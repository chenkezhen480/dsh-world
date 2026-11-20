import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { collectPaths } from './activity.ts';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const diaryName = /^(\d{4}-\d{2}-\d{2})\.md$/;
export function createDiaryReader(diaryDir: string) {
  const dates = () => existsSync(diaryDir) ? readdirSync(diaryDir).filter(name => diaryName.test(name)).map(name => name.slice(0, 10)).sort().reverse() : [];
  /** Only YYYY-MM-DD names are accepted, so a date can never escape the diary directory. */
  const read = (date: string) => { const file = join(diaryDir, `${date}.md`); return datePattern.test(date) && existsSync(file) ? readFileSync(file, 'utf8') : undefined; };
  return { dates, read };
}

/** The host's file tools that change a file; reading tools and the shell are not judged. */
const FILE_WRITERS = new Set(['write', 'edit']);
/** The files a call of the host's file tools would change; relative paths resolve against `cwd`. */
const writtenFiles = (tool: string, args: unknown, cwd: string) => FILE_WRITERS.has(tool) ? collectPaths(args, false, []).map(path => resolve(cwd, path)) : [];
const directlyIn = (dir: string, file: string) => relative(resolve(dir), dirname(file)) === '';
/**
 * Why a file tool call may not run: it changes the diary of a day already closed. A wrong or outgrown entry is
 * corrected in today's diary, so what she wrote then stays as she wrote it. Only `YYYY-MM-DD.md` files directly in the
 * diary directory are dated diaries; any other file there is left to her.
 */
export function closedDiaryRefusal(tool: string, args: unknown, diaryDir: string, cwd: string, open: ReadonlySet<string>, today: string): string | undefined {
  for (const file of writtenFiles(tool, args, cwd)) {
    const day = diaryName.exec(basename(file))?.[1];
    if (!day || open.has(day) || !directlyIn(diaryDir, file)) continue;
    return `${day} 的日记已经合上了，不能再改。写错了或者现在想法不一样了，就写进今天（${today}）的日记：哪里记错了、现在怎么看。`;
  }
  return undefined;
}
/**
 * Why a file tool call may not run: it changes her wiki from a session other than her home. Her sessions run side by
 * side, and two writers of one page overwrite each other; her home's turns come one after another.
 */
export function wikiRefusal(tool: string, args: unknown, wikiDir: string, cwd: string, home: boolean): string | undefined {
  if (home) return undefined;
  return writtenFiles(tool, args, cwd).some(file => directlyIn(wikiDir, file))
    ? '认识页只在家里整理（每晚回顾时）。现在想到的，先记进今天的日记，回顾时再改那一页。' : undefined;
}
