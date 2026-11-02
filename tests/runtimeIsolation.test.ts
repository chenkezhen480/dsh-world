import assert from 'node:assert/strict';
import test from 'node:test';
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createWorldRuntime } from '../src/runtime.ts';
import { createArchiveStore } from '../src/store.ts';
import { hostFixture, textResponse } from './hostFixture.ts';

const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
test('hot reload isolates an active corrupt session, keeps healthy turns running and retries the repaired session', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, request => { requests.push(request); return textResponse('healthy reply'); });
  const config = { worldId: 'fish', agentPreset: 'companion', timeZone: 'UTC' };
  const store = createArchiveStore({ ...config, root }); cleanup.push(() => store.close());
  const make = async (id: string) => (await ctx.agents.create({ sessionId: SessionId(id), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } })).agent;
  const bad = await make('bad'), good = await make('good');
  bad.followup(user('before reload')); await bad.whenIdle(); await ctx.sessions.flush(bad.session);
  const persistence = ctx.sessionPersistence, open = persistence.open.bind(persistence);
  let broken = true;
  persistence.open = async (id, mode) => {
    if (id === bad.id && mode === 'read' && broken) throw Object.assign(new Error('stored log is corrupt'), { name: 'SessionFormatError' });
    return open(id, mode);
  };
  cleanup.push(() => { persistence.open = open; });
  const world = createWorldRuntime(ctx, config, store); cleanup.push(() => world.stop());
  await world.start();
  assert.ok(world.faults().some(message => /bad.*记忆初始化/.test(message)));
  good.followup(user('healthy after reload')); await good.whenIdle(); await world.flush();
  assert.equal(requests.length, 2); assert.equal(errors.length, 0);
  assert.ok((await store.readPage({ worldId: 'fish', limit: 10 })).records.some(record => record.content === 'healthy after reload'));
  bad.followup(user('still broken')); await bad.whenIdle();
  assert.equal(requests.length, 2, 'a broken session must fail its own turn rather than run without memory');
  assert.equal(errors.length, 1);
  broken = false;
  bad.followup(user('repaired now')); await bad.whenIdle(); await world.flush();
  assert.equal(requests.length, 3); assert.deepEqual(world.faults(), []);
});

test('sessions that can never carry her world are not read, tracked or reported', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, request => { requests.push(request); return textResponse('reply'); });
  const config = { worldId: 'fish', agentPreset: 'companion', timeZone: 'UTC' };
  const store = createArchiveStore({ ...config, root }); cleanup.push(() => store.close());
  const persistence = ctx.sessionPersistence, open = persistence.open.bind(persistence);
  const reads: string[] = [];
  persistence.open = async (id, mode) => { if (mode === 'read') reads.push(id); return open(id, mode); };
  cleanup.push(() => { persistence.open = open; });
  const world = createWorldRuntime(ctx, config, store); cleanup.push(() => world.stop());
  await world.start();
  const coding = (await ctx.agents.create({ sessionId: SessionId('coding'), meta: { agentPreset: 'other' }, agentOptions: { provider: 'test', model: 'test' } })).agent;
  const helper = (await ctx.agents.create({ sessionId: SessionId('helper'), meta: { agentPreset: 'companion', origin: 'subagent', delegationDepth: 1 }, agentOptions: { provider: 'test', model: 'test' } })).agent;
  for (const agent of [coding, helper]) { agent.followup(user('work')); await agent.whenIdle(); }
  assert.equal(requests.length, 2);
  assert.deepEqual(reads.filter(id => id === 'coding' || id === 'helper'), []);
  assert.deepEqual(world.faults(), []);
  assert.equal(errors.length, 0);
});

test('a new world session the store cannot read yet is still created, and its memory comes with the first request (#27)', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, request => { requests.push(request); return textResponse('reply'); });
  const config = { worldId: 'fish', agentPreset: 'companion', timeZone: 'UTC' };
  const store = createArchiveStore({ ...config, root }); cleanup.push(() => store.close());
  const persistence = ctx.sessionPersistence, open = persistence.open.bind(persistence);
  // Seen on Windows hosts: the header is written, but the store does not find the session while it is being created.
  let creating = true;
  persistence.open = async (id, mode) => {
    if (id === 'home' && mode === 'read' && creating) throw Object.assign(new Error('session "home" not found'), { name: 'SessionPersistenceNotFoundError' });
    return open(id, mode);
  };
  cleanup.push(() => { persistence.open = open; });
  const world = createWorldRuntime(ctx, config, store); cleanup.push(() => world.stop());
  await world.start();
  const home = (await ctx.agents.create({ sessionId: SessionId('home'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } })).agent;
  creating = false;
  home.followup(user('hello')); await home.whenIdle(); await world.flush();
  assert.equal(requests.length, 1); assert.equal(errors.length, 0);
  assert.deepEqual(world.faults(), []);
  assert.ok((await store.readPage({ worldId: 'fish', limit: 10 })).records.some(record => record.content === 'hello'));
});

test('a failing memory setup never fails the host\'s session creation; the session\'s own first turn reports it', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, request => { requests.push(request); return textResponse('reply'); });
  const config = { worldId: 'fish', agentPreset: 'companion', timeZone: 'UTC' };
  const store = createArchiveStore({ ...config, root }); cleanup.push(() => store.close());
  const persistence = ctx.sessionPersistence, open = persistence.open.bind(persistence);
  persistence.open = async (id, mode) => {
    if (id === 'home' && mode === 'read') throw Object.assign(new Error('stored log is corrupt'), { name: 'SessionFormatError' });
    return open(id, mode);
  };
  cleanup.push(() => { persistence.open = open; });
  const world = createWorldRuntime(ctx, config, store); cleanup.push(() => world.stop());
  await world.start();
  const home = (await ctx.agents.create({ sessionId: SessionId('home'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } })).agent;
  assert.equal(ctx.agents.get(SessionId('home')), home, 'the session exists');
  home.followup(user('hello')); await home.whenIdle();
  assert.equal(requests.length, 0, 'it does not run without her memory');
  assert.ok(world.faults().some(message => /home.*记忆初始化失败/.test(message)));
});
