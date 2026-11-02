import assert from 'node:assert/strict';
import test from 'node:test';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { ManualCompactionError, type CompactionEngine, type CompactionResult } from '@deepseek-ai/dsh-compaction';
import { compactionFor, createHomeApply } from '../src/console/homeApply.ts';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import ToolFreeCompaction from '../src/compaction.ts';
import { hostFixture, mountCompaction, textResponse } from './hostFixture.ts';
import { Context } from '@deepseek-ai/cordis';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const idle = deferred<void>();
  let summary = deferred<CompactionResult | null>();
  let calls = 0, refreshed = 0, current = true, busy = false, unavailable = false;
  const home = {
    id: 'home', session: { id: 'home' }, options: {}, whenIdle: () => idle.promise,
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>) {
      if (busy) { busy = false; throw new Error('already active'); }
      return task(new AbortController().signal);
    },
  } as unknown as Agent;
  const engine = {
    compactNow(agent, signal) {
      try {
        return agent.runMaintenance(async () => {
          calls++;
          return Promise.race([summary.promise, new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
        });
      } catch (error) { throw new ManualCompactionError('busy', 'busy', { cause: error }); }
    },
  } satisfies Pick<CompactionEngine, 'compactNow'>;
  let fault: string | undefined;
  const job = createHomeApply({ ctx: new Context(), home: async () => home, isHome: () => current, compaction: agent => unavailable || agent !== home ? undefined : engine, refresh: () => { refreshed++; }, changed() {}, fault: message => { fault = message; } });
  return { job, idle, get summary() { return summary; }, nextSummary: () => { summary = deferred(); }, calls: () => calls, refreshed: () => refreshed, fault: () => fault, moveHome: () => { current = false; }, race: () => { busy = true; }, unavailable: () => { unavailable = true; } };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('home apply did not settle');
}

test('home apply waits for idle, coalesces clicks, acquires maintenance and refreshes even with nothing to compact', async () => {
  const f = fixture();
  assert.equal(f.job.request(), undefined); f.job.request();
  assert.equal(f.job.snapshot().status, 'waiting'); assert.equal(f.calls(), 0);
  f.race(); f.idle.resolve();
  await until(() => f.calls() === 1);
  assert.equal(f.job.snapshot().status, 'compacting'); f.job.request();
  f.summary.resolve(null);
  await until(() => f.job.snapshot().status === 'done');
  assert.equal(f.calls(), 1); assert.equal(f.refreshed(), 1);
  assert.match(f.job.snapshot().message!, /无需压缩/);
});

test('stopping cancels a waiting or running home apply without later retry', async () => {
  for (const running of [false, true]) {
    const f = fixture(); f.job.request();
    if (running) { f.idle.resolve(); await until(() => f.calls() === 1); }
    await f.job.cancel();
    assert.equal(f.job.snapshot().status, 'cancelled');
    f.idle.resolve(); f.summary.resolve(null);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls(), running ? 1 : 0); assert.equal(f.refreshed(), 0);
  }
});

test('a replaced home is never compacted and failures remain visible without a model retry', async () => {
  const moved = fixture(); moved.job.request(); moved.moveHome(); moved.idle.resolve();
  await until(() => moved.job.snapshot().status === 'failed');
  assert.match(moved.job.snapshot().message!, /家会话已变化/); assert.equal(moved.calls(), 0);
  const failed = fixture(); failed.job.request(); failed.idle.resolve();
  await until(() => failed.calls() === 1);
  failed.summary.reject(new ManualCompactionError('summary', 'manual compaction could not produce a smaller summary', { cause: new Error('system update without a preceding user or tool-result turn') }));
  await until(() => failed.job.snapshot().status === 'failed');
  assert.match(failed.job.snapshot().message!, /smaller summary：system update without a preceding user/, 'the real reason is shown, not only the stage');
  assert.equal(failed.fault(), failed.job.snapshot().message, 'the failure stays in the console health');
  assert.equal(failed.calls(), 1); assert.equal(failed.refreshed(), 0);
  // Nobody watches the nightly request after the review, so a missing engine is a recorded failure, not a dropped return value.
  const absent = fixture(); absent.unavailable();
  assert.equal(absent.job.request(), undefined);
  await until(() => absent.job.snapshot().status === 'failed');
  assert.match(absent.fault()!, /未加载压缩服务/); assert.equal(absent.calls(), 0);
});

test('the home compacts with the engine in her session\'s preset, and the host-plane one only when the preset has none', () => {
  const home = { id: 'home' } as unknown as Agent;
  const preset = { compactNow: async () => null }, host = { compactNow: async () => null };
  const ctx = (services: Record<string, unknown>) => ({ get: (name: string) => services[name] }) as never;
  const registry = (engine: unknown) => ({ serviceFor: (agent: Agent, name: string) => agent === home && name === 'compaction' ? engine : undefined });
  assert.equal(compactionFor(ctx({ agentPresets: registry(preset), compaction: host }), home), preset, 'the Web host isolates it inside the preset');
  assert.equal(compactionFor(ctx({ agentPresets: registry(undefined), compaction: host }), home), host);
  assert.equal(compactionFor(ctx({ compaction: host }), home), host, 'the TUI has no preset registry');
  assert.equal(compactionFor(ctx({ agentPresets: registry(undefined) }), home), undefined);
});

test('a later success clears the failure from the console health', async () => {
  const f = fixture(); f.job.request(); f.idle.resolve();
  await until(() => f.calls() === 1);
  f.summary.reject(new Error('timeout'));
  await until(() => f.job.snapshot().status === 'failed');
  assert.match(f.fault()!, /timeout/);
  f.nextSummary(); f.job.request();
  await until(() => f.calls() === 2);
  f.summary.resolve(null);
  await until(() => f.job.snapshot().status === 'done');
  assert.equal(f.fault(), undefined);
});

for (const backend of ['tool-free', 'stock']) test(`${backend}: a home changed during summarization is cancelled before replacement`, async t => {
  const summary = deferred<void>(); let summaries = 0, current = true;
  const { ctx, cleanup } = await hostFixture(t, async function* (request) {
    if (request.purpose === 'compaction') { summaries++; await summary.promise; yield* textResponse('summary'); }
    else yield* textResponse('reply ' + 'detail '.repeat(100));
  });
  if (backend === 'stock') await mountCompaction(ctx);
  else { await ctx.plugin(TokenMeter).await(); await ctx.plugin(ToolFreeCompaction, { auto: false, headroomTokens: 0, maxTokens: 128 }).await(); }
  const { agent } = await ctx.agents.create({ sessionId: SessionId('home'), meta: {}, agentOptions: { provider: 'test', model: 'test' } });
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'conversation ' + 'words '.repeat(100) }] }));
  await agent.whenIdle();
  const before = agent.session.surface.replaceGeneration;
  let refreshed = 0;
  const job = createHomeApply({ ctx, home: async () => agent, isHome: () => current, compaction: () => ctx.compaction, refresh: () => { refreshed++; }, changed() {}, fault() {} });
  cleanup.push(() => { summary.resolve(); return job.cancel(); }); job.request();
  await until(() => summaries === 1);
  current = false; summary.resolve();
  await until(() => job.snapshot().status === 'failed');
  assert.match(job.snapshot().message!, /家会话已变化/);
  assert.equal(agent.session.surface.replaceGeneration, before, 'the old home must not be rewritten');
  assert.equal(refreshed, 0); assert.equal(summaries, 1);
});
