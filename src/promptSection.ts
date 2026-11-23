import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt';
import { readPersona, renderPersona } from './persona.ts';
import { renderSelf } from './self.ts';
import { belongsToWorld, inWorld } from './sourceArchive.ts';
import type { WorldConfig } from './types.ts';
import { readTemplate, renderWorldPrompt, type WorldNames, type WorldPrompt } from './worldPrompt.ts';
import { syncBetweenSteps } from './worldScope.ts';

// The complete prompt uses DSH's section name, so the request guard reads ownership from the assembly context.
export const assembledWorlds = new WeakMap<AssembleContext, { worldId: string; token: symbol; text: string }>();
const promptSlots = new WeakMap<Agent, () => void>();

export interface WorldPromptSource {
  prompt: WorldPrompt; isHome(sessionId: string): boolean; archiveSession?(sessionId: string): boolean;
  /** Resolved with the persona, so a rename appears in both parts of the prompt together. */
  names?(): WorldNames;
  /** Her room's workspace; her world and persona reach only its sessions. Absent, every session of hers. */
  inWorkspace?(sessionId: string): boolean;
  /** Long-term memory; its two tools are registered on world sessions. */
  memory?: import('./memory.ts').MemoryService;
  /** News from where she is not, told to her world sessions. */
  elsewhere?: import('./elsewhere.ts').Elsewhere;
  experience?: ReturnType<typeof import('./experience/host.ts').createExperience>;
}
/** Her persona, template and 「我」 as last read for one session. */
interface Sources { persona: string; names: WorldNames; template: string; self?: { file: string; text: string } }
interface Entry { text?: string; sources?: Sources; reload: boolean; restart: boolean; disposeSync: () => void; disposePrompt?: () => void }

/** Replace the system prompt only for this world's preset and workspace. */
export function createPromptSections(config: WorldConfig, world: WorldPromptSource, token: symbol, deps: { logger: { warn(...args: unknown[]): void } }) {
  const entries = new Map<Agent, Entry>();
  const agents = new WeakMap<Session, Agent>();
  function readSources(): Sources {
    const template = readTemplate(world.prompt.file);
    if (template.error) deps.logger.warn(`dsh-world: ${template.error}`);
    return {
      persona: world.prompt.persona ? renderPersona(readPersona(world.prompt.persona)) : '',
      names: world.names?.() ?? world.prompt.names,
      template: template.text,
      ...(config.selfFile ? { self: { file: config.selfFile, text: renderSelf(config.selfFile) } } : {}),
    };
  }
  /**
   * Her files are read when the session opens or enters her workspace, and again only when `refresh` asks (after a
   * compaction, a cold session's return, or the console's apply). The prompt sits at the head of every request, so
   * re-reading it on each save would make the provider bill the whole conversation again after every edit she makes.
   */
  function render(agent: Agent, entry: Entry): string {
    if (!entry.sources || entry.reload) { entry.sources = readSources(); entry.reload = false; }
    const { persona, names, template, self } = entry.sources;
    const body = renderWorldPrompt({ ...world.prompt, names }, template, self, world.isHome(agent.id));
    return [persona, body].filter(Boolean).join('\n\n');
  }

  function sync(agent: Agent, entry: Entry): void {
    const active = inWorld(agent.session, config, world.inWorkspace);
    if (active === Boolean(entry.disposePrompt)) return;
    if (!active) { entry.disposePrompt?.(); return; }

    // A session moving between worlds can reach the new world's listener before the old one.
    promptSlots.get(agent)?.();
    const prompt = agent.ctx.systemPrompt;
    const dispose = prompt.section({
      // Shadow the preset's own persona slot. Minimal already marks that slot as complete.
      name: 'deployment:persona-prefix',
      order: prompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      complete: true,
      interpolate: false,
      text: context => {
        const text = render(agent, entry);
        assembledWorlds.set(context, { worldId: config.worldId, token, text });
        if (text !== entry.text) { entry.text = text; entry.restart = true; }
        return text;
      },
    });
    entry.restart = true;
    const release = () => {
      dispose();
      entry.restart = true;
      promptSlots.delete(agent);
      delete entry.disposePrompt;
      delete entry.sources; // read afresh when the session comes back into her workspace
    };
    entry.disposePrompt = release;
    promptSlots.set(agent, release);
  }
  function forget(agent: Agent): void {
    const entry = entries.get(agent);
    if (!entry) return;
    entry.disposeSync();
    entry.disposePrompt?.();
    entries.delete(agent);
    if (agents.get(agent.session) === agent) agents.delete(agent.session);
  }
  return {
    add(agent: Agent): void {
      if (entries.has(agent) || !belongsToWorld(agent.session, config)) return;
      // The host captures complete sections before assembly listeners and restores them afterwards.
      const entry: Entry = { reload: false, restart: false, disposeSync: syncBetweenSteps(agent.ctx, current => {
        if (current === agent) sync(agent, entry);
      }) };
      entries.set(agent, entry); agents.set(agent.session, agent);
      sync(agent, entry);
    },
    active(session: Session): boolean {
      const agent = agents.get(session);
      return !!(agent && entries.get(agent)?.disposePrompt);
    },
    /** On in-history routes, start a new series to replace the old prompt instead of appending to it. */
    takeRestart(session: Session): boolean {
      const agent = agents.get(session); const entry = agent && entries.get(agent);
      if (!entry?.restart) return false;
      entry.restart = false;
      return true;
    },
    /** Her files are read again at the next assembly; one that already ran keeps what it read. */
    refresh(session: Session): void {
      const agent = agents.get(session); const entry = agent && entries.get(agent);
      if (entry?.disposePrompt) entry.reload = true;
    },
    forget,
    clear(): void {
      for (const agent of entries.keys()) forget(agent);
    },
  };
}
