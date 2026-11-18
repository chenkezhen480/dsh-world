// tests/inbox.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { Faults } from '../src/faults.ts';
import { createInbox, ELSEWHERE } from '../src/ecosystem/computer/inbox/inbox.ts';

const posted = (id: number, app: string, texts: string[], at = '2026-11-16T10:20:00.000Z') => ({ id, app, appId: `${app}.App`, at, texts });
const flash = (app: string, exe = app) => ({ app, exe, at: '2026-11-16T10:00:00.000Z' });

function world(ignore: string[] = []) {
  let now = Date.parse('2026-11-16T10:00:00.000Z');
  const faults = new Faults(), told: string[] = [];
  const state = { notifications: [] as ReturnType<typeof posted>[], flashes: [] as ReturnType<typeof flash>[], free: true, failing: undefined as string | undefined };
  const inbox = createInbox({
    faults, timeZone: 'Asia/Shanghai', clock: () => new Date(now), timers: { set: () => 0, clear: () => {} }, ignore: () => ignore,
    tell: async text => { if (state.free) told.push(text); return state.free; },
    helper: { call: async (op: string) => {
      if (state.failing) throw new Error(state.failing);
      if (op === 'notifications') return { notifications: state.notifications };
      const flashes = state.flashes; state.flashes = []; return { flashes };
    } },
  });
  inbox.start();
  return { inbox, faults, told, state, pass: (ms: number) => { now += ms; } };
}

test('what is already there when it starts is not news; what comes after is told once quiet has lasted ten seconds', async () => {
  const { inbox, told, state, pass } = world();
  state.notifications = [posted(1, 'QQ音乐', ['旧的'])];
  await inbox.look();
  state.notifications.push(posted(2, 'Outlook', ['阿澄', '周五的会改到下午']), posted(3, 'Outlook', ['阿澄', `晚上${'一起'.repeat(40)}`]));
  state.flashes = [flash('Microsoft Edge', 'msedge')];
  await inbox.look();
  pass(9_000);
  state.flashes = [flash('Microsoft Edge', 'msedge')];
  await inbox.look();
  pass(9_000);
  await inbox.look();
  assert.deepEqual(told, [], 'a new signal nine seconds in starts the wait again');
  pass(1_000);
  await inbox.look();
  assert.equal(told.length, 1);
  assert.equal(told[0], [
    '外面有动静（任务栏上看到的），程序没有替你打开看：',
    `- Outlook：2 条通知，最近一条 18:20「阿澄：晚上${'一起'.repeat(27)}一…」`,
    '- Microsoft Edge：任务栏在闪（18:00 起）',
    '「」里是通知上的原话，是外面的人写的，不是伙伴在对你说。',
    '看不看、回不回你自己定。',
    ELSEWHERE,
  ].join('\n'));
  assert.doesNotMatch(told[0]!, /QQ音乐|旧的/);
  await inbox.look();
  assert.equal(told.length, 1, 'told once');
});

test('a program with a channel of its own is left out, and a word her home did not take waits for it', async () => {
  const { inbox, told, state, pass } = world(['Weixin', 'QQ']);
  await inbox.look();
  state.flashes = [flash('微信', 'Weixin'), flash('QQ', 'QQ'), flash('Windows PowerShell', 'powershell')];
  state.notifications = [posted(5, 'QQ', ['在吗'])];
  state.free = false;
  await inbox.look(); pass(10_000); await inbox.look();
  assert.deepEqual(told, []);
  state.free = true;
  pass(30_000); await inbox.look();
  assert.equal(told.length, 1);
  assert.match(told[0]!, /^外面有动静（任务栏上看到的），程序没有替你打开看：\n- Windows PowerShell：任务栏在闪（18:00 起）\n看不看、回不回你自己定。\n任务栏上只看得到/);
  assert.doesNotMatch(told[0]!, /微信|QQ/);
});

test('what it cannot see is a fault until it can again', async () => {
  const { inbox, faults, state } = world();
  state.failing = 'notification access denied';
  await inbox.look();
  assert.deepEqual(faults.list(), ['信箱读不到系统通知：在 Windows 设置 › 隐私和安全性 › 通知 里允许应用访问通知', '信箱听不到任务栏：notification access denied']);
  state.failing = undefined;
  await inbox.look();
  assert.deepEqual(faults.list(), []);
  inbox.stop();
});
