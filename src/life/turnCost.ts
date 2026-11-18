// src/life/turnCost.ts
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import { injectedSources } from '../compaction.ts';
import type { Spend, SpendTurn } from './types.ts';

/** The latest turns the console lists under today's spend. */
export const TURNS_KEPT = 8;
const SNIPPET = 24;
/** What the harness and the plugin put around a turn: never what started it. */
const AROUND = new Set([...injectedSources, 'runtime-context', 'skill-catalog', 'dsh-world-channel-context', 'dsh-world-wechat-outgoing']);
const CHANNELS: Record<string, string> = { wechat: '微信', qq: 'QQ' };

const snippet = (message: UserMessage) => {
  const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(' ')
    // A channel's words open with who and where (`identityPrefix`), her own with 【我的时间】: neither says what the turn is about.
    .replace(/^【[^】]*】\s*/, '').replace(/\s+/g, ' ').trim();
  return text.length > SNIPPET ? `${text.slice(0, SNIPPET)}…` : text;
};

/** What a message says started the turn it opens, or undefined when it only travels with the words that did. */
export function turnTrigger(message: UserMessage): string | undefined {
  const { source } = message;
  if (AROUND.has(source.kind)) return undefined;
  if (source.kind === 'user') {
    const channel = (source as { identity?: { channel?: string } }).identity?.channel;
    return `${channel ? CHANNELS[channel] ?? channel : 'DSH'}：${snippet(message)}`;
  }
  if (source.kind === 'dsh-world-life') return `她的时间：${snippet(message)}`;
  if (source.kind === 'compact-checkpoint') return '压缩后接着做';
  return source.kind;
}

/** A turn that just opened, at the end of the day's list; older ones fall off past TURNS_KEPT. */
export function openTurn(spend: Spend, at: Date): SpendTurn {
  const turn: SpendTurn = { at: at.toISOString(), trigger: '', steps: 0, yuan: 0, hit: 0, miss: 0, out: 0, tools: {}, ended: false };
  spend.turns = [...spend.turns ?? [], turn].slice(-TURNS_KEPT);
  return turn;
}

/** One model step of the turn under way: its cost, its tokens and the tools it called. */
export function addStep(turn: SpendTurn, step: { yuan: number; hit: number; miss: number; out: number; tools: readonly string[] }): void {
  turn.steps++; turn.yuan += step.yuan; turn.hit += step.hit; turn.miss += step.miss; turn.out += step.out;
  for (const tool of step.tools) turn.tools[tool] = (turn.tools[tool] ?? 0) + 1;
}
