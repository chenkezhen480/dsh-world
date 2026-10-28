import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRoutineStore, nextRoutineOccurrence } from '../src/life/routines.ts';

test('routine occurrence supports daily, weekly, interval and one-shot schedules in a named zone', () => {
  const after = new Date('2026-10-28T12:00:00.000Z');
  assert.equal(nextRoutineOccurrence({ kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }, after)?.toISOString(), '2026-10-29T01:00:00.000Z');
  assert.equal(nextRoutineOccurrence({ kind: 'weekly', weekdays: [1], time: '09:00', timeZone: 'Asia/Shanghai' }, after)?.toISOString(), '2026-11-02T01:00:00.000Z');
  assert.equal(nextRoutineOccurrence({ kind: 'every-n-days', interval: 2, startDate: '2026-10-27', time: '09:00', timeZone: 'Asia/Shanghai' }, after)?.toISOString(), '2026-10-29T01:00:00.000Z');
  assert.equal(nextRoutineOccurrence({ kind: 'one-shot', date: '2026-10-28', time: '21:00', timeZone: 'Asia/Shanghai' }, after)?.toISOString(), '2026-10-28T13:00:00.000Z');
  assert.equal(nextRoutineOccurrence({ kind: 'daily', time: '09:00', timeZone: 'America/New_York' }, new Date('2026-03-07T14:00:00.000Z'))?.toISOString(), '2026-03-08T13:00:00.000Z', 'DST offset is applied for the next local day');
  assert.equal(nextRoutineOccurrence({ kind: 'daily', time: '02:30', timeZone: 'America/New_York' }, new Date('2026-03-07T12:00:00.000Z'))?.toISOString(), '2026-03-08T07:00:00.000Z', 'a spring DST gap advances to the first valid local minute');
  assert.equal(nextRoutineOccurrence({ kind: 'daily', time: '01:30', timeZone: 'America/New_York' }, new Date('2026-10-31T12:00:00.000Z'))?.toISOString(), '2026-11-01T05:30:00.000Z', 'a repeated fall DST time uses its first occurrence');
});

test('routines persist, globally pause without deleting, collect latest-only due, deduplicate and handle decisions', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-routines-'));
  try {
    let now = new Date('2026-10-20T00:00:00.000Z');
    let store = createRoutineStore(root, 'UTC', () => now);
    const routine = store.add({ title: '喝水', note: '喝一杯', schedule: { kind: 'daily', time: '09:00', timeZone: 'UTC' } });
    now = new Date('2026-10-24T10:00:00.000Z');
    const due = store.collectDue();
    assert.equal(due.length, 1);
    assert.equal(due[0]!.dueAt, '2026-10-24T09:00:00.000Z', 'missed daily occurrences collapse to the latest one');
    assert.deepEqual(store.collectDue(), [], 'the same due occurrence is not emitted twice');
    assert.equal(store.takePendingSummary()[0]!.id, routine.id, 'a natural user turn may claim one bounded due summary');
    assert.deepEqual(store.takePendingSummary(), [], 'the same due occurrence is not surfaced twice');
    store = createRoutineStore(root, 'UTC', () => now);
    assert.equal(store.list().routines[0]!.dueAt, '2026-10-24T09:00:00.000Z', 'pending state survives restart');
    store.handle(routine.id, 'defer', 30);
    assert.equal(store.list().routines[0]!.dueAt, null, 'deferred items are not actionable until their delay expires');
    assert.equal(store.list().routines[0]!.deferUntil, '2026-10-24T10:30:00.000Z');
    assert.deepEqual(store.collectDue(), [], 'defer timer does not surface early');
    now = new Date('2026-10-24T10:30:00.000Z');
    assert.equal(store.collectDue()[0]!.dueAt, '2026-10-24T09:00:00.000Z', 'deferred item becomes actionable at the requested time');
    store.handle(routine.id, 'skip');
    assert.equal(store.list().routines[0]!.dueAt, null);
    assert.equal(store.list().routines[0]!.deferUntil, null);
    store.setEnabled(false);
    now = new Date('2026-10-27T10:00:00.000Z');
    assert.deepEqual(store.collectDue(), [], 'global off retains routines and skips due processing');
    assert.equal(store.list().routines.length, 1);
    store.pause(routine.id, true);
    assert.equal(store.list().routines[0]!.enabled, false);
    store.pause(routine.id, false);
    assert.equal(store.list().routines[0]!.enabled, true);
    store.remove(routine.id);
    assert.equal(store.list().routines.length, 0);
    assert.equal(JSON.parse(readFileSync(join(root, 'routines.json'), 'utf8')).version, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('one-shot routines do not repeat, and invalid schedules and ids are rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-routines-once-'));
  try {
    let now = new Date('2026-10-20T00:00:00.000Z');
    const store = createRoutineStore(root, 'UTC', () => now);
    assert.throws(() => store.add({ title: 'bad', note: '', schedule: { kind: 'daily', time: '25:00', timeZone: 'UTC' } as never }), /HH:mm/);
    assert.throws(() => store.pause('missing', true), /找不到/);
    const row = store.add({ title: '一次', note: '', schedule: { kind: 'one-shot', date: '2026-10-21', time: '09:00', timeZone: 'UTC' } });
    now = new Date('2026-10-22T10:00:00.000Z');
    assert.equal(store.collectDue()[0]!.id, row.id);
    assert.equal(store.list().routines[0]!.nextDueAt, null);
    assert.deepEqual(store.collectDue(), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('routine file drops malformed persisted entries instead of scheduling them', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-routines-invalid-'));
  try {
    const path = join(root, 'routines.json');
    writeFileSync(path, JSON.stringify({ version: 1, enabled: true, routines: [{ id: 'bad', title: 'bad', note: '', enabled: true, schedule: { kind: 'daily', time: '09:00', timeZone: 'UTC' }, dueAt: 'yesterday', deferUntil: null, lastHandledAt: null, nextDueAt: null }] }));
    assert.equal(createRoutineStore(root, 'UTC').list().routines.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
