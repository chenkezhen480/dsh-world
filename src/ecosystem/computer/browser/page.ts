// src/ecosystem/computer/browser/page.ts
import { setTimeout as pause } from 'node:timers/promises';
import type { Cdp } from './cdp.ts';
import { PAGE_LIB } from './pageLib.ts';
import type { Anchor, Condition, ExtractSpec, Target } from '../procedures/format.ts';

export interface Control { ref: number; role: string; name: string; view: boolean; value: string }
interface Snapshot { url: string; title: string; controls: Control[]; text: string }
export type Row = Record<string, string>;

/** Everything one tab can do; the procedure engine's `Driver` is the anchor-only part of it. */
export interface Page {
  open(url: string): Promise<void>;
  read(options?: { page?: number; ref?: number }): Promise<string>;
  brief(): Promise<string>;
  /** `holdMs`: how long the button stays down, a long press; 0 or absent for a plain click. */
  click(target: Target, holdMs?: number): Promise<void>;
  type(target: Target, text: string): Promise<void>;
  press(key: string): Promise<void>;
  scroll(direction: 'up' | 'down', target?: Target): Promise<void>;
  wait(condition: Condition, timeoutMs: number, signal?: AbortSignal): Promise<void>;
  has(condition: Condition): Promise<boolean>;
  extract(spec: ExtractSpec): Promise<Row[]>;
  evaluate(script: string, args: Record<string, unknown>): Promise<unknown>;
  shot(): Promise<Buffer>;
  bringToFront(): Promise<void>;
}

const PER_PAGE = 40, TEXT_BUDGET = 1200;
const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' }, Tab: { code: 'Tab', keyCode: 9 }, Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 }, Delete: { code: 'Delete', keyCode: 46 }, Home: { code: 'Home', keyCode: 36 }, End: { code: 'End', keyCode: 35 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 }, ArrowDown: { code: 'ArrowDown', keyCode: 40 }, ArrowLeft: { code: 'ArrowLeft', keyCode: 37 }, ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  PageUp: { code: 'PageUp', keyCode: 33 }, PageDown: { code: 'PageDown', keyCode: 34 },
};
export const PAGE_KEYS = Object.keys(KEYS);

export const describeAnchor = (anchor: Anchor) => [anchor.role, anchor.name && `「${anchor.name}」`, anchor.text && `文字「${anchor.text}」`, anchor.css && `选择器 ${anchor.css}`, anchor.nth && `第 ${anchor.nth + 1} 个`].filter(Boolean).join(' ');
const describeTarget = (target: Target) => 'ref' in target ? `编号 ${target.ref}` : describeAnchor(target.anchor);
const missing = (target: Target) => new Error('ref' in target
  ? `编号 ${target.ref} 对应的元素已经不在页面上了，先 page_read 再用新编号`
  : `页面上找不到 ${describeAnchor(target.anchor)}`);

/** One numbered line per control, `perPage` of them, then the text she can see; what `page_read` returns. */
export function formatRead(snapshot: Snapshot, page = 1, perPage = PER_PAGE, textBudget = TEXT_BUDGET): string {
  const pages = Math.max(1, Math.ceil(snapshot.controls.length / perPage));
  const shown = snapshot.controls.slice((page - 1) * perPage, page * perPage);
  const lines = [`${snapshot.title || '（无标题）'} · ${snapshot.url}`];
  for (const control of shown) lines.push(`[${control.ref}] ${control.role} ${control.name}${control.value ? ` = ${control.value}` : ''}${control.view ? '' : '（屏外）'}`);
  if (!snapshot.controls.length) lines.push('（没有可操作的元素）');
  if (pages > 1) lines.push(`（控件第 ${Math.min(page, pages)}/${pages} 页；${page < pages ? `page=${page + 1} 看后面` : '已是最后一页'}）`);
  if (snapshot.text) lines.push('—— 页面文字 ——', snapshot.text.length > textBudget ? snapshot.text.slice(0, textBudget) + '…' : snapshot.text);
  return lines.join('\n');
}

export function createPage(cdp: Cdp): Page {
  // A new document restarts the page's numbering; carrying the highest number seen keeps an old number from ever naming another element.
  let highest = 0;
  async function call<T>(expression: string): Promise<T> {
    const result = await cdp.send<{ result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', {
      expression: `(() => {window.__dshBase = ${highest};${PAGE_LIB};\nreturn (${expression});\n})()`, returnByValue: true, awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value as T;
  }
  async function snapshot(ref?: number): Promise<Snapshot> {
    if (ref !== undefined && !Number.isSafeInteger(ref)) throw new Error(`编号 ${String(ref)} 不是有效的元素编号`);
    const data = await call<Snapshot | { missing: true }>(`window.__dshWorld.snapshot(${JSON.stringify(ref ?? null)}, ${TEXT_BUDGET})`);
    if ('missing' in data) throw missing({ ref: ref! });
    highest = data.controls.reduce((top, control) => Number.isSafeInteger(control.ref) && control.ref > top ? control.ref : top, highest);
    return data;
  }
  async function pointOf(target: Target): Promise<{ x: number; y: number }> {
    const point = await call<{ x: number; y: number } | { covered: true; by: string } | null>(`window.__dshWorld.point(${JSON.stringify(target)})`);
    if (!point) throw missing(target);
    if ('covered' in point) throw new Error(`${describeTarget(target)} 被别的东西挡住了（${point.by}），先关掉它或滚动一下`);
    return point;
  }
  const mouse = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, pointerType: 'mouse', ...extra });
  async function has(condition: Condition): Promise<boolean> { return await call<boolean>(`window.__dshWorld.has(${JSON.stringify(condition)})`); }
  return {
    async open(url) {
      await cdp.send('Page.enable');
      let release = () => {};
      const loaded = new Promise<void>(resolve => {
        const timer = setTimeout(() => { release(); resolve(); }, 15_000);
        const off = cdp.on(method => { if (method === 'Page.loadEventFired') { release(); resolve(); } });
        release = () => { clearTimeout(timer); off(); };
      });
      try {
        const navigated = await cdp.send<{ errorText?: string }>('Page.navigate', { url });
        if (navigated.errorText) throw new Error(`打不开 ${url}：${navigated.errorText}`);
        await loaded;
      } finally { release(); }
    },
    async read({ page = 1, ref } = {}) { return formatRead(await snapshot(ref), page); },
    async brief() { return formatRead(await snapshot(), 1, 15, 300); },
    async click(target, holdMs = 0) {
      const { x, y } = await pointOf(target);
      await mouse('mouseMoved', x, y, { button: 'none', clickCount: 0 });
      await mouse('mousePressed', x, y, { buttons: 1 });
      if (holdMs > 0) await pause(holdMs);
      await mouse('mouseReleased', x, y);
    },
    async type(target, text) {
      const focused = await call<'ok' | 'missing' | 'unfocusable'>(`window.__dshWorld.focus(${JSON.stringify(target)})`);
      if (focused === 'missing') throw missing(target);
      if (focused === 'unfocusable') throw new Error(`${describeTarget(target)} 这个元素不能输入`);
      await cdp.send('Input.insertText', { text });
    },
    async press(key) {
      const spec = KEYS[key];
      if (!spec) throw new Error(`不认识按键 ${key}，可用：${PAGE_KEYS.join('、')}`);
      const base = { key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode };
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(spec.text ? { text: spec.text } : {}) });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    },
    async scroll(direction, target) {
      const { x, y } = target ? await pointOf(target) : await call<{ x: number; y: number }>('({ x: innerWidth / 2, y: innerHeight / 2 })');
      await mouse('mouseWheel', x, y, { button: 'none', clickCount: 0, deltaX: 0, deltaY: direction === 'down' ? 600 : -600 });
    },
    async wait(condition, timeoutMs, signal) {
      const deadline = Date.now() + timeoutMs;
      let lastError = '';
      for (;;) {
        signal?.throwIfAborted();
        try { if (await has(condition)) return; } catch (error) { lastError = error instanceof Error ? error.message : String(error); /* the page may be between documents */ }
        if (Date.now() >= deadline) throw new Error(`等了 ${Math.round(timeoutMs / 1000)} 秒没等到${lastError ? `（最后一次出错：${lastError}）` : ''}`);
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    },
    has,
    async extract(spec) { return await call<Row[]>(`window.__dshWorld.extract(${JSON.stringify(spec)})`); },
    async evaluate(script, args) {
      const result = await cdp.send<{ result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', {
        expression: `Promise.race([(async (args) => {\n${script}\n})(${JSON.stringify(args)}), new Promise((_, reject) => setTimeout(() => reject(new Error('页面脚本超过十秒没有结束')), 10000))])`, returnByValue: true, awaitPromise: true, timeout: 10_000,
      });
      if (result.exceptionDetails) throw new Error(`页面脚本出错：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
      return result.result.value ?? null;
    },
    async shot() { return Buffer.from((await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' })).data, 'base64'); },
    async bringToFront() { await cdp.send('Page.bringToFront'); },
  };
}
