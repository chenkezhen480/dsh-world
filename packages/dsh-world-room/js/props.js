// Reusable furniture and decoration. Every function draws at the origin of the Zone it is given.
import { RNG, arch, ellipse, gBall, gBox, gFrame, move, rect, spin, star, tailOutline, tiltY } from './kit.js';

const TAU = 2 * Math.PI;

// ---------------------------------------------------------------- motifs and trims

const FLUKES = [[0.72, 0.12], [0.98, -0.1], [1.28, 0.34], [1.56, 0.28], [1.62, 0.6], [1.38, 0.62], [1.36, 0.92], [1.1, 0.76], [1.08, 0.5]];

/** Chubby side-view whale, nose at -X (or +X when flipped), centred on loc; flat on the floor or upright on a wall. */
export function whale(z, length, mat, loc, { rot = 0, upright = false, flip = false, th = 0.004 } = {}) {
  const s = length / 2.62, side = flip ? -1 : 1, put = z.fused().at(loc, rot);
  const shape = (points, mat_, grow = 1) => {
    const pts = points.map(([x, y]) => [side * (x - 0.31) * s, y * s]);
    if (flip) pts.reverse();
    if (upright) put.slab(pts, th * grow, [0, 0, 0], mat_); else put.plate(pts, th * grow, [0, 0, 0], mat_);
  };
  shape(ellipse(1.0, 0.64), mat);
  shape(FLUKES, mat, 0.75);
  for (const [cx, cy, r] of [[-0.55, 0.92, 0.09], [-0.35, 1.06, 0.07]]) shape(ellipse(r, r, cx, cy, 8), mat);
  shape(ellipse(0.075, 0.075, -0.6, 0.08, 8), ['cream', 'lace', 'blue'].includes(mat) ? 'navy' : 'lace', 1.4);
}

export function stars(z, spots, r, { mat = 'gold', upright = false, th = 0.004 } = {}) {
  for (const loc of spots) (upright ? z.slab(star(r), th, loc, mat) : z.plate(star(r), th, loc, mat));
}

/** Row of little discs from p0 to p1: lace edging. */
export function scallops(z, p0, p1, r, { mat = 'lace', upright = false, th = 0.008 } = {}) {
  const n = Math.max(2, Math.round(Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]) / (r * 1.6)) + 1);
  z = z.fused();
  for (let i = 0; i < n; i++) {
    const loc = p0.map((a, k) => a + (p1[k] - a) * i / (n - 1));
    if (upright) z.disc(r, th, loc, mat, 10); else z.cyl(r, th, loc, mat, { segs: 10 });
  }
}

export function scallopRing(z, radius, r, { zc = 0, mat = 'lace', th = 0.008 } = {}) {
  const n = Math.max(8, Math.round(TAU * radius / (r * 1.6)));
  z = z.fused();
  for (let i = 0; i < n; i++) z.cyl(r, th, [radius * Math.cos(TAU * i / n), radius * Math.sin(TAU * i / n), zc], mat, { segs: 10 });
}

/** Ribbon bow in the XZ plane, facing -Y, knot at the origin. */
export function bow(z, w, mat = 'blue') {
  z = z.fused();
  for (const s of [-1, 1]) {
    z.ball(w * 0.27, [s * w * 0.27, 0, 0.02 * w], mat, [1, 0.35, 0.72], { tilt: tiltY(s * 0.3) });
    z.put(gBox(w * 0.17, w * 0.05, w * 0.42), mat, [s * w * 0.14, 0, -w * 0.48], 0, tiltY(-s * 0.28));
  }
  z.ball(w * 0.1, [0, -w * 0.04, 0], 'gold', [1, 1, 1], { detail: 1 });
}

// ---------------------------------------------------------------- casework

/** Door or drawer front on the plane y=0, facing -Y, origin bottom centre. */
function panel(z, w, h, frame, inset, pull) {
  z.box([w, 0.02, h], [0, -0.01, 0], frame);
  if (Math.min(w, h) > 0.15) z.box([w - 0.07, 0.012, h - 0.07], [0, -0.024, 0.035], inset);
  const spots = { knob: [[0, h / 2]], side: [[w * 0.34, h / 2]], two: [[-w * 0.27, h / 2], [w * 0.27, h / 2]] };
  if (pull === 'bar') z.box([Math.min(0.14, w * 0.45), 0.016, 0.018], [0, -0.045, h / 2 - 0.009], 'gold');
  for (const [x, zc] of spots[pull] ?? []) z.ball(0.018, [x, -0.042, zc], 'gold', [1, 1, 1], { detail: 1 });
}

/** rows, bottom to top: [height, columns, pull] */
export function cabinet(z, w, d, h, rows, { body = 'wood', frame = 'wood', inset = 'wood_light' } = {}) {
  z.box([w, d, h], [0, 0, 0], body);
  let z0 = 0.02;
  for (const [rh, cols, pull] of rows) {
    const cw = (w - 0.03) / cols;
    for (let c = 0; c < cols; c++) panel(z.at([-w / 2 + 0.015 + cw * (c + 0.5), -d / 2, z0]), cw - 0.02, rh - 0.02, frame, inset, pull);
    z0 += rh;
  }
}

/** Seat faces -Y, back at +Y. */
export function chair(z, cushion = 'plaid') {
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) z.lathe([[0, 0], [0.016, 0], [0.024, 0.26], [0, 0.26]], [sx * 0.14, sy * 0.14, 0], 'wood', { segs: 8 });
    z.cyl(0.02, 0.42, [sx * 0.15, 0.16, 0.28], 'wood', { segs: 8 });
  }
  z.box([0.36, 0.36, 0.04], [0, 0, 0.26], 'wood', { bevel: 0.015, soft: true });
  z.box([0.38, 0.04, 0.09], [0, 0.16, 0.65], 'wood', { bevel: 0.02, soft: true });
  z.box([0.3, 0.025, 0.03], [0, 0.16, 0.4], 'wood');
  for (const x of [-0.09, -0.03, 0.03, 0.09]) z.cyl(0.011, 0.23, [x, 0.16, 0.43], 'wood', { segs: 6 });
  z.box([0.31, 0.31, 0.06], [0, -0.01, 0.3], cushion, { bevel: 0.025, soft: true });
  bow(z.at([0, 0.19, 0.6], Math.PI), 0.17);
}

export function stool(z, r = 0.14, h = 0.3) {
  z.lathe([[0, 0], [r, 0], [r + 0.01, 0.015], [r, 0.03], [0, 0.03]], [0, 0, h], 'wood');
  for (let i = 0; i < 3; i++) {
    const a = TAU * i / 3 + 0.5;
    z.lathe([[0, 0], [0.014, 0], [0.02, h], [0, h]], [r * 0.6 * Math.cos(a), r * 0.6 * Math.sin(a), 0], 'wood', { segs: 8 });
  }
}

export function basket(z, w, d, h) {
  z.box([w, d, h], [0, 0, 0], 'tan', { bevel: 0.03, soft: true });
  z.box([w + 0.02, d + 0.02, 0.035], [0, 0, h - 0.03], 'wood_light');
  for (let i = 1; i < 3; i++) z.box([w + 0.006, d + 0.006, 0.01], [0, 0, h * i / 3.4], 'wood_light');
}

// ---------------------------------------------------------------- lights

export function lamp(z, s = 1) {
  z.lathe([[0, 0], [0.065 * s, 0], [0.065 * s, 0.012 * s], [0.03 * s, 0.03 * s], [0.022 * s, 0.06 * s], [0.04 * s, 0.1 * s],
    [0.04 * s, 0.13 * s], [0.015 * s, 0.17 * s], [0.012 * s, 0.24 * s], [0, 0.24 * s]], [0, 0, 0], 'gold');
  z.lathe([[0, 0.2 * s], [0.15 * s, 0.2 * s], [0.085 * s, 0.37 * s], [0, 0.37 * s]], [0, 0, 0], 'shade');
  z.cyl(0.154 * s, 0.014 * s, [0, 0, 0.196 * s], 'gold');
  z.cyl(0.089 * s, 0.012 * s, [0, 0, 0.364 * s], 'gold');
  z.ball(0.016 * s, [0, 0, 0.385 * s], 'gold', [1, 1, 1], { detail: 1 });
  const frill = z.fused();                                              // scalloped rim of the shade
  for (let i = 0; i < 12; i++) frill.ball(0.03 * s, [0.145 * s * Math.cos(TAU * i / 12), 0.145 * s * Math.sin(TAU * i / 12), 0.205 * s], 'shade', [1, 1, 0.8], { detail: 1 });
  z.set.lamps.push(z.world([0, -0.06 * s, 0.5 * s]));
}

/** Wall light on the plane y=0. */
export function sconce(z) {
  z.box([0.05, 0.03, 0.12], [0, -0.015, -0.05], 'gold');
  z.box([0.025, 0.1, 0.025], [0, -0.06, -0.02], 'gold');
  z.lathe([[0, 0], [0.04, 0], [0.07, 0.11], [0.03, 0.14], [0, 0.14]], [0, -0.1, 0], 'shade');
  z.set.lamps.push(z.world([0, -0.24, 0.05]));
}

// ---------------------------------------------------------------- plants

function pot(z, s = 1, body = 'cream', band = 'indigo') {
  z.lathe([[0, 0], [0.06 * s, 0], [0.085 * s, 0.09 * s], [0.078 * s, 0.12 * s], [0.065 * s, 0.12 * s], [0, 0.1 * s]], [0, 0, 0], body);
  z.cyl(0.079 * s, 0.022 * s, [0, 0, 0.042 * s], band);
}

function bloom(z, loc, r) {
  z = z.fused();
  z.ball(r, loc, 'peri');
  for (let i = 0; i < 9; i++) {
    const a = RNG.uniform(0, TAU), up = RNG.uniform(0, 1), side = Math.sqrt(1 - up * up);
    z.ball(r * 0.5, [loc[0] + r * 0.8 * side * Math.cos(a), loc[1] + r * 0.8 * side * Math.sin(a), loc[2] + r * 0.8 * up],
      RNG.choice(['peri', 'blue', 'indigo', 'peri']), [1, 1, 1], { detail: 1 });
  }
}

/** Hydrangea in a pot. */
export function flowers(z, s = 1) {
  pot(z, s);
  for (let i = 0; i < 6; i++) {
    const lean = spin(TAU * i / 6).multiply(move(0.085 * s, 0, 0)).multiply(tiltY(-0.35));
    z.put(gBall(0.075 * s, [1, 0.6, 0.14], 1), ['green', 'green_dark'][i % 2], [0, 0, 0.13 * s], 0, lean);
  }
  for (let i = 0; i < 3; i++) {
    const a = TAU * i / 3 + 0.5;
    bloom(z, [0.06 * s * Math.cos(a), 0.06 * s * Math.sin(a), 0.2 * s], 0.056 * s);
  }
  bloom(z, [0, 0, 0.26 * s], 0.06 * s);
}

export function plant(z, s = 1) {
  pot(z, s);
  for (let i = 0; i < 10; i++) {
    const lean = spin(TAU * i / 10).multiply(tiltY(i % 2 ? 0.35 : 0.8)).multiply(move(0, 0, 0.1 * s));
    z.put(gBall(0.065 * s, [0.5, 0.14, 1.7], 1), ['green', 'green_dark'][i % 2], [0, 0, 0.11 * s], 0, lean);
  }
  z.ball(0.06 * s, [0, 0, 0.24 * s], 'green', [0.45, 0.14, 1.7], { detail: 1 });
}

/** Vines trailing down from the origin. */
function ivy(z, length, spread = 0.1, vines = 4) {
  z = z.fused();
  for (let v = 0; v < vines; v++) {
    const x0 = RNG.uniform(-spread, spread), drop = length * RNG.uniform(0.55, 1.0);
    z.box([0.008, 0.008, drop], [x0, 0, -drop], 'green_dark');
    const n = Math.max(3, Math.floor(drop / 0.065));
    for (let i = 0; i < n; i++) {
      const loc = [x0 + RNG.uniform(-0.035, 0.035), RNG.uniform(-0.025, 0), -drop * (i + 0.3) / n];
      z.put(gBall(RNG.uniform(0.034, 0.05), [1.1, 0.3, 1.15], 1), RNG.choice(['green', 'green_dark']), loc, 0, spin(RNG.uniform(-0.7, 0.7)));
    }
  }
}

export function ivyPot(z, length, { s = 0.9, spread = 0.1 } = {}) {
  pot(z, s);
  for (let i = 0; i < 5; i++) {
    const a = TAU * i / 5;
    z.put(gBall(0.05 * s, [1.1, 1.1, 0.5], 1), ['green', 'green_dark'][i % 2], [0.05 * s * Math.cos(a), 0.05 * s * Math.sin(a), 0.14 * s]);
  }
  ivy(z.at([0, -0.075 * s, 0.13 * s]), length, spread);
}

// ---------------------------------------------------------------- small things

export function jar(z, content = 'tan', lid = 'wood_dark') {
  z.cyl(0.05, 0.105, [0, 0, 0], content);
  z.cyl(0.054, 0.03, [0, 0, 0.105], lid);
  z.box([0.05, 0.006, 0.04], [0, -0.05, 0.035], 'cream');
}

export function cup(z) {
  z.cyl(0.032, 0.062, [0, 0, 0], 'cream', { r2: 0.04 });
  z.cyl(0.039, 0.015, [0, 0, 0.022], 'indigo');
  z.ring(0.02, 0.006, [0.045, 0, 0.032], 'cream', -Math.PI / 2, Math.PI / 2);
}

/** A row of upright books along X, standing on z=0. */
export function books(z, x0, x1, { depth = 0.18, hmin = 0.19, hmax = 0.27 } = {}) {
  let x = x0;
  while (x < x1) {
    const w = RNG.uniform(0.035, 0.06);
    if (RNG.random() >= 0.1) {
      z.box([w - 0.004, depth, RNG.uniform(hmin, hmax)], [x + w / 2, 0, 0],
        RNG.choice(['navy', 'indigo', 'navy', 'cream', 'gold', 'blue', 'navy_light']));
    }
    x += w;
  }
}

export function bookStack(z, n = 3) {
  for (let i = 0; i < n; i++) {
    z.box([0.17 - 0.012 * i, 0.12, 0.028], [0, 0, 0.028 * i], ['navy', 'cream', 'indigo', 'gold'][i % 4], { rot: RNG.uniform(-0.25, 0.25) });
  }
}

/** Hangs down from the origin on the plane y=0. */
export function towel(z, w, h) {
  z.box([w, 0.014, h], [0, -0.007, -h], 'cream');
  z.box([w, 0.016, 0.028], [0, -0.008, -h + 0.035], 'indigo');
  whale(z, w * 0.6, 'indigo', [0, -0.014, -h * 0.5], { upright: true });
}

export function roundRug(z, r, rim = 'cream', inner = 'indigo') {
  scallopRing(z, r, r * 0.09);
  z.cyl(r, 0.012, [0, 0, 0], rim, { segs: 32 });
  z.cyl(r * 0.8, 0.016, [0, 0, 0], inner, { segs: 32 });
  z.cyl(r * 0.55, 0.018, [0, 0, 0], rim, { segs: 32 });
  z.cyl(r * 0.48, 0.02, [0, 0, 0], inner, { segs: 32 });
}

/** Little round whale plaque on the plane y=0. */
function sign(z, r = 0.075) {
  z.disc(r, 0.012, [0, 0, 0], 'cream');
  z.disc(r * 0.86, 0.014, [0, 0, 0], 'lace');
  whale(z, r * 1.25, 'indigo', [0, -0.014, 0], { upright: true });
  z.ball(0.012, [0, -0.01, r], 'gold', [1, 1, 1], { detail: 1 });
}

/** Door on the wall plane y=0, facing -Y. */
export function archedDoor(z, w, h, leaf, inset, frame = 'wood_dark') {
  z.put(gFrame(arch(w + 0.16, h + 0.08), arch(w, h), 0.07), frame);
  z.slab(arch(w, h), 0.04, [0, 0, 0], leaf);
  z.slab(rect(w * 0.68, h * 0.3, 0.09), 0.012, [0, -0.04, 0], inset);
  z.slab(arch(w * 0.68, h * 0.46, h * 0.46), 0.012, [0, -0.04, 0], inset);
  z.box([0.04, 0.012, 0.13], [w * 0.37, -0.046, h * 0.4], 'gold');
  z.box([0.09, 0.02, 0.022], [w * 0.33, -0.066, h * 0.455], 'gold');
  sign(z.at([0, -0.052, h * 0.68]));
}

/** Whale tail on top of the mirror, in the plane y=0. */
export function mirrorCrown(z, width) {
  z.slab(tailOutline(width), 0.05, [0, 0.025, 0], 'indigo');
  z.ball(width * 0.11, [0, 0, 0], 'gold', [1, 1, 1], { detail: 1 });
}
