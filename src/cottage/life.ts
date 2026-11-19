import { ago, type ElsewhereNews } from '../elsewhere.ts';

/**
 * Her life in the cottage, as data: where she is, what is on the stove, on the line and in the garden bed, what she
 * changed in the yard, and the weather her partner set. Pure: every function takes the state and the time and returns
 * a new state, a text or facts.
 */

/** A thing standing in the land, as the room's world.js places them. */
export interface Thing { id: string; kind: string; at: number[]; rot?: number; scale?: number; variant?: string }
/** One chunk's changes, as world.js applies them over what grows there by itself. */
export interface ChunkChange { removed: string[]; added: Thing[] }
export interface Crop { name: string; sownAt: string; wateredUntil: string; /** hours it has grown while watered */ growth: number; countedAt: string }
/** Set by her partner from the console; it is fine until someone says otherwise. */
export const WEATHERS = { sunny: '晴', cloudy: '阴', rain: '雨' } as const;
export type Weather = keyof typeof WEATHERS;
/** Own keys only: "constructor" is in every object, but it is no weather and no place. */
export const isWeather = (text: unknown): text is Weather => typeof text === 'string' && Object.hasOwn(WEATHERS, text);
export interface CottageState {
  seed: number; generator: number;
  at: string; since: string;
  pot?: { dish: string; readyAt: string };
  /** dryAt is left out while it hangs in the rain: it only starts drying once the rain stops. */
  laundry?: { dryAt?: string };
  crop?: Crop;
  weather?: { kind: Weather; since: string };
  changes: Record<string, ChunkChange>;
}
/** What the room package says about its places (js/places.js) and its land (js/world.js). */
export interface Layout {
  PLACES: Record<string, { name: string; at: number[]; near: string; outside?: boolean; plot?: number[] }>;
  GENERATOR: number;
  chunkOf(x: number, y: number): [number, number];
  chunkKey(cx: number, cy: number): string;
}

export const COOK_MINUTES = 25;
export const DRY_HOURS = 3;
/** A watering keeps the crop growing this long; after it the crop is thirsty and stops growing. */
export const WATER_HOURS = 24;
/** Hours of watered growth until it is ripe: two well-kept days. */
export const RIPE_HOURS = 48;
const SPROUT_HOURS = 8;
/** A change of weather is news for this long; after that it is just the weather. */
const WEATHER_NEWS_HOURS = 3;
const SKY_WORDS: Record<Weather, string> = { sunny: '', cloudy: '，天阴着', rain: '，外面在下雨' };
const WEATHER_CHANGES: Record<Weather, string> = { sunny: '天晴了', cloudy: '天阴了', rain: '下雨了' };
const FLOWERS_PER_PLACE = 6;
const NAME_MAX = 12;
const MINUTE = 60_000, HOUR = 60 * MINUTE;

const iso = (time: number) => new Date(time).toISOString();
const at = (text: string) => Date.parse(text);
/** How long until a moment, in her words. */
export function inTime(milliseconds: number): string {
  const minutes = Math.max(1, Math.ceil(milliseconds / MINUTE));
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}`;
}

export function newCottage(seed: number, layout: Layout, now: number): CottageState {
  return { seed, generator: layout.GENERATOR, at: 'room', since: iso(now), changes: {} };
}

/** A stored cottage.json read back; anything that does not fit is refused, never patched over (the file stays as it was). */
export function parseCottage(raw: unknown, layout: Layout): CottageState {
  const value = raw as Partial<CottageState> | null;
  const time = (text: unknown) => typeof text === 'string' && !Number.isNaN(at(text));
  if (!value || typeof value !== 'object') throw new Error('不是一个对象');
  if (!Number.isSafeInteger(value.seed) || !Number.isSafeInteger(value.generator)) throw new Error('seed 和 generator 要是整数');
  if (typeof value.at !== 'string' || !Object.hasOwn(layout.PLACES, value.at) || !time(value.since)) throw new Error(`她在的地方不认识：${String(value.at)}`);
  if (value.pot && (typeof value.pot.dish !== 'string' || !time(value.pot.readyAt))) throw new Error('锅里的东西读不懂');
  if (value.laundry && value.laundry.dryAt !== undefined && !time(value.laundry.dryAt)) throw new Error('晾的衣服读不懂');
  if (value.weather && (!isWeather(value.weather.kind) || !time(value.weather.since))) throw new Error('天气读不懂');
  const crop = value.crop;
  if (crop && (typeof crop.name !== 'string' || !time(crop.sownAt) || !time(crop.wateredUntil) || !time(crop.countedAt) || typeof crop.growth !== 'number')) throw new Error('菜圃读不懂');
  if (!value.changes || typeof value.changes !== 'object') throw new Error('院子里的改动读不懂');
  return value as CottageState;
}

const raining = (state: CottageState) => state.weather?.kind === 'rain';

/**
 * The crop brought up to now: it grows only while it is watered, and rain waters it for as long as it falls (the
 * growth before the rain was counted when it started, see changeWeather).
 */
export function cropNow(crop: Crop, now: number, rain = false): Crop & { stage: 'sprout' | 'growing' | 'ripe'; thirsty: boolean } {
  const wateredUntil = rain ? Math.max(at(crop.wateredUntil), now) : at(crop.wateredUntil);
  const grown = Math.max(0, Math.min(now, wateredUntil) - at(crop.countedAt)) / HOUR;
  const growth = Math.min(RIPE_HOURS, crop.growth + grown);
  const stage = growth >= RIPE_HOURS ? 'ripe' : growth >= SPROUT_HOURS ? 'growing' : 'sprout';
  return { ...crop, growth, countedAt: iso(Math.max(now, at(crop.countedAt))), stage, thirsty: stage !== 'ripe' && now > wateredUntil };
}
/** The crop as it is kept: its growth counted up to now. */
function counted(crop: Crop, now: number, rain: boolean): Crop {
  const { stage: _stage, thirsty: _thirsty, ...kept } = cropNow(crop, now, rain);
  return kept;
}

/**
 * Her partner changes the weather. The crop's growth is counted up to now under the old weather; rain soaks laundry
 * left out, and when it stops it has watered the crop for another day and the laundry starts drying again.
 */
export function changeWeather(state: CottageState, kind: Weather, now: number): CottageState {
  const was = state.weather?.kind ?? 'sunny';
  if (kind === was) return state;
  const next: CottageState = { ...state, weather: { kind, since: iso(now) } };
  if (state.crop) next.crop = counted(state.crop, now, was === 'rain');
  if (kind === 'rain' && next.laundry) next.laundry = {};
  if (was === 'rain') {
    if (next.crop && next.crop.growth < RIPE_HOURS) next.crop = { ...next.crop, wateredUntil: iso(now + WATER_HOURS * HOUR) };
    if (next.laundry && !next.laundry.dryAt) next.laundry = { dryAt: iso(now + DRY_HOURS * HOUR) };
  }
  return next;
}

/** A place named by its id or by what she calls it. */
export function findPlace(layout: Layout, text: string): string | undefined {
  const wanted = text.trim();
  if (Object.hasOwn(layout.PLACES, wanted)) return wanted;
  const entries = Object.entries(layout.PLACES);
  return entries.find(([, place]) => place.name === wanted)?.[0] ?? entries.find(([, place]) => place.name.includes(wanted) || wanted.includes(place.name))?.[0];
}

type Done = { state: CottageState; text: string };
type Action = { where: (place: string, layout: Layout) => boolean; run(state: CottageState, now: number, what: string, layout: Layout): Done };
const named = (what: string, asking: string) => {
  const name = what.trim();
  if (!name) throw new Error(`要说${asking}（what）`);
  if ([...name].length > NAME_MAX) throw new Error(`${asking}写短一点，${NAME_MAX} 个字以内`);
  return name;
};
const only = (...places: string[]) => (place: string) => places.includes(place);

/** What she can do, and where. A refusal is thrown in her words and changes nothing. */
export const ACTIONS: Record<string, Action> = {
  做饭: {
    where: only('kitchen'),
    run(state, now, what) {
      if (state.pot) throw new Error(`锅里还有${state.pot.dish}，先吃掉再做`);
      const dish = named(what, '做什么');
      return { state: { ...state, pot: { dish, readyAt: iso(now + COOK_MINUTES * MINUTE) } }, text: `${dish}下锅了，大约 ${COOK_MINUTES} 分钟后好。` };
    },
  },
  吃饭: {
    where: only('table', 'kitchen'),
    run(state, now) {
      if (!state.pot) throw new Error('锅里没有吃的，先去厨房做饭');
      if (now < at(state.pot.readyAt)) throw new Error(`${state.pot.dish}还要 ${inTime(at(state.pot.readyAt) - now)}才好`);
      const { pot, ...rest } = state;
      return { state: rest, text: `吃完了${pot.dish}。` };
    },
  },
  晾衣服: {
    where: only('line'),
    run(state, now) {
      if (state.laundry) throw new Error('晾衣绳上已经挂着衣服了');
      if (raining(state)) throw new Error('外面在下雨，衣服晾出去也干不了');
      return { state: { ...state, laundry: { dryAt: iso(now + DRY_HOURS * HOUR) } }, text: `衣服晾上了，大约 ${DRY_HOURS} 小时后干。` };
    },
  },
  收衣服: {
    where: only('line'),
    run(state, now) {
      if (!state.laundry) throw new Error('晾衣绳上没有衣服');
      const { laundry, ...rest } = state;
      if (!laundry.dryAt) return { state: rest, text: '冒雨把湿衣服收了回来，雨停了再晾。' };
      if (now < at(laundry.dryAt)) throw new Error(`衣服还潮，还要 ${inTime(at(laundry.dryAt) - now)}才干`);
      return { state: rest, text: '把干衣服收下来了。' };
    },
  },
  种菜: {
    where: only('garden'),
    run(state, now, what) {
      if (state.crop) throw new Error(`菜圃里已经种着${state.crop.name}了`);
      const name = named(what, '种什么');
      const crop: Crop = { name, sownAt: iso(now), wateredUntil: iso(now + WATER_HOURS * HOUR), growth: 0, countedAt: iso(now) };
      return { state: { ...state, crop }, text: `种下了${name}，也浇了水。浇一次水够一天，一直有水的话，长满两天就熟。` };
    },
  },
  浇水: {
    where: only('garden'),
    run(state, now) {
      if (!state.crop) throw new Error('菜圃里还什么都没种');
      if (raining(state)) throw new Error('正下着雨，菜圃不用浇');
      const crop = counted(state.crop, now, false);
      if (crop.growth >= RIPE_HOURS) throw new Error(`${crop.name}已经熟了，摘下来就好`);
      return { state: { ...state, crop: { ...crop, wateredUntil: iso(now + WATER_HOURS * HOUR) } }, text: `给${crop.name}浇了水，够它喝一天。` };
    },
  },
  收菜: {
    where: only('garden'),
    run(state, now) {
      if (!state.crop) throw new Error('菜圃里还什么都没种');
      const crop = cropNow(state.crop, now, raining(state));
      if (crop.stage !== 'ripe') throw new Error(`${crop.name}还没熟，还要好好长 ${inTime((RIPE_HOURS - crop.growth) * HOUR)}`);
      const { crop: _crop, ...rest } = state;
      return { state: rest, text: `摘下了${crop.name}。` };
    },
  },
  种花: {
    where: (place, layout) => Boolean(layout.PLACES[place]?.plot),
    run(state, _now, _what, layout) {
      const place = layout.PLACES[state.at]!, mine = Object.values(state.changes).flatMap(change => change.added).filter(thing => thing.id.startsWith('her:'));
      const here = mine.filter(thing => thing.id.startsWith(`her:${state.at}:`)).length;
      if (here >= FLOWERS_PER_PLACE) throw new Error(`${place.name}这里已经种满了`);
      // On that place's open ground, a little further out each time, so they never land on one another.
      const angle = here * 2.4 + 0.5, radius = 0.3 + 0.13 * here, [px, py] = place.plot!;
      const x = px! + Math.cos(angle) * radius, y = py! + Math.sin(angle) * radius;
      const key = layout.chunkKey(...layout.chunkOf(x, y)), change = state.changes[key] ?? { removed: [], added: [] };
      const thing: Thing = { id: `her:${state.at}:${mine.length + 1}`, kind: 'flowers', at: [x, y], scale: 1 };
      return { state: { ...state, changes: { ...state.changes, [key]: { ...change, added: [...change.added, thing] } } }, text: `在${place.name}种了一丛花。` };
    },
  },
};
export const ACTION_NAMES = Object.keys(ACTIONS);

/** What she can do where she is. */
export function doable(state: CottageState, layout: Layout): string[] {
  return ACTION_NAMES.filter(name => ACTIONS[name]!.where(state.at, layout));
}

export function goTo(state: CottageState, layout: Layout, text: string, now: number): Done {
  const place = findPlace(layout, text);
  if (!place) throw new Error(`没有「${text}」这个地方，能去：${Object.values(layout.PLACES).map(p => p.name).join('、')}`);
  const there = layout.PLACES[place]!;
  if (place === state.at) return { state, text: `已经在${there.name}了。` };
  const next = { ...state, at: place, since: iso(now) };
  const can = doable(next, layout);
  return { state: next, text: `到${there.name}了。${there.near}。${can.length ? `这里能${can.join('、')}。` : ''}` };
}

export function act(state: CottageState, layout: Layout, name: string, what: string, now: number): Done {
  const action = Object.hasOwn(ACTIONS, name.trim()) ? ACTIONS[name.trim()] : undefined;
  if (!action) throw new Error(`不会「${name}」，能做的有：${ACTION_NAMES.join('、')}`);
  if (!action.where(state.at, layout)) {
    const places = Object.keys(layout.PLACES).filter(place => action.where(place, layout)).map(place => layout.PLACES[place]!.name);
    throw new Error(`${name}要先去${places.join('或')}`);
  }
  return action.run(state, now, what, layout);
}

/** The cooking, the laundry and the garden, one line each, as they are now. */
function goings(state: CottageState, now: number): string[] {
  const lines: string[] = [];
  if (state.pot) {
    const left = at(state.pot.readyAt) - now;
    lines.push(left > 0 ? `锅里：${state.pot.dish}，还要 ${inTime(left)}` : `锅里：${state.pot.dish}做好了（${ago(-left)}）`);
  }
  if (state.laundry) {
    const dryAt = state.laundry.dryAt, left = dryAt ? at(dryAt) - now : 0;
    lines.push(!dryAt ? '晾衣绳：衣服挂在外面淋着雨' : left > 0 ? `晾衣绳：衣服还要 ${inTime(left)}干` : '晾衣绳：衣服干了');
  }
  if (state.crop) {
    const crop = cropNow(state.crop, now, raining(state));
    const stage = { sprout: '刚发芽', growing: '正在长', ripe: '熟了' }[crop.stage];
    lines.push(`菜圃：${crop.name}${stage}${crop.thirsty ? `，缺水 ${ago(now - at(crop.wateredUntil)).replace('前', '')}了` : crop.stage === 'ripe' ? '' : raining(state) ? '，淋着雨' : '，水够'}`);
  }
  return lines;
}

export function partOfDay(now: number, timeZone: string): string {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(new Date(now)));
  return hour < 5 ? '深夜' : hour < 8 ? '清晨' : hour < 11 ? '上午' : hour < 13 ? '中午' : hour < 17 ? '下午' : hour < 19 ? '傍晚' : hour < 23 ? '晚上' : '深夜';
}

/** What she sees when she looks round: kept short, it is sent again with every later step. */
export function describe(state: CottageState, layout: Layout, now: number, timeZone: string): string {
  const place = layout.PLACES[state.at]!, can = doable(state, layout);
  const elsewhere = Object.entries(layout.PLACES).filter(([id]) => id !== state.at).map(([, p]) => p.name);
  return [
    `我在${place.name}，${partOfDay(now, timeZone)}${SKY_WORDS[state.weather?.kind ?? 'sunny']}。${place.near}。`,
    ...goings(state, now),
    can.length ? `这里能：${can.join('、')}。` : '这里没有要做的事。',
    `能去：${elsewhere.join('、')}。`,
  ].join('\n');
}

/** What has become ready or needs her, as facts for 别处的动静; each is told once (its mark), and a new one when it changes. */
export function news(state: CottageState, now: number): ElsewhereNews[] {
  const list: ElsewhereNews[] = [];
  if (state.pot && now >= at(state.pot.readyAt)) list.push({ key: 'room:pot', mark: state.pot.readyAt, text: `小屋：锅里的${state.pot.dish}做好了（${ago(now - at(state.pot.readyAt))}）` });
  const { laundry, weather } = state;
  if (laundry && !laundry.dryAt) list.push({ key: 'room:laundry', mark: `rain:${weather?.since}`, text: '小屋：下雨了，晾衣绳上的衣服还在外面淋着' });
  else if (laundry?.dryAt && now >= at(laundry.dryAt)) list.push({ key: 'room:laundry', mark: laundry.dryAt, text: `小屋：晾衣绳上的衣服干了（${ago(now - at(laundry.dryAt))}）` });
  if (weather && now - at(weather.since) < WEATHER_NEWS_HOURS * HOUR) {
    list.push({ key: 'room:weather', mark: weather.since, text: `小屋：${WEATHER_CHANGES[weather.kind]}（${ago(now - at(weather.since))}）` });
  }
  if (state.crop) {
    const crop = cropNow(state.crop, now, raining(state));
    if (crop.stage === 'ripe') list.push({ key: 'room:crop', mark: `ripe:${crop.sownAt}`, text: `小屋：菜圃里的${crop.name}熟了` });
    else if (crop.thirsty) list.push({ key: 'room:crop', mark: `thirsty:${crop.wateredUntil}`, text: `小屋：菜圃里的${crop.name}缺水了（${ago(now - at(crop.wateredUntil)).replace('前', '')}没浇）` });
  }
  return list;
}

/** What the console and the room page show of it. */
export function cottageView(state: CottageState, now: number) {
  const crop = state.crop && cropNow(state.crop, now, raining(state)), dryAt = state.laundry?.dryAt;
  return {
    seed: state.seed, generator: state.generator, at: state.at, since: state.since,
    pot: state.pot ? { dish: state.pot.dish, ready: now >= at(state.pot.readyAt), readyAt: state.pot.readyAt } : null,
    laundry: state.laundry ? { dry: dryAt !== undefined && now >= at(dryAt), dryAt: dryAt ?? null } : null,
    weather: state.weather ?? { kind: 'sunny', since: null },
    crop: crop ? { name: crop.name, stage: crop.stage, thirsty: crop.thirsty } : null,
    changes: state.changes,
  };
}
