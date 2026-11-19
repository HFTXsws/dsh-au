import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../scripts/build-client.js';

// HTTP, DOM focus, window messaging and time are browser/system boundaries. Real callApi,
// diagnostics, focus controller, apply entry and controlled receiver all execute unchanged.
function browser({ response = { ok: true, sessionId: 'busy-session', reason: 'busy' } } = {}) {
  let now = 1000;
  let timerId = 0;
  const timers = new Map();
  const listeners = new Map();
  const requests = [];
  const responses = [];
  const storage = new Map();
  const parentMessages = [];
  const win = {
    name: '', navigator: { userAgent: 'Desktop', platform: 'Win32', maxTouchPoints: 0 },
    innerWidth: 1200, location: { href: 'http://127.0.0.1:6534/' },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { due: now + delay, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    matchMedia: () => ({ matches: false }),
  };
  win.parent = { postMessage: (data) => parentMessages.push(data) };
  win.top = win.parent;
  const document = { activeElement: null, documentElement: { hasAttribute: () => false }, visibilityState: 'visible' };
  const localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) };
  class ClockDate extends Date { static now() { return now; } }
  const fetch = async (url, options) => {
    const payload = options?.body ? JSON.parse(options.body) : { action: 'getState' };
    requests.push({ payload, keepalive: options?.keepalive });
    const data = payload.action === 'getInitialSessionFocus' ? await (responses.length ? responses.shift() : response) : { ok: true };
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  const env = {
    win, document, requests, responses, timers, listeners, parentMessages,
    globals: {
      window: win, document, navigator: win.navigator, localStorage, sessionStorage: localStorage,
      fetch, URL, Date: ClockDate,
      Element: class {}, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    },
    frame() { return { contentWindow: { messages: [], postMessage(data) { this.messages.push(data); } } }; },
    emit(type, data = {}) {
      let stopped = false;
      const event = { ...data, stopImmediatePropagation() { stopped = true; } };
      for (const listener of [...(listeners.get(type) || [])]) { listener(event); if (stopped) break; }
    },
    async settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); },
    async advance(ms) {
      const until = now + ms;
      let ticks = 0;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.due <= until).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        assert.ok(++ticks < 100, 'clock must settle');
        now = next[1].due;
        timers.delete(next[0]);
        next[1].fn();
        await env.settle();
      }
      now = until;
      await env.settle();
    },
    queries() { return requests.filter(({ payload }) => payload.action === 'getInitialSessionFocus').map(({ payload }) => payload); },
    results() { return requests.filter(({ payload }) => payload.action === 'reportClientEvent' && payload.event === 'initial-session-focus').map(({ payload }) => payload); },
  };
  return env;
}

function loadClient(env) {
  let descriptor;
  env.win.__ModuleLoader__ = { load: (definition) => { descriptor = definition; } };
  const footer = 'return { name: \'dsh-au\', inject, apply, mobile: mobileClient.helpers, shortcuts: shortcutHelpers };';
  const source = build(); // In-memory build reads source only; never writes or reloads client.js.
  assert.ok(source.includes(footer), 'production factory must expose the normal entry');
  const hooked = source.replace(footer, 'return { apply, createInitialSessionFocusController, installControlledFrameShortcutBridge };');
  new Function(...Object.keys(env.globals), hooked)(...Object.values(env.globals));
  // React is an external package boundary: this feature has no rendering/hooks under test.
  // Keep function declarations real; unrelated components are not mounted in these tests.
  const react = { createElement: (type, props) => ({ type, props }), Fragment: Symbol('Fragment') };
  return descriptor.factory((name) => {
    if (name === 'react') return react;
    if (name === 'react-dom') return {};
    throw new Error(`unexpected dependency ${name}`);
  });
}

function remote(frame, overrides = {}) {
  return { deviceId: 'mac', routeId: 'mac-route', frameKey: 'mac_0', frame, loaded: true, allowed: true, ...overrides };
}
function local(overrides = {}) { return { deviceId: 'local', loaded: true, allowed: true, ...overrides }; }
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function acknowledge(env, frame, request, overrides = {}) {
  env.emit('message', {
    source: frame.contentWindow,
    data: { source: 'dsh-au', type: 'initial-session-focus-result', requestId: request.requestId, sessionId: request.sessionId, result: 'applied', ...overrides },
  });
}

// Regression: first entry must not fight subsequent manual navigation, refresh or plugin HMR.
test('first loaded entry queries once per device and same-page controllers share visits, while a new page starts fresh', async (t) => {
  const env = browser();
  const client = loadClient(env);
  const page = env.frame();
  const openedLocal = [];
  let selectedLocal = 'current-session';
  const controller = client.createInitialSessionFocusController({
    openLocalSession(id) { openedLocal.push(id); selectedLocal = id; }, readLocalSessionId: () => selectedLocal,
  });
  t.after(() => controller.dispose());
  controller.update(remote(page, { loaded: false }));
  await env.settle();
  assert.equal(env.queries().length, 0);
  controller.update(remote(page));
  await env.settle();
  assert.equal(env.queries().length, 1);
  const sent = page.contentWindow.messages[0];
  acknowledge(env, page, sent);
  await env.advance(1000);
  assert.equal(page.contentWindow.messages.length, 1, 'an exact early ACK cancels the compatibility retry');
  controller.update(local());
  await env.settle();
  assert.deepEqual(openedLocal, ['busy-session']);
  controller.update(remote(page));
  controller.update(remote(env.frame(), { frameKey: 'mac_1' }));
  await env.advance(4000);
  assert.equal(env.queries().filter((query) => query.deviceId === 'mac').length, 1);
  controller.dispose();
  const hotClient = loadClient(env);
  const hot = hotClient.createInitialSessionFocusController();
  t.after(() => hot.dispose());
  hot.update(remote(env.frame(), { frameKey: 'mac_2' }));
  await env.settle();
  assert.equal(env.queries().filter((query) => query.deviceId === 'mac').length, 1);
  const newPage = browser();
  const fresh = loadClient(newPage).createInitialSessionFocusController();
  t.after(() => fresh.dispose());
  fresh.update(remote(newPage.frame()));
  await newPage.settle();
  assert.equal(newPage.queries().length, 1);
});

test('empty focus targets retain the current session and an already-selected local target is not reopened', async (t) => {
  for (const response of [{ ok: true, sessionId: '', reason: 'keep-current' }, { ok: true, sessionId: 'current-session', reason: 'busy' }]) {
    await t.test(response.sessionId || 'empty target', async (subtest) => {
      const env = browser({ response });
      const opened = [];
      const controller = loadClient(env).createInitialSessionFocusController({
        openLocalSession: (id) => opened.push(id), readLocalSessionId: () => 'current-session',
      });
      subtest.after(() => controller.dispose());
      controller.update(local());
      await env.settle();
      assert.deepEqual(opened, []);
      assert.equal(env.results()[0].result, response.sessionId ? 'already-selected' : 'keep-current');
      assert.equal(env.results()[0].action, 'reportClientEvent');
      assert.ok(env.requests.find(({ payload }) => payload.event === 'initial-session-focus').keepalive);
    });
  }
});

test('an old backend state snapshot is not mistaken for a supported empty focus result', async (t) => {
  const env = browser({ response: { ok: true, self: { status: 'busy' }, devices: [] } });
  const opened = [];
  const controller = loadClient(env).createInitialSessionFocusController({
    openLocalSession: (id) => opened.push(id), readLocalSessionId: () => 'current-session',
  });
  t.after(() => controller.dispose());
  controller.update(local());
  await env.settle();
  assert.deepEqual(opened, []);
  assert.equal(env.results()[0].result, 'query-failed');
  assert.equal(env.results()[0].reason, 'focus-api-unavailable');
});

test('a pending local query yields to input, manual session selection or leaving the panel', async (t) => {
  for (const cancellation of ['input', 'selection', 'panel']) {
    await t.test(cancellation, async (subtest) => {
      const env = browser();
      const pending = deferred();
      env.responses.push(pending.promise);
      const opened = [];
      let selected = 'current-session';
      const controller = loadClient(env).createInitialSessionFocusController({
        openLocalSession: (id) => opened.push(id), readLocalSessionId: () => selected,
      });
      subtest.after(() => controller.dispose());
      controller.update(local());
      if (cancellation === 'input') env.document.activeElement = { tagName: 'TEXTAREA' };
      if (cancellation === 'selection') selected = 'manually-selected';
      if (cancellation === 'panel') controller.update(local({ allowed: false }));
      pending.resolve({ ok: true, sessionId: 'busy-session', reason: 'busy' });
      await env.settle();
      assert.deepEqual(opened, []);
      assert.equal(env.results().length, 1);
      assert.equal(env.results()[0].result, cancellation === 'panel' ? 'cancelled-navigation' : 'skipped-user-input');
    });
  }
});

test('a pending remote query yields to iframe focus, switching devices or replacing the old page', async (t) => {
  for (const cancellation of ['input', 'outer-input', 'modal', 'switch', 'replacement']) {
    await t.test(cancellation, async (subtest) => {
      const env = browser();
      const pending = deferred();
      env.responses.push(pending.promise);
      const controller = loadClient(env).createInitialSessionFocusController();
      subtest.after(() => controller.dispose());
      const page = env.frame();
      const other = env.frame();
      controller.update(remote(page));
      if (cancellation === 'input') env.document.activeElement = page;
      if (cancellation === 'outer-input') env.document.activeElement = { tagName: 'TEXTAREA' };
      if (cancellation === 'modal') env.document.activeElement = { tagName: 'BUTTON', closest: () => ({}) };
      if (cancellation === 'switch') controller.update(remote(other, { deviceId: 'win', routeId: 'win-route', frameKey: 'win_0', allowed: false }));
      if (cancellation === 'replacement') controller.update(remote(other, { frameKey: 'mac_1' }));
      pending.resolve({ ok: true, sessionId: 'busy-session', reason: 'busy' });
      await env.settle();
      await env.advance(4000);
      assert.deepEqual(page.contentWindow.messages, []);
      assert.deepEqual(other.contentWindow.messages, []);
      assert.equal(env.results().length, 1);
      assert.equal(env.results()[0].result, ['input', 'outer-input', 'modal'].includes(cancellation) ? 'skipped-user-input' : cancellation === 'switch' ? 'cancelled-switch' : 'cancelled-navigation');
    });
  }
});

test('remote focus addresses only its target frame, accepts exact acknowledgements and retries the old protocol only once', async (t) => {
  const env = browser();
  const controller = loadClient(env).createInitialSessionFocusController();
  t.after(() => controller.dispose());
  const page = env.frame();
  const unrelated = env.frame();
  controller.update(remote(page));
  await env.settle();
  const primary = page.contentWindow.messages[0];
  assert.equal(primary.type, 'initial-session-focus');
  assert.equal(primary.sessionId, 'busy-session');
  assert.deepEqual(unrelated.contentWindow.messages, []);
  env.emit('message', { source: unrelated.contentWindow, data: { ...primary, type: 'initial-session-focus-result', result: 'applied' } });
  acknowledge(env, page, primary, { source: 'other' });
  acknowledge(env, page, primary, { type: 'other' });
  acknowledge(env, page, primary, { requestId: 'other' });
  acknowledge(env, page, primary, { sessionId: 'other' });
  acknowledge(env, page, primary, { result: 'invalid-result' });
  acknowledge(env, page, primary, { result: 'not-ready' });
  await env.advance(800);
  assert.equal(page.contentWindow.messages.length, 2);
  const fallback = page.contentWindow.messages[1];
  assert.equal(fallback.source, 'dsh-au-todo');
  assert.equal(fallback.type, 'dsh-au-todo:select-session');
  assert.equal(fallback.initialFocus, true);
  assert.equal(fallback.requestId, primary.requestId);
  assert.equal(fallback.sessionId, primary.sessionId);
  acknowledge(env, page, primary);
  await env.advance(4000);
  assert.equal(page.contentWindow.messages.length, 2);
  assert.equal(env.results()[0].result, 'applied');
  assert.equal(env.timers.size, 0);
  controller.dispose();
  assert.equal(env.listeners.get('message').size, 0);

  // A peer with no acknowledgement gets one compatibility retry, not a forced reload.
  const oldEnv = browser();
  const old = loadClient(oldEnv).createInitialSessionFocusController();
  t.after(() => old.dispose());
  const oldPage = oldEnv.frame();
  old.update(remote(oldPage));
  await oldEnv.settle();
  await oldEnv.advance(4000);
  assert.equal(oldPage.contentWindow.messages.length, 2);
  assert.equal(oldEnv.results()[0].result, 'sent-unconfirmed');
  assert.equal(oldEnv.timers.size, 0);
});

// Context.get, the official sessions list and uiWorkspace are host SDK boundaries. Use real
// snapshot objects and initialize private product context solely through the actual apply().
function controlledClient(t, env, { selected = 'current-session', available = true, throwOpen = false } = {}) {
  env.win.name = 'dsh-au-controlled:mac';
  const client = loadClient(env);
  const effects = [];
  const opened = [];
  const subscribers = new Set();
  const sessions = { list: {
    getSnapshot: () => ({ byId: { [selected]: { id: selected, retainedBy: { mainView: 1 } } } }),
    subscribe: (listener) => { subscribers.add(listener); return () => subscribers.delete(listener); },
  } };
  const uiWorkspace = available ? { openSession(id) { if (throwOpen) throw new Error('host navigation failed'); opened.push(id); selected = id; } } : {};
  const ctx = {
    get: (name) => ({ sessions, uiWorkspace })[name],
    effect: (callback, label) => effects.push({ callback, label }),
    slots: { inject() {}, register() { return () => {}; } },
  };
  client.apply(ctx);
  const dispose = client.installControlledFrameShortcutBridge();
  t.after(dispose);
  // Also run the real legacy Todo listener via its registered host effect, proving that the
  // new receiver stops that listener rather than mocking away its confirmation side effect.
  const legacy = effects.find(({ label }) => label === 'dsh-au-todo: controlled session bridge');
  assert.ok(legacy, 'production apply must register the controlled Todo bridge');
  const disposeLegacy = legacy.callback();
  t.after(disposeLegacy);
  return { opened, dispose, uiWorkspace };
}
function focusMessage(sessionId = 'busy-session', requestId = 'request-1', legacy = false) {
  return legacy ? { source: 'dsh-au-todo', type: 'dsh-au-todo:select-session', initialFocus: true, sessionId, requestId }
    : { source: 'dsh-au', type: 'initial-session-focus', sessionId, requestId };
}

test('controlled receiver validates parent and IDs, deduplicates new/legacy focus, and navigates without confirming or sending', async (t) => {
  const env = browser();
  const receiver = controlledClient(t, env);
  env.emit('message', { source: {}, data: focusMessage() });
  env.emit('message', { source: env.win.parent, data: focusMessage('') });
  env.emit('message', { source: env.win.parent, data: focusMessage('busy-session', '') });
  assert.deepEqual(receiver.opened, []);
  assert.deepEqual(env.parentMessages, []);
  env.emit('message', { source: env.win.parent, data: focusMessage() });
  env.emit('message', { source: env.win.parent, data: focusMessage('busy-session', 'request-1', true) });
  env.emit('message', { source: env.win.parent, data: focusMessage('busy-session', 'request-2') });
  await env.settle();
  assert.deepEqual(receiver.opened, ['busy-session']);
  assert.deepEqual(env.parentMessages.map((message) => message.result), ['applied', 'already-selected', 'already-selected']);
  assert.ok(env.parentMessages.every((message) => message.type === 'initial-session-focus-result'));
  assert.deepEqual(env.requests, [], 'neither new nor compatibility focus may confirm or send any API action');
  receiver.dispose();
  env.emit('message', { source: env.win.parent, data: focusMessage('other-session', 'request-3') });
  assert.deepEqual(receiver.opened, ['busy-session']);
});

test('trusted remote interaction refuses delayed initial navigation while missing or failed SDKs return explicit results', async (t) => {
  for (const type of ['input', 'pointerdown', 'keydown']) {
    await t.test(type, async (subtest) => {
      const env = browser();
      const receiver = controlledClient(subtest, env);
      // Synthetic input must not suppress the initial-focus request; real user input must.
      env.emit(type, { isTrusted: false, code: 'KeyA', key: 'a' });
      env.emit('message', { source: env.win.parent, data: focusMessage() });
      assert.deepEqual(receiver.opened, ['busy-session']);
      env.emit(type, { isTrusted: true, code: 'KeyA', key: 'a' });
      env.emit('message', { source: env.win.parent, data: focusMessage('other-session', 'request-2', true) });
      assert.deepEqual(receiver.opened, ['busy-session']);
      assert.equal(env.parentMessages.at(-1).result, 'skipped-user-input');
      assert.deepEqual(env.requests, []);
    });
  }
  for (const options of [{ available: false, result: 'not-ready' }, { throwOpen: true, result: 'open-failed' }]) {
    await t.test(options.result, async (subtest) => {
      const env = browser();
      const receiver = controlledClient(subtest, env, options);
      env.emit('message', { source: env.win.parent, data: focusMessage() });
      assert.deepEqual(receiver.opened, []);
      assert.equal(env.parentMessages.at(-1).result, options.result);
      assert.deepEqual(env.requests, []);
    });
  }
});
