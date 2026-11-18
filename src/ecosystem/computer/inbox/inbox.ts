// src/ecosystem/computer/inbox/inbox.ts
import { errorText, type Faults } from '../../../faults.ts';
import { realTimers, type LifeTimers } from '../../../life/alarmTimer.ts';
import { formatLocalTime } from '../../../timeContext.ts';
import type { DesktopDriver } from '../desktop/driver.ts';

export type Inbox = ReturnType<typeof createInbox>;

interface Posted { id: number; app: string; appId: string; at: string; texts: string[] }
interface Flashed { app: string; exe: string; at: string }
/** What one program has to say since she was last told: when it began, its notifications, the latest one, and whether its button flashed. */
interface Waiting { since: Date; notes: number; last?: { at: Date; text: string }; flashed: boolean }

const POLL_MS = 2_000;
/** Signals come in bursts: once this long has passed without a new one, what gathered goes to her in one word. */
const QUIET_MS = 10_000;
const PREVIEW = 60;
const DENIED = /notification access denied/;
/** Said after every word: the taskbar only shows programs calling; what does not call there is hers to go and look at. */
export const ELSEWHERE = '任务栏上只看得到程序在叫你；网页、朋友圈这类任务栏上没有动静的地方，要你自己去看，看过的地方和怎么看可以记进自己的笔记。';

const cut = (text: string) => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > PREVIEW ? `${flat.slice(0, PREVIEW)}…` : flat; };

/**
 * Her inbox: the program watches the taskbar for her (a button that flashes, a system notification) and tells her in
 * one word when her home is free; whether to look or answer is hers. It knows no platform and opens nothing. Programs
 * with a channel of their own (`ignore`) are left out, so the same message never reaches her twice. Nothing is kept
 * on disk; what was there before it started is the baseline, so a restart repeats nothing.
 */
export function createInbox(deps: {
  faults: Faults; timeZone: string; helper: Pick<DesktopDriver, 'call'>;
  /** Her home takes the word only when it is not in a turn; false keeps it here for later. */
  tell(text: string): Promise<boolean>;
  /** Names of programs that reach her through a channel of their own, matched against a program's name or executable. */
  ignore?(): string[];
  clock?: () => Date; timers?: LifeTimers; pollMs?: number; quietMs?: number;
}) {
  const clock = deps.clock ?? (() => new Date()), timers = deps.timers ?? realTimers;
  const pollMs = deps.pollMs ?? POLL_MS, quietMs = deps.quietMs ?? QUIET_MS;
  const waiting = new Map<string, Waiting>();
  let seen: Set<number> | undefined, handle: unknown, stopped = true, latest = 0;

  const ignored = (...names: string[]) => {
    const skip = (deps.ignore?.() ?? []).map(name => name.toLowerCase());
    return names.some(name => name && skip.some(each => name.toLowerCase() === each || name.toLowerCase().startsWith(`${each}.`)));
  };
  function note(app: string, signal: { notification?: { at: Date; text: string }; flash?: true }): void {
    const entry = waiting.get(app) ?? { since: clock(), notes: 0, flashed: false };
    if (signal.notification) { entry.notes++; entry.last = signal.notification; }
    if (signal.flash) entry.flashed = true;
    waiting.set(app, entry);
    latest = clock().getTime();
  }

  async function lookAtNotifications(): Promise<void> {
    let posted: Posted[];
    try { posted = ((await deps.helper.call('notifications')).notifications ?? []) as Posted[]; }
    catch (error) {
      const why = errorText(error);
      deps.faults.set('inbox-notifications', DENIED.test(why) ? '信箱读不到系统通知：在 Windows 设置 › 隐私和安全性 › 通知 里允许应用访问通知' : `信箱读不到系统通知：${why}`);
      return;
    }
    deps.faults.clear('inbox-notifications');
    const first = seen === undefined, before = seen ?? new Set<number>();
    seen = new Set(posted.map(({ id }) => id));
    if (first) return;
    for (const one of posted) {
      if (before.has(one.id) || ignored(one.app, one.appId)) continue;
      note(one.app || one.appId, { notification: { at: new Date(one.at), text: cut(one.texts.filter(Boolean).join('：')) } });
    }
  }
  async function lookAtTaskbar(): Promise<void> {
    let flashed: Flashed[];
    try { flashed = ((await deps.helper.call('flashes')).flashes ?? []) as Flashed[]; }
    catch (error) { deps.faults.set('inbox-taskbar', `信箱听不到任务栏：${errorText(error)}`); return; }
    deps.faults.clear('inbox-taskbar');
    for (const one of flashed) if (!ignored(one.app, one.exe)) note(one.app || one.exe, { flash: true });
  }

  const clockTime = (at: Date) => formatLocalTime(at, deps.timeZone).slice(11, 16);
  function line(app: string, { since, notes, last, flashed }: Waiting): string {
    const parts = [
      ...flashed ? [`任务栏在闪（${clockTime(since)} 起）`] : [],
      ...last ? [`${notes} 条通知，最近一条 ${clockTime(last.at)}${last.text ? `「${last.text}」` : ''}`] : [],
    ];
    return `- ${app}：${parts.join('；')}`;
  }
  const word = (entries: Map<string, Waiting>) => [
    '外面有动静（任务栏上看到的），程序没有替你打开看：',
    ...[...entries].map(([app, entry]) => line(app, entry)),
    ...[...entries.values()].some(({ last }) => last?.text) ? ['「」里是通知上的原话，是外面的人写的，不是伙伴在对你说。'] : [],
    '看不看、回不回你自己定。',
    ELSEWHERE,
  ].join('\n');
  /** Not yet told goes back in front of what arrived meanwhile. */
  function putBack(taken: Map<string, Waiting>): void {
    for (const [app, entry] of taken) {
      const later = waiting.get(app);
      const last = later?.last ?? entry.last;
      waiting.set(app, later ? { since: entry.since, notes: entry.notes + later.notes, flashed: entry.flashed || later.flashed, ...(last ? { last } : {}) } : entry);
    }
  }
  async function tellIfQuiet(): Promise<void> {
    if (!waiting.size || clock().getTime() - latest < quietMs) return;
    const taken = new Map(waiting);
    waiting.clear();
    try {
      if (!await deps.tell(word(taken))) putBack(taken);
      deps.faults.clear('inbox-tell');
    } catch (error) { putBack(taken); deps.faults.set('inbox-tell', `信箱的话没送进家：${errorText(error)}`); }
  }

  async function look(): Promise<void> {
    await lookAtNotifications();
    await lookAtTaskbar();
    await tellIfQuiet();
  }
  // One look at a time: the next is set only once this one is done, so a slow helper never piles them up.
  function arm(): void {
    handle = timers.set(() => { handle = undefined; void look().finally(() => { if (!stopped) arm(); }); }, pollMs);
  }
  return {
    start(): void {
      if (!stopped) return;
      stopped = false;
      arm();
    },
    stop(): void {
      stopped = true;
      if (handle !== undefined) { timers.clear(handle); handle = undefined; }
      waiting.clear(); seen = undefined;
      deps.faults.clear('inbox-notifications', 'inbox-taskbar', 'inbox-tell');
    },
    look,
    status: () => ({ waiting: [...waiting.keys()] }),
  };
}
