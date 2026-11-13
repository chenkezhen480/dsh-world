import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import { durableWrite } from './life/lifeStore.ts';
import { MOODS, parseMood } from './mood.ts';
import { OutsideWorldError } from './worldScope.ts';

const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };

/**
 * One call to write her mood, so it is no harder to change than to feel: the whole of mood.md is replaced with what she
 * passes. A line she got wrong refuses the write and says why, instead of leaving her a file the snapshot cannot read.
 */
export function moodTools(file: string, inside: () => boolean): ToolDefinition[] {
  return [defineTool({
    name: 'set_mood',
    description: `记下我此刻的心情，由我自己决定什么时候记、记什么。mood 整份替换 room/mood.md，一行一件：「名字 数值」是一种心情，数值是 0 到 10 的整数，比如「开心 6」；名字只能是固定的这几个：${MOODS.join('、')}，没写的算 0。想说得更细，写进不以数字结尾的行，那是心情旁边的小事，最多三行。记下后，下一步就在时间前面看到。`,
    parameters: { mood: { type: 'string', required: true } },
    output,
    execute: async ({ mood }) => {
      if (!inside()) throw new OutsideWorldError();
      const parsed = parseMood(typeof mood === 'string' ? mood : '');
      if (parsed.kind === 'none') throw new Error('没有写任何心情，这次没有改动');
      if (parsed.kind === 'mood' && parsed.outside.length) throw new Error(`${parsed.outside.join('、')} 不在固定的心情里，这次没有改动：只能用 ${MOODS.join('、')}；更细的感受写进小事那几行`);
      if (parsed.kind === 'mood' && parsed.unread) throw new Error(`有 ${parsed.unread} 行没读懂，这次没有改动：心情要写成「名字 数值」，数值是 0 到 10 的整数`);
      durableWrite(file, `${(mood as string).trim()}\n`);
      return '已记下。';
    },
  })];
}
