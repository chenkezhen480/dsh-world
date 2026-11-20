import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { durableWrite } from './life/lifeStore.ts';
import { validArchiveScope, type MemoryArchiveScope } from './archiveSelection.ts';
import { DEFAULT_REVIEW_TIME, validClockTime } from './life/alarm.ts';

interface WorldSettings { running: boolean; dailyBudget?: number; memoryTurns?: number; coldHours?: number; archiveScope?: MemoryArchiveScope; workspacePermission?: string; wechatContext?: number; wechatBufferSeconds?: number; wechatEnabled?: boolean; qqEnabled?: boolean; computerEnabled?: boolean; desktopEnabled?: boolean; compactAfterReview?: boolean; compactionSwapped?: boolean; consoleSwitchesOnly?: boolean; reviewTime?: string; wakeTime?: string; inboxIgnore?: string[] }
/** How many of the newest turns the memory block carries when nothing else is set. */
export const DEFAULT_MEMORY_TURNS = 200;
/** Hours a session stays silent before its next turn re-reads her memory block and prompt (#36); see `runtime.ts`. */
export const DEFAULT_COLD_HOURS = 24, MAX_COLD_HOURS = 720;
/** WeChat group messages read before a mention, and seconds a private image waits for its companions. */
export const DEFAULT_WECHAT_CONTEXT = 5, MAX_WECHAT_CONTEXT = 20;
export const DEFAULT_WECHAT_BUFFER_SECONDS = 3, MAX_WECHAT_BUFFER_SECONDS = 30;
/**
 * Programs her inbox leaves out until the partner edits the list (#61): Windows' own, which never call her. When DSH
 * starts, the console host and the remote-desktop client (WSLg runs on it) redraw their windows the way a flashing
 * button does, and she spent a turn each time looking for a button that was not there; Windows' own notifications are
 * about the machine. Named by executable or notification id, so they hold in every display language.
 */
export const DEFAULT_INBOX_IGNORE: readonly string[] = ['conhost', 'OpenConsole', 'msrdc', 'mstsc', 'explorer', 'Windows.SystemToast', 'Microsoft.Windows'];
export const MAX_INBOX_IGNORE = 50, MAX_INBOX_NAME = 100;

/**
 * Her world's own settings, changed from the world console and kept in `<world>/world.json` so they outlast a
 * restart: whether it runs (memory block, prompts, archive and life line together), how much her home may
 * spend a day, and how many recent turns her memory block carries. A world that already has a life line from before the switch existed is running; a new one waits
 * for its partner to press start.
 */
/** The config lines that 0.8.0 asked for besides the console switches (`computer`, `desktop`); 0.8.1 reads them once. */
export interface LegacyModuleConfig { computer?: unknown; desktop?: unknown }
export function createWorldSwitch(worldDir: string, configuredScope: MemoryArchiveScope = 'workspace', configuredWake = '09:00', legacy: LegacyModuleConfig = {}) {
  const file = join(worldDir, 'world.json');
  const stored = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Partial<WorldSettings> : undefined;
  let settings: WorldSettings = {
    running: stored ? stored.running === true : existsSync(join(worldDir, 'life.json')),
    ...(typeof stored?.dailyBudget === 'number' ? { dailyBudget: stored.dailyBudget } : {}),
    ...(validTurns(stored?.memoryTurns) ? { memoryTurns: stored.memoryTurns } : {}),
    ...(validColdHours(stored?.coldHours) ? { coldHours: stored.coldHours } : {}),
    ...(validArchiveScope(stored?.archiveScope) ? { archiveScope: stored.archiveScope } : {}),
    ...(validWorkspacePermission(stored?.workspacePermission) ? { workspacePermission: stored.workspacePermission } : {}),
    ...(validWechatContext(stored?.wechatContext) ? { wechatContext: stored.wechatContext } : {}),
    ...(validWechatBuffer(stored?.wechatBufferSeconds) ? { wechatBufferSeconds: stored.wechatBufferSeconds } : {}),
    ...(typeof stored?.wechatEnabled === 'boolean' ? { wechatEnabled: stored.wechatEnabled } : {}),
    ...(typeof stored?.qqEnabled === 'boolean' ? { qqEnabled: stored.qqEnabled } : {}),
    ...(typeof stored?.computerEnabled === 'boolean' ? { computerEnabled: stored.computerEnabled } : {}),
    ...(typeof stored?.desktopEnabled === 'boolean' ? { desktopEnabled: stored.desktopEnabled } : {}),
    ...(stored?.compactAfterReview === false ? { compactAfterReview: false } : {}),
    ...(stored?.compactionSwapped === true ? { compactionSwapped: true } : {}),
    ...(stored?.consoleSwitchesOnly === true ? { consoleSwitchesOnly: true } : {}),
    ...(validClockTime(stored?.reviewTime) ? { reviewTime: stored.reviewTime } : {}),
    ...(validClockTime(stored?.wakeTime) ? { wakeTime: stored.wakeTime } : {}),
    ...(validInboxIgnore(stored?.inboxIgnore) ? { inboxIgnore: inboxNames(stored.inboxIgnore) } : {}),
  };
  const activeScope = settings.archiveScope ?? configuredScope;
  function save(next: WorldSettings): void {
    durableWrite(file, JSON.stringify(next, null, 2));
    settings = next;
  }
  /**
   * In 0.8.0 her browser ran only with `computer: true` in the config and the switch on, and her use of the computer
   * also needed `desktop: true`; from 0.8.1 the switch alone decides. So the first start after the upgrade keeps what
   * was really on: a switch whose config line was taken out (or set false) to say no is turned off, not back on.
   * Once settled, or once either is switched on from the console, the config has no say.
   */
  function settleLegacySwitches(): void {
    if (settings.consoleSwitchesOnly || (!settings.computerEnabled && !settings.desktopEnabled)) return;
    const { computerEnabled, desktopEnabled, ...rest } = settings;
    const computer = computerEnabled === true && legacy.computer === true, desktop = computer && desktopEnabled === true && legacy.desktop === true;
    save({ ...rest, ...(computer ? { computerEnabled: true } : {}), ...(desktop ? { desktopEnabled: true } : {}), consoleSwitchesOnly: true });
  }
  settleLegacySwitches();
  return {
    archiveScope: () => activeScope,
    selectedArchiveScope: () => settings.archiveScope ?? configuredScope,
    restartRequired: () => (settings.archiveScope ?? configuredScope) !== activeScope,
    setArchiveScope(scope: MemoryArchiveScope): void {
      if (!validArchiveScope(scope)) throw new Error('归档范围只能为 home 或 workspace');
      save({ ...settings, archiveScope: scope });
    },
    workspacePermission: () => settings.workspacePermission ?? 'danger-full-access',
    setWorkspacePermission(permission: string): void {
      if (!validWorkspacePermission(permission)) throw new Error('工作区权限必须为非空字符串');
      save({ ...settings, workspacePermission: permission });
    },
    /** After each evening look back her home is compacted, which is when the 我是谁 she has just rewritten takes effect; on unless the partner turns it off. */
    compactAfterReview: () => settings.compactAfterReview !== false,
    setCompactAfterReview(on: boolean): void {
      const { compactAfterReview: _old, ...rest } = settings;
      save(on ? rest : { ...rest, compactAfterReview: false });
    },
    /** Whether the profile has been switched to the tool-free compaction (by this plugin or by hand); asked once, so putting the stock one back sticks. */
    compactionSwapped: () => settings.compactionSwapped === true,
    markCompactionSwapped: () => save({ ...settings, compactionSwapped: true }),
    running: () => settings.running,
    set: (running: boolean) => save({ ...settings, running }),
    /** CNY a day for her home; undefined is no limit. */
    dailyBudget: () => settings.dailyBudget,
    setDailyBudget(yuan: number | undefined): void {
      const { dailyBudget: _old, ...rest } = settings;
      save(yuan === undefined ? rest : { ...rest, dailyBudget: yuan });
    },
    /** Turns in her memory block; read when a block is built, so a change shows from the next session start or compaction. */
    memoryTurns: () => settings.memoryTurns ?? DEFAULT_MEMORY_TURNS,
    setMemoryTurns(turns: number | undefined): void {
      const { memoryTurns: _old, ...rest } = settings;
      save(turns === undefined || turns === DEFAULT_MEMORY_TURNS ? rest : { ...rest, memoryTurns: turns });
    },
    /** Read at every turn start, so a change applies from the next turn of each session. */
    coldHours: () => settings.coldHours ?? DEFAULT_COLD_HOURS,
    setColdHours(hours: number | undefined): void {
      const { coldHours: _old, ...rest } = settings;
      save(hours === undefined || hours === DEFAULT_COLD_HOURS ? rest : { ...rest, coldHours: hours });
    },
    /**
     * The console's switches for the WeChat, QQ and computer modules; all are off until someone turns them on. QQ's SDK is an
     * optional dependency, so its code is not even loaded before then. WeChat used to default to on, so a world that
     * never stored a choice but whose WeChat module has already run (it keeps its outbox) stays on after the upgrade.
     */
    wechatEnabled: () => settings.wechatEnabled ?? existsSync(join(worldDir, 'wechat-outbox.sqlite')),
    qqEnabled: () => settings.qqEnabled === true,
    /** Her own browser: off until someone turns it on. */
    computerEnabled: () => settings.computerEnabled === true,
    /** Her use of the partner's computer: off until someone turns it on. */
    desktopEnabled: () => settings.desktopEnabled === true,
    setModules(next: { wechat?: boolean; qq?: boolean; computer?: boolean; desktop?: boolean }): void {
      const { wechatEnabled, qqEnabled, computerEnabled, desktopEnabled, consoleSwitchesOnly: _settled, ...rest } = settings;
      const wechat = next.wechat ?? wechatEnabled ?? existsSync(join(worldDir, 'wechat-outbox.sqlite')), qq = next.qq ?? qqEnabled === true, computer = next.computer ?? computerEnabled === true, desktop = next.desktop ?? desktopEnabled === true;
      save({ ...rest, wechatEnabled: wechat, ...(qq ? { qqEnabled: true } : {}), ...(computer ? { computerEnabled: true } : {}), ...(desktop ? { desktopEnabled: true } : {}), ...(computer || desktop ? { consoleSwitchesOnly: true } : {}) });
    },
    /** Her evening look back and her morning wake when nothing is pending; the configured `fallbackWakeTime` is the morning's default. */
    reviewTime: () => settings.reviewTime ?? DEFAULT_REVIEW_TIME,
    wakeTime: () => settings.wakeTime ?? configuredWake,
    /** A field left out stays as it is; null goes back to its default. */
    setSchedule(next: { review?: string | null; wake?: string | null }): void {
      const { reviewTime: oldReview, wakeTime: oldWake, ...rest } = settings;
      const review = next.review === undefined ? oldReview : next.review ?? undefined;
      const wake = next.wake === undefined ? oldWake : next.wake ?? undefined;
      save({ ...rest, ...(review === undefined || review === DEFAULT_REVIEW_TIME ? {} : { reviewTime: review }), ...(wake === undefined || wake === configuredWake ? {} : { wakeTime: wake }) });
    },
    /** Read by the WeChat adapter on its next poll; a batch already waiting keeps the value it started with. */
    wechatContext: () => settings.wechatContext ?? DEFAULT_WECHAT_CONTEXT,
    wechatBufferSeconds: () => settings.wechatBufferSeconds ?? DEFAULT_WECHAT_BUFFER_SECONDS,
    setWechat(next: { context?: number | null; bufferSeconds?: number | null }): void {
      const { wechatContext: oldContext, wechatBufferSeconds: oldBuffer, ...rest } = settings;
      const context = next.context === undefined ? oldContext : next.context ?? undefined;
      const buffer = next.bufferSeconds === undefined ? oldBuffer : next.bufferSeconds ?? undefined;
      save({ ...rest, ...(context === undefined || context === DEFAULT_WECHAT_CONTEXT ? {} : { wechatContext: context }), ...(buffer === undefined || buffer === DEFAULT_WECHAT_BUFFER_SECONDS ? {} : { wechatBufferSeconds: buffer }) });
    },
    /** Read at every look, so a change applies from the next one. */
    inboxIgnore: () => settings.inboxIgnore ?? [...DEFAULT_INBOX_IGNORE],
    inboxIgnoreCustom: () => settings.inboxIgnore !== undefined,
    /** null, or the same names as the default in any order, goes back to the default; an empty list leaves nothing out. */
    setInboxIgnore(names: readonly string[] | null): void {
      const { inboxIgnore: _old, ...rest } = settings;
      const kept = names === null ? undefined : inboxNames(names);
      save(kept === undefined || sameNames(kept, DEFAULT_INBOX_IGNORE) ? rest : { ...rest, inboxIgnore: kept });
    },
  };
}
export const validTurns = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1;
export const validColdHours = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_COLD_HOURS;
export const validWorkspacePermission = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export const validWechatContext = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_WECHAT_CONTEXT;
export const validWechatBuffer = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_WECHAT_BUFFER_SECONDS;
export const validInboxIgnore = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= MAX_INBOX_IGNORE && value.every(name => typeof name === 'string' && name.trim().length <= MAX_INBOX_NAME);
/** Trimmed, blanks dropped, and each name once: the inbox matches without regard to case. */
function inboxNames(names: readonly string[]): string[] {
  const kept = new Map<string, string>();
  for (const name of names.map(each => each.trim())) if (name && !kept.has(name.toLowerCase())) kept.set(name.toLowerCase(), name);
  return [...kept.values()];
}
/** Both lists hold each name once. */
const sameNames = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && b.every(name => a.some(each => each.toLowerCase() === name.toLowerCase()));
