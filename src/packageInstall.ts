import { readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** This plugin's own package.json, the same file from `src/` and from the built `lib/`. */
export const ownPackage: { version: string; repository: { url: string }; peerDependencies: Record<string, string> } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
/** Optional packages are this plugin's optional peer dependencies: package.json holds the one range for each. */
const peers = ownPackage.peerDependencies;
export function peerRange(name: string): string {
  const range = peers[name];
  if (!range) throw new Error(`${name} is not a peer dependency of dsh-world`);
  return range;
}

/**
 * `1.2.3`, `1.2.3-dev.4`, `1.2.3+build`: its three numbers and whether it is a pre-release; undefined for anything
 * else, so text that only starts like a version never passes, and never reaches the command her partner pastes.
 */
function versionParts(version: string): { numbers: [number, number, number]; pre: boolean } | undefined {
  const found = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  return found ? { numbers: [Number(found[1]), Number(found[2]), Number(found[3])], pre: found[4] !== undefined } : undefined;
}
export const isVersion = (text: string) => versionParts(text) !== undefined;
/** Whether `latest` is a later release than `current`; a pre-release comes before the version it leads up to. */
export function isNewerVersion(latest: string, current: string): boolean {
  const next = versionParts(latest), now = versionParts(current);
  if (!next || !now) return false;
  for (let index = 0; index < 3; index++) if (next.numbers[index] !== now.numbers[index]) return next.numbers[index]! > now.numbers[index]!;
  return now.pre && !next.pre;
}
/** Whether `version` falls in a `^major.minor.patch` range, the only form this plugin writes for its peers. */
export function meetsRange(version: string, range: string): boolean {
  const wanted = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (!wanted) throw new Error(`unsupported version range: ${range}`);
  const have = versionParts(version);
  if (!have) return false;
  const [a, b, c] = wanted.slice(1).map(Number), [x, y, z] = have.numbers;
  const atLeast = x > a || (x === a && (y > b || (y === b && z >= c)));
  // A caret allows changes left of the first non-zero part only: ^1.2.3 takes 1.x, ^0.2.3 takes 0.2.x, ^0.0.3 takes 0.0.3.
  return atLeast && x === a && (a > 0 || (y === b && (b > 0 || z === c)));
}

export interface ProfileContext { dir: string; name: string; packageManager?: { command: string; args?: readonly string[]; env?: Record<string, string> }; [key: string]: unknown }
export interface HostInstaller {
  withFileLock<T>(file: string, work: () => Promise<T>, options?: { signal: AbortSignal }): Promise<T>;
  writeFileAtomic(file: string, bytes: Uint8Array, options: { mode: number }): Promise<unknown>;
  runProfilePnpm(profile: ProfileContext, args: string[], options: Record<string, unknown>): Promise<{ exitCode: number; output: string; timedOut?: boolean; incompatible?: unknown[] }>;
}
export async function hostInstaller(manual: string): Promise<HostInstaller> {
  const operations = '@deepseek-ai/dsh-plugin-manager/operations', atomic = '@deepseek-ai/dsh-atomic-write';
  const [manager, files] = await Promise.all([import(operations), import(atomic)]);
  if (typeof manager.runProfilePnpm !== 'function' || typeof files.withFileLock !== 'function' || typeof files.writeFileAtomic !== 'function') throw new Error(`宿主未提供按需依赖安装能力，请在当前 profile 手动安装${manual}`);
  return { runProfilePnpm: manager.runProfilePnpm, withFileLock: files.withFileLock, writeFileAtomic: files.writeFileAtomic };
}

/**
 * Installs one optional peer package into the current profile, and only when the partner asks for it from the console:
 * startup and ordinary turns never install packages. A failed or cancelled install puts package.json and the lockfile back.
 * `label` names the package for the partner. `needsRestart()`: this process installed it, so code imported from it only
 * loads after a restart (files read from disk on each request, like the room page, do not wait for one).
 */
export function createPackageInstaller(deps: { name: string; label: string; available(): boolean; profile(): ProfileContext | undefined; signal: AbortSignal; loadHost?: () => Promise<HostInstaller> }) {
  const range = peerRange(deps.name);
  // A space only where the label meets Chinese with a Latin letter: 安装 SnowLuma SDK, 安装小屋.
  const lead = /^[A-Za-z]/.test(deps.label) ? ' ' : '', tail = /[A-Za-z]$/.test(deps.label) ? ' ' : '';
  const manual = `${lead}${deps.label}（${deps.name}）`;
  let installed = false, pending: Promise<boolean> | undefined;
  async function install(): Promise<boolean> {
    const profile = deps.profile();
    if (!profile || !isAbsolute(profile.dir) || !profile.packageManager?.command) throw new Error(`宿主未提供当前 profile 的包管理器，请手动安装${manual}`);
    const host = await (deps.loadHost ?? (() => hostInstaller(manual)))();
    return host.withFileLock(join(profile.dir, 'package.json'), async () => {
      deps.signal.throwIfAborted();
      const context = { ...profile, profile: profile.name };
      const options = { ...profile.packageManager, env: { ...profile.packageManager?.env, npm_config_ignore_scripts: 'true' }, execution: 'service', signal: deps.signal, activateNewBundles: false, outputBytes: 4096, idleTimeoutMs: 120_000, lookupTimeoutMs: 20_000 };
      // Let the host reject an earlier surviving package process before taking a rollback snapshot.
      const probe = await host.runProfilePnpm(context, ['--version'], options);
      if (probe.exitCode !== 0 || probe.timedOut || probe.incompatible?.length) throw new Error(probe.output || '宿主包管理器当前不可用，请稍后重试');
      deps.signal.throwIfAborted();
      const saved = await Promise.all(['package.json', 'pnpm-lock.yaml'].map(async name => {
        const path = join(profile.dir, name);
        try { return { path, bytes: await readFile(path) }; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, bytes: undefined }; throw error; }
      }));
      try {
        const result = await host.runProfilePnpm(context, ['add', `${deps.name}@${range}`, '--ignore-scripts', '--config.engine-strict=true'], options);
        deps.signal.throwIfAborted();
        if (result.exitCode !== 0 || result.timedOut || result.incompatible?.length) throw new Error(result.output || `${deps.label}${tail}安装失败，请检查网络和它的 Node 要求`);
        installed = true; return true;
      } catch (error) {
        for (const file of saved) {
          if (file.bytes === undefined) await rm(file.path, { force: true });
          else await host.writeFileAtomic(file.path, file.bytes, { mode: 0o600 });
        }
        throw error;
      }
    }, { signal: deps.signal });
  }
  return {
    needsRestart: () => installed,
    /** Installs when the package is missing (or the wrong version); true when this call or an earlier one installed it. */
    async ensure(): Promise<boolean> {
      deps.signal.throwIfAborted();
      if (installed) return true;
      if (deps.available()) return false;
      return pending ??= install().finally(() => { pending = undefined; });
    },
  };
}
