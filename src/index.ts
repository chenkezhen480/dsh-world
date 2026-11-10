import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
// DSH's HMR reconciles the profile once at every start and drops, as failed imports, the profile modules whose import
// has not finished (dsh-hmr `reconcileProfile`). The QQ module is imported later and is the only way to `ws`, a CommonJS
// package: dropped halfway, Node fails it with ERR_INTERNAL_ASSERTION and QQ switched on at boot never starts. Loaded
// with the plugin, `ws` is complete before that reconciliation runs.
import 'ws';
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import z from '@deepseek-ai/schemastery';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { createBridge, type Bridge } from './ecosystem/bridge/bridge.ts';
import { bridgeRoute, compactRoute } from './ecosystem/bridge/route.ts';
import { consoleRoute, type ConsoleActions } from './console/routes.ts';
import { consoleSources } from './console/snapshot.ts';
import { compactionFor, createHomeApply } from './console/homeApply.ts';
import { errorText, Faults } from './faults.ts';
import { repairCopiedPresets, swapCompactionOnce, swapPresetCompaction, swapStockCompaction, type ConfigEditor } from './compactionSwap.ts';
import { hostLife } from './life/host.ts';
import { createLifeStore, durableWrite } from './life/lifeStore.ts';
import { toastSupported, windowsToast, type Notifier } from './life/notify.ts';
import { createLifeRuntime, type LifeRuntime } from './life/runtime.ts';
import type { LifeOptions } from './life/types.ts';
import { createOutlet } from './ecosystem/shared/outlets.ts';
import { readPersona, writePersona } from './persona.ts';
import { MOOD_FILE } from './mood.ts';
import type { QqNativeModule } from './ecosystem/qq-native/index.ts';
import { qqRoute } from './ecosystem/qq/route.ts';
import { createConsoleDoors, discoverSnowlumaHome } from './ecosystem/qq/panel.ts';
import { createMemory } from './memory.ts';
import { createWorldRuntime, guardWorldContext } from './runtime.ts';
import { createArchiveStore } from './store.ts';
import type { WorldConfig } from './types.ts';
import { DEFAULT_TEMPLATE_FILE, MEMORY_SNIPPET_FILE, memoryTemplateGaps, roomTitle, worldNames } from './worldPrompt.ts';
import { createWorldSwitch } from './worldSwitch.ts';
import { CLOCK_TIME, DEFAULT_REVIEW_TIME } from './life/alarm.ts';
import { createWechatModule, type WechatModule } from './ecosystem/wechat/index.ts';
import { createWechatRecorder } from './ecosystem/wechat/archive.ts';
import { createAdapterSupervisor, type AdapterSupervisor } from './ecosystem/wechat/supervisor.ts';
import { createChannelSessions } from './ecosystem/shared/sessions.ts';
import { canonicalPath, createArchiveSelection, createWorkspaceMembership } from './archiveSelection.ts';
import { inWorld } from './sourceArchive.ts';
import { validWorldId, worldListRoute, worldPath } from './worldRoutes.ts';
import { createWorkspacePermissions } from './workspacePermissions.ts';
import { createPhotoStore, type PhotoStore } from './life/photos.ts';
import { createQqSdkInstaller, type QqSdkProfile } from './ecosystem/qq-native/sdkInstall.ts';

export { createWorldRuntime } from './runtime.ts';
export type { WorldConfig, ConversationRecord, ConversationTurn, ArchiveCursor } from './types.ts';
export const name = 'dsh-world';
export const inject = ['agents', 'sessions', 'sessionPersistence', 'llm'];
/** What `apply` receives: the schema below fills these defaults. */
export type Config = WorldConfig & Required<Pick<WorldConfig, 'life' | 'replaceCompaction' | 'fallbackWakeTime' | 'outlets' | 'bridge' | 'toast' | 'allowedHosts'>>;
// The installed default uses the standard preset, a world named default and the system time zone.
// The life line is on by default and needs the desktop host's services.
const systemTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
export const Config = z.object({
  worldId: z.string().default('default'), agentPreset: z.string().default('standard'), timeZone: z.string().default(systemTimeZone),
  companionName: z.string(), partnerName: z.string(),
  archiveScope: z.union([z.const('home').description('仅家会话'), z.const('workspace').description('家所在工作区'), z.transform(z.const('world').hidden(), () => 'workspace' as const).hidden()]).default('workspace').description('记忆归档范围，修改后重启生效'),
  // Install means the tool-free compaction: the first start rewrites the profile's stock compaction row (see README); false leaves it alone.
  replaceCompaction: z.boolean().default(true),
  life: z.boolean().default(true), diaryDir: z.string(), fallbackWakeTime: z.string().pattern(CLOCK_TIME).default('09:00'),
  selfFile: z.string(), worldPromptFile: z.string(), alarmTemplateFile: z.string(), personaFile: z.string(),
  // Where her words go outside DSH; no app is known by name (see README for the push body).
  outlets: z.array(z.object({ name: z.string().required(), url: z.string(), urlFile: z.string(), path: z.string(), kinds: z.array(z.union([z.const('reply'), z.const('busy'), z.const('reach')])) })).default([]),
  // A local app reads bridge.json to send words to this world's home.
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
    // 看门狗：每 30 秒探一次 wsUrl 的端口，不通且没有实例时才拉起。关掉后面板上的按钮照旧能用。
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
interface WebServer { register(route: ReturnType<typeof consoleRoute> | ReturnType<typeof bridgeRoute> | ReturnType<typeof compactRoute> | ReturnType<typeof qqRoute> | ReturnType<typeof worldListRoute>): () => void }
interface ProfileWorlds {
  rooms: Map<string, { path: string; authorize(session: Session): symbol | false | undefined }>;
  consoles: Map<string, readonly string[]>;
  profileEdits: Promise<void>;
  unregisterList?: () => void;
}

function profileWorlds(root: Context): ProfileWorlds {
  const existing = root.get('dshWorldProfile') as ProfileWorlds | undefined;
  if (existing) return existing;
  const worlds: ProfileWorlds = { rooms: new Map(), consoles: new Map(), profileEdits: Promise.resolve() };
  root.provide('dshWorldProfile', worlds);
  guardWorldContext(root, (session, worldId) => {
    if (worldId !== undefined) return worlds.rooms.get(worldId)?.authorize(session);
    for (const room of worlds.rooms.values()) {
      const token = room.authorize(session);
      if (token !== undefined) return token;
    }
  });
  return worlds;
}

/**
 * Her world runs only after her partner presses start in the world console, and stops when they press stop:
 * memory block, persona, world prompt, archive and life line come and go together. The switch is kept in
 * `<world>/world.json`, so it outlasts a restart.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const { root } = ctx;
  const { worldId } = config;
  if (!validWorldId(worldId)) throw new TypeError('dsh-world: invalid worldId');
  const worlds = profileWorlds(root);
  const dshHome = resolveDshHome();
  const worldDir = join(dshHome, 'worlds', worldId);
  const roomDir = join(worldDir, 'room');
  const prefix = worldPath(worldId);
  const roomPath = canonicalPath(roomDir);
  const dataPath = canonicalPath(worldDir);
  if ([...worlds.rooms].some(([id, room]) => id.toLowerCase() === worldId.toLowerCase() || canonicalPath(room.path) === roomPath || canonicalPath(dirname(room.path)) === dataPath)) {
    throw new Error(`dsh-world: worldId ${worldId} 与已加载的世界重复`);
  }
  const store = createArchiveStore({ ...config, root: dshHome });
  const power = createWorldSwitch(worldDir, config.archiveScope ?? 'workspace', config.fallbackWakeTime);
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
  const options: LifeOptions = { worldDir, roomDir, diaryDir: config.diaryDir || join(worldDir, 'diary'), selfFile, schedule: () => ({ review: power.reviewTime(), wake: power.wakeTime() }), timeZone: config.timeZone, alarmFile: config.alarmTemplateFile || join(worldDir, 'alarm.md') };
  /** The name in her persona comes first, then the configured one. */
  const names = () => worldNames({ ...config, companionName: readPersona(personaFile).名字 || config.companionName });
  const lifeStore = (() => {
    if (!config.life) return undefined;
    try { const current = createLifeStore(worldDir, config.timeZone); current.read(); return current; }
    catch (error) { faults.set('life', `生活线没能启动：${errorText(error)}`); ctx.logger.error(error); return undefined; }
  })();
  const storedHome = () => lifeStore?.read().homeSessionId;
  let isHome: (sessionId: string) => boolean = id => id === storedHome();
  /** Where her world reaches: her room's workspace, and in it the sessions of her preset. */
  const inWorkspace = createWorkspaceMembership(ctx, roomDir, () => Array.from(worlds.rooms.values(), room => room.path));
  const archiveSession = createArchiveSelection(power.archiveScope(), id => isHome(id), inWorkspace);
  const inWorldSession = (session: Session) => inWorld(session, config, inWorkspace);
  /** Long-term memory over the archive and her own files; the tools and the console are two doors to it. */
  const memoryService = createMemory({ store: store.memory, timeZone: config.timeZone, sources: { diaryDir: options.diaryDir }, visible: id => archiveSession(id) });

  /** What is wrong with long-term memory, in the console's health list: a source that could not be read. */
  const memoryHealth = (): string[] => memoryService.status().failures.map(failure => `记忆来源 ${failure.sourceId}：${failure.message}`);
  let memory: ReturnType<typeof createWorldRuntime> | undefined;
  let stopLifeLine: (() => Promise<void>) | undefined;
  let disposed = false;
  let lifecycle = Promise.resolve();
  const changeWorld = (change: () => Promise<void>) => lifecycle = lifecycle.then(change, change);
  /**
   * A memory line that cannot start is a fault, never a failed plugin: the console must still open to say so, and
   * the life line and channels run on. Stopping and starting the world from the console tries again.
   */
  async function startMemory(fresh: boolean): Promise<void> {
    if (memory || disposed) return;
    const prompt = { file: worldPromptFile, persona: personaFile, conversationsDir: join(worldDir, 'conversations'), names: names(), memoryTools: true, ...(config.life ? { life: options } : {}) };
    const runtime = createWorldRuntime(ctx, { ...memoryConfig, selfFile, moodFile: join(roomDir, MOOD_FILE) }, store, { prompt, names, isHome: id => isHome(id), archiveSession, inWorkspace, memory: memoryService }, power.memoryTurns, power.coldHours);
    memory = runtime;
    try { await runtime.start({ fresh }); faults.clear('memory'); }
    catch (error) { memory = undefined; faults.set('memory', `记忆线没能启动：${errorText(error)}`); ctx.logger.error(error); }
  }
  async function stopMemory(): Promise<void> {
    const running = memory; memory = undefined;
    await running?.stop();
  }
  ctx.effect(() => {
    worlds.rooms.set(worldId, {
      path: roomDir,
      authorize: session => {
        if (!inWorldSession(session)) return undefined;
        return !disposed && power.running() && memory ? memory.scopeToken : false;
      },
    });
    return () => {
      disposed = true;
      return changeWorld(async () => {
        try { await stopLifeLine?.(); }
        finally { await stopMemory().finally(() => store.close()).finally(() => worlds.rooms.delete(worldId)); }
      });
    };
  }, 'dsh-world memory line');
  if (power.running()) await changeWorld(() => startMemory(false));
  // The host's workspace service may come up after this plugin; what the first catch-up could not place is read then.
  ctx.inject(['workspaceRegistry'], injected => {
    void changeWorld(async () => { if (!disposed) await memory?.retryCatchUp(); }).catch(error => injected.logger.error(error));
  });

  // The console and the life line need the desktop host.
  ctx.inject(['sessionController', 'permissionPresets', 'webServer'], async lifeCtx => {
    const webServer = (lifeCtx as unknown as { webServer: WebServer }).webServer;
    const host = hostLife(lifeCtx);
    const configEditor = lifeCtx.get('configEditor') as ConfigEditor | undefined;
    const profileDir = () => (lifeCtx.get('profileContext') as { dir?: string } | undefined)?.dir;
    const swap = () => swapCompactionOnce({ enabled: config.replaceCompaction, profileDir: profileDir(), done: power.compactionSwapped, markDone: power.markCompactionSwapped,
      swap: async dir => { const row = swapStockCompaction(dir); return row.status === 'unchanged' && configEditor ? swapPresetCompaction(configEditor, config.agentPreset, dir) : row; },
      report: message => { faults.set('compaction-swap', message); lifeCtx.logger.warn(`dsh-world: ${message}`); } });
    const repair = async () => {
      const dir = profileDir();
      if (configEditor && dir) await repairCopiedPresets({ editor: configEditor, profileDir: dir, report: message => { faults.set('preset-repair', message); lifeCtx.logger.warn(`dsh-world: ${message}`); } });
    };
    // Different worlds may edit the same profile or preset on startup.
    const editProfile = () => worlds.profileEdits = worlds.profileEdits.then(swap, swap).then(repair, repair);
    // The preset row the editor rewrites is active only once the host has finished loading.
    const appReady = lifeCtx.get('appReady') as { onReady(listener: () => void): () => void } | undefined;
    if (!appReady) void editProfile();
    else lifeCtx.effect(() => {
      let closed = false;
      const cancel = appReady.onReady(() => { if (!closed) void editProfile(); });
      return () => { closed = true; cancel(); };
    }, 'dsh-world compaction swap');
    const permissions = createWorkspacePermissions(lifeCtx, options.roomDir, power);
    // SnowLuma 的控制台在 OneBot 通道关闭时仍可用。
    const doors = createConsoleDoors({ worldDir, snowlumaHome: config.qqNative?.snowlumaHome ?? '' });
    const unregisterQq = webServer.register(
      qqRoute(prefix, config.allowedHosts, doors, () => qqNative?.status() ?? null, patch => qqNative?.update(patch) ?? null),
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
      compaction: agent => compactionFor(lifeCtx, agent),
      refresh: session => { if (!memory) throw new Error('世界记忆线已停止'); memory.refreshPrompt(session); },
      changed: () => sources.invalidate(),
      fault: message => { if (message) faults.set('home-apply', message); else faults.clear('home-apply'); },
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
      if (wechat || life !== current || disposed || !power.running() || !power.wechatEnabled()) return;
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
        if (disposed) return;
        const outlets = config.outlets.map(outlet => createOutlet(outlet, () => host.origin()));
        const notifier: Notifier = { ...(config.toast && toastSupported() ? { toast: windowsToast(config.toastAppId || undefined) } : {}), outlets };
        const current = createLifeRuntime({ ctx: lifeCtx, config: { ...config, companionName: names().companion }, options, store: lifeStore, host, notifier, dailyBudget: power.dailyBudget, inWorkspace, photos, alarmContext: now => wechat?.presence(now), afterReview: () => { if (power.compactAfterReview()) homeApply.request(); } });
        life = current; isHome = current.isHome;
        if (config.bridge) { bridge = createBridge({ ctx: lifeCtx, prefix, home: () => current.home(), inWorld: inWorldSession, outlets, origin: () => host.origin(), file: join(worldDir, 'bridge.json'), name: names().companion }); bridge.start(); }
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
    lifeCtx.effect(() => () => changeWorld(stopLife), 'dsh-world life line');
    // The host matches exact routes before the longest prefix, so this path never reaches the console.
    if (config.bridge) lifeCtx.effect(() => webServer.register(bridgeRoute(prefix, () => bridge, config.allowedHosts)), 'dsh-world bridge route');
    if (config.bridge) lifeCtx.effect(() => webServer.register(compactRoute(prefix, () => bridge, () => !power.running() || !life ? '请先启动世界生活线' : homeApply.request(), config.allowedHosts)), 'dsh-world compact route');

    // Her album lives in her room, so the console shows it whether or not the life line is running.
    const sources = consoleSources({ ctx: lifeCtx, config: memoryConfig, archive: store, longTerm: memoryService, names, ...(lifeStore ? { lifeStore } : {}), life: () => life, homeApply: homeApply.snapshot, compactAfterReview: power.compactAfterReview, ...(config.life ? { schedule: () => ({ review: power.reviewTime(), wake: power.wakeTime(), defaults: { review: DEFAULT_REVIEW_TIME, wake: config.fallbackWakeTime } }) } : {}), photos, diaryDir: options.diaryDir, running: power.running, dailyBudget: power.dailyBudget, memoryTurns: power.memoryTurns, coldHours: power.coldHours, selectedArchiveScope: power.selectedArchiveScope, workspacePermissions: permissions.snapshot, wechat: () => wechat ? { ...wechat.status(), adapter: adapter?.status() ?? null } : undefined, archiveSession, native: () => qqNative?.status() ?? null,
      modules: () => ({ wechat: { available: config.wechat, enabled: power.wechatEnabled(), running: wechat !== undefined }, qq: { available: Boolean(config.qqNative?.enabled), enabled: power.qqEnabled(), running: qqNative !== undefined, ...(qqSdk.needsRestart() ? { restartRequired: true } : {}) } }), faults: () => [...faults.list(), ...(adapter?.status().error ? [`微信适配器：${adapter.status().error}`] : []), ...(memory?.faults() ?? []), ...(bridge?.faults() ?? []), ...memoryHealth()] });
    const actions: ConsoleActions = {
      start: () => changeWorld(async () => {
        if (disposed || power.running()) return;
        power.set(true);
        try { await startMemory(true); await startLife(true); } finally { sources.invalidate(); }
      }),
      stop: () => changeWorld(async () => {
        if (disposed || !power.running()) return;
        power.set(false);
        try { await stopLife(); }
        finally { await stopMemory().finally(() => sources.invalidate()); }
      }),
      applyHome: () => !power.running() || !life ? '请先启动世界生活线' : homeApply.request(),
      prompts: () => ({
        persona: readPersona(personaFile),
        worldPrompt: existsSync(worldPromptFile) ? (text => ({ text, custom: true, memory: { missing: memoryTemplateGaps(text), snippet: readFileSync(MEMORY_SNIPPET_FILE, 'utf8') } }))(readFileSync(worldPromptFile, 'utf8')) : { text: readFileSync(DEFAULT_TEMPLATE_FILE, 'utf8'), custom: false },
      }),
      savePersona: persona => { writePersona(personaFile, { ...readPersona(personaFile), ...persona }); sources.invalidate(); },
      setDailyBudget: yuan => { power.setDailyBudget(yuan); sources.invalidate(); },
      setMemoryTurns: turns => { power.setMemoryTurns(turns); sources.invalidate(); },
      setColdHours: hours => { power.setColdHours(hours); sources.invalidate(); },
      setWorkspacePermission: permission => { permissions.set(permission); sources.invalidate(); },
      setCompactAfterReview: on => { power.setCompactAfterReview(on); sources.invalidate(); },
      setSchedule: next => { power.setSchedule(next); life?.reschedule(); sources.invalidate(); },
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
    lifeCtx.effect(() => webServer.register(consoleRoute(prefix, sources, actions, config.allowedHosts)), 'dsh-world console routes');
    lifeCtx.effect(() => {
      worlds.unregisterList ??= webServer.register(worldListRoute(worlds.consoles));
      worlds.consoles.set(worldId, config.allowedHosts);
      return () => {
        worlds.consoles.delete(worldId);
        if (!worlds.consoles.size) { worlds.unregisterList?.(); delete worlds.unregisterList; }
      };
    }, 'dsh-world world list');
    if (power.running()) await changeWorld(async () => { if (!disposed && power.running()) await startLife(false); });
  });
}
