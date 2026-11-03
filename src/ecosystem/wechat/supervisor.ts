import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, statSync, truncateSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The adapter script ships next to the sources; this resolves from both `src/` and the built `lib/`. */
export const ADAPTER_SCRIPT = fileURLToPath(new URL('../../../src/ecosystem/wechat/windows/adapter.py', import.meta.url));
/** The native bridge's build script, beside the bridge source the adapter checks its build against. */
export const BUILD_SCRIPT = fileURLToPath(new URL('../../../src/ecosystem/wechat/windows/engine/build.ps1', import.meta.url));
/** The adapter exits with this when a person must check WeChat and run `acknowledge`; restarting cannot help. */
export const EXIT_NEEDS_HUMAN = 2;
/** The adapter exits with this when no build of the native bridge matches its source (an upgrade changed it). */
export const EXIT_NEEDS_BUILD = 3;
const MAX_LOG_BYTES = 1024 * 1024;
const HEALTHY_MS = 60_000;
const BUILD_BY_HAND = '请在仓库里运行 wechat.ps1 Build，再在控制台重启适配器';

export interface AdapterStatus { running: boolean; pid: number | null; restarts: number; lastExit: string | null; error: string | null; needsHuman: boolean; building: boolean }
export interface AdapterSupervisorDeps {
  python: string; config: string; logFile: string; script?: string; buildScript?: string;
  /** Delay before the first restart and the cap it doubles up to. */
  minDelayMs?: number; maxDelayMs?: number;
  spawnProcess?: typeof spawn; killTree?(child: ChildProcess): void;
  log(message: string): void;
}

/** The last line the adapter wrote to its log after byte `from`: what it said as it stopped. */
function lastLine(file: string, from: number): string | undefined {
  try {
    const size = statSync(file).size, length = Math.min(size - from, 4096);
    if (length <= 0) return undefined;
    const buffer = Buffer.alloc(length), fd = openSync(file, 'r');
    try { readSync(fd, buffer, 0, length, size - length); } finally { closeSync(fd); }
    return buffer.toString('utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1);
  } catch { return undefined; }
}

/**
 * Runs the Windows WeChat adapter for as long as the world's WeChat module lives: started with the module,
 * restarted with a growing delay when it exits or cannot start (a file missing during an upgrade comes back),
 * and stopped (its whole process tree) with the module. An exit that says a person must act is not retried. An exit
 * that says the native bridge needs building is answered by building it once into the `engine` folder beside the
 * adapter's config (where the adapter looks) and starting it again; a build that fails, or still does not match,
 * stops with what to do. The adapter itself waits for the same WeChat account to log in again, so a WeChat
 * restart needs nothing from here.
 */
export function createAdapterSupervisor(deps: AdapterSupervisorDeps) {
  const script = deps.script ?? ADAPTER_SCRIPT, buildScript = deps.buildScript ?? BUILD_SCRIPT;
  const spawnProcess = deps.spawnProcess ?? spawn;
  const minDelay = deps.minDelayMs ?? 1000, maxDelay = deps.maxDelayMs ?? 30_000;
  let child: ChildProcess | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false, replacing = false, needsHuman = false, started = false, failures = 0, restarts = 0;
  /** `rebuilt`: the last start came right after a build, so needing one again means building cannot help. */
  let building = false, rebuilt = false;
  let lastExit: string | null = null, error: string | null = null;
  let exited: Promise<void> = Promise.resolve();

  const killTree = deps.killTree ?? ((target: ChildProcess) => {
    // The Windows venv launcher starts a child interpreter; killing only the launcher would leave it running.
    if (process.platform === 'win32' && target.pid) spawn('taskkill', ['/PID', String(target.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else target.kill();
  });

  function fail(message: string): void {
    error = message;
    deps.log(`dsh-world WeChat adapter not started: ${message}`);
    schedule();
  }
  /** Not retried: only a person can fix it, and the console's restart tries again. */
  function halted(message: string): void {
    error = message;
    deps.log(`dsh-world WeChat adapter stopped: ${message}`);
  }
  function rebuild(): void {
    if (rebuilt) return halted(`原生桥刚重新构建过，仍然对不上它的源码；${BUILD_BY_HAND}`);
    let fd: number;
    try { fd = openSync(deps.logFile, 'a'); } catch (cause) { return halted(`原生桥需要重新构建，但写不了适配器日志：${String(cause)}`); }
    let builder: ChildProcess;
    try { builder = spawnProcess('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', buildScript, '-OutDir', join(dirname(deps.config), 'engine')], { stdio: ['ignore', fd, fd], windowsHide: true }); }
    catch (cause) { return halted(`原生桥需要重新构建，自动构建没能启动：${String(cause)}；${BUILD_BY_HAND}`); }
    finally { closeSync(fd); }
    building = true;
    deps.log('dsh-world WeChat adapter: the native bridge no longer matches its source; building it again');
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true; building = false;
      // Stopped meanwhile, or started again by the module, which already launched it.
      if (stopped || child) return;
      if (!ok) return halted(`原生桥需要重新构建，自动构建没成功（详情在 wechat-adapter.log）；${BUILD_BY_HAND}`);
      rebuilt = true;
      launch();
    };
    builder.once('exit', code => finish(code === 0));
    builder.once('error', () => finish(false));
  }
  function launch(): void {
    if (stopped) return;
    for (const [what, path] of [['Python', deps.python], ['适配器配置', deps.config], ['适配器脚本', script]] as const) {
      if (!existsSync(path)) return fail(`${what}不存在：${path}`);
    }
    let fd: number, logFrom: number;
    try {
      if (existsSync(deps.logFile) && statSync(deps.logFile).size > MAX_LOG_BYTES) truncateSync(deps.logFile, 0);
      fd = openSync(deps.logFile, 'a');
      logFrom = statSync(deps.logFile).size;
    } catch (cause) { return fail(`无法写适配器日志：${String(cause)}`); }
    const startedAt = Date.now();
    let current: ChildProcess;
    try { current = spawnProcess(deps.python, ['-X', 'utf8', '-u', script, 'watch', '--config', deps.config, '--allow-send'], { cwd: dirname(script), stdio: ['ignore', fd, fd], windowsHide: true }); }
    catch (cause) { return fail(`适配器启动失败：${String(cause)}`); }
    finally { closeSync(fd); } // the child owns its copy of the descriptor
    error = null;
    if (started) restarts++;
    started = true;
    child = current;
    exited = new Promise<void>(resolve => {
      let done = false;
      const finish = (text: string, code: number | null) => {
        if (done) return;
        done = true;
        if (child === current) child = undefined;
        const said = lastLine(deps.logFile, logFrom);
        lastExit = said ? `${text}：${said}` : text;
        if (Date.now() - startedAt > HEALTHY_MS) failures = 0;
        if (code !== EXIT_NEEDS_BUILD) rebuilt = false;
        if (!stopped && !replacing) {
          if (code === EXIT_NEEDS_HUMAN) { needsHuman = true; deps.log('dsh-world WeChat adapter stopped: a message needs checking by a person (run acknowledge, then restart it from the console)'); }
          else if (code === EXIT_NEEDS_BUILD) rebuild();
          else { deps.log(`dsh-world WeChat adapter exited (${text}); restarting`); schedule(); }
        }
        resolve();
      };
      current.once('exit', (code, signal) => finish(signal ? `signal ${signal}` : `code ${code}`, signal ? null : code));
      current.once('error', cause => finish(`error ${String(cause)}`, null));
    });
  }
  function schedule(): void {
    if (stopped) return;
    const delay = Math.min(maxDelay, minDelay * 2 ** failures++);
    timer = setTimeout(() => { timer = undefined; launch(); }, delay);
    timer.unref?.();
  }
  async function halt(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = undefined; }
    const running = child;
    if (!running) return;
    killTree(running);
    await Promise.race([exited, new Promise<void>(resolve => { setTimeout(resolve, 5000).unref?.(); })]);
  }
  return {
    start(): void { stopped = false; launch(); },
    /** The console's restart: also the way out of "a person must check" once the person has. */
    async restart(): Promise<void> {
      // A build under way starts the adapter itself when it is done.
      if (stopped || building) return;
      replacing = true;
      try { await halt(); } finally { replacing = false; }
      needsHuman = false; failures = 0; rebuilt = false;
      launch();
    },
    async stop(): Promise<void> {
      stopped = true;
      await halt();
    },
    status(): AdapterStatus { return { running: child !== undefined, pid: child?.pid ?? null, restarts, lastExit, error, needsHuman, building }; },
  };
}
export type AdapterSupervisor = ReturnType<typeof createAdapterSupervisor>;
