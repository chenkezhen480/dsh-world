import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { bounded, clipText, DEFAULT_SEARCH_LIMIT, isCalendarDate, MAX_SEARCH_TOTAL, regularNames, readRegularText, snippet } from './life/search.ts';

/** Characters of her self-description read per session; she is asked to keep it to what matters. */
export const SELF_CAP = 4000;

export interface SelfHit { version: 'current' | 'history'; date?: string; text: string }

/**
 * Her 我是谁 file as it goes into `{{self}}`: only what she wrote, tagged so her own headings do not read as
 * sections of the world prompt. What the file is and that she may rewrite it is the template's to say.
 * Empty when she has not written it. Never throws: an unreadable file becomes a short note.
 */
export function renderSelf(selfFile: string): string {
  let text: string;
  // trim() also drops a leading BOM.
  try { text = existsSync(selfFile) ? readFileSync(selfFile, 'utf8').trim() : ''; }
  catch (error) { return `（这次没能读到我是谁.md：${error instanceof Error ? error.message : String(error)}。它还在，下次会再试。）`; }
  if (!text) return '';
  const chars = Array.from(text);
  const capped = chars.length > SELF_CAP;
  const body = `<我是谁.md>\n${capped ? chars.slice(0, SELF_CAP).join('') : text}\n</我是谁.md>`;
  return capped ? `${body}\n（后面还有 ${chars.length - SELF_CAP} 字没读进来；挑最要紧的留下吧。）` : body;
}
/** Keeps her 我是谁 as it is today beside it, in `<name>.history/<day><ext>`, so every change she makes can be seen and undone. Undefined when she has not written one. */
export function keepSelfCopy(selfFile: string, day: string): string | undefined {
  if (!existsSync(selfFile)) return undefined;
  const ext = extname(selfFile);
  const dir = join(dirname(selfFile), `${basename(selfFile, ext)}.history`);
  mkdirSync(dir, { recursive: true });
  const copy = join(dir, `${day}${ext}`);
  copyFileSync(selfFile, copy);
  return copy;
}

/** Searches the current self-description and its dated history without changing the prompt's current self. */
export function searchSelf(selfFile: string, query: string, limit = DEFAULT_SEARCH_LIMIT): SelfHit[] {
  const needle = query.trim(); if (!needle) return [];
  const hits: SelfHit[] = [];
  const current = readRegularText(selfFile)?.replace(/^\uFEFF/, '').trim();
  if (current && current.toLowerCase().includes(needle.toLowerCase())) hits.push({ version: 'current', text: snippet(current, needle) });
  const ext = extname(selfFile); const dir = join(dirname(selfFile), `${basename(selfFile, ext)}.history`);
  for (const name of regularNames(dir, new RegExp(`^\\d{4}-\\d{2}-\\d{2}${escapeRegExp(ext)}$`)).sort().reverse()) {
    const date = name.slice(0, 10);
    if (!isCalendarDate(date)) continue;
    const text = readRegularText(join(dir, name))?.replace(/^\uFEFF/, '').trim();
    if (text && text.toLowerCase().includes(needle.toLowerCase())) hits.push({ version: 'history', date, text: snippet(text, needle) });
  }
  return bounded(hits, limit);
}

/** Compares two self-description versions with a bounded line diff. `current` selects the live file. */
export function compareSelf(selfFile: string, older: string, newer: string): { older: string; newer: string; truncated: boolean; changes: { kind: 'removed' | 'added'; text: string }[] } {
  const readVersion = (version: string): string => {
    if (version !== 'current' && !isCalendarDate(version)) throw new Error('版本必须是 current 或有效的 YYYY-MM-DD 日期');
    const ext = extname(selfFile);
    const file = version === 'current' ? selfFile : join(dirname(selfFile), `${basename(selfFile, ext)}.history`, `${version}${ext}`);
    const text = readRegularText(file);
    if (text === undefined) throw new Error(`找不到可读取的版本：${version}`);
    return text.replace(/^\uFEFF/, '').trim().slice(0, MAX_SEARCH_TOTAL * 4);
  };
  const leftAll = readVersion(older).split(/\r?\n/), rightAll = readVersion(newer).split(/\r?\n/);
  let truncated = leftAll.length > 200 || rightAll.length > 200;
  const left = leftAll.slice(0, 200), right = rightAll.slice(0, 200);
  // A small LCS table gives a readable insertion/deletion diff. Inputs are capped above.
  const rows = left.length + 1, cols = right.length + 1;
  const lcs = Array.from({ length: rows }, () => new Uint16Array(cols));
  for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--)
    lcs[i]![j] = left[i] === right[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const changes: { kind: 'removed' | 'added'; text: string }[] = [];
  let i = 0, j = 0, total = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) { i++; j++; continue; }
    const remove = i < left.length && (j >= right.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!);
    const kind = remove ? 'removed' : 'added';
    const rawLine = (remove ? left[i++] : right[j++])!;
    if (Array.from(rawLine).length > 800) truncated = true;
    const line = clipText(rawLine, 800);
    const size = Array.from(line).length;
    if (total + size > MAX_SEARCH_TOTAL) { truncated = true; break; }
    changes.push({ kind, text: line }); total += size;
  }
  return { older, newer, truncated, changes };
}

function escapeRegExp(text: string): string { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
