import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * 蓝灯 / 红灯的"已确认"记录：对话日志里没有"你看过了"这个动作，
 * 这里只持久化 sessionId → 已确认到的 turn/end 序号，重启回放日志时据此判断是否已读。
 */
const MAX_ENTRIES = 500;
const FLUSH_DELAY_MS = 500;

export function resolveAckFilePath() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-au.acks.json');
}

export function createAckStore({ filePath = resolveAckFilePath(), flushDelayMs = FLUSH_DELAY_MS } = {}) {
  const acks = new Map();
  let timer = null;
  let dirty = false;

  try {
    if (existsSync(filePath)) {
      const raw = JSON.parse(readFileSync(filePath, 'utf8'));
      for (const [sessionId, seq] of Object.entries(raw?.acks || {}).slice(-MAX_ENTRIES)) {
        if (Number.isFinite(seq)) acks.set(sessionId, seq);
      }
    }
  } catch {
    // 文件损坏时当作没有记录，最坏结果只是多亮一次蓝灯。
  }

  function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!dirty) return;
    dirty = false;
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, acks: Object.fromEntries([...acks].slice(-MAX_ENTRIES)) }), 'utf8');
      renameSync(tmp, filePath);
    } catch {
      // 写入失败不影响灯色，只是下次重启可能重新亮灯。
    }
  }

  function set(sessionId, seq) {
    if (typeof sessionId !== 'string' || !sessionId || !Number.isFinite(seq)) return;
    if ((acks.get(sessionId) ?? -1) >= seq) return;
    acks.delete(sessionId);
    acks.set(sessionId, seq);
    dirty = true;
    if (!timer) {
      timer = setTimeout(flush, flushDelayMs);
      timer.unref?.();
    }
  }

  return { get: (sessionId) => acks.get(sessionId) ?? -1, set, flush };
}
