// tests/computerLibrary.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Faults } from '../src/faults.ts';
import { createProcedureLibrary } from '../src/ecosystem/computer/procedures/library.ts';

const tool = (description: string) => JSON.stringify({ name: 'bili_unread', description, params: {}, steps: [{ open: 'https://message.bilibili.com/' }] });

test('saving checks the tool, keeps the old version, and moves the revision', t => {
  const dir = join(mkdtempSync(join(tmpdir(), 'computer-lib-')), 'procedures'); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const library = createProcedureLibrary(dir, { faults: new Faults() });
  const empty = library.revision();
  assert.deepEqual(library.list(), []);
  assert.equal(library.save(tool('第一版')).version, 1);
  const first = library.revision();
  assert.notEqual(first, empty);
  assert.equal(library.save(tool('第二版')).version, 2);
  assert.equal(JSON.parse(readFileSync(join(dir, 'bili_unread.v1.json'), 'utf8')).description, '第一版');
  assert.equal(library.get('bili_unread')?.description, '第二版');
  assert.equal(library.list().length, 1, 'old versions are not tools');
  assert.throws(() => library.save('{"name":"x"'), /JSON 格式不对/);
  assert.throws(() => library.save('{"name":"bili_unread","description":"d","steps":[]}'), /steps：/);
  assert.equal(library.get('bili_unread')?.description, '第二版', 'a refused save changes nothing');
});

test('a broken file is skipped as a fault, an edit by hand is picked up, a deleted file clears its fault', t => {
  const dir = mkdtempSync(join(tmpdir(), 'computer-lib-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const faults = new Faults();
  const library = createProcedureLibrary(dir, { faults });
  writeFileSync(join(dir, 'broken.json'), '{');
  writeFileSync(join(dir, 'bili_unread.json'), tool('手写'));
  assert.deepEqual(library.list().map(entry => entry.procedure.name), ['bili_unread']);
  assert.match(faults.list().join(), /她的工具 broken\.json 没能载入/);
  const before = library.revision();
  writeFileSync(join(dir, 'bili_unread.json'), tool('又改了')); utimesSync(join(dir, 'bili_unread.json'), new Date(), new Date(Date.now() + 5000));
  assert.notEqual(library.revision(), before);
  assert.equal(library.get('bili_unread')?.description, '又改了');
  rmSync(join(dir, 'broken.json')); library.list();
  assert.deepEqual(faults.list(), []);
});

test('runs are noted for the list and the console', t => {
  const dir = mkdtempSync(join(tmpdir(), 'computer-lib-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const library = createProcedureLibrary(dir);
  library.note('bili_unread', false, '第 3 步找不到');
  assert.equal(library.lastRun('bili_unread')?.ok, false);
  assert.equal(library.lastRun('other'), undefined);
  assert.equal(existsSync(join(dir, 'bili_unread.json')), false);
});

test('a save never overwrites a kept version, whatever the numbering', t => {
  const dir = mkdtempSync(join(tmpdir(), 'computer-lib-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const library = createProcedureLibrary(dir);
  writeFileSync(join(dir, 'bili_unread.json'), tool('现在'));
  writeFileSync(join(dir, 'bili_unread.v3.json'), tool('三'));
  writeFileSync(join(dir, 'bili_unread.vx.json'), 'hand-named');
  assert.equal(library.save(tool('新')).version, 5);
  assert.equal(JSON.parse(readFileSync(join(dir, 'bili_unread.v4.json'), 'utf8')).description, '现在');
  assert.equal(JSON.parse(readFileSync(join(dir, 'bili_unread.v3.json'), 'utf8')).description, '三');
});

test('a file whose name differs from its tool name is skipped with a fault', t => {
  const dir = mkdtempSync(join(tmpdir(), 'computer-lib-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const faults = new Faults();
  const library = createProcedureLibrary(dir, { faults });
  writeFileSync(join(dir, 'other_name.json'), tool('名字不对'));
  assert.deepEqual(library.list(), []);
  assert.match(faults.list().join(), /她的工具 other_name\.json 没能载入.*文件名应该是 bili_unread\.json/);
});

test('kept versions come newest first, without repeats or files that no longer parse', t => {
  const dir = mkdtempSync(join(tmpdir(), 'computer-lib-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const library = createProcedureLibrary(dir);
  assert.deepEqual(library.kept('bili_unread'), []);
  for (const description of ['一', '二', '二', '三']) library.save(tool(description));
  writeFileSync(join(dir, 'bili_unread.v9.json'), '{"name":');
  assert.deepEqual(library.kept('bili_unread').map(({ procedure, version }) => [version, procedure.description]), [[3, '二'], [1, '一']]);
  library.save(tool('二'));
  assert.deepEqual(library.kept('bili_unread').map(({ version }) => version), [10, 1], 'one the same as the newest adds nothing');
});
