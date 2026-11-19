import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildScriptLaunchSpec,
  createBackgroundServiceManager,
  isRunnableScriptPath,
  serviceControlCapability,
  syncBootStartupEntry,
} from '../lib/background-services.js';
import { useTempSyncRepo } from './helpers/temp-sync-repo.mjs';
import { updateMachineServiceFlag } from '../lib/config-store.js';
import {
  applyLocalBinding,
  expandLocalPath,
  machineFilePath,
  slugifyMachine,
  toHomeRelative,
  toRepoRelativePath,
  writeActivePointer,
} from '../lib/local-bindings.js';
import { inspectLocalServiceManagement, runLocalServicesDoctor } from '../lib/service-doctor.js';

const ENV_KEYS = [
  'DSH_HOME',
  'DSH_AU_LOCAL_DIR',
  'DSH_AU_LOCAL_BINDINGS_PATH',
  'DSH_AU_MACHINES_DIR',
  'DSH_AU_LOCAL_POINTER_PATH',
  'DSH_AU_LOCAL_STATE_PATH',
  'DSH_AU_CONFIG_PATH',
  'DSH_AU_CLOUD_MANIFEST_PATH',
  'DSH_AU_STARTUP_DIR',
  'DSH_AU_PID_DIR',
  'DSH_AU_SYNC_REPO',
];

function withIsolatedEnv(run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-au-doctor-test-'));
  const previous = ENV_KEYS.map((key) => [key, process.env[key]]);
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.DSH_HOME = path.join(dir, 'dsh-home');
  process.env.DSH_AU_LOCAL_DIR = path.join(dir, 'local');
  process.env.DSH_AU_CONFIG_PATH = path.join(dir, 'dsh-au.config.json');
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = path.join(dir, 'manifest.cloud.json');
  process.env.DSH_AU_STARTUP_DIR = path.join(dir, 'startup');
  process.env.DSH_AU_PID_DIR = path.join(dir, 'pids');
  writeFileSync(process.env.DSH_AU_CLOUD_MANIFEST_PATH, JSON.stringify({ schemaVersion: 1, services: {}, devices: [] }));
  return Promise.resolve()
    .then(() => run(dir))
    .finally(() => {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

test('本项目内路径自动归一为仓库相对路径，展开时还原为当前仓库绝对路径', (t) => {
  const { root } = useTempSyncRepo(t);
  const inRepoAbs = path.join(root, 'gateways', 'demo-gateway', 'server.py');
  assert.equal(toRepoRelativePath(inRepoAbs), 'gateways/demo-gateway/server.py');
  assert.equal(toHomeRelative(inRepoAbs), 'gateways/demo-gateway/server.py');
  assert.equal(toRepoRelativePath('gateways/demo-gateway/server.py'), 'gateways/demo-gateway/server.py');
  assert.equal(expandLocalPath('gateways/demo-gateway/server.py'), inRepoAbs);

  const bound = applyLocalBinding(
    { id: 'demo_gateway', name: 'Demo Gateway' },
    { demo_gateway: { scriptPath: 'gateways/demo-gateway/server.py', health: 'http://127.0.0.1:8321/health' } },
    {},
  );
  assert.equal(bound.scriptPath, inRepoAbs);
  assert.equal(bound.scriptPathShort, 'gateways/demo-gateway/server.py');
});

test('任意路径与任意系统脚本均可通过本地绑定 JSON 获得控制与开机自启能力', async () => {
  await withIsolatedEnv(async (dir) => {
    const customScript = path.join(dir, 'custom-dir', 'my_worker.mjs');
    mkdirSync(path.dirname(customScript), { recursive: true });
    writeFileSync(customScript, 'setInterval(() => {}, 1000);\n', 'utf8');

    const bindings = {
      any_py: { name: 'Python 服务', scriptPath: '/opt/anywhere/service.py' },
      any_sh: { name: 'Shell 服务', scriptPath: '/usr/local/bin/run-daemon.sh' },
      any_mjs: { name: 'Node 服务', scriptPath: customScript },
      config_only: { name: '纯配置', scriptPath: '/etc/some/config.json' },
    };

    assert.equal(isRunnableScriptPath('/opt/anywhere/service.py', 'linux'), true);
    assert.equal(isRunnableScriptPath('/usr/local/bin/run-daemon.sh', 'darwin'), true);
    assert.equal(isRunnableScriptPath(customScript, 'win32'), true);
    assert.equal(isRunnableScriptPath('/etc/some/config.json', 'win32'), false);

    assert.equal(serviceControlCapability('any_py', { bindings, platform: 'linux' }).canControl, true);
    assert.equal(serviceControlCapability('any_sh', { bindings, platform: 'darwin' }).canControl, true);
    assert.equal(serviceControlCapability('any_mjs', { bindings, platform: 'win32' }).canControl, true);

    assert.equal(buildScriptLaunchSpec('/usr/local/bin/run-daemon.sh', { platform: 'linux' }).command, 'bash');
    assert.equal(buildScriptLaunchSpec('/opt/app/task.ps1', { platform: 'darwin' }).command, 'pwsh');

    const machineId = slugifyMachine(hostname());
    const mFile = machineFilePath(machineId);
    mkdirSync(path.dirname(mFile), { recursive: true });
    writeFileSync(mFile, JSON.stringify({
      schemaVersion: 2,
      machineId,
      services: {
        any_mjs: { name: 'Node 服务', scriptPath: customScript.replace(/\\/g, '/') },
      },
    }, null, 2));
    writeActivePointer(machineId);

    const profile = { enabled: ['any_mjs'], autoStartOnBoot: ['any_mjs'], autoStartOnDsh: ['any_mjs'] };
    const winBoot = await syncBootStartupEntry(hostname(), profile, 'win32');
    assert.equal(winBoot.synced, true);
    assert.deepEqual(winBoot.activeServices, ['any_mjs']);
    assert.equal(existsSync(winBoot.filePath), true);

    const macBoot = await syncBootStartupEntry(hostname(), profile, 'darwin');
    assert.equal(macBoot.synced, true);
    assert.deepEqual(macBoot.activeServices, ['any_mjs']);
    assert.match(readFileSync(macBoot.filePath, 'utf8'), /my_worker\.mjs/);

    const linuxBoot = await syncBootStartupEntry(hostname(), profile, 'linux');
    assert.equal(linuxBoot.synced, true);
    assert.deepEqual(linuxBoot.activeServices, ['any_mjs']);
    assert.match(readFileSync(linuxBoot.filePath, 'utf8'), /\[Desktop Entry\]/);
  });
});

test('本地服务 Doctor 能检查启用、开机自启、随 DSH 自启及 start/restart/stop 全链路闭环', async () => {
  await withIsolatedEnv(async (dir) => {
    const port = await getFreePort();
    const mockServerScript = path.join(dir, 'arbitrary-service', 'mock-http-service.mjs');
    mkdirSync(path.dirname(mockServerScript), { recursive: true });
    writeFileSync(mockServerScript, [
      "import http from 'node:http';",
      `const srv = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });`,
      `srv.listen(${port}, '127.0.0.1');`,
      "process.on('SIGTERM', () => srv.close(() => process.exit(0)));",
    ].join('\n'), 'utf8');

    const syncRepo = path.join(dir, 'sync-repo');
    const inRepoAbs = path.join(syncRepo, 'gateways', 'demo-gateway', 'server.py');
    mkdirSync(path.dirname(inRepoAbs), { recursive: true });
    writeFileSync(inRepoAbs, 'print("ok")\n');
    process.env.DSH_AU_SYNC_REPO = syncRepo;

    const machineId = slugifyMachine(hostname());
    const mFile = machineFilePath(machineId);
    mkdirSync(path.dirname(mFile), { recursive: true });
    writeFileSync(mFile, JSON.stringify({
      schemaVersion: 2,
      machineId,
      hostname: hostname(),
      services: {
        custom_http_svc: {
          name: '任意路径测试服务',
          scriptPath: mockServerScript.replace(/\\/g, '/'),
          health: `http://127.0.0.1:${port}/health`,
          port,
        },
        in_repo_bad_abs: {
          name: '仓库内未用相对路径的服务',
          scriptPath: inRepoAbs.replace(/\\/g, '/'),
        },
      },
    }, null, 2));
    writeActivePointer(machineId);

    updateMachineServiceFlag({}, hostname(), 'custom_http_svc', 'enabled', true);
    updateMachineServiceFlag({}, hostname(), 'custom_http_svc', 'autoStartOnBoot', true);
    updateMachineServiceFlag({}, hostname(), 'custom_http_svc', 'autoStartOnDsh', true);

    // 1. 检查仓库内绝对路径会被 Doctor 提示应改为相对路径
    const badCheck = await inspectLocalServiceManagement('in_repo_bad_abs', { skipNetworkProbe: true });
    assert.equal(badCheck.status, 'misconfigured');
    assert.equal(badCheck.scriptPath.usesRepoRelative, false);
    assert.equal(badCheck.scriptPath.expectedRepoRelative, 'gateways/demo-gateway/server.py');

    // 2. 对 custom_http_svc 执行带真实生命周期探针的 Doctor 检查
    const liveCheck = await inspectLocalServiceManagement('custom_http_svc', {
      probeLifecycle: true,
      preferScriptRunner: true,
    });
    assert.equal(liveCheck.status, 'managed');
    assert.equal(liveCheck.lifecycleFullyManaged, true);
    assert.equal(liveCheck.capabilities.enabled.supported, true);
    assert.equal(liveCheck.capabilities.autoStartOnBoot.supported, true);
    assert.equal(liveCheck.capabilities.autoStartOnDsh.supported, true);
    assert.equal(liveCheck.capabilities.start.supported, true);
    assert.equal(liveCheck.capabilities.restart.supported, true);
    assert.equal(liveCheck.capabilities.stop.supported, true);
    assert.equal(liveCheck.lifecycleProbe.ok, true);
    assert.equal(liveCheck.lifecycleProbe.steps.start.ok, true);
    assert.equal(liveCheck.lifecycleProbe.steps.restart.ok, true);
    assert.equal(liveCheck.lifecycleProbe.steps.stop.ok, true);

    // 3. 验证随 DSH 自启 (triggerDshAutoStart) 对任意路径脚本同样生效，最后清理停止
    const manager = createBackgroundServiceManager();
    delete globalThis.__dshAuAutoStartedHosts;
    const autoStarted = await manager.triggerDshAutoStart({
      enabled: ['custom_http_svc'],
      autoStartOnDsh: ['custom_http_svc'],
    }, 'doctor-test-host');
    assert.deepEqual(autoStarted, ['custom_http_svc']);
    const stopAfterAuto = await manager.controlService('custom_http_svc', 'stop', { preferScriptRunner: true });
    assert.equal(stopAfterAuto.ok, true);

    // 4. 整机汇总报告验证
    const fullReport = await runLocalServicesDoctor({ serviceId: 'custom_http_svc' });
    assert.equal(fullReport.ok, true);
    assert.equal(fullReport.summary.managed, 1);
  });
});
