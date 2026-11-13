// 本地单测：把 fixtures 里的真实事件（逐字来自外包交付包）喂给 snowluma.ts，
// 不连网，只断言契约行为。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import {
  createBridge,
  segmentsToText,
  normalizeMessageEvent,
  normalizeNoticeEvent,
  normalizeNoticeType,
  buildSegments,
} from '../src/ecosystem/qq-native/snowluma.ts';

/** 契约测试只关心「喂进去什么、吐出来什么」，形状用这个别名放开。 */
type Loose = any;

const HERE = path.dirname(fileURLToPath(import.meta.url));

const load = (name: Loose) => JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'qqSdk', name), 'utf8'));

// 把一条 SDK 事件灌进 bridge 的内部分发链（不连网）
function feed(bridge: Loose, event: Loose) {
  bridge.__emitForTest(event);
}

test('群消息：最小通路（fixtures/event.group.text.json）', () => {
  const got: Loose[] = [];
  const bridge = createBridge({ wsUrl: 'ws://127.0.0.1:0/', onGroupMessage: (m: Loose) => got.push(m) });
  feed(bridge, load('event.group.text.json'));
  const msg = got[0];
  assert.ok(msg, '群消息应进入 onGroupMessage');
  assert.equal(msg.kind, 'group');
  assert.equal(msg.groupId, '700000001');        // 一律字符串化
  assert.equal(msg.userId, '3000000001');
  assert.equal(msg.messageId, '2000000001');
  assert.equal(msg.selfId, '1000000001');
  assert.equal(msg.time, 1761523200);
  assert.equal(msg.rawMessage, '在吗');
  assert.equal(msg.text, '在吗');
  assert.equal(msg.sender.card, '小明');
  assert.equal(msg.sender.role, 'member');
  assert.equal(msg.sender.userId, '3000000001');
  assert.equal(msg.sender.nickname, '小明');
});

test('混合段：未知段不丢、reply id 在 segments 里、mface 有可读占位', () => {
  const got: Loose[] = [];
  const bridge = createBridge({ wsUrl: 'ws://127.0.0.1:0/', onGroupMessage: (m: Loose) => got.push(m) });
  feed(bridge, load('event.group.mixed.json'));
  const msg = got[0];
  assert.equal(msg.segments.length, 6);
  assert.equal(msg.segments[0].type, 'reply');
  assert.equal(msg.segments[0].data.id, '2000000001');   // 契约没给 msg.replyId，引用信息在 segments 里
  assert.equal(msg.segments[1].type, 'at');
  assert.equal(msg.segments[1].data.qq, '1000000001');
  assert.equal(msg.sender.role, 'admin');
  assert.match(msg.text, /帮我看下这段/);
  assert.match(msg.text, /\[动画表情\]|\[mface/, 'mface 段必须可读或落到 default 分支留占位');
  assert.match(msg.text, /^\[引用消息\]/, 'reply 段转成引用占位');
  assert.match(msg.text, /@1000000001/);
  assert.match(msg.text, /\[图片\]/);
  assert.equal(msg.segments.find((segment: Loose) => segment.type === 'image').data.file, 'ab12cd34.image');
  assert.match(msg.text, /\[表情14\]/);
});

test('私聊：负数 message_id 与缺失 card（fixtures/event.private.text.json）', () => {
  const got: Loose[] = [];
  const bridge = createBridge({ wsUrl: 'ws://127.0.0.1:0/', onPrivateMessage: (m: Loose) => got.push(m) });
  feed(bridge, load('event.private.text.json'));
  const msg = got[0];
  assert.equal(msg.kind, 'private');
  assert.equal(msg.groupId, null);
  assert.equal(msg.messageId, '-1234567890');            // 负数不能当 falsy 丢掉
  assert.equal(msg.sender.card ?? null, null);           // 缺 card → null，不是空串
  assert.equal(msg.sender.role ?? null, null);
  assert.match(msg.text, /私聊测试/);
  assert.match(msg.text, /\[卡片消息\]/);                 // json 段
});

test('机器人状态：走 notice，不进消息通路，归一化为 bot_offline', () => {
  const groupMsgs = [];
  const notices: Loose[] = [];
  const bridge = createBridge({
    wsUrl: 'ws://127.0.0.1:0/',
    onGroupMessage: (m: Loose) => groupMsgs.push(m),
    onNotice: (type: Loose, m: Loose) => notices.push([type, m]),
  });
  feed(bridge, load('event.notice.bot-status.json'));
  assert.equal(groupMsgs.length, 0, 'bot_status 不能当群消息');
  assert.equal(notices.length, 1);
  assert.equal(notices[0][0], 'bot_offline');            // 契约的归一化名，不是 'bot_status'
  assert.equal(notices[0][1].kind, 'notice');
  assert.equal(notices[0][1].noticeType, 'bot_status');
  assert.equal(notices[0][1].subType, 'offline');
});

test('防回声：user_id / sender.user_id 两个来源 + message_sent 全部过滤', () => {
  const got: Loose[] = [];
  const bridge = createBridge({ wsUrl: 'ws://127.0.0.1:0/', onGroupMessage: (m: Loose) => got.push(m) });
  const base = { time: 1, self_id: 1000000001, message_type: 'group', sub_type: 'normal', group_id: 7, message: [], raw_message: '', font: 0 };

  feed(bridge, { ...base, post_type: 'message', message_id: 1, user_id: 1000000001, sender: { user_id: 1000000001, nickname: 'x' } });
  feed(bridge, { ...base, post_type: 'message', message_id: 2, user_id: 2000000002, sender: { user_id: 1000000001, nickname: 'x' } }); // 只 sender 是自己
  feed(bridge, { ...base, post_type: 'message_sent', message_id: 3, user_id: 2000000002, sender: { user_id: 2000000002, nickname: 'x' } }); // 回流
  // id 混用：self 是字符串、user 是数字，也必须过滤（切片第 2 节）
  feed(bridge, { ...base, post_type: 'message', message_id: 4, self_id: '1000000001', user_id: 1000000001, sender: { user_id: 2000000002, nickname: 'x' } });
  feed(bridge, { ...base, post_type: 'message', message_id: 5, user_id: 3000000003, sender: { user_id: 3000000003, nickname: 'ok' } }); // 正常消息

  assert.equal(got.length, 1, '只有最后一条正常消息通过');
  assert.equal(got[0].messageId, '5');
  assert.equal(got[0].sender.card, null);
});

test('message 为字符串时从 CQ 重建 segments，图片链接不进入文本', () => {
  const event = load('event.group.text.json');
  event.message = '在吗[CQ:face,id=14][CQ:image,file=abc.png,url=https://example.com/private]';
  const msg = normalizeMessageEvent(event) as Loose;
  assert.equal(msg.text, '在吗[CQ:face,id=14][图片]');
  assert.equal(msg.segments.length, 3);
  assert.deepEqual(msg.segments[1], { type: 'face', data: { id: '14' } });
  assert.equal(msg.segments[2].data.file, 'abc.png');
});

test('segmentsToText：at all、markdown、完全未知段走 default', () => {
  assert.equal(segmentsToText([{ type: 'at', data: { qq: 'all' } }]), '@全体成员');
  assert.equal(segmentsToText([{ type: 'markdown', data: { content: '# hi' } }]), '# hi');
  assert.equal(segmentsToText([{ type: 'markdown', data: { text: 't', content: 'c' } }]), 't');
  assert.equal(segmentsToText([{ type: 'weather', data: { foo: 1 } }]), '[weather]');
  assert.equal(segmentsToText([{ type: 'file', data: { name: 'a.zip' } }]), '[文件a.zip]');
  assert.equal(segmentsToText([{ type: 'forward', data: { forward_id: 'fw1' } }]), '[转发消息 id=fw1]');
  assert.equal(segmentsToText('  纯文本  '), '纯文本');
  assert.equal(segmentsToText(null), '');
  assert.equal(segmentsToText([{ type: 'mface', data: { summary: '[动画表情]' } }]), '[表情:[动画表情]]');
});

test('notice 归一化：poke 两形状、未知类型给 other、不 throw', () => {
  assert.equal(normalizeNoticeType({ notice_type: 'notify', sub_type: 'poke' }), 'poke');
  assert.equal(normalizeNoticeType({ notice_type: 'group_poke' }), 'poke');
  assert.equal(normalizeNoticeType({ notice_type: 'bot_status', sub_type: 'online' }), 'bot_online');
  assert.equal(normalizeNoticeType({ notice_type: 'bot_status', sub_type: 'weird' }), 'other');
  assert.equal(normalizeNoticeType({ notice_type: 'group_increase' }), 'group_increase');
  assert.equal(normalizeNoticeType({ notice_type: 'friend_recall' }), 'friend_recall');
  assert.equal(normalizeNoticeType({ notice_type: 'essence', sub_type: 'add' }), 'other');
  assert.equal(normalizeNoticeType({}), 'other');
  assert.equal(normalizeNoticeEvent({ post_type: 'message' }), null);
});

// ── 出站 ─────────────────────────────────────────────────────

test('出站：reply/at/text 的段形状与 CQ 转义', () => {
  const segs = buildSegments([
    { type: 'reply', id: '2000000001' },
    { type: 'at', qq: '3000000001' },
    { type: 'text', text: '[CQ:at,qq=all] 好' },
  ]);
  assert.deepEqual(segs[0], { type: 'reply', data: { id: '2000000001' } });
  assert.deepEqual(segs[1], { type: 'at', data: { qq: '3000000001' } });
  assert.equal(segs[2].type, 'text');
  assert.equal(segs[2].data.text, '[CQ：at,qq=all] 好');   // 全角防注入，切片第 6 节
});

test('出站：字符串等价 text；数字 qq/id 可用', () => {
  assert.deepEqual(buildSegments('hi'), [{ type: 'text', data: { text: 'hi' } }]);
  const segs = buildSegments([{ type: 'at', qq: 123 }, { type: 'face', id: 14 }]);
  assert.deepEqual(segs[0], { type: 'at', data: { qq: '123' } });
  assert.deepEqual(segs[1], { type: 'face', data: { id: '14' } });
});

test('出站：@全体和字符串账号保持原值，不经过数字转换', () => {
  const segments = buildSegments([{ type: 'at', qq: 'all' }, { type: 'at', qq: '9007199254740993' }]);
  assert.deepEqual(segments, [{ type: 'at', data: { qq: 'all' } }, { type: 'at', data: { qq: '9007199254740993' } }]);
});

test('出站：两个 reply 抛错（SDK 契约）、未知类型/缺字段/空 parts 抛错', () => {
  assert.throws(() => buildSegments([{ type: 'reply', id: '1' }, { type: 'reply', id: '2' }, { type: 'text', text: 'x' }]), /can only appear once/);
  assert.throws(() => buildSegments([{ type: 'poke', id: '1' }]), /不支持的 parts 段类型/);
  assert.throws(() => buildSegments([{ type: 'at' }]), /缺少必填字段 "qq"/);
  assert.throws(() => buildSegments([{ type: 'reply' }]), /缺少必填字段 "id"/);
  assert.throws(() => buildSegments([{ type: 'image' }]), /缺少必填字段 "file"/);
  assert.throws(() => buildSegments([]), /parts 不能为空/);
  assert.throws(() => buildSegments(42), /必须是数组或字符串/);
});

test('sendGroup/sendPrivate 未启动时 reject 得清楚；stop 幂等；初始状态 closed', async () => {
  const bridge = createBridge({ wsUrl: 'ws://127.0.0.1:0/' });
  assert.equal(bridge.getState(), 'closed');
  await assert.rejects(bridge.sendGroup('123', 'hi'), /QQ 桥未启动或已停止/);
  await assert.rejects(bridge.sendPrivate(123, 'hi'), /QQ 桥未启动或已停止/);
  await bridge.stop();
  await bridge.stop();   // 幂等：第二次不许抛
  assert.equal(bridge.getState(), 'closed');
});

test('start 对拒连端点 fail-loud：reject + 状态保持 connecting（SDK 退避重试），stop 后 closed', async () => {
  // 先占一个端口再关掉，得到一个必然拒连的本地端口
  const server = net.createServer();
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', () => r()); });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise((r) => server.close(r));

  const states: Loose[] = [];
  const bridge = createBridge({
    wsUrl: `ws://127.0.0.1:${port}/`,
    onState: (s: Loose) => states.push(s),
  });
  await assert.rejects(bridge.start(), /SnowLuma/, 'start() 必须把失败说清楚');
  assert.equal(bridge.getState(), 'connecting', 'SDK reconnect 在退避重试，状态是 connecting');
  await bridge.stop();
  assert.equal(bridge.getState(), 'closed');
  assert.equal(states[0], 'connecting');
});

test('握手期间关闭 QQ 连接不会抛出未处理的 WebSocket 错误', { timeout: 5000 }, async t => {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let socket: net.Socket | undefined;
  t.after(async () => {
    socket?.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const accepted = new Promise<net.Socket>(resolve => server.once('connection', resolve));
  const port = (server.address() as net.AddressInfo).port;
  const bridge = createBridge({ wsUrl: `ws://127.0.0.1:${port}/` });
  const rejected = assert.rejects(bridge.start(), /closed/);
  socket = await accepted;
  await bridge.stop();
  await rejected;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(bridge.getState(), 'closed');
});
