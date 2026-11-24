import type { MessageId } from '@deepseek-ai/dsh-llm';

/**
 * The home turn an alarm of hers started (her own or the morning one). When it is about to close with nothing planned,
 * she is asked once, inside that turn, so asking spends a step and no turn of its own. A turn someone spoke in is a
 * conversation, not the alarm's, and is left to close.
 */
export function createAlarmTurnWatch() {
  let rang = false, spoken = false, told = false;
  // The ask outlives its turn's end: a turn stopped or failed before its next step closes with the ask still queued,
  // and only once that home is idle can it be taken back out.
  let waiting: { agentId: string; id: MessageId } | undefined;
  return {
    /** The alarm's word started its step in the turn under way. */
    rang(): void { rang = true; },
    /** Someone's words came into the turn under way (her partner in DSH, or anyone through QQ or WeChat). */
    partnerSpoke(): void { spoken = true; },
    /** Whether this turn is still to be asked: an alarm's, nobody spoke in it, not asked yet. */
    due(): boolean { return rang && !spoken && !told; },
    /** She was asked with this word; not again in this turn. */
    asked(agentId: string, id: MessageId): void { told = true; waiting = { agentId, id }; },
    /** The ask sent to this home, if any, now in the caller's hands. */
    takeAsk(agentId: string): MessageId | undefined {
      if (waiting?.agentId !== agentId) return undefined;
      const { id } = waiting; waiting = undefined;
      return id;
    },
    turnEnded(): void { rang = false; spoken = false; told = false; },
  };
}
