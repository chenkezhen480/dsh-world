import type { Context } from '@deepseek-ai/cordis';
import { SessionId, SessionLogOffset, type Session, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-persistence';
import { abortable } from './abortable.ts';
import { extractConversationRecords, isOrdinarySession } from './archive.ts';
import type { ArchiveStore } from './store.ts';
import type { WorldConfig } from './types.ts';
import { wechatDeliveryPatch } from './ecosystem/wechat/archive.ts';
import { errorText, Faults } from './faults.ts';

const pageSize = 128;
/** Events kept for one session while its replay is pending; past this the stored log is read instead. */
const MAX_OBSERVED = 4096;
const sessionPresets = new WeakMap<Session, { nextSeq: number; preset?: string }>();
/** The header is creation-time metadata; later selections in the log decide the current preset. */
export function sessionPreset(session: Session): string | undefined {
  const state = sessionPresets.get(session) ?? { nextSeq: 0, preset: session.header.agentPreset };
  const end = session.seq;
  for (let from = state.nextSeq; from < end; from += pageSize) {
    for (const event of session.snapshotEvents(SessionLogOffset(from), SessionLogOffset(Math.min(from + pageSize, end)))) {
      if (event.type === 'agent-preset/selected') state.preset = event.data.agentPreset;
    }
  }
  state.nextSeq = end;
  sessionPresets.set(session, state);
  return state.preset;
}
/** Unreadable logs are isolated per source; their archive gaps remain visible until replay succeeds. */
export function isCorruptSessionLog(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? '');
  return /stored log is corrupt|SessionFormatError|does not match (?:an|the) open turn/i.test(text);
}
export function belongsToWorld(session: Session, config: WorldConfig): boolean {
  return isOrdinarySession(session.header) && sessionPreset(session) === config.agentPreset;
}
/** One of her sessions that is also in her room's workspace; without a membership test, any of her sessions. */
export function inWorld(session: Session, config: WorldConfig, inWorkspace?: (sessionId: string) => boolean): boolean {
  return belongsToWorld(session, config) && (inWorkspace?.(session.id) ?? true);
}
export const isNotFound = (error: unknown) => error instanceof Error && error.name === 'SessionPersistenceNotFoundError';

/**
 * Copies her conversations from the host's session logs into the archive. Each session is replayed from where
 * the archive left off; replays run one at a time, and a session already queued is not queued twice. Sessions
 * outside `archived` are left alone.
 */
export function createSourceArchive(ctx: Context, config: WorldConfig, store: ArchiveStore, archived: (sessionId: string) => boolean = () => true) {
  const dirty = new Set<string>();
  const jobs = new Map<string, Promise<void>>();
  const failures = new Map<string, unknown>();
  const faults = new Faults();
  let tail = Promise.resolve();
  /**
   * What her live sessions published past the archive's position, so a replay need not reopen the stored log: the
   * host decodes and freezes the whole log on every open, and on every read after it changed, which for a home that
   * has lived a month is the whole month again on each of her messages (#68). Only the events are kept, never the
   * session, and they go as soon as the archive holds them.
   */
  const observed = new Map<string, SessionEvent[]>();

  function forget(sessionId: string): void {
    store.forgetProgress(sessionId); observed.delete(sessionId);
    failures.delete(sessionId); faults.clear(sessionId);
  }
  function observe(sessionId: string, event: SessionEvent): void {
    if (!archived(sessionId)) return;
    const events = observed.get(sessionId);
    // A gap, or a backlog no replay has drained, leaves the rest to the stored log.
    if (!events || event.seq !== events.at(-1)!.seq + 1 || events.length >= MAX_OBSERVED) observed.set(sessionId, [event]);
    else events.push(event);
  }

  /** Her conversation records in one page of a session's log, and the turn its last turn start leaves. */
  function pageRecords(events: readonly SessionEvent[], source: { header: SessionHeader; inheritedEventCount: SessionLogOffset }, turn: number, skip: boolean) {
    const records = events.flatMap(event => {
      if (event.type === 'turn/start') turn = event.data.turn;
      return skip ? [] : extractConversationRecords(event, { ...config, header: source.header, inheritedEventCount: source.inheritedEventCount, turn }).map(record => {
        const delivery = record.wechatDelivery ? store.delivery(record.recordId) : undefined;
        return delivery ? { ...record, ...wechatDeliveryPatch(record, delivery) } : record;
      });
    });
    return { records, turn };
  }
  /** Archives a live session from what it published; false when that does not reach from the archive's position to its end. */
  async function copyObserved(live: Session): Promise<boolean> {
    let { nextSeq, turn } = store.progress(live.id);
    const events = (observed.get(live.id) ?? []).filter(event => event.seq >= nextSeq);
    if ((events[0]?.seq ?? live.seq) !== nextSeq || (events.at(-1)?.seq ?? nextSeq - 1) + 1 !== live.seq) return false;
    for (let from = 0; from < events.length && archived(live.id); from += pageSize) {
      const page = events.slice(from, from + pageSize);
      const copied = pageRecords(page, live, turn, false);
      turn = copied.turn; nextSeq = page.at(-1)!.seq + 1;
      await store.commitRecords(copied.records, { sessionId: live.id, nextSeq, turn });
    }
    return true;
  }
  /** Drops what the archive now holds; a session with nothing left waiting is forgotten. */
  function settleObserved(sessionId: string): void {
    const { nextSeq } = store.progress(SessionId(sessionId));
    const rest = observed.get(sessionId)?.filter(event => event.seq >= nextSeq);
    if (rest?.length) observed.set(sessionId, rest); else observed.delete(sessionId);
  }
  /** Copies what the archive has not seen yet; `skip` moves past it without keeping it. */
  async function copySource(sessionId: string, skip: boolean): Promise<void> {
    const id = SessionId(sessionId);
    const live = ctx.sessions.get(id);
    try {
      if (live && !skip && await copyObserved(live)) return;
      if (live) await ctx.sessions.flush(live);
      // A deleted session keeps what it already archived; there is nothing left to replay.
      const handle = await ctx.sessionPersistence.open(id, 'read').catch(error => {
        if (isNotFound(error)) { ctx.logger.warn(`dsh-world: session ${sessionId} is no longer stored; skipping replay`); forget(sessionId); return undefined; }
        throw error;
      });
      if (!handle) return;
      try {
        let { nextSeq, turn } = store.progress(id);
        while (true) {
          const { events } = await handle.read(nextSeq, pageSize);
          if (!events.length || (!skip && !archived(sessionId))) break;
          const copied = pageRecords(events, handle, turn, skip);
          turn = copied.turn; nextSeq = events.at(-1)!.seq + 1;
          await store.commitRecords(copied.records, { sessionId: id, nextSeq, turn });
        }
      } finally { await handle.close(); }
    } finally { settleObserved(sessionId); }
  }
  async function replay(sessionId: string, skip = false): Promise<void> {
    try {
      await copySource(sessionId, skip);
      failures.delete(sessionId); faults.clear(sessionId);
    } catch (error) {
      dirty.delete(sessionId);
      const message = `会话 ${sessionId} 归档未完成：${errorText(error)}`;
      faults.set(sessionId, message);
      if (isCorruptSessionLog(error)) {
        failures.delete(sessionId); ctx.logger.warn(`dsh-world: ${message}`); return;
      }
      failures.set(sessionId, error);
      throw error;
    }
  }
  /** Runs after every queued replay. */
  function enqueue(work: () => Promise<void>): Promise<void> {
    const job = tail.then(work);
    tail = job.catch(error => { ctx.logger.error(error); });
    return job;
  }
  function schedule(sessionId: string): Promise<void> {
    // Not archived itself, it still waits for the replays already queued, so its memory block is current.
    if (!archived(sessionId)) return tail;
    dirty.add(sessionId);
    const pending = jobs.get(sessionId);
    if (pending) return pending;
    const job = tail.then(async () => {
      try { while (dirty.delete(sessionId)) await replay(sessionId); }
      finally { jobs.delete(sessionId); }
    });
    jobs.set(sessionId, job);
    tail = job.catch(error => { ctx.logger.error(error); });
    return job;
  }
  /** Replays what was missed, or passes over messages written while the world was stopped when `skip` is set. */
  async function catchUp(skip = false, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    // Keep the current replay in the queue so its transaction and file close finish before shutdown.
    const replayOne = (id: string) => (skip ? enqueue(() => replay(id, true)) : schedule(id)).catch(() => {});
    try {
      // The host exposes a metadata inventory; every selected message log is still read in pages.
      const snapshots = await abortable(ctx.sessionPersistence.list({ signal }), signal);
      const visited = new Set<string>();
      for (let offset = 0; offset < snapshots.length; offset += pageSize) {
        for (const { header } of snapshots.slice(offset, offset + pageSize)) {
          if (signal?.aborted) return;
          if (!isOrdinarySession(header) || !archived(header.id)) continue;
          visited.add(header.id);
          await replayOne(header.id);
        }
      }
      let after = '';
      while (!signal?.aborted) {
        const ids = store.sourcePage(after);
        if (!ids.length) return;
        for (const id of ids) {
          if (signal?.aborted) return;
          after = id;
          if (visited.has(id)) continue;
          // A session deleted from the host (not merely archived there) keeps its records but has nothing left to resume.
          const exists = await abortable(ctx.sessionPersistence.stat(SessionId(id), { signal }), signal);
          if (signal?.aborted) return;
          if (!exists) { forget(id); continue; }
          if (!archived(id)) continue;
          await replayOne(id);
        }
      }
    } catch (error) { if (!signal?.aborted || error !== signal.reason) throw error; }
  }
  return {
    schedule,
    /** Every event a live session publishes, in order; a replay then reads them instead of the stored log. */
    observe,
    catchUp,
    faults: () => faults.list(),
    /** Moves past everything a session holds now without keeping it (said while her world was stopped). */
    skip: (sessionId: string) => enqueue(() => replay(sessionId, true)),
    /** Waits for every queued replay; rejects while any session still has an unresolved failure. */
    async flush(): Promise<void> {
      let current: Promise<void>;
      do { current = tail; await current; } while (current !== tail);
      if (failures.size) throw new AggregateError([...failures.values()], 'dsh-world: source archive has unresolved failures');
    },
  };
}
