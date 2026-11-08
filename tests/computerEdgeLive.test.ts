// tests/computerEdgeLive.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findBrowser, launchBrowser, runningPort } from '../src/ecosystem/computer/browser/edge.ts';
import { closeTarget, connectCdp, newTarget, pageTargets } from '../src/ecosystem/computer/browser/cdp.ts';
import { createPage } from '../src/ecosystem/computer/browser/page.ts';

const binary = findBrowser();
const PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<title>测试页</title><main>
  <button onclick="document.getElementById('out').textContent='点到了'">发送</button>
  <input placeholder="搜索"><p id="out">还没点</p>
  <ul><li class="item" data-id="1"><a class="who">阿明</a><span class="text">你好</span><ul><li class="item" data-id="3"><a class="who">小蓝</a><span class="text">楼中楼</span></li></ul></li><li class="item" data-id="2"><a class="who">小红</a><span class="text">在吗</span></li></ul>
  <button id="hidden-under">被挡住</button><div style="position:fixed;inset:0;background:transparent" id="cover"></div></main>`);
const NEXT = 'data:text/html;charset=utf-8,' + encodeURIComponent('<title>第二页</title><button>别的按钮</button>');

test('her own Edge: launch, adopt, read, click, type, extract, script, shot', { skip: !process.env.DSH_WORLD_EDGE_TEST || !binary }, async t => {
  const profile = mkdtempSync(join(tmpdir(), 'computer-live-'));
  const port = await launchBrowser(binary!, profile);
  assert.equal(await runningPort(profile), port, 'a second start adopts the running browser');
  const target = await newTarget(port);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  t.after(async () => { cdp.close(); for (const tab of await pageTargets(port)) await closeTarget(port, tab.id); });
  const page = createPage(cdp);
  await page.open(PAGE);
  // The cover sits over everything; take it away for the ordinary clicks, then put it back to see a covered click refused.
  await page.evaluate('document.getElementById("cover").style.display = "none"', {});
  const read = await page.read();
  assert.match(read, /测试页/);
  const ref = Number(/\[(\d+)\] button 发送/.exec(read)![1]);
  await page.click({ ref });
  assert.equal(await page.has({ text: '点到了' }), true);
  assert.match(await page.read(), new RegExp(`\\[${ref}\\] button 发送`), 'the same number survives a second read');
  await page.type({ anchor: { role: 'textbox', name: '搜索' } }, '鲸鲸');
  await page.type({ anchor: { role: 'textbox', name: '搜索' } }, '小鲸');
  assert.match(await page.read(), /textbox 搜索 = 小鲸$/m, 'typing replaces what was there');
  assert.deepEqual(await page.extract({ list: { css: 'li.item' }, fields: { id: { attr: 'data-id' }, who: { css: '.who' }, text: { css: '.text' } } }),
    [{ id: '1', who: '阿明', text: '你好' }, { id: '3', who: '小蓝', text: '楼中楼' }, { id: '2', who: '小红', text: '在吗' }], 'nested items keep their parents; attr alone reads the item itself');
  assert.equal(await page.evaluate('return args.n + document.querySelectorAll("li").length', { n: 1 }), 4);
  await assert.rejects(page.click({ anchor: { role: 'button', name: '不存在' } }), /页面上找不到 button 「不存在」/);
  await page.evaluate('document.getElementById("cover").style.display = "block"', {});
  await assert.rejects(page.click({ anchor: { role: 'button', name: '被挡住' } }), /挡住了/);
  assert.ok((await page.shot()).subarray(1, 4).toString() === 'PNG');
  await page.open(NEXT);
  await page.read();
  await assert.rejects(page.click({ ref }), /已经不在页面上/, 'a number from the old page never names an element of the new one');
});
