import './isolate-sync.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { comparePluginVersions, pushNewerInstalledPluginVersions } from '../lib/official-settings-sync.js';
import { makeTempSyncRepo } from './helpers/temp-sync-repo.mjs';

const PACKAGE_NAME = 'demo-plugin';
const PLUGIN_ID = 'demo-plugin';

function writeInstalledPlugin(dshHome, version, { enabled = true, patch = '' } = {}) {
  const profile = path.join(dshHome, 'profiles', 'desktop');
  const moduleDir = path.join(profile, 'node_modules', PACKAGE_NAME);
  mkdirSync(moduleDir, { recursive: true });
  writeFileSync(path.join(profile, 'package.json'), `${JSON.stringify({
    dependencies: { [PACKAGE_NAME]: version },
    dsh: { profile: { bundles: enabled ? [PACKAGE_NAME] : [] } },
  }, null, 2)}\n`);
  writeFileSync(path.join(profile, 'cordis.patch.yml'), patch);
  writeFileSync(path.join(moduleDir, 'package.json'), `${JSON.stringify({ name: PACKAGE_NAME, version }, null, 2)}\n`);
}

function writeCloudPlugin(repo, version, { enabled = true, configText = '' } = {}) {
  const pluginDir = path.join(repo.syncDir, 'plugins', PACKAGE_NAME);
  mkdirSync(pluginDir, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    package: PACKAGE_NAME,
    name: 'Demo',
    version,
    requestedSpec: version,
    versionVerified: true,
    enabled,
    patchId: PLUGIN_ID,
    source: { type: 'npm', ref: version },
    hasConfig: Boolean(configText),
  };
  writeFileSync(path.join(pluginDir, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (configText) writeFileSync(path.join(pluginDir, 'config.yml'), configText);
  writeFileSync(path.join(repo.syncDir, 'cloud', 'manifest.cloud.json'), `${JSON.stringify({
    schemaVersion: 1,
    plugins: {
      [PLUGIN_ID]: {
        name: 'Demo',
        package: PACKAGE_NAME,
        source: 'npm',
        version,
        snapshot: 'dsh-au/sync/plugins/demo-plugin',
      },
    },
  }, null, 2)}\n`);
  return pluginDir;
}

function setup(t) {
  const repo = makeTempSyncRepo('dsh-plugin-version-');
  const dshHome = mkdtempSync(path.join(tmpdir(), 'dsh-plugin-version-home-'));
  t.after(() => {
    rmSync(repo.root, { recursive: true, force: true });
    rmSync(dshHome, { recursive: true, force: true });
  });
  return { repo, dshHome };
}

test('版本比较认预发布和范围符号', () => {
  assert.equal(comparePluginVersions('0.5.0', '0.4.1'), 1);
  assert.equal(comparePluginVersions('0.2.2-rc.3.1', '0.2.1-rc.3.1'), 1);
  assert.equal(comparePluginVersions('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(comparePluginVersions('^0.5.0', '0.5.0'), 0);
  assert.equal(comparePluginVersions('not-a-version', '0.5.0'), null);
});

test('只是本机版本更新时，自动把版本号写上云，不改配置', (t) => {
  const { repo, dshHome } = setup(t);
  const configText = '- id: demo-plugin\n  name: "demo-plugin"\n  config:\n    theme: dark\n';
  const pluginDir = writeCloudPlugin(repo, '0.4.1', { configText });
  writeInstalledPlugin(dshHome, '0.5.0', { patch: configText });

  const result = pushNewerInstalledPluginVersions({
    repoRoot: repo.root,
    dshHome,
    selectedPlugins: [PLUGIN_ID],
  });

  assert.deepEqual(result.updated.map((item) => item.to), ['0.5.0']);
  const snapshot = JSON.parse(readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8'));
  assert.equal(snapshot.version, '0.5.0');
  assert.equal(snapshot.enabled, true);
  assert.equal(readFileSync(path.join(pluginDir, 'config.yml'), 'utf8'), configText);
  const cloud = JSON.parse(readFileSync(path.join(repo.syncDir, 'cloud', 'manifest.cloud.json'), 'utf8'));
  assert.equal(cloud.plugins[PLUGIN_ID].version, '0.5.0');
  assert.equal(cloud.plugins[PLUGIN_ID].snapshot, 'dsh-au/sync/plugins/demo-plugin');
});

test('配置不同或本机更旧时不自动推版本', (t) => {
  const { repo, dshHome } = setup(t);
  const cloudConfig = '- id: demo-plugin\n  name: "demo-plugin"\n  config:\n    theme: dark\n';
  const pluginDir = writeCloudPlugin(repo, '0.4.1', { configText: cloudConfig });
  writeInstalledPlugin(dshHome, '0.5.0', {
    patch: '- id: demo-plugin\n  name: "demo-plugin"\n  config:\n    theme: light\n',
  });

  const changedConfig = pushNewerInstalledPluginVersions({
    repoRoot: repo.root,
    dshHome,
    selectedPlugins: [PLUGIN_ID],
  });
  assert.deepEqual(changedConfig.updated, []);
  assert.equal(JSON.parse(readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8')).version, '0.4.1');

  writeInstalledPlugin(dshHome, '0.4.0', { patch: cloudConfig });
  writeCloudPlugin(repo, '0.5.0', { configText: cloudConfig });
  const older = pushNewerInstalledPluginVersions({
    repoRoot: repo.root,
    dshHome,
    selectedPlugins: [PLUGIN_ID],
  });
  assert.deepEqual(older.updated, []);
  assert.equal(JSON.parse(readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8')).version, '0.5.0');
});

test('没有勾选同步的插件不推版本', (t) => {
  const { repo, dshHome } = setup(t);
  const pluginDir = writeCloudPlugin(repo, '0.4.1');
  writeInstalledPlugin(dshHome, '0.5.0');
  const result = pushNewerInstalledPluginVersions({
    repoRoot: repo.root,
    dshHome,
    selectedPlugins: [],
  });
  assert.deepEqual(result.updated, []);
  assert.equal(JSON.parse(readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8')).version, '0.4.1');
});

test('本地仓库来源（local / local-repo）的插件不自动推版本上云', (t) => {
  const { repo, dshHome } = setup(t);
  const pluginDir = writeCloudPlugin(repo, '0.4.1');
  const manifestPath = path.join(repo.syncDir, 'cloud', 'manifest.cloud.json');
  const cloud = JSON.parse(readFileSync(manifestPath, 'utf8'));
  cloud.plugins[PLUGIN_ID].source = 'local';
  writeFileSync(manifestPath, `${JSON.stringify(cloud, null, 2)}\n`);
  const snapshotPath = path.join(pluginDir, 'plugin.json');
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  snapshot.source = { type: 'local-repo', ref: '0.4.1' };
  writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  writeInstalledPlugin(dshHome, '0.5.0');

  const result = pushNewerInstalledPluginVersions({
    repoRoot: repo.root,
    dshHome,
    selectedPlugins: [PLUGIN_ID],
  });
  assert.deepEqual(result.updated, []);
  assert.equal(JSON.parse(readFileSync(snapshotPath, 'utf8')).version, '0.4.1');
});
