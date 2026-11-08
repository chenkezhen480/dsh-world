// tests/computerTools.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { computerTools } from '../src/ecosystem/computer/tools.ts';
import { createProcedureLibrary } from '../src/ecosystem/computer/procedures/library.ts';
import type { Page } from '../src/ecosystem/computer/browser/page.ts';

function setup(t: test.TestContext, record?: () => Promise<never>, failRun?: Error) {
  const dir = mkdtempSync(join(tmpdir(), 'computer-tools-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls: string[] = [];
  const page = {
    open: async (url: string) => { calls.push(`open ${url}`); }, read: async () => '页 · u\n[1] button 发送', brief: async () => '页 · u',
    click: async (target: unknown) => { calls.push(`click ${JSON.stringify(target)}`); }, type: async () => {}, press: async () => {}, scroll: async () => {},
    wait: async () => {}, has: async () => true, extract: async () => [{ uid: '42', id: 'm1', text: '你好' }], evaluate: async () => 2, shot: async () => Buffer.from('png'), bringToFront: async () => {},
  } as unknown as Page;
  let runs = 0;
  const browser = { run: <T>(work: (p: Page, signal: AbortSignal) => Promise<T>) => { runs++; return failRun ? Promise.reject(failRun) : work(page, new AbortController().signal); } };
  const library = createProcedureLibrary(dir);
  const recorded: unknown[] = [];
  const agent = { id: 'home-1' } as unknown as Agent;
  const tools = () => computerTools({ agent, browser, library, recorder: { record: async (_agent, _map, rows) => { if (record) return record(); recorded.push(...rows); return { written: rows.length, skipped: 0, outOfScope: false }; } }, attachments: () => undefined });
  const run = (list: ToolDefinition[], name: string, args: object = {}) => list.find(tool => tool.name === name)!.execute(args as never, { signal: new AbortController().signal, deferContext() {} } as never) as Promise<string>;
  return { calls, library, tools, run, recorded, runs: () => runs };
}

test('page tools act on her page and answer briefly', async t => {
  const s = setup(t);
  const tools = s.tools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['page_click', 'page_eval', 'page_open', 'page_press', 'page_read', 'page_scroll', 'page_shot', 'page_type', 'page_wait', 'procedure_list', 'procedure_save']);
  assert.match(await s.run(tools, 'page_open', { url: 'https://www.bilibili.com/' }), /\[1\] button 发送/);
  assert.match(await s.run(tools, 'page_click', { ref: 1 }), /已点击 \[1\]/);
  assert.deepEqual(s.calls, ['open https://www.bilibili.com/', 'click {"ref":1}']);
  await assert.rejects(s.run(tools, 'page_scroll', { direction: 'left' }), /up 或 down/);
  await assert.rejects(s.run(tools, 'page_shot'), /宿主图片存储不可用/);
});

test('a saved tool becomes my_<name>, runs without the model, and archives what it declared', async t => {
  const s = setup(t);
  const saved = await s.run(s.tools(), 'procedure_save', { json: JSON.stringify({
    name: 'bili_dm_read', description: '读阿明的私信', params: { uid: { type: 'string', required: true } },
    steps: [{ open: 'https://message.bilibili.com/#/whisper/mid{{uid}}' }, { extract: { list: { css: '.msg' }, fields: { id: { css: '.msg', attr: 'data-id' }, text: { css: '.text' } } } }],
    messages: { channel: 'bilibili', accountId: 'me', conversationType: 'private', conversationId: '{{uid}}', messageId: '{{id}}', speakerId: '{{uid}}', content: '{{text}}' },
  }) });
  assert.match(saved, /已保存 my_bili_dm_read（第 1 版）/);
  const tools = s.tools();
  const mine = tools.find(tool => tool.name === 'my_bili_dm_read')!;
  assert.match(mine.description, /读阿明的私信/);
  assert.deepEqual((mine.parameters as { required?: string[] }).required, ['uid']);
  const out = await s.run(tools, 'my_bili_dm_read', { uid: '42' });
  assert.match(out, /"rows":\[\{"uid":"42","id":"m1","text":"你好"\}\]/);
  assert.match(out, /新记进归档 1 条/);
  assert.equal(s.recorded.length, 1);
  assert.match(await s.run(tools, 'procedure_list'), /my_bili_dm_read — 读阿明的私信（最近：成功/);
  await assert.rejects(s.run(tools, 'my_bili_dm_read', {}), /missing required property "uid"/);
});

test('a refused save explains itself', async t => {
  const s = setup(t);
  await assert.rejects(s.run(s.tools(), 'procedure_save', { json: '{"name":"x"}' }), /没有保存：name：/);
});

test('a failing archive write is told after the result, never in its place', async t => {
  const s = setup(t, async () => { throw new Error('找不到这一轮的开始，没有记进归档'); });
  await s.run(s.tools(), 'procedure_save', { json: JSON.stringify({
    name: 'read_dm', description: '读私信', params: {}, steps: [{ open: 'https://example.com/' }, { extract: { list: { css: '.msg' }, fields: { id: { css: '.msg', attr: 'data-id' } } } }],
    messages: { channel: 'bilibili', accountId: 'me', conversationType: 'private', conversationId: 'c', messageId: '{{id}}', speakerId: 'c', content: '{{id}}' },
  }) });
  const out = await s.run(s.tools(), 'my_read_dm');
  assert.match(out, /"rows":\[/);
  assert.match(out, /（没能记进归档：找不到这一轮的开始，没有记进归档）/);
});

const ping = JSON.stringify({ name: 'ping', description: '看看', params: {}, steps: [{ open: 'https://example.com/' }] });

test('a run that is cut off is noted as failed before the error goes on', async t => {
  const s = setup(t, undefined, new Error('操作等得太久'));
  s.library.save(ping);
  await assert.rejects(s.run(s.tools(), 'my_ping'), /操作等得太久/);
  assert.equal(s.library.lastRun('ping')?.ok, false);
  assert.match(s.library.lastRun('ping')?.detail ?? '', /操作等得太久/);
});

test('a bad number is refused before the browser is touched', async t => {
  const s = setup(t);
  const tools = s.tools();
  await assert.rejects(s.run(tools, 'page_click', { ref: 0 }), /编号/);
  await assert.rejects(s.run(tools, 'page_read', { page: 0 }), /page/);
  await assert.rejects(s.run(tools, 'page_read', { ref: -1 }), /编号/);
  await assert.rejects(s.run(tools, 'page_wait', { text: '' }), /text/);
  assert.equal(s.runs(), 0);
});

test('her tool descriptions do not carry a path on the disk', async t => {
  const s = setup(t);
  s.library.save(ping);
  const mine = s.tools().find(tool => tool.name === 'my_ping')!;
  assert.equal(mine.description, '看看（我自己的工具；坏了就用 page_* 走通后 procedure_save 覆盖）');
});

test('page_open refuses anything but web addresses before the browser is touched', async t => {
  const s = setup(t);
  for (const url of ['file:///C:/', 'javascript:alert(1)', 'data:text/html,x', 'edge://settings']) await assert.rejects(s.run(s.tools(), 'page_open', { url }), /只能打开 http 或 https 地址/);
  assert.equal(s.runs(), 0);
  assert.deepEqual(s.calls, []);
});

test('page_type says the box content is replaced', t => {
  assert.match(setup(t).tools().find(tool => tool.name === 'page_type')!.description, /替换/);
});
