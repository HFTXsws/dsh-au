import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRemoteProxyPool } from '../lib/remote-proxy-pool.js';
import { createRuntimeBridge } from '../lib/runtime-bridge.js';
import { createRemoteModelShortcuts } from '../lib/remote-model-shortcuts.js';

const temp = mkdtempSync(join(tmpdir(), 'dsh-au-remote-model-shortcuts-'));
const manifestPath = join(temp, 'manifest.cloud.json');
const previousManifestPath = process.env.DSH_AU_CLOUD_MANIFEST_PATH;
process.env.DSH_AU_CLOUD_MANIFEST_PATH = manifestPath;
after(() => {
  if (previousManifestPath === undefined) delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
  else process.env.DSH_AU_CLOUD_MANIFEST_PATH = previousManifestPath;
  rmSync(temp, { recursive: true, force: true });
});

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

function writeManifest(devices) {
  writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, devices, services: {}, plugins: {} }), 'utf8');
}

function makeRemote(route, deviceId) {
  return {
    id: route.id,
    deviceId,
    url: route.url,
    transport: route.type,
    username: '',
    password: '',
  };
}

async function makeBridge(devices, t) {
  writeManifest(devices);
  const remotes = devices.flatMap((device) => (device.routes || [])
    .filter((route) => route.type !== 'local')
    .map((route) => makeRemote(route, device.id)));
  const remotePool = createRemoteProxyPool();
  t.after(() => remotePool.stopAll());
  await remotePool.syncRemotes(remotes);
  const config = { remotes };
  const runtimeBridge = createRuntimeBridge({
    ctx: {},
    getConfig: () => config,
    remotePool,
    statusTracker: {
      getSessionStatus: () => 'idle',
      confirm() {},
    },
    getLocalHostInfo: () => ({ hostname: 'test-host', ips: [] }),
  });
  return { config, runtimeBridge, shortcuts: createRemoteModelShortcuts({ runtimeBridge }) };
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function sendNative(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// 回归：远程模型快捷键报告“无效”时，必须验证真实 /api envelope，而不是调用 REST 直路径。
test('远端目录使用精确 client-request envelope、脱敏字段且不伪装 current', { timeout: 5000 }, async (t) => {
  const requests = [];
  const upstream = await listen(t, async (req, res) => {
    const body = await readBody(req);
    requests.push({ path: req.url, body });
    if (body.method === 'session/modelCatalog') {
      sendNative(res, {
        type: 'server-response',
        rpcId: body.rpcId,
        result: {
          ok: true,
          value: {
            default: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' },
            current: { provider: 'private-provider', model: 'private-model' },
            groups: [{
              id: 'provider-a',
              name: 'Provider A',
              models: [{
                id: 'model-a',
                name: 'Model A',
                description: 'private-description',
                reasoning: {
                  efforts: [{ id: 'high', name: 'High', description: 'private-effort-description' }],
                  defaultEffort: 'high',
                },
                apiKey: 'private-api-key',
              }],
            }],
            failures: [{ id: 'private', name: 'Private', message: 'private-failure' }],
            secret: 'private-secret',
          },
        },
      });
      return;
    }
    sendNative(res, { type: 'server-response', rpcId: body.rpcId, result: { ok: false } }, 404);
  });
  const device = { id: 'device-a', name: 'Device A', routes: [{ id: 'route-a', type: 'tunnel', url: upstream.url }] };
  const { shortcuts } = await makeBridge([device], t);
  const result = await shortcuts.getRemoteModelCatalog({ deviceId: 'device-a', routeId: 'route-a' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.catalog, {
    groups: [{
      id: 'provider-a',
      name: 'Provider A',
      models: [{
        id: 'model-a',
        name: 'Model A',
        reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' },
      }],
    }],
    default: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' },
    current: null,
  });
  assert.doesNotMatch(JSON.stringify(result), /private-(?:description|provider|model|api-key|failure|secret)/u);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/api');
  assert.equal(requests[0].body.type, 'client-request');
  assert.match(requests[0].body.rpcId, /^[0-9a-f-]{36}$/u);
  assert.equal(requests[0].body.method, 'session/modelCatalog');
  assert.deepEqual(requests[0].body.payload, { args: {} });
});

test('选模只向指定 route 发送严格参数，跨设备 route、local route、未知设备和缺少 sessionId 均拒绝', { timeout: 5000 }, async (t) => {
  const calls = [];
  const upstream = await listen(t, async (req, res) => {
    const body = await readBody(req);
    calls.push({ path: req.url, body });
    sendNative(res, {
      type: 'server-response',
      rpcId: body.rpcId,
      result: { ok: true, value: { selected: { provider: 'azure-full', model: 'azure-gpt-generic', reasoningEffort: 'high' } } },
    });
  });
  const other = await listen(t, async (req, res) => {
    await readBody(req);
    sendNative(res, { type: 'server-response', result: { ok: false } }, 500);
  });
  const devices = [
    { id: 'device-a', name: 'Device A', routes: [
      { id: 'route-a', type: 'tunnel', url: upstream.url },
      { id: 'local-a', type: 'local' },
    ] },
    { id: 'device-b', name: 'Device B', routes: [{ id: 'route-b', type: 'tunnel', url: other.url }] },
  ];
  const { shortcuts } = await makeBridge(devices, t);

  const crossDevice = await shortcuts.getRemoteModelCatalog({ deviceId: 'device-a', routeId: 'route-b' });
  assert.equal(crossDevice.ok, false);
  assert.equal(crossDevice.status, 400);
  assert.match(crossDevice.error, /不属于目标设备/u);
  assert.equal(calls.length, 0);

  const local = await shortcuts.getRemoteModelCatalog({ deviceId: 'device-a', routeId: 'local-a' });
  assert.equal(local.ok, false);
  assert.equal(local.status, 400);
  assert.match(local.error, /local route/u);

  const unknown = await shortcuts.getRemoteModelCatalog({ deviceId: 'missing-device', routeId: 'route-a' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.status, 400);

  const missingSession = await shortcuts.selectRemoteModel({
    deviceId: 'device-a',
    routeId: 'route-a',
    selection: { provider: 'azure-full', model: 'azure-gpt-generic', reasoningEffort: 'high' },
  });
  assert.equal(missingSession.ok, false);
  assert.equal(missingSession.status, 400);
  assert.match(missingSession.error, /sessionId/u);
  assert.equal(calls.length, 0);

  const selected = await shortcuts.selectRemoteModel({
    deviceId: 'device-a',
    routeId: 'route-a',
    sessionId: 'session-visible-in-frame',
    selection: {
      provider: 'azure-full',
      model: 'azure-gpt-generic',
      reasoningEffort: 'high',
      ignored: 'must-not-pass',
    },
  });
  assert.equal(selected.ok, false);
  assert.equal(selected.status, 400);
  assert.equal(calls.length, 0);

  const success = await shortcuts.selectRemoteModel({
    deviceId: 'device-a',
    routeId: 'route-a',
    sessionId: 'session-visible-in-frame',
    selection: { provider: 'azure-full', model: 'azure-gpt-generic', reasoningEffort: 'high' },
  });
  assert.deepEqual(success, {
    ok: true,
    selected: { provider: 'azure-full', model: 'azure-gpt-generic', reasoningEffort: 'high' },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api');
  assert.equal(calls[0].body.method, 'session/selectModel');
  assert.deepEqual(calls[0].body.payload.args.request, {
    sessionId: 'session-visible-in-frame',
    provider: 'azure-full',
    model: 'azure-gpt-generic',
    reasoningEffort: 'high',
  });
  assert.deepEqual(Object.keys(calls[0].body.payload.args.request).sort(), ['model', 'provider', 'reasoningEffort', 'sessionId']);
});

test('exact route failure does not fail over to another route and 404/405 is unsupported without model fallback', { timeout: 5000 }, async (t) => {
  let failedCalls = 0;
  let fallbackCalls = 0;
  const failed = await listen(t, async (_req, res) => {
    failedCalls += 1;
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'private-upstream-error-payload' }));
  });
  const fallback = await listen(t, async (_req, res) => {
    fallbackCalls += 1;
    sendNative(res, { type: 'server-response', result: { ok: true, value: { groups: [] } } });
  });
  const device = { id: 'device-multi', name: 'Multi', routes: [
    { id: 'route-failed', type: 'tunnel', url: failed.url },
    { id: 'route-fallback', type: 'tunnel', url: fallback.url },
  ] };
  const { shortcuts } = await makeBridge([device], t);
  const result = await shortcuts.getRemoteModelCatalog({ deviceId: 'device-multi', routeId: 'route-failed' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 501);
  assert.match(result.error, /不支持模型快捷切换接口/u);
  assert.equal(failedCalls, 1);
  assert.equal(fallbackCalls, 0);
  assert.doesNotMatch(JSON.stringify(result), /private-upstream-error-payload/u);
});
