import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { durableWrite } from './lifeStore.ts';

export type RoutineSchedule =
  | { kind: 'daily'; time: string; timeZone: string }
  | { kind: 'weekly'; weekdays: number[]; time: string; timeZone: string }
  | { kind: 'every-n-days'; interval: number; startDate: string; time: string; timeZone: string }
  | { kind: 'one-shot'; date: string; time: string; timeZone: string };
export interface Routine {
  id: string; title: string; schedule: RoutineSchedule; note: string; enabled: boolean;
  nextDueAt: string | null; dueAt: string | null; deferUntil: string | null; lastHandledAt: string | null; surfacedAt: string | null;
}
export interface RoutineFile { version: 1; enabled: boolean; routines: Routine[] }
export type RoutineDecision = 'done' | 'skip' | 'defer';
export type RoutineStore = ReturnType<typeof createRoutineStore>;

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
function validDate(value: string): boolean {
  const m = datePattern.exec(value); if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!;
}
function validInstant(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function validZone(zone: string): boolean { try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); return true; } catch { return false; } }
export function validateRoutineSchedule(value: unknown): asserts value is RoutineSchedule {
  if (!value || typeof value !== 'object') throw new Error('schedule 必须是对象');
  const s = value as Record<string, unknown>;
  if (typeof s.time !== 'string' || !timePattern.test(s.time) || typeof s.timeZone !== 'string' || !validZone(s.timeZone)) throw new Error('time 必须是 HH:mm，timeZone 必须是有效时区');
  if (s.kind === 'daily') return;
  if (s.kind === 'weekly') {
    if (!Array.isArray(s.weekdays) || !s.weekdays.length || !s.weekdays.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) throw new Error('weekdays 必须是 0–6 的非空数组');
    return;
  }
  if (s.kind === 'every-n-days') {
    if (!Number.isInteger(s.interval) || (s.interval as number) < 1 || (s.interval as number) > 365 || typeof s.startDate !== 'string' || !validDate(s.startDate)) throw new Error('interval 必须是 1–365，startDate 必须是有效日期');
    return;
  }
  if (s.kind === 'one-shot') { if (typeof s.date !== 'string' || !validDate(s.date)) throw new Error('date 必须是有效日期'); return; }
  throw new Error('不支持的 schedule kind');
}

function parts(at: Date, zone: string) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const v = Object.fromEntries(p.map(x => [x.type, x.value]));
  return { date: `${v.year}-${v.month}-${v.day}`, time: `${v.hour}:${v.minute}`, weekday: new Date(`${v.year}-${v.month}-${v.day}T00:00:00Z`).getUTCDay() };
}
function localInstant(date: string, time: string, zone: string): Date {
  const [y, m, d] = date.split('-').map(Number), [hh, mm] = time.split(':').map(Number);
  const target = Date.UTC(y!, m! - 1, d!, hh!, mm!);
  const offsets = new Set<number>();
  for (const delta of [-36, -12, 0, 12, 36]) {
    const probe = new Date(target + delta * 3_600_000);
    const local = parts(probe, zone), [ly, lm, ld] = local.date.split('-').map(Number), [lh, lmin] = local.time.split(':').map(Number);
    offsets.add(Date.UTC(ly!, lm! - 1, ld!, lh!, lmin!) - probe.getTime());
  }
  const matches = [...offsets].map(offset => new Date(target - offset)).filter(at => parts(at, zone).date === date && parts(at, zone).time === time).sort((a, b) => a.getTime() - b.getTime());
  if (matches.length) return matches[0]!;
  // A daylight-saving gap has no exact wall-clock instant; use the first valid minute after it.
  for (let minute = 1; minute <= 180; minute++) {
    const shifted = new Date(target + minute * 60_000);
    const nextDate = shifted.toISOString().slice(0, 10), nextTime = shifted.toISOString().slice(11, 16);
    const found = localInstantExact(nextDate, nextTime, zone);
    if (found) return found;
  }
  throw new Error(`无法解析当地时间：${date} ${time} ${zone}`);
}
function localInstantExact(date: string, time: string, zone: string): Date | undefined {
  const [y, m, d] = date.split('-').map(Number), [hh, mm] = time.split(':').map(Number), target = Date.UTC(y!, m! - 1, d!, hh!, mm!);
  for (const delta of [-36, -12, 0, 12, 36]) {
    const probe = new Date(target + delta * 3_600_000), local = parts(probe, zone);
    const [ly, lm, ld] = local.date.split('-').map(Number), [lh, lmin] = local.time.split(':').map(Number);
    const candidate = new Date(target - (Date.UTC(ly!, lm! - 1, ld!, lh!, lmin!) - probe.getTime()));
    if (parts(candidate, zone).date === date && parts(candidate, zone).time === time) return candidate;
  }
  return undefined;
}
function addDays(date: string, days: number): string { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
export function nextRoutineOccurrence(schedule: RoutineSchedule, after: Date): Date | null {
  validateRoutineSchedule(schedule);
  if (schedule.kind === 'one-shot') {
    const candidate = localInstant(schedule.date, schedule.time, schedule.timeZone);
    return candidate.getTime() > after.getTime() ? candidate : null;
  }
  const today = parts(after, schedule.timeZone).date;
  for (let offset = 0; offset <= 370; offset++) {
    const date = addDays(today, offset);
    let applies = false;
    if (schedule.kind === 'daily') applies = true;
    else if (schedule.kind === 'weekly') applies = schedule.weekdays.includes(new Date(`${date}T00:00:00Z`).getUTCDay());
    else if (schedule.kind === 'every-n-days') {
      const distance = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${schedule.startDate}T00:00:00Z`)) / 86_400_000;
      applies = distance >= 0 && distance % schedule.interval === 0;
    }
    if (!applies) continue;
    const candidate = localInstant(date, schedule.time, schedule.timeZone);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  return null;
}
function latestRoutineOccurrence(schedule: RoutineSchedule, now: Date): Date | null {
  const today = parts(now, schedule.timeZone).date;
  for (let offset = 0; offset <= 370; offset++) {
    const date = addDays(today, -offset);
    let applies = false;
    if (schedule.kind === 'daily') applies = true;
    else if (schedule.kind === 'weekly') applies = schedule.weekdays.includes(new Date(`${date}T00:00:00Z`).getUTCDay());
    else if (schedule.kind === 'every-n-days') {
      const distance = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${schedule.startDate}T00:00:00Z`)) / 86_400_000;
      applies = distance >= 0 && distance % schedule.interval === 0;
    } else applies = date === schedule.date;
    if (!applies) continue;
    const candidate = localInstant(date, schedule.time, schedule.timeZone);
    if (candidate.getTime() <= now.getTime()) return candidate;
  }
  return null;
}

function empty(): RoutineFile { return { version: 1, enabled: true, routines: [] }; }
function validFile(value: unknown): RoutineFile {
  if (!value || typeof value !== 'object') return empty();
  const raw = value as Partial<RoutineFile>;
  const routines = Array.isArray(raw.routines) ? raw.routines.filter((r): r is Routine => {
    try { return Boolean(r && typeof r.id === 'string' && r.id.length <= 100 && typeof r.title === 'string' && r.title.length <= 120 && typeof r.note === 'string' && r.note.length <= 500 && typeof r.enabled === 'boolean' && (r.dueAt === null || validInstant(r.dueAt)) && (r.deferUntil === undefined || r.deferUntil === null || validInstant(r.deferUntil)) && (r.nextDueAt === null || validInstant(r.nextDueAt)) && (r.lastHandledAt === null || validInstant(r.lastHandledAt)) && (r.surfacedAt === undefined || r.surfacedAt === null || validInstant(r.surfacedAt)) && validateRoutineSchedule(r.schedule) === undefined); } catch { return false; }
  }) : [];
  return { version: 1, enabled: raw.enabled !== false, routines: routines.map(routine => ({ ...routine, deferUntil: routine.deferUntil ?? null, surfacedAt: routine.surfacedAt ?? null })) };
}
export function createRoutineStore(worldDir: string, timeZone: string, clock: () => Date = () => new Date()) {
  const file = join(worldDir, 'routines.json');
  let state: RoutineFile;
  try { state = existsSync(file) ? validFile(JSON.parse(readFileSync(file, 'utf8'))) : empty(); }
  catch (error) { throw new Error(`dsh-world: routines.json is unreadable; it was left untouched`, { cause: error }); }
  const persist = () => durableWrite(file, JSON.stringify(state, null, 2));
  const defaultZone = timeZone || 'UTC';
  function normalize(routine: Omit<Routine, 'id' | 'enabled' | 'nextDueAt' | 'dueAt' | 'deferUntil' | 'lastHandledAt' | 'surfacedAt'> & Partial<Pick<Routine, 'id' | 'enabled'>>): Routine {
    validateRoutineSchedule(routine.schedule);
    const now = clock();
    return { id: routine.id || crypto.randomUUID(), title: routine.title.trim().slice(0, 120), note: routine.note.trim().slice(0, 500), schedule: structuredClone(routine.schedule), enabled: routine.enabled !== false, nextDueAt: nextRoutineOccurrence(routine.schedule, now)?.toISOString() ?? null, dueAt: null, deferUntil: null, lastHandledAt: null, surfacedAt: null };
  }
  return {
    list: () => structuredClone(state),
    setEnabled(enabled: boolean) { state.enabled = enabled; persist(); },
    add(input: Omit<Routine, 'id' | 'enabled' | 'nextDueAt' | 'dueAt' | 'deferUntil' | 'lastHandledAt' | 'surfacedAt'>) {
      if (!input.title.trim()) throw new Error('title 不能为空');
      const routine = normalize(input); state.routines.push(routine); persist(); return structuredClone(routine);
    },
    update(id: string, patch: Partial<Pick<Routine, 'title' | 'note' | 'schedule'>>) {
      const routine = state.routines.find(item => item.id === id); if (!routine) throw new Error('找不到这个 routine id');
      const next = { ...routine, ...patch };
      if (patch.schedule) { validateRoutineSchedule(patch.schedule); next.nextDueAt = nextRoutineOccurrence(patch.schedule, clock())?.toISOString() ?? null; next.dueAt = null; next.deferUntil = null; next.surfacedAt = null; }
      if (patch.title !== undefined) { if (!patch.title.trim()) throw new Error('title 不能为空'); next.title = patch.title.trim().slice(0, 120); }
      if (patch.note !== undefined) next.note = patch.note.trim().slice(0, 500);
      Object.assign(routine, next); persist(); return structuredClone(routine);
    },
    pause(id: string, paused: boolean) {
      const routine = state.routines.find(item => item.id === id); if (!routine) throw new Error('找不到这个 routine id');
      routine.enabled = !paused;
      if (paused) { routine.nextDueAt = null; routine.dueAt = null; routine.deferUntil = null; routine.surfacedAt = null; }
      else routine.nextDueAt = nextRoutineOccurrence(routine.schedule, clock())?.toISOString() ?? null;
      persist(); return structuredClone(routine);
    },
    remove(id: string) { const count = state.routines.length; state.routines = state.routines.filter(r => r.id !== id); if (state.routines.length === count) throw new Error('找不到这个 routine id'); persist(); },
    handle(id: string, decision: RoutineDecision, deferMinutes = 60) {
      const routine = state.routines.find(item => item.id === id); if (!routine) throw new Error('找不到这个 routine id');
      if (!routine.dueAt) throw new Error('这个 routine 当前没有待处理事项');
      if (decision === 'defer') {
        if (!Number.isInteger(deferMinutes) || deferMinutes < 1 || deferMinutes > 10080) throw new Error('deferMinutes 必须是 1–10080 的整数');
        routine.deferUntil = new Date(clock().getTime() + deferMinutes * 60_000).toISOString();
        routine.dueAt = null;
      } else { routine.lastHandledAt = clock().toISOString(); routine.dueAt = null; routine.deferUntil = null; routine.surfacedAt = null; }
      persist(); return structuredClone(routine);
    },
    /** Persist at most the latest missed occurrence per routine; never invokes the model. */
    collectDue(now = clock()): Routine[] {
      if (!state.enabled) return [];
      const newlyDue: Routine[] = [];
      for (const routine of state.routines) {
        if (!routine.enabled) continue;
        let changed = false;
        if (routine.nextDueAt && Date.parse(routine.nextDueAt) <= now.getTime()) {
          const latest = latestRoutineOccurrence(routine.schedule, now) ?? new Date(routine.nextDueAt);
          routine.dueAt = latest.toISOString();
          routine.surfacedAt = null;
          routine.nextDueAt = nextRoutineOccurrence(routine.schedule, latest)?.toISOString() ?? null;
          changed = true;
        }
        if (routine.deferUntil && Date.parse(routine.deferUntil) <= now.getTime()) {
          routine.deferUntil = null;
          routine.dueAt = latestRoutineOccurrence(routine.schedule, now)?.toISOString() ?? routine.dueAt ?? now.toISOString();
          routine.surfacedAt = null;
          changed = true;
        }
        if (changed) newlyDue.push(structuredClone(routine));
      }
      if (newlyDue.length) persist();
      return newlyDue;
    },
    takePendingSummary(now = clock()): Routine[] {
      if (!state.enabled) return [];
      const pending = state.routines.filter(item => item.enabled && item.dueAt && (!item.deferUntil || Date.parse(item.deferUntil) <= now.getTime()) && !item.surfacedAt).slice(0, 5);
      if (pending.length) { for (const item of pending) item.surfacedAt = now.toISOString(); persist(); }
      return structuredClone(pending);
    },
    /** Stored but never called by default; reserved for a future explicit wake opt-in. */
    defaultTimeZone: defaultZone,
  };
}
