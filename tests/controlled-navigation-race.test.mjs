import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../scripts/build-client.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

// Browser messaging/time, React and the host SDK are system boundaries. The production
// receiver, workspace resolution, fallbacks, extraction and confirmation stay real.
function controlled(t, { sdk = {}, statuses = new Map(), rows = {}, nativeConfirm = false } = {}) {
  const listeners = new Map();
  const messages = [];
  const requests = [];
  const responses = [];
  const timers = new Map();
  const effects = [];
  const subscribers = new Set();
  const opened = [];
  let timerId = 0;
  let selected = 'current';
  let now = 1000;
  const win = {
    name: 'dsh-au-controlled:remote', innerWidth: 1200,
    navigator: { userAgent: 'Desktop', platform: 'Win32', maxTouchPoints: 0 },
    location: { href: 'http://remote/' },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  win.parent = { postMessage(data) { messages.push(data); } };
  win.top = win.parent;
  const workspaces = { list: { getSnapshot: () => ({ items: [] }) }, ...sdk.workspaces };
  const sessions = { list: { getSnapshot: () => ({ byId: { ...rows, [selected]: { ...(rows[selected] || {}), id: selected, retainedBy: { mainView: 1 } } } }), subscribe: (listener) => { subscribers.add(listener); return () => subscribers.delete(listener); } }, ...sdk.sessions };
  const uiWorkspace = {
    openSession(id) { opened.push(id); selected = id; },
    openWorkspace(id) { opened.push(id); selected = `${id}-session`; },
    ...sdk.uiWorkspace,
  };
  const ctx = {
    get: (name) => ({ workspaces, sessions, uiWorkspace, uiSession: { sessionStatus: { getSnapshot: () => statuses } } })[name],
    effect: (callback, label) => effects.push({ callback, label }),
    slots: { inject() {}, register() { return () => {}; } },
  };
  const document = { visibilityState: 'visible', hasFocus: () => true, documentElement: { setAttribute() {}, hasAttribute: () => false }, getElementById: () => null };
  class ClockDate extends Date { static now() { return now; } }
  let descriptor;
  win.__ModuleLoader__ = { load(definition) { descriptor = definition; } };
  const footer = "return { name: 'dsh-au', inject, apply, mobile: mobileClient.helpers, shortcuts: shortcutHelpers };";
  const source = build(); // Source-only build: the existing generated client is not the baseline.
  assert.ok(source.includes(footer));
  const hooked = source.replace(footer, 'return { apply, installControlledFrameShortcutBridge, extractControlledWorkspacesSnapshot, markControlledSessionConfirmed, syncControlledSessionsWithBackendState };');
  const fetch = async (url, options) => {
    requests.push({ url, payload: JSON.parse(options?.body || '{}') });
    const result = responses.length ? await responses.shift() : { ok: true, confirmed: true };
    if (result instanceof Error) throw result;
    return { ok: true, status: 200, text: async () => JSON.stringify(result), json: async () => result };
  };
  class Element {
    constructor(region = 'main') { this.region = region; }
    closest(selector) {
      if (selector.includes('dsh-au-top-wrap') || selector.includes('dsh-au-todo-dock')) return null;
      return selector.includes(this.region) ? this : null;
    }
  }
  const globals = { window: win, document, navigator: win.navigator, Date: ClockDate, fetch, Element, localStorage: { getItem: () => null, setItem() {} } };
  new Function(...Object.keys(globals), hooked)(...Object.values(globals));
  const client = descriptor.factory((name) => {
    if (name === 'react') return { createElement: (type, props) => ({ type, props }), Fragment: Symbol('Fragment') };
    if (name === 'react-dom') return {};
    throw new Error(`unexpected dependency ${name}`);
  });
  client.apply(ctx);
  const dispose = client.installControlledFrameShortcutBridge();
  t.after(dispose);
  // Keep the actual legacy Todo receiver active: compatibility must not trigger a second
  // SDK open or its unconditional backend confirmation.
  const legacy = effects.find(({ label }) => label === 'dsh-au-todo: controlled session bridge');
  assert.ok(legacy);
  t.after(legacy.callback());
  if (nativeConfirm) {
    const native = effects.find(({ label }) => label === 'dsh-au-todo: native session confirm bridge');
    assert.ok(native);
    t.after(native.callback());
  }
  return {
    client, ctx, statuses, rows, win, document, messages, requests, responses, opened, dispose, timers,
    emit(data, source = win.parent) {
      let stopped = false;
      const event = { data, source, stopImmediatePropagation() { stopped = true; } };
      for (const listener of [...(listeners.get('message') || [])]) { listener(event); if (stopped) break; }
    },
    select(id) { selected = id; for (const listener of [...subscribers]) listener(); },
    event(type, extra = {}) { for (const listener of [...(listeners.get(type) || [])]) listener({ isTrusted: true, target: new Element(), ...extra }); },
    async settle() { for (let i = 0; i < 20; i += 1) await Promise.resolve(); },
    async runTimers() { const pending = [...timers.values()]; timers.clear(); for (const fn of pending) fn(); await this.settle(); },
    advance(ms) { now += ms; },
    acks(id) { return messages.filter((m) => m.type === 'dsh-au:remote-command-ack' && m.commandId === id); },
    snapshots() { return messages.filter((m) => m.type === 'dsh-au:controlled-workspaces-snapshot'); },
    session(id) { return client.extractControlledWorkspacesSnapshot(ctx).workspaces.flatMap((ws) => ws.sessions).find((s) => s.sessionId === id); },
  };
}
function session(id, seq, extra = {}) {
  return { source: 'dsh-au', type: 'dsh-au:open-remote-session', commandId: id, selectionSeq: seq, sessionId: id, ...extra };
}
function workspace(id, seq, extra = {}) {
  return { source: 'dsh-au', type: 'dsh-au:open-remote-workspace', commandId: id, selectionSeq: seq, path: `/${id}`, ...extra };
}
function todo(id, seq) {
  return { source: 'dsh-au-todo', type: 'dsh-au-todo:select-session', commandId: id, selectionSeq: seq, sessionId: id };
}

// Incident: A's resolve/create finishes after B and steals the remote frame focus.
test('a delayed workspace intent yields to a newer session and only the current intent reports selection', async (t) => {
  const pending = deferred();
  const env = controlled(t, { sdk: { workspaces: { create: () => pending.promise } } });
  env.emit(workspace('A', 1));
  env.emit(session('B', 2));
  await env.settle();
  pending.resolve({ workspaceId: 'workspace-A' });
  await env.settle();
  await env.runTimers();
  assert.deepEqual(env.opened, ['B']);
  const doneB = env.acks('B').find((ack) => ack.stage === 'done');
  assert.equal(doneB.result, 'applied');
  assert.equal(doneB.navigationCommandId, 'B');
  assert.equal(doneB.selectionSeq, 2);
  const doneA = env.acks('A').find((ack) => ack.stage === 'done');
  assert.equal(doneA.result, 'superseded');
  assert.equal(doneA.sessionId, undefined, 'an old command must not return another command\'s current session');
  assert.ok(env.snapshots().length > 0);
  assert.ok(env.snapshots().every((snap) => snap.navigationCommandId === 'B' && snap.selectionSeq === 2));
});

test('primary and Todo retries preserve a pending command and replay received rather than premature done', async (t) => {
  const pending = deferred();
  const env = controlled(t, { sdk: { workspaces: { create: () => pending.promise } } });
  const primary = workspace('A', 3);
  env.emit(primary);
  env.emit(primary);
  env.emit(todo('A', 3));
  await env.settle();
  assert.deepEqual(env.opened, []);
  assert.ok(env.acks('A').every((ack) => ack.stage === 'received'));
  pending.resolve({ workspaceId: 'workspace-A' });
  await env.settle();
  assert.deepEqual(env.opened, ['workspace-A']);
  env.emit(primary);
  env.emit(todo('A', 3));
  await env.settle();
  assert.deepEqual(env.opened, ['workspace-A']);
  assert.equal(env.acks('A').at(-1).result, 'applied');
  assert.deepEqual(env.requests, [], 'the compatibility retry must not reach legacy unconditional confirmation');
});

test('older sequenced packets and no-sequence compatibility commands cannot restore an obsolete intent', async (t) => {
  for (const sequenced of [true, false]) {
    await t.test(sequenced ? 'selectionSeq ordering' : 'legacy latest received command', async (subtest) => {
      const pending = deferred();
      const env = controlled(subtest, { sdk: { workspaces: { create: () => pending.promise } } });
      env.emit(workspace('A', sequenced ? 4 : undefined));
      env.emit(todo('B', sequenced ? 5 : undefined));
      await env.settle();
      env.emit(workspace('A', sequenced ? 4 : undefined));
      if (sequenced) env.emit(session('C', 3));
      pending.resolve({ workspaceId: 'workspace-A' });
      await env.settle();
      assert.deepEqual(env.opened, ['B']);
      assert.equal(env.acks('A').at(-1).result, 'superseded');
      if (sequenced) assert.equal(env.acks('C').at(-1).result, 'superseded');
    });
  }
});

test('session creation fallbacks yield after asynchronous boundaries to cancellation, disposal or a newer workspace', async (t) => {
  for (const action of ['cancel', 'dispose', 'newer-workspace']) {
    await t.test(action, async (subtest) => {
      const pending = deferred();
      const env = controlled(subtest, { sdk: { sessions: { create: () => pending.promise }, uiWorkspace: { openWorkspace: undefined } } });
      env.emit(workspace('A', 6, { createNew: true }));
      await env.settle();
      if (action === 'cancel') env.emit({ source: 'dsh-au', type: 'dsh-au:cancel-remote-navigation', selectionSeq: 7 });
      if (action === 'dispose') env.dispose();
      if (action === 'newer-workspace') env.emit(workspace('B', 7, { fallbackSessionId: 'B' }));
      await env.settle();
      pending.resolve({ sessionId: 'created-A' });
      await env.settle();
      await env.runTimers();
      assert.deepEqual(env.opened, action === 'newer-workspace' ? ['B'] : []);
      assert.ok(env.snapshots().every((snap) => snap.navigationCommandId === 'B'));
      if (action !== 'dispose') assert.equal(env.acks('A').at(-1).result, action === 'cancel' ? 'cancelled' : 'superseded');
    });
  }
});

test('background snapshot extraction retains the selected session\'s unread completion and native running beats stale row error', (t) => {
  const statuses = new Map([
    ['current', { running: false, completionUnread: true, stateSeq: 8, endSeq: 8, ackedSeq: 7 }],
    ['running', { running: true, completionUnread: true, stateSeq: 10, endSeq: 8, ackedSeq: 8 }],
  ]);
  const env = controlled(t, { statuses, rows: {
    current: { id: 'current', title: 'completed', status: 'done' },
    running: { id: 'running', title: 'working', status: 'error', stateSeq: 8, endSeq: 8, ackedSeq: 7 },
  } });
  env.document.visibilityState = 'hidden';
  env.document.hasFocus = () => false;
  assert.equal(env.session('current').completionUnread, true);
  assert.equal(statuses.get('current').completionUnread, true);
  assert.equal(env.session('running').status, 'running');
  assert.equal(env.session('running').stateSeq, 10);
});

test('confirmation and backend idle reconciliation cannot clear a running turn or a newer completion', (t) => {
  const statuses = new Map([['S', { running: true, completionUnread: true, stateSeq: 12, endSeq: 10, ackedSeq: 9 }]]);
  const env = controlled(t, { statuses, rows: { S: { id: 'S', title: 'S' } } });
  assert.equal(env.client.markControlledSessionConfirmed('S', env.ctx, { endSeq: 10 }), false);
  assert.equal(statuses.get('S').completionUnread, true);
  statuses.set('S', { running: false, completionUnread: true, stateSeq: 14, endSeq: 14, ackedSeq: 10 });
  const stale = { S: { status: 'idle', stateSeq: 10, endSeq: 10, ackedSeq: 10 } };
  assert.equal(env.client.syncControlledSessionsWithBackendState({ S: 'idle' }, env.ctx, 20000, stale), false);
  assert.equal(statuses.get('S').completionUnread, true);
  const fresh = { S: { status: 'idle', stateSeq: 14, endSeq: 14, ackedSeq: 14 } };
  assert.equal(env.client.syncControlledSessionsWithBackendState({ S: 'idle' }, env.ctx, 20000, fresh), true);
  assert.equal(statuses.get('S').completionUnread, false);
  assert.equal(env.session('S').endSeq, 14);
  assert.equal(env.session('S').ackedSeq, 14);
  statuses.set('S', { running: false, completionUnread: true, stateSeq: 16, endSeq: 16, ackedSeq: 14 });
  assert.equal(env.session('S').completionUnread, true, 'an old confirmation cannot suppress the next completion');
});

test('an explicit open acknowledges only the completion present before its asynchronous SDK open', async (t) => {
  const pending = deferred();
  const statuses = new Map([['S', { running: false, completionUnread: true, stateSeq: 20, endSeq: 20, ackedSeq: 18 }]]);
  const env = controlled(t, { statuses, rows: { S: { id: 'S' } }, sdk: { uiWorkspace: { openSession: () => pending.promise } } });
  env.emit(session('S', 8, { endSeq: 20 }));
  statuses.set('S', { running: false, completionUnread: true, stateSeq: 22, endSeq: 22, ackedSeq: 20 });
  pending.resolve();
  await env.settle();
  assert.equal(statuses.get('S').completionUnread, true);
  assert.equal(env.session('S').completionUnread, true);
  env.emit({ source: 'dsh-au', type: 'dsh-au:confirm-remote-session', sessionId: 'S', endSeq: 20 });
  assert.equal(statuses.get('S').completionUnread, true);
  env.emit({ source: 'dsh-au', type: 'dsh-au:confirm-remote-session', sessionId: 'S', endSeq: 22 });
  assert.equal(statuses.get('S').completionUnread, false);
});

test('backend-only versions refuse an old end after observing a new native turn', (t) => {
  const statuses = new Map([['S', { running: false, completionUnread: true }]]);
  const env = controlled(t, { statuses, rows: { S: { id: 'S' } } });
  const old = { S: { status: 'idle', stateSeq: 24, endSeq: 24, ackedSeq: 24 } };
  env.client.syncControlledSessionsWithBackendState({ S: 'idle' }, env.ctx, 1000, old);
  statuses.set('S', { running: true, completionUnread: false });
  env.session('S');
  statuses.set('S', { running: false, completionUnread: true });
  env.emit({ source: 'dsh-au', type: 'dsh-au:confirm-remote-session', sessionId: 'S', endSeq: 24 });
  assert.equal(statuses.get('S').completionUnread, true);
  env.client.syncControlledSessionsWithBackendState({ S: 'idle' }, env.ctx, 20000, old);
  assert.equal(statuses.get('S').completionUnread, true);
  env.client.syncControlledSessionsWithBackendState({ S: 'idle' }, env.ctx, 20000, { S: { status: 'idle', stateSeq: 26, endSeq: 26, ackedSeq: 26 } });
  assert.equal(statuses.get('S').completionUnread, false);
});

test('an open received before native status exists cannot acknowledge its first later completion', async (t) => {
  const pending = deferred();
  const env = controlled(t, { rows: { S: { id: 'S' } }, sdk: { uiWorkspace: { openSession: () => pending.promise } } });
  env.emit(session('S', 9));
  env.statuses.set('S', { running: false, completionUnread: true });
  pending.resolve();
  await env.settle();
  assert.equal(env.statuses.get('S').completionUnread, true);
});

function selfState(status, endSeq = 30, extra = {}) {
  return { sessionStateVersion: 1, sessionStateDetails: { S: { status, stateSeq: endSeq, endSeq, ackedSeq: endSeq - 2, ...extra } }, sessions: [{ id: 'S', statusV2: status }] };
}

test('focused native completion confirmation binds its observed end once, not every input or selection callback', async (t) => {
  const env = controlled(t, { nativeConfirm: true });
  env.win.__dshAuLastStateSnap = { self: selfState('done') };
  env.select('S');
  env.event('pointerdown');
  env.event('input');
  env.select('S');
  await env.settle();
  assert.equal(env.requests.length, 2, 'one version is confirmed on each of the two backend APIs, not on every event');
  assert.ok(env.requests.every(({ payload }) => payload.sessionId === 'S' && payload.expectedEndSeq === 30));
  env.win.__dshAuLastStateSnap.self = selfState('error', 32);
  env.event('input');
  await env.settle();
  assert.equal(env.requests.length, 4);
  assert.ok(env.requests.slice(2).every(({ payload }) => payload.expectedEndSeq === 32));
});

test('controlled backend metadata binds native confirmation even without the outer shell state snapshot', async (t) => {
  const env = controlled(t, { nativeConfirm: true });
  env.client.syncControlledSessionsWithBackendState({ S: 'done' }, env.ctx, 1000, { S: { status: 'done', stateSeq: 40, endSeq: 40, ackedSeq: 38 } });
  env.select('S');
  await env.settle();
  assert.equal(env.requests.length, 2);
  assert.ok(env.requests.every(({ payload }) => payload.expectedEndSeq === 40));
});

test('hidden or unfocused native selection is not a user confirmation and old input cannot confirm a newly arrived end', async (t) => {
  for (const focus of ['hidden', 'unfocused', 'focused-before-end']) {
    await t.test(focus, async (subtest) => {
      const env = controlled(subtest, { nativeConfirm: true });
      env.win.__dshAuLastStateSnap = { self: selfState(focus === 'focused-before-end' ? 'busy' : 'done') };
      if (focus === 'hidden') env.document.visibilityState = 'hidden';
      if (focus === 'unfocused') env.document.hasFocus = () => false;
      env.select('S');
      env.event('input');
      await env.settle();
      assert.deepEqual(env.requests, []);
      env.document.visibilityState = 'visible';
      env.document.hasFocus = () => true;
      const ended = selfState('done', 34);
      env.win.__dshAuLastStateSnap.self = ended;
      env.event('dsh-au:self-state', { detail: ended });
      await env.settle();
      assert.deepEqual(env.requests, [], 'a state update may not give an earlier hidden/busy click a new end watermark');
      env.event('input');
      await env.settle();
      assert.equal(env.requests.length, 2);
      assert.ok(env.requests.every(({ payload }) => payload.expectedEndSeq === 34));
    });
  }
});

test('new peers do not confirm busy waiting unknown or absent end metadata while legacy focused completion remains compatible', async (t) => {
  for (const state of [selfState('busy'), selfState('busy', 2, { stateSeq: 3, ackedSeq: -1 }), selfState('waiting'), selfState('unknown'), selfState('done', -1), { sessionStateVersion: 1, sessionStateDetails: {} }]) {
    await t.test(JSON.stringify(state), async (subtest) => {
      const env = controlled(subtest, { nativeConfirm: true });
      env.win.__dshAuLastStateSnap = { self: state };
      env.select('S');
      env.event('input');
      await env.settle();
      assert.deepEqual(env.requests, []);
    });
  }
  const legacy = controlled(t, { nativeConfirm: true });
  legacy.win.__dshAuLastStateSnap = { self: { sessions: [{ id: 'S', status: 'done' }] } };
  legacy.select('S');
  await legacy.settle();
  assert.equal(legacy.requests.length, 2);
  assert.ok(legacy.requests.every(({ payload }) => !Object.hasOwn(payload, 'expectedEndSeq')));
});

// Protocol regression: title and other non-turn events may advance stateSeq after endSeq.
test('non-turn state updates keep the completed end explicitly confirmable without resurrecting unread status', (t) => {
  const statuses = new Map([['S', { running: false, completionUnread: true, stateSeq: 7, endSeq: 5, ackedSeq: -1 }]]);
  const env = controlled(t, { statuses, rows: { S: { id: 'S', status: 'done' } } });
  env.emit({ source: 'dsh-au', type: 'dsh-au:confirm-remote-session', sessionId: 'S', endSeq: 5, stateSeq: 5 });
  assert.equal(statuses.get('S').completionUnread, false);
  assert.equal(env.session('S').status, 'idle');
  statuses.set('S', { ...statuses.get('S'), stateSeq: 9 });
  assert.equal(env.session('S').status, 'idle', 'same-end title events must not invalidate the completed-turn confirmation');
});

test('shared idle confirmation clears the same completed end after non-turn state updates but preserves a newly observed busy turn', (t) => {
  const statuses = new Map([['S', { running: false, completionUnread: true, stateSeq: 7, endSeq: 5, ackedSeq: -1 }]]);
  const env = controlled(t, { statuses, rows: { S: { id: 'S', status: 'done' } } });
  env.client.syncControlledSessionsWithBackendState({ S: 'idle' }, env.ctx, 1000, { S: { status: 'idle', stateSeq: 7, endSeq: 5, ackedSeq: 5 } });
  assert.equal(statuses.get('S').completionUnread, false);
  assert.equal(env.session('S').status, 'idle');
  statuses.set('S', { running: true, completionUnread: true, stateSeq: 10, endSeq: 5, ackedSeq: 5 });
  env.session('S');
  env.emit({ source: 'dsh-au', type: 'dsh-au:confirm-remote-session', sessionId: 'S', endSeq: 5 });
  assert.equal(statuses.get('S').completionUnread, true);
  statuses.set('S', { running: false, completionUnread: true, stateSeq: 10, endSeq: 5, ackedSeq: 5 });
  env.client.syncControlledSessionsWithBackendState({ S: 'idle' }, env.ctx, 20000, { S: { status: 'idle', stateSeq: 10, endSeq: 5, ackedSeq: 5 } });
  assert.equal(statuses.get('S').completionUnread, true, 'the old end stays protected by the observed native busy floor');
});

test('native completion confirmation sends the completed end despite later title events while a busy old end makes no RPC', async (t) => {
  const statuses = new Map([['S', { running: false, completionUnread: true, stateSeq: 9, endSeq: 5, ackedSeq: -1 }]]);
  const env = controlled(t, { nativeConfirm: true, statuses });
  env.win.__dshAuLastStateSnap = { self: selfState('done', 5, { stateSeq: 7, ackedSeq: -1 }) };
  env.select('S');
  await env.settle();
  assert.equal(env.requests.length, 2);
  assert.ok(env.requests.every(({ payload }) => payload.expectedEndSeq === 5));
  env.win.__dshAuLastStateSnap.self = selfState('busy', 5, { stateSeq: 10, ackedSeq: -1 });
  statuses.set('S', { running: true, completionUnread: true, stateSeq: 10, endSeq: 5, ackedSeq: -1 });
  env.event('input');
  await env.settle();
  assert.equal(env.requests.length, 2, 'a new busy turn cannot confirm its previous completed end');
});

test('failed native end confirmations retry the same observed end and publish success only after one API really confirms', async (t) => {
  for (const failure of ['transport', 'semantic']) {
    await t.test(failure, async (subtest) => {
      const env = controlled(subtest, { nativeConfirm: true });
      env.win.__dshAuLastStateSnap = { self: selfState('done', 5, { stateSeq: 7, ackedSeq: -1 }) };
      env.responses.push(...(failure === 'transport' ? [new Error('offline'), new Error('offline')] : [{ ok: false, confirmed: false }, { ok: true, confirmed: false }]));
      env.select('S');
      env.event('input');
      await env.settle();
      assert.equal(env.requests.length, 2, 'pending duplicate input must share one confirmation attempt');
      assert.equal(env.messages.filter((m) => m.type === 'remote-session-confirmed').length, 0);
      env.responses.push({ ok: false, confirmed: false }, { ok: true, confirmed: true });
      env.event('input');
      await env.settle();
      assert.equal(env.requests.length, 4, 'after both APIs fail, the same end remains retryable');
      assert.ok(env.requests.every(({ payload }) => payload.expectedEndSeq === 5));
      const succeeded = env.messages.filter((m) => m.type === 'remote-session-confirmed');
      assert.equal(succeeded.length, 1, 'one successful API confirms the end even if the other API fails');
      assert.equal(succeeded[0].endSeq, 5);
      env.event('input');
      await env.settle();
      assert.equal(env.requests.length, 4, 'a genuinely confirmed end remains deduplicated');
    });
  }
});

test('legacy idle reconciliation keeps its recent-busy safety window', (t) => {
  const statuses = new Map([['S', { running: true, completionUnread: false }]]);
  const env = controlled(t, { statuses, rows: { S: { id: 'S' } } });
  env.session('S');
  statuses.set('S', { running: false, completionUnread: true });
  assert.equal(env.client.syncControlledSessionsWithBackendState({ S: 'idle' }, env.ctx, 1001), false);
  assert.equal(statuses.get('S').completionUnread, true);
  assert.equal(env.client.syncControlledSessionsWithBackendState({ S: 'idle' }, env.ctx, 10000), true);
  assert.equal(statuses.get('S').completionUnread, false);
});
