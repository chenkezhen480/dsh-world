import { readFileSync, statSync } from 'node:fs';
import { errorText } from './faults.ts';

/** Her mood, kept in her room. The plugin never writes it: it only reads it back to her. */
export const MOOD_FILE = 'mood.md';
/** Always shown, at 0 when she has not set them, so one snapshot compares with the next. */
export const DEFAULT_MOODS = ['开心', '兴奋', '平静', '累', '困', '烦', '难过', '紧张'] as const;
const MAX_NAME = 12, MAX_TRIVIA_LINES = 3, MAX_TRIVIA_CHARS = 12;

export type Mood =
  | { kind: 'none' }
  | { kind: 'failed'; message: string }
  | { kind: 'mood'; values: Map<string, number>; trivia: string[]; cut: boolean; unread: number };

/**
 * One thing per line. A line ending in a number after a space, a full-width space or a colon is a mood `名字 数值`,
 * its value a whole number from 0 to 10; a line ending in anything else is a small thing beside her mood. A later line
 * for the same mood wins. A mood line she got wrong is counted, never taken as a small thing.
 */
export function parseMood(text: string): Mood {
  const values = new Map<string, number>(), trivia: string[] = [];
  let cut = false, unread = 0;
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const pair = /^(.*?)[\s　:：]+([+-]?\d+(?:\.\d+)?)$/u.exec(line);
    if (pair) {
      const name = pair[1]!.trim(), value = Number(pair[2]);
      if (!name || Array.from(name).length > MAX_NAME || !Number.isInteger(value) || value < 0 || value > 10) unread++;
      else values.set(name, value);
      continue;
    }
    if (trivia.length === MAX_TRIVIA_LINES) { cut = true; continue; }
    const chars = Array.from(line);
    if (chars.length > MAX_TRIVIA_CHARS) cut = true;
    trivia.push(chars.slice(0, MAX_TRIVIA_CHARS).join(''));
  }
  return values.size || trivia.length || unread ? { kind: 'mood', values, trivia, cut, unread } : { kind: 'none' };
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
export const MOOD_CLEARED = '【我的心情值】现在没有心情值（mood.md 不在或是空的），之前那条不再算数。';

/** What she reads just before the time block, in her own voice; undefined when there is nothing to show. */
export function moodText(mood: Mood): string | undefined {
  if (mood.kind === 'none') return undefined;
  if (mood.kind === 'failed') return '【我的心情值】mood.md 读不出来，之前那条不再算数。';
  const shown = DEFAULT_MOODS.map(name => `${name} ${mood.values.get(name) ?? 0}`);
  const own = [...mood.values].filter(([name]) => !(DEFAULT_MOODS as readonly string[]).includes(name)).map(([name, value]) => `${name} ${value}`);
  const lines = [`【我的心情值】${shown.join(' · ')}${own.length ? `｜我自己加的：${own.join(' · ')}` : ''}（以最新一条为准）`];
  if (mood.trivia.length) lines.push(`旁边：${mood.trivia.join('；')}${mood.cut ? '……后面还有' : ''}`);
  if (mood.unread) lines.push(`（mood.md 里有 ${mood.unread} 行没读懂）`);
  return lines.join('\n');
}
