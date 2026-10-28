import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLifeStore, durableWrite } from '../src/life/lifeStore.ts';
import { createWorldSwitch } from '../src/worldSwitch.ts';
import { readdirSync, renameSync } from 'node:fs';

async function dir(t: test.TestContext) { const root = await mkdtemp(join(tmpdir(), 'dsh-life-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test('life state round-trips atomically and starts empty', async t => {
  const root = await dir(t); const store = createLifeStore(root, 'Asia/Seoul');
  assert.deepEqual(store.read(), { version: 1 });
  const alarm = { at: '2026-10-23T12:00:00.000Z', note: '写日记', setAt: '2026-10-23T11:00:00.000Z', source: 'plan' as const };
  store.write({ version: 1, homeSessionId: 'home', alarm });
  assert.deepEqual(createLifeStore(root, 'Asia/Seoul').read(), { version: 1, homeSessionId: 'home', alarm });
});
test('a life.json that is not JSON is reported and left untouched', async t => {
  const root = await dir(t); await writeFile(join(root, 'life.json'), '{broken');
  assert.throws(() => createLifeStore(root, 'UTC').read(), /not valid JSON/);
  assert.equal(await readFile(join(root, 'life.json'), 'utf8'), '{broken');
});
test('activity is split by local day and a failed write marks the next record as a gap', async t => {
  const root = await dir(t); const store = createLifeStore(root, 'Asia/Seoul');
  const base = { sessionId: 'home', callId: 'c', tool: 'pwsh', summary: 'x', outside: true };
  assert.ok(store.appendActivity({ ...base, time: '2026-10-22T15:30:00.000Z' }));
  assert.deepEqual(store.activityDays(), ['2026-10-23']);
  assert.equal(store.activity('2026-10-23').length, 1);
  assert.deepEqual(store.activity('../life'), []);
  await rm(join(root, 'activity'), { recursive: true }); await writeFile(join(root, 'activity'), 'not a directory');
  assert.equal(store.appendActivity({ ...base, time: '2026-10-23T01:00:00.000Z' }), false);
  await rm(join(root, 'activity'));
  assert.ok(store.appendActivity({ ...base, time: '2026-10-23T02:00:00.000Z' }));
  assert.equal(store.activity('2026-10-23')[0].gapBefore, true);
});
test('wake and compaction logs append and skip a half-written tail', async t => {
  const root = await dir(t); const store = createLifeStore(root, 'UTC');
  store.appendWake({ scheduledAt: 'a', deliveredAt: 'b', source: 'first', lateMs: 0 });
  await writeFile(join(root, 'life', 'wakes.jsonl'), (await readFile(join(root, 'life', 'wakes.jsonl'), 'utf8')) + '{"half');
  assert.equal(store.wakes().length, 1);
  store.appendCompaction({ time: 't', sessionId: 's', ok: true, shadowedTokens: 10 });
  assert.deepEqual(store.compactions(), [{ time: 't', sessionId: 's', ok: true, shadowedTokens: 10 }]);
});
test('cost records are independent JSONL entries and survive a torn tail', async t => {
  const root = await dir(t); const store = createLifeStore(root, 'UTC');
  const record = { occurredAt: '2026-10-23T01:00:00.000Z', day: '2026-10-23', worldId: 'fish', sessionId: 'home', model: 'deepseek-flash', inputTokens: 10, cacheReadTokens: 2, outputTokens: 3, yuan: 0.001, source: 'home' };
  store.appendCost(record);
  await writeFile(join(root, 'life', 'costs.jsonl'), (await readFile(join(root, 'life', 'costs.jsonl'), 'utf8')) + '{broken');
  assert.deepEqual(store.costs(), [record]);
  store.appendCost({ ...record, occurredAt: '2026-10-23T02:00:00.000Z' });
  assert.equal(store.costs().length, 2);
});
test('a half-written tail does not swallow the next record', async t => {
  const root = await dir(t); const store = createLifeStore(root, 'UTC'); const file = join(root, 'life', 'wakes.jsonl');
  store.appendWake({ scheduledAt: 'a', deliveredAt: 'b', source: 'first', lateMs: 0 });
  await writeFile(file, (await readFile(file, 'utf8')) + '{"half');
  store.appendWake({ scheduledAt: 'c', deliveredAt: 'd', source: 'plan', lateMs: 1 });
  assert.deepEqual(store.wakes().map(wake => wake.scheduledAt), ['a', 'c']);
});
test('activity heals a deleted directory and non-object lines are skipped', async t => {
  const root = await dir(t); const store = createLifeStore(root, 'UTC');
  const base = { sessionId: 'home', callId: 'c', tool: 'pwsh', summary: 'x', outside: false };
  await rm(join(root, 'activity'), { recursive: true });
  assert.ok(store.appendActivity({ ...base, time: '2026-10-23T01:00:00.000Z' }));
  await writeFile(join(root, 'activity', '2026-10-23.jsonl'), (await readFile(join(root, 'activity', '2026-10-23.jsonl'), 'utf8')) + '42\nnull\n');
  assert.equal(store.activity('2026-10-23').length, 1);
});
function fail(code: string) { return Object.assign(new Error(code), { code }); }
test('durableWrite retries a transient rename lock and then succeeds', async t => {
  const root = await dir(t); const file = join(root, 'life.json'); let calls = 0;
  durableWrite(file, 'new', (from, to) => { if (++calls <= 2) throw fail('EPERM'); renameSync(from, to); });
  assert.equal(calls, 3);
  assert.equal(await readFile(file, 'utf8'), 'new');
  assert.deepEqual(readdirSync(root).filter(name => name.endsWith('.tmp')), []);
});
test('durableWrite gives up on a permanent lock and cleans the temp file', async t => {
  const root = await dir(t); const file = join(root, 'life.json'); let calls = 0;
  assert.throws(() => durableWrite(file, 'new', () => { calls++; throw fail('EPERM'); }), { code: 'EPERM' });
  assert.equal(calls, 10);
  assert.deepEqual(readdirSync(root).filter(name => name.endsWith('.tmp')), []);
});
test('durableWrite rethrows a non-retryable error immediately', async t => {
  const root = await dir(t); const file = join(root, 'life.json'); let calls = 0;
  assert.throws(() => durableWrite(file, 'new', () => { calls++; throw fail('ENOSPC'); }), { code: 'ENOSPC' });
  assert.equal(calls, 1);
  assert.deepEqual(readdirSync(root).filter(name => name.endsWith('.tmp')), []);
});
test('a new world waits for start; a world with a life line from before the switch is running; the switch outlasts a restart', async t => {
  const fresh = await dir(t);
  assert.equal(createWorldSwitch(fresh).running(), false);
  const old = await dir(t); await writeFile(join(old, 'life.json'), JSON.stringify({ version: 1, homeSessionId: 'home' }));
  const power = createWorldSwitch(old);
  assert.equal(power.running(), true);
  power.set(false);
  assert.equal(createWorldSwitch(old).running(), false, 'stopped stays stopped, life.json or not');
  createWorldSwitch(fresh).set(true);
  assert.equal(createWorldSwitch(fresh).running(), true);
});
