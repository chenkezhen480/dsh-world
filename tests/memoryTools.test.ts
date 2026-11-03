import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createUserMessage, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { hostFixture, textResponse } from './hostFixture.ts';
import { createMemory, type MemoryService } from '../src/memory.ts';
import { createWorldRuntime } from '../src/runtime.ts';
import { createArchiveStore } from '../src/store.ts';
import { record } from './fixtures.ts';

const config = { worldId: 'fish', agentPreset: 'companion', timeZone: 'Asia/Seoul' };
const names = { companion: '小鱼', partner: '伙伴' };
const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const toolNames = (request: GenerateOptions) => request.tools?.map(tool => tool.name) ?? [];
const memoryToolNames = (request: GenerateOptions) => toolNames(request).filter(name => name.startsWith('memory_'));
const create = async (ctx: Awaited<ReturnType<typeof hostFixture>>['ctx'], id: string, preset = 'companion') => (await ctx.agents.create({ sessionId: SessionId(id), meta: { agentPreset: preset }, agentOptions: { provider: 'test', model: 'test' } })).agent;
async function* call(name: string, args: object, id = `${name}-call`): AsyncIterable<StreamChunk> {
  const block = { type: 'tool-call' as const, id: ToolCallId(id), name, arguments: JSON.stringify(args) };
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id: block.id, name, argumentsDelta: block.arguments };
  yield { type: 'block-end', index: 0, block };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}
const lastToolResult = (request: GenerateOptions) => request.messages.filter(message => message.role === 'tool').at(-1)?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') ?? '';

async function setup(t: test.TestContext, script: (request: GenerateOptions, index: number) => AsyncIterable<StreamChunk>, options: { inWorkspace?: (id: string) => boolean; memory?: (real: MemoryService) => MemoryService } = {}) {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, request => { requests.push(request); return script(request, requests.length - 1); });
  const store = createArchiveStore({ ...config, root });
  const room = join(root, 'room'); await mkdir(room, { recursive: true });
  const real = createMemory({ store: store.memory, timeZone: config.timeZone, sources: { diaryDir: join(room, '日记') }, visible: () => true });
  const service = options.memory?.(real) ?? real;
  const world = createWorldRuntime(ctx, config, store, { prompt: { names }, isHome: () => false, ...(options.inWorkspace ? { inWorkspace: options.inWorkspace } : {}), memory: service });
  await world.start(); cleanup.push(() => world.stop().finally(() => store.close()));
  return { ctx, store, world, requests, errors, room, memory: real };
}

test('both tools reach every world session with no life line at all, not other presets, and a lookup goes end to end', async t => {
  const s = await setup(t, (request, index) => index === 0 ? call('memory_find', { query: '潮汐' }) : index === 1 ? call('memory_read', { ref: JSON.parse(lastToolResult(request)).items[0].ref }) : textResponse('好'));
  await s.store.commitRecords([record('a1', { content: '我们聊过潮汐', sourceSessionId: 'chat', turnId: 'chat:1' })]);
  const agent = await create(s.ctx, 'chat');
  agent.followup(user('想想')); await agent.whenIdle();
  assert.deepEqual(memoryToolNames(s.requests[0]!), ['memory_find', 'memory_read']);
  const found = JSON.parse(lastToolResult(s.requests[1]!));
  assert.equal(found.items[0].kind, 'conversation'); assert.equal(found.coverage, undefined, 'a ready index adds nothing to the result'); assert.equal(found.items[0].text, '我们聊过潮汐');
  assert.equal(JSON.parse(lastToolResult(s.requests[2]!)).content, '我们聊过潮汐');
  const other = await create(s.ctx, 'elsewhere', 'other');
  other.followup(user('hi')); await other.whenIdle();
  assert.deepEqual(memoryToolNames(s.requests.at(-1)!), []);
  assert.equal(s.errors.length, 0);
});

test('invalid arguments and unreadable refs come back as tool errors, not as empty results', async t => {
  const s = await setup(t, (request, index) => index === 0 ? call('memory_find', { limit: 1000 }) : index === 1 ? call('memory_read', { ref: 'nonsense' }) : textResponse('好'));
  const agent = await create(s.ctx, 'chat');
  agent.followup(user('想想')); await agent.whenIdle();
  assert.match(lastToolResult(s.requests[1]!), /limit 必须是 1 到 100 的整数/);
  assert.match(lastToolResult(s.requests[2]!), /引用无效/);
});

test('leaving the workspace removes the tools, and a lookup that is waiting while the session leaves returns nothing', async t => {
  let inside = true; let release!: () => void; let entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const s = await setup(t, (_request, index) => index === 0 ? call('memory_find', { query: '秘密' }) : textResponse('好'), {
    inWorkspace: id => id === 'chat' && inside,
    memory: real => ({ ...real, find: async input => { const page = await real.find(input); entered(); await gate; return page; } }),
  });
  await s.store.commitRecords([record('a1', { content: '一个秘密', sourceSessionId: 'chat' })]);
  const agent = await create(s.ctx, 'chat');
  agent.followup(user('找找')); await reached; // the lookup has run and is waiting
  inside = false; release(); await agent.whenIdle();
  const result = lastToolResult(s.requests[1]!);
  assert.match(result, /会话不在世界工作区内/); assert.ok(!result.includes('一个秘密'));
  agent.followup(user('再来')); await agent.whenIdle();
  assert.deepEqual(memoryToolNames(s.requests.at(-1)!), [], 'the schemas are gone as well');
});

test('stopping the world takes the tools away and starting again registers them once', async t => {
  const s = await setup(t, () => textResponse('好'));
  const agent = await create(s.ctx, 'chat');
  agent.followup(user('一')); await agent.whenIdle();
  assert.equal(memoryToolNames(s.requests.at(-1)!).length, 2);
  await s.world.stop();
  agent.followup(user('二')); await agent.whenIdle();
  assert.deepEqual(memoryToolNames(s.requests.at(-1)!), []);
  const again = createWorldRuntime(s.ctx, config, s.store, { prompt: { names }, isHome: () => false, memory: s.memory });
  await again.start();
  const reopened = await create(s.ctx, 'chat-2');
  for (const text of ['三', '四']) { reopened.followup(user(text)); await reopened.whenIdle(); }
  agent.followup(user('五')); await agent.whenIdle();
  assert.deepEqual(memoryToolNames(s.requests.at(-1)!), ['memory_find', 'memory_read'], 'once, not twice');
  await again.stop();
});

test('a lookup returns a short page: eight hits by default, clipped excerpts, no bookkeeping fields', async t => {
  const s = await setup(t, (_request, index) => index === 0 ? call('memory_find', { query: '潮汐' }) : textResponse('好'));
  await s.store.commitRecords(Array.from({ length: 12 }, (_, i) => record(`b${i}`, { content: `潮汐${'很长'.repeat(300)}`, sourceSessionId: 'chat', turnId: `chat:${i}` })));
  const agent = await create(s.ctx, 'chat');
  agent.followup(user('想想')); await agent.whenIdle();
  const found = JSON.parse(lastToolResult(s.requests[1]!));
  assert.equal(found.items.length, 8); assert.ok(found.nextCursor);
  assert.ok(Array.from(found.items[0].text as string).length <= 201);
  for (const key of ['sourceId', 'timeBasis', 'current', 'search']) assert.ok(!(key in found.items[0]) && !(key in found), key);
});
