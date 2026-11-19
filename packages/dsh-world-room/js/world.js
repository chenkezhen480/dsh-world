// The land around her house: endless, cut into chunks and made from a seed, so only what gets changed would need keeping.
// Pure (no three.js, no page): the page draws it, and dsh-world can read the same land to tell her what is around her.
// Coordinates as in kit.js: x east, y north (toward the back wall), z up; 1 unit = her height. The house floor is at 0.

/** A world keeps the version it was made with: new rules must never move an old world's hills or trees. */
export const GENERATOR = 1;
export const CHUNK = 16;
/** Level of the yard; the house stands on its plinth just above it. */
export const GROUND = -0.3;

/** Her house as the land sees it. The yard is flat and fenced, and holds only what is planned for it. */
export const HOUSE = Object.freeze({
  door: [5.02, 0.03],
  window: { at: [-1.65, 1.75], facing: [-0.633, 0.774] },
  yard: { x0: -7.5, x1: 9.5, y0: -5.5, y1: 7.5, corner: 1.6 },
  gate: [9.5, 0.6],
});
/** The camera looks at the room from the south: in front of the house only low things, or they hide the room. */
const FRONT = { y: -2.4, x0: -12, x1: 14, rise: 0.52 };

// ---------------------------------------------------------------- numbers that come out the same everywhere

/** Integers in, a number in [0, 1) out; the same for the same seed on every machine. */
function hash(seed, a, b, c) {
  let h = (seed ^ 0x9e3779b9) | 0;
  for (const v of [a, b, c]) {
    h = Math.imul(h ^ (v | 0), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return (h >>> 0) / 4294967296;
}

/** mulberry32: a small generator for the choices made inside one chunk. */
export function rngFrom(seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, between: (a, b) => a + (b - a) * next(), pick: list => list[Math.floor(next() * list.length)] };
}

/** A whole number for a text, so a thing's look can follow from its id. */
export function textSeed(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

const smooth = t => t * t * (3 - 2 * t);
const smoothstep = (a, b, x) => smooth(Math.min(1, Math.max(0, (x - a) / (b - a))));

/** Value noise on a unit grid; `channel` keeps different uses of the same seed apart. */
function noise(seed, channel, x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), u = smooth(x - xi), v = smooth(y - yi);
  const a = hash(seed, channel, xi, yi), b = hash(seed, channel, xi + 1, yi);
  const c = hash(seed, channel, xi, yi + 1), d = hash(seed, channel, xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(seed, channel, x, y, octaves) {
  let sum = 0, amp = 0.5, scale = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(seed, channel * 16 + i, x * scale, y * scale);
    norm += amp; amp *= 0.5; scale *= 2;
  }
  return sum / norm;
}

// ---------------------------------------------------------------- the yard, planned by hand

/** How far a point is outside the yard's rounded fence line; 0 inside. */
function outsideYard(x, y) {
  const { x0, x1, y0, y1 } = HOUSE.yard;
  return Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1));
}

const along = (from, to, spacing) => {
  const n = Math.max(1, Math.round(Math.hypot(to[0] - from[0], to[1] - from[1]) / spacing));
  return Array.from({ length: n }, (_, i) => [from[0] + (to[0] - from[0]) * (i + 0.5) / n, from[1] + (to[1] - from[1]) * (i + 0.5) / n]);
};

/** The fence: panels round the yard's rounded rectangle, open at the gate. */
function fencePanels() {
  const { x0, x1, y0, y1, corner: r } = HOUSE.yard, ring = [];
  const arc = (cx, cy, from) => { for (let i = 0; i <= 4; i++) { const a = from + Math.PI / 2 * i / 4; ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); } };
  arc(x1 - r, y0 + r, -Math.PI / 2); arc(x1 - r, y1 - r, 0); arc(x0 + r, y1 - r, Math.PI / 2); arc(x0 + r, y0 + r, Math.PI);
  const panels = [];
  ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length], rot = Math.atan2(b[1] - a[1], b[0] - a[0]);
    for (const at of along(a, b, 1.2)) {
      if (Math.hypot(at[0] - HOUSE.gate[0], at[1] - HOUSE.gate[1]) < 1.0) continue;
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]) / Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 1.2));
      panels.push({ kind: 'fence', at, rot, length });
    }
  });
  return panels;
}

/** Stepping stones from the door to the gate. */
function stones() {
  const route = [[5.3, 0.12], [6.4, 0.38], [7.9, 0.56], HOUSE.gate];
  return route.slice(1).flatMap((to, i) => along(route[i], to, 0.62)).map((at, i) => ({ kind: 'stone', at, rot: i * 1.7 }));
}

const WINDOW_ALONG = Math.atan2(0.633, 0.774);       // the window wall's own direction
/** What she sees from her window and what stands round the house; ids name them, so a change can refer to them. */
function yardThings() {
  const planned = [
    { id: 'bed', kind: 'bed', at: [-2.5, 2.8], rot: WINDOW_ALONG },                   // right under the window
    { id: 'hydrangea-left', kind: 'bush', variant: 'hydrangea', at: [-3.5, 1.85], scale: 1.1 },
    { id: 'hydrangea-right', kind: 'bush', variant: 'hydrangea', at: [-1.3, 3.65], scale: 1.0 },
    { id: 'blossom', kind: 'tree', variant: 'blossom', at: [-5.3, 4.3], scale: 1.15 },  // framing the view out of the window
    { id: 'hydrangea-back', kind: 'bush', variant: 'hydrangea', at: [0.4, 4.7], scale: 0.9 },
    { id: 'bush-back', kind: 'bush', variant: 'round', at: [2.1, 4.9], scale: 1.0 },
    { id: 'apple', kind: 'tree', variant: 'apple', at: [7.3, 5.6], scale: 1.0 },
    { id: 'clothesline', kind: 'clothesline', at: [5.4, 4.9], rot: -0.35 },
    { id: 'bench', kind: 'bench', at: [-6.2, 0.6], rot: -Math.PI / 2 },
    { id: 'mailbox', kind: 'mailbox', at: [9.0, -0.55], rot: Math.PI / 2 },
    { id: 'flowers-front-left', kind: 'flowers', at: [-2.8, -4.0], scale: 1.2 },
    { id: 'flowers-front', kind: 'flowers', at: [2.2, -4.4], scale: 1.0 },
    { id: 'flowers-front-right', kind: 'flowers', at: [6.6, -3.5], scale: 1.1 },
  ];
  return [
    ...planned.map(({ id, ...thing }) => ({ id: `yard:${id}`, ...thing })),
    ...fencePanels().map((thing, i) => ({ id: `yard:fence-${i}`, ...thing })),
    ...stones().map((thing, i) => ({ id: `yard:stone-${i}`, ...thing })),
  ];
}

const YARD = new Map(yardThings().map(thing => [thing.id, thing]));
/** One planned yard thing by its name (`bed`, `clothesline`, …), as it stands before any change. */
export const yardThing = name => YARD.get(`yard:${name}`);

/** Highest a thing may stand at (x, y) before it hides the room from the camera. */
export function headroom(x, y) {
  if (y >= FRONT.y || x < FRONT.x0 || x > FRONT.x1) return Infinity;
  return (FRONT.y - y) * FRONT.rise;
}
/** How tall each kind roughly stands, at scale 1. */
const TALL = { tree: 3.2, bush: 0.9, rock: 0.5, flowers: 0.35, tufts: 0.3 };

// ---------------------------------------------------------------- the world

/**
 * createWorld({ seed, version }) gives the land of one world:
 *   height(x, y)   ground level;  ground(x, y)  'lawn' | 'grass' | 'meadow' | 'dirt', for the colour underfoot
 *   road(x)        the dirt road east from the gate: its y at x, or undefined west of the gate
 *   chunk(cx, cy, change?)  { cx, cy, x0, y0, objects }: everything standing in that chunk, a change applied
 * Every object has an id: `yard:…` for the planned ones, `cx,cy:n` for the grown ones.
 */
export function createWorld({ seed, version = GENERATOR }) {
  if (version !== GENERATOR) throw new Error(`world made with generator ${version}; this room knows generator ${GENERATOR}`);
  if (!Number.isSafeInteger(seed)) throw new Error('a world seed is a whole number');
  const yard = [...YARD.values()];

  function road(x) {
    if (x < HOUSE.gate[0]) return undefined;
    return HOUSE.gate[1] + (fbm(seed, 9, x / 34, 0.5, 2) - 0.5) * 6 * smoothstep(HOUSE.gate[0], 30, x);
  }
  function height(x, y) {
    const hills = (fbm(seed, 1, x / 26, y / 26, 3) - 0.5) * 3.4 + (fbm(seed, 2, x / 90, y / 90, 2) - 0.5) * 10;
    const y0 = road(x), byRoad = y0 === undefined ? 1 : smoothstep(1.4, 6, Math.abs(y - y0));
    return GROUND + hills * Math.min(smoothstep(0, 10, outsideYard(x, y)), byRoad);
  }
  function ground(x, y) {
    if (outsideYard(x, y) === 0) return 'lawn';
    const y0 = road(x);
    if (y0 !== undefined && Math.abs(y - y0) < 1.0) return 'dirt';
    return fbm(seed, 3, x / 9, y / 9, 2) > 0.55 ? 'meadow' : 'grass';
  }

  /** What grows on open land in one chunk: a few things per 4-unit cell, thicker where the woods are. */
  function grown(cx, cy) {
    const rng = rngFrom(Math.floor(hash(seed, 100, cx, cy) * 4294967296)), things = [], cell = 4;
    for (let i = 0; i < CHUNK / cell; i++) {
      for (let j = 0; j < CHUNK / cell; j++) {
        const x = cx * CHUNK + (i + rng.between(0.15, 0.85)) * cell, y = cy * CHUNK + (j + rng.between(0.15, 0.85)) * cell;
        const roll = rng.next(), scale = rng.between(0.8, 1.3), rot = rng.between(0, 2 * Math.PI), pick = rng.next();
        if (outsideYard(x, y) < 1.2) continue;
        const y0 = road(x);
        if (y0 !== undefined && Math.abs(y - y0) < 2.4) continue;
        const woods = smoothstep(0.45, 0.75, fbm(seed, 4, x / 40, y / 40, 2));
        let kind = roll < 0.12 + 0.5 * woods ? 'tree' : roll < 0.75 ? 'tufts' : roll < 0.8 ? 'bush' : roll < 0.9 ? 'flowers' : roll < 0.94 ? 'rock' : undefined;
        if (!kind) continue;
        if (TALL[kind] * scale > headroom(x, y)) kind = headroom(x, y) > TALL.flowers * scale ? 'flowers' : undefined;
        if (!kind) continue;
        const variant = kind === 'tree' ? (height(x, y) > 1.2 || pick < 0.25 ? 'pine' : pick > 0.95 ? 'blossom' : 'round')
          : kind === 'bush' ? (pick < 0.3 ? 'hydrangea' : 'round') : undefined;
        things.push({ kind, at: [x, y], rot, scale, ...(variant ? { variant } : {}) });
      }
    }
    // The road, in short straight pieces on one grid from the gate; each belongs to the chunk its middle is in.
    const piece = 1.6, first = Math.max(0, Math.ceil((cx * CHUNK - HOUSE.gate[0] - piece / 2) / piece));
    for (let k = first; HOUSE.gate[0] + (k + 0.5) * piece < (cx + 1) * CHUNK; k++) {
      const x = HOUSE.gate[0] + k * piece, a = road(x), b = road(x + piece), mid = (a + b) / 2;
      if (mid < cy * CHUNK || mid >= (cy + 1) * CHUNK) continue;
      things.push({ kind: 'road', at: [x + piece / 2, mid], rot: Math.atan2(b - a, piece), length: piece + 0.15 });
    }
    return things.map((thing, n) => ({ id: `${cx},${cy}:${n}`, ...thing }));
  }

  function chunk(cx, cy, change) {
    const x0 = cx * CHUNK, y0 = cy * CHUNK;
    const inside = ([x, y]) => x >= x0 && x < x0 + CHUNK && y >= y0 && y < y0 + CHUNK;
    const placed = [...yard.filter(thing => inside(thing.at)), ...grown(cx, cy)];
    const objects = applyChanges(placed, change).map(thing => ({ ...thing, at: [thing.at[0], thing.at[1], height(thing.at[0], thing.at[1])] }));
    return { cx, cy, x0, y0, objects };
  }

  return { seed, version, height, ground, road, chunk };
}

/** A chunk's changes: `removed` names things taken away, `added` are things put there, each with its own id. */
export function applyChanges(objects, change) {
  if (!change) return objects;
  const gone = new Set(change.removed ?? []);
  return [...objects.filter(thing => !gone.has(thing.id)), ...(change.added ?? [])];
}

export const chunkOf = (x, y) => [Math.floor(x / CHUNK), Math.floor(y / CHUNK)];
export const chunkKey = (cx, cy) => `${cx},${cy}`;
