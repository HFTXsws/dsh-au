import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CLIENT_RETURN = "    return { name: 'dsh-au', inject, apply, mobile: mobileClient.helpers, shortcuts: shortcutHelpers };";
const EXPORT_HOOK = '\n    globalThis.__AU_SERVICE_FLAG_TEST__ = { UnifiedWorkbenchModal, resolveServiceState };\n' + CLIENT_RETURN;

function makeWindow() {
  const storage = new Map();
  return {
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    addEventListener() {},
    removeEventListener() {},
    location: { href: 'http://localhost/' },
  };
}

/** React 是宿主提供的运行边界；setter 真正更新状态，ref 在重新渲染后保留身份。 */
function makeReact(workbench) {
  const states = [];
  const refs = [];
  let stateCursor = 0;
  let refCursor = 0;
  return {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      const merged = { ...(props || {}) };
      if (children.length === 1) merged.children = children[0];
      else if (children.length > 1) merged.children = children;
      return { type, props: merged };
    },
    useState(initialValue) {
      const index = stateCursor++;
      if (!(index in states)) {
        // 只替换工作台的初始网络快照，其余 hook 一律执行真实组件的初始值。
        states[index] = index === 0 ? structuredClone(workbench)
          : (typeof initialValue === 'function' ? initialValue() : initialValue);
      }
      return [states[index], (update) => {
        states[index] = typeof update === 'function' ? update(states[index]) : update;
      }];
    },
    useRef(initialValue) {
      const index = refCursor++;
      if (!(index in refs)) refs[index] = { current: initialValue };
      return refs[index];
    },
    useCallback: (callback) => callback,
    useMemo: (callback) => callback(),
    // 此文件测试手动开关，不运行初始化请求和定时轮询，避免外部时钟干扰行为证明。
    useEffect() {},
    reset() { stateCursor = 0; refCursor = 0; },
  };
}

function serviceFixture({ id = 'dsh_bridge', enabled = false, boot = false, systemBoot } = {}) {
  return {
    id,
    name: id === 'dsh_bridge' ? 'DSH 远程访问桥接' : 'DSH IPv6 直连（Caddy）',
    description: '服务开关回归夹具',
    running: true,
    control: 'full',
    canControl: true,
    port: id === 'dsh_bridge' ? 3080 : 8443,
    ...(id === 'svc_ipv6_entry' ? { serviceName: 'ExampleIPv6Svc' } : {}),
    instances: [],
    localState: { enabled, autoStartOnBoot: boot, autoStartOnDsh: false, cloud: false },
    ...(systemBoot ? { systemBoot } : {}),
  };
}

function workbenchFixture(service = serviceFixture()) {
  return {
    ok: true,
    selfHostname: 'FlagBook',
    platformOs: 'win32',
    menuSpec: { groups: [], repoSkills: [], ideProfiles: [] },
    menuFavorites: [],
    services: [service],
    cloudServiceIds: [],
    currentMachineProfile: {
      enabled: service.localState.enabled ? [service.id] : [],
      autoStartOnBoot: service.localState.enabled && service.localState.autoStartOnBoot ? [service.id] : [],
      autoStartOnDsh: [],
    },
    machineServiceProfiles: {},
    localBinding: { exists: true, machineId: 'flagbook', file: 'dsh-au/sync/machines/flagbook.json', serviceIds: [service.id], machines: [] },
    localDshPlugins: [],
    dshPlugins: [],
    currentMachineDshPluginIds: [],
    serviceLogsById: {},
    runner: { running: false, logs: [], logsByCode: {} },
  };
}

function httpResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
}

function saveResponse({ id = 'dsh_bridge', enabled = true, boot = false } = {}) {
  const profile = {
    enabled: enabled ? [id] : [],
    autoStartOnBoot: enabled && boot ? [id] : [],
    autoStartOnDsh: [],
  };
  return {
    ok: true,
    hostname: 'FlagBook',
    profile,
    currentMachineProfile: profile,
    localStateLists: { ...profile, cloud: [] },
  };
}

/** 真正执行已生成客户端的 factory；不替换服务解析、保存 handler 或 fetch 包装器。 */
function loadClient({ service = serviceFixture(), respond = () => httpResponse(saveResponse()) } = {}) {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  assert.ok(code.includes(CLIENT_RETURN), 'client.js 缺少 ModuleLoader factory 测试注入点');
  const requests = [];
  const win = makeWindow();
  const exports = {};
  const React = makeReact(workbenchFixture(service));
  win.__ModuleLoader__ = { load: (definition) => { win.definition = definition; } };
  const fetch = async (url, options) => {
    const request = { url, method: options?.method, payload: JSON.parse(options?.body || '{}') };
    requests.push(request);
    return respond(request);
  };
  new Function('window', 'fetch', 'globalThis', code.replace(CLIENT_RETURN, EXPORT_HOOK))(win, fetch, exports);
  win.definition.factory((id) => {
    if (id === 'react') return React;
    if (id === 'react-dom') return { createPortal: (element) => element };
    throw new Error(`未预期的客户端依赖：${id}`);
  });
  const hooks = exports.__AU_SERVICE_FLAG_TEST__;
  assert.equal(typeof hooks?.UnifiedWorkbenchModal, 'function');
  assert.equal(typeof hooks?.resolveServiceState, 'function');
  return {
    requests,
    resolveServiceState: hooks.resolveServiceState,
    render() {
      React.reset();
      return hooks.UnifiedWorkbenchModal({ initialTab: 'services', onClose() {} });
    },
  };
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return textOf(node.props?.children);
}

function findAll(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (Array.isArray(node)) { node.forEach((item) => findAll(item, predicate, found)); return found; }
  if (predicate(node)) found.push(node);
  findAll(node.props?.children, predicate, found);
  return found;
}

function flagButton(tree, flag) {
  const matches = findAll(tree, (node) => node.type === 'button'
    && String(node.props?.className || '').split(/\s+/).includes('dsh-au-kv')
    && (flag === 'enabled' ? textOf(node).startsWith('本机启用') : /开机.*自启/.test(textOf(node))));
  assert.equal(matches.length, 1, `必须能找到唯一的 ${flag} 开关行`);
  return matches[0];
}

function assertErrorAndLog(tree) {
  const notices = findAll(tree, (node) => node.props?.['data-tone'] === 'err' && textOf(node).length > 0);
  assert.ok(notices.length > 0, '保存失败必须有可见错误提示');
  const debugToggle = findAll(tree, (node) => node.type === 'button' && textOf(node).includes('调试详情'))[0];
  assert.ok(debugToggle, '服务详情必须保留诊断入口');
  return debugToggle;
}

function assertVisibleErrorLog(tree) {
  const terminals = findAll(tree, (node) => String(node.props?.className || '').split(/\s+/).includes('dsh-au-wb-term'));
  assert.equal(terminals.length, 1, '展开后的服务详情必须有日志区域');
  assert.ok(findAll(terminals[0], (node) => node.props?.className === 'dsh-au-log-err').length > 0,
    '保存失败不能只有空日志占位符，必须记录界面错误');
}

// 2026-10-28 生产回归：注册状态不能冒充启用状态；点击自启时自动联动开启本机启用。
test('已登记但未启用的服务不显示启用，点击开机自启可联动开启本机启用', async () => {
  const client = loadClient({
    respond: () => httpResponse(saveResponse({ enabled: true, boot: true })),
  });
  const service = serviceFixture();
  const state = client.resolveServiceState(service, [service.id], [], false);
  assert.equal(state.connectedOnHost, true);
  assert.equal(state.enabledOnHost, false);
  assert.equal(state.bootOn, false);
  const unregistered = client.resolveServiceState(serviceFixture({ enabled: true, boot: true }), [], [], false);
  assert.equal(unregistered.connectedOnHost, false);
  assert.equal(unregistered.enabledOnHost, false, '旧的 enabled 记录不能让未登记服务看起来已启用');
  assert.equal(unregistered.bootOn, false);
  const tree = client.render();
  assert.ok(textOf(flagButton(tree, 'enabled')).includes('关闭'));
  const bootButton = flagButton(tree, 'autoStartOnBoot');
  assert.equal(bootButton.props.disabled, false);
  await bootButton.props.onClick?.();
  assert.deepEqual(client.requests, [{
    url: '/dsh-au/api',
    method: 'POST',
    payload: { action: 'saveMachineServiceProfile', hostname: 'FlagBook', serviceId: 'dsh_bridge', field: 'autoStartOnBoot', value: true },
  }]);
  const updatedTree = client.render();
  assert.ok(textOf(flagButton(updatedTree, 'enabled')).includes('开启'));
  assert.ok(textOf(flagButton(updatedTree, 'autoStartOnBoot')).includes('开启'));
});

test('点击本机启用提交单字段保存并在确认成功后开启', async () => {
  const client = loadClient();
  const button = flagButton(client.render(), 'enabled');
  await button.props.onClick();
  assert.deepEqual(client.requests, [{
    url: '/dsh-au/api',
    method: 'POST',
    payload: { action: 'saveMachineServiceProfile', hostname: 'FlagBook', serviceId: 'dsh_bridge', field: 'enabled', value: true },
  }]);
  assert.ok(textOf(flagButton(client.render(), 'enabled')).includes('开启'));
  assert.equal(flagButton(client.render(), 'autoStartOnBoot').props.disabled, false);
});

test('已启用服务可关闭开机自启且仍保持本机启用', async () => {
  const client = loadClient({
    service: serviceFixture({ enabled: true, boot: true }),
    respond: () => httpResponse(saveResponse({ enabled: true, boot: false })),
  });
  await flagButton(client.render(), 'autoStartOnBoot').props.onClick();
  assert.deepEqual(client.requests[0].payload, {
    action: 'saveMachineServiceProfile', hostname: 'FlagBook', serviceId: 'dsh_bridge', field: 'autoStartOnBoot', value: false,
  });
  const tree = client.render();
  assert.ok(textOf(flagButton(tree, 'autoStartOnBoot')).includes('关闭'));
  assert.ok(textOf(flagButton(tree, 'enabled')).includes('开启'));
});

test('HTTP 失败或保存回执不一致均保持原状态并展示错误日志', async (t) => {
  const failures = [
    { name: 'HTTP 500', response: () => httpResponse({ ok: false, error: '服务开关保存不可用' }, 500) },
    { name: 'HTTP 200 但目标未写入', response: () => httpResponse(saveResponse({ enabled: false })) },
    { name: 'HTTP 200 缺少开关回执', response: () => httpResponse({ ok: true }) },
  ];
  for (const failure of failures) {
    await t.test(failure.name, async () => {
      const client = loadClient({ respond: failure.response });
      await flagButton(client.render(), 'enabled').props.onClick();
      let tree = client.render();
      assert.equal(client.requests.length, 1);
      assert.ok(textOf(flagButton(tree, 'enabled')).includes('关闭'));
      assert.equal(flagButton(tree, 'enabled').props.disabled, false, '失败后保存状态必须解除');
      const debugToggle = assertErrorAndLog(tree);
      if (debugToggle.props['aria-expanded'] !== true) {
        debugToggle.props.onClick();
        tree = client.render();
      }
      assertVisibleErrorLog(tree);
    });
  }
});

test('开关已保存但启动项写入失败时保留开启状态并明确提示同步失败', async () => {
  const client = loadClient({
    service: serviceFixture({ enabled: true, boot: false }),
    respond: () => httpResponse({
      ...saveResponse({ enabled: true, boot: true }),
      bootSync: { synced: false, error: '启动项写入失败' },
    }),
  });
  await flagButton(client.render(), 'autoStartOnBoot').props.onClick();
  let tree = client.render();
  assert.equal(client.requests.length, 1);
  assert.equal(client.requests[0].payload.value, true);
  const bootButton = flagButton(tree, 'autoStartOnBoot');
  assert.ok(textOf(bootButton).includes('开启'), '启动项失败不能把已经保存的开关回滚为关闭');
  assert.equal(bootButton.props.disabled, false, '同步失败后仍需解除保存锁');
  const notices = findAll(tree, (node) => node.props?.['data-tone'] === 'err');
  assert.ok(notices.some((notice) => textOf(notice).includes('开关已保存，但启动项同步失败')
    && textOf(notice).includes('启动项写入失败')), '必须区分开关已保存与系统启动项未生效');
  assert.ok(!textOf(tree).includes('未保存或未生效'), '不能将已确认保存错误地提示为未保存');
  const debugToggle = assertErrorAndLog(tree);
  if (debugToggle.props['aria-expanded'] !== true) {
    debugToggle.props.onClick();
    tree = client.render();
  }
  assertVisibleErrorLog(tree);
});

test('保存期间重复点击仅发出一个请求且结束后解除禁用', async () => {
  let complete;
  const response = new Promise((resolve) => { complete = resolve; });
  const client = loadClient({ respond: () => response });
  const button = flagButton(client.render(), 'enabled');
  const firstSave = button.props.onClick();
  // 使用同一个旧 callback 模拟 React 尚未重新渲染时的快速双击。
  const secondSave = button.props.onClick();
  assert.equal(client.requests.length, 1);
  assert.equal(flagButton(client.render(), 'enabled').props.disabled, true);
  complete(httpResponse(saveResponse()));
  await Promise.all([firstSave, secondSave]);
  const finished = flagButton(client.render(), 'enabled');
  assert.equal(finished.props.disabled, false);
  assert.ok(textOf(finished).includes('开启'));
});

test('不可控服务在卡片上直接显示原因，可控服务不显示', () => {
  const reason = '当前 Windows 控制器没有登记此服务，暂不提供不可靠的启停操作';
  const locked = loadClient({ service: { ...serviceFixture({ enabled: true }), canControl: false, controlReason: reason } });
  const lockedNotes = findAll(locked.render(), (node) => node?.props?.className === 'dsh-au-card-desc' && textOf(node).startsWith('仅可查看'));
  assert.equal(lockedNotes.length, 1, '不可控服务卡片必须说明原因');
  assert.ok(textOf(lockedNotes[0]).includes(reason));
  const open = loadClient({ service: serviceFixture({ enabled: true }) });
  assert.equal(findAll(open.render(), (node) => textOf(node).startsWith('仅可查看')).length, 0);
});

test('Windows 系统服务自启可在插件中直接点击切换并提交保存', async (t) => {
  const modes = [
    { enabled: true, mode: 'Auto', localBoot: true, expectedValue: false },
    { enabled: false, mode: 'Manual', localBoot: false, expectedValue: true },
  ];
  for (const mode of modes) {
    await t.test(mode.mode, async () => {
      const client = loadClient({ service: serviceFixture({
        id: 'svc_ipv6_entry', enabled: true, boot: mode.localBoot,
        systemBoot: { managed: true, serviceName: 'ExampleIPv6Svc', enabled: mode.enabled, mode: mode.mode, reason: '由插件联动 Windows 系统服务控制开机自启' },
      }) });
      const button = flagButton(client.render(), 'autoStartOnBoot');
      assert.equal(Boolean(button.props.disabled), false, '系统服务自启按钮必须允许点击管理');
      await button.props.onClick?.();
      assert.equal(client.requests.length, 1, '点击系统服务自启应提交保存请求');
      assert.equal(client.requests[0].payload.field, 'autoStartOnBoot');
      assert.equal(client.requests[0].payload.value, mode.expectedValue);
    });
  }
});

// 盘符挂载调试详情：缓存目录必须独立展示，不能冒充 rclone 配置文件路径。
test('盘符挂载调试详情独立显示脚本、配置和缓存路径且不触发服务控制', () => {
  const service = serviceFixture({ id: 'svc_mount' });
  Object.assign(service, {
    name: '示例盘符挂载 Q:', // 展示名与服务 id 分开
    scriptPath: 'C:/fixture/quark_mount.py',
    configPath: 'C:/fixture/rclone.conf',
    cacheDir: 'C:/fixture/cache',
  });
  const client = loadClient({ service });
  let tree = client.render();
  const debugButtons = findAll(tree, (node) => node.type === 'button' && textOf(node).includes('调试详情'));
  assert.equal(debugButtons.length, 1, '服务详情必须有唯一的调试详情入口');
  debugButtons[0].props.onClick();
  tree = client.render();

  for (const expectedLine of [
    '脚本路径: C:/fixture/quark_mount.py',
    '配置路径: C:/fixture/rclone.conf',
    '缓存目录: C:/fixture/cache',
  ]) {
    const lines = findAll(tree, (node) => node.type === 'div' && textOf(node) === expectedLine);
    assert.equal(lines.length, 1, `必须独立显示 ${expectedLine}`);
  }
  assert.ok(!textOf(tree).includes('配置路径: C:/fixture/cache'), '缓存目录不能显示成配置路径');
  assert.deepEqual(client.requests, [], '查看调试详情不能发出启停或其他 API 请求');
});
