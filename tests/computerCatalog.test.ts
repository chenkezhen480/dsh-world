// tests/computerCatalog.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { catalogText } from '../src/ecosystem/computer/procedures/catalog.ts';
import { createProcedureLibrary } from '../src/ecosystem/computer/procedures/library.ts';

const op = (category: string, name: string, description: string, extra: object = {}) =>
  JSON.stringify({ name, category, description, params: {}, steps: [{ open: 'https://example.com/' }], ...extra });

function library(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'computer-catalog-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lib = createProcedureLibrary(dir);
  lib.save(op('wechat', '打开微信', '打开网页版'));
  lib.save(op('wechat', '发送消息', '给某人发一句话', { params: { to: { type: 'string', required: true }, text: { type: 'string', required: true } } }));
  lib.save(op('bilibili', '看私信', '读 B站 私信'));
  lib.saveGuide('wechat', '程序：Weixin.exe（微信）。从任务栏点开，消息框在窗口底部。');
  lib.saveGuide('bilibili', '网站：bilibili.com（B站）');
  return lib;
}

test('naming what she wants returns that category: her note, the names of its operations and where their files are', t => {
  const lib = library(t);
  const text = catalogText(lib, '微信');
  assert.equal(text, [
    'wechat',
    '程序：Weixin.exe（微信）。从任务栏点开，消息框在窗口底部。',
    '操作：发送消息、打开微信',
    `文件在 ${join(lib.dir, 'wechat')}，一个操作一个 <名字>.json；要看参数和步骤就读它。`,
    '',
    '用 procedure_run("wechat/操作名", 参数) 直接跑；没有合适的就用 page_* 自己做，走通了 procedure_save 存进来。',
  ].join('\n'));
  assert.doesNotMatch(text, /给某人发一句话|打开网页版/, 'descriptions are in the files, not here');
});

test('operations come newest first: the last saved or edited by hand leads', t => {
  const lib = library(t);
  const age = (name: string, minutes: number) => { const at = new Date(Date.now() - minutes * 60_000); utimesSync(join(lib.dir, 'wechat', `${name}.json`), at, at); };
  age('发送消息', 30); age('打开微信', 10);
  assert.match(catalogText(lib, '微信'), /^操作：打开微信、发送消息$/m);
  writeFileSync(join(lib.dir, 'wechat', '发送消息.json'), op('wechat', '发送消息', '改过了'));
  assert.match(catalogText(lib, '微信'), /^操作：发送消息、打开微信$/m);
});

test('only the object is matched: the category name and her note, never what an operation is called', t => {
  const lib = library(t);
  lib.save(op('bilibili', '发送消息', '给 UP 主发私信'));
  const wechat = catalogText(lib, '微信');
  assert.match(wechat, /^wechat\n/);
  assert.doesNotMatch(wechat, /bilibili|UP 主/, 'the same operation name in another category stays out');
  assert.match(catalogText(lib, 'B站'), /^bilibili\n/);
  assert.match(catalogText(lib, 'weixin'), /^wechat\n/, 'case does not matter');
  assert.match(catalogText(lib, 'bilibili'), /^bilibili\n/, 'the category name itself');
  assert.match(catalogText(lib, '发送消息'), /^没有对得上「发送消息」的分类/, 'an operation name is not an object');
});

test('the object is matched fuzzily: run together with other words, in another case, or misspelt', t => {
  const lib = library(t);
  assert.match(catalogText(lib, 'B站私信'), /^bilibili\n/, 'a word of hers that holds the object');
  assert.match(catalogText(lib, '打开微信'), /^wechat\n/);
  assert.match(catalogText(lib, 'WeChat'), /^wechat\n/);
  assert.match(catalogText(lib, 'bilbili'), /^bilibili\n/, 'a typo');
  assert.match(catalogText(lib, 'Weixin.exe'), /^wechat\n/);
  assert.match(catalogText(lib, '网易云音乐'), /^没有对得上/, 'a few letters in common are not a match');
});

test('one category comes back; when her words fit several equally, only their names, so she picks one', t => {
  const lib = library(t);
  lib.saveGuide('qq', '程序：QQ.exe，聊天');
  lib.saveGuide('wechat', '程序：Weixin.exe（微信），聊天');
  assert.equal(catalogText(lib, '聊天'), '「聊天」对得上不止一类：qq、wechat。用 computer_use 说出其中一类的名字。');
});

test('nothing named is using the computer freely: only the categories are listed', t => {
  assert.equal(catalogText(library(t)), '学会的操作：bilibili（1 个）、wechat（2 个）。要用某一类，用 computer_use 说出它的名字。');
  const dir = mkdtempSync(join(tmpdir(), 'computer-catalog-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.match(catalogText(createProcedureLibrary(dir)), /^还没有学会的操作。/);
  assert.match(catalogText(createProcedureLibrary(dir), '   '), /^还没有学会的操作。/);
});

test('no match says so and lists what there is, so she can start a new category', t => {
  const text = catalogText(library(t), '网易云音乐');
  assert.match(text, /^没有对得上「网易云音乐」的分类（已有：bilibili、wechat）。是其中一类的话，用 procedure_note 在它的说明里写上这个叫法；/);
  assert.match(text, /procedure_save/);
});

test('a long note is cut; however many operations, their names fit on one line', t => {
  const lib = library(t);
  lib.saveGuide('wechat', '微信' + '很'.repeat(900));
  for (let i = 0; i < 20; i++) lib.save(op('wechat', `操作${i}`, '一个'));
  const text = catalogText(lib, '微信');
  assert.match(text, /…（截断）/);
  assert.equal(/^操作：(.+)$/m.exec(text)![1]!.split('、').length, 22);
});

test('a category with only her note says so; files the development build left flat are found where they are', t => {
  const lib = library(t);
  lib.saveGuide('qq', '程序：QQ.exe');
  assert.match(catalogText(lib, 'QQ'), /^qq\n程序：QQ\.exe\n（这一类还没有操作）\n文件在 /);
  writeFileSync(join(lib.dir, 'bili_unread.json'), JSON.stringify({ name: 'bili_unread', description: '旧的', params: {}, steps: [{ open: 'https://e.com/' }] }));
  assert.match(catalogText(lib, '未分类'), new RegExp(`操作：bili_unread\n文件在 ${lib.dir.replace(/\\/g, '\\\\')}，`));
});
