import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createArchiveStore } from '../src/store.ts';
import { createMemory } from '../src/memory.ts';
import { chatRef, decodeRef, fileRef, MemoryError, type FindParams } from '../src/memoryStore.ts';
import { record } from './fixtures.ts';

async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-world-mem-'));
  const stores: ReturnType<typeof createArchiveStore>[] = [];
  const open = () => { const store = createArchiveStore({ root, worldId: 'fish', timeZone: 'Asia/Seoul', agentPreset: 'companion' }); stores.push(store); return store; };
  t.after(async () => { for (const s of stores) s.close(); await rm(root, { recursive: true, force: true }); });
  return { root, open, db: join(root, 'worlds/fish/archive.sqlite') };
}
const params = (over: Partial<FindParams> = {}): FindParams => ({ order: 'newest', limit: 20, ...over });
const words = (store: ReturnType<typeof createArchiveStore>, over: Partial<FindParams> = {}, sessions = ['a', 'home']) => store.memory.find(params(over), sessions, store.memory.snapshot().head, 50).map(r => r.content);

test('memory adds nothing to the archive: an existing archive answers at once, with no tables, queue or rebuild', async t => {
  const s = await setup(t);
  const first = s.open();
  await first.commitRecords([record('a1', { content: '旧的话' })], { sessionId: 'a', nextSeq: 5, turn: 2 });
  first.close();
  const before = new DatabaseSync(s.db);
  const tables = () => (before.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(row => row.name);
  const known = tables();
  before.close();
  const store = s.open();
  assert.equal(store.progress('a').nextSeq, 5);
  assert.deepEqual(words(store, { query: '旧的话' }, ['a']), ['旧的话'], 'no waiting for an index: the first query already finds it');
  store.close();
  const after = new DatabaseSync(s.db);
  assert.deepEqual((after.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(row => row.name), known, 'opening and searching created no table');
  after.close();
  assert.ok(!known.some(name => /^memory/.test(name)));
});

test('added and revised chat lines are found at once: the old words vanish and the new appear, also after a restart', async t => {
  const s = await setup(t);
  const store = s.open();
  await store.commitRecords([record('a1', { content: '最初的话' })]);
  assert.deepEqual(words(store, { query: '最初' }), ['最初的话']);
  await store.updateRecord('a1', () => ({ content: '修订后的话' }));
  assert.deepEqual(words(store, { query: '最初' }), []);
  assert.deepEqual(words(store, { query: '修订' }), ['修订后的话']);
  store.close();
  const again = s.open();
  assert.deepEqual(words(again, { query: '修订' }), ['修订后的话']);
});

test('a chat ref is bound to the content it showed: after a revision it says sourceChanged instead of reading the new text', async t => {
  const s = await setup(t);
  const store = s.open();
  await store.commitRecords([record('a1', { content: '原话' })]);
  const [hit] = store.memory.find(params({ query: '原话' }), ['a'], store.memory.snapshot().head, 5);
  const ref = store.memory.item(hit!, '原话').ref;
  assert.equal(store.memory.read(ref, () => true).content, '原话');
  await store.updateRecord('a1', () => ({ content: '改过的话' }));
  assert.throws(() => store.memory.read(ref, () => true), (error: unknown) => error instanceof MemoryError && error.code === 'sourceChanged');
  assert.throws(() => store.memory.read(ref, () => false), (error: unknown) => error instanceof MemoryError && error.code === 'sourceChanged' || error instanceof MemoryError && error.code === 'outOfScope');
  assert.throws(() => store.memory.read(chatRef('nope', 'x'), () => true), (error: unknown) => error instanceof MemoryError && error.code === 'notFound');
});

test('chat lines of sessions the caller cannot see are filtered inside the query, before paging', async t => {
  const s = await setup(t);
  const store = s.open();
  await store.commitRecords([
    record('g1', { sourceSessionId: 'group', content: '群里的话', occurredAt: '2026-10-23T12:00:00.000Z' }),
    record('h1', { sourceSessionId: 'home', content: '家里的话', occurredAt: '2026-10-23T12:01:00.000Z' }),
    record('h2', { sourceSessionId: 'home', content: '家里又说', occurredAt: '2026-10-23T12:02:00.000Z' }),
  ]);
  assert.deepEqual(store.memory.sessionIds().sort(), ['group', 'home']);
  assert.deepEqual(words(store, {}, ['home']), ['家里又说', '家里的话']);
  assert.deepEqual(words(store, { query: '群里' }, ['home']), []);
  assert.deepEqual(words(store, { sourceId: 'chat:group' }, ['home']), [], 'naming a session does not widen the scope');
  assert.deepEqual(store.memory.find(params({ limit: 1 }), ['home'], store.memory.snapshot().head, 1).length, 1);
});

test('time ranges compare instants, whatever offset a line was stored with, and the end is exclusive', async t => {
  const s = await setup(t);
  const store = s.open();
  await store.commitRecords([
    record('a1', { content: '早', occurredAt: '2026-10-23T20:00:00.000+09:00' }),
    record('a2', { content: '晚', occurredAt: '2026-10-23T12:00:00.000Z' }),
  ]);
  const at = (iso: string) => Date.parse(iso);
  assert.deepEqual(words(store, { fromMs: at('2026-10-23T11:30:00Z') }), ['晚'], '20:00+09:00 is 11:00Z, before the start');
  assert.deepEqual(words(store, { fromMs: at('2026-10-23T10:30:00Z'), toMs: at('2026-10-23T12:00:00Z') }), ['早'], 'the end instant itself is out');
});

test('the same turn is read in the order it was said, and a snapshot keeps later lines out of a page', async t => {
  const s = await setup(t);
  const store = s.open();
  await store.commitRecords([1, 2, 3].map(n => record(`a${n}`, { content: `第${n}句`, sourceSeq: n, turnId: 'a:1', occurredAt: `2026-10-23T12:0${n}:00.000Z` })));
  assert.deepEqual(words(store, { turnId: 'a:1', order: 'oldest' }), ['第1句', '第2句', '第3句']);
  const taken = store.memory.snapshot().head;
  await store.commitRecords([record('a4', { content: '第4句', sourceSeq: 4, turnId: 'a:1', occurredAt: '2026-10-23T12:04:00.000Z' })]);
  assert.deepEqual(store.memory.find(params(), ['a'], taken, 50).map(r => r.content), ['第3句', '第2句', '第1句']);
});

test('a page cursor stays valid while only new lines arrive and expires when a line is revised or the visible set changes', async t => {
  const s = await setup(t);
  const store = s.open();
  let sessions = ['a'];
  const memory = createMemory({ store: store.memory, timeZone: 'Asia/Seoul', sources: {}, visible: id => sessions.includes(id) });
  await store.commitRecords([1, 2, 3, 4].map(n => record(`a${n}`, { content: `第${n}句`, sourceSeq: n, occurredAt: `2026-10-23T12:0${n}:00.000Z` })));
  const one = await memory.find({ limit: 2 });
  await store.commitRecords([record('a5', { content: '第5句', sourceSeq: 5, occurredAt: '2026-10-23T12:05:00.000Z' })]);
  const two = await memory.find({ limit: 2, cursor: one.nextCursor! });
  assert.deepEqual([...one.items, ...two.items].map(item => item.excerpt), ['第4句', '第3句', '第2句', '第1句'], 'the line that arrived meanwhile does not shift the pages');
  const again = await memory.find({ limit: 2 });
  await store.updateRecord('a1', () => ({ content: '第一句改了' }));
  await assert.rejects(memory.find({ limit: 2, cursor: again.nextCursor! }), (error: unknown) => error instanceof MemoryError && error.code === 'cursorExpired');
  const third = await memory.find({ limit: 2 });
  sessions = ['a', 'other'];
  await store.commitRecords([record('o1', { sourceSessionId: 'other', content: '别处', sourceSeq: 6 })]);
  await assert.rejects(memory.find({ limit: 2, cursor: third.nextCursor! }), (error: unknown) => error instanceof MemoryError && error.code === 'cursorExpired');
  await assert.rejects(memory.find({ cursor: 'garbage' }), (error: unknown) => error instanceof MemoryError && error.code === 'invalidCursor');
});

test('refs decode only to their own two shapes', () => {
  assert.deepEqual(decodeRef(chatRef('r1', '正文')), { kind: 'c', recordId: 'r1', hash: decodeRef(chatRef('r1', '正文')).hash });
  assert.deepEqual(decodeRef(fileRef('diary:2026-10-23.md', '日记')).kind, 'a');
  for (const bad of ['', 'm1.', 'm1.e30', 'x.abc', 'm1.' + Buffer.from('["z","a","b"]').toString('base64url'), 'm1.' + Buffer.from('["c",1,"b"]').toString('base64url')]) {
    assert.throws(() => decodeRef(bad), (error: unknown) => error instanceof MemoryError && error.code === 'invalidRef', bad);
  }
});
