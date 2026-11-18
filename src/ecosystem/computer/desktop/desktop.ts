// src/ecosystem/computer/desktop/desktop.ts
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DesktopDriver } from './driver.ts';
import { isRunning } from './processes.ts';
import { createRecording } from './recording.ts';
import { createTurns, type DesktopResult } from './turns.ts';
import { watching } from './watching.ts';

export { STOPPED, type DesktopAction, type DesktopResult } from './turns.ts';

export type Desktop = ReturnType<typeof createDesktop>;

/** The screenshot's long edge; her coordinates are in this image's pixels and are mapped back to the window's. */
export const IMAGE_EDGE = 1280;
/** A zoomed part is enlarged at most this many times, past which it only gets blurrier. */
export const ZOOM_GROW = 4;
const WINDOWS_SHOWN = 30;
/** How long a program has to repaint after input before the next picture, and to show a window after a launch. */
const SETTLE_MS = 400, APPEAR_MS = 10_000, GIVE_BACK_TRIES = 3;
/** Mouse-wheel notches per scroll: about a screenful in most programs. */
export const NOTCHES = 3;
export const VK: Record<string, number> = {
  return: 0x0d, tab: 0x09, escape: 0x1b, space: 0x20, backspace: 0x08, delete: 0x2e, home: 0x24, end: 0x23,
  pageup: 0x21, pagedown: 0x22, left: 0x25, up: 0x26, right: 0x27, down: 0x28,
};
const MODIFIER_VK: Record<string, number> = { ctrl: 0x11, shift: 0x10, alt: 0x12 };
const KEY_ALIASES: Record<string, string> = { enter: 'return', esc: 'escape', pgup: 'pageup', pgdn: 'pagedown', del: 'delete' };
export const DESKTOP_KEYS = 'return、tab、escape、space、backspace、delete、home、end、pageup、pagedown、方向键 up/down/left/right、f1–f12、单个字母或数字，可加 ctrl+、shift+、alt+';

/** `owner` is the window it belongs to (0 for a main window): dialogs and panels such as WeChat's Moments composer. */
export interface Listed { hwnd: number; owner: number; pid: number; exe: string; title: string; minimized: boolean; width: number; height: number }
interface Window { hwnd: number; pid: number; app: string }
/** The last picture of the current window: how many window pixels one picture pixel is, and its size. */
interface View { scale: number; width: number; height: number }

/** `D:\\微信\\Weixin\\Weixin.exe` → `Weixin`; a Store app's id has no executable. */
const executable = (appId: string) => /([^\\/"]+)\.exe$/i.exec(appId)?.[1];
const area = (window: Listed) => window.width * window.height;
export const largest = (windows: Listed[]) => [...windows].sort((a, b) => area(b) - area(a))[0];
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A key as people write it (`Enter`, `ctrl+f`) to its virtual-key code and modifiers; anything else is refused. */
export function desktopKey(text: string): { vk: number; modifiers: number[] } {
  const parts = text.toLowerCase().split('+').map(part => KEY_ALIASES[part.trim()] ?? part.trim());
  const last = parts.pop() ?? '';
  const vk = VK[last] ?? (/^f([1-9]|1[0-2])$/.test(last) ? 0x6f + Number(last.slice(1)) : /^[a-z0-9]$/.test(last) ? last.toUpperCase().charCodeAt(0) : undefined);
  if (vk === undefined || !parts.every(part => part in MODIFIER_VK)) throw new Error(`不认识按键 ${text}，可用：${DESKTOP_KEYS}`);
  return { vk, modifiers: parts.map(part => MODIFIER_VK[part]!) };
}

/** The longest she can hold a button or a key: the helper does nothing else meanwhile, and cannot be stopped mid-press. */
export const MAX_HOLD_SECONDS = 10;
/** `hold` (seconds) as milliseconds, 0 for a plain press; out of range is refused. */
export function holdMs(hold: number | undefined): number {
  if (hold === undefined) return 0;
  if (!(hold > 0 && hold <= MAX_HOLD_SECONDS)) throw new Error(`hold 是按住的秒数，大于 0、最多 ${MAX_HOLD_SECONDS}`);
  return Math.round(hold * 1000);
}
/** What she is told she did: a press, or a press held for so long. */
/** What she is told after a drag: where it went, and how long it was held first. */
export const dragged = (hold: number | undefined) => hold === undefined ? '已拖过去。' : `已按住 ${hold} 秒再拖过去。`;
export const pressed = (what: string, hold: number | undefined) => hold === undefined ? `已${what}。` : `已${what === '点击' ? '长按' : what}，按住 ${hold} 秒。`;

/** The program's windows, by her name for it: an exact title, the executable, then a title that starts with it. */
export function windowsNamed(windows: Listed[], name: string): Listed[] {
  const wanted = name.toLowerCase();
  const hit = windows.find(entry => entry.title.toLowerCase() === wanted) ?? windows.find(entry => entry.exe.toLowerCase() === wanted)
    ?? windows.find(entry => entry.title.toLowerCase().startsWith(wanted));
  return hit ? windows.filter(entry => entry.pid === hit.pid) : [];
}

/**
 * Her turn on the partner's computer: one current window, its last picture, and what she did. She sees screenshots
 * and acts by their pixels, the way a person does. Input is posted to the window, so the partner's pointer and focus
 * stay theirs; a window that is brought up or launched hands the focus straight back. One action at a time, in order.
 */
export function createDesktop(deps: {
  driver: Pick<DesktopDriver, 'call'>; running?(executable: string): Promise<boolean>; settleMs?: number; appearMs?: number; secondMs?: number;
  /** Her name on the banner the partner sees while she acts; without it there is no banner. */
  companion?(): string;
  /** A banner that could not be drawn: said in the console's health, never a failed action of hers. */
  signFault?(text: string | undefined): void;
  lingerMs?: number;
}) {
  const running = deps.running ?? isRunning, settleMs = deps.settleMs ?? SETTLE_MS, appearMs = deps.appearMs ?? APPEAR_MS;
  let window: Window | undefined, view: View | undefined, shots = 0;
  /** The program's windows as last seen, and her last input: what changed after it, and how soon, is told to her. */
  let known: Map<number, string> | undefined, acted: { what: string; at: number } | undefined;

  const call = (op: string, args: Record<string, unknown> = {}) => deps.driver.call(op, args).catch((error: unknown) => {
    const why = error instanceof Error ? error.message : String(error);
    // Windows keeps an ordinary program away from an administrator's windows; background mode has no way round that.
    if (/ELEVATED/.test(why)) throw new Error(`${window?.app ?? '这个窗口'}是以管理员权限运行的程序，后台模式截不到、也点不了它。要操作它，请伙伴切到前台模式。`);
    throw new Error(`没做成：${why}`);
  });
  const recording = createRecording({ call, ...(deps.secondMs === undefined ? {} : { secondMs: deps.secondMs }) });
  async function list(): Promise<{ windows: Listed[]; foreground: number }> {
    const data = await call('windows');
    return { windows: (data.windows as Listed[] | undefined) ?? [], foreground: Number(data.foreground ?? 0) };
  }
  function current(): Window {
    if (!window) throw new Error('还没有打开窗口：先 desktop open 一个程序');
    return window;
  }
  /** A picture pixel to a window pixel; outside the picture is refused, it would land in some other window. */
  function onWindow(x: unknown, y: unknown): { x: number; y: number } {
    current();
    if (!view) throw new Error('还没看过这个窗口：先 desktop shot');
    if (typeof x !== 'number' || typeof y !== 'number') throw new Error('要给 x、y（截图上的像素）');
    if (x < 0 || y < 0 || x > view.width || y > view.height) throw new Error(`x、y 要在截图里面（${view.width}×${view.height}）`);
    return { x: Math.round(x * view.scale), y: Math.round(y * view.scale) };
  }

  /** A window that went away (closed, minimized, into the tray) is never pictured; she is told and opens it again. */
  async function visible(): Promise<{ open: Window; windows: Listed[] }> {
    const open = current(), { windows } = await list();
    if (windows.some(entry => entry.hwnd === open.hwnd && !entry.minimized)) return { open, windows };
    window = undefined; view = undefined;
    throw new Error(`${open.app} 的窗口不见了（关掉了、最小化了或收进了托盘）：先 desktop open 它`);
  }
  /** A picture holds one window only, so a dialog or panel the program opened beside it is named, or she would never know. */
  function others({ open, windows }: { open: Window; windows: Listed[] }): string {
    const titles = [...new Set(windows.filter(entry => entry.pid === open.pid && entry.hwnd !== open.hwnd && !entry.minimized).map(entry => `「${entry.title}」`))];
    return titles.length ? `\n${open.app} 还开着别的窗口：${titles.join('、')}，不在这张截图里；要操作它就 desktop open 它的标题。` : '';
  }
  /**
   * A dialog or panel opens a moment after the input that asked for it. By hand she never notices, since she looks
   * between steps; a replay does not wait unless she wrote it down. So each change is told with the time it took.
   */
  function changes({ open, windows }: { open: Window; windows: Listed[] }): string {
    const now = new Map(windows.filter(entry => entry.pid === open.pid && !entry.minimized).map(entry => [entry.hwnd, entry.title]));
    const before = known;
    known = now;
    if (!before || !acted) return '';
    const appeared = [...now].filter(([hwnd]) => !before.has(hwnd)).map(([, title]) => `「${title}」`);
    const gone = [...before].filter(([hwnd]) => !now.has(hwnd)).map(([, title]) => `「${title}」`);
    if (!appeared.length && !gone.length) return '';
    const what = [appeared.length ? `出现了${appeared.join('、')}` : '', gone.length ? `关掉了${gone.join('、')}` : ''].filter(Boolean).join('，');
    return `\n窗口变了：${what}（在上一次${acted.what}之后 ${((Date.now() - acted.at) / 1000).toFixed(1)} 秒内）。窗口是过一会儿才变的；存成操作时，用到它的那一步前面要加 wait，回放时步与步之间不停。`;
  }
  async function picture(region?: { x: number; y: number; w: number; h: number }, mark?: { x: number; y: number }): Promise<{ data: Buffer; width: number; height: number; clientWidth: number; also: string }> {
    const seen = await visible(), { hwnd } = seen.open;
    const file = join(tmpdir(), `dsh-world-desktop-${process.pid}-${++shots}.png`);
    try {
      const shot = await call('shot', { hwnd, file, edge: IMAGE_EDGE, grow: region ? ZOOM_GROW : 1, ...(region ?? { x: 0, y: 0, w: 0, h: 0 }), markX: mark?.x ?? -1, markY: mark?.y ?? -1 });
      return { data: readFileSync(file), width: Number(shot.width), height: Number(shot.height), clientWidth: Number(shot.clientWidth), also: changes(seen) + others(seen) };
    } finally { rmSync(file, { force: true }); }
  }
  async function shot(said = '', mark?: { x: number; y: number }): Promise<DesktopResult> {
    const taken = await picture(undefined, mark);
    if (mark) said += '图上的红圈是刚才点到的地方，没点中就看偏了多少，改了再点。';
    view = { scale: taken.clientWidth / taken.width, width: taken.width, height: taken.height };
    return { text: `${said}${current().app} 的截图附在下一条消息里（${taken.width}×${taken.height}）。按图上的像素用 desktop click 带 x、y；字太小就 desktop zoom。${taken.also}`, image: { data: taken.data, mediaType: 'image/png' } };
  }
  /** After acting she sees the result: a wrong click is caught by her, not assumed fine. */
  async function after(done: string, clicked?: { x: number; y: number }): Promise<DesktopResult> {
    await pause(settleMs);
    return shot(done, clicked);
  }

  /** Waits for a window of the program to show up, as one does after a click on the tray or a launch. */
  async function appear(name: string, exe: string | undefined, before: Set<number>): Promise<Listed[]> {
    for (const deadline = Date.now() + appearMs; ;) {
      const { windows } = await list();
      const fresh = windows.filter(entry => !before.has(entry.hwnd));
      const mine = windowsNamed(windows, name).length ? windowsNamed(windows, name)
        : exe ? windows.filter(entry => entry.exe.toLowerCase() === exe.toLowerCase()) : [];
      if (mine.length) return mine;
      if (Date.now() >= deadline) return fresh.length === 1 ? fresh : [];
      await pause(Math.min(500, appearMs));
    }
  }
  /** The partner's window goes back in front; a sentence for her when that did not work. */
  async function giveBack(foreground: number): Promise<string> {
    if (!foreground) return '原来在前面的是桌面，焦点留在新窗口上。';
    // The program pulls itself to the front a moment after its window shows (WeChat from the tray does), which undoes
    // a hand-back made too early; so it is checked after a pause and made again.
    for (let attempt = 0; attempt < GIVE_BACK_TRIES; attempt++) {
      await pause(settleMs);
      await call('refocus', { hwnd: foreground });
      await pause(settleMs);
      if ((await list()).foreground === foreground) return '焦点还给了伙伴原来的窗口。';
    }
    return '焦点没能还给伙伴原来的窗口。';
  }
  /**
   * A program closed to the tray has no window, and launching it again opens a second copy (WeChat 4.x does), so
   * its tray icon is clicked: that is the program showing itself, which a window forced visible from outside is not.
   */
  async function fromTray(name: string, foreground: number, before: Set<number>): Promise<{ windows: Listed[]; told: string }> {
    const cursor = (await call('cursor')).cursor;
    const tray = await call('tray', { name });
    if (tray.result !== 'opened') return { windows: [], told: '' };
    const windows = await appear(name, undefined, before);
    if (!windows.length) throw new Error(`点了 ${name} 的托盘图标，但 ${appearMs / 1000} 秒内没有出现它的窗口`);
    const moved = JSON.stringify(tray.cursor) !== JSON.stringify(cursor) ? '（伙伴的鼠标位置变了，可能是伙伴自己在动。）' : '';
    return { windows, told: `它收在托盘里，已经从托盘图标点开；${await giveBack(foreground)}${moved}\n` };
  }
  async function launch(name: string, foreground: number, before: Set<number>): Promise<{ windows: Listed[]; told: string }> {
    const apps = ((await call('apps')).apps as { name: string; appId: string }[] | undefined) ?? [];
    const wanted = name.toLowerCase();
    const app = apps.find(entry => entry.name.toLowerCase() === wanted) ?? apps.find(entry => entry.name.toLowerCase().includes(wanted));
    if (!app) throw new Error(`找不到叫「${name}」的程序：开着的窗口、托盘图标和开始菜单里都没有。不带 app 调 desktop open 看看开着哪些`);
    const exe = executable(app.appId);
    if (exe && await running(exe)) throw new Error(`${app.name} 开着，但没有窗口，托盘里也找不到它的图标；再启动会多开一个，所以不启动。请伙伴把它打开。`);
    await call('launch', { appId: app.appId });
    const windows = await appear(app.name, exe, before);
    if (!windows.length) throw new Error(`${app.name} 启动了，但 ${appearMs / 1000} 秒内没有出现窗口`);
    return { windows, told: `${app.name} 没开，已经启动；${await giveBack(foreground)}\n` };
  }
  async function open(app?: string): Promise<DesktopResult> {
    const { windows, foreground } = await list();
    if (!app?.trim()) {
      const titles = [...new Set(windows.map(entry => entry.title))].slice(0, WINDOWS_SHOWN);
      return { text: `开着的窗口：${titles.join('、') || '（没有）'}。收在托盘里的、没开的，写它的名字也能打开。` };
    }
    const name = app.trim(), before = new Set(windows.map(entry => entry.hwnd));
    let mine = windowsNamed(windows, name), told = '';
    if (!mine.length) ({ windows: mine, told } = await fromTray(name, foreground, before));
    if (!mine.length) ({ windows: mine, told } = await launch(name, foreground, before));
    // Her name may be one window's own title (a panel such as 朋友圈); otherwise the program's main window.
    const titled = mine.find(entry => entry.title.toLowerCase() === name.toLowerCase() && !entry.minimized);
    let chosen = titled ?? largest(mine.filter(entry => !entry.minimized && !entry.owner)) ?? largest(mine.filter(entry => !entry.minimized));
    if (!chosen) {
      const minimized = largest(mine)!;
      if ((await call('restore', { hwnd: minimized.hwnd })).restored !== true) throw new Error(`${name} 最小化着，还原不出来`);
      chosen = minimized;
      told += '它原来最小化着，已经还原，没有抢伙伴的焦点。\n';
    }
    // Switching between one program's windows keeps what was seen; another program starts afresh.
    if (window?.pid !== chosen.pid) known = undefined;
    window = { hwnd: chosen.hwnd, pid: chosen.pid, app: name };
    view = undefined;
    return shot(told);
  }

  // The sign: a banner the program words (never her text) and a frame around the window she is on, while she acts.
  async function sign(show: boolean): Promise<void> {
    if (!deps.companion || (show && !window)) return;
    try {
      await deps.driver.call('sign', show && window ? { show: true, hwnd: window.hwnd, text: `${deps.companion()}正在操作`, hint: '连按两下 Esc 停下', stop: '停下', stopped: '已停下' } : { show: false });
      deps.signFault?.(undefined);
    } catch (error) { deps.signFault?.(`她操作时的提示没能显示：${error instanceof Error ? error.message : String(error)}`); }
  }
  const watch = watching({
    recording, what: app => ` ${app} 的窗口`, keep: '窗口不能最小化、不能收进托盘。',
    target: async () => {
      const { open: target } = await visible();
      return {
        key: `window:${target.hwnd}`, app: target.app,
        capture: async (file, edge) => String((await call('shot', { hwnd: target.hwnd, file, edge, grow: 1, x: 0, y: 0, w: 0, h: 0, markX: -1, markY: -1 })).print ?? ''),
        space: () => call('key', { hwnd: target.hwnd, vk: VK.space, modifiers: [] }),
      };
    },
  });

  const run: Record<string, (input: DesktopInput) => Promise<DesktopResult>> = {
    record: input => watch.record(input),
    stop: () => watch.stop(),
    review: input => watch.review(input),
    open: input => open(input.app),
    shot: () => shot(),
    click: async input => {
      const at = onWindow(input.x, input.y);
      await call('click', { hwnd: current().hwnd, ...at, right: input.right === true, count: input.double ? 2 : 1, hold: holdMs(input.hold) });
      return after(pressed('点击', input.hold), at);
    },
    drag: async input => {
      const from = onWindow(input.x, input.y), to = onWindow(input.x2, input.y2);
      await call('drag', { hwnd: current().hwnd, x: from.x, y: from.y, x2: to.x, y2: to.y, right: input.right === true, hold: holdMs(input.hold) });
      return after(dragged(input.hold), to);
    },
    type: async input => {
      if (typeof input.text !== 'string' || !input.text) throw new Error('text 不能是空的');
      const at = input.x !== undefined || input.y !== undefined ? onWindow(input.x, input.y) : undefined;
      if (at) await call('click', { hwnd: current().hwnd, ...at, right: false, count: 1 });
      await call('type', { hwnd: current().hwnd, text: input.text });
      if (input.submit) await call('key', { hwnd: current().hwnd, vk: VK.return, modifiers: [] });
      return after(input.submit ? '已输入并回车。' : '已输入。', at);
    },
    press: async input => {
      await call('key', { hwnd: current().hwnd, ...desktopKey(String(input.key ?? '')), hold: holdMs(input.hold) });
      return after(pressed(`按 ${input.key}`, input.hold));
    },
    scroll: async input => {
      const step = { up: [NOTCHES, 0], down: [-NOTCHES, 0], left: [0, -NOTCHES], right: [0, NOTCHES] }[String(input.direction)];
      if (!step) throw new Error('direction 只能是 up、down、left 或 right');
      if (!view) throw new Error('还没看过这个窗口：先 desktop shot');
      const at = input.x === undefined && input.y === undefined ? onWindow(view.width / 2, view.height / 2) : onWindow(input.x, input.y);
      await call('scroll', { hwnd: current().hwnd, ...at, up: step[0], right: step[1] });
      return after('已滚动。');
    },
    zoom: async input => {
      const from = onWindow(input.x, input.y), to = onWindow(input.x2, input.y2);
      if (!(to.x > from.x && to.y > from.y)) throw new Error('zoom 要给左上角 x、y 和右下角 x2、y2（截图上的像素）');
      const part = await picture({ x: from.x, y: from.y, w: to.x - from.x, h: to.y - from.y });
      return { text: '放大的局部附在下一条消息里；在它上面量的坐标不能直接点，回到整张截图上点。', image: { data: part.data, mediaType: 'image/png' } };
    },
  };

  const turns = createTurns<DesktopInput>({
    run, sign, recording, app: () => window?.app, ...(deps.lingerMs === undefined ? {} : { lingerMs: deps.lingerMs }),
    acted: what => { acted = { what, at: Date.now() }; },
  });
  return {
    actions: turns.actions, act: turns.act, recent: turns.recent, halt: turns.halt, release: turns.release, halted: turns.halted,
    /** When the switch goes off: nothing she opened stays "current" for a later turn, and what she recorded is deleted. */
    reset(): void { window = undefined; view = undefined; known = undefined; acted = undefined; recording.clear(); turns.reset(); },
  };
}
export interface DesktopInput {
  action: string; app?: string; x?: number; y?: number; x2?: number; y2?: number; text?: string; submit?: boolean; key?: string; direction?: string; double?: boolean; right?: boolean;
  /** For `click`, `drag` and `press`: seconds to keep the button or the key down (a long press, or walking in a game). */
  hold?: number;
  /** For `record`: how long, and how far apart the frames are. For `review`: a stretch of the recording, or one moment of it. */
  seconds?: number; every?: number; from?: number; to?: number; at?: number; pause?: boolean;
}
