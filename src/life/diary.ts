import { join } from 'node:path';
import { bounded, DEFAULT_SEARCH_LIMIT, isCalendarDate, regularNames, readRegularText, snippet } from './search.ts';

const diaryFilePattern = /^\d{4}-\d{2}-\d{2}\.md$/;
export interface TextHit { date: string; text: string; }

export function createDiaryReader(diaryDir: string) {
  const dates = () => regularNames(diaryDir, diaryFilePattern).map(name => name.slice(0, 10)).filter(isCalendarDate).sort().reverse();
  /** Only YYYY-MM-DD names are accepted, so a date can never escape the diary directory. */
  const read = (date: string) => isCalendarDate(date) ? readRegularText(join(diaryDir, `${date}.md`)) : undefined;
  const search = (query: string, limit = DEFAULT_SEARCH_LIMIT): TextHit[] => {
    const needle = query.trim(); if (!needle) return [];
    return bounded(dates().flatMap(date => { const text = read(date); return text && text.toLowerCase().includes(needle.toLowerCase()) ? [{ date, text: snippet(text, needle) }] : []; }), limit);
  };
  return { dates, read, search };
}
