import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import z from '@deepseek-ai/schemastery';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { createBridge, type Bridge } from './ecosystem/bridge/bridge.ts';
import { bridgeRoute } from './ecosystem/bridge/route.ts';
import { consoleRoute, type ConsoleActions } from './console/routes.ts';
import { consoleSources } from './console/snapshot.ts';
import { errorText, Faults } from './faults.ts';
import { hostLife } from './life/host.ts';
import { createLifeStore, durableWrite } from './life/lifeStore.ts';
import { createRoutineStore } from './life/routines.ts';
import { createPhotoStore } from './life/photos.ts';
import { toastSupported, windowsToast, type Notifier } from './life/notify.ts';
import { createLifeRuntime, type LifeRuntime } from './life/runtime.ts';
import type { LifeOptions } from './life/types.ts';
import { createOutlet } from './ecosystem/shared/outlets.ts';
import { readPersona, writePersona } from './persona.ts';
import { createQqBridge, syncBridgeSessionMode, type QqBridge } from './ecosystem/qq/bridge.ts';
import { createQqSupervisor } from './ecosystem/qq/supervisor.ts';
import { qqRoute } from './ecosystem/qq/route.ts';
import { createConsoleDoors } from './ecosystem/qq/panel.ts';
import { createWorldRuntime } from './runtime.ts';
import { createArchiveStore } from './store.ts';
import type { WorldConfig } from './types.ts';
import { DEFAULT_TEMPLATE_FILE, roomTitle, worldNames } from './worldPrompt.ts';
import { createWorldSwitch } from './worldSwitch.ts';
import { createWechatModule, type WechatModule } from './ecosystem/wechat/index.ts';
import { createWechatRecorder } from './ecosystem/wechat/archive.ts';
import { createAdapterSupervisor, type AdapterSupervisor } from './ecosystem/wechat/supervisor.ts';
import { createChannelSessions } from './ecosystem/shared/sessions.ts';
import { createArchiveSelection } from './archiveSelection.ts';
import { belongsToWorld } from './sourceArchive.ts';

export { createWorldRuntime } from './runtime.ts';
export type { WorldConfig, ConversationRecord, ConversationTurn, ArchiveCursor } from './types.ts';
export const name = 'dsh-world';
export const inject = ['agents', 'sessions', 'sessionPersistence', 'llm'];
/** What `apply` receives: the schema below fills these defaults. */
export type Config = WorldConfig & Required<Pick<WorldConfig, 'life' | 'fallbackWakeTime' | 'outlets' | 'bridge' | 'toast' | 'allowedHosts' | 'qqBridgeDir' | 'qqBridgePort' | 'qqBridgeAutoStart' | 'qqBridgeBindHomeSession'>>;
// One companion per profile is the usual case, so it works as installed: the standard preset, a world named
// default and the system time zone, with the life line on (it needs the desktop host's services and stays off without them).
const systemTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
export const Config = z.object({
  worldId: z.string().default('default'), agentPreset: z.string().default('standard'), timeZone: z.string().default(systemTimeZone),
  companionName: z.string(), partnerName: z.string(),
  archiveScope: z.union([z.const('home').description('仅家会话'), z.const('workspace').description('家所在工作区'), z.transform(z.const('world').hidden(), () => 'workspace' as const).hidden()]).default('workspace').description('记忆归档范围，修改后重启生效'),
  life: z.boolean().default(true), diaryDir: z.string(), fallbackWakeTime: z.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).default('09:00'),
  selfFile: z.string(), worldPromptFile: z.string(), alarmTemplateFile: z.string(), personaFile: z.string(),
  // Where her words go outside DSH; no app is known by name (see README for the push body).
  outlets: z.array(z.object({ name: z.string().required(), url: z.string(), urlFile: z.string(), path: z.string(), kinds: z.array(z.union([z.const('reply'), z.const('busy'), z.const('reach')])) })).default([]),
  // A local app may hand her partner's words to her home through POST /dsh-world/bridge/say.
  bridge: z.boolean().default(false),
  wechat: z.boolean().default(false),
  wechatAdapter: z.object({ python: z.string(), config: z.string() }).description('随微信模块启动和停止 Windows 适配器；写上即视为允许它发送消息'),
  toast: z.boolean().default(true),
  // The console and the bridge answer only this machine by name, plus these (a LAN address or domain behind a proxy).
  allowedHosts: z.array(z.string()).default([]),
  // QQ: her home is reachable from outside DSH through a separate `qq-bridge` process. Empty qqBridgeDir leaves
  // this whole module off; the bridge is started by hand from the console unless qqBridgeAutoStart says otherwise.
  qqBridgeDir: z.string().default(''), qqBridgePort: z.number().default(3100), qqBridgeNode: z.string(),
  qqBridgeAutoStart: z.boolean().default(false),
  // 谁和谁共用一个会话。空着就不碰桥的 config.json（尊重人自己填的）；'owner' 让每个群各自一份会话、
  // 只有主人私聊用她的家会话——这是装上之后最想要的那个，人在插件配置里说一次就够了。
  qqBridgeBindHomeSession: z.union([z.const('owner').description('群各自独立，主人私聊用她的家会话'), z.const('all').description('所有入口都用她的家会话'), z.const('none').description('谁都不绑，每个入口各建一个'), z.const('')]).default(''),
});
interface WebServer { register(route: ReturnType<typeof consoleRoute> | ReturnType<typeof bridgeRoute> | ReturnType<typeof qqRoute>): () => void }

/**
 * Her world runs only after her partner presses start in the world console, and stops when they press stop:
 * memory block, persona, world prompt, archive and life line come and go together. The switch is kept in
 * `<world>/world.json`, so it outlasts a restart.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const dshHome = resolveDshHome();
  const worldDir = join(dshHome, 'worlds', config.worldId);
  const store = createArchiveStore({ ...config, root: dshHome });
  const power = createWorldSwitch(worldDir, config.archiveScope ?? 'workspace');
  const memoryConfig = { ...config, archiveScope: power.archiveScope() };
  const faults = new Faults();
  const attachments = (() => { try { return ctx.get('attachments') as AttachmentStore | undefined; } catch { return undefined; } })();
  // Her self-description lives in her room whether or not the life line runs; she writes it with her file tools.
  const selfFile = config.selfFile || join(worldDir, 'room', '我是谁.md');
  const personaFile = config.personaFile || join(worldDir, 'persona.md');
  const worldPromptFile = config.worldPromptFile || join(worldDir, 'world-prompt.md');
  const options: LifeOptions = { worldDir, roomDir: join(worldDir, 'room'), diaryDir: config.diaryDir || join(worldDir, 'diary'), selfFile, fallbackWakeTime: config.fallbackWakeTime, timeZone: config.timeZone, alarmFile: config.alarmTemplateFile || join(worldDir, 'alarm.md') };
  /** The name in her persona comes first, then the configured one. */
  const names = () => worldNames({ ...config, companionName: readPersona(personaFile).名字 || config.companionName });
  const lifeStore = (() => {
    if (!config.life) return undefined;
    try { const current = createLifeStore(worldDir, config.timeZone); current.read(); return current; }
    catch (error) { faults.set('life', `生活线没能启动：${errorText(error)}`); ctx.logger.error(error); return undefined; }
  })();
  const routineStore = (() => { try { return createRoutineStore(worldDir, config.timeZone); } catch (error) { faults.set('routines', `习惯数据不可用：${errorText(error)}`); ctx.logger.error(error); return undefined; } })();
  const photoStore = (() => { if (!attachments) return undefined; try { return createPhotoStore(worldDir, attachments); } catch (error) { faults.set('photos', `照片索引不可用：${errorText(error)}`); ctx.logger.error(error); return undefined; } })();
  const storedHome = () => lifeStore?.read().homeSessionId;
  let isHome: (sessionId: string) => boolean = id => id === storedHome();
  const includesSession = createArchiveSelection(ctx, power.archiveScope(), id => isHome(id), options.roomDir);

  let memory: ReturnType<typeof createWorldRuntime> | undefined;
  let stopLifeLine: (() => Promise<void>) | undefined;
  async function startMemory(fresh: boolean): Promise<void> {
    if (memory) return;
    const prompt = { file: worldPromptFile, persona: personaFile, conversationsDir: join(worldDir, 'conversations'), names: names(), ...(config.life ? { life: options } : {}) };
    memory = createWorldRuntime(ctx, { ...memoryConfig, selfFile }, store, { prompt, isHome: id => isHome(id), archiveSession: includesSession }, power.memoryTurns, power.memoryTokenBudget);
    await memory.start({ fresh });
  }
  async function stopMemory(): Promise<void> {
    const running = memory; memory = undefined;
    await running?.stop();
  }
  ctx.effect(() => async () => {
    try { await stopLifeLine?.(); }
    finally { await stopMemory().finally(() => store.close()); }
  }, 'dsh-world memory line');
  if (power.running()) await startMemory(false);
  // The host's workspace service may come up after this plugin; what the first catch-up could not place is read then.
  ctx.inject(['workspaceRegistry'], injected => { void memory?.retryCatchUp().catch(error => injected.logger.error(error)); });

  // The console and the life line need the desktop host.
  ctx.inject(['sessionController', 'permissionPresets', 'webServer'], async lifeCtx => {
    const webServer = (lifeCtx as unknown as { webServer: WebServer }).webServer;
    const host = hostLife(lifeCtx);
    // QQ: one more door into her home, managed here rather than by a launcher script. The endpoint is aligned
    // on every start whether or not the bridge runs — DSH picks a new port each restart, and a stale baseUrl
    // looks exactly like a dead bridge (a dead event stream, no error, for hours). The console switch starts
    // and stops this management at any time; it does not stop a bridge that is already running.
    let qq: QqBridge | undefined;
    let qqSupervisor: ReturnType<typeof createQqSupervisor> | undefined;
    let unregisterQq: (() => void) | undefined;
    function startQq(): void {
      if (qq || !config.qqBridgeDir || !power.qqEnabled()) return;
      const service = createQqBridge({ dir: config.qqBridgeDir, port: config.qqBridgePort, nodePath: config.qqBridgeNode || process.execPath, origin: () => host.origin(), logger: lifeCtx.logger });
      qq = service;
      // 会话绑定先写：桥是启动时才读 config.json 的，这条必须在 ensureRunning/syncEndpoint 之前。
      syncBridgeSessionMode(config.qqBridgeDir, config.qqBridgeBindHomeSession, lifeCtx.logger);
      // 两个控制台的门：qq-bridge 的令牌是文件，SnowLuma 的会话令牌得用面板密码现换。
      const doors = createConsoleDoors({ worldDir, bridgeDir: config.qqBridgeDir, port: config.qqBridgePort });
      unregisterQq = webServer.register(qqRoute(service, config.allowedHosts, doors));
      void (config.qqBridgeAutoStart ? service.ensureRunning() : service.syncEndpoint()).catch(error => lifeCtx.logger.warn(error));
      // QQ 巡检：桥是独立进程，崩了、被结束、连不上 DSH 都不会有人知道——上一版只有启动时那一次
      // ensureRunning，之后再无人过问。2026-10-26 那条链路死了四个小时，就是这么来的。
      // 这里只负责「什么时候该拉」，怎么拉仍然是 bridge.ts 的事。
      qqSupervisor = createQqSupervisor({ dir: config.qqBridgeDir, port: config.qqBridgePort, bridge: service, logger: lifeCtx.logger });
      qqSupervisor.start();
    }
    function stopQq(): void {
      qqSupervisor?.stop(); qqSupervisor = undefined;
      unregisterQq?.(); unregisterQq = undefined;
      qq = undefined;
    }
    startQq();
    lifeCtx.effect(() => () => stopQq(), 'dsh-world qq');
    let life: LifeRuntime | undefined;
    let bridge: Bridge | undefined;
    let wechat: WechatModule | undefined;
    let adapter: AdapterSupervisor | undefined;
    let channels: ReturnType<typeof createChannelSessions> | undefined;
    let unregisterWechat: (() => void) | undefined;
    let lifeStop: Promise<void> | undefined;
    let wechatClosing: Promise<void> = Promise.resolve();
    /** Starts the WeChat module (its tools, route and, when configured, the adapter) against the running life line. */
    async function startWechat(current: LifeRuntime): Promise<void> {
      if (wechat || !config.wechat) return;
      await wechatClosing;
        const groupSessions = createChannelSessions({ ctx: lifeCtx, host, store, roomDir: options.roomDir, roomTitle: roomTitle(names()), agentPreset: config.agentPreset });
        channels = groupSessions;
        wechat = createWechatModule({ ctx: lifeCtx, worldId: config.worldId, acceptAgent: agent => belongsToWorld(agent.session, config), home: identity => identity.conversationType === 'group' ? groupSessions.open(identity) : current.home(), origin: () => host.origin(), file: join(worldDir, 'wechat.json'), incomingDir: join(worldDir, 'wechat-incoming'), allowedHosts: config.allowedHosts, settings: () => ({ contextMessages: power.wechatContext(), bufferSeconds: power.wechatBufferSeconds() }),
          ...createWechatRecorder(store, config.worldId, includesSession) });
        wechat.start(); unregisterWechat = webServer.register(wechat.route);
        if (config.wechatAdapter?.python && config.wechatAdapter.config) { adapter = createAdapterSupervisor({ python: config.wechatAdapter.python, config: config.wechatAdapter.config, logFile: join(worldDir, 'wechat-adapter.log'), log: message => lifeCtx.logger.warn(message) }); adapter.start(); }
    }
    /** Takes the WeChat tools, route and adapter down; the adapter goes first because it exits when the module's connection file disappears. */
    function stopWechat(): Promise<void> {
      unregisterWechat?.(); unregisterWechat = undefined;
      const closingAdapter = adapter?.stop(); adapter = undefined;
      const closing = Promise.all([closingAdapter, wechat?.stop()]).then(() => {}); wechat = undefined;
      channels?.stop(); channels = undefined;
      return wechatClosing = closing;
    }
    async function startLife(resumed: boolean): Promise<void> {
      if (!lifeStore || life) return;
      try {
        await lifeStop;
        const outlets = config.outlets.map(outlet => createOutlet(outlet, () => host.origin()));
        const notifier: Notifier = { ...(config.toast && toastSupported() ? { toast: windowsToast() } : {}), outlets };
        const current = createLifeRuntime({ ctx: lifeCtx, config: { ...config, companionName: names().companion }, options, store: lifeStore, host, notifier, dailyBudget: power.dailyBudget, ...(routineStore ? { routines: routineStore } : {}), ...(photoStore ? { photos: photoStore } : {}), ...(attachments ? { attachments } : {}) });
        life = current; isHome = current.isHome;
        if (config.bridge) { bridge = createBridge({ ctx: lifeCtx, home: () => current.home(), outlets, origin: () => host.origin(), file: join(worldDir, 'bridge.json'), name: names().companion }); bridge.start(); }
        if (config.wechat && power.wechatEnabled()) await startWechat(current);
        faults.clear('life');
        await current.start({ resumed });
      } catch (error) {
        // The console still opens and says why, instead of looking as if the life line were simply off.
        await stopLife();
        faults.set('life', `生活线没能启动：${errorText(error)}`); lifeCtx.logger.error(error);
      }
    }
    function stopLife(): Promise<void> {
      isHome = id => id === storedHome();
      bridge?.stop(); life?.stop();
      const closingWechat = stopWechat();
      bridge = undefined; life = undefined;
      return lifeStop = Promise.all([lifeStop, closingWechat]).then(() => {});
    }
    stopLifeLine = stopLife;
    lifeCtx.effect(() => () => stopLife(), 'dsh-world life line');
    // The host matches exact routes before the longest prefix, so this path never reaches the console.
    if (config.bridge) lifeCtx.effect(() => webServer.register(bridgeRoute(() => bridge, config.allowedHosts)), 'dsh-world bridge route');

    // Her album lives in her room, so the console shows it whether or not the life line is running.
    const sources = consoleSources({ ctx: lifeCtx, config: memoryConfig, archive: store, names, ...(lifeStore ? { lifeStore } : {}), ...(routineStore ? { routines: routineStore } : {}), ...(photoStore ? { photos: photoStore } : {}), life: () => life, diaryDir: options.diaryDir, running: power.running, dailyBudget: power.dailyBudget, memoryTurns: power.memoryTurns, memoryTokenBudget: power.memoryTokenBudget, selectedArchiveScope: power.selectedArchiveScope, wechat: () => wechat ? { ...wechat.status(), adapter: adapter?.status() ?? null } : undefined, includesSession, ...(config.qqBridgeDir ? { qq: async () => qq ? { ...(await qq.status()), ...(qqSupervisor ? { supervisor: qqSupervisor.snapshot() } : {}) } : null } : {}),
      modules: () => ({ wechat: { available: config.wechat, enabled: power.wechatEnabled(), running: wechat !== undefined }, qq: { available: Boolean(config.qqBridgeDir), enabled: power.qqEnabled(), running: qq !== undefined } }), faults: () => [...faults.list(), ...(memory?.faults() ?? []), ...(bridge?.faults() ?? []), ...(qq?.faults() ?? [])] });
    const actions: ConsoleActions = {
      async start() {
        if (power.running()) return;
        power.set(true);
        try { await startMemory(true); await startLife(true); } finally { sources.invalidate(); }
      },
      async stop() {
        if (!power.running()) return;
        power.set(false);
        await stopLife();
        try { await stopMemory(); } finally { sources.invalidate(); }
      },
      prompts: () => ({
        persona: readPersona(personaFile),
        worldPrompt: existsSync(worldPromptFile) ? { text: readFileSync(worldPromptFile, 'utf8'), custom: true } : { text: readFileSync(DEFAULT_TEMPLATE_FILE, 'utf8'), custom: false },
      }),
      savePersona: persona => { writePersona(personaFile, { ...readPersona(personaFile), ...persona }); sources.invalidate(); },
      setDailyBudget: yuan => { power.setDailyBudget(yuan); sources.invalidate(); },
      setMemoryTurns: turns => { power.setMemoryTurns(turns); sources.invalidate(); },
      setMemoryTokenBudget: tokens => { power.setMemoryTokenBudget(tokens); sources.invalidate(); },
      async setModules(patch) {
        if (patch.wechat !== undefined && !config.wechat) return '没有配置微信模块（配置里 wechat: true）';
        if (patch.qq !== undefined && !config.qqBridgeDir) return '没有配置 QQ 桥目录（配置里 qqBridgeDir）';
        power.setModules(patch);
        try {
          if (patch.wechat === false) await stopWechat();
          if (patch.wechat === true && life) await startWechat(life);
          if (patch.qq === false) stopQq();
          if (patch.qq === true) startQq();
        } catch (error) { faults.set('wechat', `微信模块没能切换：${errorText(error)}`); lifeCtx.logger.error(error); return `切换失败：${errorText(error)}`; }
        finally { sources.invalidate(); }
        faults.clear('wechat');
        return undefined;
      },
      restartWechatAdapter: async () => { if (!adapter) return false; try { await adapter.restart(); } finally { sources.invalidate(); } return true; },
      setWechatSettings: next => { power.setWechat(next); sources.invalidate(); },
      setRoutineEnabled: enabled => { routineStore?.setEnabled(enabled); life?.refreshRoutineTimer(); sources.invalidate(); },
      setRoutinePaused: (id, paused) => { routineStore?.pause(id, paused); life?.refreshRoutineTimer(); sources.invalidate(); },
      removeRoutine: id => { routineStore?.remove(id); life?.refreshRoutineTimer(); sources.invalidate(); },
      setArchiveScope: scope => { power.setArchiveScope(scope); sources.invalidate(); return power.restartRequired(); },
      saveWorldPrompt: text => { if (text.trim()) durableWrite(worldPromptFile, text); else rmSync(worldPromptFile, { force: true }); },
    };
    lifeCtx.effect(() => webServer.register(consoleRoute(sources, actions, config.allowedHosts)), 'dsh-world console routes');
    if (power.running()) await startLife(false);
  });
}
