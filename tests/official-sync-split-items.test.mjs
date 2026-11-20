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
  buildOfficialSyncItems,
  discoverUnlistedOfficialBlocks,
  isFullPatchSelection,
  normalizeCloudSyncConfig,
  pushLocalOfficialSettingsToRepo,
  resolveSelectedPatchIds,
} from '../lib/official-settings-sync.js';
import { useTempSyncRepo } from './helpers/temp-sync-repo.mjs';

const SPLIT_UI_IDS = ['ui-theme', 'ui-chat', 'ui-settings-account', 'session-log-deepseek'];
const FIXED_PATCH_BACKED_IDS = [
  'ui-theme', 'ui-chat', 'ui-settings-account', 'session-log-deepseek',
  'subagent-models', 'permission-preset', 'llm-providers',
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
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(repoDshDir, { recursive: true });

  const manifestPath = path.join(tempRoot, 'manifest.cloud.json');
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = manifestPath;
  writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, plugins: {} }));

  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), localPatch);
  for (const p of ['kiro', 'generic', 'local']) {
    writeFileSync(path.join(repoDshDir, `cordis.patch.${p}.yml`), cloudPatch);
  }
  return { repoRoot, dshHome, profileDir, repoDshDir };
}

test('OFFICIAL_SYNC_ITEMS：拆分后的 8 个固定项按顺序排列，且 patchIds 映射正确', () => {
  assert.deepEqual(ALL_OFFICIAL_SYNC_ITEM_IDS, [
    'ui-theme', 'ui-chat', 'ui-settings-account', 'session-log-deepseek',
    'subagent-models', 'permission-preset', 'llm-providers', 'desktop-preferences',
  ]);
  const byId = Object.fromEntries(OFFICIAL_SYNC_ITEMS.map((i) => [i.id, i]));
  assert.deepEqual(byId['ui-theme'].patchIds, ['ui-theme']);
  assert.deepEqual(byId['ui-chat'].patchIds, ['ui-chat']);
  assert.deepEqual(byId['ui-settings-account'].patchIds, ['ui-settings-account']);
  assert.deepEqual(byId['session-log-deepseek'].patchIds, ['session-log-deepseek']);
  assert.deepEqual(byId['subagent-models'].patchIds, ['subagent-model-selection-settings']);
  assert.deepEqual(byId['permission-preset'].patchIds, ['permission']);
  assert.deepEqual(byId['llm-providers'].patchIds, ['llm-pi-ai', 'dsh-acp-adapter', 'agent-default-model']);
  assert.deepEqual(byId['desktop-preferences'].patchIds, []);
  assert.equal(byId['desktop-preferences'].isDesktopPreferences, true);
});

test('旧 ID 展开：normalizeCloudSyncConfig 与 resolveSelectedPatchIds 都把 general-settings / ui-chat-account 拆成 4 个新 ID', () => {
  const cfg = normalizeCloudSyncConfig({ selectedItems: ['general-settings', 'permission-preset'] });
  for (const id of [...SPLIT_UI_IDS, 'permission-preset']) {
    assert.ok(cfg.selectedItems.includes(id), `selectedItems 应包含 ${id}`);
  }
  assert.ok(!cfg.selectedItems.includes('general-settings'), '旧 ID 不应保留');

  const legacyChat = normalizeCloudSyncConfig({ selectedItems: ['ui-chat-account'] });
  for (const id of SPLIT_UI_IDS) assert.ok(legacyChat.selectedItems.includes(id), `ui-chat-account 应展开出 ${id}`);

  // 展开后映射到 DSH block ID
  const fromLegacy = resolveSelectedPatchIds(['general-settings']);
  assert.ok(fromLegacy instanceof Set);
  for (const id of SPLIT_UI_IDS) assert.ok(fromLegacy.has(id), `应含 block ${id}`);
  assert.ok(!fromLegacy.has('permission'));

  // 固定项与 patch:<blockId> 的映射
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

test('isFullPatchSelection：7 个固定 patch 项全选才为真，不要求 desktop-preferences，patch: ID 不影响结果', () => {
  assert.equal(isFullPatchSelection(FIXED_PATCH_BACKED_IDS), true);
  assert.equal(isFullPatchSelection([...FIXED_PATCH_BACKED_IDS, 'desktop-preferences']), true);
  // 额外的动态块不改变结果
  assert.equal(isFullPatchSelection([...FIXED_PATCH_BACKED_IDS, 'patch:dsh-client-ui-foo']), true);
  // 缺一个固定项即为假，动态块也补不上
  const missingOne = FIXED_PATCH_BACKED_IDS.filter((id) => id !== 'ui-chat');
  assert.equal(isFullPatchSelection(missingOne), false);
  assert.equal(isFullPatchSelection([...missingOne, 'patch:dsh-client-ui-foo']), false);
  assert.equal(isFullPatchSelection(['patch:dsh-client-ui-foo']), false);
});

test('模型提供商按提供商汇总成一行：细节不同也能判出差异，细项名与取值有中文', (t) => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-provider-summary-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  const repoRoot = path.join(tempRoot, 'repo');
  const dshHome = path.join(tempRoot, 'home');
  mkdirSync(path.join(repoRoot, 'app-config', 'dsh'), { recursive: true });
  mkdirSync(path.join(dshHome, 'profiles', 'desktop'), { recursive: true });
  const block = (url) => [
    '- id: llm-pi-ai', '  config:', '    providers:', '      kiro:', '        displayName: "Kiro"', `        baseURL: ${url}`,
    '        models:', '          - id: "a"', '          - id: "b"',
    '- id: permission', '  config:', '    defaultPreset: danger-full-access', '',
  ].join('\n');
  writeFileSync(path.join(repoRoot, 'app-config', 'dsh', 'cordis.patch.kiro.yml'), block('http://cloud'));
  writeFileSync(path.join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'), block('http://local'));
  const items = Object.fromEntries(buildOfficialSyncItems({ repoRoot, dshHome, profile: 'kiro' }).map((i) => [i.id, i]));
  const providers = items['llm-providers'].fields.filter((f) => f.key.startsWith('llm-pi-ai.'));
  // 一个提供商只占一行，显示模型数；baseURL 不同 → 云端值注明细节不同。
  assert.equal(providers.length, 1);
  assert.equal(providers[0].local, 'Kiro（2 个模型）');
  assert.notEqual(providers[0].local, providers[0].cloud);
  const preset = items['permission-preset'].fields.find((f) => f.key === 'permission.defaultPreset');
  assert.equal(preset.label, '新会话的默认权限模式');
  assert.equal(preset.local, '完全权限（danger-full-access）');
});
