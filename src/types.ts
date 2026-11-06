import type { OutletConfig } from './ecosystem/shared/outlets.ts';
import type { SessionHeader } from '@deepseek-ai/dsh-session';
import type { SpeakerIdentity } from './ecosystem/shared/identity.ts';
import type { MemoryArchiveScope } from './archiveSelection.ts';

export interface WorldConfig {
  worldId: string;
  agentPreset: string;
  timeZone: string;
  /** Archive her current home alone, or ordinary sessions in its workspace (default). */
  archiveScope?: MemoryArchiveScope;
  /** The life line (home session, alarm, tools, console); on by default. */
  life?: boolean;
  /** On the first start in a profile, switch its stock compaction row to the tool-free one (restart to load it); on by default. */
  replaceCompaction?: boolean;
  /** Her diary directory; defaults to `<world>/diary`. */
  diaryDir?: string;
  /** Local HH:MM of the morning wake when no alarm is pending (she set none, or cancelled hers); 09:00 by default. */
  fallbackWakeTime?: string;
  /** Her own "who I am" file, part of the world prompt; defaults to `<world>/room/我是谁.md` in the plugin. */
  selfFile?: string;
  /** Her name (home title, notifications, memory labels); TA when unset. */
  companionName?: string;
  /** What she calls her partner in the plugin's own words; 伙伴 when unset. */
  partnerName?: string;
  /** Her layered persona, edited in the world console; defaults to `<world>/persona.md`. */
  personaFile?: string;
  /** The world prompt template; defaults to `<world>/world-prompt.md` when it exists, else the shipped one. */
  worldPromptFile?: string;
  /** The alarm wording template; defaults to `<world>/alarm.md` when it exists, else the shipped one. */
  alarmTemplateFile?: string;
  /** Where her words go outside DSH: replies to bridged words, the busy notice, reach_out. */
  outlets?: OutletConfig[];
  /** Runs the bridge: a local app may hand her partner's words to her home. */
  bridge?: boolean;
  /** The independent local WeChat module; the Windows adapter uses `<world>/wechat.json`. */
  wechat?: boolean;
  /** QQ straight to OneBot: no qq-bridge process, the plugin owns the sockets, the sessions and the state. */
  qqNative?: { enabled?: boolean; wsUrl?: string; accessToken?: string; allowPrivate?: string[]; ownerQQ?: string; allowGroups?: string[]; autoReply?: boolean; batchQuietMs?: number; contextMessages?: number; bindHomeSession?: 'owner' | 'all' | 'none' | '';
    /** 群里什么时候接话：mention 只接被叫到的（被 @ / 被引用她的话 / 命中关键词），all 每句都接。 */
    groupTrigger?: 'mention' | 'all';
    /** 群里命中这些词也算在叫她。 */
    groupKeywords?: string[];
    /** 只停嘴不停耳：这个时间（ISO）之前照收、照记上下文，但一句都不回；到点自己醒。空着就是没静默。 */
    mutedUntil?: string;
    /** SnowLuma 装在哪；空着就靠猜（D:\SnowLuma、C:\SnowLuma、~/SnowLuma）。 */
    snowlumaHome?: string;
    /** 看门狗：通道开着时盯住 wsUrl 的端口，不通且没有实例时按 snowlumaHome 拉起。默认开。 */
    supervise?: boolean;
    /** 阳台：让这台机器上别的程序能跟家里说话（一行一条 JSON 的 WebSocket）。port 为 0 就不开。 */
    bridge?: { port?: number; token?: string; title?: string; contextMessages?: number };
  };
  /** With `wechat`, run the Windows adapter for as long as the module runs; naming both here is the standing permission for it to send (`--allow-send`). */
  wechatAdapter?: { python?: string; config?: string };
  /** reach_out also shows a system notification (Windows only); on by default. */
  toast?: boolean;
  /** The desktop's notification identity (AppUserModelID); found in the Start menu when absent. */
  toastAppId?: string;
  /** Names besides this machine the console and the bridge answer to (a LAN address or domain behind a reverse proxy). */
  allowedHosts?: string[];
  // 外面那个 qq-bridge 进程在 2026-10-27 拆掉了，它的五个配置键（qqBridgeDir/Port/Node/AutoStart/
  // BindHomeSession）一起没了：QQ 现在由 qqNative 自己直连 OneBot。
}
export interface DeliveryState { status: 'pending' | 'sent' | 'uncertain' | 'failed'; confirmed: number; total: number }
export interface ConversationRecord extends Partial<SpeakerIdentity> {
  schemaVersion: 1;
  worldId: string;
  recordId: string;
  sourceSessionId: string;
  sourceMessageId: string;
  sourceSeq: number;
  turnId: string;
  role: 'user' | 'assistant';
  occurredAt: string;
  content: string;
  status: 'complete' | 'interrupted';
  wechatDelivery?: DeliveryState;
}
export interface ArchiveScope {
  worldId: string;
  header: SessionHeader;
  inheritedEventCount: number;
  turn: number;
}
export interface ArchiveCursor {
  date: string;
  occurredAt: string;
  recordId: string;
  maxSequence: number;
}
export interface PageQuery {
  before?: ArchiveCursor;
  limit: number;
}
export interface RecordPage {
  records: ConversationRecord[];
  nextCursor?: ArchiveCursor;
}
export interface ConversationTurn {
  turnId: string;
  occurredAt: string;
  messages: ConversationRecord[];
}
export interface ArchiveReader {
  readPage(query: PageQuery): Promise<RecordPage>;
  readTurn(turnId: string, afterSeq?: number, limit?: number): Promise<ConversationRecord[]>;
}
