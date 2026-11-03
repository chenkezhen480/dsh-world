import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-tools';
import { errorText, type Faults } from '../faults.ts';
import { scopedTool } from '../worldScope.ts';
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
 * checking each of its tool calls; reach_out only by the current home. A registration that fails (a name clash) is a fault and never breaks
 * agent creation; it registers all of a group or none. Each tool refuses to run once its session leaves her world.
 */
export function createToolRegistry(deps: { faults: Faults; logger: { error(...args: unknown[]): void }; tools: (agent: Agent) => readonly ToolDefinition[]; isHome(agent: Agent): boolean; inWorld(agent: Agent): boolean; guard?: ToolGuard }) {
  const alarm = new Map<Agent, Registration>();
  const home = new Map<Agent, Registration>();
  function register(agent: Agent, tools: readonly ToolDefinition[], names: string[]): Registration {
    const done: Registration = [];
    try { for (const tool of tools) if (names.includes(tool.name)) done.push(agent.ctx.tools.register(scopedTool(tool, () => deps.inWorld(agent)))); }
    catch (error) { undo(done); throw error; }
    return done;
  }
  function forget(agent: Agent): void { alarm.delete(agent); home.delete(agent); deps.faults.clear(`attach:${agent.id}`); }
  return {
    /** Registers what the agent is missing; true when its tool list changed. */
    attach(agent: Agent): boolean {
      const needsAlarm = !alarm.get(agent)?.length, needsHome = deps.isHome(agent) && !home.get(agent)?.length;
      if (!needsAlarm && !needsHome) return false;
      let changed = false;
      try {
        const tools = deps.tools(agent);
        if (needsAlarm) {
          const done = register(agent, tools, ALARM_TOOLS);
          // The world sessions' own policy comes and goes with their alarm tools.
          try { if (deps.guard) done.push(agent.ctx.tools.guard(execution => deps.inWorld(agent) ? deps.guard!(execution) : undefined)); }
          catch (error) { undo(done); throw error; }
          alarm.set(agent, done); changed = true;
        }
        if (needsHome) { home.set(agent, register(agent, tools, HOME_TOOLS)); changed = true; }
        deps.faults.clear(`attach:${agent.id}`);
      } catch (error) { deps.faults.set(`attach:${agent.id}`, `工具挂载失败：${errorText(error)}`); deps.logger.error(error); }
      return changed;
    },
    forget,
    /** Takes every tool away from an agent that left her world; true when it had any. */
    detach(agent: Agent): boolean {
      const lists = [alarm.get(agent), home.get(agent)];
      const changed = lists.some(list => list?.length);
      for (const list of lists) if (list) undo(list);
      forget(agent);
      return changed;
    },
    /** A rebuilt home takes reach_out from the old one. */
    releaseOldHomes(): void { for (const [agent, list] of home) if (!deps.isHome(agent)) undo(list); },
    clear(): void {
      for (const list of [...home.values(), ...alarm.values()]) undo(list);
      home.clear(); alarm.clear();
    },
  };
}
