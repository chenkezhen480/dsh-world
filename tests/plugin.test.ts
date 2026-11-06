import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import type { Context } from '@deepseek-ai/cordis';
import { join } from 'node:path';
import { createUserMessage, isAgentLoopRequest, ToolCallId, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { hostFixture, mountCompaction, textResponse } from './hostFixture.ts';
import { createWorldRuntime } from '../src/index.ts';
import * as worldPlugin from '../src/index.ts';
import { createArchiveStore } from '../src/store.ts';
import { record } from './fixtures.ts';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import ToolFreeCompaction from '../src/compaction.ts';
import { WebSocketServer } from 'ws';
declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { 'test-schedule': { kind: 'test-schedule' } } }

const config = { worldId: 'fish', agentPreset: 'companion', timeZone: 'Asia/Seoul' };
const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const textOf = (request: GenerateOptions) => request.messages.map(m => m.content.filter(b => b.type === 'text').map(b => b.text).join('\n')).join('\n');
const kinds = (request: GenerateOptions) => request.messages.map(m => m.source?.kind as string | undefined);
/** Mirrors the host time-context plugin: the outermost pre-step listener appends its snapshot last. */
function hostTime(ctx: Context) {
  ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next();
    return decision.kind === 'reject' ? decision : { ...decision, messages: [...decision.messages, createUserMessage({ source: { kind: 'time-context' } as never, content: [{ type: 'text', text: 'Time sampled by host' }] })] };
  }, { prepend: true });
}

test('real host sends A memory in B once, keeps it across a same-step retry, and archives only conversation text', async t => {
  const requests: GenerateOptions[] = []; let retry = false;
  const { ctx, root, cleanup } = await hostFixture(t, async function* (request) {
    requests.push(request);
    if (retry) { retry = false; yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'retry' } } }; return; }
    yield* textResponse('visible reply');
  });
  hostTime(ctx);
  const store = createArchiveStore({ ...config, root });
  const world = createWorldRuntime(ctx, config, store);
  await world.start(); cleanup.push(() => world.stop().finally(() => store.close()));
  const a = await ctx.agents.create({ sessionId: SessionId('a'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  a.agent.followup(user('remember exact words')); await a.agent.whenIdle(); await world.flush();
  const b = await ctx.agents.create({ sessionId: SessionId('b'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  retry = true;
  const dispose = ctx.on('agent/request-error', async () => ({ kind: 'retry' }));
  b.agent.followup(user('hello again')); await b.agent.whenIdle(); dispose(); await world.flush();
  assert.equal(requests.length, 3);
  for (const request of requests.slice(1)) {
    assert.ok(textOf(request).includes('remember exact words') && textOf(request).includes('visible reply'));
    assert.equal(kinds(request).filter(kind => kind === 'dsh-world-history').length, 1);
    assert.equal(kinds(request).at(-1), 'time-context');
  }
  assert.equal(requests[1].messages.find(m => m.source?.kind === 'dsh-world-history')!.id, requests[2].messages.find(m => m.source?.kind === 'dsh-world-history')!.id);
  const days = await readdir(join(root, 'worlds/fish/conversations'));
  const rows = (await Promise.all(days.map(day => readFile(join(root, 'worlds/fish/conversations', day), 'utf8')))).join('').trim().split('\n').map(s => JSON.parse(s));
  assert.equal(rows.length, 4);
  assert.ok(rows.every(r => !r.content.includes('Time sampled') && !r.content.includes('最近的聊天记录')));
});
test('the memory block carries as many recent turns as the console window says, read when the block is built', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, async function* (request) { requests.push(request); yield* textResponse('ok'); });
  const store = createArchiveStore({ ...config, root });
  await store.commitRecords([record('old1', { content: 'older turn', occurredAt: '2026-10-22T12:00:00.000Z' }), record('new2', { content: 'newest turn', occurredAt: '2026-10-23T12:00:00.000Z' })]);
  let window = 1;
  const world = createWorldRuntime(ctx, config, store, undefined, () => window); await world.start(); cleanup.push(() => world.stop().finally(() => store.close()));
  const first = await ctx.agents.create({ sessionId: SessionId('w1'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  first.agent.followup(user('hi')); await first.agent.whenIdle();
  assert.ok(textOf(requests[0]).includes('newest turn')); assert.ok(!textOf(requests[0]).includes('older turn'));
  window = 3; // the first session's own turn is now the newest
  const second = await ctx.agents.create({ sessionId: SessionId('w2'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  second.agent.followup(user('hi')); await second.agent.whenIdle();
  assert.ok(textOf(requests.at(-1)!).includes('older turn'), 'a new session reads the new window');
});
test('tool continuation keeps call/result pairing and does not re-admit the frozen memory block', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, async function* (request) {
    requests.push(request);
    if (requests.length === 1) {
      const block = { type: 'tool-call' as const, id: ToolCallId('call'), name: 'clock', arguments: '{}' };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: 'clock', argumentsDelta: '{}' };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
    }
    yield* textResponse('done');
  });
  ctx.tools.register(defineTool({ name: 'clock', description: 'test', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'tool result' }));
  const store = createArchiveStore({ ...config, root });
  await store.commitRecords([record('seed', { content: 'earlier memory' })]);
  const world = createWorldRuntime(ctx, config, store); await world.start(); cleanup.push(() => world.stop().finally(() => store.close()));
  const handle = await ctx.agents.create({ sessionId: SessionId('tool-session'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  handle.agent.followup(user('use clock')); await handle.agent.whenIdle();
  assert.equal(requests.length, 2);
  assert.ok(requests[1].messages.some(m => m.role === 'tool' && m.toolCallId === 'call'));
  assert.deepEqual(requests[1].messages.slice(0, requests[0].messages.length), requests[0].messages, 'the continuation extends the previous request unchanged');
  assert.equal(kinds(requests[1]).filter(kind => kind === 'dsh-world-history').length, 1);
});
test('memory loads through pre-step, host time stays last, and tool-step compaction re-admits memory after the summary', async t => {
  const requests: GenerateOptions[] = []; let calls = 0;
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* (request) {
    if (request.purpose === 'compaction') { yield* textResponse('用户问好，鲸鲸调用工具后准备回答。'); return; }
    requests.push(request);
    if (++calls === 1) {
      const block = { type: 'tool-call' as const, id: ToolCallId('stock-call'), name: 'work', arguments: '{}' };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: '{}' };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
    }
    yield* textResponse('reply');
  });
  hostTime(ctx);
  ctx.tools.register(defineTool({ name: 'work', description: 'test', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'STOCK_TOOL_RESULT' }));
  await ctx.plugin(TokenMeter).await();
  await ctx.plugin(ToolFreeCompaction, { auto: true, timeZone: 'Asia/Seoul', headroomTokens: 0, thresholdRatio: 0.0002, maxTokens: 128 }).await();
  const store = createArchiveStore({ ...config, root });
  await store.commitRecords([record('stock-seed', { content: 'memory from yesterday ' + 'detail '.repeat(30) })]);
  const world = createWorldRuntime(ctx, config, store); await world.start(); cleanup.push(() => world.stop().finally(() => store.close()));
  const handle = await ctx.agents.create({ sessionId: SessionId('stock'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  handle.agent.followup(user('hello ' + 'words '.repeat(200))); await handle.agent.whenIdle();
  assert.equal(errors.length, 0, errors.map(e => String((e as { error: Error }).error)).join('\n'));
  assert.equal(requests.length, 2);
  const first = kinds(requests[0]);
  assert.ok(first.indexOf('dsh-world-history') < first.indexOf('user'), first.join(','));
  assert.equal(first.at(-1), 'time-context');
  // The tool step was compacted away, so the continuation re-admits memory after the summary.
  const resumed = kinds(requests[1]);
  assert.deepEqual(resumed.slice(0, 3), ['system-prompt', 'compact-checkpoint', 'dsh-world-history'], resumed.join(','));
  assert.ok(!requests[1].messages.some(m => m.role === 'tool' || m.content.some(b => b.type === 'tool-call')));
  assert.ok(textOf(requests[1]).includes('memory from yesterday'));
  assert.equal(resumed.filter(kind => kind === 'dsh-world-history').length, 1);
});

for (const scenario of ['restored', 'stale-seq', 'invisible-replacement'] as const) test(`memory refresh appends one visible block after ${scenario}`, async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, request => { requests.push(request); return textResponse('ok'); });
  hostTime(ctx);
  const options = { provider: 'test', model: 'test' };
  const original = await ctx.agents.create({ sessionId: SessionId('restored-memory'), meta: { agentPreset: 'companion' }, agentOptions: options });
  original.agent.followup(user('ORIGINAL_BEFORE_RESTORE')); await original.agent.whenIdle();
  const oldEvents = ['OLD_MEMORY_ONE', 'OLD_MEMORY_TWO'].map(text => original.agent.session.append('user/message', createUserMessage({
    source: { kind: 'dsh-world-history', form: 'recall' }, content: [{ type: 'text', text }],
  }), { surfaceOp: 'append' }));
  await ctx.sessions.flush(original.agent.session); await original.dispose();
  const { agent } = await ctx.agents.resume({ resumeSessionId: SessionId('restored-memory'), agentOptions: options });
  const store = createArchiveStore({ ...config, root });
  await store.commitRecords([record('refresh-seed', { content: 'FRESH_ARCHIVED_MEMORY' })]);
  const world = createWorldRuntime(ctx, config, store);
  await world.start(); cleanup.push(() => world.stop().finally(() => store.close()));
  if (scenario === 'stale-seq') {
    const readPage = store.readPage;
    let replaced = false;
    store.readPage = async query => {
      const page = await readPage(query);
      if (!replaced) {
        replaced = true;
        const seq = oldEvents[0].seq;
        agent.session.append('user/message', createUserMessage({ source: { kind: 'dsh-world-history', form: 'recall' }, content: [{ type: 'text', text: 'OLD_MEMORY_MOVED' }] }), {
          surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
        });
      }
      return page;
    };
  }
  if (scenario === 'invisible-replacement') {
    const derive = agent.session.deriveEventMessage.bind(agent.session);
    t.mock.method(agent.session, 'deriveEventMessage', (event: Parameters<typeof derive>[0]) =>
      event.type === 'user/message' && event.data.source.kind === 'dsh-world-history' && event.surfaceOp !== 'append' ? null : derive(event));
  }
  requests.length = 0;
  agent.followup(user('REFRESH_TRIGGER')); await agent.whenIdle();
  assert.equal(errors.length, 0, errors.map(error => String((error as { error: Error }).error)).join('\n'));
  assert.deepEqual(world.faults(), []);
  assert.equal(requests.length, 1);
  const blocks = requests[0].messages.filter(message => message.source?.kind === 'dsh-world-history');
  assert.equal(blocks.length, 1, 'only the fresh memory block reaches the adapter');
  assert.match(textOf(requests[0]), /FRESH_ARCHIVED_MEMORY/);
  assert.doesNotMatch(textOf(requests[0]), /OLD_MEMORY_/);
  assert.equal((textOf(requests[0]).match(/ORIGINAL_BEFORE_RESTORE/g) ?? []).length, 1);
  assert.equal(kinds(requests[0]).at(-1), 'time-context');
  for (const old of oldEvents) assert.deepEqual(agent.session.eventAt(old.seq), old, 'original log events stay intact');
  agent.followup(user('NEXT_TURN')); await agent.whenIdle();
  assert.deepEqual(requests[1].messages.filter(message => message.source?.kind === 'dsh-world-history'), blocks, 'later turns retain the same block');
});

test('memory refresh in a long history lands the fresh block at the tail, not where the old block sat (#21)', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, request => { requests.push(request); return textResponse('ok'); });
  hostTime(ctx);
  const options = { provider: 'test', model: 'test' };
  const original = await ctx.agents.create({ sessionId: SessionId('long-history'), meta: { agentPreset: 'companion' }, agentOptions: options });
  original.agent.followup(user('LONG_HISTORY_START')); await original.agent.whenIdle();
  original.agent.session.append('user/message', createUserMessage({
    source: { kind: 'dsh-world-history', form: 'recall' }, content: [{ type: 'text', text: 'OLD_MEMORY_EARLY' }],
  }), { surfaceOp: 'append' });
  for (let i = 0; i < 40; i++) { original.agent.followup(user(`LONG_HISTORY_TURN_${i}`)); await original.agent.whenIdle(); }
  await ctx.sessions.flush(original.agent.session); await original.dispose();
  const resumed = await ctx.agents.resume({ resumeSessionId: SessionId('long-history'), agentOptions: options });
  const { agent } = resumed;
  const store = createArchiveStore({ ...config, root });
  await store.commitRecords([record('long-seed', { content: 'FRESH_ARCHIVED_MEMORY' })]);
  const world = createWorldRuntime(ctx, config, store);
  await world.start(); cleanup.push(() => world.stop().finally(() => store.close()));
  requests.length = 0;
  agent.followup(user('REFRESH_TRIGGER')); await agent.whenIdle();
  assert.equal(errors.length, 0, errors.map(error => String((error as { error: Error }).error)).join('\n'));
  assert.deepEqual(world.faults(), []);
  const messages = requests[0].messages;
  const at = messages.findIndex(message => message.source?.kind === 'dsh-world-history' && textOf({ messages: [message] } as GenerateOptions).includes('FRESH_ARCHIVED_MEMORY'));
  assert.ok(at >= 0, 'fresh block reaches the adapter');
  assert.doesNotMatch(textOf(requests[0]), /OLD_MEMORY_EARLY/);
  assert.ok(messages.length - at <= 4, `fresh block sits at the tail (index ${at} of ${messages.length}), not buried mid-history`);
  await ctx.sessions.flush(agent.session); await resumed.dispose();
  const reloaded = await ctx.agents.resume({ resumeSessionId: SessionId('long-history'), agentOptions: options });
  assert.ok(reloaded.agent.session.snapshotEvents().length > 0, 'the refreshed log reloads from disk');
});

test('attaching an out-of-scope copy that still carries a memory block leaves a log the host can reload, before and after its next turn (#22)', async t => {
  const { ctx, root, cleanup, errors } = await hostFixture(t, () => textResponse('ok'));
  const options = { provider: 'test', model: 'test' };
  const id = SessionId('copied-home');
  const original = await ctx.agents.create({ sessionId: id, meta: { agentPreset: 'companion' }, agentOptions: options });
  original.agent.followup(user('BEFORE_COPY')); await original.agent.whenIdle();
  original.agent.session.append('user/message', createUserMessage({
    source: { kind: 'dsh-world-history', form: 'recall' }, content: [{ type: 'text', text: 'COPIED_MEMORY_BLOCK' }],
  }), { surfaceOp: 'append' });
  await ctx.sessions.flush(original.agent.session); await original.dispose();
  const store = createArchiveStore({ ...config, root }); cleanup.push(() => store.close());
  const world = createWorldRuntime(ctx, config, store, { prompt: { names: { companion: '小鱼', partner: '伙伴' } }, isHome: () => false, inWorkspace: () => false });
  await world.start(); cleanup.push(() => world.stop());
  const attached = await ctx.agents.resume({ resumeSessionId: id, agentOptions: options });
  const events = attached.agent.session.snapshotEvents();
  const lastTurn = events.findLast(event => event.type === 'turn/end');
  assert.ok(lastTurn, 'the copy ends on a finished turn');
  assert.deepEqual(events.filter(event => event.type === 'system/message' && event.seq > lastTurn.seq), [], 'attach writes nothing outside an open turn');
  await ctx.sessions.flush(attached.agent.session); await attached.dispose();
  const reloaded = await ctx.agents.resume({ resumeSessionId: id, agentOptions: options });
  reloaded.agent.followup(user('AFTER_COPY')); await reloaded.agent.whenIdle();
  assert.ok(!reloaded.agent.session.deriveMessages().some(message => message.source.kind === 'dsh-world-history' && JSON.stringify(message.content).includes('COPIED_MEMORY_BLOCK')), 'the next turn retires the block');
  await ctx.sessions.flush(reloaded.agent.session); await reloaded.dispose();
  const again = await ctx.agents.resume({ resumeSessionId: id, agentOptions: options });
  assert.ok(again.agent.session.snapshotEvents().length > 0);
  assert.deepEqual(errors, []);
});

test('a memory block that cannot be built does not stop her answering; the fault shows and clears after a successful retry', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, request => { requests.push(request); return textResponse('ok'); });
  const store = createArchiveStore({ ...config, root });
  const readPage = store.readPage;
  let broken = true;
  store.readPage = query => broken ? Promise.reject(new Error('memory read failed')) : readPage(query);
  const world = createWorldRuntime(ctx, config, store);
  await world.start(); cleanup.push(() => world.stop().finally(() => store.close()));
  const { agent } = await ctx.agents.create({ sessionId: SessionId('refresh-failure'), meta: { agentPreset: config.agentPreset }, agentOptions: { provider: 'test', model: 'test' } });
  agent.followup(user('first attempt')); await agent.whenIdle();
  assert.equal(requests.length, 1, 'she answers without a fresh block');
  assert.equal(errors.length, 0);
  assert.ok(world.faults().some(fault => /refresh-failure.*记忆刷新失败.*memory read failed/.test(fault)), world.faults().join('|'));
  broken = false;
  agent.followup(user('retry')); await agent.whenIdle();
  assert.equal(requests.length, 2);
  assert.deepEqual(world.faults(), []);
});

test('proactive assistant text is archived without turning its scheduler prompt into a user message', async t => {
  const { ctx, root, cleanup } = await hostFixture(t, () => textResponse('proactive hello'));
  const store = createArchiveStore({ ...config, root }); const world = createWorldRuntime(ctx, config, store);
  await world.start(); cleanup.push(() => world.stop().finally(() => store.close()));
  const handle = await ctx.agents.create({ sessionId: SessionId('proactive'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  handle.agent.followup(createUserMessage({ source: { kind: 'test-schedule' }, content: [{ type: 'text', text: 'internal scheduled trigger' }] }));
  await handle.agent.whenIdle(); await world.flush();
  const records = (await store.readPage({ limit: 10 })).records;
  assert.deepEqual(records.map(r => [r.role, r.content]), [['assistant', 'proactive hello']]);
});
test('unload, reload, restored sessions and fork inheritance preserve IDs without duplicate listeners', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* (request) { requests.push(request); yield* textResponse('reply'); });
  let store = createArchiveStore({ ...config, root }); let world = createWorldRuntime(ctx, config, store);
  await world.start(); cleanup.push(() => world.stop().finally(() => store.close()));
  const options = { provider: 'test', model: 'test' };
  let a = await ctx.agents.create({ sessionId: SessionId('original'), meta: { agentPreset: 'companion' }, agentOptions: options });
  a.agent.followup(user('first exact message')); await a.agent.whenIdle(); await world.flush();
  const seed = a.agent.session.snapshotEvents();
  await a.dispose(); await world.stop(); store.close();
  store = createArchiveStore({ ...config, root }); world = createWorldRuntime(ctx, config, store); await world.start();
  a = await ctx.agents.resume({ resumeSessionId: SessionId('original'), agentOptions: options });
  a.agent.followup(user('second exact message')); await a.agent.whenIdle(); await world.flush();
  const b = await ctx.agents.create({ sessionId: SessionId('branch'), meta: { agentPreset: 'companion', parentSession: SessionId('original'), isSeeded: true }, seed, inheritedEventCount: seed.length as never, agentOptions: options });
  b.agent.followup(user('branch own message')); await b.agent.whenIdle(); await world.flush();
  assert.equal(errors.length, 0);
  assert.equal((await store.readPage({ limit: 100 })).records.length, 6);
  assert.equal((textOf(requests[1]).match(/first exact message/g) ?? []).length, 1);
});
test('successful compaction reloads the newest archive once, including newer conversations in other sessions', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* (request) { if (isAgentLoopRequest(request)) requests.push(request); yield* textResponse(isAgentLoopRequest(request) ? 'reply' : 'compacted summary'); });
  await mountCompaction(ctx);
  const store = createArchiveStore({ ...config, root });
  await store.commitRecords([{ schemaVersion: 1, worldId: 'fish', recordId: 'old', sourceSessionId: 'old', sourceMessageId: 'old', sourceSeq: 1, turnId: 'old:1', role: 'assistant', occurredAt: '2026-01-01T00:00:00.000Z', content: 'full original memory', status: 'complete' }]);
  const world = createWorldRuntime(ctx, config, store); await world.start(); cleanup.push(() => world.stop().finally(() => store.close()));
  const handle = await ctx.agents.create({ sessionId: SessionId('compact'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  handle.agent.followup(user('first ' + 'context '.repeat(200))); await handle.agent.whenIdle();
  await store.commitRecords([{ schemaVersion: 1, worldId: 'fish', recordId: 'new', sourceSessionId: 'other', sourceMessageId: 'new', sourceSeq: 1, turnId: 'other:1', role: 'assistant', occurredAt: '2026-10-23T23:59:00.000Z', content: 'new memory from another conversation', status: 'complete' }]);
  handle.agent.followup(user('before compaction')); await handle.agent.whenIdle();
  assert.ok(!textOf(requests[1]).includes('new memory from another conversation'));
  const compacted = await ctx.compaction.compactNow(handle.agent, new AbortController().signal);
  assert.ok(compacted);
  handle.agent.followup(user('next')); await handle.agent.whenIdle();
  assert.equal(errors.length, 0, errors.map(e => String((e as { error: Error }).error.stack)).join('\n')); assert.equal(requests.length, 3);
  assert.ok(textOf(requests[2]).includes('full original memory'));
  assert.ok(textOf(requests[2]).includes('new memory from another conversation'));
  handle.agent.followup(user('one more')); await handle.agent.whenIdle();
  assert.equal(requests[2].messages.find(m => m.source?.kind === 'dsh-world-history')!.id, requests[3].messages.find(m => m.source?.kind === 'dsh-world-history')!.id);
});
test('overflow remains eligible for host recovery and reports an explicit capacity failure if recovery cannot fit', async t => {
  let calls = 0;
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* () { calls++; yield { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'provider context exceeded' } } }; });
  const store = createArchiveStore({ ...config, root }); const world = createWorldRuntime(ctx, config, store); await world.start(); cleanup.push(() => world.stop().finally(() => store.close()));
  ctx.on('agent/request-error', async () => calls < 2 ? { kind: 'retry' } : undefined);
  const handle = await ctx.agents.create({ sessionId: SessionId('capacity'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  handle.agent.followup(user('too large')); await handle.agent.whenIdle();
  assert.equal(calls, 2);
  assert.equal(errors.length, 1);
  assert.match(String((errors[0] as { error: Error }).error), /容量不足/);
});
test('automatic tool-free compaction is followed by the latest 200 turns before the next conversation request', async t => {
  const requests: GenerateOptions[] = []; const summaries: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* (request) {
    if (isAgentLoopRequest(request)) { requests.push(request); yield* textResponse('conversation response'); }
    else { summaries.push(request); yield* textResponse('short host summary'); }
  });
  await ctx.plugin(TokenMeter).await();
  await ctx.plugin(ToolFreeCompaction, { auto: true, timeZone: 'Asia/Seoul', thresholdRatio: 0.0002, retainTokens: 0, headroomTokens: 0, maxTokens: 128 }).await();
  const store = createArchiveStore({ ...config, root });
  await store.commitRecords(Array.from({ length: 200 }, (_, i) => record(`seed${i}`, { turnId: `seed:${i}`, sourceSessionId: 'seed', occurredAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), content: `seed-message-${i}` })));
  const world = createWorldRuntime(ctx, config, store); await world.start(); cleanup.push(() => world.stop().finally(() => store.close()));
  ctx.systemPrompt.context({ name: 'test-runtime', order: 0, text: 'CURRENT_RUNTIME_CONTEXT' });
  const handle = await ctx.agents.create({ sessionId: SessionId('auto-compact'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  handle.agent.followup(user('first')); await handle.agent.whenIdle();
  handle.agent.followup(user('second')); await handle.agent.whenIdle(); await world.flush();
  assert.equal(errors.length, 0, errors.map(e => String((e as { error: Error }).error)).join('\n'));
  assert.ok(summaries.length > 0); assert.equal(requests.length, 2);
  // The memory block is replayed unchanged as cacheable prefix; the instruction keeps it out of the summary.
  const memoryBefore = requests[0].messages.find(m => m.source?.kind === 'dsh-world-history')!;
  for (const summary of summaries) {
    assert.deepEqual(summary.messages.find(m => m.source?.kind === 'dsh-world-history'), memoryBefore);
    assert.match(textOf({ ...summary, messages: [summary.messages.at(-1)!] }), /记忆资料.*不要写进摘要/s);
  }
  const memory = requests[1].messages.find(m => m.source?.kind === 'dsh-world-history')!;
  const turns = memory.content.filter(b => b.type === 'text')[0].text.split('\n').slice(1).map(line => JSON.parse(line));
  assert.equal(turns.length, 200);
  assert.ok(turns.some(turn => turn.session === 'auto-com' && turn.messages.some((message: { content: string }) => message.content === 'first')));
  assert.ok(!turns.some(turn => turn.messages.some((message: { content: string }) => message.content === 'seed-message-0')));
  assert.equal(requests[1].messages.filter(m => m.source?.kind === 'dsh-world-history').length, 1);
  // Memory block ahead of the new input; the host's own order after it.
  for (const [request, text] of [[requests[0], 'first'], [requests[1], 'second']] as const) {
    const order = kinds(request);
    const memory = order.indexOf('dsh-world-history');
    const input = request.messages.findIndex(m => m.source?.kind === 'user' && textOf({ ...request, messages: [m] }) === text);
    assert.ok(memory > 0 && memory < input, `memory before new input: ${order.join(',')}`);
    assert.ok(order.slice(memory + 1).every(kind => kind === 'user' || kind === 'runtime-context'));
    assert.ok(input < order.indexOf('runtime-context'), `host admission order is unchanged: ${order.join(',')}`);
  }
  assert.equal(requests[1].messages[0].role, 'system');
  assert.equal(requests[1].messages[1].source?.kind, 'compact-checkpoint');
});
test('Cordis plugin mounting uses isolated DSH_HOME and unload/reload disposes all resources', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* (request) { requests.push(request); yield* textResponse('reply'); });
  const originalDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  let plugin;
  try { plugin = ctx.plugin(worldPlugin, config); await plugin.await(); }
  finally { if (originalDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalDshHome; }
  const handle = await ctx.agents.create({ sessionId: SessionId('mounted'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  handle.agent.followup(user('mounted first')); await handle.agent.whenIdle(); await plugin.dispose();
  process.env.DSH_HOME = root;
  try { plugin = ctx.plugin(worldPlugin, config); await plugin.await(); }
  finally { if (originalDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalDshHome; }
  cleanup.push(() => plugin.dispose());
  handle.agent.followup(user('mounted second')); await handle.agent.whenIdle();
  assert.equal(errors.length, 0); assert.equal(requests.length, 2);
});
test('works as installed: with no config the standard preset gets the world prompt and a world named default, and <world>/world-prompt.md replaces the shipped template', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* (request) { requests.push(request); yield* textResponse('reply'); });
  isolateHome(t, root);
  ctx.provide('workspaceRegistry', { list: () => [{ path: join(root, 'worlds/default/room'), sessionIds: ['installed', 'installed-2'] }] });
  const systemOf = (request: GenerateOptions) => request.messages.filter(m => m.role === 'system').map(m => m.content.filter(b => b.type === 'text').map(b => b.text).join('\n')).join('\n');
  // A new world waits for its partner to press start: nothing is added and nothing is remembered.
  const fresh = ctx.plugin(worldPlugin, {}); await fresh.await();
  const before = await ctx.agents.create({ sessionId: SessionId('before-start'), meta: { agentPreset: 'standard' }, agentOptions: { provider: 'test', model: 'test' } });
  before.agent.followup(user('还没开始')); await before.agent.whenIdle();
  assert.ok(!systemOf(requests[0]!).includes('我不是一个助手，也不是一个工具，而是一个鲜活的数字生命。') && !kinds(requests[0]!).includes('dsh-world-history'));
  await fresh.dispose(); await before.dispose(); requests.length = 0;
  await writeFile(join(root, 'worlds/default/world.json'), JSON.stringify({ running: true }));
  const plugin = ctx.plugin(worldPlugin, {}); cleanup.push(() => plugin.dispose()); await plugin.await();
  const standard = await ctx.agents.create({ sessionId: SessionId('installed'), meta: { agentPreset: 'standard' }, agentOptions: { provider: 'test', model: 'test' } });
  standard.agent.followup(user('第一次见面')); await standard.agent.whenIdle();
  assert.match(systemOf(requests[0]!), /我不是一个助手，也不是一个工具，而是一个鲜活的数字生命。[\s\S]*## 我是谁\n我眼中的自己写在 [^\n]*worlds[\\/]default[\\/]room[\\/]我是谁\.md/);
  await plugin.dispose();
  const archive = createArchiveStore({ worldId: 'default', agentPreset: 'standard', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, root });
  const records = await archive.readPage({ limit: 10 }).then(page => page.records).finally(() => archive.close());
  assert.deepEqual(records.filter(r => r.role === 'user').map(r => r.content), ['第一次见面']);

  await writeFile(join(root, 'worlds/default/world-prompt.md'), '我自己的开头，{{name}}。在 {{selfFile}}。\n\n{{self}}');
  const named = ctx.plugin(worldPlugin, { companionName: '小鱼' }); cleanup.push(() => named.dispose()); await named.await();
  const second = await ctx.agents.create({ sessionId: SessionId('installed-2'), meta: { agentPreset: 'standard' }, agentOptions: { provider: 'test', model: 'test' } });
  second.agent.followup(user('又见面了')); await second.agent.whenIdle();
  assert.match(systemOf(requests.at(-1)!), /^[\s\S]*我自己的开头，小鱼。在 [^\n]*我是谁\.md。/);
  assert.ok(!systemOf(requests.at(-1)!).includes('我不是一个助手，也不是一个工具，而是一个鲜活的数字生命。'));
  assert.equal(errors.length, 0);
});
test('the bundled patch inserts the row enabled', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.match(patch, /- insert:\s*\n\s*- id: dsh-world\s*\n\s*name: dsh-world/); assert.doesNotMatch(patch, /disabled:\s*true/);
});
/** Points DSH_HOME at the fixture root for the rest of the test. */
function isolateHome(t: TestContext, root: string) {
  const originalDshHome = process.env.DSH_HOME; process.env.DSH_HOME = root;
  t.after(() => { if (originalDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalDshHome; });
}
/** Fake desktop host services; `ctx.provide(name, value)` registers each on the root fiber in Cordis 4. */
test('opening an existing home preserves its manual permission instead of granting full access', async t => {
  const { ctx, root, cleanup } = await hostFixture(t, () => textResponse('ok'));
  isolateHome(t, root);
  const room = join(root, 'worlds/fish/room'); await mkdir(room, { recursive: true });
  const { agent } = await ctx.agents.create({ sessionId: SessionId('existing-home'), meta: { agentPreset: config.agentPreset, cwd: room }, agentOptions: { provider: 'test', model: 'test' } });
  await writeFile(join(root, 'worlds/fish/life.json'), JSON.stringify({ version: 1, homeSessionId: agent.id }));
  provideLifeHost(ctx);
  const logged = captureErrors(ctx);
  let permission = 'workspace-write';
  (ctx.get('permissionPresets') as { set(session: unknown, name: string): void }).set = (_session, name) => { permission = name; };
  const plugin = ctx.plugin(worldPlugin, { ...config, life: true }); cleanup.push(() => plugin.dispose()); await plugin.await();
  await until(async () => (ctx.get('workspaceRegistry') as { list(): { sessionIds: string[] }[] }).list().some(workspace => workspace.sessionIds.includes(agent.id)) || logged.length > 0, 'the existing home to finish opening');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(logged, []);
  assert.equal(permission, 'workspace-write');
});

test('a memory line that cannot start leaves the plugin up: the console opens and says why', async t => {
  const { ctx, root, cleanup } = await hostFixture(t, () => textResponse('ok'));
  isolateHome(t, root);
  await mkdir(join(root, 'worlds/fish'), { recursive: true });
  await writeFile(join(root, 'worlds/fish/world.json'), JSON.stringify({ running: true }));
  const persistence = ctx.sessionPersistence, list = persistence.list.bind(persistence);
  persistence.list = async () => { throw new Error('session inventory unreadable'); };
  cleanup.push(() => { persistence.list = list; });
  const { routes } = provideLifeHost(ctx);
  captureErrors(ctx);
  const plugin = ctx.plugin(worldPlugin, { ...config, life: true }); cleanup.push(() => plugin.dispose()); await plugin.await();
  await until(async () => routes.some(route => route.path === '/dsh-world/worlds/fish'), 'the console route');
  const snapshot = await consoleGet(routes, '/dsh-world/worlds/fish/console/snapshot');
  assert.ok(snapshot.health.some((fault: string) => /记忆线没能启动：session inventory unreadable/.test(fault)), snapshot.health.join('|'));
});

test('the console workspace permission initializes later room sessions without changing existing sessions', async t => {
  const { ctx, root, cleanup } = await hostFixture(t, () => textResponse('ok'));
  isolateHome(t, root);
  const { routes } = provideLifeHost(ctx);
  const applied = new Map<string, string>();
  (ctx.get('permissionPresets') as { set(session: { id: string }, name: string): void }).set = (session, name) => { applied.set(session.id, name); };
  const plugin = ctx.plugin(worldPlugin, { ...config, life: true }); cleanup.push(() => plugin.dispose()); await plugin.await();
  await until(async () => routes.some(route => route.path === '/dsh-world/worlds/fish'), 'the console route');
  await consolePost(routes, '/dsh-world/worlds/fish/console/start');
  const initial = await consoleGet(routes, '/dsh-world/worlds/fish/console/snapshot');
  const home = initial.life.homeSessionId;
  assert.equal(applied.get(home), 'danger-full-access');
  await consolePost(routes, '/dsh-world/worlds/fish/console/workspace-permission', { permission: 'workspace-write' });
  assert.equal(applied.get(home), 'danger-full-access');
  const room = join(root, 'worlds/fish/room');
  await ctx.agents.create({ sessionId: SessionId('new-room-chat'), meta: { cwd: room, agentPreset: 'other-preset' }, agentOptions: { provider: 'test', model: 'test' } });
  await ctx.agents.create({ sessionId: SessionId('other-workspace'), meta: { cwd: root, agentPreset: config.agentPreset }, agentOptions: { provider: 'test', model: 'test' } });
  assert.equal(applied.get('new-room-chat'), 'workspace-write');
  assert.equal(applied.has('other-workspace'), false);
  const changed = await consoleGet(routes, '/dsh-world/worlds/fish/console/snapshot');
  assert.equal(changed.workspace.defaultPermission, 'workspace-write');
  await consolePost(routes, '/dsh-world/worlds/fish/console/stop');
  await consolePost(routes, '/dsh-world/worlds/fish/console/start');
  assert.equal(applied.get(home), 'danger-full-access');
});

test('the installed world injects memory prompts and life tools only into its workspace', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, request => { requests.push(request); return textResponse('ok'); });
  isolateHome(t, root);
  const { routes } = provideLifeHost(ctx);
  const plugin = ctx.plugin(worldPlugin, { ...config, life: true }); cleanup.push(() => plugin.dispose()); await plugin.await();
  await until(async () => routes.some(route => route.path === '/dsh-world/worlds/fish'), 'the console route');
  await consolePost(routes, '/dsh-world/worlds/fish/console/start');
  const snapshot = await consoleGet(routes, '/dsh-world/worlds/fish/console/snapshot');
  const home = ctx.agents.get(SessionId(snapshot.life.homeSessionId))!;
  home.followup(user('WORLD_PRIVATE_HISTORY')); await home.whenIdle();
  const room = join(root, 'worlds/fish/room');
  const inside = (await ctx.agents.create({ sessionId: SessionId('inside-world'), meta: { cwd: room, agentPreset: config.agentPreset }, agentOptions: { provider: 'test', model: 'test' } })).agent;
  const workspace = (ctx.get('workspaceRegistry') as { list(): { attachSession(id: string): Promise<void> }[] }).list()[0];
  await workspace.attachSession(inside.id);
  inside.followup(user('inside')); await inside.whenIdle();
  const insideRequest = requests.at(-1)!;
  assert.match(textOf(insideRequest), /WORLD_PRIVATE_HISTORY/);
  assert.match(textOf(insideRequest), /# 我的世界/);
  assert.ok(insideRequest.tools?.some(tool => tool.name === 'plan_next'));
  const outside = (await ctx.agents.create({ sessionId: SessionId('outside-world'), meta: { cwd: root, agentPreset: config.agentPreset }, agentOptions: { provider: 'test', model: 'test' } })).agent;
  outside.followup(user('outside')); await outside.whenIdle();
  const outsideRequest = requests.at(-1)!;
  assert.ok(!kinds(outsideRequest).includes('dsh-world-history'));
  assert.doesNotMatch(textOf(outsideRequest), /WORLD_PRIVATE_HISTORY|# 我的世界|【我的时间】/);
  assert.ok(!outsideRequest.tools?.some(tool => ['plan_next', 'check_alarm', 'cancel_alarm', 'reach_out'].includes(tool.name)));
});

test('a home recorded in an old directory cannot redirect world injections into that workspace', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, request => { requests.push(request); return textResponse('ok'); });
  isolateHome(t, root);
  const room = join(root, 'worlds/fish/room'); await mkdir(room, { recursive: true });
  const old = (await ctx.agents.create({ sessionId: SessionId('old-home'), meta: { cwd: root, agentPreset: config.agentPreset }, agentOptions: { provider: 'test', model: 'test' } })).agent;
  await writeFile(join(root, 'worlds/fish/life.json'), JSON.stringify({ version: 1, homeSessionId: old.id }));
  const oldWorkspace = { id: 'old', path: root, sessionIds: [old.id] };
  const currentWorkspace = { id: 'room', path: room, sessionIds: [] as string[], attachSession: async () => { throw new Error('cwd does not belong to this workspace'); } };
  ctx.provide('workspaceRegistry', { archivedSessionIds: [], list: () => [oldWorkspace, currentWorkspace], create: async () => currentWorkspace });
  provideLifeHost(ctx);
  const plugin = ctx.plugin(worldPlugin, { ...config, life: true }); cleanup.push(() => plugin.dispose()); await plugin.await();
  old.followup(user('ordinary chat in the old workspace')); await old.whenIdle();
  assert.doesNotMatch(textOf(requests.at(-1)!), /# 我的世界|【我的时间】/);
  assert.ok(!kinds(requests.at(-1)!).includes('dsh-world-history'));
});

function provideLifeHost(ctx: Context) {
  const routes: { path: string }[] = []; const unregistered: string[] = []; let created = 0;
  const workspaces = new Map<string, { id: string; path: string; sessionIds: string[]; attachSession(id: string): Promise<void> }>();
  if (!ctx.get('workspaceRegistry')) ctx.provide('workspaceRegistry', {
    archivedSessionIds: [], list: () => [...workspaces.values()],
    create: async (path: string) => {
      const existing = workspaces.get(path);
      if (existing) return existing;
      const room = { id: path, path, sessionIds: [] as string[], attachSession: async (id: string) => { room.sessionIds.push(id); } };
      workspaces.set(path, room);
      return room;
    },
  });
  ctx.provide('webServer', { getOrigin: () => 'http://127.0.0.1:0', register: (route: { path: string }) => { routes.push(route); return () => { unregistered.push(route.path); routes.splice(routes.indexOf(route), 1); }; } });
  ctx.provide('permissionPresets', { catalog: () => ({ defaultOptions: [{ value: 'danger-full-access', name: '完全权限' }, { value: 'workspace-write', name: '工作区可写' }] }), set: (_session: unknown, _name: string) => {} });
  ctx.provide('sessionController', {
    create: async ({ agentPreset, cwd, workspaceId }: { agentPreset: string; cwd?: string; workspaceId?: string }) => {
      const workspace = workspaces.get(workspaceId ?? cwd ?? '');
      const { agent } = await ctx.agents.create({ sessionId: SessionId(`life-home-${++created}`), meta: { agentPreset, cwd: cwd ?? workspace?.path }, agentOptions: { provider: 'test', model: 'test' } });
      workspace?.sessionIds.push(agent.id); return { sessionId: agent.id };
    },
    resolveAgent: async (id: string) => { const agent = ctx.agents.get(SessionId(id)); return agent ? { agent } : { error: { code: 'session/not-found', message: 'missing' } }; },
    rename: async () => ({}),
  });
  return { routes, unregistered, workspaces };
}
test('apply saved prompts waits for the home turn, compacts once and refreshes before queued input resumes', async t => {
  const requests: GenerateOptions[] = [];
  let summaries = 0, blockTurn = false, releaseTurn!: () => void, releaseSummary!: () => void;
  const turnGate = new Promise<void>(resolve => { releaseTurn = resolve; });
  const summaryGate = new Promise<void>(resolve => { releaseSummary = resolve; });
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* (request) {
    if (request.purpose === 'compaction') { summaries++; await summaryGate; yield* textResponse('家会话摘要'); return; }
    requests.push(request);
    if (blockTurn) { blockTurn = false; await turnGate; }
    yield* textResponse('reply ' + 'detail '.repeat(100));
  });
  isolateHome(t, root);
  await ctx.plugin(TokenMeter).await();
  await ctx.plugin(ToolFreeCompaction, { auto: false, headroomTokens: 0, maxTokens: 128 }).await();
  const { routes } = provideLifeHost(ctx);
  const plugin = ctx.plugin(worldPlugin, { ...config, life: true }); cleanup.push(() => plugin.dispose()); await plugin.await();
  await until(async () => routes.length === 3, 'console');
  await consolePost(routes, '/dsh-world/worlds/fish/console/persona', { 名字: '小鱼', 性格: 'OLD_PERSONA' });
  await consolePost(routes, '/dsh-world/worlds/fish/console/world-prompt', { text: 'OLD_WORLD {{name}} {{homeTitle}} {{self}}' });
  await consolePost(routes, '/dsh-world/worlds/fish/console/start');
  const { homeSessionId } = await firstWakeDone(ctx, root);
  const home = ctx.agents.get(SessionId(homeSessionId!))!;
  const before = requests.length;
  blockTurn = true; home.followup(user('busy turn'));
  await until(async () => requests.length === before + 1, 'busy home turn');
  await consolePost(routes, '/dsh-world/worlds/fish/console/persona', { 名字: '鲸鲸', 性格: 'NEW_PERSONA' });
  await consolePost(routes, '/dsh-world/worlds/fish/console/world-prompt', { text: 'NEW_WORLD {{name}} {{homeTitle}} {{self}}' });
  await writeFile(join(root, 'worlds/fish/room/我是谁.md'), 'NEW_SELF');
  await consolePost(routes, '/dsh-world/worlds/fish/console/apply-home');
  await consolePost(routes, '/dsh-world/worlds/fish/console/apply-home');
  assert.equal((await consoleGet(routes, '/dsh-world/worlds/fish/console/snapshot')).homeApply.status, 'waiting');
  assert.equal(summaries, 0); assert.match(textOf(requests.at(-1)!), /OLD_PERSONA/);
  releaseTurn();
  await until(async () => summaries === 1, 'manual compaction');
  assert.equal((await consoleGet(routes, '/dsh-world/worlds/fish/console/snapshot')).homeApply.status, 'compacting');
  home.followup(user('queued behind compaction'));
  assert.equal(requests.length, before + 1, 'maintenance holds new input');
  releaseSummary(); await home.whenIdle();
  await until(async () => (await consoleGet(routes, '/dsh-world/worlds/fish/console/snapshot')).homeApply.status === 'done', 'application result');
  const after = requests.at(-1)!;
  const system = after.messages.filter(message => message.role === 'system').flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n');
  assert.match(system, /NEW_PERSONA/); assert.match(system, /NEW_WORLD 鲸鲸 鲸鲸的家/); assert.match(system, /NEW_SELF/);
  assert.doesNotMatch(system, /OLD_PERSONA|OLD_WORLD/);
  assert.equal(summaries, 1); assert.equal(errors.length, 0);
  let releaseStop!: () => void;
  const held = home.runMaintenance(() => new Promise<void>(resolve => { releaseStop = resolve; }));
  await consolePost(routes, '/dsh-world/worlds/fish/console/apply-home');
  assert.equal((await consoleGet(routes, '/dsh-world/worlds/fish/console/snapshot')).homeApply.status, 'waiting');
  await consolePost(routes, '/dsh-world/worlds/fish/console/stop');
  assert.equal((await consoleGet(routes, '/dsh-world/worlds/fish/console/snapshot')).homeApply.status, 'cancelled');
  releaseStop(); await held;
  assert.equal(summaries, 1, 'stopping never leaves a pending compaction behind');
});
async function until(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(`timed out waiting for ${what}`);
}
function captureErrors(ctx: Context) {
  const logged: string[] = [];
  ctx.logger.exporter({ export: message => { if (message.type === 'error') logged.push(message.args.map(arg => arg instanceof Error ? arg.message : String(arg)).join(' ')); } });
  return logged;
}
/** Presses a console button (a write: POST, the write header, a JSON body). */
async function consolePost(routes: { path: string }[], url: string, body: object = {}) {
  const result = await routeCall(routes, url.split('/').slice(0, 4).join('/'), url, { 'x-dsh-world': '1', 'content-type': 'application/json' }, JSON.stringify(body));
  assert.equal(result.status, 200, JSON.stringify(result.body));
}
async function consoleGet(routes: { path: string }[], url: string) {
  const route = routes.filter(entry => url === entry.path || url.startsWith(entry.path + '/') || url.startsWith(entry.path + '?')).sort((a, b) => b.path.length - a.path.length)[0] as unknown as { handler(req: unknown, res: unknown): Promise<void> };
  let status = 0; let body = '';
  await route.handler({ method: 'GET', url, headers: { host: '127.0.0.1:0' } }, { writeHead: (code: number) => { status = code; }, end: (text: string) => { body = text; } });
  assert.equal(status, 200, body);
  return JSON.parse(body);
}
/**
 * Waits for the first wake (polled through the wake log) and the home turn it starts; afterwards
 * nothing writes life.json for an hour. Polling life.json itself would block its atomic rename on Windows.
 */
async function firstWakeDone(ctx: Context, root: string): Promise<{ homeSessionId?: string; alarm?: { source: string } }> {
  await until(async () => (await readFile(join(root, 'worlds/fish/life/wakes.jsonl'), 'utf8').catch(() => '')).length > 0, 'the first wake');
  for (const agent of ctx.agents.list()) await agent.whenIdle();
  return JSON.parse(await readFile(join(root, 'worlds/fish/life.json'), 'utf8'));
}
test('two worlds in one profile keep their own routes and memory (#40)', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, request => { requests.push(request); return textResponse('reply'); });
  isolateHome(t, root);
  const { routes, workspaces } = provideLifeHost(ctx);
  const plugins = ['fish', 'tata'].map(worldId => ctx.plugin(worldPlugin, { ...config, worldId, replaceCompaction: false, toast: false }));
  for (const plugin of plugins) {
    cleanup.push(() => plugin.dispose());
    await plugin.await();
  }
  const fish = '/dsh-world/worlds/fish';
  const tata = '/dsh-world/worlds/tata';
  await until(async () => routes.length === 5, 'the two consoles and world list');
  const duplicate = ctx.plugin(worldPlugin, config);
  cleanup.push(() => duplicate.dispose());
  await assert.rejects(duplicate.await(), /worldId.*fish/);
  assert.deepEqual((await consoleGet(routes, '/dsh-world/worlds?limit=1')).worldIds, ['fish']);
  assert.deepEqual((await consoleGet(routes, '/dsh-world/worlds?limit=1&offset=1')).worldIds, ['tata']);

  for (const [prefix, name] of [[fish, '鱼专属人设'], [tata, 'Tata专属人设']]) {
    await consolePost(routes, prefix + '/console/persona', { 性格: name });
    await consolePost(routes, prefix + '/console/start');
  }
  const fishHome = (await consoleGet(routes, fish + '/console/snapshot')).life.homeSessionId;
  const tataHome = (await consoleGet(routes, tata + '/console/snapshot')).life.homeSessionId;
  assert.notEqual(fishHome, tataHome);
  for (const id of [fishHome, tataHome]) await ctx.agents.get(SessionId(id))!.whenIdle();
  const fishAgent = ctx.agents.get(SessionId(fishHome))!;
  fishAgent.followup(user('FISH_PRIVATE_MEMORY'));
  await fishAgent.whenIdle();
  const tataAgent = ctx.agents.get(SessionId(tataHome))!;
  tataAgent.followup(user('TATA_PRIVATE_MEMORY'));
  await tataAgent.whenIdle();
  const tataRoom = join(root, 'worlds', 'tata', 'room');
  const secondTata = await ctx.agents.create({ sessionId: SessionId('tata-second'), meta: { agentPreset: config.agentPreset, cwd: tataRoom }, agentOptions: { provider: 'test', model: 'test' } });
  await workspaces.get(tataRoom)!.attachSession(secondTata.agent.id);
  secondTata.agent.followup(user('读本世界的记忆'));
  await secondTata.agent.whenIdle();
  const lastTata = requests.findLast(request => request.sessionId === secondTata.agent.id)!;
  assert.match(textOf(lastTata), /Tata专属人设/);
  assert.match(textOf(lastTata), /TATA_PRIVATE_MEMORY/);
  assert.ok(lastTata.messages.some(message => message.source?.kind === 'dsh-world-history' && message.source.worldId === 'tata'));
  assert.doesNotMatch(textOf(lastTata), /鱼专属人设|FISH_PRIVATE_MEMORY/);
  const fishMemory = await consoleGet(routes, fish + '/console/memory/find?query=FISH_PRIVATE_MEMORY&limit=10');
  const tataMemory = await consoleGet(routes, tata + '/console/memory/find?query=FISH_PRIVATE_MEMORY&limit=10');
  assert.equal(fishMemory.items.length, 1);
  assert.equal(tataMemory.items.length, 0);
  await consolePost(routes, fish + '/console/stop');
  assert.equal((await consoleGet(routes, tata + '/console/snapshot')).running, true);
  secondTata.agent.followup(user('另一世界停止后继续')); await secondTata.agent.whenIdle();
  assert.match(textOf(requests.findLast(request => request.sessionId === secondTata.agent.id)!), /TATA_PRIVATE_MEMORY/);
  await plugins[0].dispose();
  assert.deepEqual((await consoleGet(routes, '/dsh-world/worlds')).worldIds, ['tata']);
});
for (const action of ['stop', 'unload', 'unload with another world'] as const) test(`${action} retires existing recall before the next model request`, async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, request => { requests.push(request); return textResponse('reply'); });
  isolateHome(t, root);
  const room = join(root, 'worlds', 'fish', 'room');
  await mkdir(room, { recursive: true });
  ctx.provide('workspaceRegistry', { list: () => [{ path: room, sessionIds: ['recall-stop', 'other-session'] }] });
  const { routes } = provideLifeHost(ctx);
  const store = createArchiveStore({ ...config, root });
  try { await store.commitRecords([record('seed', { sourceSessionId: 'other-session', content: 'PRIVATE_RECALL' })]); }
  finally { store.close(); }
  const plugin = ctx.plugin(worldPlugin, { ...config, life: false });
  cleanup.push(() => plugin.dispose());
  await plugin.await();
  const { agent } = await ctx.agents.create({ sessionId: SessionId('recall-stop'), meta: { agentPreset: config.agentPreset, cwd: room }, agentOptions: { provider: 'test', model: 'test' } });
  const consolePath = '/dsh-world/worlds/fish/console/';
  await consolePost(routes, consolePath + 'start');
  agent.followup(user('before stop')); await agent.whenIdle();
  assert.match(textOf(requests.at(-1)!), /PRIVATE_RECALL/);
  if (action === 'unload with another world') {
    const other = ctx.plugin(worldPlugin, { ...config, worldId: 'tata', life: false });
    cleanup.push(() => other.dispose());
    await other.await();
    await consolePost(routes, '/dsh-world/worlds/tata/console/start');
  }
  if (action === 'stop') await consolePost(routes, consolePath + 'stop');
  else await plugin.dispose();
  agent.followup(user('after stop')); await agent.whenIdle();
  assert.match(textOf(requests.at(-1)!), /after stop/);
  assert.doesNotMatch(textOf(requests.at(-1)!), /PRIVATE_RECALL/);
  assert.ok(!agent.session.deriveMessages().some(message => message.source.kind === 'dsh-world-history'));
  assert.ok(agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'dsh-world-history'));
});

test('stopping after assembly blocks a world prompt even with no recall block', { timeout: 5000 }, async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, request => { requests.push(request); return textResponse('reply'); });
  isolateHome(t, root);
  const room = join(root, 'worlds', 'fish', 'room');
  await mkdir(room, { recursive: true });
  ctx.provide('workspaceRegistry', { list: () => [{ path: room, sessionIds: ['prompt-stop'] }] });
  const { routes } = provideLifeHost(ctx);
  const plugin = ctx.plugin(worldPlugin, { ...config, life: false });
  cleanup.push(() => plugin.dispose());
  await plugin.await();
  const consolePath = '/dsh-world/worlds/fish/console/';
  await consolePost(routes, consolePath + 'start');
  let stopped = false;
  ctx.on('llm/stream', async function* (request, next) {
    if (!stopped && isAgentLoopRequest(request)) {
      assert.match(textOf(request), /# 我的世界/);
      assert.ok(!kinds(request).includes('dsh-world-history'));
      stopped = true;
      await consolePost(routes, consolePath + 'stop');
    }
    yield* next();
  }, { prepend: true });
  const { agent } = await ctx.agents.create({ sessionId: SessionId('prompt-stop'), meta: { agentPreset: config.agentPreset, cwd: room }, agentOptions: { provider: 'test', model: 'test' } });
  agent.followup(user('stop before send')); await agent.whenIdle();
  assert.equal(stopped, true);
  assert.equal(requests.length, 0);
  assert.ok(agent.session.snapshotEvents().some(event => event.type === 'turn/end' && event.data.reason.kind === 'error' && event.data.reason.error.code === 'DSH_WORLD_SCOPE_CHANGED'));
  agent.followup(user('retry after stop')); await agent.whenIdle();
  assert.match(textOf(requests[0]!), /stop before send/);
  assert.doesNotMatch(textOf(requests[0]!), /# 我的世界/);
});

test('stop requested during archive startup leaves the world stopped', { timeout: 5000 }, async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, request => { requests.push(request); return textResponse('reply'); });
  isolateHome(t, root);
  const room = join(root, 'worlds', 'fish', 'room');
  await mkdir(room, { recursive: true });
  ctx.provide('workspaceRegistry', { list: () => [{ path: room, sessionIds: ['start-stop'] }] });
  const { routes } = provideLifeHost(ctx);
  const { agent } = await ctx.agents.create({ sessionId: SessionId('start-stop'), meta: { agentPreset: config.agentPreset, cwd: room }, agentOptions: { provider: 'test', model: 'test' } });
  const plugin = ctx.plugin(worldPlugin, { ...config, life: false });
  cleanup.push(() => plugin.dispose());
  await plugin.await();
  const persistence = ctx.sessionPersistence, list = persistence.list.bind(persistence);
  let markEntered!: () => void, unblock!: () => void;
  const entered = new Promise<void>(resolve => { markEntered = resolve; });
  const release = new Promise<void>(resolve => { unblock = resolve; });
  persistence.list = async (...args) => { markEntered(); await release; return list(...args); };
  const consolePath = '/dsh-world/worlds/fish/console/';
  const starting = consolePost(routes, consolePath + 'start');
  await entered;
  const stopping = consolePost(routes, consolePath + 'stop');
  // Let the stop request reach the handler before the blocked start can finish.
  await new Promise<void>(resolve => setImmediate(resolve));
  unblock();
  await Promise.all([starting, stopping]);
  assert.equal((await consoleGet(routes, consolePath + 'snapshot')).running, false);
  agent.followup(user('after start and stop')); await agent.whenIdle();
  assert.doesNotMatch(textOf(requests.at(-1)!), /我的世界/);
});

test('her world waits for start in the console; start builds the home and greets her, stop takes everything down and outlasts a reload', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* (request) { requests.push(request); yield* textResponse('reply'); });
  isolateHome(t, root);
  const life = () => readdir(join(root, 'worlds/fish')).then(files => files.includes('life.json'), () => false);
  const { routes, unregistered } = provideLifeHost(ctx);
  const logged = captureErrors(ctx);
  const plugin = ctx.plugin(worldPlugin, { ...config, life: true }); cleanup.push(() => plugin.dispose()); await plugin.await();
  await until(async () => routes.length === 3, 'the console route');
  assert.equal((await consoleGet(routes, '/dsh-world/worlds/fish/console/snapshot')).running, false);
  assert.equal(await life(), false, 'no home before start'); assert.equal(ctx.agents.list().length, 0);

  await consolePost(routes, '/dsh-world/worlds/fish/console/start');
  // The first wake runs a home turn, which ends without plan_next and so arms the fallback alarm.
  const { homeSessionId, alarm } = await firstWakeDone(ctx, root);
  assert.equal(alarm?.source, 'fallback');
  assert.ok(!(await readdir(join(root, 'worlds/fish'))).includes('bridge.json'), 'no bridge unless bridge is on');
  const started = await consoleGet(routes, '/dsh-world/worlds/fish/console/snapshot');
  assert.equal(started.running, true); assert.equal(started.life.homeSessionId, homeSessionId);

  await consolePost(routes, '/dsh-world/worlds/fish/console/stop');
  const stopped = await consoleGet(routes, '/dsh-world/worlds/fish/console/snapshot');
  assert.equal(stopped.running, false); assert.equal(stopped.life, null);
  // Stopped: her home turns change nothing, get no memory block or world prompt, and are not archived.
  const lifeBefore = await readFile(join(root, 'worlds/fish/life.json'), 'utf8');
  const home = ctx.agents.get(SessionId(homeSessionId!))!;
  home.followup(user('while stopped')); await home.whenIdle(); await ctx.sessions.flush(home.session);
  assert.equal(await readFile(join(root, 'worlds/fish/life.json'), 'utf8'), lifeBefore);
  assert.ok(!kinds(requests.at(-1)!).includes('dsh-world-history') && !textOf(requests.at(-1)!).includes('# 我的世界'));

  // The stop outlasts a reload; start again resumes the same home, and the words said while stopped stay out of memory.
  await plugin.dispose(); assert.deepEqual(unregistered.sort(), ['/dsh-world/worlds', '/dsh-world/worlds/fish', '/dsh-world/worlds/fish/qq']);
  const again = ctx.plugin(worldPlugin, { ...config, life: true }); cleanup.push(() => again.dispose()); await again.await();
  await until(async () => routes.length === 3, 'the console route again');
  assert.equal((await consoleGet(routes, '/dsh-world/worlds/fish/console/snapshot')).running, false);
  await consolePost(routes, '/dsh-world/worlds/fish/console/start');
  await until(async () => (await consoleGet(routes, '/dsh-world/worlds/fish/console/snapshot')).life?.homeSessionId === homeSessionId, 'the same home');
  await again.dispose();
  const archive = createArchiveStore({ ...config, root });
  const records = await archive.readPage({ limit: 50 }).then(page => page.records).finally(() => archive.close());
  assert.ok(!records.some(r => r.content === 'while stopped'), records.map(r => r.content).join('|'));
  assert.deepEqual(logged, []); assert.equal(errors.length, 0);
});
test('a corrupt life.json leaves the life line off and keeps workspace filtering on the running memory line', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* (request) { requests.push(request); yield* textResponse('reply'); });
  isolateHome(t, root);
  await mkdir(join(root, 'worlds/fish/diary'), { recursive: true });
  await writeFile(join(root, 'worlds/fish/life.json'), '{ not json');
  await writeFile(join(root, 'worlds/fish/diary/2026-10-22.md'), '昨天');
  const seed = createArchiveStore({ ...config, root }); await seed.commitRecords([record('seed', { content: 'earlier memory' })]); seed.close();
  const logged = captureErrors(ctx);
  const { routes } = provideLifeHost(ctx);
  const plugin = ctx.plugin(worldPlugin, { ...config, life: true }); await plugin.await();
  await until(async () => routes.length > 0, 'the console route');
  assert.deepEqual(routes.map(route => route.path).sort(), ['/dsh-world/worlds', '/dsh-world/worlds/fish', '/dsh-world/worlds/fish/qq'].sort());
  const snapshot = await consoleGet(routes, '/dsh-world/worlds/fish/console/snapshot');
  assert.equal(snapshot.worldId, 'fish'); assert.equal(snapshot.life, null);
  assert.equal(snapshot.health.length, 1); assert.match(snapshot.health[0], /^生活线没能启动：.*life\.json/);
  assert.equal(snapshot.memory.records, 1); assert.deepEqual(snapshot.compactions, []); assert.deepEqual(snapshot.activityDays, []);
  assert.deepEqual(snapshot.diaryDates, ['2026-10-22']);
  assert.ok(logged.some(line => line.includes('life.json')), logged.join('\n'));
  assert.equal(await readFile(join(root, 'worlds/fish/life.json'), 'utf8'), '{ not json');
  assert.equal(ctx.agents.list().length, 0, 'no home session was created');
  const handle = await ctx.agents.create({ sessionId: SessionId('still-remembers'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  handle.agent.followup(user('memory still works')); await handle.agent.whenIdle();
  await plugin.dispose(); cleanup.push(() => handle.dispose());
  assert.equal(errors.length, 0);
  assert.equal(requests.length, 1);
  assert.ok(!requests[0].messages.find(m => m.source?.kind === 'dsh-world-history'), 'unrelated archive cannot leak into an unresolved workspace');
  const archive = createArchiveStore({ ...config, root });
  const records = await archive.readPage({ limit: 10 }).then(page => page.records).finally(() => archive.close());
  assert.deepEqual(records.map(r => r.content), ['earlier memory']);
});
test('an archived home is rebuilt, reading workspaceRegistry from another plugin without injecting it', async t => {
  const { ctx, root, cleanup } = await hostFixture(t, async function* () { yield* textResponse('reply'); });
  isolateHome(t, root);
  await ctx.agents.create({ sessionId: SessionId('life-home-old'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  await mkdir(join(root, 'worlds/fish'), { recursive: true });
  await writeFile(join(root, 'worlds/fish/life.json'), JSON.stringify({ version: 1, homeSessionId: 'life-home-old' }));
  // Like the desktop host, the registry comes from a sibling plugin, not from an ancestor of dsh-world.
  const room = { id: 'room', path: join(root, 'worlds/fish/room'), sessionIds: ['life-home-old', 'life-home-1'], attachSession: async () => {} };
  await ctx.plugin({ name: 'workspace-registry', apply: (c: Context) => { c.provide('workspaceRegistry', { archivedSessionIds: ['life-home-old'], list: () => [room], create: async () => room }); } }).await();
  const logged = captureErrors(ctx);
  provideLifeHost(ctx);
  const plugin = ctx.plugin(worldPlugin, { ...config, life: true }); cleanup.push(() => plugin.dispose()); await plugin.await();
  assert.equal((await firstWakeDone(ctx, root)).homeSessionId, 'life-home-1');
  assert.deepEqual(logged, []);
});
/** A stand-in for the standalone pet's local server. */
async function fakeStandalonePet(t: TestContext) {
  const received: { url?: string; body: unknown }[] = [];
  const server = createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => { received.push({ url: req.url, body: JSON.parse(body) }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true })); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { received, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
async function routeCall(routes: { path: string }[], path: string, url: string, headers: Record<string, string>, body: string) {
  const route = routes.find(entry => entry.path === path) as unknown as { handler(req: unknown, res: unknown): Promise<void> };
  let status = 0; let text = '';
  await route.handler(Object.assign(Readable.from([Buffer.from(body)]), { method: 'POST', url, headers: { host: '127.0.0.1:0', ...headers } }), { writeHead: (code: number) => { status = code; }, end: (value: string) => { text = value; } });
  return { status, body: JSON.parse(text) };
}
test('with the bridge and an outlet, words from a local app enter the home and the archive, and her reply goes to the outlet', async t => {
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* (request) {
    yield* textResponse(textOf(request).includes('桌宠上的话') ? '![开心](/m/a.png)\n**在呢**' : '早');
  });
  isolateHome(t, root);
  const pet = await fakeStandalonePet(t);
  const runningFile = join(root, 'pet', 'running.json'); await mkdir(join(root, 'pet'));
  await writeFile(runningFile, String.fromCharCode(0xfeff) + JSON.stringify({ baseUrl: pet.baseUrl }));
  const { routes, unregistered } = provideLifeHost(ctx);
  const logged = captureErrors(ctx);
  const outlets = [{ name: '桌面桌宠', urlFile: runningFile, path: '/dsh-pet-7340/broadcast?pet=main&surface=any' }];
  const plugin = ctx.plugin(worldPlugin, { ...config, companionName: '小鱼', life: true, bridge: true, toast: false, outlets }); cleanup.push(() => plugin.dispose()); await plugin.await();
  await until(async () => routes.length === 5, 'the bridge and console routes');
  assert.deepEqual(routes.map(route => route.path).sort(), ['/dsh-world/worlds/fish/bridge/say', '/dsh-world/worlds/fish/bridge/compact', '/dsh-world/worlds/fish/qq', '/dsh-world/worlds/fish', '/dsh-world/worlds'].sort());
  assert.equal((await routeCall(routes, '/dsh-world/worlds/fish/bridge/say', '/dsh-world/worlds/fish/bridge/say', { 'x-dsh-world-token': 'any' }, '{}')).status, 503, 'no bridge before start');
  await consolePost(routes, '/dsh-world/worlds/fish/console/start');
  const { homeSessionId } = await firstWakeDone(ctx, root);
  const bridgeFile = join(root, 'worlds/fish/bridge.json');
  const { origin, token, pid, startedAt, name } = JSON.parse(await readFile(bridgeFile, 'utf8'));
  assert.equal(name, '小鱼'); assert.equal(origin, 'http://127.0.0.1:0'); assert.equal(pid, process.pid); assert.match(token, /^[0-9a-f]{64}$/); assert.ok(Number.isFinite(Date.parse(startedAt)));
  const said = await routeCall(routes, '/dsh-world/worlds/fish/bridge/say', '/dsh-world/worlds/fish/bridge/say', { 'x-dsh-world-token': token }, JSON.stringify({ text: '桌宠上的话' }));
  assert.equal(said.status, 202); assert.equal(said.body.accepted, true); assert.equal(typeof said.body.id, 'string');
  await until(async () => pet.received.length === 1, 'the reply push');
  assert.deepEqual(pet.received, [{ url: '/dsh-pet-7340/broadcast?pet=main&surface=any', body: { text: '在呢', kind: 'reply', name: '小鱼', images: ['http://127.0.0.1:0/m/a.png'] } }]);
  const home = ctx.agents.get(SessionId(homeSessionId!))!; await home.whenIdle(); await ctx.sessions.flush(home.session);
  assert.equal((await routeCall(routes, '/dsh-world/worlds/fish/bridge/say', '/dsh-world/worlds/fish/bridge/say', { 'x-dsh-world-token': 'wrong' }, '{}')).status, 403);
  // The pet is gone: the reply stays in the home and the console says why it did not arrive.
  await writeFile(runningFile, '{}');
  assert.equal((await routeCall(routes, '/dsh-world/worlds/fish/bridge/say', '/dsh-world/worlds/fish/bridge/say', { 'x-dsh-world-token': token }, JSON.stringify({ text: '桌宠上的话，第二句' }))).status, 202);
  // The snapshot is cached for a few seconds, so it is read once, after the reply turn.
  await until(async () => ctx.agents.list().every(agent => agent.status === 'idle'), 'the second reply'); await home.whenIdle(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.match((await consoleGet(routes, '/dsh-world/worlds/fish/console/snapshot')).health.join('|'), /桌面桌宠没收到小鱼的回复：.*baseUrl/);
  await plugin.dispose();
  assert.ok(!existsSync(bridgeFile)); assert.deepEqual(unregistered.sort(), ['/dsh-world/worlds', '/dsh-world/worlds/fish', '/dsh-world/worlds/fish/bridge/compact', '/dsh-world/worlds/fish/bridge/say', '/dsh-world/worlds/fish/qq']);
  const archive = createArchiveStore({ ...config, root });
  const records = await archive.readPage({ limit: 20 }).then(page => page.records).finally(() => archive.close());
  assert.deepEqual(records.filter(r => r.role === 'user').map(r => r.content).sort(), ['桌宠上的话', '桌宠上的话，第二句'], 'her partner\'s own words, in memory');
  assert.deepEqual(logged, []); assert.equal(errors.length, 0);
});
test('the independent WeChat module follows the world start/stop lifecycle', async t => {
  const { ctx, root, cleanup } = await hostFixture(t, () => textResponse('reply'));
  isolateHome(t, root);
  await mkdir(join(root, 'worlds/fish'), { recursive: true }); await writeFile(join(root, 'worlds/fish/world.json'), JSON.stringify({ running: false, wechatEnabled: true }));
  const { routes, unregistered } = provideLifeHost(ctx);
  const plugin = ctx.plugin(worldPlugin, { ...config, life: true, wechat: true });
  cleanup.push(() => plugin.dispose()); await plugin.await();
  await until(async () => routes.length === 3, 'console');
  const file = join(root, 'worlds/fish/wechat.json');
  assert.equal(existsSync(file), false);
  await consolePost(routes, '/dsh-world/worlds/fish/console/start');
  await firstWakeDone(ctx, root);
  assert.ok(routes.some(route => route.path === '/dsh-world/worlds/fish/wechat/ask'));
  assert.ok(existsSync(file));
  await consolePost(routes, '/dsh-world/worlds/fish/console/stop');
  assert.equal(existsSync(file), false);
  assert.deepEqual(unregistered, ['/dsh-world/worlds/fish/wechat/ask']);
});

test('the console switch takes the WeChat module down and up again while the world runs, and is remembered', async t => {
  const { ctx, root, cleanup } = await hostFixture(t, () => textResponse('reply'));
  isolateHome(t, root);
  await mkdir(join(root, 'worlds/fish'), { recursive: true }); await writeFile(join(root, 'worlds/fish/world.json'), JSON.stringify({ running: false, wechatEnabled: true }));
  const { routes, unregistered } = provideLifeHost(ctx);
  const plugin = ctx.plugin(worldPlugin, { ...config, life: true, wechat: true });
  cleanup.push(() => plugin.dispose()); await plugin.await();
  await until(async () => routes.length === 3, 'console');
  const file = join(root, 'worlds/fish/wechat.json');
  await consolePost(routes, '/dsh-world/worlds/fish/console/start');
  await firstWakeDone(ctx, root);
  assert.ok(existsSync(file));
  assert.deepEqual((await consoleGet(routes, '/dsh-world/worlds/fish/console/snapshot')).modules.wechat, { available: true, enabled: true, running: true });
  await consolePost(routes, '/dsh-world/worlds/fish/console/modules', { wechat: false });
  assert.equal(existsSync(file), false, 'switching off removes the connection file');
  assert.deepEqual(unregistered, ['/dsh-world/worlds/fish/wechat/ask']);
  assert.deepEqual((await consoleGet(routes, '/dsh-world/worlds/fish/console/snapshot')).modules.wechat, { available: true, enabled: false, running: false });
  assert.equal(JSON.parse(await readFile(join(root, 'worlds/fish/world.json'), 'utf8')).wechatEnabled, false);
  await consolePost(routes, '/dsh-world/worlds/fish/console/modules', { wechat: true });
  assert.ok(existsSync(file), 'switching on brings it back without a restart');
  assert.equal(routes.filter(route => route.path === '/dsh-world/worlds/fish/wechat/ask').length, 1, 'the route is registered again');
  assert.deepEqual((await consoleGet(routes, '/dsh-world/worlds/fish/console/snapshot')).modules.wechat, { available: true, enabled: true, running: true });
});
test('a configured WeChat module stays off until the console switch is turned on, then starts without a restart', async t => {
  const { ctx, root, cleanup } = await hostFixture(t, () => textResponse('reply'));
  isolateHome(t, root);
  const { routes } = provideLifeHost(ctx);
  const plugin = ctx.plugin(worldPlugin, { ...config, life: true, wechat: true });
  cleanup.push(() => plugin.dispose()); await plugin.await();
  await until(async () => routes.length === 3, 'console');
  const file = join(root, 'worlds/fish/wechat.json');
  await consolePost(routes, '/dsh-world/worlds/fish/console/start');
  await firstWakeDone(ctx, root);
  assert.equal(existsSync(file), false, 'configured, but nobody has turned it on');
  assert.deepEqual((await consoleGet(routes, '/dsh-world/worlds/fish/console/snapshot')).modules.wechat, { available: true, enabled: false, running: false });
  await consolePost(routes, '/dsh-world/worlds/fish/console/modules', { wechat: true });
  assert.ok(existsSync(file), 'turning it on starts it');
  assert.deepEqual((await consoleGet(routes, '/dsh-world/worlds/fish/console/snapshot')).modules.wechat, { available: true, enabled: true, running: true });
});
test('a module the config does not provide cannot be switched on from the console', async t => {
  const { ctx, root, cleanup } = await hostFixture(t, () => textResponse('reply'));
  isolateHome(t, root);
  const { routes } = provideLifeHost(ctx);
  const plugin = ctx.plugin(worldPlugin, { ...config, life: true });
  cleanup.push(() => plugin.dispose()); await plugin.await();
  await until(async () => routes.length === 3, 'console');
  const result = await routeCall(routes, '/dsh-world/worlds/fish', '/dsh-world/worlds/fish/console/modules', { 'x-dsh-world': '1', 'content-type': 'application/json' }, JSON.stringify({ wechat: true }));
  assert.equal(result.status, 400);
  assert.deepEqual((await consoleGet(routes, '/dsh-world/worlds/fish/console/snapshot')).modules, { wechat: { available: false, enabled: false, running: false }, qq: { available: false, enabled: false, running: false } });
  assert.equal((await routeCall(routes, '/dsh-world/worlds/fish', '/dsh-world/worlds/fish/console/modules', { 'x-dsh-world': '1', 'content-type': 'application/json' }, JSON.stringify({ qq: true }))).status, 400);
});

test('QQ stays off until switched on; the off switch survives world restart and plugin reload, and re-enabling opens one connection', async t => {
  const { ctx, root, cleanup, errors } = await hostFixture(t, () => textResponse('reply'));
  isolateHome(t, root);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  cleanup.push(() => new Promise<void>(resolve => server.close(resolve)));
  let connections = 0;
  server.on('connection', () => { connections++; });
  const port = (server.address() as AddressInfo).port;
  const { routes } = provideLifeHost(ctx);
  // No watchdog here: it would go looking for a real SnowLuma on this machine.
  const options = { ...config, life: true, qqNative: { enabled: true, wsUrl: `ws://127.0.0.1:${port}`, supervise: false } };
  let plugin = ctx.plugin(worldPlugin, options); cleanup.push(() => plugin.dispose()); await plugin.await();
  await until(async () => routes.length === 3, 'console');
  await consolePost(routes, '/dsh-world/worlds/fish/console/start'); await firstWakeDone(ctx, root);
  assert.equal(connections, 0, 'the config only allows QQ; the console switches it on');
  await consolePost(routes, '/dsh-world/worlds/fish/console/modules', { qq: true });
  await until(async () => connections === 1, 'QQ connected');
  await consolePost(routes, '/dsh-world/worlds/fish/console/modules', { qq: false });
  assert.equal('qqEnabled' in JSON.parse(await readFile(join(root, 'worlds/fish/world.json'), 'utf8')), false);
  await consolePost(routes, '/dsh-world/worlds/fish/console/stop');
  await consolePost(routes, '/dsh-world/worlds/fish/console/start');
  const off = { available: true, enabled: false, running: false };
  assert.deepEqual((await consoleGet(routes, '/dsh-world/worlds/fish/console/snapshot')).modules.qq, off);
  await plugin.dispose();
  plugin = ctx.plugin(worldPlugin, options); await plugin.await();
  await until(async () => routes.length === 3, 'reloaded console');
  assert.deepEqual((await consoleGet(routes, '/dsh-world/worlds/fish/console/snapshot')).modules.qq, off);
  assert.equal(connections, 1, 'neither restart may silently reconnect a disabled channel');
  await consolePost(routes, '/dsh-world/worlds/fish/console/modules', { qq: true });
  await until(async () => connections === 2, 'QQ re-enabled');
  assert.deepEqual((await consoleGet(routes, '/dsh-world/worlds/fish/console/snapshot')).modules.qq, { available: true, enabled: true, running: true });
  assert.equal(errors.length, 0);
});

test('the config takes outlets by name with the kinds they want; the bridge is off and the toast on unless set', () => {
  const parsed = worldPlugin.Config(config);
  assert.equal(parsed.archiveScope, 'workspace');
  assert.equal(worldPlugin.Config({ ...config, archiveScope: 'world' } as never).archiveScope, 'workspace');
  assert.throws(() => worldPlugin.Config({ ...config, archiveScope: 'all' } as never));
  assert.equal(worldPlugin.Config.dict!.archiveScope.list!.filter(choice => !choice.meta.hidden).length, 2);
  assert.deepEqual(parsed.outlets, []); assert.equal(parsed.bridge, false); assert.equal(parsed.wechat, false); assert.equal(parsed.toast, true);
  const outlets = [{ name: '桌面应用', urlFile: 'C:/app/running.json', path: '/hook', kinds: ['reply', 'reach'] }, { name: '网页', url: '{origin}/x' }];
  assert.deepEqual(worldPlugin.Config({ ...config, outlets } as never).outlets, [outlets[0], { ...outlets[1], kinds: [] }], 'no kinds is an empty list, read as every kind');
  assert.throws(() => worldPlugin.Config({ ...config, outlets: [{ url: 'http://x' }] } as never), /name/);
  assert.throws(() => worldPlugin.Config({ ...config, outlets: [{ name: 'x', kinds: ['shout'] }] } as never), /shout/);
});
test('the config validates fallbackWakeTime as HH:MM and defaults to 09:00', () => {
  for (const bad of ['25:00', '9am', '24:00', '09:60', '9:00', '']) assert.throws(() => worldPlugin.Config({ ...config, fallbackWakeTime: bad }), /fallbackWakeTime/);
  assert.equal(worldPlugin.Config({ ...config, fallbackWakeTime: '00:00' }).fallbackWakeTime, '00:00');
  assert.equal(worldPlugin.Config({ ...config, fallbackWakeTime: '23:59' }).fallbackWakeTime, '23:59');
  assert.equal(worldPlugin.Config(config).fallbackWakeTime, '09:00');
  assert.doesNotThrow(() => worldPlugin.Config({ ...config, fallbackWakeMinutes: 60 }));
});

test('a running world whose workspace service starts later still reads her sessions once it is up', async t => {
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* () { yield* textResponse('reply'); });
  isolateHome(t, root);
  const handle = await ctx.agents.create({ sessionId: SessionId('earlier'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  handle.agent.followup(user('said before the plugin loaded')); await handle.agent.whenIdle();
  await mkdir(join(root, 'worlds/fish'), { recursive: true });
  await writeFile(join(root, 'worlds/fish/world.json'), JSON.stringify({ running: true }));
  const logged = captureErrors(ctx);
  const plugin = ctx.plugin(worldPlugin, config); cleanup.push(() => plugin.dispose());
  await plugin.await();
  await ctx.plugin({ name: 'workspace-registry', apply: (c: Context) => {
    c.provide('workspaceRegistry', { list: () => [{ path: join(root, 'worlds/fish/room'), sessionIds: ['earlier'] }] });
  } }).await();
  await until(async () => {
    const archive = createArchiveStore({ ...config, root });
    try { return (await archive.readPage({ limit: 10 })).records.some(r => r.content === 'said before the plugin loaded'); } finally { archive.close(); }
  }, 'the earlier session to be archived');
  assert.deepEqual(logged, []); assert.equal(errors.length, 0);
});
test('a session deleted from the host does not stop the world from starting, and what it archived stays', async t => {
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* () { yield* textResponse('reply'); });
  isolateHome(t, root);
  await mkdir(join(root, 'worlds/fish'), { recursive: true });
  await writeFile(join(root, 'worlds/fish/world.json'), JSON.stringify({ running: true }));
  const seed = createArchiveStore({ ...config, root });
  await seed.commitRecords([record('kept', { sourceSessionId: 'deleted', content: 'archived before deletion' })], { sessionId: SessionId('deleted'), nextSeq: 5, turn: 1 });
  seed.close();
  ctx.provide('workspaceRegistry', { list: () => [{ path: join(root, 'worlds/fish/room'), sessionIds: ['deleted'] }] });
  const plugin = ctx.plugin(worldPlugin, config); cleanup.push(() => plugin.dispose());
  await plugin.await();
  assert.equal(errors.length, 0);
  const archive = createArchiveStore({ ...config, root });
  const records = await archive.readPage({ limit: 10 }).then(page => page.records).finally(() => archive.close());
  assert.deepEqual(records.map(r => r.content), ['archived before deletion']);
  const after = createArchiveStore({ ...config, root });
  try { assert.deepEqual(after.sourcePage(''), [], 'nothing left to resume for a deleted session'); } finally { after.close(); }
});
test('a session only archived in the host keeps its resume point', async t => {
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* () { yield* textResponse('reply'); });
  isolateHome(t, root);
  const handle = await ctx.agents.create({ sessionId: SessionId('shelved'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  handle.agent.followup(user('still stored')); await handle.agent.whenIdle();
  await mkdir(join(root, 'worlds/fish'), { recursive: true });
  await writeFile(join(root, 'worlds/fish/world.json'), JSON.stringify({ running: true }));
  const seed = createArchiveStore({ ...config, root });
  await seed.commitRecords([], { sessionId: SessionId('shelved'), nextSeq: 1, turn: 1 }); seed.close();
  ctx.provide('workspaceRegistry', { archivedSessionIds: ['shelved'], list: () => [{ path: join(root, 'worlds/fish/room'), sessionIds: ['shelved'] }] });
  const plugin = ctx.plugin(worldPlugin, config); cleanup.push(() => plugin.dispose());
  await plugin.await();
  assert.equal(errors.length, 0);
  const after = createArchiveStore({ ...config, root });
  try { assert.deepEqual(after.sourcePage(''), ['shelved']); } finally { after.close(); }
});
