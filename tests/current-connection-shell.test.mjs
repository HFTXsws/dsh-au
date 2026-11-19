import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../scripts/build-client.js';

const CLIENT_RETURN = "    return { name: 'dsh-au', inject, apply, mobile: mobileClient.helpers, shortcuts: shortcutHelpers };";
const EXPORT_HOOK = '\n    globalThis.__AU_CURRENT_SHELL_TEST__ = { AuFleetShell, RemoteDshFrame, RemoteManagerModal, UnifiedWorkbenchModal, DeviceModal, RouteModal, AuthPromptCard };\n' + CLIENT_RETURN;
const TUNNEL_URL = 'http://127.0.0.1:7984/remote/win-tunnel/';
const LAN_URL = 'http://192.0.2.19:31990/';

function snapshot(lanReady = false) {
  return {
    ok: true,
    self: { deviceId: 'self', ips: ['10.0.0.2'], localUrl: 'http://127.0.0.1:7984', status: 'idle', lanShareEnabled: true },
    devices: [
      { id: 'self', name: 'self', routes: [{ id: 'lan-self', type: 'lan', url: 'http://10.0.0.2:31990/' }] },
      { id: 'win', name: 'win', routes: [
        { id: 'win-lan', type: 'lan', url: LAN_URL },
        { id: 'win-tunnel', type: 'tunnel', url: 'https://win.example/' },
      ] },
    ],
    remotes: [
      { id: 'win-lan', originUrl: LAN_URL, url: LAN_URL, online: lanReady, status: lanReady ? 'idle' : 'offline', transport: 'lan' },
      { id: 'win-tunnel', originUrl: 'https://win.example/', proxyUrl: TUNNEL_URL, online: true, status: 'idle', transport: 'tunnel' },
    ],
  };
}

/** 宿主 React/DOM 是边界；状态 setter 与 ref 保留身份，不替换任何选路或点击 handler。 */
function shellClient({ mobile = false, seedShell = true } = {}) {
  const storage = new Map();
  const localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) };
  const navigations = [];
  const win = {
    localStorage,
    innerWidth: mobile ? 390 : 1280,
    location: {
      href: mobile ? 'http://10.0.0.2:31990/' : 'http://127.0.0.1:7984/',
      assign: (url) => { navigations.push(url); },
    },
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (callback) => { callback(); },
  };
  const doc = {
    body: { appendChild(child) { return child; } },
    documentElement: {},
    querySelector: () => null,
    createElement() {
      return {
        style: {},
        appendChild(child) { return child; },
        submit() { navigations.push({ action: this.action, target: this.target }); },
        remove() {},
      };
    },
  };
  const states = [];
  const refs = [];
  let stateCursor = 0;
  let refCursor = 0;
  // 仅预置网络快照与宿主挂载/视口事实；设备选择与已打开路线由实际按钮修改。
  const seeds = new Map([
    [0, snapshot()], [10, true], [13, false], [14, mobile],
    [17, { topHost: {}, stageHost: {}, centerColumn: {} }],
    [19, { top: 0, left: 0, width: 900, height: 600 }],
  ]);
  // 直接渲染弹窗时不套用壳层专属 state；仍执行真实输入 handler 与状态更新。
  if (!seedShell) seeds.clear();
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children } };
    },
    useState(initialValue) {
      const index = stateCursor++;
      if (!(index in states)) states[index] = seeds.has(index) ? seeds.get(index) : (typeof initialValue === 'function' ? initialValue() : initialValue);
      return [states[index], (update) => { states[index] = typeof update === 'function' ? update(states[index]) : update; }];
    },
    useRef(initialValue) {
      const index = refCursor++;
      if (!(index in refs)) refs[index] = { current: initialValue };
      return refs[index];
    },
    useCallback: (callback) => callback,
    // 隔离宿主定时器、挂载和 HTTP 初始化；显式扫描通过真实 handler + fetch 边界更新快照。
    useEffect() {},
  };
  let response = snapshot();
  const fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(response) });
  const exports = {};
  win.__ModuleLoader__ = { load: (definition) => { win.definition = definition; } };
  const code = build();
  assert.ok(code.includes(CLIENT_RETURN), 'fresh build 缺少 factory 测试出口');
  new Function('window', 'document', 'localStorage', 'fetch', 'globalThis', code.replace(CLIENT_RETURN, EXPORT_HOOK))(win, doc, localStorage, fetch, exports);
  win.definition.factory((id) => {
    if (id === 'react') return React;
    if (id === 'react-dom') return { createPortal: (element) => element };
    throw new Error(`未预期的宿主依赖：${id}`);
  });
  const hooks = exports.__AU_CURRENT_SHELL_TEST__;
  return {
    managerType: hooks.RemoteManagerModal,
    frameType: hooks.RemoteDshFrame,
    workbenchType: hooks.UnifiedWorkbenchModal,
    deviceModalType: hooks.DeviceModal,
    navigations,
    nextSnapshot(value) { response = value; },
    render() {
      stateCursor = 0;
      refCursor = 0;
      return hooks.AuFleetShell({ selectPanel() {}, collapseSidebar() {}, expandSidebar() {}, usePanelInfo: () => null });
    },
    renderManager(props) { return hooks.RemoteManagerModal(props); },
    renderModal(name, props) {
      stateCursor = 0;
      refCursor = 0;
      return hooks[name](props);
    },
  };
}

function findAll(node, predicate, found = []) {
  if (Array.isArray(node)) { node.forEach((item) => findAll(item, predicate, found)); return found; }
  if (!node || typeof node !== 'object') return found;
  if (predicate(node)) found.push(node);
  findAll(node.props?.children, predicate, found);
  return found;
}

function textOf(node) {
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  return typeof node === 'object' ? textOf(node.props?.children) : String(node);
}

function button(tree, label) {
  const matches = findAll(tree, (node) => node.type === 'button' && node.props['aria-label'] === label);
  assert.equal(matches.length, 1, `应有唯一的 ${label} 按钮`);
  return matches[0];
}

function tools(tree) {
  const matches = findAll(tree, (node) => node.props.id === 'dsh-au-topbar-tools');
  assert.equal(matches.length, 1, '移动菜单应复用唯一的桌面操作组');
  return matches[0];
}

/** React 冒泡是宿主边界；先执行真实子按钮 handler，再将点击传给真实操作组 handler。 */
function clickTool(tree, label) {
  const target = button(tree, label);
  target.props.onClick();
  tools(tree).props.onClick({ target: { closest: () => target } });
}

function tab(tree, name) {
  const matches = findAll(tree, (node) => node.type === 'button' && node.props.className?.split(/\s+/).includes('dsh-au-tab')
    && findAll(node, (child) => child.props.className === 'dsh-au-tab-name').some((child) => textOf(child) === name));
  assert.equal(matches.length, 1, `应有唯一的 ${name} 设备按钮`);
  return matches[0];
}

function manager(client, tree) {
  const matches = findAll(tree, (node) => node.type === client.managerType);
  assert.equal(matches.length, 1, '管理弹窗必须由真实壳层传入 props');
  return matches[0];
}

function assertCurrentTunnel(client, tree) {
  const props = manager(client, tree).props;
  assert.equal(props.currentConnections.win, 'win-tunnel');
  const rendered = client.renderManager(props);
  const markedRows = findAll(rendered, (node) => node.props.className === 'dsh-au-remote-row dsh-au-remote-route'
    && textOf(node).includes('当前') && textOf(node).includes('https://win.example/'));
  assert.equal(markedRows.length, 1);
  assert.ok(textOf(markedRows[0]).includes('https://win.example/'));
}

// 移动端工具此前被 CSS 整组隐藏：展开入口必须能打开同一份桌面操作。
test('移动菜单可切换展开，复用所有工具且键盘顺序在工具之前', () => {
  const client = shellClient({ mobile: true });
  let tree = client.render();
  assert.equal(button(tree, '设备栏工具菜单').props['aria-expanded'], false);
  button(tree, '设备栏工具菜单').props.onClick();
  tree = client.render();
  assert.equal(button(tree, '设备栏工具菜单').props['aria-expanded'], true);
  const header = findAll(tree, (node) => node.type === 'header')[0];
  assert.ok(header.props.className.includes('mobile-tools-open'));
  assert.equal(button(tree, '设备栏工具菜单').props['aria-controls'], tools(tree).props.id);
  assert.deepEqual(findAll(tools(tree), (node) => node.type === 'button').map(textOf), ['插件', '服务', '脚本菜单', '远程', '新增']);
  const labels = findAll(header, (node) => node.type === 'button').map((node) => node.props['aria-label']);
  assert.ok(labels.indexOf('设备栏工具菜单') < labels.indexOf('打开统一菜单'), 'Tab 顺序应先经过菜单入口再进入工具');
  button(tree, '设备栏工具菜单').props.onClick();
  assert.equal(button(client.render(), '设备栏工具菜单').props['aria-expanded'], false);
});

test('移动菜单打开菜单、服务和插件的原工作台标签后自动关闭并归还焦点', () => {
  for (const [label, expectedTab] of [['打开统一菜单', 'fav'], ['管理后台服务', 'services'], ['打开插件管理', 'plugins']]) {
    const client = shellClient({ mobile: true });
    button(client.render(), '设备栏工具菜单').props.onClick();
    const tree = client.render();
    let focused = 0;
    button(tree, '设备栏工具菜单').props.ref.current = { focus: () => { focused += 1; } };
    clickTool(tree, label);
    const next = client.render();
    const modals = findAll(next, (node) => node.type === client.workbenchType);
    assert.equal(modals.length, 1);
    assert.equal(modals[0].props.initialTab, expectedTab);
    assert.equal(button(next, '设备栏工具菜单').props['aria-expanded'], false);
    assert.equal(focused, 1);
  }
});

test('移动菜单保持远程管理与新增入口可用', () => {
  for (const [label, modalKey] of [['查看和编辑远程配置', 'managerType'], ['添加手动设备', 'deviceModalType']]) {
    const client = shellClient({ mobile: true });
    button(client.render(), '设备栏工具菜单').props.onClick();
    clickTool(client.render(), label);
    const next = client.render();
    assert.equal(findAll(next, (node) => node.type === client[modalKey]).length, 1);
    assert.equal(button(next, '设备栏工具菜单').props['aria-expanded'], false);
  }
});

test('Escape 关闭移动菜单并归还焦点，收起后重新展开不会保留打开的菜单', () => {
  const client = shellClient({ mobile: true });
  button(client.render(), '设备栏工具菜单').props.onClick();
  let tree = client.render();
  let focused = 0;
  let prevented = 0;
  button(tree, '设备栏工具菜单').props.ref.current = { focus: () => { focused += 1; } };
  const header = findAll(tree, (node) => node.type === 'header')[0];
  header.props.onKeyDown({ key: 'Escape', preventDefault: () => { prevented += 1; } });
  assert.equal(button(client.render(), '设备栏工具菜单').props['aria-expanded'], false);
  assert.equal(prevented, 1);
  assert.equal(focused, 1);
  button(client.render(), '设备栏工具菜单').props.onClick();
  button(client.render(), '收起设备栏').props.onClick();
  tree = client.render();
  assert.equal(findAll(tree, (node) => node.type === 'header').length, 0);
  const capsules = findAll(tree, (node) => node.type === 'button' && node.props.className?.includes('dsh-au-floating-capsule'));
  assert.equal(capsules.length, 1);
  capsules[0].props.onClick();
  assert.equal(button(client.render(), '设备栏工具菜单').props['aria-expanded'], false);
});

test('桌面保留原有工具组，不使用移动展开布局', () => {
  const client = shellClient();
  const tree = client.render();
  const header = findAll(tree, (node) => node.type === 'header')[0];
  assert.equal(header.props.className, 'dsh-au-topbar');
  assert.deepEqual(findAll(tools(tree), (node) => node.type === 'button').map(textOf), ['插件', '服务', '脚本菜单', '远程', '新增']);
  clickTool(tree, '管理后台服务');
  assert.equal(findAll(client.render(), (node) => node.type === client.workbenchType)[0].props.initialTab, 'services');
});

// 2026-10-28 移动键盘回归：打开四类输入界面不抢焦点，用户手动输入仍走真实 handler。
test('弹窗与认证卡打开不自动聚焦，手动输入仍可编辑', () => {
  const scenarios = [
    ['AuthPromptCard', { dev: { id: 'remote', name: '远程设备', originUrl: 'https://remote.example/' }, onSave() {} }],
    ['DeviceModal', { onClose() {}, onSave() {} }],
    ['RouteModal', { devices: [{ id: 'remote', name: '远程设备' }], onClose() {}, onSave() {}, onDelete() {} }],
    ['UnifiedWorkbenchModal', { initialTab: 'fav', onClose() {} }],
  ];
  for (const [name, props] of scenarios) {
    const client = shellClient({ mobile: true, seedShell: false });
    const tree = client.renderModal(name, props);
    const inputs = findAll(tree, node => node.type === 'input');
    assert.ok(inputs.length > 0, `${name} 必须实际渲染输入，避免空树误通过`);
    for (const input of inputs) {
      assert.notEqual(input.props.autoFocus, true, `${name} 打开不能弹出移动键盘`);
      assert.ok(!input.props.disabled && !input.props.readOnly, `${name} 不能用禁用输入来规避焦点`);
      // 若以后添加焦点或触摸 handler，仍不允许取消用户主动选中输入框的事件。
      for (const event of ['onFocus', 'onMouseDown', 'onPointerDown', 'onTouchStart']) {
        input.props[event]?.({ target: { value: input.props.value }, preventDefault() { assert.fail(`${name} 不能拦截手动焦点`); } });
      }
    }
    inputs[0].props.onChange({ target: { value: '手动输入' } });
    assert.equal(findAll(client.renderModal(name, props), node => node.type === 'input')[0].props.value, '手动输入', `${name} 用户手动输入必须仍可更新`);
  }
});

// 2026-10-28 澄清回归：本机查看仅把原 LAN 行改名，当前标记必须在真实壳层中可见。
test('本机打开管理弹窗，原 LAN 行显示本机和当前且没有回环地址', () => {
  const client = shellClient();
  const props = manager(client, client.render()).props;
  assert.deepEqual(props.currentConnections, { self: 'lan-self', win: 'win-tunnel' });
  const rendered = client.renderManager(props);
  const selfRows = findAll(rendered, (node) => node.props.className === 'dsh-au-remote-row dsh-au-remote-route'
    && textOf(node).includes('http://10.0.0.2:31990/'));
  assert.equal(selfRows.length, 1);
  assert.ok(textOf(selfRows[0]).includes('本机'));
  assert.ok(textOf(selfRows[0]).includes('当前'));
  assert.ok(!textOf(selfRows[0]).includes('局域网'));
  assert.ok(!textOf(rendered).includes('127.0.0.1'));
});

test('浏览器顶栏点设备整页跳到穿透，不打开保活 iframe', () => {
  const client = shellClient();
  tab(client.render(), 'win').props.onClick();
  assert.deepEqual(client.navigations, [{ action: '/dsh-au/connect', target: '' }]);
  assert.equal(findAll(client.render(), (node) => node.type === client.frameType).length, 0);
});

// 移动端刷新目前继续使用 directFrameRoutes；标签必须服从该实际导航来源，而非另一个 ref。
test('移动端优选变更后刷新，当前标签仍属于实际 direct-frame 路线', async () => {
  const client = shellClient({ mobile: true });
  tab(client.render(), 'win').props.onClick();
  client.nextSnapshot(snapshot(true));
  await manager(client, client.render()).props.onDiscover();
  let tree = client.render();
  const frameBeforeMenu = findAll(tree, (node) => node.type === client.frameType)[0];
  button(tree, '设备栏工具菜单').props.onClick();
  tree = client.render();
  const frameWithMenu = findAll(tree, (node) => node.type === client.frameType)[0];
  assert.equal(frameWithMenu.props.frameKey, frameBeforeMenu.props.frameKey, '展开工具不能重建保活页面');
  assert.equal(frameWithMenu.props.targetUrl, frameBeforeMenu.props.targetUrl, '展开工具不能导航保活页面');
  let focused = 0;
  button(tree, '设备栏工具菜单').props.ref.current = { focus: () => { focused += 1; } };
  // 刷新不打开弹窗，关闭工具后仍需恢复入口焦点，不能留在隐藏的按钮上。
  clickTool(tree, '刷新当前远程设备 win');
  tree = client.render();
  assert.equal(button(tree, '设备栏工具菜单').props['aria-expanded'], false);
  assert.equal(focused, 1);
  assert.equal(findAll(tree, (node) => node.type === client.workbenchType).length, 0);
  assert.equal(findAll(tree, (node) => node.type === client.frameType)[0].props.targetUrl, 'about:blank', '移动端 frame 必须仍走同源认证导航，而非桌面保存 URL');
  assertCurrentTunnel(client, tree);
});
