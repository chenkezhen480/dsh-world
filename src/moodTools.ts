import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import { durableWrite } from './life/lifeStore.ts';
import { MOODS, moodAge, moodUpdatedAt, parseMood } from './mood.ts';
import { appendLedger } from './moodLedger.ts';
import { OutsideWorldError } from './worldScope.ts';

const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };

/**
 * One call to write her mood, so it is no harder to change than to feel: the whole of mood.md is replaced with what she
 * passes. A line she got wrong refuses the write and says why, instead of leaving her a file the snapshot cannot read.
 * The wording names when moods move — a harsh word, a thing that worked out, someone she misses — so changing one is a
 * gesture, not a decision; how often is still hers, the prompt only asks that one mood not stand all day.
 */
export function moodTools(file: string, inside: () => boolean, now: () => number = Date.now): ToolDefinition[] {
  return [defineTool({
    name: 'set_mood',
    description: `记下我此刻的心情，由我自己决定什么时候记、记什么。心情是会变的：话说重了、事情成了、想起谁了，都可以随手改一条。mood 整份替换 room/mood.md，一行一件：「名字 数值」是一种心情，数值是 0 到 10 的整数，比如「开心 6」；名字只能是固定的这几个：${MOODS.join('、')}，没写的算 0。想说得更细，写进不以数字结尾的行，那是心情旁边的小事，最多三行。记下后，下一步就在时间前面看到。`,
    parameters: { mood: { type: 'string', required: true } },
    output,
    execute: async ({ mood }) => {
      if (!inside()) throw new OutsideWorldError();
      const parsed = parseMood(typeof mood === 'string' ? mood : '');
      if (parsed.kind === 'none') throw new Error('没有写任何心情，这次没有改动');
      if (parsed.kind === 'failed') throw new Error(`mood.md 读不出来，这次没有改动：${parsed.message}`);
      if (parsed.outside.length) throw new Error(`${parsed.outside.join('、')} 不在固定的心情里，这次没有改动：只能用 ${MOODS.join('、')}；更细的感受写进小事那几行`);
      if (parsed.unread) throw new Error(`有 ${parsed.unread} 行没读懂，这次没有改动：心情要写成「名字 数值」，数值是 0 到 10 的整数`);
      durableWrite(file, `${(mood as string).trim()}\n`);
      appendLedger(file, parsed);
      const updatedAt = moodUpdatedAt(file);
      return updatedAt === undefined ? '已记下。' : `已记下（${moodAge(updatedAt, now())} 的那条被换掉了）。`;
    },
  })];
}
