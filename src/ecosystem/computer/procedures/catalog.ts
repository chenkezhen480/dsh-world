// src/ecosystem/computer/procedures/catalog.ts
import { dirname, join } from 'node:path';
import type { ProcedureLibrary, StoredProcedure } from './library.ts';
import { cut } from './run.ts';

const GUIDE_SHOWN = 500;
const START_HINT = '用 page_* 自己摸索，走通了用 procedure_save 存进一个分类，再用 procedure_note 写这一类的说明。';

/** Two-letter overlap a misspelt word still needs, so bilbili finds bilibili but a stray shared letter finds nothing. */
const SIMILAR = 0.6;

/**
 * The words in a text, lower-cased; one letter alone names nothing. Chinese runs stay whole: a word like 微信 has no
 * spaces around it, so a run of hers is matched by containment below, not split.
 */
const words = (text: string) => text.toLowerCase().split(/[\s,，、。.;；:：/|()（）「」【】!！?？]+/u).filter(word => [...word].length > 1);
const pairs = (word: string) => { const chars = [...word]; return new Set(chars.slice(1).map((ch, i) => chars[i]! + ch)); };
/** How much of `a` and `b` is the same: the shorter one's length when one holds the other, else by shared letter pairs. */
function closeness(a: string, b: string): number {
  const shorter = Math.min([...a].length, [...b].length);
  if (a.includes(b) || b.includes(a)) return shorter;
  const x = pairs(a), y = pairs(b);
  const dice = 2 * [...x].filter(pair => y.has(pair)).length / (x.size + y.size);
  return dice >= SIMILAR ? dice * shorter : 0;
}
/**
 * How well `target` names the object `haystack` describes: each word of hers counts by its closest word there.
 * Word against word, never letters scattered through her note, or 消息 in 消息框 would pull in 发送消息.
 */
function score(target: string, haystack: string): number {
  const hay = words(haystack);
  return words(target).reduce((sum, word) => sum + Math.max(0, ...hay.map(other => closeness(word, other))), 0);
}

interface Group { name: string; guide: string; operations: StoredProcedure[] }
function groups(library: ProcedureLibrary): Group[] {
  const all = library.list();
  // Newest first: what she saved or fixed last is likeliest what she is doing now.
  const newest = (a: StoredProcedure, b: StoredProcedure) => b.modified - a.modified;
  return library.categories().map(({ name, guide }) => ({ name, guide, operations: all.filter(entry => entry.procedure.category === name).sort(newest) }));
}
/**
 * A category as she needs it to pick an operation: her note, the operation names and the folder. The names are short
 * and say what each does; parameters and steps are in the files, which she reads only for the one she picks.
 */
function section(library: ProcedureLibrary, group: Group): string {
  const lines = [group.name];
  if (group.guide.trim()) lines.push(cut(group.guide.trim(), GUIDE_SHOWN));
  lines.push(group.operations.length ? `操作：${group.operations.map(({ procedure }) => procedure.name).join('、')}` : '（这一类还没有操作）');
  // Files the development build left flat sit in the root, not in the 未分类 folder.
  const folders = group.operations.length ? [...new Set(group.operations.map(({ file }) => dirname(file)))] : [join(library.dir, group.name)];
  lines.push(`文件在 ${folders.join('、')}，一个操作一个 <名字>.json；要看参数和步骤就读它。`);
  return `${lines.join('\n')}\n\n用 procedure_run("${group.name}/操作名", 参数) 直接跑；没有合适的就用 page_* 自己做，走通了 procedure_save 存进来。`;
}

/**
 * What `computer_use` answers. A target names the thing she is about to use, a program or a site, so it is matched
 * against the category name and her note only: operations are named by what they do, and the same 发送消息 under
 * several categories would pull in the lists of things she is not using. One category comes back, never a mix.
 */
export function catalogText(library: ProcedureLibrary, target?: string): string {
  const all = groups(library);
  if (!target?.trim()) {
    if (!all.length) return `还没有学会的操作。${START_HINT}`;
    return `学会的操作：${all.map(group => `${group.name}（${group.operations.length} 个）`).join('、')}。要用某一类，用 computer_use 说出它的名字。`;
  }
  const named = target.trim();
  const ranked = all.map(group => ({ group, score: score(named, `${group.name} ${group.guide}`) })).filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) {
    if (!all.length) return `还没有学会的操作。${START_HINT}`;
    return `没有对得上「${named}」的分类（已有：${all.map(group => group.name).join('、')}）。是其中一类的话，用 procedure_note 在它的说明里写上这个叫法；不是就${START_HINT}`;
  }
  const best = ranked.filter(entry => entry.score === ranked[0]!.score);
  if (best.length > 1) return `「${named}」对得上不止一类：${best.map(({ group }) => group.name).join('、')}。用 computer_use 说出其中一类的名字。`;
  return section(library, ranked[0]!.group);
}
