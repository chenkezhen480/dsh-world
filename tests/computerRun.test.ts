// tests/computerRun.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProcedure } from '../src/ecosystem/computer/procedures/format.ts';
import { checkArgs, failureText, resultText, runProcedure, summaryLine, type Driver } from '../src/ecosystem/computer/procedures/run.ts';

function fakeDriver(overrides: Partial<Driver> = {}) {
  const calls: string[] = [];
  const driver: Driver = {
    open: async url => { calls.push(`open ${url}`); },
    click: async target => { calls.push(`click ${JSON.stringify(target)}`); },
    type: async (target, text) => { calls.push(`type ${JSON.stringify(target)} ${text}`); },
    press: async key => { calls.push(`press ${key}`); },
    wait: async () => { calls.push('wait'); },
    has: async () => true,
    extract: async () => [{ who: '阿明', text: '你好' }],
    evaluate: async (_script, args) => { calls.push(`eval ${JSON.stringify(args)}`); return 3; },
    brief: async () => '当前页 · u\n[1] button 发送',
    ...overrides,
  };
  return { driver, calls };
}
const send = parseProcedure({
  name: 'bili_dm_send', description: '发私信', params: { uid: { type: 'string', required: true }, text: { type: 'string', required: true } },
  steps: [
    { open: 'https://message.bilibili.com/#/whisper/mid{{uid}}' },
    { wait: { anchor: { role: 'textbox' } } },
    { type: { into: { role: 'textbox' }, text: '{{text}}' } },
    { click: { role: 'button', name: '发送' }, outward: true },
    { check: { text: '{{text}}' } },
  ],
});

test('steps run in order with arguments filled in', async () => {
  const { driver, calls } = fakeDriver();
  const result = await runProcedure(send, { uid: '42', text: '在吗' }, driver);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['open https://message.bilibili.com/#/whisper/mid42', 'wait', 'type {"anchor":{"role":"textbox"}} 在吗', 'click {"anchor":{"role":"button","name":"发送"}}']);
});

test('a failure stops at its step, says whether anything outward already happened, and shows the page', async () => {
  const before = await runProcedure(send, { uid: '42', text: '在吗' }, fakeDriver({ type: async () => { throw new Error('页面上找不到 textbox'); } }).driver);
  assert.equal(before.ok, false);
  if (before.ok) return;
  assert.equal(before.step, 3); assert.equal(before.outwardDone, false);
  assert.match(failureText('bili_dm_send', before), /第 3 步.*找不到 textbox[\s\S]*还没有任何向外的动作[\s\S]*\[1\] button 发送/);
  const after = await runProcedure(send, { uid: '42', text: '在吗' }, fakeDriver({ has: async () => false }).driver);
  assert.equal(after.ok, false);
  if (after.ok) return;
  assert.equal(after.step, 5); assert.equal(after.outwardDone, true);
  assert.match(failureText('bili_dm_send', after), /可能已经发出.*不要直接重跑/);
});

test('arguments are checked against what the tool declared', () => {
  assert.deepEqual(checkArgs(send, { uid: '42', text: 'hi' }), { uid: '42', text: 'hi' });
  assert.throws(() => checkArgs(send, { uid: '42' }), /缺少参数 text/);
  assert.throws(() => checkArgs(send, { uid: 42, text: 'x' }), /uid 应该是 string/);
  assert.throws(() => checkArgs(send, { uid: '1', text: 'x', extra: 1 }), /不认识的参数 extra/);
});

test('results and the alarm line stay short', async () => {
  const unread = parseProcedure({ name: 'bili_unread', description: '看谁找我', params: {}, onAlarm: true, summary: '私信 {{dm}}；回复我 {{count}}',
    steps: [{ extract: { list: { css: '.item' }, fields: { who: { css: '.who' }, text: { css: '.text' } } } }, { script: 'return 3', as: 'dm' }] });
  const result = await runProcedure(unread, {}, fakeDriver().driver);
  assert.equal(summaryLine(unread, result), 'my_bili_unread：私信 3；回复我 1');
  assert.ok(result.ok);
  assert.equal(resultText(result), '{"rows":[{"who":"阿明","text":"你好"}],"values":{"dm":3}}');
  const broken = await runProcedure(unread, {}, fakeDriver({ extract: async () => { throw new Error('页面上找不到 选择器 .item'); } }).driver);
  assert.match(summaryLine(unread, broken), /^my_bili_unread 没跑通（第 1 步：页面上找不到 选择器 \.item）$/);
});

test('cancellation is not reported as a page failure', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runProcedure(send, { uid: '1', text: 'x' }, fakeDriver().driver, controller.signal));
});

test('an outward step that itself throws still counts as possibly sent', async () => {
  const result = await runProcedure(send, { uid: '1', text: 'x' }, fakeDriver({ click: async () => { throw new Error('连接断了'); } }).driver);
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.step, 4); assert.equal(result.outwardDone, true); }
});

test('a long result is cut by characters, never in the middle of one', () => {
  const text = resultText({ ok: true, rows: [], values: { v: '😀'.repeat(3000) } });
  assert.ok(text.endsWith('…（截断）'));
  assert.equal([...text].length, 2000 + [...'…（截断）'].length);
  assert.doesNotMatch(text, /[\ud800-\udbff](?![\udc00-\udfff])/);
});

test('parameters in extract anchors are filled in before the driver sees them', async () => {
  const seen: unknown[] = [];
  const procedure = parseProcedure({ name: 'bili_user', description: '读某人', params: { uid: { type: 'string', required: true } },
    steps: [{ extract: { list: { css: '.u{{uid}}' }, fields: { text: { css: '.t{{uid}}' }, id: { attr: 'data-id' } }, limit: 5 } }] });
  await runProcedure(procedure, { uid: '42' }, fakeDriver({ extract: async spec => { seen.push(spec); return []; } }).driver);
  assert.deepEqual(seen, [{ list: { css: '.u42' }, fields: { text: { css: '.t42' }, id: { attr: 'data-id' } }, limit: 5 }]);
});

test('an open step whose parameter turns into a non-web address is refused when it runs', async () => {
  const goto = parseProcedure({ name: 'goto', description: 'g', params: { url: { type: 'string', required: true } }, steps: [{ open: '{{url}}' }] });
  const { driver, calls } = fakeDriver();
  const result = await runProcedure(goto, { url: 'file:///C:/secret' }, driver);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /只能打开 http 或 https 地址/);
  assert.deepEqual(calls, []);
});

test('a wait step hands the run signal to the driver', async () => {
  const seen: unknown[] = [];
  const wait = parseProcedure({ name: 'wait_one', description: 'w', params: {}, steps: [{ wait: { text: 'x' } }] });
  const controller = new AbortController();
  await runProcedure(wait, {}, fakeDriver({ wait: async (_c, _t, signal) => { seen.push(signal); } }).driver, controller.signal);
  assert.deepEqual(seen, [controller.signal]);
});
