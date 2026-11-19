// Where she can be, in the house and in the yard, and the paths between them. Plain data: the page walks her along
// these paths, and dsh-world reads the same file to name the places and check where she can go. Room coordinates
// (see kit.js): x east, y north, z up, 1 unit = her height; the house floor is at 0, the bed platform at 0.15.
import { GROUND } from './world.js';

// What dsh-world needs of the land to place her changes: it reads this one file.
export { GENERATOR, chunkKey, chunkOf } from './world.js';

const G = GROUND;

/**
 * name: what she and the partner call it. near: what is there, as she would see it. clips: what she does there, idle
 * (and busy, while she is in the middle of a turn). seat: a spot she hops up onto from `at` (the armchair, the bed).
 * plot: open ground near it, clear of everything planned and inside the fence, where she can plant flowers.
 */
export const PLACES = Object.freeze({
  room: { name: '屋子中间', at: [-1.0, -0.6, 0], stop: 'center', clips: { idle: ['idle', 'look', 'hum', 'cube', 'stretch'] },
    near: '蓝色的大地毯和小圆桌，左边是厨房，后面是床，右边是书桌和扶手椅' },
  kitchen: { name: '厨房', at: [-2.55, -0.65, 0], stop: 'kitchen', clips: { idle: ['wipe', 'eat'] },
    near: '灶台上一把水壶，旁边是水槽、果盘和砧板；墙上两层架子放着罐子和杯子，垂着绿萝' },
  table: { name: '餐桌', at: [0.6, -0.3, 0], stop: 'table', clips: { idle: ['noodle'] },
    near: '小圆桌铺着蕾丝桌布，上面是鲸鱼茶壶、两个杯子和一小盆绣球，两把格子垫的椅子' },
  sofa: { name: '扶手椅', at: [1.62, -0.66, 0], seat: [2.15, -0.34, 0.37], stop: 'sofa', clips: { idle: ['nap'] },
    near: '米白的扶手椅，搭着蓝格子毯子，靠垫上绣着鲸鱼；旁边小桌上一盏台灯和两本书' },
  desk: { name: '书桌', at: [2.78, -0.72, 0], stop: 'aisle', clips: { idle: ['read'], busy: ['code'] },
    near: '书桌上是电脑、键盘和支在架子上的手机，后面一整面书架，书架上趴着一只蓝鲸摆件' },
  mirror: { name: '传送镜前', at: [1.75, 1.25, 0], stop: 'mirror', clips: { idle: ['mirror'] },
    near: '一人高的椭圆镜子，镜框是米白和金色，顶上一条鲸尾；镜子还锁着' },
  bed: { name: '床上', at: [-0.5, 0.45, 0.15], seat: [-0.5, 1.17, 0.63], stop: 'platform', clips: { idle: ['nap'] },
    near: '深蓝的被子上绣着白鲸和星星，枕头上一个蓝蝴蝶结；床头柜上有台灯' },
  window: { name: '窗边', at: [-1.35, 0.95, 0.15], stop: 'nook', clips: { idle: ['look', 'idle'] },
    near: '拱形的窗，两边挂着蓝窗帘，窗台上两盆绣球；窗外是菜圃、樱花树和院子的篱笆' },
  garden: { name: '菜圃', at: [-3.0, 3.6, G], stop: 'garden', outside: true, clips: { idle: ['wipe', 'look'] },
    near: '窗下的木框菜圃，两边各一丛蓝绣球，抬头就是自己的窗' },
  blossom: { name: '樱花树下', at: [-4.6, 3.3, G], stop: 'northwest', outside: true, plot: [-6.2, 3.2], clips: { idle: ['hum', 'look'] },
    near: '一棵开满粉花的樱花树，树下落着花瓣，往外是篱笆和草地' },
  line: { name: '晾衣绳', at: [5.0, 4.3, G], stop: 'northeast', outside: true, clips: { idle: ['wipe', 'stretch'] },
    near: '后院两根柱子拉着晾衣绳，旁边一棵挂着红苹果的树' },
  bench: { name: '长椅', at: [-5.7, 0.6, G], seat: [-6.2, 0.6, G + 0.45], stop: 'west', outside: true, plot: [-6.4, -1.4], clips: { idle: ['nap'] },
    near: '房子西边一张木长椅，对着前院的草坪' },
  lawn: { name: '前院', at: [1.0, -3.6, G], stop: 'front', outside: true, plot: [-0.3, -4.2], clips: { idle: ['stretch', 'hum', 'look'] },
    near: '房前的草坪，种着几丛花，前面是白篱笆' },
  mailbox: { name: '信箱', at: [8.6, -0.5, G], stop: 'mailbox', outside: true, clips: { idle: ['look'] },
    near: '院门边上一个深蓝的信箱' },
  gate: { name: '院门口', at: [9.1, 0.6, G], stop: 'gate', outside: true, clips: { idle: ['look', 'idle'] },
    near: '篱笆上留着的院门，门外一条土路往东一直通到看不见的地方' },
});

/** Points on the floor and lawn she walks between: through the house it keeps clear of the furniture, outside it goes round the house. */
export const STOPS = Object.freeze({
  kitchen: [-2.55, -0.65, 0], center: [-1.0, -0.6, 0], table: [0.6, -0.3, 0], sofa: [1.32, -0.22, 0], mirror: [1.36, 0.95, 0],
  desk: [3.6, -1.1, 0], aisle: [2.1, -1.3, 0], indoor: [4.55, -0.15, 0],
  step: [0.5, 0.1, 0], platform: [0.3, 0.45, 0.15], nook: [-1.05, 0.47, 0.15],
  door: [5.7, 0.3, G], southeast: [6.5, -3.0, G], front: [1.0, -3.6, G], southwest: [-5.4, -3.0, G], west: [-5.4, 0.6, G],
  northwest: [-4.4, 3.4, G], garden: [-3.0, 3.6, G], back: [1.2, 5.9, G], northeast: [5.2, 4.4, G], mailbox: [8.6, -0.5, G], gate: [9.1, 0.6, G],
});
const LINKS = [
  ['kitchen', 'center'], ['center', 'table'], ['table', 'sofa'], ['sofa', 'mirror'], ['sofa', 'aisle'], ['aisle', 'desk'], ['desk', 'indoor'],
  ['table', 'step'], ['center', 'step'], ['step', 'platform'], ['platform', 'nook'],
  ['indoor', 'door'],                                                              // the front door
  ['door', 'southeast'], ['southeast', 'front'], ['front', 'southwest'], ['southwest', 'west'], ['west', 'northwest'], ['northwest', 'garden'],
  ['garden', 'back'], ['back', 'northeast'], ['northeast', 'door'], ['door', 'mailbox'], ['mailbox', 'gate'], ['door', 'gate'],
];

const far = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const NEXT = (() => {
  const next = new Map(Object.keys(STOPS).map(stop => [stop, []]));
  for (const [a, b] of LINKS) { next.get(a).push(b); next.get(b).push(a); }
  return next;
})();

/** The shortest way between two stops (Dijkstra over a handful of points). */
function between(from, to) {
  const dist = new Map([[from, 0]]), back = new Map(), open = new Set([from]);
  while (open.size) {
    const here = [...open].reduce((a, b) => (dist.get(a) <= dist.get(b) ? a : b));
    open.delete(here);
    if (here === to) break;
    for (const next of NEXT.get(here)) {
      const d = dist.get(here) + far(STOPS[here], STOPS[next]);
      if (d < (dist.get(next) ?? Infinity)) { dist.set(next, d); back.set(next, here); open.add(next); }
    }
  }
  if (!dist.has(to)) throw new Error(`no way from ${from} to ${to}`);
  const stops = [to];
  while (stops[0] !== from) stops.unshift(back.get(stops[0]));
  return stops;
}

/** The points she walks from one place to another: off her seat, along the stops, to the other place (and up its seat). */
export function route(fromId, toId) {
  const from = PLACES[fromId], to = PLACES[toId];
  if (!from || !to) throw new Error(`unknown place: ${from ? toId : fromId}`);
  const points = [from.at, ...between(from.stop, to.stop).map(stop => STOPS[stop]), to.at];
  // Neighbouring points that are the same spot are walked once.
  return points.filter((p, i) => i === 0 || far(p, points[i - 1]) > 0.01 || p[2] !== points[i - 1][2]);
}
