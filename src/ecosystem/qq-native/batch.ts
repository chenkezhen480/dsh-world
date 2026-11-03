/**
 * Messages of one conversation that arrive close together are asked as one: people send two or three lines in a
 * row, and asking her each half sentence on its own costs a turn apiece. The quiet window restarts with every
 * message but never stretches past `maxMs` from the first, so a busy group still gets its answer.
 */
/** The longest a batch waits from its first message, so a quiet window past it changes nothing. */
export const MAX_BATCH_MS = 30_000;
export function createBatcher<T>(options: { quietMs(): number; maxMs?: number; flush(key: string, items: T[]): void }) {
  const maxMs = options.maxMs ?? MAX_BATCH_MS;
  const open = new Map<string, { items: T[]; since: number; timer?: ReturnType<typeof setTimeout> }>();
  return {
    add(key: string, item: T): void {
      const now = Date.now();
      const batch = open.get(key) ?? { items: [], since: now };
      batch.items.push(item);
      clearTimeout(batch.timer);
      batch.timer = setTimeout(() => { open.delete(key); options.flush(key, batch.items); }, Math.max(0, Math.min(options.quietMs(), maxMs - (now - batch.since))));
      open.set(key, batch);
    },
    /** Conversations with words still gathering. */
    get size() { return open.size; },
    clear(): void { for (const batch of open.values()) clearTimeout(batch.timer); open.clear(); },
  };
}
