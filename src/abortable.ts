import { addAbortListener } from 'node:events';

export async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => {});
    signal.throwIfAborted();
  }
  let listener: ReturnType<typeof addAbortListener>;
  const aborted = new Promise<never>((_, reject) => { listener = addAbortListener(signal, () => reject(signal.reason)); });
  try { return await Promise.race([promise, aborted]); }
  finally { listener![Symbol.dispose](); }
}
