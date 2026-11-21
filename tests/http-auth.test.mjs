import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { getConnectionRejection } from '../lib/http-auth.js';
import { apply } from '../lib/index.js';
import { registerTodoRoutes } from '../lib/todo/index.js';

function createMockRes() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(chunk = '') {
      this.body += typeof chunk === 'string' ? chunk : String(chunk || '');
    },
  };
}

test('getConnectionRejection calls ctx.get("connection").requestRejection or falls back safely', () => {
  const req = { headers: { origin: 'https://evil.example' } };
  assert.equal(getConnectionRejection(null, req), undefined);
  assert.equal(getConnectionRejection({}, req), undefined);

  const viaGet = {
    get(name) {
      return name === 'connection' ? { requestRejection: (r) => (r === req ? 403 : undefined) } : undefined;
    },
  };
  assert.equal(getConnectionRejection(viaGet, req), 403);

  const viaProp = {
    connection: { requestRejection: () => 401 },
  };
  assert.equal(getConnectionRejection(viaProp, req), 401);
});

test('apply(ctx) enforces ctx.connection.requestRejection on /dsh-au/connect, /dsh-au/api and /dsh-au-todo/api', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-http-auth-'));
  const envPatch = {
    DSH_HOME: dir,
    DSH_AU_LOCAL_DIR: join(dir, 'local'),
    DSH_AU_CLOUD_MANIFEST_PATH: join(dir, 'cloud.json'),
    DSH_AU_DISABLE_AUTO_START: '1',
  };
  const previous = Object.fromEntries(Object.keys(envPatch).map((key) => [key, process.env[key]]));
  Object.assign(process.env, envPatch);
  writeFileSync(envPatch.DSH_AU_CLOUD_MANIFEST_PATH, JSON.stringify({ schemaVersion: 1, services: {}, devices: [], plugins: {} }));

  t.mock.method(http.Server.prototype, 'listen', function (...args) {
    this.address = () => ({ port: 49102 });
    this.close = () => this;
    queueMicrotask(() => args.at(-1)?.());
    return this;
  });
  t.mock.method(dgram, 'createSocket', () => Object.assign(new EventEmitter(), {
    bind(_port, ready) { ready?.(); },
    setBroadcast() {},
    send() {},
    close() {},
  }));
  t.mock.method(childProcess, 'spawn', () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: Object.assign(new EventEmitter(), { setEncoding() {} }),
      stderr: new EventEmitter(),
      kill() {},
    });
    queueMicrotask(() => {
      child.stdout.emit('data', '{"services":[]}');
      child.emit('close', 0);
    });
    return child;
  });
  syncBuiltinESMExports();

  const routes = new Map();
  const cleanups = [];
  let currentRejection;
  const conn = {
    requestRejection: () => currentRejection,
  };
  const webServer = {
    port: 0,
    register(route) {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
  };
  const ctx = {
    webServer,
    get(name) {
      if (name === 'connection') return conn;
      if (name === 'webServer') return webServer;
      return undefined;
    },
    on() {},
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') cleanups.push(dispose);
      return dispose;
    },
    inject(deps, fn) {
      if (!Array.isArray(deps) || !deps.includes('webServer')) return () => {};
      const dispose = fn(ctx);
      if (typeof dispose === 'function') cleanups.push(dispose);
      return dispose;
    },
  };

  t.after(() => {
    for (const fn of cleanups.reverse()) {
      try { fn(); } catch {}
    }
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  apply(ctx);
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(routes.has('/dsh-au/connect'));
  assert.ok(routes.has('/dsh-au/api'));
  assert.ok(routes.has('/dsh-au-todo/api'));

  for (const status of [401, 403]) {
    currentRejection = status;

    const connectRes = createMockRes();
    await routes.get('/dsh-au/connect')({ method: 'POST', headers: {} }, connectRes);
    assert.equal(connectRes.statusCode, status);

    const apiRes = createMockRes();
    await routes.get('/dsh-au/api')({ method: 'GET', headers: {} }, apiRes);
    assert.equal(apiRes.statusCode, status);
    assert.equal(JSON.parse(apiRes.body).ok, false);

    const todoRes = createMockRes();
    await routes.get('/dsh-au-todo/api')({ method: 'POST', headers: {} }, todoRes);
    assert.equal(todoRes.statusCode, status);
    assert.equal(JSON.parse(todoRes.body).ok, false);
  }

  currentRejection = undefined;
  const allowedConnectRes = createMockRes();
  await routes.get('/dsh-au/connect')({ method: 'GET', headers: {} }, allowedConnectRes);
  assert.equal(allowedConnectRes.statusCode, 405);

  const allowedApiRes = createMockRes();
  await routes.get('/dsh-au/api')({ method: 'DELETE', headers: {} }, allowedApiRes);
  assert.equal(allowedApiRes.statusCode, 405);

  const allowedTodoRes = createMockRes();
  await routes.get('/dsh-au-todo/api')({ method: 'GET', headers: {} }, allowedTodoRes);
  assert.notEqual(allowedTodoRes.statusCode, 401);
  assert.notEqual(allowedTodoRes.statusCode, 403);
});

test('registerTodoRoutes rejects unauthorized requests even before feature-enabled check', async () => {
  let handler = null;
  const dispose = registerTodoRoutes({
    server: {
      register(route) {
        handler = route.handler;
        return () => {};
      },
    },
    bridge: {},
    isEnabled: () => false,
    checkRequest: () => 403,
  });
  try {
    const res = createMockRes();
    await handler({ method: 'POST', headers: {} }, res);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'Forbidden' });
  } finally {
    dispose();
  }
});
