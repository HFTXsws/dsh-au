import './isolate-net-log.mjs';
import './isolate-sync.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installGoalCreationPolicy } from '../lib/goal-creation-policy.js';
import { loadConfig, saveConfig } from '../lib/config-store.js';

/** 外部 DSH SDK 边界 fake：模拟全局单调 guard、嵌套工具调度及注入作用域卸载，不 mock 本项目内部模块。 */
function createHost({ guardSupported = true, promptSupported = true, autoTools = true } = {}) {
  const guards = new Set();
  const contexts = new Map();
  const injections = [];
  const scopes = [];
  const state = {
    goal: { id: 'existing-goal', revision: 2, action: 'pause', objective: 'Existing work' },
    created: [],
    driver: { running: true },
    session: { id: 'existing-session', status: 'idle' },
  };
  const tools = guardSupported ? {
    guard(check) { guards.add(check); return () => guards.delete(check); },
  } : {};
  const systemPrompt = promptSupported ? {
    context(entry) { contexts.set(entry.name, entry); return () => contexts.delete(entry.name); },
  } : {};
  function scope(services = {}) {
    const disposers = [];
    const ctx = {
      ...services,
      effect(setup) {
        const dispose = setup();
        if (typeof dispose === 'function') disposers.push(dispose);
      },
      dispose() { for (const dispose of disposers.splice(0).reverse()) dispose(); },
    };
    scopes.push(ctx);
    return ctx;
  }
  const ctx = scope({
    get: () => undefined,
    on: () => () => {},
    inject(deps, setup) {
      injections.push({ deps, setup });
      if (deps[0] === 'tools' && autoTools) setup(scope({ tools }));
      if (deps[0] === 'systemPrompt') setup(scope({ systemPrompt }));
    },
  });
  function execute(name, args = {}, agent) {
    const exec = { name, arguments: args, agent };
    for (const check of guards) {
      const reason = check(exec);
      if (typeof reason === 'string') return { ok: false, denied: true, reason };
    }
    // 真实目标状态由宿主所有；这些本地记录仅观察被拒绝调用是否到达宿主副作用边界。
    if (name === 'create_goal') {
      state.created.push({ ...args });
      return { ok: true };
    }
    if (name === 'get_goal') return { ok: true, goal: structuredClone(state.goal) };
    if (name === 'update_goal') {
      state.goal = { ...state.goal, ...args, revision: state.goal.revision + 1 };
      return { ok: true, goal: structuredClone(state.goal) };
    }
    if (name === 'multi_tool_use.parallel' || name === 'run_code') {
      return { ok: true, results: args.calls.map((call) => execute(call.name, call.arguments, agent)) };
    }
    return { ok: true, name };
  }
  return {
    ctx, state, tools, execute,
    prompt: () => [...contexts.values()].map((entry) => entry.text()).filter(Boolean).join('\n'),
    activate(name, services) {
      const entry = injections.find((item) => item.deps[0] === name);
      const child = scope(services);
      entry.setup(child);
      return child;
    },
    dispose() { for (const child of scopes.splice(0).reverse()) child.dispose(); },
  };
}

test('enabled global policy blocks only exact create_goal with no host goal, driver or session side effects', async (t) => {
  for (const agent of [{ id: 'root' }, { id: 'child', parent: { id: 'root' } }, undefined]) {
    await t.test(agent?.id || 'unscoped dispatch', (t) => {
      const host = createHost();
      t.after(() => host.dispose());
      installGoalCreationPolicy(host.ctx, () => ({ features: { blockGoalCreation: true } }));
      const before = structuredClone(host.state);
      const result = host.execute('create_goal', { objective: 'Must not reach host' }, agent);
      assert.equal(result.denied, true);
      assert.equal(typeof result.reason, 'string');
      assert.deepEqual(host.state, before);
      for (const name of ['get_goal', 'create_goal_extra', 'other_tool']) {
        assert.equal(host.execute(name).ok, true, name);
      }
      assert.deepEqual(host.state, before);
    });
  }
});

test('existing goal updates including resume retain native state transitions while blocking remains enabled', async (t) => {
  for (const action of ['edit', 'pause', 'resume', 'complete', 'blocked']) {
    await t.test(action, (t) => {
      const host = createHost();
      t.after(() => host.dispose());
      installGoalCreationPolicy(host.ctx, () => ({ features: { blockGoalCreation: true } }));
      const before = structuredClone(host.state);
      assert.deepEqual(host.execute('get_goal').goal, before.goal);
      assert.equal(host.execute('update_goal', { action }).ok, true);
      assert.deepEqual(host.execute('get_goal').goal, { ...before.goal, action, revision: 3 });
      assert.deepEqual(host.state.driver, before.driver);
      assert.deepEqual(host.state.session, before.session);
      assert.deepEqual(host.state.created, []);
    });
  }
});

test('nested parallel and code-dispatch calls cannot bypass global creation denial', async (t) => {
  for (const name of ['multi_tool_use.parallel', 'run_code']) {
    await t.test(name, (t) => {
      const host = createHost();
      t.after(() => host.dispose());
      installGoalCreationPolicy(host.ctx, () => ({ features: { blockGoalCreation: true } }));
      const result = host.execute(name, { calls: [
        { name: 'create_goal', arguments: { objective: 'Nested create' } },
        { name: 'update_goal', arguments: { action: 'resume' } },
        { name: 'get_goal' },
      ] });
      assert.equal(result.results[0].denied, true);
      assert.equal(result.results[1].ok, true);
      assert.equal(result.results[2].goal.action, 'resume');
      assert.deepEqual(host.state.created, []);
    });
  }
});

test('live config replacement toggles denial and prompt guidance without registration churn; unload and tools reload remove and restore policy', (t) => {
  const host = createHost();
  t.after(() => host.dispose());
  let cfg = { features: { blockGoalCreation: false } };
  const policy = installGoalCreationPolicy(host.ctx, () => cfg);
  assert.equal(policy.getError(), null);
  assert.equal(host.prompt(), '');
  assert.equal(host.execute('create_goal').ok, true);
  cfg = { features: { blockGoalCreation: true } };
  assert.equal(host.execute('create_goal').denied, true);
  assert.ok(host.prompt().length > 0); // 动态契约，不绑定提示措辞。
  cfg.features.blockGoalCreation = false;
  assert.equal(host.execute('create_goal').ok, true);
  assert.equal(host.prompt(), '');
  cfg.features.blockGoalCreation = true;
  host.dispose();
  assert.equal(host.execute('create_goal').ok, true);
  assert.equal(host.prompt(), '');
  assert.equal(typeof policy.getError(), 'string');
  const toolsScope = host.activate('tools', { tools: host.tools });
  assert.equal(host.execute('create_goal').denied, true);
  toolsScope.dispose();
  assert.equal(host.execute('create_goal').ok, true);
});

test('policy remains hard-enforced without the optional prompt service and cannot override another host guard', (t) => {
  const host = createHost({ promptSupported: false });
  t.after(() => host.dispose());
  let enabled = true;
  installGoalCreationPolicy(host.ctx, () => ({ features: { blockGoalCreation: enabled } }));
  assert.equal(host.execute('create_goal').denied, true);
  host.tools.guard((exec) => exec.name === 'create_goal' ? 'Independent host restriction' : undefined);
  enabled = false;
  assert.equal(host.execute('create_goal').denied, true);
  assert.deepEqual(host.state.created, []);
});

/** 路由集成保留真实配置读写和 apply；只替换外部网络/进程边界，避免测试打开 LAN 端口或运行本机服务。 */
async function mountPlugin(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-goal-policy-'));
  const envPatch = {
    DSH_HOME: dir,
    DSH_AU_LOCAL_DIR: join(dir, 'local'),
    DSH_AU_CLOUD_MANIFEST_PATH: join(dir, 'cloud.json'),
    DSH_AU_DISABLE_AUTO_START: '1',
  };
  const previous = Object.fromEntries(Object.keys(envPatch).map((key) => [key, process.env[key]]));
  Object.assign(process.env, envPatch);
  writeFileSync(envPatch.DSH_AU_CLOUD_MANIFEST_PATH, JSON.stringify({ schemaVersion: 1, services: {}, devices: [], plugins: {} }));
  const routes = new Map();
  const host = createHost(options);
  t.mock.method(http.Server.prototype, 'listen', function (...args) {
    this.address = () => ({ port: 49101 });
    this.close = () => this;
    queueMicrotask(() => args.at(-1)());
    return this;
  });
  t.mock.method(dgram, 'createSocket', () => Object.assign(new EventEmitter(), {
    bind(_port, ready) { ready(); }, setBroadcast() {}, send() {}, close() {},
  }));
  t.mock.method(childProcess, 'spawn', () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: Object.assign(new EventEmitter(), { setEncoding() {} }), stderr: new EventEmitter(), kill() {},
    });
    queueMicrotask(() => { child.stdout.emit('data', '{"services":[]}'); child.emit('close', 0); });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    host.dispose();
    // 还原 SDK 边界 fake 对 Node 具名导出的替换；不改变宿主真实状态。
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const { apply } = await import('../lib/index.js');
  apply(host.ctx);
  host.activate('webServer', { webServer: {
    port: 0,
    register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); },
  } });
  // 让插件启动的边界微任务收束后再测试和清理，不使用固定等待时间。
  await new Promise((resolve) => setImmediate(resolve));
  return {
    ...host,
    async api(body) {
      const req = Object.assign(new EventEmitter(), { method: 'POST', setEncoding() {} });
      let status;
      let response;
      const pending = routes.get('/dsh-au/api')(req, {
        writeHead(code) { status = code; }, end(text) { response = JSON.parse(text); },
      });
      req.emit('data', JSON.stringify(body));
      req.emit('end');
      await pending;
      return { status, ...response };
    },
  };
}

test('saveFeatures applies immediately, boolean-only patches preserve other flags, and getFeatures reloads the live config', async (t) => {
  const host = await mountPlugin(t);
  const before = structuredClone(host.state);
  const initial = await host.api({ action: 'getFeatures' });
  assert.equal(initial.features.blockGoalCreation, false);
  assert.equal(host.execute('create_goal').ok, true);
  const saved = await host.api({ action: 'saveFeatures', blockGoalCreation: true, todo: false });
  assert.equal(saved.status, 200);
  assert.equal(saved.features.blockGoalCreation, true);
  assert.equal(host.execute('create_goal').denied, true);
  for (const value of ['false', 0, null, {}]) {
    const ignored = await host.api({ action: 'saveFeatures', blockGoalCreation: value });
    assert.deepEqual(ignored.features, saved.features);
    assert.equal(host.execute('create_goal').denied, true);
  }
  assert.deepEqual(host.execute('get_goal').goal, before.goal);
  assert.equal(host.execute('update_goal', { action: 'resume' }).ok, true);
  assert.equal(host.execute('get_goal').goal.action, 'resume');
  assert.deepEqual(host.state.session, before.session);
  assert.deepEqual(host.state.driver, before.driver);
  const disk = loadConfig();
  disk.features.blockGoalCreation = false;
  saveConfig(disk);
  assert.equal((await host.api({ action: 'getFeatures' })).features.blockGoalCreation, false);
  assert.equal(host.execute('create_goal').ok, true);
  await host.api({ action: 'saveFeatures', blockGoalCreation: true });
  assert.equal(host.execute('create_goal').denied, true);
  const disabled = await host.api({ action: 'saveFeatures', blockGoalCreation: false });
  assert.equal(disabled.features.todo, false);
  assert.equal(host.execute('create_goal').ok, true);
  await host.api({ action: 'saveFeatures', blockGoalCreation: true });
  host.dispose();
  assert.equal(host.execute('create_goal').ok, true);
});

test('unsupported or unready hosts reject activation without persisting false enforcement and report unsupported reloaded settings', async (t) => {
  for (const options of [{ guardSupported: false }, { autoTools: false }]) {
    await t.test(JSON.stringify(options), async (t) => {
      const host = await mountPlugin(t, options);
      const rejected = await host.api({ action: 'saveFeatures', blockGoalCreation: true });
      assert.equal(rejected.status, 501);
      assert.equal(rejected.ok, false);
      assert.equal(typeof rejected.error, 'string');
      assert.equal(loadConfig().features.blockGoalCreation, false);
      const disk = loadConfig();
      disk.features.blockGoalCreation = true;
      saveConfig(disk);
      const unsupported = await host.api({ action: 'getFeatures' });
      assert.equal(unsupported.status, 200);
      assert.equal(unsupported.ok, true);
      assert.equal(unsupported.features.blockGoalCreation, true);
      assert.ok(unsupported.goalCreationError.length > 0);
      const unrelated = await host.api({ action: 'saveFeatures', todo: false });
      assert.equal(unrelated.status, 200);
      assert.equal(unrelated.features.todo, false);
      assert.equal(unrelated.features.blockGoalCreation, true);
      assert.ok(unrelated.goalCreationError.length > 0);
      assert.equal((await host.api({ action: 'saveFeatures', blockGoalCreation: false })).ok, true);
      assert.equal(loadConfig().features.blockGoalCreation, false);
      assert.equal(host.execute('get_goal').ok, true);
    });
  }
});
