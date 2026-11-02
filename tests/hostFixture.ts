import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import Agents from '@deepseek-ai/dsh-agent';
import Loop from '@deepseek-ai/dsh-agent-loop';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import * as persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import BasicCompaction from '@deepseek-ai/dsh-compaction-basic';
import type { TestContext } from 'node:test';

/** `personaPrefix`: the deployment's own system persona, as DSH's settings would give the system prompt plugin. */
export async function hostFixture(t: TestContext, stream: (request: GenerateOptions) => AsyncIterable<StreamChunk>, options: { personaPrefix?: string; includeHarnessIdentity?: boolean } = {}) {
  // The host keeps workspace paths in their real form; a Windows temp folder may be an 8.3 short name (CI's RUNNER~1).
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-world-host-')));
  const ctx = new Context();
  const cleanup: (() => Promise<unknown> | unknown)[] = [];
  t.after(async () => { try { for (const stop of cleanup.reverse()) await stop(); await ctx.fiber.dispose(); } finally { await rm(root, { recursive: true, force: true }); } });
  ctx.plugin(Sessions); ctx.plugin(Projections); ctx.plugin(Agents); ctx.plugin(SystemPrompt, { ...(options.personaPrefix === undefined ? {} : { personaPrefix: options.personaPrefix }), ...(options.includeHarnessIdentity === undefined ? {} : { includeHarnessIdentity: options.includeHarnessIdentity }) }); ctx.plugin(Tools); ctx.plugin(LlmRuntime);
  const storage = ctx.plugin(persistence, { root: join(root, 'sessions'), compression: 'none' });
  await storage.await();
  await ctx.plugin(Loop, { agents: [], maxParallelToolCalls: 10 }).await();
  class Adapter extends LlmAdapter {
    override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 1048576 }, defaultMaxTokens: 4096 }; }
    override stream(request: GenerateOptions) { return stream(request); }
  }
  ctx.llm.registerAdapter(['test'], new Adapter());
  assert.ok(ctx.agentLoop);
  const errors: unknown[] = [];
  ctx.on('agent/error', payload => { errors.push(payload); });
  return { ctx, root, cleanup, errors };
}
export async function* textResponse(text: string): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}
export async function mountCompaction(ctx: Context, auto = false, thresholdRatio = 0.8) {
  await ctx.plugin(TokenMeter).await();
  await ctx.plugin(BasicCompaction, { auto, thresholdRatio, retainTokens: 1, headroomTokens: 0, maxTokens: 128 }).await();
}
