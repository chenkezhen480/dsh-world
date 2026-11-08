// src/ecosystem/computer/procedures/run.ts
import { errorText } from '../../../faults.ts';
import { describeAnchor, type Row } from '../browser/page.ts';
import type { ProcedureLibrary } from './library.ts';
import { isWebAddress, substitute, WEB_ONLY, type Anchor, type Condition, type ExtractSpec, type Procedure, type Step, type Target } from './format.ts';

/** What replaying needs from a page; her browser's `Page` is one. */
export interface Driver {
  open(url: string): Promise<void>;
  click(target: Target): Promise<void>;
  type(target: Target, text: string): Promise<void>;
  press(key: string): Promise<void>;
  wait(condition: Condition, timeoutMs: number, signal?: AbortSignal): Promise<void>;
  has(condition: Condition): Promise<boolean>;
  extract(spec: ExtractSpec): Promise<Row[]>;
  evaluate(script: string, args: Record<string, unknown>): Promise<unknown>;
  brief(): Promise<string>;
}
export type Args = Record<string, string | number | boolean>;
export type RunResult =
  | { ok: true; rows: Row[]; values: Record<string, unknown> }
  | { ok: false; step: number; action: string; error: string; outwardDone: boolean; page: string };

export function checkArgs(procedure: Procedure, input: Record<string, unknown>): Args {
  const out: Args = {};
  for (const key of Object.keys(input)) if (!(key in procedure.params)) throw new Error(`不认识的参数 ${key}`);
  for (const [name, param] of Object.entries(procedure.params)) {
    const value = input[name];
    if (value === undefined) { if (param.required) throw new Error(`缺少参数 ${name}`); continue; }
    if (typeof value !== param.type) throw new Error(`参数 ${name} 应该是 ${param.type}`);
    out[name] = value as string | number | boolean;
  }
  return out;
}

const fill = (anchor: Anchor, args: Args): Anchor => Object.fromEntries(Object.entries(anchor).map(([key, value]) => [key, typeof value === 'string' ? substitute(value, args) : value])) as Anchor;
const fillExtract = (spec: ExtractSpec, args: Args): ExtractSpec => ({
  ...spec, list: fill(spec.list, args),
  fields: Object.fromEntries(Object.entries(spec.fields).map(([name, field]) => [name, fill(field, args) as ExtractSpec['fields'][string]])),
});
const fillCondition = (condition: Condition, args: Args): Condition => ({
  ...(condition.text === undefined ? {} : { text: substitute(condition.text, args) }),
  ...(condition.url === undefined ? {} : { url: substitute(condition.url, args) }),
  ...(condition.anchor === undefined ? {} : { anchor: fill(condition.anchor, args) }),
});
const describeCondition = (condition: Condition) => [condition.text && `文字「${condition.text}」`, condition.url && `地址含 ${condition.url}`, condition.anchor && describeAnchor(condition.anchor)].filter(Boolean).join('、');
export function describeStep(step: Step): string {
  if ('open' in step) return `打开 ${step.open}`;
  if ('click' in step) return `点 ${describeAnchor(step.click)}`;
  if ('type' in step) return `在 ${describeAnchor(step.type.into)} 输入`;
  if ('press' in step) return `按 ${step.press}`;
  if ('wait' in step) return `等 ${describeCondition(step.wait)}`;
  if ('check' in step) return `确认 ${describeCondition(step.check)}`;
  if ('extract' in step) return `提取 ${describeAnchor(step.extract.list)}`;
  return '页面脚本';
}

/** Replays her steps without the model: the first one that fails stops the run and says where, never retried. */
export async function runProcedure(procedure: Procedure, args: Args, driver: Driver, signal?: AbortSignal): Promise<RunResult> {
  let rows: Row[] = [], outwardDone = false;
  const values: Record<string, unknown> = {};
  for (const [index, step] of procedure.steps.entries()) {
    signal?.throwIfAborted();
    const outward = 'outward' in step && step.outward === true;
    try {
      if ('open' in step) { const url = substitute(step.open, args); if (!isWebAddress(url)) throw new Error(WEB_ONLY); await driver.open(url); }
      else if ('click' in step) await driver.click({ anchor: fill(step.click, args) });
      else if ('type' in step) await driver.type({ anchor: fill(step.type.into, args) }, substitute(step.type.text, args));
      else if ('press' in step) await driver.press(step.press);
      else if ('wait' in step) await driver.wait(fillCondition(step.wait, args), (step.wait.seconds ?? 10) * 1000, signal);
      else if ('check' in step) { const condition = fillCondition(step.check, args); if (!await driver.has(condition)) throw new Error(`页面上没有${describeCondition(condition)}`); }
      else if ('extract' in step) rows = await driver.extract(fillExtract(step.extract, args));
      else { const value = await driver.evaluate(step.script, args); if (step.as) values[step.as] = value; }
      if (outward) outwardDone = true;
    } catch (error) {
      if (signal?.aborted) throw error;
      const page = await driver.brief().catch(() => '（读不到当前页面）');
      // A failed outward step may still have gone out: it counts as done.
      return { ok: false, step: index + 1, action: describeStep(step), error: errorText(error), outwardDone: outwardDone || outward, page };
    }
  }
  return { ok: true, rows, values };
}

export function failureText(name: string, result: Extract<RunResult, { ok: false }>): string {
  return `my_${name} 没跑通：第 ${result.step} 步（${result.action}）${result.error}。`
    + (result.outwardDone ? '这一步或之前有向外的动作，可能已经发出，先看页面确认，不要直接重跑。' : '还没有任何向外的动作，修好可以再跑。')
    + `\n当前页面：\n${result.page}`;
}

/** Cuts by characters, not UTF-16 units, so an emoji is never split. */
export const cut = (text: string, max: number) => { const chars = [...text]; return chars.length > max ? chars.slice(0, max).join('') + '…（截断）' : text; };

/** What her tool hands back: the rows of its last extract and the values its scripts kept, cut to 2000 characters. */
export function resultText(result: Extract<RunResult, { ok: true }>): string {
  const out = { ...(result.rows.length ? { rows: result.rows } : {}), ...(Object.keys(result.values).length ? { values: result.values } : {}) };
  const text = Object.keys(out).length ? JSON.stringify(out) : '完成。';
  return cut(text, 2000);
}

/** One line after her alarm: the tool's own summary, or its result; a failure is said as a failure, never as nothing. */
export function summaryLine(procedure: Procedure, result: RunResult): string {
  if (!result.ok) return `my_${procedure.name} 没跑通（第 ${result.step} 步：${cut(result.error, 60)}）`;
  const values = { ...Object.fromEntries(Object.entries(result.values).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)])), count: String(result.rows.length) };
  const body = procedure.summary ? substitute(procedure.summary, values) : resultText(result);
  return `my_${procedure.name}：${cut(body, 200)}`;
}

/** The one place a run, or the error that cut it off, becomes the note `procedure_list` shows. */
export function noteRun(library: Pick<ProcedureLibrary, 'note'>, name: string, outcome: RunResult | { thrown: unknown }): void {
  if ('thrown' in outcome) library.note(name, false, cut(errorText(outcome.thrown), 200));
  else library.note(name, outcome.ok, outcome.ok ? undefined : cut(`第 ${outcome.step} 步：${outcome.error}`, 200));
}
