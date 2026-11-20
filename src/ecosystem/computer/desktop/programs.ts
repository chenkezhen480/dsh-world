// src/ecosystem/computer/desktop/programs.ts
import { execFile } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { errorText } from '../../../faults.ts';

/**
 * A top-level window as the helper lists it. `owner` is the window it belongs to (0 for a main window): dialogs and
 * panels such as WeChat's Moments composer. `appId` is a Store app's id, the one the Start menu starts it by.
 */
export interface Listed { hwnd: number; owner: number; pid: number; exe: string; title: string; minimized: boolean; width: number; height: number; appId?: string }
/** A Start menu entry: what it is called there, and what starts it (a path for most programs, an id for a Store app). */
export interface StartApp { name: string; appId: string }

/** How long a program has to show a window after its tray icon is clicked or it is launched. */
export const APPEAR_MS = 10_000;
const WINDOWS_SHOWN = 30;

/** `D:\\微信\\Weixin\\Weixin.exe` → `Weixin`; a Store app's id has no executable. */
export const executable = (appId: string) => /([^\\/"]+)\.exe$/i.exec(appId)?.[1];
const area = (window: Listed) => window.width * window.height;
const largest = (windows: Listed[]) => [...windows].sort((a, b) => area(b) - area(a))[0];
/** A title that names the program: as its start (`微信`), or after the dash Windows puts before it (`下载 - 文件资源管理器`). */
const names = (title: string, wanted: string) => { const own = title.toLowerCase(); return own === wanted || own.startsWith(wanted) || own.endsWith(` - ${wanted}`); };

/** The program's windows, by her name for it: an exact title, the executable, then a title that names it. */
function windowsNamed(windows: Listed[], name: string): Listed[] {
  const wanted = name.toLowerCase();
  const hit = windows.find(entry => entry.title.toLowerCase() === wanted) ?? windows.find(entry => entry.exe.toLowerCase() === wanted)
    ?? windows.find(entry => names(entry.title, wanted));
  return hit ? windows.filter(entry => entry.pid === hit.pid) : [];
}
/** Her name for a program in the Start menu: an entry called that, else one whose name holds it. */
function startApp(apps: StartApp[], name: string): StartApp | undefined {
  const wanted = name.toLowerCase();
  return apps.find(entry => entry.name.toLowerCase() === wanted) ?? apps.find(entry => entry.name.toLowerCase().includes(wanted));
}
/** A Start menu entry's windows, whatever their titles say: a Store app's by its id, any other's by its executable. */
function windowsOf(windows: Listed[], app: StartApp): Listed[] {
  const exe = executable(app.appId)?.toLowerCase();
  return windows.filter(entry => (entry.appId !== undefined && entry.appId === app.appId) || (exe !== undefined && entry.exe.toLowerCase() === exe));
}
/** Which of the program's windows she gets: the one her name is the title of, else one its title names, else its main window. */
export function pick(mine: Listed[], name: string): Listed {
  const wanted = name.toLowerCase(), shown = mine.filter(entry => !entry.minimized);
  return shown.find(entry => entry.title.toLowerCase() === wanted) ?? largest(shown.filter(entry => names(entry.title, wanted)))
    ?? largest(shown.filter(entry => !entry.owner)) ?? largest(shown) ?? largest(mine)!;
}
/** What she is told when she opens nothing by name. */
export const openWindows = (windows: Listed[]) =>
  `开着的窗口：${[...new Set(windows.map(entry => entry.title))].slice(0, WINDOWS_SHOWN).join('、') || '（没有）'}。收在托盘里的、没开的，写它的名字也能打开。`;

/**
 * Whether a program with this executable name is running, windows or not: WeChat closed to the tray has none, and
 * launching it then would open a second copy.
 */
export function isRunning(name: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile('tasklist', ['/FI', `IMAGENAME eq ${name}.exe`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 10_000 }, (error, stdout) => {
      if (error) return reject(new Error(`查不到 ${name} 有没有在运行：${error.message}`));
      resolve(stdout.toLowerCase().includes(`"${name.toLowerCase()}.exe"`));
    });
  });
}

/** Waits for the program's window to show up; when none says it is, a single new window is taken for it. */
async function appear(list: () => Promise<Listed[]>, find: (windows: Listed[]) => Listed[], before: Set<number>, appearMs: number): Promise<Listed[]> {
  for (const deadline = Date.now() + appearMs; ;) {
    const windows = await list();
    const mine = find(windows);
    if (mine.length) return mine;
    if (Date.now() >= deadline) { const fresh = windows.filter(entry => !before.has(entry.hwnd)); return fresh.length === 1 ? fresh : []; }
    await pause(Math.min(500, appearMs));
  }
}

/** How she reached the program: it was open, it was brought back from its tray icon, or it was launched. */
export interface Reached { windows: Listed[]; via: 'open' | 'tray' | 'launch'; name: string }
/**
 * The program she names, brought up the way a person would: its open windows, found by title or executable, or through
 * its Start menu entry, which may call it something else (记事本 for Notepad); else its tray icon, since launching a
 * program closed to the tray opens a second copy (WeChat 4.x does); else the Start menu, unless it is running without
 * a window or an icon, where a launch would be that second copy too.
 */
export async function reach(name: string, windows: Listed[], deps: {
  list(): Promise<Listed[]>; apps(): Promise<StartApp[]>; running(executable: string): Promise<boolean>;
  /** Clicks its tray icon; false when it has none. */
  tray(name: string): Promise<boolean>;
  launch(appId: string): Promise<unknown>;
  appearMs: number;
}): Promise<Reached> {
  const named = windowsNamed(windows, name);
  if (named.length) return { windows: named, via: 'open', name };
  // The Start menu tells a renamed program by its file; one that cannot be listed leaves the tray to try, and is said when it was needed.
  let unlisted: string | undefined;
  const entry = startApp(await deps.apps().catch(error => { unlisted = errorText(error); return []; }), name);
  /** Her name for it, else what the Start menu calls it, else its executable or Store id. */
  const find = (list: Listed[], called: string) => { const own = windowsNamed(list, called); return own.length || !entry ? own : windowsOf(list, entry); };
  const known = entry ? windowsOf(windows, entry) : [];
  if (known.length) return { windows: known, via: 'open', name };
  const before = new Set(windows.map(each => each.hwnd)), seconds = deps.appearMs / 1000;
  if (await deps.tray(name)) {
    const shown = await appear(deps.list, list => find(list, name), before, deps.appearMs);
    if (!shown.length) throw new Error(`点了 ${name} 的托盘图标，但 ${seconds} 秒内没有出现它的窗口`);
    return { windows: shown, via: 'tray', name };
  }
  if (!entry) throw new Error(unlisted
    ? `找不到叫「${name}」的程序：开着的窗口和托盘图标里都没有，开始菜单没能读出来（${unlisted}）。不带 app 调 desktop open 看看开着哪些`
    : `找不到叫「${name}」的程序：开着的窗口、托盘图标和开始菜单里都没有。不带 app 调 desktop open 看看开着哪些`);
  const exe = executable(entry.appId);
  if (exe && await deps.running(exe)) throw new Error(`${entry.name} 开着，但没有窗口，托盘里也找不到它的图标；再启动会多开一个，所以不启动。请伙伴把它打开。`);
  await deps.launch(entry.appId);
  const launched = await appear(deps.list, list => find(list, entry.name), before, deps.appearMs);
  if (!launched.length) throw new Error(`${entry.name} 启动了，但 ${seconds} 秒内没有出现窗口；过一会儿再 desktop open 它`);
  return { windows: launched, via: 'launch', name: entry.name };
}
