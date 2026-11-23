import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

/** Characters of her self-description read per session; she is asked to keep it to what matters. */
export const SELF_CAP = 5000;

/**
 * Her 「我」 in her room: `我.md`. A world that has only the `我是谁.md` it was called before keeps that file, never
 * renamed or moved; once the partner renames it, the new name is read from the next start.
 */
export function selfFileIn(roomDir: string): string {
  const current = join(roomDir, '我.md'), earlier = join(roomDir, '我是谁.md');
  return !existsSync(current) && existsSync(earlier) ? earlier : current;
}

/**
 * Her 「我」 as it goes into `{{self}}`: only what she wrote, tagged with its file name so her own headings do not read as
 * sections of the world prompt. What the file is and that she may rewrite it is the template's to say.
 * Empty when she has not written it. Never throws: an unreadable file becomes a short note.
 */
export function renderSelf(selfFile: string): string {
  const name = basename(selfFile);
  let text: string;
  // trim() also drops a leading BOM.
  try { text = existsSync(selfFile) ? readFileSync(selfFile, 'utf8').trim() : ''; }
  catch (error) { return `（这次没能读到${name}：${error instanceof Error ? error.message : String(error)}。它还在，下次会再试。）`; }
  if (!text) return '';
  const { text: read, rest } = capOwn(text, SELF_CAP);
  const body = `<${name}>\n${read}\n</${name}>`;
  return rest ? `${body}\n（后面还有 ${rest} 字没读进来；挑最要紧的留下吧。）` : body;
}
/** Her own text as much of it as is read in, by characters, never splitting one; `rest` is how many were left out. */
export function capOwn(text: string, cap: number): { text: string; rest: number } {
  const chars = Array.from(text);
  return chars.length > cap ? { text: chars.slice(0, cap).join(''), rest: chars.length - cap } : { text, rest: 0 };
}
/** Keeps her 「我」 as it is today beside it, in `<name>.history/<day><ext>`, so every change she makes can be seen and undone. Undefined when she has not written one. */
export function keepSelfCopy(selfFile: string, day: string): string | undefined {
  if (!existsSync(selfFile)) return undefined;
  const ext = extname(selfFile);
  const dir = join(dirname(selfFile), `${basename(selfFile, ext)}.history`);
  mkdirSync(dir, { recursive: true });
  const copy = join(dir, `${day}${ext}`);
  copyFileSync(selfFile, copy);
  return copy;
}
