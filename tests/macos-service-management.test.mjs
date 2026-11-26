import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// Isolate controller root before import; nothing targets the real LaunchAgent.
const root = mkdtempSync(path.join(tmpdir(), 'dsh-au-macos-test-'));
const env = {
  HOME: path.join(root, 'home'),
  DSH_AU_CONTROLLER_ROOT: path.join(root, 'Controller'),
  DSH_AU_AUWIN_ROOT: undefined,
  DSH_AU_CONTROLLER_MODULE: undefined,
  DSH_AU_CONTROLLER_ENTRY: undefined,
  DSH_AU_CONTROLLER_WORKER_MODULE: undefined,
  DSH_AU_LOCAL_DIR: path.join(root, 'local'), DSH_AU_MACHINES_DIR: path.join(root, 'machines'),
  DSH_AU_LOCAL_POINTER_PATH: path.join(root, 'active.json'), DSH_AU_LOCAL_STATE_PATH: path.join(root, 'state.json'),
  DSH_AU_CONFIG_PATH: path.join(root, 'config.json'), DSH_AU_CLOUD_MANIFEST_PATH: path.join(root, 'cloud.json'),
  DSH_AU_STARTUP_DIR: path.join(root, 'startup'), DSH_AU_PID_DIR: path.join(root, 'pids'),
  DSH_AU_LOCAL_BINDINGS_PATH: undefined,
};
const previous = Object.keys(env).map((key) => [key, process.env[key]]);
for (const [key, value] of Object.entries(env)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
const controller = path.join(env.DSH_AU_CONTROLLER_ROOT, 'custom', 'controller', 'services.py');
mkdirSync(path.dirname(controller), { recursive: true });
writeFileSync(controller, '# Never executed test fixture\n');
writeFileSync(env.DSH_AU_CLOUD_MANIFEST_PATH, JSON.stringify({
  services: {},
  devices: [],
  controller: { module: 'custom.controller.services' },
}));
const api = await import('../lib/background-services.js');
const { machineFilePath, writeActivePointer } = await import('../lib/local-bindings.js');
after(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  assert.equal(path.dirname(root), path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith('dsh-au-macos-test-'));
  rmSync(root, { recursive: true, force: true });
});
const entry = { id: 'custom_mount', name: 'Test mount', launchd: { label: 'com.example.mount', plist: path.join(root, 'mount.plist') } };
writeFileSync(entry.launchd.plist, '<plist><dict><key>Label</key><string>com.example.mount</string></dict></plist>');
const target = 'gui/777/com.example.mount';
const output = `${target} = {\n\tstate = running\n\tpid = 4242\n}\n`;

// 2026-10-28 regression: mounted NFS service falsely stopped without HTTP/tracked PID.
test('native no-port probe requires running state and live top-level PID', async (t) => {
  for (const [name, result, live, expected] of [
    ['live', { ok: true, output }, true, true],
    ['dead PID', { ok: true, output }, false, false],
    ['waiting', { ok: true, output: output.replace('state = running', 'state = waiting') }, true, false],
    ['no PID', { ok: true, output: `${target} = {\n\tstate = running\n}\n` }, true, false],
    ['missing', { ok: false, output: 'missing job' }, true, false],
    ['nested PID', { ok: true, output: `${target} = {\n\tstate = running\n\tenvironment = {\n\t\tpid = 4242\n\t}\n}\n` }, true, false],
  ]) await t.test(name, async () => {
    const options = { platform: 'darwin', uid: 777,
      runLaunchctl: (args) => { assert.deepEqual(args, ['print', target]); return result; },
      isPidAlive: (pid) => { assert.equal(pid, 4242); return live; } };
    assert.equal(await api.probeMacLaunchdAlive(entry, options), expected);
    assert.equal(await api.probeServiceEndpointAlive(entry, options), expected);
  });
});

test('declared HTTP and TCP outrank native process status', async () => {
  const server = http.createServer((req, res) => { res.writeHead(401); res.end(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const port = server.address().port;
    const options = { platform: 'darwin', uid: 777, runLaunchctl: () => { throw new Error('Health must win'); }, isPidAlive: () => true };
    for (const declaration of [{ health: `http://127.0.0.1:${port}/health` }, { port }]) {
      assert.equal(await api.probeServiceEndpointAlive({ ...entry, ...declaration }, options), true);
    }
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const declaration of [{ health: `http://127.0.0.1:${port}/health` }, { port }]) {
      assert.equal(await api.probeServiceEndpointAlive({ ...entry, ...declaration }, options), false);
    }
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
});

test('live native start is idempotent without launchd mutations', async () => {
  const mutations = [];
  const result = await api.controlMacLaunchdService(entry, 'start', {
    uid: 777, probeAlive: async () => true,
    runLaunchctl: (args) => { if (args[0] !== 'print') mutations.push(args); return { ok: true, output }; },
    timeoutMs: 20, pollIntervalMs: 1 });
  assert.equal(result.ok, true);
  assert.deepEqual(mutations, []);
});

test('native actions use original plist and confirm requested state', async (t) => {
  for (const [name, action, loaded, commands] of [
    ['unloaded start', 'start', false, [['bootstrap', 'gui/777', entry.launchd.plist], ['kickstart', target]]],
    ['loaded start', 'start', true, [['kickstart', target]]],
    ['restart', 'restart', true, [['kickstart', '-k', target]]],
    ['stop', 'stop', true, [['bootout', target]]],
  ]) await t.test(name, async () => {
    const observed = [];
    let alive = action !== 'start';
    const result = await api.controlMacLaunchdService(entry, action, {
      uid: 777, probeAlive: async () => alive,
      runLaunchctl: (args) => {
        if (args[0] === 'print') return { ok: loaded, missing: !loaded, output };
        observed.push(args);
        if (args[0] === 'kickstart') alive = true;
        if (args[0] === 'bootout') alive = false;
        return { ok: true, output: '' };
      }, timeoutMs: 20, pollIntervalMs: 1 });
    assert.equal(result.ok, true);
    assert.deepEqual(observed, commands);
    assert.equal(alive, action !== 'stop');
  });
});

test('native command failures remain failures without raw diagnostic leakage or fallback', async (t) => {
  for (const action of ['start', 'restart', 'stop']) await t.test(action, async () => {
    const mutations = [];
    const marker = 'SENSITIVE_ENV_SENTINEL';
    const result = await api.controlMacLaunchdService(entry, action, {
      uid: 777, probeAlive: async () => action === 'restart',
      runLaunchctl: (args) => {
        if (args[0] === 'print') return { ok: true, output };
        mutations.push(args);
        return { ok: false, output: `denied token=${marker}` };
      }, timeoutMs: 10, pollIntervalMs: 1 });
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes(marker), false);
    assert.equal(mutations.length, 1);
    assert.equal(mutations.some(([command]) => command === 'load' || command === 'unload'), false);
  });
});

test('launchd inspection denied is not mistaken for an unloaded job', async () => {
  const mutations = [];
  const result = await api.controlMacLaunchdService(entry, 'start', {
    uid: 777, probeAlive: async () => false,
    runLaunchctl: (args) => {
      if (args[0] !== 'print') mutations.push(args);
      return { ok: false, missing: false, exitCode: 1, output: 'denied token=SENSITIVE_PRINT_SENTINEL' };
    }, timeoutMs: 10, pollIntervalMs: 1 });
  assert.equal(result.ok, false);
  assert.deepEqual(mutations, []);
  assert.equal(JSON.stringify(result).includes('SENSITIVE_PRINT_SENTINEL'), false);
});

test('successful command is not success until target state arrives', async (t) => {
  for (const action of ['start', 'stop']) await t.test(action, async () => {
    const result = await api.controlMacLaunchdService(entry, action, {
      uid: 777, probeAlive: async () => action === 'stop',
      runLaunchctl: () => ({ ok: true, output }), timeoutMs: 5, pollIntervalMs: 1 });
    assert.equal(result.ok, false);
  });
});

test('native boot preserves original plist and handles native synchronization failure safely', async (t) => {
  const machineId = 'isolated-mac';
  const scriptPath = path.join(root, 'rclone');
  writeFileSync(scriptPath, '#!/bin/sh\nexit 0\n');
  const plist = path.join(env.HOME, 'Library', 'LaunchAgents', `${entry.launchd.label}.plist`);
  mkdirSync(path.dirname(plist), { recursive: true });
  const original = readFileSync(entry.launchd.plist, 'utf8');
  writeFileSync(plist, original);
  const binding = machineFilePath(machineId);
  mkdirSync(path.dirname(binding), { recursive: true });
  writeFileSync(binding, JSON.stringify({ schemaVersion: 2, machineId, platform: 'darwin', services: {
    custom_mount: { name: entry.name, scriptPath, launcher: { label: entry.launchd.label } } } }));
  writeActivePointer(machineId);
  // 测试用 launchd 文件名去掉个人组织前缀，需与 lib 写出的 boot plist 一致。
  const genericPath = path.join(env.DSH_AU_STARTUP_DIR, `com.dsh-au.boot.${machineId}.plist`);
  const existingGeneric = '<plist><dict><key>Label</key><string>existing-generic</string></dict></plist>\n';
  for (const [name, ok] of [['success', true], ['failure preserves existing startup', false]]) {
    await t.test(name, async () => {
      if (!ok) {
        mkdirSync(path.dirname(genericPath), { recursive: true });
        writeFileSync(genericPath, existingGeneric);
      }
      const commands = [];
      const marker = 'SENSITIVE_BOOT_SENTINEL';
      const result = await api.syncBootStartupEntry(machineId, { enabled: [entry.id], autoStartOnBoot: [entry.id] }, 'darwin', {
        runLaunchctl: async (args) => { commands.push(args); return { ok, output: ok ? '' : marker }; } });
      assert.equal(result.synced, ok);
      assert.deepEqual(result.activeServices, []);
      assert.deepEqual(result.skippedServices, []);
      assert.ok(commands.some(([action, service]) => action === 'enable' && service.endsWith(`/${entry.launchd.label}`)));
      assert.equal(JSON.stringify(result).includes(marker), false);
      assert.equal(readFileSync(plist, 'utf8'), original);
      assert.equal(result.filePath, genericPath);
      if (ok) assert.equal(existsSync(genericPath), false);
      else assert.equal(readFileSync(genericPath, 'utf8'), existingGeneric);
    });
  }
});

test('Mac Workers and Windows built-ins use controller only while module exists', () => {
  const bindings = {
    cursor_workers: { controller: 'external' },
    svc_mount: { platformController: 'custom' },
  };
  for (const [id, platform, preferScriptRunner, expected] of [
    ['cursor_workers', 'darwin', false, true], ['cursor_workers', 'darwin', true, false],
    ['svc_mount', 'win32', false, true], ['svc_mount', 'win32', true, false],
    ['svc_mount', 'darwin', false, true], ['cursor_workers', 'linux', false, true],
    ['custom_mount', 'darwin', false, false],
  ]) assert.equal(api.usesAuWinServiceController(id, { platform, preferScriptRunner, bindings }), expected, `${id}/${platform}/${preferScriptRunner}`);
  assert.equal(api.usesAuWinServiceController('svc_mount', { platform: 'win32' }), false);
  assert.ok(controller.startsWith(`${root}${path.sep}`));
  rmSync(controller);
  try {
    assert.equal(api.usesAuWinServiceController('cursor_workers', { platform: 'darwin', bindings }), false);
    assert.equal(api.usesAuWinServiceController('svc_mount', { platform: 'win32', bindings }), false);
  } finally {
    writeFileSync(controller, '# Never executed test fixture\n');
  }
});
