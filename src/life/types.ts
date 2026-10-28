export type AlarmSource = 'plan' | 'fallback';
/** `nudged`: she was already asked once, when a home turn stopped well before this alarm, whether she is done. */
export interface Alarm { at: string; note: string; setAt: string; source: AlarmSource; nudged?: true }
/** The next look back on a day: when it is due, and the local day it looks back on. */
export interface Review { at: string; day: string }
/** A word the plugin owes her home: `arrival` when a new home was built, `return` when her world was started again. */
export interface Greeting { at: string; kind: 'arrival' | 'return' }
/** What her home spent on the local `day`, in CNY, and whether she was told she went past her budget. */
export interface Spend { day: string; yuan: number; reminded?: true }
export interface CostRecord {
  occurredAt: string;
  day: string;
  worldId: string;
  sessionId: string;
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  yuan: number;
  source: string;
}
export interface LifeState { version: 1; homeSessionId?: string; alarm?: Alarm; greeting?: Greeting; review?: Review; spend?: Spend }
/** `first` is a new home's first wake, `return` the word when her world starts again, `review` the daily look back. */
export interface WakeRecord { scheduledAt: string; deliveredAt: string; source: AlarmSource | 'first' | 'return' | 'review'; lateMs: number }
export interface ActivityRecord { time: string; sessionId: string; callId: string; tool: string; summary: string; outside: boolean; gapBefore?: true; status?: 'ok' | 'error' }
export interface CompactionRecord { time: string; sessionId: string; ok: boolean; shadowedTokens?: number; error?: string }
export interface LifeOptions {
  worldDir: string; roomDir: string; diaryDir: string; selfFile: string; fallbackWakeTime: string; timeZone: string;
  /** Her alarm wording; the shipped `templates/alarm.md` when absent or missing. */
  alarmFile?: string;
}
