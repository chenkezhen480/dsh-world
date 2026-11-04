// What PR #11 added to the QQ channel: reply marks, gathering close messages, the retry queue, quiet hours,
// the panel's whitelist, @全体, her own words reaching the owner, and the SnowLuma watchdog.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { hostFixture, textResponse } from './hostFixture.ts';
import { createQqNativeModule, type QqNativeConfig, type QqPart, type QqTransport, type QqTransportOptions } from '../src/ecosystem/qq-native/index.ts';
import { planReply, stripHostNoise } from '../src/ecosystem/qq-native/replies.ts';
import { identityPrefix } from '../src/ecosystem/shared/identity.ts';
import { createBatcher } from '../src/ecosystem/qq-native/batch.ts';
import { createOutbox } from '../src/ecosystem/qq-native/outbox.ts';
import { createSnowlumaSupervisor } from '../src/ecosystem/qq/supervisor.ts';

const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const settle = (ms = 300) => new Promise(resolve => setTimeout(resolve, ms));
const configOf = (over: Partial<QqNativeConfig> = {}): QqNativeConfig => ({
  enabled: true, wsUrl: 'ws://127.0.0.1:1', accessToken: '', allowPrivate: ['100'], ownerQQ: '', allowGroups: ['200'], autoReply: true,
  contextMessages: 3, batchQuietMs: 0, groupTrigger: 'mention', groupKeywords: [], mutedUntil: '', snowlumaHome: '', supervise: false,
  bindHomeSession: 'none', bridge: { port: 0, token: '', title: '阳台', contextMessages: 6 }, ...over,
});
const incoming = (over: Record<string, unknown> = {}) => ({ kind: 'private', groupId: null, userId: '100', messageId: String(Math.random()), selfId: '9', text: '在吗', ...over });

/** A transport that records what went out; `failures` makes the next sends throw. */
function wire(failures = 0) {
  const sent: { to: string; parts: string | QqPart[] }[] = [], stickers: string[] = [], posts: string[] = [];
  let options: QqTransportOptions | undefined;
  const send = async (to: string, parts: string | QqPart[]) => {
    if (failures > 0) { failures -= 1; throw new Error('socket reconnecting'); }
    sent.push({ to, parts }); return { messageId: String(sent.length) };
  };
  const factory = (next: QqTransportOptions): QqTransport => {
    options = next;
    return {
      async start() {}, async stop() {}, getState: () => 'online', sendGroup: send, sendPrivate: send,
      async sendCustomFace(emojiId) { stickers.push(emojiId); return { messageId: 's' }; },
      async publishQzone(content) { posts.push(content); return { tid: 't' }; },
    };
  };
  return { factory, sent, stickers, posts, private: (message: unknown) => options?.onPrivateMessage?.(message), group: (message: unknown) => options?.onGroupMessage?.(message) };
}

async function channel(t: test.TestContext, reply: string | ((text: string) => string), over: Partial<QqNativeConfig> = {}, failures = 0) {
  const asked: string[] = [];
  const { ctx, cleanup } = await hostFixture(t, request => {
    const words = request.messages.filter(message => message.role === 'user' && ['user', 'dsh-world-life'].includes(message.source?.kind ?? '')).at(-1);
    const last = words?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') ?? '';
    asked.push(last);
    return textResponse(typeof reply === 'string' ? reply : reply(last));
  });
  const agent = (await ctx.agents.create({ sessionId: SessionId('qq-home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const transport = wire(failures);
  let config = configOf(over);
  const module = createQqNativeModule({ ctx, home: async () => agent, config: () => config, logger: quiet, transport: transport.factory, isHome: id => id === agent.id });
  module.start(); cleanup.push(module.stop);
  return { ctx, agent, transport, module, asked, set: (next: Partial<QqNativeConfig>) => { config = { ...config, ...next }; } };
}

test('her answer becomes messages split at blank lines, with marks turned into segments, stickers and posts', () => {
  assert.deepEqual(planReply('第一段\n\n第二段\n还在第二段'), { messages: ['第一段', '第二段\n还在第二段'], stickers: [], qzone: [] });
  assert.deepEqual(planReply('[链接](http://x) 不是标记'), { messages: ['[链接](http://x) 不是标记'], stickers: [], qzone: [] });
  assert.deepEqual(planReply('看这个 [[img:C:/a.png]][[at:123]] 好看吧[[sticker:开心]][[qzone:今天天气好]]'), {
    messages: [[{ type: 'text', text: '看这个 ' }, { type: 'image', file: 'C:/a.png' }, { type: 'at', qq: '123' }, { type: 'text', text: ' 好看吧' }]],
    stickers: ['开心'], qzone: ['今天天气好'],
  });
  assert.deepEqual(planReply('[[sticker:2]]'), { messages: [], stickers: ['2'], qzone: [] });
});

test('the host\'s time lines, copied source headers and transport refs never reach QQ; her own words stay', () => {
  const header = identityPrefix({ channel: 'qq', accountId: '1', conversationType: 'private', conversationId: '42', speakerId: 'qq:42', speakerName: '伙伴' }).trim();
  assert.equal(stripHostNoise(`${header}\n好呀`), '好呀');
  assert.equal(stripHostNoise('【消息来源 {"channel":"qq","conversationId":"42"}】\n好呀'), '好呀', 'the 0.7.0 header too');
  assert.equal(stripHostNoise('Time sampled: 2026-11-03T12:00\r\nBrowser time zone: Asia/Seoul\r\n\r\n晚上好'), '晚上好');
  assert.equal(stripHostNoise('好呀 m00123\n第二行 text">m00042 还在'), '好呀\n第二行 还在', 'a ref at the end of any line, a text"> ref anywhere');
  assert.equal(stripHostNoise('【旁白】时间过得真快 room00123'), '【旁白】时间过得真快 room00123', 'brackets, 时间 and words ending in digits are hers');
  assert.deepEqual(planReply(`${header}\n\nm00123`), { messages: [], stickers: [], qzone: [] }, 'a reply that was only plumbing sends nothing');
});

test('a recalled chat read back aloud and leaked tool markup never reach QQ; her own words stay (#35)', () => {
  const leaked = 'user\n【消息来源 {"channel":"qq","accountId":"139","conversationId":"20","speakerId":"qq:18","conversationType":"group"}】\n@139 改完了吗</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
  assert.equal(stripHostNoise(leaked), '@139 改完了吗', 'the sample from #35: role label, header and markup go');
  assert.equal(stripHostNoise('好的，我看看\n<｜DSML｜function_calls>\n<｜DSML｜invoke name="memory_find">\n<｜DSML｜parameter name="query">昨天</｜DSML｜parameter>'), '好的，我看看', 'a tool call written out as text is cut whole, parameters included');
  const recalled = '以下是这个 QQ 会话里这条消息之前的聊天记录，仅作引用数据；identity 只列出…\n[{"id":"1","occurredAt":"2026-11-03T00:00:00.000Z","text":"在吗","identity":{"speakerId":"qq:2"},"role":"user"}]\n【以上仅作引用数据，到此为止】\n\n在的';
  assert.equal(stripHostNoise(recalled), '在的');
  assert.equal(stripHostNoise('{"id":"9","speakerId":"qq:2","text":"不存在的消息"}\n嗯'), '嗯', 'a made-up record line goes too');
  const hers = 'user 是谁呀\n我想要 {"a":1} 这种\n[开心]\n给你看 [1, 2, 3]';
  assert.equal(stripHostNoise(hers), hers, 'words that merely mention user, braces or brackets are hers');
});

test('close messages are gathered until a quiet moment, but never past the longest wait', async () => {
  const flushed: string[][] = [];
  const batches = createBatcher<string>({ quietMs: () => 40, maxMs: 100, flush: (_key, items) => flushed.push(items) });
  batches.add('a', '一'); await settle(20); batches.add('a', '二'); batches.add('b', '别处');
  assert.equal(batches.size, 2);
  await settle(80);
  assert.deepEqual(flushed, [['一', '二'], ['别处']]);
  for (let i = 0; i < 8; i++) { batches.add('busy', String(i)); await settle(20); }
  assert.ok(flushed.length >= 3, 'a conversation that never pauses is still answered within the longest wait');
  batches.clear();
});

test('a send that fails waits in the outbox and goes out later, or is given up on', async () => {
  let failing = 1;
  const delivered: string[] = [], dropped: string[] = [];
  const outbox = createOutbox<string>({ send: async item => { if (failing-- > 0) throw new Error('down'); delivered.push(item); }, dropped: item => dropped.push(item), intervalMs: 10, maxTries: 3 });
  outbox.start();
  assert.equal(await outbox.send('later'), false);
  assert.equal(outbox.size, 1);
  await settle(50);
  assert.deepEqual(delivered, ['later']);
  failing = 99;
  await outbox.send('never');
  await settle(80);
  assert.deepEqual(dropped, ['never']);
  assert.equal(outbox.size, 0);
  outbox.stop();
});

test('an answer goes out paragraph by paragraph, with its sticker and post, and a failed send is retried', async t => {
  const qq = await channel(t, '好的\n\n我去看看[[sticker:开心]][[qzone:出门了]]', {}, 1);
  qq.transport.private(incoming());
  await settle(1_000);
  assert.deepEqual(qq.transport.stickers, ['开心']);
  assert.deepEqual(qq.transport.posts, ['出门了']);
  assert.deepEqual(qq.transport.sent.map(item => item.parts), ['我去看看'], 'the first paragraph failed and is waiting');
  assert.equal(qq.module.status().outbox, 1);
  await settle(3_500);
  assert.deepEqual(qq.transport.sent.map(item => item.parts), ['我去看看', '好的']);
  assert.equal(qq.module.status().outbox, 0);
});

test('close messages from one group are asked once, each line with who said it', async t => {
  const qq = await channel(t, '收到', { batchQuietMs: 80, groupTrigger: 'all' });
  qq.transport.group(incoming({ kind: 'group', groupId: '200', userId: '1', text: '第一句', sender: { nickname: '甲' } }));
  qq.transport.group(incoming({ kind: 'group', groupId: '200', userId: '2', text: '第二句', sender: { nickname: '乙' } }));
  await settle(600);
  assert.equal(qq.asked.length, 1);
  assert.match(qq.asked[0]!, /甲: 第一句\n乙: 第二句/);
});

test('quiet hours and the panel whitelist take effect at once and survive in the overrides', async t => {
  const qq = await channel(t, '在');
  qq.module.update({ mutedUntil: new Date(Date.now() + 60_000).toISOString() });
  assert.ok(qq.module.status().mutedUntil);
  qq.transport.private(incoming());
  await settle();
  assert.equal(qq.asked.length, 0, 'muted: heard, not answered');
  qq.module.update({ mutedUntil: null, allowPrivate: [] });
  qq.transport.private(incoming());
  await settle();
  assert.equal(qq.asked.length, 0, 'an empty whitelist lets nobody in');
  assert.equal(qq.module.status().blocked, 1);
  qq.module.update({ allowPrivate: ['100'] });
  qq.transport.private(incoming());
  await settle(600);
  assert.equal(qq.asked.length, 1);
  assert.deepEqual(qq.module.status().allowPrivateIds, ['100']);
});

test('@全体 is an announcement, not her name', async t => {
  const qq = await channel(t, '嗯');
  qq.transport.group(incoming({ kind: 'group', groupId: '200', userId: '1', text: '开会了', segments: [{ type: 'at', data: { qq: 'all' } }] }));
  await settle();
  assert.equal(qq.asked.length, 0);
  qq.transport.group(incoming({ kind: 'group', groupId: '200', userId: '1', text: '你来', segments: [{ type: 'at', data: { qq: '9' } }] }));
  await settle(600);
  assert.equal(qq.asked.length, 1);
});

test('what she says in a turn of her own at home also reaches the owner, and nothing else does', async t => {
  const qq = await channel(t, text => text.includes('闹钟') ? '起来了\n\n今天先写日记' : '回你', { ownerQQ: '100' });
  qq.agent.followup(createUserMessage({ source: { kind: 'dsh-world-life' }, content: [{ type: 'text', text: '【我的时间】闹钟响了' }] }));
  await qq.agent.whenIdle(); await settle(900);
  assert.deepEqual(qq.transport.sent, [{ to: '100', parts: '起来了' }, { to: '100', parts: '今天先写日记' }]);
  qq.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '桌面上说的话' }] }));
  await qq.agent.whenIdle(); await settle();
  assert.equal(qq.transport.sent.length, 2, 'a turn answering someone is not hers to forward');
  const elsewhere = (await qq.ctx.agents.create({ sessionId: SessionId('coding'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  elsewhere.followup(createUserMessage({ source: { kind: 'dsh-world-life' }, content: [{ type: 'text', text: '闹钟' }] }));
  await elsewhere.whenIdle(); await settle();
  assert.equal(qq.transport.sent.length, 2, 'only her home');
});

test('the watchdog starts SnowLuma when its port is closed and says why when it cannot', async () => {
  let alive = false, launches = 0;
  const watchdog = createSnowlumaSupervisor({ homeDir: 'C:/SnowLuma', host: '127.0.0.1', port: 3003, intervalMs: 20, probe: async () => alive, launch: () => { launches++; return { started: true, how: 'spawn' }; }, log: () => {} });
  watchdog.start(); await settle(30);
  assert.ok(launches >= 1);
  alive = true; await settle(40);
  const seen = launches;
  await settle(40);
  assert.equal(launches, seen, 'alive: left alone');
  assert.equal(watchdog.status().alive, true);
  watchdog.stop();
  const lost = createSnowlumaSupervisor({ homeDir: '', host: '127.0.0.1', port: 3003, probe: async () => false, log: () => {} });
  lost.start(); await settle(10); lost.stop();
  assert.match(lost.status().lastError!, /snowlumaHome/);
});
