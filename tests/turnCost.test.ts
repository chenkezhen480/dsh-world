// tests/turnCost.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import { addStep, openTurn, TURNS_KEPT, turnTrigger } from '../src/life/turnCost.ts';
import type { Spend } from '../src/life/types.ts';

const message = (source: Record<string, unknown>, text: string) => createUserMessage({ source: source as UserMessage['source'], content: [{ type: 'text', text }] });

test('a turn is named by what started it, never by what travels with it', () => {
  assert.equal(turnTrigger(message({ kind: 'user' }, '帮我看看这个视频讲了什么，顺便把重点记进你的笔记里好不好')), 'DSH：帮我看看这个视频讲了什么，顺便把重点记进你的笔记…');
  assert.equal(turnTrigger(message({ kind: 'user', identity: { channel: 'wechat' } }, '【微信「viva la vida」，chatId wxid_x】\n在吗')), '微信：在吗');
  assert.equal(turnTrigger(message({ kind: 'user', identity: { channel: 'qq' } }, '【QQ 私聊「阿澄」，chatId 42】\n晚上好')), 'QQ：晚上好');
  assert.equal(turnTrigger(message({ kind: 'dsh-world-life' }, '【我的时间】2026-11-17 快过完了，回头看看今天吧。')), '她的时间：2026-11-17 快过完了，回头看看今天吧。');
  assert.equal(turnTrigger(message({ kind: 'compact-checkpoint' }, '以下是此前交流的摘要')), '压缩后接着做');
  for (const kind of ['dsh-world-history', 'dsh-world-elsewhere', 'dsh-world-mood', 'time-context', 'runtime-context', 'skill-catalog', 'dsh-world-channel-context'])
    assert.equal(turnTrigger(message({ kind }, '注入的上下文')), undefined, kind);
});

test('a turn adds up its steps and tools, and only the latest ones are kept', () => {
  const spend: Spend = { day: '2026-11-18', yuan: 0 };
  const turn = openTurn(spend, new Date('2026-11-18T06:00:00Z'));
  addStep(turn, { yuan: 0.6, hit: 5000, miss: 315000, out: 380, tools: ['computer_use'] });
  addStep(turn, { yuan: 0.03, hit: 320000, miss: 1800, out: 620, tools: ['desktop', 'desktop'] });
  assert.deepEqual({ ...turn, yuan: Math.round(turn.yuan * 100) }, { at: '2026-11-18T06:00:00.000Z', trigger: '', steps: 2, yuan: 63, hit: 325000, miss: 316800, out: 1000, tools: { computer_use: 1, desktop: 2 }, ended: false });
  for (let n = 0; n < TURNS_KEPT + 3; n++) openTurn(spend, new Date());
  assert.equal(spend.turns!.length, TURNS_KEPT);
  assert.ok(!spend.turns!.includes(turn), 'the oldest falls off');
});
