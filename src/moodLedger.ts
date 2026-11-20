import { appendFileSync, readFileSync } from 'node:fs';
import type { Mood } from './mood.ts';

/** One accepted change to mood.md, as the ledger keeps it: everything else is derived by the reader. */
export interface MoodLedgerRow {
  /** When the change was accepted, UTC ISO. */
  at: string;
  /** The whole fixed set is not repeated; only what she set, so a row reads like her call. */
  values: Record<string, number>;
  /** Her small things beside the mood, already trimmed by the parse. */
  trivia?: string[];
}

/**
 * The ledger sits beside mood.md in her room, one append-only line per accepted change, oldest first. The plugin never
 * rewrites it: her drift over a day is history, not state. A missing or unreadable ledger is an empty list, never a
 * fault — the console trend is a nicety, and it must not take her mood card down with it.
 */
export function moodLedgerOf(file: string): string {
  return `${file}.jsonl`;
}

/** One append-only line after the file write succeeded; silent — the trend is a nicety, never worth an error she sees. */
export function appendLedger(file: string, parsed: Extract<Mood, { kind: 'mood' }>): void {
  try {
    const row: MoodLedgerRow = { at: new Date().toISOString(), values: Object.fromEntries(parsed.values) };
    if (parsed.trivia.length) row.trivia = [...parsed.trivia];
    appendFileSync(moodLedgerOf(file), `${JSON.stringify(row)}\n`);
  } catch { /* the write itself already succeeded; the trend may miss one row */ }
}

/** The console trend reads the ledger; a missing or unreadable ledger is just an empty list, never a fault. */
export function readMoodLedger(file: string): MoodLedgerRow[] {
  try {
    const rows: MoodLedgerRow[] = [];
    for (const line of readFileSync(moodLedgerOf(file), 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && typeof (parsed as MoodLedgerRow).at === 'string' && (parsed as MoodLedgerRow).values && typeof (parsed as MoodLedgerRow).values === 'object')
        rows.push({ at: (parsed as MoodLedgerRow).at, values: (parsed as MoodLedgerRow).values, ...(Array.isArray((parsed as MoodLedgerRow).trivia) ? { trivia: (parsed as MoodLedgerRow).trivia } : {}) });
    }
    return rows;
  } catch {
    return [];
  }
}
