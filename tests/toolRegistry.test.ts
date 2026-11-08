import assert from 'node:assert/strict';
import test from 'node:test';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { Faults } from '../src/faults.ts';
import { createToolRegistry } from '../src/life/toolRegistry.ts';

const tool = (name: string) => ({ name, description: name, parameters: {}, output: { schema: { type: 'string' }, render: () => [] }, execute: async () => '' }) as unknown as ToolDefinition;

test('extra home tools follow their revision and leave a home that is no longer one', () => {
  const registered = new Map<string, Set<string>>();
  const agent = (id: string) => ({ id, ctx: { tools: { register: (definition: ToolDefinition) => {
    const set = registered.get(id) ?? new Set<string>(); registered.set(id, set); set.add(definition.name); return () => { set.delete(definition.name); };
  } } } }) as unknown as Agent;
  let home = 'h1', revision = 'r1', extra = ['page_read', 'my_a'];
  // reach_out is there because a home without its home tools counts as still missing them.
  const registry = createToolRegistry({ faults: new Faults(), logger: { error() {} }, tools: () => [tool('plan_next'), tool('reach_out')], isHome: a => a.id === home, inWorld: () => true,
    extras: { tools: () => extra.map(tool), revision: () => revision } });
  const h1 = agent('h1'), other = agent('o');
  assert.equal(registry.attach(h1), true);
  assert.deepEqual([...registered.get('h1')!].sort(), ['my_a', 'page_read', 'plan_next', 'reach_out']);
  registry.attach(other);
  assert.deepEqual([...registered.get('o')!], ['plan_next'], 'other world sessions get only the alarm tools');
  assert.equal(registry.attach(h1), false, 'the same revision changes nothing');
  revision = 'r2'; extra = ['page_read', 'my_a', 'my_b'];
  assert.equal(registry.attach(h1), true);
  assert.ok(registered.get('h1')!.has('my_b'));
  home = 'o'; registry.releaseOldHomes();
  assert.deepEqual([...registered.get('h1')!], ['plan_next']);
  assert.equal(registry.attach(other), true);
  assert.ok(registered.get('o')!.has('my_b'));
  registry.clear();
  assert.equal(registered.get('o')!.size, 0);
});

test('extras that cannot be listed are a fault and never keep the alarm or home tools away', () => {
  const registered = new Map<string, Set<string>>();
  const agent = (id: string) => ({ id, ctx: { tools: { register: (definition: ToolDefinition) => {
    const set = registered.get(id) ?? new Set<string>(); registered.set(id, set); set.add(definition.name); return () => { set.delete(definition.name); };
  } } } }) as unknown as Agent;
  const faults = new Faults();
  const registry = createToolRegistry({ faults, logger: { error() {} }, tools: () => [tool('plan_next'), tool('reach_out')], isHome: () => true, inWorld: () => true,
    extras: { tools: () => [], revision: () => { throw new Error('库读不了'); } } });
  assert.doesNotThrow(() => registry.attach(agent('h')));
  assert.deepEqual([...registered.get('h')!].sort(), ['plan_next', 'reach_out']);
  assert.ok(faults.list().some(fault => fault.includes('库读不了')));
});

test('a session that is not the home gets no extras when the revision moves', () => {
  const registered = new Map<string, Set<string>>();
  const agent = (id: string) => ({ id, ctx: { tools: { register: (definition: ToolDefinition) => {
    const set = registered.get(id) ?? new Set<string>(); registered.set(id, set); set.add(definition.name); return () => { set.delete(definition.name); };
  } } } }) as unknown as Agent;
  let revision = 'r1';
  const registry = createToolRegistry({ faults: new Faults(), logger: { error() {} }, tools: () => [tool('plan_next')], isHome: a => a.id === 'h', inWorld: () => true,
    extras: { tools: () => [tool('my_a')], revision: () => revision } });
  const other = agent('o');
  registry.attach(other);
  revision = 'r2';
  assert.equal(registry.attach(other), false);
  assert.deepEqual([...registered.get('o')!], ['plan_next']);
});
