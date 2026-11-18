/**
 * Messages that failed to go out wait here and are tried again every few seconds for a while, so a reply that
 * lands while the socket is reconnecting (a plugin reload stops it for a moment) is not simply lost.
 */
export function createOutbox<T>(options: {
  send(item: T): Promise<void>;
  /** Called once for an item given up on: `ttl` for too long in the queue, `stop` for the channel going away. */
  dropped(item: T, reason?: 'ttl' | 'stop'): void;
  intervalMs?: number; ttlMs?: number; maxTries?: number;
}) {
  const ttlMs = options.ttlMs ?? 5 * 60_000, maxTries = options.maxTries ?? 40;
  const waiting: { item: T; tries: number; since: number }[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let flushing = false;
  async function flush(): Promise<void> {
    if (flushing) return;
    flushing = true;
    try {
      for (const entry of [...waiting]) {
        const remove = () => waiting.splice(waiting.indexOf(entry), 1);
        if (Date.now() - entry.since > ttlMs || entry.tries >= maxTries) { remove(); options.dropped(entry.item, 'ttl'); continue; }
        try { await options.send(entry.item); remove(); } catch { entry.tries += 1; }
      }
    } finally { flushing = false; }
  }
  return {
    /** Sends now; a failure is queued for later instead of thrown. True when it went out. */
    async send(item: T): Promise<boolean> {
      try { await options.send(item); return true; }
      catch { waiting.push({ item, tries: 1, since: Date.now() }); return false; }
    },
    get size() { return waiting.length; },
    start(): void {
      if (timer) return;
      timer = setInterval(() => { void flush(); }, options.intervalMs ?? 3_000);
      timer.unref?.();
    },
    /** Stopping drops what is still waiting (the channel is going away), but never silently: each one is reported. */
    stop(): void {
      if (timer) { clearInterval(timer); timer = undefined; }
      for (const entry of waiting.splice(0)) options.dropped(entry.item, 'stop');
    },
  };
}
