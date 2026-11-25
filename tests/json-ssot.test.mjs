import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getMachineServiceProfile, loadConfig, saveConfig, updateMachineServiceFlag, updateMachineServiceProfile } from '../lib/config-store.js';
import { isWindowsSystemBootService, windowsServiceBootState } from '../lib/background-services.js';
import { cloudDefinitionToLocalBinding, machineFilePath, slugifyMachine, writeActivePointer } from '../lib/local-bindings.js';

const ENV_KEYS = [
  'DSH_AU_LOCAL_DIR', 'DSH_AU_LOCAL_BINDINGS_PATH', 'DSH_AU_MACHINES_DIR',
  'DSH_AU_LOCAL_POINTER_PATH', 'DSH_AU_LOCAL_STATE_PATH', 'DSH_AU_CONFIG_PATH', 'DSH_AU_CLOUD_MANIFEST_PATH',
];

/** 每个用例独占 sync 目录、云清单与 ~/.dsh 配置，不碰真实机器上的文件。 */
function withJsonWorld(run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-au-ssot-'));
  const previous = ENV_KEYS.map((key) => [key, process.env[key]]);
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.DSH_AU_LOCAL_DIR = path.join(dir, 'local');
  process.env.DSH_AU_CONFIG_PATH = path.join(dir, 'dsh-au.config.json');
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = path.join(dir, 'manifest.cloud.json');
  try {
    return run(dir);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** 当前机器绑定只登记 services 里的服务；旧配置名单按入参写进 ~/.dsh。 */
function seed(dir, { services, legacy, state }) {
  const machineId = slugifyMachine(hostname());
  writeJson(machineFilePath(machineId), { schemaVersion: 2, machineId, services });
  writeActivePointer(machineId);
  writeJson(process.env.DSH_AU_CLOUD_MANIFEST_PATH, { schemaVersion: 1, services: {}, devices: [] });
  if (legacy) writeJson(process.env.DSH_AU_CONFIG_PATH, { machineServiceProfiles: { [hostname()]: legacy } });
  if (state) {
    writeJson(path.join(dir, 'local', 'state.json'), { schemaVersion: 1, machines: { [machineId]: { services: state } } });
  }
  return machineId;
}

test('回归 2026-10-27：旧预设里的服务没登记在绑定 JSON 就不算接入', () => {
  withJsonWorld((dir) => {
    seed(dir, {
      services: { antigravity_acp: { name: 'ACP' } },
      legacy: {
        enabled: ['dsh_bridge', 'antigravity', 'proxy', 'antigravity_acp'],
        autoStartOnBoot: ['antigravity', 'proxy'],
        autoStartOnDsh: ['dsh_bridge', 'antigravity'],
      },
    });
    const profile = getMachineServiceProfile(loadConfig(), hostname());
    assert.deepEqual(profile.enabled, ['antigravity_acp'], '只有绑定 JSON 里登记的服务能算接入');
    assert.deepEqual(profile.autoStartOnBoot, [], '旧预设里的 antigravity/proxy 开机自启不能生效');
    assert.deepEqual(profile.autoStartOnDsh, []);
  });
});

test('旧开关只迁一次：已登记且尚无状态的服务才搬，已有状态不被覆盖', () => {
  withJsonWorld((dir) => {
    const machineId = seed(dir, {
      services: { kept: { name: 'K' }, fresh: { name: 'F' } },
      legacy: { enabled: ['kept', 'fresh'], autoStartOnBoot: ['kept', 'fresh'], autoStartOnDsh: ['fresh'] },
      state: { kept: { enabled: false, autoStartOnBoot: false, autoStartOnDsh: false, cloud: false } },
    });
    const profile = getMachineServiceProfile(loadConfig(), hostname());
    assert.deepEqual(profile.enabled, ['fresh'], 'kept 已有 JSON 状态，旧名单不能把它打开');
    assert.deepEqual(profile.autoStartOnBoot, ['fresh']);
    assert.deepEqual(profile.autoStartOnDsh, ['fresh']);

    const saved = JSON.parse(readFileSync(machineFilePath(machineId), 'utf8'));
    assert.equal(saved.services.fresh.enabled, true, '迁移结果落在 machines/<machineId>.json');
  });
});

test('回归 2026-10-27：云定义接入本机时换算成本机事实，不原样照抄', () => {
  const cloudDef = {
    name: 'Antigravity Gateway',
    description: '网关',
    scriptPath: 'gateways/antigravity-gateway/server.py',
    workdir: 'gateways/antigravity-gateway',
    health: 'http://127.0.0.1:8321/health',
    port: 8321,
    log: '',
    doc: 'docs/example-gateway.md',
    launcher: { label: 'com.example.antigravity-gateway' },
    category: 'core',
    control: 'full',
  };
  // 本项目内的路径直接记录为仓库相对路径；展开执行时再由 applyLocalBinding 换算成当前电脑绝对路径。
  const win = cloudDefinitionToLocalBinding(cloudDef, 'win32');
  assert.equal(win.scriptPath, 'gateways/antigravity-gateway/server.py', '本项目内的路径直接记录为仓库相对路径');
  assert.equal(win.launcher, undefined, 'launchd label 是 macOS 专属，Windows 绑定不该带');
  for (const key of ['workdir', 'log', 'category']) {
    assert.equal(Object.hasOwn(win, key), false, `${key} 不属于本机绑定`);
  }
  assert.equal(win.control, 'full', '控制策略作为本机安全限制保留，避免只允许启动的服务被放宽');
  assert.equal(win.health, 'http://127.0.0.1:8321/health');
  assert.equal(win.port, 8321);
  assert.equal(win.doc, cloudDef.doc, 'doc 保持仓库相对路径');

  const mac = cloudDefinitionToLocalBinding(cloudDef, 'darwin');
  assert.equal(mac.scriptPath, 'gateways/antigravity-gateway/server.py');
  assert.deepEqual(mac.launcher, { label: 'com.example.antigravity-gateway' });

  // 仓库外路径：在家目录下缩成 ~/，不在家目录下保持绝对路径且统一用 /。
  const externalHomeScript = path.join(homedir(), 'external-tools', 'worker.py');
  const extBound = cloudDefinitionToLocalBinding({ name: 'Ext', scriptPath: externalHomeScript }, 'win32');
  assert.equal(extBound.scriptPath, '~/external-tools/worker.py');
});

test('面板开关只写 state.json，旧配置名单原样保留作回滚依据', () => {
  withJsonWorld((dir) => {
    const legacy = { enabled: ['svc', 'ghost'], autoStartOnBoot: ['ghost'], autoStartOnDsh: [] };
    seed(dir, { services: { svc: { name: 'S' } }, legacy });

    const cfg = loadConfig();
    const profile = updateMachineServiceProfile(cfg, hostname(), { enabled: ['svc', 'ghost'], autoStartOnDsh: ['svc'] });
    assert.deepEqual(profile.enabled, ['svc'], '未登记的 ghost 不能经由开关接入');
    assert.deepEqual(profile.autoStartOnDsh, ['svc']);
    saveConfig(cfg);

    const onDisk = JSON.parse(readFileSync(process.env.DSH_AU_CONFIG_PATH, 'utf8'));
    assert.deepEqual(onDisk.machineServiceProfiles[hostname()], legacy, '保存配置不能改写或丢掉旧名单');
    assert.deepEqual(getMachineServiceProfile(loadConfig(), hostname()).autoStartOnDsh, ['svc']);
  });
});

test('已登记但未启用时，开启自启自动联动开启本机启用', () => {
  withJsonWorld((dir) => {
    seed(dir, { services: { dsh_bridge: { name: '桥接' } }, state: { dsh_bridge: { enabled: false } } });
    const saved = updateMachineServiceFlag({}, hostname(), 'dsh_bridge', 'autoStartOnBoot', true);
    assert.deepEqual(saved.enabled, ['dsh_bridge']);
    assert.deepEqual(saved.autoStartOnBoot, ['dsh_bridge']);
  });
});

test('单项开关保留其他服务最新设置，停用只清除本项自启', () => {
  withJsonWorld((dir) => {
    seed(dir, { services: { dsh_bridge: { name: '桥接' }, other: { name: '其他' } } });
    updateMachineServiceFlag({}, hostname(), 'dsh_bridge', 'enabled', true);
    updateMachineServiceFlag({}, hostname(), 'other', 'enabled', true);
    updateMachineServiceFlag({}, hostname(), 'other', 'autoStartOnBoot', true);
    const saved = updateMachineServiceFlag({}, hostname(), 'dsh_bridge', 'autoStartOnBoot', true);
    assert.deepEqual(saved.autoStartOnBoot.sort(), ['dsh_bridge', 'other']);
    const stopped = updateMachineServiceFlag({}, hostname(), 'dsh_bridge', 'enabled', false);
    assert.deepEqual(stopped.enabled, ['other']);
    assert.deepEqual(stopped.autoStartOnBoot, ['other']);
    assert.throws(() => updateMachineServiceFlag({}, hostname(), 'ghost', 'enabled', true), /尚未登记/);
    assert.throws(() => updateMachineServiceFlag({}, hostname(), 'other', 'enabled', 'true'), /参数无效/);
  });
});

test('系统自启与本地启用独立：自动、手动、禁用与查询失败不会混淆', () => {
  assert.equal(isWindowsSystemBootService('svc_ipv6_entry', 'win32'), false);
  assert.equal(isWindowsSystemBootService('svc_ipv6_entry', 'darwin'), false);
  assert.equal(isWindowsSystemBootService('dsh_bridge', 'win32'), false);
  assert.equal(windowsServiceBootState('ExampleIPv6Svc', { StartMode: 'Auto' }).enabled, true);
  assert.equal(windowsServiceBootState('ExampleIPv6Svc', { StartMode: 'Manual' }).enabled, false);
  assert.equal(windowsServiceBootState('ExampleIPv6Svc', { StartMode: 'Disabled' }).enabled, false);
  const unknown = windowsServiceBootState('ExampleIPv6Svc');
  assert.equal(unknown.enabled, null);
  assert.equal(unknown.mode, 'unknown');
  assert.equal(unknown.managed, true);
});
