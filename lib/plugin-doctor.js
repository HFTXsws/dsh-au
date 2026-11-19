import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { readCloudPlugins } from './cloud-manifest.js';
import { getRepoRoot, resolvePluginBundlesDir } from './sync-repo.js';
import { pluginBundleSlug, readPluginBundles } from './plugin-bundles.js';
import { readPluginProfileState } from './plugin-profile-state.js';
import { resolvePluginRuntime } from './plugin-runtime.js';

/** 只读插件体检：不安装、不修改锁/配置、不启动服务、不输出 patch 或凭据内容。 */
export function runPluginsDoctor({ dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh'), profile = 'desktop',
  repoRoot = getRepoRoot(), plugins = readCloudPlugins(), runtimeOptions = {} } = {}) {
  const profileDir = path.resolve(dshHome, 'profiles', profile);
  const errors = [];
  const warnings = [];
  let pkg = {};
  try { pkg = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8')); }
  catch { errors.push({ code: 'PROFILE_MISSING_OR_INVALID', message: 'Profile package.json 不存在或无法解析' }); }
  const state = readPluginProfileState(profileDir);
  if (state.lock) errors.push({ code: 'PROFILE_BUSY', message: state.lock.alive ? 'Profile 有未释放的变更锁；进程仍存活不证明原工作线程仍在执行，请核实任务状态' : 'Profile 存在中断遗留锁，请先核实原任务已退出；Doctor 不擅自清锁' });
  if (state.recovery) warnings.push({ code: 'RECOVERY_REQUIRED', message: '上一轮安装中断或未完整成功；配置恢复不代表 node_modules/store 已回滚' });
  const snapshots = readPluginBundles(repoRoot);
  errors.push(...(snapshots.errors || []).map((issue) => ({ code: issue.code, package: issue.package, message: issue.message })));
  warnings.push(...(snapshots.warnings || []).map((issue) => ({ code: issue.code, package: issue.package, message: issue.message })));
  const runtime = resolvePluginRuntime({ ...runtimeOptions, profileDir });
  if (!runtime.ok) errors.push({ code: runtime.code, message: runtime.error });
  const installed = [];
  for (const plugin of plugins) {
    const packageName = plugin.package;
    if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(packageName || '')) {
      errors.push({ code: 'PLUGIN_PACKAGE_INVALID', message: '云定义含非法包名' }); continue;
    }
    const requestedSpec = pkg.dependencies?.[packageName] || '';
    let actual;
    try { actual = JSON.parse(readFileSync(path.join(profileDir, 'node_modules', ...packageName.split('/'), 'package.json'), 'utf8')); } catch { /* 未安装或损坏明确列出。 */ }
    const snapshot = snapshots.byPackage.get(packageName)?.manifest;
    const expected = snapshot?.requestedSpec === plugin.version ? snapshot.version : plugin.version;
    const validPackage = actual?.name === packageName && typeof actual?.version === 'string';
    const enabled = Array.isArray(pkg.dsh?.profile?.bundles) && pkg.dsh.profile.bundles.includes(packageName);
    installed.push({ id: plugin.id, package: packageName, requestedSpec, actualVersion: validPackage ? actual.version : '',
      expectedVersion: expected || '', installed: validPackage, declaredEnabled: enabled, loadingVerified: false, source: plugin.source || 'npm' });
    if (requestedSpec && !validPackage) errors.push({ code: 'INSTALLED_PACKAGE_INVALID', package: packageName, message: '已有依赖声明，但实际包缺失、损坏或包名不符' });
    if (validPackage && expected && actual.version !== expected) warnings.push({ code: 'VERSION_MISMATCH', package: packageName, message: `实际 ${actual.version} 与云快照 ${expected} 不一致` });
    if (plugin.source !== 'local' && expected && !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(expected)) {
      warnings.push({ code: 'VERSION_NOT_PINNED', package: packageName, message: '云版本不是精确版本，请从已安装的来源电脑重新同步快照' });
    }
    if (plugin.snapshot) {
      // 按仓库实际布局解析快照目录（dsh-sync/plugins 或旧 dsh-au/sync/plugins），不再写死旧路径。
      const expectedDir = path.resolve(resolvePluginBundlesDir(repoRoot), pluginBundleSlug(packageName));
      const saved = snapshots.byPackage.get(packageName);
      if (path.resolve(repoRoot, plugin.snapshot) !== expectedDir || !saved || path.resolve(saved.dir) !== expectedDir) {
        errors.push({ code: 'SNAPSHOT_MISSING_OR_MISMATCHED', package: packageName, message: '云清单声明的快照缺失或路径归属不符，同步会拒绝使用默认配置替代' });
      }
    }
  }
  return { ok: errors.length === 0, profileDir, runtime, state, plugins: installed, errors, warnings,
    loadingVerified: false, note: '只读检查不证明真实安装、重启加载或其它系统实机验收' };
}
