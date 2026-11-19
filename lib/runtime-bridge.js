import http from 'node:http';
import https from 'node:https';
import { resolveUpstreamUrl } from './proxy-core.js';
import { getSharedDevices } from './config-store.js';
import {
  createTodoFollowupMessage,
  hasSessionAcceptedMessage,
  listConversationSummaries,
  listLocalWorkspaces,
} from './session-reader.js';

function isRouteReady(route) {
  return route.online !== false && route.status !== 'offline' && route.status !== 'needs_auth';
}

function transportRank(route) {
  if (route.kind === 'lan' || route.transport === 'lan') return 3;
  if (route.transport === 'ipv6') return 2;
  return 1;
}

function sortRoutes(routes) {
  return [...routes].sort((left, right) => {
    const readyDiff = Number(isRouteReady(right)) - Number(isRouteReady(left));
    if (readyDiff !== 0) return readyDiff;
    return transportRank(right) - transportRank(left);
  });
}

/** 复用局域网免密桥接转发 JSON 请求；局域网桥本身已完成目标本机 Cookie 换取。 */
function requestLanJson(baseUrl, requestPath, body = {}, timeoutMs = 8_000) {
  let target;
  try {
    target = resolveUpstreamUrl(requestPath, baseUrl);
  } catch {
    return Promise.resolve({ ok: false, error: '局域网请求路径无效' });
  }
  const serialized = JSON.stringify(body);
  const isHttps = target.protocol === 'https:';
  const client = isHttps ? https : http;
  return new Promise((resolve) => {
    const req = client.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      method: 'POST',
      path: `${target.pathname}${target.search}`,
      headers: {
        host: target.host,
        origin: target.origin,
        referer: target.href,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(serialized),
      },
      timeout: timeoutMs,
      rejectUnauthorized: false,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (raw.length < 512 * 1024) raw += chunk; });
      res.on('end', () => {
        try {
          const payload = JSON.parse(raw);
          resolve({ ...payload, httpStatus: res.statusCode || 0 });
        } catch {
          resolve({ ok: false, error: `局域网返回无效 JSON（HTTP ${res.statusCode || 0}）`, httpStatus: res.statusCode || 0 });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '局域网请求超时' }); });
    req.on('error', () => resolve({ ok: false, error: '局域网请求失败' }));
    req.end(serialized);
  });
}

/** 判断公共设备定义是否属于当前宿主本机（显式绑定或局域网路由 IP 命中本机网卡），防止未绑定归属时把本机当成远程设备自转发。 */
function isLocalSharedDevice(device, config, localIps) {
  if (config?.localDeviceId && device?.id === config.localDeviceId) return true;
  if (!localIps?.size) return false;
  return (device?.routes || []).some((route) => {
    if (route.type !== 'lan' && route.transport !== 'lan' && route.kind !== 'lan') return false;
    try { return localIps.has(new URL(route.url || route.originUrl || '').hostname); } catch { return false; }
  });
}

/**
 * 为同进程插件提供 dsh-au 的唯一多机通道。
 * 暴露的数据不包含远程 URL、用户名、密码或 Cookie；跨机调用只允许由 routeId 路由。
 */
export function createRuntimeBridge({ ctx, getConfig, remotePool, statusTracker, getLocalHostInfo }) {
  function resolveLocalDeviceId(config = getConfig()) {
    if (config?.localDeviceId) return config.localDeviceId;
    const { ips } = getLocalHostInfo?.() || {};
    const localIps = new Set((ips || []).filter((ip) => typeof ip === 'string'));
    const matched = getSharedDevices().find((device) => isLocalSharedDevice(device, config, localIps));
    return matched?.id || 'local';
  }

  async function collectDeviceGroups() {
    const config = getConfig();
    const { ips } = getLocalHostInfo?.() || {};
    const localIps = new Set((ips || []).filter((ip) => typeof ip === 'string'));
    const remoteById = new Map((await remotePool.syncRemotes(config.remotes)).map((route) => [route.id, route]));
    const statusRank = { error: 6, waiting: 5, busy: 4, done: 3, idle: 2, unknown: 1, needs_auth: 1, offline: 0 };

    // 设备归属只读取公共账本的 devices[].routes[]，同时剔除当前本机（含未显式绑定但局域网 IP 命中的本机），避免跨机请求自环。
    return getSharedDevices()
      .filter((device) => !isLocalSharedDevice(device, config, localIps))
      .map((device) => {
        const routes = device.routes.map((definition) => {
          if (definition.type === 'local') {
            return { ...definition, deviceId: device.id, name: device.name, kind: 'local', transport: 'local', status: 'offline', online: false };
          }
          const runtime = remoteById.get(definition.id);
          return runtime
            ? { ...runtime, ...definition, deviceId: device.id, name: device.name, kind: definition.type === 'lan' ? 'lan' : 'remote', transport: definition.type }
            : { ...definition, deviceId: device.id, name: device.name, kind: definition.type === 'lan' ? 'lan' : 'remote', transport: definition.type, status: 'offline', online: false };
        });
        const sorted = sortRoutes(routes);
        const best = sorted[0] || null;
        const status = [...sorted].sort((a, b) => (statusRank[b.status] ?? 0) - (statusRank[a.status] ?? 0))[0]?.status || 'offline';
        // 新版远端才有 statusV2；旧版远端回落到旧四值，行为不变。
        const effective = (route) => route.statusV2 || route.status;
        const statusV2 = effective([...sorted].sort((a, b) => (statusRank[effective(b)] ?? 0) - (statusRank[effective(a)] ?? 0))[0] || {}) || 'offline';
        const readyRoute = sorted.find(isRouteReady) || best;
        return {
          deviceId: device.id,
          routeId: best?.id || '',
          name: device.name,
          status,
          statusV2,
          waitingCount: readyRoute?.waitingCount || 0,
          sessionStatesV2: readyRoute?.sessionStatesV2,
          sessionStateDetails: readyRoute?.sessionStateDetails,
          sessionStateVersion: readyRoute?.sessionStateVersion,
          online: sorted.some(isRouteReady),
          aliases: [device.id, ...routes.map((route) => route.id)],
          routes: sorted,
        };
      });
  }

  async function getDevices() {
    const groups = await collectDeviceGroups();
    return groups.map(({ routes, ...device }) => device);
  }

  async function requestRoute(route, path, body) {
    return route.kind === 'lan' && route.url
      ? requestLanJson(route.url, path, body)
      : remotePool.requestJson(route.id, path, body);
  }

  /** exact route 专供会话级远程模型请求；不参与旧 requestDevice 的多路回退。 */
  async function requestDeviceRoute(deviceId, path, body, routeId) {
    const groups = await collectDeviceGroups();
    const target = groups.find((item) => item.deviceId === deviceId);
    if (!target) {
      const localDevice = getSharedDevices().find((device) => device.id === deviceId);
      return localDevice?.routes?.some((route) => route.type === 'local')
        ? { ok: false, status: 400, error: '不支持 local route' }
        : { ok: false, status: 400, error: '目标设备不在 dsh-au 已连接设备中' };
    }
    const route = target.routes.find((item) => item.id === routeId);
    if (!route) {
      const belongsElsewhere = groups.some((item) => item.deviceId !== deviceId && item.routes.some((item) => item.id === routeId));
      return { ok: false, status: 400, error: belongsElsewhere ? 'routeId 不属于目标设备' : '目标设备未登记该 routeId' };
    }
    if (route.kind === 'local' || route.type === 'local') {
      return { ok: false, status: 400, error: '不支持 local route' };
    }
    if (!isRouteReady(route)) return { ok: false, status: 400, error: '目标 route 当前不可访问' };
    return requestRoute(route, path, body);
  }

  async function requestDevice(deviceId, path, body, options = {}) {
    if (typeof options?.routeId === 'string' && options.routeId) {
      return requestDeviceRoute(deviceId, path, body, options.routeId);
    }
    const groups = await collectDeviceGroups();
    const target = groups.find((item) =>
      item.deviceId === deviceId
      || item.instanceId === deviceId
      || item.routeId === deviceId
      || item.aliases.includes(deviceId));
    if (!target) return { ok: false, error: '目标设备不在 dsh-au 已连接设备中' };
    const readyRoutes = target.routes.filter(isRouteReady);
    if (!readyRoutes.length) return { ok: false, error: '目标设备当前不可访问' };

    let lastResult = { ok: false, error: '远程请求失败' };
    for (const route of readyRoutes) {
      const res = await requestRoute(route, path, body);
      lastResult = res;
      if (res?.ok === true || res?.type === 'server-response') return res;
      // 旧调用保留 404/405 直返语义；exact route 永远不会走这里。
      if (res?.httpStatus === 404 || res?.httpStatus === 405) return res;
    }
    return lastResult;
  }

  const sessionWrites = new Map();
  const acceptedMessageIds = new Set();

  /** 按会话串行化写入动作，防止并发连点导致同一会话交错入队。 */
  async function withSessionWriteLock(sessionId, operation) {
    const previous = sessionWrites.get(sessionId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(() => operation());
    sessionWrites.set(sessionId, task);
    try {
      return await task;
    } finally {
      if (sessionWrites.get(sessionId) === task) sessionWrites.delete(sessionId);
    }
  }

  async function listLocalSessions(limit = 50) {
    return listConversationSummaries(ctx, statusTracker, limit);
  }

  async function getLocalWorkspaces(limit = 50) {
    return listLocalWorkspaces(ctx, statusTracker, limit);
  }

  async function sendTodo(sessionId, text, options = {}) {
    if (typeof sessionId !== 'string' || !sessionId || typeof text !== 'string' || !text.trim()) {
      return { ok: false, error: '缺少会话或 Todo 内容' };
    }
    const cleanText = text.trim();
    const rawRequestId = typeof options === 'string'
      ? options.trim()
      : (typeof options?.requestId === 'string' ? options.requestId.trim() : '');
    const messageId = rawRequestId ? `dsh-au-todo:${sessionId}:${rawRequestId}` : '';

    return withSessionWriteLock(sessionId, async () => {
      const controller = ctx.get?.('sessionController') || ctx.sessionController;
      if (!controller?.resolveAgent) return { ok: false, error: '当前 DSH 未提供 sessionController' };
      try {
        const resolved = await controller.resolveAgent(sessionId);
        const agent = resolved?.agent;
        if (!agent?.followup && typeof controller.prompt !== 'function') {
          return { ok: false, error: resolved?.error?.message || '目标会话不可继续' };
        }
        // 幂等防重：若内存账本、活跃会话队列或持久化历史已存在同一 messageId，直接确认并视为成功。
        if (messageId && (
          acceptedMessageIds.has(messageId)
          || await hasSessionAcceptedMessage(ctx, sessionId, messageId, agent?.session)
        )) {
          statusTracker?.confirm?.(sessionId);
          return { ok: true, deduplicated: true };
        }
        if (typeof agent?.followup === 'function') {
          agent.followup(createTodoFollowupMessage(cleanText, messageId));
        } else {
          await controller.prompt({
            sessionId,
            requestId: messageId || `dsh-au-todo:${sessionId}:${Date.now()}`,
            mode: 'queue',
            content: [{ type: 'text', text: cleanText }],
          });
        }
        if (messageId) {
          acceptedMessageIds.add(messageId);
          if (acceptedMessageIds.size > 512) {
            const oldest = acceptedMessageIds.values().next().value;
            if (oldest !== undefined) acceptedMessageIds.delete(oldest);
          }
        }
        // 入队后立即触发宿主会话持久化落盘，防止进程异常退出丢失刚投递的消息。
        try {
          const sessionsService = ctx.get?.('sessions') || ctx.sessions;
          if (agent?.session && typeof sessionsService?.flush === 'function') {
            await sessionsService.flush(agent.session);
          }
        } catch {}
        statusTracker?.confirm?.(sessionId);
        return { ok: true };
      } catch {
        return { ok: false, error: 'Todo 投递失败' };
      }
    });
  }

  /** 立即停止目标会话当前正在执行的回合（调用官方 agent.cancel({ kind: 'user' })）。 */
  async function interruptSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) {
      return { ok: false, error: '缺少 sessionId' };
    }
    try {
      const agentsService = ctx.get?.('agents') || ctx.agents;
      let agent = typeof agentsService?.get === 'function' ? agentsService.get(sessionId) : null;
      if (!agent && typeof agentsService?.list === 'function') {
        const list = agentsService.list() || [];
        agent = list.find((item) => (item?.session?.id || item?.id) === sessionId) || null;
      }
      if (typeof agent?.cancel === 'function') {
        await agent.cancel({ kind: 'user' });
        statusTracker?.refresh?.();
        return { ok: true };
      }
      const controller = ctx.get?.('sessionController') || ctx.sessionController;
      if (typeof controller?.cancel === 'function') {
        await controller.cancel({ sessionId });
        statusTracker?.refresh?.();
        return { ok: true };
      }
      return { ok: false, error: '目标会话当前未在运行或不支持停止' };
    } catch {
      return { ok: false, error: '停止会话失败' };
    }
  }

  /** 跨设备确认或投递成功后立即重新探测目标设备，让顶栏蓝灯无需等待 15 秒轮询即可消灯。 */
  async function refreshDevice(deviceId) {
    if (typeof deviceId !== 'string' || !deviceId || typeof remotePool?.probeAll !== 'function') return;
    const config = getConfig();
    const matched = (config.remotes || []).filter((route) => route.deviceId === deviceId || route.id === deviceId);
    if (!matched.length) return;
    let targets = matched;
    // 若该设备存在已连通路由，优先仅探测就绪路由，避免离线局域网路由（4.5s 超时）阻塞状态刷新。
    if (typeof remotePool.syncRemotes === 'function' && matched.length > 1) {
      try {
        const runtimeById = new Map((await remotePool.syncRemotes(config.remotes)).map((item) => [item.id, item]));
        const readyTargets = matched.filter((route) => {
          const runtime = runtimeById.get(route.id);
          return runtime && isRouteReady(runtime);
        });
        if (readyTargets.length) targets = readyTargets;
      } catch {}
    }
    try { await remotePool.probeAll(targets); } catch {}
  }

  return {
    version: 1,
    getLocalDevice() {
      const { hostname } = getLocalHostInfo();
      // 优先使用显式绑定或网卡匹配的公共设备 ID，未匹配时暴露 local。
      return { deviceId: resolveLocalDeviceId(), name: hostname || '本机' };
    },
    getDevices,
    requestDevice,
    requestDeviceRoute,
    refreshDevice,
    listLocalSessions,
    listLocalWorkspaces: getLocalWorkspaces,
    getSessionStatus: (sessionId) => statusTracker.getSessionStatus(sessionId),
    getSessionState: (sessionId) => statusTracker.getSessionState?.(sessionId)
      || { status: statusTracker.getSessionStatus?.(sessionId) || 'idle' },
    confirmSession: (sessionId, expectedEndSeq) => statusTracker.confirm(sessionId, expectedEndSeq),
    sendTodo,
    interruptSession,
  };
}
