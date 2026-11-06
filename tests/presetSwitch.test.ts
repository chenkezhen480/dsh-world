import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { hostFixture, textResponse } from './hostFixture.ts';
import { record } from './fixtures.ts';
import { createArchiveStore } from '../src/store.ts';
import { createWorldRuntime } from '../src/runtime.ts';
import { createMemory } from '../src/memory.ts';
import { writePersona } from '../src/persona.ts';
import { belongsToWorld } from '../src/sourceArchive.ts';

const config = { worldId: 'fish', agentPreset: 'standard', timeZone: 'UTC' };
const user = () => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] });

for (const scenario of [
  { created: 'ptc', selected: 'standard', restored: false, inside: true, included: true },
  { created: 'standard', selected: 'ptc', restored: false, inside: true, included: false },
  { created: 'ptc', selected: 'standard', restored: false, inside: false, included: false },
  { created: 'ptc', selected: 'standard', restored: true, inside: true, included: true },
  { created: 'standard', selected: 'ptc', restored: true, inside: true, included: false },
]) test(`world context follows ${scenario.created} -> ${scenario.selected}, ${scenario.restored ? 'restored' : 'live'}, ${scenario.inside ? 'inside' : 'outside'} the workspace (#39)`, async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, request => { requests.push(request); return textResponse('reply'); });
  const store = createArchiveStore({ ...config, root });
  cleanup.push(() => store.close());
  await store.commitRecords([record('seed', { content: 'PRESET_MEMORY_MARKER', sourceSessionId: 'prior' })]);
  const file = join(root, 'world-prompt.md'), persona = join(root, 'persona.md'), selfFile = join(root, 'self.md');
  await writeFile(file, 'PRESET_WORLD_MARKER\n{{self}}');
  await writeFile(selfFile, 'PRESET_SELF_MARKER');
  writePersona(persona, { 性格: 'PRESET_PERSONA_MARKER' });
  const memory = createMemory({ store: store.memory, timeZone: config.timeZone, sources: {}, visible: () => true });
  const world = createWorldRuntime(ctx, { ...config, selfFile }, store, {
    prompt: { file, persona, names: { companion: '小鱼', partner: '伙伴' } },
    isHome: () => false, inWorkspace: () => scenario.inside, memory,
  });
  cleanup.push(() => world.stop()); await world.start();
  const id = SessionId('switching'), agentOptions = { provider: 'test', model: 'test' };
  const original = await ctx.agents.create({ sessionId: id, meta: { agentPreset: scenario.created }, agentOptions });
  original.agent.session.append('agent-preset/selected', { agentPreset: scenario.selected });
  let agent = original.agent;
  if (scenario.restored) {
    await ctx.sessions.flush(agent.session); await original.dispose();
    agent = (await ctx.agents.resume({ resumeSessionId: id, agentOptions })).agent;
  }
  agent.followup(user()); await agent.whenIdle();
  assert.equal(requests.length, 1, 'the first request already uses the selected preset');
  const request = requests[0]!;
  const text = request.messages.flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
  for (const marker of ['PRESET_WORLD_MARKER', 'PRESET_SELF_MARKER', 'PRESET_PERSONA_MARKER', 'PRESET_MEMORY_MARKER']) {
    assert.equal(text.includes(marker), scenario.included, marker);
  }
  assert.deepEqual(request.tools?.filter(tool => tool.name.startsWith('memory_')).map(tool => tool.name) ?? [], scenario.included ? ['memory_find', 'memory_read'] : []);
  assert.equal(agent.session.header.agentPreset, scenario.created, 'the immutable creation header stays intact');
  assert.deepEqual(errors, []);
});

test('the latest preset selection wins across event pages and later appends (#39)', t => {
  const id = SessionId('preset-pages');
  const session = Session.create(id, [], { id, version: 4, createdAt: 0, isSeeded: false, agentPreset: 'ptc' });
  assert.equal(belongsToWorld(session, config), false);
  for (let i = 0; i < 260; i++) session.append('agent-preset/selected', { agentPreset: i % 2 ? 'standard' : 'ptc' });
  const read = t.mock.method(session, 'snapshotEvents');
  assert.equal(belongsToWorld(session, config), true);
  session.append('agent-preset/selected', { agentPreset: 'ptc' });
  assert.equal(belongsToWorld(session, config), false);
  session.append('agent-preset/selected', { agentPreset: 'standard' });
  assert.equal(belongsToWorld(session, config), true);
  for (const { arguments: [from, to] } of read.mock.calls) assert.ok(from !== undefined && to !== undefined && to - from <= 128, 'event reads are bounded');
});
