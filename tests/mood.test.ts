import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage, ToolCallId, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { hostFixture, textResponse } from './hostFixture.ts';
import { MOOD_CLEARED, moodText, parseMood, readMood } from '../src/mood.ts';
import { createWorldRuntime } from '../src/runtime.ts';
import { createArchiveStore } from '../src/store.ts';

const config = { worldId: 'fish', agentPreset: 'companion', timeZone: 'Asia/Seoul' };
const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const kinds = (request: GenerateOptions) => request.messages.map(m => m.source?.kind as string | undefined);
const moods = (request: GenerateOptions) => request.messages.filter(m => m.source?.kind === 'dsh-world-mood').map(m => m.content.flatMap(b => b.type === 'text' ? [b.text] : []).join(''));
/** Mirrors the host time-context plugin: the outermost pre-step listener appends its snapshot last. */
function hostTime(ctx: Context) {
  ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next();
    return decision.kind === 'reject' ? decision : { ...decision, messages: [...decision.messages, createUserMessage({ source: { kind: 'time-context' } as never, content: [{ type: 'text', text: 'Time sampled by host' }] })] };
  }, { prepend: true });
}

test('her moods are read with every separator, the later line winning, the default set always shown at 0 when unset and her own words after it', () => {
  const mood = parseMood('﻿开心 6\r\n累：7\n紧张:1\n想家　5\n开心 8\n');
  assert.equal(moodText(mood), '【我的心情值】开心 8 · 兴奋 0 · 平静 0 · 累 7 · 困 0 · 烦 0 · 难过 0 · 紧张 1｜我自己加的：想家 5（以最新一条为准）');
});

test('a mood line she got wrong is counted for her, never taken as a small thing, and small things beyond the limits are cut with a mark', () => {
  const mood = parseMood('开心 11\n累 7.5\n烦 -1\n一个特别特别特别长的心情名字 3\n外面在下雨\n楼下的猫今天又来了一次哦\n晚饭吃面\n还有一件\n');
  assert.equal(moodText(mood), [
    '【我的心情值】开心 0 · 兴奋 0 · 平静 0 · 累 0 · 困 0 · 烦 0 · 难过 0 · 紧张 0（以最新一条为准）',
    '旁边：外面在下雨；楼下的猫今天又来了一次哦；晚饭吃面……后面还有',
    '（mood.md 里有 4 行没读懂）',
  ].join('\n'));
  assert.match(moodText(parseMood('楼下的猫今天又来了一次哦哦哦'))!, /旁边：楼下的猫今天又来了一次哦……后面还有$/m, 'one long line is cut to twelve characters');
});

test('a missing or blank mood file is no mood at all, not every mood at 0; one that cannot be read says so', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-world-mood-')); t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(readMood(join(root, 'mood.md')), { kind: 'none' });
  await writeFile(join(root, 'mood.md'), '  \n\t\n');
  assert.deepEqual(readMood(join(root, 'mood.md')), { kind: 'none' });
  assert.equal(moodText({ kind: 'none' }), undefined);
  await mkdir(join(root, 'dir.md'));
  const failed = readMood(join(root, 'dir.md'));
  assert.equal(failed.kind, 'failed');
  assert.match(moodText(failed)!, /mood\.md 读不出来/);
});

test('her mood comes just before the time block, only when it changed, appended without retiring the old one, and never outside her world', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* (request) { requests.push(request); yield* textResponse('嗯'); });
  hostTime(ctx);
  const moodFile = join(root, 'room', 'mood.md'); await mkdir(join(root, 'room'), { recursive: true });
  const store = createArchiveStore({ ...config, root });
  const world = createWorldRuntime(ctx, { ...config, moodFile }, store);
  await world.start(); cleanup.push(() => world.stop().finally(() => store.close()));
  const { agent } = await ctx.agents.create({ sessionId: SessionId('home'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  const say = async (text: string) => { agent.followup(user(text)); await agent.whenIdle(); return requests.at(-1)!; };

  assert.deepEqual(moods(await say('早')), [], 'no mood file, no snapshot');
  await writeFile(moodFile, '开心 6\n累 7\n外面在下雨\n');
  const first = await say('在吗');
  assert.equal(moods(first).length, 1);
  assert.deepEqual(kinds(first).slice(-2), ['dsh-world-mood', 'time-context'], 'right before the time block');
  assert.match(moods(first)[0]!, /开心 6[\s\S]*累 7[\s\S]*旁边：外面在下雨/);
  assert.equal(moods(await say('还在')).length, 1, 'unchanged: nothing new on the next turn');

  await writeFile(moodFile, '开心 3\n累 9\n');
  const changed = await say('怎么了');
  assert.equal(moods(changed).length, 2, 'the new one is appended');
  assert.equal(moods(changed)[0], moods(first)[0], 'the old one stays exactly where it was, so the cached prefix is whole');
  assert.deepEqual(changed.messages.slice(0, first.messages.length), first.messages);

  await rm(moodFile);
  assert.equal(moods(await say('嗯')).at(-1), MOOD_CLEARED, 'a removed file is said once, so the old values stop counting');
  assert.equal(moods(await say('好')).length, 3, 'and only once');

  await writeFile(moodFile, '开心 5\n');
  const outside = await ctx.agents.create({ sessionId: SessionId('work'), meta: { agentPreset: 'coding' }, agentOptions: { provider: 'test', model: 'test' } });
  outside.agent.followup(user('写代码')); await outside.agent.whenIdle();
  assert.deepEqual(moods(requests.at(-1)!), [], 'a session outside her world never sees it');
  assert.equal(errors.length, 0, errors.map(e => String((e as { error: Error }).error)).join('\n'));
});

test('a change she makes in the middle of a turn shows on its next step', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, async function* (request) {
    requests.push(request);
    if (requests.length === 1) {
      const block = { type: 'tool-call' as const, id: ToolCallId('call'), name: 'feel', arguments: '{}' };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: 'feel', argumentsDelta: '{}' };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
    }
    yield* textResponse('好多了');
  });
  const moodFile = join(root, 'room', 'mood.md'); await mkdir(join(root, 'room'), { recursive: true });
  await writeFile(moodFile, '难过 6\n');
  ctx.tools.register(defineTool({ name: 'feel', description: 'test', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => { await writeFile(moodFile, '难过 2\n开心 5\n'); return 'ok'; } }));
  const store = createArchiveStore({ ...config, root });
  const world = createWorldRuntime(ctx, { ...config, moodFile }, store);
  await world.start(); cleanup.push(() => world.stop().finally(() => store.close()));
  const { agent } = await ctx.agents.create({ sessionId: SessionId('home'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  agent.followup(user('抱抱')); await agent.whenIdle();
  assert.equal(requests.length, 2);
  assert.match(moods(requests[0]!).join(''), /难过 6/);
  assert.equal(moods(requests[1]!).length, 2);
  assert.match(moods(requests[1]!)[1]!, /开心 5[\s\S]*难过 2/);
});

test('a mood file that cannot be read is a fault until it can be read again, and she is told instead of shown zeros', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, async function* (request) { requests.push(request); yield* textResponse('嗯'); });
  const moodFile = join(root, 'room', 'mood.md'); await mkdir(moodFile, { recursive: true });
  const store = createArchiveStore({ ...config, root });
  const world = createWorldRuntime(ctx, { ...config, moodFile }, store);
  await world.start(); cleanup.push(() => world.stop().finally(() => store.close()));
  const { agent } = await ctx.agents.create({ sessionId: SessionId('home'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  agent.followup(user('在吗')); await agent.whenIdle();
  assert.match(moods(requests.at(-1)!).join(''), /mood\.md 读不出来/);
  assert.match(world.faults().join('\n'), /mood\.md 读不出来/);
  await rm(moodFile, { recursive: true }); await writeFile(moodFile, '平静 4\n');
  agent.followup(user('好了')); await agent.whenIdle();
  assert.match(moods(requests.at(-1)!).at(-1)!, /平静 4/);
  assert.doesNotMatch(world.faults().join('\n'), /mood/);
});
