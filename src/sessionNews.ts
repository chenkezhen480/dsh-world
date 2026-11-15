import type { Session } from '@deepseek-ai/dsh-session';
import { chatLabel, chatName } from './ecosystem/shared/identity.ts';
import { ago, type ElsewhereNews, type ElsewhereSource } from './elsewhere.ts';
import { sessionMarker } from './history.ts';
import type { ArchiveStore } from './store.ts';
import type { ConversationRecord } from './types.ts';

interface Place { label?: string; count: number; lastSequence: number; last: ConversationRecord }
/** What one of her sessions has been told about the others: how far it has read the archive, and what came since. */
interface Seen { scanned: number; places: Map<string, Place> }

/**
 * Her other sessions as a source of news: what was archived there since this session started hearing, counted per
 * session, never the words. It starts at the archive's end, so an upgrade or a restart tells nothing old; she reads a
 * place with memory_find on its sourceId, and once she has paged its newest lines it is caught up.
 */
export function createSessionNews(deps: { store: Pick<ArchiveStore, 'readSince' | 'lastSequence'>; isHome(sessionId: string): boolean; partner(): string }) {
  const seen = new WeakMap<Session, Seen>();
  const labelOf = (sessionId: string, record: ConversationRecord) => deps.isHome(sessionId) ? '家'
    : record.channel && record.conversationType === 'group' ? chatLabel(record.channel, 'group', chatName(record) ?? record.conversationId ?? '') : undefined;
  /** Reads what was archived since the last look, keeping only other sessions' lines. */
  function catchUp(session: Session): Seen {
    const state = seen.get(session);
    if (!state) { const fresh = { scanned: deps.store.lastSequence(), places: new Map<string, Place>() }; seen.set(session, fresh); return fresh; }
    for (let batch = deps.store.readSince(state.scanned); batch.length; batch = deps.store.readSince(state.scanned)) {
      for (const { sequence, record } of batch) {
        state.scanned = sequence;
        const id = record.sourceSessionId;
        if (id === session.id) continue;
        const place = state.places.get(id) ?? { count: 0, lastSequence: sequence, last: record };
        place.count += 1; place.lastSequence = sequence; place.last = record; place.label ??= labelOf(id, record);
        state.places.set(id, place);
      }
    }
    return state;
  }
  const source: ElsewhereSource = {
    look: '别的会话用 memory_find 带上那一行的 sourceId 翻最新的',
    news(now: Date, session: Session): ElsewhereNews[] {
      return [...catchUp(session).places].sort(([, a], [, b]) => b.lastSequence - a.lastSequence).map(([id, place]) => {
        const who = place.last.role === 'assistant' ? '我自己' : place.last.speakerName ?? deps.partner();
        const label = place.label ?? `另一个窗口（${sessionMarker(id)}）`;
        return {
          key: `session:${id}`, mark: `${place.count}:${place.lastSequence}`,
          text: `${label}有 ${place.count} 条我在这边没看到，最后是${who}（${ago(now.getTime() - Date.parse(place.last.occurredAt))}）；sourceId：chat:${id}`,
        };
      });
    },
  };
  return {
    source,
    /** She paged the newest lines of that session from this one: it is caught up. */
    looked(session: Session, sessionId: string): void { catchUp(session).places.delete(sessionId); },
  };
}
