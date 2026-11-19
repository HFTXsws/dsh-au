import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 2026-10-28 截图回归：本机路径重复 LAN 地址，且只登记 LAN 的本机没有「本机」行。
const routesSource = readFileSync(new URL('../client/src/03-routes.js', import.meta.url), 'utf8');
const iconsSource = readFileSync(new URL('../client/src/05-icons.js', import.meta.url), 'utf8');
const cardsSource = readFileSync(new URL('../client/src/06-cards.js', import.meta.url), 'utf8');
const h = (type, props, ...children) => ({ type, props: props || {}, children });
const { buildManualDeviceViews, resolveCurrentAccessRoute, resolveCurrentConnection, resolveCurrentConnections, RemoteManagerModal } = new Function('h', 'useState',
  `${routesSource}\n${iconsSource}\n${cardsSource}\nreturn { buildManualDeviceViews, resolveCurrentAccessRoute, resolveCurrentConnection, resolveCurrentConnections, RemoteManagerModal };`,
)(h, (value) => [value, () => {}]);

const self = {
  deviceId: 'device-a', ips: ['192.0.2.10'], bridgePort: 31990,
  localUrl: 'http://127.0.0.1:7984/', status: 'done', statusV2: 'waiting',
};
const lan = { id: 'lan-a', type: 'lan', url: 'http://192.0.2.10:31990/' };
const local = { id: 'local-a', type: 'local' };
const remotes = [{ ...lan, originUrl: lan.url, online: true, status: 'done' }];

function nodesMatching(tree, predicate) {
  const result = [];
  const visit = (node) => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== 'object') return;
    if (predicate(node)) result.push(node);
    visit(node.children);
  };
  visit(tree);
  return result;
}

function textOf(tree) {
  if (Array.isArray(tree)) return tree.map(textOf).join('');
  if (!tree || typeof tree === 'boolean') return '';
  return typeof tree === 'object' ? textOf(tree.children) : String(tree);
}

for (const [scenario, configuredRoutes] of [
  ['已登记本机直连', [lan, local]],
  ['仅登记局域网', [lan]],
]) {
  test(`${scenario}：原 LAN 行显示本机和当前，不新增或展示回环地址`, () => {
    const definitions = [{ id: 'device-a', name: 'device-a', routes: configuredRoutes }];
    const before = structuredClone(definitions);
    const devices = buildManualDeviceViews(self, definitions, remotes);
    assert.deepEqual(devices[0].routes.map((route) => route.id).sort(), configuredRoutes.map((route) => route.id).sort());
    assert.equal(devices[0].routes.find((route) => route.kind === 'lan').originUrl, lan.url);
    assert.deepEqual(definitions, before);

    // 宿主端口已经变化也应标记原 LAN 行，不依赖截图里的旧 127 端口。
    const currentConnection = resolveCurrentConnection(devices, self, 'http://127.0.0.1:13535/');
    assert.deepEqual(currentConnection, { deviceId: 'device-a', routeId: lan.id });
    const currentConnections = currentConnection ? { [currentConnection.deviceId]: currentConnection.routeId } : {};
    const tree = RemoteManagerModal({ devices, self, lanOn: true, currentConnections });
    assert.equal(nodesMatching(tree, (node) => node.props.className?.startsWith('dsh-au-dot ')).length, 1);
    const rows = nodesMatching(tree, (node) => node.props.className === 'dsh-au-remote-row dsh-au-remote-route');
    assert.equal(rows.length, 1);
    assert.ok(textOf(rows[0]).includes('本机'));
    assert.ok(textOf(rows[0]).includes('当前'));
    assert.ok(textOf(rows[0]).includes(lan.url));
    assert.ok(!textOf(rows[0]).includes('局域网'));
    assert.ok(!textOf(tree).includes('127.0.0.1'));
    assert.equal(nodesMatching(tree, (node) => node.props['aria-label'] === '当前正在使用的连接路径').length, 1);
    assert.ok(textOf(tree).includes('1 条连接路径'));
  });
}

test('其它设备保留 LAN 选路，并隐藏仅本机可用的直连路径', () => {
  const remoteLan = { id: 'lan-win', type: 'lan', url: 'http://192.0.2.19:31990/' };
  const definitions = [{ id: 'win', name: 'win', routes: [remoteLan, { id: 'local-win', type: 'local' }] }];
  const runtime = [{ ...remoteLan, online: true, status: 'busy' }];
  const devices = buildManualDeviceViews(self, definitions, runtime);
  assert.equal(devices[0].selectedRoute.id, remoteLan.id);
  assert.equal(devices[0].targetUrl, remoteLan.url);
  assert.equal(devices[0].routes.find((route) => route.kind === 'local').online, false);
  const rows = nodesMatching(RemoteManagerModal({ devices, self, lanOn: true }),
    (node) => node.props.className === 'dsh-au-remote-row dsh-au-remote-route');
  assert.equal(rows.length, 1);
  assert.ok(textOf(rows[0]).includes(remoteLan.url));
  assert.ok(!textOf(rows[0]).includes('127.0.0.1'));
});

test('从 LAN 或公网访问宿主时，不将宿主回环地址作为可复制路径', () => {
  for (const [href, accessRemotes] of [
    ['http://192.0.2.10:31990/', remotes],
    ['https://ipv6.example:8443/dsh/', [{ originUrl: 'https://ipv6.example:8443/dsh/', transport: 'ipv6' }]],
    ['https://unregistered.example/', []],
  ]) {
    const accessTransport = resolveCurrentAccessRoute(accessRemotes, href).transport;
    const [device] = buildManualDeviceViews(self, [{ id: 'device-a', name: 'device-a', routes: [lan, local] }], remotes, accessTransport);
    const localRoute = device.routes.find((route) => route.kind === 'local');
    assert.equal(localRoute.originUrl, '', accessTransport);
    assert.equal(localRoute.url, '', accessTransport);
    assert.equal(device.targetUrl, lan.url);
    const tree = RemoteManagerModal({ devices: [device], self, lanOn: true,
      currentConnections: {} });
    const rows = nodesMatching(tree, (node) => node.props.className === 'dsh-au-remote-row dsh-au-remote-route');
    assert.equal(rows.length, 1);
    assert.ok(textOf(rows[0]).includes('局域网'));
    assert.ok(!textOf(tree).includes('127.0.0.1'));
  }
});

// 每台设备分别标记当前通路；已有保活记录不被重新算出的优选路径覆盖。
test('三台设备同时在各自当前连接旁显示标签，而非只标一个全局当前设备', () => {
  const definitions = [{ id: 'device-a', name: 'device-a', routes: [lan] },
    ...['mac', 'win'].map((id) => ({ id, name: id, routes: [
      { id: `lan-${id}`, type: 'lan', url: `http://${id}.local:31990/` },
      { id: `tunnel-${id}`, type: 'tunnel', url: `https://${id}.example/` },
    ] })),
  ];
  const runtime = [...remotes, ...['mac', 'win'].flatMap((id) => [
    { id: `lan-${id}`, online: false, status: 'offline' },
    { id: `tunnel-${id}`, online: true, status: 'busy', proxyUrl: `http://127.0.0.1:13535/remote/${id}/` },
  ])];
  const devices = buildManualDeviceViews(self, definitions, runtime);
  const currentConnections = resolveCurrentConnections(devices, self, 'http://127.0.0.1:13535/');
  assert.deepEqual(currentConnections, { mac: 'tunnel-mac', win: 'tunnel-win', 'device-a': lan.id });
  const tree = RemoteManagerModal({ devices, self, lanOn: true, currentConnections });
  const rows = nodesMatching(tree, (node) => node.props.className === 'dsh-au-remote-row dsh-au-remote-route');
  const marked = rows.filter((row) => textOf(row).includes('当前'));
  assert.equal(marked.length, 3);
  for (const url of [lan.url, 'https://mac.example/', 'https://win.example/']) {
    assert.equal(marked.filter((row) => textOf(row).includes(url)).length, 1);
  }
  assert.equal(nodesMatching(tree, (node) => node.props.className?.startsWith('dsh-au-dot ')).length, 3);
  assert.ok(!textOf(tree).includes('127.0.0.1'));
});

test('设备没有已打开连接且全部路径离线时，不将离线路径误标为当前', () => {
  const devices = buildManualDeviceViews(self, [{ id: 'win', name: 'win', routes: [
    { id: 'lan-win', type: 'lan', url: 'http://win.local:31990/' },
  ] }], []);
  const currentConnections = resolveCurrentConnections(devices, self, 'http://127.0.0.1:13535/');
  const tree = RemoteManagerModal({ devices, self, lanOn: true, currentConnections });
  assert.equal(nodesMatching(tree, (node) => node.props['aria-label'] === '当前正在使用的连接路径').length, 0);
});

// 单条通路匹配仍保留子路径、保活 URL 和未知入口回归。
for (const [scenario, href, activeDeviceId, openedRouteId, expected, openedRouteUrl = ''] of [
  ['本机查看原 LAN 行', 'http://127.0.0.1:7984/', null, '', { deviceId: 'device-a', routeId: lan.id }],
  ['局域网入口', lan.url, null, '', { deviceId: 'device-a', routeId: lan.id }],
  ['同域名的子路径入口', 'https://remote.example/dsh/session?id=1', null, '', { deviceId: 'device-a', routeId: 'ipv6-a' }],
  ['已打开远端路径不同于最新优选', 'http://127.0.0.1:7984/', 'win', 'tunnel-win', { deviceId: 'win', routeId: 'tunnel-win' }],
  ['保活 URL 不跟随重新选中的 ID', 'http://127.0.0.1:7984/', 'win', 'lan-win', { deviceId: 'win', routeId: 'tunnel-win' }, 'http://127.0.0.1:32001/'],
  ['未登记公网入口', 'https://unknown.example/', null, '', null],
]) {
  test(`${scenario}：仅实际使用的路径显示「当前」`, () => {
    const definitions = [
      { id: 'device-a', name: 'device-a', routes: [local, lan,
        { id: 'tunnel-a', type: 'tunnel', url: 'https://remote.example/' },
        { id: 'ipv6-a', type: 'ipv6', url: 'https://remote.example/dsh/' },
      ] },
      { id: 'win', name: 'win', routes: [
        { id: 'lan-win', type: 'lan', url: 'http://192.0.2.19:31990/' },
        { id: 'tunnel-win', type: 'tunnel', url: 'https://win.example/' },
      ] },
    ];
    const devices = buildManualDeviceViews(self, definitions, [
      ...remotes,
      { id: 'lan-win', online: true, status: 'idle' },
      { id: 'tunnel-win', online: true, status: 'idle', proxyUrl: 'http://127.0.0.1:32001/', originUrl: 'https://win.example/' },
    ]);
    // 优选 LAN 与已打开 tunnel 故意不同，避免标签误跟随后台排序。
    const currentConnection = resolveCurrentConnection(devices, self, href, activeDeviceId, openedRouteId, openedRouteUrl);
    assert.deepEqual(currentConnection, expected);
    const currentConnections = currentConnection ? { [currentConnection.deviceId]: currentConnection.routeId } : {};
    const tree = RemoteManagerModal({ devices, self, lanOn: true, currentConnections });
    const markers = nodesMatching(tree, (node) => node.props['aria-label'] === '当前正在使用的连接路径');
    assert.equal(markers.length, expected ? 1 : 0);
    if (expected) {
      assert.equal(textOf(markers[0]), '当前');
      const rows = nodesMatching(tree, (node) => node.props.className === 'dsh-au-remote-row dsh-au-remote-route');
      const markedRows = rows.filter((row) => textOf(row).includes('当前'));
      assert.equal(markedRows.length, 1);
      const expectedRoute = devices.find((device) => device.id === expected.deviceId).routes.find((route) => route.id === expected.routeId);
      assert.ok(textOf(markedRows[0]).includes(expectedRoute.originUrl));
    }
  });
}
