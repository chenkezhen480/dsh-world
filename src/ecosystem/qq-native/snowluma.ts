// lib/snowluma.js —— QQ 桥的纯 SDK 侧实现：连接、事件归一化、发送。
// 本文件是 P1 交付物；插件装配层（package.json / cordis.patch.yml / lib/index.js）不属于本文件职责。
// 依赖：由 profile 另行安装的 @snowluma/sdk（纯 ESM；本模块只用 import）。
//
// ────────────────────────────────────────────────────────────────
// 一、createBridge 的契约（权威定义，外壳 lib/index.js 依赖它）
// ────────────────────────────────────────────────────────────────
//
//   export function createBridge(options) -> Bridge
//
//   options（外壳传给你的，只读）：
//     wsUrl        string      例 'ws://127.0.0.1:3001'
//     accessToken  string|undefined   为空时不往 SDK 里传（传空串会变 `Bearer `）
//     log          (level, message) => void     level: 'info'|'warn'|'error'
//     onGroupMessage(msg)     收到群消息时调用（自己发的已过滤掉）
//     onPrivateMessage(msg)   收到私聊消息时调用
//     onNotice(type, msg)     收到通知事件时调用，type 已归一化（见三）
//     onState(state)          连接状态变化，state: 'connecting'|'online'|'closed'
//     sendDelayMs   number     可选；串行发送的固定间隔，缺省 500（外壳当前不传，见实现说明⑤）
//
//   Bridge（返回的对象）：
//     start()                        Promise<void>   开始连接。失败也会 reject 得清楚
//     stop()                         Promise<void>   断开，幂等（连调两次不抛）
//     sendGroup(groupId, parts)      Promise<{ messageId }>   groupId: string|number
//     sendPrivate(userId, parts)     Promise<{ messageId }>
//     getState()                     'connecting'|'online'|'closed'
//     __emitForTest(event)           仅供测试：把一条 SDK 形状的事件直接灌进内部分发链，
//                                    不经过网络（fixtures/README.md 认可的测试注入点）
//
// ────────────────────────────────────────────────────────────────
// 二、parts（要发送的内容，纯数据，不含 SDK 类型）
// ────────────────────────────────────────────────────────────────
//
//   parts 是数组，元素形如：
//     { type:'text',  text:'你好' }
//     { type:'at',    qq:'123456' | 'all' }
//     { type:'reply', id:'消息id' }          ← 一条消息里最多一次，SDK 会抛错
//     { type:'image', file:'https://… 或 本地路径' }
//     { type:'face',  id:'14' }
//   也允许直接传字符串，等价于 [{ type:'text', text:那个字符串 }]。
//   五种之外的部分类型会以明确的 Error 拒绝（宁可大声失败，不悄悄丢段）。
//
//   注意：文本要自己转义 `[CQ:`（见《范例切片》第 6 节 escapeCqText），
//         否则模型输出的 `[CQ:at,qq=all]` 会被当真实段执行。
//
// ────────────────────────────────────────────────────────────────
// 三、msg（回调出去的入站消息，plain 形状）
// ────────────────────────────────────────────────────────────────
//
//   {
//     kind: 'group' | 'private',
//     groupId: string | null,        // 私聊为 null
//     userId: string,                // 发送者 QQ（**字符串**，网关会 number/string 混用）
//     messageId: string,
//     selfId: string,                // 机器人自己的 QQ
//     time: number,                  // 秒级时间戳
//     rawMessage: string,            // 原始 CQ 字符串，排障用
//     text: string,                  // 已转换好的可读文本（段→文本，见《范例切片》第 8 节）
//     segments: Array<{type,data}>,  // 原始段数组，保留给上层判断 @ / 引用
//     sender: { userId: string, nickname: string, card: string|null, role: string|null }
//   }
//   （私聊事件没有 card / role 字段 → 归一化为 null，不是空串。）
//
//   onNotice(type, msg) 的 type 归一化为：'poke' | 'group_increase' | 'group_decrease'
//   | 'group_admin' | 'group_recall' | 'friend_recall' | 'bot_online' | 'bot_offline' | 'other'。
//   notice 的 msg 形状：{ kind:'notice', type, noticeType, subType, groupId, userId,
//   operatorId, selfId, time, raw }（raw 是原始 SDK 事件，供上层取本模块没展开的字段）。
//   （SDK 的 notice_type 是运行时字符串集合，没有枚举可依赖 —— 不穷举、不 throw。）
//
// ────────────────────────────────────────────────────────────────
// 四、必须遵守的四条红线
// ────────────────────────────────────────────────────────────────
//   1. 自己发的消息要过滤：String(user_id) === String(self_id)（两个来源都判，
//      见《范例切片》第 2 节），另加 post_type === 'message_sent' 防回流。
//   2. 重连交给 SDK：`new SnowLumaWebSocketClient({ reconnect: true })`，
//      不自己再套一层重连循环（会双重重连）。
//   3. 发送要串行 + 间隔 + 超时（《范例切片》第 6 节的三件套），不 Promise.all 并发发。
//   4. 入站段→文本的 switch 必须有 default 分支（未知段保留 `[xxx]` 占位）。
//
// ────────────────────────────────────────────────────────────────
// 实现说明（与切片的差异及理由，逐条可查）
// ────────────────────────────────────────────────────────────────
//   ① 出站文本转义用本文件的 escapeOutgoingText（切片第 6 节的逐字实现：
//      `[CQ:` → 全角 `[CQ：`）。SDK 也导出同名 escapeCqText，但行为不同 ——
//      它是 CQ 字符串序列化用的实体转义（`[` → `&#91;`，dist/messages/cq-format.js 实读），
//      段模式下网关不一定解码实体，显示会变成 `&#91;`。以切片的生产行为为准。
//   ② withTimeout 超时抛 SDK 的 SnowLumaTimeoutError（带 timeoutMs），而不是切片里的
//      普通 Error —— 其余发送错误本来就都是 SDK 错误（SnowLumaApiError / Auth /
//      Connection / Timeout），统一后上层（P2/P3）能按类型分类，不必解析文案。
//   ③ 段构造走 chain()（MessageChain）：SDK 会在第二次 reply 时抛
//      「Message segment "reply" can only appear once in a chain」，与契约二的行为一致。
//   ④ start() 首连失败会 reject，但客户端对象保留（SDK reconnect 按退避自动重试，
//      状态保持 'connecting' 直到 open）。想彻底重来先 stop() 再 start()；
//      start() 在已启动时直接返回，不会创建第二个客户端（避免双份事件）。
//   ⑤ options.sendDelayMs 缺省 500ms：旧桥从 config.json 读 sendDelayMs，本层拿不到
//      就给保守默认；外壳以后要传的话本模块已支持（容忍配置缺失，用默认值）。
//   ⑥ 除 createBridge 外还导出纯函数 segmentsToText / normalizeMessageEvent /
//      normalizeNoticeType / normalizeNoticeEvent / buildSegments，供不连网的单测
//      直接断言（fixtures/README.md 认可的另一种测法）；createBridge 内部只调它们。

/** @typedef {'connecting'|'online'|'closed'} BridgeState */

import {
  SnowLumaTimeoutError,
  SnowLumaWebSocketClient,
  chain,
  parseSegments,
} from '@snowluma/sdk';
import WebSocket from 'ws';

class SnowlumaSocket extends WebSocket {
  override close(code?: number, reason?: string): void {
    // The SDK removes its error listener before closing, but ws emits an error when a handshake is cancelled.
    if (this.readyState === WebSocket.CONNECTING) this.once('error', () => {});
    super.close(code, reason);
  }
}

/**
 * 交付物里进出的都是未知形状的 JSON。这个别名只干一件事：让字段访问合法。
 * 交付模块逐字保留，所以注解只加在参数上；真正的形状契约写在文件头那段注释里。
 */
type Loose = any;

// ── 常量 ──────────────────────────────────────────────────────
const SEND_TIMEOUT_MS = 15000;      // 单次发送的外层超时（切片第 6 节：SEND_TIMEOUT_MS = 15000）
const DEFAULT_SEND_DELAY_MS = 500;  // 串行发送间隔的默认值（见实现说明⑤）
const DEFAULT_WS_URL = 'ws://127.0.0.1:3001';
/** 她想的词和收藏表情备注里写的词对不上时，按这张小表再找一次。 */
const FACE_ALIASES: Record<string, string[]> = {
  开心: ['好耶', '成了', '可以', '舒服'], 高兴: ['好耶', '成了'], 生气: ['炸毛', '气'], 不懂: ['问号', '不懂'], 疑问: ['问号'],
  求: ['拜托', '合十'], 拜托: ['合十', '拜托'], 钱: ['钱包', '钱来了'], 累: ['熬夜', '咖啡'], 困: ['睡觉', '抱枕头'], 睡: ['睡觉', '抱枕头'],
  在: ['举手', '我在这'], 同意: ['可以', '比赞'], 赞: ['比赞', '可以'], 思考: ['思考中', '转圈'], 等我: ['思考中'],
};

const sleep = (ms: Loose): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

// 切片第 6 节的 withTimeout；超时抛 SnowLumaTimeoutError（实现说明②）。
function withTimeout(promise: Loose, ms: Loose, label: Loose) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new SnowLumaTimeoutError(`操作超时(${ms}ms)：${label}`, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 切片第 6 节 escapeCqText 的逐字实现：防 CQ 码注入（实现说明①）。
function escapeOutgoingText(value: Loose) {
  return String(value ?? '').replace(/\[CQ:/gi, '[CQ：');
}

// ──────────────────────────────────────────────────────────────
// 入站：段 → 可读文本（切片第 8 节；switch 必须有 default —— 红线 4）
// ──────────────────────────────────────────────────────────────
/**
 * 把入站 message（段数组，或少数网关直接给的字符串）转成给上层/AI 看的文本。
 * @param {unknown} message event.message（JsonValue）
 * @returns {string}
 */
export function segmentsToText(message: Loose) {
  // CQ 字符串里的图片链接也不交给模型，取图只使用解析出的 file 标识。
  if (typeof message === 'string') return message.replace(/\[CQ:image(?:,[^\]]*)?\]/g, '[图片]').trim();
  const list = Array.isArray(message)
    ? message
    : (message && typeof message === 'object' ? [message] : []);
  const out = [];
  for (const seg of list) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': {
        // 本层拿不到群名片解析器（需要群成员查询，属 P2+），先回退成 QQ 号；
        // 原始 at 段保留在 msg.segments 里，上层可以再解析。
        if (d.qq === 'all') out.push('@全体成员');
        else out.push(`@${d.qq ?? ''}`);
        break;
      }
      case 'face': out.push(`[表情${d.id ?? ''}]`); break;
      // 市场表情（mface）在部分网关实现里出现：有 summary 就用它，别让模型只看到 "[mface]"。
      case 'mface': out.push(`[表情${d.summary ? `:${d.summary}` : ''}]`); break;
      case 'image': out.push('[图片]'); break;
      case 'record': out.push(d.file ? `[语音 file=${d.file}]` : '[语音]'); break;
      case 'video': out.push('[视频]'); break;
      case 'file': out.push(`[文件${d.name ?? ''}]`); break;
      case 'reply':
        // 引用/回复段：本层无法取被引用消息原文（需要历史查询），给占位；
        // 原始引用 id 保留在 msg.segments[0].data.id，供上层解析。
        out.push('[引用消息]');
        break;
      case 'json': out.push('[卡片消息]'); break;
      // markdown：SnowLuma 1.14.9 的线上段是 {type:'markdown',data:{content}}；
      // 1.14.17+ 起还会带 data.text。两个形状都读（切片第 8 节原文）。
      case 'markdown': out.push(String(d.text ?? d.content ?? '[Markdown]')); break;
      case 'forward': {
        const fid = d.forward_id ?? d.res_id ?? d.id ?? null;
        out.push(fid ? `[转发消息 id=${fid}]` : '[转发消息]');
        break;
      }
      // 未知段保留占位而不是丢掉 —— 让上层知道自己漏看了什么（红线 4）。
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  return out.join('').trim();
}

// event.message → 段数组（string 形状用 SDK 的 parseSegments 从 CQ 重建）。
function toSegmentArray(message: Loose) {
  if (Array.isArray(message)) return message;
  if (typeof message === 'string') {
    try { return parseSegments(message); } catch { return []; }
  }
  if (message && typeof message === 'object') return [message];
  return [];
}

// ──────────────────────────────────────────────────────────────
// 入站：SDK 事件 → 契约三的 plain msg
// ──────────────────────────────────────────────────────────────
/**
 * 把一条 SDK 消息事件归一化成契约里的 msg；非消息事件返回 null。
 * @param {unknown} event
 */
export function normalizeMessageEvent(event: Loose) {
  const messageType = event?.message_type;
  if (messageType !== 'group' && messageType !== 'private') return null;
  const sender = (event?.sender && typeof event.sender === 'object') ? event.sender : {};
  return {
    kind: messageType,
    groupId: messageType === 'group' ? String(event?.group_id ?? '') : null,
    userId: String(event?.user_id ?? sender.user_id ?? ''),
    messageId: String(event?.message_id ?? ''),   // 负数 id 也会被如实字符串化，不当 falsy 丢掉
    selfId: String(event?.self_id ?? ''),
    time: Number(event?.time ?? 0),
    rawMessage: String(event?.raw_message ?? ''),
    text: segmentsToText(event?.message),
    segments: toSegmentArray(event?.message),
    sender: {
      userId: String(sender.user_id ?? event?.user_id ?? ''),
      nickname: String(sender.nickname ?? ''),
      card: sender.card != null ? String(sender.card) : null,
      role: sender.role != null ? String(sender.role) : null,
    },
  };
}

/**
 * notice_type → 契约三的归一化名。运行时字符串集合，不穷举、不 throw。
 * @param {unknown} event
 * @returns {string}
 */
export function normalizeNoticeType(event: Loose) {
  const noticeType = String(event?.notice_type ?? '');
  const subType = String(event?.sub_type ?? '');
  if (noticeType === 'bot_status') {
    // bot_status 是 SnowLuma 自有扩展（非 OneBot 标准），sub_type: 'online'|'offline'
    if (subType === 'online') return 'bot_online';
    if (subType === 'offline') return 'bot_offline';
    return 'other';
  }
  if (noticeType === 'poke' || noticeType === 'group_poke' || noticeType === 'friend_poke') return 'poke';
  // 拍一拍在 OneBot v11 里走 notice/notify + sub_type:poke（切片第 4 节的 'notify'）
  if (noticeType === 'notify' && subType === 'poke') return 'poke';
  if (noticeType === 'group_increase' || noticeType === 'group_decrease'
    || noticeType === 'group_admin' || noticeType === 'group_recall'
    || noticeType === 'friend_recall') return noticeType;
  return 'other';
}

/**
 * 把一条 SDK 通知事件归一化成 { type, msg }；非通知事件返回 null。
 * @param {unknown} event
 */
export function normalizeNoticeEvent(event: Loose) {
  if (event?.post_type !== 'notice') return null;
  return {
    kind: 'notice',
    type: normalizeNoticeType(event),
    noticeType: String(event?.notice_type ?? ''),
    subType: event?.sub_type != null ? String(event.sub_type) : null,
    groupId: event?.group_id != null ? String(event.group_id) : null,
    userId: event?.user_id != null ? String(event.user_id) : null,
    operatorId: event?.operator_id != null ? String(event.operator_id) : null,
    selfId: String(event?.self_id ?? ''),
    time: Number(event?.time ?? 0),
    raw: event,
  };
}

// ──────────────────────────────────────────────────────────────
// 出站：契约二的 plain parts → SDK 段
// ──────────────────────────────────────────────────────────────
function requireField(part: Loose, field: Loose, kind: Loose) {
  const value = part?.[field];
  if (value == null || value === '') throw new Error(`parts[${kind}] 缺少必填字段 "${field}"`);
  return value;
}

/**
 * 把契约二的 parts 转成 SDK 段数组。错误以 throw 暴露（发送队列里统一变成 reject）。
 * @param {string|Array<object>} parts
 * @returns {Array<{type:string,data:object}>}
 */
export function buildSegments(parts: Loose) {
  const list = typeof parts === 'string' ? [{ type: 'text', text: parts }] : parts;
  if (!Array.isArray(list)) throw new Error(`parts 必须是数组或字符串，得到 ${typeof parts}`);
  if (list.length === 0) throw new Error('parts 不能为空');
  // 注意：MessageChain 是不可变实现（addSegment 返回新实例，dist/messages/chain.js 实读），
  // 必须接住每个方法的返回值往下叠，直接 c.text(...) 不接返回值会什么都加不上。
  let c = chain();
  for (const part of list) {
    if (typeof part === 'string') {
      if (part) c = c.text(escapeOutgoingText(part));
      continue;
    }
    if (!part || typeof part !== 'object') {
      throw new Error(`parts 元素必须是对象或字符串，得到 ${typeof part}`);
    }
    switch (part.type) {
      case 'text':
        if (part.text) c = c.text(escapeOutgoingText(part.text));
        break;
      case 'at':
        c = c.raw('at', { qq: String(requireField(part, 'qq', 'at')) });
        break;
      case 'reply':
        // 一条消息里最多一次；第二次由 SDK 抛「can only appear once in a chain」
        c = c.reply(String(requireField(part, 'id', 'reply')));
        break;
      case 'image':
        c = c.image(String(requireField(part, 'file', 'image')));
        break;
      case 'face':
        c = c.face(String(requireField(part, 'id', 'face')));
        break;
      default:
        throw new Error(`不支持的 parts 段类型「${part?.type ?? '(空)'}」，支持 text / at / reply / image / face`);
    }
  }
  const segments = c.build();
  if (!segments.length) throw new Error('消息段为空（parts 没有产生任何可发送内容）');
  return segments;
}

// ──────────────────────────────────────────────────────────────
// createBridge
// ──────────────────────────────────────────────────────────────
/**
 * @param {{
 *   wsUrl?: string,
 *   accessToken?: string,
 *   sendDelayMs?: number,
 *   log?: (level: string, message: string) => void,
 *   onGroupMessage?: (msg: any) => void,
 *   onPrivateMessage?: (msg: any) => void,
 *   onNotice?: (type: string, msg: any) => void,
 *   onState?: (state: BridgeState) => void
 * }} options
 */
export function createBridge(options: Loose) {
  const opts = options ?? {};
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  const sendDelayMs = (Number.isFinite(opts.sendDelayMs) && opts.sendDelayMs >= 0)
    ? opts.sendDelayMs
    : DEFAULT_SEND_DELAY_MS;

  /** @type {BridgeState} */
  let state = 'closed';
  /** @type {SnowLumaWebSocketClient|null} */
  let client: SnowLumaWebSocketClient | null = null;
  let stopped = true;   // start() 未调用、或已 stop()

  // 上层回调的异常只记日志，不允许打断收发主链路（SDK 会把 handler 抛错吞进 error 事件，
  // 这里自己包一层，保留是哪个回调出错的标签；同步抛与 Promise reject 都接住）。
  const safeInvoke = (label: Loose, fn: Loose, ...args: unknown[]) => {
    try {
      const result = fn(...args);
      if (result && typeof result.catch === 'function') {
        result.catch((error: Loose) => log('error', `${label} 回调出错: ${(error as Loose)?.message ?? error}`));
      }
    } catch (error) {
      log('error', `${label} 回调出错: ${(error as Loose)?.message ?? error}`);
    }
  };
  const callbackOf = (name: Loose) => (typeof opts[name] === 'function' ? opts[name] : () => {});

  const setState = (next: Loose) => {
    if (state === next) return;
    state = next;
    safeInvoke('onState', callbackOf('onState'), next);
  };

  // —— 入站分发（SDK handler 与 __emitForTest 共用同一条链） ——

  const handleGroupEvent = (event: Loose) => {
    // 红线 1：自己发的必须过滤，两个来源都按字符串比较（切片第 2 节注释原文：
    // 网关可能把 id 序列化成 number/string 混用，=== 会漏掉自己发的消息）
    if (event?.post_type === 'message_sent') return;
    const selfId = String(event?.self_id ?? '');
    if (selfId && (String(event?.user_id ?? '') === selfId
      || String(event?.sender?.user_id ?? '') === selfId)) return;
    const msg = normalizeMessageEvent(event);
    if (!msg) return;
    log('info', `群消息 group=${msg.groupId} user=${msg.userId} msgid=${msg.messageId} card=${msg.sender.card ?? '-'}: ${msg.rawMessage.slice(0, 120)}`);
    safeInvoke('onGroupMessage', callbackOf('onGroupMessage'), msg);
  };

  const handlePrivateEvent = (event: Loose) => {
    if (event?.post_type === 'message_sent') return;
    const selfId = String(event?.self_id ?? '');
    if (selfId && String(event?.user_id ?? '') === selfId) return;
    const msg = normalizeMessageEvent(event);
    if (!msg) return;
    log('info', `私聊消息 user=${msg.userId} msgid=${msg.messageId}: ${msg.rawMessage.slice(0, 120)}`);
    safeInvoke('onPrivateMessage', callbackOf('onPrivateMessage'), msg);
  };

  const handleNoticeEvent = (event: Loose) => {
    const notice = normalizeNoticeEvent(event);
    if (!notice) return;
    // bot_status 是账号在线态的最便宜信号（切片第 5 节）：offline 时上层收不到任何消息，要喊出来
    if (notice.type === 'bot_offline') {
      log('warn', 'SnowLuma 报告 QQ 账号会话已离线（bot_status: offline）—— 重新登录之前群里不会有任何消息进来');
    } else if (notice.type === 'bot_online') {
      log('info', 'SnowLuma 报告 QQ 账号会话已上线（bot_status: online）');
    }
    safeInvoke('onNotice', callbackOf('onNotice'), notice.type, notice);
  };

  // —— 出站：串行发送队列（红线 3，切片第 6 节三件套：串行 + 间隔 + 超时） ——

  /** @type {Promise<void>} */
  let sendChain = Promise.resolve();

  /** 往外发的每一件事（消息、收藏表情、说说）都排同一条队：串行、限时、两件之间停 sendDelayMs。 */
  function serial<T>(label: string, work: (bot: Loose) => Promise<T>): Promise<T> {
    if (!client) return Promise.reject(new Error(`QQ 桥未启动或已停止，无法${label}`));
    const bot = client;
    // 转换放在任务里：段转换出错也走 reject，调用方 await 时统一接住
    const task = sendChain.then(() => withTimeout(work(bot), SEND_TIMEOUT_MS, label) as Promise<T>);
    // 队列本体不管成败都继续走（切片第 6 节的节奏）
    sendChain = task.then(
      () => sleep(sendDelayMs),
      (error) => {
        log('error', `${label}失败: ${(error as Loose)?.message ?? error}`);
        return sleep(sendDelayMs);
      },
    );
    return task;
  }

  function enqueueSend(kind: Loose, targetId: Loose, parts: Loose) {
    return serial(`发送（${kind}:${targetId}）`, async bot => {
      const segments = buildSegments(parts);
      const result = await (kind === 'group' ? bot.sendGroupMessage(targetId, segments) : bot.sendPrivateMessage(targetId, segments));
      return { messageId: String(result?.message_id ?? '') };
    });
  }

  /**
   * 收藏表情（id 和备注），缓存 5 分钟。备注里写着「炸毛生气」「爱心眼捧脸（好耶）」这种话，
   * 她按意思挑就行，不用记十五位的 hex。
   */
  let faces: { at: number; list: { id: string; desc: string }[] } | undefined;
  async function faceList(): Promise<{ id: string; desc: string }[]> {
    if (faces && Date.now() - faces.at < 5 * 60_000) return faces.list;
    if (!client) throw new Error('QQ 桥未启动或已停止，拿不到收藏表情');
    const res = await withTimeout(client.request('fetch_custom_face_detail', { count: 50 }), SEND_TIMEOUT_MS, '拉收藏表情') as Loose;
    const list = (Array.isArray(res?.data) ? res.data as Loose[] : [])
      .map(face => ({ id: String(face?.emoji_id ?? ''), desc: String(face?.desc ?? '') }))
      .filter(face => face.id);
    faces = { at: Date.now(), list };
    return list;
  }
  async function resolveFace(wanted: Loose): Promise<string> {
    const raw = String(wanted ?? '').trim();
    if (raw.length > 20 || raw.includes('_')) return raw; // 已经是 emoji_id
    const list = await faceList();
    if (!raw || /^\d{1,3}$/.test(raw)) {
      const hit = list[Number(raw || '1') - 1];
      if (!hit) throw new Error(`没有第 ${raw || 1} 个收藏表情（一共 ${list.length} 个）`);
      return hit.id;
    }
    const key = raw.toLowerCase();
    const hit = list.find(face => face.desc.toLowerCase().includes(key))
      // 整词对不上就按字松一点找（备注里常有括号、标点），再查一张小同义表。
      ?? list.find(face => [...key].filter(char => char.trim()).every(char => face.desc.toLowerCase().includes(char)))
      ?? (FACE_ALIASES[raw] ?? []).map(alias => list.find(face => face.desc.includes(alias))).find(Boolean);
    if (!hit) throw new Error(`没有跟「${raw}」对得上的收藏表情；现有：${list.map(face => face.desc).join(' / ')}`);
    return hit.id;
  }

  function buildClient() {
    const bot = new SnowLumaWebSocketClient({
      url: opts.wsUrl || DEFAULT_WS_URL,
      // Node 22's built-in WebSocket can error without close; ws lets the SDK settle failed connects.
      webSocket: SnowlumaSocket,
      // 空串会让鉴权头变成 `Bearer `，某些网关直接 401 —— 必须 || undefined（切片第 1 节）
      accessToken: opts.accessToken || undefined,
      requestTimeoutMs: 30000,
      // 红线 2：重连交给 SDK（默认 1s→2s→4s… 指数退避，上限 30s，无限次）
      reconnect: true,
    });

    // 三个低层事件都必须挂 handler；error 不挂会被静默吞掉（SDK 手册：事件回调里抛错
    // 只会变成低层 error 事件，无监听器时直接丢弃）
    bot.on('open', () => {
      setState('online');
      log('info', `WS 已连接 ${bot.url}`);
    });
    bot.on('close', (info: Loose) => {
      if (stopped) {
        setState('closed');
      } else {
        // 非用户主动关闭：SDK 会自动重连，这段时间的真实状态是「连接中」
        setState('connecting');
      }
      log('warn', `WS 关闭 code=${info?.code ?? '?'} reason=${info?.reason ?? '?'}${stopped ? '' : '（SDK 将自动重连）'}`);
    });
    bot.on('error', (error: Loose) => {
      log('error', `WS 错误: ${error?.message ?? String(error)}`);
    });

    bot.onGroupMessage(handleGroupEvent);
    bot.onPrivateMessage(handlePrivateEvent);
    // 全量通知一个入口，内部按 notice_type 归一化（含 bot_status → bot_online/bot_offline）
    bot.onNotice(handleNoticeEvent);
    return bot;
  }

  return {
    async start() {
      if (client) return;   // 已在启动/运行中；connect() 本身幂等，不建第二个客户端
      stopped = false;
      setState('connecting');
      let bot;
      try {
        bot = buildClient();
      } catch (error) {
        stopped = true;
        setState('closed');
        log('error', `创建 SDK 客户端失败: ${(error as Loose)?.message ?? error}`);
        throw error;
      }
      client = bot;
      try {
        await bot.connect();
        log('info', '桥已启动');
      } catch (error) {
        // 首连失败按契约 reject 得清楚；客户端保留，SDK reconnect 会按退避自动重试
        // （closed-before-opening 属于「非用户主动关闭」，重连条件成立），状态保持 connecting
        if (client === bot) log('error', `首次连接失败: ${(error as Loose)?.message ?? error}（SDK 将按退避自动重连）`);
        throw error;
      }
    },

    async stop() {
      stopped = true;
      const bot = client;
      client = null;
      if (bot) {
        // SDK 是 close(code?, reason?)，没有 disconnect()；close() 会阻止自动重连并
        // 把 pending 请求 reject 成 ConnectionError。包一层保证幂等（连调两次不抛）
        try { bot.close(); } catch (error) { log('warn', `关闭 WS 时出错: ${(error as Loose)?.message ?? error}`); }
      }
      setState('closed');
    },

    async sendGroup(groupId: Loose, parts: Loose) {
      const id = Number(groupId);
      if (!Number.isFinite(id)) throw new Error(`sendGroup: 无效的群号 ${JSON.stringify(groupId ?? null)}`);
      return enqueueSend('group', id, parts);
    },

    async sendPrivate(userId: Loose, parts: Loose) {
      const id = Number(userId);
      if (!Number.isFinite(id)) throw new Error(`sendPrivate: 无效的 QQ 号 ${JSON.stringify(userId ?? null)}`);
      return enqueueSend('private', id, parts);
    },

    async getImage(file: string): Promise<string> {
      if (!client) throw new Error('QQ 桥未启动或已停止，无法取图');
      const { url, file_url: fileUrl } = (await client.getImage({ file }, { timeoutMs: SEND_TIMEOUT_MS })) ?? {};
      if (typeof url === 'string' && url) return url;
      if (typeof fileUrl === 'string' && fileUrl) return fileUrl;
      throw new Error('SnowLuma 未返回图片直链');
    },

    /**
     * 发账号收藏表情：它走 `send_custom_face`，不是消息段，只能单发一条。`emojiId` 可以是 emoji_id、
     * 第几个（1 起），或者一个意思（「开心」）——按备注挑。
     */
    async sendCustomFace(emojiId: Loose, target: { groupId?: Loose; userId?: Loose }) {
      const { groupId, userId } = target ?? {};
      if ((groupId == null) === (userId == null)) throw new Error('sendCustomFace: 群号和 QQ 号必须且只能给一个');
      const emoji = await resolveFace(emojiId);
      return serial('发收藏表情', async bot => {
        const raw = await bot.request('send_custom_face', groupId != null ? { emoji_id: emoji, group_id: Number(groupId) } : { emoji_id: emoji, user_id: Number(userId) });
        return { messageId: String(raw?.data?.message_id ?? '') };
      });
    },

    /** 发一条 QQ 空间说说（`send_qzone_msg`）：图片可选，`ugcRight` 缺省 1（所有人可见）。 */
    async publishQzone(content: string, options?: { images?: string[]; ugcRight?: number }) {
      return serial('发说说', async bot => {
        const raw = await bot.request('send_qzone_msg', { content, ugc_right: options?.ugcRight ?? 1, ...(options?.images?.length ? { images: options.images } : {}) });
        const data = raw?.data ?? raw;
        return { tid: String(data?.tid ?? ''), time: Number(data?.time ?? 0) };
      });
    },

    /** @returns {BridgeState} */
    getState() {
      return state;
    },

    // 仅供测试的注入点（fixtures/README.md 认可的方式之一）：把一条 SDK 形状的事件
    // 直接灌进与真实收包相同的内部分发链，不经过网络。
    __emitForTest(event: Loose) {
      const post = event?.post_type;
      if (post === 'message' || post === 'message_sent') {
        if (event?.message_type === 'group') handleGroupEvent(event);
        else if (event?.message_type === 'private') handlePrivateEvent(event);
        return;
      }
      if (post === 'notice') handleNoticeEvent(event);
    },
  };
}
