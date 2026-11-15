import assert from 'node:assert/strict';
import test from 'node:test';
import { createWechatPresence } from '../src/ecosystem/wechat/presence.ts';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWechatModule } from '../src/ecosystem/wechat/index.ts';
import { hostFixture } from './hostFixture.ts';

const now = new Date('2026-10-29T04:00:00Z');
const group = { id: 'family@chatroom', name: '家人' };
const report = (patch = {}) => ({ accountId: 'bot', chats: [group], presence: {
  observedAt: now.toISOString(), groups: [{ chatId: group.id, count: 37, lastSpeaker: '爸爸', lastAt: '2026-10-29T03:40:00Z', lastSelf: false }], ...patch,
} });
test('a group with unread messages is news from elsewhere, a quiet one is for her alarm, both bounded facts without instructions', () => {
  const p = createWechatPresence();
  assert.deepEqual(p.unread(now), []); assert.equal(p.quiet(now), undefined);
  p.accept(report());
  assert.deepEqual(p.unread(now), [{ key: 'wechat:family@chatroom', mark: '37:1793245200000', text: '微信群「家人」37 条我还没看到，最后是爸爸（20 分钟前）' }]);
  assert.equal(p.quiet(now), undefined, 'a group with unread messages is not repeated on the alarm');
  p.accept(report({ groups: [{ chatId: group.id, count: 100, lastSpeaker: '爸爸', lastAt: '2026-10-29T03:40:00Z', lastSelf: false }] }));
  assert.match(p.unread(now)[0]!.text, /99\+/);
  p.accept(report({ groups: [{ chatId: group.id, count: 0, lastSpeaker: '鲸鲸', lastAt: '2026-10-26T04:00:00Z', lastSelf: true }] }));
  assert.deepEqual(p.unread(now), []);
  assert.equal(p.quiet(now), '微信：「家人」3 天没人说话，最后是我自己');
  assert.ok(p.quiet(new Date(now.getTime() + 60_005)), 'a 60-second adapter poll still has a usable summary');
  assert.equal(p.quiet(new Date(now.getTime() + 126_000)), undefined, 'stale adapter data cannot assert a quiet group');
  p.clear(); assert.equal(p.quiet(now), undefined);
});
test('only configured groups are reported and invalid or future metadata is rejected atomically', () => {
  const p = createWechatPresence(); p.accept(report());
  for (const entry of [{ chatId: 'stranger@chatroom' }, { count: -1 }, { count: 1.5 }, { lastAt: 'not a date' }, { lastSelf: 'yes' }]) {
    const body = report(); Object.assign(body.presence.groups[0], entry);
    assert.throws(() => p.accept(body));
  }
  assert.match(p.unread(now)[0]!.text, /37 条我还没看到/);
  p.accept({ accountId: 'other', chats: [], presence: { observedAt: now.toISOString(), groups: [] } });
  assert.deepEqual(p.unread(now), []);
});
test('authenticated adapter polls update facts without opening a home, and offline or bad reports clear them', async t => {
  const { ctx, root, cleanup } = await hostFixture(t, async function* () { assert.fail('metadata must not call a model'); });
  const file = join(root, 'wechat.json');
  const module = createWechatModule({ ctx, file, home: async () => { assert.fail('metadata must not open a home'); }, origin: () => 'http://127.0.0.1', allowedHosts: [] });
  module.start(); cleanup.push(() => module.stop());
  const { token } = JSON.parse(await readFile(file, 'utf8'));
  const post = async (body: unknown, auth = token) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', headers: { host: '127.0.0.1', 'x-dsh-world-token': auth } });
    let status = 0;
    await module.route.handler(req as never, { writeHead(code: number) { status = code; }, end() {} } as never);
    return status;
  };
  assert.equal(await post({ outbox: report() }, 'bad'), 403);
  assert.deepEqual(module.elsewhere.news(now), []);
  assert.equal(await post({ outbox: report() }), 200);
  assert.match(module.elsewhere.news(now)[0]!.text, /37 条我还没看到/);
  assert.equal(ctx.agents.list().length, 0);
  assert.equal(await post({ status: { wechat: 'offline' } }), 200);
  assert.deepEqual(module.elsewhere.news(now), []);
  assert.equal(await post({ outbox: report({ groups: [{ chatId: 'unknown@chatroom' }] }) }), 400);
  assert.deepEqual(module.elsewhere.news(now), []);
});
