// src/ecosystem/computer/tools.ts
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { AttachmentStore, ImageMediaType } from '@deepseek-ai/dsh-attachment';
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { errorText } from '../../faults.ts';
import { imagesMessage, keepImages, shownImage } from '../../images.ts';
import { PAGE_KEYS, type Page, type Row } from './browser/page.ts';
import type { Browser } from './browser/browser.ts';
import type { ComputerRecorder } from './procedures/archive.ts';
import type { ProcedureLibrary } from './procedures/library.ts';
import { catalogText } from './procedures/catalog.ts';
import { checkArgs, cut, failureText, fallbackText, noteRun, resultText, runVersions, type Args } from './procedures/run.ts';
import { desktopAdvice, isWebAddress, WEB_ONLY, type Computer, type MessageMap } from './procedures/format.ts';
import type { Desktop, DesktopResult } from './desktop/desktop.ts';
import { DESKTOP_KEYS, holdMs, MAX_HOLD_SECONDS, pressed, type DesktopInput } from './desktop/input.ts';

const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };
/** What a picture of the partner's computer shows: one window in the background, the whole screen in front. */
const pictured = (screen: boolean) => screen ? '伙伴电脑整个屏幕' : '伙伴电脑上当前窗口';

const DESKTOP_NOTE = `用伙伴的电脑（后台模式）：看当前窗口的截图，按图上的像素操作；输入直接投给那个窗口，不动伙伴的鼠标、不抢焦点，伙伴用着电脑我也能用。学会的操作先用 computer_use 找。以管理员权限运行的程序（很多游戏）后台够不着，要用就请伙伴切到前台模式。action 取一种：open（app 写程序名，打开它当作当前窗口，托盘里的会点开；不写就列出开着的窗口）｜shot（再截一张）｜click（x、y 是截图上的像素；double 双击，right 右键，hold 按住几秒是长按）｜drag（从 x、y 按住拖到 x2、y2 松开；hold 先按住几秒再拖，right 用右键）｜type（text；给 x、y 就先点那里；submit 再回车）｜press（key：${DESKTOP_KEYS}；hold 按住几秒）｜scroll（direction 为 up/down/left/right，可加 x、y）｜zoom（截图上 x、y 到 x2、y2 放大看）｜record（看视频这类会动的：先让它播起来，录 seconds 秒，最多 600；every 每几秒一帧，默认 1；pause 为 false 时录完不暂停）｜stop（停下正在录的）｜review（看录好的：不带参数看全片，from、to 细看一段，at 看某一秒）。每步之后都有新截图，自己看做对了没有；没反应就换个办法，别重复同一下。`;
/** Foreground mode: the same actions over the whole screen with the real mouse and keyboard. */
const SCREEN_NOTE = `用伙伴的电脑（前台模式）：伙伴把电脑交给了我。看整个屏幕的截图，用真的鼠标键盘按图上的像素操作，游戏和管理员程序也能用；伙伴的鼠标会跟着动。伙伴连按两下 Esc 或点屏幕顶上的「停下」，我就停。action 和后台模式一样：open（把程序放到最前面，没开的会启动；不写 app 就列出窗口）｜shot｜click（x、y，double、right，hold 长按几秒）｜drag（x、y 拖到 x2、y2；hold 先按住几秒，right）｜type（text，可先给 x、y，submit）｜press（key：${DESKTOP_KEYS}；hold 按住几秒，比如游戏里按住 w 走路）｜scroll（direction，可加 x、y）｜zoom（x、y 到 x2、y2）｜record（seconds、every、pause）｜stop｜review（from、to 或 at）。走通的步骤可以 procedure_save 存成 where:"screen" 的操作，以后在前台模式下用 procedure_run 回放。`;

const FORMAT_NOTE = `格式不对时保存会被拒绝并说明哪里不对。文件是 JSON：name（操作名，中文也行，不含 / 和 .）、category（分类，比如 wechat、bilibili）、description、params（{名字:{type,required?}}）、steps。步骤各取一种：open｜click（可加 hold：按住的秒数，长按，最多 ${MAX_HOLD_SECONDS} 秒）｜type {into,text}｜press｜wait {text|anchor|url,seconds?}｜check｜extract {list,fields,limit?}｜script（可 return，as 存成值）。锚点 {role?,name?,text?,css?,nth?（从 0 数）}，role、name 用 page_read 里看到的；extract 的字段可以只写 attr，读列表项自己。文字里的 {{参数}} 会代入。会向外发出的步骤标 outward:true。extract 一条都没有、某个字段每条都空、带 as 的 script 结果为空，都算没跑通；本来就可能为空的（比如没有未读）在那一步加 allowEmpty:true。check 最多等 3 秒。没跑通而且还没有向外的动作时，会依次试最近 2 个旧版本。onAlarm:true 表示闹钟前自动跑（不能有必填参数和 outward 步骤）；summary 可用 {{as 名}} 和 {{count}}。messages 把 extract 的字段写进归档：channel、conversationType 写死，其余是 {{字段}} 模板，outgoing 算出 true 表示是你自己说的。\n伙伴电脑上用 desktop 走通的：后台模式写 where:"desktop"，前台模式写 where:"screen"（只能在前台模式下跑）。步骤各取一种：open（程序名或窗口标题，比如「微信」「朋友圈」）｜click {x,y,double?,right?,hold?}｜drag {x,y,x2,y2,right?,hold?}｜type {text,x?,y?}｜press（同 desktop 的按键，可加 hold）｜scroll {direction,x?,y?}｜wait {seconds}。x、y 是 desktop 截图上的像素（desktop 是窗口的截图，screen 是整个屏幕的截图），大小变了会按比例跟着变。回放时步与步之间不停，手动做时等过的地方（点完才弹出的窗口）要写 wait。不能用 onAlarm、summary、messages。跑完会给最后一张截图，自己看做成了没有。`;

/**
 * Her page tools and her catalog: what she learns is found with `computer_use` and run with `procedure_run`, so the tool
 * list stays the same however much she learns. Home only (see `toolRegistry`).
 */
export function computerTools(deps: { agent: Agent; browser: Pick<Browser, 'run'>; library: ProcedureLibrary; recorder: Pick<ComputerRecorder, 'record'>; attachments(): AttachmentStore | undefined; desktop?: Pick<Desktop, 'act'>;
  /** Foreground mode is on: the desktop tool works the whole screen through these instead; saved operations still replay through `desktop`. */
  screen?: Pick<Desktop, 'act'> }): ToolDefinition[] {
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
    defineTool({ name: 'page_click', description: `点 page_read 给出的编号；hold 是按住的秒数，长按（最多 ${MAX_HOLD_SECONDS} 秒）。`, parameters: { ref: { type: 'integer', required: true }, hold: { type: 'number' } }, output,
      execute: async args => {
        const target = ref(args.ref), held = holdMs(args.hold);
        return run(async p => { await p.click(target, held); return `${pressed('点击', args.hold, ` [${args.ref}]`)}现在：${await where(p)}`; });
      } }),
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
        const attachments = imageStore();
        await attach(attachments, { data: await run(p => p.shot()), mediaType: 'image/png' }, '我的浏览器.png', '这是我浏览器当前页面的截图。', context);
        return '截图附在下一条消息里。';
      } }),
    defineTool({ name: 'page_eval', description: '在当前页面里执行一段 JS（可 return 一个能转成 JSON 的值），只在我的浏览器页面里，碰不到电脑上的文件。十秒超时，结果截到 2000 字。', parameters: { script: { type: 'string', required: true } }, output,
      execute: async ({ script }) => run(async p => cut(JSON.stringify(await p.evaluate(script, {})) ?? 'null', 2000)) }),
  ];
  const procedures: ToolDefinition[] = [
    defineTool({ name: 'computer_use', description: '用电脑之前先说这次要用的程序或网站（target 只写对象，比如「微信」「B站」，不写要做的事），返回我写的这一类的说明、操作名和文件所在的文件夹；要看某个操作的参数和步骤就读它的文件。不说就列出我现在能用的模块和学会的操作有哪些分类。', parameters: { target: { type: 'string' } }, output,
      // Asked without naming anything, she is first told which of her modules she has right now: a name each, no instructions.
      execute: async ({ target }) => target?.trim() ? catalogText(deps.library, target) : `${modules()}\n${catalogText(deps.library)}` }),
    defineTool({ name: 'procedure_run', description: '跑一个学会的操作：path 写「分类/操作」，args 是它声明的参数。不调模型，直接回放；没跑通会说第几步、为什么。', parameters: { path: { type: 'string', required: true }, args: { type: 'object', additionalProperties: true } }, output,
      execute: async ({ path, args }, context) => runStored(path, (args ?? {}) as Record<string, unknown>, context) }),
    // The format is long and only needed when she writes one, so it is handed over on asking rather than sent with every step.
    defineTool({ name: 'procedure_save', description: `把用 page_* 或 desktop 走通的步骤存成一个操作，以后用 procedure_run 直接跑；同名覆盖、留下旧版本。文件在 ${deps.library.dir}，也可以直接改。json 是整份操作；第一次写或记不清格式，就不带 json 调一次，会给出完整的格式说明。`, parameters: { json: { type: 'string' } }, output,
      execute: async ({ json }) => {
        if (typeof json !== 'string' || !json.trim()) return `操作文件的格式：\n${FORMAT_NOTE}`;
        try {
          const { path, version } = deps.library.save(json);
          const advice = desktopAdvice(deps.library.get(path)!);
          return `已保存 ${path}（第 ${version} 版），可以用 procedure_run 跑了。${advice.length ? `\n先看看这几处：\n${advice.map(line => `- ${line}`).join('\n')}` : ''}`;
        }
        catch (error) { throw new Error(`没有保存：${errorText(error)}（完整格式：不带 json 调一次 procedure_save）`); }
      } }),
    defineTool({ name: 'procedure_note', description: '写某一类操作的说明：这一类对应哪个程序或网站（写上程序名、网址和别称，computer_use 靠它找到这一类）、要注意什么。整份替换，旧的留作版本，最多 1000 字。', parameters: { category: { type: 'string', required: true }, text: { type: 'string', required: true } }, output,
      execute: async ({ category, text }) => {
        try { return `已写好 ${category} 的说明（第 ${deps.library.saveGuide(category, text)} 版）。`; }
        catch (error) { throw new Error(`没有保存：${errorText(error)}`); }
      } }),
  ];
  const live = deps.screen ?? deps.desktop;
  const desktop: ToolDefinition[] = !live ? [] : [
    defineTool({ name: 'desktop', description: deps.screen ? SCREEN_NOTE : DESKTOP_NOTE, output, parameters: {
      action: { type: 'string', required: true }, app: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' },
      double: { type: 'boolean' }, right: { type: 'boolean' }, hold: { type: 'number' }, text: { type: 'string' }, submit: { type: 'boolean' }, key: { type: 'string' }, direction: { type: 'string' },
      seconds: { type: 'number' }, every: { type: 'number' }, from: { type: 'number' }, to: { type: 'number' }, at: { type: 'number' }, pause: { type: 'boolean' },
    }, execute: async (input, context) => {
      context.signal.throwIfAborted();
      const result = await live.act(input as DesktopInput);
      if (!result.image) return result.text;
      const { caption } = result.image;
      return await shown(result.image, caption ? '录下的画面.jpg' : '伙伴的电脑.png', caption ?? `这是${pictured(deps.screen !== undefined)}的截图。`, context)
        ? result.text : `${result.text}（宿主图片存储不可用，看不到截图）`;
    } }),
  ];
  return [...page, ...procedures, ...desktop];

  /** The modules she can use now; the desktop line follows its switch and mode. */
  function modules(): string {
    const desktop = deps.screen ? 'desktop（伙伴的电脑，前台模式：整个屏幕，真的鼠标键盘）' : deps.desktop ? 'desktop（伙伴的电脑，后台模式：一个窗口，不动伙伴的鼠标）' : '';
    return `现在能用：page_*（你自己的浏览器）、${desktop ? `${desktop}、` : ''}procedure_*（学会的操作）。`;
  }
  function imageStore(): AttachmentStore {
    const attachments = deps.attachments();
    if (!attachments) throw new Error('宿主图片存储不可用');
    return attachments;
  }
  /** Tool results carry text only, so an image goes to her in the next message. */
  async function attach(attachments: AttachmentStore, image: { data: Buffer; mediaType: ImageMediaType }, name: string, caption: string, context: ToolRunContext): Promise<void> {
    const [attachment] = await keepImages(attachments, [{ data: image.data, mediaType: image.mediaType, name }]);
    context.signal.throwIfAborted();
    context.deferContext(imagesMessage(shownImage(caption, attachment!)));
  }

  /** A picture of something that already happened: a missing image store costs her the picture, never the result. False then. */
  async function shown(image: NonNullable<DesktopResult['image']>, name: string, caption: string, context: ToolRunContext): Promise<boolean> {
    const attachments = deps.attachments();
    if (!attachments) return false;
    await attach(attachments, image, name, caption, context);
    return true;
  }
  /** The picture a run on the partner's computer ended on. */
  async function lastPicture(image: NonNullable<DesktopResult['image']>, where: Computer, context: ToolRunContext): Promise<string> {
    return await shown(image, '伙伴的电脑.png', `这是操作跑完时${pictured(where === 'screen')}的截图。`, context)
      ? '\n最后一张截图附在下一条消息里，看看做成了没有。' : '\n（宿主图片存储不可用，看不到最后的截图）';
  }
  /** Filing what she read must never cost her the read itself, so a failure is a line after the result. */
  async function archiveNote(map: MessageMap, rows: Row[], args: Args): Promise<string> {
    try {
      const archived = await deps.recorder.record(deps.agent, map, rows, args);
      return archived.outOfScope ? '\n（这个会话不在归档范围里，没有记）' : `\n新记进归档 ${archived.written} 条${archived.skipped ? `，跳过 ${archived.skipped} 条缺字段的` : ''}。`;
    } catch (error) { return `\n（没能记进归档：${errorText(error)}）`; }
  }

  /** One of her operations, newest version first, falling back to the ones it replaced. */
  async function runStored(path: string, input: Record<string, unknown>, context: ToolRunContext): Promise<string> {
    const procedure = deps.library.get(path);
    if (!procedure) throw new Error(`没有 ${path} 这个操作，先用 computer_use 看看有哪些`);
    checkArgs(procedure, input);
    const kept = deps.library.kept(path);
    // Each mode replays what was found in it: one window in the background, the whole screen in the foreground.
    const live = procedure.where === 'screen' ? deps.screen : procedure.where === 'desktop' ? deps.desktop : undefined;
    if (procedure.where === 'desktop' && !live) throw new Error(`${path} 是伙伴电脑上的操作（后台模式），要先打开「她用电脑」`);
    if (procedure.where === 'screen' && !live) throw new Error(`${path} 是在整个屏幕上做的操作（前台模式），要请伙伴把「她用电脑」切到「前台」`);
    let outcome, last: DesktopResult['image'];
    // On the desktop every step answers with a picture; the last one is what she checks the run by.
    const hands = live && { act: async (input: DesktopInput) => { const result = await live.act(input); last = result.image ?? last; return result; } };
    try {
      outcome = procedure.where !== undefined
        ? await runVersions(procedure, kept, input, hands!, context.signal)
        : await run((p, signal) => runVersions(procedure, kept, input, p, AbortSignal.any([signal, context.signal])));
    } catch (error) { noteRun(deps.library, path, { thrown: error }); throw error; }
    noteRun(deps.library, path, outcome);
    const { result, ran, fallback } = outcome;
    const seen = last && procedure.where ? await lastPicture(last, procedure.where, context) : '';
    if (!result.ok) return failureText(path, result) + seen;
    if (procedure.where !== undefined) return '做完了。' + (fallback ? `（${fallbackText(fallback)}趁现在用 desktop 把最新版走通再存。）` : '') + (seen || '（没有截图，用 desktop shot 看看结果）');
    // The version that ran declares what it read, and its own arguments are what fill the records.
    const archived = ran.messages && result.rows.length ? await archiveNote(ran.messages, result.rows, checkArgs(ran, input)) : '';
    return resultText(result) + archived + (fallback ? `\n（${fallbackText(fallback)}页面可能改了，或新旧页面并存。趁现在修：用 page_* 看看现在的页面，改好再 procedure_save，新旧页面都要能跑。）` : '');
  }
}
