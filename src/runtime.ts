import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createSystemMessage, createUserMessage, isAgentLoopRequest, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm';
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-compaction';
import './hostContract.ts';
import { Faults } from './faults.ts';
import { createHistory, excludePresentMessages, renderHistory } from './history.ts';
import { createWorldToolRegistry, memoryTools } from './memoryTools.ts';
import { createPromptSections, type WorldPromptSource } from './promptSection.ts';
import { belongsToWorld, createSourceArchive, inWorld, isCorruptSessionLog } from './sourceArchive.ts';
import type { ArchiveStore } from './store.ts';
import type { WorldConfig } from './types.ts';
import { worldNames } from './worldPrompt.ts';
import { reassembleOnChange } from './worldScope.ts';
import { DEFAULT_MEMORY_TURNS } from './worldSwitch.ts';

export type { WorldPromptSource } from './promptSection.ts';
const memorySource = 'dsh-world-history';
const worldSources: readonly string[] = [memorySource];

/**
 * Per session: whether the memory block must be (re)built at the next step and the current loop position.
 */
interface MemoryState { reload: boolean; position: { turn: number; step: number }; inScope: boolean; restart: boolean; pendingId?: string; retiring: SessionSeq[] }

/**
 * The memory line: her conversations are archived as they happen, and every world session gets a memory
 * block of the newest turns at its start and after each successful compaction, never in between, so it stays
 * inside the provider-cached prefix. `home` archives the current home; `workspace` uses host membership. The memory block still
 * goes to every world session in her workspace (`inWorkspace`), independently of the archive scope.
 * `memoryTurns` is read each time a block is built (default 200).
 */
export function createWorldRuntime(ctx: Context, config: WorldConfig, store: ArchiveStore, world?: WorldPromptSource, memoryTurns: () => number = () => DEFAULT_MEMORY_TURNS) {
  if (config.archiveScope === 'workspace' && !world?.archiveSession) throw new Error('Workspace archive requires the host workspace selection');
  const archivedByScope = world?.archiveSession ?? ((sessionId: string) => config.archiveScope !== 'home' || !!world?.isHome(sessionId));
  /** False while some session's workspace was unknown (the host's workspace service was not up yet); `retryCatchUp` reads those later. */
  let undecided = false;
  /** Archiving never fails on unknown membership: the session waits, and what it said is read in order later. */
  const archived = (sessionId: string) => { try { return archivedByScope(sessionId); } catch { undecided = true; return false; } };
  const archive = createSourceArchive(ctx, config, store, archived);
  const history = createHistory(store);
  const names = () => world?.names?.() ?? world?.prompt.names ?? worldNames(config);
  const included = (session: Session) => inWorld(session, config, world?.inWorkspace);
  const faults = new Faults();
  const prompts = world && createPromptSections(config, world, { logger: ctx.logger });
  const memory = new WeakMap<Session, MemoryState>();
  const toolSets = [world?.memory ? (inside: () => boolean) => memoryTools(world.memory!, inside) : undefined].filter(make => !!make);
  const tools = toolSets.length ? createWorldToolRegistry({ tools: inside => toolSets.flatMap(make => make(inside)), inWorld: agent => !stopped && included(agent.session), faults, logger: ctx.logger }) : undefined;
  /** The memory tools follow world membership, whatever the life line does. */
  const syncTools = (agent: Agent): boolean => !tools ? false : included(agent.session) ? tools.attach(agent) : tools.detach(agent);
  const attaching = new WeakMap<Session, Promise<void>>();
  const disposers: (() => void)[] = [];
  let stopping: Promise<void> | undefined;
  let stopped = false;
  /**
   * Whether the session may carry her world: her preset, or a memory block inherited onto its surface (a delegated
   * child of her session). Everything else is never read from disk or tracked. The check stays in memory.
   */
  const mayCarryWorld = (session: Session) => belongsToWorld(session, config) || memory.has(session) || session.surface.nodes.some(seq => {
    const event = session.eventAt(seq);
    return event?.type === 'user/message' && worldSources.includes(event.data.source.kind);
  });

  /** Restore the loop position; recalled blocks are located directly on the current surface. */
  async function readMemoryState(session: Session): Promise<MemoryState> {
    let position = { turn: 1, step: 1 };
    const handle = await ctx.sessionPersistence.open(session.id, 'read');
    try {
      for (let offset = 0; ; offset += 128) {
        const { events } = await handle.read(offset, 128);
        if (!events.length) break;
        for (const event of events) {
          if (event.type === 'step/start') position = { turn: event.data.turn, step: event.data.step };
        }
      }
    } finally { await handle.close(); }
    const inScope = included(session);
    return { reload: true, position, retiring: [], inScope, restart: !inScope && belongsToWorld(session, config) };
  }
  /**
   * Marks our recalled blocks on the surface for retirement. The empty system node that retires one is accepted by
   * the host only inside an open turn and step, which pre-step and attach are not, so `flushRetired` writes it from
   * the step's request hook, after the step has started and before the request is assembled (#22).
   */
  function retireMemory(session: Session, state: MemoryState, kinds: readonly string[] = worldSources): void {
    const found = session.surface.nodes.filter(seq => {
      const event = session.eventAt(seq);
      return event?.type === 'user/message' && kinds.includes(event.data.source.kind);
    });
    state.retiring = [...new Set([...state.retiring, ...found])];
    if (found.length) state.restart = true;
    if (kinds.includes(memorySource)) { state.reload = true; state.pendingId = undefined; }
  }
  /** Where memory blocks sit on a session's surface, for the log: positions and event types only, never message text. */
  function memoryNodesOn(session: Session): string {
    const found: string[] = [];
    for (const seq of session.surface.nodes) {
      const event = session.eventAt(seq);
      if (!event) continue;
      let message: ReturnType<Session['deriveEventMessage']>;
      try { message = session.deriveEventMessage(event); } catch { continue; }
      if (message?.source?.kind && worldSources.includes(message.source.kind)) found.push(`#${seq}(${event.type})`);
    }
    return found.length ? found.slice(0, 8).join('、') + (found.length > 8 ? `…共 ${found.length} 个` : '') : '无';
  }
  /** Empty system nodes retire only our recalled blocks and derive no model message; original logs stay intact. */
  function flushRetired(session: Session, state: MemoryState, position: { turn: number; step: number }): void {
    const retiring = state.retiring; state.retiring = [];
    for (const seq of retiring) {
      if (!session.surface.nodes.includes(seq)) continue;
      session.append('system/message', { ...position, message: createSystemMessage('') }, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] });
    }
  }
  async function attach(agent: Agent): Promise<void> {
    const { session } = agent;
    if (memory.has(session) || !mayCarryWorld(session)) return;
    const pending = attaching.get(session);
    if (pending) return pending;
    const job = faults.track(`memory:${session.id}`, `会话 ${session.id} 记忆初始化失败`, async () => {
      if (included(session)) {
        if (archived(session.id)) await store.commitRecords([], store.progress(session.id));
        await archive.schedule(session.id);
      }
      const state = await readMemoryState(session);
      // Retiring writes a system/message, which the host only accepts inside an open turn and step; attach runs
      // between turns, so an out-of-scope block is retired by the next pre-step (before any request) instead (#22).
      memory.set(session, state);
    });
    attaching.set(session, job);
    try { await job; } finally { attaching.delete(session); }
  }
  /** Retire old blocks, then admit fresh memory through the host's normal append path (#21). */
  async function freshBlock(session: Session, state: MemoryState): Promise<UserMessage | undefined> {
    const turns = await history.loadRecentTurns(config.worldId, memoryTurns(), archivedByScope);
    if (!included(session)) { retireMemory(session, state); return undefined; }
    const present = new Set(session.deriveMessages().map(message => message.id));
    const text = renderHistory(excludePresentMessages(turns, present), config.timeZone, names(), config.archiveScope === 'home');
    retireMemory(session, state, [memorySource]);
    return text ? createUserMessage({ content: [{ type: 'text', text }], source: { kind: memorySource, form: 'recall' } }) : undefined;
  }
  /** Reads what the first catch-up had to leave, once the host can say which sessions belong to her. */
  async function retryCatchUp(): Promise<void> {
    if (!undecided) return;
    undecided = false;
    await archive.catchUp();
  }

  /** `fresh`: her world was just started from the console, so what was said while it was stopped is not archived. */
  async function start(options: { fresh?: boolean } = {}): Promise<void> {
    try {
      disposers.push(ctx.on('session/event', (session, event) => {
        const state = memory.get(session);
        if (state && event.type === 'step/start') state.position = { turn: event.data.turn, step: event.data.step };
        const compacted = event.type === 'compaction/end' && event.data.error === undefined;
        if (state && event.type === 'user/message' && event.data.id === state.pendingId) { state.reload = false; state.pendingId = undefined; }
        if (state && compacted) { state.reload = true; }
        if (compacted) prompts?.refresh(session);
        if (session.header.origin === 'subagent' || (session.header.delegationDepth ?? 0) > 0 || (!config.archiveScope && !belongsToWorld(session, config))) return;
        if (event.type === 'assistant/message' || event.type === 'turn/end' || event.type === 'turn/start' || event.type === 'compaction/end' || (event.type === 'user/message' && event.data.source.kind === 'user')) void archive.schedule(session.id).catch(() => {});
      }));
      disposers.push(ctx.on('agent/created', async ({ agent }) => { prompts?.add(agent); syncTools(agent); await attach(agent); return undefined; }));
      if (tools) {
        disposers.push(reassembleOnChange(ctx, syncTools));
        disposers.push(ctx.on('agent/pre-step', ({ agent }, next) => { syncTools(agent); return next(); }, { prepend: true }));
        disposers.push(ctx.on('agent/disposed', ({ agent }) => tools.forget(agent)));
      }
      // Admitted ahead of the step's new input; the host's own admission order (contexts, time-context last) is kept.
      disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next();
        const { agent, step, signal } = payload;
        // An empty first step ends the turn; any later step runs anyway, so adding to it is safe.
        if (decision.kind !== 'enter' || (step === 1 && !decision.messages.length) || signal.aborted || !mayCarryWorld(agent.session)) return decision;
        await attach(agent);
        const state = memory.get(agent.session)!;
        const leave = () => {
          state.restart ||= state.inScope; state.inScope = false;
          retireMemory(agent.session, state);
          const restart = state.restart; state.restart = false;
          return restart ? { ...decision, startsRequestSeries: true as const } : decision;
        };
        if (!included(agent.session)) return leave();
        state.inScope = true;
        await archive.schedule(agent.id); signal.throwIfAborted();
        if (!included(agent.session)) return leave();
        if (!state.reload) return decision;
        let block: UserMessage | undefined;
        await faults.track(`memory:${agent.id}`, `会话 ${agent.id} 记忆刷新失败`, async () => { block = await freshBlock(agent.session, state); });
        if (!included(agent.session)) return leave();
        signal.throwIfAborted();
        if (!included(agent.session)) return leave();
        if (state.reload && !block) state.reload = false;
        if (!block) return decision;
        state.pendingId = block.id;
        return { ...decision, messages: [block, ...decision.messages] };
      }));
      // The step is open here and its request is not built yet: the one place retired blocks can be written validly.
      disposers.push(ctx.on('agent/request', async function (payload, next) {
        const state = memory.get(payload.agent.session);
        if (state?.retiring.length) flushRetired(payload.agent.session, state, { turn: payload.turn, step: payload.step });
        return next();
      }));
      disposers.push(ctx.on('llm/stream', async function* (request, next) {
        const agent = isAgentLoopRequest(request) && request.sessionId ? ctx.agents.get(request.sessionId) : undefined;
        const owned = agent && included(agent.session);
        const inRequest = agent && !owned ? request.messages.filter(message => !!message.source?.kind && worldSources.includes(message.source.kind)).length : 0;
        const placed = !!agent && !owned && !!prompts?.active(agent.session);
        if (agent && !owned && (placed || inRequest)) {
          const state = memory.get(agent.session);
          if (state) { retireMemory(agent.session, state); flushRetired(agent.session, state, state.position); state.restart = true; }
          const reasons = [inRequest ? `请求里还带着 ${inRequest} 条世界记忆块` : '', placed ? '世界提示还挂在会话上' : ''].filter(Boolean).join('；');
          ctx.logger.warn(`dsh-world: 阻止了会话 ${agent.id}（预设 ${agent.session.header.agentPreset ?? '无'}）的一次请求，它不在世界工作区里。原因：${reasons}。${state ? '已尝试退役记忆块' : '这个会话没有记忆状态，没法退役'}；退役后会话表面上仍有的记忆节点：${memoryNodesOn(agent.session)}。DSH_WORLD_SCOPE_CHANGED`);
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'DSH_WORLD_SCOPE_CHANGED', message: 'dsh-world: 会话已离开世界工作区，已阻止携带世界上下文的请求，请重新发送。' } } } satisfies StreamChunk;
          return;
        }
        for await (const chunk of next()) {
          if (owned && chunk.type === 'finish' && chunk.reason.kind === 'error' && chunk.reason.failure.code === 'CONTEXT_WINDOW_EXCEEDED') yield {
            ...chunk, reason: { ...chunk.reason, failure: { ...chunk.reason.failure, message: `dsh-world: 模型总容量不足，完整近期记忆未被裁剪。${chunk.reason.failure.message}` } },
          } satisfies StreamChunk;
          else yield chunk;
        }
      }));
      await archive.catchUp(options.fresh);
      if (options.fresh) for (const agent of ctx.agents.list()) if (belongsToWorld(agent.session, config)) await archive.skip(agent.id);
      for (const agent of ctx.agents.list()) {
        prompts?.add(agent);
        try { await attach(agent); }
        catch (error) {
          if (!isCorruptSessionLog(error)) throw error;
          ctx.logger.warn(`dsh-world: 会话 ${agent.id} 记忆初始化失败，已隔离：`, error);
        }
      }
    } catch (error) { await stop(); throw error; }
  }
  function stop(): Promise<void> {
    return stopping ??= (async () => {
      stopped = true;
      prompts?.clear(); tools?.clear();
      for (const dispose of disposers.splice(0).reverse()) dispose();
      await archive.flush();
    })();
  }
  return { start, retryCatchUp, refreshPrompt: (session: Session) => { prompts?.refresh(session); }, flush: archive.flush, stop, faults: () => [...faults.list(), ...archive.faults()] };
}
