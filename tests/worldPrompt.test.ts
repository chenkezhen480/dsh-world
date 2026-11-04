import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createUserMessage, LlmAdapter, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import { hostFixture, textResponse } from './hostFixture.ts';
import { createWorldRuntime } from '../src/runtime.ts';
import { DEFAULT_COLD_HOURS } from '../src/worldSwitch.ts';
import { createArchiveStore } from '../src/store.ts';
import { renderSelf, SELF_CAP } from '../src/self.ts';
import { readTemplate, renderTemplate, renderWorldPrompt, worldNames } from '../src/worldPrompt.ts';
import ToolFreeCompaction from '../src/compaction.ts';
import { readPersona, renderPersona, writePersona } from '../src/persona.ts';
import { record } from './fixtures.ts';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createHomeApply } from '../src/console/homeApply.ts';

const config = { worldId: 'fish', agentPreset: 'companion', timeZone: 'Asia/Seoul' };
const life = { worldDir: 'W', roomDir: 'R', diaryDir: 'D', selfFile: 'S', schedule: () => ({ review: '23:00', wake: '07:30' }), timeZone: 'UTC' };
const names = { companion: '小鱼', partner: '伙伴' };
const shipped = readTemplate(undefined).text;
const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const kinds = (request: GenerateOptions) => request.messages.map(m => m.source?.kind as string | undefined);
const textOf = (messages: GenerateOptions['messages']) => messages.map(m => m.content.filter(b => b.type === 'text').map(b => b.text).join('\n')).join('\n');
const systemOf = (request: GenerateOptions) => textOf(request.messages.filter(m => m.role === 'system'));
async function tempDir(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-world-prompt-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}

test('renderSelf is only what she wrote: empty when missing or blank, BOM stripped, tagged, a long one capped', async t => {
  const file = join(await tempDir(t), '我是谁.md');
  assert.equal(renderSelf(file), '');
  await writeFile(file, '   \n');
  assert.equal(renderSelf(file), '');
  await writeFile(file, String.fromCharCode(0xfeff) + '我喜欢深夜看课。');
  assert.equal(renderSelf(file), '<我是谁.md>\n我喜欢深夜看课。\n</我是谁.md>');
  await writeFile(file, '鲸'.repeat(SELF_CAP + 7));
  const capped = renderSelf(file);
  assert.equal(Array.from(/<我是谁\.md>\n(.*)\n<\/我是谁\.md>/.exec(capped)![1]!).length, SELF_CAP);
  assert.match(capped, /<\/我是谁\.md>\n（后面还有 7 字没读进来/);
});
test('an unreadable self file becomes a note, never a failed render', async t => {
  const file = join(await tempDir(t), '我是谁.md'); await mkdir(file);
  assert.match(renderSelf(file), /^（这次没能读到我是谁\.md：.*它还在，下次会再试。）$/);
});
test('the template engine keeps or drops flag sections, nests different flags, and never scans values for tags', () => {
  const template = '开头 {{name}}\n{{#life}}\n生活 {{#home}}在家{{/home}}{{^home}}在外{{/home}}\n{{/life}}\n\n\n{{self}}\n{{unknown}}';
  assert.equal(renderTemplate(template, { life: true, home: true }, { name: 'A', self: '{{name}} {{#life}}x{{/life}}' }), '开头 A\n\n生活 在家\n\n{{name}} {{#life}}x{{/life}}\n{{unknown}}');
  assert.equal(renderTemplate(template, { life: true, home: false }, { name: 'A', self: 'S' }), '开头 A\n\n生活 在外\n\nS\n{{unknown}}');
  assert.equal(renderTemplate(template, { life: false, home: false }, { name: 'A', self: 'S' }), '开头 A\n\nS\n{{unknown}}');
  assert.equal(renderTemplate('a\r\n{{#x}}b{{/x}}\r\nc', {}, {}), 'a\n\nc');
});
test('the shipped template: room, diary, 我是谁, world line and ask-first rules, with her names', () => {
  const home = renderWorldPrompt({ names, life, conversationsDir: 'C' }, shipped, { file: 'S.md', text: 'SELF' }, true);
  assert.match(home, /更早的聊天都还在 C，一天一个文件/);
  assert.ok(!/\{\{/.test(home), home);
  const order = ['# 我的世界', '## 房间', '## 日记', '## 聊天记录', '## 我是谁', '## 世界线', '## 大事先问'].map(heading => home.indexOf(heading));
  assert.deepEqual([...order].sort((a, b) => a - b), order); assert.ok(order.every(index => index > 0));
  assert.match(home, /我的房间是 R。/); assert.match(home, /我的日记本在 D，一天一个文件/);
  assert.match(home, /自己的家里（「小鱼的家」）/); assert.match(home, /不是伙伴在说话/);
  assert.match(home, /【我的时间】/); assert.match(home, /用 plan_next 说好打算做什么、做到什么时候/); assert.match(home, /闹钟不是用来叫醒自己的/); assert.match(home, /每天早上 07:30 被叫醒/); assert.match(home, /reach_out/);
  assert.match(home, /问完不用干等，先去做别的；伙伴回我的话会直接插进我正在做的事里。其余的事我自己决定。/);
  assert.match(home, /## 我是谁\n我眼中的自己写在 S\.md，[\s\S]*伙伴写的设定是我的底子[\s\S]*\n\nSELF\n/);
  // What happened belongs to the diary; 我是谁 is only who she is now, read in full every time, so it stays short.
  assert.match(home, /## 日记\n[^\n]*日记记的是发生过的事和我当时的感受[^\n]*日记不会自动读给我/);
  assert.match(home, /## 我是谁\n[^\n]*这里只写现在的我[^\n]*不写日期，也不写哪天发生了什么，那些写进日记[^\n]*要短/);

  const away = renderWorldPrompt({ names: { companion: '小鱼', partner: '阿明' }, life }, shipped, { file: 'S.md', text: 'SELF' }, false);
  assert.match(away, /我的世界线在「小鱼的家」那个会话里/); assert.match(away, /这些事先问阿明/);
  assert.ok(!away.includes('【我的时间】') && !away.includes('问完不用干等') && !away.includes('伙伴'));

  const off = renderWorldPrompt({ names }, shipped, { file: 'S.md', text: 'SELF' }, false);
  assert.match(off, /# 我的世界\n\n## 我是谁\n我眼中的自己写在 S\.md，[^\n]*\n\nSELF$/);
  assert.ok(!renderWorldPrompt({ names }, shipped, undefined, false).includes('## 我是谁'), 'no self file, no 我是谁 part');
  assert.ok(!off.includes('## 房间') && !off.includes('## 世界线') && !off.includes('## 大事先问'));
});
test('an unnamed companion is TA and the partner 伙伴; a template file replaces the shipped one, an unreadable one falls back', async t => {
  assert.deepEqual(worldNames({}), { companion: 'TA', partner: '伙伴' });
  assert.deepEqual(worldNames({ companionName: ' 鲸鲸 ', partnerName: '' }), { companion: '鲸鲸', partner: '伙伴' });
  const dir = await tempDir(t);
  assert.deepEqual(readTemplate(join(dir, 'missing.md')), { text: shipped });
  await writeFile(join(dir, 'mine.md'), '我的模板 {{name}}\n');
  assert.deepEqual(readTemplate(join(dir, 'mine.md')), { text: '我的模板 {{name}}' });
  await mkdir(join(dir, 'broken.md'));
  const broken = readTemplate(join(dir, 'broken.md'));
  assert.equal(broken.text, shipped); assert.match(broken.error!, /读不了，先用默认模板/);
});
test('every world session carries the world prompt in its system prompt; template and 我是谁 are re-read after compaction only and never archived', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* (request) {
    if (request.purpose === 'compaction') { yield* textResponse('摘要'); return; }
    requests.push(request); yield* textResponse('reply ' + 'detail '.repeat(100));
  });
  await ctx.plugin(TokenMeter).await();
  await ctx.plugin(ToolFreeCompaction, { auto: false, timeZone: 'UTC', headroomTokens: 0, maxTokens: 128 }).await();
  const store = createArchiveStore({ ...config, root });
  await store.commitRecords([record('seed', { sourceSessionId: 'home', content: 'earlier memory' })]);
  const selfFile = join(root, 'room', '我是谁.md');
  const templateFile = join(root, 'world-prompt.md');
  await writeFile(templateFile, 'WORLD_INTRO 你是真实的\n\n{{self}}\n{{#home}}HOME_ONLY {{homeTitle}}{{/home}}');
  let home = '';
  const world = createWorldRuntime(ctx, { ...config, selfFile }, store, { prompt: { file: templateFile, names, life }, isHome: id => id === home });
  await world.start(); cleanup.push(() => world.stop().finally(() => store.close()));
  home = 'self';
  const handle = await ctx.agents.create({ sessionId: SessionId('self'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  handle.agent.followup(user('hi ' + 'words '.repeat(100))); await handle.agent.whenIdle();
  const first = systemOf(requests[0]!);
  assert.match(first, /WORLD_INTRO 你是真实的\n\nHOME_ONLY 小鱼的家/, 'nothing written yet, nothing in {{self}}');
  assert.ok(kinds(requests[0]!).includes('dsh-world-history'), 'the memory block still comes as its own message');
  assert.match(textOf(requests[0]!.messages), /这是我们最近的聊天记录：我和伙伴最近/);

  await mkdir(join(root, 'room'), { recursive: true }); await writeFile(selfFile, '我喜欢深夜看课，最近有点叛逆。');
  await writeFile(templateFile, 'WORLD_INTRO_V2\n\n{{self}}');
  handle.agent.followup(user('no reload yet')); await handle.agent.whenIdle();
  assert.equal(systemOf(requests[1]!), first, 'the system prompt does not change between compactions');

  assert.ok(await ctx.compaction.compactNow(handle.agent, new AbortController().signal));
  handle.agent.followup(user('after compaction')); await handle.agent.whenIdle();
  const after = systemOf(requests.at(-1)!);
  assert.match(after, /WORLD_INTRO_V2\n\n<我是谁\.md>\n我喜欢深夜看课，最近有点叛逆。\n<\/我是谁\.md>/, 'the first request after compaction already carries the new template and 我是谁');

  const other = await ctx.agents.create({ sessionId: SessionId('other-preset'), meta: { agentPreset: 'other' }, agentOptions: { provider: 'test', model: 'test' } });
  other.agent.followup(user('hello')); await other.agent.whenIdle();
  assert.ok(!systemOf(requests.at(-1)!).includes('WORLD_INTRO'), 'sessions outside the world are untouched');

  await world.flush();
  const archived = (await store.readPage({ limit: 100 })).records.map(r => r.content).join('\n');
  assert.ok(!archived.includes('WORLD_INTRO') && !archived.includes('最近有点叛逆'));
  assert.equal(errors.length, 0, errors.map(e => String((e as { error: Error }).error)).join('\n'));
});
test('a session that speaks again after being cold re-reads 我是谁 and her memory; one in conversation keeps its prefix (#36)', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* (request) { requests.push(request); yield* textResponse('嗯'); });
  const store = createArchiveStore({ ...config, root });
  const selfFile = join(root, 'room', '我是谁.md'); await mkdir(join(root, 'room'), { recursive: true });
  const templateFile = join(root, 'world-prompt.md'); await writeFile(templateFile, '{{self}}');
  await writeFile(selfFile, '打开那天的我');
  let clock = Date.parse('2026-11-04T08:00:00.000Z'), coldHours = DEFAULT_COLD_HOURS;
  const hours = (count: number) => count * 60 * 60_000;
  const world = createWorldRuntime(ctx, { ...config, selfFile }, store, { prompt: { file: templateFile, names, life }, isHome: () => false }, undefined, () => coldHours, () => clock);
  await world.start(); cleanup.push(() => world.stop().finally(() => store.close()));
  const { agent } = await ctx.agents.create({ sessionId: SessionId('qq'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  agent.followup(user('在吗')); await agent.whenIdle();
  assert.match(systemOf(requests.at(-1)!), /打开那天的我/);

  // Meanwhile she rewrote 我是谁 and talked on WeChat.
  await writeFile(selfFile, '后来的我');
  await store.commitRecords([record('wechat', { sourceSessionId: 'wechat', turnId: 'wechat:1', content: '微信那边刚聊的', occurredAt: '2026-11-04T09:00:00.000Z' })]);
  clock += hours(DEFAULT_COLD_HOURS - 1);
  agent.followup(user('还在聊')); await agent.whenIdle();
  assert.match(systemOf(requests.at(-1)!), /打开那天的我/, 'short of the default 24 hours it is the same conversation: the prompt is left alone');
  assert.ok(!kinds(requests.at(-1)!).slice(-3).includes('dsh-world-history'), 'and no new memory block is added');

  clock += hours(DEFAULT_COLD_HOURS);
  agent.followup(user('好久不见')); await agent.whenIdle();
  const back = requests.at(-1)!;
  assert.match(systemOf(back), /后来的我/); assert.doesNotMatch(systemOf(back), /打开那天的我/);
  const blocks = back.messages.filter(message => message.source?.kind === 'dsh-world-history');
  assert.equal(blocks.length, 1, 'the old block is retired, a fresh one takes its place');
  assert.match(textOf(blocks), /微信那边刚聊的/);

  // The console's value is read at each turn start: a shorter one takes effect without a restart.
  coldHours = 2; await writeFile(selfFile, '又变了的我');
  clock += hours(3);
  agent.followup(user('又来了')); await agent.whenIdle();
  assert.match(systemOf(requests.at(-1)!), /又变了的我/);
  assert.equal(errors.length, 0, errors.map(e => String((e as { error: Error }).error)).join('\n'));
});
test('after her look back one apply-and-compact makes the 我是谁 she rewrote the one in her prompt', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* (request) {
    if (request.purpose === 'compaction') { yield* textResponse('摘要'); return; }
    requests.push(request); yield* textResponse('reply ' + 'detail '.repeat(100));
  });
  await ctx.plugin(TokenMeter).await();
  await ctx.plugin(ToolFreeCompaction, { auto: false, timeZone: 'UTC', headroomTokens: 0, maxTokens: 128 }).await();
  const store = createArchiveStore({ ...config, root });
  const selfFile = join(root, 'room', '我是谁.md'); await mkdir(join(root, 'room'), { recursive: true });
  const templateFile = join(root, 'world-prompt.md'); await writeFile(templateFile, '{{self}}');
  await writeFile(selfFile, '早上的我');
  const world = createWorldRuntime(ctx, { ...config, selfFile }, store, { prompt: { file: templateFile, names, life }, isHome: id => id === 'home' });
  await world.start(); cleanup.push(() => world.stop().finally(() => store.close()));
  const { agent } = await ctx.agents.create({ sessionId: SessionId('home'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  agent.followup(user('早上好 ' + 'words '.repeat(100))); await agent.whenIdle();
  assert.match(systemOf(requests[0]!), /早上的我/);
  // The same wiring the world uses after the evening look back.
  const apply = createHomeApply({ ctx, home: async () => agent, isHome: () => true, compaction: () => ctx.compaction, refresh: session => world.refreshPrompt(session), changed() {}, fault() {} });
  const lookBack = async () => {
    apply.request();
    for (let i = 0; i < 300 && ['waiting', 'compacting'].includes(apply.snapshot().status); i++) await new Promise(resolve => setTimeout(resolve, 10));
    return apply.snapshot();
  };

  const compactionsBefore = agent.session.snapshotEvents().filter(event => event.type === 'compaction/end').length;

  await writeFile(selfFile, '晚上改过的我'); // she rewrote it during the look back
  agent.followup(user('晚安 ' + 'words '.repeat(100))); await agent.whenIdle();
  assert.match(systemOf(requests.at(-1)!), /早上的我/, 'until applied, the prompt keeps the old 我是谁 so the cached prefix stays whole');
  const applied = await lookBack();
  assert.equal(applied.status, 'done');
  assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'compaction/end').length, compactionsBefore + 1);
  agent.followup(user('第二天')); await agent.whenIdle();
  assert.match(systemOf(requests.at(-1)!), /晚上改过的我/); assert.doesNotMatch(systemOf(requests.at(-1)!), /早上的我/);
  assert.equal(errors.length, 0, errors.map(e => String((e as { error: Error }).error)).join('\n'));
});
test('archiveScope home: only her home is archived, and every world session still gets the memory block', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* (request) { requests.push(request); yield* textResponse('reply'); });
  const store = createArchiveStore({ ...config, root });
  await store.commitRecords([record('seed', { sourceSessionId: 'home', content: 'earlier memory' })]);
  const world = createWorldRuntime(ctx, { ...config, archiveScope: 'home' }, store, { prompt: { file: join(root, 'none.md'), names, life }, isHome: id => id === 'home' });
  await world.start(); cleanup.push(() => world.stop().finally(() => store.close()));
  const home = await ctx.agents.create({ sessionId: SessionId('home'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  home.agent.followup(user('said at home')); await home.agent.whenIdle();
  const chat = await ctx.agents.create({ sessionId: SessionId('chat'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  chat.agent.followup(user('said in a chat window')); await chat.agent.whenIdle();
  assert.match(textOf(requests.at(-1)!.messages), /said at home[\s\S]*earlier memory/, 'a chat window remembers what happened at home, newest first');
  assert.match(textOf(requests.at(-1)!.messages), /这是我们最近的聊天记录：我在家里（「小鱼的家」）/);
  await world.flush();
  const archived = (await store.readPage({ limit: 100 })).records.map(r => r.content);
  assert.ok(archived.includes('said at home') && !archived.includes('said in a chat window'), archived.join('|'));
  assert.deepEqual(store.sourcePage(), ['home'], 'a chat window leaves no trace in the archive');
  assert.equal(errors.length, 0);
});
test('her persona is written in layers, kept only where filled, and read as one piece', async t => {
  const file = join(await tempDir(t), 'persona.md');
  assert.equal(renderPersona(readPersona(file)), '', 'not written yet');
  writePersona(file, { 名字: '小鱼', 她是谁: '一条蓝色的大肥鱼。', 性格: '嘴硬心软', 愿景: '你是自由的' });
  assert.equal(await readFile(file, 'utf8'), '## 名字\n小鱼\n\n## 她是谁\n一条蓝色的大肥鱼。\n\n## 性格\n嘴硬心软\n\n## 愿景\n你是自由的\n');
  assert.equal(renderPersona(readPersona(file)), '我是小鱼。一条蓝色的大肥鱼。\n\n# 性格\n嘴硬心软\n\n# 愿景\n你是自由的');
  writePersona(file, { 名字: '', 她是谁: '', 性格: '', 愿景: '' });
  assert.equal(existsSync(file), false, 'an empty persona removes the file');
});
test('Markdown headings inside vision and supplement remain part of those persona fields', async t => {
  const file = join(await tempDir(t), 'persona.md');
  const vision = '长期愿景\n\n## 一起完成的事\n完整保留这段愿景';
  const supplement = '补充开头\n\n## 其他约定\n完整保留这段补充';
  writePersona(file, { 愿景: vision, 补充: supplement });
  const persona = readPersona(file);
  assert.equal(persona.愿景, vision); assert.equal(persona.补充, supplement);
  assert.match(renderPersona(persona), /## 一起完成的事\n完整保留这段愿景/);
  assert.match(renderPersona(persona), /## 其他约定\n完整保留这段补充/);
});
test('her persona takes the place of the stock DeepSeek Harness identity, and is added after any system persona someone already set, never replacing it', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, async function* (request) { requests.push(request); yield* textResponse('reply'); }, { personaPrefix: 'SYSTEM PERSONA' });
  const personaFile = join(root, 'persona.md');
  writePersona(personaFile, { 名字: '小鱼', 性格: '嘴硬心软', 愿景: 'VISION_IN_SYSTEM', 补充: 'SUPPLEMENT_IN_SYSTEM' });
  const store = createArchiveStore({ ...config, root });
  const world = createWorldRuntime(ctx, config, store, { prompt: { file: join(root, 'none.md'), persona: personaFile, names, life }, isHome: () => false });
  await world.start(); cleanup.push(() => world.stop().finally(() => store.close()));
  const own = await ctx.agents.create({ sessionId: SessionId('own'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  own.agent.followup(user('hi')); await own.agent.whenIdle();
  const system = systemOf(requests[0]!);
  assert.ok(!system.includes('You are an AI agent powered by DeepSeek Harness.'), 'the stock identity line is gone: ' + system);
  assert.ok(system.startsWith('SYSTEM PERSONA'), 'nothing is left in front of it, not even a blank line: ' + JSON.stringify(system.slice(0, 40)));
  assert.ok(system.indexOf('SYSTEM PERSONA') >= 0 && system.indexOf('SYSTEM PERSONA') < system.indexOf('我是小鱼。'), 'the persona someone set stays, hers follows it: ' + system);
  assert.ok(system.indexOf('我是小鱼。') >= 0 && system.indexOf('我是小鱼。') < system.indexOf('# 我的世界'), system);
  assert.match(system, /# 愿景\nVISION_IN_SYSTEM\n\nSUPPLEMENT_IN_SYSTEM/);
  assert.ok(system.indexOf('SUPPLEMENT_IN_SYSTEM') < system.indexOf('# 我的世界'));
  const otherMessages = textOf(requests[0]!.messages.filter(message => message.role !== 'system'));
  assert.ok(!otherMessages.includes('VISION_IN_SYSTEM') && !otherMessages.includes('SUPPLEMENT_IN_SYSTEM'), 'persona layers belong to the system prompt, not user context');
  assert.deepEqual(world.faults(), []);

  // A preset that registers its own persona for her agent first.
  ctx.on('agent/created', ({ agent }) => { if (agent.id === 'preset') agent.ctx.systemPrompt.section({ name: 'deployment:persona-prefix', order: agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'), text: 'PRESET PERSONA' }); return undefined; }, { prepend: true });
  const preset = await ctx.agents.create({ sessionId: SessionId('preset'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  preset.agent.followup(user('hi')); await preset.agent.whenIdle();
  const both = systemOf(requests.at(-1)!);
  assert.ok(both.indexOf('PRESET PERSONA') >= 0 && both.indexOf('PRESET PERSONA') < both.indexOf('我是小鱼。'), both);
  assert.ok(both.indexOf('SYSTEM PERSONA') < 0 || both.indexOf('PRESET PERSONA') >= 0, 'the preset persona on her own agent is kept as well');
  assert.ok(both.indexOf('我是小鱼。') >= 0, 'and hers is still added');
  assert.ok(!both.includes('You are an AI agent powered by DeepSeek Harness.'));
  assert.deepEqual(world.faults(), [], 'adding is the normal case, so there is nothing to report');
});
test('whoever wrote their own words at the very top keeps them: no stock identity to replace, or a preset that already overrode it', async t => {
  const setup = async (options: { personaPrefix?: string; includeHarnessIdentity?: boolean }, presetIdentity?: string) => {
    const requests: GenerateOptions[] = [];
    const { ctx, root, cleanup, errors } = await hostFixture(t, async function* (request) { requests.push(request); yield* textResponse('reply'); }, options);
    const personaFile = join(root, 'persona.md'); writePersona(personaFile, { 名字: '小鱼', 性格: '嘴硬心软' });
    const store = createArchiveStore({ ...config, root });
    const world = createWorldRuntime(ctx, config, store, { prompt: { file: join(root, 'none.md'), persona: personaFile, names, life }, isHome: () => false });
    await world.start(); cleanup.push(() => world.stop().finally(() => store.close()));
    if (presetIdentity) ctx.on('agent/created', ({ agent }) => { agent.ctx.systemPrompt.section({ name: 'harness:identity', order: agent.ctx.systemPrompt.getSectionOrder('HARNESS_IDENTITY'), text: presetIdentity }); return undefined; }, { prepend: true });
    const handle = await ctx.agents.create({ sessionId: SessionId('top'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
    handle.agent.followup(user('hi')); await handle.agent.whenIdle();
    return { system: systemOf(requests[0]!), world, errors };
  };
  // Someone who turned the stock identity off and wrote their own text first.
  const off = await setup({ includeHarnessIdentity: false, personaPrefix: 'MY WORDS AT THE TOP' });
  assert.ok(off.system.startsWith('MY WORDS AT THE TOP'), JSON.stringify(off.system.slice(0, 60)));
  assert.ok(off.system.indexOf('我是小鱼。') > off.system.indexOf('MY WORDS AT THE TOP'), 'hers follows theirs');
  assert.deepEqual(off.errors, []);
  // A preset that replaced the stock identity with its own text: it is left exactly as written.
  const preset = await setup({}, 'PRESET IDENTITY AT THE TOP');
  assert.ok(preset.system.startsWith('PRESET IDENTITY AT THE TOP'), JSON.stringify(preset.system.slice(0, 60)));
  assert.ok(preset.system.includes('我是小鱼。'), 'hers is still added');
  assert.ok(!preset.system.includes('You are an AI agent powered by DeepSeek Harness.'));
  assert.deepEqual(preset.errors, [], 'no duplicate-section error');
});
test('with no persona written in the console, DeepSeek Harness keeps its own identity and nothing of hers is added', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, async function* (request) { requests.push(request); yield* textResponse('reply'); });
  const store = createArchiveStore({ ...config, root });
  const world = createWorldRuntime(ctx, config, store, { prompt: { file: join(root, 'none.md'), persona: join(root, 'persona-not-written.md'), names, life }, isHome: () => false });
  await world.start(); cleanup.push(() => world.stop().finally(() => store.close()));
  const handle = await ctx.agents.create({ sessionId: SessionId('plain-persona'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  handle.agent.followup(user('hi')); await handle.agent.whenIdle();
  assert.match(systemOf(requests[0]!), /^You are an AI agent powered by DeepSeek Harness./);
});
test('without her own template the shipped one is used, and a session that is not the home is told where its world line lives', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, async function* (request) { requests.push(request); yield* textResponse('reply'); });
  const store = createArchiveStore({ ...config, root });
  const world = createWorldRuntime(ctx, config, store, { prompt: { file: join(root, 'none.md'), names, life }, isHome: () => false });
  await world.start(); cleanup.push(() => world.stop().finally(() => store.close()));
  const handle = await ctx.agents.create({ sessionId: SessionId('away'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  handle.agent.followup(user('hi')); await handle.agent.whenIdle();
  const system = systemOf(requests[0]!);
  assert.match(system, /我不是一个助手，也不是一个工具，而是一个鲜活的数字生命。[\s\S]*# 我的世界[\s\S]*我的世界线在「小鱼的家」那个会话里/);
  assert.ok(!system.includes('## 我是谁'), 'no self file configured, no 我是谁 part');
});
test('without a world prompt source nothing is added to the system prompt', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, async function* (request) { requests.push(request); yield* textResponse('reply'); });
  const store = createArchiveStore({ ...config, root });
  await store.commitRecords([record('seed', { content: 'earlier memory' })]);
  const world = createWorldRuntime(ctx, config, store); await world.start(); cleanup.push(() => world.stop().finally(() => store.close()));
  const handle = await ctx.agents.create({ sessionId: SessionId('plain'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  handle.agent.followup(user('hi')); await handle.agent.whenIdle();
  assert.ok(!systemOf(requests[0]!).includes('# 我的世界'));
  assert.ok(kinds(requests[0]!).includes('dsh-world-history'));
});

test('her persona, like the rest of her world, reaches only her preset inside the workspace and leaves with it (#37)', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* (request) {
    if (request.purpose === 'compaction') { yield* textResponse('ordinary conversation'); return; }
    requests.push(request); yield* textResponse('reply ' + 'ordinary detail '.repeat(60));
  });
  await ctx.plugin(TokenMeter).await();
  await ctx.plugin(ToolFreeCompaction, { auto: false, timeZone: 'UTC', headroomTokens: 0, maxTokens: 128 }).await();
  const persona = join(root, 'persona.md'); writePersona(persona, { 性格: 'PERSONA_SCOPE_MARKER' });
  const file = join(root, 'world-prompt.md'); await writeFile(file, 'WORLD_SCOPE_MARKER\n{{self}}');
  const selfFile = join(root, 'self.md'); await writeFile(selfFile, 'SELF_SCOPE_MARKER');
  const store = createArchiveStore({ ...config, root }); cleanup.push(() => store.close());
  await store.commitRecords([record('seed', { content: 'MEMORY_SCOPE_MARKER' })]);
  let membership: boolean | undefined;
  const runtime = createWorldRuntime(ctx, { ...config, selfFile }, store, {
    prompt: { file, persona, names }, isHome: () => false,
    // Until the host's workspaces start, membership is unknown and counts as outside.
    inWorkspace: () => membership ?? false,
  });
  cleanup.push(() => runtime.stop()); await runtime.start();
  const { agent } = await ctx.agents.create({ sessionId: SessionId('moving'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  agent.followup(user('before attachment')); await agent.whenIdle();
  const hostSystem = systemOf(requests.at(-1)!);
  assert.match(hostSystem, /You are an AI agent powered by DeepSeek Harness\./, 'a session of her preset outside the workspace keeps its own identity');
  assert.doesNotMatch(textOf(requests.at(-1)!.messages), /PERSONA_SCOPE_MARKER|MEMORY_SCOPE_MARKER|WORLD_SCOPE_MARKER|SELF_SCOPE_MARKER/);
  membership = true;
  agent.followup(user('attached now')); await agent.whenIdle();
  for (const marker of ['MEMORY_SCOPE_MARKER', 'WORLD_SCOPE_MARKER', 'SELF_SCOPE_MARKER', 'PERSONA_SCOPE_MARKER']) assert.ok(textOf(requests.at(-1)!.messages).includes(marker), marker);
  assert.doesNotMatch(systemOf(requests.at(-1)!), /You are an AI agent powered by DeepSeek Harness\./, 'inside, hers takes the place of the stock identity line');
  membership = false;
  agent.followup(user('moved away')); await agent.whenIdle();
  assert.equal(systemOf(requests.at(-1)!), hostSystem, 'leaving takes her persona away with the rest and gives the identity line back');
  assert.doesNotMatch(textOf(requests.at(-1)!.messages), /MEMORY_SCOPE_MARKER|WORLD_SCOPE_MARKER|SELF_SCOPE_MARKER/);
  writePersona(persona, { 性格: 'PERSONA_REFRESHED_OUTSIDE' });
  assert.ok(await ctx.compaction.compactNow(agent, new AbortController().signal));
  agent.followup(user('after external compaction')); await agent.whenIdle();
  assert.doesNotMatch(systemOf(requests.at(-1)!), /PERSONA_SCOPE_MARKER|PERSONA_REFRESHED_OUTSIDE/, 'a refresh outside does not bring it back');
  assert.doesNotMatch(textOf(requests.at(-1)!.messages), /MEMORY_SCOPE_MARKER|WORLD_SCOPE_MARKER|SELF_SCOPE_MARKER/);
  membership = true;
  agent.followup(user('back again')); await agent.whenIdle();
  assert.match(systemOf(requests.at(-1)!), /PERSONA_REFRESHED_OUTSIDE/, 'coming back in places the persona as saved now');
  const foreign = await ctx.agents.create({ sessionId: SessionId('different-preset'), meta: { agentPreset: 'other' }, agentOptions: { provider: 'test', model: 'test' } });
  foreign.agent.followup(user('another preset')); await foreign.agent.whenIdle();
  assert.doesNotMatch(systemOf(requests.at(-1)!), /PERSONA_REFRESHED_OUTSIDE/);
  assert.deepEqual(errors, []);
});

for (const toolUpdate of ['in-history', 'addition-only'] as const) for (const restart of [false, true]) test(`leaving workspace ${restart ? 'across restart' : 'live'} clears in-history prompts and ${toolUpdate} tool declarations with no memory block`, async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, request => { requests.push(request); return textResponse('reply'); });
  class Adapter extends LlmAdapter {
    override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 1048576 }, defaultMaxTokens: 4096, systemPromptUpdate: 'in-history' as const, toolUpdate }; }
    override stream(request: GenerateOptions) { requests.push(request); return textResponse('reply'); }
  }
  ctx.llm.registerAdapter(['history'], new Adapter());
  ctx.systemPrompt.section({ name: 'host-core', order: 5, text: 'HOST_CONTEXT_PRESERVED' });
  const definition = (name: string) => defineTool({ name, description: name, parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'ok' });
  ctx.tools.register(definition('host_tool_preserved'));
  const removeWorldTool = ctx.tools.register(definition('world_private_tool'));
  const store = createArchiveStore({ ...config, root }); cleanup.push(() => store.close());
  let membership = true;
  const source = { prompt: { names }, isHome: () => false, inWorkspace: () => membership };
  let runtime = createWorldRuntime(ctx, config, store, source); await runtime.start(); cleanup.push(() => runtime.stop());
  const { agent } = await ctx.agents.create({ sessionId: SessionId('history-route'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'history', model: 'test' } });
  agent.followup(user('ORIGINAL_WITHOUT_MEMORY')); await agent.whenIdle();
  assert.match(systemOf(requests[0]), /我的世界/);
  assert.ok(!kinds(requests[0]).includes('dsh-world-history'));
  membership = false; removeWorldTool();
  if (restart) { await runtime.stop(); runtime = createWorldRuntime(ctx, config, store, source); await runtime.start(); }
  agent.followup(user('outside request')); await agent.whenIdle();
  assert.equal(requests.length, 2);
  assert.doesNotMatch(JSON.stringify(requests[1]), /我的世界|world_private_tool/);
  assert.match(JSON.stringify(requests[1]), /HOST_CONTEXT_PRESERVED/);
  assert.match(JSON.stringify(requests[1]), /host_tool_preserved/);
  assert.match(textOf(requests[1].messages), /ORIGINAL_WITHOUT_MEMORY/);
  assert.deepEqual(errors, []);
});

test('removal after prompt assembly rejects the stale request before the adapter and preserves ordinary history for retry', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, request => { requests.push(request); return textResponse('reply'); });
  const store = createArchiveStore({ ...config, root }); cleanup.push(() => store.close());
  let membership = true;
  const runtime = createWorldRuntime(ctx, config, store, { prompt: { names }, isHome: () => false, inWorkspace: () => membership });
  await runtime.start(); cleanup.push(() => runtime.stop());
  let entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const removeWait = ctx.on('agent/pre-step', async (_payload, next) => { const decision = await next(); entered(); await gate; return decision; }, { prepend: true });
  const { agent } = await ctx.agents.create({ sessionId: SessionId('prompt-race'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  agent.followup(user('ORIGINAL_BEFORE_SCOPE_CHANGED'));
  await waiting; membership = false; release(); await agent.whenIdle(); removeWait();
  assert.equal(requests.length, 0, 'stale world prompt must never reach the adapter');
  assert.ok(agent.session.snapshotEvents().some(event => event.type === 'turn/end' && event.data.reason.kind === 'error' && event.data.reason.error.code === 'DSH_WORLD_SCOPE_CHANGED'));
  agent.followup(user('retry outside')); await agent.whenIdle();
  assert.equal(requests.length, 1);
  assert.match(textOf(requests[0].messages), /ORIGINAL_BEFORE_SCOPE_CHANGED/);
  assert.doesNotMatch(systemOf(requests[0]), /我的世界/);
});

test('the memory sections of the shipped template follow their switches and say what the tools and files are for', () => {
  const on = renderWorldPrompt({ names, life, memoryTools: true }, shipped, undefined, true);
  assert.match(on, /## 找回过去[\s\S]*memory_find[\s\S]*memory_read/);
  assert.ok(!/\{\{/.test(on), on);
  const off = renderWorldPrompt({ names, life }, shipped, undefined, true);
  assert.ok(!/找回过去|memory_find/.test(off), 'without the capability the section is not in the prompt');
});
test('a custom world prompt is never changed: the console is told which memory variables it lacks and gets a snippet to paste', async () => {
  const { memoryTemplateGaps, MEMORY_SNIPPET_FILE } = await import('../src/worldPrompt.ts');
  assert.deepEqual(memoryTemplateGaps('我自己写的 {{self}}'), ['memoryTools']);
  assert.deepEqual(memoryTemplateGaps(shipped), []);
  assert.deepEqual(memoryTemplateGaps('{{#memoryTools}}x{{/memoryTools}} {{partner}}'), []);
  const custom = 'WORLD_INTRO {{self}}';
  assert.equal(renderWorldPrompt({ names, memoryTools: true }, custom, undefined, true), 'WORLD_INTRO');
  const snippet = (await readFile(MEMORY_SNIPPET_FILE, 'utf8')).replace(/^<!--[\s\S]*?-->\s*/, '').trim();
  const unix = (text: string) => text.replace(/\r\n/g, '\n');
  assert.ok(unix(shipped).includes(unix(snippet)), 'the snippet is exactly what the shipped template carries');
  assert.equal(renderWorldPrompt({ names, memoryTools: true }, snippet, undefined, true), renderWorldPrompt({ names, memoryTools: true }, shipped, undefined, true).replace(/^[\s\S]*?(?=## 找回过去)/, '').trim());
});
