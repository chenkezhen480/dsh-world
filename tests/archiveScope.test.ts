import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { createWorldSwitch } from '../src/worldSwitch.ts';
import { createArchiveSelection, createWorkspaceMembership } from '../src/archiveSelection.ts';
import { createArchiveStore } from '../src/store.ts';
import { createHistory } from '../src/history.ts';
import { record } from './fixtures.ts';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { hostFixture, textResponse } from './hostFixture.ts';
import { createWorldRuntime } from '../src/runtime.ts';

test('saving archive scope requires restart and preserves the active scope until then', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dw-scope-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const settings = createWorldSwitch(dir, 'home');
  assert.equal(settings.archiveScope(), 'home');
  settings.setArchiveScope('workspace');
  assert.equal(settings.archiveScope(), 'home');
  assert.equal(settings.selectedArchiveScope(), 'workspace');
  assert.equal(settings.restartRequired(), true);
  const restarted = createWorldSwitch(dir, 'home');
  assert.equal(restarted.archiveScope(), 'workspace');
  assert.equal(restarted.restartRequired(), false);
  settings.setArchiveScope('home');
  assert.equal(settings.restartRequired(), false);
});

test('workspace scope uses the workspace owning home, includes groups and ignores presets', () => {
  const ctx = new Context();
  ctx.provide('workspaceRegistry', { list: () => [
    { path: 'room', sessionIds: ['home', 'family', 'another-preset'] },
    { path: 'other', sessionIds: ['unrelated'] },
  ] });
  const includes = createArchiveSelection(ctx, 'workspace', id => id === 'home', 'room');
  for (const id of ['home', 'family', 'another-preset']) assert.equal(includes(id), true);
  assert.equal(includes('unrelated'), false);
  const onlyHome = createArchiveSelection(ctx, 'home', id => id === 'home', 'room');
  assert.equal(onlyHome('home'), true); assert.equal(onlyHome('family'), false);
});

test('a home also left in an older workspace does not pull that workspace into her archive', () => {
  const ctx = new Context();
  // Moving a home into her room adds it there; the host keeps it in the workspace it came from, listed first.
  ctx.provide('workspaceRegistry', { list: () => [
    { path: 'default-workspace', sessionIds: ['home', 'coding'] },
    { path: 'room', sessionIds: ['home', 'family'] },
  ] });
  const archived = createArchiveSelection(ctx, 'workspace', id => id === 'home', 'room');
  for (const id of ['home', 'family']) assert.equal(archived(id), true, id);
  assert.equal(archived('coding'), false);
});

test('workspace membership follows the room path only and is empty until the host has workspaces', () => {
  const ctx = new Context();
  const inWorkspace = createWorkspaceMembership(ctx, 'room');
  assert.equal(inWorkspace('home'), false, 'no registry yet: outside, not an error');
  ctx.provide('workspaceRegistry', { list: () => [
    { path: 'elsewhere', sessionIds: ['home'] },
    { path: 'room', sessionIds: ['family'] },
  ] });
  assert.equal(inWorkspace('family'), true);
  assert.equal(inWorkspace('home'), false, 'a home recorded in another workspace does not pull it in');
});

test('narrowing memory filters old broader archive records without deleting them', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dw-history-scope-'));
  const store = createArchiveStore({ root, worldId: 'fish', agentPreset: 'test', timeZone: 'UTC' });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  await store.commitRecords([
    record('home', { sourceSessionId: 'home', turnId: 'home:1', occurredAt: '2026-10-25T01:00:00Z' }),
    record('group', { sourceSessionId: 'family', turnId: 'family:1', occurredAt: '2026-10-26T01:00:00Z' }),
  ]);
  const turns = await createHistory(store).loadRecentTurns(200, id => id === 'home');
  assert.deepEqual(turns.map(turn => turn.turnId), ['home:1']);
  assert.equal(store.stats().records, 2);
});

test('workspace injection excludes other workspaces and subagents while home-only archive still reaches workspace chats', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, request => { requests.push(request); return textResponse('ok'); });
  const config = { worldId: 'fish', agentPreset: 'companion', timeZone: 'UTC', archiveScope: 'home' as const };
  const store = createArchiveStore({ ...config, root }); cleanup.push(() => store.close());
  await store.commitRecords([record('seed', { sourceSessionId: 'home', content: 'WORKSPACE_PRIVATE_MEMORY' })]);
  ctx.provide('workspaceRegistry', { list: () => [{ path: 'room', sessionIds: ['home', 'chat', 'child'] }, { path: 'other', sessionIds: ['outside'] }] });
  const runtime = createWorldRuntime(ctx, config, store, { prompt: { names: { companion: '鱼', partner: '我' } }, isHome: id => id === 'home', inWorkspace: createArchiveSelection(ctx, 'workspace', id => id === 'home', 'room') });
  cleanup.push(() => runtime.stop()); await runtime.start();
  for (const id of ['outside', 'chat', 'child']) {
    const { agent } = await ctx.agents.create({ sessionId: SessionId(id), meta: { agentPreset: 'companion', ...(id === 'child' ? { origin: 'subagent' as const } : {}) }, agentOptions: { provider: 'test', model: 'test' } });
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: id + '-original' }] })); await agent.whenIdle();
    const request = JSON.stringify(requests.at(-1)!.messages);
    if (id === 'chat') assert.match(request, /WORKSPACE_PRIVATE_MEMORY/);
    else assert.doesNotMatch(request, /WORKSPACE_PRIVATE_MEMORY|我的世界/);
  }
  await runtime.flush();
  assert.deepEqual((await store.readPage({ limit: 100 })).records.map(row => row.content), ['WORKSPACE_PRIVATE_MEMORY']);
  assert.deepEqual(errors, []);
});

test('restart retires leaked plugin memory from outside and inherited sessions without deleting conversation or archive', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, request => { requests.push(request); return textResponse('ok'); });
  const config = { worldId: 'fish', agentPreset: 'companion', timeZone: 'UTC' };
  const store = createArchiveStore({ ...config, root }); cleanup.push(() => store.close());
  await store.commitRecords([record('seed', { content: 'DURABLE_PRIVATE_MEMORY' })]);
  const options = { provider: 'test', model: 'test' };
  const handles = [];
  for (const [id, agentPreset] of [['outside', 'companion'], ['inherited', 'other']] as const) {
    const handle = await ctx.agents.create({ sessionId: SessionId(id), meta: { agentPreset, ...(id === 'inherited' ? { origin: 'subagent' as const } : {}) }, agentOptions: options }); handles.push(handle);
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'ORIGINAL_' + id }] })); await handle.agent.whenIdle();
    handle.agent.session.append('user/message', createUserMessage({ source: { kind: 'dsh-world-history', form: 'recall' }, content: [{ type: 'text', text: 'OLD_LEAKED_PRIVATE_MEMORY' }] }), { surfaceOp: 'append' });
    await ctx.sessions.flush(handle.agent.session);
  }
  await handles[0].dispose();
  const runtime = createWorldRuntime(ctx, config, store, { prompt: { names: { companion: '鱼', partner: '我' } }, isHome: () => false, inWorkspace: () => false });
  cleanup.push(() => runtime.stop()); await runtime.start();
  handles[0] = await ctx.agents.resume({ resumeSessionId: SessionId('outside'), agentOptions: options });
  for (const handle of handles) {
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'after restart' }] })); await handle.agent.whenIdle();
    const request = JSON.stringify(requests.at(-1)!.messages);
    assert.doesNotMatch(request, /OLD_LEAKED_PRIVATE_MEMORY|DURABLE_PRIVATE_MEMORY|dsh-world-history/);
    assert.match(request, /ORIGINAL_/);
    assert.ok(handle.agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'dsh-world-history'), 'original durable log retained');
  }
  assert.ok((await store.readPage({ limit: 100 })).records.some(row => row.content === 'DURABLE_PRIVATE_MEMORY'));
  assert.deepEqual(errors, []);
});

test('an old memory block the persisted log read does not list is still retired from the surface, so the session is never blocked over and over', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, request => { requests.push(request); return textResponse('ok'); });
  const config = { worldId: 'fish', agentPreset: 'standard', timeZone: 'UTC' };
  const store = createArchiveStore({ ...config, root }); cleanup.push(() => store.close());
  const options = { provider: 'test', model: 'test' };
  const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
  // A work session (not in the room workspace) that an older version had injected a memory block into.
  const made = await ctx.agents.create({ sessionId: SessionId('work'), meta: { agentPreset: 'standard' }, agentOptions: options });
  made.agent.followup(user('WORK_ONE')); await made.agent.whenIdle();
  made.agent.session.append('user/message', createUserMessage({ source: { kind: 'dsh-world-history', form: 'recall' }, content: [{ type: 'text', text: 'OLD_0_5_MEMORY' }] }), { surfaceOp: 'append' });
  made.agent.followup(user('WORK_TWO')); await made.agent.whenIdle();
  await ctx.sessions.flush(made.agent.session); await made.dispose();
  // Whatever the reason in a real profile, the read of the stored log does not list that block. Retiring must not depend on it.
  const persistence = ctx.sessionPersistence as unknown as { open(...args: unknown[]): Promise<object> };
  const original = persistence.open.bind(persistence);
  persistence.open = async (...args: unknown[]) => {
    const handle = await original(...args);
    if (args[1] !== 'read') return handle;
    return new Proxy(handle, { get(target, prop) { if (prop === 'read') return async () => ({ events: [] }); const value = (target as Record<string | symbol, unknown>)[prop]; return typeof value === 'function' ? value.bind(target) : value; } });
  };
  const runtime = createWorldRuntime(ctx, config, store, { prompt: { names: { companion: '鱼', partner: '我' } }, isHome: () => false, inWorkspace: () => false });
  cleanup.push(() => runtime.stop()); await runtime.start();
  const { agent } = await ctx.agents.resume({ resumeSessionId: SessionId('work'), agentOptions: options });
  persistence.open = original;
  for (const text of ['after upgrade', 'send again', 'and again']) {
    requests.length = 0;
    agent.followup(user(text)); await agent.whenIdle();
    assert.equal(requests.length, 1, `"${text}" reached the model`);
    assert.doesNotMatch(JSON.stringify(requests[0]!.messages), /OLD_0_5_MEMORY|dsh-world-history/);
  }
  assert.ok(!agent.session.snapshotEvents().some(event => event.type === 'turn/end' && event.data.reason.kind === 'error' && event.data.reason.error?.code === 'DSH_WORLD_SCOPE_CHANGED'), 'never told to send again');
  assert.ok(agent.session.deriveMessages().every(message => message.source.kind !== 'dsh-world-history'));
  assert.deepEqual(errors, []);
});

for (const retained of [false, true]) test(`workspace removal during history loading discards ${retained ? 'retained' : 'new'} private memory before dispatch`, async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, request => { requests.push(request); return textResponse('ok'); });
  const config = { worldId: 'fish', agentPreset: 'companion', timeZone: 'UTC' };
  const store = createArchiveStore({ ...config, root }); cleanup.push(() => store.close());
  await store.commitRecords([record('seed', { content: 'PRIVATE_MEMORY_AFTER_REMOVAL' })]);
  let membership = true;
  const source = { prompt: { names: { companion: '鱼', partner: '我' } }, isHome: () => false, inWorkspace: () => membership };
  let runtime = createWorldRuntime(ctx, config, store, source); await runtime.start(); cleanup.push(() => runtime.stop());
  const { agent } = await ctx.agents.create({ sessionId: SessionId('racing'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  if (retained) {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'before restart' }] })); await agent.whenIdle();
    await runtime.stop(); runtime = createWorldRuntime(ctx, config, store, source); await runtime.start(); requests.length = 0;
  }
  let entered!: () => void; const reading = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const readPage = store.readPage;
  store.readPage = async query => { const page = await readPage(query); entered(); await gate; return page; };
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'ORIGINAL_DURING_REMOVAL' }] }));
  await reading; membership = false; release(); await agent.whenIdle();
  assert.ok(requests.every(request => !JSON.stringify(request.messages).includes('PRIVATE_MEMORY_AFTER_REMOVAL')));
  assert.ok(agent.session.deriveMessages().every(message => message.source.kind !== 'dsh-world-history'));
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'outside retry' }] })); await agent.whenIdle();
  assert.match(JSON.stringify(requests.at(-1)!.messages), /ORIGINAL_DURING_REMOVAL/);
  assert.doesNotMatch(JSON.stringify(requests.at(-1)!.messages), /PRIVATE_MEMORY_AFTER_REMOVAL/);
});

test('when the guard blocks a request it logs why: the reasons, the session and the memory nodes still on it, never their text', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, request => { requests.push(request); return textResponse('ok'); });
  const warnings: string[] = [];
  const logger = ctx.logger as unknown as { warn(...args: unknown[]): void };
  const warn = logger.warn.bind(logger);
  logger.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); warn(...args); };
  const config = { worldId: 'fish', agentPreset: 'companion', timeZone: 'UTC' };
  const store = createArchiveStore({ ...config, root }); cleanup.push(() => store.close());
  await store.commitRecords([record('seed', { content: 'PRIVATE_MEMORY_TEXT_MUST_NOT_BE_LOGGED' })]);
  let membership = true;
  const runtime = createWorldRuntime(ctx, config, store, { prompt: { names: { companion: '鱼', partner: '我' } }, isHome: () => false, inWorkspace: () => membership });
  await runtime.start(); cleanup.push(() => runtime.stop());
  const { agent } = await ctx.agents.create({ sessionId: SessionId('racing'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  // She leaves the workspace after the request was put together (memory block and world prompt included), just before it is sent.
  let flipped = false;
  ctx.on('llm/stream', async function* (_request, next) { if (!flipped) { flipped = true; membership = false; } yield* next(); }, { prepend: true });
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'ORIGINAL' }] }));
  await agent.whenIdle();
  const blocked = warnings.filter(line => line.includes('DSH_WORLD_SCOPE_CHANGED') || line.includes('离开了世界工作区'));
  assert.equal(blocked.length, 1, warnings.join(' | '));
  const line = blocked[0]!;
  assert.match(line, /racing/); assert.match(line, /companion/);
  assert.match(line, /请求里还带着 1 条世界记忆块/); assert.match(line, /世界提示还挂在会话上/);
  assert.match(line, /退役后会话表面上仍有的记忆节点：无/);
  assert.doesNotMatch(line, /PRIVATE_MEMORY_TEXT_MUST_NOT_BE_LOGGED/);
  assert.equal(requests.length, 0, 'nothing reached the model');
});

test('restart discovers cold workspace sessions and replaces an older broad memory block', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, request => { requests.push(request); return textResponse('ok'); });
  const config = { worldId: 'fish', agentPreset: 'companion', timeZone: 'UTC', archiveScope: 'workspace' as const };
  const store = createArchiveStore({ ...config, root }); cleanup.push(() => store.close());
  const included = new Set(['home', 'family', 'different']);
  const agents = [];
  const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
  for (const id of ['home', 'family', 'different', 'foreign']) {
    const { agent } = await ctx.agents.create({ sessionId: SessionId(id), meta: { agentPreset: id === 'different' ? 'other' : 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
    agent.followup(user(id + '-original')); await agent.whenIdle(); await ctx.sessions.flush(agent.session); agents.push(agent);
  }
  const source = { prompt: { names: { companion: '鱼', partner: '我' } }, isHome: (id: string) => id === 'home', archiveSession: (id: string) => included.has(id) };
  const broad = createWorldRuntime(ctx, config, store, source); await broad.start();
  const archived = (await store.readPage({ limit: 100 })).records.map(row => row.content);
  for (const text of ['home-original', 'family-original', 'different-original']) assert.ok(archived.includes(text), text);
  assert.ok(!archived.includes('foreign-original'));
  const home = agents[0]; home.followup(user('first home request')); await home.whenIdle(); await broad.flush();
  assert.match(JSON.stringify(requests.at(-1)?.messages.filter(message => message.source?.kind === 'dsh-world-history')), /family-original/);
  await broad.stop();
  const narrow = createWorldRuntime(ctx, { ...config, archiveScope: 'home' }, store, { ...source, archiveSession: source.isHome });
  cleanup.push(() => narrow.stop()); await narrow.start();
  home.followup(user('after restart')); await home.whenIdle();
  await narrow.flush();
  const blocks = requests.at(-1)!.messages.filter(message => message.source?.kind === 'dsh-world-history');
  assert.ok(blocks.length <= 1);
  assert.doesNotMatch(JSON.stringify(blocks), /family-original|different-original|foreign-original/);
  assert.ok((await store.readPage({ limit: 100 })).records.some(row => row.content === 'family-original'), 'old archive retained');
});
