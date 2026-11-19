// The land drawn round the house: chunks from world.js built near where the view is, dropped when it moves away.
import * as THREE from 'three';
import { createSet } from './kit.js';
import { drawThing } from './outdoor.js';
import { inkless } from './stage.js';
import { CHUNK, chunkKey, chunkOf } from './world.js';

/** All the ground is one part to the outline pass, so no ink line runs along the chunk borders. */
const GROUND_ID = 253 / 255;
const GROUND_COLORS = { lawn: '#A9D27A', grass: '#97C569', meadow: '#8ABB5F', dirt: '#CDB088' };
const SKY = { zenith: '#86BDEB', horizon: '#E4F0F4' };
/** Only her eyes see it: the stage's inside layer. */
export const SKY_LAYER = 1;

/** One chunk's ground: a grid one unit apart, its normals from the height itself so neighbouring chunks meet smoothly. */
function groundGeometry(world, cx, cy) {
  const n = CHUNK, side = n + 1, x0 = cx * n, y0 = cy * n, e = 0.25;
  const position = new Float32Array(side * side * 3), normal = new Float32Array(side * side * 3), color = new Float32Array(side * side * 3);
  const tint = new THREE.Color(), colors = Object.fromEntries(Object.entries(GROUND_COLORS).map(([k, v]) => [k, new THREE.Color(v)]));
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const x = x0 + i, y = y0 + j, k = (j * side + i) * 3;
      position.set([x, y, world.height(x, y)], k);
      const nx = world.height(x - e, y) - world.height(x + e, y), ny = world.height(x, y - e) - world.height(x, y + e);
      const len = Math.hypot(nx, ny, 2 * e);
      normal.set([nx / len, ny / len, 2 * e / len], k);
      // A faint, fixed unevenness, so the grass is not one flat colour.
      const wobble = 0.97 + 0.06 * (((Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0) % 100) / 100;
      tint.copy(colors[world.ground(x, y)]).multiplyScalar(wobble).toArray(color, k);
    }
  }
  const index = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * side + i, b = a + 1, c = a + side + 1, d = a + side;
    index.push(a, b, c, a, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
  geo.setAttribute('pid', new THREE.BufferAttribute(new Float32Array(side * side).fill(GROUND_ID), 1));
  geo.setIndex(index);
  return geo;
}

/** A dome of sky with toon clouds, unlit and outside the fog; it rides along with her eyes. */
function createSky() {
  const look = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { zenith: { value: new THREE.Color(SKY.zenith) }, horizon: { value: new THREE.Color(SKY.horizon) }, cloud: { value: new THREE.Color('#FFFFFF') }, stars: { value: 0 }, cover: { value: 0 } },
    vertexShader: 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform vec3 zenith, horizon, cloud;
      uniform float stars, cover;
      varying vec3 vDir;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
      }
      float clouds(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * noise(p); p *= 2.1; a *= 0.5; } return s; }
      void main() {
        vec3 d = normalize(vDir);
        vec3 sky = mix(horizon, zenith, smoothstep(0.0, 0.55, d.z));
        // Clouds on a flat ceiling seen in perspective, with a hard edge like the rest of the toon look.
        vec2 p = d.xy / (d.z + 0.12) * 1.4;
        float c = smoothstep(0.58 - cover * 0.3, 0.64 - cover * 0.3, clouds(p)) * smoothstep(0.02, 0.18, d.z);
        // At night a few hard little stars, only where there is no cloud.
        float star = step(0.9975, hash(floor(p * 40.0))) * smoothstep(0.15, 0.45, d.z) * stars * (1.0 - c);
        gl_FragColor = vec4(mix(mix(sky, cloud, c * 0.92), vec3(1.0, 0.97, 0.86), star), 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(450, 32, 16), look);
  sky.layers.set(SKY_LAYER);
  sky.frustumCulled = false;
  // The outline pass sees nothing here: no ink along the clouds.
  sky.userData.surface = inkless(THREE.BackSide);
  return sky;
}

/**
 * createLand({ world, materials, parent, changed, fault }) owns the chunks on show. `follow(x, y, reach)` asks for the
 * land within `reach` of a point and builds it nearest first, one chunk a frame, calling `changed()` after each;
 * `show(world, changes)` swaps in another world or other chunk changes, rebuilding at once only the chunks on show that
 * differ; `sky` goes into the scene. A kind of thing this page cannot draw is reported once through `fault`.
 */
export function createLand({ world, materials, parent, changed, fault }) {
  const shown = new Map(), unknown = new Set();
  let changes = {};
  let queue = [], frame = 0;
  const sky = createSky();
  parent.add(sky);

  function build(cx, cy) {
    const group = new THREE.Group();
    group.name = 'land';
    const ground = new THREE.Mesh(groundGeometry(world, cx, cy), materials('toon'));
    ground.receiveShadow = true;
    group.add(ground);
    const set = createSet(), zone = set.zone('land');
    for (const thing of world.chunk(cx, cy, changes[chunkKey(cx, cy)]).objects) {
      drawThing(zone, thing, (kind) => {
        if (unknown.has(kind)) return;
        unknown.add(kind);
        fault(`小屋外面有这一版页面不认识的东西（${kind}），先空着。`);
      });
    }
    const things = set.build(materials).get('land');
    if (things) group.add(things);
    return group;
  }
  function drop(key) {
    const group = shown.get(key);
    group.traverse(o => o.geometry?.dispose());
    parent.remove(group);
    shown.delete(key);
  }
  function buildNext() {
    const next = queue.shift();
    if (!next || shown.has(next.key)) return;
    const group = build(next.cx, next.cy);
    shown.set(next.key, group);
    parent.add(group);
    changed();
  }
  function work() {
    frame = 0;
    buildNext();
    if (queue.length) frame = requestAnimationFrame(work);
  }

  function rebuild(key) {
    const [cx, cy] = key.split(',').map(Number);
    drop(key);
    const group = build(cx, cy);
    shown.set(key, group);
    parent.add(group);
  }

  return {
    sky,
    /** The sky for a time of day and its weather: { sky: [zenith, horizon], cloud, stars, cover } from state.js. */
    light(values) {
      const u = sky.material.uniforms;
      u.zenith.value.set(values.sky[0]); u.horizon.value.set(values.sky[1]); u.cloud.value.set(values.cloud); u.stars.value = values.stars; u.cover.value = values.cover ?? 0;
    },
    show(nextWorld, nextChanges) {
      const before = changes, fresh = nextWorld !== world;
      world = nextWorld; changes = nextChanges;
      const differs = key => fresh || JSON.stringify(before[key]) !== JSON.stringify(changes[key]);
      const stale = [...shown.keys()].filter(differs);
      for (const key of stale) rebuild(key);
      if (stale.length) changed();
    },
    /** `now`: build what is missing right away (the first frame should not show the house on nothing). */
    follow(x, y, reach, now = false) {
      const [cx0, cy0] = chunkOf(x - reach, y - reach), [cx1, cy1] = chunkOf(x + reach, y + reach);
      const want = [];
      for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
        const key = chunkKey(cx, cy);
        if (!shown.has(key)) want.push({ key, cx, cy, far: Math.hypot((cx + 0.5) * CHUNK - x, (cy + 0.5) * CHUNK - y) });
      }
      // A little past what is asked for stays, so a small pan back and forth does not rebuild anything.
      for (const key of [...shown.keys()]) {
        const [cx, cy] = key.split(',').map(Number);
        if (cx < cx0 - 1 || cx > cx1 + 1 || cy < cy0 - 1 || cy > cy1 + 1) drop(key);
      }
      queue = want.sort((a, b) => a.far - b.far);
      if (now) { while (queue.length) buildNext(); return; }
      if (queue.length && !frame) frame = requestAnimationFrame(work);
    },
  };
}
