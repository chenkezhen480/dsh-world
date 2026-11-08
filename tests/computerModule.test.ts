import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { Faults } from '../src/faults.ts';
import { createComputerModule } from '../src/ecosystem/computer/index.ts';

test('the module offers her tools, follows her library, and reports its state', async t => {
  const worldDir = mkdtempSync(join(tmpdir(), 'computer-module-')); t.after(() => rmSync(worldDir, { recursive: true, force: true }));
  const browser = { run: async () => '', scratch: async () => '', show: async () => {}, status: () => ({ state: 'stopped' as const, binary: 'msedge.exe' }), stop() {} };
  const module = createComputerModule({ worldDir, worldId: 'w', faults: new Faults(), store: { commitRecords: async () => {}, hasRecord: () => false }, archived: () => true, attachments: () => undefined, browser: browser as never });
  const agent = { id: 'home-1' } as unknown as Agent;
  const before = module.revision();
  assert.ok(module.tools(agent).some(tool => tool.name === 'page_read'));
  assert.equal(await module.alarmFacts(), undefined);
  const save = module.tools(agent).find(tool => tool.name === 'procedure_save')!;
  await save.execute({ json: JSON.stringify({ name: 'look', description: '看看', params: {}, steps: [{ open: 'https://example.com/' }] }) } as never, { signal: new AbortController().signal } as never);
  assert.notEqual(module.revision(), before);
  assert.ok(module.tools(agent).some(tool => tool.name === 'my_look'));
  assert.deepEqual(module.status(), { browser: { state: 'stopped', binary: 'msedge.exe' }, dir: join(worldDir, 'procedures'), procedures: [{ name: 'look', description: '看看', onAlarm: false, last: null }] });
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
