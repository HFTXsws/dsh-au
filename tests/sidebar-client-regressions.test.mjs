import './isolate-net-log.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { build } from '../scripts/build-client.js';
import { createRemoteProxyPool } from '../lib/remote-proxy-pool.js';

// Browser messaging, DOM, time and HTTP are boundaries; all plugin reducers and controllers are real.
function browser(fetchImpl = async () => ({ json: async () => ({ ok: true, remoteWorkspaces: [] }) })) {
  const listeners = new Map();
  const messages = [];
  const disposers = [];
  const win = {
    name: '', innerWidth: 1280, innerHeight: 800,
    navigator: { userAgent: 'Desktop', platform: 'Win32', maxTouchPoints: 0 },
    location: { href: 'http://127.0.0.1:6534/' },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatchEvent(event) { for (const fn of [...(listeners.get(event.type) || [])]) fn(event); },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
  };
  const frameWindow = { postMessage(data) { messages.push(data); } };
  const frame = { name: 'dsh-au-controlled:mac', contentWindow: frameWindow };
  const doc = {
    visibilityState: 'visible', hasFocus: () => true, activeElement: null,
    documentElement: { setAttribute() {}, getAttribute: () => null },
    querySelector: () => null, querySelectorAll: () => [frame],
    addEventListener() {}, removeEventListener() {},
  };
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  class Event { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } }
  let descriptor;
  win.__ModuleLoader__ = { load(value) { descriptor = value; } };
  const footer = "return { name: 'dsh-au', inject, apply, mobile: mobileClient.helpers, shortcuts: shortcutHelpers };";
  const source = build().replace(footer, 'return { apply, controller: remoteWorkspacesClient.apply };');
  new Function('window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'fetch', 'CustomEvent', source)(
    win, doc, win.navigator, storage, storage, fetchImpl, Event,
  );
  const react = {
    createElement: (type, props) => ({ type, props }), Fragment: Symbol('Fragment'),
    useState: (value) => [value, () => {}], useEffect() {}, useCallback: (fn) => fn, useRef: (value) => ({ current: value }),
  };
  const client = descriptor.factory((id) => {
    if (id === 'react') return react;
    if (id === 'react-dom') return {};
    throw new Error(`unexpected external dependency: ${id}`);
  });
  return {
    helpers: client.apply.remoteWorkspaces, win, doc, frameWindow, messages,
    mount() { client.controller({ effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); } }); },
    emit(data) { win.dispatchEvent({ type: 'message', source: frameWindow, data }); },
    dispose() { for (const fn of disposers.reverse()) fn(); },
  };
}
test('remote probes preserve safe event and acknowledgement watermarks for sidebar reconciliation', async (t) => {
  const expected = { status: 'idle', stateSeq: 5, endSeq: 5, ackedSeq: 5 };
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ self: { status: 'idle', statusV2: 'idle', sessionStateVersion: 1,
      sessionStatesV2: { s: 'idle' }, sessionStateDetails: {
        s: { ...expected, unexpected: 'must-not-propagate' },
        unknown: { status: 'idle', stateSeq: -1, endSeq: -1, ackedSeq: -1 },
        invalid: { status: 'done', stateSeq: 1.5, endSeq: 1, ackedSeq: -1 },
        impossible: { status: 'idle', stateSeq: -1, endSeq: 50, ackedSeq: 50 },
        replay: { status: 'idle', stateSeq: 5, endSeq: 5, ackedSeq: 7 },
      },
    } }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const pool = createRemoteProxyPool();
  t.after(async () => {
    pool.stopAll();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  const remotes = [{ id: 'route', deviceId: 'mac', name: 'mac', url: `http://127.0.0.1:${server.address().port}/` }];
  await pool.probeAll(remotes);
  const [peer] = await pool.syncRemotes(remotes);
  assert.equal(peer.sessionStateVersion, 1);
  assert.deepEqual(peer.sessionStateDetails.s, expected);
  assert.deepEqual(peer.sessionStateDetails.unknown, { status: 'idle', stateSeq: -1, endSeq: -1, ackedSeq: -1 });
  assert.equal(Object.hasOwn(peer.sessionStateDetails, 'invalid'), false);
  assert.equal(Object.hasOwn(peer.sessionStateDetails, 'impossible'), false);
  assert.deepEqual(peer.sessionStateDetails.replay, { status: 'idle', stateSeq: 5, endSeq: 5, ackedSeq: 7 });
});

const workspace = (sessions) => ({ deviceId: 'mac', deviceName: 'mac', workspaceId: 'ws', title: 'Project', path: '/project', sessions });
const session = (sessionId, status, updatedAt, extra = {}) => ({ sessionId, title: sessionId, status, updatedAt, ...extra });

// CR 2026-10-30: server idle is processed before live busy on every merge, releasing the live sort lock.
test('dual-channel running sessions retain order until the merged turn finishes', () => {
  const { helpers: h } = browser();
  const server = [workspace([session('one', 'idle', 100), session('two', 'idle', 90)])];
  const merge = (one, two, status = 'busy') => h.mergeRemoteWorkspaces(server, new Map([['mac', {
    workspaces: [workspace([session('one', status, one), session('two', status, two)])],
  }]])).visible[0];
  const first = merge(2000, 1000);
  const second = merge(2500, 3000);
  assert.deepEqual(first.sessions.map((s) => s.sessionId), ['one', 'two']);
  assert.deepEqual(second.sessions.map((s) => s.sessionId), ['one', 'two']);
  assert.equal(second.sortUpdatedAt, first.sortUpdatedAt);
  const finished = merge(2500, 3000, 'done');
  assert.deepEqual(finished.sessions.map((s) => s.sessionId), ['two', 'one']);
});

// State ordering uses the owning session's event/ack watermarks, never semantic status priority.
for (const [name, server, live, expected] of [
  ['new running turn defeats an old completion', session('s', 'done', 1000, { stateSeq: 2, endSeq: 2, ackedSeq: -1 }), session('s', 'busy', 2000, { stateSeq: 3, endSeq: -1, ackedSeq: -1 }), 'busy'],
  ['new completion defeats an old waiting turn', session('s', 'waiting', 1000, { stateSeq: 2, endSeq: -1, ackedSeq: -1 }), session('s', 'done', 2000, { stateSeq: 3, endSeq: 3, ackedSeq: -1, completionUnread: true }), 'done'],
  ['shared acknowledgement defeats stale unread at the same event sequence', session('s', 'idle', 1000, { stateSeq: 3, endSeq: 3, ackedSeq: 3 }), session('s', 'done', 2000, { stateSeq: 3, endSeq: 3, ackedSeq: -1, completionUnread: true }), 'idle'],
]) {
  test(name, () => {
    const { helpers: h } = browser();
    const result = h.mergeRemoteWorkspaces([workspace([server])], new Map([['mac', { workspaces: [workspace([live])] }]])).visible[0].sessions[0];
    assert.equal(result.status, expected);
    assert.equal(Boolean(result.completionUnread), expected === 'done');
    assert.equal(result.stateSeq, Math.max(server.stateSeq, live.stateSeq));
  });
}

test('confirming a seen completion does not hide a newer short turn that skips the busy snapshot', () => {
  const { helpers: h } = browser();
  h.store.serverWorkspaces = [workspace([session('s', 'done', 1000, { stateSeq: 2, endSeq: 2, ackedSeq: -1, completionUnread: true })])];
  h.confirmRemoteSessionOptimistically('mac', 's', { sendRpc: false });
  const result = h.normalizeServerRemoteWorkspaces({ remoteWorkspaces: [workspace([
    session('s', 'done', 2000, { stateSeq: 4, endSeq: 4, ackedSeq: 2, completionUnread: true }),
  ])] })[0].sessions[0];
  assert.equal(result.status, 'done');
  assert.equal(result.completionUnread, true);
});

for (const failure of ['refused', 'offline']) {
  test(`a ${failure} confirmation restores only its observed completion rather than leaving a false read`, async () => {
    const { helpers: h } = browser(async () => {
      if (failure === 'offline') throw new Error('offline');
      return { json: async () => ({ ok: false, confirmed: false }) };
    });
    h.store.serverWorkspaces = [workspace([session('s', 'done', 1000, { stateSeq: 2, endSeq: 2, ackedSeq: -1, completionUnread: true })])];
    h.confirmRemoteSessionOptimistically('mac', 's');
    await new Promise(setImmediate);
    const result = h.rebuildNativeRemoteRegistry().visible[0].sessions[0];
    assert.equal(result.status, 'done');
    assert.equal(result.completionUnread, true);
  });
}

test('an older failed confirmation does not roll back a newer completed turn', async () => {
  let rejectOld;
  const { helpers: h } = browser(() => new Promise((resolve) => { rejectOld = resolve; }));
  h.store.serverWorkspaces = [workspace([session('s', 'done', 1000, { stateSeq: 2, endSeq: 2, ackedSeq: -1, completionUnread: true })])];
  h.confirmRemoteSessionOptimistically('mac', 's');
  h.store.serverWorkspaces = [workspace([session('s', 'error', 2000, { stateSeq: 4, endSeq: 4, ackedSeq: -1, completionUnread: true })])];
  rejectOld({ json: async () => ({ ok: false, confirmed: false }) });
  await new Promise(setImmediate);
  const result = h.rebuildNativeRemoteRegistry().visible[0].sessions[0];
  assert.equal(result.status, 'error');
  assert.equal(result.endSeq, 4);
  assert.equal(result.completionUnread, true);
});

test('a new completed end within the legacy debounce interval still sends its own acknowledgement', async () => {
  const requestedEnds = [];
  const { helpers: h } = browser(async (_url, options) => {
    requestedEnds.push(JSON.parse(options.body).expectedEndSeq);
    return { json: async () => ({ ok: true, confirmed: true }) };
  });
  h.store.serverWorkspaces = [workspace([session('s', 'done', 1000, { stateSeq: 2, endSeq: 2, ackedSeq: -1, completionUnread: true })])];
  h.confirmRemoteSessionOptimistically('mac', 's');
  await new Promise(setImmediate);
  h.store.serverWorkspaces = [workspace([session('s', 'done', 2000, { stateSeq: 4, endSeq: 4, ackedSeq: 2, completionUnread: true })])];
  h.confirmRemoteSessionOptimistically('mac', 's');
  await new Promise(setImmediate);
  assert.deepEqual(requestedEnds, [2, 4]);
});

test('server reconciliation never clears a newer completed turn using an older idle snapshot', () => {
  const { helpers: h } = browser();
  h.store.serverWorkspaces = [workspace([session('s', 'idle', 1000, { stateSeq: 2, endSeq: 2, ackedSeq: 2 })])];
  h.store.controlledSnapshots.set('mac', { workspaces: [workspace([
    session('s', 'done', 2000, { stateSeq: 4, endSeq: 4, ackedSeq: 2, completionUnread: true }),
  ])] });
  h.reconcileConfirmedSessionsWithServer(null);
  const result = h.store.controlledSnapshots.get('mac').workspaces[0].sessions[0];
  assert.equal(result.status, 'done');
  assert.equal(result.completionUnread, true);
});

test('a shared acknowledgement at the observed end sequence clears immediately despite a recent busy observation', () => {
  const { helpers: h } = browser();
  h.store.recentBusyAtBySession.set('s', Date.now());
  h.store.serverWorkspaces = [workspace([session('s', 'idle', 2000, { stateSeq: 4, endSeq: 4, ackedSeq: 4 })])];
  h.store.controlledSnapshots.set('mac', { workspaces: [workspace([
    session('s', 'done', 2000, { stateSeq: 4, endSeq: 4, ackedSeq: 2, completionUnread: true }),
  ])] });
  h.reconcileConfirmedSessionsWithServer(null);
  const result = h.store.controlledSnapshots.get('mac').workspaces[0].sessions[0];
  assert.equal(result.status, 'idle');
  assert.equal(result.completionUnread, false);
  assert.equal(result.ackedSeq, 4);
});

test('device badges display names as text rather than parsing untrusted markup', () => {
  const { helpers: h } = browser();
  const name = '<img src=x onerror="void 0">';
  h.store.serverWorkspaces = [{ ...workspace([]), deviceName: name }];
  const nodes = [];
  const container = { querySelector: () => null, appendChild(node) { node.parentElement = this; } };
  const row = {
    getAttribute: () => 'workspace:dsh-au-remote-ws:mac:ws', setAttribute() {},
    querySelector(selector) { return selector.includes('_projectText') ? container : null; },
  };
  const doc = {
    querySelectorAll: (selector) => selector.startsWith('[data-row-key^="workspace:') ? [row] : [],
    createElement() {
      const attrs = new Map();
      const node = { children: [], innerHTML: '', textContent: '',
        setAttribute(key, value) { attrs.set(key, value); }, getAttribute: (key) => attrs.get(key),
        appendChild(child) { this.children.push(child); child.parentElement = this; },
      };
      nodes.push(node);
      return node;
    },
  };
  h.decorateNativeRemoteRows(doc);
  assert.ok(nodes.some((node) => node.textContent === name));
  assert.ok(nodes.every((node) => !node.innerHTML.includes(name)));
});

test('a delayed native confirmation event cannot acknowledge the next completed turn', (t) => {
  const env = browser();
  t.after(() => env.dispose());
  env.mount();
  const h = env.helpers;
  h.store.serverWorkspaces = [workspace([session('s', 'error', 2000, { stateSeq: 4, endSeq: 4, ackedSeq: 2, completionUnread: true })])];
  env.emit({ source: 'dsh-au', type: 'remote-session-confirmed', sessionId: 's', endSeq: 2 });
  assert.equal(h.store.serverWorkspaces[0].sessions[0].status, 'error');
  assert.equal(h.store.serverWorkspaces[0].sessions[0].completionUnread, true);
  env.emit({ source: 'dsh-au', type: 'remote-session-confirmed', sessionId: 's', endSeq: 4 });
  assert.equal(h.store.serverWorkspaces[0].sessions[0].status, 'idle');
});

test('cancelled devices keep live content and resume their snapshot selection without replaying old navigation', (t) => {
  const env = browser();
  t.after(() => env.dispose());
  env.mount();
  const h = env.helpers;
  const ws = workspace([session('one', 'idle', 1), session('two', 'idle', 2)]);
  h.store.serverWorkspaces = [ws];
  h.activateRemoteSession(ws, ws.sessions[0]);
  env.win.dispatchEvent({ type: 'dsh-au:active-device-change', detail: { activeId: 'local' } });
  const cancellation = env.messages.find((m) => m.type === 'dsh-au:cancel-remote-navigation');
  const snapshot = { source: 'dsh-au', type: 'dsh-au:controlled-workspaces-snapshot', selectionSeq: cancellation.selectionSeq,
    currentSessionId: 'two', workspaces: [{ ...ws, title: 'Live project' }] };
  env.emit(snapshot);
  assert.equal(h.store.controlledSnapshots.get('mac').workspaces[0].title, 'Live project');
  assert.equal(h.store.selectedSessionByDevice.get('mac'), 'one');
  env.win.dispatchEvent({ type: 'dsh-au:active-device-change', detail: { activeId: 'mac' } });
  env.emit(snapshot);
  assert.equal(h.store.selectedSessionByDevice.get('mac'), 'two');
});

test('superseded ACKs and snapshots cannot replace the latest sidebar selection', async (t) => {
  const env = browser();
  t.after(() => env.dispose());
  env.mount();
  const h = env.helpers;
  const ws = workspace([session('one', 'idle', 1), session('two', 'idle', 2)]);
  h.store.serverWorkspaces = [ws];
  h.activateRemoteSession(ws, ws.sessions[0]);
  const first = env.messages.find((m) => m.type === 'dsh-au:open-remote-session');
  h.activateRemoteSession(ws, ws.sessions[1]);
  const second = env.messages.filter((m) => m.type === 'dsh-au:open-remote-session').at(-1);
  env.emit({ source: 'dsh-au', type: 'dsh-au:remote-command-ack', commandId: first.commandId, stage: 'done', sessionId: 'one' });
  assert.equal(h.store.selectedSessionByDevice.get('mac'), 'two');
  env.emit({ source: 'dsh-au', type: 'dsh-au:controlled-workspaces-snapshot', navigationCommandId: first.commandId,
    selectionSeq: first.selectionSeq, currentSessionId: 'one', workspaces: [ws] });
  assert.equal(h.store.selectedSessionByDevice.get('mac'), 'two');
  env.emit({ source: 'dsh-au', type: 'dsh-au:remote-command-ack', commandId: second.commandId,
    selectionSeq: second.selectionSeq, stage: 'done', sessionId: 'two' });
  assert.equal(h.store.selectedSessionByDevice.get('mac'), 'two');
  env.emit({ source: 'dsh-au', type: 'dsh-au:controlled-workspaces-snapshot', currentSessionId: 'one', workspaces: [ws] });
  assert.equal(h.store.selectedSessionByDevice.get('mac'), 'two', 'an unlabelled legacy snapshot cannot undo a completed newer intent');
});

test('groupCombinedWorkspacesByDevice places the most recently active device group and workspace at the top', async (t) => {
  const env = browser();
  t.after(() => env.dispose());
  env.mount();
  const h = env.helpers;
  const localItems = [
    { workspaceId: 'local-old', title: '默认工作区' },
    { workspaceId: 'local-new', title: 'AuWin' },
  ];
  const remoteItems = [
    { workspaceId: 'dsh-au-remote-ws:win2:w1', remoteDeviceId: 'win2', remoteDeviceName: 'win-box', sortUpdatedAt: 900 },
    { workspaceId: 'dsh-au-remote-ws:mac:m1', remoteDeviceId: 'mac', remoteDeviceName: 'mac', sortUpdatedAt: 100 },
    { workspaceId: 'dsh-au-remote-ws:mac:m2', remoteDeviceId: 'mac', remoteDeviceName: 'mac', sortUpdatedAt: 500 },
  ];
  const localUpdatedById = new Map([['local-old', 10], ['local-new', 200]]);
  const ordered = h.groupCombinedWorkspacesByDevice(localItems, remoteItems, { localUpdatedById, orderBy: 'recent' });
  assert.deepEqual(
    ordered.map((ws) => ws.workspaceId),
    ['dsh-au-remote-ws:win2:w1', 'dsh-au-remote-ws:mac:m2', 'dsh-au-remote-ws:mac:m1', 'local-new', 'local-old'],
  );

  // 本机刚发新对话时，本机分组和对应工作区一起排到最顶部
  const localUpdatedLater = new Map([['local-old', 10], ['local-new', 1200]]);
  const orderedAfterLocalPrompt = h.groupCombinedWorkspacesByDevice(localItems, remoteItems, { localUpdatedById: localUpdatedLater, orderBy: 'recent' });
  assert.deepEqual(
    orderedAfterLocalPrompt.map((ws) => ws.workspaceId),
    ['local-new', 'local-old', 'dsh-au-remote-ws:win2:w1', 'dsh-au-remote-ws:mac:m2', 'dsh-au-remote-ws:mac:m1'],
  );
});

test('scrollSidebarToTop smoothly scrolls the treeBody container to the top', async (t) => {
  const env = browser();
  t.after(() => env.dispose());
  env.mount();
  const h = env.helpers;
  const calls = [];
  const scroller = {
    scrollTo: (opts) => calls.push(opts),
    scrollTop: 320,
  };
  const treeContainer = {
    closest: (sel) => (sel.includes('_treeBody') ? scroller : null),
  };
  const doc = { querySelector: (sel) => (sel.includes('role="tree"') ? treeContainer : null) };
  assert.equal(h.scrollSidebarToTop(doc), true);
  assert.deepEqual(calls, [{ top: 0, behavior: 'smooth' }]);
});

test('decorateSidebarDeviceGroups renders collapsible device headers when remote workspaces exist and clears on local-only', async (t) => {
  const env = browser();
  t.after(() => env.dispose());
  env.mount();
  const h = env.helpers;
  h.store.devices = [{ id: 'mac', name: 'mac', transport: 'tunnel', online: true }];
  h.store.nativeWorkspaceById.set('dsh-au-remote-ws:mac:ws1', { deviceId: 'mac', deviceName: 'mac', workspaceId: 'ws1' });

  function makeClassList(initial = []) {
    const set = new Set(initial);
    return {
      add: (...names) => names.forEach((n) => set.add(n)),
      remove: (...names) => names.forEach((n) => set.delete(n)),
      has: (name) => set.has(name),
      toArray: () => [...set],
    };
  }
  function makeSection(rowKey) {
    const rowEl = { getAttribute: (name) => (name === 'data-row-key' ? rowKey : null) };
    return {
      classList: makeClassList(['_groupSection_1']),
      style: {},
      querySelector: (sel) => (sel.includes('workspace:') ? rowEl : null),
    };
  }
  const headers = [];
  const sections = [
    makeSection('workspace:local-auwin'),
    makeSection('workspace:dsh-au-remote-ws:mac:ws1'),
  ];
  const treeContainer = {
    classList: makeClassList(['_list_1']),
    children: sections,
    appendChild(node) { headers.push(node); },
    querySelectorAll(sel) {
      if (sel.includes('_groupSection')) return sections;
      if (sel.includes('data-dsh-au-device-group-header')) return headers.filter((n) => !n.__removed);
      return [];
    },
    querySelector() { return null; },
  };
  const makeNode = (tag) => {
    const attrs = new Map();
    const listeners = new Map();
    const node = {
      tagName: tag.toUpperCase(),
      style: {},
      children: [],
      setAttribute: (k, v) => attrs.set(k, String(v)),
      getAttribute: (k) => attrs.get(k) ?? null,
      addEventListener: (type, fn) => listeners.set(type, fn),
      click: () => listeners.get('click')?.({ stopPropagation() {} }),
      appendChild: (c) => node.children.push(c),
      remove: () => { node.__removed = true; },
    };
    return node;
  };
  const doc = {
    querySelector: (sel) => (sel.includes('role="tree"') ? treeContainer : null),
    createElement: makeNode,
  };

  h.decorateSidebarDeviceGroups(doc);
  assert.equal(treeContainer.classList.has('dsh-au-ws-grouped-tree'), true);
  assert.equal(headers.length, 2);
  assert.equal(headers[0].getAttribute('data-dsh-au-group-key'), 'local');
  assert.equal(headers[1].getAttribute('data-dsh-au-group-key'), 'remote:mac');
  assert.equal(sections[0].classList.has('dsh-au-ws-grouped-item'), true);
  assert.equal(sections[1].classList.has('dsh-au-ws-group-hidden'), false);

  headers[1].click();
  assert.equal(sections[1].classList.has('dsh-au-ws-group-hidden'), true);
  assert.equal(headers[1].getAttribute('aria-expanded'), 'false');

  headers[1].click();
  assert.equal(sections[1].classList.has('dsh-au-ws-group-hidden'), false);
  assert.equal(headers[1].getAttribute('aria-expanded'), 'true');

  // 切回纯本机时，自动清理设备分组标题与缩进
  sections.pop();
  h.decorateSidebarDeviceGroups(doc);
  assert.equal(treeContainer.classList.has('dsh-au-ws-grouped-tree'), false);
  assert.equal(headers.every((n) => n.__removed), true);
  assert.equal(sections[0].classList.has('dsh-au-ws-grouped-item'), false);
});

test('resolveDevicePillStatus shows preloading dot for idle/done devices and preserves busy/waiting/error/offline', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../client/src/11-shell.js', import.meta.url), 'utf8');
  const start = source.indexOf('function resolveDevicePillStatus');
  const end = source.indexOf('// END resolveDevicePillStatus');
  assert.ok(start >= 0 && end > start, '11-shell.js should define resolveDevicePillStatus');
  const resolveDevicePillStatus = new Function(`${source.slice(start, end)}\nreturn resolveDevicePillStatus;`)();

  assert.equal(resolveDevicePillStatus({ status: 'idle' }, { preloading: true }), 'preloading');
  assert.equal(resolveDevicePillStatus({ status: 'done' }, { preloading: true }), 'preloading');
  assert.equal(resolveDevicePillStatus({ status: 'idle' }, { preloading: false }), 'idle');
  assert.equal(resolveDevicePillStatus({ status: 'busy' }, { preloading: true }), 'busy');
  assert.equal(resolveDevicePillStatus({ status: 'waiting' }, { preloading: true }), 'waiting');
  assert.equal(resolveDevicePillStatus({ status: 'error' }, { preloading: true }), 'error');
  assert.equal(resolveDevicePillStatus({ status: 'offline' }, { preloading: true }), 'offline');
});

test('createNew falls back to backend createRemoteSession when controlled iframe reports open-failed after received ack', async (t) => {
  const createRequests = [];
  let createResolvedResolve = null;
  const createDone = new Promise((r) => { createResolvedResolve = r; });
  const env = browser(async (url, init) => {
    const body = JSON.parse(init?.body || '{}');
    if (url === '/dsh-au-todo/api' && body.action === 'createRemoteSession') {
      createRequests.push(body);
      const res = {
        json: async () => ({
          ok: true,
          sessionId: 's-mac-fallback-1',
          workspaceId: 'ws-mac-1',
          cwd: '/Users/example/DemoApp',
        }),
      };
      createResolvedResolve?.();
      return res;
    }
    return { json: async () => ({ ok: true, remoteWorkspaces: [] }) };
  });
  t.after(() => env.dispose());
  env.mount();
  const h = env.helpers;
  const ws = workspace([session('s-old-1', 'idle', 1)]);
  h.store.serverWorkspaces = [ws];
  h.store.controlledSnapshots.set('mac', { fromControlledFrame: true, updatedAt: Date.now(), workspaces: [ws] });

  h.activateRemoteWorkspace(ws, { createNew: true }, env.doc);
  const openWsMsg = env.messages.find((m) => m?.type === 'dsh-au:open-remote-workspace');
  assert.ok(openWsMsg, 'should initially dispatch dsh-au:open-remote-workspace to live controlled iframe');

  env.emit({
    source: 'dsh-au',
    type: 'dsh-au:remote-command-ack',
    commandId: openWsMsg.commandId,
    navigationCommandId: openWsMsg.commandId,
    selectionSeq: openWsMsg.selectionSeq,
    stage: 'received',
  });
  env.emit({
    source: 'dsh-au',
    type: 'dsh-au:remote-command-ack',
    commandId: openWsMsg.commandId,
    navigationCommandId: openWsMsg.commandId,
    selectionSeq: openWsMsg.selectionSeq,
    stage: 'done',
    result: 'open-failed',
  });

  await createDone;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(createRequests.length, 1, 'open-failed must trigger backend createRemoteSession fallback');
  assert.equal(h.store.selectedSessionByDevice.get('mac'), 's-mac-fallback-1');
});
