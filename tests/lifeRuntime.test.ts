import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import { hostFixture, textResponse } from './hostFixture.ts';
import { createLifeRuntime } from '../src/life/runtime.ts';
import { createLifeStore, type LifeStore } from '../src/life/lifeStore.ts';
import { hostLife, type LifeHost } from '../src/life/host.ts';
import type { Notifier } from '../src/life/notify.ts';
import ToolFreeCompaction from '../src/compaction.ts';
import { stepCost } from '../src/life/pricing.ts';
import { askTurn } from '../src/ecosystem/shared/turn.ts';

const config = { worldId: 'fish', agentPreset: 'companion', timeZone: 'Asia/Seoul', companionName: '鲸鲸' };
const textOf = (request: GenerateOptions) => request.messages.map(m => m.content.filter(b => b.type === 'text').map(b => b.text).join('\n')).join('\n');
const toolNames = (request: GenerateOptions) => request.tools?.map(tool => tool.name) ?? [];
const count = (names: string[], name: string) => names.filter(entry => entry === name).length;
const tick = () => new Promise(resolve => setImmediate(resolve));
const userMessage = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const createAgent = async (ctx: Context, id: string, agentPreset = 'companion') => (await ctx.agents.create({ sessionId: SessionId(id), meta: { agentPreset }, agentOptions: { provider: 'test', model: 'test' } })).agent;
const testTool = (name: string, execute: () => Promise<string>) => defineTool({ name, description: 'test', parameters: { command: { type: 'string' } }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute });
async function* toolCall(name: string, args: object, id = `${name}-call`): AsyncIterable<StreamChunk> {
  const block = { type: 'tool-call' as const, id: ToolCallId(id), name, arguments: JSON.stringify(args) };
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id: block.id, name, argumentsDelta: block.arguments };
  yield { type: 'block-end', index: 0, block };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}
function fakeTimers(clock: { now: Date }) {
  let pending: { fn: () => void; at: number }[] = [];
  return {
    set(fn: () => void, ms: number) { const entry = { fn, at: clock.now.getTime() + ms }; pending.push(entry); return entry; },
    clear(handle: unknown) { pending = pending.filter(entry => entry !== handle); },
    /** Move the clock and run every due timer. */
    advance(ms: number) { clock.now = new Date(clock.now.getTime() + ms); const due = pending.filter(entry => entry.at <= clock.now.getTime()); pending = pending.filter(entry => !due.includes(entry)); for (const entry of due) entry.fn(); },
    /** Wall clock jumps (suspend, clock change) while no timer time passes. */
    jump(ms: number) { clock.now = new Date(clock.now.getTime() + ms); for (const entry of pending) entry.at += ms; },
  };
}
interface SetupOptions { afterReview?: () => void; before?: (worldDir: string) => Promise<void>; host?: (host: LifeHost) => LifeHost; store?: (store: LifeStore) => LifeStore; notifier?: Notifier; dailyBudget?: () => number | undefined; inWorkspace?: (id: string) => boolean; alarmContext?: (now: Date) => string | undefined; schedule?: { review: string; wake: string } }
async function setup(t: test.TestContext, model: (request: GenerateOptions, index: number) => AsyncIterable<StreamChunk>, setupOptions: SetupOptions = {}) {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, request => { if (request.purpose !== 'compaction') requests.push(request); return model(request, requests.length - 1); });
  const worldDir = join(root, 'world'); await mkdir(worldDir, { recursive: true }); await setupOptions.before?.(worldDir);
  const clock = { now: new Date('2026-10-23T03:00:00.000Z') }; const timers = fakeTimers(clock);
  const archived = new Set<string>(); const renamed = new Map<string, string>(); let created = 0;
  /** The host's workspaces by path; a session created in one is listed in it. */
  const workspaces = new Map<string, { id: string; title: string; sessionIds: string[]; attachSession(id: string): Promise<void> }>();
  const baseHost: LifeHost = {
    createSession: async (_cwd, agentPreset, workspaceId) => {
      const id = (await ctx.agents.create({ sessionId: SessionId(`home-${++created}`), meta: { agentPreset }, agentOptions: { provider: 'test', model: 'test' } })).agent.id;
      if (workspaceId) [...workspaces.values()].find(workspace => workspace.id === workspaceId)!.sessionIds.unshift(id);
      return id;
    },
    workspace: async (path, title) => {
      if (!workspaces.has(path)) { const sessionIds: string[] = []; workspaces.set(path, { id: `ws-${workspaces.size + 1}`, title, sessionIds, attachSession: async id => { if (!sessionIds.includes(id)) sessionIds.unshift(id); } }); }
      return workspaces.get(path);
    },
    resolveAgent: async id => ctx.agents.get(SessionId(id)),
    isArchived: id => archived.has(id),
    rename: async (id, title) => { renamed.set(id, title); }, origin: () => 'http://127.0.0.1:0',
  };
  const host = setupOptions.host?.(baseHost) ?? baseHost;
  const baseStore = createLifeStore(worldDir, config.timeZone);
  const store = setupOptions.store?.(baseStore) ?? baseStore;
  const options = { worldDir, roomDir: join(worldDir, 'room'), diaryDir: join(worldDir, 'diary'), selfFile: join(worldDir, 'room', 'self.md'), schedule: () => setupOptions.schedule ?? { review: '23:00', wake: '09:00' }, timeZone: config.timeZone, alarmFile: join(worldDir, 'alarm.md') };
  const make = () => createLifeRuntime({ ctx, config, options, store, host, notifier: setupOptions.notifier ?? { toast: async () => {}, outlets: [] }, clock: () => clock.now, timers, ...(setupOptions.dailyBudget ? { dailyBudget: setupOptions.dailyBudget } : {}), inWorkspace: setupOptions.inWorkspace, alarmContext: setupOptions.alarmContext, ...(setupOptions.afterReview ? { afterReview: setupOptions.afterReview } : {}) });
  let life = make();
  cleanup.push(() => life.stop());
  /** Waits out deliveries and the home turns they start, a few rounds deep. */
  const idle = async () => {
    for (let round = 0; round < 3; round++) {
      await life.settled();
      const home = life.snapshot().homeSessionId;
      if (home) await ctx.agents.get(SessionId(home))?.whenIdle();
      await tick();
    }
  };
  /** Start, then fire the zero-delay timer that delivers a due (first or overdue) alarm. */
  const start = async () => { await life.start(); timers.advance(0); await idle(); };
  /** Stop this runtime and make a fresh one over the same ctx and store (a plugin reload). */
  const restart = () => { life.stop(); life = make(); return life; };
  /** Through the evening look back (23:00 Seoul) to the morning fallback (09:00 Seoul), one timer each. */
  const untilMorning = async () => {
    const wait = (hour: number) => { const next = new Date(clock.now); next.setUTCHours(hour, 0, 0, 0); if (next.getTime() <= clock.now.getTime()) next.setUTCDate(next.getUTCDate() + 1); return next.getTime() - clock.now.getTime(); };
    timers.advance(wait(14)); await idle();
    timers.advance(wait(0)); await idle();
  };
  const alarm = () => { const pending = life.snapshot().alarm; return pending && { at: pending.at, source: pending.source }; };
  const faults = () => life.snapshot().faults;
  return { ctx, get life() { return life; }, store, requests, errors, clock, timers, archived, renamed, worldDir, idle, start, restart, untilMorning, alarm, faults, workspaces, created: () => created };
}
/** life.json for an existing home `home-0` (create it before start), optionally with an alarm of her own due at start. */
const existingHome = (note?: string) => (worldDir: string) => writeFile(join(worldDir, 'life.json'), JSON.stringify({
  version: 1, homeSessionId: 'home-0', ...(note === undefined ? {} : { alarm: { at: '2026-10-23T03:00:00.000Z', note, setAt: '2026-10-23T02:00:00.000Z', source: 'plan' } }),
}));
/** A host whose nth resolveAgent call is held until released (or rejected); `reached` resolves once that call is made. */
function holdResolve(nth: number) {
  let calls = 0;
  let reach!: () => void;
  const held: { release?: () => void; fail?: (error: Error) => void; reached: Promise<void> } = { reached: new Promise(resolve => { reach = resolve; }) };
  const patch = (host: LifeHost): LifeHost => ({
    ...host,
    resolveAgent: id => ++calls === nth ? new Promise((resolve, reject) => { held.release = () => resolve(host.resolveAgent(id)); held.fail = reject; reach(); }) : host.resolveAgent(id),
  });
  return { held, patch };
}

test('first start builds the home with a title and reach_out at home, alarm tools in world sessions', async t => {
  const s = await setup(t, () => textResponse('我到家了'));
  await s.start();
  const home = s.life.snapshot().homeSessionId!;
  assert.equal(s.renamed.get(home), '鲸鲸的家');
  assert.equal(s.requests.length, 1);
  assert.match(textOf(s.requests[0]), /这是我的家/);
  assert.deepEqual(toolNames(s.requests[0]).filter(name => ['plan_next', 'reach_out', 'read_diary'].includes(name)).sort(), ['plan_next', 'reach_out']);
  const chat = await createAgent(s.ctx, 'chat');
  chat.followup(userMessage('hi')); await chat.whenIdle();
  const names = toolNames(s.requests[1]);
  assert.ok(!names.includes('read_diary') && !names.includes('reach_out'), 'reach_out stays home');
  assert.ok(['plan_next', 'check_alarm', 'cancel_alarm'].every(name => count(names, name) === 1), 'the alarm can be set from any of her sessions');
  assert.equal(s.store.wakes().length, 1); assert.equal(s.store.wakes()[0].source, 'first');
});
test('her room is a workspace of the host, named for her, and a new home is built in it', async t => {
  const s = await setup(t, () => textResponse('嗯'));
  await s.start();
  const room = s.workspaces.get(join(s.worldDir, 'room'))!;
  assert.equal(room.title, '鲸鲸的房间');
  assert.deepEqual(room.sessionIds, [s.life.snapshot().homeSessionId]);
  assert.equal(s.workspaces.size, 1);
});
test('a home built before her room was a workspace moves into it', async t => {
  const s = await setup(t, () => textResponse('嗯'), { before: existingHome() });
  await createAgent(s.ctx, 'home-0');
  await s.start();
  assert.deepEqual(s.workspaces.get(join(s.worldDir, 'room'))!.sessionIds, ['home-0']);
  assert.equal(s.created(), 0);
});
test('without her room as a workspace no home is built anywhere else, and the console says why', async t => {
  const plain = await setup(t, () => textResponse('嗯'), { host: host => ({ ...host, workspace: async () => undefined }) });
  await plain.start();
  assert.equal(plain.life.snapshot().homeSessionId, undefined); assert.equal(plain.created(), 0); assert.equal(plain.requests.length, 0);
  assert.ok(plain.faults().some(fault => fault.startsWith('家打不开：宿主没有工作区服务')), plain.faults().join('|'));

  const failing = await setup(t, () => textResponse('嗯'), { host: host => ({ ...host, workspace: async () => { throw new Error('registry busy'); } }) });
  await failing.start();
  assert.equal(failing.life.snapshot().homeSessionId, undefined); assert.equal(failing.requests.length, 0);
  assert.ok(failing.faults().some(fault => fault === '家打不开：registry busy'), failing.faults().join('|'));
});
test('a new home is renamed again after its first turn ends (the host retitles from the first prompt), and not after later turns', async t => {
  const titles: string[] = [];
  const s = await setup(t, () => textResponse('嗯'), { host: host => ({ ...host, rename: async (id, title) => { titles.push(`${id}:${title}`); await host.rename(id, title); } }) });
  await s.life.start();
  const home = s.life.snapshot().homeSessionId!;
  assert.deepEqual(titles, [`${home}:鲸鲸的家`]);
  s.timers.advance(0); await s.idle();
  assert.deepEqual(titles, [`${home}:鲸鲸的家`, `${home}:鲸鲸的家`]);
  await s.untilMorning();
  const agent = s.ctx.agents.get(SessionId(home))!;
  agent.followup(userMessage('在吗')); await s.idle();
  assert.equal(s.requests.length, 4); assert.equal(titles.length, 2);
});
test('an existing home is not renamed after its turns', async t => {
  const titles: string[] = [];
  const s = await setup(t, () => textResponse('嗯'), { host: host => ({ ...host, rename: async (id, title) => { titles.push(id); await host.rename(id, title); } }), before: async worldDir => { await writeFile(join(worldDir, 'life.json'), JSON.stringify({ version: 1, homeSessionId: 'home-0' })); } });
  await createAgent(s.ctx, 'home-0');
  await s.start();
  await s.untilMorning();
  assert.equal(s.requests.length, 2); assert.deepEqual(titles, []);
});
test('the host reads archived sessions from an array or a Set', () => {
  const host = (archivedSessionIds: Iterable<string> | undefined) => hostLife({ get: () => archivedSessionIds && { archivedSessionIds } } as unknown as Context);
  assert.equal(host(['a']).isArchived('a'), true);
  assert.equal(host(new Set(['a'])).isArchived('a'), true);
  assert.equal(host(new Set(['a'])).isArchived('b'), false);
  assert.equal(host(undefined).isArchived('a'), false);
});
test('a session of another agent preset gets no life tools', async t => {
  const s = await setup(t, () => textResponse('ok'));
  await s.start();
  const coder = await createAgent(s.ctx, 'coder', 'coder');
  coder.followup(userMessage('hi')); await coder.whenIdle();
  assert.ok(!toolNames(s.requests.at(-1)!).some(name => ['read_diary', 'plan_next', 'reach_out'].includes(name)));
});
test('plan_next sets the alarm and the alarm wakes her with her own note', async t => {
  const s = await setup(t, (_request, index) => index === 0 ? toolCall('plan_next', { after_minutes: 90, note: '去写日记' }) : textResponse('好'));
  await s.start();
  assert.equal(s.life.snapshot().alarm?.at, '2026-10-23T04:30:00.000Z');
  s.timers.advance(90 * 60_000); await s.idle();
  assert.match(textOf(s.requests.at(-1)!), /2026-10-23T13:30:00\+09:00 到了，这是我说好做到的时间：「去写日记」/);
  assert.deepEqual(s.store.wakes().map(wake => wake.source), ['first', 'plan']);
});
test('a home turn that stops well before her own alarm asks once whether she is done; the alarm still rings', async t => {
  const s = await setup(t, (_request, index) => index === 0 ? toolCall('plan_next', { after_minutes: 90, note: '看视频' }) : textResponse('嗯'), { before: existingHome('起来') });
  await createAgent(s.ctx, 'home-0');
  await s.start();
  assert.equal(s.requests.length, 3, 'the first turn (two steps), then one question');
  assert.match(textOf(s.requests[2]!), /【我的时间】我说好做到 2026-10-23T13:30:00\+09:00（「看视频」），现在才 2026-10-23T12:00:00\+09:00，这一轮就停了。/);
  assert.equal(s.store.read().alarm?.nudged, true, 'asked is remembered across restarts');
  s.timers.advance(90 * 60_000); await s.idle();
  assert.equal(s.requests.length, 4);
  assert.match(textOf(s.requests[3]!), /说好做到的时间：「看视频」/);
});
test('the turn the question started never asks again, even with a new alarm, so nothing loops', async t => {
  const s = await setup(t, (_request, index) => index === 0 ? toolCall('plan_next', { after_minutes: 90, note: '看视频' }, 'a')
    : index === 2 ? toolCall('plan_next', { after_minutes: 60, note: '写日记' }, 'b') : textResponse('嗯'), { before: existingHome('起来') });
  await createAgent(s.ctx, 'home-0');
  await s.start();
  assert.equal(s.requests.length, 4);
  assert.deepEqual(s.alarm(), { at: '2026-10-23T04:00:00.000Z', source: 'plan' });
});
test('no question when her alarm is close, after her partner spoke, or when the turn was stopped', async t => {
  const close = await setup(t, (_request, index) => index === 0 ? toolCall('plan_next', { after_minutes: 5, note: '收尾' }) : textResponse('嗯'), { before: existingHome('起来') });
  await createAgent(close.ctx, 'home-0');
  await close.start();
  assert.equal(close.requests.length, 2);

  const chat = await setup(t, () => textResponse('嗯'));
  await chat.start();
  chat.life.planNext({ after_minutes: 60 }, '看书');
  const home = chat.ctx.agents.get(SessionId(chat.life.snapshot().homeSessionId!))!;
  home.followup(userMessage('在吗')); await chat.idle();
  assert.equal(chat.requests.length, 2, 'a pause in talking with her partner is not stopping early');
  assert.equal(chat.store.read().alarm?.nudged, undefined, 'so a later early stop is still asked about');

  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const playing = new Promise<void>(resolve => { entered = resolve; });
  const stopped = await setup(t, (_request, index) => index === 0 ? toolCall('play_game', {}) : textResponse('嗯'));
  stopped.ctx.tools.register(testTool('play_game', async () => { entered(); await gate; return 'played'; }));
  await stopped.life.start(); stopped.timers.advance(0); await playing; await stopped.life.settled();
  stopped.life.planNext({ after_minutes: 60 }, '玩游戏');
  const playingHome = stopped.ctx.agents.get(SessionId(stopped.life.snapshot().homeSessionId!))!;
  playingHome.cancel({ kind: 'user' }); release(); await stopped.idle();
  assert.equal(stopped.requests.length, 1);
});
test('a home turn that ends without an alarm gets the fallback alarm', async t => {
  const s = await setup(t, () => textResponse('发会儿呆'));
  await s.start();
  assert.deepEqual(s.alarm(), { at: '2026-10-24T00:00:00.000Z', source: 'fallback' });
  await s.untilMorning();
  assert.match(textOf(s.requests.at(-1)!), /没说接下来做什么/);
});
test('a partner turn in the home does not consume the pending alarm', async t => {
  const s = await setup(t, () => textResponse('嗯'));
  await s.start();
  const pending = s.life.snapshot().alarm;
  const home = s.ctx.agents.get(SessionId(s.life.snapshot().homeSessionId!))!;
  home.followup(userMessage('在吗')); await s.idle();
  assert.equal(s.requests.length, 2); assert.deepEqual(s.life.snapshot().alarm, pending);
  await s.untilMorning();
  assert.equal(s.requests.length, 4); assert.match(textOf(s.requests[3]), /没说接下来做什么/);
});
test('a channel\'s words that join a home turn already running get that turn\'s answer, not a ten-minute wait (#34)', async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const playing = new Promise<void>(resolve => { entered = resolve; });
  const s = await setup(t, (_request, index) => index === 0 ? toolCall('play_game', {}) : textResponse('在呢，刚玩完'));
  s.ctx.tools.register(testTool('play_game', async () => { entered(); await gate; return 'played'; }));
  await s.life.start(); s.timers.advance(0); await playing;
  const home = s.ctx.agents.get(SessionId(s.life.snapshot().homeSessionId!))!;
  assert.equal(home.status, 'running', 'her own turn started first');
  const answer = askTurn(s.ctx, home, userMessage('在吗'), { name: 'QQ', cancelled: new Promise<never>((_resolve, reject) => { setTimeout(() => reject(new Error('still waiting')), 2000).unref(); }) });
  release();
  assert.equal(await answer, '在呢，刚玩完');
});
test('while she is busy, the alarm and her partner\'s message both enter the running turn', async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const playing = new Promise<void>(resolve => { entered = resolve; });
  const s = await setup(t, (_request, index) => index === 0 ? toolCall('play_game', {}) : textResponse('听到了'));
  s.ctx.tools.register(testTool('play_game', async () => { entered(); await gate; return 'played'; }));
  await s.life.start(); s.timers.advance(0); await playing; await s.life.settled();
  const home = s.ctx.agents.get(SessionId(s.life.snapshot().homeSessionId!))!;
  assert.equal(home.status, 'running');
  s.life.planNext({ after_minutes: 5 }, '收工');
  s.timers.advance(5 * 60_000); await s.life.settled();
  home.followup(userMessage('在玩什么'));
  release(); await s.idle();
  assert.equal(s.requests.length, 2, 'both arrived inside the same turn, at the next step');
  assert.match(textOf(s.requests[1]), /说好做到的时间：「收工」/); assert.match(textOf(s.requests[1]), /在玩什么/);
});
test('her file tools may write today\'s diary but not a closed day\'s; she is told to correct it today', async t => {
  const written: string[] = [];
  const diary = (day: string) => join(s.worldDir, 'diary', `${day}.md`);
  const s = await setup(t, (_request, index) => index === 0 ? toolCall('write', { file_path: diary('2026-10-22'), content: '改昨天' }, 'past') : index === 1 ? toolCall('write', { file_path: diary('2026-10-23'), content: '今天' }, 'today') : textResponse('好'));
  s.ctx.tools.register(defineTool({ name: 'write', description: 'test', parameters: { file_path: { type: 'string' }, content: { type: 'string' } }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async args => { written.push(String((args as { file_path: string }).file_path)); return 'ok'; } }));
  await s.start();
  assert.deepEqual(written, [diary('2026-10-23')], 'only today\'s diary was written');
  assert.match(JSON.stringify(s.requests[1]!.messages), /2026-10-22 的日记已经合上了.*今天（2026-10-23）的日记/);
});
test('an archived home is replaced, keeps the pending alarm, and the old home loses reach_out', async t => {
  const s = await setup(t, (_request, index) => index === 0 ? toolCall('plan_next', { after_minutes: 30, note: '看书' }) : textResponse('嗯'));
  await s.start();
  const first = s.life.snapshot().homeSessionId!; s.archived.add(first);
  s.timers.advance(30 * 60_000); await s.idle();
  const second = s.life.snapshot().homeSessionId!;
  assert.notEqual(second, first); assert.equal(s.renamed.get(second), '鲸鲸的家');
  assert.match(textOf(s.requests.at(-1)!), /「看书」/);
  const old = s.ctx.agents.get(SessionId(first))!;
  old.followup(userMessage('还在吗')); await old.whenIdle();
  const names = toolNames(s.requests.at(-1)!);
  assert.ok(!names.includes('read_diary') && !names.includes('reach_out') && count(names, 'plan_next') === 1, 'the old home keeps the alarm tools like any session, and loses reach_out');
  assert.doesNotMatch(textOf(s.requests.at(-1)!), /你现在在自己的家里/);
});
test('life tools are limited to the workspace and removed when membership ends', async t => {
  const included = new Set(['inside']);
  const s = await setup(t, () => textResponse('ok'), { inWorkspace: id => id.startsWith('home-') || included.has(id) });
  const inside = await createAgent(s.ctx, 'inside');
  const outside = await createAgent(s.ctx, 'outside');
  inside.ctx.tools.register(testTool('unrelated_tool', async () => 'ok'));
  await s.start();
  inside.followup(userMessage('inside workspace')); await inside.whenIdle();
  assert.ok(toolNames(s.requests.at(-1)!).includes('plan_next'));
  outside.followup(userMessage('outside workspace')); await outside.whenIdle();
  assert.ok(!toolNames(s.requests.at(-1)!).some(name => ['plan_next', 'check_alarm', 'cancel_alarm', 'reach_out'].includes(name)));
  included.delete('inside');
  inside.followup(userMessage('no longer inside')); await inside.whenIdle();
  const names = toolNames(s.requests.at(-1)!);
  assert.ok(!names.includes('plan_next')); assert.ok(names.includes('unrelated_tool'));
});

test('life tools cannot execute or remain in schemas after leaving the workspace during a request', async t => {
  let allowed = true;
  const s = await setup(t, request => {
    if (request.sessionId === 'inside' && allowed) { allowed = false; return toolCall('plan_next', { after_minutes: 90, note: 'outside plan' }); }
    return textResponse('ok');
  }, { inWorkspace: id => id.startsWith('home-') || (id === 'inside' && allowed) });
  const inside = await createAgent(s.ctx, 'inside');
  await s.start();
  inside.followup(userMessage('scope changes while the request is in flight')); await inside.whenIdle();
  assert.notEqual(s.life.snapshot().alarm?.note, 'outside plan');
  const last = s.requests.at(-1)!;
  assert.ok(!toolNames(last).includes('plan_next'));
});

test('an existing home is reused when it is resolved', async t => {
  const s = await setup(t, () => textResponse('回来了'), { before: async worldDir => { await writeFile(join(worldDir, 'life.json'), JSON.stringify({ version: 1, homeSessionId: 'home-0' })); } });
  await createAgent(s.ctx, 'home-0');
  await s.life.start();
  assert.equal(s.created(), 0); assert.equal(s.life.snapshot().homeSessionId, 'home-0');
});
test('a restart with an idle home and no pending alarm sets the fallback alarm, and it rings', async t => {
  const s = await setup(t, () => textResponse('醒了'), { before: async worldDir => { await writeFile(join(worldDir, 'life.json'), JSON.stringify({ version: 1, homeSessionId: 'home-0' })); } });
  await createAgent(s.ctx, 'home-0');
  await s.start();
  assert.equal(s.created(), 0); assert.equal(s.requests.length, 0);
  assert.deepEqual(s.alarm(), { at: '2026-10-24T00:00:00.000Z', source: 'fallback' });
  assert.equal(s.store.read().alarm?.source, 'fallback');
  await s.untilMorning();
  assert.equal(s.requests.length, 2); assert.match(textOf(s.requests[1]), /没说接下来做什么/);
  assert.deepEqual(s.store.wakes().map(wake => wake.source), ['review', 'fallback']);
});
test('a rebuilt home with no pending alarm gets a first wake', async t => {
  const s = await setup(t, () => textResponse('新家'), { before: async worldDir => { await writeFile(join(worldDir, 'life.json'), JSON.stringify({ version: 1, homeSessionId: 'gone' })); } });
  await s.start();
  assert.notEqual(s.life.snapshot().homeSessionId, 'gone');
  assert.deepEqual(s.store.wakes().map(wake => wake.source), ['first']);
  assert.match(textOf(s.requests[0]), /这是我的家/);
});
test('the world is told when the evening look back has been handed to her, and for nothing else', async t => {
  const told: string[] = [];
  let held: { ctx: Awaited<ReturnType<typeof setup>>['ctx']; requests: unknown[] } | undefined, requestsWhenIdle = -1;
  const s = await setup(t, () => textResponse('想想今天'), {
    // What the console's apply-and-compact relies on: asked for right now, whenIdle still holds until her look back has run.
    afterReview: () => { told.push('review'); void held!.ctx.agents.get(SessionId('home-0'))!.whenIdle().then(() => { requestsWhenIdle = held!.requests.length; }); },
    before: async worldDir => {
    await writeFile(join(worldDir, 'life.json'), JSON.stringify({ version: 1, homeSessionId: 'home-0', alarm: { at: '2026-10-24T00:30:00.000Z', note: '睡觉', setAt: '2026-10-23T02:00:00.000Z', source: 'plan' } }));
  } });
  held = s;
  await createAgent(s.ctx, 'home-0');
  await s.start();
  assert.deepEqual(told, [], 'starting up and the first alarm are not a look back');
  s.timers.advance(11 * 3_600_000); await s.idle();
  assert.deepEqual(told, ['review']);
  assert.equal(requestsWhenIdle, 1, 'her look back had already run when the home reported idle');
  s.timers.advance(2 * 3_600_000); await s.idle();
  assert.deepEqual(told, ['review'], 'her own alarm ringing afterwards is not a look back either');
});
test('every evening at 23:00 she looks back on the day: its records, her diary, and a kept copy of her 我是谁', async t => {
  const s = await setup(t, () => textResponse('想想今天'), { before: async worldDir => {
    await writeFile(join(worldDir, 'life.json'), JSON.stringify({ version: 1, homeSessionId: 'home-0', alarm: { at: '2026-10-24T00:30:00.000Z', note: '睡觉', setAt: '2026-10-23T02:00:00.000Z', source: 'plan' } }));
    await mkdir(join(worldDir, 'room'), { recursive: true }); await writeFile(join(worldDir, 'room', 'self.md'), '我是早上的我');
    await mkdir(join(worldDir, 'conversations'), { recursive: true }); await writeFile(join(worldDir, 'conversations', '2026-10-23.jsonl'), '{}\n');
  } });
  await createAgent(s.ctx, 'home-0');
  await s.start();
  assert.deepEqual(s.store.read().review, { at: '2026-10-23T14:00:00.000Z', day: '2026-10-23' });
  s.timers.advance(11 * 3_600_000); await s.idle();
  assert.equal(s.requests.length, 1, 'the look back, and no early-stop question after it although her alarm is hours away');
  const text = textOf(s.requests[0]!);
  assert.match(text, /【我的时间】2026-10-23 快过完了，回头看看今天吧。今天的聊天记录在 [^ ]*conversations[\\/]2026-10-23\.jsonl/);
  assert.ok(!text.includes('今天做过的事在'), 'no activity file today, so it is not mentioned');
  // The diary first, then whether she has changed: what happened goes to the diary, never into 我是谁.
  assert.match(text, /先写日记，再看自己：\n1\. 日记：[\s\S]*写进今天的日记[\s\S]*\n2\. 我是谁：[\s\S]*今天发生的事不写进去，也不从日记里搬内容/);
  assert.match(text, /改之前的那份已经留在 [^ ]*self\.history[\\/]2026-10-23\.md/);
  assert.equal(await readFile(join(s.worldDir, 'room', 'self.history', '2026-10-23.md'), 'utf8'), '我是早上的我');
  assert.deepEqual(s.store.read().review, { at: '2026-10-24T14:00:00.000Z', day: '2026-10-24' });
  assert.deepEqual(s.store.wakes().map(wake => wake.source), ['review']);
  assert.deepEqual(s.alarm(), { at: '2026-10-24T00:30:00.000Z', source: 'plan' }, 'her alarm is untouched');
});
test('new review and morning times from the console move what is pending at once; an alarm of her own stays', async t => {
  const schedule = { review: '23:00', wake: '09:00' };
  const s = await setup(t, () => textResponse('好'), { schedule });
  await s.start();
  assert.deepEqual(s.alarm(), { at: '2026-10-24T00:00:00.000Z', source: 'fallback' });
  Object.assign(schedule, { review: '22:00', wake: '07:30' });
  s.life.reschedule();
  assert.deepEqual(s.store.read().review, { at: '2026-10-23T13:00:00.000Z', day: '2026-10-23' });
  assert.deepEqual(s.alarm(), { at: '2026-10-23T22:30:00.000Z', source: 'fallback' });
  assert.equal(s.store.read().alarm?.at, '2026-10-23T22:30:00.000Z', 'saved, so a restart keeps it');
  s.timers.advance(10 * 3_600_000); await s.idle();
  assert.match(textOf(s.requests.at(-1)!), /2026-10-23 快过完了[\s\S]*休息到明早 07:30/);
  s.life.planNext({ after_minutes: 60 }, '看书');
  const own = s.alarm();
  schedule.wake = '06:00'; s.life.reschedule();
  assert.deepEqual(s.alarm(), own);
  // Changed while her world was stopped: the next start follows it.
  schedule.review = '21:30';
  s.restart(); await s.life.start();
  assert.deepEqual(s.store.read().review, { at: '2026-10-24T12:30:00.000Z', day: '2026-10-24' });
});
test('a look back missed while the app was closed comes late, for the day it belongs to', async t => {
  const s = await setup(t, () => textResponse('补上'), { before: async worldDir => {
    await writeFile(join(worldDir, 'life.json'), JSON.stringify({ version: 1, homeSessionId: 'home-0', review: { at: '2026-10-22T14:00:00.000Z', day: '2026-10-22' } }));
  } });
  await createAgent(s.ctx, 'home-0');
  await s.start();
  const text = textOf(s.requests[0]!);
  assert.match(text, /2026-10-22 快过完了[\s\S]*今天家里没有聊天记录[\s\S]*（晚了 13 小时/);
  assert.ok(!text.includes('改之前的那份'), 'no 我是谁 yet, nothing kept');
  assert.deepEqual(s.store.read().review, { at: '2026-10-23T14:00:00.000Z', day: '2026-10-23' }, 'the next one is tonight');
});
test('a late look back keeps its day\'s diary open until that turn ends', async t => {
  const written: string[] = [];
  const s = await setup(t, request => {
    // Write yesterday's diary in answer to the look back and to the partner's later ask; anything else is a plain reply.
    const last = request.messages.at(-1)!, asked = last.role === 'user' ? JSON.stringify(last.content) : '';
    const call = asked.includes('快过完了') ? 'during' : asked.includes('再改一下昨天的') ? 'after' : undefined;
    return call ? toolCall('write', { file_path: join(s.worldDir, 'diary', '2026-10-22.md') }, call) : textResponse('好');
  }, { before: async worldDir => {
    await writeFile(join(worldDir, 'life.json'), JSON.stringify({ version: 1, homeSessionId: 'home-0', review: { at: '2026-10-22T14:00:00.000Z', day: '2026-10-22' } }));
  } });
  s.ctx.tools.register(defineTool({ name: 'write', description: 'test', parameters: { file_path: { type: 'string' } }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async args => { written.push(String((args as { file_path: string }).file_path)); return 'ok'; } }));
  const home = await createAgent(s.ctx, 'home-0');
  await s.start();
  assert.equal(written.length, 1, 'written while the late look back runs');
  home.followup(userMessage('再改一下昨天的')); await s.idle();
  assert.equal(written.length, 1, 'closed once that turn ended');
  assert.match(JSON.stringify(s.requests.at(-1)!.messages), /2026-10-22 的日记已经合上了/);
});
test('started again from the console, a home without an alarm of her own is told she is back; one with her alarm waits for it', async t => {
  const back = await setup(t, () => textResponse('回来了'), { before: existingHome() });
  await createAgent(back.ctx, 'home-0');
  await back.life.start({ resumed: true }); back.timers.advance(0); await back.idle();
  assert.equal(back.requests.length, 1);
  assert.match(textOf(back.requests[0]!), /【我的时间】我回来了。伙伴把这个世界停了一阵/);
  assert.deepEqual(back.store.wakes().map(wake => wake.source), ['return']);

  // Only the morning fallback pending (say, the first wake failed): she is woken all the same.
  const fallback = await setup(t, () => textResponse('醒了'), { before: async worldDir => { await writeFile(join(worldDir, 'life.json'), JSON.stringify({ version: 1, homeSessionId: 'home-0', alarm: { at: '2026-10-24T00:00:00.000Z', note: '', setAt: '2026-10-23T02:00:00.000Z', source: 'fallback' } })); } });
  await createAgent(fallback.ctx, 'home-0');
  await fallback.life.start({ resumed: true }); fallback.timers.advance(0); await fallback.idle();
  assert.match(textOf(fallback.requests[0]!), /【我的时间】我回来了/);
  assert.deepEqual(fallback.alarm(), { at: '2026-10-24T00:00:00.000Z', source: 'fallback' }, 'the morning fallback stays');

  const waiting = await setup(t, () => textResponse('嗯'), { before: existingHome('看书') });
  await createAgent(waiting.ctx, 'home-0');
  await waiting.life.start({ resumed: true }); waiting.timers.advance(0); await waiting.idle();
  assert.ok(!waiting.requests.some(request => /我回来了/.test(textOf(request))), 'her own alarm speaks instead');
  assert.match(textOf(waiting.requests[0]!), /「看书」/);
});
test('her home\'s spending is counted per local day, and past the daily budget she is told once', async t => {
  let budget: number | undefined = 0.01;
  const usage = { inputTokens: 4000, outputTokens: 1000 };
  const s = await setup(t, request => (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk;
    yield { type: 'text-delta', index: 0, text: '嗯' } as StreamChunk;
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '嗯' } } as StreamChunk;
    yield { type: 'usage', usage } as StreamChunk;
    yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk;
    void request;
  })(), { before: existingHome('看书'), dailyBudget: () => budget });
  await createAgent(s.ctx, 'home-0');
  await s.start();
  const step = stepCost(usage, 'test', new Date('2026-10-23T03:00:00Z'));
  const spend = () => s.store.read().spend;
  assert.equal(spend()?.day, '2026-10-23');
  assert.ok(Math.abs(spend()!.yuan - step * s.requests.length) < 1e-9, String(spend()?.yuan));
  const home = s.ctx.agents.get(SessionId('home-0'))!;
  home.followup(userMessage('再聊一句')); await s.idle();
  const told = s.requests.filter(request => /过了伙伴给我定的每天 0\.01 元/.test(textOf(request)));
  assert.equal(told.length > 0, true, 'told once spending passed 0.01');
  assert.equal(spend()?.reminded, true);
  home.followup(userMessage('又一句')); await s.idle();
  assert.equal(textOf(s.requests.at(-1)!).split('过了伙伴给我定的每天').length - 1, 1, 'not told again that day');
  budget = undefined;
});
test('a home rebuilt while her own alarm is pending greets her at once, is not asked about, and the alarm still rings', async t => {
  const s = await setup(t, () => textResponse('新家'), { before: async worldDir => { await writeFile(join(worldDir, 'life.json'), JSON.stringify({
    version: 1, homeSessionId: 'archived-home', alarm: { at: '2026-10-23T04:00:00.000Z', note: '歇着', setAt: '2026-10-23T02:00:00.000Z', source: 'plan' },
  })); } });
  s.archived.add('archived-home');
  await s.start();
  assert.equal(s.requests.length, 1, 'only the greeting, no early-stop question after it');
  assert.match(textOf(s.requests[0]), /这是我的家/);
  assert.deepEqual(s.alarm(), { at: '2026-10-23T04:00:00.000Z', source: 'plan' });
  assert.equal(s.store.read().greeting, undefined);
  s.timers.advance(60 * 60_000); await s.idle();
  assert.match(textOf(s.requests.at(-1)!), /说好做到的时间：「歇着」/);
  assert.deepEqual(s.store.wakes().map(wake => wake.source), ['first', 'plan']);
});
test('an alarm that came due while the app was closed is delivered late with the delay', async t => {
  const s = await setup(t, () => textResponse('醒啦'), { before: async worldDir => {
    await writeFile(join(worldDir, 'life.json'), JSON.stringify({ version: 1, homeSessionId: 'home-0', alarm: { at: '2026-10-23T00:00:00.000Z', note: '早安', setAt: '2026-10-22T15:00:00.000Z', source: 'plan' } }));
  } });
  await createAgent(s.ctx, 'home-0');
  await s.start();
  assert.match(textOf(s.requests[0]), /「早安」。[^\n]*（晚了 3 小时/);
  assert.equal(s.store.wakes()[0].lateMs, 3 * 3_600_000);
});
test('timers run in short segments, so a wall-clock jump still delivers the alarm', async t => {
  const s = await setup(t, (_request, index) => index === 0 ? toolCall('plan_next', { after_minutes: 120, note: '午睡' }) : textResponse('醒了'));
  await s.start();
  s.timers.jump(2 * 3_600_000);
  s.timers.advance(5 * 60_000); await s.idle();
  assert.match(textOf(s.requests.at(-1)!), /「午睡」/);
});
test('retries back off on schedule even though timers run in short segments', async t => {
  let calls = 0;
  const s = await setup(t, () => textResponse('终于'), { host: host => ({ ...host, resolveAgent: id => ++calls >= 2 && calls <= 4 ? Promise.reject(new Error('home is busy')) : host.resolveAgent(id) }) });
  await s.life.start(); s.timers.advance(0); await s.idle();
  s.timers.advance(60_000); await s.idle();
  s.timers.advance(5 * 60_000); await s.idle();
  assert.ok(s.faults().some(fault => fault.includes('15 分钟后重试')));
  s.timers.advance(5 * 60_000); await s.idle(); s.timers.advance(5 * 60_000); await s.idle();
  assert.equal(s.requests.length, 0, 'a 5-minute segment does not cut the 15-minute retry short');
  s.timers.advance(5 * 60_000); await s.idle();
  assert.equal(s.requests.length, 1); assert.deepEqual(s.store.wakes().map(wake => wake.source), ['first']);
});
test('a failed delivery never fires a newer alarm before it is due', async t => {
  const { held, patch } = holdResolve(2);
  const s = await setup(t, () => textResponse('看书去'), { host: patch, before: existingHome('旧的') });
  await createAgent(s.ctx, 'home-0');
  await s.life.start(); s.timers.advance(0); await held.reached;
  s.life.planNext({ after_minutes: 30 }, '看书');
  held.fail!(new Error('home is busy')); await s.life.settled();
  s.timers.advance(60_000); await s.idle();
  assert.equal(s.store.wakes().length, 0); assert.equal(s.requests.length, 0);
  assert.deepEqual(s.alarm(), { at: '2026-10-23T03:30:00.000Z', source: 'plan' });
  s.timers.advance(29 * 60_000); await s.idle();
  assert.deepEqual(s.store.wakes().map(wake => wake.source), ['plan']);
  assert.match(textOf(s.requests[0]), /「看书」/);
});
test('plan_next while a delivery is resolving the home keeps the new alarm', async t => {
  const { held, patch } = holdResolve(2);
  const s = await setup(t, () => textResponse('好'), { host: patch, before: existingHome('旧的') });
  await createAgent(s.ctx, 'home-0');
  await s.life.start(); s.timers.advance(0); await held.reached;
  s.life.planNext({ after_minutes: 30 }, '新的');
  held.release!(); await s.idle();
  assert.equal(s.requests.length, 0, 'the replaced alarm is not delivered'); assert.equal(s.store.wakes().length, 0);
  assert.deepEqual(s.alarm(), { at: '2026-10-23T03:30:00.000Z', source: 'plan' });
  s.timers.advance(30 * 60_000); await s.idle();
  assert.deepEqual(s.store.wakes().map(wake => wake.source), ['plan']); assert.match(textOf(s.requests[0]), /「新的」/);
});
test('plan_next without a pending alarm keeps the plain text', async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const playing = new Promise<void>(resolve => { entered = resolve; });
  const s = await setup(t, (_request, index) => index === 0 ? toolCall('play_game', {}) : textResponse('好'));
  s.ctx.tools.register(testTool('play_game', async () => { entered(); await gate; return 'played'; }));
  await s.life.start(); s.timers.advance(0); await playing; await s.life.settled();
  assert.equal(s.alarm(), undefined);
  assert.equal(s.life.planNext({ after_minutes: 30 }, '看书'), '记下了，到 2026-10-23T12:30:00+09:00 提醒我。');
  release(); await s.idle();
});
test('plan_next says what it replaced, and the old note with it', async t => {
  const s = await setup(t, () => textResponse('好'));
  await s.start();
  assert.equal(s.alarm()?.source, 'fallback');
  // The plugin's own fallback is not her plan, so replacing it is not worth mentioning.
  assert.equal(s.life.planNext({ after_minutes: 30 }, ''), '记下了，到 2026-10-23T12:30:00+09:00 提醒我。');
  assert.equal(s.life.planNext({ after_minutes: 20 }, '看下一课'), '记下了，到 2026-10-23T12:20:00+09:00 提醒我。（替换了原来做到 2026-10-23T12:30:00+09:00 的安排。）');
  assert.equal(s.life.planNext({ after_minutes: 10 }, '只列检查'), '记下了，到 2026-10-23T12:10:00+09:00 提醒我。（替换了原来做到 2026-10-23T12:20:00+09:00 的安排：「看下一课」。还想留着里面的事，就写进新的 note。）');
});
test('a new alarm clears the retry fault; one that cannot be saved is a fault but still rings', async t => {
  const { held, patch } = holdResolve(2);
  let failWrites = false;
  const s = await setup(t, () => textResponse('嗯'), { host: patch, before: existingHome('旧的'), store: store => ({ ...store, write: state => { if (failWrites) throw new Error('disk full'); store.write(state); } }) });
  await createAgent(s.ctx, 'home-0');
  await s.life.start(); s.timers.advance(0); await held.reached; held.fail!(new Error('home is busy')); await s.life.settled();
  assert.ok(s.faults().some(fault => fault.includes('分钟后重试')));
  s.life.planNext({ after_minutes: 10 }, '再来');
  assert.ok(!s.faults().some(fault => fault.includes('分钟后重试')));
  failWrites = true;
  assert.throws(() => s.life.planNext({ after_minutes: 20 }, '存不下'), /disk full/);
  assert.ok(s.faults().some(fault => fault.startsWith('闹钟没能保存：')));
  s.timers.advance(20 * 60_000); await s.idle();
  assert.match(textOf(s.requests.at(-1)!), /「存不下」/);
});
test('an alarm that was steered counts as delivered even when recording it fails', async t => {
  let failing = false;
  const s = await setup(t, () => textResponse('嗯'), { store: store => ({
    ...store,
    write: state => { if (failing) throw new Error('disk full'); store.write(state); },
    appendWake: record => { if (failing) throw new Error('disk full'); store.appendWake(record); },
  }) });
  await s.start();
  failing = true;
  await s.untilMorning();
  assert.equal(s.requests.length, 3);
  assert.ok(s.faults().some(fault => fault.startsWith('生活状态没能保存：')));
  s.timers.advance(60_000); await s.idle(); s.timers.advance(5 * 60_000); await s.idle();
  assert.equal(s.requests.length, 3, 'not retried');
});
test('a fallback alarm that cannot be saved becomes a fault instead of breaking the turn', async t => {
  let failWrites = false;
  const s = await setup(t, () => textResponse('嗯'), {
    before: async worldDir => { await writeFile(join(worldDir, 'life.json'), JSON.stringify({ version: 1, homeSessionId: 'home-0' })); },
    store: store => ({ ...store, write: state => { if (failWrites) throw new Error('disk full'); store.write(state); } }),
  });
  await createAgent(s.ctx, 'home-0');
  await s.start();
  assert.equal(s.life.snapshot().alarm?.source, 'fallback');
  failWrites = true;
  await s.untilMorning();
  assert.deepEqual(s.errors, []); assert.equal(s.requests.length, 2);
  assert.ok(s.faults().some(fault => fault.startsWith('断线保护闹钟没能保存：')));
  assert.equal(s.life.snapshot().alarm?.source, 'fallback');
  await s.untilMorning();
  assert.equal(s.requests.length, 4);
  assert.match(textOf(s.requests.at(-1)!), /没说接下来做什么/, 'the unsaved fallback still rings in this run');
});
test('a failing rename is a fault and retries on the same session', async t => {
  // Creation, the greeting's reopen and its first-turn rename fail; the next resolve retries.
  let renameFails = 3;
  const s = await setup(t, () => textResponse('嗯'), { host: host => ({
    ...host,
    rename: async (id, title) => { if (renameFails-- > 0) throw new Error('rename refused'); await host.rename(id, title); },
  }) });
  await s.life.start();
  s.timers.advance(0); await s.idle();
  const home = s.life.snapshot().homeSessionId!;
  assert.equal(s.created(), 1);
  assert.ok(s.faults().some(fault => fault.startsWith('家改名失败：')));
  assert.deepEqual(s.store.wakes().map(wake => wake.source), ['first']);
  await s.untilMorning();
  assert.equal(s.created(), 1); assert.equal(s.renamed.get(home), '鲸鲸的家');
  assert.ok(!s.faults().some(fault => fault.startsWith('家改名失败：')));
});
test('a reloaded runtime replaces the old registrations instead of stacking them', async t => {
  const s = await setup(t, () => textResponse('嗯'));
  const chat = await createAgent(s.ctx, 'chat');
  await s.start();
  const second = s.restart(); await second.start();
  await s.untilMorning();
  const home = toolNames(s.requests.at(-1)!);
  assert.equal(count(home, 'plan_next'), 1); assert.equal(count(home, 'reach_out'), 1); assert.equal(count(home, 'read_diary'), 0);
  chat.followup(userMessage('hi')); await chat.whenIdle();
  assert.equal(count(toolNames(s.requests.at(-1)!), 'plan_next'), 1); assert.equal(count(toolNames(s.requests.at(-1)!), 'reach_out'), 0); assert.equal(count(toolNames(s.requests.at(-1)!), 'read_diary'), 0);
  assert.deepEqual(s.errors, []);
});
test('stop ends the life line: no delivery after it, and plan_next refuses', async t => {
  const { held, patch } = holdResolve(2);
  const s = await setup(t, () => textResponse('嗯'), { host: patch });
  await s.life.start();
  s.timers.advance(0); await held.reached;
  s.life.stop(); held.release!(); await s.idle();
  assert.equal(s.requests.length, 0); assert.equal(s.store.wakes().length, 0);
  assert.equal(s.store.read().greeting?.kind, 'arrival', 'the undelivered greeting stays saved');
  assert.throws(() => s.life.planNext({ after_minutes: 5 }, '还想'), /生活线已停止/);
});
test('a registration failure is a fault and never breaks agent creation', async t => {
  const s = await setup(t, () => textResponse('嗯'), { before: async worldDir => { await writeFile(join(worldDir, 'life.json'), JSON.stringify({ version: 1, homeSessionId: 'clash' })); } });
  s.ctx.on('agent/created', ({ agent }) => { if (agent.id === 'clash') agent.ctx.tools.register(testTool('plan_next', async () => 'x')); return undefined; });
  const clash = await createAgent(s.ctx, 'clash');
  assert.ok(clash);
  await s.start().catch(() => undefined);
  assert.ok(s.faults().some(fault => fault.startsWith('工具挂载失败：')));
});
test('home tool calls are logged with the outside-room flag and their outcome', async t => {
  const s = await setup(t, (_request, index) => index === 0 ? toolCall('pwsh', { command: 'Start-Process notepad' }) : index === 1 ? toolCall('broken', {}) : textResponse('写好了'));
  s.ctx.tools.register(testTool('pwsh', async () => 'ok'));
  s.ctx.tools.register(testTool('broken', async () => { throw new Error('boom'); }));
  await s.start();
  const [day] = s.store.activityDays();
  assert.deepEqual(s.store.activity(day).map(record => [record.tool, record.summary, record.outside, record.status]), [['pwsh', 'Start-Process notepad', true, 'ok'], ['broken', '{}', false, 'error']]);
});
test('compactions in world sessions are recorded for the console', async t => {
  const s = await setup(t, request => request.purpose === 'compaction' ? textResponse('摘要') : textResponse('reply ' + 'detail '.repeat(100)));
  await s.ctx.plugin(TokenMeter).await();
  await s.ctx.plugin(ToolFreeCompaction, { auto: false, timeZone: 'UTC', headroomTokens: 0, maxTokens: 128 }).await();
  await s.start();
  const home = s.ctx.agents.get(SessionId(s.life.snapshot().homeSessionId!))!;
  assert.ok(await s.ctx.compaction.compactNow(home, new AbortController().signal));
  assert.equal(s.store.compactions().length, 1); assert.equal(s.store.compactions()[0].ok, true);
  assert.ok((s.store.compactions()[0].shadowedTokens ?? 0) > 0);
});
test('a compaction log that cannot be written is a fault', async t => {
  const s = await setup(t, request => request.purpose === 'compaction' ? textResponse('摘要') : textResponse('reply ' + 'detail '.repeat(100)), { store: store => ({ ...store, appendCompaction: () => { throw new Error('disk full'); } }) });
  await s.ctx.plugin(TokenMeter).await();
  await s.ctx.plugin(ToolFreeCompaction, { auto: false, timeZone: 'UTC', headroomTokens: 0, maxTokens: 128 }).await();
  await s.start();
  const home = s.ctx.agents.get(SessionId(s.life.snapshot().homeSessionId!))!;
  assert.ok(await s.ctx.compaction.compactNow(home, new AbortController().signal));
  assert.ok(s.faults().some(fault => fault.startsWith('压缩记录写入失败：')));
});
test('reach_out reaches the outlets with her name, and a failed push there is a fault until one works', async t => {
  const sent: unknown[] = []; let fails = true;
  const s = await setup(t, (_request, index) => index === 0 ? toolCall('reach_out', { text: '想你了' }) : index === 1 ? toolCall('reach_out', { text: '又想你了' }, 'second') : textResponse('嗯'), {
    notifier: { toast: async () => {}, outlets: [{ name: '桌面应用', kinds: ['reach'], send: async push => { sent.push(push); if (fails) { fails = false; throw new Error('connect ECONNREFUSED'); } } }] },
  });
  const faults: string[][] = [];
  s.ctx.on('session/event', (_session, event) => { if (event.type === 'tool/result') faults.push(s.faults()); });
  await s.start();
  assert.deepEqual(sent, [{ text: '想你了', kind: 'reach', name: '鲸鲸' }, { text: '又想你了', kind: 'reach', name: '鲸鲸' }]);
  assert.deepEqual(faults[0], ['桌面应用没送到：connect ECONNREFUSED']);
  assert.ok(!s.faults().some(fault => fault.startsWith('桌面应用')), 'cleared by the next push that works');
});
test('home() opens the same home the alarm uses', async t => {
  const s = await setup(t, () => textResponse('嗯'));
  await s.start();
  assert.equal((await s.life.home()).id, s.life.snapshot().homeSessionId);
  assert.equal(s.created(), 1);
});
test('check_alarm tells her what is next; cancel_alarm puts her own alarm back to the morning fallback', async t => {
  const s = await setup(t, () => textResponse('嗯'));
  await s.start();
  assert.ok(['check_alarm', 'cancel_alarm'].every(name => toolNames(s.requests[0]!).includes(name)));
  assert.equal(s.life.checkAlarm(), '我现在没有自己定的闹钟。下一次会在 2026-10-24T09:00:00+09:00（还有 21 小时）按平常的时间叫我。');
  s.life.planNext({ after_minutes: 90 }, '看 B 站');
  assert.equal(s.life.checkAlarm(), '我说好做「看 B 站」做到 2026-10-23T13:30:00+09:00（还有 1 小时 30 分）。');
  assert.equal(s.life.cancelAlarm(), '取消了做到 2026-10-23T13:30:00+09:00 的安排：「看 B 站」。不另定的话，我就休息到 2026-10-24T09:00:00+09:00。');
  assert.deepEqual(s.alarm(), { at: '2026-10-24T00:00:00.000Z', source: 'fallback' });
  assert.equal(s.life.cancelAlarm(), '现在没有我自己定的闹钟，不用取消。下一次会在 2026-10-24T09:00:00+09:00 按平常的时间叫我。');
  assert.deepEqual(s.alarm(), { at: '2026-10-24T00:00:00.000Z', source: 'fallback' });
});
test('a world alarm.md shapes the wake messages and the tool descriptions; an unreadable one is a fault and the shipped wording is used', async t => {
  const s = await setup(t, () => textResponse('嗯'), { before: dir => writeFile(join(dir, 'alarm.md'), '## 第一次到家\n你好呀{{name}}，{{partner}}给你搭了个家。\n## plan_next 说明\n自己定的说明，例如 {{example}}\n') });
  await s.start();
  assert.match(textOf(s.requests[0]!), /【我的时间】你好呀鲸鲸，伙伴给你搭了个家。\n接下来想做什么，用 plan_next 说好做到几点/);
  assert.equal(s.requests[0]!.tools?.find(tool => tool.name === 'plan_next')?.description, '自己定的说明，例如 2026-10-23T21:00:00+09:00');
  assert.ok(!s.faults().some(fault => fault.includes('闹钟模板')));

  const broken = await setup(t, () => textResponse('嗯'), { before: dir => mkdir(join(dir, 'alarm.md')) });
  await broken.start();
  assert.match(textOf(broken.requests[0]!), /【我的时间】这是我的家。/);
  assert.ok(broken.faults().some(fault => /闹钟模板 .* 读不了，先用默认的/.test(fault)), broken.faults().join('|'));
});
test('group facts follow a custom alarm section without rewriting the file or waking an extra turn', async t => {
  const own = '## 闹钟响了\n我自己的闹钟措辞。\n';
  let facts: string | undefined = '微信：「家人」37 条未读，最后是爸爸（20 分钟前）';
  const s = await setup(t, () => textResponse('嗯'), { before: dir => writeFile(join(dir, 'alarm.md'), own), alarmContext: () => facts });
  await s.start();
  assert.doesNotMatch(textOf(s.requests.at(-1)!), /37 条未读/, 'the greeting is not a group wake');
  const before = s.requests.length;
  s.life.planNext({ after_minutes: 1 }, '读一会书');
  assert.equal(s.requests.length, before);
  s.timers.advance(60_000); await s.idle();
  assert.equal(s.requests.length, before + 1);
  assert.match(textOf(s.requests.at(-1)!), /我自己的闹钟措辞。[\s\S]*微信：「家人」37 条未读/);
  assert.equal(await readFile(join(s.worldDir, 'alarm.md'), 'utf8'), own);
  facts = undefined; s.life.planNext({ after_minutes: 1 }, '接着读');
  s.timers.advance(60_000); await s.idle();
  const latest = s.requests.at(-1)!.messages.at(-1)!;
  assert.doesNotMatch(JSON.stringify(latest), /微信：/);
});
test('an alarm set from a chat session rings at home, not in the chat', async t => {
  const sessionOf = (request: GenerateOptions) => (request as { sessionId?: string }).sessionId;
  let asked = false;
  const s = await setup(t, request => {
    if (sessionOf(request) === 'chat' && !asked) { asked = true; return toolCall('plan_next', { after_minutes: 30, note: '提醒伙伴喝水' }); }
    return textResponse('嗯');
  });
  await s.start();
  const chat = await createAgent(s.ctx, 'chat');
  chat.followup(userMessage('半小时后提醒我喝水')); await chat.whenIdle();
  assert.equal(s.alarm()?.source, 'plan');
  const before = s.requests.length;
  s.timers.advance(30 * 60_000); await s.idle();
  const home = s.life.snapshot().homeSessionId!;
  const rung = s.requests.slice(before).filter(request => sessionOf(request) === home);
  assert.equal(rung.length, 1);
  assert.match(textOf(rung[0]!), /【我的时间】[^ ]+ 到了，这是我说好做到的时间：「提醒伙伴喝水」/);
  assert.ok(!s.requests.slice(before).some(request => sessionOf(request) === 'chat'));
});

/** A pre-step that holds (or fails) the first step carrying a word of the plugin's own, like a host still starting. */
function holdLifeStep(ctx: Context) {
  let release!: (outcome: 'run' | 'fail') => void;
  let reach!: () => void;
  const reached = new Promise<void>(resolve => { reach = resolve; });
  const outcome = new Promise<'run' | 'fail'>(resolve => { release = resolve; });
  let held = false;
  const dispose = ctx.on('agent/pre-step', async (payload, next) => {
    if (held || !payload.messages.some(message => message.source.kind === 'dsh-world-life')) return next();
    held = true; reach();
    if (await outcome === 'fail') throw new Error('host still starting');
    return next();
  }, { prepend: true });
  return { reached, release, dispose };
}
const lifeJson = async (worldDir: string) => JSON.parse(await readFile(join(worldDir, 'life.json'), 'utf8'));

test('an alarm whose turn takes it in but never starts a step goes back on the schedule and is sent again', async t => {
  const s = await setup(t, () => textResponse('嗯'), { before: existingHome('写日记') });
  await createAgent(s.ctx, 'home-0');
  const hold = holdLifeStep(s.ctx); t.after(hold.dispose);
  hold.release('fail');
  await s.start();
  assert.deepEqual(s.store.wakes(), [], 'not counted as delivered');
  assert.deepEqual(s.alarm(), { at: '2026-10-23T03:00:00.000Z', source: 'plan' }, 'her alarm is back, not replaced by the morning fallback');
  assert.ok(s.faults().some(fault => /^闹钟没开始，1 分钟后重新送：那一轮没开始就结束了（error）/.test(fault)), s.faults().join('|'));
  s.timers.advance(60_000); await s.idle();
  assert.deepEqual(s.store.wakes().map(wake => wake.source), ['plan']);
  assert.ok(!s.faults().some(fault => /闹钟/.test(fault)), s.faults().join('|'));
  assert.equal((await lifeJson(s.worldDir)).delivering, undefined);
  assert.match(textOf(s.requests.at(-1)!), /「写日记」/);
});

test('a word stuck before its first step is reported, and after a restart it is sent again unless it ran', async t => {
  for (const ran of [false, true]) {
    const s = await setup(t, () => textResponse('嗯'), { before: existingHome('看书') });
    const home = await createAgent(s.ctx, 'home-0');
    const hold = holdLifeStep(s.ctx); t.after(hold.dispose);
    await s.life.start(); s.timers.advance(0); await hold.reached;
    assert.equal((await lifeJson(s.worldDir)).delivering.what, '闹钟', 'written before the steer, so a crash still finds it');
    assert.deepEqual(s.store.wakes(), []);
    s.timers.advance(5 * 60_000);
    assert.ok(s.faults().some(fault => /^闹钟在 12:00 送进了家，5 分钟了这一轮还没开始$/.test(fault)), s.faults().join('|'));
    // The app goes away with the turn still open; whatever happens next is seen only from the log.
    const next = s.restart();
    hold.release(ran ? 'run' : 'fail'); await home.whenIdle();
    const before = s.requests.length;
    await next.start(); s.timers.advance(0); await s.idle();
    if (ran) {
      assert.deepEqual(s.store.wakes().map(wake => wake.source), ['plan'], 'counted once it is known to have run');
      assert.equal(s.requests.length, before, 'not sent twice');
    } else {
      assert.deepEqual(s.store.wakes(), []);
      assert.ok(s.faults().some(fault => /^闹钟没开始，1 分钟后重新送：上次那一轮没开始就中断了/.test(fault)), s.faults().join('|'));
      s.timers.advance(60_000); await s.idle();
      assert.deepEqual(s.store.wakes().map(wake => wake.source), ['plan']);
      assert.match(textOf(s.requests.at(-1)!), /「看书」/);
    }
    assert.ok(!s.faults().some(fault => /这一轮还没开始/.test(fault)));
  }
});
