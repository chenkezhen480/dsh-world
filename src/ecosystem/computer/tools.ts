// src/ecosystem/computer/tools.ts
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { errorText } from '../../faults.ts';
import { PAGE_KEYS, type Page, type Row } from './browser/page.ts';
import type { Browser } from './browser/browser.ts';
import type { ComputerRecorder } from './procedures/archive.ts';
import type { ProcedureLibrary } from './procedures/library.ts';
import { checkArgs, cut, failureText, noteRun, resultText, runProcedure, type Args } from './procedures/run.ts';
import { isWebAddress, WEB_ONLY, type MessageMap, type Procedure } from './procedures/format.ts';

const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };

const FORMAT_NOTE = '格式不对时保存会被拒绝并说明哪里不对。文件是 JSON：name（小写字母开头，只用小写字母、数字、下划线）、description、params（{名字:{type,required?}}）、steps。步骤各取一种：open｜click｜type {into,text}｜press｜wait {text|anchor|url,seconds?}｜check｜extract {list,fields,limit?}｜script（可 return，as 存成值）。锚点 {role?,name?,text?,css?,nth?（从 0 数）}，role、name 用 page_read 里看到的；extract 的字段可以只写 attr，读列表项自己。文字里的 {{参数}} 会代入。会向外发出的步骤标 outward:true。onAlarm:true 表示闹钟前自动跑（不能有必填参数和 outward 步骤）；summary 可用 {{as 名}} 和 {{count}}。messages 把 extract 的字段写进归档：channel、conversationType 写死，其余是 {{字段}} 模板，outgoing 算出 true 表示是我自己说的。';

/** Her page tools, her save and list, and one `my_<name>` tool per saved file; home only (see `toolRegistry`). */
export function computerTools(deps: { agent: Agent; browser: Pick<Browser, 'run'>; library: ProcedureLibrary; recorder: Pick<ComputerRecorder, 'record'>; attachments(): AttachmentStore | undefined }): ToolDefinition[] {
  const run = <T>(work: (page: Page, signal: AbortSignal) => Promise<T>) => deps.browser.run(work);
  // Checked before anything is queued, so a bad argument never launches or waits on the browser.
  const whole = (value: unknown, message: string) => { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(message); return value as number; };
  const REF = 'ref 是 page_read 里方括号中的编号';
  const ref = (value: unknown) => ({ ref: whole(value, REF) });
  const where = (page: Page) => page.brief().then(text => text.split('\n')[0]);
  const page: ToolDefinition[] = [
    defineTool({ name: 'page_open', description: '在我自己的浏览器里打开一个地址（浏览器没开会先打开它，窗口在桌面上，不用伙伴的鼠标键盘），返回页面上的元素和文字，同 page_read。登录要扫码时在那个窗口里扫。', parameters: { url: { type: 'string', required: true } }, output,
      execute: async ({ url }) => { if (!isWebAddress(url)) throw new Error(WEB_ONLY); return run(async p => { await p.open(url); return p.read(); }); } }),
    defineTool({ name: 'page_read', description: '读当前页面：每个可操作元素一行，[编号] 角色 名称；编号在页面不跳转时一直有效。page 翻看更多元素，ref 只看某个元素里面。之后附可见文字（截断）。', parameters: { page: { type: 'integer' }, ref: { type: 'integer' } }, output,
      execute: async ({ page: index, ref: scope }) => {
        const options = { ...(index === undefined ? {} : { page: whole(index, 'page 应该是 1 以上的整数') }), ...(scope === undefined ? {} : ref(scope)) };
        return run(p => p.read(options));
      } }),
    defineTool({ name: 'page_click', description: '点 page_read 给出的编号。', parameters: { ref: { type: 'integer', required: true } }, output,
      execute: async args => { const target = ref(args.ref); return run(async p => { await p.click(target); return `已点击 [${args.ref}]，现在：${await where(p)}`; }); } }),
    defineTool({ name: 'page_type', description: '在编号对应的输入框里输入文字（整段输入，中文也行），框里原有的内容会被替换；submit 为 true 时再按回车。', parameters: { ref: { type: 'integer', required: true }, text: { type: 'string', required: true }, submit: { type: 'boolean' } }, output,
      execute: async args => { const target = ref(args.ref); return run(async p => { await p.type(target, args.text); if (args.submit) await p.press('Enter'); return `已输入，现在：${await where(p)}`; }); } }),
    defineTool({ name: 'page_press', description: `按一个键：${PAGE_KEYS.join('、')}。`, parameters: { key: { type: 'string', required: true } }, output,
      execute: async ({ key }) => run(async p => { await p.press(key); return `已按 ${key}，现在：${await where(p)}`; }) }),
    defineTool({ name: 'page_scroll', description: '滚动一屏左右：direction 为 up 或 down；给 ref 就在那个元素上滚。', parameters: { direction: { type: 'string', required: true }, ref: { type: 'integer' } }, output,
      execute: async args => {
        if (args.direction !== 'up' && args.direction !== 'down') throw new Error('direction 只能是 up 或 down');
        const target = args.ref === undefined ? undefined : ref(args.ref);
        return run(async p => { await p.scroll(args.direction as 'up' | 'down', target); return '已滚动。'; });
      } }),
    defineTool({ name: 'page_wait', description: '等某段文字出现（text，最多等 seconds 秒，默认 10）；或检查某个编号的元素还在（ref，立即返回）。seconds 最多 60。', parameters: { text: { type: 'string' }, ref: { type: 'integer' }, seconds: { type: 'number' } }, output,
      execute: async ({ text, ref: id, seconds = 10 }) => {
        if (text === undefined && id === undefined) throw new Error('要给 text 或 ref');
        if (text !== undefined && !text.trim()) throw new Error('text 不能是空的');
        const target = id === undefined ? undefined : whole(id, REF);
        if (typeof seconds !== 'number' || seconds <= 0 || seconds > 60) throw new Error('seconds 应该在 0 到 60 之间');
        return run(async (p, signal) => {
          if (target !== undefined) { await p.read({ ref: target }); return `[${target}] 还在。`; }
          await p.wait({ text: text! }, seconds * 1000, signal); return `等到了「${text}」。`;
        });
      } }),
    defineTool({ name: 'page_shot', description: '截当前页面一张图附在下一条消息里；只在读文字看不明白时用，图片很占地方。', parameters: {}, output,
      execute: async (_args, context) => {
        const attachments = deps.attachments();
        if (!attachments) throw new Error('宿主图片存储不可用');
        const data = await run(p => p.shot());
        const [attachment] = await attachments.saveImages([{ data, mediaType: 'image/png', name: '我的浏览器.png' }]);
        if (!attachment) throw new Error('截图没能存下来');
        context.signal.throwIfAborted();
        context.deferContext(createUserMessage({ source: { kind: 'dsh-world-channel-context', form: 'recall' }, content: [{ type: 'text', text: '这是我浏览器当前页面的截图。' }, { type: 'image', attachment }] }));
        return '截图附在下一条消息里。';
      } }),
    defineTool({ name: 'page_eval', description: '在当前页面里执行一段 JS（可 return 一个能转成 JSON 的值），只在我的浏览器页面里，碰不到电脑上的文件。十秒超时，结果截到 2000 字。', parameters: { script: { type: 'string', required: true } }, output,
      execute: async ({ script }) => run(async p => cut(JSON.stringify(await p.evaluate(script, {})) ?? 'null', 2000)) }),
  ];
  const procedures: ToolDefinition[] = [
    defineTool({ name: 'procedure_save', description: `把用 page_* 走通的步骤存成我自己的工具 my_<name>，以后直接调用、不必再一步步摸；同名会覆盖并留下旧版本。文件在 ${deps.library.dir}，也可以直接改。${FORMAT_NOTE}`, parameters: { json: { type: 'string', required: true } }, output,
      execute: async ({ json }) => {
        try { const { procedure, version } = deps.library.save(json); return `已保存 my_${procedure.name}（第 ${version} 版），下一步起就能用。`; }
        catch (error) { throw new Error(`没有保存：${errorText(error)}`); }
      } }),
    defineTool({ name: 'procedure_list', description: '列出我自己的工具和它们最近一次跑的结果。', parameters: {}, output,
      execute: async () => {
        const list = deps.library.list();
        if (!list.length) return `还没有自己的工具。文件会放在 ${deps.library.dir}。`;
        return list.map(({ procedure }) => {
          const last = deps.library.lastRun(procedure.name);
          return `my_${procedure.name} — ${procedure.description}${procedure.onAlarm ? '（闹钟前自动跑）' : ''}（最近：${!last ? '还没跑过' : last.ok ? `成功 ${last.at}` : `失败 ${last.at}：${last.detail ?? ''}`}）`;
        }).join('\n');
      } }),
  ];
  return [...page, ...procedures, ...deps.library.list().map(({ procedure }) => ownTool(procedure))];

  /** Filing what she read must never cost her the read itself, so a failure is a line after the result. */
  async function archiveNote(map: MessageMap, rows: Row[], args: Args): Promise<string> {
    try {
      const archived = await deps.recorder.record(deps.agent, map, rows, args);
      return archived.outOfScope ? '\n（这个会话不在归档范围里，没有记）' : `\n新记进归档 ${archived.written} 条${archived.skipped ? `，跳过 ${archived.skipped} 条缺字段的` : ''}。`;
    } catch (error) { return `\n（没能记进归档：${errorText(error)}）`; }
  }

  function ownTool(procedure: Procedure): ToolDefinition {
    const parameters = Object.fromEntries(Object.entries(procedure.params).map(([name, param]) => [name, { type: param.type, ...(param.required ? { required: true } : {}), ...(param.description ? { description: param.description } : {}) }]));
    return defineTool({ name: `my_${procedure.name}`, description: `${procedure.description}（我自己的工具；坏了就用 page_* 走通后 procedure_save 覆盖）`, parameters, output,
      execute: async (input: Record<string, unknown>, context: ToolRunContext) => {
        const args = checkArgs(procedure, input);
        let result;
        try { result = await run((p, signal) => runProcedure(procedure, args, p, AbortSignal.any([signal, context.signal]))); }
        catch (error) { noteRun(deps.library, procedure.name, { thrown: error }); throw error; }
        noteRun(deps.library, procedure.name, result);
        if (!result.ok) return failureText(procedure.name, result);
        return resultText(result) + (procedure.messages && result.rows.length ? await archiveNote(procedure.messages, result.rows, args) : '');
      } } as never);
  }
}
