import { readFileSync, statSync } from 'node:fs';
import { errorText } from '../faults.ts';
import { formatDuration } from './alarm.ts';

/** The note she keeps for herself in her room. The plugin never writes it: it only reads it back. */
export const FOCUS_FILE = 'focus.md';
/** It rides on every wake, so a long note is cut rather than resent whole. */
export const FOCUS_MAX_CHARS = 200;

export type FocusNote =
  | { kind: 'none' }
  | { kind: 'note'; text: string; ageMs: number }
  | { kind: 'failed'; message: string };

/**
 * A missing or blank note is `none`; a note that cannot be read is reported instead, so a permission problem never
 * looks like she simply has not written one.
 */
export function readFocusNote(path: string, now: Date): FocusNote {
  try {
    const info = statSync(path);
    if (!info.isFile()) return { kind: 'failed', message: '不是普通文件' };
    const text = readFileSync(path, 'utf8')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .join('；');
    if (!text) return { kind: 'none' };
    return { kind: 'note', text, ageMs: Math.max(0, now.getTime() - info.mtimeMs) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' };
    return { kind: 'failed', message: errorText(error) };
  }
}

/** What she reads in her own message: first person, one line, the time it was written, no advice. */
export function focusLine(note: FocusNote): string | undefined {
  if (note.kind !== 'note') return undefined;
  const chars = Array.from(note.text);
  const text = chars.length > FOCUS_MAX_CHARS ? `${chars.slice(0, FOCUS_MAX_CHARS).join('')}……后面还有` : note.text;
  const ago = note.ageMs < 60_000 ? '刚刚' : ` ${formatDuration(note.ageMs)}前`;
  return `我${ago}在 ${FOCUS_FILE} 写下：${text}`;
}
