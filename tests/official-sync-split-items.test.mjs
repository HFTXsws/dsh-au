import './isolate-sync.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ALL_OFFICIAL_SYNC_ITEM_IDS,
  OFFICIAL_SYNC_ITEMS,
  applySelectedOfficialPatchBlocks,
  backupUncheckedSettingsToMachine,
  buildCloudPluginSyncItems,
  buildOfficialSyncItems,
  buildPreferenceSyncItems,
  computeLocalOfficialSettingsHash,
  computeOfficialSettingsHash,
  discoverUnlistedOfficialBlocks,
  isFullPatchSelection,
  normalizeCloudSyncConfig,
  pushLocalOfficialSettingsToRepo,
  resolveSelectedPatchIds,
  restoreUncheckedSettingsFromMachine,
  syncOfficialClaudeLauncher,
} from '../lib/official-settings-sync.js';
import { useTempSyncRepo } from './helpers/temp-sync-repo.mjs';

const SPLIT_UI_IDS = ['ui-theme', 'ui-chat', 'ui-settings-account', 'session-log-deepseek'];
const SPLIT_MODEL_IDS = ['llm-pi-ai', 'agent-default-model', 'claude-launcher', 'codex-catalog', 'dsh-acp-adapter'];
const FIXED_PATCH_BACKED_IDS = [
  'ui-theme', 'ui-chat', 'ui-settings-account', 'session-log-deepseek',
  'subagent-models', 'permission-preset',
  'llm-pi-ai', 'agent-default-model', 'dsh-acp-adapter',
];

const FOO_BLOCK = [
  '- id: dsh-client-ui-foo',
  '  name: "@deepseek-ai/dsh-client-ui-foo"',
  '  config:',
  '    x: 1',
  '',
].join('\n');

const BAR_BLOCK = [
  '- id: dsh-client-ui-bar',
  '  name: "@deepseek-ai/dsh-client-ui-bar"',
  '  config:',
  '    y: 2',
  '',
].join('\n');

/** 建临时 dshHome + repoRoot：本地 patch 写入 localPatch，云端三个方案文件写入 cloudPatch。 */
function makeSyncFixture(t, { localPatch = '', cloudPatch = '' } = {}) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-split-items-'));
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
  const cloudDir = path.join(repoRoot, 'dsh-sync', 'cloud');
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(repoDshDir, { recursive: true });
  mkdirSync(cloudDir, { recursive: true });

  const manifestPath = path.join(tempRoot, 'manifest.cloud.json');
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = manifestPath;
  writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, plugins: {} }));

  writeFileSync(path.join(cloudDir, 'dsh-profiles.json'), JSON.stringify({
    schemaVersion: 2,
    defaultProfile: 'kiro',
    restoreScript: 'scripts/dsh-restore.mjs',
    desktopPreferencesFile: 'app-config/dsh/desktop-preferences.json',
    pathNormalizations: [],
    watchedFiles: [],
    profiles: ['kiro', 'generic', 'local'].map((id) => ({
      id,
      label: id,
      file: `app-config/dsh/cordis.patch.${id}.yml`,
      selectable: true,
    })),
  }, null, 2));

  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), localPatch);
  for (const p of ['kiro', 'generic', 'local']) {
    writeFileSync(path.join(repoDshDir, `cordis.patch.${p}.yml`), cloudPatch);
  }
  return { repoRoot, dshHome, profileDir, repoDshDir };
}

test('OFFICIAL_SYNC_ITEMS：拆分后的 12 个固定项按顺序排列，且 patchIds 映射正确', () => {
  assert.deepEqual(ALL_OFFICIAL_SYNC_ITEM_IDS, [
    'ui-theme', 'ui-chat', 'ui-settings-account', 'session-log-deepseek',
    'subagent-models', 'permission-preset',
    'llm-pi-ai', 'agent-default-model', 'claude-launcher', 'codex-catalog', 'dsh-acp-adapter',
    'desktop-preferences',
  ]);
  const byId = Object.fromEntries(OFFICIAL_SYNC_ITEMS.map((i) => [i.id, i]));
  assert.deepEqual(byId['ui-theme'].patchIds, ['ui-theme']);
  assert.deepEqual(byId['ui-chat'].patchIds, ['ui-chat']);
  assert.deepEqual(byId['ui-settings-account'].patchIds, ['ui-settings-account']);
  assert.deepEqual(byId['session-log-deepseek'].patchIds, ['session-log-deepseek']);
  assert.deepEqual(byId['subagent-models'].patchIds, ['subagent-model-selection-settings']);
  assert.deepEqual(byId['permission-preset'].patchIds, ['permission']);
  assert.deepEqual(byId['llm-pi-ai'].patchIds, ['llm-pi-ai']);
  assert.deepEqual(byId['agent-default-model'].patchIds, ['agent-default-model']);
  assert.deepEqual(byId['claude-launcher'].patchIds, []);
  assert.equal(byId['claude-launcher'].isClaudeLauncher, true);
  assert.deepEqual(byId['codex-catalog'].patchIds, []);
  assert.equal(byId['codex-catalog'].isCodexCatalog, true);
  assert.deepEqual(byId['dsh-acp-adapter'].patchIds, ['dsh-acp-adapter']);
  assert.deepEqual(byId['desktop-preferences'].patchIds, []);
  assert.equal(byId['desktop-preferences'].isDesktopPreferences, true);
});

test('旧 ID 展开：normalizeCloudSyncConfig 与 resolveSelectedPatchIds 把 general-settings / ui-chat-account / llm-providers 无感展开', () => {
  const cfg = normalizeCloudSyncConfig({ selectedItems: ['general-settings', 'permission-preset'] });
  for (const id of [...SPLIT_UI_IDS, 'permission-preset']) {
    assert.ok(cfg.selectedItems.includes(id), `selectedItems 应包含 ${id}`);
  }
  assert.ok(!cfg.selectedItems.includes('general-settings'), '旧 ID 不应保留');

  const legacyChat = normalizeCloudSyncConfig({ selectedItems: ['ui-chat-account'] });
  for (const id of SPLIT_UI_IDS) assert.ok(legacyChat.selectedItems.includes(id), `ui-chat-account 应展开出 ${id}`);

  const legacyModel = normalizeCloudSyncConfig({ selectedItems: ['llm-providers'] });
  for (const id of SPLIT_MODEL_IDS) assert.ok(legacyModel.selectedItems.includes(id), `llm-providers 应展开出 ${id}`);
  assert.ok(!legacyModel.selectedItems.includes('llm-providers'), '旧 ID llm-providers 不应保留');

  // 展开后映射到 DSH block ID
  const fromLegacy = resolveSelectedPatchIds(['general-settings']);
  assert.ok(fromLegacy instanceof Set);
  for (const id of SPLIT_UI_IDS) assert.ok(fromLegacy.has(id), `应含 block ${id}`);
  assert.ok(!fromLegacy.has('permission'));

  // 固定项与 patch:<blockId> 的映射（含 legacy llm-providers 自动展开）
  const mixed = resolveSelectedPatchIds(['llm-providers', 'subagent-models', 'patch:dsh-client-ui-foo']);
  assert.deepEqual(
    [...mixed].sort(),
    ['agent-default-model', 'dsh-acp-adapter', 'dsh-client-ui-foo', 'llm-pi-ai', 'subagent-model-selection-settings'],
  );
});

test('applySelectedOfficialPatchBlocks：只选 ui-theme 时仅替换该块，其余块保持本地原样；patch:<id> 可复制动态块', () => {
  const current = [
    '- id: ui-theme',
    '  config:',
    '    fontSize: 12',
    '- id: ui-chat',
    '  config:',
    '    density: old',
    '- id: permission',
    '  config:',
    '    defaultPreset: local-only',
    '- id: dsh-au',
    '  disabled: false',
    '',
  ].join('\n');
  const rendered = [
    '- id: ui-theme',
    '  config:',
    '    fontSize: 18',
    '- id: ui-chat',
    '  config:',
    '    density: new',
    '- id: permission',
    '  config:',
    '    defaultPreset: danger-full-access',
    '',
    FOO_BLOCK,
  ].join('\n');

  const themeOnly = applySelectedOfficialPatchBlocks({
    currentPatchText: current,
    renderedProfilePatch: rendered,
    selectedItems: ['ui-theme'],
  });
  assert.match(themeOnly, /fontSize: 18/, 'ui-theme 应取云端');
  assert.doesNotMatch(themeOnly, /fontSize: 12/);
  assert.match(themeOnly, /density: old/, 'ui-chat 未选，保持本地');
  assert.doesNotMatch(themeOnly, /density: new/);
  assert.match(themeOnly, /defaultPreset: local-only/, 'permission 未选，保持本地');
  assert.doesNotMatch(themeOnly, /dsh-client-ui-foo/, '未选动态块不应带入');

  const withDynamic = applySelectedOfficialPatchBlocks({
    currentPatchText: current,
    renderedProfilePatch: rendered,
    selectedItems: ['patch:dsh-client-ui-foo'],
  });
  assert.match(withDynamic, /- id: dsh-client-ui-foo/);
  assert.match(withDynamic, /x: 1/);
  assert.match(withDynamic, /fontSize: 12/, '其余块仍为本地值');
});

test('discoverUnlistedOfficialBlocks：只发现 @deepseek-ai/ 且不在固定项里的块，排除 dsh-au、第三方与固定项块', (t) => {
  const localPatch = [
    FOO_BLOCK,
    '- id: dsh-au',
    '  name: "dsh-au"',
    '  disabled: false',
    '- id: third-party-thing',
    '  name: "@someone/third-party-thing"',
    '  config:',
    '    z: 3',
    '- id: ui-theme',
    '  name: "@deepseek-ai/dsh-client-ui-theme"',
    '  config:',
    '    fontSize: 12',
    '',
  ].join('\n');
  // 云端独有的块也应被发现
  const fx = makeSyncFixture(t, { localPatch, cloudPatch: BAR_BLOCK });

  const found = discoverUnlistedOfficialBlocks({ repoRoot: fx.repoRoot, dshHome: fx.dshHome, profile: 'kiro' });
  const ids = found.map((b) => b.id).sort();
  assert.deepEqual(ids, ['patch:dsh-client-ui-bar', 'patch:dsh-client-ui-foo']);
  const foo = found.find((b) => b.blockId === 'dsh-client-ui-foo');
  assert.equal(foo.packageName, '@deepseek-ai/dsh-client-ui-foo');
});

test('normalizeCloudSyncConfig：默认不含 patch: ID；保留合法 patch:<id>，丢弃 patch:../evil', () => {
  const def = normalizeCloudSyncConfig(undefined);
  assert.deepEqual(def.selectedItems, [...ALL_OFFICIAL_SYNC_ITEM_IDS]);
  assert.ok(def.selectedItems.every((id) => !id.startsWith('patch:')));

  const cfg = normalizeCloudSyncConfig({
    selectedItems: ['ui-theme', 'patch:dsh-client-ui-foo', 'patch:../evil', 'patch:Bad_ID'],
  });
  assert.ok(cfg.selectedItems.includes('ui-theme'));
  assert.ok(cfg.selectedItems.includes('patch:dsh-client-ui-foo'));
  assert.ok(!cfg.selectedItems.includes('patch:../evil'));
  assert.ok(!cfg.selectedItems.includes('patch:Bad_ID'));
});

test('buildOfficialSyncItems：固定项之后追加动态项，每项带 inSync 与 fields', (t) => {
  const fx = makeSyncFixture(t, { localPatch: FOO_BLOCK, cloudPatch: '' });
  const items = buildOfficialSyncItems({ repoRoot: fx.repoRoot, dshHome: fx.dshHome, profile: 'kiro' });

  const fixedCount = ALL_OFFICIAL_SYNC_ITEM_IDS.length;
  assert.deepEqual(items.slice(0, fixedCount).map((i) => i.id), [...ALL_OFFICIAL_SYNC_ITEM_IDS]);
  assert.ok(items.slice(0, fixedCount).every((i) => !i.dynamic), '固定项不应带 dynamic');

  const dynamic = items.slice(fixedCount);
  assert.equal(dynamic.length, 1);
  assert.equal(dynamic[0].id, 'patch:dsh-client-ui-foo');
  assert.equal(dynamic[0].dynamic, true);
  // 本地有、云端无，必然不一致
  assert.equal(dynamic[0].inSync, false);

  for (const item of items) {
    assert.equal(typeof item.inSync, 'boolean', `${item.id} 应有 inSync`);
    assert.ok(Array.isArray(item.fields), `${item.id} 应有 fields 数组`);
    for (const f of item.fields) {
      for (const key of ['label', 'officialDefault', 'local', 'cloud']) {
        assert.ok(key in f, `${item.id} 的字段缺少 ${key}`);
      }
    }
  }
});

test('pushLocalOfficialSettingsToRepo：只把已选动态块写入云端各方案文件，未选块不写', (t) => {
  useTempSyncRepo(t, 'dsh-split-push-');
  const fx = makeSyncFixture(t, {
    localPatch: `${FOO_BLOCK}${BAR_BLOCK}`,
    cloudPatch: '- id: dsh-au\n  disabled: false\n',
  });

  pushLocalOfficialSettingsToRepo({
    repoRoot: fx.repoRoot,
    dshHome: fx.dshHome,
    profile: 'kiro',
    selectedItems: ['patch:dsh-client-ui-foo'],
    selectedPlugins: [],
    selectedPreferences: [],
  });

  for (const p of ['kiro', 'generic', 'local']) {
    const text = readFileSync(path.join(fx.repoDshDir, `cordis.patch.${p}.yml`), 'utf8');
    assert.match(text, /- id: dsh-client-ui-foo/, `${p} 应写入已选动态块`);
    assert.match(text, /x: 1/);
    assert.doesNotMatch(text, /dsh-client-ui-bar/, `${p} 不应写入未选块`);
  }
});

test('isFullPatchSelection：9 个固定 patch 项全选才为真，不要求非 patch 项，patch: ID 不影响结果', () => {
  assert.equal(isFullPatchSelection(FIXED_PATCH_BACKED_IDS), true);
  assert.equal(isFullPatchSelection([...FIXED_PATCH_BACKED_IDS, 'desktop-preferences', 'claude-launcher', 'codex-catalog']), true);
  // 额外的动态块不改变结果
  assert.equal(isFullPatchSelection([...FIXED_PATCH_BACKED_IDS, 'patch:dsh-client-ui-foo']), true);
  // 缺一个固定项即为假，动态块也补不上
  const missingOne = FIXED_PATCH_BACKED_IDS.filter((id) => id !== 'ui-chat');
  assert.equal(isFullPatchSelection(missingOne), false);
  assert.equal(isFullPatchSelection([...missingOne, 'patch:dsh-client-ui-foo']), false);
  assert.equal(isFullPatchSelection(['patch:dsh-client-ui-foo']), false);
});

test('模型提供商按提供商汇总成一行：细节不同也能判出差异，细项名与取值有中文，并附 summary / detailTags / diffLines', (t) => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-provider-summary-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  const repoRoot = path.join(tempRoot, 'repo');
  const dshHome = path.join(tempRoot, 'home');
  mkdirSync(path.join(repoRoot, 'app-config', 'dsh'), { recursive: true });
  mkdirSync(path.join(repoRoot, 'dsh-sync', 'cloud'), { recursive: true });
  mkdirSync(path.join(dshHome, 'profiles', 'desktop'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'dsh-sync', 'cloud', 'dsh-profiles.json'), JSON.stringify({
    schemaVersion: 2,
    defaultProfile: 'kiro',
    profiles: [{ id: 'kiro', label: 'kiro', file: 'app-config/dsh/cordis.patch.kiro.yml', selectable: true }],
  }));
  const block = (url) => [
    '- id: llm-pi-ai', '  config:', '    providers:', '      kiro:', '        displayName: "Kiro"', `        baseURL: ${url}`,
    '        models:', '          - id: "a"', '          - id: "b"',
    '- id: permission', '  config:', '    defaultPreset: danger-full-access', '',
  ].join('\n');
  writeFileSync(path.join(repoRoot, 'app-config', 'dsh', 'cordis.patch.kiro.yml'), block('http://cloud'));
  writeFileSync(path.join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'), block('http://local'));
  const items = Object.fromEntries(buildOfficialSyncItems({ repoRoot, dshHome, profile: 'kiro' }).map((i) => [i.id, i]));
  const providers = items['llm-pi-ai'].fields.filter((f) => f.key.startsWith('llm-pi-ai.'));
  // 一个提供商只占一行，显示模型数；baseURL 不同 → 云端值注明细节不同。
  assert.equal(providers.length, 1);
  assert.equal(providers[0].local, 'Kiro（2 个模型）');
  assert.notEqual(providers[0].local, providers[0].cloud);
  assert.equal(items['llm-pi-ai'].summary, '1 家供应商 · 2 个模型');
  assert.deepEqual(items['llm-pi-ai'].detailTags, [{ label: 'kiro', detail: '2 模型' }]);
  assert.ok(Array.isArray(items['llm-pi-ai'].diffLines));
  assert.equal(items['llm-pi-ai'].diffLines[0].changed, true);
  const preset = items['permission-preset'].fields.find((f) => f.key === 'permission.defaultPreset');
  assert.equal(preset.label, '新会话的默认权限模式');
  assert.equal(preset.local, '完全权限（danger-full-access）');
});

test('claude-launcher 白名单同步：推送与拉取不泄密 ANTHROPIC_AUTH_TOKEN，保留本机凭据与 URL，并支持 summary/detailTags/diffLines', (t) => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-claude-launcher-'));
  const prevClaudePath = process.env.DSH_AU_CLAUDE_SETTINGS_PATH;
  const prevLauncherStatePath = process.env.DSH_AU_LAUNCHER_STATE_PATH;
  const prevManifest = process.env.DSH_AU_CLOUD_MANIFEST_PATH;
  t.after(() => {
    if (prevClaudePath === undefined) delete process.env.DSH_AU_CLAUDE_SETTINGS_PATH;
    else process.env.DSH_AU_CLAUDE_SETTINGS_PATH = prevClaudePath;
    if (prevLauncherStatePath === undefined) delete process.env.DSH_AU_LAUNCHER_STATE_PATH;
    else process.env.DSH_AU_LAUNCHER_STATE_PATH = prevLauncherStatePath;
    if (prevManifest === undefined) delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    else process.env.DSH_AU_CLOUD_MANIFEST_PATH = prevManifest;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const repoRoot = path.join(tempRoot, 'repo');
  const dshHome = path.join(tempRoot, 'home', '.dsh');
  const claudeSettingsPath = path.join(tempRoot, 'home', '.claude', 'settings.json');
  const launcherStatePath = path.join(tempRoot, 'home', '.ai-sync-config', 'launcher-state.json');
  process.env.DSH_AU_CLAUDE_SETTINGS_PATH = claudeSettingsPath;
  process.env.DSH_AU_LAUNCHER_STATE_PATH = launcherStatePath;

  mkdirSync(path.dirname(claudeSettingsPath), { recursive: true });
  mkdirSync(path.dirname(launcherStatePath), { recursive: true });
  mkdirSync(path.join(repoRoot, 'dsh-sync', 'cloud'), { recursive: true });
  mkdirSync(path.join(repoRoot, 'app-config', 'dsh'), { recursive: true });
  mkdirSync(path.join(dshHome, 'profiles', 'desktop'), { recursive: true });

  const manifestPath = path.join(tempRoot, 'manifest.cloud.json');
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = manifestPath;
  writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, plugins: {} }));
  writeFileSync(path.join(repoRoot, 'dsh-sync', 'cloud', 'dsh-profiles.json'), JSON.stringify({
    schemaVersion: 2,
    defaultProfile: 'kiro',
    profiles: [{ id: 'kiro', label: 'kiro', file: 'app-config/dsh/cordis.patch.kiro.yml', selectable: true }],
  }));
  writeFileSync(path.join(repoRoot, 'app-config', 'dsh', 'cordis.patch.kiro.yml'), '');
  writeFileSync(path.join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'), '');

  writeFileSync(claudeSettingsPath, JSON.stringify({
    env: {
      ANTHROPIC_AUTH_TOKEN: 'sk-secret-local-token-12345',
      ANTHROPIC_API_KEY: 'sk-ant-secret-key',
      ANTHROPIC_BASE_URL: 'https://private-gateway.example.com/v1',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      ANTHROPIC_MODEL: 'claude-sonnet-4-6',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-6',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-4-6',
    },
    effort: 'high',
    otherCustomSetting: 'keep-me',
  }, null, 2));
  writeFileSync(launcherStatePath, JSON.stringify({ target: 'GBU' }));

  const beforeLocalHash = computeLocalOfficialSettingsHash({ dshHome, repoRoot, selectedItems: ['claude-launcher'] });
  const pushRes = pushLocalOfficialSettingsToRepo({
    repoRoot,
    dshHome,
    profile: 'kiro',
    selectedItems: ['claude-launcher'],
    selectedPlugins: [],
  });
  assert.equal(pushRes.claudeLauncherUpdated, true);

  const cloudLauncherFile = path.join(repoRoot, 'dsh-sync', 'cloud', 'claude-launcher.json');
  const cloudRaw = readFileSync(cloudLauncherFile, 'utf8');
  assert.doesNotMatch(cloudRaw, /sk-secret-local-token-12345/);
  assert.doesNotMatch(cloudRaw, /sk-ant-secret-key/);
  assert.doesNotMatch(cloudRaw, /private-gateway\.example\.com/);
  assert.doesNotMatch(cloudRaw, /aws-secret/);
  assert.doesNotMatch(cloudRaw, /ANTHROPIC_AUTH_TOKEN/);
  assert.doesNotMatch(cloudRaw, /ANTHROPIC_BASE_URL/);

  const cloudJson = JSON.parse(cloudRaw);
  assert.equal(cloudJson.ANTHROPIC_MODEL, 'claude-sonnet-4-6');
  assert.equal(cloudJson.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-4-6');
  assert.equal(cloudJson.effort, 'high');
  assert.equal(cloudJson.gateway, 'GBU');

  // 云端修改后，本机哈希与云端哈希一致性检查 + 拉取回写保留本机凭据
  const itemsInSync = Object.fromEntries(buildOfficialSyncItems({ repoRoot, dshHome, profile: 'kiro' }).map((i) => [i.id, i]));
  assert.equal(itemsInSync['claude-launcher'].inSync, true);
  assert.equal(itemsInSync['claude-launcher'].summary, '当前网关：GBU');
  assert.equal(itemsInSync['claude-launcher'].detailTags.length, 5);
  assert.ok(itemsInSync['claude-launcher'].diffLines.every((l) => l.changed === false));

  const hashBeforeCloudEdit = computeOfficialSettingsHash(repoRoot, 'kiro');
  writeFileSync(cloudLauncherFile, JSON.stringify({
    ...cloudJson,
    ANTHROPIC_MODEL: 'claude-opus-4-7',
    effort: 'medium',
  }, null, 2));
  const hashAfterCloudEdit = computeOfficialSettingsHash(repoRoot, 'kiro');
  assert.notEqual(hashAfterCloudEdit, hashBeforeCloudEdit);

  const itemsDiff = Object.fromEntries(buildOfficialSyncItems({ repoRoot, dshHome, profile: 'kiro' }).map((i) => [i.id, i]));
  assert.equal(itemsDiff['claude-launcher'].inSync, false);
  assert.ok(itemsDiff['claude-launcher'].diffLines.some((l) => l.key === 'claude-launcher.ANTHROPIC_MODEL' && l.changed === true));

  const pullRes = syncOfficialClaudeLauncher({ repoRoot, dshHome, enabled: true });
  assert.equal(pullRes.updated, true);
  const afterLocal = JSON.parse(readFileSync(claudeSettingsPath, 'utf8'));
  assert.equal(afterLocal.env.ANTHROPIC_MODEL, 'claude-opus-4-7');
  assert.equal(afterLocal.effort, 'medium');
  assert.equal(afterLocal.env.ANTHROPIC_AUTH_TOKEN, 'sk-secret-local-token-12345');
  assert.equal(afterLocal.env.ANTHROPIC_BASE_URL, 'https://private-gateway.example.com/v1');
  assert.equal(afterLocal.otherCustomSetting, 'keep-me');

  const afterLocalHash = computeLocalOfficialSettingsHash({ dshHome, repoRoot, selectedItems: ['claude-launcher'] });
  assert.notEqual(afterLocalHash, beforeLocalHash);
});

test('buildPreferenceSyncItems 与 buildCloudPluginSyncItems 均返回 summary 与 diffLines', (t) => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-summary-difflines-'));
  const prevCfg = process.env.DSH_AU_CONFIG_PATH;
  const prevShortcuts = process.env.DSH_AU_MODEL_SHORTCUTS_PATH;
  const prevManifest = process.env.DSH_AU_CLOUD_MANIFEST_PATH;
  t.after(() => {
    if (prevCfg === undefined) delete process.env.DSH_AU_CONFIG_PATH;
    else process.env.DSH_AU_CONFIG_PATH = prevCfg;
    if (prevShortcuts === undefined) delete process.env.DSH_AU_MODEL_SHORTCUTS_PATH;
    else process.env.DSH_AU_MODEL_SHORTCUTS_PATH = prevShortcuts;
    if (prevManifest === undefined) delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    else process.env.DSH_AU_CLOUD_MANIFEST_PATH = prevManifest;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const repoRoot = path.join(tempRoot, 'repo');
  const dshHome = path.join(tempRoot, 'dshHome');
  mkdirSync(path.join(repoRoot, 'dsh-sync', 'cloud'), { recursive: true });
  mkdirSync(path.join(dshHome, 'profiles', 'desktop'), { recursive: true });

  const cfgPath = path.join(dshHome, 'dsh-au.config.json');
  const shortcutsPath = path.join(dshHome, 'model-shortcuts.json');
  const manifestPath = path.join(tempRoot, 'manifest.cloud.json');
  process.env.DSH_AU_CONFIG_PATH = cfgPath;
  process.env.DSH_AU_MODEL_SHORTCUTS_PATH = shortcutsPath;
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = manifestPath;

  writeFileSync(cfgPath, JSON.stringify({
    clientPreferences: {
      shortcutOverrides: { 'todo.toggle': { code: 'KeyT', ctrl: true, alt: false, shift: false, meta: false } },
    },
  }));
  writeFileSync(shortcutsPath, JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    binding: { code: 'KeyM', ctrl: false, alt: true, shift: false, meta: false },
    slots: [{ provider: 'kiro', model: 'claude-sonnet-4-6' }],
  }));
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    plugins: { 'demo-plugin': { id: 'demo-plugin', name: 'Demo', package: 'demo-plugin', source: 'npm', version: '1.0.0' } },
  }));

  const prefItems = Object.fromEntries(buildPreferenceSyncItems({ repoRoot, dshHome }).map((i) => [i.id, i]));
  assert.equal(prefItems.shortcuts.summary, '1 个自定义快捷键');
  assert.equal(prefItems.shortcuts.diffLines[0].key, 'shortcuts.todo.toggle');
  assert.equal(prefItems.shortcuts.diffLines[0].local, 'Ctrl+KeyT');
  assert.equal(prefItems.modelShortcuts.summary, '已启用 · 1/9 个槽位');
  assert.equal(prefItems.modelShortcuts.diffLines.length, 11);

  const pluginItems = buildCloudPluginSyncItems({ repoRoot, dshHome });
  assert.equal(pluginItems.length, 1);
  assert.equal(typeof pluginItems[0].summary, 'string');
  assert.equal(pluginItems[0].diffLines.length, 3);
});

test('backupUncheckedSettingsToMachine 与 restoreUncheckedSettingsFromMachine：claude-launcher 白名单备份/恢复且不泄密 token', (t) => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-claude-machine-backup-'));
  const prevEnv = {
    DSH_AU_SYNC_REPO: process.env.DSH_AU_SYNC_REPO,
    DSH_AU_CLOUD_MANIFEST_PATH: process.env.DSH_AU_CLOUD_MANIFEST_PATH,
    DSH_AU_MACHINES_DIR: process.env.DSH_AU_MACHINES_DIR,
    DSH_AU_LOCAL_DIR: process.env.DSH_AU_LOCAL_DIR,
    DSH_AU_CLAUDE_SETTINGS_PATH: process.env.DSH_AU_CLAUDE_SETTINGS_PATH,
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
  const claudeSettingsPath = path.join(tempRoot, 'claude-settings.json');
  mkdirSync(path.join(repoRoot, 'dsh-sync', 'cloud'), { recursive: true });
  mkdirSync(machinesDir, { recursive: true });
  mkdirSync(path.join(dshHome, 'profiles', 'desktop'), { recursive: true });

  const manifestPath = path.join(repoRoot, 'dsh-sync', 'cloud', 'manifest.cloud.json');
  writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, plugins: {} }));
  process.env.DSH_AU_SYNC_REPO = repoRoot;
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = manifestPath;
  process.env.DSH_AU_MACHINES_DIR = machinesDir;
  process.env.DSH_AU_LOCAL_DIR = path.join(tempRoot, 'local');
  process.env.DSH_AU_CLAUDE_SETTINGS_PATH = claudeSettingsPath;

  writeFileSync(claudeSettingsPath, JSON.stringify({
    env: {
      ANTHROPIC_AUTH_TOKEN: 'sk-do-not-backup',
      ANTHROPIC_BASE_URL: 'https://secret.example.com',
      ANTHROPIC_MODEL: 'claude-sonnet-4-6',
    },
    effort: 'high',
  }));

  const backupRes = backupUncheckedSettingsToMachine({
    repoRoot,
    dshHome,
    selectedItems: [],
    cloudSyncEnabled: true,
    machineId: 'mac-claude',
  });
  assert.ok(backupRes.backedUpItems.includes('claude-launcher'));
  const machineRaw = readFileSync(path.join(machinesDir, 'mac-claude.json'), 'utf8');
  assert.doesNotMatch(machineRaw, /sk-do-not-backup/);
  assert.doesNotMatch(machineRaw, /secret\.example\.com/);

  // 模拟另一台机器仅有 token、缺少模型映射时缺省恢复
  writeFileSync(claudeSettingsPath, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-new-machine' } }));
  const restoreRes = restoreUncheckedSettingsFromMachine({
    repoRoot,
    dshHome,
    selectedItems: [],
    cloudSyncEnabled: false,
    machineId: 'mac-claude',
  });
  assert.ok(restoreRes.restoredItems.includes('claude-launcher'));
  const restored = JSON.parse(readFileSync(claudeSettingsPath, 'utf8'));
  assert.equal(restored.env.ANTHROPIC_MODEL, 'claude-sonnet-4-6');
  assert.equal(restored.effort, 'high');
  assert.equal(restored.env.ANTHROPIC_AUTH_TOKEN, 'sk-new-machine');
});
