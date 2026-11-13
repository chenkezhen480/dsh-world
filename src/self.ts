import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

/** Characters of her self-description read per session; she is asked to keep it to what matters. */
export const SELF_CAP = 5000;

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
