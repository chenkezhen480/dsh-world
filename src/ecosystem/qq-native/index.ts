import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { speakerIdentity, conversationKey, type SpeakerIdentity } from '../shared/identity.ts';
import type { ChannelContextMessage } from '../shared/context.ts';
import { createBridge } from './snowluma.ts';
import { createQqHome } from './home.ts';
import { createBatcher } from './batch.ts';
import { createOutbox } from './outbox.ts';
import { planReply, type QqPart } from './replies.ts';
import { createSnowlumaSupervisor, type SnowlumaStatus } from '../qq/supervisor.ts';
import { startSnowluma, type StartResult } from '../qq/snowluma-start.ts';
import type { NativePatch } from '../qq/route.ts';
import type { InWorld } from '../../worldScope.ts';
import { createNativeBridge, type BridgeStatus, type NativeBridge } from './native-bridge.ts';

export type { QqPart } from './replies.ts';

/** The largest single message we accept from QQ; anything longer is cut before it reaches her. */
const MAX_INCOMING = 2_000;
/** How many distinct messages we remember to drop repeats of. */
const SEEN_LIMIT = 500;
/** The pause between the messages one answer is split into. */
const SPLIT_PAUSE_MS = 600;

/** The newest `limit` ids, oldest dropped first. */
function recentIds(limit: number) {
  const ids = new Set<string>();
  return {
    has: (id: string) => ids.has(id),
    /** False when the id was already there. */
    add(id: string): boolean {
      if (ids.has(id)) return false;
      ids.add(id);
      if (ids.size > limit) ids.delete(ids.values().next().value!);
      return true;
    },
    clear: () => ids.clear(),
  };
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * What we actually read off an incoming message.
 *
 * The transport (`snowluma.ts`) hands over its own normalized shape; this is the part of it the
 * module depends on, written out here so the wiring does not lean on that file's type names.
 */
interface QqIncoming {
  kind: 'group' | 'private';
  groupId: string | null;
  userId: string;
  messageId: string;
  selfId: string;
  text: string;
  sender?: { nickname?: string; card?: string | null } | undefined;
  /** 原始段数组（OneBot 的 message）。群里那句是不是在叫她，看的就是它。 */
  segments?: Array<{ type?: string; data?: Record<string, unknown> }> | undefined;
}

export interface QqNativeConfig {
  enabled: boolean;
  wsUrl: string;
  accessToken: string;
  /** QQ numbers allowed to talk to her at all; empty means nobody. */
  allowPrivate: readonly string[];
  /** 她自己开口（家里闹钟、世界线那一轮）的话推给谁；空着退回 allowPrivate 的第一个。 */
  ownerQQ: string;
  allowGroups: readonly string[];
  /** 她会不会回。关掉是「收到但不理」——连问都不问，不花调用。 */
  autoReply: boolean;
  /** How many earlier messages of the same conversation are shown to her with each new one. */
  contextMessages: number;
  /** 同一会话这几毫秒内说的话攒成一条再问她；0 = 一条一问。 */
  batchQuietMs: number;
  /** 群里什么时候接话：mention 只接被叫到的（被 @ / 被引用她的消息 / 命中关键词），all 每句都接。 */
  groupTrigger: 'mention' | 'all';
  /** 群里命中这些词也算在叫她。 */
  groupKeywords: readonly string[];
  /** 只停嘴不停耳：这个时间（ISO）之前照收、照记上下文，但不回；到点自己醒。空着就是没静默。 */
  mutedUntil: string;
  /** SnowLuma 的家目录；看门狗和「拉起 SnowLuma」都靠它。 */
  snowlumaHome: string;
  /** 看门狗：通道开着时盯住 wsUrl 的端口，不通就拉起 SnowLuma。 */
  supervise: boolean;
  /** Who shares her home session: `owner` keeps it for the owner's private chat, `none` gives every
   *  conversation its own, empty follows whatever the bridge's own setting says. */
  bindHomeSession: 'owner' | 'all' | 'none' | '';
  /** 阳台：让这台机器上别的程序能跟家里说话的那条线。`port` 为 0 就整块不开。 */
  bridge: { port: number; token: string; title: string; contextMessages: number };
}

export interface QqNativeStatus {
  enabled: boolean;
  connected: boolean;
  url: string;
  allowPrivate: number;
  allowGroups: number;
  /** 名单本身，面板拿它填输入框。 */
  allowPrivateIds: string[];
  allowGroupsIds: string[];
  autoReply: boolean;
  conversations: number;
  answering: number;
  lastEventAt: string | null;
  lastError: string | null;
  sent: number;
  failed: number;
  /** 发不出去、在队里等重试的条数。 */
  outbox: number;
  /** 阳台那条线现在什么样（没开就是 null）。 */
  bridge: BridgeStatus | null;
  /** 到了通道、但不在白名单里被挡下的条数。 */
  blocked: number;
  /** 最近一次被白名单挡下的时刻。 */
  lastBlockedAt: string | null;
  bindHomeSession: 'owner' | 'all' | 'none' | '';
  /** 群里接话的规矩。 */
  groupTrigger: 'mention' | 'all';
  /** 静默到什么时候；没在静默就是 null。 */
  mutedUntil: string | null;
  /** 同一个人连发几句合成一次问的窗口（毫秒）。 */
  batchQuietMs: number;
  supervisor: SnowlumaStatus;
  /** 这次请求按下「拉起 SnowLuma」的结果。 */
  launch?: StartResult;
}

/** 传输层交给通道的那几件（真身上是 snowluma.js 的 createBridge，测试可以换掉）。 */
export interface QqTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  getState(): string;
  sendGroup(groupId: string, parts: string | QqPart[]): Promise<{ messageId: string }>;
  sendPrivate(userId: string, parts: string | QqPart[]): Promise<{ messageId: string }>;
  /** 发账号收藏表情（不是消息段，单发一条）；测试替身可以不实现。 */
  sendCustomFace?(emojiId: string, target: { groupId?: string; userId?: string }): Promise<{ messageId: string }>;
  /** 发一条 QQ 空间说说；测试替身可以不实现。 */
  publishQzone?(content: string): Promise<{ tid: string }>;
}

/** createBridge 认的那几个选项，通道只用到这几个。 */
export interface QqTransportOptions {
  wsUrl: string;
  accessToken?: string;
  log(level: string, message: string): void;
  onGroupMessage?(message: unknown): void;
  onPrivateMessage?(message: unknown): void;
  onNotice?(type: string, notice?: unknown): void;
}

/** One message to send, kept as it was so a retry sends exactly the same. */
interface Outgoing { kind: 'group' | 'private'; target: string; parts: string | QqPart[] }
/** What one conversation said while its words were gathering. */
interface Gathered { text: string; identity: SpeakerIdentity; who: string }

/**
 * QQ as another way into the same home, without a bridge process in between.
 *
 * One OneBot connection in, the same `home` the WeChat channel uses in the middle, and a reply sent
 * back out. There is no separate session store: a conversation's identity key is the whole mapping,
 * so a group keeps talking to the same conversation she already has for it.
 */
export function createQqNativeModule(deps: {
  ctx: Context;
  home(identity: SpeakerIdentity): Promise<Agent>;
  inWorld?: InWorld;
  /** Whether the session is her home now: what she says there on her own goes to the owner too. */
  isHome?(sessionId: string): boolean;
  config(): QqNativeConfig;
  /** 面板拨的开关存这儿；不给就只在内存里活到下一次重载。 */
  stateFile?: string;
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };
  /** 传输层；不给就用真身（snowluma.js 那条线）。测试靠它把合成事件灌进来。 */
  transport?(options: QqTransportOptions): QqTransport;
}) {
  const home = createQqHome({ ctx: deps.ctx, home: deps.home, inWorld: deps.inWorld });
  const seen = recentIds(SEEN_LIMIT);
  // 她说出去的消息 id。有人引用她的话，引用的就是这个 id。
  const sentIds = recentIds(SEEN_LIMIT);
  const contexts = new Map<string, ChannelContextMessage[]>();
  const answering = new Set<string>();
  let client: QqTransport | undefined;
  let nativeBridge: NativeBridge | undefined;
  let stopped = false;
  const disposers: (() => void)[] = [];
  // 面板要的那几个数自己记：传输层只交出一个 getState()，不带计数。
  const stats: { sent: number; failed: number; blocked: number; lastEventAt: string | null; lastBlockedAt: string | null; lastError: string | null } = {
    sent: 0, failed: 0, blocked: 0, lastEventAt: null, lastBlockedAt: null, lastError: null,
  };

  // 拨过的开关写在 stateFile 里，重载不丢；配置里那个是出厂默认。
  type Overrides = { autoReply?: boolean; bridge?: { port?: number }; mutedUntil?: string | null; allowPrivate?: string[]; allowGroups?: string[]; batchQuietMs?: number };
  const overrides = ((): Overrides => {
    try { return deps.stateFile ? JSON.parse(readFileSync(deps.stateFile, 'utf8')) : {}; } catch { return {}; }
  })();
  function writeOverrides(): void {
    const file = deps.stateFile;
    if (!file) return;
    try { writeFileSync(file, JSON.stringify(overrides, null, 2) + '\n', 'utf8'); } catch (error) { deps.logger.warn('QQ 原生通道：开关没存下来', error); }
  }
  /** The configuration with whatever the panel changed laid over it. */
  const settings = (): QqNativeConfig => {
    const base = deps.config();
    return {
      ...base,
      ...(overrides.autoReply === undefined ? {} : { autoReply: overrides.autoReply }),
      ...(overrides.mutedUntil === undefined ? {} : { mutedUntil: overrides.mutedUntil ?? '' }),
      ...(overrides.allowPrivate === undefined ? {} : { allowPrivate: overrides.allowPrivate }),
      ...(overrides.allowGroups === undefined ? {} : { allowGroups: overrides.allowGroups }),
      ...(overrides.batchQuietMs === undefined ? {} : { batchQuietMs: overrides.batchQuietMs }),
      bridge: overrides.bridge?.port === undefined ? base.bridge : { ...base.bridge, port: overrides.bridge.port },
    };
  };
  const mutedUntil = (config: QqNativeConfig): string | null => {
    const until = config.mutedUntil.trim();
    return until && Date.now() < Date.parse(until) ? until : null;
  };

  const supervisor = createSnowlumaSupervisor({
    homeDir: deps.config().snowlumaHome, host: '127.0.0.1', port: Number(new URL(deps.config().wsUrl).port || 3003),
    log: message => deps.logger.info(message),
  });

  async function sendNow({ kind, target, parts }: Outgoing): Promise<void> {
    if (!client) throw new Error('QQ 通道没连上');
    const sent = await (kind === 'group' ? client.sendGroup(target, parts) : client.sendPrivate(target, parts));
    if (sent?.messageId) sentIds.add(String(sent.messageId));
    stats.sent += 1;
  }
  const outbox = createOutbox<Outgoing>({ send: sendNow, dropped: () => { stats.failed += 1; stats.lastError = '排在队里太久，放弃了'; } });

  /** Sends one of her answers: its paragraphs a pause apart (queued if they fail), then stickers and posts. */
  async function say(kind: 'group' | 'private', target: string, text: string): Promise<void> {
    const plan = planReply(text);
    for (const [index, parts] of plan.messages.entries()) {
      if (index) await pause(SPLIT_PAUSE_MS);
      if (!await outbox.send({ kind, target, parts })) deps.logger.warn(`QQ 这条没发出去，先排队（${outbox.size} 条待发）`);
    }
    for (const sticker of plan.stickers) {
      try { await client?.sendCustomFace?.(sticker, kind === 'group' ? { groupId: target } : { userId: target }); }
      catch (error) { deps.logger.warn(`QQ 收藏表情没发出去：${errorText(error)}`); }
    }
    for (const content of plan.qzone) {
      try { await client?.publishQzone?.(content); }
      catch (error) { deps.logger.warn(`QQ 空间那条没发出去：${errorText(error)}`); }
    }
  }

  /**
   * 群里这句是不是在叫她。
   *
   * 量过：不做这个判断时，群里没被叫到的每一句都会让她跑完一整轮、还往群里冒一条——哪怕她自己在话里
   * 写的是「这句不接」，钱和噪声都已经花了。所以只有被 @ 到（@全体 是群公告，不算）、有人引用过她的话、
   * 或者命中配的关键词，才把话递到她跟前；其余只记进那个群的上下文，等她真被叫到时知道刚才在说什么。
   */
  function directedAtHer(message: QqIncoming, config: QqNativeConfig): boolean {
    if (config.groupTrigger === 'all') return true;
    for (const segment of message.segments ?? []) {
      const data = segment?.data ?? {};
      if (segment?.type === 'at' && String(data.qq ?? '') === message.selfId) return true;
      if (segment?.type === 'reply' && data.id != null && sentIds.has(String(data.id))) return true;
    }
    return config.groupKeywords.some(word => word !== '' && message.text.includes(word));
  }

  function allowed(identity: SpeakerIdentity, config: QqNativeConfig): boolean {
    return identity.conversationType === 'group'
      ? config.allowGroups.includes(identity.conversationId)
      : config.allowPrivate.includes(identity.speakerId.slice('qq:'.length));
  }

  function pushContext(key: string, message: ChannelContextMessage, limit: number) {
    const list = contexts.get(key) ?? [];
    list.push(message);
    while (list.length > Math.max(1, Math.min(limit, 20))) list.shift();
    contexts.set(key, list);
  }

  // Close messages of one conversation are asked together; each keeps who said it (a group has several voices).
  const batches = createBatcher<Gathered>({ quietMs: () => settings().batchQuietMs, flush: (key, items) => { void answer(key, items); } });

  function deliver(message: QqIncoming) {
    if (stopped) return;
    const config = settings();
    if (!config.enabled) return;
    const messageId = message.messageId;
    if (messageId && !seen.add(messageId)) return;
    const selfId = message.selfId;
    const userId = message.userId;
    // Her own words come back through the same socket; answering them would be talking to herself.
    if (!userId || userId === selfId) return;
    const text = message.text.trim().slice(0, MAX_INCOMING);
    if (!text) return;
    const isGroup = message.kind === 'group';
    const conversationId = isGroup ? message.groupId ?? '' : userId;
    if (!conversationId) return;
    stats.lastEventAt = new Date().toISOString();
    const speakerName = message.sender?.card || message.sender?.nickname || '';
    let identity: SpeakerIdentity;
    try {
      identity = speakerIdentity({
        channel: 'qq',
        accountId: selfId || '0',
        speakerId: `qq:${userId}`,
        ...(speakerName ? { speakerName } : {}),
        conversationId,
        conversationType: isGroup ? 'group' : 'private',
        ...(isGroup ? { conversationName: `群 ${conversationId}` } : {}),
        ...(messageId ? { platformMessageId: messageId } : {}),
      });
    } catch (error) { deps.logger.warn('QQ 消息身份不合法:', error); return; }
    // 不在白名单也算「到过」：不然分不清「消息根本没送到」和「送到了但被白名单挡下」。
    if (!allowed(identity, config)) {
      stats.blocked += 1;
      stats.lastBlockedAt = new Date().toISOString();
      return;
    }
    const key = conversationKey(identity);
    // 群里没叫她的话、静默中的话、自动回复关着时的话，都只进上下文：不开口、也不花一轮（关掉自动回复就是
    // 「别理它」，连问都不问；静默到点自己醒）。等她真被叫到，就知道刚才在说什么。私聊不看叫没叫她。
    if ((isGroup && !directedAtHer(message, config)) || mutedUntil(config) || !config.autoReply) {
      pushContext(key, { id: messageId || String(Date.now()), occurredAt: new Date().toISOString(), text, identity }, config.contextMessages);
      return;
    }
    batches.add(key, { text, identity, who: speakerName });
  }

  async function answer(key: string, gathered: Gathered[]): Promise<void> {
    const config = settings();
    // 攒着的这几秒里开关可能被关掉，或者开始静默：那就别问了。
    if (stopped || !config.autoReply || mutedUntil(config)) return;
    // The first speaker's identity carries the turn; a group's lines keep their names in the text.
    const { identity } = gathered[0]!;
    const isGroup = identity.conversationType === 'group';
    const text = gathered.length === 1 ? gathered[0]!.text : gathered.map(item => isGroup && item.who ? `${item.who}: ${item.text}` : item.text).join('\n');
    answering.add(key);
    try {
      const reply = await home.ask(text, identity, contexts.get(key) ?? []);
      // 她那句话记成她自己说的：不然后面拿这段上下文问她「刚才聊到哪了」时，她说过的会被当成对方说的。
      const herIdentity = speakerIdentity({ channel: 'qq', accountId: identity.accountId, speakerId: `qq:${identity.accountId}`, conversationId: identity.conversationId, conversationType: identity.conversationType });
      pushContext(key, { id: reply.id, occurredAt: new Date().toISOString(), text: reply.text, identity: herIdentity }, config.contextMessages);
      if (reply.text.trim()) await say(isGroup ? 'group' : 'private', identity.conversationId, reply.text.trim());
    } catch (error) {
      stats.failed += 1;
      stats.lastError = errorText(error);
      deps.logger.warn(`QQ 回复 ${key} 失败: ${stats.lastError}`);
    } finally { answering.delete(key); }
  }

  /**
   * 她自己开的一轮（家里的闹钟、世界线）说完的话，也推一份给主人。只看她的家，只看由她自己的时间开起来、
   * 中途没有人说话的那一轮：有人说话的轮次是在回那个人，QQ 进来的话已经由上面那条路原路回过了。
   */
  function forwardOwnTurns(): () => void {
    const turns = new Map<string, { own: boolean; said: string }>();
    return deps.ctx.on('session/event', (session, event) => {
      if (!deps.isHome?.(session.id) || (deps.inWorld && !deps.inWorld(session))) return;
      if (event.type === 'turn/start') { turns.set(session.id, { own: false, said: '' }); return; }
      const turn = turns.get(session.id);
      if (!turn) return;
      if (event.type === 'user/message') {
        if (event.data.source.kind === 'dsh-world-life') turn.own = true;
        else if (event.data.source.kind === 'user') { turns.delete(session.id); return; }
      }
      if (event.type === 'assistant/message') {
        const text = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim();
        if (text) turn.said = text;
      }
      if (event.type !== 'turn/end') return;
      turns.delete(session.id);
      const config = settings();
      const owner = config.ownerQQ || config.allowPrivate[0];
      if (!turn.own || !turn.said || !owner || !client || mutedUntil(config)) return;
      void say('private', owner, turn.said).catch(error => deps.logger.warn(`她自己的话没能推给主人：${errorText(error)}`));
    });
  }

  /**
   * 阳台：给机器上别的程序留的一条线。
   *
   * 和 QQ 那条完全分开 —— 它是外面递话进来，不是 QQ 消息。一条线一间屋子（会话键里带着
   * `qq-bridge`），所以它跟她别的会话互不打扰。口令落在世界目录（qq-bridge.json），
   * 重启 DSH 对面那份配置不用改。
   */
  function startBridge(config: QqNativeConfig): void {
    if (nativeBridge || !config.bridge.port) return;
    nativeBridge = createNativeBridge({
      ctx: deps.ctx,
      session: identity => deps.home(identity),
      inWorld: deps.inWorld,
      config: () => {
        const live = settings().bridge;
        return { port: live.port, token: live.token, title: live.title, contextMessages: live.contextMessages };
      },
      worldDir: deps.stateFile ? dirname(deps.stateFile) : process.cwd(),
      script: join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'qq-line.js'),
      log: (message: string) => deps.logger.info(message),
    });
    void nativeBridge.start().catch((error: unknown) => deps.logger.error('阳台没能开起来', error));
  }

  function status(): QqNativeStatus {
    const config = settings();
    return {
      enabled: config.enabled,
      connected: client?.getState() === 'online',
      url: config.wsUrl,
      allowPrivate: config.allowPrivate.length,
      allowGroups: config.allowGroups.length,
      allowPrivateIds: [...config.allowPrivate],
      allowGroupsIds: [...config.allowGroups],
      autoReply: config.autoReply,
      bindHomeSession: config.bindHomeSession,
      bridge: nativeBridge?.status() ?? null,
      groupTrigger: config.groupTrigger,
      conversations: contexts.size,
      answering: answering.size + batches.size,
      lastEventAt: stats.lastEventAt,
      blocked: stats.blocked,
      lastBlockedAt: stats.lastBlockedAt,
      lastError: stats.lastError,
      sent: stats.sent,
      failed: stats.failed,
      outbox: outbox.size,
      mutedUntil: mutedUntil(config),
      batchQuietMs: config.batchQuietMs,
      supervisor: supervisor.status(),
    };
  }

  return {
    status,
    /**
     * 面板上拨的那些：会不会自己回、静默到几点（null 立刻恢复）、白名单（整组换掉，空数组谁都不收）、
     * 阳台端口（当场关掉重开那条线，0 就是关），以及手动拉起 SnowLuma 一次。一次请求里给的几项一起生效。
     */
    update(patch: NativePatch): QqNativeStatus {
      if (patch.autoReply !== undefined) overrides.autoReply = patch.autoReply;
      if (patch.mutedUntil !== undefined) overrides.mutedUntil = patch.mutedUntil;
      if (patch.allowPrivate) overrides.allowPrivate = patch.allowPrivate;
      if (patch.allowGroups) overrides.allowGroups = patch.allowGroups;
      if (patch.bridge) overrides.bridge = { port: patch.bridge.port };
      if (patch.batchQuietMs !== undefined) overrides.batchQuietMs = patch.batchQuietMs;
      writeOverrides();
      if (patch.bridge) { nativeBridge?.stop(); nativeBridge = undefined; startBridge(settings()); }
      return { ...status(), ...(patch.startSnowluma ? { launch: startSnowluma(settings().snowlumaHome) } : {}) };
    },
    start() {
      if (stopped) return;
      const config = settings();
      if (!config.enabled) return;
      client = (deps.transport ?? createBridge)({
        wsUrl: config.wsUrl,
        ...(config.accessToken ? { accessToken: config.accessToken } : {}),
        log: (level: string, message: string) => {
          const line = `QQ 原生通道：${message}`;
          // 连回来就把上次的报错擦掉（不然面板上挂着一句昨天的错，会让人以为现在还坏着）。
          // 「QQ 账号离线」不是这一层的事，留着。
          if (level === 'info') {
            if (message.startsWith('WS 已连接') && stats.lastError !== 'QQ 账号离线') stats.lastError = null;
            deps.logger.info(line);
          } else if (level === 'warn') deps.logger.warn(line);
          else { stats.lastError = message; deps.logger.error(line); }
        },
        // 传输层只交出一条归一化过的消息，形状见 QqIncoming；两边对不上的字段这里本来也不用。
        onGroupMessage: (message: unknown) => deliver(message as QqIncoming),
        onPrivateMessage: (message: unknown) => deliver(message as QqIncoming),
        // bot_status 是 SnowLuma 的自有扩展：账号掉线时让它显示成「QQ 账号离线」，别和「桥挂了」混在一起。
        onNotice: (type: string) => {
          if (type === 'bot_offline') stats.lastError = 'QQ 账号离线';
          if (type === 'bot_online') stats.lastError = null;
        },
      });
      outbox.start();
      if (config.supervise) supervisor.start();
      startBridge(config);
      disposers.push(forwardOwnTurns());
      client.start().catch((error: unknown) => {
        stats.lastError = errorText(error);
        deps.logger.warn('QQ 原生通道首次连接失败：', stats.lastError);
      });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const dispose of disposers.splice(0)) dispose();
      supervisor.stop();
      batches.clear();
      outbox.stop();
      home.stop();
      nativeBridge?.stop(); nativeBridge = undefined;
      void client?.stop();
      client = undefined;
      contexts.clear();
      seen.clear(); sentIds.clear();
    },
  };
}

export type QqNativeModule = ReturnType<typeof createQqNativeModule>;
