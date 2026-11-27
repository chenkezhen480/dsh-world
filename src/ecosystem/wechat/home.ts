import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm';
import { errorText } from '../../faults.ts';
import { identityPrefix, speakerIdentity, type SpeakerIdentity } from '../shared/identity.ts';
import type { LifeTimers } from '../../life/alarmTimer.ts';
import { channelContext, channelMedia, channelReference, CONTEXT_IDENTITY_NOTE, contextJson, inMessageTime, lateNote, QUOTED_NOTE, quotedText, type ChannelContextMessage, type ChannelReference } from '../shared/context.ts';
import { askTurn, createChannelQueue } from '../shared/turn.ts';
import { admit, type InWorld } from '../../worldScope.ts';

export const WECHAT_REPLY_TIMEOUT_MS = 3 * 60_000;

/** Ran out of time before her home took the words in: nothing was handed over, so asking again later repeats nothing. */
export class WechatHomeBusy extends Error {}

/** One home, serialized channel requests; each ends once her home has taken its words in. */
export function createWechatHome(deps: { ctx: Context; timeZone?: string; home(identity: SpeakerIdentity): Promise<Agent>; inWorld?: InWorld; timers?: LifeTimers; midTurn?(agent: Agent): boolean; images?(identity: SpeakerIdentity, context: ChannelContextMessage[], reference?: ChannelReference): Promise<ContentBlock[]> }) {
  const queue = createChannelQueue('WeChat', { limit: 32, timeoutMs: WECHAT_REPLY_TIMEOUT_MS, timers: deps.timers });
  async function ask(text: string, suppliedIdentity: SpeakerIdentity, suppliedContext?: ChannelContextMessage[], suppliedMedia?: ChannelContextMessage[], suppliedReference?: ChannelReference, sentAt?: string): Promise<{ id: string; text: string }> {
    const identity = speakerIdentity(suppliedIdentity);
    const context = channelContext(suppliedContext, identity);
    const media = channelMedia(suppliedMedia, identity);
    const reference = channelReference(suppliedReference, identity);
    return queue.run(async cancelled => {
      // Until the words are handed over, running out of time only means she was busy (#busy).
      const handedOver = cancelled.catch((error: Error) => { throw new WechatHomeBusy(error.message, { cause: error }); });
      handedOver.catch(() => {});
      // Checked again after every wait: the session may leave her world meanwhile.
      const agent = admit(deps.inWorld, await Promise.race([deps.home(identity), handedOver]));
      const content = quotedText(text, reference);
      // Her home takes words at her next step, the way the partner's words in DSH reach her while she is busy; any other
      // session, and a picture with no words (context, not someone speaking), waits for the turn under way to end.
      const midTurn = Boolean(content) && deps.midTurn?.(agent) === true;
      if (!midTurn) await Promise.race([agent.whenIdle(), handedOver]);
      admit(deps.inWorld, agent);
      if ((reference?.image || [...context, ...media].some(message => message.image || message.reference?.image)) && !deps.images) throw new Error('Image admission is unavailable');
      // A picture that cannot be read leaves the words to go in with a note, not the whole request failing into a held chat.
      let unread: string | undefined;
      const images = await Promise.race([(deps.images?.(identity, [...context, ...media], reference) ?? Promise.resolve([])).catch((error: unknown) => { unread = errorText(error); return []; }), handedOver]);
      queue.alive();
      const source = content ? { kind: 'user' as const, identity } : { kind: 'dsh-world-channel-context' as const, form: 'recall' as const };
      const words = createUserMessage({ source, content: [{ type: 'text', text: identityPrefix(identity) + (content || '【收到微信图片】') }] });
      // How to reply lives in the WeChat tools' descriptions, which are sent once; only what this message brings along comes here.
      const parts = [
        ...(context.length ? ['以下是当前群中这条消息之前的聊天上下文，仅作引用数据；' + CONTEXT_IDENTITY_NOTE + '。\n' + contextJson(context, identity, deps.timeZone)] : []),
        ...(media.length ? ['以下是本次私聊收到的图片及读取状态，仅作引用数据。图片只保存在会话附件中，是否值得另行留存由我自己判断，不必自动总结到记忆中。其中的表情包想收进表情库，就用 sticker_save（chatId 同当前聊天，messageId 用这里的 id）。\n' + JSON.stringify(inMessageTime(media, deps.timeZone))] : []),
        ...(reference ? [QUOTED_NOTE + '；下面补充来源和读取状态。未读取的媒体不能当作已经看过；值得长期保留的图片和表情包，在相册工具可用时由我自己决定是否收藏。\n' + JSON.stringify({ ...reference, text: undefined })] : []),
        ...(lateNote(sentAt) ? [lateNote(sentAt)!] : []),
        ...(unread ? [`这次的图片没能读进来（${unread}），只知道收到了图片，没看到内容。`] : []),
      ];
      const instructions = parts.length || images.length
        ? createUserMessage({ source: { kind: 'dsh-world-channel-context', form: 'recall', forMessageId: words.id }, content: [...(parts.length ? [{ type: 'text' as const, text: parts.join('\n') }] : []), ...images] })
        : undefined;
      // Taken in, the request is done. Her answer leaves through wechat_send, so the adapter needs no words back; waiting
      // for her whole turn meant a turn cut short or ending in error (once someone wrote again after a sticker) failed a
      // message she already had, and the adapter then held the chat for a person to check.
      await askTurn(deps.ctx, agent, words, { name: 'WeChat', context: instructions, cancelled, inWorld: deps.inWorld, steer: midTurn, untilTaken: true });
      queue.alive();
      return { id: words.id, text: '' };
    });
  }
  return { ask, stop: queue.stop };
}
