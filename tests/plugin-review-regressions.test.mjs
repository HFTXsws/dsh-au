import './isolate-sync.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { syncDshPlugins } from '../lib/plugin-sync-core.js';
import { runPluginsDoctor } from '../lib/plugin-doctor.js';
import { writePluginBundle } from '../lib/plugin-bundles.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'dsh-review-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('dsh-review-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const profileDir = path.join(root, 'profiles', 'desktop');
  fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), '{}');
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '- id: keep-local\n  config:\n    keep: unchanged\n');
  return { root, profileDir };
}

test('legacy link removal followed by write failure retains dependency recovery risk', (t) => {
  const { root, profileDir } = fixture(t);
  const owner = { id: 'dsh-au', package: 'dsh-au', version: '0.1.0', source: 'local' };
  const repositoryPlugin = fileURLToPath(new URL('..', import.meta.url));
  fs.symlinkSync(repositoryPlugin, path.join(profileDir, 'node_modules', 'dsh-au'), process.platform === 'win32' ? 'junction' : 'dir');
  const oldTarget = path.join(root, 'retired-plugin');
  fs.mkdirSync(oldTarget);
  const oldLink = path.join(profileDir, 'node_modules', 'dsh-au-todo');
  fs.symlinkSync(oldTarget, oldLink, process.platform === 'win32' ? 'junction' : 'dir');
  const original = JSON.stringify({ dependencies: { 'dsh-au': '0.1.0', 'dsh-au-todo': '0.1.0' }, dsh: { profile: { bundles: ['dsh-au', 'dsh-au-todo'] } } });
  fs.writeFileSync(path.join(profileDir, 'package.json'), original);
  const mapPath = path.join(profileDir, 'node_modules', '.package-map.json');
  fs.writeFileSync(mapPath, JSON.stringify({ packages: { 'dsh-au-todo': {} } }));
  const originalWrite = fs.writeFileSync;
  // Only the filesystem failure boundary is substituted; junction removal and transaction recovery stay real.
  const failure = t.mock.method(fs, 'writeFileSync', (target, ...args) => {
    if (typeof target === 'string' && path.resolve(target) === mapPath) throw Object.assign(new Error('map write denied'), { code: 'EACCES' });
    return originalWrite(target, ...args);
  });
  syncBuiltinESMExports();
  let result;
  try {
    result = syncDshPlugins({ dshHome: root, bundleRepoRoot: root, plugins: [owner], selectedIds: [owner.id] });
  } finally {
    failure.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(result.ok, false);
  assert.equal(result.configRestored, true);
  assert.equal(result.recoveryRequired, true);
  assert.equal(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'), original);
  assert.equal(fs.existsSync(oldLink), false);
  assert.equal(fs.existsSync(oldTarget), true);
});

test('Doctor and sync both reject wrong declared snapshot ownership despite a valid package snapshot', (t) => {
  const { root, profileDir } = fixture(t);
  const plugin = { id: 'demo', package: 'demo-plugin', version: '1.0.0', source: 'npm', snapshot: 'dsh-au/sync/plugins/other-plugin' };
  writePluginBundle({ repoRoot: root, profileDir, plugin, configText: '- id: demo\n  config:\n    value: unchanged\n' });
  const before = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
  const diagnosis = runPluginsDoctor({ dshHome: root, repoRoot: root, plugins: [plugin],
    runtimeOptions: { ancestorExecPaths: [], appRoots: [], env: { PATH: '' }, homeDir: root } });
  const sync = syncDshPlugins({ dshHome: root, bundleRepoRoot: root, plugins: [plugin], selectedIds: [plugin.id] });
  assert.equal(diagnosis.ok, false);
  assert.ok(diagnosis.errors.some((issue) => issue.code === 'SNAPSHOT_MISSING_OR_MISMATCHED'));
  assert.equal(sync.ok, false);
  assert.equal(sync.code, 'SNAPSHOT_INVALID');
  assert.equal(fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8'), before);
});
