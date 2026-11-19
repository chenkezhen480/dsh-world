import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error plain browser module, no types
import { CHUNK, GENERATOR, GROUND, HOUSE, applyChanges, createWorld } from '../packages/dsh-world-room/js/world.js';

type Thing = { id: string; kind: string; at: number[]; scale?: number };
type Chunk = { cx: number; cy: number; x0: number; y0: number; objects: Thing[] };
const SEED = 20261118;
const around = (world: { chunk(cx: number, cy: number): Chunk }, r = 3) => {
  const chunks: Chunk[] = [];
  for (let cx = -r; cx <= r; cx++) for (let cy = -r; cy <= r; cy++) chunks.push(world.chunk(cx, cy));
  return chunks;
};

test('the same seed always makes the same land, and another seed another land', () => {
  const a = createWorld({ seed: SEED }), b = createWorld({ seed: SEED }), c = createWorld({ seed: 7 });
  assert.deepEqual(a.chunk(2, -1), b.chunk(2, -1));
  assert.deepEqual(a.chunk(-40, 17), b.chunk(-40, 17), 'far away too: the land never ends');
  assert.notDeepEqual(a.chunk(2, -1).objects, c.chunk(2, -1).objects);
  assert.equal(a.height(37.25, -11.5), b.height(37.25, -11.5));
  assert.equal(a.version, GENERATOR);
});

test('the yard round the house is flat, lawn, and holds only what was planned for it', () => {
  const world = createWorld({ seed: SEED }), { x0, x1, y0, y1 } = HOUSE.yard;
  for (let x = x0; x <= x1; x += 0.5) for (let y = y0; y <= y1; y += 0.5) {
    assert.equal(world.height(x, y), GROUND, `${x},${y}`);
    assert.equal(world.ground(x, y), 'lawn');
  }
  const things = around(world, 1).flatMap(chunk => chunk.objects);
  const inYard = things.filter(t => t.at[0] > x0 && t.at[0] < x1 && t.at[1] > y0 && t.at[1] < y1);
  assert.ok(inYard.every(t => t.id.startsWith('yard:')), 'nothing grows by chance inside the fence');
  const hugging = things.filter(t => !t.id.startsWith('yard:') && t.kind !== 'road' && t.at[0] > x0 - 1 && t.at[0] < x1 + 1 && t.at[1] > y0 - 1 && t.at[1] < y1 + 1);
  assert.deepEqual(hugging.map(t => t.id), [], 'and nothing grows right against it');
  for (const id of ['yard:bed', 'yard:blossom', 'yard:mailbox', 'yard:clothesline']) assert.ok(things.some(t => t.id === id), id);
  assert.ok(things.filter(t => t.kind === 'fence').length > 30, 'the fence goes all the way round');
  const nearGate = things.filter(t => t.kind === 'fence' && Math.hypot(t.at[0] - HOUSE.gate[0], t.at[1] - HOUSE.gate[1]) < 0.9);
  assert.deepEqual(nearGate, [], 'the gate is left open');
});

test('nothing tall stands between the camera and the room', () => {
  const tall: Record<string, number> = { tree: 3.2, bush: 0.9, rock: 0.5, flowers: 0.35, tufts: 0.3 };
  for (const t of around(createWorld({ seed: SEED })).flatMap(chunk => chunk.objects)) {
    const [x, y] = t.at;
    if (!(t.kind in tall) || y >= -2.4 || x < -12 || x > 14) continue;
    assert.ok(tall[t.kind]! * (t.scale ?? 1) <= (-2.4 - y) * 0.52 + 1e-9, `${t.id} (${t.kind}) at ${x.toFixed(1)},${y.toFixed(1)}`);
  }
});

test('every thing belongs to one chunk, stands on the ground, and has an id of its own', () => {
  const world = createWorld({ seed: SEED }), seen = new Set<string>();
  for (const chunk of around(world)) {
    for (const t of chunk.objects) {
      assert.ok(!seen.has(t.id), `${t.id} appears twice`);
      seen.add(t.id);
      assert.ok(t.at[0] >= chunk.x0 && t.at[0] < chunk.x0 + CHUNK && t.at[1] >= chunk.y0 && t.at[1] < chunk.y0 + CHUNK, `${t.id} is inside its chunk`);
      assert.equal(t.at[2], world.height(t.at[0], t.at[1]));
    }
  }
  assert.ok(seen.size > 300);
  assert.ok([...seen].some(id => /^\d+,0:\d+$/.test(id) && world.chunk(Number(id.split(',')[0]), 0).objects.some((t: Thing) => t.id === id && t.kind === 'road')), 'the road runs east from the gate');
});

test('a chunk keeps what was changed in it: things taken away stay away, things put there stand on the ground', () => {
  const world = createWorld({ seed: SEED });
  const before = world.chunk(-1, 0).objects as Thing[];
  assert.ok(before.some(t => t.id === 'yard:bed'));
  const change = { removed: ['yard:bed'], added: [{ id: 'her:flowers-1', kind: 'flowers', at: [-3.1, 3.4] }] };
  const after = world.chunk(-1, 0, change).objects as Thing[];
  assert.ok(!after.some(t => t.id === 'yard:bed'));
  assert.deepEqual(after.find(t => t.id === 'her:flowers-1')!.at, [-3.1, 3.4, GROUND]);
  assert.equal(after.length, before.length);
  assert.deepEqual(applyChanges(before, undefined), before);
});

test('a world made by another version of the rules is refused, not redrawn differently', () => {
  assert.throws(() => createWorld({ seed: SEED, version: GENERATOR + 1 }), /generator/);
  assert.throws(() => createWorld({ seed: 1.5 }), /whole number/);
});
