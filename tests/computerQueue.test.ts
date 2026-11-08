import assert from 'node:assert/strict';
import test from 'node:test';
import { createChannelQueue } from '../src/ecosystem/shared/turn.ts';

test('a queue can name its own timeout', async () => {
  const queue = createChannelQueue('浏览器', { limit: 2, timeoutMs: 20, timeoutMessage: '浏览器操作超时' });
  await assert.rejects(queue.run(cancelled => cancelled), /^Error: 浏览器操作超时$/);
  const plain = createChannelQueue('QQ', { limit: 2, timeoutMs: 20 });
  await assert.rejects(plain.run(cancelled => cancelled), /QQ home reply timed out/);
});
