import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { Faults } from '../../faults.ts';
import type { ArchiveStore } from '../../store.ts';
import { createBrowser, type Browser } from './browser/browser.ts';
import { createAlarmFacts } from './procedures/alarm.ts';
import { createComputerRecorder } from './procedures/archive.ts';
import { createProcedureLibrary } from './procedures/library.ts';
import { computerTools } from './tools.ts';

/**
 * Her own browser and the tools she makes with it, for her home only. The plugin knows no platform: it gives her page
 * tools; what she learns to do with them lives in `<world>/procedures/`, and her logins in `<world>/browser/`.
 */
export function createComputerModule(deps: { worldDir: string; worldId: string; faults: Faults; store: Pick<ArchiveStore, 'commitRecords' | 'hasRecord'>; archived(sessionId: string): boolean; attachments(): AttachmentStore | undefined; browser?: Browser }) {
  const token = randomUUID();
  const library = createProcedureLibrary(join(deps.worldDir, 'procedures'), { faults: deps.faults });
  const browser = deps.browser ?? createBrowser({ profileDir: join(deps.worldDir, 'browser'), faults: deps.faults });
  const recorder = createComputerRecorder({ store: deps.store, worldId: deps.worldId, archived: deps.archived });
  return {
    tools: (agent: Agent) => computerTools({ agent, browser, library, recorder, attachments: deps.attachments }),
    // Per instance: after off and on the registry must replace the tools of the stopped module even if the files are the same.
    revision: () => `${token}|${library.revision()}`,
    alarmFacts: createAlarmFacts({ library, browser }),
    status: () => ({
      browser: browser.status(), dir: library.dir,
      procedures: library.list().map(({ procedure }) => ({ name: procedure.name, description: procedure.description, onAlarm: procedure.onAlarm === true, last: library.lastRun(procedure.name) ?? null })),
    }),
    show: () => browser.show(),
    stop: () => { browser.stop(); library.clearFaults(); deps.faults.clear('computer'); },
  };
}
export type ComputerModule = ReturnType<typeof createComputerModule>;
