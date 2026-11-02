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
  /** The engine her home actually compacts with; on the Web host it sits inside the session's preset, not on the host. */
  compaction(agent: Agent): Pick<CompactionEngine, 'compactNow'> | undefined;
  refresh(session: Session): void;
  changed(): void;
  /** The console health entry for a failed request; undefined clears it. */
  fault(message: string | undefined): void;
}
/** The Web host's preset registry; `serviceFor` reads a service from a session's isolated preset group (0.2.1-rc.2 on). */
interface AgentPresets { serviceFor?(agent: Agent, name: string): unknown }
/**
 * DSH's Web host composes compaction inside each session's preset, an isolated realm the host plane cannot see; the
 * host-plane service is what the TUI, or a profile that inserts one at the top level, provides.
 */
export function compactionFor(ctx: Pick<Context, 'get'>, agent: Agent): Pick<CompactionEngine, 'compactNow'> | undefined {
  const preset = (ctx.get('agentPresets') as AgentPresets | undefined)?.serviceFor?.(agent, 'compaction') as CompactionEngine | undefined;
  return preset ?? ctx.get('compaction') as CompactionEngine | undefined;
}
const unavailable = '未加载压缩服务：家会话所用的预设里和宿主上都没有压缩插件';
/** The manual compaction error says only which stage failed; what actually went wrong is in its cause. */
function failureText(error: unknown): string {
  const parts: string[] = [];
  for (let current = error; current !== undefined && parts.length < 4; current = current instanceof Error ? current.cause : undefined) parts.push(errorText(current));
  return parts.join('：');
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
  function update(next: HomeApplyState): void {
    state = next; deps.changed();
    // The state only lives in memory, and the nightly request after the review has no one watching it.
    if (next.status === 'failed') { deps.ctx.logger.warn(`dsh-world: ${next.message ?? ''}`); deps.fault(next.message); }
    else if (next.status === 'done') { deps.ctx.logger.info(`dsh-world: ${next.message ?? ''}`); deps.fault(undefined); }
  }
  async function run(operation: AbortController): Promise<void> {
    const { signal } = operation;
    const agent = await abortable(deps.home(), signal);
    const engine = deps.compaction(agent);
    if (!engine) throw new Error(unavailable);
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
              check(); agentSignal.throwIfAborted();
              // Refresh before maintenance releases queued input, including an empty selection.
              deps.refresh(agent.session);
              return result;
            } finally { dispose(); }
          }),
        }, signal);
        update({ status: 'done', sessionId: agent.id, message: result ? '已应用并压缩家会话，下轮使用已保存配置。' : '已应用已保存配置，家会话暂无内容，无需压缩。' });
        return;
      } catch (error) {
        // Input can claim the idle phase between whenIdle and compactNow; no summary has started yet.
        if (!entered && error instanceof ManualCompactionError && error.code === 'busy') { update({ status: 'waiting', sessionId: agent.id }); continue; }
        throw error;
      }
    }
  }
  return {
    snapshot: () => state,
    /** Failures, including a missing engine, arrive later as the `failed` state. */
    request(): undefined {
      if (pending) return;
      controller = new AbortController();
      const { signal } = controller;
      update({ status: 'waiting' });
      pending = run(controller).catch(error => {
        update({ ...state, status: signal.reason === stopped ? 'cancelled' : 'failed', message: signal.reason === stopped ? '已取消应用并压缩家会话。' : `应用并压缩失败：${failureText(signal.aborted ? signal.reason : error)}` });
      }).finally(() => { controller = undefined; pending = undefined; });
      return undefined;
    },
    async cancel(): Promise<void> { controller?.abort(stopped); await pending; },
  };
}
