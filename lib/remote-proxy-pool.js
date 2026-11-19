import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { buildUpstreamHeaders, createCookieJar, proxyHttpRequest, proxyWebSocketUpgrade, resolveUpstreamUrl } from './proxy-core.js';
import { createUpstreamRequest } from './upstream-proxy.js';
import { logNet, sanitizePath, sanitizeUrl } from './net-log.js';

// 持续失败时每条路径最多每 5 分钟记一次，避免 15 秒轮询刷屏。
const PROBE_FAILURE_LOG_INTERVAL_MS = 5 * 60 * 1000;
const LIGHTS_V2 = ['idle', 'busy', 'waiting', 'done', 'error'];

/** 代理策略按路线隔离：只有用户明确标记为 tunnel 的路线才可使用本机 Clash。 */
function routeProxy(remote) {
  return remote?.transport === 'tunnel' ? (remote.proxyUrl || '') : '';
}

/** 远端 sessionStatesV2 来自网络，只保留有限条目里的合法灯色。 */
function sanitizeSessionStatesV2(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  for (const [sessionId, light] of Object.entries(value).slice(0, 200)) {
    if (typeof sessionId === 'string' && sessionId.length <= 128 && LIGHTS_V2.includes(light)) result[sessionId] = light;
  }
  return result;
}

/** 仅接收版本 1 的日志序号详情；-1 是无版本哨兵，禁止网络值伪造精度/字段。 */
function sanitizeSessionStateDetails(value, version) {
  if (version !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).slice(0, 200).filter(([sessionId, detail]) => (
    sessionId.length > 0 && sessionId.length <= 128 && detail && typeof detail === 'object' && !Array.isArray(detail)
    && LIGHTS_V2.includes(detail.status)
    && ['stateSeq', 'endSeq', 'ackedSeq'].every((key) => Number.isSafeInteger(detail[key]) && detail[key] >= -1)
    && detail.endSeq <= detail.stateSeq // 结束不能晚于已观测日志；ackedSeq 允许在回放前领先。
  )).map(([sessionId, detail]) => [sessionId, {
    status: detail.status, stateSeq: detail.stateSeq, endSeq: detail.endSeq, ackedSeq: detail.ackedSeq,
  }]);
  // fromEntries 保留合法会话键为自有属性，不让 __proto__ 网络键改变对象原型。
  return Object.fromEntries(entries);
}

/**
 * 写探测诊断日志：
 * 1. 状态 / 在线 / 通路类型任一变化 → 立即记录（定位“何时断、断成什么”）；
 * 2. 状态未变但仍失败 → 节流记录，确认故障是否持续；
 * 3. 状态未变且正常 → 不记录。
 */
function recordProbe(entry, remote, next, elapsedMs) {
  const prev = entry.probeState || {};
  const changed = prev.status !== next.status || prev.online !== next.online || prev.transport !== next.transport;
  const failing = next.online === false || next.status === 'offline' || next.status === 'needs_auth';
  const now = Date.now();
  if (!changed && !(failing && now - (entry.lastFailureLogAt || 0) >= PROBE_FAILURE_LOG_INTERVAL_MS)) return;
  if (failing) entry.lastFailureLogAt = now;
  logNet(changed ? 'probe.change' : 'probe.still_failing', {
    routeId: remote.id,
    deviceId: remote.deviceId || '',
    type: remote.transport || '',
    url: sanitizeUrl(remote.url),
    from: prev.status || '',
    to: next.status,
    online: next.online,
    transport: next.transport || '',
    stage: next.stage || '',
    httpStatus: next.httpStatus || 0,
    errorCode: next.errorCode || '',
    elapsedMs,
  });
}

/**
 * 识别远程 URL 的传输通道类型（供「局域网 > IPv6 > 内网穿透」优先级优选）：
 * - 若响应头包含 Cloudflare 隧道特征 (cf-ray / server: cloudflare) 则归为 tunnel（内网穿透）；
 * - 若使用 IPv6 字面量、连接的底层 Socket 为 IPv6、域名含 ipv6/ddns 或带非标准直连端口（如 :8443）则归为 ipv6；
 * - 其余标准 443/80 反向代理域名归为 tunnel（内网穿透）。
 */
export function classifyRemoteTransport(rawUrl, resHeaders = {}, remoteFamily = '', configuredTransport = '') {
  // 用户确认的通路类型优先于端口/DNS 启发式，避免 LAN 路由被 31990 等非标准端口误标为 IPv6。
  if (configuredTransport === 'lan' || configuredTransport === 'ipv6' || configuredTransport === 'tunnel') return configuredTransport;
  const cfRay = resHeaders?.['cf-ray'];
  const srvHeader = String(resHeaders?.server || '').toLowerCase();
  if (cfRay || srvHeader.includes('cloudflare') || srvHeader.includes('frp')) {
    return 'tunnel';
  }
  if (remoteFamily === 'IPv6') {
    return 'ipv6';
  }
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    if (host.startsWith('[') || host.includes(':') || host.includes('ipv6') || host.includes('ddns')) {
      return 'ipv6';
    }
    if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
      return 'ipv6';
    }
  } catch {}
  return 'tunnel';
}

/** 返回远端 dsh-au 状态接口的子路径与根路径候选，兼容部署在 /dsh/ 等反向代理子路径下的 DSH。 */
function statusApiCandidates(target) {
  const prefix = target.pathname.endsWith('/') ? target.pathname : `${target.pathname}/`;
  const nested = new URL(target.origin);
  nested.pathname = `${prefix}dsh-au/api`;
  const root = new URL('/dsh-au/api', target.origin);
  return [...new Map([nested, root].map((url) => [url.href, url])).values()];
}

/** 请求一个候选状态接口；仅接受 dsh-au 返回的 JSON status，避免把任意 200 误判为空闲。 */
async function requestRemoteStatus(target, remote, cookieJar, timeoutMs) {
  const headers = buildUpstreamHeaders({}, target, {
    basicAuth: { username: remote.username, password: remote.password },
    cookieJar,
  });
  return new Promise((resolve) => {
    createUpstreamRequest(target, {
      method: 'GET',
      headers,
      timeout: timeoutMs,
    }, routeProxy(remote)).then((request) => {
      request.once('response', (res) => {
        if (res.headers['set-cookie'] && cookieJar) cookieJar.capture(res.headers['set-cookie']);
        const code = res.statusCode || 0;
        if (code === 401 || code === 407) {
          res.resume();
          resolve({ kind: 'needs_auth', httpStatus: code });
          return;
        }
        if (code < 200 || code >= 300) {
          res.resume();
          resolve({ kind: 'unavailable', httpStatus: code });
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { if (body.length < 256 * 1024) body += chunk; });
        res.on('end', () => {
          try {
            const self = JSON.parse(body)?.self;
            const status = self?.status;
            if (status === 'busy' || status === 'done' || status === 'idle' || status === 'error') {
              resolve({
                kind: 'status',
                status,
                // 新版远端附带的扩展字段；旧版远端没有这些字段，行为与之前完全一致。
                statusV2: LIGHTS_V2.includes(self.statusV2) ? self.statusV2 : undefined,
                waitingCount: Number(self.waitingCount) || 0,
                sessionStatesV2: sanitizeSessionStatesV2(self.sessionStatesV2),
                sessionStateDetails: sanitizeSessionStateDetails(self.sessionStateDetails, self.sessionStateVersion),
                sessionStateVersion: self.sessionStateVersion === 1 ? 1 : undefined,
                runningCount: Number(self.runningCount) || 0,
                instanceId: typeof self.instanceId === 'string' ? self.instanceId : '',
                hostname: typeof self.hostname === 'string' ? self.hostname : '',
                ips: Array.isArray(self.ips) ? self.ips.filter((ip) => typeof ip === 'string') : [],
                httpStatus: code,
              });
              return;
            }
          } catch {}
          resolve({ kind: 'unavailable', httpStatus: code });
        });
        res.on('error', () => resolve({ kind: 'unavailable', httpStatus: code }));
      });
      request.once('timeout', () => { request.destroy(); resolve({ kind: 'unavailable' }); });
      request.once('error', () => resolve({ kind: 'unavailable' }));
      request.end();
    }).catch(() => resolve({ kind: 'unavailable' }));
  });
}

/** 只验证远端首页可达：状态接口不存在时仍显示在线，但以 unknown 明确避免误报绿灯。 */
async function probeRemoteReachability(target, remote, cookieJar, timeoutMs) {
  const headers = buildUpstreamHeaders({}, target, {
    basicAuth: { username: remote.username, password: remote.password },
    cookieJar,
  });
  return new Promise((resolve) => {
    const fallback = (errorCode = 'ERROR') => ({
      status: 'offline', online: false, errorCode,
      transport: classifyRemoteTransport(target.href, {}, '', remote.transport),
    });
    createUpstreamRequest(target, {
      method: 'GET',
      headers,
      timeout: timeoutMs,
    }, routeProxy(remote)).then((req) => {
      req.once('response', (res) => {
        if (res.headers['set-cookie'] && cookieJar) cookieJar.capture(res.headers['set-cookie']);
        res.resume();
        const code = res.statusCode || 0;
        const transport = classifyRemoteTransport(target.href, res.headers, res.socket?.remoteFamily, remote.transport);
        if (code === 401 || code === 407) {
          const hasSavedCredentials = Boolean(remote.password);
          // 仅保存用户名而没有密码时，仍需让用户补填密码；完整凭据失效才视为不可访问，不强迫重复填写。
          resolve(hasSavedCredentials
            ? { status: 'offline', accessReason: 'upstream_denied', online: false, httpStatus: code, transport }
            : { status: 'needs_auth', accessReason: 'credentials_required', online: true, httpStatus: code, transport });
        }
        else if (code >= 200 && code < 500) resolve({ status: 'unknown', online: true, httpStatus: code, transport });
        else resolve({ status: 'offline', online: false, httpStatus: code, transport });
      });
      // errorCode 仅供诊断日志区分“超时 / 拒绝连接 / 重置”，不参与状态判断。
      req.once('timeout', () => { req.destroy(); resolve(fallback('TIMEOUT')); });
      req.once('error', (err) => resolve(fallback(err?.code || 'ERROR')));
      req.end();
    }).catch((error) => resolve(fallback(error?.code || 'ERROR')));
  });
}

/** 探测远程 DSH 节点的连通性、Basic Auth 鉴权状态与实际忙闲状态。 */
export async function probeRemoteTarget(remote, cookieJar, timeoutMs = 4500) {
  let target;
  try {
    target = new URL(remote.url);
  } catch {
    return { status: 'offline', online: false, transport: remote.transport === 'ipv6' ? 'ipv6' : 'tunnel' };
  }

  // 首页才是远端实际登录入口；已有凭据的不可达路径不会要求用户重新输入密码。
  // 状态接口的 401/404 可能只是反向代理的路径规则，不能把可用首页误判为登录失效。
  const reachability = await probeRemoteReachability(target, remote, cookieJar, timeoutMs);
  // stage 标记结论来自哪一步：home=首页探测、status=状态接口、status_miss=首页可达但状态接口不可用。
  if (reachability.status === 'needs_auth' || reachability.status === 'offline') return { ...reachability, stage: 'home' };

  for (const candidate of statusApiCandidates(target)) {
    const result = await requestRemoteStatus(candidate, remote, cookieJar, timeoutMs);
    if (result.kind === 'status') {
      return {
        status: result.status,
        statusV2: result.statusV2,
        waitingCount: result.waitingCount,
        sessionStatesV2: result.sessionStatesV2,
        sessionStateDetails: result.sessionStateDetails,
        sessionStateVersion: result.sessionStateVersion,
        runningCount: result.runningCount,
        instanceId: result.instanceId,
        hostname: result.hostname,
        ips: result.ips,
        online: true,
        httpStatus: result.httpStatus,
        stage: 'status',
        transport: reachability.transport || classifyRemoteTransport(remote.url, {}, '', remote.transport),
      };
    }
  }
  return { ...reachability, stage: 'status_miss' };
}

/**
 * 为每个远程域名分配独立的本机回环代理端口 (http://127.0.0.1:<port>/)：
 * 确保远程 DSH 页面内的根路径静态资源 (/assets/...)、接口 (/api/...) 与 WebSocket 全部落在该独立源下
 */
export function createRemoteProxyPool({ onRemoteIdentity, getAllowedOrigins } = {}) {
  const entries = new Map();
  // 锁屏断开后为 true：不再监听代理端口，探活和状态同步也不能把连接拉回来。
  let connectionsSuspended = false;

  function closeRecord(entry) {
    try {
      for (const socket of entry.sockets) socket.destroy();
      entry.server?.closeAllConnections?.();
      entry.server?.close();
    } catch {}
  }

  function closeAll() {
    for (const entry of entries.values()) closeRecord(entry);
    entries.clear();
  }

  /** 锁屏期间给界面一个离线快照，不分配新的本机代理端口。 */
  function suspendedRemoteView(remote) {
    return {
      id: remote.id,
      name: remote.name,
      originUrl: remote.url,
      hasCredentials: Boolean(remote.username || remote.password),
      username: remote.username || '',
      proxyUrl: '',
      status: 'offline',
      statusV2: 'offline',
      waitingCount: 0,
      sessionStatesV2: {},
      sessionStateDetails: {},
      sessionStateVersion: 1,
      accessReason: '',
      runningCount: 0,
      instanceId: '',
      deviceId: remote.deviceId || '',
      hostname: '',
      ips: [],
      transport: remote.transport || '',
      upstreamProxyUrl: remote.proxyUrl || '',
      online: false,
      probeCompleted: false,
      kind: 'remote',
    };
  }

  // 宿主提供运行期的精确主 GUI origins；缺失/异常绝不回退为所有 localhost 端口。
  function allowedOrigins() {
    try {
      const origins = getAllowedOrigins?.();
      return Array.isArray(origins) ? origins : [];
    } catch {
      return [];
    }
  }

  async function ensureProxy(remote) {
    if (connectionsSuspended) return null;
    let entry = entries.get(remote.id);
    if (entry) {
      // 首页快照与后台探测可能同时创建代理，等待同一监听结果而非重复分配端口。
      await entry.ready;
      // 改址后的稳定 ID 不得沿用旧机身份，避免优选逻辑把两台机器合成一台。
      if (entry.remote.url !== remote.url) {
        entry.lastIdentity = remote.knownIdentity || null;
        entry.probeState = { status: 'unknown', online: true, probeCompleted: false };
        entry.probeRevision += 1;
        // 改址后的旧探测只写旧 Cookie 罐，不能污染新目标。
        entry.cookieJar = createCookieJar();
        entry.assetCache.clear();
      }
      entry.remote = { ...remote };
      return entry;
    }
    const cookieJar = createCookieJar();
    const assetCache = new Map();
    const record = {
      remote: { ...remote },
      cookieJar,
      assetCache,
      server: null,
      port: 0,
      // 未探测不假装空闲；仍允许用户手动尝试，但客户端不能据此预加载。
      probeState: { status: 'unknown', online: true, probeCompleted: false },
      probeRevision: 0,
      sockets: new Set(),
      // 认证曾成功时持久化的身份可在凭据临时失效后继续支撑同机归并。
      lastIdentity: remote.knownIdentity || null,
    };

    const srv = http.createServer((req, res) => {
      const cur = record.remote;
      const requestId = randomUUID();
      const path = sanitizePath(req.url);
      const basePath = new URL(cur.url).pathname;
      // 仅诊断界面冷加载的首页、插件与静态资源；业务 API 快慢不额外刷屏。
      const isLoadRequest = req.method === 'GET' && (path === '/' || path === basePath || path === `${basePath.replace(/\/$/, '')}/` || path.includes('/assets/') || path.includes('/plugins/'));
      // 传入完整 cur.url（含 /dsh/ 等子路径与 query），由 proxy-core 统一补齐子路径前缀并缓存大体积静态包
      proxyHttpRequest(req, res, cur.url, {
        allowedOrigins: allowedOrigins(),
        upstreamProxy: routeProxy(cur),
        basicAuth: { username: cur.username, password: cur.password },
        cookieJar: record.cookieJar,
        assetCache: record.assetCache,
        onTrace(kind, info) {
          // 静态资源成功不刷屏；失败只记标量码与 pathname，不记响应内容或错误消息。
          if (kind !== 'error' && info.statusCode < 400) return;
          logNet(`remote.http.${kind}`, {
            routeId: cur.id, deviceId: cur.deviceId || '', requestId, path,
            httpStatus: info.statusCode || 0, errorCode: info.errorCode || '',
            result: kind === 'error' ? 'error' : 'http-error', elapsedMs: info.elapsedMs || 0,
            firstCause: info.firstCause || '',
            upstreamComplete: info.upstreamComplete ?? null, upstreamAborted: info.upstreamAborted === true,
            ttfbMs: info.ttfbMs ?? null, bytesReceived: info.bytesReceived ?? 0,
          });
        },
        onTransferTrace(kind, info) {
          if (!isLoadRequest || info.statusCode >= 400) return;
          let event;
          if (kind === 'headers' || kind === 'complete') {
            if (info.statusCode < 200 || info.elapsedMs < 2000) return;
            event = 'remote.http.slow';
          } else if (kind === 'pending' || kind === 'aborted') event = `remote.http.${kind}`;
          else return;
          // pending 仅表示15秒尚未完成，不推断断线或停滞；所有字段均为标量指标。
          logNet(event, {
            routeId: cur.id, deviceId: cur.deviceId || '', requestId, path,
            stage: info.stage, result: info.result, httpStatus: info.statusCode || 0,
            ttfbMs: info.ttfbMs, bytesReceived: info.bytesReceived,
            cacheHit: info.cacheHit === true, elapsedMs: info.elapsedMs,
            firstCause: info.firstCause || '',
            upstreamComplete: info.upstreamComplete ?? null, upstreamAborted: info.upstreamAborted === true,
          });
        },
      });
    });

    srv.on('upgrade', (req, socket, head) => {
      const cur = record.remote;
      const connectionId = randomUUID();
      record.sockets.add(socket);
      socket.once('close', () => record.sockets.delete(socket));
      proxyWebSocketUpgrade(req, socket, head, cur.url, {
        allowedOrigins: allowedOrigins(),
        upstreamProxy: routeProxy(cur),
        basicAuth: { username: cur.username, password: cur.password },
        cookieJar: record.cookieJar,
        onTrace(kind, info) {
          logNet(`remote.ws.${kind}`, {
            routeId: cur.id, deviceId: cur.deviceId || '', connectionId, path: sanitizePath(req.url),
            direction: info.direction, result: info.result, httpStatus: info.statusCode || 0,
            errorCode: info.errorCode || '', elapsedMs: info.elapsedMs || 0,
            firstCause: info.firstCause || '', phase: info.phase || '',
            clientBytes: info.clientBytes ?? 0, upstreamBytes: info.upstreamBytes ?? 0,
            clientIdleMs: info.clientIdleMs ?? null, upstreamIdleMs: info.upstreamIdleMs ?? null,
          });
        },
      });
    });

    record.server = srv;
    record.ready = new Promise((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        record.port = srv.address().port;
        srv.removeListener('error', reject);
        resolve();
      });
    });
    // 先发布正在监听的记录，后来的调用等待 ready；避免两个临时代理相互覆盖。
    entries.set(remote.id, record);
    try {
      await record.ready;
    } catch (err) {
      if (entries.get(remote.id) === record) entries.delete(remote.id);
      throw err;
    }
    // 监听完成前如果已经锁屏，马上关掉刚打开的端口，避免断开后又连上。
    if (connectionsSuspended) {
      closeRecord(record);
      if (entries.get(remote.id) === record) entries.delete(remote.id);
      return null;
    }
    return record;
  }

  /**
   * 复用已建立的远程路线、Basic Auth 与 Cookie 罐转发 JSON 操作。
   * 插件消费者只按 routeId 调用，绝不读取或复制 dsh-au 的网络鉴权配置。
   */
  async function requestJson(remoteId, requestPath, body = {}, timeoutMs = 8_000) {
    const entry = entries.get(remoteId);
    if (!entry) return { ok: false, error: '未找到已连接的 dsh-au 远程路线' };
    let target;
    try {
      target = resolveUpstreamUrl(requestPath, entry.remote.url);
    } catch {
      return { ok: false, error: '远程请求路径无效' };
    }
    const serialized = JSON.stringify(body);
    const headers = buildUpstreamHeaders({ 'content-type': 'application/json' }, target, {
      basicAuth: { username: entry.remote.username, password: entry.remote.password },
      cookieJar: entry.cookieJar,
    });
    headers['content-length'] = Buffer.byteLength(serialized);
    return new Promise((resolve) => {
      createUpstreamRequest(target, { method: 'POST', headers, timeout: timeoutMs }, routeProxy(entry.remote)).then((request) => {
        request.once('response', (response) => {
          if (response.headers['set-cookie']) entry.cookieJar.capture(response.headers['set-cookie']);
          let raw = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => { if (raw.length < 512 * 1024) raw += chunk; });
          response.on('end', () => {
            try {
              const payload = JSON.parse(raw);
              resolve({ ...payload, httpStatus: response.statusCode || 0 });
            } catch {
              resolve({ ok: false, error: `远程返回无效 JSON（HTTP ${response.statusCode || 0}）` });
            }
          });
        });
        request.once('timeout', () => { request.destroy(); resolve({ ok: false, error: '远程请求超时' }); });
        request.once('error', () => resolve({ ok: false, error: '远程请求失败' }));
        request.end(serialized);
      }).catch(() => resolve({ ok: false, error: '远程请求失败' }));
    });
  }

  return {
    ensureProxy,
    requestJson,
    async syncRemotes(remotes) {
      if (connectionsSuspended) return remotes.map(suspendedRemoteView);
      const keepIds = new Set(remotes.map((r) => r.id));
      for (const [id, entry] of entries.entries()) {
        if (!keepIds.has(id)) {
          try {
            for (const socket of entry.sockets) socket.destroy();
            entry.server?.closeAllConnections?.();
            entry.server?.close();
          } catch {}
          entries.delete(id);
        }
      }
      const list = [];
      for (const r of remotes) {
        const entry = await ensureProxy(r);
        if (!entry) {
          list.push(suspendedRemoteView(r));
          continue;
        }
        let subpath = '/';
        try {
          const parsed = new URL(r.url);
          const normPath = !parsed.pathname || parsed.pathname === '/'
            ? '/'
            : (parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`);
          subpath = `${normPath}${parsed.search || ''}`;
        } catch {}
        list.push({
          id: r.id,
          name: r.name,
          originUrl: r.url,
          hasCredentials: Boolean(r.username || r.password),
          username: r.username || '',
          proxyUrl: `http://127.0.0.1:${entry.port}${subpath}`,
          status: entry.probeState.status,
          statusV2: entry.probeState.statusV2,
          waitingCount: entry.probeState.waitingCount || 0,
          sessionStatesV2: entry.probeState.sessionStatesV2,
          sessionStateDetails: entry.probeState.sessionStateDetails,
          sessionStateVersion: entry.probeState.sessionStateVersion,
          accessReason: entry.probeState.accessReason || '',
          runningCount: entry.probeState.runningCount || 0,
          instanceId: entry.probeState.instanceId || entry.lastIdentity?.instanceId || '',
          deviceId: r.deviceId || '',
          hostname: entry.probeState.hostname || entry.lastIdentity?.hostname || '',
          ips: entry.probeState.ips?.length ? entry.probeState.ips : (entry.lastIdentity?.ips || []),
          transport: r.transport || entry.probeState.transport || classifyRemoteTransport(r.url, {}, '', r.transport),
          // 仅是本机无凭据的 Clash 地址，便于编辑当前路线；云清单不会携带此字段。
          upstreamProxyUrl: r.proxyUrl || '',
          online: entry.probeState.online,
          probeCompleted: entry.probeState.probeCompleted === true,
          kind: 'remote',
        });
      }
      return list;
    },
    async probeAll(remotes) {
      if (connectionsSuspended) return;
      await Promise.all(
        remotes.map(async (r) => {
          const entry = await ensureProxy(r);
          if (!entry) return;
          const startedAt = Date.now();
          const probedRemote = { ...r };
          const revision = ++entry.probeRevision;
          const nextState = await probeRemoteTarget(probedRemote, entry.cookieJar);
          // 改址、删除或较新的探测发生后，迟到结果不能覆盖当前目标的状态/身份。
          if (entries.get(r.id) !== entry || entry.remote.url !== probedRemote.url || entry.probeRevision !== revision) return;
          nextState.probeCompleted = true;
          recordProbe(entry, probedRemote, nextState, Date.now() - startedAt);
          if (nextState.instanceId || nextState.hostname) {
            const identity = {
              instanceId: nextState.instanceId || entry.lastIdentity?.instanceId || '',
              hostname: nextState.hostname || entry.lastIdentity?.hostname || '',
              ips: nextState.ips?.length ? nextState.ips : (entry.lastIdentity?.ips || []),
            };
            entry.lastIdentity = identity;
            // 仅把远端实际返回的身份写入缓存；认证失效后仍可稳定归并同一物理机。
            if (JSON.stringify(r.knownIdentity || null) !== JSON.stringify(identity)) {
              r.knownIdentity = identity;
              onRemoteIdentity?.(r.id, identity);
            }
          }
          entry.probeState = nextState;
        })
      );
    },
    suspendConnections() {
      connectionsSuspended = true;
      closeAll();
    },
    resumeConnections() {
      connectionsSuspended = false;
    },
    isConnectionsSuspended() {
      return connectionsSuspended;
    },
    stopAll() {
      closeAll();
    },
  };
}
