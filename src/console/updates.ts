import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorText } from '../faults.ts';
import { realTimers, type LifeTimers } from '../life/alarmTimer.ts';
import { isNewerVersion, isVersion, type ProfileContext } from '../packageInstall.ts';
import { quotePowerShell } from '../powershell.ts';

/** npm's newest release of this plugin: `latest` is the dist tag a plain install takes, so pre-releases never show. */
const LATEST_URL = 'https://registry.npmjs.org/dsh-world/latest';
const DAY_MS = 24 * 60 * 60_000, TIMEOUT_MS = 15_000;
/** The updater this install ships (package.json `files`), the same path from `src/` and from the built `lib/`. */
export const UPDATER_SCRIPT = fileURLToPath(new URL('../../scripts/update-world.mjs', import.meta.url));

/** What the console says about updates: the version running, the newest on npm, and whether that one is newer. */
export interface UpdateStatus {
  current: string; latest?: string; newer: boolean; checkedAt?: string;
  /** Why the last look failed; the newest version found before it, if any, still stands. */
  error?: string;
  changelog: string; upgrade: string;
  /** For a newer release, what to paste once DSH is closed, and where; absent when this machine cannot say its own paths. */
  command?: string; shell?: string;
}

/** What the upgrade command needs from this machine: the profile, DSH's own pnpm and Node, and the updater to copy. */
export interface UpgradeTools { platform: NodeJS.Platform; profileDir: string; pnpm: string; node: string; script: string }
/**
 * This machine's tools as DSH reports them: the profile, and the pnpm DSH runs it with. DSH ships its Node beside that
 * pnpm (`dependencies/node` next to `dependencies/pnpm`), so nobody has to install one; without it, the Node on PATH.
 * Undefined when DSH does not say where its pnpm is, and then the partner fills the command in from the instructions.
 */
export function upgradeTools(profile: ProfileContext | undefined, script = UPDATER_SCRIPT, platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = existsSync): UpgradeTools | undefined {
  const pnpm = profile?.packageManager?.args?.find(arg => /pnpm\.(c|m)?js$/i.test(arg));
  if (!profile?.dir || !pnpm || !exists(script)) return undefined;
  const path = platform === 'win32' ? win32 : posix;
  const bundled = path.join(path.dirname(path.dirname(path.dirname(pnpm))), 'node', 'bin', platform === 'win32' ? 'node.exe' : 'node');
  return { platform, profileDir: profile.dir, pnpm, node: exists(bundled) ? bundled : 'node', script };
}
const quoteSh = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
/**
 * The upgrade the instructions describe, filled in for this machine: copy the updater out of the package it replaces,
 * download the new package, and run the updater, which backs everything up first and restores it if anything fails.
 */
export function upgradeCommand(tools: UpgradeTools, version: string, tarball: string): { command: string; shell: string } {
  const archive = `dsh-world-${version}.tgz`;
  if (tools.platform === 'win32') {
    const q = quotePowerShell;
    return {
      shell: 'PowerShell',
      command: [
        '# 先从应用菜单正常退出 DSH（微信适配器会一起退出），再把下面整段粘贴到 PowerShell 里运行。',
        '& {',
        "  $ErrorActionPreference = 'Stop'",
        "  $updater = Join-Path $env:TEMP 'dsh-world-update.mjs'",
        `  $archive = Join-Path $env:TEMP ${q(archive)}`,
        `  Copy-Item -LiteralPath ${q(tools.script)} -Destination $updater -Force`,
        `  Invoke-WebRequest -UseBasicParsing -Uri ${q(tarball)} -OutFile $archive`,
        `  & ${q(tools.node)} $updater --profile ${q(tools.profileDir)} --package $archive --pnpm ${q(tools.pnpm)}`,
        '}',
      ].join('\n'),
    };
  }
  const q = quoteSh;
  return {
    shell: '终端',
    command: [
      '# 先从应用菜单正常退出 DSH，再把下面整段粘贴到终端里运行。',
      'updater="${TMPDIR:-/tmp}/dsh-world-update.mjs"',
      `archive="\${TMPDIR:-/tmp}"/${q(archive)}`,
      `cp ${q(tools.script)} "$updater" &&`,
      `curl -fL -o "$archive" ${q(tarball)} &&`,
      `${q(tools.node)} "$updater" --profile ${q(tools.profileDir)} --package "$archive" --pnpm ${q(tools.pnpm)}`,
    ].join('\n'),
  };
}

/** `git+https://github.com/owner/repo.git` → `https://github.com/owner/repo`. */
const webAddress = (repository: string) => repository.replace(/^git\+/, '').replace(/\.git$/, '');

/**
 * Whether a newer dsh-world is out: npm is asked when the plugin starts and once a day after, and the answer is kept
 * in memory only, for the console to show. It only tells; updating needs DSH closed (`scripts/update-world.mjs`).
 * Nothing about her or her partner is sent: the one request names the package and nothing else.
 */
export function createUpdateCheck(deps: { current: string; repository: string; fetch?: typeof fetch; timers?: LifeTimers; clock?: () => Date; intervalMs?: number }) {
  const fetcher = deps.fetch ?? fetch, timers = deps.timers ?? realTimers, clock = deps.clock ?? (() => new Date()), every = deps.intervalMs ?? DAY_MS;
  const site = webAddress(deps.repository);
  let found: { latest?: string; tarball?: string; checkedAt?: string; error?: string } = {}, handle: unknown, stopped = true;
  /** The look in flight, so stopping (DSH closing) does not wait for npm to answer. */
  let looking: AbortController | undefined;

  async function check(): Promise<void> {
    const checkedAt = clock().toISOString(), mine = looking = new AbortController();
    try {
      const response = await fetcher(LATEST_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.any([mine.signal, AbortSignal.timeout(TIMEOUT_MS)]) });
      if (!response.ok) throw new Error(`npm 回了 ${response.status}`);
      const { version, dist } = await response.json() as { version?: unknown; dist?: { tarball?: unknown } };
      if (typeof version !== 'string' || !isVersion(version)) throw new Error('npm 给的版本号认不出来');
      // The address npm gives for that version; only an https one on npm itself goes into a command she is asked to paste.
      const tarball = typeof dist?.tarball === 'string' && dist.tarball.startsWith('https://registry.npmjs.org/') ? dist.tarball : `https://registry.npmjs.org/dsh-world/-/dsh-world-${version}.tgz`;
      found = { latest: version, tarball, checkedAt };
    } catch (error) {
      if (mine.signal.aborted) return;
      const { latest, tarball } = found;
      found = { ...(latest && tarball ? { latest, tarball } : {}), checkedAt, error: errorText(error) };
    } finally {
      if (looking === mine) looking = undefined;
    }
  }
  // One look at a time: the next is set only once this one is done.
  function arm(): void { handle = timers.set(() => { handle = undefined; void check().finally(() => { if (!stopped) arm(); }); }, every); }
  return {
    start(): void {
      if (!stopped) return;
      stopped = false;
      void check().finally(() => { if (!stopped) arm(); });
    },
    stop(): void {
      stopped = true;
      if (handle !== undefined) { timers.clear(handle); handle = undefined; }
      looking?.abort();
    },
    check,
    /** `tools`: this machine's paths, for the command to copy; without them the instructions are the way. */
    status(tools?: UpgradeTools): UpdateStatus {
      const { tarball, ...shown } = found;
      const newer = found.latest !== undefined && isNewerVersion(found.latest, deps.current);
      return {
        current: deps.current, newer, ...shown, changelog: `${site}/blob/main/CHANGELOG.md`, upgrade: `${site}/blob/main/INSTALL.md#已有-world用编译包更新`,
        ...(newer && tools && tarball ? upgradeCommand(tools, found.latest!, tarball) : {}),
      };
    },
  };
}
export type UpdateCheck = ReturnType<typeof createUpdateCheck>;
