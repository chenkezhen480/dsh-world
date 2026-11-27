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
import { createWechatHome, WechatHomeBusy } from '../src/ecosystem/wechat/home.ts';
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

test('a plugin context without systemPrompt in its inject list admits a session that enters before tool selection', async t => {
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
  // DSH 0.2.2 selects tools before assembling the prompt; membership arrives after the inbox insertion.
  cleanup.push(ctx.on('session/event', (session, event) => { if (session === agent.session && event.type === 'turn/start') inside = true; }, { prepend: true }));
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
  const channel = createWechatHome({ ctx, timeZone: 'America/New_York', home: async received => { assert.equal(received.conversationId, identity.conversationId); return agent; } }); cleanup.push(channel.stop);
  await channel.ask('@她', identity, [previous]);
  const context = requests[0].messages.find(message => message.source?.kind === 'dsh-world-channel-context');
  assert.ok(context);
  assert.match(JSON.stringify(context), /wechat:dad/);
  assert.match(JSON.stringify(context), /前一句/);
  assert.match(JSON.stringify(context), /2026-10-24T20:00:00-04:00/);
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

test('WeChat requests use the existing home and keep user-role sender identity', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, cleanup } = await hostFixture(t, request => { requests.push(request); return textResponse('最终答复'); });
  const home = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const channel = createWechatHome({ ctx, home: async () => home }); cleanup.push(channel.stop);
  const reply = await channel.ask('今晚吃什么', identity);
  assert.equal(reply.text, '', 'her answer leaves through wechat_send; the request only hands the words over');
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

test('WeChat conversations wait their turn: the second reaches her once the turn the first started has ended', async t => {
  const { ctx, cleanup } = await hostFixture(t, request => {
    const last = request.messages.filter(message => message.role === 'user').at(-1)!;
    return textResponse(last.content.filter(block => block.type === 'text').map(block => block.text).join('').split('\n').at(-1)!);
  });
  const home = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const channel = createWechatHome({ ctx, home: async () => home }); cleanup.push(channel.stop);
  const [a, b] = await Promise.all([channel.ask('第一人', identity), channel.ask('第二人', { ...identity, conversationId: 'private', speakerId: 'wechat:wxid_dad' })]);
  assert.notEqual(a.id, b.id);
  await home.whenIdle();
  const events = home.session.snapshotEvents();
  assert.ok(events.findIndex(event => event.type === 'user/message' && event.data.id === b.id) > events.findIndex(event => event.type === 'turn/end'));
  channel.stop(); await assert.rejects(channel.ask('停止后', identity), /stopped/);
});

test('running out of time while she is still busy is a busy refusal and hands nothing over (#busy)', async t => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const running = new Promise<void>(resolve => { entered = resolve; });
  const { ctx, cleanup } = await hostFixture(t, () => (async function* () { entered(); await gate; yield* textResponse('桌面那边的事'); })());
  const home = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  let expire = () => {};
  const timers = { set: (fn: () => void) => { expire = fn; return 1; }, clear: () => {} };
  const channel = createWechatHome({ ctx, home: async () => home, timers }); cleanup.push(channel.stop);
  home.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '桌面问题' }] }));
  await running;
  const reply = channel.ask('她在忙时来的微信', identity);
  const refused = assert.rejects(reply, WechatHomeBusy);
  await new Promise(resolve => setImmediate(resolve));
  expire();
  await refused;
  release(); await home.whenIdle();
  const texts = home.session.snapshotEvents().flatMap(event => event.type === 'user/message' ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []) : []);
  assert.equal(texts.some(text => text.includes('她在忙时来的微信')), false, 'the refused words never reached her');
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
  assert.equal(path, '/dsh-world/worlds/default/wechat/ask');
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
  assert.equal((await response.json()).text, '');
  assert.ok(agent.ctx.tools.get('wechat_send', agent));
  assert.ok(agent.ctx.tools.get('wechat_history', agent));
  assert.equal(other.ctx.tools.get('wechat_send', other), undefined);
  channel.stop(); assert.equal(existsSync(file), false);
  assert.equal((await request({ text: 'hello', identity })).status, 503);
  await writeFile(file, JSON.stringify({ token: 'newer-module' }));
  channel.stop(); assert.equal(existsSync(file), true);
});

test('in her home WeChat words reach her at the next step of what she is doing; elsewhere they wait for it to end', async t => {
  for (const midTurn of [true, false]) {
    let release!: () => void, entered!: () => void, step = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const busy = new Promise<void>(resolve => { entered = resolve; });
    const requests: GenerateOptions[] = [];
    const { ctx, cleanup } = await hostFixture(t, request => (async function* (): AsyncIterable<StreamChunk> {
      requests.push(request);
      if (step++) { yield* textResponse('我在'); return; }
      const call = { type: 'tool-call' as const, id: ToolCallId('work'), name: 'long_work', arguments: '{}' };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments };
      yield { type: 'block-end', index: 0, block: call };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    })());
    cleanup.push(ctx.tools.register(defineTool({ name: 'long_work', description: 'test', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => { entered(); await gate; return 'done'; } })));
    const home = (await ctx.agents.create({ sessionId: SessionId(`home-${midTurn}`), agentOptions: { provider: 'test', model: 'test' } })).agent;
    const channel = createWechatHome({ ctx, home: async () => home, midTurn: () => midTurn }); cleanup.push(channel.stop);
    home.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '去忙一件长的事' }] }));
    await busy;
    const reply = channel.ask('在吗', { ...identity, conversationType: 'private', conversationId: 'wxid_partner' });
    await new Promise(resolve => setTimeout(resolve, 20));
    release();
    // Either way the request ends once she has the words; elsewhere they only go in after the turn under way.
    assert.equal((await reply).text, '');
    await home.whenIdle();
    const turns = home.session.snapshotEvents().filter(event => event.type === 'turn/end').length;
    assert.equal(turns, midTurn ? 1 : 2, midTurn ? 'taken into the turn under way' : 'a turn of its own after the first ended');
    if (midTurn) assert.match(JSON.stringify(requests[1]!.messages), /在吗/, 'the step after the busy one already has it');
    else { assert.doesNotMatch(JSON.stringify(requests[1]!.messages), /在吗/); assert.match(JSON.stringify(requests[2]!.messages), /在吗/); }
  }
});

test('in her home a request ends once she has the words, so a second message is not held behind her answer to the first', async t => {
  const gates: (() => void)[] = [], entered: (() => void)[] = [];
  const busy = [0, 1, 2].map(n => new Promise<void>(resolve => { entered[n] = resolve; }));
  const requests: GenerateOptions[] = [];
  let step = 0;
  const { ctx, cleanup } = await hostFixture(t, request => (async function* (): AsyncIterable<StreamChunk> {
    requests.push(request);
    if (step++ >= 3) { yield* textResponse('玩完了'); return; }
    const call = { type: 'tool-call' as const, id: ToolCallId(`play-${step}`), name: 'play', arguments: '{}' };
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments };
    yield { type: 'block-end', index: 0, block: call };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  })());
  let played = 0;
  cleanup.push(ctx.tools.register(defineTool({ name: 'play', description: 'test', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => { const n = played++; entered[n]!(); await new Promise<void>(resolve => { gates[n] = resolve; }); return 'ok'; } })));
  const home = (await ctx.agents.create({ sessionId: SessionId('home-play'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const channel = createWechatHome({ ctx, home: async () => home, midTurn: () => true }); cleanup.push(channel.stop);
  const partner = { ...identity, conversationType: 'private' as const, conversationId: 'wxid_partner' };
  home.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '打一会儿游戏' }] }));
  await busy[0];
  const first = channel.ask('在吗', partner);
  await new Promise(resolve => setTimeout(resolve, 20));
  gates[0]!();
  assert.equal((await first).text, '', 'done once she has it, with no answer from her');
  assert.equal(home.status, 'running', 'while she is still playing');
  await busy[1];
  const second = channel.ask('还在玩吗', partner);
  await new Promise(resolve => setTimeout(resolve, 20));
  gates[1]!();
  assert.equal((await second).text, '');
  await busy[2]; gates[2]!();
  await home.whenIdle();
  assert.equal(home.session.snapshotEvents().filter(event => event.type === 'turn/end').length, 1, 'both went into the one turn');
  assert.match(JSON.stringify(requests[1]!.messages), /在吗/);
  assert.match(JSON.stringify(requests[2]!.messages), /还在玩吗/);
});

test('a request ends once she has the words: her turn being cut in on, or cancelled, afterwards does not fail it (a sticker held the chat)', async t => {
  const partner = { channel: 'wechat', accountId: 'wxid_bot', conversationType: 'private' as const, conversationId: 'wxid_partner', speakerId: 'wechat:wxid_partner', speakerName: '伙伴' };
  for (const after of ['cut in', 'cancelled'] as const) {
    await t.test(after, async t => {
      let release!: () => void, entered!: () => void, step = 0;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const busy = new Promise<void>(resolve => { entered = resolve; });
      const { ctx, cleanup } = await hostFixture(t, () => (async function* (): AsyncIterable<StreamChunk> {
        if (step++) { yield* textResponse('后来的事'); return; }
        const call = { type: 'tool-call' as const, id: ToolCallId('look'), name: 'look_up', arguments: '{}' };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments };
        yield { type: 'block-end', index: 0, block: call };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      })());
      cleanup.push(ctx.tools.register(defineTool({ name: 'look_up', description: 'test', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => { entered(); await gate; return 'ok'; } })));
      const home = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
      const channel = createWechatHome({ ctx, home: async () => home }); cleanup.push(channel.stop);
      // A sticker alone: no words, so it starts a turn of its own.
      const reply = channel.ask('', partner);
      await busy;
      if (after === 'cut in') home.steer(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '你又发了一句' }] }));
      else home.cancel({ kind: 'user' });
      release();
      assert.equal((await reply).text, '', 'handed over, so nothing for the adapter to hold the chat for');
      await home.whenIdle();
      assert.ok(home.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.content.some(block => block.type === 'text' && block.text.includes('【收到微信图片】'))));
    });
  }
});

test('a picture that cannot be read still hands the words over, with a note that it was not seen', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, cleanup } = await hostFixture(t, request => { requests.push(request); return textResponse('嗯'); });
  const home = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const channel = createWechatHome({ ctx, home: async () => home, images: async () => { throw new Error('图片下载超时'); } }); cleanup.push(channel.stop);
  const partner = { channel: 'wechat', accountId: 'wxid_bot', conversationType: 'private' as const, conversationId: 'wxid_partner', speakerId: 'wechat:wxid_partner', speakerName: '伙伴' };
  const media = [{ id: 'm.db:9', occurredAt: '2026-11-26T04:21:06.000Z', text: '【微信表情包】', identity: partner, image: { file: `${'a'.repeat(64)}.png`, quality: 'original' } }];
  const reply = await channel.ask('看这个', partner, [], media as never);
  assert.equal(reply.text, '');
  const seen = JSON.stringify(requests[0]!.messages);
  assert.match(seen, /看这个/);
  assert.match(seen, /这次的图片没能读进来（图片下载超时），只知道收到了图片，没看到内容。/);
});

test('a message that reached her late says how long ago it was sent; one that came as it was sent says nothing (#72)', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, cleanup } = await hostFixture(t, request => { requests.push(request); return textResponse('嗯'); });
  const home = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const channel = createWechatHome({ ctx, home: async () => home }); cleanup.push(channel.stop);
  const partner = { channel: 'wechat', accountId: 'wxid_bot', conversationType: 'private' as const, conversationId: 'wxid_partner', speakerId: 'wechat:wxid_partner', speakerName: '伙伴' };
  await channel.ask('在吗', partner, [], [], undefined, new Date(Date.now() - 20 * 60_000).toISOString()); await home.whenIdle();
  assert.match(JSON.stringify(requests.at(-1)!.messages), /这条是 20 分钟前发的，不是刚刚说的。/);
  await channel.ask('现在呢', partner, [], [], undefined, new Date().toISOString()); await home.whenIdle();
  assert.doesNotMatch(JSON.stringify(requests.at(-1)!.messages.slice(-3)), /前发的/);
});
