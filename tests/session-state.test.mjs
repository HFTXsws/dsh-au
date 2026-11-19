import test from 'node:test';
import assert from 'node:assert/strict';
import { STALE_CLOSE_MS, createSessionStateStore } from '../lib/session-state.js';

// 事件夹具：只含事件类型、序号与必要的关联字段，不含任何真实对话内容。
function stream() {
  let n = 0;
  const e = (type, data = {}) => ({ type, seq: n++, time: 1_000 + n, data });
  return {
    turnStart: (turn = 1) => e('turn/start', { turn }),
    turnEnd: (kind, turn = 1) => e('turn/end', { turn, reason: { kind } }),
    approvalAsked: (id) => e('approval/asked', { id, toolName: 'bash', callId: `call-${id}` }),
    approvalDecided: (id, outcome = 'allowed-once') => e('approval/decided', { id, outcome }),
    questionCall: (callId) => e('tool/call', { turn: 1, step: 1, callId, name: 'ask_user_question', arguments: '{}' }),
    otherCall: (callId) => e('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{}' }),
    toolResult: (callId) => e('tool/result', { turn: 1, step: 1, message: { toolCallId: callId } }),
  };
}

test('no events means idle', () => {
  const store = createSessionStateStore();
  assert.equal(store.get('s1'), 'idle');
});

test('open turn is busy, completed turn is done until confirmed', () => {
  const s = stream();
  const store = createSessionStateStore();
  store.ingest('s1', [s.turnStart()]);
  assert.equal(store.get('s1'), 'busy');
  store.ingest('s1', [s.turnEnd('completed')]);
  assert.equal(store.get('s1'), 'done');
  assert.equal(store.confirm('s1'), true);
  assert.equal(store.get('s1'), 'idle');
});

test('a new turn clears the previous confirmation and result', () => {
  const s = stream();
  const store = createSessionStateStore();
  store.ingest('s1', [s.turnStart(1), s.turnEnd('completed', 1)]);
  store.confirm('s1');
  store.ingest('s1', [s.turnStart(2)]);
  assert.equal(store.get('s1'), 'busy');
  store.ingest('s1', [s.turnEnd('completed', 2)]);
  assert.equal(store.get('s1'), 'done');
});

test('turn end reasons map to lights', () => {
  const cases = {
    completed: 'done', 'max-tokens': 'done', blocked: 'done', interrupted: 'done',
    error: 'error',
    aborted: 'idle', forked: 'idle',
  };
  for (const [kind, light] of Object.entries(cases)) {
    const s = stream();
    const store = createSessionStateStore();
    store.ingest('s1', [s.turnStart(), s.turnEnd(kind)]);
    assert.equal(store.get('s1'), light, kind);
  }
});

test('error stays red until confirmed', () => {
  const s = stream();
  const store = createSessionStateStore();
  store.ingest('s1', [s.turnStart(), s.turnEnd('error')]);
  assert.equal(store.get('s1'), 'error');
  assert.equal(store.confirm('s1'), true);
  assert.equal(store.get('s1'), 'idle');
});

test('pending approval is waiting and resolves back to busy', () => {
  const s = stream();
  const store = createSessionStateStore();
  store.ingest('s1', [s.turnStart(), s.approvalAsked('a1')]);
  assert.equal(store.get('s1'), 'waiting');
  store.ingest('s1', [s.approvalDecided('a1')]);
  assert.equal(store.get('s1'), 'busy');
});

test('rejected or cancelled approvals also release the wait', () => {
  for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
    const s = stream();
    const store = createSessionStateStore();
    store.ingest('s1', [s.turnStart(), s.approvalAsked('a1'), s.approvalDecided('a1', outcome)]);
    assert.equal(store.get('s1'), 'busy', outcome);
  }
});

test('ask_user_question without a result is waiting; other tool calls are not', () => {
  const s = stream();
  const store = createSessionStateStore();
  store.ingest('s1', [s.turnStart(), s.otherCall('c0')]);
  assert.equal(store.get('s1'), 'busy');
  store.ingest('s1', [s.questionCall('c1')]);
  assert.equal(store.get('s1'), 'waiting');
  store.ingest('s1', [s.toolResult('c1')]);
  assert.equal(store.get('s1'), 'busy');
});

test('turn end clears any leftover pending waits', () => {
  const s = stream();
  const store = createSessionStateStore();
  store.ingest('s1', [s.turnStart(), s.approvalAsked('a1'), s.questionCall('c1'), s.turnEnd('aborted')]);
  assert.equal(store.get('s1'), 'idle');
});

test('ingest is idempotent and ignores stale sequence numbers', () => {
  const s = stream();
  const store = createSessionStateStore();
  const events = [s.turnStart(), s.turnEnd('completed')];
  store.ingest('s1', events);
  store.ingest('s1', events);
  store.ingest('s1', [events[0]]);
  assert.equal(store.get('s1'), 'done');
  assert.equal(store.lastSeq('s1'), events[1].seq);
});

test('confirm refuses while a turn is open', () => {
  const s = stream();
  const store = createSessionStateStore();
  store.ingest('s1', [s.turnStart()]);
  assert.equal(store.confirm('s1'), false);
  assert.equal(store.get('s1'), 'busy');
});

test('a running agent shows busy even before events arrive', () => {
  const store = createSessionStateStore();
  store.setAgentRunning('s1', true);
  assert.equal(store.get('s1'), 'busy');
  store.setAgentRunning('s1', false);
  assert.equal(store.get('s1'), 'idle');
});

test('an open turn with no running agent is closed as interrupted and waits for confirmation (blue, not red)', () => {
  const s = stream();
  const store = createSessionStateStore();
  store.ingest('s1', [s.turnStart()]);
  store.setAgentRunning('s1', false);
  store.reconcile('s1', 0);
  assert.equal(store.get('s1'), 'busy');
  store.reconcile('s1', STALE_CLOSE_MS);
  assert.equal(store.get('s1'), 'done');
});

test('a running agent keeps an open turn from being treated as orphaned', () => {
  const s = stream();
  const store = createSessionStateStore();
  store.ingest('s1', [s.turnStart()]);
  store.setAgentRunning('s1', true);
  store.reconcile('s1', 0);
  store.reconcile('s1', STALE_CLOSE_MS);
  store.reconcile('s1', STALE_CLOSE_MS * 3);
  assert.equal(store.get('s1'), 'busy');
});

test('drop forgets a session and entries lists every known session', () => {
  const s = stream();
  const store = createSessionStateStore();
  store.ingest('s1', [s.turnStart()]);
  store.ingest('s2', [s.turnStart(), s.turnEnd('completed')]);
  assert.deepEqual(store.entries().sort(), [['s1', 'busy'], ['s2', 'done']]);
  store.drop('s1');
  assert.deepEqual(store.entries(), [['s2', 'done']]);
});

test('silenceOlderThan acknowledges stale unconfirmed results only', () => {
  const s = stream();
  const store = createSessionStateStore();
  store.ingest('old', [s.turnStart(), s.turnEnd('error')]);
  store.ingest('new', [s.turnStart(), s.turnEnd('completed')]);
  const newTime = store.lastTime('new');
  store.silenceOlderThan(newTime);
  assert.equal(store.get('old'), 'idle');
  assert.equal(store.get('new'), 'done');
});

test('confirm reports the ended turn sequence so it can be persisted', () => {
  const s = stream();
  const acked = [];
  const store = createSessionStateStore({ onAck: (id, seq) => acked.push([id, seq]) });
  const [start, end] = [s.turnStart(), s.turnEnd('completed')];
  store.ingest('s1', [start, end]);
  assert.equal(store.confirm('s1'), true);
  assert.deepEqual(acked, [['s1', end.seq]]);
});

test('replaying an already-acknowledged turn end keeps the light quiet, a newer one lights up again', () => {
  const s = stream();
  const first = [s.turnStart(1), s.turnEnd('completed', 1)];
  const second = [s.turnStart(2), s.turnEnd('error', 2)];
  const ackedSeq = first[1].seq;
  const store = createSessionStateStore({ ackedSeqOf: () => ackedSeq });
  store.ingest('s1', first);
  assert.equal(store.get('s1'), 'idle');
  store.ingest('s1', second);
  assert.equal(store.get('s1'), 'error');
});

test('an orphaned turn closed after restart honours the persisted acknowledgement', () => {
  const s = stream();
  const events = [s.turnStart()];
  const store = createSessionStateStore({ ackedSeqOf: () => events[0].seq });
  store.ingest('s1', events);
  store.reconcile('s1', 0);
  store.reconcile('s1', STALE_CLOSE_MS);
  assert.equal(store.get('s1'), 'idle');
});
