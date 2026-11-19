import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// 所有绑定、PID 与事件日志都隔离到临时目录；fixture 脚本故意不存在，任何测试都不能启动真实服务。
const root = mkdtempSync(path.join(tmpdir(), 'dsh-au-service-recovery-'));
const machineId = 'recovery-fixture';
const env = {
  DSH_AU_LOCAL_DIR: path.join(root, 'local'),
  DSH_AU_MACHINES_DIR: path.join(root, 'machines'),
  DSH_AU_LOCAL_POINTER_PATH: path.join(root, 'active.json'),
  DSH_AU_LOCAL_STATE_PATH: path.join(root, 'state.json'),
  DSH_AU_CONFIG_PATH: path.join(root, 'config.json'),
  DSH_AU_CLOUD_MANIFEST_PATH: path.join(root, 'cloud.json'),
  DSH_AU_AUWIN_ROOT: path.join(root, 'absent-auwin'),
  DSH_AU_STARTUP_DIR: path.join(root, 'startup'),
  DSH_AU_PID_DIR: path.join(root, 'pids'),
  DSH_AU_LOCAL_BINDINGS_PATH: undefined,
};
const previous = Object.keys(env).map((key) => [key, process.env[key]]);
for (const [key, value] of Object.entries(env)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

writeJson(env.DSH_AU_LOCAL_POINTER_PATH, { schemaVersion: 1, machineId });
writeJson(path.join(env.DSH_AU_MACHINES_DIR, `${machineId}.json`), {
  schemaVersion: 2,
  machineId,
  services: {
    fixture: {
      name: 'Recovery fixture',
      scriptPath: path.join(root, 'must-not-run.mjs'),
    },
  },
});
writeJson(env.DSH_AU_CLOUD_MANIFEST_PATH, {
  schemaVersion: 1,
  services: {
    svc_files: { name: 'FileServer' },
    svc_mount: { name: 'MountSvc', dependsOn: ['svc_files'] },
    proxy: { name: 'Proxy' },
    webui: { name: 'WebUI', dependsOn: ['proxy'] },
  },
  devices: [],
  plugins: {},
});

const { createBackgroundServiceManager } = await import('../lib/background-services.js');
const { readServiceEvents } = await import('../lib/service-event-log.js');
let managerSequence = 0;

function createFixtureManager({ initial = false, now = 0, startResult, scope = 'machine-a' } = {}) {
  let running = initial;
  let clock = now;
  let activeScope = scope;
  let probeCalls = 0;
  const starts = [];
  const recoveryState = new Map();
  const eventFile = path.join(root, `events-${managerSequence += 1}.jsonl`);
  const manager = createBackgroundServiceManager({
    now: () => clock,
    recoveryState,
    recoveryScope: () => activeScope,
    recoveryProbe: async () => {
      probeCalls += 1;
      if (running instanceof Error) throw running;
      if (Array.isArray(running)) return running;
      return [{ id: 'fixture', running }];
    },
    recoveryStart: async (serviceId, action) => {
      starts.push({ serviceId, action, at: clock });
      return startResult ? startResult(serviceId, action) : { ok: true, running: true, message: 'started' };
    },
    serviceEventLog: { filePath: eventFile },
  });
  return {
    manager,
    starts,
    recoveryState,
    eventFile,
    setRunning(value) { running = value; },
    setNow(value) { clock = value; },
    setScope(value) { activeScope = value; },
    probeCalls() { return probeCalls; },
  };
}

const fixtureProfile = { enabled: ['fixture'], autoStartOnBoot: ['fixture'] };

async function observeTwice(fixture, running = false) {
  fixture.setRunning(running);
  await fixture.manager.reconcileBootRecovery(fixtureProfile);
  return fixture.manager.reconcileBootRecovery(fixtureProfile);
}

after(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  assert.equal(path.dirname(root), path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith('dsh-au-service-recovery-'));
  rmSync(root, { recursive: true, force: true });
});

test('cold stopped service stays idle until a confirmed running-to-stopped transition', async () => {
  const fixture = createFixtureManager();
  await observeTwice(fixture, false);
  assert.deepEqual(fixture.starts, []);

  fixture.setRunning(true);
  await fixture.manager.reconcileBootRecovery(fixtureProfile);
  fixture.setRunning(false);
  await fixture.manager.reconcileBootRecovery(fixtureProfile);
  fixture.setRunning(null);
  await fixture.manager.reconcileBootRecovery(fixtureProfile);
  fixture.setRunning(false);
  await fixture.manager.reconcileBootRecovery(fixtureProfile);
  assert.deepEqual(fixture.starts, [], 'unknown observation must break consecutive stopped confirmations');

  await fixture.manager.reconcileBootRecovery(fixtureProfile);
  assert.deepEqual(fixture.starts.map(({ serviceId, action }) => ({ serviceId, action })), [
    { serviceId: 'fixture', action: 'start' },
  ]);
});

test('explicit user stop suppresses recovery and user start returns the service to unseen', async () => {
  const fixture = createFixtureManager({ initial: true });
  await fixture.manager.reconcileBootRecovery(fixtureProfile);

  const stopped = await fixture.manager.controlService('fixture', 'stop', { source: 'user' });
  assert.equal(stopped.ok, true);
  await observeTwice(fixture, false);
  assert.deepEqual(fixture.starts, []);

  const startRequest = await fixture.manager.controlService('fixture', 'start', { source: 'user' });
  assert.equal(startRequest.ok, false, 'the missing fixture script must never be launched');
  await observeTwice(fixture, false);
  assert.deepEqual(fixture.starts, [], 'clearing suppression must not turn a cold stop into a recovery');

  fixture.setRunning(true);
  await fixture.manager.reconcileBootRecovery(fixtureProfile);
  await observeTwice(fixture, false);
  assert.equal(fixture.starts.length, 1);

  const events = readServiceEvents({ filePath: fixture.eventFile, limit: 100 });
  assert.ok(events.some((event) => event.event === 'service.recovery.suppressed'));
  assert.ok(events.some((event) => event.event === 'service.recovery.reset'));
});

test('removing boot eligibility clears manual suppression and later re-enables as unseen', async () => {
  const fixture = createFixtureManager({ initial: true });
  await fixture.manager.reconcileBootRecovery(fixtureProfile);
  await fixture.manager.controlService('fixture', 'stop', { source: 'user' });
  assert.equal(fixture.recoveryState.get('fixture').manualSuppressed, true);

  fixture.setRunning(false);
  await fixture.manager.reconcileBootRecovery({ enabled: [], autoStartOnBoot: [] });
  assert.equal(fixture.recoveryState.has('fixture'), false);
  await observeTwice(fixture, false);
  assert.deepEqual(fixture.starts, [], 're-enabled cold service must return to unseen instead of retaining stale state');
});

test('switching active machine binding clears same-id recovery state', async () => {
  const fixture = createFixtureManager({ initial: true, scope: 'machine-a' });
  await fixture.manager.reconcileBootRecovery(fixtureProfile);
  assert.equal(fixture.recoveryState.get('fixture').everRunning, true);

  fixture.setScope('machine-b');
  await observeTwice(fixture, false);
  assert.equal(fixture.recoveryState.get('fixture').everRunning, false);
  assert.deepEqual(fixture.starts, [], 'new binding cold stop must not inherit the previous machine arm state');
});

test('binding switch invalidates an in-flight probe before it can arm the new machine', async () => {
  let scope = 'machine-a';
  let releaseProbe;
  let enterProbe;
  let probeCalls = 0;
  const probeEntered = new Promise((resolve) => { enterProbe = resolve; });
  const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
  const starts = [];
  const recoveryState = new Map();
  const manager = createBackgroundServiceManager({
    now: () => 0,
    recoveryState,
    recoveryScope: () => scope,
    recoveryProbe: async () => {
      probeCalls += 1;
      if (probeCalls === 1) {
        enterProbe();
        await probeGate;
        return [{ id: 'fixture', running: true }];
      }
      return [{ id: 'fixture', running: false }];
    },
    recoveryStart: async (serviceId, action) => {
      starts.push({ serviceId, action });
      return { ok: true, running: true };
    },
    serviceEventLog: { filePath: path.join(root, `events-${managerSequence += 1}.jsonl`) },
  });

  const oldTick = manager.reconcileBootRecovery(fixtureProfile);
  await probeEntered;
  scope = 'machine-b';
  manager.refreshRecoveryScope();
  const idle = manager.waitForRecoveryMaintenanceIdle();
  releaseProbe();
  const oldResult = await oldTick;
  await idle;
  assert.equal(oldResult.skipped, 'scope-changed');

  await manager.reconcileBootRecovery(fixtureProfile);
  await manager.reconcileBootRecovery(fixtureProfile);
  assert.equal(recoveryState.get('fixture').everRunning, false);
  assert.deepEqual(starts, []);
});

test('recovery attempts honor 30-second and 2-minute delays plus the 15-minute cap', async () => {
  const fixture = createFixtureManager({ initial: true });
  await fixture.manager.reconcileBootRecovery(fixtureProfile);
  await observeTwice(fixture, false);
  assert.equal(fixture.starts.length, 1);
  assert.equal(fixture.recoveryState.get('fixture').nextRetryAt, 30_000);

  fixture.setNow(29_999);
  await observeTwice(fixture, false);
  assert.equal(fixture.starts.length, 1);
  fixture.setNow(30_000);
  await fixture.manager.reconcileBootRecovery(fixtureProfile);
  assert.equal(fixture.starts.length, 2);
  assert.equal(fixture.recoveryState.get('fixture').nextRetryAt, 150_000);

  fixture.setNow(149_999);
  await observeTwice(fixture, false);
  assert.equal(fixture.starts.length, 2);
  fixture.setNow(150_000);
  await fixture.manager.reconcileBootRecovery(fixtureProfile);
  assert.equal(fixture.starts.length, 3);
  assert.equal(fixture.recoveryState.get('fixture').nextRetryAt, 450_000, 'third attempt must apply the 5-minute delay');

  fixture.setNow(450_000);
  await observeTwice(fixture, false);
  assert.equal(fixture.starts.length, 3, 'three attempts inside 15 minutes must open the breaker');
  fixture.setNow(900_001);
  await fixture.manager.reconcileBootRecovery(fixtureProfile);
  assert.equal(fixture.starts.length, 4, 'recovery may resume after the oldest attempt leaves the rolling window');
});

test('five continuous healthy minutes clear the rolling attempt count', async () => {
  const fixture = createFixtureManager({ initial: true });
  await fixture.manager.reconcileBootRecovery(fixtureProfile);
  await observeTwice(fixture, false);
  fixture.setNow(30_000);
  await observeTwice(fixture, false);
  fixture.setNow(150_000);
  await observeTwice(fixture, false);
  assert.equal(fixture.starts.length, 3);

  fixture.setRunning(true);
  fixture.setNow(150_001);
  await fixture.manager.reconcileBootRecovery(fixtureProfile);
  fixture.setNow(450_001);
  await fixture.manager.reconcileBootRecovery(fixtureProfile);
  assert.deepEqual(fixture.recoveryState.get('fixture').attempts, []);

  await observeTwice(fixture, false);
  assert.equal(fixture.starts.length, 4, 'stable health must close the breaker without waiting 15 minutes');
});

test('svc_mount recovery starts and confirms FileServer before starting svc_mount', async () => {
  let snapshot = [
    { id: 'svc_files', running: false },
    { id: 'svc_mount', running: true },
  ];
  const calls = [];
  const manager = createBackgroundServiceManager({
    now: () => 0,
    recoveryState: new Map(),
    recoveryProbe: async () => snapshot,
    recoveryStart: async (serviceId, action) => {
      calls.push({ serviceId, action });
      return { ok: true, running: true, message: `${serviceId} started` };
    },
    serviceEventLog: { filePath: path.join(root, `events-${managerSequence += 1}.jsonl`) },
  });
  const profile = { enabled: ['svc_mount'], autoStartOnBoot: ['svc_mount'] };
  await manager.reconcileBootRecovery(profile);
  snapshot = snapshot.map((service) => service.id === 'svc_mount' ? { ...service, running: false } : service);
  await manager.reconcileBootRecovery(profile);
  await manager.reconcileBootRecovery(profile);

  assert.deepEqual(calls, [
    { serviceId: 'svc_files', action: 'start' },
    { serviceId: 'svc_mount', action: 'start' },
  ]);
});

test('svc_mount recovery stops when FileServer dependency cannot be restored', async () => {
  let quarkRunning = true;
  const calls = [];
  const manager = createBackgroundServiceManager({
    now: () => 0,
    recoveryState: new Map(),
    recoveryProbe: async () => [
      { id: 'svc_files', running: false },
      { id: 'svc_mount', running: quarkRunning },
    ],
    recoveryStart: async (serviceId, action) => {
      calls.push({ serviceId, action });
      return { ok: false, running: false, error: 'dependency failed' };
    },
    serviceEventLog: { filePath: path.join(root, `events-${managerSequence += 1}.jsonl`) },
  });
  const profile = { enabled: ['svc_mount'], autoStartOnBoot: ['svc_mount'] };
  await manager.reconcileBootRecovery(profile);
  quarkRunning = false;
  await manager.reconcileBootRecovery(profile);
  const result = await manager.reconcileBootRecovery(profile);

  assert.deepEqual(calls, [{ serviceId: 'svc_files', action: 'start' }]);
  assert.equal(result.attempted[0].serviceId, 'svc_mount');
  assert.equal(result.attempted[0].ok, false);
  assert.match(result.attempted[0].message, /依赖 svc_files 未确认运行/);
});

test('manual suppression survives while the service remains an eligible dependency', async () => {
  let webuiRunning = true;
  const starts = [];
  const recoveryState = new Map([['proxy', {
    everRunning: true,
    manualSuppressed: true,
    consecutiveStopped: 0,
    attempts: [],
    nextRetryAt: 0,
    healthySince: null,
    lastStatus: 'stopped',
    breakerLoggedUntil: 0,
  }]]);
  const manager = createBackgroundServiceManager({
    now: () => 0,
    recoveryState,
    recoveryScope: () => 'dependency-machine',
    recoveryProbe: async () => [
      { id: 'proxy', running: false },
      { id: 'webui', running: webuiRunning },
    ],
    recoveryStart: async (serviceId, action) => {
      starts.push({ serviceId, action });
      return { ok: true, running: true };
    },
    serviceEventLog: { filePath: path.join(root, `events-${managerSequence += 1}.jsonl`) },
  });
  const profile = { enabled: ['webui'], autoStartOnBoot: ['webui'] };
  await manager.reconcileBootRecovery(profile);
  webuiRunning = false;
  await manager.reconcileBootRecovery(profile);
  const result = await manager.reconcileBootRecovery(profile);

  assert.equal(recoveryState.get('proxy').manualSuppressed, true);
  assert.deepEqual(starts, []);
  assert.match(result.attempted[0].message, /依赖 proxy 已被手动停止/);
});

test('concurrent reconciliation shares one probe and one recovery attempt', async () => {
  let releaseProbe;
  let probeCalls = 0;
  const starts = [];
  const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
  const manager = createBackgroundServiceManager({
    now: () => 0,
    recoveryState: new Map([['fixture', {
      everRunning: true,
      manualSuppressed: false,
      consecutiveStopped: 1,
      attempts: [],
      nextRetryAt: 0,
      healthySince: null,
      lastStatus: 'stopped',
      breakerLoggedUntil: 0,
    }]]),
    recoveryProbe: async () => {
      probeCalls += 1;
      await probeGate;
      return [{ id: 'fixture', running: false }];
    },
    recoveryStart: async (serviceId, action) => {
      starts.push({ serviceId, action });
      return { ok: true, running: true };
    },
    serviceEventLog: { filePath: path.join(root, `events-${managerSequence += 1}.jsonl`) },
  });

  const first = manager.reconcileBootRecovery(fixtureProfile);
  const second = manager.reconcileBootRecovery(fixtureProfile);
  releaseProbe();
  await Promise.all([first, second]);
  assert.equal(probeCalls, 1);
  assert.deepEqual(starts, [{ serviceId: 'fixture', action: 'start' }]);
});

test('user stop waits for an in-flight recovery and remains the final control action', async () => {
  let enterRecovery;
  let releaseRecovery;
  const recoveryEntered = new Promise((resolve) => { enterRecovery = resolve; });
  const recoveryGate = new Promise((resolve) => { releaseRecovery = resolve; });
  const fixture = createFixtureManager({
    initial: true,
    startResult: async () => {
      enterRecovery();
      await recoveryGate;
      return { ok: true, running: true, message: 'recovered' };
    },
  });
  await fixture.manager.reconcileBootRecovery(fixtureProfile);
  fixture.setRunning(false);
  await fixture.manager.reconcileBootRecovery(fixtureProfile);
  const recovery = fixture.manager.reconcileBootRecovery(fixtureProfile);
  await recoveryEntered;

  let stopSettled = false;
  const stop = fixture.manager.controlService('fixture', 'stop', { source: 'user' })
    .then((result) => { stopSettled = true; return result; });
  await Promise.resolve();
  assert.equal(stopSettled, false);
  releaseRecovery();
  const [recoveryResult, stopResult] = await Promise.all([recovery, stop]);

  assert.equal(recoveryResult.attempted[0].ok, false);
  assert.match(recoveryResult.attempted[0].message, /用户控制.*失效/);
  assert.equal(stopResult.ok, true);
  assert.equal(fixture.recoveryState.get('fixture').manualSuppressed, true);
});

test('Doctor suspension and disposal invalidate and wait for an in-flight recovery', async () => {
  let enterRecovery;
  let releaseRecovery;
  const recoveryEntered = new Promise((resolve) => { enterRecovery = resolve; });
  const recoveryGate = new Promise((resolve) => { releaseRecovery = resolve; });
  const fixture = createFixtureManager({
    initial: true,
    startResult: async () => {
      enterRecovery();
      await recoveryGate;
      return { ok: true, running: true };
    },
  });
  await fixture.manager.reconcileBootRecovery(fixtureProfile);
  fixture.setRunning(false);
  await fixture.manager.reconcileBootRecovery(fixtureProfile);
  const recovery = fixture.manager.reconcileBootRecovery(fixtureProfile);
  await recoveryEntered;

  const releaseSuspend = fixture.manager.suspendRecovery('fixture');
  let idleSettled = false;
  const idle = fixture.manager.waitForRecoveryIdle('fixture').then(() => { idleSettled = true; });
  const disposed = fixture.manager.disposeRecovery();
  await Promise.resolve();
  assert.equal(idleSettled, false);
  releaseRecovery();
  const [result] = await Promise.all([recovery, idle, disposed]);
  releaseSuspend();

  assert.equal(result.attempted[0].ok, false);
  assert.match(result.attempted[0].message, /插件销毁失效/);
});

test('suspension and disposal prevent recovery without stopping services', async () => {
  const fixture = createFixtureManager({ initial: true });
  await fixture.manager.reconcileBootRecovery(fixtureProfile);
  const release = fixture.manager.suspendRecovery('fixture');
  await observeTwice(fixture, false);
  assert.deepEqual(fixture.starts, []);

  release();
  await observeTwice(fixture, false);
  assert.equal(fixture.starts.length, 1);
  const probesBeforeDispose = fixture.probeCalls();
  fixture.manager.disposeRecovery();
  const result = await fixture.manager.reconcileBootRecovery(fixtureProfile);
  assert.equal(result.skipped, 'disposed');
  assert.equal(fixture.probeCalls(), probesBeforeDispose);
  assert.equal(fixture.starts.length, 1);
});
