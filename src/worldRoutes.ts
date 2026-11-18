import type { IncomingMessage, ServerResponse } from 'node:http';
import { errorText } from './faults.ts';
import { jsonObject, knownHost, readBody, sendJson } from './http.ts';

export const WORLDS_PATH = '/dsh-world/worlds';
export const validWorldId = (id: string) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id);
export const worldPath = (id: string) => `${WORLDS_PATH}/${id}`;
/** A write must carry this header; a page on another site cannot add it without a CORS preflight, which is never answered. */
export const WRITE_HEADER = 'x-dsh-world';
const MAX_BODY_BYTES = 4 * 1024;
const MAX_NAME = 40;

/** The worlds this profile has loaded, and one more added on request: `add` throws its refusal in words for the partner. */
export function worldListRoute(worlds: ReadonlyMap<string, readonly string[]>, add?: (worldId: string, companionName: string) => Promise<void>) {
  async function addOne(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const written = req.headers[WRITE_HEADER] === '1' && String(req.headers['content-type'] ?? '').startsWith('application/json');
    const body = written ? jsonObject(await readBody(req, MAX_BODY_BYTES)) : undefined;
    const worldId = body?.worldId, companionName = body?.companionName ?? '';
    if (typeof worldId !== 'string' || typeof companionName !== 'string' || [...companionName].length > MAX_NAME) {
      sendJson(res, { status: 400, body: { error: '请填世界的名字' } }); return;
    }
    try { await add!(worldId.trim(), companionName.trim()); }
    catch (error) { sendJson(res, { status: 409, body: { error: errorText(error) } }); return; }
    sendJson(res, { status: 200, body: { ok: true, worldId: worldId.trim(), restartRequired: true } });
  }
  return {
    kind: 'exact' as const, path: WORLDS_PATH,
    async handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const ids = [...worlds].filter(([, hosts]) => knownHost(req.headers.host, hosts)).map(([id]) => id).sort();
      if (!ids.length || req.headers['sec-fetch-site'] === 'cross-site') {
        sendJson(res, { status: 403, body: { error: 'forbidden' } }); return;
      }
      if (req.method === 'POST' && add) return addOne(req, res);
      if (req.method !== 'GET') {
        sendJson(res, { status: 405, body: { error: 'method not allowed' }, headers: { allow: add ? 'GET, POST' : 'GET' } }); return;
      }
      const { searchParams } = new URL(req.url ?? WORLDS_PATH, 'http://localhost');
      const limit = Number(searchParams.get('limit') ?? 20), offset = Number(searchParams.get('offset') ?? 0);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
        sendJson(res, { status: 400, body: { error: '世界列表分页参数无效' } }); return;
      }
      const worldIds = ids.slice(offset, offset + limit);
      const nextOffset = offset + worldIds.length < ids.length ? offset + worldIds.length : null;
      sendJson(res, { status: 200, body: { worldIds, nextOffset } });
    },
  };
}
