// src/ecosystem/computer/desktop/actions.ts
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { errorText } from '../../../faults.ts';
import { desktopKey, dragged, holdMs, NOTCHES, pressed, VK, type DesktopInput, type Point } from './input.ts';
import type { DesktopResult } from './turns.ts';

/** The screenshot's long edge; her coordinates are in this image's pixels and are mapped back to real ones. */
const IMAGE_EDGE = 1280;
/** A zoomed part is enlarged at most this many times, past which it only gets blurrier. */
const ZOOM_GROW = 4;
/** How long a program has to repaint after input before the next picture. */
export const SETTLE_MS = 400;

/** What the helper is asked to picture: a part (all of it when `w` is 0), fitted to `edge`, with her last input marked. */
export interface Framing { file: string; edge: number; grow: number; x: number; y: number; w: number; h: number; markX: number; markY: number }
/** How a mode sends input. Positions are real pixels: the window's client area in the background, the screen in front. */
export interface Input {
  click(at: Point, how: { right: boolean; count: number; hold: number }): Promise<unknown>;
  drag(from: Point, to: Point, how: { right: boolean; hold: number }): Promise<unknown>;
  type(text: string): Promise<unknown>;
  /** Without `hold`, a plain stroke. */
  key(key: { vk: number; modifiers: number[] }, hold?: number): Promise<unknown>;
  scroll(at: Point, up: number, right: number): Promise<unknown>;
}
/** The last picture she was given: how many real pixels one of its pixels is, its size, where it starts, and its print. */
interface View { scale: number; width: number; height: number; left: number; top: number; print: string }
type Action = (input: DesktopInput) => Promise<DesktopResult>;

/**
 * What she does with what she sees, the same in both modes: she is given a picture and acts by its pixels, and every
 * action is answered with a fresh picture, so a wrong click is caught by her, not assumed fine. A mode says how it
 * pictures (`picture`) and how it sends input (`input`).
 */
export function createActions(deps: {
  input: Input;
  /** Pictures what she is on into `framing.file`; `also` is said after the picture. Throws when nothing can be pictured. */
  picture(framing: Framing): Promise<{ shot: Record<string, unknown>; also?: string }>;
  /** What a picture is of, as she is told it (`微信 `, `整个屏幕`), asked once it is taken. */
  subject(): string;
  /** Throws, before her pixels are read, when she has nothing to act on. */
  ready?(): void;
  /** Why her pixels mean nothing yet. */
  unseen: string;
  /** Said when a held press or a drag left the picture exactly as it was, in a mode where that may mean it was never felt. */
  unmoved?: string;
  /** Names the temporary picture files. */
  kind: string;
  settleMs: number;
}) {
  let view: View | undefined, shots = 0;

  async function take(region?: { x: number; y: number; w: number; h: number }, mark?: Point) {
    const file = join(tmpdir(), `dsh-world-${deps.kind}-${process.pid}-${++shots}.png`);
    try {
      const { shot, also = '' } = await deps.picture({ file, edge: IMAGE_EDGE, grow: region ? ZOOM_GROW : 1, ...(region ?? { x: 0, y: 0, w: 0, h: 0 }), markX: mark?.x ?? -1, markY: mark?.y ?? -1 });
      return { data: readFileSync(file), width: Number(shot.width), height: Number(shot.height), clientWidth: Number(shot.clientWidth), left: Number(shot.left ?? 0), top: Number(shot.top ?? 0), print: String(shot.print ?? ''), also };
    } finally { rmSync(file, { force: true }); }
  }
  /** A picture pixel to a real one (`local` is on the pictured area itself); outside the picture is refused, it would land somewhere she never saw. */
  function at(x: unknown, y: unknown): { real: Point; local: Point } {
    deps.ready?.();
    if (!view) throw new Error(deps.unseen);
    if (typeof x !== 'number' || typeof y !== 'number') throw new Error('要给 x、y（截图上的像素）');
    if (x < 0 || y < 0 || x > view.width || y > view.height) throw new Error(`x、y 要在截图里面（${view.width}×${view.height}）`);
    const local = { x: Math.round(x * view.scale), y: Math.round(y * view.scale) };
    return { local, real: { x: local.x + view.left, y: local.y + view.top } };
  }
  /** `before`: the print of the picture a held press or a drag started from, to tell her when nothing at all changed. */
  async function shot(said = '', mark?: Point, before?: string): Promise<DesktopResult> {
    const taken = await take(undefined, mark);
    view = { scale: taken.clientWidth / taken.width, width: taken.width, height: taken.height, left: taken.left, top: taken.top, print: taken.print };
    if (deps.unmoved && before && taken.print === before) said += deps.unmoved;
    if (mark) said += '图上的红圈是刚才点到的地方，没点中就看偏了多少，改了再点。';
    return { text: `${said}${deps.subject()}的截图附在下一条消息里（${taken.width}×${taken.height}）。按图上的像素用 desktop click 带 x、y；字太小就 desktop zoom。${taken.also}`, image: { data: taken.data, mediaType: 'image/png' } };
  }
  /** After acting she sees the result; `held` is a press held down or dragged. */
  async function after(done: string, mark?: Point, held = false): Promise<DesktopResult> {
    const before = held ? view?.print : undefined;
    await pause(deps.settleMs);
    return shot(done, mark, before);
  }

  const run = {
    shot: () => shot(),
    click: async input => {
      const { real, local } = at(input.x, input.y), hold = holdMs(input.hold);
      await deps.input.click(real, { right: input.right === true, count: input.double ? 2 : 1, hold });
      return after(pressed('点击', input.hold), local, hold > 0);
    },
    drag: async input => {
      const from = at(input.x, input.y), to = at(input.x2, input.y2);
      await deps.input.drag(from.real, to.real, { right: input.right === true, hold: holdMs(input.hold) });
      return after(dragged(input.hold), to.local, true);
    },
    type: async input => {
      if (typeof input.text !== 'string' || !input.text) throw new Error('text 不能是空的');
      const point = input.x !== undefined || input.y !== undefined ? at(input.x, input.y) : undefined;
      if (point) await deps.input.click(point.real, { right: false, count: 1, hold: 0 });
      await deps.input.type(input.text);
      if (input.submit) await deps.input.key({ vk: VK.return!, modifiers: [] });
      return after(input.submit ? '已输入并回车。' : '已输入。', point?.local);
    },
    press: async input => {
      const key = desktopKey(String(input.key ?? '')), hold = holdMs(input.hold);
      await deps.input.key(key, hold);
      return after(pressed(`按 ${input.key}`, input.hold), undefined, hold > 0);
    },
    scroll: async input => {
      const step = { up: [NOTCHES, 0], down: [-NOTCHES, 0], left: [0, -NOTCHES], right: [0, NOTCHES] }[String(input.direction)];
      if (!step) throw new Error('direction 只能是 up、down、left 或 right');
      deps.ready?.();
      if (!view) throw new Error(deps.unseen);
      const point = input.x === undefined && input.y === undefined ? at(view.width / 2, view.height / 2) : at(input.x, input.y);
      await deps.input.scroll(point.real, step[0]!, step[1]!);
      return after('已滚动。');
    },
    zoom: async input => {
      const from = at(input.x, input.y).local, to = at(input.x2, input.y2).local;
      if (!(to.x > from.x && to.y > from.y)) throw new Error('zoom 要给左上角 x、y 和右下角 x2、y2（截图上的像素）');
      const part = await take({ x: from.x, y: from.y, w: to.x - from.x, h: to.y - from.y });
      return { text: '放大的局部附在下一条消息里；在它上面量的坐标不能直接点，回到整张截图上点。', image: { data: part.data, mediaType: 'image/png' } };
    },
  } satisfies Record<string, Action>;

  return {
    run, shot, after,
    /** What she saw no longer holds (another window, or none): her pixels mean nothing until the next picture. */
    forget(): void { view = undefined; },
  };
}

/**
 * The sign the partner sees while she acts: a banner the program words (never her text) over `target()`, the window
 * she is on or 0 for the whole screen; nothing while she is on nothing yet. One that cannot be drawn is said in the
 * console's health, never a failed action of hers.
 */
export function createSign(deps: { call(op: string, args: Record<string, unknown>): Promise<unknown>; target(): number | undefined; companion?(): string; signFault?(text: string | undefined): void }) {
  return async (show: boolean): Promise<void> => {
    const hwnd = deps.target();
    if (!deps.companion || (show && hwnd === undefined)) return;
    try {
      await deps.call('sign', show ? { show: true, hwnd, text: `${deps.companion()}正在操作`, hint: '连按两下 Esc 停下', stop: '停下', stopped: '已停下' } : { show: false });
      deps.signFault?.(undefined);
    } catch (error) { deps.signFault?.(`她操作时的提示没能显示：${errorText(error)}`); }
  };
}
