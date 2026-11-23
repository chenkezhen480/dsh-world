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
  // A first install: nothing allowed in the config and no browser found (a Mac); the switches are still there to say so.
  const nothing = { available: false, enabled: false, running: false };
  const fresh = nodes(ui.Overview({ snap: { ...snap, modules: { wechat: nothing, qq: nothing, computer: { ...nothing, reason: '这台电脑上找不到 Edge 或 Chrome' }, desktop: { ...nothing, reason: '她用电脑目前只支持 Windows。' }, cottage: nothing, foreground: nothing } }, refresh }));
  assert.ok(fresh.some(node => node.type === ui.Modules), 'the 接入 card is shown with nothing configured');
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
  // Her computer page: the browser card, and below it the inbox settings, even before her use of the computer is on.
  const inbox = { ignore: ['conhost'], custom: false, told: [] };
  const modules = { wechat: nothing, qq: nothing, computer: nothing, desktop: { available: true, enabled: false, running: false, inbox }, cottage: nothing, foreground: nothing };
  at = 0;
  states[0] = 'computer';
  const page = nodes(ui.View({ snap: { ...stopped, modules }, refresh }));
  assert.ok(page.some(node => node.type === 'button' && text(node) === '她的电脑'), 'the tab is named for the whole computer');
  const card = page.find(node => node.type === ui.Inbox);
  assert.ok(card, 'the inbox settings live on her computer page');
  assert.deepEqual([card.props!.inbox, card.props!.listening, card.props!.onSaved], [inbox, false, refresh]);
  at = 0;
  assert.ok(!nodes(ui.View({ snap: { ...stopped, modules: { ...modules, desktop: { ...modules.desktop, available: false, reason: '她用电脑目前只支持 Windows。' } } }, refresh })).some(node => node.type === ui.Inbox), 'no inbox where she cannot use the computer');
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
  assert.match(text(tree), /压缩一次，换上保存的内容/);
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
  assert.equal(box().props!.checked, false); assert.match(text(tree), /自动压缩一次家会话，换上她刚改写的「我」/); assert.match(text(tree), /已关闭/);
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
  // `life: false` in the config: the card is still there, with nothing to press and what to change to get it.
  states.length = 0; at = 0;
  tree = expand(component({ schedule: { ...schedule, life: false } }));
  assert.deepEqual([input('每日回顾时间').props!.disabled, input('早上醒来时间').props!.disabled, tree.find(el => el.type === 'button')!.props!.disabled], [true, true, true]);
  assert.match(text(tree), /配置里写了 life: false[^]*重启 DSH 后这里就能改/);
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

test('today\'s spend lists three conversations a page, newest first', async () => {
  type El = { type: unknown; props: Record<string, any> | null; children: unknown[] };
  const states: unknown[] = []; let at = 0;
  const react = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
    useState(init: unknown) { const index = at++; if (!(index in states)) states[index] = init; return [states[index], (value: unknown) => { states[index] = value; }]; },
  };
  let loaded: { factory: (require: (name: string) => unknown) => { __test: (worldId: string) => { Budget: (props: unknown) => unknown } } } | undefined;
  runInNewContext(await readFile('client/index.js', 'utf8'), { window: { __ModuleLoader__: { load: (entry: typeof loaded) => { loaded = entry; } } } });
  const component = loaded!.factory(() => react).__test('fish').Budget;
  const expand = (value: unknown): El[] => {
    if (Array.isArray(value)) return value.flatMap(expand);
    if (!value || typeof value !== 'object') return [];
    const el = value as El;
    return typeof el.type === 'function' ? expand(el.type({ ...el.props, children: el.children })) : [el, ...el.children.flatMap(expand)];
  };
  const text = (value: unknown): string => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text((value as El).children) : value == null || typeof value === 'boolean' ? '' : String(value);
  const turns = Array.from({ length: 8 }, (_, n) => ({ at: `2026-11-18T0${n}:00:00Z`, trigger: `第${n + 1}次`, steps: 1, yuan: 0.1, hit: 0, miss: 0, out: 0, tools: {}, ended: true }));
  let tree: El[] = [];
  const render = (list = turns) => { at = 0; tree = expand(component({ zone: 'UTC', budget: { daily: null, today: { yuan: 0.8, turns: list } } })); };
  const shown = () => tree.filter(el => el.props?.className === 'dw-turn-what').map(text);
  const button = (label: string) => tree.find(el => el.type === 'button' && text(el) === label)!;
  render();
  assert.deepEqual(shown(), ['第8次', '第7次', '第6次']);
  assert.match(text(tree), /最近 8 次对话[^]*第 1 \/ 3 页/);
  assert.equal(button('上一页').props!.disabled, true);
  button('下一页').props!.onClick(); render(); button('下一页').props!.onClick(); render();
  assert.deepEqual(shown(), ['第2次', '第1次']);
  assert.equal(button('下一页').props!.disabled, true);
  render(turns.slice(0, 2));
  assert.deepEqual(shown(), ['第2次', '第1次'], 'a shorter list (a new day) stays on a page that exists');
  assert.equal(tree.some(el => el.type === 'button' && text(el) === '下一页'), false, 'one page needs no pager');
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
  // Nothing to write in the config: her browser is the console's switch alone, and says what her use of the computer needs.
  assert.match(render({ wechat: { available: true, enabled: true, running: true }, qq: { available: false, enabled: true, running: false }, computer: { available: true, enabled: false, running: false } }), /她的浏览器 · 已关闭开启她没有自己的浏览器。开启后她下一步就能用；她用电脑也要先开这一项。/);
  assert.match(render({ wechat: { available: false, enabled: false, running: false }, qq: { available: false, enabled: false, running: false }, computer: { available: true, enabled: true, running: true } }), /她的浏览器 · 运行中/);
  const elsewhere = render({ wechat: { available: false, enabled: false, running: false }, qq: { available: false, enabled: false, running: false }, computer: { available: true, enabled: true, running: true }, desktop: { available: false, reason: '她用电脑目前只支持 Windows。', enabled: false, running: false } });
  assert.match(elsewhere, /她用电脑 · 这台电脑用不了她用电脑目前只支持 Windows。/, 'not Windows: listed, and why it cannot be used');
  const noBrowser = render({ wechat: { available: false, enabled: false, running: false }, qq: { available: false, enabled: false, running: false }, computer: { available: false, reason: '这台电脑上找不到 Edge 或 Chrome，她的浏览器要用其中一个。', enabled: false, running: false } });
  assert.match(noBrowser, /她的浏览器 · 这台电脑用不了开启这台电脑上找不到 Edge 或 Chrome，她的浏览器要用其中一个。/, 'no browser on this machine: said, not offered as a config line');
  assert.doesNotMatch(elsewhere, /关闭后台前台/);
  const desktop = (d: object, f: object = { available: false, enabled: false, running: false }) => render({ wechat: { available: false, enabled: false, running: false }, qq: { available: false, enabled: false, running: false }, computer: { available: true, enabled: true, running: true }, desktop: d, foreground: f });
  // One row for her use of the computer: off, background or foreground, and what the mode on means.
  assert.match(desktop({ available: true, enabled: false, running: false }), /她用电脑 · 已关闭关闭后台前台她用不了你的电脑。$/);
  assert.match(desktop({ available: true, enabled: true, running: true }), /她用电脑 · 后台模式关闭后台前台后台模式：她每次只看一个窗口的截图[^]*连按两下 Esc/);
  assert.match(desktop({ available: true, enabled: true, running: true }, { available: true, enabled: true, running: true }), /她用电脑 · 前台模式[^]*前台模式：你把电脑交给她[^]*确认一次管理员权限/);
  assert.doesNotMatch(desktop({ available: true, enabled: true, running: true }, { available: true, enabled: true, running: true }), /前台模式 · /, 'no second row for it');
  assert.match(on, /微信 · 运行中/); assert.match(on, /wechat_send/); assert.match(on, /QQ · 未配置关闭配置里还没允许 QQ：[^]*qqNative[^]*重启 DSH 后这里就能开/);
  assert.match(render({ wechat: { available: false, enabled: false, running: false }, qq: { available: true, enabled: false, running: false } }), /微信 · 未配置开启配置里还没允许微信：[^]*wechat: true/, 'not configured: what to write, not what the switch would do');
  assert.match(render({ wechat: { available: false, enabled: false, running: false }, qq: { available: false, enabled: false, running: false }, cottage: { available: false, enabled: false, running: false } }), /她住进小屋 · 未安装开启小屋还没装：先在顶部「小屋」标签里安装/, 'the cottage row is listed before the room is installed');
  const off = render({ wechat: { available: true, enabled: false, running: false }, qq: { available: true, enabled: false, running: false } });
  assert.match(off, /微信 · 已关闭/); assert.match(off, /QQ · 已关闭/); assert.match(off, /工具未注册/);
  assert.match(render({ wechat: { available: true, enabled: true, running: false }, qq: { available: true, enabled: true, running: false } }, false), /已开启，世界启动后生效/);
});

test('her browser card lists what she learned by category, with her note and each last run', async () => {
  const source = await readFile('client/index.js', 'utf8');
  let loaded: { factory: (require: (name: string) => unknown) => { __test: (worldId: string) => { Computer: unknown } } } | undefined;
  const react = { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }), useState: (value: unknown) => [value, () => {}], useEffect: () => {}, useRef: (current: unknown) => ({ current }) };
  runInNewContext(source, { fetch: () => Promise.reject(new Error('no fetch')), window: { __ModuleLoader__: { load: (entry: typeof loaded) => { loaded = entry; } } } });
  const { Computer } = loaded!.factory(() => react).__test('fish');
  type El = { type: unknown; props: Record<string, unknown> | null; children: unknown[] };
  const text = (node: unknown): string => {
    if (node == null || typeof node === 'boolean') return '';
    if (Array.isArray(node)) return node.map(text).join('');
    if (typeof node !== 'object') return String(node);
    const el = node as El;
    if (typeof el.type === 'function') return text((el.type as (p: unknown) => unknown)({ ...el.props, children: el.children }));
    return text(el.children);
  };
  const render = (categories: unknown, desktop: unknown = null) => text(react.createElement(Computer, { zone: 'Asia/Shanghai', computer: { browser: { state: 'stopped', binary: null }, dir: 'D:/w/procedures', categories, desktop } }));
  assert.match(render([]), /她还没有学会的操作/);
  const shown = render([
    { name: 'bilibili', guide: true, operations: [{ name: '看私信', description: '读 B站 私信', onAlarm: true, last: { at: 'x', ok: false, detail: '第 2 步找不到' } }] },
    { name: 'wechat', guide: false, operations: [] },
  ]);
  assert.match(shown, /bilibili · 她写了说明看私信 · 读 B站 私信（闹钟前） · 最近失败：第 2 步找不到/);
  assert.match(shown, /wechat · 还没写说明这一类还没有操作/);
  assert.doesNotMatch(shown, /my_/);
  assert.doesNotMatch(shown, /她用电脑/, 'nothing about the desktop while its switch is off');
  const desktop = render([], { running: true, recent: [{ at: '2026-11-15T12:30:00Z', action: 'click', app: '微信', ok: false }, { at: '2026-11-15T12:29:00Z', action: 'open', app: '微信', ok: true }] });
  assert.match(desktop, /她用电脑 · 驱动运行中20:30 click · 微信 · 没做成20:29 open · 微信/);
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

test('the inbox list on her computer page saves each change at once and offers the names she was told (#61)', async () => {
  type El = { type: unknown; props: Record<string, any> | null; children: unknown[] };
  const states: unknown[] = [];
  let at = 0, refreshed = 0, error = '';
  const requests: { url: string; body: unknown }[] = [];
  const react = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
    useState(init: unknown) { const index = at++; if (!(index in states)) states[index] = init; return [states[index], (value: unknown) => { states[index] = typeof value === 'function' ? (value as (old: unknown) => unknown)(states[index]) : value; }]; },
    useEffect: () => {}, useRef: (current: unknown) => ({ current }),
  };
  let loaded: { factory: (require: (name: string) => unknown) => { __test: (worldId: string) => { Modules: (props: unknown) => unknown; Inbox: (props: unknown) => unknown } } } | undefined;
  runInNewContext(await readFile('client/index.js', 'utf8'), {
    window: { __ModuleLoader__: { load: (entry: typeof loaded) => { loaded = entry; } } },
    fetch: async (url: string, options: { body: string }) => { requests.push({ url, body: JSON.parse(options.body) }); return { ok: !error, status: error ? 400 : 200, json: async () => error ? { error } : { ok: true } }; },
  });
  const { Modules, Inbox } = loaded!.factory(() => react).__test('fish');
  const expand = (value: unknown): El[] => {
    if (Array.isArray(value)) return value.flatMap(expand);
    if (!value || typeof value !== 'object') return [];
    const el = value as El;
    return typeof el.type === 'function' ? expand((el.type as (p: unknown) => unknown)({ ...el.props, children: el.children })) : [el, ...el.children.flatMap(expand)];
  };
  const text = (value: unknown): string => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text((value as El).children) : value == null || typeof value === 'boolean' ? '' : String(value);
  const off = { available: false, enabled: false, running: false };
  let inbox = { ignore: ['conhost', 'msrdc'], custom: false, told: ['远程桌面', 'MSRDC', 'Microsoft Edge'] }, enabled = true, tree: El[] = [];
  const render = () => { at = 0; tree = expand(Inbox({ inbox, listening: enabled, onSaved: () => { refreshed++; } })); };
  const button = (label: string | RegExp) => tree.find(el => el.type === 'button' && (typeof label === 'string' ? text(el) === label : label.test(text(el))))!;
  const settle = async () => { await new Promise(setImmediate); render(); };
  at = 0;
  const switches = text(expand(Modules({ running: true, modules: { wechat: off, qq: off, computer: { available: true, enabled: true, running: true }, desktop: { available: true, enabled: true, running: true, inbox }, foreground: off } })));
  assert.match(switches, /她用电脑 · 后台模式[^]*不理会哪些程序在「她的电脑」页里改/);
  assert.doesNotMatch(switches, /信箱不理会这些程序/, 'the 接入 card keeps the switches only');
  render();
  assert.match(text(tree), /^信箱她用电脑开着时，信箱替她看任务栏/);
  assert.match(text(tree), /信箱不理会这些程序[^]*conhost×msrdc×[^]*最近报过：不再报「远程桌面」不再报「Microsoft Edge」[^]*默认的是 Windows 自己的程序/, 'a told name already left out, in any case, is not offered');
  assert.equal(tree.some(el => el.type === 'button' && text(el) === '恢复默认'), false, 'nothing to go back to while it is the default');
  button('不再报「远程桌面」').props!.onClick(); await settle();
  assert.deepEqual(requests.at(-1), { url: '/dsh-world/worlds/fish/console/inbox-ignore', body: { names: ['conhost', 'msrdc', '远程桌面'] } });
  assert.match(text(tree), /存好了：信箱不再报「远程桌面」/); assert.equal(refreshed, 1);
  inbox = { ignore: ['conhost', 'msrdc', '远程桌面'], custom: true, told: ['远程桌面'] }; render();
  assert.doesNotMatch(text(tree), /最近报过/);
  button('×').props!.onClick(); await settle();
  assert.deepEqual(requests.at(-1)!.body, { names: ['msrdc', '远程桌面'] }, '× takes out that one name');
  tree.find(el => el.type === 'input')!.props!.onChange({ target: { value: ' Mem Reduct ' } }); render();
  tree.find(el => el.type === 'input')!.props!.onKeyDown({ key: 'Enter' }); await settle();
  assert.deepEqual(requests.at(-1)!.body, { names: ['conhost', 'msrdc', '远程桌面', 'Mem Reduct'] });
  assert.equal(tree.find(el => el.type === 'input')!.props!.value, '', 'the box empties once added');
  const before = requests.length;
  tree.find(el => el.type === 'input')!.props!.onChange({ target: { value: 'MSRDC' } }); render();
  button('加上').props!.onClick(); render();
  assert.equal(requests.length, before, 'a name already there is not sent again'); assert.match(text(tree), /「MSRDC」已经在名单里/);
  button('恢复默认').props!.onClick(); await settle();
  assert.deepEqual(requests.at(-1)!.body, { names: null });
  error = 'names 必须是名字列表'; button('恢复默认').props!.onClick(); await settle();
  assert.match(text(tree), /保存失败：names 必须是名字列表/);
  enabled = false; render();
  assert.match(text(tree), /她用电脑关着，信箱现在没在听[^]*信箱不理会这些程序/, 'off: it says the inbox is not listening, and the list can still be set');
});

test('her own templates are compared with the shipped ones: a section she lacks, a variable hers does not use, and the shipped words to copy', async () => {
  const source = await readFile('client/index.js', 'utf8');
  let loaded: { factory: (require: (name: string) => unknown) => { __test: (worldId: string) => { TemplateGaps: unknown } } } | undefined;
  const react = { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }), useState: (value: unknown) => [value, () => {}], useEffect: () => {}, useRef: (current: unknown) => ({ current }) };
  runInNewContext(source, { fetch: () => Promise.reject(new Error('no fetch')), window: { __ModuleLoader__: { load: (entry: typeof loaded) => { loaded = entry; } } } });
  const { TemplateGaps } = loaded!.factory(() => react).__test('fish');
  type El = { type: unknown; props: Record<string, unknown> | null; children: unknown[] };
  const text = (node: unknown): string => {
    if (node == null || typeof node === 'boolean') return '';
    if (Array.isArray(node)) return node.map(text).join('');
    if (typeof node !== 'object') return String(node);
    const el = node as El;
    if (typeof el.type === 'function') return text((el.type as (p: unknown) => unknown)({ ...el.props, children: el.children }));
    return text(el.children);
  };
  const render = (props: object) => text(react.createElement(TemplateGaps, { title: '对照', note: '只是提醒', ...props }));
  assert.match(render({ gaps: [{ heading: '认识', text: '{{#wikiDir}}\n## 认识\n…\n{{/wikiDir}}' }] }), /^对照只是提醒「认识」 自带有这一段，你的没有\{\{#wikiDir\}\}\n## 认识/);
  assert.match(render({ gaps: [{ heading: '每日回顾', missing: ['wikiDir', 'activity'], text: '## 每日回顾\n…' }] }), /「每日回顾」 自带的用到了 \{\{wikiDir\}\}、\{\{activity\}\}，你的没有## 每日回顾/);
  assert.match(render({ gaps: [{ heading: '我', renamed: { from: '我是谁', note: '「我是谁」这一段现在叫「我」。' }, text: '## 我\n…' }] }), /「我」 改了名，你的还叫「我是谁」：「我是谁」这一段现在叫「我」。## 我/);
  assert.equal(render({ gaps: [] }), '对照和插件自带的没有差距。');
  assert.equal(render({ error: '读不了 alarm.md：坏了' }), '对照读不了 alarm.md：坏了', 'an unreadable file says so, never "no gaps"');
});

test('handing the gaps to her: a button for what is ticked, nothing while she is away, and what she changed with a way back', async () => {
  const source = await readFile('client/index.js', 'utf8');
  let loaded: { factory: (require: (name: string) => unknown) => { __test: (worldId: string) => { PromptMerge: unknown } } } | undefined;
  const react = { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }), useState: (value: unknown) => [value, () => {}], useEffect: () => {}, useRef: (current: unknown) => ({ current }) };
  runInNewContext(source, { fetch: () => Promise.reject(new Error('no fetch')), window: { __ModuleLoader__: { load: (entry: typeof loaded) => { loaded = entry; } } } });
  const { PromptMerge } = loaded!.factory(() => react).__test('fish');
  type El = { type: unknown; props: Record<string, unknown> | null; children: unknown[] };
  const expand = (value: unknown): El[] => {
    if (Array.isArray(value)) return value.flatMap(expand);
    if (!value || typeof value !== 'object') return [];
    const el = value as El;
    return typeof el.type === 'function' ? expand((el.type as (p: unknown) => unknown)({ ...el.props, children: el.children })) : [el, ...el.children.flatMap(expand)];
  };
  const text = (value: unknown): string => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text((value as El).children) : value == null || typeof value === 'boolean' ? '' : String(value);
  const render = (props: object) => expand(react.createElement(PromptMerge, { ids: ['world:认识', 'alarm:每日回顾'], picked: (id: string) => id !== 'alarm:每日回顾', running: true, ...props }));
  const ask = (tree: El[]) => tree.find(el => el.type === 'button' && /交给她融进去/.test(text(el)))!;
  const idle = render({ merge: { status: 'idle' } });
  assert.equal(text(ask(idle)), '交给她融进去（1 处）'); assert.equal(ask(idle).props!.disabled, false);
  assert.match(text(idle), /「大事先问」这类规矩她也能改到/, 'the risk of the choice made is said where it is pressed');
  const away = render({ merge: { status: 'idle' }, running: false });
  assert.equal(ask(away).props!.disabled, true); assert.match(text(away), /世界开始后才能交给她/);
  assert.equal(ask(render({ merge: { status: 'merging' } })).props!.disabled, true);
  const done = render({ merge: { status: 'done', message: '她改了 1 处', undoable: true, changes: [{ file: 'W/world-prompt.md', sections: [{ heading: '认识', kind: 'added', after: '## 认识\n…' }] }] } });
  assert.match(text(done), /她改了 1 处[^]*W\/world-prompt\.md新加「认识」现在：\n## 认识/);
  assert.ok(done.some(el => el.type === 'button' && text(el) === '撤销这次融合'));
  assert.ok(!render({ merge: { status: 'failed', message: '读不通' } }).some(el => el.type === 'button' && text(el) === '撤销这次融合'), 'a failed merge was put back already');
});
