import assert from 'node:assert/strict';
import test from 'node:test';
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createWorldRuntime } from '../src/runtime.ts';
import { createArchiveStore } from '../src/store.ts';
import { hostFixture, textResponse } from './hostFixture.ts';

const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
test('a session whose log cannot be read keeps talking with the fault shown, and what it said is archived once the log reads again', async t => {
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
  assert.ok(world.faults().some(message => /bad.*归档未完成/.test(message)), world.faults().join('|'));
  good.followup(user('healthy after reload')); await good.whenIdle(); await world.flush();
  assert.equal(requests.length, 2); assert.equal(errors.length, 0);
  assert.ok((await store.readPage({ limit: 10 })).records.some(record => record.content === 'healthy after reload'));
  bad.followup(user('still broken')); await bad.whenIdle(); await world.flush();
  assert.equal(requests.length, 3, 'a broken archive does not stop her talking');
  assert.equal(errors.length, 0);
  assert.ok(!(await store.readPage({ limit: 10 })).records.some(record => record.content === 'still broken'));
  assert.ok(world.faults().some(message => /bad.*归档未完成/.test(message)));
  broken = false;
  bad.followup(user('repaired now')); await bad.whenIdle(); await world.flush();
  assert.equal(requests.length, 4); assert.deepEqual(world.faults(), []);
  const contents = (await store.readPage({ limit: 20 })).records.map(record => record.content);
  for (const words of ['before reload', 'still broken', 'repaired now']) assert.equal(contents.filter(content => content === words).length, 1, words);
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
  assert.ok((await store.readPage({ limit: 10 })).records.some(record => record.content === 'hello'));
});

test('an archive that cannot be written does not stop her talking; what she said is archived once it can be written again', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, request => { requests.push(request); return textResponse('reply'); });
  const config = { worldId: 'fish', agentPreset: 'companion', timeZone: 'UTC' };
  const store = createArchiveStore({ ...config, root }); cleanup.push(() => store.close());
  const commitRecords = store.commitRecords;
  let broken = false;
  store.commitRecords = (records, progress) => broken ? Promise.reject(new Error('disk full')) : commitRecords(records, progress);
  const world = createWorldRuntime(ctx, config, store); cleanup.push(() => world.stop());
  await world.start();
  const home = (await ctx.agents.create({ sessionId: SessionId('home'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } })).agent;
  broken = true;
  home.followup(user('while broken')); await home.whenIdle();
  assert.equal(requests.length, 1);
  assert.ok(world.faults().some(message => /home.*disk full/.test(message)), world.faults().join('|'));
  broken = false;
  home.followup(user('after repair')); await home.whenIdle(); await world.flush();
  assert.equal(requests.length, 2); assert.deepEqual(world.faults(), []);
  const records = (await store.readPage({ limit: 10 })).records;
  for (const words of ['while broken', 'after repair']) assert.equal(records.filter(record => record.content === words).length, 1, words);
  assert.equal(records.filter(record => record.role === 'assistant').length, 2);
});

test('a session whose log cannot be read is still created and talks; the fault names it', async t => {
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
  assert.equal(requests.length, 1);
  assert.ok(world.faults().some(message => /home.*归档未完成/.test(message)), world.faults().join('|'));
});
