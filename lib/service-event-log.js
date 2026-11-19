import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * 本地服务生命周期事件使用有界 JSONL 持久化：当前文件超过上限前滚动为 .1，
 * 任何文件系统错误都由本模块吞掉，不能反向阻断服务启停。
 */
export const SERVICE_EVENT_LOG_MAX_BYTES = 2 * 1024 * 1024;
export const SERVICE_EVENT_LOG_MAX_TAIL = 1000;
const DEFAULT_TAIL_LIMIT = 200;
const MAX_MESSAGE_LENGTH = 16 * 1024;
const REDACTED = '[REDACTED]';
const SECRET_KEY_PATTERN = '(?:[A-Za-z][A-Za-z0-9.-]*[_-])?(?:password|passwd|access[_-]?token|refresh[_-]?token|token|secret(?:[_-]?access[_-]?key)?|access[_-]?key(?:[_-]?id)?|api[_-]?key|credential)';

export function resolveServiceEventLogPath() {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(dshHome, 'logs', 'dsh-au-services.jsonl');
}

/** 自由格式消息落盘前移除常见凭据、认证头、Cookie 与 URL userinfo。 */
export function sanitizeServiceEventMessage(value) {
  let message = String(value ?? '').slice(0, MAX_MESSAGE_LENGTH);
  // URL 中的 user:password 必须整体遮住，同时保留协议和主机便于诊断。
  message = message.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@/\s]+)@/gi,
    `$1${REDACTED}:${REDACTED}@`,
  );
  // Cookie / Set-Cookie 可能含多段分号值，整行字段比逐段匹配更安全。
  message = message.replace(/\b((?:set[-_])?cookie)\b(\s*(?:=|:)\s*)[^\r\n]*/gi, `$1$2${REDACTED}`);
  message = message.replace(
    /\b(Authorization)\b(\s*(?:=|:)\s*)((?:Bearer|Basic)\s+)[^\s,;]+/gi,
    `$1$2$3${REDACTED}`,
  );
  message = message.replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, `$1 ${REDACTED}`);
  const assignment = new RegExp(
    `\\b(${SECRET_KEY_PATTERN})\\b(\\s*(?:=|:)\\s*)(?:"[^"]*"|'[^']*'|[^\\s,;]+)`,
    'gi',
  );
  const spaced = new RegExp(`\\b(${SECRET_KEY_PATTERN})\\b(\\s+)(?!${REDACTED.replace(/[\[\]]/g, '\\$&')})[^\\s,;]+`, 'gi');
  message = message.replace(assignment, (_match, key, separator) => `${key}${separator}${REDACTED}`);
  return message.replace(spaced, (_match, key, separator) => `${key}${separator}${REDACTED}`);
}

function sanitizeServiceEventField(value, maxLength = 256) {
  return sanitizeServiceEventMessage(value).replace(/[\r\n]+/g, ' ').slice(0, maxLength);
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function rotateIfNeeded(filePath, maxBytes, incomingBytes) {
  const currentBytes = statSync(filePath).size;
  if (currentBytes === 0 || currentBytes + incomingBytes <= maxBytes) return;
  const backupPath = `${filePath}.1`;
  if (existsSync(backupPath)) rmSync(backupPath, { force: true });
  renameSync(filePath, backupPath);
}

/**
 * 追加一条结构固定的服务事件。返回是否成功写入，但文件系统失败永不抛出。
 */
export function appendServiceEvent(event, {
  filePath = resolveServiceEventLogPath(),
  maxBytes = SERVICE_EVENT_LOG_MAX_BYTES,
} = {}) {
  try {
    const record = {
      ts: new Date().toISOString(),
      event: sanitizeServiceEventField(event?.event, 256),
      serviceId: sanitizeServiceEventField(event?.serviceId, 256),
      action: sanitizeServiceEventField(event?.action, 128),
      ok: event?.ok === true,
      message: sanitizeServiceEventMessage(event?.message),
    };
    if (Number.isSafeInteger(event?.pid) && event.pid > 0) record.pid = event.pid;
    if (Number.isInteger(event?.exitCode)) record.exitCode = event.exitCode;
    if (event?.source !== undefined) record.source = sanitizeServiceEventField(event.source, 128);

    const line = `${JSON.stringify(record)}\n`;
    mkdirSync(dirname(filePath), { recursive: true });
    try {
      rotateIfNeeded(filePath, positiveInteger(maxBytes, SERVICE_EVENT_LOG_MAX_BYTES), Buffer.byteLength(line));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    appendFileSync(filePath, line, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function boundedTailLimit(limit) {
  if (!Number.isFinite(limit)) return DEFAULT_TAIL_LIMIT;
  return Math.min(SERVICE_EVENT_LOG_MAX_TAIL, Math.max(0, Math.floor(limit)));
}

/** 只读返回按时间写入顺序排列的末尾事件；损坏行与不可读文件均安全跳过。 */
export function readServiceEvents({
  filePath = resolveServiceEventLogPath(),
  limit = DEFAULT_TAIL_LIMIT,
} = {}) {
  const boundedLimit = boundedTailLimit(limit);
  if (boundedLimit === 0) return [];

  const events = [];
  for (const candidate of [`${filePath}.1`, filePath]) {
    try {
      for (const line of readFileSync(candidate, 'utf8').split(/\r?\n/)) {
        if (!line) continue;
        try { events.push(JSON.parse(line)); } catch { /* 单行损坏不影响其余历史事件 */ }
      }
    } catch { /* 日志尚未创建或临时不可读时返回已有事件 */ }
  }
  return events.slice(-boundedLimit);
}
