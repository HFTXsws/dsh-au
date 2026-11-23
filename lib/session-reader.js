/**
 * 将官方 sessionQuery / workspaceRegistry 的宿主数据归一成跨插件可消费的会话摘要。
 * 此模块不读写原生日志；所有历史读取均通过 DSH 官方 query 服务完成。
 */
function isBridgedExtSessionId(id) {
  return typeof id === 'string' && id.toLowerCase().startsWith('0000e870-');
}

function textFrom(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map((item) => textFrom(item, depth + 1)).filter(Boolean).join(' ');
  if (typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text.trim();
  if (typeof value.content === 'string') return value.content.trim();
  if (Array.isArray(value.content)) return textFrom(value.content, depth + 1);
  return '';
}

function titleFrom(observation) {
  const candidates = [
    observation?.title,
    observation?.value?.title,
    observation?.snapshot?.title,
    observation?.projections?.values?.title,
  ];
  return candidates.find((value) => typeof value === 'string' && value.trim())?.trim() || '';
}

function eventsFrom(observation) {
  const events = observation?.events || observation?.records || observation?.snapshot?.events || [];
  return Array.isArray(events) ? events.map((item) => item?.event || item).filter(Boolean) : [];
}

function titleFromEvents(observation) {
  const events = eventsFrom(observation);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'session/title') continue;
    const title = event.data?.title;
    if (typeof title === 'string' && title.trim()) return title.trim();
  }
  return '';
}

const CONVERSATION_ACTIVITY_EVENT_TYPES = new Set([
  'user/message',
  'assistant/message',
  'tool/call',
  'tool-call',
  'tool/result',
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
]);

/**
 * 仅统计真实对话与执行事件的最新时间戳。
 * 打开历史会话时 DSH 会追加 session/end-seed、permission/preset、sandbox/mode 等系统策略事件，
 * 若不加过滤会将历史会话的更新时间误刷为打开会话时的当前时间。
 */
function latestEventTime(observation) {
  return eventsFrom(observation).reduce((latest, event) => {
    if (!CONVERSATION_ACTIVITY_EVENT_TYPES.has(event?.type)) return latest;
    const time = Number(event?.time);
    return Number.isFinite(time) ? Math.max(latest, time) : latest;
  }, 0);
}

/**
 * 仅识别用户本人在聊天框主动发送的消息（source.kind === 'user'，或测试/旧事件中无 source 的真实用户文本），
 * 排除自动续跑插件（dsh-continue）、Goal、Schedule、Todo 续跑及系统上下文注入。
 */
function isHumanUserMessageEvent(event) {
  if (event?.type !== 'user/message') return false;
  const msg = event.data?.message || event.data || event.payload?.message || event.payload;
  const sourceKind = msg?.source?.kind;
  if (typeof sourceKind === 'string' && sourceKind.length > 0) {
    return sourceKind === 'user';
  }
  const text = textFrom(msg);
  if (!text || text.startsWith('<system-reminder>')) return false;
  return true;
}

function latestHumanMessageTime(observation) {
  return eventsFrom(observation).reduce((latest, event) => {
    if (!isHumanUserMessageEvent(event)) return latest;
    const time = Number(event?.time);
    return Number.isFinite(time) ? Math.max(latest, time) : latest;
  }, 0);
}

function summaryFrom(observation) {
  const events = eventsFrom(observation);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!['assistant/message', 'user/message'].includes(event?.type)) continue;
    const text = textFrom(event.data?.message || event.data);
    if (text) return text.replace(/\s+/g, ' ').slice(0, 220);
  }
  return '';
}

function workspaceNameFor(sessionId, workspaces) {
  const workspace = workspaces.find((item) => Array.isArray(item?.sessionIds) && item.sessionIds.includes(sessionId));
  return workspace?.title || '未归类工作区';
}

const MAX_CACHED_SUMMARIES = 128;
const summaryCacheByCtx = new WeakMap();
const fallbackSummaryCache = createSummaryCacheState();

function createSummaryCacheState() {
  return {
    // 按会话版本缓存观察到的摘要、标题与末条事件时间（LRU 上限 128 条）。
    summaries: new Map(),
    // 按会话版本缓存标题快照（sessionId -> { revision, title }），避免冷历史重复查询。
    titles: new Map(),
    // 列表并发去重：按 limit 缓存正在进行中的摘要列表计算 Promise。
    listInFlight: new Map(),
    // 坏日志隔离：记录读取失败时的版本号，版本未变化前不再重复触发 observeSession。
    failedRevisions: new Map(),
    // 并发去重：同一会话同一版本的并发读取复用同一个 Promise。
    inFlight: new Map(),
    // 实时事件递增版本：收到 session/event 或 agent/status 时立即使旧版本失效。
    liveVersion: new Map(),
    // 时间戳偏离诊断环形缓冲区（最多保留 30 条）
    sortAnomalies: [],
    // 记录已打印诊断日志的会话版本，防止同版本重复输出
    loggedAnomalyRevisions: new Set(),
  };
}

function getSummaryCacheState(ctx) {
  if (ctx && (typeof ctx === 'object' || typeof ctx === 'function')) {
    let state = summaryCacheByCtx.get(ctx);
    if (!state) {
      state = createSummaryCacheState();
      summaryCacheByCtx.set(ctx, state);
    }
    return state;
  }
  return fallbackSummaryCache;
}

function bumpLiveSessionVersion(state, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return;
  state.liveVersion.set(sessionId, (state.liveVersion.get(sessionId) || 0) + 1);
  state.failedRevisions.delete(sessionId);
}

function evictCachedSessions(state, sessionIds) {
  if (!sessionIds) return;
  for (const id of sessionIds) {
    if (typeof id !== 'string' || !id) continue;
    state.summaries.delete(id);
    state.titles?.delete(id);
    state.failedRevisions.delete(id);
    state.liveVersion.delete(id);
  }
}

function readCachedSummary(state, sessionId, revision) {
  if (!revision) return null;
  const entry = state.summaries.get(sessionId);
  if (!entry || entry.revision !== revision) return null;
  state.summaries.delete(sessionId);
  state.summaries.set(sessionId, entry);
  return entry.value;
}

function writeCachedSummary(state, sessionId, revision, value) {
  if (!revision) return;
  state.summaries.delete(sessionId);
  state.summaries.set(sessionId, { revision, value });
  state.failedRevisions.delete(sessionId);
  while (state.summaries.size > MAX_CACHED_SUMMARIES) {
    const oldestKey = state.summaries.keys().next().value;
    if (oldestKey === undefined) break;
    state.summaries.delete(oldestKey);
  }
}

function recordSortTime(record, cacheState = null) {
  // 若传入 cacheState 且存在已观察的真实对话更新时间，优先使用缓存的 updatedAt
  if (cacheState) {
    const cachedTs = Number(cacheState?.summaries?.get(record?.header?.id)?.value?.updatedAt) || 0;
    if (cachedTs > 0) return cachedTs;
  }
  // 打开历史会话时 DSH 写入 session/end-seed 会导致 record.updatedAt（文件 mtime）被刷新为当前时间；
  // 因此优先使用未被污染的 lastPromptAt，再兜底 record.updatedAt / header.updatedAt / header.createdAt
  return Number(
    record?.projections?.values?.sessionListMetadata?.lastPromptAt
    || record?.updatedAt
    || record?.header?.updatedAt
    || record?.header?.createdAt
    || 0,
  );
}

/**
 * 计算会话日志版本指纹：
 * 1. 优先读取宿主内存活跃会话 seq（ctx.sessions）与持久化层 revision（sessionPersistence.stat）；
 * 2. 结合 sessionQuery 记录时间戳、回合大纲、实时事件计数与状态灯，任一变化即触发重新观察。
 */
async function resolveSessionRevision(ctx, record, status, state) {
  const sessionId = record?.header?.id;
  if (!sessionId) return '';
  let liveSeq = '';
  try {
    const live = ctx?.sessions?.get?.(sessionId);
    if (live && Number.isFinite(Number(live.seq))) {
      liveSeq = `live:${Number(live.seq) - 1}`;
    }
  } catch {}

  let persistedRev = '';
  if (!liveSeq) {
    try {
      const persistence = ctx?.get?.('sessionPersistence');
      if (typeof persistence?.stat === 'function') {
        const snapshot = await persistence.stat(sessionId);
        if (snapshot?.revision !== undefined && snapshot?.revision !== null) {
          persistedRev = `persist:${String(snapshot.revision)}`;
        }
      }
    } catch {}
  }

  // 版本指纹仅使用记录自身的时间戳，避免写入 summaries 缓存后因 observed.updatedAt 更大而改变自身 revision 导致缓存自失效
  const sortTime = recordSortTime(record);
  const recordRev = record?.revision ?? record?.header?.revision ?? '';
  const outline = record?.projections?.values?.turnOutline;
  const outlineKey = Array.isArray(outline) && outline.length
    ? `${outline.length}:${outline[outline.length - 1]?.seq ?? ''}:${outline[outline.length - 1]?.response ? 1 : 0}`
    : '';
  const liveVer = state.liveVersion.get(sessionId) || 0;
  if (!liveSeq && !persistedRev && !sortTime && !recordRev && !outlineKey && !liveVer) {
    return '';
  }
  // 移除状态灯后缀：单纯确认状态灯（如 done -> idle）不应使日志摘要与标题快照缓存失效，保持与实际日志内容一致
  return `${liveSeq}|${persistedRev}|${sortTime}|${recordRev}|${outlineKey}|${liveVer}`;
}

async function observeSessionSummary(ctx, query, record, status, state, resolvedRevision) {
  const sessionId = record.header.id;
  // 若上层已在批量计算中解析出 revision，直接复用，避免同一会话在单轮列表查询中重复调用 resolveSessionRevision
  const revision = resolvedRevision !== undefined
    ? resolvedRevision
    : await resolveSessionRevision(ctx, record, status, state);
  const cached = readCachedSummary(state, sessionId, revision);
  if (cached) return cached;
  if (revision && state.failedRevisions.get(sessionId) === revision) {
    return { summary: '', title: '', updatedAt: 0, lastUserMessageAt: 0 };
  }
  const flightKey = `${sessionId}\0${revision || 'unversioned'}`;
  const existingFlight = state.inFlight.get(flightKey);
  if (existingFlight) return existingFlight;

  const task = (async () => {
    let observation;
    try {
      observation = await query.observeSession?.(sessionId, { projectionMode: 'none' });
      const value = {
        summary: summaryFrom(observation),
        title: titleFromEvents(observation),
        snapshotTitle: state.titles?.get(sessionId)?.title || '',
        updatedAt: latestEventTime(observation),
        lastUserMessageAt: latestHumanMessageTime(observation),
      };
      writeCachedSummary(state, sessionId, revision, value);
      return value;
    } catch {
      if (revision) state.failedRevisions.set(sessionId, revision);
      return { summary: '', title: '', updatedAt: 0, lastUserMessageAt: 0 };
    } finally {
      await observation?.[Symbol.asyncDispose]?.();
    }
  })();

  state.inFlight.set(flightKey, task);
  try {
    return await task;
  } finally {
    state.inFlight.delete(flightKey);
  }
}

/** 读取最近 50 条顶层、未归档对话，并保留单会话蓝灯状态。 */
export async function listConversationSummaries(ctx, statusTracker, limit = 50) {
  const query = ctx?.get?.('sessionQuery');
  if (!query?.listSessions) return [];
  const cacheState = getSummaryCacheState(ctx);
  const historyLimit = Math.max(1, Math.min(50, limit));

  // 基于 (ctx, limit) 的在途 Promise 合并：多个并发调用共享底层的 listSessions、readTitleSnapshots 与 observeSessionSummary
  let inFlightTask = cacheState.listInFlight.get(historyLimit);
  if (!inFlightTask) {
    inFlightTask = (async () => {
      const archived = new Set(ctx.get?.('workspaceRegistry')?.archivedSessionIds || []);
      evictCachedSessions(cacheState, archived);
      const workspaces = ctx.get?.('workspaceRegistry')?.list?.() || [];
      const records = await query.listSessions();
      const statusById = new Map();
      const statusOf = (id) => {
        if (!statusById.has(id)) {
          statusById.set(id, statusTracker?.getSessionStatus?.(id) || 'idle');
        }
        return statusById.get(id);
      };
      const activeRank = (id) => (statusOf(id) !== 'idle' ? 1 : 0);
      // 历史条数上限不截掉活跃根会话；51 个 running 时树也必须保留 51 个节点。
      const sorted = records
        .filter((record) => record?.header?.id && record.header.origin !== 'subagent'
          && !(Number(record.header.delegationDepth) > 0) && !archived.has(record.header.id)
          && !isBridgedExtSessionId(record.header.id))
        .sort((left, right) =>
          activeRank(right.header.id) - activeRank(left.header.id)
          || recordSortTime(right, cacheState) - recordSortTime(left, cacheState));
      const visible = sorted.filter((record, index) => index < historyLimit || activeRank(record.header.id));

      // 1. 预先解析所有可见会话的版本号
      const revisions = await Promise.all(
        visible.map((record) => resolveSessionRevision(ctx, record, statusOf(record.header.id), cacheState)),
      );

      // 2. 检查哪些会话已有当前版本的有效标题缓存，仅对其余会话发起 readTitleSnapshots 查询
      const titleById = new Map();
      const uncachedIds = [];

      for (let index = 0; index < visible.length; index += 1) {
        const id = visible[index].header.id;
        const rev = revisions[index];
        const cachedSummary = rev ? readCachedSummary(cacheState, id, rev) : null;
        const titleEntry = rev ? cacheState.titles.get(id) : null;
        const hasCached = Boolean(rev && (cachedSummary !== null || titleEntry?.revision === rev));

        if (titleEntry?.revision === rev && typeof titleEntry.title === 'string') {
          titleById.set(id, titleEntry.title);
        } else if (typeof cachedSummary?.snapshotTitle === 'string' && cachedSummary.snapshotTitle) {
          titleById.set(id, cachedSummary.snapshotTitle);
        }

        if (!hasCached) {
          uncachedIds.push(id);
        }
      }

      // 仅当存在未缓存标题的会话时才调用 query.readTitleSnapshots
      if (uncachedIds.length > 0 && typeof query.readTitleSnapshots === 'function') {
        const rawTitles = await query.readTitleSnapshots(uncachedIds) || [];
        if (Array.isArray(rawTitles)) {
          if (rawTitles.length === uncachedIds.length) {
            for (let i = 0; i < uncachedIds.length; i += 1) {
              const item = rawTitles[i];
              const title = titleFrom(item);
              const sid = (typeof item === 'object' && item?.sessionId) ? item.sessionId : uncachedIds[i];
              titleById.set(sid, title);
              if (sid !== uncachedIds[i]) {
                titleById.set(uncachedIds[i], title);
              }
            }
          } else if (rawTitles.length === visible.length) {
            // 兼容返回全部 visible 长度的单测 mock
            for (let i = 0; i < visible.length; i += 1) {
              const item = rawTitles[i];
              const title = titleFrom(item);
              const sid = (typeof item === 'object' && item?.sessionId) ? item.sessionId : visible[i].header.id;
              titleById.set(sid, title);
            }
          }
        }
      }

      // 将最新解析到的标题存入 cacheState.titles 缓存
      for (let index = 0; index < visible.length; index += 1) {
        const id = visible[index].header.id;
        const rev = revisions[index];
        const title = titleById.get(id);
        if (rev && typeof title === 'string') {
          cacheState.titles.set(id, { revision: rev, title });
        }
      }

      // 3. 按会话版本命中缓存；传入已计算好的 revision 避免二次调用 resolveSessionRevision
      const summaries = await Promise.all(
        visible.map((record, index) =>
          observeSessionSummary(ctx, query, record, statusOf(record.header.id), cacheState, revisions[index])),
      );

      // 返回基础会话列表（不携带随时变化的动态 sessionState）
      const baseSummaries = visible.map((record, index) => {
        const sessionId = record.header.id;
        const observed = summaries[index] || { summary: '', title: '', updatedAt: 0, lastUserMessageAt: 0 };
        const observedTime = Number(observed.updatedAt) || 0;
        const promptTime = Number(record?.projections?.values?.sessionListMetadata?.lastPromptAt) || 0;
        const headerTime = recordSortTime(record);
        // 若已从对话事件流观察到真实消息/回合时间（observedTime > 0），仅与提问时间取最大值，
        // 严禁用 record.updatedAt（会被打开历史会话时写入的 session/end-seed 刷新文件 mtime）覆盖真实对话时间！
        const updatedAt = observedTime > 0
          ? Math.max(observedTime, promptTime)
          : (headerTime || Date.now());

        // 诊断日志：当 header 时间与观察到的最新事件时间偏离超过 60 秒时记录
        if (observedTime > 0 && headerTime > 0 && Math.abs(observedTime - headerTime) > 60_000) {
          if (!Array.isArray(cacheState?.sortAnomalies)) {
            if (cacheState) cacheState.sortAnomalies = [];
          }
          cacheState?.sortAnomalies?.push({
            sessionId,
            headerTime,
            observedTime,
            finalUpdatedAt: updatedAt,
          });
          if (cacheState?.sortAnomalies && cacheState.sortAnomalies.length > 30) {
            cacheState.sortAnomalies.shift();
          }

          if (cacheState && !cacheState.loggedAnomalyRevisions) {
            cacheState.loggedAnomalyRevisions = new Set();
          }
          const anomalyKey = `${sessionId}@${revisions?.[index] || ''}`;
          if (!cacheState?.loggedAnomalyRevisions?.has(anomalyKey)) {
            cacheState?.loggedAnomalyRevisions?.add(anomalyKey);
            console.debug?.('[dsh-au][sort-diag] session timestamp divergence', {
              sessionId,
              headerTime,
              observedTime,
              finalUpdatedAt: updatedAt,
            });
          }
        }

        const lastUserMessageAt = Number(observed.lastUserMessageAt || record.lastUserMessageAt || 0);
        const workspace = workspaces.find((ws) => ws?.sessionIds?.includes(sessionId));
        return {
          sessionId,
          title: titleById.get(sessionId) || observed.title || record.header.title || '未命名对话',
          summary: observed.summary,
          workspace: workspaceNameFor(sessionId, workspaces),
          updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
          ...(Number.isFinite(lastUserMessageAt) && lastUserMessageAt > 0 ? { lastUserMessageAt } : {}),
          cwd: record.header.cwd || '',
          ...((workspace?.workspaceId || record.header.workspaceId)
            ? { workspaceId: workspace?.workspaceId || record.header.workspaceId } : {}),
        };
      });

      // 观察完冷会话真实末条事件时间后重新排序，确保具有较新助手/工具事件的冷会话排在正确位置
      return baseSummaries.sort((left, right) =>
        activeRank(right.sessionId) - activeRank(left.sessionId)
        || (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0));
    })();

    cacheState.listInFlight.set(historyLimit, inFlightTask);
  }

  let baseList;
  try {
    baseList = await inFlightTask;
  } finally {
    if (cacheState.listInFlight.get(historyLimit) === inFlightTask) {
      cacheState.listInFlight.delete(historyLimit);
    }
  }

  // 在等待共享基准列表完成后，为每个调用方独立附加当下的最新状态详情（避免多调用方拿到不同轮次的状态灯或序号）
  const statusOf = (id) => statusTracker?.getSessionStatus?.(id) || 'idle';
  const activeRank = (id) => (statusOf(id) !== 'idle' ? 1 : 0);
  return baseList.map((item) => {
    const sessionId = item.sessionId;
    const sessionState = statusTracker?.getSessionState?.(sessionId) || { status: statusOf(sessionId) };
    return {
      ...item,
      ...sessionState,
    };
  }).sort((left, right) =>
    activeRank(right.sessionId) - activeRank(left.sessionId)
    || (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0));
}

/**
 * 聚合本机工作区及其下属顶层会话树。
 * 优先按宿主 workspaceRegistry 归组；未被任何注册工作区命中的活跃会话按 cwd / workspace 兜底归入补充工作区，防止漏掉对话。
 */
export async function listLocalWorkspaces(ctx, statusTracker, limit = 50, preloadedSummaries = null) {
  const registry = ctx?.get?.('workspaceRegistry');
  const workspaces = registry?.list?.() || [];
  const pinned = new Set(registry?.pinnedSessionIds || []);
  // 支持传入已预载的会话摘要；若未传入则拉取摘要（通过 listInFlight 自动享受并发合并）
  const rawSummaries = Array.isArray(preloadedSummaries)
    ? preloadedSummaries
    : await listConversationSummaries(ctx, statusTracker, limit);
  const summaries = rawSummaries
    .filter((s) => {
      if (!s?.sessionId) return false;
      const title = typeof s.title === 'string' ? s.title.trim() : '';
      const untitled = !title || title === '未命名对话';
      const noSummary = !(typeof s.summary === 'string' && s.summary.trim());
      const isIdle = !s.status || s.status === 'idle';
      return !(untitled && noSummary && isIdle && !pinned.has(s.sessionId));
    });
  const byId = new Map(summaries.map((s) => [s.sessionId, s]));
  const assigned = new Set();

  const normalizePathKey = (raw) => typeof raw === 'string'
    ? raw.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    : '';

  const sortSessions = (list) => [...list].sort((left, right) =>
    Number(pinned.has(right.sessionId)) - Number(pinned.has(left.sessionId))
    || (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0));

  const result = workspaces.map((ws) => {
    const wsSessions = [];
    const seenInWs = new Set();
    if (Array.isArray(ws?.sessionIds)) {
      for (const id of ws.sessionIds) {
        const s = byId.get(id);
        if (s && !seenInWs.has(s.sessionId)) {
          seenInWs.add(s.sessionId);
          assigned.add(s.sessionId);
          wsSessions.push(s);
        }
      }
    }
    // 真实 workspaceId 优先于 cwd；否则曾换过 cwd 的会话可能被挂到错误工作区。
    for (const s of summaries) {
      if (s.workspaceId && s.workspaceId === ws?.workspaceId && !assigned.has(s.sessionId)) {
        seenInWs.add(s.sessionId);
        assigned.add(s.sessionId);
        wsSessions.push(s);
      }
    }
    const wsNormPath = normalizePathKey(ws?.path);
    if (wsNormPath) {
      for (const s of summaries) {
        if (!seenInWs.has(s.sessionId) && !assigned.has(s.sessionId) && s.cwd && normalizePathKey(s.cwd) === wsNormPath
          && !workspaces.some((registered) => s.workspaceId && registered.workspaceId === s.workspaceId)) {
          seenInWs.add(s.sessionId);
          assigned.add(s.sessionId);
          wsSessions.push(s);
        }
      }
    }
    const sortedSessions = sortSessions(wsSessions);
    const maxSessionUpdatedAt = sortedSessions.reduce((max, s) => Math.max(max, Number(s.updatedAt) || 0), 0);
    const wsUpdatedAt = sortedSessions.length > 0
      ? maxSessionUpdatedAt
      : (Date.parse(ws?.createdAt || '') || 0);
    return {
      workspaceId: String(ws?.workspaceId || ws?.path || ws?.title || ''),
      title: ws?.title === 'default-workspace' ? '默认工作区' : String(ws?.title || '默认工作区'),
      rawTitle: String(ws?.title || ''),
      path: String(ws?.path || ''),
      createdAt: ws?.createdAt || '',
      updatedAt: Number.isFinite(wsUpdatedAt) ? wsUpdatedAt : 0,
      sessions: sortedSessions.map((s) => ({
        sessionId: s.sessionId,
        title: s.title || '未命名对话',
        summary: s.summary || '',
        updatedAt: s.updatedAt || 0,
        cwd: s.cwd || String(ws?.path || ''),
        status: s.status || 'idle',
        ...(s.stateSeq !== undefined ? { stateSeq: s.stateSeq, endSeq: s.endSeq, ackedSeq: s.ackedSeq } : {}),
        pinned: pinned.has(s.sessionId),
      })),
    };
  });

  // 将未被任何注册工作区命中的剩余会话按 cwd / workspace 聚合为补充工作区追加在末尾，确保没有任何活跃会话漏掉。
  const fallbackGroups = new Map();
  for (const s of summaries) {
    if (assigned.has(s.sessionId)) continue;
    const key = normalizePathKey(s.cwd) || s.workspace || '未归类工作区';
    if (!fallbackGroups.has(key)) {
      fallbackGroups.set(key, []);
    }
    fallbackGroups.get(key).push(s);
  }

  for (const [key, groupSessions] of fallbackGroups.entries()) {
    const sortedSessions = sortSessions(groupSessions);
    const first = sortedSessions[0] || {};
    const cwd = first.cwd || '';
    const normCwd = normalizePathKey(cwd);
    const rawTitle = (first.workspace && first.workspace !== '未归类工作区')
      ? String(first.workspace)
      : (cwd
        ? (cwd.trim().replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || cwd)
        : String(key || '未归类工作区'));
    const normalizedTitle = (rawTitle === 'default-workspace' || rawTitle === '未归类工作区' && result.some((item) => item.title === '默认工作区'))
      ? '默认工作区'
      : rawTitle;
    const wsUpdatedAt = sortedSessions.reduce((max, s) => Math.max(max, Number(s.updatedAt) || 0), 0);
    const mappedSessions = sortedSessions.map((s) => ({
      sessionId: s.sessionId,
      title: s.title || '未命名对话',
      summary: s.summary || '',
      updatedAt: s.updatedAt || 0,
      cwd: s.cwd || String(cwd),
      status: s.status || 'idle',
      ...(s.stateSeq !== undefined ? { stateSeq: s.stateSeq, endSeq: s.endSeq, ackedSeq: s.ackedSeq } : {}),
      pinned: pinned.has(s.sessionId),
    }));
    const existing = result.find((item) =>
      (normCwd && normalizePathKey(item.path) === normCwd)
      || item.title === normalizedTitle
    );
    if (existing) {
      const seenIds = new Set(existing.sessions.map((s) => s.sessionId));
      for (const s of mappedSessions) {
        if (!seenIds.has(s.sessionId)) {
          seenIds.add(s.sessionId);
          existing.sessions.push(s);
        }
      }
      existing.sessions = sortSessions(existing.sessions);
      if (wsUpdatedAt > existing.updatedAt) existing.updatedAt = wsUpdatedAt;
      if (!existing.path && cwd) existing.path = String(cwd);
      continue;
    }
    result.push({
      workspaceId: cwd ? `cwd:${cwd}` : 'ungrouped',
      title: normalizedTitle,
      rawTitle,
      path: String(cwd),
      createdAt: '',
      updatedAt: Number.isFinite(wsUpdatedAt) ? wsUpdatedAt : 0,
      sessions: mappedSessions,
    });
  }

  return result;
}

/** 状态追踪启动回放用：最近的顶层、未归档会话 ID（排除子 agent 会话）。 */
export async function listRootSessionIds(ctx, limit = 50) {
  const query = ctx.get?.('sessionQuery');
  if (!query?.listSessions) return [];
  const archived = new Set(ctx.get?.('workspaceRegistry')?.archivedSessionIds || []);
  const records = await query.listSessions();
  return records
    .filter((record) => record?.header?.id
      && record.header.origin !== 'subagent'
      && !(Number(record.header.delegationDepth) > 0)
      && !archived.has(record.header.id)
      && !isBridgedExtSessionId(record.header.id))
    .sort((left, right) => recordSortTime(right) - recordSortTime(left))
    .slice(0, Math.max(1, Math.min(50, limit)))
    .map((record) => record.header.id);
}

/** 读取序号大于 afterSeq 的会话事件；事件缺少 seq 时按追加顺序补下标，保证重复回放可去重。 */
export async function readSessionEventsAfter(ctx, sessionId, afterSeq = -1) {
  const query = ctx.get?.('sessionQuery');
  if (!query?.observeSession) return [];
  let observation;
  try {
    observation = await query.observeSession(sessionId, { projectionMode: 'none' });
    return eventsFrom(observation)
      .map((event, index) => (Number.isFinite(event?.seq) ? event : { ...event, seq: index }))
      .filter((event) => event.seq > afterSeq);
  } finally {
    await observation?.[Symbol.asyncDispose]?.();
  }
}

/**
 * 订阅宿主实时信号（session/event、agent/status、session/created、session/disposed、domain/changed）：
 * 1. session/event 推送归约事件并递增对应会话的缓存版本；
 * 2. agent/status、生命周期与工作区归档变更通过可选钩子实时驱动状态对账与缓存失效。
 */
export function subscribeSessionEvents(ctx, handler, hooks = {}) {
  if (typeof ctx?.on !== 'function') return null;
  let diagnosed = 0;
  const cacheState = getSummaryCacheState(ctx);
  const disposers = [];
  const register = (eventName, listener) => {
    try {
      const off = ctx.on(eventName, listener);
      if (typeof off === 'function') disposers.push(off);
    } catch {}
  };
  const looksLikeEvent = (value) => value && typeof value === 'object' && typeof value.type === 'string' && 'data' in value;
  const sessionIdFrom = (value) => {
    const id = value?.session?.id
      || value?.sessionId
      || value?.header?.id
      || (!looksLikeEvent(value) ? value?.id : '');
    return typeof id === 'string' && id ? id : '';
  };

  register('session/event', (...args) => {
    try {
      let sessionId = '';
      const events = [];
      for (const arg of args) {
        if (!arg || typeof arg !== 'object') continue;
        sessionId = sessionId || sessionIdFrom(arg);
        const candidates = Array.isArray(arg.events) ? arg.events : [arg.event ?? arg];
        for (const candidate of candidates) {
          const event = candidate?.event || candidate;
          if (looksLikeEvent(event)) events.push(event);
        }
      }
      if (sessionId && events.length) {
        bumpLiveSessionVersion(cacheState, sessionId);
        handler?.(sessionId, events);
      } else if (diagnosed < 3) {
        diagnosed += 1;
        console.info('[dsh-au] session/event 载荷未识别，字段名：', JSON.stringify(args.map((arg) => (arg && typeof arg === 'object' ? Object.keys(arg).slice(0, 12) : typeof arg))));
      }
    } catch {
      // 实时订阅出错不影响主流程，回放对账会补上。
    }
  });

  register('agent/status', (payload) => {
    try {
      const agent = payload?.agent || payload;
      const sessionId = sessionIdFrom(agent) || sessionIdFrom(payload);
      const status = payload?.status || agent?.status;
      if (!sessionId || (status !== 'running' && status !== 'idle')) return;
      const isSubagent = Boolean(
        agent?.parent
        || agent?.origin === 'subagent'
        || agent?.session?.header?.origin === 'subagent'
        || Number(agent?.session?.header?.delegationDepth) > 0,
      );
      bumpLiveSessionVersion(cacheState, sessionId);
      (hooks?.onAgentStatus || handler?.onAgentStatus)?.(sessionId, status === 'running', isSubagent);
    } catch {}
  });

  register('session/created', (session) => {
    try {
      const sessionId = sessionIdFrom(session);
      if (!sessionId) return;
      bumpLiveSessionVersion(cacheState, sessionId);
      (hooks?.onSessionCreated || handler?.onSessionCreated)?.(sessionId);
    } catch {}
  });

  register('session/disposed', (session) => {
    try {
      const sessionId = sessionIdFrom(session);
      if (!sessionId) return;
      (hooks?.onSessionDisposed || handler?.onSessionDisposed)?.(sessionId);
    } catch {}
  });

  register('domain/changed', (change) => {
    try {
      if (change?.domain !== 'workspace' || (change?.table && change.table !== '')) return;
      let archivedIds = change?.value?.archivedSessionIds;
      if (!Array.isArray(archivedIds)) {
        try { archivedIds = ctx.get?.('workspaceRegistry')?.archivedSessionIds || []; } catch { archivedIds = []; }
      }
      evictCachedSessions(cacheState, archivedIds);
      (hooks?.onArchivedSessions || handler?.onArchivedSessions)?.(archivedIds);
    } catch {}
  });

  if (!disposers.length) return null;
  return () => {
    for (const off of disposers) {
      try { off(); } catch {}
    }
  };
}

/**
 * 检查目标会话是否已接收过指定 messageId 的消息（覆盖已落盘 user/message 与尚在队列中的 agent/inbox/spliced）。
 * 用于网络抖动或重复点击时的幂等防重，避免同一条 Todo 被重复送入对话。
 */
export async function hasSessionAcceptedMessage(ctx, sessionId, messageId, liveSession = null) {
  if (typeof sessionId !== 'string' || !sessionId || typeof messageId !== 'string' || !messageId) return false;
  const matchesMessage = (msg) => msg && typeof msg === 'object' && (
    msg.id === messageId
    || msg.source?.rpcId === messageId
    || msg.source?.requestId === messageId
  );
  const matchesEvents = (events) => Array.isArray(events) && events.some((item) => {
    const event = item?.event || item;
    const data = event?.data || event?.payload?.message || event?.payload;
    if (event?.type === 'user/message') return matchesMessage(data);
    if (event?.type === 'agent/inbox/spliced') {
      return Array.isArray(data?.inserted) && data.inserted.some(matchesMessage);
    }
    return false;
  });

  try {
    const live = liveSession || ctx?.sessions?.get?.(sessionId);
    const liveEvents = live?.snapshotEvents?.();
    if (matchesEvents(liveEvents)) return true;
  } catch {}

  try {
    const persistedEvents = await readSessionEventsAfter(ctx, sessionId, -1);
    if (matchesEvents(persistedEvents)) return true;
  } catch {}

  return false;
}

/** dsh-au-todo 投递前统一构造最小的 DSH 用户消息；传入 requestId 时写入幂等标识供去重核对。 */
export function createTodoFollowupMessage(text, requestId = '') {
  const cleanReqId = typeof requestId === 'string' ? requestId.trim() : '';
  return {
    ...(cleanReqId ? { id: cleanReqId } : {}),
    role: 'user',
    content: [{ type: 'text', text }],
    // 明确标记插件来源，避免以人为输入冒充授权；附带 rpcId 供历史/入队去重识别。
    source: cleanReqId
      ? { kind: 'cordis-host-runner', rpcId: cleanReqId }
      : { kind: 'cordis-host-runner' },
  };
}
