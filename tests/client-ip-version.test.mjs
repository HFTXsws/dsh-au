import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  CLIENT_IP_VERSION_HEADER,
  detectClientIpVersion,
  buildUpstreamHeaders,
  proxyHttpRequest,
} from '../lib/proxy-core.js';

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

test('detectClientIpVersion: IPv6 XFF', () => {
  assert.equal(detectClientIpVersion({ 'x-forwarded-for': '2001:db8::1' }), '6');
  assert.equal(detectClientIpVersion({ 'x-forwarded-for': '2409:8a00:1234:5678::1' }), '6');
  assert.equal(detectClientIpVersion({ 'x-forwarded-for': '::1' }), '6');
});

test('detectClientIpVersion: IPv4 XFF', () => {
  assert.equal(detectClientIpVersion({ 'x-forwarded-for': '192.168.1.1' }), '4');
  assert.equal(detectClientIpVersion({ 'x-forwarded-for': '114.114.114.114' }), '4');
  assert.equal(detectClientIpVersion({ 'x-forwarded-for': '127.0.0.1' }), '4');
});

test('detectClientIpVersion: 多跳 XFF', () => {
  // 逗号分隔首项为 IPv6
  assert.equal(detectClientIpVersion({ 'x-forwarded-for': '2409:8a00::1, 10.0.0.1, 127.0.0.1' }), '6');
  // 逗号分隔首项为 IPv4
  assert.equal(detectClientIpVersion({ 'x-forwarded-for': '1.2.3.4, 2409:8a00::1, 10.0.0.1' }), '4');
  // 首项带前后空格
  assert.equal(detectClientIpVersion({ 'x-forwarded-for': '   1.2.3.4   , 10.0.0.1' }), '4');
  assert.equal(detectClientIpVersion({ 'x-forwarded-for': '   2409:8a00::1   , 10.0.0.1' }), '6');
});

test('detectClientIpVersion: 带端口与 zone id 的 IPv4/IPv6', () => {
  // IPv4 带端口
  assert.equal(detectClientIpVersion({ 'x-forwarded-for': '192.168.1.100:8080' }), '4');
  // IPv6 带方括号与端口
  assert.equal(detectClientIpVersion({ 'x-forwarded-for': '[2001:db8::1]:8443' }), '6');
  // IPv6 仅带方括号
  assert.equal(detectClientIpVersion({ 'x-forwarded-for': '[2001:db8::1]' }), '6');
  // IPv6 zone id
  assert.equal(detectClientIpVersion({ 'x-forwarded-for': 'fe80::1%eth0' }), '6');
  // IPv6 带 zone id、方括号和端口
  assert.equal(detectClientIpVersion({ 'x-forwarded-for': '[fe80::1%12]:8080' }), '6');
});

test('detectClientIpVersion: ::ffff: IPv4 映射', () => {
  // 小写 ::ffff:
  assert.equal(detectClientIpVersion({ 'x-forwarded-for': '::ffff:192.168.1.5' }), '4');
  // 大写 ::FFFF:
  assert.equal(detectClientIpVersion({ 'x-forwarded-for': '::FFFF:192.168.1.5' }), '4');
  // 带方括号和端口
  assert.equal(detectClientIpVersion({ 'x-forwarded-for': '[::ffff:192.168.1.5]:8080' }), '4');
  // 不带方括号带端口
  assert.equal(detectClientIpVersion({ 'x-forwarded-for': '::ffff:192.168.1.5:8080' }), '4');
});

test('detectClientIpVersion: x-real-ip 回退与优先级', () => {
  // XFF 缺失时回退 x-real-ip (IPv4)
  assert.equal(detectClientIpVersion({ 'x-real-ip': '1.2.3.4' }), '4');
  // XFF 缺失时回退 x-real-ip (IPv6)
  assert.equal(detectClientIpVersion({ 'x-real-ip': '2001:db8::1' }), '6');
  // XFF 存在时优先于 x-real-ip
  assert.equal(detectClientIpVersion({ 'x-forwarded-for': '2001:db8::1', 'x-real-ip': '1.2.3.4' }), '6');
  assert.equal(detectClientIpVersion({ 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '2001:db8::1' }), '4');
  // XFF 为空串时回退 x-real-ip
  assert.equal(detectClientIpVersion({ 'x-forwarded-for': '', 'x-real-ip': '1.2.3.4' }), '4');
});

test('detectClientIpVersion: remoteAddress 回退与优先级', () => {
  // 无代理头时直接取 remoteAddress (IPv4)
  assert.equal(detectClientIpVersion({}, '192.168.1.1'), '4');
  assert.equal(detectClientIpVersion({}, '127.0.0.1'), '4');
  // 无代理头时直接取 remoteAddress (IPv6)
  assert.equal(detectClientIpVersion({}, '2001:db8::1'), '6');
  assert.equal(detectClientIpVersion({}, '::1'), '6');
  // remoteAddress 为 ::ffff: IPv4 映射
  assert.equal(detectClientIpVersion({}, '::ffff:192.168.1.1'), '4');
  // x-real-ip 优先于 remoteAddress
  assert.equal(detectClientIpVersion({ 'x-real-ip': '1.2.3.4' }, '2001:db8::1'), '4');
  // XFF 优先于 remoteAddress
  assert.equal(detectClientIpVersion({ 'x-forwarded-for': '2001:db8::1' }, '127.0.0.1'), '6');
});

test('detectClientIpVersion: 非法与空值', () => {
  assert.equal(detectClientIpVersion(), '');
  assert.equal(detectClientIpVersion(null, null), '');
  assert.equal(detectClientIpVersion({}, ''), '');
  assert.equal(detectClientIpVersion({ 'x-forwarded-for': '' }, ''), '');
  assert.equal(detectClientIpVersion({ 'x-forwarded-for': '   ' }, ''), '');
  assert.equal(detectClientIpVersion({ 'x-forwarded-for': 'invalid-ip' }), '');
  assert.equal(detectClientIpVersion({ 'x-forwarded-for': '999.999.999.999' }), '');
  assert.equal(detectClientIpVersion({ 'x-forwarded-for': '::ffff:notanip' }), '');
  assert.equal(detectClientIpVersion({}, 'not-an-ip'), '');
});

test('buildUpstreamHeaders: 防伪造与 clientIpVersion 注入', () => {
  const target = new URL('http://127.0.0.1:31990/dsh/');

  // 1. 外部传入伪造内部头且未传 clientIpVersion：头被清除
  const forged = { [CLIENT_IP_VERSION_HEADER]: '6', authorization: 'Bearer token' };
  const headers1 = buildUpstreamHeaders(forged, target);
  assert.equal(headers1[CLIENT_IP_VERSION_HEADER], undefined);

  // 2. 外部传入伪造内部头，但合法指定 clientIpVersion='4'：被覆盖为 '4'
  const headers2 = buildUpstreamHeaders(forged, target, { clientIpVersion: '4' });
  assert.equal(headers2[CLIENT_IP_VERSION_HEADER], '4');

  // 3. 合法写入 clientIpVersion='6'
  const headers3 = buildUpstreamHeaders({}, target, { clientIpVersion: '6' });
  assert.equal(headers3[CLIENT_IP_VERSION_HEADER], '6');

  // 4. 传入非法 clientIpVersion（如 '8' 或其他）：不写入
  const headers4 = buildUpstreamHeaders(forged, target, { clientIpVersion: '8' });
  assert.equal(headers4[CLIENT_IP_VERSION_HEADER], undefined);

  // 5. 空字符串或未传 clientIpVersion：不写入
  const headers5 = buildUpstreamHeaders({}, target, { clientIpVersion: '' });
  assert.equal(headers5[CLIENT_IP_VERSION_HEADER], undefined);
});

test('proxyHttpRequest: 透传 clientIpVersion 到上游请求头', async (t) => {
  let receivedHeaders = null;
  const upstream = await listen(t, (req, res) => {
    receivedHeaders = req.headers;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });

  const proxy = await listen(t, (req, res) => {
    void proxyHttpRequest(req, res, upstream.origin, { clientIpVersion: '6' });
  });

  await new Promise((resolve, reject) => {
    const clientReq = http.get(proxy.origin + '/test', {
      headers: {
        [CLIENT_IP_VERSION_HEADER]: '4', // 外部伪造
      },
    }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    clientReq.on('error', reject);
  });

  assert.ok(receivedHeaders);
  // 伪造的 '4' 被清洗，并由 options.clientIpVersion 安全覆盖为 '6'
  assert.equal(receivedHeaders[CLIENT_IP_VERSION_HEADER], '6');
});
