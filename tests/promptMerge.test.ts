import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import { hostFixture, textResponse } from './hostFixture.ts';
import { createPromptMerge, type PromptMergeState } from '../src/console/promptMerge.ts';

const textOf = (request: GenerateOptions) => request.messages.map(m => m.content.filter(b => b.type === 'text').map(b => b.text).join('\n')).join('\n');
/** Her own world prompt, written before her wiki: no 认识, no 找回过去. */
const OWN_WORLD = '我自己的开头。\n\n## 我是谁\n{{self}}\n\n## 大事先问\n先问伙伴。\n';
/** Her own review, written before her wiki: it never names {{wikiDir}}. */
const OWN_ALARM = '## 每日回顾\n{{date}} 快过完了，写日记。\n';
/** Her own 「我」, in the file an older world keeps, still with the sixth part under its earlier name. */
const OWN_SELF = '## 性子\n慢热。\n\n## 生活习惯\n早睡早起。\n';

/** Her home, with a model that does whatever `edit` says to her files when she is asked to merge. */
async function setup(t: TestContext, edit: (files: { world: string; alarm: string; self: string }) => Promise<void>) {
  const requests: GenerateOptions[] = [];
  let files!: { world: string; alarm: string; self: string };
  const { ctx, root } = await hostFixture(t, request => {
    requests.push(request);
    return (async function* () {
      if (/融进我们自己写的模板/.test(textOf(request))) await edit(files);
      yield* textResponse('改好了');
    })();
  });
  files = { world: join(root, 'world-prompt.md'), alarm: join(root, 'alarm.md'), self: join(root, '我是谁.md') };
  await writeFile(files.world, OWN_WORLD); await writeFile(files.alarm, OWN_ALARM); await writeFile(files.self, OWN_SELF);
  const { agent } = await ctx.agents.create({ sessionId: SessionId('home'), meta: {}, agentOptions: { provider: 'test', model: 'test' } });
  let applied = 0;
  const faults: (string | undefined)[] = [];
  const merge = createPromptMerge({
    ctx, worldPromptFile: files.world, alarmFile: files.alarm, selfFile: files.self, historyDir: join(root, 'prompt-history'),
    home: async () => agent, inWorld: () => true,
    partner: () => '伙伴',
    apply: () => { applied += 1; }, changed: () => {}, fault: message => { faults.push(message); },
    clock: () => new Date('2026-11-21T10:00:00Z'),
  });
  const settled = async (): Promise<PromptMergeState> => {
    for (let tries = 0; tries < 400; tries++) {
      const state = merge.snapshot();
      if (state.status !== 'waiting' && state.status !== 'merging') return state;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('the merge never finished');
  };
  return { root, files, merge, requests, settled, applied: () => applied, faults };
}

test('she merges the chosen sections into the partner\'s own templates; the copies are kept, what she changed is listed, and it can be undone', async t => {
  const s = await setup(t, async ({ world }) => {
    await writeFile(world, OWN_WORLD + '\n{{#wikiDir}}\n## 认识\n我在 {{wikiDir}} 写我对人和事的理解。\n{{/wikiDir}}\n');
  });
  assert.equal(s.merge.request(['world:认识']), undefined);
  const done = await s.settled();
  assert.equal(done.status, 'done', done.message);
  // What she was asked: the files, and the shipped words of only the section chosen.
  const asked = textOf(s.requests[0]!);
  assert.match(asked, /伙伴让我把插件新版自带的提示词，融进我们自己写的模板里。我们的模板在 [^\n]*world-prompt\.md 和 [^\n]*alarm\.md/);
  assert.match(asked, /【世界提示词 ·「认识」】自带的有这一段，我们的没有：\n```\n\{\{#wikiDir\}\}\n## 认识\n/);
  assert.doesNotMatch(asked, /【世界提示词 ·「找回过去」】|【alarm\.md/, 'only what was chosen');
  assert.deepEqual(done.changes!.map(file => [file.file, file.sections.map(section => `${section.kind}:${section.heading}`)]), [[s.files.world, ['added:认识']]]);
  assert.equal(done.undoable, true); assert.equal(s.applied(), 1, 'her home is compacted, so her next turn reads it');
  const [copy] = await readdir(join(s.root, 'prompt-history'));
  assert.equal(await readFile(join(s.root, 'prompt-history', copy!, 'world-prompt.md'), 'utf8'), OWN_WORLD, 'the copy is taken before she is asked');
  assert.equal(s.merge.undo(), undefined);
  assert.equal(await readFile(s.files.world, 'utf8'), OWN_WORLD);
  assert.equal(await readFile(s.files.alarm, 'utf8'), OWN_ALARM);
  assert.deepEqual([s.merge.snapshot().status, s.merge.snapshot().undoable], ['idle', undefined]);
  assert.equal(s.merge.undo(), '没有可以撤销的融合');
});

test('a merge that leaves a template unreadable to the plugin is put back, and the reason is told', async t => {
  for (const [name, broken, reason] of [
    ['a switch left open', OWN_WORLD + '\n{{#wikiDir}}\n## 认识\n没关上的开关\n', /world-prompt\.md：开关没配对：\{\{#wikiDir\}\}/],
    ['a placeholder nobody fills', OWN_WORLD + '\n## 认识\n在 {{wikiFolder}} 里。\n', /用了插件不认识的变量：\{\{wikiFolder\}\}/],
  ] as const) {
    await t.test(name, async t => {
      const s = await setup(t, async ({ world }) => { await writeFile(world, broken); });
      s.merge.request(['world:认识']);
      const failed = await s.settled();
      assert.equal(failed.status, 'failed');
      assert.match(failed.message!, /她融完的模板读不通，已换回融合之前的样子/);
      assert.match(failed.message!, reason);
      assert.equal(await readFile(s.files.world, 'utf8'), OWN_WORLD, 'her template is as it was');
      assert.equal(s.applied(), 0, 'nothing broken is applied');
      assert.match(s.faults.at(-1)!, reason, 'the health card says why');
    });
  }
});

test('an alarm.md section has to pair its own switches; a variable she already used is not unknown', async t => {
  const s = await setup(t, async ({ alarm }) => {
    await writeFile(alarm, '## 每日回顾\n{{date}} 快过完了，写日记。{{#wikiDir}}整理 {{wikiDir}}。{{/wikiDir}}\n');
  });
  s.merge.request(['alarm:每日回顾']);
  const done = await s.settled();
  assert.equal(done.status, 'done', done.message);
  assert.match(textOf(s.requests[0]!), /【alarm\.md ·「每日回顾」】自带的这一段用到了 [^\n]*\{\{wikiDir\}\}[^\n]*，我们的没有/);
  assert.deepEqual(done.changes!.map(file => file.sections.map(section => `${section.kind}:${section.heading}`)), [['changed:每日回顾']]);
});

test('nothing chosen is refused before anything is copied; a turn that changes nothing is said and not applied', async t => {
  const s = await setup(t, async () => {});
  assert.equal(s.merge.request(['world:不存在的段']), '没有勾选要融的段，或者模板已经和自带的没有差距');
  assert.equal(s.requests.length, 0);
  s.merge.request(['world:认识']);
  const done = await s.settled();
  assert.deepEqual([done.status, done.message, done.undoable], ['done', '她这一轮什么都没改。', false]);
  assert.equal(s.applied(), 0);
});

test('a section she has under the name it had before is handed over as renamed, with what the rename changed', async t => {
  const s = await setup(t, async ({ world }) => { await writeFile(world, (await readFile(world, 'utf8')).replace('## 我是谁', '## 我')); });
  s.merge.request(['world:我']);
  const done = await s.settled();
  assert.equal(done.status, 'done', done.message);
  assert.match(textOf(s.requests[0]!), /【世界提示词 ·「我是谁」→「我」】改了名：「我是谁」这一段现在叫「我」；里面固定的六段，「生活习惯」现在叫「生活方式」。自带的这一段现在是：\n```\n\{\{#selfFile\}\}\n## 我\n/);
  assert.match(textOf(s.requests[0]!), /改了名的，把我们那段的标题和里面的叫法跟上，内容还是我们的/, 'the request, from its own file');
  assert.deepEqual(done.changes!.map(file => file.sections.map(section => `${section.kind}:${section.heading}`)), [['added:我', 'removed:我是谁']]);
});

test('her 「我」 is copied with the templates: a heading she renames there is listed, undone, and put back with a failed merge', async t => {
  await t.test('listed and undone', async t => {
    const s = await setup(t, async ({ world, self }) => {
      await writeFile(world, (await readFile(world, 'utf8')).replace('## 我是谁', '## 我'));
      await writeFile(self, (await readFile(self, 'utf8')).replace('## 生活习惯', '## 生活方式'));
    });
    s.merge.request(['world:我']);
    const done = await s.settled();
    assert.equal(done.status, 'done', done.message);
    const self = done.changes!.find(file => file.file === s.files.self)!;
    assert.deepEqual(self.sections.map(section => `${section.kind}:${section.heading}`), ['added:生活方式', 'removed:生活习惯'], 'what she changed in her 「我」 is shown with the rest');
    const [copy] = await readdir(join(s.root, 'prompt-history'));
    assert.equal(await readFile(join(s.root, 'prompt-history', copy!, '我是谁.md'), 'utf8'), OWN_SELF, 'copied before she is asked');
    s.merge.undo();
    assert.equal(await readFile(s.files.self, 'utf8'), OWN_SELF, 'undone with the templates');
  });
  await t.test('put back when a template does not read', async t => {
    const s = await setup(t, async ({ world, self }) => {
      await writeFile(world, OWN_WORLD + '\n{{#wikiDir}}\n## 认识\n没关上\n');
      await writeFile(self, '写坏了的自述');
    });
    s.merge.request(['world:认识']);
    assert.equal((await s.settled()).status, 'failed');
    assert.equal(await readFile(s.files.self, 'utf8'), OWN_SELF, 'everything goes back, her 「我」 too');
  });
});
