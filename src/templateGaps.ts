import { existsSync, readFileSync } from 'node:fs';
import { errorText } from './faults.ts';
import { DEFAULT_ALARM_FILE, MESSAGE_KEYS, parseSections } from './life/messages.ts';
import { DEFAULT_TEMPLATE_FILE, renderTemplate } from './worldPrompt.ts';

/**
 * Where her own template falls short of the shipped one, for the console to say; nothing is ever added to what she
 * reads. `text` is the shipped section, to copy over by hand.
 */
export interface TemplateGap {
  heading: string;
  /** Variables the shipped section uses and hers does not; absent when the whole section is missing. */
  missing?: string[];
  /** Her section is there under the name it had before: `from` is that name, `note` what the rename changed. */
  renamed?: { from: string; note: string };
  text: string;
}

const HEADING = /^#{1,6}\s+(.+?)\s*$/;
const OPENERS = /^\s*(?:\{\{[#^]\w+\}\}\s*)+$/;
const TAG = /\{\{([#^/]?)(\w+)\}\}/g;

/** The variables a text uses: values and flags alike, the way a capability gets into a template. */
const variables = (text: string) => new Set([...text.matchAll(TAG)].filter(([, kind]) => kind !== '/').map(([, , name]) => name!));

/** A flag opened or closed in another section is dropped, so a copied section never leaves a stray tag behind. */
function balanced(text: string): string {
  const count = (name: string, kinds: string) => [...text.matchAll(TAG)].filter(([, kind, each]) => each === name && kinds.includes(kind!)).length;
  const uneven = [...new Set([...text.matchAll(TAG)].filter(([, kind]) => kind).map(([, , name]) => name!))].filter(name => count(name, '#^') !== count(name, '/'));
  return uneven.reduce((kept, name) => kept.replace(new RegExp(String.raw`\{\{[#^/]${name}\}\}\n?`, 'g'), ''), text).trim();
}

/** A template's sections by heading. A line of opening tags just above a heading opens that section; before the first heading is 开头. */
export function sectionsOf(template: string): { heading: string; text: string }[] {
  const sections: { heading: string; lines: string[] }[] = [{ heading: '开头', lines: [] }];
  for (const line of template.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = HEADING.exec(line)?.[1];
    if (heading === undefined) { sections.at(-1)!.lines.push(line); continue; }
    const previous = sections.at(-1)!.lines, carried: string[] = [];
    for (let end = previous.length; ;) {
      let at = end - 1;
      while (at >= 0 && !previous[at]!.trim()) at--;
      if (at < 0 || !OPENERS.test(previous[at]!)) { previous.splice(end); break; }
      carried.unshift(previous[at]!);
      end = at;
    }
    sections.push({ heading, lines: [...carried, line] });
  }
  return sections.map(({ heading, lines }) => ({ heading, text: lines.join('\n').trim() }));
}

/** Words in a section beyond its heading and tags: a heading that only groups others is not worth naming. */
const hasWords = (text: string) => text.split('\n').filter(line => !HEADING.test(line)).join('').replace(TAG, '').trim() !== '';

/**
 * Shipped sections that were renamed, with what changed. Her section under the earlier name is that section, so it is
 * never told as missing; it is told as renamed, for her template to follow or not.
 */
const RENAMED: Readonly<Record<string, { from: string; note: string }>> = {
  我: { from: '我是谁', note: '「我是谁」这一段现在叫「我」；里面固定的六段，「生活习惯」现在叫「生活方式」。' },
};

/**
 * Her `world-prompt.md` replaces the shipped one whole, so a shipped section she lacks is one she never reads; one she
 * has under its earlier name is told as renamed.
 */
export function worldPromptGaps(own: string, shipped = readFileSync(DEFAULT_TEMPLATE_FILE, 'utf8')): TemplateGap[] {
  const hers = new Set(sectionsOf(own).map(section => section.heading)), lacking = new Map<string, string[]>();
  // One heading may have a version for her home and one for elsewhere: both are the one section she lacks.
  for (const { heading, text } of sectionsOf(shipped)) {
    if (heading !== '开头' && !hers.has(heading) && hasWords(text)) lacking.set(heading, [...lacking.get(heading) ?? [], text]);
  }
  return [...lacking].map(([heading, texts]) => {
    const renamed = RENAMED[heading];
    return { heading, ...(renamed && hers.has(renamed.from) ? { renamed } : {}), text: balanced(texts.join('\n\n')) };
  });
}

/**
 * Her `alarm.md` replaces the shipped one section by section, and a section she leaves out is the shipped one; what
 * she can miss is what a section of her own does not use, most often a capability added after she wrote it.
 */
export function alarmGaps(own: string, shipped = readFileSync(DEFAULT_ALARM_FILE, 'utf8')): TemplateGap[] {
  const hers = parseSections(own, MESSAGE_KEYS), ours = parseSections(shipped, MESSAGE_KEYS);
  return MESSAGE_KEYS.flatMap(key => {
    const mine = hers.get(key), theirs = ours.get(key);
    if (mine === undefined || theirs === undefined) return [];
    const used = variables(mine), missing = [...variables(theirs)].filter(name => !used.has(name));
    return missing.length ? [{ heading: key, missing, text: `## ${key}\n${theirs}` }] : [];
  });
}

/**
 * What would make a template read wrong: a switch the renderer cannot pair (it would be read to her as written; tried
 * with every switch on and every one off, so one hidden inside another is found too), or a variable that is in neither
 * `known` (the shipped template, her earlier version) nor anything the plugin fills. Empty when it reads as before.
 */
export function templateProblems(text: string, known: Iterable<string>): string[] {
  const problems: string[] = [];
  const switches = [...new Set([...text.matchAll(TAG)].filter(([, kind]) => kind).map(([, , name]) => name!))];
  for (const flags of [{}, Object.fromEntries(switches.map(name => [name, true]))]) {
    const left = renderTemplate(text, flags, {}).match(/\{\{[#^/]\w+\}\}/g);
    if (left) { problems.push(`开关没配对：${[...new Set(left)].join('、')}`); break; }
  }
  const allowed = new Set(known), unknown = [...variables(text)].filter(name => !allowed.has(name));
  if (unknown.length) problems.push(`用了插件不认识的变量：${unknown.map(name => `{{${name}}}`).join('、')}`);
  return problems;
}
/** Every variable a template uses, for `templateProblems` to accept. */
export const templateVariables = (text: string) => [...variables(text)];

export interface SectionChange { heading: string; kind: 'added' | 'changed' | 'removed'; before?: string; after?: string }
/** What changed between two versions of a template, by section; a heading used twice is told apart by its order. */
export function sectionChanges(before: string, after: string): SectionChange[] {
  const keyed = (text: string) => {
    const seen = new Map<string, number>();
    return new Map(sectionsOf(text).map(section => {
      const nth = (seen.get(section.heading) ?? 0) + 1;
      seen.set(section.heading, nth);
      return [`${section.heading}#${nth}`, section] as const;
    }));
  };
  const was = keyed(before), now = keyed(after), changes: SectionChange[] = [];
  for (const [key, section] of now) {
    const old = was.get(key);
    if (!old) changes.push({ heading: section.heading, kind: 'added', after: section.text });
    else if (old.text !== section.text) changes.push({ heading: section.heading, kind: 'changed', before: old.text, after: section.text });
  }
  for (const [key, section] of was) if (!now.has(key)) changes.push({ heading: section.heading, kind: 'removed', before: section.text });
  return changes;
}

/** Her `alarm.md` for the console: whether she has one and where it falls short; one that cannot be read says so instead. */
export function alarmTemplate(file: string | undefined): { custom: boolean; gaps?: TemplateGap[]; error?: string } {
  if (!file || !existsSync(file)) return { custom: false };
  try { return { custom: true, gaps: alarmGaps(readFileSync(file, 'utf8')) }; }
  catch (error) { return { custom: true, error: `读不了 ${file}：${errorText(error)}` }; }
}
