// src/ecosystem/computer/procedures/format.ts
import { PAGE_KEYS } from '../browser/page.ts';
import { desktopKey, holdMs, type Point } from '../desktop/input.ts';

/** Finds an element by what a person sees: its role and name, text it shows, or a CSS selector; `nth` picks among several. */
export interface Anchor { role?: string; name?: string; text?: string; css?: string; nth?: number }
export interface Condition { text?: string; anchor?: Anchor; url?: string }
export interface ExtractSpec { list: Anchor; fields: Record<string, Anchor & { attr?: string }>; limit?: number }
export type Target = { ref: number } | { anchor: Anchor };
export type Step =
  | { open: string }
  | { click: Anchor; outward?: boolean; hold?: number }
  | { type: { into: Anchor; text: string }; outward?: boolean }
  | { press: string; outward?: boolean }
  | { wait: Condition & { seconds?: number } }
  | { check: Condition }
  | { extract: ExtractSpec; allowEmpty?: boolean }
  | { script: string; as?: string; outward?: boolean; allowEmpty?: boolean };
export interface Param { type: 'string' | 'number' | 'boolean'; required?: boolean; description?: string }
/** How the rows of the last `extract` become archive records; every value is a template over the row and the arguments. */
export interface MessageMap {
  channel: string; accountId: string; conversationType: 'private' | 'group'; conversationId: string; messageId: string;
  speakerId: string; speakerName?: string; conversationName?: string; content: string; occurredAt?: string;
  /** Evaluates to `true` for her own messages. */
  outgoing?: string;
}
export type Direction = 'up' | 'down' | 'left' | 'right';
/** Steps on the partner's computer, the `desktop` actions written down: nothing to read there, only pictures. */
export type DesktopStep =
  | { open: string }
  | { click: Point & { double?: boolean; right?: boolean; hold?: number }; outward?: boolean }
  | { drag: Point & { x2: number; y2: number; right?: boolean; hold?: number }; outward?: boolean }
  | { type: { text: string } & Partial<Point>; outward?: boolean }
  | { press: string; hold?: number; outward?: boolean }
  | { scroll: { direction: Direction } & Partial<Point> }
  | { wait: { seconds: number } };
interface Common { name: string; category: string; description: string; params: Record<string, Param> }
export interface PageProcedure extends Common { where?: undefined; steps: Step[]; onAlarm?: boolean; summary?: string; messages?: MessageMap }
/** `desktop` is replayed in background mode (one window), `screen` in foreground mode (the whole screen, real input). */
export type Computer = 'desktop' | 'screen';
export interface DesktopProcedure extends Common { where: Computer; steps: DesktopStep[]; onAlarm?: undefined; summary?: undefined; messages?: undefined }
export type Procedure = PageProcedure | DesktopProcedure;

export class ProcedureError extends Error { override name = 'ProcedureError'; }
const fail = (path: string, why: string): never => { throw new ProcedureError(`${path}：${why}`); };

/** A category or operation name is also a folder or file name, so it holds no path characters. */
export const ENTRY_NAME = /^[\p{L}\p{N}_-]{1,40}$/u;
/** Her own notes for a category live in `<category>/目录.md`, so no operation may take that name. */
export const GUIDE_NAME = '目录';
/** Where files the development build left flat in `procedures/` belong. */
export const UNSORTED = '未分类';
const FIELD_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,30}$/;
const TEMPLATE = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;
const ACTIONS = ['open', 'click', 'type', 'press', 'wait', 'check', 'extract', 'script'] as const;
const EXTRAS: Record<(typeof ACTIONS)[number], string[]> = { open: [], click: ['outward', 'hold'], type: ['outward'], press: ['outward'], wait: [], check: [], extract: ['allowEmpty'], script: ['as', 'outward', 'allowEmpty'] };
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const ANCHOR_KEYS = ['role', 'name', 'text', 'css', 'nth'];
const MAX_STEPS = 40, MAX_SCRIPT = 4000, MAX_TEXT = 500;

export const substitute = (text: string, values: Record<string, unknown>) => text.replace(TEMPLATE, (_all, key: string) => Object.hasOwn(values, key) ? String(values[key] ?? '') : '');
/** Her browser reads the web, not the computer: no file:, chrome:, edge:, javascript: or data: pages. */
export const WEB_ONLY = '只能打开 http 或 https 地址';
export const isWebAddress = (url: string) => /^https?:\/\//i.test(url.trim()) || url.trim() === 'about:blank';
const names = (text: string) => [...text.matchAll(TEMPLATE)].map(match => match[1]!);

const record = (value: unknown, path: string): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail(path, '应该是一个对象');
/** A typo like `nmae` must not quietly turn an anchor into "any link". */
function only(input: Record<string, unknown>, keys: readonly string[], path: string): void {
  for (const key of Object.keys(input)) if (input[key] !== undefined && !keys.includes(key)) fail(path, `不认识 ${key}`);
}
function identifier(value: string, path: string, what: string): string {
  if (!FIELD_NAME.test(value) || RESERVED.has(value)) fail(path, `${what} ${value} 只能用字母、数字和下划线，且不能是 ${[...RESERVED].join('、')}`);
  return value;
}
function text(value: unknown, path: string, max = MAX_TEXT, known?: ReadonlySet<string>): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return fail(path, `应该是 1 到 ${max} 字的文字`);
  if (known) for (const name of names(value)) if (!known.has(name)) fail(path, `{{${name}}} 不是已声明的参数或字段`);
  return value;
}
const optionalText = (value: unknown, path: string, known?: ReadonlySet<string>) => value === undefined ? undefined : text(value, path, MAX_TEXT, known);
const flag = (value: unknown, path: string) => value === undefined ? undefined : typeof value === 'boolean' ? value : fail(path, '应该是 true 或 false');

/** `bare` is for an extract field that names only an attribute: it reads the list item itself. */
function anchor(value: unknown, path: string, known: ReadonlySet<string>, extra: readonly string[] = [], bare = false): Anchor {
  const input = record(value, path);
  only(input, [...ANCHOR_KEYS, ...extra], path);
  const out: Anchor = {};
  for (const key of ['role', 'name', 'text', 'css'] as const) { const field = optionalText(input[key], `${path}.${key}`, known); if (field !== undefined) out[key] = field; }
  if (!bare && !out.role && !out.name && !out.text && !out.css) fail(path, '至少要有 role、name、text、css 中的一个');
  if (input.nth !== undefined) { if (!Number.isSafeInteger(input.nth) || (input.nth as number) < 0 || (input.nth as number) > 50) fail(`${path}.nth`, '应该是 0 到 50 的整数'); out.nth = input.nth as number; }
  return out;
}
function condition(value: unknown, path: string, known: ReadonlySet<string>, extra: readonly string[] = []): Condition {
  const input = record(value, path);
  only(input, ['text', 'url', 'anchor', ...extra], path);
  const out: Condition = {};
  const textValue = optionalText(input.text, `${path}.text`, known), urlValue = optionalText(input.url, `${path}.url`, known);
  if (textValue !== undefined) out.text = textValue;
  if (urlValue !== undefined) out.url = urlValue;
  if (input.anchor !== undefined) out.anchor = anchor(input.anchor, `${path}.anchor`, known);
  if (!out.text && !out.url && !out.anchor) fail(path, '至少要有 text、url、anchor 中的一个');
  return out;
}
function extract(value: unknown, path: string, known: ReadonlySet<string>): ExtractSpec {
  const input = record(value, path);
  only(input, ['list', 'fields', 'limit'], path);
  const fields = record(input.fields, `${path}.fields`);
  const entries = Object.entries(fields);
  if (!entries.length || entries.length > 12) fail(`${path}.fields`, '要有 1 到 12 个字段');
  const out: ExtractSpec = { list: anchor(input.list, `${path}.list`, known), fields: {} };
  for (const [name, field] of entries) {
    identifier(name, `${path}.fields`, '字段名');
    const attr = optionalText(record(field, `${path}.fields.${name}`).attr, `${path}.fields.${name}.attr`);
    out.fields[name] = { ...anchor(field, `${path}.fields.${name}`, known, ['attr'], attr !== undefined), ...(attr === undefined ? {} : { attr }) };
  }
  if (input.limit !== undefined) { if (!Number.isSafeInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 20) fail(`${path}.limit`, '应该是 1 到 20 的整数'); out.limit = input.limit as number; }
  return out;
}
/** `taken` holds the names a `script` result may not reuse; a step that names a result adds it. */
function step(value: unknown, path: string, known: ReadonlySet<string>, taken: Set<string>): Step {
  const input = record(value, path);
  const actions = ACTIONS.filter(action => action in input);
  if (actions.length !== 1) return fail(path, `每一步只能有一个动作（${ACTIONS.join('、')}）`);
  const action = actions[0]!;
  for (const key of Object.keys(input)) if (key !== action && !EXTRAS[action].includes(key)) fail(path, `${action} 这一步不认识 ${key}`);
  const outward = flag(input.outward, `${path}.outward`), allowEmpty = flag(input.allowEmpty, `${path}.allowEmpty`);
  const extra = outward === undefined ? {} : { outward }, empty = allowEmpty === undefined ? {} : { allowEmpty };
  switch (action) {
    case 'open': {
      const address = text(input.open, `${path}.open`, 2000, known);
      // An address that starts with a parameter can only be checked once it is filled in, when the step runs.
      if (!address.trimStart().startsWith('{{') && !isWebAddress(address)) fail(`${path}.open`, WEB_ONLY);
      return { open: address };
    }
    case 'click': return { click: anchor(input.click, `${path}.click`, known), ...extra, ...held(input.hold, `${path}.hold`) };
    case 'type': { const body = record(input.type, `${path}.type`); only(body, ['into', 'text'], `${path}.type`); return { type: { into: anchor(body.into, `${path}.type.into`, known), text: text(body.text, `${path}.type.text`, 2000, known) }, ...extra }; }
    case 'press': {
      const key = text(input.press, `${path}.press`, 40);
      if (!PAGE_KEYS.includes(key)) fail(`${path}.press`, `不认识按键 ${key}，可用：${PAGE_KEYS.join('、')}`);
      return { press: key, ...extra };
    }
    case 'wait': {
      const seconds = record(input.wait, `${path}.wait`).seconds;
      if (seconds !== undefined && (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0 || seconds > 60)) fail(`${path}.wait.seconds`, '应该是大于 0、不超过 60 的秒数');
      return { wait: { ...condition(input.wait, `${path}.wait`, known, ['seconds']), ...(seconds === undefined ? {} : { seconds: seconds as number }) } };
    }
    case 'check': return { check: condition(input.check, `${path}.check`, known) };
    case 'extract': return { extract: extract(input.extract, `${path}.extract`, known), ...empty };
    case 'script': {
      const as = input.as === undefined ? undefined : identifier(String(input.as), `${path}.as`, '结果名');
      if (as !== undefined) { if (taken.has(as)) fail(`${path}.as`, `${as} 已经被参数、count 或前面的步骤用了`); taken.add(as); }
      // Only a kept value is checked for emptiness, so the flag means nothing without `as`.
      if (allowEmpty !== undefined && as === undefined) fail(`${path}.allowEmpty`, '只用在带 as 的脚本上');
      return { script: text(input.script, `${path}.script`, MAX_SCRIPT), ...(as === undefined ? {} : { as }), ...extra, ...empty };
    }
  }
}
const DESKTOP_ACTIONS = ['open', 'click', 'drag', 'type', 'press', 'scroll', 'wait'] as const;
const DIRECTIONS: Direction[] = ['up', 'down', 'left', 'right'];
function coordinate(value: unknown, path: string): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 4000 ? value : fail(path, '应该是截图上的像素（0 到 4000 的数）');
}
/** Seconds held, checked as her `desktop` checks them; absent for a plain press. */
function held(value: unknown, path: string): { hold?: number } {
  if (value === undefined) return {};
  try { holdMs(value as number); } catch (error) { fail(path, error instanceof Error ? error.message : String(error)); }
  return { hold: value as number };
}
/** Both x and y or neither: half a point would land somewhere she never chose. */
function optionalPoint(input: Record<string, unknown>, path: string): Partial<Point> {
  if (input.x === undefined && input.y === undefined) return {};
  return { x: coordinate(input.x, `${path}.x`), y: coordinate(input.y, `${path}.y`) };
}
function desktopStep(value: unknown, path: string, known: ReadonlySet<string>): DesktopStep {
  const input = record(value, path);
  const actions = DESKTOP_ACTIONS.filter(action => action in input);
  if (actions.length !== 1) return fail(path, `每一步只能有一个动作（${DESKTOP_ACTIONS.join('、')}）`);
  const action = actions[0]!;
  const canGoOut = action === 'click' || action === 'drag' || action === 'type' || action === 'press';
  for (const key of Object.keys(input)) if (key !== action && !(canGoOut && key === 'outward') && !(action === 'press' && key === 'hold')) fail(path, `${action} 这一步不认识 ${key}`);
  const outward = flag(input.outward, `${path}.outward`), extra = outward === undefined ? {} : { outward };
  switch (action) {
    case 'open': return { open: text(input.open, `${path}.open`, 200, known) };
    case 'click': {
      const body = record(input.click, `${path}.click`);
      only(body, ['x', 'y', 'double', 'right', 'hold'], `${path}.click`);
      const double = flag(body.double, `${path}.click.double`), right = flag(body.right, `${path}.click.right`);
      return { click: { x: coordinate(body.x, `${path}.click.x`), y: coordinate(body.y, `${path}.click.y`), ...(double ? { double } : {}), ...(right ? { right } : {}), ...held(body.hold, `${path}.click.hold`) }, ...extra };
    }
    case 'drag': {
      const body = record(input.drag, `${path}.drag`);
      only(body, ['x', 'y', 'x2', 'y2', 'right', 'hold'], `${path}.drag`);
      const right = flag(body.right, `${path}.drag.right`);
      return { drag: { x: coordinate(body.x, `${path}.drag.x`), y: coordinate(body.y, `${path}.drag.y`), x2: coordinate(body.x2, `${path}.drag.x2`), y2: coordinate(body.y2, `${path}.drag.y2`), ...(right ? { right } : {}), ...held(body.hold, `${path}.drag.hold`) }, ...extra };
    }
    case 'type': {
      const body = record(input.type, `${path}.type`);
      only(body, ['text', 'x', 'y'], `${path}.type`);
      return { type: { text: text(body.text, `${path}.type.text`, 2000, known), ...optionalPoint(body, `${path}.type`) }, ...extra };
    }
    case 'press': {
      const key = text(input.press, `${path}.press`, 40);
      try { desktopKey(key); } catch (error) { fail(`${path}.press`, error instanceof Error ? error.message : String(error)); }
      return { press: key, ...held(input.hold, `${path}.hold`), ...extra };
    }
    case 'scroll': {
      const body = record(input.scroll, `${path}.scroll`);
      only(body, ['direction', 'x', 'y'], `${path}.scroll`);
      if (!DIRECTIONS.includes(body.direction as Direction)) fail(`${path}.scroll.direction`, `应该是 ${DIRECTIONS.join('、')}`);
      return { scroll: { direction: body.direction as Direction, ...optionalPoint(body, `${path}.scroll`) } };
    }
    case 'wait': {
      const body = record(input.wait, `${path}.wait`);
      only(body, ['seconds'], `${path}.wait`);
      if (typeof body.seconds !== 'number' || !Number.isFinite(body.seconds) || body.seconds <= 0 || body.seconds > 60) fail(`${path}.wait.seconds`, '桌面上只能等几秒：大于 0、不超过 60');
      return { wait: { seconds: body.seconds as number } };
    }
  }
}
function params(value: unknown): Record<string, Param> {
  const input = record(value ?? {}, 'params');
  const out: Record<string, Param> = {};
  for (const [name, raw] of Object.entries(input)) {
    identifier(name, 'params', '参数名');
    const param = record(raw, `params.${name}`);
    only(param, ['type', 'required', 'description'], `params.${name}`);
    if (!['string', 'number', 'boolean'].includes(param.type as string)) fail(`params.${name}.type`, '应该是 string、number 或 boolean');
    const required = flag(param.required, `params.${name}.required`), description = optionalText(param.description, `params.${name}.description`);
    out[name] = { type: param.type as Param['type'], ...(required === undefined ? {} : { required }), ...(description === undefined ? {} : { description }) };
  }
  return out;
}
function messages(value: unknown, known: ReadonlySet<string>): MessageMap {
  const input = record(value, 'messages');
  only(input, ['channel', 'accountId', 'conversationType', 'conversationId', 'messageId', 'speakerId', 'speakerName', 'conversationName', 'content', 'occurredAt', 'outgoing'], 'messages');
  const channel = text(input.channel, 'messages.channel', 40);
  if (!/^[a-z][a-z0-9-]*$/.test(channel)) fail('messages.channel', '只能用小写字母、数字和连字符，例如 bilibili');
  if (input.conversationType !== 'private' && input.conversationType !== 'group') fail('messages.conversationType', '应该是 private 或 group');
  const out: MessageMap = {
    channel, conversationType: input.conversationType as MessageMap['conversationType'],
    accountId: text(input.accountId, 'messages.accountId', MAX_TEXT, known), conversationId: text(input.conversationId, 'messages.conversationId', MAX_TEXT, known),
    messageId: text(input.messageId, 'messages.messageId', MAX_TEXT, known), speakerId: text(input.speakerId, 'messages.speakerId', MAX_TEXT, known),
    content: text(input.content, 'messages.content', MAX_TEXT, known),
  };
  for (const key of ['speakerName', 'conversationName', 'occurredAt', 'outgoing'] as const) { const field = optionalText(input[key], `messages.${key}`, known); if (field !== undefined) out[key] = field; }
  return out;
}

export const procedurePath = (procedure: Pick<Procedure, 'category' | 'name'>) => `${procedure.category}/${procedure.name}`;

/** A desktop step right after input that opens the window it needs: by hand there was time between them, in a replay none. */
export const isOpenTooSoon = (steps: DesktopStep[], index: number) => index > 0 && 'open' in steps[index]! && !('wait' in steps[index - 1]!) && !('open' in steps[index - 1]!);
/**
 * What a saved desktop operation is likely to trip on, said when she saves it rather than refused: she may know
 * better, and she learns it either way. A page operation has its own waits and checks.
 */
export function desktopAdvice(procedure: Procedure): string[] {
  if (procedure.where === undefined) return [];
  const advice = procedure.steps.flatMap((step, index) => isOpenTooSoon(procedure.steps, index) && 'open' in step
    ? [`第 ${index + 1} 步 open「${step.open}」紧跟在上一步后面，回放时中间不停；手动做时这个窗口是过一会儿才出来的，要的话在中间加 {"wait":{"seconds":1}}。`] : []);
  if (!procedure.steps.some(step => 'outward' in step && step.outward)) advice.push('没有一步标 outward：会把东西发出去的那一步（发送、发表）要标 "outward": true，没跑通时才知道可能已经发出去了。');
  return advice;
}
export function entryName(value: unknown, path: string): string {
  if (typeof value !== 'string' || !ENTRY_NAME.test(value) || value === GUIDE_NAME) return fail(path, `只能用文字、数字、下划线和连字符，1 到 40 个字，不能是「${GUIDE_NAME}」`);
  return value;
}

/**
 * Her tool file, checked through: a mistake is refused with where it is, so nothing half-valid is ever saved or run.
 * `category` is the folder the file sits in, used when the file does not say.
 */
export function parseProcedure(value: unknown, category = UNSORTED): Procedure {
  const input = record(value, '工具');
  only(input, ['name', 'category', 'description', 'params', 'where', 'steps', 'onAlarm', 'summary', 'messages'], '工具');
  const name = entryName(input.name, 'name');
  const own = input.category === undefined ? category : entryName(input.category, 'category');
  const declared = params(input.params);
  const known = new Set(Object.keys(declared));
  if (!Array.isArray(input.steps) || !input.steps.length || input.steps.length > MAX_STEPS) fail('steps', `要有 1 到 ${MAX_STEPS} 步`);
  if (input.where !== undefined && input.where !== 'desktop' && input.where !== 'screen') fail('where', '只能是 desktop（后台模式走通的）或 screen（前台模式走通的）；网页上的不写');
  if (input.where === 'desktop' || input.where === 'screen') {
    // Nothing on the desktop can be read back, and nothing there may run unseen before an alarm.
    for (const key of ['onAlarm', 'summary', 'messages']) if (input[key] !== undefined) fail(key, '桌面上的操作不能用');
    const steps = (input.steps as unknown[]).map((item, index) => desktopStep(item, `steps[${index}]`, known));
    return { name, category: own, description: text(input.description, 'description'), params: declared, where: input.where, steps };
  }
  const taken = new Set([...known, 'count']);
  const steps = (input.steps as unknown[]).map((item, index) => step(item, `steps[${index}]`, known, taken));
  const onAlarm = flag(input.onAlarm, 'onAlarm');
  if (onAlarm && Object.values(declared).some(param => param.required)) fail('onAlarm', '闹钟前自动跑的工具不能有必填参数');
  if (onAlarm && steps.some(item => 'outward' in item && item.outward)) fail('onAlarm', '闹钟前自动跑的工具不能有向外发出的步骤');
  const fields = new Set([...known, ...steps.flatMap(item => 'extract' in item ? Object.keys(item.extract.fields) : [])]);
  const values = new Set([...known, 'count', ...steps.flatMap(item => 'script' in item && item.as ? [item.as] : [])]);
  if (input.messages !== undefined && !steps.some(item => 'extract' in item)) fail('messages', '只有带 extract 的工具才能声明消息');
  const summary = optionalText(input.summary, 'summary', values);
  return {
    name, category: own, description: text(input.description, 'description'), params: declared, steps,
    ...(onAlarm === undefined ? {} : { onAlarm }), ...(summary === undefined ? {} : { summary }),
    ...(input.messages === undefined ? {} : { messages: messages(input.messages, fields) }),
  };
}
