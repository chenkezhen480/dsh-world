import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { consoleSources, estimateTokens } from '../src/console/snapshot.ts';
import { consoleRoute, handleConsole, type ConsoleActions, type ConsoleSources } from '../src/console/routes.ts';
import { PERSONA_LAYERS, type Persona } from '../src/persona.ts';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorldSwitch, DEFAULT_COLD_HOURS, DEFAULT_MEMORY_TURNS } from '../src/worldSwitch.ts';

const sources: ConsoleSources = {
  snapshot: async () => ({ worldId: 'jingjing' }),
  activity: (day, outsideOnly) => [{ day, outsideOnly }],
  diary: date => date === '2026-10-23' ? '他去上班了。' : undefined,
};
function fakeActions() {
  const calls: string[] = [];
  const persona = Object.fromEntries(PERSONA_LAYERS.map(layer => [layer, ''])) as Persona;
  const actions: ConsoleActions = {
    start: async () => { calls.push('start'); }, stop: async () => { calls.push('stop'); },
    applyHome: () => { calls.push('apply-home'); return undefined; },
    restoreCompactionPreset: async () => { calls.push('restore-compaction-preset'); },
    prompts: () => ({ persona, worldPrompt: { text: 'T', custom: false } }),
    savePersona: layers => { calls.push(`persona:${JSON.stringify(layers)}`); },
    saveWorldPrompt: text => { calls.push(`world:${text}`); },
    setDailyBudget: yuan => { calls.push(`budget:${yuan}`); },
    setMemoryTurns: turns => { calls.push(`memory:${turns}`); },
    setColdHours: hours => { calls.push(`cold:${hours}`); },
    setArchiveScope: scope => { calls.push(`scope:${scope}`); return scope === 'workspace'; },
    setWorkspacePermission: permission => { calls.push(`permission:${permission}`); },
    setCompactAfterReview: on => { calls.push(`compact-after-review:${on}`); },
    setSchedule: next => { calls.push(`schedule:${JSON.stringify(next)}`); },
    setModules: async modules => { calls.push(`modules:${JSON.stringify(modules)}`); return undefined; },
    restartWechatAdapter: async () => { calls.push('adapter-restart'); return true; },
    setWechatSettings: next => { calls.push(`wechat:${JSON.stringify(next)}`); },
  };
  return { actions, calls };
}
const get = (url: string, actions = fakeActions().actions) => handleConsole('/dsh-world/worlds/fish', sources, actions, { method: 'GET', url, write: false });

test('album metadata is paginated and image bytes stay in a same-origin no-store endpoint', async () => {
  const image = { ref: { mediaType: 'image/png' }, data: new Uint8Array([1, 2, 3, 4]) };
  const view = { ...sources, photos: (limit: number, offset: number) => ({ photos: [], total: 0, hasMore: false, limit, offset }), photo: (id: string) => id === 'kept' ? image as never : undefined };
  const request = { method: 'GET', url: '/dsh-world/worlds/fish/console/photos?limit=12&offset=24', write: false };
  assert.deepEqual((await handleConsole('/dsh-world/worlds/fish', view, fakeActions().actions, request)).body, { photos: [], total: 0, hasMore: false, limit: 12, offset: 24 });
  for (const query of ['limit=0', 'limit=101', 'offset=-1']) assert.equal((await handleConsole('/dsh-world/worlds/fish', view, fakeActions().actions, { ...request, url: '/dsh-world/worlds/fish/console/photos?' + query })).status, 400);
  const route = consoleRoute('/dsh-world/worlds/fish', view, fakeActions().actions);
  for (const cross of [false, true]) {
    let status = 0, headers: Record<string, unknown> = {}, bytes: unknown;
    await route.handler({ method: 'GET', url: '/dsh-world/worlds/fish/console/photo?id=kept', headers: { host: 'localhost', ...(cross ? { 'sec-fetch-site': 'cross-site' } : {}) } } as never,
      { writeHead(code: number, value: Record<string, unknown>) { status = code; headers = value; }, end(value: unknown) { bytes = value; } } as never);
    assert.equal(status, cross ? 403 : 200);
    if (!cross) { assert.equal(headers['content-type'], 'image/png'); assert.equal(headers['cache-control'], 'no-store'); assert.deepEqual(bytes, image.data); }
  }
});

test('QQ dependency preparation can report a successful installation requiring restart', async () => {
  const reply = await handleConsole('/dsh-world/worlds/fish', sources, { ...fakeActions().actions, setModules: async () => ({ restartRequired: true, message: 'SDK 已安装，请重启 DSH' }) }, { method: 'POST', url: '/dsh-world/worlds/fish/console/modules', write: true, body: { qq: true } });
  assert.equal(reply.status, 200); assert.deepEqual(reply.body, { ok: true, restartRequired: true, message: 'SDK 已安装，请重启 DSH' });
});

test('applying home prompts requires the write header and reports an unavailable home or compaction service', async () => {
  const { actions, calls } = fakeActions();
  const request = { method: 'POST', url: '/dsh-world/worlds/fish/console/apply-home', headers: { 'x-dsh-world': '1', 'content-type': 'application/json' }, body: '{}' };
  for (const headers of [{ 'content-type': 'application/json' }, { ...request.headers, 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await run(sources, { ...request, headers }, actions)).status, 403);
  }
  assert.deepEqual(calls, []);
  assert.equal((await run(sources, request, actions)).status, 200);
  assert.deepEqual(calls, ['apply-home']);
  const refused = await run(sources, request, { ...actions, applyHome: () => '请先启动世界生活线' });
  assert.equal(refused.status, 400); assert.equal(JSON.parse(refused.body!).error, '请先启动世界生活线');
});

test('console reads are JSON views', async () => {
  assert.deepEqual(await get('/dsh-world/worlds/fish/console/snapshot'), { status: 200, body: { worldId: 'jingjing' } });
  assert.deepEqual(await get('/dsh-world/worlds/fish/console/activity?day=2026-10-23&outside=1'), { status: 200, body: [{ day: '2026-10-23', outsideOnly: true }] });
  assert.equal((await get('/dsh-world/worlds/fish/console/diary')).status, 404);
  assert.deepEqual(await get('/dsh-world/worlds/fish/console/diary?date=2026-10-23'), { status: 200, body: { date: '2026-10-23', text: '他去上班了。' } });
  assert.equal((await get('/dsh-world/worlds/fish/console/diary?date=../x')).status, 404);
  assert.equal(((await get('/dsh-world/worlds/fish/console/prompts')).body as { worldPrompt: { text: string } }).worldPrompt.text, 'T');
  for (const url of ['/dsh-world/worlds/fish/console/nope', '/dsh-world/worlds/fishX/console/snapshot', '/other']) assert.equal((await get(url)).status, 404, url);
});

test('archive scope exposes only home and workspace and returns restart status', async () => {
  const { actions, calls } = fakeActions();
  const post = (scope: unknown) => handleConsole('/dsh-world/worlds/fish', sources, actions, { method: 'POST', url: '/dsh-world/worlds/fish/console/archive-scope', write: true, body: { scope } });
  assert.deepEqual(await post('workspace'), { status: 200, body: { ok: true, restartRequired: true } });
  assert.deepEqual(await post('home'), { status: 200, body: { ok: true, restartRequired: false } });
  for (const scope of ['all', 'world', '', null, undefined]) assert.equal((await post(scope)).status, 400);
  assert.deepEqual(calls, ['scope:workspace', 'scope:home']);
});

test('the compact-after-review switch is a boolean write that survives a restart and is on until turned off', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dw-compact-review-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { actions, calls } = fakeActions();
  const post = (on: unknown) => handleConsole('/dsh-world/worlds/fish', sources, actions, { method: 'POST', url: '/dsh-world/worlds/fish/console/compact-after-review', write: true, body: { on } });
  assert.equal((await post(true)).status, 200); assert.equal((await post(false)).status, 200);
  for (const bad of ['true', 1, null, undefined]) assert.equal((await post(bad)).status, 400, String(bad));
  assert.deepEqual(calls, ['compact-after-review:true', 'compact-after-review:false']);
  const power = createWorldSwitch(dir);
  assert.equal(power.compactAfterReview(), true, 'on for a world that never said otherwise');
  power.setCompactAfterReview(false);
  assert.equal(createWorldSwitch(dir).compactAfterReview(), false);
  assert.equal(JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8')).compactAfterReview, false);
  power.setCompactAfterReview(true);
  assert.equal(createWorldSwitch(dir).compactAfterReview(), true);
  assert.ok(!('compactAfterReview' in JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8'))), 'on is the absence of the key');
});

test('the review and morning times are HH:MM writes that survive a restart; empty goes back to 23:00 and the configured morning', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dw-schedule-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { actions, calls } = fakeActions();
  const post = (body: Record<string, unknown>) => handleConsole('/dsh-world/worlds/fish', sources, actions, { method: 'POST', url: '/dsh-world/worlds/fish/console/schedule', write: true, body });
  assert.equal((await post({ review: '00:30', wake: '07:15' })).status, 200);
  assert.equal((await post({ wake: null })).status, 200);
  for (const bad of [{}, { review: '24:00' }, { review: '9:00' }, { wake: '07:60' }, { wake: 730 }, { review: '' }]) assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
  assert.deepEqual(calls, ['schedule:{"review":"00:30","wake":"07:15"}', 'schedule:{"wake":null}']);
  const power = createWorldSwitch(dir, 'workspace', '08:00');
  assert.deepEqual([power.reviewTime(), power.wakeTime()], ['23:00', '08:00'], 'a world that never set them keeps 23:00 and the configured morning');
  power.setSchedule({ review: '00:30', wake: '07:15' });
  const again = createWorldSwitch(dir, 'workspace', '08:00');
  assert.deepEqual([again.reviewTime(), again.wakeTime()], ['00:30', '07:15']);
  again.setSchedule({ wake: null });
  assert.deepEqual([again.reviewTime(), again.wakeTime()], ['00:30', '08:00'], 'a field left out stays');
  again.setSchedule({ review: '23:00' });
  const stored = JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8'));
  assert.ok(!('reviewTime' in stored) && !('wakeTime' in stored), 'the defaults are the absence of the keys');
});

test('workspace permission writes accept the host catalog and reject invalid or unauthorized requests without changing settings', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dw-permission-route-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const power = createWorldSwitch(dir);
  power.setWorkspacePermission('danger-full-access');
  let attempted = 0;
  const actions = { ...fakeActions().actions, setWorkspacePermission(permission: string) {
    attempted++;
    if (!['danger-full-access', 'custom-read-only'].includes(permission)) throw new Error(`未知工作区权限：${permission}`);
    power.setWorkspacePermission(permission);
  } };
  const request = { method: 'POST', url: '/dsh-world/worlds/fish/console/workspace-permission', headers: { 'x-dsh-world': '1', 'content-type': 'application/json' }, body: JSON.stringify({ permission: 'custom-read-only' }) };
  for (const headers of [{ 'content-type': 'application/json' }, { ...request.headers, 'content-type': 'text/plain' }, { ...request.headers, 'sec-fetch-site': 'cross-site' }, { ...request.headers, host: 'rebind.example' }]) {
    assert.equal((await run(sources, { ...request, headers }, actions)).status, 403);
  }
  assert.equal(attempted, 0);
  for (const permission of [null, undefined, false, 1, {}, [], '', '  ']) {
    assert.equal((await run(sources, { ...request, body: JSON.stringify({ permission }) }, actions)).status, 400);
  }
  assert.equal(attempted, 0, 'malformed permissions never reach the host action');
  const unknown = await run(sources, { ...request, body: JSON.stringify({ permission: 'unknown' }) }, actions);
  assert.equal(unknown.status, 400);
  assert.deepEqual(JSON.parse(unknown.body!), { error: '未知工作区权限：unknown' });
  assert.equal(createWorldSwitch(dir).workspacePermission(), 'danger-full-access');
  const saved = await run(sources, request, actions);
  assert.equal(saved.status, 200); assert.deepEqual(JSON.parse(saved.body!), { ok: true });
  assert.equal(createWorldSwitch(dir).workspacePermission(), 'custom-read-only');
});

test('workspace permission defaults to the existing home permission, persists and preserves state when the atomic write fails', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dw-permission-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const power = createWorldSwitch(dir);
  assert.equal(power.workspacePermission(), 'danger-full-access');
  power.setMemoryTurns(60);
  power.setWorkspacePermission('custom-read-only');
  assert.equal(power.workspacePermission(), 'custom-read-only');
  assert.equal(createWorldSwitch(dir).workspacePermission(), 'custom-read-only');
  assert.equal(createWorldSwitch(dir).memoryTurns(), 60);
  const file = join(dir, 'world.json'), before = readFileSync(file, 'utf8');
  for (const permission of [undefined, null, 1, {}, '', '  ']) {
    assert.throws(() => power.setWorkspacePermission(permission as never), /非空字符串/);
    assert.equal(readFileSync(file, 'utf8'), before);
  }
  mkdirSync(`${file}.${process.pid}.tmp`);
  assert.throws(() => power.setWorkspacePermission('workspace-write'));
  assert.equal(power.workspacePermission(), 'custom-read-only');
  assert.equal(readFileSync(file, 'utf8'), before, 'the prior settings survive an unsuccessful replacement');
  for (const permission of [null, 3, '', '  ']) {
    writeFileSync(file, JSON.stringify({ running: false, workspacePermission: permission }));
    assert.equal(createWorldSwitch(dir).workspacePermission(), 'danger-full-access');
  }
});
test('the console can restart the plugin-managed adapter, and says so when there is none', async () => {
  const { actions, calls } = fakeActions();
  const post = (a: ConsoleActions) => handleConsole('/dsh-world/worlds/fish', sources, a, { method: 'POST', url: '/dsh-world/worlds/fish/console/wechat-adapter', write: true, body: {} });
  assert.equal((await post(actions)).status, 200);
  assert.deepEqual(calls, ['adapter-restart']);
  assert.equal((await post({ ...actions, restartWechatAdapter: async () => false })).status, 400);
  assert.equal((await handleConsole('/dsh-world/worlds/fish', sources, actions, { method: 'POST', url: '/dsh-world/worlds/fish/console/wechat-adapter', write: false, body: {} })).status, 403);
});
test('the module switches take booleans, say what they change, and report why a module cannot be switched', async () => {
  const { actions, calls } = fakeActions();
  const post = (body: Record<string, unknown>, a: ConsoleActions = actions) => handleConsole('/dsh-world/worlds/fish', sources, a, { method: 'POST', url: '/dsh-world/worlds/fish/console/modules', write: true, body });
  assert.equal((await post({ wechat: false })).status, 200);
  assert.equal((await post({ wechat: true, qq: false })).status, 200);
  for (const body of [{}, { wechat: 'yes' }, { qq: 1 }]) assert.equal((await post(body)).status, 400, JSON.stringify(body));
  assert.deepEqual(calls, ['modules:{"wechat":false}', 'modules:{"wechat":true,"qq":false}']);
  const refused = await post({ qq: true }, { ...actions, setModules: async () => '没有配置 QQ 桥目录' });
  assert.deepEqual(refused, { status: 400, body: { error: '没有配置 QQ 桥目录' } });
});
test('wechat settings validate their range and keep omitted fields', async () => {
  const { actions, calls } = fakeActions();
  const post = (body: Record<string, unknown>) => handleConsole('/dsh-world/worlds/fish', sources, actions, { method: 'POST', url: '/dsh-world/worlds/fish/console/wechat', write: true, body });
  assert.equal((await post({ contextMessages: 12, bufferSeconds: 1.5 })).status, 200);
  assert.equal((await post({ contextMessages: null })).status, 200);
  for (const body of [{}, { contextMessages: 0 }, { contextMessages: 21 }, { contextMessages: 2.5 }, { bufferSeconds: -1 }, { bufferSeconds: 31 }, { bufferSeconds: '3' }]) assert.equal((await post(body)).status, 400, JSON.stringify(body));
  assert.deepEqual(calls, ['wechat:{"context":12,"bufferSeconds":1.5}', 'wechat:{"context":null}']);
});
test('WeChat and QQ both start off in a new world; a world that already ran WeChat keeps it on; an explicit choice is written and survives a restart', t => {
  const fresh = mkdtempSync(join(tmpdir(), 'dsh-world-modules-')); t.after(() => rmSync(fresh, { recursive: true, force: true }));
  assert.deepEqual([createWorldSwitch(fresh).wechatEnabled(), createWorldSwitch(fresh).qqEnabled()], [false, false], 'nothing is on until someone turns it on');

  // A world from before the switch defaulted to off: it never stored a choice, but its WeChat module has run.
  const used = mkdtempSync(join(tmpdir(), 'dsh-world-modules-')); t.after(() => rmSync(used, { recursive: true, force: true }));
  writeFileSync(join(used, 'wechat-outbox.sqlite'), '');
  const power = createWorldSwitch(used);
  assert.deepEqual([power.wechatEnabled(), power.qqEnabled()], [true, false], 'an upgrade does not switch off a WeChat that was in use');
  power.setModules({ wechat: false });
  assert.deepEqual([createWorldSwitch(used).wechatEnabled(), createWorldSwitch(used).qqEnabled()], [false, false], 'turning it off sticks although the module has run before');
  power.setModules({ qq: true });
  assert.deepEqual([createWorldSwitch(used).wechatEnabled(), createWorldSwitch(used).qqEnabled()], [false, true], 'a switch left out keeps its value');
  power.setModules({ wechat: true });
  assert.deepEqual(JSON.parse(readFileSync(join(used, 'world.json'), 'utf8')), { running: false, wechatEnabled: true, qqEnabled: true });
  power.setModules({ qq: false });
  assert.deepEqual(JSON.parse(readFileSync(join(used, 'world.json'), 'utf8')), { running: false, wechatEnabled: true });
});
test('wechat settings default to 8 and 3, persist, and return to default', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-world-wechat-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const power = createWorldSwitch(dir);
  assert.deepEqual([power.wechatContext(), power.wechatBufferSeconds()], [5, 3]);
  power.setWechat({ context: 12, bufferSeconds: 0 });
  const again = createWorldSwitch(dir);
  assert.deepEqual([again.wechatContext(), again.wechatBufferSeconds()], [12, 0]);
  again.setWechat({ context: null });
  assert.deepEqual([createWorldSwitch(dir).wechatContext(), createWorldSwitch(dir).wechatBufferSeconds()], [5, 0]);
  again.setWechat({ bufferSeconds: 3 });
  assert.equal('wechatBufferSeconds' in JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8')), false);
});
test('console writes need the write mark, and change only what they name', async () => {
  const { actions, calls } = fakeActions();
  const post = (url: string, body?: Record<string, unknown>, write = true) => handleConsole('/dsh-world/worlds/fish', sources, actions, { method: 'POST', url, write, body });
  assert.equal((await post('/dsh-world/worlds/fish/console/start', {}, false)).status, 403);
  assert.deepEqual(calls, []);
  assert.equal((await post('/dsh-world/worlds/fish/console/start', {})).status, 200);
  assert.equal((await post('/dsh-world/worlds/fish/console/stop', {})).status, 200);
  assert.equal((await post('/dsh-world/worlds/fish/console/persona', { 名字: '小鱼', 性格: '嘴硬' })).status, 200);
  assert.equal((await post('/dsh-world/worlds/fish/console/persona', { 名字: 3 })).status, 400);
  assert.equal((await post('/dsh-world/worlds/fish/console/persona', { 年龄: '3' })).status, 400, 'only known layers');
  assert.equal((await post('/dsh-world/worlds/fish/console/world-prompt', { text: '我的模板' })).status, 200);
  assert.equal((await post('/dsh-world/worlds/fish/console/world-prompt', {})).status, 400);
  assert.equal((await post('/dsh-world/worlds/fish/console/budget', { daily: 5 })).status, 200);
  assert.equal((await post('/dsh-world/worlds/fish/console/budget', { daily: null })).status, 200);
  for (const daily of [-1, '5', undefined]) assert.equal((await post('/dsh-world/worlds/fish/console/budget', { daily })).status, 400, String(daily));
  assert.equal((await post('/dsh-world/worlds/fish/console/memory', { turns: 60 })).status, 200);
  assert.equal((await post('/dsh-world/worlds/fish/console/memory', { turns: null })).status, 200);
  for (const turns of [0, 1.5, '60', undefined]) assert.equal((await post('/dsh-world/worlds/fish/console/memory', { turns })).status, 400, String(turns));
  assert.equal((await post('/dsh-world/worlds/fish/console/memory', { coldHours: 12 })).status, 200);
  assert.equal((await post('/dsh-world/worlds/fish/console/memory', { coldHours: null })).status, 200);
  for (const coldHours of [0, 721, 1.5, '12']) assert.equal((await post('/dsh-world/worlds/fish/console/memory', { coldHours })).status, 400, String(coldHours));
  assert.equal((await post('/dsh-world/worlds/fish/console/nope', {})).status, 404);
  assert.deepEqual(calls, ['start', 'stop', 'persona:{"名字":"小鱼","性格":"嘴硬"}', 'world:我的模板', 'budget:5', 'budget:undefined', 'memory:60', 'memory:undefined', 'cold:12', 'cold:undefined']);
  const del = await handleConsole('/dsh-world/worlds/fish', sources, actions, { method: 'DELETE', url: '/dsh-world/worlds/fish/console/snapshot', write: false });
  assert.equal(del.status, 405); assert.equal(del.headers?.allow, 'GET, POST');
});
test('token estimate weights CJK characters and fullwidth forms separately', () => {
  assert.equal(estimateTokens('鲸鲸鲸鲸鲸'), 3);
  assert.equal(estimateTokens('abcdefg'), 2);
  assert.equal(estimateTokens('，。'), estimateTokens('鲸鲸'));
});

function fakeRes() {
  const out: { status?: number; headers?: Record<string, string>; body?: string } = {};
  return { out, res: { writeHead: (status: number, headers: Record<string, string>) => { out.status = status; out.headers = headers; }, end: (body: string) => { out.body = body; } } as never };
}
async function run(src: ConsoleSources, req: { method?: string; url?: string; headers?: Record<string, string>; body?: string }, actions = fakeActions().actions) {
  const { out, res } = fakeRes();
  const stream = Object.assign(Readable.from(req.body === undefined ? [] : [Buffer.from(req.body)]), { method: req.method ?? 'GET', url: req.url ?? '/', headers: { host: 'localhost:3080', ...req.headers } });
  await consoleRoute('/dsh-world/worlds/fish', src, actions).handler(stream as never, res);
  return out;
}
test('consoleRoute sets JSON, no-store and no CORS headers', async () => {
  const out = await run(sources, { url: '/dsh-world/worlds/fish/console/snapshot' });
  assert.equal(out.status, 200);
  assert.equal(out.headers!['content-type'], 'application/json; charset=utf-8');
  assert.equal(out.headers!['cache-control'], 'no-store');
  assert.ok(!Object.keys(out.headers!).some(k => k.toLowerCase() === 'access-control-allow-origin'));
  assert.deepEqual(JSON.parse(out.body!), { worldId: 'jingjing' });
});
test('consoleRoute rejects cross-site requests, and writes without the header or a JSON body', async () => {
  const { actions, calls } = fakeActions();
  assert.equal((await run(sources, { url: '/dsh-world/worlds/fish/console/snapshot', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await run(sources, { url: '/dsh-world/worlds/fish/console/snapshot', headers: { host: 'rebind.example' } })).status, 403, 'DNS rebinding: same-origin to the browser, another name');
  for (const host of ['127.0.0.1:3080', 'LOCALHOST', '[::1]:3080']) assert.equal((await run(sources, { url: '/dsh-world/worlds/fish/console/snapshot', headers: { host } })).status, 200, host);
  const { out, res } = fakeRes();
  await consoleRoute('/dsh-world/worlds/fish', sources, fakeActions().actions, ['dsh.lan']).handler(Object.assign(Readable.from([]), { method: 'GET', url: '/dsh-world/worlds/fish/console/snapshot', headers: { host: 'DSH.lan:8443' } }) as never, res);
  assert.equal(out.status, 200, 'a name listed in allowedHosts, behind a proxy');
  const write = { 'x-dsh-world': '1', 'content-type': 'application/json' };
  assert.equal((await run(sources, { method: 'POST', url: '/dsh-world/worlds/fish/console/start', headers: { 'content-type': 'application/json' }, body: '{}' }, actions)).status, 403, 'no write header');
  assert.equal((await run(sources, { method: 'POST', url: '/dsh-world/worlds/fish/console/start', headers: { 'x-dsh-world': '1', 'content-type': 'text/plain' }, body: '{}' }, actions)).status, 403, 'a form post');
  assert.equal((await run(sources, { method: 'POST', url: '/dsh-world/worlds/fish/console/start', headers: { ...write, 'sec-fetch-site': 'cross-site' }, body: '{}' }, actions)).status, 403);
  assert.equal((await run(sources, { method: 'POST', url: '/dsh-world/worlds/fish/console/start', headers: write, body: '[]' }, actions)).status, 400);
  assert.deepEqual(calls, []);
  assert.equal((await run(sources, { method: 'POST', url: '/dsh-world/worlds/fish/console/start', headers: write, body: '{}' }, actions)).status, 200);
  assert.deepEqual(calls, ['start']);
});
test('consoleRoute hides errors behind a generic 500', async () => {
  const out = await run({ ...sources, snapshot: async () => { throw new Error('secret C:\\path'); } }, { url: '/dsh-world/worlds/fish/console/snapshot' });
  assert.equal(out.status, 500);
  assert.deepEqual(JSON.parse(out.body!), { error: 'internal error' });
  const failing = { ...fakeActions().actions, start: async () => { throw new Error('boom'); } };
  assert.equal((await run(sources, { method: 'POST', url: '/dsh-world/worlds/fish/console/start', headers: { 'x-dsh-world': '1', 'content-type': 'application/json' }, body: '{}' }, failing)).body, '{"error":"internal error"}');
});
test('the snapshot is cached and shared between concurrent polls until invalidated, and has the same shape while stopped', async () => {
  let computed = 0; let running = true;
  const life = { snapshot: () => { computed++; return { homeSessionId: undefined, alarm: undefined, review: undefined, faults: [] }; } };
  const archive = { readPage: async () => ({ records: [], nextCursor: undefined }), readTurn: async () => [], stats: () => ({ records: 0, sessions: 0 }) };
  const src = consoleSources({
    ctx: { agents: { get: () => undefined } } as never, config: { worldId: 'w', timeZone: 'UTC' } as never, archive: archive as never,
    names: () => ({ companion: '小鱼', partner: '伙伴' }), life: () => running ? life as never : undefined, diaryDir: 'Z:/no/such/dir', running: () => running, dailyBudget: () => 3, memoryTurns: () => 50, faults: () => ['桥坏了'],
  });
  const [a, b] = await Promise.all([src.snapshot(), src.snapshot()]);
  await src.snapshot();
  assert.equal(computed, 1); assert.equal(a, b);
  assert.deepEqual((a as { running: boolean; name: string; health: string[] }), { ...(a as object), running: true, name: '小鱼', health: ['桥坏了'] });
  running = false; src.invalidate();
  const stopped = await src.snapshot() as { running: boolean; life: unknown; memory: { windowTurns: number } };
  assert.equal(stopped.running, false); assert.equal(stopped.life, null); assert.equal(stopped.memory.windowTurns, 50);
  assert.deepEqual((stopped as unknown as { budget: unknown }).budget, { daily: 3, today: null });
  assert.equal((stopped as unknown as { workspace: unknown }).workspace, null);
});

test('snapshot workspace permissions follow the host catalog and refresh after invalidation', async () => {
  let defaultPermission = 'custom-read-only';
  const src = consoleSources({
    ctx: { agents: { get: () => undefined } } as never, config: { worldId: 'w', timeZone: 'UTC' } as never,
    archive: { readPage: async () => ({ records: [], nextCursor: undefined }), readTurn: async () => [], stats: () => ({ records: 0, sessions: 0 }) } as never,
    names: () => ({ companion: '小鱼', partner: '伙伴' }), life: () => undefined, diaryDir: 'Z:/no/such/dir', running: () => false,
    dailyBudget: () => undefined, memoryTurns: () => 200, faults: () => [],
    workspacePermissions: () => ({ defaultPermission, options: [{ value: 'custom-read-only', name: '自定义只读', description: '读取项目' }, { value: 'workspace-write', name: '工作区写入' }] }),
  });
  assert.deepEqual((await src.snapshot() as { workspace: unknown }).workspace, { defaultPermission: 'custom-read-only', options: [{ value: 'custom-read-only', name: '自定义只读', description: '读取项目' }, { value: 'workspace-write', name: '工作区写入' }] });
  defaultPermission = 'workspace-write'; src.invalidate();
  assert.equal((await src.snapshot() as { workspace: { defaultPermission: string } }).workspace.defaultPermission, 'workspace-write');
});

test('the memory window is kept in world.json, defaults to 200 and survives a restart', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dw-switch-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const power = createWorldSwitch(dir);
  assert.equal(power.memoryTurns(), DEFAULT_MEMORY_TURNS);
  power.setMemoryTurns(60);
  assert.equal(createWorldSwitch(dir).memoryTurns(), 60);
  power.setMemoryTurns(undefined);
  assert.equal(createWorldSwitch(dir).memoryTurns(), 200);
  assert.equal('memoryTurns' in JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8')), false, 'the default is not written out');
});

test('the cold-session hours are kept in world.json, default to 24 and survive a restart (#36)', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dw-switch-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const power = createWorldSwitch(dir);
  assert.equal(power.coldHours(), DEFAULT_COLD_HOURS); assert.equal(DEFAULT_COLD_HOURS, 24);
  power.setColdHours(6);
  assert.equal(createWorldSwitch(dir).coldHours(), 6);
  power.setColdHours(undefined);
  assert.equal(createWorldSwitch(dir).coldHours(), 24);
  assert.equal('coldHours' in JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8')), false, 'the default is not written out');
  writeFileSync(join(dir, 'world.json'), JSON.stringify({ running: true, coldHours: 0 }));
  assert.equal(createWorldSwitch(dir).coldHours(), 24, 'a value out of range in a hand-edited world.json falls back to the default');
});

test('memory lookups reach the console through the same service as the tools: parameters, paging, errors and the health of her files', async t => {
  const { createArchiveStore } = await import('../src/store.ts');
  const { createMemory } = await import('../src/memory.ts');
  const { record } = await import('./fixtures.ts');
  const root = mkdtempSync(join(tmpdir(), 'dw-console-memory-'));
  const store = createArchiveStore({ root, worldId: 'w', timeZone: 'Asia/Seoul', agentPreset: 'companion' });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const diaryDir = join(root, '日记'); mkdirSync(diaryDir);
  writeFileSync(join(diaryDir, '潮汐.md'), '潮汐跟月亮有关');
  const longTerm = createMemory({ store: store.memory, timeZone: 'Asia/Seoul', sources: { diaryDir }, visible: id => id === 'home' });
  await store.commitRecords(['1', '2', '3'].map(n => record(`a${n}`, { sourceSessionId: 'home', turnId: 'home:1', sourceSeq: Number(n), content: `第${n}句 潮汐`, occurredAt: `2026-10-23T12:0${n}:00.000Z` })).concat(record('g1', { sourceSessionId: 'group', content: '群里的潮汐' })));
  const src = consoleSources({
    ctx: { agents: { get: () => undefined } } as never, config: { worldId: 'w', timeZone: 'Asia/Seoul' } as never, archive: store as never, longTerm,
    names: () => ({ companion: '小鱼', partner: '伙伴' }), life: () => undefined, diaryDir: join(root, 'diary'), running: () => false, dailyBudget: () => undefined, memoryTurns: () => 200, faults: () => [],
  });
  const find = (query: string) => handleConsole('/dsh-world/worlds/fish', src, fakeActions().actions, { method: 'GET', url: `/dsh-world/worlds/fish/console/memory/find?${query}`, write: false });
  const first = await find('query=' + encodeURIComponent('潮汐') + '&kinds=conversation,diary&limit=2');
  const page = first.body as { items: { ref: string; sourceId: string; excerpt: string; kind: string }[]; nextCursor: string; coverage: { state: string } };
  assert.equal(first.status, 200); assert.equal(page.items.length, 2); assert.equal(page.coverage.state, 'ready');
  assert.ok(page.items.every(item => item.sourceId !== 'chat:group'), 'the group line is out of scope');
  const second = (await find(`query=${encodeURIComponent('潮汐')}&kinds=conversation,diary&limit=2&cursor=${encodeURIComponent(page.nextCursor)}`)).body as { items: unknown[]; nextCursor?: string };
  assert.equal(second.items.length, 2); assert.equal(second.nextCursor, undefined);
  assert.equal((await find(`query=${encodeURIComponent('潮汐')}&limit=2&cursor=${encodeURIComponent(page.nextCursor)}`)).status, 409, 'a cursor for another query has expired');
  assert.deepEqual((await find('limit=0')).status, 400); assert.equal((await find('limit=abc')).status, 400); assert.equal((await find('from=2026-10-23')).status, 400);
  assert.equal(((await find('limit=0')).body as { code: string }).code, 'invalidQuery');
  assert.equal((await find('turnId=home:1&order=oldest')).status, 200);
  const read = await handleConsole('/dsh-world/worlds/fish', src, fakeActions().actions, { method: 'GET', url: `/dsh-world/worlds/fish/console/memory/read?ref=${encodeURIComponent(page.items[0]!.ref)}&limit=3`, write: false });
  assert.equal(read.status, 200); assert.equal((read.body as { content: string }).content.length > 0, true);
  assert.equal((await handleConsole('/dsh-world/worlds/fish', src, fakeActions().actions, { method: 'GET', url: '/dsh-world/worlds/fish/console/memory/read?ref=junk', write: false })).status, 400);
  assert.equal((await handleConsole('/dsh-world/worlds/fish', src, fakeActions().actions, { method: 'GET', url: '/dsh-world/worlds/fish/console/memory/read?ref=' + encodeURIComponent('m1.' + Buffer.from('["a","diary:nope.md","abc"]').toString('base64url')), write: false })).status, 404);
  assert.equal((await handleConsole('/dsh-world/worlds/fish', sources, fakeActions().actions, { method: 'GET', url: '/dsh-world/worlds/fish/console/memory/find', write: false })).status, 404, 'a console without long-term memory says so');
  assert.equal((await handleConsole('/dsh-world/worlds/fish', src, fakeActions().actions, { method: 'POST', url: '/dsh-world/worlds/fish/console/memory/find', write: true, body: {} })).status, 404, 'lookups are reads only');
  const snapshot = await src.snapshot() as { memory: { index: { state: string; failures: unknown[] } } };
  assert.equal(snapshot.memory.index.state, 'ready'); assert.deepEqual(snapshot.memory.index.failures, []);
});
