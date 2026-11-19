import './isolate-sync.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {
  expandPortableConfigPaths,
  normalizePortableConfigPaths,
  readPluginBundles,
  resolvePluginBundleDir,
  writePluginBundle,
} from '../lib/plugin-bundles.js';
import {
  applyBundleOrder,
  applySingleDshPluginState,
  captureAllLocalPlugins,
  capturePluginBundle,
  previewPluginRestore,
  syncDshPlugins,
} from '../lib/plugin-sync-core.js';
import {
  getSharedDshPlugins,
  promoteAllLocalDshPluginsToCloud,
  readLocalDshBundleOrder,
  removeCloudDshPlugin,
} from '../lib/config-store.js';
import { loadLocalBindings, updateMachinePlugins } from '../lib/local-bindings.js';
import { upsertCloudPlugin } from '../lib/cloud-manifest.js';

const PACKAGE = '@weibaohui/dsh-continue';

function makeProfile(dir) {
  const profileDir = join(dir, 'profiles', 'desktop');
  mkdirSync(join(profileDir, 'node_modules', ...PACKAGE.split('/')), { recursive: true });
  writeFileSync(
    join(profileDir, 'node_modules', ...PACKAGE.split('/'), 'package.json'),
    JSON.stringify({
      name: PACKAGE,
      version: '0.3.11',
      license: 'MIT',
      repository: { type: 'git', url: 'git+https://github.com/weibaohui/dsh-continue.git' },
    }),
    'utf8',
  );
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }), 'utf8');
  return profileDir;
}

const CONFIG_BLOCK = [
  '- id: dsh-continue',
  '  name: "@weibaohui/dsh-continue"',
  '  config:',
  '    prompt: 继续',
  '    enabled: true',
  '    maxAttempts: 50',
  '',
].join('\n');

test('plugin bundle snapshot records the patch block and the download source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-bundle-'));
  try {
    const profileDir = makeProfile(dir);
    const repoRoot = join(dir, 'repo');
    const written = writePluginBundle({
      repoRoot,
      profileDir,
      plugin: { package: PACKAGE, name: PACKAGE, version: '0.3.11', enabled: true, source: 'npm' },
      configText: CONFIG_BLOCK,
      patchId: 'dsh-continue',
      syncedFrom: 'Test-Machine',
    });

    assert.equal(written.slug, 'weibaohui-dsh-continue');
    assert.deepEqual(written.files, ['plugin.json', 'README.md', 'config.yml']);
    const manifest = JSON.parse(readFileSync(join(written.dir, 'plugin.json'), 'utf8'));
    assert.equal(manifest.package, PACKAGE);
    assert.equal(manifest.patchId, 'dsh-continue');
    assert.equal(manifest.hasConfig, true);
    // git+https 前缀与 .git 后缀必须归一化，换机才点得开。
    assert.equal(manifest.source.url, 'https://github.com/weibaohui/dsh-continue');
    assert.equal(manifest.source.license, 'MIT');
    assert.equal(readFileSync(join(written.dir, 'config.yml'), 'utf8'), CONFIG_BLOCK);
    const readme = readFileSync(join(written.dir, 'README.md'), 'utf8');
    assert.match(readme, /github\.com\/weibaohui\/dsh-continue/);
    assert.match(readme, /没有同步什么/);

    const saved = readPluginBundles(repoRoot);
    assert.equal(saved.byPackage.get(PACKAGE)?.configText, CONFIG_BLOCK);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('syncing a plugin to this machine merges only its own patch block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-bundle-apply-'));
  process.env.DSH_PLUGIN_SYNC_SKIP_NPM = '1';
  try {
    const dshHome = join(dir, 'dsh');
    const profileDir = makeProfile(dshHome);
    // 本机已有别的 patch 块，同步后必须原样保留。
    const patchPath = join(profileDir, 'cordis.patch.yml');
    writeFileSync(patchPath, '- id: llm-pi-ai\n  config:\n    providers: {}\n', 'utf8');

    const repoRoot = join(dir, 'repo');
    writePluginBundle({
      repoRoot,
      profileDir,
      plugin: { package: PACKAGE, name: PACKAGE, version: '0.3.11', enabled: true, source: 'npm' },
      configText: CONFIG_BLOCK,
      patchId: 'dsh-continue',
      syncedFrom: 'Other-Machine',
    });

    // 本机选择直接作为入参传入，不再写跨机器名单。
    const result = syncDshPlugins({
      dshHome,
      machineName: 'Test-Machine',
      plugins: [{
        id: 'weibaohui-dsh-continue',
        name: PACKAGE,
        package: PACKAGE,
        version: '0.3.11',
        source: 'npm',
      }],
      bundleRepoRoot: repoRoot,
      selectedIds: ['weibaohui-dsh-continue'],
    });

    assert.equal(result.ok, true);
    const patch = readFileSync(patchPath, 'utf8');
    assert.match(patch, /- id: dsh-continue/);
    assert.match(patch, /maxAttempts: 50/);
    assert.match(patch, /prompt: 继续/);
    assert.match(patch, /- id: llm-pi-ai/);
    const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
    assert.deepEqual(pkg.dsh.profile.bundles, [PACKAGE]);
  } finally {
    delete process.env.DSH_PLUGIN_SYNC_SKIP_NPM;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unselecting one cloud plugin does not install another selected plugin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-bundle-unlink-'));
  try {
    const dshHome = join(dir, 'dsh');
    const profileDir = makeProfile(dshHome);
    const patchPath = join(profileDir, 'cordis.patch.yml');
    writeFileSync(patchPath, `${CONFIG_BLOCK}- id: keep-local\n  config:\n    value: preserved\n`, 'utf8');
    const repoRoot = join(dir, 'repo');
    writePluginBundle({
      repoRoot,
      profileDir,
      plugin: { package: PACKAGE, name: PACKAGE, version: '0.3.11', enabled: true, source: 'npm' },
      configText: CONFIG_BLOCK,
      patchId: 'dsh-continue',
      syncedFrom: 'Other-Machine',
    });

    const result = applySingleDshPluginState({
      dshHome,
      machineName: 'Test-Machine',
      pluginId: 'weibaohui-dsh-continue',
      enabled: false,
      plugins: [
        { id: 'weibaohui-dsh-continue', name: PACKAGE, package: PACKAGE, version: '0.3.11', source: 'npm' },
        { id: 'would-install', name: 'Other plugin', package: '@example/would-install', version: '1.0.0', source: 'npm' },
      ],
      bundleRepoRoot: repoRoot,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.results, [{ id: 'weibaohui-dsh-continue', status: 'skipped', reason: '当前电脑未选择' }]);
    const patch = readFileSync(patchPath, 'utf8');
    assert.match(patch, /- id: dsh-continue\n  disabled: true/);
    assert.match(patch, /- id: keep-local\n  config:\n    value: preserved/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('connecting one cloud plugin applies its snapshot without reinstalling another cloud plugin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-bundle-link-one-'));
  try {
    const dshHome = join(dir, 'dsh');
    const profileDir = makeProfile(dshHome);
    const patchPath = join(profileDir, 'cordis.patch.yml');
    const packagePath = join(profileDir, 'package.json');
    writeFileSync(packagePath, JSON.stringify({
      dependencies: { [PACKAGE]: '0.3.11', '@example/dsh-acp-adapter': '0.2.1-rc.2.4' },
      dsh: { profile: { bundles: [PACKAGE, '@example/dsh-acp-adapter'] } },
    }), 'utf8');
    writeFileSync(patchPath, [
      '- id: dsh-continue',
      '  disabled: true',
      '  config:',
      '    prompt: local-value',
      '- id: keep-local',
      '  config:',
      '    value: preserved',
      '',
    ].join('\n'), 'utf8');
    const repoRoot = join(dir, 'repo');
    writePluginBundle({
      repoRoot,
      profileDir,
      plugin: { package: PACKAGE, name: PACKAGE, version: '0.3.11', enabled: true, source: 'npm' },
      configText: '- id: dsh-continue\n  name: "@weibaohui/dsh-continue"\n  config:\n    prompt: cloud-value\n',
      patchId: 'dsh-continue',
      syncedFrom: 'Cloud-Machine',
    });

    const result = applySingleDshPluginState({
      dshHome,
      machineName: 'Test-Machine',
      pluginId: 'weibaohui-dsh-continue',
      enabled: true,
      plugins: [
        { id: 'weibaohui-dsh-continue', name: PACKAGE, package: PACKAGE, version: '0.3.11', source: 'npm' },
        { id: 'acp', name: 'ACP', package: '@example/dsh-acp-adapter', version: '0.2.1-rc.3.1', source: 'npm' },
      ],
      bundleRepoRoot: repoRoot,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.results, [{ id: 'weibaohui-dsh-continue', status: 'already-managed', enabled: true }]);
    const patch = readFileSync(patchPath, 'utf8');
    assert.match(patch, /- id: dsh-continue\n  disabled: false\n  name: "@weibaohui\/dsh-continue"\n  config:\n    prompt: cloud-value/);
    assert.doesNotMatch(patch, /local-value/);
    assert.match(patch, /- id: keep-local\n  config:\n    value: preserved/);
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
    assert.equal(pkg.dependencies['@example/dsh-acp-adapter'], '0.2.1-rc.2.4');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cloud catalog entry without enabled still snapshots the real profile state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-bundle-enabled-'));
  // 云清单必须隔离，否则会读到真实云清单。
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = join(dir, 'manifest.cloud.json');
  try {
    const profileDir = makeProfile(dir);
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dependencies: { [PACKAGE]: '0.3.11' },
      dsh: { profile: { bundles: [PACKAGE] } },
    }), 'utf8');
    // 云清单条目只有 id/package/version/source，没有 enabled。
    const captured = capturePluginBundle({
      packageName: PACKAGE,
      dshHome: dir,
      plugin: { id: 'weibaohui-dsh-continue', package: PACKAGE, version: '0.3.11', source: 'npm' },
      bundleRepoRoot: join(dir, 'repo'),
      syncedFrom: 'Test-Machine',
    });
    assert.equal(captured.ok, true);
    const manifest = JSON.parse(readFileSync(join(captured.dir, 'plugin.json'), 'utf8'));
    assert.equal(manifest.enabled, true);
    assert.equal(manifest.hasConfig, false);
    assert.deepEqual(captured.files, ['plugin.json', 'README.md']);
  } finally {
    delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleting a cloud plugin removes its definition and snapshot dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-bundle-remove-'));
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = join(dir, 'manifest.cloud.json');
  try {
    const repoRoot = join(dir, 'repo');
    const profileDir = makeProfile(dir);
    writePluginBundle({
      repoRoot,
      profileDir,
      plugin: { package: PACKAGE, name: PACKAGE, version: '0.3.11', enabled: true, source: 'npm' },
      configText: CONFIG_BLOCK,
      patchId: 'dsh-continue',
    });
    const bundleDir = resolvePluginBundleDir(repoRoot, PACKAGE);
    assert.equal(existsSync(bundleDir), true);

    upsertCloudPlugin({ id: 'weibaohui-dsh-continue', name: PACKAGE, package: PACKAGE, source: 'npm', version: '0.3.11' }, 'weibaohui-dsh-continue');
    assert.equal(getSharedDshPlugins().length, 1);

    const removed = removeCloudDshPlugin('weibaohui-dsh-continue', { repoRoot });
    assert.equal(removed.removedDefinition, true);
    assert.equal(removed.removedBundle.removed, true);
    // 定义与仓库快照目录都必须消失。
    assert.equal(getSharedDshPlugins().length, 0);
    assert.equal(existsSync(bundleDir), false);
  } finally {
    delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cloud plugin definitions preserve an explicit private npm registry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-registry-'));
  const originalManifestPath = process.env.DSH_AU_CLOUD_MANIFEST_PATH;
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = join(dir, 'manifest.cloud.json');
  try {
    upsertCloudPlugin({
      id: 'private-plugin',
      name: '@team/private-plugin',
      package: '@team/private-plugin',
      source: 'npm',
      version: '1.0.0',
      registry: 'https://packages.example.test/npm',
    }, 'private-plugin');
    assert.equal(getSharedDshPlugins().find((plugin) => plugin.id === 'private-plugin')?.registry, 'https://packages.example.test/npm');

    upsertCloudPlugin({
      id: 'unsafe-plugin',
      name: '@team/unsafe-plugin',
      package: '@team/unsafe-plugin',
      source: 'npm',
      version: '1.0.0',
      registry: 'file:///private-registry',
    }, 'unsafe-plugin');
    assert.equal(getSharedDshPlugins().find((plugin) => plugin.id === 'unsafe-plugin')?.registry, undefined);
  } finally {
    if (originalManifestPath === undefined) delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    else process.env.DSH_AU_CLOUD_MANIFEST_PATH = originalManifestPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repo-linked plugin is recorded as local-repo, npm package as npm', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-bundle-local-'));
  try {
    const profileDir = join(dir, 'profiles', 'desktop');
    const pkgDir = join(dir, 'repo', 'dsh-au');
    mkdirSync(join(profileDir, 'node_modules'), { recursive: true });
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: 'dsh-au', version: '0.1.0', license: 'MIT',
    }), 'utf8');
    // Windows junction 与真实 profile 挂载方式一致，无需管理员软链权限。
    symlinkSync(pkgDir, join(profileDir, 'node_modules', 'dsh-au'), process.platform === 'win32' ? 'junction' : 'dir');

    const linked = writePluginBundle({
      repoRoot: join(dir, 'snapshots'),
      profileDir,
      plugin: { package: 'dsh-au', name: 'dsh-au', version: '0.1.0', enabled: true, source: 'local-profile' },
      configText: '- id: dsh-au\n  disabled: false\n',
      patchId: 'dsh-au',
    });
    assert.equal(linked.manifest.source.type, 'local-repo');

    const npmOne = writePluginBundle({
      repoRoot: join(dir, 'snapshots'),
      profileDir: makeProfile(join(dir, 'other')),
      plugin: { package: PACKAGE, name: PACKAGE, version: '0.3.11', enabled: true },
      configText: CONFIG_BLOCK,
      patchId: 'dsh-continue',
    });
    assert.equal(npmOne.manifest.source.type, 'npm');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('portable config paths normalize Windows/macOS home prefixes and expand per target platform', () => {
  const rawWinConfig = [
    '- id: dsh-acp-adapter',
    '  config:',
    '    agents:',
    '      cursor:',
    '        args:',
    '          - "C:\\\\Users\\\\someone\\\\.dsh\\\\cursor-acp-wrapper.mjs"',
    '      antigravity:',
    '        env:',
    '          AGY_ACP_SERVER: "C:\\\\Users\\\\someone\\\\.dsh\\\\antigravity-acp-candidates\\\\1.4.3\\',
    '            \\\\agy_acp_server.exe"',
    '          PLAIN_PATH: C:\\Users\\someone\\.dsh\\plain.txt',
    '',
  ].join('\n');

  const normalized = normalizePortableConfigPaths(rawWinConfig, 'C:\\Users\\someone');
  assert.match(normalized, /"~\/\.dsh\/cursor-acp-wrapper\.mjs"/);
  assert.match(normalized, /"~\/\.dsh\/antigravity-acp-candidates\/1\.4\.3\/agy_acp_server\.exe"/);
  assert.match(normalized, /PLAIN_PATH: ~\/\.dsh\/plain\.txt/);
  assert.doesNotMatch(normalized, /someone/);

  const expandedMac = expandPortableConfigPaths(normalized, '/Users/macuser', 'darwin');
  assert.match(expandedMac, /"\/Users\/macuser\/\.dsh\/cursor-acp-wrapper\.mjs"/);
  assert.match(expandedMac, /PLAIN_PATH: \/Users\/macuser\/\.dsh\/plain\.txt/);

  const expandedWin = expandPortableConfigPaths(normalized, 'C:\\Users\\bob', 'win32');
  assert.match(expandedWin, /"C:\\\\Users\\\\bob\\\\\.dsh\\\\cursor-acp-wrapper\.mjs"/);
  assert.match(expandedWin, /PLAIN_PATH: C:\\Users\\bob\\\.dsh\\plain\.txt/);
});

test('captureAllLocalPlugins, previewPluginRestore, and fault-tolerant syncDshPlugins preserve bundleOrder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-batch-sync-'));
  try {
    const dshHome = join(dir, 'dsh');
    const profileDir = makeProfile(dshHome);
    const secondPkg = '@example/second-plugin';
    mkdirSync(join(profileDir, 'node_modules', ...secondPkg.split('/')), { recursive: true });
    writeFileSync(
      join(profileDir, 'node_modules', ...secondPkg.split('/'), 'package.json'),
      JSON.stringify({ name: secondPkg, version: '1.2.0', license: 'MIT' }),
      'utf8',
    );
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dependencies: {
        [secondPkg]: '1.2.0',
        [PACKAGE]: '0.3.11',
      },
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-BundlerHost', secondPkg, PACKAGE],
        },
      },
    }), 'utf8');
    const patchPath = join(profileDir, 'cordis.patch.yml');
    writeFileSync(
      patchPath,
      `${CONFIG_BLOCK}# Common DSH host-plane patch shared by every profile.\n- id: second-plugin\n  config:\n    script: C:\\Users\\alice\\.dsh\\helper.mjs\n`,
      'utf8',
    );

    const repoRoot = join(dir, 'repo');
    const capturedAll = captureAllLocalPlugins({
      dshHome,
      bundleRepoRoot: repoRoot,
      syncedFrom: 'Source-PC',
      homeDir: 'C:\\Users\\alice',
    });
    assert.equal(capturedAll.ok, true);
    assert.equal(capturedAll.captured.length, 2);
    assert.deepEqual(capturedAll.bundleOrder, ['@deepseek-ai/dsh-BundlerHost', secondPkg, PACKAGE]);

    const secondSaved = readPluginBundles(repoRoot).byPackage.get(secondPkg);
    assert.match(secondSaved?.configText || '', /~\/\.dsh\/helper\.mjs/);
    const continueSaved = readPluginBundles(repoRoot).byPackage.get(PACKAGE);
    assert.doesNotMatch(continueSaved?.configText || '', /^#/m);

    // 模拟在第二台电脑上预览恢复：second-plugin 未启用，missing-local 安装会失败但不应阻断其余插件
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dependencies: {
        [PACKAGE]: '0.3.11',
        [secondPkg]: '1.2.0',
      },
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-BundlerHost', PACKAGE],
        },
      },
    }), 'utf8');

    const cloudPlugins = [
      { id: 'weibaohui-dsh-continue', name: PACKAGE, package: PACKAGE, version: '0.3.11', source: 'npm' },
      { id: 'example-second-plugin', name: secondPkg, package: secondPkg, version: '1.2.0', source: 'npm' },
      { id: 'missing-local', name: 'missing-local', package: 'missing-local-pkg', version: '0.1.0', source: 'local' },
    ];

    const preview = previewPluginRestore({
      dshHome,
      plugins: cloudPlugins,
      selectedIds: ['weibaohui-dsh-continue', 'example-second-plugin', 'missing-local'],
      bundleOrder: ['@deepseek-ai/dsh-BundlerHost', secondPkg, PACKAGE],
      bundleRepoRoot: repoRoot,
      homeDir: '/Users/target',
      platform: 'darwin',
    });
    assert.equal(preview.ok, true);
    assert.deepEqual(preview.toInstall.map((x) => x.id), ['missing-local']);
    assert.deepEqual(preview.toEnable.map((x) => x.id), ['example-second-plugin']);
    assert.deepEqual(preview.unchanged.map((x) => x.id), ['weibaohui-dsh-continue']);

    const synced = syncDshPlugins({
      dshHome,
      machineName: 'Target-Mac',
      plugins: cloudPlugins,
      selectedIds: ['weibaohui-dsh-continue', 'example-second-plugin', 'missing-local'],
      bundleOrder: ['@deepseek-ai/dsh-BundlerHost', secondPkg, PACKAGE],
      bundleRepoRoot: repoRoot,
      homeDir: '/Users/target',
      platform: 'darwin',
    });
    assert.equal(synced.ok, true);
    assert.equal(synced.partialFailure, true);
    assert.equal(synced.errors.length, 1);
    assert.equal(synced.errors[0].id, 'missing-local');

    const finalPkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
    assert.deepEqual(finalPkg.dsh.profile.bundles, ['@deepseek-ai/dsh-BundlerHost', secondPkg, PACKAGE]);
    const finalPatch = readFileSync(patchPath, 'utf8');
    assert.match(finalPatch, /\/Users\/target\/\.dsh\/helper\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyBundleOrder reorders only managed bundles while preserving host entries', () => {
  const ordered = applyBundleOrder(
    ['@deepseek-ai/dsh-BundlerHost', 'pkg-b', 'pkg-a', 'custom-unmanaged'],
    ['pkg-a', 'pkg-b'],
  );
  assert.deepEqual(ordered, ['@deepseek-ai/dsh-BundlerHost', 'pkg-a', 'pkg-b', 'custom-unmanaged']);
});

test('promoteAllLocalDshPluginsToCloud and updateMachinePlugins persist all installed plugins and bundleOrder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-promote-all-'));
  const prevCloud = process.env.DSH_AU_CLOUD_MANIFEST_PATH;
  const prevBindings = process.env.DSH_AU_LOCAL_BINDINGS_PATH;
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = join(dir, 'manifest.cloud.json');
  process.env.DSH_AU_LOCAL_BINDINGS_PATH = join(dir, 'machines', 'test-pc.json');
  try {
    const profileDir = makeProfile(dir);
    const secondPkg = '@example/second-plugin';
    mkdirSync(join(profileDir, 'node_modules', ...secondPkg.split('/')), { recursive: true });
    writeFileSync(
      join(profileDir, 'node_modules', ...secondPkg.split('/'), 'package.json'),
      JSON.stringify({ name: secondPkg, version: '2.0.0', license: 'MIT' }),
      'utf8',
    );
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dependencies: {
        [PACKAGE]: '0.3.11',
        [secondPkg]: '2.0.0',
      },
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-BundlerHost', secondPkg, PACKAGE],
        },
      },
    }), 'utf8');

    const promoted = promoteAllLocalDshPluginsToCloud('Test-PC', new Map(), dir);
    assert.equal(promoted.promoted.length, 2);
    assert.deepEqual(promoted.bundleOrder, ['@deepseek-ai/dsh-BundlerHost', secondPkg, PACKAGE]);
    assert.deepEqual(readLocalDshBundleOrder('desktop', dir), ['@deepseek-ai/dsh-BundlerHost', secondPkg, PACKAGE]);

    const updated = updateMachinePlugins(promoted.pluginIds, 'Test-PC', {
      bundleOrder: promoted.bundleOrder,
      createIfMissing: true,
    });
    assert.equal(updated.ok, true);
    assert.equal(updated.changed, true);

    const loaded = loadLocalBindings('Test-PC', { migrate: false });
    assert.equal(loaded.exists, true);
    assert.deepEqual(loaded.plugins, promoted.pluginIds);
    assert.deepEqual(loaded.pluginBundleOrder, ['@deepseek-ai/dsh-BundlerHost', secondPkg, PACKAGE]);
  } finally {
    if (prevCloud === undefined) delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    else process.env.DSH_AU_CLOUD_MANIFEST_PATH = prevCloud;
    if (prevBindings === undefined) delete process.env.DSH_AU_LOCAL_BINDINGS_PATH;
    else process.env.DSH_AU_LOCAL_BINDINGS_PATH = prevBindings;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writePluginBundle rejects plaintext credentials but allows env placeholders and non-credential fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-bundle-secrets-'));
  try {
    const profileDir = makeProfile(dir);
    const repoRoot = join(dir, 'repo');

    const badConfigs = [
      '- id: demo\n  config:\n    apiKey: sk-live-123456\n',
      '- id: demo\n  config:\n    password: "my-secret-password"\n',
      '- id: demo\n  config:\n    access_token: tok_plain_abc\n',
      '- id: demo\n  config:\n    authorization: Bearer plain-bearer\n',
      '- id: demo\n  config:\n    webhook: https://user:pass@example.com/hook\n',
      '- id: demo\n  config:\n    webhook: https://example.com/hook?token=plain123\n',
      // 花括号内联写法、驼峰字段名、明文与变量引用混写，都必须拦下。
      '- id: demo\n  config: {password: inline-secret}\n',
      '- id: demo\n  config:\n    db: { user: admin, "password": "inline-secret" }\n',
      '- id: demo\n  config:\n    authToken: real-token-value\n',
      '- id: demo\n  config:\n    botToken: real-token-value\n',
      '- id: demo\n  config:\n    apiKey: sk-live-123${HOME}\n',
      '- id: demo\n  config:\n    token: sk-xx process.env.X\n',
      '- id: demo\n  config:\n    secret: plain keychain\n',
      '- id: demo\n  config:\n    webhook: https://example.com/hook?token=plain${X}\n',
      '- id: demo\n  config:\n    webhook: https://user:plainpass@example.com/hook\n',
    ];
    for (const configText of badConfigs) {
      assert.throws(
        () => writePluginBundle({
          repoRoot,
          profileDir,
          plugin: { package: PACKAGE, name: PACKAGE, version: '0.3.11', enabled: true, source: 'npm' },
          configText,
          patchId: 'demo',
        }),
        /明文凭据/,
      );
      assert.equal(existsSync(join(resolvePluginBundleDir(repoRoot, PACKAGE), 'config.yml')), false);
    }

    const safeConfig = [
      '- id: dsh-continue',
      '  config:',
      '    apiKey: ${OPENAI_API_KEY}',
      '    token: $env:MY_TOKEN',
      '    secret: process.env.MY_SECRET',
      '    password: null',
      '    cookie: ~',
      '    refresh_token: ""',
      '    authToken: $.store.authToken',
      '    clientSecret: keychain:demo',
      '    credential: credentialStore.get("demo")',
      '    botToken: getenv("BOT_TOKEN")',
      '    maxTokens: 4096',
      '    endpoint: https://example.com/hook?token=${HOOK_TOKEN}',
      '    headers: { authorization: "Bearer ${API_TOKEN}", accept: json }',
      '    proxy: https://user:${PROXY_PASS}@example.com/',
      '',
    ].join('\n');
    const written = writePluginBundle({
      repoRoot,
      profileDir,
      plugin: { package: PACKAGE, name: PACKAGE, version: '0.3.11', enabled: true, source: 'npm' },
      configText: safeConfig,
      patchId: 'dsh-continue',
    });
    assert.equal(written.hasConfig, true);
    assert.equal(readFileSync(join(written.dir, 'config.yml'), 'utf8'), safeConfig);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
