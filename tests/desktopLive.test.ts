// tests/desktopLive.test.ts
// On the real desktop, with WeChat open: set DSH_WORLD_DESKTOP_TEST=1. Nothing is clicked or typed, and no screen
// content is printed: only sizes and the plugin's own words.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Faults } from '../src/faults.ts';
import { createDesktop } from '../src/ecosystem/computer/desktop/desktop.ts';
import { createDesktopDriver } from '../src/ecosystem/computer/desktop/driver.ts';

const live = { skip: !process.env.DSH_WORLD_DESKTOP_TEST || process.platform !== 'win32' };

test('WeChat with a window is pictured at real pixels and a part of it zoomed, with the pointer left alone', live, async t => {
  const faults = new Faults();
  const driver = createDesktopDriver({ faults });
  t.after(() => driver.stop());
  const desktop = createDesktop({ driver });
  const pointer = (await driver.call('cursor')).cursor;
  assert.match((await desktop.act({ action: 'open' })).text, /^开着的窗口：/);
  const opened = await desktop.act({ action: 'open', app: '微信' });
  console.log(opened.text.split('\n').join(' / '));
  assert.match(opened.text, /微信 的截图附在下一条消息里（\d+×\d+）/);
  assert.ok(opened.image && opened.image.data.length > 10_000, 'a real picture, not a black one');
  assert.ok((await desktop.act({ action: 'zoom', x: 0, y: 0, x2: 200, y2: 120 })).image);
  assert.deepEqual((await driver.call('cursor')).cursor, pointer);
  assert.deepEqual(faults.list(), []);
});
