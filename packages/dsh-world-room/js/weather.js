// Rain over the land round the view: short streaks falling past wherever you or she are looking, never inside the house.
import * as THREE from 'three';
import { inkless } from './stage.js';

const DROPS = 1400;
const FALL = 9;                   // units a second
const STREAK = [0.05, 0.03, 0.38];  // a drop's length, leaning a little with the wind
const TOP = 7, BOTTOM = -1.5;
/** However far the view reaches, rain is only drawn this close to its middle. */
const NEAR = 16;

/** Whether (x, y) is inside the polygon. */
function inside([x, y], polygon) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/**
 * createRain(parent, house, ceiling) owns the falling drops; `house` is the floor's outline, kept dry, and
 * `ceiling(x, y)` how high a drop may start there (your view: low in front of the house, or the rain between you and
 * the room looks as if it fell inside). `set(on)` starts or stops it, `step(seconds, view)` moves the drops along
 * and keeps them round the view ({ x, y, reach }); `falling` says whether it needs another frame.
 */
export function createRain(parent, house, ceiling = () => Infinity) {
  const position = new Float32Array(DROPS * 6), drops = new Float32Array(DROPS * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: '#D7E1EE', transparent: true, opacity: 0.6, depthWrite: false }));
  lines.frustumCulled = false;
  lines.visible = false;
  lines.userData.surface = inkless();
  parent.add(lines);
  let on = false, middle = [0, 0], radius = NEAR;

  /** A new drop somewhere round the middle where rain may fall; height anywhere for a first fill, else at its top. */
  function spawn(i, anywhere) {
    let x, y, top;
    do {
      x = middle[0] + (Math.random() * 2 - 1) * radius; y = middle[1] + (Math.random() * 2 - 1) * radius;
      top = Math.min(TOP, ceiling(x, y));
    } while (top < BOTTOM + 1 || inside([x, y], house));
    drops.set([x, y, anywhere ? BOTTOM + Math.random() * (top - BOTTOM) : top], i * 3);
  }
  function fill() { for (let i = 0; i < DROPS; i++) spawn(i, true); }

  return {
    set(next) {
      if (next === on) return;
      on = next;
      lines.visible = on;
      if (on) fill();
    },
    step(seconds, view) {
      if (!on) return;
      const far = Math.hypot(view.x - middle[0], view.y - middle[1]) > radius / 2;
      middle = [view.x, view.y]; radius = Math.min(NEAR, view.reach);
      if (far) fill();                                // the view jumped: rain round it at once, not drop by drop
      for (let i = 0; i < DROPS; i++) {
        const k = i * 3;
        drops[k + 2] -= FALL * Math.min(seconds, 0.1);
        if (drops[k + 2] < BOTTOM) spawn(i, false);
        const [x, y, z] = [drops[k], drops[k + 1], drops[k + 2]];
        position.set([x, y, z, x + STREAK[0], y + STREAK[1], z + STREAK[2]], i * 6);
      }
      geometry.attributes.position.needsUpdate = true;
    },
    get falling() { return on; },
  };
}
