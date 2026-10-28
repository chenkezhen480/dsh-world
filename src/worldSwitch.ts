import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { durableWrite } from './life/lifeStore.ts';
import { validArchiveScope, type MemoryArchiveScope } from './archiveSelection.ts';

interface WorldSettings { running: boolean; dailyBudget?: number; memoryTurns?: number; memoryTokenBudget?: number; archiveScope?: MemoryArchiveScope; wechatContext?: number; wechatBufferSeconds?: number; wechatEnabled?: boolean; qqEnabled?: boolean }
/** How many of the newest turns the memory block carries when nothing else is set. */
export const DEFAULT_MEMORY_TURNS = 200;
/** WeChat group messages read before a mention, and seconds a private image waits for its companions. */
export const DEFAULT_WECHAT_CONTEXT = 8, MAX_WECHAT_CONTEXT = 20;
export const DEFAULT_WECHAT_BUFFER_SECONDS = 3, MAX_WECHAT_BUFFER_SECONDS = 30;

/**
 * Her world's own settings, changed from the world console and kept in `<world>/world.json` so they outlast a
 * restart: whether it runs (memory block, prompts, archive and life line together), how much her home may
 * spend a day, and how many recent turns her memory block carries. A world that already has a life line from before the switch existed is running; a new one waits
 * for its partner to press start.
 */
export function createWorldSwitch(worldDir: string, configuredScope: MemoryArchiveScope = 'workspace') {
  const file = join(worldDir, 'world.json');
  const stored = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Partial<WorldSettings> : undefined;
  let settings: WorldSettings = {
    running: stored ? stored.running === true : existsSync(join(worldDir, 'life.json')),
    ...(typeof stored?.dailyBudget === 'number' ? { dailyBudget: stored.dailyBudget } : {}),
    ...(validTurns(stored?.memoryTurns) ? { memoryTurns: stored.memoryTurns } : {}),
    ...(validMemoryTokenBudget(stored?.memoryTokenBudget) ? { memoryTokenBudget: stored.memoryTokenBudget } : {}),
    ...(validArchiveScope(stored?.archiveScope) ? { archiveScope: stored.archiveScope } : {}),
    ...(validWechatContext(stored?.wechatContext) ? { wechatContext: stored.wechatContext } : {}),
    ...(validWechatBuffer(stored?.wechatBufferSeconds) ? { wechatBufferSeconds: stored.wechatBufferSeconds } : {}),
    ...(stored?.wechatEnabled === false ? { wechatEnabled: false } : {}),
    ...(stored?.qqEnabled === false ? { qqEnabled: false } : {}),
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
    /** Optional estimated token cap for each rebuilt memory block; absent leaves the historical behavior intact. */
    memoryTokenBudget: () => settings.memoryTokenBudget,
    setMemoryTokenBudget(tokens: number | undefined): void {
      const { memoryTokenBudget: _old, ...rest } = settings;
      save(tokens === undefined ? rest : { ...rest, memoryTokenBudget: tokens });
    },
    /** The console's switches for the WeChat and QQ modules; on unless turned off, and only an off switch is written out. */
    wechatEnabled: () => settings.wechatEnabled !== false,
    qqEnabled: () => settings.qqEnabled !== false,
    setModules(next: { wechat?: boolean; qq?: boolean }): void {
      const { wechatEnabled, qqEnabled, ...rest } = settings;
      const wechat = next.wechat ?? wechatEnabled !== false, qq = next.qq ?? qqEnabled !== false;
      save({ ...rest, ...(wechat ? {} : { wechatEnabled: false }), ...(qq ? {} : { qqEnabled: false }) });
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
export const validMemoryTokenBudget = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 200_000;

export const validWechatContext = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_WECHAT_CONTEXT;
export const validWechatBuffer = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_WECHAT_BUFFER_SECONDS;
