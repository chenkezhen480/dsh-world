import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { durableWrite } from './life/lifeStore.ts';
import { validArchiveScope, type MemoryArchiveScope } from './archiveSelection.ts';
import { DEFAULT_REVIEW_TIME, validClockTime } from './life/alarm.ts';

interface WorldSettings { running: boolean; dailyBudget?: number; memoryTurns?: number; archiveScope?: MemoryArchiveScope; workspacePermission?: string; wechatContext?: number; wechatBufferSeconds?: number; wechatEnabled?: boolean; qqEnabled?: boolean; compactAfterReview?: boolean; compactionSwapped?: boolean; reviewTime?: string; wakeTime?: string }
/** How many of the newest turns the memory block carries when nothing else is set. */
export const DEFAULT_MEMORY_TURNS = 200;
/** WeChat group messages read before a mention, and seconds a private image waits for its companions. */
export const DEFAULT_WECHAT_CONTEXT = 5, MAX_WECHAT_CONTEXT = 20;
export const DEFAULT_WECHAT_BUFFER_SECONDS = 3, MAX_WECHAT_BUFFER_SECONDS = 30;

/**
 * Her world's own settings, changed from the world console and kept in `<world>/world.json` so they outlast a
 * restart: whether it runs (memory block, prompts, archive and life line together), how much her home may
 * spend a day, and how many recent turns her memory block carries. A world that already has a life line from before the switch existed is running; a new one waits
 * for its partner to press start.
 */
export function createWorldSwitch(worldDir: string, configuredScope: MemoryArchiveScope = 'workspace', configuredWake = '09:00') {
  const file = join(worldDir, 'world.json');
  const stored = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Partial<WorldSettings> : undefined;
  let settings: WorldSettings = {
    running: stored ? stored.running === true : existsSync(join(worldDir, 'life.json')),
    ...(typeof stored?.dailyBudget === 'number' ? { dailyBudget: stored.dailyBudget } : {}),
    ...(validTurns(stored?.memoryTurns) ? { memoryTurns: stored.memoryTurns } : {}),
    ...(validArchiveScope(stored?.archiveScope) ? { archiveScope: stored.archiveScope } : {}),
    ...(validWorkspacePermission(stored?.workspacePermission) ? { workspacePermission: stored.workspacePermission } : {}),
    ...(validWechatContext(stored?.wechatContext) ? { wechatContext: stored.wechatContext } : {}),
    ...(validWechatBuffer(stored?.wechatBufferSeconds) ? { wechatBufferSeconds: stored.wechatBufferSeconds } : {}),
    ...(typeof stored?.wechatEnabled === 'boolean' ? { wechatEnabled: stored.wechatEnabled } : {}),
    ...(typeof stored?.qqEnabled === 'boolean' ? { qqEnabled: stored.qqEnabled } : {}),
    ...(stored?.compactAfterReview === false ? { compactAfterReview: false } : {}),
    ...(stored?.compactionSwapped === true ? { compactionSwapped: true } : {}),
    ...(validClockTime(stored?.reviewTime) ? { reviewTime: stored.reviewTime } : {}),
    ...(validClockTime(stored?.wakeTime) ? { wakeTime: stored.wakeTime } : {}),
  };
  const activeScope = settings.archiveScope ?? configuredScope;
  function save(next: WorldSettings): void {
    durableWrite(file, JSON.stringify(next, null, 2));
    settings = next;
  }
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
    /** After each evening look back her home is applied and compacted, so the 我是谁 she has just rewritten takes effect; on unless the partner turns it off. */
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
    /**
     * The console's switches for the WeChat and QQ modules; both are off until someone turns them on. QQ's SDK is an
     * optional dependency, so its code is not even loaded before then. WeChat used to default to on, so a world that
     * never stored a choice but whose WeChat module has already run (it keeps its outbox) stays on after the upgrade.
     */
    wechatEnabled: () => settings.wechatEnabled ?? existsSync(join(worldDir, 'wechat-outbox.sqlite')),
    qqEnabled: () => settings.qqEnabled === true,
    setModules(next: { wechat?: boolean; qq?: boolean }): void {
      const { wechatEnabled, qqEnabled, ...rest } = settings;
      const wechat = next.wechat ?? wechatEnabled ?? existsSync(join(worldDir, 'wechat-outbox.sqlite')), qq = next.qq ?? qqEnabled === true;
      save({ ...rest, wechatEnabled: wechat, ...(qq ? { qqEnabled: true } : {}) });
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
  };
}
export type WorldSwitch = ReturnType<typeof createWorldSwitch>;
export const validTurns = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1;
export const validWorkspacePermission = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export const validWechatContext = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_WECHAT_CONTEXT;
export const validWechatBuffer = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_WECHAT_BUFFER_SECONDS;
