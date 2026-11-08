import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { connectCdp } from '../src/ecosystem/computer/browser/cdp.ts';

async function fakeBrowser(t: test.TestContext, answer: (message: { id: number; method: string }) => object | undefined) {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const sockets: import('ws').WebSocket[] = [];
  server.on('connection', socket => {
    sockets.push(socket);
    socket.on('message', raw => {
      const message = JSON.parse(String(raw));
      const reply = answer(message);
      if (reply) socket.send(JSON.stringify({ id: message.id, ...reply }));
    });
  });
  t.after(() => new Promise<void>(resolve => { for (const socket of sockets) socket.close(); server.close(() => resolve()); }));
  return { url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`, sockets };
}

test('requests are matched to their answers, errors keep the method name, events reach listeners', async t => {
  const browser = await fakeBrowser(t, message => message.method === 'Bad.thing' ? { error: { message: 'nope' } } : { result: { echoed: message.method } });
  const cdp = await connectCdp(browser.url);
  t.after(() => cdp.close());
  assert.deepEqual(await cdp.send('Page.enable'), { echoed: 'Page.enable' });
  await assert.rejects(cdp.send('Bad.thing'), /Bad\.thing: nope/);
  const seen = new Promise<string>(resolve => cdp.on(method => resolve(method)));
  browser.sockets[0]!.send(JSON.stringify({ method: 'Page.loadEventFired', params: {} }));
  assert.equal(await seen, 'Page.loadEventFired');
});

test('a request the browser never answers times out, and a closed socket fails what is pending', async t => {
  const browser = await fakeBrowser(t, () => undefined);
  const cdp = await connectCdp(browser.url, { timeoutMs: 30 });
  await assert.rejects(cdp.send('Runtime.evaluate'), /Runtime\.evaluate: 浏览器没有回应/);
  const pending = cdp.send('Page.navigate');
  browser.sockets[0]!.close();
  await assert.rejects(pending, /浏览器连接已断开/);
  assert.equal(cdp.closed, true);
  await assert.rejects(cdp.send('Page.enable'), /浏览器连接已断开/);
});
