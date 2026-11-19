import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { createAckStore } from '../lib/ack-store.js';
import { createSessionStateStore } from '../lib/session-state.js';
import { createStatusTracker } from '../lib/status-tracker.js';
import { createRuntimeBridge } from '../lib/runtime-bridge.js';
import { listConversationSummaries, listLocalWorkspaces } from '../lib/session-reader.js';
import { registerTodoRoutes, fetchRemoteNativeSessions } from '../lib/todo/index.js';

const event = (type, seq, data = {}) => ({ type, seq, time: 1_000 + seq, data });
const turn = (seq, kind = 'completed') => [
  event('turn/start', seq, { turn: seq }),
  event('turn/end', seq + 1, { reason: { kind } }),
];
const detail = (status, stateSeq, endSeq = -1, ackedSeq = -1) => ({ status, stateSeq, endSeq, ackedSeq });
const recentAt = Date.now() - 1000;

function isolateTodoStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-sidebar-protocol-'));
  const previous = process.env.DSH_AU_TODO_PATH;
  process.env.DSH_AU_TODO_PATH = join(dir, 'todo.json');
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_AU_TODO_PATH;
    else process.env.DSH_AU_TODO_PATH = previous;
    // Only remove the exact temporary directory allocated by this fixture.
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function routeClient(t, bridge) {
  let handler;
  const dispose = registerTodoRoutes({
    server: { register(spec) { handler = spec.handler; return () => {}; } },
    bridge,
  });
  t.after(dispose);
  return async (body) => {
    const req = new PassThrough();
    req.method = 'POST';
    let payload;
    const res = { writeHead() {}, end(text) { payload = JSON.parse(text); } };
    const pending = handler(req, res);
    req.end(JSON.stringify(body));
    await pending;
    return payload;
  };
}

function remoteBridge({ device = {}, cards = [], workspaces, nativeItems = [] } = {}) {
  return {
    getLocalDevice: () => ({ deviceId: 'local', name: '本机' }),
    listLocalSessions: async () => [],
    getDevices: async () => [{ deviceId: 'peer', name: '远端', ...device }],
    requestDevice: async (_id, path) => path === '/api/session/list'
      ? { result: { ok: true, value: { items: nativeItems } } }
      : { ok: true, cards, ...(workspaces === undefined ? {} : { workspaces }) },
  };
}

// 2026-10-30: delayed acknowledgement must not clear a later completed turn.
test('observed end confirmation is idempotent, persists old acknowledgements, and refuses a later turn', (t) => {
  const dir = isolateTodoStore(t);
  const ackStore = createAckStore({ filePath: join(dir, 'acks.json') });
  ackStore.set('existing', 7);
  const store = createSessionStateStore({ ackedSeqOf: ackStore.get, onAck: ackStore.set });
  store.ingest('s1', turn(10));
  assert.equal(store.confirm('s1', 11), true);
  assert.equal(store.confirm('s1', 11), true);
  store.ingest('s1', turn(12, 'error'));
  assert.equal(store.confirm('s1', 11), false, 'old end confirmation must not acknowledge end 13');
  assert.equal(store.get('s1'), 'error');
  assert.deepEqual(store.getState('s1'), detail('error', 13, 13, 11));
  assert.equal(store.confirm('s1', 13), true);
  ackStore.flush();
  const reloaded = createAckStore({ filePath: join(dir, 'acks.json') });
  assert.equal(reloaded.get('existing'), 7);
  assert.equal(reloaded.get('s1'), 13);
});

test('strict HTTP confirmation refuses running, waiting, unknown and mismatched ends without reporting success', async (t) => {
  isolateTodoStore(t);
  let agents = [];
  const tracker = createStatusTracker(() => ({ list: () => agents }));
  t.after(() => tracker.dispose());
  tracker.ingest('s1', turn(10));
  const bridge = createRuntimeBridge({
    ctx: {}, getConfig: () => ({ remotes: [] }), remotePool: {}, statusTracker: tracker,
    getLocalHostInfo: () => ({ hostname: 'test', ips: [] }),
  });
  const call = routeClient(t, bridge);
  for (const expectedEndSeq of [9, -1, '11', null]) {
    const response = await call({ action: 'confirmSession', sessionId: 's1', expectedEndSeq });
    assert.equal(response.ok, false, String(expectedEndSeq));
    assert.equal(response.confirmed, false);
    assert.equal(response.state.status, 'done');
  }
  const accepted = await call({ action: 'confirmSession', sessionId: 's1', expectedEndSeq: 11 });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.confirmed, true);
  assert.deepEqual(accepted.state, detail('idle', 11, 11, 11));
  tracker.ingest('s1', [event('turn/start', 12)]);
  agents = [{ id: 's1', status: 'running' }];
  for (const state of ['busy', 'waiting']) {
    if (state === 'waiting') tracker.ingest('s1', [event('approval/asked', 13, { id: 'approval' })]);
    const response = await call({ action: 'confirmSession', sessionId: 's1', expectedEndSeq: 11 });
    assert.equal(response.ok, false);
    assert.equal(response.confirmed, false);
    assert.equal(response.state.status, state);
  }
  const unknown = await call({ action: 'confirmSession', sessionId: 'unknown', expectedEndSeq: 11 });
  assert.equal(unknown.confirmed, false);
});

test('tracker details and local cards/tree share event and acknowledgement sequences without changing old light fields', async (t) => {
  isolateTodoStore(t);
  const tracker = createStatusTracker(() => ({ list: () => [] }));
  tracker.ingest('s1', turn(20));
  tracker.confirm('s1', 21);
  const ctx = {
    get: (key) => key === 'workspaceRegistry'
      ? { list: () => [{ workspaceId: 'real-ws', title: '项目', path: '/project', sessionIds: ['s1'] }] }
      : key === 'sessionQuery'
        ? { listSessions: async () => [{ header: { id: 's1', title: '对话', cwd: '/project' } }], observeSession: async () => ({ events: [] }) }
        : null,
  };
  const snapshot = tracker.getSnapshot();
  assert.equal(snapshot.sessions.s1, 'idle');
  assert.equal(snapshot.sessionsV2.s1, 'idle');
  assert.deepEqual(snapshot.sessionsDetails.s1, detail('idle', 21, 21, 21));
  const cards = await listConversationSummaries(ctx, tracker);
  const workspaces = await listLocalWorkspaces(ctx, tracker);
  for (const session of [cards[0], workspaces[0].sessions[0]]) {
    assert.equal(session.stateSeq, 21);
    assert.equal(session.endSeq, 21);
    assert.equal(session.ackedSeq, 21);
  }
});

// 2026-10-30: stale probe busy/waiting used to overwrite a newer authoritative idle.
test('authoritative cards and workspace idle win stale busy/waiting probes including explicitly unversioned peers', async (t) => {
  isolateTodoStore(t);
  let fixtures;
  const bridge = remoteBridge();
  bridge.getDevices = async () => [{ deviceId: 'peer', name: '远端', ...fixtures.device }];
  bridge.requestDevice = async () => fixtures.response;
  const call = routeClient(t, bridge);
  for (const probedLight of ['busy', 'waiting']) {
    for (const versioned of [false, true]) {
      const meta = versioned ? { stateSeq: 11, endSeq: 11, ackedSeq: 11 } : {};
      fixtures = {
        device: { sessionStatesV2: { s1: probedLight }, ...(versioned ? { sessionStateDetails: { s1: detail(probedLight, 10) } } : {}) },
        response: { ok: true, cards: [{ sessionId: 's1', title: '已读', status: 'idle', updatedAt: recentAt, ...meta }], workspaces: [{ workspaceId: 'w', sessions: [{ sessionId: 's1', title: '已读', status: 'idle', updatedAt: recentAt, ...meta }] }] },
      };
      const response = await call({ action: 'getState' });
      assert.equal(response.cards[0].status, 'idle', `${probedLight}, versioned=${versioned}`);
      assert.equal(response.remoteWorkspaces[0].sessions[0].status, 'idle');
      if (versioned) assert.equal(response.remoteWorkspaces[0].sessions[0].ackedSeq, 11);
    }
  }
});

// 2026-10-30: 51 active roots produced only 50 tree nodes when workspaces were present.
test('native supplementation inserts missing active roots into existing real workspace, preserves empty groups and pins, and excludes archived children', async (t) => {
  isolateTodoStore(t);
  const cards = Array.from({ length: 50 }, (_, i) => ({ sessionId: `s${i}`, title: `对话${i}`, status: 'busy', cwd: '/project', updatedAt: i, pinned: i === 0 }));
  const nativeItems = [...cards, { sessionId: 's50', title: '活跃第51条', workspaceId: 'real-ws', cwd: '/unrelated', running: true }, { sessionId: 'archived', archived: true, running: true }, { sessionId: 'child', origin: 'subagent', running: true }]
    .map((item) => ({ ...item, blank: false, projections: { values: { title: item.title || item.sessionId } } }));
  const device = { sessionStatesV2: Object.fromEntries(nativeItems.map((item) => [item.sessionId, 'busy'])) };
  const call = routeClient(t, remoteBridge({ device, cards, nativeItems, workspaces: [
    { workspaceId: 'empty', title: '空工作区', path: '/empty', sessions: [] },
    { workspaceId: 'real-ws', title: '项目', path: '/project', sessions: cards },
  ] }));
  const response = await call({ action: 'getRemoteWorkspaces' });
  const project = response.remoteWorkspaces.find((ws) => ws.workspaceId === 'real-ws');
  assert.equal(project.sessions.length, 51);
  assert.equal(project.sessions.find((s) => s.sessionId === 's50').status, 'busy');
  assert.equal(project.sessions[0].sessionId, 's0', 'pin remains first');
  assert.deepEqual(response.remoteWorkspaces.find((ws) => ws.workspaceId === 'empty').sessions, []);
  assert.equal(response.remoteWorkspaces.flatMap((ws) => ws.sessions).some((s) => s.sessionId === 'archived' || s.sessionId === 'child'), false);
});

test('local workspace tree keeps all 51 active roots beyond history limit and excludes archived and delegated records', async (t) => {
  isolateTodoStore(t);
  const tracker = createStatusTracker(() => ({ list: () => [] }));
  const records = Array.from({ length: 51 }, (_, i) => ({ header: { id: `s${i}`, title: `活跃${i}`, cwd: '/project' }, updatedAt: i }));
  for (const record of records) tracker.ingest(record.header.id, [event('turn/start', 1)]);
  records.push({ header: { id: 'archived', title: '已归档', cwd: '/project' } }, { header: { id: 'child', title: '子代理', cwd: '/project', delegationDepth: 1 } });
  const ctx = { get: (key) => key === 'workspaceRegistry'
    ? { archivedSessionIds: ['archived'], pinnedSessionIds: ['s0'], list: () => [{ workspaceId: 'w', title: '项目', path: '/project', sessionIds: records.map((r) => r.header.id) }] }
    : key === 'sessionQuery' ? { listSessions: async () => records, observeSession: async () => ({ events: [] }) } : null };
  const workspaces = await listLocalWorkspaces(ctx, tracker, 50);
  assert.equal(workspaces[0].sessions.length, 51);
  assert.equal(workspaces[0].sessions[0].sessionId, 's0');
});

test('registered workspace ID beats a mismatched cwd even when the cwd workspace appears first', async (t) => {
  isolateTodoStore(t);
  const tracker = createStatusTracker(() => ({ list: () => [] }));
  tracker.ingest('s1', [event('turn/start', 1)]);
  const ctx = { get: (key) => key === 'workspaceRegistry'
    ? { list: () => [
      { workspaceId: 'cwd-ws', title: '路径项目', path: '/cwd', sessionIds: [] },
      { workspaceId: 'real-ws', title: '真正项目', path: '/real', sessionIds: [] },
    ] }
    : key === 'sessionQuery' ? { listSessions: async () => [{ header: { id: 's1', title: '活跃', workspaceId: 'real-ws', cwd: '/cwd' } }], observeSession: async () => ({ events: [] }) } : null };
  const workspaces = await listLocalWorkspaces(ctx, tracker);
  assert.equal(workspaces[0].sessions.length, 0);
  assert.equal(workspaces[1].sessions[0].sessionId, 's1');
});

test('native-only HTTP acknowledgement exposes local-only fallback and rejects stale ends and transport failures', async (t) => {
  isolateTodoStore(t);
  let current = detail('done', 11, 11);
  let httpStatus = 404;
  const bridge = remoteBridge();
  bridge.getDevices = async () => [{ deviceId: 'peer', name: '远端', sessionStatesV2: { s1: 'done' }, sessionStateDetails: { s1: current } }];
  bridge.requestDevice = async (_deviceId, path) => path === '/api/session/list'
    ? { result: { ok: true, value: { items: [{ sessionId: 's1', blank: false, running: false, updatedAt: recentAt, projections: { values: { title: '对话' } } }] } } }
    : { ok: false, httpStatus };
  const call = routeClient(t, bridge);
  await call({ action: 'getState' });
  const accepted = await call({ action: 'confirmSession', deviceId: 'peer', sessionId: 's1', expectedEndSeq: 11 });
  assert.equal(accepted.confirmed, true);
  assert.equal(accepted.localOnly, true);
  assert.equal(accepted.legacy, true);
  current = detail('done', 13, 13);
  const refreshed = await call({ action: 'getState' });
  assert.equal(refreshed.cards[0].status, 'done');
  const stale = await call({ action: 'confirmSession', deviceId: 'peer', sessionId: 's1', expectedEndSeq: 11 });
  assert.equal(stale.ok, false);
  assert.equal(stale.confirmed, false);
  httpStatus = 503;
  const failed = await call({ action: 'confirmSession', deviceId: 'peer', sessionId: 's1', expectedEndSeq: 13 });
  assert.equal(failed.ok, false);
  assert.equal(failed.confirmed, false);
});

test('native-only versioned read acknowledgement is bound to its end and never hides a newer completion', async (t) => {
  isolateTodoStore(t);
  const states = new Map([['peer:s1', { status: 'idle', acknowledged: true, ackedSeq: 11 }]]);
  const bridge = remoteBridge({ nativeItems: [{ sessionId: 's1', blank: false, running: false, projections: { values: { title: '对话' } } }] });
  const device = { deviceId: 'peer', sessionStatesV2: { s1: 'done' }, sessionStateDetails: { s1: detail('done', 13, 13, -1) } };
  const cards = await fetchRemoteNativeSessions(bridge, device, states);
  assert.equal(cards[0].status, 'done');
  assert.equal(cards[0].endSeq, 13);
  assert.equal(cards[0].ackedSeq, 11);
});

// 2026-11-02: native supplementation must not resurrect an owner's completed/hidden card from a stale light.
for (const protocol of ['hidden IDs', 'legacy workspace tree']) {
  test(`remote completion exclusions from ${protocol} survive native supplementation without losing another active root`, async (t) => {
    isolateTodoStore(t);
    const bridge = remoteBridge({
      device: { sessionStatesV2: { hidden: 'done', active: 'busy' } },
      nativeItems: ['hidden', 'active'].map((sessionId) => ({ sessionId, blank: false, running: sessionId === 'active',
        updatedAt: recentAt, projections: { values: { title: sessionId } } })),
    });
    const request = bridge.requestDevice;
    bridge.requestDevice = async (id, path) => path === '/dsh-au-todo/api'
      ? { ok: true, cards: [], ...(protocol === 'hidden IDs' ? { hiddenSessionIds: ['hidden'] }
        : { workspaces: [{ workspaceId: 'w', sessions: [{ sessionId: 'hidden', title: '已完成', status: 'idle' }] }] }) }
      : request(id, path);
    const call = routeClient(t, bridge);
    const state = await call({ action: 'getState' });
    assert.deepEqual(state.cards.map((card) => card.sessionId), ['active']);
    assert.ok(state.authoritativeDeviceIds.includes('peer'));
  });
}

test('completion publishes its owning state and hidden IDs, stays hidden across background turns, and reopens on a new human message', async (t) => {
  isolateTodoStore(t);
  const tracker = createStatusTracker(() => ({ list: () => [] }));
  t.after(() => tracker.dispose());
  tracker.ingest('s1', turn(10));
  let lastUserMessageAt = recentAt;
  const bridge = {
    getLocalDevice: () => ({ deviceId: 'self', name: '本机' }),
    getDevices: async () => [],
    listLocalSessions: async () => [{ sessionId: 's1', title: '任务', updatedAt: recentAt, lastUserMessageAt, ...tracker.getSessionState('s1') }],
    getSessionState: (id) => tracker.getSessionState(id),
    confirmSession: (id, expectedEndSeq) => tracker.confirm(id, expectedEndSeq),
  };
  const call = routeClient(t, bridge);
  const completed = await call({ action: 'hideSession', sessionId: 's1', lastUserMessageAt });
  assert.equal(completed.ok, true);
  assert.deepEqual(completed.state, detail('idle', 11, 11, 11));
  const hidden = await call({ action: 'getLocalSessions' });
  assert.deepEqual(hidden.cards, []);
  assert.deepEqual(hidden.hiddenSessionIds, ['s1']);
  // 后台插件自动续跑触发 turn/start（无新用户消息）时，必须保持隐藏，不得重新弹出
  tracker.ingest('s1', [event('turn/start', 12)]);
  const bgActive = await call({ action: 'getLocalSessions' });
  assert.deepEqual(bgActive.cards, []);
  // 用户本人主动发送新消息后，解除隐藏并重新展示
  lastUserMessageAt = Date.now() + 2000;
  const active = await call({ action: 'getLocalSessions' });
  assert.equal(active.cards[0].status, 'busy');
  assert.equal(active.cards[0].stateSeq, 12);
  tracker.ingest('s1', [event('turn/end', 13, { reason: { kind: 'completed' } })]);
  const late = await call({ action: 'hideSession', sessionId: 's1', expectedEndSeq: 11 });
  assert.equal(late.confirmed, false);
  assert.equal(late.state.status, 'done', 'an old completion click must not acknowledge end 13');
});
