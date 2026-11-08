// src/ecosystem/computer/browser/browser.ts
import { errorText, type Faults } from '../../../faults.ts';
import { createChannelQueue } from '../../shared/turn.ts';
import { closeTarget, connectCdp, newTarget, pageTargets, type Cdp, type Target } from './cdp.ts';
import { findBrowser, launchBrowser, runningPort } from './edge.ts';
import { createPage, type Page } from './page.ts';

export interface BrowserStatus { state: 'missing' | 'stopped' | 'running'; binary: string | null }
export type Browser = ReturnType<typeof createBrowser>;

/**
 * Her one browser: adopted when it already runs on her profile, started otherwise, reconnected after it was closed.
 * Every operation — her page tools, her own tools, the runs before her alarm — goes through one queue, so two of
 * them never act on the same page at once. A timeout or a stop aborts the running work and drops its connection, so
 * it cannot keep acting while the next operation takes over. Stopping drops the connection only: the window and her pages stay.
 */
export function createBrowser(deps: {
  profileDir: string; faults: Faults; timeoutMs?: number;
  find?: () => string | undefined; running?: (profileDir: string) => Promise<number>; launch?: (binary: string, profileDir: string) => Promise<number>;
  targets?: (port: number) => Promise<Target[]>; open?: (port: number) => Promise<Target>; close?: (port: number, id: string) => Promise<void>; connect?: (url: string) => Promise<Cdp>;
}) {
  const find = deps.find ?? (() => findBrowser()), running = deps.running ?? runningPort, launch = deps.launch ?? launchBrowser;
  const targets = deps.targets ?? pageTargets, open = deps.open ?? (port => newTarget(port)), close = deps.close ?? closeTarget, connect = deps.connect ?? (url => connectCdp(url));
  const queue = createChannelQueue('浏览器', { limit: 8, timeoutMs: deps.timeoutMs ?? 120_000, timeoutMessage: '浏览器操作超时（两分钟）；如果这一步会向外发出，可能已经发出，先看页面再决定' });
  let main: { cdp: Cdp; page: Page } | undefined;
  /** Bumped on every stop and cancellation, so a connection that finishes late knows it is no longer wanted. */
  let generation = 0;

  async function port(): Promise<number> {
    const adopted = await running(deps.profileDir);
    if (adopted) return adopted;
    const binary = find();
    if (!binary) throw new Error('这台电脑上找不到 Edge 或 Chrome');
    return await launch(binary, deps.profileDir);
  }
  /** Failures to reach the browser itself are faults; a page that refuses a click is not. */
  async function reach<T>(work: () => Promise<T>): Promise<T> {
    try { const value = await work(); deps.faults.clear('computer'); return value; }
    catch (error) { deps.faults.set('computer', `她的浏览器没能打开：${errorText(error)}`); throw error; }
  }
  function dropMain(): void { main?.cdp.close(); main = undefined; }
  /** Runs `job` in the queue with a signal that aborts when the queue cancels it (timeout or stop). */
  function inQueue<T>(job: (signal: AbortSignal) => Promise<T>, onCancel: () => void): Promise<T> {
    return queue.run(cancelled => {
      const controller = new AbortController();
      cancelled.catch(() => { generation++; controller.abort(); onCancel(); });
      return Promise.race([job(controller.signal), cancelled]);
    });
  }
  async function mainPage(): Promise<Page> {
    if (main && !main.cdp.closed) return main.page;
    const mine = generation;
    const cdp = await reach(async () => {
      const at = await port();
      const target = (await targets(at))[0] ?? await open(at);
      return await connect(target.webSocketDebuggerUrl);
    });
    if (mine !== generation || queue.stopped) { cdp.close(); throw new Error('浏览器操作已取消'); }
    main = { cdp, page: createPage(cdp) };
    return main.page;
  }
  /** One operation on her main tab. */
  function run<T>(work: (page: Page, signal: AbortSignal) => Promise<T>): Promise<T> {
    return inQueue(async signal => work(await mainPage(), signal), dropMain);
  }
  return {
    run,
    /** Work in a tab of its own, closed afterwards, so the page she is on stays as it was. */
    scratch<T>(work: (page: Page, signal: AbortSignal) => Promise<T>, caller?: AbortSignal): Promise<T> {
      let cdp: Cdp | undefined;
      return inQueue(async signal => {
        // The caller may have given up while this waited in the queue; then it must not open a tab nobody reads.
        caller?.throwIfAborted();
        const at = await reach(port);
        caller?.throwIfAborted();
        const target = await reach(() => open(at));
        try {
          signal.throwIfAborted();
          cdp = await reach(() => connect(target.webSocketDebuggerUrl));
          signal.throwIfAborted();
          return await work(createPage(cdp), signal);
        } finally { cdp?.close(); await close(at, target.id); }
      }, () => cdp?.close());
    },
    /** Brings her window forward, for her partner to scan a login code or watch. */
    show(): Promise<void> { return run(page => page.bringToFront()); },
    status(): BrowserStatus {
      const binary = find() ?? null;
      return { state: !binary ? 'missing' : main && !main.cdp.closed ? 'running' : 'stopped', binary };
    },
    stop(): void { generation++; queue.stop(); dropMain(); },
  };
}
