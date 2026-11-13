import { readFileSync, statSync } from 'node:fs';
import { errorText } from './faults.ts';

/** Her mood, kept in her room. The plugin never writes it: it only reads it back to her. */
export const MOOD_FILE = 'mood.md';
/**
 * The fixed set, always shown in this order and at 0 when unset, so one snapshot compares with the next. Free words
 * would pile up as near-synonyms (高兴 beside 开心) with no end; what the set cannot say goes into the small things.
 */
export const MOODS = ['开心', '兴奋', '平静', '安心', '烦', '生气', '紧张', '难过', '累', '孤单', '想念'] as const;
const known = (name: string) => (MOODS as readonly string[]).includes(name);
const MAX_TRIVIA_LINES = 3, MAX_TRIVIA_CHARS = 12;

export type Mood =
  | { kind: 'none' }
  | { kind: 'failed'; message: string }
  | { kind: 'mood'; values: Map<string, number>; trivia: string[]; cut: boolean; unread: number; outside: string[] };

/**
 * One thing per line. A line ending in a number after a space, a full-width space or a colon is a mood `名字 数值`,
 * its value a whole number from 0 to 10; a line ending in anything else is a small thing beside her mood. A later line
 * for the same mood wins. A mood line she got wrong is counted, and a name outside the set is named back to her;
 * neither is ever taken as a small thing.
 */
export function parseMood(text: string): Mood {
  const values = new Map<string, number>(), trivia: string[] = [], outside: string[] = [];
  let cut = false, unread = 0;
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const pair = /^(.*?)[\s　:：]+([+-]?\d+(?:\.\d+)?)$/u.exec(line);
    if (pair) {
      const name = pair[1]!.trim(), value = Number(pair[2]);
      if (!name || !Number.isInteger(value) || value < 0 || value > 10) unread++;
      else if (!known(name)) { if (!outside.includes(name)) outside.push(name); }
      else values.set(name, value);
      continue;
    }
    if (trivia.length === MAX_TRIVIA_LINES) { cut = true; continue; }
    const chars = Array.from(line);
    if (chars.length > MAX_TRIVIA_CHARS) cut = true;
    trivia.push(chars.slice(0, MAX_TRIVIA_CHARS).join(''));
  }
  return values.size || trivia.length || unread || outside.length ? { kind: 'mood', values, trivia, cut, unread, outside } : { kind: 'none' };
}

/** A missing or blank file is `none`, not every mood at 0; a file that cannot be read is `failed`. */
export function readMood(path: string): Mood {
  try {
    if (!statSync(path).isFile()) return { kind: 'failed', message: '不是普通文件' };
    return parseMood(readFileSync(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' };
    return { kind: 'failed', message: errorText(error) };
  }
}

/** Shown once after an earlier snapshot when she has emptied or removed the file, so the old values stop counting. */
export const MOOD_CLEARED = '【我的心情值】现在没有心情值（mood.md 不在或是空的），之前那条不再算数；想记的时候用 set_mood。';

export interface MoodValue { name: string; value: number }
/** Every mood of the set in its order, at 0 when she has not set it. */
export function moodValues(mood: Extract<Mood, { kind: 'mood' }>): MoodValue[] {
  return MOODS.map(name => ({ name, value: mood.values.get(name) ?? 0 }));
}
const outsideNote = (names: readonly string[]) => `（${names.join('、')} 不在固定的心情里，没有算进去；换成最接近的那个，细的写进小事）`;

/** What she reads just before the time block, in her own voice; undefined when there is nothing to show. */
export function moodText(mood: Mood): string | undefined {
  if (mood.kind === 'none') return undefined;
  if (mood.kind === 'failed') return '【我的心情值】mood.md 读不出来，之前那条不再算数；可以用 set_mood 重新记。';
  const lines = [`【我的心情值】${moodValues(mood).map(value => `${value.name} ${value.value}`).join(' · ')}（以最新一条为准，用 set_mood 改）`];
  if (mood.trivia.length) lines.push(`旁边：${mood.trivia.join('；')}${mood.cut ? '……后面还有' : ''}`);
  if (mood.outside.length) lines.push(outsideNote(mood.outside));
  if (mood.unread) lines.push(`（mood.md 里有 ${mood.unread} 行没读懂）`);
  return lines.join('\n');
}

export type MoodView =
  | { kind: 'none' }
  | { kind: 'failed'; message: string }
  | { kind: 'mood'; values: MoodValue[]; trivia: string[]; cut: boolean; unread: number; outside: string[]; updatedAt: string | null };
/** The world console's read-only view: what she reads, plus when she last changed the file. */
export function moodView(path: string): MoodView {
  const mood = readMood(path);
  if (mood.kind !== 'mood') return mood;
  let updatedAt: string | null = null;
  try { updatedAt = statSync(path).mtime.toISOString(); } catch { /* removed since it was read; the values still stand */ }
  return { kind: 'mood', values: moodValues(mood), trivia: mood.trivia, cut: mood.cut, unread: mood.unread, outside: mood.outside, updatedAt };
}
