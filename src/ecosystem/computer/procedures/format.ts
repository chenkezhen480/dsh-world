// src/ecosystem/computer/procedures/format.ts
import { PAGE_KEYS } from '../browser/page.ts';

/** Finds an element by what a person sees: its role and name, text it shows, or a CSS selector; `nth` picks among several. */
export interface Anchor { role?: string; name?: string; text?: string; css?: string; nth?: number }
export interface Condition { text?: string; anchor?: Anchor; url?: string }
export interface ExtractSpec { list: Anchor; fields: Record<string, Anchor & { attr?: string }>; limit?: number }
export type Target = { ref: number } | { anchor: Anchor };
export type Step =
  | { open: string }
  | { click: Anchor; outward?: boolean }
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
export interface Procedure { name: string; category: string; description: string; params: Record<string, Param>; steps: Step[]; onAlarm?: boolean; summary?: string; messages?: MessageMap }

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
const EXTRAS: Record<(typeof ACTIONS)[number], string[]> = { open: [], click: ['outward'], type: ['outward'], press: ['outward'], wait: [], check: [], extract: ['allowEmpty'], script: ['as', 'outward', 'allowEmpty'] };
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
    case 'click': return { click: anchor(input.click, `${path}.click`, known), ...extra };
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
  only(input, ['name', 'category', 'description', 'params', 'steps', 'onAlarm', 'summary', 'messages'], '工具');
  const name = entryName(input.name, 'name');
  const own = input.category === undefined ? category : entryName(input.category, 'category');
  const declared = params(input.params);
  const known = new Set(Object.keys(declared));
  if (!Array.isArray(input.steps) || !input.steps.length || input.steps.length > MAX_STEPS) fail('steps', `要有 1 到 ${MAX_STEPS} 步`);
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
