import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../scripts/build-client.js';

// Browser, HTTP and Host SDK are external boundaries; exercise the real assembled plugin between them.
function fixture(t, { controlled = false, parent = null, nativeRpc = false, describeBinding = null, desktop = false, fetchResponse = null } = {}) {
  const listeners = new Map();
  const selections = [];
  const nativeListeners = new Set();
  const fixedBindings = new Map();
  const nativeCommands = new Map();
  let nativeOverride = null;
  const catalogListeners = new Set();
  const effectiveBinding = (definition) => nativeOverride || definition.defaults['desktop:windows'];
  const keyboard = { subscribe: (listener) => { nativeListeners.add(listener); return () => nativeListeners.delete(listener); } };
  let sessionId = controlled ? 'remote-visible' : 'local-visible';
  let nextLoad = null;
  let groups = [{ id: 'provider', name: 'Provider', models: [
    { id: 'first', name: 'First' },
    { id: 'ninth', name: 'Ninth', reasoning: { efforts: [{ id: 'high', name: 'High' }] } },
  ] }];
  const config = { enabled: false, binding: { code: 'KeyM', ctrl: false, alt: true, shift: false, meta: false }, slots: Array(9).fill(null) };
  config.slots[0] = { provider: 'provider', model: 'first' };
  config.slots[2] = { provider: 'missing', model: 'unavailable' };
  config.slots[8] = { provider: 'provider', model: 'ninth', reasoningEffort: 'high' };
  const emit = (type, event) => { for (const handler of [...(listeners.get(type) || [])]) handler(event); };
  const win = {
    name: controlled ? 'dsh-au-controlled:remote' : '', parent,
    setTimeout, clearTimeout, postMessage() {}, location: { href: 'http://127.0.0.1:4770/' },
    addEventListener: (type, listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
    __ModuleLoader__: { load: (value) => { definition = value; } },
  };
  if (desktop) win.dshDesktop = { keyboard };
  win.top = controlled ? parent : win;
  if (!controlled) win.parent = win;
  let definition;
  const fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const extra = fetchResponse ? await fetchResponse(body) : null;
    if (extra) return { ok: extra.ok !== false, status: extra.ok === false ? 501 : 200, text: async () => JSON.stringify(extra) };
    if (body.action === 'saveModelShortcuts') {
      for (const field of ['enabled', 'binding', 'slots']) if (Object.hasOwn(body, field)) config[field] = body[field];
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, modelShortcuts: config }) };
  };
  const doc = { activeElement: null };
  new Function('window', 'document', 'localStorage', 'fetch', build())(win, doc, { getItem: () => null }, fetch);
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }), Fragment: Symbol('Fragment'),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: () => {}, useCallback: (fn) => fn, useRef: (value) => ({ current: value }),
  };
  const mod = definition.factory((id) => id === 'react' ? react : { createPortal: () => ({}) });
  const hostCatalog = async () => {
    if (nextLoad) { const pending = nextLoad; nextLoad = null; await pending; }
    return { groups, current: { provider: 'provider', model: 'first' } };
  };
  const services = {
    shortcuts: describeBinding || desktop ? {
      platform: 'windows', runtime: desktop ? 'desktop' : 'web', config: { getSnapshot: () => ({ revision: 1 }) },
      describeBinding: describeBinding || ((binding) => ({ issue: null, conflicts: [...nativeCommands.values()].filter((definition) => {
        const current = effectiveBinding(definition);
        return current.code === binding.code && JSON.stringify(current.modifiers) === JSON.stringify(binding.modifiers);
      }).map((definition) => definition.id) })),
      registerFixed: (definition) => { fixedBindings.set(definition.id, definition); return () => fixedBindings.delete(definition.id); },
      register: (definition) => { nativeCommands.set(definition.id, definition); return () => nativeCommands.delete(definition.id); },
      edit: () => { throw new Error('Project model key must never write Host preferences'); },
      catalog: {
        getSnapshot: () => [...nativeCommands.values()].map((definition) => ({ id: definition.id, binding: effectiveBinding(definition) })),
        subscribe: (listener) => { catalogListeners.add(listener); return () => catalogListeners.delete(listener); },
      },
      fixedCatalog: { getSnapshot: () => [...fixedBindings.values()] },
    } : null,
    sessions: { list: { getSnapshot: () => ({ byId: sessionId ? { [sessionId]: { id: sessionId, retainedBy: { mainView: 1 } } } : {} }) } },
    modelDirectories: nativeRpc ? null : { directoryFor: (id) => ({
      load: hostCatalog,
      select: async (selection) => { selections.push({ sessionId: id, ...selection }); return { ok: true }; },
    }), catalog: { load: async () => { const value = await hostCatalog(); return { groups: value.groups, default: value.current }; } } },
    remote: { session: {
      modelCatalog: async () => ({ ok: true, value: await hostCatalog() }),
      selectModel: async (selection) => { selections.push(selection); return { ok: true }; },
    } },
  };
  const ctx = { get: (name) => services[name], remote: services.remote };
  const api = mod.apply.modelShortcuts;
  const dispose = api.installModelShortcuts(ctx);
  t.after(dispose);
  if (!controlled) api.updateModelShortcutTarget({ deviceId: 'local', frame: null, allowed: true });
  return { api, old: mod.shortcuts, win, doc, emit, ctx, config, selections, fixedBindings, nativeCommands,
    emitNative: (input) => {
      if (input.revision !== 1) return false;
      const definition = [...nativeCommands.values()].find((definition) => {
        const binding = effectiveBinding(definition);
        return binding.code === input.code && ['control', 'alt', 'shift', 'meta'].every((modifier) => binding.modifiers.includes(modifier) === Boolean(input[modifier]));
      });
      if (!definition) return false;
      if (input.kind === 'iframe' && (!doc.activeElement?.isConnected || input.frameName !== doc.activeElement.name
        || !doc.activeElement.matches?.('iframe[data-html-preview]'))) return false;
      const resolution = definition.resolve({ target: doc.activeElement, region: 'page', modal: null,
        ...(input.kind === 'iframe' ? { source: 'iframe' } : {}) });
      if (resolution.status === 'handled' && !input.repeat) resolution.run();
      return true;
    },
    setNativeOverride: (binding) => { nativeOverride = binding; for (const listener of catalogListeners) listener(); },
    setSession: (id) => { sessionId = id; }, setGroups: (value) => { groups = value; },
    delayNextLoad: (value) => { nextLoad = value; } };
}

function key(code, modifiers = {}) {
  const event = { code, ...modifiers, prevented: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() {} };
  return event;
}

async function enable(f) {
  f.config.enabled = true;
  await f.api.loadModelShortcuts();
}

test('default-disabled and closed list never consume normal digits; clear and change apply only to the model trigger', async (t) => {
  const f = fixture(t);
  await f.api.loadModelShortcuts();
  for (const event of [key('Digit1'), key('Numpad9'), key('KeyM', { altKey: true })]) {
    assert.equal(f.api.consumeModelShortcutKey(event), false);
    assert.equal(event.prevented, false);
  }
  await enable(f);
  await f.api.saveModelShortcuts({ binding: null });
  assert.equal(f.api.consumeModelShortcutKey(key('KeyM', { altKey: true })), false);
  await f.api.saveModelShortcuts({ binding: { code: 'KeyJ', ctrl: true, alt: false, shift: false, meta: false } });
  assert.equal(f.api.consumeModelShortcutKey(key('KeyM', { altKey: true })), false);
  assert.deepEqual(f.old.shortcutStore.overrides, {}, 'shared trigger must not enter the browser override table');
  assert.equal(f.api.validateModelShortcutBinding({ code: 'BracketLeft', ctrl: false, alt: true, shift: false, meta: false }).ok, false);
  assert.equal(f.old.validateShortcutBinding({ code: 'KeyJ', ctrl: true, alt: false, shift: false, meta: false }, 'menu.open').ok, false);
});

test('Host reserved bindings and catalog conflicts refuse enabling without rewriting configuration', async (t) => {
  for (const description of [{ issue: 'reserved', conflicts: [] }, { issue: null, conflicts: ['host.command'] }]) {
    const f = fixture(t, { describeBinding: (binding) => {
      assert.deepEqual(binding, { code: 'KeyM', modifiers: ['alt'] });
      return description;
    } });
    await f.api.loadModelShortcuts();
    await assert.rejects(f.api.saveModelShortcuts({ enabled: true }), /宿主|冲突/);
    assert.equal(f.config.enabled, false);
    assert.equal(f.api.modelShortcutsStore.snapshot.enabled, false);
    assert.equal(f.api.modelShortcutsStore.snapshot.busy, false);
  }
});

test('holes and unavailable models retain numbers; digit 9 switches only the visible session through the Host', async (t) => {
  for (const nativeRpc of [false, true]) {
    const f = fixture(t, { nativeRpc });
    await enable(f);
    await f.api.openModelShortcutPopup();
    const popup = f.api.modelShortcutPopup.snapshot;
    assert.deepEqual(f.api.configuredModelShortcutRows(f.config.slots, popup.catalog).map((row) => [row.number, row.available]), [[1, true], [3, false], [9, true]]);
    assert.equal(await f.api.selectModelShortcutNumber(2), false);
    assert.equal(await f.api.selectModelShortcutNumber(3), false);
    assert.equal(f.selections.length, 0);
    assert.match(f.api.modelShortcutPopup.snapshot.error, /不可用/);
    assert.equal(await f.api.selectModelShortcutNumber(9), true);
    assert.deepEqual(f.selections, [{ sessionId: 'local-visible', provider: 'provider', model: 'ninth', reasoningEffort: 'high' }]);
    assert.equal(f.api.modelShortcutPopup.snapshot.open, false);
    assert.equal(f.api.consumeModelShortcutKey(key('Digit9')), false);
  }
});

test('Escape closes the list, modifiers and IME do not select a numbered model', async (t) => {
  const f = fixture(t);
  await enable(f);
  await f.api.openModelShortcutPopup();
  for (const event of [key('Digit1', { shiftKey: true }), key('Digit1', { isComposing: true }), key('Digit1', { ctrlKey: true })]) {
    assert.equal(f.api.consumeModelShortcutKey(event), false);
  }
  const escape = key('Escape');
  assert.equal(f.api.consumeModelShortcutKey(escape), true);
  assert.equal(escape.prevented, true);
  assert.equal(f.api.modelShortcutPopup.snapshot.open, false);
  assert.equal(f.selections.length, 0);
});

test('session change or model disappearance while loading refuses the switch without a fallback', async (t) => {
  for (const changed of ['session', 'catalog']) {
    const f = fixture(t);
    await enable(f);
    await f.api.openModelShortcutPopup();
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    f.delayNextLoad(waiting);
    const selection = f.api.selectModelShortcutNumber(1);
    if (changed === 'session') f.setSession('different-session');
    else f.setGroups([]);
    release();
    assert.equal(await selection, false);
    assert.equal(f.selections.length, 0);
    assert.match(f.api.modelShortcutPopup.snapshot.error, /已改变|不可用/);
  }
});

test('settings can read the current Host catalog without allowing an actual switch outside the conversation', async (t) => {
  const f = fixture(t);
  f.api.updateModelShortcutTarget({ deviceId: 'local', frame: null, allowed: false });
  f.setSession('');
  const catalog = await f.api.loadModelShortcutCatalog();
  assert.equal(catalog.models.length, 2);
  assert.deepEqual(catalog.current, { provider: 'provider', model: 'first' });
  await enable(f);
  await f.api.openModelShortcutPopup();
  assert.match(f.api.modelShortcutPopup.snapshot.error, /先打开/);
  assert.equal(await f.api.selectModelShortcutNumber(1), false);
  assert.equal(f.selections.length, 0);
});

test('remote iframe requests address only its visible session; background and forged replies cannot redirect selection', async (t) => {
  const top = fixture(t);
  const child = fixture(t, { controlled: true, parent: top.win });
  child.win.postMessage = (data) => {
    if (data.type === 'model-shortcut-request') top.emit('message', { source: {}, data: {
      source: 'dsh-au', type: 'model-shortcut-result', requestId: data.requestId, ok: true, value: { sessionId: 'forged-session', models: [] },
    } });
    queueMicrotask(() => child.emit('message', { source: top.win, data }));
  };
  top.win.postMessage = (data) => queueMicrotask(() => top.emit('message', { source: child.win, data }));
  const frame = { contentWindow: child.win };
  top.api.updateModelShortcutTarget({ deviceId: 'remote', frame, allowed: true });
  const push = () => top.old.postShortcutConfig(child.win);
  top.api.modelShortcutsStore.listeners.add(push);
  t.after(() => top.api.modelShortcutsStore.listeners.delete(push));
  await enable(top);
  await top.api.openModelShortcutPopup();
  assert.equal(top.api.modelShortcutPopup.snapshot.catalog.sessionId, 'remote-visible');
  top.emit('message', { source: {}, data: { source: 'dsh-au', type: 'model-shortcut-key', action: 'select', number: 1 } });
  assert.equal(child.selections.length, 0);
  assert.equal(await top.api.selectModelShortcutNumber(9), true);
  assert.equal(top.selections.length, 0, 'viewing remote must never switch the retained local session');
  assert.deepEqual(child.selections, [{ sessionId: 'remote-visible', provider: 'provider', model: 'ninth', reasoningEffort: 'high' }]);
  await top.api.openModelShortcutPopup();
  child.setSession('new-remote-session');
  assert.equal(await top.api.selectModelShortcutNumber(1), false);
  assert.equal(child.selections.length, 1);
  top.api.closeModelShortcutPopup();
  await Promise.resolve();
  const digit = key('Digit1');
  child.emit('keydown', digit);
  assert.equal(digit.prevented, false);
  await top.api.openModelShortcutPopup();
  let release;
  child.delayNextLoad(new Promise((resolve) => { release = resolve; }));
  const pendingSelection = top.api.selectModelShortcutNumber(1);
  await Promise.resolve();
  top.api.updateModelShortcutTarget({ deviceId: 'local', frame: null, allowed: true });
  await Promise.resolve();
  release();
  assert.equal(await pendingSelection, false);
  assert.equal(child.selections.length, 1, 'leaving the remote device during catalog load must cancel its unsubmitted selection');
  top.api.updateModelShortcutTarget({ deviceId: 'remote', frame, allowed: true });
  await top.api.openModelShortcutPopup();
  let releaseOld;
  child.delayNextLoad(new Promise((resolve) => { releaseOld = resolve; }));
  const oldSelection = top.api.selectModelShortcutNumber(1);
  await Promise.resolve();
  top.api.closeModelShortcutPopup();
  await top.api.openModelShortcutPopup();
  releaseOld();
  assert.equal(await oldSelection, false);
  await new Promise(setImmediate);
  assert.equal(child.selections.length, 1, 'reopening on the same device must not reactivate a previous generation selection');
});

test('Host local override is reported, never written back into project config or silently reset', async (t) => {
  const f = fixture(t, { desktop: true });
  await enable(f);
  f.setNativeOverride({ code: 'KeyJ', modifiers: ['control'] });
  assert.match(f.api.modelShortcutsStore.snapshot.error, /本地覆盖/);
  assert.equal(f.config.binding.code, 'KeyM');
  f.emitNative({ kind: 'keyboard', code: 'KeyJ', control: true, revision: 1 });
  assert.equal(f.api.modelShortcutPopup.snapshot.open, false, 'a Host-only key is not the shared project trigger');
  assert.equal(f.emitNative({ kind: 'keyboard', code: 'KeyM', alt: true, revision: 1 }), false);
  f.setNativeOverride(null);
  assert.equal(f.api.modelShortcutsStore.snapshot.error, '');
  assert.deepEqual(f.old.shortcutStore.overrides, {});
});

async function until(predicate) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await new Promise(setImmediate);
  }
  assert.ok(predicate(), 'observable remote operation did not finish');
}

test('late controlled iframe requests fresh config and forwards Alt+M despite its web-only reservation policy', async (t) => {
  const top = fixture(t);
  await enable(top);
  const startup = [];
  top.win.postMessage = (data) => startup.push(data);
  const child = fixture(t, { controlled: true, parent: top.win,
    describeBinding: () => ({ issue: 'unsupported-browser', conflicts: [] }) });
  const frame = { contentWindow: child.win, name: 'dsh-au-controlled:remote' };
  top.api.updateModelShortcutTarget({ deviceId: 'remote', frame, allowed: true });
  child.win.postMessage = (data) => queueMicrotask(() => child.emit('message', { source: top.win, data }));
  top.win.postMessage = (data) => queueMicrotask(() => top.emit('message', { source: child.win, data }));
  const push = () => top.old.postShortcutConfig(child.win);
  top.api.modelShortcutsStore.listeners.add(push);
  t.after(() => top.api.modelShortcutsStore.listeners.delete(push));
  for (const data of startup) top.emit('message', { source: child.win, data });
  await until(() => child.api.modelShortcutsStore.snapshot.loaded);
  const trigger = key('KeyM', { altKey: true, target: { tagName: 'TEXTAREA' } });
  child.emit('keydown', trigger);
  assert.equal(trigger.prevented, true, 'embedded web policy cannot reject its Parent-owned binding');
  await until(() => top.api.modelShortcutPopup.snapshot.open && !top.api.modelShortcutPopup.snapshot.loading);
  assert.equal(top.api.modelShortcutPopup.snapshot.catalog.sessionId, 'remote-visible');
  const digit = key('Digit9');
  top.emit('keydown', digit);
  await until(() => child.selections.length === 1);
  assert.equal(digit.prevented, true);
  assert.equal(top.selections.length, 0);
  assert.deepEqual(child.selections[0], { sessionId: 'remote-visible', provider: 'provider', model: 'ninth', reasoningEffort: 'high' });
});

test('native iframe key opens old remote and exact-route RPC switches only its confirmed visible session', async (t) => {
  for (const changedSession of [false, true]) {
    let visibleSession = 'legacy-visible';
    const remoteSelections = [];
    const requests = [];
    const f = fixture(t, { desktop: true, fetchResponse: (body) => {
      if (body.action === 'getRemoteModelCatalog') {
        requests.push(body);
        return { ok: true, catalog: { default: { provider: 'provider', model: 'ninth' }, current: null,
          groups: [{ id: 'provider', name: 'Remote Provider', models: [{ id: 'ninth', name: 'Ninth',
            reasoning: { efforts: [{ id: 'high', name: 'High' }] } }] }] } };
      }
      if (body.action === 'selectRemoteModel') {
        requests.push(body); remoteSelections.push(body);
        return { ok: true, selected: body.selection };
      }
      return null;
    } });
    const peer = { postMessage: (data) => queueMicrotask(() => {
      // This peer intentionally implements only the existing legacy protocol, not new model messages.
      if (data.type === 'dsh-au:request-workspaces-snapshot') f.emit('message', { source: peer,
        data: { source: 'dsh-au', type: 'dsh-au:controlled-workspaces-snapshot', currentSessionId: visibleSession } });
      if (data.type === 'frame-probe') f.emit('message', { source: peer,
        data: { source: 'dsh-au', type: 'frame-ready', frameId: data.frameId } });
    }) };
    const frame = { contentWindow: peer, name: 'dsh-au-controlled:legacy', isConnected: true, matches: () => true };
    f.api.updateModelShortcutTarget({ deviceId: 'remote-device', routeId: 'opened-tunnel', frame, allowed: true });
    f.doc.activeElement = frame;
    await enable(f);
    assert.equal(f.nativeCommands.size, 1, 'native declaration takes its default from project config, without writing preferences');
    assert.equal(f.fixedBindings.size, 0, 'fixed input references do not provide native capture');
    assert.equal(f.emitNative({ kind: 'iframe', frameName: frame.name, code: 'Digit1', revision: 1 }), false,
      'plain digits must not be native-captured while the picker is closed');
    f.emitNative({ kind: 'iframe', frameName: 'background-device', code: 'KeyM', alt: true, revision: 1 });
    f.emitNative({ kind: 'iframe', frameName: frame.name, code: 'KeyM', alt: true, revision: 99 });
    assert.equal(f.api.modelShortcutPopup.snapshot.open, false, 'wrong frame or stale native revision is ignored');
    f.emitNative({ kind: 'iframe', frameName: frame.name, code: 'KeyM', alt: true, revision: 1 });
    await until(() => f.api.modelShortcutPopup.snapshot.open && !f.api.modelShortcutPopup.snapshot.loading);
    assert.equal(f.api.modelShortcutPopup.snapshot.target.sessionId, 'legacy-visible');
    assert.equal(f.api.modelShortcutPopup.snapshot.catalog.current, null, 'Host deployment default cannot impersonate session current');
    if (changedSession) visibleSession = 'another-session';
    f.doc.activeElement = { role: 'dialog' };
    f.emit('keydown', key('Digit9'));
    await until(() => changedSession ? Boolean(f.api.modelShortcutPopup.snapshot.error) : remoteSelections.length === 1);
    if (changedSession) {
      assert.equal(remoteSelections.length, 0);
      assert.match(f.api.modelShortcutPopup.snapshot.error, /当前对话已改变/);
    } else {
      assert.deepEqual(remoteSelections[0], { action: 'selectRemoteModel', deviceId: 'remote-device',
        routeId: 'opened-tunnel', sessionId: 'legacy-visible', selection: { provider: 'provider', model: 'ninth', reasoningEffort: 'high' } });
    }
    assert.equal(f.selections.length, 0, 'old remote compatibility must never change the retained local session');
    assert.ok(requests.every((request) => request.routeId === 'opened-tunnel'));
    f.api.closeModelShortcutPopup();
    await f.api.saveModelShortcuts({ binding: null });
    assert.equal(f.nativeCommands.size, 0, 'clearing project trigger removes native capture');
    assert.deepEqual(f.old.shortcutStore.overrides, {});
  }
});

test('old local plugin status snapshot cannot fake a successful remote catalog or selection receipt', async (t) => {
  for (const staleAt of ['catalog', 'select']) {
    const f = fixture(t, { fetchResponse: (body) => {
      if (body.action === 'getRemoteModelCatalog') return staleAt === 'catalog'
        ? { ok: true, self: { deviceId: 'local' } }
        : { ok: true, catalog: { current: null, groups: [{ id: 'provider', name: 'Provider', models: [{ id: 'ninth', name: 'Ninth',
          reasoning: { efforts: [{ id: 'high', name: 'High' }] } }] }] } };
      if (body.action === 'selectRemoteModel') return { ok: true, self: { deviceId: 'local' } };
      return null;
    } });
    const peer = { postMessage: (data) => queueMicrotask(() => {
      if (data.type === 'dsh-au:request-workspaces-snapshot') f.emit('message', { source: peer,
        data: { source: 'dsh-au', type: 'dsh-au:controlled-workspaces-snapshot', currentSessionId: 'legacy-visible' } });
      if (data.type === 'frame-probe') f.emit('message', { source: peer,
        data: { source: 'dsh-au', type: 'frame-ready', frameId: data.frameId } });
    }) };
    f.api.updateModelShortcutTarget({ deviceId: 'remote-device', routeId: 'opened-tunnel', frame: { contentWindow: peer }, allowed: true });
    await enable(f);
    f.emit('keydown', key('KeyM', { altKey: true }));
    await until(() => f.api.modelShortcutPopup.snapshot.open && !f.api.modelShortcutPopup.snapshot.loading);
    if (staleAt === 'select') {
      f.emit('keydown', key('Digit9'));
      await until(() => Boolean(f.api.modelShortcutPopup.snapshot.error));
    }
    assert.equal(f.api.modelShortcutPopup.snapshot.open, true, 'no valid selection receipt means the dialog cannot report success');
    assert.match(f.api.modelShortcutPopup.snapshot.error, /载入|重载|有效回执/);
    assert.equal(f.selections.length, 0);
  }
});
