import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionPreloadCache, SESSION_PRELOAD_FRESH_WINDOW_MS, SESSION_PRELOAD_LIMIT } from '../lib/session-preload.js';

function makeHarness({ now = 2_000_000_000_000, sessions = {}, formatStatus = 'current', statFormatStatus = 'current', visible = true, archivedSessionIds = [], deferList = false, waitForObserve = false, observationMode = 'lease', throwOnObserve = false } = {}) {
  const timers = new Set();
  const state = { now, observeCalls: 0, disposeCalls: 0, asyncDisposeCalls: 0, releaseObserve: null, releaseList: null };
  const records = new Map();
  const revisions = new Map();
  for (const [sessionId, value] of Object.entries(sessions)) {
    const eventTime = Number(value.eventTime ?? now - 1_000);
    records.set(sessionId, {
      header: { id: sessionId, workspaceId: 'ws-visible', createdAt: now - 10 * SESSION_PRELOAD_FRESH_WINDOW_MS },
      ...(value.record || {}),
      formatStatus: value.formatStatus ?? formatStatus,
      projections: value.projections || {},
    });
    revisions.set(sessionId, value.revision ?? 'revision-1');
    records.get(sessionId).__eventTime = eventTime;
  }

  const observe = async (sessionId) => {
    state.observeCalls += 1;
    if (waitForObserve) {
      await new Promise((resolve) => { state.releaseObserve = resolve; });
    }
    if (throwOnObserve) throw new Error('corrupt fixture');
    const eventTime = records.get(sessionId)?.__eventTime ?? (state.now - 1_000);
    const observation = { events: [{ type: 'user/message', time: eventTime }], cursor: 7, revision: revisions.get(sessionId) };
    if (observationMode === 'lease' && typeof Symbol.dispose === 'symbol') {
      observation[Symbol.dispose] = () => { state.disposeCalls += 1; };
    } else if (observationMode === 'async-lease' && typeof Symbol.asyncDispose === 'symbol') {
      observation[Symbol.asyncDispose] = async () => { state.asyncDisposeCalls += 1; };
    }
    return observation;
  };

  const query = {
    listSessions: async () => {
      if (deferList) await new Promise((resolve) => { state.releaseList = resolve; });
      return [...records.values()];
    },
    observeSession: observe,
  };
  const persistence = {
    stat: async (sessionId) => ({
      header: { id: sessionId },
      revision: revisions.get(sessionId),
      formatStatus: statFormatStatus,
    }),
  };
  const registry = {
    archivedSessionIds,
    list: () => visible ? [{ workspaceId: 'ws-visible', sessionIds: [...records.keys()] }] : [],
  };
  const ctx = {
    get(name) {
      return { sessionQuery: query, sessionPersistence: persistence, workspaceRegistry: registry }[name] || null;
    },
  };
  const cache = createSessionPreloadCache({
    ctx,
    now: () => state.now,
    setTimer(fn, delay) {
      const timer = { fn, delay };
      timers.add(timer);
      return timer;
    },
    clearTimer(timer) {
      timers.delete(timer);
    },
  });
  return {
    cache,
    state,
    records,
    revisions,
    timers,
    advance(ms) { state.now += ms; },
    runTimers() {
      for (const timer of [...timers]) {
        timers.delete(timer);
        timer.fn();
      }
    },
  };
}

function request(sessionId, updatedAt, clientId = 'client-a', requestId = `req-${sessionId}-${clientId}`) {
  return { clientId, requestId, sessionId, updatedAt };
}

test('same revision shares one native observation and releases only the owning client lease', async () => {
  const fixture = makeHarness({ sessions: { 's-1': {} } });
  const at = fixture.state.now;
  const first = fixture.cache.preload(request('s-1', at - 1_000, 'client-a', 'req-a'));
  const second = fixture.cache.preload(request('s-1', at - 1_000, 'client-b', 'req-a'));
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.result, 'ready');
  assert.equal(right.result, 'ready');
  assert.equal(left.cursor, 7);
  assert.equal(fixture.state.observeCalls, 1);

  fixture.cache.release({ clientId: 'client-a', sessionIds: ['s-1'] });
  assert.equal(fixture.state.disposeCalls, 0);
  fixture.cache.release({ clientId: 'client-b', sessionIds: ['s-1'] });
  assert.equal(fixture.state.disposeCalls, 1);
  fixture.advance(SESSION_PRELOAD_FRESH_WINDOW_MS);
  fixture.runTimers();
  assert.equal(fixture.state.disposeCalls, 1);

  fixture.cache.dispose();
  assert.equal(fixture.state.disposeCalls, 1);
});

test('exactly 48 hours remains fresh and expires only after the inclusive boundary', async () => {
  const at = 2_000_000_000_000;
  const fixture = makeHarness({ now: at, sessions: { 's-boundary': { eventTime: at - SESSION_PRELOAD_FRESH_WINDOW_MS } } });
  const result = await fixture.cache.preload(request('s-boundary', at - SESSION_PRELOAD_FRESH_WINDOW_MS, 'client-a', 'req-boundary'));
  assert.equal(result.result, 'ready');
  assert.equal(fixture.state.disposeCalls, 0);
  fixture.runTimers();
  assert.equal(fixture.state.disposeCalls, 0);
  fixture.advance(1);
  fixture.runTimers();
  assert.equal(fixture.state.disposeCalls, 1);
  fixture.cache.dispose();
});

test('persistence revision change refreshes a lease, while unchanged revision reuses it', async () => {
  const fixture = makeHarness({ sessions: { 's-1': {} } });
  const at = fixture.state.now;
  assert.equal((await fixture.cache.preload(request('s-1', at - 1_000, 'client-a', 'req-1'))).result, 'ready');
  assert.equal((await fixture.cache.preload(request('s-1', at - 1_000, 'client-a', 'req-2'))).result, 'ready');
  assert.equal(fixture.state.observeCalls, 1);
  fixture.cache.release({ clientId: 'client-a', sessionIds: ['s-1'] });
  assert.equal(fixture.state.disposeCalls, 1);

  assert.equal((await fixture.cache.preload(request('s-1', at - 1_000, 'client-a', 'req-3'))).result, 'ready');
  assert.equal(fixture.state.observeCalls, 2);
  assert.equal(fixture.state.disposeCalls, 1);

  fixture.revisions.set('s-1', 'revision-2');
  assert.equal((await fixture.cache.preload(request('s-1', at - 1_000, 'client-a', 'req-4'))).result, 'ready');
  assert.equal(fixture.state.observeCalls, 3);
  assert.equal(fixture.state.disposeCalls, 2);
  fixture.cache.dispose();
  assert.equal(fixture.state.disposeCalls, 3);
});

test('client freshness is only a gate; old actual messages are skipped and createdAt never qualifies a session', async () => {
  const at = 2_000_000_000_000;
  const stale = makeHarness({ now: at, sessions: { 's-old': { eventTime: at - SESSION_PRELOAD_FRESH_WINDOW_MS - 1 } } });
  assert.equal((await stale.cache.preload(request('s-old', at - 1_000, 'client-a', 'req-old'))).result, 'skipped');
  assert.equal(stale.state.observeCalls, 1);
  assert.equal(stale.state.disposeCalls, 1);
  stale.cache.dispose();

  const current = makeHarness({ now: at, sessions: { 's-current': { eventTime: at - 5_000 } } });
  const result = await current.cache.preload(request('s-current', at - 1_000, 'client-a', 'req-current'));
  assert.equal(result.result, 'ready');
  assert.equal(result.updatedAt, at - 1_000);
  current.cache.dispose();
  assert.equal(current.state.disposeCalls, 1);
});

test('migration, corrupt, and legacy observations fail closed without retaining a lease', async () => {
  const cases = [
    { name: 'migration status', options: { sessions: { 's-migration': {} }, statFormatStatus: 'migration-required' }, expected: 'skipped', calls: 0 },
    { name: 'hidden workspace', options: { sessions: { 's-hidden': {} }, visible: false }, expected: 'skipped', calls: 0 },
    { name: 'archived workspace session', options: { sessions: { 's-archived': {} }, archivedSessionIds: ['s-archived'] }, expected: 'skipped', calls: 0 },
    { name: 'corrupt read', options: { sessions: { 's-corrupt': {} }, throwOnObserve: true }, expected: 'failed', calls: 1 },
    { name: 'legacy lease', options: { sessions: { 's-legacy': {} }, observationMode: 'none' }, expected: 'unsupported', calls: 1 },
  ];
  for (const item of cases) {
    const fixture = makeHarness(item.options);
    const sessionId = Object.keys(item.options.sessions)[0];
    const result = await fixture.cache.preload(request(sessionId, fixture.state.now - 1_000, 'client-a', `req-${item.name.replace(/[^A-Za-z0-9._:-]/gu, '-')}`));
    assert.equal(result.result, item.expected, item.name);
    assert.equal(fixture.state.observeCalls, item.calls, item.name);
    assert.equal(fixture.state.disposeCalls, 0, item.name);
    fixture.cache.dispose();
  }
});

test('full cache rejects an older warm and admits a newer warm without LRU churn', async () => {
  const sessions = {};
  for (let index = 0; index < SESSION_PRELOAD_LIMIT; index += 1) sessions[`s-${index}`] = { eventTime: 2_000_000_000_000 - index * 1_000 };
  sessions['s-old'] = { eventTime: 2_000_000_000_000 - (SESSION_PRELOAD_LIMIT + 1) * 1_000 };
  sessions['s-new'] = { eventTime: 2_000_000_000_000 - 1 };
  const fixture = makeHarness({ now: 2_000_000_000_000, sessions });
  for (let index = 0; index < SESSION_PRELOAD_LIMIT; index += 1) {
    const id = `s-${index}`;
    assert.equal((await fixture.cache.preload(request(id, fixture.state.now - index * 1_000, 'client-a', `req-${id}`))).result, 'ready');
  }
  const readsBefore = fixture.state.observeCalls;
  assert.equal((await fixture.cache.preload(request('s-old', fixture.state.now - (SESSION_PRELOAD_LIMIT + 1) * 1_000, 'client-a', 'req-old'))).result, 'skipped');
  assert.equal(fixture.state.observeCalls, readsBefore);
  assert.equal((await fixture.cache.preload(request('s-new', fixture.state.now - 1, 'client-a', 'req-new'))).result, 'ready');
  assert.equal(fixture.state.observeCalls, readsBefore + 1);
  fixture.cache.dispose();
  assert.equal(fixture.state.disposeCalls, SESSION_PRELOAD_LIMIT + 1);
});

test('newer warm may replace the oldest owned entry while the global cache stays bounded', async () => {
  const sessions = {};
  for (let index = 0; index < SESSION_PRELOAD_LIMIT; index += 1) sessions[`owned-${index}`] = { eventTime: 2_000_000_000_000 - index * 1_000 };
  sessions['owned-new'] = { eventTime: 2_000_000_000_000 - 1 };
  const fixture = makeHarness({ now: 2_000_000_000_000, sessions });
  for (let index = 0; index < SESSION_PRELOAD_LIMIT; index += 1) {
    const id = `owned-${index}`;
    assert.equal((await fixture.cache.preload(request(id, fixture.state.now - index * 1_000, 'client-a', `req-${id}`))).result, 'ready');
  }
  assert.equal((await fixture.cache.preload(request('owned-new', fixture.state.now - 1, 'client-b', 'req-owned-new'))).result, 'ready');
  assert.equal(fixture.state.observeCalls, SESSION_PRELOAD_LIMIT + 1);
  assert.equal(fixture.state.disposeCalls, 1);
  fixture.cache.dispose();
  assert.equal(fixture.state.disposeCalls, SESSION_PRELOAD_LIMIT + 1);
});

test('owned request IDs are scoped to their session and preflight cancellation prevents observation', async () => {
  const fixture = makeHarness({ sessions: { 's-one': {}, 's-two': {} } });
  const at = fixture.state.now;
  assert.equal((await fixture.cache.preload(request('s-one', at - 1_000, 'client-a', 'req-same'))).result, 'ready');
  assert.equal((await fixture.cache.preload(request('s-two', at - 1_000, 'client-a', 'req-same'))).result, 'ready');
  assert.equal(fixture.state.observeCalls, 2);
  fixture.cache.dispose();

  const cancelled = makeHarness({ sessions: { 's-preflight': {} }, deferList: true });
  const pending = cancelled.cache.preload(request('s-preflight', cancelled.state.now - 1_000, 'client-a', 'req-preflight'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof cancelled.state.releaseList, 'function');
  cancelled.cache.cancel({ clientId: 'client-a', requestId: 'req-preflight' });
  cancelled.state.releaseList();
  assert.equal((await pending).result, 'skipped');
  assert.equal(cancelled.state.observeCalls, 0);
  cancelled.cache.dispose();
});

test('cancel aborts a pending preload and disposes an observation that completes late', async () => {
  const fixture = makeHarness({ sessions: { 's-late': {} }, waitForObserve: true });
  const pending = fixture.cache.preload(request('s-late', fixture.state.now - 1_000, 'client-a', 'req-late'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.state.observeCalls, 1);
  fixture.cache.cancel({ clientId: 'client-a', requestId: 'req-late' });
  fixture.state.releaseObserve();
  const result = await pending;
  assert.equal(result.result, 'skipped');
  assert.equal(fixture.state.disposeCalls, 1);
  fixture.cache.dispose();
});
