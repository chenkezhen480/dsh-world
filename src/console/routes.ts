import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonObject, knownHost, readBody, sendJson, type JsonResult } from '../http.ts';
import { PERSONA_LAYERS, type Persona } from '../persona.ts';
import { validMemoryTokenBudget, validTurns, validWechatBuffer, validWechatContext, MAX_WECHAT_BUFFER_SECONDS, MAX_WECHAT_CONTEXT } from '../worldSwitch.ts';
import { validArchiveScope, type MemoryArchiveScope } from '../archiveSelection.ts';

export const CONSOLE_PREFIX = '/dsh-world';
/** A write must carry this header; a page on another site cannot add it without a CORS preflight, which is never answered. */
export const WRITE_HEADER = 'x-dsh-world';
const MAX_BODY_BYTES = 64 * 1024;
export interface ConsoleSources {
  snapshot(): Promise<unknown>;
  activity(day: string, outsideOnly: boolean): unknown;
  diary(date: string): string | undefined;
  /** The pictures she kept with `keep_photo`, newest first. */
}
/** What the console can change: whether her world runs, and her persona and world prompt. */
export interface ConsoleActions {
  start(): Promise<void>;
  stop(): Promise<void>;
  prompts(): { persona: Persona; worldPrompt: { text: string; custom: boolean } };
  savePersona(persona: Partial<Persona>): void;
  /** An empty text goes back to the shipped template. */
  saveWorldPrompt(text: string): void;
  /** CNY a day for her home; undefined removes the limit. */
  setDailyBudget(yuan: number | undefined): void;
  /** Turns in her memory block; undefined goes back to the default. */
  setMemoryTurns(turns: number | undefined): void;
  setMemoryTokenBudget(tokens: number | undefined): void;
  setArchiveScope(scope: MemoryArchiveScope): boolean;
  /** A field left out stays as it is; null goes back to its default. */
  /** Turns the WeChat and QQ modules on or off now (their tools and routes come and go with the switch). Returns why it cannot, or nothing. */
  setModules(modules: { wechat?: boolean; qq?: boolean }): Promise<string | undefined>;
  /** Restarts the adapter the plugin manages; false when it does not manage one. */
  restartWechatAdapter(): Promise<boolean>;
  setWechatSettings(settings: { context?: number | null; bufferSeconds?: number | null }): void;
  setRoutineEnabled(enabled: boolean): void;
  setRoutinePaused(id: string, paused: boolean): void;
  removeRoutine(id: string): void;
}
export interface ConsoleRequest { method: string; url: string; write: boolean; body?: Record<string, unknown> | undefined }
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
    case '/console/persona': { const layers = persona(body); if (!layers) return bad('persona layers must be strings'); actions.savePersona(layers); return ok(); }
    case '/console/budget': {
      const daily = body?.daily;
      if (daily !== null && (typeof daily !== 'number' || !Number.isFinite(daily) || daily < 0)) return bad('daily must be a non-negative number or null');
      actions.setDailyBudget(daily === null ? undefined : daily); return ok();
    }
    case '/console/memory': {
      const turns = body?.turns, tokens = body?.tokenBudget;
      if (turns === undefined && tokens === undefined) return bad('nothing to change');
      if (turns !== undefined && turns !== null && !validTurns(turns)) return bad('turns must be a whole number of at least 1, or null');
      if (tokens !== undefined && tokens !== null && !validMemoryTokenBudget(tokens)) return bad('tokenBudget must be a whole number from 1 to 200000, or null');
      if (turns !== undefined) actions.setMemoryTurns(turns === null ? undefined : turns);
      if (tokens !== undefined) actions.setMemoryTokenBudget(tokens === null ? undefined : tokens);
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
      return refused ? bad(refused) : ok();
    }
    case '/console/wechat-adapter': return await actions.restartWechatAdapter() ? ok() : bad('适配器不是由插件管理的，请在配置里写 wechatAdapter');
    case '/console/archive-scope': {
      if (!validArchiveScope(body?.scope)) return bad('scope must be home or workspace');
      return ok({ ok: true, restartRequired: actions.setArchiveScope(body.scope) });
    }
    case '/console/routines': {
      if (typeof body?.enabled !== 'boolean') return bad('enabled must be boolean');
      actions.setRoutineEnabled(body.enabled); return ok();
    }
    case '/console/routines/pause': {
      if (typeof body?.id !== 'string' || !body.id || typeof body.paused !== 'boolean') return bad('id and paused are required');
      actions.setRoutinePaused(body.id, body.paused); return ok();
    }
    case '/console/routines/remove': {
      if (typeof body?.id !== 'string' || !body.id) return bad('id is required');
      actions.removeRoutine(body.id); return ok();
    }
    case '/console/world-prompt': { if (typeof body?.text !== 'string') return bad('text must be a string'); actions.saveWorldPrompt(body.text); return ok(); }
    default: return { status: 404, body: { error: 'not found' } };
  }
}

/** Reads are open to the console page; writes need POST, the write header and a JSON body. */
export async function handleConsole(sources: ConsoleSources, actions: ConsoleActions, request: ConsoleRequest): Promise<JsonResult> {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname !== CONSOLE_PREFIX && !url.pathname.startsWith(CONSOLE_PREFIX + '/')) return { status: 404, body: { error: 'not found' } };
  const path = url.pathname.slice(CONSOLE_PREFIX.length);
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
    default: return { status: 404, body: { error: 'not found' } };
  }
}
export function consoleRoute(sources: ConsoleSources, actions: ConsoleActions, allowedHosts: readonly string[] = []) {
  return {
    kind: 'prefix' as const, path: CONSOLE_PREFIX,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      let result: JsonResult;
      try {
        if (req.headers['sec-fetch-site'] === 'cross-site' || !knownHost(req.headers.host, allowedHosts)) result = { status: 403, body: { error: 'cross-site requests are not allowed' } };
        else {
          const method = req.method ?? 'GET';
          const write = method === 'POST' && req.headers[WRITE_HEADER] === '1' && String(req.headers['content-type'] ?? '').startsWith('application/json');
          const body = write ? jsonObject(await readBody(req, MAX_BODY_BYTES)) : undefined;
          result = write && body === undefined ? bad('a JSON object body is required') : await handleConsole(sources, actions, { method, url: req.url ?? '/', write, body });
        }
      } catch { result = { status: 500, body: { error: 'internal error' } }; }
      sendJson(res, result);
    },
  };
}
