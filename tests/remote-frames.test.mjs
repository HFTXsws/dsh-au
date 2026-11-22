import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '../client/src');
// The real shell now depends on model shortcut target ownership; include its source, not a helper mock.
const fragments = ['01-runtime.js', '01a-shortcuts.js', '01b-model-shortcuts.js', '02-styles.js', '03-routes.js',
  '04-actions.js', '05-icons.js', '06-cards.js', '07-menu-model.js', '08-workbench-logic.js',
  '09-workbench-views.js', '10-workbench.js', '10a-remote-frame.js', '10b-initial-session-focus.js', '10c-remote-session-preload.js', '11-shell.js', '13a-shortcut-settings.js'];

// React/ReactDOM are the third-party boundary: initialize hooks normally and reconcile keyed
// components across rerenders. No product helper is replaced and no state slot is injected.
function createHookHost(browser) {
  const instances = new Map();
  let current;
  let dirty = true;
  let root;
  let rootProps;
  let exported;
  let tree;
  let seen;
  const dependenciesEqual = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  function slot(create) {
    const i = current.cursor++;
    if (!(i in current.hooks)) current.hooks[i] = create();
    return current.hooks[i];
  }
  const react = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const owner = current;
      const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }));
      state.set ||= (value) => {
        if (!owner.alive) return;
        const next = typeof value === 'function' ? value(state.value) : value;
        if (!Object.is(next, state.value)) { state.value = next; dirty = true; }
      };
      return [state.value, state.set];
    },
    useRef: (initial) => slot(() => ({ current: initial })),
    useCallback(callback, deps) {
      const memo = slot(() => ({}));
      if (!dependenciesEqual(memo.deps, deps)) { memo.deps = deps; memo.value = callback; }
      return memo.value;
    },
    useEffect(effect, deps) {
      const state = slot(() => ({}));
      if (!dependenciesEqual(state.deps, deps)) {
        state.deps = deps;
        current.effects.push(() => { state.cleanup?.(); state.cleanup = effect(); });
      }
    },
  };
  const portal = Symbol('Portal');
  const reactDom = { createPortal: (children, container) => ({ type: portal, props: { children, container } }) };
  function renderComponent(component, props, identity) {
    let instance = instances.get(identity);
    if (!instance) {
      instance = { hooks: [], alive: true, element: null };
      instances.set(identity, instance);
    }
    seen.add(identity);
    instance.cursor = 0;
    instance.effects = [];
    const previous = current;
    current = instance;
    const result = component(props);
    current = previous;
    const expanded = expand(result, identity, instance);
    if (component === exported.RemoteDshFrame && expanded) expanded.componentProps = props;
    return expanded;
  }
  function expand(node, path, owner) {
    if (node === null || node === undefined || typeof node === 'boolean') return null;
    if (Array.isArray(node)) return node.map((child, i) => expand(child, `${path}/${i}`, owner));
    if (typeof node !== 'object') return node;
    if (node.type === exported.RemoteDshFrame) {
      return renderComponent(node.type, node.props, `frame:${node.props.key ?? path}`);
    }
    // Other UI components remain real function references, but their unrelated dialogs/icons
    // are opaque to this renderer; assertions inspect only their public element props.
    if (typeof node.type === 'function') return node;
    const result = { ...node, props: { ...node.props } };
    if (node.type === 'iframe') {
      owner.element ||= browser.document.createElement('iframe');
      const element = owner.element;
      if (element.src !== node.props.src) {
        element.src = node.props.src;
        element.contentWindow.location.href = node.props.src;
      }
      element.name = node.props.name;
      element.props = result.props;
      if (node.props.ref) node.props.ref.current = element;
      result.element = element;
      result.componentKey = path;
    }
    result.props.children = expand(node.props.children, `${path}/children`, owner);
    return result;
  }
  function dispose(instance) {
    instance.alive = false;
    for (const hook of instance.hooks) hook.cleanup?.();
    if (instance.element) instance.element.removed = true;
  }
  function render() {
    let rounds = 0;
    while (dirty) {
      assert.ok(++rounds < 60, 'hook host did not settle');
      dirty = false;
      seen = new Set();
      tree = renderComponent(root, rootProps, 'root');
      for (const [id, instance] of instances) {
        if (!seen.has(id)) { dispose(instance); instances.delete(id); }
      }
      browser.frames = [...instances.values()].map((instance) => instance.element).filter(Boolean);
      for (const instance of instances.values()) {
        for (const effect of instance.effects) effect();
        instance.effects = [];
      }
    }
  }
  const requireBoundary = (name) => {
    if (name === 'react') return react;
    if (name === 'react-dom') return reactDom;
    throw new Error(`Unexpected third-party dependency: ${name}`);
  };
  const bindings = { require: requireBoundary, ...browser.globals };
  // Read actual source fragments instead of generated client.js, which another agent builds.
  exported = new Function(...Object.keys(bindings), fragments.map((file) => readFileSync(join(srcDir, file), 'utf8')).join('\n')
    + '\nreturn { AuFleetShell, RemoteDshFrame, RemoteManagerModal, UnifiedWorkbenchModal, installControlledFrameShortcutBridge };')(...Object.values(bindings));
  return {
    exported,
    mount(component, props) { root = component; rootProps = props; dirty = true; render(); },
    render,
    nodes(predicate) {
      const found = [];
      function walk(node) {
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (!node || typeof node !== 'object') return;
        if (predicate(node)) found.push(node);
        walk(node.props?.children);
      }
      walk(tree);
      return found;
    },
    unmount() { for (const instance of instances.values()) dispose(instance); instances.clear(); tree = null; },
  };
}

// Browser APIs (DOM, postMessage, storage) are system boundaries; fake only geometry,
// events and browsing-context identity, not product route/lifecycle behavior.
function createBrowser({ href = 'http://127.0.0.1:7984/', mobile = false, electron = false, snapshot } = {}) {
  let time = 1000;
  let nextId = 0;
  const tasks = new Map();
  const listeners = new Map();
  const storage = new Map();
  const browser = { frames: [], requests: [], navigations: [], snapshot };
  const setTimer = (callback, delay, interval = 0) => {
    const id = ++nextId;
    tasks.set(id, { callback, due: time + delay, interval });
    return id;
  };
  const addEventListener = (type, callback) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(callback);
  };
  const removeEventListener = (type, callback) => listeners.get(type)?.delete(callback);
  const emit = (type, event) => { for (const callback of [...(listeners.get(type) || [])]) callback(event); };
  class ElementBoundary {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.dataset = {};
      this.style = {};
      this.attributes = new Map();
      if (tag === 'iframe') {
        this.contentWindow = { location: { href: 'about:blank' }, messages: [],
          postMessage(data) { this.messages.push(data); } };
      }
    }
    appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
    insertBefore(child) { return this.appendChild(child); }
    remove() { this.removed = true; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    removeAttribute(name) { this.attributes.delete(name); }
    getBoundingClientRect() { return { left: 0, top: 0, bottom: this.id === 'dsh-au-top-host' ? 42 : 800, width: 1200, height: 800 }; }
    querySelectorAll(selector) { return selector === 'iframe' ? browser.frames : []; }
    closest() { return null; }
    submit() { browser.navigations.push({ action: this.action, target: this.target }); }
  }
  const body = new ElementBoundary('body');
  const head = new ElementBoundary('head');
  const center = new ElementBoundary('div');
  const main = center.appendChild(new ElementBoundary('main'));
  const overlay = new ElementBoundary('div');
  const document = {
    body, head, documentElement: new ElementBoundary('html'),
    createElement: (tag) => new ElementBoundary(tag),
    querySelector(selector) {
      if (selector === '[data-slot="main"]') return main;
      if (selector === '[data-shell-overlay]') return overlay;
      return null;
    },
    getElementById(id) { return [...head.children, ...center.children, ...overlay.children].find((node) => node.id === id); },
  };
  const window = {
    name: '', innerWidth: mobile ? 390 : 1200, navigator: { platform: 'Win32', userAgent: mobile ? 'Android Mobile' : electron ? 'Mozilla/5.0 Electron/44.0' : 'Desktop', maxTouchPoints: mobile ? 5 : 0 },
    matchMedia: () => ({ matches: mobile }),
    location: { href, assign: (url) => browser.navigations.push(url) },
    addEventListener, removeEventListener, dispatchEvent: (event) => emit(event.type, event),
    setTimeout: (callback, delay) => setTimer(callback, delay), clearTimeout: (id) => tasks.delete(id),
  };
  window.top = window;
  window.parent = window;
  const localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) };
  class ClockDate extends Date { static now() { return time; } }
  class ObserverBoundary { observe() {} disconnect() {} }
  // fetch is the HTTP boundary: product callApi and report functions execute unmodified;
  // fake only the server's JSON response and observe public diagnostic requests.
  const fetch = async (url, options) => {
    const payload = options?.body ? JSON.parse(options.body) : { action: 'getState' };
    browser.requests.push(payload);
    const data = payload.action === 'getState' ? browser.snapshot
      : payload.action === 'getInitialSessionFocus' ? browser.focusTargets?.[payload.deviceId] || { ok: true, sessionId: '', reason: 'keep-current' }
      : { ok: true };
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  Object.assign(browser, {
    window, document, emit, listeners, tasks,
    globals: {
      window, document, navigator: window.navigator, localStorage, sessionStorage: localStorage, fetch, URL,
      Date: ClockDate, Element: ElementBoundary, MutationObserver: ObserverBoundary, ResizeObserver: ObserverBoundary,
      setInterval: (callback, delay) => setTimer(callback, delay, delay), clearInterval: (id) => tasks.delete(id),
      requestAnimationFrame: (callback) => setTimer(callback, 16), cancelAnimationFrame: (id) => tasks.delete(id),
      CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    },
    async settle(host) {
      for (let i = 0; i < 8; i++) { await Promise.resolve(); host.render(); }
    },
    // Clock is an external boundary: run deadlines in order and settle async HTTP between ticks.
    async advance(milliseconds, host) {
      const target = time + milliseconds;
      let ticks = 0;
      while (true) {
        const next = [...tasks.entries()].filter(([, task]) => task.due <= target).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
        if (!next) break;
        assert.ok(++ticks < 500, 'clock did not settle');
        const [id, task] = next;
        time = task.due;
        if (task.interval) task.due += task.interval; else tasks.delete(id);
        task.callback();
        await browser.settle(host);
      }
      time = target;
      await browser.settle(host);
    },
  });
  return browser;
}

function device(id, routes = [{ id: `${id}-tunnel`, type: 'tunnel' }]) {
  return { id, name: id, routes: routes.map((route) => ({ ...route, url: route.url || `https://${route.id}.example/` })) };
}
function state(devices, overrides = {}) {
  return {
    ok: true, self: { deviceId: 'local-device', status: 'idle', localUrl: 'http://127.0.0.1:7984/', ips: [] },
    devices, remotes: devices.flatMap((entry) => entry.routes.map((route) => ({
      ...route, originUrl: route.url, proxyUrl: `http://127.0.0.1:${9000 + devices.indexOf(entry) * 10 + entry.routes.indexOf(route)}/`,
      status: 'idle', online: true, probeCompleted: true, ...overrides[route.id],
    }))),
  };
}
async function shell(t, snapshot, options = {}) {
  const browser = createBrowser({ snapshot, ...options });
  const host = createHookHost(browser);
  // Injected DSH layout APIs are host SDK boundaries; the host stays on its normal main panel.
  host.mount(host.exported.AuFleetShell, {
    selectPanel: options.selectPanel || (() => {}),
    collapseSidebar: options.collapseSidebar || (() => {}),
    expandSidebar: options.expandSidebar || (() => {}),
    toggleSidebar: options.toggleSidebar || (() => {}),
    usePanelInfo: options.usePanelInfo || ((selector) => selector({ activePanelId: options.activePanelId || null })),
  });
  t.after(() => host.unmount());
  await browser.settle(host);
  await browser.advance(20, host);
  return { browser, host };
}
const frames = (host) => host.nodes((node) => node.type === 'iframe');
const frame = (host, id) => frames(host).find((node) => node.props.name === `dsh-au-controlled:${id}`);
const loading = (host) => host.nodes((node) => node.props?.className === 'dsh-au-loading').length;
async function click(host, browser, label) {
  const node = host.nodes((entry) => entry.type === 'button' && (entry.props['aria-label'] === label
    || entry.props.title === label || text(entry).trim() === label))[0];
  assert.ok(node, `button ${label} must be rendered`);
  node.props.onClick({});
  await browser.settle(host);
}
/** 侧栏远程对话入口：打开嵌页舞台，不走顶栏整页跳转。 */
async function openStage(host, browser, deviceId) {
  browser.emit('dsh-au:select-device', { detail: { deviceId } });
  await browser.settle(host);
}
function text(node) {
  if (Array.isArray(node)) return node.map(text).join('');
  if (node === null || node === undefined) return '';
  return typeof node === 'object' ? text(node.props?.children) : String(node);
}
async function documentLoaded(node, browser, host, href = node.props.src) {
  node.element.contentWindow.location.href = href;
  node.props.onLoad({ currentTarget: node.element });
  await browser.settle(host);
}
async function update(snapshot, browser, host) {
  browser.snapshot = snapshot;
  await browser.advance(4000, host);
}
const events = (browser, event) => browser.requests.filter((request) => request.action === 'reportClientEvent' && request.event === event);

// Regression 2026-10-28: a transient offline probe previously removed the retained iframe.
test('opened remote survives offline recovery and preferred-route changes without losing its actual connection', async (t) => {
  const devices = [device('mac', [{ id: 'tunnel', type: 'tunnel' }, { id: 'lan', type: 'lan', url: 'http://192.0.2.10:31990/' }])];
  const { browser, host } = await shell(t, state(devices, { lan: { status: 'offline', online: false } }));
  await openStage(host, browser, 'mac');
  const original = frame(host, 'mac');
  assert.equal(events(browser, 'select-device').at(-1).result, 'still-loading');
  await documentLoaded(original, browser, host);
  await openStage(host, browser, 'mac');
  assert.equal(events(browser, 'select-device').at(-1).result, 'document-loaded', 'click diagnostics must reflect the latest load, not a stale callback');
  await update(state(devices, { tunnel: { status: 'offline', online: false }, lan: { status: 'offline', online: false } }), browser, host);
  assert.equal(frame(host, 'mac').element, original.element);
  assert.equal(frame(host, 'mac').props.src, original.props.src);
  assert.equal(frame(host, 'mac').componentKey, original.componentKey);
  assert.equal(frame(host, 'mac').props.style.display, 'block');
  assert.equal(loading(host), 0);
  await update(state(devices), browser, host);
  await click(host, browser, '返回本机对话');
  assert.equal(frame(host, 'mac').props.style.display, 'none');
  await openStage(host, browser, 'mac');
  assert.equal(frame(host, 'mac').element, original.element);
  assert.equal(frame(host, 'mac').props.src, original.props.src);
  await click(host, browser, '查看和编辑远程配置');
  const manager = host.nodes((node) => node.type === host.exported.RemoteManagerModal)[0];
  assert.equal(manager.props.currentConnections.mac, 'tunnel');
});

test('preloading requires completed probes and opens one hidden page at a time, reused by first selection', async (t) => {
  const devices = [device('alpha'), device('beta'), device('pending'), device('unknown'), device('gamma')];
  const blocked = { 'pending-tunnel': { probeCompleted: 1 }, 'unknown-tunnel': { status: 'unknown' } };
  const initial = state(devices, {
    'alpha-tunnel': { probeCompleted: false }, 'beta-tunnel': { probeCompleted: undefined }, 'gamma-tunnel': { probeCompleted: false }, ...blocked,
  });
  const { browser, host } = await shell(t, initial);
  browser.emit('dsh-au:preload-device', { detail: { deviceIds: ['alpha', 'beta', 'pending', 'unknown', 'gamma'] } });
  await browser.settle(host);
  await browser.advance(1000, host);
  assert.equal(frames(host).length, 0);
  const ready = state(devices, blocked);
  await update(ready, browser, host);
  browser.emit('dsh-au:preload-device', { detail: { deviceIds: ['alpha', 'beta', 'pending', 'unknown', 'gamma'] } });
  await browser.settle(host);
  await browser.advance(750, host);
  assert.equal(frames(host).length, 1);
  const alpha = frame(host, 'alpha');
  assert.ok(alpha);
  assert.equal(alpha.props.style.display, 'none');
  assert.equal(loading(host), 0, 'background preload must not change active device');
  await browser.advance(5000, host);
  assert.equal(frames(host).length, 1, 'another page waits for the in-flight preload');
  await documentLoaded(alpha, browser, host);
  // Replaying the same ordered plan must skip the already opened alpha and continue with beta.
  browser.emit('dsh-au:preload-device', { detail: { deviceIds: ['alpha', 'beta', 'pending', 'unknown', 'gamma'] } });
  await browser.settle(host);
  await browser.advance(750, host);
  const beta = frame(host, 'beta');
  assert.equal(frames(host).length, 2);
  assert.equal(beta.props.style.display, 'none');
  await openStage(host, browser, 'beta');
  assert.equal(frame(host, 'beta').element, beta.element);
  assert.equal(frame(host, 'beta').componentKey, beta.componentKey);
  assert.equal(frame(host, 'beta').props.style.display, 'block');
  await browser.advance(8000, host);
  assert.equal(frames(host).length, 2, 'completed pages are never duplicated and a truthy non-boolean probe is not accepted');
  await update(state(devices, { 'pending-tunnel': { probeCompleted: 1 }, 'unknown-tunnel': { status: 'unknown' } }), browser, host);
  assert.equal(frames(host).length, 2, 'a new eligible peer still waits for the loading page');
  frame(host, 'beta').props.onError();
  await browser.settle(host);
  browser.emit('dsh-au:preload-device', { detail: { deviceIds: ['alpha', 'beta', 'pending', 'unknown', 'gamma'] } });
  await browser.settle(host);
  await browser.advance(1500, host);
  assert.equal(frames(host).length, 3, 'an exhausted load failure releases the next queued preload');
  assert.equal(frame(host, 'gamma').props.style.display, 'none');
  assert.equal(frame(host, 'pending'), undefined, 'a truthy non-boolean probe must not pass the preload gate');
  assert.equal(frame(host, 'unknown'), undefined, 'a reachable unknown page is not a confirmed DSH peer');
});

test('empty explicit recent plan cancels pending background frames without affecting manual selection', async (t) => {
  const { browser, host } = await shell(t, state([device('mac'), device('win')]));
  browser.emit('dsh-au:preload-device', { detail: { deviceIds: ['mac', 'win'] } });
  await browser.settle(host);
  browser.emit('dsh-au:preload-device', { detail: { deviceIds: [] } });
  await browser.settle(host);
  await browser.advance(2000, host);
  assert.equal(frames(host).length, 0, 'empty recent plan must not create background frames');
  await openStage(host, browser, 'mac');
  assert.ok(frame(host, 'mac'), 'manual selection may still open an older device');
});

test('first visible entry focuses only its ready device, while preload and later switches never refocus', async (t) => {
  const { browser, host } = await shell(t, state([device('mac'), device('win')]));
  browser.emit('dsh-au:preload-device', { detail: { deviceIds: ['mac', 'win'] } });
  await browser.settle(host);
  browser.focusTargets = {
    mac: { ok: true, sessionId: 'mac-running', reason: 'busy' },
    win: { ok: true, sessionId: 'win-pending', reason: 'done' },
  };
  await browser.advance(750, host);
  await documentLoaded(frame(host, 'mac'), browser, host);
  await browser.advance(750, host);
  await documentLoaded(frame(host, 'win'), browser, host);
  const sent = (id) => frame(host, id).element.contentWindow.messages.filter((message) => message.type === 'initial-session-focus');
  assert.equal(sent('mac').length, 0, 'hidden preload must not choose a conversation');
  assert.equal(sent('win').length, 0);
  const acknowledge = async (id) => {
    const message = sent(id).at(-1);
    browser.emit('message', { source: frame(host, id).element.contentWindow, data: {
      source: 'dsh-au', type: 'initial-session-focus-result', requestId: message.requestId, sessionId: message.sessionId, result: 'applied',
    } });
    await browser.settle(host);
  };
  await openStage(host, browser, 'mac');
  assert.equal(sent('mac').at(-1).sessionId, 'mac-running');
  assert.equal(sent('win').length, 0, 'navigation must not broadcast to another device');
  await acknowledge('mac');
  await click(host, browser, '返回本机对话');
  await openStage(host, browser, 'mac');
  assert.equal(sent('mac').length, 1);
  await openStage(host, browser, 'win');
  assert.equal(sent('win').at(-1).sessionId, 'win-pending');
  await acknowledge('win');
  await browser.advance(5000, host);
  assert.equal(browser.requests.filter((request) => request.action === 'getInitialSessionFocus' && request.deviceId === 'mac').length, 1);
  assert.equal(browser.requests.filter((request) => request.action === 'getInitialSessionFocus' && request.deviceId === 'win').length, 1);
});

test('nonlocal browsers and compact mobile never preload or silently navigate', async (t) => {
  for (const options of [{ href: 'https://control.example/' }, { href: 'http://192.0.2.20:31990/' }, { mobile: true }]) {
    await t.test(JSON.stringify(options), async (subtest) => {
      const { browser, host } = await shell(subtest, state([device('mac')]), options);
      await browser.advance(10000, host);
      assert.equal(frames(host).length, 0);
      assert.deepEqual(browser.navigations, []);
      assert.equal(events(browser, 'iframe-mounted').length, 0);
    });
  }
});

test('browser topbar tab leaves the page; sidebar selection keeps the iframe', async (t) => {
  const devices = [device('mac', [{ id: 'tunnel', type: 'tunnel' }, { id: 'lan', type: 'lan', url: 'http://192.0.2.10:31990/' }])];
  const { browser, host } = await shell(t, state(devices, { lan: { status: 'offline', online: false } }));
  await click(host, browser, 'mac内网穿透');
  // 本机浏览器走本机代登录通道：地址里不带远端密码，也不再经过跳转接口。
  assert.deepEqual(browser.navigations, ['http://127.0.0.1:9000/']);
  assert.equal(frames(host).length, 0);
  browser.navigations.length = 0;
  await openStage(host, browser, 'mac');
  assert.deepEqual(browser.navigations, []);
  assert.ok(frame(host, 'mac'), 'sidebar selection must still embed the remote DSH');
});

test('electron topbar tab embeds the remote page and stays on the shell', async (t) => {
  const devices = [device('mac', [{ id: 'tunnel', type: 'tunnel' }, { id: 'lan', type: 'lan', url: 'http://192.0.2.10:31990/' }])];
  const { browser, host } = await shell(t, state(devices, { lan: { status: 'offline', online: false } }), { electron: true });
  await click(host, browser, 'mac内网穿透');
  assert.deepEqual(browser.navigations, []);
  assert.ok(frame(host, 'mac'), 'desktop shell must keep the remote page inside the current window');
});

test('browser topbar lan tab uses local auth-injecting proxy url', async (t) => {
  const devices = [device('mac', [{ id: 'lan', type: 'lan', url: 'http://192.0.2.10:31990/' }])];
  const { browser, host } = await shell(t, state(devices));
  await click(host, browser, 'mac局域网');
  assert.equal(browser.navigations[0], 'http://127.0.0.1:9000/');
  assert.equal(frames(host).length, 0);
});

test('compact mobile topbar still embeds instead of leaving', async (t) => {
  const { browser, host } = await shell(t, state([device('mac')]), { mobile: true });
  await click(host, browser, '拖动以移动；单击展开设备栏');
  await click(host, browser, 'mac内网穿透');
  assert.deepEqual(browser.navigations, []);
  assert.ok(frame(host, 'mac'));
});

test('explicit refresh adopts the newest route with a new page and ignores stale loaded/error callbacks', async (t) => {
  const devices = [device('mac', [{ id: 'tunnel', type: 'tunnel' }, { id: 'lan', type: 'lan', url: 'http://192.0.2.10:31990/' }])];
  const { browser, host } = await shell(t, state(devices, { lan: { status: 'offline', online: false } }));
  await openStage(host, browser, 'mac');
  const original = frame(host, 'mac');
  await documentLoaded(original, browser, host);
  await update(state(devices), browser, host);
  await click(host, browser, '刷新当前远程设备 mac');
  const refreshed = frame(host, 'mac');
  assert.notEqual(refreshed.element, original.element);
  assert.notEqual(refreshed.componentKey, original.componentKey);
  assert.equal(refreshed.props.src, 'http://127.0.0.1:9001/');
  assert.equal(loading(host), 1, 'old loaded state must not hide the new-page loading overlay');
  original.props.onError();
  // A late child callback is a public component input, not an internal helper mock.
  refreshed.componentProps.onLoaded(original.componentProps.frameKey, true, 'mac');
  refreshed.componentProps.onFailure('mac', original.componentProps.routeId, 'load-error', original.componentProps.frameKey);
  await browser.settle(host);
  assert.equal(frame(host, 'mac').element, refreshed.element);
  assert.equal(loading(host), 1, 'late success from the old key cannot mark the new page loaded');
  assert.equal(events(browser, 'iframe-reload').length, 1);
  await documentLoaded(refreshed, browser, host);
  assert.equal(loading(host), 0);
});

test('slow loading survives eight seconds and background switching, then the original thirty-second timeout falls back once', async (t) => {
  const devices = [device('mac', [{ id: 'first', type: 'tunnel' }, { id: 'second', type: 'tunnel' }])];
  const { browser, host } = await shell(t, state(devices));
  await openStage(host, browser, 'mac');
  const original = frame(host, 'mac');
  await browser.advance(9000, host);
  assert.equal(frame(host, 'mac').element, original.element);
  assert.equal(events(browser, 'iframe-reload').length, 0);
  await click(host, browser, '返回本机对话');
  await browser.advance(20999, host);
  assert.equal(frame(host, 'mac').element, original.element);
  await browser.advance(1, host);
  const fallback = frame(host, 'mac');
  assert.notEqual(fallback.element, original.element);
  assert.notEqual(fallback.props.src, original.props.src);
  assert.equal(fallback.props.style.display, 'none');
  assert.equal(events(browser, 'iframe-timeout').length, 1);
  assert.equal(events(browser, 'iframe-reload').length, 1);
  assert.equal(events(browser, 'iframe-reload')[0].reason, 'load-timeout');
  original.props.onError();
  await browser.settle(host);
  await browser.advance(1000, host);
  assert.equal(frame(host, 'mac').element, fallback.element);
  assert.equal(events(browser, 'iframe-reload').length, 1);
});

test('a previously loaded page shows an exhausted real load failure and clears it when the page recovers', async (t) => {
  const { browser, host } = await shell(t, state([device('mac')]));
  await openStage(host, browser, 'mac');
  const original = frame(host, 'mac');
  await documentLoaded(original, browser, host);
  original.props.onError();
  await browser.settle(host);
  const unavailable = () => host.nodes((node) => node.type?.name === 'UnavailableCard').length;
  assert.equal(unavailable(), 1, 'old successful load must not hide the real failure prompt');
  assert.equal(frame(host, 'mac').element, original.element, 'exhausted routes retain the page for possible recovery');
  assert.equal(events(browser, 'iframe-unavailable')[0].result, 'routes-exhausted');
  await documentLoaded(frame(host, 'mac'), browser, host);
  assert.equal(unavailable(), 0);
  assert.equal(loading(host), 0);
});

test('blank loads are ignored, document load supports legacy peers, and only the exact frame handshake reports ready', async (t) => {
  const browser = createBrowser({ snapshot: { ok: true } });
  const host = createHookHost(browser);
  const loaded = [];
  const failures = [];
  host.mount(host.exported.RemoteDshFrame, {
    deviceId: 'mac', routeId: 'tunnel', frameKey: 'mac_0', targetUrl: 'https://remote.example/', active: false,
    onLoaded: (...args) => loaded.push(args), onFailure: (...args) => failures.push(args),
  });
  t.after(() => host.unmount());
  const page = frames(host)[0];
  await documentLoaded(page, browser, host, 'about:blank');
  assert.equal(loaded.filter(([, success]) => success).length, 0);
  assert.equal(events(browser, 'iframe-loaded').length, 0);
  await documentLoaded(page, browser, host, 'https://remote.example/');
  assert.equal(loaded.filter(([, success]) => success).length, 1, 'legacy remote can dismiss loading after document load');
  assert.equal(events(browser, 'iframe-loaded')[0].result, 'document-loaded');
  const frameId = page.props['data-dsh-au-frame-id'];
  assert.ok(page.element.contentWindow.messages.some((message) => message.type === 'frame-probe' && message.frameId === frameId));
  const validData = { source: 'dsh-au', type: 'frame-ready', frameId };
  for (const event of [
    { source: {}, data: validData },
    { source: page.element.contentWindow, data: { ...validData, source: 'other' } },
    { source: page.element.contentWindow, data: { ...validData, type: 'other' } },
    { source: page.element.contentWindow, data: { ...validData, frameId: 'old-frame' } },
  ]) browser.emit('message', event);
  await browser.settle(host);
  assert.equal(events(browser, 'iframe-ready').length, 0);
  await browser.advance(6000, host);
  assert.equal(events(browser, 'iframe-ready-unconfirmed').length, 1);
  assert.equal(events(browser, 'iframe-ready-unconfirmed')[0].result, 'no-ready-ack');
  assert.deepEqual(failures, [], 'unconfirmed readiness must not cause a reload or failure');
  browser.emit('message', { source: page.element.contentWindow, data: validData });
  browser.emit('message', { source: page.element.contentWindow, data: validData });
  await browser.settle(host);
  assert.equal(events(browser, 'iframe-ready').length, 1);
  assert.ok(events(browser, 'iframe-ready')[0].clientId);
  assert.equal(events(browser, 'iframe-ready')[0].routeId, 'tunnel');
  host.unmount();
  browser.emit('message', { source: page.element.contentWindow, data: validData });
  await browser.advance(31000, { render() {} });
  assert.equal(events(browser, 'iframe-unmounted').length, 1);
  assert.equal(events(browser, 'iframe-ready').length, 1);
  assert.equal(events(browser, 'iframe-timeout').length, 0);
  assert.deepEqual(failures, []);
  assert.equal(browser.listeners.get('message')?.size || 0, 0);
  assert.equal(browser.tasks.size, 0);
});

test('a new document resets ready diagnostics and replaces the previous probe timers', async (t) => {
  const browser = createBrowser({ snapshot: { ok: true } });
  const host = createHookHost(browser);
  const failures = [];
  host.mount(host.exported.RemoteDshFrame, {
    deviceId: 'mac', routeId: 'tunnel', frameKey: 'mac_0', targetUrl: 'https://remote.example/', active: false,
    onLoaded() {}, onFailure: (...args) => failures.push(args),
  });
  t.after(() => host.unmount());
  const page = frames(host)[0];
  await documentLoaded(page, browser, host);
  const frameId = page.props['data-dsh-au-frame-id'];
  browser.emit('message', { source: page.element.contentWindow, data: { source: 'dsh-au', type: 'frame-ready', frameId } });
  await documentLoaded(page, browser, host, 'https://remote.example/next');
  await browser.advance(6000, host);
  assert.equal(events(browser, 'iframe-ready-unconfirmed').length, 1, 'old document readiness must not confirm the new document');
  assert.equal(page.element.contentWindow.messages.filter((message) => message.type === 'frame-probe').length, 5, 'old retry timers must not duplicate the new document probes');
  assert.deepEqual(failures, []);
});

// The controlled remote runs the actual runtime bridge, not a hand-authored ready responder.
test('controlled remote acknowledges probes from its parent only and stops responding when disposed', async (t) => {
  const browser = createBrowser({ snapshot: { ok: true } });
  const messages = [];
  browser.window.parent = { postMessage: (data) => messages.push(data) };
  const host = createHookHost(browser);
  const dispose = host.exported.installControlledFrameShortcutBridge();
  t.after(dispose);
  const data = { source: 'dsh-au', type: 'frame-probe', frameId: 'client:mac_0' };
  browser.emit('message', { source: {}, data });
  assert.deepEqual(messages, []);
  browser.emit('message', { source: browser.window.parent, data });
  assert.deepEqual(messages, [{ source: 'dsh-au', type: 'frame-ready', frameId: 'client:mac_0' }]);
  dispose();
  browser.emit('message', { source: browser.window.parent, data });
  assert.equal(messages.length, 1);
});

test('forwarded shortcuts open workbench modals and controlled host actions invoke layout callbacks while preserving the iframe', async (t) => {
  const selectedPanels = [];
  let sidebarToggled = 0;
  let activePanelId = null;
  const shellProps = {
    selectPanel: (id) => { selectedPanels.push(id); },
    toggleSidebar: () => { sidebarToggled++; },
    collapseSidebar() {},
    expandSidebar() {},
    usePanelInfo: (selector) => selector({ activePanelId }),
  };
  const { browser, host } = await shell(t, state([device('mac')]), shellProps);
  await openStage(host, browser, 'mac');
  const original = frame(host, 'mac');
  assert.ok(original);
  assert.equal(original.props.style.display, 'block');
  await documentLoaded(original, browser, host);

  browser.emit('message', {
    source: original.element.contentWindow,
    data: { source: 'dsh-au', type: 'shortcut-action', action: 'menu.open' },
  });
  await browser.settle(host);
  let modal = host.nodes((node) => node.type === host.exported.UnifiedWorkbenchModal)[0];
  assert.ok(modal, 'forwarded menu.open opens UnifiedWorkbenchModal');
  assert.equal(modal.props.initialTab, 'fav');

  browser.emit('message', {
    source: original.element.contentWindow,
    data: { source: 'dsh-au', type: 'shortcut-action', action: 'services.open' },
  });
  await browser.settle(host);
  modal = host.nodes((node) => node.type === host.exported.UnifiedWorkbenchModal)[0];
  assert.ok(modal, 'forwarded services.open switches UnifiedWorkbenchModal tab');
  assert.equal(modal.props.initialTab, 'services');
  modal.props.onClose();
  await browser.settle(host);
  assert.equal(host.nodes((node) => node.type === host.exported.UnifiedWorkbenchModal).length, 0);

  browser.emit('message', {
    source: original.element.contentWindow,
    data: { source: 'dsh-au', type: 'dsh-au:controlled-host-action', action: 'toggle-sidebar' },
  });
  await browser.settle(host);
  assert.equal(sidebarToggled, 1, 'controlled toggle-sidebar invokes host toggleSidebar');
  assert.equal(frame(host, 'mac').element, original.element);

  browser.emit('message', {
    source: original.element.contentWindow,
    data: { source: 'dsh-au', type: 'dsh-au:controlled-host-action', action: 'select-panel', panelId: 'plugins' },
  });
  await browser.settle(host);
  assert.equal(selectedPanels.at(-1), 'plugins', 'controlled select-panel invokes host selectPanel with panelId');
  assert.equal(frame(host, 'mac').element, original.element, 'stage iframe element is preserved');
  assert.equal(frame(host, 'mac').props.style.display, 'none', 'stage iframe is hidden when switched to host panel');

  await openStage(host, browser, 'mac');
  assert.equal(frame(host, 'mac').props.style.display, 'block');
  activePanelId = 'settings';
  host.mount(host.exported.AuFleetShell, shellProps);
  await browser.settle(host);
  assert.equal(frame(host, 'mac').element, original.element, 'iframe element is preserved when activePanelId changes');
  assert.equal(frame(host, 'mac').props.style.display, 'none', 'stage iframe is hidden when host panel is active');
});
