import assert from 'node:assert/strict';
import test from 'node:test';
import { createAlarmTimer, type LifeTimers } from '../src/life/alarmTimer.ts';

function manualTimers(clock: { now: number }) {
  let pending: { fn: () => void; at: number }[] = [];
  const timers: LifeTimers = {
    set(fn, ms) { const entry = { fn, at: clock.now + ms }; pending.push(entry); return entry; },
    clear(handle) { pending = pending.filter(entry => entry !== handle); },
  };
  const advance = (ms: number) => { clock.now += ms; const due = pending.filter(entry => entry.at <= clock.now); pending = pending.filter(entry => !due.includes(entry)); for (const entry of due) entry.fn(); };
  return { timers, advance, count: () => pending.length };
}

test('the alarm timer fires once due, in five-minute segments, and backs off after failures', () => {
  const clock = { now: Date.parse('2026-10-24T00:00:00Z') };
  const { timers, advance, count } = manualTimers(clock);
  let fired = 0; let at: string | undefined = '2026-10-24T00:12:00Z';
  const timer = createAlarmTimer({ clock: () => new Date(clock.now), timers, dueAlarm: () => at, fire: () => { fired++; } });
  timer.arm();
  advance(10 * 60_000); assert.equal(fired, 0, 'two segments pass without firing');
  advance(2 * 60_000); assert.equal(fired, 1);
  assert.equal(timer.failed(), 1); advance(59_000); assert.equal(fired, 1); advance(1_000); assert.equal(fired, 2);
  assert.equal(timer.failed(), 5);
  timer.reset(); advance(0); assert.equal(fired, 3, 'a reset drops the backoff');
  at = undefined; timer.arm(); assert.equal(count(), 0, 'nothing pending, nothing armed');
  at = '2026-10-24T01:00:00Z'; timer.stop(); timer.arm(); assert.equal(count(), 0, 'a stopped timer never arms');
});
