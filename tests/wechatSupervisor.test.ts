import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { createAdapterSupervisor } from '../src/ecosystem/wechat/supervisor.ts';

class FakeChild extends EventEmitter { pid: number; constructor(pid: number) { super(); this.pid = pid; } }
function setup(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-world-supervisor-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const python = join(dir, 'python.exe'), config = join(dir, 'config.json'), script = join(dir, 'adapter.py');
  for (const file of [python, config, script]) writeFileSync(file, '');
  const children: FakeChild[] = [], launches: { command: string; args: string[] }[] = [], logs: string[] = [], killed: number[] = [];
  const supervisor = createAdapterSupervisor({
    python, config, script, logFile: join(dir, 'adapter.log'), minDelayMs: 5, maxDelayMs: 20, log: message => logs.push(message),
    spawnProcess: ((command: string, args: string[]) => { launches.push({ command, args }); const child = new FakeChild(100 + children.length); children.push(child); return child; }) as never,
    killTree: (child: ChildProcess) => { killed.push(child.pid!); queueMicrotask(() => child.emit('exit', null, 'SIGKILL')); },
  });
  return { dir, python, config, script, children, launches, logs, killed, supervisor };
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('the adapter starts with the bound config and an explicit send permission, and stops with its whole tree', async t => {
  const { supervisor, launches, python, config, script, children, killed } = setup(t);
  supervisor.start();
  assert.equal(launches.length, 1);
  assert.equal(launches[0]!.command, python);
  assert.deepEqual(launches[0]!.args, ['-X', 'utf8', '-u', script, 'watch', '--config', config, '--allow-send']);
  assert.deepEqual(supervisor.status(), { running: true, pid: 100, restarts: 0, lastExit: null, error: null, needsHuman: false, building: false });
  await supervisor.stop();
  assert.deepEqual(killed, [children[0]!.pid]);
  assert.equal(supervisor.status().running, false);
  await wait(40);
  assert.equal(launches.length, 1, 'a stopped supervisor never restarts it');
});

test('an exit restarts the adapter after a delay and keeps count', async t => {
  const { supervisor, launches, children, logs } = setup(t);
  supervisor.start();
  children[0]!.emit('exit', 1, null);
  assert.equal(supervisor.status().running, false);
  assert.equal(supervisor.status().lastExit, 'code 1');
  assert.equal(launches.length, 1, 'not at once');
  await wait(60);
  assert.equal(launches.length, 2);
  assert.equal(supervisor.status().restarts, 1);
  assert.match(logs[0]!, /exited \(code 1\)/);
  await supervisor.stop();
});

test('a file that is missing at start is retried and the adapter comes up once it is back', async t => {
  const { supervisor, launches, python, dir } = setup(t);
  rmSync(python);
  supervisor.start();
  assert.equal(launches.length, 0);
  assert.match(supervisor.status().error ?? '', /Python不存在/);
  writeFileSync(python, '');
  await wait(60);
  assert.equal(launches.length, 1);
  assert.equal(supervisor.status().error, null);
  assert.equal(supervisor.status().restarts, 0, 'waiting for a file is not a restart');
  await supervisor.stop();
  assert.ok(readdirSync(dir).includes('config.json'));
});

test('an exit that asks for a person is not retried until the console restarts it', async t => {
  const { supervisor, launches, children } = setup(t);
  supervisor.start();
  children[0]!.emit('exit', 2, null);
  assert.equal(supervisor.status().needsHuman, true);
  await wait(60);
  assert.equal(launches.length, 1, 'retrying cannot help');
  await supervisor.restart();
  assert.equal(launches.length, 2);
  assert.equal(supervisor.status().needsHuman, false);
  assert.equal(supervisor.status().running, true);
  await supervisor.stop();
});

test('restarting a running adapter replaces it once, without a second automatic restart', async t => {
  const { supervisor, launches, killed, children } = setup(t);
  supervisor.start();
  await supervisor.restart();
  assert.deepEqual(killed, [children[0]!.pid]);
  await wait(60);
  assert.equal(launches.length, 2);
  assert.equal(supervisor.status().restarts, 1);
  await supervisor.stop();
});

test('a stale native bridge is built again into the engine folder beside the config, and the adapter starts after it', async t => {
  const { supervisor, launches, children, config, dir } = setup(t);
  supervisor.start();
  children[0]!.emit('exit', 3, null);
  assert.equal(launches.length, 2);
  assert.equal(launches[1]!.command, 'powershell.exe');
  assert.deepEqual(launches[1]!.args.slice(-2), ['-OutDir', join(dir, 'engine')]);
  assert.equal(join(config, '..', 'engine'), join(dir, 'engine'));
  assert.equal(supervisor.status().building, true);
  await supervisor.restart();
  assert.equal(launches.length, 2, 'the console waits for the build');
  children[1]!.emit('exit', 0, null);
  assert.equal(supervisor.status().building, false);
  assert.equal(launches.length, 3); assert.equal(supervisor.status().running, true);
  assert.equal(supervisor.status().error, null);
  await supervisor.stop();
});

test('a build that fails, or one that still does not match, stops with what to do instead of looping', async t => {
  const failing = setup(t);
  failing.supervisor.start();
  failing.children[0]!.emit('exit', 3, null);
  failing.children[1]!.emit('exit', 1, null);
  await wait(60);
  assert.equal(failing.launches.length, 2, 'no retry');
  assert.match(failing.supervisor.status().error ?? '', /自动构建没成功[\s\S]*wechat\.ps1 Build/);
  await failing.supervisor.stop();

  const stale = setup(t);
  stale.supervisor.start();
  stale.children[0]!.emit('exit', 3, null);
  stale.children[1]!.emit('exit', 0, null);
  stale.children[2]!.emit('exit', 3, null);
  await wait(60);
  assert.equal(stale.launches.length, 3, 'built once; building again cannot help');
  assert.match(stale.supervisor.status().error ?? '', /刚重新构建过，仍然对不上/);
  await stale.supervisor.restart();
  assert.equal(stale.launches.length, 4, 'the console restart tries again');
  assert.equal(stale.supervisor.status().error, null);
  await stale.supervisor.stop();
});

test('an exit carries the last thing the adapter said in its log', async t => {
  const { supervisor, children, dir } = setup(t);
  writeFileSync(join(dir, 'adapter.log'), '上一次的话\n');
  supervisor.start();
  appendFileSync(join(dir, 'adapter.log'), '开始监听所选聊天；Ctrl+C 停止。\r\n微信适配器停止：不能唯一核对微信核心 DLL\r\n');
  children[0]!.emit('exit', 1, null);
  assert.equal(supervisor.status().lastExit, 'code 1：微信适配器停止：不能唯一核对微信核心 DLL');
  await supervisor.stop();
});
