import './isolate-sync.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { getLocalDshPluginInventory } from '../lib/config-store.js';
import { readPluginBundles, resolvePluginBundleDir, writePluginBundle } from '../lib/plugin-bundles.js';

const PACKAGE = '@example/snapshot';
const CONFIG = '- id: snapshot\n  config:\n    retries: 3\n';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-au-snapshot-integrity-'));
  t.after(() => {
    // Only remove the exact absolute temporary directory created by this fixture.
    assert.equal(resolve(root), root);
    rmSync(root, { recursive: true, force: true });
  });
  const dshHome = join(root, 'dsh');
  const profileDir = join(dshHome, 'profiles', 'desktop');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    dependencies: { [PACKAGE]: '^1.1.2' },
    dsh: { profile: { bundles: [PACKAGE] } },
  }));
  const repoRoot = join(root, 'repo');
  const write = (options = {}) => writePluginBundle({
    repoRoot, profileDir, plugin: { package: PACKAGE, version: '^1.1.2', enabled: true },
    configText: CONFIG, patchId: 'snapshot', ...options,
  });
  return { root, dshHome, profileDir, repoRoot, write };
}

function installMeta(profileDir, packageName = PACKAGE, version = '1.4.0') {
  const dir = join(profileDir, 'node_modules', packageName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: packageName, version, license: 'MIT' }));
}

function legacySnapshot(repoRoot, manifest, configText) {
  const dir = resolvePluginBundleDir(repoRoot, manifest.package || PACKAGE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest));
  if (configText !== undefined) writeFileSync(join(dir, 'config.yml'), configText);
  return dir;
}

test('empty re-export removes generated config and preserves unrelated files', (t) => {
  const f = fixture(t);
  const first = f.write();
  const notes = join(first.dir, 'notes.txt');
  writeFileSync(notes, 'independent content');
  const second = f.write({ configText: '' });
  assert.equal(existsSync(join(first.dir, 'config.yml')), false);
  assert.equal(readFileSync(notes, 'utf8'), 'independent content');
  assert.equal(second.manifest.hasConfig, false);
  assert.equal(second.manifest.configHash, undefined);
  assert.deepEqual(second.files, ['plugin.json', 'README.md']);
  const read = readPluginBundles(f.repoRoot);
  assert.equal(read.ok, true);
  assert.equal(read.byPackage.get(PACKAGE).configText, '');
});

test('hasConfig false ignores stale configuration without reading or restoring it', (t) => {
  const f = fixture(t);
  legacySnapshot(f.repoRoot, { package: PACKAGE, hasConfig: false }, CONFIG);
  const read = readPluginBundles(f.repoRoot);
  assert.equal(read.byPackage.get(PACKAGE).configText, '');
  assert.equal(read.errors.length, 0);
  assert.ok(read.warnings.some((warning) => warning.code === 'STALE_CONFIG_IGNORED'));
});

test('hash is calculated from exported portable bytes and detects tampering', (t) => {
  const f = fixture(t);
  const written = f.write({ configText: '- id: snapshot\n  config:\n    path: /home/alice/.dsh/helper.mjs\n', homeDir: '/home/alice' });
  const configPath = join(written.dir, 'config.yml');
  const bytes = readFileSync(configPath);
  assert.match(bytes.toString(), /~\/\.dsh\/helper\.mjs/);
  assert.equal(written.manifest.configHash, createHash('sha256').update(bytes).digest('hex'));
  writeFileSync(configPath, CONFIG);
  assert.throws(() => f.write({ configText: '' }), /修改|删除/);
  assert.equal(readFileSync(configPath, 'utf8'), CONFIG);
  const read = readPluginBundles(f.repoRoot);
  assert.equal(read.ok, false);
  assert.equal(read.byPackage.has(PACKAGE), false);
  assert.ok(read.errors.some((error) => error.code === 'CONFIG_HASH_MISMATCH' && error.package === PACKAGE));
});

test('required missing config is an error, never an empty usable bundle', (t) => {
  const f = fixture(t);
  const dir = legacySnapshot(f.repoRoot, { package: PACKAGE, hasConfig: true });
  const read = readPluginBundles(f.repoRoot);
  assert.equal(read.ok, false);
  assert.equal(read.byPackage.has(PACKAGE), false);
  assert.ok(read.errors.some((error) => error.code === 'CONFIG_MISSING' && error.dir === dir));
});

test('legacy config without hash remains readable with an explicit warning', (t) => {
  const f = fixture(t);
  legacySnapshot(f.repoRoot, { schemaVersion: 1, package: PACKAGE, hasConfig: true }, CONFIG);
  const read = readPluginBundles(f.repoRoot);
  assert.equal(read.ok, true);
  assert.equal(read.byPackage.get(PACKAGE).configText, CONFIG);
  assert.ok(read.warnings.some((warning) => warning.code === 'LEGACY_CONFIG_NO_HASH'));
});

test('legacy manifest without hasConfig infers config with a warning', (t) => {
  const f = fixture(t);
  legacySnapshot(f.repoRoot, { package: PACKAGE }, CONFIG);
  const read = readPluginBundles(f.repoRoot);
  assert.equal(read.ok, true);
  assert.equal(read.byPackage.get(PACKAGE).configText, CONFIG);
  assert.ok(read.warnings.some((warning) => warning.code === 'LEGACY_HAS_CONFIG'));
});

test('bad JSON and missing manifest report explicit diagnostics with paths', (t) => {
  const f = fixture(t);
  const brokenDir = legacySnapshot(f.repoRoot, { package: PACKAGE });
  writeFileSync(join(brokenDir, 'plugin.json'), '{broken');
  const missingDir = join(resolvePluginBundleDir(f.repoRoot, PACKAGE), '..', 'missing');
  mkdirSync(missingDir, { recursive: true });
  const read = readPluginBundles(f.repoRoot);
  assert.equal(read.ok, false);
  assert.equal(read.byPackage.size, 0);
  assert.ok(read.errors.some((error) => error.code === 'MANIFEST_INVALID_JSON' && error.path === join(brokenDir, 'plugin.json')));
  assert.ok(read.errors.some((error) => error.code === 'MANIFEST_MISSING' && error.dir === missingDir));
});

test('installed version and requested range remain separate in snapshot and inventory', (t) => {
  const f = fixture(t);
  installMeta(f.profileDir);
  const written = f.write();
  assert.equal(written.manifest.version, '1.4.0');
  assert.equal(written.manifest.source.ref, '1.4.0');
  assert.equal(written.manifest.requestedSpec, '^1.1.2');
  const item = getLocalDshPluginInventory('desktop', f.dshHome)[0];
  assert.equal(item.version, '1.4.0');
  assert.equal(item.requestedSpec, '^1.1.2');
  assert.equal(item.installedVersion, '1.4.0');
  assert.equal(item.installed, true);
  assert.equal(item.installationVerified, true);
  const serialized = JSON.parse(JSON.stringify(getLocalDshPluginInventory('desktop', f.dshHome, { includeInstallFacts: true })))[0];
  assert.equal(serialized.installedVersion, '1.4.0');
  assert.equal(serialized.requestedSpec, '^1.1.2');
});

test('metadata absence retains the declared version but does not claim verified installation', (t) => {
  const f = fixture(t);
  const item = getLocalDshPluginInventory('desktop', f.dshHome)[0];
  assert.equal(item.version, '^1.1.2');
  assert.equal(item.requestedSpec, '^1.1.2');
  assert.equal(item.installedVersion, '');
  assert.equal(item.installed, false);
  assert.equal(item.installationVerified, false);
  assert.equal(Object.keys(item).includes('installed'), false);
});

test('colliding slugs cannot overwrite another package snapshot', (t) => {
  const f = fixture(t);
  const original = f.write();
  const before = readFileSync(join(original.dir, 'plugin.json'), 'utf8');
  assert.throws(() => f.write({ plugin: { package: 'example-snapshot', version: '2.0.0' }, configText: '' }), /冲突/);
  assert.equal(readFileSync(join(original.dir, 'plugin.json'), 'utf8'), before);
  assert.equal(readFileSync(join(original.dir, 'config.yml'), 'utf8'), CONFIG);
});

test('unowned config is retained on a first empty export', (t) => {
  const f = fixture(t);
  const dir = resolvePluginBundleDir(f.repoRoot, PACKAGE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yml'), 'independent content');
  f.write({ configText: '' });
  assert.equal(readFileSync(join(dir, 'config.yml'), 'utf8'), 'independent content');
  assert.equal(readPluginBundles(f.repoRoot).byPackage.get(PACKAGE).configText, '');
});

test('manifest commits last and failed writes clean up only their temporary files', (t) => {
  const f = fixture(t);
  const original = f.write();
  const before = readFileSync(join(original.dir, 'plugin.json'), 'utf8');
  const readme = join(original.dir, 'README.md');
  assert.equal(resolve(readme), readme);
  rmSync(readme);
  mkdirSync(readme);
  assert.throws(() => f.write({ configText: '- id: snapshot\n  config:\n    retries: 9\n' }));
  assert.equal(readFileSync(join(original.dir, 'plugin.json'), 'utf8'), before);
  assert.equal(readdirSync(original.dir).some((name) => name.endsWith('.tmp')), false);
  // A partially committed config must fail integrity checks, not fall back to defaults.
  assert.equal(readPluginBundles(f.repoRoot).ok, false);
});

test('snapshot directory links cannot redirect deletion outside the repository', (t) => {
  const f = fixture(t);
  const outside = join(f.root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'plugin.json'), JSON.stringify({ package: PACKAGE, hasConfig: true }));
  writeFileSync(join(outside, 'config.yml'), CONFIG);
  const dir = resolvePluginBundleDir(f.repoRoot, PACKAGE);
  mkdirSync(join(dir, '..'), { recursive: true });
  symlinkSync(outside, dir, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.write({ configText: '' }), /路径|链接/);
  assert.equal(readFileSync(join(outside, 'config.yml'), 'utf8'), CONFIG);
});

test('dot package names are rejected instead of escaping the snapshot scope', (t) => {
  const f = fixture(t);
  assert.throws(() => f.write({ plugin: { package: '..' }, configText: '' }), /包名|路径/);
  assert.equal(existsSync(join(f.repoRoot, 'dsh-au', 'sync', 'plugin.json')), false);
});

test('duplicate package manifests are invalid regardless of directory iteration order', (t) => {
  const f = fixture(t);
  f.write();
  const duplicate = join(resolvePluginBundleDir(f.repoRoot, PACKAGE), '..', 'duplicate');
  mkdirSync(duplicate, { recursive: true });
  writeFileSync(join(duplicate, 'plugin.json'), JSON.stringify({ package: PACKAGE, hasConfig: false }));
  const read = readPluginBundles(f.repoRoot);
  assert.equal(read.ok, false);
  assert.equal(read.byPackage.has(PACKAGE), false);
  assert.ok(read.errors.some((error) => error.code === 'DUPLICATE_PACKAGE'));
});

// Inventory must not read or update the user's cloud catalog while these tests run.
const originalCloud = process.env.DSH_AU_CLOUD_MANIFEST_PATH;
const cloudRoot = mkdtempSync(join(tmpdir(), 'dsh-au-snapshot-cloud-'));
process.env.DSH_AU_CLOUD_MANIFEST_PATH = join(cloudRoot, 'manifest.cloud.json');
test.after(() => {
  if (originalCloud === undefined) delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
  else process.env.DSH_AU_CLOUD_MANIFEST_PATH = originalCloud;
  assert.equal(resolve(cloudRoot), cloudRoot);
  rmSync(cloudRoot, { recursive: true, force: true });
});

// Deliberately use a missing isolated cloud catalog: reads are harmless and no cloud writes are needed.
assert.equal(existsSync(process.env.DSH_AU_CLOUD_MANIFEST_PATH), false);
