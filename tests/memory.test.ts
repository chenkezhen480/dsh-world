import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createArchiveStore } from '../src/store.ts';
import { createMemory, MemoryError, readStable, type MemoryDeps } from '../src/memory.ts';
import { record } from './fixtures.ts';

async function setup(t: test.TestContext, visible: (id: string) => boolean = () => true) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-world-memory-'));
  const room = join(root, 'room');
  const paths = { diaryDir: join(room, '日记') };
  await mkdir(paths.diaryDir, { recursive: true });
  const store = createArchiveStore({ root, worldId: 'fish', timeZone: 'Asia/Seoul', agentPreset: 'companion' });
  const gate = { visible };
  const memory = createMemory({ store: store.memory, timeZone: 'Asia/Seoul', sources: paths, visible: id => gate.visible(id) } satisfies MemoryDeps);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, room, paths, store, memory, gate };
}
const code = (expected: string) => (error: unknown) => error instanceof MemoryError && error.code === expected;
const excerpts = (page: { items: { excerpt: string }[] }) => page.items.map(item => item.excerpt);

test('chat and diary are found, each with the time it really has', async t => {
  const s = await setup(t);
  await writeFile(join(s.paths.diaryDir, '2026-10-23.md'), '今天在海边捡了贝壳');
  await writeFile(join(s.paths.diaryDir, '随手记.md'), '海边的风很大');
  await s.store.commitRecords([record('a1', { content: '聊到了贝壳', occurredAt: '2026-10-23T12:30:00.000Z' })]);

  const page = await s.memory.find({ query: '贝壳' });
  assert.deepEqual(page.items.map(item => item.kind).sort(), ['conversation', 'diary']);
  const all = await s.memory.find({ limit: 10 });
  const bySource = Object.fromEntries(all.items.map(item => [item.sourceId, item]));
  assert.equal(bySource['chat:a']!.timeBasis, 'message'); assert.equal(bySource['chat:a']!.time, '2026-10-23T21:30:00+09:00');
  assert.equal(bySource['diary:2026-10-23.md']!.timeBasis, 'diaryDate'); assert.equal(bySource['diary:2026-10-23.md']!.time, '2026-10-23T00:00:00+09:00');
  assert.equal(bySource['diary:随手记.md']!.timeBasis, 'fileObserved', 'a diary without a date in its name has the time it last changed');
  assert.equal(all.coverage.state, 'ready');
  assert.deepEqual((await s.memory.find({ kinds: ['diary'], from: '2026-10-23T00:00:00+09:00', to: '2026-10-24T00:00:00+09:00' })).items.map(item => item.sourceId), ['diary:2026-10-23.md']);
  assert.equal((await s.memory.find({ kinds: ['diary'], query: '贝壳', to: '2026-10-23T00:00:00+09:00' })).items.length, 0, 'the end of the range is exclusive');
  await assert.rejects(s.memory.find({ kinds: ['self'] }), code('invalidQuery'), '我是谁 is in the world prompt, not something to look up');
});

test('only the diary directory itself is read: not the room beside it, not its subfolders, and links do not lead out', async t => {
  const s = await setup(t);
  await writeFile(join(s.paths.diaryDir, '正常.md'), '日记里的内容 引用了 [旁边的文件](../秘密.md)');
  await writeFile(join(s.room, '秘密.md'), '房间里别的文件');
  await mkdir(join(s.paths.diaryDir, '旧')); await writeFile(join(s.paths.diaryDir, '旧', '子目录.md'), '子目录里的内容');
  await mkdir(join(s.root, 'elsewhere')); await writeFile(join(s.root, 'elsewhere', '外面.md'), '目录外的内容');
  await symlink(join(s.root, 'elsewhere', '外面.md'), join(s.paths.diaryDir, '外面.md'), 'file').catch(() => {});

  const ids = (await s.memory.find({ limit: 50 })).items.map(item => item.sourceId).sort();
  assert.deepEqual(ids, ['diary:正常.md']);
  for (const query of ['目录外', '别的文件', '子目录']) assert.equal((await s.memory.find({ query })).items.length, 0, query);
});

test('two files with the same words stay two sources; a ref is bound to the text it showed', async t => {
  const s = await setup(t);
  await writeFile(join(s.paths.diaryDir, '甲.md'), '同样的话'); await writeFile(join(s.paths.diaryDir, '乙.md'), '同样的话');
  assert.equal((await s.memory.find({ query: '同样的话' })).items.length, 2);
  const [first] = (await s.memory.find({ sourceId: 'diary:甲.md' })).items;
  const [second] = (await s.memory.find({ sourceId: 'diary:乙.md' })).items;
  await rename(join(s.paths.diaryDir, '甲.md'), join(s.paths.diaryDir, '丙.md'));
  await writeFile(join(s.paths.diaryDir, '乙.md'), '改过的话');
  const now = await s.memory.find({ query: '同样的话' });
  assert.deepEqual(now.items.map(item => item.sourceId), ['diary:丙.md'], 'a rename is the old path leaving and a new one joining');
  await assert.rejects(s.memory.read({ ref: first!.ref }), code('notFound'));
  await assert.rejects(s.memory.read({ ref: second!.ref }), code('sourceChanged'));
  await rm(join(s.paths.diaryDir, '乙.md'));
  assert.equal((await s.memory.find({ kinds: ['diary'] })).items.length, 1, 'a deleted file leaves the results');
});

test('a file that cannot be read or decoded keeps its last text and is never mistaken for a deletion', async t => {
  const s = await setup(t);
  const file = join(s.paths.diaryDir, '主题.md');
  await writeFile(file, '第一版');
  assert.deepEqual(excerpts(await s.memory.find({ kinds: ['diary'] })), ['第一版']);
  await writeFile(file, Buffer.from([0xff, 0xfe, 0x41, 0x80]));
  assert.deepEqual(excerpts(await s.memory.find({ kinds: ['diary'] })), ['第一版'], 'the last good text stays');
  const status = s.memory.status();
  assert.equal(status.state, 'partial'); assert.match(status.failures[0]!.message, /UTF-8/);
  await writeFile(file, '第二版');
  assert.deepEqual(excerpts(await s.memory.find({ kinds: ['diary'] })), ['第二版']);
  assert.equal(s.memory.status().state, 'ready');
});

test('a read that sees the file change is not used, and a missing file is missing', async t => {
  const s = await setup(t);
  const file = join(s.root, 'moving.md'); await writeFile(file, 'abc');
  const result = await readStable(file, () => appendFile(file, 'def'));
  assert.equal(result.kind, 'failed');
  assert.deepEqual(await readStable(join(s.root, 'nope.md')), { kind: 'missing' });
});

test('literal queries: two-character names, three-character words, quotes, percent, backslash and emoji', async t => {
  const s = await setup(t);
  const lines = ['小满说今天下雨', '长期记忆很重要', '她说"你好"然后走了', '打折 100% 真的', 'C:\\temp\\新建 文件', '开心 😀😀 一整天', 'NEAR OR AND *', "it's a O'Brien"];
  await s.store.commitRecords(lines.map((content, index) => record(`a${index + 1}`, { content, occurredAt: `2026-10-23T12:${10 + index}:00.000Z` })));
  const find = async (query: string) => excerpts(await s.memory.find({ query }));
  assert.deepEqual(await find('小满'), ['小满说今天下雨']);
  assert.deepEqual(await find('长期记'), ['长期记忆很重要']);
  assert.deepEqual(await find('记忆'), ['长期记忆很重要']);
  assert.deepEqual(await find('"你好"'), ['她说"你好"然后走了']);
  assert.deepEqual(await find('100%'), ['打折 100% 真的']);
  assert.deepEqual(await find('%'), ['打折 100% 真的']);
  assert.deepEqual(await find('C:\\temp'), ['C:\\temp\\新建 文件']);
  assert.deepEqual(await find('\\'), ['C:\\temp\\新建 文件']);
  assert.deepEqual(await find('😀😀'), ['开心 😀😀 一整天']);
  assert.deepEqual(await find('NEAR OR'), ['NEAR OR AND *']);
  assert.deepEqual(await find("'Br"), ["it's a O'Brien"]);
  assert.deepEqual(await find('near'), [], 'matching is case sensitive');
  assert.equal((await s.memory.find({ query: '记忆' })).search.method, 'scan'); assert.equal((await s.memory.find({})).search.method, 'browse');
  await assert.rejects(s.memory.find({ query: 'x'.repeat(201) }), code('invalidQuery'));
  await assert.rejects(s.memory.find({ query: 'a\0b' }), code('invalidQuery'));
});

test('paging, same-turn reading, direct links and back references, invalid and cross-scope refs', async t => {
  const s = await setup(t);
  await s.store.commitRecords(['1', '2', '3', '4', '5'].map(n => record(`a${n}`, { content: `第${n}句`, sourceSeq: Number(n), turnId: Number(n) <= 3 ? 'a:1' : 'a:2', occurredAt: `2026-10-23T12:0${n}:00.000Z` })));
 
  const one = await s.memory.find({ limit: 2 }), two = await s.memory.find({ limit: 2, cursor: one.nextCursor! }), three = await s.memory.find({ limit: 2, cursor: two.nextCursor! });
  assert.deepEqual([...excerpts(one), ...excerpts(two), ...excerpts(three)], ['第5句', '第4句', '第3句', '第2句', '第1句']);
  assert.equal(three.nextCursor, undefined);
  assert.deepEqual(excerpts(await s.memory.find({ turnId: 'a:1', limit: 2 })), ['第3句', '第2句']);
  assert.deepEqual(excerpts(await s.memory.find({ turnId: 'a:1', order: 'oldest' })), ['第1句', '第2句', '第3句']);
  await assert.rejects(s.memory.find({ limit: 2, cursor: one.nextCursor!, query: '第' }), code('cursorExpired'));
  await assert.rejects(s.memory.find({ limit: 0 }), code('invalidQuery')); await assert.rejects(s.memory.find({ limit: 101 }), code('invalidQuery'));
  await assert.rejects(s.memory.find({ from: '2026-10-23' }), code('invalidQuery')); await assert.rejects(s.memory.find({ kinds: ['x'] }), code('invalidQuery'));
  const [line] = (await s.memory.find({ query: '第3句' })).items;
  await writeFile(join(s.paths.diaryDir, '线索.md'), `# 线索\n引用：memory:${line!.ref}\n`);
  const [page] = (await s.memory.find({ kinds: ['diary'] })).items;
  assert.deepEqual((await s.memory.find({ linkedTo: line!.ref })).items.map(item => item.sourceId), ['diary:线索.md']);
  assert.deepEqual((await s.memory.find({ linkedTo: page!.ref })).items.map(item => item.ref), [line!.ref]);
  const chunk = await s.memory.read({ ref: line!.ref });
  assert.equal(chunk.turnId, 'a:1'); assert.equal(chunk.content, '第3句');
  await assert.rejects(s.memory.read({ ref: 'garbage' }), code('invalidRef'));
  await assert.rejects(s.memory.find({ linkedTo: 'garbage' }), code('invalidRef'));
  await assert.rejects(s.memory.read({ ref: line!.ref, limit: 16001 }), code('invalidQuery'));
  await assert.rejects(s.memory.read({ ref: line!.ref, offset: -1 }), code('invalidQuery'));
  await s.store.updateRecord('a3', () => ({ content: '第三句改了' }));
  await assert.rejects(s.memory.read({ ref: line!.ref }), code('sourceChanged'));
});

test('reading is paged by characters and never cuts a character in half', async t => {
  const s = await setup(t);
  await writeFile(join(s.paths.diaryDir, '长.md'), '一😀二😀三😀四');
 
  const [item] = (await s.memory.find({ kinds: ['diary'] })).items;
  const a = await s.memory.read({ ref: item!.ref, limit: 3 }), b = await s.memory.read({ ref: item!.ref, offset: a.nextOffset!, limit: 3 }), c = await s.memory.read({ ref: item!.ref, offset: b.nextOffset!, limit: 3 });
  assert.deepEqual([a.content, b.content, c.content], ['一😀二', '😀三😀', '四']);
  assert.equal(c.nextOffset, undefined); assert.equal(a.totalChars, 7); assert.equal(a.version, c.version);
  assert.equal((await s.memory.read({ ref: item!.ref, offset: 99 })).content, '');
});

test('narrowing the scope hides group lines and their counts but not what she wrote, and refs into the group cannot be opened', async t => {
  const s = await setup(t);
  await s.store.commitRecords([
    record('g1', { sourceSessionId: 'group', content: '群里提到了小橘', occurredAt: '2026-10-23T12:00:00.000Z' }),
    record('h1', { sourceSessionId: 'home', content: '家里也聊了小橘', occurredAt: '2026-10-23T12:01:00.000Z' }),
  ]);
 
  const [groupLine] = (await s.memory.find({ query: '群里' })).items;
  await writeFile(join(s.paths.diaryDir, '小橘.md'), `小橘是一只猫。\n引用：memory:${groupLine!.ref}\n`);
  await writeFile(join(s.paths.diaryDir, '想法.md'), '我记得群里有人提过小橘'); // her own words stay
 
  s.gate.visible = id => id === 'home';
  const scoped = await s.memory.find({ query: '小橘', limit: 1 });
  assert.equal(scoped.items.length, 1);
  const everything = await s.memory.find({ query: '小橘' });
  assert.deepEqual(everything.items.map(item => item.sourceId).sort(), ['chat:home', 'diary:小橘.md', 'diary:想法.md']);
  assert.equal(JSON.stringify(everything).includes('群里提到'), false);
  const onlyGroupWords = await s.memory.find({ query: '群里提到', limit: 1 });
  assert.deepEqual(onlyGroupWords.items, []); assert.equal(onlyGroupWords.nextCursor, undefined, 'no hint that more matched');
  await assert.rejects(s.memory.read({ ref: groupLine!.ref }), code('outOfScope'));
  await assert.rejects(s.memory.find({ linkedTo: groupLine!.ref }), code('outOfScope'));
  const [page] = (await s.memory.find({ sourceId: 'diary:小橘.md' })).items;
  assert.deepEqual((await s.memory.find({ linkedTo: page!.ref })).items, [], 'the link out of the page cannot expand into the group');
  assert.match((await s.memory.read({ ref: page!.ref })).content, /小橘是一只猫/, 'the page itself is hers and stays readable');
  await s.store.commitRecords([record('g2', { sourceSessionId: 'group', content: '又来一条', occurredAt: '2026-10-23T12:05:00.000Z' })]);
  assert.equal(JSON.stringify(await s.memory.find({})).includes('又来一条'), false, 'a line of an invisible session leaves no trace');
});

test('a host that cannot yet say what is in scope hides chat and reports it rather than guessing', async t => {
  const s = await setup(t, () => { throw new Error('工作区归档需要宿主工作区服务'); });
  await s.store.commitRecords([record('a1', { content: '某句话' })]);
  await writeFile(join(s.paths.diaryDir, '某天.md'), '某句日记')
  const page = await s.memory.find({});
  assert.deepEqual(page.items.map(item => item.kind), ['diary']);
  assert.equal(page.coverage.state, 'partial'); assert.match(page.coverage.failures.map(f => f.message).join(), /工作区/);
});

test('a scope that shrinks between the query and its answer is refused instead of answered', async t => {
  const s = await setup(t);
  await s.store.commitRecords([record('a1', { content: '某句话' })])
  let calls = 0;
  s.gate.visible = () => ++calls <= 1; // yes when the query is planned, no when its answer is checked
  await assert.rejects(s.memory.find({ query: '某句' }), code('scopeChanged'));
});
