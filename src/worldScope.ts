import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';

/**
 * Her world and persona reach only her preset's sessions in her room's workspace. A
 * session can join or leave the workspace at any time, so every way in checks again where it matters: before an
 * injection, after every wait, and when a tool runs.
 */
export type InWorld = (session: Session) => boolean;

export class OutsideWorldError extends Error {
  constructor() { super('会话不在世界工作区内'); this.name = 'OutsideWorldError'; }
}

/** The agent, if it is (still) in her world; without a predicate every agent is. */
export function admit(inWorld: InWorld | undefined, agent: Agent): Agent {
  if (inWorld && !inWorld(agent.session)) throw new OutsideWorldError();
  return agent;
}

/** The same scope check controls step admission and execution; older hosts ignore the registration condition. */
export function registerScopedTool(agent: Agent, tool: ToolDefinition, inside: () => boolean, left?: () => void): () => void {
  const register: (definition: ToolDefinition, options?: { when(): boolean }) => () => void = agent.ctx.tools.register.bind(agent.ctx.tools);
  return register({ ...tool, execute: (args, exec) => {
    if (!inside()) { left?.(); throw new OutsideWorldError(); }
    return tool.execute(args, exec);
  } }, { when: inside });
}

export function syncBetweenSteps(ctx: Context, sync: (agent: Agent) => void): () => void {
  return ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/start' && event.type !== 'step/end') return;
    const agent = ctx.get('agents')?.get(session.id);
    if (agent) sync(agent);
  });
}

/** DSH 0.2.2 selects tools before prompt assembly. Check again during assembly for late changes. */
export function reassembleOnChange(ctx: Context, sync: (agent: Agent) => boolean): () => void {
  const beforeStep = syncBetweenSteps(ctx, sync);
  const assemble = ctx.on('system-prompt/assemble', (_assembly, context, next) => context.agent && sync(context.agent) ? context.agent.ctx.systemPrompt.assemble(context) : next());
  return () => { beforeStep(); assemble(); };
}
