import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { abortable } from '../abortable.ts';
import { errorText } from '../faults.ts';
import { askTurn } from '../ecosystem/shared/turn.ts';
import { DEFAULT_ALARM_FILE, parseSections } from '../life/messages.ts';
import { alarmGaps, sectionChanges, templateProblems, templateVariables, worldPromptGaps, type SectionChange, type TemplateGap } from '../templateGaps.ts';
import { DEFAULT_TEMPLATE_FILE, renderTemplate } from '../worldPrompt.ts';
import { admit, type InWorld } from '../worldScope.ts';

/** The request she gets, the same path from `src/` and the built `lib/`: `partner`, `files` and `items` are filled in. */
export const PROMPT_MERGE_FILE = fileURLToPath(new URL('../../templates/prompt-merge.md', import.meta.url));

export interface PromptMergeState {
  status: 'idle' | 'waiting' | 'merging' | 'done' | 'failed' | 'cancelled';
  message?: string;
  /** What she changed in each file, to look over until the next request or an undo. */
  changes?: { file: string; sections: SectionChange[] }[];
  /** The copies taken before she began can still be put back. */
  undoable?: boolean;
}
/** One of her templates as the merge sees it: where it is, the shipped one it is compared with, how it falls short. */
interface Template { kind: 'world' | 'alarm'; file: string; shipped: string; gaps(own: string): TemplateGap[]; problems(text: string, known: string[]): string[] }

/** alarm.md is sent section by section, so each section has to pair its own switches. */
const alarmProblems = (text: string, known: string[]) => [...parseSections(text)].flatMap(([heading, body]) => templateProblems(body, known).map(problem => `「${heading}」${problem}`));
const quoted = (gap: TemplateGap) => `\`\`\`\n${gap.text}\n\`\`\``;
/** One thing to merge, as she reads it: which file and section, what is missing or renamed, and the shipped words. */
function itemText(kind: Template['kind'], gap: TemplateGap): string {
  if (kind === 'alarm') return `【alarm.md ·「${gap.heading}」】自带的这一段用到了 ${gap.missing!.map(name => `{{${name}}}`).join('、')}，我们的没有：\n${quoted(gap)}`;
  return gap.renamed
    ? `【世界提示词 ·「${gap.renamed.from}」→「${gap.heading}」】改了名：${gap.renamed.note}自带的这一段现在是：\n${quoted(gap)}`
    : `【世界提示词 ·「${gap.heading}」】自带的有这一段，我们的没有：\n${quoted(gap)}`;
}

/**
 * The partner's request to have her merge the shipped prompts into their own templates: the files are copied, she is
 * asked in her home, and once her turn ends each template must still read as a template, or the copies go back.
 * Her 「我」 is copied too: a rename reaches the headings she wrote in it, and what she changes there is listed and
 * undone with the rest. Nothing is merged without a request, and she writes it herself; the plugin only checks and
 * keeps the way back.
 */
export function createPromptMerge(deps: {
  ctx: Context;
  worldPromptFile: string;
  alarmFile?: string | undefined;
  /** Her 「我」 as this world reads it (`我.md`, or the `我是谁.md` an older world keeps). */
  selfFile?: string | undefined;
  /** Where the copies go, one folder per request. */
  historyDir: string;
  home(): Promise<Agent>;
  inWorld: InWorld;
  /** What she calls the partner, for the request in `templates/prompt-merge.md`. */
  partner(): string;
  /** Compacts her home once she has changed something, so her next turn reads it. */
  apply(): void;
  changed(): void;
  /** The console health entry for a failed merge; undefined clears it. */
  fault(message: string | undefined): void;
  clock?: () => Date;
}) {
  const clock = deps.clock ?? (() => new Date());
  let state: PromptMergeState = { status: 'idle' };
  /** Each copied file and its text before she began. */
  let saved: Map<string, string> | undefined, controller: AbortController | undefined, pending: Promise<void> | undefined;
  const stopped = new Error('世界已停止');
  function update(next: PromptMergeState): void {
    state = next; deps.changed();
    if (next.status === 'failed') { deps.ctx.logger.warn(`dsh-world: ${next.message ?? ''}`); deps.fault(next.message); }
    else if (next.status === 'done' || next.status === 'idle') deps.fault(undefined);
  }
  /** Only templates of her own: with none, there is nothing of hers to merge into. */
  function templates(): Template[] {
    const world: Template = { kind: 'world', file: deps.worldPromptFile, shipped: readFileSync(DEFAULT_TEMPLATE_FILE, 'utf8'), gaps: worldPromptGaps, problems: templateProblems };
    const alarm: Template[] = deps.alarmFile ? [{ kind: 'alarm', file: deps.alarmFile, shipped: readFileSync(DEFAULT_ALARM_FILE, 'utf8'), gaps: alarmGaps, problems: alarmProblems }] : [];
    return [world, ...alarm].filter(template => existsSync(template.file));
  }
  function restore(): void {
    for (const [file, text] of saved ?? []) writeFileSync(file, text);
  }
  /** Whether each template still reads as one, and what she changed in every copied file. */
  function check(list: Template[]): { problems: string[]; changes: NonNullable<PromptMergeState['changes']> } {
    const problems: string[] = [], changes: NonNullable<PromptMergeState['changes']> = [];
    const now = new Map<string, string>();
    for (const file of saved!.keys()) {
      try { now.set(file, readFileSync(file, 'utf8')); }
      catch (error) { problems.push(`${basename(file)} 读不了：${errorText(error)}`); }
    }
    for (const template of list) {
      const after = now.get(template.file);
      if (after === undefined) continue;
      const found = template.problems(after, [...templateVariables(template.shipped), ...templateVariables(saved!.get(template.file)!)]);
      problems.push(...found.map(problem => `${basename(template.file)}：${problem}`));
    }
    for (const [file, after] of now) {
      const sections = sectionChanges(saved!.get(file)!, after);
      if (sections.length) changes.push({ file, sections });
    }
    return { problems, changes };
  }
  async function run(list: Template[], items: string, signal: AbortSignal): Promise<void> {
    const agent = admit(deps.inWorld, await abortable(deps.home(), signal));
    const text = renderTemplate(readFileSync(PROMPT_MERGE_FILE, 'utf8'), {}, { partner: deps.partner(), files: list.map(template => template.file).join(' 和 '), items });
    const words = createUserMessage({ source: { kind: 'dsh-world-prompt-merge' }, content: [{ type: 'text', text }] });
    const cancelled = new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    cancelled.catch(() => {});
    update({ status: 'merging', undoable: true });
    await askTurn(deps.ctx, agent, words, { name: '融合提示词', cancelled, inWorld: deps.inWorld });
    const { problems, changes } = check(list);
    if (problems.length) {
      restore();
      update({ status: 'failed', message: `她融完的模板读不通，已换回融合之前的样子：${problems.join('；')}` });
      return;
    }
    if (!changes.length) { update({ status: 'done', message: '她这一轮什么都没改。', undoable: false }); return; }
    update({ status: 'done', message: `她改了 ${changes.reduce((sum, file) => sum + file.sections.length, 0)} 处，正在压缩家会话，她下一轮就读到。`, changes, undoable: true });
    deps.apply();
  }
  return {
    snapshot: () => state,
    /**
     * Sends the chosen gaps to her, each named `world:<标题>` or `alarm:<标题>` as the console lists them; a refusal is
     * returned, a failure arrives later as the `failed` state.
     */
    request(ids: readonly string[]): string | undefined {
      if (pending) return '上一次融合还没做完';
      let list: Template[], chosen: string[];
      try {
        list = templates();
        chosen = list.flatMap(template => template.gaps(readFileSync(template.file, 'utf8')).filter(gap => ids.includes(`${template.kind}:${gap.heading}`)).map(gap => itemText(template.kind, gap)));
      } catch (error) { return `模板读不了：${errorText(error)}`; }
      if (!chosen.length) return '没有勾选要融的段，或者模板已经和自带的没有差距';
      // The copies first: whatever happens next, the way back is on disk before she is asked.
      const folder = join(deps.historyDir, clock().toISOString().replace(/[:.]/g, '-'));
      mkdirSync(folder, { recursive: true });
      const self = deps.selfFile && existsSync(deps.selfFile) ? [deps.selfFile] : [];
      saved = new Map([...list.map(template => template.file), ...self].map(file => {
        copyFileSync(file, join(folder, basename(file)));
        return [file, readFileSync(file, 'utf8')] as const;
      }));
      controller = new AbortController();
      const { signal } = controller;
      update({ status: 'waiting', undoable: true });
      pending = run(list, chosen.join('\n\n'), signal).catch(error => {
        update({ ...state, status: signal.reason === stopped ? 'cancelled' : 'failed', message: signal.reason === stopped ? '世界停了，这次融合没做完；她已经改了的留着，可以撤销。' : `融合没做成：${errorText(signal.aborted ? signal.reason : error)}` });
      }).finally(() => { controller = undefined; pending = undefined; });
      return undefined;
    },
    /** Puts back the copies taken before her last merge; what was changed since is lost with it. */
    undo(): string | undefined {
      if (pending) return '融合还没做完，等她这一轮结束再撤销';
      if (!state.undoable || !saved) return '没有可以撤销的融合';
      restore();
      saved = undefined;
      update({ status: 'idle', message: '已撤销，模板和她的「我」换回了融合之前的样子。点「应用并压缩家会话」后她就读到。' });
      return undefined;
    },
    async cancel(): Promise<void> { controller?.abort(stopped); await pending; },
  };
}
export type PromptMerge = ReturnType<typeof createPromptMerge>;
