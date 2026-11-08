// tests/computerAlarm.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAlarmFacts } from '../src/ecosystem/computer/procedures/alarm.ts';
import { createProcedureLibrary } from '../src/ecosystem/computer/procedures/library.ts';
import type { Page } from '../src/ecosystem/computer/browser/page.ts';

const tool = (name: string, extra: object) => JSON.stringify({ name, description: name, params: {}, steps: [{ open: `https://example.com/${name}` }], ...extra });

test('her alarm tools run in a scratch tab, one line each; a failure says so', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'computer-alarm-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const library = createProcedureLibrary(dir);
  library.save(tool('bili_unread', { onAlarm: true, summary: '私信 2' }));
  library.save(tool('broken', { onAlarm: true }));
  library.save(tool('not_alarm', {}));
  const opened: string[] = [];
  const page = { open: async (url: string) => { opened.push(url); if (url.endsWith('broken')) throw new Error('打不开'); }, brief: async () => '页' } as unknown as Page;
  let scratches = 0;
  const facts = createAlarmFacts({ library, browser: { scratch: async work => { scratches++; return work(page, new AbortController().signal); } } });
  assert.equal(await facts(), 'my_bili_unread：私信 2\nmy_broken 没跑通（第 1 步：打不开）');
  assert.equal(scratches, 2);
  assert.deepEqual(opened, ['https://example.com/bili_unread', 'https://example.com/broken']);
  assert.equal(library.lastRun('broken')?.ok, false);
});

test('no alarm tools is nothing to add; a tool past its time is cut off and said', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'computer-alarm-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const library = createProcedureLibrary(dir);
  const never = { scratch: async () => new Promise<never>(() => {}) };
  assert.equal(await createAlarmFacts({ library, browser: never })(), undefined);
  library.save(tool('slow', { onAlarm: true }));
  assert.match(await createAlarmFacts({ library, browser: never, perToolMs: 20 })() ?? '', /^my_slow 没跑通（超过 1 秒）$/);
});

test('a tool past its time is aborted and recorded; the next one still runs; an empty budget says so', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'computer-alarm-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const library = createProcedureLibrary(dir);
  library.save(tool('a_hung', { onAlarm: true }));
  library.save(tool('b_fine', { onAlarm: true }));
  const signals: AbortSignal[] = [];
  const page = { open: async () => {}, brief: async () => '页' } as unknown as Page;
  let calls = 0;
  const browser = { scratch: async (work: (page: Page, signal: AbortSignal) => Promise<unknown>) => {
    const signal = new AbortController().signal; signals.push(signal);
    return ++calls === 1 ? new Promise<never>(() => {}) : work(page, signal);
  } };
  const lines = (await createAlarmFacts({ library, browser: browser as never, perToolMs: 20 })())!.split('\n');
  assert.match(lines[0]!, /^my_a_hung 没跑通（超过 1 秒）$/);
  assert.match(lines[1]!, /^my_b_fine：/);
  assert.equal(library.lastRun('a_hung')?.ok, false);
  assert.equal(library.lastRun('b_fine')?.ok, true);
  assert.equal(await createAlarmFacts({ library, browser: browser as never, totalMs: 0 })(), 'my_a_hung 没来得及跑（闹钟前的时间用完了）\nmy_b_fine 没来得及跑（闹钟前的时间用完了）');
});

test('the work of a tool past its time is told to stop, not left running', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'computer-alarm-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const library = createProcedureLibrary(dir);
  library.save(JSON.stringify({ name: 'slow', description: 'slow', params: {}, onAlarm: true, steps: [{ open: 'https://example.com/1' }, { open: 'https://example.com/2' }] }));
  const opened: string[] = [];
  const page = { open: async (url: string) => { opened.push(url); await new Promise(resolve => setTimeout(resolve, 60)); }, brief: async () => '页' } as unknown as Page;
  const browser = { scratch: <T>(work: (page: Page, signal: AbortSignal) => Promise<T>) => work(page, new AbortController().signal) };
  await createAlarmFacts({ library, browser, perToolMs: 20 })();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(opened, ['https://example.com/1']);
});

test('the per-tool signal is handed to the browser so a queued run that times out opens no tab later', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'computer-alarm-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const library = createProcedureLibrary(dir);
  library.save(JSON.stringify({ name: 'queued', description: 'q', params: {}, onAlarm: true, steps: [{ open: 'https://example.com/1' }] }));
  let given: AbortSignal | undefined;
  const browser = { scratch: (_work: unknown, signal?: AbortSignal) => { given = signal; return new Promise<never>(() => {}); } };
  await createAlarmFacts({ library, browser: browser as never, perToolMs: 20 })();
  assert.equal(given?.aborted, true);
});
