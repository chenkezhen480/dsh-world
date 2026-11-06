import type { IncomingMessage, ServerResponse } from 'node:http';
import { knownHost, sendJson } from './http.ts';

export const WORLDS_PATH = '/dsh-world/worlds';
export const validWorldId = (id: string) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id);
export const worldPath = (id: string) => `${WORLDS_PATH}/${id}`;

export function worldListRoute(worlds: ReadonlyMap<string, readonly string[]>) {
  return {
    kind: 'exact' as const, path: WORLDS_PATH,
    handler(req: IncomingMessage, res: ServerResponse): void {
      const ids = [...worlds].filter(([, hosts]) => knownHost(req.headers.host, hosts)).map(([id]) => id).sort();
      if (!ids.length || req.headers['sec-fetch-site'] === 'cross-site') {
        sendJson(res, { status: 403, body: { error: 'forbidden' } }); return;
      }
      if (req.method !== 'GET') {
        sendJson(res, { status: 405, body: { error: 'method not allowed' }, headers: { allow: 'GET' } }); return;
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
