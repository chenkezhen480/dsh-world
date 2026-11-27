import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
async function command(file, args, options = {}) {
  try { return await execute(file, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...options }); }
  catch (error) {
    // pnpm prints why it failed to stdout, which the error message leaves out: without it a failure names only the command.
    const said = String(error.stdout ?? '').trim();
    if (said) error.message += `\n${said.slice(-2000)}`;
    throw error;
  }
}
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
  await cp(from, to, {
    recursive: true, verbatimSymlinks: true, preserveTimestamps: true,
    filter: process.platform === 'win32' ? async (source, dest) => {
      if (!(await lstat(source)).isSymbolicLink()) return true;
      // Resolved from where the link is. A relative one copied as written points elsewhere from the backup folder,
      // so Windows makes it a file link, and a directory behind a file link cannot be opened: DSH failed to start
      // with EPERM on realpath after such a backup was put back.
      const target = await readlink(source);
      const absolute = isAbsolute(target) ? target : resolve(dirname(source), target);
      const info = await stat(absolute).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (info && !info.isDirectory()) return true;
      // A directory, or nothing there any more (a removed plugin's link): copied as a symlink, a dangling one needs a
      // privilege most accounts lack and stopped the whole backup with EPERM. Junctions need none and lead to the
      // same place wherever the copy lands.
      await symlink(absolute, dest, 'junction');
      return false;
    } : undefined,
  });
}
/** Package links in node_modules, and one level into @scopes, that cannot be resolved the way DSH resolves them at start. */
async function unreadableLinks(modules) {
  const names = [];
  const check = async name => {
    const path = join(modules, name);
    if (!(await lstat(path)).isSymbolicLink()) return;
    try { await realpath(path); } catch { names.push(name); }
  };
  if (!await exists(modules)) return names;
  for (const entry of await readdir(modules, { withFileTypes: true })) {
    if (entry.name.startsWith('@') && entry.isDirectory()) for (const inner of await readdir(join(modules, entry.name))) await check(join(entry.name, inner));
    else await check(entry.name);
  }
  return names;
}
function within(parent, file) {
  const below = relative(parent, file);
  return below !== '..' && !below.startsWith('..' + sep) && !isAbsolute(below);
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

/** The pnpm major that laid out the profile's node_modules, from pnpm's own record (JSON or YAML); undefined when it has none. */
async function layoutMajor(profile) {
  const record = join(profile, 'node_modules', '.modules.yaml');
  if (!await exists(record)) return undefined;
  const match = /packageManager["']?\s*:\s*["']?pnpm@(\d+)\./.exec(await readFile(record, 'utf8'));
  return match ? Number(match[1]) : undefined;
}

/**
 * Require a normal exit; never kill a host or an adapter with an unfinished turn. Her own browser keeps running after
 * DSH exits and holds files in her world, which the backup could not read: its main process, not each helper of it.
 */
export async function runningProcesses(home, run = command) {
  const separator = String.raw`[\\/]`;
  const worlds = join(home, 'worlds').split(sep).map(part => part.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&')).join(separator);
  const browserPattern = String.raw`user-data-dir="?${worlds}${separator}[^\\/"]+${separator}browser(?:["\s]|$)`;
  if (process.platform === 'win32') {
    const query = String.raw`$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | Where-Object {
      $_.ProcessId -ne [int]$env:DSH_WORLD_UPDATE_PID -and (
        $_.Name -in @('DeepSeek Harness.exe', 'DSH NEXT.exe') -or
        $_.CommandLine -match '(dsh-desktop-host[\\/].*index\.js|dsh-world[\\/].*adapter\.py)' -or
        ($_.CommandLine -match $env:DSH_WORLD_UPDATE_BROWSER -and $_.CommandLine -notmatch '--type=')
      )
    } | ForEach-Object { "$($_.Name) pid $($_.ProcessId)" }`;
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(query, 'utf16le').toString('base64')], {
      env: { ...process.env, DSH_WORLD_UPDATE_PID: String(process.pid), DSH_WORLD_UPDATE_BROWSER: browserPattern },
    });
    return stdout.trim().split(/\r?\n/).filter(Boolean);
  }
  const { stdout } = await run('ps', ['-axo', 'pid=,args=']);
  const browser = new RegExp(browserPattern);
  const herBrowser = line => browser.test(line) && !/--type=/.test(line);
  return stdout.split('\n').filter(line => Number(line.trim().split(/\s+/)[0]) !== process.pid && (/dsh-desktop-host[/\\]|deepseek[- ]harness|(?:[/\s])(?:dsh-desktop-next|DSH NEXT)(?=\s|$)|dsh-world[/\\].*adapter\.py/i.test(line) || herBrowser(line)));
}

export async function updateWorld({ profile: profilePath, archive: archivePath, pnpm: pnpmPath }, { run = command, processes = runningProcesses, log: print = console.log } = {}) {
  // Kept for update.log in the backup: what the updater said is evidence a closed window loses.
  const said = [];
  const log = message => { said.push(`${new Date().toISOString()} ${message}`); print(message); };
  const profile = await realpath(resolve(profilePath));
  if (basename(dirname(profile)) !== 'profiles') throw new Error('Profile must be under <DSH_HOME>/profiles/');
  const home = dirname(dirname(profile));
  if (within(profile, process.cwd())) throw new Error('Run the updater outside the profile directory');
  const original = await json(join(profile, 'package.json'));
  const modules = join(profile, 'node_modules'), installedRoot = join(modules, 'dsh-world');
  const oldSpecifier = original.dependencies?.['dsh-world'];
  const linked = await exists(installedRoot) && (await lstat(installedRoot)).isSymbolicLink();
  const externalLink = linked && !within(modules, resolve(modules, await readlink(installedRoot)));
  if (!oldSpecifier) {
    const bundles = original.dsh?.profile?.bundles;
    if (!externalLink || !Array.isArray(bundles) || !bundles.includes('dsh-world')) throw new Error('Install dsh-world in this profile before updating');
    if ((await json(join(installedRoot, 'package.json'))).name !== 'dsh-world') throw new Error('The linked directory is not a dsh-world package');
  }
  const archive = await realpath(resolve(archivePath)), pnpm = await realpath(resolve(pnpmPath));
  if (!/\.(?:c|m)?js$/i.test(pnpm)) throw new Error('--pnpm must point to the DSH pnpm.cjs or pnpm.mjs entry');
  const stopped = async () => {
    const active = await processes(home);
    if (active.length) throw new Error(`Please exit DSH, its WeChat adapter and her own browser window normally before updating: ${active.join(', ')}`);
  };
  await stopped();
  const { stdout: listing } = await readArchive(run, archive, ['-tzf']);
  const entries = listing.trim().split(/\r?\n/);
  if (entries.filter(file => file === 'package/package.json').length !== 1 || !entries.includes('package/lib/index.js')) throw new Error('A compiled dsh-world archive with lib/index.js is required');
  const { stdout: manifestText } = await readArchive(run, archive, ['-xOzf', 'package/package.json']);
  const target = JSON.parse(manifestText.replace(/^\uFEFF/, ''));
  if (target.name !== 'dsh-world' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(target.version) || target.main !== 'lib/index.js') throw new Error('The archive must be a compiled dsh-world package');
  // node_modules laid out by another pnpm major is linked from that major's store, and DSH's pnpm then refuses to add
  // anything (ERR_PNPM_UNEXPECTED_STORE): profiles first installed by an older DSH, or by a pnpm found on PATH.
  const laidOutBy = await layoutMajor(profile);
  const nodeArgs = process.versions.electron ? ['--expose-internals'] : [];
  const runPnpm = args => run(process.execPath, [...nodeArgs, pnpm, ...args], { cwd: profile });
  const pnpmMajor = laidOutBy === undefined ? undefined : Number((await runPnpm(['--version'])).stdout.trim().split('.')[0]);
  if (pnpmMajor < laidOutBy) throw new Error(`This profile's node_modules was installed by pnpm ${laidOutBy}, but --pnpm is pnpm ${pnpmMajor}. Point --pnpm at the pnpm of the DSH you run now (its startup log names it)`);
  const relayout = pnpmMajor > laidOutBy;

  const lockPath = join(dirname(profile), `.dsh-world-update-${basename(profile)}.lock`);
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`Another updater owns the lock: ${lockPath}`); throw error; }
  let backup, installing = false;
  /** Links that did not open before the update; only ones the update broke are its fault. */
  let unreadableBefore = new Set();
  try {
    await lock.writeFile(String(process.pid));
    const backupParent = join(home, 'backups');
    await mkdir(backupParent, { recursive: true });
    backup = await mkdtemp(join(backupParent, `dsh-world-${basename(profile)}-`));
    unreadableBefore = new Set(await unreadableLinks(modules));
    log(`Backing up profile and world data to ${backup}; every file is copied, which can take a few minutes`);
    await copyDirectory(profile, join(backup, 'profile'));
    // Windows links are copied as junctions to where they led; a copy that does not open would be no backup at all.
    if (process.platform === 'win32') {
      const broken = (await unreadableLinks(join(backup, 'profile', 'node_modules'))).filter(name => !unreadableBefore.has(name));
      if (broken.length) throw new Error(`The backup copy of these package links does not open: ${broken.join(', ')}`);
    }
    log('Backed up the profile');
    const protectedFiles = new Map();
    protectedFiles.set(profile, await fingerprint(profile, ['node_modules', 'package.json', 'pnpm-lock.yaml']));
    for (const name of ['worlds', 'sessions']) {
      const root = join(home, name);
      protectedFiles.set(root, await fingerprint(root));
      if (await exists(root)) { await copyDirectory(root, join(backup, name)); log(`Backed up ${name}`); }
    }
    for (const name of Object.keys(original.dependencies ?? {}).filter(name => name !== 'dsh-world')) {
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
    const relink = () => runPnpm(['install', '--ignore-scripts', '--config.confirm-modules-purge=false']);
    let relinked = relayout;
    if (relinked) {
      // The same packages from the lockfile, linked anew; the checks below still require every other plugin unchanged.
      log(`node_modules was installed by pnpm ${laidOutBy}; reinstalling it with pnpm ${pnpmMajor} first`);
      await relink();
    }
    const changePackage = args => runPnpm(args).catch(async error => {
      const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
      if (relinked || !/\bERR_PNPM_UNEXPECTED_STORE\b/.test(output)) throw error;
      await stopped();
      log('pnpm is using a different store; relinking dependencies from the lockfile before retrying once');
      await relink();
      relinked = true;
      await stopped();
      return runPnpm(args);
    });
    // pnpm can retain a link: resolution even after add changes the manifest to file:.
    if (typeof oldSpecifier === 'string' && oldSpecifier.startsWith('link:')) {
      log('Removing the previous dsh-world link registration');
      await changePackage(['remove', 'dsh-world', '--config.ignore-scripts=true']);
    } else if (externalLink && await exists(installedRoot)) {
      await unlink(installedRoot);
    }
    log(`Installing compiled dsh-world ${target.version} into ${profile}`);
    const install = await changePackage(['add', savedArchive, '--ignore-scripts']);
    if (install.stdout?.trim()) log(install.stdout.trim());
    const installed = await json(join(installedRoot, 'package.json'));
    if (installed.name !== 'dsh-world' || installed.version !== target.version) throw new Error('Installed dsh-world version does not match the archive');
    for (const entry of ['lib/index.js', 'scripts/update-world.mjs'].filter(file => entries.includes('package/' + file))) {
      const { stdout } = await readArchive(run, savedArchive, ['-xOzf', 'package/' + entry], { encoding: 'buffer' });
      if (createHash('sha256').update(stdout).digest('hex') !== await digest(join(installedRoot, entry))) throw new Error(`Installed package content does not match: ${entry}`);
    }
    await run(process.execPath, ['--check', join(installedRoot, 'lib', 'index.js')], { cwd: profile });
    const updated = await json(join(profile, 'package.json'));
    const expected = structuredClone(original);
    (expected.dependencies ??= {})['dsh-world'] = updated.dependencies?.['dsh-world'];
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
    let failure;
    if (!installing) failure = new Error(`Update was not installed: ${error.message}. Backup: ${backup ?? 'not created'}`, { cause: error });
    else {
      try {
        await stopped();
        await rename(profile, join(backup, 'failed-profile'));
        await copyDirectory(join(backup, 'profile'), profile);
        // Said here rather than by DSH failing to start on a link it cannot open.
        const broken = (await unreadableLinks(modules)).filter(name => !unreadableBefore.has(name));
        if (broken.length) throw new Error(`these package links do not open after the restore: ${broken.join(', ')}`);
        failure = new Error(`Update failed: ${error.message}. Old profile restored. Backup: ${backup}`, { cause: error });
      } catch (restoreError) {
        failure = new Error(`Update failed: ${error.message}. Profile restore failed: ${restoreError.message}. Keep DSH closed and restore from backup: ${backup}`, { cause: error });
      }
    }
    said.push(`${new Date().toISOString()} ${failure.message}`);
    throw failure;
  } finally {
    if (backup) await writeFile(join(backup, 'update.log'), said.join('\n') + '\n').catch(() => {});
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
