import './isolate-sync.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  REPO_ROOT,
  buildCloudServiceEntry,
  normalizeNpmRegistry,
  removeCloudService,
  readCloudManifest,
  readCloudDevices,
  readCloudPlugins,
  resolveCloudManifestPath,
  toRepoRelativePath,
  upsertCloudPlugin,
  upsertCloudService,
  writeCloudDevices,
} from '../lib/cloud-manifest.js';

const inRepoFile = path.join(REPO_ROOT, 'sync', 'cloud', 'manifest.cloud.json');

test('仓库内的路径转成相对路径，仓库外的留空', () => {
  assert.equal(toRepoRelativePath(inRepoFile), 'sync/cloud/manifest.cloud.json');
  assert.equal(toRepoRelativePath(path.join(REPO_ROOT, 'lib')), 'lib');
  // 仓库外：家目录日志、临时目录、相对路径、空值，一律留空
  assert.equal(toRepoRelativePath('/Users/someone/Library/Logs/x.log'), '');
  assert.equal(toRepoRelativePath(path.join(tmpdir(), 'nope.log')), '');
  assert.equal(toRepoRelativePath('relative/path.py'), '');
  assert.equal(toRepoRelativePath(''), '');
  // 仓库内但文件不存在，也不写出去，避免同步一个错的路径
  assert.equal(toRepoRelativePath(path.join(REPO_ROOT, 'gateways', '不存在.py')), '');
});

test('服务条目只填仓库内的路径字段，其余字段照写', () => {
  const entry = buildCloudServiceEntry({
    name: '示例服务',
    description: '说明文字',
    scriptPath: inRepoFile,
    workdir: '/Users/someone/elsewhere',
    health: 'http://127.0.0.1:8321/health',
    port: 8321,
    log: '/Users/someone/Library/Logs/x.log',
    launchd: { label: 'com.example.demo' },
    category: 'core',
    control: 'full',
  });
  assert.equal(entry.scriptPath, 'sync/cloud/manifest.cloud.json');
  assert.equal(entry.workdir, '');
  assert.equal(entry.log, '');
  assert.equal(entry.health, 'http://127.0.0.1:8321/health');
  assert.equal(entry.port, 8321);
  assert.equal(entry.launcher.label, 'com.example.demo');
  assert.equal(entry.category, 'core');
});

test('同步到云写入清单，删除云服务摘掉条目', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-au-cloud-manifest-'));
  const manifestPath = path.join(dir, 'manifest.cloud.json');
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = manifestPath;
  try {
    assert.equal(resolveCloudManifestPath(), manifestPath);

    upsertCloudService({ name: 'A', scriptPath: inRepoFile, port: 1234 }, 'svc_a');
    upsertCloudService({ name: 'B', scriptPath: '/Users/someone/x.py' }, 'svc_b');

    const written = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(written.schemaVersion, 1);
    assert.ok(written.updatedAt);
    assert.deepEqual(Object.keys(written.services).sort(), ['svc_a', 'svc_b']);
    assert.equal(written.services.svc_a.scriptPath, 'sync/cloud/manifest.cloud.json');
    // 仓库外的脚本路径必须留空，否则别的电脑会拿到一个不存在的绝对路径
    assert.equal(written.services.svc_b.scriptPath, '');

    assert.equal(removeCloudService('svc_a').removed, true);
    const after = readCloudManifest().manifest;
    assert.deepEqual(Object.keys(after.services), ['svc_b']);
    // 删不存在的条目不算错
    assert.equal(removeCloudService('svc_a').removed, false);
  } finally {
    delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('云清单文件损坏时按空表处理，不让调用方崩', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-au-cloud-bad-'));
  const manifestPath = path.join(dir, 'bad.json');
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = manifestPath;
  try {
    writeFileSync(manifestPath, '{ 不是合法 JSON', 'utf8');
    const result = readCloudManifest();
    assert.deepEqual(result.manifest.services, {});
    assert.ok(result.error);
    // 接下来还能正常写入新条目
    upsertCloudService({ name: 'C' }, 'svc_c');
    assert.deepEqual(Object.keys(readCloudManifest().manifest.services), ['svc_c']);
  } finally {
    delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('设备定义与服定义共存一份文件，互不覆盖', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-au-cloud-devices-'));
  const manifestPath = path.join(dir, 'manifest.cloud.json');
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = manifestPath;
  try {
    upsertCloudService({ name: '服务A' }, 'svc_a');
    writeCloudDevices([
      { id: 'example-mac', name: 'mac', routes: [{ id: 'r1', type: 'tunnel', url: 'https://a.example/', username: 'u' }] },
    ]);

    const afterDevices = readCloudManifest().manifest;
    // 写设备不能把服务定义冲掉
    assert.deepEqual(Object.keys(afterDevices.services), ['svc_a']);
    assert.deepEqual(readCloudDevices().map((d) => d.id), ['example-mac']);

    upsertCloudService({ name: '服务B' }, 'svc_b');
    // 反之，写服务也不能把设备定义冲掉
    assert.deepEqual(readCloudDevices().map((d) => d.id), ['example-mac']);
    assert.deepEqual(Object.keys(readCloudManifest().manifest.services).sort(), ['svc_a', 'svc_b']);

    writeCloudDevices([]);
    assert.deepEqual(Object.keys(readCloudManifest().manifest.services).sort(), ['svc_a', 'svc_b']);
  } finally {
    delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doc 字段非必填：仓库内填相对路径，缺失或仓库外留空', () => {
  // 相对写法（推荐）：直接写仓库内相对路径
  const withRelative = buildCloudServiceEntry({ name: 'A', doc: 'README.md' });
  assert.equal(withRelative.doc, 'README.md');

  // 绝对写法：落在仓库内也规范成相对路径
  const withAbsolute = buildCloudServiceEntry({
    name: 'B',
    doc: path.join(REPO_ROOT, 'README.md'),
  });
  assert.equal(withAbsolute.doc, 'README.md');

  // 不填 / 文件不存在 / 仓库外：一律留空
  assert.equal(buildCloudServiceEntry({ name: 'C' }).doc, '');
  assert.equal(buildCloudServiceEntry({ name: 'D', doc: 'docs/不存在.md' }).doc, '');
  assert.equal(buildCloudServiceEntry({ name: 'E', doc: '/Users/someone/note.md' }).doc, '');
});

test('只写在 JSON 里的服务也会出现在列表，且标为仅展示', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-au-json-service-'));
  const manifestPath = path.join(dir, 'manifest.cloud.json');
  const localPath = path.join(dir, 'manifest.local.json');
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = manifestPath;
  process.env.DSH_AU_LOCAL_BINDINGS_PATH = localPath;
  try {
    writeFileSync(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      updatedAt: '',
      services: {
        cloud_only: { name: '云里定义的服务', description: '只在云清单', health: 'http://127.0.0.1:9999/health', port: 9999 },
      },
      devices: [],
    }, null, 2)}\n`, 'utf8');
    writeFileSync(localPath, `${JSON.stringify({
      schemaVersion: 2,
      hostname: 'test',
      services: {
        local_only: {
          name: '本机定义的服务',
          health: 'http://127.0.0.1:8888/health',
          scriptPath: inRepoFile,
          enabled: true,
        },
      },
    }, null, 2)}\n`, 'utf8');

    const { createBackgroundServiceManager } = await import('../lib/background-services.js');
    const list = await createBackgroundServiceManager().listServices(false);

    const cloudOnly = list.find((svc) => svc.id === 'cloud_only');
    assert.ok(cloudOnly, '云清单里的服务必须出现在列表里');
    assert.equal(cloudOnly.name, '云里定义的服务');
    // 代码里没有内建控制定义，只能展示，不能假装能启停
    assert.equal(cloudOnly.control, 'view');

    const localOnly = list.find((svc) => svc.id === 'local_only');
    assert.ok(localOnly, '本机绑定里的服务必须出现在列表里');
    assert.equal(localOnly.name, '本机定义的服务');
    assert.equal(localOnly.control, 'view');
    assert.equal(localOnly.port, 8888, '端口应从 health 自动推导');
  } finally {
    delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    delete process.env.DSH_AU_LOCAL_BINDINGS_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('回归 2026-10-27：Windows 扫描不展示未登记的内置服务', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-au-unregistered-service-'));
  const manifestPath = path.join(dir, 'manifest.cloud.json');
  const localPath = path.join(dir, 'manifest.local.json');
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = manifestPath;
  process.env.DSH_AU_LOCAL_BINDINGS_PATH = localPath;
  try {
    writeFileSync(manifestPath, `${JSON.stringify({
      schemaVersion: 1, updatedAt: '', services: {}, devices: [],
    }, null, 2)}\n`, 'utf8');
    writeFileSync(localPath, `${JSON.stringify({
      schemaVersion: 2, hostname: 'test', services: {},
    }, null, 2)}\n`, 'utf8');

    const { createBackgroundServiceManager } = await import('../lib/background-services.js');
    const list = await createBackgroundServiceManager().listServices(false);

    assert.equal(list.some((svc) => svc.id === 'antigravity'), false,
      '扫描器发现内置服务时，未登记服务不能进入面板列表');
  } finally {
    delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    delete process.env.DSH_AU_LOCAL_BINDINGS_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('只写在 JSON 里的服务 id 也能接入本机，不需要改代码白名单', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-au-json-id-'));
  const manifestPath = path.join(dir, 'manifest.cloud.json');
  const localPath = path.join(dir, 'manifest.local.json');
  const configPath = path.join(dir, 'dsh-au.config.json');
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = manifestPath;
  process.env.DSH_AU_LOCAL_BINDINGS_PATH = localPath;
  process.env.DSH_AU_CONFIG_PATH = configPath;
  try {
    writeFileSync(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      updatedAt: '',
      services: { custom_svc: { name: '自定义服务', health: 'http://127.0.0.1:7777/health' } },
      devices: [],
    }, null, 2)}\n`, 'utf8');
    writeFileSync(localPath, `${JSON.stringify({
      schemaVersion: 2,
      hostname: 'test',
      services: { custom_svc: { name: '自定义服务', health: 'http://127.0.0.1:7777/health' } },
    }, null, 2)}\n`, 'utf8');

    const { knownServiceIds, loadConfig, updateMachineServiceProfile } = await import('../lib/config-store.js');
    assert.ok(knownServiceIds().has('custom_svc'), 'JSON 里的 id 必须算合法');

    // 本机服务档是唯一状态来源：直接在 ~/.dsh 配置里记下来。
    const cfg = loadConfig();
    const profile = updateMachineServiceProfile(cfg, 'json-id-test-host', {
      enabled: ['custom_svc'],
      autoStartOnBoot: [],
      autoStartOnDsh: [],
    });
    assert.deepEqual(profile.enabled, ['custom_svc']);
  } finally {
    for (const key of ['DSH_AU_CLOUD_MANIFEST_PATH', 'DSH_AU_LOCAL_BINDINGS_PATH', 'DSH_AU_CONFIG_PATH']) delete process.env[key];
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildCloudServiceEntry 过滤含 userinfo 或敏感 query 参数的 health URL', () => {
  const stringWithUserinfo = buildCloudServiceEntry({
    name: 'A',
    health: 'https://admin:secret123@example.com/health',
  });
  assert.equal(stringWithUserinfo.health, '');

  const stringWithSensitiveQuery = buildCloudServiceEntry({
    name: 'B',
    health: 'https://example.com/health?token=abc123&ok=1',
  });
  assert.equal(stringWithSensitiveQuery.health, '');

  const arrayMixed = buildCloudServiceEntry({
    name: 'C',
    health: [
      'http://127.0.0.1:8321/health',
      'https://user:pass@example.com/health',
      'https://example.com/status?api_key=xyz',
      'https://example.com/ready?v=1',
    ],
  });
  assert.deepEqual(arrayMixed.health, [
    'http://127.0.0.1:8321/health',
    'https://example.com/ready?v=1',
  ]);
});

test('normalizeNpmRegistry 与 upsertCloudPlugin 拒绝含凭据或敏感 query 参数的 registry URL', () => {
  assert.equal(normalizeNpmRegistry('https://registry.npmmirror.com/'), 'https://registry.npmmirror.com/');
  assert.equal(normalizeNpmRegistry('https://user:pass@npm.example.com/'), '');
  assert.equal(normalizeNpmRegistry('https://user@npm.example.com/'), '');
  assert.equal(normalizeNpmRegistry('https://npm.example.com/?token=secret'), '');
  assert.equal(normalizeNpmRegistry('https://npm.example.com/?auth=123'), '');

  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-au-cloud-registry-'));
  const manifestPath = path.join(dir, 'manifest.cloud.json');
  const prev = process.env.DSH_AU_CLOUD_MANIFEST_PATH;
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = manifestPath;
  try {
    upsertCloudPlugin({
      id: 'p1',
      package: 'pkg-one',
      source: 'npm',
      version: '1.0.0',
      registry: 'https://user:secret@npm.example.com/',
    });
    upsertCloudPlugin({
      id: 'p2',
      package: 'pkg-two',
      source: 'npm',
      version: '1.0.0',
      registry: 'https://registry.npmmirror.com/',
    });
    const plugins = readCloudPlugins();
    assert.equal(plugins.find((p) => p.id === 'p1')?.registry, undefined);
    assert.equal(plugins.find((p) => p.id === 'p2')?.registry, 'https://registry.npmmirror.com/');
  } finally {
    if (prev === undefined) delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    else process.env.DSH_AU_CLOUD_MANIFEST_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('云清单幂等写入：重复同步相同插件/服务/设备不改 updatedAt 且返回 unchanged: true，实际变更时更新落盘', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-au-cloud-idempotent-'));
  const manifestPath = path.join(dir, 'manifest.cloud.json');
  const prev = process.env.DSH_AU_CLOUD_MANIFEST_PATH;
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = manifestPath;
  try {
    const pluginInput = {
      id: 'demo-plugin',
      name: 'Demo Plugin',
      package: 'demo-plugin',
      source: 'npm',
      version: '1.0.0',
      registry: 'https://registry.npmmirror.com/',
    };
    const serviceInput = {
      name: '示例服务',
      description: '初始描述',
      scriptPath: inRepoFile,
      port: 8321,
      health: 'http://127.0.0.1:8321/health',
    };
    const devicesInput = [
      { id: 'mac-mini', name: 'Mac', routes: [{ id: 'r1', type: 'tunnel', url: 'https://mac.example/' }] },
    ];

    // 1. 初次写入：返回 unchanged: false 并正常落盘
    const firstPlugin = upsertCloudPlugin(pluginInput, 'demo-plugin');
    assert.equal(firstPlugin.unchanged, false);
    assert.ok(firstPlugin.manifest.updatedAt);

    const firstService = upsertCloudService(serviceInput, 'demo_svc');
    assert.equal(firstService.unchanged, false);

    const firstDevices = writeCloudDevices(devicesInput);
    assert.equal(firstDevices.unchanged, false);

    const baselineRaw = readFileSync(manifestPath, 'utf8');
    const baselineParsed = JSON.parse(baselineRaw);

    // 2. 重复调用相同内容：均返回 unchanged: true，且磁盘内容与 updatedAt 保持完全不变
    const samePlugin = upsertCloudPlugin(pluginInput, 'demo-plugin');
    assert.equal(samePlugin.unchanged, true);
    assert.equal(samePlugin.manifest.updatedAt, baselineParsed.updatedAt);
    assert.equal(samePlugin.manifest.schemaVersion, 1);
    assert.equal(readFileSync(manifestPath, 'utf8'), baselineRaw);

    const sameService = upsertCloudService(serviceInput, 'demo_svc');
    assert.equal(sameService.unchanged, true);
    assert.equal(sameService.manifest.updatedAt, baselineParsed.updatedAt);
    assert.equal(readFileSync(manifestPath, 'utf8'), baselineRaw);

    const sameDevices = writeCloudDevices(devicesInput);
    assert.equal(sameDevices.unchanged, true);
    assert.equal(sameDevices.manifest.updatedAt, baselineParsed.updatedAt);
    assert.equal(readFileSync(manifestPath, 'utf8'), baselineRaw);

    // 3. 人工调整磁盘 JSON 键序并固定旧时间戳后再次重复写入，仍应判为一致且保留旧时间戳
    const fixedOldTime = '2026-01-01T00:00:00.000Z';
    const reorderedRaw = `${JSON.stringify({
      plugins: baselineParsed.plugins,
      devices: baselineParsed.devices,
      services: baselineParsed.services,
      updatedAt: fixedOldTime,
      schemaVersion: 1,
    }, null, 2)}\n`;
    writeFileSync(manifestPath, reorderedRaw, 'utf8');

    const reorderedSame = upsertCloudPlugin(pluginInput, 'demo-plugin');
    assert.equal(reorderedSame.unchanged, true);
    assert.equal(reorderedSame.manifest.updatedAt, fixedOldTime);
    assert.equal(readFileSync(manifestPath, 'utf8'), reorderedRaw);

    // 4. 实际修改插件版本：返回 unchanged: false，落盘并更新 updatedAt
    const updatedPlugin = upsertCloudPlugin({ ...pluginInput, version: '1.1.0' }, 'demo-plugin');
    assert.equal(updatedPlugin.unchanged, false);
    assert.notEqual(updatedPlugin.manifest.updatedAt, fixedOldTime);
    assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).plugins['demo-plugin'].version, '1.1.0');

    // 5. 实际修改服务描述：返回 unchanged: false，落盘并更新 updatedAt
    const beforeServiceEdit = JSON.parse(readFileSync(manifestPath, 'utf8'));
    writeFileSync(manifestPath, `${JSON.stringify({ ...beforeServiceEdit, updatedAt: fixedOldTime }, null, 2)}\n`, 'utf8');
    const updatedService = upsertCloudService({ ...serviceInput, description: '新描述' }, 'demo_svc');
    assert.equal(updatedService.unchanged, false);
    assert.notEqual(updatedService.manifest.updatedAt, fixedOldTime);
    assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).services.demo_svc.description, '新描述');

    // 6. 实际修改设备路由：返回 unchanged: false，落盘并更新 updatedAt
    const beforeDeviceEdit = JSON.parse(readFileSync(manifestPath, 'utf8'));
    writeFileSync(manifestPath, `${JSON.stringify({ ...beforeDeviceEdit, updatedAt: fixedOldTime }, null, 2)}\n`, 'utf8');
    const updatedDevices = writeCloudDevices([
      { id: 'mac-mini', name: 'Mac', routes: [{ id: 'r1', type: 'tunnel', url: 'https://mac-v2.example/' }] },
    ]);
    assert.equal(updatedDevices.unchanged, false);
    assert.notEqual(updatedDevices.manifest.updatedAt, fixedOldTime);
    assert.equal(
      JSON.parse(readFileSync(manifestPath, 'utf8')).devices[0].routes[0].url,
      'https://mac-v2.example/',
    );
  } finally {
    if (prev === undefined) delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    else process.env.DSH_AU_CLOUD_MANIFEST_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
