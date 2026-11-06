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
function runtime(values: readonly unknown[]): { run(name: string, props?: object): { hooks: string[]; tree: unknown } } {
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
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    console,
  });
  assert.equal(loaded.length, 1, '客户端应该只注册一次模块');
  const exports = loaded[0].factory((name: string) => {
    if (name === 'react') return react;
    throw new Error(`组件不该依赖 ${name}`);
  });
  return {
    run(name: string, props: object = filled) {
      at = 0;
      hooks.length = 0;
      const component = exports.__test('fish')[name];
      assert.equal(typeof component, 'function', `${name} 应该在 __test 里`);
      const tree = component({ ...props, snapshot: props, snap: props });
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
  homeApply: { status: 'waiting' },
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
  workspace: { defaultPermission: 'custom-read-only', options: [{ value: 'custom-read-only', name: '只读' }] },
  health: [],
  stats: {},
  alarm: null,
  dates: ['2026-10-26'],
  modules: { wechat: { available: true, enabled: true, running: true }, qq: { available: true, enabled: true, running: true } },
  wechat: { accountId: 'wxid_bot', chats: 2, pending: 0, uncertain: 0, lastContactAt: '2026-10-26T10:00:00.000Z', account: 'online', contextMessages: 8, bufferSeconds: 3, adapter: { running: true, pid: 1, restarts: 0, lastExit: null, error: null, needsHuman: false } },
  // 原生通道那张卡：不带上它，QQ 卡片里新加的「主动开口」两个勾选框永远走不到渲染那一步。
  native: {
    enabled: true, connected: true, url: 'ws://127.0.0.1:3003', allowPrivate: 1, allowGroups: 1, autoReply: true,
    bindHomeSession: 'none', groupTrigger: 'mention', conversations: 2, answering: 0, sent: 3, failed: 0,
    blocked: 2, lastBlockedAt: '2026-10-26T10:05:00.000Z', lastEventAt: '2026-10-26T10:00:00.000Z', lastError: null,
    bridge: {
      serving: true, port: 3210, url: 'ws://127.0.0.1:3210', token: 'ab'.repeat(16),
      line: 'DSH_QQ_BRIDGE_URL=ws://127.0.0.1:3210 DSH_QQ_BRIDGE_TOKEN=ab node qq-line.js 阳台 line-1',
      lines: 1, threads: ['line-1'], received: 2, relayed: 2, spoken: 0, lastAt: null, lastError: null, quiet: [],
    },
  },
};

const components = ['Activity', 'Diary', 'Qq', 'Panel', 'View', 'Overview', 'PersonaEditor', 'PromptEditor', 'HomeApply', 'PhotoAlbum', 'Modules', 'Wechat', 'WorkspacePermission'] as const;

for (const name of components) {
  test(`${name} 在两帧之间不会换 hook 顺序`, () => {
    // 第一帧：什么都还没读到（第一个 useState 给 null，其余用组件自己的初始值）
    const empty = name === 'WorkspacePermission' ? runtime([]).run(name, { workspace: null }) : name === 'PhotoAlbum' ? runtime([]).run(name) : runtime([null]).run(name);
    // 第二帧：数据到了（第一个 useState 给满的假数据，其余仍是初始值）
    const full = name === 'WorkspacePermission' ? runtime([]).run(name) : name === 'Modules' ? runtime(['SDK 已安装，请重启 DSH']).run(name) : name === 'PhotoAlbum' ? runtime([{ photos: [{ id: 'p', description: '窗边', tags: [], width: 2, height: 2, savedAt: '2026-10-29T00:00:00Z' }], total: 1, hasMore: false }]).run(name) : runtime([filled]).run(name);
    assert.deepEqual(
      full.hooks,
      empty.hooks,
      `${name} 第一帧调了 ${empty.hooks.join('→')}，数据到了以后变成 ${full.hooks.join('→')}；` +
      'React 会因此卸载整棵树，界面直接变白',
    );
  });
}
