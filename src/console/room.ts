import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorText } from '../faults.ts';
import { knownHost, sendJson } from '../http.ts';
import { meetsRange, peerRange } from '../packageInstall.ts';

/**
 * Her cottage: a static page the console shows in a frame, one copy under each world's prefix. It only reads that
 * world's `console/snapshot` (a relative address, so the page itself knows no world), and adds no storage of its own.
 * The longer prefix wins over the console's, as with the QQ doors.
 *
 * The page lives in its own package, installed into the profile only when the partner asks for it from the console,
 * so the plugin itself stays small. It is looked up on every request: an install needs no restart.
 */
export const ROOM_PACKAGE = 'dsh-world-room';
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.webm': 'video/webm' };
/** Its own scripts, pictures and clips, and the snapshot only; framed by the console alone. The import map and the page styles are inline. */
const POLICY = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; frame-ancestors 'self'";

/**
 * The installed room package, or undefined while there is none: in the profile, where the console's install puts it,
 * or else wherever this plugin's own dependencies are found.
 */
export function installedRoom(profileDir?: string): { dir: string; version: string } | undefined {
  const inProfile = profileDir && join(profileDir, 'node_modules', ROOM_PACKAGE, 'package.json');
  let file = inProfile && existsSync(inProfile) ? inProfile : undefined;
  if (!file) {
    try { file = fileURLToPath(import.meta.resolve(`${ROOM_PACKAGE}/package.json`)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') return undefined;
      throw error;
    }
  }
  return { dir: dirname(file), version: String(JSON.parse(readFileSync(file, 'utf8')).version) };
}

export interface RoomStatus { installed: boolean; version?: string; wanted: string; current: boolean; error?: string }
/** What the console shows: whether the room is installed, and whether that version is one this plugin works with. */
export function roomStatus(find: () => ReturnType<typeof installedRoom> = installedRoom): RoomStatus {
  const wanted = peerRange(ROOM_PACKAGE);
  try {
    const found = find();
    return found ? { installed: true, version: found.version, wanted, current: meetsRange(found.version, wanted) } : { installed: false, wanted, current: false };
  } catch (error) {
    // A broken install shows as one to put right, not as a console that cannot load.
    return { installed: false, wanted, current: false, error: `小屋读不出来：${errorText(error)}` };
  }
}

/** The file a request path under `prefix` names inside `root`, or undefined when it is not a servable file there. */
export function roomFile(root: string, prefix: string, pathname: string): string | undefined {
  let rest: string;
  try { rest = decodeURIComponent(pathname.slice(prefix.length)); } catch { return undefined; }
  if (!rest.startsWith('/') || rest.includes('\0') || rest.includes('\\')) return undefined;
  const file = resolve(root, '.' + (rest.endsWith('/') ? rest + 'index.html' : rest));
  return file.startsWith(resolve(root) + sep) && TYPES[extname(file)] ? file : undefined;
}

/** `room()` is the folder the page is served from; undefined while it is not installed. */
export function roomRoute(worldPrefix: string, allowedHosts: readonly string[] = [], room: () => string | undefined = () => installedRoom()?.dir) {
  const prefix = worldPrefix + '/room';
  return {
    kind: 'prefix' as const, path: prefix,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.headers['sec-fetch-site'] === 'cross-site' || !knownHost(req.headers.host, allowedHosts)) { sendJson(res, { status: 403, body: { error: 'cross-site requests are not allowed' } }); return; }
      if (req.method !== 'GET') { sendJson(res, { status: 405, body: { error: 'method not allowed' }, headers: { allow: 'GET' } }); return; }
      const { pathname } = new URL(req.url ?? '/', 'http://localhost');
      // The page's relative addresses only work from inside the folder.
      if (pathname === prefix) { res.writeHead(308, { location: prefix + '/' }); res.end(); return; }
      let root: string | undefined;
      try { root = room(); } catch (error) { sendJson(res, { status: 500, body: { error: `小屋读不出来：${errorText(error)}` } }); return; }
      if (!root) { sendJson(res, { status: 404, body: { error: '小屋还没安装，请在控制台的「小屋」标签里安装' } }); return; }
      const file = roomFile(root, prefix, pathname);
      if (!file) { sendJson(res, { status: 404, body: { error: 'not found' } }); return; }
      let data: Buffer;
      try { data = await readFile(file); } catch (error) {
        const missing = ['ENOENT', 'EISDIR', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
        sendJson(res, missing ? { status: 404, body: { error: 'not found' } } : { status: 500, body: { error: 'internal error' } });
        return;
      }
      const headers = { 'content-type': TYPES[extname(file)], 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'content-security-policy': POLICY, 'accept-ranges': 'bytes' };
      const part = byteRange(req.headers.range, data.byteLength);
      if (part === 'unsatisfiable') { res.writeHead(416, { 'content-range': `bytes */${data.byteLength}` }); res.end(); return; }
      if (!part) { res.writeHead(200, { ...headers, 'content-length': data.byteLength }); res.end(data); return; }
      res.writeHead(206, { ...headers, 'content-length': part.end - part.start + 1, 'content-range': `bytes ${part.start}-${part.end}/${data.byteLength}` });
      res.end(data.subarray(part.start, part.end + 1));
    },
  };
}

/**
 * One `bytes=a-b`, `bytes=a-` or `bytes=-n` range inside a file of `size` bytes. A browser can only jump about in
 * her clips when ranges are answered. Anything else in the header (several ranges, other units) gets the whole file.
 */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '');
  if (!match || (match[1] === '' && match[2] === '')) return undefined;
  const start = match[1] === '' ? Math.max(0, size - Number(match[2])) : Number(match[1]);
  const end = match[1] === '' || match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  return start > end || start >= size ? 'unsatisfiable' : { start, end };
}
