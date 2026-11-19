import http from 'node:http';
import { getLocalHostInfo } from './config-store.js';
import { createCookieJar, proxyHttpRequest, proxyWebSocketUpgrade, rejectUntrustedProxyOrigin } from './proxy-core.js';
import { logNet, sanitizePath } from './net-log.js';

// 桥接诊断阈值：超过 SLOW_MS 记慢请求；超过 STALL_MS 仍无上游响应记“卡住”。
const SLOW_MS = 2000;
const STALL_MS = 5000;

/**
 * 本机局域网免密桥接服务 (0.0.0.0:<bridgePort>)：
 * - 响应 /__dsh_au_ping 供局域网其他电脑自发现与状态同步
 * - 自动通过宿主 connection.authenticatedUrl 换取本机 BrowserAuth 会话 Cookie
 * - 将局域网内其他电脑的 HTTP 与 WebSocket 请求免密桥接到本机 127.0.0.1:<localDshPort>
 */
export function createLanBridge({ instanceId, preferredPort, getLanShareEnabled, getLocalDshTarget, getStatus, getDeviceId, getAllowedOrigins }) {
  const cookieJar = createCookieJar();
  let server = null;
  let boundPort = 0;
  let bootstrappedAuthUrl = '';
  let bootstrapPromise = null;

  /** 与远程池共享宿主的显式可信入口；注册 hostname 必须由宿主配置授信，不从 Host 猜。 */
  function trustedOrigins(localOrigin) {
    const origins = localOrigin ? [localOrigin] : [];
    try {
      const configured = getAllowedOrigins?.();
      if (Array.isArray(configured)) origins.push(...configured);
    } catch {}
    return origins;
  }

  /** 单飞换取本机 BrowserAuth 会话 Cookie；若宿主无需 Cookie 或端口未变则不重复请求 */
  async function ensureLocalSessionCookie(targetOrigin) {
    const { authUrl } = getLocalDshTarget();
    if (!authUrl) return;
    if (bootstrappedAuthUrl === authUrl) return;
    if (bootstrapPromise) {
      await bootstrapPromise;
      return;
    }
    bootstrapPromise = new Promise((resolve) => {
      const req = http.get(authUrl, { headers: { host: new URL(targetOrigin).host } }, (res) => {
        if (res.headers['set-cookie']) cookieJar.capture(res.headers['set-cookie']);
        res.resume();
        bootstrappedAuthUrl = authUrl;
        resolve();
      });
      req.on('error', (err) => {
        // 换取本机会话失败会让后续转发全部 401/挂起，单独记录便于定位。
        logNet('bridge.bootstrap_error', { errorCode: err?.code || 'ERROR' });
        bootstrappedAuthUrl = '';
        resolve();
      });
    }).finally(() => {
      bootstrapPromise = null;
    });
    await bootstrapPromise;
  }

  function handleRequest(req, res) {
    if (req.url?.startsWith('/__dsh_au_ping')) {
      if (!getLanShareEnabled()) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, disabled: true }));
        return;
      }
      const { hostname } = getLocalHostInfo();
      const { status, statusV2, runningCount, waitingCount } = getStatus();
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      // deviceId 是云清单里的设备绑定，不含密码；扫描端靠它把探测地址写到对应 lan 路径。
      // status / runningCount 保持旧四值语义供旧设备读取，statusV2 / waitingCount 是新版设备可选读取的扩展。
      res.end(JSON.stringify({
        ok: true,
        dshAu: true,
        instanceId,
        deviceId: getDeviceId?.() || '',
        hostname,
        status,
        statusV2,
        runningCount,
        waitingCount,
        bridgePort: boundPort,
      }));
      return;
    }
    if (!getLanShareEnabled()) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('本机已关闭局域网免密接入（可在 dsh-au 顶部栏开启）');
      return;
    }
    const { origin } = getLocalDshTarget();
    const allowedOrigins = trustedOrigins(origin);
    // 必须先拒绝外来网页，再换取本机 BrowserAuth 会话；core 转发时仍会复核。
    if (rejectUntrustedProxyOrigin(req, res, allowedOrigins)) return;
    if (!origin) {
      logNet('bridge.no_local_dsh', { path: sanitizePath(req.url) });
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('本机 DSH 服务端口尚未就绪');
      return;
    }
    const trace = createRequestTrace(req, res);
    void ensureLocalSessionCookie(origin).then(() => {
      trace.mark('bootstrap_done');
      proxyHttpRequest(req, res, origin, { cookieJar, allowedOrigins, onTrace: trace.onUpstream });
    });
  }

  /**
   * 单个桥接请求的诊断追踪，用阶段区分“卡在哪一层”：
   * - bootstrap：等待换取本机 BrowserAuth Cookie；
   * - upstream：已转发给本机 DSH，等待首包。
   * 正常快速请求不落盘；慢请求、出错、超过 STALL_MS 仍未响应、调用方提前断开才记录。
   */
  function createRequestTrace(req, res) {
    const startedAt = Date.now();
    const path = sanitizePath(req.url);
    const remote = req.socket?.remoteAddress || '';
    let stage = 'bootstrap';
    let bootstrapMs = -1;
    let responded = false;
    const elapsed = () => Date.now() - startedAt;
    const stallTimer = setTimeout(() => {
      logNet('bridge.stalled', { path, method: req.method, remote, stage, bootstrapMs, elapsedMs: elapsed() });
    }, STALL_MS);
    stallTimer.unref?.();
    res.on('close', () => {
      clearTimeout(stallTimer);
      // 未拿到上游响应就被关闭：通常是对端探测超时放弃，正是“局域网无法访问”的现场。
      if (!responded) logNet('bridge.aborted', { path, method: req.method, remote, stage, bootstrapMs, elapsedMs: elapsed() });
    });
    return {
      mark(name) {
        if (name === 'bootstrap_done') {
          bootstrapMs = elapsed();
          stage = 'upstream';
          if (bootstrapMs >= SLOW_MS) logNet('bridge.bootstrap_slow', { path, bootstrapMs, authed: Boolean(bootstrappedAuthUrl) });
        }
      },
      onUpstream(kind, info) {
        responded = true;
        clearTimeout(stallTimer);
        const totalMs = elapsed();
        if (kind === 'error') logNet('bridge.upstream_error', { path, method: req.method, remote, bootstrapMs, elapsedMs: totalMs, ...info });
        else if (totalMs >= SLOW_MS) logNet('bridge.slow', { path, method: req.method, remote, bootstrapMs, elapsedMs: totalMs, ...info });
      },
    };
  }

  return {
    async start() {
      if (server) return boundPort;
      for (let offset = 0; offset < 20; offset += 1) {
        const tryPort = preferredPort + offset;
        const ok = await new Promise((resolve) => {
          const srv = http.createServer(handleRequest);
          srv.on('upgrade', (req, socket, head) => {
            if (!getLanShareEnabled()) { socket.destroy(); return; }
            const { origin } = getLocalDshTarget();
            const allowedOrigins = trustedOrigins(origin);
            if (rejectUntrustedProxyOrigin(req, socket, allowedOrigins)) return;
            if (!origin) { socket.destroy(); return; }
            void ensureLocalSessionCookie(origin).then(() => {
              proxyWebSocketUpgrade(req, socket, head, origin, { cookieJar, allowedOrigins });
            });
          });
          srv.once('error', () => resolve(false));
          srv.listen(tryPort, '0.0.0.0', () => {
            server = srv;
            boundPort = srv.address().port;
            resolve(true);
          });
        });
        if (ok) return boundPort;
      }
      return 0;
    },
    getPort: () => boundPort,
    stop() {
      if (server) {
        try {
          server.closeAllConnections?.();
          server.close();
        } catch {}
        server = null;
        boundPort = 0;
      }
    },
  };
}
