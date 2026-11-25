import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../scripts/build-client.js';

const RETURN_LINE = "    return { name: 'dsh-au', inject, apply, mobile: mobileClient.helpers, shortcuts: shortcutHelpers };";
const EXPORT_HOOK = "\n    globalThis.__AU_SETTINGS_TEST__ = { CloudSyncModal, CloudSyncFeatureGroup, renderOfficialRow };\n" + RETURN_LINE;

function makeWindow() {
  const store = new Map();
  return {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); },
      removeItem: (key) => { store.delete(key); },
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    location: { href: 'http://localhost/' },
  };
}

/** 支持状态更新与重渲染的极简假 React，用于验证真实组件树与 Tab 切换交互。 */
function makeStatefulReact(initialStates = []) {
  const states = [...initialStates];
  let cursor = 0;
  const Fragment = Symbol('Fragment');
  const createElement = (type, props, ...children) => {
    const merged = { ...(props || {}) };
    if (children.length === 1) merged.children = children[0];
    else if (children.length > 1) merged.children = children;
    return { type, props: merged };
  };
  return {
    Fragment,
    createElement,
    useState: (init) => {
      const idx = cursor;
      cursor += 1;
      if (!(idx in states)) {
        states[idx] = typeof init === 'function' ? init() : init;
      }
      const setState = (next) => {
        states[idx] = typeof next === 'function' ? next(states[idx]) : next;
      };
      return [states[idx], setState];
    },
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    resetCursor: () => { cursor = 0; },
    states,
  };
}

function loadSettingsComponents(react) {
  const code = build();
  assert.ok(code.includes(RETURN_LINE), 'bundle 缺少 return 语句，无法注入测试出口');
  const patched = code.replace(RETURN_LINE, EXPORT_HOOK);
  const win = makeWindow();
  globalThis.window = win;
  new Function('window', patched)({ __ModuleLoader__: { load: (def) => { win.__def = def; } } });
  win.__def.factory((id) => {
    if (id === 'react') return react;
    if (id === 'react-dom') return { createPortal: (node) => node };
    throw new Error(`未预期的 require：${id}`);
  });
  return globalThis.__AU_SETTINGS_TEST__;
}

/** 递归收集所有匹配谓词的虚拟节点。 */
function findAll(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  const children = node.props?.children;
  if (children !== undefined) findAll(children, predicate, out);
  return out;
}

/** 提取节点及其子树的纯文本。 */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && node.props) return textOf(node.props.children);
  return '';
}

function renderComponent(Component, props, react) {
  const expand = (node) => {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(expand);
    if (typeof node.type === 'function') {
      return expand(node.type(node.props || {}));
    }
    if (node.props && node.props.children !== undefined) {
      return {
        ...node,
        props: {
          ...node.props,
          children: expand(node.props.children),
        },
      };
    }
    return node;
  };
  react.resetCursor();
  return expand(Component(props));
}

function makeModalProps(overrides = {}) {
  return {
    isOpen: true,
    onClose: () => {},
    cloudSync: {
      enabled: true,
      profile: 'general',
      selectedItems: ['ui-theme'],
      selectedPlugins: ['dsh-au', 'plugin-a'],
      syncPluginConfigs: ['dsh-au', 'plugin-a'],
      selectedPreferences: ['shortcuts'],
    },
    profileOptions: [{ id: 'general', label: '通用' }],
    items: [
      { id: 'ui-theme', title: '界面主题', inSync: false, diffDetails: ['主题'] },
      { id: 'ui-chat', title: '对话样式', inSync: false, diffDetails: ['字体'] },
    ],
    itemsByProfile: null,
    pluginItems: [
      { id: 'dsh-au', title: 'dsh-au', category: '自研插件', inSync: false, diffLabel: '有差异' },
      { id: 'plugin-a', title: '已勾选插件A', category: '云插件', inSync: false, diffLabel: '有差异' },
      { id: 'plugin-b', title: '未勾选插件B', category: '云插件', inSync: false, diffLabel: '有差异' },
    ],
    preferenceItems: [
      { id: 'shortcuts', title: '已勾选快捷键', category: '本机设置', inSync: false, diffLabel: '本地与云不一致' },
      { id: 'model-shortcuts', title: '未勾选模型槽位', category: '本机设置', inSync: false, diffLabel: '本地与云不一致' },
    ],
    machineId: 'test-machine',
    onSave: () => {},
    onSaveAndSync: () => {},
    onPushToRepo: () => {},
    onSyncSinglePlugin: () => {},
    busy: false,
    message: '',
    ...overrides,
  };
}

test('CloudSyncModal：切换到「dsh-au 设置」页签时仅单高亮，不再同时高亮「DSH 官方设置」', () => {
  const react = makeStatefulReact();
  const { CloudSyncModal } = loadSettingsComponents(react);
  const props = makeModalProps();

  // 初始渲染：默认在「DSH 官方设置」页签
  let tree = renderComponent(CloudSyncModal, props, react);
  let tabs = findAll(tree, (n) => n.type === 'button' && n.props?.role === 'tab');
  assert.equal(tabs.length, 3);
  assert.equal(tabs[0].props['aria-selected'], true);
  assert.match(tabs[0].props.className, /\bis-active\b/);
  assert.equal(tabs[1].props['aria-selected'], false);
  assert.doesNotMatch(tabs[1].props.className, /\bis-active\b/);
  assert.equal(tabs[2].props['aria-selected'], false);

  // 点击切换到「dsh-au 设置」页签
  tabs[1].props.onClick();
  tree = renderComponent(CloudSyncModal, props, react);
  tabs = findAll(tree, (n) => n.type === 'button' && n.props?.role === 'tab');
  assert.equal(tabs[0].props['aria-selected'], false, '切到 dsh-au 后官方设置 aria-selected 必须为 false');
  assert.doesNotMatch(tabs[0].props.className, /\bis-active\b/, '切到 dsh-au 后官方设置不得保留 is-active');
  assert.equal(tabs[1].props['aria-selected'], true);
  assert.match(tabs[1].props.className, /\bis-active\b/);
  assert.equal(tabs[2].props['aria-selected'], false);
  assert.doesNotMatch(tabs[2].props.className, /\bis-active\b/);
});

test('CloudSyncModal：未勾选配置项隐藏不一致角标与警示样式，且不计入页签角标和顶部提示条', () => {
  const react = makeStatefulReact();
  const { CloudSyncModal } = loadSettingsComponents(react);
  const props = makeModalProps();

  // 1. 官方设置页签：仅 1 项已勾选不一致
  let tree = renderComponent(CloudSyncModal, props, react);
  let tabs = findAll(tree, (n) => n.type === 'button' && n.props?.role === 'tab');
  assert.match(textOf(tabs[0]), /1 项不一致/);
  assert.match(textOf(tabs[1]), /2 项不一致/); // 1 个已勾选本机设置 + 1 个固定同步 dsh-au
  assert.match(textOf(tabs[2]), /1 项不一致/); // 1 个已勾选其它云插件

  const banner = findAll(tree, (n) => String(n.props?.className || '').includes('dsh-au-cloud-sync-diff-banner'));
  assert.equal(banner.length, 1);
  const bannerText = textOf(banner[0]);
  assert.match(bannerText, /4 项不一致/);
  assert.doesNotMatch(bannerText, /对话样式|未勾选插件B|未勾选模型槽位/);

  const officialRows = findAll(tree, (n) => String(n.props?.className || '').includes('dsh-au-cloud-sync-row-item'));
  assert.equal(officialRows.length, 2);
  // 已勾选行显示差异角标
  assert.equal(findAll(officialRows[0], (n) => String(n.props?.className || '').includes('dsh-au-cloud-sync-row-status is-diff')).length, 1);
  // 未勾选行不显示差异角标也不带 is-diff
  assert.equal(findAll(officialRows[1], (n) => String(n.props?.className || '').includes('dsh-au-cloud-sync-row-status')).length, 0);
  assert.equal(findAll(officialRows[1], (n) => String(n.props?.className || '').includes('is-diff')).length, 0);

  const hasClass = (node, cls) => String(node.props?.className || '').split(/\s+/).includes(cls);

  // 2. 切到「dsh-au 设置」页签：未勾选的本机设置项不显示角标和 is-diff
  tabs[1].props.onClick();
  tree = renderComponent(CloudSyncModal, props, react);
  const prefItems = findAll(tree, (n) => hasClass(n, 'dsh-au-cloud-sync-item'));
  // 第 0 项为固定同步的 dsh-au 版本与开关，第 1 项为已勾选 shortcuts，第 2 项为未勾选 model-shortcuts
  assert.equal(prefItems.length, 3);
  assert.match(prefItems[0].props.className, /\bis-diff\b/);
  assert.match(prefItems[1].props.className, /\bis-diff\b/);
  assert.equal(findAll(prefItems[1], (n) => hasClass(n, 'dsh-au-cloud-sync-diff-badge')).length, 1);
  assert.doesNotMatch(prefItems[2].props.className, /\bis-diff\b/);
  assert.equal(findAll(prefItems[2], (n) => hasClass(n, 'dsh-au-cloud-sync-diff-badge')).length, 0);

  // 3. 切到「其它云插件」页签：未勾选插件不显示差异角标和单插件同步按钮
  tabs = findAll(tree, (n) => n.type === 'button' && n.props?.role === 'tab');
  tabs[2].props.onClick();
  tree = renderComponent(CloudSyncModal, props, react);
  const pluginRows = findAll(tree, (n) => hasClass(n, 'dsh-au-cloud-sync-item'));
  assert.equal(pluginRows.length, 2);
  assert.equal(findAll(pluginRows[0], (n) => hasClass(n, 'dsh-au-cloud-sync-diff-badge') && hasClass(n, 'is-diff')).length, 1);
  assert.equal(findAll(pluginRows[0], (n) => hasClass(n, 'dsh-au-cloud-sync-mini-btn')).length, 2);
  assert.equal(findAll(pluginRows[1], (n) => hasClass(n, 'dsh-au-cloud-sync-diff-badge')).length, 0);
  assert.equal(findAll(pluginRows[1], (n) => hasClass(n, 'dsh-au-cloud-sync-mini-btn')).length, 0);
});

test('CloudSyncFeatureGroup：设置页外层「待同步」计数仅统计已勾选项与固定同步的 dsh-au', () => {
  // 预置 CloudSyncFeatureGroup 内部的 useState 槽位（顺序与组件内声明一致）
  const initialStates = [
    [{ id: 'general', label: '通用' }], // profileOptions
    {
      enabled: true,
      profile: 'general',
      selectedItems: ['ui-theme'],
      selectedPlugins: ['plugin-a'], // 故意不含 dsh-au，验证固定同步项仍会被计入
      syncPluginConfigs: ['plugin-a'],
      selectedPreferences: ['shortcuts'],
      inSync: false,
      conflict: false,
    }, // cloudSync
    [
      { id: 'ui-theme', title: '界面主题', inSync: false },
      { id: 'ui-chat', title: '对话样式', inSync: false }, // 未勾选
    ], // items
    null, // itemsByProfile
    [
      { id: 'dsh-au', title: 'dsh-au', inSync: false }, // 固定同步
      { id: 'plugin-a', title: '插件A', inSync: false }, // 已勾选
      { id: 'plugin-b', title: '插件B', inSync: false }, // 未勾选
    ], // pluginItems
    [
      { id: 'shortcuts', title: '快捷键', inSync: true },
      { id: 'model-shortcuts', title: '模型槽位', inSync: false }, // 未勾选
    ], // preferenceItems
    'test-machine', // machineId
    '', // syncRepoRoot
    false, // repoPathRestart
    true, // loaded
    false, // busy
    '', // message
    false, // modalOpen
    false, // firstSyncConfirmOpen
  ];
  const react = makeStatefulReact(initialStates);
  const { CloudSyncFeatureGroup } = loadSettingsComponents(react);
  const tree = renderComponent(CloudSyncFeatureGroup, {}, react);
  const outerBadges = findAll(tree, (n) => String(n.props?.className || '').includes('dsh-au-cloud-sync-outer-diff'));
  assert.equal(outerBadges.length, 1);
  // 仅计入：ui-theme(1) + dsh-au(1) + plugin-a(1) = 3 项待同步（不含 ui-chat、plugin-b、model-shortcuts）
  assert.equal(textOf(outerBadges[0]), '3 项待同步');
});
