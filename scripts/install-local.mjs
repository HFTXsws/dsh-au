#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, normalizeRemote, saveConfig } from '../lib/config-store.js';
import { installClientControlShims } from '../lib/client-control/install-shim.js';
import { cleanupLegacyPlugins } from '../lib/legacy-cleanup.js';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const profileName = process.argv.includes('--profile')
  ? (process.argv[process.argv.indexOf('--profile') + 1] || 'desktop')
  : 'desktop';
if (!/^[A-Za-z0-9._-]{1,80}$/.test(profileName) || /^\.+$/.test(profileName)) {
  console.error('[dsh-au] DSH profile 名称只允许字母、数字、点、下划线和连字符');
  process.exit(1);
}
const refreshShimsOnly = process.argv.includes('--refresh-shims-only');
const profileDir = join(dshHome, 'profiles', profileName);
const pkgJsonPath = join(profileDir, 'package.json');
const nodeModulesDir = join(profileDir, 'node_modules');
const targetLink = join(nodeModulesDir, 'dsh-au');

if (!existsSync(pkgJsonPath)) {
  console.error(`[dsh-au] 未找到 DSH profile 配置: ${pkgJsonPath}`);
  process.exit(1);
}

mkdirSync(nodeModulesDir, { recursive: true });
if (refreshShimsOnly) {
  let mounted = false;
  try {
    const actual = realpathSync(targetLink);
    const expected = realpathSync(pluginRoot);
    mounted = process.platform === 'win32'
      ? actual.toLowerCase() === expected.toLowerCase()
      : actual === expected;
  } catch {}
  if (!mounted) {
    console.error(`[dsh-au] 无法原地刷新：现有挂载未指向 ${pluginRoot}`);
    process.exit(1);
  }
} else {
  try {
    if (existsSync(targetLink) || lstatSync(targetLink)) {
      rmSync(targetLink, { recursive: true, force: true });
    }
  } catch {}
  // Windows 使用 junction（无需管理员权限），macOS/Linux 使用 dir 软链。
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(pluginRoot, targetLink, linkType);
}
const clientControlShims = installClientControlShims({
  binDir: join(nodeModulesDir, '.bin'),
  packageDir: targetLink,
  nodePath: process.execPath,
  platform: process.platform,
  profile: profileName,
});
if (refreshShimsOnly) {
  console.log(`[dsh-au] 已刷新现有挂载 ${profileDir}`);
  console.log(`[dsh-au] Agent 客户端控制入口: ${clientControlShims.join(', ')}`);
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
const pluginVersion = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')).version;
pkg.dependencies = { ...(pkg.dependencies || {}), 'dsh-au': pluginVersion };
const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
if (!bundles.includes('dsh-au')) bundles.push('dsh-au');
pkg.dsh = { ...(pkg.dsh || {}), profile: { ...(pkg.dsh?.profile || {}), bundles } };
writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

const pkgMapPath = join(nodeModulesDir, '.package-map.json');
if (existsSync(pkgMapPath)) {
  try {
    const map = JSON.parse(readFileSync(pkgMapPath, 'utf8'));
    if (map?.packages?.['.']?.dependencies) map.packages['.'].dependencies['dsh-au'] = 'dsh-au';
    if (map?.packages) {
      map.packages['dsh-au'] = { url: './dsh-au', dependencies: { 'dsh-au': 'dsh-au' } };
    }
    writeFileSync(pkgMapPath, JSON.stringify(map), 'utf8');
  } catch {}
}

// 待办面板与移动端抽屉已并入 dsh-au；旧的独立挂载留着会重复加载，这里一并清掉。
const legacy = cleanupLegacyPlugins({ profileDir });
if (legacy.changed) console.log(`[dsh-au] 已清理并入主插件的旧挂载：${legacy.summary.join('、')}`);
for (const warning of legacy.warnings) console.warn(`[dsh-au] ${warning}`);

const cfg = loadConfig();
saveConfig(cfg);
console.log(`[dsh-au] 已挂载到 ${profileDir}`);
console.log(`[dsh-au] Agent 客户端控制入口: ${clientControlShims.join(', ')}`);
console.log(`[dsh-au] 配置文件路径: ${join(dshHome, 'dsh-au.config.json')}`);
