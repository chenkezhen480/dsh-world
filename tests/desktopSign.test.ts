// tests/desktopSign.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { Faults } from '../src/faults.ts';
import { createDesktop, STOPPED } from '../src/ecosystem/computer/desktop/desktop.ts';
import { createComputerModule } from '../src/ecosystem/computer/index.ts';

type Args = Record<string, unknown>;
const WECHAT = { hwnd: 67996, owner: 0, pid: 14568, exe: 'Weixin', title: '微信', minimized: false, width: 1750, height: 1400 };

/** The helper: every call is kept; a click can be held open, so the partner can press stop while it is under way. */
function helper(options: { signFails?: boolean } = {}) {
  const calls: [string, Args][] = [];
  let release: (() => void) | undefined, picture = 0;
  const call = async (op: string, args: Args = {}) => {
    calls.push([op, args]);
    if (op === 'windows') return { windows: [WECHAT], foreground: 1 };
    if (op === 'sign' && options.signFails) throw new Error('the sign could not be drawn');
    if (op === 'click' && args.hold) await new Promise<void>(resolve => { release = resolve; });
    if (op === 'sheet') { writeFileSync(String(args.file), 'sheet'); return { width: 1, height: 1 }; }
    if (op === 'shot') { writeFileSync(String(args.file), 'png'); picture += 9; return { width: 1280, height: 1024, clientWidth: 1600, clientHeight: 1280, print: (picture % 250).toString(16).padStart(2, '0').repeat(256) }; }
    return {};
  };
  return { calls, call, signs: () => calls.filter(([op]) => op === 'sign').map(([, args]) => args), keys: () => calls.filter(([op]) => op === 'key').length, letGo: () => release?.() };
}
function setup(options: { signFails?: boolean; secondMs?: number } = {}) {
  const h = helper(options), faults: (string | undefined)[] = [];
  let holdNext = false;
  const driver = { call: (op: string, args: Args = {}) => h.call(op, op === 'click' && holdNext ? { ...args, hold: (holdNext = false, true) } : args) };
  const desktop = createDesktop({ driver, running: async () => false, settleMs: 0, appearMs: 50, secondMs: options.secondMs ?? 2, lingerMs: 30, companion: () => '鲸鲸', signFault: text => faults.push(text) });
  return { ...h, desktop, faults, hold: () => { holdNext = true; } };
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('while she acts the partner sees the program\'s own words over the window she is on, gone a moment after she stops', async () => {
  const s = setup();
  await s.desktop.act({ action: 'open', app: '一个她随便写的名字 微信' }).catch(() => {});
  await s.desktop.act({ action: 'open', app: '微信' });
  await s.desktop.act({ action: 'click', x: 10, y: 10 });
  const shown = s.signs().filter(args => args.show);
  assert.ok(shown.length >= 2);
  for (const args of shown) assert.deepEqual(args, { show: true, hwnd: WECHAT.hwnd, text: '鲸鲸正在操作', hint: '连按两下 Esc 停下', stop: '停下', stopped: '已停下' }, 'her words never reach the banner');
  await pause(60);
  assert.deepEqual(s.signs().at(-1), { show: false });
  const before = s.signs().length;
  await s.desktop.act({ action: 'record', seconds: 3 });
  await s.desktop.act({ action: 'review' });
  assert.ok(s.signs().slice(before).every(args => args.show), 'looking at what was recorded is not acting');
});

test('a banner that cannot be drawn is a fault for the console, never a failed action of hers', async () => {
  const s = setup({ signFails: true });
  await s.desktop.act({ action: 'open', app: '微信' });
  assert.equal((await s.desktop.act({ action: 'shot' })).image?.mediaType, 'image/png');
  assert.match(String(s.faults.at(-1)), /^她操作时的提示没能显示：the sign could not be drawn$/);
});

test('the partner\'s stop cuts off the step under way and every later one until they speak to her; what was recorded can still be looked at', async () => {
  const s = setup();
  await s.desktop.act({ action: 'open', app: '微信' });
  await s.desktop.act({ action: 'record', seconds: 2 });
  s.hold();
  const step = s.desktop.act({ action: 'click', x: 10, y: 10 });
  await pause(10);
  assert.deepEqual(s.desktop.halt(), { cut: true, recording: false });
  s.letGo();
  await assert.rejects(step, new Error(STOPPED));
  await assert.rejects(s.desktop.act({ action: 'shot' }), new Error(STOPPED));
  await assert.rejects(s.desktop.act({ action: 'open', app: '微信' }), new Error(STOPPED));
  assert.match((await s.desktop.act({ action: 'review' })).text, /录了 2s/);
  s.desktop.release();
  assert.equal((await s.desktop.act({ action: 'shot' })).image?.mediaType, 'image/png');
});

test('a recording the partner stops ends there, and nothing more is sent to the window, not even the pause', async () => {
  // Long enough (a minute of fake seconds) that a busy machine cannot let it end before the stop.
  const s = setup({ secondMs: 200 });
  await s.desktop.act({ action: 'open', app: '微信' });
  await s.desktop.act({ action: 'record', seconds: 300 });
  await pause(20);
  assert.deepEqual(s.desktop.halt(), { cut: false, recording: true });
  await pause(30);
  assert.equal(s.keys(), 0, 'no space bar after the partner said stop');
  assert.match((await s.desktop.act({ action: 'review' })).text, /录了 \d+s、\d+ 帧/);
});

test('the module tells her of a stop that cut off no step of hers, and lets her go on once the partner speaks', async t => {
  const worldDir = mkdtempSync(join(tmpdir(), 'computer-sign-')); t.after(() => rmSync(worldDir, { recursive: true, force: true }));
  const browser = { run: async () => '', scratch: async () => '', show: async () => {}, status: () => ({ state: 'stopped' as const, binary: null }), stop() {} };
  const h = helper(), told: string[] = [];
  let events: ((name: string) => void) | undefined;
  const module = createComputerModule({ worldDir, worldId: 'w', faults: new Faults(), store: { commitRecords: async () => {}, hasRecord: () => false }, archived: () => true, attachments: () => undefined, browser: browser as never, platform: 'win32',
    desktopDriver: listen => { events = listen; return { call: h.call, running: () => false, stop() {} }; }, companion: () => '鲸鲸', notice: text => told.push(text) });
  module.setDesktop(true);
  const desktop = module.tools({ id: 'home-1' } as unknown as Agent).find(tool => tool.name === 'desktop')!;
  const act = (input: object) => Promise.resolve(desktop.execute(input as never, { signal: new AbortController().signal, deferContext: () => {} } as never));
  await act({ action: 'open', app: '微信' });
  events!('stop');
  assert.deepEqual(told, ['（伙伴刚才按了停下：在伙伴再跟你说话之前，不能再操作伙伴的电脑。先问问伙伴。）']);
  await assert.rejects(act({ action: 'shot' }), new Error(STOPPED));
  module.partnerSpoke();
  assert.match(String(await act({ action: 'shot' })), /截图/);
  events!('something else');
  assert.equal(told.length, 1);
  module.stop();
});
