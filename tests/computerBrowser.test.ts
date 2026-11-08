// tests/computerBrowser.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { Faults } from '../src/faults.ts';
import { createBrowser } from '../src/ecosystem/computer/browser/browser.ts';
import type { Cdp, Target } from '../src/ecosystem/computer/browser/cdp.ts';

function fakeCdp(log: string[], name: string): Cdp {
  let closed = false;
  return { send: async method => { log.push(`${name}:${method}`); return {} as never; }, on: () => () => {}, close: () => { closed = true; log.push(`${name}:close`); }, get closed() { return closed; } };
}
const tab = (id: string): Target => ({ id, type: 'page', url: 'about:blank', title: '', webSocketDebuggerUrl: `ws://x/${id}` });

test('adopts a running browser, keeps one main tab, and runs scratch work in a tab it closes', async () => {
  const log: string[] = [];
  let launched = 0;
  const browser = createBrowser({
    profileDir: 'P', faults: new Faults(), find: () => 'edge.exe',
    running: async () => 9222, launch: async () => { launched++; return 9333; },
    targets: async () => [tab('main')], open: async () => tab('scratch'), close: async (_port, id) => { log.push(`closed:${id}`); },
    connect: async url => fakeCdp(log, url.endsWith('main') ? 'main' : 'scratch'),
  });
  await browser.run(page => page.bringToFront());
  await browser.run(page => page.bringToFront());
  assert.equal(launched, 0);
  assert.deepEqual(log, ['main:Page.bringToFront', 'main:Page.bringToFront'], 'the main tab is connected once');
  await browser.scratch(page => page.bringToFront());
  assert.deepEqual(log.slice(2), ['scratch:Page.bringToFront', 'scratch:close', 'closed:scratch']);
  assert.equal(browser.status().state, 'running');
});

test('starts the browser when none runs, and a missing browser is a fault, not a crash', async () => {
  const faults = new Faults();
  let launched = 0;
  const started = createBrowser({ profileDir: 'P', faults, find: () => 'edge.exe', running: async () => 0, launch: async () => { launched++; return 9333; }, targets: async () => [], open: async () => tab('t'), close: async () => {}, connect: async () => fakeCdp([], 't') });
  await started.run(async () => undefined);
  assert.equal(launched, 1);
  const none = createBrowser({ profileDir: 'P', faults, find: () => undefined, running: async () => 0 });
  assert.equal(none.status().state, 'missing');
  await assert.rejects(none.run(async () => undefined), /找不到 Edge 或 Chrome/);
  assert.match(faults.list().join(), /她的浏览器没能打开：.*找不到 Edge 或 Chrome/);
});

test('work runs one at a time', async () => {
  const order: string[] = [];
  const browser = createBrowser({ profileDir: 'P', faults: new Faults(), find: () => 'e', running: async () => 1, targets: async () => [tab('m')], connect: async () => fakeCdp([], 'm') });
  const slow = browser.run(async () => { order.push('a1'); await new Promise(resolve => setTimeout(resolve, 20)); order.push('a2'); });
  const fast = browser.run(async () => { order.push('b'); });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ['a1', 'a2', 'b']);
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('stop() cancels hanging work: its signal aborts and the main connection is closed', async () => {
  const cdps: Cdp[] = [];
  const browser = createBrowser({ profileDir: 'P', faults: new Faults(), find: () => 'e', running: async () => 1, targets: async () => [tab('m')], connect: async () => { const cdp = fakeCdp([], 'm'); cdps.push(cdp); return cdp; } });
  let signal!: AbortSignal;
  const hung = browser.run((_page, given) => { signal = given; return new Promise<never>(() => {}); });
  await tick();
  browser.stop();
  await assert.rejects(hung, /stopped/);
  assert.equal(signal.aborted, true);
  assert.equal(cdps[0]!.closed, true);
});

test('after a timeout the next run reconnects', async () => {
  let connects = 0;
  const cdps: Cdp[] = [];
  const browser = createBrowser({ profileDir: 'P', faults: new Faults(), timeoutMs: 20, find: () => 'e', running: async () => 1, targets: async () => [tab('m')], connect: async () => { connects++; const cdp = fakeCdp([], 'm'); cdps.push(cdp); return cdp; } });
  await assert.rejects(browser.run(() => new Promise<never>(() => {})), /超时.*可能已经发出/);
  assert.equal(cdps[0]!.closed, true);
  await browser.run(async () => undefined);
  assert.equal(connects, 2);
});

test('a connect that finishes after stop() is closed, not kept', async () => {
  const late = deferred<Cdp>();
  const cdp = fakeCdp([], 'm');
  const browser = createBrowser({ profileDir: 'P', faults: new Faults(), find: () => 'e', running: async () => 1, targets: async () => [tab('m')], connect: () => late.promise });
  const pending = browser.run(async () => undefined);
  pending.catch(() => {});
  await tick();
  browser.stop();
  late.resolve(cdp);
  await assert.rejects(pending);
  assert.equal(cdp.closed, true);
  assert.notEqual(browser.status().state, 'running');
});

test('a scratch tab is closed when its work throws or its connection fails', async () => {
  const log: string[] = [];
  const base = { profileDir: 'P', faults: new Faults(), find: () => 'e', running: async () => 1, open: async () => tab('s'), close: async (_port: number, id: string) => { log.push(`closed:${id}`); } };
  const failing = createBrowser({ ...base, connect: async () => fakeCdp(log, 's') });
  await assert.rejects(failing.scratch(async () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(log, ['s:close', 'closed:s']);
  log.length = 0;
  const unreachable = createBrowser({ ...base, connect: async () => { throw new Error('no socket'); } });
  await assert.rejects(unreachable.scratch(async () => undefined), /no socket/);
  assert.deepEqual(log, ['closed:s']);
});

test('a scratch run whose signal is already aborted opens no tab', async () => {
  const log: string[] = [];
  const browser = createBrowser({ profileDir: 'P', faults: new Faults(), find: () => 'e', running: async () => 1, open: async () => { log.push('opened'); return tab('s'); }, close: async () => {}, connect: async () => fakeCdp(log, 's') });
  const controller = new AbortController(); controller.abort(new Error('late'));
  await assert.rejects(browser.scratch(async () => 'x', controller.signal), /late/);
  assert.deepEqual(log, []);
});
