import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createUserMessage, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createWechatModule } from '../src/ecosystem/wechat/index.ts';
import { createWechatRecorder } from '../src/ecosystem/wechat/archive.ts';
import { createArchiveStore } from '../src/store.ts';
import { createWorldRuntime } from '../src/runtime.ts';
import { createWechatSending } from '../src/ecosystem/wechat/sending.ts';
import { createStickerLibrary } from '../src/ecosystem/wechat/stickerLibrary.ts';
import { hostFixture, textResponse } from './hostFixture.ts';

const chats = [{ id: 'owner', name: '伙伴' }, { id: 'family@chatroom', name: '家庭群' }];
const registration = { accountId: 'wxid_bot', chats };
const words = [{ type: 'text', text: '想跟你说句话' }, { type: 'sticker', stickerId: 'st_hello' }, { type: 'text', text: '晚安' }];
async function* call(name: string, args: object): AsyncIterable<StreamChunk> {
  const block = { type: 'tool-call' as const, id: ToolCallId(name), name, arguments: JSON.stringify(args) };
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id: block.id, name, argumentsDelta: block.arguments };
  yield { type: 'block-end', index: 0, block };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}

test('a tool continuation removes WeChat schemas and execution after leaving the workspace without new inbox input', async t => {
  let inside = true;
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, request => {
    requests.push(request);
    return requests.length === 1 ? call('leave_workspace', {}) : requests.length === 2 ? call('wechat_chats', {}) : textResponse('已经移出');
  });
  cleanup.push(ctx.tools.register(defineTool({ name: 'leave_workspace', description: '切换工作区', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => { inside = false; return '已移出'; } })));
  const agent = (await ctx.agents.create({ sessionId: SessionId('moving'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const module = createWechatModule({ ctx, file: join(root, 'wechat.json'), inWorld: candidate => inside && candidate === agent.session, home: async () => agent, origin: () => 'http://127.0.0.1:1', allowedHosts: [] });
  module.start(); cleanup.push(() => module.stop());
  let inboxInsertions = 0;
  cleanup.push(ctx.on('agent/inbox/inserted', ({ agent: candidate }) => { if (candidate === agent) inboxInsertions++; }));
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '切换后继续工具回合' }] }));
  await agent.whenIdle();
  assert.equal(requests.length, 3);
  assert.equal(inboxInsertions, 1, 'no new inbox event can trigger the scope synchronization');
  assert.ok(requests[0].tools?.some(tool => tool.name === 'wechat_send'));
  assert.deepEqual(requests[1].tools?.filter(tool => tool.name.startsWith('wechat_')), []);
  assert.ok(requests[1].tools?.some(tool => tool.name === 'leave_workspace'), 'the native host tool stays available');
  const result = agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.step === 2);
  assert.equal(result?.type === 'tool/result' && result.data.message.isError, true);
  assert.equal(result?.type === 'tool/result' && result.data.error?.code, 'UNKNOWN_TOOL');
  assert.equal(agent.ctx.tools.get('wechat_send', agent), undefined);
});

test('a model request already in flight cannot send WeChat messages after its agent leaves the workspace', async t => {
  let inside = true;
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, request => {
    requests.push(request);
    if (requests.length === 1) { inside = false; return call('wechat_send', { chatId: 'owner', messages: words }); }
    return textResponse('这条没有发出');
  });
  const agent = (await ctx.agents.create({ sessionId: SessionId('inflight'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const file = join(root, 'wechat.json');
  const module = createWechatModule({ ctx, file, inWorld: candidate => inside && candidate === agent.session, home: async () => agent, origin: () => 'http://127.0.0.1:1', allowedHosts: [] });
  module.start(); cleanup.push(() => module.stop());
  const server = createServer((req, res) => { void module.route.handler(req, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const { token, path } = JSON.parse(await readFile(file, 'utf8'));
  const poll = () => fetch(`http://127.0.0.1:${address.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-world-token': token }, body: JSON.stringify({ outbox: registration }) });
  assert.equal((await poll()).status, 200);
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '在途期间移出工作区' }] }));
  await agent.whenIdle();
  assert.ok(requests[0].tools?.some(tool => tool.name === 'wechat_send'), 'the request captured the tool before membership changed');
  const result = agent.session.snapshotEvents().find(event => event.type === 'tool/result');
  assert.equal(result?.type === 'tool/result' && result.data.message.isError, true);
  assert.equal(module.status().pending, 0);
  assert.equal((await (await poll()).json()).job, undefined);
  assert.equal(agent.session.deriveMessages().some(message => message.source.kind === 'dsh-world-wechat-outgoing'), false);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].tools ?? [], []);
});

test('a desktop turn can send to either bound chat through persistent tools and one durable queue', async t => {
  let calls = 0;
  const { ctx, root, cleanup } = await hostFixture(t, () => calls++ === 0 ? call('wechat_send', { chatId: 'family@chatroom', messages: words }) : textResponse('这段留在家里'));
  const store = createArchiveStore({ root, worldId: 'test', agentPreset: 'test', timeZone: 'UTC' }); cleanup.push(() => store.close());
  const world = createWorldRuntime(ctx, { worldId: 'test', agentPreset: 'test', timeZone: 'UTC' }, store);
  await world.start(); cleanup.push(() => world.stop());
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), meta: { agentPreset: 'test' }, agentOptions: { provider: 'test', model: 'test' } })).agent;
  const file = join(root, 'wechat.json');
  await createStickerLibrary(join(root, 'stickers')).add(Buffer.concat([Buffer.from('GIF89a'), Buffer.from('hello sticker....')]), { id: 'st_hello', tags: ['你好'] });
  const module = createWechatModule({ ctx, file, worldId: 'test', inWorld: candidate => candidate.id === agent.id, home: async () => agent, origin: () => 'http://127.0.0.1:1', allowedHosts: [], ...createWechatRecorder(store, 'test') });
  module.start(); cleanup.push(() => module.stop());
  assert.ok(agent.ctx.tools.get('wechat_send', agent), 'sending is available before any WeChat inbound message');
  assert.ok(agent.ctx.tools.get('wechat_chats', agent));
  assert.ok(agent.ctx.tools.get('wechat_delivery', agent));
  assert.ok(agent.ctx.tools.get('wechat_history', agent));
  const server = createServer((req, res) => { void module.route.handler(req, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const { token, path } = JSON.parse(await readFile(file, 'utf8'));
  const post = (body: unknown) => fetch(`http://127.0.0.1:${address.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-world-token': token }, body: JSON.stringify(body) });
  assert.equal(module.status().lastContactAt, null);
  const first = await (await post({ outbox: registration })).json();
  assert.deepEqual(first.settings, { contextMessages: 5, bufferSeconds: 3 }, 'the adapter learns the defaults on its first poll');
  assert.equal(module.status().accountId, 'wxid_bot');
  assert.equal(module.status().account, 'online', 'a successful poll means the account is logged in');
  assert.equal((await post({ status: { wechat: 'offline' } })).status, 200);
  assert.equal(module.status().account, 'offline');
  assert.equal((await post({ status: { wechat: 'maybe' } })).status, 400);
  await post({ outbox: registration });
  assert.equal(module.status().account, 'online');
  assert.equal(module.status().pending, 0);
  assert.ok(module.status().lastContactAt);
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '去跟家人打招呼' }] }));
  await agent.whenIdle(); await ctx.sessions.flush(agent.session); await world.flush();
  const result = await (await post({ outbox: registration })).json();
  assert.equal(module.status().pending, 1, 'a claimed job still counts as waiting');
  assert.equal(result.job.chatId, 'family@chatroom');
  assert.equal(result.job.accountId, 'wxid_bot');
  assert.deepEqual(result.job.messages, words);
  assert.deepEqual((await (await post({ outbox: registration })).json()).job, result.job, 'an unacknowledged claim is returned with the same ID');
  assert.ok(agent.ctx.tools.get('wechat_send', agent), 'the tool survives the end of the turn');
  const record = (await store.readPage({ limit: 10 })).records.find(item => item.recordId === result.job.id);
  assert.ok(record);
  assert.match(record.content, /想跟你说句话[\s\S]*st_hello[\s\S]*晚安/);
  assert.doesNotMatch(record.content, /arguments|tool-call/);
  assert.equal(record.speakerId, 'wechat:wxid_bot');
  assert.equal((await post({ receipt: { id: result.job.id, confirmed: 3, status: 'sent' } })).status, 200);
  assert.equal((await (await post({ outbox: registration })).json()).job, undefined);
  const confirmed = (await store.readPage({ limit: 10 })).records.find(item => item.recordId === result.job.id)!;
  assert.equal(confirmed.wechatDelivery?.status, 'sent');
  assert.equal((await post({ outbox: { ...registration, accountId: 'other_bot' } })).status, 400);
});

test('a desktop turn reads an unmentioned group, sends to that chatId and checks the existing receipt tool', async t => {
  let step = 0;
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, request => {
    requests.push(request);
    const result = () => JSON.parse(request.messages.filter(message => message.role === 'tool').at(-1)!.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''));
    if (step++ === 0) return call('wechat_history', { chatId: 'family@chatroom', limit: 3 });
    if (step === 2) {
      assert.equal(result().messages[0].text, '今晚吃面');
      return call('wechat_send', { chatId: result().chatId, messages: [{ type: 'text', text: '我也想吃面' }] });
    }
    if (step === 3) return call('wechat_delivery', { id: result().id });
    assert.ok(['staged', 'queued', 'claimed', 'sent'].includes(result().status), JSON.stringify(result()));
    return textResponse('看过群聊，也安排好发言了');
  });
  const agent = (await ctx.agents.create({ sessionId: SessionId('reader'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const file = join(root, 'wechat.json');
  await createStickerLibrary(join(root, 'stickers')).add(Buffer.concat([Buffer.from('GIF89a'), Buffer.from('hello sticker....')]), { id: 'st_hello', tags: ['你好'] });
  const module = createWechatModule({ ctx, file, worldId: 'test', inWorld: candidate => candidate.id === agent.id, home: async () => { assert.fail('history must not start an inbound home request'); }, origin: () => 'http://127.0.0.1:1', allowedHosts: [] });
  module.start(); cleanup.push(() => module.stop());
  const server = createServer((req, res) => { void module.route.handler(req, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const { token, path } = JSON.parse(await readFile(file, 'utf8'));
  const post = async (body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-world-token': token }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); return response.json();
  };
  await post({ outbox: registration });
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '看看群里聊什么，想说就说' }] }));
  let finished = false, read = false, sent = false;
  const idle = agent.whenIdle().then(() => { finished = true; });
  for (let i = 0; i < 400 && (!finished || !sent); i++) {
    const work = await post({ outbox: registration });
    if (work.read) {
      read = true;
      assert.equal(work.read.chatId, 'family@chatroom');
      await post({ readResult: { id: work.read.id, accountId: registration.accountId, chatId: work.read.chatId,
        messages: [{ id: 'm.db:12', occurredAt: '2026-10-27T10:00:00Z', text: '今晚吃面', identity: { channel: 'wechat', accountId: registration.accountId, speakerId: 'wechat:dad', conversationType: 'group', conversationId: work.read.chatId } }] } });
    }
    if (work.job) {
      assert.equal(work.job.chatId, 'family@chatroom'); assert.equal(work.job.messages[0].text, '我也想吃面'); sent = true;
      await post({ receipt: { id: work.job.id, confirmed: 1, status: 'sent' } });
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(finished && read && sent); await idle;
  assert.equal(requests.length, 4); assert.equal(errors.length, 0, errors.map(value => String((value as { error?: unknown }).error)).join('\n'));
  assert.equal(module.status().pending, 0);
});

test('restarting memory keeps retained WeChat words once and recalls the full words in another session', async t => {
  const marker = '这句微信正文只出现一次';
  const requests: GenerateOptions[] = [];
  let calls = 0;
  const { ctx, root, cleanup, errors } = await hostFixture(t, request => {
    requests.push(request);
    return calls++ === 0 ? call('wechat_send', { chatId: 'owner', messages: [{ type: 'text', text: marker }] }) : textResponse('留在家里的话');
  });
  const config = { worldId: 'test', agentPreset: 'test', timeZone: 'UTC' };
  const store = createArchiveStore({ ...config, root }); cleanup.push(() => store.close());
  let world = createWorldRuntime(ctx, config, store);
  await world.start(); cleanup.push(() => world.stop());
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), meta: { agentPreset: 'test' }, agentOptions: { provider: 'test', model: 'test' } })).agent;
  const sending = createWechatSending({ ctx, file: join(root, 'outbox.sqlite'), worldId: 'test', ...createWechatRecorder(store, 'test') });
  cleanup.push(() => sending.stop());
  for (const tool of sending.tools) cleanup.push(agent.ctx.tools.register(tool));
  await sending.poll(registration);
  const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
  agent.followup(user('安排一条微信消息')); await agent.whenIdle(); await world.flush();
  const job = await sending.poll(registration); assert.ok(job);
  await world.stop();
  await sending.receipt({ id: job.id, confirmed: 1, status: 'sent' });
  world = createWorldRuntime(ctx, config, store); await world.start();
  agent.followup(user('重载后的下一轮')); await agent.whenIdle(); await world.flush();
  const messages = requests.at(-1)!.messages;
  // The words she sent stay once in the request: in her wechat_send call, not again in its queue note or the recalled memory.
  const content = messages.map(message => JSON.stringify(message.content)).join('\n');
  const recalled = messages.filter(message => message.source?.kind === 'dsh-world-history').flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n');
  assert.equal(content.split(marker).length - 1, 1, 'retained outgoing content must not be repeated in recalled memory');
  assert.doesNotMatch(recalled, new RegExp(marker));
  assert.match(recalled, /"sent":"已发"/);
  const other = (await ctx.agents.create({ sessionId: SessionId('other'), meta: { agentPreset: 'test' }, agentOptions: { provider: 'test', model: 'test' } })).agent;
  other.followup(user('在另一个会话继续')); await other.whenIdle();
  const otherMemory = requests.at(-1)!.messages.filter(message => message.source?.kind === 'dsh-world-history').flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n');
  assert.match(otherMemory, new RegExp(marker));
  assert.match(otherMemory, /"sent":"已发"/);
  assert.deepEqual(errors, []);
});

test('a batch whose result is unknown is told once to the session that sent it, and a sent one says nothing', async t => {
  const requests: GenerateOptions[] = [];
  let calls = 0;
  const { ctx, root, cleanup } = await hostFixture(t, request => {
    requests.push(request);
    const step = calls++;
    return step === 0 ? call('wechat_send', { chatId: 'owner', messages: [{ type: 'text', text: '第一批' }] }) : step === 2 ? call('wechat_send', { chatId: 'owner', messages: [{ type: 'text', text: '第二批' }, { type: 'text', text: '第二批续' }] }) : textResponse('好');
  });
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const sending = createWechatSending({ ctx, file: join(root, 'outbox.sqlite'), worldId: 'test' });
  cleanup.push(() => sending.stop());
  for (const tool of sending.tools) cleanup.push(agent.ctx.tools.register(tool));
  await sending.poll(registration);
  const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
  const notices = () => requests.at(-1)!.messages.filter(message => message.source?.kind === 'dsh-world-wechat-delivery').map(message => message.content.map(block => block.type === 'text' ? block.text : '').join(''));
  agent.followup(user('发第一批')); await agent.whenIdle();
  const first = await sending.poll(registration); assert.ok(first);
  await sending.receipt({ id: first.id, confirmed: 1, status: 'sent' });
  agent.followup(user('发第二批')); await agent.whenIdle();
  assert.deepEqual(notices(), [], 'a batch that went out is not reported');
  const second = await sending.poll(registration); assert.ok(second);
  await sending.receipt({ id: second.id, confirmed: 1, status: 'uncertain' });
  await sending.receipt({ id: second.id, confirmed: 1, status: 'uncertain' });
  agent.followup(user('下一轮')); await agent.whenIdle();
  assert.deepEqual(notices(), ['【微信结果不明】发往微信「伙伴」的 2 条（开头是「第二批」）：前 1 条已发，第 2 条不知道发没发出，后面的没发。不要自动重发，先弄清对方收到了什么。']);
});

test('an unconfigured target is rejected without queuing or archiving words as sent', async t => {
  let calls = 0;
  const { ctx, root, cleanup } = await hostFixture(t, () => calls++ === 0 ? call('wechat_send', { chatId: 'stranger', messages: words }) : textResponse('没有发出'));
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const sending = createWechatSending({ ctx, file: join(root, 'outbox.sqlite'), worldId: 'test' }); cleanup.push(() => sending.stop());
  for (const tool of sending.tools) cleanup.push(agent.ctx.tools.register(tool));
  await sending.poll(registration);
  assert.ok(agent.ctx.tools.get('wechat_send', agent));
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '主动说话' }] })); await agent.whenIdle();
  const failed = agent.session.snapshotEvents().find(event => event.type === 'tool/result');
  assert.equal(failed?.type === 'tool/result' && failed.data.message.isError, true);
  assert.ok(!agent.session.deriveMessages().some(message => message.source.kind === 'dsh-world-wechat-outgoing'));
  assert.equal(await sending.poll(registration), undefined);
});

test('a sticker the library does not have is refused when queued, not discovered later as a failed send', async t => {
  let calls = 0;
  const { ctx, root, cleanup } = await hostFixture(t, () => calls++ === 0 ? call('wechat_send', { chatId: 'family@chatroom', messages: words }) : textResponse('没有排队'));
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const sending = createWechatSending({ ctx, file: join(root, 'outbox.sqlite'), worldId: 'test', hasSticker: async id => id === 'st_known' }); cleanup.push(() => sending.stop());
  for (const tool of sending.tools) cleanup.push(agent.ctx.tools.register(tool));
  await sending.poll(registration);
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '发个表情' }] })); await agent.whenIdle();
  const failed = agent.session.snapshotEvents().find(event => event.type === 'tool/result');
  assert.equal(failed?.type === 'tool/result' && failed.data.message.isError, true);
  assert.match(JSON.stringify(failed), /表情库里没有 st_hello/);
  assert.equal(await sending.poll(registration), undefined, 'nothing was queued');
});

test('claimed sends survive a host restart and group-origin sends respect the home-only archive', async t => {
  let calls = 0;
  const { ctx, root, cleanup } = await hostFixture(t, () => calls++ === 0 ? call('wechat_send', { chatId: 'owner', messages: words }) : textResponse('已安排'));
  const config = { root, worldId: 'test', agentPreset: 'test', timeZone: 'UTC', archiveScope: 'home' as const };
  const store = createArchiveStore(config); cleanup.push(() => store.close());
  const isHome = (id: string) => id === 'home';
  const world = createWorldRuntime(ctx, config, store, { prompt: { names: { companion: '鲸鲸', partner: '伙伴' } }, isHome, archiveSession: isHome }); await world.start(); cleanup.push(() => world.stop());
  const agent = (await ctx.agents.create({ sessionId: SessionId('group'), meta: { agentPreset: 'test' }, agentOptions: { provider: 'test', model: 'test' } })).agent;
  const file = join(root, 'outbox.sqlite');
  let sending = createWechatSending({ ctx, file, worldId: 'test', ...createWechatRecorder(store, 'test', isHome) });
  cleanup.push(() => sending.stop());
  for (const tool of sending.tools) cleanup.push(agent.ctx.tools.register(tool));
  await sending.poll(registration);
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '从群会话主动联系伙伴' }] }));
  await agent.whenIdle(); await world.flush();
  const claimed = await sending.poll(registration); assert.ok(claimed);
  assert.equal((await store.readPage({ limit: 10 })).records.length, 0);
  assert.match(JSON.stringify(agent.session.snapshotEvents()), /dsh-world-wechat-outgoing/);
  await sending.stop();
  sending = createWechatSending({ ctx, file, worldId: 'test', ...createWechatRecorder(store, 'test', isHome) });
  assert.deepEqual(await sending.poll(registration), claimed);
  await sending.receipt({ id: claimed.id, confirmed: 3, status: 'sent' });
  assert.equal(await sending.poll(registration), undefined);
  assert.equal(store.delivery(claimed.id)?.status, 'sent');
  assert.equal((await store.readPage({ limit: 10 })).records.length, 0);
  await world.stop();
  const expanded = createWorldRuntime(ctx, { ...config, archiveScope: 'workspace' }, store, { prompt: { names: { companion: '鲸鲸', partner: '伙伴' } }, isHome, archiveSession: () => true });
  await expanded.start(); cleanup.push(() => expanded.stop()); await expanded.flush();
  let recovered = (await store.readPage({ limit: 10 })).records.find(record => record.recordId === claimed.id);
  assert.equal(recovered?.wechatDelivery?.status, 'sent', 'scope expansion preserves the receipt already confirmed outside shared memory');
  await sending.receipt({ id: claimed.id, confirmed: 3, status: 'sent' });
  recovered = (await store.readPage({ limit: 10 })).records.find(record => record.recordId === claimed.id);
  assert.equal(recovered?.wechatDelivery?.confirmed, 3);
});

test('a send never becomes deliverable when its originating session cannot be flushed', async t => {
  let calls = 0;
  const { ctx, root, cleanup } = await hostFixture(t, () => calls++ === 0 ? call('wechat_send', { chatId: 'owner', messages: words }) : textResponse('留在家里'));
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const sending = createWechatSending({ ctx, file: join(root, 'outbox.sqlite'), worldId: 'test' }); cleanup.push(() => sending.stop());
  for (const tool of sending.tools) cleanup.push(agent.ctx.tools.register(tool));
  await sending.poll(registration);
  const off = ctx.on('session/flush', async session => {
    if (session.id === agent.id && session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'dsh-world-wechat-outgoing')) throw new Error('source disk failure');
  });
  try {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '试着发送' }] })); await agent.whenIdle();
    assert.equal(await sending.poll(registration), undefined);
  } finally { off(); }
});
