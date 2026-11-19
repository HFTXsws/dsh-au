import './isolate-sync.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readPluginBundles } from '../lib/plugin-bundles.js';
import { capturePluginBundle, extractTopLevelPatchBlocks, previewPluginRestore, syncDshPlugins } from '../lib/plugin-sync-core.js';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugin = {
  id: 'weibaohui-dsh-continue',
  name: '@weibaohui/dsh-continue',
  package: '@weibaohui/dsh-continue',
  source: 'npm',
  version: '0.3.12',
  snapshot: 'sync/plugins/weibaohui-dsh-continue',
};

function makeTargetProfile(t) {
  const dshHome = mkdtempSync(path.join(tmpdir(), 'dsh-continue-ssot-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dshHome)), path.resolve(tmpdir()));
    assert.ok(path.basename(dshHome).startsWith('dsh-continue-ssot-'));
    rmSync(dshHome, { recursive: true, force: true });
  });
  const profileDir = path.join(dshHome, 'profiles', 'desktop');
  const moduleDir = path.join(profileDir, 'node_modules', '@weibaohui', 'dsh-continue');
  mkdirSync(moduleDir, { recursive: true });
  writeFileSync(path.join(moduleDir, 'package.json'), JSON.stringify({ name: plugin.package, version: plugin.version }));
  writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    dependencies: { [plugin.package]: plugin.version },
    dsh: { profile: { bundles: [plugin.package] } },
  }));
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '- id: keep-local\n  config:\n    value: preserved\n');
  return { dshHome, profileDir };
}

test('incident 2026-11-06: retired continue plugin is recorded in removedPlugins and snapshot restore remains SSOT', (t) => {
  assert.equal(existsSync(path.join(pluginRoot, 'app-config', 'dsh', 'cordis.patch.common.yml')), false);
  const repoManifest = JSON.parse(readFileSync(path.join(pluginRoot, 'sync', 'cloud', 'manifest.cloud.json'), 'utf8'));
  assert.equal(Boolean(repoManifest.plugins?.[plugin.id]), false);
  assert.equal(Boolean(repoManifest.removedPlugins?.[plugin.id]), false);
  assert.equal(existsSync(path.join(pluginRoot, plugin.snapshot)), false);

  const { dshHome: seedHome } = makeTargetProfile(t);
  const seedPatch = `- id: dsh-continue
  name: ${JSON.stringify(plugin.package)}
  disabled: false
  config:
    rules:
      - id: r-503-auth-unavailable
        action: continue
        maxAttempts: 0
        delayMs: 60000
`;
  writeFileSync(path.join(seedHome, 'profiles', 'desktop', 'cordis.patch.yml'), seedPatch, 'utf8');
  const fixtureRepoRoot = path.join(seedHome, 'fixture-repo');
  const seedCapture = capturePluginBundle({ packageName: plugin.package, dshHome: seedHome, bundleRepoRoot: fixtureRepoRoot });
  assert.equal(seedCapture.ok, true);
  plugin.snapshot = path.relative(fixtureRepoRoot, seedCapture.dir).split(path.sep).join('/');

  const bundles = readPluginBundles(fixtureRepoRoot);
  const snapshot = bundles.byPackage.get(plugin.package);
  assert.equal(bundles.ok, true, JSON.stringify(bundles.errors));
  assert.ok(snapshot);
  assert.equal(snapshot.manifest.hasConfig, true);
  assert.equal(snapshot.manifest.enabled, true);
  assert.equal(snapshot.manifest.patchId, 'dsh-continue');
  assert.equal(snapshot.manifest.version, plugin.version);
  assert.equal(snapshot.manifest.versionVerified, true);
  assert.match(snapshot.manifest.configHash, /^[a-f0-9]{64}$/);

  const { dshHome, profileDir } = makeTargetProfile(t);
  const before = previewPluginRestore({ dshHome, plugins: [plugin], selectedIds: [plugin.id], bundleRepoRoot: fixtureRepoRoot, requireSnapshots: true });
  assert.deepEqual(before.toUpdateConfig.map((item) => item.id), [plugin.id]);

  const result = syncDshPlugins({ dshHome, plugins: [plugin], selectedIds: [plugin.id], bundleRepoRoot: fixtureRepoRoot, requireSnapshots: true });
  assert.equal(result.ok, true);
  const patchText = readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
  const continueBlock = extractTopLevelPatchBlocks(patchText).find((block) => block.id === 'dsh-continue')?.text || '';
  assert.match(patchText, /- id: keep-local\n  config:\n    value: preserved/);
  // 413 由 dsh-au 的 preset-aware 恢复链唯一处理；外部插件只保留明确需要的 503 规则。
  const expectedRuleIds = ['r-503-auth-unavailable'];
  assert.deepEqual([...continueBlock.matchAll(/^      - id: (.+)$/gm)].map((match) => match[1]), expectedRuleIds);
  assert.doesNotMatch(continueBlock, /r-413|INVALID_REQUEST/);
  assert.match(continueBlock, /- id: r-503-auth-unavailable[\s\S]*?action: continue[\s\S]*?maxAttempts: 0\n        delayMs: 60000/);
  assert.equal(continueBlock, snapshot.configText);
  // 使用真实导出/恢复链路，仅写临时仓库与 Profile；不得将插件默认规则重新拼回快照。
  const exportRoot = path.join(dshHome, 'export-repo');
  const captured = capturePluginBundle({ packageName: plugin.package, dshHome, bundleRepoRoot: exportRoot });
  assert.equal(captured.ok, true);
  const exported = readPluginBundles(exportRoot).byPackage.get(plugin.package);
  assert.equal(exported.configText, snapshot.configText);
  const second = makeTargetProfile(t);
  const restored = syncDshPlugins({ dshHome: second.dshHome, plugins: [plugin], selectedIds: [plugin.id], bundleRepoRoot: exportRoot, requireSnapshots: true });
  assert.equal(restored.ok, true);
  const restoredText = readFileSync(path.join(second.profileDir, 'cordis.patch.yml'), 'utf8');
  const restoredBlock = extractTopLevelPatchBlocks(restoredText).find((block) => block.id === 'dsh-continue')?.text;
  assert.equal(restoredBlock, snapshot.configText);
});

test('snapshot-only mode rejects an undeclared snapshot before changing plugin state', (t) => {
  const { dshHome, profileDir } = makeTargetProfile(t);
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  const before = readFileSync(patchPath, 'utf8');
  const undeclared = { ...plugin };
  delete undeclared.snapshot;
  const preview = previewPluginRestore({ dshHome, plugins: [undeclared], selectedIds: [undeclared.id], bundleRepoRoot: pluginRoot, requireSnapshots: true });
  const result = syncDshPlugins({ dshHome, plugins: [undeclared], selectedIds: [], bundleRepoRoot: pluginRoot, requireSnapshots: true });
  assert.equal(preview.ok, false);
  assert.equal(preview.code, 'SNAPSHOT_INVALID');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SNAPSHOT_INVALID');
  assert.equal(readFileSync(patchPath, 'utf8'), before);
});
