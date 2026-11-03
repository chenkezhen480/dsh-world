import { createHash } from 'node:crypto';
import { lastAssistantStreamChunk, type ContentBlock } from '@deepseek-ai/dsh-llm';
import { isAppendSurfaceEvent, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session';
import type { ArchiveScope, ConversationRecord } from './types.ts';
import { identityPrefix, legacyIdentityPrefix, speakerIdentity } from './ecosystem/shared/identity.ts';
import { replyMessages, replyText } from './ecosystem/wechat/messages.ts';

export const conversationRecordId = (worldId: string, sessionId: string, messageId: string) =>
  createHash('sha256').update(JSON.stringify([worldId, sessionId, messageId])).digest('hex');

export function visibleText(content: readonly ContentBlock[]): string {
  return content.flatMap(block => {
    if (block.type === 'text') return [block.text];
    if (block.type === 'image' || block.type === 'file') return [JSON.stringify({ type: block.type, attachment: block.attachment })];
    return [];
  }).join('\n');
}

/** A session someone talks in: not a subagent, not delegated. Only these are archived or carry her world. */
export const isOrdinarySession = (header: Pick<SessionHeader, 'origin' | 'delegationDepth'>) => header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0;

export function extractConversationRecords(event: SessionEvent, scope: ArchiveScope): ConversationRecord[] {
  const { header } = scope;
  if (!isOrdinarySession(header) || event.seq < scope.inheritedEventCount) return [];
  if (event.type !== 'user/message' && event.type !== 'assistant/message') return [];
  if (!isAppendSurfaceEvent(event)) return [];
  const message = event.type === 'user/message' ? event.data : event.data.message;
  const outgoing = event.type === 'user/message' && event.data.source.kind === 'dsh-world-wechat-outgoing' ? event.data.source : undefined;
  if (event.type === 'user/message' && message.source.kind !== 'user' && !outgoing) return [];
  const identity = event.type === 'user/message' && 'identity' in message.source ? speakerIdentity(message.source.identity) : undefined;
  const sentMessages = outgoing ? replyMessages(outgoing.messages) : undefined;
  if (outgoing && (identity?.channel !== 'wechat' || identity.speakerId !== `wechat:${identity.accountId}`)) throw new Error('Invalid WeChat outgoing identity');
  const visible = visibleText(message.content);
  const prefix = identity && [identityPrefix(identity), legacyIdentityPrefix(identity)].find(prefix => visible.startsWith(prefix));
  const content = outgoing ? `微信待发送给 ${identity!.conversationId}（已生成，发送尚未确认）：\n${replyText(sentMessages!)}` : prefix ? visible.slice(prefix.length) : visible;
  if (!content) return [];
  const turn = event.type === 'assistant/message' ? event.data.turn : scope.turn;
  if (!Number.isSafeInteger(turn) || turn < 1) throw new Error(`dsh-world: no host turn for ${header.id}/${event.seq}`);
  return [{
    schemaVersion: 1, worldId: scope.worldId,
    recordId: conversationRecordId(scope.worldId, header.id, message.id),
    sourceSessionId: header.id, sourceMessageId: message.id, sourceSeq: event.seq,
    turnId: `${header.id}:${turn}`, role: event.type === 'user/message' && !outgoing ? 'user' : 'assistant',
    occurredAt: new Date(event.time).toISOString(), content, ...identity,
    ...(sentMessages ? { wechatDelivery: { status: 'pending' as const, confirmed: 0, total: sentMessages.length } } : {}),
    status: event.type === 'assistant/message' && (event.data.interrupted || lastAssistantStreamChunk(event.data.stream, 'finish')?.reason.kind === 'max-tokens') ? 'interrupted' : 'complete',
  }];
}
