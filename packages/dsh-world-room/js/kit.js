// Geometry, colours and the Zone placer the room is built from.
// Everything here is Z-up (x right, y toward the back wall, z up; 1 unit = her height); the stage turns the whole room upright.
import * as THREE from 'three';
import { mergeGeometries, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

export const COLORS = {
  wall: '#F8ECDA', wall_low: '#EFDDC4', tile: '#F3EEE4',
  beam: '#8A5B40', wood: '#B98660', wood_light: '#DDB07E', wood_dark: '#96654A',
  navy: '#2D3364', navy_light: '#3D4785', indigo: '#4A5EA4', blue: '#5A8ED6', peri: '#7E92E4',
  cream: '#FAF4E8', lace: '#FFFDF6', linen: '#EDE3D0', tan: '#C9A36B', gold: '#D6B46C',
  green: '#7CA853', green_dark: '#5A8640', metal: '#3C3C4A', steel: '#B4BCC8',
  yellow: '#F2CB4E', pink: '#F2B8B0', brown: '#7A5038',
  glass: '#C4DCF4', glass_hi: '#EEF6FF', shade: '#FFE4B0', screen: '#E2EEFB', sky: '#D6ECFA',
  // outdoors
  leaf: '#7DB356', leaf_dark: '#5E9645', leaf_light: '#A3CF70', leaf_dry: '#BDB35E', bark: '#8A6247', blossom: '#F4B9C8', blossom_light: '#FBDDE4',
  pine: '#4F8652', blade: '#A0CE68', stone: '#CFC8BB', stone_dark: '#A9A193', dirt: '#D2B386', soil: '#8B6A4E', fence: '#F6F0E4', apple: '#E26A52',
};
/** Drawn unlit and casting no shadow: light sources and bright surfaces. */
const GLOW = new Set(['glass', 'glass_hi', 'shade', 'screen', 'sky']);
const SMOOTH_ANGLE = THREE.MathUtils.degToRad(35);

// ---------------------------------------------------------------- patterns (canvas textures, 1 UV unit = 1 scene unit / scale)

function canvas(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function planks(a, b, seam, rng) {
  // 4 units along the boards, 1 unit across (5 boards)
  return canvas(1024, 256, (g, w, h) => {
    const rows = 5, rh = h / rows;
    for (let r = 0; r < rows; r++) {
      let x = -rng.uniform(0, 300);
      while (x < w) {
        const len = rng.uniform(260, 420);
        g.fillStyle = rng.random() < 0.5 ? a : b;
        g.fillRect(x, r * rh, len, rh);
        g.fillStyle = seam;
        g.fillRect(x, r * rh, 4, rh);
        x += len;
      }
      g.fillStyle = seam;
      g.fillRect(0, r * rh, w, 3);
    }
  });
}

const mixHex = (a, b, t) => '#' + new THREE.Color(a).lerp(new THREE.Color(b), t).getHexString();

const PATTERNS = {
  floor: { scale: [0.25, 1], make: rng => planks('#D9A871', '#E1B480', '#BC8A5B', rng) },
  plaid: { scale: [11, 11], make: () => canvas(64, 64, (g) => {
    const a = '#F4EEE2', b = '#4A5EA4';
    g.fillStyle = a; g.fillRect(0, 0, 64, 64);
    g.fillStyle = mixHex(a, b, 0.5); g.fillRect(0, 0, 32, 64); g.fillRect(0, 0, 64, 32);
    g.fillStyle = b; g.fillRect(0, 0, 32, 32);
  }) },
  tiles_wall: { scale: [7, 7], make: () => tile('#F3EEE4', '#D9CDB8') },
  tiles_bath: { scale: [6, 6], make: () => tile('#DDE9F6', '#9DB8DC') },
  tiles_floor: { scale: [2.5, 2.5], make: () => canvas(64, 64, (g) => {
    g.fillStyle = '#E8F0FA'; g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#9DB8DC'; g.fillRect(0, 0, 32, 32); g.fillRect(32, 32, 32, 32);
  }) },
  stripes: { scale: [9, 9], make: () => canvas(64, 8, (g) => {
    g.fillStyle = '#5A8ED6'; g.fillRect(0, 0, 64, 8);
    g.fillStyle = '#FAF4E8'; g.fillRect(0, 0, 19, 8);
  }) },
};

function tile(a, seam) {
  return canvas(64, 64, (g) => {
    g.fillStyle = a; g.fillRect(0, 0, 64, 64);
    g.fillStyle = seam; g.fillRect(0, 0, 4, 64); g.fillRect(0, 0, 64, 4);
  });
}

/** UVs from each face's own two largest axes, in local units, so a pattern keeps its size on every part. */
function boxProject(geo, scale) {
  const pos = geo.attributes.position, nor = geo.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i += 3) {
    const n = [0, 1, 2].map(k => Math.abs(nor.getComponent(i, k) + nor.getComponent(i + 1, k) + nor.getComponent(i + 2, k)));
    const axis = n.indexOf(Math.max(...n));
    const [a, b] = [[1, 2], [0, 2], [0, 1]][axis];
    for (let k = 0; k < 3; k++) {
      uv[(i + k) * 2] = pos.getComponent(i + k, a) * scale[0];
      uv[(i + k) * 2 + 1] = pos.getComponent(i + k, b) * scale[1];
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

// ---------------------------------------------------------------- random (seeded: the room looks the same on every load)

export function createRng(seed) {
  let s = seed >>> 0;
  const random = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { random, uniform: (a, b) => a + (b - a) * random(), choice: list => list[Math.floor(random() * list.length)] };
}
export const RNG = createRng(7);

// ---------------------------------------------------------------- outlines (lists of [x, y], counter-clockwise)

export function arch(w, h, z0 = 0, n = 14) {
  const r = w / 2, pts = [[-r, z0], [r, z0]];
  for (let i = 0; i <= n; i++) pts.push([r * Math.cos(Math.PI * i / n), z0 + h - r + r * Math.sin(Math.PI * i / n)]);
  return pts;
}
export function roundedTop(w, h, rise, n = 14) {
  const r = w / 2, pts = [[-r, 0], [r, 0]];
  for (let i = 0; i <= n; i++) pts.push([r * Math.cos(Math.PI * i / n), h - rise + rise * Math.sin(Math.PI * i / n)]);
  return pts;
}
export const rect = (w, h, z0 = 0) => [[-w / 2, z0], [w / 2, z0], [w / 2, z0 + h], [-w / 2, z0 + h]];
export function star(r, points = 5, inner = 0.45) {
  return Array.from({ length: points * 2 }, (_, i) => {
    const k = i % 2 === 0 ? r : r * inner, a = Math.PI / 2 + Math.PI * i / points;
    return [k * Math.cos(a), k * Math.sin(a)];
  });
}
export const ellipse = (rx, ry, cx = 0, cy = 0, n = 20) =>
  Array.from({ length: n }, (_, i) => [cx + rx * Math.cos(2 * Math.PI * i / n), cy + ry * Math.sin(2 * Math.PI * i / n)]);
const TAIL = [[-0.03, 0], [0.03, 0], [0.05, 0.12], [0.2, 0.2], [0.12, 0.27], [0, 0.2], [-0.12, 0.27], [-0.2, 0.2], [-0.05, 0.12]];
export const tailOutline = width => TAIL.map(([x, y]) => [x * width / 0.4, y * width / 0.4]);

/** Counter-clockwise polygon grown outward by d (mitred corners). */
export function offsetPolygon(pts, d) {
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i + n - 1) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
    const d1 = unit2(p1[0] - p0[0], p1[1] - p0[1]), d2 = unit2(p2[0] - p1[0], p2[1] - p1[1]);
    const n1 = [d1[1], -d1[0]], n2 = [d2[1], -d2[0]];
    const cross = d1[0] * d2[1] - d1[1] * d2[0];
    const a = [p1[0] + n1[0] * d, p1[1] + n1[1] * d];
    if (Math.abs(cross) < 1e-6) { out.push(a); continue; }
    const b = [p1[0] + n2[0] * d, p1[1] + n2[1] * d];
    const t = ((b[0] - a[0]) * d2[1] - (b[1] - a[1]) * d2[0]) / cross;
    out.push([a[0] + d1[0] * t, a[1] + d1[1] * t]);
  }
  return out;
}
function unit2(x, y) { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; }

// ---------------------------------------------------------------- geometry (pure: each returns a non-indexed BufferGeometry)

const STAND = new THREE.Matrix4().makeRotationX(Math.PI / 2);     // a shape drawn in XY now stands in XZ, its body toward -Y
const creased = geo => toCreasedNormals(geo, SMOOTH_ANGLE);

export function gBox(sx, sy, sz) {
  return new THREE.BoxGeometry(sx, sy, sz).translate(0, 0, sz / 2).toNonIndexed();
}

/** Box with rounded edges: the outer third of every face bends round a corner of radius r. */
export function gSoftBox(sx, sy, sz, r) {
  r = Math.min(r, 0.45 * Math.min(sx, sy, sz));
  const geo = new THREE.BoxGeometry(2, 2, 2, 6, 6, 6);
  const pos = geo.attributes.position, nor = geo.attributes.normal;
  const half = [sx / 2, sy / 2, sz / 2], dir = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const u = [pos.getX(i), pos.getY(i), pos.getZ(i)];
    const q = u.map(v => Math.sign(v) * Math.max(0, (Math.abs(v) - 1 / 3) * 1.5));
    dir.set(q[0], q[1], q[2]).normalize();
    const p = u.map((v, k) => Math.sign(v) * (half[k] - r) * Math.min(1, Math.abs(v) * 3) + dir.getComponent(k) * r);
    pos.setXYZ(i, p[0], p[1], p[2] + sz / 2);
    nor.setXYZ(i, dir.x, dir.y, dir.z);
  }
  return geo.toNonIndexed();
}

/** profile: [[radius, z], ...] bottom to top; radius 0 closes an end. */
export function gLathe(profile, segs = 20) {
  const geo = new THREE.LatheGeometry(profile.map(([r, z]) => new THREE.Vector2(Math.max(r, 1e-5), z)), segs);
  return creased(geo.applyMatrix4(STAND));
}
export const gCyl = (r, h, r2 = r, segs = 20) => gLathe([[0, 0], [r, 0], [r2, h], [0, h]], segs);

export function gBall(r, scale = [1, 1, 1], detail = 2) {
  const geo = new THREE.SphereGeometry(r, 8 + detail * 4, 6 + detail * 3).applyMatrix4(STAND).scale(scale[0], scale[1], scale[2]);
  return creased(geo);
}

function shapeOf(pts) { return new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y))); }
function extrude(shape, h) { return creased(new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 1 })); }

/** Polygon in XY, extruded up by h. */
export const gPrism = (pts, h) => extrude(shapeOf(pts), h);
/** Upright cut-out: back on the XZ plane, body toward -Y. */
export const gSlab = (outline, th) => gPrism(outline, th).applyMatrix4(STAND);
/** Upright ring between two outlines. */
export function gFrame(outer, inner, th) {
  const shape = shapeOf(outer);
  shape.holes.push(new THREE.Path(inner.map(([x, y]) => new THREE.Vector2(x, y))));
  return extrude(shape, th).applyMatrix4(STAND);
}
/** Wall piece along X; the x0 and x1 ends have their own bottom and top heights. */
export function gWall(x0, x1, y0, y1, zl0, zl1, zr0, zr1) {
  return gSlab([[x0, zl0], [x1, zr0], [x1, zr1], [x0, zl1]], y1 - y0).translate(0, y1, 0);
}
/** Torus, or an arc of one, standing in the XZ plane. */
export function gRing(big, small, a0 = 0, a1 = 2 * Math.PI) {
  return new THREE.TorusGeometry(big, small, 8, 14, a1 - a0).rotateZ(a0).applyMatrix4(STAND).toNonIndexed();
}

export const tiltX = a => new THREE.Matrix4().makeRotationX(a);
export const tiltY = a => new THREE.Matrix4().makeRotationY(a);
export const spin = a => new THREE.Matrix4().makeRotationZ(a);
export const move = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);
const UPRIGHT = tiltX(Math.PI / 2);     // a lying shape (axis +Z) now points at -Y

/** Frame on the inner face of wall a->b (floor edge, counter-clockwise): origin mid-wall, +Y out of the room, -X end at b. */
export function wallFrame(a, b) {
  const d = unit2(b[0] - a[0], b[1] - a[1]);
  const out = [d[1], -d[0]], x = [out[1], -out[0]];
  return move((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0).multiply(spin(Math.atan2(x[1], x[0])));
}

// ---------------------------------------------------------------- the set: collects parts, hands back one mesh per group and look

/**
 * createSet() owns every part until build(): parts are added through Zones, grouped by zone name, then merged so a
 * zone costs a handful of draw calls. Each part carries its own id (the outline pass draws a line where ids change).
 */
export function createSet() {
  const piles = new Map();          // "group|look" -> geometries
  const lamps = [];                 // where warm lights go, in room coordinates
  let nextId = 1;

  const newId = () => (nextId++ % 251 + 1) / 255;

  function add(group, mat, geo, matrix, pid = newId()) {
    const look = PATTERNS[mat] ? mat : GLOW.has(mat) ? 'glow' : 'toon';
    if (!PATTERNS[mat] && !COLORS[mat]) throw new Error(`unknown material: ${mat}`);
    geo.deleteAttribute('uv');
    if (PATTERNS[mat]) boxProject(geo, PATTERNS[mat].scale);
    fill(geo, 'pid', 1, [pid]);
    geo.applyMatrix4(matrix);
    if (!PATTERNS[mat]) fill(geo, 'color', 3, new THREE.Color(COLORS[mat]).toArray());
    const key = group + '|' + look;
    if (!piles.has(key)) piles.set(key, []);
    piles.get(key).push(geo);
  }

  /** group name -> THREE.Group of merged meshes; `materials` maps a look to its material. */
  function build(materials) {
    const groups = new Map();
    for (const [key, geos] of piles) {
      const [group, look] = key.split('|');
      const mesh = new THREE.Mesh(mergeGeometries(geos), materials(look));
      mesh.castShadow = mesh.receiveShadow = look !== 'glow';
      if (!groups.has(group)) { const g = new THREE.Group(); g.name = group; groups.set(group, g); }
      groups.get(group).add(mesh);
      for (const g of geos) g.dispose();
    }
    piles.clear();
    return groups;
  }

  return { add, build, lamps, zone: name => new Zone({ add, lamps, newId }, name) };
}

function fill(geo, name, size, value) {
  const n = geo.attributes.position.count, data = new Float32Array(n * size);
  for (let i = 0; i < n; i++) data.set(value, i * size);
  geo.setAttribute(name, new THREE.BufferAttribute(data, size));
}

export function patternTextures() {
  const rng = createRng(11);
  return Object.fromEntries(Object.entries(PATTERNS).map(([name, p]) => [name, p.make(rng)]));
}

/** Places parts in a local frame (+Y = toward the wall behind, -Y = front) inside one named group. */
export class Zone {
  constructor(set, name, frame = new THREE.Matrix4(), pid = undefined) { this.set = set; this.name = name; this.frame = frame; this.pid = pid; }

  at(loc = [0, 0, 0], rot = 0) { return this.in(move(...loc).multiply(spin(rot))); }
  in(matrix) { return new Zone(this.set, this.name, this.frame.clone().multiply(matrix), this.pid); }
  /** Everything placed through the returned zone counts as one part: no outlines between its pieces. */
  fused() { return new Zone(this.set, this.name, this.frame, this.pid ?? this.set.newId()); }
  world(loc) { return new THREE.Vector3(...loc).applyMatrix4(this.frame); }

  put(geo, mat, loc = [0, 0, 0], rot = 0, tilt = null) {
    const m = this.frame.clone().multiply(move(...loc)).multiply(spin(rot));
    this.set.add(this.name, mat, geo, tilt ? m.multiply(tilt) : m, this.pid);
  }
  box(size, loc, mat, { bevel = 0.012, soft = false, rot = 0, tilt = null } = {}) {
    this.put(soft ? gSoftBox(...size, bevel) : gBox(...size), mat, loc, rot, tilt);
  }
  cyl(r, h, loc, mat, { r2 = r, segs = 20, tilt = null } = {}) { this.put(gCyl(r, h, r2, segs), mat, loc, 0, tilt); }
  lathe(profile, loc, mat, { segs = 20, tilt = null } = {}) { this.put(gLathe(profile, segs), mat, loc, 0, tilt); }
  ball(r, loc, mat, scale = [1, 1, 1], { tilt = null, detail = 2 } = {}) { this.put(gBall(r, scale, detail), mat, loc, 0, tilt); }
  slab(outline, th, loc, mat, rot = 0) { this.put(gSlab(outline, th), mat, loc, rot); }
  plate(outline, th, loc, mat, rot = 0) { this.put(gPrism(outline, th), mat, loc, rot); }
  disc(r, th, loc, mat, segs = 20) { this.put(gCyl(r, th, r, segs), mat, loc, 0, UPRIGHT); }
  ring(big, small, loc, mat, a0 = 0, a1 = 2 * Math.PI, rot = 0, tilt = null) { this.put(gRing(big, small, a0, a1), mat, loc, rot, tilt); }
}
