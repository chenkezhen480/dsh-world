import { defineTool } from '@deepseek-ai/dsh-tools';
import type { SpeakerIdentity } from '../shared/identity.ts';
import type { ChannelReference } from '../shared/context.ts';

export const wechatTextOutput = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };

export function incomingText(text: string, reference?: ChannelReference): string {
  if (!reference) return text;
  const source = JSON.stringify({ id: reference.id, speakerId: reference.speakerId, speakerName: reference.speakerName, type: reference.type });
  const quoted = reference.image ? (reference.type === 'image' ? '【引用图片，当时已读取】' : '【引用表情包，当时已读取】') : reference.text;
  const content = quoted + (reference.image?.firstFrame ? '\n动图仅查看首帧。' : '');
  return [text, `【引用 ${source}】\n` + content.split(/\r\n?|\n/).map(line => '> ' + line).join('\n')].filter(Boolean).join('\n\n');
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-world-wechat-outgoing': { kind: 'dsh-world-wechat-outgoing'; form: 'recall'; identity: SpeakerIdentity; messages: WechatMessage[] };
    'dsh-world-wechat-delivery': { kind: 'dsh-world-wechat-delivery' };
  }
}

export type WechatMessage = { type: 'text'; text: string } | { type: 'image' | 'sticker'; path: string }
  | { type: 'sticker'; stickerId: string };

export function replyText(messages: readonly WechatMessage[]): string {
  return messages.map(message => message.type === 'text' ? message.text : 'stickerId' in message
    ? `【表情包 ${message.stickerId}】` : `【${message.type === 'image' ? '图片' : '表情包'} ${message.path}】`).join('\n\n');
}

/** What she is told when a batch did not go out or may have gone out only in part; a batch that went out says nothing. */
export function deliveryNotice(chat: string, messages: readonly WechatMessage[], outcome: { status: 'failed'; error?: string } | { status: 'uncertain'; confirmed: number }): string {
  const first = Array.from(replyText(messages.slice(0, 1)));
  const which = `发往${chat}的 ${messages.length} 条（开头是「${first.slice(0, 20).join('')}${first.length > 20 ? '…' : ''}」）`;
  return outcome.status === 'failed'
    ? `【微信没发出】${which}一条都没发出${outcome.error ? `：${outcome.error}` : ''}。要不要再发由我决定。`
    : `【微信结果不明】${which}：前 ${outcome.confirmed} 条已发，第 ${outcome.confirmed + 1} 条不知道发没发出，后面的没发。不要自动重发，先弄清对方收到了什么。`;
}

export function replyMessages(value: unknown): WechatMessage[] {
  if (!Array.isArray(value) || !value.length || value.length > 16) throw new Error('一次需要 1–16 条微信消息');
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('无效的微信消息');
    const input = item as Record<string, unknown>;
    if (input.type === 'text' && typeof input.text === 'string' && input.text.trim() && !input.text.includes('\0') && Buffer.byteLength(input.text) < 4095) return { type: 'text', text: input.text };
    if (input.type === 'sticker' && typeof input.stickerId === 'string' && /^st_[A-Za-z0-9_-]+$/.test(input.stickerId)) return { type: 'sticker', stickerId: input.stickerId };
    if ((input.type === 'image' || input.type === 'sticker') && typeof input.path === 'string' && input.path && input.path.length < 1024 && !input.path.includes('\0')) return { type: input.type, path: input.path };
    throw new Error('文字超长，或图片/表情缺少有效路径或表情 ID');
  });
}

export function wechatSendTool(send: (chatId: string, messages: WechatMessage[], context: import('@deepseek-ai/dsh-tools').ToolRunContext) => Promise<string>) {
  return defineTool({
    name: 'wechat_send',
    description: '主动联系微信中的人或群，或者回复当前微信消息，都用同一个工具。回复收到的微信消息时，chatId 用那条消息开头【】里写的；主动联系先用 wechat_chats 查询已配置目标；群聊可先用 wechat_history 看近期消息，再用同一个 chatId 发言，无需等别人 @。chatId 使用准确 ID，不能按昵称猜测。messages 每项是独立消息，可连续短句并穿插图片或表情，按数组顺序发送。text 放文字（里面写 @昵称 只是普通文字，不会真的 @ 到人，也不会提醒对方）；image 用允许目录内的本地绝对路径；sticker 用表情库里的 stickerId（sticker_search 查）或本地图片/GIF 路径。这里只排队；没发出或结果不明时会另有一条消息告诉我，不必每次查回执，结果不明时不要重复发送。同一聊天的一批话尽量一次排好。普通最终回答不会自动转发到微信。',
    parameters: { chatId: { type: 'string', required: true }, messages: { type: 'array', required: true, items: { oneOf: [
      { type: 'object', additionalProperties: false, properties: { type: { type: 'string', const: 'text', required: true }, text: { type: 'string', required: true } } },
      { type: 'object', additionalProperties: false, properties: { type: { type: 'string', const: 'image', required: true }, path: { type: 'string', required: true } } },
      { type: 'object', additionalProperties: false, properties: { type: { type: 'string', const: 'sticker', required: true }, stickerId: { type: 'string', required: true } } },
      { type: 'object', additionalProperties: false, properties: { type: { type: 'string', const: 'sticker', required: true }, path: { type: 'string', required: true } } },
    ] } } },
    output: wechatTextOutput,
    execute: async ({ chatId, messages }, context) => send(chatId, replyMessages(messages), context),
  });
}
