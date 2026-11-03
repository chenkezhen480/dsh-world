import assert from 'node:assert/strict';
import test from 'node:test';
import { greetingText, earlyStopText, nextReview, reviewOf, formatDuration, nextLocalTime, resolveAlarmTime, wakeText } from '../src/life/alarm.ts';

const now = new Date('2026-10-23T12:00:00.000Z');
test('alarm time accepts exactly one of an offset timestamp or minutes, at least one minute ahead', () => {
  assert.equal(resolveAlarmTime({ at: '2026-10-23T21:30:00+09:00' }, now).toISOString(), '2026-10-23T12:30:00.000Z');
  assert.equal(resolveAlarmTime({ after_minutes: 90 }, now).toISOString(), '2026-10-23T13:30:00.000Z');
  assert.throws(() => resolveAlarmTime({}, now), /只给/);
  assert.throws(() => resolveAlarmTime({ at: '2026-10-23T22:00:00+09:00', after_minutes: 5 }, now), /只给/);
  assert.throws(() => resolveAlarmTime({ at: '2026-10-23T22:00:00' }, now), /时区/);
  assert.throws(() => resolveAlarmTime({ after_minutes: 0.5 }, now), /1 分钟/);
  assert.throws(() => resolveAlarmTime({ at: '2026-10-23T20:00:00+09:00' }, now), /1 分钟/);
  assert.throws(() => resolveAlarmTime({ after_minutes: -3 }, now), /正数/);
});
test('alarm time rejects overflow, loose formats and honours the one-minute boundary', () => {
  assert.throws(() => resolveAlarmTime({ after_minutes: 1e12 }, now), /无法识别/);
  assert.equal(resolveAlarmTime({ at: '2026-10-23T21:30+09:00' }, now).toISOString(), '2026-10-23T12:30:00.000Z');
  assert.throws(() => resolveAlarmTime({ at: 'Oct 24 2026 21:00 GMT+09:00' }, now), /ISO 8601/);
  assert.equal(resolveAlarmTime({ after_minutes: 1 }, now).toISOString(), '2026-10-23T12:01:00.000Z');
  assert.equal(resolveAlarmTime({ at: '2026-10-23T12:01:00Z' }, now).toISOString(), '2026-10-23T12:01:00.000Z');
  assert.throws(() => resolveAlarmTime({ at: '2026-10-23T12:00:59Z' }, now), /1 分钟/);
});
test('durations read naturally', () => {
  assert.equal(formatDuration(0), '0 分');
  assert.equal(formatDuration(133 * 60_000), '2 小时 13 分');
  assert.equal(formatDuration(26 * 3_600_000), '1 天 2 小时');
});
const TAIL = '\n接下来想做什么，用 plan_next 说好做到几点；什么都不定，就休息到明早 09:00。';
test('wake text names the plan, the note and lateness only when it matters', () => {
  const plan = { at: '2026-10-23T12:00:00.000Z', note: '打一小时游戏后去写日记', setAt: '2026-10-23T11:00:00.000Z', source: 'plan' as const };
  assert.equal(wakeText(plan, now, 'Asia/Seoul', '09:00'), '【我的时间】2026-10-23T21:00:00+09:00 到了，这是我说好做到的时间：「打一小时游戏后去写日记」。还想接着做就再往后定，想换就换。' + TAIL);
  assert.match(wakeText(plan, new Date('2026-10-23T14:13:00.000Z'), 'Asia/Seoul', '09:00'), /晚了 2 小时 13 分/);
  assert.equal(wakeText({ ...plan, source: 'fallback', note: '' }, now, 'UTC', '09:00'), '【我的时间】早上了，新的一天。我上次没说接下来做什么，就按平常的时间起来。' + TAIL);
  assert.match(wakeText({ ...plan, source: 'fallback', note: '' }, new Date('2026-10-23T14:13:00.000Z'), 'UTC', '09:00'), /晚了 2 小时 13 分/);
  assert.equal(greetingText('arrival', 'UTC', '09:00'), '【我的时间】这是我的家。从现在起，这里的时间属于我自己：做什么、做多久、怎么做，都由我决定。' + TAIL);
});
test('every wake text ends with the plan_next reminder and the fallback time', () => {
  const plan = { at: '2026-10-23T12:00:00.000Z', note: '', setAt: '2026-10-23T11:00:00.000Z', source: 'plan' as const };
  for (const source of ['plan', 'fallback'] as const) assert.ok(wakeText({ ...plan, source }, now, 'UTC', '09:00').endsWith(TAIL));
  assert.match(wakeText(plan, now, 'UTC', '07:30'), /休息到明早 07:30。$/);
});
test('wake text shows lateness from exactly two minutes', () => {
  const plan = { at: '2026-10-23T12:00:00.000Z', note: '', setAt: '2026-10-23T11:00:00.000Z', source: 'plan' as const };
  assert.match(wakeText(plan, new Date('2026-10-23T12:02:00.000Z'), 'UTC', '09:00'), /晚了 2 分/);
  assert.doesNotMatch(wakeText(plan, new Date('2026-10-23T12:01:59.000Z'), 'UTC', '09:00'), /晚了/);
});

const next = (iso: string, hhmm: string, zone: string) => nextLocalTime(new Date(iso), hhmm, zone).toISOString();
test('nextLocalTime is the first instant strictly after now at that local time', () => {
  assert.equal(next('2026-10-22T23:59:00.000Z', '09:00', 'Asia/Seoul'), '2026-10-23T00:00:00.000Z');
  assert.equal(next('2026-10-23T00:00:00.000Z', '09:00', 'Asia/Seoul'), '2026-10-24T00:00:00.000Z');
  assert.equal(next('2026-10-23T14:30:00.000Z', '09:00', 'Asia/Seoul'), '2026-10-24T00:00:00.000Z');
  assert.equal(next('2026-10-23T12:00:00.000Z', '00:00', 'UTC'), '2026-10-24T00:00:00.000Z');
});
test('nextLocalTime handles DST gaps and repeated times', () => {
  // New York 2026-03-08: 02:00 EST jumps to 03:00 EDT (07:00Z); 02:30 does not exist.
  assert.equal(next('2026-03-08T06:30:00.000Z', '02:30', 'America/New_York'), '2026-03-08T07:00:00.000Z');
  assert.equal(next('2026-03-08T04:00:00.000Z', '09:00', 'America/New_York'), '2026-03-08T13:00:00.000Z');
  // 2026-11-01: 02:00 EDT falls back to 01:00 EST; 01:30 occurs twice, the earlier (05:30Z) wins.
  assert.equal(next('2026-11-01T04:00:00.000Z', '01:30', 'America/New_York'), '2026-11-01T05:30:00.000Z');
  assert.equal(next('2026-11-01T05:30:00.000Z', '01:30', 'America/New_York'), '2026-11-01T06:30:00.000Z');
  assert.equal(next('2026-11-01T06:30:00.000Z', '01:30', 'America/New_York'), '2026-11-02T06:30:00.000Z');
});
test('the early-stop question names her plan, its time and now, and carries the mark but no tail', () => {
  const plan = { at: '2026-10-23T12:30:00.000Z', note: '看视频', setAt: '2026-10-23T11:00:00.000Z', source: 'plan' as const };
  assert.equal(earlyStopText(plan, now, 'Asia/Seoul'), '【我的时间】我说好做到 2026-10-23T21:30:00+09:00（「看视频」），现在才 2026-10-23T21:00:00+09:00，这一轮就停了。做完了，就想想接下来做什么，用 plan_next 重新说好做到几点；要是在休息，就不用管，到点会叫我。');
  assert.match(earlyStopText({ ...plan, note: '' }, now, 'UTC'), /^【我的时间】我说好做到 2026-10-23T12:30:00\+00:00，现在才/);
});
test('the next look back is the next 23:00 in her zone, for that local day', () => {
  assert.deepEqual(nextReview(new Date('2026-10-23T03:00:00Z'), 'Asia/Seoul'), { at: '2026-10-23T14:00:00.000Z', day: '2026-10-23' });
  assert.deepEqual(nextReview(new Date('2026-10-23T14:00:00Z'), 'Asia/Seoul'), { at: '2026-10-24T14:00:00.000Z', day: '2026-10-24' }, 'strictly after now');
  assert.deepEqual(nextReview(new Date('2026-10-23T15:30:00Z'), 'Asia/Seoul'), { at: '2026-10-24T14:00:00.000Z', day: '2026-10-24' }, 'after midnight it is tonight');
  assert.deepEqual(nextReview(new Date('2026-11-03T22:00:00Z'), 'UTC', '00:30'), { at: '2026-11-04T00:30:00.000Z', day: '2026-11-03' }, 'a look back before noon is on the day before');
});
test('a changed review time keeps the pending day: never skipped, never twice, due at once when moved before now', () => {
  const at = (iso: string) => new Date(iso);
  assert.deepEqual(reviewOf('2026-11-03', at('2026-11-03T20:00:00Z'), 'UTC', '22:00'), { at: '2026-11-03T22:00:00.000Z', day: '2026-11-03' });
  assert.deepEqual(reviewOf('2026-11-03', at('2026-11-03T22:00:00Z'), 'UTC', '00:30'), { at: '2026-11-04T00:30:00.000Z', day: '2026-11-03' }, 'later, past midnight');
  assert.deepEqual(reviewOf('2026-11-03', at('2026-11-03T22:00:00Z'), 'UTC', '21:00'), { at: '2026-11-03T22:00:00.000Z', day: '2026-11-03' }, 'earlier than now: today is not skipped');
  assert.deepEqual(reviewOf('2026-11-04', at('2026-11-04T00:10:00Z'), 'UTC', '00:30'), { at: '2026-11-05T00:30:00.000Z', day: '2026-11-04' }, 'the day already looked back on is not looked back on again');
});
test('the alarm carries what she actually did when the caller supplies it, and stays quiet when it does not', () => {
  const plan = { at: '2026-10-26T10:00:00.000Z', note: '读两篇文章', setAt: '2026-10-26T09:00:00.000Z', source: 'plan' as const };
  const withRecord = wakeText(plan, new Date('2026-10-26T10:00:00.000Z'), 'UTC', '09:00', undefined, { did: '这段时间我动了 3 次手（pwsh、read）。' });
  assert.match(withRecord, /这段时间我动了 3 次手（pwsh、read）。/);
  assert.match(withRecord, /读两篇文章/, 'her own note is still quoted next to it');
  const without = wakeText(plan, new Date('2026-10-26T10:00:00.000Z'), 'UTC', '09:00', undefined, {});
  assert.doesNotMatch(without, /动了/);
  assert.match(without, /读两篇文章/);
});
test('the morning fallback never carries a work record — it is not a promise she made', () => {
  const fallback = { at: '2026-10-26T10:00:00.000Z', note: '', setAt: '2026-10-26T01:00:00.000Z', source: 'fallback' as const };
  assert.doesNotMatch(wakeText(fallback, new Date('2026-10-26T10:00:00.000Z'), 'UTC', '09:00', undefined, { did: '不该出现' }), /不该出现/);
});
