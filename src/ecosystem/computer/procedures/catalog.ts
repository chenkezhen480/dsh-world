// src/ecosystem/computer/procedures/catalog.ts
import type { Procedure } from './format.ts';
import type { ProcedureLibrary, RunNote, StoredProcedure } from './library.ts';
import { cut } from './run.ts';

const MAX_CATEGORIES = 3, MAX_OPERATIONS = 15, GUIDE_SHOWN = 500;
const RUN_HINT = '用 procedure_run("分类/操作", 参数) 直接跑；没有合适的就用 page_* 自己做，走通了 procedure_save 存进来。';
const START_HINT = '用 page_* 自己摸索，走通了用 procedure_save 存进一个分类，再用 procedure_note 写这一类的说明。';

/** The words she named. Chinese runs stay whole: a word like 私信 has no spaces around it. */
const words = (text: string) => text.toLowerCase().split(/[\s,，、。.;；:：/|()（）]+/u).filter(Boolean);
const letters = (text: string) => new Set([...text.toLowerCase()].filter(ch => /[\p{L}\p{N}]/u.test(ch)));

/**
 * How well `target` names what `haystack` describes: words of hers found whole count most (by length), letters shared
 * break ties. Literal only, like the memory search: no vectors, nothing she did not say.
 */
export function score(target: string, haystack: string): number {
  const hay = haystack.toLowerCase();
  const whole = words(target).filter(word => hay.includes(word)).reduce((sum, word) => sum + [...word].length * 10, 0);
  const wanted = letters(target), have = letters(hay);
  const shared = [...wanted].filter(ch => have.has(ch)).length;
  if (!whole && shared < Math.max(2, Math.ceil(wanted.size / 2))) return 0;
  return whole + shared;
}

interface Group { name: string; guide: string; operations: StoredProcedure[] }
function groups(library: ProcedureLibrary): Group[] {
  const all = library.list();
  return library.categories().map(({ name, guide }) => ({ name, guide, operations: all.filter(entry => entry.procedure.category === name) }));
}
const lastText = (last: RunNote | undefined) => !last ? '还没跑过' : last.ok ? `最近：成功 ${last.at}` : `最近：失败 ${last.at}：${cut(last.detail ?? '', 60)}`;
/** A full-width bracket already sets the name apart, so the dash follows it without a space. */
const heading = (procedure: Procedure) => { const names = Object.keys(procedure.params); return names.length ? `${procedure.name}（${names.join(', ')}）— ` : `${procedure.name} — `; };
function section(library: ProcedureLibrary, group: Group): string {
  const lines = [group.name];
  if (group.guide.trim()) lines.push(cut(group.guide.trim(), GUIDE_SHOWN));
  lines.push(group.operations.length ? '操作：' : '（这一类还没有操作）');
  for (const { procedure, path } of group.operations.slice(0, MAX_OPERATIONS)) {
    lines.push(`- ${heading(procedure)}${procedure.description}（${lastText(library.lastRun(path))}）`);
  }
  if (group.operations.length > MAX_OPERATIONS) lines.push(`（还有 ${group.operations.length - MAX_OPERATIONS} 个，说得更具体些可以缩小范围）`);
  return lines.join('\n');
}

/** What `computer_use` answers: with a target, the categories it names; without, the names of all of them. */
export function catalogText(library: ProcedureLibrary, target?: string): string {
  const all = groups(library);
  if (!target?.trim()) {
    if (!all.length) return `还没有学会的操作。${START_HINT}`;
    return `学会的操作：${all.map(group => `${group.name}（${group.operations.length} 个）`).join('、')}。要用某一类，用 computer_use 说出它的名字。`;
  }
  const haystack = (group: Group) => [group.name, group.guide, ...group.operations.flatMap(({ procedure }) => [procedure.name, procedure.description])].join(' ');
  const ranked = all.map(group => ({ group, score: score(target, haystack(group)) })).filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score).slice(0, MAX_CATEGORIES);
  if (!ranked.length) return `还没有学会和「${target.trim()}」相关的操作${all.length ? `（已有：${all.map(group => group.name).join('、')}）` : ''}。${START_HINT}`;
  return [...ranked.map(({ group }) => section(library, group)), RUN_HINT].join('\n\n');
}
