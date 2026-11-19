import assert from 'node:assert/strict';
import test from 'node:test';
import { installOversizedRequestRecovery } from '../lib/oversized-request-recovery.js';

const OVERSIZED_MESSAGE = 'Responses request exceeds 32 MiB';

function createAgent(id = 'agent-1') {
  return {
    id,
    status: 'running',
    session: { id: `session-${id}`, surface: { replaceGeneration: 0 } },
  };
}

function createHost({ presetService, fallbackService, hasPresetRegistry = true } = {}) {
  const listeners = new Map();
  const ctx = {
    get(name) {
      if (name === 'agentPresets' && hasPresetRegistry) {
        return { serviceFor: () => presetService };
      }
      if (name === 'compaction') return fallbackService;
      return undefined;
    },
    on(name, listener) {
      const group = listeners.get(name) || [];
      group.push(listener);
      listeners.set(name, group);
      return () => listeners.set(name, (listeners.get(name) || []).filter((item) => item !== listener));
    },
  };
  const dispose = installOversizedRequestRecovery(ctx);
  return {
    dispose,
    emit(name, ...args) {
      for (const listener of listeners.get(name) || []) listener(...args);
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

function requestPayload(agent, failure, signal = new AbortController().signal) {
  return { agent, failure, signal };
}

test('exact Responses 32 MiB failure uses the live preset compaction service and retries after durable progress', async (t) => {
  const agent = createAgent();
  agent.session.surface.replaceGeneration = 4;
  const observed = [];
  const presetService = {
    async compactIfNeeded(receivedAgent, trigger, signal) {
      observed.push({ receivedAgent, trigger, signal });
      receivedAgent.session.surface.replaceGeneration += 1;
    },
  };
  const host = createHost({
    presetService,
    fallbackService: { compactIfNeeded() { throw new Error('global fallback must not run'); } },
  });
  t.after(host.dispose);
  const signal = new AbortController().signal;

  const outcome = await host.requestError(requestPayload(agent, {
    message: `${OVERSIZED_MESSAGE}: upstream rejected request`,
    status: 413,
  }, signal));

  assert.deepEqual(outcome.result, { kind: 'retry' });
  assert.equal(outcome.delegated, 0);
  assert.equal(agent.session.surface.replaceGeneration, 5);
  assert.deepEqual(observed, [{ receivedAgent: agent, trigger: 'context-overflow', signal }]);
});

test('hosts without a preset registry use the global compaction fallback', async (t) => {
  const agent = createAgent();
  const host = createHost({
    hasPresetRegistry: false,
    fallbackService: {
      async compactIfNeeded(receivedAgent) {
        receivedAgent.session.surface.replaceGeneration += 1;
      },
    },
  });
  t.after(host.dispose);

  const outcome = await host.requestError(requestPayload(agent, {
    message: OVERSIZED_MESSAGE,
    status: 413,
  }));

  assert.deepEqual(outcome.result, { kind: 'retry' });
  assert.equal(outcome.delegated, 0);
});

test('unrelated invalid requests, missing isolated services, and compaction without progress preserve the original error', async (t) => {
  const cases = [
    {
      name: 'ordinary INVALID_REQUEST',
      failure: { message: 'tool schema is invalid', code: 'INVALID_REQUEST' },
      presetService: { compactIfNeeded() { throw new Error('must not compact unrelated requests'); } },
    },
    {
      name: 'preset registry has no compaction service',
      failure: { message: OVERSIZED_MESSAGE, code: 'INVALID_REQUEST' },
      presetService: undefined,
      fallbackService: { compactIfNeeded() { throw new Error('must not escape the live preset isolate'); } },
    },
    {
      name: 'compaction commits no replacement',
      failure: { message: `${OVERSIZED_MESSAGE}: API 413` },
      presetService: { async compactIfNeeded() {} },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const host = createHost(scenario);
      t.after(host.dispose);
      const outcome = await host.requestError(requestPayload(createAgent(scenario.name), scenario.failure));
      assert.equal(outcome.result, outcome.delegatedResult);
      assert.equal(outcome.delegated, 1);
    });
  }
});

test('one agent retries once per failure chain and rearms after assistant commit or idle', async (t) => {
  const agent = createAgent();
  let compactions = 0;
  const host = createHost({
    presetService: {
      async compactIfNeeded(receivedAgent) {
        compactions += 1;
        receivedAgent.session.surface.replaceGeneration += 1;
      },
    },
  });
  t.after(host.dispose);
  const failure = { message: OVERSIZED_MESSAGE, code: 'INVALID_REQUEST' };

  assert.deepEqual((await host.requestError(requestPayload(agent, failure))).result, { kind: 'retry' });
  assert.equal((await host.requestError(requestPayload(agent, failure))).delegated, 1);
  assert.equal(compactions, 1);

  host.emit('session/event', agent.session, { type: 'assistant/message', data: {} });
  assert.deepEqual((await host.requestError(requestPayload(agent, failure))).result, { kind: 'retry' });
  assert.equal((await host.requestError(requestPayload(agent, failure))).delegated, 1);
  assert.equal(compactions, 2);

  host.emit('agent/status', { agent, status: 'idle' });
  assert.deepEqual((await host.requestError(requestPayload(agent, failure))).result, { kind: 'retry' });
  assert.equal(compactions, 3);
});

test('concurrent duplicate 413 delegates while the first compaction is still in flight', async (t) => {
  const agent = createAgent();
  let releaseCompaction;
  let markStarted;
  const compactionStarted = new Promise((resolve) => { markStarted = resolve; });
  const compactionGate = new Promise((resolve) => { releaseCompaction = resolve; });
  let compactions = 0;
  const host = createHost({
    presetService: {
      async compactIfNeeded(receivedAgent) {
        compactions += 1;
        markStarted();
        await compactionGate;
        receivedAgent.session.surface.replaceGeneration += 1;
      },
    },
  });
  t.after(host.dispose);
  const failure = { message: OVERSIZED_MESSAGE, code: 'INVALID_REQUEST' };

  const first = host.requestError(requestPayload(agent, failure));
  await compactionStarted;
  const duplicate = await host.requestError(requestPayload(agent, failure));
  assert.equal(duplicate.result, duplicate.delegatedResult);
  assert.equal(duplicate.delegated, 1);
  assert.equal(compactions, 1);

  releaseCompaction();
  assert.deepEqual((await first).result, { kind: 'retry' });
  assert.equal(compactions, 1);
});

test('compaction error still retries when its durable replacement generation advanced', async (t) => {
  const agent = createAgent();
  const host = createHost({
    presetService: {
      async compactIfNeeded(receivedAgent) {
        receivedAgent.session.surface.replaceGeneration += 1;
        throw new Error('post-commit failure');
      },
    },
  });
  t.after(host.dispose);

  const outcome = await host.requestError(requestPayload(agent, {
    message: `${OVERSIZED_MESSAGE}: HTTP 413`,
  }));

  assert.deepEqual(outcome.result, { kind: 'retry' });
  assert.equal(outcome.delegated, 0);
});

test('aborted recovery delegates even when compaction advanced generation', async (t) => {
  const agent = createAgent();
  const controller = new AbortController();
  const host = createHost({
    presetService: {
      async compactIfNeeded(receivedAgent) {
        receivedAgent.session.surface.replaceGeneration += 1;
        controller.abort();
      },
    },
  });
  t.after(host.dispose);

  const outcome = await host.requestError(requestPayload(agent, {
    message: OVERSIZED_MESSAGE,
    status: 413,
  }, controller.signal));

  assert.equal(outcome.result, outcome.delegatedResult);
  assert.equal(outcome.delegated, 1);
});
