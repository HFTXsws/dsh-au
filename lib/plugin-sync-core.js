#!/usr/bin/env node
/**
 * 将云清单（sync/cloud/manifest.cloud.json）里的 DSH 插件同步到当前电脑。
 * 插件定义来自云清单；是否启用由本机 DSH Profile 自己决定。
 */
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { getLocalDshPluginInventory, getMachineDshPluginIds, getSharedDshPlugins } from './config-store.js';
import { expandPortableConfigPaths, pluginBundleSlug, readPluginBundles, writePluginBundle } from './plugin-bundles.js';
import { cleanupLegacyPlugins } from './legacy-cleanup.js';
import { acquirePluginProfileLock, readPluginProfileState, recordPluginRecovery, restorePluginProfile, snapshotPluginProfile, writePluginProfileText } from './plugin-profile-state.js';
import { resolvePluginNode, resolvePluginRuntime, runPluginCommand } from './plugin-runtime.js';
import { resolveExternalPluginLink } from './plugin-links.js';
import { PLUGIN_ROOT, getRepoRoot, resolvePluginBundlesDir } from './sync-repo.js';

export const repoRoot = PLUGIN_ROOT;
const args = process.argv.slice(2);
const option = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] || fallback) : fallback;
};

/**
 * 基于云清单计算本机最终插件计划：本机 Profile 决定是否启用，DSH 方案决定是否适用。
 * profile-managed 条目（如 ACP）只由对应方案的还原流程处理，避免孤立开关破坏模型默认值。
 */
export function buildPluginSyncPlan(plugins, enabledIds, platform = process.platform, dshProfile = '') {
  const selected = new Set(enabledIds);
  return plugins.map((plugin) => ({
    ...plugin,
    enabled: selected.has(plugin.id),
    supported: !Array.isArray(plugin.platforms) || plugin.platforms.includes(platform),
    profileSupported: !plugin.requiresDshProfile || plugin.requiresDshProfile === dshProfile,
    profileManaged: plugin.activation === 'profile-managed',
  }));
}

/** 指定 DSH 方案的 profile-managed 插件必须在该电脑清单中被明确选中。 */
export function validateDshProfilePluginSelection(plugins, enabledIds, dshProfile) {
  const selected = new Set(enabledIds);
  const missing = plugins.filter((plugin) =>
    plugin.activation === 'profile-managed'
      && plugin.requiresDshProfile === dshProfile
      && !selected.has(plugin.id),
  );
  return missing.length === 0
    ? { ok: true }
    : { ok: false, missing, error: `${dshProfile} 方案依赖已取消选择的插件：${missing.map((plugin) => plugin.name).join('、')}` };
}

/** 将一个普通插件的开关写入 DSH patch，保留已有 config 块和其他插件内容。 */
export function setPatchPluginDisabled(patchText, plugin, disabled) {
  const escapedId = plugin.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = new RegExp(`(^- id: ${escapedId}\\r?\\n)([\\s\\S]*?)(?=^- id: |(?![\\s\\S]))`, 'm');
  const match = patchText.match(block);
  if (!match) {
    const suffix = `${patchText.endsWith('\n') ? '' : '\n'}- id: ${plugin.id}\n  name: ${JSON.stringify(plugin.package)}\n  disabled: ${disabled}\n`;
    return `${patchText}${suffix}`;
  }
  const head = match[1];
  const body = match[2];
  // 行尾不能用 \s*：它会吞掉 LF，令相邻的 YAML `- id` 拼到 disabled 值后面。
  const disabledLine = /^  disabled:[ \t]*(?:true|false)[ \t]*(\r?)$/m;
  const nextBody = disabledLine.test(body)
    ? body.replace(disabledLine, (_line, carriageReturn) => `  disabled: ${disabled}${carriageReturn}`)
    : `  disabled: ${disabled}\n${body}`;
  return `${patchText.slice(0, match.index)}${head}${nextBody}${patchText.slice(match.index + match[0].length)}`;
}

/** 公共 host-plane patch 里的 `- id` 块；不含路径，只按 id 覆盖本机同名条目。 */
export function extractTopLevelPatchBlocks(text) {
  const blocks = [];
  let current = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const idMatch = line.match(/^- id: (.+)$/);
    if (idMatch) {
      if (current) blocks.push(current);
      current = { id: idMatch[1].trim(), lines: [line] };
      continue;
    }
    // 顶层 0 缩进的 # 注释属于文件/分段头，不能拼到上一个插件块末尾。
    if (/^#/.test(line)) continue;
    if (current) current.lines.push(line);
  }
  if (current) blocks.push(current);
  // 顶层 `- id` 才开新块；缩进的规则 id 必须留在当前插件配置里。
  return blocks.map((block) => ({ id: block.id, text: `${block.lines.join('\n').replace(/\s+$/, '')}\n` }));
}

/** 云清单 id 可能是 weibaohui-dsh-continue，本机 patch 仍用 dsh-continue。 */
export function resolvePluginPatchId(plugin, overlayIds = []) {
  const pluginId = typeof plugin?.id === 'string' ? plugin.id : '';
  const packageName = typeof plugin?.package === 'string' ? plugin.package : '';
  if (overlayIds.includes(pluginId)) return pluginId;
  const matched = overlayIds.find((id) => pluginId === id
    || pluginId.endsWith(`-${id}`)
    || packageName === id
    || packageName.endsWith(`/${id}`));
  return matched || pluginId;
}

export function upsertPatchBlock(patchText, blockText, patchId) {
  const escapedId = String(patchId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = new RegExp(`^- id: ${escapedId}\r?\n(?:(?!^- id: )[\\s\\S])*`, 'm');
  const nextBlock = `${String(blockText).trimEnd()}\n`;
  if (block.test(patchText)) return patchText.replace(block, nextBlock);
  return `${patchText.endsWith('\n') ? patchText : `${patchText}\n`}${nextBlock}`;
}

export function removePatchBlocksByIds(patchText, matchIds) {
  const ids = new Set((Array.isArray(matchIds) ? matchIds : [matchIds]).filter((v) => typeof v === 'string' && v.trim()));
  if (ids.size === 0 || !patchText) return patchText;
  const eol = patchText.includes('\r\n') ? '\r\n' : '\n';
  let next = patchText.replace(/\r\n/g, '\n');
  let changed = false;
  for (const id of ids) {
    const escapedId = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const blockRe = new RegExp(`^- id: ${escapedId}\\n(?:(?!^- id: |^#)[\\s\\S])*`, 'm');
    if (blockRe.test(next)) {
      next = next.replace(blockRe, '');
      changed = true;
    }
  }
  if (!changed) return patchText;
  next = next.replace(/\n{3,}/g, '\n\n');
  return next.replace(/\n/g, eol);
}

/** 启用时用仓库公共配置覆盖本机同 id 块（自动展开 ~/ 便携路径）；停用只改 disabled，不拆已有规则。 */
export function applyPluginPatchConfig(patchText, plugin, disabled, overlayText = '', options = {}) {
  const expandedOverlay = overlayText
    ? expandPortableConfigPaths(overlayText, options.homeDir || homedir(), options.platform || process.platform)
    : '';
  const overlays = extractTopLevelPatchBlocks(expandedOverlay);
  const patchId = resolvePluginPatchId(plugin, overlays.map((item) => item.id));
  const overlay = overlays.find((item) => item.id === patchId);
  const next = overlay && !disabled
    ? upsertPatchBlock(patchText, overlay.text, patchId)
    : patchText;
  return setPatchPluginDisabled(next, { ...plugin, id: patchId }, disabled);
}

/**
 * 按备份记录的 bundleOrder 重排 profile.bundles 中受管插件的相对顺序，
 * 同时保留未出现在 bundleOrder 中的宿主固有项（如 BundlerHost）原位不变。
 */
export function applyBundleOrder(bundles = [], bundleOrder = []) {
  const current = [...new Set((Array.isArray(bundles) ? bundles : []).filter((x) => typeof x === 'string' && x.trim()))];
  const order = [...new Set((Array.isArray(bundleOrder) ? bundleOrder : []).filter((x) => typeof x === 'string' && x.trim()))];
  if (order.length === 0 || current.length <= 1) return current;
  const orderIndex = new Map(order.map((pkg, idx) => [pkg, idx]));
  const managedInCurrent = current
    .filter((pkg) => orderIndex.has(pkg))
    .sort((a, b) => orderIndex.get(a) - orderIndex.get(b));
  let cursor = 0;
  return current.map((pkg) => (orderIndex.has(pkg) ? managedInCurrent[cursor++] : pkg));
}

/** 兼容旧调用方，但运行时发现只有 plugin-runtime 一份实现。 */
export function resolveAppBundledPnpm(options = {}) {
  const runtime = resolvePluginRuntime(options);
  return runtime.ok && runtime.source === 'bundled' ? runtime.args[0] || runtime.command : '';
}

export function resolvePnpmCommand(options = {}) {
  const runtime = resolvePluginRuntime(options);
  return runtime.ok ? runtime.args[0] || runtime.command : '';
}

/** 不再用 npm exec 下载未固定版本；显式入口仍必须经过兼容核验。 */
export function buildPnpmInvocation(pnpmCommand = '') {
  if (!pnpmCommand) return null;
  const runtime = resolvePluginRuntime({ env: { ...process.env, DSH_PNPM_BIN: pnpmCommand } });
  return runtime.ok ? runtime : null;
}

export function resolvePnpmInvocation(options = {}) {
  const runtime = resolvePluginRuntime(options);
  return runtime.ok ? runtime : null;
}

/** package.json 已钉版本且 node_modules 在时不再跑 pnpm add。 */
export function isNpmPluginAlreadyInstalled(profileDir, plugin) {
  const packageName = typeof plugin?.package === 'string' ? plugin.package : '';
  if (!packageName) return false;
  const packagePath = path.join(profileDir, 'package.json');
  const modulePath = path.join(profileDir, 'node_modules', ...packageName.split('/'));
  try {
    if (!existsSync(packagePath) || !existsSync(modulePath)) return false;
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
    const declared = pkg?.dependencies?.[packageName];
    if (typeof declared !== 'string') return false;
    const installed = JSON.parse(readFileSync(path.join(modulePath, 'package.json'), 'utf8'));
    return installed.name === packageName && typeof installed.version === 'string'
      && (!plugin.version || (declared === plugin.version && installed.version === plugin.version));
  } catch {
    return false;
  }
}

/** npm 云插件默认从官方公共 registry 下载，避免桌面宿主继承的私有镜像让公开插件安装失败。 */
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org/';

/** 允许云清单为私有插件显式指定 http(s) registry；无效来源安全回退至官方公共 registry。 */
export function resolveNpmRegistry(plugin) {
  const configured = typeof plugin?.registry === 'string'
    ? plugin.registry.trim()
    : typeof plugin?.source?.registry === 'string'
      ? plugin.source.registry.trim()
      : '';
  try {
    const url = new URL(configured || DEFAULT_NPM_REGISTRY);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : DEFAULT_NPM_REGISTRY;
  } catch {
    return DEFAULT_NPM_REGISTRY;
  }
}

/** 从 @scope/package 提取 scope，供安装时覆盖继承的 scoped registry。 */
export function getNpmPackageScope(packageName) {
  const match = String(packageName || '').trim().match(/^(@[^/]+)\//);
  return match ? match[1] : '';
}

/** 构造安装参数时总是传 registry；scoped 包也必须覆盖同名 scope 的宿主配置。 */
export function buildNpmInstallArgs(plugin) {
  const spec = plugin.version ? `${plugin.package}@${plugin.version}` : plugin.package;
  const registry = resolveNpmRegistry(plugin);
  const scope = getNpmPackageScope(plugin.package);
  return [
    'add',
    '--save-exact',
    '--registry', registry,
    ...(scope ? [`--${scope}:registry=${registry}`] : []),
    spec,
  ];
}

/**
 * 找出 profile 里以软链 / junction 挂载的本地插件（如 dsh-au），返回 包名 → link: 规格。
 * 这些包不在 npm 上，pnpm add 若按 "0.1.0" 重新解析会 404，并误报 "No authorization header"。
 */
export function findLocalLinkedDependencies(profileDir) {
  const pkg = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
  const linked = {};
  for (const [name, declared] of Object.entries(pkg?.dependencies || {})) {
    if (typeof declared !== 'string' || /^(link|file|workspace):/.test(declared)) continue;
    // 普通 pnpm isolated/外置虚拟仓库的链接不是本地插件，不能改成 link:。
    const target = resolveExternalPluginLink(profileDir, name);
    if (target) linked[name] = `link:${target.split(path.sep).join('/')}`;
  }
  return linked;
}

/**
 * pnpm add 期间临时把本地软链插件写成 link: 规格，结束后恢复原值。
 * 恢复是为了不改变界面显示的版本号和其它脚本读取的 dependencies 值。
 */
export function withLocalLinkSpecs(profileDir, run) {
  const packagePath = path.join(profileDir, 'package.json');
  const linked = findLocalLinkedDependencies(profileDir);
  const names = Object.keys(linked);
  if (names.length === 0) return run();
  const original = JSON.parse(readFileSync(packagePath, 'utf8'));
  const originalSpecs = Object.fromEntries(names.map((name) => [name, original.dependencies[name]]));
  writePluginProfileText(profileDir, 'package.json', `${JSON.stringify({ ...original, dependencies: { ...original.dependencies, ...linked } }, null, 2)}\n`);
  try {
    return run();
  } finally {
    // pnpm add 会回写 package.json（新增插件），只把本地软链条目换回原值，保留新增内容。
    const after = JSON.parse(readFileSync(packagePath, 'utf8'));
    after.dependencies = { ...(after.dependencies || {}), ...originalSpecs };
    writePluginProfileText(profileDir, 'package.json', `${JSON.stringify(after, null, 2)}\n`);
  }
}

/** 从 pnpm 输出里优先挑出真正的失败原因（错误码、解析失败、请求地址），避免只截到误导性的末尾提示。 */
export function summarizePnpmFailure(output) {
  const lines = String(output || '').split(/\r?\n/).map((line) => line.replace(/^[\s│├╰─▶×]+/u, '').trim()).filter(Boolean);
  const key = lines.filter((line) => /ERR_PNPM|Failed to resolve|GET https?:\/\/|ENOTFOUND|ETIMEDOUT|ECONNRESET/.test(line));
  return [...new Set(key.length ? key : lines.slice(-2))].slice(0, 3).join(' ');
}

/** 安装 npm 云插件；已按固定版本装好时跳过，供菜单 72 复用。 */
export function installNpmPlugin(profileDir, plugin) {
  const spec = plugin.version ? `${plugin.package}@${plugin.version}` : plugin.package;
  if (process.env.DSH_PLUGIN_SYNC_SKIP_NPM === '1') return { ok: true, skipped: true };
  if (isNpmPluginAlreadyInstalled(profileDir, plugin)) return { ok: true, skipped: true };
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(plugin.version || '')) {
    return { ok: false, code: 'VERSION_NOT_PINNED', sideEffectsPossible: false, error: `安装失败: ${spec}（云快照未固定实际版本，请从已安装的来源电脑重新同步）` };
  }
  const runtime = resolvePluginRuntime({ profileDir });
  if (!runtime.ok) return { ...runtime, sideEffectsPossible: false, error: `安装失败: ${spec}：${runtime.error}` };
  // 禁止包管理器暗中切换/下载另一个版本；保留代理和 registry 的本机配置。
  const env = { ...process.env, COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_AUTO_PIN: '0', npm_config_manage_package_manager_versions: 'false' };
  const result = withLocalLinkSpecs(profileDir, () => runPluginCommand(runtime.command,
    [...runtime.args, ...buildNpmInstallArgs(plugin)], { cwd: profileDir, env }));
  if (!result.ok) {
    const detail = summarizePnpmFailure(`${result.stderr || ''}\n${result.stdout || ''}`) || result.error || result.code;
    return { ok: false, code: result.code, runtime, sideEffectsPossible: result.sideEffectsPossible, error: `安装失败: ${spec}：${detail}` };
  }
  const metaPath = path.join(profileDir, 'node_modules', ...plugin.package.split('/'), 'package.json');
  let actual;
  try { actual = JSON.parse(readFileSync(metaPath, 'utf8')); } catch { /* 下方统一给核验失败，而不是误报安装成功。 */ }
  if (actual?.name !== plugin.package || actual?.version !== plugin.version) {
    return { ok: false, code: 'INSTALL_VERIFICATION_FAILED', sideEffectsPossible: true, error: `安装器已退出，但 ${spec} 的实际包名或版本不符；请运行插件 Doctor` };
  }
  return { ok: true, runtime, sideEffectsPossible: true };
}

/** 软链已指向仓库插件目录时不再卸链，避免同步当前正在运行的 dsh-au 把工作台重载掉。 */
export function isLocalPluginAlreadyMounted(profileDir, plugin, root = repoRoot) {
  const packageName = typeof plugin?.package === 'string' ? plugin.package : '';
  if (!packageName) return false;
  const targetLink = path.join(profileDir, 'node_modules', packageName);
  const expected = packageName === 'dsh-au' ? PLUGIN_ROOT : path.join(root, packageName);
  try {
    if (!existsSync(targetLink) || !existsSync(expected)) return false;
    return realpathSync(targetLink) === realpathSync(expected);
  } catch {
    return false;
  }
}

/** 软链仓库本地插件到 profile；dsh-au 已挂载时只刷新新版本安装产物，不卸链。 */
export function installLocalPlugin(profileDir, dshHome, plugin) {
  // 云清单不记录任何本机路径；仓库自研插件以已校验的 id/package 相对仓库根定位。
  const alreadyMounted = isLocalPluginAlreadyMounted(profileDir, plugin);
  const refreshMountedDshAu = alreadyMounted && plugin.package === 'dsh-au';
  if (alreadyMounted && !refreshMountedDshAu) return { ok: true, skipped: true };
  const localRoot = plugin.package === 'dsh-au' ? PLUGIN_ROOT : getRepoRoot();
  const installer = plugin.package === 'dsh-au'
    ? path.join(PLUGIN_ROOT, 'scripts', 'install-local.mjs')
    : path.join(localRoot, plugin.package, 'scripts', 'install-local.mjs');
  if (!existsSync(installer)) return { ok: false, code: 'LOCAL_INSTALLER_MISSING', sideEffectsPossible: false, error: `找不到仓库插件安装器: ${installer}` };
  const node = resolvePluginNode();
  if (!node.ok) return { ...node, sideEffectsPossible: false };
  const args = [installer, '--profile', path.basename(profileDir),
    ...(refreshMountedDshAu ? ['--refresh-shims-only'] : [])];
  const result = runPluginCommand(node.command, args, {
    cwd: localRoot, env: { ...process.env, DSH_HOME: dshHome },
  });
  const action = refreshMountedDshAu ? '刷新' : '挂载';
  return result.ok ? { ok: true, sideEffectsPossible: true, refreshed: refreshMountedDshAu }
    : { ok: false, code: result.code, sideEffectsPossible: result.sideEffectsPossible, error: `${action}失败: ${plugin.id}：${result.error}` };
}

/** 卸载 npm 云插件；跳过或缺失 runtime 时返回状态。 */
export function uninstallNpmPlugin(profileDir, packageName) {
  if (process.env.DSH_PLUGIN_SYNC_SKIP_NPM === '1') return { ok: true, skipped: true };
  const runtime = resolvePluginRuntime({ profileDir });
  if (!runtime.ok) return { ...runtime, sideEffectsPossible: false, error: `卸载失败: ${packageName}：${runtime.error}` };
  const env = { ...process.env, COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_AUTO_PIN: '0', npm_config_manage_package_manager_versions: 'false' };
  const result = withLocalLinkSpecs(profileDir, () => runPluginCommand(runtime.command,
    [...runtime.args, 'remove', packageName], { cwd: profileDir, env }));
  if (!result.ok) {
    const detail = summarizePnpmFailure(`${result.stderr || ''}\n${result.stdout || ''}`) || result.error || result.code;
    return { ok: false, code: result.code, runtime, sideEffectsPossible: result.sideEffectsPossible, error: `卸载失败: ${packageName}：${detail}` };
  }
  return { ok: true, runtime, sideEffectsPossible: true };
}

/** 把插件包写进 profile 的 dependencies 与 bundles；供菜单 72 复用。 */
export function ensureBundle(profileDir, plugin) {
  const packagePath = path.join(profileDir, 'package.json');
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  pkg.dependencies = { ...(pkg.dependencies || {}), [plugin.package]: plugin.version || pkg.dependencies?.[plugin.package] || '*' };
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
  if (!bundles.includes(plugin.package)) bundles.push(plugin.package);
  pkg.dsh = { ...(pkg.dsh || {}), profile: { ...(pkg.dsh?.profile || {}), bundles } };
  writePluginProfileText(profileDir, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`);
}

/** 所有入口共用锁和配置恢复；失败只承诺配置恢复，不假称依赖目录已回滚。 */
export function syncDshPlugins(options) {
  if (options.dryRun) return syncDshPluginsUnlocked(options);
  const profileDir = path.join(options.dshHome, 'profiles', options.profile || 'desktop');
  if (!existsSync(path.join(profileDir, 'package.json')) || (options.applyConfiguration !== false && !existsSync(path.join(profileDir, 'cordis.patch.yml')))) {
    return { ok: false, code: 'PROFILE_MISSING', error: `未找到 DSH Desktop profile: ${profileDir}`, results: [] };
  }
  let release;
  let snapshot;
  const transaction = { sideEffectsPossible: false };
  try {
    release = acquirePluginProfileLock(profileDir);
    snapshot = snapshotPluginProfile(profileDir);
    const previousRecovery = readPluginProfileState(profileDir).recovery;
    const result = syncDshPluginsUnlocked({ ...options, transaction });
    if (!result.ok) restorePluginProfile(profileDir, snapshot);
    const changed = JSON.stringify(snapshotPluginProfile(profileDir)) !== JSON.stringify(snapshot);
    const completedIds = (result.results || []).filter((item) => ['ready', 'already-managed'].includes(item.status)).map((item) => item.id);
    const previousIds = previousRecovery?.failedPluginIds || (previousRecovery?.pluginId ? [previousRecovery.pluginId] : []);
    const unresolvedIds = previousIds.filter((id) => !completedIds.includes(id));
    const failedPluginIds = [...new Set([...unresolvedIds, ...(result.results || []).filter((item) => item.status === 'failed').map((item) => item.id)])];
    const priorUnverified = Boolean(previousRecovery) && (!previousIds.length || unresolvedIds.length > 0);
    const recoveryRequired = priorUnverified || (transaction.sideEffectsPossible && (!result.ok || Boolean(result.partialFailure)));
    recordPluginRecovery(profileDir, recoveryRequired ? { status: 'needs-verification', code: result.code || 'INSTALL_FAILED', failedPluginIds, configRestored: !result.ok } : null);
    const applied = (result.results || []).filter((item) => ['ready', 'already-managed', 'removed'].includes(item.status)).length;
    return { ...result, changed, recoveryRequired, configRestored: !result.ok, restartRequired: result.ok && (changed || Boolean(result.anyRemoved)),
      outcome: !result.ok ? 'failed' : result.partialFailure ? 'partial' : changed || applied ? 'configured' : 'skipped' };
  } catch (error) {
    let configRestored = false;
    if (snapshot) {
      try { restorePluginProfile(profileDir, snapshot); configRestored = true; } catch { /* 保留失败状态，不能宣称已恢复。 */ }
      try { recordPluginRecovery(profileDir, { status: 'needs-verification', code: error.code || 'PROFILE_WRITE_FAILED', configRestored }); } catch { /* 原始错误优先。 */ }
    }
    return { ok: false, outcome: 'failed', code: error.code || 'PROFILE_WRITE_FAILED', error: error.message, results: [], configRestored,
      recoveryRequired: Boolean(snapshot) && (transaction.sideEffectsPossible || !configRestored), restartRequired: false };
  } finally {
    if (release) release();
  }
}

/** dryRun 只计算计划；真实执行必须由上面的事务入口调用。 */
function syncDshPluginsUnlocked({
  dshHome,
  profile = 'desktop',
  dshProfile = '',
  machineName = hostname(),
  plugins = getSharedDshPlugins(),
  // 本机勾选结果可直接传入：即面板“保存”时用，不传则按本机 DSH Profile 推导。
  selectedIds = null,
  bundleOrder = [],
  dryRun = false,
  bundleRepoRoot = repoRoot,
  homeDir = homedir(),
  platform = process.platform,
  installPlugin = null,
  uninstallPlugin = null,
  removedPlugins = [],
  applyConfiguration = true,
  requireSnapshots = false,
  transaction = {},
}) {
  const profileDir = path.join(dshHome, 'profiles', profile);
  const packagePath = path.join(profileDir, 'package.json');
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  if (!existsSync(packagePath) || (applyConfiguration && !existsSync(patchPath))) {
    return { ok: false, error: `未找到 DSH Desktop profile: ${profileDir}` };
  }

  // 恢复前先在内存中备份 package.json 与 cordis.patch.yml 原文；若批量安装全部失败则无损回滚。
  const originalPackageText = readFileSync(packagePath, 'utf8');
  const originalPatchText = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
  const selected = Array.isArray(selectedIds) ? selectedIds : getMachineDshPluginIds(machineName);
  const plan = buildPluginSyncPlan(plugins, selected, platform, dshProfile);
  // 快照损坏必须在安装/清理之前拒绝，不能悄悄退回公共默认块覆盖本机。
  const bundles = readPluginBundles(bundleRepoRoot);
  // 旧云定义可保留请求范围；恢复采用同一请求范围对应的已核实快照精确版本。
  for (const plugin of plan) {
    const saved = bundles.byPackage.get(plugin.package)?.manifest;
    if (saved && saved.requestedSpec === plugin.version && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(saved.version || '')) plugin.version = saved.version;
  }
  const targets = plan.filter((item) => item.enabled && item.supported && item.profileSupported && !item.profileManaged);
  const configTargets = applyConfiguration
    ? plan.filter((item) => item.supported && item.profileSupported && !item.profileManaged)
    : [];
  const validationTargets = requireSnapshots ? configTargets : targets.filter((plugin) => plugin.snapshot);
  const snapshotErrors = (bundles.errors || []).filter((issue) => (validationTargets.length > 0 && issue.code === 'SNAPSHOT_ROOT_UNREADABLE') || validationTargets.some((plugin) => issue.package === plugin.package
    || (issue.dir && path.resolve(issue.dir) === path.resolve(resolvePluginBundlesDir(bundleRepoRoot), pluginBundleSlug(plugin.package)))));
  for (const plugin of validationTargets) {
    const expectedDir = path.resolve(resolvePluginBundlesDir(bundleRepoRoot), pluginBundleSlug(plugin.package));
    const saved = bundles.byPackage.get(plugin.package);
    if (!plugin.snapshot) {
      snapshotErrors.push({ code: 'SNAPSHOT_NOT_DECLARED', package: plugin.package,
        message: `${plugin.package} 未声明唯一云快照；未修改本机配置` });
      continue;
    }
    const declaredDir = path.resolve(bundleRepoRoot, plugin.snapshot);
    if (declaredDir !== expectedDir || !saved || path.resolve(saved.dir) !== expectedDir) {
      snapshotErrors.push({ code: 'SNAPSHOT_MISSING_OR_MISMATCHED', package: plugin.package,
        message: `${plugin.package} 声明的云快照缺失或归属不符；未修改本机配置` });
    }
  }
  if (snapshotErrors.length) {
    return { ok: false, code: 'SNAPSHOT_INVALID', error: snapshotErrors.map((issue) => issue.message).join('；'), results: [], errors: snapshotErrors };
  }

  const results = [];
  const errors = [];
  const failedPluginIds = new Set();
  let attemptedCount = 0;

  for (const plugin of plan) {
    if (!plugin.supported) {
      results.push({ id: plugin.id, status: 'skipped', reason: '当前系统不支持' });
      continue;
    }
    if (!plugin.profileSupported) {
      results.push({ id: plugin.id, status: 'skipped', reason: `不适用于 ${dshProfile || '当前'} DSH 方案` });
      continue;
    }
    if (plugin.profileManaged) {
      results.push({ id: plugin.id, status: 'profile-managed', enabled: plugin.enabled });
      continue;
    }
    if (!plugin.enabled) {
      results.push({ id: plugin.id, status: 'skipped', reason: '当前电脑未选择' });
      continue;
    }
    if (dryRun) {
      results.push({ id: plugin.id, status: 'planned', enabled: plugin.enabled });
      continue;
    }
    attemptedCount += 1;
    // 中断留下阶段标记；完成后由事务根据真实安装副作用决定是否需 Doctor 复核。
    const attemptSnapshot = snapshotPluginProfile(profileDir);
    recordPluginRecovery(profileDir, { status: 'installing', pluginId: plugin.id });
    const priorSideEffects = transaction.sideEffectsPossible;
    // 若进程收尾/JSON解析抛错，没有返回安装结果，也必须保守提示依赖副作用。
    transaction.sideEffectsPossible = true;
    const installed = installPlugin
      ? installPlugin(profileDir, plugin)
      : plugin.source === 'local'
        ? installLocalPlugin(profileDir, dshHome, plugin)
        : installNpmPlugin(profileDir, plugin);
    transaction.sideEffectsPossible = priorSideEffects || Boolean(installed.sideEffectsPossible || (!installed.skipped && !installed.code));
    if (!installed.ok) {
      // 恢复本次尝试的配置，不让失败安装器污染此前成功项；依赖目录副作用仍单独报告。
      restorePluginProfile(profileDir, attemptSnapshot);
      // 单插件安装失败时隔离错误并继续恢复其余插件，避免一个包网络异常阻断整机还原
      failedPluginIds.add(plugin.id);
      errors.push({ id: plugin.id, package: plugin.package, code: installed.code, error: installed.error });
      results.push({ id: plugin.id, package: plugin.package, status: 'failed', code: installed.code, error: installed.error });
      continue;
    }
    ensureBundle(profileDir, plugin);
    results.push({ id: plugin.id, status: installed.skipped ? 'already-managed' : 'ready', enabled: plugin.enabled });
  }

  // 所有尝试安装的插件全部失败时回滚 package.json 与 cordis.patch.yml，返回 ok: false
  if (!dryRun && attemptedCount > 0 && errors.length === attemptedCount) {
    writePluginProfileText(profileDir, 'package.json', originalPackageText);
    writePluginProfileText(profileDir, 'cordis.patch.yml', originalPatchText);
    return { ok: false, code: errors[0].code, error: errors[0].error, results, errors };
  }

  if (!dryRun && applyConfiguration) {
    // 只有 dsh-au 本身就绪后才清理它已合并的旧挂载；失败不得先拆掉旧环境。
    if (targets.some((plugin) => plugin.package === 'dsh-au' && !failedPluginIds.has(plugin.id))) {
      const priorLegacyEffects = transaction.sideEffectsPossible;
      // 清理可能先拆链接再写配置；收尾抛错时同样不能宣称没有依赖副作用。
      transaction.sideEffectsPossible = true;
      const legacy = cleanupLegacyPlugins({ profileDir });
      transaction.sideEffectsPossible = priorLegacyEffects || Boolean(legacy.changed);
      for (const warning of legacy.warnings) console.warn(`[dsh-plugins] ${warning}`);
    }
    if (Array.isArray(bundleOrder) && bundleOrder.length > 0) {
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
      const currentBundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
      const orderedBundles = applyBundleOrder(currentBundles, bundleOrder);
      pkg.dsh = { ...(pkg.dsh || {}), profile: { ...(pkg.dsh?.profile || {}), bundles: orderedBundles } };
      writePluginProfileText(profileDir, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`);
    }
    // 每个插件只读取自己的云快照（sync/plugins/<slug>/config.yml）；不存在第二份公共模板兜底。
    let patchText = readFileSync(patchPath, 'utf8');
    for (const plugin of plan) {
      if (!plugin.supported || !plugin.profileSupported || plugin.profileManaged) continue;
      if (failedPluginIds.has(plugin.id)) continue;
      const snapshotConfig = bundles.byPackage.get(plugin.package)?.configText || '';
      patchText = applyPluginPatchConfig(patchText, plugin, !plugin.enabled, snapshotConfig, { homeDir, platform });
    }
    writePluginProfileText(profileDir, 'cordis.patch.yml', patchText);
  }

  // 清理云端已下线的插件（只处理 removedPlugins 中明确记录的项，不触碰本机额外安装的私有插件）
  const activePackageSet = new Set(plugins.map((p) => p?.package).filter(Boolean));
  const selectedIdSet = new Set(selected);
  const effectiveRemovedPlugins = (Array.isArray(removedPlugins) ? removedPlugins : []).filter((item) =>
    item && typeof item.package === 'string' && item.package.trim()
    && !activePackageSet.has(item.package.trim())
    && !selectedIdSet.has(item.id));

  let anyRemoved = false;
  if (effectiveRemovedPlugins.length > 0) {
    for (const item of effectiveRemovedPlugins) {
      const pkgName = item.package.trim();
      const itemId = item.id || pkgName;
      const matchIds = [item.patchId, item.id, pkgName, pkgName.split('/').pop()].filter(Boolean);

      let currentPkg = {};
      try { currentPkg = JSON.parse(readFileSync(packagePath, 'utf8')); } catch {}
      const inDeps = Boolean(currentPkg?.dependencies && Object.hasOwn(currentPkg.dependencies, pkgName));
      const inBundles = Array.isArray(currentPkg?.dsh?.profile?.bundles) && currentPkg.dsh.profile.bundles.includes(pkgName);
      const currentPatchText = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
      const inPatch = extractTopLevelPatchBlocks(currentPatchText).some((b) => matchIds.includes(b.id));

      if (!inDeps && !inBundles && !inPatch) continue;

      if (dryRun) {
        results.push({ id: itemId, package: pkgName, status: 'planned-remove', enabled: false });
        continue;
      }

      if (inDeps) {
        const nodeModulesPkgPath = path.join(profileDir, 'node_modules', ...pkgName.split('/'));
        let isSymlink = false;
        try { isSymlink = lstatSync(nodeModulesPkgPath).isSymbolicLink(); } catch {}
        const isLocalLink = isSymlink || Boolean(resolveExternalPluginLink(profileDir, pkgName));
        transaction.sideEffectsPossible = true;
        if (isLocalLink) {
          try { rmSync(nodeModulesPkgPath, { recursive: true, force: true }); } catch {}
        } else if (uninstallPlugin) {
          uninstallPlugin(profileDir, item);
        } else {
          uninstallNpmPlugin(profileDir, pkgName);
        }
      }

      let afterPkg = {};
      try { afterPkg = JSON.parse(readFileSync(packagePath, 'utf8')); } catch {}
      let pkgChanged = false;
      if (afterPkg?.dependencies && Object.hasOwn(afterPkg.dependencies, pkgName)) {
        delete afterPkg.dependencies[pkgName];
        pkgChanged = true;
      }
      if (Array.isArray(afterPkg?.dsh?.profile?.bundles) && afterPkg.dsh.profile.bundles.includes(pkgName)) {
        afterPkg.dsh.profile.bundles = afterPkg.dsh.profile.bundles.filter((name) => name !== pkgName);
        pkgChanged = true;
      }
      if (pkgChanged) {
        writePluginProfileText(profileDir, 'package.json', `${JSON.stringify(afterPkg, null, 2)}\n`);
      }

      if (inPatch && existsSync(patchPath)) {
        const latestPatchText = readFileSync(patchPath, 'utf8');
        const nextPatchText = removePatchBlocksByIds(latestPatchText, matchIds);
        if (nextPatchText !== latestPatchText) {
          writePluginProfileText(profileDir, 'cordis.patch.yml', nextPatchText);
        }
      }

      anyRemoved = true;
      results.push({ id: itemId, package: pkgName, status: 'removed', enabled: false });
    }
  }

  return {
    ok: true,
    machineName,
    profileDir,
    dshProfile,
    dryRun,
    results,
    errors,
    anyRemoved,
    partialFailure: errors.length > 0,
    restartRequired: !dryRun,
  };
}

/**
 * 只应用一枚云插件的启用或停用状态，避免取消一个插件时顺带安装、升级其它已选插件。
 */
export function applySingleDshPluginState({
  pluginId,
  enabled,
  plugins = getSharedDshPlugins(),
  ...syncOptions
}) {
  const plugin = plugins.find((item) => item.id === pluginId);
  if (!plugin) return { ok: false, error: `该插件不在项目云清单中: ${pluginId || '(未指定)'}` };
  return syncDshPlugins({
    ...syncOptions,
    plugins: [plugin],
    selectedIds: enabled ? [plugin.id] : [],
  });
}

/**
 * 「同步到云」的文件那一半：把这台机器上某个插件的配置落成仓库里的快照目录
 * （sync/plugins/<slug>/：plugin.json + config.yml + README.md）。
 * 只读本机 DSH profile，不写本机任何配置。
 */
export function capturePluginBundle({
  packageName,
  dshHome,
  profile = 'desktop',
  bundleRepoRoot = repoRoot,
  syncedFrom = hostname(),
  plugin: pluginOverride = null,
  homeDir = homedir(),
}) {
  const name = typeof packageName === 'string' ? packageName : '';
  // 快照面向传入的目标 DSH 目录；测试、迁移与多实例不能读到当前机器的 Profile。
  const inventory = getLocalDshPluginInventory(profile, dshHome);
  const found = inventory.find((item) => item.package === name);
  const base = pluginOverride || found;
  if (!base) return { ok: false, error: `本机没有安装插件: ${name || '(未指定包名)'}` };
  // 云清单条目不带 enabled：一律以本机 profile 实际启用状态为准，避免快照写成 false。
  const plugin = {
    ...base,
    enabled: typeof base.enabled === 'boolean' ? base.enabled : Boolean(found?.enabled),
    version: base.version || found?.version || '',
  };
  const profileDir = path.join(dshHome, 'profiles', profile);
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  const patchText = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
  const blocks = extractTopLevelPatchBlocks(patchText);
  const patchId = resolvePluginPatchId(plugin, blocks.map((block) => block.id));
  const block = blocks.find((item) => item.id === patchId);
  const written = writePluginBundle({
    repoRoot: bundleRepoRoot,
    profileDir,
    plugin,
    configText: block ? block.text : '',
    patchId,
    syncedFrom,
    homeDir,
  });
  return {
    ok: true,
    packageName: plugin.package,
    plugin,
    slug: written.slug,
    dir: written.dir,
    files: written.files,
    hasConfig: written.hasConfig,
    patchId,
  };
}

/**
 * 一键扫描本机 DSH Profile 直接安装的全部第三方插件，逐个拆分其 cordis.patch.yml 配置块
 * 写入 sync/plugins/<slug>/，并记录当前 profile.bundles 的加载顺序。
 */
export function captureAllLocalPlugins({
  dshHome = path.join(homedir(), '.dsh'),
  profile = 'desktop',
  bundleRepoRoot = repoRoot,
  syncedFrom = hostname(),
  homeDir = homedir(),
} = {}) {
  const profileDir = path.join(dshHome, 'profiles', profile);
  const packagePath = path.join(profileDir, 'package.json');
  let bundleOrder = [];
  if (existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
      if (Array.isArray(pkg?.dsh?.profile?.bundles)) {
        bundleOrder = pkg.dsh.profile.bundles.filter((item) => typeof item === 'string' && item.trim());
      }
    } catch {}
  }
  const inventory = getLocalDshPluginInventory(profile, dshHome);
  const captured = [];
  const errors = [];
  for (const item of inventory) {
    try {
      const res = capturePluginBundle({
        packageName: item.package,
        dshHome,
        profile,
        bundleRepoRoot,
        syncedFrom,
        plugin: item,
        homeDir,
      });
      if (res.ok) captured.push(res);
      else errors.push({ package: item.package, error: res.error });
    } catch (err) {
      errors.push({ package: item.package, error: err.message });
    }
  }
  return {
    ok: true,
    profileDir,
    bundleOrder,
    captured,
    errors,
  };
}

/**
 * 恢复前只读差异预览：对照明细（待安装、待启用、配置更新、已就绪、加载顺序变更），不修改任何本机文件。
 */
export function previewPluginRestore({
  dshHome = path.join(homedir(), '.dsh'),
  profile = 'desktop',
  dshProfile = '',
  plugins = getSharedDshPlugins(),
  selectedIds = [],
  bundleOrder = [],
  bundleRepoRoot = repoRoot,
  homeDir = homedir(),
  platform = process.platform,
  requireSnapshots = false,
} = {}) {
  const profileDir = path.join(dshHome, 'profiles', profile);
  const packagePath = path.join(profileDir, 'package.json');
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  const pkg = existsSync(packagePath) ? JSON.parse(readFileSync(packagePath, 'utf8')) : {};
  const currentPatchText = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
  const currentBundles = Array.isArray(pkg?.dsh?.profile?.bundles)
    ? pkg.dsh.profile.bundles.filter((item) => typeof item === 'string')
    : [];
  const bundles = readPluginBundles(bundleRepoRoot);

  const plan = buildPluginSyncPlan(plugins, selectedIds, platform, dshProfile);
  if (requireSnapshots) {
    const previewTargets = plan.filter((item) => item.supported && item.profileSupported && !item.profileManaged);
    const snapshotErrors = (bundles.errors || []).filter((issue) => (previewTargets.length > 0 && issue.code === 'SNAPSHOT_ROOT_UNREADABLE') || previewTargets.some((plugin) => issue.package === plugin.package
      || (issue.dir && path.resolve(issue.dir) === path.resolve(resolvePluginBundlesDir(bundleRepoRoot), pluginBundleSlug(plugin.package)))));
    for (const plugin of previewTargets) {
      const expectedDir = path.resolve(resolvePluginBundlesDir(bundleRepoRoot), pluginBundleSlug(plugin.package));
      const saved = bundles.byPackage.get(plugin.package);
      if (!plugin.snapshot) snapshotErrors.push({ code: 'SNAPSHOT_NOT_DECLARED', package: plugin.package, message: `${plugin.package} 未声明唯一云快照` });
      else if (path.resolve(bundleRepoRoot, plugin.snapshot) !== expectedDir || !saved || path.resolve(saved.dir) !== expectedDir) {
        snapshotErrors.push({ code: 'SNAPSHOT_MISSING_OR_MISMATCHED', package: plugin.package, message: `${plugin.package} 声明的云快照缺失或归属不符` });
      }
    }
    if (snapshotErrors.length) return { ok: false, code: 'SNAPSHOT_INVALID', error: snapshotErrors.map((issue) => issue.message).join('；'), errors: snapshotErrors,
      toInstall: [], toEnable: [], toUpdateConfig: [], unchanged: [], bundleOrderChanged: false, totalSelected: 0 };
  }
  const toInstall = [];
  const toEnable = [];
  const toUpdateConfig = [];
  const unchanged = [];

  for (const plugin of plan) {
    if (!plugin.enabled || !plugin.supported || !plugin.profileSupported || plugin.profileManaged) continue;
    const summary = {
      id: plugin.id,
      name: plugin.name || plugin.package,
      package: plugin.package,
      version: plugin.version || '',
      source: plugin.source || 'npm',
    };
    const installed = plugin.source === 'local'
      ? isLocalPluginAlreadyMounted(profileDir, plugin, bundleRepoRoot)
      : isNpmPluginAlreadyInstalled(profileDir, plugin);
    if (!installed) {
      toInstall.push(summary);
      continue;
    }
    const snapshotBundle = bundles.byPackage.get(plugin.package);
    const snapshotConfig = snapshotBundle?.configText || '';
    const simulatedPatch = applyPluginPatchConfig(currentPatchText, plugin, false, snapshotConfig, { homeDir, platform });
    const inBundles = currentBundles.includes(plugin.package);
    const currentBlocks = extractTopLevelPatchBlocks(currentPatchText);
    const snapshotIds = extractTopLevelPatchBlocks(snapshotConfig).map((block) => block.id);
    const patchId = snapshotBundle?.manifest?.patchId
      || resolvePluginPatchId(plugin, [...snapshotIds, ...currentBlocks.map((block) => block.id)]);
    const currentBlock = currentBlocks.find((b) => b.id === patchId);
    const isCurrentlyDisabled = !inBundles || (currentBlock && /^  disabled:\s*true\b/m.test(currentBlock.text));

    if (isCurrentlyDisabled) {
      toEnable.push(summary);
    } else {
      // 仅针对当前插件块做归一化比对：合并 YAML 双引号折行、忽略默认 disabled: false，以及无独立 config 时的空壳块差异。
      const normalizePluginBlock = (blockText) => {
        const cleaned = String(blockText || '')
          .replace(/\\\r?\n[ \t]*(?=\\\\)/g, '')
          .replace(/\r\n/g, '\n')
          .replace(/^  disabled:[ \t]*false[ \t]*\n/gm, '')
          .trim();
        if (!cleaned) return '';
        const bodyLines = cleaned
          .split('\n')
          .slice(1)
          .filter((line) => line.trim() && !/^  name:\s*/.test(line));
        return bodyLines.length === 0 ? '' : `${cleaned}\n`;
      };
      const simulatedBlocks = extractTopLevelPatchBlocks(simulatedPatch);
      const simulatedBlock = simulatedBlocks.find((b) => b.id === patchId);
      if (normalizePluginBlock(simulatedBlock?.text) !== normalizePluginBlock(currentBlock?.text)) {
        toUpdateConfig.push(summary);
      } else {
        unchanged.push(summary);
      }
    }
  }

  const reordered = applyBundleOrder(currentBundles, bundleOrder);
  const bundleOrderChanged = bundleOrder.length > 0
    && (reordered.length !== currentBundles.length || reordered.some((item, idx) => item !== currentBundles[idx]));

  return {
    ok: true,
    toInstall,
    toEnable,
    toUpdateConfig,
    unchanged,
    bundleOrderChanged,
    totalSelected: toInstall.length + toEnable.length + toUpdateConfig.length + unchanged.length,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh');
  const profile = option('--profile', 'desktop');
  const exportPackage = option('--export', '');
  if (exportPackage) {
    const captured = capturePluginBundle({ packageName: exportPackage, dshHome, profile });
    if (!captured.ok) {
      console.error(`[dsh-plugin-sync] ${captured.error}`);
      process.exit(1);
    }
    console.log(`[dsh-plugin-sync] 已生成配置快照: ${captured.dir}`);
    for (const file of captured.files) console.log(`  ${path.join(captured.dir, file)}`);
    console.log(captured.hasConfig
      ? `[dsh-plugin-sync] 已带上 patch 配置块 ${captured.patchId}（config.yml）`
      : '[dsh-plugin-sync] 该插件没有独立 patch 配置块，只记录安装与启用信息');
    process.exit(0);
  }
  const output = syncDshPlugins({
    dshHome,
    profile: option('--profile', 'desktop'),
    dshProfile: option('--dsh-profile', ''),
    machineName: option('--machine', hostname()),
    dryRun: args.includes('--dry-run'),
    requireSnapshots: true,
  });
  if (!output.ok) {
    console.error(`[dsh-plugin-sync] ${output.error}`);
    process.exit(1);
  }
  console.log(`[dsh-plugin-sync] 已按 ${output.machineName} 的仓库清单${output.dryRun ? '预览' : '同步'} ${output.results.length} 个插件。`);
  for (const result of output.results) {
    console.log(`  [${result.status}] ${result.id}${result.enabled === undefined ? '' : result.enabled ? '（启用）' : '（停用）'}`);
  }
  if (!output.dryRun) console.log('[dsh-plugin-sync] 请完全重启 DSH 使插件状态生效。');
}
