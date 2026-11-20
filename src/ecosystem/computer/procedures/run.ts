// src/ecosystem/computer/procedures/run.ts
import { errorText } from '../../../faults.ts';
import { describeAnchor, type Row } from '../browser/page.ts';
import type { ProcedureLibrary } from './library.ts';
import { holdMs, type DesktopInput } from '../desktop/input.ts';
import type { DesktopResult } from '../desktop/turns.ts';
import { isOpenTooSoon, isWebAddress, procedurePath, substitute, WEB_ONLY, type Anchor, type Condition, type DesktopProcedure, type DesktopStep, type ExtractSpec, type Procedure, type Step, type Target } from './format.ts';

/** What replaying needs from a page; her browser's `Page` is one. */
export interface Driver {
  open(url: string): Promise<void>;
  click(target: Target, holdMs?: number): Promise<void>;
  type(target: Target, text: string): Promise<void>;
  press(key: string): Promise<void>;
  wait(condition: Condition, timeoutMs: number, signal?: AbortSignal): Promise<void>;
  has(condition: Condition): Promise<boolean>;
  extract(spec: ExtractSpec): Promise<Row[]>;
  evaluate(script: string, args: Record<string, unknown>): Promise<unknown>;
  brief(): Promise<string>;
}
/** What replaying a desktop operation needs: her `desktop` hands, each action answered with a fresh picture. */
export interface Hands { act(input: DesktopInput): Promise<DesktopResult> }
export type Args = Record<string, string | number | boolean>;
export type Failure = { ok: false; step: number; action: string; error: string; outwardDone: boolean; page: string };
export type RunResult = { ok: true; rows: Row[]; values: Record<string, unknown> } | Failure;
/** One of the versions she replaced, kept as `<name>.v<n>.json`. */
export interface KeptVersion { procedure: Procedure; version: number }
/** Which version a run ended on: the newest unless it failed before anything went out and a kept one worked. */
export interface VersionedRun { result: RunResult; ran: Procedure; fallback?: { version: number; newest: Failure } }

/** How long a `check` waits for the page a step led to, so a check right after sending sees the page it opened. */
const CHECK_MS = 3000;
/** Kept versions tried after the newest fails, so a long repair history cannot make one call run for minutes. */
export const MAX_FALLBACK = 2;

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
const isEmpty = (value: unknown): boolean => value === null || value === undefined || value === ''
  || (Array.isArray(value) ? value.every(isEmpty) : typeof value === 'object' ? Object.values(value).every(isEmpty) : false);
const EMPTY_HINT = '（页面可能改了；本来就可能为空的，在这一步加 allowEmpty: true）';
/** An extract that finds nothing, or a field blank in every row, is far likelier a changed page than an empty one. */
function emptyRows(spec: ExtractSpec, rows: Row[]): string | undefined {
  if (!rows.length) return `一条都没有提取到${EMPTY_HINT}`;
  const blank = Object.keys(spec.fields).find(name => rows.every(row => isEmpty(row[name])));
  return blank === undefined ? undefined : `提取到 ${rows.length} 条，但字段 ${blank} 每一条都是空的${EMPTY_HINT}`;
}

const held = (hold: number | undefined) => hold === undefined ? '点' : `长按 ${hold} 秒`;
const at = (point: { x?: number; y?: number }) => point.x === undefined ? '' : `（${point.x}, ${point.y}）`;
export function describeStep(step: Step | DesktopStep): string {
  if ('open' in step) return `打开 ${step.open}`;
  if ('click' in step) {
    if ('x' in step.click) return `${held(step.click.hold)}${at(step.click)}`;
    return `${held('hold' in step ? step.hold : undefined)} ${describeAnchor(step.click)}`;
  }
  if ('type' in step) return 'into' in step.type ? `在 ${describeAnchor(step.type.into)} 输入` : `输入${at(step.type)}`;
  if ('drag' in step) return `从${at(step.drag)}拖到${at({ x: step.drag.x2, y: step.drag.y2 })}`;
  if ('press' in step) return `按 ${step.press}`;
  if ('scroll' in step) return `往 ${step.scroll.direction} 滚${at(step.scroll)}`;
  if ('wait' in step) return 'seconds' in step.wait && !('text' in step.wait || 'url' in step.wait || 'anchor' in step.wait) ? `等 ${step.wait.seconds} 秒` : `等 ${describeCondition(step.wait as Condition)}`;
  if ('check' in step) return `确认 ${describeCondition(step.check)}`;
  if ('extract' in step) return `提取 ${describeAnchor(step.extract.list)}`;
  return '页面脚本';
}

/**
 * Replays her steps without the model: the first one that fails stops the run and says where, never retried. Coming up
 * empty is failing too, unless the step allows it, so a broken tool is never read as "nothing new".
 */
export async function runProcedure(procedure: Procedure, args: Args, driver: Driver | Hands, signal?: AbortSignal): Promise<RunResult> {
  if (procedure.where !== undefined) {
    if (!('act' in driver)) throw new Error(`${procedurePath(procedure)} 是伙伴电脑上的操作，要在「她用电脑」里跑`);
    return runDesktop(procedure, args, driver, signal);
  }
  if (!('open' in driver)) throw new Error(`${procedurePath(procedure)} 是网页上的操作，要在我的浏览器里跑`);
  let rows: Row[] = [], outwardDone = false;
  const values: Record<string, unknown> = {};
  for (const [index, step] of procedure.steps.entries()) {
    signal?.throwIfAborted();
    const outward = 'outward' in step && step.outward === true;
    try {
      if ('open' in step) { const url = substitute(step.open, args); if (!isWebAddress(url)) throw new Error(WEB_ONLY); await driver.open(url); }
      else if ('click' in step) await driver.click({ anchor: fill(step.click, args) }, holdMs(step.hold));
      else if ('type' in step) await driver.type({ anchor: fill(step.type.into, args) }, substitute(step.type.text, args));
      else if ('press' in step) await driver.press(step.press);
      else if ('wait' in step) await driver.wait(fillCondition(step.wait, args), (step.wait.seconds ?? 10) * 1000, signal);
      else if ('check' in step) {
        const condition = fillCondition(step.check, args);
        try { await driver.wait(condition, CHECK_MS, signal); }
        catch (error) { if (signal?.aborted) throw error; throw new Error(`等了 ${CHECK_MS / 1000} 秒，页面上还是没有${describeCondition(condition)}`); }
      }
      else if ('extract' in step) {
        rows = await driver.extract(fillExtract(step.extract, args));
        const empty = step.allowEmpty ? undefined : emptyRows(step.extract, rows);
        if (empty) throw new Error(empty);
      }
      else {
        const value = await driver.evaluate(step.script, args);
        if (step.as) { if (!step.allowEmpty && isEmpty(value)) throw new Error(`页面脚本的结果 ${step.as} 是空的${EMPTY_HINT}`); values[step.as] = value; }
      }
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

function desktopInput(step: Exclude<DesktopStep, { wait: unknown }>, args: Args): DesktopInput {
  if ('open' in step) return { action: 'open', app: substitute(step.open, args) };
  if ('click' in step) return { action: 'click', ...step.click };
  if ('drag' in step) return { action: 'drag', ...step.drag };
  if ('type' in step) return { action: 'type', ...step.type, text: substitute(step.type.text, args) };
  if ('press' in step) return { action: 'press', key: step.press, ...(step.hold === undefined ? {} : { hold: step.hold }) };
  return { action: 'scroll', ...step.scroll };
}
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

/**
 * Her desktop steps through her own hands. Each step answers with a picture, which the caller keeps through `driver`,
 * so she sees where it ended; positions are pixels of the picture, so they follow the window's size, not its place.
 */
async function runDesktop(procedure: DesktopProcedure, args: Args, hands: Hands, signal?: AbortSignal): Promise<RunResult> {
  let outwardDone = false;
  // On the whole screen her positions are pixels of a picture of it: one is taken first, so they are measured on this screen.
  if (procedure.where === 'screen') await hands.act({ action: 'shot' });
  for (const [index, step] of procedure.steps.entries()) {
    signal?.throwIfAborted();
    const outward = 'outward' in step && step.outward === true;
    try {
      if ('wait' in step) await sleep(step.wait.seconds * 1000, signal);
      else await hands.act(desktopInput(step, args));
      if (outward) outwardDone = true;
    } catch (error) {
      if (signal?.aborted) throw error;
      const early = isOpenTooSoon(procedure.steps, index) ? '（回放时步与步之间不停，可能是窗口还没出来；在这一步前面加 wait）' : '';
      return { ok: false, step: index + 1, action: describeStep(step), error: errorText(error) + early, outwardDone: outwardDone || outward, page: '（最后一张截图附在下一条消息里）' };
    }
  }
  return { ok: true, rows: [], values: {} };
}

/**
 * Runs her newest version; when it fails before anything went out, her kept versions newest first, since a site may
 * serve its old and new page side by side and a repair for one must not lose the other. The newest's failure is the
 * one reported when none works. A kept version whose parameters no longer fit the call is skipped.
 */
export async function runVersions(newest: Procedure, kept: KeptVersion[], input: Record<string, unknown>, driver: Driver | Hands, signal?: AbortSignal): Promise<VersionedRun> {
  const result = await runProcedure(newest, checkArgs(newest, input), driver, signal);
  if (result.ok || result.outwardDone) return { result, ran: newest };
  for (const { procedure, version } of kept.slice(0, MAX_FALLBACK)) {
    let args: Args;
    try { args = checkArgs(procedure, input); } catch { continue; }
    const older = await runProcedure(procedure, args, driver, signal);
    if (older.ok) return { result: older, ran: procedure, fallback: { version, newest: result } };
    if (older.outwardDone) break; // something may have gone out: no other version gets a turn
  }
  return { result, ran: newest };
}

/** Told after a result that came from a kept version, so she knows her newest one is broken. */
export const fallbackText = ({ version, newest }: NonNullable<VersionedRun['fallback']>) =>
  `最新版第 ${newest.step} 步（${newest.action}）没跑通：${cut(newest.error, 80)}；这次退回第 ${version} 版跑通了。`;

/** Said at the moment it breaks, when the task is still in front of her: doing it by hand is how the new version gets made. */
export const REPAIR_NOW = '现在就修：先用 page_* 或 desktop 把这件事做完，再把走通的步骤用原来的名字 procedure_save 成新版（不另起一个新的），存完跑一次确认。';

export function failureText(path: string, result: Failure): string {
  return `${path} 没跑通：第 ${result.step} 步（${result.action}）${result.error}。`
    + (result.outwardDone ? `这一步或之前有向外的动作，可能已经发出，先看页面确认，不要直接重跑；确认之后再把它修好存成新版。` : `还没有任何向外的动作。${REPAIR_NOW}`)
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
  if (!result.ok) return `${procedurePath(procedure)} 没跑通（第 ${result.step} 步：${cut(result.error, 60)}）`;
  const values = { ...Object.fromEntries(Object.entries(result.values).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)])), count: String(result.rows.length) };
  const body = procedure.summary ? substitute(procedure.summary, values) : resultText(result);
  return `${procedurePath(procedure)}：${cut(body, 200)}`;
}

/** The one place a run, or the error that cut it off, becomes the note the catalog and the console show. */
export function noteRun(library: Pick<ProcedureLibrary, 'note'>, path: string, outcome: VersionedRun | { thrown: unknown }): void {
  if ('thrown' in outcome) return library.note(path, false, cut(errorText(outcome.thrown), 200));
  const { result, fallback } = outcome;
  if (result.ok) library.note(path, true, fallback && cut(fallbackText(fallback), 200));
  else library.note(path, false, cut(`第 ${result.step} 步：${result.error}`, 200));
}
