// What stands outside: one drawing per kind of thing world.js places. Every drawing is at the origin of the Zone it is
// given (already moved to the thing's spot and turned by its rot); its look follows from its id, so a chunk that is
// dropped and built again looks the same.
import { rngFrom, textSeed } from './world.js';
import { tiltX, tiltY } from './kit.js';

const TAU = 2 * Math.PI;
/** The garden bed's greens: leaf size and fruit for each stage; 'kept' is the bed while she does not live here. */
const CROP = {
  kept: { leaf: 0.11, flowers: true },
  empty: { leaf: 0 },
  sprout: { leaf: 0.045 },
  growing: { leaf: 0.09 },
  ripe: { leaf: 0.11, fruit: true },
};

/** A rounded crown of leaves: one big ball and a few smaller ones round it, drawn as one part. */
function crown(z, rng, s, at, colors, size = 0.78) {
  const c = z.fused();
  c.ball(size * s, [at[0], at[1], at[2]], colors[0], [1, 1, 0.86]);
  for (let i = 0; i < 4; i++) {
    const a = TAU * i / 4 + rng.between(-0.4, 0.4), r = rng.between(0.42, 0.55) * s;
    c.ball(r, [at[0] + Math.cos(a) * 0.5 * s, at[1] + Math.sin(a) * 0.5 * s, at[2] + rng.between(-0.25, 0.3) * s], rng.pick(colors), [1, 1, 0.86]);
  }
  return c;
}

function trunk(z, s, h) {
  z.cyl(0.12 * s, h, [0, 0, -0.05], 'bark', { r2: 0.08 * s, segs: 8 });
}

const TREES = {
  round(z, rng, s) {
    trunk(z, s, 1.3 * s);
    crown(z, rng, s, [0, 0, 1.75 * s], ['leaf', 'leaf', 'leaf_dark', 'leaf_light']);
  },
  blossom(z, rng, s) {
    trunk(z, s, 1.35 * s);
    crown(z, rng, s, [0, 0, 1.85 * s], ['blossom', 'blossom', 'blossom_light', 'blossom_light'], 0.85);
    const petals = z.fused();                                        // a few fallen petals round the foot
    for (let i = 0; i < 6; i++) petals.ball(0.05, [rng.between(-0.9, 0.9) * s, rng.between(-0.9, 0.9) * s, 0], 'blossom_light', [1, 1, 0.2], { detail: 1 });
  },
  apple(z, rng, s) {
    trunk(z, s, 1.2 * s);
    const c = crown(z, rng, s, [0, 0, 1.7 * s], ['leaf', 'leaf_dark', 'leaf']);
    for (let i = 0; i < 7; i++) {
      const a = rng.between(0, TAU), up = rng.between(-0.3, 0.5);
      c.ball(0.08 * s, [Math.cos(a) * 0.72 * s, Math.sin(a) * 0.72 * s, (1.7 + up) * s], 'apple', [1, 1, 1], { detail: 1 });
    }
  },
  pine(z, rng, s) {
    trunk(z, s, 0.6 * s);
    const c = z.fused();
    [[0.95, 0.45, 1.0], [0.72, 1.05, 0.85], [0.48, 1.6, 0.75]].forEach(([r, at, h]) => c.cyl(r * s, h * s, [0, 0, at * s], 'pine', { r2: 0.03, segs: 9 }));
  },
};

/** The hydrangeas by the window are the same blue as the ones indoors. */
function hydrangea(z, rng, s) {
  const b = z.fused();
  b.ball(0.42 * s, [0, 0, 0.3 * s], 'leaf_dark', [1.2, 1, 0.8]);
  for (let i = 0; i < 6; i++) {
    const a = TAU * i / 6 + rng.between(-0.3, 0.3);
    b.ball(rng.between(0.14, 0.18) * s, [Math.cos(a) * 0.32 * s, Math.sin(a) * 0.3 * s, rng.between(0.45, 0.62) * s], rng.pick(['peri', 'blue', 'indigo', 'peri']));
  }
  b.ball(0.17 * s, [0, 0, 0.68 * s], 'peri');
}

const DRAW = {
  tree: (z, thing, rng) => (TREES[thing.variant] ?? TREES.round)(z, rng, thing.scale ?? 1),
  bush(z, thing, rng) {
    const s = thing.scale ?? 1;
    if (thing.variant === 'hydrangea') { hydrangea(z, rng, s); return; }
    const b = z.fused();
    for (let i = 0; i < 3; i++) b.ball(rng.between(0.3, 0.42) * s, [rng.between(-0.3, 0.3) * s, rng.between(-0.25, 0.25) * s, 0.25 * s], rng.pick(['leaf', 'leaf_dark']), [1, 1, 0.8]);
  },
  flowers(z, thing, rng) {
    const s = thing.scale ?? 1, f = z.fused(), color = rng.pick(['yellow', 'pink', 'lace', 'peri', 'blossom']);
    for (let i = 0; i < 9; i++) {
      const a = rng.between(0, TAU), r = rng.between(0, 0.45) * s, h = rng.between(0.18, 0.3);
      f.box([0.02, 0.02, h], [Math.cos(a) * r, Math.sin(a) * r, 0], 'leaf_dark');
      f.ball(rng.between(0.045, 0.065), [Math.cos(a) * r, Math.sin(a) * r, h], rng.next() < 0.7 ? color : 'lace', [1, 1, 0.8], { detail: 1 });
    }
    for (let i = 0; i < 3; i++) f.ball(0.12 * s, [rng.between(-0.3, 0.3) * s, rng.between(-0.3, 0.3) * s, 0.02], 'leaf', [1.2, 1, 0.3], { detail: 1 });
  },
  tufts(z, thing, rng) {
    const s = thing.scale ?? 1, t = z.fused();
    for (let i = 0; i < 5; i++) {
      const lean = tiltY(rng.between(-0.35, 0.35)).multiply(tiltX(rng.between(-0.35, 0.35)));
      t.cyl(0.04, rng.between(0.16, 0.3) * s, [rng.between(-0.18, 0.18) * s, rng.between(-0.18, 0.18) * s, -0.02], 'blade', { r2: 0.003, segs: 5, tilt: lean });
    }
  },
  rock(z, thing, rng) {
    const s = thing.scale ?? 1;
    z.ball(0.32 * s, [0, 0, 0.05], 'stone', [1.2, 0.95, 0.6], { detail: 1 });
    if (rng.next() < 0.6) z.ball(0.18 * s, [0.34 * s, 0.12 * s, 0.02], 'stone_dark', [1.1, 1, 0.6], { detail: 1 });
  },
  /** One panel of white picket fence along local x, with its post at the start. */
  fence(z, thing) {
    const L = thing.length;
    z.box([0.09, 0.09, 0.62], [-L / 2, 0, -0.05], 'fence', { bevel: 0.02, soft: true });
    const p = z.fused();
    for (const h of [0.16, 0.4]) p.box([L, 0.035, 0.05], [0, 0.02, h], 'fence');
    const n = Math.max(2, Math.round(L / 0.2));
    for (let i = 0; i < n; i++) p.box([0.06, 0.03, 0.5], [-L / 2 + L * (i + 0.5) / n, -0.015, -0.02], 'fence');
  },
  stone: z => z.ball(0.27, [0, 0, -0.03], 'stone', [1, 0.82, 0.14], { detail: 1 }),
  road: (z, thing) => z.box([thing.length, 1.6, 0.04], [0, 0, -0.02], 'dirt'),
  /**
   * The garden bed under her window: a wooden box of soil. While she does not live here it holds greens and a few
   * flowers; while she does, it shows her crop as it is (variant: empty, sprout, growing, ripe), pale when thirsty.
   */
  bed(z, thing, rng) {
    const crop = CROP[thing.variant ?? 'kept'], dry = thing.thirsty === true;
    z.box([1.9, 0.62, 0.26], [0, 0, -0.04], 'wood', { bevel: 0.03, soft: true });
    z.box([1.78, 0.5, 0.03], [0, 0, 0.215], dry ? 'dirt' : 'soil');
    const rows = [-0.12, 0.12];
    if (!crop.leaf) { for (const row of rows) z.box([1.6, 0.05, 0.015], [0, row, 0.232], 'bark'); return; }   // furrows, waiting
    const g = z.fused();
    for (let i = 0; i < 6; i++) {
      // Thirsty: the leaves go pale and droop.
      for (const row of rows) g.ball(crop.leaf, [-0.72 + i * 0.29, row, 0.23 + crop.leaf * (dry ? 0.2 : 0.45)], dry ? 'leaf_dry' : rng.next() < 0.2 ? 'leaf_dark' : 'leaf_light', dry ? [1.15, 1.15, 0.4] : [1, 1, 0.75], { detail: 1 });
    }
    if (crop.flowers) for (let i = 0; i < 3; i++) g.ball(0.06, [-0.6 + i * 0.6, 0, 0.42], rng.pick(['yellow', 'pink', 'peri']), [1, 1, 1], { detail: 1 });
    if (crop.fruit) for (let i = 0; i < 6; i++) for (const row of rows) g.ball(0.055, [-0.72 + i * 0.29 + 0.06, row - 0.05, 0.37], 'apple', [1, 1, 1], { detail: 1 });
  },
  /** Laundry pegged on the clothesline: still dark with water, or dry and light. */
  laundry(z, thing, rng) {
    const wet = thing.variant === 'wet', colors = wet ? ['peri', 'indigo', 'navy_light'] : ['lace', 'peri', 'pink', 'cream'];
    let x = -1.2;
    for (let i = 0; i < 4; i++) {
      const wide = rng.between(0.32, 0.46), tall = rng.between(0.34, 0.5), cloth = z.fused();
      cloth.box([wide, 0.02, tall], [x + wide / 2, -0.2 + (i % 2) * 0.4, 1.5 - tall / 2], rng.pick(colors), { bevel: 0.008 });
      cloth.box([0.03, 0.04, 0.05], [x + 0.06, -0.2 + (i % 2) * 0.4, 1.5], 'wood_light');
      if (wet) cloth.ball(0.02, [x + wide / 2, -0.2 + (i % 2) * 0.4, 1.5 - tall - 0.05], 'glass', [1, 1, 1.4], { detail: 1 });
      x += wide + rng.between(0.15, 0.3);
    }
  },
  clothesline(z) {
    for (const x of [-1.5, 1.5]) {
      z.cyl(0.05, 1.62, [x, 0, -0.05], 'wood', { segs: 8 });
      z.box([0.06, 0.5, 0.06], [x, 0, 1.52], 'wood');
    }
    const line = z.fused();
    for (const y of [-0.2, 0.2]) line.box([3.0, 0.015, 0.015], [0, y, 1.5], 'lace');
  },
  bench(z) {
    z.box([1.1, 0.38, 0.07], [0, 0, 0.4], 'wood', { bevel: 0.02, soft: true });
    z.box([1.1, 0.06, 0.32], [0, 0.17, 0.52], 'wood', { bevel: 0.02, soft: true });
    for (const x of [-0.45, 0.45]) for (const y of [-0.13, 0.13]) z.box([0.07, 0.07, 0.45], [x, y, -0.05], 'wood_dark');
  },
  mailbox(z) {
    z.box([0.08, 0.08, 0.95], [0, 0, -0.05], 'wood');
    z.box([0.36, 0.24, 0.22], [0, 0, 0.88], 'navy', { bevel: 0.05, soft: true });
    z.box([0.03, 0.12, 0.1], [0.19, 0.06, 1.0], 'gold');
  },
};

/** Draws one placed thing into the zone; a kind this page does not know is drawn as nothing and named once. */
export function drawThing(zone, thing, unknown) {
  const draw = DRAW[thing.kind];
  if (!draw) { unknown(thing.kind); return; }
  draw(zone.at(thing.at, thing.rot ?? 0), thing, rngFrom(textSeed(thing.id)));
}
