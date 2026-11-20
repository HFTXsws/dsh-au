import './isolate-net-log.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createRemoteProxyPool } from '../lib/remote-proxy-pool.js';
import { createLanBridge } from '../lib/lan-bridge.js';
import { hashLanPassword } from '../lib/lan-auth.js';

// P1 regression: a foreign local webpage must not borrow the proxy's Basic/Cookie session.
async function listen(handler) {
  const server = http.createServer(handler);
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    server,
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function request(url, { method = 'GET', headers = {}, body = '', upgrade = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, agent: false }, (res) => {
      let received = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { received += chunk; });
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: received }));
    });
    if (upgrade) req.once('upgrade', (res, socket) => {
      socket.on('error', () => {});
      socket.destroy();
      resolve({ status: res.statusCode, headers: res.headers, body: '' });
    });
    req.setTimeout(2000, () => req.destroy(new Error('test HTTP request timed out')));
    req.once('error', reject);
    req.end(body);
  });
}

async function withRemote(run, { injectOrigins = true } = {}) {
  let upstream;
  let main;
  let pool;
  let proxyServer;
  const calls = [];
  try {
    upstream = await listen((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        calls.push({ path: req.url, method: req.method, headers: req.headers, body });
        // Upstream permissive CORS must not override the local proxy policy or poison its cache.
        res.writeHead(200, {
          'content-type': 'text/plain',
          'set-cookie': 'remote_session=server-secret; SameSite=Strict; Secure',
          'access-control-allow-origin': '*',
          'access-control-allow-credentials': 'true',
          vary: 'Accept-Encoding',
        });
        res.end('remote business response');
      });
    });
    upstream.server.on('upgrade', (req, socket) => {
      calls.push({ path: req.url, method: 'UPGRADE', headers: req.headers });
      const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    });
    main = await listen((_req, res) => res.end('trusted main DSH'));
    let allowedOrigins = [main.origin, `http://localhost:${new URL(main.origin).port}`, `http://[::1]:${new URL(main.origin).port}`];
    pool = createRemoteProxyPool(injectOrigins ? { getAllowedOrigins: () => allowedOrigins } : {});
    const entry = await pool.ensureProxy({
      id: 'origin-security', url: `${upstream.origin}/dsh/`, username: 'test-user', password: 'test-password',
    });
    proxyServer = entry.server;
    const proxyOrigin = `http://127.0.0.1:${entry.port}`;
    await run({ calls, mainOrigin: main.origin, proxyOrigin, entry, upstreamOrigin: upstream.origin,
      setAllowedOrigins(value) { allowedOrigins = value; } });
  } finally {
    const proxyClosed = proxyServer?.listening ? new Promise((resolve) => proxyServer.once('close', resolve)) : Promise.resolve();
    pool?.stopAll();
    await proxyClosed;
    if (main) await main.close();
    if (upstream) await upstream.close();
  }
}

function assertCors(response, origin) {
  assert.equal(response.headers['access-control-allow-origin'], origin);
  assert.equal(response.headers['access-control-allow-credentials'], origin ? 'true' : undefined);
  assert.ok(response.headers.vary?.split(/,\s*/).some((value) => value.toLowerCase() === 'origin'), 'CORS responses vary by Origin');
}

function assertDenied(response, calls, before) {
  // Check the upstream side effect first: suppressing CORS alone does not prevent writes.
  assert.equal(calls.length, before, 'denied request must not reach upstream with credentials or business data');
  assert.equal(response.status, 403);
  assertCors(response, undefined);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.doesNotMatch(response.body, /remote business response|server-secret|test-password/);
}

test('foreign and opaque Origins are rejected for preflight, reads and writes before upstream credentials', { timeout: 15000 }, async () => {
  await withRemote(async ({ calls, entry, proxyOrigin, mainOrigin }) => {
    entry.cookieJar.capture('remote_session=server-secret');
    const otherPort = Number(new URL(mainOrigin).port) === 1 ? 2 : 1;
    const origins = [
      `http://127.0.0.1:${otherPort}`, `http://localhost:${otherPort}`, 'http://[::1]:1',
      'https://attacker.example', 'null', '', `${mainOrigin}/path`, `${mainOrigin}.attacker.example`,
    ];
    for (const origin of origins) {
      for (const method of ['POST', 'GET', 'OPTIONS']) {
        const before = calls.length;
        const response = await request(`${proxyOrigin}/dsh/api/change`, {
          method, headers: { origin, 'content-type': 'application/json',
            ...(method === 'OPTIONS' ? { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } : {}) },
          body: method === 'POST' ? '{"change":"forbidden"}' : '',
        });
        assertDenied(response, calls, before);
      }
    }
    const before = calls.length;
    const forgedHost = await request(`${proxyOrigin}/api/change`, {
      headers: { origin: 'https://attacker.example', host: 'attacker.example' },
    });
    assertDenied(forgedHost, calls, before);
  });
});

test('explicit main DSH and proxy iframe Origins retain authenticated HTTP and navigation compatibility', { timeout: 10000 }, async () => {
  await withRemote(async ({ calls, proxyOrigin, mainOrigin, upstreamOrigin }) => {
    for (const origin of [mainOrigin, `http://localhost:${new URL(mainOrigin).port}`, `http://[::1]:${new URL(mainOrigin).port}`,
      proxyOrigin, `http://localhost:${new URL(proxyOrigin).port}`, `http://[::1]:${new URL(proxyOrigin).port}`, undefined]) {
      const headers = origin === undefined ? {} : { origin };
      const before = calls.length;
      if (origin) {
        const preflight = await request(`${proxyOrigin}/api/change`, {
          method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
        });
        assert.equal(preflight.status, 204);
        assertCors(preflight, origin);
        assert.equal(calls.length, before, 'preflight remains local');
      }
      const response = await request(`${proxyOrigin}/api/change`, {
        method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body: 'allowed change',
      });
      assert.equal(response.status, 200);
      assertCors(response, origin);
      assert.ok(response.headers.vary.includes('Accept-Encoding'));
      assert.equal(calls.at(-1).path, '/dsh/api/change');
      assert.equal(calls.at(-1).body, 'allowed change');
      assert.equal(calls.at(-1).headers.authorization, `Basic ${Buffer.from('test-user:test-password').toString('base64')}`);
      if (origin) assert.equal(calls.at(-1).headers.origin, upstreamOrigin);
    }
    const navigation = await request(`${proxyOrigin}/dsh/`, { headers: { 'sec-fetch-mode': 'navigate' } });
    assert.equal(navigation.status, 200);
    assert.equal(calls.at(-1).headers.cookie, 'remote_session=server-secret');
  });
});

test('asset cache cannot bypass Origin denial or reuse another callers CORS grant', { timeout: 10000 }, async () => {
  await withRemote(async ({ calls, proxyOrigin, mainOrigin, setAllowedOrigins }) => {
    const url = `${proxyOrigin}/assets/security.abc123.js`;
    assertDenied(await request(url, { headers: { origin: 'https://attacker.example' } }), calls, 0);
    const first = await request(url, { headers: { origin: mainOrigin } });
    assert.equal(calls.length, 1, 'denied cold-cache request cannot populate the asset cache');
    assert.equal(first.status, 200);
    assertCors(first, mainOrigin);
    const before = calls.length;
    const denied = await request(url, { headers: { origin: 'https://attacker.example' } });
    assertDenied(denied, calls, before);
    for (const origin of [proxyOrigin, undefined, mainOrigin]) {
      const cached = await request(url, { headers: origin ? { origin } : {} });
      assert.equal(cached.body, first.body);
      assertCors(cached, origin);
      assert.equal(calls.length, before, 'compatible caller still gets a real asset-cache hit');
    }
    setAllowedOrigins([]);
    assertDenied(await request(url, { headers: { origin: mainOrigin } }), calls, before);
  });
});

test('omitting trusted-Origin injection fails closed for cross-origin callers, not own iframe or server calls', { timeout: 10000 }, async () => {
  await withRemote(async ({ calls, proxyOrigin, mainOrigin }) => {
    assertDenied(await request(`${proxyOrigin}/api/change`, { headers: { origin: mainOrigin } }), calls, 0);
    for (const origin of [proxyOrigin, `http://localhost:${new URL(proxyOrigin).port}`, `http://[::1]:${new URL(proxyOrigin).port}`, undefined]) {
      const response = await request(`${proxyOrigin}/`, { headers: origin ? { origin } : {} });
      assert.equal(response.status, 200);
      assertCors(response, origin);
    }
  }, { injectOrigins: false });
});

test('WebSocket entry shares Origin authorization before the Basic/Cookie upgrade', { timeout: 10000 }, async () => {
  await withRemote(async ({ calls, entry, proxyOrigin, mainOrigin }) => {
    entry.cookieJar.capture('remote_session=server-secret');
    for (const origin of ['http://127.0.0.1:1', 'null', mainOrigin, proxyOrigin,
      `http://localhost:${new URL(proxyOrigin).port}`, `http://[::1]:${new URL(proxyOrigin).port}`, undefined]) {
      const before = calls.length;
      const response = await request(`${proxyOrigin}/socket`, { upgrade: true, headers: {
        connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...(origin ? { origin } : {}),
      } });
      if (origin === 'null' || origin === 'http://127.0.0.1:1') {
        assert.equal(calls.length, before, 'untrusted upgrade never sends Basic/Cookie upstream');
        assert.equal(response.status, 403);
      } else {
        assert.equal(response.status, 101);
        assert.equal(calls.at(-1).headers.cookie, 'remote_session=server-secret');
        assert.ok(calls.at(-1).headers.authorization.startsWith('Basic '));
      }
    }
  });
});

test('LAN bridge rejects foreign Origins before auth bootstrap while keeping direct and server navigation', { timeout: 10000 }, async () => {
  let upstream;
  let bridge;
  let allowedOrigins = [];
  const calls = [];
  const lanPasswordHash = hashLanPassword('bridge-pass');
  const lanAuth = { authorization: `Basic ${Buffer.from('u:bridge-pass').toString('base64')}` };
  try {
    upstream = await listen((req, res) => {
      calls.push({ path: req.url, cookie: req.headers.cookie, authorization: req.headers.authorization });
      if (req.url === '/bootstrap') res.setHeader('set-cookie', 'browser_session=lan-secret; SameSite=Strict');
      res.end('LAN business response');
    });
    bridge = createLanBridge({
      instanceId: 'security-test', preferredPort: 0, getLanShareEnabled: () => true,
      getLanPasswordHash: () => lanPasswordHash,
      getLocalDshTarget: () => ({ origin: upstream.origin, authUrl: `${upstream.origin}/bootstrap` }),
      getAllowedOrigins: () => allowedOrigins,
      getStatus: () => ({ status: 'idle', runningCount: 0 }),
    });
    const port = await bridge.start();
    assert.ok(port > 0);
    const origin = `http://127.0.0.1:${port}`;
    const mainLocalhost = `http://localhost:${new URL(upstream.origin).port}`;
    const registeredBridgeOrigin = `http://registered-bridge.example:${port}`;
    allowedOrigins = [mainLocalhost, 'https://registered-main.example', registeredBridgeOrigin];
    for (const source of ['http://127.0.0.1:1', 'null']) {
      for (const method of ['POST', 'GET', 'OPTIONS']) {
        assertDenied(await request(`${origin}/api/change`, {
          method, headers: { origin: source, 'access-control-request-method': 'POST' },
        }), calls, 0);
      }
      assertDenied(await request(`${origin}/socket`, { upgrade: true, headers: {
        origin: source, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      } }), calls, 0);
    }
    const ping = await request(`${origin}/__dsh_au_ping`, { headers: { origin: 'https://attacker.example' } });
    assert.equal(JSON.parse(ping.body).dshAu, true, 'public discovery endpoint stays non-credentialed');
    assert.equal(calls.length, 0);
    for (const source of [mainLocalhost, registeredBridgeOrigin, 'https://registered-main.example',
      origin, `http://localhost:${port}`, `http://[::1]:${port}`, undefined, upstream.origin]) {
      const response = await request(`${origin}/chat`, { headers: source ? { origin: source, ...lanAuth } : lanAuth });
      assert.equal(response.status, 200);
      // 局域网接入密码只在桥接层校验，不转发给本机 DSH。
      assert.equal(calls.at(-1).authorization, undefined);
      assertCors(response, source);
      assert.equal(calls.at(-1).cookie, 'browser_session=lan-secret');
    }
    assert.equal(calls.filter((call) => call.path === '/bootstrap').length, 1);
    const before = calls.length;
    allowedOrigins = [];
    assertDenied(await request(`${origin}/chat`, { headers: { origin: registeredBridgeOrigin } }), calls, before);
    assertDenied(await request(`${origin}/chat`, { headers: { origin: `http://localhost:${port + 1}`, host: `localhost:${port + 1}` } }), calls, before);
  } finally {
    bridge?.stop();
    if (upstream) await upstream.close();
  }
});

test('rejects absolute-form and protocol-relative proxy targets with 400 without leaking credentials while forwarding normal paths', { timeout: 10000 }, async () => {
  await withRemote(async ({ calls, entry, proxyOrigin, mainOrigin }) => {
    entry.cookieJar.capture('remote_session=server-secret');
    const proxyUrl = new URL(proxyOrigin);
    const sendRawPath = (path, { upgrade = false } = {}) => new Promise((resolve, reject) => {
      const req = http.request({
        hostname: proxyUrl.hostname,
        port: Number(proxyUrl.port),
        method: 'GET',
        path,
        headers: {
          origin: mainOrigin,
          ...(upgrade ? {
            connection: 'Upgrade',
            upgrade: 'websocket',
            'sec-websocket-version': '13',
            'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          } : {}),
        },
        agent: false,
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.once('error', reject);
        res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.once('upgrade', (res, socket) => {
        socket.destroy();
        resolve({ status: res.statusCode, headers: res.headers, body: '' });
      });
      req.setTimeout(2000, () => req.destroy(new Error('test HTTP request timed out')));
      req.once('error', reject);
      req.end();
    });

    for (const badTarget of [
      'http://evil.example/secret',
      'https://evil.example/secret',
      'ws://evil.example/socket',
      'wss://evil.example/socket',
      '//evil.example/secret',
      '/\\evil.example/secret',
    ]) {
      const before = calls.length;
      const httpRes = await sendRawPath(badTarget);
      assert.equal(httpRes.status, 400, `HTTP ${badTarget} must be rejected with 400`);
      assert.equal(calls.length, before, `HTTP ${badTarget} must not reach upstream`);
      assert.doesNotMatch(httpRes.body, /test-password|server-secret/);

      const wsRes = await sendRawPath(badTarget, { upgrade: true });
      assert.equal(wsRes.status, 400, `Upgrade ${badTarget} must be rejected with 400`);
      assert.equal(calls.length, before, `Upgrade ${badTarget} must not reach upstream`);
    }

    for (const [reqPath, expectedUpstreamPath] of [
      ['/dsh/', '/dsh/'],
      ['/assets/app.js', '/dsh/assets/app.js'],
      ['/plugins/??a', '/dsh/plugins/??a'],
      ['/connect?token=1', '/dsh/connect?token=1'],
    ]) {
      const res = await sendRawPath(reqPath);
      assert.equal(res.status, 200);
      assert.equal(calls.at(-1).path, expectedUpstreamPath);
    }
  });
});
