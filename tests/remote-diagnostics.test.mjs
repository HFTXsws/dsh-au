import './isolate-net-log.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { readNetLog, recordClientEvent, recordRouteChange } from '../lib/net-log.js';
import { createRemoteProxyPool } from '../lib/remote-proxy-pool.js';
import { proxyHttpRequest, proxyWebSocketUpgrade } from '../lib/proxy-core.js';

const events = () => readNetLog().map((line) => JSON.parse(line));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function listen(t, handler) {
  const sockets = new Set();
  const server = http.createServer(handler);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

function get(url, onHeaders) {
  return new Promise((resolve, reject) => {
    http.get(url, { agent: false, headers: { cookie: 'private_cookie_secret' } }, (res) => {
      onHeaders?.();
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

function upgrade(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, {
      agent: false,
      headers: {
        connection: 'Upgrade', upgrade: 'websocket',
        'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        cookie: 'private_cookie_secret', authorization: 'Basic private_authorization_secret',
      },
    });
    req.once('upgrade', (res, socket, head) => {
      socket.on('error', () => {});
      resolve({ status: res.statusCode, socket, head });
    });
    req.once('response', (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, socket: null }));
    });
    req.once('error', reject);
  });
}

function acceptUpgrade(req, socket) {
  const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSet-Cookie: private_cookie_secret\r\n\r\n`);
}

function remote(id, url) {
  return { id, deviceId: 'example-mac', transport: 'tunnel', url, username: 'private_username_secret', password: 'private_password_secret' };
}

function assertRedacted(recorded) {
  const raw = JSON.stringify(recorded);
  assert.doesNotMatch(raw, /private_(?:query|cookie|authorization|username|password|body|header)_secret/);
  assert.doesNotMatch(raw, /closeCode|authorization|set-cookie|errorMessage/);
}

test('unprobed route remains manually connectable without pretending idle, then exposes completed probe', { timeout: 5000 }, async (t) => {
  // 2026-10-28: 启动假 idle 导致误选 LAN，预加载必须有真实探测依据。
  const upstream = await listen(t, (req, res) => {
    res.end(req.url.endsWith('/dsh-au/api') ? JSON.stringify({ self: { status: 'busy' } }) : 'home');
  });
  const pool = createRemoteProxyPool();
  t.after(() => pool.stopAll());
  const configured = { ...remote('probe-completion', upstream.origin), proxyUrl: upstream.origin };
  const [initial] = await pool.syncRemotes([configured]);
  assert.match(initial.proxyUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(initial.upstreamProxyUrl, configured.proxyUrl);
  assert.equal(initial.status, 'unknown');
  assert.equal(initial.online, true, '未探测仍可手动连接');
  assert.equal(initial.probeCompleted, false);
  assert.equal((await get(initial.proxyUrl)).status, 200);
  await pool.probeAll([configured]);
  const [completed] = await pool.syncRemotes([configured]);
  assert.equal(completed.status, 'busy');
  assert.equal(completed.online, true);
  assert.equal(completed.probeCompleted, true);
});

test('concurrent first snapshot and probe reuse one route and retain the completed result', { timeout: 5000 }, async (t) => {
  const upstream = await listen(t, (req, res) => {
    res.end(req.url === '/dsh-au/api' ? JSON.stringify({ self: { status: 'busy' } }) : 'home');
  });
  const pool = createRemoteProxyPool();
  t.after(() => pool.stopAll());
  const configured = remote('concurrent-probe', upstream.origin);
  const probing = pool.probeAll([configured]);
  const [first, second] = await Promise.all([pool.syncRemotes([configured]), pool.syncRemotes([configured])]);
  assert.equal(first[0].proxyUrl, second[0].proxyUrl, '并发调用不能创建两个代理端口');
  await probing;
  const [completed] = await pool.syncRemotes([configured]);
  assert.equal(completed.probeCompleted, true, '初次探测不能因代理被替换而丢弃');
  assert.equal(completed.status, 'busy');
});

test('in-place URL change resets completion and ignores late old target state and identity', { timeout: 5000 }, async (t) => {
  const entered = deferred();
  const released = deferred();
  const old = await listen(t, async (req, res) => {
    if (req.url === '/') {
      entered.resolve();
      await released.promise;
      res.end('old home');
    } else res.end(JSON.stringify({ self: { status: 'idle', instanceId: 'stale-identity' } }));
  });
  const next = await listen(t, (req, res) => {
    res.end(req.url === '/dsh-au/api' ? JSON.stringify({ self: { status: 'busy', instanceId: 'current-identity' } }) : 'new home');
  });
  const pool = createRemoteProxyPool();
  t.after(() => { released.resolve(); pool.stopAll(); });
  const configured = remote('changed-target', old.origin);
  await pool.syncRemotes([configured]);
  const pending = pool.probeAll([configured]);
  await entered.promise;
  configured.url = next.origin;
  const [reset] = await pool.syncRemotes([configured]);
  assert.equal(reset.status, 'unknown');
  assert.equal(reset.probeCompleted, false);
  await pool.probeAll([configured]);
  released.resolve();
  await pending;
  const [current] = await pool.syncRemotes([configured]);
  assert.equal(current.probeCompleted, true);
  assert.equal(current.status, 'busy');
  assert.equal(current.instanceId, 'current-identity');
  assert.equal(configured.knownIdentity.instanceId, 'current-identity');
});

test('remote HTTP failure responses and connection errors enter JSONL without successful-resource noise or secrets', { timeout: 5000 }, async (t) => {
  const upstream = await listen(t, (req, res) => {
    if (req.url.startsWith('/reset')) { req.socket.destroy(); return; }
    res.writeHead(req.url.startsWith('/failure') ? 503 : req.url.startsWith('/denied') ? 403 : 200);
    res.end('response');
  });
  const pool = createRemoteProxyPool();
  t.after(() => pool.stopAll());
  const [view] = await pool.syncRemotes([remote('http-diagnostics', upstream.origin)]);
  const before = events().length;
  for (const [path, status] of [['ok', 200], ['failure', 503], ['denied', 403], ['reset', 502]]) {
    assert.equal((await get(`${view.proxyUrl}${path}?token=private_query_secret`)).status, status);
  }
  const recorded = events().slice(before).filter((event) => event.routeId === 'http-diagnostics');
  assert.deepEqual(recorded.map((event) => event.event), ['remote.http.response', 'remote.http.response', 'remote.http.error']);
  assert.deepEqual(recorded.map((event) => event.httpStatus), [503, 403, 0]);
  assert.deepEqual(recorded.map((event) => event.path), ['/failure', '/denied', '/reset']);
  assert.equal(recorded[2].errorCode, 'ECONNRESET');
  assert.ok(recorded.every((event) => event.requestId));
  assert.equal(new Set(recorded.map((event) => event.requestId)).size, 3, '失败请求也有独立关联ID');
  assert.ok(recorded.every((event) => event.elapsedMs >= 0 && event.runId === recorded[0].runId));
  assertRedacted(recorded);
});

test('slow homepage headers expose TTFB and completion, with one truthful pending event when headers are still absent', async (t) => {
  for (const delay of [2500, 16000]) await t.test(`headers after ${delay}ms`, { timeout: 5000 }, async (t) => {
    const entered = deferred();
    const upstream = await listen(t, (_req, res) => entered.resolve(res));
    const pool = createRemoteProxyPool();
    t.after(() => pool.stopAll());
    const [view] = await pool.syncRemotes([remote(`slow-headers-${delay}`, upstream.origin)]);
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    const before = events().length;
    const response = get(`${view.proxyUrl}?token=private_query_secret`);
    const upstreamResponse = await entered.promise;
    t.mock.timers.tick(Math.min(delay, 15000));
    if (delay > 15000) t.mock.timers.tick(delay - 15000);
    upstreamResponse.end('private_body_secret');
    assert.deepEqual(await response, { status: 200, body: 'private_body_secret' });
    t.mock.timers.tick(30000);
    const recorded = events().slice(before).filter((event) => event.routeId === `slow-headers-${delay}`);
    const slow = recorded.filter((event) => event.event === 'remote.http.slow');
    assert.deepEqual(slow.map((event) => event.stage), ['headers', 'complete']);
    assert.ok(slow.every((event) => event.ttfbMs === delay && event.elapsedMs === delay && event.cacheHit === false));
    assert.equal(slow[0].bytesReceived, 0);
    assert.equal(slow[1].bytesReceived, Buffer.byteLength('private_body_secret'));
    const pending = recorded.filter((event) => event.event === 'remote.http.pending');
    assert.equal(pending.length, delay > 15000 ? 1 : 0, '未完成检查只发一次，完成后计时器不得再发事件');
    if (pending.length) {
      assert.equal(pending[0].stage, 'waiting-headers');
      assert.equal(pending[0].result, 'pending');
      assert.equal(pending[0].ttfbMs, null);
      assert.equal(pending[0].elapsedMs, 15000);
    }
    assert.ok(recorded.every((event) => event.requestId === slow[0].requestId && event.requestId));
    assertRedacted(recorded);
  });
});

test('slow plugin body completion preserves early TTFB and counts actual UTF-8 bytes through pending and downstream finish', { timeout: 5000 }, async (t) => {
  const entered = deferred();
  const upstream = await listen(t, (_req, res) => { res.write('你好'); entered.resolve(res); });
  const pool = createRemoteProxyPool();
  t.after(() => pool.stopAll());
  const [view] = await pool.syncRemotes([remote('slow-plugin-body', upstream.origin)]);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const before = events().length;
  const headers = deferred();
  const response = get(`${view.proxyUrl}plugins/??entry?token=private_query_secret`, headers.resolve);
  const upstreamResponse = await entered.promise;
  await headers.promise;
  t.mock.timers.tick(15000);
  t.mock.timers.tick(1000);
  upstreamResponse.end('private_body_secret');
  assert.deepEqual(await response, { status: 200, body: '你好private_body_secret' });
  t.mock.timers.tick(30000);
  const recorded = events().slice(before).filter((event) => event.routeId === 'slow-plugin-body');
  assert.deepEqual(recorded.map((event) => event.event), ['remote.http.pending', 'remote.http.slow']);
  assert.equal(recorded[0].stage, 'receiving-body');
  assert.equal(recorded[0].ttfbMs, 0);
  assert.equal(recorded[0].bytesReceived, Buffer.byteLength('你好'));
  assert.equal(recorded[1].stage, 'complete');
  assert.equal(recorded[1].elapsedMs, 16000);
  assert.equal(recorded[1].ttfbMs, 0);
  assert.equal(recorded[1].bytesReceived, Buffer.byteLength('你好private_body_secret'));
  assert.equal(recorded[0].requestId, recorded[1].requestId);
  assert.equal(recorded[1].path, '/plugins/');
  assert.equal(recorded[0].upstreamComplete, false, 'streaming body is not yet complete');
  assert.equal(recorded[1].upstreamComplete, true);
  assert.equal(recorded[1].upstreamAborted, false);
  assertRedacted(recorded);
});

test('caller abort closes the upstream request without reporting a network timeout', { timeout: 5000 }, async (t) => {
  const entered = deferred();
  const upstreamClosed = deferred();
  const upstream = await listen(t, (req, res) => {
    req.socket.once('close', upstreamClosed.resolve);
    entered.resolve(res);
  });
  const pool = createRemoteProxyPool();
  t.after(() => pool.stopAll());
  const configured = remote('caller-abort', upstream.origin);
  const entry = await pool.ensureProxy(configured);
  const [view] = await pool.syncRemotes([configured]);
  const proxyClosed = deferred();
  // 等待真实代理 TCP close，避免读取日志早于 res.close 的异步竞态。
  entry.server.once('connection', (socket) => socket.once('close', proxyClosed.resolve));
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const before = events().length;
  const request = http.get(`${view.proxyUrl}?token=private_query_secret`, { agent: false });
  request.on('error', () => {});
  const upstreamResponse = await entered.promise;
  t.mock.timers.tick(1000);
  request.destroy();
  await Promise.all([proxyClosed.promise, upstreamClosed.promise]);
  t.mock.timers.tick(30000);
  const recorded = events().slice(before).filter((event) => event.routeId === 'caller-abort');
  assert.deepEqual(recorded.map((event) => event.event), ['remote.http.aborted']);
  assert.equal(recorded[0].result, 'caller-aborted');
  assert.equal(recorded[0].stage, 'waiting-headers');
  assert.equal(recorded[0].ttfbMs, null);
  assert.equal(recorded[0].elapsedMs, 1000);
  assert.equal(recorded[0].firstCause, 'caller-aborted');
  assert.equal(upstreamResponse.destroyed, true);
  assertRedacted(recorded);
});

// 2026-11-03: discarded /plugins/events consumers left upstream streams running.
test('aborting an active event stream releases its upstream with or without transfer observers', { timeout: 5000 }, async (t) => {
  for (const observing of [false, true]) await t.test(`observing=${observing}`, async (t) => {
    const upstreamClosed = deferred();
    const upstream = await listen(t, (req, res) => {
      req.socket.once('close', upstreamClosed.resolve);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: private_body_secret\n\n');
    });
    const options = observing ? { onTransferTrace() {} } : {};
    const proxy = await listen(t, (req, res) => proxyHttpRequest(req, res, upstream.origin, options));
    const headers = deferred();
    const request = http.get(`${proxy.origin}/plugins/events`, { agent: false }, (res) => {
      res.on('error', () => {});
      res.resume();
      headers.resolve();
    });
    request.on('error', () => {});
    await headers.promise;
    request.destroy();
    await upstreamClosed.promise;
  });
});

test('truncated upstream event response reports incomplete/aborted state without leaking body', { timeout: 5000 }, async (t) => {
  const entered = deferred();
  const upstream = await listen(t, (req, res) => {
    res.write('private_body_secret');
    entered.resolve(req.socket);
  });
  const pool = createRemoteProxyPool();
  t.after(() => pool.stopAll());
  const [view] = await pool.syncRemotes([remote('truncated-stream', upstream.origin)]);
  const before = events().length;
  const headers = deferred();
  const response = get(`${view.proxyUrl}plugins/events`, headers.resolve);
  const upstreamSocket = await entered.promise;
  await headers.promise;
  upstreamSocket.destroy();
  assert.equal((await response).body, 'private_body_secret', 'forwarded prefix is preserved');
  const recorded = events().slice(before).filter((event) => event.routeId === 'truncated-stream');
  const failed = recorded.find((event) => event.event === 'remote.http.error');
  assert.equal(failed.firstCause, 'upstream-aborted');
  assert.equal(failed.upstreamComplete, false);
  assert.equal(failed.upstreamAborted, true);
  assert.equal(failed.bytesReceived, Buffer.byteLength('private_body_secret'));
  assertRedacted(recorded);
});

test('fast successful static resource and cache hit remain silent in JSONL after pending deadlines', { timeout: 5000 }, async (t) => {
  let hits = 0;
  const upstream = await listen(t, (_req, res) => { hits += 1; res.end('private_body_secret'); });
  const pool = createRemoteProxyPool();
  t.after(() => pool.stopAll());
  const [view] = await pool.syncRemotes([remote('fast-cached-asset', upstream.origin)]);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const before = events().length;
  for (let i = 0; i < 2; i += 1) assert.equal((await get(`${view.proxyUrl}assets/entry.js?token=private_query_secret`)).body, 'private_body_secret');
  t.mock.timers.tick(30000);
  assert.equal(hits, 1, '第二次请求仍由缓存返回，而不是被指标监听改变缓存行为');
  assert.deepEqual(events().slice(before).filter((event) => event.routeId === 'fast-cached-asset'), []);
});

test('throwing transfer observers cannot affect successful forwarding, cache fill or cache-hit responses', { timeout: 5000 }, async (t) => {
  let hits = 0;
  const upstream = await listen(t, (_req, res) => { hits += 1; res.end('cached response'); });
  const cache = new Map();
  const proxy = await listen(t, (req, res) => proxyHttpRequest(req, res, upstream.origin, {
    assetCache: cache,
    onTransferTrace() { throw new Error('private_body_secret'); },
  }));
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  for (let i = 0; i < 2; i += 1) assert.deepEqual(await get(`${proxy.origin}/assets/entry.js`), { status: 200, body: 'cached response' });
  t.mock.timers.tick(30000);
  assert.equal(hits, 1);
});

test('real WebSocket handshake, upstream disconnect and refusal log one close with connection correlation and no fake protocol code', { timeout: 5000 }, async (t) => {
  const upstreamClosed = deferred();
  let acceptedSocket;
  const upstream = await listen(t, (_req, res) => res.end('home'));
  upstream.server.on('upgrade', (req, socket) => {
    socket.on('error', () => {});
    if (req.url.startsWith('/denied')) {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    acceptedSocket = socket;
    socket.once('close', upstreamClosed.resolve);
    acceptUpgrade(req, socket);
  });
  const pool = createRemoteProxyPool();
  t.after(() => pool.stopAll());
  const [view] = await pool.syncRemotes([remote('ws-diagnostics', upstream.origin)]);
  const before = events().length;
  const connected = await upgrade(`${view.proxyUrl}socket?token=private_query_secret`);
  assert.equal(connected.status, 101);
  const clientClosed = new Promise((resolve) => connected.socket.once('close', resolve));
  // 真实未掩码文本帧穿过桥接，保证不仅是构造出一条日志。
  const received = new Promise((resolve) => connected.socket.once('data', resolve));
  acceptedSocket.write(Buffer.from([0x81, 2, 0x68, 0x69]));
  assert.deepEqual(await received, Buffer.from([0x81, 2, 0x68, 0x69]));
  const clientFrame = Buffer.from([0x81, 0x82, 1, 2, 3, 4, 0x68 ^ 1, 0x69 ^ 2]);
  const receivedByUpstream = new Promise((resolve) => acceptedSocket.once('data', resolve));
  connected.socket.write(clientFrame);
  assert.deepEqual(await receivedByUpstream, clientFrame, 'masked client bytes pass through unchanged');
  acceptedSocket.end();
  await clientClosed;
  await upstreamClosed.promise;
  assert.equal((await upgrade(`${view.proxyUrl}denied?token=private_query_secret`)).status, 403);
  const recorded = events().slice(before).filter((event) => event.routeId === 'ws-diagnostics');
  const opened = recorded.find((event) => event.event === 'remote.ws.upgrade');
  assert.ok(opened);
  const closed = recorded.filter((event) => event.event === 'remote.ws.close' && event.connectionId === opened.connectionId);
  assert.equal(closed.length, 1, 'end + close 只产生一条关闭记录');
  assert.equal(closed[0].direction, 'upstream');
  assert.equal(closed[0].firstCause, 'upstream-end');
  assert.equal(closed[0].phase, 'stream');
  assert.equal(closed[0].upstreamBytes, 4);
  assert.equal(closed[0].clientBytes, clientFrame.length);
  assert.ok(closed[0].upstreamIdleMs >= 0 && closed[0].clientIdleMs >= 0);
  assert.ok(closed[0].elapsedMs >= 0);
  const refused = recorded.find((event) => event.event === 'remote.ws.rejected');
  assert.equal(refused.httpStatus, 403);
  assert.notEqual(refused.connectionId, opened.connectionId);
  assert.equal(recorded.filter((event) => event.event === 'remote.ws.close' && event.connectionId === refused.connectionId).length, 1);
  assert.ok(recorded.every((event) => event.runId === opened.runId));
  assertRedacted(recorded);
});

test('stopping the remote pool also closes already upgraded sockets and logs the disconnect', { timeout: 5000 }, async (t) => {
  const upstreamClosed = deferred();
  const upstream = await listen(t, (_req, res) => res.end('home'));
  upstream.server.on('upgrade', (req, socket) => {
    socket.on('error', () => {});
    socket.once('close', upstreamClosed.resolve);
    // 测试上游必须消费输入/FIN，否则升级后的暂停 socket 不会结束半关闭连接。
    socket.once('end', () => socket.end());
    socket.resume();
    acceptUpgrade(req, socket);
  });
  const pool = createRemoteProxyPool();
  t.after(() => pool.stopAll());
  const [view] = await pool.syncRemotes([remote('ws-pool-stop', upstream.origin)]);
  const before = events().length;
  const connected = await upgrade(`${view.proxyUrl}socket`);
  assert.equal(connected.status, 101);
  const clientClosed = new Promise((resolve) => connected.socket.once('close', resolve));
  pool.stopAll();
  await Promise.all([clientClosed, upstreamClosed.promise]);
  const recorded = events().slice(before).filter((event) => event.routeId === 'ws-pool-stop');
  assert.equal(recorded.filter((event) => event.event === 'remote.ws.close').length, 1);
  assert.equal(recorded.at(-1).direction, 'client');
});

test('failed WebSocket upstream connection logs the actual error and closes the caller once', { timeout: 5000 }, async (t) => {
  const upstream = await listen(t, (_req, res) => res.end('home'));
  await new Promise((resolve) => upstream.server.close(resolve));
  const pool = createRemoteProxyPool();
  t.after(() => pool.stopAll());
  const [view] = await pool.syncRemotes([remote('ws-connection-error', upstream.origin)]);
  const before = events().length;
  await assert.rejects(upgrade(`${view.proxyUrl}socket?token=private_query_secret`), { code: 'ECONNRESET' });
  const recorded = events().slice(before).filter((event) => event.routeId === 'ws-connection-error');
  assert.deepEqual(recorded.map((event) => event.event), ['remote.ws.error', 'remote.ws.close']);
  assert.equal(recorded[0].errorCode, 'ECONNREFUSED');
  assert.equal(recorded[0].direction, 'upstream');
  assert.equal(recorded[0].connectionId, recorded[1].connectionId);
  assertRedacted(recorded);
});

test('throwing diagnostic callbacks cannot interrupt HTTP forwarding or upgraded socket cleanup', { timeout: 5000 }, async (t) => {
  let upstreamSocket;
  const upstream = await listen(t, (_req, res) => { res.writeHead(503); res.end('still forwarded'); });
  upstream.server.on('upgrade', (req, socket) => {
    upstreamSocket = socket;
    socket.on('error', () => {});
    acceptUpgrade(req, socket);
  });
  const options = { onTrace() { throw new Error('diagnostic side channel failed'); } };
  const proxy = await listen(t, (req, res) => proxyHttpRequest(req, res, upstream.origin, options));
  proxy.server.on('upgrade', (req, socket, head) => proxyWebSocketUpgrade(req, socket, head, upstream.origin, options));
  assert.deepEqual(await get(`${proxy.origin}/`), { status: 503, body: 'still forwarded' });
  const connected = await upgrade(`${proxy.origin}/socket`);
  assert.equal(connected.status, 101);
  const clientClosed = new Promise((resolve) => connected.socket.once('close', resolve));
  upstreamSocket.end();
  await clientClosed;
});

test('all client lifecycle events and route reasons enter JSONL through bounded whitelist, not arbitrary payloads', () => {
  const before = events().length;
  const names = [
    'select-device', 'select-local', 'iframe-mounted', 'iframe-unmounted', 'iframe-loaded', 'iframe-ready',
    'iframe-error', 'iframe-timeout', 'iframe-reload', 'iframe-unavailable', 'iframe-probe-offline', 'iframe-probe-recovered', 'iframe-ready-unconfirmed',
  ];
  for (const event of names) recordClientEvent({
    event, deviceId: 'example-mac', clientId: 'client-1', frameId: 'frame-1', routeId: 'route-1',
    fromRouteId: 'route-old', reason: 'load-timeout', result: 'offline', elapsedMs: 123.4, httpStatus: 502,
    errorCode: 'TIMEOUT', password: 'private_password_secret', query: 'private_query_secret',
    authorization: 'private_authorization_secret', cookie: 'private_cookie_secret',
    runId: 'forged', extra: { password: 'private_password_secret' },
  });
  recordClientEvent({ event: 'untrusted-event', frameId: 'x'.repeat(256), reason: 'https://host/?token=private_query_secret', result: 'free form error message', elapsedMs: Infinity, httpStatus: '502' });
  recordRouteChange({
    deviceId: 'example-mac', clientId: 'client-1', frameId: 'frame-1', routeId: 'actual-route',
    fromRouteId: 'preferred-old', toRouteId: 'preferred-new', reason: 'preference-change', accessTransport: 'local',
    password: 'private_password_secret',
    routes: [{ id: 'route-1', transport: 'tunnel', status: 'busy', online: true, password: 'private_password_secret', url: '/?token=private_query_secret' }],
  });
  const recorded = events().slice(before);
  assert.deepEqual(recorded.slice(0, names.length).map((event) => event.event), names.map((name) => `client.${name}`));
  assert.equal(recorded[0].elapsedMs, 123);
  assert.equal(recorded[0].httpStatus, 502);
  assert.ok(recorded.every((event) => event.runId === recorded[0].runId && event.runId !== 'forged'));
  const invalid = recorded[names.length];
  assert.equal(invalid.event, 'client.unknown');
  assert.equal(invalid.frameId.length, 128);
  assert.equal(invalid.reason, '');
  assert.equal(invalid.result, '');
  assert.equal(invalid.elapsedMs, undefined);
  assert.equal(invalid.httpStatus, undefined);
  const change = recorded.at(-1);
  assert.equal(change.event, 'route.change');
  assert.equal(change.reason, 'preference-change');
  assert.equal(change.routeId, 'actual-route');
  assert.equal(change.from, 'preferred-old');
  assert.equal(change.to, 'preferred-new');
  assert.equal(change.frameId, 'frame-1');
  assert.deepEqual(change.routes, [{ id: 'route-1', transport: 'tunnel', status: 'busy', online: true }]);
  assertRedacted(recorded);
});

test('select-local keeps switch source fields so automatic returns to local can be traced', () => {
  const before = events().length;
  recordClientEvent({
    event: 'select-local', deviceId: 'local', reason: 'intercept', trigger: 'openSession',
    sessionId: 'sess-1', fromDeviceId: 'example-mac', knownRemote: false, recordCount: 12,
  });
  recordClientEvent({ event: 'select-local', deviceId: 'local', trigger: 'https://host/?token=private_query_secret', knownRemote: 'false' });
  const [traced, rejected] = events().slice(before);
  assert.equal(traced.reason, 'intercept');
  assert.equal(traced.trigger, 'openSession');
  assert.equal(traced.sessionId, 'sess-1');
  assert.equal(traced.fromDeviceId, 'example-mac');
  assert.equal(traced.knownRemote, false);
  assert.equal(traced.recordCount, 12);
  assert.equal(rejected.trigger, '');
  assert.equal(rejected.knownRemote, undefined);
  assertRedacted([traced, rejected]);
});
