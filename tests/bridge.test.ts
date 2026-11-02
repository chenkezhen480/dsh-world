import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createUserMessage, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { hostFixture, textResponse } from './hostFixture.ts';
import { createBridge, HomeUnavailable, REPLY_TIMEOUT_MS, type Bridge } from '../src/ecosystem/bridge/bridge.ts';
import { BRIDGE_PATH, COMPACT_PATH, bridgeRoute, compactRoute } from '../src/ecosystem/bridge/route.ts';
import type { Push } from '../src/ecosystem/shared/outlets.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
const userMessage = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const userTexts = (request: GenerateOptions) => request.messages.filter(m => m.role === 'user' && m.source?.kind === 'user').map(m => m.content.filter(b => b.type === 'text').map(b => b.text).join(''));
function fakeTimers(clock: { now: Date }) {
  let pending: { fn: () => void; at: number }[] = [];
  return {
    set(fn: () => void, ms: number) { const entry = { fn, at: clock.now.getTime() + ms }; pending.push(entry); return entry; },
    clear(handle: unknown) { pending = pending.filter(entry => entry !== handle); },
    advance(ms: number) { clock.now = new Date(clock.now.getTime() + ms); const due = pending.filter(entry => entry.at <= clock.now.getTime()); pending = pending.filter(entry => !due.includes(entry)); for (const entry of due) entry.fn(); },
  };
}
async function* textThenTool(text: string, name: string, id = `${name}-call`): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  const block = { type: 'tool-call' as const, id: ToolCallId(id), name, arguments: '{}' };
  yield { type: 'block-start', index: 1, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 1, id: block.id, name, argumentsDelta: '{}' };
  yield { type: 'block-end', index: 1, block };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}
async function* toolOnly(name: string, id = `${name}-call`): AsyncIterable<StreamChunk> {
  const block = { type: 'tool-call' as const, id: ToolCallId(id), name, arguments: '{}' };
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id: block.id, name, argumentsDelta: '{}' };
  yield { type: 'block-end', index: 0, block };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}
const testTool = (name: string, execute: () => Promise<string>) => defineTool({ name, description: 'test', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute });

async function setup(t: test.TestContext, model: (request: GenerateOptions, index: number) => AsyncIterable<StreamChunk>) {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, request => { requests.push(request); return model(request, requests.length - 1); });
  const home = (await ctx.agents.create({ sessionId: SessionId('home'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } })).agent;
  const clock = { now: new Date('2026-10-23T03:00:00.000Z') }; const timers = fakeTimers(clock);
  const pushes: Omit<Push, 'name'>[] = []; const names: string[] = []; const reachOnly: Push[] = []; const control = { pushFails: false, homeFails: undefined as string | undefined };
  const file = join(root, 'world', 'bridge.json'); await mkdir(join(root, 'world'), { recursive: true });
  const make = (bridgeFile = file) => createBridge({
    ctx, file: bridgeFile, origin: () => 'http://127.0.0.1:5173', timers, clock: () => clock.now,
    home: async () => { if (control.homeFails) throw new Error(control.homeFails); return home; },
    outlets: [
      { name: '桌面桌宠', kinds: ['reply', 'busy', 'reach'], send: async ({ name, ...push }) => { names.push(name); pushes.push(push); if (control.pushFails) throw new Error('connect ECONNREFUSED'); } },
      { name: '只要 reach', kinds: ['reach'], send: async push => { reachOnly.push(push); } },
    ],
  });
  const bridge = make(); bridge.start(); cleanup.push(() => bridge.stop());
  /** A home turn held inside a tool until `release()`. */
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const playing = new Promise<void>(resolve => { entered = resolve; });
  ctx.tools.register(testTool('play_game', async () => { entered(); await gate; return 'played'; }));
  ctx.tools.register(testTool('look', async () => 'a puzzle'));
  const busy = async () => { home.followup(userMessage('先玩会儿')); await playing; assert.equal(home.status, 'running'); };
  const idle = async () => { await home.whenIdle(); await tick(); await tick(); };
  return { ctx, root, home, bridge, make, file, pushes, names, reachOnly, control, requests, errors, timers, release, busy, idle };
}

test('her partner\'s words reach an idle home as a followup from the user, and her reply goes to the pet', async t => {
  const s = await setup(t, () => textResponse('![开心](http://127.0.0.1:5173/m/a?size=150)\n**在的**，刚醒'));
  const { id } = await s.bridge.say('在吗');
  await s.idle();
  assert.equal(s.requests.length, 1);
  const sent = s.requests[0]!.messages.find(m => m.source?.kind === 'user')!;
  assert.equal(sent.id, id); assert.deepEqual(userTexts(s.requests[0]!), ['在吗']);
  assert.deepEqual(s.pushes, [{ text: '在的，刚醒', kind: 'reply', images: ['http://127.0.0.1:5173/m/a?size=150'] }]);
  assert.deepEqual(s.names, ['TA'], 'an unnamed companion is TA'); assert.deepEqual(s.reachOnly, [], 'an outlet that takes only reach gets no reply');
  assert.deepEqual(s.errors, []);
});
test('while she is busy the words are steered into the running turn, and the reply is her first visible text after them', async t => {
  const s = await setup(t, (_request, index) => index === 0 ? textThenTool('我去玩游戏了', 'play_game') : index === 1 ? toolOnly('look') : index === 2 ? textResponse('在玩消消乐') : textResponse('不该出现'));
  await s.busy();
  await s.bridge.say('在玩什么');
  s.release(); await s.idle();
  assert.equal(s.requests.length, 3, 'the words entered the same turn at the next step');
  assert.deepEqual(userTexts(s.requests[1]!), ['先玩会儿', '在玩什么']);
  assert.deepEqual(s.pushes, [{ text: '在玩消消乐', kind: 'reply' }]);
});
test('a sentence she was already saying when the words arrived is not taken as the reply', async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const speaking = new Promise<void>(resolve => { entered = resolve; });
  const s = await setup(t, (_request, index) => index === 0 ? (async function* () { entered(); await gate; yield* textResponse('我在自言自语'); })() : textResponse('听到你了'));
  s.home.followup(userMessage('先说会儿')); await speaking;
  await s.bridge.say('喂');
  release(); await s.idle();
  assert.equal(s.requests.length, 2); assert.deepEqual(userTexts(s.requests[1]!), ['先说会儿', '喂']);
  assert.deepEqual(s.pushes, [{ text: '听到你了', kind: 'reply' }]);
});
test('only the reply after the latest of several messages is pushed', async t => {
  const s = await setup(t, (_request, index) => index === 0 ? toolOnly('play_game') : textResponse('两句都听到了'));
  await s.busy();
  await s.bridge.say('第一句'); await s.bridge.say('第二句');
  s.release(); await s.idle();
  assert.deepEqual(userTexts(s.requests[1]!), ['先玩会儿', '第一句', '第二句']);
  assert.deepEqual(s.pushes, [{ text: '两句都听到了', kind: 'reply' }]);
  s.timers.advance(REPLY_TIMEOUT_MS); await tick();
  assert.equal(s.pushes.length, 1, 'no busy after the reply');
});
test('no reply within three minutes pushes busy, and the later reply is still pushed', async t => {
  const s = await setup(t, (_request, index) => index === 0 ? toolOnly('play_game') : textResponse('忙完啦'));
  await s.busy();
  await s.bridge.say('在吗');
  s.timers.advance(REPLY_TIMEOUT_MS - 1); await tick();
  assert.equal(s.pushes.length, 0);
  s.timers.advance(1); await tick();
  assert.deepEqual([...s.pushes], [{ text: 'TA在忙，忙完会在家里回你', kind: 'busy' }]);
  s.release(); await s.idle();
  assert.deepEqual([...s.pushes], [{ text: 'TA在忙，忙完会在家里回你', kind: 'busy' }, { text: '忙完啦', kind: 'reply' }]);
});
test('a failed push is a fault until the next push works', async t => {
  const s = await setup(t, () => textResponse('嗯'));
  s.control.pushFails = true;
  await s.bridge.say('在吗'); await s.idle();
  assert.deepEqual(s.bridge.faults(), ['桌面桌宠没收到TA的回复：connect ECONNREFUSED']);
  s.control.pushFails = false;
  await s.bridge.say('再试'); await s.idle();
  assert.deepEqual(s.bridge.faults(), []); assert.equal(s.pushes.length, 2);
});
test('a home that cannot be opened rejects the words and is a fault', async t => {
  const s = await setup(t, () => textResponse('嗯'));
  s.control.homeFails = 'resolve failed';
  await assert.rejects(s.bridge.say('在吗'), HomeUnavailable);
  assert.deepEqual(s.bridge.faults(), ['从外面送来的话没进家：resolve failed']);
  assert.equal(s.requests.length, 0);
  s.control.homeFails = undefined;
  await s.bridge.say('在吗'); await s.idle();
  assert.deepEqual(s.bridge.faults(), []);
});
test('the bridge rechecks workspace membership after resolving an idle or running home', async t => {
  for (const running of [false, true]) await t.test(running ? 'running' : 'idle', async t => {
    const s = await setup(t, (_request, index) => running && index === 0 ? toolOnly('play_game') : textResponse('忙完了'));
    if (running) await s.busy();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let resolving!: () => void; const opening = new Promise<void>(resolve => { resolving = resolve; });
    const members = new Set<string>([s.home.id]);
    const messages: string[] = [];
    s.ctx.on('session/event', (session, event) => { if (session.id === s.home.id && event.type === 'user/message') messages.push(event.data.id); });
    const bridge = createBridge({
      ctx: s.ctx, home: async () => { resolving(); await gate; return s.home; },
      inWorld: agent => members.has(agent.id),
      outlets: [], origin: () => 'http://127.0.0.1:5173', file: join(s.root, 'guarded-bridge.json'),
    });
    bridge.start(); t.after(bridge.stop);
    const answer = bridge.say('不能进入原会话');
    await opening;
    members.delete(s.home.id);
    const rejected = assert.rejects(answer, HomeUnavailable);
    release();
    try { await rejected; } finally { s.release(); await s.idle(); }

    assert.deepEqual(messages, []);
    assert.equal(s.requests.length, running ? 2 : 0);
    assert.match(bridge.faults()[0]!, /工作区/);
  });
});

test('bridge.json carries the origin, a fresh token, the pid and the start time, and is removed on stop', async t => {
  const s = await setup(t, () => textResponse('嗯'));
  const written = JSON.parse(await readFile(s.file, 'utf8'));
  assert.deepEqual(Object.keys(written).sort(), ['name', 'origin', 'pid', 'startedAt', 'token']); assert.equal(written.name, 'TA');
  assert.equal(written.origin, 'http://127.0.0.1:5173'); assert.equal(written.pid, process.pid);
  assert.equal(written.startedAt, '2026-10-23T03:00:00.000Z'); assert.match(written.token, /^[0-9a-f]{64}$/);
  assert.ok(s.bridge.checkToken(written.token)); assert.ok(!s.bridge.checkToken(written.token.slice(1))); assert.ok(!s.bridge.checkToken(undefined));
  const other = s.make(join(s.root, 'other.json')); other.start();
  assert.notEqual(JSON.parse(await readFile(join(s.root, 'other.json'), 'utf8')).token, written.token);
  other.stop(); assert.ok(!existsSync(join(s.root, 'other.json')));
  s.bridge.stop(); assert.ok(!existsSync(s.file));
  await assert.rejects(s.bridge.say('在吗'), HomeUnavailable);
});
test('stop leaves a bridge.json that a newer start wrote', async t => {
  const s = await setup(t, () => textResponse('嗯'));
  await writeFile(s.file, JSON.stringify({ origin: 'x', token: 'newer', pid: 1, startedAt: 'x' }));
  s.bridge.stop();
  assert.equal(JSON.parse(await readFile(s.file, 'utf8')).token, 'newer');
});
test('a bridge.json that cannot be written is a fault', async t => {
  const s = await setup(t, () => textResponse('嗯'));
  await writeFile(join(s.root, 'not-a-dir'), '');
  const broken = s.make(join(s.root, 'not-a-dir', 'bridge.json')); broken.start(); t.after(() => broken.stop());
  assert.equal(broken.faults().length, 1); assert.match(broken.faults()[0]!, /^bridge\.json 没能写入，外面的程序找不到家：/);
});

function fakeBridge(say: (text: string) => Promise<{ id: string }> = async () => ({ id: 'm1' })): Bridge & { said: string[] } {
  const said: string[] = [];
  return { said, checkToken: token => token === 'secret', say: async text => { said.push(text); return say(text); }, start() {}, stop() {}, faults: () => [] } as Bridge & { said: string[] };
}
async function call(bridge: Bridge | undefined, request: { method?: string; url?: string; headers?: Record<string, string>; body?: string }) {
  const req = Object.assign(Readable.from(request.body === undefined ? [] : [Buffer.from(request.body)]), { method: request.method ?? 'POST', url: request.url ?? BRIDGE_PATH, headers: { host: '127.0.0.1:3080', ...request.headers } });
  let status = 0; let headers: Record<string, string> = {}; let body = '';
  await bridgeRoute(() => bridge).handler(req as never, { writeHead: (code: number, extra: Record<string, string>) => { status = code; headers = extra; }, end: (text: string) => { body = text; } } as never);
  return { status, headers, body: JSON.parse(body) };
}
const ok = { 'x-dsh-world-token': 'secret', 'content-type': 'application/json' };

test('the say route accepts trimmed text with the right token and answers 202 without waiting', async () => {
  const bridge = fakeBridge();
  const route = bridgeRoute(() => bridge);
  assert.deepEqual({ kind: route.kind, path: route.path }, { kind: 'exact', path: '/dsh-world/bridge/say' });
  assert.deepEqual(await call(bridge, { headers: ok, body: JSON.stringify({ text: '  在吗  ' }) }), { status: 202, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: { accepted: true, id: 'm1' } });
  assert.deepEqual(bridge.said, ['在吗']);
  assert.equal((await call(bridge, { headers: ok, body: JSON.stringify({ text: '鲸'.repeat(2000) }) })).status, 202);
});
test('the say route refuses a bad token, cross-site requests, other methods and bad bodies without saying anything', async () => {
  const bridge = fakeBridge();
  const body = JSON.stringify({ text: '在吗' });
  assert.deepEqual(await call(bridge, { body }), { status: 403, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: { error: 'forbidden' } });
  assert.equal((await call(bridge, { headers: { 'x-dsh-world-token': 'wrong' }, body })).status, 403);
  assert.equal((await call(bridge, { headers: { ...ok, 'sec-fetch-site': 'cross-site' }, body })).status, 403);
  assert.equal((await call(bridge, { headers: { ...ok, host: 'evil.example:3080' }, body })).status, 403, 'a rebound name');
  const get = await call(bridge, { method: 'GET', headers: ok });
  assert.equal(get.status, 405); assert.equal(get.headers.allow, 'POST');
  for (const bad of ['{ torn', '[]', JSON.stringify({ text: 3 }), JSON.stringify({ text: '   ' }), JSON.stringify({ text: '鲸'.repeat(2001) }), JSON.stringify({ text: 'x'.repeat(70_000) })]) {
    assert.deepEqual((await call(bridge, { headers: ok, body: bad })).status, 400, bad.slice(0, 20));
  }
  assert.deepEqual(bridge.said, []);
});
test('the say route answers 503 while her world is stopped (no bridge)', async () => {
  assert.deepEqual((await call(undefined, { headers: ok, body: JSON.stringify({ text: '在吗' }) })).body, { error: 'home unavailable' });
  assert.equal((await call(undefined, { headers: { ...ok, 'sec-fetch-site': 'cross-site' }, body: '{}' })).status, 403);
});
test('the say route answers 503 when the home is unavailable and never echoes internals', async () => {
  const unavailable = fakeBridge(async () => { throw new HomeUnavailable('session C:\\secret broke'); });
  assert.deepEqual((await call(unavailable, { headers: ok, body: JSON.stringify({ text: '在吗' }) })).body, { error: 'home unavailable' });
  assert.equal((await call(unavailable, { headers: ok, body: JSON.stringify({ text: '在吗' }) })).status, 503);
  const broken = fakeBridge(async () => { throw new Error('C:\\secret'); });
  assert.deepEqual(await call(broken, { headers: ok, body: JSON.stringify({ text: '在吗' }) }), { status: 500, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: { error: 'internal error' } });
});

async function callCompact(bridge: Bridge | undefined, request: () => string | undefined, init: { method?: string; headers?: Record<string, string> }) {
  const req = Object.assign(Readable.from([]), { method: init.method ?? 'POST', url: COMPACT_PATH, headers: { host: '127.0.0.1:3080', ...init.headers } });
  let status = 0; let body = '';
  await compactRoute(() => bridge, request).handler(req as never, { writeHead: (code: number) => { status = code; }, end: (text: string) => { body = text; } } as never);
  return { status, body: JSON.parse(body) };
}
test('the compact route asks for one compaction with the right token, and says why when it cannot', async () => {
  const bridge = fakeBridge();
  let asked = 0;
  assert.deepEqual(await callCompact(bridge, () => { asked += 1; return undefined; }, { headers: ok }), { status: 202, body: { accepted: true } });
  assert.equal(asked, 1);
  assert.deepEqual(await callCompact(bridge, () => '请先启动世界生活线', { headers: ok }), { status: 409, body: { error: '请先启动世界生活线' } });
});
test('the compact route asks for nothing on a bad token, a cross-site request, another method or while her world is stopped', async () => {
  const bridge = fakeBridge();
  let asked = 0;
  const request = () => { asked += 1; return undefined; };
  assert.equal((await callCompact(bridge, request, {})).status, 403);
  assert.equal((await callCompact(bridge, request, { headers: { 'x-dsh-world-token': 'wrong' } })).status, 403);
  assert.equal((await callCompact(bridge, request, { headers: { ...ok, 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await callCompact(bridge, request, { headers: { ...ok, host: 'evil.example:3080' } })).status, 403);
  assert.equal((await callCompact(bridge, request, { method: 'GET', headers: ok })).status, 405);
  assert.equal((await callCompact(undefined, request, { headers: ok })).status, 503);
  assert.equal(asked, 0);
});
