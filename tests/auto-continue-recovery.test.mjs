import './isolate-sync.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_AUTO_CONTINUE } from '../lib/features.js';
import {
  installAutoContinueRecovery,
  isPayloadTooLargeOrOverflowFailure,
  isTimeoutFailure,
  matchAutoContinueRule,
} from '../lib/auto-continue-recovery.js';

function createAgent(id = 'agent-1', sessionOverrides = {}) {
  const followups = [];
  const session = {
    id: `session-${id}`,
    header: {},
    surface: { replaceGeneration: 0 },
    ...sessionOverrides,
  };
  return {
    id,
    status: 'running',
    session,
    followups,
    async followup(message) {
      followups.push(message);
    },
  };
}

function createHost({
  autoContinue = {},
  presetCompaction,
  fallbackCompaction,
  hasPresetRegistry = true,
  agents = [],
  options = {},
} = {}) {
  const listeners = new Map();
  const agentMap = new Map(agents.map((a) => [a.session.id, a]));
  // 恢复行为测试自己带上规则。产品出厂默认是关闭且没有规则。
  const compactOnDisconnect = autoContinue.compactOnDisconnect !== false;
  const retryDelaySec = Number.isFinite(autoContinue.retryDelaySec) ? autoContinue.retryDelaySec : 60;
  const maxRetries = Number.isFinite(autoContinue.maxRetries) ? autoContinue.maxRetries : 5;
  const fixtureRules = [
    {
      id: 'rule-503',
      name: '503',
      enabled: true,
      statusCodes: [503],
      keywords: ['auth_unavailable', 'no auth available', 'Remote end closed connection without response'],
      action: 'wait_retry',
      delaySec: retryDelaySec,
      maxRetries,
      compactOnSecondAttempt: compactOnDisconnect,
    },
    {
      id: 'rule-413',
      name: '413',
      enabled: compactOnDisconnect,
      statusCodes: [413],
      keywords: ['Payload Too Large', 'Responses request exceeds 32 MiB', 'request_too_large', 'context_length_exceeded'],
      action: 'compact_retry',
      delaySec: 0,
      maxRetries: 2,
      compactOnSecondAttempt: false,
    },
  ];
  let liveAutoContinue = {
    ...DEFAULT_AUTO_CONTINUE,
    enabled: true,
    ...autoContinue,
    rules: autoContinue.rules ?? fixtureRules,
  };

  const ctx = {
    agents: agentMap,
    get(name) {
      if (name === 'agentPresets' && hasPresetRegistry) {
        return { serviceFor: () => presetCompaction };
      }
      if (name === 'compaction') return fallbackCompaction;
      return undefined;
    },
    on(name, listener) {
      const group = listeners.get(name) || [];
      group.push(listener);
      listeners.set(name, group);
      return () => listeners.set(name, (listeners.get(name) || []).filter((item) => item !== listener));
    },
  };

  const dispose = installAutoContinueRecovery(ctx, () => ({ autoContinue: liveAutoContinue }), options);

  return {
    ctx,
    agentMap,
    dispose,
    setAutoContinue(patch) {
      liveAutoContinue = { ...liveAutoContinue, ...patch };
    },
    listenerCount(name) {
      return (listeners.get(name) || []).length;
    },
    emit(name, ...args) {
      for (const listener of [...(listeners.get(name) || [])]) listener(...args);
    },
    async requestError(payload) {
      const [listener] = listeners.get('agent/request-error') || [];
      assert.equal(typeof listener, 'function');
      let delegated = 0;
      const delegatedResult = { kind: 'original-error' };
      const result = await listener(payload, async () => {
        delegated += 1;
        return delegatedResult;
      });
      return { result, delegated, delegatedResult };
    },
  };
}

test('503 auth_unavailable / RemoteDisconnected 等待设定秒数后原地重试，连续第 2 次断连自动触发隔离压缩', async (t) => {
  const agent = createAgent('main');
  const sleeps = [];
  const compactions = [];
  const host = createHost({
    autoContinue: { enabled: true, retryDelaySec: 60, maxRetries: 3, compactOnDisconnect: true },
    presetCompaction: {
      async compactIfNeeded(receivedAgent, trigger) {
        compactions.push({ id: receivedAgent.id, trigger });
      },
    },
    options: {
      sleep: async (ms, sig) => {
        sleeps.push(ms);
        return !sig?.aborted;
      },
    },
  });
  t.after(host.dispose);

  const err503 = {
    status: 503,
    code: 'SERVER',
    message: 'auth_unavailable: no auth available (last upstream error: Remote end closed connection without response)',
  };

  // 第 1 次失败：不触发压缩，等待 60s 后返回 retry
  const first = await host.requestError({ agent, failure: err503, signal: new AbortController().signal });
  assert.deepEqual(first.result, { kind: 'retry' });
  assert.equal(first.delegated, 0);
  assert.deepEqual(sleeps, [60_000]);
  assert.equal(compactions.length, 0);

  // 第 2 次连续失败：触发一次 preset 压缩，再等待 60s 后返回 retry
  const second = await host.requestError({ agent, failure: err503, signal: new AbortController().signal });
  assert.deepEqual(second.result, { kind: 'retry' });
  assert.equal(compactions.length, 1);
  assert.deepEqual(compactions[0], { id: 'main', trigger: 'context-overflow' });

  // 第 3 次连续失败：本失败簇已压缩过，不再重复压缩，仍可重试第 3 次
  const third = await host.requestError({ agent, failure: err503, signal: new AbortController().signal });
  assert.deepEqual(third.result, { kind: 'retry' });
  assert.equal(compactions.length, 1);

  // 第 4 次连续失败：达到 maxRetries=3 上限，不再拦截，透传给 next() 防死循环
  const fourth = await host.requestError({ agent, failure: err503, signal: new AbortController().signal });
  assert.equal(fourth.delegated, 1);
  assert.deepEqual(fourth.result, fourth.delegatedResult);

  // 收到 assistant/message 后计数清零，后续新失败可再次恢复
  host.emit('session/event', agent.session, { type: 'assistant/message' });
  const afterReset = await host.requestError({ agent, failure: err503, signal: new AbortController().signal });
  assert.deepEqual(afterReset.result, { kind: 'retry' });
});

test('鉴权失败（401/403）、额度耗尽（QUOTA/429余额不足）、32MiB 413 与子代理不触发此恢复', async (t) => {
  const agent = createAgent('main');
  const subagent = createAgent('sub', { header: { origin: 'subagent' } });
  const host = createHost({
    options: { sleep: async () => true },
  });
  t.after(host.dispose);

  const nonRetryable = [
    { status: 401, code: 'AUTH', message: 'invalid api key' },
    { status: 403, code: 'AUTH', message: 'not allowed by your administrator' },
    { status: 429, code: 'QUOTA', message: 'insufficient balance' },
    { status: 429, code: 'RATE_LIMIT', message: '账户余额不足，请充值' },
    { status: 413, code: 'INVALID_REQUEST', message: 'Responses request exceeds 32 MiB' },
    { status: 400, code: 'INVALID_REQUEST', message: 'invalid json schema' },
  ];

  for (const failure of nonRetryable) {
    const out = await host.requestError({ agent, failure, signal: new AbortController().signal });
    assert.equal(out.delegated, 1, `should not intercept ${failure.message}`);
  }

  // 子代理不拦截
  const subOut = await host.requestError({
    agent: subagent,
    failure: { status: 503, code: 'SERVER', message: 'auth_unavailable' },
    signal: new AbortController().signal,
  });
  assert.equal(subOut.delegated, 1);

  // Model turn 400 可恢复
  const modelTurnOut = await host.requestError({
    agent,
    failure: { status: 400, code: 'INVALID_REQUEST', message: 'Requests ending with a model turn are not supported.' },
    signal: new AbortController().signal,
  });
  assert.deepEqual(modelTurnOut.result, { kind: 'retry' });
});

test('等待期间用户主动中止（AbortSignal）或关闭总开关时立即放弃重试', async (t) => {
  const agent = createAgent('main');
  const controller = new AbortController();
  const host = createHost({
    options: {
      sleep: async () => {
        controller.abort();
        return false;
      },
    },
  });
  t.after(host.dispose);

  const abortedOut = await host.requestError({
    agent,
    failure: { status: 503, code: 'SERVER', message: 'auth_unavailable' },
    signal: controller.signal,
  });
  assert.equal(abortedOut.delegated, 1);

  host.setAutoContinue({ enabled: false });
  const disabledOut = await host.requestError({
    agent,
    failure: { status: 503, code: 'SERVER', message: 'auth_unavailable' },
    signal: new AbortController().signal,
  });
  assert.equal(disabledOut.delegated, 1);
});

test('max-tokens 与 interrupted 回合结束时自动按配置提示词续写，completed 重置计数', async (t) => {
  const agent = createAgent('writer');
  const host = createHost({
    autoContinue: { enabled: true, maxRetries: 2, continueOnTruncate: true, prompt: '请继续输出' },
    agents: [agent],
    options: { truncateDelayMs: 0, randomUUID: () => 'uuid-fixed-1' },
  });
  t.after(host.dispose);

  host.emit('session/event', agent.session, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } });
  assert.equal(agent.followups.length, 1);
  assert.deepEqual(agent.followups[0], {
    id: 'uuid-fixed-1',
    role: 'user',
    content: [{ type: 'text', text: '请继续输出' }],
    source: { kind: 'dsh-au-continue' },
  });

  host.emit('session/event', agent.session, { type: 'turn/end', data: { reason: 'interrupted' } });
  assert.equal(agent.followups.length, 2);

  // 达到 maxRetries=2 后不再继续发送
  host.emit('session/event', agent.session, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } });
  assert.equal(agent.followups.length, 2);

  // 正常完成后重置计数
  host.emit('session/event', agent.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  host.emit('session/event', agent.session, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } });
  assert.equal(agent.followups.length, 3);
});

test('isPayloadTooLargeOrOverflowFailure 正确识别 413 / 超大请求体与上下文溢出', () => {
  assert.equal(isPayloadTooLargeOrOverflowFailure({ status: 413 }), true);
  assert.equal(isPayloadTooLargeOrOverflowFailure({ code: 'CONTEXT_OVERFLOW' }), true);
  assert.equal(isPayloadTooLargeOrOverflowFailure({ code: 'PAYLOAD_TOO_LARGE' }), true);
  assert.equal(isPayloadTooLargeOrOverflowFailure({ message: 'Payload Too Large' }), true);
  assert.equal(isPayloadTooLargeOrOverflowFailure({ message: 'request_too_large' }), true);
  assert.equal(isPayloadTooLargeOrOverflowFailure({ message: 'context_length_exceeded' }), true);
  assert.equal(isPayloadTooLargeOrOverflowFailure({ message: 'prompt is too long' }), true);
  assert.equal(isPayloadTooLargeOrOverflowFailure({ message: 'too many tokens' }), true);
  assert.equal(isPayloadTooLargeOrOverflowFailure({ message: 'exceeds the maximum context length' }), true);
  assert.equal(isPayloadTooLargeOrOverflowFailure({ message: 'Responses request exceeds 32 MiB' }), true);

  // 终态鉴权与额度排除
  assert.equal(isPayloadTooLargeOrOverflowFailure({ status: 401, message: 'payload too large' }), false);
  assert.equal(isPayloadTooLargeOrOverflowFailure({ status: 429, code: 'QUOTA', message: 'payload too large' }), false);
  assert.equal(isPayloadTooLargeOrOverflowFailure(null), false);
  assert.equal(isPayloadTooLargeOrOverflowFailure({ status: 500, message: 'internal error' }), false);
});

test('413 / Payload Too Large / Responses request exceeds 32 MiB 先压缩后原地重试，不等待 retryDelaySec', async (t) => {
  const agent = createAgent('main');
  const sleeps = [];
  const compactions = [];
  const host = createHost({
    autoContinue: { enabled: true, retryDelaySec: 60, maxRetries: 5, compactOnDisconnect: true },
    presetCompaction: {
      async compactIfNeeded(receivedAgent, trigger, signal) {
        compactions.push({ id: receivedAgent.id, trigger, hasSignal: !!signal });
      },
    },
    options: {
      sleep: async (ms) => {
        sleeps.push(ms);
        return true;
      },
    },
  });
  t.after(host.dispose);

  // 1. 触发 413 状态码
  const out1 = await host.requestError({
    agent,
    failure: { status: 413, message: 'Request Entity Too Large' },
    signal: new AbortController().signal,
  });
  assert.deepEqual(out1.result, { kind: 'retry' });
  assert.equal(out1.delegated, 0);
  assert.equal(compactions.length, 1);
  assert.deepEqual(compactions[0], { id: 'main', trigger: 'context-overflow', hasSignal: true });
  assert.equal(sleeps.length, 0, '413 压缩后应直接原地重试，不应调用 sleep 等待 60 秒');

  // 重置 session 状态以便测试第二种格式
  host.emit('session/event', agent.session, { type: 'assistant/message' });

  // 2. 触发 Responses request exceeds 32 MiB
  const out2 = await host.requestError({
    agent,
    failure: { status: 400, message: 'Responses request exceeds 32 MiB' },
    signal: new AbortController().signal,
  });
  assert.deepEqual(out2.result, { kind: 'retry' });
  assert.equal(out2.delegated, 0);
  assert.equal(compactions.length, 2);
  assert.equal(sleeps.length, 0);
});

test('没有 compaction 服务或 compactIfNeeded 抛错时，413 直接 next() 透传失败不死循环', async (t) => {
  const agent = createAgent('main');

  // 场景 A：无 compaction 服务
  const hostWithoutCompaction = createHost({
    autoContinue: { enabled: true, compactOnDisconnect: true },
    hasPresetRegistry: false,
    fallbackCompaction: null,
  });
  t.after(hostWithoutCompaction.dispose);

  const outNoService = await hostWithoutCompaction.requestError({
    agent,
    failure: { status: 413, message: 'Payload Too Large' },
    signal: new AbortController().signal,
  });
  assert.equal(outNoService.delegated, 1);
  assert.deepEqual(outNoService.result, outNoService.delegatedResult);

  // 场景 B：compactIfNeeded 抛出异常
  const hostThrowing = createHost({
    autoContinue: { enabled: true, compactOnDisconnect: true },
    presetCompaction: {
      async compactIfNeeded() {
        throw new Error('disk full or compaction error');
      },
    },
  });
  t.after(hostThrowing.dispose);

  const outThrow = await hostThrowing.requestError({
    agent,
    failure: { status: 413, message: 'Payload Too Large' },
    signal: new AbortController().signal,
  });
  assert.equal(outThrow.delegated, 1);
  assert.deepEqual(outThrow.result, outThrow.delegatedResult);

  // 场景 C：compactOnDisconnect 为 false 时不压缩并直接透传
  const hostDisabledCompact = createHost({
    autoContinue: { enabled: true, compactOnDisconnect: false },
    presetCompaction: {
      async compactIfNeeded() {},
    },
  });
  t.after(hostDisabledCompact.dispose);

  const outDisabled = await hostDisabledCompact.requestError({
    agent,
    failure: { status: 413, message: 'Payload Too Large' },
    signal: new AbortController().signal,
  });
  assert.equal(outDisabled.delegated, 1);
});

test('连续 413 超过上限（compactedFor413Count >= 2）时停止重试并 next()', async (t) => {
  const agent = createAgent('main');
  let compactions = 0;
  const host = createHost({
    autoContinue: { enabled: true, maxRetries: 5, compactOnDisconnect: true },
    presetCompaction: {
      async compactIfNeeded() {
        compactions += 1;
      },
    },
  });
  t.after(host.dispose);

  const err413 = { status: 413, message: 'Payload Too Large' };

  // 第 1 次 413
  const out1 = await host.requestError({ agent, failure: err413, signal: new AbortController().signal });
  assert.deepEqual(out1.result, { kind: 'retry' });
  assert.equal(out1.delegated, 0);
  assert.equal(compactions, 1);

  // 第 2 次 413
  const out2 = await host.requestError({ agent, failure: err413, signal: new AbortController().signal });
  assert.deepEqual(out2.result, { kind: 'retry' });
  assert.equal(out2.delegated, 0);
  assert.equal(compactions, 2);

  // 第 3 次 413：已达到 2 次压缩上限，停止重试，直接透传 next()
  const out3 = await host.requestError({ agent, failure: err413, signal: new AbortController().signal });
  assert.equal(out3.delegated, 1);
  assert.deepEqual(out3.result, out3.delegatedResult);
  assert.equal(compactions, 2);

  // 收到 assistant/message 后重置，可再次恢复
  host.emit('session/event', agent.session, { type: 'assistant/message' });
  const outAfterReset = await host.requestError({ agent, failure: err413, signal: new AbortController().signal });
  assert.deepEqual(outAfterReset.result, { kind: 'retry' });
  assert.equal(outAfterReset.delegated, 0);
  assert.equal(compactions, 3);
});

test('matchAutoContinueRule 正确匹配状态码、关键词与兜底兼容规则，排除终态错误与禁用规则', () => {
  const rules = [
    {
      id: 'rule-503',
      enabled: true,
      statusCodes: [503],
      keywords: ['auth_unavailable', 'no auth available'],
      action: 'wait_retry',
    },
    {
      id: 'rule-413',
      enabled: true,
      statusCodes: [413],
      keywords: ['Payload Too Large'],
      action: 'compact_retry',
    },
    {
      id: 'rule-custom',
      enabled: true,
      statusCodes: [504],
      keywords: ['gateway_timeout'],
      action: 'wait_retry',
    },
    {
      id: 'rule-disabled',
      enabled: false,
      statusCodes: [422],
      keywords: ['semantic_error'],
      action: 'wait_retry',
    },
  ];

  // 1. 无效输入或终态鉴权/额度错误返回 null
  assert.equal(matchAutoContinueRule(null, rules), null);
  assert.equal(matchAutoContinueRule({ status: 401, message: 'unauthorized' }, rules), null);
  assert.equal(matchAutoContinueRule({ status: 403, message: 'forbidden' }, rules), null);
  assert.equal(matchAutoContinueRule({ status: 429, code: 'QUOTA', message: 'insufficient quota' }, rules), null);

  // 2. 状态码直接匹配
  assert.equal(matchAutoContinueRule({ status: 503 }, rules)?.id, 'rule-503');
  assert.equal(matchAutoContinueRule({ status: 413 }, rules)?.id, 'rule-413');
  assert.equal(matchAutoContinueRule({ status: 504 }, rules)?.id, 'rule-custom');

  // 3. 关键词大小写不敏感匹配（message 与 code）
  assert.equal(matchAutoContinueRule({ message: 'AUTH_UNAVAILABLE: no auth' }, rules)?.id, 'rule-503');
  assert.equal(matchAutoContinueRule({ code: 'GATEWAY_TIMEOUT' }, rules)?.id, 'rule-custom');

  // 4. 禁用规则被跳过
  assert.equal(matchAutoContinueRule({ status: 422 }, rules), null);
  assert.equal(matchAutoContinueRule({ message: 'semantic_error' }, rules), null);

  // 5. 兜底兼容：rule-413 兼容 isPayloadTooLargeOrOverflowFailure
  assert.equal(matchAutoContinueRule({ message: 'Responses request exceeds 32 MiB' }, rules)?.id, 'rule-413');
  assert.equal(matchAutoContinueRule({ code: 'CONTEXT_OVERFLOW' }, rules)?.id, 'rule-413');

  // 6. 兜底兼容：rule-503 兼容 isTransientRecoverableFailure
  assert.equal(matchAutoContinueRule({ status: 500, message: 'internal_server_error' }, rules)?.id, 'rule-503');
  assert.equal(matchAutoContinueRule({ status: 400, message: 'Requests ending with a model turn are not supported.' }, rules)?.id, 'rule-503');
});

test('自定义规则支持 compact_retry 延迟、followup_prompt 与独立重试计数', async (t) => {
  const agent = createAgent('main');
  const sleeps = [];
  const compactions = [];
  const host = createHost({
    autoContinue: {
      enabled: true,
      rules: [
        {
          id: 'rule-compact-delay',
          enabled: true,
          statusCodes: [413],
          keywords: ['custom_overflow'],
          action: 'compact_retry',
          delaySec: 5,
          maxRetries: 2,
        },
        {
          id: 'rule-followup',
          enabled: true,
          statusCodes: [429],
          keywords: ['rate_limit_followup'],
          action: 'followup_prompt',
          delaySec: 3,
          maxRetries: 1,
        },
      ],
    },
    presetCompaction: {
      async compactIfNeeded(receivedAgent, trigger) {
        compactions.push({ id: receivedAgent.id, trigger });
      },
    },
    options: {
      sleep: async (ms) => {
        sleeps.push(ms);
        return true;
      },
    },
  });
  t.after(host.dispose);

  // 1. compact_retry 带延迟：执行压缩并等待 5 秒后重试
  const outCompact1 = await host.requestError({
    agent,
    failure: { status: 413, message: 'custom_overflow' },
    signal: new AbortController().signal,
  });
  assert.deepEqual(outCompact1.result, { kind: 'retry' });
  assert.equal(compactions.length, 1);
  assert.deepEqual(sleeps, [5000]);

  // 第 2 次 compact_retry：仍可重试
  const outCompact2 = await host.requestError({
    agent,
    failure: { status: 413, message: 'custom_overflow' },
    signal: new AbortController().signal,
  });
  assert.deepEqual(outCompact2.result, { kind: 'retry' });
  assert.equal(compactions.length, 2);

  // 第 3 次 compact_retry：达到 maxRetries=2，透传 next()
  const outCompact3 = await host.requestError({
    agent,
    failure: { status: 413, message: 'custom_overflow' },
    signal: new AbortController().signal,
  });
  assert.equal(outCompact3.delegated, 1);

  // 2. 另一条规则 rule-followup 有独立的重试配额，仍可触发重试
  const outFollowup = await host.requestError({
    agent,
    failure: { status: 429, message: 'rate_limit_followup' },
    signal: new AbortController().signal,
  });
  assert.deepEqual(outFollowup.result, { kind: 'retry' });
  assert.deepEqual(sleeps, [5000, 5000, 3000]);

  // rule-followup 达到 maxRetries=1 后停止
  const outFollowup2 = await host.requestError({
    agent,
    failure: { status: 429, message: 'rate_limit_followup' },
    signal: new AbortController().signal,
  });
  assert.equal(outFollowup2.delegated, 1);
});

test('isTimeoutFailure 正确识别 TIMEOUT / 流空闲超时 / 408 / 504 / upstream_stream_interrupted，不误判 503 断连与 413', () => {
  assert.equal(isTimeoutFailure({ code: 'TIMEOUT' }), true);
  assert.equal(isTimeoutFailure({ code: 'TIMEOUT', message: 'pi-ai stream idle timeout after 300000ms' }), true);
  assert.equal(isTimeoutFailure({ message: 'pi-ai stream idle timeout after 300000ms' }), true);
  assert.equal(isTimeoutFailure({ status: 408, message: 'Request Timeout' }), true);
  assert.equal(isTimeoutFailure({ status: 504, message: 'Gateway Timeout' }), true);
  assert.equal(isTimeoutFailure({ message: 'upstream_stream_interrupted' }), true);
  assert.equal(isTimeoutFailure({ message: 'connect ETIMEDOUT' }), true);
  assert.equal(isTimeoutFailure({ message: 'stream_timeout' }), true);

  // 非超时 503 远端断连、413 超大包、鉴权/额度终态均返回 false
  assert.equal(
    isTimeoutFailure({
      status: 503,
      code: 'SERVER',
      message: 'auth_unavailable: no auth available (last upstream error: Remote end closed connection without response)',
    }),
    false,
  );
  assert.equal(isTimeoutFailure({ status: 413, message: 'Payload Too Large' }), false);
  assert.equal(isTimeoutFailure({ status: 401, code: 'TIMEOUT', message: 'stream idle timeout' }), false);
  assert.equal(isTimeoutFailure({ status: 429, code: 'QUOTA', message: 'insufficient quota timed out' }), false);
  assert.equal(isTimeoutFailure(null), false);
});

test('TIMEOUT 流空闲超时连续失败 2 次及以上时仅延迟重试，绝不触发强制压缩，且不污染 compactedOnce 状态', async (t) => {
  const agent = createAgent('main');
  const sleeps = [];
  const compactions = [];
  const host = createHost({
    autoContinue: { enabled: true, retryDelaySec: 60, maxRetries: 4, compactOnDisconnect: true },
    presetCompaction: {
      async compactIfNeeded(receivedAgent, trigger) {
        compactions.push({ id: receivedAgent.id, trigger });
      },
    },
    options: {
      sleep: async (ms, sig) => {
        sleeps.push(ms);
        return !sig?.aborted;
      },
    },
  });
  t.after(host.dispose);

  const errTimeout = {
    code: 'TIMEOUT',
    message: 'pi-ai stream idle timeout after 300000ms',
  };

  // 第 1 次、第 2 次、第 3 次连续流超时：均正常延迟重试，但绝不调用 compactIfNeeded
  for (let i = 1; i <= 3; i++) {
    const out = await host.requestError({ agent, failure: errTimeout, signal: new AbortController().signal });
    assert.deepEqual(out.result, { kind: 'retry' });
    assert.equal(out.delegated, 0);
    assert.equal(compactions.length, 0, `第 ${i} 次超时不应触发强制上下文压缩`);
    assert.equal(sleeps.length, i);
  }

  // 若随后第 4 次遇到真实 503 远端断连，因 compactedOnce 未被超时污染，仍能正常触发一次隔离压缩
  const err503 = {
    status: 503,
    code: 'SERVER',
    message: 'Remote end closed connection without response',
  };
  const fourth = await host.requestError({ agent, failure: err503, signal: new AbortController().signal });
  assert.deepEqual(fourth.result, { kind: 'retry' });
  assert.equal(compactions.length, 1);
  assert.deepEqual(compactions[0], { id: 'main', trigger: 'context-overflow' });
});



