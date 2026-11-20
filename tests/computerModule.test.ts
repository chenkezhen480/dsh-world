import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { Faults } from '../src/faults.ts';
import { createComputerModule, moduleLimits } from '../src/ecosystem/computer/index.ts';

test('the module offers her tools, keeps its tool list as she learns, and reports its state', async t => {
  const worldDir = mkdtempSync(join(tmpdir(), 'computer-module-')); t.after(() => rmSync(worldDir, { recursive: true, force: true }));
  const browser = { run: async () => '', scratch: async () => '', show: async () => {}, status: () => ({ state: 'stopped' as const, binary: 'msedge.exe' }), stop() {} };
  const module = createComputerModule({ worldDir, worldId: 'w', faults: new Faults(), store: { commitRecords: async () => {}, hasRecord: () => false }, archived: () => true, attachments: () => undefined, browser: browser as never });
  const agent = { id: 'home-1' } as unknown as Agent;
  const before = module.revision();
  assert.ok(module.tools(agent).some(tool => tool.name === 'computer_use'));
  assert.equal(await module.alarmFacts(), undefined);
  const save = module.tools(agent).find(tool => tool.name === 'procedure_save')!;
  await save.execute({ json: JSON.stringify({ name: '看看', category: 'web', description: '看看', params: {}, steps: [{ open: 'https://example.com/' }] }) } as never, { signal: new AbortController().signal } as never);
  assert.equal(module.revision(), before, 'learning something new does not change the tool list');
  assert.deepEqual(module.status(), {
    browser: { state: 'stopped', binary: 'msedge.exe' }, dir: join(worldDir, 'procedures'),
    categories: [{ name: 'web', guide: false, operations: [{ name: '看看', description: '看看', onAlarm: false, last: null }] }],
    desktop: null, inbox: null,
  });
});

test('two modules on the same files still have different revisions, so tools registered by an older one are replaced', async t => {
  const worldDir = mkdtempSync(join(tmpdir(), 'computer-module-')); t.after(() => rmSync(worldDir, { recursive: true, force: true }));
  const browser = { run: async () => '', scratch: async () => '', show: async () => {}, status: () => ({ state: 'stopped' as const, binary: null }), stop() {} };
  const make = () => createComputerModule({ worldDir, worldId: 'w', faults: new Faults(), store: { commitRecords: async () => {}, hasRecord: () => false }, archived: () => true, attachments: () => undefined, browser: browser as never });
  assert.notEqual(make().revision(), make().revision());
});

test('stopping clears the browser fault and the faults of her broken tool files', async t => {
  const worldDir = mkdtempSync(join(tmpdir(), 'computer-module-')); t.after(() => rmSync(worldDir, { recursive: true, force: true }));
  mkdirSync(join(worldDir, 'procedures'));
  writeFileSync(join(worldDir, 'procedures', 'broken.json'), '{not json');
  const faults = new Faults();
  const browser = { run: async () => '', scratch: async () => '', show: async () => {}, status: () => ({ state: 'stopped' as const, binary: null }), stop() {} };
  const module = createComputerModule({ worldDir, worldId: 'w', faults, store: { commitRecords: async () => {}, hasRecord: () => false }, archived: () => true, attachments: () => undefined, browser: browser as never });
  module.status();
  faults.set('computer', '她的浏览器没能打开：x');
  assert.ok(faults.list().some(line => line.includes('broken.json')));
  module.stop();
  assert.deepEqual(faults.list(), []);
});

test('what this machine cannot run is said once, for the console row and its refusal alike', () => {
  assert.deepEqual(moduleLimits('win32', () => 'C:\\Edge\\msedge.exe'), {});
  assert.deepEqual(moduleLimits('win32', () => undefined), { computer: '这台电脑上找不到 Edge 或 Chrome，她的浏览器要用其中一个。' });
  assert.deepEqual(moduleLimits('darwin', () => undefined), { computer: '这台电脑上找不到 Edge 或 Chrome，她的浏览器要用其中一个。', desktop: '她用电脑目前只支持 Windows。' });
});

test('her desktop switch adds and removes the desktop tool; on another system it is a fault, not a tool', async t => {
  const worldDir = mkdtempSync(join(tmpdir(), 'computer-module-')); t.after(() => rmSync(worldDir, { recursive: true, force: true }));
  const browser = { run: async () => '', scratch: async () => '', show: async () => {}, status: () => ({ state: 'stopped' as const, binary: null }), stop() {} };
  let stopped = 0;
  const driver = { call: async () => ({}), running: () => false, stop: () => { stopped++; } };
  const faults = new Faults();
  const make = (platform: NodeJS.Platform) => createComputerModule({ worldDir, worldId: 'w', faults, store: { commitRecords: async () => {}, hasRecord: () => false }, archived: () => true, attachments: () => undefined, browser: browser as never, platform, desktopDriver: () => driver });
  const agent = { id: 'home-1' } as unknown as Agent;
  const module = make('win32');
  const before = module.revision();
  assert.equal(module.tools(agent).some(tool => tool.name === 'desktop'), false, 'off by default');
  module.setDesktop(true);
  assert.notEqual(module.revision(), before, 'the tool list changes, so the registry re-registers');
  assert.equal(module.tools(agent).filter(tool => tool.name === 'desktop').length, 1);
  assert.deepEqual(module.status().desktop, { running: false, foreground: false, recent: [] });
  module.setDesktop(false);
  assert.equal(stopped, 1);
  assert.equal(module.revision(), before);
  assert.equal(module.status().desktop, null);
  const elsewhere = make('linux');
  elsewhere.setDesktop(true);
  assert.equal(elsewhere.tools(agent).some(tool => tool.name === 'desktop'), false);
  assert.deepEqual(faults.list(), ['她用电脑目前只支持 Windows']);
  elsewhere.stop();
  assert.deepEqual(faults.list(), []);
});

test('her inbox goes on and off with her use of the computer, with a helper of its own, and only on Windows', async t => {
  const worldDir = mkdtempSync(join(tmpdir(), 'computer-module-')); t.after(() => rmSync(worldDir, { recursive: true, force: true }));
  const browser = { run: async () => '', scratch: async () => '', show: async () => {}, status: () => ({ state: 'stopped' as const, binary: null }), stop() {} };
  const faults = new Faults(), calls: string[] = [];
  let helpers = 0, stopped = 0;
  const helper = { call: async (op: string) => { calls.push(op); return op === 'flashes' ? { flashes: [] } : { notifications: [] }; }, running: () => false, stop: () => { stopped++; } };
  const make = (platform: NodeJS.Platform) => createComputerModule({ worldDir, worldId: 'w', faults, store: { commitRecords: async () => {}, hasRecord: () => false }, archived: () => true, attachments: () => undefined, browser: browser as never, platform,
    desktopDriver: () => ({ call: async () => ({}), running: () => false, stop() {} }),
    inbox: { timeZone: 'Asia/Shanghai', tell: async () => true, ignore: () => [], helper: () => { helpers++; return helper; }, pollMs: 10 } });
  const module = make('win32');
  assert.equal(module.status().inbox, null, 'her computer is off: nothing is watched');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual([helpers, calls.length], [0, 0]);
  module.setDesktop(true);
  assert.deepEqual(module.status().inbox, { waiting: [], told: [] });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual([calls.includes('notifications'), calls.includes('flashes')], [true, true]);
  module.setDesktop(false);
  assert.deepEqual([module.status().inbox, stopped], [null, 1], 'turning her computer off stops the inbox and its helper');
  module.setDesktop(true); module.stop();
  assert.deepEqual([helpers, stopped], [2, 2]);
  const elsewhere = make('linux');
  elsewhere.setDesktop(true);
  assert.deepEqual([elsewhere.status().inbox, faults.list()], [null, ['她用电脑目前只支持 Windows']]);
  elsewhere.stop();
  assert.deepEqual(faults.list(), []);
});
