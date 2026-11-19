import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../scripts/build-client.js';

function makeWindow() {
  const listeners = new Map();
  const values = new Map();
  return {
    name: '',
    location: { href: 'http://127.0.0.1:4770/' },
    localStorage: {
      getItem: (key) => values.get(key) || null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
    addEventListener: (type, listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
    dispatchEvent: (event) => {
      for (const listener of [...(listeners.get(event.type) || [])]) listener(event);
    },
    setTimeout,
    clearTimeout,
  };
}

function makeReact(stateValues) {
  let cursor = 0;
  let refs = [];
  let effects = [];
  let renderAgain = () => {};
  const sameDeps = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
    useState: (initial) => {
      const index = cursor++;
      if (stateValues[index] === undefined) stateValues[index] = typeof initial === 'function' ? initial() : initial;
      return [stateValues[index], (next) => {
        stateValues[index] = typeof next === 'function' ? next(stateValues[index]) : next;
        renderAgain();
      }];
    },
    useEffect: (effect, deps) => {
      const index = cursor++;
      const previous = effects[index];
      if (!previous || !sameDeps(previous.deps, deps)) effects[index] = { effect, deps, pending: true, cleanup: previous?.cleanup };
    },
    useCallback: (fn) => fn,
    useRef: (value) => {
      const index = cursor++;
      if (!refs[index]) refs[index] = { current: value };
      return refs[index];
    },
    reset: () => { cursor = 0; },
    setRender: (fn) => { renderAgain = fn; },
    flushEffects: () => {
      for (const entry of effects) {
        if (!entry?.pending) continue;
        entry.pending = false;
        entry.cleanup?.();
        entry.cleanup = entry.effect?.();
      }
    },
    unmount: () => {
      for (const entry of effects) entry?.cleanup?.();
    },
  };
  return React;
}

function walk(node, out = []) {
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, out));
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  walk(node.props?.children, out);
  return out;
}

function createHarness(t, { saveFailure = false } = {}) {
  const window = makeWindow();
  let definition = null;
  window.__ModuleLoader__ = { load: (next) => { definition = next; } };
  const originalFetch = globalThis.fetch;
  const saved = [];
  const config = {
    enabled: true,
    binding: { code: 'KeyM', ctrl: false, alt: true, shift: false, meta: false },
    slots: [
      { provider: 'p', model: 'one', label: 'One' },
      null,
      { provider: 'p', model: 'three', label: 'Three' },
      null,
      { provider: 'p', model: 'five', label: 'Five' },
      { provider: 'p', model: 'six', label: 'Six' },
      null,
      { provider: 'p', model: 'eight', label: 'Eight' },
      { provider: 'p', model: 'nine', label: 'Nine' },
    ],
  };
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.action === 'saveModelShortcuts') {
      saved.push(body);
      if (!saveFailure && body.slots) config.slots = body.slots;
      return {
        ok: !saveFailure,
        status: saveFailure ? 500 : 200,
        text: async () => JSON.stringify(saveFailure ? { ok: false, error: '保存失败' } : { ok: true, modelShortcuts: config }),
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, modelShortcuts: config }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  new Function('window', 'document', 'localStorage', build())(window, { activeElement: null }, window.localStorage);
  // Initialize hooks normally: configuration and catalog enter through real production loaders.
  const React = makeReact([]);
  const mod = definition.factory((id) => {
    if (id === 'react') return React;
    if (id === 'react-dom') return { createPortal: (element) => element };
    throw new Error(`未预期的 require：${id}`);
  });
  const hostServices = {
    sessions: { list: { getSnapshot: () => ({ byId: { visible: { id: 'visible', retainedBy: { mainView: 1 } } } }) } },
    modelDirectories: { directoryFor: () => ({
      load: async () => ({ groups: [{ id: 'p', name: 'Provider', models: config.slots.filter(Boolean).map((slot) => ({ id: slot.model, name: slot.label })) }], current: { provider: 'p', model: 'one' } }),
      select: () => { throw new Error('Sorting must not select a Host model'); },
    }) },
  };
  const disposeModelShortcuts = mod.apply.modelShortcuts.installModelShortcuts({ get: (name) => hostServices[name] });
  t.after(() => { React.unmount(); disposeModelShortcuts(); });
  const settings = mod.apply.modelShortcutSettings;
  let tree = null;
  let activeHandle = null;
  const domRows = [];
  const domHandles = [];
  const root = {
    querySelectorAll: (selector) => selector === '.dsh-au-model-shortcut-row' ? domRows : [],
  };
  for (let index = 0; index < 9; index += 1) {
    const handle = {
      index,
      focusCount: 0,
      focused: false,
      captured: new Set(),
      getBoundingClientRect: () => ({ top: index * 50, height: 40 }),
      focus() { activeHandle = this; this.focused = true; this.focusCount += 1; },
      closest: () => root,
      setPointerCapture(pointerId) { this.captured.add(pointerId); },
      releasePointerCapture(pointerId) { this.captured.delete(pointerId); this.released = true; },
    };
    const row = {
      getBoundingClientRect: () => ({ top: index * 50, height: 40 }),
      querySelector: (selector) => selector === '.dsh-au-model-shortcut-drag-handle' ? handle : null,
    };
    domHandles.push(handle);
    domRows.push(row);
  }
  const render = () => {
    React.reset();
    tree = settings.ModelShortcutSettingsGroup();
    React.flushEffects();
    return tree;
  };
  React.setRender(render);
  render();
  const nodes = () => walk(tree);
  const handleAt = (index) => nodes().filter((node) => node.props?.className === 'dsh-au-model-shortcut-drag-handle')[index];
  const selectAt = (index) => nodes().filter((node) => node.type === 'select' && node.props?.className === 'dsh-au-model-shortcut-select')[index];
  const ready = (async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (mod.apply.modelShortcuts.modelShortcutsStore.snapshot.loaded && selectAt(0)?.props.disabled === false) return;
      await new Promise(setImmediate);
    }
    throw new Error('Configuration and Host catalog did not finish loading');
  })();
  const pointerTarget = (index, pointerType = 'mouse') => {
    const handle = handleAt(index);
    handle.props.onPointerDown({
      pointerId: 1, pointerType, clientX: 0, clientY: index * 50 + 20, currentTarget: domHandles[index],
      preventDefault() {}, stopPropagation() {},
    });
    return handle;
  };
  return {
    config, saved, render, nodes, handleAt, selectAt, pointerTarget, settings, ready, modelShortcuts: mod.apply.modelShortcuts, domHandles, root,
    getActiveHandle: () => activeHandle,
    dispatchKey: (event) => window.dispatchEvent({ type: 'keydown', ...event }),
    unmount: () => React.unmount(),
  };
}

function pointerEvent(handle, overrides = {}) {
  return {
    pointerId: 1, pointerType: 'mouse', clientX: 0, clientY: 20, currentTarget: handle,
    preventDefault() {}, stopPropagation() {}, ...overrides,
  };
}

test('拖动保留全部九槽与 null，跨行移动只保存一次', async (t) => {
  const h = createHarness(t);
  await h.ready;
  const handle = h.pointerTarget(7, 'touch');
  handle.props.onPointerMove(pointerEvent(h.domHandles[7], { pointerType: 'touch', clientY: 60 }));
  await handle.props.onPointerUp(pointerEvent(h.domHandles[7], { pointerType: 'touch', clientY: 60 }));

  assert.equal(h.saved.length, 1);
  assert.equal(h.domHandles[7].released, true, 'touch pointerup 必须释放 capture');
  assert.equal(h.getActiveHandle(), h.domHandles[1], '成功重排后焦点跟随模型到目标槽');
  assert.deepEqual(h.saved[0].slots.map((slot) => slot?.model || null), [
    'one', 'eight', null, 'three', null, 'five', 'six', null, 'nine',
  ]);
});

test('拖动 no-op、pointercancel 与 Escape 都不保存', async (t) => {
  const h = createHarness(t);
  await h.ready;
  const handle = h.pointerTarget(3);
  handle.props.onPointerMove(pointerEvent(h.domHandles[3], { clientY: 170 }));
  await handle.props.onPointerUp(pointerEvent(h.domHandles[3], { clientY: 170 }));
  assert.equal(h.saved.length, 0, '回到原位置不得保存');
  assert.equal(h.domHandles[3].released, true, 'no-op pointerup 也必须释放 capture');

  const cancelHandle = h.handleAt(2);
  cancelHandle.props.onPointerDown(pointerEvent(h.domHandles[2]));
  cancelHandle.props.onPointerMove(pointerEvent(h.domHandles[2], { clientY: 10 }));
  cancelHandle.props.onPointerCancel(pointerEvent(h.domHandles[2]));
  assert.equal(h.saved.length, 0, 'pointercancel 不得保存');
  assert.equal(h.domHandles[2].released, true, 'pointercancel 必须释放 capture');

  const escapeHandle = h.handleAt(1);
  escapeHandle.props.onPointerDown(pointerEvent(h.domHandles[1]));
  h.dispatchKey({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  await new Promise(setImmediate);
  assert.equal(h.saved.length, 0, 'Escape 取消拖动不得保存');
  assert.equal(h.domHandles[1].released, true, '窗口 Escape 必须释放 capture');
  assert.equal(h.getActiveHandle(), h.domHandles[1], '窗口 Escape 必须把焦点留在原握柄');
});

test('组件卸载释放未完成拖动的 pointer capture', async (t) => {
  const h = createHarness(t);
  await h.ready;
  h.pointerTarget(4);
  h.unmount();
  assert.equal(h.domHandles[4].released, true);
  assert.equal(h.saved.length, 0);
});

test('握柄键盘上下移动保存一次并跟随同一项，SyntheticEvent 清空 currentTarget 也不丢焦点', async (t) => {
  const h = createHarness(t);
  await h.ready;
  const first = h.handleAt(0);
  const firstEvent = { key: 'ArrowDown', currentTarget: h.domHandles[0], preventDefault() {}, stopPropagation() {} };
  first.props.onKeyDown(firstEvent);
  firstEvent.currentTarget = null;
  await new Promise(setImmediate);
  assert.equal(h.saved.length, 1);
  assert.equal(h.getActiveHandle(), h.domHandles[1], '第一次键盘移动后焦点到目标槽');
  assert.deepEqual(h.saved[0].slots.map((slot) => slot?.model || null), [
    null, 'one', 'three', null, 'five', 'six', null, 'eight', 'nine',
  ]);

  const second = h.handleAt(1);
  const secondEvent = { key: 'ArrowDown', currentTarget: h.domHandles[1], preventDefault() {}, stopPropagation() {} };
  second.props.onKeyDown(secondEvent);
  secondEvent.currentTarget = null;
  await new Promise(setImmediate);
  assert.equal(h.saved.length, 2, '连续键盘移动每次只保存一次');
  assert.equal(h.getActiveHandle(), h.domHandles[2], '连续 ArrowDown 继续移动同一个模型');
  assert.deepEqual(h.saved[1].slots.map((slot) => slot?.model || null), [
    null, 'three', 'one', null, 'five', 'six', null, 'eight', 'nine',
  ]);
  assert.equal(h.selectAt(0).props.onPointerDown, undefined, '模型下拉控件不得启动拖动');
});

test('保存失败恢复原顺序并保留原配置', async (t) => {
  const h = createHarness(t, { saveFailure: true });
  await h.ready;
  const handle = h.pointerTarget(0);
  const container = { querySelectorAll: () => Array.from({ length: 9 }, (_, index) => ({ getBoundingClientRect: () => ({ top: index * 50, height: 40 }) })) };
  const current = { ...handle, closest: () => container, releasePointerCapture() {} };
  handle.props.onPointerMove(pointerEvent(handle, { clientY: 220, currentTarget: current }));
  await handle.props.onPointerUp(pointerEvent(handle, { clientY: 220, currentTarget: current }));
  assert.equal(h.saved.length, 1);
  assert.equal(h.getActiveHandle(), h.domHandles[0], '保存失败后焦点回到原槽');
  assert.deepEqual(h.config.slots.map((slot) => slot?.model || null), [
    'one', null, 'three', null, 'five', 'six', null, 'eight', 'nine',
  ]);
  const restored = h.render();
  const values = walk(restored)
    .filter((node) => node.type === 'select' && node.props?.className === 'dsh-au-model-shortcut-select')
    .map((node) => node.props.value);
  assert.deepEqual(values.map((value) => value.split('\u0000')[1] || null), h.config.slots.map((slot) => slot?.model || null));
});

test('同模型不同推理档位只标真正当前项，并优先展示已保存强度', async (t) => {
  const h = createHarness(t);
  await h.ready;
  const catalog = {
    current: { provider: 'p', model: 'same', reasoningEffort: 'xhigh' },
    models: [{
      provider: 'p', model: 'same', label: 'Same', providerLabel: 'Provider',
      reasoningDefault: 'high', reasoningDefaultLabel: 'High',
      reasoningEfforts: [{ id: 'high', name: 'High' }, { id: 'xhigh', name: 'Xhigh' }],
    }],
  };
  const rows = h.modelShortcuts.configuredModelShortcutRows([
    { provider: 'p', model: 'same', label: 'Same / High', reasoningEffort: 'high' },
    { provider: 'p', model: 'same', label: 'Same / Xhigh', reasoningEffort: 'xhigh' },
  ], catalog);
  assert.equal(rows[0].current, false, '同模型但不同强度不能标当前');
  assert.equal(rows[1].current, true, '保存 xhigh 且当前 xhigh 才标当前');
  assert.equal(rows[0].reasoningLabel, 'High');
  assert.equal(rows[1].reasoningLabel, 'Xhigh', '弹层应优先展示已保存强度而非提供方默认 High');
  const defaultCurrentRows = h.modelShortcuts.configuredModelShortcutRows(rows.map((row) => row.selection), {
    ...catalog,
    current: { provider: 'p', model: 'same' },
  });
  assert.deepEqual(defaultCurrentRows.map((row) => row.current), [true, false], 'current 无强度时使用目录默认 high');
});
