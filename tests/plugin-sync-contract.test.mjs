import './isolate-sync.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applySingleDshPluginState, isNpmPluginAlreadyInstalled, syncDshPlugins } from '../lib/plugin-sync-core.js';
import { applySingleDshPluginState as applyAsync } from '../lib/plugin-sync-jobs.js';
import { acquirePluginProfileLock } from '../lib/plugin-profile-state.js';
import { writePluginBundle } from '../lib/plugin-bundles.js';
import { runPluginsDoctor } from '../lib/plugin-doctor.js';

const plugin = { id: 'demo', package: 'demo-plugin', version: '1.0.0', source: 'npm' };
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-contract-空格 '));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('dsh-contract-'));
    rmSync(root, { recursive: true, force: true });
  });
  const profileDir = path.join(root, 'profiles', 'desktop');
  const moduleDir = path.join(profileDir, 'node_modules', plugin.package);
  mkdirSync(moduleDir, { recursive: true });
  writeFileSync(path.join(moduleDir, 'package.json'), JSON.stringify({ name: plugin.package, version: plugin.version }));
  writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ dependencies: { [plugin.package]: plugin.version }, dsh: { profile: { bundles: [] } } }));
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '- id: local-only\n  config:\n    keep: unchanged\n');
  const options = { dshHome: root, bundleRepoRoot: root, plugins: [plugin], selectedIds: [plugin.id] };
  return { root, profileDir, moduleDir, options };
}
const read = (dir, name) => readFileSync(path.join(dir, name), 'utf8');

test('incident: matching dependency declaration does not hide a different installed version', (t) => {
  const { profileDir, moduleDir } = fixture(t);
  assert.equal(isNpmPluginAlreadyInstalled(profileDir, plugin), true);
  for (const meta of [{ name: plugin.package, version: '9.0.0' }, { name: 'other-plugin', version: plugin.version }]) {
    writeFileSync(path.join(moduleDir, 'package.json'), JSON.stringify(meta));
    assert.equal(isNpmPluginAlreadyInstalled(profileDir, plugin), false);
  }
});

test('shared snapshot application preserves unrelated blocks and a repeat changes no configuration', (t) => {
  const { root, profileDir, options } = fixture(t);
  writePluginBundle({ repoRoot: root, profileDir, plugin, configText: '- id: demo\n  name: demo-plugin\n  config:\n    prompt: cloud-value\n', patchId: 'demo' });
  const first = syncDshPlugins(options);
  assert.equal(first.ok, true);
  assert.equal(first.outcome, 'configured');
  assert.match(read(profileDir, 'cordis.patch.yml'), /keep: unchanged/);
  assert.match(read(profileDir, 'cordis.patch.yml'), /prompt: cloud-value/);
  const before = read(profileDir, 'cordis.patch.yml');
  const mtime = statSync(path.join(profileDir, 'cordis.patch.yml')).mtimeMs;
  const second = syncDshPlugins(options);
  assert.equal(second.changed, false);
  assert.equal(second.restartRequired, false);
  assert.equal(read(profileDir, 'cordis.patch.yml'), before);
  assert.equal(statSync(path.join(profileDir, 'cordis.patch.yml')).mtimeMs, mtime);
});

test('corrupt selected snapshot is rejected before any installation or configuration application', (t) => {
  const { root, profileDir, options } = fixture(t);
  const saved = writePluginBundle({ repoRoot: root, profileDir, plugin, configText: '- id: demo\n  config:\n    prompt: saved\n' });
  writeFileSync(path.join(saved.dir, 'config.yml'), '- id: demo\n  config:\n    prompt: tampered\n');
  const before = read(profileDir, 'package.json');
  const patch = read(profileDir, 'cordis.patch.yml');
  const declaredPlugin = { ...plugin, snapshot: `dsh-au/sync/plugins/${saved.slug}` };
  const result = syncDshPlugins({ ...options, plugins: [declaredPlugin], requireSnapshots: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SNAPSHOT_INVALID');
  assert.equal(read(profileDir, 'package.json'), before);
  assert.equal(read(profileDir, 'cordis.patch.yml'), patch);
  assert.equal(existsSync(path.join(profileDir, '.dsh-plugin-sync.lock')), false);
  assert.equal(existsSync(path.join(profileDir, '.dsh-plugin-sync.recovery.json')), false);
});

test('failed package-manager boundary restores configuration and lockfile but reports dependency side effects', (t) => {
  const { profileDir, moduleDir, options } = fixture(t);
  writeFileSync(path.join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: original\n');
  const packageBefore = read(profileDir, 'package.json');
  const patchBefore = read(profileDir, 'cordis.patch.yml');
  // The adapter represents the external package-manager boundary, using real filesystem effects.
  const result = syncDshPlugins({ ...options, installPlugin: () => {
    writeFileSync(path.join(profileDir, 'package.json'), '{}');
    writeFileSync(path.join(profileDir, 'cordis.patch.yml'), 'partial write');
    writeFileSync(path.join(profileDir, 'pnpm-lock.yaml'), 'partial lock');
    writeFileSync(path.join(moduleDir, 'external-side-effect.txt'), 'not claimed rolled back');
    return { ok: false, code: 'COMMAND_EXIT', error: 'external failure', sideEffectsPossible: true };
  } });
  assert.equal(result.ok, false);
  assert.equal(result.configRestored, true);
  assert.equal(result.recoveryRequired, true);
  assert.equal(read(profileDir, 'package.json'), packageBefore);
  assert.equal(read(profileDir, 'cordis.patch.yml'), patchBefore);
  assert.equal(read(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: original\n');
  assert.equal(existsSync(path.join(moduleDir, 'external-side-effect.txt')), true);
});

test('partial package-manager failure preserves successful plugin and records incomplete recovery', (t) => {
  const { profileDir, options } = fixture(t);
  const failed = { ...plugin, id: 'failed', package: 'failed-plugin' };
  const result = syncDshPlugins({ ...options, plugins: [plugin, failed], selectedIds: [plugin.id, failed.id],
    installPlugin: (_dir, item) => {
      if (item.id === plugin.id) return { ok: true, skipped: true };
      writeFileSync(path.join(profileDir, 'package.json'), '{}');
      writeFileSync(path.join(profileDir, 'cordis.patch.yml'), 'failed installer pollution');
      writeFileSync(path.join(profileDir, 'pnpm-lock.yaml'), 'failed lock pollution');
      return { ok: false, code: 'COMMAND_EXIT', error: 'external failure', sideEffectsPossible: true };
    } });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'partial');
  assert.equal(result.recoveryRequired, true);
  assert.deepEqual(JSON.parse(read(profileDir, 'package.json')).dsh.profile.bundles, [plugin.package]);
  assert.doesNotMatch(read(profileDir, 'cordis.patch.yml'), /- id: failed|failed installer pollution/);
  assert.match(read(profileDir, 'cordis.patch.yml'), /keep: unchanged/);
  assert.equal(existsSync(path.join(profileDir, 'pnpm-lock.yaml')), false);
});

test('declared snapshot missing entirely refuses restoration rather than silently applying defaults', (t) => {
  const { profileDir, options } = fixture(t);
  const before = read(profileDir, 'cordis.patch.yml');
  const result = syncDshPlugins({ ...options, plugins: [{ ...plugin, snapshot: 'dsh-au/sync/plugins/demo-plugin' }] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SNAPSHOT_INVALID');
  assert.equal(read(profileDir, 'cordis.patch.yml'), before);
});

test('real package-manager process corrupting package.json still reports dependency recovery risk', (t) => {
  const { root, profileDir, moduleDir, options } = fixture(t);
  const external = path.join(root, 'external-local-plugin');
  mkdirSync(external);
  writeFileSync(path.join(external, 'package.json'), '{"name":"local-plugin","version":"1.0.0"}');
  symlinkSync(external, path.join(profileDir, 'node_modules', 'local-plugin'), process.platform === 'win32' ? 'junction' : 'dir');
  const pkg = JSON.parse(read(profileDir, 'package.json'));
  pkg.dependencies['local-plugin'] = '1.0.0';
  writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(pkg));
  writeFileSync(path.join(moduleDir, 'package.json'), JSON.stringify({ name: plugin.package, version: '9.0.0' }));
  const before = read(profileDir, 'package.json');
  const pnpm = path.join(root, 'pnpm fake.cjs');
  // Real CLI boundary: version probe succeeds, installation writes partial state and exits unsuccessfully.
  writeFileSync(pnpm, `const fs = require('node:fs'); const path = require('node:path');
if (process.argv.includes('--version')) { console.log('11.28.5'); }
else { fs.writeFileSync(path.join(process.cwd(), 'node_modules', 'partial-install.txt'), 'external effect'); fs.writeFileSync(path.join(process.cwd(), 'package.json'), '{'); process.exitCode=1; }`);
  const previous = process.env.DSH_PNPM_BIN;
  process.env.DSH_PNPM_BIN = pnpm;
  t.after(() => { if (previous === undefined) delete process.env.DSH_PNPM_BIN; else process.env.DSH_PNPM_BIN = previous; });
  const result = syncDshPlugins(options);
  assert.equal(result.ok, false);
  assert.equal(result.configRestored, true);
  assert.equal(result.recoveryRequired, true);
  assert.equal(read(profileDir, 'package.json'), before);
  assert.equal(existsSync(path.join(profileDir, 'node_modules', 'partial-install.txt')), true);
});

test('worker refuses a profile locked by another entrance and leaves its owner lock intact', async (t) => {
  const { profileDir, options } = fixture(t);
  const release = acquirePluginProfileLock(profileDir);
  try {
    const result = await applyAsync({ ...options, pluginId: plugin.id, enabled: true });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'PROFILE_BUSY');
    assert.equal(existsSync(path.join(profileDir, '.dsh-plugin-sync.lock')), true);
  } finally { release(); }
  assert.equal(existsSync(path.join(profileDir, '.dsh-plugin-sync.lock')), false);
});

test('unsupported single-plugin request is skipped without enabling or touching unrelated configuration', (t) => {
  const { profileDir, options } = fixture(t);
  const before = read(profileDir, 'cordis.patch.yml');
  const result = applySingleDshPluginState({ ...options, pluginId: plugin.id, enabled: true,
    plugins: [{ ...plugin, platforms: ['unsupported-os'] }] });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'skipped');
  assert.equal(result.changed, false);
  assert.equal(read(profileDir, 'cordis.patch.yml'), before);
});

test('Doctor reports actual drift and stale recovery without exposing config or changing files', (t) => {
  const { root, profileDir, moduleDir } = fixture(t);
  writeFileSync(path.join(moduleDir, 'package.json'), JSON.stringify({ name: plugin.package, version: '9.0.0' }));
  writeFileSync(path.join(profileDir, '.dsh-plugin-sync.recovery.json'), JSON.stringify({ status: 'needs-verification' }));
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '- id: local-only\n  config:\n    token: never-output-this\n');
  const before = read(profileDir, 'cordis.patch.yml');
  const report = runPluginsDoctor({ dshHome: root, repoRoot: root, plugins: [plugin],
    runtimeOptions: { ancestorExecPaths: [], appRoots: [], pnpmCandidates: [], env: { PATH: '' }, homeDir: root } });
  assert.equal(report.plugins[0].actualVersion, '9.0.0');
  assert.ok(report.warnings.some((item) => item.code === 'VERSION_MISMATCH'));
  assert.ok(report.warnings.some((item) => item.code === 'RECOVERY_REQUIRED'));
  assert.equal(report.loadingVerified, false);
  assert.doesNotMatch(JSON.stringify(report), /never-output-this/);
  assert.equal(read(profileDir, 'cordis.patch.yml'), before);
  assert.equal(existsSync(path.join(profileDir, '.dsh-plugin-sync.recovery.json')), true);
});

test('retired cloud plugin in removedPlugins is uninstalled and cleaned idempotently without touching private plugins', (t) => {
  const { profileDir, options } = fixture(t);
  const retired = { id: 'retired-cloud', package: 'retired-cloud-plugin', patchId: 'retired-cloud', removedAt: '2026-11-13T00:00:00.000Z' };
  const privatePkg = 'local-private-plugin';

  for (const [pkgName, ver] of [[retired.package, '1.2.0'], [privatePkg, '0.5.0']]) {
    const modDir = path.join(profileDir, 'node_modules', pkgName);
    mkdirSync(modDir, { recursive: true });
    writeFileSync(path.join(modDir, 'package.json'), JSON.stringify({ name: pkgName, version: ver }));
  }

  const pkg = JSON.parse(read(profileDir, 'package.json'));
  pkg.dependencies[retired.package] = '1.2.0';
  pkg.dependencies[privatePkg] = '0.5.0';
  pkg.dsh.profile.bundles = [plugin.package, retired.package, privatePkg];
  writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(pkg, null, 2));

  writeFileSync(
    path.join(profileDir, 'cordis.patch.yml'),
    [
      '- id: local-only',
      '  config:',
      '    keep: unchanged',
      `- id: ${retired.patchId}`,
      `  name: "${retired.package}"`,
      '  config:',
      '    foo: bar',
      '- id: local-private',
      `  name: "${privatePkg}"`,
      '  config:',
      '    secret: mine',
      '',
    ].join('\n'),
  );

  const uninstalled = [];
  const uninstallPlugin = (_dir, item) => {
    uninstalled.push(item.package);
    return { ok: true };
  };

  const first = syncDshPlugins({ ...options, removedPlugins: [retired], uninstallPlugin });
  assert.equal(first.ok, true);
  assert.equal(first.anyRemoved, true);
  assert.equal(first.restartRequired, true);
  assert.deepEqual(uninstalled, [retired.package]);
  assert.ok(first.results.some((item) => item.id === retired.id && item.status === 'removed'));

  const pkgAfterFirst = JSON.parse(read(profileDir, 'package.json'));
  assert.equal(Object.hasOwn(pkgAfterFirst.dependencies, retired.package), false);
  assert.equal(pkgAfterFirst.dsh.profile.bundles.includes(retired.package), false);
  assert.equal(pkgAfterFirst.dependencies[privatePkg], '0.5.0');
  assert.equal(pkgAfterFirst.dsh.profile.bundles.includes(privatePkg), true);

  const patchAfterFirst = read(profileDir, 'cordis.patch.yml');
  assert.doesNotMatch(patchAfterFirst, /retired-cloud|foo: bar/);
  assert.match(patchAfterFirst, /local-private/);
  assert.match(patchAfterFirst, /secret: mine/);
  assert.match(patchAfterFirst, /keep: unchanged/);

  // 幂等性：再次执行不应重复调用卸载或报错，私有插件仍完好保留
  const second = syncDshPlugins({ ...options, removedPlugins: [retired], uninstallPlugin });
  assert.equal(second.ok, true);
  assert.equal(second.anyRemoved, false);
  assert.equal(second.restartRequired, false);
  assert.deepEqual(uninstalled, [retired.package]);
  assert.equal(second.results.some((item) => item.status === 'removed'), false);
  const pkgAfterSecond = JSON.parse(read(profileDir, 'package.json'));
  assert.equal(pkgAfterSecond.dependencies[privatePkg], '0.5.0');
  assert.equal(pkgAfterSecond.dsh.profile.bundles.includes(privatePkg), true);
  assert.match(read(profileDir, 'cordis.patch.yml'), /secret: mine/);
});
