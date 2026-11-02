import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const command = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/update-world.mjs', import.meta.url));

async function fixture(t, name = 'dsh-world', compiled = true) {
  // The updater works on real paths; a Windows temp folder may be an 8.3 short name (CI's RUNNER~1).
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-update-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = join(root, 'profiles', 'desktop');
  const oldPackage = join(profile, 'node_modules', 'dsh-world');
  const contents = join(root, 'input', 'package');
  await mkdir(oldPackage, { recursive: true });
  await mkdir(join(profile, 'node_modules', 'other'), { recursive: true });
  await mkdir(contents, { recursive: true });
  await mkdir(join(root, 'worlds', 'one'), { recursive: true });
  await mkdir(join(root, 'sessions'), { recursive: true });
  const manifest = { name: 'profile', private: true, dependencies: { 'dsh-world': 'file:old.tgz', other: 'link:../my-plugin' }, dsh: { profile: { bundles: ['other', 'dsh-world'] } } };
  await writeFile(join(profile, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(profile, 'pnpm-lock.yaml'), 'old lock');
  await writeFile(join(profile, 'cordis.patch.yml'), 'my original configuration');
  await writeFile(join(oldPackage, 'package.json'), JSON.stringify({ name: 'dsh-world', version: '0.5.7' }));
  await writeFile(join(oldPackage, 'index.js'), 'old implementation');
  await writeFile(join(profile, 'node_modules', 'other', 'index.js'), 'another plugin stays unchanged');
  await writeFile(join(root, 'worlds', 'one', 'persona.md'), 'her own persona');
  await writeFile(join(root, 'worlds', 'one', 'world-prompt.md'), 'her world line');
  await writeFile(join(root, 'sessions', 'history.jsonl'), 'original session events');
  await writeFile(join(contents, 'package.json'), JSON.stringify({ name, version: '0.6.0', main: 'lib/index.js' }));
  if (compiled) {
    await mkdir(join(contents, 'lib'));
    await writeFile(join(contents, 'lib', 'index.js'), 'export const version = "0.6.0";');
  }
  const archive = join(root, 'new package.tgz');
  await command('tar', ['-czf', 'new package.tgz', '-C', 'input', 'package'], { cwd: root });
  const options = { profile, archive, pnpm: join(root, 'pnpm.mjs') };
  await writeFile(options.pnpm, '');
  const runner = async (file, args, settings) => {
    if (args[0] !== options.pnpm) return command(file, args, settings);
    const updated = { ...manifest, dependencies: { ...manifest.dependencies, 'dsh-world': 'file:' + args[2].replaceAll('\\', '/') } };
    await writeFile(join(profile, 'package.json'), JSON.stringify(updated));
    await writeFile(join(profile, 'pnpm-lock.yaml'), 'new lock');
    await rm(oldPackage, { recursive: true });
    await cp(contents, oldPackage, { recursive: true });
    return { stdout: '', stderr: '' };
  };
  return { root, profile, oldPackage, options, runner, manifest };
}

test('updater backs up the profile and world data and preserves authored files and other registrations', async t => {
  const f = await fixture(t);
  const { updateWorld } = await import('../scripts/update-world.mjs');
  const result = await updateWorld(f.options, { run: f.runner, processes: async () => [], log() {} });
  assert.equal(result.version, '0.6.0');
  assert.equal(await readFile(join(result.backup, 'profile', 'node_modules', 'dsh-world', 'index.js'), 'utf8'), 'old implementation');
  assert.equal(await readFile(join(result.backup, 'worlds', 'one', 'persona.md'), 'utf8'), 'her own persona');
  assert.equal(await readFile(join(result.backup, 'sessions', 'history.jsonl'), 'utf8'), 'original session events');
  assert.equal(await readFile(join(f.root, 'worlds', 'one', 'world-prompt.md'), 'utf8'), 'her world line');
  assert.equal(await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8'), 'my original configuration');
  const installed = JSON.parse(await readFile(join(f.profile, 'package.json'), 'utf8'));
  assert.equal(installed.dependencies.other, 'link:../my-plugin');
  assert.deepEqual(installed.dsh, f.manifest.dsh);
  const savedArchive = installed.dependencies['dsh-world'].slice(5);
  assert.deepEqual(await readFile(savedArchive), await readFile(f.options.archive));
  assert.match(await readFile(join(f.oldPackage, 'lib', 'index.js'), 'utf8'), /0\.6\.0/);
  assert.equal((await readdir(join(f.root, 'profiles'))).some(name => name.endsWith('.lock')), false);
});

test('a failed install restores the whole old profile and retains the failed profile for inspection', async t => {
  const f = await fixture(t);
  const { updateWorld } = await import('../scripts/update-world.mjs');
  await assert.rejects(updateWorld(f.options, {
    processes: async () => [], log() {},
    run: async (file, args, settings) => {
      const result = await f.runner(file, args, settings);
      if (args[0] === f.options.pnpm) throw new Error('installation interrupted');
      return result;
    },
  }), /installation interrupted.*restored.*backup/is);
  assert.deepEqual(JSON.parse(await readFile(join(f.profile, 'package.json'), 'utf8')), f.manifest);
  assert.equal(await readFile(join(f.oldPackage, 'index.js'), 'utf8'), 'old implementation');
  assert.equal(await readFile(join(f.profile, 'pnpm-lock.yaml'), 'utf8'), 'old lock');
  const [backup] = await readdir(join(f.root, 'backups'));
  const failed = join(f.root, 'backups', backup, 'failed-profile');
  assert.equal(JSON.parse(await readFile(join(failed, 'node_modules', 'dsh-world', 'package.json'), 'utf8')).version, '0.6.0');
});

test('unexpected changes to other profile configuration fail validation and restore the old profile', async t => {
  const f = await fixture(t);
  const { updateWorld } = await import('../scripts/update-world.mjs');
  await assert.rejects(updateWorld(f.options, {
    processes: async () => [], log() {},
    run: async (file, args, settings) => {
      const result = await f.runner(file, args, settings);
      if (args[0] === f.options.pnpm) await writeFile(join(f.profile, 'cordis.patch.yml'), 'unexpected overwrite');
      return result;
    },
  }), /configuration.*restored/is);
  assert.equal(await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8'), 'my original configuration');
  assert.equal(await readFile(join(f.oldPackage, 'index.js'), 'utf8'), 'old implementation');
});

test('unrelated or source-only archives are rejected before changing the profile', async t => {
  for (const [name, compiled] of [['another-package', true], ['dsh-world', false]]) {
    await t.test(`${name}, compiled=${compiled}`, async t => {
      const f = await fixture(t, name, compiled);
      const { updateWorld } = await import('../scripts/update-world.mjs');
      await assert.rejects(updateWorld(f.options, { run: f.runner, processes: async () => [], log() {} }), /dsh-world|compiled/i);
      assert.equal(await readFile(join(f.oldPackage, 'index.js'), 'utf8'), 'old implementation');
      assert.equal((await readdir(f.root)).includes('backups'), false);
    });
  }
});

test('an active DSH process or an existing updater lock prevents installation', async t => {
  const f = await fixture(t);
  const { updateWorld } = await import('../scripts/update-world.mjs');
  await assert.rejects(updateWorld(f.options, { run: f.runner, processes: async () => ['DSH host pid 123'], log() {} }), /exit DSH/i);
  await writeFile(join(f.root, 'profiles', '.dsh-world-update-desktop.lock'), 'another updater');
  await assert.rejects(updateWorld(f.options, { run: f.runner, processes: async () => [], log() {} }), /lock/i);
  assert.equal(await readFile(join(f.oldPackage, 'index.js'), 'utf8'), 'old implementation');
});

test('a stale same-version install is rejected and restored instead of reporting success', async t => {
  const f = await fixture(t);
  const { updateWorld } = await import('../scripts/update-world.mjs');
  await assert.rejects(updateWorld(f.options, {
    processes: async () => [], log() {},
    run: async (file, args, settings) => {
      const result = await f.runner(file, args, settings);
      if (args[0] === f.options.pnpm) await writeFile(join(f.oldPackage, 'lib', 'index.js'), 'export const version = "old code";');
      return result;
    },
  }), /package content.*restored/is);
  assert.equal(await readFile(join(f.oldPackage, 'index.js'), 'utf8'), 'old implementation');
});

test('a DSH restart during backup stops the update before installation', async t => {
  const f = await fixture(t);
  const { updateWorld } = await import('../scripts/update-world.mjs');
  let checks = 0;
  await assert.rejects(updateWorld(f.options, { run: f.runner, processes: async () => ++checks === 1 ? [] : ['DSH restarted'], log() {} }), /not installed.*exit DSH/i);
  assert.equal(await readFile(join(f.oldPackage, 'index.js'), 'utf8'), 'old implementation');
});

test('the standalone updater documents required paths without loading DSH or starting an update', async () => {
  const { stdout } = await command(process.execPath, [script, '--help']);
  assert.match(stdout, /--profile/);
  assert.match(stdout, /--package/);
  assert.match(stdout, /--pnpm/);
});

test('the updater CLI also runs through a pnpm-style directory link', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-update-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const link = join(root, 'linked-scripts');
  await symlink(fileURLToPath(new URL('../scripts', import.meta.url)), link, process.platform === 'win32' ? 'junction' : 'dir');
  const { stdout } = await command(process.execPath, [join(link, 'update-world.mjs'), '--help']);
  assert.match(stdout, /--profile/);
});

test('process detection catches standalone hosts and adapters with both path separators', async () => {
  const { runningProcesses } = await import('../scripts/update-world.mjs');
  const samples = [
    { ProcessId: 12001, Name: 'python.exe', CommandLine: 'python C:\\Sandbox\\dsh-world\\src\\ecosystem\\wechat\\windows\\adapter.py watch' },
    { ProcessId: 12002, Name: 'python.exe', CommandLine: 'python C:/Sandbox/dsh-world/src/ecosystem/wechat/windows/adapter.py watch' },
    { ProcessId: 12003, Name: 'node.exe', CommandLine: 'node C:\\DSH\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js' },
    { ProcessId: 12004, Name: 'node.exe', CommandLine: 'node /opt/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js' },
    { ProcessId: 12005, Name: 'node.exe', CommandLine: 'node unrelated-app.js' },
    { ProcessId: process.pid, Name: 'node.exe', CommandLine: 'node /opt/dsh-desktop-host/lib/index.js' },
  ];
  const found = await runningProcesses(async (file, args, options) => {
    if (process.platform !== 'win32') return { stdout: samples.map(row => `${row.ProcessId} ${row.CommandLine}`).join('\n') };
    const query = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    const data = Buffer.from(JSON.stringify(samples), 'utf8').toString('base64');
    const program = `function Get-CimInstance { foreach ($row in (ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}'))))) { $row } }\n` + query;
    return command(file, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(program, 'utf16le').toString('base64')], options);
  });
  assert.equal(found.length, 4);
  for (const id of [12001, 12002, 12003, 12004]) assert.ok(found.some(line => line.includes(String(id))));
});

test('profile backup and restore preserve internal dependency directory links without following them', async t => {
  const f = await fixture(t);
  const target = join(f.profile, 'node_modules', '.pnpm', 'shared-dependency');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'value.js'), 'retained dependency');
  const link = join(f.profile, 'node_modules', 'linked-dependency');
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  const { updateWorld } = await import('../scripts/update-world.mjs');
  await assert.rejects(updateWorld(f.options, {
    processes: async () => [], log() {},
    run: async (file, args, settings) => {
      const result = await f.runner(file, args, settings);
      if (args[0] === f.options.pnpm) throw new Error('installation interrupted');
      return result;
    },
  }), /installation interrupted.*restored/is);
  assert.equal(await readFile(join(link, 'value.js'), 'utf8'), 'retained dependency');
  assert.ok((await lstat(link)).isSymbolicLink());
  const [backup] = await readdir(join(f.root, 'backups'));
  assert.ok((await lstat(join(f.root, 'backups', backup, 'profile', 'node_modules', 'linked-dependency'))).isSymbolicLink());
});
