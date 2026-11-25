import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
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
    await rm(oldPackage, { recursive: true, force: true });
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

test('node_modules from an older pnpm is reinstalled with DSH\'s pnpm before the add, which would otherwise refuse it', async t => {
  const f = await fixture(t);
  // pnpm 10 wrote JSON, older ones YAML; both name the pnpm that laid the folder out.
  for (const record of ['{\n  "packageManager": "pnpm@10.34.9",\n  "storeDir": "C:\\\\pnpm\\\\store\\\\v10"\n}', 'packageManager: pnpm@9.15.0\nstoreDir: /pnpm/store/v3\n']) {
    await t.test(record.slice(0, 20), async () => {
      await writeFile(join(f.profile, 'node_modules', '.modules.yaml'), record);
      const { updateWorld } = await import('../scripts/update-world.mjs');
      const calls = [];
      const result = await updateWorld(f.options, {
        processes: async () => [], log() {},
        run: async (file, args, settings) => {
          if (args[0] !== f.options.pnpm) return f.runner(file, args, settings);
          calls.push(args.slice(1, 2).join());
          if (args[1] === '--version') return { stdout: '11.28.5\n', stderr: '' };
          if (args[1] === 'install') { assert.deepEqual(args.slice(1), ['install', '--ignore-scripts', '--config.confirm-modules-purge=false']); assert.equal(settings.cwd, f.profile); return { stdout: '', stderr: '' }; }
          return f.runner(file, args, settings);
        },
      });
      assert.equal(result.version, '0.6.0');
      assert.deepEqual(calls, ['--version', 'install', 'add']);
      await writeFile(join(f.profile, 'package.json'), JSON.stringify(f.manifest));
    });
  }
});

test('a --pnpm older than the one that laid out node_modules is refused before anything is backed up', async t => {
  const f = await fixture(t);
  await writeFile(join(f.profile, 'node_modules', '.modules.yaml'), '{ "packageManager": "pnpm@11.28.5" }');
  const { updateWorld } = await import('../scripts/update-world.mjs');
  await assert.rejects(updateWorld(f.options, {
    processes: async () => [], log() {},
    run: async (file, args, settings) => args[0] === f.options.pnpm ? (args[1] === '--version' ? { stdout: '10.34.9\n', stderr: '' } : assert.fail('nothing is installed')) : f.runner(file, args, settings),
  }), /installed by pnpm 11, but --pnpm is pnpm 10.*DSH you run now/);
  assert.equal((await readdir(f.root)).includes('backups'), false);
  assert.deepEqual(JSON.parse(await readFile(join(f.profile, 'package.json'), 'utf8')), f.manifest);
});

test('a different pnpm store triggers one relink and retry even when the pnpm major matches', async t => {
  const f = await fixture(t);
  await writeFile(join(f.profile, 'node_modules', '.modules.yaml'), 'packageManager: pnpm@11.20.0\n');
  const { updateWorld } = await import('../scripts/update-world.mjs');
  const calls = [];
  const result = await updateWorld(f.options, {
    processes: async () => [], log() {},
    run: async (file, args, settings) => {
      if (args[0] !== f.options.pnpm) return f.runner(file, args, settings);
      calls.push(args[1]);
      if (args[1] === '--version') return { stdout: '11.21.0\n' };
      if (args[1] === 'install') return { stdout: '' };
      if (calls.length === 2) {
        throw Object.assign(new Error('pnpm add exited with code 1'), {
          stdout: '[ERR_PNPM_UNEXPECTED_STORE] Unexpected store location',
        });
      }
      return f.runner(file, args, settings);
    },
  });
  assert.deepEqual(calls, ['--version', 'add', 'install', 'add']);
  assert.equal(result.version, '0.6.0');
  assert.match(await readFile(join(f.oldPackage, 'lib', 'index.js'), 'utf8'), /0\.6\.0/);
  assert.deepEqual(JSON.parse(await readFile(join(result.backup, 'profile', 'package.json'), 'utf8')), f.manifest);
});

test('external dsh-world links can be upgraded without writing to their source', async t => {
  for (const managed of [true, false]) {
    await t.test(managed ? 'pnpm link dependency' : 'junction registered as a bundle', async t => {
      const f = await fixture(t);
      const source = join(f.root, 'linked source');
      await cp(f.oldPackage, source, { recursive: true });
      await rm(f.oldPackage, { recursive: true });
      if (managed) {
        f.manifest.dependencies['dsh-world'] = 'link:../../linked source';
        // pnpm links a directory on Windows as a junction to its absolute path; a relative symlink needs a privilege most users lack.
        if (process.platform === 'win32') await symlink(source, f.oldPackage, 'junction');
        else await symlink('../../../linked source', f.oldPackage, 'dir');
      } else {
        delete f.manifest.dependencies['dsh-world'];
        await symlink(source, f.oldPackage, process.platform === 'win32' ? 'junction' : 'dir');
      }
      await writeFile(join(f.profile, 'package.json'), JSON.stringify(f.manifest));
      const oldTarget = await readlink(f.oldPackage);
      const { updateWorld } = await import('../scripts/update-world.mjs');
      let removed = false;
      const result = await updateWorld(f.options, {
        processes: async () => [], log() {},
        run: async (file, args, settings) => {
          if (args[0] === f.options.pnpm && args[1] === 'remove') {
            assert.equal(args[2], 'dsh-world');
            if ((await lstat(f.oldPackage).catch(() => undefined))?.isSymbolicLink()) await unlink(f.oldPackage);
            removed = true;
            return { stdout: '' };
          }
          if (args[0] === f.options.pnpm) {
            assert.equal(removed, managed);
            await assert.rejects(lstat(f.oldPackage), { code: 'ENOENT' });
          }
          return f.runner(file, args, settings);
        },
      });
      assert.equal(result.version, '0.6.0');
      assert.equal(await readlink(join(result.backup, 'profile/node_modules/dsh-world')), oldTarget);
      assert.equal(await readFile(join(source, 'index.js'), 'utf8'), 'old implementation');
    });
  }
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
    // Her own browser outlives DSH and holds files in her world: its main process is named, its helpers are not.
    { ProcessId: 12006, Name: 'msedge.exe', CommandLine: '"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --user-data-dir=C:\\Users\\o\\.dsh\\worlds\\jingjing\\browser --remote-debugging-port=0' },
    { ProcessId: 12007, Name: 'msedge.exe', CommandLine: '"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --type=renderer --user-data-dir="C:\\Users\\o\\.dsh\\worlds\\jingjing\\browser"' },
    { ProcessId: 12008, Name: 'msedge.exe', CommandLine: '"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --profile-directory=Default' },
    { ProcessId: 12009, Name: 'chrome', CommandLine: '/usr/bin/google-chrome --user-data-dir=/home/o/.dsh/worlds/w/browser --remote-debugging-port=0' },
    { ProcessId: 12010, Name: 'DSH NEXT.exe', CommandLine: '"C:\\Apps\\DSH NEXT\\DSH NEXT.exe"' },
    { ProcessId: 12011, Name: 'dsh-desktop-next', CommandLine: '/opt/dsh-desktop-next/dsh-desktop-next' },
  ];
  const sampleProcesses = async (file, args, options) => {
    if (process.platform !== 'win32') return { stdout: samples.map(row => `${row.ProcessId} ${row.CommandLine}`).join('\n') };
    const query = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    const data = Buffer.from(JSON.stringify(samples), 'utf8').toString('base64');
    const program = `function Get-CimInstance { foreach ($row in (ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}'))))) { $row } }\n` + query;
    return command(file, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(program, 'utf16le').toString('base64')], options);
  };
  const home = process.platform === 'win32' ? 'C:\\Users\\o\\.dsh' : '/home/o/.dsh';
  const found = await runningProcesses(home, sampleProcesses);
  const localBrowser = process.platform === 'win32' ? 12006 : 12009;
  const otherBrowser = process.platform === 'win32' ? 12009 : 12006;
  const desktopNext = process.platform === 'win32' ? 12010 : 12011;
  assert.equal(found.length, 6, found.join('\n'));
  for (const id of [12001, 12002, 12003, 12004, localBrowser, desktopNext]) assert.ok(found.some(line => line.includes(String(id))));
  for (const id of [12007, 12008, otherBrowser]) assert.ok(!found.some(line => line.includes(String(id))), `${id}: a helper, the partner's browser or another data directory`);
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
