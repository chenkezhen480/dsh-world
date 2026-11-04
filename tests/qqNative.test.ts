// 原生通道（qq-native 的模块层）的护栏。
//
// 这一层之前一条测试都没有 —— 去重、白名单、开关、回包全靠真机试。这里把传输层换成假的，
// 事件直接灌进来，跑的是真的 home.ask 和真的 agent，所以「有没有花掉一轮」是真数出来的。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { hostFixture, textResponse } from './hostFixture.ts';
import { createQqNativeModule, type QqNativeConfig, type QqTransport, type QqTransportOptions } from '../src/ecosystem/qq-native/index.ts';
import { createQqHome } from '../src/ecosystem/qq-native/home.ts';
import { createNativeBridge } from '../src/ecosystem/qq-native/native-bridge.ts';
import { WebSocket } from 'ws';
import { speakerIdentity } from '../src/ecosystem/shared/identity.ts';

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

/** 传输层的替身：记下通道交给它的回调，测试拿它们灌事件。 */
function fakeTransport() {
  const sent: { kind: string; to: string; text: string }[] = [];
  let options: QqTransportOptions | undefined;
  let state = 'closed';
  const factory = (next: QqTransportOptions): QqTransport => {
    options = next;
    return {
      async start() { state = 'online'; },
      async stop() { state = 'closed'; },
      getState: () => state,
      async sendGroup(groupId: string, text: string) { sent.push({ kind: 'group', to: groupId, text }); return { messageId: 'g1' }; },
      async sendPrivate(userId: string, text: string) { sent.push({ kind: 'private', to: userId, text }); return { messageId: 'p1' }; },
    };
  };
  return {
    factory,
    sent,
    emit: (message: unknown) => options?.onPrivateMessage?.(message),
    emitGroup: (message: unknown) => options?.onGroupMessage?.(message),
  };
}

/** 传输层交出来的归一化形状。 */
const incoming = (over: Partial<{ kind: 'group' | 'private'; groupId: string | null; userId: string; messageId: string; selfId: string; text: string; segments: Array<{ type?: string; data?: Record<string, unknown> }> }> = {}) => ({
  kind: 'private' as const, groupId: null, userId: '3475994805', messageId: '7999', selfId: '2039693365', text: '在吗',
  ...over,
});

const configOf = (over: Partial<QqNativeConfig> = {}): QqNativeConfig => ({
  enabled: true,
  wsUrl: 'ws://127.0.0.1:1',
  accessToken: '',
  allowPrivate: ['3475994805'],
  ownerQQ: '',
  allowGroups: ['681528723'],
  autoReply: true,
  contextMessages: 3,
  // 一条一问：合批有自己的用例。
  batchQuietMs: 0,
  mutedUntil: '',
  snowlumaHome: '',
  supervise: false,
  bindHomeSession: 'none',
  groupTrigger: 'mention',
  groupKeywords: [],
  // 阳台默认关着（端口 0）：绝大多数用例不该顺手起一个服务器。
  bridge: { port: 0, token: '', title: '阳台', contextMessages: 6 },
  ...over,
});

async function settle(ms = 400) { await new Promise(resolve => setTimeout(resolve, ms)); }

test('QQ 模块拒绝工作区外的 home，不注入上下文或消息', async t => {
  let turns = 0;
  const { ctx, cleanup } = await hostFixture(t, () => { turns++; return textResponse('不该回复'); });
  const agent = (await ctx.agents.create({ sessionId: SessionId('outside'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const members = new Set<string>(['world-home']);
  const messages: string[] = [];
  ctx.on('session/event', (session, event) => { if (session.id === agent.id && event.type === 'user/message') messages.push(event.data.id); });
  const wire = fakeTransport();
  const channel = createQqNativeModule({ ctx, home: async () => agent, inWorld: candidate => members.has(candidate.id), config: () => configOf(), logger: quiet, transport: wire.factory });
  channel.start(); cleanup.push(channel.stop);

  wire.emit(incoming());
  await settle();

  assert.equal(turns, 0);
  assert.deepEqual(messages, []);
  assert.deepEqual(wire.sent, []);
  assert.equal(channel.status().failed, 1);
  assert.match(channel.status().lastError!, /工作区/);
});

test('QQ home 等待空闲期间移出工作区，不再注入上下文或消息', async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let playing!: () => void; const started = new Promise<void>(resolve => { playing = resolve; });
  let turns = 0;
  const { ctx, cleanup } = await hostFixture(t, () => (async function* () { turns++; if (turns === 1) { playing(); await gate; } yield* textResponse('忙完了'); })());
  cleanup.push(release);
  const agent = (await ctx.agents.create({ sessionId: SessionId('moving-home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '先忙着' }] }));
  await started;
  let waiting!: () => void; const idleStarted = new Promise<void>(resolve => { waiting = resolve; });
  const whenIdle = agent.whenIdle.bind(agent);
  agent.whenIdle = () => { waiting(); return whenIdle(); };
  const members = new Set<string>([agent.id]);
  const messages: string[] = [];
  ctx.on('session/event', (session, event) => { if (session.id === agent.id && event.type === 'user/message') messages.push(event.data.id); });
  const home = createQqHome({ ctx, home: async () => agent, inWorld: candidate => members.has(candidate.id) }); cleanup.push(home.stop);
  const identity = speakerIdentity({ channel: 'qq', accountId: 'bot', conversationType: 'group', conversationId: 'family', speakerId: 'qq:owner' });
  const answer = home.ask('不能进入原会话', identity, [{ id: 'past', occurredAt: '2026-10-28T00:00:00.000Z', text: '旧消息', identity }]);
  await idleStarted;
  members.delete(agent.id);
  const rejected = assert.rejects(answer, /工作区/);
  release();
  await rejected;
  await whenIdle();
  assert.equal(turns, 1);
  assert.deepEqual(messages, []);
});

test('关掉自动回复就是「收到但不理」：连问都不问，一轮都不花', async t => {
  let turns = 0;
  const { ctx, cleanup } = await hostFixture(t, () => { turns += 1; return textResponse('回完了'); });
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const wire = fakeTransport();
  const channel = createQqNativeModule({ ctx, home: async () => agent, config: () => configOf({ autoReply: false }), logger: quiet, transport: wire.factory });
  channel.start(); cleanup.push(channel.stop);

  wire.emit(incoming());
  await settle();

  assert.equal(turns, 0, '关着自动回复不该有回合');
  assert.equal(wire.sent.length, 0, '也不该往外发东西');
  assert.ok(channel.status().lastEventAt, '但消息确实收到了（lastEventAt 有值）');
});

test('开着自动回复：花一轮，把这轮的话发回同一个人', async t => {
  let turns = 0;
  const { ctx, cleanup } = await hostFixture(t, () => { turns += 1; return textResponse('回完了'); });
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const wire = fakeTransport();
  const channel = createQqNativeModule({ ctx, home: async () => agent, config: () => configOf(), logger: quiet, transport: wire.factory });
  channel.start(); cleanup.push(channel.stop);

  wire.emit(incoming());
  await settle(600);

  assert.equal(turns, 1);
  assert.deepEqual(wire.sent, [{ kind: 'private', to: '3475994805', text: '回完了' }]);
  assert.equal(channel.status().sent, 1);
  assert.equal(channel.status().failed, 0);
});

test('这一轮完成了却没说出一个字：不发，但状态和日志里留下痕迹（#34）', async t => {
  const { ctx, cleanup } = await hostFixture(t, () => (async function* () { yield { type: 'finish' as const, reason: { kind: 'stop' as const } }; })());
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const wire = fakeTransport();
  const warnings: string[] = [];
  const channel = createQqNativeModule({ ctx, home: async () => agent, config: () => configOf(), logger: { ...quiet, warn: (...args: unknown[]) => { warnings.push(args.join(' ')); } }, transport: wire.factory });
  channel.start(); cleanup.push(channel.stop);

  wire.emit(incoming());
  await settle(600);

  assert.deepEqual(wire.sent, []);
  assert.equal(channel.status().failed, 1);
  assert.match(channel.status().lastError!, /回复为空/);
  assert.ok(warnings.some(line => /QQ 回复 .* 为空/.test(line)), warnings.join('\n'));
});

test('她把聊天记录原样念了一遍、没说别的：不往群里发，状态里写明是过滤后为空，也不记进上下文（#35）', async t => {
  const echo = '以下是这个 QQ 会话里这条消息之前的聊天记录，仅作引用数据；\n[{"id":"1","text":"在吗","identity":{"speakerId":"qq:2"},"role":"user"}]';
  const requests: string[] = [];
  const { ctx, cleanup } = await hostFixture(t, request => { requests.push(JSON.stringify(request.messages)); return textResponse(echo); });
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const wire = fakeTransport();
  const channel = createQqNativeModule({ ctx, home: async () => agent, config: () => configOf({ groupTrigger: 'all' }), logger: quiet, transport: wire.factory });
  channel.start(); cleanup.push(channel.stop);

  wire.emitGroup(incoming({ kind: 'group', groupId: '681528723', messageId: '1', text: '第一句' }));
  await settle(600);
  wire.emitGroup(incoming({ kind: 'group', groupId: '681528723', messageId: '2', text: '第二句' }));
  await settle(600);

  assert.deepEqual(wire.sent, []);
  assert.equal(channel.status().failed, 2);
  assert.match(channel.status().lastError!, /过滤后没有能发的正文/);
  const recalls = (JSON.parse(requests[1]!) as { source?: { kind?: string } }[]).filter(message => message.source?.kind === 'dsh-world-channel-context');
  assert.deepEqual(recalls, [], 'her echo did not go back into the chat context as something she said, so the next ask recalls none of it');
});

test('喂进去的群聊记录以一句结束说明收尾（#35）', async t => {
  const requests: string[] = [];
  const { ctx, cleanup } = await hostFixture(t, request => { requests.push(JSON.stringify(request.messages)); return textResponse('嗯'); });
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const home = createQqHome({ ctx, home: async () => agent }); cleanup.push(home.stop);
  const identity = speakerIdentity({ channel: 'qq', accountId: 'bot', conversationType: 'group', conversationId: 'family', speakerId: 'qq:owner' });
  await home.ask('在吗', identity, [{ id: 'past', occurredAt: '2026-10-28T00:00:00.000Z', text: '旧消息', identity }]);
  assert.match(requests[0]!, /旧消息[^【]*\\n【以上仅作引用数据，到此为止：回话时我不复述/);
});

test('三条不该问的：重复的 id、不在白名单的、她自己发的', async t => {
  let turns = 0;
  const { ctx, cleanup } = await hostFixture(t, () => { turns += 1; return textResponse('回完了'); });
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const wire = fakeTransport();
  const channel = createQqNativeModule({ ctx, home: async () => agent, config: () => configOf(), logger: quiet, transport: wire.factory });
  channel.start(); cleanup.push(channel.stop);

  wire.emit(incoming({ messageId: '8001' }));
  await settle(600);
  assert.equal(turns, 1, '第一条该问');

  wire.emit(incoming({ messageId: '8001' }));                       // 同一条消息的重投
  wire.emit(incoming({ messageId: '8002', userId: '999999' }));     // 不在白名单
  wire.emit(incoming({ messageId: '8003', userId: '2039693365' })); // 她自己发的（回声）
  wire.emit(incoming({ messageId: '' }));                           // 协议里没给 id：不拦，但也别当重复
  await settle(600);
  assert.equal(turns, 2, '只有「没 id 的那条」该再多一次；重复/白名单外/自己的都不算');
});

test('群里说话也走同一条线，回包发回群里', async t => {
  let turns = 0;
  const { ctx, cleanup } = await hostFixture(t, () => { turns += 1; return textResponse('群里回一句'); });
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const wire = fakeTransport();
  const channel = createQqNativeModule({ ctx, home: async () => agent, config: () => configOf(), logger: quiet, transport: wire.factory });
  channel.start(); cleanup.push(channel.stop);

  // 现在群里默认只接被叫到的：给个 @ 段，这条测的是「回包发回群里」而不是闸门。
  wire.emitGroup(incoming({
    kind: 'group', groupId: '681528723', userId: '3997750133', messageId: '9001', text: '@2039693365 大家好',
    segments: [{ type: 'at', data: { qq: '2039693365' } }, { type: 'text', data: { text: ' 大家好' } }],
  }));
  await settle(600);

  assert.equal(turns, 1);
  assert.deepEqual(wire.sent, [{ kind: 'group', to: '681528723', text: '群里回一句' }]);
});


test('群里没叫她就不接：只记上下文，不花一轮', async t => {
  let turns = 0;
  const { ctx, cleanup } = await hostFixture(t, () => { turns += 1; return textResponse('不该被问到'); });
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const wire = fakeTransport();
  const channel = createQqNativeModule({ ctx, home: async () => agent, config: () => configOf(), logger: quiet, transport: wire.factory });
  channel.start(); cleanup.push(channel.stop);

  // 一句普通群聊：没 @、没引用、没关键词
  wire.emitGroup(incoming({ kind: 'group', groupId: '681528723', userId: '3997750133', messageId: '9101', text: '中午吃什么' }));
  await settle(600);

  assert.equal(turns, 0, '没叫到她的群消息不该花一轮');
  assert.equal(wire.sent.length, 0, '也不该往群里冒泡');
  assert.ok(channel.status().lastEventAt, '但消息确实收到了');
});

test('群里被 @ 到、或者有人引用她刚说的话，才递给她', async t => {
  let turns = 0;
  const { ctx, cleanup } = await hostFixture(t, () => { turns += 1; return textResponse('在'); });
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const wire = fakeTransport();
  const channel = createQqNativeModule({ ctx, home: async () => agent, config: () => configOf(), logger: quiet, transport: wire.factory });
  channel.start(); cleanup.push(channel.stop);

  // 被 @：at 段指着她自己的号
  wire.emitGroup(incoming({
    kind: 'group', groupId: '681528723', userId: '3997750133', messageId: '9201', text: '@2039693365 在吗',
    segments: [{ type: 'at', data: { qq: '2039693365' } }, { type: 'text', data: { text: ' 在吗' } }],
  }));
  await settle(600);
  assert.equal(turns, 1, '@ 到她就该接');
  assert.equal(wire.sent.length, 1);

  // 引用她刚回的那句：她发出去的消息 id 是 g1（假传输层固定返回的）
  wire.emitGroup(incoming({
    kind: 'group', groupId: '681528723', userId: '3997750133', messageId: '9202', text: '[引用消息] 这句什么意思',
    segments: [{ type: 'reply', data: { id: 'g1' } }, { type: 'text', data: { text: ' 这句什么意思' } }],
  }));
  await settle(600);
  assert.equal(turns, 2, '有人引用她的话也是冲着她来的');
});

test('命中关键词也算在叫她；私聊不受这个闸门管', async t => {
  let turns = 0;
  const { ctx, cleanup } = await hostFixture(t, () => { turns += 1; return textResponse('在'); });
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const wire = fakeTransport();
  const channel = createQqNativeModule({ ctx, home: async () => agent, config: () => configOf({ groupKeywords: ['大肥鱼'] }), logger: quiet, transport: wire.factory });
  channel.start(); cleanup.push(channel.stop);

  wire.emitGroup(incoming({ kind: 'group', groupId: '681528723', userId: '3997750133', messageId: '9301', text: '大肥鱼呢' }));
  await settle(600);
  assert.equal(turns, 1, '关键词命中就该接');

  // 私聊：不管关键词、不管 @，一律接
  wire.emit(incoming({ messageId: '9302', text: '喂' }));
  await settle(600);
  assert.equal(turns, 2, '私聊照旧每句都接');
});

test('groupTrigger 拨成 all：群里每句都接（逃生口）', async t => {
  let turns = 0;
  const { ctx, cleanup } = await hostFixture(t, () => { turns += 1; return textResponse('在'); });
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const wire = fakeTransport();
  const channel = createQqNativeModule({ ctx, home: async () => agent, config: () => configOf({ groupTrigger: 'all' }), logger: quiet, transport: wire.factory });
  channel.start(); cleanup.push(channel.stop);

  wire.emitGroup(incoming({ kind: 'group', groupId: '681528723', userId: '3997750133', messageId: '9401', text: '随便说一句' }));
  await settle(600);
  assert.equal(turns, 1, 'all 就是老的「句句都接」');
});

test('不在白名单的消息：到过、被挡下，状态里分得出来', async t => {
  let turns = 0;
  const { ctx, cleanup } = await hostFixture(t, () => { turns += 1; return textResponse('不该被问到'); });
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const wire = fakeTransport();
  const channel = createQqNativeModule({ ctx, home: async () => agent, config: () => configOf(), logger: quiet, transport: wire.factory });
  channel.start(); cleanup.push(channel.stop);

  wire.emit(incoming({ userId: '111111', messageId: '9501' }));
  await settle();

  const status = channel.status();
  assert.equal(turns, 0, '不在白名单不该问她');
  assert.equal(status.blocked, 1, '但要记一笔：这条确实到过通道');
  assert.ok(status.lastBlockedAt, '时间戳也留着');
  assert.ok(status.lastEventAt, 'lastEventAt 同时会动 —— 两个数一起看才知道是「送到了但被挡」');
});


test('她回过的话记成她自己说的：下一轮的上下文里那几句是 assistant', async t => {
  const { ctx, cleanup } = await hostFixture(t, () => textResponse('我在。'));
  const agent = (await ctx.agents.create({ sessionId: SessionId('home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const wire = fakeTransport();
  const injected: string[] = [];
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'user/message' && (event.data.source ?? {}).kind === 'dsh-world-channel-context') {
      injected.push(String((event.data.content?.[0] as { text?: string } | undefined)?.text ?? ''));
    }
  });
  const channel = createQqNativeModule({ ctx, home: async () => agent, config: () => configOf(), logger: quiet, transport: wire.factory });
  channel.start(); cleanup.push(channel.stop);

  const at = { kind: 'group' as const, groupId: '681528723', segments: [{ type: 'at', data: { qq: '2039693365' } }] };
  wire.emitGroup(incoming({ ...at, messageId: '8101', text: '@大肥鱼 在吗' }));
  await settle(600);
  assert.equal(wire.sent.length, 1, '叫到她了，她回了一句');

  wire.emitGroup(incoming({ ...at, messageId: '8102', text: '@大肥鱼 刚才聊到哪了' }));
  await settle(600);

  assert.equal(injected.length, 1, '第二条进群消息带上了上下文');
  assert.match(injected[0], /"role":"assistant"/, '她说过的那句是 assistant，不是对方说的');
});

test('阳台等待空闲期间移出工作区，不再注入上下文或敲门消息', async t => {
  for (const kind of ['message', 'ring']) await t.test(kind, async t => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let playing!: () => void; const started = new Promise<void>(resolve => { playing = resolve; });
    let turns = 0;
    const { ctx, cleanup, root } = await hostFixture(t, () => (async function* () { turns++; if (turns === 1) { playing(); await gate; } yield* textResponse('忙完了'); })());
    cleanup.push(release);
    const agent = (await ctx.agents.create({ sessionId: SessionId(`moving-${kind}`), agentOptions: { provider: 'test', model: 'test' } })).agent;
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '先忙着' }] }));
    await started;
    let waiting!: () => void; const idleStarted = new Promise<void>(resolve => { waiting = resolve; });
    const whenIdle = agent.whenIdle.bind(agent);
    agent.whenIdle = () => { waiting(); return whenIdle(); };
    const members = new Set<string>([agent.id]);
    const messages: string[] = [];
    ctx.on('session/event', (session, event) => { if (session.id === agent.id && event.type === 'user/message') messages.push(event.data.id); });
    const port = 13900 + Math.floor(Math.random() * 100);
    const token = 'secret-token-workspace-01';
    const bridge = createNativeBridge({
      ctx, session: async () => agent, inWorld: candidate => members.has(candidate.id),
      config: () => ({ port, token, title: '阳台', contextMessages: 4 }),
      worldDir: root, script: 'qq-line.js', log: () => {},
    });
    await bridge.start(); cleanup.push(bridge.stop);
    const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${token}`);
    cleanup.push(() => ws.close());
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ kind, threadId: 'moving-line', text: '不能进入原会话' }));
    await idleStarted;
    members.delete(agent.id);
    release();
    await whenIdle();
    await settle();

    assert.equal(turns, 1);
    assert.deepEqual(messages, []);
    assert.match(bridge.status().lastError!, /工作区/);
    assert.equal(bridge.status().spoken, 0);
  });
});

test('阳台：外面递一句话进来，她把原话吐回那条线；口令不对连不上', async t => {
  let turns = 0;
  const { ctx, cleanup } = await hostFixture(t, () => { turns += 1; return textResponse('听见了，这条线是通的。'); });
  const agent = (await ctx.agents.create({ sessionId: SessionId('outside'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const dir = mkdtempSync(join(tmpdir(), 'qq-bridge-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const port = 13210 + Math.floor(Math.random() * 200);
  const token = 'secret-token-0123456789';
  const bridge = createNativeBridge({
    ctx,
    session: async () => agent,
    config: () => ({ port, token, title: '阳台', contextMessages: 4 }),
    worldDir: dir,
    script: 'qq-line.js',
    log: () => {},
  });
  await bridge.start();
  cleanup.push(() => bridge.stop());

  // 口令不对：hello 递上去也不该被留下。
  const rejected = new WebSocket(`ws://127.0.0.1:${port}`);
  const kicked = await new Promise<boolean>(resolve => {
    rejected.on('open', () => rejected.send(JSON.stringify({ kind: 'hello', threadId: 'x', token: 'nope' })));
    rejected.on('close', () => resolve(true));
    setTimeout(() => resolve(false), 3_000);
  });
  assert.equal(kicked, true, '口令不对该被请出去');
  assert.equal(turns, 0, '没进门就不该花一轮');

  // 口令对：递一句话，她把这一轮的原话吐回来。
  const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${token}`);
  const frames: Array<Record<string, unknown>> = [];
  ws.on('message', data => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
  await new Promise<void>(resolve => {
    ws.on('open', () => { ws.send(JSON.stringify({ kind: 'message', threadId: 'line-1', text: '外面有人问，你在吗', from: '外面' })); resolve(); });
  });
  await settle(2_000);

  assert.equal(turns, 1, '递进来的一句话该花一轮');
  const replies = frames.filter(frame => frame.kind === 'reply');
  assert.equal(replies[0]?.hold, true, '收下的那一刻该先回一条 hold，别让门外干等着');
  assert.equal(replies[0]?.text, '');
  const reply = replies.find(frame => frame.text !== '');
  assert.ok(reply, `该收到一条 reply，实际收到 ${JSON.stringify(frames)}`);
  assert.equal(reply.text, '听见了，这条线是通的。');
  const status = bridge.status();
  assert.equal(status.received, 1);
  assert.equal(status.relayed, 1);
  assert.equal(status.spoken, 1);

  // kind 缺省也算一句话（只会写 {"text":"…"} 的程序太多）；重复 hello 不该有任何反应。
  const before = turns;
  ws.send(JSON.stringify({ threadId: 'line-1', text: '再说一句，这次没写 kind', from: '外面' }));
  ws.send(JSON.stringify({ kind: 'hello', threadId: 'line-1', token }));
  await settle(2_000);
  assert.equal(turns, before + 1, 'kind 缺省也该被当成一句话');
  assert.equal(frames.filter(frame => frame.kind === 'error').length, 0, 'hello 不该被当成一句话、退回"text 是空的"');
  assert.equal(bridge.status().received, 2, '两句话都该记上账（hello 不算）');
  assert.deepEqual(bridge.status().threads, ['line-1'], '线名该进上下文表');
  assert.deepEqual(status.threads, ['line-1']);
  assert.equal(status.serving, true);
  assert.match(status.line, /DSH_QQ_BRIDGE_TOKEN=/);
  ws.close();
});


test('阳台：口令写在 URL 里时，对面再发 hello 也收得到 ready', async t => {
  const { ctx, cleanup } = await hostFixture(t, () => textResponse('嗯。'));
  const agent = (await ctx.agents.create({ sessionId: SessionId('outside2'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const dir = mkdtempSync(join(tmpdir(), 'qq-bridge-ready-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const port = 13460 + Math.floor(Math.random() * 200);
  const token = 'secret-token-ready-0123';
  const bridge = createNativeBridge({
    ctx, session: async () => agent,
    config: () => ({ port, token, title: '阳台', contextMessages: 4 }),
    worldDir: dir, script: 'qq-line.js', log: () => {},
  });
  await bridge.start();
  cleanup.push(() => bridge.stop());

  const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${token}`);
  const frames: Array<Record<string, unknown>> = [];
  ws.on('message', data => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
  await new Promise<void>(resolve => {
    ws.on('open', () => { ws.send(JSON.stringify({ kind: 'hello', threadId: 'line-9', token, from: '外面' })); resolve(); });
  });
  await settle(1_200);
  assert.ok(frames.some(frame => frame.kind === 'ready'), `该收到 ready，实际 ${JSON.stringify(frames)}`);
  assert.equal(frames.filter(frame => frame.kind === 'error').length, 0, 'hello 不该被退回"text 是空的"');
  assert.equal(bridge.status().received, 0, 'hello 不是一句话，不该记账');
  ws.close();
});

test('阳台：线走了以后她说的话记成 dropped，不再混进 spoken', async t => {
  const { ctx, cleanup } = await hostFixture(t, () => textResponse('这句递不出去了。'));
  const agent = (await ctx.agents.create({ sessionId: SessionId('outside3'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const dir = mkdtempSync(join(tmpdir(), 'qq-bridge-drop-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const port = 13660 + Math.floor(Math.random() * 200);
  const token = 'secret-token-dropped-01';
  const bridge = createNativeBridge({
    ctx, session: async () => agent,
    config: () => ({ port, token, title: '阳台', contextMessages: 4 }),
    worldDir: dir, script: 'qq-line.js', log: () => {},
  });
  await bridge.start();
  cleanup.push(() => bridge.stop());

  const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${token}`);
  await new Promise<void>(resolve => { ws.on('open', () => resolve()); });
  ws.send(JSON.stringify({ kind: 'message', threadId: 'line-gone', text: '说完这句我就撤', from: '外面' }));
  ws.close();
  await settle(3_000);
  const status = bridge.status();
  assert.equal(status.received, 1);
  assert.equal(status.relayed, 1);
  assert.equal(status.spoken, 0, '线都走了，不该算"说出去了"');
  assert.equal(status.dropped, 1, '没递到要单独记一笔');
});

test('面板先改阳台端口，也不会丢掉之前存下的自动回复开关', async t => {
  const { ctx } = await hostFixture(t, () => textResponse('嗯'));
  const dir = mkdtempSync(join(tmpdir(), 'dw-qq-state-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'qq-native.json');
  const make = () => createQqNativeModule({ ctx, home: async () => { throw new Error('unused'); }, config: () => configOf(), stateFile, logger: quiet, transport: fakeTransport().factory });
  make().update({ autoReply: false });
  make().update({ bridge: { port: 0 } });
  assert.equal(make().status().autoReply, false);
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), { autoReply: false, bridge: { port: 0 } });
});

test('面板改的合批窗口存下来，重载后还在；没改过的就是配置里的', async t => {
  const { ctx } = await hostFixture(t, () => textResponse('嗯'));
  const dir = mkdtempSync(join(tmpdir(), 'dw-qq-batch-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'qq-native.json');
  const make = () => createQqNativeModule({ ctx, home: async () => { throw new Error('unused'); }, config: () => configOf(), stateFile, logger: quiet, transport: fakeTransport().factory });
  assert.equal(make().status().batchQuietMs, configOf().batchQuietMs);
  make().update({ batchQuietMs: 0 });
  assert.equal(make().status().batchQuietMs, 0);
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).batchQuietMs, 0);
});
