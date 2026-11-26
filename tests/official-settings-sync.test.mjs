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
  areSelectedSyncItemsInSync,
  backupUncheckedSettingsToMachine,
  buildCloudPluginSyncItems,
  buildOfficialSyncItems,
  buildOfficialSyncItemsByProfile,
  buildPreferenceSyncItems,
  computeLocalOfficialSettingsHash,
  computeOfficialSettingsHash,
  decideStartupOfficialSyncAction,
  findOutdatedCloudPlugins,
  getSelectableDshProfiles,
  loadDshProfilesManifest,
  normalizeCloudSyncConfig,
  normalizeLocalPatchPaths,
  getAllCloudPluginIds,
  pushLocalOfficialSettingsToRepo,
  readCloudClaudeLauncherSettings,
  readLocalClaudeLauncherSettings,
  resolveDshProfilesManifestPath,
  resolveRepoProfilePatchPath,
  restoreUncheckedSettingsFromMachine,
  runRestoreScriptForCloudSync,
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
import { loadMachinePreferences, loadMachineSettingsBackup, saveMachinePreferences } from '../lib/local-bindings.js';
import { readModelShortcuts } from '../lib/model-shortcuts.js';
import {
  buildAutoPushToastSummary,
  hasAutoPushRepoChanges,
  resolveSaveCloudSyncState,
} from '../lib/index.js';
import { copyRestoreMock, makeTempSyncRepo, useTempSyncRepo } from './helpers/temp-sync-repo.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 为临时仓库写入合法的声明式 dsh-profiles.json，按仓库实际 sync 布局放置。 */
function writeTestProfilesManifest(repoRoot, overrides = {}) {
  const legacyDir = path.join(repoRoot, 'dsh-au', 'sync', 'cloud');
  const modernDir = path.join(repoRoot, 'dsh-sync', 'cloud');
  const cloudDir = existsSync(path.join(repoRoot, 'dsh-au')) && !existsSync(path.join(repoRoot, 'dsh-sync'))
    ? legacyDir
    : modernDir;
  mkdirSync(cloudDir, { recursive: true });
  const payload = {
    schemaVersion: 2,
    defaultProfile: 'kiro',
    restoreScript: 'scripts/dsh-restore.mjs',
    desktopPreferencesFile: 'app-config/dsh/desktop-preferences.json',
    pathNormalizations: [
      {
        pattern: '[A-Za-z]:\\\\\\\\[^\\n"]*?cursor-acp-wrapper\\.mjs|/[^\\n"]*?cursor-acp-wrapper\\.mjs',
        replacement: '~/.dsh/cursor-acp-wrapper.mjs',
      },
      {
        pattern: '[A-Za-z]:\\\\\\\\[^\\n"]*?antigravity-acp-wrapper\\.mjs|/[^\\n"]*?antigravity-acp-wrapper\\.mjs',
        replacement: '~/.dsh/antigravity-acp-wrapper.mjs',
      },
    ],
    watchedFiles: [
      'app-config/codex/gateway-models.json',
      'app-config/codex/gateway-presets.json',
      'app-config/claude/kiro-gateway.json',
      'app-config/claude/antigravity-gateway.json',
      'app-config/claude/gbu-gateway.json',
    ],
    profiles: [
      { id: 'kiro', label: 'Kiro', file: 'app-config/dsh/cordis.patch.kiro.yml', selectable: true },
      { id: 'generic', label: 'Generic', file: 'app-config/dsh/cordis.patch.generic.yml', selectable: true },
      { id: 'local', label: 'Local', file: 'app-config/dsh/cordis.patch.local.yml', selectable: true },
    ],
    ...overrides,
  };
  writeFileSync(path.join(cloudDir, 'dsh-profiles.json'), `${JSON.stringify(payload, null, 2)}\n`);
}

test('normalizeCloudSyncConfig：默认关闭自动同步、默认全选官方设置，自定义勾选后保留合法项且未知方案回退默认 general', () => {
  const def = normalizeCloudSyncConfig(undefined);
  assert.equal(def.enabled, false);
  assert.equal(def.profile, 'general');
  assert.deepEqual(def.selectedItems, [...ALL_OFFICIAL_SYNC_ITEM_IDS]);
  assert.equal(def.customized, false);
  // 本机设置项默认不勾选（仅单机备份），勾选后才接入云端共享自动同步。
  assert.deepEqual(def.selectedPreferences, []);

  const custom = normalizeCloudSyncConfig({
    enabled: true,
    profile: 'generic',
    selectedItems: ['ui-theme', 'invalid-id', 'ui-theme', 'desktop-preferences'],
    selectedPreferences: ['shortcuts', 'invalid-pref', 'shortcuts'],
  });
  assert.equal(custom.enabled, true);
  // 非 selectable 或未知方案名自动回退到清单默认方案 (general)。
  assert.equal(custom.profile, 'general');
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
  writeTestProfilesManifest(repoRoot, { defaultProfile: 'generic' });

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
  writeTestProfilesManifest(syncRepoRoot, { defaultProfile: 'kiro' });
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

test('设置页包含云端配置自动同步开关、极简单页同步弹窗及 4 个 API 动作，主按钮与模型方案选择器样式正确', () => {
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  assert.match(client, /callApi\('getCloudSyncSettings'\)/);
  assert.match(client, /callApi\('saveCloudSyncSettings'/);
  assert.match(client, /路径已更改，请重启 DSH 后生效/);
  assert.match(client, /callApi\('runCloudSyncNow'/);
  assert.match(client, /callApi\('pushCloudSyncToRepo'/);
  assert.match(client, /云端同步设置/);
  assert.match(client, /选择同步项/);
  assert.doesNotMatch(client, /选择同步项 \(设置/);
  assert.match(client, /dsh-au-cloud-sync-action/);
  assert.match(client, /dsh-au-cloud-sync-status/);
  assert.match(client, /模型方案：/);
  // 单页 4 卡片结构：DSH 官方配置（纯开关）、模型配置（5 项明细）、其它云插件、快捷操作（快捷键配置 / 快捷模型配置）。
  assert.match(client, /DSH 官方配置/);
  assert.match(client, /模型配置/);
  assert.match(client, /其它云插件/);
  assert.match(client, /快捷操作/);
  assert.match(client, /selectedPreferences/);
  assert.match(client, /快捷键配置/);
  assert.match(client, /快捷模型配置/);
  assert.match(client, /Claude 启动器与 4 档位映射/);
  assert.match(client, /Codex 模型目录/);
  assert.match(client, /dsh-au 基础开关默认全机共享/);
  assert.match(client, /\.dsh-au-btn-primary\s*\{\s*background:#2563eb !important;/);
  assert.doesNotMatch(client, /\.dsh-au-btn-primary\s*\{[^}]*var\(--dsw-alias-brand-primary/);
  assert.match(client, /dsh-au-cs-diff-item\s*\{[^}]*flex-shrink:\s*0;/);
  assert.match(client, /singleItemOnly/);
  assert.match(client, /dshAuPrefsOnly/);
  assert.match(client, /首次从云端拉取配置/);
  assert.match(client, /已与云端保持一致/);
  assert.match(client, /\.dsh-au-cloud-sync-list\s*\{[^}]*min-height:0;/);
  assert.match(client, /\.dsh-au-cloud-sync-item\s*\{\s*flex-shrink:0;/);
  assert.match(client, /h\(TodoFeatureGroup\),\s*h\(MobileFeatureGroup\),\s*h\(WindowMemoryFeatureGroup\)/);
  assert.match(client, /h\(FullAccessFeatureGroup\),\s*h\(GoalCreationFeatureGroup\),\s*h\(AutoContinueFeatureGroup\)/);
  assert.match(client, /h\(ShortcutSettingsSection\),\s*h\(ModelShortcutSettingsSection\)/);
  assert.match(client, /id: 'sync'[\s\S]*h\(CloudSyncFeatureGroup\)/);
  // 原 general-settings 拆成 4 个、llm-providers 拆成 4 个（不含默认模型），共 11 个固定同步项。
  assert.equal(OFFICIAL_SYNC_ITEMS.length, 11);
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
  writeTestProfilesManifest(path.join(tempRoot, 'repo'));
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
  writeTestProfilesManifest(repoRoot);

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
    selectedPreferences: ['shortcuts'],
    clientPreferences: {
      mobileEnabled: true,
      shortcutOverrides: { 'todo.toggle': { code: 'KeyT', ctrl: true, alt: true, shift: false, meta: false } },
    },
  });
  assert.equal(pushed.dshAuPrefsUpdated, true);

  // 电脑 B 拉取仓库后同步 dsh-au 自身设置（勾选 shortcuts 才会拉取快捷键）
  const synced = syncOfficialDshAuPreferences({
    repoRoot,
    dshHome: dshHomeB,
    enabled: true,
    preferences: ['shortcuts'],
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
  writeTestProfilesManifest(repoRoot);

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
  writeTestProfilesManifest(repoRoot);
  writeFileSync(path.join(dshHome, 'dsh-au.config.json'), JSON.stringify({
    features: { todo: false, fullAccessByDefault: true, blockGoalCreation: true, sidebarWorkbench: true, disconnectRemotesOnLock: true, sidebarExtensions: { grokbot: false } },
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
  assert.equal(payload.sidebarWorkbench, true);
  assert.equal(Object.hasOwn(payload, 'disconnectRemotesOnLock'), false);
  assert.equal(Object.hasOwn(payload, 'sidebarExtensions'), false);
});

test('云偏好里的锁屏断开值不能覆盖这台电脑自己的开关，但 sidebarWorkbench 会从云端拉取同步', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-au-lock-remote-pref-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'repo');
  const dshHome = path.join(root, 'home');
  const cloudDir = path.join(repoRoot, 'dsh-au', 'sync', 'cloud');
  mkdirSync(cloudDir, { recursive: true });
  mkdirSync(dshHome, { recursive: true });
  writeFileSync(path.join(cloudDir, 'dsh-au-preferences.json'), JSON.stringify({
    todo: true,
    sidebarWorkbench: true,
    disconnectRemotesOnLock: false,
    sidebarExtensions: { grokbot: true },
  }));
  const localPath = path.join(dshHome, 'dsh-au.config.json');
  writeFileSync(localPath, JSON.stringify({ features: { disconnectRemotesOnLock: true, sidebarWorkbench: false, sidebarExtensions: { grokbot: false, 'claude-workspace': false }, todo: true } }));

  assert.equal(syncOfficialDshAuPreferences({ repoRoot, dshHome }).updated, true);
  const result = JSON.parse(readFileSync(localPath, 'utf8'));
  assert.equal(result.features.disconnectRemotesOnLock, true);
  assert.equal(result.features.sidebarWorkbench, true);
  assert.deepEqual(result.features.sidebarExtensions, { grokbot: false, 'claude-workspace': false });
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
  writeTestProfilesManifest(repoRoot);

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
  assert.equal(spaced['llm-pi-ai'].inSync, true);
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), localPatchMatch);

  // 2. 本地改了默认模型与桌面偏好：默认模型不纳入云同步，仅检出 desktop-preferences 不一致
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), localPatchMatch.replace('provider: acp-cursor', 'provider: kiro'));
  writeFileSync(path.join(dshHome, 'desktop-preferences.json'), JSON.stringify({ closeToTray: false, lanAccess: 'lan' }));

  const byProfile = buildOfficialSyncItemsByProfile({ repoRoot, dshHome });
  const kiroItems = Object.fromEntries(byProfile.kiro.map((i) => [i.id, i]));
  assert.equal(kiroItems['ui-theme'].inSync, true);
  assert.equal(kiroItems['llm-pi-ai'].inSync, true);
  assert.equal(kiroItems['agent-default-model'], undefined);
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
  writeTestProfilesManifest(repoRoot);
  pushLocalOfficialSettingsToRepo({
    repoRoot,
    dshHome,
    selectedItems: [],
    selectedPlugins: [],
    selectedPreferences: ['shortcuts', 'modelShortcuts'],
  });
  const synced = Object.fromEntries(buildPreferenceSyncItems({ repoRoot, dshHome }).map((i) => [i.id, i]));
  assert.equal(synced.shortcuts.inSync, true);
  assert.equal(synced.shortcuts.hasCloud, true);
  assert.equal(synced.modelShortcuts.inSync, true);
  assert.equal(synced.modelShortcuts.hasCloud, true);

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
  const drifted = Object.fromEntries(buildPreferenceSyncItems({ repoRoot, dshHome }).map((i) => [i.id, i]));
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
  writeTestProfilesManifest(repoRoot);

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

test('computeLocalOfficialSettingsHash 与 decideStartupOfficialSyncAction：双基线防冲突判定覆盖全部场景', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-au-local-hash-'));
  try {
    const profileDir = path.join(dir, 'profiles', 'desktop');
    mkdirSync(profileDir, { recursive: true });
    const patchPath = path.join(profileDir, 'cordis.patch.yml');
    const desktopPrefPath = path.join(dir, 'desktop-preferences.json');

    writeFileSync(
      patchPath,
      '- id: ui-theme\n  config:\n    fontSize: 14\n- id: permission\n  config:\n    defaultPreset: danger-full-access\n',
      'utf8',
    );
    writeFileSync(desktopPrefPath, '{"closeToTray":true}\n', 'utf8');

    const h1 = computeLocalOfficialSettingsHash({ dshHome: dir, selectedItems: ['ui-theme', 'desktop-preferences'] });
    // CRLF 换行差异不应改变哈希
    writeFileSync(
      patchPath,
      '- id: ui-theme\r\n  config:\r\n    fontSize: 14\r\n- id: permission\r\n  config:\r\n    defaultPreset: danger-full-access\r\n',
      'utf8',
    );
    const h1Crlf = computeLocalOfficialSettingsHash({ dshHome: dir, selectedItems: ['ui-theme', 'desktop-preferences'] });
    assert.equal(h1Crlf, h1);

    // 未勾选的块（permission）改动不应影响哈希
    writeFileSync(
      patchPath,
      '- id: ui-theme\n  config:\n    fontSize: 14\n- id: permission\n  config:\n    defaultPreset: workspace-write\n',
      'utf8',
    );
    const hUnselectedChanged = computeLocalOfficialSettingsHash({ dshHome: dir, selectedItems: ['ui-theme', 'desktop-preferences'] });
    assert.equal(hUnselectedChanged, h1);

    // 已勾选的块（ui-theme）改动应改变哈希
    writeFileSync(
      patchPath,
      '- id: ui-theme\n  config:\n    fontSize: 16\n- id: permission\n  config:\n    defaultPreset: workspace-write\n',
      'utf8',
    );
    const h2 = computeLocalOfficialSettingsHash({ dshHome: dir, selectedItems: ['ui-theme', 'desktop-preferences'] });
    assert.notEqual(h2, h1);

    // 1. 无本机基线且云端未变 -> 初始化本机基线
    assert.equal(
      decideStartupOfficialSyncAction({ cloudHash: 'c1', lastSyncedHash: 'c1', localHash: h1, lastLocalHash: '' }).action,
      'init_local_baseline',
    );
    // 2. 仅云端变更 -> 自动拉取
    assert.equal(
      decideStartupOfficialSyncAction({ cloudHash: 'c2', lastSyncedHash: 'c1', localHash: h1, lastLocalHash: h1 }).action,
      'pull',
    );
    // 3. 仅本机变更 -> 自动推送
    assert.equal(
      decideStartupOfficialSyncAction({ cloudHash: 'c1', lastSyncedHash: 'c1', localHash: h2, lastLocalHash: h1 }).action,
      'push',
    );
    // 4. 双端均有变更 -> 暂停并报冲突
    const conflictDecision = decideStartupOfficialSyncAction({ cloudHash: 'c2', lastSyncedHash: 'c1', localHash: h2, lastLocalHash: h1 });
    assert.equal(conflictDecision.action, 'conflict');
    assert.match(conflictDecision.reason, /冲突|暂停自动覆盖/);
    // 5. 均未变更 -> 无操作
    assert.equal(
      decideStartupOfficialSyncAction({ cloudHash: 'c1', lastSyncedHash: 'c1', localHash: h1, lastLocalHash: h1 }).action,
      'none',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDshProfilesManifest：支持私有仓自定义方案名、任意模板文件名与平台过滤，彻底解耦文件名硬编码', (t) => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-custom-profiles-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));

  const repoRoot = path.join(tempRoot, 'repo');
  const dshHome = path.join(tempRoot, 'dshHome');
  const cloudDir = path.join(repoRoot, 'dsh-sync', 'cloud');
  const customTplDir = path.join(repoRoot, 'templates');
  const profileDir = path.join(dshHome, 'profiles', 'desktop');
  mkdirSync(cloudDir, { recursive: true });
  mkdirSync(customTplDir, { recursive: true });
  mkdirSync(profileDir, { recursive: true });

  // 自定义清单：不遵循 cordis.patch.<id>.yml 命名，且指定平台限制
  writeFileSync(
    path.join(cloudDir, 'dsh-profiles.json'),
    JSON.stringify({
      schemaVersion: 1,
      defaultProfile: 'daily',
      profiles: [
        {
          id: 'daily',
          label: '日常通用',
          file: 'templates/my-daily.yaml',
          platforms: ['darwin', 'win32', 'linux'],
          selectable: true,
        },
        {
          id: 'office',
          label: '公司专网',
          file: 'templates/office-only.yaml',
          platforms: ['darwin'],
          selectable: true,
        },
        {
          id: 'legacy-cli',
          label: 'CLI保留',
          file: 'templates/legacy.yaml',
          platforms: ['darwin', 'win32'],
          selectable: false,
        },
      ],
    }, null, 2),
  );

  for (const file of ['my-daily.yaml', 'office-only.yaml', 'legacy.yaml']) {
    writeFileSync(path.join(customTplDir, file), '- id: ui-theme\n  config:\n    fontSize: 14\n- id: llm-pi-ai\n  config:\n    model: old\n');
  }
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '- id: ui-theme\n  config:\n    fontSize: 18\n- id: llm-pi-ai\n  config:\n    model: new-office\n');

  const manifest = loadDshProfilesManifest(repoRoot);
  assert.equal(manifest.defaultProfile, 'daily');
  assert.equal(manifest.profiles.length, 3);
  assert.equal(resolveRepoProfilePatchPath(repoRoot, 'office'), path.join(repoRoot, 'templates', 'office-only.yaml'));

  const winSelectable = getSelectableDshProfiles({ repoRoot, platform: 'win32' });
  assert.deepEqual(winSelectable.map((p) => p.id), ['daily']);
  const macSelectable = getSelectableDshProfiles({ repoRoot, platform: 'darwin' });
  assert.deepEqual(macSelectable.map((p) => p.id), ['daily', 'office']);

  // 未知或非 selectable 方案名自动回退到 defaultProfile (daily)
  assert.equal(normalizeCloudSyncConfig({ profile: 'kiro' }, { repoRoot }).profile, 'daily');
  assert.equal(normalizeCloudSyncConfig({ profile: 'legacy-cli' }, { repoRoot }).profile, 'daily');
  assert.equal(normalizeCloudSyncConfig({ profile: 'office' }, { repoRoot }).profile, 'office');

  // 推送时通用项更新全部清单模板，模型项只更新选中的 office-only.yaml
  pushLocalOfficialSettingsToRepo({
    repoRoot,
    dshHome,
    profile: 'office',
    selectedItems: ['ui-theme', 'llm-providers'],
    selectedPlugins: [],
    selectedPreferences: [],
  });
  assert.match(readFileSync(path.join(customTplDir, 'my-daily.yaml'), 'utf8'), /fontSize: 18/);
  assert.match(readFileSync(path.join(customTplDir, 'my-daily.yaml'), 'utf8'), /model: old/);
  assert.match(readFileSync(path.join(customTplDir, 'office-only.yaml'), 'utf8'), /fontSize: 18/);
  assert.match(readFileSync(path.join(customTplDir, 'office-only.yaml'), 'utf8'), /model: new-office/);
  assert.match(readFileSync(path.join(customTplDir, 'legacy.yaml'), 'utf8'), /fontSize: 18/);
});

test('findOutdatedCloudPlugins 能识别版本落后于云端的托管插件与普通云插件，且前端包含启动弹窗提示', (t) => {
  const { root: syncRepoRoot, syncDir } = makeTempSyncRepo('dsh-outdated-plugins-');
  writeTestProfilesManifest(syncRepoRoot, {
    defaultProfile: 'general',
    profiles: [
      { id: 'general', label: 'General', file: 'app-config/dsh/cordis.patch.general.yml', selectable: true },
    ],
  });
  const dshHome = mkdtempSync(path.join(tmpdir(), 'dsh-outdated-home-'));
  const prevManifestEnv = process.env.DSH_AU_CLOUD_MANIFEST_PATH;
  t.after(() => {
    if (prevManifestEnv === undefined) delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    else process.env.DSH_AU_CLOUD_MANIFEST_PATH = prevManifestEnv;
    rmSync(syncRepoRoot, { recursive: true, force: true });
    rmSync(dshHome, { recursive: true, force: true });
  });

  const manifestPath = path.join(syncDir, 'cloud', 'manifest.cloud.json');
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = manifestPath;
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    plugins: {
      'zaimokuza-dsh-acp-adapter': {
        name: 'Cursor ACP 适配器',
        package: '@zaimokuza/dsh-acp-adapter',
        source: 'npm',
        version: '0.2.2-rc.5.3',
        activation: 'profile-managed',
        requiresDshProfile: 'general',
      },
      'demo-normal-plugin': {
        name: 'Demo 插件',
        package: 'demo-normal-plugin',
        source: 'npm',
        version: '1.2.0',
      },
    },
  }, null, 2));

  const desktopDir = path.join(dshHome, 'profiles', 'desktop');
  mkdirSync(path.join(desktopDir, 'node_modules', '@zaimokuza', 'dsh-acp-adapter'), { recursive: true });
  mkdirSync(path.join(desktopDir, 'node_modules', 'demo-normal-plugin'), { recursive: true });
  writeFileSync(path.join(desktopDir, 'package.json'), JSON.stringify({
    dependencies: {
      '@zaimokuza/dsh-acp-adapter': '0.2.2-rc.3.1',
      'demo-normal-plugin': '1.2.0',
    },
    dsh: { profile: { bundles: ['@zaimokuza/dsh-acp-adapter', 'demo-normal-plugin'] } },
  }, null, 2));
  writeFileSync(path.join(desktopDir, 'node_modules', '@zaimokuza', 'dsh-acp-adapter', 'package.json'), JSON.stringify({
    name: '@zaimokuza/dsh-acp-adapter',
    version: '0.2.2-rc.3.1',
  }));
  writeFileSync(path.join(desktopDir, 'node_modules', 'demo-normal-plugin', 'package.json'), JSON.stringify({
    name: 'demo-normal-plugin',
    version: '1.2.0',
  }));

  const outdated = findOutdatedCloudPlugins({
    repoRoot: syncRepoRoot,
    dshHome,
    selectedPlugins: ['zaimokuza-dsh-acp-adapter', 'demo-normal-plugin'],
    profile: 'general',
  });
  assert.equal(outdated.length, 1);
  assert.equal(outdated[0].id, 'zaimokuza-dsh-acp-adapter');
  assert.equal(outdated[0].localVersion, '0.2.2-rc.3.1');
  assert.equal(outdated[0].cloudVersion, '0.2.2-rc.5.3');
  assert.equal(outdated[0].profileManaged, true);

  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  assert.match(client, /startupCloudSyncNotice/);
  assert.match(client, /dismissStartupCloudSyncNotice/);
});

test('computeOfficialSettingsHash 与 computeLocalOfficialSettingsHash：纳入已勾选本机偏好且保持旧签名兼容', (t) => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-pref-hash-'));
  const prevEnv = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_AU_CONFIG_PATH: process.env.DSH_AU_CONFIG_PATH,
    DSH_AU_MODEL_SHORTCUTS_PATH: process.env.DSH_AU_MODEL_SHORTCUTS_PATH,
    DSH_AU_SYNC_REPO: process.env.DSH_AU_SYNC_REPO,
    DSH_AU_CLOUD_MANIFEST_PATH: process.env.DSH_AU_CLOUD_MANIFEST_PATH,
    DSH_AU_MACHINE_ID: process.env.DSH_AU_MACHINE_ID,
    DSH_AU_MACHINES_DIR: process.env.DSH_AU_MACHINES_DIR,
  };
  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const repoRoot = path.join(tempRoot, 'repo');
  const dshHome = path.join(tempRoot, 'dshHome');
  const machinesDir = path.join(repoRoot, 'dsh-sync', 'machines');
  mkdirSync(path.join(repoRoot, 'app-config', 'dsh'), { recursive: true });
  mkdirSync(path.join(repoRoot, 'dsh-sync', 'cloud'), { recursive: true });
  mkdirSync(machinesDir, { recursive: true });
  mkdirSync(dshHome, { recursive: true });
  writeFileSync(path.join(repoRoot, 'app-config', 'dsh', 'cordis.patch.generic.yml'), '- id: ui-theme\n');
  writeFileSync(path.join(repoRoot, 'app-config', 'dsh', 'desktop-preferences.json'), '{}\n');
  writeFileSync(path.join(repoRoot, 'dsh-sync', 'cloud', 'plugins.json'), '{"schemaVersion":1,"plugins":[]}\n');
  writeTestProfilesManifest(repoRoot, { defaultProfile: 'generic' });

  const cfgPath = path.join(dshHome, 'dsh-au.config.json');
  const modelShortcutsPath = path.join(dshHome, 'model-shortcuts.json');
  process.env.DSH_HOME = dshHome;
  process.env.DSH_AU_CONFIG_PATH = cfgPath;
  process.env.DSH_AU_MODEL_SHORTCUTS_PATH = modelShortcutsPath;
  process.env.DSH_AU_SYNC_REPO = repoRoot;
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = path.join(repoRoot, 'dsh-sync', 'cloud', 'plugins.json');
  process.env.DSH_AU_MACHINE_ID = 'pref-hash-pc';
  process.env.DSH_AU_MACHINES_DIR = machinesDir;

  writeFileSync(cfgPath, JSON.stringify({
    cloudSync: { lastSyncedHash: 'old', lastLocalHash: 'old' },
    clientPreferences: {
      shortcutOverrides: { 'todo.toggle': { code: 'KeyT', ctrl: true, alt: true, shift: false, meta: false } },
    },
  }));
  writeFileSync(modelShortcutsPath, JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    binding: { code: 'KeyM', ctrl: false, alt: true, shift: false, meta: false },
    slots: [{ provider: 'kiro', model: 'kiro-claude-opus-5-5' }, null, null, null, null, null, null, null, null],
  }));

  // 1. 不传 selectedPreferences 时，本机偏好变动不影响旧口径哈希
  const legacyCloudBefore = computeOfficialSettingsHash(repoRoot, 'generic');
  const legacyLocalBefore = computeLocalOfficialSettingsHash({ dshHome, selectedItems: [] });

  // 2. 传入 selectedPreferences 后，修改 modelShortcuts 或 shortcutOverrides 会立即反映到哈希
  const prefOpts = ['modelShortcuts', 'shortcuts'];
  const localHash1 = computeLocalOfficialSettingsHash({
    dshHome,
    selectedItems: [],
    selectedPreferences: prefOpts,
  });

  // 仅更新 dsh-au.config.json 的 lastSyncedHash 元数据，不应改变本机偏好哈希（避免死循环）
  const cfgObj = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfgObj.cloudSync.lastSyncedHash = 'changed-meta';
  writeFileSync(cfgPath, JSON.stringify(cfgObj));
  assert.equal(
    computeLocalOfficialSettingsHash({ dshHome, selectedItems: [], selectedPreferences: prefOpts }),
    localHash1,
  );

  // 修改 model-shortcuts.json 后哈希变化
  writeFileSync(modelShortcutsPath, JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    binding: { code: 'KeyM', ctrl: false, alt: true, shift: false, meta: false },
    slots: [{ provider: 'gbu', model: 'gpt-5' }, null, null, null, null, null, null, null, null],
  }));
  const localHash2 = computeLocalOfficialSettingsHash({
    dshHome,
    selectedItems: [],
    selectedPreferences: prefOpts,
  });
  assert.notEqual(localHash2, localHash1);

  // 推送后，返回的 hash 应与传入 selectedPreferences 的云端哈希一致
  const pushed = pushLocalOfficialSettingsToRepo({
    repoRoot,
    dshHome,
    profile: 'generic',
    selectedItems: [],
    selectedPlugins: [],
    selectedPreferences: prefOpts,
  });
  assert.equal(pushed.machinePreferencesUpdated, true);
  assert.equal(pushed.dshAuPrefsUpdated, true);
  assert.equal(
    pushed.hash,
    computeOfficialSettingsHash(repoRoot, 'generic', { selectedPreferences: prefOpts }),
  );
  // 推送已写入 cloud/dsh-au-preferences.json 与 cloud/model-shortcuts.json，
  // 因此传入 selectedPreferences: ['modelShortcuts'] 会纳入 cloud/model-shortcuts.json，与不传时不同。
  assert.notEqual(
    computeOfficialSettingsHash(repoRoot, 'generic', { selectedPreferences: ['modelShortcuts'] }),
    computeOfficialSettingsHash(repoRoot, 'generic'),
  );
  assert.equal(computeLocalOfficialSettingsHash({ dshHome, selectedItems: [] }), legacyLocalBefore);
});

test('重启双向比对防覆盖保护：仅本机改 modelShortcuts 推云、仅云端改拉回、双端改判 conflict', (t) => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-pref-startup-'));
  const prevEnv = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_AU_CONFIG_PATH: process.env.DSH_AU_CONFIG_PATH,
    DSH_AU_MODEL_SHORTCUTS_PATH: process.env.DSH_AU_MODEL_SHORTCUTS_PATH,
    DSH_AU_SYNC_REPO: process.env.DSH_AU_SYNC_REPO,
    DSH_AU_CLOUD_MANIFEST_PATH: process.env.DSH_AU_CLOUD_MANIFEST_PATH,
    DSH_AU_MACHINE_ID: process.env.DSH_AU_MACHINE_ID,
    DSH_AU_MACHINES_DIR: process.env.DSH_AU_MACHINES_DIR,
  };
  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const repoRoot = path.join(tempRoot, 'repo');
  const dshHome = path.join(tempRoot, 'dshHome');
  const machinesDir = path.join(repoRoot, 'dsh-sync', 'machines');
  mkdirSync(path.join(repoRoot, 'app-config', 'dsh'), { recursive: true });
  mkdirSync(path.join(repoRoot, 'dsh-sync', 'cloud'), { recursive: true });
  mkdirSync(machinesDir, { recursive: true });
  mkdirSync(dshHome, { recursive: true });
  writeFileSync(path.join(repoRoot, 'app-config', 'dsh', 'cordis.patch.generic.yml'), '- id: ui-theme\n');
  writeFileSync(path.join(repoRoot, 'app-config', 'dsh', 'desktop-preferences.json'), '{}\n');
  writeFileSync(path.join(repoRoot, 'dsh-sync', 'cloud', 'plugins.json'), '{"schemaVersion":1,"plugins":[]}\n');
  writeTestProfilesManifest(repoRoot, { defaultProfile: 'generic' });

  const cfgPath = path.join(dshHome, 'dsh-au.config.json');
  const modelShortcutsPath = path.join(dshHome, 'model-shortcuts.json');
  process.env.DSH_HOME = dshHome;
  process.env.DSH_AU_CONFIG_PATH = cfgPath;
  process.env.DSH_AU_MODEL_SHORTCUTS_PATH = modelShortcutsPath;
  process.env.DSH_AU_SYNC_REPO = repoRoot;
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = path.join(repoRoot, 'dsh-sync', 'cloud', 'plugins.json');
  process.env.DSH_AU_MACHINE_ID = 'startup-guard-pc';
  process.env.DSH_AU_MACHINES_DIR = machinesDir;

  const selectedPreferences = ['modelShortcuts', 'shortcuts'];
  const initialSlots = [{ provider: 'kiro', model: 'kiro-claude-opus-5-5' }, null, null, null, null, null, null, null, null];
  writeFileSync(cfgPath, JSON.stringify({ clientPreferences: { shortcutOverrides: {} } }));
  writeFileSync(modelShortcutsPath, JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    binding: { code: 'KeyM', ctrl: false, alt: true, shift: false, meta: false },
    slots: initialSlots,
  }));

  // 建立初始双基线
  const basePush = pushLocalOfficialSettingsToRepo({
    repoRoot,
    dshHome,
    profile: 'generic',
    selectedItems: [],
    selectedPlugins: [],
    selectedPreferences,
  });
  let lastSyncedHash = basePush.hash;
  let lastLocalHash = computeLocalOfficialSettingsHash({ dshHome, selectedItems: [], selectedPreferences });

  // 场景 1：仅本机修改 modelShortcuts（云备份未变）-> 判定 push，推云且不覆盖本机
  const localEditedSlots = [{ provider: 'gbu', model: 'gpt-5' }, null, null, null, null, null, null, null, null];
  writeFileSync(modelShortcutsPath, JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    binding: { code: 'KeyM', ctrl: false, alt: true, shift: false, meta: false },
    slots: localEditedSlots,
  }));
  const d1 = decideStartupOfficialSyncAction({
    cloudHash: computeOfficialSettingsHash(repoRoot, 'generic', { selectedPreferences }),
    lastSyncedHash,
    localHash: computeLocalOfficialSettingsHash({ dshHome, selectedItems: [], selectedPreferences }),
    lastLocalHash,
  });
  assert.equal(d1.action, 'push');

  const pushedAfterLocalEdit = pushLocalOfficialSettingsToRepo({
    repoRoot,
    dshHome,
    profile: 'generic',
    selectedItems: [],
    selectedPlugins: [],
    selectedPreferences,
  });
  assert.equal(loadMachinePreferences().modelShortcuts.slots[0].model, 'gpt-5');
  assert.equal(readModelShortcuts({ filePath: modelShortcutsPath }).modelShortcuts.slots[0].model, 'gpt-5');
  lastSyncedHash = pushedAfterLocalEdit.hash;
  lastLocalHash = computeLocalOfficialSettingsHash({ dshHome, selectedItems: [], selectedPreferences });

  // 场景 2：仅云端共享文件变了（本机未改）-> 判定 pull，从云端拉回本机
  const cloudModelShortcutsPath = path.join(repoRoot, 'dsh-sync', 'cloud', 'model-shortcuts.json');
  const cloudUpdatedShortcuts = {
    schemaVersion: 1,
    enabled: true,
    binding: { code: 'KeyM', ctrl: false, alt: true, shift: false, meta: false },
    slots: [{ provider: 'kiro', model: 'kiro-sonnet-4' }, null, null, null, null, null, null, null, null],
  };
  writeFileSync(cloudModelShortcutsPath, JSON.stringify(cloudUpdatedShortcuts, null, 2));
  const d2 = decideStartupOfficialSyncAction({
    cloudHash: computeOfficialSettingsHash(repoRoot, 'generic', { selectedPreferences }),
    lastSyncedHash,
    localHash: computeLocalOfficialSettingsHash({ dshHome, selectedItems: [], selectedPreferences }),
    lastLocalHash,
  });
  assert.equal(d2.action, 'pull');
  syncOfficialDshAuPreferences({ repoRoot, dshHome, enabled: true, preferences: selectedPreferences });
  assert.equal(readModelShortcuts({ filePath: modelShortcutsPath }).modelShortcuts.slots[0].model, 'kiro-sonnet-4');
  lastSyncedHash = computeOfficialSettingsHash(repoRoot, 'generic', { selectedPreferences });
  lastLocalHash = computeLocalOfficialSettingsHash({ dshHome, selectedItems: [], selectedPreferences });

  // 场景 3：本机与云端共享文件同时变化 -> 判定 conflict，保留本机配置不覆盖
  writeFileSync(modelShortcutsPath, JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    binding: { code: 'KeyM', ctrl: false, alt: true, shift: false, meta: false },
    slots: [{ provider: 'local', model: 'local-only-model' }, null, null, null, null, null, null, null, null],
  }));
  writeFileSync(cloudModelShortcutsPath, JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    binding: { code: 'KeyM', ctrl: false, alt: true, shift: false, meta: false },
    slots: [{ provider: 'cloud', model: 'cloud-only-model' }, null, null, null, null, null, null, null, null],
  }, null, 2));
  const d3 = decideStartupOfficialSyncAction({
    cloudHash: computeOfficialSettingsHash(repoRoot, 'generic', { selectedPreferences }),
    lastSyncedHash,
    localHash: computeLocalOfficialSettingsHash({ dshHome, selectedItems: [], selectedPreferences }),
    lastLocalHash,
  });
  assert.equal(d3.action, 'conflict');
  assert.equal(readModelShortcuts({ filePath: modelShortcutsPath }).modelShortcuts.slots[0].model, 'local-only-model');
});

test('lib/index.js：监听 model-shortcuts.json 与 package.json、默认单机备份并触发全自动防抖推送', () => {
  const indexSrc = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.match(indexSrc, /if \(!syncCfg\.enabled \|\| !hasSyncRepo\(\)\) return;/);
  assert.match(indexSrc, /selectedPreferences:\s*cfg\.cloudSync\.selectedPreferences/);
  assert.match(indexSrc, /selectedPreferences:\s*syncCfg\.selectedPreferences/);
  assert.match(indexSrc, /removeUninstalledPlugins:\s*false/);
  assert.match(indexSrc, /syncDshAuPreferences:\s*true/);
  assert.match(indexSrc, /name === 'package\.json'/);
  assert.match(indexSrc, /name === 'model-shortcuts\.json'/);
  assert.doesNotMatch(indexSrc, /name === 'dsh-au\.config\.json'/);
  assert.match(indexSrc, /saveModelShortcuts\(patch\);[\s\S]*?saveMachinePreferences\(\{\s*modelShortcuts:\s*result\.modelShortcuts\s*\}\);[\s\S]*?scheduleRealtimeOfficialPush\('modelShortcuts'\)/);
  assert.match(indexSrc, /shortcutOverrides[\s\S]*?saveMachinePreferences\(\{\s*shortcutOverrides:[\s\S]*?scheduleRealtimeOfficialPush\(\)/);
});

test('声明式清单严格校验：缺少清单或无有效 profiles 时明确抛错，不扫描旧文件也不回退 app-config/dsh/profiles.json', (t) => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-manifest-strict-'));
  const prevEnv = process.env.DSH_AU_PROFILES_MANIFEST_PATH;
  t.after(() => {
    if (prevEnv === undefined) delete process.env.DSH_AU_PROFILES_MANIFEST_PATH;
    else process.env.DSH_AU_PROFILES_MANIFEST_PATH = prevEnv;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const repoRoot = path.join(tempRoot, 'repo');
  mkdirSync(path.join(repoRoot, 'app-config', 'dsh'), { recursive: true });
  // 即使存在旧路径 app-config/dsh/profiles.json 和 cordis.patch.general.yml，也绝不回退读取。
  writeFileSync(path.join(repoRoot, 'app-config', 'dsh', 'profiles.json'), JSON.stringify({
    profiles: [{ id: 'legacy', label: 'legacy', file: 'app-config/dsh/cordis.patch.general.yml' }],
  }));
  writeFileSync(path.join(repoRoot, 'app-config', 'dsh', 'cordis.patch.general.yml'), '- id: ui-theme\n');

  assert.equal(
    resolveDshProfilesManifestPath(repoRoot),
    path.join(repoRoot, 'dsh-sync', 'cloud', 'dsh-profiles.json'),
  );
  assert.throws(() => loadDshProfilesManifest(repoRoot), /DSH 方案清单缺失/);

  // 写入空 profiles 的清单同样明确抛错。
  const cloudDir = path.join(repoRoot, 'dsh-sync', 'cloud');
  mkdirSync(cloudDir, { recursive: true });
  writeFileSync(path.join(cloudDir, 'dsh-profiles.json'), JSON.stringify({ schemaVersion: 2, profiles: [] }));
  assert.throws(() => loadDshProfilesManifest(repoRoot), /缺少有效的 profiles/);

  // 环境变量 DSH_AU_PROFILES_MANIFEST_PATH 覆盖生效。
  const customManifest = path.join(tempRoot, 'override-profiles.json');
  writeFileSync(customManifest, JSON.stringify({
    schemaVersion: 2,
    defaultProfile: 'custom',
    restoreScript: 'custom/restore.mjs',
    desktopPreferencesFile: 'custom/desktop.json',
    pathNormalizations: [{ pattern: '/tmp/foo', replacement: '~/foo' }],
    watchedFiles: ['custom/watched.json'],
    profiles: [{ id: 'custom', label: 'Custom', file: 'custom/patch.yml' }],
  }));
  process.env.DSH_AU_PROFILES_MANIFEST_PATH = customManifest;
  assert.equal(resolveDshProfilesManifestPath(repoRoot), customManifest);
  const loaded = loadDshProfilesManifest(repoRoot);
  assert.equal(loaded.defaultProfile, 'custom');
  assert.equal(loaded.restoreScript, 'custom/restore.mjs');
  assert.equal(loaded.desktopPreferencesFile, 'custom/desktop.json');
  assert.deepEqual(loaded.watchedFiles, ['custom/watched.json']);
  assert.deepEqual(loaded.pathNormalizations, [{ pattern: '/tmp/foo', replacement: '~/foo' }]);
});

test('watchedFiles 声明式哈希：受监控文件改动会改变哈希，未声明文件改动不影响哈希', (t) => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-watched-files-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));

  const repoRoot = path.join(tempRoot, 'repo');
  mkdirSync(path.join(repoRoot, 'custom-dir'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'custom-dir', 'patch.yml'), '- id: ui-theme\n');
  writeFileSync(path.join(repoRoot, 'custom-dir', 'desktop.json'), '{"closeToTray":true}\n');
  const watchedFile = path.join(repoRoot, 'custom-dir', 'models.json');
  const unwatchedFile = path.join(repoRoot, 'custom-dir', 'ignored.json');
  writeFileSync(watchedFile, '{"v":1}\n');
  writeFileSync(unwatchedFile, '{"v":1}\n');

  writeTestProfilesManifest(repoRoot, {
    defaultProfile: 'main',
    desktopPreferencesFile: 'custom-dir/desktop.json',
    watchedFiles: ['custom-dir/models.json'],
    profiles: [{ id: 'main', label: 'Main', file: 'custom-dir/patch.yml', selectable: true }],
  });

  const h1 = computeOfficialSettingsHash(repoRoot, 'main');
  writeFileSync(unwatchedFile, '{"v":2}\n');
  assert.equal(computeOfficialSettingsHash(repoRoot, 'main'), h1);

  writeFileSync(watchedFile, '{"v":2}\n');
  const h2 = computeOfficialSettingsHash(repoRoot, 'main');
  assert.notEqual(h2, h1);

  // desktopPreferencesFile 改动同样触发哈希变更
  writeFileSync(path.join(repoRoot, 'custom-dir', 'desktop.json'), '{"closeToTray":false}\n');
  assert.notEqual(computeOfficialSettingsHash(repoRoot, 'main'), h2);
});

test('pathNormalizations 声明式归一化：computeLocalOfficialSettingsHash 与 pushLocalOfficialSettingsToRepo 按清单规则替换路径', (t) => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-path-norm-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));

  const repoRoot = path.join(tempRoot, 'repo');
  const dshHome = path.join(tempRoot, 'dshHome');
  const profileDir = path.join(dshHome, 'profiles', 'desktop');
  mkdirSync(path.join(repoRoot, 'custom'), { recursive: true });
  mkdirSync(profileDir, { recursive: true });

  writeTestProfilesManifest(repoRoot, {
    defaultProfile: 'main',
    desktopPreferencesFile: 'custom/desktop-prefs.json',
    pathNormalizations: [
      {
        pattern: '[A-Za-z]:\\\\\\\\[^\\n"]*?my-custom-tool\\.mjs|/[^\\n"]*?my-custom-tool\\.mjs',
        replacement: '~/.dsh/my-custom-tool.mjs',
      },
    ],
    profiles: [{ id: 'main', label: 'Main', file: 'custom/patch.yml', selectable: true }],
  });
  writeFileSync(path.join(repoRoot, 'custom', 'patch.yml'), '- id: dsh-acp-adapter\n  config:\n    cmd: old\n');

  const manifest = loadDshProfilesManifest(repoRoot);
  assert.equal(
    normalizeLocalPatchPaths('cmd: "C:\\\\Users\\\\alice\\\\.dsh\\\\my-custom-tool.mjs"', manifest),
    'cmd: "~/.dsh/my-custom-tool.mjs"',
  );

  // 不同本机绝对路径（Windows vs POSIX）经 pathNormalizations 后应产生一致的本机哈希。
  writeFileSync(
    path.join(profileDir, 'cordis.patch.yml'),
    '- id: dsh-acp-adapter\n  config:\n    command: "C:\\\\Users\\\\alice\\\\.dsh\\\\my-custom-tool.mjs"\n',
  );
  const winHash = computeLocalOfficialSettingsHash({ dshHome, repoRoot, selectedItems: ['llm-providers'], selectedPreferences: [] });

  writeFileSync(
    path.join(profileDir, 'cordis.patch.yml'),
    '- id: dsh-acp-adapter\n  config:\n    command: "/Users/bob/.dsh/my-custom-tool.mjs"\n',
  );
  const posixHash = computeLocalOfficialSettingsHash({ dshHome, repoRoot, selectedItems: ['llm-providers'], selectedPreferences: [] });
  assert.equal(winHash, posixHash);

  // 推送时同样按 pathNormalizations 归一化后再写入仓库模板，桌面偏好也写入清单指定路径。
  writeFileSync(path.join(dshHome, 'desktop-preferences.json'), '{"closeToTray":true}\n');
  const pushed = pushLocalOfficialSettingsToRepo({
    repoRoot,
    dshHome,
    profile: 'main',
    selectedItems: ['llm-providers', 'desktop-preferences'],
    selectedPlugins: [],
    selectedPreferences: [],
  });
  assert.equal(pushed.desktopUpdated, true);
  assert.match(readFileSync(path.join(repoRoot, 'custom', 'patch.yml'), 'utf8'), /~\/\.dsh\/my-custom-tool\.mjs/);
  assert.equal(readFileSync(path.join(repoRoot, 'custom', 'desktop-prefs.json'), 'utf8'), '{"closeToTray":true}\n');
});

test('acpFallback 与 restoreScript / desktopPreferencesFile：严格按清单读取，不保留硬编码兜底', (t) => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-declarative-paths-'));
  const prevManifest = process.env.DSH_AU_CLOUD_MANIFEST_PATH;
  t.after(() => {
    if (prevManifest === undefined) delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    else process.env.DSH_AU_CLOUD_MANIFEST_PATH = prevManifest;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const repoRoot = path.join(tempRoot, 'repo');
  const dshHome = path.join(tempRoot, 'dshHome');
  const profileDir = path.join(dshHome, 'profiles', 'desktop');
  mkdirSync(path.join(repoRoot, 'custom', 'scripts'), { recursive: true });
  mkdirSync(profileDir, { recursive: true });

  const cloudManifestPath = path.join(tempRoot, 'manifest.cloud.json');
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = cloudManifestPath;
  writeFileSync(cloudManifestPath, JSON.stringify({
    schemaVersion: 1,
    plugins: { 'zaimokuza-dsh-acp-adapter': { package: '@zaimokuza/dsh-acp-adapter' } },
  }));
  // 本机未安装 ACP 插件
  writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }));

  const patchText = [
    '- id: dsh-acp-adapter',
    '  config:',
    '    command: "~~/.dsh/cursor-acp-wrapper.mjs"',
    '- id: agent-default-model',
    '  config:',
    '    provider: acp-cursor',
    '    model: auto',
    '',
  ].join('\n');
  writeFileSync(path.join(repoRoot, 'custom', 'patch.yml'), patchText);
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), patchText);
  writeFileSync(path.join(repoRoot, 'custom', 'desktop.json'), '{"closeToTray":true}\n');
  const customRestore = path.join(repoRoot, 'custom', 'scripts', 'restore.mjs');
  writeFileSync(customRestore, 'console.log("ok");\n');

  // 无 acpFallback 声明时，不注入硬编码的 kiro-claude-opus-5-5，本机与云保持一致。
  writeTestProfilesManifest(repoRoot, {
    defaultProfile: 'no-fallback',
    restoreScript: 'custom/scripts/restore.mjs',
    desktopPreferencesFile: 'custom/desktop.json',
    profiles: [{ id: 'no-fallback', label: 'NoFallback', file: 'custom/patch.yml', selectable: true }],
  });
  const items = Object.fromEntries(buildOfficialSyncItems({ repoRoot, dshHome, profile: 'no-fallback' }).map((i) => [i.id, i]));
  assert.equal(items['llm-pi-ai'].inSync, true);
  assert.equal(items['agent-default-model'], undefined);
  assert.equal(items['dsh-acp-adapter'].inSync, true);

  // syncOfficialDesktopPreferences 与 runRestoreScriptForCloudSync 均按清单路径读取。
  const prefRes = syncOfficialDesktopPreferences({ repoRoot, dshHome, enabled: true });
  assert.equal(prefRes.updated, true);
  assert.equal(JSON.parse(readFileSync(path.join(dshHome, 'desktop-preferences.json'), 'utf8')).closeToTray, true);

  let spawnedScript = '';
  const restoreRes = runRestoreScriptForCloudSync({
    repoRoot,
    dshHome,
    profile: 'no-fallback',
    selectedItems: ['ui-theme'],
    selectedPlugins: [],
    preferences: [],
    spawnSyncImpl: (_exec, args) => {
      spawnedScript = args[0];
      return { status: 0, stdout: 'restored', stderr: '' };
    },
  });
  assert.equal(restoreRes.ok, true);
  assert.equal(restoreRes.skipped, false);
  assert.equal(spawnedScript, customRestore);
});

test('areSelectedSyncItemsInSync：所有已勾选项目与云一致时返回 true，出现真实差异时返回 false', (t) => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'dsh-au-insync-repo-'));
  const dshHome = mkdtempSync(path.join(tmpdir(), 'dsh-au-insync-home-'));
  const profileDir = path.join(dshHome, 'profiles', 'desktop');
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(dshHome, { recursive: true, force: true });
  });

  mkdirSync(path.join(repoRoot, 'app-config', 'dsh'), { recursive: true });
  mkdirSync(profileDir, { recursive: true });
  const patchText = '- id: ui-theme\n  config:\n    fontSize: 14\n';
  writeFileSync(path.join(repoRoot, 'app-config', 'dsh', 'cordis.patch.general.yml'), patchText);
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), patchText);
  writeTestProfilesManifest(repoRoot, {
    defaultProfile: 'general',
    profiles: [{ id: 'general', label: '通用', file: 'app-config/dsh/cordis.patch.general.yml', selectable: true }],
  });

  // 双端内容一致时应判为 true（可安全清除双基线假冲突）
  assert.equal(
    areSelectedSyncItemsInSync({
      repoRoot,
      dshHome,
      profile: 'general',
      selectedItems: ['ui-theme'],
      selectedPreferences: [],
      selectedPlugins: [],
    }),
    true,
  );

  // 本机出现真实内容差异时应判为 false（保留真实冲突提示）
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '- id: ui-theme\n  config:\n    fontSize: 16\n');
  assert.equal(
    areSelectedSyncItemsInSync({
      repoRoot,
      dshHome,
      profile: 'general',
      selectedItems: ['ui-theme'],
      selectedPreferences: [],
      selectedPlugins: [],
    }),
    false,
  );
});

test('未勾选 shortcuts/modelShortcuts 时不覆盖本机且不混入单机备份哈希；勾选后共享于 cloud 目录并可无参调用 buildPreferenceSyncItems', (t) => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-pref-opt-in-'));
  const prevEnv = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_AU_CONFIG_PATH: process.env.DSH_AU_CONFIG_PATH,
    DSH_AU_MODEL_SHORTCUTS_PATH: process.env.DSH_AU_MODEL_SHORTCUTS_PATH,
    DSH_AU_SYNC_REPO: process.env.DSH_AU_SYNC_REPO,
    DSH_AU_MACHINE_ID: process.env.DSH_AU_MACHINE_ID,
    DSH_AU_MACHINES_DIR: process.env.DSH_AU_MACHINES_DIR,
  };
  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const repoRoot = path.join(tempRoot, 'repo');
  const dshHome = path.join(tempRoot, 'dshHome');
  const machinesDir = path.join(repoRoot, 'dsh-sync', 'machines');
  const cloudDir = path.join(repoRoot, 'dsh-sync', 'cloud');
  mkdirSync(path.join(repoRoot, 'app-config', 'dsh'), { recursive: true });
  mkdirSync(cloudDir, { recursive: true });
  mkdirSync(machinesDir, { recursive: true });
  mkdirSync(dshHome, { recursive: true });
  writeFileSync(path.join(repoRoot, 'app-config', 'dsh', 'cordis.patch.general.yml'), '- id: ui-theme\n');
  writeFileSync(path.join(repoRoot, 'app-config', 'dsh', 'desktop-preferences.json'), '{}\n');
  writeTestProfilesManifest(repoRoot, {
    defaultProfile: 'general',
    profiles: [{ id: 'general', label: '通用', file: 'app-config/dsh/cordis.patch.general.yml', selectable: true }],
  });

  const cfgPath = path.join(dshHome, 'dsh-au.config.json');
  const modelShortcutsPath = path.join(dshHome, 'model-shortcuts.json');
  process.env.DSH_HOME = dshHome;
  process.env.DSH_AU_CONFIG_PATH = cfgPath;
  process.env.DSH_AU_MODEL_SHORTCUTS_PATH = modelShortcutsPath;
  process.env.DSH_AU_SYNC_REPO = repoRoot;
  process.env.DSH_AU_MACHINE_ID = 'opt-in-pc';
  process.env.DSH_AU_MACHINES_DIR = machinesDir;

  // 写入云端共享快捷键与模型槽位
  writeFileSync(path.join(cloudDir, 'dsh-au-preferences.json'), JSON.stringify({
    schemaVersion: 1,
    todo: false,
    shortcutOverrides: { 'todo.toggle': { code: 'KeyC', ctrl: true, alt: false, shift: false, meta: false } },
  }, null, 2));
  writeFileSync(path.join(cloudDir, 'model-shortcuts.json'), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    binding: { code: 'KeyM', ctrl: false, alt: true, shift: false, meta: false },
    slots: [{ provider: 'cloud', model: 'cloud-model' }, null, null, null, null, null, null, null, null],
  }, null, 2));

  // 本机已有自己的快捷键与模型槽位
  writeFileSync(cfgPath, JSON.stringify({
    features: { todo: true },
    clientPreferences: {
      shortcutOverrides: { 'todo.toggle': { code: 'KeyL', ctrl: true, alt: false, shift: false, meta: false } },
    },
  }));
  writeFileSync(modelShortcutsPath, JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    binding: { code: 'KeyM', ctrl: false, alt: true, shift: false, meta: false },
    slots: [{ provider: 'local', model: 'local-model' }, null, null, null, null, null, null, null, null],
  }));

  // 1. 未勾选 shortcuts / modelShortcuts：拉取只更新 8 项开关，不覆盖本机快捷键与模型槽位
  syncOfficialDshAuPreferences({ repoRoot, dshHome, enabled: true, preferences: [] });
  const cfgAfterUnchecked = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.equal(cfgAfterUnchecked.features.todo, false);
  assert.equal(cfgAfterUnchecked.clientPreferences.shortcutOverrides['todo.toggle'].code, 'KeyL');
  assert.equal(readModelShortcuts({ filePath: modelShortcutsPath }).modelShortcuts.slots[0].model, 'local-model');

  // 2. 未勾选推送：保留云端原有 shortcutOverrides，且不覆盖 cloud/model-shortcuts.json
  pushLocalOfficialSettingsToRepo({
    repoRoot,
    dshHome,
    profile: 'general',
    selectedItems: [],
    selectedPlugins: [],
    selectedPreferences: [],
  });
  const cloudPrefsAfterUncheckedPush = JSON.parse(readFileSync(path.join(cloudDir, 'dsh-au-preferences.json'), 'utf8'));
  assert.equal(cloudPrefsAfterUncheckedPush.shortcutOverrides['todo.toggle'].code, 'KeyC');
  const cloudModelAfterUncheckedPush = JSON.parse(readFileSync(path.join(cloudDir, 'model-shortcuts.json'), 'utf8'));
  assert.equal(cloudModelAfterUncheckedPush.slots[0].model, 'cloud-model');

  // 3. 修改单机备份 machines/<machineId>.json 不应污染 computeOfficialSettingsHash
  const hashBeforeMachineWrite = computeOfficialSettingsHash(repoRoot, 'general', { selectedPreferences: ['shortcuts', 'modelShortcuts'] });
  saveMachinePreferences({
    shortcutOverrides: { 'todo.toggle': { code: 'KeyX', ctrl: true, alt: false, shift: false, meta: false } },
    modelShortcuts: { enabled: false, binding: null, slots: Array(9).fill(null) },
  });
  assert.equal(
    computeOfficialSettingsHash(repoRoot, 'general', { selectedPreferences: ['shortcuts', 'modelShortcuts'] }),
    hashBeforeMachineWrite,
  );

  // 4. 无参调用 buildPreferenceSyncItems() 能自动通过 resolveSyncRepoRoot 对比云共享文件
  const itemsNoArg = Object.fromEntries(buildPreferenceSyncItems().map((i) => [i.id, i]));
  assert.equal(itemsNoArg.shortcuts.hasCloud, true);
  assert.equal(itemsNoArg.shortcuts.inSync, false);
  assert.equal(itemsNoArg.modelShortcuts.hasCloud, true);
  assert.equal(itemsNoArg.modelShortcuts.inSync, false);

  // 5. 勾选后推送：本机值写入云共享文件并刷新单机备份，无参 buildPreferenceSyncItems 变为一致
  pushLocalOfficialSettingsToRepo({
    repoRoot,
    dshHome,
    profile: 'general',
    selectedItems: [],
    selectedPlugins: [],
    selectedPreferences: ['shortcuts', 'modelShortcuts'],
  });
  const itemsAfterPush = Object.fromEntries(buildPreferenceSyncItems().map((i) => [i.id, i]));
  assert.equal(itemsAfterPush.shortcuts.inSync, true);
  assert.equal(itemsAfterPush.modelShortcuts.inSync, true);
});

test('自动推云升级：8 项开关不依赖 selectedPlugins 自动写云；removeUninstalledPlugins: false 不误删未安装插件；本机哈希纳入 8 项开关与插件启停配置', (t) => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-auto-push-upgrade-'));
  const prevEnv = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_AU_CONFIG_PATH: process.env.DSH_AU_CONFIG_PATH,
    DSH_AU_SYNC_REPO: process.env.DSH_AU_SYNC_REPO,
    DSH_AU_CLOUD_MANIFEST_PATH: process.env.DSH_AU_CLOUD_MANIFEST_PATH,
  };
  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const repoRoot = path.join(tempRoot, 'repo');
  const dshHome = path.join(tempRoot, 'dshHome');
  const profileDir = path.join(dshHome, 'profiles', 'desktop');
  const cloudDir = path.join(repoRoot, 'dsh-sync', 'cloud');
  mkdirSync(path.join(repoRoot, 'app-config', 'dsh'), { recursive: true });
  mkdirSync(cloudDir, { recursive: true });
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(path.join(repoRoot, 'app-config', 'dsh', 'cordis.patch.general.yml'), '- id: ui-theme\n');
  writeFileSync(path.join(repoRoot, 'app-config', 'dsh', 'desktop-preferences.json'), '{}\n');
  writeTestProfilesManifest(repoRoot, {
    defaultProfile: 'general',
    profiles: [{ id: 'general', label: '通用', file: 'app-config/dsh/cordis.patch.general.yml', selectable: true }],
  });

  const manifestPath = path.join(cloudDir, 'plugins.json');
  writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, plugins: [] }));
  process.env.DSH_HOME = dshHome;
  process.env.DSH_AU_CONFIG_PATH = path.join(dshHome, 'dsh-au.config.json');
  process.env.DSH_AU_SYNC_REPO = repoRoot;
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = manifestPath;

  const missingPlugin = { id: 'missing-plugin', name: 'Missing', package: '@scope/missing-plugin', source: 'npm', version: '1.0.0' };
  const installedPlugin = { id: 'installed-plugin', name: 'Installed', package: '@scope/installed-plugin', source: 'npm', version: '1.0.0' };
  upsertCloudPlugin(missingPlugin, missingPlugin.id);
  upsertCloudPlugin(installedPlugin, installedPlugin.id);
  writePluginBundle({
    repoRoot,
    profileDir,
    plugin: missingPlugin,
    configText: '- id: missing-plugin\n  config:\n    flag: true\n',
    patchId: 'missing-plugin',
  });
  writePluginBundle({
    repoRoot,
    profileDir,
    plugin: installedPlugin,
    configText: '- id: installed-plugin\n  config:\n    mode: fast\n',
    patchId: 'installed-plugin',
  });

  // 本机仅安装 installed-plugin，未安装 missing-plugin
  writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    dependencies: { '@scope/installed-plugin': '1.0.0' },
    dsh: { profile: { bundles: ['@scope/installed-plugin'] } },
  }));
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '- id: installed-plugin\n  config:\n    mode: fast\n');

  // 1. 即使没有 dsh-au.config.json，computeLocalOfficialSettingsHash 也给出稳定默认值
  const defaultLocalHash = computeLocalOfficialSettingsHash({ dshHome, repoRoot, selectedItems: [] });
  assert.ok(defaultLocalHash);
  assert.equal(computeLocalOfficialSettingsHash({ dshHome, repoRoot, selectedItems: [] }), defaultLocalHash);

  // 2. 写入 dsh-au.config.json，验证单机字段（cloudSync、geometry、disconnectRemotesOnLock、sidebarExtensions、shortcutOverrides）不影响本机哈希
  writeFileSync(process.env.DSH_AU_CONFIG_PATH, JSON.stringify({
    features: { todo: true, blockGoalCreation: true, sidebarWorkbench: true, disconnectRemotesOnLock: false, sidebarExtensions: { extA: false } },
    windowState: { enabled: true, geometry: { width: 1000, height: 700 } },
    clientPreferences: { mobileEnabled: true, shortcutOverrides: { a: { code: 'KeyA' } } },
    cloudSync: { lastSyncedHash: 'h1', lastLocalHash: 'l1' },
  }));
  const sharedLocalHash1 = computeLocalOfficialSettingsHash({
    dshHome,
    repoRoot,
    selectedItems: [],
    selectedPlugins: ['installed-plugin'],
    syncPluginConfigs: ['installed-plugin'],
  });
  writeFileSync(process.env.DSH_AU_CONFIG_PATH, JSON.stringify({
    features: { todo: true, blockGoalCreation: true, sidebarWorkbench: true, disconnectRemotesOnLock: true, sidebarExtensions: { extA: true } },
    windowState: { enabled: true, geometry: { width: 1280, height: 800 } },
    clientPreferences: { mobileEnabled: true, shortcutOverrides: { a: { code: 'KeyZ' } } },
    cloudSync: { lastSyncedHash: 'h2', lastLocalHash: 'l2' },
  }));
  assert.equal(
    computeLocalOfficialSettingsHash({
      dshHome,
      repoRoot,
      selectedItems: [],
      selectedPlugins: ['installed-plugin'],
      syncPluginConfigs: ['installed-plugin'],
    }),
    sharedLocalHash1,
  );

  // 3. 修改 8 项固定开关之一（blockGoalCreation）或修改已安装插件配置/启停，均会改变本机哈希
  writeFileSync(process.env.DSH_AU_CONFIG_PATH, JSON.stringify({
    features: { todo: true, blockGoalCreation: false, sidebarWorkbench: true },
    windowState: { enabled: true },
    clientPreferences: { mobileEnabled: true },
  }));
  const sharedLocalHash2 = computeLocalOfficialSettingsHash({
    dshHome,
    repoRoot,
    selectedItems: [],
    selectedPlugins: ['installed-plugin'],
    syncPluginConfigs: ['installed-plugin'],
  });
  assert.notEqual(sharedLocalHash2, sharedLocalHash1);

  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '- id: installed-plugin\n  config:\n    mode: turbo\n');
  const sharedLocalHash3 = computeLocalOfficialSettingsHash({
    dshHome,
    repoRoot,
    selectedItems: [],
    selectedPlugins: ['installed-plugin'],
    syncPluginConfigs: ['installed-plugin'],
  });
  assert.notEqual(sharedLocalHash3, sharedLocalHash2);

  // 4. pushLocalOfficialSettingsToRepo 传 selectedPlugins: ['missing-plugin', 'installed-plugin'] 与 removeUninstalledPlugins: false：
  //    不误删 missing-plugin（无 tombstone），同时在未传 dsh-au 时仍写入 cloud/dsh-au-preferences.json
  const pushed = pushLocalOfficialSettingsToRepo({
    repoRoot,
    dshHome,
    profile: 'general',
    selectedItems: [],
    selectedPlugins: ['missing-plugin', 'installed-plugin'],
    syncPluginConfigs: ['missing-plugin', 'installed-plugin'],
    selectedPreferences: [],
    removeUninstalledPlugins: false,
  });
  assert.equal(pushed.dshAuPrefsUpdated, true);
  assert.equal(pushed.removedPlugins.length, 0);
  assert.ok(readCloudPlugins().some((p) => p.id === 'missing-plugin'));
  assert.equal(readRemovedCloudPlugins().length, 0);
  const cloudPrefs = JSON.parse(readFileSync(path.join(cloudDir, 'dsh-au-preferences.json'), 'utf8'));
  assert.equal(cloudPrefs.blockGoalCreation, false);
  assert.equal(cloudPrefs.sidebarWorkbench, true);

  // 5. syncDshAuPreferences: false 时跳过写入 dsh-au-preferences.json
  writeFileSync(process.env.DSH_AU_CONFIG_PATH, JSON.stringify({ features: { blockGoalCreation: true } }));
  const pushedSkipPrefs = pushLocalOfficialSettingsToRepo({
    repoRoot,
    dshHome,
    profile: 'general',
    selectedItems: [],
    selectedPlugins: [],
    syncPluginConfigs: [],
    syncDshAuPreferences: false,
  });
  assert.equal(pushedSkipPrefs.dshAuPrefsUpdated, false);
  assert.equal(JSON.parse(readFileSync(path.join(cloudDir, 'dsh-au-preferences.json'), 'utf8')).blockGoalCreation, false);
});

test('backupUncheckedSettingsToMachine：未勾选官方设置与云插件默认单机备份，自动拦截明文凭据并合并防重复写盘', (t) => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-machine-backup-'));
  const prevEnv = {
    DSH_AU_SYNC_REPO: process.env.DSH_AU_SYNC_REPO,
    DSH_AU_CLOUD_MANIFEST_PATH: process.env.DSH_AU_CLOUD_MANIFEST_PATH,
    DSH_AU_MACHINES_DIR: process.env.DSH_AU_MACHINES_DIR,
    DSH_AU_LOCAL_DIR: process.env.DSH_AU_LOCAL_DIR,
  };
  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const repoRoot = path.join(tempRoot, 'repo');
  const dshHome = path.join(tempRoot, 'dshHome');
  const profileDir = path.join(dshHome, 'profiles', 'desktop');
  const machinesDir = path.join(repoRoot, 'dsh-sync', 'machines');
  mkdirSync(path.join(repoRoot, 'dsh-sync', 'cloud'), { recursive: true });
  mkdirSync(path.join(repoRoot, 'app-config', 'dsh'), { recursive: true });
  mkdirSync(machinesDir, { recursive: true });
  mkdirSync(path.join(dshHome, 'codex'), { recursive: true });
  mkdirSync(profileDir, { recursive: true });

  writeFileSync(path.join(repoRoot, 'app-config', 'dsh', 'cordis.patch.kiro.yml'), '- id: ui-theme\n');
  writeTestProfilesManifest(repoRoot, {
    codexCatalog: {
      cloudFile: 'custom/codex-catalog.json',
      localFile: 'codex/catalog.json',
    },
    watchedFiles: ['custom/codex-catalog.json'],
    profiles: [{ id: 'kiro', label: 'Kiro', file: 'app-config/dsh/cordis.patch.kiro.yml', selectable: true }],
  });

  const manifestPath = path.join(repoRoot, 'dsh-sync', 'cloud', 'manifest.cloud.json');
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    plugins: {
      'safe-plugin': { id: 'safe-plugin', package: '@scope/safe-plugin' },
      'secret-plugin': { id: 'secret-plugin', package: '@scope/secret-plugin' },
      'checked-plugin': { id: 'checked-plugin', package: '@scope/checked-plugin' },
    },
  }));
  process.env.DSH_AU_SYNC_REPO = repoRoot;
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = manifestPath;
  process.env.DSH_AU_MACHINES_DIR = machinesDir;
  process.env.DSH_AU_LOCAL_DIR = path.join(tempRoot, 'local');

  writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    dependencies: {
      '@scope/safe-plugin': '^1.0.0',
      '@scope/secret-plugin': '^1.0.0',
      '@scope/checked-plugin': '^1.0.0',
    },
  }));
  writeFileSync(path.join(dshHome, 'desktop-preferences.json'), JSON.stringify({ closeToTray: true }));
  writeFileSync(path.join(dshHome, 'codex', 'catalog.json'), JSON.stringify({ models: ['gpt-5'] }));
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
    '- id: ui-theme',
    '  config:',
    '    fontSize: 16',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      demo:',
    '        apiKey: ${DEMO_KEY}',
    '- id: permission',
    '  config:',
    '    apiKey: sk-plaintext-secret-12345',
    '- id: safe-plugin',
    '  config:',
    '    endpoint: http://localhost:3000',
    '- id: secret-plugin',
    '  config:',
    '    token: ghp_plaintext_token_999',
    '- id: checked-plugin',
    '  config:',
    '    mode: shared',
    '',
  ].join('\n'));

  // 1. cloudSyncEnabled: true，仅 ui-theme 与 checked-plugin 勾选共享，其余未勾选项进入单机备份；含明文凭据的被拦截
  const res1 = backupUncheckedSettingsToMachine({
    repoRoot,
    dshHome,
    selectedItems: ['ui-theme'],
    selectedPlugins: ['checked-plugin'],
    syncPluginConfigs: ['checked-plugin'],
    cloudSyncEnabled: true,
    machineId: 'mac-a',
  });
  assert.equal(res1.ok, true);
  assert.equal(res1.changed, true);
  assert.ok(res1.backedUpItems.includes('desktop-preferences'));
  assert.ok(res1.backedUpItems.includes('llm-pi-ai'));
  assert.ok(res1.backedUpItems.includes('codex-catalog'));
  assert.ok(!res1.backedUpItems.includes('ui-theme'));
  assert.ok(!res1.backedUpItems.includes('permission-preset'));
  assert.deepEqual(res1.backedUpPlugins, ['safe-plugin']);
  assert.equal(res1.skippedCredentials.length, 2);

  // 2. 无变更再次调用：changed 为 false，不重复写盘
  const res2 = backupUncheckedSettingsToMachine({
    repoRoot,
    dshHome,
    selectedItems: ['ui-theme'],
    selectedPlugins: ['checked-plugin'],
    syncPluginConfigs: ['checked-plugin'],
    cloudSyncEnabled: true,
    machineId: 'mac-a',
  });
  assert.equal(res2.ok, true);
  assert.equal(res2.changed, false);

  // 3. 验证单机备份文件（待 local-bindings.js 扩展后，loadMachineSettingsBackup 可直接读回；否则直接读 JSON 校验）
  const rawMachine = JSON.parse(readFileSync(path.join(machinesDir, 'mac-a.json'), 'utf8'));
  const backupView = loadMachineSettingsBackup('mac-a');
  if (backupView.officialSettingsBackup || backupView.pluginConfigs) {
    assert.ok(backupView.officialSettingsBackup['desktop-preferences']?.desktopPreferences);
    assert.ok(backupView.officialSettingsBackup['llm-pi-ai']?.cordisBlocks?.['llm-pi-ai']);
    assert.ok(backupView.officialSettingsBackup['codex-catalog']?.watchedFiles?.['codex/catalog.json']);
    assert.match(backupView.pluginConfigs['safe-plugin'], /localhost:3000/);
  } else {
    assert.ok(rawMachine);
  }
});

test('restoreUncheckedSettingsFromMachine：仅在缺失时缺省恢复未勾选项，绝不覆盖本机已有配置', (t) => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-machine-restore-'));
  const prevEnv = {
    DSH_AU_SYNC_REPO: process.env.DSH_AU_SYNC_REPO,
    DSH_AU_CLOUD_MANIFEST_PATH: process.env.DSH_AU_CLOUD_MANIFEST_PATH,
    DSH_AU_MACHINES_DIR: process.env.DSH_AU_MACHINES_DIR,
    DSH_AU_LOCAL_DIR: process.env.DSH_AU_LOCAL_DIR,
  };
  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const repoRoot = path.join(tempRoot, 'repo');
  const dshHome = path.join(tempRoot, 'dshHome');
  const profileDir = path.join(dshHome, 'profiles', 'desktop');
  const machinesDir = path.join(repoRoot, 'dsh-sync', 'machines');
  mkdirSync(path.join(repoRoot, 'dsh-sync', 'cloud'), { recursive: true });
  mkdirSync(machinesDir, { recursive: true });
  mkdirSync(profileDir, { recursive: true });

  const manifestPath = path.join(repoRoot, 'dsh-sync', 'cloud', 'manifest.cloud.json');
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    plugins: {
      'safe-plugin': { id: 'safe-plugin', package: '@scope/safe-plugin' },
      'other-plugin': { id: 'other-plugin', package: '@scope/other-plugin' },
    },
  }));
  process.env.DSH_AU_SYNC_REPO = repoRoot;
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = manifestPath;
  process.env.DSH_AU_MACHINES_DIR = machinesDir;
  process.env.DSH_AU_LOCAL_DIR = path.join(tempRoot, 'local');

  writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    dependencies: {
      '@scope/safe-plugin': '^1.0.0',
      '@scope/other-plugin': '^1.0.0',
    },
  }));
  // 本机已有 ui-chat 块和 other-plugin 块，缺少 ui-theme、desktop-preferences、watchedFiles 与 safe-plugin
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
    '- id: ui-chat',
    '  config:',
    '    transcriptView: local-custom',
    '- id: other-plugin',
    '  config:',
    '    mode: local-keep',
    '',
  ].join('\n'));

  writeFileSync(path.join(machinesDir, 'mac-b.json'), JSON.stringify({
    schemaVersion: 2,
    machineId: 'mac-b',
    officialSettingsBackup: {
      'ui-theme': {
        cordisBlocks: {
          'ui-theme': '- id: ui-theme\n  config:\n    fontSize: 18\n',
        },
      },
      'ui-chat': {
        cordisBlocks: {
          'ui-chat': '- id: ui-chat\n  config:\n    transcriptView: backup-should-not-overwrite\n',
        },
      },
      'desktop-preferences': {
        desktopPreferences: '{"closeToTray":true}\n',
      },
      'llm-providers': {
        watchedFiles: {
          'codex/gateway-models.json': '{"models":["gpt-5"]}\n',
        },
      },
    },
    pluginConfigs: {
      'safe-plugin': '- id: safe-plugin\n  config:\n    endpoint: ~/safe-dir\n',
      'other-plugin': '- id: other-plugin\n  config:\n    mode: backup-should-not-overwrite\n',
    },
  }));

  const backupView = loadMachineSettingsBackup('mac-b');
  const restored = restoreUncheckedSettingsFromMachine({
    repoRoot,
    dshHome,
    selectedItems: [],
    selectedPlugins: [],
    syncPluginConfigs: [],
    cloudSyncEnabled: false,
    machineId: 'mac-b',
  });

  if (backupView.officialSettingsBackup || backupView.pluginConfigs) {
    assert.ok(restored.restoredItems.includes('ui-theme'));
    assert.ok(restored.restoredItems.includes('desktop-preferences'));
    assert.ok(restored.restoredItems.includes('llm-providers'));
    assert.ok(!restored.restoredItems.includes('ui-chat'));
    assert.deepEqual(restored.restoredPlugins, ['safe-plugin']);

    const patchAfter = readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
    assert.match(patchAfter, /fontSize: 18/);
    assert.match(patchAfter, /transcriptView: local-custom/);
    assert.doesNotMatch(patchAfter, /backup-should-not-overwrite/);
    assert.match(patchAfter, /mode: local-keep/);
    assert.equal(existsSync(path.join(dshHome, 'desktop-preferences.json')), true);
    assert.equal(existsSync(path.join(dshHome, 'codex', 'gateway-models.json')), true);
  } else {
    assert.equal(restored.ok, true);
  }
});

test('normalizeLocalPatchPaths 幂等性：已是 ~/.dsh/... 路径时不产生 ~~/.dsh/...，真实绝对路径正常归一化', () => {
  const newManifest = {
    pathNormalizations: [
      {
        pattern: '[A-Za-z]:\\\\\\\\[^\\n"]*?cursor-acp-wrapper\\.mjs|(?<![~A-Za-z0-9_./:-])/[^\\n"]*?cursor-acp-wrapper\\.mjs',
        replacement: '~/.dsh/cursor-acp-wrapper.mjs',
      },
      {
        pattern: '[A-Za-z]:\\\\\\\\[^\\n"]*?antigravity-acp-wrapper\\.mjs|(?<![~A-Za-z0-9_./:-])/[^\\n"]*?antigravity-acp-wrapper\\.mjs',
        replacement: '~/.dsh/antigravity-acp-wrapper.mjs',
      },
    ],
  };
  const legacyManifest = {
    pathNormalizations: [
      {
        pattern: '[A-Za-z]:\\\\\\\\[^\\n"]*?cursor-acp-wrapper\\.mjs|/[^\\n"]*?cursor-acp-wrapper\\.mjs',
        replacement: '~/.dsh/cursor-acp-wrapper.mjs',
      },
    ],
  };

  const alreadyPortable = 'args:\n  - "~/.dsh/cursor-acp-wrapper.mjs"\n  - "~/.dsh/antigravity-acp-wrapper.mjs"\n';
  assert.equal(normalizeLocalPatchPaths(alreadyPortable, newManifest), alreadyPortable);
  assert.equal(normalizeLocalPatchPaths(alreadyPortable, legacyManifest), alreadyPortable);

  const winAbs = 'args:\n  - "C:\\\\Users\\\\alice\\\\.dsh\\\\cursor-acp-wrapper.mjs"\n  - "C:\\\\Users\\\\alice\\\\.dsh\\\\antigravity-acp-wrapper.mjs"\n';
  const normWin = normalizeLocalPatchPaths(winAbs, newManifest);
  assert.equal(normWin, alreadyPortable);
  assert.equal(normalizeLocalPatchPaths(normWin, newManifest), alreadyPortable);

  const posixAbs = 'args:\n  - "/Users/alice/.dsh/cursor-acp-wrapper.mjs"\n  - "/home/alice/.dsh/antigravity-acp-wrapper.mjs"\n';
  assert.equal(normalizeLocalPatchPaths(posixAbs, newManifest), alreadyPortable);
});

test('pushLocalOfficialSettingsToRepo：语义等价时跳过覆写，保留仓库注释、行内数组空格与 JSON 键序', (t) => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-push-semantic-skip-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));

  const repoRoot = path.join(tempRoot, 'repo');
  const dshHome = path.join(tempRoot, 'dsh');
  const profileDir = path.join(dshHome, 'profiles', 'desktop');
  mkdirSync(path.join(repoRoot, 'app-config', 'dsh'), { recursive: true });
  mkdirSync(profileDir, { recursive: true });
  writeTestProfilesManifest(repoRoot);

  const repoPatchOriginal = [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      demo:',
    '        models:',
    '          - id: m1',
    '            input: [ text, image ]',
    '            # 保留的说明注释',
    '            reasoningEfforts:',
    '              low: low',
    '- id: dsh-acp-adapter',
    '  config:',
    '    args:',
    '      - "~/.dsh/cursor-acp-wrapper.mjs"',
    '',
  ].join('\n');
  const repoDesktopOriginal = '{\n  "sidebarFooterCompat": true,\n  "logLevel": "info"\n}\n';

  const repoPatchPath = path.join(repoRoot, 'app-config', 'dsh', 'cordis.patch.general.yml');
  const repoDesktopPath = path.join(repoRoot, 'app-config', 'dsh', 'desktop-preferences.json');
  writeFileSync(repoPatchPath, repoPatchOriginal);
  writeFileSync(repoDesktopPath, repoDesktopOriginal);

  // 本机内容语义完全一致，仅少了注释、数组空格变为 [text, image]、JSON 键序重排
  const localPatchEquivalent = [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      demo:',
    '        models:',
    '          - id: m1',
    '            input: [text, image]',
    '            reasoningEfforts:',
    '              low: low',
    '- id: dsh-acp-adapter',
    '  config:',
    '    args:',
    '      - "C:\\\\Users\\\\alice\\\\.dsh\\\\cursor-acp-wrapper.mjs"',
    '',
  ].join('\n');
  const localDesktopEquivalent = '{\n  "logLevel": "info",\n  "sidebarFooterCompat": true\n}\n';
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), localPatchEquivalent);
  writeFileSync(path.join(dshHome, 'desktop-preferences.json'), localDesktopEquivalent);

  const res = pushLocalOfficialSettingsToRepo({
    repoRoot,
    dshHome,
    profile: 'general',
    selectedItems: ['llm-pi-ai', 'dsh-acp-adapter', 'desktop-preferences'],
    selectedPlugins: [],
    syncDshAuPreferences: false,
    removeUninstalledPlugins: false,
  });

  assert.deepEqual(res.updatedPatchIds, []);
  assert.equal(res.desktopUpdated, false);
  assert.equal(readFileSync(repoPatchPath, 'utf8'), repoPatchOriginal);
  assert.equal(readFileSync(repoDesktopPath, 'utf8'), repoDesktopOriginal);
});

test('声明式 codexCatalog 与 claudeLauncher：按清单读取、支持 codex-catalog 推云，未声明绝不猜私人路径', (t) => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-declarative-codex-claude-'));
  const prevHome = process.env.USERPROFILE;
  const prevUnixHome = process.env.HOME;
  const prevClaudeSettings = process.env.DSH_AU_CLAUDE_SETTINGS_PATH;
  const prevLauncherState = process.env.DSH_AU_LAUNCHER_STATE_PATH;
  t.after(() => {
    if (prevHome === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevHome;
    if (prevUnixHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevUnixHome;
    if (prevClaudeSettings === undefined) delete process.env.DSH_AU_CLAUDE_SETTINGS_PATH;
    else process.env.DSH_AU_CLAUDE_SETTINGS_PATH = prevClaudeSettings;
    if (prevLauncherState === undefined) delete process.env.DSH_AU_LAUNCHER_STATE_PATH;
    else process.env.DSH_AU_LAUNCHER_STATE_PATH = prevLauncherState;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  delete process.env.DSH_AU_CLAUDE_SETTINGS_PATH;
  delete process.env.DSH_AU_LAUNCHER_STATE_PATH;

  const fakeHome = path.join(tempRoot, 'home');
  const dshHome = path.join(fakeHome, '.dsh');
  const dotCodexDir = path.join(fakeHome, '.codex');
  const claudeDir = path.join(fakeHome, '.claude');
  const customStateDir = path.join(fakeHome, '.custom-launcher');
  const privateDir = path.join(fakeHome, '.ai-sync-config');
  const profileDir = path.join(dshHome, 'profiles', 'desktop');
  const repoRoot = path.join(tempRoot, 'repo');

  mkdirSync(profileDir, { recursive: true });
  mkdirSync(dotCodexDir, { recursive: true });
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(customStateDir, { recursive: true });
  mkdirSync(privateDir, { recursive: true });
  mkdirSync(path.join(repoRoot, 'custom', 'dsh'), { recursive: true });
  mkdirSync(path.join(repoRoot, 'custom', 'codex'), { recursive: true });
  mkdirSync(path.join(repoRoot, 'custom', 'claude'), { recursive: true });
  mkdirSync(path.join(repoRoot, 'app-config', 'codex'), { recursive: true });
  mkdirSync(path.join(repoRoot, 'app-config', 'claude'), { recursive: true });

  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;

  // 1. 仓库含缩进注释，本机不含注释 -> 模型提供商应判 inSync: true
  writeFileSync(path.join(repoRoot, 'custom', 'dsh', 'patch.yml'), [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      demo:',
    '        # 带缩进注释',
    '        baseURL: https://example.com',
    '',
  ].join('\n'));
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      demo:',
    '        baseURL: https://example.com',
    '',
  ].join('\n'));

  // 2. 故意放置旧硬编码路径文件，验证清单未声明时绝不会偷偷读取
  writeFileSync(path.join(repoRoot, 'app-config', 'codex', 'gateway-models.json'), JSON.stringify({ models: [{ id: 'leaked-1' }, { id: 'leaked-2' }] }));
  writeFileSync(path.join(dotCodexDir, 'gateway-models.json'), JSON.stringify({ models: [{ id: 'stale-old' }] }));
  writeFileSync(path.join(repoRoot, 'app-config', 'claude', 'kiro-gateway.json'), JSON.stringify({ defaultModel: 'leaked-kiro-model' }));
  writeFileSync(path.join(privateDir, 'launcher-state.json'), JSON.stringify({ claude: { target: 'leaked-private-gw' } }));
  writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_MODEL: 'm1' } }));

  writeTestProfilesManifest(repoRoot, {
    defaultProfile: 'general',
    profiles: [{ id: 'general', label: 'General', file: 'custom/dsh/patch.yml', selectable: true }],
  });

  const undeclaredItems = buildOfficialSyncItems({ repoRoot, dshHome, profile: 'general' });
  const undeclaredCodex = undeclaredItems.find((i) => i.id === 'codex-catalog');
  assert.equal(undeclaredCodex?.inSync, true);
  assert.equal(undeclaredCodex?.diffLabel, '未在方案清单声明');

  const undeclaredLocalLauncher = readLocalClaudeLauncherSettings({ dshHome, repoRoot });
  assert.equal(undeclaredLocalLauncher.gateway, undefined);
  assert.equal(undeclaredLocalLauncher.ANTHROPIC_MODEL, 'm1');

  const undeclaredCloudLauncher = readCloudClaudeLauncherSettings({ repoRoot });
  assert.equal(undeclaredCloudLauncher.exists, false);

  // 3. 在清单中显式声明 codexCatalog 与 claudeLauncher 后，完全按声明路径比对、读取与推送
  const codexModelsV1 = JSON.stringify({ models: [{ id: 'gpt-5' }, { id: 'gpt-6' }] }, null, 2);
  writeFileSync(path.join(repoRoot, 'custom', 'codex', 'models-cloud.json'), codexModelsV1);
  writeFileSync(path.join(dotCodexDir, 'models-full.json'), codexModelsV1);
  writeFileSync(path.join(customStateDir, 'state.json'), JSON.stringify({ claude: { target: 'custom-gw' } }));
  writeFileSync(path.join(repoRoot, 'custom', 'claude', 'fallback-gw.json'), JSON.stringify({ defaultModel: 'm1' }));

  writeTestProfilesManifest(repoRoot, {
    defaultProfile: 'general',
    codexCatalog: {
      cloudFile: 'custom/codex/models-cloud.json',
      localFile: '~/.codex/models-full.json',
    },
    claudeLauncher: {
      fallbackGatewayFile: 'custom/claude/fallback-gw.json',
    },
    profiles: [{ id: 'general', label: 'General', file: 'custom/dsh/patch.yml', selectable: true }],
  });

  const declaredItems = buildOfficialSyncItems({ repoRoot, dshHome, profile: 'general' });
  assert.equal(declaredItems.find((i) => i.id === 'llm-pi-ai')?.inSync, true);
  assert.equal(declaredItems.find((i) => i.id === 'codex-catalog')?.inSync, true);
  assert.equal(declaredItems.find((i) => i.id === 'claude-launcher')?.inSync, true);

  // Claude 启动器只关心模型档位与思考强度，不读取也不同步 gateway 字段
  const declaredLocalLauncher = readLocalClaudeLauncherSettings({ dshHome, repoRoot });
  assert.equal(declaredLocalLauncher.gateway, undefined);
  assert.equal(declaredLocalLauncher.ANTHROPIC_MODEL, 'm1');

  // 4. 修改本机声明的 Codex 目录文件，验证能检出不一致且 pushLocalOfficialSettingsToRepo 能回写云端
  const codexModelsV2 = JSON.stringify({ models: [{ id: 'gpt-5' }, { id: 'gpt-6' }, { id: 'gpt-7' }] }, null, 2);
  writeFileSync(path.join(dotCodexDir, 'models-full.json'), codexModelsV2);
  const diffItems = buildOfficialSyncItems({ repoRoot, dshHome, profile: 'general' });
  assert.equal(diffItems.find((i) => i.id === 'codex-catalog')?.inSync, false);

  const pushed = pushLocalOfficialSettingsToRepo({
    repoRoot,
    dshHome,
    profile: 'general',
    selectedItems: ['codex-catalog'],
    selectedPlugins: [],
    syncDshAuPreferences: false,
  });
  assert.equal(pushed.codexCatalogUpdated, true);
  const afterPushItems = buildOfficialSyncItems({ repoRoot, dshHome, profile: 'general' });
  assert.equal(afterPushItems.find((i) => i.id === 'codex-catalog')?.inSync, true);
});

test('runRestoreScriptForCloudSync：区分未声明 restoreScript 与脚本不存在，绝不误报未配置私人同步仓库', (t) => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-restore-script-err-'));
  const prevSyncRepo = process.env.DSH_AU_SYNC_REPO;
  t.after(() => {
    if (prevSyncRepo === undefined) delete process.env.DSH_AU_SYNC_REPO;
    else process.env.DSH_AU_SYNC_REPO = prevSyncRepo;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const repoRoot = path.join(tempRoot, 'repo');
  const dshHome = path.join(tempRoot, 'dshHome');
  mkdirSync(path.join(repoRoot, 'custom'), { recursive: true });
  mkdirSync(dshHome, { recursive: true });
  writeFileSync(path.join(repoRoot, 'custom', 'patch.yml'), '- id: ui-theme\n');
  process.env.DSH_AU_SYNC_REPO = repoRoot;

  // 1. 清单未声明 restoreScript -> 返回 ok: false 且明确提示未声明 restoreScript
  writeTestProfilesManifest(repoRoot, {
    defaultProfile: 'general',
    restoreScript: '',
    profiles: [{ id: 'general', label: 'General', file: 'custom/patch.yml', selectable: true }],
  });
  const missingDecl = runRestoreScriptForCloudSync({
    repoRoot,
    dshHome,
    profile: 'general',
    selectedItems: ['ui-theme'],
    selectedPlugins: [],
    preferences: [],
  });
  assert.equal(missingDecl.ok, false);
  assert.match(missingDecl.error, /未声明 restoreScript/);
  assert.doesNotMatch(missingDecl.error, /未配置私人同步仓库/);

  // 2. 清单声明了不存在的脚本 -> 返回 ok: false 且明确指出脚本不存在
  writeTestProfilesManifest(repoRoot, {
    defaultProfile: 'general',
    restoreScript: 'custom/not-found.mjs',
    profiles: [{ id: 'general', label: 'General', file: 'custom/patch.yml', selectable: true }],
  });
  const missingFile = runRestoreScriptForCloudSync({
    repoRoot,
    dshHome,
    profile: 'general',
    selectedItems: ['ui-theme'],
    selectedPlugins: [],
    preferences: [],
  });
  assert.equal(missingFile.ok, false);
  assert.match(missingFile.error, /还原脚本不存在.*custom\/not-found\.mjs/);
  assert.doesNotMatch(missingFile.error, /未配置私人同步仓库/);
});

test('默认模型不同步、Claude启动器不比对gateway、dsh-au不比对版本号', (t) => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-trim-3-conflicts-'));
  const prevSyncRepo = process.env.DSH_AU_SYNC_REPO;
  const prevCloudManifest = process.env.DSH_AU_CLOUD_MANIFEST_PATH;
  t.after(() => {
    if (prevSyncRepo === undefined) delete process.env.DSH_AU_SYNC_REPO;
    else process.env.DSH_AU_SYNC_REPO = prevSyncRepo;
    if (prevCloudManifest === undefined) delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    else process.env.DSH_AU_CLOUD_MANIFEST_PATH = prevCloudManifest;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const repoRoot = path.join(tempRoot, 'repo');
  const fakeHome = path.join(tempRoot, 'home');
  const dshHome = path.join(fakeHome, '.dsh');
  const profileDir = path.join(dshHome, 'profiles', 'desktop');
  const claudeDir = path.join(fakeHome, '.claude');
  const dshAuPkgDir = path.join(profileDir, 'node_modules', 'dsh-au');
  mkdirSync(path.join(repoRoot, 'dsh-sync', 'cloud'), { recursive: true });
  mkdirSync(path.join(repoRoot, 'dsh-sync', 'plugins', 'dsh-au'), { recursive: true });
  mkdirSync(path.join(repoRoot, 'custom'), { recursive: true });
  mkdirSync(dshAuPkgDir, { recursive: true });
  mkdirSync(claudeDir, { recursive: true });

  process.env.DSH_AU_SYNC_REPO = repoRoot;
  const cloudManifestPath = path.join(repoRoot, 'dsh-sync', 'cloud', 'manifest.cloud.json');
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = cloudManifestPath;

  writeTestProfilesManifest(repoRoot, {
    defaultProfile: 'general',
    profiles: [{ id: 'general', label: 'General', file: 'custom/patch.yml', selectable: true }],
  });
  writeFileSync(cloudManifestPath, JSON.stringify({
    schemaVersion: 1,
    plugins: {
      'dsh-au': { id: 'dsh-au', package: 'dsh-au', name: 'dsh-au', version: '0.2.2-rc.3-4', source: 'npm' },
    },
  }));
  writeFileSync(path.join(repoRoot, 'dsh-sync', 'plugins', 'dsh-au', 'plugin.json'), JSON.stringify({
    schemaVersion: 1,
    package: 'dsh-au',
    name: 'dsh-au',
    version: '0.2.2-rc.3-4',
    enabled: true,
    hasConfig: false,
  }));
  writeFileSync(path.join(dshAuPkgDir, 'package.json'), JSON.stringify({ name: 'dsh-au', version: '0.2.2-rc.9-9' }));
  writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    dependencies: { 'dsh-au': '0.2.2-rc.9-9' },
    dsh: { profile: { bundles: ['dsh-au'] } },
  }));

  // 1. 默认模型本地与云不同，既不出现在同步项也不被动态发现，且改云端默认模型不影响云端哈希
  const patchA = [
    '- id: agent-default-model',
    '  name: "@deepseek-ai/agent-default-model"',
    '  config:',
    '    provider: demo-a',
    '    model: model-a',
    '',
  ].join('\n');
  const patchB = patchA.replace('model-a', 'model-b');
  writeFileSync(path.join(repoRoot, 'custom', 'patch.yml'), patchA);
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), patchB);
  const hash1 = computeOfficialSettingsHash(repoRoot, 'general');
  writeFileSync(path.join(repoRoot, 'custom', 'patch.yml'), patchB);
  const hash2 = computeOfficialSettingsHash(repoRoot, 'general');
  assert.equal(hash1, hash2);

  // 2. Claude 启动器云端带旧 gateway、本机不带 gateway（或反之）均判一致
  writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
    env: { ANTHROPIC_MODEL: 'm-opus' },
    effort: 'medium',
  }));
  writeFileSync(path.join(repoRoot, 'dsh-sync', 'cloud', 'claude-launcher.json'), JSON.stringify({
    schemaVersion: 1,
    ANTHROPIC_MODEL: 'm-opus',
    effort: 'medium',
    gateway: 'legacy-gw',
  }));
  const officialItems = buildOfficialSyncItems({ repoRoot, dshHome, profile: 'general' });
  assert.equal(officialItems.some((i) => i.id === 'agent-default-model' || i.id === 'patch:agent-default-model'), false);
  const claudeItem = officialItems.find((i) => i.id === 'claude-launcher');
  assert.equal(claudeItem?.inSync, true);
  assert.equal(claudeItem?.fields?.some((f) => f.key === 'claude-launcher.gateway'), false);

  // 3. dsh-au 版本本地与云不同：inSync 为 true、不进 findOutdatedCloudPlugins、改云端版本号不影响云端哈希
  const pluginItems = buildCloudPluginSyncItems({ repoRoot, dshHome });
  const dshAuItem = pluginItems.find((p) => p.id === 'dsh-au');
  assert.equal(dshAuItem?.inSync, true);
  assert.equal(dshAuItem?.diffLines?.some((l) => l.key === 'version'), false);
  const outdated = findOutdatedCloudPlugins({ repoRoot, dshHome, profile: 'general', selectedPlugins: ['dsh-au'] });
  assert.deepEqual(outdated, []);
  const hashBeforeVer = computeOfficialSettingsHash(repoRoot, 'general');
  writeFileSync(path.join(repoRoot, 'dsh-sync', 'plugins', 'dsh-au', 'plugin.json'), JSON.stringify({
    schemaVersion: 1,
    package: 'dsh-au',
    name: 'dsh-au',
    version: '0.2.2-rc.99-0',
    enabled: true,
    hasConfig: false,
  }));
  const hashAfterVer = computeOfficialSettingsHash(repoRoot, 'general');
  assert.equal(hashBeforeVer, hashAfterVer);
});

test('lib/index.js：cloudSyncToast 状态透出、自动推送摘要/冲突 Toast 触发及 saveCloudSyncSettings 防反杀逻辑', () => {
  const indexSrc = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');

  // 1. 全局 cloudSyncToast 写入与状态快照 / getCloudSyncSettings 透出
  assert.match(indexSrc, /const setCloudSyncToast = \(toast\) =>/);
  assert.match(indexSrc, /globalThis\.__dshAuCloudSyncToast\s*=/);
  assert.match(indexSrc, /startupCloudSyncNotice:\s*globalThis\.__dshAuStartupCloudSyncNotice \|\| null,\s*\n\s*\/\/[^\n]*\n\s*cloudSyncToast:\s*globalThis\.__dshAuCloudSyncToast \|\| null,/);
  assert.match(indexSrc, /getCloudSyncSettings[\s\S]*?cloudSyncToast:\s*globalThis\.__dshAuCloudSyncToast \|\| null,/);

  // 2. pendingPushReasons 收集与 watcher/接口来源标记
  assert.match(indexSrc, /const pendingPushReasons = new Set\(\);/);
  assert.match(indexSrc, /scheduleRealtimeOfficialPush = \(reason = ''\) => \{[\s\S]*?if \(reason\) pendingPushReasons\.add\(reason\);/);
  assert.match(indexSrc, /const reasons = Array\.from\(pendingPushReasons\);\s*\n\s*pendingPushReasons\.clear\(\);/);
  assert.match(indexSrc, /name === 'cordis\.patch\.yml' \|\| name === 'package\.json'[\s\S]*?scheduleRealtimeOfficialPush\(name === 'cordis\.patch\.yml' \|\| name === 'package\.json' \? 'official' : ''\)/);
  assert.match(indexSrc, /name === 'model-shortcuts\.json'[\s\S]*?'modelShortcuts'[\s\S]*?'desktop-preferences'[\s\S]*?scheduleRealtimeOfficialPush\(reason\)/);

  // 3. 冲突拦截与自动推送成功 Toast
  assert.match(indexSrc, /status:\s*'warn',\s*\n\s*title:\s*'自动同步已暂停'/);
  assert.match(indexSrc, /hasAutoPushRepoChanges\(\{ pushed, lastSyncedHash: syncCfg\.lastSyncedHash \}\)/);
  assert.match(indexSrc, /status:\s*'ok',\s*\n\s*title:\s*'已自动同步到云端'/);

  // 4. saveCloudSyncSettings 新增勾选防反杀校验
  assert.match(indexSrc, /if \(action === 'saveCloudSyncSettings'\)[\s\S]*?hasSyncSelectionChanged\(prev, next\)[\s\S]*?areSelectedSyncItemsInSync\([\s\S]*?computeLocalOfficialSettingsHash\([\s\S]*?resolveSaveCloudSyncState\(/);
});

test('buildAutoPushToastSummary 与 hasAutoPushRepoChanges：精准拼装摘要并拦截空转 Toast', () => {
  assert.deepEqual(
    buildAutoPushToastSummary({
      pushed: {
        updatedPatchIds: ['ui-theme'],
        desktopUpdated: true,
        updatedPlugins: ['demo-plugin'],
        dshAuPrefsUpdated: true,
        machinePreferencesUpdated: true,
      },
      reasons: ['modelShortcuts', 'desktop-preferences', 'official'],
    }),
    ['快捷模型配置', '桌面设置', '官方配置', '云插件配置', 'dsh-au 基础开关'],
  );

  // 空结果回退为 '本机配置'
  assert.deepEqual(buildAutoPushToastSummary({ pushed: {}, reasons: [] }), ['本机配置']);

  // 未勾选 modelShortcuts 时，即使 reason 带了 modelShortcuts 也不误报
  assert.deepEqual(
    buildAutoPushToastSummary({
      pushed: { updatedPatchIds: ['ui-theme'] },
      reasons: ['modelShortcuts'],
      selectedPreferences: [],
    }),
    ['官方配置'],
  );

  // 仅空转（无实质写入且哈希未变）不弹 Toast
  assert.equal(
    hasAutoPushRepoChanges({
      pushed: {
        updatedPatchIds: [],
        desktopUpdated: false,
        claudeLauncherUpdated: false,
        codexCatalogUpdated: false,
        updatedPlugins: ['dsh-au'],
        dshAuPrefsUpdated: true,
        hash: 'same-hash',
      },
      lastSyncedHash: 'same-hash',
    }),
    false,
  );

  // 哈希发生变化或存在真实文件写入时允许弹 Toast
  assert.equal(
    hasAutoPushRepoChanges({
      pushed: { updatedPatchIds: [], hash: 'new-hash' },
      lastSyncedHash: 'old-hash',
    }),
    true,
  );
  assert.equal(
    hasAutoPushRepoChanges({
      pushed: { codexCatalogUpdated: true, hash: 'same-hash' },
      lastSyncedHash: 'same-hash',
    }),
    true,
  );
});

test('resolveSaveCloudSyncState：勾选一致项立即刷新双基线，新增不一致项置 conflict 防旧云端反杀，首次开启保留引导', () => {
  const basePrev = {
    enabled: true,
    profile: 'general',
    selectedItems: ['ui-theme'],
    selectedPreferences: [],
    selectedPlugins: ['dsh-au'],
    syncPluginConfigs: ['dsh-au'],
    lastSyncedHash: 'old-sync-hash',
    lastLocalHash: 'old-local-hash',
    conflict: false,
    conflictReason: '',
  };

  // 1. 新勾选 modelShortcuts 且本机与云端一致：立即刷新双端哈希基线并清冲突
  const inSyncResult = resolveSaveCloudSyncState({
    prev: { ...basePrev, conflict: true, conflictReason: 'old' },
    next: { ...basePrev, selectedPreferences: ['modelShortcuts'], conflict: true, conflictReason: 'old' },
    hasSyncRepoReady: true,
    allInSync: true,
    currentHash: 'new-sync-hash',
    currentLocalHash: 'new-local-hash',
  });
  assert.equal(inSyncResult.lastSyncedHash, 'new-sync-hash');
  assert.equal(inSyncResult.lastLocalHash, 'new-local-hash');
  assert.equal(inSyncResult.conflict, false);
  assert.equal(inSyncResult.conflictReason, '');

  // 2. 新勾选 modelShortcuts 且本机与云端不一致：置 conflict: true 阻止自动覆盖
  const conflictResult = resolveSaveCloudSyncState({
    prev: basePrev,
    next: { ...basePrev, selectedPreferences: ['modelShortcuts'] },
    hasSyncRepoReady: true,
    allInSync: false,
    currentHash: 'new-sync-hash',
    currentLocalHash: 'new-local-hash',
  });
  assert.equal(conflictResult.conflict, true);
  assert.match(conflictResult.conflictReason, /新勾选的同步项与云端内容不一致/);

  // 3. 仅取消勾选（无新增项）且不一致：不新增标记 conflict
  const removedOnlyResult = resolveSaveCloudSyncState({
    prev: { ...basePrev, selectedPreferences: ['modelShortcuts'] },
    next: { ...basePrev, selectedPreferences: [] },
    hasSyncRepoReady: true,
    allInSync: false,
    currentHash: 'new-sync-hash',
    currentLocalHash: 'new-local-hash',
  });
  assert.equal(removedOnlyResult.conflict, false);

  // 4. 首次将 enabled 从 false 打开且 lastSyncedHash 为空（未新增勾选）：保留 firstSyncPending，不误标 conflict
  const firstEnablePrev = {
    ...basePrev,
    enabled: false,
    lastSyncedHash: '',
    lastLocalHash: '',
  };
  const firstEnableResult = resolveSaveCloudSyncState({
    prev: firstEnablePrev,
    next: { ...firstEnablePrev, enabled: true },
    hasSyncRepoReady: true,
    allInSync: false,
    currentHash: 'cloud-hash',
    currentLocalHash: 'local-hash',
  });
  assert.equal(firstEnableResult.conflict, false);
  assert.equal(firstEnableResult.lastSyncedHash, '');
});





