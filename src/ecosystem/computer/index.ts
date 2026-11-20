import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { Faults } from '../../faults.ts';
import type { ArchiveStore } from '../../store.ts';
import { createBrowser, type Browser } from './browser/browser.ts';
import { findBrowser } from './browser/edge.ts';
import { createAlarmFacts } from './procedures/alarm.ts';
import { createComputerRecorder } from './procedures/archive.ts';
import { createProcedureLibrary } from './procedures/library.ts';
import { computerTools } from './tools.ts';
import { createDesktop, type Desktop } from './desktop/desktop.ts';
import { createDesktopDriver, type DesktopDriver } from './desktop/driver.ts';
import { createScreen, type Screen } from './desktop/screen.ts';
import { createInbox, type Inbox } from './inbox/inbox.ts';

/** Her use of the partner's computer is built on Windows' own interfaces; the one place that says where it can run. */
export const desktopSupported = (platform: NodeJS.Platform = process.platform) => platform === 'win32';
/**
 * Why her browser or her use of the computer cannot run on this machine, in the words the console shows; nothing for
 * one that can. The console's rows and its refusals both read it, so they never disagree.
 */
export function moduleLimits(platform: NodeJS.Platform = process.platform, browser: () => string | undefined = findBrowser): { computer?: string; desktop?: string } {
  return {
    ...(browser() ? {} : { computer: '这台电脑上找不到 Edge 或 Chrome，她的浏览器要用其中一个。' }),
    ...(desktopSupported(platform) ? {} : { desktop: '她用电脑目前只支持 Windows。' }),
  };
}

/** A helper as the module uses it; only foreground mode's is started ahead of use. */
type Hands = Pick<DesktopDriver, 'call' | 'running' | 'stop'> & Partial<Pick<DesktopDriver, 'start'>>;

/**
 * Her own browser and the operations she learns with it, for her home only. The plugin knows no platform: it gives her page
 * tools; what she learns to do with them lives in `<world>/procedures/`, and her logins in `<world>/browser/`. With its own
 * switch she also uses the partner's computer, through a Windows helper in a child process (`desktop/`): in the background,
 * or, while the partner keeps foreground mode on, with the real mouse and keyboard through a helper they approved as
 * administrator. While that switch is on her inbox watches the taskbar for her too (`inbox/`), with a helper of its own.
 */
export function createComputerModule(deps: {
  worldDir: string; worldId: string; faults: Faults; store: Pick<ArchiveStore, 'commitRecords' | 'hasRecord'>; archived(sessionId: string): boolean;
  attachments(): AttachmentStore | undefined; browser?: Browser;
  platform?: NodeJS.Platform; desktopDriver?(events: (name: string) => void): Hands;
  /** Foreground mode's helper; by default the same helper started as administrator. */
  foregroundDriver?(events: (name: string) => void): Hands;
  /** Her name on the banner while she acts. */
  companion?(): string;
  /** A word into her home, at her next step or as a turn of its own: how she hears the partner stopped her between steps. */
  notice?(text: string): void;
  /** Her inbox, on with her use of the computer: programs on the taskbar that call, told to her when her home is free. */
  inbox?: { timeZone: string; tell(text: string): Promise<boolean>; ignore(): string[]; helper?(): Hands; pollMs?: number };
}) {
  const token = randomUUID();
  const library = createProcedureLibrary(join(deps.worldDir, 'procedures'), { faults: deps.faults });
  const browser = deps.browser ?? createBrowser({ profileDir: join(deps.worldDir, 'browser'), faults: deps.faults });
  const recorder = createComputerRecorder({ store: deps.store, worldId: deps.worldId, archived: deps.archived });
  let desktopUse: { driver: Hands; desktop: Desktop; inbox?: Pick<Inbox, 'status' | 'stop'>; foreground?: { driver: Hands; screen: Screen } } | undefined;
  const signFault = (text: string | undefined) => { if (text) deps.faults.set('desktop-sign', text); else deps.faults.clear('desktop-sign'); };
  function stopForeground(): void {
    const foreground = desktopUse?.foreground;
    if (!foreground) return;
    foreground.screen.reset(); foreground.driver.stop();
    delete desktopUse!.foreground;
  }
  // What she recorded goes with the switch, like the window she had open.
  function stopDesktop(): void { stopForeground(); desktopUse?.inbox?.stop(); desktopUse?.desktop.reset(); desktopUse?.driver.stop(); desktopUse = undefined; deps.faults.clear('desktop-sign'); }
  /** The partner pressed stop on the sign. A step that was cut off tells her itself; otherwise she is told here. */
  function stopped(): void {
    if (!desktopUse) return;
    const back = desktopUse.desktop.halt(), front = desktopUse.foreground?.screen.halt();
    const cut = back.cut || front?.cut === true, recording = back.recording || front?.recording === true;
    if (cut) return;
    deps.notice?.(`（伙伴刚才按了停下：在伙伴再跟你说话之前，不能再操作伙伴的电脑。${recording ? '正在录的那一段停在了按下的地方，录到的还能用 desktop review 看。' : ''}先问问伙伴。）`);
  }
  /** What a helper says it saw happen; the sign's stop is the one thing either helper reports. */
  const events = (name: string) => { if (name === 'stop') stopped(); };
  const windows = () => desktopSupported(deps.platform);
  /** The taskbar is watched with a helper of its own, so a slow look never holds up a step she takes. */
  function startInbox(options: NonNullable<typeof deps.inbox>): Pick<Inbox, 'status' | 'stop'> {
    const helper = options.helper?.() ?? createDesktopDriver({ faults: deps.faults, as: { fault: 'inbox-helper', name: '信箱的助手', stopped: '信箱停了' } });
    const inbox = createInbox({ helper, faults: deps.faults, timeZone: options.timeZone, tell: options.tell, ignore: options.ignore, ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }) });
    inbox.start();
    return { status: () => inbox.status(), stop: () => { inbox.stop(); helper.stop(); } };
  }
  return {
    tools: (agent: Agent) => computerTools({
      agent, browser, library, recorder, attachments: deps.attachments,
      ...(desktopUse ? { desktop: desktopUse.desktop } : {}), ...(desktopUse?.foreground ? { screen: desktopUse.foreground.screen } : {}),
    }),
    // Per instance: after off and on the registry must replace the tools of the stopped module. Her operations no longer
    // change the list; only her desktop switch does.
    revision: () => `${token}${desktopUse ? '|desktop' : ''}${desktopUse?.foreground ? '|foreground' : ''}`,
    desktopOn: () => desktopUse !== undefined,
    foregroundOn: () => desktopUse?.foreground !== undefined,
    /** The partner spoke to her: a stop they pressed is lifted. */
    partnerSpoke: () => { desktopUse?.desktop.release(); desktopUse?.foreground?.screen.release(); },
    /** Her use of the partner's computer, on or off; the driver itself starts only when she first acts. */
    setDesktop(on: boolean): void {
      if (!on) { stopDesktop(); deps.faults.clear('desktop'); return; }
      if (desktopUse) return;
      if (!windows()) { deps.faults.set('desktop', '她用电脑目前只支持 Windows'); return; }
      const driver = deps.desktopDriver?.(events) ?? createDesktopDriver({ faults: deps.faults, events });
      const desktop = createDesktop({ driver, ...(deps.companion ? { companion: deps.companion } : {}), signFault });
      desktopUse = { driver, desktop, ...(deps.inbox ? { inbox: startInbox(deps.inbox) } : {}) };
      deps.faults.clear('desktop');
    },
    /**
     * Foreground mode, on top of her use of the computer: turning it on asks the partner, through UAC, to let a helper
     * run as administrator, and her desktop tool works the whole screen until it is turned off or DSH restarts. Nothing
     * keeps it across a restart, so each time it is on the partner has approved it. Returns why it could not, or nothing.
     */
    async setForeground(on: boolean): Promise<string | undefined> {
      if (!on) { stopForeground(); return undefined; }
      if (!desktopUse) return '先打开「她用电脑」';
      if (desktopUse.foreground) return undefined;
      const driver = deps.foregroundDriver?.(events) ?? createDesktopDriver({ faults: deps.faults, events, elevated: true });
      try { await driver.start?.(); }
      catch (error) { driver.stop(); return error instanceof Error ? error.message : String(error); }
      if (!desktopUse) { driver.stop(); return '她用电脑已经关掉了'; }
      desktopUse.foreground = { driver, screen: createScreen({ hands: driver, eyes: desktopUse.driver, ...(deps.companion ? { companion: deps.companion } : {}), signFault }) };
      return undefined;
    },
    alarmFacts: createAlarmFacts({ library, browser }),
    status: () => ({
      browser: browser.status(), dir: library.dir,
      categories: library.categories().map(({ name, guide }) => ({
        name, guide: guide.trim() !== '',
        operations: library.list().filter(entry => entry.procedure.category === name).map(({ procedure, path }) => ({ name: procedure.name, description: procedure.description, onAlarm: procedure.onAlarm === true, last: library.lastRun(path) ?? null })),
      })),
      desktop: desktopUse ? { running: desktopUse.driver.running(), foreground: desktopUse.foreground !== undefined, recent: (desktopUse.foreground?.screen ?? desktopUse.desktop).recent().slice(0, 5) } : null,
      inbox: desktopUse?.inbox?.status() ?? null,
    }),
    show: () => browser.show(),
    stop: () => { browser.stop(); stopDesktop(); library.clearFaults(); deps.faults.clear('computer', 'desktop'); },
  };
}
export type ComputerModule = ReturnType<typeof createComputerModule>;
