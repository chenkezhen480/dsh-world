import assert from 'node:assert/strict';
import test from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { hostFixture, textResponse } from './hostFixture.ts';
import { createWorldRuntime } from '../src/runtime.ts';
import { createArchiveStore } from '../src/store.ts';

const config = { worldId: 'fish', agentPreset: 'companion', timeZone: 'Asia/Seoul' };
const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const kinds = (request: GenerateOptions) => request.messages.map(m => m.source?.kind as string | undefined);
const moods = (request: GenerateOptions) => request.messages.filter(m => m.source?.kind === 'dsh-world-mood').map(m => m.content.flatMap(b => b.type === 'text' ? [b.text] : []).join(''));
/** Mirrors the host time-context plugin: the outermost pre-step listener appends its snapshot last. */
function hostTime(ctx: Context) {
  ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next();
    return decision.kind === 'reject' ? decision : { ...decision, messages: [...decision.messages, createUserMessage({ source: { kind: 'time-context' } as never, content: [{ type: 'text', text: 'Time sampled by host' }] })] };
  }, { prepend: true });
}

test('a session still showing her mood from before 0.8.4 is told once, at a step\'s end, that it is over; others never hear of it', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* (request) { requests.push(request); yield* textResponse('嗯'); });
  hostTime(ctx);
  // What 0.8.3 left in her sessions: a snapshot at the end of a step.
  let older = true;
  ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next();
    if (decision.kind === 'reject' || !older) return decision;
    older = false;
    return { ...decision, messages: [...decision.messages, createUserMessage({ source: { kind: 'dsh-world-mood', form: 'snapshot', worldId: 'fish' }, content: [{ type: 'text', text: '【我的心情值】开心 6（此刻感受变了就用 set_mood 更新）' }] })] };
  });
  const store = createArchiveStore({ ...config, root });
  const world = createWorldRuntime(ctx, config, store);
  await world.start(); cleanup.push(() => world.stop().finally(() => store.close()));
  const { agent } = await ctx.agents.create({ sessionId: SessionId('home'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  const say = async (text: string) => { agent.followup(user(text)); await agent.whenIdle(); return requests.at(-1)!; };

  assert.deepEqual(moods(await say('早')), ['【我的心情值】开心 6（此刻感受变了就用 set_mood 更新）']);
  const told = await say('在吗');
  assert.deepEqual(moods(told).slice(1), ['【我的心情值】心情值不再记了：上面最后那条不会再更新，set_mood 也没有了。']);
  assert.deepEqual(kinds(told).slice(-2), ['dsh-world-mood', 'time-context'], 'at the step end, ahead of the time');
  const later = await say('还在');
  assert.equal(moods(later).length, 2, 'said once');
  assert.deepEqual(later.messages.slice(0, told.messages.length), told.messages, 'appended; nothing before it moves');

  const fresh = await ctx.agents.create({ sessionId: SessionId('fresh'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  fresh.agent.followup(user('你好')); await fresh.agent.whenIdle();
  assert.deepEqual(moods(requests.at(-1)!), [], 'a session that never showed her mood hears nothing of it');
  assert.equal(errors.length, 0, errors.map(e => String((e as { error: Error }).error)).join('\n'));
});
