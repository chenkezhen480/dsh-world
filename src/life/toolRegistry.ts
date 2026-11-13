import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-tools';
import { errorText, type Faults } from '../faults.ts';
import { registerScopedTool } from '../worldScope.ts';
import type { ToolDefinition, ToolGuard } from '@deepseek-ai/dsh-tools';

type Registration = (() => void)[];
const ALARM_TOOLS = ['plan_next', 'check_alarm', 'cancel_alarm'];
const HOME_TOOLS = ['reach_out', 'keep_photo', 'list_photos', 'forget_photo'];

/** Disposes in reverse; a disposer whose agent scope is already gone may throw and is skipped. */
function undo(list: Registration): void {
  for (const dispose of list.splice(0).reverse()) { try { dispose(); } catch { /* scope already disposed */ } }
}

/**
 * The alarm tools are held by every world session (she can set her alarm anywhere; it rings at home), with `guard`
 * checking each of its tool calls; reach_out only by the current home. `extras` are more home-only tools whose set
 * changes at run time (her own tools): they are registered again whenever their revision moves. A registration that
 * fails (a name clash) is a fault and never breaks agent creation; it registers all of a group or none. Each tool
 * refuses to run once its session leaves her world.
 */
export function createToolRegistry(deps: { faults: Faults; logger: { error(...args: unknown[]): void }; tools: (agent: Agent) => readonly ToolDefinition[]; isHome(agent: Agent): boolean; inWorld(agent: Agent): boolean; guard?: ToolGuard; extras?: { tools(agent: Agent): readonly ToolDefinition[]; revision(): string } }) {
  const alarm = new Map<Agent, Registration>();
  const home = new Map<Agent, Registration>();
  const extras = new Map<Agent, { revision: string; done: Registration }>();
  function register(agent: Agent, tools: readonly ToolDefinition[], names?: string[]): Registration {
    const done: Registration = [];
    try { for (const tool of tools) if (!names || names.includes(tool.name)) done.push(registerScopedTool(agent, tool, () => deps.inWorld(agent))); }
    catch (error) { undo(done); throw error; }
    return done;
  }
  function dropExtras(agent: Agent): void { const entry = extras.get(agent); if (entry) undo(entry.done); extras.delete(agent); }
  function forget(agent: Agent): void { alarm.delete(agent); home.delete(agent); extras.delete(agent); deps.faults.clear(`attach:${agent.id}`); }
  return {
    /** Registers what the agent is missing; true when its tool list changed. */
    attach(agent: Agent): boolean {
      let changed = false;
      try {
        const isHome = deps.isHome(agent);
        const needsAlarm = !alarm.get(agent)?.length, needsHome = isHome && !home.get(agent)?.length;
        if (needsAlarm || needsHome) {
          const tools = deps.tools(agent);
          if (needsAlarm) {
            const done = register(agent, tools, ALARM_TOOLS);
            // The world sessions' own policy comes and goes with their alarm tools.
            try { if (deps.guard) done.push(agent.ctx.tools.guard(execution => deps.inWorld(agent) ? deps.guard!(execution) : undefined)); }
            catch (error) { undo(done); throw error; }
            alarm.set(agent, done); changed = true;
          }
          if (needsHome) { home.set(agent, register(agent, tools, HOME_TOOLS)); changed = true; }
        }
        // After the fixed groups, so a failing extras source never keeps them away.
        const revision = isHome ? deps.extras?.revision() : undefined;
        if (revision !== undefined && extras.get(agent)?.revision !== revision) {
          dropExtras(agent); extras.set(agent, { revision, done: register(agent, deps.extras!.tools(agent)) }); changed = true;
        }
        deps.faults.clear(`attach:${agent.id}`);
      } catch (error) { deps.faults.set(`attach:${agent.id}`, `工具挂载失败：${errorText(error)}`); deps.logger.error(error); }
      return changed;
    },
    forget,
    /** Takes every tool away from an agent that left her world; true when it had any. */
    detach(agent: Agent): boolean {
      const lists = [alarm.get(agent), home.get(agent), extras.get(agent)?.done];
      const changed = lists.some(list => list?.length);
      for (const list of lists) if (list) undo(list);
      forget(agent);
      return changed;
    },
    /** A rebuilt home takes reach_out and her own tools from the old one. */
    releaseOldHomes(): void {
      for (const [agent, list] of home) if (!deps.isHome(agent)) undo(list);
      for (const agent of [...extras.keys()]) if (!deps.isHome(agent)) dropExtras(agent);
    },
    clear(): void {
      for (const list of [...home.values(), ...alarm.values(), ...[...extras.values()].map(entry => entry.done)]) undo(list);
      home.clear(); alarm.clear(); extras.clear();
    },
  };
}
