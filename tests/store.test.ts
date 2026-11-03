import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile, mkdir, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createArchiveStore } from '../src/store.ts';
import { record } from './fixtures.ts';

async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-world-'));
  const stores: ReturnType<typeof createArchiveStore>[] = [];
  const open = () => { const store = createArchiveStore({ root, worldId: 'fish', timeZone: 'Asia/Seoul', agentPreset: 'companion' }); stores.push(store); return store; };
  t.after(async () => { for (const s of stores) s.close(); await rm(root, { recursive: true, force: true }); });
  return { root, open, path: (date: string) => join(root, 'worlds/fish/conversations', `${date}.jsonl`) };
}
test('midnight files preserve actual timestamps, turn identity and replay uniqueness', async t => {
  const s = await setup(t); const store = s.open();
  const records = [record('a', { occurredAt: '2026-10-23T14:59:59.000Z', turnId: 'same' }), record('b', { occurredAt: '2026-10-23T15:00:00.000Z', turnId: 'same' })];
  await store.commitRecords(records); await store.commitRecords(records);
  for (const [day, r] of [['2026-10-23', records[0]], ['2026-10-24', records[1]]] as const) assert.deepEqual((await readFile(s.path(day), 'utf8')).trim().split('\n').map(line => JSON.parse(line)), [r]);
});
test('stable pagination excludes later appends including backdated records', async t => {
  const s = await setup(t); const store = s.open();
  await store.commitRecords(['a', 'b', 'c', 'd'].map(id => record(id)));
  const first = await store.readPage({ limit: 2 });
  assert.deepEqual(first.records.map(r => r.recordId), ['d', 'c']);
  await store.commitRecords([record('e'), record('aa')]);
  const second = await store.readPage({ before: first.nextCursor, limit: 2 });
  assert.deepEqual(second.records.map(r => r.recordId), ['b', 'a']);
  assert.equal(second.nextCursor, undefined);
});
test('failed export reports error and recovers canonical records plus source progress on reopen', async t => {
  const s = await setup(t); const store = s.open();
  await mkdir(s.path('2026-10-23'));
  await assert.rejects(store.commitRecords([record('a')], { sessionId: 'a', nextSeq: 4, turn: 1 }), /archive write failed/);
  await rm(s.path('2026-10-23'), { recursive: true });
  store.close(); const resumed = s.open();
  assert.equal(resumed.progress('a').nextSeq, 4);
  assert.deepEqual((await resumed.readPage({ limit: 10 })).records.map(r => r.recordId), ['a']);
});
test('crash after file write before progress and partial tail recover without duplication', async t => {
  const s = await setup(t); const store = s.open();
  await mkdir(s.path('2026-10-23'));
  await assert.rejects(store.commitRecords([record('a'), record('b')]), /archive write failed/);
  await rm(s.path('2026-10-23'), { recursive: true });
  await writeFile(s.path('2026-10-23'), JSON.stringify(record('a')) + '\n' + JSON.stringify(record('b')).slice(0, 30));
  store.close(); const resumed = s.open();
  await resumed.readPage({ limit: 10 });
  assert.equal((await readFile(s.path('2026-10-23'), 'utf8')).trim().split('\n').length, 2);
});
test('a shortened export is rebuilt from the database on the next write to that day', async t => {
  const s = await setup(t); const store = s.open();
  await store.commitRecords([record('a'), record('b')]);
  await truncate(s.path('2026-10-23'), 0);
  await store.commitRecords([record('c')]);
  assert.deepEqual((await readFile(s.path('2026-10-23'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).recordId), ['a', 'b', 'c']);
});
test('separate processes can write the same world day safely', async t => {
  const s = await setup(t); s.open();
  const run = (prefix: string) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'tests/storeWriter.ts', s.root, prefix], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let error = ''; child.stderr.on('data', data => error += data); child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(error)));
  });
  await Promise.all([run('left'), run('right')]);
  const rows = (await readFile(s.path('2026-10-23'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, 40); assert.equal(new Set(rows.map(r => r.recordId)).size, 40);
});
test('a worldId that would leave the worlds directory is refused; the same world reopens under another time zone', async t => {
  const s = await setup(t); await s.open().commitRecords([record('a')]);
  assert.throws(() => createArchiveStore({ root: s.root, worldId: '../other', timeZone: 'UTC', agentPreset: 'companion' }), /worldId/);
  const moved = createArchiveStore({ root: s.root, worldId: 'fish', timeZone: 'UTC', agentPreset: 'companion' });
  try { assert.deepEqual((await moved.readPage({ limit: 10 })).records.map(r => r.recordId), ['a']); } finally { moved.close(); }
});
test('stats count records and distinct source sessions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-world-stats-'));
  const store = createArchiveStore({ root, worldId: 'fish', agentPreset: 'companion', timeZone: 'UTC' });
  t.after(() => store.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  await store.commitRecords([record('a1', { sourceSessionId: 's1' }), record('a2', { sourceSessionId: 's1' }), record('a3', { sourceSessionId: 's2' })]);
  assert.deepEqual(store.stats(), { records: 3, sessions: 2 });
});
