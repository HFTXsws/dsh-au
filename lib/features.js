/** 需要宿主机参与的内置功能开关；mobile 只影响各访问端的浏览器，开关存在浏览器本地，不进这里。 */
export const DEFAULT_FEATURES = Object.freeze({
  todo: true,
  fullAccessByDefault: false,
  blockGoalCreation: false,
  // 锁屏断开远程 DSH 只属于这台电脑，默认关闭，不进云偏好。
  disconnectRemotesOnLock: false,
});

/** todo 缺字段时开启；权限、目标限制和锁屏断开只有显式 true 才启用，旧配置保持原行为。 */
export function normalizeFeatures(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    todo: source.todo !== false,
    fullAccessByDefault: source.fullAccessByDefault === true,
    blockGoalCreation: source.blockGoalCreation === true,
    disconnectRemotesOnLock: source.disconnectRemotesOnLock === true,
  };
}

/** 出厂不带续跑规则。503 / 413 属于私人同步配置，不写进每个人的默认值。 */
export const DEFAULT_AUTO_CONTINUE_RULES = Object.freeze([]);

/** 归一化单条自动续跑规则：补齐缺省值与合法边界裁剪 */
export function normalizeAutoContinueRule(rule, index = 0) {
  const rawId = typeof rule?.id === 'string' ? rule.id.trim() : '';
  const id = rawId || `rule-${index + 1}`;

  const rawName = typeof rule?.name === 'string' ? rule.name.trim() : '';
  const name = rawName || `自定义错误规则 ${index + 1}`;

  const enabled = rule?.enabled !== false;

  let rawCodes = [];
  if (Array.isArray(rule?.statusCodes)) {
    rawCodes = rule.statusCodes;
  } else if (typeof rule?.statusCodes === 'string') {
    rawCodes = rule.statusCodes.split(/[,\s]+/);
  } else if (typeof rule?.statusCodes === 'number') {
    rawCodes = [rule.statusCodes];
  }
  const statusCodes = [];
  const seenCodes = new Set();
  for (const item of rawCodes) {
    const n = Math.round(Number(item));
    if (Number.isInteger(n) && n >= 100 && n <= 599 && !seenCodes.has(n)) {
      seenCodes.add(n);
      statusCodes.push(n);
    }
  }

  let rawKeywords = [];
  if (Array.isArray(rule?.keywords)) {
    rawKeywords = rule.keywords;
  } else if (typeof rule?.keywords === 'string') {
    rawKeywords = rule.keywords.split(',');
  }
  const keywords = [];
  const seenKeywords = new Set();
  for (const item of rawKeywords) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed && !seenKeywords.has(trimmed)) {
        seenKeywords.add(trimmed);
        keywords.push(trimmed);
      }
    }
  }

  const action = (rule?.action === 'compact_retry' || rule?.action === 'followup_prompt')
    ? rule.action
    : 'wait_retry';

  const defaultDelay = action === 'compact_retry' ? 0 : 60;
  const rawDelay = rule?.delaySec;
  let delaySec = defaultDelay;
  if (rawDelay !== undefined && rawDelay !== null && String(rawDelay).trim() !== '') {
    const num = Number(rawDelay);
    if (Number.isFinite(num)) {
      delaySec = Math.min(600, Math.max(0, Math.round(num)));
    }
  }

  const rawRetries = rule?.maxRetries;
  let maxRetries = 5;
  if (rawRetries !== undefined && rawRetries !== null && String(rawRetries).trim() !== '') {
    const num = Number(rawRetries);
    if (Number.isFinite(num)) {
      maxRetries = Math.min(30, Math.max(1, Math.round(num)));
    }
  }

  const compactOnSecondAttempt = Boolean(rule?.compactOnSecondAttempt);

  return {
    id,
    name,
    enabled,
    statusCodes,
    keywords,
    action,
    delaySec,
    maxRetries,
    compactOnSecondAttempt,
  };
}

/** 智能恢复与自动续跑默认关闭，且没有规则。私人仓库同步过来的配置会原样保留。 */
export const DEFAULT_AUTO_CONTINUE = Object.freeze({
  enabled: false,
  retryDelaySec: 60,
  maxRetries: 5,
  compactOnDisconnect: true,
  continueOnTruncate: true,
  prompt: '继续',
  rules: DEFAULT_AUTO_CONTINUE_RULES,
});

/** 归一化自动续跑配置：边界裁剪并补齐缺省值，防止异常数值引发死循环。 */
export function normalizeAutoContinue(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const isDefaultRulesRef = source.rules === DEFAULT_AUTO_CONTINUE_RULES ||
    (typeof DEFAULT_AUTO_CONTINUE === 'object' && source.rules === DEFAULT_AUTO_CONTINUE?.rules);
  const hasRules = Array.isArray(source.rules) && source.rules.length > 0 && !isDefaultRulesRef;
  const compactOnDisconnect = source.compactOnDisconnect !== false;

  let rules;
  let retryDelaySec;
  let maxRetries;

  if (hasRules) {
    rules = source.rules.map((rule, idx) => normalizeAutoContinueRule(rule, idx));
    const targetRule = rules.find((r) => r.id === 'rule-503') || rules.find((r) => r.action === 'wait_retry');

    if (source.retryDelaySec !== undefined && source.retryDelaySec !== null && String(source.retryDelaySec).trim() !== '') {
      const delayNum = Number(source.retryDelaySec);
      retryDelaySec = Number.isFinite(delayNum)
        ? Math.min(600, Math.max(5, Math.round(delayNum)))
        : DEFAULT_AUTO_CONTINUE.retryDelaySec;
    } else if (targetRule) {
      retryDelaySec = Math.min(600, Math.max(5, Math.round(targetRule.delaySec)));
    } else {
      retryDelaySec = DEFAULT_AUTO_CONTINUE.retryDelaySec;
    }

    if (source.maxRetries !== undefined && source.maxRetries !== null && String(source.maxRetries).trim() !== '') {
      const retriesNum = Number(source.maxRetries);
      maxRetries = Number.isFinite(retriesNum)
        ? Math.min(30, Math.max(1, Math.round(retriesNum)))
        : DEFAULT_AUTO_CONTINUE.maxRetries;
    } else if (targetRule) {
      maxRetries = Math.min(30, Math.max(1, Math.round(targetRule.maxRetries)));
    } else {
      maxRetries = DEFAULT_AUTO_CONTINUE.maxRetries;
    }
  } else {
    const delayNum = Number(source.retryDelaySec);
    const retriesNum = Number(source.maxRetries);
    retryDelaySec = Number.isFinite(delayNum)
      ? Math.min(600, Math.max(5, Math.round(delayNum)))
      : DEFAULT_AUTO_CONTINUE.retryDelaySec;
    maxRetries = Number.isFinite(retriesNum)
      ? Math.min(30, Math.max(1, Math.round(retriesNum)))
      : DEFAULT_AUTO_CONTINUE.maxRetries;

    rules = [];
  }

  const rawPrompt = typeof source.prompt === 'string' ? source.prompt.trim() : '';

  return {
    enabled: source.enabled === true,
    retryDelaySec,
    maxRetries,
    compactOnDisconnect,
    continueOnTruncate: source.continueOnTruncate !== false,
    prompt: rawPrompt ? rawPrompt.slice(0, 200) : DEFAULT_AUTO_CONTINUE.prompt,
    rules,
  };
}
