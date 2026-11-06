import { connect } from 'node:net';
import { startSnowluma, type StartResult } from './snowluma-start.ts';

/**
 * SnowLuma 的看门狗：QQ 通道开着，就每隔一段时间探一次 OneBot 的端口，不通且没有实例时才拉起。
 * 拉不起来只把原因记在面板上；探活重叠时跳过这一轮，不叠着打。
 */
export interface SnowlumaStatus {
  watching: boolean;
  /** 上一次探测时端口通不通。 */
  alive: boolean;
  lastCheckAt: string | null;
  /** 看门狗拉起来的次数。 */
  restarts: number;
  lastRestartAt: string | null;
  lastError: string | null;
}

/** 连得上就算活，其余（超时、拒绝）都算不通。 */
function probePort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host, port });
    const finish = (alive: boolean) => { socket.destroy(); resolve(alive); };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export function createSnowlumaSupervisor(options: {
  /** SnowLuma 的家目录；空字符串表示不知道。 */
  homeDir: string; host: string; port: number;
  intervalMs?: number; probeTimeoutMs?: number;
  /** 测试替身。 */
  probe?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  launch?: () => StartResult;
  log(message: string): void;
}) {
  const probe = options.probe ?? probePort;
  const launch = options.launch ?? (() => startSnowluma(options.homeDir));
  const state: SnowlumaStatus = { watching: false, alive: false, lastCheckAt: null, restarts: 0, lastRestartAt: null, lastError: null };
  let timer: ReturnType<typeof setInterval> | undefined;
  let busy = false;

  async function tick(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      state.alive = await probe(options.host, options.port, options.probeTimeoutMs ?? 3_000);
      if (!state.watching) return;
      state.lastCheckAt = new Date().toISOString();
      if (state.alive) { state.lastError = null; return; }
      if (!options.homeDir) { state.lastError = '没配 qqNative.snowlumaHome，不知道 SnowLuma 装在哪'; return; }
      const result = launch();
      state.lastError = result.error ?? (result.alreadyRunning ? 'SnowLuma 已在运行或启动中，等待 OneBot 端口就绪' : result.started ? null : '拉不起来，原因不明');
      if (result.started) { state.restarts += 1; state.lastRestartAt = new Date().toISOString(); }
      options.log(`看门狗：${options.port} 不通，${result.started ? `已拉起 SnowLuma（${result.how}）` : result.alreadyRunning ? '不重复拉起' : 'SnowLuma 没起来'}${state.lastError ? `：${state.lastError}` : ''}`);
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
    } finally { busy = false; }
  }

  return {
    start(): void {
      if (timer) return;
      state.watching = true;
      timer = setInterval(() => { void tick(); }, options.intervalMs ?? 30_000);
      timer.unref?.();
      void tick();
    },
    stop(): void {
      state.watching = false;
      if (timer) { clearInterval(timer); timer = undefined; }
    },
    status: (): SnowlumaStatus => ({ ...state }),
  };
}

export type SnowlumaSupervisor = ReturnType<typeof createSnowlumaSupervisor>;
