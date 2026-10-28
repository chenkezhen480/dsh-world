import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-tools';
import { errorText, type Faults } from '../faults.ts';
import type { lifeTools } from './tools.ts';

type Registration = (() => void)[];
const ALARM_TOOLS = ['plan_next', 'check_alarm', 'cancel_alarm'];
const HOME_TOOLS = ['reach_out', 'search_diary', 'read_diary', 'search_self', 'compare_self', 'routine_add', 'routine_list', 'routine_update', 'routine_pause', 'routine_remove', 'routine_handle', 'keep_photo', 'list_photos', 'forget_photo'];

/** Disposes in reverse; a disposer whose agent scope is already gone may throw and is skipped. */
function undo(list: Registration): void {
  for (const dispose of list.splice(0).reverse()) { try { dispose(); } catch { /* scope already disposed */ } }
}

/**
 * The alarm tools are held by every world session (she can set her alarm anywhere; it rings at home);
 * reach_out only by the current home. A registration that fails (a name clash) is a fault and never breaks
 * agent creation; it registers all of a group or none.
 */
export function createToolRegistry(deps: { faults: Faults; logger: { error(...args: unknown[]): void }; tools: () => ReturnType<typeof lifeTools>; isHome(agent: Agent): boolean }) {
  const alarm = new Map<Agent, Registration>();
  const home = new Map<Agent, Registration>();
  function register(agent: Agent, tools: ReturnType<typeof lifeTools>, names: string[]): Registration {
    const done: Registration = [];
    try { for (const tool of tools) if (names.includes(tool.name)) done.push(agent.ctx.tools.register(tool)); }
    catch (error) { undo(done); throw error; }
    return done;
  }
  return {
    attach(agent: Agent): void {
      const needsAlarm = !alarm.get(agent)?.length, needsHome = deps.isHome(agent) && !home.get(agent)?.length;
      if (!needsAlarm && !needsHome) return;
      try {
        const tools = deps.tools();
        if (needsAlarm) alarm.set(agent, register(agent, tools, ALARM_TOOLS));
        if (needsHome) home.set(agent, register(agent, tools, HOME_TOOLS));
        deps.faults.clear(`attach:${agent.id}`);
      } catch (error) { deps.faults.set(`attach:${agent.id}`, `工具挂载失败：${errorText(error)}`); deps.logger.error(error); }
    },
    forget(agent: Agent): void { alarm.delete(agent); home.delete(agent); deps.faults.clear(`attach:${agent.id}`); },
    /** A rebuilt home takes reach_out from the old one. */
    releaseOldHomes(): void { for (const [agent, list] of home) if (!deps.isHome(agent)) undo(list); },
    clear(): void {
      for (const list of [...home.values(), ...alarm.values()]) undo(list);
      home.clear(); alarm.clear();
    },
  };
}
