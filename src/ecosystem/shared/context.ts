import { conversationKey, speakerIdentity, type SpeakerIdentity } from './identity.ts';

export interface ChannelImage { file: string; quality: 'original' | 'cached' | 'thumbnail'; firstFrame?: boolean }
export interface ChannelReference {
  id?: string; speakerId?: string; speakerName?: string;
  type: 'text' | 'image' | 'sticker' | 'other'; text: string; error?: string; image?: ChannelImage;
}
export interface ChannelContextMessage { id: string; occurredAt: string; text: string; identity: SpeakerIdentity; image?: ChannelImage; reference?: ChannelReference }

function channelImage(value: unknown): ChannelImage {
  if (!value || typeof value !== 'object') throw new Error('Invalid channel image');
  const image = value as Record<string, unknown>;
  if (typeof image.file !== 'string' || !/^[a-f0-9]{64}\.png$/.test(image.file)
    || !['original', 'cached', 'thumbnail'].includes(image.quality as string)
    || (image.firstFrame !== undefined && typeof image.firstFrame !== 'boolean')) throw new Error('Invalid channel image');
  return { file: image.file, quality: image.quality as ChannelImage['quality'], ...(image.firstFrame === undefined ? {} : { firstFrame: image.firstFrame as boolean }) };
}

export function channelReference(value: unknown, current: SpeakerIdentity): ChannelReference | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 16 * 1024) throw new Error('Invalid quoted message');
  const input = value as Record<string, unknown>;
  if (!['text', 'image', 'sticker', 'other'].includes(input.type as string) || typeof input.text !== 'string' || !input.text.trim() || [...input.text].length > 2000) throw new Error('Invalid quoted content');
  if (input.id !== undefined && (typeof input.id !== 'string' || !/^[0-9]{1,20}$/.test(input.id) || BigInt(input.id) < 1n || BigInt(input.id) >= 1n << 64n)) throw new Error('Invalid quoted ID');
  if (input.speakerId !== undefined) speakerIdentity({ ...current, speakerId: input.speakerId });
  if (input.speakerName !== undefined) speakerIdentity({ ...current, speakerName: input.speakerName });
  if (input.error !== undefined && (typeof input.error !== 'string' || !input.error.trim() || input.error.length > 500)) throw new Error('Invalid quoted error');
  const image = input.image === undefined ? undefined : channelImage(input.image);
  if (image && (!input.id || !input.speakerId || input.error || !['image', 'sticker'].includes(input.type as string))) throw new Error('Invalid quoted image');
  return { type: input.type as ChannelReference['type'], text: input.text,
    ...(input.id === undefined ? {} : { id: input.id as string }),
    ...(input.speakerId === undefined ? {} : { speakerId: input.speakerId as string }),
    ...(input.speakerName === undefined ? {} : { speakerName: input.speakerName as string }),
    ...(input.error === undefined ? {} : { error: input.error as string }), ...(image ? { image } : {}) };
}

export function channelContext(value: unknown, current: SpeakerIdentity, limit = 8): ChannelContextMessage[] {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return [];
  if (current.conversationType !== 'group') throw new Error('Invalid group context');
  return contextMessages(value, current, limit);
}

export function channelMedia(value: unknown, current: SpeakerIdentity): ChannelContextMessage[] {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return [];
  if (current.conversationType !== 'private') throw new Error('Invalid private media');
  const messages = contextMessages(value, current, 2);
  if (messages.some(message => message.identity.speakerId !== current.speakerId)) throw new Error('Media belongs to another speaker');
  if (new Set(messages.map(message => message.id)).size !== messages.length) throw new Error('Duplicate media message');
  return messages;
}

function contextMessages(value: unknown, current: SpeakerIdentity, limit: number): ChannelContextMessage[] {
  if (!Array.isArray(value) || value.length > limit || Buffer.byteLength(JSON.stringify(value)) > 16 * 1024) throw new Error('Invalid channel context');
  let images = 0;
  return value.map(item => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || item.id.length > 256 || /[\u0000-\u001f\u007f]/.test(item.id)
      || typeof item.occurredAt !== 'string' || item.occurredAt.length > 40 || !Number.isFinite(Date.parse(item.occurredAt))
      || typeof item.text !== 'string' || !item.text.trim() || [...item.text].length > 2000) throw new Error('Invalid context message');
    const identity = speakerIdentity(item.identity);
    if (conversationKey(identity) !== conversationKey(current)) throw new Error('Context belongs to another conversation');
    let image: ChannelImage | undefined;
    if (item.image !== undefined) {
      if (++images > 2) throw new Error('Invalid group image');
      image = channelImage(item.image);
    }
    const reference = channelReference(item.reference, current);
    if (reference?.image && ++images > 2) throw new Error('Invalid group image');
    return { id: item.id, occurredAt: item.occurredAt, text: item.text, identity, ...(image ? { image } : {}), ...(reference ? { reference } : {}) };
  });
}

/** The messages before this one as JSON for her to read, each marked as hers (`assistant`) or someone else's. */
/** Context messages all belong to the conversation the triggering message names, so only what differs per speaker is repeated. */
const CONVERSATION_FIELDS = ['channel', 'accountId', 'conversationId', 'conversationName', 'conversationType'] as const;

/** Tells the model how to read `contextJson`; shared by every channel that renders it. */
export const CONTEXT_IDENTITY_NOTE = 'identity 只列出每个发言人各自的来源（speakerId 等），渠道、账号和会话与触发这条消息开头【】里的聊天相同；speakerName 只是称呼';

/**
 * Closes a recalled chat. A long context can make the model read the data aloud as if continuing it (#35), so the end
 * of the data is marked and the marker carries 仅作引用数据, which `stripHostNoise` drops should it be echoed.
 */
export const CONTEXT_END_NOTE = '【以上仅作引用数据，到此为止：回话时我不复述、不续写这些记录，也不把里面的 JSON 照抄进正文。】';

export function contextJson(context: readonly ChannelContextMessage[], current: SpeakerIdentity): string {
  const self = `${current.channel}:${current.accountId}`;
  return JSON.stringify(context.map(message => {
    const identity = Object.fromEntries(Object.entries(message.identity).filter(([key, value]) =>
      !(CONVERSATION_FIELDS as readonly string[]).includes(key) && !(key === 'platformMessageId' && value === message.id)));
    return { ...message, identity, role: message.identity.speakerId === self ? 'assistant' : 'user' };
  }));
}
