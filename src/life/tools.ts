import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Notifier } from './notify.ts';
import type { WorldNames } from '../worldPrompt.ts';
import { exampleTime, fillMessage, readAlarmMessages } from './messages.ts';
import { pushOf } from '../ecosystem/shared/outlets.ts';

export interface AlarmDescriptions { plan: string; check: string; cancel: string }
export interface RecallCall { query: string; from?: string; to?: string; sources?: readonly string[]; limit?: number; offset?: number }
export interface StatusCall { mood?: string; energy?: number; chips?: readonly string[]; note?: string }
export interface LifeToolHost {
  planNext(input: { at?: string; after_minutes?: number }, note: string): string;
  /** Searches the archive, the diary and the activity log; absent when the world has no memory to search. */
  recall?(input: RecallCall): string;
  /** Rewrites the status strip in the console; absent when the world has no place to keep it. */
  setStatus?(input: StatusCall): string;
  /** With both, check_alarm and cancel_alarm are offered too. */
  checkAlarm?(): string;
  cancelAlarm?(): string;
  notifier: Notifier;
  names?: WorldNames;
  /** The DSH origin, for sticker URLs in her words. */
  origin?(): string | undefined;
  /** From the alarm template; the shipped wording otherwise. */
  descriptions?: AlarmDescriptions;
}
export function alarmDescriptions(messages = readAlarmMessages(undefined), values: Record<string, string> = { example: exampleTime('UTC'), fallbackWakeTime: '09:00' }): AlarmDescriptions {
  return { plan: fillMessage(messages, 'plan_next 说明', values), check: fillMessage(messages, 'check_alarm 说明', values), cancel: fillMessage(messages, 'cancel_alarm 说明', values) };
}
const text = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };

export function lifeTools(host: LifeToolHost) {
  const { companion, partner } = host.names ?? { companion: 'TA', partner: '伙伴' };
  const descriptions = host.descriptions ?? alarmDescriptions();
  const planNext = defineTool({
    name: 'plan_next',
    description: descriptions.plan,
    parameters: { at: { type: 'string' }, after_minutes: { type: 'number' }, note: { type: 'string', required: true } },
    output: text,
    execute: async ({ at, after_minutes, note }) => host.planNext({ ...(at === undefined ? {} : { at }), ...(after_minutes === undefined ? {} : { after_minutes }) }, note),
  });
  const { toast, outlets } = host.notifier;
  const reaching = outlets.filter(outlet => outlet.kinds.includes('reach'));
  const channelNames = [...(toast ? ['系统通知'] : []), ...reaching.map(outlet => outlet.name)];
  const reachOut = defineTool({
    name: 'reach_out',
    description: `想找${partner}时用：先在家里正常把话说出来，再用它把这句话送到${partner}面前（${channelNames.length ? channelNames.join(' + ') : '现在还没有配置任何通道'}）。image 可选，是一个表情的名字，接收的一方认得才会显示。找${partner}时说一两句就好，细节留在家里，${partner}来了自己会看。`,
    parameters: { text: { type: 'string', required: true }, image: { type: 'string' } },
    output: text,
    execute: async ({ text: message, image }) => {
      if (!channelNames.length) throw new Error('现在还没有配置任何通道，话留在家里了。');
      const push = pushOf(message, 'reach', companion, host.origin?.(), image);
      const channels: [string, string, Promise<void>][] = [
        ...(toast ? [['系统通知', '已发出', toast.call(host.notifier, companion, message)] as [string, string, Promise<void>]] : []),
        ...reaching.map(outlet => [outlet.name, '已送到', outlet.send(push)] as [string, string, Promise<void>]),
      ];
      const results = await Promise.allSettled(channels.map(([, , sent]) => sent));
      const summary = `${results.map((result, index) => { const [name, done] = channels[index]!; return result.status === 'fulfilled' ? `${name}${done}` : `${name}没送到：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`; }).join('；')}。`;
      if (results.every(result => result.status === 'rejected')) throw new Error(summary);
      return summary;
    },
  });
  const { checkAlarm, cancelAlarm } = host;
  const recall = host.recall ? defineTool({
    name: 'recall',
    description: `想不起以前的事时用：翻${companion}的长期记忆——聊天归档、日记、活动记录，返回原话片段和出处行号。只搜关键词，不认语义：给一个词或几个人名地名，比一整句问话更容易搜到。sources 可选 chat / diary / activity；from、to 是 YYYY-MM-DD。搜不到就是没记过，别编。`,
    parameters: {
      query: { type: 'string', required: true },
      from: { type: 'string' }, to: { type: 'string' },
      sources: { type: 'array', items: { type: 'string' } },
      limit: { type: 'number' }, offset: { type: 'number' },
    },
    output: text,
    execute: async (args: RecallCall) => host.recall!(args),
  }) : undefined;
  const setStatus = host.setStatus ? defineTool({
    name: 'set_status',
    description: `更新状态卡：心情、精力、几个小标签，再加一句想让人看到的话。小标签写什么都行——今天几碗饭、窗外天气、尾巴酸不酸，最多 4 个，这次给的整组替换。状态卡在世界控制台「概览」的最上面，${partner}一打开就看得到。这次没写的项保持原样；心情一两个词，精力 0–100。`,
    parameters: { mood: { type: 'string' }, energy: { type: 'number' }, chips: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } },
    output: text,
    execute: async (args: StatusCall) => host.setStatus!(args),
  }) : undefined;
  const base = [planNext, ...(recall ? [recall] : []), ...(setStatus ? [setStatus] : []), reachOut] as const;
  if (!checkAlarm || !cancelAlarm) return base;
  const check = defineTool({ name: 'check_alarm', description: descriptions.check, parameters: {}, output: text, execute: async () => checkAlarm.call(host) });
  const cancel = defineTool({ name: 'cancel_alarm', description: descriptions.cancel, parameters: {}, output: text, execute: async () => cancelAlarm.call(host) });
  return [...base, check, cancel] as const;
}
