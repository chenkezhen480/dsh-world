import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const command = (file, args, options = {}) => execute(file, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...options });
// GNU tar (the one Git Bash puts first) reads the `C:` of an archive path as a remote host; naming the archive from its own folder works with every tar.
const readArchive = (run, archive, args, options = {}) => run('tar', [args[0], basename(archive), ...args.slice(1)], { ...options, cwd: dirname(archive) });
const json = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
async function exists(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function copyDirectory(from, to) {
  if (process.platform !== 'win32') return cp(from, to, { recursive: true, verbatimSymlinks: true });
  // fs.cp recreates pnpm junctions as privileged file symlinks on Windows.
  try { await command('robocopy.exe', [from, to, '/E', '/SJ', '/SL', '/R:0', '/W:0', '/COPY:DAT', '/DCOPY:DA', '/NFL', '/NDL', '/NJH', '/NJS', '/NP']); }
  catch (error) { if (!Number.isInteger(error.code) || error.code < 0 || error.code >= 8) throw error; }
}
async function fingerprint(root, excluded = []) {
  const files = Object.create(null);
  if (!await exists(root)) return files;
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(directory, entry.name), key = relative(root, file);
      if (excluded.includes(key)) continue;
      if (entry.isSymbolicLink()) files[key] = 'link:' + await readlink(file);
      else if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) files[key] = await digest(file);
      else throw new Error(`Unsupported filesystem entry: ${file}`);
    }
  }
  await visit(root);
  return files;
}

/** Require a normal exit; never kill a host or an adapter with an unfinished turn. */
export async function runningProcesses(run = command) {
  if (process.platform === 'win32') {
    const query = String.raw`$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | Where-Object {
      $_.ProcessId -ne [int]$env:DSH_WORLD_UPDATE_PID -and (
        $_.Name -eq 'DeepSeek Harness.exe' -or
        $_.CommandLine -match '(dsh-desktop-host[\\/].*index\.js|dsh-world[\\/].*adapter\.py)'
      )
    } | ForEach-Object { "$($_.Name) pid $($_.ProcessId)" }`;
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(query, 'utf16le').toString('base64')], { env: { ...process.env, DSH_WORLD_UPDATE_PID: String(process.pid) } });
    return stdout.trim().split(/\r?\n/).filter(Boolean);
  }
  const { stdout } = await run('ps', ['-axo', 'pid=,args=']);
  return stdout.split('\n').filter(line => Number(line.trim().split(/\s+/)[0]) !== process.pid && /dsh-desktop-host[/\\]|deepseek[- ]harness|dsh-world[/\\].*adapter\.py/i.test(line));
}

export async function updateWorld({ profile: profilePath, archive: archivePath, pnpm: pnpmPath }, { run = command, processes = runningProcesses, log = console.log } = {}) {
  const profile = await realpath(resolve(profilePath));
  if (basename(dirname(profile)) !== 'profiles') throw new Error('Profile must be under <DSH_HOME>/profiles/');
  const home = dirname(dirname(profile));
  const fromProfile = relative(profile, process.cwd());
  if (!fromProfile || (!fromProfile.startsWith('..' + sep) && fromProfile !== '..' && !isAbsolute(fromProfile))) throw new Error('Run the updater outside the profile directory');
  const original = await json(join(profile, 'package.json'));
  if (!original.dependencies?.['dsh-world']) throw new Error('Install dsh-world in this profile before updating');
  const archive = await realpath(resolve(archivePath)), pnpm = await realpath(resolve(pnpmPath));
  if (!/\.(?:c|m)?js$/i.test(pnpm)) throw new Error('--pnpm must point to the DSH pnpm.cjs or pnpm.mjs entry');
  const stopped = async () => {
    const active = await processes();
    if (active.length) throw new Error(`Please exit DSH and its WeChat adapter normally before updating: ${active.join(', ')}`);
  };
  await stopped();
  const { stdout: listing } = await readArchive(run, archive, ['-tzf']);
  const entries = listing.trim().split(/\r?\n/);
  if (entries.filter(file => file === 'package/package.json').length !== 1 || !entries.includes('package/lib/index.js')) throw new Error('A compiled dsh-world archive with lib/index.js is required');
  const { stdout: manifestText } = await readArchive(run, archive, ['-xOzf', 'package/package.json']);
  const target = JSON.parse(manifestText.replace(/^\uFEFF/, ''));
  if (target.name !== 'dsh-world' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(target.version) || target.main !== 'lib/index.js') throw new Error('The archive must be a compiled dsh-world package');

  const lockPath = join(dirname(profile), `.dsh-world-update-${basename(profile)}.lock`);
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`Another updater owns the lock: ${lockPath}`); throw error; }
  let backup, installing = false;
  try {
    await lock.writeFile(String(process.pid));
    const backupParent = join(home, 'backups');
    await mkdir(backupParent, { recursive: true });
    backup = await mkdtemp(join(backupParent, `dsh-world-${basename(profile)}-`));
    log(`Backing up profile and world data to ${backup}`);
    await copyDirectory(profile, join(backup, 'profile'));
    const protectedFiles = new Map();
    protectedFiles.set(profile, await fingerprint(profile, ['node_modules', 'package.json', 'pnpm-lock.yaml']));
    for (const name of ['worlds', 'sessions']) {
      const root = join(home, name);
      protectedFiles.set(root, await fingerprint(root));
      if (await exists(root)) await copyDirectory(root, join(backup, name));
    }
    for (const name of Object.keys(original.dependencies).filter(name => name !== 'dsh-world')) {
      if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)) throw new Error(`Invalid dependency name: ${name}`);
      const root = join(profile, 'node_modules', name);
      if (await exists(root)) protectedFiles.set(root, await fingerprint(root));
    }
    const packages = join(backup, 'packages');
    await mkdir(packages);
    const savedArchive = join(packages, `dsh-world-${target.version}.tgz`);
    await cp(archive, savedArchive);
    const archiveSha256 = await digest(savedArchive);
    if (archiveSha256 !== await digest(archive)) throw new Error('Archive changed while backing up');
    await writeFile(join(backup, 'manifest.json'), JSON.stringify({ profile, archive: savedArchive, archiveSha256, version: target.version, protectedFiles: Object.fromEntries(protectedFiles) }, null, 2));
    await stopped();
    installing = true;
    log(`Installing compiled dsh-world ${target.version} into ${profile}`);
    const install = await run(process.execPath, [pnpm, 'add', savedArchive, '--ignore-scripts'], { cwd: profile });
    if (install.stdout?.trim()) log(install.stdout.trim());
    const installedRoot = join(profile, 'node_modules', 'dsh-world');
    const installed = await json(join(installedRoot, 'package.json'));
    if (installed.name !== 'dsh-world' || installed.version !== target.version) throw new Error('Installed dsh-world version does not match the archive');
    for (const entry of ['lib/index.js', 'scripts/update-world.mjs'].filter(file => entries.includes('package/' + file))) {
      const { stdout } = await readArchive(run, savedArchive, ['-xOzf', 'package/' + entry], { encoding: 'buffer' });
      if (createHash('sha256').update(stdout).digest('hex') !== await digest(join(installedRoot, entry))) throw new Error(`Installed package content does not match: ${entry}`);
    }
    await run(process.execPath, ['--check', join(installedRoot, 'lib', 'index.js')], { cwd: profile });
    const updated = await json(join(profile, 'package.json'));
    const expected = structuredClone(original);
    expected.dependencies['dsh-world'] = updated.dependencies?.['dsh-world'];
    const specifier = expected.dependencies['dsh-world'];
    if (typeof specifier !== 'string' || !specifier.startsWith('file:') || resolve(profile, specifier.slice(5)) !== savedArchive) throw new Error('Installed package is not bound to the preserved archive');
    if (!isDeepStrictEqual(updated, expected)) throw new Error('Other profile configuration or dependency registrations changed');
    for (const [root, before] of protectedFiles) {
      const after = await fingerprint(root, root === profile ? ['node_modules', 'package.json', 'pnpm-lock.yaml'] : []);
      if (!isDeepStrictEqual(before, after)) throw new Error(`Protected configuration or world files changed: ${root}`);
    }
    const result = { version: installed.version, profile, backup, archive: savedArchive, archiveSha256 };
    await writeFile(join(backup, 'result.json'), JSON.stringify(result, null, 2));
    log(`Updated dsh-world to ${installed.version}. Restart DSH when ready. Backup: ${backup}`);
    return result;
  } catch (error) {
    if (!installing) throw new Error(`Update was not installed: ${error.message}. Backup: ${backup ?? 'not created'}`, { cause: error });
    try {
      await stopped();
      await rename(profile, join(backup, 'failed-profile'));
      await copyDirectory(join(backup, 'profile'), profile);
    } catch (restoreError) {
      throw new Error(`Update failed: ${error.message}. Profile restore failed: ${restoreError.message}. Keep DSH closed and restore from backup: ${backup}`, { cause: error });
    }
    throw new Error(`Update failed: ${error.message}. Old profile restored. Backup: ${backup}`, { cause: error });
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

if (process.argv[1] && await realpath(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { profile: { type: 'string' }, package: { type: 'string' }, pnpm: { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) console.log('Usage: node update-world.mjs --profile <DSH_HOME/profiles/name> --package <compiled.tgz> --pnpm <DSH pnpm.cjs or pnpm.mjs>\nExit DSH first. The updater backs up the full profile, worlds and sessions; failed installs restore the old profile. No Git, npm or TypeScript is needed.');
    else {
      if (!values.profile || !values.package || !values.pnpm) throw new Error('--profile, --package and --pnpm are required; see --help');
      const options = { profile: resolve(values.profile), archive: resolve(values.package), pnpm: resolve(values.pnpm) };
      process.chdir(dirname(dirname(options.profile)));
      await updateWorld(options);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
