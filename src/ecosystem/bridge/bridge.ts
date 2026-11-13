import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-session';
import { durableWrite } from '../../life/lifeStore.ts';
import { errorText, Faults } from '../../faults.ts';
import { realTimers, type LifeTimers } from '../../life/alarmTimer.ts';
import { busyText, pushOf, type Outlet, type Push, type PushKind } from '../shared/outlets.ts';
import { admit, type InWorld } from '../../worldScope.ts';

export const bridgePaths = (prefix: string) => ({ sayPath: prefix + '/bridge/say', compactPath: prefix + '/bridge/compact' });
export const REPLY_TIMEOUT_MS = 3 * 60_000;
/** The words could not be handed to her home; the route answers 503. */
export class HomeUnavailable extends Error {}
export interface BridgeDeps {
  ctx: Context;
  prefix: string;
  /** The current home, resolving or rebuilding it (the life line's own). */
  home(): Promise<Agent>;
  inWorld?: InWorld;
  /** Where her replies and the busy notice go; each takes the kinds it lists. */
  outlets: readonly Outlet[];
  origin(): string;
  /** `<world>/bridge.json`, where a local app finds the bridge. */
  file: string;
  timers?: LifeTimers;
  clock?: () => Date;
  /** Her name, in the busy notice and the console's faults; TA when unnamed. */
  name?: string;
}
interface Tracked { id: string; sessionId: string; admitted: boolean; finalText?: string; timer?: unknown }
const labels = (name: string): Record<PushKind, string> => ({ reply: `${name}的回复`, busy: `「${name}在忙」`, reach: `${name}找你的话` });

/**
 * A local app's way into her home: its words arrive as her partner's own (source `user`). The final
 * reply after admission goes to the outlets when that turn completes. Only the latest words are tracked.
 */
export function createBridge(deps: BridgeDeps) {
  const { ctx } = deps;
  const name = deps.name ?? 'TA';
  const clock = deps.clock ?? (() => new Date());
  const timers = deps.timers ?? realTimers;
  const faults = new Faults();
  const disposers: (() => void)[] = [];
  const token = randomBytes(32).toString('hex');
  let tracked: Tracked | undefined;
  let stopped = false;

  function send(push: Push): void {
    for (const outlet of deps.outlets) {
      if (!outlet.kinds.includes(push.kind)) continue;
      const key = `push:${outlet.name}`;
      void outlet.send(push).then(() => faults.clear(key), error => {
        if (stopped) return;
        faults.set(key, `${outlet.name}没收到${labels(name)[push.kind]}：${errorText(error)}`);
        ctx.logger.warn(`dsh-world: the push to ${outlet.name} failed:`, error);
      });
    }
  }
  function untrack(): void {
    if (tracked?.timer !== undefined) timers.clear(tracked.timer);
    tracked = undefined;
  }
  function track(id: string, sessionId: string): void {
    untrack();
    const entry: Tracked = { id, sessionId, admitted: false };
    // The reply stays tracked after "busy": it is still pushed when it comes.
    entry.timer = timers.set(() => { entry.timer = undefined; if (tracked === entry && !stopped) send({ text: busyText(name), kind: 'busy', name }); }, REPLY_TIMEOUT_MS);
    tracked = entry;
  }
  function start(): void {
    disposers.push(ctx.on('session/event', (session, event) => {
      if (!tracked || session.id !== tracked.sessionId) return;
      if (event.type === 'user/message') {
        if (event.data.id === tracked.id) tracked.admitted = true;
        else if (tracked.admitted && event.data.source.kind === 'user') untrack();
        return;
      }
      if (!tracked.admitted) return;
      if (event.type === 'assistant/message') {
        const { content } = event.data.message;
        // Text accompanying a tool call can be narration, including when the tool itself ends the turn.
        tracked.finalText = content.some(block => block.type === 'tool-call') ? undefined
          : content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
      }
      // The next turn end in this session closes the turn that admitted the words, even when steered in.
      if (event.type === 'turn/end') {
        const { finalText } = tracked;
        untrack();
        if (event.data.reason.kind !== 'completed' || !finalText) return;
        const reply = pushOf(finalText, 'reply', name, safeOrigin());
        if (reply.text || reply.images) send(reply);
      }
    }));
    try {
      durableWrite(deps.file, JSON.stringify({ origin: deps.origin(), ...bridgePaths(deps.prefix), token, pid: process.pid, startedAt: clock().toISOString(), name }, null, 2));
      faults.clear('file');
    } catch (error) { faults.set('file', `bridge.json 没能写入，外面的程序找不到家：${errorText(error)}`); ctx.logger.error(error); }
  }
  function safeOrigin(): string | undefined { try { return deps.origin(); } catch { return undefined; } }
  function stop(): void {
    if (stopped) return;
    stopped = true;
    untrack();
    for (const dispose of disposers.splice(0).reverse()) dispose();
    // A newer start (a reload) may already have written its own token; that file is not ours to remove.
    try { if (JSON.parse(readFileSync(deps.file, 'utf8')).token === token) rmSync(deps.file, { force: true }); } catch { /* gone or unreadable */ }
  }
  function checkToken(value: string | undefined): boolean {
    if (typeof value !== 'string') return false;
    const given = Buffer.from(value); const expected = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
  async function say(text: string): Promise<{ id: string }> {
    if (stopped) throw new HomeUnavailable('the bridge is stopped');
    let agent: Agent;
    try { agent = await deps.home(); }
    catch (error) { faults.set('home', `从外面送来的话没进家：${errorText(error)}`); ctx.logger.error(error); throw new HomeUnavailable(errorText(error), { cause: error }); }
    if (stopped) throw new HomeUnavailable('the bridge is stopped');
    const words = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
    // Tracked first: steering can admit the words before it returns.
    track(words.id, agent.id);
    try {
      admit(deps.inWorld, agent);
      // Like her partner typing in the home: into the running turn at its next step, or a new turn.
      if (agent.status === 'running') agent.steer(words); else agent.followup(words);
    } catch (error) {
      untrack();
      faults.set('home', `从外面送来的话没进家：${errorText(error)}`); ctx.logger.error(error);
      throw new HomeUnavailable(errorText(error), { cause: error });
    }
    faults.clear('home');
    return { id: words.id };
  }
  return { start, stop, say, checkToken, faults: () => faults.list() };
}
export type Bridge = ReturnType<typeof createBridge>;
