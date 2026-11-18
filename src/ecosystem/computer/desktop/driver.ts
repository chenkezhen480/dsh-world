// src/ecosystem/computer/desktop/driver.ts
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { errorText, type Faults } from '../../../faults.ts';

export type DesktopDriver = ReturnType<typeof createDesktopDriver>;

/** A call that hangs this long has an unknown outcome; the helper is killed rather than trusted again. */
const CALL_MS = 30_000;
/** How long the partner has to answer the UAC prompt that starts foreground mode's helper. */
const ELEVATE_MS = 120_000;
/** Starts that end before any reply, in a row, after which it stays down until the switch is turned off and on. */
const MAX_FAILED_STARTS = 2;
// Shipped as source (package.json `files`), so the same path holds from `src/` and from the built `lib/`.
export const HELPER_SCRIPT = fileURLToPath(new URL('../../../../src/ecosystem/computer/desktop/win32.ps1', import.meta.url));
const POWERSHELL = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER_SCRIPT];
/** Words the elevated helper's launcher says when the partner declines the UAC prompt (English and Chinese Windows). */
const DECLINED = /canceled by the user|cancelled by the user|已被用户取消|操作已取消/i;

interface Pending { resolve(data: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
/** One running helper as the driver sees it: lines go in, lines come out, and it says once when it is gone. */
interface Link { write(line: string): void; end(): void }

/**
 * The Windows helper (`win32.ps1`) in a child process, started on first use and ended with the module. A crash or a
 * hung call fails what is pending, is a fault, and the next call starts it again; starts that keep dying stop there,
 * so a broken machine is said once instead of relaunched on every step. Her inbox runs a helper of its own (`as`), so
 * a slow step of hers and a look at the notifications never wait on each other.
 *
 * `elevated` is foreground mode's helper: started as administrator, so the partner approves it once through UAC. A UAC
 * prompt cannot share stdin and stdout, so it dials back to a pipe opened here and proves itself with a one-time key.
 * It is never restarted behind the partner's back: once it is gone, foreground mode is over until it is turned on again.
 */
export function createDesktopDriver(deps: { faults: Faults; command?: string[]; callMs?: number; as?: { fault: string; name: string; stopped: string }; events?(name: string): void; elevated?: boolean; elevateMs?: number }) {
  const [program, ...programArgs] = deps.command ?? POWERSHELL, callMs = deps.callMs ?? CALL_MS;
  const { fault: FAULT, name, stopped } = deps.as ?? (deps.elevated
    ? { fault: 'computer-foreground', name: '前台模式的助手', stopped: '前台模式关掉了' }
    : { fault: 'computer-desktop', name: '她用电脑的助手', stopped: '她用电脑的开关关掉了' });
  const pending = new Map<number, Pending>();
  let link: Link | undefined, starting: Promise<Link> | undefined, nextId = 1, failedStarts = 0, answered = false, halted: string | undefined;

  function failAll(why: string): void {
    for (const [id, entry] of pending) { clearTimeout(entry.timer); entry.reject(new Error(why)); pending.delete(id); }
  }
  function lost(gone: Link, why: string): void {
    if (link !== gone) return;
    link = undefined;
    if (deps.elevated) halted = `${name}退出了：${why}。要再用前台模式，请伙伴把它关掉再打开（会再确认一次管理员权限）`;
    else if (!answered && ++failedStarts >= MAX_FAILED_STARTS) halted = `${name}起不来：${why}`;
    deps.faults.set(FAULT, halted ?? `${name}退出了：${why}，下一次用时重新启动`);
    failAll(`${name}退出了：${why}`);
  }
  function settle(line: string): void {
    let message: { id?: number; data?: Record<string, unknown>; error?: string; event?: string };
    try { message = JSON.parse(line) as typeof message; } catch { return; }
    // Not an answer: something the helper saw happen, such as the partner stopping her.
    if (typeof message.event === 'string') { deps.events?.(message.event); return; }
    const entry = message.id === undefined ? undefined : pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id!); clearTimeout(entry.timer);
    answered = true; failedStarts = 0; deps.faults.clear(FAULT);
    if (message.error !== undefined) entry.reject(new Error(message.error)); else entry.resolve(message.data ?? {});
  }

  function startChild(): Link {
    answered = false;
    const started: ChildProcess = spawn(program!, programArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    const made: Link = { write: line => started.stdin!.write(line), end: () => { started.stdin?.end(); started.kill(); } };
    started.stderr!.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-500); });
    createInterface({ input: started.stdout! }).on('line', settle);
    started.stdin!.on('error', () => { /* the exit handler says why it went away */ });
    started.on('error', error => lost(made, errorText(error)));
    started.on('exit', (code, signal) => lost(made, stderr.trim().split('\n').at(-1)?.trim() || `退出码 ${code ?? signal}`));
    return made;
  }
  /** Opens a pipe only this run knows, starts the helper through UAC, and takes the first connection that says the key. */
  function startElevated(): Promise<Link> {
    answered = false;
    const pipe = `dsh-world-${randomBytes(16).toString('hex')}`, key = randomBytes(24).toString('hex');
    const elevateMs = deps.elevateMs ?? ELEVATE_MS;
    return new Promise<Link>((resolve, reject) => {
      let settled = false;
      const server: Server = createServer((socket: Socket) => {
        if (settled) { socket.destroy(); return; }
        let proven = false;
        createInterface({ input: socket }).on('line', line => {
          if (proven) { settle(line); return; }
          let hello: unknown;
          try { hello = (JSON.parse(line) as { hello?: unknown }).hello; } catch { /* not the helper */ }
          // Anything else that found the pipe is not the helper this run started.
          if (hello !== key || settled) { socket.destroy(); return; }
          proven = true; settled = true; clearTimeout(timer); server.close();
          const made: Link = { write: text => socket.write(text), end: () => socket.destroy() };
          socket.on('close', () => lost(made, '和 DSH 的连接断了'));
          socket.on('error', () => { /* close follows */ });
          resolve(made);
        });
      });
      const fail = (why: string) => { if (settled) return; settled = true; clearTimeout(timer); server.close(); reject(new Error(why)); };
      const timer = setTimeout(() => fail(`${Math.round(elevateMs / 1000)} 秒内没有确认管理员权限`), elevateMs);
      server.on('error', error => fail(errorText(error)));
      server.listen(`\\\\.\\pipe\\${pipe}`, () => {
        // The launcher only asks Windows to start the helper as administrator; the helper itself dials the pipe.
        const quoted = (text: string) => `'${text.replace(/'/g, "''")}'`;
        const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `"${HELPER_SCRIPT}"`, '-Pipe', pipe, '-Key', key];
        const launcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList ${args.map(quoted).join(',')}`], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        let said = '';
        launcher.stderr!.on('data', (chunk: Buffer) => { said += chunk.toString('utf8'); });
        launcher.on('error', error => fail(errorText(error)));
        launcher.on('exit', code => { if (code) fail(DECLINED.test(said) ? '伙伴没有同意管理员权限' : said.trim().split('\n').find(Boolean)?.trim() || `启动失败（退出码 ${code}）`); });
      });
    });
  }
  function send(target: Link, op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`助手 ${callMs / 1000} 秒没有回应，结果不明：先 desktop shot 看看现在的样子`));
        if (link === target) { target.end(); lost(target, '一次调用卡住了'); }
      }, callMs);
      pending.set(id, { resolve, reject, timer });
      target.write(`${JSON.stringify({ id, op, args })}\n`);
    });
  }
  function ready(): Promise<Link> {
    if (halted) return Promise.reject(new Error(halted));
    if (link) return Promise.resolve(link);
    if (!deps.elevated) return Promise.resolve(link = startChild());
    return starting ??= startElevated().then(made => { link = made; deps.faults.clear(FAULT); return made; }, (error: unknown) => {
      halted = `前台模式没有打开：${errorText(error)}`;
      deps.faults.set(FAULT, halted);
      throw new Error(halted);
    }).finally(() => { starting = undefined; });
  }

  return {
    /** One helper operation by name, e.g. `windows` or `click`; a refusal rejects with the helper's reason. */
    call(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      // A helper already up takes the call at once, so stopping right after a call still fails it.
      if (!link && !deps.elevated && !halted) link = startChild();
      return link ? send(link, op, args) : ready().then(target => send(target, op, args));
    },
    /** Starts it now rather than on first use: foreground mode asks for administrator rights when it is turned on. */
    start: async (): Promise<void> => { await ready(); },
    running: () => link !== undefined,
    /** Ends the helper and forgets a halted start, so turning the switch on again tries afresh. */
    stop(): void {
      const ending = link;
      link = undefined; halted = undefined; failedStarts = 0;
      failAll(stopped);
      ending?.end();
      deps.faults.clear(FAULT);
    },
  };
}
