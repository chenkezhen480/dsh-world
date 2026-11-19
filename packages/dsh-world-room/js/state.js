// What the cottage shows for one console snapshot. Pure, so it can be tested without a browser.
import { chunkKey, chunkOf, yardThing } from './world.js';

/** Her home's status -> where she is in the room. */
const SPOT_BY_STATUS = { running: 'work', idle: 'idle', cold: 'rest' };

/**
 * her: 'work' | 'idle' | 'rest', or 'away' while her world is stopped (or its life line never started).
 * alarm: the next alarm ({ at, note }) or null. mirrorOpen: the teleport mirror unlocks while her computer module runs.
 * life: her cottage as dsh-world keeps it while she lives here (her seed, where she is, the pot, the laundry, the garden
 * bed, her changes to the yard), or null while she does not: then the room plays out her day by itself.
 */
export function roomState(snapshot) {
  const life = snapshot?.running === true ? snapshot.life : null;
  return {
    her: life ? SPOT_BY_STATUS[life.status] ?? 'idle' : 'away',
    alarm: life?.alarm ? { at: life.alarm.at, note: life.alarm.note ?? '' } : null,
    mirrorOpen: snapshot?.modules?.computer?.running === true,
    life: life && snapshot.room?.life ? snapshot.room.life : null,
  };
}

/** Local HH:MM of an ISO time in the world's time zone; the raw text when it cannot be read. */
export function clockText(iso, timeZone) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return String(iso ?? '');
  try { return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(at); } catch { return at.toISOString().slice(11, 16); }
}

/**
 * Her changes to the yard, and what she has going on out there (the garden bed as it is, laundry on the line), as the
 * chunk changes the land applies. Her stored changes are copied, never edited.
 */
export function yardChanges(life) {
  if (!life) return {};
  const changes = Object.fromEntries(Object.entries(life.changes ?? {}).map(([key, change]) => [key, { removed: [...change.removed ?? []], added: [...change.added ?? []] }]));
  const put = (thing, replacing) => {
    const change = changes[chunkKey(...chunkOf(thing.at[0], thing.at[1]))] ??= { removed: [], added: [] };
    if (replacing) change.removed.push(replacing);
    change.added.push(thing);
  };
  const bed = yardThing('bed'), line = yardThing('clothesline');
  put({ ...bed, id: 'live:bed', variant: life.crop?.stage ?? 'empty', thirsty: life.crop?.thirsty === true }, bed.id);
  if (life.laundry) put({ ...line, id: 'live:laundry', kind: 'laundry', variant: life.laundry.dry ? 'dry' : 'wet' });
  return changes;
}

/** How the light looks at four moments of the day; the hours between blend from one to the next. */
const LIGHTS = {
  night: { fill: ['#8C9BD6', '#4A4F72', 1.25], key: ['#A9BDFF', 0.35], beam: ['#A9BDFF', 0.4], lamps: 1.8, sky: ['#1D2A55', '#46578E'], cloud: '#56679A', stars: 1, her: '#B4BCDC' },
  dawn: { fill: ['#FFE4EC', '#EAD9D0', 2.0], key: ['#FFD0B8', 0.7], beam: ['#FFC0A0', 1.6], lamps: 0.8, sky: ['#9DB4E6', '#F8D6CF'], cloud: '#FFF1EC', stars: 0, her: '#F4EAEE' },
  day: { fill: ['#FFFFFF', '#F1E6D8', 2.55], key: ['#FFF4E4', 1.1], beam: ['#FFD79A', 3], lamps: 0.5, sky: ['#86BDEB', '#E4F0F4'], cloud: '#FFFFFF', stars: 0, her: '#FFFFFF' },
  dusk: { fill: ['#FFD9C2', '#E8C9B0', 1.9], key: ['#FFB07A', 0.8], beam: ['#FF9F5A', 2.0], lamps: 1.0, sky: ['#7F8FC8', '#F6C49B'], cloud: '#FFE0C8', stars: 0, her: '#FCE8DA' },
};
const DAY = [[0, 'night'], [5, 'night'], [6.5, 'dawn'], [8, 'day'], [16.5, 'day'], [18, 'dusk'], [19.5, 'night'], [24, 'night']];

const mixColor = (a, b, t) => '#' + [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, '0')).join('').toUpperCase();
const mix = (a, b, t) => Array.isArray(a) ? a.map((v, i) => mix(v, b[i], t))
  : typeof a === 'number' ? a + (b - a) * t
    : typeof a === 'string' ? mixColor(a, b, t)
      : Object.fromEntries(Object.keys(a).map(k => [k, mix(a[k], b[k], t)]));

/** The light at a local hour (0–24, fractions for minutes): a smooth blend of the moments either side. */
export function daylight(hour) {
  const h = ((hour % 24) + 24) % 24;
  const i = DAY.findIndex(([at], n) => h >= at && h < DAY[n + 1][0]);
  const [a, from] = DAY[i], [b, to] = DAY[i + 1], t = (h - a) / (b - a);
  return mix(LIGHTS[from], LIGHTS[to], t * t * (3 - 2 * t));
}

/** How grey each weather makes the day: 0 is the sun as it is, 1 a heavy sky. */
const OVERCAST = { sunny: 0, cloudy: 0.55, rain: 0.85 };
/** A colour drained toward its own grey and dimmed, by k (0–1). */
const greyed = (hex, k) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)), grey = 0.3 * r + 0.59 * g + 0.11 * b;
  return '#' + [r, g, b].map(v => Math.round((v + (grey - v) * k) * (1 - 0.18 * k)).toString(16).padStart(2, '0')).join('').toUpperCase();
};
/**
 * The light of an hour under the weather her partner set: clouds take the colour out of it and hide the sun and the
 * stars, whatever the hour, so a rainy night stays a night. cover is how much of the sky the clouds fill.
 */
export function weathered(light, kind) {
  const k = OVERCAST[kind] ?? 0;
  if (!k) return { ...light, cover: 0 };
  return {
    fill: [greyed(light.fill[0], k), greyed(light.fill[1], k), light.fill[2] * (1 - 0.25 * k)],
    key: [greyed(light.key[0], k), light.key[1] * (1 - 0.7 * k)],
    beam: [light.beam[0], light.beam[1] * (1 - 0.9 * k)],
    lamps: light.lamps,
    sky: [greyed(light.sky[0], k), greyed(light.sky[1], k)],
    cloud: greyed(light.cloud, k * 0.8),
    stars: light.stars * (1 - k),
    her: greyed(light.her, k * 0.3),
    cover: k,
  };
}

/** The local hour of a moment in a time zone, with minutes as a fraction; UTC when the zone cannot be read. */
export function localHour(time, timeZone) {
  let parts;
  try { parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(time)); } catch { parts = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(time)); }
  const part = type => Number(parts.find(p => p.type === type).value);
  return part('hour') + part('minute') / 60;
}
