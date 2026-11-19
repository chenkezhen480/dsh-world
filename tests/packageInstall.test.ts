import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPackageInstaller, meetsRange, type HostInstaller } from '../src/packageInstall.ts';

const SDK = { name: '@snowluma/sdk', label: 'SnowLuma SDK' };

test('SDK availability needs no package operation, while a missing SDK is installed only once and needs restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'qq-sdk-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), '{"dependencies":{"dsh-world":"1.0.0"}}');
  let exists = true, calls = 0; const args: string[][] = [];
  const host: HostInstaller = {
    withFileLock: async (_path, work) => work(), writeFileAtomic: async (file, bytes) => { await writeFile(file, bytes); },
    runProfilePnpm: async (_profile, values, options) => { calls++; args.push(values); assert.equal((options.env as Record<string, string>).npm_config_ignore_scripts, 'true'); return { exitCode: 0, output: '', incompatible: [] }; },
  };
  const sdk = createPackageInstaller({ ...SDK, available: () => exists, profile: () => ({ dir: root, name: 'test', packageManager: { command: 'host-node', args: ['host-pnpm.mjs'] } }), loadHost: async () => host, signal: new AbortController().signal });
  assert.equal(await sdk.ensure(), false); assert.equal(calls, 0);
  exists = false;
  const [a, b] = await Promise.all([sdk.ensure(), sdk.ensure()]);
  assert.equal(a, true); assert.equal(b, true); assert.equal(calls, 2); assert.equal(sdk.needsRestart(), true);
  assert.deepEqual(args[0], ['--version']);
  assert.deepEqual(args[1]!.slice(0, 2), ['add', '@snowluma/sdk@^2.2.1']);
  assert.ok(args[1]!.includes('--ignore-scripts')); assert.ok(args[1]!.includes('--config.engine-strict=true'));
});
test('a rejected or cancelled install restores the profile and does not mark QQ ready', async t => {
  const root = await mkdtemp(join(tmpdir(), 'qq-sdk-fail-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'package.json'), original = '{"dependencies":{"dsh-world":"1.0.0"}}'; await writeFile(file, original);
  const host: HostInstaller = {
    withFileLock: async (_path, work) => work(), writeFileAtomic: async (path, bytes, options) => { assert.equal(options.mode, 0o600); await writeFile(path, bytes); },
    runProfilePnpm: async (_profile, args) => { if (args[0] === '--version') return { exitCode: 0, output: '10' }; await writeFile(file, '{}'); await writeFile(join(root, 'pnpm-lock.yaml'), 'failed'); return { exitCode: 1, output: 'SDK requires another Node runtime' }; },
  };
  const sdk = createPackageInstaller({ ...SDK, available: () => false, profile: () => ({ dir: root, name: 'test', packageManager: { command: 'host-node' } }), loadHost: async () => host, signal: new AbortController().signal });
  await assert.rejects(sdk.ensure(), /SDK requires another Node/);
  assert.equal(await readFile(file, 'utf8'), original); assert.equal(sdk.needsRestart(), false);
  await assert.rejects(readFile(join(root, 'pnpm-lock.yaml')), { code: 'ENOENT' });
  const cancelled = new AbortController(); cancelled.abort(new Error('disposed'));
  const stopped = createPackageInstaller({ ...SDK, available: () => false, profile: () => ({ dir: root, name: 'test' }), loadHost: async () => host, signal: cancelled.signal });
  await assert.rejects(stopped.ensure(), /disposed/);
});

test('cancellation after the package operation restores both manifest and existing lockfile', async t => {
  const root = await mkdtemp(join(tmpdir(), 'qq-sdk-abort-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'package.json'), lock = join(root, 'pnpm-lock.yaml');
  await writeFile(file, '{"private":true}'); await writeFile(lock, 'original-lock');
  const controller = new AbortController();
  const host: HostInstaller = {
    withFileLock: async (_path, work) => work(),
    writeFileAtomic: async (path, bytes, options) => { assert.equal(options.mode, 0o600); await writeFile(path, bytes); },
    runProfilePnpm: async (_profile, args) => { if (args[0] === '--version') return { exitCode: 0, output: '10' }; await writeFile(file, '{}'); await writeFile(lock, 'changed'); controller.abort(new Error('disposed')); return { exitCode: 0, output: '' }; },
  };
  const sdk = createPackageInstaller({ ...SDK, available: () => false, profile: () => ({ dir: root, name: 'test', packageManager: { command: 'host-node' } }), loadHost: async () => host, signal: controller.signal });
  await assert.rejects(sdk.ensure(), /disposed/);
  assert.equal(await readFile(file, 'utf8'), '{"private":true}'); assert.equal(await readFile(lock, 'utf8'), 'original-lock');
  assert.equal(sdk.needsRestart(), false);
});

test('a prior active host package process is rejected before rollback files are read or written', async t => {
  const root = await mkdtemp(join(tmpdir(), 'qq-sdk-busy-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'package.json'); await writeFile(file, '{"private":true}');
  const host: HostInstaller = {
    withFileLock: async (_path, work) => work(),
    writeFileAtomic: async () => { assert.fail('must not restore files while a previous process is still writing'); },
    runProfilePnpm: async (_profile, args) => { assert.deepEqual(args, ['--version']); await writeFile(file, '{"changedByPreviousRun":true}'); return { exitCode: 1, output: 'previous package run is still active' }; },
  };
  const sdk = createPackageInstaller({ ...SDK, available: () => false, profile: () => ({ dir: root, name: 'test', packageManager: { command: 'host-node' } }), loadHost: async () => host, signal: new AbortController().signal });
  await assert.rejects(sdk.ensure(), /previous package run/);
  assert.equal(await readFile(file, 'utf8'), '{"changedByPreviousRun":true}'); assert.equal(sdk.needsRestart(), false);
});

test('the room page installs the same way, at the version range dsh-world asks for', async t => {
  const root = await mkdtemp(join(tmpdir(), 'room-package-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), '{"private":true}');
  const args: string[][] = [];
  const host: HostInstaller = { withFileLock: async (_path, work) => work(), writeFileAtomic: async () => {}, runProfilePnpm: async (_profile, values) => { args.push(values); return { exitCode: 0, output: '' }; } };
  const room = createPackageInstaller({ name: 'dsh-world-room', label: '小屋', available: () => false, profile: () => ({ dir: root, name: 'test', packageManager: { command: 'host-node' } }), loadHost: async () => host, signal: new AbortController().signal });
  assert.equal(await room.ensure(), true);
  assert.deepEqual(args[1]!.slice(0, 2), ['add', 'dsh-world-room@^0.1.0']);
  const missing = createPackageInstaller({ name: 'dsh-world-room', label: '小屋', available: () => false, profile: () => undefined, loadHost: async () => host, signal: new AbortController().signal });
  await assert.rejects(missing.ensure(), /请手动安装小屋（dsh-world-room）/, 'no space before a Chinese label');
  const sdk = createPackageInstaller({ ...SDK, available: () => false, profile: () => undefined, loadHost: async () => host, signal: new AbortController().signal });
  await assert.rejects(sdk.ensure(), /请手动安装 SnowLuma SDK（@snowluma\/sdk）/);
  assert.throws(() => createPackageInstaller({ name: 'left-pad', label: 'x', available: () => true, profile: () => undefined, signal: new AbortController().signal }), /not a peer dependency/);
});

test('a caret range takes what npm would take', () => {
  for (const [version, range, fits] of [
    ['2.2.1', '^2.2.1', true], ['2.9.0', '^2.2.1', true], ['2.2.0', '^2.2.1', false], ['3.0.0', '^2.2.1', false],
    ['0.1.0', '^0.1.0', true], ['0.1.7', '^0.1.0', true], ['0.2.0', '^0.1.0', false], ['0.0.9', '^0.1.0', false],
    ['0.0.3', '^0.0.3', true], ['0.0.4', '^0.0.3', false], ['0.1.0-dev.1', '^0.1.0', true], ['not a version', '^0.1.0', false],
  ] as const) assert.equal(meetsRange(version, range), fits, `${version} in ${range}`);
  assert.throws(() => meetsRange('1.0.0', '>=1.0.0'), /unsupported/);
});
