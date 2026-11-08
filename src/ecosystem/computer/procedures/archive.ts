// src/ecosystem/computer/procedures/archive.ts
import { createHash } from 'node:crypto';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionSeq } from '@deepseek-ai/dsh-session';
import { speakerIdentity, type SpeakerIdentity } from '../../shared/identity.ts';
import type { ArchiveStore } from '../../../store.ts';
import type { ConversationRecord } from '../../../types.ts';
import type { Row } from '../browser/page.ts';
import { substitute, type MessageMap } from './format.ts';
import type { Args } from './run.ts';

/** Keyed by the platform's own message, not the session: reading the same message again finds the same record. */
export const computerRecordId = (worldId: string, channel: string, conversationId: string, messageId: string) =>
  createHash('sha256').update(JSON.stringify(['computer', worldId, channel, conversationId, messageId])).digest('hex');

export function messageRecords(map: MessageMap, rows: readonly Row[], args: Args, at: { worldId: string; sessionId: string; turn: number; seq: number; now: Date }): { records: ConversationRecord[]; skipped: number } {
  const records: ConversationRecord[] = [];
  let skipped = 0;
  for (const row of rows) {
    const values = { ...args, ...row };
    const field = (template: string | undefined) => template === undefined ? '' : substitute(template, values).trim();
    const accountId = field(map.accountId), conversationId = field(map.conversationId), messageId = field(map.messageId), content = field(map.content);
    const outgoing = field(map.outgoing) === 'true';
    const speaker = outgoing ? accountId : field(map.speakerId);
    if (!accountId || !conversationId || !messageId || !speaker || !content) { skipped++; continue; }
    let identity: SpeakerIdentity;
    try {
      identity = speakerIdentity({ channel: map.channel, accountId, conversationId, speakerId: `${map.channel}:${speaker}`, conversationType: map.conversationType,
        ...(field(map.speakerName) ? { speakerName: field(map.speakerName) } : {}), ...(field(map.conversationName) ? { conversationName: field(map.conversationName) } : {}) });
    } catch { skipped++; continue; }
    const when = Date.parse(field(map.occurredAt));
    const recordId = computerRecordId(at.worldId, map.channel, conversationId, messageId);
    // The rows come from a tool's result, not from a session message, so the source ids are synthetic: history.ts only
    // uses sourceMessageId to drop messages already in context, and these never are.
    records.push({
      schemaVersion: 1, worldId: at.worldId, recordId,
      sourceSessionId: at.sessionId, sourceMessageId: `computer:${recordId.slice(0, 32)}`, sourceSeq: at.seq,
      turnId: `${at.sessionId}:${at.turn}`, role: outgoing ? 'assistant' : 'user',
      occurredAt: new Date(Number.isFinite(when) ? when : at.now.getTime()).toISOString(),
      content: [...content].slice(0, 2000).join(''), status: 'complete', ...identity,
    });
  }
  return { records, skipped };
}

/** The turn the running tool belongs to: the latest turn start in the session. */
function homeTurn(agent: Agent): number {
  for (let seq = agent.session.seq - 1; seq >= 0; seq--) {
    const event = agent.session.eventAt(SessionSeq(seq));
    if (event?.type === 'turn/start') return event.data.turn;
  }
  throw new Error('找不到这一轮的开始，没有记进归档');
}

/** Writes what one of her tools read, as the home turn that ran it, and only where her archive reaches. */
export function createComputerRecorder(deps: { store: Pick<ArchiveStore, 'commitRecords' | 'hasRecord'>; worldId: string; archived(sessionId: string): boolean; now?: () => Date }) {
  return {
    async record(agent: Agent, map: MessageMap, rows: readonly Row[], args: Args): Promise<{ written: number; skipped: number; outOfScope: boolean }> {
      if (!deps.archived(agent.id)) return { written: 0, skipped: 0, outOfScope: true };
      const turn = homeTurn(agent);
      const { records, skipped } = messageRecords(map, rows, args, { worldId: deps.worldId, sessionId: agent.id, turn, seq: agent.session.seq, now: deps.now?.() ?? new Date() });
      // `written` is what was new to the archive: reading the same messages again must not claim to have filed them.
      const fresh = records.filter(record => !deps.store.hasRecord(record.recordId)).length;
      if (records.length) await deps.store.commitRecords(records);
      return { written: fresh, skipped, outOfScope: false };
    },
  };
}
export type ComputerRecorder = ReturnType<typeof createComputerRecorder>;
