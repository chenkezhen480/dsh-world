import assert from 'node:assert/strict';
import test from 'node:test';
import { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import { hostFixture, textResponse } from './hostFixture.ts';
import ToolFreeCompaction, { compactionThreshold, toolFreeMessages } from '../src/compaction.ts';

test('compaction replays the conversation prefix minus tool calls and results, then commits one paragraph with no tool tail', async t => {
  const summaries: GenerateOptions[] = []; const conversation: GenerateOptions[] = []; let conversationCalls = 0;
  const { ctx, errors } = await hostFixture(t, async function* (request) {
    if (request.purpose === 'compaction') { summaries.push(request); yield* textResponse('第一段\n\n第二段'); return; }
    conversation.push(request);
    if (++conversationCalls === 1) {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'before tool visible text' } };
      const block = { type: 'tool-call' as const, id: ToolCallId('private-call'), name: 'work', arguments: '{"value":"PRIVATE_TOOL_ARGUMENT"}' };
      yield { type: 'block-start', index: 1, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 1, id: block.id, name: 'work', argumentsDelta: block.arguments };
      yield { type: 'block-end', index: 1, block };
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
    }
    yield* textResponse('after tool visible text');
  });
  ctx.tools.register(defineTool({ name: 'work', description: 'PRIVATE_TOOL_SCHEMA', parameters: { value: { type: 'string', required: true } }, output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] }, execute: async () => 'PRIVATE_TOOL_RESULT' }));
  await ctx.plugin(TokenMeter).await();
  await ctx.plugin(ToolFreeCompaction, { auto: false, timeZone: 'Asia/Seoul', headroomTokens: 0, maxTokens: 128 }).await();
  const handle = await ctx.agents.create({ sessionId: SessionId('tool-free'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'real user request ' + 'context detail '.repeat(200) }] })); await handle.agent.whenIdle();
  assert.equal(errors.length, 0); assert.equal(conversationCalls, 2);
  const result = await ctx.compaction.compactNow(handle.agent, new AbortController().signal);
  assert.ok(result); assert.equal(summaries.length, 1);
  const request = summaries[0];
  assert.ok(!request.messages.some(message => message.role === 'tool' || message.content.some(block => block.type === 'tool-call')));
  const text = JSON.stringify(request.messages);
  for (const removed of ['PRIVATE_TOOL_ARGUMENT', 'PRIVATE_TOOL_RESULT']) assert.ok(!text.includes(removed));
  for (const kept of ['real user request', 'before tool visible text', 'after tool visible text']) assert.ok(text.includes(kept), kept);
  // Same prefix as the last conversation request up to the first removed tool call, so the provider cache applies.
  const last = conversation.at(-1)!.messages;
  const firstTool = last.findIndex(message => message.role === 'tool' || message.content.some(block => block.type === 'tool-call'));
  assert.ok(firstTool > 0); assert.deepEqual(request.messages.slice(0, firstTool), last.slice(0, firstTool));
  assert.deepEqual(request.tools, conversation.at(-1)!.tools);
  assert.equal(request.messages.filter(message => message.role === 'assistant').length, 1, 'text around a removed call is rejoined');
  assert.deepEqual(result.summary, [{ type: 'text', text: '第一段 第二段' }]);
  assert.match(JSON.stringify(request.messages.at(-1)), /执行上下文压缩.*当前时间：.*时区：Asia\/Seoul/);
  const context = handle.agent.session.deriveMessages();
  assert.ok(!context.some(message => message.role === 'tool' || message.content.some(block => block.type === 'tool-call')));
  assert.equal(context.filter(message => message.role !== 'system').length, 1);
  assert.ok(handle.agent.session.snapshotEvents().some(event => event.type === 'tool/result'));
  assert.ok(handle.agent.session.snapshotEvents().some(event => event.type === 'plugin:dsh-world/compaction-request' as never));
});
test('failed or truncated summaries leave the original model context intact', async t => {
  const { ctx } = await hostFixture(t, async function* (request) {
    if (request.purpose === 'compaction') { yield { type: 'block-end', index: 0, block: { type: 'text', text: 'incomplete summary' } }; yield { type: 'finish', reason: { kind: 'max-tokens' } }; return; }
    yield* textResponse('complete original response');
  });
  await ctx.plugin(TokenMeter).await();
  await ctx.plugin(ToolFreeCompaction, { auto: false, timeZone: 'UTC', headroomTokens: 0, maxTokens: 128 }).await();
  const handle = await ctx.agents.create({ sessionId: SessionId('failed-summary'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'original user input' }] })); await handle.agent.whenIdle();
  const before = handle.agent.session.deriveMessages();
  await assert.rejects(ctx.compaction.compactNow(handle.agent, new AbortController().signal), error => error instanceof Error && String(error.cause).includes('truncated'));
  assert.deepEqual(handle.agent.session.deriveMessages(), before);
});
test('automatic compaction immediately after a tool result removes the entire paired tail', async t => {
  let conversationCalls = 0; const resumed: GenerateOptions[] = [];
  const { ctx, errors } = await hostFixture(t, async function* (request) {
    if (request.purpose === 'compaction') { yield* textResponse('已记住用户要求，继续完成任务。'); return; }
    if (++conversationCalls === 1) {
      const block = { type: 'tool-call' as const, id: ToolCallId('tail-call'), name: 'work', arguments: '{}' };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: '{}' };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
    }
    resumed.push(request); yield* textResponse('done');
  });
  ctx.tools.register(defineTool({ name: 'work', description: 'test', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'TAIL_TOOL_RESULT' }));
  await ctx.plugin(TokenMeter).await();
  await ctx.plugin(ToolFreeCompaction, { auto: true, timeZone: 'UTC', headroomTokens: 0, thresholdRatio: 0.0002, maxTokens: 128 }).await();
  const handle = await ctx.agents.create({ sessionId: SessionId('tool-tail'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'user facts '.repeat(300) }] })); await handle.agent.whenIdle();
  assert.equal(errors.length, 0, errors.map(error => String((error as { error: Error }).error)).join('\n'));
  assert.equal(resumed.length, 1);
  assert.ok(!resumed[0].messages.some(message => message.role === 'tool' || message.content.some(block => block.type === 'tool-call')));
});
test('compaction starts at 75% of the window, and earlier only when a reply would no longer fit', () => {
  const million = 1_048_576;
  assert.equal(compactionThreshold({ contextWindow: million, ratio: 0.75, reserved: 256_000 }), 786_432, 'the usual case: 75% of the window, however large the reply allowance');
  assert.equal(compactionThreshold({ contextWindow: million, ratio: 0.75, reserved: 32_000 }), 786_432);
  assert.equal(compactionThreshold({ contextWindow: 128_000, ratio: 0.75, reserved: 8_000 }), 96_000, 'no fixed headroom is taken off a small window');
  assert.equal(compactionThreshold({ contextWindow: 128_000, ratio: 0.75, reserved: 64_000 }), 64_000, 'a reply allowance above a quarter of the window pulls the trigger down so prompt and reply still fit');
  assert.equal(compactionThreshold({ contextWindow: million, ratio: 0.5, reserved: 0 }), 524_288, 'the ratio stays the one knob');
  assert.throws(() => compactionThreshold({ contextWindow: 100_000, ratio: 0.75, reserved: 100_000 }), /leaves no room/);
});

test('a model that declares no context window is compacted by an assumed window instead of never', async t => {
  const summaries: GenerateOptions[] = []; const conversation: GenerateOptions[] = [];
  const { ctx, errors } = await hostFixture(t, () => textResponse('the fixture adapter is not used here'));
  class Undeclared extends LlmAdapter {
    override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, defaultMaxTokens: 100 }; }
    override stream(request: GenerateOptions) {
      if (request.purpose === 'compaction') { summaries.push(request); return textResponse('摘要'); }
      conversation.push(request); return textResponse('reply');
    }
  }
  ctx.llm.registerAdapter(['undeclared'], new Undeclared());
  await ctx.plugin(TokenMeter).await();
  // The window is assumed to be 4000 tokens here, so 75% of it is 3000.
  await ctx.plugin(ToolFreeCompaction, { auto: true, timeZone: 'UTC', headroomTokens: 0, maxTokens: 128, defaultContextWindow: 4000 }).await();
  const handle = await ctx.agents.create({ sessionId: SessionId('undeclared'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'undeclared', model: 'any' } });
  handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'user facts '.repeat(1500) }] })); await handle.agent.whenIdle();
  assert.equal(summaries.length, 0, 'the first request is below the assumed trigger');
  handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'next' }] })); await handle.agent.whenIdle();
  assert.equal(summaries.length, 1, 'with the conversation past 75% of the assumed window, it was compacted before the next request');
  assert.equal(errors.length, 0, errors.map(error => String((error as { error: Error }).error)).join('\n'));
});
test('a later compaction replays the earlier paragraph for merging instead of the shadowed original', async t => {
  const summaries: GenerateOptions[] = [];
  const { ctx } = await hostFixture(t, async function* (request) {
    if (request.purpose === 'compaction') { summaries.push(request); yield* textResponse(`摘要${summaries.length}`); return; }
    yield* textResponse('reply ' + 'detail '.repeat(100));
  });
  await ctx.plugin(TokenMeter).await();
  await ctx.plugin(ToolFreeCompaction, { auto: false, timeZone: 'UTC', headroomTokens: 0, maxTokens: 128 }).await();
  const handle = await ctx.agents.create({ sessionId: SessionId('merge'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  for (const text of ['first input', 'second input']) {
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: text + ' context '.repeat(100) }] })); await handle.agent.whenIdle();
    assert.ok(await ctx.compaction.compactNow(handle.agent, new AbortController().signal));
  }
  const replayed = JSON.stringify(summaries[1].messages);
  assert.ok(summaries[1].messages.some(message => message.source?.kind === 'compact-checkpoint' && JSON.stringify(message.content).includes('摘要1')));
  assert.ok(replayed.includes('second input') && !replayed.includes('first input'));
  const context = handle.agent.session.deriveMessages().filter(message => message.role !== 'system');
  assert.equal(context.length, 1); assert.match(JSON.stringify(context[0].content), /摘要2/);
});
test('reasoning-only steps left by a removed tool call are dropped, and an echoed summary lead is not doubled', async t => {
  const call = { type: 'tool-call' as const, id: ToolCallId('c'), name: 'send_sticker', arguments: '{}' };
  const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
  const step = (text: string) => ({ id: text, role: 'assistant', source: { kind: 'model' }, content: [{ type: 'reasoning', text }, call] }) as never;
  const result = { id: 'r', role: 'tool', toolCallId: call.id, source: { kind: 'tool' }, content: [{ type: 'text', text: 'sent' }] } as never;
  assert.deepEqual(toolFreeMessages([user('hello'), step('pick a sticker'), result, user('again'), step('another'), result]).map(message => message.role), ['user', 'user']);
  const reply = (text: string) => ({ id: text, role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }, call] }) as never;
  const update = (text: string) => ({ id: text, role: 'developer', source: { kind: 'memory' }, content: [{ type: 'text', text }] }) as never;
  // DeepSeek Messages refuses an update that no longer follows a user or tool-result turn once the tool result is gone.
  const hello = user('hello');
  assert.deepEqual(toolFreeMessages([update('first'), hello, update('after user'), reply('looking'), result, update('after tool'), reply('found it')]).map(message => message.id),
    [hello.id, 'after user', 'looking']);
  const { ctx } = await hostFixture(t, async function* (request) {
    if (request.purpose === 'compaction') { yield* textResponse('以下是此前交流的摘要：用户打了招呼。'); return; }
    yield* textResponse('reply ' + 'detail '.repeat(100));
  });
  await ctx.plugin(TokenMeter).await();
  await ctx.plugin(ToolFreeCompaction, { auto: false, timeZone: 'UTC', headroomTokens: 0, maxTokens: 128 }).await();
  const handle = await ctx.agents.create({ sessionId: SessionId('lead'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  handle.agent.followup(user('hi ' + 'context '.repeat(100))); await handle.agent.whenIdle();
  const compacted = await ctx.compaction.compactNow(handle.agent, new AbortController().signal);
  assert.deepEqual(compacted?.summary, [{ type: 'text', text: '用户打了招呼。' }]);
  const checkpoint = JSON.stringify(handle.agent.session.deriveMessages().at(-1)!.content);
  assert.equal(checkpoint.split('以下是此前交流的摘要').length - 1, 1);
});
test('her own alarm messages stay in the summarized input and the instruction says they are hers, not the user\'s', async t => {
  const summaries: GenerateOptions[] = [];
  const { ctx } = await hostFixture(t, async function* (request) {
    if (request.purpose === 'compaction') { summaries.push(request); yield* textResponse('她起床了。'); return; }
    yield* textResponse('reply ' + 'detail '.repeat(100));
  });
  await ctx.plugin(TokenMeter).await();
  await ctx.plugin(ToolFreeCompaction, { auto: false, timeZone: 'UTC', headroomTokens: 0, maxTokens: 128 }).await();
  const handle = await ctx.agents.create({ sessionId: SessionId('home'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  handle.agent.followup(createUserMessage({ source: { kind: 'dsh-world-life' }, content: [{ type: 'text', text: '【我的时间】闹钟响了。ALARM_NOTE ' + 'context '.repeat(100) }] })); await handle.agent.whenIdle();
  assert.ok(await ctx.compaction.compactNow(handle.agent, new AbortController().signal));
  const input = summaries[0].messages;
  assert.ok(input.some(message => message.source?.kind === 'dsh-world-life' && JSON.stringify(message.content).includes('ALARM_NOTE')));
  const instruction = JSON.stringify(input.find(message => message.source?.kind === 'dsh-world-summary-input')!.content);
  assert.ok(instruction.includes('以【我的时间】（较早的是【你的时间】）开头的消息是你自己定的闹钟和留给自己的话，不是用户说的话；把它们当作你自己的安排来记，不要算作用户发言。'));
});
