import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createHistory, renderHistory } from '../history.ts';
import { createDiaryReader } from '../life/diary.ts';
import { formatLocalTime } from '../timeContext.ts';
import { estimateTokens as estimateTokensImpl } from '../tokenEstimate.ts';
import type { LifeStore } from '../life/lifeStore.ts';
import type { CostRecord } from '../life/types.ts';
import type { LifeRuntime } from '../life/runtime.ts';
import type { ArchiveStore } from '../store.ts';
import type { WorldConfig } from '../types.ts';
import type { WorldNames } from '../worldPrompt.ts';
import type { MemoryArchiveScope } from '../archiveSelection.ts';
import type { RoutineStore } from '../life/routines.ts';
import type { PhotoStore } from '../life/photos.ts';
import type { ConsoleSources } from './routes.ts';

const SNAPSHOT_TTL_MS = 5000;
export function estimateTokens(text: string): number {
  return estimateTokensImpl(text);
}
interface CostBucket { yuan: number; records: number; inputTokens: number; cacheReadTokens: number; outputTokens: number }
const emptyCostBucket = (): CostBucket => ({ yuan: 0, records: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 });
function addCost(bucket: CostBucket, record: CostRecord): void {
  bucket.yuan += record.yuan; bucket.records++; bucket.inputTokens += record.inputTokens; bucket.cacheReadTokens += record.cacheReadTokens; bucket.outputTokens += record.outputTokens;
}
function roundedYuan(value: number): number { return Math.round(value * 1e8) / 1e8; }
/** A local estimate from the home JSONL records, grouped for the console without entering her context. */
export function summarizeCosts(records: readonly CostRecord[], day: string) {
  const today = emptyCostBucket(); const byModel = new Map<string, CostBucket>(); const bySession = new Map<string, CostBucket>();
  for (const record of records) {
    if (record.day !== day) continue;
    addCost(today, record);
    const model = byModel.get(record.model) ?? emptyCostBucket(); addCost(model, record); byModel.set(record.model, model);
    const session = bySession.get(record.sessionId) ?? emptyCostBucket(); addCost(session, record); bySession.set(record.sessionId, session);
  }
  const normalized = (bucket: CostBucket) => ({ ...bucket, yuan: roundedYuan(bucket.yuan) });
  const groups = (items: Map<string, CostBucket>) => [...items.entries()].map(([key, bucket]) => ({ key, ...normalized(bucket) })).sort((a, b) => b.yuan - a.yuan || a.key.localeCompare(b.key));
  return { estimated: true, currency: 'CNY', note: '本地估算，不是供应商账单原值', day, today: normalized(today), byModel: groups(byModel), bySession: groups(bySession) };
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
  diaryDir: string;
  running(): boolean;
  /** CNY a day for her home; undefined is no limit. */
  dailyBudget(): number | undefined;
  routines?: RoutineStore;
  photos?: PhotoStore;
  /** Turns her memory block carries. */
  memoryTurns(): number;
  memoryTokenBudget?(): number | undefined;
  selectedArchiveScope?(): MemoryArchiveScope;
  /** The WeChat module's state; undefined while it is off or her world is stopped. */
  wechat?(): unknown;
  includesSession?(id: string): boolean;
  /** Faults outside the life line: the memory line, the bridge, the QQ bridge, starting and stopping. */
  faults(): string[];
  /** Which modules the config allows, whether their console switch is on, and whether they are running now. */
  modules?(): unknown;
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
    const now = new Date();
    const life = deps.life()?.snapshot();
    const home = life?.homeSessionId ? deps.ctx.agents.get(SessionId(life.homeSessionId)) : undefined;
    const window = deps.memoryTurns();
    const turns = await history.loadRecentTurns(config.worldId, window, deps.includesSession);
    const archiveScope = config.archiveScope ?? 'workspace';
    const selectedArchiveScope = deps.selectedArchiveScope?.() ?? archiveScope;
    // Never let a dead bridge take the whole console down with it: a broken QQ module shows as "not running".
    const qq = deps.qq ? await deps.qq().catch(() => null) : null;
    return {
      worldId: config.worldId, timeZone: config.timeZone, now: now.toISOString(), running: deps.running(), name: deps.names().companion,
      budget: { daily: deps.dailyBudget() ?? null, today: life?.spend ?? null },
      costs: summarizeCosts(lifeStore?.costs() ?? [], formatLocalTime(now, config.timeZone).slice(0, 10)),
      life: life ? { homeSessionId: life.homeSessionId, status: home ? home.status : 'cold', alarm: life.alarm, review: life.review, recentWakes: lifeStore?.wakes().slice(-5).reverse() ?? [] } : null,
      routines: deps.routines?.list() ?? { version: 1, enabled: true, routines: [] },
      photos: deps.photos?.list() ?? life?.photos ?? [],
      health: [...(life?.faults ?? []), ...deps.faults()],
      memory: { turns: turns.length, windowTurns: window, tokenBudget: deps.memoryTokenBudget?.() ?? null, archiveScope, selectedArchiveScope, restartRequired: archiveScope !== selectedArchiveScope, approxTokens: estimateTokens(renderHistory(turns, config.timeZone, deps.names(), archiveScope === 'home')), oldest: turns.at(-1)?.messages[0]?.occurredAt, ...archive.stats() },
      wechat: deps.wechat?.() ?? null,
      compactions: lifeStore?.compactions().slice(-5).reverse() ?? [],
      diaryDates: diary.dates(), activityDays: lifeStore?.activityDays() ?? [],
      qq: deps.qq ? qq : null,
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
  };
}
