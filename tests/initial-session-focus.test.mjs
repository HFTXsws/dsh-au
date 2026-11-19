import './isolate-sync.mjs';
import './isolate-net-log.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { createInitialSessionFocusResolver, selectInitialSessionFocus } from '../lib/initial-session-focus.js';
import { createStatusTracker } from '../lib/status-tracker.js';
import { createRemoteProxyPool } from '../lib/remote-proxy-pool.js';

// All filesystem/config/log boundaries are private to this test worker; no production loadConfig.
const temp = mkdtempSync(join(tmpdir(), 'dsh-au-initial-focus-'));
process.env.DSH_HOME = join(temp, 'home');
process.env.DSH_AU_CONFIG_PATH = join(temp, 'config.json');
process.env.DSH_AU_LOCAL_DIR = join(temp, 'sync/local');
process.env.DSH_AU_NET_LOG = join(temp, 'net.jsonl');
after(() => {
  const target = resolve(temp);
  assert.equal(dirname(target), resolve(tmpdir()));
  assert.ok(basename(target).startsWith('dsh-au-initial-focus-'));
  rmSync(target, { recursive: true, force: true });
});

const keep = { ok: true, sessionId: '', reason: 'keep-current' };
const failed = { ok: false, errorCode: 'FOCUS_QUERY_FAILED' };
const candidate = (sessionId, status, updatedAt = 0, extra = {}) => ({ sessionId, status, updatedAt, ...extra });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

for (const [scenario, candidates, expected] of [
  ['running beats newer waiting and completed conversations', [candidate('done', 'done', 300), candidate('waiting', 'waiting', 200), candidate('busy', 'busy', 100)], { ok: true, sessionId: 'busy', reason: 'busy' }],
  ['waiting beats a newer pending completion', [candidate('done', 'done', 300), candidate('waiting', 'waiting', 200)], { ok: true, sessionId: 'waiting', reason: 'waiting' }],
  ['done and error share priority and use latest activity', [candidate('done', 'done', 100), candidate('error', 'error', 200)], { ok: true, sessionId: 'error', reason: 'error' }],
  ['stable IDs break equal timestamps', [candidate('b', 'busy', 200), candidate('a', 'busy', 200)], { ok: true, sessionId: 'a', reason: 'busy' }],
  ['native activity metadata participates in same-priority ordering', [candidate('a', 'busy', 100), candidate('b', 'busy', 50, { projections: { values: { sessionListMetadata: { lastPromptAt: 200 } } } })], { ok: true, sessionId: 'b', reason: 'busy' }],
  ['unknown and idle states keep the current conversation', [candidate('idle', 'idle'), candidate('unknown', 'unknown'), candidate('prototype', 'constructor')], keep],
  ['explicit child and archived markers cannot outrank a root conversation', [candidate('child', 'busy', 500, { origin: 'subagent' }), candidate('depth', 'busy', 500, { delegationDepth: 0, header: { delegationDepth: 1 } }), candidate('archived', 'busy', 500, { archived: true }), candidate('root', 'done', 100)], { ok: true, sessionId: 'root', reason: 'done' }],
]) {
  test(scenario, () => {
    const before = structuredClone(candidates);
    assert.deepEqual(selectInitialSessionFocus(candidates), expected);
    assert.deepEqual(candidates, before, 'selection never mutates session records');
  });
}

function eventStream(types, time) {
  return types.map(([type, data], seq) => ({ type, data, seq, time: time + seq }));
}

// 2026-10-28: a running root older than the first 50 lower-priority records must still be selected.
for (const neighborStatus of ['idle', 'done']) {
  test(`an older running conversation beyond the first fifty ${neighborStatus} roots reads only the highest-priority history`, async (t) => {
    const records = Array.from({ length: 51 }, (_, index) => ({ header: { id: `neighbor-${index}`, createdAt: 2000 + index } }));
    records.push({ header: { id: 'older-running', createdAt: 1000 } });
    const tracker = createStatusTracker(() => ({ list: () => [{ id: 'older-running', status: 'running' }] }));
    t.after(() => tracker.dispose());
    if (neighborStatus === 'done') {
      for (const record of records.slice(0, 51)) tracker.ingest(record.header.id, eventStream([
        ['turn/start', { turn: 1 }], ['turn/end', { reason: { kind: 'completed' } }],
      ], record.header.createdAt));
    }
    const observed = [];
    const ctx = { get(name) {
      if (name === 'sessionQuery') return {
        listSessions: async () => records,
        observeSession: async (id) => { observed.push(id); return { events: [{ type: 'assistant/message', seq: 0, time: 4000, data: { text: 'private-body' } }] }; },
      };
      if (name === 'workspaceRegistry') return { archivedSessionIds: [], list: () => [] };
      throw new Error('unexpected host service');
    } };
    const focus = createInitialSessionFocusResolver({ ctx, statusTracker: tracker });
    assert.deepEqual(await focus({ deviceId: 'local' }), { ok: true, sessionId: 'older-running', reason: 'busy' });
    assert.deepEqual(observed, ['older-running'], 'only the highest-priority candidate should read its event history');
  });
}

for (const mode of ['events', 'failure', 'empty']) {
  test(`same-priority local focus uses real event time and metadata fallback without inventing now (${mode})`, async (t) => {
    const records = [{ header: { id: 'a', createdAt: 10 } }, { header: { id: 'b', createdAt: 20 } }];
    const tracker = createStatusTracker(() => ({ list: () => records.map((record) => ({ id: record.header.id, status: 'running' })) }));
    t.after(() => tracker.dispose());
    const ctx = { get(name) {
      if (name === 'sessionQuery') return {
        listSessions: async () => records,
        observeSession: async (id) => {
          if (id === 'b' && mode === 'failure') throw new Error('private-event-query-error');
          return { events: id === 'b' && mode === 'empty' ? [] : [{ type: 'assistant/message', seq: 0, time: id === 'a' ? 300 : 200, data: { text: 'private-body' } }] };
        },
      };
      if (name === 'workspaceRegistry') return { archivedSessionIds: [], list: () => [] };
      throw new Error('unexpected host service');
    } };
    const focus = createInitialSessionFocusResolver({ ctx, statusTracker: tracker });
    assert.deepEqual(await focus({ deviceId: 'local' }), { ok: true, sessionId: 'a', reason: 'busy' });
  });
}

test('local selection follows real state transitions without confirming conversations or selecting delegated/archived roots', async (t) => {
  const now = Date.now();
  const ids = ['running', 'waiting', 'done', 'delegated', 'archived', 'flag-archived'];
  const agents = ids.map((id) => ({ id, status: id === 'done' ? 'idle' : 'running' }));
  // The official agents service is a boundary; the tracker and state reducer are real.
  const tracker = createStatusTracker(() => ({ list: () => agents }));
  t.after(() => tracker.dispose());
  const records = ids.map((id) => ({ header: { id, createdAt: now - 10000,
    delegationDepth: id === 'delegated' ? 1 : 0, archived: id === 'flag-archived', cwd: 'private-cwd' } }));
  const observations = {
    waiting: eventStream([['turn/start', { turn: 1 }], ['approval/asked', { id: 'approval-1' }]], now - 200),
    done: eventStream([['turn/start', { turn: 1 }], ['turn/end', { reason: { kind: 'completed' } }]], now - 100),
  };
  for (const [id, events] of Object.entries(observations)) tracker.ingest(id, events);
  // Only official sessionQuery/workspace SDK methods are substituted, never local helpers.
  const ctx = { get(name) {
    if (name === 'sessionQuery') return {
      listSessions: async () => records,
      readTitleSnapshots: async (sessionIds) => sessionIds.map(() => ({ title: 'private-title' })),
      observeSession: async (id) => ({ events: observations[id] || [], [Symbol.asyncDispose]: async () => {} }),
    };
    if (name === 'workspaceRegistry') return { archivedSessionIds: ['archived'], list: () => [] };
    throw new Error(`Unexpected host service ${name}`);
  } };
  const focus = createInitialSessionFocusResolver({ ctx, statusTracker: tracker,
    getConfig() { throw new Error('Local selection must not read remote credentials'); } });
  const assertReadonly = async (expected) => {
    const before = tracker.getSnapshot().sessionsV2;
    assert.deepEqual(await focus({ deviceId: 'local' }), expected);
    assert.deepEqual(tracker.getSnapshot().sessionsV2, before, 'selection cannot acknowledge blue/red results');
  };
  await assertReadonly({ ok: true, sessionId: 'running', reason: 'busy' });
  observations.running = eventStream([['turn/start', { turn: 1 }], ['turn/end', { reason: { kind: 'completed' } }]], now + 100);
  tracker.ingest('running', observations.running);
  agents.find((agent) => agent.id === 'running').status = 'idle';
  await assertReadonly({ ok: true, sessionId: 'waiting', reason: 'waiting' });
  observations.waiting.push({ type: 'turn/end', seq: 2, time: now + 200, data: { reason: { kind: 'completed' } } });
  tracker.ingest('waiting', observations.waiting);
  agents.find((agent) => agent.id === 'waiting').status = 'idle';
  await assertReadonly({ ok: true, sessionId: 'waiting', reason: 'done' });
  // User acknowledgement is simulated by the real model, not performed by the selector.
  for (const id of ['running', 'waiting', 'done']) tracker.confirm(id);
  await assertReadonly(keep);
});

test('official local query failures return a content-free error and preserve the state model', async (t) => {
  const tracker = createStatusTracker(() => ({ list: () => [] }));
  t.after(() => tracker.dispose());
  const ctx = { get(name) {
    if (name === 'sessionQuery') return { listSessions: async () => { throw new Error('https://private-host/?password=private-secret'); } };
    if (name === 'workspaceRegistry') return { archivedSessionIds: [], list: () => [] };
    throw new Error('unexpected service');
  } };
  const focus = createInitialSessionFocusResolver({ ctx, statusTracker: tracker });
  assert.deepEqual(await focus({ deviceId: 'local' }), failed);
  assert.deepEqual(tracker.getSnapshot().sessionsV2, {});
});

async function nativeServer(t, options = {}) {
  const posted = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('connection', 'close');
    if (req.method === 'GET') {
      res.end(req.url === '/dsh-au/api' ? JSON.stringify({ self: { status: 'idle', sessionStatesV2: options.lights || {} } }) : 'home');
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    posted.push({ path: req.url, method: body.method });
    if (options.onRequest) await options.onRequest();
    const result = options.response ?? { type: 'server-response', rpcId: body.rpcId,
      result: { ok: true, value: { items: options.items || [] } } };
    res.end(JSON.stringify(result));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  return { url: `http://127.0.0.1:${server.address().port}/`, posted };
}
function configuredRemote(id, deviceId, url) {
  return { id, deviceId, url, transport: 'tunnel', username: 'private-user', password: 'private-password' };
}

test('remote native running overrides stale V2 lights and keeps selection independent of Todo metadata', { timeout: 5000 }, async (t) => {
  const server = await nativeServer(t, {
    lights: { live: 'done', waiting: 'waiting', child: 'busy', archived: 'busy' },
    items: [
      { sessionId: 'child', running: true, origin: 'subagent', updatedAt: 9999 },
      { sessionId: 'archived', running: true, archived: true, updatedAt: 9999 },
      { sessionId: 'waiting', running: false, updatedAt: 200, title: 'private-title', cwd: 'private-cwd' },
      { sessionId: 'live', running: true, updatedAt: 100, hidden: true, pinned: false, priority: 'P3' },
    ],
  });
  const pool = createRemoteProxyPool();
  t.after(() => pool.stopAll());
  const config = { remotes: [configuredRemote('route-win', 'win', server.url)] };
  await pool.probeAll(config.remotes);
  const focus = createInitialSessionFocusResolver({ remotePool: pool, getConfig: () => config });
  assert.deepEqual(await focus({ deviceId: 'win', routeId: 'route-win' }), { ok: true, sessionId: 'live', reason: 'busy' });
  assert.deepEqual(server.posted, [{ path: '/api/session/list', method: 'session/list' }], 'only the native read API may be called');
});

test('remote unknown states keep current, route mismatches never query another device, and query failures never fall back', { timeout: 5000 }, async (t) => {
  const primary = await nativeServer(t, { items: [{ sessionId: 'unknown', running: false, status: 'done', updatedAt: 999 }] });
  const other = await nativeServer(t, { items: [{ sessionId: 'other-live', running: true }] });
  const pool = createRemoteProxyPool();
  t.after(() => pool.stopAll());
  const config = { remotes: [configuredRemote('primary', 'win', primary.url), configuredRemote('other', 'other-device', other.url)] };
  const focus = createInitialSessionFocusResolver({ remotePool: pool, getConfig: () => config });
  assert.deepEqual(await focus({ deviceId: 'win', routeId: 'primary' }), keep, 'no V2 light means no invented done state');
  for (const body of [{ deviceId: 'win', routeId: 'other' }, { deviceId: 'win', routeId: 'missing' }, { deviceId: 'win' }]) {
    assert.deepEqual(await focus(body), failed);
  }
  assert.equal(primary.posted.length, 1);
  assert.deepEqual(other.posted, [], 'the registered route must belong to the requested device');
  const broken = await nativeServer(t, { response: { result: { ok: false, error: 'private-network-url' } } });
  config.remotes.unshift(configuredRemote('broken', 'win', broken.url));
  assert.deepEqual(await focus({ deviceId: 'win', routeId: 'broken' }), failed);
  assert.equal(primary.posted.length, 1, 'failure on the exact route cannot silently switch to another route');
});

test('changed registration rejects a late native result instead of opening a session on the replacement device', { timeout: 5000 }, async (t) => {
  const entered = deferred();
  const release = deferred();
  const source = await nativeServer(t, { items: [{ sessionId: 'stale-live', running: true }],
    onRequest: async () => { entered.resolve(); await release.promise; } });
  const replacement = await nativeServer(t, { items: [{ sessionId: 'replacement-live', running: true }] });
  const pool = createRemoteProxyPool();
  t.after(() => { release.resolve(); pool.stopAll(); });
  const config = { remotes: [configuredRemote('route-win', 'win', source.url)] };
  const focus = createInitialSessionFocusResolver({ remotePool: pool, getConfig: () => config });
  const pending = focus({ deviceId: 'win', routeId: 'route-win' });
  await entered.promise;
  config.remotes[0].url = replacement.url;
  release.resolve();
  assert.deepEqual(await pending, failed);
  assert.deepEqual(replacement.posted, []);
});
