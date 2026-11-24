import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalTodoActions, dedupeTodoCards, fetchRemoteNativeSessions, isBlankTodoCard, isRecentTodoCard, sortTodoCards } from '../lib/todo/index.js';
import { applyTodoMetadata, loadTodoStore } from '../lib/todo/todo-store.js';

const recentAt = Date.now() - 1000;

const cards = [
  { sessionId: 'late-p0', priority: 'P0', sortOrder: 3, updatedAt: 1 },
  { sessionId: 'first-p1', priority: 'P1', sortOrder: 1, updatedAt: 1 },
  { sessionId: 'first-p0', priority: 'P0', sortOrder: 1, updatedAt: 1 },
  { sessionId: 'stash-p3', pinned: true, priority: 'P3', sortOrder: 9, updatedAt: 1 },
];

test('priority always comes before pin, status, and drag weight', () => {
  assert.deepEqual(sortTodoCards(cards).map((card) => card.sessionId), ['first-p0', 'late-p0', 'first-p1', 'stash-p3']);
});

test('Todo display window includes only the previous 48 hours', () => {
  const now = Date.now();
  assert.equal(isRecentTodoCard({ updatedAt: now - 48 * 60 * 60 * 1000 }, now), true);
  assert.equal(isRecentTodoCard({ updatedAt: now - 48 * 60 * 60 * 1000 - 1 }, now), false);
  assert.equal(isRecentTodoCard({ updatedAt: now + 1 }, now), false);
  assert.equal(isRecentTodoCard({ updatedAt: 'not-a-date' }, now), false);
});

test('same session returned through local and self-remote paths appears once', () => {
  const local = { sessionId: 's1', deviceId: 'local-device', deviceName: '本机' };
  const mirrored = { sessionId: 's1', deviceId: 'self-route', deviceName: 'MyHost' };
  assert.deepEqual(dedupeTodoCards([local, mirrored]), [local]);
});

test('queued Todo is delivered to its owning session then removed only after acceptance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-todo-'));
  process.env.DSH_AU_TODO_PATH = join(dir, 'dsh-au-todo.json');
  try {
    const sent = [];
    const actions = createLocalTodoActions({
      getLocalDevice: () => ({ deviceId: 'dev-a', name: '设备 A' }),
      listLocalSessions: async () => [{ sessionId: 's1', title: '会话', updatedAt: 1, workspace: '默认', status: 'done' }],
      sendTodo: async (sessionId, text) => { sent.push({ sessionId, text }); return { ok: true }; },
      confirmSession: () => true,
    });
    await actions.dispatchLocal('appendTodo', { sessionId: 's1', text: '继续执行下一项' });
    const delivery = await actions.dispatchLocal('sendNextTodo', { sessionId: 's1' });
    assert.equal(delivery.ok, true);
    assert.deepEqual(sent, [{ sessionId: 's1', text: '继续执行下一项' }]);
    assert.equal(applyTodoMetadata([{ sessionId: 's1', updatedAt: 1 }], loadTodoStore())[0].todos.length, 0);
  } finally {
    delete process.env.DSH_AU_TODO_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('failed Todo delivery keeps the queued item for retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-todo-'));
  process.env.DSH_AU_TODO_PATH = join(dir, 'dsh-au-todo.json');
  try {
    const actions = createLocalTodoActions({
      getLocalDevice: () => ({ deviceId: 'dev-a', name: '设备 A' }),
      listLocalSessions: async () => [],
      sendTodo: async () => ({ ok: false, error: 'session unavailable' }),
      confirmSession: () => true,
    });
    await actions.dispatchLocal('appendTodo', { sessionId: 's1', text: '稍后重试' });
    const delivery = await actions.dispatchLocal('sendNextTodo', { sessionId: 's1' });
    assert.equal(delivery.ok, false);
    assert.equal(applyTodoMetadata([{ sessionId: 's1', updatedAt: 1 }], loadTodoStore())[0].todos[0].text, '稍后重试');
  } finally {
    delete process.env.DSH_AU_TODO_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local cards carry isLocal=true and client click navigation invokes openNativeSession for local instanceId', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-todo-'));
  process.env.DSH_AU_TODO_PATH = join(dir, 'dsh-au-todo.json');
  try {
    const actions = createLocalTodoActions({
      getLocalDevice: () => ({ deviceId: 'au_testdevice01', name: 'MyHost' }), // 本机设备 id 用测试占位，不带真实指纹
      listLocalSessions: async () => [{ sessionId: 's-local-1', title: '本机对话', updatedAt: 10, workspace: 'DemoApp', status: 'idle' }],
      sendTodo: async () => ({ ok: true }),
      confirmSession: () => true,
    });
    const localCards = await actions.getLocalSessions();
    assert.equal(localCards[0].deviceId, 'au_testdevice01');
    assert.equal(localCards[0].isLocal, true);

    const clientSrc = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
    assert.match(clientSrc, /function isLocalCard\(card, localDeviceId\)/);
    assert.match(clientSrc, /if \(!isLocalCard\(card, localDeviceId\)\)/);
    assert.match(clientSrc, /const result = openNativeSession\(card\.sessionId, openSession\)/);
  } finally {
    delete process.env.DSH_AU_TODO_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('temporarily pinned Todo persists as the highest-priority card without changing its ordinary priority', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-todo-'));
  process.env.DSH_AU_TODO_PATH = join(dir, 'dsh-au-todo.json');
  try {
    const actions = createLocalTodoActions({
      getLocalDevice: () => ({ deviceId: 'dev-a', name: '设备 A' }),
      listLocalSessions: async () => [
        { sessionId: 'ordinary-p0', title: 'P0', updatedAt: 2, workspace: '默认', status: 'idle' },
        { sessionId: 'stashed-p3', title: '暂存', updatedAt: 1, workspace: '默认', status: 'idle' },
      ],
      sendTodo: async () => ({ ok: true }),
      confirmSession: () => true,
    });
    assert.deepEqual(await actions.dispatchLocal('setPinned', { sessionId: 'stashed-p3', pinned: true }), { ok: true });
    await actions.dispatchLocal('setPriority', { sessionId: 'stashed-p3', priority: 'P3' });
    const cards = await actions.getLocalSessions();
    assert.equal(cards.find((card) => card.sessionId === 'stashed-p3')?.pinned, true);
    assert.equal(cards.find((card) => card.sessionId === 'stashed-p3')?.priority, 'P3');
    assert.deepEqual(sortTodoCards(cards).map((card) => card.sessionId), ['stashed-p3', 'ordinary-p0']);
  } finally {
    delete process.env.DSH_AU_TODO_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('complete only hides a card from the Todo list and preserves its native conversation and queued content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-todo-'));
  process.env.DSH_AU_TODO_PATH = join(dir, 'dsh-au-todo.json');
  try {
    const actions = createLocalTodoActions({
      getLocalDevice: () => ({ deviceId: 'dev-a', name: '设备 A' }),
      listLocalSessions: async () => [{ sessionId: 's-hidden', title: '保留的原生对话', updatedAt: 1, workspace: '默认', status: 'idle' }],
      sendTodo: async () => ({ ok: true }),
      confirmSession: () => true,
    });
    await actions.dispatchLocal('appendTodo', { sessionId: 's-hidden', text: '待办内容必须留存' });
    assert.deepEqual(await actions.dispatchLocal('hideSession', { sessionId: 's-hidden' }), { ok: true });
    assert.equal((await actions.getLocalSessions()).length, 0);
    const stored = applyTodoMetadata([{ sessionId: 's-hidden', updatedAt: 1 }], loadTodoStore())[0];
    assert.equal(stored.hidden, true);
    assert.equal(stored.todos[0].text, '待办内容必须留存');
  } finally {
    delete process.env.DSH_AU_TODO_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Todo client opens a shared phone-and-desktop panel from the official header action and supports compact expansion', () => {
  const clientSrc = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  assert.match(clientSrc, /function TodoHeaderActionInner\(\)/);
  assert.match(clientSrc, /features\.loaded && features\.todo \? h\(TodoHeaderActionInner, props\) : null/);
  assert.match(clientSrc, /features\.loaded && features\.todo \? h\(TodoDockInner, props\) : null/);
  assert.match(clientSrc, /onPointerDown: \(event\) => \{/);
  assert.match(clientSrc, /onTouchStart: \(\) => \{/);
  assert.match(clientSrc, /pointerToggled\.current = true/);
  assert.match(clientSrc, /conversation\.session\.header\.utilities/);
  assert.match(clientSrc, /order:\s*-20/);
  assert.doesNotMatch(clientSrc, /conversation\.session\.header\.actions/);
  assert.doesNotMatch(clientSrc, /conversation\.session\.header\.corner/);
  assert.match(clientSrc, /id: 'dsh-au-todo-toggle'/);
  assert.match(clientSrc, /function setTodoPanelAnchor\(next\)/);
  assert.match(clientSrc, /button\?\.closest\?\.\('header'\)/);
  // [data-slot="conversation.header"] 为 display:contents（宽高等为 0），禁止用它测锚点或给按钮加 fixed。
  assert.doesNotMatch(clientSrc, /closest\?\.\('\[data-slot="conversation\.header"\]'\)/);
  assert.doesNotMatch(clientSrc, /position:\s*'fixed'/);
  assert.doesNotMatch(clientSrc, /right: `\$\{right \+ 42\}px`/);
  assert.match(clientSrc, /new ResizeObserver\(updateAnchor\)/);
  assert.match(clientSrc, /style: panelAnchor/);
  assert.match(clientSrc, /if \(!panelOpen\) return null/);
  assert.doesNotMatch(clientSrc, /dsh-au-mobile="true"\] \.dsh-au-todo-dock/);
  assert.match(clientSrc, /\.dsh-au-todo-summary \{[^}]*white-space:nowrap/s);
  assert.match(clientSrc, /\.dsh-au-todo-card\[data-expanded="true"\] \.dsh-au-todo-summary \{[^}]*max-height:14\.5em/s);
  assert.match(clientSrc, /data-expanded/);
  assert.match(clientSrc, /function selectedSessionSource\(sessions\)/);
  assert.match(clientSrc, /retainedBy\?\.mainView/);
  assert.match(clientSrc, /hooks: \{ selectedSession: currentSession \}/);
  assert.match(clientSrc, /'data-selected': String\(selected\)/);
  assert.match(clientSrc, /'aria-current': selected \? 'page' : undefined/);
  // 2026-10-27 回归：直接从 DSH 原生列表选中已完成会话也必须走确认协议，初始快照不得误确认。
  assert.match(clientSrc, /const previousNativeSelectionId = useRef\(null\)/);
  assert.match(clientSrc, /if \(previous === null\) return;/);
  assert.match(clientSrc, /if \(previous !== selectedSessionId\) pendingNativeSelectionId\.current = selectedSessionId;/);
  assert.match(clientSrc, /isLocalCard\(item, localDeviceId\) && item\.sessionId === sessionId/);
  assert.match(clientSrc, /card\.status !== 'done' && card\.status !== 'error'/);
  assert.match(clientSrc, /callApi\('confirmSession', \{ deviceId: card\.deviceId, sessionId \}\)/);
  assert.match(clientSrc, /collapseCard\(card\)/);
  assert.match(clientSrc, /\.dsh-au-todo-priority-row \{ display:flex/);
  assert.match(clientSrc, /\.dsh-au-todo-priority-pill/);
  assert.match(clientSrc, /\.dsh-au-todo-card-actions \{ display:flex/);
  assert.match(clientSrc, /dsh-au-todo-workspace-tag/);
  assert.match(clientSrc, /dsh-au-todo-device-badge/);
  assert.match(clientSrc, /className: 'dsh-au-todo-jump'/);
  assert.match(clientSrc, /\.dsh-au-todo-name \{[^}]*font-size:14px/s);
  assert.match(clientSrc, /\.dsh-au-todo-name \{ font-size:15px; \}/);
  assert.match(clientSrc, /function isMobileOrTouchViewport\(\)/);
  assert.match(clientSrc, /draggable: !touchMode/);
  assert.match(clientSrc, /if \(isMobileOrTouchViewport\(\)\) \{\s*setPanelOpen\(false\);/s);
  assert.match(clientSrc, /className: 'dsh-au-todo-time'/);
  assert.match(clientSrc, /data-pinned/);
  assert.match(clientSrc, /'置顶'/);
  assert.match(clientSrc, /callApi\('setPinned'/);
  assert.match(clientSrc, /取消置顶/);
  assert.match(clientSrc, /\.dsh-au-todo-card\[data-pinned="true"\]/);
  assert.match(clientSrc, /function reconcileCardsWithAuSnap\(rawCards, snap, localDeviceId\)/);
  assert.match(clientSrc, /window\.addEventListener\(TODO_CYCLE_EVENT, onCycleEvent\)/);
  assert.match(clientSrc, /callApi\('hideSession'/);
  assert.match(clientSrc, /Todo 列表加载失败：/);
});

test('fetchRemoteNativeSessions falls back to native /api/session/list when remote dsh-au-todo is not installed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-todo-'));
  process.env.DSH_AU_TODO_PATH = join(dir, 'dsh-au-todo.json');
  try {
    const remoteStates = new Map();
    const bridge = {
      requestDevice: async (deviceId, path, body) => {
        assert.equal(deviceId, 'example-mac');
        assert.equal(path, '/api/session/list');
        assert.equal(body.method, 'session/list');
        return {
          type: 'server-response',
          rpcId: body.rpcId,
          result: {
            ok: true,
            value: {
              items: [
                {
                  sessionId: 'session-mac-ok',
                  blank: false,
                  running: false,
                  updatedAt: 1792921075363,
                  cwd: '/Users/someone/Documents/deepseek-harness/default-workspace',
                  projections: {
                    values: {
                      title: '回复 OK',
                      sessionListMetadata: { blank: false, lastPromptAt: 1792921075363 },
                      turnOutline: [{ prompt: '回复我 OK', response: 'OK', seq: 4, turn: 1 }],
                    },
                  },
                },
                {
                  sessionId: 'session-mac-blank',
                  blank: true,
                  running: false,
                  updatedAt: 1792921064932,
                  cwd: '/Users/someone/Projects/AuOS/DemoApp',
                },
              ],
            },
          },
        };
      },
    };
    const remoteCards = await fetchRemoteNativeSessions(
      bridge,
      { deviceId: 'example-mac', name: 'example-mac', status: 'done' },
      remoteStates,
    );
    assert.equal(remoteCards.length, 1);
    assert.equal(remoteCards[0].sessionId, 'session-mac-ok');
    assert.equal(remoteCards[0].title, '回复 OK');
    assert.equal(remoteCards[0].summary, 'OK');
    assert.equal(remoteCards[0].workspace, 'default-workspace');
    assert.equal(remoteCards[0].deviceId, 'example-mac');
    assert.equal(remoteCards[0].deviceName, 'example-mac');
    assert.equal(remoteCards[0].isLocal, false);
    assert.equal(remoteCards[0].status, 'done');
  } finally {
    delete process.env.DSH_AU_TODO_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fetchRemoteNativeSessions uses the remote per-session lights when the device publishes them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-todo-'));
  process.env.DSH_AU_TODO_PATH = join(dir, 'dsh-au-todo.json');
  try {
    const item = (sessionId, title) => ({
      sessionId, blank: false, running: false, updatedAt: 1,
      projections: { values: { title, turnOutline: [{ prompt: title, response: 'x', seq: 1, turn: 1 }] } },
    });
    const bridge = {
      requestDevice: async (_deviceId, _path, body) => ({
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: true, value: { items: [item('s-first', '第一'), item('s-wait', '等审批'), item('s-err', '出错'), item('s-done', '完成')] } },
      }),
    };
    const states = new Map();
    // 设备整机是 done，但逐会话灯色明确：不再只有列表第一条能变蓝。
    const device = {
      deviceId: 'example-mac', name: 'example-mac', status: 'done',
      sessionStatesV2: { 's-first': 'idle', 's-wait': 'waiting', 's-err': 'error', 's-done': 'done' },
    };
    const byId = (cards) => Object.fromEntries(cards.map((card) => [card.sessionId, card.status]));
    assert.deepEqual(byId(await fetchRemoteNativeSessions(bridge, device, states)), {
      's-first': 'idle', 's-wait': 'waiting', 's-err': 'error', 's-done': 'done',
    });
    // 本机只记录已读；远端灯色再次变化为 busy 后会重新亮起。
    states.set('example-mac:s-done', { status: 'done', acknowledged: true });
    assert.equal(byId(await fetchRemoteNativeSessions(bridge, device, states))['s-done'], 'idle');
    device.sessionStatesV2['s-done'] = 'busy';
    assert.equal(byId(await fetchRemoteNativeSessions(bridge, device, states))['s-done'], 'busy');
    device.sessionStatesV2['s-done'] = 'done';
    assert.equal(byId(await fetchRemoteNativeSessions(bridge, device, states))['s-done'], 'done');
  } finally {
    delete process.env.DSH_AU_TODO_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('blank untitled conversations are filtered but keep cards with summary, todos, pin or running state', () => {
  assert.equal(isBlankTodoCard({ title: '未命名对话', status: 'waiting' }), false);
  assert.equal(isBlankTodoCard({ title: '未命名对话', status: 'done' }), false);
  assert.equal(isBlankTodoCard({ title: '未命名对话', status: 'error' }), false);
  assert.equal(isBlankTodoCard({ title: '未命名对话', summary: '', todos: [] }), true);
  assert.equal(isBlankTodoCard({ title: '', summary: '  ' }), true);
  assert.equal(isBlankTodoCard({ title: '未命名对话', summary: '有内容' }), false);
  assert.equal(isBlankTodoCard({ title: '未命名对话', todos: [{ id: '1', text: 'x' }] }), false);
  assert.equal(isBlankTodoCard({ title: '未命名对话', pinned: true }), false);
  assert.equal(isBlankTodoCard({ title: '未命名对话', status: 'busy' }), false);
  assert.equal(isBlankTodoCard({ title: '修复按钮', summary: '' }), false);
  const clientSrc = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  assert.match(clientSrc, /className: 'dsh-au-todo-loading'/);
  assert.match(clientSrc, /@keyframes dsh-au-todo-spin/);
  assert.match(clientSrc, /finally \{\s*setLoading\(false\);/);
});

function createRouteHarness() {
  let handler = null;
  let registered = 0;
  const server = { register: (route) => { registered += 1; handler = route.handler; return () => { handler = null; }; } };
  const call = async (action = 'getState') => {
    const req = new (await import('node:stream')).PassThrough();
    req.method = 'POST';
    const res = { status: 0, body: '', writeHead(status) { this.status = status; }, end(text) { this.body = text; } };
    const pending = handler(req, res);
    req.end(JSON.stringify({ action }));
    await pending;
    return { status: res.status, json: JSON.parse(res.body) };
  };
  return { server, call, isRegistered: () => handler !== null, registeredCount: () => registered };
}

test('registerTodoRoutes serves getState through the in-process bridge, answers 404 when disabled, and releases the lock on dispose', async () => {
  const { registerTodoRoutes } = await import('../lib/todo/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-todo-'));
  process.env.DSH_AU_TODO_PATH = join(dir, 'dsh-au-todo.json');
  delete globalThis.__dshAuTodoApplyActive;
  const harness = createRouteHarness();
  let enabled = true;
  const bridge = {
    version: 1,
    getLocalDevice: () => ({ deviceId: 'local-1', name: 'win' }),
    listLocalSessions: async () => [{ sessionId: 's1', title: '修复按钮', summary: '有内容', updatedAt: recentAt }],
    getDevices: async () => [],
  };
  const dispose = registerTodoRoutes({ server: harness.server, bridge, isEnabled: () => enabled });
  try {
    const ready = await harness.call();
    assert.equal(ready.status, 200);
    assert.deepEqual(ready.json.cards.map((card) => card.sessionId), ['s1']);
    enabled = false;
    const off = await harness.call();
    assert.equal(off.status, 404);
    assert.equal(off.json.ok, false);
    enabled = true;
    assert.equal((await harness.call()).status, 200);
  } finally {
    dispose();
    assert.equal(harness.isRegistered(), false);
    assert.equal(globalThis.__dshAuTodoApplyActive, undefined);
    delete process.env.DSH_AU_TODO_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registerTodoRoutes skips registration while a legacy dsh-au-todo holds the lock and never releases that lock', async () => {
  const { registerTodoRoutes } = await import('../lib/todo/index.js');
  const harness = createRouteHarness();
  globalThis.__dshAuTodoApplyActive = true;
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const dispose = registerTodoRoutes({ server: harness.server, bridge: {} });
    assert.equal(harness.registeredCount(), 0);
    dispose();
    assert.equal(globalThis.__dshAuTodoApplyActive, true);
  } finally {
    console.warn = originalWarn;
    delete globalThis.__dshAuTodoApplyActive;
  }
});

test('cross-device confirmSession normalizes remote deviceId to local, refreshes remote probe, and hideSession confirms local session', async () => {
  const { registerTodoRoutes } = await import('../lib/todo/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-todo-'));
  process.env.DSH_AU_TODO_PATH = join(dir, 'dsh-au-todo.json');
  delete globalThis.__dshAuTodoApplyActive;
  let handler = null;
  const server = { register: (route) => { handler = route.handler; return () => { handler = null; }; } };
  const call = async (payload) => {
    const req = new (await import('node:stream')).PassThrough();
    req.method = 'POST';
    const res = { status: 0, body: '', writeHead(status) { this.status = status; }, end(text) { this.body = text; } };
    const pending = handler(req, res);
    req.end(JSON.stringify(payload));
    await pending;
    return { status: res.status, json: JSON.parse(res.body) };
  };
  const forwardedCalls = [];
  const refreshedDevices = [];
  const confirmedLocalSessions = [];
  const bridge = {
    version: 1,
    getLocalDevice: () => ({ deviceId: 'device_local', name: '本机' }),
    listLocalSessions: async () => [{ sessionId: 's-local', title: '本机任务', summary: 'ok', status: 'done', updatedAt: 1 }],
    getDevices: async () => [{ deviceId: 'example-mac', name: 'mac', status: 'done', sessionStatesV2: { 's-mac': 'done' } }],
    confirmSession: (sessionId) => {
      confirmedLocalSessions.push(sessionId);
      return { ok: true };
    },
    refreshDevice: async (deviceId) => {
      refreshedDevices.push(deviceId);
      return { ok: true };
    },
    requestDevice: async (deviceId, path, body) => {
      forwardedCalls.push({ deviceId, path, body });
      return { ok: true };
    },
  };
  const dispose = registerTodoRoutes({ server, bridge, isEnabled: () => true });
  try {
    const remoteConfirm = await call({ action: 'confirmSession', deviceId: 'example-mac', sessionId: 's-mac' });
    assert.equal(remoteConfirm.status, 200);
    assert.equal(forwardedCalls.length, 1);
    assert.equal(forwardedCalls[0].deviceId, 'example-mac');
    assert.equal(forwardedCalls[0].path, '/dsh-au-todo/api');
    assert.equal(forwardedCalls[0].body.deviceId, 'local');
    assert.equal(forwardedCalls[0].body.sessionId, 's-mac');
    assert.deepEqual(refreshedDevices, ['example-mac']);

    const localHide = await call({ action: 'hideSession', deviceId: 'local', sessionId: 's-local' });
    assert.equal(localHide.status, 200);
    assert.deepEqual(confirmedLocalSessions, ['s-local']);
  } finally {
    dispose();
    delete process.env.DSH_AU_TODO_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sortTodoCards orders priority -> pin -> error/waiting/done -> busy -> idle, and getState supplements recent remote active sessions', async () => {
  const mixed = [
    { sessionId: 'idle-newest', status: 'idle', priority: 'P2', sortOrder: -999, updatedAt: 999 },
    { sessionId: 'idle-with-todo', status: 'idle', priority: 'P2', sortOrder: -100, updatedAt: 100, todos: [{ id: '1', text: '继续' }] },
    { sessionId: 'busy-win', status: 'busy', priority: 'P2', sortOrder: -10, updatedAt: 10 },
    { sessionId: 'done-win', status: 'done', priority: 'P2', sortOrder: -5, updatedAt: 5 },
    { sessionId: 'waiting-mac', status: 'waiting', priority: 'P2', sortOrder: -3, updatedAt: 3 },
    { sessionId: 'error-local', status: 'error', priority: 'P2', sortOrder: -1, updatedAt: 1 },
    { sessionId: 'pinned-idle', status: 'idle', pinned: true, priority: 'P3', sortOrder: -1, updatedAt: 1 },
  ];
  assert.deepEqual(sortTodoCards(mixed).map((c) => c.sessionId), [
    'error-local',
    'waiting-mac',
    'done-win',
    'busy-win',
    'idle-with-todo',
    'idle-newest',
    'pinned-idle',
  ]);

  const { registerTodoRoutes } = await import('../lib/todo/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-todo-'));
  process.env.DSH_AU_TODO_PATH = join(dir, 'dsh-au-todo.json');
  delete globalThis.__dshAuTodoApplyActive;
  const harness = createRouteHarness();
  const bridge = {
    version: 1,
    getLocalDevice: () => ({ deviceId: 'local-1', name: '本机' }),
    listLocalSessions: async () => [{ sessionId: 's-local-idle', title: '本机历史', summary: 'x', status: 'idle', updatedAt: recentAt }],
    getDevices: async () => [{
      deviceId: 'win',
      name: 'win',
      status: 'busy',
      statusV2: 'busy',
      sessionStatesV2: { 's-win-truncated': 'done', 's-win-old': 'idle' },
    }],
    requestDevice: async (_deviceId, path, body) => {
      if (path === '/dsh-au-todo/api') {
        return {
          ok: true,
          cards: [{ sessionId: 's-win-old', title: '旧会话', summary: 'old', status: 'idle', priority: 'P2', sortOrder: -100, updatedAt: recentAt }],
        };
      }
      if (path === '/api/session/list') {
        return {
          type: 'server-response',
          rpcId: body.rpcId,
          result: {
            ok: true,
            value: {
              items: [
                {
                  sessionId: 's-win-running',
                  running: true,
                  blank: false,
                  updatedAt: recentAt,
                  projections: { values: { title: 'win正在执行', turnOutline: [{ prompt: 'p', response: 'r' }] } },
                },
                {
                  sessionId: 's-win-truncated',
                  running: false,
                  blank: false,
                  updatedAt: recentAt,
                  projections: { values: { title: 'win被截断的完成会话', turnOutline: [{ prompt: 'p', response: 'r' }] } },
                },
              ],
            },
          },
        };
      }
      return { ok: false };
    },
  };
  const dispose = registerTodoRoutes({ server: harness.server, bridge, isEnabled: () => true });
  try {
    const res = await harness.call('getState');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.cards.map((c) => `${c.sessionId}:${c.status}`), [
      's-win-old:idle',
      's-win-truncated:done',
      's-win-running:busy',
      's-local-idle:idle',
    ]);
  } finally {
    dispose();
    delete process.env.DSH_AU_TODO_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runtimeBridge sendTodo deduplicates accepted requestId, flushes session, and interruptSession cancels active agent', async () => {
  const { createRuntimeBridge } = await import('../lib/runtime-bridge.js');
  const { hasSessionAcceptedMessage } = await import('../lib/session-reader.js');
  const sentMessages = [];
  const flushedSessions = [];
  const cancelCalls = [];
  const liveEvents = [];

  const liveSession = {
    sessionId: 's-1',
    snapshotEvents: () => liveEvents,
  };
  const agent = {
    session: liveSession,
    followup(message) {
      sentMessages.push(message);
      liveEvents.push({
        type: 'user/message',
        payload: {
          message: {
            id: message.id,
            source: message.source,
          },
        },
      });
    },
    async cancel(reason) {
      cancelCalls.push(reason);
    },
  };
  const ctx = {
    sessionController: {
      resolveAgent: async (id) => (id === 's-1' ? { agent } : null),
    },
    sessions: {
      load: async () => liveSession,
      flush: async (s) => {
        flushedSessions.push(s.sessionId);
      },
    },
    agents: {
      get: (id) => (id === 's-1' ? agent : null),
      list: () => [agent],
    },
  };

  const bridge = createRuntimeBridge({
    ctx,
    getConfig: () => ({}),
    getLocalHostInfo: () => ({ hostname: 'win', ips: [] }),
  });

  const first = await bridge.sendTodo('s-1', '请继续验证', { requestId: 'todo-99' });
  assert.equal(first.ok, true);
  assert.equal(first.deduplicated, undefined);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].id, 'dsh-au-todo:s-1:todo-99');
  assert.equal(sentMessages[0].source?.rpcId, 'dsh-au-todo:s-1:todo-99');
  assert.deepEqual(flushedSessions, ['s-1']);
  assert.equal(await hasSessionAcceptedMessage(ctx, 's-1', 'dsh-au-todo:s-1:todo-99', liveSession), true);

  const duplicate = await bridge.sendTodo('s-1', '请继续验证', { requestId: 'todo-99' });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.deduplicated, true);
  assert.equal(sentMessages.length, 1);

  const interrupted = await bridge.interruptSession('s-1');
  assert.equal(interrupted.ok, true);
  assert.deepEqual(cancelCalls, [{ kind: 'user' }]);
});

test('registerTodoRoutes supports local/remote interruptSession with 404 native cancel fallback and passes requestId in sendNextTodo', async () => {
  const { registerTodoRoutes } = await import('../lib/todo/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-todo-'));
  process.env.DSH_AU_TODO_PATH = join(dir, 'dsh-au-todo.json');
  delete globalThis.__dshAuTodoApplyActive;
  let handler = null;
  const server = { register: (route) => { handler = route.handler; return () => { handler = null; }; } };
  const call = async (payload) => {
    const req = new (await import('node:stream')).PassThrough();
    req.method = 'POST';
    const res = { status: 0, body: '', writeHead(status) { this.status = status; }, end(text) { this.body = text; } };
    const pending = handler(req, res);
    req.end(JSON.stringify(payload));
    await pending;
    return { status: res.status, json: JSON.parse(res.body) };
  };

  const sentTodos = [];
  const interruptedLocal = [];
  const remoteRequests = [];
  const refreshed = [];
  const bridge = {
    version: 1,
    getLocalDevice: () => ({ deviceId: 'local-dev', name: '本机' }),
    listLocalSessions: async () => [{ sessionId: 's-1', title: '任务1', summary: 'ok', status: 'done', updatedAt: 1 }],
    getDevices: async () => [],
    sendTodo: async (sessionId, text, options) => {
      sentTodos.push({ sessionId, text, options });
      return { ok: true };
    },
    interruptSession: async (sessionId) => {
      interruptedLocal.push(sessionId);
      return { ok: true, sessionId };
    },
    refreshDevice: async (deviceId) => {
      refreshed.push(deviceId);
    },
    requestDevice: async (deviceId, path, body) => {
      remoteRequests.push({ deviceId, path, body });
      if (path === '/dsh-au-todo/api') {
        return { ok: false, httpStatus: 404, error: 'HTTP 404' };
      }
      if (path === '/api/session/cancel') {
        return { type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { cancelled: true } } };
      }
      return { ok: false };
    },
  };

  const dispose = registerTodoRoutes({ server, bridge, isEnabled: () => true });
  try {
    const added = await call({ action: 'appendTodo', deviceId: 'local', sessionId: 's-1', text: '修复防重' });
    const todoId = added.json.todo.id;
    const sent = await call({ action: 'sendNextTodo', deviceId: 'local', sessionId: 's-1' });
    assert.equal(sent.json.ok, true);
    assert.equal(sentTodos.length, 1);
    assert.deepEqual(sentTodos[0], {
      sessionId: 's-1',
      text: '修复防重',
      options: { requestId: todoId },
    });

    const localStop = await call({ action: 'interruptSession', deviceId: 'local', sessionId: 's-1' });
    assert.equal(localStop.json.ok, true);
    assert.deepEqual(interruptedLocal, ['s-1']);

    const remoteStop = await call({ action: 'interruptSession', deviceId: 'example-mac', sessionId: 's-remote' });
    assert.equal(remoteStop.json.ok, true);
    assert.deepEqual(remoteRequests.map((item) => item.path), ['/dsh-au-todo/api', '/api/session/cancel']);
    assert.deepEqual(refreshed, ['example-mac']);
  } finally {
    dispose();
    delete process.env.DSH_AU_TODO_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('client bundle supports snap.current + get() in selectedSessionSource and renders interruptSession stop button for busy/waiting cards', () => {
  const clientCode = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  assert.match(clientCode, /snap\.current/);
  assert.match(clientCode, /get:\s*getSnapshot/);
  assert.match(clientCode, /callApi\('interruptSession'/);
  assert.match(clientCode, /dsh-au-todo-btn interrupt/);
});

test('savePriority and sortTodoCards support priorities from P0 through P8', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-todo-p8-'));
  process.env.DSH_AU_TODO_PATH = join(dir, 'todo.json');
  try {
    const { savePriority } = await import('../lib/todo/todo-store.js');
    const { sortTodoCards } = await import('../lib/todo/index.js');

    // 1. 测试各级别有效保存
    for (let i = 0; i <= 8; i++) {
      const res = savePriority(`sess-${i}`, `P${i}`);
      assert.equal(res.ok, true, `P${i} must be valid priority`);
    }
    const invalid = savePriority('sess-bad', 'P9');
    assert.equal(invalid.ok, false);

    // 2. 测试排序权重：P0 高于 P2 高于 P5 高于 P8
    const cards = [
      { sessionId: 's8', priority: 'P8', sortOrder: 0, updatedAt: 10 },
      { sessionId: 's0', priority: 'P0', sortOrder: 0, updatedAt: 10 },
      { sessionId: 's5', priority: 'P5', sortOrder: 0, updatedAt: 10 },
      { sessionId: 's2', priority: 'P2', sortOrder: 0, updatedAt: 10 },
    ];
    const sorted = sortTodoCards(cards);
    assert.deepEqual(sorted.map((c) => c.sessionId), ['s0', 's2', 's5', 's8']);

    // 3. 测试新会话与未记录优先级默认回退到 P4
    const { applyTodoMetadata } = await import('../lib/todo/todo-store.js');
    const defaultCards = applyTodoMetadata([{ sessionId: 'brand-new-card', updatedAt: 10 }]);
    assert.equal(defaultCards[0].priority, 'P4', 'new cards must default to priority P4');
  } finally {
    delete process.env.DSH_AU_TODO_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('global waiting session cycle service runs independently when Todo panel is never opened or features are unmounted', async () => {
  const { outFile } = await import('../scripts/build-client.js');
  const code = readFileSync(outFile, 'utf8');
  let captured = null;
  const dispatchedEvents = [];
  const win = {
    name: '',
    innerWidth: 1280,
    innerHeight: 800,
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', maxTouchPoints: 0 },
    location: { href: 'http://127.0.0.1:8722/' },
    dispatchedEvents,
    addEventListener(type, handler) {
      if (!this._listeners) this._listeners = {};
      if (!this._listeners[type]) this._listeners[type] = [];
      this._listeners[type].push(handler);
    },
    removeEventListener() {},
    dispatchEvent(ev) {
      dispatchedEvents.push(ev);
    },
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    __ModuleLoader__: {
      load(def) {
        captured = def;
      },
    },
  };
  const fakeReact = {
    createElement: (type, props, children) => ({ type, props: { ...(props || {}), children } }),
    Fragment: 'Fragment',
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (val) => ({ current: val }),
  };
  const fakeReactDom = {
    createPortal: (child, container) => ({ portal: child, container }),
    render: () => {},
    unmountComponentAtNode: () => {},
  };
  new Function('window', 'document', 'navigator', 'localStorage', code)(
    win,
    { documentElement: { setAttribute() {}, getAttribute: () => null }, head: { appendChild() {} }, querySelector: () => null, querySelectorAll: () => [] },
    win.navigator,
    { getItem: () => null, setItem() {}, removeItem() {} },
  );
  const plugin = captured.factory((id) => {
    if (id === 'react') return fakeReact;
    if (id === 'react-dom') return fakeReactDom;
    throw new Error(`unexpected require: ${id}`);
  });

  assert.ok(plugin.apply.todo, 'apply.todo must export helpers');
  assert.equal(typeof plugin.apply.todo.cycleWaitingSessionGlobal, 'function', 'must export cycleWaitingSessionGlobal');
  assert.equal(typeof plugin.apply.todo.syncGlobalCards, 'function', 'must export syncGlobalCards');
});

test('offline or timed-out remote devices are skipped without double native fallback, and local deviceId never resolves a Lan badge', async () => {
  const { registerTodoRoutes } = await import('../lib/todo/index.js');
  const { listConversationSummaries } = await import('../lib/session-reader.js');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-todo-offline-'));
  process.env.DSH_AU_TODO_PATH = join(dir, 'dsh-au-todo.json');
  delete globalThis.__dshAuTodoApplyActive;
  const harness = createRouteHarness();
  const requested = [];
  const bridge = {
    version: 1,
    getLocalDevice: () => ({ deviceId: 'win', name: 'MyHost' }),
    listLocalSessions: async () => [],
    getDevices: async () => [
      { deviceId: 'yoga-offline', name: 'yoga', online: false, status: 'offline' },
      { deviceId: 'yoga-timeout', name: 'yoga2', online: true, status: 'unknown' },
    ],
    requestDevice: async (deviceId, path) => {
      requested.push(`${deviceId}:${path}`);
      return { ok: false, error: '局域网请求超时' };
    },
  };
  const dispose = registerTodoRoutes({ server: harness.server, bridge, isEnabled: () => true });
  try {
    const res = await harness.call('getState');
    assert.equal(res.status, 200);
    // yoga-offline 直接跳过；yoga-timeout 在 getLocalSessions 超时后不再二次请求 /api/session/list
    assert.deepEqual(requested, ['yoga-timeout:/dsh-au-todo/api']);

    // 验证 session-reader 仅将 source.kind === 'user' 记入 lastUserMessageAt，忽略 dsh-continue 自动续跑消息
    const ctx = {
      get: (key) => key === 'sessionQuery'
        ? {
            listSessions: async () => [{ header: { id: 's-cont', title: '自动续跑会话' } }],
            observeSession: async () => ({
              events: [
                { type: 'user/message', time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '人工提问' }] } },
                { type: 'user/message', time: 5000, data: { source: { kind: 'dsh-continue' }, content: [{ type: 'text', text: '继续' }] } },
              ],
            }),
          }
        : null,
    };
    const summaries = await listConversationSummaries(ctx, null);
    assert.equal(summaries[0].updatedAt, 5000);
    assert.equal(summaries[0].lastUserMessageAt, 1000);
  } finally {
    dispose();
    delete process.env.DSH_AU_TODO_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collectRemoteCardsAndWorkspaces does not synthesize extra workspaces from orphan cards when remote returns non-empty workspaces, and falls back only when workspaces is empty', async () => {
  const { registerTodoRoutes } = await import('../lib/todo/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-todo-ws-align-'));
  process.env.DSH_AU_TODO_PATH = join(dir, 'dsh-au-todo.json');
  delete globalThis.__dshAuTodoApplyActive;
  const harness = createRouteHarness();
  const bridge = {
    version: 1,
    getLocalDevice: () => ({ deviceId: 'local-dev', name: '本机' }),
    listLocalSessions: async () => [],
    listLocalWorkspaces: async () => [],
    getDevices: async () => [
      { deviceId: 'peer-with-ws', name: 'MacBook', online: true },
      { deviceId: 'peer-empty-ws', name: 'LegacyBox', online: true },
    ],
    requestDevice: async (deviceId, path) => {
      if (deviceId === 'peer-with-ws' && path === '/dsh-au-todo/api') {
        return {
          ok: true,
          cards: [
            { sessionId: 's-match', title: '匹配已有路径', summary: 'ok', cwd: '/Users/mac/DemoApp', updatedAt: recentAt, status: 'idle' },
            { sessionId: 's-orphan-tmp', title: '临时目录游离会话', summary: 'tmp', cwd: '/tmp/dsh-cursor-acp-verify-999', updatedAt: recentAt, status: 'busy' },
          ],
          workspaces: [
            {
              workspaceId: 'ws-real-mac',
              title: 'DemoApp',
              path: '/Users/mac/DemoApp',
              updatedAt: 1000,
              sessions: [],
            },
          ],
        };
      }
      if (deviceId === 'peer-empty-ws' && path === '/dsh-au-todo/api') {
        return {
          ok: true,
          cards: [
            { sessionId: 's-legacy-1', title: '空工作区回退会话', summary: 'legacy', cwd: 'D:/LegacyApp', updatedAt: recentAt, status: 'idle' },
          ],
          workspaces: [],
        };
      }
      return { ok: false, httpStatus: 404 };
    },
  };
  const dispose = registerTodoRoutes({ server: harness.server, bridge, isEnabled: () => true });
  try {
    const res = await harness.call('getState');
    assert.equal(res.status, 200);
    const macWorkspaces = res.json.remoteWorkspaces.filter((w) => w.deviceId === 'peer-with-ws');
    assert.equal(macWorkspaces.length, 1, 'must strictly return registered workspaces without synthesizing extra cwd workspaces');
    assert.equal(macWorkspaces[0].workspaceId, 'ws-real-mac');
    assert.deepEqual(macWorkspaces[0].sessions.map((s) => s.sessionId), ['s-match']);

    const legacyWorkspaces = res.json.remoteWorkspaces.filter((w) => w.deviceId === 'peer-empty-ws');
    assert.equal(legacyWorkspaces.length, 1, 'empty remote workspaces array should fall back to synthesizeWorkspacesFromCards');
    assert.equal(legacyWorkspaces[0].title, 'LegacyApp');
    assert.deepEqual(legacyWorkspaces[0].sessions.map((s) => s.sessionId), ['s-legacy-1']);
  } finally {
    dispose();
    delete process.env.DSH_AU_TODO_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});


