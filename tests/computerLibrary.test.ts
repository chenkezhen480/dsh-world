// tests/computerLibrary.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Faults } from '../src/faults.ts';
import { createProcedureLibrary } from '../src/ecosystem/computer/procedures/library.ts';

const tool = (description: string, extra: object = {}) => JSON.stringify({ name: '发送消息', category: 'wechat', description, params: {}, steps: [{ open: 'https://example.com/' }], ...extra });
const scratch = (t: test.TestContext) => { const dir = join(mkdtempSync(join(tmpdir(), 'computer-lib-')), 'procedures'); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

test('saving puts an operation in its category folder and keeps what it replaces', t => {
  const dir = scratch(t);
  const library = createProcedureLibrary(dir, { faults: new Faults() });
  assert.deepEqual(library.list(), []);
  assert.deepEqual(library.save(tool('第一版')), { procedure: library.get('wechat/发送消息'), path: 'wechat/发送消息', version: 1 });
  assert.equal(library.save(tool('第二版')).version, 2);
  assert.equal(JSON.parse(readFileSync(join(dir, 'wechat', '发送消息.v1.json'), 'utf8')).description, '第一版');
  assert.equal(library.get('wechat/发送消息')?.description, '第二版');
  assert.deepEqual(library.list().map(entry => entry.path), ['wechat/发送消息'], 'old versions are not operations');
  assert.throws(() => library.save('{"name":"x"'), /JSON 格式不对/);
  assert.equal(library.get('wechat/发送消息')?.description, '第二版', 'a refused save changes nothing');
});

test('files the development build left flat are read in place as 未分类 and never moved', t => {
  const dir = scratch(t);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bili_unread.json'), JSON.stringify({ name: 'bili_unread', description: '旧的', params: {}, steps: [{ open: 'https://e.com/' }] }));
  writeFileSync(join(dir, 'bili_unread.v1.json'), JSON.stringify({ name: 'bili_unread', description: '更旧', params: {}, steps: [{ open: 'https://e.com/v1' }] }));
  const library = createProcedureLibrary(dir);
  assert.deepEqual(library.list().map(entry => entry.path), ['未分类/bili_unread']);
  assert.deepEqual(library.kept('未分类/bili_unread').map(({ version, procedure }) => [version, procedure.description]), [[1, '更旧']]);
  assert.ok(existsSync(join(dir, 'bili_unread.json')));
  library.save(JSON.stringify({ name: 'bili_unread', category: '未分类', description: '新的', params: {}, steps: [{ open: 'https://e.com/' }] }));
  assert.equal(library.get('未分类/bili_unread')?.description, '新的', 'a saved one in the folder wins over the flat file');
  assert.ok(existsSync(join(dir, 'bili_unread.json')), 'the flat file stays where it was');
});

test('a broken file is a fault, a file in the wrong folder or under the wrong name too; an edit by hand is picked up', t => {
  const dir = scratch(t);
  const faults = new Faults();
  const library = createProcedureLibrary(dir, { faults });
  mkdirSync(join(dir, 'wechat'), { recursive: true });
  writeFileSync(join(dir, 'wechat', 'broken.json'), '{');
  writeFileSync(join(dir, 'wechat', '别的名字.json'), tool('名字不对'));
  writeFileSync(join(dir, 'wechat', '发送消息.json'), tool('分类不对', { category: 'bilibili' }));
  assert.deepEqual(library.list(), []);
  const listed = faults.list().join('\n');
  assert.match(listed, /她的操作 wechat\/broken\.json 没能载入/);
  assert.match(listed, /wechat\/别的名字\.json.*文件名应该是 发送消息\.json/);
  assert.match(listed, /wechat\/发送消息\.json.*分类应该是 wechat/);
  writeFileSync(join(dir, 'wechat', '发送消息.json'), tool('改好了')); utimesSync(join(dir, 'wechat', '发送消息.json'), new Date(), new Date(Date.now() + 5000));
  assert.equal(library.get('wechat/发送消息')?.description, '改好了');
  rmSync(join(dir, 'wechat', 'broken.json')); rmSync(join(dir, 'wechat', '别的名字.json')); library.list();
  assert.deepEqual(faults.list(), []);
});

test('kept versions come newest first, without repeats or files that no longer parse; numbering never overwrites one', t => {
  const dir = scratch(t);
  const library = createProcedureLibrary(dir);
  assert.deepEqual(library.kept('wechat/发送消息'), []);
  for (const description of ['一', '二', '二', '三']) library.save(tool(description));
  writeFileSync(join(dir, 'wechat', '发送消息.v9.json'), '{"name":');
  assert.deepEqual(library.kept('wechat/发送消息').map(({ procedure, version }) => [version, procedure.description]), [[3, '二']], 'a repeat adds nothing');
  assert.equal(library.save(tool('二')).version, 11);
  assert.deepEqual(library.kept('wechat/发送消息').map(({ version }) => version), [10]);
});

test('a save keeps the two newest of what it replaced and removes the older ones of that name only', t => {
  const dir = scratch(t);
  const library = createProcedureLibrary(dir);
  const versions = (folder: string, start: string) => readdirSync(join(dir, folder)).filter(name => name.startsWith(`${start}.v`)).sort();
  library.save(tool('别的', { name: '别的操作' }));
  for (const description of ['一', '二', '三']) library.save(tool(description));
  library.save(tool('别的二', { name: '别的操作' }));
  assert.deepEqual(versions('wechat', '发送消息'), ['发送消息.v1.json', '发送消息.v2.json'], 'two kept: nothing to remove yet');
  for (const description of ['四', '五']) library.save(tool(description));
  assert.deepEqual(versions('wechat', '发送消息'), ['发送消息.v3.json', '发送消息.v4.json']);
  assert.deepEqual(library.kept('wechat/发送消息').map(({ procedure }) => procedure.description), ['四', '三']);
  assert.deepEqual(versions('wechat', '别的操作'), ['别的操作.v1.json'], 'another operation is not touched');
  for (const text of ['甲', '乙', '丙', '丁']) library.saveGuide('wechat', text);
  assert.deepEqual(versions('wechat', '目录'), ['目录.v2.md', '目录.v3.md'], 'her notes are kept the same way');
});

test('her category notes are hers: written only when she saves, the old one kept', t => {
  const dir = scratch(t);
  const library = createProcedureLibrary(dir);
  library.save(tool('一'));
  assert.deepEqual(library.categories(), [{ name: 'wechat', guide: '' }]);
  assert.equal(library.saveGuide('wechat', '微信要从任务栏点开'), 1);
  assert.equal(library.saveGuide('wechat', '程序：Weixin.exe'), 2);
  assert.equal(readFileSync(join(dir, 'wechat', '目录.v1.md'), 'utf8'), '微信要从任务栏点开');
  assert.deepEqual(library.categories(), [{ name: 'wechat', guide: '程序：Weixin.exe' }]);
  library.saveGuide('bilibili', 'B站');
  assert.deepEqual(library.categories().map(category => category.name), ['bilibili', 'wechat'], 'a category may have a note before any operation');
  assert.throws(() => library.saveGuide('../x', 'a'), /category：/);
  assert.throws(() => library.saveGuide('wechat', ''), /说明/);
  assert.throws(() => library.saveGuide('wechat', 'x'.repeat(1001)), /说明/);
});

test('runs are noted by path for the catalog and the console', t => {
  const dir = scratch(t);
  const library = createProcedureLibrary(dir);
  library.note('wechat/发送消息', false, '第 3 步找不到');
  assert.equal(library.lastRun('wechat/发送消息')?.ok, false);
  assert.equal(library.lastRun('wechat/别的'), undefined);
  assert.equal(existsSync(join(dir, 'wechat')), false);
});
