// src/ecosystem/computer/desktop/input.ts

/** One `desktop` call as she makes it, in either mode; the same words are what a saved operation replays. */
export interface DesktopInput {
  action: string; app?: string; x?: number; y?: number; x2?: number; y2?: number; text?: string; submit?: boolean; key?: string; direction?: string; double?: boolean; right?: boolean;
  /** For `click`, `drag` and `press`: seconds to keep the button or the key down (a long press, or walking in a game). */
  hold?: number;
  /** For `swipe`: [x, y] points on her screenshot, from where it is pressed, through each in turn, to where it is let go. */
  path?: number[][];
  /**
   * For `record`: how long, and how far apart the frames are. For `review`: a stretch of the recording, or one moment of
   * it. For `swipe`: how long the whole stroke takes.
   */
  seconds?: number; every?: number; from?: number; to?: number; at?: number; pause?: boolean;
}

/** A position: on her screenshot when she gives it, in real pixels once it is mapped back. */
export interface Point { x: number; y: number }

/** Mouse-wheel notches per scroll: about a screenful in most programs. */
export const NOTCHES = 3;
export const VK: Record<string, number> = {
  return: 0x0d, tab: 0x09, escape: 0x1b, space: 0x20, backspace: 0x08, delete: 0x2e, home: 0x24, end: 0x23,
  pageup: 0x21, pagedown: 0x22, left: 0x25, up: 0x26, right: 0x27, down: 0x28,
};
const MODIFIER_VK: Record<string, number> = { ctrl: 0x11, shift: 0x10, alt: 0x12 };
const KEY_ALIASES: Record<string, string> = { enter: 'return', esc: 'escape', pgup: 'pageup', pgdn: 'pagedown', del: 'delete' };
export const DESKTOP_KEYS = 'return、tab、escape、space、backspace、delete、home、end、pageup、pagedown、方向键 up/down/left/right、f1–f12、单个字母或数字，可加 ctrl+、shift+、alt+';

/** A key as people write it (`Enter`, `ctrl+f`) to its virtual-key code and modifiers; anything else is refused. */
export function desktopKey(text: string): { vk: number; modifiers: number[] } {
  const parts = text.toLowerCase().split('+').map(part => KEY_ALIASES[part.trim()] ?? part.trim());
  const last = parts.pop() ?? '';
  const vk = VK[last] ?? (/^f([1-9]|1[0-2])$/.test(last) ? 0x6f + Number(last.slice(1)) : /^[a-z0-9]$/.test(last) ? last.toUpperCase().charCodeAt(0) : undefined);
  if (vk === undefined || !parts.every(part => part in MODIFIER_VK)) throw new Error(`不认识按键 ${text}，可用：${DESKTOP_KEYS}`);
  return { vk, modifiers: parts.map(part => MODIFIER_VK[part]!) };
}

/** The longest she can hold a button or a key, on the partner's computer or in her browser: nothing else is done meanwhile, and a press cannot be stopped halfway. */
export const MAX_HOLD_SECONDS = 10;
/** `hold` (seconds) as milliseconds, 0 for a plain press; out of range is refused. */
export function holdMs(hold: number | undefined): number {
  if (hold === undefined) return 0;
  if (!(hold > 0 && hold <= MAX_HOLD_SECONDS)) throw new Error(`hold 是按住的秒数，大于 0、最多 ${MAX_HOLD_SECONDS}`);
  return Math.round(hold * 1000);
}
/** A drag waits this long after the press unless held longer, then travels in this long: what programs that take drags saw. */
export const DRAG_PAUSE_MS = 80, DRAG_MS = 400;
/** A swipe moves at once: one step after the press, not a long press that some programs take for picking a thing up. */
export const SWIPE_PAUSE_MS = 20;
/** The most points one swipe passes through: enough for an S across a board. */
export const MAX_SWIPE_POINTS = 20;
/**
 * How long a swipe of `length` picture pixels takes: `seconds` when she says, else about a pixel a millisecond, so a short
 * flick is quick and an S across the screen is still seen point by point.
 */
export function swipeMs(seconds: number | undefined, length: number): number {
  if (seconds === undefined) return Math.min(3000, Math.max(200, Math.round(length)));
  if (!(seconds > 0 && seconds <= MAX_HOLD_SECONDS)) throw new Error(`seconds 是整个滑动用的秒数，大于 0、最多 ${MAX_HOLD_SECONDS}`);
  return Math.round(seconds * 1000);
}
/** What she is told after a drag: how long it was held first. */
export const dragged = (hold: number | undefined) => hold === undefined ? '已拖过去。' : `已按住 ${hold} 秒再拖过去。`;
/**
 * What she is told she did, the same words on her partner's computer and in her own browser: a press, or a press held
 * for so long. `at` names what was pressed (` [3]` for an element of her page).
 */
export const pressed = (what: string, hold: number | undefined, at = '') => hold === undefined ? `已${what}${at}。` : `已${what === '点击' ? '长按' : what}${at}，按住 ${hold} 秒。`;
