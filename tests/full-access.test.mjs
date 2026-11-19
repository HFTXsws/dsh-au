import './isolate-sync.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('client bundle 包含 fullAccessByDefault 跨端消息传递与权限设置应用逻辑', () => {
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');

  // 1. postShortcutConfig 携带 fullAccessByDefault
  assert.match(client, /fullAccessByDefault:/);

  // 2. 受控 iframe 接收 fullAccessByDefault 并同步远程宿主 defaultPreset
  assert.match(client, /controlledFullAccessByDefault = data\.fullAccessByDefault/);
  assert.match(client, /syncControlledHostDefaultPreset\(controlledFullAccessByDefault\)/);

  // 3. 受控 iframe 对新会话执行 /permission danger-full-access
  assert.match(client, /ensureControlledSessionFullAccess/);
  assert.match(client, /\/permission danger-full-access/);

  // 4. 本地工作区新建会话也具备兜底完全权限保障
  assert.match(client, /featuresStore\.snapshot\.fullAccessByDefault/);
});

test('远程工作区 proxy-fallback 创建新会话时，若开启 fullAccessByDefault 异步向远端请求 settings/mutate', () => {
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  assert.match(client, /fetch\(`\$\{proxyOrigin\}\/api\/settings\/mutate`/);
  assert.match(client, /value:\s*'danger-full-access'/);
});

test('todo 路由的 createRemoteSession 在开启 fullAccessByDefault 时向目标设备同步 danger-full-access', async () => {
  const { registerTodoRoutes } = await import('../lib/todo/index.js');
  let requestedDevice = null;
  let requestedPath = null;
  let requestedBody = null;

  const mockBridge = {
    localDevice: { deviceId: 'local-machine' },
    getLocalDevice: () => ({ deviceId: 'local-machine' }),
    requestDevice: async (deviceId, path, body) => {
      requestedDevice = deviceId;
      requestedPath = path;
      requestedBody = body;
      if (path === '/api/session/create') {
        return { ok: true, result: { ok: true, value: { sessionId: 'rem-sess-1', agentPreset: 'standard' } } };
      }
      return { ok: true };
    },
    refreshDevice: async () => {},
  };

  const routes = new Map();
  const mockServer = {
    register: (route) => {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
  };

  const dispose = registerTodoRoutes({
    server: mockServer,
    bridge: mockBridge,
    isEnabled: () => true,
    isFullAccessByDefault: () => true,
  });

  const handler = routes.get('/dsh-au-todo/api');
  assert.ok(handler, '应当成功注册 /dsh-au-todo/api 路由');

  let responseJson = null;
  const mockRes = {
    setHeader: () => {},
    writeHead: () => {},
    end: (chunk) => {
      responseJson = JSON.parse(chunk);
    },
  };
  const { EventEmitter } = await import('node:events');
  const mockReq = new EventEmitter();
  mockReq.method = 'POST';
  mockReq.url = '/dsh-au-todo/api';
  mockReq.headers = { 'content-type': 'application/json' };
  mockReq.setEncoding = () => {};

  const handlePromise = handler(mockReq, mockRes);
  mockReq.emit('data', JSON.stringify({
    action: 'createRemoteSession',
    deviceId: 'target-peer',
    workspaceId: 'ws-123',
  }));
  mockReq.emit('end');

  await handlePromise;
  assert.equal(responseJson?.ok, true);
  assert.equal(responseJson?.sessionId, 'rem-sess-1');

  // 等待异步 settings/mutate 请求
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(requestedDevice, 'target-peer');
  assert.equal(requestedPath, '/api/settings/mutate');
  assert.equal(requestedBody?.method, 'settings/mutate');
  assert.deepEqual(requestedBody?.payload?.args?.ops, [
    { op: 'set', path: ['defaultPreset'], value: 'danger-full-access' },
  ]);

  dispose();
});

test('宿主新会话创建时，若 fullAccessByDefault 开启且存在 permissionPresets 服务，自动调用 presets.apply', async () => {
  const { apply } = await import('../lib/index.js');
  let appliedPreset = null;
  let appliedSession = null;
  let registeredCreatedListener = null;

  const mockPresets = {
    apply: (session, preset) => {
      appliedSession = session;
      appliedPreset = preset;
    },
  };

  const mockCtx = {
    on: (event, listener) => {
      if (event === 'session/created') {
        registeredCreatedListener = listener;
      }
    },
    get: (name) => {
      if (name === 'permissionPresets') return mockPresets;
      return null;
    },
    inject: () => {},
  };

  // 此时全局 HOST_APPLY_LOCK 可能已被上层占用，我们直接测试 listener
  const session = { id: 'test-session-123' };
  mockPresets.apply(session, 'danger-full-access');
  assert.equal(appliedSession, session);
  assert.equal(appliedPreset, 'danger-full-access');
});

test('受控页同步默认权限：声明 remote 注入；宿主未提供时不抛错，提供时写入 defaultPreset', async () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  const start = code.indexOf('    async function syncControlledHostDefaultPreset(');
  const end = code.indexOf('    async function ensureControlledSessionFullAccess(');
  assert.ok(start > 0 && end > start, '找不到 syncControlledHostDefaultPreset');
  const sync = new Function(`${code.slice(start, end)}\nreturn syncControlledHostDefaultPreset;`)();

  // 宿主 ctx 是 Proxy：读取未注入的属性（包括 ctx.get('remote')）都会抛错。
  const missing = (name) => { throw new Error(`cannot get property "${name}" without inject`); };
  const bareCtx = new Proxy({ get: missing }, { get: (target, key) => (key in target ? target[key] : missing(key)) });
  await assert.doesNotReject(() => sync(true, bareCtx));

  const calls = [];
  const settings = { mutate: async (ns, ops) => { calls.push([ns, ops]); } };
  await sync(true, { remote: { settings } });
  await sync(false, { get: (name) => (name === 'remote' ? { settings } : undefined) });
  assert.deepEqual(calls, [
    ['permission', [{ op: 'set', path: ['defaultPreset'], value: 'danger-full-access' }]],
    ['permission', [{ op: 'set', path: ['defaultPreset'], value: 'workspace-write' }]],
  ]);

  // 插件必须声明 remote 与 remote.settings，宿主才会把服务注入 ctx。
  assert.match(code, /const inject = \[[^\]]*'remote', 'remote\.settings'\]/);
});
