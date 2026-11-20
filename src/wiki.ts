import type { AuthorDoc } from './memoryFiles.ts';
import { capOwn } from './self.ts';

/** Her wiki's folder in her room: one page per subject, named by its title. */
export const WIKI_FOLDER = '认识';
/** Her own catalog of the pages, `<room>/认识/目录.md`, the same name she gives the notes on her operations. */
export const WIKI_INDEX = '目录';
/** Characters of her catalog placed at the start of a session; the rest is in the file. */
export const CATALOG_CAP = 2000;
/** Related pages listed with one page, each way; the counts say how many more. */
const RELATED_SHOWN = 20;
/** Gaps named in the review line, each kind; the counts say how many in all. */
const GAPS_SHOWN = 5;

/** What a page is linked to and from, worked out from all of her pages each time, so it is never out of date. */
export interface PageRelations {
  links: string[]; linkedFrom: string[];
  /** Pages it names that she has not written (yet, or under another name since). */
  missing: string[];
  /** Its `引用：` refs that no longer point at the text they cited. */
  staleRefs?: string[];
  more?: { links?: number; linkedFrom?: number; missing?: number };
}

/** File names are compared the way Windows compares them. */
const key = (title: string) => title.trim().toLowerCase();
const isIndex = (page: Pick<AuthorDoc, 'title'>) => key(page.title) === key(WIKI_INDEX);
const shown = (titles: readonly string[]) => [...titles].sort((a, b) => a.localeCompare(b, 'zh'));

export function pageRelations(page: AuthorDoc, pages: readonly AuthorDoc[]): PageRelations {
  const titles = new Set(pages.map(each => key(each.title)));
  const lists = {
    links: shown(page.pages),
    linkedFrom: shown(pages.filter(each => each !== page && !isIndex(each) && each.pages.some(target => key(target) === key(page.title))).map(each => each.title)),
    missing: shown(page.pages.filter(title => !titles.has(key(title)))),
  };
  const more = Object.fromEntries(Object.entries(lists).filter(([, list]) => list.length > RELATED_SHOWN).map(([name, list]) => [name, list.length - RELATED_SHOWN]));
  return {
    links: lists.links.slice(0, RELATED_SHOWN), linkedFrom: lists.linkedFrom.slice(0, RELATED_SHOWN), missing: lists.missing.slice(0, RELATED_SHOWN),
    ...(Object.keys(more).length ? { more } : {}),
  };
}

/** The page named `title`, as she writes it in a link or a file name (`[[小林]]`, `小林.md`, `小林`); compared like file names. */
export function pageNamed<T extends Pick<AuthorDoc, 'title'>>(pages: readonly T[], title: string): T | undefined {
  const wanted = key(title.trim().replace(/^\[\[|\]\]$/g, '').replace(/\.(md|txt)$/i, ''));
  return pages.find(page => key(page.title) === wanted);
}
/** Names to offer when `title` names no page: those that contain it or that it contains, else the newest. */
export function nearTitles(pages: readonly AuthorDoc[], title: string, count = 8): string[] {
  const wanted = key(title.replace(/^\[\[|\]\]$/g, ''));
  const near = pages.filter(page => { const name = key(page.title); return name.includes(wanted) || wanted.includes(name); });
  return (near.length ? near : [...pages].sort((a, b) => b.timeMs - a.timeMs)).slice(0, count).map(page => page.title);
}

const HEAD = (dir: string) => `【我写过的认识】页面在 ${dir}，一个主题一个文件，页和页用 [[标题]] 互相链接。想看哪一页，用 wiki_open 写页名打开；想查哪一页提到过某件事，用 memory_find（kinds 写 wiki）。`;
/**
 * What she sees of her wiki when a session starts: her own `目录.md`, cut like her 我是谁; before she has written one,
 * the page names, newest first, as many as fit. Nothing of a page's body. Undefined when she has no page.
 */
export function wikiCatalog(pages: readonly AuthorDoc[], dir: string): string | undefined {
  const index = pages.find(isIndex)?.content.trim();
  if (index) {
    const { text, rest } = capOwn(index, CATALOG_CAP);
    return `${HEAD(dir)}下面是我自己整理的目录：\n<目录.md>\n${text}\n</目录.md>${rest ? `\n（目录后面还有 ${rest} 字没读进来，要看全就读 目录.md。）` : ''}`;
  }
  const others = pages.filter(page => !isIndex(page)).sort((a, b) => b.timeMs - a.timeMs);
  if (!others.length) return undefined;
  const lines: string[] = [];
  let used = 0;
  for (const page of others) {
    const line = `- [[${page.title}]]`;
    if (used + line.length + 1 > CATALOG_CAP) break;
    lines.push(line); used += line.length + 1;
  }
  const cut = lines.length < others.length ? `\n（只列出最近改过的 ${lines.length} 页，共 ${others.length} 页，其余用 memory_find 翻。）` : '';
  return `${HEAD(dir)}还没有整理目录（每晚回顾时可以写 目录.md），这些是我写过的页，最近改过的在前：\n${lines.join('\n')}${cut}`;
}

const listed = (items: readonly string[]) => `${items.slice(0, GAPS_SHOWN).join('、')}${items.length > GAPS_SHOWN ? ` 等 ${items.length} 个` : ''}`;
/**
 * The facts her evening review is given about her wiki, for her to mend while she tidies it: links to pages that do
 * not exist, pages her catalog leaves out, refs that went stale. Undefined when there is nothing to say.
 */
export function wikiGaps(pages: readonly AuthorDoc[], stale: (page: AuthorDoc) => readonly string[] = () => []): string | undefined {
  const titles = new Set(pages.map(page => key(page.title)));
  const broken = pages.flatMap(page => page.pages.filter(target => !titles.has(key(target))).map(target => `${page.title} → ${target}`));
  // A page named anywhere in her catalog is in it, written as [[标题]] or not.
  const index = pages.find(isIndex), catalogText = index?.content.toLowerCase() ?? '';
  const outside = pages.filter(page => !isIndex(page) && !catalogText.includes(key(page.title))).map(page => page.title);
  const staleIn = pages.filter(page => stale(page).length).map(page => page.title);
  const parts = [
    ...broken.length ? [`${broken.length} 处 [[链接]] 指向还没有的页：${listed(broken)}（写那一页，或者改成对的名字）`] : [],
    ...outside.length ? [index ? `${outside.length} 页还不在目录.md 里：${listed(outside)}` : `有 ${outside.length} 页，还没有目录.md`] : [],
    ...staleIn.length ? [`${staleIn.length} 页里有「引用：」指向的原文已经改过：${listed(staleIn)}`] : [],
  ];
  return parts.length ? `认识页的情况：${parts.join('；')}。整理认识时顺手处理。` : undefined;
}
