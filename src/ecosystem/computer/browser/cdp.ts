/** One DevTools socket to one page target; a request the browser never answers times out instead of hanging a tool call. Ported from dsh-inner-browser-use (MIT, see ../NOTICE.md). */
export interface Cdp {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(listener: (method: string, params: Record<string, unknown>) => void): () => void;
  close(): void;
  readonly closed: boolean;
}

export function connectCdp(url: string, options: { timeoutMs?: number } = {}): Promise<Cdp> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const socket = new WebSocket(url);
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; method: string; timer: ReturnType<typeof setTimeout> }>();
  const listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  let next = 1, closed = false;
  socket.addEventListener('message', event => {
    let message: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string } };
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`)); else entry.resolve(message.result ?? {});
      return;
    }
    if (message.method) for (const listener of listeners) { try { listener(message.method, message.params ?? {}); } catch { /* one listener's failure costs that event only */ } }
  });
  socket.addEventListener('close', () => {
    closed = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('浏览器连接已断开')); }
    pending.clear();
  });
  const cdp: Cdp = {
    send<T>(method: string, params: Record<string, unknown> = {}) {
      if (closed) return Promise.reject(new Error('浏览器连接已断开'));
      const id = next++;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: 浏览器没有回应`)); }, timeoutMs);
        pending.set(id, { resolve: value => resolve(value as T), reject, method, timer });
        try { socket.send(JSON.stringify({ id, method, params })); }
        catch { pending.delete(id); clearTimeout(timer); reject(new Error('浏览器连接已断开')); }
      });
    },
    on(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close() { try { socket.close(); } catch { /* already closed */ } },
    get closed() { return closed; },
  };
  return new Promise((resolve, reject) => {
    const fail = () => { clearTimeout(timer); cdp.close(); reject(new Error('连不上浏览器的调试端口')); };
    const timer = setTimeout(fail, timeoutMs);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(cdp); }, { once: true });
    socket.addEventListener('error', fail, { once: true });
  });
}

export interface Target { id: string; type: string; url: string; title: string; webSocketDebuggerUrl: string }

export async function pageTargets(port: number, fetchImpl: typeof fetch = fetch): Promise<Target[]> {
  const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`读不到浏览器的标签页（HTTP ${response.status}）`);
  return (await response.json() as Target[]).filter(target => target.type === 'page' && target.webSocketDebuggerUrl);
}

/** Chromium 111+ takes only PUT here. */
export async function newTarget(port: number, url = 'about:blank', fetchImpl: typeof fetch = fetch): Promise<Target> {
  const response = await fetchImpl(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`开不了新标签页（HTTP ${response.status}）`);
  return await response.json() as Target;
}

/** Closing a tab is best-effort cleanup, so a failure is deliberately not reported. */
export async function closeTarget(port: number, id: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await fetchImpl(`http://127.0.0.1:${port}/json/close/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(3000) }).catch(() => undefined);
}
