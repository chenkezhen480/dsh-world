import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { browserCandidates, findBrowser, launchArgs, launchBrowser, runningPort } from '../src/ecosystem/computer/browser/edge.ts';

test('Edge is looked for before Chrome, machine-wide before per-user', () => {
  const list = browserCandidates({ 'PROGRAMFILES(X86)': 'X86', PROGRAMFILES: 'PF', LOCALAPPDATA: 'LA' });
  assert.equal(list.length, 6);
  assert.match(list[0]!, /X86.*Microsoft.*Edge.*msedge\.exe$/);
  assert.match(list[2]!, /LA.*msedge\.exe$/);
  assert.match(list[3]!, /X86.*Google.*chrome\.exe$/);
  assert.equal(findBrowser(list, path => path === list[4]), list[4]);
  assert.equal(findBrowser(list, () => false), undefined);
});

test('her browser runs on its own profile, with no origin allowed to the debugging port', () => {
  const args = launchArgs('D:/w/browser');
  assert.ok(args.includes('--user-data-dir=D:/w/browser'));
  assert.ok(args.includes('--remote-debugging-port=0'));
  assert.ok(!args.some(arg => arg.startsWith('--remote-allow-origins')));
  assert.ok(!args.some(arg => arg.startsWith('--headless')));
});

test('a port file is trusted only while the browser answers on it', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'computer-edge-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(await runningPort(dir), 0);
  writeFileSync(join(dir, 'DevToolsActivePort'), '9333\n/devtools/browser/x');
  const answering = (async () => new Response('{}')) as typeof fetch;
  assert.equal(await runningPort(dir, answering), 9333);
  const silent = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
  assert.equal(await runningPort(dir, silent), 0);
  assert.equal(existsSync(join(dir, 'DevToolsActivePort')), false);
});

test('a browser that cannot be started is reported, not waited for', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'computer-edge-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(launchBrowser(join(dir, 'missing.exe'), dir, 2000), /浏览器没能启动/);
});
