import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { listLocalWorkspaces } from '../lib/session-reader.js';
import { createLocalTodoActions, registerTodoRoutes, sanitizeLoneSurrogates, synthesizeWorkspacesFromCards } from '../lib/todo/index.js';
import { outFile } from '../scripts/build-client.js';

function loadClientHelpers() {
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
    addEventListener() {},
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
  plugin.apply.remoteWorkspaces.__testWin = win;
  return plugin.apply.remoteWorkspaces;
}

test('listLocalWorkspaces normalizes default-workspace, preserves empty workspaces, sorts pinned first, and groups ungrouped sessions', async () => {
  const ctx = {
    get(name) {
      if (name === 'workspaceRegistry') {
        return {
          archivedSessionIds: ['s-archived'],
          pinnedSessionIds: ['s-2'],
          list: () => [
            {
              workspaceId: 'ws-default',
              title: 'default-workspace',
              path: 'C:/Users/demo/.dsh/default-workspace',
              createdAt: '2026-10-20T00:00:00.000Z',
              sessionIds: [],
            },
            {
              workspaceId: 'ws-au',
              title: 'DemoApp',
              path: 'D:/Work/DemoApp',
              createdAt: '2026-10-21T00:00:00.000Z',
              sessionIds: ['s-1', 's-2'],
            },
          ],
        };
      }
      if (name === 'sessionQuery') {
        return {
          listSessions: async () => [
            { header: { id: 's-1', title: '常规会话', cwd: 'D:/Work/DemoApp', createdAt: 1000 }, updatedAt: 2000 },
            { header: { id: 's-2', title: '置顶会话', cwd: 'D:/Work/DemoApp', createdAt: 1000 }, updatedAt: 1500 },
            { header: { id: 's-orphan', title: '游离会话', cwd: 'D:/Work/OtherApp', createdAt: 3000 }, updatedAt: 3500 },
            { header: { id: 's-archived', title: '归档会话', cwd: 'D:/Work/DemoApp', createdAt: 4000 }, updatedAt: 4000 },
          ],
          readTitleSnapshots: async (ids) => ids.map(() => ({})),
          observeSession: async () => ({ events: [] }),
        };
      }
      return null;
    },
  };
  const statusTracker = {
    getSessionStatus: (id) => (id === 's-2' ? 'busy' : 'idle'),
  };

  const workspaces = await listLocalWorkspaces(ctx, statusTracker, 50);
  assert.equal(workspaces.length, 3);

  const defaultWs = workspaces.find((w) => w.workspaceId === 'ws-default');
  assert.equal(defaultWs.title, '默认工作区');
  assert.equal(defaultWs.sessions.length, 0);

  const auWs = workspaces.find((w) => w.workspaceId === 'ws-au');
  assert.equal(auWs.title, 'DemoApp');
  assert.deepEqual(auWs.sessions.map((s) => s.sessionId), ['s-2', 's-1']);
  assert.equal(auWs.sessions[0].pinned, true);
  assert.equal(auWs.sessions[0].status, 'busy');

  const orphanWs = workspaces.find((w) => w.path === 'D:/Work/OtherApp');
  assert.ok(orphanWs);
  assert.equal(orphanWs.title, 'OtherApp');
  assert.deepEqual(orphanWs.sessions.map((s) => s.sessionId), ['s-orphan']);
});

test('synthesizeWorkspacesFromCards and registerTodoRoutes return remoteWorkspaces for both updated and legacy remote peers', async (t) => {
  delete globalThis.__dshAuTodoApplyActive;
  const synthesized = synthesizeWorkspacesFromCards([
    { sessionId: 'r-1', title: '修复样式', workspace: 'SampleApp', cwd: 'D:/SampleApp', updatedAt: 5000, status: 'busy' },
    { sessionId: 'r-2', title: '编写测试', workspace: 'SampleApp', cwd: 'D:/SampleApp', updatedAt: 6000, status: 'idle' },
  ], { deviceId: 'dev-win', name: '主力机', isLocal: false });

  assert.equal(synthesized.length, 1);
  assert.equal(synthesized[0].title, 'SampleApp');
  assert.equal(synthesized[0].deviceName, '主力机');
  assert.equal(synthesized[0].sessions.length, 2);

  let registeredHandler = null;
  const server = {
    register(spec) {
      registeredHandler = spec.handler;
      return () => { registeredHandler = null; };
    },
  };

  const bridge = {
    getLocalDevice: () => ({ deviceId: 'dev-local', name: '本机' }),
    listLocalSessions: async () => [],
    listLocalWorkspaces: async () => [
      { workspaceId: 'ws-local', title: 'DemoApp', path: 'D:/DemoApp', updatedAt: 1000, sessions: [] },
    ],
    getDevices: async () => [
      { deviceId: 'dev-mac', name: 'MacBook', sessionStatesV2: { 'm-1': 'waiting' } },
      { deviceId: 'dev-legacy', name: '旧版工作站', sessionStatesV2: {} },
    ],
    requestDevice: async (deviceId, path, body) => {
      if (deviceId === 'dev-mac' && body.action === 'getLocalSessions') {
        return {
          ok: true,
          cards: [
            { sessionId: 'm-1', title: 'Mac 对话', workspace: 'DemoApp', cwd: '/Users/mac/DemoApp', updatedAt: 9000, status: 'idle' },
          ],
          workspaces: [
            {
              workspaceId: 'ws-mac-empty',
              title: 'default-workspace',
              path: '/Users/mac/.dsh/default-workspace',
              updatedAt: 1000,
              sessions: [],
            },
            {
              workspaceId: 'ws-mac-1',
              title: 'DemoApp',
              path: '/Users/mac/DemoApp',
              updatedAt: 9000,
              sessions: [
                { sessionId: 'm-1', title: 'Mac 对话', cwd: '/Users/mac/DemoApp', updatedAt: 9000, status: 'idle' },
              ],
            },
          ],
        };
      }
      if (deviceId === 'dev-legacy' && body.action === 'getLocalSessions') {
        return {
          ok: true,
          cards: [
            { sessionId: 'leg-1', title: '旧版会话', workspace: 'AuWin', cwd: 'E:/AuWin', updatedAt: 7000, status: 'done' },
          ],
        };
      }
      if (path === '/api/workspace/create') {
        const reqPayload = body?.payload?.args?.request || {};
        return {
          type: 'server-response',
          rpcId: body?.rpcId || 'rpc-ws',
          result: {
            ok: true,
            value: {
              workspace: {
                workspaceId: `ws-resolved-${String(reqPayload.path || '').split(/[\\/]/).pop()}`,
                title: 'AuWin',
                path: reqPayload.path || '',
              },
            },
          },
        };
      }
      if (path === '/api/session/create') {
        const reqPayload = body?.payload?.args?.request || {};
        // DSH SessionCreateRequest schema: workspaceId is exclusive with cwd
        if (reqPayload.workspaceId && reqPayload.cwd) {
          return {
            type: 'server-response',
            rpcId: body?.rpcId || 'rpc-err',
            result: {
              ok: false,
              error: { code: 'invalid_request', message: 'workspaceId is exclusive with cwd' },
            },
          };
        }
        return {
          type: 'server-response',
          rpcId: body?.rpcId || 'rpc-1',
          result: {
            ok: true,
            value: {
              sessionId: `created-${deviceId}-${reqPayload.workspaceId || 'cwd'}`,
              agentPreset: 'standard',
            },
          },
        };
      }
      return { ok: false, httpStatus: 404 };
    },
  };

  const localActions = createLocalTodoActions(bridge);
  const localRes = await localActions.dispatchLocal('getLocalSessions', {});
  assert.equal(localRes.ok, true);
  assert.equal(Array.isArray(localRes.workspaces), true);
  assert.equal(localRes.workspaces[0].workspaceId, 'ws-local');

  const dispose = registerTodoRoutes({ server, bridge, isEnabled: () => true });
  t.after(dispose);

  const callRoute = async (payload) => {
    let statusCode = 0;
    let bodyText = '';
    const req = {
      method: 'POST',
      setEncoding() {},
      on(event, cb) {
        if (event === 'data') cb(JSON.stringify(payload));
        if (event === 'end') cb();
      },
    };
    const res = {
      writeHead(code) { statusCode = code; },
      end(str) { bodyText = str; },
    };
    await registeredHandler(req, res);
    return { statusCode, data: JSON.parse(bodyText) };
  };

  const stateRes = await callRoute({ action: 'getState' });
  assert.equal(stateRes.statusCode, 200);
  assert.equal(stateRes.data.ok, true);
  assert.equal(Array.isArray(stateRes.data.remoteWorkspaces), true);
  assert.equal(stateRes.data.remoteWorkspaces.length, 3);

  const macDemoApp = stateRes.data.remoteWorkspaces.find((w) => w.workspaceId === 'ws-mac-1');
  assert.equal(macDemoApp.deviceName, 'MacBook');
  // 权威本次 idle 不能被此前 waiting 探针反盖（旧设备也按来源优先级降级）。
  assert.equal(macDemoApp.sessions[0].status, 'idle');

  const macEmpty = stateRes.data.remoteWorkspaces.find((w) => w.workspaceId === 'ws-mac-empty');
  assert.equal(macEmpty.title, '默认工作区');
  assert.equal(macEmpty.sessions.length, 0);

  const legacyWs = stateRes.data.remoteWorkspaces.find((w) => w.deviceId === 'dev-legacy');
  assert.equal(legacyWs.title, 'AuWin');
  assert.equal(legacyWs.deviceName, '旧版工作站');
  assert.equal(legacyWs.sessions[0].sessionId, 'leg-1');

  const createRes = await callRoute({
    action: 'createRemoteSession',
    deviceId: 'dev-mac',
    workspaceId: 'ws-mac-empty',
    cwd: '/Users/mac/.dsh/default-workspace',
  });
  assert.equal(createRes.statusCode, 200);
  assert.equal(createRes.data.ok, true);
  assert.equal(createRes.data.sessionId, 'created-dev-mac-ws-mac-empty');

  const createSyntheticWsRes = await callRoute({
    action: 'createRemoteSession',
    deviceId: 'dev-legacy',
    workspaceId: 'ws:e:/auwin',
    cwd: 'E:/AuWin',
  });
  assert.equal(createSyntheticWsRes.statusCode, 200);
  assert.equal(createSyntheticWsRes.data.ok, true);
  assert.equal(createSyntheticWsRes.data.sessionId, 'created-dev-legacy-ws-resolved-AuWin');
  assert.equal(createSyntheticWsRes.data.workspaceId, 'ws-resolved-AuWin');
});

test('stale optimistic blank 新对话 in controlled snapshot does not hide a session the server reports as non-blank', () => {
  const helpers = loadClientHelpers();
  const wsPath = 'F:/AuOS/DemoApp';
  // 通道 A：服务端已看到该会话发过消息（真实标题、非空白）
  const serverWorkspaces = helpers.normalizeServerRemoteWorkspaces({
    ok: true,
    localDeviceId: 'dev-local',
    remoteWorkspaces: [{
      deviceId: 'win',
      workspaceId: `cwd:${wsPath}`,
      title: 'DemoApp',
      path: wsPath,
      sessions: [
        { sessionId: 's-new', title: '回复OK', updatedAt: 9000 },
        { sessionId: 's-old', title: '评审', updatedAt: 5000 },
      ],
    }],
  });
  // 通道 B：受控端快照仍残留新建时乐观写入的空白「新对话」
  const controlledSnapshots = new Map([['win', {
    currentSessionId: 's-other',
    workspaces: [{
      workspaceId: `cwd:${wsPath}`,
      title: 'DemoApp',
      path: wsPath,
      sessions: [{ sessionId: 's-new', title: '新对话', blank: true, updatedAt: 8000 }],
    }],
  }]]);

  const merged = helpers.mergeRemoteWorkspaces(serverWorkspaces, controlledSnapshots, [{ id: 'win', name: 'win' }], new Set());
  const session = merged.visible[0].sessions.find((s) => s.sessionId === 's-new');
  assert.ok(session, '新会话应仍在工作区内');
  assert.equal(session.blank, false, '任一通道非空白即视为非空白');
  assert.equal(session.title, '回复OK', '占位标题不得覆盖真实标题');

  // 两侧都还是空白时保持空白（未发消息的新对话依旧按原生规则隐藏）
  const bothBlank = helpers.mergeRemoteWorkspaces(
    [{ ...serverWorkspaces[0], sessions: [{ ...serverWorkspaces[0].sessions[0], title: '新对话', blank: true }] }],
    controlledSnapshots,
    [{ id: 'win', name: 'win' }],
    new Set(),
  );
  assert.equal(bothBlank.visible[0].sessions.find((s) => s.sessionId === 's-new').blank, true);
});

test('client remoteWorkspaces helpers merge server + controlled iframe snapshots, manage hidden workspaces, and switch back to local on native sidebar click', () => {
  const helpers = loadClientHelpers();
  assert.equal(typeof helpers.normalizeServerRemoteWorkspaces, 'function');
  assert.equal(typeof helpers.mergeRemoteWorkspaces, 'function');
  assert.equal(typeof helpers.shouldSwitchToLocalOnSidebarClick, 'function');

  const serverWorkspaces = helpers.normalizeServerRemoteWorkspaces({
    ok: true,
    localDeviceId: 'dev-local',
    remoteWorkspaces: [
      {
        deviceId: 'dev-mac',
        deviceName: 'MacBook',
        workspaceId: 'ws-1',
        title: 'DemoApp',
        path: '/Users/mac/DemoApp',
        updatedAt: 5000,
        sessions: [
          { sessionId: 's-mac-1', title: '同步配置', status: 'busy', updatedAt: 5000 },
        ],
      },
    ],
  });
  assert.equal(serverWorkspaces.length, 1);
  assert.equal(serverWorkspaces[0].status, 'busy');

  const controlledSnapshots = new Map([
    [
      'dev-mac',
      {
        currentSessionId: 's-mac-1',
        workspaces: [
          {
            workspaceId: 'ws-1',
            title: 'DemoApp',
            path: '/Users/mac/DemoApp',
            updatedAt: 6000,
            sessions: [
              { sessionId: 's-mac-1', title: '同步配置', status: 'idle', updatedAt: 6000 },
              { sessionId: 's-mac-2', title: '新增对话', status: 'idle', updatedAt: 7000 },
            ],
          },
          {
            workspaceId: 'ws-empty',
            title: 'EmptyApp',
            path: '/Users/mac/EmptyApp',
            updatedAt: 4000,
            sessions: [],
          },
        ],
      },
    ],
  ]);

  const merged = helpers.mergeRemoteWorkspaces(serverWorkspaces, controlledSnapshots, [{ id: 'dev-mac', name: 'MacBook' }], new Set());
  assert.equal(merged.visible.length, 2);
  assert.equal(merged.visible[0].workspaceId, 'ws-1');
  assert.equal(merged.visible[0].sessions.length, 2);
  // 服务端探测到的 busy 状态优先保留，不被受控端默认 idle 冲掉
  assert.equal(merged.visible[0].sessions.find((s) => s.sessionId === 's-mac-1').status, 'busy');
  assert.equal(merged.visible[1].workspaceId, 'ws-empty');
  assert.equal(merged.visible[1].title, 'EmptyApp');

  const hiddenApplied = helpers.mergeRemoteWorkspaces(
    serverWorkspaces,
    controlledSnapshots,
    [{ id: 'dev-mac', name: 'MacBook' }],
    new Set(['dev-mac:ws-empty']),
  );
  assert.equal(hiddenApplied.visible.length, 1);
  assert.equal(hiddenApplied.hiddenCount, 1);

  const remoteActiveDoc = {
    documentElement: {
      getAttribute: (attr) => (attr === 'data-dsh-au-remote-active' ? 'true' : null),
    },
  };
  const nativeWorkspaceTarget = {
    closest(selector) {
      if (selector.includes('_sidebarCol') || selector.includes('aside[data-slot="sidebar"]')) return {};
      if (selector === '[data-dsh-au-remote-workspaces="1"]') return null;
      if (selector.includes('[data-row-key^="workspace:"]')) return {};
      return null;
    },
  };
  const remoteRowTarget = {
    closest(selector) {
      if (selector.includes('_sidebarCol') || selector.includes('aside[data-slot="sidebar"]')) return {};
      if (selector === '[data-dsh-au-remote-workspaces="1"]') return {};
      return null;
    },
  };
  assert.equal(helpers.shouldSwitchToLocalOnSidebarClick(nativeWorkspaceTarget, remoteActiveDoc), true);
  assert.equal(helpers.shouldSwitchToLocalOnSidebarClick(remoteRowTarget, remoteActiveDoc), false);

  // 验证实机 AppFrame (_sidebarCol -> _regionArea -> _treeBody -> div[role="tree"][class*="_list"]) 挂载契约
  const treeEl = {
    children: [],
    lastElementChild: null,
    querySelector() { return null; },
    appendChild(child) {
      child.parentElement = treeEl;
      this.children.push(child);
      this.lastElementChild = child;
    },
  };
  const realDshDoc = {
    querySelector(sel) {
      if (sel.includes('[class*="_sidebarCol"]') && sel.includes('div[role="tree"][class*="_list"]')) {
        return treeEl;
      }
      return null;
    },
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(),
        className: '',
        attrs: {},
        parentElement: null,
        setAttribute(k, v) { this.attrs[k] = v; },
      };
    },
  };
  const mountNode = helpers.ensureRemoteWorkspacesMountNode(realDshDoc);
  assert.ok(mountNode);
  assert.equal(mountNode.className, 'dsh-au-remote-ws-root');
  assert.equal(mountNode.attrs['data-dsh-au-remote-workspaces'], '1');
  assert.equal(treeEl.lastElementChild, mountNode);

  // 验证受控端通过 uiWorkspace.workspaces (sessionIds + default-workspace + archivedSessionIds) 提取完整工作区快照
  const controlledSnap = helpers.extractControlledWorkspacesSnapshot({
    uiWorkspace: {
      workspaces: {
        list: {
          getSnapshot: () => ({
            archivedSessionIds: ['s-archived'],
            items: [
              {
                workspaceId: 'ws-default',
                title: 'default-workspace',
                path: '/Users/mac/Documents/deepseek-harness/default-workspace',
                createdAt: '2026-10-20T00:00:00.000Z',
                sessionIds: ['s-live', 's-archived'],
              },
              {
                workspaceId: 'ws-empty-real',
                title: 'sample-workspace', // 个人工作区名改成示例名
                path: '/Users/mac/Projects/AuOS/sample-workspace',
                createdAt: '2026-10-21T00:00:00.000Z',
                sessionIds: [],
              },
            ],
          }),
        },
      },
      sessions: {
        list: {
          getSnapshot: () => ({
            byId: {
              's-live': { id: 's-live', displayTitle: '实机活跃会话', running: true, updatedAt: 9000 },
              's-archived': { id: 's-archived', displayTitle: '已归档会话', running: false, updatedAt: 8000 },
            },
          }),
        },
      },
    },
  });
  assert.equal(controlledSnap.workspaces.length, 2);
  assert.equal(controlledSnap.workspaces[0].title, '默认工作区');
  assert.equal(controlledSnap.workspaces[0].sessions.length, 1);
  assert.equal(controlledSnap.workspaces[0].sessions[0].sessionId, 's-live');
  assert.equal(controlledSnap.workspaces[0].sessions[0].status, 'running');
  assert.equal(controlledSnap.workspaces[1].title, 'sample-workspace');
  assert.equal(controlledSnap.workspaces[1].sessions.length, 0);

  // 验证同设备「默认工作区」去重（default-workspace + cwd:默认工作区 / 空 cwd）及跨设备全局按更新时间排序
  const multiDeviceMerged = helpers.mergeRemoteWorkspaces(
    [
      {
        deviceId: 'dev-win',
        deviceName: 'win',
        workspaceId: 'ws-win-default',
        title: '默认工作区',
        path: 'C:/Users/win/.dsh/default-workspace',
        updatedAt: 2000,
        sessions: [{ sessionId: 'w-1', title: '旧对话', status: 'idle', updatedAt: 2000 }],
      },
      {
        deviceId: 'dev-win',
        deviceName: 'win',
        workspaceId: 'cwd:默认工作区',
        title: '默认工作区',
        path: '',
        updatedAt: 8500,
        sessions: [{ sessionId: 'w-2', title: '新对话', status: 'done', updatedAt: 8500 }],
      },
      {
        deviceId: 'dev-mac',
        deviceName: 'mac',
        workspaceId: 'ws-mac-older',
        title: 'sample-workspace',
        path: '/Users/mac/sample-workspace',
        updatedAt: 5000,
        sessions: [],
      },
    ],
    new Map([
      [
        'dev-mac',
        {
          workspaces: [
            {
              workspaceId: 'ws-mac-newest',
              title: 'DemoApp',
              path: '/Users/mac/DemoApp',
              updatedAt: 9500,
              sessions: [],
            },
          ],
        },
      ],
    ]),
    [{ id: 'dev-win', name: 'win' }, { id: 'dev-mac', name: 'mac' }],
    new Set(),
  );
  assert.equal(multiDeviceMerged.visible.length, 3, 'duplicate 默认工作区 on win must be merged into 1');
  assert.deepEqual(
    multiDeviceMerged.visible.map((w) => `${w.deviceName}:${w.title}`),
    ['mac:DemoApp', 'win:默认工作区', 'mac:sample-workspace'],
    'workspaces across all devices must be sorted globally by updatedAt descending',
  );
  assert.equal(multiDeviceMerged.visible[1].sessions.length, 2);
  assert.equal(multiDeviceMerged.visible[1].status, 'done');

  // 验证 syncWorkspaceListFlexOrder 将本机工作区与远端工作区按「最近更新」时间交错排序
  const secLocalOld = {
    style: {},
    querySelector: () => ({ getAttribute: () => 'workspace:ws-local-old' }),
  };
  const secLocalNew = {
    style: {},
    querySelector: () => ({ getAttribute: () => 'workspace:ws-local-new' }),
  };
  const remMid = {
    style: {},
    getAttribute: (k) => (k === 'data-remote-ws-updated-at' ? '5000' : ''),
  };
  const restoreEl = { style: {} };
  const flexTreeDoc = {
    querySelector(sel) {
      if (sel.includes('div[role="tree"][class*="_list"]')) {
        return {
          querySelectorAll(q) {
            if (q === ':scope > [class*="_groupSection"]') return [secLocalOld, secLocalNew];
            if (q === '.dsh-au-remote-ws-item') return [remMid];
            return [];
          },
          querySelector(q) {
            if (q === '.dsh-au-remote-ws-restore') return restoreEl;
            return null;
          },
        };
      }
      return null;
    },
  };
  helpers.syncWorkspaceListFlexOrder({
    uiWorkspace: {
      orderBy: 'recent',
      workspaces: {
        list: {
          getSnapshot: () => ({
            items: [
              { workspaceId: 'ws-local-old', createdAt: 1000, sessionIds: ['s-old'] },
              { workspaceId: 'ws-local-new', createdAt: 2000, sessionIds: ['s-new'] },
            ],
          }),
        },
      },
      sessions: {
        list: {
          getSnapshot: () => ({
            byId: {
              's-old': { id: 's-old', updatedAt: 3000 },
              's-new': { id: 's-new', updatedAt: 9000 },
            },
          }),
        },
      },
    },
  }, flexTreeDoc);
  assert.equal(secLocalNew.style.order, '1');
  assert.equal(remMid.style.order, '2');
  assert.equal(secLocalOld.style.order, '3');
  assert.equal(restoreEl.style.order, '99999');
});

test('activateRemoteWorkspace with createNew creates remote blank session, injects optimistic 新对话, and sends select-session to controlled frame', async () => {
  const helpers = loadClientHelpers();
  const postedMessages = [];
  const fakeFrame = {
    name: 'dsh-au-controlled:dev-mac',
    src: 'http://127.0.0.1:14828/',
    contentWindow: {
      postMessage(msg) {
        postedMessages.push(msg);
      },
    },
  };
  const fakeDoc = {
    querySelectorAll() {
      return [fakeFrame];
    },
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init?.body || '{}');
    if (url === '/dsh-au-todo/api' && body.action === 'createRemoteSession') {
      return {
        json: async () => ({
          ok: true,
          sessionId: 'session-new-mac-blank',
          cwd: body.cwd,
        }),
      };
    }
    throw new Error(`unexpected url: ${url}`);
  };

  try {
    const newSid = await helpers.activateRemoteWorkspace(
      {
        key: 'dev-mac:default-workspace',
        deviceId: 'dev-mac',
        deviceName: 'mac',
        workspaceId: 'default-workspace',
        title: '默认工作区',
        path: '/Users/mac/Documents/deepseek-harness/default-workspace',
        sessions: [],
      },
      { createNew: true },
      fakeDoc,
    );
    assert.equal(newSid, 'session-new-mac-blank');
    assert.equal(helpers.store.selectedSessionByDevice.get('dev-mac'), 'session-new-mac-blank');
    const snap = helpers.store.controlledSnapshots.get('dev-mac');
    assert.ok(snap);
    assert.equal(snap.workspaces[0].sessions[0].sessionId, 'session-new-mac-blank');
    assert.equal(snap.workspaces[0].sessions[0].title, '新对话');
    assert.equal(
      postedMessages.some((m) => m.type === 'dsh-au-todo:select-session' && m.sessionId === 'session-new-mac-blank'),
      true,
      'must send dsh-au-todo:select-session so legacy remote peers open the new blank session',
    );
    assert.equal(
      postedMessages.some((m) => m.type === 'dsh-au:open-remote-session' && m.sessionId === 'session-new-mac-blank'),
      true,
      'must send dsh-au:open-remote-session with commandId',
    );
  } finally {
    globalThis.fetch = origFetch;
  }

  // 验证受控端当前正处于空白新对话时，extractControlledWorkspacesSnapshot 会保留该「新对话」而非过滤丢弃
  const snapWithActiveBlank = helpers.extractControlledWorkspacesSnapshot({
    uiWorkspace: {
      mainView: { kind: 'session', sessionId: 's-active-blank' },
      workspaces: {
        list: {
          getSnapshot: () => ({
            items: [
              {
                workspaceId: 'ws-default',
                title: 'default-workspace',
                path: '/Users/mac/Documents/deepseek-harness/default-workspace',
                sessionIds: ['s-active-blank'],
              },
            ],
          }),
        },
      },
      sessions: {
        list: {
          getSnapshot: () => ({
            byId: {
              's-active-blank': { id: 's-active-blank', blank: true, running: false, updatedAt: 9999 },
            },
          }),
        },
      },
    },
  });
  assert.equal(snapWithActiveBlank.currentSessionId, 's-active-blank');
  assert.equal(snapWithActiveBlank.workspaces[0].sessions.length, 1);
  assert.equal(snapWithActiveBlank.workspaces[0].sessions[0].sessionId, 's-active-blank');
  assert.equal(snapWithActiveBlank.workspaces[0].sessions[0].title, '新对话');
});

test('installNativeWorkspaceBridge merges remote workspaces into native stores, enforces 5-session watermark, intercepts actions, and decorates native rows', async () => {
  const helpers = loadClientHelpers();

  const rawWsSnap = {
    phase: 'ready',
    pinnedSessionIds: ['local-pinned'],
    archivedSessionIds: [],
    items: [
      {
        workspaceId: 'ws-local-1',
        title: 'local-older',
        path: 'D:/Work/local-older',
        createdAt: 2000,
        sessionIds: ['local-s1'],
      },
      {
        workspaceId: 'ws-local-2',
        title: 'local-newest',
        path: 'D:/Work/local-newest',
        createdAt: 9000,
        sessionIds: ['local-s2'],
      },
    ],
  };
  const rawSessSnap = {
    byId: {
      'local-s1': { id: 'local-s1', title: '本地旧对话', updatedAt: 2000, retainedBy: { mainView: 1 } },
      'local-s2': { id: 'local-s2', title: '本地新对话', updatedAt: 12000, retainedBy: { mainView: 0 } },
    },
  };
  const rawStatusMap = new Map();

  const wsList = {
    listeners: new Set(),
    getSnapshot: () => rawWsSnap,
    subscribe(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    },
  };
  const sessList = {
    listeners: new Set(),
    getSnapshot: () => rawSessSnap,
    subscribe(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    },
  };
  const statusStore = {
    getSnapshot: () => rawStatusMap,
    subscribe: () => () => {},
  };

  let localOpenedSession = null;
  let retainedKeysResult = null;
  const uiWorkspace = {
    orderBy: 'recent',
    workspaces: wsList,
    sessions: sessList,
    view: {
      getSnapshot: () => ({
        groupExpansion: {
          'dsh-au-remote-ws:dev-mac:ws-mac': true,
        },
      }),
      setGroupExpanded() {},
      retainAccountKeys(keys) {
        retainedKeysResult = keys;
      },
    },
    openSession(id) {
      localOpenedSession = id;
    },
    selectWorkspace() {},
    startSession() {},
  };
  const workspacesSvc = {
    list: wsList,
    pinSession: async () => {},
    unpinSession: async () => {},
    archiveSession: async () => {},
    unarchiveSession: async () => {},
    rename: async () => {},
    remove: async () => {},
  };
  const sessionsSvc = {
    list: sessList,
    rename: async () => {},
  };
  const uiSession = {
    sessionStatus: statusStore,
    statusListeners: new Set(),
  };

  // 注入一个拥有 7 条会话的远端工作区（验证前 5 条状态保留、第 6/7 条 done 不撑大初始 5 条水位线）
  helpers.store.devices = [{ id: 'dev-mac', name: 'mac' }];
  helpers.store.serverWorkspaces = [
    {
      deviceId: 'dev-mac',
      deviceName: 'mac',
      workspaceId: 'ws-mac',
      title: 'DemoApp',
      path: '/Users/mac/DemoApp',
      updatedAt: 8000,
      status: 'waiting',
      sessions: [
        { sessionId: 'm-1', title: '会话1', status: 'waiting', updatedAt: 8000, cwd: '/Users/mac/DemoApp' },
        { sessionId: 'm-2', title: '会话2', status: 'busy', updatedAt: 7000, cwd: '/Users/mac/DemoApp' },
        { sessionId: 'm-3', title: '会话3', status: 'done', updatedAt: 6000, cwd: '/Users/mac/DemoApp' },
        { sessionId: 'm-4', title: '会话4', status: 'error', updatedAt: 5000, cwd: '/Users/mac/DemoApp' },
        { sessionId: 'm-5', title: '会话5', status: 'idle', updatedAt: 4000, cwd: '/Users/mac/DemoApp' },
        { sessionId: 'm-6', title: '会话6', status: 'done', updatedAt: 3000, cwd: '/Users/mac/DemoApp' },
        { sessionId: 'm-7', title: '会话7', status: 'done', updatedAt: 2000, cwd: '/Users/mac/DemoApp' },
      ],
    },
  ];

  const dispose = helpers.installNativeWorkspaceBridge({
    uiWorkspace,
    workspaces: workspacesSvc,
    sessions: sessionsSvc,
    uiSession,
  });

  try {
    const mergedWsSnap = wsList.getSnapshot();
    assert.equal(mergedWsSnap.items.length, 3);
    // 按设备分组（本机优先，组内按最近更新排序）：local-newest (12000) -> local-older (2000) -> mac:DemoApp (8000)
    assert.deepEqual(
      mergedWsSnap.items.map((w) => w.workspaceId),
      ['ws-local-2', 'ws-local-1', 'dsh-au-remote-ws:dev-mac:ws-mac'],
    );
    const macWsItem = mergedWsSnap.items[2];
    assert.equal(macWsItem.path, 'mac · /Users/mac/DemoApp');
    assert.equal(macWsItem.sessionIds.length, 7);

    // 验证前 5 条会话的状态正常注入，而 index >= 5 的会话不注入 completionUnread，确保初始水位线恒为 5
    const statusMap = statusStore.getSnapshot();
    assert.equal(statusMap.get('m-1')?.pendingInteractionKind, 'approval');
    assert.equal(statusMap.get('m-2')?.running, true);
    assert.equal(statusMap.get('m-3')?.completionUnread, true);
    assert.equal(statusMap.get('m-4')?.completionUnread, true);
    assert.equal(statusMap.has('m-6'), false, 'sessions beyond index 4 must not force requiredWatermark above 5');
    assert.equal(statusMap.has('m-7'), false);

    // 验证点击远端会话通过 uiWorkspace.openSession 激活远端舞台，且本地会话 retainedBy.mainView 归零
    const origFetch = globalThis.fetch;
    const apiCalls = [];
    globalThis.fetch = async (url, init) => {
      apiCalls.push({ url, body: JSON.parse(init?.body || '{}') });
      return { json: async () => ({ ok: true }) };
    };
    try {
      uiWorkspace.openSession('m-1');
      assert.equal(helpers.store.activeDeviceId, 'dev-mac');
      assert.equal(helpers.store.selectedSessionByDevice.get('dev-mac'), 'm-1');
      assert.equal(localOpenedSession, null);

      const sessSnapAfterSelect = sessList.getSnapshot();
      assert.equal(sessSnapAfterSelect.byId['local-s1'].retainedBy.mainView, 0);
      assert.equal(sessSnapAfterSelect.byId['m-1'].retainedBy.mainView, 1);
      assert.equal(sessSnapAfterSelect.byId['m-1'].cwd, 'mac · /Users/mac/DemoApp');
      assert.equal(typeof sessSnapAfterSelect.byId['m-1'].updatedAt, 'number', 'updatedAt must be epoch ms number so relativeTime never produces NaN年');
      assert.equal(sessSnapAfterSelect.byId['m-1'].updatedAt, 8000);
      assert.equal(typeof sessSnapAfterSelect.byId['m-1'].createdAt, 'number');

      // 验证置顶、重命名、归档穿透
      await workspacesSvc.pinSession('m-5');
      assert.equal(wsList.getSnapshot().pinnedSessionIds.includes('m-5'), true);
      assert.equal(apiCalls.some((c) => c.body.action === 'remoteEntityAction' && c.body.entityAction === 'pinSession' && c.body.sessionId === 'm-5'), true);

      await sessionsSvc.rename('m-5', '重命名后的远端会话');
      assert.equal(sessList.getSnapshot().byId['m-5'].title, '重命名后的远端会话');

      await workspacesSvc.archiveSession('m-7');
      assert.equal(wsList.getSnapshot().items[1].sessionIds.includes('m-7'), false);

      // 验证 retainAccountKeys 保留远端工作区展开键
      uiWorkspace.view.retainAccountKeys(['', 'ws-local-1', 'ws-local-2']);
      assert.equal(retainedKeysResult.includes('dsh-au-remote-ws:dev-mac:ws-mac'), true);
    } finally {
      globalThis.fetch = origFetch;
    }

    // 验证 decorateNativeRemoteRows 为远端工作区行注入 [🖥 mac] 徽章、为错误态会话原生状态点添加 .dsh-au-state-dot-error
    const createdBadges = [];
    const textEl = { nextSibling: null };
    const mainBtn = {
      querySelector: (sel) => (sel === '[class*="_projectText"]' ? textEl : null),
      appendChild(el) { createdBadges.push(el); },
    };
    const wsRowEl = {
      attrs: { 'data-row-key': 'workspace:dsh-au-remote-ws:dev-mac:ws-mac' },
      getAttribute(k) { return this.attrs[k] || ''; },
      setAttribute(k, v) { this.attrs[k] = v; },
      querySelector(sel) {
        if (sel === '[class*="_projectMainButton"]') return mainBtn;
        return null;
      },
    };
    const dotClasses = new Set();
    const errorSessRowEl = {
      attrs: { 'data-row-key': 'session:m-4' },
      getAttribute(k) { return this.attrs[k] || ''; },
      setAttribute(k, v) { this.attrs[k] = v; },
      closest: () => null,
      querySelector(sel) {
        if (sel === '[class*="_stateDot"]') {
          return {
            classList: {
              add: (c) => dotClasses.add(c),
              remove: (c) => dotClasses.delete(c),
            },
          };
        }
        return null;
      },
    };
    helpers.decorateNativeRemoteRows({
      querySelectorAll(sel) {
        if (sel.startsWith('[data-row-key^="workspace:')) return [wsRowEl];
        if (sel === '[data-row-key^="session:"]') return [errorSessRowEl];
        return [];
      },
      createElement(tag) {
        return {
          tagName: tag,
          className: '',
          attrs: {},
          innerHTML: '',
          textContent: '',
          children: [],
          appendChild(child) { this.children.push(child); child.parentElement = this; },
          getAttribute(k) { return this.attrs[k] || ''; },
          setAttribute(k, v) { this.attrs[k] = v; },
        };
      },
    });
    assert.equal(createdBadges.length, 1);
    assert.equal(createdBadges[0].className, 'dsh-au-remote-ws-badge');
    assert.equal(createdBadges[0].children.some((node) => node.textContent === 'mac'), true);
    assert.equal(dotClasses.has('dsh-au-state-dot-error'), true);

    // 验证 setGroupExpanded 触发远端设备后台预加载事件
    const dispatchedEvents = helpers.__testWin.dispatchedEvents;
    dispatchedEvents.length = 0;
    const origCustomEvent = globalThis.CustomEvent;
    globalThis.CustomEvent = class CustomEvent {
      constructor(type, opts) {
        this.type = type;
        this.detail = opts?.detail;
      }
    };
    try {
      uiWorkspace.view.setGroupExpanded('dsh-au-remote-ws:dev-mac:ws-mac', true);
      assert.equal(
        dispatchedEvents.some((ev) => ev.type === 'dsh-au:preload-device' && ev.detail?.deviceId === 'dev-mac'),
        true,
        'expanding a remote workspace must trigger dsh-au:preload-device',
      );
      helpers.activateRemoteSession(
        { key: 'dev-mac:ws-mac', deviceId: 'dev-mac', deviceName: 'mac', workspaceId: 'ws-mac', title: 'DemoApp' },
        { sessionId: 'm-1', title: '会话 1', status: 'idle' },
      );
      assert.equal(
        dispatchedEvents.some((ev) => ev.type === 'dsh-au:stage-transition' && ev.detail?.active === true && ev.detail?.deviceId === 'dev-mac'),
        true,
        'activating a remote session must trigger dsh-au:stage-transition loading mask',
      );
      assert.equal(
        dispatchedEvents.some((ev) => ev.type === 'dsh-au:select-device' && ev.detail?.deviceId === 'dev-mac' && ev.detail?.skipInitialFocus === true),
        true,
        'activating a remote session must pass skipInitialFocus: true to prevent initialFocusController override',
      );
    } finally {
      globalThis.CustomEvent = origCustomEvent;
    }
  } finally {
    dispose();
  }
});

test('consecutive createNew clicks across different workspaces on a legacy remote peer always create session in the clicked workspace and clean up unused blank sessions', async () => {
  const helpers = loadClientHelpers();
  const postedMessages = [];
  const createdRequests = [];
  const fakeFrame = {
    name: 'dsh-au-controlled:example-mac',
    src: 'http://127.0.0.1:6831/',
    contentWindow: {
      postMessage(msg) {
        postedMessages.push(msg);
      },
    },
  };
  const fakeDoc = {
    querySelectorAll() {
      return [fakeFrame];
    },
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init?.body || '{}');
    if (url === '/dsh-au-todo/api' && body.action === 'createRemoteSession') {
      createdRequests.push(body);
      const isAuWin = String(body.cwd || '').includes('AuWin');
      return {
        json: async () => ({
          ok: true,
          sessionId: isAuWin ? 'session-auwin-new' : 'session-myhost-new',
          cwd: body.cwd,
        }),
      };
    }
    throw new Error(`unexpected url: ${url}`);
  };

  try {
    // 1. 第 1 次点击 DemoApp 的「+」
    const sid1 = await helpers.activateRemoteWorkspace(
      {
        key: 'example-mac:cwd:/Users/someone/Projects/AuOS/DemoApp',
        deviceId: 'example-mac',
        deviceName: 'mac',
        workspaceId: 'cwd:/Users/someone/Projects/AuOS/DemoApp',
        title: 'DemoApp',
        path: '/Users/someone/Projects/AuOS/DemoApp',
        sessions: [],
      },
      { createNew: true },
      fakeDoc,
    );
    assert.equal(sid1, 'session-myhost-new');
    assert.equal(helpers.hasLiveControlledSnapshot('example-mac'), false, 'optimistic injection must not masquerade as live controlled snapshot');

    // 2. 第 2 次点击 AuWin 的「+」：绝不能因上一次乐观注入而跳过 createRemoteBlankSession
    postedMessages.length = 0;
    const sid2 = await helpers.activateRemoteWorkspace(
      {
        key: 'example-mac:cwd:/Users/someone/Projects/AuOS/AuWin',
        deviceId: 'example-mac',
        deviceName: 'mac',
        workspaceId: 'cwd:/Users/someone/Projects/AuOS/AuWin',
        title: 'AuWin',
        path: '/Users/someone/Projects/AuOS/AuWin',
        sessions: [],
      },
      { createNew: true },
      fakeDoc,
    );
    assert.equal(sid2, 'session-auwin-new');
    assert.equal(createdRequests.length, 2);
    assert.equal(createdRequests[1].cwd, '/Users/someone/Projects/AuOS/AuWin');
    assert.equal(helpers.store.selectedSessionByDevice.get('example-mac'), 'session-auwin-new');
    assert.equal(
      postedMessages.some((m) => m.type === 'dsh-au-todo:select-session' && m.sessionId === 'session-auwin-new'),
      true,
      'second click on AuWin must send select-session for AuWin new session',
    );

    // 验证 DemoApp 下未发消息的「新对话」已被自动清理，只保留当前 AuWin 的「新对话」
    const snap = helpers.store.controlledSnapshots.get('example-mac');
    const myhostWs = snap.workspaces.find((w) => w.title === 'DemoApp');
    const auwinWs = snap.workspaces.find((w) => w.title === 'AuWin');
    assert.equal(myhostWs?.sessions?.length || 0, 0, 'unused optimistic blank session in DemoApp must be cleaned up');
    assert.equal(auwinWs?.sessions?.length, 1);
    assert.equal(auwinWs.sessions[0].sessionId, 'session-auwin-new');
    assert.equal(auwinWs.sessions[0].blank, true);

    // 3. 验证旧版远端 getLocalSessions 返回未携带 blank 的「未命名对话」时，synthesizeWorkspacesFromCards 会过滤空白卡片且 mergeRemoteWorkspaces 保持乐观「新对话」为 blank: true
    const synth = synthesizeWorkspacesFromCards([
      { sessionId: 'session-auwin-new', title: '未命名对话', summary: '', cwd: '/Users/someone/Projects/AuOS/AuWin', updatedAt: 1000, status: 'idle' },
      { sessionId: 'session-auwin-real', title: '配置远端访问', summary: '已配置', cwd: '/Users/someone/Projects/AuOS/AuWin', updatedAt: 900, status: 'idle' },
    ], { deviceId: 'example-mac', name: 'mac' });
    assert.equal(synth.length, 1);
    assert.deepEqual(synth[0].sessions.map((s) => s.sessionId), ['session-auwin-real'], 'blank 未命名对话 cards must be filtered out of synthesized workspaces');

    const merged = helpers.mergeRemoteWorkspaces(
      [
        {
          deviceId: 'example-mac',
          deviceName: 'mac',
          workspaceId: 'cwd:/Users/someone/Projects/AuOS/AuWin',
          title: 'AuWin',
          path: '/Users/someone/Projects/AuOS/AuWin',
          updatedAt: 1000,
          sessions: [
            { sessionId: 'session-auwin-new', title: '未命名对话', summary: '', status: 'idle', updatedAt: 1000 },
          ],
        },
      ],
      helpers.store.controlledSnapshots,
      [{ deviceId: 'example-mac', name: 'mac' }],
      new Set(),
    );
    const mergedAuwin = merged.visible.find((w) => w.title === 'AuWin');
    const mergedNewSess = mergedAuwin.sessions.find((s) => s.sessionId === 'session-auwin-new');
    assert.equal(mergedNewSess.title, '新对话');
    assert.equal(mergedNewSess.blank, true, 'unmessaged legacy 未命名对话 record must not flip optimistic 新对话 to non-blank');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('activateRemoteWorkspace injects 0ms optimistic 新对话 before RPC finishes, targets online routeId, caches resolvedWorkspaceId, and filters blank 未命名对话 in normalizeServerRemoteWorkspaces', async () => {
  const helpers = loadClientHelpers();
  helpers.store.devices = [
    {
      id: 'win',
      name: 'win',
      online: true,
      selectedRoute: { id: 'r_example_win_tunnel', online: true },
    },
  ];

  // 1. 验证 normalizeServerRemoteWorkspaces 过滤携带空 summary 的历史空白「未命名对话」
  const normalizedWs = helpers.normalizeServerRemoteWorkspaces({
    localDeviceId: 'local',
    remoteWorkspaces: [
      {
        deviceId: 'win',
        deviceName: 'win',
        workspaceId: 'cwd:F:/Projects/DemoApp',
        title: 'DemoApp',
        path: 'F:/Projects/DemoApp',
        updatedAt: 2000,
        sessions: [
          { sessionId: 's-blank-old', title: '未命名对话', summary: '', status: 'idle', updatedAt: 2000 },
          { sessionId: 's-real-1', title: '分析一下这个插件', summary: '好的', status: 'idle', updatedAt: 1800 },
        ],
      },
    ],
  }, helpers.store.devices);
  assert.equal(normalizedWs.length, 1);
  assert.deepEqual(normalizedWs[0].sessions.map((s) => s.sessionId), ['s-real-1']);

  // 2. 验证点击 + 时在 RPC 尚未返回前（0ms）已立即注入「新对话」占位，且请求使用在线 selectedRoute.id、上报诊断日志，并在第二次点击时复用缓存的真实 workspaceId
  let resolveFetch = null;
  const todoBodies = [];
  const diagBodies = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const body = JSON.parse(init?.body || '{}');
    if (url === '/dsh-au/api') {
      diagBodies.push(body);
      return Promise.resolve({ json: async () => ({ ok: true }) });
    }
    todoBodies.push({ url, body });
    return new Promise((resolve) => {
      resolveFetch = resolve;
    });
  };

  try {
    const targetWs = {
      key: 'win:cwd:F:/Projects/DemoApp',
      deviceId: 'win',
      deviceName: 'win',
      workspaceId: 'cwd:F:/Projects/DemoApp',
      title: 'DemoApp',
      path: 'F:/Projects/DemoApp',
      sessions: [],
    };
    const promise1 = helpers.activateRemoteWorkspace(targetWs, { createNew: true }, null);

    // 0ms 检查：尚未 resolveFetch 时，store.controlledSnapshots 已经挂载「新对话」占位并置为选中
    const immediateSnap = helpers.store.controlledSnapshots.get('win');
    assert.ok(immediateSnap, '0ms snapshot must exist before RPC resolves');
    assert.equal(immediateSnap.workspaces[0].sessions[0].title, '新对话');
    assert.equal(immediateSnap.workspaces[0].sessions[0].sessionId.startsWith('dsh-au-creating:'), true);
    assert.equal(helpers.store.selectedSessionByDevice.get('win'), immediateSnap.workspaces[0].sessions[0].sessionId);

    // 校验首次请求自动采用在线 routeId 'r_example_win_tunnel' 以跳过离线局域网路由
    assert.equal(todoBodies.length, 1);
    assert.equal(todoBodies[0].body.deviceId, 'r_example_win_tunnel');
    assert.equal(todoBodies[0].body.workspaceId, 'cwd:F:/Projects/DemoApp');

    resolveFetch({
      json: async () => ({
        ok: true,
        sessionId: 'session-win-created-1',
        workspaceId: 'ws-win-real-uuid',
        cwd: 'F:/Projects/DemoApp',
      }),
    });
    const sid1 = await promise1;
    assert.equal(sid1, 'session-win-created-1');
    assert.equal(helpers.store.selectedSessionByDevice.get('win'), 'session-win-created-1');
    assert.equal(helpers.store.controlledSnapshots.get('win').workspaces[0].sessions.length, 1);
    assert.equal(helpers.store.controlledSnapshots.get('win').workspaces[0].sessions[0].sessionId, 'session-win-created-1');

    // 校验客户端已上报 remote-session-create 耗时诊断日志
    assert.equal(diagBodies.length, 1);
    assert.equal(diagBodies[0].event, 'remote-session-create');
    assert.equal(diagBodies[0].deviceId, 'win');
    assert.equal(diagBodies[0].routeId, 'r_example_win_tunnel');
    assert.equal(diagBodies[0].sessionId, 'session-win-created-1');
    assert.equal(diagBodies[0].result, 'ok');
    assert.equal(typeof diagBodies[0].elapsedMs, 'number');

    // 第二次点击同一工作区 +：直接携带已缓存的真实 workspaceId 'ws-win-real-uuid'
    const promise2 = helpers.activateRemoteWorkspace(targetWs, { createNew: true }, null);
    assert.equal(todoBodies.length, 2);
    assert.equal(todoBodies[1].body.workspaceId, 'ws-win-real-uuid');
    resolveFetch({
      json: async () => ({
        ok: true,
        sessionId: 'session-win-created-2',
        workspaceId: 'ws-win-real-uuid',
        cwd: 'F:/Projects/DemoApp',
      }),
    });
    const sid2 = await promise2;
    assert.equal(sid2, 'session-win-created-2');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('confirmRemoteSessionOptimistically, activateRemoteSession, and autoConfirmActiveRemoteSession clear green/blue dot in 0ms and re-arm on next busy turn', async () => {
  const helpers = loadClientHelpers();
  helpers.store.devices = [
    {
      id: 'mac',
      name: 'mac',
      online: true,
      selectedRoute: { id: 'example-mac', online: true },
    },
  ];
  helpers.store.serverWorkspaces = [
    {
      deviceId: 'mac',
      deviceName: 'mac',
      workspaceId: 'ws-mac-1',
      title: 'DemoApp',
      path: '/Users/example/DemoApp',
      updatedAt: 3000,
      status: 'done',
      sessions: [
        {
          sessionId: 's-mac-done',
          title: '确认回复OK',
          status: 'done',
          completionUnread: true,
          updatedAt: 3000,
          cwd: '/Users/example/DemoApp',
        },
      ],
    },
  ];

  const confirmCalls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init?.body || '{}');
    if (url === '/dsh-au-todo/api' && body.action === 'confirmSession') {
      confirmCalls.push(body);
    }
    return { json: async () => ({ ok: true }) };
  };

  try {
    // 1) 点击会话行 activateRemoteSession：0ms 内立即清除 serverWorkspaces 中的 done 与 completionUnread，且使用在线 routeId 'example-mac'
    const mergedBefore = helpers.rebuildNativeRemoteRegistry();
    assert.equal(mergedBefore.visible[0].status, 'done');
    assert.equal(mergedBefore.visible[0].sessions[0].status, 'done');

    helpers.activateRemoteSession(mergedBefore.visible[0], mergedBefore.visible[0].sessions[0]);

    const mergedAfterClick = helpers.rebuildNativeRemoteRegistry();
    assert.equal(mergedAfterClick.visible[0].status, 'idle', 'workspace blue dot must clear in 0ms');
    assert.equal(mergedAfterClick.visible[0].sessions[0].status, 'idle', 'session done status must clear in 0ms');
    assert.equal(mergedAfterClick.visible[0].sessions[0].completionUnread, false, 'session green dot must clear in 0ms');
    assert.equal(confirmCalls.length, 1);
    assert.equal(confirmCalls[0].deviceId, 'example-mac');
    assert.equal(confirmCalls[0].sessionId, 's-mac-done');

    // 2) 在 15 秒乐观确认保护期内，即使后台轮询返回旧的 status: 'done'，也不会把绿灯/蓝灯重新点亮
    const stalePollNormalized = helpers.normalizeServerRemoteWorkspaces({
      localDeviceId: 'local',
      remoteWorkspaces: [
        {
          deviceId: 'mac',
          deviceName: 'mac',
          workspaceId: 'ws-mac-1',
          title: 'DemoApp',
          path: '/Users/example/DemoApp',
          updatedAt: 3000,
          sessions: [
            { sessionId: 's-mac-done', title: '确认回复OK', status: 'done', completionUnread: true, updatedAt: 3000 },
          ],
        },
      ],
    }, helpers.store.devices);
    assert.equal(stalePollNormalized[0].status, 'idle');
    assert.equal(stalePollNormalized[0].sessions[0].status, 'idle');
    assert.equal(stalePollNormalized[0].sessions[0].completionUnread, false);

    // 3) 当该会话发起新一轮对话进入 busy，再输出完成变为 done 时，若用户正停留在当前远端会话舞台上，autoConfirmActiveRemoteSession 立即自动消除绿灯
    const busyNormalized = helpers.normalizeServerRemoteWorkspaces({
      localDeviceId: 'local',
      remoteWorkspaces: [
        {
          deviceId: 'mac',
          deviceName: 'mac',
          workspaceId: 'ws-mac-1',
          title: 'DemoApp',
          path: '/Users/example/DemoApp',
          updatedAt: 4000,
          sessions: [
            { sessionId: 's-mac-done', title: '确认回复OK', status: 'busy', completionUnread: false, updatedAt: 4000 },
          ],
        },
      ],
    }, helpers.store.devices);
    assert.equal(busyNormalized[0].sessions[0].status, 'busy', 'entering busy must clear optimistic confirm lock');

    // 新一轮完成返回 done，此时用户正停留在 mac 的 s-mac-done 会话上
    helpers.store.serverWorkspaces = helpers.normalizeServerRemoteWorkspaces({
      localDeviceId: 'local',
      remoteWorkspaces: [
        {
          deviceId: 'mac',
          deviceName: 'mac',
          workspaceId: 'ws-mac-1',
          title: 'DemoApp',
          path: '/Users/example/DemoApp',
          updatedAt: 5000,
          sessions: [
            { sessionId: 's-mac-done', title: '确认回复OK', status: 'done', completionUnread: true, updatedAt: 5000 },
          ],
        },
      ],
    }, helpers.store.devices);
    assert.equal(helpers.store.serverWorkspaces[0].sessions[0].status, 'done');

    helpers.autoConfirmActiveRemoteSession({ visibilityState: 'visible', activeElement: null });
    const mergedAfterAuto = helpers.rebuildNativeRemoteRegistry();
    assert.equal(mergedAfterAuto.visible[0].status, 'idle');
    assert.equal(mergedAfterAuto.visible[0].sessions[0].status, 'idle');
    assert.equal(mergedAfterAuto.visible[0].sessions[0].completionUnread, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('CR fixes & Agents-Anywhere borrowings: controlled native completionUnread sync, unfocused window guard, stale probe done guard, rapid createNew race guard, parallel streaming anti-jitter, and lone surrogate sanitization', async (t) => {
  const helpers = loadClientHelpers();

  // 1. 孤立 UTF-16 代理项清洗：保留完整 Emoji（🚀），将截断的高/低代理项替换为 \uFFFD
  const brokenStr = `正常🚀文本\uD83D尾随\uDE80结束`;
  const cleanedBackend = sanitizeLoneSurrogates(brokenStr);
  const cleanedClient = helpers.sanitizeTextForSync(brokenStr);
  assert.equal(cleanedBackend, '正常🚀文本\uFFFD尾随\uFFFD结束');
  assert.equal(cleanedClient, '正常🚀文本\uFFFD尾随\uFFFD结束');

  // 2. 隐患一修复验证：受控端原生 uiSession.sessionStatus 的 completionUnread 被 markControlledSessionConfirmed 同步清理，15s 后不会死灰复燃
  const controlledStatusMap = new Map([
    ['s-ctrl-1', { running: false, completionUnread: true }],
  ]);
  const controlledCtx = {
    uiWorkspace: {
      workspaces: {
        list: {
          getSnapshot: () => ({
            items: [{ workspaceId: 'ws-c1', title: 'AuOS', path: '/Users/mac/AuOS', sessionIds: ['s-ctrl-1'] }],
          }),
        },
      },
      sessions: {
        list: {
          getSnapshot: () => ({
            byId: {
              's-ctrl-1': { id: 's-ctrl-1', displayTitle: '已完成对话', running: false, updatedAt: 5000 },
            },
          }),
        },
      },
    },
    uiSession: {
      sessionStatus: {
        getSnapshot: () => controlledStatusMap,
      },
    },
  };
  const snapBeforeConfirm = helpers.extractControlledWorkspacesSnapshot(controlledCtx);
  assert.equal(snapBeforeConfirm.workspaces[0].sessions[0].status, 'done');
  assert.equal(snapBeforeConfirm.workspaces[0].sessions[0].completionUnread, true);

  helpers.markControlledSessionConfirmed('s-ctrl-1', controlledCtx);
  assert.equal(controlledStatusMap.get('s-ctrl-1').completionUnread, false, 'native statusMap completionUnread must be cleared in-place');
  const snapAfterConfirm = helpers.extractControlledWorkspacesSnapshot(controlledCtx);
  assert.equal(snapAfterConfirm.workspaces[0].sessions[0].status, 'idle');
  assert.equal(Boolean(snapAfterConfirm.workspaces[0].sessions[0].completionUnread), false);

  // 3. 隐患二修复验证：后端 collectRemoteCardsAndWorkspaces 中，远端权威 cards 返回 idle 时，旧探针缓存的 done/error 不得反超覆盖 idle
  delete globalThis.__dshAuTodoApplyActive;
  let routeHandler = null;
  const disposeRoute = registerTodoRoutes({
    server: {
      register(spec) {
        routeHandler = spec.handler;
        return () => { routeHandler = null; };
      },
    },
    bridge: {
      getLocalDevice: () => ({ deviceId: 'local', name: '本机' }),
      listLocalSessions: async () => [],
      listLocalWorkspaces: async () => [],
      getDevices: async () => [
        {
          deviceId: 'dev-mac',
          name: 'mac',
          statusV2: 'done',
          // 模拟本机探针缓存滞留旧 done 与旧 busy；两者都不能覆盖本次权威 idle。
          sessionStatesV2: { 's-confirmed-idle': 'done', 's-live-busy': 'busy' },
        },
      ],
      requestDevice: async (devId, path, body) => {
        if (devId === 'dev-mac' && body.action === 'getLocalSessions') {
          return {
            ok: true,
            cards: [
              { sessionId: 's-confirmed-idle', title: '已读对话', status: 'idle', updatedAt: 8000, cwd: '/Users/mac/AuOS' },
              { sessionId: 's-live-busy', title: '运行中对话', status: 'idle', updatedAt: 9000, cwd: '/Users/mac/AuOS' },
            ],
            workspaces: [
              {
                workspaceId: 'ws-mac-auos',
                title: 'AuOS',
                path: '/Users/mac/AuOS',
                updatedAt: 9000,
                sessions: [
                  { sessionId: 's-confirmed-idle', title: '已读对话', status: 'idle', updatedAt: 8000, cwd: '/Users/mac/AuOS' },
                  { sessionId: 's-live-busy', title: '运行中对话', status: 'idle', updatedAt: 9000, cwd: '/Users/mac/AuOS' },
                ],
              },
            ],
          };
        }
        return { ok: false, httpStatus: 404 };
      },
    },
    isEnabled: () => true,
  });
  t.after(disposeRoute);

  let respBody = '';
  await routeHandler(
    {
      method: 'POST',
      setEncoding() {},
      on(ev, cb) {
        if (ev === 'data') cb(JSON.stringify({ action: 'getState' }));
        if (ev === 'end') cb();
      },
    },
    {
      writeHead() {},
      end(str) { respBody = str; },
    },
  );
  const parsedState = JSON.parse(respBody);
  const macWs = parsedState.remoteWorkspaces.find((w) => w.workspaceId === 'ws-mac-auos');
  assert.equal(
    macWs.sessions.find((s) => s.sessionId === 's-confirmed-idle').status,
    'idle',
    'stale probed done in sessionStatesV2 must NOT overwrite authoritative idle from remote cards',
  );
  assert.equal(
    macWs.sessions.find((s) => s.sessionId === 's-live-busy').status,
    'idle',
    'earlier probed busy in sessionStatesV2 must NOT overwrite authoritative idle',
  );

  // 4. 隐患三修复验证：当系统窗口失焦（doc.hasFocus() === false，如切到副屏其他软件）时，autoConfirmActiveRemoteSession 不得提前灭灯；待窗口重获焦点后再自动灭灯
  helpers.store.activeDeviceId = 'mac';
  helpers.store.selectedSessionByDevice.set('mac', 's-focus-test');
  helpers.store.activeInteractedSessions.add('s-focus-test');
  helpers.store.serverWorkspaces = [
    {
      deviceId: 'mac',
      deviceName: 'mac',
      workspaceId: 'ws-focus',
      title: 'AuOS',
      path: '/Users/mac/AuOS',
      updatedAt: 10000,
      status: 'done',
      sessions: [
        { sessionId: 's-focus-test', title: '后台跑完的任务', status: 'done', completionUnread: true, updatedAt: 10000 },
      ],
    },
  ];
  // 窗口处于失焦状态：绿灯与蓝灯必须保留
  helpers.autoConfirmActiveRemoteSession({
    visibilityState: 'visible',
    hasFocus: () => false,
    activeElement: { tagName: 'IFRAME', name: 'dsh-au-controlled:mac' },
  });
  assert.equal(helpers.store.serverWorkspaces[0].sessions[0].status, 'done', 'must NOT auto-clear light while browser window is unfocused');
  assert.equal(helpers.store.serverWorkspaces[0].sessions[0].completionUnread, true);

  // 用户切回窗口（hasFocus() === true）：立即自动灭灯
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ ok: true }) });
  try {
    helpers.autoConfirmActiveRemoteSession({
      visibilityState: 'visible',
      hasFocus: () => true,
      activeElement: { tagName: 'IFRAME', name: 'dsh-au-controlled:mac' },
    });
    assert.equal(helpers.store.serverWorkspaces[0].sessions[0].status, 'idle', 'must auto-clear light once window regains focus');
    assert.equal(helpers.store.serverWorkspaces[0].sessions[0].completionUnread, false);

    // 5. 隐患四修复验证：跨工作区快速连点「+」号时，先发起但后返回的旧请求不得抢夺后一个工作区的新会话焦点
    const resolvers = [];
    globalThis.fetch = (url, init) => {
      const body = JSON.parse(init?.body || '{}');
      if (url === '/dsh-au-todo/api' && body.action === 'createRemoteSession') {
        return new Promise((resolve) => {
          resolvers.push({ cwd: body.cwd, resolve });
        });
      }
      return Promise.resolve({ json: async () => ({ ok: true }) });
    };

    const pWsA = helpers.activateRemoteWorkspace(
      { key: 'mac:ws-a', deviceId: 'mac', deviceName: 'mac', workspaceId: 'ws-a', title: 'WorkspaceA', path: '/Users/mac/WsA', sessions: [] },
      { createNew: true },
      null,
    );
    const pWsB = helpers.activateRemoteWorkspace(
      { key: 'mac:ws-b', deviceId: 'mac', deviceName: 'mac', workspaceId: 'ws-b', title: 'WorkspaceB', path: '/Users/mac/WsB', sessions: [] },
      { createNew: true },
      null,
    );
    assert.equal(resolvers.length, 2);
    // 先让第 2 次点击（WorkspaceB）返回，再让第 1 次点击（WorkspaceA）返回
    resolvers[1].resolve({ json: async () => ({ ok: true, sessionId: 'sid-ws-b-real', cwd: '/Users/mac/WsB' }) });
    await pWsB;
    assert.equal(helpers.store.selectedSessionByDevice.get('mac'), 'sid-ws-b-real');

    resolvers[0].resolve({ json: async () => ({ ok: true, sessionId: 'sid-ws-a-stale', cwd: '/Users/mac/WsA' }) });
    await pWsA;
    assert.equal(
      helpers.store.selectedSessionByDevice.get('mac'),
      'sid-ws-b-real',
      'superseded createNew request for WorkspaceA must NOT hijack selectedSessionByDevice from WorkspaceB',
    );
  } finally {
    globalThis.fetch = origFetch;
  }

  // 6. Agents-Anywhere 借鉴项验证：多个远端会话并行流式输出（busy）时锁定相对排序，防止侧栏随每次 token 更新反复上下跳动
  helpers.store.busySortTsBySession.clear();
  const snapTick1 = helpers.mergeRemoteWorkspaces(
    [
      {
        deviceId: 'mac',
        deviceName: 'mac',
        workspaceId: 'ws-parallel',
        title: 'ParallelProj',
        path: '/Users/mac/ParallelProj',
        updatedAt: 2000,
        sessions: [
          { sessionId: 's-stream-1', title: '并行任务 1', status: 'busy', updatedAt: 2000 },
          { sessionId: 's-stream-2', title: '并行任务 2', status: 'busy', updatedAt: 1000 },
        ],
      },
    ],
    new Map(),
    [{ id: 'mac', name: 'mac' }],
    new Set(),
  );
  assert.deepEqual(snapTick1.visible[0].sessions.map((s) => s.sessionId), ['s-stream-1', 's-stream-2']);

  // 下一秒 s-stream-2 流式输出 token 导致 updatedAt (3000) 超过 s-stream-1 (2500)，但两者均仍在 busy：相对顺序必须保持稳定不跳动
  const snapTick2 = helpers.mergeRemoteWorkspaces(
    [
      {
        deviceId: 'mac',
        deviceName: 'mac',
        workspaceId: 'ws-parallel',
        title: 'ParallelProj',
        path: '/Users/mac/ParallelProj',
        updatedAt: 3000,
        sessions: [
          { sessionId: 's-stream-1', title: '并行任务 1', status: 'busy', updatedAt: 2500 },
          { sessionId: 's-stream-2', title: '并行任务 2', status: 'busy', updatedAt: 3000 },
        ],
      },
    ],
    new Map(),
    [{ id: 'mac', name: 'mac' }],
    new Set(),
  );
  assert.deepEqual(
    snapTick2.visible[0].sessions.map((s) => s.sessionId),
    ['s-stream-1', 's-stream-2'],
    'parallel busy sessions must keep stable relative order during streaming',
  );
});

test('cross-computer session confirmation sync: authoritative server idle suppresses stale controlled iframe unread and clears local session completionUnread', () => {
  const helpers = loadClientHelpers();
  helpers.store.recentBusyAtBySession.clear();

  // 1) 场景一：用户在电脑 A 已确认过对话（服务端通道 A 状态为 idle、completionUnread: false），
  //    切到电脑 B 时，电脑 B 后台受控 iframe 仍残留浏览器本地 completionUnread: true / status: 'done'。
  //    mergeRemoteWorkspaces 与 reconcileConfirmedSessionsWithServer 必须以服务端权威 idle 为准，直接灭掉绿点并通知受控 iframe。
  helpers.store.serverWorkspaces = [
    {
      deviceId: 'win',
      deviceName: 'win',
      workspaceId: 'ws-win-1',
      title: 'DemoApp',
      path: 'D:/Work/DemoApp',
      updatedAt: 5000,
      status: 'idle',
      sessions: [
        {
          sessionId: 's-already-confirmed-on-win',
          title: '优化远程访问与登录有效期',
          status: 'idle',
          completionUnread: false,
          updatedAt: 5000,
        },
        {
          sessionId: 's-still-unconfirmed',
          title: '尚未确认的新完成对话',
          status: 'done',
          completionUnread: true,
          updatedAt: 4000,
        },
      ],
    },
  ];
  helpers.store.controlledSnapshots.set('win', {
    fromControlledFrame: true,
    updatedAt: 5100,
    workspaces: [
      {
        workspaceId: 'ws-win-1',
        title: 'DemoApp',
        path: 'D:/Work/DemoApp',
        updatedAt: 5100,
        sessions: [
          {
            sessionId: 's-already-confirmed-on-win',
            title: '优化远程访问与登录有效期',
            status: 'done',
            completionUnread: true,
            updatedAt: 5000,
          },
          {
            sessionId: 's-still-unconfirmed',
            title: '尚未确认的新完成对话',
            status: 'done',
            completionUnread: true,
            updatedAt: 4000,
          },
          {
            sessionId: 's-live-busy-in-iframe',
            title: '正在运行的新任务',
            status: 'busy',
            completionUnread: false,
            updatedAt: 5100,
          },
        ],
      },
    ],
  });

  const merged = helpers.mergeRemoteWorkspaces(
    helpers.store.serverWorkspaces,
    helpers.store.controlledSnapshots,
    [{ id: 'win', name: 'win' }],
    new Set(),
  );
  const winWs = merged.visible[0];
  const confirmedSess = winWs.sessions.find((s) => s.sessionId === 's-already-confirmed-on-win');
  const unconfirmedSess = winWs.sessions.find((s) => s.sessionId === 's-still-unconfirmed');
  const liveBusySess = winWs.sessions.find((s) => s.sessionId === 's-live-busy-in-iframe');
  assert.equal(confirmedSess.status, 'idle', 'confirmed session on another computer must stay idle despite stale iframe done');
  assert.equal(confirmedSess.completionUnread, false, 'confirmed session on another computer must not relight completionUnread');
  assert.equal(unconfirmedSess.status, 'done', 'genuinely unconfirmed session must keep done status');
  assert.equal(unconfirmedSess.completionUnread, true);
  assert.equal(liveBusySess.status, 'busy', 'live busy session in controlled iframe must still surface immediately');

  // 验证 reconcileConfirmedSessionsWithServer 清理 controlledSnapshots 缓存并向受控 iframe 下发 dsh-au:confirm-remote-session
  const postedToIframe = [];
  const fakeDoc = {
    querySelectorAll() {
      return [
        {
          name: 'dsh-au-controlled:win',
          contentWindow: {
            postMessage(msg) {
              postedToIframe.push(msg);
            },
          },
        },
      ];
    },
  };
  const mutated = helpers.reconcileConfirmedSessionsWithServer(fakeDoc);
  assert.equal(mutated, true);
  const snapAfterReconcile = helpers.store.controlledSnapshots.get('win');
  const snapConfirmedSess = snapAfterReconcile.workspaces[0].sessions.find((s) => s.sessionId === 's-already-confirmed-on-win');
  assert.equal(snapConfirmedSess.status, 'idle');
  assert.equal(snapConfirmedSess.completionUnread, false);
  assert.equal(
    postedToIframe.some((m) => m.type === 'dsh-au:confirm-remote-session' && m.sessionId === 's-already-confirmed-on-win'),
    true,
    'reconcileConfirmedSessionsWithServer must notify controlled iframe to clear native completionUnread',
  );

  // 2) 场景二：若某条会话刚刚在受控端处于 busy（8 秒窗口内）并率先在受控端完成变为 done，
  //    此时服务端通道 A 尚未轮询刷新仍为 idle，必须保留新回合刚产生的 done 与 completionUnread: true
  helpers.store.controlledSnapshots.set('win', {
    fromControlledFrame: true,
    updatedAt: 5200,
    workspaces: [
      {
        workspaceId: 'ws-win-1',
        title: 'DemoApp',
        path: 'D:/Work/DemoApp',
        updatedAt: 5200,
        sessions: [
          {
            sessionId: 's-live-busy-in-iframe',
            title: '正在运行的新任务',
            status: 'done',
            completionUnread: true,
            updatedAt: 5200,
          },
        ],
      },
    ],
  });
  const mergedFreshFinish = helpers.mergeRemoteWorkspaces(
    [
      {
        deviceId: 'win',
        deviceName: 'win',
        workspaceId: 'ws-win-1',
        title: 'DemoApp',
        path: 'D:/Work/DemoApp',
        updatedAt: 5000,
        status: 'idle',
        sessions: [
          { sessionId: 's-live-busy-in-iframe', title: '正在运行的新任务', status: 'idle', completionUnread: false, updatedAt: 5000 },
        ],
      },
    ],
    helpers.store.controlledSnapshots,
    [{ id: 'win', name: 'win' }],
    new Set(),
  );
  const freshFinishedSess = mergedFreshFinish.visible[0].sessions.find((s) => s.sessionId === 's-live-busy-in-iframe');
  assert.equal(freshFinishedSess.status, 'done', 'session that just finished a live busy turn within 8s must light up immediately');
  assert.equal(freshFinishedSess.completionUnread, true);

  // 3) 场景三：本机某条对话已在另一台电脑上被远程确认过（本机后端 self.sessionStatesV2[sid] === 'idle'），
  //    回到本机查看时，installNativeWorkspaceBridge 的 statusStore.getSnapshot 与 syncControlledSessionsWithBackendState
  //    自动清除本机浏览器残留的 completionUnread 绿点。
  const localStatusMap = new Map([
    ['local-confirmed-remotely', { running: false, completionUnread: true }],
    ['local-still-done', { running: false, completionUnread: true }],
  ]);
  helpers.__testWin.__dshAuLastStateSnap = {
    self: {
      deviceId: 'mac',
      sessionStatesV2: {
        'local-confirmed-remotely': 'idle',
        'local-still-done': 'done',
      },
    },
    remotes: [],
  };
  const statusStore = {
    getSnapshot: () => localStatusMap,
    subscribe: () => () => {},
  };
  const disposeBridge = helpers.installNativeWorkspaceBridge({
    uiWorkspace: {
      orderBy: 'recent',
      openSession() {},
      selectWorkspace() {},
      startSession() {},
    },
    workspaces: {
      list: {
        getSnapshot: () => ({ phase: 'ready', items: [], pinnedSessionIds: [], archivedSessionIds: [] }),
        subscribe: () => () => {},
      },
    },
    sessions: {
      list: {
        getSnapshot: () => ({ ids: [], byId: {} }),
        subscribe: () => () => {},
      },
    },
    uiSession: {
      sessionStatus: statusStore,
    },
  });
  try {
    const snap = statusStore.getSnapshot();
    assert.equal(
      snap.get('local-confirmed-remotely')?.completionUnread,
      false,
      'local session confirmed remotely on another computer must have completionUnread cleared automatically',
    );
    assert.equal(
      localStatusMap.get('local-confirmed-remotely')?.completionUnread,
      false,
      'underlying native statusMap must also be updated to completionUnread: false',
    );
    assert.equal(
      snap.get('local-still-done')?.completionUnread,
      true,
      'local session still in done state on backend must keep completionUnread: true',
    );
  } finally {
    disposeBridge();
    delete helpers.__testWin.__dshAuLastStateSnap;
  }
});

test('workspace badge displays connection transport (Lan, ipv4, ipv6) and hides custom blue dot when status is done', async () => {
  const helpers = loadClientHelpers();

  // 1. 测试 mapTransportToBadgeLabel
  assert.equal(helpers.mapTransportToBadgeLabel('lan'), 'Lan');
  assert.equal(helpers.mapTransportToBadgeLabel('ipv6'), 'ipv6');
  assert.equal(helpers.mapTransportToBadgeLabel('tunnel'), 'ipv4');
  assert.equal(helpers.mapTransportToBadgeLabel('ipv4'), 'ipv4');
  assert.equal(helpers.mapTransportToBadgeLabel('local'), '');

  // 2. 测试 resolveDeviceConnectionTransport
  helpers.store.devices = [
    { id: 'dev-lan', name: 'win-box', selectedRoute: { transport: 'lan', online: true } },
    { id: 'dev-ipv6', name: 'mac-box', selectedRoute: { transport: 'ipv6', online: true } },
    { id: 'dev-tunnel', name: 'cloud-box', selectedRoute: { transport: 'tunnel', online: true } },
  ];
  assert.equal(helpers.resolveDeviceConnectionTransport('dev-lan'), 'Lan');
  assert.equal(helpers.resolveDeviceConnectionTransport('dev-ipv6'), 'ipv6');
  assert.equal(helpers.resolveDeviceConnectionTransport('dev-tunnel'), 'ipv4');

  // 3. 测试 decorateNativeRemoteRows：包含连接方式，且蓝灯隐藏
  helpers.store.serverWorkspaces = [
    {
      deviceId: 'dev-lan',
      deviceName: 'win-box',
      workspaceId: 'ws-lan',
      title: 'AuWin',
      status: 'done',
      sessions: [
        { sessionId: 's-done', title: '完成任务', status: 'done', completionUnread: true },
      ],
    },
  ];
  helpers.rebuildNativeRemoteRegistry();

  const createdBadges = [];
  const textEl = { nextSibling: null };
  const mainBtn = {
    querySelector: (sel) => (sel === '[class*="_projectText"]' ? textEl : null),
    appendChild(el) { createdBadges.push(el); },
  };
  const wsRowEl = {
    attrs: { 'data-row-key': `workspace:${helpers.toNativeRemoteWorkspaceId('dev-lan', 'ws-lan')}` },
    getAttribute(k) { return this.attrs[k] || ''; },
    setAttribute(k, v) { this.attrs[k] = v; },
    querySelector(sel) {
      if (sel === '[class*="_projectMainButton"]') return mainBtn;
      return null;
    },
  };

  const fakeDoc = {
    querySelectorAll(selector) {
      if (selector.startsWith(`[data-row-key^="workspace:${helpers.NATIVE_REMOTE_WS_PREFIX}"]`)) {
        return [wsRowEl];
      }
      return [];
    },
    createElement(tag) {
      return {
        tagName: tag,
        className: '',
        attrs: {},
        innerHTML: '',
        textContent: '',
        children: [],
        appendChild(child) { this.children.push(child); child.parentElement = this; },
        getAttribute(k) { return this.attrs[k] || ''; },
        setAttribute(k, v) { this.attrs[k] = v; },
      };
    },
  };

  helpers.decorateNativeRemoteRows(fakeDoc);

  assert.equal(createdBadges.length, 1);
  const mainBadge = createdBadges[0];
  assert.equal(mainBadge.className, 'dsh-au-remote-ws-badge');
  assert.equal(
    mainBadge.children.some((c) => c.className === 'dsh-au-remote-ws-badge-name' && c.textContent === 'win-box'),
    true,
    'badge must contain device name',
  );
  assert.equal(
    mainBadge.children.some((c) => c.className === 'dsh-au-remote-ws-badge-transport' && c.textContent === 'Lan'),
    true,
    'badge must contain Lan transport label',
  );
  assert.equal(
    mainBadge.children.some((c) => c.className === 'dsh-au-remote-ws-badge-sep' && c.textContent === '·'),
    true,
    'badge must contain separator dot',
  );
  assert.equal(
    mainBadge.children.some((c) => String(c.className).includes('dsh-au-remote-ws-badge-dot')),
    false,
    'custom blue dot must be hidden when workspace status is done',
  );
});

test('hero picker openWorkspace routes remote creation and navigation without local retain or draft migration', async (t) => {
  const helpers = loadClientHelpers();
  // 个人盘符路径改成示例路径，避免开源测试带真实目录指纹。
  const path = 'F:\\Projects\\HelperApp';
  helpers.store.devices = [{ id: 'win', name: 'win', selectedRoute: { id: 'win-route', online: true } }];
  helpers.store.serverWorkspaces = [{ deviceId: 'win', deviceName: 'win', workspaceId: path, path, title: 'AuWin', sessions: [] }];
  const localCalls = [];
  let localRetains = 0;
  let draftMigrations = 0;
  const sessions = { list: { getSnapshot: () => ({ byId: {} }) } };
  const workspaces = { list: { getSnapshot: () => ({ items: [], pinnedSessionIds: [], archivedSessionIds: [] }) } };
  // 模拟已核实的原生入口：openWorkspace 创建后直接 retain，并不经过 openSession。
  const uiWorkspace = {
    async openWorkspace(id, beforeOpen, options) {
      localCalls.push({ id, beforeOpen, options });
      localRetains += 1;
      beforeOpen?.();
    },
  };
  const beforeOpen = () => { draftMigrations += 1; };
  const dispose = helpers.installNativeWorkspaceBridge({ sessions, workspaces, uiWorkspace });
  t.after(dispose);
  const nativeId = workspaces.list.getSnapshot().items[0].workspaceId;
  assert.equal(nativeId, `dsh-au-remote-ws:win:${path}`);
  const remoteCalls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init?.body || '{}');
    if (body.action === 'createRemoteSession') remoteCalls.push({ url, body });
    return { json: async () => ({ ok: true, sessionId: 'remote-created', workspaceId: 'remote-real' }) };
  };

  const attempt = uiWorkspace.openWorkspace(nativeId, beforeOpen);
  assert.equal(typeof attempt.then, 'function', 'native owner expects a Promise with catch');
  await attempt;
  assert.equal(localCalls.length, 0, 'injected IDs must never reach local openWorkspace');
  assert.equal(localRetains, 0, 'remote sessions must not be retained by the local controller');
  assert.equal(draftMigrations, 0, 'the local draft callback must not run against a remote binding');
  assert.equal(remoteCalls.length, 1);
  assert.equal(remoteCalls[0].url, '/dsh-au-todo/api');
  assert.equal(remoteCalls[0].body.deviceId, 'win-route');
  assert.equal(remoteCalls[0].body.workspaceId, path);
  assert.equal(remoteCalls[0].body.cwd, path);
  assert.equal(helpers.store.activeDeviceId, 'win');
  assert.ok(helpers.rebuildNativeRemoteRegistry().visible[0].sessions.some((s) => s.sessionId === 'remote-created'));

  const options = { agentPreset: 'local-preset' };
  await uiWorkspace.openWorkspace('local-workspace', beforeOpen, options);
  assert.deepEqual(localCalls, [{ id: 'local-workspace', beforeOpen, options }]);
  assert.equal(localRetains, 1);
  assert.equal(draftMigrations, 1);
  await assert.rejects(uiWorkspace.openWorkspace('dsh-au-remote-ws:missing:unknown'), /远程工作区/);
  assert.equal(localCalls.length, 1, 'missing remote metadata must fail closed');
  dispose();
  await uiWorkspace.openWorkspace('local-workspace', beforeOpen, options);
  assert.equal(localCalls.length, 2, 'dispose must restore native navigation');
});

test('workspace picker groups by computer with stable same-name identities, native row order, footer and repeat decoration', () => {
  const helpers = loadClientHelpers();
  const picked = [];
  // 具有真实 DOM 移动语义的最小菜单：移动整行不改变点击闭包或原父节点。
  function node(tag = 'div', className = '') {
    return {
      tagName: tag.toUpperCase(), className, attrs: {}, children: [], parentElement: null, textContent: '',
      getAttribute(key) { return this.attrs[key] || ''; },
      setAttribute(key, value) { this.attrs[key] = String(value); },
      insertBefore(child, reference) {
        child.remove();
        const index = reference ? this.children.indexOf(reference) : this.children.length;
        assert.ok(index >= 0, 'reference must remain a direct child');
        this.children.splice(index, 0, child); child.parentElement = this;
      },
      appendChild(child) { this.insertBefore(child, null); },
      remove() {
        if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
        this.parentElement = null;
      },
      closest() { return this.parentElement?.className.includes('_itemWrap') ? this.parentElement : null; },
      querySelector(selector) {
        if (selector.includes('itemLabel')) return this.children.find((child) => child.className.includes('itemLabel')) || null;
        if (selector === '.dsh-au-menu-ws-badge') return this.children.find((child) => child.className.includes('dsh-au-menu-ws-badge')) || null;
        return null;
      },
      querySelectorAll(selector) {
        if (selector.includes('group-heading')) return this.children.filter((child) => child.className === 'dsh-au-menu-ws-group-heading');
        const descendants = this.children.flatMap((child) => [child, ...child.querySelectorAll(selector)]);
        return descendants.filter((child) => child.tagName === 'BUTTON' && child.getAttribute('role') === 'menuitem');
      },
    };
  }
  const menu = node(); menu.setAttribute('role', 'menu');
  const viewport = node(); const footer = node(); menu.appendChild(viewport); menu.appendChild(footer);
  const ws = (id, title, deviceId = '') => ({ workspaceId: id, title, ...(deviceId ? { __dshAuRemote: true, remoteDeviceId: deviceId, remoteDeviceName: deviceId } : {}) });
  helpers.store.combinedWorkspaces = [ws('win-au', 'AuWin', 'win'), ws('local-au', 'AuWin'), ws('mac-au', 'AuWin', 'mac'), ws('win-default', '默认工作区', 'win'), ws('local-other', 'DemoApp')];
  helpers.store.devices = [{ id: 'win', selectedRoute: { transport: 'ipv4' } }, { id: 'mac', selectedRoute: { transport: 'ipv6' } }];
  const buttons = new Map();
  for (const workspace of helpers.store.combinedWorkspaces) {
    const row = node('div', 'native_itemWrap'); const btn = node('button'); const label = node('span', 'native_itemLabel');
    btn.setAttribute('role', 'menuitem'); label.textContent = workspace.title;
    btn.appendChild(label); row.appendChild(btn); viewport.appendChild(row);
    btn.click = () => picked.push(workspace.workspaceId);
    buttons.set(workspace.workspaceId, btn);
  }
  const add = node('button'); add.setAttribute('role', 'menuitem'); add.textContent = '添加工作区'; footer.appendChild(add);
  const doc = { querySelectorAll: () => [menu], createElement: (tag) => node(tag) };
  helpers.decorateWorkspacePickerMenu(doc);
  const order = () => viewport.querySelectorAll('button[role="menuitem"]').map((btn) => btn.getAttribute('data-dsh-au-picker-workspace-id'));
  assert.deepEqual(order(), ['local-au', 'local-other', 'mac-au', 'win-au', 'win-default']);
  const headings = viewport.querySelectorAll(':scope > .dsh-au-menu-ws-group-heading');
  assert.deepEqual(headings.map((heading) => heading.textContent), ['本机', 'mac · ipv6', 'win · ipv4']);
  assert.equal(add.parentElement, footer, 'pinned add-workspace footer must stay outside groups');
  assert.equal(add.getAttribute('data-dsh-au-picker-workspace-id'), '');
  for (const id of order()) {
    const btn = buttons.get(id); btn.click();
    assert.equal(btn.parentElement.parentElement, viewport, 'React-owned row stays in its original viewport');
    assert.ok(headings.some((heading) => heading.getAttribute('id') === btn.getAttribute('aria-describedby')));
  }
  assert.deepEqual(picked, order(), 'visual and native DOM keyboard/click order must agree');
  const headingIds = headings.map((heading) => heading.getAttribute('id'));
  helpers.decorateWorkspacePickerMenu(doc);
  assert.deepEqual(order(), ['local-au', 'local-other', 'mac-au', 'win-au', 'win-default']);
  assert.deepEqual(viewport.querySelectorAll(':scope > .dsh-au-menu-ws-group-heading').map((heading) => heading.getAttribute('id')), headingIds, 'repeat observation must not recreate headings');
  assert.equal(buttons.get('win-au').getAttribute('data-dsh-au-picker-workspace-id'), 'win-au');

  // 原生 React 按 key 把新行插到旧源列表首项前；分组后它已不是视觉首位，也不能靠 DOM 下标识别。
  const added = ws('other-au', 'AuWin', 'other');
  helpers.store.combinedWorkspaces = [added, ...helpers.store.combinedWorkspaces];
  const addedRow = node('div', 'native_itemWrap'); const addedButton = node('button'); const addedLabel = node('span', 'native_itemLabel');
  addedButton.setAttribute('role', 'menuitem'); addedLabel.textContent = 'AuWin';
  addedButton.appendChild(addedLabel); addedRow.appendChild(addedButton);
  viewport.insertBefore(addedRow, buttons.get('win-au').parentElement);
  helpers.decorateWorkspacePickerMenu(doc);
  assert.equal(addedButton.getAttribute('data-dsh-au-picker-workspace-id'), 'other-au');
  assert.deepEqual(order(), ['local-au', 'local-other', 'mac-au', 'other-au', 'win-au', 'win-default']);
  // 远端设备的最后两行移除后，其分组标题也必须消失，其他原生行不能被回收。
  helpers.store.combinedWorkspaces = helpers.store.combinedWorkspaces.filter((workspace) => workspace.remoteDeviceId !== 'win');
  buttons.get('win-au').parentElement.remove(); buttons.get('win-default').parentElement.remove();
  helpers.decorateWorkspacePickerMenu(doc);
  assert.deepEqual(order(), ['local-au', 'local-other', 'mac-au', 'other-au']);
  assert.deepEqual(viewport.querySelectorAll(':scope > .dsh-au-menu-ws-group-heading').map((heading) => heading.textContent), ['本机', 'mac · ipv6', 'other']);

  // 同数量但不匹配的普通菜单不能被当成工作区列表。
  buttons.get('local-au').children[0].textContent = '删除会话';
  const before = [...viewport.children];
  helpers.decorateWorkspacePickerMenu(doc);
  assert.deepEqual(viewport.children, before);
});

test('decorateWorkspacePickerMenu decorates remote workspaces in new session dropdown and skips local ones', async () => {
  const helpers = loadClientHelpers();

  helpers.store.devices = [
    { id: 'win', name: 'win', selectedRoute: { transport: 'lan', online: true } },
    { id: 'mac', name: 'mac', selectedRoute: { transport: 'ipv6', online: true } },
  ];

  helpers.store.combinedWorkspaces = [
    {
      workspaceId: 'local-1',
      title: 'DemoApp',
      __dshAuRemote: false,
    },
    {
      workspaceId: 'dsh-au-remote-ws:win:ws-auwin',
      title: 'AuWin',
      __dshAuRemote: true,
      remoteDeviceId: 'win',
      remoteDeviceName: 'win',
    },
    {
      workspaceId: 'dsh-au-remote-ws:mac:ws-mac-auwin',
      title: 'AuWin',
      __dshAuRemote: true,
      remoteDeviceId: 'mac',
      remoteDeviceName: 'mac',
    },
  ];

  const makeBtn = (labelText, hasCheck = false) => {
    const btn = {
      tagName: 'BUTTON',
      attrs: { role: 'menuitem' },
      children: [],
      textContent: labelText,
      appendChild(child) { this.children.push(child); child.parentElement = this; },
      insertBefore(child, ref) {
        const idx = this.children.indexOf(ref);
        if (idx >= 0) this.children.splice(idx, 0, child);
        else this.children.push(child);
        child.parentElement = this;
      },
      getAttribute(k) { return this.attrs[k] || ''; },
      setAttribute(k, v) { this.attrs[k] = v; },
      querySelector(sel) {
        if (sel === '.dsh-au-menu-ws-badge') {
          return this.children.find((c) => c.className?.includes('dsh-au-menu-ws-badge')) || null;
        }
        if (sel.includes('itemLabel')) {
          return { textContent: labelText };
        }
        if (sel.includes('check') && hasCheck) {
          return { parentElement: this };
        }
        return null;
      },
    };
    return btn;
  };

  const btnLocal = makeBtn('DemoApp', true);
  const btnRemoteWin = makeBtn('AuWin', false);
  const btnRemoteMac = makeBtn('AuWin', false);
  const btnAdd = makeBtn('添加工作区', false);

  const menuEl = {
    attrs: { role: 'menu' },
    querySelectorAll(sel) {
      if (sel === 'button[role="menuitem"]') {
        return [btnLocal, btnRemoteWin, btnRemoteMac, btnAdd];
      }
      return [];
    },
  };

  const fakeDoc = {
    querySelectorAll(sel) {
      if (sel.includes('[role="menu"]')) {
        return [menuEl];
      }
      return [];
    },
    createElement(tag) {
      return {
        tagName: tag,
        className: '',
        attrs: {},
        children: [],
        innerHTML: '',
        textContent: '',
        appendChild(child) { this.children.push(child); child.parentElement = this; },
        getAttribute(k) { return this.attrs[k] || ''; },
        setAttribute(k, v) { this.attrs[k] = v; },
      };
    },
  };

  helpers.decorateWorkspacePickerMenu(fakeDoc);

  // 1. 本地项不应该被注入徽章
  assert.equal(btnLocal.children.some((c) => c.className?.includes('dsh-au-menu-ws-badge')), false);

  // 2. 远端 Win 项应该注入带 win 和 Lan 的徽章
  const winBadge = btnRemoteWin.children.find((c) => c.className?.includes('dsh-au-menu-ws-badge'));
  assert.ok(winBadge, 'remote win item must have badge');
  assert.equal(winBadge.children.some((c) => c.className === 'dsh-au-remote-ws-badge-name' && c.textContent === 'win'), true);
  assert.equal(winBadge.children.some((c) => c.className === 'dsh-au-remote-ws-badge-transport' && c.textContent === 'Lan'), true);

  // 3. 远端 Mac 项应该注入带 mac 和 ipv6 的徽章，即使它也叫 AuWin
  const macBadge = btnRemoteMac.children.find((c) => c.className?.includes('dsh-au-menu-ws-badge'));
  assert.ok(macBadge, 'remote mac item must have badge');
  assert.equal(macBadge.children.some((c) => c.className === 'dsh-au-remote-ws-badge-name' && c.textContent === 'mac'), true);
  assert.equal(macBadge.children.some((c) => c.className === 'dsh-au-remote-ws-badge-transport' && c.textContent === 'ipv6'), true);

  // 4. “添加工作区”按钮不应该被误注入徽章
  assert.equal(btnAdd.children.some((c) => c.className?.includes('dsh-au-menu-ws-badge')), false);
});

test('installNativeWorkspaceBridge resets accidental manual session order lock and scrollSidebarToSession never clicks overflow button', () => {
  const helpers = loadClientHelpers();
  let viewState = {
    orderBy: 'manual',
    groupExpansion: {},
    sessionOrderByAccount: { 'ws-local': ['old-1', 'old-2', 'active-30m'] },
  };
  const wsList = {
    getSnapshot: () => ({
      phase: 'ready',
      items: [{ workspaceId: 'ws-local', title: 'DemoApp', path: 'D:/DemoApp', sessionIds: ['old-1', 'old-2', 'active-30m'] }],
      pinnedSessionIds: [],
      archivedSessionIds: [],
    }),
    subscribe: () => () => {},
  };
  const sessList = {
    getSnapshot: () => ({
      ids: ['old-1', 'old-2', 'active-30m'],
      byId: {
        'old-1': { id: 'old-1', title: 'Au 全总结', updatedAt: 1000, lastPromptAt: 1000 },
        'old-2': { id: 'old-2', title: '本轮运行失败 503', updatedAt: 900, lastPromptAt: 900 },
        'active-30m': { id: 'active-30m', title: 'DSH-AU 后台 CPU 占用', updatedAt: 5000, lastPromptAt: 5000 },
      },
    }),
    subscribe: () => () => {},
  };
  const uiWorkspace = {
    workspaces: wsList,
    sessions: sessList,
    view: {
      getSnapshot: () => viewState,
      setOrderBy(mode) { viewState = { ...viewState, orderBy: mode, sessionOrderByAccount: {} }; },
      setSessionOrder(acc, order) { viewState = { ...viewState, orderBy: 'manual', sessionOrderByAccount: { [acc]: order } }; },
      setGroupExpanded(key, expanded) { viewState.groupExpansion[key] = expanded; },
    },
  };
  const dispose = helpers.installNativeWorkspaceBridge({ uiWorkspace, workspaces: { list: wsList }, sessions: { list: sessList } });
  try {
    assert.equal(uiWorkspace.view.getSnapshot().orderBy, 'updated');
    assert.deepEqual(uiWorkspace.view.getSnapshot().sessionOrderByAccount, {});
    uiWorkspace.view.setSessionOrder('ws-local', ['old-2', 'active-30m', 'old-1']);
    assert.equal(uiWorkspace.view.getSnapshot().orderBy, 'updated', 'accidental micro-drag must not re-lock manual session order');
    assert.deepEqual(wsList.getSnapshot().items[0].sessionIds, ['active-30m', 'old-1', 'old-2']);

    let overflowClicked = 0;
    let scrolled = 0;
    const fakeDoc = {
      querySelector(sel) {
        if (sel === '[data-row-key="session:active-30m"]') {
          return { scrollIntoView() { scrolled += 1; } };
        }
        return {
          closest: () => ({
            querySelectorAll: () => [{ textContent: '展开其余 66 个会话', click() { overflowClicked += 1; } }],
          }),
        };
      },
    };
    helpers.scrollSidebarToSession('active-30m', { isLocal: true }, fakeDoc);
    assert.equal(scrolled, 1);
    assert.equal(overflowClicked, 0, 'switching sessions must never click the overflow expand button');
  } finally {
    dispose();
  }
});

test('workspace picker groups by computer with disambiguated titles and paths across machines', () => {
  const helpers = loadClientHelpers();

  function node(tag = 'div', className = '') {
    return {
      tagName: tag.toUpperCase(),
      className,
      attrs: {},
      children: [],
      parentElement: null,
      textContent: '',
      getAttribute(key) { return this.attrs[key] || ''; },
      setAttribute(key, value) { this.attrs[key] = String(value); },
      insertBefore(child, reference) {
        child.remove();
        const index = reference ? this.children.indexOf(reference) : this.children.length;
        assert.ok(index >= 0, 'reference must remain a direct child');
        this.children.splice(index, 0, child);
        child.parentElement = this;
      },
      appendChild(child) { this.insertBefore(child, null); },
      remove() {
        if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
        this.parentElement = null;
      },
      closest() {
        let p = this.parentElement;
        while (p) {
          if (p.className && (p.className.includes('_itemWrap') || p.className.includes('itemWrap'))) return p;
          p = p.parentElement;
        }
        return null;
      },
      querySelector(selector) {
        for (const child of this.children) {
          if (selector.includes('itemLabel') && child.className?.includes('itemLabel')) return child;
          if (selector.includes('disambiguated') && child.className?.includes('disambiguated')) return child;
          if (selector.includes('title') && child.className?.includes('title')) return child;
          if (selector.includes('pathSuffix') && child.className?.includes('pathSuffix')) return child;
          if (selector === '.dsh-au-menu-ws-badge' && child.className?.includes('dsh-au-menu-ws-badge')) return child;
          const found = child.querySelector?.(selector);
          if (found) return found;
        }
        return null;
      },
      querySelectorAll(selector) {
        if (selector.includes('group-heading')) return this.children.filter((child) => child.className === 'dsh-au-menu-ws-group-heading');
        const descendants = this.children.flatMap((child) => [child, ...child.querySelectorAll(selector)]);
        return descendants.filter((child) => child.tagName === 'BUTTON' && child.getAttribute('role') === 'menuitem');
      },
    };
  }

  helpers.store.devices = [
    { id: 'mac', name: 'MacBook Pro', selectedRoute: { transport: 'lan', online: true } },
  ];

  const wsList = [
    {
      workspaceId: 'local-demo-app',
      title: 'demo-app',
      path: 'D:\\Projects\\Workspace\\demo-app',
      __dshAuRemote: false,
    },
    {
      workspaceId: 'remote-demo-app',
      title: 'demo-app',
      path: '/Users/demo/Workspace/demo-app',
      __dshAuRemote: true,
      remoteDeviceId: 'mac',
      remoteDeviceName: 'MacBook Pro',
    },
    {
      workspaceId: 'local-default',
      title: 'default-workspace',
      path: 'C:\\Users\\demo\\.dsh\\default',
      __dshAuRemote: false,
    },
    {
      workspaceId: 'remote-default',
      title: 'default-workspace',
      path: '/Users/demo/.dsh/default',
      __dshAuRemote: true,
      remoteDeviceId: 'mac',
      remoteDeviceName: 'MacBook Pro',
    },
  ];
  helpers.store.combinedWorkspaces = wsList;

  const menu = node('div');
  menu.setAttribute('role', 'menu');
  const viewport = node('div', 'native_viewport');
  menu.appendChild(viewport);

  // 模拟 DSH 原生对同名工作区生成的 disambiguated DOM 结构
  const buttonMap = new Map();
  for (const ws of wsList) {
    const row = node('div', 'native_itemWrap');
    const btn = node('button');
    btn.setAttribute('role', 'menuitem');
    const itemLabel = node('span', 'native_itemLabel');

    const disambiguated = node('span', 'xWovGG_disambiguated');
    disambiguated.setAttribute('title', ws.path);
    const titleNode = node('span', 'xWovGG_title');
    titleNode.textContent = ws.title === 'default-workspace' ? '默认工作区' : ws.title;
    const suffixNode = node('span', 'xWovGG_pathSuffix');
    suffixNode.textContent = ws.path.includes('\\') ? ws.path.split('\\').slice(-2).join('\\') : ws.path.split('/').slice(-2).join('/');

    disambiguated.appendChild(titleNode);
    disambiguated.appendChild(suffixNode);
    itemLabel.appendChild(disambiguated);
    btn.appendChild(itemLabel);
    row.appendChild(btn);
    viewport.appendChild(row);

    buttonMap.set(ws.workspaceId, btn);
  }

  const doc = { querySelectorAll: () => [menu], createElement: (tag) => node(tag) };
  helpers.decorateWorkspacePickerMenu(doc);

  // 1. 必须生成分组头，且本机在前，远端在后
  const headings = viewport.querySelectorAll(':scope > .dsh-au-menu-ws-group-heading');
  assert.equal(headings.length, 2, 'must render two computer group headings');
  assert.deepEqual(headings.map((h) => h.textContent), ['本机', 'MacBook Pro · Lan']);
  assert.equal(headings[0].getAttribute('data-dsh-au-group-first'), 'true');

  // 2. 每个按钮必须准确对应其设备并打上正确的工作区 ID
  assert.equal(buttonMap.get('local-demo-app').getAttribute('data-dsh-au-picker-workspace-id'), 'local-demo-app');
  assert.equal(buttonMap.get('remote-demo-app').getAttribute('data-dsh-au-picker-workspace-id'), 'remote-demo-app');
  assert.equal(buttonMap.get('local-default').getAttribute('data-dsh-au-picker-workspace-id'), 'local-default');
  assert.equal(buttonMap.get('remote-default').getAttribute('data-dsh-au-picker-workspace-id'), 'remote-default');

  // 3. 验证视觉与 DOM 顺序：本机组包含 local-demo-app 与 local-default，远端组包含 remote-demo-app 与 remote-default
  const currentButtons = viewport.children
    .filter((c) => c.className === 'native_itemWrap')
    .map((row) => row.children[0].getAttribute('data-dsh-au-picker-workspace-id'));
  assert.deepEqual(currentButtons, ['local-demo-app', 'local-default', 'remote-demo-app', 'remote-default']);
});

test('selectRouteForCurrentAccess prefers confirmed ready route over unknown route to avoid startup/reconnect route jitter', () => {
  const routesSrc = readFileSync(new URL('../client/src/03-routes.js', import.meta.url), 'utf8');
  const mod = { exports: {} };
  const fn = new Function('module', 'exports', `
    function formatRouteBadge() { return ''; }
    function buildRemoteTargetUrl(r) { return r.url || ''; }
    ${routesSrc}
    module.exports = { selectRouteForCurrentAccess };
  `);
  fn(mod, mod.exports);
  const { selectRouteForCurrentAccess } = mod.exports;

  // tunnel 已探活成功（idle），lan 仍在探活超时中（status: 'unknown'）：不得切往 unknown 的 lan
  const duringProbe = selectRouteForCurrentAccess([
    { id: 'lan_mac', transport: 'lan', status: 'unknown', online: true },
    { id: 'r_tunnel', transport: 'tunnel', status: 'idle', online: true },
    { id: 'r_ipv6', transport: 'ipv6', status: 'offline', online: false },
  ], 'local');
  assert.equal(duringProbe.id, 'r_tunnel');

  // 当所有路由都还在 unknown 时，仍回退到优先级最高的 lan
  const allUnknown = selectRouteForCurrentAccess([
    { id: 'lan_mac', transport: 'lan', status: 'unknown', online: true },
    { id: 'r_tunnel', transport: 'tunnel', status: 'unknown', online: true },
  ], 'local');
  assert.equal(allUnknown.id, 'lan_mac');

  // lan 探活成功变为 idle 后，切往更优的 lan
  const lanReady = selectRouteForCurrentAccess([
    { id: 'lan_mac', transport: 'lan', status: 'idle', online: true },
    { id: 'r_tunnel', transport: 'tunnel', status: 'idle', online: true },
  ], 'local');
  assert.equal(lanReady.id, 'lan_mac');
});



