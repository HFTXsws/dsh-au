import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// Isolate every persisted input before importing the manager; never discover real services.
const root = mkdtempSync(path.join(tmpdir(), 'dsh-au-control-policy-'));
const env = {
  DSH_HOME: path.join(root, 'dsh-home'),
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
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
const api = await import('../lib/background-services.js');
const bindings = await import('../lib/local-bindings.js');
const { buildCloudServiceEntry } = await import('../lib/cloud-manifest.js');
const machineId = 'control-policy-fixture';
const scriptPath = path.join(root, 'never-run.mjs');
writeFileSync(scriptPath, "throw new Error('Policy tests must not launch this fixture');\n");

after(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  assert.equal(path.dirname(root), path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith('dsh-au-control-policy-'));
  rmSync(root, { recursive: true, force: true });
});

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

function seed(localServices, cloudServices = {}) {
  writeJson(bindings.machineFilePath(machineId), { schemaVersion: 2, machineId, services: localServices });
  bindings.writeActivePointer(machineId);
  writeJson(env.DSH_AU_CLOUD_MANIFEST_PATH, { schemaVersion: 1, services: cloudServices, devices: [] });
  writeJson(env.DSH_AU_LOCAL_STATE_PATH, { schemaVersion: 1, machines: {
    [machineId]: { services: Object.fromEntries(Object.keys(localServices).map((id) => [id, {
      enabled: true, autoStartOnBoot: false, autoStartOnDsh: false, cloud: false,
    }])) },
  } });
}

const policyCases = [
  { name: 'Downloader GUI local start-only protects downloads', id: 'svc_download', local: 'start-only', expected: 'start-only' },
  { name: 'JSON full control is not tightened without a catalog policy', id: 'svc_files', local: 'full', cloud: 'full', expected: 'full' },
  { name: 'custom cloud start-only cannot be widened locally', id: 'custom', local: 'full', cloud: 'start-only', expected: 'start-only' },
  { name: 'local view tightens cloud full', id: 'custom', local: 'view', cloud: 'full', expected: 'view' },
  { name: 'cloud view cannot be widened locally', id: 'custom', local: 'full', cloud: 'view', expected: 'view' },
  { name: 'invalid local policy fails closed', id: 'custom', local: 'typo', expected: 'view' },
  { name: 'invalid cloud policy fails closed', id: 'custom', local: 'full', cloud: null, expected: 'view' },
  { name: 'omitted policy keeps existing generic full control', id: 'custom', expected: 'full' },
];

test('registered policies only tighten inferred or catalog permissions', async (t) => {
  for (const scenario of policyCases) await t.test(scenario.name, () => {
    const local = { name: 'Isolated service', scriptPath };
    const cloud = {};
    if (Object.hasOwn(scenario, 'local')) local.control = scenario.local;
    if (Object.hasOwn(scenario, 'cloud')) cloud.control = scenario.cloud;
    seed({ [scenario.id]: local }, { [scenario.id]: cloud });
    const entry = api.resolveServiceDefinition(scenario.id);
    assert.equal(entry.control, scenario.expected);
    for (const action of ['start', 'stop', 'restart']) {
      const allowed = scenario.expected === 'full' || (scenario.expected === 'start-only' && action === 'start');
      assert.equal(api.validateServiceControlRequest(scenario.id, action, { entry }).ok, allowed);
    }
  });
});

test('Downloader open launch binding is start-only without a service whitelist', () => {
  // Resolve only: this test never runs open or contacts the application's real WebAPI.
  const local = { svc_download: { scriptPath: '/usr/bin/open',
    args: ['-g', '-a', '/Applications/svc_download.app'], control: 'start-only' } };
  const entry = api.resolveServiceDefinition('svc_download', { bindings: local, cloud: {} });
  assert.equal(entry.control, 'start-only');
  assert.deepEqual(entry.args, local.svc_download.args);
  assert.equal(api.validateServiceControlRequest('svc_download', 'start', { entry }).ok, true);
});

test('direct local application infers control but cannot widen an existing restriction', async (t) => {
  for (const [name, current, local, expected] of [
    ['runnable start-only', undefined, { scriptPath, control: 'start-only' }, 'start-only'],
    ['launcher start-only', undefined, { launcher: { label: 'com.example.policy-fixture' }, control: 'start-only' }, 'start-only'],
    ['monitor cannot gain start', undefined, { health: 'http://127.0.0.1:1/', control: 'full' }, 'view'],
    ['existing view cannot gain full', 'view', { scriptPath, control: 'full' }, 'view'],
    ['existing start-only cannot gain full', 'start-only', { scriptPath, control: 'full' }, 'start-only'],
  ]) await t.test(name, () => {
    const entry = { id: 'fixture', ...(current === undefined ? {} : { control: current }) };
    assert.equal(bindings.applyLocalBinding(entry, { fixture: local }, {}).control, expected);
  });
});

test('unsafe manager actions are rejected before any process or HTTP boundary', async (t) => {
  // A boundary trap makes regressions fail safely instead of stopping a real or fixture process.
  const boundaryCalls = [];
  const forbidden = (boundary) => () => {
    boundaryCalls.push(boundary);
    throw new Error(`Rejected policy crossed ${boundary}`);
  };
  t.mock.method(childProcess, 'spawn', forbidden('spawn'));
  t.mock.method(childProcess, 'spawnSync', forbidden('spawnSync'));
  t.mock.method(http, 'get', forbidden('http.get'));
  t.mock.method(process, 'kill', forbidden('process.kill'));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (const scenario of policyCases.filter(({ expected }) => expected !== 'full')) {
    for (const action of scenario.expected === 'view' ? ['start', 'stop', 'restart'] : ['stop', 'restart']) {
      await t.test(`${scenario.name}: ${action}`, async () => {
        const local = { name: 'Isolated service', scriptPath, health: 'http://127.0.0.1:1/' };
        const cloud = {};
        if (Object.hasOwn(scenario, 'local')) local.control = scenario.local;
        if (Object.hasOwn(scenario, 'cloud')) cloud.control = scenario.cloud;
        seed({ [scenario.id]: local }, { [scenario.id]: cloud });
        const result = await api.createBackgroundServiceManager().controlService(scenario.id, action);
        assert.equal(result.ok, false);
        assert.equal(typeof result.error, 'string');
        assert.ok(result.error.length > 0);
        assert.deepEqual(boundaryCalls, []);
      });
    }
  }
});

test('cloud attachment and saved local roundtrip preserve restrictions and fail closed', async (t) => {
  for (const [name, requested, expected] of [
    ['start-only', 'start-only', 'start-only'], ['view', 'view', 'view'], ['full', 'full', 'full'],
    ['unknown', 'typo', 'view'], ['blank', '', 'view'], ['null', null, 'view'],
    ['boolean', false, 'view'], ['number', 7, 'view'], ['object', {}, 'view'],
  ]) await t.test(name, () => {
    for (const platform of ['darwin', 'linux', 'win32']) {
      const attached = bindings.cloudDefinitionToLocalBinding({
        name: 'Fixture', scriptPath: 'scripts/build-client.js', control: requested,
      }, platform);
      assert.equal(attached.control, expected);
      seed({ fixture: { scriptPath } });
      assert.equal(bindings.setLocalBindingService('fixture', attached).ok, true);
      const saved = JSON.parse(readFileSync(bindings.machineFilePath(machineId), 'utf8')).services.fixture;
      assert.equal(saved.control, expected);
      const runtime = api.resolveServiceDefinition('fixture');
      assert.equal(runtime.control, expected);
      const exported = buildCloudServiceEntry(runtime);
      const reattached = bindings.cloudDefinitionToLocalBinding(exported, platform);
      assert.equal(reattached.control, expected);
      assert.equal(api.resolveServiceDefinition('fixture', { bindings: { fixture: reattached }, cloud: {} }).control, expected);
    }
  });
});
