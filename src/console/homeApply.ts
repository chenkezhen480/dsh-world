import { addAbortListener } from 'node:events';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-llm';
import { ManualCompactionError, type CompactionEngine } from '@deepseek-ai/dsh-compaction';
import type { Session } from '@deepseek-ai/dsh-session';
import { ToolFreeCompaction } from '../compaction.ts';
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
  timeZone?: string;
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
  let fallbackEngine: Pick<CompactionEngine, 'compactNow'> | undefined;
  // Fallback: when the host does not expose a 'compaction' service to plugin
  // contexts (observed on desktop 0.2.1-rc.3), build dsh-world's own tool-free
  // engine so 「应用并压缩家会话」 keeps working.
  // The engine needs llm/tokenMeter/sessions; manually constructed cordis
  // plugins get no inject, so walk up to the outermost ctx where those
  // services resolve without the inject guard.
  function serviceCtx(): Context {
    let ctx = deps.ctx;
    for (let depth = 0; depth < 8; depth++) {
      try {
        void ctx.llm;
        void ctx.tokenMeter;
        void ctx.sessions;
        return ctx;
      } catch {
        const parent = ctx.parent;
        if (!parent || parent === ctx) return ctx;
        ctx = parent;
      }
    }
    return ctx;
  }
  function resolveEngine(): Pick<CompactionEngine, 'compactNow'> {
    const hosted = deps.compaction();
    if (hosted) return hosted;
    fallbackEngine ??= new ToolFreeCompaction(serviceCtx(), {
      timeZone: deps.timeZone ?? 'Asia/Shanghai',
      auto: true,
      thresholdRatio: 0.8,
      headroomTokens: 65536,
      summarizationProvider: '',
      summarizationModel: '',
      maxTokens: 65536,
      modelPolicies: [],
    });
    return fallbackEngine;
  }
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
    request(): string | undefined {
      if (pending) return;
      const engine = resolveEngine();
      if (!engine) return '未加载压缩服务，请先启用 DSH 压缩插件';
      controller = new AbortController();
      const { signal } = controller;
      update({ status: 'waiting' });
      pending = run(engine, controller).catch(error => {
        update({ ...state, status: signal.reason === stopped ? 'cancelled' : 'failed', message: signal.reason === stopped ? '已取消应用并压缩家会话。' : `应用并压缩失败：${errorText(signal.aborted ? signal.reason : error)}` });
      }).finally(() => { controller = undefined; pending = undefined; });
      return undefined;
    },
    async cancel(): Promise<void> { controller?.abort(stopped); await pending; },
  };
}
