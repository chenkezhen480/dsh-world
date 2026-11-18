// tests/desktop.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { createDesktop } from '../src/ecosystem/computer/desktop/desktop.ts';

type Args = Record<string, unknown>;
const WECHAT = { hwnd: 67996, pid: 14568, exe: 'Weixin', title: '微信', minimized: false, width: 1750, height: 1400 };
const TERMINAL = { hwnd: 500, pid: 9, exe: 'WindowsTerminal', title: 'Windows PowerShell', minimized: false, width: 2000, height: 1100 };
const START_MENU = [{ name: '微信', appId: 'D:\\微信\\Weixin\\Weixin.exe' }, { name: '记事本', appId: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App' }];

/** The Windows helper as it answered on the partner's computer: pictures are 1280 wide of a 1600-pixel client area. */
function fake(windows: typeof WECHAT[], overrides: Record<string, (args: Args) => Args> = {}) {
  const calls: [string, Args][] = [];
  const answers: Record<string, (args: Args) => Args> = {
    windows: () => ({ windows, foreground: TERMINAL.hwnd }),
    shot: args => { writeFileSync(String(args.file), 'png'); return { width: 1280, height: 1024, clientWidth: 1600, clientHeight: 1280 }; },
    cursor: () => ({ cursor: [10, 20] }),
    tray: () => ({ result: 'missing', cursor: [10, 20] }),
    apps: () => ({ apps: START_MENU }),
    refocus: () => ({ refocused: true }),
    restore: () => ({ restored: true }),
    ...overrides,
  };
  const driver = { call: async (op: string, args: Args = {}) => { calls.push([op, args]); return (answers[op] ?? (() => ({})))(args); } };
  return { calls, driver, ops: () => calls.map(([op]) => op) };
}
function setup(windows: typeof WECHAT[] = [TERMINAL, WECHAT], overrides: Record<string, (args: Args) => Args> = {}, running: string[] = []) {
  const f = fake(windows, overrides);
  return { ...f, desktop: createDesktop({ driver: f.driver, running: async exe => running.includes(exe), settleMs: 0, appearMs: 50 }) };
}

test('an open window is pictured; her pixels are mapped to the window and she sees the result', async () => {
  const s = setup();
  const opened = await s.desktop.act({ action: 'open', app: '微信' });
  assert.match(opened.text, /^微信 的截图附在下一条消息里（1280×1024）。按图上的像素用 desktop click 带 x、y/);
  assert.deepEqual(opened.image, { data: Buffer.from('png'), mediaType: 'image/png' });
  assert.equal(s.calls.find(([op]) => op === 'shot')![1].hwnd, WECHAT.hwnd);
  const clicked = await s.desktop.act({ action: 'click', x: 200, y: 400 });
  assert.deepEqual(s.calls.find(([op]) => op === 'click')![1], { hwnd: WECHAT.hwnd, x: 250, y: 500, right: false, count: 1, hold: 0 });
  assert.match(clicked.text, /^已点击。图上的红圈是刚才点到的地方，没点中就看偏了多少，改了再点。微信 的截图附在下一条消息里/);
  const marked = s.calls.filter(([op]) => op === 'shot').at(-1)![1];
  assert.deepEqual([marked.markX, marked.markY], [250, 500], 'the click is drawn where it landed, in window pixels');
  assert.equal(s.calls.find(([op]) => op === 'shot')![1].markX, -1, 'a plain picture has no mark');
  assert.ok(clicked.image, 'a fresh picture after every action');
  await s.desktop.act({ action: 'click', x: 1, y: 1, double: true, right: true });
  assert.deepEqual(s.calls.filter(([op]) => op === 'click')[1]![1], { hwnd: WECHAT.hwnd, x: 1, y: 1, right: true, count: 2, hold: 0 });
  // A long press holds the button down for so long, and she is told it was held.
  const held = await s.desktop.act({ action: 'click', x: 1, y: 1, hold: 1.5 });
  assert.equal(s.calls.filter(([op]) => op === 'click')[2]![1].hold, 1500);
  assert.match(held.text, /^已长按，按住 1.5 秒。/);
  const key = await s.desktop.act({ action: 'press', key: 'w', hold: 2 });
  assert.deepEqual(s.calls.filter(([op]) => op === 'key').at(-1)![1], { hwnd: WECHAT.hwnd, vk: 0x57, modifiers: [], hold: 2000 });
  assert.match(key.text, /^已按 w，按住 2 秒。/);
  const clicks = s.calls.filter(([op]) => op === 'click').length;
  await assert.rejects(s.desktop.act({ action: 'click', x: 1, y: 1, hold: 30 }), /hold 是按住的秒数，大于 0、最多 10/);
  await assert.rejects(s.desktop.act({ action: 'press', key: 'w', hold: 0 }), /hold 是按住的秒数/);
  assert.equal(s.calls.filter(([op]) => op === 'click').length, clicks, 'nothing pressed for a hold out of range');
  // A drag: pressed at one end (held first if asked), let go at the other, both mapped like a click; the mark is where it ended.
  const drag = await s.desktop.act({ action: 'drag', x: 200, y: 400, x2: 600, y2: 400, hold: 1 });
  assert.deepEqual(s.calls.find(([op]) => op === 'drag')![1], { hwnd: WECHAT.hwnd, x: 250, y: 500, x2: 750, y2: 500, right: false, hold: 1000 });
  assert.match(drag.text, /^已按住 1 秒再拖过去。/);
  assert.deepEqual([s.calls.filter(([op]) => op === 'shot').at(-1)![1].markX, s.calls.filter(([op]) => op === 'shot').at(-1)![1].markY], [750, 500]);
  await assert.rejects(s.desktop.act({ action: 'drag', x: 200, y: 400 }), /要给 x、y/, 'a drag needs where it ends');
  assert.equal(s.ops().includes('refocus'), false, 'nothing took the focus, so nothing is given back');
});

test('a panel the program opened beside its window is named after each picture, and opened by its title', async () => {
  const composer = { hwnd: 1903374, owner: WECHAT.hwnd, pid: WECHAT.pid, exe: 'Weixin', title: '朋友圈', minimized: false, width: 2000, height: 2000 };
  const s = setup([TERMINAL, composer, WECHAT]);
  const main = await s.desktop.act({ action: 'open', app: '微信' });
  assert.equal(s.calls.find(([op]) => op === 'shot')![1].hwnd, WECHAT.hwnd, 'the main window, though the panel is larger');
  assert.match(main.text, /\n微信 还开着别的窗口：「朋友圈」，不在这张截图里；要操作它就 desktop open 它的标题。$/);
  const panel = await s.desktop.act({ action: 'open', app: '朋友圈' });
  assert.equal(s.calls.filter(([op]) => op === 'shot').at(-1)![1].hwnd, composer.hwnd);
  assert.match(panel.text, /^朋友圈 的截图[^\n]*\n朋友圈 还开着别的窗口：「微信」/);
});

test('a window that opens or closes after her input is told, with how soon, so she knows a replay must wait for it', async () => {
  const windows = [TERMINAL, WECHAT];
  const picker = { hwnd: 777, owner: WECHAT.hwnd, pid: WECHAT.pid, exe: 'Weixin', title: '选择文件', minimized: false, width: 900, height: 700 };
  const s = setup(windows, { click: () => { windows.push(picker); return {}; } });
  assert.doesNotMatch((await s.desktop.act({ action: 'open', app: '微信' })).text, /窗口变了/, 'opening is not a change');
  const clicked = await s.desktop.act({ action: 'click', x: 10, y: 10 });
  assert.match(clicked.text, /\n窗口变了：出现了「选择文件」（在上一次点击之后 \d+\.\d 秒内）。窗口是过一会儿才变的；存成操作时，用到它的那一步前面要加 wait/);
  assert.doesNotMatch((await s.desktop.act({ action: 'shot' })).text, /窗口变了/, 'said once');
  windows.pop();
  assert.match((await s.desktop.act({ action: 'press', key: 'escape' })).text, /窗口变了：关掉了「选择文件」（在上一次按键之后/);
});

test('a point outside the picture is refused before the window is touched', async () => {
  const s = setup();
  await s.desktop.act({ action: 'open', app: '微信' });
  await assert.rejects(s.desktop.act({ action: 'click', x: 1300, y: 10 }), /要在截图里面（1280×1024）/);
  await assert.rejects(s.desktop.act({ action: 'click' }), /要给 x、y/);
  assert.equal(s.ops().includes('click'), false);
});

test('a minimized window is restored without taking the focus', async () => {
  const windows = [TERMINAL, { ...WECHAT, minimized: true }];
  const s = setup(windows, { restore: () => { windows[1] = WECHAT; return { restored: true }; } });
  const minimized = s.calls;
  const opened = await s.desktop.act({ action: 'open', app: 'weixin' });
  assert.deepEqual(minimized.find(([op]) => op === 'restore')![1], { hwnd: WECHAT.hwnd });
  assert.match(opened.text, /^它原来最小化着，已经还原，没有抢伙伴的焦点。\nweixin 的截图/);
});

test('a program closed to the tray is opened from its tray icon, and the focus goes back to the partner', async () => {
  const windows = [TERMINAL];
  const s = setup(windows, { tray: () => { windows.push(WECHAT); return { result: 'opened', cursor: [10, 20] }; } });
  const opened = await s.desktop.act({ action: 'open', app: '微信' });
  assert.deepEqual(s.calls.find(([op]) => op === 'tray')![1], { name: '微信' });
  assert.deepEqual(s.calls.find(([op]) => op === 'refocus')![1], { hwnd: TERMINAL.hwnd });
  assert.match(opened.text, /^它收在托盘里，已经从托盘图标点开；焦点还给了伙伴原来的窗口。\n微信 的截图/);
  assert.equal(s.ops().includes('launch'), false, 'never a second copy');
});

test('a program that takes the front again after the hand-back is handed back again, and a failure is said', async () => {
  const windows = [TERMINAL];
  let front = TERMINAL.hwnd, stolen = 1;
  const s = setup(windows, {
    windows: () => ({ windows, foreground: front }),
    tray: () => { windows.push(WECHAT); front = WECHAT.hwnd; return { result: 'opened', cursor: [10, 20] }; },
    // WeChat comes to the front once more right after the first hand-back.
    refocus: args => { front = stolen-- > 0 ? WECHAT.hwnd : Number(args.hwnd); return { refocused: true }; },
  });
  assert.match((await s.desktop.act({ action: 'open', app: '微信' })).text, /焦点还给了伙伴原来的窗口/);
  assert.equal(s.ops().filter(op => op === 'refocus').length, 2);
  const stubbornWindows = [TERMINAL];
  let stubbornFront = TERMINAL.hwnd;
  const stubborn = setup(stubbornWindows, {
    windows: () => ({ windows: stubbornWindows, foreground: stubbornFront }),
    tray: () => { stubbornWindows.push(WECHAT); stubbornFront = WECHAT.hwnd; return { result: 'opened', cursor: [10, 20] }; },
  });
  assert.match((await stubborn.desktop.act({ action: 'open', app: '微信' })).text, /焦点没能还给伙伴原来的窗口/);
  assert.equal(stubborn.ops().filter(op => op === 'refocus').length, 3);
});

test('a pointer that moved while the tray was clicked is said, since it may not be the partner', async () => {
  const windows = [TERMINAL];
  const s = setup(windows, { tray: () => { windows.push(WECHAT); return { result: 'opened', cursor: [900, 700] }; } });
  assert.match((await s.desktop.act({ action: 'open', app: '微信' })).text, /伙伴的鼠标位置变了/);
});

test('running with no window and no tray icon is never launched again', async () => {
  const s = setup([TERMINAL], {}, ['Weixin']);
  await assert.rejects(s.desktop.act({ action: 'open', app: '微信' }), /微信 开着，但没有窗口，托盘里也找不到它的图标；再启动会多开一个/);
  assert.equal(s.ops().includes('launch'), false);
});

test('a program that is not running is launched from the Start menu, and the focus goes back', async () => {
  const windows = [TERMINAL];
  const s = setup(windows, { launch: () => { windows.push(WECHAT); return {}; } });
  const opened = await s.desktop.act({ action: 'open', app: '微信' });
  assert.deepEqual(s.calls.find(([op]) => op === 'launch')![1], { appId: 'D:\\微信\\Weixin\\Weixin.exe' });
  assert.match(opened.text, /^微信 没开，已经启动；焦点还给了伙伴原来的窗口。\n/);
});

test('a name nobody has is said; without a name she sees what is open', async () => {
  const s = setup();
  await assert.rejects(s.desktop.act({ action: 'open', app: '画图' }), /找不到叫「画图」的程序：开着的窗口、托盘图标和开始菜单里都没有/);
  assert.equal((await s.desktop.act({ action: 'open' })).text, '开着的窗口：Windows PowerShell、微信。收在托盘里的、没开的，写它的名字也能打开。');
});

test('keys: names people write and combinations; anything else is refused before the window is touched', async () => {
  const s = setup();
  await s.desktop.act({ action: 'open', app: '微信' });
  await s.desktop.act({ action: 'press', key: 'Enter' });
  await s.desktop.act({ action: 'press', key: 'ctrl+f' });
  await s.desktop.act({ action: 'press', key: 'f5' });
  assert.deepEqual(s.calls.filter(([op]) => op === 'key').map(([, args]) => [args.vk, args.modifiers]), [[0x0d, []], [0x46, [0x11]], [0x74, []]]);
  await assert.rejects(s.desktop.act({ action: 'press', key: 'win+r' }), /不认识按键 win\+r/);
  await assert.rejects(s.desktop.act({ action: 'press', key: 'printscreen' }), /不认识按键/);
  assert.equal(s.calls.filter(([op]) => op === 'key').length, 3);
});

test('typing goes where she points first, then return if she submits', async () => {
  const s = setup();
  await s.desktop.act({ action: 'open', app: '微信' });
  const typed = await s.desktop.act({ action: 'type', x: 80, y: 40, text: '你好', submit: true });
  assert.deepEqual(s.calls.slice(-5).map(([op, args]) => [op, op === 'type' ? args.text : op === 'key' ? args.vk : op === 'click' ? [args.x, args.y] : '']), [['click', [100, 50]], ['type', '你好'], ['key', 0x0d], ['windows', ''], ['shot', '']]);
  assert.match(typed.text, /^已输入并回车。/);
  await assert.rejects(s.desktop.act({ action: 'type', text: '' }), /text 不能是空的/);
});

test('scrolling goes to the middle of the window unless she points', async () => {
  const s = setup();
  await s.desktop.act({ action: 'open', app: '微信' });
  await s.desktop.act({ action: 'scroll', direction: 'down' });
  assert.deepEqual(s.calls.find(([op]) => op === 'scroll')![1], { hwnd: WECHAT.hwnd, x: 800, y: 640, up: -3, right: 0 });
  await assert.rejects(s.desktop.act({ action: 'scroll', direction: 'sideways' }), /direction 只能是/);
});

test('a zoom is a part of the window at its own pixels, enlarged', async () => {
  const s = setup();
  await s.desktop.act({ action: 'open', app: '微信' });
  const zoomed = await s.desktop.act({ action: 'zoom', x: 100, y: 100, x2: 300, y2: 200 });
  const asked = s.calls.filter(([op]) => op === 'shot').at(-1)![1];
  assert.deepEqual([asked.x, asked.y, asked.w, asked.h, asked.grow], [125, 125, 250, 125, 4]);
  assert.match(zoomed.text, /不能直接点/);
  await assert.rejects(s.desktop.act({ action: 'zoom', x: 300, y: 100, x2: 100, y2: 200 }), /左上角/);
});

test('a window that went away is never pictured: she is told instead', async () => {
  const windows = [TERMINAL, WECHAT];
  const s = setup(windows);
  await s.desktop.act({ action: 'open', app: '微信' });
  windows.pop();
  const shots = s.calls.filter(([op]) => op === 'shot').length;
  await assert.rejects(s.desktop.act({ action: 'shot' }), /微信 的窗口不见了（关掉了、最小化了或收进了托盘）：先 desktop open 它/);
  await assert.rejects(s.desktop.act({ action: 'click', x: 1, y: 1 }), /还没有打开窗口/);
  assert.equal(s.calls.filter(([op]) => op === 'shot').length, shots);
});

test('a refusal from the helper is said as one; what she did is kept without what she typed', async () => {
  const s = setup(undefined, { click: () => { throw new Error('window 67996 is gone'); } });
  await assert.rejects(s.desktop.act({ action: 'shot' }), /还没有打开窗口/);
  await s.desktop.act({ action: 'open', app: '微信' });
  await assert.rejects(s.desktop.act({ action: 'click', x: 1, y: 1 }), /^Error: 没做成：window 67996 is gone$/);
  await s.desktop.act({ action: 'type', text: '秘密' });
  await assert.rejects(s.desktop.act({ action: 'fly' }), /不认识的 action：fly/);
  assert.deepEqual(s.desktop.recent().map(({ action, ok, app }) => [action, ok, app]), [['type', true, '微信'], ['click', false, '微信'], ['open', true, '微信'], ['shot', false, undefined]]);
  assert.doesNotMatch(JSON.stringify(s.desktop.recent()), /秘密/);
});

test('actions run one at a time, in order', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const s = setup();
  const slow = createDesktop({ driver: { call: async (op, args) => { if (op === 'click') await gate; return s.driver.call(op, args); } }, running: async () => false, settleMs: 0 });
  await slow.act({ action: 'open', app: '微信' });
  const first = slow.act({ action: 'click', x: 1, y: 1 });
  const second = slow.act({ action: 'press', key: 'tab' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(s.ops().includes('key'), false, 'the key waits for the click');
  release();
  await Promise.all([first, second]);
  assert.ok(s.ops().indexOf('click') < s.ops().indexOf('key'));
});
