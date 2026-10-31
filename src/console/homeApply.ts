import { addAbortListener } from 'node:events';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-llm';
import { ManualCompactionError, type CompactionEngine } from '@deepseek-ai/dsh-compaction';
import type { Session } from '@deepseek-ai/dsh-session';
import { errorText } from '../faults.ts';

export interface HomeApplyState {
  status: 'idle' | 'waiting' | 'compacting' | 'done' | 'failed' | 'cancelled';
  sessionId?: string;
  message?: string;
}
interface HomeApplyDeps {
  ctx: Context;
  home(): Promise<Agent>;
  isHome(agent: Agent): boolean;
  compaction(): Pick<CompactionEngine, 'compactNow'> | undefined;
  refresh(session: Session): void;
  changed(): void;
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let listener: ReturnType<typeof addAbortListener>;
  const aborted = new Promise<never>((_, reject) => { listener = addAbortListener(signal, () => reject(signal.reason)); });
  try { return await Promise.race([promise, aborted]); }
  finally { listener![Symbol.dispose](); }
}

/** One explicit request, held behind existing turns and cancelled with the life line. */
export function createHomeApply(deps: HomeApplyDeps) {
  let state: HomeApplyState = { status: 'idle' };
  let controller: AbortController | undefined;
  let pending: Promise<void> | undefined;
  const stopped = new Error('世界已停止');
  function update(next: HomeApplyState): void { state = next; deps.changed(); }
  async function run(engine: Pick<CompactionEngine, 'compactNow'>, operation: AbortController): Promise<void> {
    const { signal } = operation;
    const agent = await abortable(deps.home(), signal);
    const check = () => {
      if (!signal.aborted && !deps.isHome(agent)) operation.abort(new Error('家会话已变化，请重新提交'));
      signal.throwIfAborted();
    };
    for (;;) {
      await abortable(agent.whenIdle(), signal);
      check();
      let entered = false;
      try {
        const result = await engine.compactNow({ session: agent.session, options: agent.options,
          runMaintenance: task => agent.runMaintenance(async agentSignal => {
            entered = true; check();
            update({ status: 'compacting', sessionId: agent.id });
            const dispose = deps.ctx.on('llm/stream', async function* (request, next) {
              if (request.purpose !== 'compaction' || request.sessionId !== agent.id) { yield* next(); return; }
              check();
              for await (const chunk of next()) { check(); yield chunk; }
              // Both stock and tool-free compactNow check this signal before committing their summary.
              check();
            });
            try {
              const result = await task(agentSignal);
              check();
              agentSignal.throwIfAborted();
              // Refresh before maintenance releases queued input, including an empty selection.
              deps.refresh(agent.session);
              return result;
            }
            finally {
              dispose();
            }
          }),
        }, signal);
        update({ status: 'done', sessionId: agent.id, message: result ? '已应用并压缩家会话，下轮使用已保存配置。' : '已应用已保存配置，家会话暂无内容，无需压缩。' });
        return;
      }
      catch (error) {
        // Input can claim the idle phase between whenIdle and compactNow; no summary has started yet.
        if (!entered && error instanceof ManualCompactionError && error.code === 'busy') {
          update({ status: 'waiting', sessionId: agent.id });
          continue;
        }
        throw error;
      }
    }
  }
  /** Fallback when the host does not expose a 'compaction' service to plugin
   * scopes (observed on desktop 0.2.1-rc.3): hot-reload the saved persona and
   * world prompt WITHOUT compacting. A short home session can never produce a
   * "smaller" summary, and the button's purpose is applying config anyway. */
  async function applyWithoutCompaction(signal: AbortSignal): Promise<void> {
    const agent = await deps.home();
    if (signal.aborted) return;
    deps.refresh(agent.session);
    update({ status: 'done', sessionId: agent.id, message: '已应用已保存配置并刷新提示词（宿主未提供压缩服务，未压缩）。' });
  }
  return {
    snapshot: () => state,
    request() {
      if (pending) return;
      const hosted = typeof deps.compaction === 'function' ? deps.compaction() : undefined;
      controller = new AbortController();
      const { signal } = controller;
      update({ status: 'waiting' });
      if (hosted) {
        pending = run(hosted, controller).catch(error => {
          update({ ...state, status: signal.reason === stopped ? 'cancelled' : 'failed', message: signal.reason === stopped ? '已取消应用并压缩家会话。' : `应用并压缩失败：${errorText(signal.aborted ? signal.reason : error)}` });
        }).finally(() => { controller = undefined; pending = undefined; });
      }
      else {
        pending = applyWithoutCompaction(signal).catch(error => {
          update({ ...state, status: signal.reason === stopped ? 'cancelled' : 'failed', message: signal.reason === stopped ? '已取消应用并压缩家会话。' : `应用并压缩失败：${errorText(signal.aborted ? signal.reason : error)}` });
        }).finally(() => { controller = undefined; pending = undefined; });
      }
      return undefined;
    },
    async cancel() { controller?.abort(stopped); await pending; },
  };
}