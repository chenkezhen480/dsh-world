import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createUserMessage, ToolCallId, type ContextFormed, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Context } from '@deepseek-ai/cordis';
import { hostFixture, textResponse } from './hostFixture.ts';
import { createWechatHome } from '../src/ecosystem/wechat/home.ts';
import { createWechatModule } from '../src/ecosystem/wechat/index.ts';
import { replyMessages } from '../src/ecosystem/wechat/messages.ts';
import { createWechatRecorder } from '../src/ecosystem/wechat/archive.ts';
import { createArchiveStore } from '../src/store.ts';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { channelContext, contextJson } from '../src/ecosystem/shared/context.ts';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'runtime-context': { kind: 'runtime-context' } & ContextFormed }
  interface MessageSourceMap { 'skill-catalog': { kind: 'skill-catalog'; form: 'catalog'; entries: { name: string; description: string }[] } }
}

const identity = { channel: 'wechat', accountId: 'wxid_bot', conversationType: 'group' as const, conversationId: 'family@chatroom', speakerId: 'wechat:wxid_mom', speakerName: '妈妈' };

test('the WeChat module rejects a home outside its accepted workspace before injecting context or tools', async t => {
  let calls = 0;
  const { ctx, root, cleanup } = await hostFixture(t, () => { calls++; return textResponse('不应进入这里'); });
  const agent = (await ctx.agents.create({ sessionId: SessionId('outside'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const file = join(root, 'wechat.json');
  const channel = createWechatModule({ ctx, file, inWorld: () => false, home: async () => agent, origin: () => 'http://127.0.0.1:1', allowedHosts: [] });
  channel.start(); cleanup.push(channel.stop);
  const { token, path } = JSON.parse(await readFile(file, 'utf8'));
  const server = createServer((req, res) => { void channel.route.handler(req, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-world-token': token }, body: JSON.stringify({ text: '越界请求', identity }) });
  assert.equal(response.status, 503);
  assert.equal(calls, 0);
  assert.equal(agent.ctx.tools.get('wechat_send', agent), undefined);
  assert.equal(agent.ctx.tools.get('wechat_history', agent), undefined);
  assert.equal(agent.inbox.nextStep.length + agent.inbox.nextTurn.length, 0);
  assert.equal(agent.session.snapshotEvents().some(event => event.type === 'user/message'), false);
});

test('inbox insertions reconcile WeChat tools with workspace membership and retain the host tool underneath', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, request => { requests.push(request); return textResponse('已收到'); });
  const hostTool = defineTool({ name: 'wechat_send', description: '宿主原有工具', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'host' });
  cleanup.push(ctx.tools.register(hostTool));
  let inside = true;
  const agent = (await ctx.agents.create({ sessionId: SessionId('inside'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const channel = createWechatModule({ ctx, file: join(root, 'wechat.json'), inWorld: candidate => inside && candidate.id !== 'outside', home: async () => agent, origin: () => 'http://127.0.0.1:1', allowedHosts: [] });
  channel.start(); cleanup.push(channel.stop);
  const late = (await ctx.agents.create({ sessionId: SessionId('late'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const outside = (await ctx.agents.create({ sessionId: SessionId('outside'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  for (const candidate of [agent, late]) {
    for (const name of ['wechat_chats', 'wechat_send', 'wechat_delivery', 'wechat_history']) assert.ok(candidate.ctx.tools.get(name, candidate), name);
    assert.notEqual(candidate.ctx.tools.get('wechat_send', candidate), hostTool);
  }
  assert.equal(outside.ctx.tools.get('wechat_send', outside), hostTool);
  assert.equal(outside.ctx.tools.get('wechat_history', outside), undefined);
  inside = false;
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '移出工作区后的消息' }] }));
  await agent.whenIdle();
  assert.equal(agent.ctx.tools.get('wechat_send', agent), hostTool);
  for (const name of ['wechat_chats', 'wechat_delivery', 'wechat_history']) assert.equal(agent.ctx.tools.get(name, agent), undefined, name);
  assert.equal(requests.at(-1)!.tools?.find(tool => tool.name === 'wechat_send')?.description, '宿主原有工具');
  assert.equal(requests.at(-1)!.tools?.some(tool => tool.name === 'wechat_history'), false);
  inside = true;
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '重新进入工作区后的消息' }] }));
  await agent.whenIdle();
  assert.notEqual(agent.ctx.tools.get('wechat_send', agent), hostTool);
  assert.ok(agent.ctx.tools.get('wechat_history', agent));
  await channel.stop();
  assert.equal(agent.ctx.tools.get('wechat_send', agent), hostTool);
});

test('a plugin context without systemPrompt in its inject list can admit a session that enters the workspace at assembly', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, request => { requests.push(request); return textResponse('已收到'); });
  let inside = false;
  const agent = (await ctx.agents.create({ sessionId: SessionId('entering'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  let channel!: ReturnType<typeof createWechatModule>;
  // Like the real plugin: its services are only those it injected.
  await ctx.plugin({ name: 'scoped-wechat', inject: ['agents'], apply(scoped: Context) {
    channel = createWechatModule({ ctx: scoped, file: join(root, 'wechat.json'), inWorld: () => inside, home: async () => agent, origin: () => 'http://127.0.0.1:1', allowedHosts: [] });
    channel.start();
  } }).await();
  cleanup.push(() => channel.stop());
  // Membership arrives only by the time the prompt is assembled, after the inbox insertion.
  cleanup.push(ctx.on('system-prompt/assemble', (_assembly, _context, next) => { inside = true; return next(); }, { prepend: true }));
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '刚进工作区' }] }));
  await agent.whenIdle();
  assert.deepEqual(errors.map(error => String((error as { error?: unknown }).error ?? error)), []);
  assert.ok(requests.at(-1)!.tools?.some(tool => tool.name === 'wechat_history'));
});

for (const waitingFor of ['idle', 'images'] as const) {
  test(`WeChat checks workspace membership again after waiting for ${waitingFor}`, async t => {
    let release!: () => void, entered!: () => void, resolved!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const homeResolved = new Promise<void>(resolve => { resolved = resolve; });
    const requests: GenerateOptions[] = [];
    const { ctx, cleanup } = await hostFixture(t, request => (async function* () {
      requests.push(request);
      if (waitingFor === 'idle') { entered(); await gate; }
      yield* textResponse('桌面答复');
    })());
    const agent = (await ctx.agents.create({ sessionId: SessionId('moving'), agentOptions: { provider: 'test', model: 'test' } })).agent;
    let inside = true;
    const channel = createWechatHome({ ctx, home: async () => { resolved(); return agent; }, inWorld: () => inside, images: async () => {
      if (waitingFor === 'images') { entered(); await gate; }
      return [];
    } }); cleanup.push(channel.stop);
    if (waitingFor === 'idle') {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '桌面已有的请求' }] }));
      await waiting;
    }
    const rejected = assert.rejects(channel.ask('不得注入的微信消息', identity), /世界工作区/);
    await homeResolved;
    if (waitingFor === 'images') await waiting;
    inside = false; release();
    await rejected; await agent.whenIdle();
    assert.equal(requests.length, waitingFor === 'idle' ? 1 : 0);
    const messages = agent.session.snapshotEvents().filter(event => event.type === 'user/message');
    assert.equal(messages.some(event => event.data.source.kind === 'dsh-world-channel-context' || (event.data.source as { identity?: unknown }).identity), false);
    assert.equal(agent.inbox.nextStep.length + agent.inbox.nextTurn.length, 0);
  });
}

test('rendered group context names each speaker but states the conversation only once (#token)', () => {
  const here = { ...identity, conversationName: '一家人' };
  const messages = [
    { id: 'm.db:1', occurredAt: '2026-10-25T00:00:00Z', text: '前一句', identity: { ...here, speakerId: 'wechat:wxid_dad', speakerName: '爸爸', platformMessageId: 'm.db:1' } },
    { id: 'm.db:2', occurredAt: '2026-10-25T00:01:00Z', text: '我回了', identity: { ...here, speakerId: 'wechat:wxid_bot', speakerName: '她' } },
    { id: 'm.db:3', occurredAt: '2026-10-25T00:02:00Z', text: '带提及', identity: { ...here, speakerId: 'wechat:wxid_mom', mentionIds: ['wechat:wxid_bot'] } },
  ];
  const context = channelContext(messages, here);
  const text = contextJson(context, here);
  const rendered = JSON.parse(text) as { id: string; role: string; text: string; identity: Record<string, unknown> }[];
  assert.deepEqual(rendered.map(message => [message.id, message.role, message.text]), [['m.db:1', 'user', '前一句'], ['m.db:2', 'assistant', '我回了'], ['m.db:3', 'user', '带提及']]);
  assert.deepEqual(rendered[0].identity, { speakerId: 'wechat:wxid_dad', speakerName: '爸爸' }, 'only what differs per speaker');
  assert.deepEqual(rendered[2].identity, { speakerId: 'wechat:wxid_mom', speakerName: '妈妈', mentionIds: ['wechat:wxid_bot'] }, 'fields that are not conversation-wide stay');
  for (const shared of ['conversationId', 'conversationName', 'conversationType', 'accountId', 'channel']) assert.doesNotMatch(text, new RegExp(shared));
  assert.ok(text.length < JSON.stringify(context.map(message => ({ ...message, role: 'user' }))).length * 0.65, 'clearly smaller than repeating the full identity');
});

test('group context preserves sender IDs without accepting another conversation or becoming a fresh user request', async t => {
  const previous = { id: 'm.db:1', occurredAt: '2026-10-25T00:00:00Z', identity: { ...identity, speakerId: 'wechat:dad', speakerName: '爸爸' }, text: '前一句' };
  assert.throws(() => channelContext([{ ...previous, identity: { ...identity, conversationId: 'other@chatroom' } }], identity));
  assert.throws(() => channelContext(Array.from({ length: 9 }, () => previous), identity));
  const requests: GenerateOptions[] = [];
  const { ctx, cleanup } = await hostFixture(t, request => { requests.push(request); return textResponse('群回复'); });
  const agent = (await ctx.agents.create({ sessionId: SessionId('group'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const channel = createWechatHome({ ctx, home: async received => { assert.equal(received.conversationId, identity.conversationId); return agent; } }); cleanup.push(channel.stop);
  await channel.ask('@她', identity, [previous]);
  const context = requests[0].messages.find(message => message.source?.kind === 'dsh-world-channel-context');
  assert.ok(context);
  assert.match(JSON.stringify(context), /wechat:dad/);
  assert.match(JSON.stringify(context), /前一句/);
});

test('delivery updates the same durable record, survives reopening and rejects stale or invalid receipts', async t => {
  const { root, cleanup } = await hostFixture(t, () => textResponse('unused'));
  const config = { root, worldId: 'test', agentPreset: 'test', timeZone: 'UTC' };
  let store = createArchiveStore(config);
  cleanup.push(() => store.close());
  const recorder = createWechatRecorder(store, 'test');
  const id = await recorder.record({ sessionId: 'home', messageId: 'answer', seq: 10, turn: 1, time: Date.now(), identity,
    messages: [{ type: 'text', text: '第一句' }, { type: 'sticker', stickerId: 'st_hi' }, { type: 'text', text: '最后一句' }] });
  await recorder.receipt({ id, confirmed: 1, status: 'uncertain' });
  assert.match((await store.readPage({ limit: 10 })).records[0].content, /已确认发送 1\/3/);
  store.close(); store = createArchiveStore(config);
  const restored = createWechatRecorder(store, 'test');
  await restored.receipt({ id, confirmed: 3, status: 'sent' });
  await restored.receipt({ id, confirmed: 3, status: 'sent' });
  await assert.rejects(restored.receipt({ id, confirmed: 1, status: 'uncertain' }));
  await assert.rejects(restored.receipt({ id, confirmed: 4, status: 'sent' }));
  const records = (await store.readPage({ limit: 10 })).records;
  assert.equal(records.length, 1);
  assert.match(records[0].content, /已确认发送 3\/3/);
  assert.doesNotMatch(records[0].content, /待发送|送达尚未确认/);
  const exported = await readFile(join(root, 'worlds/test/conversations', records[0].occurredAt.slice(0, 10) + '.jsonl'), 'utf8');
  assert.equal(exported.trim().split('\n').length, 1);
  assert.equal(JSON.parse(exported).content, records[0].content);
});

test('invalid outgoing payloads are rejected as a whole', () => {
  assert.throws(() => replyMessages([{ type: 'text', text: 'ok' }, { type: 'image' }]));
  assert.throws(() => replyMessages([{ type: 'text', text: '鱼'.repeat(1400) }]));
  assert.throws(() => replyMessages(Array.from({ length: 17 }, () => ({ type: 'text', text: 'x' }))));
});

test('non-home group delivery cannot bypass the configured shared archive scope', async t => {
  const { root, cleanup } = await hostFixture(t, () => textResponse('unused'));
  const store = createArchiveStore({ root, worldId: 'test', agentPreset: 'test', timeZone: 'UTC' }); cleanup.push(() => store.close());
  const recorder = createWechatRecorder(store, 'test', id => id === 'home');
  const id = await recorder.record({ sessionId: 'group', messageId: 'group-answer', seq: 5, turn: 1, time: Date.now(), identity,
    messages: [{ type: 'text', text: '只在群里的话' }] });
  await recorder.receipt({ id, confirmed: 1, status: 'sent' });
  assert.equal((await store.readPage({ limit: 10 })).records.length, 0);
  assert.deepEqual(store.delivery(id), { status: 'sent', confirmed: 1, total: 1 });
});

test('an empty final answer does not send earlier tool commentary as the WeChat reply', async t => {
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
  cleanup.push(home.ctx.tools.register(defineTool({ name: 'check', description: 'check', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'done' })));
  const channel = createWechatHome({ ctx, home: async () => home }); cleanup.push(channel.stop);
  const reply = await channel.ask('查一下', identity);
  assert.equal(reply.text, '');
  assert.equal('messages' in reply, false);
});

test('WeChat requests use the existing home and keep user-role sender identity', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, cleanup } = await hostFixture(t, request => { requests.push(request); return textResponse('最终答复'); });
  const home = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const channel = createWechatHome({ ctx, home: async () => home }); cleanup.push(channel.stop);
  const reply = await channel.ask('今晚吃什么', identity);
  assert.equal(reply.text, '最终答复');
  assert.equal('deliveryId' in reply, false, 'ordinary final text is kept in the session, not automatically sent');
  assert.equal('messages' in reply, false);
  const sent = requests[0].messages.find(message => message.id === reply.id)!;
  assert.equal(sent.role, 'user');
  assert.deepEqual((sent.source as unknown as { identity: unknown }).identity, identity);
  const event = home.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.id === reply.id);
  assert.ok(event, 'the actual home log contains the message');
});

test('a plain WeChat message carries one short header and no repeated tool instructions (#token)', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, cleanup } = await hostFixture(t, request => { requests.push(request); return textResponse('好'); });
  const home = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const channel = createWechatHome({ ctx, home: async () => home }); cleanup.push(channel.stop);
  const ken = { channel: 'wechat', accountId: 'wxid_bot', conversationType: 'private' as const, conversationId: 'wxid_ken', speakerId: 'wechat:wxid_ken', speakerName: 'Ken', platformMessageId: 'message_0.db:7' };
  const reply = await channel.ask('在吗', ken);
  const sent = requests[0].messages.find(message => message.id === reply.id)!;
  assert.deepEqual(sent.content, [{ type: 'text', text: '【微信「Ken」，chatId wxid_ken】\n在吗' }]);
  assert.equal(requests[0].messages.some(message => message.source?.kind === 'dsh-world-channel-context'), false);
  await channel.ask('@她', identity);
  const group = requests[1].messages.findLast(message => message.role === 'user' && message.source?.kind === 'user')!;
  assert.deepEqual(group.content, [{ type: 'text', text: '【微信群「family@chatroom」 妈妈 说，chatId family@chatroom】\n@她' }]);
});

test('WeChat conversations wait their turn and do not receive each other\'s reply', async t => {
  const { ctx, cleanup } = await hostFixture(t, request => {
    const last = request.messages.filter(message => message.role === 'user').at(-1)!;
    return textResponse(last.content.filter(block => block.type === 'text').map(block => block.text).join('').split('\n').at(-1)!);
  });
  const home = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const channel = createWechatHome({ ctx, home: async () => home }); cleanup.push(channel.stop);
  const [a, b] = await Promise.all([channel.ask('第一人', identity), channel.ask('第二人', { ...identity, conversationId: 'private', speakerId: 'wechat:wxid_dad' })]);
  assert.equal(a.text, '第一人'); assert.equal(b.text, '第二人'); assert.notEqual(a.id, b.id);
  channel.stop(); await assert.rejects(channel.ask('停止后', identity), /stopped/);
});

test('a later desktop turn is not returned as the WeChat answer', async t => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const running = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  const { ctx, cleanup } = await hostFixture(t, () => (async function* () {
    const first = calls++ === 0;
    if (first) { entered(); await gate; }
    yield* textResponse(first ? '微信答复' : '桌面私密答复');
  })());
  const home = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const channel = createWechatHome({ ctx, home: async () => home }); cleanup.push(channel.stop);
  const reply = channel.ask('群里的问题', identity);
  await running;
  home.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '桌面问题' }] }));
  release();
  assert.equal((await reply).text, '微信答复');
  await home.whenIdle();
});

test('a cancelled home request is a failure, not a successful empty answer', async t => {
  const { ctx, cleanup } = await hostFixture(t, () => textResponse('不应发送'));
  const home = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const channel = createWechatHome({ ctx, home: async () => home }); cleanup.push(channel.stop);
  cleanup.push(ctx.on('session/event', (session, event) => {
    if (session.id === home.id && event.type === 'user/message') home.cancel({ kind: 'user' });
  }));
  await assert.rejects(channel.ask('取消的消息', identity), /did not finish/);
});

test('a reply is not released for sending until its own session log is durable', async t => {
  const { ctx, cleanup } = await hostFixture(t, () => textResponse('不能丢失的群回复'));
  const agent = (await ctx.agents.create({ sessionId: SessionId('group'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  let ended = false;
  const offEvent = ctx.on('session/event', (session, event) => { if (session.id === agent.id && event.type === 'turn/end') ended = true; });
  const offFlush = ctx.on('session/flush', async session => { if (ended && session.id === agent.id) throw new Error('group log disk failure'); });
  const channel = createWechatHome({ ctx, home: async () => agent }); cleanup.push(channel.stop);
  try {
    await assert.rejects(channel.ask('群问题', identity), /group log disk failure/);
  } finally { offEvent(); offFlush(); }
});

test('desktop words that cut in before she has said anything keep the mixed answer from leaving on WeChat', async t => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const running = new Promise<void>(resolve => { entered = resolve; });
  let step = 0;
  const { ctx, cleanup } = await hostFixture(t, () => (async function* (): AsyncIterable<StreamChunk> {
    if (step++) { yield* textResponse('混合内容'); return; }
    const call = { type: 'tool-call' as const, id: ToolCallId('look'), name: 'look_up', arguments: '{}' };
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments };
    yield { type: 'block-end', index: 0, block: call };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  })());
  ctx.tools.register(defineTool({ name: 'look_up', description: 'test', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => { entered(); await gate; return 'ok'; } }));
  const home = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const channel = createWechatHome({ ctx, home: async () => home }); cleanup.push(channel.stop);
  const reply = channel.ask('微信问题', identity);
  const rejected = assert.rejects(reply, /did not finish/);
  await running;
  home.steer(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '桌面内容' }] }));
  release();
  await rejected; await home.whenIdle();
});

test('host snapshots, the first-session skill catalog and memory recall do not count as another person speaking', async t => {
  let injectSnapshot = () => {};
  const { ctx, cleanup } = await hostFixture(t, () => { injectSnapshot(); return textResponse('微信正常答复'); });
  const home = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  injectSnapshot = () => {
    home.session.append('user/message', createUserMessage({ source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'time', text: '当前时间' }] }, content: [{ type: 'text', text: '当前时间' }] }), { surfaceOp: 'append' });
    home.session.append('user/message', createUserMessage({ source: { kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'test', description: '工具目录' }] }, content: [{ type: 'text', text: '可用技能目录' }] }), { surfaceOp: 'append' });
    home.session.append('user/message', createUserMessage({ source: { kind: 'dsh-world-history', form: 'recall' }, content: [{ type: 'text', text: '压缩后重注入的记忆' }] }), { surfaceOp: 'append' });
  };
  const channel = createWechatHome({ ctx, home: async () => home }); cleanup.push(channel.stop);
  assert.equal((await channel.ask('在吗', identity)).text, '微信正常答复');
});

test('what she said before desktop words cut in still goes out on WeChat; what came after them does not', async t => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const looking = new Promise<void>(resolve => { entered = resolve; });
  let step = 0;
  const { ctx, cleanup } = await hostFixture(t, () => (async function* (): AsyncIterable<StreamChunk> {
    if (step++) { yield* textResponse('混合内容'); return; }
    const call = { type: 'tool-call' as const, id: ToolCallId('look'), name: 'look_up', arguments: '{}' };
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: '我先看看' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '我先看看' } };
    yield { type: 'block-start', index: 1, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 1, id: call.id, name: call.name, argumentsDelta: call.arguments };
    yield { type: 'block-end', index: 1, block: call };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  })());
  ctx.tools.register(defineTool({ name: 'look_up', description: 'test', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => { entered(); await gate; return 'ok'; } }));
  const home = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const channel = createWechatHome({ ctx, home: async () => home }); cleanup.push(channel.stop);
  const reply = channel.ask('微信问题', identity);
  await looking;
  home.steer(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '桌面内容' }] }));
  release();
  assert.equal((await reply).text, '我先看看');
  await home.whenIdle();
});

test('her own alarm ringing during a WeChat reply does not make the request fail', async t => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const running = new Promise<void>(resolve => { entered = resolve; });
  const { ctx, cleanup } = await hostFixture(t, () => (async function* () {
    entered(); await gate; yield* textResponse('回完了');
  })());
  const home = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const channel = createWechatHome({ ctx, home: async () => home }); cleanup.push(channel.stop);
  const reply = channel.ask('微信问题', identity);
  await running;
  home.steer(createUserMessage({ source: { kind: 'dsh-world-life' }, content: [{ type: 'text', text: '闹钟响了' }] }));
  release();
  assert.equal((await reply).text, '回完了');
});

test('the independent WeChat endpoint authenticates and validates before entering home; stop removes only its own discovery file', async t => {
  let calls = 0;
  const receipts: unknown[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, () => { calls++; return textResponse('已收到'); });
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const file = join(root, 'wechat.json');
  const channel = createWechatModule({ ctx, file, home: async () => agent, origin: () => 'http://127.0.0.1:1', allowedHosts: [], receipt: async receipt => { receipts.push(receipt); } });
  channel.start(); cleanup.push(channel.stop);
  assert.equal(agent.ctx.tools.get('wechat_send', agent), undefined, 'without inWorld only the explicitly requested home receives tools');
  const other = (await ctx.agents.create({ sessionId: SessionId('other'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  assert.equal(other.ctx.tools.get('wechat_history', other), undefined);
  const { token, path } = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(path, '/dsh-world/wechat/ask');
  const server = createServer((req, res) => { void channel.route.handler(req, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}${path}`;
  const request = (body: unknown, auth = token) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-world-token': auth }, body: JSON.stringify(body) });
  const receipt = { id: 'a'.repeat(64), confirmed: 2, status: 'sent' };
  assert.equal((await request({ receipt }, 'invalid')).status, 403);
  assert.equal((await request({ receipt: { ...receipt, confirmed: -1 } })).status, 400);
  assert.deepEqual(receipts, []);
  assert.equal((await request({ receipt })).status, 200);
  assert.deepEqual(receipts, [receipt]);
  assert.equal((await request({ text: 'hello', identity }, 'invalid')).status, 403);
  assert.equal((await request({ text: 'hello', identity: { ...identity, speakerId: 'qq:123' } })).status, 400);
  assert.equal((await request({ text: 'hello', identity: { ...identity, channel: 'qq', speakerId: 'qq:123' } })).status, 400);
  assert.equal((await request({ text: 'a'.repeat(40000), identity })).status, 400);
  assert.equal(calls, 0);
  const response = await request({ text: 'hello', identity });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).text, '已收到');
  assert.ok(agent.ctx.tools.get('wechat_send', agent));
  assert.ok(agent.ctx.tools.get('wechat_history', agent));
  assert.equal(other.ctx.tools.get('wechat_send', other), undefined);
  channel.stop(); assert.equal(existsSync(file), false);
  assert.equal((await request({ text: 'hello', identity })).status, 503);
  await writeFile(file, JSON.stringify({ token: 'newer-module' }));
  channel.stop(); assert.equal(existsSync(file), true);
});
