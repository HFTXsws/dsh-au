import './isolate-sync.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  findLatestMachinePreferences,
  loadMachinePreferences,
  loadMachineSettingsBackup,
  sanitizeCloudSyncBackup,
  sanitizeOfficialSettingsBackup,
  sanitizePluginConfigs,
  sanitizeSidebarExtensions,
  saveMachinePreferences,
  saveMachineSettingsBackup,
  saveMenuFavorites,
  updateMachinePlugins,
} from '../lib/local-bindings.js';
import { loadConfig } from '../lib/config-store.js';
import { readModelShortcuts, saveModelShortcuts } from '../lib/model-shortcuts.js';
import { syncOfficialDshAuPreferences } from '../lib/official-settings-sync.js';

function useTempSyncDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-au-machine-prefs-'));
  const previous = process.env.DSH_AU_LOCAL_DIR;
  process.env.DSH_AU_LOCAL_DIR = path.join(dir, 'local');
  mkdirSync(path.join(dir, 'local', 'machines'), { recursive: true });
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_AU_LOCAL_DIR;
    else process.env.DSH_AU_LOCAL_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    localDir: path.join(dir, 'local'),
    machineFile: (id) => path.join(dir, 'local', 'machines', `${id}.json`),
    pointTo: (id) => writeFileSync(
      path.join(dir, 'local', 'active.json'),
      JSON.stringify({ schemaVersion: 1, machineId: id, switchedAt: '' }),
    ),
    clearPointer: () => rmSync(path.join(dir, 'local', 'active.json'), { force: true }),
  };
}

test('机器偏好只写当前电脑那份，原有服务绑定不被抹掉', (t) => {
  const fixture = useTempSyncDir(t);
  fixture.pointTo('machine-a');
  writeFileSync(fixture.machineFile('machine-a'), JSON.stringify({
    schemaVersion: 2,
    machineId: 'machine-a',
    displayName: '电脑 A',
    services: { antigravity: { name: 'Antigravity Gateway', scriptPath: 'gateways/a.py' } },
    menuFavorites: ['11'],
  }));

  const saved = saveMachinePreferences({
    shortcutOverrides: { 'todo.toggle': { code: 'KeyT', ctrl: true, alt: true, shift: false, meta: false } },
    modelShortcuts: { enabled: true, binding: null, slots: [] },
  });
  assert.equal(saved.ok, true);

  const written = JSON.parse(readFileSync(fixture.machineFile('machine-a'), 'utf8'));
  assert.deepEqual(written.menuFavorites, ['11']);
  assert.equal(written.services.antigravity.scriptPath, 'gateways/a.py');
  assert.equal(written.shortcutOverrides['todo.toggle'].code, 'KeyT');
  assert.equal(written.modelShortcuts.enabled, true);
  assert.ok(written.updatedAt);

  const loaded = loadMachinePreferences();
  assert.equal(loaded.machineId, 'machine-a');
  assert.equal(loaded.shortcutOverrides['todo.toggle'].code, 'KeyT');
  assert.equal(loaded.modelShortcuts.enabled, true);

  // 保存常用收藏走另一条写路径，也不能把本机设置抹掉。
  const favorites = saveMenuFavorites(['11', '33']);
  assert.equal(favorites.ok, true);
  const afterFavorites = JSON.parse(readFileSync(fixture.machineFile('machine-a'), 'utf8'));
  assert.equal(afterFavorites.shortcutOverrides['todo.toggle'].code, 'KeyT');
  assert.equal(afterFavorites.modelShortcuts.enabled, true);
});

test('新电脑没有自己那份时，从最近更新的设备备份取初值作为来源', (t) => {
  const fixture = useTempSyncDir(t);
  fixture.pointTo('machine-a');
  // 先有设备 A 的机器备份，模拟另一台已经推送过配置的电脑。
  writeFileSync(fixture.machineFile('machine-a'), JSON.stringify({
    schemaVersion: 2,
    machineId: 'machine-a',
    services: {},
  }));
  saveMachinePreferences({
    shortcutOverrides: { 'device.next': { code: 'KeyN', ctrl: false, alt: true, shift: false, meta: false } },
    modelShortcuts: { enabled: false, binding: null, slots: [{ provider: 'azure-full', model: 'x' }] },
  });

  // 模拟另一台什么都没配过的电脑：没有指针，也没有自己的机器备份。
  fixture.clearPointer();
  const own = loadMachinePreferences();
  assert.equal(own.exists, false);
  assert.equal(own.shortcutOverrides, null);

  const latest = findLatestMachinePreferences();
  assert.equal(latest.shortcutSource, 'machine-a');
  assert.equal(latest.shortcutOverrides['device.next'].code, 'KeyN');
  assert.equal(latest.modelSource, 'machine-a');
  assert.equal(latest.modelShortcuts.slots[0].provider, 'azure-full');
  assert.equal(latest.modelShortcuts.slots[0].model, 'x');

  // 取初值后写回自己的那份，不能改到来源设备。
  saveMachinePreferences({ shortcutOverrides: latest.shortcutOverrides });
  const ownId = loadMachinePreferences().machineId;
  assert.notEqual(ownId, 'machine-a');
  const sourceAfter = JSON.parse(readFileSync(fixture.machineFile('machine-a'), 'utf8'));
  assert.equal(sourceAfter.modelShortcuts.enabled, false);
  assert.equal(sourceAfter.shortcutOverrides['device.next'].code, 'KeyN');
});

test('模型槽位首次读取时把旧的仓库共享配置迁到本机，之后只认本机', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-au-model-migrate-'));
  const previousHome = process.env.DSH_HOME;
  const previousPath = process.env.DSH_AU_MODEL_SHORTCUTS_PATH;
  const previousLocal = process.env.DSH_AU_LOCAL_DIR;
  delete process.env.DSH_AU_MODEL_SHORTCUTS_PATH;
  process.env.DSH_HOME = path.join(dir, 'home');
  process.env.DSH_AU_LOCAL_DIR = path.join(dir, 'local');
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    if (previousPath === undefined) delete process.env.DSH_AU_MODEL_SHORTCUTS_PATH;
    else process.env.DSH_AU_MODEL_SHORTCUTS_PATH = previousPath;
    if (previousLocal === undefined) delete process.env.DSH_AU_LOCAL_DIR;
    else process.env.DSH_AU_LOCAL_DIR = previousLocal;
    rmSync(dir, { recursive: true, force: true });
  });

  const repoRoot = path.join(dir, 'repo');
  const legacyPath = path.join(repoRoot, 'dsh-au', 'sync', 'cloud', 'model-shortcuts.json');
  mkdirSync(path.dirname(legacyPath), { recursive: true });
  writeFileSync(legacyPath, JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    binding: { code: 'KeyM', ctrl: false, alt: true, shift: false, meta: false },
    slots: [{ provider: 'azure-full', model: 'legacy-model' }],
  }));

  const first = readModelShortcuts({ repoRoot });
  assert.equal(first.exists, true);
  assert.equal(first.migratedFrom, legacyPath);
  assert.equal(first.modelShortcuts.enabled, true);
  assert.equal(first.modelShortcuts.slots[0].provider, 'azure-full');
  assert.equal(first.modelShortcuts.slots[0].model, 'legacy-model');
  const localPath = path.join(dir, 'home', 'model-shortcuts.json');
  assert.equal(existsSync(localPath), true);

  // 旧文件之后被改动也不会再影响本机，说明只读本机那份。
  writeFileSync(legacyPath, JSON.stringify({ schemaVersion: 1, enabled: false, binding: null, slots: [] }));
  const second = readModelShortcuts({ repoRoot });
  assert.equal(second.modelShortcuts.enabled, true);
  assert.equal(second.modelShortcuts.slots[0].provider, 'azure-full');
  assert.equal(second.modelShortcuts.slots[0].model, 'legacy-model');

  // 保存只写本机文件，不再写仓库旧文件。
  saveModelShortcuts({ enabled: false }, { repoRoot });
  const savedLocal = JSON.parse(readFileSync(localPath, 'utf8'));
  assert.equal(savedLocal.enabled, false);
  const legacyAfter = JSON.parse(readFileSync(legacyPath, 'utf8'));
  assert.equal(legacyAfter.enabled, false);
});

test('发布链路：未勾选 shortcuts 时不同步覆盖本机，保留本机单机备份/已有值', (t) => {
  const fixture = useTempSyncDir(t);
  fixture.pointTo('machine-a');
  const binding = (code) => ({ code, ctrl: false, alt: true, shift: false, meta: false });
  writeFileSync(fixture.machineFile('machine-a'), JSON.stringify({
    schemaVersion: 2,
    machineId: 'machine-a',
    services: {},
    shortcutOverrides: { 'todo.toggle': binding('KeyN') },
  }));

  const repoRoot = path.join(fixture.dir, 'repo');
  const cloudDir = path.join(repoRoot, 'dsh-au', 'sync', 'cloud');
  mkdirSync(cloudDir, { recursive: true });
  writeFileSync(path.join(cloudDir, 'dsh-au-preferences.json'), JSON.stringify({
    schemaVersion: 1,
    todo: true,
    shortcutOverrides: { 'todo.toggle': binding('KeyC') },
  }));

  const dshHome = path.join(fixture.dir, 'home');
  mkdirSync(dshHome, { recursive: true });
  const configPath = path.join(dshHome, 'dsh-au.config.json');

  // 未勾选 shortcuts（preferences: []）时，本机已有值不被云端覆盖。
  writeFileSync(configPath, JSON.stringify({
    clientPreferences: { shortcutOverrides: { 'todo.toggle': binding('KeyL') } },
  }));
  syncOfficialDshAuPreferences({ repoRoot, dshHome, preferences: [] });
  const kept = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(kept.clientPreferences.shortcutOverrides['todo.toggle'].code, 'KeyL');

  // 本机缺失 shortcutOverrides 且未勾选 shortcuts 时，云端不写入，启动读取仍回落到单机备份。
  writeFileSync(configPath, JSON.stringify({ instanceId: 'au_keep_local' }));
  syncOfficialDshAuPreferences({ repoRoot, dshHome, preferences: [] });
  const afterSync = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(afterSync.clientPreferences?.shortcutOverrides, undefined);

  const prevCfg = process.env.DSH_AU_CONFIG_PATH;
  const prevManifest = process.env.DSH_AU_CLOUD_MANIFEST_PATH;
  const manifestPath = path.join(fixture.dir, 'manifest.cloud.json');
  writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, services: {}, devices: [] }));
  process.env.DSH_AU_CONFIG_PATH = configPath;
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = manifestPath;
  try {
    const loaded = loadConfig();
    assert.equal(loaded.clientPreferences.shortcutOverrides['todo.toggle'].code, 'KeyN');
  } finally {
    if (prevCfg === undefined) delete process.env.DSH_AU_CONFIG_PATH;
    else process.env.DSH_AU_CONFIG_PATH = prevCfg;
    if (prevManifest === undefined) delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    else process.env.DSH_AU_CLOUD_MANIFEST_PATH = prevManifest;
  }
});

test('sanitizeCloudSyncBackup 仅保留持久化配置字段并剔除运行态字段', () => {
  const sanitized = sanitizeCloudSyncBackup({
    enabled: true,
    profile: 'default',
    selectedItems: ['ui-theme', 'ui-theme', ''],
    selectedPlugins: ['dsh-au'],
    syncPluginConfigs: ['dsh-au'],
    selectedPreferences: ['shortcuts'],
    customized: true,
    pluginsCustomized: false,
    lastSyncedHash: 'abc123',
    lastSyncedAt: '2026-01-01T00:00:00Z',
    lastLocalHash: 'def456',
    conflict: true,
    conflictReason: 'diverged',
  });
  assert.deepEqual(sanitized, {
    enabled: true,
    profile: 'default',
    selectedItems: ['ui-theme'],
    selectedPlugins: ['dsh-au'],
    syncPluginConfigs: ['dsh-au'],
    selectedPreferences: ['shortcuts'],
    customized: true,
    pluginsCustomized: false,
  });
  assert.equal(sanitizeCloudSyncBackup(null), null);
});

test('单机备份设置读写与跨写路径保留，无同步仓库时安全返回 no-sync-repo', (t) => {
  const fixture = useTempSyncDir(t);
  fixture.pointTo('machine-s');
  writeFileSync(fixture.machineFile('machine-s'), JSON.stringify({
    schemaVersion: 2,
    machineId: 'machine-s',
    menuFavorites: ['11'],
    plugins: ['dsh-au'],
    services: { svc: { name: 'Svc', enabled: true } },
    shortcutOverrides: { 'todo.toggle': { code: 'KeyT', ctrl: true, alt: true, shift: false, meta: false } },
  }));

  const geom = {
    bounds: { x: 100, y: 80, width: 1200, height: 800 },
    display: { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1080 },
    fullscreen: false,
    maximized: false,
    savedAt: '2026-01-01T00:00:00.000Z',
  };
  const saved = saveMachineSettingsBackup({
    windowGeometry: geom,
    disconnectRemotesOnLock: true,
    cloudSync: {
      enabled: true,
      profile: 'default',
      selectedItems: ['ui-theme'],
      customized: true,
      lastSyncedHash: 'should-strip',
      conflict: true,
    },
    syncRepoRoot: '/tmp/my-sync-repo',
  }, 'machine-s');
  assert.equal(saved.ok, true);

  // 保存收藏后，新增单机备份字段仍完整保留
  const fav = saveMenuFavorites(['11', '22']);
  assert.equal(fav.ok, true);

  const loaded = loadMachineSettingsBackup('machine-s');
  assert.deepEqual(loaded.windowGeometry, geom);
  assert.equal(loaded.disconnectRemotesOnLock, true);
  assert.deepEqual(loaded.cloudSync, {
    enabled: true,
    profile: 'default',
    selectedItems: ['ui-theme'],
    customized: true,
  });
  assert.equal(loaded.syncRepoRoot, '/tmp/my-sync-repo');

  const raw = JSON.parse(readFileSync(fixture.machineFile('machine-s'), 'utf8'));
  assert.equal(raw.services.svc.enabled, true);
  assert.deepEqual(raw.plugins, ['dsh-au']);
  assert.equal(raw.shortcutOverrides['todo.toggle'].code, 'KeyT');

  // 无同步仓库时安全返回 { ok: false, reason: 'no-sync-repo' }
  const keys = ['DSH_AU_LOCAL_DIR', 'DSH_AU_LOCAL_BINDINGS_PATH', 'DSH_AU_LOCAL_POINTER_PATH', 'DSH_AU_LOCAL_STATE_PATH', 'DSH_AU_MACHINES_DIR', 'DSH_AU_SYNC_REPO', 'DSH_AU_CONFIG_PATH'];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  process.env.DSH_AU_CONFIG_PATH = path.join(fixture.dir, 'empty-config.json');
  try {
    const blocked = saveMachineSettingsBackup({ disconnectRemotesOnLock: true }, 'machine-s');
    assert.deepEqual(blocked, { ok: false, reason: 'no-sync-repo' });
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
});

test('loadConfig 启动时从单机备份恢复缺省设置，绝不覆盖本机已显式存在的设置', (t) => {
  const fixture = useTempSyncDir(t);
  fixture.pointTo('machine-cfg');
  const backupGeom = {
    bounds: { x: 40, y: 50, width: 1000, height: 700 },
    display: { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1080 },
    fullscreen: false,
    maximized: false,
    savedAt: '2026-01-01T00:00:00.000Z',
  };
  saveMachineSettingsBackup({
    windowGeometry: backupGeom,
    disconnectRemotesOnLock: true,
    cloudSync: {
      enabled: true,
      selectedItems: ['ui-theme'],
      customized: true,
    },
  }, 'machine-cfg');

  const cfgPath = path.join(fixture.dir, 'dsh-au.config.json');
  const manifestPath = path.join(fixture.dir, 'manifest.cloud.json');
  writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, services: {}, devices: [] }));
  const prevCfg = process.env.DSH_AU_CONFIG_PATH;
  const prevManifest = process.env.DSH_AU_CLOUD_MANIFEST_PATH;
  process.env.DSH_AU_CONFIG_PATH = cfgPath;
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = manifestPath;
  t.after(() => {
    if (prevCfg === undefined) delete process.env.DSH_AU_CONFIG_PATH;
    else process.env.DSH_AU_CONFIG_PATH = prevCfg;
    if (prevManifest === undefined) delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    else process.env.DSH_AU_CLOUD_MANIFEST_PATH = prevManifest;
  });

  // 1. 本机配置缺失上述字段时，从单机备份恢复
  writeFileSync(cfgPath, JSON.stringify({ instanceId: 'au_test1' }));
  const restored = loadConfig();
  assert.equal(restored.features.disconnectRemotesOnLock, true);
  assert.deepEqual(restored.windowState.geometry.bounds, backupGeom.bounds);
  assert.equal(restored.cloudSync.enabled, true);
  assert.deepEqual(restored.cloudSync.selectedItems, ['ui-theme']);

  // 2. 本机显式存在设置时，绝不被备份覆盖
  const localGeom = {
    bounds: { x: 10, y: 20, width: 800, height: 600 },
    display: { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1080 },
    fullscreen: false,
    maximized: false,
    savedAt: '2026-02-01T00:00:00.000Z',
  };
  writeFileSync(cfgPath, JSON.stringify({
    instanceId: 'au_test2',
    features: { disconnectRemotesOnLock: false },
    windowState: { enabled: true, geometry: localGeom },
    cloudSync: { enabled: false, selectedItems: ['ui-chat'], customized: true },
  }));
  const preserved = loadConfig();
  assert.equal(preserved.features.disconnectRemotesOnLock, false);
  assert.deepEqual(preserved.windowState.geometry.bounds, localGeom.bounds);
  assert.equal(preserved.cloudSync.enabled, false);
  assert.deepEqual(preserved.cloudSync.selectedItems, ['ui-chat']);
});

test('sidebarExtensions 单机备份清洗、读写与 loadConfig 缺省恢复及不覆盖本机显式值', (t) => {
  assert.deepEqual(sanitizeSidebarExtensions({
    ' ext-a ': true,
    'ext-b': false,
    '': true,
    '   ': false,
    'ext-str': 'true',
    'ext-num': 1,
  }), {
    'ext-a': true,
    'ext-b': false,
  });
  assert.equal(sanitizeSidebarExtensions(null), null);
  assert.equal(sanitizeSidebarExtensions(['ext-a']), null);

  const fixture = useTempSyncDir(t);
  fixture.pointTo('machine-ext');
  const saved = saveMachineSettingsBackup({
    sidebarExtensions: { 'ext-a': false, 'ext-b': true, bad: 'nope', '': true },
  }, 'machine-ext');
  assert.equal(saved.ok, true);

  // 跨写路径保留 sidebarExtensions
  const fav = saveMenuFavorites(['11']);
  assert.equal(fav.ok, true);

  const loaded = loadMachineSettingsBackup('machine-ext');
  assert.deepEqual(loaded.sidebarExtensions, { 'ext-a': false, 'ext-b': true });

  // 同时保存 shortcutOverrides 用于验证 loadConfig 启动恢复
  saveMachinePreferences({
    shortcutOverrides: { 'todo.toggle': { code: 'KeyB', ctrl: false, alt: true, shift: false, meta: false } },
  });

  const cfgPath = path.join(fixture.dir, 'dsh-au.config.json');
  const manifestPath = path.join(fixture.dir, 'manifest.cloud.json');
  writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, services: {}, devices: [] }));
  const prevCfg = process.env.DSH_AU_CONFIG_PATH;
  const prevManifest = process.env.DSH_AU_CLOUD_MANIFEST_PATH;
  process.env.DSH_AU_CONFIG_PATH = cfgPath;
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = manifestPath;
  t.after(() => {
    if (prevCfg === undefined) delete process.env.DSH_AU_CONFIG_PATH;
    else process.env.DSH_AU_CONFIG_PATH = prevCfg;
    if (prevManifest === undefined) delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    else process.env.DSH_AU_CLOUD_MANIFEST_PATH = prevManifest;
  });

  // 1. 本机缺失时从单机备份恢复初值
  writeFileSync(cfgPath, JSON.stringify({ instanceId: 'au_ext_1' }));
  const restored = loadConfig();
  assert.deepEqual(restored.features.sidebarExtensions, { 'ext-a': false, 'ext-b': true });
  assert.equal(restored.clientPreferences.shortcutOverrides['todo.toggle'].code, 'KeyB');

  // 2. 本机显式存在设置时（含空对象 {}），绝不被单机备份覆盖
  writeFileSync(cfgPath, JSON.stringify({
    instanceId: 'au_ext_2',
    features: { sidebarExtensions: { 'ext-a': true } },
    clientPreferences: { shortcutOverrides: { 'todo.toggle': { code: 'KeyL', ctrl: false, alt: true, shift: false, meta: false } } },
  }));
  const preserved = loadConfig();
  assert.deepEqual(preserved.features.sidebarExtensions, { 'ext-a': true });
  assert.equal(preserved.clientPreferences.shortcutOverrides['todo.toggle'].code, 'KeyL');

  // 3. 传 null 清空 sidebarExtensions 单机备份
  const cleared = saveMachineSettingsBackup({ sidebarExtensions: null }, 'machine-ext');
  assert.equal(cleared.ok, true);
  assert.equal(loadMachineSettingsBackup('machine-ext').sidebarExtensions, undefined);
});

test('officialSettingsBackup 与 pluginConfigs 清洗、读写、assertNoSecrets 零误报、跨写路径保留与 null 清空', (t) => {
  assert.equal(sanitizeOfficialSettingsBackup(null), null);
  assert.equal(sanitizeOfficialSettingsBackup(['a']), null);
  assert.deepEqual(sanitizeOfficialSettingsBackup({}), {});
  assert.deepEqual(sanitizeOfficialSettingsBackup({
    '': { desktopPreferences: '{"a":1}' },
    '   ': { desktopPreferences: '{"a":1}' },
    'bad-entry': 'not-an-object',
    'empty-entry': { cordisBlocks: {}, watchedFiles: { '': 'x' }, unknownField: 'ignored' },
    ' item-a ': {
      cordisBlocks: {
        ' patch-1 ': 'providers:\n  - apiKeyEnv: OPENAI_API_KEY\n',
        '': 'drop',
        badVal: 123,
      },
      desktopPreferences: '{"theme":"dark"}',
      watchedFiles: {
        ' sync/a.yaml ': 'token: just-text\n',
        '   ': 'drop',
        badFile: { nested: true },
      },
      extra: 'should-strip',
    },
  }), {
    'item-a': {
      cordisBlocks: {
        'patch-1': 'providers:\n  - apiKeyEnv: OPENAI_API_KEY\n',
      },
      desktopPreferences: '{"theme":"dark"}',
      watchedFiles: {
        'sync/a.yaml': 'token: just-text\n',
      },
    },
  });

  assert.equal(sanitizePluginConfigs(null), null);
  assert.equal(sanitizePluginConfigs(['dsh-au']), null);
  assert.deepEqual(sanitizePluginConfigs({}), {});
  assert.deepEqual(sanitizePluginConfigs({
    ' dsh-au ': 'apiKeyEnv: DSH_KEY\n',
    '': 'drop',
    '   ': 'drop',
    badNum: 42,
    badObj: { a: 1 },
  }), {
    'dsh-au': 'apiKeyEnv: DSH_KEY\n',
  });

  const fixture = useTempSyncDir(t);
  fixture.pointTo('machine-backup');
  writeFileSync(fixture.machineFile('machine-backup'), JSON.stringify({
    schemaVersion: 2,
    machineId: 'machine-backup',
    menuFavorites: ['11'],
    plugins: ['dsh-au'],
    services: { svc: { name: 'Svc', enabled: true } },
  }));

  const officialSettingsBackup = {
    'official-llm': {
      cordisBlocks: {
        'llm-yaml': 'model: gpt-5\napiKeyEnv: MY_API_KEY\n',
      },
      desktopPreferences: '{"fontSize":14}',
      watchedFiles: {
        'config/models.yaml': 'apiKeyEnv: OTHER_KEY\n',
      },
    },
    'invalid-only': {
      cordisBlocks: { '': 'ignored' },
      unknown: 1,
    },
  };
  const pluginConfigs = {
    'dsh-au': 'server:\n  apiKeyEnv: PLUGIN_KEY\n',
    invalid: 999,
  };

  const saved = saveMachineSettingsBackup({ officialSettingsBackup, pluginConfigs }, 'machine-backup');
  assert.equal(saved.ok, true);

  // 其他写路径（saveMenuFavorites、updateMachinePlugins）不得抹掉这两个字段
  const fav = saveMenuFavorites(['11', '22']);
  assert.equal(fav.ok, true);
  const plug = updateMachinePlugins(['dsh-au', 'dsh-market']);
  assert.equal(plug.ok, true);

  const loaded = loadMachineSettingsBackup('machine-backup');
  assert.deepEqual(loaded.officialSettingsBackup, {
    'official-llm': {
      cordisBlocks: {
        'llm-yaml': 'model: gpt-5\napiKeyEnv: MY_API_KEY\n',
      },
      desktopPreferences: '{"fontSize":14}',
      watchedFiles: {
        'config/models.yaml': 'apiKeyEnv: OTHER_KEY\n',
      },
    },
  });
  assert.deepEqual(loaded.pluginConfigs, {
    'dsh-au': 'server:\n  apiKeyEnv: PLUGIN_KEY\n',
  });

  // 传 null 清空
  const clearedOfficial = saveMachineSettingsBackup({ officialSettingsBackup: null }, 'machine-backup');
  assert.equal(clearedOfficial.ok, true);
  const afterClearOfficial = loadMachineSettingsBackup('machine-backup');
  assert.equal(afterClearOfficial.officialSettingsBackup, undefined);
  assert.deepEqual(afterClearOfficial.pluginConfigs, {
    'dsh-au': 'server:\n  apiKeyEnv: PLUGIN_KEY\n',
  });

  const clearedPlugins = saveMachineSettingsBackup({ pluginConfigs: null }, 'machine-backup');
  assert.equal(clearedPlugins.ok, true);
  const afterClearAll = loadMachineSettingsBackup('machine-backup');
  assert.equal(afterClearAll.pluginConfigs, undefined);

  // 原有字段仍完整保留
  const raw = JSON.parse(readFileSync(fixture.machineFile('machine-backup'), 'utf8'));
  assert.deepEqual(raw.menuFavorites, ['11', '22']);
  assert.deepEqual(raw.plugins, ['dsh-au', 'dsh-market']);
  assert.equal(raw.services.svc.enabled, true);
});
