/**
 * 两帧之间 hook 顺序不能变。
 *
 * 浏览器半侧的几个组件都没有 ErrorBoundary：只要有一个组件在某一帧多调用或少调用
 * 一个 useState，React 就会抛 "Rendered more hooks than during the previous render"，
 * 整棵树被卸载 —— 用户看到的是全白的界面，控制台之外什么线索都没有。
 *
 * 这个测试用两个假 React 框架把每个组件各渲两遍（先空数据、再有数据），比对 hook 序列。
 * 曾经踩过一次：开关的 useState 写在 early return 后面，数据一到就白屏。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'client', 'index.js'), 'utf8');

/** 假 React：只记 hook 调用顺序，值从 values 里按位取，取不到就用初始值。 */
function runtime(values: readonly unknown[], requests: Array<{ path: string; init: any }> = []): { run(name: string, props?: any): { hooks: string[]; tree: any } } {
  const hooks: string[] = [];
  let at = 0;
  const react = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
    useState: (init: unknown) => {
      const index = at++;
      hooks.push('useState');
      return [index < values.length ? values[index] : init, () => {}];
    },
    useEffect: () => { hooks.push('useEffect') },
    useRef: () => { hooks.push('useRef'); return { current: null } },
    useMemo: (fn: () => unknown) => { hooks.push('useMemo'); return fn() },
    Fragment: 'fragment',
  };
  const loaded: Array<{ factory: (require: (name: string) => unknown) => any }> = [];
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: (opts: never) => { loaded.push(opts) } } },
    document: { visibilityState: 'visible' },
    fetch: (path: string, init: any) => { requests.push({ path, init }); return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) },
    console,
  });
  assert.equal(loaded.length, 1, '客户端应该只注册一次模块');
  const exports = loaded[0].factory((name: string) => {
    if (name === 'react') return react;
    throw new Error(`组件不该依赖 ${name}`);
  });
  return {
    run(name: string, props?: any) {
      at = 0;
      hooks.length = 0;
      const component = exports.__test[name];
      assert.equal(typeof component, 'function', `${name} 应该在 __test 里`);
      const tree = component(props || { ...filled, snapshot: filled, snap: filled });
      return { hooks: [...hooks], tree };
    },
  };
}

/** 一份「什么都有一点」的假数据，让组件走「有数据」那条分支。 */
const filled = {
  life: { today: '2026-10-26', days: [{ day: '2026-10-26', rows: [] }], memory: {}, quota: { daily: 20, used: 3 } },
  persona: { persona: '她', rules: [] },
  prompt: { prompt: '世界提示词' },
  sessions: [{ sessionId: 'session-1', title: '和主人说话' }],
  enabled: true,
  dryRun: true,
  running: true,
  timeZone: 'Asia/Shanghai',
  policy: { maxCallsPerDay: 60, maxPerDay: 3 },
  today: { dayKey: '2026-10-26', calls: 2, messages: 1, sent: 1, suppressed: 0, pending: 0 },
  usage: { calls: 2, sampled: 2, avgInputTokens: 1200, avgOutputTokens: 30 },
  usageSeries: [{ dayKey: '2026-10-26', calls: 2, sampled: 2, avgInputTokens: 1200, avgOutputTokens: 30, messages: 1 }],
  reports: [{ decision: 'send', blocked: [], text: '在吗' }],
  days: [{ key: '2026-10-26', date: '2026-10-26', summary: '今天', rows: [] }],
  diary: '',
  records: [],
  memory: { rounds: 3 },
  mem: { turns: 3, windowTurns: 200, tokenBudget: 6000, approxTokens: 900, records: 4, sessions: 1 },
  costs: { today: { yuan: 0.0123, records: 2 }, byModel: [{ key: 'deepseek-chat', yuan: 0.0123 }], bySession: [{ key: 'session-12345678', yuan: 0.0123 }], note: '本地估算，不是供应商账单原值' },
  health: [],
  stats: {},
  alarm: null,
  dates: ['2026-10-26'],
  modules: { wechat: { available: true, enabled: true, running: true }, qq: { available: true, enabled: true, running: true } },
  wechat: { accountId: 'wxid_bot', chats: 2, pending: 0, uncertain: 0, lastContactAt: '2026-10-26T10:00:00.000Z', account: 'online', contextMessages: 8, bufferSeconds: 3, adapter: { running: true, pid: 1, restarts: 0, lastExit: null, error: null, needsHuman: false } },
  routines: { version: 1, enabled: true, routines: [{ id: 'r-1', title: '喝水', enabled: true, dueAt: null }] },
  photos: [{ id: 'photo-1', description: '窗边', width: 2, height: 2, bytes: 4, tags: ['家'] }],
};

const components = ['Activity', 'Diary', 'Qq', 'Panel', 'View', 'Overview', 'PersonaEditor', 'PromptEditor', 'Proactive', 'Modules', 'Wechat', 'Memory', 'CostSummary', 'RoutineAdmin', 'PhotoAlbum'] as const;

for (const name of components) {
  test(`${name} 在两帧之间不会换 hook 顺序`, () => {
    // 第一帧：什么都还没读到（第一个 useState 给 null，其余用组件自己的初始值）
    const empty = runtime([null]).run(name);
    // 第二帧：数据到了（第一个 useState 给满的假数据，其余仍是初始值）
    const full = runtime([filled]).run(name);
    assert.deepEqual(
      full.hooks,
      empty.hooks,
      `${name} 第一帧调了 ${empty.hooks.join('→')}，数据到了以后变成 ${full.hooks.join('→')}；` +
      'React 会因此卸载整棵树，界面直接变白',
    );
  });
}

test('Memory 展示并保存 token 预算到现有 memory 路由', async () => {
  const requests: Array<{ path: string; init: any }> = [];
  const { tree } = runtime(['workspace', '200', '6000', ''], requests).run('Memory', { mem: filled.mem });
  const nodes: any[] = [];
  function visit(node: any): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    nodes.push(node);
    visit(node.children);
  }
  visit(tree);
  const input = nodes.find(node => node.props?.['aria-label'] === '记忆 token 预算');
  assert.equal(input?.props.value, '6000');
  const button = nodes.find(node => node.type === 'button' && node.children?.includes('保存 token 预算'));
  assert.ok(button);
  button.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests[0]?.path, '/dsh-world/console/memory');
  assert.deepEqual(JSON.parse(requests[0].init.body), { tokenBudget: 6000 });
});

test('Overview 展示今日成本及本地估算说明', () => {
  const { tree } = runtime([]).run('Overview');
  const nodes: any[] = [];
  function visit(node: any): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    nodes.push(node);
    visit(node.children);
  }
  visit(tree);
  const costComponent = nodes.find(node => node.type?.name === 'CostSummary');
  assert.ok(costComponent);
  assert.equal(costComponent.props.costs, filled.costs);
  const { tree: card } = runtime([]).run('CostSummary', { costs: filled.costs });
  assert.match(JSON.stringify(card), /本地估算/);
  assert.match(JSON.stringify(card), /deepseek-chat/);
});

test('RoutineAdmin 的总开关、暂停和删除请求指向习惯控制台路由', async () => {
  const requests: Array<{ path: string; init: any }> = [];
  const { tree } = runtime([], requests).run('RoutineAdmin', { routines: filled.routines });
  const nodes: any[] = [];
  function visit(node: any): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    nodes.push(node);
    visit(node.children);
  }
  visit(tree);
  nodes.find(node => node.type === 'input')!.props.onChange({ target: { checked: false } });
  const buttons = nodes.filter(node => node.type === 'button');
  buttons[0].props.onClick();
  buttons[1].props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests.map(({ path, init }) => [path, JSON.parse(init.body)]), [
    ['/dsh-world/console/routines', { enabled: false }],
    ['/dsh-world/console/routines/pause', { id: 'r-1', paused: true }],
    ['/dsh-world/console/routines/remove', { id: 'r-1' }],
  ]);
});
