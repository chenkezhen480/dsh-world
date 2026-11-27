// tests/desktopScreen.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { Faults } from '../src/faults.ts';
import { createScreen } from '../src/ecosystem/computer/desktop/screen.ts';
import { STOPPED } from '../src/ecosystem/computer/desktop/turns.ts';
import { createComputerModule } from '../src/ecosystem/computer/index.ts';

type Args = Record<string, unknown>;
const GAME = { hwnd: 656506, owner: 0, pid: 28624, exe: 'StarRail', title: '崩坏：星穹铁道', minimized: false, width: 2560, height: 1600 };

/** Two helpers: `hands` (administrator: pictures, real input, the sign) and `eyes` (ordinary: windows and starting programs). */
function helpers(windows = [GAME]) {
  const calls: [string, string, Args][] = [];
  let picture = 0, foreground = 1;
  const helper = (who: string) => ({ call: async (op: string, args: Args = {}) => {
    calls.push([who, op, args]);
    if (op === 'windows') return { windows, foreground };
    if (op === 'apps') return { apps: [{ name: '记事本', appId: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App' }] };
    if (op === 'tray') return { result: 'missing' };
    if (op === 'launch') { windows = [...windows, { hwnd: 77, owner: 0, pid: 7, exe: 'Notepad', title: '无标题 - 记事本', minimized: false, width: 800, height: 600 }]; return {}; }
    if (op === 'refocus') return { refocused: true };
    // A screen of 2560×1600 whose left edge is at -2560 (a second monitor on the left), pictured 1280 wide.
    if (op === 'screen') { writeFileSync(String(args.file), 'jpg'); picture += 7; return { width: 1280, height: 800, clientWidth: 2560, clientHeight: 1600, left: -2560, top: 0, print: (picture % 250).toString(16).padStart(2, '0').repeat(256) }; }
    if (op === 'sheet') { writeFileSync(String(args.file), 'sheet'); return { width: 1, height: 1 }; }
    return {};
  } });
  return { calls, hands: helper('hands'), eyes: helper('eyes'), by: (who: string) => calls.filter(([each]) => each === who).map(([, op, args]) => [op, args] as const), front: (hwnd: number) => { foreground = hwnd; } };
}

test('foreground mode sees the whole screen and acts with the real mouse and keyboard, at screen positions', async () => {
  const h = helpers();
  const screen = createScreen({ hands: h.hands, eyes: h.eyes, settleMs: 0, lingerMs: 20, companion: () => '鲸鲸' });
  await assert.rejects(screen.act({ action: 'click', x: 1, y: 1 }), /还没看过屏幕：先 desktop shot/);
  const shot = await screen.act({ action: 'shot' });
  assert.match(shot.text, /^整个屏幕的截图附在下一条消息里（1280×800）/);
  await screen.act({ action: 'click', x: 640, y: 400, double: true });
  assert.deepEqual(h.by('hands').find(([op]) => op === 'rclick')?.[1], { x: -1280, y: 800, right: false, count: 2, hold: 0 }, 'picture pixels doubled, from the screen\'s own left edge');
  assert.deepEqual(h.by('hands').filter(([op]) => op === 'screen').at(-1)?.[1].marks, [1280, 800], 'the red circle is drawn on the picture, not the screen');
  await screen.act({ action: 'type', text: '鲸鲸', submit: true });
  await screen.act({ action: 'press', key: 'ctrl+c' });
  await screen.act({ action: 'scroll', direction: 'down' });
  await screen.act({ action: 'click', x: 640, y: 400, right: true, hold: 1 });
  await screen.act({ action: 'press', key: 'w', hold: 3 });
  assert.match((await screen.act({ action: 'drag', x: 100, y: 100, x2: 300, y2: 200 })).text, /^已拖过去。/);
  const input = h.by('hands').filter(([op]) => op.startsWith('r')).map(([op, args]) => [op, args]);
  assert.deepEqual(input.slice(1), [['rtype', { text: '鲸鲸' }], ['rkey', { vk: 0x0d, modifiers: [] }], ['rkey', { vk: 0x43, modifiers: [0x11], hold: 0 }], ['rscroll', { x: -1280, y: 800, up: -3, right: 0 }],
    ['rclick', { x: -1280, y: 800, right: true, count: 1, hold: 1000 }], ['rkey', { vk: 0x57, modifiers: [], hold: 3000 }], ['rstroke', { xs: [-2360, -1960], ys: [200, 400], right: false, pause: 80, ms: 400 }]], 'a right button held for a second, w held for three, then a drag');
  assert.ok(h.by('eyes').every(([op]) => op === 'windows' || op === 'apps' || op === 'launch' || op === 'tray'), 'the ordinary helper never sends input');
  const signs = h.by('hands').filter(([op]) => op === 'sign').map(([, args]) => args);
  assert.deepEqual(signs[0], { show: true, hwnd: 0, text: '鲸鲸正在操作', hint: '连按两下 Esc 停下', stop: '停下', stopped: '已停下' }, 'the sign is over the whole screen');
});

test('a swipe goes with the real mouse through every point, pressed and moving at once, at screen positions', async () => {
  const h = helpers();
  const screen = createScreen({ hands: h.hands, eyes: h.eyes, settleMs: 0, lingerMs: 20 });
  await screen.act({ action: 'shot' });
  const swiped = await screen.act({ action: 'swipe', path: [[600, 100], [1000, 100], [600, 200], [1000, 200]], seconds: 2 });
  assert.match(swiped.text, /^已滑过去。图上的红线是刚才的路线/);
  assert.deepEqual(h.by('hands').find(([op]) => op === 'rstroke')?.[1], { xs: [-1360, -560, -1360, -560], ys: [200, 200, 400, 400], right: false, pause: 20, ms: 2000 }, 'an S across part of the screen, no long press first');
  assert.deepEqual(h.by('hands').filter(([op]) => op === 'screen').at(-1)?.[1].marks, [1200, 200, 2000, 200, 1200, 400, 2000, 400], 'the whole path is drawn, on the picture');
});

test('when another window took the front after she looked, nothing is sent and she is told which one (her clicks once landed in DSH)', async () => {
  const DSH = { ...GAME, hwnd: 990, pid: 1, exe: 'DeepSeek Harness', title: '鲸鲸的家 — DeepSeek Harness' };
  const h = helpers([GAME, DSH]);
  const screen = createScreen({ hands: h.hands, eyes: h.eyes, settleMs: 0, lingerMs: 20 });
  h.front(GAME.hwnd);
  await screen.act({ action: 'shot' });
  await screen.act({ action: 'click', x: 640, y: 400 });
  assert.equal(h.by('hands').filter(([op]) => op === 'rclick').length, 1, 'the game is still in front: the click goes');
  for (const input of [{ action: 'click', x: 640, y: 400 }, { action: 'swipe', path: [[1, 1], [9, 9]] }, { action: 'press', key: 'f' }]) {
    h.front(GAME.hwnd);
    await screen.act({ action: 'shot' });
    h.front(DSH.hwnd);
    await assert.rejects(screen.act(input), /最前面的窗口换成了「鲸鲸的家 — DeepSeek Harness」，刚才那张截图已经不是现在的样子，这一下没做。先 desktop shot/);
  }
  assert.equal(h.by('hands').filter(([op]) => op.startsWith('r')).length, 1, 'no input reached whatever took the front');
  await assert.rejects(screen.act({ action: 'click', x: 640, y: 400 }), /还没看过屏幕：先 desktop shot/, 'her old picture counts for nothing now');
  await screen.act({ action: 'shot' });
  await screen.act({ action: 'click', x: 640, y: 400 });
  assert.equal(h.by('hands').filter(([op]) => op === 'rclick').length, 2, 'having looked again, she acts on what is there now');
});

test('opening a program brings its window to the front, and one that is not running is started by the ordinary helper', async () => {
  const h = helpers();
  const screen = createScreen({ hands: h.hands, eyes: h.eyes, settleMs: 0, appearMs: 50 });
  assert.match((await screen.act({ action: 'open', app: '崩坏：星穹铁道' })).text, /^整个屏幕的截图/);
  assert.deepEqual(h.by('hands').find(([op]) => op === 'refocus')?.[1], { hwnd: GAME.hwnd });
  const opened = await screen.act({ action: 'open', app: '记事本' });
  assert.match(opened.text, /^记事本 没开，已经启动。\n整个屏幕的截图/);
  assert.deepEqual(h.by('eyes').find(([op]) => op === 'launch')?.[1], { appId: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App' }, 'never launched as administrator');
  assert.deepEqual(h.by('hands').filter(([op]) => op === 'refocus').at(-1)?.[1], { hwnd: 77 });
  await assert.rejects(screen.act({ action: 'open', app: '不存在的程序' }), /找不到叫「不存在的程序」的程序/);
});

test('the whole screen is recorded and reviewed the same way, and the partner\'s stop works the same', async () => {
  const h = helpers();
  const screen = createScreen({ hands: h.hands, eyes: h.eyes, settleMs: 0, secondMs: 2 });
  const recorded = await screen.act({ action: 'record', seconds: 4, pause: false });
  assert.match(recorded.text, /^录好了。屏幕 录了 4s、5 帧/);
  assert.equal(h.by('hands').filter(([op]) => op === 'screen').length, 5);
  await screen.act({ action: 'shot' });
  assert.deepEqual(screen.halt(), { cut: false, recording: false });
  await assert.rejects(screen.act({ action: 'click', x: 1, y: 1 }), new Error(STOPPED));
  assert.match((await screen.act({ action: 'review', at: 2 })).text, /第 2s 的那一帧/);
  screen.release();
  await screen.act({ action: 'click', x: 1, y: 1 });
});

test('the module turns foreground mode on only once the administrator helper is up, and her tool follows the mode', async t => {
  const worldDir = mkdtempSync(join(tmpdir(), 'computer-foreground-')); t.after(() => rmSync(worldDir, { recursive: true, force: true }));
  const browser = { run: async () => '', scratch: async () => '', show: async () => {}, status: () => ({ state: 'stopped' as const, binary: null }), stop() {} };
  const h = helpers();
  let refuse: string | undefined = '前台模式没有打开：伙伴没有同意管理员权限', stoppedForeground = 0;
  const module = createComputerModule({ worldDir, worldId: 'w', faults: new Faults(), store: { commitRecords: async () => {}, hasRecord: () => false }, archived: () => true, attachments: () => undefined, browser: browser as never, platform: 'win32',
    desktopDriver: () => ({ call: h.eyes.call, running: () => false, stop() {} }),
    foregroundDriver: () => ({ call: h.hands.call, running: () => true, stop: () => { stoppedForeground++; }, start: async () => { if (refuse) throw new Error(refuse); } }) });
  const description = () => module.tools({ id: 'home-1' } as unknown as Agent).find(tool => tool.name === 'desktop')?.description ?? '';
  assert.equal(await module.setForeground(true), '先打开「她用电脑」');
  module.setDesktop(true);
  const background = module.revision();
  assert.match(description(), /^用伙伴的电脑（后台模式）/);
  assert.equal(await module.setForeground(true), '前台模式没有打开：伙伴没有同意管理员权限');
  assert.equal(module.foregroundOn(), false);
  refuse = undefined;
  assert.equal(await module.setForeground(true), undefined);
  assert.equal(module.foregroundOn(), true);
  assert.notEqual(module.revision(), background, 'her tools are registered again');
  assert.match(description(), /^用伙伴的电脑（前台模式）：伙伴把电脑交给了我/);
  const catalog = () => Promise.resolve(module.tools({ id: 'home-1' } as unknown as Agent).find(tool => tool.name === 'computer_use')!.execute({} as never, {} as never)) as Promise<string>;
  assert.match(await catalog(), /^现在能用：page_\*（你自己的浏览器）、desktop（伙伴的电脑，前台模式：整个屏幕，真的鼠标键盘）、procedure_\*/);
  await module.setForeground(false);
  assert.match(await catalog(), /desktop（伙伴的电脑，后台模式：一个窗口，不动伙伴的鼠标）/);
  await module.setForeground(true);
  await module.setForeground(false);
  assert.deepEqual([module.foregroundOn(), stoppedForeground, module.revision()], [false, 3, background], 'off ends the administrator helper');
  await module.setForeground(true);
  module.setDesktop(false);
  assert.deepEqual([module.foregroundOn(), stoppedForeground], [false, 4], 'turning her use of the computer off ends foreground mode too');
  module.stop();
});
