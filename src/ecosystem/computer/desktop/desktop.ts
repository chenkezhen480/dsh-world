// src/ecosystem/computer/desktop/desktop.ts
import { setTimeout as pause } from 'node:timers/promises';
import { createActions, createSign, SETTLE_MS } from './actions.ts';
import type { DesktopDriver } from './driver.ts';
import { VK, type DesktopInput } from './input.ts';
import { APPEAR_MS, isRunning, openWindows, pick, reach, type Listed, type StartApp } from './programs.ts';
import { createRecording } from './recording.ts';
import { createTurns, type DesktopResult } from './turns.ts';
import { watching } from './watching.ts';

export { STOPPED, type DesktopAction, type DesktopResult } from './turns.ts';

export type Desktop = ReturnType<typeof createDesktop>;

const GIVE_BACK_TRIES = 3;
/**
 * Posted input reaches a program that reads its messages; one that reads the real mouse and keyboard (many games) never
 * sees a button or a key held, so a held press or a drag that changed nothing at all is told with what to do about it.
 */
const UNMOVED = '截图和动手之前一模一样。后台模式下，有的程序（很多游戏）读的是真实的鼠标键盘，看不到按住、拖动和滑动；该动的没动，就请伙伴切到前台模式。';
interface Window { hwnd: number; pid: number; app: string }

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
  const settleMs = deps.settleMs ?? SETTLE_MS, appearMs = deps.appearMs ?? APPEAR_MS;
  let window: Window | undefined;
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

  /** A window that went away (closed, minimized, into the tray) is never pictured; she is told and opens it again. */
  async function visible(): Promise<{ open: Window; windows: Listed[] }> {
    const open = current(), { windows } = await list();
    if (windows.some(entry => entry.hwnd === open.hwnd && !entry.minimized)) return { open, windows };
    window = undefined; actions.forget();
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
  const actions = createActions({
    kind: 'desktop', settleMs, unseen: '还没看过这个窗口：先 desktop shot', unmoved: UNMOVED,
    ready: () => { current(); }, subject: () => `${current().app} `,
    picture: async framing => {
      const seen = await visible();
      return { shot: await call('shot', { hwnd: seen.open.hwnd, ...framing }), also: changes(seen) + others(seen) };
    },
    input: {
      click: (at, how) => call('click', { hwnd: current().hwnd, ...at, ...how }),
      stroke: (points, how) => call('stroke', { hwnd: current().hwnd, xs: points.map(point => point.x), ys: points.map(point => point.y), ...how }),
      type: text => call('type', { hwnd: current().hwnd, text }),
      key: (key, hold) => call('key', { hwnd: current().hwnd, ...key, ...(hold === undefined ? {} : { hold }) }),
      scroll: (at, up, right) => call('scroll', { hwnd: current().hwnd, ...at, up, right }),
    },
  });

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
  async function open(app?: string): Promise<DesktopResult> {
    const { windows, foreground } = await list();
    if (!app?.trim()) return { text: openWindows(windows) };
    const name = app.trim();
    // A tray icon is clicked with the partner's pointer left where it is; if it moved meanwhile, that may be them.
    let pointer: { before?: unknown; after?: unknown } = {};
    const reached = await reach(name, windows, {
      list: async () => (await list()).windows, apps: async () => ((await call('apps')).apps as StartApp[] | undefined) ?? [],
      running: deps.running ?? isRunning, appearMs, launch: appId => call('launch', { appId }),
      tray: async called => {
        const before = (await call('cursor')).cursor, tray = await call('tray', { name: called });
        pointer = { before, after: tray.cursor };
        return tray.result === 'opened';
      },
    });
    let told = '';
    if (reached.via === 'tray') {
      const moved = JSON.stringify(pointer.after) !== JSON.stringify(pointer.before) ? '（伙伴的鼠标位置变了，可能是伙伴自己在动。）' : '';
      told = `它收在托盘里，已经从托盘图标点开；${await giveBack(foreground)}${moved}\n`;
    }
    if (reached.via === 'launch') told = `${reached.name} 没开，已经启动；${await giveBack(foreground)}\n`;
    const chosen = pick(reached.windows, name);
    if (chosen.minimized) {
      if ((await call('restore', { hwnd: chosen.hwnd })).restored !== true) throw new Error(`${name} 最小化着，还原不出来`);
      told += '它原来最小化着，已经还原，没有抢伙伴的焦点。\n';
    }
    // Switching between one program's windows keeps what was seen; another program starts afresh.
    if (window?.pid !== chosen.pid) known = undefined;
    window = { hwnd: chosen.hwnd, pid: chosen.pid, app: name };
    actions.forget();
    return actions.shot(told);
  }

  const watch = watching({
    recording, what: app => ` ${app} 的窗口`, keep: '窗口不能最小化、不能收进托盘。',
    target: async () => {
      const { open: target } = await visible();
      return {
        key: `window:${target.hwnd}`, app: target.app,
        capture: async (file, edge) => String((await call('shot', { hwnd: target.hwnd, file, edge, grow: 1, x: 0, y: 0, w: 0, h: 0, marks: [] })).print ?? ''),
        space: () => call('key', { hwnd: target.hwnd, vk: VK.space, modifiers: [] }),
      };
    },
  });
  const run: Record<string, (input: DesktopInput) => Promise<DesktopResult>> = {
    record: input => watch.record(input), stop: () => watch.stop(), review: input => watch.review(input),
    open: input => open(input.app), ...actions.run,
  };
  const turns = createTurns<DesktopInput>({
    run, recording, app: () => window?.app, ...(deps.lingerMs === undefined ? {} : { lingerMs: deps.lingerMs }),
    sign: createSign({ call: (op, args) => deps.driver.call(op, args), target: () => window?.hwnd, ...(deps.companion ? { companion: deps.companion } : {}), ...(deps.signFault ? { signFault: deps.signFault } : {}) }),
    acted: what => { acted = { what, at: Date.now() }; },
  });
  return {
    actions: turns.actions, act: turns.act, recent: turns.recent, halt: turns.halt, release: turns.release, halted: turns.halted,
    /** When the switch goes off: nothing she opened stays "current" for a later turn, and what she recorded is deleted. */
    reset(): void { window = undefined; actions.forget(); known = undefined; acted = undefined; recording.clear(); turns.reset(); },
  };
}
