import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import z from '@deepseek-ai/schemastery';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { createBridge, type Bridge } from './ecosystem/bridge/bridge.ts';
import { bridgeRoute } from './ecosystem/bridge/route.ts';
import { consoleRoute, type ConsoleActions } from './console/routes.ts';
import { consoleSources } from './console/snapshot.ts';
import { createHomeApply } from './console/homeApply.ts';
import { errorText, Faults } from './faults.ts';
import { hostLife } from './life/host.ts';
import { createLifeStore, durableWrite } from './life/lifeStore.ts';
import { toastSupported, windowsToast, type Notifier } from './life/notify.ts';
import { createLifeRuntime, type LifeRuntime } from './life/runtime.ts';
import type { LifeOptions } from './life/types.ts';
import { createOutlet } from './ecosystem/shared/outlets.ts';
import { readPersona, writePersona } from './persona.ts';
import type { QqNativeModule } from './ecosystem/qq-native/index.ts';
import { qqRoute } from './ecosystem/qq/route.ts';
import { createConsoleDoors, discoverSnowlumaHome } from './ecosystem/qq/panel.ts';
import { createWorldRuntime } from './runtime.ts';
import { createArchiveStore } from './store.ts';
import type { WorldConfig } from './types.ts';
import { DEFAULT_TEMPLATE_FILE, roomTitle, worldNames } from './worldPrompt.ts';
import { createWorldSwitch } from './worldSwitch.ts';
import { createWechatModule, type WechatModule } from './ecosystem/wechat/index.ts';
import { createWechatRecorder } from './ecosystem/wechat/archive.ts';
import { createAdapterSupervisor, type AdapterSupervisor } from './ecosystem/wechat/supervisor.ts';
import { createChannelSessions } from './ecosystem/shared/sessions.ts';
import { createArchiveSelection, createWorkspaceMembership } from './archiveSelection.ts';
import { inWorld } from './sourceArchive.ts';
import { createWorkspacePermissions } from './workspacePermissions.ts';
import { createPhotoStore, type PhotoStore } from './life/photos.ts';
import { createQqSdkInstaller, type QqSdkProfile } from './ecosystem/qq-native/sdkInstall.ts';

export { createWorldRuntime } from './runtime.ts';
export type { WorldConfig, ConversationRecord, ConversationTurn, ArchiveCursor } from './types.ts';
export const name = 'dsh-world';
export const inject = ['agents', 'sessions', 'sessionPersistence', 'llm'];
/** What `apply` receives: the schema below fills these defaults. */
export type Config = WorldConfig & Required<Pick<WorldConfig, 'life' | 'fallbackWakeTime' | 'outlets' | 'bridge' | 'toast' | 'allowedHosts'>>;
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
  qqNative: z.object({
    enabled: z.boolean().default(false),
    wsUrl: z.string().default('ws://127.0.0.1:3003'),
    accessToken: z.string().default(''),
    allowPrivate: z.array(z.string()).default([]),
    // 她自己开口（家里闹钟那一轮）的话推给谁。空着退回 allowPrivate 的第一个；白名单不止一人时一定要填。
    ownerQQ: z.string().default(''),
    allowGroups: z.array(z.string()).default([]),
    autoReply: z.boolean().default(true),
    contextMessages: z.number().default(6),
    // 同一会话这几毫秒内说的话攒成一条再问她（0 = 一条一问）。
    batchQuietMs: z.number().default(10_000),
    // 群里什么时候接话。量出来的事实是：不做这个判断的话，群里每句都会让她跑完一轮、还往群里冒一条
    // （她自己会在话里写「这句不接」，但那句话本身也发到群里了）。默认只接被叫到的。
    groupTrigger: z.union([z.const('mention').description('只接被叫到的（被 @ / 被引用她的话 / 命中关键词）'), z.const('all').description('每句都接')]).default('mention'),
    groupKeywords: z.array(z.string()).default([]),
    // 只停嘴不停耳：这个时间之前照收、照记，但不回，到点自己醒。ISO 时间，如 2026-10-28T08:00:00+08:00。
    mutedUntil: z.string().default(''),
    // SnowLuma 装在哪：控制台那扇门要去它的 config/runtime.json 拿地址与端口。空着就按 D:\SnowLuma、
    // C:\SnowLuma、~/SnowLuma 挨个认（认「里面有 config/runtime.json」这一条）。
    snowlumaHome: z.string().default(''),
    // 看门狗：通道开着时每 30 秒探一次 wsUrl 的端口，不通就把 SnowLuma 拉起来。不想让插件动手就关掉，面板上的按钮照旧能用。
    supervise: z.boolean().default(true),
    // 谁和她的家会话共用一个入口。'owner'（默认）＝群各自独立、私聊用她的家；'all'＝都用她的家；
    // 'none'＝谁都不绑，每个入口各建一个 —— 开发测试 QQ 的时候填 none，回合就不会走进步话生活的家里。
    bindHomeSession: z.union([z.const('owner').description('群各自独立，私聊用她的家会话'), z.const('all').description('都用她的家会话'), z.const('none').description('谁都不绑，每个入口各建一个'), z.const('')]).default('owner'),
    // 阳台：给这台机器上别的程序留的一条线。口令空着就由插件自己生成一条并存在世界目录里。
    bridge: z.object({
      port: z.number().default(0),
      token: z.string().default(''),
      title: z.string().default('阳台'),
      contextMessages: z.number().default(6),
    }).default({ port: 0, token: '', title: '阳台', contextMessages: 6 }),
  }).description('QQ 直接连 OneBot：不经过 qq-bridge 进程，会话与状态都由这个插件自己管'),
  wechat: z.boolean().default(false),
  wechatAdapter: z.object({ python: z.string(), config: z.string() }).description('随微信模块启动和停止 Windows 适配器；写上即视为允许它发送消息'),
  toast: z.boolean().default(true),
  toastAppId: z.string().description('系统通知用的 AppUserModelID；不填就在开始菜单里找 DSH 桌面版'),
  // The console and the bridge answer only this machine by name, plus these (a LAN address or domain behind a proxy).
  allowedHosts: z.array(z.string()).default([]),
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
  let photoStore: PhotoStore | undefined;
  const photos = () => {
    try { photoStore ??= createPhotoStore(worldDir); faults.clear('photos'); return photoStore; }
    catch (error) { faults.set('photos', `相册打不开：${errorText(error)}`); throw error; }
  };
  ctx.effect(() => () => photoStore?.close(), 'dsh-world album');
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
  const storedHome = () => lifeStore?.read().homeSessionId;
  let isHome: (sessionId: string) => boolean = id => id === storedHome();
  /** Whose conversations her archive keeps (the home, or her whole workspace). */
  const archiveSession = createArchiveSelection(ctx, power.archiveScope(), id => isHome(id), options.roomDir);
  /** Where her world reaches: her room's workspace, and in it the sessions of her preset. */
  const inWorkspace = createWorkspaceMembership(ctx, options.roomDir);
  const inWorldSession = (session: Session) => inWorld(session, config, inWorkspace);

  let memory: ReturnType<typeof createWorldRuntime> | undefined;
  let stopLifeLine: (() => Promise<void>) | undefined;
  async function startMemory(fresh: boolean): Promise<void> {
    if (memory) return;
    const prompt = { file: worldPromptFile, persona: personaFile, conversationsDir: join(worldDir, 'conversations'), names: names(), ...(config.life ? { life: options } : {}) };
    memory = createWorldRuntime(ctx, { ...memoryConfig, selfFile }, store, { prompt, names, isHome: id => isHome(id), archiveSession, inWorkspace }, power.memoryTurns);
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
  ctx.inject(['sessionController', 'permissionPresets', 'webServer', 'llm', 'tokenMeter', 'sessions'], async lifeCtx => {
    const webServer = (lifeCtx as unknown as { webServer: WebServer }).webServer;
    const host = hostLife(lifeCtx);
    const permissions = createWorkspacePermissions(lifeCtx, options.roomDir, power);
    // QQ 的两扇门：她自己那条 OneBot 通道的状态与开关，以及 SnowLuma 的控制台。**无条件注册** —— 通道
    // 关着的时候 /native 回 null，而 SnowLuma 那扇门跟通道没关系。（这里原来还有一半是给外面那个
    // qq-bridge 进程用的，连 qqBridgeDir 一起在 2026-10-27 拆掉了。当时的教训：那条路由是注册在「有桥
    // 目录」这个分支里的，配置一摘，整片 /dsh-world/qq/* 就全 404，界面也一起没了。所以现在它不再挂在
    // 任何配置上 —— 端点先存在，功能再按需开关。）
    const doors = createConsoleDoors({ worldDir, snowlumaHome: config.qqNative?.snowlumaHome ?? '' });
    const unregisterQq = webServer.register(
      qqRoute(config.allowedHosts, doors, () => qqNative?.status() ?? null, patch => qqNative?.update(patch) ?? null),
    );
    lifeCtx.effect(() => () => unregisterQq(), 'dsh-world qq route');
    let life: LifeRuntime | undefined;
    const sdkAbort = new AbortController();
    const sdkAvailable = () => { try { import.meta.resolve('@snowluma/sdk'); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') return false; throw error; } };
    const qqSdk = createQqSdkInstaller({ available: sdkAvailable, profile: () => lifeCtx.get('profileContext') as QqSdkProfile | undefined, signal: sdkAbort.signal });
    lifeCtx.effect(() => () => sdkAbort.abort(new Error('世界插件已卸载')), 'dsh-world SDK installation');
    let qqChange = 0;
    const homeApply = createHomeApply({
      ctx: lifeCtx,
      home: async () => { if (!life) throw new Error('请先启动世界生活线'); return life.home(); },
      isHome: agent => !!life?.isHome(agent.id) && ctx.agents.get(agent.id) === agent && !host.isArchived(agent.id) && inWorldSession(agent.session),
      compaction: () => lifeCtx.get('compaction'),
      refresh: session => { if (!memory) throw new Error('世界记忆线已停止'); memory.refreshPrompt(session); },
      changed: () => sources.invalidate(),
    });
    let bridge: Bridge | undefined;
    let wechat: WechatModule | undefined;
    let qqNative: QqNativeModule | undefined;
    let qqChannels: ReturnType<typeof createChannelSessions> | undefined;
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
        wechat = createWechatModule({ ctx: lifeCtx, worldId: config.worldId, inWorld: inWorldSession, home: identity => identity.conversationType === 'group' ? groupSessions.open(identity) : current.home(), origin: () => host.origin(), file: join(worldDir, 'wechat.json'), incomingDir: join(worldDir, 'wechat-incoming'), allowedHosts: config.allowedHosts, settings: () => ({ contextMessages: power.wechatContext(), bufferSeconds: power.wechatBufferSeconds() }),
          ...createWechatRecorder(store, config.worldId, archiveSession) });
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
    /** QQ talks to her through the same home the WeChat channel uses; only the transport differs. */
    async function startQqNative(current: LifeRuntime): Promise<void> {
      const q = config.qqNative;
      if (qqNative || !q?.enabled || !power.qqEnabled()) return;
      try {
        if (qqSdk.needsRestart()) throw new Error('SDK 已安装，请重启 DSH 后启用 QQ');
        if (!sdkAvailable()) throw new Error('QQ 缺少 SnowLuma SDK，请关闭再开启 QQ，按需安装依赖');
        const { createQqNativeModule } = await import('./ecosystem/qq-native/index.ts');
        if (qqNative || life !== current || !power.running() || !power.qqEnabled()) return;
        const groupSessions = createChannelSessions({ ctx: lifeCtx, host, store, roomDir: options.roomDir, roomTitle: roomTitle(names()), agentPreset: config.agentPreset });
        qqChannels = groupSessions;
        qqNative = createQqNativeModule({
          ctx: lifeCtx,
          inWorld: inWorldSession,
          isHome: id => current.isHome(id),
          // `none` keeps private test traffic out of her real home, as groups are by default.
          home: identity => {
            const bind = q.bindHomeSession ?? 'owner';
            if (identity.conversationType === 'group') return bind === 'all' ? current.home() : groupSessions.open(identity);
            return bind === 'none' ? groupSessions.open(identity) : current.home();
          },
          logger: lifeCtx.logger,
          stateFile: join(options.roomDir, '..', 'qq-native.json'),
          config: () => ({
            enabled: q.enabled ?? false,
            wsUrl: q.wsUrl ?? 'ws://127.0.0.1:3003',
            accessToken: q.accessToken ?? '',
            allowPrivate: q.allowPrivate ?? [],
            ownerQQ: q.ownerQQ ?? '',
            allowGroups: q.allowGroups ?? [],
            autoReply: q.autoReply ?? true,
            contextMessages: q.contextMessages ?? 6,
            batchQuietMs: q.batchQuietMs ?? 10_000,
            groupTrigger: q.groupTrigger ?? 'mention',
            groupKeywords: q.groupKeywords ?? [],
            mutedUntil: q.mutedUntil ?? '',
            snowlumaHome: discoverSnowlumaHome(q.snowlumaHome ?? ''),
            supervise: q.supervise ?? true,
            bridge: {
              port: q.bridge?.port ?? 0,
              token: q.bridge?.token ?? '',
              title: q.bridge?.title ?? '阳台',
              contextMessages: q.bridge?.contextMessages ?? 6,
            },
            bindHomeSession: q.bindHomeSession ?? 'owner',
          }),
        });
        qqNative.start();
        faults.clear('qq');
      } catch (error) {
        stopQqNative();
        faults.set('qq', `QQ 模块没能启动：${errorText(error)}`); lifeCtx.logger.error(error);
      }
    }
    function stopQqNative(): void { qqNative?.stop(); qqNative = undefined; qqChannels?.stop(); qqChannels = undefined; faults.clear('qq'); }
    async function startLife(resumed: boolean): Promise<void> {
      if (!lifeStore || life) return;
      try {
        await lifeStop;
        const outlets = config.outlets.map(outlet => createOutlet(outlet, () => host.origin()));
        const notifier: Notifier = { ...(config.toast && toastSupported() ? { toast: windowsToast(config.toastAppId || undefined) } : {}), outlets };
        const current = createLifeRuntime({ ctx: lifeCtx, config: { ...config, companionName: names().companion }, options, store: lifeStore, host, notifier, dailyBudget: power.dailyBudget, inWorkspace, photos, alarmContext: now => wechat?.presence(now) });
        life = current; isHome = current.isHome;
        if (config.bridge) { bridge = createBridge({ ctx: lifeCtx, home: () => current.home(), inWorld: inWorldSession, outlets, origin: () => host.origin(), file: join(worldDir, 'bridge.json'), name: names().companion }); bridge.start(); }
        if (config.wechat && power.wechatEnabled()) await startWechat(current);
        if (config.qqNative?.enabled && power.qqEnabled()) await startQqNative(current);
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
      stopQqNative();
      bridge = undefined; life = undefined;
      return lifeStop = Promise.all([lifeStop, closingWechat, homeApply.cancel()]).then(() => {});
    }
    stopLifeLine = stopLife;
    lifeCtx.effect(() => () => stopLife(), 'dsh-world life line');
    // The host matches exact routes before the longest prefix, so this path never reaches the console.
    if (config.bridge) lifeCtx.effect(() => webServer.register(bridgeRoute(() => bridge, config.allowedHosts)), 'dsh-world bridge route');

    // Her album lives in her room, so the console shows it whether or not the life line is running.
    const sources = consoleSources({ ctx: lifeCtx, config: memoryConfig, archive: store, names, ...(lifeStore ? { lifeStore } : {}), life: () => life, homeApply: homeApply.snapshot, photos, diaryDir: options.diaryDir, running: power.running, dailyBudget: power.dailyBudget, memoryTurns: power.memoryTurns, selectedArchiveScope: power.selectedArchiveScope, workspacePermissions: permissions.snapshot, wechat: () => wechat ? { ...wechat.status(), adapter: adapter?.status() ?? null } : undefined, archiveSession, native: () => qqNative?.status() ?? null,
      modules: () => ({ wechat: { available: config.wechat, enabled: power.wechatEnabled(), running: wechat !== undefined }, qq: { available: Boolean(config.qqNative?.enabled), enabled: power.qqEnabled(), running: qqNative !== undefined, ...(qqSdk.needsRestart() ? { restartRequired: true } : {}) } }), faults: () => [...faults.list(), ...(memory?.faults() ?? []), ...(bridge?.faults() ?? [])] });
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
      applyHome: () => !power.running() || !life ? '请先启动世界生活线' : homeApply.request(),
      prompts: () => ({
        persona: readPersona(personaFile),
        worldPrompt: existsSync(worldPromptFile) ? { text: readFileSync(worldPromptFile, 'utf8'), custom: true } : { text: readFileSync(DEFAULT_TEMPLATE_FILE, 'utf8'), custom: false },
      }),
      savePersona: persona => { writePersona(personaFile, { ...readPersona(personaFile), ...persona }); sources.invalidate(); },
      setDailyBudget: yuan => { power.setDailyBudget(yuan); sources.invalidate(); },
      setMemoryTurns: turns => { power.setMemoryTurns(turns); sources.invalidate(); },
      setWorkspacePermission: permission => { permissions.set(permission); sources.invalidate(); },
      async setModules(patch) {
        if (patch.wechat !== undefined && !config.wechat) return '没有配置微信模块（配置里 wechat: true）';
        if (patch.qq !== undefined && !config.qqNative?.enabled) return '没有配置原生 QQ 通道（配置里 qqNative.enabled）';
        const change = patch.qq === undefined ? qqChange : ++qqChange;
        let restartRequired = false;
        if (patch.qq === true) {
          try { restartRequired = await qqSdk.ensure(); sdkAbort.signal.throwIfAborted(); faults.clear('qq-sdk'); }
          catch (error) { const message = `QQ 依赖安装失败：${errorText(error)}`; faults.set('qq-sdk', message); return message; }
          if (change !== qqChange) return 'QQ 开关已被更新，本次安装不会重新开启 QQ';
        }
        power.setModules(patch);
        try {
          if (patch.wechat === false) await stopWechat();
          if (patch.wechat === true && life) await startWechat(life);
          if (patch.qq === false) stopQqNative();
          if (patch.qq === true && life && !restartRequired) await startQqNative(life);
          if (patch.qq === true && life && !restartRequired && !qqNative) return 'QQ 模块没能启动，请查看健康状态';
        } catch (error) { faults.set('wechat', `微信模块没能切换：${errorText(error)}`); lifeCtx.logger.error(error); return `切换失败：${errorText(error)}`; }
        finally { sources.invalidate(); }
        faults.clear('wechat');
        if (restartRequired) return { restartRequired: true, message: 'SnowLuma SDK 已安装。请重启 DSH，QQ 会按已保存的开关启用。' };
        return undefined;
      },
      restartWechatAdapter: async () => { if (!adapter) return false; try { await adapter.restart(); } finally { sources.invalidate(); } return true; },
      setWechatSettings: next => { power.setWechat(next); sources.invalidate(); },
      setArchiveScope: scope => { power.setArchiveScope(scope); sources.invalidate(); return power.restartRequired(); },
      saveWorldPrompt: text => { if (text.trim()) durableWrite(worldPromptFile, text); else rmSync(worldPromptFile, { force: true }); },
    };
    lifeCtx.effect(() => webServer.register(consoleRoute(sources, actions, config.allowedHosts)), 'dsh-world console routes');
    if (power.running()) await startLife(false);
  });
}
