import http from 'node:http';
import https from 'node:https';
import { createUpstreamRequest } from './upstream-proxy.js';

/** 服务端 Cookie 罐：解决跨源 iframe 中 SameSite=Strict / Secure Cookie 被浏览器丢弃的问题 */
export function createCookieJar() {
  const store = new Map();
  return {
    capture(setCookieHeaders) {
      const list = Array.isArray(setCookieHeaders)
        ? setCookieHeaders
        : setCookieHeaders ? [String(setCookieHeaders)] : [];
      const sanitized = [];
      for (const raw of list) {
        const firstPair = raw.split(';')[0]?.trim();
        const eqIdx = firstPair ? firstPair.indexOf('=') : -1;
        if (eqIdx > 0) {
          store.set(firstPair.slice(0, eqIdx).trim(), firstPair.slice(eqIdx + 1).trim());
        }
        sanitized.push(
          raw
            .replace(/;\s*SameSite=(Strict|Lax)/gi, '')
            .replace(/;\s*Secure/gi, '')
        );
      }
      return sanitized;
    },
    mergeHeader(clientCookie) {
      const merged = new Map();
      if (typeof clientCookie === 'string' && clientCookie.trim()) {
        for (const part of clientCookie.split(';')) {
          const eq = part.indexOf('=');
          if (eq > 0) merged.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
        }
      }
      for (const [k, v] of store.entries()) merged.set(k, v);
      if (merged.size === 0) return undefined;
      return [...merged.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    hasCookies() {
      return store.size > 0;
    },
  };
}

/**
 * 将代理收到的请求路径安全解析到目标上游 URL：
 * 1. 强制要求路径形式请求（拒绝 http://、https://、ws://、wss:// 等绝对 URI 或协议相对 // 逃逸）
 * 2. 自动补齐上游子路径前缀（如 https://host:8443/dsh/ 下转发 /assets/* 与 /api/* 到 /dsh/...）
 * 3. 在根路径请求上保留上游配置的 query 参数
 * 4. 构造后再次校验 result.origin === base.origin
 */
export function resolveUpstreamUrl(reqUrl, targetBaseUrl) {
  const base = new URL(targetBaseUrl);
  const basePath = !base.pathname || base.pathname === '/'
    ? '/'
    : (base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`);
  const baseNoSlash = basePath === '/' ? '/' : basePath.slice(0, -1);

  const rawReq = reqUrl === undefined || reqUrl === null || reqUrl === '' ? '/' : String(reqUrl);
  if (!rawReq.startsWith('/') || rawReq.startsWith('//') || rawReq.startsWith('/\\')) {
    throw new Error('upstream request URL must be an origin-form path');
  }
  const qIdx = rawReq.indexOf('?');
  const rawPath = qIdx >= 0 ? rawReq.slice(0, qIdx) : rawReq;
  const rawSearch = qIdx >= 0 ? rawReq.slice(qIdx) : '';
  const cleanPath = rawPath.replace(/^\/+/, '/') || '/';

  let finalPath;
  if (basePath !== '/') {
    if (cleanPath === '/' || cleanPath === baseNoSlash || cleanPath === basePath) {
      finalPath = basePath;
    } else if (cleanPath.startsWith(basePath)) {
      finalPath = cleanPath;
    } else {
      finalPath = `${basePath}${cleanPath.slice(1)}`;
    }
  } else {
    finalPath = cleanPath;
  }

  const isRootRequest = cleanPath === '/' || cleanPath === baseNoSlash || cleanPath === basePath;
  const finalSearch = !rawSearch && isRootRequest && base.search ? base.search : rawSearch;
  const result = new URL(`${finalPath}${finalSearch}`, base.origin);
  if (result.origin !== base.origin) {
    throw new Error('upstream request URL escaped target origin');
  }
  return result;
}

/** 构造发往目标 DSH 的请求头：重写 Host/Origin/Sec-Fetch-Site 并注入 Basic Auth 与 Cookie */
export function buildUpstreamHeaders(inHeaders, targetUrl, { basicAuth, cookieJar } = {}) {
  const headers = { ...inHeaders };
  delete headers['x-forwarded-for'];
  delete headers['x-forwarded-host'];
  delete headers['x-forwarded-proto'];
  headers.host = targetUrl.host;
  if (inHeaders.origin || inHeaders.upgrade) {
    headers.origin = targetUrl.origin;
  }
  headers.referer = targetUrl.href;
  headers['sec-fetch-site'] = 'same-origin';

  if (basicAuth && (basicAuth.username || basicAuth.password)) {
    const token = Buffer.from(`${basicAuth.username || ''}:${basicAuth.password || ''}`).toString('base64');
    headers.authorization = `Basic ${token}`;
  }
  if (cookieJar) {
    const cookie = cookieJar.mergeHeader(inHeaders.cookie);
    if (cookie) headers.cookie = cookie;
  }
  return headers;
}

/** 判断是否为可缓存的带指纹静态资源或插件合并包 */
function isCacheableStaticPath(pathWithQuery) {
  return pathWithQuery.includes('/assets/') || pathWithQuery.includes('/plugins/??');
}

/** 诊断是旁路：回调失败不能中断响应转发或 socket 清理。 */
function emitTrace(onTrace, kind, data) {
  try { onTrace?.(kind, data); } catch {}
}

/** 只信任显式主 DSH 来源及实际接入的代理端口；Host/转发头不能扩展信任范围。 */
export function rejectUntrustedProxyOrigin(req, response, allowedOrigins = []) {
  const origin = req.headers?.origin;
  // 无 Origin 的服务器调用和页面导航保持兼容；空值/null/多来源头不是可信来源。
  if (origin === undefined) return false;
  let validOrigin = false;
  try {
    const parsed = new URL(origin);
    validOrigin = typeof origin === 'string' && parsed.origin === origin && ['http:', 'https:'].includes(parsed.protocol);
  } catch {}
  const address = req.socket?.localAddress;
  const port = req.socket?.localPort;
  const host = address?.startsWith('::ffff:') ? address.slice(7) : address;
  const protocol = req.socket?.encrypted ? 'https' : 'http';
  const ownOrigins = host && port ? [new URL(`${protocol}://${host.includes(':') ? `[${host}]` : host}:${port}`).origin] : [];
  // 回环别名只能对应实际接入的监听端口；请求 Host 或其它 localhost 端口绝不授信。
  if (port && (host === '127.0.0.1' || host === '::1')) {
    for (const alias of ['localhost', '127.0.0.1', '[::1]']) ownOrigins.push(new URL(`${protocol}://${alias}:${port}`).origin);
  }
  if (validOrigin && (ownOrigins.includes(origin) || (Array.isArray(allowedOrigins) && allowedOrigins.includes(origin)))) return false;
  const headers = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', vary: 'Origin' };
  if (typeof response.writeHead === 'function') {
    response.writeHead(403, headers);
    response.end('dsh-au proxy: untrusted Origin');
  } else {
    // Upgrade 走同一授权边界，在任何上游握手/凭据注入前返回真实 HTTP 拒绝。
    response.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nCache-Control: no-store\r\nVary: Origin\r\nContent-Length: 0\r\n\r\n');
  }
  req.resume?.();
  return true;
}

/** CORS 授权属于当前调用方，不存进静态缓存，也不继承上游的宽松授权。 */
function withProxyCors(headers, origin) {
  const result = { ...headers };
  for (const key of Object.keys(result)) {
    if (key.startsWith('access-control-')) delete result[key];
  }
  const vary = (Array.isArray(result.vary) ? result.vary.join(', ') : String(result.vary || '')).split(',').map((value) => value.trim()).filter(Boolean);
  if (!vary.some((value) => value.toLowerCase() === 'origin')) vary.push('Origin');
  result.vary = vary.join(', ');
  if (origin) {
    result['access-control-allow-origin'] = origin;
    result['access-control-allow-credentials'] = 'true';
  }
  return result;
}

/** 转发 HTTP 请求并剥离 iframe/BasicAuth 弹窗拦截响应头 */
export async function proxyHttpRequest(req, res, targetBaseUrl, { basicAuth, cookieJar, assetCache, onTrace, onTransferTrace, allowedOrigins, upstreamProxy } = {}) {
  if (rejectUntrustedProxyOrigin(req, res, allowedOrigins)) return;
  const reqOrigin = typeof req.headers?.origin === 'string' ? req.headers.origin : '';
  if (req.method === 'OPTIONS' && reqOrigin) {
    res.writeHead(204, {
      'access-control-allow-origin': reqOrigin,
      'access-control-allow-methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
      'access-control-allow-headers': req.headers['access-control-request-headers'] || 'content-type, authorization',
      'access-control-allow-credentials': 'true',
      'access-control-max-age': '86400',
      vary: 'Origin',
      'cache-control': 'no-store',
    });
    res.end();
    return;
  }
  const startedAt = Date.now();
  let target;
  try {
    target = resolveUpstreamUrl(req.url || '/', targetBaseUrl);
  } catch (err) {
    res.writeHead(400, withProxyCors({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, reqOrigin));
    res.end(`dsh-au proxy: invalid target URL (${err?.message || 'bad request'})`);
    req.resume?.();
    return;
  }
  const fullPath = `${target.pathname}${target.search}`;
  const canCache = Boolean(assetCache && req.method === 'GET' && isCacheableStaticPath(fullPath));
  const cacheKey = canCache ? `${target.origin}${fullPath}|${req.headers['accept-encoding'] || ''}` : '';
  let ttfbMs = null;
  let bytesReceived = 0;
  let cacheHit = false;
  let transferStatus = 0;
  let transferDone = false;
  let pendingTimer = null;
  let upstreamResponse = null;
  let upReq = null;
  let firstCause = '';
  // Keep the first terminal observation: a later upstream reset must not turn a
  // caller-aborted event stream into an unexplained network failure.
  const rememberCause = (cause) => { if (!firstCause) firstCause = cause; };
  const transferInfo = (stage, result) => ({
    stage, result, statusCode: transferStatus, ttfbMs, bytesReceived, cacheHit,
    firstCause,
    upstreamComplete: upstreamResponse ? upstreamResponse.complete === true : null,
    upstreamAborted: upstreamResponse?.aborted === true,
    elapsedMs: Date.now() - startedAt,
  });
  const errorInfo = (errorCode) => ({ ...transferInfo(ttfbMs === null ? 'waiting-headers' : 'receiving-body', 'error'), errorCode });
  const clearTransfer = () => {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = null;
  };
  const failTransfer = (cause) => { rememberCause(cause); transferDone = true; clearTransfer(); };
  const abortTransfer = () => {
    rememberCause('caller-aborted');
    if (transferDone) return;
    transferDone = true;
    clearTransfer();
    // A cancelled consumer no longer owns the upstream response. Do not use
    // normal request close (GET bodies finish before an SSE response does).
    upstreamResponse?.destroy();
    upReq?.destroy();
    emitTrace(onTransferTrace, 'aborted', transferInfo(ttfbMs === null ? 'waiting-headers' : 'receiving-body', 'caller-aborted'));
  };

  // Cleanup is independent of optional observers; only unfinished response
  // close / aborted request means cancellation, never the normal GET req.close.
  res.once('finish', () => {
    if (transferDone) return;
    rememberCause('completed');
    transferDone = true;
    clearTransfer();
    emitTrace(onTransferTrace, 'complete', transferInfo('complete', 'completed'));
  });
  res.once('close', () => {
    if (!res.writableFinished) abortTransfer();
    else clearTransfer();
  });
  res.once('error', () => failTransfer('caller-error'));
  req.once('aborted', abortTransfer);
  req.once('error', () => failTransfer('caller-error'));
  if (typeof onTransferTrace === 'function') {
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      if (!transferDone) emitTrace(onTransferTrace, 'pending', transferInfo(ttfbMs === null ? 'waiting-headers' : 'receiving-body', 'pending'));
    }, 15_000);
    pendingTimer.unref?.();
  }

  if (canCache && assetCache.has(cacheKey)) {
    const hit = assetCache.get(cacheKey);
    cacheHit = true;
    transferStatus = 200;
    ttfbMs = Date.now() - startedAt;
    // 缓存命中没有上游传输，因此 bytesReceived 保持 0。
    emitTrace(onTransferTrace, 'headers', transferInfo('headers', 'headers'));
    res.writeHead(200, withProxyCors(hit.headers, reqOrigin));
    res.end(hit.body);
    return;
  }

  const headers = buildUpstreamHeaders(req.headers, target, { basicAuth, cookieJar });

  try {
    upReq = await createUpstreamRequest(target, {
      method: req.method,
      path: fullPath,
      headers,
    }, upstreamProxy);
  } catch (err) {
    failTransfer('upstream-connect-error');
    if (firstCause === 'caller-aborted') return;
    emitTrace(onTrace, 'error', errorInfo(err?.code || 'ERROR'));
    if (!res.headersSent) {
      res.writeHead(502, withProxyCors({ 'content-type': 'text/plain; charset=utf-8' }, reqOrigin));
    }
    res.end(`dsh-au 代理连接失败: ${err?.message || 'upstream unavailable'}`);
    return;
  }
  if (firstCause === 'caller-aborted') {
    upReq.once('error', () => {});
    upReq.destroy();
    return;
  }
  upReq.once('response', (upRes) => {
      upstreamResponse = upRes;
      // 原 onTrace 仍只收 response/error；传输分段指标不进入局域网桥接旧追踪。
      transferStatus = upRes.statusCode || 502;
      ttfbMs = Date.now() - startedAt;
      emitTrace(onTransferTrace, 'headers', transferInfo('headers', 'headers'));
      if (typeof onTransferTrace === 'function') {
        upRes.on('data', (chunk) => { bytesReceived += chunk.length; });
      }
      upRes.once('aborted', () => failTransfer('upstream-aborted'));
      emitTrace(onTrace, 'response', { statusCode: upRes.statusCode || 0, elapsedMs: Date.now() - startedAt });
      upRes.on('error', (err) => {
        failTransfer('upstream-response-error');
        if (firstCause === 'caller-aborted') return;
        emitTrace(onTrace, 'error', errorInfo(err?.code || 'ERROR'));
        res.end();
      });
      const resHeaders = withProxyCors(upRes.headers, '');
      delete resHeaders['x-frame-options'];
      delete resHeaders['content-security-policy'];
      delete resHeaders['content-security-policy-report-only'];
      // 剥离 www-authenticate，防止浏览器在 iframe 内弹出原生 Basic Auth 登录框或直接静默拦截
      delete resHeaders['www-authenticate'];
      if (resHeaders['set-cookie'] && cookieJar) {
        resHeaders['set-cookie'] = cookieJar.capture(resHeaders['set-cookie']);
      }
      const statusCode = upRes.statusCode || 502;
      res.writeHead(statusCode, withProxyCors(resHeaders, reqOrigin));

      if (canCache && statusCode === 200) {
        const chunks = [];
        let total = 0;
        const maxBytes = 20 * 1024 * 1024;
        upRes.on('data', (chunk) => {
          total += chunk.length;
          if (total <= maxBytes) chunks.push(chunk);
          res.write(chunk);
        });
        upRes.on('end', () => {
          if (total > 0 && total <= maxBytes) {
            if (assetCache.size >= 32) {
              const oldest = assetCache.keys().next().value;
              if (oldest !== undefined) assetCache.delete(oldest);
            }
            const cachedHeaders = { ...resHeaders };
            delete cachedHeaders['transfer-encoding'];
            cachedHeaders['content-length'] = String(total);
            assetCache.set(cacheKey, { headers: cachedHeaders, body: Buffer.concat(chunks, total) });
          }
          res.end();
        });
        return;
      }

      upRes.pipe(res);
  });

  upReq.on('error', (err) => {
    failTransfer('upstream-request-error');
    if (firstCause === 'caller-aborted') return;
    emitTrace(onTrace, 'error', errorInfo(err?.code || 'ERROR'));
    if (!res.headersSent) {
      res.writeHead(502, withProxyCors({ 'content-type': 'text/plain; charset=utf-8' }, reqOrigin));
    }
    res.end(`dsh-au 代理连接失败: ${err.message}`);
  });
  req.pipe(upReq);
}

/** 转发 WebSocket Upgrade；记录握手与 TCP 生命周期，不伪造协议 closeCode。 */
export async function proxyWebSocketUpgrade(req, socket, head, targetBaseUrl, { basicAuth, cookieJar, onTrace, allowedOrigins, upstreamProxy } = {}) {
  if (rejectUntrustedProxyOrigin(req, socket, allowedOrigins)) return;
  const startedAt = Date.now();
  let connectedAt = 0;
  let upstreamSocket = null;
  let upReq = null;
  let finished = false;
  let statusCode = 0;
  let clientBytes = 0;
  let upstreamBytes = 0;
  let lastClientDataAt = null;
  let lastUpstreamDataAt = null;
  // Observe only byte lengths/times. No payload/frame buffering or protocol
  // parsing: TCP end remains distinct from an unavailable WebSocket closeCode.
  const observeTraffic = (direction, chunk) => {
    if (direction === 'client') { clientBytes += chunk.length; lastClientDataAt = Date.now(); }
    else { upstreamBytes += chunk.length; lastUpstreamDataAt = Date.now(); }
  };
  const trafficInfo = () => ({
    clientBytes, upstreamBytes,
    clientIdleMs: lastClientDataAt === null ? null : Math.max(0, Date.now() - lastClientDataAt),
    upstreamIdleMs: lastUpstreamDataAt === null ? null : Math.max(0, Date.now() - lastUpstreamDataAt),
  });
  let target;
  try {
    target = resolveUpstreamUrl(req.url || '/', targetBaseUrl);
  } catch {
    if (!socket.destroyed) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n');
    }
    req.resume?.();
    return;
  }
  const headers = buildUpstreamHeaders(req.headers, target, { basicAuth, cookieJar });

  // end/close/error 经常连续触发；只清理与记录一次，并覆盖握手前客户端放弃。
  const finish = (result, direction, errorCode = '') => {
    if (finished) return;
    finished = true;
    const info = {
      result, direction, errorCode, statusCode,
      firstCause: `${direction}-${result}`,
      phase: connectedAt ? 'stream' : 'handshake',
      ...trafficInfo(),
      elapsedMs: Date.now() - (connectedAt || startedAt),
    };
    if (result === 'error') emitTrace(onTrace, 'error', info);
    emitTrace(onTrace, 'close', info);
    if (upstreamSocket && !upstreamSocket.destroyed) upstreamSocket.destroy();
    if (!upstreamSocket && upReq && !upReq.destroyed) upReq.destroy();
    // 拒绝握手时保留状态行的发送机会，其他关闭与既有双向销毁语义一致。
    if (!socket.destroyed) {
      if (result === 'rejected') socket.end();
      else socket.destroy();
    }
  };
  socket.once('error', (err) => finish('error', 'client', err?.code || 'ERROR'));
  socket.once('close', () => finish('close', 'client'));
  socket.once('end', () => finish('end', 'client'));

  try {
    upReq = await createUpstreamRequest(target, {
      method: req.method || 'GET',
      headers,
    }, upstreamProxy);
  } catch (err) {
    finish('error', 'upstream', err?.code || 'ERROR');
    return;
  }
  if (finished) {
    upReq.destroy();
    return;
  }

  upReq.on('upgrade', (upRes, upSocket, upHead) => {
    if (finished) { upSocket.destroy(); return; }
    upstreamSocket = upSocket;
    if (socket.destroyed) { finish('close', 'client'); return; }
    statusCode = upRes.statusCode || 101;
    connectedAt = Date.now();
    emitTrace(onTrace, 'upgrade', { result: 'connected', direction: 'upstream', statusCode, elapsedMs: connectedAt - startedAt });
    upSocket.once('error', (err) => finish('error', 'upstream', err?.code || 'ERROR'));
    upSocket.once('close', () => finish('close', 'upstream'));
    upSocket.once('end', () => finish('end', 'upstream'));
    if (upRes.headers['set-cookie'] && cookieJar) cookieJar.capture(upRes.headers['set-cookie']);
    const lines = [`HTTP/1.1 ${statusCode} ${upRes.statusMessage || 'Switching Protocols'}`];
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (Array.isArray(v)) {
        for (const item of v) lines.push(`${k}: ${item}`);
      } else if (v !== undefined) {
        lines.push(`${k}: ${v}`);
      }
    }
    lines.push('', '');
    socket.write(lines.join('\r\n'));
    if (upHead && upHead.length) { observeTraffic('upstream', upHead); socket.write(upHead); }
    if (head && head.length) { observeTraffic('client', head); upSocket.write(head); }
    upSocket.on('data', (chunk) => observeTraffic('upstream', chunk));
    socket.on('data', (chunk) => observeTraffic('client', chunk));
    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });

  upReq.on('response', (upRes) => {
    if (finished) { upRes.resume(); return; }
    statusCode = upRes.statusCode || 502;
    emitTrace(onTrace, 'rejected', { result: 'rejected', direction: 'upstream', statusCode, elapsedMs: Date.now() - startedAt });
    upRes.resume();
    socket.write(`HTTP/1.1 ${statusCode} ${upRes.statusMessage || 'Bad Gateway'}\r\n\r\n`);
    finish('rejected', 'upstream');
  });
  upReq.on('error', (err) => finish('error', 'upstream', err?.code || 'ERROR'));
  upReq.end();
}
