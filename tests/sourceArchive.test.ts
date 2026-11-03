import assert from 'node:assert/strict';
import test from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import { createSourceArchive, isCorruptSessionLog } from '../src/sourceArchive.ts';
import { createArchiveStore, type ArchiveStore } from '../src/store.ts';
import { createWorldRuntime } from '../src/runtime.ts';
import { consoleSources } from '../src/console/snapshot.ts';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId, SessionSeq, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session';

class SessionPersistenceNotFoundError extends Error { override name = 'SessionPersistenceNotFoundError'; }
const config = { worldId: 'fish', agentPreset: 'companion', timeZone: 'UTC' } as never;

/** Two archived sessions, "a" first; `open` decides how each one fares. */
function fixture(open: (id: string) => Promise<unknown>, stored: (id: string) => boolean = () => true) {
  const opened: string[] = []; const forgotten: string[] = []; const warned: string[] = []; const errored: unknown[] = [];
  const store = {
    sourcePage: (after: string) => after ? [] : ['a', 'b'],
    progress: () => ({ nextSeq: 0, turn: 0 }),
    commitRecords: async () => {},
    forgetProgress: (id: string) => { forgotten.push(id); },
    readPage: async () => ({ records: [] }),
    stats: () => ({ records: 0, sessions: 0 }),
  } as unknown as ArchiveStore;
  const ctx = {
    on: () => () => {}, agents: { list: () => [] },
    sessions: { get: () => undefined, flush: async () => {} },
    sessionPersistence: { list: async () => [], stat: async (id: string) => (stored(id) ? {} : undefined), open: async (id: string) => { opened.push(id); return open(id); } },
    logger: { warn: (message: string) => warned.push(message), error: (error: unknown) => errored.push(error) },
  } as unknown as Context;
  return { archive: createSourceArchive(ctx, config, store), ctx, store, opened, forgotten, warned, errored };
}
const emptyLog = { header: {}, inheritedEventCount: 0, read: async () => ({ events: [] }), close: async () => {} };

test('a replay scheduled immediately after awaiting the previous one archives new words before flush succeeds', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-source-race-'));
  const options = { worldId: 'fish', agentPreset: 'companion', timeZone: 'UTC' };
  const store = createArchiveStore({ ...options, root });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const events: SessionEvent[] = [];
  const header: SessionHeader = { id: SessionId('one'), version: 4, createdAt: 0, isSeeded: false, agentPreset: 'companion' };
  const ctx = { sessions: { get: () => undefined }, logger: { warn() {}, error() {} }, sessionPersistence: {
    open: async () => ({ header, inheritedEventCount: 0, close: async () => {},
      read: async (offset: number, limit: number) => ({ events: events.filter(event => event.seq >= offset).slice(0, limit) }) }),
  } } as unknown as Context;
  const archive = createSourceArchive(ctx, options, store);
  await archive.schedule('one');
  events.push({ type: 'turn/start', seq: SessionSeq(0), time: Date.now(), data: { turn: 1 } } as SessionEvent,
    { type: 'user/message', seq: SessionSeq(1), time: Date.now(), surfaceOp: 'append', data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'after the first replay' }] }) });
  await archive.schedule('one'); await archive.flush();
  assert.equal(store.stats().records, 1);
  assert.equal(store.progress('one').nextSeq, 2);
  assert.deepEqual(archive.faults(), []);
});

test('a session whose log vanished is skipped with a warning and does not count as a failure', async () => {
  const { archive, warned, forgotten } = fixture(async id => { if (id === 'a') throw new SessionPersistenceNotFoundError('a'); return emptyLog; });
  await archive.catchUp();
  await archive.flush();
  assert.deepEqual(forgotten, ['a']);
  assert.equal(warned.length, 1); assert.match(warned[0], /session a is no longer stored/);
});
test('one session failing does not stop catch-up of the next, and flush still reports it', async () => {
  const { archive, opened } = fixture(async id => { if (id === 'a') throw new Error('disk error'); return emptyLog; });
  await archive.catchUp();
  assert.deepEqual(opened, ['a', 'b']);
  await assert.rejects(archive.flush(), /unresolved failures/);
});
test('catch-up forgets the resume point of a session the host no longer has, and reads the others', async () => {
  const { archive, opened, forgotten } = fixture(async () => emptyLog, id => id !== 'a');
  await archive.catchUp();
  await archive.flush();
  assert.deepEqual(forgotten, ['a']);
  assert.deepEqual(opened, ['b']);
});

test('corrupt-source gaps reach world and console health without QQ while healthy sources continue', async t => {
  const { ctx, store, opened } = fixture(async id => {
    if (id === 'a') throw Object.assign(new Error('system/message does not match an open turn and step'), { name: 'SessionFormatError' });
    return emptyLog;
  });
  const world = createWorldRuntime(ctx, config, store); await world.start();
  t.after(() => world.stop()); await world.flush();
  assert.deepEqual(opened, ['a', 'b']);
  assert.equal(world.faults().length, 1, 'a skipped source must remain visible as an archive gap');
  assert.match(world.faults()[0]!, /a.*归档.*system\/message/);
  const sources = consoleSources({ ctx, config, archive: store, names: () => ({ companion: '小鱼', partner: '伙伴' }),
    life: () => undefined, diaryDir: tmpdir(), running: () => true, dailyBudget: () => undefined, memoryTurns: () => 200, faults: world.faults });
  assert.deepEqual((await sources.snapshot() as { health: string[] }).health, world.faults());
});

test('a successful replay clears only its own corrupt-source gap', async () => {
  let broken = true;
  const { archive } = fixture(async id => {
    if (broken || id === 'b') throw new Error('stored log is corrupt');
    return emptyLog;
  });
  await archive.catchUp(); await archive.flush();
  assert.equal(archive.faults().length, 2);
  broken = false;
  await archive.schedule('a'); await archive.flush();
  assert.equal(archive.faults().length, 1);
  assert.match(archive.faults()[0]!, /b.*归档/);
});

test('a deleted corrupt source clears its gap and resume point', async () => {
  let exists = true;
  const { archive, forgotten } = fixture(async id => {
    if (id === 'a') throw new Error('stored log is corrupt');
    return emptyLog;
  }, id => id !== 'a' || exists);
  await archive.catchUp(); await archive.flush();
  assert.equal(archive.faults().length, 1);
  exists = false;
  await archive.catchUp(); await archive.flush();
  assert.deepEqual(forgotten, ['a']);
  assert.deepEqual(archive.faults(), []);
});

test('skipping a corrupt source reports a gap, while a normal I/O error remains fatal', async () => {
  const corrupt = fixture(async () => { throw new Error('stored log is corrupt'); }).archive;
  await corrupt.skip('a'); await corrupt.flush();
  assert.match(corrupt.faults()[0]!, /a.*归档/);
  const denied = fixture(async () => { throw new Error('EACCES: permission denied'); }).archive;
  await assert.rejects(denied.skip('a'), /EACCES/);
  await assert.rejects(denied.flush(), /unresolved failures/);
});

test('a corrupt later page preserves committed words and resumes without duplicates; deletion keeps those words', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-source-gap-'));
  const options = { worldId: 'fish', agentPreset: 'companion', timeZone: 'UTC' };
  const store = createArchiveStore({ ...options, root });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const header = (id: string): SessionHeader => ({ id: SessionId(id), version: 4, createdAt: 0, isSeeded: false, agentPreset: 'companion' });
  const words = (seq: number, text: string): SessionEvent<'user/message'> => ({ type: 'user/message', seq: SessionSeq(seq), time: 1792758600000,
    surfaceOp: 'append', data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }) });
  const start = { type: 'turn/start', seq: SessionSeq(0), time: 1792758600000, data: { turn: 1 } } as SessionEvent;
  const first = words(1, '坏页之前已归档'), second = words(2, '修复之后补归档'), healthy = words(1, '好会话照常归档');
  const reads: number[] = [];
  let broken = true, deleted = false;
  const ctx = {
    sessions: { get: () => undefined }, logger: { warn() {}, error() {} },
    sessionPersistence: {
      list: async () => ['a', 'b'].map(id => ({ header: header(id) })),
      open: async (id: string) => {
        if (id === 'a' && deleted) throw new SessionPersistenceNotFoundError('a');
        return { header: header(id), inheritedEventCount: 0, close: async () => {}, read: async (offset: number, limit: number) => {
          assert.equal(limit, 128);
          if (id === 'a') reads.push(offset);
          if (id === 'a' && offset >= 2 && broken) throw new Error('stored log is corrupt');
          return { events: offset === 0 ? [start, id === 'a' ? first : healthy] : id === 'a' && offset === 2 ? [second] : [] };
        } };
      },
    },
  } as unknown as Context;
  const archive = createSourceArchive(ctx, options, store);
  await archive.catchUp(); await archive.flush();
  assert.equal(archive.faults().length, 1);
  assert.equal(store.progress('a').nextSeq, 2, 'the failed page must not advance progress');
  assert.equal((await store.readPage({ limit: 10 })).records.length, 2, 'healthy and already committed words survive');
  assert.deepEqual(reads, [0, 2]);
  broken = false; reads.length = 0;
  await archive.schedule('a'); await archive.flush();
  assert.deepEqual(reads, [2, 3]);
  assert.equal(store.progress('a').nextSeq, 3);
  assert.deepEqual(archive.faults(), []);
  assert.equal((await store.readPage({ limit: 10 })).records.length, 3);
  broken = true;
  await archive.schedule('a'); await archive.flush();
  assert.equal(archive.faults().length, 1);
  deleted = true;
  await archive.schedule('a'); await archive.flush();
  assert.deepEqual(archive.faults(), []);
  assert.equal(store.progress('a').nextSeq, 0);
  assert.equal((await store.readPage({ limit: 10 })).records.length, 3);
});

test('corrupt session logs are isolated without treating unrelated errors as corruption', () => {
  // 这几种都是宿主的原文：坏在哪都无所谓，要紧的是认出它。
  assert.equal(isCorruptSessionLog(new Error('stored log is corrupt: unexpected end of file')), true);
  assert.equal(isCorruptSessionLog(Object.assign(new Error('boom'), { name: 'SessionFormatError' })), true);
  assert.equal(isCorruptSessionLog(new Error('system/message does not match an open turn and step')), true);
  // 一轮里步数重号（有人遇到过）：错误名在跨线程或被包装时可能丢掉，只剩这句原文。
  assert.equal(isCorruptSessionLog(new Error('step/start does not match the open turn and next step')), true);
  // 别的错误照旧往外抛，不能被这道网兜住。
  assert.equal(isCorruptSessionLog(new Error('EACCES: permission denied')), false);
  assert.equal(isCorruptSessionLog(undefined), false);
});
