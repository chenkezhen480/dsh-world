import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, changeWeather, cropNow, describe, goTo, newCottage, news, parseCottage, cottageView, COOK_MINUTES, type Layout, type CottageState } from '../src/cottage/life.ts';
import { createCottageModule, loadLayout } from '../src/cottage/index.ts';
import { createWorldSwitch } from '../src/worldSwitch.ts';
// @ts-expect-error plain browser module, no types
import { HOUSE, createWorld } from '../packages/dsh-world-room/js/world.js';

const PACKAGE_DIR = fileURLToPath(new URL('../packages/dsh-world-room/', import.meta.url));
const layout = await loadLayout(PACKAGE_DIR);
const T0 = Date.parse('2026-11-19T08:00:00Z'), MIN = 60_000, HOUR = 60 * MIN;
const start = () => newCottage(42, layout, T0);
/** Runs one step after another, each taking the state the last one left. */
function steps(state: CottageState, list: [string, ...string[]][], now: number): CottageState {
  for (const [kind, a, b = ''] of list) state = (kind === 'go' ? goTo(state, layout, a!, now) : act(state, layout, a!, b, now)).state;
  return state;
}

test('she starts in the middle of the room, in a land of her own seed', () => {
  const room = start();
  assert.equal(room.at, 'room');
  assert.equal(room.seed, 42);
  assert.equal(room.generator, (layout as Layout).GENERATOR);
  assert.deepEqual(room.changes, {});
});

test('going somewhere says what is there and what she can do there', () => {
  const { state, text } = goTo(start(), layout, '厨房', T0);
  assert.equal(state.at, 'kitchen');
  assert.match(text, /^到厨房了。灶台/);
  assert.match(text, /这里能做饭、吃饭。/);
  assert.equal(goTo(state, layout, 'kitchen', T0).text, '已经在厨房了。');
  assert.equal(goTo(start(), layout, '床', T0).state.at, 'bed', 'what she calls it is enough');
  assert.throws(() => goTo(start(), layout, '火星', T0), /没有「火星」这个地方，能去：屋子中间、厨房/);
  for (const inherited of ['constructor', 'toString', '__proto__']) {
    assert.throws(() => goTo(start(), layout, inherited, T0), /这个地方/, `${inherited} is in every object, but it is no place`);
    assert.throws(() => act(start(), layout, inherited, '', T0), /不会/);
    assert.throws(() => parseCottage({ ...start(), at: inherited }, layout), /不认识/);
    assert.throws(() => parseCottage({ ...start(), weather: { kind: inherited, since: start().since } }, layout), /天气读不懂/);
  }
});

test('cooking takes its time, the dish is told once when it is ready, and eating clears the pot', () => {
  const cooking = steps(start(), [['go', '厨房'], ['do', '做饭', '番茄蛋汤']], T0);
  assert.equal(cooking.pot!.dish, '番茄蛋汤');
  assert.throws(() => act(cooking, layout, '做饭', '面条', T0), /锅里还有番茄蛋汤/);
  assert.throws(() => act(cooking, layout, '吃饭', '', T0 + 10 * MIN), /番茄蛋汤还要 15 分钟才好/);
  assert.deepEqual(news(cooking, T0 + 10 * MIN), [], 'nothing to tell before it is ready');
  const ready = news(cooking, T0 + (COOK_MINUTES + 3) * MIN);
  assert.deepEqual(ready.map(n => n.key), ['room:pot']);
  assert.equal(ready[0]!.text, '小屋：锅里的番茄蛋汤做好了（3 分钟前）');
  assert.equal(news(cooking, T0 + 2 * HOUR)[0]!.mark, ready[0]!.mark, 'the same dish is the same news, told once');
  const eaten = steps(cooking, [['go', '餐桌'], ['do', '吃饭']], T0 + HOUR);
  assert.equal(eaten.pot, undefined);
  assert.deepEqual(news(eaten, T0 + 2 * HOUR), []);
});

test('each thing is done where it belongs, and a refusal changes nothing', () => {
  const room = start();
  assert.throws(() => act(room, layout, '晾衣服', '', T0), /晾衣服要先去晾衣绳/);
  assert.throws(() => act(room, layout, '种花', '', T0), /种花要先去樱花树下或长椅或前院/);
  assert.throws(() => act(goTo(room, layout, '菜圃', T0).state, layout, '种花', '', T0), /种花要先去/, 'the garden bed is for vegetables');
  assert.throws(() => act(room, layout, '飞', '', T0), /不会「飞」，能做的有：做饭、吃饭/);
  assert.throws(() => act(goTo(room, layout, '厨房', T0).state, layout, '做饭', '', T0), /要说做什么/);
  assert.equal(room.at, 'room');
});

test('laundry dries in a few hours on the line', () => {
  const hung = steps(start(), [['go', '晾衣绳'], ['do', '晾衣服']], T0);
  assert.throws(() => act(hung, layout, '收衣服', '', T0 + HOUR), /衣服还潮，还要 2 小时才干/);
  assert.deepEqual(news(hung, T0 + 3 * HOUR + 5 * MIN).map(n => n.text), ['小屋：晾衣绳上的衣服干了（5 分钟前）']);
  assert.equal(act(hung, layout, '收衣服', '', T0 + 4 * HOUR).state.laundry, undefined);
});

test('the garden grows only while it is watered, says once when it is thirsty, and ripens after two kept days', () => {
  const sown = steps(start(), [['go', '菜圃'], ['do', '种菜', '小番茄']], T0);
  assert.equal(cropNow(sown.crop!, T0 + HOUR).stage, 'sprout');
  // Left alone for 30 hours: it grew for the 24 the first watering lasted, then stopped.
  const dry = cropNow(sown.crop!, T0 + 30 * HOUR);
  assert.equal(dry.growth, 24);
  assert.equal(dry.thirsty, true);
  const thirsty = news(sown, T0 + 30 * HOUR);
  assert.deepEqual(thirsty.map(n => n.text), ['小屋：菜圃里的小番茄缺水了（6 小时没浇）']);
  const watered = act(sown, layout, '浇水', '', T0 + 30 * HOUR).state;
  assert.deepEqual(news(watered, T0 + 31 * HOUR), [], 'watered: nothing to tell');
  assert.notEqual(news(watered, T0 + 60 * HOUR)[0]?.mark, thirsty[0]!.mark, 'thirsty again is new news');
  assert.throws(() => act(watered, layout, '收菜', '', T0 + 40 * HOUR), /小番茄还没熟，还要好好长 14 小时/);
  const ripe = cropNow(watered.crop!, T0 + 54 * HOUR);
  assert.equal(ripe.stage, 'ripe');
  assert.deepEqual(news(watered, T0 + 54 * HOUR).map(n => n.text), ['小屋：菜圃里的小番茄熟了']);
  assert.equal(act(watered, layout, '收菜', '', T0 + 54 * HOUR).state.crop, undefined);
  assert.throws(() => act(sown, layout, '种菜', '茄子', T0), /已经种着小番茄/);
});

test('flowers she plants become changes in the chunk they stand in, never on top of each other', () => {
  let room = goTo(start(), layout, '樱花树下', T0).state;
  for (let i = 0; i < 6; i++) room = act(room, layout, '种花', '', T0).state;
  assert.throws(() => act(room, layout, '种花', '', T0), /樱花树下这里已经种满了/);
  const added = Object.entries(room.changes).flatMap(([key, change]) => change.added.map(thing => ({ key, thing })));
  assert.equal(added.length, 6);
  assert.equal(new Set(added.map(a => a.thing.id)).size, 6);
  for (const { key, thing } of added) assert.equal(key, layout.chunkKey(...layout.chunkOf(thing.at[0]!, thing.at[1]!)));
  const spots = added.map(a => a.thing.at);
  for (let i = 0; i < spots.length; i++) for (let j = 0; j < i; j++) assert.ok(Math.hypot(spots[i]![0]! - spots[j]![0]!, spots[i]![1]! - spots[j]![1]!) > 0.3);
  room = act(goTo(room, layout, '前院', T0).state, layout, '种花', '', T0).state;
  assert.ok(Object.values(room.changes).flatMap(c => c.added).some(t => t.id.startsWith('her:lawn:')));
});

test('looking round tells where she is, the time of day, what is going on and where she can go', () => {
  const busy = steps(start(), [['go', '厨房'], ['do', '做饭', '咖喱']], T0);
  const text = describe(busy, layout, T0 + 5 * MIN, 'Asia/Shanghai');
  assert.match(text, /^我在厨房，下午。/);
  assert.match(text, /锅里：咖喱，还要 20 分钟/);
  assert.match(text, /这里能：做饭、吃饭。/);
  assert.match(text, /能去：屋子中间、餐桌/);
  assert.ok(!text.includes('能去：厨房'));
  assert.ok(text.length < 400, 'short: it is sent again with every later step');
});

test('a stored room is read back only when it is whole', () => {
  const room = steps(start(), [['go', '菜圃'], ['do', '种菜', '萝卜']], T0);
  assert.deepEqual(parseCottage(JSON.parse(JSON.stringify(room)), layout), room);
  assert.throws(() => parseCottage({ ...room, at: 'moon' }, layout), /不认识：moon/);
  assert.throws(() => parseCottage({ ...room, crop: { ...room.crop, sownAt: 'soon' } }, layout), /菜圃读不懂/);
  assert.throws(() => parseCottage(null, layout), /不是一个对象/);
  assert.deepEqual(cottageView(room, T0).crop, { name: '萝卜', stage: 'sprout', thirsty: false });
});

test('the module keeps her cottage in cottage.json, gives her one cottage tool, and leaves a broken file alone', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-room-life-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let clock = T0;
  const make = () => createCottageModule({ worldDir: dir, layout, timeZone: 'UTC', partner: () => '阿明', isHome: id => id === 'home', now: () => clock });
  const module = make();
  const stored = JSON.parse(readFileSync(join(dir, 'cottage.json'), 'utf8'));
  assert.ok(Number.isSafeInteger(stored.seed) && stored.seed > 0, 'a new room gets a seed of its own');
  const [tool] = module.tools();
  assert.equal(tool!.name, 'cottage');
  assert.match(tool!.description, /阿明在控制台的小屋里看得到我/);
  const run = (input: Record<string, unknown>) => (tool as unknown as { execute(input: Record<string, unknown>): Promise<string> }).execute(input);
  assert.match(await run({ action: 'look' }), /^我在屋子中间，上午。/);
  assert.match(await run({ action: 'go', place: '厨房' }), /^到厨房了/);
  assert.match(await run({ action: 'do', do: '做饭', what: '粥' }), /粥下锅了/);
  await assert.rejects(run({ action: 'fly' }), /action 只能是 look、go 或 do/);
  clock += 30 * MIN;
  const session = (id: string) => ({ id }) as never;
  assert.deepEqual(module.elsewhere.news(new Date(clock), session('home')).map((n: { text: string }) => n.text), ['小屋：锅里的粥做好了（5 分钟前）']);
  assert.deepEqual(module.elsewhere.news(new Date(clock), session('group-chat')), [], 'a group session has no cottage tool, so it is not told');
  const again = make();
  assert.equal(again.view().at, 'kitchen', 'read back from cottage.json');
  assert.equal(again.view().seed, stored.seed);
  writeFileSync(join(dir, 'cottage.json'), '{"seed":1');
  assert.throws(make);
  assert.equal(readFileSync(join(dir, 'cottage.json'), 'utf8'), '{"seed":1', 'a broken file is reported, not written over');
});

test('her cottage is off in every world until someone turns it on, and the choice is kept in world.json', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cottage-switch-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(createWorldSwitch(dir).cottageEnabled(), false, 'a new world and an upgraded one alike: nothing changes in her context');
  createWorldSwitch(dir).setModules({ cottage: true });
  assert.equal(createWorldSwitch(dir).cottageEnabled(), true);
  createWorldSwitch(dir).setModules({ qq: true });
  assert.equal(createWorldSwitch(dir).cottageEnabled(), true, 'another switch leaves it as it is');
  createWorldSwitch(dir).setModules({ cottage: false });
  assert.equal(JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8')).cottageEnabled, undefined, 'off is the default, so nothing is stored for it');
});

test('every flower she can plant lands inside the fence and clear of everything planned in the yard', () => {
  type Placed = { id: string; kind: string; at: number[] };
  const yard: Placed[] = [];
  const world = createWorld({ seed: 7 });
  for (let cx = -1; cx <= 0; cx++) for (let cy = -1; cy <= 0; cy++) yard.push(...(world.chunk(cx, cy).objects as Placed[]).filter(t => t.id.startsWith('yard:') && !['fence', 'stone'].includes(t.kind)));
  assert.ok(yard.some(t => t.id === 'yard:bed'), 'the planned things are all looked at');
  const { x0, x1, y0, y1 } = HOUSE.yard;
  for (const [id, place] of Object.entries(layout.PLACES).filter(([, p]) => p.plot)) {
    let room = goTo(newCottage(1, layout, T0), layout, id, T0).state;
    for (let i = 0; i < 6; i++) room = act(room, layout, '种花', '', T0).state;
    for (const flower of Object.values(room.changes).flatMap(c => c.added)) {
      const [x, y] = flower.at as [number, number];
      assert.ok(x > x0 + 0.4 && x < x1 - 0.4 && y > y0 + 0.4 && y < y1 - 0.4, `${place.name}: ${flower.id} inside the fence`);
      for (const thing of yard) assert.ok(Math.hypot(thing.at[0]! - x, thing.at[1]! - y) > 0.6, `${place.name}: ${flower.id} clear of ${thing.id}`);
    }
  }
});

test('rain waters the garden bed for as long as it falls and for a day after, so she need not water it', () => {
  const sown = steps(newCottage(42, layout, T0), [['go', '菜圃'], ['do', '种菜', '小番茄']], T0);
  // Left alone 30 hours: thirsty for the last 6. Then it rains for 10 hours.
  const rain = changeWeather(sown, 'rain', T0 + 30 * HOUR);
  assert.equal(rain.crop!.growth, 24, 'the dry hours before the rain were not growth');
  assert.equal(cropNow(rain.crop!, T0 + 40 * HOUR, true).growth, 34);
  assert.equal(cropNow(rain.crop!, T0 + 40 * HOUR, true).thirsty, false);
  assert.deepEqual(news(rain, T0 + 31 * HOUR).map(n => n.key), ['room:weather'], 'raining: not thirsty');
  assert.throws(() => act(rain, layout, '浇水', '', T0 + 31 * HOUR), /正下着雨，菜圃不用浇/);
  assert.match(describe(rain, layout, T0 + 31 * HOUR, 'UTC'), /^我在菜圃，[^。]+，外面在下雨。/);
  assert.match(describe(rain, layout, T0 + 31 * HOUR, 'UTC'), /菜圃：小番茄正在长，淋着雨/);
  const after = changeWeather(rain, 'sunny', T0 + 40 * HOUR);
  assert.equal(after.crop!.growth, 34);
  assert.equal(cropNow(after.crop!, T0 + 54 * HOUR).stage, 'ripe', 'the rain kept it watered a day after it stopped');
  assert.equal(changeWeather(after, 'sunny', T0 + 41 * HOUR), after, 'the same weather again changes nothing');
});

test('rain soaks the laundry on the line: it dries only once the rain stops, and she can bring it in wet', () => {
  const hung = steps(newCottage(42, layout, T0), [['go', '晾衣绳'], ['do', '晾衣服']], T0);
  const soaked = changeWeather(hung, 'rain', T0 + HOUR);
  assert.deepEqual(soaked.laundry, {});
  const told = news(soaked, T0 + HOUR + 10 * MIN);
  assert.deepEqual(told.map(n => n.text), ['小屋：下雨了，晾衣绳上的衣服还在外面淋着', '小屋：下雨了（10 分钟前）']);
  assert.equal(news(soaked, T0 + 9 * HOUR).find(n => n.key === 'room:laundry')!.mark, told[0]!.mark, 'told once for this rain');
  assert.ok(!news(soaked, T0 + 9 * HOUR).some(n => n.key === 'room:weather'), 'a change of weather is news for a few hours, then just the weather');
  assert.match(act(soaked, layout, '收衣服', '', T0 + 2 * HOUR).text, /冒雨把湿衣服收了回来/);
  assert.throws(() => act(act(soaked, layout, '收衣服', '', T0 + 2 * HOUR).state, layout, '晾衣服', '', T0 + 2 * HOUR), /外面在下雨/);
  const stopped = changeWeather(soaked, 'cloudy', T0 + 2 * HOUR);
  assert.throws(() => act(stopped, layout, '收衣服', '', T0 + 4 * HOUR), /衣服还潮，还要 1 小时才干/, 'drying starts again when the rain stops');
  assert.equal(cottageView(stopped, T0 + 5 * HOUR).laundry!.dry, true);
  assert.deepEqual(cottageView(stopped, T0 + 5 * HOUR).weather, { kind: 'cloudy', since: new Date(T0 + 2 * HOUR).toISOString() });
  assert.deepEqual(cottageView(hung, T0).weather, { kind: 'sunny', since: null }, 'fine until someone says otherwise');
  assert.deepEqual(parseCottage(JSON.parse(JSON.stringify(soaked)), layout), soaked, 'a soaked line and the weather are read back');
  assert.throws(() => parseCottage({ ...soaked, weather: { kind: 'snow', since: soaked.since } }, layout), /天气读不懂/);
});
