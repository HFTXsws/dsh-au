import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { outFile } from '../scripts/build-client.js';

// 把工作台渲染成可比较的元素树，锁住「拆分前后 DOM 结构一致」。
// 只做测试用注入：在 factory return 前挂一个测试出口，其余代码原样执行。
const EXPORT_HOOK = "\n    globalThis.__AU_CLIENT_TEST__ = { UnifiedWorkbenchModal, getChildInputGuide, parseQuotaSections };\n"
  + "    return { name: 'dsh-au', inject, apply, mobile: mobileClient.helpers, shortcuts: shortcutHelpers };";

const snapshotDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/client-render');

function makeWindow() {
  const store = new Map();
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
  };
  return { localStorage, addEventListener() {}, removeEventListener() {}, location: { href: 'http://localhost/' } };
}

/** 假 React：useState 按调用顺序取 fixture，渲染树用纯对象表示。 */
function makeReact(stateValues) {
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
    useState: () => {
      const value = stateValues[cursor];
      cursor += 1;
      return [value, () => {}];
    },
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    reset: () => { cursor = 0; },
  };
}

function flatten(nodes, out) {
  for (const node of Array.isArray(nodes) ? nodes : [nodes]) {
    if (Array.isArray(node)) flatten(node, out);
    else out.push(node);
  }
  return out;
}

function serialize(node) {
  if (node === null || node === undefined || node === false || node === true) return null;
  if (Array.isArray(node)) return flatten(node, []).map(serialize).filter((item) => item !== null);
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node === 'function') return '[fn]';
  const { type, props } = node;
  const name = typeof type === 'string'
    ? type
    : (typeof type === 'symbol' ? '#fragment' : (type?.name || 'anonymous'));
  const out = {};
  for (const key of Object.keys(props || {}).sort()) {
    if (key === 'children') continue;
    const value = props[key];
    out[key] = typeof value === 'function' ? '[fn]' : value;
  }
  const children = props?.children;
  return { t: name, p: out, c: children === undefined ? null : serialize(children) };
}

function loadWorkbench() {
  const code = readFileSync(outFile, 'utf8');
  assert.ok(code.includes("    return { name: 'dsh-au', inject, apply, mobile: mobileClient.helpers, shortcuts: shortcutHelpers };"), 'bundle 缺少 return 语句，无法注入测试出口');
  const patched = code.replace(
    "    return { name: 'dsh-au', inject, apply, mobile: mobileClient.helpers, shortcuts: shortcutHelpers };",
    EXPORT_HOOK,
  );
  const win = makeWindow();
  new Function('window', patched)({ __ModuleLoader__: { load: (def) => { win.__def = def; } } });
  return win.__def;
}

function makeWb() {
  return {
    ok: true,
    platformOs: 'darwin',
    selfHostname: 'TestBook',
    menuFavorites: ['11', '45', '99'],
    menuSpec: {
      configured: true,
      groups: [
        {
          id: 'basic',
          title: '基础',
          items: [
            { code: '11', label: '同步 Skill', description: '把仓库 Skill 同步到各端', runner: 'node', script: 'sync-skill' },
            {
              code: '21',
              label: '导入 IDE 配置',
              description: '从 IDE 导入',
              runner: 'node',
              script: 'ide',
              args: ['--force'],
              params: [
                {
                  name: 'action',
                  label: '动作',
                  type: 'select',
                  options: [
                    { value: 'import', label: '上传' },
                    { value: 'export', label: '同步' },
                  ],
                  defaultValue: 'import',
                  winFlag: '-Action',
                  posixFlag: '--action',
                },
              ],
            },
            { code: '31', label: '查询额度', description: '额度查询', runner: 'python', script: 'quota.py', readonly: true },
            { code: '41', label: '需要确认', description: '带确认', runner: 'node', script: 'confirm', confirm: true },
          ],
        },
        {
          id: 'cursor',
          title: 'Cursor',
          items: [
            {
              code: '45',
              label: 'Cursor 规则',
              description: '同步规则',
              runner: 'node',
              script: 'rules',
              params: [
                {
                  name: 'skills',
                  label: 'Skill',
                  type: 'multiselect',
                  options: [
                    { value: 'skill-a', label: 'skill-a' },
                    { value: 'skill-b', label: 'skill-b' },
                  ],
                  winFlag: '-Names',
                  posixFlag: '',
                },
              ],
            },
            {
              code: '71',
              label: '重装插件',
              description: '插件重装',
              runner: 'node',
              script: 'plugin',
              params: [
                {
                  name: 'dshProfile',
                  label: 'DSH 方案',
                  type: 'select',
                  options: [
                    { value: 'kiro', label: 'profile kiro' }, // 展示名去个人文案，value 仍用 kiro 以免改断 profile 断言
                    { value: 'local', label: 'profile local', platform: 'darwin' },
                  ],
                  defaultValue: 'kiro',
                  winFlag: '--profile',
                  posixFlag: '--profile',
                },
              ],
            },
          ],
        },
      ],
    },
    services: [
      {
        id: 'dsh_bridge', name: 'DSH 桥', guard: '本机桥接', running: true, port: 55656,
        control: 'service', instances: [{ name: 'bridge-1' }],
        // 开关来自 state.json，经 applyLocalBinding 挂到 localState 上。
        localState: { enabled: true, autoStartOnBoot: false, autoStartOnDsh: true, cloud: true },
      },
      {
        id: 'antigravity', name: 'Antigravity', guard: '代理', running: false, port: 8080,
        control: 'start-only',
        localState: { enabled: true, autoStartOnBoot: true, autoStartOnDsh: false, cloud: true },
      },
      {
        id: 'win_svc', name: 'Windows 服务', guard: '仅 Windows', running: false, kind: 'windows-service',
      },
    ],
    dshPlugins: [
      { id: 'dsh-acp-adapter', package: 'dsh-acp-adapter', name: 'Cursor ACP', version: '1.0.0', source: 'npm' },
      { id: 'dsh-au', package: 'dsh-au', name: 'DSH AU', version: '0.1.0', source: 'local' },
    ],
    localDshPlugins: [
      { id: 'dsh-au', package: 'dsh-au', name: 'DSH AU', version: '0.1.0', description: '多机远程与局域网自发现工作区插件', enabled: true },
      { id: 'dsh-au-todo', package: 'dsh-au-todo', name: 'DSH AU Todo', version: '0.1.0', description: '待办面板插件', enabled: false },
    ],
    currentMachineDshPluginIds: ['dsh-au'],
    machineDshPluginProfiles: { TestBook: ['dsh-au'] },
    cloudServiceIds: ['dsh_bridge', 'antigravity'],
    currentMachineProfile: {
      enabled: ['dsh_bridge', 'antigravity'],
      autoStartOnBoot: ['antigravity'],
      autoStartOnDsh: ['dsh_bridge'],
    },
    machineServiceProfiles: { TestBook: { enabled: ['dsh_bridge'] } },
    // 三层结构：云服务定义在云清单，本机事实在云备份，当前用哪份由本机指针决定。
    localBinding: {
      machineId: 'example-macbook-pro',
      displayName: '小贞林的 MacBook Pro',
      file: 'dsh-au/sync/machines/example-macbook-pro.json',
      exists: true,
      // 本机服务列表只认这里：与旧快照里「已接入」的两项保持一致。
      serviceIds: ['dsh_bridge', 'antigravity'],
      plugins: ['@weibaohui/dsh-continue', 'dsh-market'],
      currentHostId: 'testbook',
      machinesDir: 'dsh-au/sync/machines',
      machines: [
        {
          machineId: 'example-macbook-pro',
          displayName: '小贞林的 MacBook Pro',
          hostname: 'example-MacBook-Pro.local',
          platform: 'darwin',
          updatedAt: '2026-10-27T02:55:33.072Z',
          serviceCount: 2,
          favoriteCount: 2,
          plugins: ['@weibaohui/dsh-continue', 'dsh-market'],
          pluginCount: 2,
          broken: false,
          active: true,
          currentHost: false,
          file: 'dsh-au/sync/machines/example-macbook-pro.json',
        },
        {
          machineId: 'testbook',
          displayName: '测试机',
          hostname: 'TestBook',
          platform: 'darwin',
          updatedAt: '2026-10-20T11:00:00.000Z',
          serviceCount: 1,
          favoriteCount: 3,
          plugins: [],
          pluginCount: 0,
          broken: false,
          active: false,
          currentHost: true,
          file: 'dsh-au/sync/machines/testbook.json',
        },
      ],
    },
    runner: {
      running: true,
      code: '11',
      label: '同步 Skill',
      exitCode: null,
      logs: [
        { type: 'cmd', text: '$ node scripts/sync-skill.js' },
        { type: 'out', text: '[完成] 已同步 12 项' },
        { type: 'out', text: '[执行结束] 退出码: 0' },
      ],
    },
    serviceLogsById: {
      dsh_bridge: [{ type: 'out', text: 'bridge listening on :55656' }],
    },
  };
}

const STATE_KEYS = [
  'wb', 'activeTab', 'search', 'osOverride', 'selectedCode', 'selectedServiceId',
  'selectedPluginId', 'pluginView', 'serviceView', 'pluginSaving', 'pluginNotice', 'pluginNoticeOwner',
  'menuParamValues',
  'dshProfile', 'scrcpyDevice', 'stdinText', 'busySvcId', 'busyMachineId', 'pendingDeleteSvc',
  'pendingDeletePlugin', 'serviceNotice', 'copiedLog', 'debugExpanded',
  'selectedAiServiceIds', 'aiSyncPromptVisible', 'aiSyncPromptCopied', 'savingServiceFlag',
];

const CASES = [
  { name: 'fav-darwin', state: { activeTab: 'fav' } },
  { name: 'all-darwin', state: { activeTab: 'all' } },
  // 锁住声明式 params：右侧检查器是通用 multiselect（Skill 标签 + options），不是旧的 repoSkills 双 span。
  { name: 'group-cursor', state: { activeTab: 'cursor', selectedCode: '45' } },
  { name: 'search-filtered', state: { activeTab: 'all', search: 'cursor' } },
  { name: 'services-local', state: { activeTab: 'services', selectedServiceId: 'dsh_bridge' } },
  { name: 'services-backup', state: { activeTab: 'services', serviceView: 'backup' } },
  { name: 'services-cloud', state: { activeTab: 'services', serviceView: 'cloud', selectedServiceId: 'antigravity' } },
  { name: 'services-cloud-ai-prompt', state: { activeTab: 'services', serviceView: 'cloud', selectedServiceId: 'antigravity', selectedAiServiceIds: ['antigravity'], aiSyncPromptVisible: true } },
  { name: 'services-flag-on', state: { activeTab: 'services', selectedServiceId: 'antigravity', busySvcId: 'antigravity', serviceNotice: { id: 'antigravity', text: '已接入' } } },
  { name: 'plugins-local', state: { activeTab: 'plugins', selectedPluginId: 'dsh-au' } },
  { name: 'plugins-cloud', state: { activeTab: 'plugins', pluginView: 'cloud', selectedPluginId: 'dsh-acp-adapter', pluginNotice: '同步完成', pluginNoticeOwner: 'dsh-acp-adapter' } },
  { name: 'menu-confirm', state: { activeTab: 'basic', selectedCode: '41', stdinText: 'y' } },
  { name: 'menu-quota', state: { activeTab: 'basic', selectedCode: '31', debugExpanded: true, copiedLog: true } },
  // 锁住声明式 select：动作选项来自 item.params，Win32 预览不再渲染旧的 4 步 IDE 文案。
  { name: 'win32-preview', state: { activeTab: 'all', osOverride: 'win32', selectedCode: '21' } },
];

function renderCase(definition, testCase) {
  // wbPatch 只给排序这类用例改局部数据，基线快照仍用完整 makeWb()。
  const wb = { ...makeWb(), ...(testCase.wbPatch || {}) };
  const state = {
    activeTab: 'fav', search: '', osOverride: '', selectedCode: '11',
    selectedServiceId: 'dsh_bridge', selectedPluginId: '', pluginView: 'local',
    serviceView: 'local', pluginSaving: false, pluginNotice: '', pluginNoticeOwner: '', menuParamValues: { skills: ['skill-a'] },
    dshProfile: 'kiro', scrcpyDevice: '', stdinText: '', busySvcId: '', busyMachineId: '', pendingDeleteSvc: '',
    serviceNotice: null, copiedLog: false, debugExpanded: false,
    selectedAiServiceIds: [], aiSyncPromptVisible: false, aiSyncPromptCopied: false, savingServiceFlag: null,
    ...testCase.state,
  };
  // 只有 fav / all / group 之外的用例才切 wb.platformOs，避免两套 fixture 打架。
  if (state.osOverride === '') delete state.osOverride;
  const values = STATE_KEYS.map((key) => (key === 'wb' ? wb : state[key]));
  const React = makeReact(values);
  const winMod = definition.factory((id) => {
    if (id === 'react') return React;
    if (id === 'react-dom') return { createPortal: (element) => element };
    throw new Error(`未预期的 require：${id}`);
  });
  assert.equal(winMod.name, 'dsh-au');
  React.reset();
  const tree = globalThis.__AU_CLIENT_TEST__.UnifiedWorkbenchModal({ initialTab: 'fav', onClose() {} });
  return JSON.stringify(serialize(tree), null, 1);
}

const definition = loadWorkbench();

test('工作台渲染快照：拆分前后 DOM 结构必须一致', () => {
  mkdirSync(snapshotDir, { recursive: true });
  const update = process.env.UPDATE_SNAPSHOTS === '1';
  const mismatches = [];
  for (const testCase of CASES) {
    const actual = renderCase(definition, testCase);
    const file = join(snapshotDir, `${testCase.name}.json`);
    if (update || !existsSync(file)) {
      writeFileSync(file, `${actual}\n`);
      continue;
    }
    // 快照在 Windows checkout 时可能被 Git 转成 CRLF；渲染结果固定为 LF，比较前统一换行符。
    const expected = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim();
    if (expected !== actual.trim()) mismatches.push(testCase.name);
  }
  assert.deepEqual(mismatches, [], `渲染结构与基线不一致：${mismatches.join(', ')}`);
});

test('声明式 params 检查器使用通用控件，而不是旧硬编码选项', () => {
  const cursor = renderCase(definition, CASES.find((item) => item.name === 'group-cursor'));
  assert.match(cursor, /"c": "Skill"/);
  assert.match(cursor, /"c": "skill-a"/);
  assert.match(cursor, /"c": "skill-b"/);

  const win = renderCase(definition, CASES.find((item) => item.name === 'win32-preview'));
  assert.match(win, /"c": "动作"/);
  assert.match(win, /"c": "上传"/);
  assert.match(win, /"c": "同步"/);
  assert.doesNotMatch(win, /1\. 上传 \(本机 -> 项目\)/);
  assert.doesNotMatch(win, /Codex 主档/);
});

test('渲染快照覆盖所有工作台标签页', () => {
  // 拆面板时如果漏了某个分支，这里会因为缺少快照文件而提醒补 fixture。
  const missing = CASES.filter((testCase) => !existsSync(join(snapshotDir, `${testCase.name}.json`)));
  assert.deepEqual(missing.map((item) => item.name), []);
});

/** 从渲染树按 DOM 顺序取插件卡标题，用来校验排序而不是靠字符串位置碰运气。 */
function pluginCardTitles(tree) {
  const titles = [];
  const collectTitle = (node) => {
    if (!node || typeof node === 'string') return;
    if (Array.isArray(node)) {
      node.forEach(collectTitle);
      return;
    }
    if (String(node?.p?.className || '').split(/\s+/).includes('dsh-au-card-title')) {
      const text = node.c;
      titles.push(typeof text === 'string' ? text : flatten(text, []).join(''));
      return;
    }
    collectTitle(node.c);
  };
  const visit = (node) => {
    if (!node || typeof node === 'string') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (String(node?.p?.className || '').includes('dsh-au-wb-card')) {
      collectTitle(node.c);
      return;
    }
    visit(node.c);
  };
  visit(tree);
  return titles;
}

test('回归 2026-10-27：缺失本机绑定时服务页明确提示未生成', () => {
  const rendered = renderCase(definition, {
    state: { activeTab: 'services', selectedServiceId: 'dsh_bridge' },
    wbPatch: {
      selfHostname: 'MissingBook',
      localBinding: {
        machineId: 'missingbook',
        file: 'dsh-au/sync/machines/missingbook.json',
        exists: false,
        machines: [],
      },
    },
  });

  assert.match(rendered, /未生成本机绑定（预期文件：machines\/missingbook\.json）/);
  assert.doesNotMatch(rendered, /· 绑定 machines\/missingbook\.json/);
});

test('Windows 回退 powershell 预览时右侧仍显示菜单执行结果', () => {
  const savedPreview = 'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/init.ps1';
  const renderWithPsName = (psCommandName) => renderCase(definition, {
    state: { activeTab: 'basic', osOverride: 'win32', selectedCode: '11' },
    wbPatch: {
      platformOs: 'win32',
      menuSpec: {
        configured: true,
        psCommandName,
        groups: [{
          id: 'basic',
          title: '基础',
          items: [{
            code: '11',
            label: '同步 Skill',
            description: '把仓库 Skill 同步到各端',
            runner: 'platform',
            script: 'init',
            resolvedScript: 'scripts/init.ps1',
          }],
        }],
      },
      runner: {
        running: false,
        activeCode: '',
        previewByCode: { 11: savedPreview },
        logsByCode: {
          11: [
            { type: 'cmd', text: `$ ${savedPreview}` },
            { type: 'ok', text: '[完成] Windows 菜单已执行' },
            { type: 'ok', text: '[执行结束] #11 同步 Skill 退出码: 0' },
          ],
        },
      },
    },
  });

  // 后端 preview 为 powershell，前端 menuSpec 也报告 powershell 时应对上。
  assert.match(renderWithPsName('powershell'), /Windows 菜单已执行/);
  // 双保险：前端仍按 pwsh 拼预览时，归一化比较也不能丢掉结果。
  const mismatched = renderWithPsName('pwsh');
  assert.match(mismatched, /Windows 菜单已执行/);
  assert.match(mismatched, /执行成功/);
});

test('未配置私人同步仓库时菜单面板展示提示卡片', () => {
  const rendered = renderCase(definition, {
    state: { activeTab: 'all' },
    wbPatch: {
      menuSpec: {
        configured: false,
        message: '未配置私人同步仓库 (syncRepoRoot)',
        groups: [],
      },
    },
  });
  assert.match(rendered, /未配置私人同步仓库 \(syncRepoRoot\)/);
});

test('插件卡按「启用 + 已接入云同步」优先排序', () => {
  // 宿主按包名返回，和用户关心的状态无关：启用且已接云的必须提到最前。
  const tree = JSON.parse(renderCase(definition, {
    state: { activeTab: 'plugins', selectedPluginId: '' },
    wbPatch: {
      dshPlugins: [
        { id: 'cloud-only', package: 'cloud-only', name: '云插件甲', version: '1.0.0' },
        { id: 'dsh-au', package: 'dsh-au', name: 'DSH AU', version: '0.1.0' },
      ],
      localDshPlugins: [
        { id: 'local-only', package: 'local-only', name: '本机未启用', version: '1.0.0', enabled: false },
        { id: 'cloud-only', package: 'cloud-only', name: '云插件甲', version: '1.0.0', enabled: false },
        { id: 'dsh-au', package: 'dsh-au', name: 'DSH AU', version: '0.1.0', enabled: true },
      ],
      currentMachineDshPluginIds: ['dsh-au', 'cloud-only'],
    },
  }));
  assert.deepEqual(pluginCardTitles(tree), ['DSH AU', '云插件甲', '本机未启用']);
});

test('插件操作提示仅在所属插件详情中显示', () => {
  const otherPlugin = renderCase(definition, {
    state: {
      activeTab: 'plugins', selectedPluginId: 'dsh-au',
      pluginNotice: 'ACP 安装失败', pluginNoticeOwner: 'dsh-acp-adapter',
    },
  });
  assert.doesNotMatch(otherPlugin, /ACP 安装失败/);

  const ownerPlugin = renderCase(definition, {
    state: {
      activeTab: 'plugins', pluginView: 'cloud', selectedPluginId: 'dsh-acp-adapter',
      pluginNotice: 'ACP 安装失败', pluginNoticeOwner: 'dsh-acp-adapter',
    },
  });
  assert.match(ownerPlugin, /ACP 安装失败/);
});

test('云服务 AI同步只展示临时勾选与安全 Prompt', () => {
  const rendered = renderCase(definition, {
    state: {
      activeTab: 'services', serviceView: 'cloud', selectedServiceId: 'antigravity',
      selectedAiServiceIds: ['antigravity'], aiSyncPromptVisible: true,
    },
  });

  assert.match(rendered, /AI同步 · 已勾选 1 项/);
  assert.match(rendered, /选择 AI同步/);
  assert.match(rendered, /任务：安全接入以下云服务到当前电脑/);
  assert.match(rendered, /先阅读 dsh-au\/sync\/README\.md/);
  assert.match(rendered, /不得读取、输出或写入 password、token、secret、api_key、cookie 等凭据/);
  assert.match(rendered, /遇到安装、覆盖现有配置、路径缺失、启动\/停止服务或任何不确定项/);
});

test('子进程输入等待判定：只读指令豁免且浮点数/金额不误触发', () => {
  const { getChildInputGuide } = globalThis.__AU_CLIENT_TEST__;
  assert.equal(typeof getChildInputGuide, 'function', '必须导出 getChildInputGuide');

  // 1. 只读菜单项无论输出什么，均不得弹出输入等待框
  const readonlyItem = { code: '34', readonly: true, label: '一键查询所有额度' };
  assert.equal(getChildInputGuide(readonlyItem, [{ text: '1. 选项一' }]), null);
  assert.equal(getChildInputGuide(readonlyItem, [{ text: '请选择要操作的环境：' }]), null);
  assert.equal(getChildInputGuide(readonlyItem, [{ text: '是否继续？[y/n]' }]), null);

  // 2. 包含浮点数金额、百分比的输出绝不误触发选项序号选择
  const normalItem = { code: '99', readonly: false, label: '普通任务' };
  assert.equal(getChildInputGuide(normalItem, [{ text: 'Key2 今日 45.28 | 本月 785.86' }]), null);
  assert.equal(getChildInputGuide(normalItem, [{ text: '周额度 剩余 100.00% | 重置 2026-11-04 14:39' }]), null);
  assert.equal(getChildInputGuide(normalItem, [{ text: '模型额度 全部 100.0%（13 个模型无消耗）' }]), null);
  assert.equal(getChildInputGuide(normalItem, [{ text: '花费: 0.00 元' }]), null);

  // 3. 真正的选项序号或确认提示应正常触发
  const choiceGuide = getChildInputGuide(normalItem, [{ text: '1. 生产环境\n2. 测试环境' }]);
  assert.ok(choiceGuide);
  assert.match(choiceGuide.text, /当前子进程正在等待选项序号/);

  const chineseChoiceGuide = getChildInputGuide(normalItem, [{ text: '1、执行更新\n2、放弃' }]);
  assert.ok(chineseChoiceGuide);
  assert.match(chineseChoiceGuide.text, /当前子进程正在等待选项序号/);

  const confirmGuide = getChildInputGuide(normalItem, [{ text: '是否继续执行？[y/n]' }]);
  assert.ok(confirmGuide);
  assert.match(confirmGuide.text, /当前子进程正在等待确认/);
});

test('额度卡片解析：标签与数值清晰规整，分隔符统一美化', () => {
  const { parseQuotaSections } = globalThis.__AU_CLIENT_TEST__;
  assert.equal(typeof parseQuotaSections, 'function', '必须导出 parseQuotaSections');

  const logs = [
    { text: '=== 示例网关 用量 ===' },
    { text: '  Key1（原 Key）  今日 1.00 | 本月 10.00' },
    { text: '  Key2            今日 2.00 | 本月 20.00' },
    { text: '=== Antigravity 额度（demo）===' },
    { text: '  周额度          剩余 90.00% | 重置 2026-01-15 12:00' },
    { text: '  模型额度        全部 100.0%（3 个模型无消耗）' },
    { text: '=== Kiro 用量 ===' },
    { text: '  KIRO PRO MAX    已用 100.00 / 5000 (2.0%) | 重置 2026-01-01' },
  ];

  const sections = parseQuotaSections(logs, { code: '34', readonly: true });
  assert.equal(sections.length, 3);

  // 1. 示例网关
  assert.equal(sections[0].title, '示例网关 用量');
  assert.equal(sections[0].rows[0].label, 'Key1（原 Key）');
  assert.equal(sections[0].rows[0].value, '今日 1.00 · 本月 10.00');
  assert.equal(sections[0].rows[1].label, 'Key2');
  assert.equal(sections[0].rows[1].value, '今日 2.00 · 本月 20.00');

  // 2. Antigravity
  assert.equal(sections[1].title, 'Antigravity 额度（demo）');
  assert.equal(sections[1].rows[0].label, '周额度');
  assert.equal(sections[1].rows[0].value, '剩余 90.00% · 重置 2026-01-15 12:00');
  assert.equal(sections[1].rows[1].label, '模型额度');
  assert.equal(sections[1].rows[1].value, '全部 100.0%（3 个模型无消耗）');

  // 3. Kiro
  assert.equal(sections[2].title, 'Kiro 用量');
  assert.equal(sections[2].rows[0].label, 'KIRO PRO MAX');
  assert.equal(sections[2].rows[0].value, '已用 100.00 / 5000 (2.0%) · 重置 2026-01-01');
  assert.equal(sections[2].rows[0].tone, 'emerald');
});



