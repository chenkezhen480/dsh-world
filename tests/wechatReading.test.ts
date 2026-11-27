import assert from 'node:assert/strict';
import test from 'node:test';
import { createWechatReading } from '../src/ecosystem/wechat/reading.ts';
import { speakerIdentity } from '../src/ecosystem/shared/identity.ts';

const identity = speakerIdentity({ channel: 'wechat', accountId: 'bot', speakerId: 'wechat:bot', conversationId: 'family@chatroom', conversationType: 'group', conversationName: '家人' });
const entry = { id: 'm.db:1', occurredAt: '2026-10-27T10:00:00Z', text: '今晚吃面', identity: { ...identity, speakerId: 'wechat:dad', speakerName: '爸爸' } };
function fixture(images?: (source: typeof identity, context: unknown[]) => Promise<unknown[]>, timeZone?: string) {
  let allowed = true;
  const deferred: { source: { kind: string }; content: unknown[] }[] = [];
  const reading = createWechatReading({ timeZone, target: (id: string) => { if (!allowed || id !== identity.conversationId) throw new Error('聊天不在配置中'); return identity; }, images: images as never });
  const controller = new AbortController();
  const tool = { signal: controller.signal, deferContext: (message: (typeof deferred)[number]) => { deferred.push(message); } } as never;
  const run = (args: object = {}) => reading.tool.execute({ chatId: identity.conversationId, ...args }, tool);
  const look = (args: object = {}) => reading.imageTool.execute({ chatId: identity.conversationId, messageId: 'm.db:9', ...args }, tool);
  return { reading, controller, run, look, deferred, revoke: () => { allowed = false; } };
}
const picture = { ...entry, id: 'm.db:9', text: '【群图片】', image: { file: 'a'.repeat(64) + '.png', quality: 'cached' as const } };

test('history reads a configured group without a mention and keeps the same chatId and stable cursor for sending', async t => {
  const { reading, run } = fixture(); t.after(reading.stop);
  const result = run({ limit: 2 });
  const job = reading.poll()!;
  assert.equal(job.chatId, identity.conversationId); assert.equal(job.accountId, 'bot'); assert.equal(job.limit, 2);
  assert.deepEqual(reading.poll(), job, 'read-only requests can safely be delivered again until answered');
  reading.accept({ id: job.id, accountId: 'bot', chatId: job.chatId, messages: [entry], nextCursor: 'older-page' });
  const page = JSON.parse(await result as string);
  assert.equal(page.chatId, identity.conversationId); assert.equal(page.messages[0].identity.speakerId, 'wechat:dad');
  const older = run({ cursor: page.nextCursor });
  const next = reading.poll()!; assert.equal(next.cursor, 'older-page');
  reading.accept({ id: next.id, accountId: 'bot', chatId: next.chatId, messages: [] });
  assert.deepEqual(JSON.parse(await older as string).messages, []);
  assert.equal(reading.poll(), undefined);
});

test('history rejects invalid pagination, private chats, another account and cross-group results', async t => {
  const { reading, run } = fixture(); t.after(reading.stop);
  for (const args of [{ limit: 0 }, { limit: 21 }, { chatId: 'private' }, { cursor: '' }]) await assert.rejects(run(args));
  const result = run(); const job = reading.poll()!;
  assert.throws(() => reading.accept({ id: job.id, accountId: 'other', chatId: job.chatId, messages: [] }));
  assert.throws(() => reading.accept({ id: job.id, accountId: 'bot', chatId: job.chatId, messages: [{ ...entry, identity: { ...entry.identity, conversationId: 'other@chatroom' } }] }));
  reading.accept({ id: job.id, accountId: 'bot', chatId: job.chatId, error: '数据库快照不可读取' });
  await assert.rejects(result, /数据库快照不可读取/);
});

test('cancellation, stopping and a removed target release waiting reads; late results are harmless', async () => {
  const f = fixture();
  const pending = f.run(); const job = f.reading.poll()!;
  f.controller.abort(new Error('turn cancelled')); await assert.rejects(pending, /turn cancelled/);
  assert.equal(f.reading.poll(), undefined);
  f.reading.accept({ id: job.id, accountId: 'bot', chatId: job.chatId, messages: [] });
  const g = fixture(); const removed = g.run(); g.revoke();
  assert.equal(g.reading.poll(), undefined); await assert.rejects(removed, /聊天不在配置中/);
  const stopped = f.reading.tool.execute({ chatId: identity.conversationId }, { signal: new AbortController().signal } as never);
  f.reading.stop(); await assert.rejects(stopped, /停止/); g.reading.stop();
});

test('an absent or old adapter times out instead of hanging the model turn', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { reading, run } = fixture(); t.after(reading.stop);
  const pending = run(); const failed = assert.rejects(pending, /超时/);
  t.mock.timers.tick(30_000); await failed;
  assert.equal(reading.poll(), undefined);
});

test('only consumed successful reads acknowledge clearing; duplicate deliveries keep the same result', async t => {
  const f = fixture(); t.after(f.reading.stop);
  const pending = f.run(); const job = f.reading.poll()!;
  const result = { id: job.id, accountId: 'bot', chatId: job.chatId, messages: [entry] };
  assert.equal(f.reading.accept(result), true); await pending;
  assert.equal(f.reading.accept(result), true, 'a lost HTTP acknowledgement may be retried');
  assert.equal(f.reading.accept({ ...result, messages: [] }), false);
  const g = fixture(); t.after(g.reading.stop);
  const cancelled = g.run(); const old = g.reading.poll()!;
  g.controller.abort(new Error('cancelled')); await assert.rejects(cancelled);
  assert.equal(g.reading.accept({ ...result, id: old.id }), false, 'a late ignored result must not clear unread');
});

test('wechat_image asks the adapter for one picture by the id history showed and hands it over as a context message', async t => {
  const seen: unknown[][] = [];
  const { reading, look, deferred } = fixture(async (_source, context) => { seen.push(context); return [{ type: 'text', text: '图片来源' }, { type: 'image', attachment: { attachmentId: 'x' } }]; }, 'Asia/Shanghai'); t.after(reading.stop);
  const result = look();
  const job = reading.poll()!;
  assert.equal(job.imageId, 'm.db:9'); assert.equal(job.limit, 1); assert.equal(job.chatId, identity.conversationId);
  reading.accept({ id: job.id, accountId: 'bot', chatId: job.chatId, messages: [picture] });
  const text = await result as string;
  assert.match(text, /m.db:9/); assert.match(text, /下一条消息/);
  assert.match(text, /2026-10-27T18:00:00\+08:00/);
  assert.equal(seen.length, 1);
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0].source.kind, 'dsh-world-channel-context');
  assert.deepEqual(deferred[0].content.map(block => (block as { type: string }).type), ['text', 'image']);
});

test('wechat_image refuses what is not one picture of a configured group, and an answer that does not match', async t => {
  const { reading, look } = fixture(async () => []); t.after(reading.stop);
  for (const args of [{ messageId: '' }, { messageId: 'm.db' }, { messageId: 'm.db:x' }, { messageId: 'x'.repeat(100) + ':1' }, { chatId: 'private' }]) await assert.rejects(look(args));
  for (const answer of [[], [{ ...picture, image: undefined }], [{ ...picture, id: 'm.db:10' }], [picture, picture]]) {
    const result = look(); const job = reading.poll()!;
    assert.throws(() => reading.accept({ id: job.id, accountId: 'bot', chatId: job.chatId, messages: answer }));
    reading.accept({ id: job.id, accountId: 'bot', chatId: job.chatId, error: '放弃' });
    await assert.rejects(result, /放弃/);
  }
});

test('wechat_image reports a picture the adapter could not read instead of pretending it looked', async t => {
  const { reading, look, deferred } = fixture(async () => []); t.after(reading.stop);
  const result = look(); const job = reading.poll()!;
  reading.accept({ id: job.id, accountId: 'bot', chatId: job.chatId, error: '图片未读取：图片尚未下载到这台电脑' });
  await assert.rejects(result, /尚未下载/);
  assert.equal(deferred.length, 0);
});
