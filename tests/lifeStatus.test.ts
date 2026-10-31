import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStatusBoard, describe } from '../src/life/status.ts';

async function setup(t: test.TestContext) {
  const worldDir = await mkdtemp(join(tmpdir(), 'dsh-world-status-'));
  const at = Date.parse('2026-10-31T12:00:00+08:00');
  let now = at;
  const board = createStatusBoard({ worldDir, now: () => new Date(now) });
  t.after(async () => { await rm(worldDir, { recursive: true, force: true }); });
  return { worldDir, board, advance: (ms: number) => { now += ms; } };
}

test('what she writes is what the console reads, with the time she wrote it', async t => {
  const s = await setup(t);
  assert.equal(s.board.read(), undefined, 'nothing written yet is an empty card, not an error');
  assert.match(s.board.write({ mood: '满足', energy: 60, chips: ['今天 2 碗饭', '月亮很圆'], note: '今天游了三圈' }), /^状态卡已更新：满足 · 精力 60 · 今天 2 碗饭、月亮很圆 · 「今天游了三圈」。$/);
  const read = s.board.read();
  assert.deepEqual(read, { at: '2026-10-31T04:00:00.000Z', mood: '满足', energy: 60, chips: ['今天 2 碗饭', '月亮很圆'], note: '今天游了三圈' });
});

test('a partial write keeps the rest and moves the time forward', async t => {
  const s = await setup(t);
  s.board.write({ mood: '发呆', energy: 20, chips: ['今天 1 碗饭'] });
  s.advance(3_600_000);
  s.board.write({ chips: ['今天 3 碗饭', '雨停了'] });
  assert.deepEqual(s.board.read(), { at: '2026-10-31T05:00:00.000Z', mood: '发呆', energy: 20, chips: ['今天 3 碗饭', '雨停了'] }, 'the whole chip list is replaced, the other lines stay');
});

test('an empty string clears that line, and a bad value is refused', async t => {
  const s = await setup(t);
  s.board.write({ mood: '困', note: '今天早点睡', chips: ['今天 0 碗饭'] });
  s.board.write({ mood: '', note: '', chips: [] });
  assert.deepEqual(s.board.read(), { at: '2026-10-31T04:00:00.000Z' });
  assert.throws(() => s.board.write({ energy: 101 }), /精力要写 0 到 100 之间的数/);
  assert.throws(() => s.board.write({ mood: '一二三四五六七八九十十一十二' }), /心情最多 12 个字/);
  assert.throws(() => s.board.write({ note: '一'.repeat(61) }), /那句话最多 60 个字/);
  assert.throws(() => s.board.write({ chips: ['一', '二', '三', '四', '五'] }), /小标签最多 4 个/);
  assert.throws(() => s.board.write({ chips: ['一二三四五六七八九十十一十二三'] }), /每个小标签最多 12 个字/);
  assert.throws(() => s.board.write({}), /至少写一样/);
});

test('a chip is whatever she says it is, and blanks are dropped', async t => {
  const s = await setup(t);
  s.board.write({ chips: ['  今天 2 碗饭 ', '', '  ', '尾巴 有点酸'] });
  assert.deepEqual(s.board.read()?.chips, ['今天 2 碗饭', '尾巴 有点酸']);
  s.board.write({ energy: 99.7 });
  assert.equal(s.board.read()?.energy, 99.7, 'a number keeps one decimal at most');
});

test('a damaged file is an empty card, and the next write replaces it', async t => {
  const s = await setup(t);
  const file = join(s.worldDir, 'status.json');
  await writeFile(file, '{ not json');
  assert.equal(s.board.read(), undefined);
  await writeFile(file, JSON.stringify({ mood: '没有时间的一行' }));
  assert.equal(s.board.read(), undefined, 'a card without a time cannot claim to be now');
  s.board.write({ mood: '好了' });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { at: '2026-10-31T04:00:00.000Z', mood: '好了' });
});

test('describe leaves out what she did not write', () => {
  assert.equal(describe({ at: '2026-10-31T04:00:00.000Z', mood: '困' }), '困');
  assert.equal(describe({ at: '2026-10-31T04:00:00.000Z', energy: 0 }), '精力 0');
  assert.equal(describe({ at: '2026-10-31T04:00:00.000Z', chips: ['今天 0 碗饭'], note: '还没吃' }), '今天 0 碗饭 · 「还没吃」');
});