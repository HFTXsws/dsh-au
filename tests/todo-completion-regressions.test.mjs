import './isolate-net-log.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../scripts/build-client.js';
const recentAt = Date.now() - 1000;
const card = (extra = {}) => ({
  deviceId: 'mac', deviceName: 'mac', sessionId: 's1', title: 'RSS task',
  status: 'idle', priority: 'P2', updatedAt: recentAt, stateSeq: 10, ...extra,
});
const response = (cards, extra = {}) => ({ ok: true, cards, localDeviceId: 'self', authoritativeDeviceIds: ['self', 'mac'], ...extra });
const json = (data, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => data });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const flush = () => new Promise(setImmediate);

// Only browser/React rendering, timers and HTTP are replaced. All TODO handlers and reducers execute unchanged.
function panel(fetchImpl, snap = { self: { deviceId: 'self' }, remotes: [] }, options = {}) {
  const slots = [], effects = [], timers = new Set(), listeners = new Map();
  const domRows = new Map();
  let cursor = 0, selectedId = options.selectedSessionId || '', focusCount = 0;
  // Measured browser geometry: 50px rows inside a 100px scroll viewport, independent of page scrolling.
  const list = { scrollTop: 0, clientTop: 0, clientHeight: 100, getBoundingClientRect: () => ({ top: 0, bottom: 100 }) };
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const i = cursor++;
      if (!slots[i]) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[i].value, (next) => { slots[i].value = typeof next === 'function' ? next(slots[i].value) : next; }];
    },
    useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial }; },
    useCallback(fn, deps) {
      const i = cursor++;
      if (!sameDeps(slots[i]?.deps, deps)) slots[i] = { value: fn, deps };
      return slots[i].value;
    },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!sameDeps(slots[i]?.deps, deps)) {
        const previous = slots[i];
        slots[i] = { deps };
        effects.push(() => { previous?.dispose?.(); slots[i].dispose = fn(); });
      }
    },
  };
  class Event { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } }
  const win = {
    __dshAuLastStateSnap: snap, innerWidth: 1200, innerHeight: 800,
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); },
    setInterval(fn) { timers.add(fn); return fn; }, clearInterval(fn) { timers.delete(fn); },
  };
  const doc = { visibilityState: 'visible', querySelector: () => null };
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  win.navigator = { userAgent: 'Desktop', platform: 'Win32', maxTouchPoints: 0 };
  win.location = { href: 'http://localhost/' };
  let descriptor;
  win.__ModuleLoader__ = { load(value) { descriptor = value; } };
  // Test-only component export; use the full bundle so even unrelated transport helpers remain real.
  const patched = build().replace('          cycleWaitingSessionGlobal,', "          TodoDockInner, setTodoPanelOpen, TodoCycleNotice: typeof TodoCycleNotice === 'function' ? TodoCycleNotice : null, cycleWaitingSessionGlobal,")
    .replace("return { name: 'dsh-au', inject, apply, mobile: mobileClient.helpers, shortcuts: shortcutHelpers };", 'return { ...todoClient.helpers, remoteWorkspaces: remoteWorkspacesClient.helpers };');
  new Function('window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'fetch', 'CustomEvent', 'setInterval', 'clearInterval', patched)(
    win, doc, win.navigator, storage, storage, fetchImpl, Event, win.setInterval, win.clearInterval,
  );
  // Native Toast is an external host UI boundary; inspect its visible text and simulate its completion callback.
  const HostToast = () => null;
  const helpers = descriptor.factory((id) => id === 'react' ? react
    : id === '@deepseek-ai/dsh-client-ui-primitives' ? { Toast: HostToast } : {});
  helpers.setTodoPanelOpen(true);
  const render = () => {
    cursor = 0;
    const tree = options.toastOnly ? helpers.TodoCycleNotice?.() || null
      : helpers.TodoDockInner({ openSession() {}, useSelectedSession: () => selectedId });
    let index = 0;
    for (const node of nodes(tree)) {
      if (node.props?.className === 'dsh-au-todo-list' && node.props.ref) node.props.ref.current = list;
      if (node.type === 'article') {
        let row = domRows.get(node.props.key);
        if (!row) {
          row = { focus() { focusCount++; }, getBoundingClientRect() {
            const top = this.index * 50 - list.scrollTop;
            return { top, bottom: top + 50, height: 50 };
          } };
          domRows.set(node.props.key, row);
        }
        row.index = index++;
        node.props.ref?.(row);
      }
    }
    for (const effect of effects.splice(0)) effect();
    return tree;
  };
  const nodes = (tree, out = []) => {
    if (Array.isArray(tree)) for (const child of tree) nodes(child, out);
    else if (tree && typeof tree === 'object') { out.push(tree); nodes(tree.props?.children, out); }
    return out;
  };
  const text = (node) => Array.isArray(node) ? node.map(text).join('')
    : typeof node === 'string' ? node : node && typeof node === 'object' ? text(node.props?.children) : '';
  return {
    helpers, win, render, list,
    toastText: () => nodes(render()).find((node) => node.type === HostToast)?.props.text || '',
    select: (sessionId) => { selectedId = sessionId; },
    selectedText: () => nodes(render()).filter((node) => node.type === 'article' && node.props['aria-current'] === 'page').map(text),
    focusCount: () => focusCount,
    cards: () => nodes(render()).filter((node) => node.type === 'article'),
    cardText: () => nodes(render()).filter((node) => node.type === 'article').map(text),
    notice: () => nodes(render()).find((node) => node.props?.className === 'dsh-au-todo-notice')?.props.children.join('') || '',
    complete() {
      const button = nodes(render()).find((node) => node.type === 'button' && node.props.children[0] === '完成');
      assert.ok(button, 'a visible card must have a completion button');
      button.props.onClick({ stopPropagation() {} });
    },
    tick() { for (const fn of [...timers]) fn(); },
    dispose() { for (const slot of slots) slot?.dispose?.(); },
  };
}

test('cycling an empty confirmed list shows one native toast even with the TODO panel closed', async (t) => {
  const ui = panel(async () => json(response([])), undefined, { toastOnly: true });
  t.after(ui.dispose);
  ui.helpers.setTodoPanelOpen(false); ui.render();
  assert.equal(await ui.helpers.cycleWaitingSessionGlobal(), false);
  assert.equal(ui.toastText(), '当前没有待确认的对话');
  const oldDone = ui.render().props.onDone;
  assert.equal(await ui.helpers.cycleWaitingSessionGlobal(), false);
  assert.equal(ui.toastText(), '当前没有待确认的对话');
  oldDone();
  assert.equal(ui.toastText(), '当前没有待确认的对话', 'an older toast timeout must not clear the newer hint');
  ui.render().props.onDone();
  assert.equal(ui.toastText(), '');
});

test('a failed initial status read reports unavailable rather than falsely claiming no pending conversations', async (t) => {
  const ui = panel(async () => { throw new Error('offline'); }, undefined, { toastOnly: true });
  t.after(ui.dispose);
  ui.render();
  assert.equal(await ui.helpers.cycleWaitingSessionGlobal(), false);
  assert.equal(ui.toastText(), '暂时无法读取对话状态，请稍后重试');
});

test('cycling a newly pending conversation still navigates and shows a switching toast hint', async (t) => {
  let visibleCards = [];
  const ui = panel(async () => json(response(visibleCards)), undefined, { toastOnly: true });
  t.after(ui.dispose);
  ui.render();
  assert.equal(await ui.helpers.cycleWaitingSessionGlobal(), false);
  assert.equal(ui.toastText(), '当前没有待确认的对话');
  visibleCards = [card({ deviceId: 'self', isLocal: true, status: 'waiting' })];
  await ui.helpers.syncGlobalCards();
  const opened = [];
  assert.equal(await ui.helpers.cycleWaitingSessionGlobal((id) => opened.push(id)), true);
  assert.deepEqual(opened, ['s1']);
  assert.match(ui.toastText(), /正在切换到下一个未读对话/);
});

const localScrollCards = Array.from({ length: 5 }, (_, index) => card({
  deviceId: 'self', isLocal: true, sessionId: `local-${index}`, title: `local task ${index}`,
}));

test('selecting a conversation reveals its TODO card without taking focus or overriding later manual scrolling', async (t) => {
  const ui = panel(async () => json(response(localScrollCards)), undefined, { selectedSessionId: 'local-0' });
  t.after(ui.dispose);
  ui.render(); await flush(); ui.render(); await flush();
  ui.select('local-4'); ui.render();
  assert.equal(ui.list.scrollTop, 150);
  assert.match(ui.selectedText()[0], /local task 4/);
  assert.equal(ui.focusCount(), 0);
  ui.list.scrollTop = 0;
  ui.tick(); await flush(); ui.render();
  assert.equal(ui.list.scrollTop, 0, 'polling the same selected conversation must preserve manual scrolling');
  ui.select('local-2'); ui.render();
  assert.equal(ui.list.scrollTop, 50);
});

test('a selected TODO card arriving after initial loading and reopening the panel both reveal the selection', async (t) => {
  let visibleCards = localScrollCards.slice(0, 1);
  const ui = panel(async () => json(response(visibleCards)), undefined, { selectedSessionId: 'local-4' });
  t.after(ui.dispose);
  ui.render(); await flush(); ui.render(); await flush();
  assert.equal(ui.list.scrollTop, 0);
  visibleCards = localScrollCards;
  ui.tick(); await flush(); ui.render();
  assert.equal(ui.list.scrollTop, 150);
  ui.helpers.setTodoPanelOpen(false); ui.render();
  ui.list.scrollTop = 0;
  ui.helpers.setTodoPanelOpen(true); ui.render();
  assert.equal(ui.list.scrollTop, 150);
});

test('remote selection reveals and highlights only the active owning device rather than the retained local conversation', async (t) => {
  const remoteCards = localScrollCards.map((entry, index) => ({ ...entry, deviceId: 'mac', isLocal: false, sessionId: `remote-${index}`, title: `remote task ${index}` }));
  const ui = panel(async () => json(response(remoteCards)), undefined, { selectedSessionId: 'local-0' });
  t.after(ui.dispose);
  const store = ui.helpers.remoteWorkspaces.store;
  store.devices = [{ id: 'mac', selectedRoute: { id: 'mac-route', online: true } }];
  store.activeDeviceId = 'mac-route';
  store.selectedSessionByDevice.set('mac', 'remote-4');
  ui.render(); await flush(); ui.render(); await flush();
  assert.equal(ui.list.scrollTop, 150);
  assert.match(ui.selectedText()[0], /remote task 4/);
  store.selectedSessionByDevice.set('mac', 'remote-2');
  for (const listener of store.listeners) listener();
  ui.render();
  assert.equal(ui.list.scrollTop, 100, 'scrolling upward only needs to align the card top with the viewport');
  assert.match(ui.selectedText()[0], /remote task 2/);
});

// 2026-11-02 incident: completion removed the card before an uncaught save error; only a later poll restored it.
for (const failure of ['offline', 'refused']) {
  test(`a ${failure} completion restores the card and displays the save error immediately`, async (t) => {
    const ui = panel(async (_url, options) => {
      if (JSON.parse(options.body).action === 'hideSession') {
        if (failure === 'offline') throw new Error('remote offline');
        return json({ ok: false, error: 'remote refused' }, false);
      }
      return json(response([card()]));
    });
    t.after(ui.dispose);
    ui.render(); await flush();
    assert.equal(ui.cards().length, 1);
    ui.complete(); await flush();
    assert.equal(ui.cards().length, 1, 'failure must not leave a falsely completed card');
    assert.match(ui.notice(), /remote (offline|refused)/);
  });
}

test('a save failure remains visible even while its recovery refresh is still waiting', async (t) => {
  const recovery = deferred();
  let failed = false;
  const ui = panel(async (_url, options) => {
    if (JSON.parse(options.body).action === 'hideSession') { failed = true; throw new Error('save offline'); }
    return failed ? recovery.promise : json(response([card()]));
  });
  t.after(ui.dispose);
  ui.render(); await flush(); ui.cards(); await flush(); ui.complete(); await flush();
  assert.equal(ui.cards().length, 1);
  assert.match(ui.notice(), /save offline/, 'network recovery must not delay the actionable error');
  recovery.resolve(json(response([card()]))); await flush();
  assert.match(ui.notice(), /save offline/);
});

test('a pre-completion list response cannot resurrect a successfully completed card', async (t) => {
  const old = deferred();
  let stateCalls = 0;
  const ui = panel(async (_url, options) => {
    if (JSON.parse(options.body).action === 'hideSession') return json({ ok: true });
    stateCalls++;
    return stateCalls === 2 ? old.promise : json(response(stateCalls === 1 ? [card()] : []));
  });
  t.after(ui.dispose);
  ui.render(); await flush(); ui.cards();
  ui.tick(); ui.complete(); await flush();
  old.resolve(json(response([card()]))); await flush();
  assert.equal(ui.cards().length, 0);
});

test('polling while completion is pending keeps the card hidden and shares that state with global shortcuts', async (t) => {
  const save = deferred();
  const ui = panel(async (_url, options) => JSON.parse(options.body).action === 'hideSession'
    ? save.promise : json(response([card()])));
  t.after(ui.dispose);
  ui.render(); await flush(); ui.cards(); await flush(); ui.complete();
  ui.tick(); await flush();
  assert.equal(ui.cards().length, 0, 'the pending save must survive another old list poll');
  await ui.helpers.syncGlobalCards();
  assert.equal(ui.helpers.getGlobalCachedCards().length, 0);
  save.resolve(json({ ok: true })); await flush();
});

test('an authoritative empty TODO list defeats stale remote lights without hiding another real card', async (t) => {
  const snap = { self: { deviceId: 'self' }, devices: [{ id: 'mac', name: 'mac' }],
    remotes: [{ deviceId: 'mac', online: true, sessionStatesV2: { s1: 'done' } }] };
  const ui = panel(async () => json(response([card({ sessionId: 'other', title: 'other task' })])), snap);
  t.after(ui.dispose);
  ui.render(); await flush();
  assert.equal(ui.cards().length, 1);
  assert.match(ui.cardText()[0], /other task/);
});

test('a late global legacy list cannot undo the newer empty panel list after completion', async (t) => {
  const stale = deferred();
  let phase = 'initial';
  const oldCard = card({ status: 'done', stateSeq: undefined, hidden: true });
  const ui = panel(async (_url, options) => {
    if (JSON.parse(options.body).action === 'hideSession') return json({ ok: true });
    if (phase === 'stale') return stale.promise;
    return json(response(phase === 'empty' ? [] : [oldCard]));
  });
  t.after(ui.dispose);
  ui.render(); await flush(); ui.cards(); await flush(); ui.complete(); await flush();
  phase = 'stale';
  const globalRefresh = ui.helpers.syncGlobalCards();
  phase = 'empty'; ui.tick(); await flush();
  stale.resolve(json(response([oldCard]))); await globalRefresh;
  assert.equal(ui.helpers.getGlobalCachedCards().length, 0);
  phase = 'old'; ui.tick(); await flush();
  assert.equal(ui.cards().length, 0);
});

test('background auto-continue turns keep a completed card hidden until a new human message or manual todo arrives', async (t) => {
  let ownerCard = card({ status: 'done', endSeq: 10, lastUserMessageAt: recentAt });
  const ui = panel(async (_url, options) => {
    if (JSON.parse(options.body).action === 'hideSession') {
      // 模拟后台自动续跑插件（如 dsh-continue）连续触发新回合，但没有新的用户本人聊天消息
      ownerCard = card({ status: 'busy', stateSeq: 54, endSeq: -1, hidden: true, updatedAt: recentAt + 5000, lastUserMessageAt: recentAt });
      return json({ ok: true, confirmed: false, state: { status: 'busy', stateSeq: 54, endSeq: -1, ackedSeq: -1 } });
    }
    return json(response([ownerCard]));
  });
  t.after(ui.dispose);
  ui.render(); await flush(); ui.cards(); await flush(); ui.complete(); await flush();
  ui.tick(); await flush();
  assert.equal(ui.cards().length, 0, 'background auto-continue turns must not resurrect a completed card');

  // 当用户本人在聊天框主动发送了新消息（lastUserMessageAt 晚于完成时间）并且解除 hidden 后，卡片重新出现
  ownerCard = card({ status: 'busy', stateSeq: 55, hidden: false, updatedAt: recentAt + 1, lastUserMessageAt: recentAt + 1 });
  ui.tick(); await flush();
  assert.equal(ui.cards().length, 1);
  assert.equal(ui.cards()[0].props['data-status'], 'busy');
});

for (const [mode, protocol] of [['human-message', 'current'], ['manual-todo', 'current'], ['human-message', 'old'], ['manual-todo', 'old']]) {
  test(`new ${mode} under the ${protocol} protocol reopens a completed card while background status changes stay hidden`, async (t) => {
    let ownerCard = card({ status: 'done', hidden: true, lastUserMessageAt: recentAt });
    const ui = panel(async (_url, options) => JSON.parse(options.body).action === 'hideSession'
      ? json({ ok: true }) : json(response([ownerCard], protocol === 'old' ? { authoritativeDeviceIds: undefined } : {})));
    t.after(ui.dispose);
    ui.render(); await flush(); ui.cards(); ui.complete(); await flush();
    ui.tick(); await flush();
    assert.equal(ui.cards().length, 0, 'the completed card must remain hidden');
    // 后台插件触发状态变成 busy/error 但无新用户消息或新待办时，仍然保持隐藏
    ownerCard = card({ status: 'error', hidden: true, stateSeq: 99, updatedAt: recentAt + 1, lastUserMessageAt: recentAt });
    ui.tick(); await flush();
    assert.equal(ui.cards().length, 0, 'background plugin status change must not reopen a completed card');

    const reopenAt = recentAt + 2;
    ownerCard = mode === 'human-message'
      ? card({ status: 'busy', hidden: false, stateSeq: 100, updatedAt: reopenAt, lastUserMessageAt: reopenAt })
      : card({ status: 'idle', hidden: false, stateSeq: 100, updatedAt: reopenAt, todos: [{ id: 't1', text: '新待办', createdAt: reopenAt }] });
    ui.tick(); await flush();
    assert.equal(ui.cards().length, 1, 'explicit human message or manual todo must reopen the card');
  });
}

test('transitioning a hidden card to idle green light immediately removes it from the panel without waiting for polling', async (t) => {
  const snap = {
    self: { deviceId: 'self', sessionStatesV2: { s1: 'done' } },
    remotes: [],
  };
  const hiddenDoneCard = card({ deviceId: 'self', isLocal: true, status: 'done', hidden: true });
  const ui = panel(async () => json(response([hiddenDoneCard])), snap, { selectedSessionId: 'other' });
  t.after(ui.dispose);
  ui.render(); await flush(); ui.render(); await flush();
  assert.equal(ui.cards().length, 1);
  // 切换到该会话使其状态变为 idle 时，带 hidden 标记的卡片立即从列表中剔除
  ui.select('s1'); ui.render(); await flush();
  assert.equal(ui.cards().length, 0);
});

test('global shortcut cycles to newly pending local session from lightweight self-state snapshot with zero background Todo API polling when panel is closed', async (t) => {
  let todoGetStateCalls = 0;
  const snap = {
    self: { deviceId: 'self', hostname: 'MyHost', sessionStatesV2: { 'local-unread': 'done' } },
    remotes: [],
  };
  const ui = panel(async (_url, options) => {
    const body = JSON.parse(options?.body || '{}');
    if (body.action === 'getState') todoGetStateCalls += 1;
    return json({ ok: true, confirmed: true });
  }, snap, { toastOnly: true });
  t.after(ui.dispose);
  ui.helpers.setTodoPanelOpen(false);
  ui.render();
  // 面板关闭状态下不触发任何后台 getState 扫盘请求
  assert.equal(todoGetStateCalls, 0);
  const opened = [];
  assert.equal(await ui.helpers.cycleWaitingSessionGlobal((id) => opened.push(id)), true);
  assert.deepEqual(opened, ['local-unread']);
  assert.equal(todoGetStateCalls, 0, 'shortcut must resolve pending session directly from in-memory self-state snapshot without scanning Todo getState');
});

test('clicking a remote TODO card syncs sidebar remote selection, advances navigation lock, and scrolls sidebar row into view', async (t) => {
  const remoteCards = [
    card({ deviceId: 'win', deviceName: 'win', isLocal: false, sessionId: 'sess-old', title: '旧对话', status: 'idle', updatedAt: recentAt - 5000 }),
    card({ deviceId: 'win', deviceName: 'win', isLocal: false, sessionId: 'sess-sword', title: '目标：在《示例文章》第二', status: 'idle', updatedAt: recentAt }),
  ];
  const ui = panel(async () => json(response(remoteCards)), undefined, { selectedSessionId: 'local-0' });
  t.after(ui.dispose);
  const store = ui.helpers.remoteWorkspaces.store;
  store.devices = [{ id: 'win', deviceId: 'win', name: 'win', selectedRoute: { id: 'win-route', online: true } }];
  store.activeDeviceId = 'win';
  store.selectedSessionByDevice.set('win', 'sess-old');
  store.latestNavigationByDevice.set('win', { commandId: 'old-cmd', selectionSeq: 1, pending: false });

  ui.render(); await flush(); ui.render(); await flush();
  assert.match(ui.selectedText()[0], /旧对话/);

  // 点击第二张远程卡片（示例文章）
  const swordArticle = ui.cards().find((node) => JSON.stringify(node).includes('示例文章'));
  assert.ok(swordArticle, 'target card must exist');
  swordArticle.props.onClick();
  await flush(); ui.render();

  assert.equal(store.selectedSessionByDevice.get('win'), 'sess-sword', 'sidebar store must immediately select the clicked remote session');
  assert.match(ui.selectedText()[0], /示例文章/, 'TODO panel highlight must immediately switch to the clicked remote card');
});

test('a previously busy session that finishes in sidebar controlledSnapshot or auSnap transitions to done and is recognized by global shortcut', async (t) => {
  const busyCard = card({ deviceId: 'win', deviceName: 'win', isLocal: false, sessionId: 'sess-root', title: '根目录：C:\\Users\\example', status: 'busy', updatedAt: recentAt });
  const snap = {
    self: { deviceId: 'self' },
    devices: [{ id: 'win', name: 'win' }],
    remotes: [{ deviceId: 'win', online: true, sessionStatesV2: { 'sess-root': 'busy' } }],
  };
  const ui = panel(async () => json(response([busyCard])), snap, { toastOnly: true });
  t.after(ui.dispose);
  ui.helpers.setTodoPanelOpen(false);
  ui.render();
  await ui.helpers.syncGlobalCards();
  // 初始为 busy 时，快捷键无待确认会话
  assert.equal(await ui.helpers.cycleWaitingSessionGlobal(), false);

  // 远端受控 iframe 在侧边栏实时推送该会话已完成（completionUnread: true, status: 'done'），即使 auSnap 探针仍滞后为 busy
  const store = ui.helpers.remoteWorkspaces.store;
  store.devices = [{ id: 'win', deviceId: 'win', name: 'win' }];
  store.controlledSnapshots.set('win', {
    workspaces: [{
      workspaceId: 'ws-win',
      title: 'DemoApp',
      path: 'F:\\DemoApp',
      updatedAt: recentAt,
      sessions: [{ sessionId: 'sess-root', title: '根目录：C:\\Users\\example', status: 'done', completionUnread: true, updatedAt: recentAt }],
    }],
    currentSessionId: '',
    updatedAt: recentAt,
  });
  for (const listener of store.listeners) listener();

  assert.equal(await ui.helpers.cycleWaitingSessionGlobal(), true, 'shortcut must immediately recognize busy -> done session from sidebar real-time state');
  assert.equal(store.selectedSessionByDevice.get('win'), 'sess-root');
});
