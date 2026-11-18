// src/ecosystem/computer/desktop/recording.ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type Recording = ReturnType<typeof createRecording>;
/**
 * What is recorded: a window in background mode, the whole screen in foreground mode. `key` tells one target from
 * another, `capture` pictures it into a file (FRAME_EDGE long) and gives its print, `space` presses the space bar on it.
 */
export interface RecordTarget { key: string; app: string; capture(file: string, edge: number): Promise<string>; space(): Promise<unknown> }
/** `print` is the helper's 16×16 grey thumbnail of the frame, as hex: what two frames are compared by. */
export interface Frame { second: number; file: string; print: string }
/** What became of the video when the recording ended: stopped by the space bar, still running after it, or already not moving. */
export type Paused = 'paused' | 'running' | 'still';

/** A recording is at most this long and this many frames: ten minutes at one a second is some tens of megabytes. */
export const MAX_SECONDS = 600, MAX_FRAMES = 600;
const MIN_EVERY = 0.5, MAX_EVERY = 30;
/** A frame's long edge: enough to read subtitles in a single frame, small enough to keep hundreds. */
const FRAME_EDGE = 960;
/** Frames on one sheet, and a tile's width: twelve tiles read as one picture, more turn to mush. */
export const SHEET_FRAMES = 12;
const SHEET_COLUMNS = 4, TILE = 480;
/** Mean difference of two prints (0–255) above which the picture moved: a spinner or a blinking cursor stays under it. */
const MOVED = 1.5;
/** A recording in which fewer than this share of the frames differ from the one before is told as not moving. */
const STILL_SHARE = 0.1;
/** How long a player takes to act on the space bar, and how far apart the two looks are that tell whether it stopped, in seconds. */
const KEY_SETTLE = 0.6, PROBE_GAP = 0.8;

interface Take {
  dir: string; app: string; target: RecordTarget; seconds: number; every: number; startedAt: number; frames: Frame[];
  ended: boolean; cut?: string; paused?: Paused; resumed: boolean;
  /** `stopped`: she ended it and keeps the frames. `discarded`: replaced or switched off, the folder is gone. */
  stopped: boolean; discarded: boolean; done: Promise<void>;
  /** Stopped by the partner: nothing more is sent to the window, not even the pause. */
  quiet?: boolean;
}

/** `65s 1:05`: the second she passes back, and the clock reading a person would look for. */
export const frameLabel = (second: number) => {
  const whole = Math.round(second * 10) / 10;
  return whole < 60 ? `${whole}s` : `${whole}s ${Math.floor(whole / 60)}:${String(Math.floor(whole % 60)).padStart(2, '0')}`;
};
/** Up to `max` of the frames, spread evenly, first and last included. */
export function spread<T>(frames: readonly T[], max: number): T[] {
  if (frames.length <= max) return [...frames];
  return Array.from({ length: max }, (_unused, index) => frames[Math.round(index * (frames.length - 1) / (max - 1))]!);
}
/** Whether the picture changed between two frames; prints that cannot be compared count as changed, never as a false "still". */
export function moved(before: string, after: string): boolean {
  if (!before || before.length !== after.length || before.length % 2) return true;
  let total = 0;
  for (let at = 0; at < before.length; at += 2) total += Math.abs(parseInt(before.slice(at, at + 2), 16) - parseInt(after.slice(at, at + 2), 16));
  return total / (before.length / 2) > MOVED;
}
/** A recording of something that was not playing: nearly every frame is the one before it. */
export function mostlyStill(frames: readonly Frame[]): boolean {
  if (frames.length < 2) return false;
  const changes = frames.slice(1).filter((each, index) => moved(frames[index]!.print, each.print)).length;
  return changes / (frames.length - 1) < STILL_SHARE;
}

/**
 * How she watches something that moves: the window (or the screen) is pictured at a steady pace into a folder of frames, and what
 * she looks at afterwards is always that folder, never the program again. One recording at a time; a new one, or the
 * switch going off, deletes the last. The frames are pictures of the window only, with no sound.
 *
 * A video goes on playing while she reads what was recorded, and is somewhere else by the time she records again. So
 * when a recording ends on a moving picture the space bar is pressed for her, which pauses nearly every player, and
 * the next recording of the same window presses it again to go on. It is a guess: what came of it is looked at and told.
 */
export function createRecording(deps: { call(op: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>; secondMs?: number }) {
  // `call` is the helper, for laying frames out on a sheet; the frames themselves come from the target.
  const secondMs = deps.secondMs ?? 1000;
  const wait = (seconds: number) => new Promise(resolve => setTimeout(resolve, seconds * secondMs));
  let take: Take | undefined, files = 0;
  /** The target this module paused and nothing has touched since: the next recording of it starts by un-pausing. */
  let pausedTarget: string | undefined;

  async function frame(into: Take, index: number): Promise<void> {
    const file = join(into.dir, `${String(index).padStart(5, '0')}.jpg`);
    into.frames.push({ second: index * into.every, file, print: await into.target.capture(file, FRAME_EDGE) });
  }
  /** Two looks a moment apart, kept out of the recording. */
  async function probe(into: Take): Promise<boolean> {
    const file = join(into.dir, `probe-${++files}.jpg`);
    try {
      const first = await into.target.capture(file, FRAME_EDGE);
      await wait(PROBE_GAP);
      return moved(first, await into.target.capture(file, FRAME_EDGE));
    } finally { rmSync(file, { force: true }); }
  }
  /** Pauses what was playing when the recording ended; a picture that had already stopped is left alone, or the key would start it. */
  async function pause(into: Take): Promise<void> {
    const last = into.frames.slice(-3);
    if (last.length < 2 || !last.slice(1).some((each, index) => moved(last[index]!.print, each.print))) { into.paused = 'still'; return; }
    await into.target.space();
    await wait(KEY_SETTLE);
    into.paused = await probe(into) ? 'running' : 'paused';
    if (into.paused === 'paused') pausedTarget = into.target.key;
  }
  /** Each frame is aimed at its own moment from the start, so a slow one does not push the rest later. */
  async function run(into: Take, count: number, pauseAfter: boolean): Promise<void> {
    for (let index = 1; index < count && !into.stopped && !into.discarded; index++) {
      const left = into.startedAt + index * into.every * secondMs - Date.now();
      if (left > 0) await new Promise(resolve => setTimeout(resolve, left));
      if (into.stopped || into.discarded) break;
      try { await frame(into, index); }
      catch (error) { into.cut = error instanceof Error ? error.message : String(error); break; }
    }
    // The window may be gone, or the helper busy: the frames are what she asked for, the pause is a courtesy.
    if (pauseAfter && !into.cut && !into.discarded && !into.quiet) await pause(into).catch(() => {});
    into.ended = true;
  }
  function clear(): void {
    pausedTarget = undefined;
    if (!take) return;
    take.discarded = true;
    rmSync(take.dir, { recursive: true, force: true });
    take = undefined;
  }
  function recorded(): Take {
    if (!take) throw new Error('还没有录过：先 desktop record');
    return take;
  }

  return {
    /** Starts over a target; the first frame is taken before this returns, so one that cannot be pictured fails here. */
    async start(target: RecordTarget, seconds: unknown, every: unknown = 1, pauseAfter = true): Promise<{ seconds: number; every: number; endsAt: Date; resumed: boolean }> {
      if (typeof seconds !== 'number' || !(seconds >= 1 && seconds <= MAX_SECONDS)) throw new Error(`seconds 要在 1 到 ${MAX_SECONDS} 之间（录多少秒）`);
      if (typeof every !== 'number' || !(every >= MIN_EVERY && every <= MAX_EVERY)) throw new Error(`every 要在 ${MIN_EVERY} 到 ${MAX_EVERY} 之间（每几秒一帧）`);
      const count = Math.floor(seconds / every) + 1;
      if (count > MAX_FRAMES) throw new Error(`这样要录 ${count} 帧，最多 ${MAX_FRAMES} 帧：把 every 调大`);
      const resumed = pausedTarget === target.key;
      clear();
      if (resumed) { await target.space(); await wait(KEY_SETTLE); }
      const fresh: Take = { dir: mkdtempSync(join(tmpdir(), 'dsh-world-record-')), app: target.app, target, seconds, every, startedAt: Date.now(), frames: [], ended: false, resumed, stopped: false, discarded: false, done: Promise.resolve() };
      try { await frame(fresh, 0); }
      catch (error) { rmSync(fresh.dir, { recursive: true, force: true }); throw error; }
      take = fresh;
      fresh.done = run(fresh, count, pauseAfter);
      return { seconds, every, endsAt: new Date(fresh.startedAt + seconds * secondMs), resumed };
    },
    /** How it stands: what is recorded so far, whether it is over, and why it stopped early if it did. */
    state(): { app: string; seconds: number; every: number; frames: Frame[]; ended: boolean; stopping: boolean; left: number; resumed: boolean; cut?: string; paused?: Paused } {
      const { app, seconds, every, frames, ended, cut, paused, resumed, startedAt, stopped } = recorded();
      // Stopped but still taking its last frame: over in a moment, so it is waited for, not reported as still going.
      return { app, seconds, every, frames: [...frames], ended, stopping: stopped && !ended, resumed, left: ended ? 0 : Math.max(0, seconds - (Date.now() - startedAt) / secondMs), ...(cut ? { cut } : {}), ...(paused ? { paused } : {}) };
    },
    /** Resolves when the recording is over. */
    finished: (): Promise<void> => recorded().done,
    /** Ends it where it is and keeps what was recorded; over once the frame being taken, if any, is in. */
    stop(quiet = false): Promise<void> {
      const current = recorded();
      current.stopped = true;
      if (quiet) current.quiet = true;
      return current.done;
    },
    /** Whether a recording is still going. */
    running: (): boolean => take !== undefined && !take.ended,
    /** She touched the window herself, so whether it is paused is no longer this module's to know. */
    touched(): void { pausedTarget = undefined; },
    /** Some frames as one picture, each with its time in the corner. */
    async sheet(frames: readonly Frame[]): Promise<Buffer> {
      const file = join(recorded().dir, `sheet-${++files}.jpg`);
      try {
        await deps.call('sheet', { files: frames.map(each => each.file), labels: frames.map(each => frameLabel(each.second)), file, columns: Math.min(SHEET_COLUMNS, frames.length), tile: TILE });
        return readFileSync(file);
      } finally { rmSync(file, { force: true }); }
    },
    one: (target: Frame): Buffer => readFileSync(target.file),
    clear,
  };
}
