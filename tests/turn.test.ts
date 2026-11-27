import assert from 'node:assert/strict';
import test from 'node:test';
import { createUserMessage, ToolCallId, type ContextFormed, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { hostFixture, textResponse } from './hostFixture.ts';
import { askTurn } from '../src/ecosystem/shared/turn.ts';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'runtime-context': { kind: 'runtime-context' } & ContextFormed }
  interface MessageSourceMap { 'skill-catalog': { kind: 'skill-catalog'; form: 'catalog'; entries: { name: string; description: string }[] } }
}

// QQ sends what askTurn returns as her answer, so what counts as that answer is guarded here.
const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const ask = (ctx: Parameters<typeof askTurn>[0], agent: Parameters<typeof askTurn>[1], text: string) => askTurn(ctx, agent, user(text), { name: 'test' });
async function* toolCall(name: string, id = name): AsyncIterable<StreamChunk> {
  const call = { type: 'tool-call' as const, id: ToolCallId(id), name, arguments: '{}' };
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments };
  yield { type: 'block-end', index: 0, block: call };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}
const gated = () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  return { gate, reached, release, entered };
};
const tool = (name: string, execute: () => Promise<string>) => defineTool({ name, description: 'test', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute });

test('an empty final answer does not return earlier tool commentary as the answer', async t => {
  let calls = 0;
  const { ctx, cleanup } = await hostFixture(t, () => (async function* (): AsyncIterable<StreamChunk> {
    if (calls++ === 0) {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: '我先查一下' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '我先查一下' } };
      const block = { type: 'tool-call' as const, id: ToolCallId('check'), name: 'check', arguments: '{}' };
      yield { type: 'block-start', index: 1, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 1, id: block.id, name: block.name, argumentsDelta: block.arguments };
      yield { type: 'block-end', index: 1, block };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    } else yield { type: 'finish', reason: { kind: 'stop' } };
  })());
  const home = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  cleanup.push(home.ctx.tools.register(tool('check', async () => 'done')));
  assert.equal(await ask(ctx, home, '查一下'), '');
});

test('a later turn after hers is not returned as her answer', async t => {
  const { gate, reached, release, entered } = gated();
  let calls = 0;
  const { ctx } = await hostFixture(t, () => (async function* () {
    const first = calls++ === 0;
    if (first) { entered(); await gate; }
    yield* textResponse(first ? '她的答复' : '桌面私密答复');
  })());
  const home = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const reply = ask(ctx, home, '群里的问题');
  await reached;
  home.followup(user('桌面问题'));
  release();
  assert.equal(await reply, '她的答复');
  await home.whenIdle();
});

test('a cancelled turn is a failure, not a successful empty answer', async t => {
  const { ctx, cleanup } = await hostFixture(t, () => textResponse('不应发送'));
  const home = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  cleanup.push(ctx.on('session/event', (session, event) => {
    if (session.id === home.id && event.type === 'user/message') home.cancel({ kind: 'user' });
  }));
  await assert.rejects(ask(ctx, home, '取消的消息'), /did not finish/);
});

test('an answer is not returned until its own session log is durable', async t => {
  const { ctx } = await hostFixture(t, () => textResponse('不能丢失的回复'));
  const agent = (await ctx.agents.create({ sessionId: SessionId('group'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  let ended = false;
  const offEvent = ctx.on('session/event', (session, event) => { if (session.id === agent.id && event.type === 'turn/end') ended = true; });
  const offFlush = ctx.on('session/flush', async session => { if (ended && session.id === agent.id) throw new Error('group log disk failure'); });
  try { await assert.rejects(ask(ctx, agent, '群问题'), /group log disk failure/); }
  finally { offEvent(); offFlush(); }
});

test('words that cut in before she has said anything make it a failure, so a mixed answer never leaves', async t => {
  const { gate, reached, release, entered } = gated();
  let step = 0;
  const { ctx } = await hostFixture(t, () => step++ ? textResponse('混合内容') : toolCall('look_up', 'look'));
  ctx.tools.register(tool('look_up', async () => { entered(); await gate; return 'ok'; }));
  const home = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const reply = ask(ctx, home, '问题');
  const rejected = assert.rejects(reply, /did not finish/);
  await reached;
  home.steer(user('桌面内容'));
  release();
  await rejected; await home.whenIdle();
});

test('host snapshots, the first-session skill catalog and memory recall do not count as another person speaking', async t => {
  let injectSnapshot = () => {};
  const { ctx } = await hostFixture(t, () => { injectSnapshot(); return textResponse('正常答复'); });
  const home = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  injectSnapshot = () => {
    home.session.append('user/message', createUserMessage({ source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'time', text: '当前时间' }] }, content: [{ type: 'text', text: '当前时间' }] }), { surfaceOp: 'append' });
    home.session.append('user/message', createUserMessage({ source: { kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'test', description: '工具目录' }] }, content: [{ type: 'text', text: '可用技能目录' }] }), { surfaceOp: 'append' });
    home.session.append('user/message', createUserMessage({ source: { kind: 'dsh-world-history', form: 'recall' }, content: [{ type: 'text', text: '压缩后重注入的记忆' }] }), { surfaceOp: 'append' });
  };
  assert.equal(await ask(ctx, home, '在吗'), '正常答复');
});

test('what she said before other words cut in is her answer; what came after them is not', async t => {
  const { gate, reached, release, entered } = gated();
  let step = 0;
  const { ctx } = await hostFixture(t, () => (async function* (): AsyncIterable<StreamChunk> {
    if (step++) { yield* textResponse('混合内容'); return; }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: '我先看看' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '我先看看' } };
    const call = { type: 'tool-call' as const, id: ToolCallId('look'), name: 'look_up', arguments: '{}' };
    yield { type: 'block-start', index: 1, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 1, id: call.id, name: call.name, argumentsDelta: call.arguments };
    yield { type: 'block-end', index: 1, block: call };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  })());
  ctx.tools.register(tool('look_up', async () => { entered(); await gate; return 'ok'; }));
  const home = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const reply = ask(ctx, home, '问题');
  await reached;
  home.steer(user('桌面内容'));
  release();
  assert.equal(await reply, '我先看看');
  await home.whenIdle();
});

test('her own alarm ringing during the turn does not make it fail', async t => {
  const { gate, reached, release, entered } = gated();
  const { ctx } = await hostFixture(t, () => (async function* () { entered(); await gate; yield* textResponse('回完了'); })());
  const home = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const reply = ask(ctx, home, '问题');
  await reached;
  home.steer(createUserMessage({ source: { kind: 'dsh-world-life' }, content: [{ type: 'text', text: '闹钟响了' }] }));
  release();
  assert.equal(await reply, '回完了');
});
