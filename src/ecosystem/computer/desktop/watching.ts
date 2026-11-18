// src/ecosystem/computer/desktop/watching.ts
import { frameLabel, mostlyStill, SHEET_FRAMES, spread, type Frame, type Paused, type RecordTarget, type Recording } from './recording.ts';
import type { DesktopResult } from './turns.ts';

/** A recording this short is waited for and answered with its frames; a longer one returns at once and is looked at later. */
const RECORD_WAIT_SECONDS = 120;
const RECORDED = '这是刚才录下的画面，不是现在的样子。';
/** What she is told became of the video when the recording ended; pressing space was a guess, so its outcome is said. */
const PAUSED: Record<Paused, string> = {
  paused: '录完时替你按了一下空格，画面停住了，视频停在录完的地方；再 record 会先按一下空格接着放。',
  running: '录完时按了一下空格想暂停，但画面还在动，可能没停住：自己看一眼，要停就自己停。',
  still: '录到最后画面已经不动了（放完了或者本来就停着），所以没有按暂停。',
};
const clockTime = (at: Date) => at.toTimeString().slice(0, 8);
interface WatchInput { seconds?: number; every?: number; from?: number; to?: number; at?: number; pause?: boolean }

/**
 * The three actions for watching something that moves, the same in both modes: record what she is on, stop it, and
 * review it: first the whole recording on one sheet, then any stretch of it closer, then one frame.
 */
export function watching(deps: { recording: Recording; target(): Promise<RecordTarget>; what(app: string): string; keep: string }) {
  const { recording } = deps;
  const recordedImage = (data: Buffer): DesktopResult['image'] => ({ data, mediaType: 'image/jpeg', caption: RECORDED });
  async function overview(said: string): Promise<DesktopResult> {
    const { app, frames, cut, paused, resumed } = recording.state(), shown = spread(frames, SHEET_FRAMES), last = frames.at(-1)!;
    // Frames that do not differ are the one sign she gets that nothing was playing, or that this picture cannot be taken.
    const still = mostlyStill(frames);
    return {
      text: `${said}${resumed ? '（开录前先按了一下空格，接着上次停的地方放。）' : ''}${app} 录了 ${frameLabel(last.second)}、${frames.length} 帧${cut ? `（没录满，中途停了：${cut}）` : ''}。下一条消息里是全片的 ${shown.length} 帧拼在一起，每格左上角是第几秒。`
        + '细看一段：desktop review 带 from、to（秒）；看某一秒的原图：带 at。'
        + (still ? '这些帧几乎一模一样，画面没在动：视频没在播（看看播放器上有没有 ▶），或者这个程序的画面截不到。' : '') + '只有画面，没有声音。'
        + (paused && !(still && paused === 'still') ? PAUSED[paused] : '')
        // A recording is a stretch she chose, not the video's own length; the next one replaces this, so this is looked at first.
        + '视频还没放完的话，可以再 record 一次接着录；再录会换掉这一段，想细看的先看完。不想再看了就停下，不用把它看完。',
      image: recordedImage(await recording.sheet(shown)),
    };
  }
  async function stretch(from: unknown, to: unknown): Promise<DesktopResult> {
    const { frames } = recording.state(), end = frames.at(-1)!.second;
    const start = from ?? 0, stop = to ?? end;
    if (typeof start !== 'number' || typeof stop !== 'number' || !(start >= 0 && stop > start)) throw new Error('from、to 是秒数，to 要比 from 大');
    const within = frames.filter(each => each.second >= start && each.second <= stop);
    if (!within.length) throw new Error(`这一段没有帧：录的是 0 到 ${frameLabel(end)}`);
    const shown = spread(within, SHEET_FRAMES);
    return {
      text: `下一条消息里是第 ${frameLabel(shown[0]!.second)} 到 ${frameLabel(shown.at(-1)!.second)} 的 ${shown.length} 帧`
        + (within.length > shown.length ? `（这一段共 ${within.length} 帧，取了其中 ${shown.length} 帧；范围再缩小就看得更密）。` : '（这一段录到的每一帧都在）。'),
      image: recordedImage(await recording.sheet(shown)),
    };
  }
  function single(at: unknown): DesktopResult {
    const { frames } = recording.state();
    if (typeof at !== 'number' || !(at >= 0)) throw new Error('at 是秒数');
    const nearest = frames.reduce<Frame>((best, each) => Math.abs(each.second - at) < Math.abs(best.second - at) ? each : best, frames[0]!);
    return { text: `下一条消息里是第 ${frameLabel(nearest.second)} 的那一帧。`, image: recordedImage(recording.one(nearest)) };
  }

  return {
    record: async (input: WatchInput): Promise<DesktopResult> => {
      const target = await deps.target();
      const { seconds, every, endsAt } = await recording.start(target, input.seconds, input.every, input.pause !== false);
      if (seconds > RECORD_WAIT_SECONDS) return { text: `开始录${deps.what(target.app)}：共 ${seconds} 秒，每 ${every} 秒一帧，${clockTime(endsAt)} 录完。这段时间可以照常操作，也可以去做别的；${deps.keep}录完用 desktop review 看，想到点被叫醒就定个闹钟；不想录了就 desktop stop，录到的照样能看。${input.pause === false ? '' : '录完会替你按一下空格让它暂停。'}` };
      await recording.finished();
      return overview('录好了。');
    },
    stop: async (): Promise<DesktopResult> => {
      if (recording.state().ended) return { text: '现在没有在录的。录好的那一段还在，用 desktop review 看。' };
      await recording.stop();
      return overview('停下了。');
    },
    review: async (input: WatchInput): Promise<DesktopResult> => {
      const { ended, stopping, left } = recording.state();
      if (!ended && !stopping && left > RECORD_WAIT_SECONDS) return { text: `还在录，还剩 ${Math.ceil(left)} 秒。录完再 desktop review；现在就想看，先 desktop stop 停下。` };
      await recording.finished();
      if (input.at !== undefined) return single(input.at);
      return input.from !== undefined || input.to !== undefined ? stretch(input.from, input.to) : overview('');
    },
  };
}
