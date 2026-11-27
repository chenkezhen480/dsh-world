// tests/desktopProcedure.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { parseProcedure } from '../src/ecosystem/computer/procedures/format.ts';
import { runProcedure } from '../src/ecosystem/computer/procedures/run.ts';
import { createProcedureLibrary } from '../src/ecosystem/computer/procedures/library.ts';
import { computerTools } from '../src/ecosystem/computer/tools.ts';
import type { DesktopInput } from '../src/ecosystem/computer/desktop/input.ts';

const POST = {
  name: '发朋友圈', category: 'wechat', description: '在微信里发一条只有文字的朋友圈', where: 'desktop',
  params: { text: { type: 'string', required: true } },
  steps: [
    { open: '微信' }, { click: { x: 39, y: 470 } }, { wait: { seconds: 0.01 } }, { open: '朋友圈' },
    { type: { text: '{{text}}', x: 300, y: 150 } }, { press: 'ctrl+a' }, { scroll: { direction: 'down' } },
    { click: { x: 253, y: 878 }, outward: true },
  ],
};
const picture = { data: Buffer.from('png'), mediaType: 'image/png' as const };
function hands(fail?: (input: DesktopInput) => string | undefined) {
  const done: DesktopInput[] = [];
  return { done, act: async (input: DesktopInput) => { const why = fail?.(input); if (why) throw new Error(why); done.push(input); return { text: 'ok', image: picture }; } };
}

test('a desktop operation is saved with its own steps, and what does not belong there is refused', () => {
  const parsed = parseProcedure(POST);
  assert.equal(parsed.where, 'desktop');
  assert.deepEqual(parsed.steps.at(-1), { click: { x: 253, y: 878 }, outward: true });
  const refused = (change: object, why: RegExp) => assert.throws(() => parseProcedure({ ...POST, ...change }), why);
  refused({ onAlarm: true }, /onAlarm：桌面上的操作不能用/);
  refused({ where: 'web' }, /where：只能是 desktop/);
  refused({ steps: [{ extract: { list: { css: '.a' }, fields: { a: { css: '.b' } } } }] }, /每一步只能有一个动作（open、click、drag、swipe、type、press、scroll、wait）/);
  refused({ steps: [{ press: 'win+r' }] }, /steps\[0\]\.press：不认识按键 win\+r/);
  refused({ steps: [{ type: { text: 'x', x: 3 } }] }, /steps\[0\]\.type\.y：应该是截图上的像素/);
  refused({ steps: [{ click: { x: 1, y: 2, anchor: 'a' } }] }, /不认识 anchor/);
  refused({ steps: [{ wait: { text: '好了' } }] }, /不认识 text/);
  refused({ steps: [{ open: '{{who}}' }] }, /\{\{who\}\} 不是已声明的参数/);
  assert.equal(parseProcedure({ ...POST, where: undefined, steps: [{ open: 'https://a.cn/' }] }).where, undefined, 'a page operation is as before');
});

test('a desktop operation replays through her hands, with her arguments filled in', async () => {
  const h = hands();
  const result = await runProcedure(parseProcedure(POST), { text: '扒' }, h);
  assert.deepEqual(result, { ok: true, rows: [], values: {} });
  assert.deepEqual(h.done, [
    { action: 'open', app: '微信' }, { action: 'click', x: 39, y: 470 }, { action: 'open', app: '朋友圈' },
    { action: 'type', text: '扒', x: 300, y: 150 }, { action: 'press', key: 'ctrl+a' }, { action: 'scroll', direction: 'down' },
    { action: 'click', x: 253, y: 878 },
  ]);
});

test('a desktop step that fails stops the run and says whether something may have gone out', async () => {
  const early = await runProcedure(parseProcedure(POST), { text: '扒' }, hands(input => input.app === '朋友圈' ? '找不到叫「朋友圈」的程序' : undefined));
  assert.deepEqual(early.ok ? null : [early.step, early.action, early.outwardDone], [4, '打开 朋友圈', false]);
  const late = await runProcedure(parseProcedure(POST), { text: '扒' }, hands(input => input.x === 253 ? '没做成：window is gone' : undefined));
  assert.deepEqual(late.ok ? null : [late.step, late.action, late.outwardDone], [8, '点（253, 878）', true]);
  await assert.rejects(runProcedure(parseProcedure(POST), { text: '扒' }, { open: async () => {} } as never), /是伙伴电脑上的操作，要在「她用电脑」里跑/);
});

// Her first saved desktop operation, as she wrote it: no pause before the windows a click opens, nothing marked outward.
const HERS = { ...POST, steps: [{ open: '微信' }, { click: { x: 1171, y: 73 } }, { open: '选择文件' }, { type: { text: 'a.png', x: 628, y: 705 } }, { press: 'return' }, { open: '朋友圈' }, { click: { x: 254, y: 848 } }] };

test('saving tells her where a replay would not wait and what may go out unmarked; a replay that hits it says so', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-procedure-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const library = createProcedureLibrary(dir);
  const save = computerTools({ agent: { id: 'home-1' } as unknown as Agent, browser: { run: async () => '' } as never, library, recorder: { record: async () => ({ written: 0, skipped: 0, outOfScope: false }) }, attachments: () => undefined }).find(tool => tool.name === 'procedure_save')!;
  const said = await save.execute({ json: JSON.stringify(HERS) } as never, {} as never) as string;
  assert.match(said, /^已保存 wechat\/发朋友圈（第 1 版），可以用 procedure_run 跑了。\n先看看这几处：\n/);
  assert.match(said, /- 第 3 步 open「选择文件」紧跟在上一步后面，回放时中间不停/);
  assert.match(said, /- 第 6 步 open「朋友圈」/);
  assert.match(said, /- 没有一步标 outward/);
  assert.doesNotMatch(await save.execute({ json: JSON.stringify(POST) } as never, {} as never) as string, /先看看/, 'nothing to say about a careful one');
  const failed = await runProcedure(parseProcedure(HERS), { text: 'x' }, hands(input => input.app === '选择文件' ? '找不到叫「选择文件」的程序' : undefined));
  assert.match(failed.ok ? '' : failed.error, /找不到叫「选择文件」的程序（回放时步与步之间不停，可能是窗口还没出来；在这一步前面加 wait）$/);
});

test('procedure_run replays a desktop operation and hands her the picture it ended on', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-procedure-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const library = createProcedureLibrary(dir);
  library.save(JSON.stringify(POST));
  const saved: unknown[] = [], deferred: unknown[] = [];
  const store = { saveImages: async (images: unknown[]) => { saved.push(...images); return [{ id: 'a1' }]; } };
  const context = { signal: new AbortController().signal, deferContext: (message: unknown) => { deferred.push(message); } } as never;
  const make = (desktop?: ReturnType<typeof hands>) => computerTools({ agent: { id: 'home-1' } as unknown as Agent, browser: { run: async () => { throw new Error('the browser is not used'); } }, library, recorder: { record: async () => ({ written: 0, skipped: 0, outOfScope: false }) }, attachments: () => store as never, ...(desktop ? { desktop } : {}) }).find(tool => tool.name === 'procedure_run')!;
  const text = await make(hands()).execute({ path: 'wechat/发朋友圈', args: { text: '扒' } } as never, context);
  assert.equal(text, '做完了。\n最后一张截图附在下一条消息里，看看做成了没有。');
  assert.equal(saved.length, 1);
  assert.match(JSON.stringify(deferred), /这是操作跑完时伙伴电脑上当前窗口的截图/);
  await assert.rejects(make().execute({ path: 'wechat/发朋友圈', args: { text: '扒' } } as never, context), /要先打开「她用电脑」/);
});

// Daily rewards in a game that only foreground mode can reach: a long press, a drag, a key held.
const DAILY = {
  name: '每日奖励', category: 'starrail', description: '领列车补给和每日实训', where: 'screen', params: {},
  steps: [{ open: '崩坏：星穹铁道' }, { click: { x: 640, y: 752, hold: 1 } }, { drag: { x: 300, y: 500, x2: 700, y2: 500, hold: 0.5 } }, { swipe: { path: [[860, 160], [1080, 160], [860, 330], [1080, 330]] } }, { press: 'w', hold: 2 }, { press: 'escape' }],
};

test('an operation found on the whole screen is saved with long presses, drags and swipes, and replays on a fresh picture of the screen', async () => {
  const procedure = parseProcedure(DAILY);
  assert.equal(procedure.where, 'screen');
  const h = hands();
  assert.deepEqual(await runProcedure(procedure, {}, h), { ok: true, rows: [], values: {} });
  assert.deepEqual(h.done, [
    { action: 'shot' }, { action: 'open', app: '崩坏：星穹铁道' }, { action: 'click', x: 640, y: 752, hold: 1 },
    { action: 'drag', x: 300, y: 500, x2: 700, y2: 500, hold: 0.5 }, { action: 'swipe', path: [[860, 160], [1080, 160], [860, 330], [1080, 330]] },
    { action: 'press', key: 'w', hold: 2 }, { action: 'press', key: 'escape' },
  ], 'measured on a picture of this screen first');
  assert.throws(() => parseProcedure({ ...DAILY, steps: [{ swipe: { path: [[1, 1]] } }] }), /steps\[0\]\.swipe\.path.*2 到 20 个/);
  assert.throws(() => parseProcedure({ ...DAILY, steps: [{ swipe: { path: [[1, 1], [2, 2]], seconds: 30 } }] }), /steps\[0\]\.swipe\.seconds/);
  assert.throws(() => parseProcedure({ ...DAILY, steps: [{ press: 'w', hold: 30 }] }), /steps\[0\]\.hold.*最多 10/);
  assert.throws(() => parseProcedure({ ...DAILY, steps: [{ drag: { x: 1, y: 1 } }] }), /steps\[0\]\.drag\.x2/);
  assert.throws(() => parseProcedure({ ...DAILY, where: 'phone' }), /只能是 desktop（后台模式走通的）或 screen（前台模式走通的）/);
});

test('procedure_run replays a whole-screen operation only in foreground mode, and says how to get there', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'screen-procedure-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const library = createProcedureLibrary(dir);
  library.save(JSON.stringify(DAILY));
  const store = { saveImages: async () => [{ id: 'a1' }] };
  const context = { signal: new AbortController().signal, deferContext: () => {} } as never;
  const make = (live: { desktop?: ReturnType<typeof hands>; screen?: ReturnType<typeof hands> }) => computerTools({ agent: { id: 'home-1' } as unknown as Agent, browser: { run: async () => { throw new Error('the browser is not used'); } }, library, recorder: { record: async () => ({ written: 0, skipped: 0, outOfScope: false }) }, attachments: () => store as never, ...live }).find(tool => tool.name === 'procedure_run')!;
  const background = hands();
  await assert.rejects(make({ desktop: background }).execute({ path: 'starrail/每日奖励', args: {} } as never, context), /前台模式），要请伙伴把「她用电脑」切到「前台」/);
  assert.equal(background.done.length, 0, 'background mode never tries it');
  const screen = hands(), window = hands(), deferred: unknown[] = [];
  const watched = { signal: new AbortController().signal, deferContext: (message: unknown) => { deferred.push(message); } } as never;
  assert.match(String(await make({ desktop: window, screen }).execute({ path: 'starrail/每日奖励', args: {} } as never, watched)), /^做完了。/);
  assert.equal(screen.done.length, 7); assert.equal(window.done.length, 0);
  assert.match(JSON.stringify(deferred), /这是操作跑完时伙伴电脑整个屏幕的截图/, 'the last picture is said to be of the whole screen');
});
