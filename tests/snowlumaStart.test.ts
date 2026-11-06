import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSnowluma } from '../src/ecosystem/qq/snowluma-start.ts';
import { createSnowlumaSupervisor } from '../src/ecosystem/qq/supervisor.ts';

const realSpawn = childProcess.spawn;
const realSpawnSync = childProcess.spawnSync;

function setup(t: test.TestContext, realLookup = false) {
  const home = mkdtempSync(join(tmpdir(), "dsh SnowLuma's-测试-"));
  writeFileSync(join(home, 'index.mjs'), '');
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(home, { recursive: true, force: true }); });
  const state = { running: false, task: false, queryError: false, spawns: 0, taskRuns: 0 };
  const child = Object.assign(new EventEmitter(), { unref() {} });
  t.mock.method(childProcess, 'spawnSync', (command: string, args: string[], options: childProcess.SpawnSyncOptions) => {
    if (command === 'schtasks') {
      if (args[0] === '/run') state.taskRuns++;
      return { status: state.task ? 0 : 1 };
    }
    if (realLookup) return realSpawnSync(command, args, options);
    return { status: state.queryError ? 1 : 0, stdout: state.running ? (process.platform === 'win32' ? '1234\n' : `node ${home}/index.mjs\n`) : '' };
  });
  t.mock.method(childProcess, 'spawn', () => { state.spawns++; return child; });
  syncBuiltinESMExports();
  return { home, state, child };
}

test('an existing SnowLuma is not started again even when OneBot is not ready (#38)', t => {
  const { home, state } = setup(t);
  state.running = true;
  assert.equal(startSnowluma(home).started, false);
  assert.equal(state.spawns, 0);
  assert.equal(state.taskRuns, 0);
});

test('the real process lookup handles spaces, quotes and path separators without matching a neighbouring directory', async t => {
  const { home, state } = setup(t, true);
  const neighbour = `${home}-other`;
  mkdirSync(neighbour);
  t.after(() => rmSync(neighbour, { recursive: true, force: true }));
  async function launch(dir: string) {
    const script = join(dir, 'index.mjs');
    writeFileSync(script, 'setInterval(() => {}, 1000)');
    const child = realSpawn(process.execPath, [script.replace(/\\/g, '/')], { windowsHide: true, stdio: 'ignore' });
    t.after(async () => { const exited = once(child, 'exit'); child.kill(); await exited; });
    await once(child, 'spawn');
  }
  await launch(neighbour);
  assert.equal(startSnowluma(home).started, true, 'a neighbouring installation does not block this one');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 120_000 });
  await launch(home);
  assert.equal(startSnowluma(home).alreadyRunning, true, 'finds an existing instance after the in-memory startup wait expired');
  assert.equal(state.spawns, 1);
});

test('watchdog checks and the manual start share the startup wait and count only real launches (#38)', async t => {
  const { home, state } = setup(t);
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1_000_000 });
  const watchdog = createSnowlumaSupervisor({ homeDir: home, host: '127.0.0.1', port: 3001, probe: async () => false, log() {} });
  t.after(() => watchdog.stop());
  watchdog.start(); await Promise.resolve();
  startSnowluma(home);
  t.mock.timers.tick(30_000); await Promise.resolve();
  assert.equal(state.spawns, 1, 'a slow start must not spawn another copy');
  state.running = true;
  for (let i = 0; i < 4; i++) { t.mock.timers.tick(30_000); await Promise.resolve(); }
  assert.equal(state.spawns, 1, 'a running instance is still left alone after the startup wait');
  assert.equal(watchdog.status().restarts, 1);
  assert.match(watchdog.status().lastError ?? '', /运行|启动/);
});

test('a scheduled start also waits, and a vanished instance can be started after the wait', { skip: process.platform !== 'win32' }, t => {
  const { home, state } = setup(t);
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  state.task = true;
  assert.equal(startSnowluma(home).how, 'task');
  startSnowluma(home);
  assert.equal(state.taskRuns, 1, 'the task may not have created its process yet');
  t.mock.timers.tick(120_000);
  assert.equal(startSnowluma(home).started, true);
  assert.equal(state.taskRuns, 2, 'no process remains: starting again is allowed');
  assert.equal(state.spawns, 0);
});

test('a failed process lookup prevents an unchecked launch', t => {
  const { home, state } = setup(t);
  state.queryError = true;
  const result = startSnowluma(home);
  assert.equal(result.started, false);
  assert.ok(result.error);
  assert.equal(state.spawns, 0);
  assert.equal(state.taskRuns, 0);
});

test('an asynchronous spawn error is reported and does not crash or immediately retry', t => {
  const { home, state, child } = setup(t);
  startSnowluma(home);
  child.emit('error', new Error('node missing'));
  assert.match(startSnowluma(home).error ?? '', /node missing/);
  assert.equal(state.spawns, 1);
});

test('a stopped watchdog does not launch after its pending port probe finishes', async t => {
  let finish!: (alive: boolean) => void;
  let launches = 0;
  const watchdog = createSnowlumaSupervisor({
    homeDir: 'unused', host: '127.0.0.1', port: 3001,
    probe: () => new Promise(resolve => { finish = resolve; }),
    launch: () => { launches++; return { started: true }; }, log() {},
  });
  t.after(() => watchdog.stop());
  watchdog.start(); watchdog.stop(); finish(false);
  await Promise.resolve();
  assert.equal(launches, 0);
});
