import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { lastAssistantStreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-session';
import { realTimers, type LifeTimers } from '../../life/alarmTimer.ts';
import { admit, type InWorld } from '../../worldScope.ts';
import '../../hostContract.ts';

/**
 * A channel's requests, one at a time: each gets a `cancelled` promise that rejects when it runs out of time or the
 * channel stops, and the queue refuses more than `limit` waiting at once.
 */
export function createChannelQueue(name: string, options: { limit: number; timeoutMs: number; timers?: LifeTimers | undefined }) {
  const timers = options.timers ?? realTimers;
  const cancellations = new Set<() => void>();
  let pending: Promise<unknown> = Promise.resolve();
  let stopped = false;
  let queued = 0;
  const stoppedError = () => new Error(`${name} module is stopped`);
  function run<T>(work: (cancelled: Promise<never>) => Promise<T>): Promise<T> {
    if (stopped) return Promise.reject(stoppedError());
    if (queued >= options.limit) return Promise.reject(new Error(`${name} request queue is full`));
    queued++;
    const result = pending.then(async () => {
      if (stopped) throw stoppedError();
      let timer: unknown;
      let cancel!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        cancel = () => reject(stoppedError());
        timer = timers.set(() => reject(new Error(`${name} home reply timed out`)), options.timeoutMs);
      });
      cancelled.catch(() => {});
      cancellations.add(cancel);
      try { return await work(cancelled); }
      finally { cancellations.delete(cancel); timers.clear(timer); }
    }).finally(() => { queued--; });
    pending = result.catch(() => {});
    return result;
  }
  return {
    run,
    get stopped() { return stopped; },
    /** Throws once the channel has stopped, for work that resumes after a wait. */
    alive(): void { if (stopped) throw stoppedError(); },
    stop(): void { stopped = true; for (const cancel of cancellations) cancel(); },
  };
}

/**
 * Hands `words` to the agent (after the optional `context`) and waits for the turn that takes them in, returning
 * what she said in it after them. That turn may be one already running (an alarm, a compaction, another door's words
 * started it, and `words` were steered in), so it is followed by order, not by number: once `words` are in, the next
 * turn end is its end. Anything the harness injects around that turn (runtime snapshot, skill catalog, recall, her
 * own alarm, history, channel context) is not someone speaking; only a real user message cuts the answer short. What
 * she had said before it answered `words` alone and is the answer; nothing after it is, since it may be meant for
 * whoever cut in, and having said nothing yet is a failure. An interrupted, truncated or unfinished turn is a failure,
 * so the caller never sends half a message. The session's log is flushed before the answer is returned.
 */
export async function askTurn(ctx: Context, agent: Agent, words: UserMessage, options: { name: string; inWorld?: InWorld | undefined; context?: UserMessage | undefined; cancelled?: Promise<never> | undefined }): Promise<string> {
  const cancelled = options.cancelled ?? new Promise<never>(() => {});
  let admitted = false, failed = false, cut = false, reply = '';
  // Enough to tell, when it fails, which way it went.
  let seen = 0, last = 'none';
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const dispose = ctx.on('session/event', (session, event) => {
    if (session.id !== agent.id || cut) return;
    seen += 1;
    if (event.type === 'turn/end') last = `end/${event.data.reason.kind}`;
    if (event.type === 'user/message') {
      if (event.data.id === words.id) admitted = true;
      else {
        last = `inject/${event.data.source.kind}`;
        if (admitted && event.data.source.kind === 'user') { cut = true; finish(); return; }
      }
    }
    if (!admitted) return;
    if (event.type === 'assistant/message') {
      last = 'reply';
      reply = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
      if (event.data.interrupted || lastAssistantStreamChunk(event.data.stream, 'finish')?.reason.kind === 'max-tokens') failed = true;
    }
    if (event.type === 'turn/end') {
      if (event.data.reason.kind !== 'completed') failed = true;
      finish();
    }
  });
  const trace = () => `事件=${seen} admitted=${admitted} failed=${failed} 最后=${last}`;
  try {
    admit(options.inWorld, agent);
    if (options.context) agent.inject(options.context);
    agent.followup(words);
    await Promise.race([finished, cancelled]).catch((error: Error) => { throw new Error(`${error.message}（${trace()}）`, { cause: error }); });
    if (!admitted || failed || (cut && !reply.trim())) throw new Error(`${options.name} home request did not finish（${trace()}）`);
  } finally { dispose(); }
  await Promise.race([ctx.sessions.flush(agent.session), cancelled]);
  return reply;
}
