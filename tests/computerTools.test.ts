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

function setup(t: test.TestContext, record?: () => Promise<never>, failRun?: Error, pageOverrides: object = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'computer-tools-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls: string[] = [];
  const page = {
    open: async (url: string) => { calls.push(`open ${url}`); }, read: async () => '页 · u\n[1] button 发送', brief: async () => '页 · u',
    click: async (target: unknown) => { calls.push(`click ${JSON.stringify(target)}`); }, type: async () => {}, press: async () => {}, scroll: async () => {},
    wait: async () => {}, has: async () => true, extract: async () => [{ uid: '42', id: 'm1', text: '你好' }], evaluate: async () => 2, shot: async () => Buffer.from('png'), bringToFront: async () => {},
    ...pageOverrides,
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
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['computer_use', 'page_click', 'page_eval', 'page_open', 'page_press', 'page_read', 'page_scroll', 'page_shot', 'page_type', 'page_wait', 'procedure_note', 'procedure_run', 'procedure_save']);
  assert.match(await s.run(tools, 'page_open', { url: 'https://www.bilibili.com/' }), /\[1\] button 发送/);
  assert.match(await s.run(tools, 'page_click', { ref: 1 }), /已点击 \[1\]/);
  assert.deepEqual(s.calls, ['open https://www.bilibili.com/', 'click {"ref":1}']);
  await assert.rejects(s.run(tools, 'page_scroll', { direction: 'left' }), /up 或 down/);
  await assert.rejects(s.run(tools, 'page_shot'), /宿主图片存储不可用/);
});

test('a refused save explains itself', async t => {
  const s = setup(t);
  await assert.rejects(s.run(s.tools(), 'procedure_save', { json: '{"name":"a/b"}' }), /没有保存：name：/);
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

test('page_open refuses anything but web addresses before the browser is touched', async t => {
  const s = setup(t);
  for (const url of ['file:///C:/', 'javascript:alert(1)', 'data:text/html,x', 'edge://settings']) await assert.rejects(s.run(s.tools(), 'page_open', { url }), /只能打开 http 或 https 地址/);
  assert.equal(s.runs(), 0);
  assert.deepEqual(s.calls, []);
});

test('page_type says the box content is replaced', t => {
  assert.match(setup(t).tools().find(tool => tool.name === 'page_type')!.description, /替换/);
});

const dm = (extra: object = {}) => JSON.stringify({
  name: '读私信', category: 'bilibili', description: '读阿明的私信', params: { uid: { type: 'string', required: true } },
  steps: [{ open: 'https://message.bilibili.com/#/whisper/mid{{uid}}' }, { extract: { list: { css: '.msg' }, fields: { id: { css: '.msg', attr: 'data-id' }, text: { css: '.text' } } } }],
  messages: { channel: 'bilibili', accountId: 'me', conversationType: 'private', conversationId: '{{uid}}', messageId: '{{id}}', speakerId: '{{uid}}', content: '{{text}}' }, ...extra,
});

test('a saved operation is found with computer_use and run with procedure_run, without the model', async t => {
  const s = setup(t);
  assert.match(await s.run(s.tools(), 'procedure_save', { json: dm() }), /^已保存 bilibili\/读私信（第 1 版）/);
  assert.match(await s.run(s.tools(), 'procedure_note', { category: 'bilibili', text: '网站：bilibili.com（B站）' }), /^已写好 bilibili 的说明（第 1 版）/);
  assert.equal(s.tools().length, 13, 'saving never adds a tool');
  assert.match(await s.run(s.tools(), 'computer_use', { target: 'B站' }), /^bilibili\n网站：bilibili\.com（B站）\n操作：\n- 读私信（uid）— 读阿明的私信（还没跑过）/);
  const out = await s.run(s.tools(), 'procedure_run', { path: 'bilibili/读私信', args: { uid: '42' } });
  assert.match(out, /"rows":\[\{"uid":"42","id":"m1","text":"你好"\}\]/);
  assert.match(out, /新记进归档 1 条/);
  assert.match(await s.run(s.tools(), 'computer_use', { target: 'B站' }), /最近：成功/);
  await assert.rejects(s.run(s.tools(), 'procedure_run', { path: 'bilibili/读私信', args: {} }), /缺少参数 uid/);
  await assert.rejects(s.run(s.tools(), 'procedure_run', { path: 'bilibili/没有' }), /没有 bilibili\/没有 这个操作/);
});

test('a failing archive write is told after the result, never in its place', async t => {
  const s = setup(t, async () => { throw new Error('找不到这一轮的开始，没有记进归档'); });
  s.library.save(dm());
  const out = await s.run(s.tools(), 'procedure_run', { path: 'bilibili/读私信', args: { uid: '42' } });
  assert.match(out, /"rows":\[/);
  assert.match(out, /（没能记进归档：找不到这一轮的开始，没有记进归档）/);
});

test('a run that is cut off is noted as failed before the error goes on', async t => {
  const s = setup(t, undefined, new Error('操作等得太久'));
  s.library.save(dm());
  await assert.rejects(s.run(s.tools(), 'procedure_run', { path: 'bilibili/读私信', args: { uid: '1' } }), /操作等得太久/);
  assert.match(s.library.lastRun('bilibili/读私信')?.detail ?? '', /操作等得太久/);
});

test('a broken newest version falls back to a kept one, and she is told her newest failed', async t => {
  const s = setup(t, undefined, undefined, { extract: async (spec: { list: { css: string } }) => spec.list.css === '.new' ? [] : [{ uid: '42', id: 'm1', text: '你好' }] });
  const version = (css: string) => JSON.stringify({ name: '读私信', category: 'bilibili', description: '读私信', params: {}, steps: [{ open: 'https://example.com/' }, { extract: { list: { css }, fields: { id: { css, attr: 'data-id' } } } }] });
  s.library.save(version('.msg'));
  s.library.save(version('.new'));
  const out = await s.run(s.tools(), 'procedure_run', { path: 'bilibili/读私信' });
  assert.match(out, /^\{"rows":\[\{"uid":"42","id":"m1","text":"你好"\}\]\}\n（最新版第 2 步（提取 选择器 \.new）没跑通：一条都没有提取到.*这次退回第 1 版跑通了。/);
});

