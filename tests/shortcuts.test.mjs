import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function loadShortcuts(fakeWindow = {}) {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  let definition = null;
  const win = { navigator: { platform: 'Win32', userAgent: 'Windows' }, ...fakeWindow,
    __ModuleLoader__: { load: (def) => { definition = def; } } };
  new Function('window', 'navigator', code)(win, win.navigator);
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: Symbol('Fragment'),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
  };
  const mod = definition.factory((id) => {
    if (id === 'react') return fakeReact;
    if (id === 'react-dom') return { createPortal: () => ({}) };
    throw new Error(`未预期的 require：${id}`);
  });
  mod.shortcuts.setShortcutOverrides({}, { persist: false });
  return { api: mod.shortcuts, code };
}

const key = (code, mods = {}) => ({
  code,
  ctrlKey: Boolean(mods.ctrl),
  altKey: Boolean(mods.alt),
  shiftKey: Boolean(mods.shift),
  metaKey: Boolean(mods.meta),
});

test('默认键位与图中的效果及新增动作一致，多一个修饰键都不会误触发', () => {
  const { api } = loadShortcuts();
  const expected = [
    [key('BracketLeft', { alt: true }), 'device.previous'],
    [key('BracketRight', { alt: true }), 'device.next'],
    [key('Tab', { ctrl: true }), 'device.next.tab'],
    [key('Tab', { ctrl: true, shift: true }), 'device.previous.tab'],
    [key('Digit9', { alt: true }), 'menu.open'],
    [key('Digit0', { alt: true }), 'services.open'],
    [key('Delete', { ctrl: true }), 'todo.cycle'],
    [key('Backslash', { shift: true }), 'todo.toggle'],
    [key('F5'), 'device.refresh'],
    [key('F5', { ctrl: true }), 'dsh.reload'],
    [key('F4', { ctrl: true, alt: true }), 'dsh.restart'],
  ];
  for (const [event, actionId] of expected) assert.equal(api.findShortcutAction(event), actionId);
  assert.equal(api.findShortcutAction(key('BracketLeft', { alt: true, shift: true })), null);
  assert.equal(api.findShortcutAction(key('BracketLeft', { alt: true, ctrl: true })), null);
  assert.equal(api.findShortcutAction(key('Tab')), null);
  assert.equal(api.findShortcutAction(key('F5', { alt: true })), null);
  assert.equal(api.shortcutDeviceDirection('device.previous.tab'), -1);
  assert.equal(api.shortcutDeviceDirection('device.next'), 1);
  assert.equal(api.shortcutDeviceDirection('menu.open'), null);
  const ids = api.SHORTCUT_ACTIONS.map((action) => action.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('改键后旧键位失效、新键位生效；清除即停用；删除覆盖即恢复默认', () => {
  const { api } = loadShortcuts();
  api.setShortcutOverrides({ 'device.previous': { code: 'Comma', ctrl: false, alt: true, shift: false, meta: false } }, { persist: false });
  assert.equal(api.findShortcutAction(key('BracketLeft', { alt: true })), null);
  assert.equal(api.findShortcutAction(key('Comma', { alt: true })), 'device.previous');
  api.setShortcutOverrides({ 'device.previous': null }, { persist: false });
  assert.equal(api.effectiveShortcutBinding('device.previous'), null);
  assert.equal(api.findShortcutAction(key('BracketLeft', { alt: true })), null);
  api.setShortcutOverrides({}, { persist: false });
  assert.equal(api.findShortcutAction(key('BracketLeft', { alt: true })), 'device.previous');
});

test('录入期间任何快捷键都不触发，结束后恢复', () => {
  const { api } = loadShortcuts();
  api.shortcutStore.recording = true;
  assert.equal(api.findShortcutAction(key('BracketLeft', { alt: true })), null);
  api.shortcutStore.recording = false;
  assert.equal(api.findShortcutAction(key('BracketLeft', { alt: true })), 'device.previous');
});

test('录入校验：必须带命令修饰键或功能键、不能与其他动作冲突、Esc 不可用', () => {
  const { api } = loadShortcuts();
  const check = (code, mods, actionId = 'menu.open') => api.validateShortcutBinding(api.shortcutBindingFromEvent(key(code, mods)), actionId);
  assert.equal(check('KeyA', {}).ok, false);
  assert.equal(check('KeyA', { shift: true }).ok, false, 'Shift+字母会吞掉大写输入');
  assert.equal(check('Escape', { ctrl: true }).ok, false);
  assert.equal(check('KeyK', { ctrl: true }).ok, true);
  assert.equal(check('F9', {}).ok, true);
  assert.equal(check('Backslash', { shift: true }, 'todo.toggle').ok, true, '默认的 Shift+\\ 本身仍可录入');
  const clash = check('BracketLeft', { alt: true });
  assert.equal(clash.ok, false);
  assert.match(clash.reason, /切换到左侧设备/);
  assert.equal(check('Digit9', { alt: true }).ok, true, '重新录入自己当前的键位不算冲突');
  assert.equal(api.shortcutBindingFromEvent(key('ShiftLeft', { shift: true })), null, '只按修饰键不算一次录入');
  assert.equal(api.validateShortcutBinding(null, 'menu.open').ok, false);
});

test('覆盖表清洗：未知动作与坏数据丢弃，null 保留', () => {
  const { api } = loadShortcuts();
  const cleaned = api.normalizeShortcutOverrides({
    'device.next': { code: 'Period', alt: 1, ctrl: 0 },
    'device.previous': null,
    'menu.open': 'oops',
    'todo.toggle': { code: '' },
    unknown: { code: 'KeyA' },
  });
  assert.deepEqual(Object.keys(cleaned).sort(), ['device.next', 'device.previous']);
  assert.deepEqual(cleaned['device.next'], { code: 'Period', ctrl: false, alt: true, shift: false, meta: false });
  assert.deepEqual(api.normalizeShortcutOverrides('bad'), {});
});

test('键位展示按平台区分写法', () => {
  const { api } = loadShortcuts();
  const altLeft = api.effectiveShortcutBinding('device.previous');
  assert.equal(api.describeShortcutBinding(altLeft, false), 'Alt+[');
  assert.equal(api.describeShortcutBinding(altLeft, true), '⌥[');
  assert.equal(api.describeShortcutBinding(api.effectiveShortcutBinding('device.previous.tab'), false), 'Ctrl+Shift+Tab');
  assert.equal(api.describeShortcutBinding(api.effectiveShortcutBinding('device.previous.tab'), true), '⌃⇧Tab');
  assert.equal(api.describeShortcutBinding(api.effectiveShortcutBinding('menu.open'), false), 'Alt+9');
  assert.equal(api.describeShortcutBinding(api.effectiveShortcutBinding('menu.open'), true), '⌥9');
  assert.equal(api.describeShortcutBinding(api.effectiveShortcutBinding('services.open'), false), 'Alt+0');
  assert.equal(api.describeShortcutBinding(api.effectiveShortcutBinding('services.open'), true), '⌥0');
  assert.equal(api.describeShortcutBinding(api.effectiveShortcutBinding('todo.toggle'), false), 'Shift+\\');
  assert.equal(api.describeShortcutBinding(api.effectiveShortcutBinding('todo.toggle'), true), '⇧\\');
  assert.equal(api.describeShortcutBinding(api.effectiveShortcutBinding('todo.cycle'), false), 'Ctrl+Delete');
  assert.equal(api.describeShortcutBinding(api.effectiveShortcutBinding('todo.cycle'), true), '⌃Delete');

  const { api: macApi } = loadShortcuts({ navigator: { platform: 'MacIntel', userAgent: 'Macintosh' } });
  assert.equal(macApi.findShortcutAction(key('Digit9', { ctrl: true })), 'menu.open');
  assert.equal(macApi.findShortcutAction(key('Delete', { meta: true })), 'todo.cycle');
  assert.equal(macApi.describeShortcutBinding(macApi.effectiveShortcutBinding('menu.open'), false), 'Ctrl+9');
  assert.equal(macApi.describeShortcutBinding(macApi.effectiveShortcutBinding('menu.open'), true), '⌃9');
  assert.equal(macApi.describeShortcutBinding(macApi.effectiveShortcutBinding('services.open'), false), 'Ctrl+0');
  assert.equal(macApi.describeShortcutBinding(macApi.effectiveShortcutBinding('services.open'), true), '⌃0');
  assert.equal(macApi.describeShortcutBinding(macApi.effectiveShortcutBinding('todo.cycle'), false), 'Win+Delete');
  assert.equal(macApi.describeShortcutBinding(macApi.effectiveShortcutBinding('todo.cycle'), true), '⌘Delete');
  assert.equal(api.describeShortcutBinding(api.effectiveShortcutBinding('device.refresh'), false), 'F5');
  assert.equal(api.describeShortcutBinding(api.effectiveShortcutBinding('device.refresh'), true), 'F5');
  assert.equal(api.describeShortcutBinding(api.effectiveShortcutBinding('dsh.reload'), false), 'Ctrl+F5');
  assert.equal(api.describeShortcutBinding(api.effectiveShortcutBinding('dsh.reload'), true), '⌃F5');
  assert.equal(api.describeShortcutBinding(api.effectiveShortcutBinding('dsh.restart'), false), 'Ctrl+Alt+F4');
  assert.equal(api.describeShortcutBinding(api.effectiveShortcutBinding('dsh.restart'), true), '⌃⌥F4');
  assert.equal(api.describeShortcutBinding(null, false), '未设置');
});

test('受控 iframe 桥：按生效键位转发，收到外层推送后立即换键，拒绝非父窗口的推送', () => {
  const listeners = new Map();
  const posted = [];
  const parent = { id: 'parent' };
  const { api } = loadShortcuts({
    name: 'dsh-au-controlled:remote',
    parent,
    top: { postMessage: (message) => { posted.push(message); } },
    // DOM 同一事件允许多个监听器；新输入保护监听不能覆盖真正的快捷键桥。
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => {
      const handlers = listeners.get(type);
      handlers?.delete(fn);
      if (!handlers?.size) listeners.delete(type);
    },
  });
  const dispose = api.installControlledFrameShortcutBridge();
  const press = (code, mods) => {
    let prevented = false;
    const event = { ...key(code, mods), preventDefault: () => { prevented = true; } };
    for (const listener of listeners.get('keydown') || []) listener(event);
    return prevented;
  };

  assert.equal(press('BracketRight', { alt: true }), true);
  assert.deepEqual(posted.pop(), { source: 'dsh-au', type: 'switch-device', direction: 1, preserveTopbar: true });
  assert.equal(press('Backslash', { shift: true }), true);
  assert.deepEqual(posted.pop(), { source: 'dsh-au', type: 'shortcut-action', action: 'todo.toggle' });
  assert.equal(press('Delete', { ctrl: true }), true);
  assert.deepEqual(posted.pop(), { source: 'dsh-au', type: 'shortcut-action', action: 'todo.cycle' });
  assert.equal(press('F5', {}), true);
  assert.deepEqual(posted.pop(), { source: 'dsh-au', type: 'shortcut-action', action: 'device.refresh' });
  assert.equal(press('F5', { ctrl: true }), true);
  assert.deepEqual(posted.pop(), { source: 'dsh-au', type: 'shortcut-action', action: 'dsh.reload' });
  assert.equal(press('F4', { ctrl: true, alt: true }), true);
  assert.deepEqual(posted.pop(), { source: 'dsh-au', type: 'shortcut-action', action: 'dsh.restart' });
  assert.equal(press('Digit9', { alt: true }), false, '菜单快捷键不转发，也不吞掉按键');
  assert.equal(posted.length, 0);

  const push = (source, overrides) => {
    const event = { source, data: { source: 'dsh-au', type: 'shortcut-config', overrides } };
    for (const listener of listeners.get('message') || []) listener(event);
  };
  push({ id: 'stranger' }, { 'device.next': { code: 'KeyZ', alt: true } });
  assert.equal(press('BracketRight', { alt: true }), true, '陌生窗口的推送被忽略');
  posted.length = 0;
  push(parent, { 'device.next': { code: 'KeyZ', alt: true } });
  assert.equal(press('BracketRight', { alt: true }), false);
  assert.equal(press('KeyZ', { alt: true }), true);
  assert.deepEqual(posted.pop(), { source: 'dsh-au', type: 'switch-device', direction: 1, preserveTopbar: true });
  dispose();
  assert.equal(listeners.has('keydown'), false);
});

test('设置页与外壳接入快捷键管理的关键源码', () => {
  const { code } = loadShortcuts();
  assert.match(code, /h\(ShortcutSettingsGroup\)/);
  assert.match(code, /SHORTCUT_STORAGE_KEY = 'dsh-au\.shortcuts'/);
  assert.match(code, /shortcutStore\.recording = true/);
  assert.match(code, /for \(const frame of frames\) postShortcutConfig\(frame\.contentWindow\)/);
  assert.match(code, /postShortcutConfig\(event\.currentTarget\?\.contentWindow\)/);
  assert.match(code, /event\.data\.type === SHORTCUT_ACTION_MESSAGE && event\.data\.action === 'todo\.toggle'/);
  assert.match(code, /event\.data\.type === SHORTCUT_ACTION_MESSAGE && event\.data\.action === 'device\.refresh'/);
  assert.match(code, /event\.data\.type === SHORTCUT_ACTION_MESSAGE && event\.data\.action === 'dsh\.reload'/);
  assert.match(code, /event\.data\.type === SHORTCUT_ACTION_MESSAGE && event\.data\.action === 'dsh\.restart'/);
  assert.match(code, /findShortcutAction\(event\) !== 'todo\.cycle'/);
  assert.match(code, /findShortcutAction\(event\) !== 'todo\.toggle'/);
});

test('设置页快捷键分区能渲染出每个动作一行，并显示当前键位', () => {
  const { api } = loadShortcuts();
  const tree = api.ShortcutSettingsGroup();
  const flat = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    flat.push(node);
    walk(node.children);
  };
  walk(tree);
  const rows = flat.filter((node) => node.props?.className === 'dsh-au-shortcut-row');
  assert.equal(rows.length, api.SHORTCUT_ACTIONS.length);
  const text = JSON.stringify(rows);
  assert.match(text, /展开 \/ 收起待办面板/);
  assert.match(text, /Shift\+\\\\|⇧\\\\/);
  assert.match(text, /刷新远程DSH/);
  assert.match(text, /F5/);
  assert.match(text, /重新加载 DSH 页面/);
  assert.match(text, /Ctrl\+F5|⌃F5/);
  assert.match(text, /退出并重启 DSH/);
  assert.match(text, /Ctrl\+Alt\+F4|⌃⌥F4/);
  assert.match(text, /恢复默认/);
});
