import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../client/src/10c-remote-session-preload.js'), 'utf8');

function load({ window = {}, fetch = async () => ({ ok: true, text: async () => '{}' }), now = 1_000_000 } = {}) {
  class ClockDate extends Date { static now() { return now; } }
  return new Function('window', 'fetch', 'Date', 'CONTROLLED_FRAME_NAME_PREFIX', `${source}\nreturn { REMOTE_SESSION_PRELOAD_WINDOW_MS, REMOTE_SESSION_OPEN_STALL_MS, collectRecentRemoteSessions, createRemoteSessionPreloadCoordinator, installControlledSessionPreload, installSessionInstantOpenHook, warmClientSessionWindow };`)(
    window, fetch, ClockDate, 'dsh-au-controlled:'
  );
}

function scheduler(initial = 1_000_000) {
  let now = initial;
  let id = 0;
  const timers = new Map();
  const setTimer = (fn, delay) => { const key = ++id; timers.set(key, { fn, at: now + delay }); return key; };
  const clearTimer = (key) => timers.delete(key);
  const advance = async (ms) => {
    const target = now + ms;
    while (true) {
      const next = [...timers.entries()].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
      await Promise.resolve();
    }
    now = target;
    await Promise.resolve();
  };
  return { now: () => now, setTimer, clearTimer, advance, timers };
}

function frame() {
  return { contentWindow: { messages: [], postMessage(message) { this.messages.push(message); } } };
}

test('recent-session collection uses exact 48-hour activity boundary and newest device/session order', () => {
  const now = 10_000_000;
  const { REMOTE_SESSION_PRELOAD_WINDOW_MS, collectRecentRemoteSessions } = load({ now });
  const workspaces = [
    { deviceId: 'local-device', online: true, sessions: [{ id: 'local', updatedAt: now }] },
    { deviceId: 'hidden', online: true, hidden: true, sessions: [{ id: 'hidden-session', updatedAt: now }] },
    { deviceId: 'offline', online: false, sessions: [{ id: 'offline-session', updatedAt: now }] },
    { deviceId: 'remote-a', online: true, sessions: [
      { id: 'same', updatedAt: now - 5 }, { id: 'same', updatedAt: now - 50, pinned: true },
      { id: 'pinned-old', updatedAt: now - 100, pinned: true, status: 'busy' },
      { id: 'exact-boundary', updatedAt: now - REMOTE_SESSION_PRELOAD_WINDOW_MS },
      { id: 'too-old', updatedAt: now - REMOTE_SESSION_PRELOAD_WINDOW_MS - 1 }, { id: 'future', updatedAt: now + 1 },
      { id: 'created-only', createdAt: now - 1 }, { id: 'blank', updatedAt: now - 2, blank: true },
      { id: 'archived', updatedAt: now - 2, archived: true },
    ] },
    { deviceId: 'remote-b', online: true, sessions: [{ id: 'newest', updatedAt: now - 1, status: 'busy' }] },
  ];
  assert.deepEqual(collectRecentRemoteSessions(workspaces, { now, localDeviceId: 'local-device' }), [
    { deviceId: 'remote-b', sessionId: 'newest', updatedAt: now - 1 },
    { deviceId: 'remote-a', sessionId: 'same', updatedAt: now - 5 },
    { deviceId: 'remote-a', sessionId: 'pinned-old', updatedAt: now - 100 },
    { deviceId: 'remote-a', sessionId: 'exact-boundary', updatedAt: now - REMOTE_SESSION_PRELOAD_WINDOW_MS },
  ]);
});

test('coordinator serializes latest-first loads, accepts only matching frame replies, and does not repeat successes', async () => {
  const clock = scheduler();
  const frames = { alpha: frame(), beta: frame() };
  const requested = [];
  const coordinator = load().createRemoteSessionPreloadCoordinator({
    findFrame: (deviceId) => frames[deviceId], requestDevicePreload: (deviceIds) => requested.push([...deviceIds]),
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  coordinator.updatePlan([{ deviceId: 'alpha', sessionId: 'old', updatedAt: 999_900 }, { deviceId: 'beta', sessionId: 'latest', updatedAt: 999_999 }]);
  assert.deepEqual(requested, [['beta', 'alpha']]);
  assert.deepEqual(frames.beta.contentWindow.messages, []);
  assert.equal(coordinator.handleMessage({ source: {}, data: { source: 'dsh-au', type: 'frame-ready' } }), false);
  coordinator.handleMessage({ source: frames.beta.contentWindow, data: { source: 'dsh-au', type: 'frame-ready' } });
  const first = frames.beta.contentWindow.messages[0];
  assert.equal(first.type, 'dsh-au:session-preload-request');
  assert.equal(coordinator.handleMessage({ source: frames.alpha.contentWindow, data: { ...first, source: 'dsh-au', type: 'dsh-au:session-preload-ready' } }), false);
  coordinator.handleMessage({ source: frames.beta.contentWindow, data: { ...first, source: 'dsh-au', type: 'dsh-au:session-preload-ready' } });
  coordinator.handleMessage({ source: frames.alpha.contentWindow, data: { source: 'dsh-au', type: 'frame-loaded' } });
  assert.equal(frames.alpha.contentWindow.messages.length, 1);
  const second = frames.alpha.contentWindow.messages[0];
  coordinator.handleMessage({ source: frames.alpha.contentWindow, data: { ...second, source: 'dsh-au', type: 'dsh-au:session-preload-ready' } });
  coordinator.updatePlan([{ deviceId: 'alpha', sessionId: 'old', updatedAt: 999_900 }, { deviceId: 'beta', sessionId: 'latest', updatedAt: 999_999 }]);
  await clock.advance(60_000);
  assert.equal(frames.beta.contentWindow.messages.filter((m) => m.type.endsWith('request')).length, 1);
  assert.equal(frames.alpha.contentWindow.messages.filter((m) => m.type.endsWith('request')).length, 1);
  coordinator.dispose();
  assert.ok(frames.alpha.contentWindow.messages.some((m) => m.type.endsWith('prune')));
});

test('pre-plan controlled snapshots make a retained exact frame ready when the plan arrives later', () => {
  const clock = scheduler();
  const remote = frame();
  const coordinator = load().createRemoteSessionPreloadCoordinator({
    findFrame: () => remote, requestDevicePreload: () => {}, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  assert.equal(coordinator.handleMessage({ source: remote.contentWindow, data: { source: 'dsh-au', type: 'dsh-au:controlled-workspaces-snapshot' } }), true);
  coordinator.updatePlan([{ deviceId: 'remote', sessionId: 'retained', updatedAt: 999_999 }]);
  assert.equal(remote.contentWindow.messages[0].type, 'dsh-au:session-preload-request');
  coordinator.dispose();
});

test('coordinator re-emits a plan while its hidden frame is still missing', () => {
  let currentFrame = null;
  const requested = [];
  const coordinator = load().createRemoteSessionPreloadCoordinator({
    findFrame: () => currentFrame, requestDevicePreload: (ids) => requested.push(ids),
  });
  const plan = [{ deviceId: 'remote', sessionId: 'session', updatedAt: 999_999 }];
  coordinator.updatePlan(plan);
  coordinator.updatePlan(plan);
  assert.equal(requested.length, 2);
  currentFrame = frame();
  coordinator.updatePlan(plan);
  assert.equal(requested.length, 2);
  coordinator.dispose();
});

test('coordinator timeout cancels the receiver before periodic retry can issue a new request', async () => {
  const clock = scheduler();
  const remote = frame();
  const coordinator = load().createRemoteSessionPreloadCoordinator({ findFrame: () => remote, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  coordinator.updatePlan([{ deviceId: 'remote', sessionId: 'background', updatedAt: 999_999 }]);
  coordinator.handleMessage({ source: remote.contentWindow, data: { source: 'dsh-au', type: 'frame-loaded' } });
  assert.equal(remote.contentWindow.messages.filter((m) => m.type.endsWith('request')).length, 1);
  await clock.advance(12_000);
  assert.equal(remote.contentWindow.messages.at(-1).type, 'dsh-au:session-preload-cancel');
  await clock.advance(5_999);
  assert.equal(remote.contentWindow.messages.filter((m) => m.type.endsWith('request')).length, 1);
  await clock.advance(1);
  assert.equal(remote.contentWindow.messages.filter((m) => m.type.endsWith('request')).length, 2);
  coordinator.dispose();
});

test('coordinator pauses for foreground use and prunes removed plans', async () => {
  const clock = scheduler();
  const remote = frame();
  const coordinator = load().createRemoteSessionPreloadCoordinator({ findFrame: () => remote, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  coordinator.updatePlan([{ deviceId: 'remote', sessionId: 'background', updatedAt: 999_999 }]);
  coordinator.handleMessage({ source: remote.contentWindow, data: { source: 'dsh-au', type: 'frame-loaded' } });
  coordinator.notifyForeground('local', 'foreground-session');
  assert.equal(remote.contentWindow.messages.at(-1).type, 'dsh-au:session-preload-cancel');
  await clock.advance(1_000);
  assert.equal(remote.contentWindow.messages.filter((m) => m.type.endsWith('request')).length, 2);
  coordinator.updatePlan([]);
  assert.ok(remote.contentWindow.messages.some((m) => m.type.endsWith('prune')));
  coordinator.dispose();
});

function receiverBrowser(now = 1_000_000) {
  const listeners = new Set();
  const parent = { messages: [], postMessage(message) { this.messages.push(message); } };
  const window = { name: 'dsh-au-controlled:remote', parent,
    addEventListener(type, listener) { if (type === 'message') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener); },
    emit(event) { for (const listener of [...listeners]) listener(event); } };
  const requests = [];
  const sessions = { list: { getSnapshot: () => ({ byId: {
    ready: { id: 'ready', updatedAt: now - 10 }, boundary: { id: 'boundary', updatedAt: now - 48 * 60 * 60 * 1000 }, stale: { id: 'stale', createdAt: now - 10 },
  } }) } };
  const ctx = { get(name) { return name === 'sessions' ? sessions : undefined; } };
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    return { ok: true, status: 200, text: async () => JSON.stringify(body.action === 'preloadSession'
      ? { ok: true, result: 'ready', sessionId: body.sessionId, updatedAt: body.updatedAt } : { ok: true }) };
  };
  return { window, parent, requests, ctx, fetch, emit(data, source = parent) { window.emit({ source, data }); } };
}

test('controlled receiver validates parent/catalog, uses HOST API, preserves TTL equality, and releases leases', async () => {
  const env = receiverBrowser();
  const client = load({ window: env.window, fetch: env.fetch });
  const dispose = client.installControlledSessionPreload(env.ctx);
  env.emit({ source: 'dsh-au', type: 'dsh-au:session-preload-request', deviceId: 'remote', sessionId: 'ready', requestId: 'bad', updatedAt: 999_990 }, {});
  env.emit({ source: 'dsh-au', type: 'dsh-au:session-preload-request', deviceId: 'remote', sessionId: 'stale', requestId: 'stale', updatedAt: 999_990 });
  env.emit({ source: 'dsh-au', type: 'dsh-au:session-preload-request', deviceId: 'remote', sessionId: 'ready', requestId: 'r1', updatedAt: 999_990 });
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.deepEqual(env.requests.map((request) => request.action), ['preloadSession']);
  assert.ok(env.parent.messages.some((message) => message.type === 'dsh-au:session-preload-skipped' && message.requestId === 'stale'));
  assert.deepEqual(env.parent.messages.at(-1), { source: 'dsh-au', type: 'dsh-au:session-preload-ready', requestId: 'r1', deviceId: 'remote', sessionId: 'ready', updatedAt: 999_990 });
  env.emit({ source: 'dsh-au', type: 'dsh-au:session-preload-request', deviceId: 'remote', sessionId: 'boundary', requestId: 'boundary-1', updatedAt: 1_000_000 - 48 * 60 * 60 * 1000 });
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(env.requests.filter((request) => request.action === 'preloadSession').length, 2);
  env.emit({ source: 'dsh-au', type: 'dsh-au:session-preload-request', deviceId: 'remote', sessionId: 'boundary', requestId: 'boundary-2', updatedAt: 1_000_000 - 48 * 60 * 60 * 1000 });
  assert.equal(env.requests.filter((request) => request.action === 'preloadSession').length, 2);
  env.emit({ source: 'dsh-au', type: 'dsh-au:session-preload-prune', deviceId: 'remote', sessionId: 'ready', updatedAt: 999_990 });
  await Promise.resolve();
  assert.ok(env.requests.some((request) => request.action === 'cancelSessionPreload' && request.requestId === 'r1'));
  dispose();
  await Promise.resolve();
  assert.ok(env.requests.some((request) => request.action === 'releaseSessionPreloads' && request.sessionIds.includes('boundary')));
});

test('legacy or mismatched HOST responses are rejected and cancellation aborts late completion', async () => {
  const now = 1_000_000; const env = receiverBrowser(now); let preloadCalls = 0; let resolveFetch;
  env.fetch = async (url, options) => {
    const body = JSON.parse(options.body); env.requests.push(body);
    if (body.action === 'preloadSession') {
      preloadCalls += 1;
      if (preloadCalls === 1) return { ok: true, text: async () => JSON.stringify({ ok: true, result: 'ready', sessionId: 'wrong', updatedAt: body.updatedAt }) };
      return new Promise((resolve) => { resolveFetch = resolve; });
    }
    return { ok: true, text: async () => '{}' };
  };
  const client = load({ window: env.window, fetch: env.fetch, now }); const dispose = client.installControlledSessionPreload(env.ctx);
  env.emit({ source: 'dsh-au', type: 'dsh-au:session-preload-request', deviceId: 'remote', sessionId: 'ready', requestId: 'r2', updatedAt: now - 10 });
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.equal(env.parent.messages.some((message) => message.type === 'dsh-au:session-preload-ready'), false);
  assert.ok(env.requests.some((request) => request.action === 'cancelSessionPreload' && request.requestId === 'r2'));
  env.emit({ source: 'dsh-au', type: 'dsh-au:session-preload-request', deviceId: 'remote', sessionId: 'ready', requestId: 'r3', updatedAt: now - 10 });
  env.emit({ source: 'dsh-au', type: 'dsh-au:session-preload-cancel', deviceId: 'remote', sessionId: 'ready', requestId: 'r3' });
  await Promise.resolve();
  assert.ok(env.requests.some((request) => request.action === 'cancelSessionPreload'));
  resolveFetch?.({ ok: true, text: async () => JSON.stringify({ ok: true, result: 'ready', sessionId: 'ready', updatedAt: now - 10 }) });
  await Promise.resolve();
  assert.equal(env.parent.messages.some((message) => message.type === 'dsh-au:session-preload-ready' && message.requestId === 'r3'), false);
  dispose();
});

test('preload warms client session window via read-only page RPC and skips loading state on open', async () => {
  const now = 1_000_000;
  const env = receiverBrowser(now);
  const pageRequests = [];
  const installedWindows = [];
  let resyncCalls = 0;
  let followShouldFail = false;

  const sessionMap = new Map();
  const makeSession = (id) => {
    const s = {
      sessionId: id,
      openState: 'cold',
      openError: null,
      openGeneration: 0,
      notifier: { dirtyCount: 0, markDirty() { this.dirtyCount += 1; } },
      installWindow(records, hasMore) {
        installedWindows.push({ id, records, hasMore });
      },
      doOpen(generation) {
        this.openState = 'loading';
        this.openError = null;
        this.notifier.markDirty();
        return Promise.resolve().then(() => {
          if (followShouldFail) {
            this.openState = 'error';
            this.openError = new Error('ECONNRESET');
          } else if (generation === this.openGeneration) {
            this.openState = 'open';
          }
        });
      },
      resync() {
        resyncCalls += 1;
      },
    };
    return s;
  };

  const manager = {
    sessions: sessionMap,
    get(id) {
      if (!sessionMap.has(id)) sessionMap.set(id, makeSession(id));
      return sessionMap.get(id);
    },
    remote: {
      session: {
        page: async (req) => {
          pageRequests.push(req);
          return {
            ok: true,
            value: {
              records: [{ type: 'event', event: { seq: 7, type: 'assistant/message', time: now - 10 } }],
              hasMore: true,
            },
          };
        },
      },
    },
  };
  let refreshedProjections = [];
  env.ctx = {
    get(name) {
      if (name !== 'sessions') return undefined;
      return {
        list: { getSnapshot: () => ({ byId: { ready: { id: 'ready', updatedAt: now - 10 } } }) },
        refreshProjections: (sid) => refreshedProjections.push(sid),
        manager,
      };
    },
  };
  env.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    env.requests.push(body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body.action === 'preloadSession'
        ? { ok: true, result: 'ready', sessionId: body.sessionId, updatedAt: body.updatedAt, cursor: 7 }
        : { ok: true }),
    };
  };

  const diagnostics = [];
  const clock = scheduler(now);
  const remoteFrame = frame();
  const client = load({ window: env.window, fetch: env.fetch, now });
  const coordinator = client.createRemoteSessionPreloadCoordinator({
    findFrame: () => remoteFrame,
    onDiagnostic: (diag) => diagnostics.push(diag),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  coordinator.updatePlan([{ deviceId: 'remote', sessionId: 'ready', updatedAt: now - 10 }]);
  coordinator.handleMessage({ source: remoteFrame.contentWindow, data: { source: 'dsh-au', type: 'frame-ready' } });

  const dispose = client.installControlledSessionPreload(env.ctx);
  const reqMsg = remoteFrame.contentWindow.messages[0];
  env.emit(reqMsg);
  for (let i = 0; i < 10; i++) await Promise.resolve();

  assert.equal(pageRequests.length, 1);
  assert.equal(pageRequests[0].throughSeq, 7);
  assert.deepEqual(refreshedProjections, ['ready']);
  assert.equal(installedWindows.length, 1);
  assert.equal(installedWindows[0].id, 'ready');
  assert.equal(installedWindows[0].hasMore, true);

  const session = manager.get('ready');
  assert.ok(session.__dshAuPreloaded);

  // 点击打开已预热会话：同一同步 tick 内 openState 直接为 'open'，绝不暴露 'loading'
  followShouldFail = true;
  const openPromise = session.doOpen(session.openGeneration);
  assert.equal(session.openState, 'open');
  await openPromise;
  // 即使后台实时流因隧道闪断报错，已预热窗口仍保持 'open' 不回退报错页
  assert.equal(session.openState, 'open');
  assert.equal(session.openError, null);

  // 协调器收到 ready 回包后触发脱敏诊断回调
  coordinator.handleMessage({ source: remoteFrame.contentWindow, data: env.parent.messages.find((message) => message.type === 'dsh-au:session-preload-ready') });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].deviceId, 'remote');
  assert.equal(diagnostics[0].sessionId, 'ready');
  assert.equal(diagnostics[0].result, 'ready');
  assert.equal( resyncCalls, 0);

  coordinator.dispose();
  dispose();
});

// 2026-11-03：后端已完成但分页未完成时，取消/销毁必须阻止迟到安装与 ready。
for (const stop of ['cancel', 'prune', 'dispose']) {
  test(`stopping during history paging via ${stop} prevents late window publication`, async () => {
    const env = receiverBrowser();
    let resolvePage;
    let pageSignal;
    let installed = 0;
    const session = { sessionId: 'ready', openState: 'cold', doOpen() {}, installWindow() { installed += 1; } };
    const manager = { get: () => session, remote: { session: { page: (_request, signal) => {
      pageSignal = signal;
      return new Promise((resolve) => { resolvePage = resolve; });
    } } } };
    const catalog = env.ctx.get('sessions');
    catalog.manager = manager;
    const originalFetch = env.fetch;
    env.fetch = async (url, options) => {
      const response = await originalFetch(url, options);
      const body = JSON.parse(options.body);
      return { ...response, text: async () => JSON.stringify(body.action === 'preloadSession'
        ? { ok: true, result: 'ready', sessionId: body.sessionId, updatedAt: body.updatedAt, cursor: 7 } : { ok: true }) };
    };
    const dispose = load({ window: env.window, fetch: env.fetch }).installControlledSessionPreload(env.ctx);
    const req = { source: 'dsh-au', type: 'dsh-au:session-preload-request', deviceId: 'remote', sessionId: 'ready', requestId: 'page-request', updatedAt: 999_990 };
    env.emit(req);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.ok(pageSignal, '必须先进入分页阶段');
    if (stop === 'dispose') dispose();
    else env.emit({ ...req, type: `dsh-au:session-preload-${stop}` });
    assert.equal(pageSignal.aborted, true);
    resolvePage({ ok: true, value: { records: [], hasMore: false } });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.equal(installed, 0);
    assert.equal(env.parent.messages.some((m) => m.type === 'dsh-au:session-preload-ready'), false);
    assert.ok(env.requests.some((r) => r.action === 'cancelSessionPreload' && r.requestId === req.requestId));
    dispose();
  });
}

test('failed history paging releases the lease and never advertises a ready cache', async () => {
  const env = receiverBrowser();
  const catalog = env.ctx.get('sessions');
  let installed = 0;
  catalog.manager = { get: () => ({ openState: 'cold', doOpen() {}, installWindow() { installed += 1; } }),
    remote: { session: { page: async () => ({ ok: false }) } } };
  env.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); env.requests.push(body);
    return { ok: true, text: async () => JSON.stringify(body.action === 'preloadSession'
      ? { ok: true, result: 'ready', sessionId: 'ready', updatedAt: 999_990, cursor: 7 } : { ok: true }) };
  };
  const dispose = load({ window: env.window, fetch: env.fetch }).installControlledSessionPreload(env.ctx);
  env.emit({ source: 'dsh-au', type: 'dsh-au:session-preload-request', deviceId: 'remote', sessionId: 'ready', requestId: 'failed-page', updatedAt: 999_990 });
  for (let i = 0; i < 16; i++) await Promise.resolve();
  assert.equal(installed, 0);
  assert.equal(env.parent.messages.some((m) => m.type === 'dsh-au:session-preload-ready'), false);
  assert.ok(env.parent.messages.some((m) => m.type === 'dsh-au:session-preload-error' && m.reason === 'client-window-failed'));
  assert.ok(env.requests.some((r) => r.action === 'cancelSessionPreload' && r.requestId === 'failed-page'));
  dispose();
});

test('foreground loading blocks background even after one second and ignores unrelated completion', async () => {
  const clock = scheduler();
  const remote = frame();
  const coordinator = load().createRemoteSessionPreloadCoordinator({ findFrame: () => remote,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  coordinator.updatePlan([{ deviceId: 'remote', sessionId: 'selected', updatedAt: 999_999 }]);
  coordinator.handleMessage({ source: remote.contentWindow, data: { source: 'dsh-au', type: 'frame-ready' } });
  coordinator.notifyForeground('remote', 'selected');
  assert.ok(remote.contentWindow.messages.some((m) => m.type === 'dsh-au:session-preload-cancel'), '同一会话后台请求也必须取消');
  const foregroundId = remote.contentWindow.messages.at(-1).foregroundId;
  coordinator.handleMessage({ source: remote.contentWindow, data: { source: 'dsh-au', type: 'dsh-au:session-preload-foreground-state',
    deviceId: 'remote', sessionId: 'selected', foregroundId, stage: 'open-start', result: 'loading', generation: 1 } });
  await clock.advance(35_000);
  assert.equal(remote.contentWindow.messages.filter((m) => m.type.endsWith('-request')).length, 1, '新版仍加载时不能按旧端30秒兜底放行');
  const settled = { source: 'dsh-au', type: 'dsh-au:session-preload-foreground-state', deviceId: 'remote', sessionId: 'other', foregroundId, stage: 'follow-settled', result: 'open', generation: 0 };
  coordinator.handleMessage({ source: remote.contentWindow, data: settled });
  await clock.advance(1_000);
  assert.equal(remote.contentWindow.messages.filter((m) => m.type.endsWith('-request')).length, 1);
  coordinator.handleMessage({ source: remote.contentWindow, data: { ...settled, sessionId: 'selected' } });
  await clock.advance(1_000);
  assert.equal(remote.contentWindow.messages.filter((m) => m.type.endsWith('-request')).length, 1, '旧代完成不能释放新代加载');
  coordinator.handleMessage({ source: remote.contentWindow, data: { ...settled, sessionId: 'selected', generation: 1 } });
  await clock.advance(1_000);
  assert.equal(remote.contentWindow.messages.filter((m) => m.type.endsWith('-request')).length, 2);
  coordinator.dispose();
  assert.equal(clock.timers.size, 0);
});

test('legacy foreground without status has a bounded fallback instead of permanently blocking preload', async () => {
  const clock = scheduler(); const remote = frame();
  const coordinator = load().createRemoteSessionPreloadCoordinator({ findFrame: () => remote,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  coordinator.updatePlan([{ deviceId: 'remote', sessionId: 'background', updatedAt: 999_999 }]);
  coordinator.handleMessage({ source: remote.contentWindow, data: { source: 'dsh-au', type: 'frame-ready' } });
  coordinator.notifyForeground('remote', 'legacy-selection');
  const foregroundId = remote.contentWindow.messages.at(-1).foregroundId;
  assert.equal(coordinator.handleMessage({ source: remote.contentWindow, data: { source: 'dsh-au',
    type: 'dsh-au:session-preload-foreground-state', deviceId: 'remote', sessionId: 'legacy-selection', foregroundId,
    stage: 'unknown-stage', result: 'open', generation: 1 } }), false);
  assert.equal(coordinator.handleMessage({ source: remote.contentWindow, data: { source: 'dsh-au',
    type: 'dsh-au:session-preload-foreground-state', deviceId: 'remote', sessionId: 'legacy-selection', foregroundId,
    stage: 'follow-settled', result: 'open' } }), false);
  await clock.advance(29_999);
  assert.equal(remote.contentWindow.messages.filter((m) => m.type.endsWith('-request')).length, 1);
  await clock.advance(1_001);
  assert.equal(remote.contentWindow.messages.filter((m) => m.type.endsWith('-request')).length, 2);
  coordinator.dispose();
});

test('reselecting the same session rejects completion from the previous selection token', async () => {
  const clock = scheduler(); const remote = frame();
  const coordinator = load().createRemoteSessionPreloadCoordinator({ findFrame: () => remote,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  coordinator.updatePlan([{ deviceId: 'remote', sessionId: 'selected', updatedAt: 999_999 }]);
  coordinator.handleMessage({ source: remote.contentWindow, data: { source: 'dsh-au', type: 'frame-ready' } });
  coordinator.notifyForeground('remote', 'selected');
  const previousId = remote.contentWindow.messages.at(-1).foregroundId;
  coordinator.notifyForeground('remote', 'selected');
  const currentId = remote.contentWindow.messages.at(-1).foregroundId;
  assert.notEqual(currentId, previousId);
  const status = { source: 'dsh-au', type: 'dsh-au:session-preload-foreground-state', deviceId: 'remote', sessionId: 'selected',
    foregroundId: previousId, stage: 'follow-settled', result: 'open', generation: 2 };
  coordinator.handleMessage({ source: remote.contentWindow, data: status });
  await clock.advance(1_000);
  assert.equal(remote.contentWindow.messages.filter((m) => m.type.endsWith('-request')).length, 1);
  coordinator.handleMessage({ source: remote.contentWindow, data: { ...status, foregroundId: currentId, stage: 'open-start', generation: 3 } });
  await clock.advance(35_000);
  assert.equal(remote.contentWindow.messages.filter((m) => m.type.endsWith('-request')).length, 1);
  coordinator.handleMessage({ source: remote.contentWindow, data: { ...status, foregroundId: currentId, generation: 3 } });
  await clock.advance(1_000);
  assert.equal(remote.contentWindow.messages.filter((m) => m.type.endsWith('-request')).length, 2);
  coordinator.dispose();
});

test('selection binding observes existing open promises without publishing a replaced generation', async () => {
  const env = receiverBrowser();
  let resolveOld; let resolveCurrent;
  // 第三方 Session 服务是系统边界：提供真实 Promise/状态，不复制它的 open()/resync() 算法。
  const session = { sessionId: 'ready', openState: 'loading', openGeneration: 2,
    openPromise: new Promise((resolve) => { resolveOld = resolve; }) };
  env.ctx.get('sessions').manager = { sessions: new Map([['ready', session]]) };
  const dispose = load({ window: env.window, fetch: env.fetch }).installControlledSessionPreload(env.ctx);
  const select = (foregroundId) => env.emit({ source: 'dsh-au', type: 'dsh-au:session-preload-foreground-select',
    deviceId: 'remote', sessionId: 'ready', foregroundId });
  select('selection-old');
  session.openGeneration = 3;
  session.openPromise = new Promise((resolve) => { resolveCurrent = resolve; });
  select('selection-current');
  resolveOld();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(env.parent.messages.some((m) => m.stage === 'follow-settled'), false);
  session.openState = 'open';
  resolveCurrent();
  await Promise.resolve(); await Promise.resolve();
  const settled = env.parent.messages.filter((m) => m.stage === 'follow-settled');
  assert.equal(settled.length, 1);
  assert.equal(settled[0].foregroundId, 'selection-current');
  assert.equal(settled[0].generation, 3);
  assert.equal(settled[0].result, 'open');
  dispose();
});
