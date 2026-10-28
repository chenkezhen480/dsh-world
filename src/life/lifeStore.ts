import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatLocalTime } from '../timeContext.ts';
import type { ActivityRecord, CompactionRecord, CostRecord, LifeState, WakeRecord } from './types.ts';

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const dayFile = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

const renameAttempts = 10;
const transientRename = new Set(['EPERM', 'EBUSY', 'EACCES']);
function sleepSync(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/** Exported for tests only (injectable rename). On Windows a reader, indexer or antivirus can briefly lock the target, so a rename that fails with EPERM/EBUSY/EACCES is retried with a short backoff. */
export function durableWrite(file: string, text: string, rename: (from: string, to: string) => void = renameSync): void {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    const fd = openSync(temporary, 'w');
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    for (let attempt = 1; ; attempt++) {
      try { rename(temporary, file); break; } catch (error) {
        if (attempt >= renameAttempts || !transientRename.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
        sleepSync(Math.min(100, 10 * 2 ** (attempt - 1)));
      }
    }
  } catch (error) { rmSync(temporary, { force: true }); throw error; }
}
function append(file: string, value: unknown): void {
  const fd = openSync(file, 'a+');
  try {
    const size = fstatSync(fd).size; const last = Buffer.alloc(1);
    const torn = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 10;
    writeFileSync(fd, `${torn ? '\n' : ''}${JSON.stringify(value)}\n`); fsyncSync(fd);
  } finally { closeSync(fd); }
}
/** Skips unparsable or non-object lines (a half-written tail or a damaged line). */
function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { const value = JSON.parse(line); return value && typeof value === 'object' ? [value as T] : []; } catch { return []; } });
}

export function createLifeStore(worldDir: string, timeZone: string) {
  const stateFile = join(worldDir, 'life.json');
  const lifeDir = join(worldDir, 'life');
  const activityDir = join(worldDir, 'activity');
  let activityGap = false;
  mkdirSync(lifeDir, { recursive: true }); mkdirSync(activityDir, { recursive: true });
  /** A life.json that is not JSON stops the life line (the console says why) and is left as it is. */
  function read(): LifeState {
    if (!existsSync(stateFile)) return { version: 1 };
    try { return JSON.parse(readFileSync(stateFile, 'utf8')) as LifeState; }
    catch (error) { throw new Error(`dsh-world: ${stateFile} is not valid JSON; it was left untouched`, { cause: error }); }
  }
  const localDay = (iso: string) => formatLocalTime(new Date(iso), timeZone).slice(0, 10);
  return {
    read,
    write: (state: LifeState) => durableWrite(stateFile, JSON.stringify(state, null, 2)),
    appendWake: (record: WakeRecord) => append(join(lifeDir, 'wakes.jsonl'), record),
    appendCost: (record: CostRecord) => append(join(lifeDir, 'costs.jsonl'), record),
    appendCompaction: (record: CompactionRecord) => append(join(worldDir, 'compactions.jsonl'), record),
    /** Never throws: a failed write is reported to the caller and marks the next record. The gap flag is in-memory and marks the next successful write, which may land in a later day's file. */
    appendActivity(record: ActivityRecord): boolean {
      try { mkdirSync(activityDir, { recursive: true }); append(join(activityDir, `${localDay(record.time)}.jsonl`), activityGap ? { ...record, gapBefore: true } : record); activityGap = false; return true; }
      catch { activityGap = true; return false; }
    },
    wakes: () => readJsonl<WakeRecord>(join(lifeDir, 'wakes.jsonl')),
    costs: () => readJsonl<CostRecord>(join(lifeDir, 'costs.jsonl')),
    compactions: () => readJsonl<CompactionRecord>(join(worldDir, 'compactions.jsonl')),
    activity: (day: string) => dayPattern.test(day) ? readJsonl<ActivityRecord>(join(activityDir, `${day}.jsonl`)) : [],
    activityDays: () => existsSync(activityDir) ? readdirSync(activityDir).filter(name => dayFile.test(name)).map(name => name.slice(0, 10)).sort().reverse() : [],
  };
}
export type LifeStore = ReturnType<typeof createLifeStore>;
