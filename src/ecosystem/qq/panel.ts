import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { durableWrite } from '../../life/lifeStore.ts';

/**
 * The one console her partner opens from the QQ card, reached from this machine only.
 *
 * SnowLuma's console answers on loopback, but it can not be framed (`X-Frame-Options: DENY`) and its session
 * token lives in SnowLuma's own memory (a fresh 64-hex string per login, dead on restart). The only way to get
 * one is `POST /api/login` with the panel password. So he types that password exactly once; it is kept in
 * `<world>/panel.json` with mode 600 and used from then on to trade for a token behind his back. The page
 * itself takes `?token=` and wipes it off the address bar.
 *
 * Where SnowLuma lives used to be read out of the standalone `qq-bridge` process's config. That process is
 * gone, so the home now comes from `qqNative.snowlumaHome` in the plugin's own config, with a short list of
 * usual install locations as a fallback for a machine that has never been told.
 */

export const PANEL_FILE = 'panel.json';
/** Its console answers on loopback; the port comes from SnowLuma's own runtime.json, never a constant here. */
const LOOPBACK = '127.0.0.1';
const LOGIN_TIMEOUT_MS = 8000;
const DEFAULT_USERNAME = 'admin';

interface PanelFile { snowluma?: { username?: string; password?: string } }
interface RuntimeFile { webuiPort?: number; webuiHost?: string; webuiTls?: { enabled?: boolean } }

export interface PanelUrl { url: string }
export interface PanelNeeds { needs: 'password'; url?: string; username?: string }
export interface PanelError { error: string }
export type PanelResult = PanelUrl | PanelNeeds | PanelError;

/** Where SnowLuma's console listens, learned from its own config; undefined when it is not installed here. */
export function findSnowlumaConsole(homeDir: string): { base: string; username?: string } | undefined {
  if (!homeDir) return undefined;
  const runtime = join(homeDir, 'config', 'runtime.json');
  if (!existsSync(runtime)) return undefined;
  let parsed: RuntimeFile;
  try { parsed = JSON.parse(readFileSync(runtime, 'utf8')) as RuntimeFile; }
  catch { return undefined; }
  const port = Number(parsed.webuiPort);
  if (!Number.isInteger(port) || port <= 0) return undefined;
  const host = String(parsed.webuiHost ?? LOOPBACK);
  // A console bound to every interface is still reached from here by name.
  const named = host === '0.0.0.0' || host === '::' || host === '' ? LOOPBACK : host;
  const scheme = parsed.webuiTls?.enabled === true ? 'https' : 'http';
  return { base: `${scheme}://${named}:${port}`, username: undefined };
}

/** 常见安装位置，按顺序试；只认「里面有 config/runtime.json」的那个。给 ，没有就返回空。 */
export function discoverSnowlumaHome(configured = '', candidates?: readonly string[]): string {
  const list = configured !== '' ? [configured] : (candidates ?? [
    'D:\\SnowLuma', 'C:\\SnowLuma', 'E:\\SnowLuma',
    join(homedir(), 'SnowLuma'), join(homedir(), 'snowluma'),
  ]);
  for (const dir of list) {
    if (dir && existsSync(join(dir, 'config', 'runtime.json'))) return dir;
  }
  return '';
}

/** The panel password he typed once, kept beside her room rather than inside her world settings. */
export function createPanelSecrets(worldDir: string) {
  const file = join(worldDir, PANEL_FILE);
  let stored: PanelFile = {};
  try { if (existsSync(file)) stored = JSON.parse(readFileSync(file, 'utf8')) as PanelFile; }
  catch { stored = {}; }
  const read = (): { username: string; password: string } | undefined => {
    const password = stored.snowluma?.password;
    if (typeof password !== 'string' || password === '') return undefined;
    return { username: stored.snowluma?.username?.trim() || DEFAULT_USERNAME, password };
  };
  return {
    read,
    remember(username: string, password: string): void {
      stored = { ...stored, snowluma: { username: username.trim() || DEFAULT_USERNAME, password } };
      durableWrite(file, JSON.stringify(stored, null, 2));
    },
    forget(): void {
      stored = {};
      durableWrite(file, '{}');
    },
  };
}

/** Trades the panel password for a session token and hands back a URL that opens already logged in. */
export async function loginSnowluma(base: string, username: string, password: string, fetchImpl: typeof fetch = fetch): Promise<PanelResult> {
  const root = base.replace(/\/+$/, '');
  let response: Response;
  try {
    response = await fetchImpl(`${root}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    });
  } catch (error) {
    return { error: `连不上 SnowLuma 控制台（${root}）：${error instanceof Error ? error.message : String(error)}` };
  }
  let body: Record<string, unknown> = {};
  try { body = (await response.json()) as Record<string, unknown>; } catch { body = {}; }
  if (response.status === 429) return { error: '登录尝试太多，SnowLuma 让等一会儿再试' };
  const token = typeof body.token === 'string' ? body.token : '';
  if (!response.ok || body.success !== true || token === '') {
    const message = typeof body.message === 'string' ? body.message : `登录失败（HTTP ${response.status}）`;
    return { error: message };
  }
  return { url: `${root}/?token=${encodeURIComponent(token)}` };
}

/** The door the QQ card's button knocks on. */
export interface ConsoleDoors {
  snowluma(): Promise<PanelResult>;
  remember(username: string, password: string): Promise<PanelResult>;
  /** Hand a console URL to the desktop's own browser; it does not allow being framed. */
  open(kind: 'snowluma'): Promise<{ opened: true } | { error: string }>;
}

/**
 * SnowLuma's console sends `X-Frame-Options: DENY` (and `frame-ancestors 'none'`), so no page of ours can hold
 * it in a frame. Opening the desktop's own browser is the honest way in: it is where that console was meant to
 * run, and the token rides in the URL so it lands already logged in.
 */
export function openInBrowser(url: string, spawnImpl: typeof spawn = spawn): { opened: true } | { error: string } {
  try {
    if (process.platform === 'win32') {
      // The empty argument is the window title; without it `start` eats the first quoted word.
      spawnImpl('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else {
      spawnImpl(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    return { opened: true };
  } catch (error) {
    return { error: `打不开浏览器：${error instanceof Error ? error.message : String(error)}` };
  }
}

export function createConsoleDoors(options: { worldDir: string; snowlumaHome?: string }): ConsoleDoors {
  const secrets = createPanelSecrets(options.worldDir);
  const home = discoverSnowlumaHome(options.snowlumaHome ?? '');
  async function snowluma(): Promise<PanelResult> {
    const console = findSnowlumaConsole(home);
    if (!console) return { error: '没找到 SnowLuma 的控制台配置（它在哪？填 qqNative.snowlumaHome）' };
    const saved = secrets.read();
    if (!saved) return { needs: 'password', url: console.base, username: DEFAULT_USERNAME };
    return loginSnowluma(console.base, saved.username, saved.password);
  }
  return {
    snowluma,
    async remember(username: string, password: string): Promise<PanelResult> {
      const console = findSnowlumaConsole(home);
      if (!console) return { error: '没找到 SnowLuma 的控制台配置（它在哪？填 qqNative.snowlumaHome）' };
      const result = await loginSnowluma(console.base, username.trim() || DEFAULT_USERNAME, password);
      // Only keep a password that works; a typo should not be remembered as the truth.
      if ('url' in result) secrets.remember(username, password);
      return result;
    },
    async open(kind: 'snowluma') {
      const door = kind === 'snowluma' ? await snowluma() : { error: '现在只有 SnowLuma 一扇门' };
      // A door that still wants a password carries its base URL too; that is not something to open.
      if ('needs' in door) return { error: 'SnowLuma 还差一次面板密码' };
      if ('error' in door) return { error: door.error };
      return openInBrowser(door.url);
    },
  };
}
