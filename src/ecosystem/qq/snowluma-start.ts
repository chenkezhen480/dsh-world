import { spawn, spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 把 SnowLuma 拉起来一次（面板上的按钮和看门狗共用）。
 *
 * 优先借本机的 `SnowLuma-watchdog` 计划任务跑：DSH 把子进程放进一个关句柄即杀的 job，从 DSH 里 spawn
 * 出来的 SnowLuma 会跟着 DSH 一起退出；计划任务跑在 job 之外，能活过 DSH 重启。没有任务（或任务被禁用）
 * 才退回直接 spawn，并如实说明这条线只活到 DSH 退出。
 */
const TASK = 'SnowLuma-watchdog';
const START_WAIT_MS = 90_000;
const pendingStarts = new Map<string, { until: number; error?: string }>();

export interface StartResult {
  started: boolean;
  alreadyRunning?: boolean;
  /** `task` = 借计划任务跑的（能活过 DSH 退出）；`spawn` = 直接起的（DSH 一退出就没了）。 */
  how?: 'task' | 'spawn';
  error?: string;
}

/** SnowLuma 的入口：完整版自带 node.exe，Lite 版用本机 node 跑 index.mjs，再不然是 launcher.bat。 */
function entry(homeDir: string): { exe: string; args: string[] } | undefined {
  const index = join(homeDir, 'index.mjs');
  if (existsSync(index)) return { exe: existsSync(join(homeDir, 'node.exe')) ? join(homeDir, 'node.exe') : 'node', args: [index] };
  const launcher = join(homeDir, 'launcher.bat');
  return existsSync(launcher) ? { exe: launcher, args: [] } : undefined;
}

const schtasks = (...args: string[]) => process.platform === 'win32' && spawnSync('schtasks', args, { windowsHide: true, stdio: 'ignore' }).status === 0;

/** 按安装目录认已有实例，包括 DSH 重启前或用户手动启动的那份。 */
function isRunning(homeDir: string): boolean {
  const script = String.raw`$ErrorActionPreference = 'Stop'
$homeDir = $env:DSH_WORLD_SNOWLUMA_HOME.TrimEnd('\') + '\'
Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'cmd.exe'" | Where-Object {
  ([string]$_.ExecutablePath).StartsWith($homeDir, [StringComparison]::OrdinalIgnoreCase) -or
  ([string]$_.CommandLine).Replace('/', '\').IndexOf($homeDir, [StringComparison]::OrdinalIgnoreCase) -ge 0
} | Select-Object -First 1 -ExpandProperty ProcessId`;
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      env: { ...process.env, DSH_WORLD_SNOWLUMA_HOME: homeDir }, encoding: 'utf8', windowsHide: true, timeout: 5000,
    })
    : spawnSync('ps', ['-ww', '-axo', 'args='], { encoding: 'utf8', timeout: 5000, ...(process.platform === 'linux' ? { env: { ...process.env, LC_ALL: 'C.UTF-8' } } : {}) });
  if (result.error || result.status !== 0) throw new Error(`无法确认 SnowLuma 是否已在运行，未重复启动：${result.error?.message ?? result.stderr?.trim() ?? result.status}`);
  return process.platform === 'win32' ? !!result.stdout.trim() : result.stdout.split(/\r?\n/).some(line => line.includes(`${homeDir}/`));
}

export function startSnowluma(homeDir: string): StartResult {
  if (!homeDir || !existsSync(homeDir)) return { started: false, error: '不知道 SnowLuma 装在哪（填 qqNative.snowlumaHome）' };
  try {
    homeDir = realpathSync(homeDir);
    const key = process.platform === 'win32' ? homeDir.toLowerCase() : homeDir;
    const pending = pendingStarts.get(key);
    if (pending && Date.now() < pending.until) return pending.error ? { started: false, error: pending.error } : { started: false, alreadyRunning: true };
    pendingStarts.delete(key);
    // shortcut: 仍在运行但端口不通时只报告，不杀外部实例；需要自动恢复卡死时再加受控重启。
    if (isRunning(homeDir)) return { started: false, alreadyRunning: true };
    const hasTask = schtasks('/query', '/tn', TASK);
    const attempt: { until: number; error?: string } = { until: Date.now() + START_WAIT_MS };
    if (hasTask && schtasks('/run', '/tn', TASK)) {
      pendingStarts.set(key, attempt);
      return { started: true, how: 'task' };
    }
    const target = entry(homeDir);
    if (!target) return { started: false, error: '这个目录里没有 node.exe / index.mjs / launcher.bat' };
    spawn(target.exe, target.args, { cwd: homeDir, detached: true, stdio: 'ignore', windowsHide: true })
      .once('error', error => { attempt.error = error.message; }).unref();
    pendingStarts.set(key, attempt);
    return { started: true, how: 'spawn', ...(hasTask ? { error: '计划任务没跑起来（可能被禁用了），改为直接起；这条线只活到 DSH 退出' } : {}) };
  } catch (error) {
    return { started: false, error: error instanceof Error ? error.message : String(error) };
  }
}
