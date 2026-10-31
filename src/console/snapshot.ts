import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createHistory, renderHistory } from '../history.ts';
import { createDiaryReader } from '../life/diary.ts';
import type { LifeStore } from '../life/lifeStore.ts';
import type { LifeRuntime } from '../life/runtime.ts';
import type { ArchiveStore } from '../store.ts';
import type { WorldConfig } from '../types.ts';
import type { WorldNames } from '../worldPrompt.ts';
import type { MemoryArchiveScope } from '../archiveSelection.ts';
import type { ConsoleSources } from './routes.ts';
import type { HomeApplyState } from './homeApply.ts';
import type { PhotoStore } from '../life/photos.ts';

const SNAPSHOT_TTL_MS = 5000;
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[㐀-鿿豈-﫿　-〿＀-￯]/g) ?? []).length;
  return Math.round(cjk * 0.6 + (text.length - cjk) / 3.5);
}
export interface SnapshotDeps {
  ctx: Context;
  config: WorldConfig;
  archive: ArchiveStore;
  names(): WorldNames;
  /** Absent when the life line could not be set up. */
  lifeStore?: LifeStore;
  /** The running life line; undefined while her world is stopped. */
  life(): LifeRuntime | undefined;
  homeApply?(): HomeApplyState;
  photos?(): PhotoStore;
  diaryDir: string;
  running(): boolean;
  /** CNY a day for her home; undefined is no limit. */
  dailyBudget(): number | undefined;
  /** Turns her memory block carries. */
  memoryTurns(): number;
  selectedArchiveScope?(): MemoryArchiveScope;
  compactAfterReview?(): boolean;
  workspacePermissions?(): { defaultPermission: string; options: { value: string; name: string; description?: string }[] };
  /** The WeChat module's state; undefined while it is off or her world is stopped. */
  wechat?(): unknown;
  /** Whose conversations her archive keeps; the memory block shown is read through it. */
  archiveSession?(id: string): boolean;
  /** Faults outside the life line: the memory line, the bridge, the QQ bridge, starting and stopping. */
  faults(): string[];
  /** Which modules the config allows, whether their console switch is on, and whether they are running now. */
  modules?(): unknown;
  /** The OneBot channel she runs herself; null while it is off. */
  native?(): unknown;
  /** The QQ bridge, when the module is on; absent leaves that card out of the console. */
  qq?: () => Promise<unknown>;
}
/** Read-only views for the console; repeated polling within a few seconds reuses one snapshot until `invalidate`. */
export function consoleSources(deps: SnapshotDeps): ConsoleSources & { invalidate(): void } {
  const { config, archive, lifeStore } = deps;
  const history = createHistory(archive);
  const diary = createDiaryReader(deps.diaryDir);
  let cached: { at: number; value: Promise<unknown> } | undefined;
  async function compute(): Promise<unknown> {
    const life = deps.life()?.snapshot();
    const home = life?.homeSessionId ? deps.ctx.agents.get(SessionId(life.homeSessionId)) : undefined;
    const window = deps.memoryTurns();
    const turns = await history.loadRecentTurns(config.worldId, window, deps.archiveSession);
    const archiveScope = config.archiveScope ?? 'workspace';
    const selectedArchiveScope = deps.selectedArchiveScope?.() ?? archiveScope;
    // Never let a dead bridge take the whole console down with it: a broken QQ module shows as "not running".
    const qq = deps.qq ? await deps.qq().catch(() => null) : null;
    const native = deps.native?.() ?? null;
    return {
      worldId: config.worldId, timeZone: config.timeZone, now: new Date().toISOString(), running: deps.running(), name: deps.names().companion,
      budget: { daily: deps.dailyBudget() ?? null, today: life?.spend ?? null },
      workspace: deps.workspacePermissions?.() ?? null,
      compactAfterReview: deps.compactAfterReview?.() ?? null,
      life: life ? { homeSessionId: life.homeSessionId, status: home ? home.status : 'cold', alarm: life.alarm, review: life.review, recentWakes: lifeStore?.wakes().slice(-5).reverse() ?? [] } : null,
      /** What she says about herself right now; null before she ever wrote one. */
      herStatus: life?.herStatus ?? null,
      homeApply: deps.homeApply?.() ?? null,
      health: [...(life?.faults ?? []), ...deps.faults()],
      memory: { turns: turns.length, windowTurns: window, archiveScope, selectedArchiveScope, restartRequired: archiveScope !== selectedArchiveScope, approxTokens: estimateTokens(renderHistory(turns, config.timeZone, deps.names(), archiveScope === 'home')), oldest: turns.at(-1)?.messages[0]?.occurredAt, ...archive.stats() },
      wechat: deps.wechat?.() ?? null,
      compactions: lifeStore?.compactions().slice(-5).reverse() ?? [],
      diaryDates: diary.dates(), activityDays: lifeStore?.activityDays() ?? [],
      qq: deps.qq ? qq : null,
      native,
      modules: deps.modules?.() ?? null,
    };
  }
  return {
    snapshot() {
      if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached.value;
      const entry = { at: Date.now(), value: compute() };
      cached = entry;
      entry.value.catch(() => { if (cached === entry) cached = undefined; });
      return entry.value;
    },
    invalidate() { cached = undefined; },
    activity: (day, outsideOnly) => lifeStore?.activity(day).filter(record => !outsideOnly || record.outside).reverse() ?? [],
    diary: date => diary.read(date),
    photos: (limit, offset) => { if (!deps.photos) throw new Error('相册不可用'); return deps.photos().list(limit, offset); },
    photo: id => deps.photos?.().image(id),
  };
}
