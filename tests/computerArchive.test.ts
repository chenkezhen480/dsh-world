// tests/computerArchive.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createArchiveStore } from '../src/store.ts';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ConversationRecord } from '../src/types.ts';
import { createComputerRecorder, messageRecords } from '../src/ecosystem/computer/procedures/archive.ts';
import type { MessageMap } from '../src/ecosystem/computer/procedures/format.ts';

const map: MessageMap = { channel: 'bilibili', accountId: '{{me}}', conversationType: 'private', conversationId: '{{uid}}', messageId: '{{id}}', speakerId: '{{from}}', speakerName: '{{who}}', content: '{{text}}', outgoing: '{{mine}}' };
const at = { worldId: 'w', sessionId: 'home-1', turn: 4, seq: 30, now: new Date('2026-11-05T12:00:00.000Z') };
const rows = [
  { uid: '42', id: 'm1', from: '42', who: '阿明', text: '你好', mine: '' },
  { uid: '42', id: 'm2', from: '7', who: '', text: '在的', mine: 'true' },
  { uid: '42', id: '', from: '42', who: '阿明', text: '没有 id', mine: '' },
];

test('rows become records with platform identities; her own lines are hers; rows without an id are skipped', () => {
  const { records, skipped } = messageRecords(map, rows, { me: '7' }, at);
  assert.equal(skipped, 1);
  assert.equal(records.length, 2);
  assert.deepEqual([records[0]!.role, records[0]!.speakerId, records[0]!.speakerName, records[0]!.channel, records[0]!.conversationId], ['user', 'bilibili:42', '阿明', 'bilibili', '42']);
  assert.deepEqual([records[1]!.role, records[1]!.speakerId], ['assistant', 'bilibili:7']);
  assert.equal(records[0]!.turnId, 'home-1:4');
  const again = messageRecords(map, rows, { me: '7' }, { ...at, sessionId: 'home-2', turn: 9 });
  assert.equal(again.records[0]!.recordId, records[0]!.recordId, 'the same message read again is the same record');
});

test('the recorder writes only for sessions inside the archive scope', async () => {
  const committed: ConversationRecord[] = [];
  const events = [{ type: 'turn/start', seq: 1, data: { turn: 4 } }, { type: 'message', seq: 2, data: {} }];
  const agent = { id: 'home-1', session: { seq: 3, eventAt: (seq: number) => events[seq - 1] } } as unknown as Agent;
  let archived = false;
  const recorder = createComputerRecorder({ store: { commitRecords: async records => { committed.push(...records); }, hasRecord: () => false }, worldId: 'w', archived: () => archived });
  assert.deepEqual(await recorder.record(agent, map, rows, { me: '7' }), { written: 0, skipped: 0, outOfScope: true });
  archived = true;
  assert.deepEqual(await recorder.record(agent, map, rows, { me: '7' }), { written: 2, skipped: 1, outOfScope: false });
  assert.equal(committed.length, 2);
});

test('a session with no turn start is refused instead of filed under turn 0', async () => {
  const agent = { id: 'home-1', session: { seq: 2, eventAt: () => undefined } } as unknown as Agent;
  const recorder = createComputerRecorder({ store: { commitRecords: async () => {}, hasRecord: () => false }, worldId: 'w', archived: () => true });
  await assert.rejects(recorder.record(agent, map, rows, { me: '7' }), /找不到这一轮的开始/);
});

test('reading the same messages twice leaves one copy in a real archive', async t => {
  const root = mkdtempSync(join(tmpdir(), 'computer-archive-'));
  const store = createArchiveStore({ root, worldId: 'w', agentPreset: 'companion', timeZone: 'UTC' });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const events = [{ type: 'turn/start', seq: 0, data: { turn: 4 } }];
  const agent = { id: 'home-1', session: { seq: 1, eventAt: (seq: number) => events[seq] } } as unknown as Agent;
  const recorder = createComputerRecorder({ store, worldId: 'w', archived: () => true });
  assert.equal((await recorder.record(agent, map, rows, { me: '7' })).written, 2);
  assert.equal((await recorder.record(agent, map, rows, { me: '7' })).written, 0, 'a message already in the archive is not counted again');
  assert.equal(store.stats().records, 2);
});
