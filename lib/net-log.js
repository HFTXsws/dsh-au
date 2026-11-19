import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * dsh-au 网络诊断日志（JSONL，一行一事件）：
 * - 记录探测、页面生命周期、选路变化与代理失败，关联“断线/页面重建”；
 * - 绝不写入密码、Cookie、Authorization 与 URL query（可能含启动 token）；
 * - 单文件超过上限后滚动为 .1，最多保留两份，避免长期运行撑满磁盘。
 */
const MAX_BYTES = 2 * 1024 * 1024;
// 所有旁路事件共用同一实例 ID；不接受客户端伪造 runId。
const RUN_ID = randomUUID();
const CLIENT_EVENTS = new Set([
  'select-device', 'select-local', 'iframe-mounted', 'iframe-unmounted', 'iframe-loaded',
  'iframe-ready', 'iframe-ready-unconfirmed', 'iframe-error', 'iframe-timeout', 'iframe-reload', 'iframe-unavailable',
  'iframe-probe-offline', 'iframe-probe-recovered',
  'shell-started', 'shell-disposed', 'page-hidden', 'page-shown', 'initial-session-focus',
  'remote-workspace-open', 'remote-session-create', 'remote-session-open', 'session-preload', 'session-preload-stage', 'session-open',
]);
const CLIENT_TEXT_FIELDS = ['deviceId', 'clientId', 'documentId', 'frameId', 'routeId', 'fromRouteId', 'fromDeviceId', 'trigger', 'workspaceId', 'sessionId', 'requestId', 'foregroundId', 'stage', 'navigationType', 'reason', 'result', 'errorCode'];

/** 诊断字段只接受短 ID / 枚举；拒绝 URL、query、header 与自由格式错误消息。 */
function diagnosticText(value) {
  if (typeof value !== 'string' || !/^[\p{L}\p{N}_.:-]+$/u.test(value)) return '';
  return value.slice(0, 128);
}

/** 客户端输入是非可信数据：仅复制允许的标量，绝不展开请求体。 */
export function recordClientEvent(body = {}) {
  const event = CLIENT_EVENTS.has(body.event) ? body.event : 'unknown';
  const data = { deviceId: diagnosticText(body.deviceId) };
  for (const key of CLIENT_TEXT_FIELDS) {
    if (body[key] !== undefined) data[key] = diagnosticText(body[key]);
  }
  // 只保留有界时长、计数和布尔值；正文、自由格式错误与性能对象不会落盘。
  for (const key of ['elapsedMs', 'syncMs', 'backendMs', 'pageMs', 'installMs']) {
    if (Number.isFinite(body[key]) && body[key] >= 0 && body[key] <= 86400000) data[key] = Math.round(body[key]);
  }
  for (const key of ['recordCount', 'queueLength', 'generation', 'attempt']) {
    if (Number.isSafeInteger(body[key]) && body[key] >= 0 && body[key] <= 1000000000) data[key] = body[key];
  }
  // knownRemote：切回本机时该会话是否在远端列表中，用于排查误切。
  for (const key of ['cacheHit', 'clientReady', 'knownRemote']) {
    if (typeof body[key] === 'boolean') data[key] = body[key];
  }
  if (Number.isFinite(body.pageAgeMs) && body.pageAgeMs >= 0) data.pageAgeMs = Math.round(body.pageAgeMs);
  if (Number.isInteger(body.httpStatus) && body.httpStatus >= 0 && body.httpStatus <= 599) data.httpStatus = body.httpStatus;
  logNet(`client.${event}`, data);
  return { event, data };
}

/** 保留旧 from/to 字段，同时关联实际页面路线；优选变化不等于页面导航。 */
export function recordRouteChange(body = {}) {
  const data = {
    deviceId: diagnosticText(body.deviceId),
    from: diagnosticText(body.fromRouteId),
    to: diagnosticText(body.toRouteId),
    accessTransport: diagnosticText(body.accessTransport),
    reason: diagnosticText(body.reason),
    clientId: diagnosticText(body.clientId),
    documentId: diagnosticText(body.documentId),
    frameId: diagnosticText(body.frameId),
    routeId: diagnosticText(body.routeId),
    routes: Array.isArray(body.routes) ? body.routes.slice(0, 10).map((route) => ({
      id: diagnosticText(route?.id),
      transport: diagnosticText(route?.transport),
      status: diagnosticText(route?.status),
      online: route?.online !== false,
    })) : [],
  };
  logNet('route.change', data);
  return data;
}

export function resolveNetLogPath() {
  if (process.env.DSH_AU_NET_LOG) return process.env.DSH_AU_NET_LOG;
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(dshHome, 'logs', 'dsh-au-net.jsonl');
}

/** 仅保留协议、主机、端口与路径，丢弃账号密码与 query。 */
export function sanitizeUrl(raw) {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '';
  }
}

/** 路径只保留 pathname，去掉 query，防止启动 token 落盘。 */
export function sanitizePath(raw) {
  const text = String(raw || '');
  const idx = text.indexOf('?');
  return (idx >= 0 ? text.slice(0, idx) : text).slice(0, 200);
}

function rotateIfNeeded(file) {
  try {
    if (statSync(file).size < MAX_BYTES) return;
    const backup = `${file}.1`;
    if (existsSync(backup)) rmSync(backup, { force: true });
    renameSync(file, backup);
  } catch {}
}

/** 追加一条事件；日志失败绝不影响连接主流程。 */
export function logNet(event, data = {}) {
  const file = resolveNetLogPath();
  try {
    mkdirSync(dirname(file), { recursive: true });
    rotateIfNeeded(file);
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), event, ...data, runId: RUN_ID })}\n`, 'utf8');
  } catch {}
}

/** 读取最近 limit 行（含滚动备份），供界面导出。 */
export function readNetLog(limit = 2000) {
  const file = resolveNetLogPath();
  const lines = [];
  for (const path of [`${file}.1`, file]) {
    try {
      lines.push(...readFileSync(path, 'utf8').split('\n').filter(Boolean));
    } catch {}
  }
  return lines.slice(-limit);
}
