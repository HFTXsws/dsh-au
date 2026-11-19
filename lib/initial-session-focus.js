import { randomUUID } from 'node:crypto';
import { readSessionEventsAfter } from './session-reader.js';

const FOCUS_RANK = { busy: 0, waiting: 1, done: 2, error: 2 };
const KEEP_CURRENT = { ok: true, sessionId: '', reason: 'keep-current' };
const QUERY_FAILED = { ok: false, errorCode: 'FOCUS_QUERY_FAILED' };

function isRootVisible(record) {
  const header = record?.header || {};
  const metadata = record?.projections?.values?.sessionListMetadata || {};
  return record?.origin !== 'subagent' && header.origin !== 'subagent'
    && ![record?.delegationDepth, header.delegationDepth].some((depth) => Number(depth) > 0)
    && ![record, header, metadata].some((value) => value?.archived === true || value?.isArchived === true);
}

function activityTime(record) {
  const values = [record.updatedAt, record.header?.updatedAt, record.header?.createdAt,
    record.projections?.values?.sessionListMetadata?.lastPromptAt];
  return values.reduce((latest, value) => {
    if (typeof value !== 'number' && typeof value !== 'string') return latest;
    const time = Number.isFinite(Number(value)) ? Number(value) : Date.parse(value);
    return Number.isFinite(time) && time > latest ? time : latest;
  }, 0);
}

/** 只选择有明确待处理状态的对话；相同状态取最近活动，完全同分按 ID 稳定排序。 */
export function selectInitialSessionFocus(candidates) {
  const ranked = (Array.isArray(candidates) ? candidates : [])
    .filter((item) => typeof item?.sessionId === 'string' && item.sessionId.length > 0
      && item.sessionId.length <= 128 && Object.hasOwn(FOCUS_RANK, item.status) && isRootVisible(item))
    .map((item) => ({ sessionId: item.sessionId, status: item.status, updatedAt: activityTime(item) }))
    .sort((left, right) => FOCUS_RANK[left.status] - FOCUS_RANK[right.status]
      || right.updatedAt - left.updatedAt
      || (left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0));
  const selected = ranked[0];
  // 返回值刻意不包含标题、正文、工作目录或连接信息。
  return selected ? { ok: true, sessionId: selected.sessionId, reason: selected.status } : { ...KEEP_CURRENT };
}

/** 为首次进入提供只读目标；配置只来自宿主闭包，不读取或写回生产配置。 */
export function createInitialSessionFocusResolver({ ctx, statusTracker, remotePool, getConfig }) {
  return async function resolveInitialSessionFocus(body = {}) {
    try {
      if (body?.deviceId === 'local') {
        const records = await ctx.get?.('sessionQuery')?.listSessions?.() || [];
        const archivedIds = new Set(ctx.get?.('workspaceRegistry')?.archivedSessionIds || []);
        const lights = statusTracker.getSnapshot().sessionsV2 || {};
        // 必须先按全部根会话的状态选最高组，不能先截50条而丢掉更老的运行会话。
        const candidates = records.filter(isRootVisible).filter((record) => {
          const id = record.header?.id;
          return typeof id === 'string' && id.length > 0 && id.length <= 128
            && !archivedIds.has(id) && Object.hasOwn(FOCUS_RANK, lights[id]);
        }).map((record) => ({ sessionId: record.header.id, status: lights[record.header.id], updatedAt: activityTime(record) }));
        if (!candidates.length) return { ...KEEP_CURRENT };
        const bestRank = Math.min(...candidates.map((item) => FOCUS_RANK[item.status]));
        const highest = candidates.filter((item) => FOCUS_RANK[item.status] === bestRank);
        // 仅最高优先级候选读取事件时间，四条一批；不读取标题/摘要或让空闲会话触发观察。
        for (let index = 0; index < highest.length; index += 4) {
          await Promise.all(highest.slice(index, index + 4).map(async (item) => {
            try {
              const events = await readSessionEventsAfter(ctx, item.sessionId);
              const latest = events.reduce((time, event) => Math.max(time, activityTime({ updatedAt: event?.time })), 0);
              if (latest > 0) item.updatedAt = latest;
            } catch {
              // 单个历史读取失败只回落已有记录时间，不伪造Date.now，也不放弃整组选择。
            }
          }));
        }
        return selectInitialSessionFocus(highest);
      }

      const config = getConfig();
      const remotes = Array.isArray(config?.remotes) ? config.remotes : [];
      const registered = remotes.find((route) => typeof body?.deviceId === 'string' && typeof body.routeId === 'string'
        && route.id === body.routeId && route.deviceId === body.deviceId);
      if (!registered) return { ...QUERY_FAILED };
      const expectedUrl = registered.url;
      const registrationMatches = () => getConfig()?.remotes?.some((route) => route.id === body.routeId
        && route.deviceId === body.deviceId && route.url === expectedUrl);
      // syncRemotes 必须保留完整名单；只传单条会回收其它正在保活的代理。
      const routes = await remotePool.syncRemotes(remotes);
      const exactRoute = routes.find((route) => route.id === body.routeId && route.deviceId === body.deviceId);
      if (!exactRoute || !registrationMatches()) return { ...QUERY_FAILED };
      const response = await remotePool.requestJson(body.routeId, '/api/session/list', {
        type: 'client-request', rpcId: randomUUID(), method: 'session/list', payload: { args: { _request: {} } },
      });
      const items = response?.result?.value?.items;
      if (response?.result?.ok !== true || !Array.isArray(items)) return { ...QUERY_FAILED };
      // 配置在查询期间换机/改址时拒绝迟到结果，绝不模糊切到另一条路线。
      if (!registrationMatches()) return { ...QUERY_FAILED };
      const lights = exactRoute.sessionStatesV2 || {};
      return selectInitialSessionFocus(items.filter(isRootVisible).map((item) => ({
        ...item,
        // 原生实时 running 比上一轮探测灯色更可靠；否则只接受明确的 V2 状态，不猜 done。
        status: item.running === true ? 'busy' : lights[item.sessionId],
      })));
    } catch {
      // 查询失败不改变正在看的对话；错误返回不携带网络地址或原始异常内容。
      return { ...QUERY_FAILED };
    }
  };
}
