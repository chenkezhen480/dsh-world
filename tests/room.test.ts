import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { byteRange, roomRoute, roomStatus, ROOM_PACKAGE } from '../src/console/room.ts';
import { meetsRange } from '../src/packageInstall.ts';
import { worldPath } from '../src/worldRoutes.ts';
// @ts-expect-error plain browser module, no types
import { clockText, daylight, localHour, roomState, weathered, yardChanges } from '../packages/dsh-world-room/js/state.js';
// @ts-expect-error plain browser module, no types
import { chunkKey, chunkOf, createWorld, yardThing } from '../packages/dsh-world-room/js/world.js';

const WORLD = worldPath('fish'), ROOM = `${WORLD}/room`;
/** The room package as it sits in this repository, before it is published and installed into a profile. */
const PACKAGE_DIR = fileURLToPath(new URL('../packages/dsh-world-room/', import.meta.url));

type Out = { status?: number; headers?: Record<string, string | number>; body?: Buffer | string };
async function get(url: string, headers: Record<string, string> = {}, method = 'GET', room: () => string | undefined = () => PACKAGE_DIR, allowed: string[] = []) {
  const out: Out = {};
  const res = { writeHead: (status: number, h: Record<string, string | number> = {}) => { out.status = status; out.headers = h; }, end: (body?: Buffer | string) => { out.body = body; } };
  await roomRoute(WORLD, allowed, room).handler({ method, url, headers: { host: 'localhost:3080', ...headers } } as never, res as never);
  return out;
}
function fixtureRoot() {
  const root = join(mkdtempSync(join(tmpdir(), 'dsh-room-')), 'room');
  mkdirSync(join(root, 'js'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<p>room</p>');
  writeFileSync(join(root, 'js', 'main.js'), 'export {}');
  writeFileSync(join(root, 'notes.txt'), 'not a page');
  writeFileSync(join(root, 'her.png'), 'png');
  writeFileSync(join(root, '..', 'secret.js'), 'outside');
  return () => root;
}

test('the room route serves the page and its scripts from the room folder only', async () => {
  const root = fixtureRoot();
  const page = await get(`${ROOM}/`, {}, 'GET', root);
  assert.equal(page.status, 200);
  assert.equal(page.headers!['content-type'], 'text/html; charset=utf-8');
  assert.equal(String(page.body), '<p>room</p>');
  assert.match(String(page.headers!['content-security-policy']), /frame-ancestors 'self'/);
  assert.equal(page.headers!['x-content-type-options'], 'nosniff');
  const script = await get(`${ROOM}/js/main.js?v=1`, {}, 'GET', root);
  assert.equal(script.status, 200);
  assert.equal(script.headers!['content-type'], 'text/javascript; charset=utf-8');
  assert.equal((await get(`${ROOM}/her.png`, {}, 'GET', root)).headers!['content-type'], 'image/png');
  const bare = await get(`${ROOM}`, {}, 'GET', root);
  assert.equal(bare.status, 308, 'relative addresses in the page need the trailing slash');
  assert.equal(bare.headers!.location, `${ROOM}/`);
  for (const path of [`${ROOM}/missing.js`, `${ROOM}/notes.txt`, `${ROOM}/js/`, `${ROOM}/../secret.js`,
    `${ROOM}/%2e%2e/secret.js`, `${ROOM}/..%5csecret.js`, `${ROOM}/%00.js`, `${ROOM}/%zz`, `${WORLD}/roomy/index.html`]) {
    assert.equal((await get(path, {}, 'GET', root)).status, 404, path);
  }
});

test('without the room package installed the route says so, and a broken install is reported, not hidden', async () => {
  const missing = await get(`${ROOM}/`, {}, 'GET', () => undefined);
  assert.equal(missing.status, 404);
  assert.match(JSON.parse(String(missing.body)).error, /小屋还没安装/);
  const broken = await get(`${ROOM}/`, {}, 'GET', () => { throw new Error('package.json is not JSON'); });
  assert.equal(broken.status, 500);
  assert.match(JSON.parse(String(broken.body)).error, /小屋读不出来：package\.json is not JSON/);
});

test('the room route answers byte ranges, so her clips can be seeked', async () => {
  const root = fixtureRoot();
  writeFileSync(join(root(), 'clip.webm'), '0123456789');
  const whole = await get(`${ROOM}/clip.webm`, {}, 'GET', root);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers!['accept-ranges'], 'bytes');
  const part = await get(`${ROOM}/clip.webm`, { range: 'bytes=2-5' }, 'GET', root);
  assert.equal(part.status, 206);
  assert.equal(String(part.body), '2345');
  assert.equal(part.headers!['content-range'], 'bytes 2-5/10');
  assert.equal(part.headers!['content-length'], 4);
  assert.equal(String((await get(`${ROOM}/clip.webm`, { range: 'bytes=7-' }, 'GET', root)).body), '789');
  assert.equal(String((await get(`${ROOM}/clip.webm`, { range: 'bytes=-3' }, 'GET', root)).body), '789');
  assert.equal(String((await get(`${ROOM}/clip.webm`, { range: 'bytes=8-99' }, 'GET', root)).body), '89');
  const past = await get(`${ROOM}/clip.webm`, { range: 'bytes=10-' }, 'GET', root);
  assert.equal(past.status, 416);
  assert.equal(past.headers!['content-range'], 'bytes */10');
  assert.equal((await get(`${ROOM}/clip.webm`, { range: 'bytes=0-1,4-5' }, 'GET', root)).status, 200, 'several ranges: the whole file');
  assert.equal(byteRange('items=0-1', 10), undefined);
  assert.equal(byteRange('bytes=-', 10), undefined);
  assert.equal(byteRange('bytes=5-2', 10), 'unsatisfiable');
});

test('the room route refuses other sites, unknown hosts and writes', async () => {
  const root = fixtureRoot();
  assert.equal((await get(`${ROOM}/`, { 'sec-fetch-site': 'cross-site' }, 'GET', root)).status, 403);
  assert.equal((await get(`${ROOM}/`, { host: 'rebind.example' }, 'GET', root)).status, 403);
  assert.equal((await get(`${ROOM}/`, { host: 'DSH.lan:8443' }, 'GET', root, ['dsh.lan'])).status, 200);
  const post = await get(`${ROOM}/`, {}, 'POST', root);
  assert.equal(post.status, 405);
  assert.equal(post.headers!.allow, 'GET');
});

test('the console knows whether the room is installed and whether that version fits', () => {
  const wanted = JSON.parse(readFileSync('package.json', 'utf8')).peerDependencies[ROOM_PACKAGE];
  assert.deepEqual(roomStatus(() => undefined), { installed: false, wanted, current: false });
  assert.deepEqual(roomStatus(() => ({ dir: PACKAGE_DIR, version: '0.1.3' })), { installed: true, version: '0.1.3', wanted, current: true });
  assert.equal(roomStatus(() => ({ dir: PACKAGE_DIR, version: '0.0.9' })).current, false, 'an older room asks to be updated');
  const broken = roomStatus(() => { throw new Error('bad package.json'); });
  assert.equal(broken.current, false);
  assert.match(broken.error!, /小屋读不出来：bad package\.json/);
});

test('the room package is not in the plugin, and its version is the one the plugin asks for', () => {
  const plugin = JSON.parse(readFileSync('package.json', 'utf8'));
  const room = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'));
  assert.equal(room.name, ROOM_PACKAGE);
  assert.ok(meetsRange(room.version, plugin.peerDependencies[ROOM_PACKAGE]), `${room.version} fits ${plugin.peerDependencies[ROOM_PACKAGE]}`);
  assert.deepEqual(plugin.peerDependenciesMeta[ROOM_PACKAGE], { optional: true }, 'installing the plugin never pulls the room in');
  assert.ok(!plugin.files.some((entry: string) => entry.startsWith('packages')), 'the plugin does not ship the room');
  assert.equal(room.dsh, undefined, 'not a plugin of its own: the host must not try to load it');
  assert.deepEqual(room.exports, { './package.json': './package.json' }, 'the plugin finds it by its package.json');
});

test('the room page only loads what its package ships', async () => {
  const shipped: string[] = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')).files;
  const page = await get(`${ROOM}/`);
  assert.equal(page.status, 200);
  const html = String(page.body);
  const map = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)![1]) as { imports: Record<string, string> };
  for (const target of Object.values(map.imports)) assert.ok(target.startsWith('./vendor/'), target);
  assert.ok(!/https?:\/\//.test(html), 'no outside addresses');
  for (const file of ['js/main.js', 'js/kit.js', 'js/props.js', 'js/room.js', 'js/stage.js', 'js/state.js', 'js/sprite.js', 'js/routine.js', 'js/world.js', 'js/land.js', 'js/outdoor.js', 'js/places.js', 'js/weather.js', 'her/still.png', 'her/idle.webm', 'her/look.webm', 'her/hum.webm', 'her/cube.webm', 'her/code.webm', 'her/nap.webm', 'her/step.webm', 'her/run.webm', 'her/eat.webm', 'her/wipe.webm', 'her/noodle.webm', 'her/read.webm', 'her/mirror.webm', 'her/stretch.webm', 'her/cat.webm', 'vendor/three/build/three.module.js']) {
    assert.equal((await get(`${ROOM}/${file}`)).status, 200, file);
    assert.ok(shipped.includes(file.split('/')[0]!), `${file} is in the package's files`);
  }
  assert.ok(readFileSync(join(PACKAGE_DIR, 'vendor', 'three', 'LICENSE'), 'utf8').includes('MIT'));
  assert.match(readFileSync(join(PACKAGE_DIR, 'her', 'NOTICE.md'), 'utf8'), /dsh-pet[\s\S]*MIT License/, 'the clips keep their source and licence');
});

test('the room shows where she is from the console snapshot', () => {
  const life = { status: 'running', alarm: null };
  assert.deepEqual(roomState({ running: true, life }), { her: 'work', alarm: null, mirrorOpen: false, life: null });
  assert.equal(roomState({ running: true, life: { ...life, status: 'idle' } }).her, 'idle');
  assert.equal(roomState({ running: true, life: { ...life, status: 'cold' } }).her, 'rest');
  assert.equal(roomState({ running: true, life: { ...life, status: 'something new' } }).her, 'idle', 'an unknown status keeps her in the room');
  assert.equal(roomState({ running: false, life }).her, 'away', 'a stopped world');
  assert.equal(roomState({ running: true, life: null }).her, 'away', 'the life line never started');
  assert.equal(roomState(null).her, 'away', 'a new user: nothing yet');
  assert.deepEqual(roomState({ running: true, life: { status: 'idle', alarm: { at: '2026-11-11T22:30:00Z', source: 'self' } } }).alarm, { at: '2026-11-11T22:30:00Z', note: '' });
  assert.equal(roomState({ running: false, life: { status: 'idle', alarm: { at: 'x' } } }).alarm, null, 'no alarm bubble while she is away');
  assert.equal(roomState({ running: true, life, modules: { computer: { running: true } } }).mirrorOpen, true);
  assert.equal(roomState({ running: true, life, modules: { computer: { available: true, enabled: true, running: false } } }).mirrorOpen, false);
  assert.equal(clockText('2026-11-11T22:30:00Z', 'Asia/Shanghai'), '06:30');
  assert.equal(clockText('not a time', 'UTC'), 'not a time');
});

test('the room tab frames this world\'s room once it is installed, and offers to install or update it before', async () => {
  type El = { type: unknown; props: Record<string, unknown> | null; children: unknown[] };
  const react = { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }), useState: (value: unknown) => [value, () => {}], useEffect: () => {}, useRef: (current: unknown) => ({ current }) };
  const posts: { url: string; init: { method?: string; headers?: Record<string, string> } }[] = [];
  let loaded: { factory: (require: (name: string) => unknown) => { __test: (worldId: string) => { Room: (props: unknown) => El } } } | undefined;
  runInNewContext(readFileSync('client/index.js', 'utf8'), {
    window: { __ModuleLoader__: { load: (entry: typeof loaded) => { loaded = entry; } } },
    fetch: async (url: string, init: { method?: string; headers?: Record<string, string> }) => { posts.push({ url, init }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; },
  });
  const Room = loaded!.factory(() => react).__test('fish').Room;
  const wanted = '^0.1.0';
  const nodes = (value: unknown): El[] => {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== 'object') return [];
    const el = value as El;
    return [el, ...nodes(el.children)];
  };
  const text = (el: El) => nodes(el).flatMap(node => node.children.filter(child => typeof child === 'string')).join('');

  const pane = Room({ name: '鲸鲸', room: { installed: true, version: '0.1.0', wanted, current: true }, refresh: () => {} });
  const frame = nodes(pane).find(node => node.type === 'iframe')!;
  assert.equal(frame.props!.src, `${ROOM}/`);
  assert.equal(frame.props!.title, '鲸鲸的小屋');
  assert.match(text(pane), /现在只是画面：在概览的「接入」里打开「她住进小屋」/, 'before she lives there, the tab says where to turn it on');
  const living = Room({ name: '鲸鲸', room: { installed: true, version: '0.1.0', wanted, current: true, life: { at: 'room', weather: { kind: 'sunny', since: null } } }, refresh: () => {} });
  assert.match(text(living), /鲸鲸住在这里/);
  assert.ok(!nodes(pane).some(node => typeof node.type === 'function' && node.type.name === 'Weather'), 'no weather to set before she lives there');
  const weather = nodes(living).find(node => typeof node.type === 'function' && node.type.name === 'Weather')!;
  const buttons = nodes((weather.type as (props: unknown) => El)(weather.props)).filter(node => node.type === 'button');
  assert.deepEqual(buttons.map(text), ['晴', '阴', '雨']);
  assert.equal(buttons[0]!.props!['aria-pressed'], true);
  (buttons[2]!.props!.onClick as () => void)();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(posts.at(-1)!.url, `${WORLD}/console/cottage/weather`);
  assert.equal(posts.at(-1)!.init.headers!['x-dsh-world'], '1');

  let refreshed = 0;
  const offer = Room({ name: '鲸鲸', room: { installed: false, wanted, current: false }, refresh: () => { refreshed++; } });
  assert.ok(!nodes(offer).some(node => node.type === 'iframe'), 'nothing to frame before it is installed');
  const button = nodes(offer).find(node => node.type === 'button')!;
  assert.equal(text(button), '安装小屋');
  (button.props!.onClick as () => void)();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(posts.at(-1)!.url, `${WORLD}/console/room/install`);
  assert.equal(posts.at(-1)!.init.method, 'POST');
  assert.equal(posts.at(-1)!.init.headers!['x-dsh-world'], '1');
  assert.equal(refreshed, 1, 'the tab reloads the snapshot once the install is done');

  const outdated = Room({ name: '鲸鲸', room: { installed: true, version: '0.0.9', wanted, current: false }, refresh: () => {} });
  assert.equal(text(nodes(outdated).find(node => node.type === 'button')!), '更新小屋');
  assert.match(text(outdated), /0\.0\.9.*\^0\.1\.0/);
  assert.equal(text(nodes(Room({ name: '鲸鲸', room: null, refresh: () => {} })).find(node => node.type === 'button')!), '安装小屋', 'an older snapshot without the field counts as not installed');
  assert.match(readFileSync('client/index.js', 'utf8'), /\['room', '小屋'\]/);
});

test('while she lives in the cottage the page gets her own land and life, and only while her world runs', () => {
  const cottage = { seed: 7, generator: 1, at: 'garden', pot: null, laundry: null, crop: null, changes: {} };
  const life = { status: 'idle' };
  assert.equal(roomState({ running: true, life, room: { current: true, life: cottage } }).life, cottage);
  assert.equal(roomState({ running: true, life, room: { current: true } }).life, null, 'the module is off: the room plays out her day by itself');
  assert.equal(roomState({ running: false, life, room: { current: true, life: cottage } }).life, null, 'a stopped world');
});

type Placed = { id: string; kind: string; at: number[]; rot?: number; variant?: string; thirsty?: boolean };
type Changes = Record<string, { removed: string[]; added: Placed[] }>;
test('her garden bed, laundry and flowers become chunk changes; what dsh-world sent is left as it was', () => {
  assert.deepEqual(yardChanges(null), {}, 'not living here: the yard as it grows by itself');
  const bed: Placed = yardThing('bed'), line: Placed = yardThing('clothesline');
  const at = (thing: { at: number[] }): string => chunkKey(...chunkOf(thing.at[0], thing.at[1]));
  const find = (changes: Changes, thing: Placed, id: string) => changes[at(thing)]!.added.find(t => t.id === id)!;
  const flowers = { id: 'her:lawn:1', kind: 'flowers', at: [1, -4] };
  const stored = { [at(flowers)]: { removed: [], added: [flowers] } };
  const empty: Changes = yardChanges({ crop: null, laundry: null, changes: stored });
  assert.deepEqual(empty[at(bed)]!.removed, ['yard:bed'], 'her live bed takes the place of the planned one');
  assert.equal(find(empty, bed, 'live:bed').variant, 'empty');
  assert.ok(!Object.values(empty).some(change => change.added.some(t => t.kind === 'laundry')), 'nothing on the line');
  assert.ok(find(empty, flowers, 'her:lawn:1'));
  assert.deepEqual(stored[at(flowers)]!.added, [flowers], 'her stored changes are copied, not edited');

  const busy: Changes = yardChanges({ crop: { name: '小番茄', stage: 'growing', thirsty: true }, laundry: { dry: false }, changes: {} });
  const liveBed = find(busy, bed, 'live:bed');
  assert.deepEqual([liveBed.variant, liveBed.thirsty, liveBed.at, liveBed.rot], ['growing', true, bed.at, bed.rot]);
  const laundry = find(busy, line, 'live:laundry');
  assert.deepEqual([laundry.kind, laundry.variant, laundry.at], ['laundry', 'wet', line.at]);
  // The land applies them: the planned bed is gone from its chunk, hers stands on the ground there.
  const [cx, cy] = chunkOf(bed.at[0], bed.at[1]);
  const objects: Placed[] = createWorld({ seed: 7 }).chunk(cx, cy, busy[at(bed)]).objects;
  assert.ok(!objects.some(t => t.id === 'yard:bed'));
  assert.equal(objects.filter(t => t.kind === 'bed').length, 1);
});

test('the light follows the time of day in her world, blending smoothly from one hour to the next', () => {
  type Light = { fill: [string, string, number]; key: [string, number]; lamps: number; sky: [string, string]; stars: number; her: string };
  const at = (hour: number): Light => daylight(hour);
  assert.equal(at(12).sky[0], '#86BDEB', 'midday is the day the room was drawn in');
  assert.equal(at(12).her, '#FFFFFF', 'and she is shown as she is');
  assert.equal(at(23).stars, 1);
  assert.ok(at(23).lamps > at(12).lamps && at(23).fill[2] < at(12).fill[2], 'at night the lamps carry the room');
  assert.deepEqual(at(0), at(24), 'midnight is midnight either way');
  // No jumps: a minute later never looks much different.
  for (let minute = 0; minute < 24 * 60; minute++) {
    const now = at(minute / 60), next = at((minute + 1) / 60);
    assert.ok(Math.abs(now.fill[2] - next.fill[2]) < 0.05 && Math.abs(now.lamps - next.lamps) < 0.05, `smooth at ${minute} min`);
  }
  assert.equal(localHour(Date.parse('2026-11-19T10:30:00Z'), 'Asia/Shanghai'), 18.5);
  assert.equal(localHour(Date.parse('2026-11-19T10:30:00Z'), 'not a zone'), 10.5, 'a zone it cannot read falls back to UTC');
});

test('clouds and rain take the colour and the sun out of any hour, and a rainy night stays a night', () => {
  type Light = { fill: [string, string, number]; key: [string, number]; beam: [string, number]; sky: [string, string]; stars: number; cover: number };
  const noon = daylight(12), night = daylight(23);
  assert.deepEqual(weathered(noon, 'sunny'), { ...noon, cover: 0 }, 'fine weather is the hour as it is');
  const grey: Light = weathered(noon, 'cloudy'), wet: Light = weathered(noon, 'rain');
  assert.ok(wet.key[1] < grey.key[1] && grey.key[1] < noon.key[1], 'the heavier the sky, the less sun');
  assert.ok(wet.cover > grey.cover && grey.cover > 0);
  const saturation = (hex: string) => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); return Math.max(r!, g!, b!) - Math.min(r!, g!, b!); };
  assert.ok(saturation(wet.sky[0]) < saturation(noon.sky[0]) / 2, 'a rainy sky is grey, not blue');
  const rainyNight: Light = weathered(night, 'rain');
  assert.ok(rainyNight.fill[2] < wet.fill[2], 'a rainy night is darker than a rainy noon');
  assert.ok(rainyNight.stars < 0.2, 'no stars through the rain');
  assert.deepEqual(weathered(noon, 'something new'), { ...noon, cover: 0 }, 'a weather this page does not know is drawn as fine');
});
