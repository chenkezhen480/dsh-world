import assert from 'node:assert/strict';
import test from 'node:test';
import { freezeMessage, MessageId } from '@deepseek-ai/dsh-llm';
import { SessionId, SessionSeq, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session';
import { extractConversationRecords } from '../src/archive.ts';
import { identityPrefix, speakerIdentity } from '../src/ecosystem/shared/identity.ts';

const header: SessionHeader = { id: SessionId('a'), version: 4, createdAt: 0, isSeeded: false, agentPreset: 'companion' };
const scope = { worldId: 'fish', agentPreset: 'companion', header, inheritedEventCount: 0, turn: 1 };
const user = (id: string, text: string): SessionEvent<'user/message'> => ({ type: 'user/message', seq: SessionSeq(2), time: 1792758600000, surfaceOp: 'append', data: freezeMessage({ role: 'user', id: MessageId(id), source: { kind: 'user' }, content: [{ type: 'text', text }] }) });
const assistant = (id: string): SessionEvent<'assistant/message'> => ({ type: 'assistant/message', seq: SessionSeq(3), time: 1792758601000, surfaceOp: 'append', data: { turn: 1, step: 1, message: freezeMessage({ role: 'assistant', id: MessageId(id), source: { kind: 'model', provider: 'test', model: 'test' }, content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'visible' }, { type: 'tool-call', id: 'call' as never, name: 'tool', arguments: '{}' }] }), stream: [] } });

test('consecutive users and proactive assistant share host turn identity', () => {
  const records = [user('u1', 'one'), user('u2', 'two'), assistant('m1')].flatMap(e => extractConversationRecords(e, scope));
  assert.deepEqual(records.map(r => [r.turnId, r.role, r.content]), [['a:1', 'user', 'one'], ['a:1', 'user', 'two'], ['a:1', 'assistant', 'visible']]);
  assert.equal(extractConversationRecords(assistant('proactive'), scope).length, 1);
});
test('replay is stable, regenerated message is independent, inherited messages are excluded', () => {
  const first = extractConversationRecords(assistant('m1'), scope)[0];
  assert.deepEqual(extractConversationRecords(assistant('m1'), scope), [first]);
  assert.notEqual(extractConversationRecords(assistant('m2'), scope)[0].recordId, first.recordId);
  assert.deepEqual(extractConversationRecords(assistant('m1'), { ...scope, inheritedEventCount: 4 }), []);
});
// Which sessions are archived at all is the archive scope's call (archiveSelection), never the extractor's.
test('injected, replaced and delegated messages are not experiences', () => {
  const injected = user('u', 'injected');
  for (const kind of ['runtime-context', 'time-context', 'dsh-world-history', 'subagent']) {
    assert.deepEqual(extractConversationRecords({ ...injected, data: { ...injected.data, source: { kind } } } as never, scope), []);
  }
  assert.deepEqual(extractConversationRecords({ ...injected, surfaceOp: { op: 'replace', startSeq: SessionSeq(0), endSeq: SessionSeq(0) } }, scope), []);
  assert.deepEqual(extractConversationRecords(injected, { ...scope, header: { ...header, origin: 'subagent' } }), []);
  assert.deepEqual(extractConversationRecords(injected, { ...scope, header: { ...header, delegationDepth: 1 } }), []);
  for (const type of ['tool/result', 'assistant/attempt', 'turn/start', 'system/message']) assert.deepEqual(extractConversationRecords({ type } as never, scope), []);
});
test('interrupted visible text is marked, thinking-only settlement is excluded', () => {
  const event = assistant('m');
  const interrupted: SessionEvent<'assistant/message'> = { ...event, data: { ...event.data, interrupted: true } };
  assert.equal(extractConversationRecords(interrupted, scope)[0].status, 'interrupted');
  const hidden: SessionEvent<'assistant/message'> = { ...event, data: { ...event.data, message: { ...event.data.message, content: [{ type: 'reasoning', text: 'secret' }] } } };
  assert.deepEqual(extractConversationRecords(hidden, scope), []);
});
test('output-limit truncation is archived as interrupted visible text', () => {
  const event = assistant('limited');
  event.data.stream = [{ type: 'chunk', time: event.time, chunk: { type: 'finish', reason: { kind: 'max-tokens' } } }];
  assert.equal(extractConversationRecords(event, scope)[0].status, 'interrupted');
});

test('structured sender identity survives archiving while the role stays user', () => {
  const event = user('wechat-message', 'hello');
  const identity = { channel: 'wechat', accountId: 'wxid_bot', conversationId: 'family@chatroom', speakerId: 'wechat:wxid_mom', speakerName: '妈妈', platformMessageId: 'message_0.db:42', mentionIds: ['wechat:wxid_bot'] };
  const source = { kind: 'user' as const, identity };
  const tagged = { ...event, data: freezeMessage({ ...event.data, source }) };
  const record = extractConversationRecords(tagged, scope)[0];
  assert.equal(record.role, 'user');
  assert.equal(record.speakerId, identity.speakerId);
  assert.equal(record.conversationId, identity.conversationId);
  assert.equal(record.platformMessageId, identity.platformMessageId);
  assert.deepEqual(record.mentionIds, identity.mentionIds);
});
test('the channel header is not archived as words, in the current form or the one older logs still hold', () => {
  const identity = { channel: 'wechat', accountId: 'wxid_bot', conversationType: 'private' as const, conversationId: 'wxid_ken', speakerId: 'wechat:wxid_ken', speakerName: 'Ken' };
  const archived = (text: string) => {
    const event = user('wechat-message', text);
    return extractConversationRecords({ ...event, data: freezeMessage({ ...event.data, source: { kind: 'user' as const, identity } }) }, scope)[0].content;
  };
  assert.equal(archived(identityPrefix(identity) + '在吗'), '在吗');
  // As 0.7.0 wrote it: the normalized identity, whose key order differs from the literal above.
  assert.equal(archived(`【消息来源 ${JSON.stringify(speakerIdentity(identity))}】\n在吗`), '在吗');
});
