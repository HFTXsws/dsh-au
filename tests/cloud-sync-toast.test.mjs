import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build, outFile } from '../scripts/build-client.js';

const CLIENT_RETURN = "    return { name: 'dsh-au', inject, apply, mobile: mobileClient.helpers, shortcuts: shortcutHelpers };";
const EXPORT_HOOK = '\n    globalThis.__AU_CLOUD_SYNC_TOAST_TEST__ = { AuFleetShell };\n' + CLIENT_RETURN;

function loadToastHelpers() {
  const source = readFileSync(new URL('../client/src/11-shell.js', import.meta.url), 'utf8');
  const start = source.indexOf('const CLOUD_SYNC_TOAST_MAX_AGE_MS');
  const end = source.indexOf('// END resolveCloudSyncToastDecision');
  assert.ok(start >= 0 && end > start, '11-shell.js 必须定义 CLOUD_SYNC_TOAST_* 与 resolveCloudSyncToastDecision');
  return new Function(`${source.slice(start, end)}\nreturn { CLOUD_SYNC_TOAST_MAX_AGE_MS, CLOUD_SYNC_TOAST_DURATION_OK_MS, CLOUD_SYNC_TOAST_DURATION_WARN_MS, resolveCloudSyncToastDecision };`)();
}

function findAll(node, predicate, found = []) {
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, predicate, found);
    return found;
  }
  if (!node || typeof node !== 'object') return found;
  if (predicate(node)) found.push(node);
  findAll(node.props?.children, predicate, found);
  return found;
}

function findToasts(tree) {
  return findAll(tree, (n) => typeof n.props?.className === 'string' && n.props.className.split(/\s+/).includes('dsh-au-global-toast'));
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props?.children);
}

function mountShellHarness({ initialSnapshot } = {}) {
  const storage = new Map();
  const localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };

  let nextTimerId = 1;
  const activeTimeouts = new Map();
  const clearedTimeouts = [];
  const activeIntervals = new Map();

  const fakeSetTimeout = (fn, delay) => {
    const id = nextTimerId++;
    activeTimeouts.set(id, { id, fn, delay });
    return id;
  };
  const fakeClearTimeout = (id) => {
    if (id !== null && id !== undefined) {
      clearedTimeouts.push(id);
      activeTimeouts.delete(id);
    }
  };
  const fakeSetInterval = (fn, delay) => {
    const id = nextTimerId++;
    activeIntervals.set(id, { id, fn, delay });
    return id;
  };
  const fakeClearInterval = (id) => {
    activeIntervals.delete(id);
  };

  const listeners = new Map();
  const win = {
    localStorage,
    innerWidth: 1280,
    location: { hostname: '127.0.0.1', href: 'http://127.0.0.1:7984/' },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent(event) {
      const set = listeners.get(event?.type);
      if (set) for (const fn of [...set]) fn(event);
      return true;
    },
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    setInterval: fakeSetInterval,
    clearInterval: fakeClearInterval,
    requestAnimationFrame: (cb) => { cb(); return 0; },
    cancelAnimationFrame: () => {},
  };

  const doc = {
    body: { appendChild: (c) => c },
    head: { appendChild: (c) => c },
    documentElement: { setAttribute() {}, removeAttribute() {} },
    getElementById: () => null,
    querySelector: () => null,
    createElement: () => ({ style: {}, dataset: {}, appendChild: (c) => c, remove() {} }),
  };

  const states = [];
  const refs = [];
  const effects = [];
  const cleanups = [];
  let stateCursor = 0;
  let refCursor = 0;
  let effectCursor = 0;

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      const normalized = children.length === 0
        ? props?.children
        : (children.length === 1 ? children[0] : children);
      return { type, props: { ...(props || {}), children: normalized } };
    },
    useState(initialValue) {
      const index = stateCursor++;
      if (!(index in states)) {
        states[index] = typeof initialValue === 'function' ? initialValue() : initialValue;
      }
      return [states[index], (update) => {
        states[index] = typeof update === 'function' ? update(states[index]) : update;
      }];
    },
    useRef(initialValue) {
      const index = refCursor++;
      if (!(index in refs)) refs[index] = { current: initialValue };
      return refs[index];
    },
    useCallback: (cb) => cb,
    useMemo: (fn) => fn(),
    useEffect(fn, deps) {
      const index = effectCursor++;
      effects[index] = { fn, deps };
    },
  };

  let currentSnap = initialSnapshot || {
    ok: true,
    self: { deviceId: 'self', status: 'idle', ips: ['127.0.0.1'] },
    devices: [{ id: 'self', name: 'self', status: 'idle', routes: [] }],
    remotes: [],
    lanPeers: [],
  };

  const fetch = async (url, init = {}) => {
    const isGetState = String(url).includes('/dsh-au/api') && (!init.method || init.method === 'GET');
    if (isGetState) {
      return { ok: true, status: 200, text: async () => JSON.stringify(currentSnap) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
  };

  const exports = {};
  win.__ModuleLoader__ = { load: (definition) => { win.definition = definition; } };
  const code = build();
  assert.ok(code.includes(CLIENT_RETURN), 'bundle 必须包含工厂导出出口');
  new Function(
    'window', 'document', 'localStorage', 'fetch',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'globalThis',
    code.replace(CLIENT_RETURN, EXPORT_HOOK),
  )(win, doc, localStorage, fetch, fakeSetTimeout, fakeClearTimeout, fakeSetInterval, fakeClearInterval, exports);

  win.definition.factory((id) => {
    if (id === 'react') return React;
    if (id === 'react-dom') return { createPortal: (el, target) => ({ type: 'PORTAL', props: { target, children: el } }) };
    throw new Error(`未预期的模块依赖：${id}`);
  });

  const { AuFleetShell } = exports.__AU_CLOUD_SYNC_TOAST_TEST__;

  function render() {
    stateCursor = 0;
    refCursor = 0;
    effectCursor = 0;
    return AuFleetShell({
      selectPanel() {},
      collapseSidebar() {},
      expandSidebar() {},
      toggleSidebar() {},
      usePanelInfo: () => null,
    });
  }

  function runMountEffects() {
    for (let i = 0; i < effects.length; i++) {
      const cleanup = effects[i].fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    }
  }

  function unmount() {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      cleanup();
    }
  }

  async function pushSnap(snap) {
    currentSnap = snap;
    win.dispatchEvent({ type: 'dsh-au:refresh-state' });
    await new Promise((resolve) => setImmediate(resolve));
  }

  function getToastTimeouts() {
    return [...activeTimeouts.values()].filter((t) => t.delay === 4000 || t.delay === 6000);
  }

  function runToastTimers() {
    const list = getToastTimeouts();
    for (const item of list) {
      activeTimeouts.delete(item.id);
      item.fn();
    }
    return list;
  }

  return {
    render,
    runMountEffects,
    unmount,
    pushSnap,
    getToastTimeouts,
    runToastTimers,
    clearedTimeouts,
  };
}

test('client/client.js 包含全局 Toast 样式与生命周期核心实现', () => {
  const bundle = readFileSync(outFile, 'utf8');
  assert.match(bundle, /\.dsh-au-global-toast\b/);
  assert.match(bundle, /\.dsh-au-global-toast\.is-ok\b/);
  assert.match(bundle, /\.dsh-au-global-toast\.is-warn\b/);
  assert.match(bundle, /\.dsh-au-global-toast-title\b/);
  assert.match(bundle, /\.dsh-au-global-toast-msg\b/);
  assert.match(bundle, /\.dsh-au-global-toast-close\b/);
  assert.match(bundle, /@keyframes dshAuToastIn\b/);
  assert.match(bundle, /--dsw-alias-bg-elevated/);
  assert.match(bundle, /--dsw-alias-border-primary/);
  assert.match(bundle, /--dsw-alias-state-success-primary/);
  assert.match(bundle, /--dsw-alias-state-warn-primary/);
  assert.match(bundle, /cloudSyncToast/);
  assert.match(bundle, /lastSeenCloudSyncToastIdRef/);
  assert.match(bundle, /cloudSyncToastTimerRef/);
  assert.match(bundle, /30_000/);
});

test('resolveCloudSyncToastDecision: 去重、30 秒新鲜度过滤与 ok/warn 自动关闭时长', () => {
  const {
    CLOUD_SYNC_TOAST_MAX_AGE_MS,
    CLOUD_SYNC_TOAST_DURATION_OK_MS,
    CLOUD_SYNC_TOAST_DURATION_WARN_MS,
    resolveCloudSyncToastDecision,
  } = loadToastHelpers();

  assert.equal(CLOUD_SYNC_TOAST_MAX_AGE_MS, 30_000);
  assert.equal(CLOUD_SYNC_TOAST_DURATION_OK_MS, 4000);
  assert.equal(CLOUD_SYNC_TOAST_DURATION_WARN_MS, 6000);

  const now = 1_700_000_000_000;

  // 新鲜 ok Toast：展示并在 4000ms 后关闭
  const okToast = { id: 'toast-ok-1', status: 'ok', title: '云同步完成', message: '已同步 2 项设置', createdAt: now - 5_000 };
  const okDecision = resolveCloudSyncToastDecision(okToast, '', now);
  assert.equal(okDecision.action, 'show');
  assert.equal(okDecision.status, 'ok');
  assert.equal(okDecision.durationMs, 4000);
  assert.equal(okDecision.nextLastSeenId, 'toast-ok-1');

  // 新鲜 warn Toast（支持 ISO 时间戳）：展示并在 6000ms 后关闭
  const warnToast = { id: 'toast-warn-1', status: 'warn', title: '云同步部分失败', message: '1 个插件待重启', createdAt: new Date(now - 10_000).toISOString() };
  const warnDecision = resolveCloudSyncToastDecision(warnToast, 'toast-ok-1', now);
  assert.equal(warnDecision.action, 'show');
  assert.equal(warnDecision.status, 'warn');
  assert.equal(warnDecision.durationMs, 6000);
  assert.equal(warnDecision.nextLastSeenId, 'toast-warn-1');

  // 相同 id 去重，不重复弹出
  const dupDecision = resolveCloudSyncToastDecision(warnToast, 'toast-warn-1', now);
  assert.equal(dupDecision.action, 'ignore');
  assert.equal(dupDecision.nextLastSeenId, 'toast-warn-1');

  // 超过 30_000ms 的旧 Toast：仅记录 id，不回放弹窗
  const staleToast = { id: 'toast-stale-1', status: 'ok', title: '旧同步', message: '来自上次启动', createdAt: now - 30_001 };
  const staleDecision = resolveCloudSyncToastDecision(staleToast, '', now);
  assert.equal(staleDecision.action, 'skip_stale');
  assert.equal(staleDecision.nextLastSeenId, 'toast-stale-1');

  // 恰好 30_000ms 边界仍展示
  const boundaryToast = { id: 'toast-edge-1', status: 'ok', title: '边界同步', message: '刚好 30 秒', createdAt: now - 30_000 };
  const boundaryDecision = resolveCloudSyncToastDecision(boundaryToast, '', now);
  assert.equal(boundaryDecision.action, 'show');
});

test('AuFleetShell: 挂载、ok/warn Toast 渲染与自动关闭、去重、旧 Toast 跳过、关闭按钮及卸载清理', async () => {
  const baseSnap = {
    ok: true,
    self: { deviceId: 'self', status: 'idle', ips: ['127.0.0.1'] },
    devices: [{ id: 'self', name: 'self', status: 'idle', routes: [] }],
    remotes: [],
    lanPeers: [],
  };

  // 1) 新鲜 ok Toast：渲染 Portal + 4000ms 自动关闭 + 相同 id 不重复弹出
  const harness = mountShellHarness({ initialSnapshot: baseSnap });
  harness.render();
  harness.runMountEffects();
  await new Promise((resolve) => setImmediate(resolve));

  const now = Date.now();
  await harness.pushSnap({
    ...baseSnap,
    cloudSyncToast: {
      id: 'sync-ok-1',
      status: 'ok',
      title: '自动云同步完成',
      message: '已从云端拉取最新配置',
      createdAt: now - 1000,
    },
  });

  let tree = harness.render();
  let toasts = findToasts(tree);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].props.className, 'dsh-au-global-toast is-ok');
  assert.equal(toasts[0].props.role, 'status');
  assert.equal(toasts[0].props['aria-live'], 'polite');
  assert.equal(textOf(findAll(toasts[0], (n) => n.props?.className === 'dsh-au-global-toast-title')[0]), '自动云同步完成');
  assert.equal(textOf(findAll(toasts[0], (n) => n.props?.className === 'dsh-au-global-toast-msg')[0]), '已从云端拉取最新配置');

  const okTimers = harness.getToastTimeouts();
  assert.equal(okTimers.length, 1);
  assert.equal(okTimers[0].delay, 4000);

  // 4000ms 到期自动关闭
  harness.runToastTimers();
  tree = harness.render();
  assert.equal(findToasts(tree).length, 0);

  // 相同 id 再次下发，不重复弹出
  await harness.pushSnap({
    ...baseSnap,
    cloudSyncToast: {
      id: 'sync-ok-1',
      status: 'ok',
      title: '自动云同步完成',
      message: '已从云端拉取最新配置',
      createdAt: now - 1000,
    },
  });
  tree = harness.render();
  assert.equal(findToasts(tree).length, 0);

  // 2) 新 Toast 替换旧 Toast 前先清理旧定时器；warn Toast 使用 role="alert"、6000ms 自动关闭，且支持点击关闭按钮立刻关闭并清理定时器
  await harness.pushSnap({
    ...baseSnap,
    cloudSyncToast: {
      id: 'sync-ok-temp',
      status: 'ok',
      title: '即将被替换',
      message: '旧提示',
      createdAt: Date.now() - 200,
    },
  });
  const replacedTimers = harness.getToastTimeouts();
  assert.equal(replacedTimers.length, 1);
  const replacedTimerId = replacedTimers[0].id;

  await harness.pushSnap({
    ...baseSnap,
    cloudSyncToast: {
      id: 'sync-warn-2',
      status: 'warn',
      title: '自动云同步告警',
      message: '部分插件同步失败',
      createdAt: Date.now() - 100,
    },
  });
  assert.ok(harness.clearedTimeouts.includes(replacedTimerId), '开启新定时器前应先清理旧定时器');
  tree = harness.render();
  toasts = findToasts(tree);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].props.className, 'dsh-au-global-toast is-warn');
  assert.equal(toasts[0].props.role, 'alert');
  assert.equal(toasts[0].props['aria-live'], 'polite');

  const warnTimers = harness.getToastTimeouts();
  assert.equal(warnTimers.length, 1);
  assert.equal(warnTimers[0].delay, 6000);
  const warnTimerId = warnTimers[0].id;

  const closeBtn = findAll(toasts[0], (n) => n.props?.className === 'dsh-au-global-toast-close')[0];
  assert.ok(closeBtn);
  assert.equal(textOf(closeBtn), '×');
  closeBtn.props.onClick();
  assert.ok(harness.clearedTimeouts.includes(warnTimerId), '关闭 Toast 时应清理定时器');
  assert.equal(harness.getToastTimeouts().length, 0);
  tree = harness.render();
  assert.equal(findToasts(tree).length, 0);

  // 3) 新 Toast 触发但尚未关闭时，组件卸载应清理定时器
  await harness.pushSnap({
    ...baseSnap,
    cloudSyncToast: {
      id: 'sync-ok-3',
      status: 'ok',
      title: '再次同步',
      message: '完成',
      createdAt: Date.now(),
    },
  });
  const pendingTimers = harness.getToastTimeouts();
  assert.equal(pendingTimers.length, 1);
  harness.unmount();
  assert.ok(harness.clearedTimeouts.includes(pendingTimers[0].id), '组件卸载时应清理 cloudSyncToastTimerRef');

  // 4) 页面刷新（全新挂载）遇到超过 30 秒的旧 Toast，不回放弹窗
  const staleHarness = mountShellHarness({
    initialSnapshot: {
      ...baseSnap,
      cloudSyncToast: {
        id: 'sync-stale-refresh',
        status: 'ok',
        title: '陈旧同步提示',
        message: '不应在刷新后弹出',
        createdAt: Date.now() - 45_000,
      },
    },
  });
  staleHarness.render();
  staleHarness.runMountEffects();
  await new Promise((resolve) => setImmediate(resolve));
  const staleTree = staleHarness.render();
  assert.equal(findToasts(staleTree).length, 0);
  assert.equal(staleHarness.getToastTimeouts().length, 0);
  staleHarness.unmount();
});
