import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { createUpstreamRequest, normalizeHttpProxy } from '../lib/upstream-proxy.js';

async function listen(t, handler) {
  const server = http.createServer(handler);
  server.on('connect', (_req, socket) => socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  const sockets = new Set();
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

function requestBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

test('normalizes only credential-free Clash HTTP/mixed-port addresses', () => {
  assert.equal(normalizeHttpProxy('127.0.0.1:7890'), 'http://127.0.0.1:7890/');
  assert.equal(normalizeHttpProxy('http://127.0.0.1:7890/'), 'http://127.0.0.1:7890/');
  assert.equal(normalizeHttpProxy('https://127.0.0.1:7890'), '');
  assert.equal(normalizeHttpProxy('http://user:pass@127.0.0.1:7890'), '');
  assert.equal(normalizeHttpProxy('http://127.0.0.1:7890/path'), '');
});

test('sends HTTP tunnel traffic to Clash as absolute-form requests without proxy auth leakage', async (t) => {
  let seen;
  const proxy = await listen(t, async (req, res) => {
    seen = { url: req.url, host: req.headers.host, authorization: req.headers.authorization, cookie: req.headers.cookie };
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('through-clash');
  });
  const target = new URL('http://remote.example:31990/dsh/');
  const upstream = await createUpstreamRequest(target, {
    method: 'GET',
    headers: { authorization: 'Basic should-stay-inside-target', cookie: 'private-cookie' },
  }, proxy.origin);
  const response = await new Promise((resolve, reject) => {
    upstream.once('response', async (res) => resolve({ status: res.statusCode, body: await requestBody(res) }));
    upstream.once('error', reject);
    upstream.end();
  });
  assert.deepEqual(response, { status: 200, body: 'through-clash' });
  assert.equal(seen.url, target.href);
  assert.equal(seen.host, target.host);
  assert.equal(seen.authorization, 'Basic should-stay-inside-target');
  assert.equal(seen.cookie, 'private-cookie');
});

// Test-only localhost identity generated in memory; never used by a real service.
const TEST_TLS = {
  key: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgwzP5E1bjp/Q1VbOJ
89gc9YdOJGg+qmt1luRrlvnjDfGhRANCAATERnEx0hu5iEeXwx5PFnEDLH1F09i9
uyK1k1HF3IHuwQVAwiCda+HLKc9Ul8fWboxd8f2EkEBczXYU/g5iAset
-----END PRIVATE KEY-----`,
  cert: `-----BEGIN CERTIFICATE-----
MIIBFTCBvKADAgECAgID6TAKBggqhkjOPQQDAjAUMRIwEAYDVQQDDAlsb2NhbGhv
c3QwHhcNMjAwMTAxMDAwMDAwWhcNNDAwMTAxMDAwMDAwWjAUMRIwEAYDVQQDDAls
b2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATERnEx0hu5iEeXwx5P
FnEDLH1F09i9uyK1k1HF3IHuwQVAwiCda+HLKc9Ul8fWboxd8f2EkEBczXYU/g5i
AsetMAoGCCqGSM49BAMCA0gAMEUCIADkR6bUpgHtVGT1i29BnarQgzw3Km+DIag4
2yWShy6oAiEAhBprtG2RoDj/ZHxubLFk100wZtZ2owSpKvwLRp2CTgM=
-----END CERTIFICATE-----`,
};

async function tlsProxy(t, handler) {
  const connections = new Set();
  let secureConnections = 0;
  const targetServer = https.createServer(TEST_TLS, handler);
  targetServer.on('connection', (socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  targetServer.on('secureConnection', () => { secureConnections += 1; });
  await new Promise((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of connections) socket.destroy();
    await new Promise((resolve) => targetServer.close(resolve));
  });
  const proxy = await listen(t, (_req, res) => res.end());
  proxy.server.removeAllListeners('connect');
  proxy.server.on('connect', (_req, client, head) => {
    // The advertised destination deliberately cannot serve TLS. Only CONNECT
    // routes it to this ephemeral localhost target; bypassing the proxy fails.
    const upstream = net.connect(targetServer.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    client.once('close', () => upstream.destroy());
    upstream.once('error', () => client.destroy());
  });
  return {
    proxy: proxy.origin, target: new URL('https://127.0.0.1:1/'), count: () => secureConnections,
    // A constructor failure can close the client immediately after its TLS
    // handshake, before the server publishes secureConnection. Track TCP close.
    nextClose: () => new Promise((resolve) => targetServer.once('connection', (socket) => socket.once('close', resolve))),
  };
}

// 2026-11-03: agent:false ignored the established CONNECT socket and opened direct TLS.
test('HTTPS success uses the single CONNECT socket instead of opening a direct connection', { timeout: 5000 }, async (t) => {
  let seenPath;
  const env = await tlsProxy(t, (req, res) => { seenPath = req.url; res.end('through-connect'); });
  env.target.pathname = '/inside-connect';
  const request = await createUpstreamRequest(env.target, { ca: TEST_TLS.cert }, env.proxy);
  const response = await new Promise((resolve, reject) => {
    request.once('response', async (res) => resolve(await requestBody(res)));
    request.once('error', reject);
    request.end();
  });
  assert.equal(response, 'through-connect');
  assert.equal(seenPath, '/inside-connect');
  assert.equal(env.count(), 1, 'no unused preconnected TLS socket or second connection');
});

test('aborting a pending HTTPS response tears down its CONNECT socket', { timeout: 5000 }, async (t) => {
  let entered;
  const requestEntered = new Promise((resolve) => { entered = resolve; });
  const env = await tlsProxy(t, (req, _res) => entered(req.socket));
  const controller = new AbortController();
  const request = await createUpstreamRequest(env.target, { ca: TEST_TLS.cert, signal: controller.signal }, env.proxy);
  const failed = new Promise((resolve) => request.once('error', resolve));
  request.end();
  const targetSocket = await requestEntered;
  const closed = new Promise((resolve) => targetSocket.once('close', resolve));
  controller.abort();
  assert.equal((await failed).code, 'ABORT_ERR');
  await closed;
  assert.equal(env.count(), 1);
});

test('invalid HTTPS request options release the already established CONNECT socket', { timeout: 5000 }, async (t) => {
  const env = await tlsProxy(t, (_req, res) => res.end());
  const closed = env.nextClose();
  await assert.rejects(createUpstreamRequest(env.target, { ca: TEST_TLS.cert, method: 'bad\nmethod' }, env.proxy), { code: 'ERR_INVALID_HTTP_TOKEN' });
  await closed;
});

test('rejects self-signed certificates by default for both direct HTTPS and CONNECT tunnel', { timeout: 5000 }, async (t) => {
  const env = await tlsProxy(t, (_req, res) => res.end('should-not-reach'));
  await assert.rejects(
    createUpstreamRequest(env.target, {}, env.proxy),
    (error) => /DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE/.test(error.code || error.message),
  );

  const directServer = https.createServer(TEST_TLS, (_req, res) => res.end('should-not-reach'));
  const directSockets = new Set();
  directServer.on('connection', (socket) => {
    directSockets.add(socket);
    socket.once('close', () => directSockets.delete(socket));
  });
  await new Promise((resolve) => directServer.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of directSockets) socket.destroy();
    await new Promise((resolve) => directServer.close(resolve));
  });
  const directTarget = new URL(`https://localhost:${directServer.address().port}/`);
  const directReq = await createUpstreamRequest(directTarget, {});
  await assert.rejects(
    new Promise((resolve, reject) => {
      directReq.once('response', resolve);
      directReq.once('error', reject);
      directReq.end();
    }),
    (error) => /DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE/.test(error.code || error.message),
  );

  const trustedDirectReq = await createUpstreamRequest(directTarget, { ca: TEST_TLS.cert });
  const trustedBody = await new Promise((resolve, reject) => {
    trustedDirectReq.once('response', async (res) => resolve(await requestBody(res)));
    trustedDirectReq.once('error', reject);
    trustedDirectReq.end();
  });
  assert.equal(trustedBody, 'should-not-reach');
});

test('rejects a non-2xx CONNECT response before creating the target request', async (t) => {
  const proxy = await listen(t, (_req, res) => {
    res.writeHead(502);
    res.end('proxy rejected');
  });
  await assert.rejects(
    createUpstreamRequest(new URL('https://remote.example/'), { timeout: 500 }, proxy.origin),
    (error) => error.code === 'ERR_PROXY_CONNECT_STATUS'
  );
});
