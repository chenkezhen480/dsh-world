import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { consoleSources } from '../src/console/snapshot.ts';
import { moodView } from '../src/mood.ts';

async function room(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-world-mood-console-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}

test('the console view is the reading she gets, the fixed set in order and the words outside it named, with when she last changed the file', async t => {
  const dir = await room(t), file = join(dir, 'mood.md');
  assert.deepEqual(moodView(file), { kind: 'none' });
  await writeFile(file, '开心 6\n想家 5\n外面在下雨\n开心 11\n');
  await utimes(file, new Date('2026-11-10T12:00:00.000Z'), new Date('2026-11-10T12:00:00.000Z'));
  const view = moodView(file);
  assert.equal(view.kind, 'mood');
  if (view.kind !== 'mood') return;
  assert.deepEqual(view.values.slice(0, 2), [{ name: '开心', value: 6 }, { name: '兴奋', value: 0 }]);
  assert.equal(view.values.length, 11);
  assert.deepEqual(view.outside, ['想家']);
  assert.deepEqual(view.trivia, ['外面在下雨']);
  assert.equal(view.unread, 1);
  assert.equal(view.updatedAt, '2026-11-10T12:00:00.000Z');
  await rm(file); await mkdir(file);
  assert.equal(moodView(file).kind, 'failed');
});

test('the console snapshot carries her mood, and none without a mood file', async t => {
  const dir = await room(t), moodFile = join(dir, 'mood.md');
  await writeFile(moodFile, '累 7\n');
  const archive = { readPage: async () => ({ records: [], nextCursor: undefined }), readTurn: async () => [], stats: () => ({ records: 0, sessions: 0 }) };
  const sources = (file?: string) => consoleSources({
    ctx: { agents: { get: () => undefined } } as never, config: { worldId: 'w', timeZone: 'UTC' } as never, archive: archive as never,
    names: () => ({ companion: '小鱼', partner: '伙伴' }), life: () => undefined, diaryDir: join(dir, 'diary'), running: () => true, dailyBudget: () => undefined, memoryTurns: () => 50, faults: () => [],
    ...(file ? { moodFile: file } : {}),
  });
  const shown = await sources(moodFile).snapshot() as { mood: { kind: string; values: { name: string; value: number }[] } };
  assert.equal(shown.mood.kind, 'mood');
  assert.deepEqual(shown.mood.values.find(value => value.name === '累'), { name: '累', value: 7 });
  assert.equal((await sources().snapshot() as { mood: unknown }).mood, null);
});

test('the mood card shows her values, the small things and when she changed it, says when there is none, and shows a read failure', async () => {
  const source = await readFile('client/index.js', 'utf8');
  let loaded: { factory: (require: (name: string) => unknown) => { __test: (worldId: string) => { MoodCard: unknown } } } | undefined;
  const react = { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }), useState: (value: unknown) => [value, () => {}], useEffect: () => {}, useRef: (current: unknown) => ({ current }) };
  runInNewContext(source, { fetch: () => Promise.reject(new Error('no fetch')), window: { __ModuleLoader__: { load: (entry: typeof loaded) => { loaded = entry; } } } });
  const { MoodCard } = loaded!.factory(() => react).__test('fish');
  type El = { type: unknown; props: Record<string, unknown> | null; children: unknown[] };
  const text = (node: unknown): string => {
    if (node == null || typeof node === 'boolean') return '';
    if (Array.isArray(node)) return node.map(text).join('');
    if (typeof node !== 'object') return String(node);
    const el = node as El;
    if (typeof el.type === 'function') return text((el.type as (p: unknown) => unknown)({ ...el.props, children: el.children }));
    return text(el.children);
  };
  const render = (mood: unknown) => text(react.createElement(MoodCard, { mood, zone: 'Asia/Shanghai' }));
  const shown = render({ kind: 'mood', values: [{ name: '开心', value: 6 }, { name: '兴奋', value: 0 }], trivia: ['外面在下雨'], cut: true, unread: 1, outside: ['想家'], updatedAt: '2026-11-10T12:00:00.000Z' });
  assert.match(shown, /心情/); assert.match(shown, /开心 6/); assert.match(shown, /想家 不在固定的心情里，没有算进去/);
  assert.match(shown, /旁边：外面在下雨……后面还有/); assert.match(shown, /有 1 行没读懂/); assert.match(shown, /她最后改于 /);
  assert.match(render({ kind: 'none' }), /她还没有写 mood\.md/);
  assert.match(render(null), /她还没有写 mood\.md/);
  assert.match(render({ kind: 'failed', message: 'EACCES' }), /mood\.md 读不出来：EACCES/);
});
