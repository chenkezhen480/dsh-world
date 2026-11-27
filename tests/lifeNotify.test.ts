import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { toastScript, windowsToast } from '../src/life/notify.ts';

const decodeXml = (script: string) => {
  const encoded = [...script.matchAll(/FromBase64String\('([A-Za-z0-9+/=]*)'\)/g)].map(match => Buffer.from(match[1]!, 'base64').toString('utf8'));
  return encoded;
};
const fakeSpawn = (behave: (child: EventEmitter & { stderr: EventEmitter; killed: boolean; kill(): void }) => void) => ((..._args: unknown[]) => {
  const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), killed: false, kill() { this.killed = true; } });
  setImmediate(() => behave(child));
  return child;
}) as never;

test('the toast script never interpolates text and carries escaped XML as base64', () => {
  const title = '鲸’鲸‘';
  const body = `x’; Start-Process calc; ‚‛ ' < & " \u0001ok`;
  const script = toastScript('electron.app.DeepSeek Harness', title, body);
  for (const bad of ['’', '‘', '‚', '‛', 'Start-Process', '鲸', '\u0001']) assert.ok(!script.includes(bad), bad);
  const decoded = decodeXml(script), appId = decoded[0], xmlText = decoded.at(-1);
  assert.equal(appId, 'electron.app.DeepSeek Harness');
  assert.match(xmlText!, /<text>鲸’鲸‘<\/text>/);
  assert.match(xmlText!, /x’; Start-Process calc; ‚‛ &apos; &lt; &amp; &quot; ok<\/text>/);
  assert.ok(!xmlText!.includes('\u0001'));
  assert.match(script, /^\$ErrorActionPreference = 'Stop'; \[Console\]::OutputEncoding = \[Text\.Encoding\]::UTF8/);
  assert.match(script, /try \{[\s\S]*\} catch \{ \[Console\]::Error\.WriteLine\(\$_\.Exception\.Message\); exit 1 \}/);
});
test('the toast script caps the title at 64 and the body at 500 code points', () => {
  const xmlText = decodeXml(toastScript('app', '题'.repeat(70), '😀'.repeat(600))).at(-1);
  assert.ok(xmlText!.includes(`<text>${'题'.repeat(64)}…</text>`));
  assert.ok(xmlText!.includes(`<text>${'😀'.repeat(500)}…</text>`));
  const short = decodeXml(toastScript('app', 'a', 'b'.repeat(500))).at(-1);
  assert.ok(!short!.includes('…'));
});
test('windowsToast rejects with the stderr reason on a non-zero exit', { skip: process.platform !== 'win32' }, async () => {
  const toast = windowsToast('app', fakeSpawn(child => { child.stderr.emit('data', 'boom happened\n'); child.emit('close', 1); }));
  await assert.rejects(toast('t', 'b'), { message: 'powershell 退出码 1：boom happened' });
  await windowsToast('app', fakeSpawn(child => child.emit('close', 0)))('t', 'b');
});
test('windowsToast gives up on a child that never exits', { skip: process.platform !== 'win32' }, async () => {
  let killed = false;
  const spawnImpl = ((..._args: unknown[]) => Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill() { killed = true; } })) as never;
  await assert.rejects(windowsToast('app', spawnImpl, 20)('t', 'b'), { message: /^系统通知超时/ });
  assert.ok(killed);
});

test('without a configured identity the script finds the desktop in the Start menu, newest build first, and fails loudly otherwise', () => {
  const script = toastScript(undefined, 't', 'b');
  const decoded = decodeXml(script);
  assert.equal(decoded[0], '', 'nothing configured');
  assert.deepEqual(decoded.slice(1, 3), ['com.deepseek.dsh', 'electron.app.DeepSeek Harness']);
  assert.match(decoded[3]!, /^开始菜单里找不到 DSH 桌面版的通知身份/);
  assert.match(script, /\$apps = @\(Get-StartApps\)/);
  assert.match(script, /\$_\.Name -like '\*DeepSeek Harness\*'/);
  assert.match(script, /if \(\$setting -ne 0\) \{ .*throw/, 'a switched-off identity is a failure, not a silent success');
  assert.match(script, /\[Console\]::Out\.Write\(\$appId\)/);
});
test('a configured identity is still checked against the Start menu; a reused one skips the lookup', () => {
  const configured = toastScript('com.deepseek.dsh', 't', 'b');
  assert.match(configured, /if \(\$appId\) \{\r?\n  if \(-not \(\$apps \| Where-Object \{ \$_\.AppID -eq \$appId \}\)\) \{ throw/);
  const reused = toastScript('com.deepseek.dsh', 't', 'b', false);
  assert.ok(!reused.includes('Get-StartApps'));
  assert.equal(decodeXml(reused)[0], 'com.deepseek.dsh');
});
test('windowsToast reuses the identity it found and looks again after a failure', { skip: process.platform !== 'win32' }, async () => {
  const scripts: string[] = [];
  const outcomes: (() => [string, number])[] = [() => ['com.deepseek.dsh', 0], () => ['com.deepseek.dsh', 0], () => ['', 1], () => ['electron.app.DeepSeek Harness', 0]];
  const spawnImpl = ((_command: string, args: string[]) => {
    scripts.push(Buffer.from(args[3]!, 'base64').toString('utf16le'));
    const [out, code] = outcomes.shift()!();
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
    setImmediate(() => { if (out) child.stdout.emit('data', out); if (code) child.stderr.emit('data', 'gone'); child.emit('close', code); });
    return child;
  }) as never;
  const toast = windowsToast(undefined, spawnImpl);
  await toast('t', 'b'); await toast('t', 'b');
  await assert.rejects(toast('t', 'b'), /gone/);
  await toast('t', 'b');
  assert.deepEqual(scripts.map(script => script.includes('Get-StartApps')), [true, false, false, true]);
  assert.equal(decodeXml(scripts[1]!)[0], 'com.deepseek.dsh');
});

test('the switched-off check reads the setting as a number and names who switched it off (#72)', { skip: process.platform !== 'win32' }, () => {
  // Only the check itself runs here, against a stand-in notifier: a real one would show a toast.
  const check = toastScript('x', 't', 'b', false).split('\n').filter(line => line.startsWith('$setting') || line.startsWith('if ($setting'));
  assert.equal(check.length, 2);
  const run = (setting: number) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $appId = 'x'; $notifier = [pscustomobject]@{ Setting = ${setting} }; try { ${check.join('; ')}; 'shown' } catch { $_.Exception.Message }`], { encoding: 'utf8' }).stdout.trim();
  assert.equal(run(0), 'shown', 'switched on: no refusal');
  assert.equal(run(1), 'Windows 关闭了 x 的通知（这个程序的通知被关了）');
  assert.equal(run(3), 'Windows 关闭了 x 的通知（组策略关了通知）');
});
