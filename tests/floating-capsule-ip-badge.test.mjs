import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from '../scripts/build-client.js';

// 从 client/src/11-shell.js 提取纯函数，不改变模块隔离
function loadPureHelpers() {
  const source = readFileSync(new URL('../client/src/11-shell.js', import.meta.url), 'utf8');
  const start = source.indexOf('function isLoopbackHostname');
  const end = source.indexOf('// END resolveFloatingCapsuleIpBadge');
  assert.ok(start >= 0 && end > start, '11-shell.js 必须定义 isLoopbackHostname 与 resolveFloatingCapsuleIpBadge');
  return new Function(`${source.slice(start, end)}\nreturn { isLoopbackHostname, resolveFloatingCapsuleIpBadge };`)();
}

const CLIENT_RETURN = "    return { name: 'dsh-au', inject, apply, mobile: mobileClient.helpers, shortcuts: shortcutHelpers };";
const EXPORT_HOOK = '\n    globalThis.__AU_CAPSULE_BADGE_TEST__ = { AuFleetShell };\n' + CLIENT_RETURN;

function findAll(node, predicate, found = []) {
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, predicate, found);
    return found;
  }
  if (!node || typeof node !== 'object') return found;
  if (predicate(node)) found.push(node);
  findAll(node.props?.children, predicate, found);
  return found;
}

/** 模拟 AuFleetShell 渲染环境 */
function renderShell({ mobile = true, hostname = '192.168.1.88', clientIpVersion = '6', topbarCollapsed = true } = {}) {
  const storage = new Map();
  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  const win = {
    localStorage,
    innerWidth: mobile ? 390 : 1280,
    location: {
      hostname,
      href: `http://${hostname}:31990/`,
    },
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (cb) => cb(),
  };
  const doc = {
    body: { appendChild: (c) => c },
    documentElement: {},
    querySelector: () => null,
    createElement: () => ({ style: {}, appendChild: (c) => c, remove() {} }),
  };

  const states = [];
  const refs = [];
  let stateCursor = 0;
  let refCursor = 0;

  const mockSnapshot = {
    ok: true,
    clientIpVersion,
    self: { deviceId: 'self', ips: ['192.168.1.88'], status: 'idle' },
    devices: [{ id: 'self', name: 'self', status: 'idle', routes: [] }],
    remotes: [],
    lanPeers: [],
  };

  // 种子注入：第 0 个 state 为 snapshot，第 9 为 topbarCollapsed，第 10 为 compactMobile
  // 根据 11-shell.js 中的 useState 声明顺序：
  // 0: state, 1: activeId, 2: openedIds, 3: openedRouteUrls, 4: directFrameRoutes, 5: reloadSeq, 6: loadedMap, 7: failedLoadDevices
  // 8: editingRemote, 9: editingDevice, 10: remoteManager, 11: workbenchTab, 12: scanning, 13: topbarCollapsed, 14: compactMobile
  const seeds = new Map([
    [0, { self: mockSnapshot.self, devices: mockSnapshot.devices, lanPeers: [], remotes: [], clientIpVersion }],
    [13, topbarCollapsed],
    [14, mobile],
  ]);

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children: children.length === 1 ? children[0] : (children.length > 1 ? children : props?.children) } };
    },
    useState(initialValue) {
      const index = stateCursor++;
      if (!(index in states)) {
        states[index] = seeds.has(index) ? seeds.get(index) : (typeof initialValue === 'function' ? initialValue() : initialValue);
      }
      return [states[index], (update) => { states[index] = typeof update === 'function' ? update(states[index]) : update; }];
    },
    useRef(initialValue) {
      const index = refCursor++;
      if (!(index in refs)) refs[index] = { current: initialValue };
      return refs[index];
    },
    useCallback: (cb) => cb,
    useEffect() {},
    useMemo: (fn) => fn(),
  };

  const exports = {};
  win.__ModuleLoader__ = { load: (definition) => { win.definition = definition; } };
  const code = build();
  assert.ok(code.includes(CLIENT_RETURN), 'bundle 必须包含工厂导出出口');
  new Function('window', 'document', 'localStorage', 'fetch', 'globalThis', code.replace(CLIENT_RETURN, EXPORT_HOOK))(win, doc, localStorage, () => {}, exports);
  win.definition.factory((id) => {
    if (id === 'react') return React;
    if (id === 'react-dom') return { createPortal: (el) => el };
    throw new Error(`未预期的模块依赖：${id}`);
  });

  const { AuFleetShell } = exports.__AU_CAPSULE_BADGE_TEST__;
  stateCursor = 0;
  refCursor = 0;
  return AuFleetShell({
    selectPanel() {},
    collapseSidebar() {},
    expandSidebar() {},
    usePanelInfo: () => null,
  });
}

test('isLoopbackHostname: 正确识别本机回环与外网/局域网地址', () => {
  const { isLoopbackHostname } = loadPureHelpers();

  // 空值与空白判定为本机回环
  assert.equal(isLoopbackHostname(''), true);
  assert.equal(isLoopbackHostname('   '), true);
  assert.equal(isLoopbackHostname(null), true);
  assert.equal(isLoopbackHostname(undefined), true);

  // 本机回环典型值（忽略大小写和首尾空格）
  assert.equal(isLoopbackHostname('localhost'), true);
  assert.equal(isLoopbackHostname('LOCALHOST'), true);
  assert.equal(isLoopbackHostname('  localhost  '), true);
  assert.equal(isLoopbackHostname('127.0.0.1'), true);
  assert.equal(isLoopbackHostname(' 127.0.0.1 '), true);
  assert.equal(isLoopbackHostname('::1'), true);
  assert.equal(isLoopbackHostname(' ::1 '), true);
  assert.equal(isLoopbackHostname('[::1]'), true);
  assert.equal(isLoopbackHostname(' [::1] '), true);

  // 局域网与公网域名/IP 判定为非回环
  assert.equal(isLoopbackHostname('192.168.1.100'), false);
  assert.equal(isLoopbackHostname('10.0.0.2'), false);
  assert.equal(isLoopbackHostname('172.16.1.1'), false);
  assert.equal(isLoopbackHostname('au.example.com'), false);
  assert.equal(isLoopbackHostname('240e:398:3180:1::1'), false);
});

test('resolveFloatingCapsuleIpBadge: 手机端 + 公网/局域网域名 + clientIpVersion 6 -> 显示 6', () => {
  const { resolveFloatingCapsuleIpBadge } = loadPureHelpers();

  assert.equal(resolveFloatingCapsuleIpBadge({
    compactMobile: true,
    hostname: '192.168.1.50',
    clientIpVersion: '6',
  }), '6');

  assert.equal(resolveFloatingCapsuleIpBadge({
    compactMobile: true,
    hostname: 'au.example.com',
    clientIpVersion: '6',
  }), '6');

  assert.equal(resolveFloatingCapsuleIpBadge({
    compactMobile: true,
    hostname: '240e:398:3180:1::1',
    clientIpVersion: ' 6 ',
  }), '6');
});

test('resolveFloatingCapsuleIpBadge: 手机端 + 公网/局域网域名 + clientIpVersion 4 -> 显示 4', () => {
  const { resolveFloatingCapsuleIpBadge } = loadPureHelpers();

  assert.equal(resolveFloatingCapsuleIpBadge({
    compactMobile: true,
    hostname: '192.168.1.50',
    clientIpVersion: '4',
  }), '4');

  assert.equal(resolveFloatingCapsuleIpBadge({
    compactMobile: true,
    hostname: 'au.example.com',
    clientIpVersion: '4',
  }), '4');

  assert.equal(resolveFloatingCapsuleIpBadge({
    compactMobile: true,
    hostname: '10.0.0.8',
    clientIpVersion: ' 4 ',
  }), '4');
});

test('resolveFloatingCapsuleIpBadge: 桌面端（compactMobile: false）-> 不显示', () => {
  const { resolveFloatingCapsuleIpBadge } = loadPureHelpers();

  assert.equal(resolveFloatingCapsuleIpBadge({
    compactMobile: false,
    hostname: '192.168.1.50',
    clientIpVersion: '6',
  }), '');

  assert.equal(resolveFloatingCapsuleIpBadge({
    compactMobile: false,
    hostname: 'au.example.com',
    clientIpVersion: '4',
  }), '');
});

test('resolveFloatingCapsuleIpBadge: 本机 localhost / 127.0.0.1 / ::1 / [::1] -> 不显示', () => {
  const { resolveFloatingCapsuleIpBadge } = loadPureHelpers();

  for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '::1', '[::1]', '   ']) {
    assert.equal(resolveFloatingCapsuleIpBadge({
      compactMobile: true,
      hostname: host,
      clientIpVersion: '6',
    }), '', `回环主机 ${host} 不应显示 IPv6 角标`);

    assert.equal(resolveFloatingCapsuleIpBadge({
      compactMobile: true,
      hostname: host,
      clientIpVersion: '4',
    }), '', `回环主机 ${host} 不应显示 IPv4 角标`);
  }
});

test('resolveFloatingCapsuleIpBadge: clientIpVersion 为空或非法值 -> 不显示', () => {
  const { resolveFloatingCapsuleIpBadge } = loadPureHelpers();

  for (const invalid of ['', '   ', null, undefined, 'unknown', 'v6', 'v4', 6, 4]) {
    assert.equal(resolveFloatingCapsuleIpBadge({
      compactMobile: true,
      hostname: '192.168.1.50',
      clientIpVersion: invalid,
    }), '', `非法 IP 版本 ${invalid} 不应显示角标`);
  }
});

test('UI 渲染集成: 手机端局域网 IPv6 连接时渲染 .dsh-au-ip-badge.is-v6 且附带 title/aria-label', () => {
  const tree = renderShell({ mobile: true, hostname: '192.168.1.88', clientIpVersion: '6', topbarCollapsed: true });

  const capsules = findAll(tree, (n) => n.props?.className?.includes('dsh-au-floating-capsule'));
  assert.equal(capsules.length, 1, '应渲染出悬浮胶囊');
  const capsule = capsules[0];

  assert.match(capsule.props.title, /IPv6 连接/, 'title 应附带 IPv6 连接');
  assert.match(capsule.props['aria-label'], /IPv6 连接/, 'aria-label 应附带 IPv6 连接');

  const badges = findAll(capsule, (n) => n.props?.className?.includes('dsh-au-ip-badge'));
  assert.equal(badges.length, 1, '胶囊内应渲染 1 个角标元素');
  assert.equal(badges[0].props.className, 'dsh-au-ip-badge is-v6');
  assert.equal(badges[0].props['aria-hidden'], true);
  assert.equal(badges[0].props.children, '6');
});

test('UI 渲染集成: 手机端局域网 IPv4 连接时渲染 .dsh-au-ip-badge.is-v4 且附带 title/aria-label', () => {
  const tree = renderShell({ mobile: true, hostname: '192.168.1.88', clientIpVersion: '4', topbarCollapsed: true });

  const capsules = findAll(tree, (n) => n.props?.className?.includes('dsh-au-floating-capsule'));
  assert.equal(capsules.length, 1, '应渲染出悬浮胶囊');
  const capsule = capsules[0];

  assert.match(capsule.props.title, /IPv4 连接/, 'title 应附带 IPv4 连接');
  assert.match(capsule.props['aria-label'], /IPv4 连接/, 'aria-label 应附带 IPv4 连接');

  const badges = findAll(capsule, (n) => n.props?.className?.includes('dsh-au-ip-badge'));
  assert.equal(badges.length, 1, '胶囊内应渲染 1 个角标元素');
  assert.equal(badges[0].props.className, 'dsh-au-ip-badge is-v4');
  assert.equal(badges[0].props['aria-hidden'], true);
  assert.equal(badges[0].props.children, '4');
});

test('UI 渲染集成: 本机 localhost 访问时不渲染角标且不附带协议后缀', () => {
  const tree = renderShell({ mobile: true, hostname: 'localhost', clientIpVersion: '6', topbarCollapsed: true });

  const capsules = findAll(tree, (n) => n.props?.className?.includes('dsh-au-floating-capsule'));
  assert.equal(capsules.length, 1);
  const capsule = capsules[0];

  assert.doesNotMatch(capsule.props.title, /IPv[46] 连接/);
  assert.doesNotMatch(capsule.props['aria-label'], /IPv[46] 连接/);

  const badges = findAll(capsule, (n) => n.props?.className?.includes('dsh-au-ip-badge'));
  assert.equal(badges.length, 0, 'localhost 访问不应渲染角标');
});

test('UI 样式验证: client/src/02-styles.js 包含 .dsh-au-ip-badge、.is-v6 与 .is-v4 规则', () => {
  const stylesSource = readFileSync(new URL('../client/src/02-styles.js', import.meta.url), 'utf8');
  assert.match(stylesSource, /\.dsh-au-ip-badge\s*\{[^}]*position:\s*absolute/);
  assert.match(stylesSource, /\.dsh-au-ip-badge\.is-v6\s*\{[^}]*#0f2922[^}]*#34d399/);
  assert.match(stylesSource, /\.dsh-au-ip-badge\.is-v4\s*\{[^}]*#2b2110[^}]*#fbbf24/);
});
