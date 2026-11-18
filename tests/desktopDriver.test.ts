// tests/desktopDriver.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Faults } from '../src/faults.ts';
import { createDesktopDriver } from '../src/ecosystem/computer/desktop/driver.ts';

const fixture = (name: string) => [process.execPath, fileURLToPath(new URL(`./fixtures/desktop/${name}.mjs`, import.meta.url))];

test('calls go to the helper started on first use and come back with its answer', async t => {
  const faults = new Faults();
  const driver = createDesktopDriver({ faults, command: fixture('echo') });
  t.after(() => driver.stop());
  assert.equal(driver.running(), false, 'nothing starts before she uses the desktop');
  assert.deepEqual(await driver.call('click', { hwnd: 7, x: 1, y: 2 }), { op: 'click', args: { hwnd: 7, x: 1, y: 2 } });
  assert.equal(driver.running(), true);
  await assert.rejects(driver.call('refuse'), /window 7 is gone/, 'a refusal carries the reason');
  assert.deepEqual(faults.list(), []);
});

test('a crash fails what is pending and is a fault; the next call starts it again', async t => {
  const faults = new Faults();
  const driver = createDesktopDriver({ faults, command: fixture('echo') });
  t.after(() => driver.stop());
  await driver.call('windows');
  await assert.rejects(driver.call('crash'), /助手退出了/);
  assert.match(faults.list().join(), /她用电脑的助手退出了/);
  assert.deepEqual(await driver.call('windows'), { op: 'windows', args: {} });
  assert.deepEqual(faults.list(), [], 'a working call clears it');
});

test('a helper that dies before answering is tried twice, then says why and stays down until stopped', async t => {
  const faults = new Faults();
  const driver = createDesktopDriver({ faults, command: fixture('dies') });
  t.after(() => driver.stop());
  await assert.rejects(driver.call('windows'), /无法编译/);
  await assert.rejects(driver.call('windows'), /无法编译/);
  await assert.rejects(driver.call('windows'), /^Error: 她用电脑的助手起不来：Add-Type : 无法编译/);
  assert.equal(driver.running(), false, 'not relaunched on every step');
  driver.stop();
  assert.deepEqual(faults.list(), []);
});

test('a call that hangs times out with an unknown outcome and the helper is replaced', async t => {
  const faults = new Faults();
  const driver = createDesktopDriver({ faults, command: fixture('hangs'), callMs: 200 });
  t.after(() => driver.stop());
  await assert.rejects(driver.call('click'), /没有回应，结果不明/);
  assert.equal(driver.running(), false);
  assert.match(faults.list().join(), /卡住/);
});

test('turning it off fails what is pending', async () => {
  const driver = createDesktopDriver({ faults: new Faults(), command: fixture('hangs') });
  const call = driver.call('click');
  driver.stop();
  await assert.rejects(call, /开关关掉了/);
  assert.equal(driver.running(), false);
});
