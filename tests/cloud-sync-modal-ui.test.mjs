import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../scripts/build-client.js';

const RETURN_LINE = "    return { name: 'dsh-au', inject, apply, mobile: mobileClient.helpers, shortcuts: shortcutHelpers };";
const EXPORT_HOOK = "\n    globalThis.__AU_SETTINGS_TEST__ = { CloudSyncModal, CloudSyncFeatureGroup };\n" + RETURN_LINE;

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

/** 支持状态更新与重渲染的极简假 React，用于验证真实组件树与交互。 */
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

const hasClass = (node, cls) => String(node?.props?.className || '').split(/\s+/).includes(cls);

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
      selectedItems: [
        'ui-theme',
        'ui-chat',
        'ui-settings-account',
        'session-log-deepseek',
        'subagent-models',
        'permission-preset',
        'desktop-preferences',
        'llm-pi-ai',
        'agent-default-model',
      ],
      selectedPlugins: ['dsh-au', 'plugin-a'],
      syncPluginConfigs: ['dsh-au', 'plugin-a'],
      selectedPreferences: ['shortcuts'],
      lastSyncedAt: '2 分钟前自动同步',
    },
    profileOptions: [{ id: 'general', label: '通用' }],
    items: [
      { id: 'ui-theme', title: '外观：字号', inSync: true },
      { id: 'ui-chat', title: '聊天内容展示', inSync: true },
      { id: 'ui-settings-account', title: '账号设置界面', inSync: true },
      { id: 'session-log-deepseek', title: '会话日志上传设置', inSync: true },
      { id: 'subagent-models', title: '子智能体：模型选择', inSync: true },
      { id: 'permission-preset', title: '权限：新会话的默认权限模式', inSync: true },
      { id: 'desktop-preferences', title: '桌面设置', inSync: true },
      {
        id: 'llm-pi-ai',
        title: '模型提供商',
        category: 'models',
        summary: '2 家供应商 · 11 个模型',
        detailTags: [
          { label: 'gbu-full', value: 'GBU · 6 模型' },
          { label: 'antigravity', value: '反重力 · 5 模型' },
        ],
        inSync: true,
      },
      { id: 'agent-default-model', title: '默认模型', category: 'models', summary: 'gbu-full / gbu-gemini-4-neon', inSync: true },
      { id: 'claude-launcher', title: 'Claude 启动器与 4 档位映射', category: 'models', summary: '当前网关：GBU', inSync: true },
      { id: 'codex-catalog', title: 'Codex 模型目录', category: 'models', summary: '12 个网关模型', inSync: true },
      { id: 'dsh-acp-adapter', title: 'Cursor ACP 适配器', category: 'models', summary: '已启用', inSync: true },
    ],
    itemsByProfile: null,
    pluginItems: [
      { id: 'dsh-au', title: 'dsh-au', category: '自研插件', inSync: true },
      { id: 'plugin-a', title: 'dsh-mcp-bridge', category: '云插件', inSync: true },
      { id: 'plugin-b', title: 'dsh-local-ocr', category: '云插件', inSync: true },
    ],
    preferenceItems: [
      { id: 'shortcuts', title: '快捷键配置', category: '本机设置', inSync: true },
      { id: 'modelShortcuts', title: '快捷模型配置', category: '本机设置', inSync: true },
    ],
    machineId: 'Xad-Yoga',
    onQuickSave: () => {},
    onSave: () => {},
    onSaveAndSync: () => {},
    onPushToRepo: () => {},
    onResolveConflict: () => {},
    busy: false,
    message: '',
    ...overrides,
  };
}

test('CloudSyncModal：单页默认折叠态渲染 4 张卡片，DSH 官方配置无展开箭头，其余 3 卡片展开后可自由单选/多选并即时保存', () => {
  const savedCalls = [];
  const react = makeStatefulReact();
  const { CloudSyncModal } = loadSettingsComponents(react);
  const props = makeModalProps({
    onQuickSave: (payload) => savedCalls.push(payload),
  });

  // 初始折叠态：无 Tab、顶部显示绿色一致状态条
  let tree = renderComponent(CloudSyncModal, props, react);
  assert.equal(findAll(tree, (n) => n.props?.role === 'tab').length, 0, '单页布局不应再渲染 Tab');
  assert.equal(findAll(tree, (n) => hasClass(n, 'dsh-au-cs-status-ok')).length, 1, '全部一致时应显示绿色状态条');
  assert.equal(findAll(tree, (n) => hasClass(n, 'dsh-au-cs-diff-panel')).length, 0, '无差异时不应浮出冲突区');

  const cards = findAll(tree, (n) => hasClass(n, 'dsh-au-cs-group-card'));
  assert.equal(cards.length, 4, '应渲染 4 张大类卡片');

  // 1. DSH 官方配置：纯开关卡片，无展开箭头与明细
  const officialCard = cards[0];
  assert.match(textOf(officialCard), /DSH 官方配置/);
  assert.match(textOf(officialCard), /云端共享/);
  assert.equal(findAll(officialCard, (n) => hasClass(n, 'dsh-au-cs-caret')).length, 0, 'DSH 官方配置不得有展开箭头');
  assert.equal(findAll(officialCard, (n) => hasClass(n, 'dsh-au-cs-group-detail')).length, 0);

  // 2/3/4 卡片默认折叠
  assert.equal(findAll(tree, (n) => hasClass(n, 'dsh-au-cs-group-detail')).length, 0, '模型配置/其它云插件/快捷操作默认应折叠');

  // 点击展开「模型配置」，应展示 5 项精细行与供应商 tag
  const modelTop = findAll(cards[1], (n) => hasClass(n, 'dsh-au-cs-group-top'))[0];
  modelTop.props.onClick();
  tree = renderComponent(CloudSyncModal, props, react);
  let openCards = findAll(tree, (n) => hasClass(n, 'dsh-au-cs-group-card'));
  const modelRows = findAll(openCards[1], (n) => hasClass(n, 'dsh-au-cs-model-row'));
  assert.equal(modelRows.length, 5, '模型配置展开后应显示 5 项精细行');
  assert.match(textOf(modelRows[0]), /llm-pi-ai/);
  assert.match(textOf(modelRows[0]), /2 家供应商 · 11 个模型/);
  assert.match(textOf(modelRows[0]), /gbu-full/);

  // 单选勾选第 3 项 claude-launcher，触发 onQuickSave 且不关闭弹窗
  modelRows[2].props.onClick();
  assert.equal(savedCalls.length, 1);
  assert.ok(savedCalls[0].selectedItems.includes('claude-launcher'));

  // 展开「其它云插件」并自由勾选 plugin-b
  tree = renderComponent(CloudSyncModal, props, react);
  openCards = findAll(tree, (n) => hasClass(n, 'dsh-au-cs-group-card'));
  const pluginTop = findAll(openCards[2], (n) => hasClass(n, 'dsh-au-cs-group-top'))[0];
  pluginTop.props.onClick();
  tree = renderComponent(CloudSyncModal, props, react);
  openCards = findAll(tree, (n) => hasClass(n, 'dsh-au-cs-group-card'));
  const pluginChips = findAll(openCards[2], (n) => hasClass(n, 'dsh-au-cs-chip'));
  assert.equal(pluginChips.length, 2, '其它云插件不含 dsh-au，仅 2 个插件 chip');
  pluginChips[1].props.onClick();
  assert.equal(savedCalls.length, 2);
  assert.ok(savedCalls[1].selectedPlugins.includes('plugin-b'));

  // 底部只保留「完成」按钮，且包含固定共享说明
  assert.match(textOf(tree), /dsh-au 基础开关默认全机共享/);
  const footerBtns = findAll(tree, (n) => hasClass(n, 'dsh-au-cs-btn-close-footer'));
  assert.equal(footerBtns.length, 1);
  assert.equal(textOf(footerBtns[0]), '完成');
});

test('CloudSyncModal：冲突区在有差异时浮出，点击冲突行展开双栏对比且快捷键带中文名称备注', () => {
  const resolved = [];
  const react = makeStatefulReact();
  const { CloudSyncModal } = loadSettingsComponents(react);
  const props = makeModalProps({
    cloudSync: {
      enabled: true,
      profile: 'general',
      conflict: true,
      selectedItems: ['ui-theme'],
      selectedPlugins: ['dsh-au', 'plugin-a'],
      selectedPreferences: ['shortcuts', 'modelShortcuts'],
    },
    items: [
      {
        id: 'ui-theme',
        title: '外观：字号',
        inSync: false,
        fields: [{ key: 'ui-theme.fontSize', label: '字号', local: '15px', cloud: '14px' }],
      },
      { id: 'ui-chat', title: '聊天内容展示', inSync: false }, // 未勾选，不应出现在冲突区
    ],
    pluginItems: [
      { id: 'dsh-au', title: 'dsh-au', inSync: false, diffLines: [{ key: 'sidebarWorkbench', label: '侧边栏显示 DSH AU', local: true, cloud: false, changed: true }] },
      { id: 'plugin-a', title: 'dsh-mcp-bridge', inSync: false, diffLines: [{ key: 'timeoutMs', label: '超时时间', local: 15000, cloud: 30000, changed: true }] },
    ],
    preferenceItems: [
      {
        id: 'shortcuts',
        title: '快捷键配置',
        inSync: false,
        diffLines: [
          {
            key: 'cloudSync.open',
            local: { code: 'Digit2', alt: true, ctrl: false, shift: false, meta: false },
            cloud: { code: 'Digit2', alt: true, ctrl: false, shift: true, meta: false },
            changed: true,
          },
        ],
      },
      {
        id: 'modelShortcuts',
        title: '快捷模型配置',
        inSync: false,
        diffLines: [{ key: 'slot1', label: '槽位 1', local: 'gbu-gemini-4-neon', cloud: 'claude-sonnet-4-5', changed: true }],
      },
    ],
    onResolveConflict: (args) => resolved.push(args),
  });

  let tree = renderComponent(CloudSyncModal, props, react);
  const diffPanel = findAll(tree, (n) => hasClass(n, 'dsh-au-cs-diff-panel'));
  assert.equal(diffPanel.length, 1, '有差异时应浮出琥珀色冲突区');
  assert.match(textOf(diffPanel[0]), /检测到 5 项冲突 \/ 不一致/);
  assert.doesNotMatch(textOf(diffPanel[0]), /聊天内容展示/, '未勾选的配置项不应出现在冲突区');

  const diffItems = findAll(diffPanel[0], (n) => hasClass(n, 'dsh-au-cs-diff-item'));
  assert.equal(diffItems.length, 5, '快捷键、快捷模型与 dsh-au 基础开关各自独立成行');
  // 冲突行展开前不显示 compare 网格
  assert.equal(findAll(diffPanel[0], (n) => hasClass(n, 'dsh-au-cs-compare-grid')).length, 0);

  // 点击「快捷键配置」冲突行展开双栏对比
  const shortcutDiffRow = diffItems.find(item => textOf(item).includes('快捷键配置'));
  assert.ok(shortcutDiffRow, '应包含独立的快捷键配置冲突行');
  const rowHead = findAll(shortcutDiffRow, (n) => hasClass(n, 'dsh-au-cs-diff-row-head'))[0];
  rowHead.props.onClick();

  tree = renderComponent(CloudSyncModal, props, react);
  const compareGrids = findAll(tree, (n) => hasClass(n, 'dsh-au-cs-compare-grid'));
  assert.equal(compareGrids.length, 1, '点击冲突行应展开双栏对比');
  const compareText = textOf(compareGrids[0]);
  assert.match(compareText, /打开云端同步设置（cloudSync\.open）/);
  assert.match(compareText, /Alt\+2/);
  assert.match(compareText, /Alt\+Shift\+2/);

  // 点击单项「用本机」按钮应触发 onResolveConflict
  const miniBtns = findAll(shortcutDiffRow, (n) => hasClass(n, 'dsh-au-cs-mini-btn'));
  assert.equal(miniBtns.length, 2);
  miniBtns[0].props.onClick({ stopPropagation() {} });
  assert.deepEqual(resolved[0], {
    kind: 'preference',
    id: 'shortcuts',
    direction: 'push',
    profile: 'general',
  });
});

test('CloudSyncModal：「快捷键配置」与「快捷模型配置」独立展示且默认不勾选', () => {
  const react = makeStatefulReact();
  const { CloudSyncModal } = loadSettingsComponents(react);
  const props = makeModalProps({
    cloudSync: {
      enabled: true,
      profile: 'general',
      selectedItems: ['ui-theme'],
      selectedPlugins: ['dsh-au'],
    },
  });

  let tree = renderComponent(CloudSyncModal, props, react);
  let cards = findAll(tree, (n) => hasClass(n, 'dsh-au-cs-group-card'));
  const shortcutCard = cards[3];
  assert.match(textOf(shortcutCard), /快捷操作/);
  assert.match(textOf(shortcutCard), /仅单机备份/);

  // 点击展开「快捷操作」
  const shortcutTop = findAll(shortcutCard, (n) => hasClass(n, 'dsh-au-cs-group-top'))[0];
  shortcutTop.props.onClick();
  tree = renderComponent(CloudSyncModal, props, react);
  cards = findAll(tree, (n) => hasClass(n, 'dsh-au-cs-group-card'));
  const chips = findAll(cards[3], (n) => hasClass(n, 'dsh-au-cs-chip'));
  assert.equal(chips.length, 2);
  assert.match(textOf(chips[0]), /快捷键配置/);
  assert.match(textOf(chips[0]), /shortcuts/);
  assert.match(textOf(chips[1]), /快捷模型配置/);
  assert.match(textOf(chips[1]), /modelShortcuts/);
  assert.equal(chips[0].props['aria-checked'], false);
  assert.equal(chips[1].props['aria-checked'], false);
});

test('CloudSyncFeatureGroup：设置页外层「待同步」计数仅统计已勾选项与固定同步的 dsh-au', () => {
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
      { id: 'shortcuts', title: '快捷键配置', inSync: true },
      { id: 'modelShortcuts', title: '快捷模型配置', inSync: false }, // 未勾选
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
  // 仅计入：ui-theme(1) + dsh-au(1) + plugin-a(1) = 3 项待同步（不含 ui-chat、plugin-b、modelShortcuts）
  assert.equal(textOf(outerBadges[0]), '3 项待同步');
});

test('CloudSyncModal：onResolveConflict 返回 ok:false 时绝不弹出成功提示，而是显示错误提示', async () => {
  const react = makeStatefulReact();
  const { CloudSyncModal } = loadSettingsComponents(react);
  const props = makeModalProps({
    cloudSync: {
      enabled: true,
      profile: 'general',
      conflict: true,
      selectedItems: ['ui-theme'],
      selectedPlugins: ['dsh-au'],
      selectedPreferences: [],
    },
    items: [
      {
        id: 'ui-theme',
        title: '外观：字号',
        inSync: false,
        fields: [{ key: 'ui-theme.fontSize', label: '字号', local: '15px', cloud: '14px' }],
      },
    ],
    pluginItems: [{ id: 'dsh-au', title: 'dsh-au', inSync: true }],
    onResolveConflict: async () => ({ ok: false, error: '方案清单未声明 restoreScript' }),
  });

  let tree = renderComponent(CloudSyncModal, props, react);
  const diffItem = findAll(tree, (n) => hasClass(n, 'dsh-au-cs-diff-item'))[0];
  const miniBtns = findAll(diffItem, (n) => hasClass(n, 'dsh-au-cs-mini-btn'));
  assert.equal(miniBtns.length, 2);

  await miniBtns[1].props.onClick({ stopPropagation() {} });
  tree = renderComponent(CloudSyncModal, props, react);

  const toastHint = findAll(tree, (n) => hasClass(n, 'dsh-au-cs-toast-hint'))[0];
  assert.ok(hasClass(toastHint, 'show'));
  assert.ok(hasClass(toastHint, 'is-error'), '失败提示必须带 is-error 样式');
  assert.equal(textOf(toastHint), '方案清单未声明 restoreScript');
  assert.doesNotMatch(textOf(toastHint), /✓ 已将.*用云端覆盖本机/);

  // 兜底 message 无 toast 时也应识别「未声明」为错误态
  const fallbackTree = renderComponent(
    CloudSyncModal,
    makeModalProps({ message: '方案清单未声明 restoreScript' }),
    makeStatefulReact(),
  );
  const fallbackToast = findAll(fallbackTree, (n) => hasClass(n, 'dsh-au-cs-toast-hint'))[0];
  assert.ok(hasClass(fallbackToast, 'is-error'));
});

test('CloudSyncModal：onResolveConflict 返回 skipped:true 时不弹出绿色覆盖成功提示', async () => {
  const react = makeStatefulReact();
  const { CloudSyncModal } = loadSettingsComponents(react);
  const props = makeModalProps({
    cloudSync: {
      enabled: true,
      profile: 'general',
      conflict: true,
      selectedItems: ['ui-theme'],
      selectedPlugins: ['dsh-au'],
      selectedPreferences: [],
    },
    items: [
      {
        id: 'ui-theme',
        title: '外观：字号',
        inSync: false,
        fields: [{ key: 'ui-theme.fontSize', label: '字号', local: '15px', cloud: '14px' }],
      },
    ],
    pluginItems: [{ id: 'dsh-au', title: 'dsh-au', inSync: true }],
    onResolveConflict: async () => ({ ok: true, skipped: true, message: '未勾选任何同步项' }),
  });

  let tree = renderComponent(CloudSyncModal, props, react);
  const diffItem = findAll(tree, (n) => hasClass(n, 'dsh-au-cs-diff-item'))[0];
  const miniBtns = findAll(diffItem, (n) => hasClass(n, 'dsh-au-cs-mini-btn'));

  await miniBtns[1].props.onClick({ stopPropagation() {} });
  tree = renderComponent(CloudSyncModal, props, react);

  const toastHint = findAll(tree, (n) => hasClass(n, 'dsh-au-cs-toast-hint'))[0];
  assert.ok(hasClass(toastHint, 'show'));
  assert.ok(hasClass(toastHint, 'is-error'), '已跳过提示应以错误/警告态展示，而非绿色成功');
  assert.equal(textOf(toastHint), '未勾选任何同步项');
  assert.doesNotMatch(textOf(toastHint), /✓ 已将/);
});

test('CloudSyncModal：onResolveConflict 异步 resolve ok:true 后才弹出成功提示', async () => {
  const react = makeStatefulReact();
  const { CloudSyncModal } = loadSettingsComponents(react);
  let resolveConflict;
  const props = makeModalProps({
    cloudSync: {
      enabled: true,
      profile: 'general',
      conflict: true,
      selectedItems: ['ui-theme'],
      selectedPlugins: ['dsh-au'],
      selectedPreferences: [],
    },
    items: [
      {
        id: 'ui-theme',
        title: '外观：字号',
        inSync: false,
        fields: [{ key: 'ui-theme.fontSize', label: '字号', local: '15px', cloud: '14px' }],
      },
    ],
    pluginItems: [{ id: 'dsh-au', title: 'dsh-au', inSync: true }],
    onResolveConflict: () => new Promise((resolve) => { resolveConflict = resolve; }),
  });

  let tree = renderComponent(CloudSyncModal, props, react);
  const diffItem = findAll(tree, (n) => hasClass(n, 'dsh-au-cs-diff-item'))[0];
  const miniBtns = findAll(diffItem, (n) => hasClass(n, 'dsh-au-cs-mini-btn'));

  const pending = miniBtns[1].props.onClick({ stopPropagation() {} });

  // Promise 尚未 resolve 时，不得提前弹出成功提示
  tree = renderComponent(CloudSyncModal, props, react);
  let toastHint = findAll(tree, (n) => hasClass(n, 'dsh-au-cs-toast-hint'))[0];
  assert.equal(hasClass(toastHint, 'show'), false, '异步未完成前不应提前展示提示');
  assert.doesNotMatch(textOf(toastHint), /✓ 已将/);

  resolveConflict({ ok: true });
  await pending;

  tree = renderComponent(CloudSyncModal, props, react);
  toastHint = findAll(tree, (n) => hasClass(n, 'dsh-au-cs-toast-hint'))[0];
  assert.ok(hasClass(toastHint, 'show'));
  assert.equal(hasClass(toastHint, 'is-error'), false);
  assert.equal(textOf(toastHint), '✓ 已将「外观：字号」用云端覆盖本机');
});
