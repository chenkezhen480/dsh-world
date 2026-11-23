// Surface transaction adapted from @deepseek-ai/dsh-compaction-basic@0.2.1-rc.2 (MIT, Copyright (c) 2026 DeepSeek).
// Kept local so the stock package is used unmodified; selection here always runs to the newest balanced cut.
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CompactionId, ManualCompactionError, compactCheckpointSource, isCompactCheckpointSource, toolPairingBalancedAfter, toolPairingBalancedBefore, type CompactionResult } from '@deepseek-ai/dsh-compaction';
import type { CommandId } from '@deepseek-ai/dsh-commands/brand';
import { createUserMessage, errorChain, type ContentBlock, type Message, type TokenUsage, type UserMessage } from '@deepseek-ai/dsh-llm';
import { SessionSeq, type Session } from '@deepseek-ai/dsh-session';
import type { TokenMeasurement, TokenSurfaceNode } from '@deepseek-ai/dsh-token-meter';

export interface SummaryResult { summary: ContentBlock[]; rawOutput: ContentBlock[]; provider: string; model: string; maxTokens: number; usage?: TokenUsage }
export interface RegionAgent { session: Session; options: { provider?: string; model?: string } }
export interface RegionDependencies {
  meter: { measure(session: Session): TokenMeasurement; estimateMessage(message: Message): number };
  summarize(messages: Message[], agent: RegionAgent, signal?: AbortSignal): Promise<SummaryResult>;
  frame(summary: ContentBlock[]): ContentBlock[];
  recover(error: unknown, agent: RegionAgent, seqs: readonly SessionSeq[], signal?: AbortSignal): boolean;
}
export interface RegionOptions { owner: 'current-turn' | null; stability: 'whole-surface' | 'selected-span'; sourceCommandId?: CommandId; flush?: () => Promise<void> }
interface Selection { start: SessionSeq; end: SessionSeq; startIdx: number; endIdx: number; shadowedSeqs: readonly SessionSeq[] }
interface Prepared extends Selection { measurement: TokenMeasurement; selectedNodes: readonly TokenSurfaceNode[]; shadowedTokenCount: number; shadowedRouteTokenCount: number; messages: Message[] }
type Summarized = Prepared & SummaryResult & { checkpointMessage: UserMessage };

function eventAt(session: Session, seq: SessionSeq) {
  const event = session.eventAt(seq);
  if (event === undefined) throw new Error(`compaction: session seq ${seq} has no event`);
  return event;
}

class SurfaceChangedError extends Error {}

/** A span shorter than this that is mostly the checkpoint it replaced has nothing to shrink; the floor only applies to such spans. */
const MIN_COMPACT_TOKENS = 4096;
/** Share of a short span that must come from earlier checkpoints before compaction would only rewrite them. */
const CHECKPOINT_SHARE = 3 / 4;

/** Everything after the system head through the newest cut that splits no tool call from its result; `null` when it is only the last summary. */
export function selectWholeRange(session: Session, measurement: TokenMeasurement): { start: SessionSeq; end: SessionSeq } | null {
  const nodes = session.surface.nodes;
  if (!nodes.length) return null;
  if (nodes.length !== measurement.nodes.length || nodes.some((seq, index) => seq !== measurement.nodes[index]?.seq)) throw new Error('compaction: token-meter surface does not match the current session surface');
  const firstIdx = eventAt(session, nodes[0]).type === 'system/message' ? 1 : 0;
  let endIdx = nodes.length - 1;
  while (endIdx >= firstIdx && !toolPairingBalancedAfter(session, nodes[endIdx])) endIdx -= 1;
  if (endIdx < firstIdx) return null;
  const span = measurement.nodes.slice(firstIdx, endIdx + 1);
  const tokens = span.reduce((total, node) => total + node.tokens, 0);
  // Below the floor, a span that is mostly made of the last checkpoint cannot summarize into anything smaller: skip instead of rewriting it.
  const onlyLastSummary = tokens < MIN_COMPACT_TOKENS && checkpointTokens(session, span) >= tokens * CHECKPOINT_SHARE;
  return onlyLastSummary ? null : { start: nodes[firstIdx], end: nodes[endIdx] };
}

/** Tokens the span carries from earlier compaction checkpoints; a summary of them can only reproduce them. */
function checkpointTokens(session: Session, span: readonly TokenSurfaceNode[]): number {
  let total = 0;
  for (const node of span) {
    const message = session.deriveEventMessage(eventAt(session, node.seq));
    if (message !== null && isCompactCheckpointSource(message.source)) total += node.tokens;
  }
  return total;
}

export async function compactSurfaceRegion(deps: RegionDependencies, agent: RegionAgent, start: SessionSeq, end: SessionSeq, options: RegionOptions, signal?: AbortSignal): Promise<CompactionResult> {
  const { session } = agent;
  if (options.owner === null) signal?.throwIfAborted();
  const selection = validateSurfaceRegion(session, start, end);
  const entry = inspectEntryState(session);
  assertInactive(entry, 'compaction');
  if (options.owner === null && entry.openTurn !== null) throw new ManualCompactionError('busy', 'manual compaction: the session already has an open turn');
  if (options.owner !== null && entry.openTurn === null) throw new Error('compactRegion: no open turn — automatic compaction events must be enclosed in a turn');
  const lifecycle = { compactionId: CompactionId(randomUUID()), ...(options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId }), turn: options.owner === null ? null : entry.openTurn };
  const startEvent = session.append('compaction/start', lifecycle);
  const assertStable = options.stability === 'whole-surface' ? assertWholeSurfaceUnchanged : assertSelectedSpanStable;
  let failure: { error: unknown; stage: 'summary' | 'commit' } | undefined;
  let flushFailure: unknown;
  let result: CompactionResult | undefined;
  let closed = false; let closing = false; let stage: 'summary' | 'commit' = 'summary';
  try {
    const summarized = await summarize(deps, prepare(deps, session, selection), agent, lifecycle.compactionId, options.sourceCommandId, assertStable, signal);
    if (options.owner === null) signal?.throwIfAborted();
    assertStable(deps, session, summarized);
    stage = 'commit';
    const pending = commitBody(session, startEvent.seq, lifecycle, summarized);
    closing = true;
    const endEvent = session.append('compaction/end', lifecycle);
    closed = true;
    result = { ...pending, endSeq: endEvent.seq };
  } catch (error) {
    failure = { error, stage: closing ? 'commit' : stage };
    if (!closing) {
      closing = true;
      try { session.append('compaction/end', { ...lifecycle, error: errorChain(error) }); closed = true; } catch (closeError) { failure = { error: closeError, stage: 'commit' }; }
    }
  }
  if (closed && options.flush) try { await options.flush(); } catch (error) { flushFailure = error; }
  if (options.owner === null) signal?.throwIfAborted();
  if (failure) {
    if (options.owner !== null) throw failure.error;
    if (failure.stage === 'commit') throw new ManualCompactionError('commit', 'manual compaction did not commit cleanly', { cause: failure.error });
    if (failure.error instanceof SurfaceChangedError) throw new ManualCompactionError('changed', 'the compacted history changed during manual compaction', { cause: failure.error });
    throw new ManualCompactionError('summary', 'manual compaction could not produce a smaller summary', { cause: failure.error });
  }
  if (flushFailure !== undefined) throw new ManualCompactionError('persistence', 'manual compaction durability checkpoint failed', { cause: flushFailure });
  return result!;
}

export function assertNoActiveCompaction(session: Session, stage: string): void { assertInactive(inspectEntryState(session), stage); }

function assertInactive(entry: ReturnType<typeof inspectEntryState>, stage: string): void {
  if (entry.unmatchedStart === undefined || (entry.latestEndSeedSeq !== undefined && entry.latestEndSeedSeq > entry.unmatchedStart)) return;
  throw new ManualCompactionError('busy', `${stage}: compaction already in progress; the session compaction lock is already active`);
}

function validateSurfaceRegion(session: Session, start: SessionSeq, end: SessionSeq): Selection {
  const nodes = session.surface.nodes;
  const startIdx = nodes.indexOf(start); const endIdx = nodes.indexOf(end);
  if (startIdx === -1) throw new Error(`compactRegion: start seq ${start} not found in surface`);
  if (endIdx === -1) throw new Error(`compactRegion: end seq ${end} not found in surface`);
  if (startIdx > endIdx) throw new Error(`compactRegion: start seq ${start} is after end seq ${end} on the surface`);
  if (!toolPairingBalancedBefore(session, nodes[startIdx])) throw new Error(`compactRegion: start seq ${start} would split a tool-call/result pair`);
  if (!toolPairingBalancedAfter(session, nodes[endIdx])) throw new Error(`compactRegion: end seq ${end} would split a tool-call/result pair, or the step is still open`);
  return { start, end, startIdx, endIdx, shadowedSeqs: nodes.slice(startIdx, endIdx + 1) };
}

function prepare(deps: RegionDependencies, session: Session, selection: Selection): Prepared {
  const measurement = deps.meter.measure(session);
  const selectedNodes = measurement.nodes.slice(selection.startIdx, selection.endIdx + 1);
  if (selectedNodes.length !== selection.shadowedSeqs.length || selectedNodes.some((node, index) => node.seq !== selection.shadowedSeqs[index])) throw new SurfaceChangedError('compaction: selected surface changed before summarization began');
  return {
    ...selection, measurement, selectedNodes,
    shadowedTokenCount: selectedNodes.reduce((total, node) => total + node.heuristicTokens, 0),
    shadowedRouteTokenCount: selectedNodes.reduce((total, node) => total + node.tokens, 0),
    messages: selection.shadowedSeqs.map(seq => session.deriveEventMessage(eventAt(session, seq))).filter((message): message is Message => message !== null),
  };
}

async function summarize(deps: RegionDependencies, prepared: Prepared, agent: RegionAgent, compactionId: CompactionId, sourceCommandId: CommandId | undefined, assertStable: typeof assertWholeSurfaceUnchanged, signal?: AbortSignal): Promise<Summarized> {
  let summary: SummaryResult;
  for (;;) {
    signal?.throwIfAborted();
    try { summary = await deps.summarize(prepared.messages, agent, signal); break; } catch (error) {
      if (signal?.aborted) throw error;
      assertStable(deps, agent.session, prepared);
      if (!deps.recover(error, agent, prepared.shadowedSeqs, signal)) throw error;
      prepared = prepare(deps, agent.session, validateSurfaceRegion(agent.session, prepared.start, prepared.end));
    }
  }
  const checkpointMessage = createUserMessage({ content: deps.frame(summary.summary), source: compactCheckpointSource(compactionId, sourceCommandId) });
  const framed = deps.meter.estimateMessage(checkpointMessage);
  if (framed >= prepared.shadowedRouteTokenCount) throw new Error(`summary is not smaller than the shadowed content (${framed} estimated framed tokens >= ${prepared.shadowedRouteTokenCount})`);
  return { ...prepared, ...summary, checkpointMessage };
}

function assertWholeSurfaceUnchanged(deps: RegionDependencies, session: Session, prepared: Prepared): void {
  if (!isDeepStrictEqual(deps.meter.measure(session).nodes, prepared.measurement.nodes)) throw new SurfaceChangedError('compaction: session surface changed during summarization');
}

function assertSelectedSpanStable(deps: RegionDependencies, session: Session, prepared: Prepared): void {
  let current: Selection;
  try { current = validateSurfaceRegion(session, prepared.start, prepared.end); } catch (error) { throw new SurfaceChangedError('compaction: the selected span is no longer a valid replacement target', { cause: error }); }
  if (!isDeepStrictEqual([...current.shadowedSeqs], [...prepared.shadowedSeqs])) throw new SurfaceChangedError('compaction: the selected span changed during summarization');
  if (!isDeepStrictEqual(deps.meter.measure(session).nodes.slice(current.startIdx, current.endIdx + 1), prepared.selectedNodes)) throw new SurfaceChangedError('compaction: the selected span was rewritten during summarization');
}

function commitBody(session: Session, startSeq: SessionSeq, lifecycle: { compactionId: CompactionId; sourceCommandId?: CommandId }, summarized: Summarized): Omit<CompactionResult, 'endSeq'> {
  const { start, end, shadowedSeqs, shadowedTokenCount, summary, rawOutput, provider, model, maxTokens, usage, checkpointMessage } = summarized;
  const { compactionId, sourceCommandId } = lifecycle;
  const command = sourceCommandId === undefined ? {} : { sourceCommandId };
  const summaryEvent = session.append('compaction/summary', {
    compactionId, ...command, summary, rawOutput, shadowedRange: { start, end }, shadowedSeqs: [...shadowedSeqs], shadowedTokenCount, provider, model, maxTokens, ...(usage === undefined ? {} : { usage }),
  });
  session.append('user/message', checkpointMessage, { surfaceOp: { op: 'replace', startSeq: start, endSeq: end }, sourceEventSeqs: [startSeq, summaryEvent.seq, ...shadowedSeqs] });
  return { compactionId, ...command, startSeq, summarySeq: summaryEvent.seq, summary, shadowedRange: { start, end }, shadowedSeqs: [...shadowedSeqs], shadowedTokenCount };
}

function inspectEntryState(session: Session) {
  let openTurn: number | null = null; let turnKnown = false;
  let unmatchedStart: SessionSeq | undefined; let lockKnown = false;
  let latestEndSeedSeq: SessionSeq | undefined;
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = eventAt(session, SessionSeq(seq));
    if (latestEndSeedSeq === undefined && event.type === 'session/end-seed') latestEndSeedSeq = event.seq;
    if (!lockKnown) {
      if (event.type === 'compaction/start') { unmatchedStart = event.seq; lockKnown = true; } else if (event.type === 'compaction/end') lockKnown = true;
    }
    if (!turnKnown) {
      if (event.type === 'turn/start') { openTurn = event.data.turn; turnKnown = true; } else if (event.type === 'turn/end') turnKnown = true;
    }
    if (turnKnown && lockKnown && latestEndSeedSeq !== undefined) break;
  }
  return { openTurn, unmatchedStart, latestEndSeedSeq };
}
