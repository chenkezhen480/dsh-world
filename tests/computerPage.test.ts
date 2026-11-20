// tests/computerPage.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRead } from '../src/ecosystem/computer/browser/page.ts';

const controls = Array.from({ length: 45 }, (_, index) => ({ ref: index + 1, role: index % 2 ? 'button' : 'link', name: `控件${index + 1}`, view: index < 40, value: '' }));

test('a read is one numbered line per control, paged, with the visible text cut to budget', () => {
  const first = formatRead({ url: 'https://example.com/', title: '例子', controls, text: '字'.repeat(2000) }, 1);
  assert.match(first, /^例子 · https:\/\/example\.com\/\n\[1\] link 控件1\n\[2\] button 控件2/);
  assert.match(first, /第 1\/2 页；page=2 看后面/);
  assert.doesNotMatch(first, /控件41/);
  assert.match(first, /—— 页面文字 ——\n字{1200}…/);
  const second = formatRead({ url: 'u', title: 't', controls, text: '' }, 2);
  assert.match(second, /\[41\] link 控件41（屏外）/);
  assert.doesNotMatch(second, /页面文字/);
});

test('a value and an empty page say so', () => {
  assert.match(formatRead({ url: 'u', title: 't', controls: [{ ref: 3, role: 'textbox', name: '搜索', view: true, value: '鲸' }], text: '' }, 1), /\[3\] textbox 搜索 = 鲸/);
  assert.match(formatRead({ url: 'u', title: '', controls: [], text: '' }, 1), /没有可操作的元素/);
});

import { createPage } from '../src/ecosystem/computer/browser/page.ts';
import type { Cdp } from '../src/ecosystem/computer/browser/cdp.ts';

function fakeCdp(answer: (method: string, params: Record<string, unknown>) => unknown) {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const listeners = new Set<unknown>();
  const cdp: Cdp = {
    async send(method, params = {}) { sent.push({ method, params }); return await answer(method, params) as never; },
    on(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close() {}, closed: false,
  };
  return { cdp, sent, listeners };
}
const value = (v: unknown) => ({ result: { value: v } });

test('open takes its listener away when the navigation fails', async () => {
  const { cdp, listeners } = fakeCdp(method => method === 'Page.navigate' ? { errorText: 'net::ERR_NAME_NOT_RESOLVED' } : {});
  await assert.rejects(createPage(cdp).open('https://nowhere.invalid/'), /打不开/);
  assert.equal(listeners.size, 0);
  const thrown = fakeCdp(method => { if (method === 'Page.navigate') throw new Error('gone'); return {}; });
  await assert.rejects(createPage(thrown.cdp).open('https://x/'), /gone/);
  assert.equal(thrown.listeners.size, 0);
});

test('a wait that runs out says what went wrong last', async () => {
  const { cdp } = fakeCdp(() => { throw new Error('Execution context was destroyed'); });
  await assert.rejects(createPage(cdp).wait({ text: 'x' }, 300), /等了 0 秒没等到（最后一次出错：Execution context was destroyed）/);
});

test('a click goes to the point the page reports, and says what covers a target', async () => {
  const ok = fakeCdp(method => method === 'Runtime.evaluate' ? value({ x: 10, y: 20 }) : {});
  await createPage(ok.cdp).click({ ref: 1 });
  const mice = ok.sent.filter(item => item.method === 'Input.dispatchMouseEvent');
  assert.deepEqual(mice.map(item => item.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.ok(mice.every(item => item.params.x === 10 && item.params.y === 20));
  // A long press: the button stays down for the time asked before it is let go.
  const held = fakeCdp(method => method === 'Runtime.evaluate' ? value({ x: 10, y: 20 }) : {});
  const started = Date.now();
  await createPage(held.cdp).click({ ref: 1 }, 80);
  assert.deepEqual(held.sent.filter(item => item.method === 'Input.dispatchMouseEvent').map(item => item.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.ok(Date.now() - started >= 75, 'released only after the hold');
  const covered = fakeCdp(() => value({ covered: true, by: 'div 同意条款' }));
  await assert.rejects(createPage(covered.cdp).click({ anchor: { name: '提交' } }), /被别的东西挡住了（div 同意条款）/);
  assert.equal(covered.sent.filter(item => item.method === 'Input.dispatchMouseEvent').length, 0);
});

test('typing says when the element cannot take input', async () => {
  const { cdp, sent } = fakeCdp(() => value('unfocusable'));
  await assert.rejects(createPage(cdp).type({ ref: 2 }, 'hi'), /这个元素不能输入/);
  assert.equal(sent.some(item => item.method === 'Input.insertText'), false);
});

test('a ref that is not a number never reaches the page', async () => {
  const { cdp, sent } = fakeCdp(() => value({}));
  await assert.rejects(createPage(cdp).read({ ref: '1;alert(1)' as never }));
  assert.equal(sent.length, 0);
});

test('a wait stops polling when its signal aborts', async () => {
  const { cdp } = fakeCdp(() => value(false));
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('stopped')), 50);
  const started = Date.now();
  await assert.rejects(createPage(cdp).wait({ text: 'x' }, 10_000, controller.signal), /stopped/);
  assert.ok(Date.now() - started < 2000);
});
