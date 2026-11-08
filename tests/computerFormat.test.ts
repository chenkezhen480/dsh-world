// tests/computerFormat.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProcedure, ProcedureError, substitute } from '../src/ecosystem/computer/procedures/format.ts';

const unread = {
  name: 'bili_unread', description: '看谁找我', params: {}, onAlarm: true, summary: '私信 {{dm}}；回复我 {{count}}',
  steps: [
    { open: 'https://message.bilibili.com/' },
    { wait: { text: '我的消息', seconds: 8 } },
    { click: { role: 'link', name: '回复我的' } },
    { check: { text: '回复我的' } },
    { extract: { list: { css: '.reply-item' }, fields: { uid: { css: 'a.name', attr: 'data-uid' }, who: { css: 'a.name' }, text: { css: '.text' }, id: { css: '.item', attr: 'data-id' } } } },
    { script: 'return document.querySelectorAll(".unread").length', as: 'dm' },
  ],
  messages: { channel: 'bilibili', accountId: 'me', conversationType: 'group', conversationId: '{{id}}', messageId: '{{id}}', speakerId: '{{uid}}', speakerName: '{{who}}', content: '{{text}}' },
};

test('a whole tool parses and keeps what it declared', () => {
  const procedure = parseProcedure(unread);
  assert.equal(procedure.name, 'bili_unread');
  assert.equal(procedure.steps.length, 6);
  assert.equal(procedure.onAlarm, true);
  assert.equal(procedure.messages?.channel, 'bilibili');
});

test('mistakes are refused with where they are', () => {
  const bad = (patch: object, pattern: RegExp) => assert.throws(() => parseProcedure({ ...unread, ...patch }), (error: Error) => error instanceof ProcedureError && pattern.test(error.message));
  bad({ name: 'Bili-Unread' }, /^name：/);
  bad({ steps: [] }, /^steps：/);
  bad({ steps: [{ click: {} }] }, /^steps\[0\]\.click：/);
  bad({ steps: [{ click: { role: 'link' }, open: 'x' }] }, /^steps\[0\]：/);
  bad({ steps: [{ type: { into: { name: '输入' }, text: '{{who}}' } }] }, /steps\[0\]\.type\.text：.*who/);
  bad({ params: { who: { type: 'string', required: true } } }, /^onAlarm：/);
  bad({ steps: [{ script: 'x'.repeat(4001) }] }, /^steps\[0\]\.script：/);
  bad({ messages: { ...unread.messages, content: '{{body}}' } }, /^messages\.content：.*body/);
  bad({ messages: { ...unread.messages, channel: 'B站' } }, /^messages\.channel：/);
  bad({ summary: '{{nothing}}' }, /^summary：.*nothing/);
});

test('templates take parameters and row fields, unknown ones become empty', () => {
  assert.equal(substitute('给 {{who}} 发 {{n}}', { who: '阿明', n: 2 }), '给 阿明 发 2');
  assert.equal(substitute('{{missing}}!', {}), '!');
});

test('unknown keys are refused wherever they appear, so a typo cannot widen an anchor', () => {
  const bad = (patch: object, pattern: RegExp) => assert.throws(() => parseProcedure({ ...unread, ...patch }), (error: Error) => error instanceof ProcedureError && pattern.test(error.message));
  bad({ steps: [{ click: { role: 'link', nmae: '回复我的' } }] }, /^steps\[0\]\.click：.*nmae/);
  bad({ stpes: [] }, /^工具：.*stpes/);
  bad({ messages: { ...unread.messages, contnet: 'x' } }, /^messages：.*contnet/);
  bad({ steps: [{ wait: { text: 'a', secnods: 3 } }] }, /^steps\[0\]\.wait：.*secnods/);
  bad({ steps: [{ type: { into: { name: 'a' }, txt: 'b' } }] }, /^steps\[0\]\.type：.*txt/);
  bad({ params: { a: { type: 'string', requried: true } } }, /^params\.a：.*requried/);
});

test('names that would reach the prototype are refused', () => {
  const bad = (patch: object) => assert.throws(() => parseProcedure({ ...unread, ...patch }), ProcedureError);
  bad({ params: JSON.parse('{"__proto__":{"type":"string"}}') });
  bad({ steps: [{ script: 'return 1', as: 'constructor' }] });
});

test('press must be a key she can send; a script result name cannot collide', () => {
  const bad = (patch: object, pattern: RegExp) => assert.throws(() => parseProcedure({ ...unread, ...patch }), (error: Error) => error instanceof ProcedureError && pattern.test(error.message));
  bad({ steps: [{ press: 'Enterr' }] }, /^steps\[0\]\.press：/);
  bad({ steps: [{ script: 'return 1', as: 'count' }] }, /^steps\[0\]\.as：/);
  bad({ params: { n: { type: 'string' } }, steps: [{ script: 'return 1', as: 'n' }] }, /^steps\[0\]\.as：/);
  bad({ steps: [{ script: 'return 1', as: 'a' }, { script: 'return 2', as: 'a' }] }, /^steps\[1\]\.as：/);
  assert.doesNotThrow(() => parseProcedure({ ...unread, steps: [{ press: 'Enter' }] , messages: undefined, summary: undefined }));
});

test('a field with only attr reads the list item itself; without attr it needs an anchor', () => {
  const extractOf = (field: object) => ({ ...unread, messages: undefined, summary: undefined, steps: [{ extract: { list: { css: '.item' }, fields: { id: field } } }] });
  assert.deepEqual((parseProcedure(extractOf({ attr: 'data-id' })).steps[0] as { extract: { fields: object } }).extract.fields, { id: { attr: 'data-id' } });
  assert.throws(() => parseProcedure(extractOf({})), ProcedureError);
});

test('substitute only reads own values and turns null into empty', () => {
  assert.equal(substitute('{{constructor}}|{{a}}', { a: null }), '|');
});

test('a tool that runs before the alarm cannot send anything out', () => {
  assert.throws(() => parseProcedure({ name: 'bili_ping', description: 'x', params: {}, onAlarm: true, steps: [{ click: { role: 'button' }, outward: true }] }),
    (error: Error) => error instanceof ProcedureError && /^onAlarm：闹钟前自动跑的工具不能有向外发出的步骤$/.test(error.message));
});

test('an open step takes only web addresses, or a parameter that is checked when it runs', () => {
  const open = (address: string) => () => parseProcedure({ ...unread, messages: undefined, summary: undefined, onAlarm: undefined, params: { url: { type: 'string' } }, steps: [{ open: address }] });
  for (const bad of ['file:///C:/', 'chrome://settings', 'edge://flags', 'javascript:alert(1)', 'data:text/html,x', 'example.com']) assert.throws(open(bad), (error: Error) => error instanceof ProcedureError && /只能打开 http 或 https 地址/.test(error.message));
  for (const good of ['https://example.com/', 'http://example.com/', 'about:blank', '{{url}}']) assert.doesNotThrow(open(good));
});
