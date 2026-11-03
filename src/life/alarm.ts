import { formatLocalTime } from '../timeContext.ts';
import type { Alarm, Review } from './types.ts';
import { ALARM_MARK, exampleTime, fillMessage, readAlarmMessages, type AlarmMessages } from './messages.ts';

const MIN_ALARM_MS = 60_000;
const LATE_NOTICE_MS = 2 * 60_000;
/** The local time of her evening look back unless the console sets another. */
export const DEFAULT_REVIEW_TIME = '23:00';
/** A local time of day, HH:MM on the 24-hour clock. */
export const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export const validClockTime = (value: unknown): value is string => typeof value === 'string' && CLOCK_TIME.test(value);

export function resolveAlarmTime(input: { at?: string; after_minutes?: number }, now: Date, timeZone = 'UTC'): Date {
  if ((input.at === undefined) === (input.after_minutes === undefined)) throw new Error('请只给 at 或 after_minutes 其中一个');
  let target: Date;
  if (input.at !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.at)) throw new Error(`at 需要 ISO 8601 格式并带时区，例如 ${exampleTime(timeZone)}`);
    target = new Date(input.at);
  } else {
    const minutes = input.after_minutes!;
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('after_minutes 必须是正数');
    target = new Date(now.getTime() + minutes * 60_000);
  }
  if (!Number.isFinite(target.getTime())) throw new Error(`无法识别的时间：${input.at ?? input.after_minutes}`);
  if (target.getTime() - now.getTime() < MIN_ALARM_MS) throw new Error('闹钟至少要定在 1 分钟之后');
  return target;
}
const offsetMs = (at: number, timeZone: string) => {
  const m = /([+-])(\d{2}):(\d{2})$/.exec(formatLocalTime(new Date(at), timeZone))!;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
};
/** The first instant strictly after `now` whose local time in `timeZone` is hhmm:00; a time skipped by a DST gap lands on the first instant after the gap. */
export function nextLocalTime(now: Date, hhmm: string, timeZone: string): Date {
  const [hour, minute] = hhmm.split(':').map(Number) as [number, number];
  const today = formatLocalTime(now, timeZone);
  const [y, mo, d] = [Number(today.slice(0, 4)), Number(today.slice(5, 7)), Number(today.slice(8, 10))];
  for (let k = 0; k < 3; k++) {
    const wall = Date.UTC(y, mo - 1, d + k, hour, minute);
    const date = new Date(wall).toISOString().slice(0, 10);
    const want = `${date}T${hhmm}:00`;
    const around = [offsetMs(wall - 86_400_000, timeZone), offsetMs(wall + 86_400_000, timeZone)];
    const hits = [...new Set(around)].map(offset => wall - offset).filter(at => formatLocalTime(new Date(at), timeZone).slice(0, 19) === want);
    let at = hits.length ? Math.min(...hits.filter(h => h > now.getTime()), Infinity) : NaN;
    if (!hits.length) {
      // Skipped by a gap: the first instant from which the local clock reads at least the wanted time.
      let [lo, hi] = [wall - Math.max(...around), wall - Math.min(...around)].sort((a, b) => a - b) as [number, number];
      while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (formatLocalTime(new Date(mid), timeZone).slice(0, 19) >= want) hi = mid; else lo = mid; }
      at = hi;
    }
    if (at > now.getTime() && Number.isFinite(at)) return new Date(at);
  }
  throw new Error(`找不到 ${hhmm} 之后的下一个时间`);
}
export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1440); const hours = Math.floor((minutes % 1440) / 60); const rest = minutes % 60;
  const parts = [days ? `${days} 天` : '', hours ? `${hours} 小时` : '', rest || (!days && !hours) ? `${rest} 分` : ''];
  return parts.filter(Boolean).join(' ');
}
/**
 * What she hears when an alarm rings. The wording comes from the alarm template (`extra` carries her
 * names for templates that use them, plus `did` — one line about what she actually did since she set the
 * alarm, so the promise and the record arrive together); the 【我的时间】 mark is always the plugin's own.
 */
export function wakeText(alarm: Alarm, now: Date, timeZone: string, fallbackWakeTime: string, messages: AlarmMessages = readAlarmMessages(undefined), extra: Record<string, string> = {}): string {
  const base = { ...extra, timeZone, fallbackWakeTime };
  const lateText = lateNotice(now.getTime() - Date.parse(alarm.at), messages, base);
  const body = alarm.source === 'fallback' ? fillMessage(messages, '早上兜底', { ...base, late: lateText })
    : fillMessage(messages, '闹钟响了', { ...base, time: formatLocalTime(new Date(alarm.at), timeZone), note: alarm.note, late: lateText }, { note: Boolean(alarm.note), did: Boolean(extra.did) });
  return withTail(body, messages, base);
}
/** What a new home says the moment it is built, or her home when her world starts again. */
export function greetingText(kind: 'arrival' | 'return', timeZone: string, fallbackWakeTime: string, messages: AlarmMessages = readAlarmMessages(undefined), extra: Record<string, string> = {}): string {
  const base = { ...extra, timeZone, fallbackWakeTime };
  return withTail(fillMessage(messages, kind === 'arrival' ? '第一次到家' : '重新开始', base), messages, base);
}
const dayBefore = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
/** The next look back after `now` at local `time`, and the day it looks back on: one before noon looks back on the day before. */
export function nextReview(now: Date, timeZone: string, time = DEFAULT_REVIEW_TIME): Review {
  const at = nextLocalTime(now, time, timeZone);
  const date = formatLocalTime(at, timeZone).slice(0, 10);
  return { at: at.toISOString(), day: time < '12:00' ? dayBefore(date) : date };
}
/**
 * The look back on `day` once its time has changed to `time`: no day is looked back on twice or skipped. Moved
 * earlier than now, the day's look back is due at once.
 */
export function reviewOf(day: string, now: Date, timeZone: string, time: string): Review {
  let review = nextReview(now, timeZone, time);
  while (review.day < day) review = nextReview(new Date(review.at), timeZone, time);
  return review.day > day ? { at: now.toISOString(), day } : review;
}
/** Where her day is written down; a file that does not exist is left out. */
export interface ReviewFiles { conversations?: string; activity?: string; diaryDir: string; selfFile: string; snapshot?: string }
/** The evening look back: the day, where to read it, and her 我是谁 to rewrite if she has changed. */
export function reviewText(review: Review, now: Date, files: ReviewFiles, timeZone: string, fallbackWakeTime: string, messages: AlarmMessages = readAlarmMessages(undefined), extra: Record<string, string> = {}): string {
  const base = { ...extra, timeZone, fallbackWakeTime };
  const values = { ...base, date: review.day, diaryDir: files.diaryDir, selfFile: files.selfFile, conversations: files.conversations ?? '', activity: files.activity ?? '', snapshot: files.snapshot ?? '', late: lateNotice(now.getTime() - Date.parse(review.at), messages, base) };
  return withTail(fillMessage(messages, '每日回顾', values, { conversations: Boolean(files.conversations), activity: Boolean(files.activity), snapshot: Boolean(files.snapshot) }), messages, base);
}
function lateNotice(late: number, messages: AlarmMessages, values: Record<string, string>): string {
  return late >= LATE_NOTICE_MS ? fillMessage(messages, '晚到说明', { ...values, lateBy: formatDuration(late) }) : '';
}
function withTail(body: string, messages: AlarmMessages, values: Record<string, string>): string {
  const tail = fillMessage(messages, '结尾提醒', values);
  return `${ALARM_MARK}${body}${tail ? `\n${tail}` : ''}`;
}
/** What she hears when a home turn stops well before the time she said she would keep at it. */
export function earlyStopText(alarm: Alarm, now: Date, timeZone: string, messages: AlarmMessages = readAlarmMessages(undefined), extra: Record<string, string> = {}): string {
  const body = fillMessage(messages, '提前停下', { ...extra, timeZone, time: formatLocalTime(new Date(alarm.at), timeZone), now: formatLocalTime(now, timeZone), note: alarm.note }, { note: Boolean(alarm.note) });
  return `${ALARM_MARK}${body}`;
}
const local = (at: string | Date, timeZone: string) => formatLocalTime(new Date(at), timeZone);
/** plan_next's answer. Replacing her own plan says what it carried, while she can still copy it over; the plugin's own alarms are replaced silently. */
export function planReply(at: Date, replaced: Alarm | undefined, timeZone: string): string {
  const old = replaced?.source === 'plan' ? `（替换了原来做到 ${local(replaced.at, timeZone)} 的安排${replaced.note ? `：「${replaced.note}」。还想留着里面的事，就写进新的 note` : ''}。）` : '';
  return `记下了，到 ${local(at, timeZone)} 提醒我。${old}`;
}
export function checkReply(alarm: Alarm | undefined, now: Date, timeZone: string): string {
  if (!alarm) return '现在没有闹钟。';
  const left = Date.parse(alarm.at) - now.getTime();
  const when = `${local(alarm.at, timeZone)}（${left > 0 ? `还有 ${formatDuration(left)}` : '已经到点，正在叫我'}）`;
  if (alarm.source === 'plan') return `我说好${alarm.note ? `做「${alarm.note}」` : ''}做到 ${when}。`;
  return `我现在没有自己定的闹钟。下一次会在 ${when}按平常的时间叫我。`;
}
export function cancelReply(cancelled: Alarm | undefined, next: Alarm | undefined, timeZone: string): string {
  if (cancelled?.source !== 'plan') return `现在没有我自己定的闹钟，不用取消。${next ? `下一次会在 ${local(next.at, timeZone)} 按平常的时间叫我。` : ''}`;
  return `取消了做到 ${local(cancelled.at, timeZone)} 的安排${cancelled.note ? `：「${cancelled.note}」` : ''}。不另定的话，我就休息到 ${next ? local(next.at, timeZone) : '明早'}。`;
}
/** Told once a day, when her home has spent past the daily budget. */
export function budgetText(spent: number, budget: number, messages: AlarmMessages = readAlarmMessages(undefined), extra: Record<string, string> = {}): string {
  return `${ALARM_MARK}${fillMessage(messages, '额度用完', { ...extra, spent: spent.toFixed(2), budget: budget.toFixed(2) })}`;
}
