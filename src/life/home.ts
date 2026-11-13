import { mkdirSync } from 'node:fs';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { errorText, type Faults } from '../faults.ts';
import { admit, type InWorld } from '../worldScope.ts';
import type { HostWorkspace, LifeHost } from './host.ts';

export interface HomeDeps {
  host: LifeHost;
  roomDir: string;
  agentPreset: string;
  title: string;
  /** The title of her room as a workspace. */
  roomTitle: string;
  faults: Faults;
  logger: { error(...args: unknown[]): void };
  /** The recorded home, if any. */
  current(): string | undefined;
  /** Records a newly built home before anything else can fail, so a retry reuses it instead of building another. */
  moveIn(sessionId: string): void;
  /** Called with the home every time it is opened. */
  opened(agent: Agent): void;
  stopped(): boolean;
  /** Her world; a home outside it is never opened. */
  inWorld?: InWorld;
}

/**
 * Her home session: the recorded one while it exists and is not archived, otherwise a new one.
 * Her world lives only in her room's workspace, so the home is built in it, or moved into it, or not opened at all.
 * The title is applied when the home is built and again after its first turn, because the
 * host retitles a session from its first prompt.
 */
export function createHome(deps: HomeDeps) {
  const { host, faults } = deps;
  let opening: Promise<Agent> | undefined;
  /** A new home whose title is not applied yet; retried on the next open. */
  let untitled: string | undefined;
  /** A new home before its first turn ends. */
  let firstTurn: string | undefined;

  function assertRunning(): void { if (deps.stopped()) throw new Error('生活线已停止'); }
  async function rename(sessionId: string): Promise<boolean> {
    try { await host.rename(sessionId, deps.title); faults.clear('rename'); return true; }
    catch (error) { faults.set('rename', `家改名失败：${errorText(error)}`); deps.logger.error(error); return false; }
  }
  async function ready(agent: Agent): Promise<Agent> {
    assertRunning();
    admit(deps.inWorld, agent);
    if (untitled === agent.id && await rename(agent.id) && untitled === agent.id) untitled = undefined;
    assertRunning();
    deps.opened(agent);
    return agent;
  }
  /** Her room as a workspace; without one there is no home (the caller reports why). */
  async function room(): Promise<HostWorkspace> {
    mkdirSync(deps.roomDir, { recursive: true });
    const workspace = await host.workspace(deps.roomDir, deps.roomTitle);
    if (!workspace) throw new Error('宿主没有工作区服务，世界只能住在房间工作区里');
    return workspace;
  }
  async function build(): Promise<Agent> {
    assertRunning();
    const workspace = await room();
    assertRunning();
    const current = deps.current();
    if (current && !host.isArchived(current)) {
      const agent = await host.resolveAgent(current);
      assertRunning();
      if (agent) {
        // A home built before her room was a workspace moves in.
        if (!workspace.sessionIds.includes(agent.id)) await workspace.attachSession(agent.id);
        return ready(agent);
      }
    }
    const sessionId = await host.createSession(deps.roomDir, deps.agentPreset, workspace.id);
    assertRunning();
    untitled = sessionId; firstTurn = sessionId;
    deps.moveIn(sessionId);
    const agent = await host.resolveAgent(sessionId);
    if (!agent) throw new Error(`dsh-world: the new home ${sessionId} cannot be resolved`);
    return ready(agent);
  }
  return {
    /** The current home, resolving or rebuilding it; one attempt at a time. */
    open(): Promise<Agent> { return opening ??= build().finally(() => { opening = undefined; }); },
    turnEnded(sessionId: string): void {
      if (firstTurn !== sessionId || deps.stopped()) return;
      firstTurn = undefined;
      void rename(sessionId).then(ok => { if (!ok && deps.current() === sessionId) untitled = sessionId; });
    },
  };
}
