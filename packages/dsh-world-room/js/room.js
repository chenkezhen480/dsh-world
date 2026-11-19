// The cottage layout: shell, four zones, bathroom alcove, entry. Coordinates and frames as in kit.js.
import { Vector3 } from 'three';
import {
  arch, ellipse, gBox, gCyl, gFrame, gPrism, gWall, offsetPolygon, rect, roundedTop, tiltX, tiltY, wallFrame,
} from './kit.js';
import * as props from './props.js';

// floor plan, counter-clockwise
const F0 = [-3.6, -2.2], F1 = [4.6, -2.2];
const P5 = [5.3, -1.2], P4 = [4.1, 2.2], P3 = [2.35, 2.2], P2 = [-1.1, 2.2], P1 = [-2.2, 1.3], P0 = [-4.1, -0.7];      // the kitchen wall is splayed wide so its shelves face the viewer
/** The floor's outline, which the ceiling covers too: the house, for anything that must stay out of it. */
export const FOOTPRINT = [F0, F1, P5, P4, P2, P1, P0];
const B1 = [3.747, 3.2], B0 = [2.35, 3.2];        // bathroom alcove behind the back wall; B1 lies on the line P5->P4
const DOOR_WALL_END = [2.95, 2.2];                // the bathroom door wall runs P3..here, the rest of that edge is cut away
const H = 2.2, H_KITCHEN_FRONT = 1.15, H_DOOR_FRONT = 1.78, H_BATH = 1.9;
const T = 0.14;             // wall thickness
const PL = 0.15;            // bed platform height
const PLAT_FRONT = 0.36;    // front edge of the bed platform
const BED_AT = [-0.5, 1.32, PL];
// Arched hole in the window wall, in that wall's frame. The sill is below her eyes (she is 1 tall), so she sees the garden.
const WINDOW = { width: 0.86, z0: 0.5, height: 1.1 };

/** Where the sunlight comes from and what it aims at, in room coordinates. */
export function sunThroughWindow() {
  const frame = wallFrame(P2, P1);
  return { from: new Vector3(0.85, 1.9, 2.6).applyMatrix4(frame), to: new Vector3(0.0, 0.07, WINDOW.z0 + WINDOW.height * 0.45).applyMatrix4(frame) };
}

/**
 * Where she goes and which clips she plays there (see routine.js). The lane runs along the open floor from the
 * kitchen mat, behind the dining table, past the armchair and up to the mirror; pastimes hang off its stops.
 */
export const HER_PLAN = {
  places: {
    work: { at: [2.78, -0.72, 0], clips: ['code'] },                                       // beside the desk, laptop in hand
    rest: { at: [BED_AT[0], BED_AT[1] - 0.15, BED_AT[2] + 0.48], clips: ['nap'] },         // on the quilt
  },
  lane: [[-2.55, -0.65], [-1.0, -0.6], [0.6, -0.3], [1.32, -0.22], [1.36, 0.95]],
  start: 1,
  things: { stool: { home: [-1.3, 0.02, 0], stand: [-1.3, -0.22], stop: 1, top: 0.33 } },      // the little stool she carries about
  pastimes: [
    { stop: 0, at: [-2.55, -0.65], clips: ['eat'] },
    { stop: 0, at: [-2.55, -0.65], clips: ['wipe'] },
    { stop: 1, at: [-1.0, -0.6], clips: ['idle', 'look'] },
    { stop: 1, at: [-1.0, -0.6], clips: ['hum'] },
    { stop: 1, at: [-1.0, -0.6], clips: ['cube'] },
    { stop: 1, at: [-0.7, -0.75], clips: ['cat'] },
    { stop: 1, at: [-1.0, -0.6], clips: ['stretch'] },
    { stop: 2, at: [0.6, -0.3], clips: ['noodle'] },                                        // at the table, which hides her feet
    { stop: 3, at: [1.32, -0.22], clips: ['read'] },
    { stop: 4, at: [1.75, 1.25], clips: ['mirror'] },                                       // on the mirror's rug
    { stop: 3, at: [1.62, -0.66], seat: [2.15, -0.34, 0.37], clips: ['nap'] },             // curled up in the armchair
    { stop: 0, at: [-2.26, 0.0], carry: 'stool', clips: ['wipe'] },                        // on the stool at the stove
  ],
};
export const ANCHORS = { alarm: [3.25, 0.18, 1.25], mirror: [2.27, 2.0, 1.2] };

// ---------------------------------------------------------------- shell

function wall(set, a, b, hB, hA, mat = 'wall', base = 'wood_dark', group = 'shell') {
  const hx = Math.hypot(b[0] - a[0], b[1] - a[1]) / 2;
  const w = set.zone(group).in(wallFrame(a, b));
  w.put(gWall(-hx, hx, 0, T, 0, hB, 0, hA), mat);
  w.put(gWall(-hx, hx, -0.035, T + 0.035, hB, hB + 0.12, hA, hA + 0.12), 'beam');
  if (base) w.put(gWall(-hx, hx, -0.025, 0, 0, 0.1, 0, 0.1), base);
}

function windowWall(set) {
  const hx = Math.hypot(P1[0] - P2[0], P1[1] - P2[1]) / 2, { width, z0, height } = WINDOW;
  const w = set.zone('shell').in(wallFrame(P2, P1));
  w.put(gFrame([[-hx, 0], [hx, 0], [hx, H], [-hx, H]], arch(width, height, z0), T), 'wall', [0, T, 0]);
  w.put(gWall(-hx, hx, -0.035, T + 0.035, H, H + 0.12, H, H + 0.12), 'beam');
  w.put(gWall(-hx, hx, -0.025, 0, 0, 0.1, 0, 0.1), 'wood_dark');
}

/** Curved timber knee where a post meets the beam above it: corner at loc, reaching along +X (side 1) or -X (side -1) and down. */
function brace(z, loc, reach, side = 1) {
  const curve = Array.from({ length: 9 }, (_, i) => { const a = Math.PI / 2 + Math.PI / 2 * i / 8; return [side * (reach + reach * Math.cos(a)), -reach + reach * Math.sin(a)]; });
  const outline = [[0, 0], ...curve];
  z.slab(side > 0 ? outline.reverse() : outline, 0.07, loc, 'beam');
}

function buildShell(set) {
  const z = set.zone('shell');
  z.put(gPrism(FOOTPRINT, 0.12), 'floor', [0, 0, -0.12]);
  z.put(gPrism([P3, P4, B1, B0], 0.12), 'tiles_floor', [0, 0, -0.12]);
  const outline = [F0, F1, P5, B1, B0, P3, P2, P1, P0];
  z.put(gPrism(offsetPolygon(outline, 0.24), 0.24), 'beam', [0, 0, -0.36]);
  z.put(gPrism(offsetPolygon(outline, 0.17), 0.03), 'wood_dark', [0, 0, -0.125]);

  wall(set, P1, P0, H_KITCHEN_FRONT, H);
  windowWall(set);
  wall(set, P3, P2, H, H);
  wall(set, DOOR_WALL_END, P3, H_BATH, H_BATH);
  wall(set, P5, P4, H, H_DOOR_FRONT);
  wall(set, P4, B1, H_BATH, H_BATH, 'tiles_bath', null);
  wall(set, B1, B0, H_BATH, H_BATH, 'tiles_bath', null);
  wall(set, B0, [P3[0], P3[1] + T + 0.01], H_BATH, H_BATH, 'tiles_bath', null);     // stops short of the back wall's face
  z.box([P4[0] - DOOR_WALL_END[0], 0.1, 0.07], [(P4[0] + DOOR_WALL_END[0]) / 2, 2.25, 0], 'wood_dark');   // cut-away sill

  for (const [[x, y], h] of [[P0, H_KITCHEN_FRONT], [P1, H], [P2, H], [P3, H], [P4, H], [P5, H_DOOR_FRONT], [B1, H_BATH], [B0, H_BATH]]) {
    z.box([0.22, 0.22, h + 0.18], [x, y, 0], 'beam');
  }
  z.box([0.14, 0.2, H_BATH + 0.12], [DOOR_WALL_END[0], 2.24, 0], 'beam');
  z.box([0.16, 0.1, H], [1.2, 2.16, 0], 'beam');                          // pillar between bed nook and mirror
  brace(z, [P2[0] + 0.1, 2.2, H], 0.5);
  brace(z, [1.12, 2.2, H], 0.5, -1);
  brace(z, [1.28, 2.2, H], 0.42);
  brace(z, [P3[0] - 0.1, 2.2, H], 0.42, -1);
  for (const [x, y] of [[F0[0] + 0.12, F0[1] + 0.12], [F1[0] - 0.12, F1[1] + 0.12]]) {
    z.box([0.22, 0.22, 0.46], [x, y, 0], 'beam');
    z.box([0.27, 0.27, 0.05], [x, y, 0.46], 'wood_dark');
  }
}

// ---------------------------------------------------------------- zone: bed

/** Head toward +Y, against the wall; drawers in the side that faces the room. */
function bed(b) {
  b.box([1.0, 1.56, 0.26], [0, 0, 0], 'wood');
  for (const y of [-0.38, 0.38]) {                                        // drawers
    const d = b.at([0.5, y, 0.04], Math.PI / 2);
    d.box([0.62, 0.02, 0.17], [0, -0.01, 0], 'wood_light');
    for (const x of [-0.15, 0.15]) d.ball(0.018, [x, -0.028, 0.085], 'gold', [1, 1, 1], { detail: 1 });
  }
  b.box([1.06, 0.06, 0.4], [0, -0.79, 0], 'wood');                        // footboard
  b.box([0.8, 0.012, 0.18], [0, -0.826, 0.13], 'wood_light');
  b.box([1.1, 0.085, 0.04], [0, -0.79, 0.4], 'wood_dark');
  b.slab(roundedTop(1.1, 1.08, 0.3), 0.07, [0, 0.82, 0], 'wood');         // headboard
  b.slab(roundedTop(0.86, 0.94, 0.24), 0.012, [0, 0.75, 0.08], 'wood_light');
  props.stars(b, [[0, 0.738, 0.84]], 0.06, { upright: true });
  for (const sx of [-1, 1]) {
    b.box([0.09, 0.09, 0.92], [sx * 0.57, 0.79, 0], 'wood_dark');
    b.ball(0.06, [sx * 0.57, 0.79, 0.97], 'wood_dark');
    b.box([0.09, 0.09, 0.46], [sx * 0.53, -0.79, 0], 'wood_dark');
    b.ball(0.055, [sx * 0.53, -0.79, 0.5], 'wood_dark');
    props.scallops(b, [sx * 0.515, -0.74, 0.25], [sx * 0.515, 0.3, 0.25], 0.04, { th: 0.02 });   // lace under the quilt
  }
  b.box([0.96, 1.48, 0.15], [0, 0, 0.26], 'cream', { bevel: 0.04, soft: true });            // mattress
  b.box([1.04, 1.06, 0.09], [0, -0.25, 0.385], 'navy', { bevel: 0.035, soft: true });        // quilt
  b.box([1.05, 0.16, 0.093], [0, 0.26, 0.384], 'cream', { bevel: 0.03, soft: true });        // turned-down sheet
  props.scallops(b, [-0.49, 0.35, 0.47], [0.49, 0.35, 0.47], 0.035);
  b.box([1.045, 0.016, 0.006], [0, 0.16, 0.4755], 'gold');
  b.box([1.045, 0.016, 0.006], [0, -0.6, 0.4755], 'gold');
  for (let i = 0; i < 9; i++) b.cyl(0.05, 0.005, [-0.44 + i * 0.11, -0.68, 0.4755], 'indigo', { segs: 12 });   // wave border
  props.whale(b, 0.5, 'cream', [0.02, -0.22, 0.4755]);
  props.stars(b, [[-0.36, -0.04, 0.4755], [0.38, 0.0, 0.4755], [-0.32, -0.44, 0.4755], [0.36, -0.42, 0.4755], [0.08, 0.06, 0.4755]], 0.03);
  b.box([0.78, 0.3, 0.15], [0, 0.56, 0.4], 'lace', { bevel: 0.06, soft: true });             // pillows, frilled
  props.scallops(b, [-0.4, 0.4, 0.44], [0.4, 0.4, 0.44], 0.035);
  b.box([0.5, 0.24, 0.13], [0, 0.42, 0.44], 'cream', { bevel: 0.05, soft: true });
  props.bow(b.at([0, 0.29, 0.52]), 0.22, 'indigo');
}

/** Low panelled wall along X, origin at its middle on the floor. */
function partition(z, length) {
  z.box([length, 0.09, 0.4], [0, 0, 0], 'wall');
  z.box([length + 0.02, 0.1, 0.05], [0, 0, 0], 'wood_dark');
  z.box([length + 0.06, 0.12, 0.045], [0, 0, 0.4], 'wood_dark');
  const n = Math.max(1, Math.round(length / 0.5));
  for (let i = 0; i < n; i++) z.box([length / n - 0.1, 0.012, 0.24], [-length / 2 + length / n * (i + 0.5), -0.048, 0.1], 'wall_low');
}

function post(z, h) {
  z.box([0.13, 0.13, h], [0, 0, 0], 'wood_dark');
  z.ball(0.07, [0, 0, h + 0.03], 'wood_dark');
}

function windowDressing(w) {
  const { width, z0, height } = WINDOW;
  w.put(gFrame(arch(width + 0.16, height + 0.08, z0 - 0.08), arch(width - 0.04, height - 0.02, z0 + 0.02), 0.2), 'wood', [0, T + 0.03, 0]);
  w.box([0.03, 0.05, height - 0.03], [0, 0.07, z0], 'wood');                              // muntins
  for (const h of [0.34, 0.62]) w.box([width - 0.04, 0.05, 0.03], [0, 0.07, z0 + height * h], 'wood');
  w.box([width + 0.34, 0.2, 0.045], [0, -0.08, z0 - 0.1], 'wood_dark');                   // sill
  w.box([1.36, 0.028, 0.028], [0, -0.12, 2.0], 'gold');                                   // curtain rod
  for (const sx of [-1, 1]) {
    w.ball(0.035, [sx * 0.7, -0.12, 2.014], 'gold', [1, 1, 1], { detail: 1 });
    const drape = [[-0.13, 0], [0.19, 0], [0.15, 0.32], [0.05, 0.52], [0.13, 0.7], [0.14, 1.22], [-0.13, 1.22], [-0.13, 0.7], [-0.1, 0.52], [-0.15, 0.32]]
      .map(([x, y]) => [sx * x, y]);                                      // tied back, flaring away from the glass
    w.slab(drape, 0.08, [sx * 0.57, -0.08, 0.78], 'indigo');
    w.box([0.21, 0.1, 0.055], [sx * 0.55, -0.12, 1.27], 'cream', { bevel: 0.02, soft: true });
    props.scallops(w, [sx * 0.43, -0.165, 0.79], [sx * 0.75, -0.165, 0.79], 0.032, { upright: true });
  }
  props.flowers(w.at([0.18, -0.09, z0 - 0.055]), 0.85);
  props.flowers(w.at([-0.14, -0.09, z0 - 0.055]), 0.6);
}

function buildBed(set) {
  const z = set.zone('zone_bed'), front = PLAT_FRONT;
  z.put(gPrism([[-1.7, front], [1.12, front], [1.12, 2.2], [-1.1, 2.2], [-1.7, 1.71]], PL), 'floor');
  z.box([2.86, 0.03, 0.03], [-0.29, front - 0.01, PL - 0.03], 'wood_dark');              // nosing on the step edge
  partition(z.at([-1.42, front + 0.045, PL]), 0.5);                                       // left of the bed, toward the kitchen
  post(z.at([-1.13, front + 0.045, PL]), 0.5);
  post(z.at([-1.72, front + 0.045, PL]), 0.5);
  partition(z.at([1.12, front + 0.42, PL], Math.PI / 2), 0.7);
  post(z.at([1.12, front, PL]), 0.5);
  z.box([0.86, 0.24, 0.075], [0.5, front - 0.12, 0], 'wood_light');

  bed(z.at(BED_AT));

  const n = z.at([0.2, 1.98, PL]);                                                        // nightstand
  props.cabinet(n, 0.4, 0.36, 0.44, [[0.24, 1, 'side'], [0.16, 1, 'knob']]);
  n.box([0.45, 0.4, 0.03], [0, 0, 0.44], 'wood_dark');
  props.lamp(n.at([0.03, 0.02, 0.47]));
  n.box([0.12, 0.09, 0.02], [-0.12, -0.11, 0.47], 'navy', { rot: 0.3 });

  const d = z.at([0.78, 1.97, PL]);                                                       // dresser
  props.cabinet(d, 0.62, 0.4, 0.76, [[0.24, 1, 'two'], [0.24, 1, 'two'], [0.24, 2, 'knob']]);
  d.box([0.67, 0.44, 0.03], [0, 0, 0.76], 'wood_dark');
  props.flowers(d.at([0.16, 0, 0.79]));
  props.books(d.at([0, 0.05, 0.79]), -0.28, -0.05, { depth: 0.16 });

  props.roundRug(z.at([0.5, 1.1, PL]), 0.34);

  const back = z.at([0, 2.2, 0]);                                                         // on the back wall
  back.box([0.68, 0.035, 0.48], [0.4, -0.018, 1.36], 'wood_dark');
  back.box([0.58, 0.04, 0.38], [0.4, -0.02, 1.41], 'blue');
  back.box([0.58, 0.043, 0.11], [0.4, -0.02, 1.41], 'indigo');
  props.whale(back, 0.36, 'cream', [0.4, -0.063, 1.62], { upright: true });
  props.stars(back, [[0.6, -0.063, 1.72]], 0.025, { upright: true });
  back.box([0.8, 0.008, 0.008], [-0.62, -0.006, 1.845], 'wood_dark');
  for (let i = 0; i < 6; i++) {
    const sag = 0.04 * Math.sin(Math.PI * i / 5);
    back.slab([[-0.055, 0], [0.055, 0], [0, -0.13]], 0.012, [-0.97 + i * 0.14, 0, 1.84 - sag], ['indigo', 'cream'][i % 2]);
  }
  props.stars(back, [[-0.62, -0.012, 1.62]], 0.045, { upright: true });

  windowDressing(set.zone('zone_bed').in(wallFrame(P2, P1)));

  const k = z.at([-0.45, PLAT_FRONT - 0.2, 0]);                                           // basket of towels
  props.basket(k, 0.46, 0.3, 0.22);
  k.cyl(0.07, 0.3, [-0.1, 0.15, 0.25], 'cream', { tilt: tiltX(Math.PI / 2) });
  k.cyl(0.07, 0.3, [0.07, 0.15, 0.25], 'indigo', { tilt: tiltX(Math.PI / 2) });
  k.cyl(0.065, 0.3, [-0.02, 0.15, 0.34], 'linen', { tilt: tiltX(Math.PI / 2) });
  props.stars(k, [[0, -0.155, 0.1]], 0.045, { upright: true });
}

// ---------------------------------------------------------------- zone: kitchen + dining

function kettle(z) {
  z.lathe([[0, 0], [0.1, 0], [0.125, 0.045], [0.115, 0.1], [0.06, 0.15], [0, 0.155]], [0, 0, 0], 'navy');
  z.cyl(0.126, 0.02, [0, 0, 0.04], 'indigo');
  z.cyl(0.05, 0.015, [0, 0, 0.15], 'indigo');
  z.ball(0.02, [0, 0, 0.18], 'gold', [1, 1, 1], { detail: 1 });
  z.put(gCyl(0.02, 0.11, 0.012), 'navy', [0.08, 0, 0.06], 0, tiltY(0.9));
  z.ring(0.085, 0.011, [0, 0, 0.13], 'gold', 0.15, Math.PI - 0.15);
}

/** The whale teapot. */
function teapot(z) {
  z.ball(0.075, [0, 0, 0.062], 'cream', [1.25, 1.0, 0.82]);
  z.ball(0.07, [0, 0, 0.08], 'indigo', [1.22, 0.98, 0.55]);
  z.ball(0.016, [0, 0, 0.125], 'gold', [1, 1, 1], { detail: 1 });
  z.put(gCyl(0.016, 0.08, 0.01), 'cream', [-0.08, 0, 0.06], 0, tiltY(-0.9));
  z.ring(0.035, 0.008, [0.1, 0, 0.065], 'indigo', -Math.PI / 2, Math.PI / 2);
  z.ball(0.012, [-0.045, -0.062, 0.07], 'navy', [1, 1, 1], { detail: 1 });
}

/** Where the stove's free burner is, in the kitchen's frame. */
const kitchenFrame = (set, name) => set.zone(name).in(wallFrame(P1, P0)).at([0.1, 0, 0]);                 // +x = toward the back of the room
const BURNER = [0.41, -0.3, 0.744];

/** Her pot on the free burner, and the steam over it once it is done: shown only while she is cooking. */
function pot(set) {
  const p = kitchenFrame(set, 'thing_pot').at(BURNER);
  p.lathe([[0, 0], [0.085, 0], [0.095, 0.012], [0.095, 0.1], [0.1, 0.105], [0, 0.105]], [0, 0, 0], 'cream');
  p.cyl(0.098, 0.012, [0, 0, 0.1], 'navy');
  p.lathe([[0, 0], [0.09, 0], [0.05, 0.03], [0, 0.035]], [0, 0, 0.112], 'navy');
  p.ball(0.016, [0, 0, 0.152], 'gold', [1, 1, 1], { detail: 1 });
  for (const side of [-1, 1]) p.box([0.05, 0.022, 0.016], [side * 0.112, 0, 0.085], 'navy');
  const steam = kitchenFrame(set, 'thing_steam').at(BURNER).fused();
  for (const [x, z, r] of [[0.01, 0.22, 0.035], [-0.03, 0.3, 0.045], [0.02, 0.4, 0.055]]) steam.ball(r, [x, 0, z], 'lace', [1, 1, 0.9], { detail: 1 });
}

function buildKitchen(set) {
  const k = kitchenFrame(set, 'zone_kitchen');
  k.box([2.38, 0.02, 0.34], [-0.3, -0.01, 0.71], 'tiles_wall');
  props.cabinet(k.at([-0.3, -0.29, 0]), 2.3, 0.55, 0.66, [[0.44, 4, 'side'], [0.18, 4, 'bar']]);
  k.box([2.38, 0.63, 0.05], [-0.3, -0.3, 0.66], 'cream', { bevel: 0.018, soft: true });

  k.box([0.46, 0.34, 0.014], [-1.0, -0.32, 0.706], 'steel');                              // sink
  k.box([0.38, 0.26, 0.008], [-1.0, -0.32, 0.716], 'metal');
  k.cyl(0.02, 0.14, [-1.0, -0.1, 0.71], 'gold', { segs: 10 });
  k.at([-1.0, -0.16, 0.85], Math.PI / 2).ring(0.06, 0.013, [0, 0, 0], 'gold', 0, Math.PI);
  for (const x of [-1.09, -0.91]) k.ball(0.022, [x, -0.1, 0.735], 'gold', [1, 1, 1], { detail: 1 });

  const s = k.at([0.3, -0.3, 0.71]);                                                      // stove
  s.box([0.46, 0.36, 0.02], [0, 0, 0], 'metal');
  for (const x of [-0.11, 0.11]) {
    s.cyl(0.075, 0.012, [x, 0, 0.02], 'steel');
    s.cyl(0.045, 0.014, [x, 0, 0.02], 'metal');
  }
  kettle(s.at([-0.11, 0, 0.034]));

  k.lathe([[0, 0], [0.05, 0], [0.105, 0.05], [0.095, 0.055], [0, 0.02]], [-0.45, -0.3, 0.71], 'wood_light');   // fruit
  for (const [dx, dy] of [[0.035, 0], [-0.03, 0.025], [0, -0.035]]) k.ball(0.036, [-0.45 + dx, -0.3 + dy, 0.778], 'yellow');
  k.put(gBox(0.22, 0.02, 0.32), 'wood_light', [-0.06, -0.06, 0.71], 0, tiltX(0.18));
  k.put(gBox(0.16, 0.02, 0.24), 'wood', [-0.2, -0.07, 0.71], 0, tiltX(0.22));
  props.plant(k.at([-1.34, -0.33, 0.71]), 0.9);
  props.towel(k.at([-0.95, -0.578, 0.6]), 0.18, 0.3);

  for (const [x, zh, length] of [[-0.2, 1.05, 2.0], [0.4, 1.42, 1.3]]) {                  // shelves
    k.box([length, 0.2, 0.035], [x, -0.1, zh], 'wood');
    for (const sx of [-1, 1]) k.box([0.035, 0.16, 0.1], [x + sx * (length / 2 - 0.12), -0.08, zh - 0.1], 'wood_dark');
  }
  props.ivyPot(k.at([-1.08, -0.1, 1.085]), 0.5);
  for (const [x, content] of [[-0.86, 'tan'], [-0.73, 'linen']]) props.jar(k.at([x, -0.1, 1.085]), content);
  for (const x of [-0.52, -0.4, -0.28, -0.16]) props.cup(k.at([x, -0.1, 1.085]));
  props.jar(k.at([0.05, -0.1, 1.085]), 'brown', 'gold');
  k.disc(0.085, 0.012, [0.3, -0.03, 1.17], 'cream');
  k.disc(0.06, 0.014, [0.3, -0.03, 1.17], 'indigo');
  k.disc(0.045, 0.016, [0.3, -0.03, 1.17], 'cream');
  k.box([0.52, 0.012, 0.012], [0.5, -0.19, 0.99], 'gold');                                // towel bar
  props.towel(k.at([0.5, -0.197, 0.99]), 0.16, 0.22);
  for (const [x, content] of [[0.0, 'linen'], [0.14, 'tan'], [0.28, 'brown']]) props.jar(k.at([x, -0.1, 1.455]), content);
  props.cup(k.at([0.5, -0.1, 1.455]));
  props.cup(k.at([0.62, -0.1, 1.455]));
  props.ivyPot(k.at([0.92, -0.1, 1.455]), 0.6);

  k.box([1.0, 0.47, 0.01], [-0.4, -1.0, 0], 'cream');                                     // floor mat
  k.box([0.9, 0.37, 0.014], [-0.4, -1.0, 0], 'stripes');

  const d = set.zone('zone_kitchen').at([0.6, -1.0, 0]);                                  // dining set
  const rug = d.at([0.05, -0.15, 0]);
  for (const sx of [-1, 1]) props.scallops(rug, [sx * 1.37, -0.76, 0], [sx * 1.37, 0.76, 0], 0.045);
  rug.box([2.7, 1.6, 0.012], [0, 0, 0], 'indigo');
  rug.box([2.46, 1.36, 0.016], [0, 0, 0], 'navy');
  rug.box([2.3, 1.2, 0.018], [0, 0, 0], 'gold');
  rug.box([2.25, 1.15, 0.02], [0, 0, 0], 'navy');
  props.stars(rug, [-1, 1].flatMap(sx => [-1, 1].map(sy => [sx * 1.0, sy * 0.45, 0.02])), 0.05);
  props.whale(rug, 0.5, 'cream', [0.8, -0.42, 0.02], { flip: true });
  props.stars(rug, [[-0.85, 0.05, 0.02], [0.45, -0.5, 0.02], [-0.6, -0.48, 0.02]], 0.028, { mat: 'cream' });

  d.lathe([[0, 0], [0.2, 0], [0.2, 0.03], [0.07, 0.08], [0.05, 0.3], [0.09, 0.5], [0, 0.5]], [0, 0, 0], 'wood');
  d.lathe([[0, 0], [0.4, 0], [0.42, 0.015], [0.42, 0.035], [0.4, 0.05], [0, 0.05]], [0, 0, 0.5], 'wood', { segs: 32 });
  d.cyl(0.25, 0.006, [0, 0, 0.55], 'lace', { segs: 32 });
  props.scallopRing(d, 0.25, 0.03, { zc: 0.55, th: 0.004 });
  teapot(d.at([-0.06, -0.03, 0.556]));
  for (const [x, y] of [[0.14, -0.15], [-0.22, 0.12]]) {
    d.cyl(0.052, 0.006, [x, y, 0.556], 'cream', { segs: 14 });
    props.cup(d.at([x, y, 0.562]));
  }
  props.flowers(d.at([0.12, 0.14, 0.556]), 0.75);
  props.chair(d.at([-0.74, 0, 0], Math.PI / 2));
  props.chair(d.at([0.74, 0, 0], -Math.PI / 2));
}

// ---------------------------------------------------------------- zone: desk

/** Faces -Y. */
function armchair(a) {
  a.box([0.72, 0.64, 0.3], [0, 0, 0], 'linen', { bevel: 0.06, soft: true });
  a.box([0.72, 0.18, 0.48], [0, 0.25, 0.26], 'linen', { bevel: 0.07, soft: true });
  for (const sx of [-1, 1]) a.box([0.17, 0.52, 0.21], [sx * 0.285, -0.04, 0.27], 'linen', { bevel: 0.06, soft: true });
  a.box([0.4, 0.44, 0.09], [0, -0.07, 0.29], 'cream', { bevel: 0.035, soft: true });
  a.box([0.28, 0.1, 0.24], [0, 0.11, 0.37], 'navy', { bevel: 0.04, soft: true });         // whale cushion
  props.whale(a, 0.2, 'cream', [0, 0.058, 0.49], { upright: true });
  a.box([0.2, 0.42, 0.035], [0.285, -0.04, 0.475], 'plaid', { bevel: 0.014, soft: true }); // throw over the arm
  a.box([0.03, 0.42, 0.34], [0.385, -0.04, 0.16], 'plaid', { soft: true });
  a.box([0.2, 0.03, 0.2], [0.285, -0.262, 0.29], 'plaid', { soft: true });
  props.scallops(a, [0.19, -0.28, 0.29], [0.38, -0.28, 0.29], 0.025, { upright: true });
}

function monitor(m) {
  m.box([0.18, 0.11, 0.015], [0, 0, 0], 'metal');
  m.box([0.035, 0.03, 0.1], [0, 0.01, 0], 'metal');
  m.box([0.54, 0.03, 0.33], [0, 0, 0.08], 'metal', { bevel: 0.014, soft: true });
  m.box([0.49, 0.006, 0.28], [0, -0.016, 0.105], 'screen');
  m.box([0.49, 0.007, 0.035], [0, -0.016, 0.35], 'blue');
  m.box([0.22, 0.005, 0.06], [-0.1, -0.019, 0.27], 'lace');
  m.box([0.22, 0.005, 0.06], [0.1, -0.019, 0.19], 'peri');
  m.box([0.16, 0.005, 0.045], [-0.13, -0.019, 0.125], 'lace');
}

function buildDesk(set) {
  const z = set.zone('zone_desk');
  const s = z.at([3.45, 0.52, 0]);                                                        // bookshelf
  s.box([1.5, 0.03, 1.25], [0, 0.135, 0], 'wood_dark');
  for (const sx of [-1, 1]) s.box([0.04, 0.3, 1.25], [sx * 0.73, 0, 0], 'wood');
  for (const zh of [0.0, 0.58, 0.9]) s.box([1.42, 0.28, 0.03], [0, 0, zh], 'wood');
  s.box([1.58, 0.34, 0.05], [0, 0, 1.25], 'wood');
  props.books(s.at([0, -0.03, 0.93]), -0.68, 0.12);
  props.whale(s, 0.32, 'blue', [0.42, 0.0, 1.005], { upright: true, th: 0.07 });
  props.books(s.at([0, -0.03, 0.61]), -0.1, 0.68);
  props.flowers(s.at([-0.42, -0.03, 0.61]), 0.8);
  props.ivyPot(s.at([-0.56, -0.02, 1.3]), 0.8, { s: 1.1, spread: 0.08 });
  props.books(s.at([0.3, 0, 1.3]), 0.0, 0.3);
  props.bookStack(s.at([-0.05, 0, 1.3]));

  const d = z.at([3.35, 0.05, 0]);                                                        // desk
  d.box([1.1, 0.54, 0.045], [0, 0, 0.5], 'wood', { bevel: 0.015, soft: true });
  props.cabinet(d.at([0.33, 0, 0]), 0.4, 0.46, 0.5, [[0.16, 1, 'bar'], [0.15, 1, 'bar'], [0.15, 1, 'bar']]);
  for (const sy of [-1, 1]) d.lathe([[0, 0], [0.02, 0], [0.03, 0.5], [0, 0.5]], [-0.47, sy * 0.2, 0], 'wood', { segs: 8 });
  d.box([0.62, 0.02, 0.26], [-0.19, 0.23, 0.22], 'wood');
  monitor(d.at([-0.1, 0.13, 0.545]));
  d.box([0.36, 0.12, 0.015], [-0.1, -0.1, 0.545], 'cream');
  d.box([0.32, 0.085, 0.006], [-0.1, -0.1, 0.56], 'linen');
  d.ball(0.026, [0.15, -0.1, 0.553], 'cream', [0.8, 1.2, 0.5], { detail: 1 });
  d.box([0.11, 0.08, 0.03], [0.38, 0.1, 0.545], 'navy');                                  // phone on its dock
  d.box([0.09, 0.014, 0.17], [0.38, 0.105, 0.57], 'metal');
  d.box([0.075, 0.004, 0.14], [0.38, 0.096, 0.585], 'screen');
  d.box([0.05, 0.003, 0.025], [0.38, 0.093, 0.67], 'lace');
  props.flowers(d.at([-0.44, 0.15, 0.545]), 0.6);
  d.cyl(0.032, 0.07, [0.24, 0.17, 0.545], 'indigo', { segs: 12 });                        // pen cup
  ['gold', 'blue', 'cream'].forEach((mat, i) => d.put(gBox(0.008, 0.008, 0.1), mat, [0.23 + 0.012 * i, 0.17, 0.57], 0, tiltY(0.2 * (i - 1))));
  props.chair(z.at([3.25, -0.43, 0], Math.PI));

  armchair(z.at([2.15, -0.25, 0]));

  const o = z.at([2.15, -0.98, 0]);                                                       // ottoman
  o.lathe([[0, 0.035], [0.2, 0.035], [0.245, 0.08], [0.245, 0.2], [0.2, 0.24], [0, 0.24]], [0, 0, 0], 'plaid');
  o.cyl(0.248, 0.02, [0, 0, 0.075], 'indigo');
  for (let i = 0; i < 4; i++) {
    const ang = Math.PI / 4 + i * Math.PI / 2;
    o.cyl(0.025, 0.045, [0.15 * Math.cos(ang), 0.15 * Math.sin(ang), 0], 'wood_dark', { segs: 8 });
  }

  const t = z.at([1.62, 0.3, 0]);                                                         // side table + lamp
  t.cyl(0.1, 0.02, [0, 0, 0], 'wood');
  t.lathe([[0, 0], [0.03, 0], [0.02, 0.2], [0.035, 0.4], [0, 0.4]], [0, 0, 0], 'wood', { segs: 10 });
  t.lathe([[0, 0], [0.18, 0], [0.19, 0.015], [0.18, 0.03], [0, 0.03]], [0, 0, 0.4], 'wood');
  props.lamp(t.at([0.03, 0.03, 0.43]), 1.25);
  props.bookStack(t.at([-0.05, -0.09, 0.43]), 2);
}

// ---------------------------------------------------------------- zone: mirror

function buildMirror(set) {
  const z = set.zone('zone_mirror');
  const m = z.at([1.75, 2.2, 0]), base = 0.09;
  m.box([0.98, 0.28, 0.09], [0, -0.15, 0], 'cream');
  m.box([1.0, 0.29, 0.02], [0, -0.15, 0.075], 'gold');
  const oval = (rx, rz) => ellipse(rx, rz, 0, 0.95, 32);                                  // the glass is an upright oval
  m.put(gFrame(oval(0.47, 0.88), oval(0.33, 0.73), 0.11), 'cream', [0, -0.02, base]);
  m.put(gFrame(oval(0.37, 0.77), oval(0.32, 0.72), 0.014), 'gold', [0, -0.13, base]);
  m.put(gFrame(oval(0.49, 0.9), oval(0.455, 0.865), 0.05), 'indigo', [0, -0.04, base]);
  m.slab(oval(0.33, 0.73), 0.03, [0, -0.07, base], 'glass');
  for (const [dx, w] of [[0, 0.07], [0.11, 0.03]]) {                                      // the toon highlight across the glass
    m.slab([[-0.2 + dx, 0.8], [-0.2 + dx + w, 0.8], [0.0 + dx + w, 1.25], [0.0 + dx, 1.25]], 0.004, [0, -0.1, base], 'glass_hi');
  }
  for (const [x, zc] of [[-0.33, 0.33], [0.33, 0.33], [-0.33, 1.57], [0.33, 1.57]]) m.ball(0.06, [x, -0.1, base + zc], 'indigo', [1, 0.6, 1]);
  props.mirrorCrown(m.at([0, -0.075, base + 1.8]), 0.4);
  for (const sx of [-1, 1]) {
    m.box([0.16, 0.14, 0.24], [sx * 0.37, -0.085, base], 'indigo', { bevel: 0.045, soft: true });
    m.ball(0.045, [sx * 0.37, -0.13, base + 0.27], 'gold', [1, 1, 1], { detail: 1 });
    m.ball(0.035, [sx * 0.48, -0.1, base + 0.95], 'gold', [1, 1, 1], { detail: 1 });
  }
  m.box([0.16, 0.05, 0.1], [0.42, -0.14, 0.98], 'gold', { bevel: 0.02, soft: true });     // latch: the lock hangs here
  m.ring(0.03, 0.008, [0.42, -0.17, 0.98], 'gold');

  props.roundRug(z.at([1.75, 1.6, 0]), 0.5);
  const f = z.at([1.27, 1.88, 0]);                                                        // flowers on a stool, in front of the pillar
  props.stool(f);
  f.cyl(0.11, 0.006, [0, 0, 0.33], 'lace', { segs: 16 });
  props.flowers(f.at([0, 0, 0.336]));
  props.sconce(z.at([1.2, 2.11, 1.45]));
  props.ivyPot(z.at([1.2, 2.06, 2.2]), 0.75, { s: 1.1, spread: 0.12 });                   // trailing down from the top beam
}

// ---------------------------------------------------------------- extra: bathroom, front door

function buildBathroom(set) {
  const z = set.zone('extra');
  props.archedDoor(z.at([2.65, 2.2, 0]), 0.46, 1.5, 'wood', 'wood_light');

  z.box([0.5, 0.5, 0.05], [3.22, 2.93, 0], 'cream');                                      // shower tray
  for (const [x, y] of [[2.98, 2.69], [3.46, 2.69], [3.46, 3.17]]) z.box([0.02, 0.02, 1.45], [x, y, 0.05], 'gold');
  z.box([0.5, 0.02, 0.02], [3.22, 2.69, 1.48], 'gold');
  z.box([0.02, 0.5, 0.02], [3.46, 2.93, 1.48], 'gold');
  z.box([0.02, 0.02, 0.5], [3.22, 3.17, 1.1], 'gold');
  z.box([0.02, 0.16, 0.02], [3.22, 3.1, 1.6], 'gold');
  z.cyl(0.07, 0.02, [3.22, 3.02, 1.56], 'gold', { segs: 14 });

  const t = z.at([3.68, 3.0, 0]);                                                         // toilet
  t.box([0.28, 0.13, 0.32], [0, 0.11, 0.22], 'cream', { bevel: 0.03, soft: true });
  t.lathe([[0, 0], [0.09, 0], [0.07, 0.12], [0.14, 0.26], [0.13, 0.3], [0, 0.3]], [0, -0.06, 0], 'cream');
  t.lathe([[0, 0], [0.14, 0], [0.13, 0.025], [0, 0.03]], [0, -0.06, 0.3], 'lace');
  t.box([0.05, 0.03, 0.02], [0.08, 0.05, 0.54], 'gold');
  z.box([0.34, 0.1, 0.025], [3.68, 3.14, 1.05], 'wood');                                  // shelf over it
  for (const [x, mat] of [[3.58, 'indigo'], [3.67, 'cream'], [3.76, 'blue']]) {
    z.cyl(0.03, 0.1, [x, 3.14, 1.075], mat, { segs: 10 });
    z.cyl(0.015, 0.03, [x, 3.14, 1.175], 'gold', { segs: 8 });
  }

  const v = set.zone('extra').in(wallFrame(P4, B1));                                      // on the right-hand wall
  props.cabinet(v.at([0.05, -0.16, 0]), 0.46, 0.3, 0.46, [[0.42, 2, 'side']]);
  v.box([0.5, 0.34, 0.04], [0.05, -0.17, 0.46], 'cream', { soft: true });
  v.lathe([[0, 0], [0.05, 0], [0.12, 0.06], [0.11, 0.065], [0, 0.02]], [0.05, -0.17, 0.5], 'lace');
  v.cyl(0.015, 0.1, [0.05, -0.04, 0.5], 'gold', { segs: 8 });
  v.box([0.02, 0.09, 0.02], [0.05, -0.08, 0.6], 'gold');
  v.disc(0.19, 0.02, [0.05, 0, 1.2], 'gold');
  v.disc(0.16, 0.024, [0.05, 0, 1.2], 'glass');
  props.sconce(v.at([0.05, 0, 1.6]));
  v.box([0.3, 0.012, 0.012], [-0.36, -0.04, 1.0], 'gold');
  props.towel(v.at([-0.36, -0.047, 1.0]), 0.2, 0.3);

  const mat = z.at([3.4, 2.5, 0]);
  props.roundRug(mat, 0.22);
  props.whale(mat, 0.2, 'cream', [0, 0, 0.02]);
  const b = z.at([3.85, 2.42, 0]);
  props.basket(b, 0.24, 0.2, 0.2);
  b.cyl(0.05, 0.18, [0, 0.09, 0.2], 'cream', { tilt: tiltX(Math.PI / 2) });
}

function buildEntry(set) {
  const r = set.zone('extra').in(wallFrame(P5, P4));                                      // +x = toward the front
  const door = r.at([0.55, 0, 0]);
  props.archedDoor(door, 0.74, 1.62, 'navy', 'navy_light');
  const fan = Array.from({ length: 13 }, (_, i) => [0.25 * Math.cos(Math.PI * i / 12), 0.25 * Math.sin(Math.PI * i / 12)]);
  door.slab(fan, 0.058, [0, 0, 1.3], 'cream');
  door.slab(fan.map(([x, y]) => [x * 0.86, y * 0.86]), 0.06, [0, 0, 1.3], 'sky');
  for (let i = 1; i < 4; i++) door.put(gBox(0.02, 0.064, 0.22), 'cream', [0, -0.032, 1.3], 0, tiltY(Math.PI * i / 4 - Math.PI / 2));
  door.box([0.9, 0.2, 0.04], [0, -0.1, 0], 'wood_dark');                                  // threshold
  const mat = door.at([0, -0.45, 0]);
  for (const sx of [-1, 1]) props.scallops(mat, [sx * 0.36, -0.2, 0], [sx * 0.36, 0.2, 0], 0.035);
  mat.box([0.7, 0.44, 0.012], [0, 0, 0], 'cream');
  mat.box([0.6, 0.34, 0.016], [0, 0, 0], 'indigo');
  props.whale(mat, 0.3, 'cream', [0, 0, 0.016]);

  r.box([0.46, 0.03, 0.06], [1.42, -0.015, 1.25], 'wood_dark');                           // hooks, coat, umbrella
  for (const x of [1.27, 1.42, 1.57]) {
    r.box([0.02, 0.06, 0.02], [x, -0.05, 1.26], 'gold');
    r.ball(0.018, [x, -0.085, 1.27], 'gold', [1, 1, 1], { detail: 1 });
  }
  r.box([0.24, 0.08, 0.46], [1.3, -0.08, 0.8], 'navy', { bevel: 0.035, soft: true });
  r.box([0.25, 0.085, 0.06], [1.3, -0.08, 0.8], 'cream', { bevel: 0.02, soft: true });
  r.box([0.18, 0.09, 0.07], [1.3, -0.08, 1.2], 'cream', { bevel: 0.025, soft: true });
  r.lathe([[0, 0], [0.035, 0.08], [0.05, 0.55], [0, 0.6]], [1.57, -0.09, 0.62], 'indigo', { segs: 10 });
  r.ring(0.03, 0.008, [1.57, -0.09, 0.6], 'wood_dark', Math.PI, 2 * Math.PI);

  const s = r.at([1.45, -0.17, 0]);                                                       // shoe rack
  for (const sx of [-1, 1]) s.box([0.03, 0.3, 0.36], [sx * 0.29, 0, 0], 'wood');
  for (const zh of [0.04, 0.2, 0.36]) s.box([0.6, 0.3, 0.025], [0, 0, zh], 'wood');
  for (const [x, zh, m] of [[-0.16, 0.065, 'navy'], [0.02, 0.065, 'navy'], [-0.12, 0.225, 'cream'], [0.06, 0.225, 'cream'], [0.2, 0.065, 'tan']]) {
    s.box([0.09, 0.2, 0.06], [x, -0.02, zh], m, { bevel: 0.025, soft: true });
    s.box([0.085, 0.09, 0.05], [x, 0.04, zh + 0.03], m, { bevel: 0.02, soft: true });
  }
  props.basket(s.at([0.05, 0, 0.385]), 0.3, 0.22, 0.14);

  const p = set.zone('extra').at([4.25, -1.75, 0]);                                       // plant stand, front right
  p.box([0.3, 0.3, 0.42], [0, 0, 0], 'wood');
  p.box([0.26, 0.012, 0.3], [0, -0.152, 0.06], 'wood_light');
  p.box([0.35, 0.35, 0.035], [0, 0, 0.42], 'wood_dark');
  props.plant(p.at([0, 0, 0.455]), 1.5);
}

/** Adds every part of the cottage to the set, grouped as shell, zone_bed, zone_kitchen, zone_desk, zone_mirror, extra, and one group per movable thing. */
/**
 * What your cut-away view leaves open, so that from inside she is in a closed room: the front walls, the sloping wall
 * tops made up to full height, the open side of the bathroom, and a ceiling. All of it is the group `enclosure`, which
 * the page puts on the stage's inside layer: only her eyes see it.
 */
function buildEnclosure(set) {
  const group = 'enclosure', top = H + 0.12;
  for (const [a, b] of [[F0, F1], [F1, P5], [P0, F0]]) wall(set, a, b, H, H, 'wall', 'wood_dark', group);
  wall(set, P4, DOOR_WALL_END, H, H, 'wall', 'wood_dark', group);                  // the bathroom's open side, from the room
  // Above the low and sloping walls, up to the ceiling.
  for (const [a, b, hB, hA] of [[P1, P0, H_KITCHEN_FRONT, H], [P5, P4, H, H_DOOR_FRONT], [DOOR_WALL_END, P3, H_BATH, H_BATH]]) {
    const hx = Math.hypot(b[0] - a[0], b[1] - a[1]) / 2;
    set.zone(group).in(wallFrame(a, b)).put(gWall(-hx, hx, 0, T, hB + 0.12, top, hA + 0.12, top), 'wall');
  }
  const z = set.zone(group);
  // Full-height posts where your view has short ones, starting where those stop.
  for (const [[x, y], from] of [[[F0[0] + 0.12, F0[1] + 0.12], 0.51], [[F1[0] - 0.12, F1[1] + 0.12], 0.51], [P0, H_KITCHEN_FRONT + 0.18], [P5, H_DOOR_FRONT + 0.18]]) {
    z.box([0.22, 0.22, top + 0.06 - from], [x, y, from], 'beam');
  }
  z.put(gPrism(FOOTPRINT, 0.08), 'wall_low', [0, 0, top]);
  for (const x of [-1.0, 1.2, 3.4]) z.box([0.16, 4.4, 0.12], [x, 0.0, top - 0.12], 'beam');   // ceiling beams, front to back
}

export function buildRoom(set) {
  props.stool(set.zone('thing_stool'), 0.15, 0.3);            // built at the origin: the routine moves it about
  pot(set);
  buildShell(set);
  buildBed(set);
  buildKitchen(set);
  buildDesk(set);
  buildMirror(set);
  buildBathroom(set);
  buildEntry(set);
  buildEnclosure(set);
}
