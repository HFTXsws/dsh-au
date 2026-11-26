import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildScriptLaunchSpec,
  hasControllerModuleAvailable,
  listCursorWorkerInstances,
  resolveAuWinRoot,
  resolveControllerRoot,
  resolveControllerSpec,
  usesAuWinServiceController,
} from '../lib/background-services.js';
import { machineFilePath, setLocalBindingService, writeActivePointer } from '../lib/local-bindings.js';

const ENV_KEYS = [
  'DSH_AU_CONTROLLER_ROOT', 'DSH_AU_AUWIN_ROOT', 'DSH_AU_CONTROLLER_MODULE',
  'DSH_AU_CONTROLLER_ENTRY', 'DSH_AU_CONTROLLER_WORKER_MODULE',
  'DSH_AU_CONFIG_PATH', 'DSH_AU_CLOUD_MANIFEST_PATH', 'DSH_AU_LOCAL_DIR', 'DSH_AU_MACHINES_DIR',
  'DSH_AU_LOCAL_POINTER_PATH', 'DSH_AU_LOCAL_STATE_PATH', 'DSH_AU_LOCAL_BINDINGS_PATH',
];

function isolateEnv(t) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  t.after(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

test('resolveControllerRoot infers controller root from bindings when controller spec is declared', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-au-controller-root-'));
  isolateEnv(t);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const ctrlRoot = path.join(dir, 'ExtController');
  const script = path.join(ctrlRoot, 'scripts', 'worker.py');
  const configPath = path.join(dir, 'workers-config.json');
  const cloudManifestPath = path.join(dir, 'manifest.cloud.json');
  mkdirSync(path.dirname(script), { recursive: true });
  mkdirSync(path.join(ctrlRoot, 'custom', 'controller'), { recursive: true });
  writeFileSync(path.join(ctrlRoot, 'custom', 'controller', 'services.py'), '# fixture\n');
  writeFileSync(script, '# fixture\n');
  writeFileSync(configPath, JSON.stringify({
    machines: { 'Test-Host': { prefix: 'x9' } },
    repos: ['Demo'],
  }));
  writeFileSync(cloudManifestPath, JSON.stringify({
    schemaVersion: 1,
    services: {},
    devices: [],
    plugins: {},
    controller: {
      module: 'custom.controller.services',
      workerListModule: 'custom.controller.workers',
    },
  }));

  process.env.DSH_AU_LOCAL_DIR = path.join(dir, 'local');
  process.env.DSH_AU_CONFIG_PATH = path.join(dir, 'missing-config.json');
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = cloudManifestPath;

  const machineId = 'controller-root-host';
  mkdirSync(path.dirname(machineFilePath(machineId)), { recursive: true });
  writeFileSync(machineFilePath(machineId), JSON.stringify({ schemaVersion: 2, machineId, services: {} }));
  writeActivePointer(machineId);
  assert.equal(setLocalBindingService('cursor_workers', {
    name: 'Cursor Workers',
    scriptPath: script,
    configPath,
  }).ok, true);

  assert.deepEqual(resolveControllerSpec(), {
    module: 'custom.controller.services',
    entryFile: 'custom/controller/services.py',
    workerListModule: 'custom.controller.workers',
  });
  assert.equal(resolveControllerRoot(), ctrlRoot);
  assert.equal(resolveAuWinRoot(), ctrlRoot);
  assert.equal(hasControllerModuleAvailable(), true);
  const listed = await listCursorWorkerInstances({
    hostnames: ['Test-Host'],
    commands: ['node.exe index.js worker --name x9-Demo start'],
  });
  assert.deepEqual(listed.map((item) => item.name), ['x9-Demo']);
});

test('undeclared controller never guesses private paths or module names', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-au-no-ctrl-'));
  isolateEnv(t);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const fakeRoot = path.join(dir, 'Workspace');
  const script = path.join(fakeRoot, 'scripts', 'worker.py');
  mkdirSync(path.dirname(script), { recursive: true });
  writeFileSync(script, '# fixture\n');

  const cloudManifestPath = path.join(dir, 'manifest.cloud.json');
  writeFileSync(cloudManifestPath, JSON.stringify({ schemaVersion: 1, services: {}, devices: [], plugins: {} }));

  process.env.DSH_AU_LOCAL_DIR = path.join(dir, 'local');
  process.env.DSH_AU_CONFIG_PATH = path.join(dir, 'missing-config.json');
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = cloudManifestPath;

  const machineId = 'no-controller-host';
  mkdirSync(path.dirname(machineFilePath(machineId)), { recursive: true });
  writeFileSync(machineFilePath(machineId), JSON.stringify({ schemaVersion: 2, machineId, services: {} }));
  writeActivePointer(machineId);
  assert.equal(setLocalBindingService('worker_svc', { scriptPath: script, controller: 'external' }).ok, true);

  assert.deepEqual(resolveControllerSpec(), { module: '', entryFile: '', workerListModule: '' });
  assert.equal(resolveControllerRoot(), '');
  assert.equal(hasControllerModuleAvailable(), false);
  assert.equal(usesAuWinServiceController('worker_svc'), false);
});

test('resolveControllerSpec validates priority, derivation, and path/module safety', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-au-ctrl-spec-'));
  isolateEnv(t);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const cfgPath = path.join(dir, 'dsh-au.config.json');
  const cloudPath = path.join(dir, 'manifest.cloud.json');
  process.env.DSH_AU_CONFIG_PATH = cfgPath;
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = cloudPath;

  writeFileSync(cloudPath, JSON.stringify({
    controller: { entryFile: 'ext/ctrl/services.py', workerListModule: 'ext.ctrl.workers' },
  }));
  assert.deepEqual(resolveControllerSpec(), {
    module: 'ext.ctrl.services',
    entryFile: 'ext/ctrl/services.py',
    workerListModule: 'ext.ctrl.workers',
  });

  writeFileSync(cfgPath, JSON.stringify({
    controller: { module: 'cfg.ctrl.main' },
  }));
  assert.deepEqual(resolveControllerSpec(), {
    module: 'cfg.ctrl.main',
    entryFile: 'cfg/ctrl/main.py',
    workerListModule: 'ext.ctrl.workers',
  });

  process.env.DSH_AU_CONTROLLER_MODULE = 'env.ctrl.services';
  process.env.DSH_AU_CONTROLLER_WORKER_MODULE = 'env.ctrl.workers';
  assert.deepEqual(resolveControllerSpec(), {
    module: 'env.ctrl.services',
    entryFile: 'env/ctrl/services.py',
    workerListModule: 'env.ctrl.workers',
  });

  // 安全校验拒绝路径穿越和非法模块字符。
  process.env.DSH_AU_CONTROLLER_MODULE = 'bad/module;rm';
  process.env.DSH_AU_CONTROLLER_ENTRY = '../escape/services.py';
  process.env.DSH_AU_CONTROLLER_WORKER_MODULE = 'bad;import';
  assert.deepEqual(resolveControllerSpec(), {
    module: '',
    entryFile: '',
    workerListModule: '',
  });
});

test('buildScriptLaunchSpec passes options.args through without implicitly adding --no-wait', () => {
  const scriptPath = 'C:/Controller/scripts/worker.py';
  const withoutArgs = buildScriptLaunchSpec(scriptPath, { windowless: true });
  assert.equal(withoutArgs.args.includes('--no-wait'), false);

  const withArgs = buildScriptLaunchSpec(scriptPath, { windowless: true, args: ['--no-wait', '--mode', 'fast'] });
  assert.deepEqual(withArgs.args.slice(-3), ['--no-wait', '--mode', 'fast']);
});
