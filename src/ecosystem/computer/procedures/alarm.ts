// src/ecosystem/computer/procedures/alarm.ts
import { errorText } from '../../../faults.ts';
import type { Browser } from '../browser/browser.ts';
import type { ProcedureLibrary } from './library.ts';
import { cut, noteRun, runProcedure, summaryLine } from './run.ts';

/**
 * Before her alarm rings, every tool she marked `onAlarm` runs once in a tab of its own, and each leaves one line to
 * follow the alarm text. Nothing is archived here: these runs belong to no session, and only what she reads herself
 * goes into her archive.
 */
export function createAlarmFacts(deps: { library: ProcedureLibrary; browser: Pick<Browser, 'scratch'>; perToolMs?: number; totalMs?: number }) {
  const perToolMs = deps.perToolMs ?? 20_000, totalMs = deps.totalMs ?? 60_000;
  return async function facts(): Promise<string | undefined> {
    const due = deps.library.list().filter(({ procedure }) => procedure.onAlarm);
    if (!due.length) return undefined;
    const deadline = Date.now() + totalMs, lines: string[] = [];
    for (const { procedure } of due) {
      const left = Math.min(perToolMs, deadline - Date.now());
      if (left <= 0) { lines.push(`my_${procedure.name} 没来得及跑（闹钟前的时间用完了）`); continue; }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(`超过 ${Math.max(1, Math.ceil(left / 1000))} 秒`)); }, left); });
      try {
        const result = await Promise.race([deps.browser.scratch((page, signal) => runProcedure(procedure, {}, page, AbortSignal.any([signal, controller.signal])), controller.signal), late]);
        noteRun(deps.library, procedure.name, result);
        lines.push(summaryLine(procedure, result));
      } catch (error) {
        noteRun(deps.library, procedure.name, { thrown: error });
        lines.push(`my_${procedure.name} 没跑通（${cut(errorText(error), 80)}）`);
      } finally { clearTimeout(timer); }
    }
    return lines.join('\n');
  };
}
