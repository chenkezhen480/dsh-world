import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonObject, knownHost, readBody, sendJson, type JsonResult } from '../http.ts';
import { PERSONA_LAYERS, type Persona } from '../persona.ts';
import { validColdHours, validTurns, validWechatBuffer, MAX_COLD_HOURS, validWechatContext, validWorkspacePermission, MAX_WECHAT_BUFFER_SECONDS, MAX_WECHAT_CONTEXT } from '../worldSwitch.ts';
import { validArchiveScope, type MemoryArchiveScope } from '../archiveSelection.ts';
import type { PhotoStore } from '../life/photos.ts';
import { validClockTime } from '../life/alarm.ts';
import { MemoryError, type MemoryContent, type MemoryErrorCode, type MemoryPage } from '../memory.ts';

/** A write must carry this header; a page on another site cannot add it without a CORS preflight, which is never answered. */
export const WRITE_HEADER = 'x-dsh-world';
const MAX_BODY_BYTES = 64 * 1024;
export interface ConsoleSources {
  snapshot(): Promise<unknown>;
  activity(day: string, outsideOnly: boolean): unknown;
  diary(date: string): string | undefined;
  photos?(limit: number, offset: number): ReturnType<PhotoStore['list']>;
  photo?(id: string): ReturnType<PhotoStore['image']>;
  /** The same lookups the memory tools make; they check the query themselves. */
  memoryFind?(input: Record<string, unknown>): Promise<MemoryPage>;
  memoryRead?(input: Record<string, unknown>): Promise<MemoryContent>;
}
/** What the console can change: whether her world runs, and her persona and world prompt. */
export interface ConsoleActions {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Enqueue one application of saved prompts and idle-home compaction; returns a refusal, if any. */
  applyHome(): string | undefined;
  prompts(): { persona: Persona; worldPrompt: { text: string; custom: boolean; memory?: { missing: string[]; snippet: string } } };
  savePersona(persona: Partial<Persona>): void;
  /** An empty text goes back to the shipped template. */
  saveWorldPrompt(text: string): void;
  /** CNY a day for her home; undefined removes the limit. */
  setDailyBudget(yuan: number | undefined): void;
  /** Turns in her memory block; undefined goes back to the default. */
  setMemoryTurns(turns: number | undefined): void;
  /** Hours of silence after which a session re-reads her memory and prompt; undefined goes back to the default. */
  setColdHours(hours: number | undefined): void;
  setArchiveScope(scope: MemoryArchiveScope): boolean;
  setWorkspacePermission(permission: string): void;
  /** Whether the evening look back is followed by applying and compacting her home (on unless turned off). */
  setCompactAfterReview(on: boolean): void;
  /** Local HH:MM of the evening look back and the morning wake; a field left out stays, null goes back to its default. */
  setSchedule(schedule: { review?: string | null; wake?: string | null }): void;
  /** A field left out stays as it is; null goes back to its default. */
  /** Turns the WeChat and QQ modules on or off now (their tools and routes come and go with the switch). Returns why it cannot, or nothing. */
  setModules(modules: { wechat?: boolean; qq?: boolean }): Promise<string | { restartRequired: true; message: string } | undefined>;
  /** Restarts the adapter the plugin manages; false when it does not manage one. */
  restartWechatAdapter(): Promise<boolean>;
  setWechatSettings(settings: { context?: number | null; bufferSeconds?: number | null }): void;
}
export interface ConsoleRequest { method: string; url: string; write: boolean; body?: Record<string, unknown> | undefined }
const MEMORY_STATUS: Record<MemoryErrorCode, number> = { invalidQuery: 400, invalidRef: 400, invalidCursor: 400, notFound: 404, outOfScope: 403, cursorExpired: 409, sourceChanged: 409, scopeChanged: 409, readFailed: 500 };
/** Query-string values to the shape the tools take: a number that is not one stays NaN and is refused by the shared check. */
function memoryInput(params: URLSearchParams, numbers: readonly string[], lists: readonly string[]): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [key, value] of params) {
    if (value === '') continue;
    input[key] = numbers.includes(key) ? Number(value) : lists.includes(key) ? value.split(',') : value;
  }
  return input;
}
async function memoryCall<T>(run: (() => Promise<T>) | undefined): Promise<JsonResult> {
  if (!run) return { status: 404, body: { error: '记忆查找不可用' } };
  try { return ok(await run()); }
  catch (error) {
    if (error instanceof MemoryError) return { status: MEMORY_STATUS[error.code], body: { error: error.message, code: error.code } };
    throw error;
  }
}
const ok = (body: unknown = { ok: true }): JsonResult => ({ status: 200, body });
const bad = (error: string): JsonResult => ({ status: 400, body: { error } });

function persona(body: Record<string, unknown> | undefined): Partial<Persona> | undefined {
  if (!body) return undefined;
  const entries = Object.entries(body);
  if (!entries.every(([key, value]) => (PERSONA_LAYERS as readonly string[]).includes(key) && typeof value === 'string')) return undefined;
  return Object.fromEntries(entries) as Partial<Persona>;
}
async function write(actions: ConsoleActions, path: string, body: Record<string, unknown> | undefined): Promise<JsonResult> {
  switch (path) {
    case '/console/start': await actions.start(); return ok();
    case '/console/stop': await actions.stop(); return ok();
    case '/console/apply-home': { const refused = actions.applyHome(); return refused ? bad(refused) : ok(); }
    case '/console/persona': { const layers = persona(body); if (!layers) return bad('persona layers must be strings'); actions.savePersona(layers); return ok(); }
    case '/console/budget': {
      const daily = body?.daily;
      if (daily !== null && (typeof daily !== 'number' || !Number.isFinite(daily) || daily < 0)) return bad('daily must be a non-negative number or null');
      actions.setDailyBudget(daily === null ? undefined : daily); return ok();
    }
    case '/console/memory': {
      const turns = body?.turns, coldHours = body?.coldHours;
      if (turns !== undefined && turns !== null && !validTurns(turns)) return bad('turns must be a whole number of at least 1, or null');
      if (coldHours !== undefined && coldHours !== null && !validColdHours(coldHours)) return bad(`coldHours must be a whole number from 1 to ${MAX_COLD_HOURS}, or null`);
      if (turns === undefined && coldHours === undefined) return bad('nothing to change');
      if (turns !== undefined) actions.setMemoryTurns(turns ?? undefined);
      if (coldHours !== undefined) actions.setColdHours(coldHours ?? undefined);
      return ok();
    }
    case '/console/wechat': {
      const context = body?.contextMessages, bufferSeconds = body?.bufferSeconds;
      if (context !== undefined && context !== null && !validWechatContext(context)) return bad(`contextMessages must be a whole number from 1 to ${MAX_WECHAT_CONTEXT}, or null`);
      if (bufferSeconds !== undefined && bufferSeconds !== null && !validWechatBuffer(bufferSeconds)) return bad(`bufferSeconds must be a number from 0 to ${MAX_WECHAT_BUFFER_SECONDS}, or null`);
      if (context === undefined && bufferSeconds === undefined) return bad('nothing to change');
      actions.setWechatSettings({ ...(context === undefined ? {} : { context }), ...(bufferSeconds === undefined ? {} : { bufferSeconds }) }); return ok();
    }
    case '/console/modules': {
      const wechat = body?.wechat, qq = body?.qq;
      if ((wechat !== undefined && typeof wechat !== 'boolean') || (qq !== undefined && typeof qq !== 'boolean')) return bad('wechat 和 qq 必须是 true 或 false');
      if (wechat === undefined && qq === undefined) return bad('nothing to change');
      const refused = await actions.setModules({ ...(wechat === undefined ? {} : { wechat }), ...(qq === undefined ? {} : { qq }) });
      return typeof refused === 'string' ? bad(refused) : ok({ ok: true, ...refused });
    }
    case '/console/wechat-adapter': return await actions.restartWechatAdapter() ? ok() : bad('适配器不是由插件管理的，请在配置里写 wechatAdapter');
    case '/console/archive-scope': {
      if (!validArchiveScope(body?.scope)) return bad('scope must be home or workspace');
      return ok({ ok: true, restartRequired: actions.setArchiveScope(body.scope) });
    }
    case '/console/compact-after-review': {
      if (typeof body?.on !== 'boolean') return bad('on must be true or false');
      actions.setCompactAfterReview(body.on); return ok();
    }
    case '/console/schedule': {
      const review = body?.review, wake = body?.wake;
      for (const [name, value] of [['review', review], ['wake', wake]] as const) if (value !== undefined && value !== null && !validClockTime(value)) return bad(`${name} must be HH:MM (00:00–23:59), or null`);
      if (review === undefined && wake === undefined) return bad('nothing to change');
      actions.setSchedule({ ...(review === undefined ? {} : { review: review as string | null }), ...(wake === undefined ? {} : { wake: wake as string | null }) }); return ok();
    }
    case '/console/workspace-permission': {
      if (!validWorkspacePermission(body?.permission)) return bad('工作区权限必须为非空字符串');
      try { actions.setWorkspacePermission(body.permission); return ok(); }
      catch (error) { return bad(error instanceof Error ? error.message : String(error)); }
    }
    case '/console/world-prompt': { if (typeof body?.text !== 'string') return bad('text must be a string'); actions.saveWorldPrompt(body.text); return ok(); }
    default: return { status: 404, body: { error: 'not found' } };
  }
}

/** Reads are open to the console page; writes need POST, the write header and a JSON body. */
export async function handleConsole(prefix: string, sources: ConsoleSources, actions: ConsoleActions, request: ConsoleRequest): Promise<JsonResult> {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) return { status: 404, body: { error: 'not found' } };
  const path = url.pathname.slice(prefix.length);
  if (request.method === 'POST') {
    if (!request.write) return { status: 403, body: { error: 'forbidden' } };
    return write(actions, path, request.body);
  }
  if (request.method !== 'GET') return { status: 405, body: { error: 'method not allowed' }, headers: { allow: 'GET, POST' } };
  switch (path) {
    case '/console/snapshot': return ok(await sources.snapshot());
    case '/console/activity': return ok(sources.activity(url.searchParams.get('day') ?? '', url.searchParams.get('outside') === '1'));
    case '/console/diary': {
      const date = url.searchParams.get('date') ?? '';
      const text = sources.diary(date);
      return text === undefined ? { status: 404, body: { error: 'no diary for this date' } } : ok({ date, text });
    }
    case '/console/prompts': return ok(actions.prompts());
    case '/console/memory/find': { const input = memoryInput(url.searchParams, ['limit'], ['kinds']); return memoryCall(sources.memoryFind && (() => sources.memoryFind!(input))); }
    case '/console/memory/read': { const input = memoryInput(url.searchParams, ['offset', 'limit'], []); return memoryCall(sources.memoryRead && (() => sources.memoryRead!(input))); }
    case '/console/photos': {
      const limit = Number(url.searchParams.get('limit') ?? 20), offset = Number(url.searchParams.get('offset') ?? 0);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) return bad('相册分页参数无效');
      return sources.photos ? ok(sources.photos(limit, offset)) : { status: 404, body: { error: '相册不可用' } };
    }
    default: return { status: 404, body: { error: 'not found' } };
  }
}
export function consoleRoute(prefix: string, sources: ConsoleSources, actions: ConsoleActions, allowedHosts: readonly string[] = []) {
  return {
    kind: 'prefix' as const, path: prefix,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      let result: JsonResult;
      try {
        if (req.headers['sec-fetch-site'] === 'cross-site' || !knownHost(req.headers.host, allowedHosts)) result = { status: 403, body: { error: 'cross-site requests are not allowed' } };
        else {
          const method = req.method ?? 'GET';
          const url = new URL(req.url ?? '/', 'http://localhost');
          if (method === 'GET' && url.pathname === prefix + '/console/photo') {
            const image = sources.photo?.(url.searchParams.get('id') ?? '');
            if (!image) { sendJson(res, { status: 404, body: { error: '找不到这张照片' } }); return; }
            res.writeHead(200, { 'content-type': image.ref.mediaType, 'content-length': image.data.byteLength, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" });
            res.end(image.data); return;
          }
          const write = method === 'POST' && req.headers[WRITE_HEADER] === '1' && String(req.headers['content-type'] ?? '').startsWith('application/json');
          const body = write ? jsonObject(await readBody(req, MAX_BODY_BYTES)) : undefined;
          result = write && body === undefined ? bad('a JSON object body is required') : await handleConsole(prefix, sources, actions, { method, url: req.url ?? '/', write, body });
        }
      } catch { result = { status: 500, body: { error: 'internal error' } }; }
      sendJson(res, result);
    },
  };
}
