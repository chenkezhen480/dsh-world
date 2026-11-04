import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { readPersona, renderPersona } from './persona.ts';
import { renderSelf } from './self.ts';
import { belongsToWorld, inWorld } from './sourceArchive.ts';
import type { WorldConfig } from './types.ts';
import { readTemplate, renderWorldPrompt, type WorldNames, type WorldPrompt } from './worldPrompt.ts';
import { reassembleOnChange } from './worldScope.ts';

export interface WorldPromptSource {
  prompt: WorldPrompt; isHome(sessionId: string): boolean; archiveSession?(sessionId: string): boolean;
  /** Resolved with the saved prompt text, so renaming does not change an existing cached prefix. */
  names?(): WorldNames;
  /** Her room's workspace; her world (all but the persona) reaches only its sessions. Absent, every session of hers. */
  inWorkspace?(sessionId: string): boolean;
  /** Long-term memory; its two tools are registered on world sessions. */
  memory?: import('./memory.ts').MemoryService;
}
interface PromptText { template: string; self?: { file: string; text: string }; persona: string; names: WorldNames }
/** `active`: the world prompt is placed (the session is in her workspace); the persona is placed either way. */
interface Entry { text: PromptText; active: boolean; dispose: () => void; persona?: () => void }
/** The stock "You are an AI agent powered by DeepSeek Harness." line; a section of the same name on her agent shadows it. */
const HARNESS_IDENTITY = 'harness:identity';

/**
 * Her persona and the world prompt both reach only sessions of her preset inside the world's workspace, and come and
 * go together as a session enters or leaves it: the preset alone is DSH's default `standard` for most setups, so it
 * would turn every unrelated session into her (#37). Both are sections of the session's system prompt so she sees them on every
 * request. They are read when the session opens and again after each successful compaction (the host assembles
 * the system prompt before pre-step, so the refresh happens on compaction/end), when a cold session speaks again
 * (`coldHours` in `runtime.ts`, on turn/start) or on explicit console application, so the prompt stays in the provider-cached prefix. Whether the session is her home is asked per request.
 *
 * Her persona takes the place of DeepSeek Harness's stock identity line, but never of a persona someone has set: it is its own
 * section placed right after the host's persona slot, so a system persona the deployment or her preset already has stays
 * where it is and hers follows it.
 */
export function createPromptSections(config: WorldConfig, world: WorldPromptSource, deps: { logger: { warn(...args: unknown[]): void } }) {
  const entries = new Map<Agent, Entry>();
  const agents = new WeakMap<Session, Agent>();
  function read(includeWorld: boolean): PromptText {
    const persona = world.prompt.persona ? renderPersona(readPersona(world.prompt.persona)) : '';
    const names = world.names?.() ?? world.prompt.names;
    if (!includeWorld) return { template: '', persona, names };
    const template = readTemplate(world.prompt.file);
    if (template.error) deps.logger.warn(`dsh-world: ${template.error}`);
    return {
      template: template.text,
      ...(config.selfFile ? { self: { file: config.selfFile, text: renderSelf(config.selfFile) } } : {}),
      persona, names,
    };
  }
  /** Registers her persona while the session is in her workspace and she has one; drops it otherwise. */
  function placePersona(agent: Agent, entry: Entry): void {
    if (!entry.active || !entry.text.persona) { entry.persona?.(); delete entry.persona; return; }
    if (entry.persona) return;
    const prompt = agent.ctx.systemPrompt;
    const order = prompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') ?? 0;
    const text = () => entry.text.persona;
    const persona = prompt.section({ name: 'dsh-world-persona', order: order + 1, interpolate: false, text });
    // DeepSeek Harness's own identity line gives way to hers; a persona someone set in DSH sits in its own slot and is left alone.
    // If a preset already put its own words on that identity slot for this agent, they stay exactly as written.
    let identity: (() => void) | undefined;
    try { identity = prompt.section({ name: HARNESS_IDENTITY, order: prompt.getSectionOrder('HARNESS_IDENTITY'), interpolate: false, text: () => '' }); }
    catch { /* the slot is already taken for this agent */ }
    entry.persona = () => { persona(); identity?.(); };
  }
  return {
    add(agent: Agent): void {
      if (entries.has(agent) || !belongsToWorld(agent.session, config)) return;
      let disposeWorld: (() => void) | undefined;
      /** Places or removes the world prompt and her persona as the session enters or leaves her workspace; true when it did. */
      const sync = (): boolean => {
        if (inWorld(agent.session, config, world.inWorkspace) === entry.active) return false;
        entry.active = !entry.active;
        if (!entry.active) { disposeWorld?.(); disposeWorld = undefined; placePersona(agent, entry); return true; }
        entry.text = read(true);
        disposeWorld = agent.ctx.systemPrompt.section({ name: 'dsh-world', order: 50, interpolate: false, text: () => renderWorldPrompt({ ...world.prompt, names: entry.text.names }, entry.text.template, entry.text.self, world.isHome(agent.id)) });
        placePersona(agent, entry);
        return true;
      };
      const disposeSync = reassembleOnChange(agent.ctx, sync);
      const entry: Entry = { text: read(false), active: false, dispose: () => { disposeSync(); disposeWorld?.(); } };
      entries.set(agent, entry); agents.set(agent.session, agent);
      sync();
    },
    active(session: Session): boolean {
      const agent = agents.get(session);
      return !!(agent && entries.get(agent)?.active);
    },
    refresh(session: Session): void {
      const agent = agents.get(session); const entry = agent && entries.get(agent);
      if (!agent || !entry) return;
      entry.text = read(entry.active);
      placePersona(agent, entry);
    },
    clear(): void {
      for (const entry of entries.values()) for (const dispose of [entry.dispose, entry.persona]) { try { dispose?.(); } catch { /* agent scope already gone */ } }
      entries.clear();
    },
  };
}
