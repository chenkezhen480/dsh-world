// What she does in the room: one fixed place while working or resting, a round of little pastimes while idle; or, while
// she lives here, going where dsh-world says she is and staying there.

const RUN = { clip: ['run'], speed: 1.45 };       // sideways: the side-view run, mirrored when she heads right
const STEP = { clip: ['step'], speed: 0.8 };      // toward or away from the viewer: the front-view walk
const STAY_MS = 10000;                            // one play of a clip
const HOP_MS = 380;

/**
 * createRoutine(sprite, plan, things, redraw) owns where she is, what she is doing and where the movable things are.
 *   plan.places    { work, rest }: { at, clips }     she is put there at once
 *   plan.lane      points on the open floor she walks along, in order; plan.start is the stop she appears at
 *   plan.pastimes  idle: walk the lane to `stop`, step over to `at`, then play `clips`. Optional:
 *                    seat: [x, y, z]   hop onto a seat from `at`, and back off it afterwards
 *                    carry: name       first fetch that thing, set it down at `at`, stand on it; take it home afterwards
 *   plan.things    name -> { home: [x, y, z], stand: [x, y], stop, top }   where it lives, where she stands to lift it,
 *                                                                           the lane stop nearest to it, its height
 *   plan.live      { places, route } from places.js, for live()
 *   things         name -> the object in the scene
 * `go(where)` takes 'work' | 'rest' | 'idle' | 'away'; asking for the mode she is already in changes nothing.
 * `live(place, busy)` is for while she lives here: the first call puts her at that place, a later one walks her there
 * (off her seat, along the paths, up the next seat); `busy` plays the place's busy clips, while she is in a turn.
 */
export function createRoutine(sprite, plan, things, redraw) {
  let mode = 'away', stop = 0, pastime = null, held = null, timer = 0, frame = 0;
  let home = null, busy = false, walking = false;     // live: the place she is at (or heading for), whether she is in a turn
  const at = sprite.object.position;

  function halt() {
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    held = null;
    sprite.mirror(false);
    for (const [name, thing] of Object.entries(plan.things)) things[name].position.set(...thing.home);
  }
  /** A thing in her arms rides in front of her: clear of her picture, and low enough to leave her face showing. */
  function carryAlong() { if (held) things[held].position.set(at.x, at.y - 0.18, at.z + 0.04); }

  /** Walks through the points in turn (each [x, y] on the floor, or [x, y, z]), picking the clip by the way she is heading, then calls done. */
  function walk(points, done) {
    const route = points.filter(p => Math.hypot(p[0] - at.x, p[1] - at.y) > 0.01 || p !== points[0]);
    let last = performance.now(), gait = null;
    const tick = (now) => {
      // A hidden tab pauses frames: never leap on return. The first frame's time can be earlier than `last`: never step back.
      const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
      last = now;
      if (route.length) {
        const [x, y] = route[0], dx = x - at.x, dy = y - at.y, gap = Math.hypot(dx, dy);
        const here = gap < 1e-6;                             // a point she already stands on: no step to take, no heading to pick
        const next = Math.abs(dx) > Math.abs(dy) * 0.8 ? RUN : STEP;
        if (!here && (next !== gait || next === RUN)) { gait = next; sprite.play(gait.clip); sprite.mirror(gait === RUN && dx > 0); }
        const z = route[0][2] ?? 0, k = here ? 1 : Math.min(1, gait.speed * dt / gap);   // up the bed platform, down to the lawn: her feet follow the height on the way
        if (k === 1) { at.set(x, y, z); route.shift(); } else { at.x += dx * k; at.y += dy * k; at.z += (z - at.z) * k; }
        carryAlong();
        redraw();
      }
      if (route.length) frame = requestAnimationFrame(tick); else { sprite.mirror(false); done(); }
    };
    frame = requestAnimationFrame(tick);
  }

  /** A little jump to a point, for getting onto and off seats. */
  function hop(to, done) {
    const from = at.clone(), started = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - started) / HOP_MS);
      at.set(from.x + (to[0] - from.x) * t, from.y + (to[1] - from.y) * t, from.z + (to[2] - from.z) * t + 0.25 * Math.sin(Math.PI * t));
      redraw();
      if (t < 1) frame = requestAnimationFrame(tick); else done();
    };
    frame = requestAnimationFrame(tick);
  }

  const lane = (from, to) => { const out = [], step = to >= from ? 1 : -1; for (let i = from; i !== to + step; i += step) out.push(plan.lane[i]); return out; };
  /** Runs the steps one after another; each takes the function that starts the next. */
  const inTurn = (steps) => { const next = () => { const step = steps.shift(); if (step) step(next); }; next(); };
  const stay = (clips) => (next) => { sprite.play(clips); redraw(); timer = setTimeout(next, STAY_MS * clips.length); };

  function nextPastime() {
    const choices = plan.pastimes.length > 1 ? plan.pastimes.filter(p => p !== pastime) : plan.pastimes;
    const p = choices[Math.floor(Math.random() * choices.length)];
    const thing = p.carry && plan.things[p.carry], steps = [];
    let from = stop;
    if (thing) {
      steps.push(next => walk([...lane(from, thing.stop), thing.stand], next), (next) => { held = p.carry; carryAlong(); next(); });
      from = thing.stop;
    }
    steps.push(next => walk([...lane(from, p.stop), p.at], next));
    if (thing) steps.push((next) => { held = null; things[p.carry].position.set(p.at[0], p.at[1], 0); next(); }, next => hop([p.at[0], p.at[1], thing.top], next));
    if (p.seat) steps.push(next => hop(p.seat, next));
    steps.push(stay(p.clips));
    if (p.seat || thing) steps.push(next => hop([p.at[0], p.at[1], 0], next));
    if (thing) {
      steps.push((next) => { held = p.carry; carryAlong(); next(); }, next => walk([...lane(p.stop, thing.stop), thing.stand], next),
        (next) => { held = null; things[p.carry].position.set(...thing.home); next(); });
    }
    steps.push(nextPastime);
    pastime = p; stop = thing ? thing.stop : p.stop;
    inTurn(steps);
  }

  /** At a place she lives in: up its seat, then its clips. */
  function settle(place) {
    const steps = place.seat ? [next => hop(place.seat, next)] : [];
    steps.push(() => { walking = false; sprite.play(clipsAt(place)); redraw(); });
    inTurn(steps);
  }
  const clipsAt = place => (busy && place.clips.busy) || place.clips.idle;

  return {
    go(where) {
      if (where === mode) return;
      halt();
      mode = where; home = null; walking = false;
      const place = plan.places[where];
      if (place) { at.set(...place.at); sprite.play(place.clips); }
      else if (where === 'idle') { stop = plan.start; pastime = null; at.set(plan.lane[stop][0], plan.lane[stop][1], 0); nextPastime(); }
      else sprite.play(null);
      redraw();
    },
    live(id, working) {
      const { places, route } = plan.live, place = places[id];
      if (!place) return false;
      const turned = working !== busy;
      busy = working;
      if (mode === 'live' && id === home) {
        if (turned && !walking) sprite.play(clipsAt(place));
        return true;
      }
      const from = mode === 'live' ? home : null;
      halt();
      mode = 'live'; home = id; walking = true;
      if (!from) { at.set(...place.seat ?? place.at); walking = false; sprite.play(clipsAt(place)); redraw(); return true; }   // already there when the page opens
      const off = places[from].seat ? [next => hop(places[from].at, next)] : [];
      inTurn([...off, next => walk(route(from, id), next), () => settle(place)]);
      return true;
    },
  };
}
