// tests/worldAdd.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { addWorldEntry } from '../src/worldAdd.ts';
import { worldListRoute } from '../src/worldRoutes.ts';

const PATCH = `# my patch layer\n- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n  config:\n    transcriptView: standard\n\n# dsh-world: 鲸鲸\n- id: dsh-world\n  name: dsh-world\n  config:\n    worldId: jingjing\n    companionName: 鲸鲸\n`;
const ROW = (id: string, name?: string) => `# dsh-world：从世界控制台新增的世界。\n- insert:\n    - id: dsh-world-${id}\n      name: dsh-world\n      config:\n        worldId: ${id}\n${name ? `        companionName: ${JSON.stringify(name)}\n` : ''}`;
function patchFile(t: test.TestContext, content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'world-add-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'cordis.patch.yml');
  if (content !== undefined) writeFileSync(file, content);
  return file;
}

test('a new world is appended as its own row, and every line already in the file stays as it was', t => {
  const file = patchFile(t, PATCH);
  addWorldEntry(file, 'tata', '塔塔');
  assert.equal(readFileSync(file, 'utf8'), `${PATCH}\n${ROW('tata', '塔塔')}`);
  addWorldEntry(file, 'third', '');
  assert.equal(readFileSync(file, 'utf8'), `${PATCH}\n${ROW('tata', '塔塔')}\n${ROW('third')}`);
  const windows = patchFile(t, PATCH.replace(/\n/g, '\r\n'));
  addWorldEntry(windows, 'tata', '');
  assert.equal(readFileSync(windows, 'utf8').startsWith(PATCH.replace(/\n/g, '\r\n').trimEnd()), true);
});

test('a profile with no patch yet gets one; one that is not a list of rows is left alone', t => {
  for (const before of [undefined, '', '[]\n']) {
    const file = patchFile(t, before);
    addWorldEntry(file, 'tata', '');
    assert.equal(readFileSync(file, 'utf8'), ROW('tata'));
  }
  // What the host writes into a new profile: its comment, then an empty list.
  for (const before of ['# nothing yet\n', '# nothing yet\n[]\n', '# nothing yet\r\n[]\r\n']) {
    const commented = patchFile(t, before);
    addWorldEntry(commented, 'tata', '');
    assert.equal(readFileSync(commented, 'utf8').replace(/\r/g, ''), `# nothing yet\n\n${ROW('tata')}`);
    addWorldEntry(commented, 'third', '');
    assert.equal(readFileSync(commented, 'utf8').replace(/\r/g, ''), `# nothing yet\n\n${ROW('tata')}\n${ROW('third')}`);
  }
  const flow = patchFile(t, '[{ id: a, name: b }]\n');
  assert.throws(() => addWorldEntry(flow, 'tata', ''), /不是逐条列出的格式，请手动添加/);
  assert.equal(readFileSync(flow, 'utf8'), '[{ id: a, name: b }]\n');
});

test('a world that is already there, or a name that could not be a folder, is refused and nothing is written', t => {
  const file = patchFile(t, PATCH);
  assert.throws(() => addWorldEntry(file, 'jingjing', ''), /配置里已经有 jingjing 这个世界了/);
  assert.throws(() => addWorldEntry(file, 'JingJing', ''), /已经有/, 'folders differ by more than case');
  assert.throws(() => addWorldEntry(file, '../x', ''), /只能用字母、数字/);
  assert.throws(() => addWorldEntry(file, '塔塔', ''), /只能用字母、数字/);
  addWorldEntry(file, 'jing', '');
  assert.throws(() => addWorldEntry(file, 'jing', ''), /已经有 jing /, 'a name that only starts another is its own');
  assert.equal(readFileSync(file, 'utf8'), `${PATCH}\n${ROW('jing')}`);
});

async function ask(route: ReturnType<typeof worldListRoute>, method: string, headers: Record<string, string>, body?: unknown) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url: '/dsh-world/worlds', headers: { host: 'localhost:3000', ...headers } }) as unknown as IncomingMessage;
  let status = 0, text = '';
  const res = { writeHead: (code: number) => { status = code; }, end: (chunk: string) => { text = chunk; } } as unknown as ServerResponse;
  await route.handler(req, res);
  return { status, body: JSON.parse(text) as Record<string, unknown> };
}
const WRITE = { 'x-dsh-world': '1', 'content-type': 'application/json' };

test('the world list takes a new world only as a write from this machine, and says a restart is needed', async () => {
  const added: [string, string][] = [];
  const route = worldListRoute(new Map([['jingjing', []]]), async (id, name) => { if (id === 'jingjing') throw new Error('jingjing 这个世界已经加载了'); added.push([id, name]); });
  assert.deepEqual(await ask(route, 'POST', WRITE, { worldId: ' tata ', companionName: ' 塔塔 ' }), { status: 200, body: { ok: true, worldId: 'tata', restartRequired: true } });
  assert.deepEqual(added, [['tata', '塔塔']]);
  assert.deepEqual(await ask(route, 'POST', WRITE, { worldId: 'jingjing' }), { status: 409, body: { error: 'jingjing 这个世界已经加载了' } });
  assert.equal((await ask(route, 'POST', { 'content-type': 'application/json' }, { worldId: 'x' })).status, 400, 'without the write header');
  assert.equal((await ask(route, 'POST', WRITE, { companionName: '塔塔' })).status, 400);
  assert.equal((await ask(route, 'POST', WRITE, { worldId: 'x', companionName: '长'.repeat(41) })).status, 400);
  assert.equal((await ask(route, 'POST', { ...WRITE, 'sec-fetch-site': 'cross-site' }, { worldId: 'x' })).status, 403);
  assert.equal((await ask(route, 'POST', { ...WRITE, host: 'evil.example' }, { worldId: 'x' })).status, 403);
  assert.equal(added.length, 1);
  assert.deepEqual((await ask(route, 'GET', {})).body, { worldIds: ['jingjing'], nextOffset: null });
  assert.equal((await ask(worldListRoute(new Map([['jingjing', []]])), 'POST', WRITE, { worldId: 'x' })).status, 405, 'a list that cannot add says so');
});
