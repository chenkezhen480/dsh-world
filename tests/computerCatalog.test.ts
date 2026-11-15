// tests/computerCatalog.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { catalogText, score } from '../src/ecosystem/computer/procedures/catalog.ts';
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

test('naming what she wants returns that category: her note and its operations', t => {
  const lib = library(t);
  lib.note('wechat/发送消息', true);
  const text = catalogText(lib, '微信');
  assert.match(text, /^wechat\n程序：Weixin\.exe（微信）。从任务栏点开/);
  assert.match(text, /- 打开微信 — 打开网页版（还没跑过）/);
  assert.match(text, /- 发送消息（to, text）— 给某人发一句话（最近：成功 /);
  assert.match(text, /procedure_run\("分类\/操作", 参数\)/);
  assert.doesNotMatch(text, /bilibili/);
});

test('a word inside her notes, names or descriptions finds the category; the best match comes first', t => {
  const lib = library(t);
  assert.match(catalogText(lib, 'B站 私信'), /^bilibili\n/);
  assert.match(catalogText(lib, 'weixin'), /^wechat\n/, 'case does not matter');
  assert.ok(score('B站 私信', 'bilibili 网站：bilibili.com（B站） 看私信 读 B站 私信') > score('B站 私信', 'wechat 发送消息'));
});

test('nothing named is using the computer freely: only the categories are listed', t => {
  assert.equal(catalogText(library(t)), '学会的操作：bilibili（1 个）、wechat（2 个）。要用某一类，用 computer_use 说出它的名字。');
  const dir = mkdtempSync(join(tmpdir(), 'computer-catalog-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.match(catalogText(createProcedureLibrary(dir)), /^还没有学会的操作。/);
  assert.match(catalogText(createProcedureLibrary(dir), '   '), /^还没有学会的操作。/);
});

test('no match says so and lists what there is, so she can start a new category', t => {
  const text = catalogText(library(t), '网易云音乐');
  assert.match(text, /^还没有学会和「网易云音乐」相关的操作（已有：bilibili、wechat）。/);
  assert.match(text, /procedure_save/);
});

test('long notes and long categories are cut', t => {
  const lib = library(t);
  lib.saveGuide('wechat', '微信' + '很'.repeat(900));
  for (let i = 0; i < 20; i++) lib.save(op('wechat', `操作${i}`, '一个'));
  const text = catalogText(lib, '微信');
  assert.match(text, /…（截断）/);
  assert.equal((text.match(/^- /gm) ?? []).length, 15);
  assert.match(text, /（还有 7 个，说得更具体些可以缩小范围）/);
});
