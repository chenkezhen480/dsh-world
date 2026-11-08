import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Edge first: every Windows has it, and it speaks the same DevTools protocol as Chrome. Machine-wide installs live
 * under Program Files, per-user ones under LocalAppData. Ported from dsh-inner-browser-use (MIT, see ../NOTICE.md).
 */
export function browserCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [env['PROGRAMFILES(X86)'], env['PROGRAMFILES'], env['LOCALAPPDATA']].filter((root): root is string => typeof root === 'string' && root !== '');
  return [
    ...roots.map(root => join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    ...roots.map(root => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')),
  ];
}

export const findBrowser = (candidates = browserCandidates(), exists: (path: string) => boolean = existsSync) => candidates.find(path => exists(path));

const portFile = (profileDir: string) => join(profileDir, 'DevToolsActivePort');
/** The browser writes this file itself, so a read may catch it half-written or locked: that is no port yet. */
function readPort(profileDir: string): number {
  try {
    const port = Number(readFileSync(portFile(profileDir), 'utf8').split('\n')[0]);
    return Number.isSafeInteger(port) && port > 0 ? port : 0;
  } catch { return 0; }
}

/** The port of a browser already running on this profile, or 0; a port file nobody answers on is removed. */
export async function runningPort(profileDir: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  if (!existsSync(portFile(profileDir))) return 0;
  const port = readPort(profileDir);
  if (port) {
    try { if ((await fetchImpl(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })).ok) return port; }
    catch { /* nobody answers: that browser is gone */ }
  }
  rmSync(portFile(profileDir), { force: true });
  return 0;
}

/**
 * A visible window on its own profile: her logins stay in it, and it is never the person's own browser. Behind other
 * windows it keeps running at full speed. No `--remote-allow-origins`: only this process connects, web pages must not.
 */
export const launchArgs = (profileDir: string) => [
  `--user-data-dir=${profileDir}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--hide-crash-restore-bubble', '--lang=zh-CN', 'about:blank',
];

/** Starts the browser detached (it outlives a plugin reload and is adopted again) and waits for its debugging port; callers adopt a running one via `runningPort` first. */
export async function launchBrowser(binary: string, profileDir: string, timeoutMs = 15_000): Promise<number> {
  mkdirSync(profileDir, { recursive: true });
  rmSync(portFile(profileDir), { force: true });
  let failed: Error | undefined;
  const child = spawn(binary, launchArgs(profileDir), { detached: true, stdio: 'ignore' });
  let exitedAt = 0;
  child.once('error', error => { failed = error; });
  // Edge may hand the window to another process and exit, so an early exit only starts a short grace period.
  child.once('exit', () => { exitedAt = Date.now(); });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (failed) throw new Error(`浏览器没能启动：${failed.message}`);
    if (existsSync(portFile(profileDir))) { const port = readPort(profileDir); if (port) return port; }
    if (exitedAt && Date.now() - exitedAt > 2000) throw new Error('浏览器进程启动后就退出了（同一个配置目录可能已有窗口在运行，或这个浏览器拒绝了启动参数）');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('浏览器启动了，但十五秒内没有打开调试端口');
}
