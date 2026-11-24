import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatLocalTime } from '../timeContext.ts';
import { renderTemplate } from '../worldPrompt.ts';

/** The alarm wording shipped with the plugin; a world's own `alarm.md` replaces it section by section. */
export const DEFAULT_ALARM_FILE = fileURLToPath(new URL('../../templates/alarm.md', import.meta.url));
export const MESSAGE_KEYS = ['第一次到家', '重新开始', '早上兜底', '闹钟响了', '晚到说明', '没定闹钟', '每日回顾', '额度用完', '结尾提醒', 'plan_next 说明', 'check_alarm 说明', 'cancel_alarm 说明'] as const;
export type MessageKey = typeof MESSAGE_KEYS[number];
/** Marks her own alarm messages (in her own voice); the compaction instruction relies on it, so a template cannot drop it. Before 0.5 it read 【你的时间】. */
export const ALARM_MARK = '【我的时间】';

/** `## name` sections; with `names`, other Markdown headings stay in the current body. */
export function parseSections(text: string, names?: readonly string[]): Map<string, string> {
  const sections = new Map<string, string>();
  let key: string | undefined; let lines: string[] = [];
  const close = () => { if (key !== undefined) sections.set(key, lines.join('\n').trim()); };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = /^## (.+?)\s*$/.exec(line);
    if (heading && (!names || names.includes(heading[1]!))) { close(); key = heading[1]!; lines = []; } else if (key !== undefined) lines.push(line);
  }
  close();
  return sections;
}
export interface AlarmMessages { sections: Record<MessageKey, string>; error?: string }
/** Never throws: an unreadable world file falls back to the shipped wording and says why. Missing sections use the shipped ones. */
export function readAlarmMessages(file: string | undefined): AlarmMessages {
  const shipped = parseSections(readFileSync(DEFAULT_ALARM_FILE, 'utf8'));
  let own = new Map<string, string>(); let error: string | undefined;
  if (file && existsSync(file)) {
    try { own = parseSections(readFileSync(file, 'utf8')); }
    catch (cause) { error = `闹钟模板 ${file} 读不了，先用默认的：${cause instanceof Error ? cause.message : String(cause)}`; }
  }
  const sections = Object.fromEntries(MESSAGE_KEYS.map(key => [key, own.get(key) ?? shipped.get(key) ?? ''])) as Record<MessageKey, string>;
  return error ? { sections, error } : { sections };
}
export function fillMessage(messages: AlarmMessages, key: MessageKey, values: Record<string, string>, flags: Record<string, boolean> = {}): string {
  return renderTemplate(messages.sections[key], flags, values);
}
/** A fixed example time with the offset of the configured zone, so the description never changes between runs. */
export function exampleTime(timeZone: string): string {
  const offset = formatLocalTime(new Date('2026-10-23T12:00:00Z'), timeZone).slice(-6);
  return `2026-10-23T21:00:00${offset}`;
}
