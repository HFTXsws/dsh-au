import './isolate-sync.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_OFFICIAL_SYNC_ITEM_IDS,
  OFFICIAL_SYNC_ITEMS,
  applySelectedOfficialPatchBlocks,
  buildOfficialSyncItems,
  buildOfficialSyncItemsByProfile,
  buildPreferenceSyncItems,
  computeOfficialSettingsHash,
  normalizeCloudSyncConfig,
  getAllCloudPluginIds,
  pushLocalOfficialSettingsToRepo,
  syncOfficialDesktopPreferences,
  syncOfficialDshAuPreferences,
} from '../lib/official-settings-sync.js';
import {
  readCloudManifest,
  readCloudPlugins,
  readRemovedCloudPlugins,
  removeCloudPlugin,
  upsertCloudPlugin,
} from '../lib/cloud-manifest.js';
import { writePluginBundle } from '../lib/plugin-bundles.js';
import { copyRestoreMock, useTempSyncRepo } from './helpers/temp-sync-repo.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('normalizeCloudSyncConfig：默认关闭自动同步、默认全选 5 项官方设置，自定义勾选后保留合法项', () => {
  const def = normalizeCloudSyncConfig(undefined);
  assert.equal(def.enabled, false);
  assert.equal(def.profile, 'kiro');
  assert.deepEqual(def.selectedItems, [...ALL_OFFICIAL_SYNC_ITEM_IDS]);
  assert.equal(def.customized, false);
  // 本机设置项默认全开，保持旧版「随 dsh-au 插件整体同步」的行为。
  assert.deepEqual(def.selectedPreferences, ['shortcuts', 'modelShortcuts']);

  const custom = normalizeCloudSyncConfig({
    enabled: true,
    profile: 'generic',
    selectedItems: ['ui-theme', 'invalid-id', 'ui-theme', 'desktop-preferences'],
    selectedPreferences: ['shortcuts', 'invalid-pref', 'shortcuts'],
  });
  assert.equal(custom.enabled, true);
  // 旧 generic 方案已下线，保存过的值自动落到「通用」(kiro)。
  assert.equal(custom.profile, 'kiro');
  // ui-theme 已是独立同步项，不再被并入旧的 general-settings。
  assert.deepEqual(custom.selectedItems, ['ui-theme', 'desktop-preferences']);
  assert.deepEqual(custom.selectedPreferences, ['shortcuts']);
  assert.equal(custom.customized, true);
});

test('normalizeCloudSyncConfig：云清单里有 dsh-au 时固定加入同步，即使用户传入空列表', () => {
  const ids = getAllCloudPluginIds();
  const cfg = normalizeCloudSyncConfig({ selectedPlugins: [], syncPluginConfigs: [] });
  const expected = ids.includes('dsh-au') ? ['dsh-au'] : [];
  assert.deepEqual(cfg.selectedPlugins, expected);
  assert.deepEqual(cfg.syncPluginConfigs, expected);
});

test('computeOfficialSettingsHash：仅模型目录变化也会触发自动同步', (t) => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'dsh-model-hash-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const dshDir = path.join(repoRoot, 'app-config', 'dsh');
  const codexDir = path.join(repoRoot, 'app-config', 'codex');
  const cloudDir = path.join(repoRoot, 'dsh-au', 'sync', 'cloud');
  mkdirSync(dshDir, { recursive: true });
  mkdirSync(codexDir, { recursive: true });
  mkdirSync(cloudDir, { recursive: true });
  writeFileSync(path.join(dshDir, 'cordis.patch.generic.yml'), '- id: llm-pi-ai\n');
  writeFileSync(path.join(dshDir, 'desktop-preferences.json'), '{}\n');
  writeFileSync(path.join(cloudDir, 'dsh-au-preferences.json'), '{}\n');
  writeFileSync(path.join(codexDir, 'gateway-presets.json'), '{"catalogs":[]}\n');
  const modelPath = path.join(codexDir, 'gateway-models.json');
  writeFileSync(modelPath, '{"models":[{"slug":"a"}]}\n');

  const before = computeOfficialSettingsHash(repoRoot, 'generic');
  writeFileSync(modelPath, '{"models":[{"slug":"a"},{"slug":"b"}]}\n');
  const after = computeOfficialSettingsHash(repoRoot, 'generic');
  assert.notEqual(after, before);
});

test('applySelectedOfficialPatchBlocks：仅同步已勾选的官方设置块，未勾选块保留本机原值不变', () => {
  const currentPatchText = [
    '- id: ui-theme',
    '  config:',
    '    fontSize: 14',
    '- id: permission',
    '  config:',
    '    defaultPreset: workspace-write',
    '- id: custom-local-plugin',
    '  disabled: false',
    '',
  ].join('\n');

  const renderedProfilePatch = [
    '- id: ui-theme',
    '  config:',
    '    fontSize: 18',
    '    codeFontSize: 15',
    '- id: permission',
    '  config:',
    '    defaultPreset: danger-full-access',
    '- id: dsh-au',
    '  disabled: false',
    '',
  ].join('\n');

  const merged = applySelectedOfficialPatchBlocks({
    currentPatchText,
    renderedProfilePatch,
    selectedItems: ['ui-theme'],
  });

  // 已勾选的 ui-theme 更新为 18，未勾选的 permission 保留本机 workspace-write，且保留本机自定义块
  assert.match(merged, /fontSize: 18/);
  assert.match(merged, /defaultPreset: workspace-write/);
  assert.doesNotMatch(merged, /defaultPreset: danger-full-access/);
  assert.match(merged, /- id: custom-local-plugin/);
  assert.match(merged, /- id: dsh-au\n  disabled: false/);
});

test('dsh-restore.mjs --auto-sync：开关关闭时跳过，开启且自定义勾选时仅还原勾选的设置项', (t) => {
  const { root: syncRepoRoot } = useTempSyncRepo(t, 'dsh-official-restore-');
  copyRestoreMock(syncRepoRoot);
  writeFileSync(path.join(syncRepoRoot, 'app-config', 'dsh', 'cordis.patch.kiro.yml'), [
    '- id: ui-theme',
    '  config:',
    '    fontSize: 18',
    '- id: permission',
    '  config:',
    '    defaultPreset: danger-full-access',
    '',
  ].join('\n'));
  writeFileSync(path.join(syncRepoRoot, 'app-config', 'dsh', 'desktop-preferences.json'), '{}\n');

  const dshHome = mkdtempSync(path.join(tmpdir(), 'dsh-official-sync-'));
  t.after(() => rmSync(dshHome, { recursive: true, force: true }));

  const profileDir = path.join(dshHome, 'profiles', 'desktop');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    path.join(profileDir, 'package.json'),
    JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: ['dsh-au'] } } }, null, 2),
  );
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  const initialPatch = [
    '- id: ui-theme',
    '  config:',
    '    fontSize: 12',
    '- id: permission',
    '  config:',
    '    defaultPreset: workspace-write',
    '',
  ].join('\n');
  writeFileSync(patchPath, initialPatch);

  const manifestPath = path.join(dshHome, 'manifest.cloud.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      updatedAt: '',
      services: {},
      devices: [],
      plugins: { 'dsh-au': { name: 'dsh-au', package: 'dsh-au', source: 'local' } },
    }),
  );

  const restoreScript = path.join(syncRepoRoot, 'scripts', 'dsh-restore.mjs');
  const restoreEnv = {
    ...process.env,
    DSH_HOME: dshHome,
    DSH_AU_CLOUD_MANIFEST_PATH: manifestPath,
    DSH_AU_SYNC_REPO: syncRepoRoot,
    DSH_AU_PLUGIN_ROOT: PLUGIN_ROOT,
  };

  // 1. 未开启自动同步时，--auto-sync 直接跳过不改文件
  const skipped = spawnSync(process.execPath, [restoreScript, '--auto-sync'], {
    encoding: 'utf8',
    env: restoreEnv,
    windowsHide: true,
  });
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.equal(readFileSync(patchPath, 'utf8'), initialPatch);

  // 2. 开启自动同步，且仅勾选 ui-theme 和 desktop-preferences（不勾选 permission-preset）
  const auConfigPath = path.join(dshHome, 'dsh-au.config.json');
  writeFileSync(
    auConfigPath,
    JSON.stringify({
      cloudSync: {
        enabled: true,
        profile: 'kiro',
        selectedItems: ['ui-theme', 'desktop-preferences'],
        customized: true,
      },
    }),
  );

  const synced = spawnSync(process.execPath, [restoreScript, '--auto-sync', '--machine', 'Example-Mac'], {
    encoding: 'utf8',
    env: restoreEnv,
    windowsHide: true,
  });
  assert.equal(synced.status, 0, synced.stderr);

  const afterPatch = readFileSync(patchPath, 'utf8');
  assert.match(afterPatch, /fontSize: 18/);
  assert.match(afterPatch, /defaultPreset: workspace-write/);
  assert.doesNotMatch(afterPatch, /defaultPreset: danger-full-access/);
  assert.equal(existsSync(path.join(dshHome, 'desktop-preferences.json')), true);

  const updatedAuConfig = JSON.parse(readFileSync(auConfigPath, 'utf8'));
  assert.equal(updatedAuConfig.cloudSync.lastSyncedHash, computeOfficialSettingsHash(syncRepoRoot, 'kiro'));
  assert.ok(updatedAuConfig.cloudSync.lastSyncedAt);
});

test('设置页包含云端配置自动同步开关、选择同步项独立弹窗及 4 个 API 动作，主按钮与模型方案选择器样式正确', () => {
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  assert.match(client, /callApi\('getCloudSyncSettings'\)/);
  assert.match(client, /callApi\('saveCloudSyncSettings'/);
  assert.match(client, /路径已更改，请重启 DSH 后生效/);
  assert.match(client, /callApi\('runCloudSyncNow'/);
  assert.match(client, /callApi\('pushCloudSyncToRepo'/);
  assert.match(client, /自定义云端同步设置项/);
  assert.match(client, /选择同步项/);
  assert.doesNotMatch(client, /选择同步项 \(设置/);
  assert.match(client, /dsh-au-cloud-sync-action/);
  assert.match(client, /dsh-au-cloud-sync-status/);
  assert.match(client, /模型方案：/);
  // dsh-au 设置页签分两组：所有电脑共用（固定同步）与每台电脑各存一份（带独立勾选）。
  assert.match(client, /所有电脑共用（固定同步）/);
  assert.match(client, /每台电脑各存一份（互不覆盖）/);
  assert.match(client, /selectedPreferences/);
  assert.match(client, /设备 \/ 页面切换快捷键/);
  assert.match(client, /模型快捷槽位/);
  // 方案 H：官方设置逐项一行，名称对齐 DSH 官方叫法，展开后切换和云端 / 官方默认比。
  assert.match(client, /模型提供商、目录与默认模型/);
  // 方案 G：展开后四列对照。
  assert.match(client, /官方默认/);
  assert.match(client, /is-cloud-diff/);
  assert.match(client, /未分类的官方设置/);
  assert.match(client, /Codex 模型目录/);
  assert.match(client, /同步完整与精简目录，不切换当前模型/);
  assert.match(client, /\.dsh-au-btn-primary\s*\{\s*background:#2563eb !important;/);
  assert.doesNotMatch(client, /\.dsh-au-btn-primary\s*\{[^}]*var\(--dsw-alias-brand-primary/);
  assert.match(client, /展开对比/);
  assert.match(client, /官方默认/);
  assert.match(client, /云端「/);
  assert.match(client, /DSH 官方设置/);
  // 页签拆成三个：官方设置 / dsh-au 设置 / 其它云插件，dsh-au 不再出现在插件勾选列表。
  assert.match(client, /'dsh-au 设置'/);
  assert.match(client, /其它云插件 \(/);
  assert.match(client, /实时同步已开启/);
  assert.match(client, /\.dsh-au-cloud-sync-list\s*\{[^}]*min-height:0;/);
  assert.match(client, /\.dsh-au-cloud-sync-item\s*\{\s*flex-shrink:0;/);
  assert.match(client, /配置快捷键/);
  assert.match(client, /配置快捷模型/);
  assert.match(client, /h\(TodoFeatureGroup\),\s*h\(MobileFeatureGroup\),\s*h\(WindowMemoryFeatureGroup\)/);
  assert.match(client, /h\(FullAccessFeatureGroup\),\s*h\(GoalCreationFeatureGroup\),\s*h\(AutoContinueFeatureGroup\)/);
  assert.match(client, /h\(ShortcutSettingsSection\),\s*h\(ModelShortcutSettingsSection\)/);
  assert.match(client, /id: 'sync'[\s\S]*h\(CloudSyncFeatureGroup\)/);
  // 原 general-settings 拆成 4 个配置块，共 8 个固定同步项。
  assert.equal(OFFICIAL_SYNC_ITEMS.length, 8);
  assert.ok(OFFICIAL_SYNC_ITEMS.every((item) => Array.isArray(item.comparisons) && item.comparisons.length > 0));
});

test('pushLocalOfficialSettingsToRepo：通用设置同步写入全部方案，仅 llm-providers 写入目标方案', (t) => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-push-repo-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));

  const repoDshDir = path.join(tempRoot, 'repo', 'app-config', 'dsh');
  const localProfileDir = path.join(tempRoot, 'dshHome', 'profiles', 'desktop');
  mkdirSync(repoDshDir, { recursive: true });
  mkdirSync(localProfileDir, { recursive: true });

  const baseRepoPatch = (modelName) => [
    '- id: llm-pi-ai',
    '  config:',
    `    model: ${modelName}`,
    '- id: ui-theme',
    '  config:',
    '    fontSize: 14',
    '- id: dsh-au',
    '  disabled: false',
    '',
  ].join('\n');

  writeFileSync(path.join(repoDshDir, 'cordis.patch.kiro.yml'), baseRepoPatch('kiro-old'));
  writeFileSync(path.join(repoDshDir, 'cordis.patch.generic.yml'), baseRepoPatch('generic-old'));
  writeFileSync(
    path.join(localProfileDir, 'cordis.patch.yml'),
    [
      '- id: llm-pi-ai',
      '  config:',
      '    model: kiro-new',
      '- id: ui-theme',
      '  config:',
      '    fontSize: 20',
      '',
    ].join('\n'),
  );

  pushLocalOfficialSettingsToRepo({
    repoRoot: path.join(tempRoot, 'repo'),
    dshHome: path.join(tempRoot, 'dshHome'),
    profile: 'kiro',
    selectedItems: ['ui-theme', 'llm-providers'],
  });

  const kiroAfter = readFileSync(path.join(repoDshDir, 'cordis.patch.kiro.yml'), 'utf8');
  const genericAfter = readFileSync(path.join(repoDshDir, 'cordis.patch.generic.yml'), 'utf8');
  // 通用设置 ui-theme 两个方案都更新为 20
  assert.match(kiroAfter, /fontSize: 20/);
  assert.match(genericAfter, /fontSize: 20/);
  // 模型设置 llm-providers 仅更新选中的 kiro 方案，generic 保持原样
  assert.match(kiroAfter, /model: kiro-new/);
  assert.match(genericAfter, /model: generic-old/);
});

test('勾选 dsh-au 时，pushLocalOfficialSettingsToRepo 与 syncOfficialDshAuPreferences 跨机同步移动端适配与快捷键等自身设置', (t) => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-au-self-prefs-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));

  const repoRoot = path.join(tempRoot, 'repo');
  const dshHomeA = path.join(tempRoot, 'dshHomeA');
  const dshHomeB = path.join(tempRoot, 'dshHomeB');
  mkdirSync(path.join(repoRoot, 'dsh-au', 'sync', 'cloud'), { recursive: true });
  mkdirSync(path.join(dshHomeA, 'profiles', 'desktop'), { recursive: true });
  mkdirSync(path.join(dshHomeB, 'profiles', 'desktop'), { recursive: true });

  // 电脑 A 开启新建目标限制、移动端适配、默认完全权限，并自定义快捷键。
  writeFileSync(
    path.join(dshHomeA, 'dsh-au.config.json'),
    JSON.stringify({
      features: { todo: true, fullAccessByDefault: true, blockGoalCreation: true },
      autoContinue: { enabled: true, retryDelaySec: 75, maxRetries: 6, compactOnDisconnect: true, continueOnTruncate: false, prompt: '接着写' },
      windowState: { enabled: true },
    }),
  );

  const pushed = pushLocalOfficialSettingsToRepo({
    repoRoot,
    dshHome: dshHomeA,
    profile: 'kiro',
    selectedItems: [],
    selectedPlugins: ['dsh-au'],
    clientPreferences: {
      mobileEnabled: true,
      shortcutOverrides: { 'todo.toggle': { code: 'KeyT', ctrl: true, alt: true, shift: false, meta: false } },
    },
  });
  assert.equal(pushed.dshAuPrefsUpdated, true);

  // 电脑 B 拉取仓库后同步 dsh-au 自身设置
  const synced = syncOfficialDshAuPreferences({
    repoRoot,
    dshHome: dshHomeB,
    enabled: true,
  });
  assert.equal(synced.updated, true);

  const cfgB = JSON.parse(readFileSync(path.join(dshHomeB, 'dsh-au.config.json'), 'utf8'));
  assert.equal(cfgB.features.fullAccessByDefault, true);
  assert.equal(cfgB.features.blockGoalCreation, true);
  assert.equal(cfgB.autoContinue.enabled, true);
  assert.equal(cfgB.autoContinue.retryDelaySec, 75);
  assert.equal(cfgB.autoContinue.maxRetries, 6);
  assert.equal(cfgB.autoContinue.compactOnDisconnect, true);
  assert.equal(cfgB.autoContinue.continueOnTruncate, false);
  assert.equal(cfgB.autoContinue.prompt, '接着写');
  assert.equal(cfgB.autoContinue.rules.length, 0);
  assert.equal(cfgB.windowState.enabled, true);
  assert.equal(cfgB.clientPreferences.mobileEnabled, true);
  assert.equal(cfgB.clientPreferences.shortcutOverrides['todo.toggle'].code, 'KeyT');

  // 关闭也必须同步：不能把目的电脑已经开启的限制留在 true。
  const configAPath = path.join(dshHomeA, 'dsh-au.config.json');
  const configA = JSON.parse(readFileSync(configAPath, 'utf8'));
  configA.features.blockGoalCreation = false;
  writeFileSync(configAPath, JSON.stringify(configA));
  pushLocalOfficialSettingsToRepo({ repoRoot, dshHome: dshHomeA, selectedItems: [], selectedPlugins: ['dsh-au'] });
  syncOfficialDshAuPreferences({ repoRoot, dshHome: dshHomeB });
  const disabledB = JSON.parse(readFileSync(path.join(dshHomeB, 'dsh-au.config.json'), 'utf8'));
  assert.equal(disabledB.features.blockGoalCreation, false);
  assert.equal(disabledB.features.fullAccessByDefault, true);
});

test('旧云偏好缺少或损坏新建目标开关时保留本机选择和其他设置', async (t) => {
  for (const value of [undefined, 'false', null]) {
    await t.test(`cloud value: ${String(value)}`, (t) => {
      const root = mkdtempSync(path.join(tmpdir(), 'dsh-au-legacy-goal-pref-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const repoRoot = path.join(root, 'repo');
      const dshHome = path.join(root, 'home');
      const cloudDir = path.join(repoRoot, 'dsh-au', 'sync', 'cloud');
      mkdirSync(cloudDir, { recursive: true });
      mkdirSync(dshHome, { recursive: true });
      writeFileSync(path.join(cloudDir, 'dsh-au-preferences.json'), JSON.stringify({ todo: false, blockGoalCreation: value }));
      const localPath = path.join(dshHome, 'dsh-au.config.json');
      writeFileSync(localPath, JSON.stringify({ features: { blockGoalCreation: true, fullAccessByDefault: true }, unrelated: 'keep' }));

      assert.equal(syncOfficialDshAuPreferences({ repoRoot, dshHome }).updated, true);
      const result = JSON.parse(readFileSync(localPath, 'utf8'));
      assert.deepEqual(result.features, { blockGoalCreation: true, fullAccessByDefault: true, todo: false });
      assert.equal(result.unrelated, 'keep');
    });
  }
});

test('pushLocalOfficialSettingsToRepo：本机卸载云插件后推云清理清单、仓库快照与本机残留配置，不影响其他云插件', (t) => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-push-remove-plugin-'));
  const previousManifest = process.env.DSH_AU_CLOUD_MANIFEST_PATH;
  t.after(() => {
    if (previousManifest === undefined) delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    else process.env.DSH_AU_CLOUD_MANIFEST_PATH = previousManifest;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const repoRoot = path.join(tempRoot, 'repo');
  const dshHome = path.join(tempRoot, 'dshHome');
  const profileDir = path.join(dshHome, 'profiles', 'desktop');
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(profileDir, { recursive: true });

  const stalePlugin = { id: 'stale-plugin', name: 'Stale Plugin', package: '@scope/stale-plugin', source: 'npm', version: '1.0.0' };
  const keepPlugin = { id: 'keep-plugin', name: 'Keep Plugin', package: 'keep-plugin', source: 'npm', version: '1.0.0' };

  const staleBundle = writePluginBundle({
    repoRoot,
    profileDir,
    plugin: stalePlugin,
    configText: '- id: stale-plugin\n  config:\n    mode: old\n',
    patchId: 'stale-plugin',
  });
  const keepBundle = writePluginBundle({
    repoRoot,
    profileDir,
    plugin: keepPlugin,
    configText: '- id: keep-plugin\n  config:\n    mode: slow\n',
    patchId: 'keep-plugin',
  });

  const manifestPath = path.join(tempRoot, 'manifest.cloud.json');
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = manifestPath;
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      updatedAt: '',
      services: {},
      devices: [],
      plugins: {
        [stalePlugin.id]: { name: stalePlugin.name, package: stalePlugin.package, source: 'npm', version: '1.0.0' },
        [keepPlugin.id]: { name: keepPlugin.name, package: keepPlugin.package, source: 'npm', version: '1.0.0' },
      },
    }, null, 2),
  );

  // 本机 package.json 已不包含 stale-plugin，但 cordis.patch.yml 仍残留其配置块
  writeFileSync(
    path.join(profileDir, 'package.json'),
    JSON.stringify({
      dependencies: { [keepPlugin.package]: '1.2.0' },
      dsh: { profile: { bundles: [keepPlugin.package] } },
    }, null, 2),
  );
  const localPatchPath = path.join(profileDir, 'cordis.patch.yml');
  writeFileSync(
    localPatchPath,
    [
      '- id: stale-plugin',
      `  name: "${stalePlugin.package}"`,
      '  config:',
      '    mode: residual',
      '- id: keep-plugin',
      `  name: "${keepPlugin.package}"`,
      '  config:',
      '    mode: fast',
      '',
    ].join('\n'),
  );

  const pushed = pushLocalOfficialSettingsToRepo({
    repoRoot,
    dshHome,
    profile: 'kiro',
    selectedItems: [],
    selectedPlugins: [stalePlugin.id, keepPlugin.id],
    selectedPreferences: [],
  });

  assert.deepEqual(pushed.removedPlugins, [{ id: stalePlugin.id, package: stalePlugin.package }]);
  assert.deepEqual(pushed.updatedPlugins, [keepPlugin.id]);

  const { manifest } = readCloudManifest();
  assert.equal(manifest.plugins[stalePlugin.id], undefined);
  assert.ok(manifest.plugins[keepPlugin.id]);
  assert.equal(manifest.removedPlugins[stalePlugin.id]?.id, stalePlugin.id);
  assert.equal(manifest.removedPlugins[stalePlugin.id]?.package, stalePlugin.package);
  assert.ok(manifest.removedPlugins[stalePlugin.id]?.removedAt);

  assert.equal(existsSync(staleBundle.dir), false);
  assert.equal(existsSync(keepBundle.dir), true);
  assert.match(readFileSync(path.join(keepBundle.dir, 'config.yml'), 'utf8'), /mode: fast/);

  const patchAfter = readFileSync(localPatchPath, 'utf8');
  assert.doesNotMatch(patchAfter, /stale-plugin|residual/);
  assert.match(patchAfter, /keep-plugin/);
  assert.match(patchAfter, /mode: fast/);
});

test('upsertCloudPlugin：重装后重新上架同 id 插件会清除 removedPlugins 中的 tombstone', (t) => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-tombstone-readd-'));
  const previousManifest = process.env.DSH_AU_CLOUD_MANIFEST_PATH;
  t.after(() => {
    if (previousManifest === undefined) delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    else process.env.DSH_AU_CLOUD_MANIFEST_PATH = previousManifest;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const manifestPath = path.join(tempRoot, 'manifest.cloud.json');
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = manifestPath;
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      updatedAt: '',
      services: {},
      devices: [],
      plugins: {
        'demo-plugin': { name: 'Demo', package: 'demo-plugin', source: 'npm', version: '1.0.0' },
      },
    }, null, 2),
  );

  const removed = removeCloudPlugin('demo-plugin');
  assert.equal(removed.removed, true);
  assert.equal(readRemovedCloudPlugins().some((item) => item.id === 'demo-plugin'), true);

  upsertCloudPlugin({ id: 'demo-plugin', name: 'Demo', package: 'demo-plugin', source: 'npm', version: '2.0.0' }, 'demo-plugin');
  assert.equal(readRemovedCloudPlugins().some((item) => item.id === 'demo-plugin'), false);
  const plugins = readCloudPlugins();
  assert.equal(plugins.find((item) => item.id === 'demo-plugin')?.version, '2.0.0');
});

test('pushLocalOfficialSettingsToRepo：dsh-sync 布局写入 cloud/dsh-au-preferences.json', (t) => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-au-prefs-dsh-sync-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  const repoRoot = path.join(tempRoot, 'repo');
  const dshHome = path.join(tempRoot, 'dshHome');
  mkdirSync(path.join(repoRoot, 'dsh-sync', 'cloud'), { recursive: true });
  mkdirSync(dshHome, { recursive: true });
  writeFileSync(path.join(dshHome, 'dsh-au.config.json'), JSON.stringify({
    features: { todo: false, fullAccessByDefault: true, blockGoalCreation: true, disconnectRemotesOnLock: true },
  }));

  const pushed = pushLocalOfficialSettingsToRepo({
    repoRoot,
    dshHome,
    selectedItems: [],
    selectedPlugins: ['dsh-au'],
  });
  assert.equal(pushed.dshAuPrefsUpdated, true);

  const preferred = path.join(repoRoot, 'dsh-sync', 'cloud', 'dsh-au-preferences.json');
  const legacy = path.join(repoRoot, 'dsh-au', 'sync', 'cloud', 'dsh-au-preferences.json');
  assert.equal(existsSync(preferred), true);
  assert.equal(existsSync(legacy), false);
  const payload = JSON.parse(readFileSync(preferred, 'utf8'));
  assert.equal(payload.todo, false);
  assert.equal(payload.fullAccessByDefault, true);
  assert.equal(payload.blockGoalCreation, true);
  assert.equal(Object.hasOwn(payload, 'disconnectRemotesOnLock'), false);
});

test('云偏好里的锁屏断开值不能覆盖这台电脑自己的开关', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-au-lock-remote-pref-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'repo');
  const dshHome = path.join(root, 'home');
  const cloudDir = path.join(repoRoot, 'dsh-au', 'sync', 'cloud');
  mkdirSync(cloudDir, { recursive: true });
  mkdirSync(dshHome, { recursive: true });
  writeFileSync(path.join(cloudDir, 'dsh-au-preferences.json'), JSON.stringify({
    todo: true,
    disconnectRemotesOnLock: false,
  }));
  const localPath = path.join(dshHome, 'dsh-au.config.json');
  writeFileSync(localPath, JSON.stringify({ features: { disconnectRemotesOnLock: true, todo: true } }));

  assert.equal(syncOfficialDshAuPreferences({ repoRoot, dshHome }).updated, true);
  const result = JSON.parse(readFileSync(localPath, 'utf8'));
  assert.equal(result.features.disconnectRemotesOnLock, true);
  assert.equal(result.features.todo, true);
});

test('buildOfficialSyncItems：能准确识别官方设置与桌面偏好的本地/云端差异并忽略家目录路径格式差异', (t) => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-official-diff-'));
  const prevManifest = process.env.DSH_AU_CLOUD_MANIFEST_PATH;
  t.after(() => {
    if (prevManifest === undefined) delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    else process.env.DSH_AU_CLOUD_MANIFEST_PATH = prevManifest;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const repoRoot = path.join(tempRoot, 'repo');
  const dshHome = path.join(tempRoot, 'dshHome');
  const profileDir = path.join(dshHome, 'profiles', 'desktop');
  const repoDshDir = path.join(repoRoot, 'app-config', 'dsh');
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(repoDshDir, { recursive: true });

  const manifestPath = path.join(tempRoot, 'manifest.cloud.json');
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = manifestPath;
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    plugins: {
      'zaimokuza-dsh-acp-adapter': { package: '@zaimokuza/dsh-acp-adapter' },
    },
  }));
  writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    dependencies: { '@zaimokuza/dsh-acp-adapter': '0.1.0' },
    dsh: { profile: { bundles: ['@zaimokuza/dsh-acp-adapter'] } },
  }));

  const cloudPatch = [
    '- id: ui-theme',
    '  config:',
    '    fontSize: 18',
    '- id: subagent-model-selection-settings',
    '  config:',
    '    enabled: true',
    '- id: permission',
    '  config:',
    '    defaultPreset: danger-full-access',
    '- id: llm-pi-ai',
    '  config:',
    '    providers: []',
    '- id: dsh-acp-adapter',
    '  config:',
    '    command: "~~/.dsh/cursor-acp-wrapper.mjs"',
    '- id: agent-default-model',
    '  config:',
    '    provider: acp-cursor',
    '',
  ].join('\n');
  for (const p of ['kiro', 'generic', 'local']) {
    writeFileSync(path.join(repoDshDir, `cordis.patch.${p}.yml`), cloudPatch);
  }
  writeFileSync(path.join(repoDshDir, 'desktop-preferences.json'), JSON.stringify({ closeToTray: true, lanAccess: 'lan' }));

  // 1. 本地与云完全一致（包含不同家目录路径写法）
  const localPatchMatch = cloudPatch
    .replace('"~~/.dsh/cursor-acp-wrapper.mjs"', '"C:\\\\Users\\\\tester\\\\.dsh\\\\cursor-acp-wrapper.mjs"');
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), localPatchMatch);
  writeFileSync(path.join(dshHome, 'desktop-preferences.json'), JSON.stringify({ lanAccess: 'lan', closeToTray: true }));

  const matched = buildOfficialSyncItems({ repoRoot, dshHome, profile: 'kiro' });
  for (const item of matched) {
    assert.equal(item.inSync, true, `${item.id} 应判定与云一致`);
  }

  // 1b. 行内数组仅括号内空格不同（`[ text, image ]` vs `[text, image]`）仍判一致
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), localPatchMatch.replace('providers: []', 'providers: [ ]'));
  const spaced = Object.fromEntries(buildOfficialSyncItems({ repoRoot, dshHome, profile: 'kiro' }).map((i) => [i.id, i]));
  assert.equal(spaced['llm-providers'].inSync, true);
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), localPatchMatch);

  // 2. 本地改了默认模型与桌面偏好：应检出 llm-providers 与 desktop-preferences 不一致
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), localPatchMatch.replace('provider: acp-cursor', 'provider: kiro'));
  writeFileSync(path.join(dshHome, 'desktop-preferences.json'), JSON.stringify({ closeToTray: false, lanAccess: 'lan' }));

  const byProfile = buildOfficialSyncItemsByProfile({ repoRoot, dshHome });
  const kiroItems = Object.fromEntries(byProfile.kiro.map((i) => [i.id, i]));
  assert.equal(kiroItems['ui-theme'].inSync, true);
  assert.equal(kiroItems['llm-providers'].inSync, false);
  assert.deepEqual(kiroItems['llm-providers'].diffDetails, ['agent-default-model']);
  assert.equal(kiroItems['desktop-preferences'].inSync, false);
  assert.deepEqual(kiroItems['desktop-preferences'].diffDetails, ['closeToTray']);
});

test('buildPreferenceSyncItems：能准确检测本机快捷键与模型快捷槽位和云端机器备份的一致性', (t) => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-pref-diff-'));
  const prevCfg = process.env.DSH_AU_CONFIG_PATH;
  const prevShortcuts = process.env.DSH_AU_MODEL_SHORTCUTS_PATH;
  const prevMachine = process.env.DSH_AU_MACHINE_ID;
  t.after(() => {
    if (prevCfg === undefined) delete process.env.DSH_AU_CONFIG_PATH;
    else process.env.DSH_AU_CONFIG_PATH = prevCfg;
    if (prevShortcuts === undefined) delete process.env.DSH_AU_MODEL_SHORTCUTS_PATH;
    else process.env.DSH_AU_MODEL_SHORTCUTS_PATH = prevShortcuts;
    if (prevMachine === undefined) delete process.env.DSH_AU_MACHINE_ID;
    else process.env.DSH_AU_MACHINE_ID = prevMachine;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const dshHome = path.join(tempRoot, 'dshHome');
  mkdirSync(dshHome, { recursive: true });
  const cfgPath = path.join(dshHome, 'dsh-au.config.json');
  const modelShortcutsPath = path.join(dshHome, 'model-shortcuts.json');
  process.env.DSH_AU_CONFIG_PATH = cfgPath;
  process.env.DSH_AU_MODEL_SHORTCUTS_PATH = modelShortcutsPath;
  process.env.DSH_AU_MACHINE_ID = 'test-diff-machine';

  writeFileSync(cfgPath, JSON.stringify({
    clientPreferences: {
      shortcutOverrides: { 'todo.toggle': { code: 'KeyT', ctrl: true, alt: true, shift: false, meta: false } },
    },
  }));
  writeFileSync(modelShortcutsPath, JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    binding: { code: 'KeyM', ctrl: false, alt: true, shift: false, meta: false },
    slots: [{ provider: 'kiro', model: 'kiro-claude-opus-5-5', reasoningEffort: 'high' }, null, null, null, null, null, null, null, null],
  }));

  // 先推送到机器云备份 -> 两项均应与云一致
  const repoRoot = path.join(tempRoot, 'repo');
  mkdirSync(repoRoot, { recursive: true });
  pushLocalOfficialSettingsToRepo({
    repoRoot,
    dshHome,
    selectedItems: [],
    selectedPlugins: [],
    selectedPreferences: ['shortcuts', 'modelShortcuts'],
  });
  const synced = Object.fromEntries(buildPreferenceSyncItems({ dshHome }).map((i) => [i.id, i]));
  assert.equal(synced.shortcuts.inSync, true);
  assert.equal(synced.modelShortcuts.inSync, true);

  // 本地新增第二个模型槽位 -> modelShortcuts 应检出不一致，shortcuts 仍一致
  writeFileSync(modelShortcutsPath, JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    binding: { code: 'KeyM', ctrl: false, alt: true, shift: false, meta: false },
    slots: [
      { provider: 'kiro', model: 'kiro-claude-opus-5-5', reasoningEffort: 'high' },
      { provider: 'gbu', model: 'gpt-5', reasoningEffort: 'medium' },
      null, null, null, null, null, null, null,
    ],
  }));
  const drifted = Object.fromEntries(buildPreferenceSyncItems({ dshHome }).map((i) => [i.id, i]));
  assert.equal(drifted.shortcuts.inSync, true);
  assert.equal(drifted.modelShortcuts.inSync, false);
  assert.match(drifted.modelShortcuts.diffLabel, /不一致/);
});

test('pushLocalOfficialSettingsToRepo：跳过含明文凭据的 patch 块，允许环境变量引用与安全配置同步', (t) => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-push-secret-filter-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));

  const repoRoot = path.join(tempRoot, 'repo');
  const dshHome = path.join(tempRoot, 'dshHome');
  const appCfgDir = path.join(repoRoot, 'app-config', 'dsh');
  const profileDir = path.join(dshHome, 'profiles', 'desktop');
  mkdirSync(appCfgDir, { recursive: true });
  mkdirSync(profileDir, { recursive: true });

  for (const profile of ['kiro', 'generic', 'local']) {
    writeFileSync(
      path.join(appCfgDir, `cordis.patch.${profile}.yml`),
      [
        '- id: ui-theme',
        '  config:',
        '    fontSize: 16',
        '- id: llm-pi-ai',
        '  config:',
        '    providers:',
        '      openai:',
        '        apiKey: ${OPENAI_API_KEY}',
        '',
      ].join('\n'),
      'utf8',
    );
  }

  writeFileSync(
    path.join(profileDir, 'cordis.patch.yml'),
    [
      '- id: ui-theme',
      '  config:',
      '    fontSize: 18',
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      openai:',
      '        apiKey: sk-plaintext-secret-12345',
      '- id: dsh-acp-adapter',
      '  config:',
      '    apiKey: ${DEFAULT_MODEL_KEY}',
      '    maxTokens: 4096',
      '',
    ].join('\n'),
    'utf8',
  );

  const pushed = pushLocalOfficialSettingsToRepo({
    repoRoot,
    dshHome,
    profile: 'kiro',
    selectedItems: ['general-settings', 'llm-providers'],
    selectedPlugins: [],
    selectedPreferences: [],
  });

  assert.ok(pushed.updatedPatchIds.includes('ui-theme'));
  assert.ok(pushed.updatedPatchIds.includes('dsh-acp-adapter'));
  assert.ok(pushed.skippedCredentialPatchIds.includes('llm-pi-ai'));

  const kiroPatch = readFileSync(path.join(appCfgDir, 'cordis.patch.kiro.yml'), 'utf8');
  assert.match(kiroPatch, /fontSize: 18/);
  assert.match(kiroPatch, /apiKey: \$\{DEFAULT_MODEL_KEY\}/);
  assert.doesNotMatch(kiroPatch, /sk-plaintext-secret-12345/);
  assert.match(kiroPatch, /apiKey: \$\{OPENAI_API_KEY\}/);
});

test('新电脑首次同步时模型槽位保持空白，不借用其他设备的模型配置', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-au-model-no-borrow-'));
  const keys = ['DSH_AU_MACHINES_DIR', 'DSH_AU_MODEL_SHORTCUTS_PATH', 'DSH_AU_CONFIG_PATH'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const machinesDir = path.join(dir, 'machines');
  const modelShortcutsPath = path.join(dir, 'home', 'model-shortcuts.json');
  process.env.DSH_AU_MACHINES_DIR = machinesDir;
  process.env.DSH_AU_MODEL_SHORTCUTS_PATH = modelShortcutsPath;
  process.env.DSH_AU_CONFIG_PATH = path.join(dir, 'home', 'dsh-au.config.json');
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });
  // 另一台电脑的备份里配置了模型槽位。
  mkdirSync(machinesDir, { recursive: true });
  writeFileSync(path.join(machinesDir, 'other-machine.json'), JSON.stringify({
    updatedAt: new Date().toISOString(),
    modelShortcuts: { enabled: true, binding: null, slots: [{ provider: 'azure-full', model: 'borrowed' }] },
  }));

  const result = syncOfficialDshAuPreferences({ repoRoot: dir, dshHome: path.join(dir, 'home'), preferences: ['modelShortcuts'] });
  assert.equal(result.preferenceMigration?.modelShortcutsFrom, undefined);
  assert.equal(existsSync(modelShortcutsPath), false, '本机不应写入借来的模型槽位');
});
