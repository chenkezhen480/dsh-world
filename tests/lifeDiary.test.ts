import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closedDiaryRefusal, createDiaryReader } from '../src/life/diary.ts';

async function diaryDir(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-diary-')); t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, '鲸鲸的日记'); await mkdir(dir);
  await writeFile(join(dir, '2026-10-22.md'), '# 2026-10-22\n\n今天有人给我起了名字。\n被看见了。');
  await writeFile(join(dir, '2026-10-23.md'), '# 2026-10-23\n\n他去上班了。');
  await writeFile(join(dir, 'notes.txt'), 'not a diary');
  await writeFile(join(root, 'secret.md'), 'outside');
  return dir;
}
test('the reader lists dates newest first, reads one day', async t => {
  const diary = createDiaryReader(await diaryDir(t));
  assert.deepEqual(diary.dates(), ['2026-10-23', '2026-10-22']);
  assert.match(diary.read('2026-10-22')!, /起了名字/);
  assert.equal(diary.read('../secret'), undefined);
});
test('a missing diary directory reads as empty', () => {
  assert.deepEqual(createDiaryReader(join(tmpdir(), 'no-such-diary-dsh')).dates(), []);
});
test('the reader returns a file whole, including CRLF and a BOM, and skips non-date names', async t => {
  const dir = await diaryDir(t);
  const raw = '\uFEFF海风\r\n第二行\r\n';
  await writeFile(join(dir, '2026-10-20.md'), raw);
  await mkdir(join(dir, '2026-10-24.md'));
  assert.equal(createDiaryReader(dir).read('2026-10-20'), raw);
  assert.equal(createDiaryReader(dir).read('2026-01-01'), undefined);
});
test('only the open days\' diaries can be written; a closed day, by any path spelling, is refused with where to correct it', () => {
  const dir = join(tmpdir(), 'room', '日记'), cwd = join(tmpdir(), 'room');
  const open = new Set(['2026-11-03']);
  const refuse = (tool: string, args: unknown) => closedDiaryRefusal(tool, args, dir, cwd, open, '2026-11-03');
  assert.equal(refuse('write', { file_path: join(dir, '2026-11-03.md') }), undefined);
  for (const path of [join(dir, '2026-11-02.md'), '日记/2026-11-02.md', '../room/日记/2026-11-02.md']) {
    assert.match(refuse('edit', { file_path: path }) ?? '', /2026-11-02 的日记已经合上了[\s\S]*今天（2026-11-03）的日记/, path);
  }
  assert.ok(refuse('write', { path: join(dir, '2026-11-02.md') }), 'whatever the path argument is called');
  assert.equal(refuse('read', { file_path: join(dir, '2026-11-02.md') }), undefined, 'reading stays free');
  assert.equal(refuse('write', { file_path: join(dir, 'notes.md') }), undefined, 'an undated file is not a dated diary');
  assert.equal(refuse('write', { file_path: join(dir, 'old', '2026-11-02.md') }), undefined, 'only the diary directory itself');
  assert.equal(refuse('write', { file_path: join(cwd, '2026-11-02.md') }), undefined, 'a same-named file elsewhere');
});
