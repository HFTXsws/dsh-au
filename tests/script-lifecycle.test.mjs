import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { controlScriptPathService } from '../lib/background-services.js';
import { buildCloudServiceEntry, REPO_ROOT } from '../lib/cloud-manifest.js';
import { applyLocalBinding, cloudDefinitionToLocalBinding, machineFilePath, setLocalBindingService, writeActivePointer } from '../lib/local-bindings.js';

// Only the child-process boundary is faked: never run the user's Docker or stop scripts.
function world(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-au-script-lifecycle-'));
  const keys = ['DSH_AU_LOCAL_DIR', 'DSH_AU_LOCAL_BINDINGS_PATH', 'DSH_AU_MACHINES_DIR',
    'DSH_AU_LOCAL_POINTER_PATH', 'DSH_AU_LOCAL_STATE_PATH', 'DSH_AU_CONFIG_DIR',
    'DSH_AU_CONFIG_PATH', 'DSH_AU_CLOUD_MANIFEST_PATH', 'DSH_AU_PID_DIR',
    'DSH_AU_SKIP_SCRIPT_PROCESS_SCAN'];
  const previous = keys.map((key) => [key, process.env[key]]);
  for (const key of keys) delete process.env[key];
  process.env.DSH_AU_LOCAL_DIR = path.join(dir, 'local');
  process.env.DSH_AU_CONFIG_PATH = path.join(dir, 'config.json');
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = path.join(dir, 'cloud.json');
  process.env.DSH_AU_PID_DIR = path.join(dir, 'pids');
  process.env.DSH_AU_SKIP_SCRIPT_PROCESS_SCAN = '1';
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    assert.equal(path.dirname(dir), tmpdir());
    assert(path.basename(dir).startsWith('dsh-au-script-lifecycle-'));
    rmSync(dir, { recursive: true, force: true });
  });
  const start = path.join(dir, 'start.mjs');
  const stop = path.join(dir, 'stop.mjs');
  writeFileSync(start, '// isolated fixture, never executed\n');
  writeFileSync(stop, '// isolated fixture, never executed\n');
  return { dir, start, stop };
}

function fakeProcesses(t, result = 'success') {
  const calls = [];
  t.mock.method(childProcess, 'spawnSync', () => {
    assert.fail('Explicit stop must never discover or terminate a port listener');
  });
  t.mock.method(childProcess, 'spawn', (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.pid = process.pid;
    child.unref = () => {};
    child.kill = () => true;
    if (args.some((arg) => arg.endsWith('stop.mjs'))) {
      if (result === 'error') queueMicrotask(() => child.emit('error', new Error('fixture spawn failure')));
      else if (result === 'delayed') setTimeout(() => child.emit('close', 0), 20);
      else if (result !== 'timeout') queueMicrotask(() => child.emit('close', result === 'success' ? 0 : 1));
    }
    return child;
  });
  syncBuiltinESMExports();
  return calls;
}

for (const action of ['stop', 'restart']) {
  test(`explicit ${action} uses separate scripts and arguments without PID fallback`, async (t) => {
    const { start, stop } = world(t);
    const calls = fakeProcesses(t);
    const result = await controlScriptPathService({
      id: 'fixture', name: 'Fixture', scriptPath: start, args: ['--start-mode', ' padded start value '],
      stopScriptPath: stop, stopArgs: ['--stop-mode', ' padded stop value '], controlTimeoutMs: 1000,
    }, action);
    assert.equal(result.ok, true);
    assert.deepEqual(calls[0].args, [stop, '--stop-mode', ' padded stop value ']);
    if (action === 'restart') assert.deepEqual(calls[1].args, [start, '--start-mode', ' padded start value ']);
    assert.equal(calls.length, action === 'restart' ? 2 : 1);
  });
}

for (const failure of ['missing', 'invalid', 'blank', 'type', 'error', 'exit', 'timeout']) {
  test(`explicit stop ${failure} prevents restart and never falls back to process termination`, async (t) => {
    const { start, stop, dir } = world(t);
    const calls = fakeProcesses(t, failure);
    const configuredStop = failure === 'missing' ? path.join(dir, 'missing.mjs')
      : failure === 'invalid' ? path.join(dir, 'config.json')
      : failure === 'blank' ? '' : failure === 'type' ? 42 : stop;
    if (failure === 'invalid') writeFileSync(configuredStop, '{}');
    const result = await controlScriptPathService({
      id: 'fixture', name: 'Fixture', scriptPath: start, stopScriptPath: configuredStop,
      controlTimeoutMs: 20,
    }, 'restart');
    assert.equal(result.ok, false);
    assert.equal(calls.some(({ args }) => args.includes(start)), false);
    assert.equal(calls.length, ['missing', 'invalid', 'blank', 'type'].includes(failure) ? 0 : 1);
  });
}

test('2026-10-28 notes-service regression: a still-reachable shared forwarder is not killed or restarted', async (t) => {
  const { start, stop } = world(t);
  const calls = fakeProcesses(t);
  const forwarder = net.createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    forwarder.once('error', reject);
    forwarder.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => forwarder.close(resolve)));
  const port = forwarder.address().port;
  const result = await controlScriptPathService({
    id: 'fixture', name: 'Fixture', scriptPath: start, stopScriptPath: stop,
    port, controlTimeoutMs: 20,
  }, 'restart');
  assert.equal(result.ok, false);
  assert.equal(result.running, true);
  assert.equal(calls.length, 1);
  assert(forwarder.listening);
  await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => { socket.end(); resolve(); });
    socket.once('error', reject);
  });
});

test('unshareable explicit stop remains fail-closed when a repository start script is reattached', async (t) => {
  const { stop } = world(t);
  const calls = fakeProcesses(t);
  const cloud = buildCloudServiceEntry({
    name: 'Fixture', scriptPath: path.join(REPO_ROOT, 'scripts/build-client.js'),
    stopScriptPath: stop,
  });
  assert.equal(cloud.scriptPath, 'scripts/build-client.js');
  assert.equal(cloud.stopScriptPath, '');
  const attached = cloudDefinitionToLocalBinding(cloud);
  const runtime = applyLocalBinding({ id: 'fixture', name: 'Fixture' }, { fixture: attached }, {});
  assert(Object.hasOwn(runtime, 'stopScriptPath'));
  const result = await controlScriptPathService(runtime, 'restart');
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
});

test('oversized timeout is clamped instead of becoming a one-millisecond stop deadline', async (t) => {
  const { start, stop } = world(t);
  const calls = fakeProcesses(t, 'delayed');
  const result = await controlScriptPathService({
    id: 'fixture', name: 'Fixture', scriptPath: start, stopScriptPath: stop,
    controlTimeoutMs: Number.MAX_SAFE_INTEGER,
  }, 'stop');
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
});

test('saved lifecycle paths and arguments survive local binding and safe cloud roundtrip', (t) => {
  const { start, stop } = world(t);
  const machineId = 'fixture-machine';
  const file = machineFilePath(machineId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ schemaVersion: 2, machineId, services: {} }));
  writeActivePointer(machineId);
  const source = { name: 'Fixture', scriptPath: start, stopScriptPath: stop,
    args: ['--start-mode'], stopArgs: ['--stop-mode'], controlTimeoutMs: 180000 };
  assert.equal(setLocalBindingService('fixture', source).ok, true);
  const saved = JSON.parse(readFileSync(file, 'utf8')).services.fixture;
  const runtime = applyLocalBinding({ id: 'fixture' }, { fixture: saved }, {});
  assert.equal(runtime.stopScriptPath, stop);
  assert.deepEqual(runtime.args, source.args);
  assert.deepEqual(runtime.stopArgs, source.stopArgs);
  assert.equal(runtime.controlTimeoutMs, 180000);
  const cloud = buildCloudServiceEntry(runtime);
  assert.equal(cloud.scriptPath, '');
  assert.equal(cloud.stopScriptPath, '');
  const attached = cloudDefinitionToLocalBinding(cloud);
  assert.deepEqual(attached.args, source.args);
  assert.deepEqual(attached.stopArgs, source.stopArgs);
  assert.equal(attached.controlTimeoutMs, source.controlTimeoutMs);
  assert.equal(existsSync(file), true);
  const privateArg = buildCloudServiceEntry({ ...runtime, args: ['--config', '/outside/private/config.json'] });
  assert.equal(privateArg.args, undefined);
});

test('start skips spawning when probe already reports running', async (t) => {
  const { start } = world(t);
  const calls = fakeProcesses(t);
  const result = await controlScriptPathService({
    id: 'fixture', name: 'Fixture', scriptPath: start, controlTimeoutMs: 1000,
  }, 'start', { probeAlive: async () => true });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.running, true);
  assert.equal(calls.length, 0);
});

test('immediate exit is already-running when a later probe still sees the old instance', async (t) => {
  const { start } = world(t);
  const calls = [];
  t.mock.method(childProcess, 'spawn', (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.pid = 2147483646;
    child.unref = () => {};
    return child;
  });
  syncBuiltinESMExports();
  let probes = 0;
  const result = await controlScriptPathService({
    id: 'fixture', name: 'Fixture', scriptPath: start, controlTimeoutMs: 2000,
  }, 'start', {
    probeAlive: async () => {
      probes += 1;
      return probes > 1;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(calls.length, 1);
  assert.ok(probes >= 2);
});

test('local binding copies drive so Windows mount services can probe letters', (t) => {
  const runtime = applyLocalBinding({ id: 'svc_mount', name: 'MountSvc' }, {
    // 展示名与服务 id 分开：改展示名不能影响盘符探测。
    svc_mount: { name: '示例盘符挂载 Q:', scriptPath: 'D:/Tools/svc_mount.py', drive: 'Q:' },
  }, {});
  assert.equal(runtime.drive, 'Q:');
});
