import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { FOCUS_FILE, FOCUS_MAX_CHARS, focusLine, readFocusNote } from '../src/life/focusNote.ts';

const now = new Date('2026-10-23T03:00:00.000Z');
/** A note file written at `at`, so its age is the difference to `now`. */
async function noteAt(at: string, text: string): Promise<{ path: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-focus-'));
  const path = join(dir, FOCUS_FILE);
  await writeFile(path, text);
  const { utimes } = await import('node:fs/promises');
  await utimes(path, new Date(at), new Date(at));
  return { path, dir };
}

test('a note is read as one line, its lines joined, a repeated line kept once, and its age taken from the file itself', async () => {
  const { path, dir } = await noteAt('2026-10-23T00:00:00.000Z', '有点累\n外面在下雨\r\n\n风有点大\n有点累\n');
  try {
    const note = readFocusNote(path, now);
    assert.deepEqual(note, { kind: 'note', text: '有点累；外面在下雨；风有点大', ageMs: 3 * 3600e3 });
    assert.equal(focusLine(note), '我 3 小时前在 focus.md 写下：有点累；外面在下雨；风有点大');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a missing or blank note is nothing, not a fault', async () => {
  const { path, dir } = await noteAt('2026-10-23T00:00:00.000Z', '  \n\n\t\n');
  try {
    assert.deepEqual(readFocusNote(path, now), { kind: 'none' });
    assert.deepEqual(readFocusNote(join(dir, 'missing.md'), now), { kind: 'none' });
    assert.equal(focusLine({ kind: 'none' }), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a note just written says 刚刚, and one too long is cut with a mark that there is more', async () => {
  const fresh = await noteAt(now.toISOString(), '有点累');
  try { assert.equal(focusLine(readFocusNote(fresh.path, now)), '我刚刚在 focus.md 写下：有点累'); }
  finally { await rm(fresh.dir, { recursive: true, force: true }); }
  const long = await noteAt('2026-10-23T00:00:00.000Z', '累'.repeat(FOCUS_MAX_CHARS + 20));
  try {
    const line = focusLine(readFocusNote(long.path, now))!;
    assert.match(line, /^我 3 小时前在 focus\.md 写下：累{200}……后面还有$/);
  } finally { await rm(long.dir, { recursive: true, force: true }); }
});

test('a note that cannot be read is a fault, never "she has not written one"', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-focus-'));
  try {
    const path = join(dir, FOCUS_FILE);
    await mkdir(path);
    const note = readFocusNote(path, now);
    assert.equal(note.kind, 'failed');
    assert.equal(focusLine(note), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
