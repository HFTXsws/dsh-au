import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

const DEFAULT_PROXY_PORT = 80;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/** Clash 使用 HTTP/mixed-port；代理地址只允许本机运行态保存的无凭据 HTTP URL。 */
export function normalizeHttpProxy(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  let parsed;
  try {
    parsed = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `http://${raw.trim()}`);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' || parsed.username || parsed.password || parsed.search || parsed.hash) return '';
  if (parsed.pathname !== '/' && parsed.pathname !== '') return '';
  const port = parsed.port || String(DEFAULT_PROXY_PORT);
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) return '';
  parsed.pathname = '/';
  parsed.port = port;
  return parsed.href;
}

function targetProtocol(target) {
  return target.protocol === 'https:' || target.protocol === 'wss:' ? 'https:' : 'http:';
}

function targetPort(target) {
  return Number(target.port) || (targetProtocol(target) === 'https:' ? 443 : 80);
}

function proxyPort(proxy) {
  return Number(proxy.port) || DEFAULT_PROXY_PORT;
}

function proxyError(message, code = 'ERR_PROXY_CONNECTION') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function withTargetHeaders(headers, target) {
  const result = { ...(headers || {}) };
  // CONNECT 本身不能带远端 Basic Auth/Cookie；这些只随 TLS 内的真实请求发送。
  delete result['proxy-authorization'];
  delete result['Proxy-Authorization'];
  result.host = target.host;
  return result;
}

function openConnectTunnel(proxy, target, timeoutMs, tlsOptions = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let tunnelSocket = null;
    const timeout = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_CONNECT_TIMEOUT_MS;
    const connect = http.request({
      hostname: proxy.hostname,
      port: proxyPort(proxy),
      method: 'CONNECT',
      path: `${target.hostname}:${targetPort(target)}`,
      headers: {
        host: `${target.hostname}:${targetPort(target)}`,
        connection: 'keep-alive',
      },
      agent: false,
    });
    const fail = (error) => {
      if (settled) return;
      settled = true;
      tunnelSocket?.destroy();
      connect.destroy();
      reject(error instanceof Error ? error : proxyError('Clash CONNECT 失败'));
    };
    connect.setTimeout(timeout, () => fail(proxyError('Clash CONNECT 超时', 'ETIMEDOUT')));
    connect.once('error', (error) => fail(error));
    connect.once('connect', (response, socket, head) => {
      tunnelSocket = socket;
      if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
        response.resume();
        fail(proxyError(`Clash CONNECT 被拒绝（HTTP ${response.statusCode || 0}）`, 'ERR_PROXY_CONNECT_STATUS'));
        return;
      }
      // CONNECT/TLS deadlines belong to establishment, not the established stream.
      socket.setTimeout(0);
      if (head?.length) socket.unshift(head);
      const secureSocket = tls.connect({
        socket,
        servername: net.isIP(target.hostname) ? undefined : target.hostname,
        ...(tlsOptions.ca !== undefined ? { ca: tlsOptions.ca } : {}),
        rejectUnauthorized: tlsOptions.rejectUnauthorized !== false,
      });
      tunnelSocket = secureSocket;
      secureSocket.setTimeout(timeout, () => fail(proxyError('Clash TLS 建连超时', 'ETIMEDOUT')));
      secureSocket.once('secureConnect', () => {
        if (settled) return;
        settled = true;
        secureSocket.setTimeout(0);
        resolve(secureSocket);
      });
      secureSocket.once('error', (error) => fail(error));
    });
    connect.end();
  });
}

/**
 * 创建一条发往目标的请求：无代理时保持原直连；有代理时 HTTP 走绝对 URI，
 * HTTPS/WSS 先 CONNECT 到 Clash，再在同一 socket 上建立 TLS。
 */
export async function createUpstreamRequest(target, options = {}, upstreamProxy = '') {
  const protocol = targetProtocol(target);
  const targetHost = target.hostname;
  const targetPortNumber = targetPort(target);
  const headers = withTargetHeaders(options.headers, target);
  const proxyUrl = normalizeHttpProxy(upstreamProxy);
  const rejectUnauthorized = options.rejectUnauthorized !== false;
  const common = {
    ...options,
    protocol,
    hostname: targetHost,
    port: targetPortNumber,
    path: `${target.pathname}${target.search}`,
    headers,
    agent: false,
    rejectUnauthorized,
  };
  if (!proxyUrl) return protocol === 'https:' ? https.request(common) : http.request(common);

  const proxy = new URL(proxyUrl);
  if (protocol === 'http:') {
    return http.request({
      ...common,
      hostname: proxy.hostname,
      port: proxyPort(proxy),
      path: target.href,
      headers,
    });
  }
  const socket = await openConnectTunnel(proxy, target, options.timeout, {
    ca: options.ca,
    rejectUnauthorized,
  });
  try {
    // agent:false creates a fresh Agent and bypasses createConnection. Agentless
    // requests must own the exact CONNECT/TLS socket, never silently open direct TLS.
    return https.request({
      ...common,
      agent: undefined,
      createConnection: () => socket,
    });
  } catch (error) {
    socket.destroy();
    throw error;
  }
}
