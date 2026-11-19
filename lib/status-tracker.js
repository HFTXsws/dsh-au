import { STALE_CLOSE_MS, createSessionStateStore } from './session-state.js';

/**
 * 本机 DSH 会话级状态追踪器：
 * - 状态由官方 session 事件归约得出（见 session-state.js），官方 agent.status（idle | running）只用于对账；
 * - `confirm(sessionId)` 是唯一的蓝灯 / 红灯消除入口，供 dsh-au 与 dsh-au-todo 共用；
 * - 整机状态从全部根会话汇总，设备栏与 Todo 面板读到同一来源。
 */
const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECONCILE_INTERVAL_MS = 3_000;
const REPLAY_BATCH = 4;
const REPLAY_RETRY_MS = 2_000;
const PUSH_FRESH_MS = 10_000;
const END_WAIT_MS = 6_000;
const RANK = { idle: 0, done: 1, busy: 2, waiting: 3, error: 4 };

function sessionIdOf(agent) {
  const id = agent?.session?.id || agent?.id;
  return typeof id === 'string' && id ? id : '';
}

function toLegacy(light) {
  return light === 'waiting' ? 'busy' : light;
}

export function createStatusTracker(getAgentsService, deps = {}) {
  const store = createSessionStateStore({
    ackedSeqOf: (sessionId) => deps.ackStore?.get(sessionId) ?? -1,
    onAck: (sessionId, seq) => deps.ackStore?.set(sessionId, seq),
  });
  const nonRootIds = new Set();
  const replaying = new Set();
  const replayAttemptAt = new Map();
  const prevRunning = new Map();
  const pendingEnd = new Map();
  const lastPushAt = new Map();
  let unsubscribe = null;
  let timer = null;
  let disposed = false;
  let started = false;

  async function replay(sessionId) {
    if (!deps.readEventsAfter || replaying.has(sessionId) || disposed) return;
    replaying.add(sessionId);
    try {
      const events = await deps.readEventsAfter(sessionId, store.lastSeq(sessionId));
      if (!disposed && !nonRootIds.has(sessionId)) store.ingest(sessionId, events);
    } catch {
      // 回放失败只影响这一个会话，下一轮对账会重试。
    } finally {
      replaying.delete(sessionId);
    }
  }

  function requestReplay(sessionId, force = false) {
    const now = Date.now();
    if (!force && now - (replayAttemptAt.get(sessionId) || 0) < REPLAY_RETRY_MS) return;
    replayAttemptAt.set(sessionId, now);
    void replay(sessionId);
  }

  function dropSession(sessionId) {
    if (!sessionId) return;
    store.drop(sessionId);
    prevRunning.delete(sessionId);
    pendingEnd.delete(sessionId);
    replayAttemptAt.delete(sessionId);
    lastPushAt.delete(sessionId);
  }

  /** agent 刚从 running 回到 idle：回合结束事件可能还没落盘，先回放，等不到再兜底收尾。 */
  function onStoppedRunning(sessionId, now) {
    if (deps.readEventsAfter) {
      pendingEnd.set(sessionId, now);
      requestReplay(sessionId, true);
    } else {
      store.inferCompletedWithoutEvents(sessionId);
    }
  }

  function settlePendingEnd(sessionId, now) {
    const since = pendingEnd.get(sessionId);
    if (since === undefined) return;
    if (!store.isTurnOpen(sessionId)) {
      pendingEnd.delete(sessionId);
      return;
    }
    if (now - since >= END_WAIT_MS) {
      store.closeOpenTurn(sessionId, 'completed');
      pendingEnd.delete(sessionId);
    } else {
      requestReplay(sessionId);
    }
  }

  /**
   * 实时接收宿主 agent/status 信号：
   * 1. 子 agent 立即剔除并标记为非根会话；
   * 2. 根会话 running/idle 切换时立即更新状态并触发补读，无需等待 3 秒定时轮询。
   */
  function handleAgentStatus(sessionId, running, isSubagent = false) {
    if (typeof sessionId !== 'string' || !sessionId || disposed) return;
    if (isSubagent || nonRootIds.has(sessionId)) {
      nonRootIds.add(sessionId);
      dropSession(sessionId);
      return;
    }
    const now = Date.now();
    const nextRunning = Boolean(running);
    const wasRunning = prevRunning.get(sessionId) === true;
    store.setAgentRunning(sessionId, nextRunning);
    prevRunning.set(sessionId, nextRunning);
    if (wasRunning && !nextRunning) {
      onStoppedRunning(sessionId, now);
    } else if (nextRunning && !store.isTurnOpen(sessionId)) {
      requestReplay(sessionId);
    }
    settlePendingEnd(sessionId, now);
    store.reconcile(sessionId, now);
  }

  /** 新会话创建时立即对账一次，及时识别子 agent 或新建根会话。 */
  function handleSessionCreated(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId || disposed) return;
    refresh();
  }

  /** 活跃会话实例卸载时立即收尾 running 状态，但保留尚未确认的蓝/红灯。 */
  function handleSessionDisposed(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId || disposed) return;
    const now = Date.now();
    const wasRunning = prevRunning.get(sessionId) === true;
    store.setAgentRunning(sessionId, false);
    prevRunning.set(sessionId, false);
    if (wasRunning) onStoppedRunning(sessionId, now);
    settlePendingEnd(sessionId, now);
    store.reconcile(sessionId, now);
  }

  /** 工作区归档列表变更时立即移除已归档会话，避免归档后顶栏残留灯色。 */
  function handleArchivedSessions(archivedIds) {
    if (disposed || !archivedIds) return;
    for (const id of archivedIds) {
      if (typeof id === 'string' && id) dropSession(id);
    }
  }

  /** 读取官方 Agent 注册表做对账：只看 running，并剔除子 agent 与已归档会话。 */
  function refresh() {
    const seen = new Set();
    const now = Date.now();
    try {
      const archivedRaw = typeof deps.getArchivedSessionIds === 'function' ? deps.getArchivedSessionIds() : null;
      const archivedIds = archivedRaw ? new Set(Array.from(archivedRaw).filter(Boolean)) : null;
      const service = typeof getAgentsService === 'function' ? getAgentsService() : undefined;
      const agents = typeof service?.list === 'function' ? service.list() : [];
      if (!Array.isArray(agents)) return seen;
      const rootList = typeof service?.roots === 'function' ? Array.from(service.roots() || []) : null;
      const rootIds = rootList ? new Set(rootList.map(sessionIdOf).filter(Boolean)) : null;
      for (const agent of agents) {
        const sessionId = sessionIdOf(agent);
        if (!sessionId) continue;
        if (rootIds && !rootIds.has(sessionId)) {
          nonRootIds.add(sessionId);
          dropSession(sessionId);
          continue;
        }
        if (archivedIds?.has(sessionId)) {
          dropSession(sessionId);
          continue;
        }
        seen.add(sessionId);
        const running = agent?.status === 'running';
        store.setAgentRunning(sessionId, running);
        if (prevRunning.get(sessionId) === true && !running) onStoppedRunning(sessionId, now);
        prevRunning.set(sessionId, running);
        // 订阅正常推送时不额外读日志；推送缺失或回合信息缺失时才回放兜底。
        if (running && (!store.isTurnOpen(sessionId) || now - (lastPushAt.get(sessionId) || 0) > PUSH_FRESH_MS)) {
          requestReplay(sessionId);
        }
      }
      for (const [sessionId] of store.entries()) {
        if (archivedIds?.has(sessionId)) {
          dropSession(sessionId);
          continue;
        }
        if (!seen.has(sessionId)) {
          store.setAgentRunning(sessionId, false);
          if (prevRunning.get(sessionId) === true) onStoppedRunning(sessionId, now);
          prevRunning.set(sessionId, false);
        }
        settlePendingEnd(sessionId, now);
        store.reconcile(sessionId, now);
      }
    } catch {
      // 宿主服务短暂不可用时保留已知状态，避免灯在轮询间闪灭。
    }
    return seen;
  }

  function ingest(sessionId, events) {
    if (nonRootIds.has(sessionId)) return;
    store.ingest(sessionId, events);
  }

  function getSessionStatus(sessionId) {
    refresh();
    return store.get(sessionId);
  }

  function getSessionState(sessionId) {
    refresh();
    return store.getState(sessionId);
  }

  function confirm(sessionId, expectedEndSeq) {
    // 先对账官方 running，避免事件尚未到达时把正在跑的新轮误确认。
    refresh();
    return store.confirm(sessionId, expectedEndSeq);
  }

  /**
   * 旧字段（status / runningCount / sessions）保持旧四值语义，waiting 折叠为 busy，
   * 旧版本设备只认这四个值；新字段（statusV2 / waitingCount / sessionsV2）给新版设备读取。
   */
  function getSnapshot() {
    refresh();
    let runningCount = 0;
    let waitingCount = 0;
    let statusV2 = 'idle';
    const sessions = {};
    const sessionsV2 = {};
    const sessionsDetails = {};
    for (const [sessionId, light] of store.entries()) {
      sessionsDetails[sessionId] = store.getState(sessionId);
      sessionsV2[sessionId] = light;
      sessions[sessionId] = toLegacy(light);
      if (light === 'busy' || light === 'waiting') runningCount += 1;
      if (light === 'waiting') waitingCount += 1;
      if ((RANK[light] ?? 0) > (RANK[statusV2] ?? 0)) statusV2 = light;
    }
    // 灯色协议 V2 不变；额外的详情只扩展版本确认能力，旧读取方仍读字符串 map。
    return { status: toLegacy(statusV2), statusV2, runningCount, waitingCount, sessions, sessionsV2, stateVersion: 2, sessionsDetails, sessionStateVersion: 1 };
  }

  /** 启动：先对账，再回放最近的根会话日志恢复未确认的蓝红灯，最后订阅实时事件并开始定时对账。 */
  async function start() {
    if (disposed || started) return;
    started = true;
    refresh();
    if (deps.listSessionIds && deps.readEventsAfter) {
      let ids = [];
      try { ids = await deps.listSessionIds(); } catch { ids = []; }
      for (let index = 0; index < ids.length; index += REPLAY_BATCH) {
        await Promise.all(ids.slice(index, index + REPLAY_BATCH).map((id) => replay(id)));
      }
      refresh();
      // 启动前就遗留的未结束回合，立即按崩溃遗留收尾，再把超过恢复窗口的旧结果视为已读。
      for (const [sessionId] of store.entries()) {
        store.reconcile(sessionId, Date.now());
        store.reconcile(sessionId, Date.now() + STALE_CLOSE_MS);
      }
      store.silenceOlderThan(Date.now() - RECOVERY_WINDOW_MS);
    }
    if (disposed) return;
    if (typeof deps.subscribe === 'function') {
      try {
        const onEvents = (sessionId, events) => {
          lastPushAt.set(sessionId, Date.now());
          ingest(sessionId, events);
        };
        const hooks = {
          onAgentStatus: handleAgentStatus,
          onSessionCreated: handleSessionCreated,
          onSessionDisposed: handleSessionDisposed,
          onArchivedSessions: handleArchivedSessions,
        };
        Object.assign(onEvents, hooks);
        unsubscribe = deps.subscribe(onEvents, hooks) || null;
      } catch { unsubscribe = null; }
    }
    timer = setInterval(refresh, RECONCILE_INTERVAL_MS);
    timer.unref?.();
  }

  function dispose() {
    disposed = true;
    if (timer) clearInterval(timer);
    timer = null;
    if (typeof unsubscribe === 'function') {
      try { unsubscribe(); } catch {}
    }
    unsubscribe = null;
    deps.ackStore?.flush?.();
  }

  return { getSnapshot, getSessionStatus, getSessionState, confirm, refresh, ingest, start, dispose };
}
