/**
 * 会话灯色归约器：把官方 session 事件（turn/start、turn/end、approval/*、ask_user_question）
 * 归约成 idle / busy / waiting / done / error。同一个纯逻辑既处理实时事件，也回放持久日志。
 */
const QUESTION_TOOL = 'ask_user_question';
const DONE_KINDS = new Set(['completed', 'max-tokens', 'blocked', 'interrupted']);
const ERROR_KINDS = new Set(['error']);
export const STALE_CLOSE_MS = 10_000;

function createEntry() {
  return {
    lastSeq: -1,
    lastTime: 0,
    openTurn: null,
    pendingApprovals: new Set(),
    pendingQuestions: new Set(),
    ended: null,
    endSeq: -1,
    acknowledged: false,
    ackedSeq: -1,
    running: false,
    staleSince: null,
  };
}

function hasPendingWait(entry) {
  return entry.pendingApprovals.size > 0 || entry.pendingQuestions.size > 0;
}

function deriveLight(entry) {
  if (entry.openTurn !== null || entry.running) return hasPendingWait(entry) ? 'waiting' : 'busy';
  if (entry.acknowledged) return 'idle';
  if (ERROR_KINDS.has(entry.ended)) return 'error';
  if (DONE_KINDS.has(entry.ended)) return 'done';
  return 'idle';
}

function applyEvent(entry, event, ackedSeq) {
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  switch (event.type) {
    case 'turn/start':
      entry.openTurn = Number.isFinite(data.turn) ? data.turn : 0;
      entry.pendingApprovals.clear();
      entry.pendingQuestions.clear();
      entry.ended = null;
      entry.endSeq = -1;
      entry.acknowledged = false;
      break;
    case 'turn/end':
      entry.openTurn = null;
      entry.pendingApprovals.clear();
      entry.pendingQuestions.clear();
      entry.ended = typeof data.reason?.kind === 'string' ? data.reason.kind : 'completed';
      entry.endSeq = Number.isFinite(event.seq) ? event.seq : -1;
      // 回放旧日志时，已确认到的序号不低于这次结束的序号，就视为已读。
      entry.acknowledged = entry.endSeq >= 0 && ackedSeq >= entry.endSeq;
      break;
    case 'approval/asked':
      if (typeof data.id === 'string') entry.pendingApprovals.add(data.id);
      break;
    case 'approval/decided':
      if (typeof data.id === 'string') entry.pendingApprovals.delete(data.id);
      break;
    case 'tool/call':
      if (data.name === QUESTION_TOOL && typeof data.callId === 'string') entry.pendingQuestions.add(data.callId);
      break;
    case 'tool/result': {
      const callId = data.message?.toolCallId;
      if (typeof callId === 'string') entry.pendingQuestions.delete(callId);
      break;
    }
    default:
      break;
  }
}

export function createSessionStateStore({ ackedSeqOf = () => -1, onAck = () => {} } = {}) {
  const entries = new Map();

  function entryOf(sessionId) {
    let entry = entries.get(sessionId);
    if (!entry) {
      entry = createEntry();
      entries.set(sessionId, entry);
    }
    return entry;
  }

  function ingest(sessionId, events) {
    if (typeof sessionId !== 'string' || !sessionId || !Array.isArray(events)) return;
    const entry = entryOf(sessionId);
    for (const raw of events) {
      const event = raw?.event || raw;
      if (!event || typeof event.type !== 'string') continue;
      const hasSeq = Number.isFinite(event.seq);
      if (hasSeq && event.seq <= entry.lastSeq) continue;
      // 旧 ackstore 与本轮内存确认共用同一序号，不引入第二份持久化账本。
      entry.ackedSeq = Math.max(entry.ackedSeq, ackedSeqOf(sessionId));
      applyEvent(entry, event, entry.ackedSeq);
      if (hasSeq) entry.lastSeq = event.seq;
      if (Number.isFinite(event.time)) entry.lastTime = Math.max(entry.lastTime, event.time);
    }
  }

  /** agents.list() 的官方状态只做对账：running 时即使事件还没到也显示 busy。 */
  function setAgentRunning(sessionId, running) {
    if (typeof sessionId !== 'string' || !sessionId) return;
    const entry = entryOf(sessionId);
    entry.running = running === true;
    if (entry.running) entry.staleSince = null;
  }

  /** 回合还开着但 agent 已不在跑：持续超过 STALE_CLOSE_MS 仍如此，按崩溃遗留（interrupted）收尾。 */
  function reconcile(sessionId, now = Date.now()) {
    const entry = entries.get(sessionId);
    if (!entry) return;
    if (entry.openTurn !== null && !entry.running) {
      if (entry.staleSince === null) {
        entry.staleSince = now;
      } else if (now - entry.staleSince >= STALE_CLOSE_MS) {
        entry.openTurn = null;
        entry.pendingApprovals.clear();
        entry.pendingQuestions.clear();
        entry.ended = 'interrupted';
        entry.endSeq = entry.lastSeq;
        entry.acknowledged = entry.endSeq >= 0 && ackedSeqOf(sessionId) >= entry.endSeq;
        entry.staleSince = null;
      }
    } else {
      entry.staleSince = null;
    }
  }

  /** 回合结束事件迟迟没到时的兜底收尾（只在刚观察到 agent 停止运行后使用）。 */
  function closeOpenTurn(sessionId, kind) {
    const entry = entries.get(sessionId);
    if (!entry || entry.openTurn === null) return;
    entry.openTurn = null;
    entry.pendingApprovals.clear();
    entry.pendingQuestions.clear();
    entry.ended = kind;
    entry.endSeq = entry.lastSeq;
    entry.acknowledged = entry.endSeq >= 0 && ackedSeqOf(sessionId) >= entry.endSeq;
    entry.staleSince = null;
  }

  /** 完全收不到该会话的事件时（无回放能力），用 agent 的 running 到 idle 推断一次完成。 */
  function inferCompletedWithoutEvents(sessionId) {
    const entry = entries.get(sessionId);
    if (!entry || entry.lastSeq !== -1 || entry.openTurn !== null || entry.running) return;
    entry.ended = 'completed';
    entry.acknowledged = false;
  }

  function get(sessionId) {
    const entry = entries.get(sessionId);
    return entry ? deriveLight(entry) : 'idle';
  }

  /** 序号来自日志 SSOT；-1 明确表示无版本，调用端不得用本机时间补造。 */
  function getState(sessionId) {
    const entry = entries.get(sessionId);
    return {
      status: entry ? deriveLight(entry) : 'idle',
      stateSeq: entry?.lastSeq ?? -1,
      endSeq: entry?.endSeq ?? -1,
      ackedSeq: Math.max(entry?.ackedSeq ?? -1, ackedSeqOf(sessionId),
        entry?.acknowledged ? entry.endSeq : -1),
    };
  }

  function confirm(sessionId, expectedEndSeq) {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    // 严格确认未知会话不创建幽灵状态；无参旧入口仍保留原有兼容行为。
    if (expectedEndSeq !== undefined && !entries.has(sessionId)) return false;
    const entry = entryOf(sessionId);
    if (entry.openTurn !== null || entry.running) return false;
    // 新客户端确认自己实际看到的结束序号；迟到请求不能清掉下一轮。
    // 无参数旧入口保留兼容，包括完全没有日志事件的官方状态降级。
    if (expectedEndSeq !== undefined && (!Number.isSafeInteger(expectedEndSeq)
      || expectedEndSeq < 0 || entry.ended === null || expectedEndSeq !== entry.endSeq)) return false;
    entry.acknowledged = true;
    if (entry.ended !== null && entry.endSeq >= 0) {
      entry.ackedSeq = Math.max(entry.ackedSeq, entry.endSeq);
      onAck(sessionId, entry.endSeq);
    }
    return true;
  }

  /** 启动回放时，早于 cutoff 的未确认结果直接视为已读，避免陈年红蓝灯。 */
  function silenceOlderThan(cutoffMs) {
    for (const entry of entries.values()) {
      if (entry.openTurn === null && !entry.running && entry.lastTime < cutoffMs) {
        entry.acknowledged = true;
        // 启动静默同样保持已读版本单调；不改既有持久化恢复窗口策略。
        entry.ackedSeq = Math.max(entry.ackedSeq, entry.endSeq);
      }
    }
  }

  return {
    ingest,
    setAgentRunning,
    reconcile,
    closeOpenTurn,
    inferCompletedWithoutEvents,
    get,
    getState,
    confirm,
    silenceOlderThan,
    drop: (sessionId) => { entries.delete(sessionId); },
    has: (sessionId) => entries.has(sessionId),
    isTurnOpen: (sessionId) => entries.get(sessionId)?.openTurn != null,
    lastSeq: (sessionId) => entries.get(sessionId)?.lastSeq ?? -1,
    lastTime: (sessionId) => entries.get(sessionId)?.lastTime ?? 0,
    entries: () => [...entries.entries()].map(([id, entry]) => [id, deriveLight(entry)]),
  };
}
