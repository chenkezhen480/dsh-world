import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { renderPersona } from '../src/persona.ts';

test('the client registers the world console settings section under the bundle id', async () => {
  const source = await readFile('client/index.js', 'utf8');
  let loaded: { id: string; factory: (require: (name: string) => unknown) => { inject: string[]; apply(ctx: unknown): void } } | undefined;
  const react = { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }), useState: (value: unknown) => [typeof value === 'function' ? (value as () => unknown)() : value, () => {}], useEffect: () => {}, useRef: (current: unknown) => ({ current }) };
  let reply: () => Promise<unknown> = async () => { throw new Error('no fetch'); };
  const fetched: string[] = [];
  runInNewContext(source, { fetch: (url: string) => { fetched.push(url); return reply(); }, window: { __ModuleLoader__: { load: (entry: typeof loaded) => { loaded = entry; } } } });
  assert.equal(loaded?.id, 'dsh-world');
  const plugin = loaded!.factory(name => { assert.equal(name, 'react'); return react; });
  assert.deepEqual([...plugin.inject], ['slots']); // spread: the array comes from the vm realm
  const registered: { meta: Record<string, unknown>; render: () => { type: unknown } }[] = [];
  plugin.apply({ slots: { inject: (_name: string, register: () => unknown) => register(), register: (meta: Record<string, unknown>, render: () => { type: unknown }) => { registered.push({ meta, render }); return () => {}; } } });
  assert.deepEqual({ ...registered[0].meta }, { name: 'settings.section', id: 'world-console', order: 28, label: '世界控制台' });
  assert.equal(typeof registered[0].render().type, 'function');
  // minimal fake renderer: call function components, collect text
  type El = { type: unknown; props: Record<string, unknown> | null; children: unknown[] };
  const text = (node: unknown): string => {
    if (node == null || typeof node === 'boolean') return '';
    if (Array.isArray(node)) return node.map(text).join('');
    if (typeof node !== 'object') return String(node);
    const el = node as El;
    if (typeof el.type === 'function') return text((el.type as (p: unknown) => unknown)({ ...el.props, children: el.children }));
    return text(el.children);
  };
  assert.match(text(registered[0].render()), /读取中/);
  const forWorld = (plugin as unknown as { __test: (worldId: string) => { Activity: unknown; Diary: unknown; Qq: unknown; View: unknown; loadSnapshot: () => Promise<unknown>; renderPersona: (p: Record<string, string>) => string } }).__test;
  const tested = forWorld('fish');
  assert.doesNotThrow(() => text(react.createElement(tested.Activity, { days: ['2026-10-23'], zone: 'Asia/Tokyo', tick: 1 })));
  assert.match(text(react.createElement(tested.Activity, { days: [], zone: 'UTC', tick: 0 })), /还没有活动记录/);
  assert.doesNotThrow(() => text(react.createElement(tested.Diary, { dates: ['2026-10-23'] })));
  assert.match(text(react.createElement(tested.Diary, { dates: [] })), /还没有日记/);
  const respond = (status: number, json: () => Promise<unknown>) => { reply = async () => ({ ok: status >= 200 && status < 300, status, json }); };
  const load = tested.loadSnapshot;
  respond(404, async () => ({ error: 'not found' })); assert.equal(await load(), null);
  respond(200, async () => { throw new SyntaxError('Unexpected token <'); }); assert.equal(await load(), null, 'a non-JSON page counts as off');
  respond(200, async () => ({ worldId: 'fish' })); assert.equal(await load(), null, 'a snapshot without life counts as off');
  respond(200, async () => ({ worldId: 'fish', life: 'on' })); assert.equal(await load(), null);
  respond(500, async () => ({ error: 'internal error' })); await assert.rejects(load(), /internal error/);
  const degraded = { worldId: 'fish', timeZone: 'UTC', now: '2026-10-23T00:00:00.000Z', life: null, health: ['生活线没能启动：life.json is not valid JSON'], memory: { turns: 0, windowTurns: 200, approxTokens: 0, records: 1, sessions: 1 }, compactions: [], diaryDates: [], activityDays: [] };
  respond(200, async () => degraded); assert.equal(((await load()) as { life: unknown }).life, null);
  await forWorld('tata').loadSnapshot();
  assert.deepEqual(fetched.slice(-2), ['/dsh-world/worlds/fish/console/snapshot', '/dsh-world/worlds/tata/console/snapshot']);
  const shown = text(react.createElement(tested.View, { snap: degraded, error: null, tick: 0, refresh: () => {} }));
  assert.match(shown, /生活线没能启动：life\.json is not valid JSON/); assert.match(shown, /1 条/); assert.doesNotMatch(shown, /生活线未开启/);
  assert.doesNotMatch(shown, /工作区权限/, 'old snapshots omit the workspace permission card');
  const permissions = text(react.createElement(tested.View, { snap: { ...degraded, workspace: { defaultPermission: 'custom-read-only', options: [{ value: 'custom-read-only', name: '我的只读权限' }] } }, error: null, tick: 0, refresh: () => {} }));
  assert.match(permissions, /工作区权限/); assert.match(permissions, /我的只读权限/);
  assert.doesNotThrow(() => text(react.createElement(tested.View, { snap: { worldId: 'fish', timeZone: 'UTC', life: null }, error: null, tick: 0, refresh: () => {} })), 'missing sections never crash the view');
  const fresh = text(react.createElement(tested.View, { snap: { ...degraded, health: [], running: false, name: 'TA' }, error: null, tick: 0, refresh: () => {} }));
  assert.match(fresh, /她的世界/); assert.match(fresh, /她还没有住进来/); assert.match(fresh, /开始/);
  const running = text(react.createElement(tested.View, { snap: { ...degraded, health: [], running: true, name: '小鱼', life: { homeSessionId: 'session-abcdef12', status: 'idle', alarm: { at: '2026-10-23T01:00:00.000Z', source: 'plan', note: '看书' }, recentWakes: [] } }, error: null, tick: 0, refresh: () => {} }));
  assert.match(running, /小鱼的世界/); assert.match(running, /运行中/); assert.match(running, /停止/); assert.match(running, /看书/); assert.doesNotMatch(running, /还没有住进来/);
  const pendingScope = text(react.createElement(tested.View, { snap: { ...degraded, memory: { ...degraded.memory, archiveScope: 'home', selectedArchiveScope: 'workspace', restartRequired: true } }, error: null, tick: 0, refresh: () => {} }));
  assert.match(pendingScope, /当前归档：仅家会话/);
  assert.match(pendingScope, /家所在工作区/);
  assert.match(pendingScope, /请重启 DSH/);
  assert.doesNotMatch(pendingScope, /所有会话/);
  for (const persona of [{ 名字: '小鱼', 她是谁: '一条鱼。', 性格: '嘴硬', 说话方式: '', 愿景: '自由', 补充: '别复述' }, { 名字: '', 她是谁: '', 性格: '', 说话方式: '短句', 愿景: '', 补充: '' }]) {
    assert.equal(tested.renderPersona(persona), renderPersona(persona), 'the console previews exactly what she reads');
  }
  // QQ 卡：外面那个 qq-bridge 拆掉以后，这张卡只剩她自己那条原生通道 —— 状态、两个勾、SnowLuma 的门。
  const native = { connected: true, url: 'ws://127.0.0.1:3003', conversations: 2, sent: 3, failed: 0, blocked: 2, autoReply: true, lastError: null };
  const card = text(react.createElement(tested.Qq, { native }));
  assert.match(card, /她自己连着 ws:\/\/127\.0\.0\.1:3003/);
  assert.match(card, /收 2 个会话 · 发 3 条 · 挡下 2 · 会自己回/);
  assert.match(card, /打开 SnowLuma 控制台/);
  assert.doesNotMatch(card, /QQ Bridge/, '那扇门跟着桥一起没了，界面上别再留一个点了就出错的按钮');
  assert.doesNotMatch(card, /巡检|桥在跑|拉起桥|停桥/, '桥的那几行不该再出现');
  const muted = text(react.createElement(tested.Qq, { native: { ...native, autoReply: false, blocked: 0 } }));
  assert.match(muted, /只看不回/);
  assert.doesNotMatch(muted, /挡下/, '没被挡过就别写这个数');
  const offline = text(react.createElement(tested.Qq, { native: { ...native, connected: false, lastError: 'WS 错误：Unexpected server response: 401' } }));
  assert.match(offline, /她自己的通道没连上/);
  assert.match(offline, /401/);
  const nothing = text(react.createElement(tested.Qq, { native: null }));
  assert.match(nothing, /她自己的通道：没开/);
  assert.doesNotMatch(nothing, /收 0 个会话/, '没开的时候不该画一行零');
});

test('WeChat and QQ controls open on separate pages and stay out of the overview', async () => {
  type El = { type: unknown; props: Record<string, any> | null; children: unknown[] };
  const states: unknown[] = [];
  let at = 0;
  const react = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
    useState(init: unknown) {
      const index = at++;
      if (!(index in states)) states[index] = init;
      return [states[index], (value: unknown) => { states[index] = value; }];
    },
    useEffect() {}, useRef: () => ({ current: null }),
  };
  let loaded: { factory: (require: (name: string) => unknown) => { __test: (worldId: string) => Record<string, any> } } | undefined;
  runInNewContext(await readFile('client/index.js', 'utf8'), { window: { __ModuleLoader__: { load: (entry: typeof loaded) => { loaded = entry; } } } });
  const ui = loaded!.factory(() => react).__test('fish');
  const nodes = (node: unknown): El[] => {
    if (Array.isArray(node)) return node.flatMap(nodes);
    if (!node || typeof node !== 'object') return [];
    const element = node as El;
    return [element, ...element.children.flatMap(nodes)];
  };
  const text = (node: unknown): string => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text((node as El).children) : node == null || typeof node === 'boolean' ? '' : String(node);
  const snap = { running: true, worldId: 'test', timeZone: 'UTC', now: '2026-10-29T00:00:00Z', life: null, memory: {}, health: [], wechat: { accountId: 'bot' }, native: { connected: true } };
  const refresh = () => {};
  const render = () => { at = 0; return nodes(ui.View({ snap, refresh })); };
  const open = (label: string) => {
    const button = render().find(node => node.type === 'button' && text(node) === label);
    assert.ok(button, `missing ${label} page`);
    button.props!.onClick();
    return render();
  };
  const overview = nodes(ui.Overview({ snap, refresh }));
  assert.ok(!overview.some(node => node.type === ui.Wechat || node.type === ui.Qq));
  const wechat = open('微信').find(node => node.type === ui.Wechat);
  assert.ok(wechat);
  assert.equal(wechat.props!.wechat, snap.wechat);
  assert.equal(wechat.props!.zone, snap.timeZone);
  assert.equal(wechat.props!.onSaved, refresh);
  const qq = open('QQ').find(node => node.type === ui.Qq);
  assert.ok(qq);
  assert.equal(qq.props!.native, snap.native);
  qq.props!.onNeedPassword('snowluma');
  assert.ok(render().some(node => node.type === ui.Panel && node.props!.kind === 'snowluma'));
  const stopped = { ...snap, running: false, wechat: null, native: null };
  at = 0;
  states[0] = 'wechat';
  assert.match(text(ui.View({ snap: stopped, refresh })), /微信.*未开启/);
  at = 0;
  states[0] = 'qq';
  assert.match(text(ui.View({ snap: stopped, refresh })), /QQ.*未开启/);
});

test('workspace permissions render host options, preserve dirty drafts on polls and save the selected value with errors shown', async () => {
  type El = { type: unknown; props: Record<string, any> | null; children: unknown[] };
  const states: unknown[] = [], effectDeps: unknown[][] = [];
  let at = 0, effectAt = 0, changed = false;
  let pending: (() => void)[] = [];
  const react = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
    useState(init: unknown) {
      const index = at++;
      if (!(index in states)) states[index] = typeof init === 'function' ? (init as () => unknown)() : init;
      return [states[index], (value: unknown) => {
        const next = typeof value === 'function' ? (value as (old: unknown) => unknown)(states[index]) : value;
        if (!Object.is(next, states[index])) { states[index] = next; changed = true; }
      }];
    },
    useEffect(effect: () => void, deps: unknown[]) {
      const index = effectAt++, previous = effectDeps[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous[i]))) { effectDeps[index] = deps; pending.push(effect); }
    },
  };
  let loaded: { factory: (require: (name: string) => unknown) => { __test: (worldId: string) => { WorkspacePermission: (props: unknown) => unknown } } } | undefined;
  const requests: { url: string; options: any }[] = [];
  let error: string | undefined, refreshed = 0;
  runInNewContext(await readFile('client/index.js', 'utf8'), {
    fetch: async (url: string, options: unknown) => { requests.push({ url, options }); return { ok: !error, status: error ? 400 : 200, json: async () => error ? { error } : { ok: true } }; },
    window: { __ModuleLoader__: { load: (entry: typeof loaded) => { loaded = entry; } } },
  });
  const component = loaded!.factory(() => react).__test('fish').WorkspacePermission;
  assert.equal(typeof component, 'function');
  const options = [{ value: 'custom-read-only', name: '我的只读', description: '可读取工作区' }, { value: 'workspace-write', name: '工作区写入' }, { value: 'danger-full-access', name: '全部权限' }];
  let workspace: { defaultPermission: string; options: typeof options } | null = { defaultPermission: 'custom-read-only', options };
  const expand = (value: unknown): El[] => {
    if (value == null || typeof value !== 'object') return [];
    if (Array.isArray(value)) return value.flatMap(expand);
    const el = value as El;
    if (typeof el.type === 'function') return expand(el.type({ ...el.props, children: el.children }));
    return [el, ...el.children.flatMap(expand)];
  };
  const text = (value: unknown): string => {
    if (value == null || typeof value === 'boolean') return '';
    if (Array.isArray(value)) return value.map(text).join('');
    if (typeof value !== 'object') return String(value);
    return text((value as El).children);
  };
  let tree: El[] = [];
  const render = () => {
    do {
      changed = false; at = 0; effectAt = 0; pending = [];
      tree = expand(component({ workspace, onSaved: () => { refreshed++; } }));
      for (const effect of pending) effect();
    } while (changed);
    return tree;
  };
  const select = () => tree.find(el => el.type === 'select')!;
  const button = () => tree.find(el => el.type === 'button')!;
  render();
  assert.match(text(tree), /仅用于此工作区新建的会话；已有会话保留各自的权限。/);
  assert.equal(select().props!['aria-label'], '新建会话默认权限');
  assert.equal(select().props!.value, 'custom-read-only');
  assert.deepEqual(tree.filter(el => el.type === 'option').map(el => [el.props!.value, text(el)]), [['custom-read-only', '我的只读'], ['workspace-write', '工作区写入'], ['danger-full-access', '全部权限']]);
  assert.match(text(tree), /可读取工作区/);
  workspace = { ...workspace!, defaultPermission: 'danger-full-access' }; render();
  assert.equal(select().props!.value, 'danger-full-access', 'a clean draft follows updated snapshot props');
  select().props!.onChange({ target: { value: 'workspace-write' } }); render();
  workspace = { ...workspace, defaultPermission: 'custom-read-only' }; render();
  assert.equal(select().props!.value, 'workspace-write', 'polls do not overwrite an unsaved selection');
  button().props!.onClick(); await new Promise(setImmediate); render();
  assert.equal(requests.length, 1); assert.equal(requests[0].url, '/dsh-world/worlds/fish/console/workspace-permission');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers['x-dsh-world'], '1');
  assert.equal(requests[0].options.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(requests[0].options.body), { permission: 'workspace-write' });
  assert.equal(refreshed, 1); assert.match(text(tree), /已保存/); assert.doesNotMatch(text(tree), /重启/);
  workspace = { ...workspace, defaultPermission: 'workspace-write' }; render();
  select().props!.onChange({ target: { value: 'custom-read-only' } }); render();
  error = '未知工作区权限：custom-read-only';
  button().props!.onClick(); await new Promise(setImmediate); render();
  assert.match(text(tree), /保存失败：未知工作区权限：custom-read-only/);
  assert.equal(refreshed, 1); assert.equal(select().props!.value, 'custom-read-only');
  workspace = null; render(); assert.deepEqual(tree, []);
});

test('home apply submits only the explicit action and shows backend progress and failures', async () => {
  type El = { type: unknown; props: Record<string, any> | null; children: unknown[] };
  const states: unknown[] = [];
  let at = 0, refreshed = 0, error = '';
  const requests: { url: string; options: any }[] = [];
  const react = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
    useState(init: unknown) { const index = at++; if (!(index in states)) states[index] = init; return [states[index], (value: unknown) => { states[index] = value; }]; },
  };
  let loaded: { factory: (require: (name: string) => unknown) => { __test: (worldId: string) => { HomeApply: (props: unknown) => unknown } } } | undefined;
  runInNewContext(await readFile('client/index.js', 'utf8'), {
    window: { __ModuleLoader__: { load: (entry: typeof loaded) => { loaded = entry; } } },
    fetch: async (url: string, options: unknown) => { requests.push({ url, options }); return { ok: !error, status: error ? 400 : 200, json: async () => error ? { error } : { ok: true } }; },
  });
  const component = loaded!.factory(() => react).__test('fish').HomeApply;
  const expand = (value: unknown): El[] => {
    if (Array.isArray(value)) return value.flatMap(expand);
    if (!value || typeof value !== 'object') return [];
    const el = value as El;
    return typeof el.type === 'function' ? expand(el.type({ ...el.props, children: el.children })) : [el, ...el.children.flatMap(expand)];
  };
  const text = (value: unknown): string => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text((value as El).children) : value == null || typeof value === 'boolean' ? '' : String(value);
  let snap = { running: true, life: {}, homeApply: { status: 'idle', message: '' } };
  let tree: El[] = [];
  const render = () => { at = 0; tree = expand(component({ snap, refresh: () => { refreshed++; } })); };
  const button = () => tree.find(el => el.type === 'button')!;
  render(); assert.equal(requests.length, 0); assert.equal(button().props!.disabled, false);
  assert.match(text(tree), /保存的提示词会在下一轮对话生效/);
  button().props!.onClick(); render(); assert.equal(button().props!.disabled, true);
  await new Promise(setImmediate); render();
  assert.equal(refreshed, 1); assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/dsh-world/worlds/fish/console/apply-home'); assert.equal(requests[0].options.headers['x-dsh-world'], '1');
  assert.deepEqual(JSON.parse(requests[0].options.body), {}, 'the action does not save drafts');
  for (const status of ['waiting', 'compacting']) { snap = { ...snap, homeApply: { status, message: '' } }; render(); assert.equal(button().props!.disabled, true); }
  snap = { ...snap, homeApply: { status: 'failed', message: '应用并压缩失败：summary unavailable' } }; render();
  assert.equal(button().props!.disabled, false); assert.match(text(tree), /summary unavailable/);
  error = '未加载压缩服务'; button().props!.onClick(); await new Promise(setImmediate); render();
  assert.match(text(tree), /未加载压缩服务/); assert.equal(refreshed, 1);
  snap = { ...snap, running: false }; render(); assert.equal(button().props!.disabled, true);
});

test('the compact-after-review switch saves at once, says what it does and shows a refusal', async () => {
  type El = { type: unknown; props: Record<string, any> | null; children: unknown[] };
  const states: unknown[] = [];
  let at = 0, refreshed = 0, error = '';
  const requests: { url: string; options: any }[] = [];
  const react = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
    useState(init: unknown) { const index = at++; if (!(index in states)) states[index] = init; return [states[index], (value: unknown) => { states[index] = value; }]; },
  };
  let loaded: { factory: (require: (name: string) => unknown) => { __test: (worldId: string) => { CompactAfterReview: (props: unknown) => unknown } } } | undefined;
  runInNewContext(await readFile('client/index.js', 'utf8'), {
    window: { __ModuleLoader__: { load: (entry: typeof loaded) => { loaded = entry; } } },
    fetch: async (url: string, options: unknown) => { requests.push({ url, options }); return { ok: !error, status: error ? 400 : 200, json: async () => error ? { error } : { ok: true } }; },
  });
  const component = loaded!.factory(() => react).__test('fish').CompactAfterReview;
  const expand = (value: unknown): El[] => {
    if (Array.isArray(value)) return value.flatMap(expand);
    if (!value || typeof value !== 'object') return [];
    const el = value as El;
    return typeof el.type === 'function' ? expand(el.type({ ...el.props, children: el.children })) : [el, ...el.children.flatMap(expand)];
  };
  const text = (value: unknown): string => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text((value as El).children) : value == null || typeof value === 'boolean' ? '' : String(value);
  let on = false, tree: El[] = [];
  const render = () => { at = 0; tree = expand(component({ on, onSaved: () => { refreshed++; } })); };
  const box = () => tree.find(el => el.type === 'input')!;
  render();
  assert.equal(box().props!.checked, false); assert.match(text(tree), /自动压缩一次家会话[\s\S]*我是谁.*下一轮对话生效/); assert.match(text(tree), /已关闭/);
  box().props!.onChange({ target: { checked: true } }); render(); assert.equal(box().props!.disabled, true, 'busy while saving');
  await new Promise(setImmediate); render();
  assert.equal(requests.length, 1); assert.equal(requests[0].url, '/dsh-world/worlds/fish/console/compact-after-review');
  assert.equal(requests[0].options.method, 'POST'); assert.equal(requests[0].options.headers['x-dsh-world'], '1');
  assert.deepEqual(JSON.parse(requests[0].options.body), { on: true });
  assert.equal(refreshed, 1); assert.match(text(tree), /已开启/);
  on = true; render(); assert.equal(box().props!.checked, true);
  error = '保存失败'; box().props!.onChange({ target: { checked: false } }); await new Promise(setImmediate); render();
  assert.match(text(tree), /保存失败/); assert.equal(refreshed, 1);
});

test('the schedule card saves the review and morning times, refuses a bad one and empties back to the defaults', async () => {
  type El = { type: unknown; props: Record<string, any> | null; children: unknown[] };
  const states: unknown[] = [];
  let at = 0, refreshed = 0;
  const requests: { url: string; options: any }[] = [];
  const react = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
    useState(init: unknown) { const index = at++; if (!(index in states)) states[index] = init; return [states[index], (value: unknown) => { states[index] = value; }]; },
  };
  let loaded: { factory: (require: (name: string) => unknown) => { __test: (worldId: string) => { Schedule: (props: unknown) => unknown } } } | undefined;
  runInNewContext(await readFile('client/index.js', 'utf8'), {
    window: { __ModuleLoader__: { load: (entry: typeof loaded) => { loaded = entry; } } },
    fetch: async (url: string, options: unknown) => { requests.push({ url, options }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; },
  });
  const component = loaded!.factory(() => react).__test('fish').Schedule;
  const expand = (value: unknown): El[] => {
    if (Array.isArray(value)) return value.flatMap(expand);
    if (!value || typeof value !== 'object') return [];
    const el = value as El;
    return typeof el.type === 'function' ? expand(el.type({ ...el.props, children: el.children })) : [el, ...el.children.flatMap(expand)];
  };
  const text = (value: unknown): string => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text((value as El).children) : value == null || typeof value === 'boolean' ? '' : String(value);
  const schedule = { review: '23:00', wake: '08:00', defaults: { review: '23:00', wake: '08:00' } };
  let tree: El[] = [];
  const render = () => { at = 0; tree = expand(component({ schedule, onSaved: () => { refreshed++; } })); };
  const input = (label: string) => tree.find(el => el.type === 'input' && el.props!['aria-label'] === label)!;
  const save = async () => { tree.find(el => el.type === 'button')!.props!.onClick(); await new Promise(setImmediate); render(); };
  render();
  assert.equal(input('每日回顾时间').props!.value, '23:00'); assert.equal(input('早上醒来时间').props!.value, '08:00');
  assert.match(text(tree), /回顾 23:00，早上 08:00/);
  input('每日回顾时间').props!.onChange({ target: { value: '00:30' } }); input('早上醒来时间').props!.onChange({ target: { value: '7:00' } }); render();
  await save();
  assert.equal(requests.length, 0); assert.match(text(tree), /HH:MM/);
  input('早上醒来时间').props!.onChange({ target: { value: '07:00' } }); render();
  await save();
  assert.equal(requests.at(-1)!.url, '/dsh-world/worlds/fish/console/schedule');
  assert.deepEqual(JSON.parse(requests.at(-1)!.options.body), { review: '00:30', wake: '07:00' });
  assert.equal(refreshed, 1); assert.match(text(tree), /已保存/);
  input('每日回顾时间').props!.onChange({ target: { value: '' } }); render();
  await save();
  assert.deepEqual(JSON.parse(requests.at(-1)!.options.body), { review: null, wake: '07:00' });
  assert.equal(input('每日回顾时间').props!.value, '23:00', 'empty goes back to the default and shows it');
});

test('the memory card saves the cold-session hours, refuses a bad one and empties back to 24 (#36)', async () => {
  type El = { type: unknown; props: Record<string, any> | null; children: unknown[] };
  const states: unknown[] = [];
  let at = 0, refreshed = 0;
  const requests: { url: string; options: any }[] = [];
  const react = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
    useState(init: unknown) { const index = at++; if (!(index in states)) states[index] = init; return [states[index], (value: unknown) => { states[index] = value; }]; },
  };
  let loaded: { factory: (require: (name: string) => unknown) => { __test: (worldId: string) => { Memory: (props: unknown) => unknown } } } | undefined;
  runInNewContext(await readFile('client/index.js', 'utf8'), {
    window: { __ModuleLoader__: { load: (entry: typeof loaded) => { loaded = entry; } } },
    fetch: async (url: string, options: unknown) => { requests.push({ url, options }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; },
  });
  const component = loaded!.factory(() => react).__test('fish').Memory;
  const expand = (value: unknown): El[] => {
    if (Array.isArray(value)) return value.flatMap(expand);
    if (!value || typeof value !== 'object') return [];
    const el = value as El;
    return typeof el.type === 'function' ? expand(el.type({ ...el.props, children: el.children })) : [el, ...el.children.flatMap(expand)];
  };
  const text = (value: unknown): string => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text((value as El).children) : value == null || typeof value === 'boolean' ? '' : String(value);
  const mem = { turns: 3, windowTurns: 200, coldHours: 24, archiveScope: 'workspace', selectedArchiveScope: 'workspace', approxTokens: 10, records: 3, sessions: 1 };
  let tree: El[] = [];
  const render = () => { at = 0; tree = expand(component({ mem, onSaved: () => { refreshed++; } })); };
  const label = '久未开口后重新读取（小时）';
  const input = () => tree.find(el => el.type === 'input' && el.props!['aria-label'] === label)!;
  const save = async () => { const inputs = tree.filter(el => el.type === 'input' || el.type === 'button'); inputs[inputs.indexOf(input()) + 1]!.props!.onClick(); await new Promise(setImmediate); render(); };
  render();
  assert.equal(input().props!.value, '24');
  assert.match(text(tree), /隔这么久再开口，就重新读一遍记忆块/);
  input().props!.onChange({ target: { value: '0' } }); render();
  await save();
  assert.equal(requests.length, 0); assert.match(text(tree), /1 到 720/);
  input().props!.onChange({ target: { value: '12' } }); render();
  await save();
  assert.equal(requests.at(-1)!.url, '/dsh-world/worlds/fish/console/memory');
  assert.deepEqual(JSON.parse(requests.at(-1)!.options.body), { coldHours: 12 }, 'only the hours are sent, the turns stay as they are');
  assert.equal(refreshed, 1); assert.match(text(tree), /已保存/);
  input().props!.onChange({ target: { value: '' } }); render();
  await save();
  assert.deepEqual(JSON.parse(requests.at(-1)!.options.body), { coldHours: null });
  assert.equal(input().props!.value, '24', 'empty goes back to the default and shows it');
});
test('album shows metadata first, loads one selected image and paginates with the backend shape', async () => {
  type El = { type: unknown; props: Record<string, any> | null; children: unknown[] };
  const states: any[] = [], effects: { deps: unknown[] }[] = []; let at = 0, effectAt = 0;
  const calls: string[] = [];
  const react = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
    useState(init: unknown) { const index = at++; if (!(index in states)) states[index] = init; return [states[index], (value: unknown) => { states[index] = value; }]; },
    useEffect(effect: () => unknown, deps: unknown[]) { const index = effectAt++; if (!effects[index] || deps.some((value, i) => value !== effects[index].deps[i])) { effects[index] = { deps }; effect(); } },
  };
  let loaded: { factory: (require: (name: string) => unknown) => { __test: (worldId: string) => { PhotoAlbum: (props: unknown) => unknown } } } | undefined;
  runInNewContext(await readFile('client/index.js', 'utf8'), {
    window: { __ModuleLoader__: { load: (entry: typeof loaded) => { loaded = entry; } } },
    fetch: async (url: string) => { calls.push(url); return { ok: true, json: async () => ({ photos: [{ id: 'photo-1', description: '窗边', width: 2, height: 2, savedAt: '2026-10-29T00:00:00Z', tags: ['家'] }], total: 13, hasMore: true }) }; },
  });
  const component = loaded!.factory(() => react).__test('fish').PhotoAlbum;
  const expand = (value: unknown): El[] => {
    if (Array.isArray(value)) return value.flatMap(expand);
    if (!value || typeof value !== 'object') return [];
    const el = value as El;
    return typeof el.type === 'function' ? expand(el.type({ ...el.props, children: el.children })) : [el, ...el.children.flatMap(expand)];
  };
  const text = (value: unknown): string => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text((value as El).children) : value == null || typeof value === 'boolean' ? '' : String(value);
  let tree: El[] = [];
  const render = () => { at = 0; effectAt = 0; tree = expand(component({ zone: 'UTC', tick: 0 })); };
  render(); await new Promise(setImmediate); render();
  assert.match(calls[0], /photos\?limit=12&offset=0/); assert.match(text(tree), /窗边/);
  assert.equal(tree.some(el => el.type === 'img'), false);
  tree.find(el => el.type === 'button' && text(el) === '查看照片')!.props!.onClick(); render();
  assert.equal(tree.find(el => el.type === 'img')!.props!.src, '/dsh-world/worlds/fish/console/photo?id=photo-1');
  tree.find(el => el.type === 'button' && text(el) === '下一页')!.props!.onClick(); render();
  assert.match(calls.at(-1)!, /offset=12/); assert.equal(tree.some(el => el.type === 'img'), false);
});

test('the module switches say what is on, what is off and what the config does not provide', async () => {
  const source = await readFile('client/index.js', 'utf8');
  let loaded: { factory: (require: (name: string) => unknown) => { __test: (worldId: string) => { Modules: unknown } } } | undefined;
  const react = { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }), useState: (value: unknown) => [value, () => {}], useEffect: () => {}, useRef: (current: unknown) => ({ current }) };
  runInNewContext(source, { fetch: () => Promise.reject(new Error('no fetch')), window: { __ModuleLoader__: { load: (entry: typeof loaded) => { loaded = entry; } } } });
  const { Modules } = loaded!.factory(() => react).__test('fish');
  type El = { type: unknown; props: Record<string, unknown> | null; children: unknown[] };
  const text = (node: unknown): string => {
    if (node == null || typeof node === 'boolean') return '';
    if (Array.isArray(node)) return node.map(text).join('');
    if (typeof node !== 'object') return String(node);
    const el = node as El;
    if (typeof el.type === 'function') return text((el.type as (p: unknown) => unknown)({ ...el.props, children: el.children }));
    return text(el.children);
  };
  const render = (modules: unknown, running = true) => text(react.createElement(Modules, { modules, running }));
  const on = render({ wechat: { available: true, enabled: true, running: true }, qq: { available: false, enabled: true, running: false } });
  assert.match(on, /微信 · 运行中/); assert.match(on, /wechat_send/); assert.match(on, /QQ · 未配置/);
  const off = render({ wechat: { available: true, enabled: false, running: false }, qq: { available: true, enabled: false, running: false } });
  assert.match(off, /微信 · 已关闭/); assert.match(off, /QQ · 已关闭/); assert.match(off, /工具未注册/);
  assert.match(render({ wechat: { available: true, enabled: true, running: false }, qq: { available: true, enabled: true, running: false } }, false), /已开启，世界启动后生效/);
});

test('the archive tab builds its query in the configured zone, drops a late answer to an old query and keeps the error code', async () => {
  const source = await readFile('client/index.js', 'utf8');
  type Plugin = { __test: (worldId: string) => Record<string, (...args: never[]) => unknown> };
  let loaded: { factory: (require: (name: string) => unknown) => Plugin } | undefined;
  const react = { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }), useState: (value: unknown) => [typeof value === 'function' ? (value as () => unknown)() : value, () => {}], useEffect: () => {}, useRef: (current: unknown) => ({ current }) };
  const replies: { resolve: (value: unknown) => void; url: string }[] = [];
  runInNewContext(source, { fetch: (url: string) => new Promise(resolve => { replies.push({ url, resolve: (value: unknown) => resolve(value) }); }), window: { __ModuleLoader__: { load: (entry: typeof loaded) => { loaded = entry; } } } });
  const t = loaded!.factory(() => react).__test('fish') as unknown as { memoryQuery: (f: object, zone: string, cursor?: string) => string; dayStartIso: (d: string, z: string, plus?: number) => string; latest: () => { next(): number; current(id: number): boolean }; searchMemory: (guard: unknown, path: string, query: string, done: (b: unknown) => void, fail: (e: Error & { code?: string }) => void) => Promise<void>; MemorySearch: unknown };
  assert.equal(t.dayStartIso('2026-10-23', 'Asia/Seoul'), '2026-10-22T15:00:00.000Z');
  assert.equal(t.dayStartIso('2026-10-23', 'America/New_York'), '2026-10-23T04:00:00.000Z', 'daylight time');
  const filters = { query: '潮汐', kinds: ['diary', 'self'], from: '2026-10-23', to: '2026-10-23', sourceId: 'self', turnId: '', linkedTo: '', order: 'oldest' };
  const query = new URLSearchParams(t.memoryQuery(filters, 'Asia/Seoul', 'CUR'));
  assert.deepEqual(Object.fromEntries(query), { query: '潮汐', kinds: 'diary,self', from: '2026-10-22T15:00:00.000Z', to: '2026-10-23T15:00:00.000Z', sourceId: 'self', order: 'oldest', limit: '20', cursor: 'CUR' });
  assert.equal(new URLSearchParams(t.memoryQuery({ query: '', kinds: [], order: 'newest' }, 'UTC')).toString(), 'limit=20');

  const guard = t.latest(); const seen: string[] = [];
  const first = t.searchMemory(guard, 'memory/find', 'query=old', b => seen.push('old:' + JSON.stringify(b)), e => seen.push('old-error:' + e.message));
  const second = t.searchMemory(guard, 'memory/find', 'query=new', b => seen.push('new:' + JSON.stringify(b)), e => seen.push('new-error:' + e.message));
  assert.deepEqual(replies.map(reply => reply.url), ['/dsh-world/worlds/fish/console/memory/find?query=old', '/dsh-world/worlds/fish/console/memory/find?query=new']);
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  replies[1]!.resolve(ok({ items: ['n'] })); await second;
  replies[0]!.resolve(ok({ items: ['o'] })); await first;
  assert.deepEqual(seen, ['new:{"items":["n"]}'], 'the old query answered last and was dropped');
  let failure: (Error & { code?: string }) | undefined;
  const third = t.searchMemory(guard, 'memory/find', 'cursor=x', () => {}, e => { failure = e; });
  replies[2]!.resolve({ ok: false, status: 409, json: async () => ({ error: '资料变了', code: 'cursorExpired' }) }); await third;
  assert.equal(failure?.code, 'cursorExpired'); assert.equal(typeof t.MemorySearch, 'function');
  assert.doesNotThrow(() => (t.MemorySearch as unknown as (props: object) => unknown)({ zone: 'UTC' }));
  const stale = t.searchMemory(guard, 'memory/read', 'ref=a', b => seen.push('read:' + JSON.stringify(b)), () => {});
  guard.next(); // the filters changed while it was in flight
  replies[3]!.resolve(ok({ content: 'x' })); await stale;
  assert.ok(!seen.some(entry => entry.startsWith('read:')));
});
