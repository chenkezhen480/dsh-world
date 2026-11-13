import { statSync } from 'node:fs';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt';
import { readPersona, renderPersona } from './persona.ts';
import { renderSelf } from './self.ts';
import { belongsToWorld, inWorld } from './sourceArchive.ts';
import type { WorldConfig } from './types.ts';
import { DEFAULT_TEMPLATE_FILE, readTemplate, renderWorldPrompt, type WorldNames, type WorldPrompt } from './worldPrompt.ts';
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
}
interface Entry { text?: string; restart: boolean; disposeSync: () => void; disposePrompt?: () => void }

function cachePromptFile<T>(file: string | undefined, read: () => T): (force?: boolean) => T {
  let cached: { version: string; value: T } | undefined;
  return force => {
    let version = '';
    try {
      const stat = file ? statSync(file, { throwIfNoEntry: false }) : undefined;
      if (stat) version = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch { cached = undefined; return read(); }
    if (!force && cached?.version === version) return cached.value;
    const value = read();
    cached = { version, value };
    return value;
  };
}

/** Replace the system prompt only for this world's preset and workspace. */
export function createPromptSections(config: WorldConfig, world: WorldPromptSource, token: symbol, deps: { logger: { warn(...args: unknown[]): void } }) {
  const entries = new Map<Agent, Entry>();
  const agents = new WeakMap<Session, Agent>();
  const persona = cachePromptFile(world.prompt.persona, () => ({
    persona: world.prompt.persona ? renderPersona(readPersona(world.prompt.persona)) : '',
    names: world.names?.() ?? world.prompt.names,
  }));
  const template = cachePromptFile(world.prompt.file ?? DEFAULT_TEMPLATE_FILE, () => {
    const template = readTemplate(world.prompt.file);
    if (template.error) deps.logger.warn(`dsh-world: ${template.error}`);
    return template.text;
  });
  const self = cachePromptFile(config.selfFile, () => config.selfFile ? { file: config.selfFile, text: renderSelf(config.selfFile) } : undefined);
  let forceRead = false;
  function render(agent: Agent): string {
    const force = forceRead;
    forceRead = false;
    const card = persona(force);
    const body = renderWorldPrompt({ ...world.prompt, names: card.names }, template(force), self(force), world.isHome(agent.id));
    return [card.persona, body].filter(Boolean).join('\n\n');
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
        const text = render(agent);
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
      const entry: Entry = { restart: false, disposeSync: syncBetweenSteps(agent.ctx, current => {
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
    refresh(session: Session): void {
      const agent = agents.get(session);
      // A compaction can finish after the current step assembled its prompt.
      if (agent && entries.get(agent)?.disposePrompt) forceRead = true;
    },
    forget,
    clear(): void {
      for (const agent of entries.keys()) forget(agent);
    },
  };
}
