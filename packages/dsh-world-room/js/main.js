// Page entry: builds the cottage once and the land round it as the view moves, then redraws only when something changes.
import { Box3, Raycaster, Vector2, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createSet } from './kit.js';
import { createLand } from './land.js';
import { PLACES, route } from './places.js';
import { ANCHORS, FOOTPRINT, HER_PLAN, buildRoom, sunThroughWindow } from './room.js';
import { createRoutine } from './routine.js';
import { createSprite } from './sprite.js';
import { INSIDE_LAYER, addLights, createMaterials, createStage } from './stage.js';
import { clockText, daylight, localHour, roomState, weathered, yardChanges } from './state.js';
import { createRain } from './weather.js';
import { GENERATOR, createWorld, headroom } from './world.js';

const SNAPSHOT_URL = '../console/snapshot', POLL_MS = 10000;
/** The land a room stands in while she does not live there; once she does, her cottage has a seed of its own. */
const SHOWN_SEED = 20261118;
/** In your view rain in front of the house may fall from this far above what is allowed to stand there. */
const GROUND_RAIN = 0.4;
/** Her pictures; see her/NOTICE.md for where the clips come from. */
const HER_ART = {
  still: { url: './her/still.png', feet: 0, tall: 1 },
  clips: Object.fromEntries(['idle', 'look', 'hum', 'cube', 'cat', 'stretch', 'step', 'run', 'eat', 'wipe', 'noodle', 'read', 'mirror', 'code', 'nap'].map(name => [name, `./her/${name}.webm`])),
  clipFrame: { feet: 0.086, tall: 0.75 },
  loops: { run: [1.75, 4.8] },
};
const params = new URLSearchParams(location.search);
/** ?eye=x,y,heading[,pitch[,floor]] (degrees; floor is what she stands on) shows what she would see from there, instead of your view. */
const eyeAt = params.get('eye')?.split(',').map(Number);

/** What went wrong, one line per source, so a fresh snapshot does not wipe out a drawing error. */
const faults = new Map();
function setFault(source, message) {
  if (message) faults.set(source, message); else faults.delete(source);
  document.getElementById('fault').textContent = [...faults.values()].join('\n');
}
const report = error => setFault('draw', `小屋没能画出来：${error?.message ?? error}`);
window.addEventListener('error', event => report(event.error ?? event.message));
window.addEventListener('unhandledrejection', event => report(event.reason));

const canvas = document.getElementById('room');
const stage = createStage(canvas);
const materials = createMaterials();
const set = createSet();
buildRoom(set);
const groups = set.build(materials);
for (const group of groups.values()) stage.world.add(group);
// The walls and ceiling your view leaves open are hers alone.
groups.get('enclosure').traverse(o => o.layers.set(INSIDE_LAYER));
const sprite = createSprite(HER_ART, { change: () => redraw(), fault: message => setFault('her', message) });
if (!eyeAt) stage.world.add(sprite.object);                  // she does not see herself
const light = addLights(stage.world, sunThroughWindow(), set.lamps);
const land = createLand({ world: createWorld({ seed: SHOWN_SEED }), materials, parent: stage.world, changed: () => redraw(), fault: message => setFault('land', message) });
const rain = createRain(stage.world, FOOTPRINT, eyeAt ? undefined : (x, y) => headroom(x, y) + GROUND_RAIN);
const pot = groups.get('thing_pot'), steam = groups.get('thing_steam');
pot.visible = steam.visible = false;

// ?pastime=N keeps her to one idle pastime, for looking at it on its own.
const only = HER_PLAN.pastimes[params.get('pastime') ?? -1];
const routine = createRoutine(sprite, { ...HER_PLAN, ...only ? { pastimes: [only] } : {}, live: { places: PLACES, route } }, { stool: groups.get('thing_stool') }, () => redraw());

const controls = new OrbitControls(stage.camera, canvas);
controls.target = stage.target;
controls.enablePan = true;
controls.screenSpacePanning = false;                         // panning walks over the ground, not up into the sky
controls.minZoom = 0.45; controls.maxZoom = 5;
controls.minPolarAngle = 0.75; controls.maxPolarAngle = 1.15;
controls.minAzimuthAngle = -0.45; controls.maxAzimuthAngle = 0.45;
controls.enabled = !eyeAt;
controls.update();

/** Glides the view to one group (a zone, or her), or back to the whole room when name is null. */
function createFocus() {
  const home = { target: stage.target.clone(), zoom: 1 };
  let current = null, timer = 0;
  function aim(name) {
    const group = name && groups.get(name);
    if (!group) return home;
    group.updateWorldMatrix(true, true);
    const box = new Box3().setFromObject(group), size = box.getSize(new Vector3());
    return { target: box.getCenter(new Vector3()), zoom: Math.min(controls.maxZoom, 6.5 / Math.max(size.x, size.y * 1.4, size.z, 1.2)) };
  }
  function to(name, glide = 450) {
    current = groups.has(name) ? name : null;
    const from = { target: controls.target.clone(), zoom: stage.camera.zoom }, goal = aim(current), started = performance.now();
    cancelAnimationFrame(timer);
    const step = (now) => {
      const t = glide ? Math.min(1, (now - started) / glide) : 1, k = t * t * (3 - 2 * t);
      const next = from.target.clone().lerp(goal.target, k);
      stage.camera.position.add(next.clone().sub(controls.target));
      controls.target.copy(next);
      stage.camera.zoom = from.zoom + (goal.zoom - from.zoom) * k;
      stage.camera.updateProjectionMatrix();
      controls.update();
      redraw();
      if (t < 1) timer = requestAnimationFrame(step);
    };
    timer = requestAnimationFrame(step);
  }
  /** Far enough from the house that the way back is worth a button. */
  const away = () => controls.target.distanceTo(home.target) > 6 || stage.camera.zoom < 0.8;
  return { to, away, get current() { return current; } };
}

/** A click (not a drag) on a zone's furniture looks closer at that zone; clicking anything else while close steps back. */
function watchClicks(focus) {
  const ray = new Raycaster(), down = new Vector2();
  canvas.addEventListener('pointerdown', (e) => down.set(e.clientX, e.clientY));
  canvas.addEventListener('pointerup', (e) => {
    if (down.distanceTo(new Vector2(e.clientX, e.clientY)) > 5) return;
    const box = canvas.getBoundingClientRect();
    ray.setFromCamera(new Vector2((e.clientX - box.left) / box.width * 2 - 1, 1 - (e.clientY - box.top) / box.height * 2), stage.camera);
    const hit = ray.intersectObjects([...groups.values()].filter(g => g.visible), true)[0];
    const name = hit?.object.parent.name;
    if (name?.startsWith('zone_') && name !== focus.current) focus.to(name);
    else if (focus.current) focus.to(null);
  });
}

/** In her eyes: dragging turns her head. */
function watchLooking([x, y, heading = 0, pitch = 0, floor = 0]) {
  let turn = heading * Math.PI / 180, tilt = pitch * Math.PI / 180, last = null;
  const look = () => { stage.lookFrom([x, y, floor], turn, tilt); redraw(); };
  canvas.addEventListener('pointerdown', (e) => { last = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointerup', () => { last = null; });
  canvas.addEventListener('pointermove', (e) => {
    if (!last) return;
    turn -= (e.clientX - last[0]) * 0.005;
    tilt = Math.max(-1.2, Math.min(1.2, tilt + (e.clientY - last[1]) * 0.005));
    last = [e.clientX, e.clientY];
    look();
  });
  look();
}

/**
 * The alarm bubble over the desk, the lock on the mirror, and her name over her head while she is out in the yard (where
 * the house can hide her): page elements pinned to points in the room.
 */
function createBubbles() {
  const her = sprite.object.position;
  const pins = [[document.getElementById('alarm'), () => ANCHORS.alarm], [document.getElementById('lock'), () => ANCHORS.mirror], [document.getElementById('where'), () => [her.x, her.y, her.z + 1.2]]];
  function place() {
    const box = canvas.getBoundingClientRect();
    for (const [el, at] of pins) {
      if (el.hidden) continue;
      const p = stage.world.localToWorld(new Vector3(...at())).project(stage.camera);
      el.style.transform = `translate(-50%, -100%) translate(${box.left + (p.x + 1) / 2 * box.width}px, ${box.top + (1 - p.y) / 2 * box.height}px)`;
    }
  }
  function show(state, timeZone, name) {
    pins[0][0].hidden = eyeAt || !state.alarm;
    if (state.alarm) pins[0][0].textContent = '⏰ ' + clockText(state.alarm.at, timeZone) + (state.alarm.note ? ' · ' + state.alarm.note.slice(0, 16) : '');
    pins[1][0].hidden = eyeAt || state.mirrorOpen;
    const out = state.life && PLACES[state.life.at]?.outside ? PLACES[state.life.at] : null;
    pins[2][0].hidden = eyeAt || !out;
    if (out) pins[2][0].textContent = `${name} · ${out.name}`;
  }
  return { place, show };
}
const bubbles = createBubbles();
const homeButton = document.getElementById('home');

/**
 * Her cottage as dsh-world keeps it, or null while she does not live here: her own land, her changes to the yard, the
 * pot, the laundry and the garden bed. A land made by rules this page does not know is reported and not drawn over.
 */
function createLife() {
  let seed = SHOWN_SEED, world = null;
  return {
    show(life) {
      const wanted = life?.seed ?? SHOWN_SEED;
      if (wanted !== seed || !world) {
        try {
          world = createWorld({ seed: wanted, version: life?.generator ?? GENERATOR });
          seed = wanted;
          setFault('seed', null);
        } catch {
          setFault('seed', `她的院子是第 ${life.generator} 版的规则长出来的，这一版小屋画不了，请更新小屋。`);
        }
      }
      if (world) land.show(world, yardChanges(life));
      pot.visible = Boolean(life?.pot);
      steam.visible = life?.pot?.ready === true;
    },
  };
}
const life = createLife();

/** ?hour=H shows that hour's light, for looking at the night without waiting for it. */
const fixedHour = params.has('hour') ? Number(params.get('hour')) : null;
/** ?weather=rain shows that weather while she does not live here (where it is otherwise always fine). */
const fixedWeather = params.get('weather');
/** The light of her world's time of day and the weather her partner set, inside and out. */
function showDaylight(timeZone, weather) {
  const values = weathered(daylight(fixedHour ?? localHour(Date.now(), timeZone)), weather);
  rain.set(weather === 'rain');
  light(values);
  land.light(values);
  sprite.tint(values.her);
  stage.hazeColor(values.sky[1]);
}

/** Nothing is drawn before the first snapshot has said whose land this is (or failed to). */
let ready = false, pending = 0, last = 0;
function draw(now) {
  pending = 0;
  if (!ready) return;
  const view = stage.viewpoint();
  rain.step(last ? (now - last) / 1000 : 0, view);
  last = rain.falling ? now : 0;                             // after a pause the rain does not jump
  land.follow(view.x, view.y, view.reach);
  land.sky.position.set(view.x, view.y, 0);                  // the sky rides along with her eyes
  if (!eyeAt) sprite.face(stage.camera);
  stage.render();
  bubbles.place();
  homeButton.hidden = Boolean(eyeAt) || !focus.away();
  if (rain.falling) redraw();                                // rain keeps the frames coming; otherwise only a change draws
}
const redraw = () => { pending ||= requestAnimationFrame(draw); };
controls.addEventListener('change', redraw);
function fit() { stage.resize(canvas.clientWidth, canvas.clientHeight, Math.min(window.devicePixelRatio, 2)); redraw(); }
new ResizeObserver(fit).observe(canvas);
/** Reads the console snapshot now and every POLL_MS; a failed read is shown and the room keeps its last state. */
async function follow() {
  try {
    const response = await fetch(SNAPSHOT_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const snapshot = await response.json(), state = roomState(snapshot);
    life.show(state.life);
    showDaylight(snapshot.timeZone, state.life?.weather?.kind ?? fixedWeather ?? 'sunny');
    if (!state.life || !routine.live(state.life.at, state.her === 'work')) routine.go(state.her);
    bubbles.show(state, snapshot.timeZone, snapshot.name && snapshot.name !== 'TA' ? snapshot.name : '她');
    setFault('snapshot', null);
  } catch (error) {
    setFault('snapshot', `读不到世界状态：${error?.message ?? error}`);
  }
  if (!ready) {
    ready = true;
    const start = stage.viewpoint();
    land.follow(start.x, start.y, start.reach, true);          // the house never shows standing on nothing
  }
  redraw();
}

const focus = createFocus();
if (eyeAt) watchLooking(eyeAt); else watchClicks(focus);
homeButton.addEventListener('click', () => focus.to(null));
fit();
follow();
setInterval(() => { if (!document.hidden) follow(); }, POLL_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) follow(); });
if (params.has('focus')) focus.to(params.get('focus'), 0);
