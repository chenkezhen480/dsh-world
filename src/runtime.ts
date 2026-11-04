import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createSystemMessage, createUserMessage, isAgentLoopRequest, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm';
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-compaction';
import './hostContract.ts';
import { isOrdinarySession } from './archive.ts';
import { Faults } from './faults.ts';
import { createHistory, excludePresentMessages, renderHistory } from './history.ts';
import { createWorldToolRegistry, memoryTools } from './memoryTools.ts';
import { createPromptSections, type WorldPromptSource } from './promptSection.ts';
import { belongsToWorld, createSourceArchive, inWorld } from './sourceArchive.ts';
import type { ArchiveStore } from './store.ts';
import type { WorldConfig } from './types.ts';
import { worldNames } from './worldPrompt.ts';
import { reassembleOnChange } from './worldScope.ts';
import { DEFAULT_COLD_HOURS, DEFAULT_MEMORY_TURNS } from './worldSwitch.ts';

export type { WorldPromptSource } from './promptSection.ts';
const memorySource = 'dsh-world-history';
const isMemoryBlock = (event: ReturnType<Session['eventAt']>) => event?.type === 'user/message' && event.data.source.kind === memorySource;

/**
 * Per session: whether the memory block must be (re)built at the next step, the position and time of the latest request.
 */
interface MemoryState { reload: boolean; position: { turn: number; step: number }; lastRequestAt?: number; inScope: boolean; restart: boolean; pendingId?: string; retiring: SessionSeq[] }

/**
 * The memory line: her conversations are archived as they happen, and every world session gets a memory
 * block of the newest turns at its start, after each successful compaction and when it speaks again after being cold,
 * never in between, so it stays inside the provider-cached prefix. `home` archives the current home; `workspace` uses host membership. The memory block still
 * goes to every world session in her workspace (`inWorkspace`), independently of the archive scope.
 * `memoryTurns` is read each time a block is built (default 200).
 *
 * A session silent for `coldHours` (read at each turn start, default 24) is cold (#36): its provider cache has most
 * likely expired (DeepSeek clears an unused one "usually within a few hours to a few days", best effort), so its next
 * turn re-reads her memory block and prompt as a newly opened session would, at the cost of at most one uncached
 * request. A conversation in progress does not pause that long, so its cached prefix stays whole.
 */
export function createWorldRuntime(ctx: Context, config: WorldConfig, store: ArchiveStore, world?: WorldPromptSource, memoryTurns: () => number = () => DEFAULT_MEMORY_TURNS, coldHours: () => number = () => DEFAULT_COLD_HOURS, now: () => number = Date.now) {
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
  const disposers: (() => void)[] = [];
  let stopping: Promise<void> | undefined;
  let stopped = false;
  /**
   * Whether the session may carry her world: her preset, or a memory block inherited onto its surface (a delegated
   * child of her session). Everything else is never read from disk or tracked. The check stays in memory.
   */
  const mayCarryWorld = (session: Session) => belongsToWorld(session, config) || memory.has(session) || session.surface.nodes.some(seq => isMemoryBlock(session.eventAt(seq)));

  function newMemoryState(session: Session): MemoryState {
    const inScope = included(session);
    return { reload: true, position: { turn: 1, step: 1 }, retiring: [], inScope, restart: !inScope && belongsToWorld(session, config) };
  }
  /**
   * Archive failures never stop her talking: they stay in the health list, and what she said meanwhile is replayed
   * from the host's log, from the archive's last committed position, once a later replay succeeds.
   */
  async function archiveNow(sessionId: string): Promise<void> {
    if (archived(sessionId)) await faults.track(`archive:${sessionId}`, `会话 ${sessionId} 归档登记失败`, () => store.commitRecords([], store.progress(sessionId))).catch(() => {});
    await archive.schedule(sessionId).catch(() => {});
  }
  /**
   * Marks our recalled blocks on the surface for retirement. The empty system node that retires one is accepted by
   * the host only inside an open turn and step, which pre-step and attach are not, so `flushRetired` writes it from
   * the step's request hook, after the step has started and before the request is assembled (#22).
   */
  function retireMemory(session: Session, state: MemoryState): void {
    const found = session.surface.nodes.filter(seq => isMemoryBlock(session.eventAt(seq)));
    state.retiring = [...new Set([...state.retiring, ...found])];
    if (found.length) state.restart = true;
    state.reload = true; state.pendingId = undefined;
  }
  /** Where memory blocks sit on a session's surface, for the log: positions and event types only, never message text. */
  function memoryNodesOn(session: Session): string {
    const found: string[] = [];
    for (const seq of session.surface.nodes) {
      const event = session.eventAt(seq);
      if (!event) continue;
      let message: ReturnType<Session['deriveEventMessage']>;
      try { message = session.deriveEventMessage(event); } catch { continue; }
      if (message?.source?.kind === memorySource) found.push(`#${seq}(${event.type})`);
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
    // Retiring writes a system/message, which the host only accepts inside an open turn and step; attach runs
    // between turns, so an out-of-scope block is retired by the next pre-step (before any request) instead (#22).
    memory.set(session, newMemoryState(session));
    if (included(session)) await archiveNow(session.id);
  }
  /** Retire old blocks, then admit fresh memory through the host's normal append path (#21). The caller checks the scope after the wait. */
  async function freshBlock(session: Session, state: MemoryState): Promise<UserMessage | undefined> {
    const turns = await history.loadRecentTurns(memoryTurns(), archivedByScope);
    const present = new Set(session.deriveMessages().map(message => message.id));
    const text = renderHistory(excludePresentMessages(turns, present), config.timeZone, names(), config.archiveScope === 'home');
    retireMemory(session, state);
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
        const compacted = event.type === 'compaction/end' && event.data.error === undefined;
        if (state && event.type === 'user/message' && event.data.id === state.pendingId) { state.reload = false; state.pendingId = undefined; }
        if (state && compacted) { state.reload = true; }
        // The host assembles the system prompt after turn/start, so a cold session's first request already has both.
        const cold = !!state && event.type === 'turn/start' && state.lastRequestAt !== undefined && now() - state.lastRequestAt >= coldHours() * 60 * 60_000;
        if (cold) state.reload = true;
        if (compacted || cold) prompts?.refresh(session);
        if (!isOrdinarySession(session.header)) return;
        if (event.type === 'assistant/message' || event.type === 'turn/end' || event.type === 'turn/start' || event.type === 'compaction/end' || (event.type === 'user/message' && event.data.source.kind === 'user')) void archive.schedule(session.id).catch(() => {});
      }));
      // The host fails the whole session creation when a creation listener rejects, leaving an empty session behind on
      // every retry (#27); attach never rejects, and its archive failures stay in the health list.
      disposers.push(ctx.on('agent/created', ({ agent }) => {
        prompts?.add(agent); syncTools(agent);
        void attach(agent);
        return undefined;
      }));
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
        await archiveNow(agent.id); signal.throwIfAborted();
        if (!included(agent.session)) return leave();
        if (!state.reload) return decision;
        // A block that cannot be built leaves the old one in place; she talks on, the fault shows, and the next step tries again.
        let block: UserMessage | undefined, built = true;
        await faults.track(`memory:${agent.id}`, `会话 ${agent.id} 记忆刷新失败`, async () => { block = await freshBlock(agent.session, state); }).catch(() => { built = false; });
        if (!included(agent.session)) return leave();
        signal.throwIfAborted();
        if (!built) return decision;
        if (!block) { state.reload = false; return decision; }
        state.pendingId = block.id;
        return { ...decision, messages: [block, ...decision.messages] };
      }));
      // The step is open here and its request is not built yet: the one place retired blocks can be written validly.
      disposers.push(ctx.on('agent/request', async function (payload, next) {
        const state = memory.get(payload.agent.session);
        if (state) { state.position = { turn: payload.turn, step: payload.step }; state.lastRequestAt = now(); }
        if (state?.retiring.length) flushRetired(payload.agent.session, state, state.position);
        return next();
      }));
      disposers.push(ctx.on('llm/stream', async function* (request, next) {
        const agent = isAgentLoopRequest(request) && request.sessionId ? ctx.agents.get(request.sessionId) : undefined;
        const owned = agent && included(agent.session);
        const inRequest = agent && !owned ? request.messages.filter(message => message.source?.kind === memorySource).length : 0;
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
        await attach(agent);
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
