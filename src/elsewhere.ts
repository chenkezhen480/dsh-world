import type { Session } from '@deepseek-ai/dsh-session';

/** One place she is not, as facts only (how many she has not seen, who spoke last, how long ago), never the words. */
export interface ElsewhereNews {
  /** Stable for the place, e.g. `wechat:family@chatroom`. */
  key: string;
  /** Changes whenever there is something new there; the same mark is not told twice. */
  mark: string;
  text: string;
}
/** Where news comes from: a WeChat account's groups, her other sessions, later other platforms. */
export interface ElsewhereSource {
  /** How she looks for herself, e.g. `微信群用 wechat_history 看`. */
  look: string;
  /** What is pending for this session now; a place with nothing she has not seen is left out. */
  news(now: Date, session: Session): ElsewhereNews[];
}

export function ago(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  return minutes < 1 ? '刚刚' : minutes < 60 ? `${minutes} 分钟前` : minutes < 1440 ? `${Math.floor(minutes / 60)} 小时前` : `${Math.floor(minutes / 1440)} 天前`;
}

export const ELSEWHERE_HEADER = '【别处的动静】我不在场的地方攒下的消息，只是让我知道，不是对我说的话；要不要看、要不要回，我自己决定。';

export function renderElsewhere(groups: readonly { look: string; news: readonly ElsewhereNews[] }[]): string {
  return [ELSEWHERE_HEADER, ...groups.flatMap(group => group.news.map(news => `- ${news.text}`)), `（${groups.map(group => group.look).join('；')}）`].join('\n');
}

/**
 * The one way news from elsewhere reaches her: sources register here, and each session is told what is new since it
 * was last told. An event is told once; whatever she has not looked at comes back with the next news from that place.
 */
export function createElsewhere() {
  const sources = new Set<ElsewhereSource>();
  const told = new WeakMap<Session, Map<string, string>>();
  return {
    register(source: ElsewhereSource): () => void {
      sources.add(source);
      return () => { sources.delete(source); };
    },
    /** The block of what is new for this session, marking it told; undefined when nothing is. */
    take(session: Session, now: Date): string | undefined {
      const previous = told.get(session) ?? new Map<string, string>();
      const marks = new Map<string, string>(), groups: { look: string; news: ElsewhereNews[] }[] = [];
      for (const source of sources) {
        const pending = source.news(now, session);
        for (const news of pending) marks.set(news.key, news.mark);
        const fresh = pending.filter(news => previous.get(news.key) !== news.mark);
        if (fresh.length) groups.push({ look: source.look, news: fresh });
      }
      // A place she has since caught up with is forgotten, so its next message is news again.
      told.set(session, marks);
      return groups.length ? renderElsewhere(groups) : undefined;
    },
    /** What she was told is gone from her view (compaction, leaving her world): tell again what is still pending. */
    retell(session: Session): void { told.delete(session); },
  };
}
export type Elsewhere = ReturnType<typeof createElsewhere>;
