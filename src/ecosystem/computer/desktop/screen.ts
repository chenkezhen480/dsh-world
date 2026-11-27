// src/ecosystem/computer/desktop/screen.ts
import { createActions, createSign, SETTLE_MS } from './actions.ts';
import type { DesktopDriver } from './driver.ts';
import { VK, type DesktopInput } from './input.ts';
import { APPEAR_MS, isRunning, openWindows, pick, reach, type Listed, type StartApp } from './programs.ts';
import { createRecording } from './recording.ts';
import { createTurns, type DesktopResult } from './turns.ts';
import { watching } from './watching.ts';

export type Screen = ReturnType<typeof createScreen>;

/** Here she has the whole computer: the sign stays up between her steps, which take her a while to think out. */
const SCREEN_LINGER_MS = 30_000;

/**
 * Foreground mode: the partner hands her the computer. She sees the whole screen and acts with the real mouse and
 * keyboard, so every program answers her, games and administrators' windows too. `hands` is the helper the partner
 * approved as administrator: pictures, input and the sign go through it, so its stop key works over any window.
 * `eyes` is the ordinary helper: listing windows and starting programs stay out of the administrator's reach, so
 * nothing she opens runs as administrator. One action at a time; the partner's stop works as in background mode.
 */
export function createScreen(deps: {
  hands: Pick<DesktopDriver, 'call'>; eyes: Pick<DesktopDriver, 'call'>;
  companion?(): string; signFault?(text: string | undefined): void; running?(executable: string): Promise<boolean>;
  settleMs?: number; appearMs?: number; secondMs?: number; lingerMs?: number;
}) {
  const appearMs = deps.appearMs ?? APPEAR_MS;
  let front: string | undefined;
  const wrap = (driver: Pick<DesktopDriver, 'call'>) => (op: string, args: Record<string, unknown> = {}) => driver.call(op, args).catch((error: unknown) => {
    throw new Error(`没做成：${error instanceof Error ? error.message : String(error)}`);
  });
  const hands = wrap(deps.hands), eyes = wrap(deps.eyes);
  const recording = createRecording({ call: hands, ...(deps.secondMs === undefined ? {} : { secondMs: deps.secondMs }) });
  const windows = async () => ((await eyes('windows')).windows as Listed[] | undefined) ?? [];
  const actions = createActions({
    kind: 'screen', settleMs: deps.settleMs ?? SETTLE_MS, unseen: '还没看过屏幕：先 desktop shot', subject: () => '整个屏幕',
    picture: async framing => ({ shot: await hands('screen', { ...framing }) }),
    front: async () => {
      const listed = await eyes('windows'), hwnd = Number(listed.foreground);
      return { hwnd, title: (listed.windows as Listed[] | undefined)?.find(window => window.hwnd === hwnd)?.title };
    },
    input: {
      click: (at, how) => hands('rclick', { ...at, ...how }),
      stroke: (points, how) => hands('rstroke', { xs: points.map(point => point.x), ys: points.map(point => point.y), ...how }),
      type: text => hands('rtype', { text }),
      key: (key, hold) => hands('rkey', { ...key, ...(hold === undefined ? {} : { hold }) }),
      scroll: (at, up, right) => hands('rscroll', { ...at, up, right }),
    },
  });

  /** A program's window in front: found or brought up as in background mode, then restored and put in front. */
  async function open(app?: string): Promise<DesktopResult> {
    const listed = await windows();
    if (!app?.trim()) return { text: openWindows(listed) };
    const name = app.trim();
    const reached = await reach(name, listed, {
      list: windows, apps: async () => ((await eyes('apps')).apps as StartApp[] | undefined) ?? [],
      running: deps.running ?? isRunning, appearMs, launch: appId => eyes('launch', { appId }),
      tray: async called => (await eyes('tray', { name: called })).result === 'opened',
    });
    let told = reached.via === 'tray' ? '它收在托盘里，已经从托盘图标点开。\n' : reached.via === 'launch' ? `${reached.name} 没开，已经启动。\n` : '';
    const chosen = pick(reached.windows, name);
    if (chosen.minimized) await hands('restore', { hwnd: chosen.hwnd });
    if ((await hands('refocus', { hwnd: chosen.hwnd })).refocused !== true) told += '没能把它放到最前面，看截图确认。\n';
    front = name;
    return actions.after(told);
  }

  const watch = watching({
    recording, what: () => '整个屏幕', keep: '',
    target: async () => ({
      key: 'screen', app: '屏幕',
      capture: async (file, edge) => String((await hands('screen', { file, edge, grow: 1, x: 0, y: 0, w: 0, h: 0, marks: [] })).print ?? ''),
      space: () => hands('rkey', { vk: VK.space, modifiers: [] }),
    }),
  });
  const run: Record<string, (input: DesktopInput) => Promise<DesktopResult>> = {
    record: input => watch.record(input), stop: () => watch.stop(), review: input => watch.review(input),
    open: input => open(input.app), ...actions.run,
  };
  // The sign covers the whole screen here, and lives in the administrator helper so its stop key is heard over any window.
  const sign = createSign({ call: (op, args) => deps.hands.call(op, args), target: () => 0, ...(deps.companion ? { companion: deps.companion } : {}), ...(deps.signFault ? { signFault: deps.signFault } : {}) });
  const turns = createTurns<DesktopInput>({ run, sign, recording, app: () => front, lingerMs: deps.lingerMs ?? SCREEN_LINGER_MS });
  return {
    actions: turns.actions, act: turns.act, recent: turns.recent, halt: turns.halt, release: turns.release, halted: turns.halted,
    /** When foreground mode is turned off: what she saw and recorded goes with it. */
    reset(): void { actions.forget(); front = undefined; recording.clear(); turns.reset(); },
  };
}
