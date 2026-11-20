// tests/desktopRecording.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createDesktop } from '../src/ecosystem/computer/desktop/desktop.ts';
import { frameLabel, mostlyStill, moved, spread } from '../src/ecosystem/computer/desktop/recording.ts';

type Args = Record<string, unknown>;
const PLAYER = { hwnd: 700, owner: 0, pid: 70, exe: 'player', title: '播放器', minimized: false, width: 1600, height: 900 };
const grey = (level: number) => (level % 250).toString(16).padStart(2, '0').repeat(256);
const TAIL = '视频还没放完的话，可以再 record 一次接着录；再录会换掉这一段，想细看的先看完。不想再看了就停下，不用把它看完。';
const PAUSED = '录完时替你按了一下空格，画面停住了，视频停在录完的地方；再 record 会先按一下空格接着放。';

/**
 * The helper in front of a player: while it plays every picture differs from the last, the space bar toggles it
 * (unless `deaf`), and a paused one still shows a spinner that changes a pixel. One "second" is `secondMs` milliseconds.
 */
function setup(options: { secondMs?: number; playing?: boolean; deaf?: boolean; goneAfter?: number; endsAfter?: number } = {}) {
  const sheets: { files: string[]; labels: string[]; columns: number }[] = [], shots: string[] = [], keys: number[] = [];
  let windows = [PLAYER], playing = options.playing ?? true, picture = 0;
  const driver = { call: async (op: string, args: Args = {}) => {
    if (op === 'windows') return { windows, foreground: 1 };
    if (op === 'key') { keys.push(Number(args.vk)); if (!options.deaf && Number(args.vk) === 0x20) playing = !playing; return {}; }
    if (op === 'shot') {
      const file = String(args.file), frame = /\d{5}\.jpg$/.test(file);
      if (options.goneAfter !== undefined && shots.length >= options.goneAfter && frame) throw new Error('window is gone');
      if (frame) shots.push(file);
      if (options.endsAfter !== undefined && shots.length > options.endsAfter) playing = false;
      if (playing) picture += 5;
      writeFileSync(file, `frame ${shots.length} ${'.'.repeat(shots.length % 7)}`);
      // A paused player is not pixel-identical: its spinner turns.
      const print = grey(picture);
      return { width: 960, height: 540, clientWidth: 1600, clientHeight: 900, print: print.slice(0, -2) + (shots.length % 2 ? '10' : '14') };
    }
    if (op === 'sheet') { sheets.push({ files: args.files as string[], labels: args.labels as string[], columns: Number(args.columns) }); writeFileSync(String(args.file), 'sheet'); return { width: 1, height: 1 }; }
    return {};
  } };
  const desktop = createDesktop({ driver, running: async () => false, settleMs: 0, appearMs: 50, secondMs: options.secondMs ?? 2 });
  return { desktop, sheets, shots, keys, close: () => { windows = []; }, isPlaying: () => playing };
}

test('frames are labelled with the second she passes back, a sheet takes them evenly, and "did it move" is read from the pictures', () => {
  assert.deepEqual([0, 7.5, 59, 60, 65, 130, 600].map(frameLabel), ['0s', '7.5s', '59s', '60s 1:00', '65s 1:05', '130s 2:10', '600s 10:00']);
  assert.deepEqual(spread([1, 2, 3], 12), [1, 2, 3]);
  const picked = spread(Array.from({ length: 61 }, (_unused, n) => n), 12);
  assert.equal(picked.length, 12); assert.equal(picked[0], 0); assert.equal(picked.at(-1), 60);
  assert.deepEqual(picked, [...picked].sort((a, b) => a - b));
  assert.equal(moved(grey(10), grey(15)), true);
  assert.equal(moved(grey(10), grey(10).slice(0, -2) + 'ff'), false, 'one pixel of a spinner is not the picture moving');
  assert.equal(moved('', grey(10)), true, 'what cannot be compared is never called still');
  const frames = (levels: number[]) => levels.map((level, second) => ({ second, file: '', print: grey(level) }));
  assert.equal(mostlyStill(frames([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1])), true);
  assert.equal(mostlyStill(frames([1, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9])), true, 'one change at the start is a page loading, not a video');
  assert.equal(mostlyStill(frames([1, 9, 20, 30, 30, 30, 30])), false);
  assert.equal(mostlyStill(frames([1])), false);
});

test('a short recording is waited for and comes back as one sheet; it is paused for her when it ends, and looked at from the frames, not the window', async () => {
  const s = setup();
  await assert.rejects(s.desktop.act({ action: 'review' }), /还没有录过：先 desktop record/);
  await assert.rejects(s.desktop.act({ action: 'record', seconds: 30 }), /还没有打开窗口/);
  await s.desktop.act({ action: 'open', app: '播放器' });
  const recorded = await s.desktop.act({ action: 'record', seconds: 30 });
  assert.equal(s.shots.length, 31, 'one frame a second, both ends included');
  assert.equal(recorded.text, `录好了。播放器 录了 30s、31 帧。下一条消息里是全片的 12 帧拼在一起，每格左上角是第几秒。细看一段：desktop review 带 from、to（秒）；看某一秒的原图：带 at。只有画面，没有声音。${PAUSED}${TAIL}`);
  assert.deepEqual([s.keys, s.isPlaying()], [[0x20], false], 'the space bar, once, and it stopped');
  assert.deepEqual([recorded.image?.mediaType, recorded.image?.caption, recorded.image?.data.toString()], ['image/jpeg', '这是刚才录下的画面，不是现在的样子。', 'sheet']);
  assert.deepEqual([s.sheets[0]!.labels.length, s.sheets[0]!.labels[0], s.sheets[0]!.labels.at(-1), s.sheets[0]!.columns], [12, '0s', '30s', 4]);

  s.close();
  const closer = await s.desktop.act({ action: 'review', from: 10, to: 14 });
  assert.deepEqual(s.sheets.at(-1)!.labels, ['10s', '11s', '12s', '13s', '14s']);
  assert.equal(closer.text, '下一条消息里是第 10s 到 14s 的 5 帧（这一段录到的每一帧都在）。');
  assert.match((await s.desktop.act({ action: 'review', from: 5 })).text, /第 5s 到 30s 的 12 帧（这一段共 26 帧，取了其中 12 帧；范围再缩小就看得更密）/);
  const one = await s.desktop.act({ action: 'review', at: 12.4 });
  assert.equal(one.text, '下一条消息里是第 12s 的那一帧。');
  assert.match(one.image!.data.toString(), /^frame 13 /);
  await assert.rejects(s.desktop.act({ action: 'review', from: 40, to: 50 }), /这一段没有帧：录的是 0 到 30s/);
  await assert.rejects(s.desktop.act({ action: 'review', from: 9, to: 3 }), /to 要比 from 大/);
  assert.equal(s.shots.length, 31, 'looking never pictures the window again');
});

test('recording the same window again goes on from where it was paused, unless she touched the window in between', async () => {
  const s = setup();
  await s.desktop.act({ action: 'open', app: '播放器' });
  await s.desktop.act({ action: 'record', seconds: 5 });
  assert.equal(s.isPlaying(), false);
  const next = await s.desktop.act({ action: 'record', seconds: 5 });
  assert.match(next.text, /^录好了。（开录前先按了一下空格，接着上次停的地方放。）播放器 录了 5s、6 帧。/);
  assert.doesNotMatch(next.text, /画面没在动/);
  assert.deepEqual(s.keys, [0x20, 0x20, 0x20], 'paused, resumed, paused again');
  await s.desktop.act({ action: 'press', key: 'space' });
  assert.equal(s.isPlaying(), true, 'she started it herself');
  const after = await s.desktop.act({ action: 'record', seconds: 5 });
  assert.doesNotMatch(after.text, /开录前先按了一下空格/);
  assert.equal(s.keys.length, 5, 'her own key, then only the pause at the end');
  const asked = await s.desktop.act({ action: 'record', seconds: 5, pause: false });
  assert.match(asked.text, /开录前先按了一下空格/, 'it goes on from the pause the last one made');
  assert.doesNotMatch(asked.text, /录完时|没有按暂停/);
  assert.deepEqual([s.keys.length, s.isPlaying()], [6, true], 'pause: false leaves it playing when it ends');
});

test('she is told when nothing was playing, when the pause did not take, and when the video ended before the recording did', async () => {
  const paused = setup({ playing: false });
  await paused.desktop.act({ action: 'open', app: '播放器' });
  const still = await paused.desktop.act({ action: 'record', seconds: 20 });
  assert.match(still.text, /这些帧几乎一模一样，画面没在动：视频没在播（看看播放器上有没有 ▶），或者这个程序的画面截不到。只有画面，没有声音。视频还没放完的话/);
  assert.deepEqual(paused.keys, [], 'space is never pressed on a picture that is not moving: it would start it');

  const deaf = setup({ deaf: true });
  await deaf.desktop.act({ action: 'open', app: '播放器' });
  assert.match((await deaf.desktop.act({ action: 'record', seconds: 5 })).text, /录完时按了一下空格想暂停，但画面还在动，可能没停住：自己看一眼，要停就自己停。/);
  const again = await deaf.desktop.act({ action: 'record', seconds: 5 });
  assert.doesNotMatch(again.text, /开录前先按了一下空格/, 'what was not paused is not resumed');

  const ended = setup({ endsAfter: 10 });
  await ended.desktop.act({ action: 'open', app: '播放器' });
  const over = await ended.desktop.act({ action: 'record', seconds: 20 });
  assert.match(over.text, /录到最后画面已经不动了（放完了或者本来就停着），所以没有按暂停。/);
  assert.doesNotMatch(over.text, /画面没在动：视频没在播/);
  assert.deepEqual(ended.keys, []);

  const gone = setup({ goneAfter: 4 });
  await gone.desktop.act({ action: 'open', app: '播放器' });
  const cut = await gone.desktop.act({ action: 'record', seconds: 20 });
  assert.match(cut.text, /^录好了。播放器 录了 3s、4 帧（没录满，中途停了：没做成：window is gone）。/);
  assert.deepEqual(gone.keys, [], 'a window that went away is not sent a key');
});

test('a long recording returns at once and is looked at when it is over; what cannot be recorded is refused before anything starts', async () => {
  // Four milliseconds a "second": a frame every 20 ms, so the first one is back before the second is due even on a busy machine.
  const s = setup({ secondMs: 4 });
  await s.desktop.act({ action: 'open', app: '播放器' });
  for (const [input, why] of [[{ seconds: 0 }, /seconds 要在 1 到 600 之间/], [{ seconds: 601 }, /seconds 要在 1 到 600 之间/], [{}, /seconds 要在/], [{ seconds: 10, every: 0.1 }, /every 要在 0.5 到 30 之间/], [{ seconds: 600, every: 0.5 }, /这样要录 1201 帧，最多 600 帧：把 every 调大/]] as const)
    await assert.rejects(s.desktop.act({ action: 'record', ...input }), why);
  assert.equal(s.shots.length, 0);
  const started = await s.desktop.act({ action: 'record', seconds: 300, every: 5 });
  assert.match(started.text, /^开始录 播放器 的窗口：共 300 秒，每 5 秒一帧，\d\d:\d\d:\d\d 录完。这段时间可以照常操作.*不想录了就 desktop stop，录到的照样能看。录完会替你按一下空格让它暂停。$/);
  assert.equal(started.image, undefined);
  assert.equal(s.shots.length, 1, 'the first frame proves the window can be pictured');
  assert.equal((await s.desktop.act({ action: 'review' })).text.replace(/\d+/, 'N'), '还在录，还剩 N 秒。录完再 desktop review；现在就想看，先 desktop stop 停下。');
  // 300 "seconds" take at least 300ms; under a loaded machine longer, so wait for it to be over rather than for a time.
  let seen = await s.desktop.act({ action: 'review' });
  for (const deadline = Date.now() + 10_000; /^还在录/.test(seen.text) && Date.now() < deadline;) {
    await new Promise(resolve => setTimeout(resolve, 25));
    seen = await s.desktop.act({ action: 'review' });
  }
  assert.match(seen.text, /^播放器 录了 300s 5:00、61 帧。/);
  assert.match(seen.text, /画面停住了/);
  assert.deepEqual([s.sheets.at(-1)!.labels[1], s.sheets.at(-1)!.labels.at(-1)], ['25s', '300s 5:00']);
});

test('a long recording can be stopped part of the way: what was recorded is kept, and the video is paused there', async () => {
  const s = setup({ secondMs: 20 });
  await s.desktop.act({ action: 'open', app: '播放器' });
  await assert.rejects(s.desktop.act({ action: 'stop' }), /还没有录过/);
  await s.desktop.act({ action: 'record', seconds: 300 });
  await new Promise(resolve => setTimeout(resolve, 70));
  const stopped = await s.desktop.act({ action: 'stop' });
  const taken = s.shots.length;
  assert.ok(taken >= 2 && taken < 30, String(taken));
  assert.match(stopped.text, new RegExp(`^停下了。播放器 录了 ${taken - 1}s、${taken} 帧。`));
  assert.match(stopped.text, /画面停住了/);
  assert.equal(stopped.image?.data.toString(), 'sheet');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(s.shots.length, taken, 'nothing more is recorded after it stops');
  assert.match((await s.desktop.act({ action: 'review', at: 1 })).text, /第 1s 的那一帧/);
  assert.equal((await s.desktop.act({ action: 'stop' })).text, '现在没有在录的。录好的那一段还在，用 desktop review 看。');
});

test('a new recording, or the switch going off, deletes the frames of the last one', async () => {
  const s = setup();
  await s.desktop.act({ action: 'open', app: '播放器' });
  await s.desktop.act({ action: 'record', seconds: 3 });
  const first = dirname(s.shots[0]!);
  assert.equal(existsSync(first), true);
  await s.desktop.act({ action: 'record', seconds: 3 });
  const second = dirname(s.shots.at(-1)!);
  assert.notEqual(second, first);
  assert.equal(existsSync(first), false);
  s.desktop.reset();
  assert.equal(existsSync(second), false);
  await assert.rejects(s.desktop.act({ action: 'review' }), /还没有录过/);
});
