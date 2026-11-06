import assert from 'node:assert/strict';
import test from 'node:test';
import { createUserMessage, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { hostFixture, textResponse } from './hostFixture.ts';
import { registerScopedTool } from '../src/worldScope.ts';

test('step admission follows scope changes and execution rechecks an in-flight request', async t => {
  let inside = false, calls = 0;
  const requests: GenerateOptions[] = [];
  const { ctx, cleanup, errors } = await hostFixture(t, async function* (request): AsyncIterable<StreamChunk> {
    const index = requests.push(request) - 1;
    if (index !== 1 && index !== 3) { yield* textResponse('ok'); return; }
    if (index === 1) inside = false;
    const block = { type: 'tool-call' as const, id: ToolCallId(`scope-${index}`), name: 'scope_probe', arguments: '{}' };
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: '{}' };
    yield { type: 'block-end', index: 0, block };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  });
  const { agent } = await ctx.agents.create({ sessionId: SessionId('scope'), agentOptions: { provider: 'test', model: 'test' } });
  if (!('resolve' in agent.ctx.tools)) { t.skip('step admission belongs to DSH 0.2.2 and later'); return; }
  cleanup.push(registerScopedTool(agent, defineTool({
    name: 'scope_probe', description: 'scope probe', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { calls++; return 'executed'; },
  }), () => inside));
  const ask = async () => {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }));
    await agent.whenIdle();
  };
  await ask();
  inside = true; await ask();
  assert.equal(calls, 0, 'leaving while the request is in flight prevents execution');
  inside = true; await ask();
  assert.equal(calls, 1, 're-entering uses the same registration again');
  assert.deepEqual(requests.slice(0, 4).map(request => request.tools?.some(tool => tool.name === 'scope_probe') ?? false), [false, true, false, true]);
  assert.deepEqual(errors, []);
});
