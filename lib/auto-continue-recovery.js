import { randomUUID as defaultRandomUUID } from 'node:crypto';
import { normalizeAutoContinue } from './features.js';

const OVERSIZED_RESPONSES_MESSAGE = 'Responses request exceeds 32 MiB';

/** 识别 413 / 超大请求体 / 上下文超限相关的错误消息模式 */
const PAYLOAD_TOO_LARGE_MESSAGE_RE = /\b413\b|payload too large|request_too_large|request too large|context_length_exceeded|prompt is too long|too many tokens|exceeds the maximum|Responses request exceeds 32 MiB/i;

const PAYLOAD_TOO_LARGE_CODES = new Set([
  'CONTEXT_OVERFLOW',
  'PAYLOAD_TOO_LARGE',
]);

/** 识别 413 / 上下文超限 / 超大请求体等需要先压缩后原地继续的错误 */
export function isPayloadTooLargeOrOverflowFailure(failure) {
  if (!failure || typeof failure !== 'object') return false;
  if (isTerminalAuthOrQuotaFailure(failure)) return false;

  const status = Number(failure.status);
  const code = typeof failure.code === 'string' ? failure.code.trim() : '';
  const message = String(failure.message || '');

  if (status === 413) return true;
  if (PAYLOAD_TOO_LARGE_CODES.has(code)) return true;
  if (PAYLOAD_TOO_LARGE_MESSAGE_RE.test(message)) return true;
  return false;
}

/** 可原地无痕重试的临时错误码集合 */
const RECOVERABLE_CODES = new Set([
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'RATE_LIMIT',
  'EMPTY_RESPONSE',
]);

/** 可原地恢复的上游断连、网关缺号、过载与异常结尾错误消息特征 */
const RECOVERABLE_MESSAGE_RE = /auth_unavailable|no auth available|Remote end closed connection|internal_server_error|service is currently unavailable|overloaded|ECONNRESET|ETIMEDOUT|socket hang up|requests ending with a model turn are not supported/i;

/** 429 场景下属于额度/余额耗尽而非速率限制的终态关键词 */
const QUOTA_EXHAUSTED_MESSAGE_RE = /quota|insufficient|balance|credit|billing|额度|余额|欠费/i;

const TERMINAL_AUTH_CODES = new Set([
  'AUTH',
  'INVALID_CREDENTIAL',
  'MISSING_CREDENTIAL',
  'QUOTA',
]);

/** 识别鉴权失败或账户额度耗尽终态，防止对不可恢复错误死循环重试。 */
export function isTerminalAuthOrQuotaFailure(failure) {
  const status = Number(failure?.status);
  const code = typeof failure?.code === 'string' ? failure.code.trim() : '';
  const message = String(failure?.message || '');
  if (status === 401 || status === 402 || status === 403) return true;
  if (TERMINAL_AUTH_CODES.has(code)) return true;
  if ((status === 429 || /\b429\b/.test(message)) && QUOTA_EXHAUSTED_MESSAGE_RE.test(message)) {
    return true;
  }
  return false;
}

/** 识别允许第一层拦截并原地重试的临时网关/网络错误。 */
export function isTransientRecoverableFailure(failure) {
  if (!failure || typeof failure !== 'object') return false;
  const message = String(failure.message || '');
  if (message.includes(OVERSIZED_RESPONSES_MESSAGE)) return false;
  if (isTerminalAuthOrQuotaFailure(failure)) return false;

  const status = Number(failure.status);
  const code = typeof failure.code === 'string' ? failure.code.trim() : '';
  if (status === 408 || status === 429 || (Number.isFinite(status) && status >= 500)) {
    return true;
  }
  if (RECOVERABLE_CODES.has(code)) return true;
  return RECOVERABLE_MESSAGE_RE.test(message);
}

/** 匹配第一条命中的自动续跑规则 */
export function matchAutoContinueRule(failure, rules) {
  if (!failure || typeof failure !== 'object') return null;
  if (isTerminalAuthOrQuotaFailure(failure)) return null;
  if (!Array.isArray(rules)) return null;

  const status = Number(failure.status);
  const message = typeof failure.message === 'string' ? failure.message : String(failure.message || '');
  const code = typeof failure.code === 'string' ? failure.code : String(failure.code || '');
  const lowerMessage = message.toLowerCase();
  const lowerCode = code.toLowerCase();

  const enabledRules = [];
  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue;
    enabledRules.push(rule);

    const statusCodes = Array.isArray(rule.statusCodes) ? rule.statusCodes : [];
    const keywords = Array.isArray(rule.keywords) ? rule.keywords : [];

    const statusMatched = Number.isFinite(status) && statusCodes.includes(status);
    let keywordMatched = false;
    for (const kw of keywords) {
      if (typeof kw === 'string' && kw.length > 0) {
        const lowerKw = kw.toLowerCase();
        if (lowerMessage.includes(lowerKw) || lowerCode.includes(lowerKw)) {
          keywordMatched = true;
          break;
        }
      }
    }

    if (statusMatched || keywordMatched) {
      return rule;
    }
  }

  // 兜底兼容：未直接命中状态码或关键词时，检查历史错误特征兼容匹配
  for (const rule of enabledRules) {
    const statusCodes = Array.isArray(rule.statusCodes) ? rule.statusCodes : [];
    const is413Rule = rule.id === 'rule-413' || statusCodes.includes(413);
    if (is413Rule && isPayloadTooLargeOrOverflowFailure(failure)) {
      return rule;
    }

    const is503Rule = rule.id === 'rule-503' || statusCodes.includes(503);
    if (is503Rule && isTransientRecoverableFailure(failure)) {
      return rule;
    }
  }

  return null;
}

/** 优先从当前 Agent Preset 隔离域取压缩服务，旧宿主才回退全局压缩服务。 */
function compactionServiceFor(ctx, agent) {
  const presets = ctx.get?.('agentPresets');
  if (presets) return presets.serviceFor?.(agent, 'compaction');
  return ctx.get?.('compaction');
}

/** 提取 turn/end 的原因类型字符串 */
function reasonKind(reason) {
  if (!reason) return undefined;
  if (typeof reason === 'string') return reason;
  if (typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind;
  return undefined;
}

/** 排除子代理会话与后台审查会话，避免覆盖父代理调度 */
function isExcludedSession(session) {
  if (!session || typeof session !== 'object') return true;
  const sid = typeof session.id === 'string' ? session.id : '';
  if (sid.startsWith('hermes-loop-review-')) return true;
  if (session.header?.origin === 'subagent') return true;
  return false;
}

/** 默认可中断等待实现：支持 AbortSignal 随时取消 */
function defaultInterruptibleSleep(delayMs, signal) {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, Math.max(0, delayMs));
    timer.unref?.();
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 安装 DSH-AU 智能恢复与自动续跑：
 * 1. 请求层（agent/request-error）：遇到 503/5xx/远端断连/413 等符合规则的错误时原地恢复。
 * 2. 回合层（session/event turn/end）：遇到 max-tokens 输出截断或 interrupted 孤儿轮时，
 *    短延迟 2 秒后自动发送 followup 续写指令。
 */
export function installAutoContinueRecovery(ctx, getConfig, options = {}) {
  const sleep = typeof options.sleep === 'function' ? options.sleep : defaultInterruptibleSleep;
  const makeUuid = typeof options.randomUUID === 'function' ? options.randomUUID : defaultRandomUUID;
  const truncateDelayMs = Number.isFinite(options.truncateDelayMs) ? Math.max(0, options.truncateDelayMs) : 2000;

  const requestStateByAgent = new WeakMap();
  const agentsBySession = new WeakMap();
  const truncateStateBySessionId = new Map();
  const disposers = [];

  const readAutoContinue = () => {
    const raw = typeof getConfig === 'function' ? getConfig()?.autoContinue : getConfig?.autoContinue;
    return normalizeAutoContinue(raw);
  };

  const stateForAgent = (agent) => {
    let st = requestStateByAgent.get(agent);
    if (!st) {
      st = { attempts: 0, compactedOnce: false, ruleAttempts: {} };
      requestStateByAgent.set(agent, st);
    }
    if (!st.ruleAttempts) {
      st.ruleAttempts = {};
    }
    const session = agent?.session;
    if (session && (typeof session === 'object' || typeof session === 'function')) {
      let set = agentsBySession.get(session);
      if (!set) {
        set = new Set();
        agentsBySession.set(session, set);
      }
      set.add(agent);
    }
    return st;
  };

  const resetAgentState = (agent) => {
    if (!agent || (typeof agent !== 'object' && typeof agent !== 'function')) return;
    requestStateByAgent.delete(agent);
    const session = agent.session;
    const set = session && agentsBySession.get(session);
    if (set) {
      set.delete(agent);
      if (set.size === 0) agentsBySession.delete(session);
    }
  };

  const resetSessionAgents = (session) => {
    if (!session || (typeof session !== 'object' && typeof session !== 'function')) return;
    const set = agentsBySession.get(session);
    if (set) {
      for (const agent of set) requestStateByAgent.delete(agent);
      agentsBySession.delete(session);
    }
  };

  const cancelTruncateTimer = (sid) => {
    const st = truncateStateBySessionId.get(sid);
    if (st?.timer) {
      clearTimeout(st.timer);
      st.timer = null;
    }
  };

  // 第一层：请求错误原地恢复（不结束回合，不往聊天记录塞垃圾消息）
  if (typeof ctx?.on === 'function') {
    disposers.push(ctx.on('agent/request-error', async ({ agent, failure, signal } = {}, next) => {
      const cfg = readAutoContinue();
      if (!cfg.enabled || signal?.aborted) return next();
      if (!agent || (typeof agent !== 'object' && typeof agent !== 'function')) return next();
      if (isExcludedSession(agent.session)) return next();

      const rule = matchAutoContinueRule(failure, cfg.rules);
      if (!rule) return next();

      const st = stateForAgent(agent);
      const ruleId = rule.id || 'default';
      const ruleAttempts = st.ruleAttempts[ruleId] || 0;
      const ruleMaxRetries = Number.isFinite(rule.maxRetries) && rule.maxRetries > 0 ? rule.maxRetries : cfg.maxRetries;

      if (ruleAttempts >= ruleMaxRetries) {
        return next();
      }

      if (rule.action === 'compact_retry') {
        const compaction = compactionServiceFor(ctx, agent);
        if (typeof compaction?.compactIfNeeded !== 'function') {
          return next();
        }

        try {
          await compaction.compactIfNeeded(agent, 'context-overflow', signal);
        } catch {
          return next();
        }

        if (signal?.aborted) return next();

        st.attempts += 1;
        st.ruleAttempts[ruleId] = ruleAttempts + 1;

        if (Number.isFinite(rule.delaySec) && rule.delaySec > 0) {
          const completedWait = await sleep(rule.delaySec * 1000, signal);
          if (!completedWait || signal?.aborted) return next();
        }

        return { kind: 'retry' };
      }

      if (rule.action === 'wait_retry') {
        st.attempts += 1;
        st.ruleAttempts[ruleId] = ruleAttempts + 1;

        // 连续第 2 次及以上报错（或远端因大包断连重试）且开启了断连自动压缩时，先尝试隔离压缩一次
        const shouldCompact = (rule.compactOnSecondAttempt || cfg.compactOnDisconnect) && !st.compactedOnce && st.attempts >= 2;
        if (shouldCompact) {
          st.compactedOnce = true;
          try {
            const compaction = compactionServiceFor(ctx, agent);
            if (typeof compaction?.compactIfNeeded === 'function') {
              await compaction.compactIfNeeded(agent, 'context-overflow', signal);
            }
          } catch {
            // 压缩失败不阻断后续延迟重试
          }
        }

        if (signal?.aborted) return next();

        const retryAfterMs = Number.isFinite(failure?.providerRetryAfterMs) && failure.providerRetryAfterMs > 0
          ? failure.providerRetryAfterMs
          : 0;
        const configuredDelaySec = Number.isFinite(rule.delaySec) ? rule.delaySec : cfg.retryDelaySec;
        const delayMs = Math.min(600_000, Math.max(configuredDelaySec * 1000, retryAfterMs));
        const completedWait = await sleep(delayMs, signal);
        if (!completedWait || signal?.aborted) return next();

        return { kind: 'retry' };
      }

      if (rule.action === 'followup_prompt') {
        st.attempts += 1;
        st.ruleAttempts[ruleId] = ruleAttempts + 1;

        const delaySec = Number.isFinite(rule.delaySec) ? rule.delaySec : 2;
        const delayMs = delaySec * 1000;
        if (delayMs > 0) {
          const completedWait = await sleep(delayMs, signal);
          if (!completedWait || signal?.aborted) return next();
        }
        return { kind: 'retry' };
      }

      return next();
    }));

    disposers.push(ctx.on('agent/status', ({ agent, status } = {}) => {
      if (status === 'idle') resetAgentState(agent);
    }));

    // 第二层：会话事件监听（重置恢复状态 + 处理 max-tokens / interrupted 接力续写）
    disposers.push(ctx.on('session/event', (session, event) => {
      if (!event || typeof event !== 'object') return;
      if (event.type === 'assistant/message') {
        resetSessionAgents(session);
        return;
      }
      const sid = typeof session?.id === 'string' ? session.id : '';
      if (!sid) return;

      if (event.type === 'turn/start') {
        cancelTruncateTimer(sid);
        return;
      }
      if (event.type !== 'turn/end') return;

      const kind = reasonKind(event.data?.reason);
      if (kind === 'completed') {
        resetSessionAgents(session);
        cancelTruncateTimer(sid);
        truncateStateBySessionId.delete(sid);
        return;
      }
      if (kind !== 'max-tokens' && kind !== 'interrupted') return;
      if (isExcludedSession(session)) return;

      const cfg = readAutoContinue();
      if (!cfg.enabled || !cfg.continueOnTruncate) return;

      let st = truncateStateBySessionId.get(sid);
      if (!st) {
        st = { attempts: 0, timer: null };
        truncateStateBySessionId.set(sid, st);
      }
      if (st.timer !== null || st.attempts >= cfg.maxRetries) return;

      const fireFollowup = () => {
        st.timer = null;
        const latestCfg = readAutoContinue();
        if (!latestCfg.enabled || !latestCfg.continueOnTruncate) return;
        const liveAgent = ctx.agents && typeof ctx.agents.get === 'function' ? ctx.agents.get(sid) : undefined;
        if (!liveAgent || typeof liveAgent.followup !== 'function') return;
        st.attempts += 1;
        try {
          liveAgent.followup({
            id: makeUuid(),
            role: 'user',
            content: [{ type: 'text', text: latestCfg.prompt }],
            source: { kind: 'dsh-au-continue' },
          });
        } catch {}
      };

      if (truncateDelayMs <= 0) {
        fireFollowup();
      } else {
        st.timer = setTimeout(fireFollowup, truncateDelayMs);
        st.timer.unref?.();
      }
    }));
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const sid of truncateStateBySessionId.keys()) cancelTruncateTimer(sid);
    truncateStateBySessionId.clear();
    for (const dispose of disposers.reverse()) {
      if (typeof dispose === 'function') dispose();
    }
  };
}

export const install = installAutoContinueRecovery;
