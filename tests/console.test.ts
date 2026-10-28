import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { consoleSources, estimateTokens, summarizeCosts } from '../src/console/snapshot.ts';
import { consoleRoute, handleConsole, type ConsoleActions, type ConsoleSources } from '../src/console/routes.ts';
import { PERSONA_LAYERS, type Persona } from '../src/persona.ts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorldSwitch, DEFAULT_MEMORY_TURNS } from '../src/worldSwitch.ts';

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
    prompts: () => ({ persona, worldPrompt: { text: 'T', custom: false } }),
    savePersona: layers => { calls.push(`persona:${JSON.stringify(layers)}`); },
    saveWorldPrompt: text => { calls.push(`world:${text}`); },
    setDailyBudget: yuan => { calls.push(`budget:${yuan}`); },
    setMemoryTurns: turns => { calls.push(`memory:${turns}`); },
    setMemoryTokenBudget: tokens => { calls.push(`memoryTokens:${tokens}`); },
    setArchiveScope: scope => { calls.push(`scope:${scope}`); return scope === 'workspace'; },
    setModules: async modules => { calls.push(`modules:${JSON.stringify(modules)}`); return undefined; },
    restartWechatAdapter: async () => { calls.push('adapter-restart'); return true; },
    setWechatSettings: next => { calls.push(`wechat:${JSON.stringify(next)}`); },
    setRoutineEnabled: enabled => { calls.push(`routine-enabled:${enabled}`); },
    setRoutinePaused: (id, paused) => { calls.push(`routine-paused:${id}:${paused}`); },
    removeRoutine: id => { calls.push(`routine-remove:${id}`); },
  };
  return { actions, calls };
}
const get = (url: string, actions = fakeActions().actions) => handleConsole(sources, actions, { method: 'GET', url, write: false });

test('console reads are JSON views', async () => {
  assert.deepEqual(await get('/dsh-world/console/snapshot'), { status: 200, body: { worldId: 'jingjing' } });
  assert.deepEqual(await get('/dsh-world/console/activity?day=2026-10-23&outside=1'), { status: 200, body: [{ day: '2026-10-23', outsideOnly: true }] });
  assert.equal((await get('/dsh-world/console/diary')).status, 404);
  assert.deepEqual(await get('/dsh-world/console/diary?date=2026-10-23'), { status: 200, body: { date: '2026-10-23', text: '他去上班了。' } });
  assert.equal((await get('/dsh-world/console/diary?date=../x')).status, 404);
  assert.equal(((await get('/dsh-world/console/prompts')).body as { worldPrompt: { text: string } }).worldPrompt.text, 'T');
  for (const url of ['/dsh-world/console/nope', '/dsh-worldX/console/snapshot', '/other']) assert.equal((await get(url)).status, 404, url);
});

test('archive scope exposes only home and workspace and returns restart status', async () => {
  const { actions, calls } = fakeActions();
  const post = (scope: unknown) => handleConsole(sources, actions, { method: 'POST', url: '/dsh-world/console/archive-scope', write: true, body: { scope } });
  assert.deepEqual(await post('workspace'), { status: 200, body: { ok: true, restartRequired: true } });
  assert.deepEqual(await post('home'), { status: 200, body: { ok: true, restartRequired: false } });
  for (const scope of ['all', 'world', '', null, undefined]) assert.equal((await post(scope)).status, 400);
  assert.deepEqual(calls, ['scope:workspace', 'scope:home']);
});
test('the console can restart the plugin-managed adapter, and says so when there is none', async () => {
  const { actions, calls } = fakeActions();
  const post = (a: ConsoleActions) => handleConsole(sources, a, { method: 'POST', url: '/dsh-world/console/wechat-adapter', write: true, body: {} });
  assert.equal((await post(actions)).status, 200);
  assert.deepEqual(calls, ['adapter-restart']);
  assert.equal((await post({ ...actions, restartWechatAdapter: async () => false })).status, 400);
  assert.equal((await handleConsole(sources, actions, { method: 'POST', url: '/dsh-world/console/wechat-adapter', write: false, body: {} })).status, 403);
});
test('the module switches take booleans, say what they change, and report why a module cannot be switched', async () => {
  const { actions, calls } = fakeActions();
  const post = (body: Record<string, unknown>, a: ConsoleActions = actions) => handleConsole(sources, a, { method: 'POST', url: '/dsh-world/console/modules', write: true, body });
  assert.equal((await post({ wechat: false })).status, 200);
  assert.equal((await post({ wechat: true, qq: false })).status, 200);
  for (const body of [{}, { wechat: 'yes' }, { qq: 1 }]) assert.equal((await post(body)).status, 400, JSON.stringify(body));
  assert.deepEqual(calls, ['modules:{"wechat":false}', 'modules:{"wechat":true,"qq":false}']);
  const refused = await post({ qq: true }, { ...actions, setModules: async () => '没有配置 QQ 桥目录' });
  assert.deepEqual(refused, { status: 400, body: { error: '没有配置 QQ 桥目录' } });
});
test('wechat settings validate their range and keep omitted fields', async () => {
  const { actions, calls } = fakeActions();
  const post = (body: Record<string, unknown>) => handleConsole(sources, actions, { method: 'POST', url: '/dsh-world/console/wechat', write: true, body });
  assert.equal((await post({ contextMessages: 12, bufferSeconds: 1.5 })).status, 200);
  assert.equal((await post({ contextMessages: null })).status, 200);
  for (const body of [{}, { contextMessages: 0 }, { contextMessages: 21 }, { contextMessages: 2.5 }, { bufferSeconds: -1 }, { bufferSeconds: 31 }, { bufferSeconds: '3' }]) assert.equal((await post(body)).status, 400, JSON.stringify(body));
  assert.deepEqual(calls, ['wechat:{"context":12,"bufferSeconds":1.5}', 'wechat:{"context":null}']);
});
test('the module switches default to on, only an off switch is written, and it survives a restart', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-world-modules-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const power = createWorldSwitch(dir);
  assert.deepEqual([power.wechatEnabled(), power.qqEnabled()], [true, true]);
  power.setModules({ wechat: false });
  assert.deepEqual([createWorldSwitch(dir).wechatEnabled(), createWorldSwitch(dir).qqEnabled()], [false, true]);
  power.setModules({ qq: false });
  assert.deepEqual([createWorldSwitch(dir).wechatEnabled(), createWorldSwitch(dir).qqEnabled()], [false, false], 'a switch left out keeps its value');
  power.setModules({ wechat: true, qq: true });
  const stored = JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8'));
  assert.equal('wechatEnabled' in stored || 'qqEnabled' in stored, false);
});
test('wechat settings default to 8 and 3, persist, and return to default', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-world-wechat-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const power = createWorldSwitch(dir);
  assert.deepEqual([power.wechatContext(), power.wechatBufferSeconds()], [8, 3]);
  power.setWechat({ context: 12, bufferSeconds: 0 });
  const again = createWorldSwitch(dir);
  assert.deepEqual([again.wechatContext(), again.wechatBufferSeconds()], [12, 0]);
  again.setWechat({ context: null });
  assert.deepEqual([createWorldSwitch(dir).wechatContext(), createWorldSwitch(dir).wechatBufferSeconds()], [8, 0]);
  again.setWechat({ bufferSeconds: 3 });
  assert.equal('wechatBufferSeconds' in JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8')), false);
});
test('console writes need the write mark, and change only what they name', async () => {
  const { actions, calls } = fakeActions();
  const post = (url: string, body?: Record<string, unknown>, write = true) => handleConsole(sources, actions, { method: 'POST', url, write, body });
  assert.equal((await post('/dsh-world/console/start', {}, false)).status, 403);
  assert.deepEqual(calls, []);
  assert.equal((await post('/dsh-world/console/start', {})).status, 200);
  assert.equal((await post('/dsh-world/console/stop', {})).status, 200);
  assert.equal((await post('/dsh-world/console/persona', { 名字: '小鱼', 性格: '嘴硬' })).status, 200);
  assert.equal((await post('/dsh-world/console/persona', { 名字: 3 })).status, 400);
  assert.equal((await post('/dsh-world/console/persona', { 年龄: '3' })).status, 400, 'only known layers');
  assert.equal((await post('/dsh-world/console/world-prompt', { text: '我的模板' })).status, 200);
  assert.equal((await post('/dsh-world/console/world-prompt', {})).status, 400);
  assert.equal((await post('/dsh-world/console/budget', { daily: 5 })).status, 200);
  assert.equal((await post('/dsh-world/console/budget', { daily: null })).status, 200);
  for (const daily of [-1, '5', undefined]) assert.equal((await post('/dsh-world/console/budget', { daily })).status, 400, String(daily));
  assert.equal((await post('/dsh-world/console/memory', { turns: 60 })).status, 200);
  assert.equal((await post('/dsh-world/console/memory', { turns: null })).status, 200);
  assert.equal((await post('/dsh-world/console/memory', { tokenBudget: 12000 })).status, 200);
  assert.equal((await post('/dsh-world/console/memory', { tokenBudget: null })).status, 200);
  assert.equal((await post('/dsh-world/console/memory', { turns: 80, tokenBudget: 9000 })).status, 200);
  for (const turns of [0, 1.5, '60']) assert.equal((await post('/dsh-world/console/memory', { turns })).status, 400, String(turns));
  for (const tokenBudget of [0, 1.5, '6000', 200001]) assert.equal((await post('/dsh-world/console/memory', { tokenBudget })).status, 400, String(tokenBudget));
  assert.equal((await post('/dsh-world/console/memory', {})).status, 400);
  assert.equal((await post('/dsh-world/console/nope', {})).status, 404);
  assert.deepEqual(calls, ['start', 'stop', 'persona:{"名字":"小鱼","性格":"嘴硬"}', 'world:我的模板', 'budget:5', 'budget:undefined', 'memory:60', 'memory:undefined', 'memoryTokens:12000', 'memoryTokens:undefined', 'memory:80', 'memoryTokens:9000']);
  const del = await handleConsole(sources, actions, { method: 'DELETE', url: '/dsh-world/console/snapshot', write: false });
  assert.equal(del.status, 405); assert.equal(del.headers?.allow, 'GET, POST');
});
test('token estimate weights CJK characters and fullwidth forms separately', () => {
  assert.equal(estimateTokens('鲸鲸鲸鲸鲸'), 3);
  assert.equal(estimateTokens('abcdefg'), 2);
  assert.equal(estimateTokens('，。'), estimateTokens('鲸鲸'));
});
test('cost summary is a local estimate for today, grouped by model and session', () => {
  const base = { occurredAt: '2026-10-23T01:00:00.000Z', day: '2026-10-23', worldId: 'fish', inputTokens: 10, cacheReadTokens: 2, outputTokens: 3, yuan: 0.001, source: 'home' };
  const summary = summarizeCosts([
    { ...base, sessionId: 'home-a', model: 'deepseek-flash' },
    { ...base, occurredAt: '2026-10-23T02:00:00.000Z', sessionId: 'home-b', model: 'deepseek-flash', yuan: 0.002 },
    { ...base, day: '2026-10-22', sessionId: 'home-a', model: 'deepseek-v4-pro', yuan: 9 },
  ], '2026-10-23');
  assert.equal(summary.estimated, true);
  assert.equal(summary.note, '本地估算，不是供应商账单原值');
  assert.deepEqual(summary.today, { yuan: 0.003, records: 2, inputTokens: 20, cacheReadTokens: 4, outputTokens: 6 });
  assert.deepEqual(summary.byModel.map(item => [item.key, item.yuan]), [['deepseek-flash', 0.003]]);
  assert.deepEqual(summary.bySession.map(item => [item.key, item.yuan]), [['home-b', 0.002], ['home-a', 0.001]]);
});

function fakeRes() {
  const out: { status?: number; headers?: Record<string, string>; body?: string } = {};
  return { out, res: { writeHead: (status: number, headers: Record<string, string>) => { out.status = status; out.headers = headers; }, end: (body: string) => { out.body = body; } } as never };
}
async function run(src: ConsoleSources, req: { method?: string; url?: string; headers?: Record<string, string>; body?: string }, actions = fakeActions().actions) {
  const { out, res } = fakeRes();
  const stream = Object.assign(Readable.from(req.body === undefined ? [] : [Buffer.from(req.body)]), { method: req.method ?? 'GET', url: req.url ?? '/', headers: { host: 'localhost:3080', ...req.headers } });
  await consoleRoute(src, actions).handler(stream as never, res);
  return out;
}
test('consoleRoute sets JSON, no-store and no CORS headers', async () => {
  const out = await run(sources, { url: '/dsh-world/console/snapshot' });
  assert.equal(out.status, 200);
  assert.equal(out.headers!['content-type'], 'application/json; charset=utf-8');
  assert.equal(out.headers!['cache-control'], 'no-store');
  assert.ok(!Object.keys(out.headers!).some(k => k.toLowerCase() === 'access-control-allow-origin'));
  assert.deepEqual(JSON.parse(out.body!), { worldId: 'jingjing' });
});
test('consoleRoute rejects cross-site requests, and writes without the header or a JSON body', async () => {
  const { actions, calls } = fakeActions();
  assert.equal((await run(sources, { url: '/dsh-world/console/snapshot', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await run(sources, { url: '/dsh-world/console/snapshot', headers: { host: 'rebind.example' } })).status, 403, 'DNS rebinding: same-origin to the browser, another name');
  for (const host of ['127.0.0.1:3080', 'LOCALHOST', '[::1]:3080']) assert.equal((await run(sources, { url: '/dsh-world/console/snapshot', headers: { host } })).status, 200, host);
  const { out, res } = fakeRes();
  await consoleRoute(sources, fakeActions().actions, ['dsh.lan']).handler(Object.assign(Readable.from([]), { method: 'GET', url: '/dsh-world/console/snapshot', headers: { host: 'DSH.lan:8443' } }) as never, res);
  assert.equal(out.status, 200, 'a name listed in allowedHosts, behind a proxy');
  const write = { 'x-dsh-world': '1', 'content-type': 'application/json' };
  assert.equal((await run(sources, { method: 'POST', url: '/dsh-world/console/start', headers: { 'content-type': 'application/json' }, body: '{}' }, actions)).status, 403, 'no write header');
  assert.equal((await run(sources, { method: 'POST', url: '/dsh-world/console/start', headers: { 'x-dsh-world': '1', 'content-type': 'text/plain' }, body: '{}' }, actions)).status, 403, 'a form post');
  assert.equal((await run(sources, { method: 'POST', url: '/dsh-world/console/start', headers: { ...write, 'sec-fetch-site': 'cross-site' }, body: '{}' }, actions)).status, 403);
  assert.equal((await run(sources, { method: 'POST', url: '/dsh-world/console/start', headers: write, body: '[]' }, actions)).status, 400);
  assert.deepEqual(calls, []);
  assert.equal((await run(sources, { method: 'POST', url: '/dsh-world/console/start', headers: write, body: '{}' }, actions)).status, 200);
  assert.deepEqual(calls, ['start']);
});
test('consoleRoute hides errors behind a generic 500', async () => {
  const out = await run({ ...sources, snapshot: async () => { throw new Error('secret C:\\path'); } }, { url: '/dsh-world/console/snapshot' });
  assert.equal(out.status, 500);
  assert.deepEqual(JSON.parse(out.body!), { error: 'internal error' });
  const failing = { ...fakeActions().actions, start: async () => { throw new Error('boom'); } };
  assert.equal((await run(sources, { method: 'POST', url: '/dsh-world/console/start', headers: { 'x-dsh-world': '1', 'content-type': 'application/json' }, body: '{}' }, failing)).body, '{"error":"internal error"}');
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
test('memory token budget is opt-in, persists, and can be removed', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dw-memory-budget-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const power = createWorldSwitch(dir);
  assert.equal(power.memoryTokenBudget(), undefined);
  power.setMemoryTokenBudget(12000);
  assert.equal(createWorldSwitch(dir).memoryTokenBudget(), 12000);
  power.setMemoryTokenBudget(undefined);
  assert.equal(createWorldSwitch(dir).memoryTokenBudget(), undefined);
});
