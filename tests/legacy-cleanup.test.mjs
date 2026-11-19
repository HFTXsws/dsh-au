import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupLegacyPlugins, stripPatchBlocks } from '../lib/legacy-cleanup.js';
import { installLocalPlugin } from '../lib/plugin-sync-core.js';

const installScript = fileURLToPath(new URL('../scripts/install-local.mjs', import.meta.url));
const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

const PATCH = [
  '- id: dsh-au',
  '  name: "dsh-au"',
  '- id: dsh-au-todo',
  '  disabled: false',
  '  options:',
  '    a: 1',
  "- id: 'dsh-au-mobile'",
  '  disabled: false',
  '# 注释行必须保留',
  '- id: other-plugin',
  '  disabled: false',
  '',
].join('\n');

function makeProfile({ withMobileAsRealDir = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-au-legacy-'));
  const profileDir = join(root, 'profiles', 'desktop');
  const nodeModules = join(profileDir, 'node_modules');
  mkdirSync(nodeModules, { recursive: true });
  const target = join(root, 'repo-copy');
  mkdirSync(target);
  symlinkSync(target, join(nodeModules, 'dsh-au'), LINK_TYPE);
  symlinkSync(target, join(nodeModules, 'dsh-au-todo'), LINK_TYPE);
  if (withMobileAsRealDir) mkdirSync(join(nodeModules, 'dsh-au-mobile'));
  else symlinkSync(target, join(nodeModules, 'dsh-au-mobile'), LINK_TYPE);
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    dependencies: { 'dsh-au': '0.1.0', 'dsh-au-todo': '0.1.0', 'dsh-au-mobile': '0.1.0', 'other-plugin': '1.0.0' },
    dsh: { profile: { bundles: ['dsh-au', 'dsh-au-mobile', 'dsh-au-todo', 'other-plugin'] } },
  }, null, 2));
  writeFileSync(join(nodeModules, '.package-map.json'), JSON.stringify({
    packages: {
      '.': { dependencies: { 'dsh-au': 'dsh-au', 'dsh-au-todo': 'dsh-au-todo', 'dsh-au-mobile': 'dsh-au-mobile' } },
      'dsh-au': { url: './dsh-au' },
      'dsh-au-todo': { url: './dsh-au-todo' },
      'dsh-au-mobile': { url: './dsh-au-mobile' },
    },
  }));
  writeFileSync(join(profileDir, 'cordis.patch.yml'), PATCH);
  return { root, profileDir, nodeModules };
}

test('stripPatchBlocks 只删旧插件整块，保留其他块、注释和换行风格', () => {
  const out = stripPatchBlocks(PATCH);
  assert.equal(out, ['- id: dsh-au', '  name: "dsh-au"', '# 注释行必须保留', '- id: other-plugin', '  disabled: false', ''].join('\n'));
  assert.equal(stripPatchBlocks(out), out);
  const crlf = PATCH.replace(/\n/g, '\r\n');
  const crlfOut = stripPatchBlocks(crlf);
  assert.ok(crlfOut.includes('\r\n') && !crlfOut.replace(/\r\n/g, '').includes('\n'));
  assert.ok(!/dsh-au-(todo|mobile)/.test(crlfOut));
});

test('stripPatchBlocks 没有旧插件块时原样返回，不把混合行尾统一成 CRLF', () => {
  // 回归：Windows autocrlf 检出的 CRLF 快照 + 还原脚本用 LF 追加的公共段。
  const mixed = '- id: dsh-au\r\n  disabled: false\n\n# Common\r\n- id: dsh-continue\n';
  assert.equal(stripPatchBlocks(mixed), mixed);
});

test('cleanupLegacyPlugins 清掉软链、依赖、bundles、包映射和 patch 块，且可重复执行', () => {
  const { root, profileDir, nodeModules } = makeProfile();
  try {
    const first = cleanupLegacyPlugins({ profileDir });
    assert.equal(first.changed, true);
    assert.equal(existsSync(join(nodeModules, 'dsh-au-todo')), false);
    assert.equal(existsSync(join(nodeModules, 'dsh-au-mobile')), false);
    assert.ok(lstatSync(join(nodeModules, 'dsh-au')).isSymbolicLink(), '主插件软链不能被动');

    const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['dsh-au', 'other-plugin']);
    assert.deepEqual(pkg.dsh.profile.bundles, ['dsh-au', 'other-plugin']);

    const map = JSON.parse(readFileSync(join(nodeModules, '.package-map.json'), 'utf8'));
    assert.deepEqual(Object.keys(map.packages).sort(), ['.', 'dsh-au']);
    assert.deepEqual(Object.keys(map.packages['.'].dependencies), ['dsh-au']);

    const patch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8');
    assert.ok(patch.includes('- id: other-plugin') && patch.includes('# 注释行必须保留'));
    assert.ok(!/dsh-au-(todo|mobile)/.test(patch));

    const second = cleanupLegacyPlugins({ profileDir });
    assert.equal(second.changed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cleanupLegacyPlugins 遇到真实目录只提示不删除', () => {
  const { root, profileDir, nodeModules } = makeProfile({ withMobileAsRealDir: true });
  try {
    const result = cleanupLegacyPlugins({ profileDir });
    assert.ok(existsSync(join(nodeModules, 'dsh-au-mobile')));
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /dsh-au-mobile/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('全新 profile（没有任何旧挂载）不产生改动', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-au-legacy-'));
  const profileDir = join(root, 'profiles', 'desktop');
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true });
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-au': '0.1.0' }, dsh: { profile: { bundles: ['dsh-au'] } } }));
  try {
    assert.deepEqual(cleanupLegacyPlugins({ profileDir }), { changed: false, summary: [], warnings: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('云同步升级已挂载的 dsh-au 时原地补齐命令 shim', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-au-refresh-mounted-'));
  const profileDir = join(root, 'profiles', 'desktop');
  const nodeModules = join(profileDir, 'node_modules');
  const targetLink = join(nodeModules, 'dsh-au');
  mkdirSync(nodeModules, { recursive: true });
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    dependencies: { 'dsh-au': '0.1.0' },
    dsh: { profile: { bundles: ['dsh-au'] } },
  }, null, 2));
  symlinkSync(pluginRoot, targetLink, LINK_TYPE);
  try {
    const before = realpathSync(targetLink);
    const shim = join(nodeModules, '.bin', process.platform === 'win32'
      ? 'dsh-au-client-control.cmd'
      : 'dsh-au-client-control');
    assert.equal(existsSync(shim), false);

    const result = installLocalPlugin(profileDir, root, { id: 'dsh-au', package: 'dsh-au' });
    assert.equal(result.ok, true);
    assert.equal(result.refreshed, true);
    assert.equal(realpathSync(targetLink), before);
    assert.equal(existsSync(shim), true);
    // The parent cloud-sync transaction updates package.json after this installer returns.
    assert.equal(JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dependencies['dsh-au'], '0.1.0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('install-local 挂载 dsh-au 的同时清理旧的 todo / mobile 挂载', () => {
  const { root, profileDir, nodeModules } = makeProfile();
  try {
    const stdout = execFileSync(process.execPath, [installScript], {
      encoding: 'utf8',
      env: { ...process.env, DSH_HOME: root },
    });
    assert.match(stdout, /已清理并入主插件的旧挂载/);
    assert.ok(lstatSync(join(nodeModules, 'dsh-au')).isSymbolicLink());
    assert.equal(existsSync(join(nodeModules, 'dsh-au-todo')), false);
    assert.equal(existsSync(join(nodeModules, 'dsh-au-mobile')), false);
    const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
    assert.deepEqual(pkg.dsh.profile.bundles, ['dsh-au', 'other-plugin']);
    const pluginVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    assert.equal(pkg.dependencies['dsh-au'], pluginVersion);
    assert.ok(!('dsh-au-todo' in pkg.dependencies));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
