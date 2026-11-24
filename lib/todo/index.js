import { randomUUID } from 'node:crypto';
import { logNet } from '../net-log.js';
import {
  appendTodo,
  applyTodoMetadata,
  hideTodoConversation,
  loadTodoStore,
  peekTodo,
  removeTodo,
  savePinned,
  savePriority,
  saveSortOrder,
} from './todo-store.js';

const APPLY_LOCK = '__dshAuTodoApplyActive';
const ROUTE_PATH = '/dsh-au-todo/api';
const NATIVE_SESSION_LIST_PATH = '/api/session/list';
const NATIVE_SESSION_PROMPT_PATH = '/api/session/prompt';
const NATIVE_SESSION_CREATE_PATH = '/api/session/create';
const NATIVE_WORKSPACE_CREATE_PATH = '/api/workspace/create';
const remoteWorkspaceIdCache = new Map();

/**
 * 清洗字符串中的孤立 UTF-16 代理项（被截断的半个 Emoji 或终端特殊输出），
 * 避免跨设备 JSON 序列化或比对时产生非法 Unicode。
 */
export function sanitizeLoneSurrogates(input) {
  if (typeof input !== 'string' || !input) return input;
  let out = '';
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = i + 1 < input.length ? input.charCodeAt(i + 1) : 0;
      if (next >= 0xDC00 && next <= 0xDFFF) {
        out += input[i] + input[i + 1];
        i += 1;
      } else {
        out += '\uFFFD';
      }
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      out += '\uFFFD';
    } else {
      out += input[i];
    }
  }
  return out;
}

function normalizeRemoteWorkspaceCacheKey(deviceId, cwd) {
  const cleanDev = typeof deviceId === 'string' ? deviceId.trim() : '';
  const cleanCwd = typeof cwd === 'string'
    ? cwd.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    : '';
  return cleanDev && cleanCwd ? `${cleanDev}::${cleanCwd}` : '';
}

function isRealWorkspaceId(workspaceId) {
  if (typeof workspaceId !== 'string') return false;
  const trimmed = workspaceId.trim();
  if (!trimmed) return false;
  if (trimmed === 'default' || trimmed === 'default-workspace') return false;
  if (trimmed.startsWith('cwd:') || trimmed.startsWith('ws:')) return false;
  return true;
}

/**
 * 幂等在远端设备上通过目录路径解析或注册原生 Workspace，获取真实的 `workspaceId`。
 */
async function resolveOrCreateRemoteWorkspaceId(bridge, deviceId, cwd, { bypassCache = false } = {}) {
  const cleanCwd = typeof cwd === 'string' ? cwd.trim() : '';
  if (!cleanCwd || typeof bridge?.requestDevice !== 'function') return '';
  const cacheKey = normalizeRemoteWorkspaceCacheKey(deviceId, cleanCwd);
  if (!bypassCache && cacheKey && remoteWorkspaceIdCache.has(cacheKey)) {
    return remoteWorkspaceIdCache.get(cacheKey) || '';
  }
  try {
    const res = await bridge.requestDevice(deviceId, NATIVE_WORKSPACE_CREATE_PATH, {
      type: 'client-request',
      rpcId: randomUUID(),
      method: 'workspace/create',
      payload: {
        args: {
          request: { path: cleanCwd },
        },
      },
    });
    const wsId = res?.result?.value?.workspace?.workspaceId
      || res?.value?.workspace?.workspaceId
      || res?.workspace?.workspaceId
      || '';
    const resolved = isRealWorkspaceId(wsId) ? wsId.trim() : '';
    if (resolved && cacheKey) {
      remoteWorkspaceIdCache.set(cacheKey, resolved);
    }
    return resolved;
  } catch {
    return '';
  }
}

/**
 * 通过远端 DSH 原生 `/api/session/create` 在指定工作区或目录新建空白会话。
 * 注意：DSH `SessionCreateRequest` 中 `workspaceId` 与 `cwd` 互斥，且只有传入 `workspaceId`
 * 创建的会话才会挂入 `workspace.sessionIds` 并在输入框自动选中该工作区。
 */
async function createRemoteNativeSession(bridge, deviceId, { workspaceId = '', cwd = '' } = {}) {
  const startedAt = Date.now();
  const cleanWsId = typeof workspaceId === 'string' ? workspaceId.trim() : '';
  const cleanCwd = typeof cwd === 'string' ? cwd.trim() : '';
  let resolvedWsId = isRealWorkspaceId(cleanWsId) ? cleanWsId : '';
  if (!resolvedWsId && cleanCwd) {
    resolvedWsId = await resolveOrCreateRemoteWorkspaceId(bridge, deviceId, cleanCwd);
  }

  const candidates = [];
  if (resolvedWsId) {
    candidates.push({ workspaceId: resolvedWsId });
  }
  if (cleanCwd) {
    candidates.push({ cwd: cleanCwd });
  }
  if (resolvedWsId && cleanCwd) {
    candidates.push({ workspaceId: resolvedWsId, cwd: cleanCwd });
  }
  candidates.push({});

  let lastError = '远程创建会话失败';
  let triedResolveFromCwd = !cleanCwd;
  for (let i = 0; i < candidates.length; i += 1) {
    const requestPayload = candidates[i];
    const res = await bridge.requestDevice(deviceId, NATIVE_SESSION_CREATE_PATH, {
      type: 'client-request',
      rpcId: randomUUID(),
      method: 'session/create',
      payload: {
        args: {
          request: requestPayload,
        },
      },
    });
    const sessionId = res?.result?.value?.sessionId || res?.sessionId || '';
    if (res?.result?.ok && typeof sessionId === 'string' && sessionId) {
      const finalWsId = requestPayload.workspaceId || resolvedWsId || '';
      const cacheKey = normalizeRemoteWorkspaceCacheKey(deviceId, cleanCwd);
      if (finalWsId && cacheKey) {
        remoteWorkspaceIdCache.set(cacheKey, finalWsId);
      }
      logNet('remote.session.create', {
        deviceId,
        sessionId,
        workspaceId: finalWsId,
        attempt: i + 1,
        elapsedMs: Date.now() - startedAt,
        ok: true,
      });
      return {
        ok: true,
        sessionId,
        workspaceId: finalWsId,
        agentPreset: res?.result?.value?.agentPreset || 'standard',
        cwd: cleanCwd,
      };
    }
    lastError = res?.result?.error?.message || res?.error || lastError;
    // 若传入的旧/缓存 workspaceId 失效且有 cleanCwd，强制绕过缓存用 workspace/create 重新解析真实 workspaceId
    if (!triedResolveFromCwd && requestPayload.workspaceId && cleanCwd) {
      triedResolveFromCwd = true;
      const cacheKey = normalizeRemoteWorkspaceCacheKey(deviceId, cleanCwd);
      if (cacheKey) remoteWorkspaceIdCache.delete(cacheKey);
      const freshWsId = await resolveOrCreateRemoteWorkspaceId(bridge, deviceId, cleanCwd, { bypassCache: true });
      if (freshWsId && freshWsId !== resolvedWsId) {
        resolvedWsId = freshWsId;
        candidates.splice(i + 1, 0, { workspaceId: freshWsId });
      }
    }
  }
  logNet('remote.session.create', {
    deviceId,
    workspaceId: resolvedWsId,
    elapsedMs: Date.now() - startedAt,
    ok: false,
    error: lastError,
  });
  return { ok: false, error: lastError };
}

/**
 * 调用目标远端设备的 DSH 原生 RPC 接口执行会话或工作区动作（置顶、归档、重命名等）。
 */
async function executeRemoteNativeEntityAction(bridge, deviceId, { entityAction, sessionId, workspaceId, title } = {}) {
  const act = String(entityAction || '').trim();
  const sid = String(sessionId || '').trim();
  const wsId = String(workspaceId || '').trim();
  const cleanTitle = String(title || '').trim();
  const candidates = [];

  if (act === 'pinSession' && sid) {
    candidates.push(
      { path: '/api/workspace/pinSession', method: 'workspace/pinSession', args: { sessionId: sid } },
      { path: '/api/workspace/pin-session', method: 'workspace/pinSession', args: { sessionId: sid } },
      { path: '/api/session/pin', method: 'session/pin', args: { sessionId: sid } }
    );
  } else if (act === 'unpinSession' && sid) {
    candidates.push(
      { path: '/api/workspace/unpinSession', method: 'workspace/unpinSession', args: { sessionId: sid } },
      { path: '/api/workspace/unpin-session', method: 'workspace/unpinSession', args: { sessionId: sid } },
      { path: '/api/session/unpin', method: 'session/unpin', args: { sessionId: sid } }
    );
  } else if (act === 'archiveSession' && sid) {
    candidates.push(
      { path: '/api/workspace/archiveSession', method: 'workspace/archiveSession', args: { sessionId: sid } },
      { path: '/api/workspace/archive-session', method: 'workspace/archiveSession', args: { sessionId: sid } },
      { path: '/api/session/archive', method: 'session/archive', args: { sessionId: sid } }
    );
  } else if (act === 'unarchiveSession' && sid) {
    candidates.push(
      { path: '/api/workspace/unarchiveSession', method: 'workspace/unarchiveSession', args: { sessionId: sid } },
      { path: '/api/workspace/unarchive-session', method: 'workspace/unarchiveSession', args: { sessionId: sid } }
    );
  } else if (act === 'renameSession' && sid && cleanTitle) {
    candidates.push(
      { path: '/api/session/rename', method: 'session/rename', args: { sessionId: sid, title: cleanTitle } },
      { path: '/api/session/rename', method: 'session/rename', args: { request: { sessionId: sid, title: cleanTitle } } }
    );
  } else if (act === 'renameWorkspace' && wsId && cleanTitle) {
    candidates.push(
      { path: '/api/workspace/rename', method: 'workspace/rename', args: { workspaceId: wsId, title: cleanTitle } },
      { path: '/api/workspace/rename', method: 'workspace/rename', args: { request: { workspaceId: wsId, title: cleanTitle } } }
    );
  }

  for (const cand of candidates) {
    const res = await bridge.requestDevice(deviceId, cand.path, {
      type: 'client-request',
      rpcId: randomUUID(),
      method: cand.method,
      payload: { args: cand.args },
    });
    if (res?.result?.ok || res?.ok === true) {
      return { ok: true };
    }
  }
  return { ok: false, error: '远端原生动作调用未命中' };
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { if (raw.length < 256 * 1024) raw += chunk; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

const TODO_RECENT_WINDOW_MS = 48 * 60 * 60 * 1000;

function priorityRank(priority) {
  const map = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4, P5: 5, P6: 6, P7: 7, P8: 8 };
  return map[priority] ?? 4;
}

function todoTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return NaN;
}

/** Todo 只展示最近 48 小时有活动的会话，且不把未来时间当成有效活动。 */
export function isRecentTodoCard(card, now = Date.now()) {
  const updatedAt = todoTimestamp(card?.updatedAt);
  return Number.isFinite(updatedAt) && updatedAt >= now - TODO_RECENT_WINDOW_MS && updatedAt <= now;
}

/**
 * 4 层直觉分组权重：
 * 1) 等用户处理的卡片（红灯 error -> 橙灯 waiting -> 蓝灯 done）
 * 2) 正在埋头干活的卡片（黄灯 busy / running）
 * 3) 已读空闲但绑有待发 Todo 的卡片
 * 4) 普通绿灯空闲历史对话（idle）
 */
function todoStatusRank(card) {
  const status = card?.status || 'idle';
  if (status === 'error') return 0;
  if (status === 'waiting') return 1;
  if (status === 'done') return 2;
  if (status === 'busy' || status === 'running') return 3;
  if (Array.isArray(card?.todos) && card.todos.some((todo) => typeof todo?.text === 'string' && todo.text.trim())) {
    return 4;
  }
  return 5;
}

/** 先按 P0~P8 严格排序；置顶只在同一优先级内生效，避免低优先级越过高优先级。 */
export function sortTodoCards(cards) {
  return [...cards].sort((left, right) =>
    priorityRank(left.priority) - priorityRank(right.priority)
    || Number(right.pinned === true) - Number(left.pinned === true)
    || todoStatusRank(left) - todoStatusRank(right)
    || Number(left.sortOrder) - Number(right.sortOrder)
    || Number(right.updatedAt) - Number(left.updatedAt)
    || String(left.sessionId).localeCompare(String(right.sessionId)));
}

/** 未命名、无摘要、无待办、未暂存且无待处理灯色的空白对话没有可操作信息，不在 Todo 面板展示。 */
export function isBlankTodoCard(card) {
  if (!card) return true;
  const title = typeof card.title === 'string' ? card.title.trim() : '';
  const untitled = !title || title === '未命名对话';
  const noSummary = !(typeof card.summary === 'string' && card.summary.trim());
  const noTodos = !(Array.isArray(card.todos) && card.todos.length);
  return untitled && noSummary && noTodos && card.pinned !== true
    && card.status !== 'busy' && card.status !== 'waiting' && card.status !== 'done' && card.status !== 'error';
}

/** 会话 ID 在 DSH 中全局唯一；本机副本优先，避免自映射路由重复显示同一张卡。 */
export function dedupeTodoCards(cards) {
  const unique = new Map();
  for (const card of cards) {
    if (card?.sessionId && !unique.has(card.sessionId)) unique.set(card.sessionId, card);
  }
  return [...unique.values()];
}

function workspaceFromCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return '未归类工作区';
  const segments = cwd.trim().replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || '未归类工作区';
}

/**
 * 当远端设备为旧版 dsh-au（未返回 workspaces 数组）或走原生 session/list 降级时，
 * 将平铺的会话卡片按 cwd / workspace 聚合成工作区树结构，确保跨机工作区树始终完整。
 */
export function synthesizeWorkspacesFromCards(cards, device = {}) {
  if (!Array.isArray(cards) || !cards.length) return [];
  const groups = new Map();
  for (const card of cards) {
    if (!card || !card.sessionId) continue;
    const key = card.cwd || card.workspace || '默认工作区';
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(card);
  }

  const workspaces = [];
  for (const [, groupCards] of groups.entries()) {
    const first = groupCards[0] || {};
    const rawTitle = (typeof first.workspace === 'string' && first.workspace.trim() && first.workspace !== '未归类工作区')
      ? first.workspace.trim()
      : (first.cwd ? workspaceFromCwd(first.cwd) : '默认工作区');
    const title = rawTitle === 'default-workspace' ? '默认工作区' : rawTitle;
    const deviceId = device.deviceId || first.deviceId || '';
    const deviceName = device.name || device.deviceName || first.deviceName || '远程设备';
    const isLocal = Boolean(device.isLocal ?? first.isLocal);
    const sessions = groupCards
      .filter((card) => !isBlankTodoCard(card))
      .sort((left, right) =>
        Number(Boolean(right.pinned)) - Number(Boolean(left.pinned))
        || (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0))
      .map((card) => ({
        sessionId: card.sessionId,
        title: sanitizeLoneSurrogates(card.title || '未命名对话'),
        summary: sanitizeLoneSurrogates(card.summary || ''),
        updatedAt: Number(card.updatedAt) || 0,
        cwd: sanitizeLoneSurrogates(card.cwd || ''),
        status: card.status || 'idle',
        ...(card.stateSeq !== undefined ? { stateSeq: card.stateSeq, endSeq: card.endSeq, ackedSeq: card.ackedSeq } : {}),
        pinned: Boolean(card.pinned),
        deviceId: device.deviceId || card.deviceId || '',
        deviceName: device.name || device.deviceName || card.deviceName || '远程设备',
        isLocal: Boolean(device.isLocal ?? card.isLocal),
      }));
    const maxSessionUpdatedAt = sessions.length
      ? sessions.reduce((max, s) => Math.max(max, Number(s.updatedAt) || 0), 0)
      : groupCards.reduce((max, c) => Math.max(max, Number(c?.updatedAt) || 0), 0);
    const cleanTitle = sanitizeLoneSurrogates(title);
    const cleanPath = sanitizeLoneSurrogates(first.cwd || '');
    workspaces.push({
      workspaceId: String(first.workspaceId || (cleanPath ? `cwd:${cleanPath}` : `ws:${cleanTitle}`)),
      title: cleanTitle,
      path: cleanPath,
      updatedAt: maxSessionUpdatedAt,
      deviceId,
      deviceName,
      isLocal,
      sessions,
    });
  }
  return workspaces;
}

function summaryFromTurnOutline(turnOutline) {
  if (!Array.isArray(turnOutline) || !turnOutline.length) return '';
  for (let index = turnOutline.length - 1; index >= 0; index -= 1) {
    const turn = turnOutline[index];
    const text = String(turn?.response || turn?.prompt || '').replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 220);
  }
  return '';
}

/**
 * 当远端设备尚未挂载 dsh-au-todo 路由（HTTP 404/405）时，
 * 直接经 dsh-au 鉴权通道调用远端 DSH 原生 /api/session/list，确保跨设备对话实时可见。
 */
export async function fetchRemoteNativeSessions(bridge, device, remoteSessionStates = new Map(), store = loadTodoStore()) {
  const response = await bridge.requestDevice(device.deviceId, NATIVE_SESSION_LIST_PATH, {
    type: 'client-request',
    rpcId: randomUUID(),
    method: 'session/list',
    payload: { args: { _request: {} } },
  });
  const items = response?.result?.ok && Array.isArray(response.result.value?.items)
    ? response.result.value.items
    : [];
  if (!items.length) return [];

  // 新版远端 dsh-au 会公布逐会话的真实灯色（V2）；有它就直接使用，没有才回落到旧启发式。
  const remoteLights = device.sessionStatesV2 && typeof device.sessionStatesV2 === 'object' ? device.sessionStatesV2 : null;

  const remoteDetails = device.sessionStateDetails && typeof device.sessionStateDetails === 'object'
    ? device.sessionStateDetails : null;
  const isActive = (item) => item.running === true
    || (typeof remoteLights?.[item.sessionId] === 'string' && remoteLights[item.sessionId] !== 'idle');
  const validItems = items.filter((item) => item?.sessionId && item.origin !== 'subagent'
    && !(Number(item.delegationDepth) > 0) && !item.archived && !item.isArchived
    && (!item.blank || isActive(item)));
  const visible = validItems.filter((item, index) => index < 50 || isActive(item));

  const rawCards = visible.map((item, index) => {
    const sessionId = item.sessionId;
    const stateKey = `${device.deviceId}:${sessionId}`;
    const prev = remoteSessionStates.get(stateKey) || { status: 'idle', acknowledged: false };
    let status = prev.status;
    let acknowledged = prev.acknowledged === true;
    const remoteState = remoteDetails?.[sessionId];
    const remoteLight = remoteState?.status || remoteLights?.[sessionId];
    const hasVersion = Number.isSafeInteger(remoteState?.stateSeq) && remoteState.stateSeq >= 0;
    const ackedSeq = Math.max(Number.isSafeInteger(remoteState?.ackedSeq) ? remoteState.ackedSeq : -1,
      Number.isSafeInteger(prev.ackedSeq) ? prev.ackedSeq : -1);
    // 只有实际结束版本已确认才降为 idle；旧设备无元数据明确保留旧布尔降级。
    if (hasVersion) acknowledged = Number.isSafeInteger(remoteState.endSeq) && remoteState.endSeq >= 0 && ackedSeq >= remoteState.endSeq;
    if (item.running === true && remoteLight !== 'waiting') {
      // 原生会话实时处于 running 时立即亮黄灯，无需等待顶栏下一轮探测。
      status = 'busy';
      acknowledged = false;
    } else if (typeof remoteLight === 'string') {
      if (remoteLight === 'busy' || remoteLight === 'waiting') {
        status = remoteLight;
        acknowledged = false;
      } else if (remoteLight === 'done' || remoteLight === 'error') {
        // 远端没有 dsh-au-todo 路由时无法代为确认，本机只记录"已读"，远端灯色再次变化会自动清除。
        status = acknowledged ? 'idle' : remoteLight;
      } else {
        status = 'idle';
      }
    } else if (prev.status === 'busy' || (index === 0 && device.status === 'done')) {
      status = acknowledged ? 'idle' : 'done';
    } else {
      status = 'idle';
    }
    const stateMetadata = remoteState && Number.isSafeInteger(remoteState.stateSeq)
      ? { stateSeq: remoteState.stateSeq, endSeq: remoteState.endSeq, ackedSeq } : {};
    remoteSessionStates.set(stateKey, { status, acknowledged, ...stateMetadata });

    const values = item.projections?.values || {};
    const cwd = item.cwd || values.workingDirectory || '';
    // 运行中或忙碌中的会话取最大时间戳以反映实时进展；
    // 针对空闲/已完成的历史会话，打开历史会话时 DSH 写入 session/end-seed 会刷新文件 mtime (item.updatedAt)，
    // 故优先采用未受污染的提问时间 lastPromptAt，严防时间戳被误刷为“刚刚”。
    const isRunningOrBusy = item.running === true || status === 'busy' || status === 'waiting';
    const lastPromptAt = Number(values.sessionListMetadata?.lastPromptAt) || 0;
    const itemUpdatedAt = Number(item.updatedAt) || 0;
    const itemCreatedAt = Number(item.createdAt) || 0;
    const updatedAt = isRunningOrBusy
      ? (Math.max(lastPromptAt, itemUpdatedAt, itemCreatedAt) || Date.now())
      : (lastPromptAt || itemUpdatedAt || itemCreatedAt || Date.now());
    return {
      sessionId,
      title: (typeof values.title === 'string' && values.title.trim()) || '未命名对话',
      summary: summaryFromTurnOutline(values.turnOutline),
      workspace: workspaceFromCwd(cwd),
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
      cwd,
      workspaceId: item.workspaceId || values.workspaceId || '',
      running: item.running === true,
      status,
      ...stateMetadata,
    };
  });

  return applyTodoMetadata(rawCards, store)
    // 已点击完成的卡片持久保持隐藏，不再因后台续跑或非 idle 灯色重新弹出。
    .filter((card) => card.hidden !== true)
    .map((card) => ({
      ...card,
      deviceId: device.deviceId,
      deviceName: device.name,
      isLocal: false,
      todoStateSource: 'native',
    }));
}

/** 本地写入、确认与投递动作可由 HTTP 路由和单元测试共同调用。 */
export function createLocalTodoActions(bridge) {
  // 进行中的本地会话与工作区读取 Promise，用于并发调用合并去重
  let inFlightSessions = null;
  let inFlightWorkspaces = null;
  let inFlightGetLocalSessions = null;

  function invalidate() {
    inFlightSessions = null;
    inFlightWorkspaces = null;
    inFlightGetLocalSessions = null;
  }

  async function getLocalSessions() {
    if (inFlightSessions) return inFlightSessions;
    const task = (async () => {
      const device = bridge.getLocalDevice();
      const cards = applyTodoMetadata(await bridge.listLocalSessions(50), loadTodoStore())
        // 已点击完成的卡片持久隐藏，仅在追加新待办或本人发送新聊天消息解除 hidden 后重新展示。
        .filter((card) => card.hidden !== true);
      return cards.map((card) => ({ ...card, deviceId: device.deviceId, deviceName: device.name, isLocal: true }));
    })();
    inFlightSessions = task;
    try {
      return await task;
    } finally {
      if (inFlightSessions === task) inFlightSessions = null;
    }
  }

  async function getLocalWorkspaces() {
    if (inFlightWorkspaces) return inFlightWorkspaces;
    const task = (async () => {
      const device = { ...bridge.getLocalDevice(), isLocal: true };
      // 旧单测 mock 若未提供 listLocalWorkspaces，则从平铺会话卡片合成工作区结构。
      if (typeof bridge.listLocalWorkspaces !== 'function') {
        return synthesizeWorkspacesFromCards(await getLocalSessions(), device);
      }
      const store = loadTodoStore();
      const rawWorkspaces = await bridge.listLocalWorkspaces(50);
      if (!Array.isArray(rawWorkspaces)) return [];
      return rawWorkspaces.map((ws) => {
        const rawSessions = Array.isArray(ws?.sessions) ? ws.sessions : [];
        const sessions = rawSessions
          .map((session) => {
            const entry = store?.conversations?.[session.sessionId];
            // 返回前读取同一份详情，不能保留上一轮灯色却附上新一轮序号。
            const state = bridge.getSessionState?.(session.sessionId)
              || { status: bridge.getSessionStatus?.(session.sessionId) || session.status || 'idle' };
            return {
              ...session,
              ...state,
              pinned: Boolean(session.pinned || entry?.pinned),
              deviceId: device.deviceId,
              deviceName: device.name,
              isLocal: true,
            };
          })
          .sort((left, right) =>
            Number(Boolean(right.pinned)) - Number(Boolean(left.pinned))
            || (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0));
        const maxUpdatedAt = sessions.reduce((max, s) => Math.max(max, Number(s.updatedAt) || 0), 0);
        return {
          ...ws,
          updatedAt: Math.max(Number(ws?.updatedAt) || 0, maxUpdatedAt),
          deviceId: device.deviceId,
          deviceName: device.name,
          isLocal: true,
          sessions,
        };
      });
    })();
    inFlightWorkspaces = task;
    try {
      return await task;
    } finally {
      if (inFlightWorkspaces === task) inFlightWorkspaces = null;
    }
  }

  async function dispatchLocal(action, body) {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    if (action === 'getLocalSessions') {
      if (inFlightGetLocalSessions) return inFlightGetLocalSessions;
      const task = (async () => {
        const [cards, workspaces] = await Promise.all([getLocalSessions(), getLocalWorkspaces()]);
        // 隐藏 ID 由所属设备发布，供远端排除原生接口兜底时重新读出的历史卡片。
        const hiddenSessionIds = Object.entries(loadTodoStore().conversations)
          .filter(([, entry]) => entry?.hidden === true).map(([id]) => id);
        return { ok: true, cards, workspaces, hiddenSessionIds };
      })();
      inFlightGetLocalSessions = task;
      try {
        return await task;
      } finally {
        if (inFlightGetLocalSessions === task) inFlightGetLocalSessions = null;
      }
    }
    if (action === 'getLocalWorkspaces') {
      return { ok: true, workspaces: await getLocalWorkspaces() };
    }
    // 变更类动作执行前立即使读取在途缓存失效
    invalidate();
    if (!sessionId) return { ok: false, ...(action === 'confirmSession' ? { confirmed: false } : {}), error: '缺少 sessionId' };
    if (action === 'setPriority') return savePriority(sessionId, body.priority);
    if (action === 'setPinned') return savePinned(sessionId, body.pinned === true);
    if (action === 'setSortOrder') return saveSortOrder(sessionId, body.priority, Number(body.sortOrder));
    if (action === 'appendTodo') return appendTodo(sessionId, body.text);
    if (action === 'hideSession') {
      // 点击“完成”隐藏卡片时同步确认消除该会话的蓝/红灯，避免卡片隐藏后顶栏残留无法点击消除的蓝灯。
      const confirmed = await bridge.confirmSession?.(sessionId, body.expectedEndSeq) === true;
      const result = hideTodoConversation(sessionId, {
        lastUserMessageAt: body.lastUserMessageAt,
        updatedAt: body.updatedAt,
      });
      const state = bridge.getSessionState?.(sessionId);
      return { ...result, ...(state ? { state, confirmed } : {}) };
    }
    if (action === 'confirmSession') {
      const confirmed = await bridge.confirmSession(sessionId, body.expectedEndSeq) === true;
      const state = bridge.getSessionState?.(sessionId);
      return { ok: confirmed, confirmed, ...(state ? { state } : {}),
        ...(confirmed ? {} : { error: '会话仍在运行或结束版本已变化，请刷新后重试' }) };
    }
    if (action === 'interruptSession') {
      if (typeof bridge.interruptSession !== 'function') {
        return { ok: false, error: '当前环境不支持停止会话' };
      }
      return bridge.interruptSession(sessionId);
    }
    if (action === 'sendNextTodo') {
      const todo = peekTodo(sessionId);
      if (!todo) return { ok: false, error: '该对话没有待续跑的 Todo' };
      const sent = await bridge.sendTodo(sessionId, todo.text, { requestId: todo.id });
      if (!sent.ok) return sent;
      removeTodo(sessionId, todo.id);
      return { ok: true, todoId: todo.id };
    }
    return { ok: false, error: '未知 Todo 操作' };
  }
  return { getLocalSessions, getLocalWorkspaces, dispatchLocal, invalidate };
}

/**
 * 注册 `/dsh-au-todo/api`。由 dsh-au 在 webServer 就绪后调用，bridge 直接取自同进程的 runtimeBridge。
 * 返回释放函数；功能关闭（isEnabled() 为 false）时路由回 404，等价于"这台设备没装 todo"，其他设备按原生接口降级。
 */
export function registerTodoRoutes({
  server,
  bridge,
  isEnabled = () => true,
  isFullAccessByDefault = () => false,
  checkRequest = null,
}) {
  // 旧版 dsh-au-todo 若仍挂载并已持锁，不能双注册同一路径。
  if (globalThis[APPLY_LOCK]) {
    console.warn('[dsh-au] 检测到旧版 dsh-au-todo 仍在运行，已跳过内置待办路由；请重新运行 dsh-au 的 install-local 完成迁移');
    return () => {};
  }
  globalThis[APPLY_LOCK] = true;
  if (typeof globalThis.__dshAuTodoDisposeRoute === 'function') {
    try { globalThis.__dshAuTodoDisposeRoute(); } catch {}
    globalThis.__dshAuTodoDisposeRoute = null;
  }

  const todoActions = createLocalTodoActions(bridge);
  const remoteSessionStates = new Map();

  // 变更类操作名单：触发时必须立即使在途或已缓存的 getState 失效，确保状态变更立即可见
  const MUTATING_ACTIONS = new Set([
    'confirmSession',
    'hideSession',
    'setPriority',
    'setPinned',
    'setSortOrder',
    'appendTodo',
    'sendNextTodo',
    'interruptSession',
    'createRemoteSession',
    'remoteEntityAction',
  ]);

  let getStateInFlight = null;

  function invalidateGetState() {
    getStateInFlight = null;
    todoActions.invalidate?.();
  }

  /** 同步拉取各台远端设备的会话卡片与工作区树；对未返回 workspaces 的旧版远端自动按卡片合成工作区。 */
  async function collectRemoteCardsAndWorkspaces() {
    const devices = await bridge.getDevices();
    const pairs = await Promise.all(devices.map(async (device) => {
      // 明确离线或待鉴权的设备直接跳过，避免超时拖慢整个待办列表刷新。
      if (!device?.deviceId || device.online === false || device.status === 'offline' || device.status === 'needs_auth') {
        return { deviceCards: [], deviceWorkspaces: [], authoritativeDeviceId: null };
      }
      const deviceMeta = {
        deviceId: device.deviceId,
        name: device.name || '远程设备',
        isLocal: false,
      };
      const result = await bridge.requestDevice(device.deviceId, ROUTE_PATH, { action: 'getLocalSessions' });
      const remoteLights = device.sessionStatesV2 && typeof device.sessionStatesV2 === 'object'
        ? device.sessionStatesV2
        : null;

      let deviceCards = [];
      const hasAuthoritativeCards = Boolean(result?.ok && Array.isArray(result.cards));
      // 本次 cards / tree 是权威读取：此前探针即使为 busy/waiting 也不能反盖它。
      // 无版本旧设备同样按来源优先级降级，不能用本机时间猜测对端版本。
      if (hasAuthoritativeCards) {
        const mapped = result.cards.map((card) => {
          const status = card.status || 'idle';
          return {
            ...card,
            title: sanitizeLoneSurrogates(card.title || ''),
            summary: sanitizeLoneSurrogates(card.summary || ''),
            workspace: sanitizeLoneSurrogates(card.workspace || ''),
            cwd: sanitizeLoneSurrogates(card.cwd || ''),
            status,
            deviceId: device.deviceId,
            deviceName: device.name || card.deviceName || '远程设备',
            isLocal: false,
          };
        });
        // 若远端会话数超过 50 条且尚未重启更新插件，getLocalSessions 可能把排在 50 条之后的新活跃会话截丢；用原生 session/list 兜底补齐。
        const presentIds = new Set(mapped.map((card) => card.sessionId));
        const hiddenIds = new Set(Array.isArray(result.hiddenSessionIds) ? result.hiddenSessionIds : []);
        // 旧设备未发布隐藏 ID 时，权威工作区中的空闲缺席项也不能被旧探针重新补入。
        for (const ws of Array.isArray(result.workspaces) ? result.workspaces : []) {
          for (const session of Array.isArray(ws?.sessions) ? ws.sessions : []) {
            if (session.status === 'idle' && !presentIds.has(session.sessionId)) hiddenIds.add(session.sessionId);
          }
        }
        const hasMissingActiveInLights = remoteLights
          && Object.entries(remoteLights).some(([id, light]) => light && light !== 'idle' && !presentIds.has(id) && !hiddenIds.has(id));
        const deviceActiveStatus = device.statusV2 || device.status;
        const hasDeviceActiveWithoutCard = (deviceActiveStatus === 'busy' || deviceActiveStatus === 'waiting')
          && !mapped.some((card) => card.status && card.status !== 'idle');
        if (hasMissingActiveInLights || hasDeviceActiveWithoutCard) {
          const supplemented = await fetchRemoteNativeSessions(bridge, device, remoteSessionStates);
          // native 只补缺失会话；已存在的权威状态不接受旧 probe 的间接升级。
          const merged = [...mapped];
          for (const nativeCard of supplemented) {
            if (!presentIds.has(nativeCard.sessionId) && !hiddenIds.has(nativeCard.sessionId)) {
              merged.push(nativeCard);
            }
          }
          deviceCards = merged;
        } else {
          deviceCards = mapped;
        }
      } else if (result?.httpStatus === 404 || result?.httpStatus === 405 || (!result?.error && !result?.httpStatus)) {
        // 仅当远端可达但未挂载 dsh-au-todo（404/405）时才降级拉取原生 session/list，避免离线超时设备二次阻塞。
        deviceCards = await fetchRemoteNativeSessions(bridge, device, remoteSessionStates);
      }

      let deviceWorkspaces = [];
      if (result?.ok && Array.isArray(result.workspaces) && result.workspaces.length > 0) {
        const cardById = new Map(deviceCards.map((card) => [card.sessionId, card]));
        const authoritativeIds = new Set(hasAuthoritativeCards ? result.cards.map((card) => card.sessionId) : []);
        deviceWorkspaces = result.workspaces.map((ws) => {
          const rawSessions = Array.isArray(ws?.sessions) ? ws.sessions : [];
          const sessions = rawSessions
            .map((session) => {
              const card = cardById.get(session.sessionId);
              // 两个权威读取只有携带日志版本时才比较：先 seq，再同 seq 的确认进度。
              const cardIsNewer = Number.isSafeInteger(card?.stateSeq) && card.stateSeq >= 0
                && (!Number.isSafeInteger(session.stateSeq) || session.stateSeq < card.stateSeq
                  || (session.stateSeq === card.stateSeq && (card.ackedSeq ?? -1) > (session.ackedSeq ?? -1)));
              const nativeRunning = !authoritativeIds.has(session.sessionId) && card?.running === true;
              const state = cardIsNewer || nativeRunning || !session.status ? (card || session) : session;
              const status = state.status || 'idle';
              return {
                ...session,
                title: sanitizeLoneSurrogates(session.title || ''),
                summary: sanitizeLoneSurrogates(session.summary || ''),
                cwd: sanitizeLoneSurrogates(session.cwd || ''),
                status,
                ...(state.stateSeq !== undefined ? { stateSeq: state.stateSeq, endSeq: state.endSeq, ackedSeq: state.ackedSeq } : {}),
                deviceId: device.deviceId,
                deviceName: device.name || ws?.deviceName || session.deviceName || '远程设备',
                isLocal: false,
              };
            })
            .filter((session) => !(
              Object.prototype.hasOwnProperty.call(session, 'summary')
              && isBlankTodoCard(session)
            ));
          const rawWsTitle = sanitizeLoneSurrogates(ws?.title || '');
          return {
            ...ws,
            title: rawWsTitle === 'default-workspace' ? '默认工作区' : (rawWsTitle || '默认工作区'),
            path: sanitizeLoneSurrogates(ws?.path || ''),
            deviceId: device.deviceId,
            deviceName: device.name || ws?.deviceName || '远程设备',
            isLocal: false,
            sessions,
          };
        });
        // native 补到平铺卡后也尝试挂入已有的真实工作区；
        // 远端已返回非空真实工作区列表时，只允许归入已存在的 target，严禁为游离卡片反向合成假工作区。
        const assignedIds = new Set(deviceWorkspaces.flatMap((ws) => ws.sessions.map((session) => session.sessionId)));
        const pathKey = (raw) => String(raw || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        for (const card of deviceCards) {
          if (assignedIds.has(card.sessionId) || isBlankTodoCard(card)) continue;
          const target = deviceWorkspaces.find((ws) => card.workspaceId && ws.workspaceId === card.workspaceId)
            || deviceWorkspaces.find((ws) => card.cwd && pathKey(ws.path) === pathKey(card.cwd));
          if (target) {
            target.sessions.push({ ...card, pinned: Boolean(card.pinned) });
            target.updatedAt = Math.max(Number(target.updatedAt) || 0, Number(card.updatedAt) || 0);
            assignedIds.add(card.sessionId);
          }
        }
        for (const ws of deviceWorkspaces) {
          ws.sessions.sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned))
            || (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0));
        }
      } else {
        // 仅当远端未返回工作区或返回为空数组时，才由平铺 Todo 卡片回退合成工作区。
        deviceWorkspaces = synthesizeWorkspacesFromCards(deviceCards, deviceMeta);
      }

      return { deviceCards, deviceWorkspaces, authoritativeDeviceId: hasAuthoritativeCards ? device.deviceId : null };
    }));

    const remoteResults = pairs.map((item) => item.deviceCards);
    const remoteWorkspaceGroups = pairs.map((item) => item.deviceWorkspaces);
    return {
      remoteResults,
      remoteWorkspaces: remoteWorkspaceGroups.flat(),
      authoritativeDeviceIds: pairs.map((item) => item.authoritativeDeviceId).filter(Boolean),
    };
  }

  async function dispatch(action, body) {
    const localDevice = bridge.getLocalDevice();

    // 变更高频操作立即使正在进行的 getState 缓存失效，确保下一次查询能读到最新状态
    if (MUTATING_ACTIONS.has(action)) {
      invalidateGetState();
    }

    try {
      if (action === 'getState') {
        if (getStateInFlight) return getStateInFlight;
        const task = (async () => {
          const local = await todoActions.getLocalSessions();
          const { remoteResults, remoteWorkspaces, authoritativeDeviceIds } = await collectRemoteCardsAndWorkspaces();
          const now = Date.now();
          return {
            ok: true,
            localDeviceId: localDevice.deviceId,
            authoritativeDeviceIds: [localDevice.deviceId, ...authoritativeDeviceIds],
            // 先去重、过滤空白和两天外会话，再排序和截断，避免旧卡占用展示名额。
            cards: sortTodoCards(dedupeTodoCards([...local, ...remoteResults.flat()])
              .filter((card) => !isBlankTodoCard(card) && isRecentTodoCard(card, now))).slice(0, 50),
            remoteWorkspaces,
          };
        })();
        getStateInFlight = task;
        try {
          return await task;
        } finally {
          if (getStateInFlight === task) {
            getStateInFlight = null;
          }
        }
      }
      if (action === 'getRemoteWorkspaces') {
        const { remoteWorkspaces } = await collectRemoteCardsAndWorkspaces();
        return {
          ok: true,
          localDeviceId: localDevice.deviceId,
          remoteWorkspaces,
        };
      }
      const deviceId = typeof body.deviceId === 'string' ? body.deviceId : '';
      if (action === 'createRemoteSession') {
        if (!deviceId || deviceId === localDevice.deviceId || deviceId === 'local') {
          return { ok: false, error: '仅支持在远端设备创建会话' };
        }
        const created = await createRemoteNativeSession(bridge, deviceId, {
          workspaceId: body.workspaceId,
          cwd: body.cwd || body.path || '',
        });
        if (created?.ok) {
          if (isFullAccessByDefault()) {
            void Promise.resolve(bridge.requestDevice(deviceId, '/api/settings/mutate', {
              type: 'client-request',
              rpcId: randomUUID(),
              method: 'settings/mutate',
              payload: {
                args: {
                  ns: 'permission',
                  ops: [{ op: 'set', path: ['defaultPreset'], value: 'danger-full-access' }],
                },
              },
            })).catch(() => {});
          }
          // 异步触发远端设备探活刷新，不阻塞新建会话结果返回（避免离线局域网路由探活卡住新建会话 4.5s）
          void Promise.resolve(bridge.refreshDevice?.(deviceId)).catch(() => {});
        }
        return created;
      }
      if (action === 'remoteEntityAction') {
        if (!deviceId || deviceId === localDevice.deviceId || deviceId === 'local') {
          return { ok: false, error: '仅支持在远端设备执行该动作' };
        }
        const res = await executeRemoteNativeEntityAction(bridge, deviceId, {
          entityAction: body.entityAction,
          sessionId: body.sessionId,
          workspaceId: body.workspaceId,
          title: body.title,
        });
        if (res?.ok) {
          void Promise.resolve(bridge.refreshDevice?.(deviceId)).catch(() => {});
        }
        return res;
      }
      if (!deviceId || deviceId === localDevice.deviceId || deviceId === 'local') {
        return todoActions.dispatchLocal(action, body);
      }
      // 跨设备操作交给目标设备的 dsh-au-todo；转发时将落地 deviceId 设为 local，防止未绑定归属的目标机把请求再次当成远程转发自环。
      const remoteResult = await bridge.requestDevice(deviceId, ROUTE_PATH, { ...body, deviceId: 'local', action });
      if (remoteResult?.ok) {
        if (action === 'confirmSession' || action === 'hideSession' || action === 'sendNextTodo' || action === 'interruptSession') {
          await bridge.refreshDevice?.(deviceId);
        }
        if (action === 'confirmSession' && remoteResult.confirmed === undefined) {
          // 旧 Todo 服务仅返回 ok；明确标记降级，不伪装为支持绑定结束版本的新协议。
          return { ...remoteResult, confirmed: true, legacy: true };
        }
        return remoteResult;
      }
      if (remoteResult?.httpStatus === 404 || remoteResult?.httpStatus === 405) {
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
        if (action === 'confirmSession' && sessionId) {
          const key = `${deviceId}:${sessionId}`;
          const observed = remoteSessionStates.get(key);
          if (body.expectedEndSeq !== undefined && (!Number.isSafeInteger(body.expectedEndSeq)
            || body.expectedEndSeq < 0 || observed?.endSeq !== body.expectedEndSeq
            || (observed?.status !== 'done' && observed?.status !== 'error' && observed?.status !== 'idle'))) {
            return { ok: false, confirmed: false, legacy: true, error: '远端未提供可确认的结束版本，请刷新后重试' };
          }
          // 旧设备无 Todo 确认入口：明确标记仅本机已读降级，不能声称修改了对端账本。
          const state = { ...observed, status: 'idle', acknowledged: true,
            ...(body.expectedEndSeq !== undefined ? { ackedSeq: body.expectedEndSeq } : {}) };
          remoteSessionStates.set(key, state);
          return { ok: true, confirmed: true, legacy: true, localOnly: true,
            ...(state.stateSeq !== undefined ? { state: { status: state.status, stateSeq: state.stateSeq, endSeq: state.endSeq, ackedSeq: state.ackedSeq } } : {}) };
        }
        if (action === 'interruptSession' && sessionId) {
          for (const [path, method] of [
            ['/api/session/cancel', 'session/cancel'],
            ['/api/session/interrupt', 'session/interrupt'],
          ]) {
            const cancelRes = await bridge.requestDevice(deviceId, path, {
              type: 'client-request',
              rpcId: randomUUID(),
              method,
              payload: { args: { sessionId, request: { sessionId } } },
            });
            if (cancelRes?.result?.ok || cancelRes?.ok === true) {
              await bridge.refreshDevice?.(deviceId);
              return { ok: true };
            }
          }
          return { ok: false, error: '远端设备不支持停止该会话' };
        }
        // 隐藏与暂存状态必须保存到对话所属设备；远端未加载 Todo 时不能违规写入当前设备账本。
        if ((action === 'hideSession' || action === 'setPinned') && sessionId) {
          return { ok: false, error: `目标设备尚未加载 dsh-au-todo，无法把${action === 'hideSession' ? '完成' : '暂存'}状态保存到该设备` };
        }
        if (action === 'sendNextTodo' && sessionId) {
          const todo = peekTodo(sessionId);
          if (!todo) return { ok: false, error: '该对话没有待续跑的 Todo' };
          // 使用由会话与待办 ID 派生的稳定 requestId，网络重试时宿主可按同一 requestId 幂等去重。
          const deterministicRequestId = `dsh-au-todo:${sessionId}:${todo.id}`;
          const promptRes = await bridge.requestDevice(deviceId, NATIVE_SESSION_PROMPT_PATH, {
            type: 'client-request',
            rpcId: randomUUID(),
            method: 'session/prompt',
            payload: {
              args: {
                request: {
                  requestId: deterministicRequestId,
                  sessionId,
                  mode: 'queue',
                  content: [{ type: 'text', text: todo.text.trim() }],
                },
              },
            },
          });
          if (!promptRes?.result?.ok) {
            return { ok: false, error: promptRes?.result?.error?.message || promptRes?.error || '远程 Todo 投递失败' };
          }
          remoteSessionStates.set(`${deviceId}:${sessionId}`, { status: 'idle', acknowledged: true });
          removeTodo(sessionId, todo.id);
          return { ok: true, todoId: todo.id };
        }
        return todoActions.dispatchLocal(action, body);
      }
      return action === 'confirmSession' ? { ...remoteResult, ok: false, confirmed: false } : remoteResult;
    } finally {
      if (MUTATING_ACTIONS.has(action)) {
        invalidateGetState();
      }
    }
  }

  let disposeRoute = null;
  try {
    disposeRoute = server.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: async (req, res) => {
        const rejection = typeof checkRequest === 'function' ? checkRequest(req) : undefined;
        if (rejection !== undefined) {
          sendJson(res, rejection, { ok: false, error: rejection === 401 ? 'Unauthorized' : 'Forbidden' });
          return;
        }
        if (!isEnabled()) {
          sendJson(res, 404, { ok: false, error: '待办面板已在 DSH AU 设置中关闭' });
          return;
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
          return;
        }
        const body = await readJsonBody(req);
        try {
          sendJson(res, 200, await dispatch(body.action || 'getState', body));
        } catch (error) {
          sendJson(res, 500, { ok: false, ...(body.action === 'confirmSession' ? { confirmed: false } : {}), error: `Todo 操作失败: ${error?.message || 'unknown'}` });
        }
      },
    });
    globalThis.__dshAuTodoDisposeRoute = disposeRoute;
  } catch (error) {
    console.warn('[dsh-au] 无法注册待办接口', error);
  }

  return () => {
    if (typeof disposeRoute === 'function') {
      try { disposeRoute(); } catch {}
      if (globalThis.__dshAuTodoDisposeRoute === disposeRoute) globalThis.__dshAuTodoDisposeRoute = null;
    }
    if (globalThis[APPLY_LOCK]) delete globalThis[APPLY_LOCK];
  };
}
