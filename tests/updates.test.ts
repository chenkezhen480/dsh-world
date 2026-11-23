import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { setImmediate as nextImmediate } from 'node:timers/promises';
import { createUpdateCheck, upgradeCommand, upgradeTools } from '../src/console/updates.ts';
import { isNewerVersion, meetsRange } from '../src/packageInstall.ts';

test('a newer release is one with a larger number; a pre-release comes before the version it leads up to', () => {
  assert.equal(isNewerVersion('0.8.1', '0.8.0'), true);
  assert.equal(isNewerVersion('0.10.0', '0.9.9'), true, 'numbers, not text');
  assert.equal(isNewerVersion('1.0.0', '0.99.0'), true);
  assert.equal(isNewerVersion('0.8.0', '0.8.0'), false);
  assert.equal(isNewerVersion('0.7.6', '0.8.0'), false, 'an older npm release never asks her partner to go back');
  assert.equal(isNewerVersion('0.8.0', '0.8.0-dev.16'), true);
  assert.equal(isNewerVersion('0.8.0-dev.17', '0.8.0-dev.16'), false, 'pre-releases are not compared among themselves');
  assert.equal(isNewerVersion('not a version', '0.8.0'), false);
  assert.equal(meetsRange('0.2.3-rc.1', '^0.2.1'), true, 'the range check reads versions the same way');
});

function world(answers: (() => Promise<Response>)[]) {
  const asked: { url: string; headers: unknown }[] = [];
  let pending: (() => void) | undefined, delay: number | undefined;
  const check = createUpdateCheck({
    current: '0.8.0', repository: 'git+https://github.com/owner/dsh-world.git',
    fetch: (async (url: string, init: { headers?: unknown }) => { asked.push({ url, headers: init.headers }); return answers.shift()!(); }) as unknown as typeof fetch,
    timers: { set: (fn: () => void, ms: number) => { pending = fn; delay = ms; return fn; }, clear: () => { pending = undefined; } },
    clock: () => new Date('2026-11-19T10:00:00.000Z'),
  });
  const settle = async () => { for (let round = 0; round < 3; round++) await nextImmediate(); };
  return { check, asked, settle, tick: async () => { const fn = pending; pending = undefined; fn?.(); await settle(); }, armed: () => pending !== undefined, delay: () => delay };
}
const answer = (version: string) => async () => new Response(JSON.stringify({ name: 'dsh-world', version }), { status: 200 });

test('npm is asked when it starts and once a day after; only the package is named, and a failure keeps what was found', async () => {
  const w = world([answer('0.8.1'), async () => { throw new Error('getaddrinfo ENOTFOUND'); }, answer('0.8.0')]);
  assert.deepEqual(w.check.status(), { current: '0.8.0', newer: false, changelog: 'https://github.com/owner/dsh-world/blob/main/CHANGELOG.md', upgrade: 'https://github.com/owner/dsh-world/blob/main/INSTALL.md#已有-world用编译包更新' });
  w.check.start(); await w.settle();
  assert.deepEqual(w.asked, [{ url: 'https://registry.npmjs.org/dsh-world/latest', headers: { accept: 'application/json' } }]);
  assert.deepEqual([w.check.status().latest, w.check.status().newer, w.check.status().checkedAt], ['0.8.1', true, '2026-11-19T10:00:00.000Z']);
  assert.equal(w.delay(), 24 * 60 * 60_000);
  await w.tick();
  assert.deepEqual([w.check.status().latest, w.check.status().newer, w.check.status().error], ['0.8.1', true, 'getaddrinfo ENOTFOUND'], 'a day without a network still remembers the newer release');
  await w.tick();
  assert.deepEqual([w.check.status().newer, w.check.status().error], [false, undefined]);
  w.check.stop();
  assert.equal(w.armed(), false, 'stopped, nothing more is asked');
});

test('the upgrade command is filled in from what DSH says about this machine: its profile, its pnpm, and the Node beside it', () => {
  const pnpm = 'D:\\DSH\\resources\\runtime\\primary-runtime\\dependencies\\pnpm\\bin\\pnpm.mjs';
  const node = 'D:\\DSH\\resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe';
  const profile = { dir: "C:\\Users\\o'neil\\.dsh\\profiles\\desktop", name: 'desktop', packageManager: { command: 'D:\\DSH\\DeepSeek Harness.exe', args: ['--expose-internals', pnpm] } };
  const tools = upgradeTools(profile, 'win32', path => path === node)!;
  assert.deepEqual(tools, { platform: 'win32', profileDir: profile.dir, pnpm, node });
  assert.equal(upgradeTools(profile, 'win32', () => false)!.node, 'node', 'without the bundled Node, the one on PATH');
  assert.equal(upgradeTools({ dir: profile.dir, name: 'desktop' }, 'win32', () => true), undefined, 'DSH did not say where its pnpm is');
  const { command, shell } = upgradeCommand(tools, '0.8.1', 'https://registry.npmjs.org/dsh-world/-/dsh-world-0.8.1.tgz');
  assert.equal(shell, 'PowerShell');
  assert.match(command, /^# 先从应用菜单正常退出 DSH/);
  // The updater that runs is the one inside the release being installed, never the copy in the install it replaces.
  assert.match(command, /Invoke-WebRequest -UseBasicParsing -Uri 'https:\/\/registry\.npmjs\.org\/dsh-world\/-\/dsh-world-0\.8\.1\.tgz' -OutFile \$archive[^]*Push-Location \$work\n  try \{ tar -xzf 'dsh-world-0\.8\.1\.tgz' package\/scripts\/update-world\.mjs \} finally \{ Pop-Location \}/);  assert.match(command, /& 'D:\\DSH\\[^']*node\.exe' \(Join-Path \$work 'package\/scripts\/update-world\.mjs'\) --profile 'C:\\Users\\o''neil\\\.dsh\\profiles\\desktop' --package \$archive --pnpm 'D:\\DSH\\[^']*pnpm\.mjs'/, 'an apostrophe in a path is doubled, not left to end the quote');
  assert.doesNotMatch(command, /Copy-Item/);
  const posixTools = { platform: 'darwin' as const, profileDir: "/Users/o'neil/.dsh/profiles/desktop", pnpm: '/Applications/DSH/pnpm.mjs', node: '/Applications/DSH/node' };
  const sh = upgradeCommand(posixTools, '0.8.1', 'https://registry.npmjs.org/x.tgz');
  assert.equal(sh.shell, '终端');
  assert.match(sh.command, /curl -fL -o "\$archive" 'https:\/\/registry\.npmjs\.org\/x\.tgz' &&\ntar -xzf "\$archive" -C "\$work" package\/scripts\/update-world\.mjs &&\n'\/Applications\/DSH\/node' "\$work\/package\/scripts\/update-world\.mjs" --profile '\/Users\/o'\\''neil\/\.dsh\/profiles\/desktop'/);
});

test('a newer release comes with the command, using the address npm gives for it; an older or equal one has none', async () => {
  const tools = { platform: 'win32' as const, profileDir: 'C:\\p', pnpm: 'C:\\pnpm.mjs', node: 'node' };
  const release = (version: string, tarball: string) => async () => new Response(JSON.stringify({ version, dist: { tarball } }), { status: 200 });
  const w = world([release('0.8.1', 'https://registry.npmjs.org/dsh-world/-/dsh-world-0.8.1.tgz'), release('0.8.2', 'https://evil.example/x.tgz'), release('0.8.0', 'https://registry.npmjs.org/dsh-world/-/dsh-world-0.8.0.tgz')]);
  w.check.start(); await w.settle();
  assert.match(w.check.status(tools).command!, /dsh-world-0\.8\.1\.tgz/);
  assert.equal(w.check.status().command, undefined, 'without this machine\'s paths there is no command, only the instructions');
  await w.tick();
  assert.match(w.check.status(tools).command!, /-Uri 'https:\/\/registry\.npmjs\.org\/dsh-world\/-\/dsh-world-0\.8\.2\.tgz'/, 'an address off npm never goes into the command');
  await w.tick();
  assert.equal(w.check.status(tools).command, undefined, 'nothing to upgrade to');
  w.check.stop();
});

test('stopping ends a look still waiting for npm, and leaves what was found as it was', async () => {
  let signal: AbortSignal | undefined;
  const check = createUpdateCheck({
    current: '0.8.0', repository: 'git+https://github.com/owner/dsh-world.git',
    fetch: ((_url: string, init: { signal: AbortSignal }) => { signal = init.signal; return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))); }) as unknown as typeof fetch,
    timers: { set: () => 0, clear: () => {} },
  });
  check.start(); await nextImmediate();
  assert.equal(signal?.aborted, false);
  check.stop(); await nextImmediate();
  assert.equal(signal?.aborted, true, 'DSH closing does not wait up to fifteen seconds for npm');
  assert.equal(check.status().error, undefined, 'a look called off is not a failure');
});

test('a version that only starts like one is not taken, so nothing of it reaches the command', async () => {
  const w = world([answer('0.9.0"$(touch x)"'), answer('0.9.0-rc.1 x')]);
  w.check.start(); await w.settle();
  assert.deepEqual([w.check.status().latest, w.check.status().error], [undefined, 'npm 给的版本号认不出来']);
  await w.tick();
  assert.deepEqual([w.check.status().latest, w.check.status().newer], [undefined, false]);
  w.check.stop();
});

test('the console shows a newer release with where to read about it, and says so when it could not look', async () => {
  const source = await readFile('client/index.js', 'utf8');
  let loaded: { factory: (require: (name: string) => unknown) => { __test: (worldId: string) => { UpdateNotice: unknown } } } | undefined;
  const react = { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }), useState: (value: unknown) => [value, () => {}], useEffect: () => {}, useRef: (current: unknown) => ({ current }) };
  runInNewContext(source, { fetch: () => Promise.reject(new Error('no fetch')), window: { __ModuleLoader__: { load: (entry: typeof loaded) => { loaded = entry; } } } });
  const { UpdateNotice } = loaded!.factory(() => react).__test('fish');
  type El = { type: unknown; props: Record<string, unknown> | null; children: unknown[] };
  const text = (node: unknown): string => {
    if (node == null || typeof node === 'boolean') return '';
    if (Array.isArray(node)) return node.map(text).join('');
    if (typeof node !== 'object') return String(node);
    const el = node as El;
    if (typeof el.type === 'function') return text((el.type as (p: unknown) => unknown)({ ...el.props, children: el.children }));
    return text(el.children);
  };
  const render = (update: unknown) => text(react.createElement(UpdateNotice, { update }));
  const links = { changelog: 'https://example/CHANGELOG.md', upgrade: 'https://example/INSTALL.md' };
  assert.match(render({ current: '0.8.0', latest: '0.8.1', newer: true, ...links }), /有新版本dsh-world 0\.8\.1 已经发布，现在用的是 0\.8\.0。升级要先正常退出 DSH[^]*更新日志 · 怎么升级/);
  assert.doesNotMatch(render({ current: '0.8.0', latest: '0.8.1', newer: true, ...links }), /看看要运行的命令/, 'no command known, no button');
  const withCommand = render({ current: '0.8.0', latest: '0.8.1', newer: true, ...links, command: '& { THE_COMMAND }', shell: 'PowerShell' });
  assert.match(withCommand, /更新看看要运行的命令& \{ THE_COMMAND \}/, 'the button, and the command itself to read or copy by hand');
  assert.equal(render({ current: '0.8.1', latest: '0.8.1', newer: false, ...links }), '', 'up to date, nothing at all');
  assert.equal(render(null), '', 'the check is off');
  assert.equal(render({ current: '0.8.0', newer: false, error: 'getaddrinfo ENOTFOUND', ...links }), '没查到有没有新版本：getaddrinfo ENOTFOUND（明天再查）');
  assert.equal(render({ current: '0.8.1', latest: '0.8.1', newer: false, error: 'npm 回了 503', ...links }), '没查到有没有新版本：npm 回了 503（明天再查）', 'a failed look after one that found nothing newer is not shown as up to date');
});
