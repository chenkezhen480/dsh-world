import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { QQ_PREFIX, WRITE_HEADER, qqRoute } from '../src/ecosystem/qq/route.ts';
import type { ConsoleDoors } from '../src/ecosystem/qq/panel.ts';

function request(method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}) {
  const text = options.body === undefined ? '' : JSON.stringify(options.body);
  const stream = Readable.from(text ? [Buffer.from(text)] : []);
  return Object.assign(stream, { method, url: QQ_PREFIX + path, headers: { host: '127.0.0.1:1707', ...options.headers } }) as never;
}
async function call(route: ReturnType<typeof qqRoute>, req: never) {
  let status = 0;
  let body = '';
  const res = { writeHead: (code: number) => { status = code; }, end: (text: string) => { body = text; }, setHeader: () => {}, getHeader: () => undefined, headersSent: false } as never;
  await route.handler(req, res);
  return { status, body: body ? JSON.parse(body) : undefined };
}
/** 两扇门只剩 SnowLuma 一扇（外面那个 qq-bridge 的门口在 2026-10-27 拆掉了）。 */
function doors(overrides: Partial<ConsoleDoors> = {}): ConsoleDoors {
  return {
    snowluma: async () => ({ needs: 'password' as const, url: 'http://127.0.0.1:5099' }),
    remember: async () => ({ url: 'http://127.0.0.1:5099/?token=abc' }),
    open: async () => ({ opened: true as const }),
    ...overrides,
  };
}
const native = () => ({ connected: true, url: 'ws://127.0.0.1:3003', autoReply: false });
const WRITE = { [WRITE_HEADER]: '1' };

test('QQ 前缀下：状态是 GET，认不出来的路径是 404', async () => {
  const route = qqRoute([], doors(), native, () => ({ ok: true }));
  assert.deepEqual({ kind: route.kind, path: route.path }, { kind: 'prefix', path: '/dsh-world/qq' });
  const answered = await call(route, request('GET', '/native'));
  assert.equal(answered.status, 200);
  assert.equal(answered.body.connected, true);
  // 不认识的路径不该被当成 console：POST 落到写表里没有 → 404；GET 只有 /native 与 /console 两扇门 → 405。
  assert.equal((await call(route, request('POST', '/nope', { headers: WRITE }))).status, 404);
  assert.equal((await call(route, request('GET', '/nope'))).status, 405);
  // 桥那几扇门（/start /stop /halt /bind /unbind）连同桥一起没了，别再留后门。
  for (const path of ['/start', '/stop', '/halt', '/bind', '/unbind', '/proactive']) {
    const gone = await call(route, request('POST', path, { headers: WRITE }));
    assert.ok(gone.status === 404 || gone.status === 405, `${path} 应该是 404 或 405，实际 ${gone.status}`);
  }
});

test('写操作必须带 x-dsh-world 头，跨站来的连读都不给', async () => {
  const route = qqRoute([], doors(), native, () => ({ ok: true }));
  assert.equal((await call(route, request('POST', '/native', { body: { autoReply: true } }))).status, 400);
  assert.equal((await call(route, request('POST', '/native', { headers: { ...WRITE, 'sec-fetch-site': 'cross-site' }, body: { autoReply: true } }))).status, 403);
  assert.equal((await call(route, request('POST', '/native', { headers: WRITE, body: { autoReply: true } }))).status, 200);
});

test('面板的白名单、静默和拉起 SnowLuma 校验后一起交给通道', async () => {
  const patches: unknown[] = [];
  const route = qqRoute([], doors(), native, patch => { patches.push(patch); return { ok: true }; });
  const post = (body: unknown) => call(route, request('POST', '/native', { headers: WRITE, body }));
  assert.equal((await post({ allowPrivate: '123' })).status, 400, '名单要是数组');
  assert.match(String((await post({ allowGroups: ['12a'] })).body.error), /不是号码：12a/);
  assert.equal((await post({ mutedUntil: '明天早上' })).status, 400);
  assert.equal((await post({ startSnowluma: 'yes' })).status, 400, '只认 true，别的不猜');
  assert.equal((await post({ allowPrivate: [' 123 ', 456, ''], allowGroups: [], mutedUntil: '2026-10-29T08:00:00+08:00', startSnowluma: true })).status, 200);
  assert.equal((await post({ mutedUntil: '' })).status, 200);
  assert.deepEqual(patches, [
    { allowPrivate: ['123', '456'], allowGroups: [], mutedUntil: '2026-10-29T08:00:00+08:00', startSnowluma: true },
    { mutedUntil: null },
  ]);
});

test('合批窗口只收 0 到 30 秒的整数毫秒：一批从第一句起最多等 30 秒，再长也没用', async () => {
  const patches: unknown[] = [];
  const route = qqRoute([], doors(), native, patch => { patches.push(patch); return { ok: true }; });
  const post = (body: unknown) => call(route, request('POST', '/native', { headers: WRITE, body }));
  for (const bad of [-1, 30_001, 1.5, '6000', null]) assert.equal((await post({ batchQuietMs: bad })).status, 400, String(bad));
  assert.equal((await post({ batchQuietMs: 0 })).status, 200);
  assert.equal((await post({ batchQuietMs: 30_000 })).status, 200);
  assert.deepEqual(patches, [{ batchQuietMs: 0 }, { batchQuietMs: 30_000 }]);
});

test('原生通道没有接上时，写接口说清楚，而不是静默成功', async () => {
  const route = qqRoute([], doors(), undefined, undefined);
  assert.equal((await call(route, request('GET', '/native'))).status, 200);
  assert.equal((await call(route, request('GET', '/native'))).body, null);
  const welp = await call(route, request('POST', '/native', { headers: WRITE, body: { autoReply: true } }));
  assert.equal(welp.status, 400);
  assert.match(String(welp.body.error), /没有接上/);
});

test('控制台的地址是读接口：SnowLuma 那扇门要用面板密码现换', async () => {
  const route = qqRoute([], doors(), native, () => ({ ok: true }));
  const read = await call(route, request('GET', '/console'));
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.snowluma, { needs: 'password', url: 'http://127.0.0.1:5099' });
  // 桥那扇门不再存在，所以返回体里也没有 qq。
  assert.equal('qq' in read.body, false);
  // 没接门的时候：说没有，不是 500。
  assert.equal((await call(qqRoute([], undefined, native), request('GET', '/console'))).status, 404);
});

test('/open 只认 SnowLuma 那一扇门', async () => {
  const opened: string[] = [];
  const route = qqRoute([], doors({ open: async kind => { opened.push(kind); return { opened: true as const }; } }), native, () => ({ ok: true }));
  const bad = await call(route, request('POST', '/open', { headers: WRITE, body: { kind: 'qq' } }));
  assert.equal(bad.status, 400);
  assert.equal((await call(route, request('POST', '/open', { headers: WRITE, body: { kind: 'snowluma' } }))).status, 200);
  assert.deepEqual(opened, ['snowluma']);
});

test('面板密码只走 POST，还得带 x-dsh-world 头；密码要是空的就别往磁盘上写', async () => {
  const seen: string[] = [];
  const route = qqRoute([], doors({
    remember: async (username: string, password: string) => { seen.push(`${username || 'admin'}:${password}`); return { url: 'http://127.0.0.1:5099/?token=abc' }; },
  }), native, () => ({ ok: true }));
  assert.equal((await call(route, request('POST', '/panel-password', { body: { password: 'x' } }))).status, 400);
  assert.equal((await call(route, request('POST', '/panel-password', { headers: WRITE, body: { password: '' } }))).status, 400);
  const ok = await call(route, request('POST', '/panel-password', { headers: WRITE, body: { username: '', password: 'hunter2' } }));
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.snowluma, { url: 'http://127.0.0.1:5099/?token=abc' });
  assert.deepEqual(seen, ['admin:hunter2']);
});
