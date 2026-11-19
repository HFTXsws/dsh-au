import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAckStore } from '../lib/ack-store.js';
import { listConversationSummaries, subscribeSessionEvents } from '../lib/session-reader.js';
import { STALE_CLOSE_MS } from '../lib/session-state.js';
import { createStatusTracker } from '../lib/status-tracker.js';

function events(...items) {
  return items.map(([type, data], index) => ({ type, seq: index, time: Date.now(), data }));
}

test('a vanished running agent no longer holds the yellow light', () => {
  let agents = [{ id: 's1', status: 'running' }];
  const tracker = createStatusTracker(() => ({ list: () => agents }));
  assert.equal(tracker.getSnapshot().runningCount, 1);
  agents = [];
  const snapshot = tracker.getSnapshot();
  assert.equal(snapshot.runningCount, 0);
  assert.notEqual(snapshot.status, 'busy');
});

test('sub-agents are excluded from lights and counts', () => {
  const root = { id: 'root', status: 'running' };
  const child = { id: 'child', status: 'running' };
  const tracker = createStatusTracker(() => ({ list: () => [root, child], roots: () => [root] }));
  const snapshot = tracker.getSnapshot();
  assert.equal(snapshot.runningCount, 1);
  assert.deepEqual(Object.keys(snapshot.sessionsV2), ['root']);
});

test('waiting is folded to busy in legacy fields and kept in V2 fields', () => {
  const tracker = createStatusTracker(() => ({ list: () => [{ id: 's1', status: 'running' }] }));
  tracker.ingest('s1', events(
    ['turn/start', { turn: 1 }],
    ['approval/asked', { id: 'a1', toolName: 'bash', callId: 'c1' }],
  ));
  const snapshot = tracker.getSnapshot();
  assert.equal(snapshot.status, 'busy');
  assert.equal(snapshot.statusV2, 'waiting');
  assert.equal(snapshot.sessions.s1, 'busy');
  assert.equal(snapshot.sessionsV2.s1, 'waiting');
  assert.equal(snapshot.runningCount, 1);
  assert.equal(snapshot.waitingCount, 1);
  assert.equal(tracker.getSessionStatus('s1'), 'waiting');
});

test('error outranks waiting and busy in the device aggregate', () => {
  let agents = [{ id: 'a', status: 'running' }, { id: 'b', status: 'running' }];
  const tracker = createStatusTracker(() => ({ list: () => agents }));
  tracker.ingest('a', events(['turn/start', { turn: 1 }], ['approval/asked', { id: 'x', toolName: 'bash' }]));
  tracker.ingest('b', events(['turn/start', { turn: 1 }]));
  assert.equal(tracker.getSnapshot().statusV2, 'waiting');
  agents = [{ id: 'a', status: 'running' }, { id: 'b', status: 'idle' }];
  tracker.ingest('b', events(['turn/start', { turn: 2 }], ['turn/end', { turn: 2, reason: { kind: 'error' } }]).map((e, i) => ({ ...e, seq: 10 + i })));
  const snapshot = tracker.getSnapshot();
  assert.equal(snapshot.statusV2, 'error');
  assert.equal(snapshot.status, 'error');
});

test('replay after the agent stops running reads turn/end for the exact reason', async () => {
  let agents = [{ id: 's1', status: 'running' }];
  const log = events(['turn/start', { turn: 1 }], ['turn/end', { turn: 1, reason: { kind: 'aborted' } }]);
  const tracker = createStatusTracker(() => ({ list: () => agents }), {
    readEventsAfter: async (_id, afterSeq) => log.filter((event) => event.seq > afterSeq),
  });
  tracker.getSnapshot();
  agents = [{ id: 's1', status: 'idle' }];
  tracker.getSnapshot();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tracker.getSessionStatus('s1'), 'idle');
});

test('start replays recent sessions and recovers unconfirmed completion, silencing old ones', async () => {
  const now = Date.now();
  const logs = {
    fresh: [
      { type: 'turn/start', seq: 0, time: now - 60_000, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: now - 50_000, data: { turn: 1, reason: { kind: 'error' } } },
    ],
    stale: [
      { type: 'turn/start', seq: 0, time: now - 3 * 24 * 3600_000, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: now - 3 * 24 * 3600_000 + 5, data: { turn: 1, reason: { kind: 'completed' } } },
    ],
    crashed: [{ type: 'turn/start', seq: 0, time: now - 120_000, data: { turn: 1 } }],
  };
  const tracker = createStatusTracker(() => ({ list: () => [] }), {
    listSessionIds: async () => Object.keys(logs),
    readEventsAfter: async (id, afterSeq) => logs[id].filter((event) => event.seq > afterSeq),
  });
  await tracker.start();
  tracker.dispose();
  const snapshot = tracker.getSnapshot();
  assert.equal(snapshot.sessionsV2.fresh, 'error');
  assert.equal(snapshot.sessionsV2.stale, 'idle');
  assert.equal(snapshot.sessionsV2.crashed, 'done');
});

test('subscription events reach the store and dispose unsubscribes', async () => {
  let handler = null;
  let unsubscribed = false;
  const tracker = createStatusTracker(() => ({ list: () => [] }), {
    subscribe: (fn) => { handler = fn; return () => { unsubscribed = true; }; },
  });
  await tracker.start();
  handler('s1', events(['turn/start', { turn: 1 }]));
  assert.equal(tracker.getSnapshot().sessionsV2.s1, 'busy');
  tracker.dispose();
  assert.equal(unsubscribed, true);
});

test('stale window constant is long enough to cover the end-of-turn flush', () => {
  assert.ok(STALE_CLOSE_MS >= 6_000);
});

test('a confirmation survives a restart: the replayed completion stays quiet, the next one lights up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-ack-restart-'));
  const filePath = join(dir, 'dsh-au.acks.json');
  const now = Date.now();
  const log = [
    { type: 'turn/start', seq: 0, time: now - 5_000, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: now - 4_000, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const makeTracker = () => createStatusTracker(() => ({ list: () => [] }), {
    ackStore: createAckStore({ filePath }),
    listSessionIds: async () => ['s1'],
    readEventsAfter: async (_id, afterSeq) => log.filter((event) => event.seq > afterSeq),
  });
  try {
    const first = makeTracker();
    await first.start();
    assert.equal(first.getSessionStatus('s1'), 'done');
    assert.equal(first.confirm('s1'), true);
    first.dispose();

    const second = makeTracker();
    await second.start();
    assert.equal(second.getSessionStatus('s1'), 'idle');

    log.push(
      { type: 'turn/start', seq: 2, time: now - 2_000, data: { turn: 2 } },
      { type: 'turn/end', seq: 3, time: now - 1_000, data: { turn: 2, reason: { kind: 'completed' } } },
    );
    const third = makeTracker();
    await third.start();
    assert.equal(third.getSessionStatus('s1'), 'done');
    second.dispose();
    third.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real-time agent/status and workspace archive events update lights without waiting for polling', async () => {
  const bus = new Map();
  const archived = [];
  const agents = [];
  const ctx = {
    on(eventName, fn) {
      const list = bus.get(eventName) || [];
      list.push(fn);
      bus.set(eventName, list);
      return () => {
        bus.set(eventName, (bus.get(eventName) || []).filter((item) => item !== fn));
      };
    },
    get(key) {
      if (key === 'workspaceRegistry') return { archivedSessionIds: archived };
      return null;
    },
  };
  const emit = (eventName, ...args) => {
    for (const fn of bus.get(eventName) || []) fn(...args);
  };

  const tracker = createStatusTracker(() => ({ list: () => agents }), {
    getArchivedSessionIds: () => archived,
    subscribe: (handler, hooks) => subscribeSessionEvents(ctx, handler, hooks),
  });
  await tracker.start();

  // 根会话收到实时 running 信号立即变黄灯；子 agent 信号直接忽略。
  agents.push({ id: 's-live', status: 'running' });
  emit('agent/status', { agent: { id: 's-live', status: 'running' }, status: 'running' });
  emit('agent/status', { agent: { id: 's-sub', parent: 's-live', status: 'running' }, status: 'running' });
  assert.equal(tracker.getSessionStatus('s-live'), 'busy');
  assert.equal(tracker.getSnapshot().sessionsV2['s-sub'], undefined);

  // 根会话从 running 切回 idle 时立即收尾为蓝灯（done）。
  agents[0].status = 'idle';
  emit('agent/status', { agent: { id: 's-live', status: 'idle' }, status: 'idle' });
  assert.equal(tracker.getSessionStatus('s-live'), 'done');

  // 会话实例从内存卸载（session/disposed）不抹除尚未确认的蓝灯。
  agents.length = 0;
  emit('session/disposed', { id: 's-live' });
  assert.equal(tracker.getSessionStatus('s-live'), 'done');

  // 工作区归档该会话时立即移除顶栏灯色。
  archived.push('s-live');
  emit('domain/changed', { domain: 'workspace', table: '', value: { archivedSessionIds: archived } });
  assert.equal(tracker.getSnapshot().sessionsV2['s-live'], undefined);
  assert.equal(tracker.getSnapshot().statusV2, 'idle');

  tracker.dispose();
  assert.equal((bus.get('agent/status') || []).length, 0);
});

test('listConversationSummaries caches unchanged session revisions, deduplicates concurrent reads, and isolates corrupted logs', async () => {
  const bus = new Map();
  let observeCalls = { s1: 0, broken: 0 };
  let s1Revision = 1;
  let s1SummaryText = '第一版摘要';
  let brokenShouldFail = true;

  let titleCalls = 0;
  let currentLight = 'done';
  const ctx = {
    on(eventName, fn) {
      const list = bus.get(eventName) || [];
      list.push(fn);
      bus.set(eventName, list);
      return () => {};
    },
    get(key) {
      if (key === 'sessionPersistence') {
        return {
          stat: async (id) => ({ revision: id === 's1' ? s1Revision : 1 }),
        };
      }
      if (key === 'workspaceRegistry') {
        return { archivedSessionIds: [], list: () => [{ title: 'DemoApp', sessionIds: ['s1', 'broken'] }] };
      }
      if (key === 'sessionQuery') {
        return {
          listSessions: async () => [
            { header: { id: 's1', createdAt: 1000, cwd: 'D:/DemoApp' }, updatedAt: 2000 },
            { header: { id: 'broken', createdAt: 1000, cwd: 'D:/DemoApp' }, updatedAt: 1500 },
          ],
          readTitleSnapshots: async () => {
            titleCalls += 1;
            return [{ title: '正常会话' }, { title: '损坏会话' }];
          },
          observeSession: async (id) => {
            observeCalls[id] = (observeCalls[id] || 0) + 1;
            if (id === 'broken' && brokenShouldFail) {
              throw new Error('corrupted session log');
            }
            return {
              events: [
                { type: 'assistant/message', seq: 1, time: 3000 + s1Revision, data: { text: s1SummaryText } },
              ],
            };
          },
        };
      }
      return null;
    },
  };

  const disposeSub = subscribeSessionEvents(ctx, () => {});
  const tracker = { getSessionStatus: () => currentLight };

  // 并发首次拉取：每个会话只触发一次 observeSession 与一次 readTitleSnapshots。
  const [firstA, firstB] = await Promise.all([
    listConversationSummaries(ctx, tracker, 50),
    listConversationSummaries(ctx, tracker, 50),
  ]);
  assert.equal(observeCalls.s1, 1);
  assert.equal(observeCalls.broken, 1);
  assert.equal(titleCalls, 1);
  assert.equal(firstA[0].summary, '第一版摘要');
  assert.equal(firstB[0].summary, '第一版摘要');
  assert.equal(firstA[1].summary, '');

  // 版本未变化（甚至确认消灯 done -> idle）时再次拉取：命中缓存，不重复调用 readTitleSnapshots 或 observeSession。
  currentLight = 'idle';
  await listConversationSummaries(ctx, tracker, 50);
  assert.equal(observeCalls.s1, 1);
  assert.equal(observeCalls.broken, 1);
  assert.equal(titleCalls, 1);

  // 版本号推进后：重新读取 s1 的新摘要。
  s1Revision = 2;
  s1SummaryText = '第二版摘要';
  const second = await listConversationSummaries(ctx, tracker, 50);
  assert.equal(observeCalls.s1, 2);
  assert.equal(second[0].summary, '第二版摘要');

  // 收到实时 session/event 时：即使持久化 revision 尚未变，也会刷新缓存并解除坏日志隔离。
  brokenShouldFail = false;
  s1SummaryText = '实时事件摘要';
  for (const fn of bus.get('session/event') || []) {
    fn({ sessionId: 'broken', event: { type: 'assistant/message', seq: 2, time: 5000, data: { text: '修复后摘要' } } });
  }
  const third = await listConversationSummaries(ctx, tracker, 50);
  assert.equal(observeCalls.broken, 2);
  assert.equal(third[1].summary, '实时事件摘要');
  disposeSub?.();
});

test('listConversationSummaries re-sorts sessions by latest observed event time when header time is older', async () => {
  const ctx = {
    get(key) {
      if (key === 'sessionQuery') {
        return {
          listSessions: async () => [
            { header: { id: 'older-events', createdAt: 2000 }, updatedAt: 2000 },
            { header: { id: 'newer-events', createdAt: 1000 }, updatedAt: 1000 },
          ],
          readTitleSnapshots: async () => [{ title: '旧活动' }, { title: '新活动' }],
          observeSession: async (id) => ({
            events: [
              { type: 'assistant/message', seq: 1, time: id === 'newer-events' ? 9000 : 2500, data: { text: id } },
            ],
          }),
        };
      }
      return null;
    },
  };
  const result = await listConversationSummaries(ctx, { getSessionStatus: () => 'idle' }, 50);
  assert.deepEqual(result.map((item) => item.sessionId), ['newer-events', 'older-events']);
});

test('opening a historical session that appends session/end-seed and bumps file mtime does not refresh updatedAt to now', async () => {
  const realTurnEndAt = 1_793_700_646_298;
  const endSeedOpenedAt = 1_793_780_862_392;
  const ctx = {
    get(key) {
      if (key === 'sessionQuery') {
        return {
          listSessions: async () => [
            {
              header: { id: 'hist-opened', createdAt: 1_793_690_000_000 },
              updatedAt: endSeedOpenedAt,
              projections: { values: { sessionListMetadata: { lastPromptAt: 1_793_700_548_948 } } },
            },
          ],
          readTitleSnapshots: async () => [{ title: '排查工作区无法展开问题分析' }],
          observeSession: async () => ({
            events: [
              { type: 'user/message', seq: 1, time: 1_793_700_548_948, data: { source: { kind: 'user' }, text: '分析' } },
              { type: 'assistant/message', seq: 2, time: 1_793_700_642_421, data: { text: '结论' } },
              { type: 'turn/end', seq: 3, time: realTurnEndAt, data: { reason: { kind: 'completed' } } },
              { type: 'session/end-seed', seq: 4, time: endSeedOpenedAt, data: {} },
              { type: 'permission/preset', seq: 5, time: endSeedOpenedAt + 1, data: {} },
            ],
          }),
        };
      }
      return null;
    },
  };
  const result = await listConversationSummaries(ctx, { getSessionStatus: () => 'idle' }, 50);
  assert.equal(result[0].updatedAt, realTurnEndAt, 'updatedAt must remain the real turn/end timestamp, ignoring session/end-seed and file mtime');
});
