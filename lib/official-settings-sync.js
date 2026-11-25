import { normalizeAutoContinue } from './features.js';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import { REPO_ROOT, readCloudPlugins, readRemovedCloudPlugins, removeCloudPlugin, upsertCloudPlugin } from './cloud-manifest.js';
import { getRepoRoot, hasSyncRepo, resolveSyncDir, resolveSyncRepoRoot, syncRepoUnavailableMessage } from './sync-repo.js';
import { loadMachineSettingsBackup, saveMachinePreferences, saveMachineSettingsBackup } from './local-bindings.js';
import { MODEL_SHORTCUTS_SCHEMA_VERSION, normalizeModelShortcuts, readModelShortcuts, saveModelShortcuts } from './model-shortcuts.js';
import { expandPortableConfigPaths, findPlaintextCredentialIssue, normalizePortableConfigPaths, readPluginBundles, readPluginPackageMeta, removePluginBundle, updatePluginBundleVersion, writePluginBundle } from './plugin-bundles.js';
import { resolvePluginPatchId } from './plugin-sync-core.js';

export const OFFICIAL_SYNC_ITEMS = Object.freeze([
  // 按 DSH 配置块逐项拆分；title 优先用 DSH 安装包里的官方中文名，对不上的标 nonOfficial。
  {
    id: 'ui-theme',
    category: '外观',
    title: '外观：字号',
    officialName: '界面主题',
    patchIds: ['ui-theme'],
    defaultDiff: '字号大小 / 代码字号 / 终端字号',
    comparisons: [
      { label: '字号大小 / 代码字号 / 终端字号', defaultValue: '14 / 13 / 14 px', currentValue: '按私人仓库同步' },
    ],
  },
  {
    id: 'ui-chat',
    category: '聊天内容展示',
    title: '聊天内容展示',
    officialName: '聊天内容展示',
    patchIds: ['ui-chat'],
    defaultDiff: '工作过程显示、性能统计、链接打开方式',
    comparisons: [
      { label: '你希望看到多少工作过程？ (transcriptView)', defaultValue: '默认视图', currentValue: '按私人仓库同步' },
      { label: '性能与耗时统计 (performanceUsage)', defaultValue: '简略', currentValue: '按私人仓库同步' },
      { label: '链接打开方式 (linkOpening)', defaultValue: '当前窗口', currentValue: '按私人仓库同步' },
    ],
  },
  {
    id: 'ui-settings-account',
    category: '账号设置界面',
    title: '账号设置界面',
    officialName: '账号设置界面',
    patchIds: ['ui-settings-account'],
    defaultDiff: '用量显示样式与新手引导进度',
    comparisons: [
      { label: '用量显示样式 (usage)', defaultValue: '标准卡片', currentValue: '按私人仓库同步' },
      { label: '新手引导 (step)', defaultValue: '未完成', currentValue: '按私人仓库同步' },
    ],
  },
  {
    id: 'session-log-deepseek',
    category: '会话日志上传设置',
    title: '会话日志上传设置',
    officialName: '会话日志上传设置',
    patchIds: ['session-log-deepseek'],
    defaultDiff: '是否随官方模型 API 请求上传会话日志',
    comparisons: [
      { label: '上传会话日志 (enabled)', defaultValue: '开启', currentValue: '按私人仓库同步' },
    ],
  },
  {
    id: 'subagent-models',
    category: '子智能体',
    title: '子智能体：模型选择',
    officialName: '子智能体设置',
    patchIds: ['subagent-model-selection-settings'],
    defaultDiff: '从私人仓库同步子代理可用模型白名单',
    comparisons: [
      { label: '允许子代理独立选择模型', defaultValue: '关闭 (false)', currentValue: '开启 (true)' },
      { label: '子代理可用模型白名单', defaultValue: '未限制（仅跟随主对话）', currentValue: '按私人仓库子代理白名单同步' },
    ],
  },
  {
    id: 'permission-preset',
    category: '权限',
    title: '权限：新会话的默认权限模式',
    officialName: '权限模式界面',
    patchIds: ['permission'],
    defaultDiff: '新开对话默认 danger-full-access（免除读写与命令二次确认）',
    comparisons: [
      { label: '新建对话默认权限预设 (defaultPreset)', defaultValue: '工作区内修改 (workspace-write，需审批)', currentValue: '完全权限 (danger-full-access，免确认)' },
    ],
  },
  {
    id: 'llm-providers',
    category: '模型',
    title: '模型提供商、目录与默认模型',
    officialName: '模型设置界面 / 默认模型',
    nonOfficial: true,
    // 3 个配置块互相依赖（默认模型引用供应商），只能整体勾选。
    groupNote: '与 Cursor ACP 适配器、默认模型一起同步',
    patchIds: ['llm-pi-ai', 'dsh-acp-adapter', 'agent-default-model'],
    defaultDiff: '从私人仓库同步模型供应商、目录与新对话默认模型',
    comparisons: [
      { label: 'DSH 模型供应商列表 (llm-pi-ai)', defaultValue: '无自定义供应商', currentValue: '按所选方案从私人仓库同步供应商列表' },
      { label: 'Codex 模型目录', defaultValue: '不自动刷新', currentValue: '同步完整与精简目录，不切换当前模型' },
      { label: '原生 ACP 代理适配器', defaultValue: '未配置', currentValue: '按所选方案同步 ACP 适配器' },
      { label: '新对话默认模型 (agent-default-model)', defaultValue: '官方默认模型', currentValue: '按所选模型方案同步默认模型与思考强度' },
    ],
  },
  {
    id: 'desktop-preferences',
    category: '桌面设置',
    title: '桌面设置：后台运行、浏览器与局域网、桌面通知',
    officialName: '桌面设置',
    patchIds: [],
    isDesktopPreferences: true,
    defaultDiff: '关闭最小化到托盘 · 允许局域网与浏览器访问 · 仅通知回合与定时任务结果',
    comparisons: [
      { label: '点击窗口关闭按钮 (closeToTray)', defaultValue: '直接退出应用 (false)', currentValue: '最小化到系统托盘 (true)' },
      { label: '网络暴露与浏览器访问', defaultValue: '仅本机访问 (local)', currentValue: '局域网访问 (lan) + 允许浏览器访问' },
      { label: '系统桌面通知范围', defaultValue: '全部通知默认状态', currentValue: '开启对话回合与定时任务完成/失败通知，关闭后台作业通知' },
    ],
  },
]);

export const ALL_OFFICIAL_SYNC_ITEM_IDS = OFFICIAL_SYNC_ITEMS.map((item) => item.id);

/**
 * 本机设置类同步项：默认单机备份（machines/<machineId>.json），
 * 勾选后接入多台电脑云端共享自动同步。
 */
export const PREFERENCE_SYNC_ITEMS = Object.freeze([
  {
    id: 'shortcuts',
    category: '本机设置',
    title: '设备 / 页面切换快捷键',
    defaultDiff: '默认单机备份，勾选后多台电脑云端共享自动同步',
  },
  {
    id: 'modelShortcuts',
    category: '本机设置',
    title: '模型快捷槽位',
    defaultDiff: '默认单机备份，勾选后多台电脑云端共享自动同步',
  },
]);

export const ALL_PREFERENCE_SYNC_ITEM_IDS = PREFERENCE_SYNC_ITEMS.map((item) => item.id);

/** 动态发现的官方配置块用 `patch:<blockId>` 作同步项 ID；只允许小写字母、数字与连字符。 */
export const DYNAMIC_PATCH_ITEM_PREFIX = 'patch:';
const DYNAMIC_PATCH_ITEM_RE = /^patch:[a-z0-9][a-z0-9-]*$/;
export function isDynamicPatchItemId(id) {
  return typeof id === 'string' && DYNAMIC_PATCH_ITEM_RE.test(id);
}

/**
 * 旧同步项 ID → 新 ID 列表。旧版 dsh-au 或其它电脑仍可能传 general-settings，
 * 这里展开成拆分后的 4 项，保证跨版本拉取/推送行为不变。
 */
const LEGACY_ITEM_ID_MAP = Object.freeze({
  'general-settings': ['ui-theme', 'ui-chat', 'ui-settings-account', 'session-log-deepseek'],
  'ui-chat-account': ['ui-theme', 'ui-chat', 'ui-settings-account', 'session-log-deepseek'],
});

/** 展开旧 ID 并去重；保留合法的固定项与动态项，其余丢弃。 */
export function expandSyncItemIds(ids) {
  const fixed = new Set(ALL_OFFICIAL_SYNC_ITEM_IDS);
  const out = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    for (const id of LEGACY_ITEM_ID_MAP[raw] || [raw]) {
      if ((fixed.has(id) || isDynamicPatchItemId(id)) && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/** 同步项 ID 列表 → 实际要处理的 DSH 配置块 ID 集合（固定项按 patchIds，动态项去掉前缀）。 */
export function resolveSelectedPatchIds(selectedItems) {
  const ids = new Set();
  const selected = new Set(expandSyncItemIds(selectedItems));
  for (const item of OFFICIAL_SYNC_ITEMS) {
    if (selected.has(item.id)) item.patchIds.forEach((patchId) => ids.add(patchId));
  }
  for (const id of selected) {
    if (isDynamicPatchItemId(id)) ids.add(id.slice(DYNAMIC_PATCH_ITEM_PREFIX.length));
  }
  return ids;
}

/** 固定参与云同步的插件：dsh-au 自身，界面上单独放在「dsh-au 设置」页签，没有勾选框。 */
export const FIXED_SYNC_PLUGIN_ID = 'dsh-au';

export function getAllCloudPluginIds() {
  try {
    return readCloudPlugins()
      .filter((p) => typeof p?.id === 'string' && p.id)
      .map((p) => p.id);
  } catch {
    return [];
  }
}

/**
 * 解析 DSH 声明式同步清单路径：
 * 仅认环境变量 DSH_AU_PROFILES_MANIFEST_PATH 覆盖或 sync/cloud/dsh-profiles.json，不再回退旧仓库路径。
 */
export function resolveDshProfilesManifestPath(repoRoot = getRepoRoot()) {
  const envPath = String(process.env.DSH_AU_PROFILES_MANIFEST_PATH || '').trim();
  if (envPath) return envPath;
  return path.join(resolveSyncDir({ repoRoot }), 'cloud', 'dsh-profiles.json');
}

function normalizeDshProfileEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = String(entry.id || '').trim();
  if (!id) return null;
  return {
    id,
    label: String(entry.label || id).trim(),
    description: String(entry.description || entry.label || id).trim(),
    file: String(entry.file || `app-config/dsh/cordis.patch.${id}.yml`).trim(),
    platforms: Array.isArray(entry.platforms) && entry.platforms.length > 0
      ? entry.platforms.map((p) => String(p).trim()).filter(Boolean)
      : ['darwin', 'win32', 'linux'],
    selectable: entry.selectable !== false,
    acpFallback: entry.acpFallback && typeof entry.acpFallback === 'object' ? entry.acpFallback : null,
    comparisons: Array.isArray(entry.comparisons) ? entry.comparisons : null,
  };
}

/**
 * 加载并规范化 DSH 声明式同步清单 (dsh-profiles.json)：
 * - 未配置私人同步仓库且无环境变量覆盖时，返回空结构以保持 hasSyncRepo() 守卫不崩。
 * - 已配置仓库或指定清单路径时，清单缺失、解析失败或无有效 profiles 一律明确抛错，不做旧目录扫描兜底。
 */
export function loadDshProfilesManifest(repoRoot = getRepoRoot()) {
  const envPath = String(process.env.DSH_AU_PROFILES_MANIFEST_PATH || '').trim();
  if (!envPath && !hasSyncRepo({ repoRoot })) {
    return {
      schemaVersion: 2,
      defaultProfile: '',
      restoreScript: '',
      desktopPreferencesFile: '',
      pathNormalizations: [],
      watchedFiles: [],
      profiles: [],
    };
  }

  const manifestPath = resolveDshProfilesManifestPath(repoRoot);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`DSH 方案清单缺失: ${manifestPath}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(`DSH 方案清单解析失败 (${manifestPath}): ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`DSH 方案清单格式无效: ${manifestPath}`);
  }

  const profiles = Array.isArray(parsed.profiles)
    ? parsed.profiles.map(normalizeDshProfileEntry).filter(Boolean)
    : [];
  if (profiles.length === 0) {
    throw new Error(`DSH 方案清单缺少有效的 profiles 条目: ${manifestPath}`);
  }

  const requestedDefault = typeof parsed.defaultProfile === 'string' ? parsed.defaultProfile.trim() : '';
  const defaultProfile = (requestedDefault && profiles.some((p) => p.id === requestedDefault))
    ? requestedDefault
    : (profiles.find((p) => p.selectable !== false)?.id || profiles[0].id);

  // 规范化声明式字段，供哈希计算、路径归一化与还原脚本调用统一读取。
  const restoreScript = typeof parsed.restoreScript === 'string' ? parsed.restoreScript.trim() : '';
  const desktopPreferencesFile = typeof parsed.desktopPreferencesFile === 'string'
    ? parsed.desktopPreferencesFile.trim()
    : '';
  const pathNormalizations = Array.isArray(parsed.pathNormalizations)
    ? parsed.pathNormalizations
      .filter((item) => item && typeof item === 'object' && typeof item.pattern === 'string' && item.pattern && typeof item.replacement === 'string')
      .map((item) => ({ pattern: item.pattern, replacement: item.replacement }))
    : [];
  const watchedFiles = Array.isArray(parsed.watchedFiles)
    ? Array.from(new Set(parsed.watchedFiles.map((f) => (typeof f === 'string' ? f.trim() : '')).filter(Boolean)))
    : [];

  return {
    schemaVersion: Number.isInteger(parsed.schemaVersion) ? parsed.schemaVersion : 2,
    defaultProfile,
    restoreScript,
    desktopPreferencesFile,
    pathNormalizations,
    watchedFiles,
    profiles,
  };
}

/** 按清单 pathNormalizations 规则将本机绝对路径归一化为跨机可移植路径。 */
export function normalizeLocalPatchPaths(text, manifest) {
  let result = String(text || '');
  const rules = Array.isArray(manifest?.pathNormalizations) ? manifest.pathNormalizations : [];
  for (const rule of rules) {
    if (!rule || typeof rule.pattern !== 'string' || !rule.pattern || typeof rule.replacement !== 'string') continue;
    try {
      const re = new RegExp(rule.pattern, 'g');
      result = result.replace(re, rule.replacement);
    } catch {
      // 忽略无效正则，避免单个坏规则阻断整体同步。
    }
  }
  return result;
}

/**
 * 获取当前平台可选的 DSH 模型方案列表；若按平台过滤后为空则退回全部可选方案。
 */
export function getSelectableDshProfiles({ repoRoot = getRepoRoot(), platform = '' } = {}) {
  const { profiles } = loadDshProfilesManifest(repoRoot);
  const selectable = profiles.filter((p) => p.selectable !== false);
  const normalizedPlatform = typeof platform === 'string' ? platform.trim() : '';
  if (!normalizedPlatform) return selectable;
  const filtered = selectable.filter(
    (p) => !Array.isArray(p.platforms) || p.platforms.includes(normalizedPlatform),
  );
  return filtered.length > 0 ? filtered : selectable;
}

/**
 * 解析有效的方案 ID：不做旧名称别名映射，不在候选池内则直接回退到清单 defaultProfile。
 */
export function resolveDshProfileId(profile, { repoRoot = getRepoRoot(), allowNonSelectable = false, platform = '' } = {}) {
  const manifest = loadDshProfilesManifest(repoRoot);
  const candidates = allowNonSelectable
    ? manifest.profiles
    : getSelectableDshProfiles({ repoRoot, platform });
  if (typeof profile === 'string' && candidates.some((p) => p.id === profile)) {
    return profile;
  }
  if (candidates.some((p) => p.id === manifest.defaultProfile)) {
    return manifest.defaultProfile;
  }
  return candidates[0]?.id || manifest.defaultProfile || 'general';
}

/**
 * 将方案 ID 解析为仓库内对应的 cordis.patch.<profile>.yml 绝对路径。
 */
export function resolveRepoProfilePatchPath(repoRoot = getRepoRoot(), profile = '') {
  const manifest = loadDshProfilesManifest(repoRoot);
  const matchedId = resolveDshProfileId(profile, { repoRoot, allowNonSelectable: true });
  const entry = manifest.profiles.find((p) => p.id === profile)
    || manifest.profiles.find((p) => p.id === matchedId)
    || manifest.profiles[0];
  const relFile = entry?.file || `app-config/dsh/cordis.patch.${matchedId}.yml`;
  return path.join(repoRoot, ...String(relFile).split('/').filter(Boolean));
}

export const DEFAULT_CLOUD_SYNC_CONFIG = Object.freeze({
  enabled: false,
  profile: 'general',
  selectedItems: [...ALL_OFFICIAL_SYNC_ITEM_IDS],
  customized: false,
  selectedPlugins: [],
  syncPluginConfigs: [],
  pluginsCustomized: false,
  selectedPreferences: [],
  lastSyncedHash: '',
  lastSyncedAt: '',
  lastLocalHash: '',
  conflict: false,
  conflictReason: '',
});

export function normalizeCloudSyncConfig(raw, { repoRoot = getRepoRoot() } = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  // 不做旧名称别名映射；不在当前可选方案列表中时直接回退到清单 defaultProfile。
  const profile = resolveDshProfileId(source.profile, { repoRoot, allowNonSelectable: false });
  const hasExplicitList = Array.isArray(source.selectedItems);
  let selectedItems;
  if (hasExplicitList) {
    selectedItems = expandSyncItemIds(source.selectedItems);
  } else {
    selectedItems = [...ALL_OFFICIAL_SYNC_ITEM_IDS];
  }
  const customized = typeof source.customized === 'boolean'
    ? source.customized
    : (hasExplicitList && ALL_OFFICIAL_SYNC_ITEM_IDS.some((id) => !selectedItems.includes(id)));

  const allPluginIds = getAllCloudPluginIds();
  const validPluginSet = new Set(allPluginIds);
  const hasExplicitPlugins = Array.isArray(source.selectedPlugins);
  const selectedPlugins = hasExplicitPlugins
    ? Array.from(new Set(source.selectedPlugins.filter((id) => typeof id === 'string' && (validPluginSet.size === 0 || validPluginSet.has(id)))))
    : [...allPluginIds];
  const hasExplicitPluginConfigs = Array.isArray(source.syncPluginConfigs);
  const syncPluginConfigs = hasExplicitPluginConfigs
    ? Array.from(new Set(source.syncPluginConfigs.filter((id) => typeof id === 'string' && (validPluginSet.size === 0 || validPluginSet.has(id)))))
    : [...allPluginIds];
  // dsh-au 是同步功能的提供者，自身配置固定参与同步，不受用户勾选影响。
  // 只在云清单里确实有 dsh-au 时补上，避免向推送/拉取传入不存在的插件 ID。
  if (validPluginSet.has(FIXED_SYNC_PLUGIN_ID)) {
    if (!selectedPlugins.includes(FIXED_SYNC_PLUGIN_ID)) selectedPlugins.push(FIXED_SYNC_PLUGIN_ID);
    if (!syncPluginConfigs.includes(FIXED_SYNC_PLUGIN_ID)) syncPluginConfigs.push(FIXED_SYNC_PLUGIN_ID);
  }
  const pluginsCustomized = typeof source.pluginsCustomized === 'boolean'
    ? source.pluginsCustomized
    : (hasExplicitPlugins || hasExplicitPluginConfigs);

  // 本机设置默认不勾选（仅单机备份）；显式传入数组时只保留合法项，勾选后接入云端共享自动同步。
  const validPreferenceSet = new Set(ALL_PREFERENCE_SYNC_ITEM_IDS);
  const selectedPreferences = Array.isArray(source.selectedPreferences)
    ? Array.from(new Set(source.selectedPreferences.filter((id) => typeof id === 'string' && validPreferenceSet.has(id))))
    : [];

  return {
    enabled: Boolean(source.enabled),
    profile,
    selectedItems,
    customized,
    selectedPlugins,
    syncPluginConfigs,
    pluginsCustomized,
    selectedPreferences,
    lastSyncedHash: typeof source.lastSyncedHash === 'string' ? source.lastSyncedHash : '',
    lastSyncedAt: typeof source.lastSyncedAt === 'string' ? source.lastSyncedAt : '',
    lastLocalHash: typeof source.lastLocalHash === 'string' ? source.lastLocalHash : '',
    conflict: Boolean(source.conflict),
    conflictReason: typeof source.conflictReason === 'string' ? source.conflictReason : '',
  };
}

export function computeOfficialSettingsHash(repoRoot = getRepoRoot(), profile = '', options = {}) {
  // 未配置私人仓库且无清单环境变量覆盖时，返回空哈希保持守卫不崩。
  const envManifestPath = String(process.env.DSH_AU_PROFILES_MANIFEST_PATH || '').trim();
  if (!envManifestPath && !hasSyncRepo({ repoRoot })) {
    return '';
  }

  // 从声明式清单动态读取方案模板、桌面偏好文件与 watchedFiles，不再硬编码文件名。
  const manifest = loadDshProfilesManifest(repoRoot);
  const safeProfile = resolveDshProfileId(profile, { repoRoot, allowNonSelectable: true });
  const patchPath = resolveRepoProfilePatchPath(repoRoot, safeProfile);
  const prefPath = manifest.desktopPreferencesFile
    ? path.join(repoRoot, ...manifest.desktopPreferencesFile.split('/').filter(Boolean))
    : '';
  const dshAuPrefPath = path.join(resolveSyncDir({ repoRoot }), 'cloud', 'dsh-au-preferences.json');
  const readNormalized = (filePath) => (filePath && fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n')
    : '');
  const patchContent = readNormalized(patchPath);
  const prefContent = readNormalized(prefPath);
  const dshAuPrefContent = readNormalized(dshAuPrefPath);
  // 按清单 watchedFiles 顺序读取受监控的目录/网关模板文件并纳入云端哈希。
  const watchedContents = manifest.watchedFiles
    .map((relPath) => readNormalized(path.join(repoRoot, ...relPath.split('/').filter(Boolean))));
  const pluginsDir = path.join(resolveSyncDir({ repoRoot }), 'plugins');
  let pluginsDigest = '';
  try {
    if (fs.existsSync(pluginsDir)) {
      const slugs = fs.readdirSync(pluginsDir).sort();
      for (const slug of slugs) {
        const pjson = path.join(pluginsDir, slug, 'plugin.json');
        if (fs.existsSync(pjson)) {
          const parsed = JSON.parse(fs.readFileSync(pjson, 'utf8'));
          pluginsDigest += `${slug}:${Boolean(parsed.enabled)}:${parsed.version || ''}:${parsed.configHash || ''};`;
        }
      }
    }
  } catch {}
  // 显式传入 selectedPreferences 时把云端共享偏好纳入云端哈希；未勾选时不把单机 machines/<machineId>.json 混入云端哈希。
  // shortcuts 已包含在 dshAuPrefContent (cloud/dsh-au-preferences.json) 中；modelShortcuts 读取 cloud/model-shortcuts.json。
  const selectedPreferences = Array.isArray(options?.selectedPreferences)
    ? Array.from(new Set(options.selectedPreferences.filter((id) => ALL_PREFERENCE_SYNC_ITEM_IDS.includes(id)))).sort()
    : null;
  let preferencesDigest = '';
  if (selectedPreferences && selectedPreferences.includes('modelShortcuts')) {
    const cloudModelShortcutsPath = path.join(resolveSyncDir({ repoRoot }), 'cloud', 'model-shortcuts.json');
    let val = 'null';
    if (fs.existsSync(cloudModelShortcutsPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(cloudModelShortcutsPath, 'utf8'));
        val = canonicalJson(normalizeModelShortcuts(parsed, { persisted: true }));
      } catch {
        val = readNormalized(cloudModelShortcutsPath);
      }
    }
    preferencesDigest = `\n---\nmodelShortcuts:${val}`;
  }
  const hash = crypto.createHash('sha256').update(
    `${safeProfile}\n${patchContent}\n---\n${prefContent}\n---\n${dshAuPrefContent}\n---\n${watchedContents.join('\n---\n')}\n---\n${pluginsDigest}${preferencesDigest}`,
  ).digest('hex');
  return hash.slice(0, 16);
}

/**
 * 计算本机官方设置（已勾选同步项对应的 cordis.patch.yml 块 + desktop-preferences.json + 已勾选本机设置）的稳定哈希。
 * 忽略换行符差异、清单声明的本机路径差异及含明文凭据的块，避免无意义的重复自动推送。
 */
export function computeLocalOfficialSettingsHash({
  dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh'),
  selectedItems = ALL_OFFICIAL_SYNC_ITEM_IDS,
  selectedPreferences = undefined,
  selectedPlugins = undefined,
  syncPluginConfigs = undefined,
  repoRoot = getRepoRoot(),
  manifest = null,
} = {}) {
  const selectedSet = new Set(mapLegacyItemIds(selectedItems));
  const localPatchPath = path.join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml');
  const patchParts = [];

  if (fs.existsSync(localPatchPath)) {
    const resolvedManifest = manifest || loadDshProfilesManifest(repoRoot);
    const rawLocal = normalizeLocalPatchPaths(
      fs.readFileSync(localPatchPath, 'utf8').replace(/\r\n/g, '\n'),
      resolvedManifest,
    );
    const localMap = new Map(extractTopLevelPatchBlocks(rawLocal).map((b) => [b.id, b.text.trim()]));
    const patchIds = [...resolveSelectedPatchIds([...selectedSet])].sort();
    for (const patchId of patchIds) {
      const block = localMap.get(patchId);
      if (!block) continue;
      if (findPlaintextCredentialIssue(block)) continue;
      patchParts.push(`${patchId}\n${block}`);
    }
  }

  let desktopPrefContent = '';
  if (selectedSet.has('desktop-preferences')) {
    const localDesktopPath = path.join(dshHome, 'desktop-preferences.json');
    if (fs.existsSync(localDesktopPath)) {
      desktopPrefContent = fs.readFileSync(localDesktopPath, 'utf8').replace(/\r\n/g, '\n').trim();
    }
  }

  // 纳入 dsh-au.config.json 的 8 项固定共享开关（缺省时给稳定默认值），绝不纳入 cloudSync、windowState.geometry 等单机元数据避免死循环。
  const auCfgPath = process.env.DSH_AU_CONFIG_PATH || path.join(dshHome, 'dsh-au.config.json');
  let localAuCfg = {};
  try {
    if (fs.existsSync(auCfgPath)) localAuCfg = JSON.parse(fs.readFileSync(auCfgPath, 'utf8'));
  } catch {}
  const dshAuSharedPrefs = {
    todo: localAuCfg?.features?.todo !== undefined ? Boolean(localAuCfg.features.todo) : true,
    remoteManagement: localAuCfg?.features?.remoteManagement !== undefined ? Boolean(localAuCfg.features.remoteManagement) : true,
    fullAccessByDefault: localAuCfg?.features?.fullAccessByDefault !== undefined ? Boolean(localAuCfg.features.fullAccessByDefault) : false,
    blockGoalCreation: typeof localAuCfg?.features?.blockGoalCreation === 'boolean' ? localAuCfg.features.blockGoalCreation : false,
    sidebarWorkbench: localAuCfg?.features?.sidebarWorkbench === true,
    windowRestoreEnabled: localAuCfg?.windowState?.enabled !== undefined ? Boolean(localAuCfg.windowState.enabled) : false,
    mobileEnabled: typeof localAuCfg?.clientPreferences?.mobileEnabled === 'boolean' ? localAuCfg.clientPreferences.mobileEnabled : false,
    autoContinue: normalizeAutoContinue(localAuCfg?.autoContinue),
  };

  // 仅在勾选对应本机设置项时读取 model-shortcuts.json / shortcutOverrides。
  const prefIds = Array.isArray(selectedPreferences)
    ? Array.from(new Set(selectedPreferences.filter((id) => ALL_PREFERENCE_SYNC_ITEM_IDS.includes(id)))).sort()
    : null;
  let preferencesDigest = '';
  if (prefIds && prefIds.length > 0) {
    const parts = [];
    for (const prefId of prefIds) {
      if (prefId === 'modelShortcuts') {
        const shortcutsFilePath = process.env.DSH_AU_MODEL_SHORTCUTS_PATH || path.join(dshHome, 'model-shortcuts.json');
        const localModelShortcuts = readModelShortcuts({ filePath: shortcutsFilePath }).modelShortcuts;
        parts.push(`modelShortcuts:${canonicalJson(localModelShortcuts)}`);
      } else if (prefId === 'shortcuts') {
        const localShortcuts = localAuCfg?.clientPreferences?.shortcutOverrides
          && typeof localAuCfg.clientPreferences.shortcutOverrides === 'object'
          && !Array.isArray(localAuCfg.clientPreferences.shortcutOverrides)
          ? localAuCfg.clientPreferences.shortcutOverrides
          : {};
        parts.push(`shortcuts:${canonicalJson(localShortcuts)}`);
      }
    }
    preferencesDigest = `\n---\n${parts.join(';')}`;
  }

  let pluginsDigest = '';
  if (Array.isArray(selectedPlugins) && selectedPlugins.length > 0) {
    const cloudPlugins = readCloudPlugins().filter((p) => p && typeof p.id === 'string' && typeof p.package === 'string');
    const cloudPluginMap = new Map(cloudPlugins.map((p) => [p.id, p]));
    const profileDir = path.join(dshHome, 'profiles', 'desktop');
    const packagePath = path.join(profileDir, 'package.json');
    let pkg = {};
    try {
      if (fs.existsSync(packagePath)) pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    } catch {}
    const deps = pkg?.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
    const enabledBundles = new Set(Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []);
    const patchText = fs.existsSync(localPatchPath) ? fs.readFileSync(localPatchPath, 'utf8') : '';
    const localBlocks = extractTopLevelPatchBlocks(patchText);
    const bundles = readPluginBundles(repoRoot);
    const configPluginSet = new Set(Array.isArray(syncPluginConfigs) ? syncPluginConfigs : []);
    const pluginParts = [];
    for (const pluginId of [...new Set(selectedPlugins)].sort()) {
      const plugin = cloudPluginMap.get(pluginId);
      if (!plugin || !Object.hasOwn(deps, plugin.package)) continue;
      const existingBundle = bundles.byPackage.get(plugin.package);
      const patchId = existingBundle?.manifest?.patchId || plugin.package.split('/').pop() || plugin.id;
      const localBlock = localBlocks.find((b) => b.id === patchId || b.id === plugin.id || b.id === plugin.package.split('/').pop());
      const isPatchDisabled = Boolean(localBlock && /^\s+disabled:\s*true\b/m.test(localBlock.text));
      const localEnabled = enabledBundles.has(plugin.package) && !isPatchDisabled;
      let configPart = '';
      if (configPluginSet.has(plugin.id) && localBlock && !findPlaintextCredentialIssue(localBlock.text)) {
        configPart = normalizeComparablePluginBlock(localBlock.text);
      }
      pluginParts.push(`${plugin.id}:${localEnabled}:${configPart}`);
    }
    if (pluginParts.length > 0) {
      pluginsDigest = `\n---\n${pluginParts.join(';')}`;
    }
  }

  const hash = crypto.createHash('sha256').update(
    `${patchParts.join('\n===\n')}\n---\n${desktopPrefContent}\n---\n${canonicalJson(dshAuSharedPrefs)}${preferencesDigest}${pluginsDigest}`,
  ).digest('hex');
  return hash.slice(0, 16);
}

/**
 * 启动时双基线防冲突判定：
 * - 仅云端有改动 -> 自动从云拉取 (pull)
 * - 仅本机有改动 -> 自动推送到仓库 (push)
 * - 双端同时改动 -> 暂停自动覆盖并报告冲突 (conflict)
 */
export function decideStartupOfficialSyncAction({
  cloudHash = '',
  lastSyncedHash = '',
  localHash = '',
  lastLocalHash = '',
} = {}) {
  const cloudChanged = Boolean(cloudHash && (!lastSyncedHash || cloudHash !== lastSyncedHash));
  if (!lastLocalHash) {
    if (cloudChanged) {
      return {
        action: 'pull',
        reason: lastSyncedHash ? 'cloud_changed_no_local_baseline' : 'initial_sync',
      };
    }
    return { action: 'init_local_baseline', reason: 'init_local_baseline' };
  }
  const localChanged = Boolean(localHash && localHash !== lastLocalHash);
  if (cloudChanged && localChanged) {
    return {
      action: 'conflict',
      reason: '检测到本机与云端均有未同步改动，已暂停自动覆盖，请手动选择「推送到云」或「立即从云同步」',
    };
  }
  if (cloudChanged) return { action: 'pull', reason: 'cloud_only_changed' };
  if (localChanged) return { action: 'push', reason: 'local_only_changed' };
  return { action: 'none', reason: 'in_sync' };
}

/**
 * 检查用户当前勾选的官方设置、本机偏好与云插件是否已全部与云端一致。
 * 用于双基线哈希同时变化（如清单 watchedFiles 升级或双端收敛到同一状态）时排除假冲突。
 */
export function areSelectedSyncItemsInSync({
  repoRoot = getRepoRoot(),
  dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh'),
  profile = '',
  selectedItems = ALL_OFFICIAL_SYNC_ITEM_IDS,
  selectedPreferences = ALL_PREFERENCE_SYNC_ITEM_IDS,
  selectedPlugins = null,
} = {}) {
  const itemSet = new Set(mapLegacyItemIds(selectedItems));
  if (itemSet.size > 0) {
    const officialItems = buildOfficialSyncItems({ repoRoot, dshHome, profile });
    for (const item of officialItems) {
      if (itemSet.has(item.id) && !item.inSync) return false;
    }
  }

  const prefSet = new Set(Array.isArray(selectedPreferences) ? selectedPreferences : []);
  if (prefSet.size > 0) {
    const prefItems = buildPreferenceSyncItems({ repoRoot, dshHome });
    for (const item of prefItems) {
      if (prefSet.has(item.id) && !item.inSync) return false;
    }
  }

  const pluginSet = new Set(Array.isArray(selectedPlugins) ? selectedPlugins : []);
  if (pluginSet.size > 0) {
    const pluginItems = buildCloudPluginSyncItems({ repoRoot, dshHome });
    for (const item of pluginItems) {
      if (pluginSet.has(item.id) && !item.inSync) return false;
    }
  }

  return true;
}

function mapLegacyItemIds(selectedItems) {
  if (!Array.isArray(selectedItems)) return [...ALL_OFFICIAL_SYNC_ITEM_IDS];
  return expandSyncItemIds(selectedItems);
}

export function isFullPatchSelection(selectedItems) {
  const set = new Set(mapLegacyItemIds(selectedItems));
  return OFFICIAL_SYNC_ITEMS
    .filter((item) => item.patchIds.length > 0)
    .every((item) => set.has(item.id));
}

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
    if (/^#/.test(line)) continue;
    if (current) current.lines.push(line);
  }
  if (current) blocks.push(current);
  return blocks.map((block) => ({ id: block.id, text: `${block.lines.join('\n').replace(/\s+$/, '')}\n` }));
}

export function upsertPatchBlock(patchText, blockText, patchId) {
  const escapedId = String(patchId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = new RegExp(`^- id: ${escapedId}\\r?\\n(?:(?!^- id: )[\\s\\S])*`, 'm');
  const nextBlock = `${String(blockText).trimEnd()}\n`;
  if (block.test(patchText)) return patchText.replace(block, nextBlock);
  return `${patchText.endsWith('\n') ? patchText : (patchText ? `${patchText}\n` : '')}${nextBlock}`;
}

function removeTopLevelPatchBlock(patchText, matchIds) {
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

/** 配置块的 name 以 "@deepseek-ai/ 开头即视为 DSH 官方插件配置；第三方插件块交给「其它云插件」同步。 */
function isOfficialDshBlock(blockText = '') {
  return /^\s+name:\s*["']?@deepseek-ai\//m.test(String(blockText));
}

function officialPackageName(blockText = '') {
  return (String(blockText).match(/^\s+name:\s*["']?(@deepseek-ai\/[^"'\s]+)/m) || [])[1] || '';
}

/**
 * 找出本机或云端里存在、但不在固定同步清单中的 DSH 官方配置块。
 * 用于界面末尾的「未分类的官方设置」：新出现的配置块默认不勾选，确认后再同步。
 */
export function discoverUnlistedOfficialBlocks({
  repoRoot = getRepoRoot(),
  dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh'),
  profile = '',
} = {}) {
  // 按动态清单解析方案并读取对应仓库 patch 模板。
  const safeProfile = resolveDshProfileId(profile, { repoRoot, allowNonSelectable: true });
  const known = new Set(OFFICIAL_SYNC_ITEMS.flatMap((item) => item.patchIds));
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  const sources = [
    read(path.join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml')),
    read(resolveRepoProfilePatchPath(repoRoot, safeProfile)),
  ];
  const found = new Map();
  for (const text of sources) {
    for (const block of extractTopLevelPatchBlocks(text)) {
      if (known.has(block.id) || found.has(block.id) || !isOfficialDshBlock(block.text)) continue;
      const id = DYNAMIC_PATCH_ITEM_PREFIX + block.id;
      if (!isDynamicPatchItemId(id)) continue;
      found.set(block.id, { id, blockId: block.id, packageName: officialPackageName(block.text) });
    }
  }
  return [...found.values()];
}

export function applySelectedOfficialPatchBlocks({
  currentPatchText = '',
  renderedProfilePatch = '',
  sourcePatchText = '',
  selectedItems = ALL_OFFICIAL_SYNC_ITEM_IDS,
}) {
  const effectiveSource = renderedProfilePatch || sourcePatchText;
  const isAllOfficialSelected = isFullPatchSelection(selectedItems);
  // 固定项按 patchIds、动态项 patch:<id> 去前缀，统一换算成要写入的配置块。
  const selectedPatchIds = resolveSelectedPatchIds(selectedItems);
  const allOfficialPatchIds = new Set(
    OFFICIAL_SYNC_ITEMS.flatMap((item) => item.patchIds)
  );

  let resultText = '';
  const sourceBlocks = extractTopLevelPatchBlocks(effectiveSource);
  const currentBlocks = extractTopLevelPatchBlocks(currentPatchText);

  if (isAllOfficialSelected) {
    resultText = effectiveSource;
    // 固定项与勾选的动态项用云端版本；其余块（未勾选的新配置块、第三方插件块）保留本机原样。
    for (const cur of currentBlocks) {
      if (!allOfficialPatchIds.has(cur.id) && !selectedPatchIds.has(cur.id) && cur.id !== 'dsh-au') {
        resultText = upsertPatchBlock(resultText, cur.text, cur.id);
      }
    }
    // 云端独有、本机没有、且未勾选的官方新配置块：不带到本机。
    const currentIds = new Set(currentBlocks.map((b) => b.id));
    for (const src of sourceBlocks) {
      if (!allOfficialPatchIds.has(src.id) && !selectedPatchIds.has(src.id) && !currentIds.has(src.id) && isOfficialDshBlock(src.text)) {
        resultText = removeTopLevelPatchBlock(resultText, [src.id]);
      }
    }
  } else {
    resultText = currentPatchText;
    for (const src of sourceBlocks) {
      if (selectedPatchIds.has(src.id)) {
        resultText = upsertPatchBlock(resultText, src.text, src.id);
      }
    }
  }

  // 确保 - id: dsh-au\n  disabled: false 始终存在
  if (!/^- id: dsh-au\b/m.test(resultText)) {
    resultText = `${resultText.endsWith('\n') ? resultText : `${resultText}\n`}- id: dsh-au\n  disabled: false\n`;
  }
  return resultText;
}

export function syncOfficialDesktopPreferences({
  repoRoot = getRepoRoot(),
  dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh'),
  enabled = true,
} = {}) {
  const targetPath = path.join(dshHome, 'desktop-preferences.json');
  if (!enabled) {
    return { updated: false, targetPath };
  }
  const envManifestPath = String(process.env.DSH_AU_PROFILES_MANIFEST_PATH || '').trim();
  if (!envManifestPath && !hasSyncRepo({ repoRoot })) {
    return { updated: false, targetPath };
  }
  // 从声明式清单读取桌面偏好源文件路径，不再写死仓库相对路径。
  const manifest = loadDshProfilesManifest(repoRoot);
  if (!manifest.desktopPreferencesFile) {
    return { updated: false, targetPath };
  }
  const sourcePath = path.join(repoRoot, ...manifest.desktopPreferencesFile.split('/').filter(Boolean));
  if (!fs.existsSync(sourcePath)) {
    return { updated: false, targetPath };
  }
  try {
    const cloudPrefs = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    let localPrefs = {};
    if (fs.existsSync(targetPath)) {
      try {
        localPrefs = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
      } catch {}
    }
    const merged = { ...(localPrefs && typeof localPrefs === 'object' ? localPrefs : {}), ...cloudPrefs };
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    return { updated: true, targetPath };
  } catch {
    return { updated: false, targetPath };
  }
}

/**
 * 把云端偏好同步到本机：
 * 8 项固定共享开关来自 cloud/dsh-au-preferences.json；
 * 仅当勾选对应本机设置项时，才从云端共享文件（dsh-au-preferences.json#shortcutOverrides / model-shortcuts.json）拉取并刷新单机备份；
 * 未勾选时保留本机值不被覆盖。
 */
export function syncOfficialDshAuPreferences({
  repoRoot = getRepoRoot(),
  dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh'),
  enabled = true,
  preferences = [],
} = {}) {
  const syncDir = resolveSyncDir({ repoRoot });
  const sourcePath = path.join(syncDir, 'cloud', 'dsh-au-preferences.json');
  const cloudModelShortcutsPath = path.join(syncDir, 'cloud', 'model-shortcuts.json');
  const targetPath = process.env.DSH_AU_CONFIG_PATH || path.join(dshHome, 'dsh-au.config.json');
  if (!enabled) {
    return { updated: false, targetPath };
  }
  const preferenceSet = new Set(Array.isArray(preferences) ? preferences : []);
  const hasOfficialPrefs = fs.existsSync(sourcePath);
  const hasCloudModelShortcuts = preferenceSet.has('modelShortcuts') && fs.existsSync(cloudModelShortcutsPath);
  if (!hasOfficialPrefs && !hasCloudModelShortcuts) {
    return { updated: false, targetPath };
  }
  try {
    const cloudPrefs = hasOfficialPrefs ? JSON.parse(fs.readFileSync(sourcePath, 'utf8')) : {};
    let localCfg = {};
    if (fs.existsSync(targetPath)) {
      try {
        localCfg = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
      } catch {}
    }
    const nextCfg = { ...(localCfg && typeof localCfg === 'object' ? localCfg : {}) };
    if (hasOfficialPrefs) {
      nextCfg.features = {
        ...(nextCfg.features && typeof nextCfg.features === 'object' ? nextCfg.features : {}),
        ...(typeof cloudPrefs.todo === 'boolean' ? { todo: cloudPrefs.todo } : {}),
        ...(typeof cloudPrefs.remoteManagement === 'boolean' ? { remoteManagement: cloudPrefs.remoteManagement } : {}),
        ...(typeof cloudPrefs.fullAccessByDefault === 'boolean' ? { fullAccessByDefault: cloudPrefs.fullAccessByDefault } : {}),
        // 只同步新建目标开关；不读取、迁移或改变任何旧目标。
        ...(typeof cloudPrefs.blockGoalCreation === 'boolean' ? { blockGoalCreation: cloudPrefs.blockGoalCreation } : {}),
        ...(typeof cloudPrefs.sidebarWorkbench === 'boolean' ? { sidebarWorkbench: cloudPrefs.sidebarWorkbench } : {}),
      };
      if (cloudPrefs.autoContinue && typeof cloudPrefs.autoContinue === 'object') {
        nextCfg.autoContinue = normalizeAutoContinue({
          ...(nextCfg.autoContinue && typeof nextCfg.autoContinue === 'object' ? nextCfg.autoContinue : {}),
          ...cloudPrefs.autoContinue,
        });
      }
      if (typeof cloudPrefs.windowRestoreEnabled === 'boolean') {
        nextCfg.windowState = {
          ...(nextCfg.windowState && typeof nextCfg.windowState === 'object' ? nextCfg.windowState : {}),
          enabled: cloudPrefs.windowRestoreEnabled,
        };
      }
      nextCfg.clientPreferences = {
        ...(nextCfg.clientPreferences && typeof nextCfg.clientPreferences === 'object' ? nextCfg.clientPreferences : {}),
        ...(typeof cloudPrefs.mobileEnabled === 'boolean' ? { mobileEnabled: cloudPrefs.mobileEnabled } : {}),
      };
    }

    // 仅在勾选对应项时从云端共享文件拉取并同步刷新单机备份；未勾选时保留本机值不变。
    if (preferenceSet.has('shortcuts')
      && cloudPrefs.shortcutOverrides
      && typeof cloudPrefs.shortcutOverrides === 'object'
      && !Array.isArray(cloudPrefs.shortcutOverrides)) {
      nextCfg.clientPreferences = {
        ...(nextCfg.clientPreferences && typeof nextCfg.clientPreferences === 'object' ? nextCfg.clientPreferences : {}),
        shortcutOverrides: cloudPrefs.shortcutOverrides,
      };
      try {
        saveMachinePreferences({ shortcutOverrides: cloudPrefs.shortcutOverrides });
      } catch {}
    }

    let modelShortcutsSynced = false;
    if (hasCloudModelShortcuts) {
      try {
        const raw = fs.readFileSync(cloudModelShortcutsPath, 'utf8');
        const parsed = raw.trim() ? JSON.parse(raw) : null;
        const normalized = normalizeModelShortcuts(parsed, { persisted: true });
        const shortcutsFilePath = process.env.DSH_AU_MODEL_SHORTCUTS_PATH || path.join(dshHome, 'model-shortcuts.json');
        saveModelShortcuts(normalized, { filePath: shortcutsFilePath });
        modelShortcutsSynced = true;
        try {
          saveMachinePreferences({ modelShortcuts: normalized });
        } catch {}
      } catch { /* 云端文件无效时保留本机值 */ }
    }

    // 没有官方偏好、也没有任何本机设置可写时，不要凭空创建空的配置文件。
    if (!hasOfficialPrefs && !fs.existsSync(targetPath) && Object.keys(nextCfg).length === 0) {
      return { updated: modelShortcutsSynced, targetPath, preferences: cloudPrefs, preferenceMigration: null };
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, `${JSON.stringify(nextCfg, null, 2)}\n`, 'utf8');
    return { updated: true, targetPath, preferences: cloudPrefs, preferenceMigration: null };
  } catch {
    return { updated: false, targetPath };
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * 归一化官方配置 patch 块以便与仓库快照做语义比对：
 * 忽略换行符、注释行、行尾空白差异，并把各类家目录路径与 `~~/.dsh` 统一归一化为 `~/.dsh`。
 */
function normalizeComparableOfficialBlock(blockText = '', homeDir = homedir()) {
  const portable = normalizePortableConfigPaths(String(blockText || ''), homeDir)
    .replace(/~~\/\.dsh/g, '~/.dsh')
    .replace(/\r\n/g, '\n');
  const lines = portable
    .split('\n')
    .filter((line) => !/^#/.test(line))
    .map((line) => line.replace(/[ \t]+$/g, ''))
    // YAML 行内数组 `[ text, image ]` 与 `[text, image]` 等价；GBU 目录同步会改写成后者，
    // 不能因此判成「本地与云不一致」。
    .map((line) => line.replace(/\[[ \t]+/g, '[').replace(/[ \t]+\]/g, ']'));
  return lines.join('\n').trim();
}

/**
 * 按 dsh-restore.mjs 对 Kiro 方案的同一规则判定是否启用了 Cursor ACP，
 * 以便未装 ACP 插件的纯 Kiro 机器在比对 `llm-providers` 时不产生误报。
 */
function hasLocalCursorAcpEnabled(dshHome) {
  const profileDir = path.join(dshHome, 'profiles', 'desktop');
  const pkgPath = path.join(profileDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return true;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = pkg?.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
    const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
    const cloudPlugins = readCloudPlugins();
    const acpPlugin = cloudPlugins.find((p) => (
      p?.id === 'dsh-acp-adapter'
      || p?.id === 'zaimokuza-dsh-acp-adapter'
      || p?.package === '@zaimokuza/dsh-acp-adapter'
    ));
    const pkgName = acpPlugin?.package || '@zaimokuza/dsh-acp-adapter';
    return Object.hasOwn(deps, pkgName) && bundles.includes(pkgName);
  } catch {
    return true;
  }
}

/**
 * 构建弹窗「DSH 官方设置」Tab 展示用的官方配置项清单：
 * 逐项对比本机实际配置文件与当前所选方案的云端快照，标注 `inSync` 与 `diffLabel`。
 */
export function buildOfficialSyncItems({
  repoRoot = getRepoRoot(),
  dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh'),
  profile = '',
} = {}) {
  const manifest = loadDshProfilesManifest(repoRoot);
  if (manifest.profiles.length === 0) {
    return [];
  }
  const safeProfile = resolveDshProfileId(profile, { repoRoot, allowNonSelectable: true });
  const profileEntry = manifest.profiles.find((p) => p.id === safeProfile) || null;
  const localPatchPath = path.join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml');
  const repoPatchPath = resolveRepoProfilePatchPath(repoRoot, safeProfile);

  const hasLocalPatch = fs.existsSync(localPatchPath);
  const localPatchText = hasLocalPatch ? fs.readFileSync(localPatchPath, 'utf8') : '';
  const localBlockMap = new Map(extractTopLevelPatchBlocks(localPatchText).map((b) => [b.id, b.text]));

  const hasRepoPatch = fs.existsSync(repoPatchPath);
  const repoPatchText = hasRepoPatch ? fs.readFileSync(repoPatchPath, 'utf8') : '';
  const repoBlockMap = new Map(extractTopLevelPatchBlocks(repoPatchText).map((b) => [b.id, b.text]));

  // 未启用 Cursor ACP 插件时，严格按清单声明的 profileEntry.acpFallback 移除 ACP 块并回退默认模型，不再保留硬编码兜底。
  const expectedBlockMap = new Map(repoBlockMap);
  if (!hasLocalCursorAcpEnabled(dshHome) && profileEntry?.acpFallback) {
    const removeBlocks = Array.isArray(profileEntry.acpFallback.removeBlocks) && profileEntry.acpFallback.removeBlocks.length > 0
      ? profileEntry.acpFallback.removeBlocks
      : ['dsh-acp-adapter'];
    for (const blockId of removeBlocks) {
      expectedBlockMap.delete(blockId);
    }
    const defaultModel = profileEntry.acpFallback.defaultModel;
    if (defaultModel && typeof defaultModel === 'object' && defaultModel.provider && defaultModel.model) {
      expectedBlockMap.set(
        'agent-default-model',
        `- id: agent-default-model\n  config:\n    provider: ${defaultModel.provider}\n    model: ${defaultModel.model}\n`,
      );
    }
  }

  const localDesktopPath = path.join(dshHome, 'desktop-preferences.json');
  const repoDesktopPath = manifest.desktopPreferencesFile
    ? path.join(repoRoot, ...manifest.desktopPreferencesFile.split('/').filter(Boolean))
    : '';

  // 动态项：不在固定清单里的官方配置块，排在固定项后面，默认不勾选。
  const dynamicItems = discoverUnlistedOfficialBlocks({ repoRoot, dshHome, profile: safeProfile }).map((found) => ({
    id: found.id,
    category: '未分类的官方设置',
    title: found.packageName || found.blockId,
    officialName: '',
    nonOfficial: !found.packageName,
    dynamic: true,
    patchIds: [found.blockId],
    defaultDiff: '新发现的 DSH 官方配置块',
    comparisons: [],
  }));
  const items = [...OFFICIAL_SYNC_ITEMS, ...dynamicItems].map((item) => {
    if (item.isDesktopPreferences) {
      if (!repoDesktopPath || !fs.existsSync(repoDesktopPath)) {
        return { ...item, inSync: true, diffLabel: '✓ 与云一致', diffDetails: [] };
      }
      if (!fs.existsSync(localDesktopPath)) {
        return {
          ...item,
          inSync: false,
          diffLabel: '本机暂无配置 / 云端有快照',
          diffDetails: ['本机缺少 desktop-preferences.json'],
        };
      }
      try {
        const cloudPrefs = JSON.parse(fs.readFileSync(repoDesktopPath, 'utf8'));
        const localPrefs = JSON.parse(fs.readFileSync(localDesktopPath, 'utf8'));
        const diffKeys = Object.keys(cloudPrefs || {}).filter(
          (key) => canonicalJson(localPrefs?.[key]) !== canonicalJson(cloudPrefs[key]),
        );
        const inSync = diffKeys.length === 0;
        return {
          ...item,
          inSync,
          diffLabel: inSync ? '✓ 与云一致' : `本地与云有 ${diffKeys.length} 项差异`,
          diffDetails: diffKeys,
        };
      } catch {
        return {
          ...item,
          inSync: false,
          diffLabel: '配置解析异常',
          diffDetails: ['desktop-preferences.json 解析失败'],
        };
      }
    }

    if (!hasRepoPatch) {
      return { ...item, inSync: true, diffLabel: '✓ 与云一致', diffDetails: [] };
    }
    if (!hasLocalPatch) {
      return {
        ...item,
        inSync: false,
        diffLabel: '本机暂无配置 / 云端有快照',
        diffDetails: ['本机缺少 cordis.patch.yml'],
      };
    }

    const diffBlocks = [];
    for (const patchId of item.patchIds) {
      const localNormalized = normalizeComparableOfficialBlock(localBlockMap.get(patchId) || '');
      const expectedNormalized = normalizeComparableOfficialBlock(expectedBlockMap.get(patchId) || '');
      if (localNormalized !== expectedNormalized) {
        diffBlocks.push(patchId);
      }
    }
    const inSync = diffBlocks.length === 0;
    return {
      ...item,
      inSync,
      diffLabel: inSync
        ? '✓ 与云一致'
        : (diffBlocks.length === 1 ? '本地与云不一致' : `本地与云有 ${diffBlocks.length} 项差异`),
      diffDetails: diffBlocks,
    };
  });
  // 每项附上逐字段的本机 / 云端值，供界面展开时只列出有差异的细项。
  return items.map((item) => ({
    ...item,
    fields: item.isDesktopPreferences
      ? buildJsonFields(readJsonSafe(localDesktopPath), repoDesktopPath ? readJsonSafe(repoDesktopPath) : null)
      : buildPatchFields(item.patchIds, localBlockMap, expectedBlockMap),
  }));
}

function readJsonSafe(file) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; } catch { return null; }
}

/** 把一个配置块拍平成「键路径 → 值」，跳过 id / name 行与注释，并对明文凭据打码。 */
function flattenPatchBlock(blockText = '') {
  const out = new Map();
  const stack = [];
  for (const raw of normalizeComparableOfficialBlock(blockText).split('\n')) {
    // 跳过空行、块头 `- id:` 和块级 `name:`（插件包名，不是设置）。
    if (!raw.trim() || /^- id:/.test(raw) || (/^\s{2}name:\s/.test(raw) && stack.length === 0)) continue;
    const indent = raw.match(/^ */)[0].length;
    const line = raw.trim().replace(/^-\s+/, '');
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const kv = line.match(/^([\w".@/-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].replace(/"/g, '');
    let value = kv[2];
    if (value === '') { stack.push({ indent, key }); continue; }
    // 明文凭据打码；环境变量引用 ${X} 与 apiKeyEnv 这类变量名保留原样。
    if (/key|token|secret|password/i.test(key) && !/^\$\{/.test(value) && !/Env$/.test(key)) value = '***';
    const pathKey = [...stack.map((x) => x.key), key].filter((k) => k !== 'config').join('.');
    out.set(pathKey, value);
  }
  return out;
}

/**
 * 细项的官方中文名与官方默认值。中文名取自 DSH 安装包界面文字；
 * 默认值沿用 dsh-au 已记录的官方默认，未记录的留空（界面显示「未记录」）。
 */
const OFFICIAL_FIELD_META = Object.freeze({
  'ui-theme': {
    fontSize: { label: '字号大小', def: '14' },
    codeFontSize: { label: '代码字号', def: '13' },
    terminalFontSize: { label: '终端字号', def: '14' },
  },
  'ui-chat': {
    transcriptView: { label: '你希望看到多少工作过程？' },
    performanceUsage: { label: '性能与耗时统计（非官方名称）', def: '简略' },
    linkOpening: { label: '链接打开方式（非官方名称）', def: '当前窗口' },
  },
  'ui-settings-account': {
    usage: { label: '用量显示样式（非官方名称）', def: '标准卡片' },
    purpose: { label: '你希望帮你做什么？' },
    process: { label: '你希望看到多少工作过程？' },
    step: { label: '新手引导进度（非官方名称）' },
    completion: { label: '充值引导（非官方名称）' },
    version: { label: '新手引导版本（非官方名称）' },
    developerTools: { label: '开发者工具（非官方名称）' },
  },
  'session-log-deepseek': { enabled: { label: '上传会话日志', def: 'true' } },
  'subagent-model-selection-settings': {
    enabled: { label: '允许 Agent 为子智能体选择模型', def: 'false' },
    'allowedModels.provider': { label: 'Agent 可选择的模型：提供商' },
    'allowedModels.model': { label: 'Agent 可选择的模型：模型' },
  },
  permission: {
    defaultPreset: { label: '新会话的默认权限模式', def: 'workspace-write' },
    'presets.read-only.sandbox': { label: '「仅可查看」沙箱范围' },
    'presets.read-only.approval': { label: '「仅可查看」审批方式' },
    'presets.workspace-write.sandbox': { label: '「工作区内修改」沙箱范围' },
    'presets.workspace-write.approval': { label: '「工作区内修改」审批方式' },
    'presets.danger-full-access.sandbox': { label: '「完全权限」沙箱范围' },
    'presets.danger-full-access.approval': { label: '「完全权限」审批方式' },
  },
  'dsh-acp-adapter': {
    disabled: { label: 'Cursor ACP 适配器：停用（非官方名称）' },
    'agents.cursor.name': { label: 'Cursor Agent：显示名（非官方名称）' },
    'agents.cursor.command': { label: 'Cursor Agent：启动命令（非官方名称）' },
    'agents.cursor.args': { label: 'Cursor Agent：启动参数（非官方名称）' },
    'agents.cursor.env': { label: 'Cursor Agent：环境变量（非官方名称）' },
    'agents.cursor.loginHint': { label: 'Cursor Agent：登录提示（非官方名称）' },
    'agents.cursor.catalogId': { label: 'Cursor Agent：模型目录（非官方名称）' },
    toolApprovalDefault: { label: 'ACP 工具调用默认审批（非官方名称）' },
  },
  'agent-default-model': {
    provider: { label: '默认模型：提供商', def: '官方默认' },
    model: { label: '默认模型：模型', def: '官方默认' },
    reasoningEffort: { label: '默认模型：推理等级', def: '官方默认' },
  },
  'desktop-preferences': {
    closeToTray: { label: '关闭窗口后保持后台运行', def: 'false' },
    browserAccess: { label: '允许在浏览器中打开' },
    networkExposure: { label: '局域网访问（需要 HTTPS）', def: '"local"' },
    notifications: { label: '启用桌面通知' },
    turnCompleted: { label: '本轮任务完成' },
    turnFailed: { label: '本轮任务失败' },
    jobCompleted: { label: '后台任务完成' },
    jobFailed: { label: '后台任务失败' },
    scheduleCompleted: { label: '自动化任务完成' },
    scheduleFailed: { label: '自动化任务失败' },
    windowsMaterial: { label: '窗口材质（Windows）' },
    macosMaterial: { label: '窗口材质（macOS）' },
    linuxMaterial: { label: '窗口材质（Linux）' },
    logLevel: { label: '日志级别' },
    developerLogging: { label: '开发者日志' },
    port: { label: '本机访问端口（非官方名称，界面未展示）' },
    lanPort: { label: '局域网访问端口（非官方名称，界面未展示）' },
    sidebarFooterCompat: { label: '侧边栏底部图标横向排列' },
    sidebarFooterBalanced: { label: '多行图标均衡排列' },
  },
});

/**
 * 读取细项元数据。label 末尾的「（非官方名称…）」只是维护时的标记：
 * 这里剥掉后缀并返回 nonOfficial: true，界面改用绿色字体区分，不再把后缀显示出来。
 */
function fieldMeta(scope, key) {
  const meta = OFFICIAL_FIELD_META[scope]?.[key];
  if (!meta) return null;
  const m = String(meta.label || '').match(/^(.*?)（非官方名称[^）]*）$/);
  return m ? { ...meta, label: m[1], nonOfficial: true } : { ...meta, nonOfficial: false };
}

/** 常见取值的中文翻译（取自 DSH 界面文字），显示为「中文（原值）」，方便对照配置文件。 */
const VALUE_LABELS = Object.freeze({
  'read-only': '仅可查看',
  'workspace-write': '工作区内修改',
  'danger-full-access': '完全权限',
  ask: '每次询问',
  never: '从不询问',
  auto: '自动',
  true: '开启',
  false: '关闭',
  standard: '关键细节',
  focused: '聚焦结果',
  detailed: '详细',
  compact: '紧凑',
  'new-tab': '新标签页',
  '"lan"': '局域网',
  '"local"': '仅本机',
  '"off"': '纯色背景',
  '"transparent"': '玻璃背景',
  '"info"': '信息',
  low: '低',
  medium: '中',
  high: '高',
  done: '已完成',
  skipped: '已跳过',
  null: '未选择',
});

function translateValue(value) {
  if (value === null || value === undefined) return value;
  const label = VALUE_LABELS[String(value)];
  return label ? `${label}（${String(value).replace(/^"|"$/g, '')}）` : value;
}

/**
 * 模型提供商列表按 DSH「模型」设置页的粒度汇总：每个提供商一行（显示名 + 模型数），
 * 不逐个展开 baseURL、模型 ID 等细节。任一细节不同时，该提供商整行标为差异。
 */
function summarizeProviders(blockText = '') {
  const flat = flattenPatchBlock(blockText);
  const providers = new Map();
  for (const [key, value] of flat) {
    const m = key.match(/^providers\.([^.]+)\.(.+)$/);
    if (!m) continue;
    const [, pid, rest] = m;
    if (!providers.has(pid)) providers.set(pid, { displayName: '', models: 0, signature: [] });
    const p = providers.get(pid);
    if (rest === 'displayName') p.displayName = value.replace(/^"|"$/g, '');
    if (rest === 'models.id') p.models += 1;
    p.signature.push(`${rest}=${value}`);
  }
  // models.id 在拍平时会被同名键覆盖，模型数改按原文统计。
  const text = normalizeComparableOfficialBlock(blockText);
  let current = '';
  for (const p of providers.values()) p.models = 0;
  for (const line of text.split('\n')) {
    const head = line.match(/^ {6}([a-z0-9][\w-]*):\s*$/i);
    if (head) { current = head[1]; continue; }
    if (current && providers.has(current) && /^ {10}- id:/.test(line)) providers.get(current).models += 1;
  }
  const out = new Map();
  for (const [pid, p] of providers) {
    out.set(pid, { text: `${p.displayName || pid}（${p.models} 个模型）`, signature: `${p.models}|${p.signature.join('|')}` });
  }
  return out;
}

function buildProviderFields(localText, cloudText) {
  const local = summarizeProviders(localText);
  const cloud = summarizeProviders(cloudText);
  return [...new Set([...local.keys(), ...cloud.keys()])].map((pid) => {
    const l = local.get(pid);
    const c = cloud.get(pid);
    const same = Boolean(l && c && l.signature === c.signature);
    return {
      key: `llm-pi-ai.providers.${pid}`,
      label: `模型提供商：${(l || c).text.replace(/（\d+ 个模型）$/, '')}`,
      // 「模型提供商」是 DSH 模型页的官方叫法，提供商名来自用户自己的配置。
      nonOfficial: false,
      officialDefault: null,
      local: l ? l.text : null,
      // 显示文字相同但细节不同（如 baseURL、模型清单）时，在云端值后注明，确保仍判为差异。
      cloud: c ? (l && !same && l.text === c.text ? `${c.text}，细节不同` : c.text) : null,
    };
  });
}

function buildPatchFields(patchIds = [], localBlockMap, cloudBlockMap) {
  const fields = [];
  for (const patchId of patchIds) {
    if (patchId === 'llm-pi-ai') {
      fields.push(...buildProviderFields(localBlockMap.get(patchId) || '', cloudBlockMap.get(patchId) || ''));
      continue;
    }
    const local = flattenPatchBlock(localBlockMap.get(patchId) || '');
    const cloud = flattenPatchBlock(cloudBlockMap.get(patchId) || '');
    for (const key of new Set([...local.keys(), ...cloud.keys()])) {
      const meta = fieldMeta(patchId, key);
      fields.push({
        key: `${patchId}.${key}`,
        label: meta?.label || (patchIds.length > 1 ? `${patchId} · ${key}` : key),
        // 没有映射（显示原始键名）或映射到非官方叫法时都标 nonOfficial，界面显示为绿色。
        nonOfficial: !meta || meta.nonOfficial,
        officialDefault: translateValue(meta?.def ?? null),
        local: local.has(key) ? translateValue(local.get(key)) : null,
        cloud: cloud.has(key) ? translateValue(cloud.get(key)) : null,
      });
    }
  }
  return fields;
}

/** 桌面偏好只比对云端有的键（与 inSync 判定一致）；本机独有的键标为 local-only 不计入差异。 */
function buildJsonFields(localPrefs, cloudPrefs) {
  if (!localPrefs && !cloudPrefs) return [];
  const keys = new Set([...Object.keys(cloudPrefs || {}), ...Object.keys(localPrefs || {})]);
  return [...keys].map((key) => ({
    key,
    label: fieldMeta('desktop-preferences', key)?.label || key,
    nonOfficial: !fieldMeta('desktop-preferences', key) || fieldMeta('desktop-preferences', key).nonOfficial,
    officialDefault: translateValue(fieldMeta('desktop-preferences', key)?.def ?? null),
    local: localPrefs && key in localPrefs ? translateValue(canonicalJson(localPrefs[key])) : null,
    cloud: cloudPrefs && key in cloudPrefs ? translateValue(canonicalJson(cloudPrefs[key])) : null,
    localOnly: Boolean(cloudPrefs && !(key in cloudPrefs)),
  }));
}

/**
 * 一次生成清单内所有还原方案的官方设置对比状态，供弹窗切换「模型方案」下拉框时即时更新徽章。
 */
export function buildOfficialSyncItemsByProfile({
  repoRoot = getRepoRoot(),
  dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh'),
} = {}) {
  const manifest = loadDshProfilesManifest(repoRoot);
  return Object.fromEntries(
    manifest.profiles.map((p) => [p.id, buildOfficialSyncItems({ repoRoot, dshHome, profile: p.id })]),
  );
}

/**
 * 构建弹窗「本机设置」对比清单：
 * 对比当前电脑的实际快捷键/模型快捷槽位与云端共享文件
 * （cloud/dsh-au-preferences.json#shortcutOverrides 与 cloud/model-shortcuts.json）。
 */
export function buildPreferenceSyncItems({
  repoRoot = resolveSyncRepoRoot() || getRepoRoot(),
  dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh'),
} = {}) {
  const syncDir = resolveSyncDir({ repoRoot });
  const dshAuPrefPath = path.join(syncDir, 'cloud', 'dsh-au-preferences.json');
  const cloudModelShortcutsPath = path.join(syncDir, 'cloud', 'model-shortcuts.json');

  const auCfgPath = process.env.DSH_AU_CONFIG_PATH || path.join(dshHome, 'dsh-au.config.json');
  let localAuCfg = {};
  try {
    if (fs.existsSync(auCfgPath)) localAuCfg = JSON.parse(fs.readFileSync(auCfgPath, 'utf8'));
  } catch {}
  const localShortcuts = localAuCfg?.clientPreferences?.shortcutOverrides
    && typeof localAuCfg.clientPreferences.shortcutOverrides === 'object'
    && !Array.isArray(localAuCfg.clientPreferences.shortcutOverrides)
    ? localAuCfg.clientPreferences.shortcutOverrides
    : {};

  let cloudPrefs = null;
  try {
    if (fs.existsSync(dshAuPrefPath)) cloudPrefs = JSON.parse(fs.readFileSync(dshAuPrefPath, 'utf8'));
  } catch {}
  const hasCloudShortcuts = Boolean(
    cloudPrefs
    && cloudPrefs.shortcutOverrides
    && typeof cloudPrefs.shortcutOverrides === 'object'
    && !Array.isArray(cloudPrefs.shortcutOverrides),
  );
  const cloudShortcuts = hasCloudShortcuts ? cloudPrefs.shortcutOverrides : {};

  const shortcutsFilePath = process.env.DSH_AU_MODEL_SHORTCUTS_PATH || path.join(dshHome, 'model-shortcuts.json');
  const localModelShortcuts = readModelShortcuts({ filePath: shortcutsFilePath }).modelShortcuts;

  let cloudModelShortcuts = null;
  let hasCloudModelShortcuts = false;
  if (fs.existsSync(cloudModelShortcutsPath)) {
    try {
      const raw = fs.readFileSync(cloudModelShortcutsPath, 'utf8');
      const parsed = raw.trim() ? JSON.parse(raw) : null;
      cloudModelShortcuts = normalizeModelShortcuts(parsed, { persisted: true });
      hasCloudModelShortcuts = true;
    } catch {
      cloudModelShortcuts = null;
      hasCloudModelShortcuts = false;
    }
  }

  return PREFERENCE_SYNC_ITEMS.map((item) => {
    if (item.id === 'shortcuts') {
      const inSync = hasCloudShortcuts
        ? canonicalJson(localShortcuts) === canonicalJson(cloudShortcuts)
        : Object.keys(localShortcuts).length === 0;
      const diffLabel = inSync
        ? '✓ 与云一致'
        : (hasCloudShortcuts ? '本地与云共享不一致' : '本机有修改 / 云端暂无共享');
      return {
        ...item,
        inSync,
        hasCloud: hasCloudShortcuts,
        diffLabel,
        cloudValue: hasCloudShortcuts ? cloudShortcuts : null,
        localValue: localShortcuts,
      };
    }

    if (item.id === 'modelShortcuts') {
      const inSync = hasCloudModelShortcuts
        ? canonicalJson(localModelShortcuts) === canonicalJson(cloudModelShortcuts)
        : false;
      const diffLabel = inSync
        ? '✓ 与云一致'
        : (hasCloudModelShortcuts ? '本地与云共享不一致' : '云端暂无共享配置');
      return {
        ...item,
        inSync,
        hasCloud: hasCloudModelShortcuts,
        diffLabel,
        cloudValue: hasCloudModelShortcuts ? cloudModelShortcuts : null,
        localValue: localModelShortcuts,
      };
    }

    return { ...item, inSync: true, hasCloud: true, diffLabel: '✓ 与云一致' };
  });
}

function summarizePluginConfigText(packageName, configText = '') {
  const clean = String(configText || '').trim();
  if (!clean) return '仅同步安装与启用状态（无独立配置块）';
  if (packageName.includes('dsh-continue')) {
    if (/^s+disabled:s*true/m.test(clean)) return '已停用（由 dsh-au 内建智能续跑替代）';
    const ruleIds = [...clean.matchAll(/^\s*-\s+id:\s+([^\s#]+)/gm)]
      .map((m) => m[1])
      .filter((id) => id !== 'dsh-continue');
    return ruleIds.length > 0
      ? `含 ${ruleIds.length} 条自动续跑规则（${ruleIds.join('、')}）`
      : '含自动续跑配置块';
  }
  if (packageName.includes('dsh-acp-adapter')) {
    return '含 Cursor / Antigravity ACP 代理路由与审批设置';
  }
  const lineCount = clean.split(/\r?\n/).length;
  return `含独立配置块（共 ${lineCount} 行）`;
}

function normalizeComparablePluginBlock(blockText = '', homeDir = homedir()) {
  const portable = normalizePortableConfigPaths(String(blockText || ''), homeDir);
  const cleaned = portable
    .replace(/\\\r?\n[ \t]*(?=\\\\)/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/^  disabled:[ \t]*(?:true|false)[ \t]*\n/gm, '')
    .trim();
  if (!cleaned) return '';
  const bodyLines = cleaned
    .split('\n')
    .slice(1)
    .filter((line) => line.trim() && !/^  name:\s*/.test(line));
  return bodyLines.length === 0 ? '' : `${cleaned}\n`;
}

function cleanPluginVersion(value) {
  return String(value || '').trim().replace(/^[\^~>=<]+\s*/, '').replace(/\+.*$/, '');
}

function parsePluginVersion(value) {
  const match = cleanPluginVersion(value).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split('.') : null,
  };
}

function comparePrerelease(left, right) {
  if (!left && !right) return 0;
  // 正式版高于预发布版。
  if (!left) return 1;
  if (!right) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left[index]);
    const rightNumeric = /^\d+$/.test(right[index]);
    if (leftNumeric && rightNumeric) {
      const diff = Number(left[index]) - Number(right[index]);
      if (diff) return diff > 0 ? 1 : -1;
    } else if (leftNumeric) return -1;
    else if (rightNumeric) return 1;
    else if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

/** 1 表示左边更新，-1 表示更旧，0 表示相同；认不出的版本返回 null，留给手动同步。 */
export function comparePluginVersions(left, right) {
  const a = parsePluginVersion(left);
  const b = parsePluginVersion(right);
  if (!a || !b) return null;
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  return comparePrerelease(a.pre, b.pre);
}

/**
 * 启动时把「本机已经更新、启用和配置都没变」的插件版本写上云。
 * 只改版本号。配置不同、本机更旧、或没有勾选同步时保持手动。
 */
export function pushNewerInstalledPluginVersions({
  repoRoot = getRepoRoot(),
  dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh'),
  selectedPlugins = null,
} = {}) {
  if (!hasSyncRepo({ repoRoot })) return { ok: true, skipped: true, updated: [] };
  const syncDir = resolveSyncDir({ repoRoot });
  const manifestPath = path.join(syncDir, 'cloud', 'manifest.cloud.json');
  if (!fs.existsSync(manifestPath)) return { ok: true, skipped: true, updated: [] };
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return { ok: false, updated: [], error: '云插件清单无法读取' };
  }
  const plugins = manifest.plugins && typeof manifest.plugins === 'object' ? manifest.plugins : {};
  const selected = Array.isArray(selectedPlugins) ? new Set(selectedPlugins) : null;
  const profileDir = path.join(dshHome, 'profiles', 'desktop');
  const packagePath = path.join(profileDir, 'package.json');
  let pkg = {};
  try {
    if (fs.existsSync(packagePath)) pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  } catch {}
  const dependencies = pkg?.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
  const enabledBundles = new Set(Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []);
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  const patchText = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : '';
  const patchBlocks = extractTopLevelPatchBlocks(patchText);
  const bundles = readPluginBundles(repoRoot);
  const updated = [];

  for (const [id, plugin] of Object.entries(plugins)) {
    if (!plugin || typeof plugin.package !== 'string') continue;
    if (selected && !selected.has(id)) continue;
    const bundle = bundles.byPackage.get(plugin.package);
    const snapshot = bundle?.manifest;
    if (!snapshot) continue;
    const isLocalPlugin = plugin.source === 'local'
      || snapshot.source?.type === 'local'
      || snapshot.source?.type === 'local-repo';
    if (isLocalPlugin) continue;
    if (!Object.hasOwn(dependencies, plugin.package)) continue;
    const installed = readPluginPackageMeta(profileDir, plugin.package);
    if (!installed.installed) continue;
    const cloudVersion = snapshot.version || plugin.version || '';
    if (comparePluginVersions(installed.version, cloudVersion) !== 1) continue;

    const cloudEnabled = snapshot.enabled !== undefined ? Boolean(snapshot.enabled) : true;
    const patchId = snapshot.patchId || plugin.id || id;
    const localBlock = patchBlocks.find((block) => block.id === patchId || block.id === id || block.id === plugin.package.split('/').pop());
    const localDisabled = Boolean(localBlock && /^\s+disabled:\s*true\b/m.test(localBlock.text));
    const localEnabled = enabledBundles.has(plugin.package) && !localDisabled;
    if (localEnabled !== cloudEnabled) continue;
    const hasConfig = Boolean(snapshot.hasConfig && bundle.configText);
    const configDiff = hasConfig
      ? normalizeComparablePluginBlock(localBlock?.text || '') !== normalizeComparablePluginBlock(bundle.configText || '')
      : false;
    if (configDiff) continue;

    const written = updatePluginBundleVersion({ repoRoot, packageName: plugin.package, version: installed.version });
    plugin.version = written.manifest.version || installed.version;
    updated.push({ id, package: plugin.package, from: cloudVersion, to: plugin.version });
  }

  if (updated.length > 0) {
    manifest.updatedAt = new Date().toISOString();
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  return { ok: true, updated };
}

/**
 * 找出「已勾选同步但本机未安装或版本落后于云端」的云插件（含 profile-managed 托管插件如 ACP）。
 * 供启动自动同步在后台异步追齐云端版本使用，避免阻塞启动流程。
 */
export function findOutdatedCloudPlugins({
  repoRoot = getRepoRoot(),
  dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh'),
  selectedPlugins = null,
  profile = '',
  platform = process.platform,
} = {}) {
  if (!hasSyncRepo({ repoRoot })) return [];
  const safeProfile = resolveDshProfileId(profile, { repoRoot, allowNonSelectable: true });
  const cloudPlugins = readCloudPlugins().filter((p) => p && typeof p.id === 'string' && typeof p.package === 'string');
  const selected = Array.isArray(selectedPlugins) ? new Set(selectedPlugins) : null;
  const bundles = readPluginBundles(repoRoot);
  const profileDir = path.join(dshHome, 'profiles', 'desktop');
  if (!fs.existsSync(path.join(profileDir, 'package.json'))) return [];

  const outdated = [];
  for (const plugin of cloudPlugins) {
    if (selected && !selected.has(plugin.id)) continue;
    if (Array.isArray(plugin.platforms) && !plugin.platforms.includes(platform)) continue;
    if (plugin.requiresDshProfile && plugin.requiresDshProfile !== safeProfile) continue;

    const snapshot = bundles.byPackage.get(plugin.package)?.manifest;
    const isProfileManaged = plugin.activation === 'profile-managed';
    // 普通插件若在云快照中显式禁用，无需自动下载安装。
    if (!isProfileManaged && snapshot?.enabled === false) continue;

    const cloudVersion = String(snapshot?.version || plugin.version || '').trim();
    if (!cloudVersion && plugin.source !== 'local') continue;

    const installed = readPluginPackageMeta(profileDir, plugin.package);
    if (!installed.installed) {
      outdated.push({
        id: plugin.id,
        name: plugin.name || plugin.package,
        package: plugin.package,
        source: plugin.source || 'npm',
        localVersion: '',
        cloudVersion,
        profileManaged: isProfileManaged,
        reason: 'not_installed',
        plugin: { ...plugin, ...(cloudVersion ? { version: cloudVersion } : {}) },
      });
      continue;
    }

    if (cloudVersion && comparePluginVersions(installed.version, cloudVersion) === -1) {
      outdated.push({
        id: plugin.id,
        name: plugin.name || plugin.package,
        package: plugin.package,
        source: plugin.source || 'npm',
        localVersion: installed.version || '',
        cloudVersion,
        profileManaged: isProfileManaged,
        reason: 'outdated',
        plugin: { ...plugin, version: cloudVersion },
      });
    }
  }
  return outdated;
}

/**
 * 构建弹窗「云插件与配置」Tab 展示用的云插件对比清单：
 * 包含每个云插件的启用状态、版本、是否有独立 config.yml 以及「与云一致 / 具体差异原因」标签。
 */
export function buildCloudPluginSyncItems({
  repoRoot = getRepoRoot(),
  dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh'),
} = {}) {
  const cloudPlugins = readCloudPlugins().filter((p) => p && typeof p.id === 'string' && typeof p.package === 'string');
  const bundles = readPluginBundles(repoRoot);
  const profileDir = path.join(dshHome, 'profiles', 'desktop');
  const packagePath = path.join(profileDir, 'package.json');
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  let pkg = {};
  try {
    if (fs.existsSync(packagePath)) pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  } catch {}
  const dependencies = pkg?.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
  const enabledBundles = new Set(Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []);
  const patchText = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : '';
  const patchBlocks = extractTopLevelPatchBlocks(patchText);

  return cloudPlugins.map((plugin) => {
    const bundle = bundles.byPackage.get(plugin.package);
    const manifest = bundle?.manifest || {};
    const cloudEnabled = manifest.enabled !== undefined ? Boolean(manifest.enabled) : true;
    const cloudVersion = manifest.version || plugin.version || '0.1.0';
    const hasConfig = Boolean(manifest.hasConfig && bundle?.configText);
    const patchId = manifest.patchId || plugin.id;
    const localBlock = patchBlocks.find((b) => b.id === patchId || b.id === plugin.id || b.id === plugin.package.split('/').pop());
    const localPatchDisabled = Boolean(localBlock && /^\s+disabled:\s*true\b/m.test(localBlock.text));
    const localInstalled = Object.hasOwn(dependencies, plugin.package);
    const localEnabled = localInstalled && enabledBundles.has(plugin.package) && !localPatchDisabled;
    // 对比用实际装上的版本。依赖里的 ^1.2.0 不能当成已经安装的版本。
    const installed = readPluginPackageMeta(profileDir, plugin.package);
    const localVersion = installed.installed ? installed.version : (dependencies[plugin.package] || '');
    const configSummary = summarizePluginConfigText(plugin.package, bundle?.configText || '');

    const cleanLocalVer = cleanPluginVersion(localVersion);
    const cleanCloudVer = cleanPluginVersion(cloudVersion);
    const versionOrder = comparePluginVersions(cleanLocalVer, cleanCloudVer);
    const versionDiff = Boolean(localInstalled && cleanLocalVer && cleanCloudVer && (
      versionOrder === null ? cleanLocalVer !== cleanCloudVer : versionOrder !== 0
    ));
    const enabledDiff = !localInstalled ? cloudEnabled : (localEnabled !== cloudEnabled);
    const configDiff = hasConfig
      ? normalizeComparablePluginBlock(localBlock?.text || '') !== normalizeComparablePluginBlock(bundle?.configText || '')
      : false;

    const diffReasons = [];
    if (!localInstalled && cloudEnabled) {
      diffReasons.push('本机未安装 / 云启用');
    } else if (enabledDiff) {
      diffReasons.push(`本机${localEnabled ? '启用' : '停用'} / 云${cloudEnabled ? '启用' : '停用'}`);
    }
    if (versionDiff) {
      diffReasons.push(`本机 v${cleanLocalVer} / 云 v${cleanCloudVer}`);
    }
    if (configDiff) {
      diffReasons.push('配置不同');
    }
    const inSync = diffReasons.length === 0;
    const diffLabel = inSync ? '✓ 与云一致' : diffReasons.join(' · ');

    return {
      id: plugin.id,
      package: plugin.package,
      category: plugin.package === 'dsh-au' ? '自研插件' : '云插件',
      title: plugin.name || plugin.package,
      hasConfig,
      cloudEnabled,
      cloudVersion,
      localInstalled,
      localEnabled,
      localVersion,
      inSync,
      diffLabel,
      defaultDiff: `云端：${cloudEnabled ? '启用' : '停用'} (v${cloudVersion}) · ${hasConfig ? configSummary : '仅安装与启用状态'}`,
      comparisons: [
        {
          label: '插件启用状态 (enabled)',
          defaultValue: localInstalled ? (localEnabled ? '本机：启用中 (true)' : '本机：已停用 (false)') : '本机：未安装',
          currentValue: cloudEnabled ? '云端：启用 (true)' : '云端：停用 (false)',
        },
        {
          label: '插件版本与来源',
          defaultValue: localInstalled ? `本机：v${localVersion}` : '本机：未安装',
          currentValue: `云端：v${cloudVersion} (${plugin.source === 'local' ? '本地软链' : 'npm'})`,
        },
        {
          label: '插件配置快照 (config.yml)',
          defaultValue: localBlock ? '本机：已有配置块' : '本机：无独立配置块',
          currentValue: `云端：${configSummary}`,
        },
      ],
    };
  });
}

export function pushLocalOfficialSettingsToRepo({
  repoRoot = getRepoRoot(),
  dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh'),
  profile = '',
  selectedItems = ALL_OFFICIAL_SYNC_ITEM_IDS,
  selectedPlugins = null,
  syncPluginConfigs = null,
  clientPreferences = null,
  selectedPreferences = [],
  syncDshAuPreferences = true,
  removeUninstalledPlugins = true,
} = {}) {
  const manifest = loadDshProfilesManifest(repoRoot);
  const safeProfile = resolveDshProfileId(profile, { repoRoot, allowNonSelectable: true });
  const selectedSet = new Set(mapLegacyItemIds(selectedItems));
  const localPatchPath = path.join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml');
  const updatedPatchIds = [];
  const skippedCredentialPatchIds = [];

  if (fs.existsSync(localPatchPath)) {
    // 使用清单声明的 pathNormalizations 统一归一化本机绝对路径，不再硬编码 wrapper 文件名。
    const rawLocal = normalizeLocalPatchPaths(fs.readFileSync(localPatchPath, 'utf8'), manifest);
    const localBlocks = extractTopLevelPatchBlocks(rawLocal);
    const localMap = new Map(localBlocks.map((b) => [b.id, b.text]));

    // 仅模型供应商/目录/默认模型项 (llm-providers) 区分方案；其余通用设置同步写入清单中全部方案快照
    for (const targetEntry of manifest.profiles) {
      const repoPatchPath = resolveRepoProfilePatchPath(repoRoot, targetEntry.id);
      if (!fs.existsSync(repoPatchPath)) continue;
      let repoText = fs.readFileSync(repoPatchPath, 'utf8');
      const eol = repoText.includes('\r\n') ? '\r\n' : '\n';
      repoText = repoText.replace(/\r\n/g, '\n');

      // 动态发现的官方配置块与通用设置一样写入全部方案快照。
      const dynamicPatchItems = [...selectedSet]
        .filter(isDynamicPatchItemId)
        .map((id) => ({ id, patchIds: [id.slice(DYNAMIC_PATCH_ITEM_PREFIX.length)] }));
      for (const item of [...OFFICIAL_SYNC_ITEMS, ...dynamicPatchItems]) {
        if (!selectedSet.has(item.id)) continue;
        if (item.id === 'llm-providers' && targetEntry.id !== safeProfile) continue;
        for (const patchId of item.patchIds) {
          const block = localMap.get(patchId);
          if (block) {
            if (findPlaintextCredentialIssue(block)) {
              if (!skippedCredentialPatchIds.includes(patchId)) skippedCredentialPatchIds.push(patchId);
              continue;
            }
            repoText = upsertPatchBlock(repoText, block, patchId);
            if (!updatedPatchIds.includes(patchId)) updatedPatchIds.push(patchId);
          }
        }
      }
      fs.writeFileSync(repoPatchPath, repoText.replace(/\n/g, eol), 'utf8');
    }
  }

  let desktopUpdated = false;
  if (selectedSet.has('desktop-preferences') && manifest.desktopPreferencesFile) {
    const localDesktopPath = path.join(dshHome, 'desktop-preferences.json');
    const repoDesktopPath = path.join(repoRoot, ...manifest.desktopPreferencesFile.split('/').filter(Boolean));
    if (fs.existsSync(localDesktopPath)) {
      fs.mkdirSync(path.dirname(repoDesktopPath), { recursive: true });
      fs.copyFileSync(localDesktopPath, repoDesktopPath);
      desktopUpdated = true;
    }
  }

  // 同步已勾选云插件的「本机启用状态 + 插件配置快照」到仓库 dsh-au/sync/plugins/<slug>/
  const updatedPlugins = [];
  const removedPlugins = [];
  const skippedCredentialPlugins = [];
  const profileDir = path.join(dshHome, 'profiles', 'desktop');
  const packagePath = path.join(profileDir, 'package.json');
  if (fs.existsSync(packagePath)) {
    const cloudPlugins = readCloudPlugins().filter((p) => p && typeof p.id === 'string' && typeof p.package === 'string');
    const targetPluginSet = new Set(Array.isArray(selectedPlugins) ? selectedPlugins : cloudPlugins.map((p) => p.id));
    const configPluginSet = new Set(Array.isArray(syncPluginConfigs) ? syncPluginConfigs : cloudPlugins.map((p) => p.id));
    const bundles = readPluginBundles(repoRoot);
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')); } catch {}
    const deps = pkg?.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
    const enabledBundles = new Set(Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []);
    let patchText = fs.existsSync(localPatchPath) ? fs.readFileSync(localPatchPath, 'utf8') : '';
    const localBlocks = extractTopLevelPatchBlocks(patchText);

    for (const plugin of cloudPlugins) {
      if (!targetPluginSet.has(plugin.id)) continue;
      const existingBundle = bundles.byPackage.get(plugin.package);
      const patchId = existingBundle?.manifest?.patchId || plugin.package.split('/').pop() || plugin.id;
      if (!Object.hasOwn(deps, plugin.package)) {
        // 自动推云时传 removeUninstalledPlugins: false，遇到未安装云插件直接跳过，绝不误删云清单或写 tombstone。
        if (!removeUninstalledPlugins) {
          continue;
        }
        // 本机已卸载该云插件：推送下线到云端并清理仓库快照与本机残留配置块
        if (process.env.DSH_AU_CLOUD_MANIFEST_PATH || path.resolve(repoRoot) === path.resolve(getRepoRoot())) {
          try {
            removeCloudPlugin(plugin.id);
          } catch {}
        }
        try {
          removePluginBundle(repoRoot, plugin.package);
        } catch {}
        if (patchText && fs.existsSync(localPatchPath)) {
          const nextPatchText = removeTopLevelPatchBlock(patchText, [
            patchId,
            plugin.id,
            plugin.package,
            plugin.package.split('/').pop(),
          ]);
          if (nextPatchText !== patchText) {
            patchText = nextPatchText;
            try { fs.writeFileSync(localPatchPath, patchText, 'utf8'); } catch {}
          }
        }
        removedPlugins.push({ id: plugin.id, package: plugin.package });
        continue;
      }
      const localBlock = localBlocks.find((b) => b.id === patchId || b.id === plugin.id);
      const isPatchDisabled = Boolean(localBlock && /^\s+disabled:\s*true\b/m.test(localBlock.text));
      const localEnabled = enabledBundles.has(plugin.package) && !isPatchDisabled;
      const shouldPushConfig = configPluginSet.has(plugin.id);
      const configTextToWrite = shouldPushConfig
        ? (localBlock ? localBlock.text : '')
        : (existingBundle?.configText || '');

      try {
        const nextVersion = deps[plugin.package] || plugin.version || '0.1.0';
        const written = writePluginBundle({
          repoRoot,
          profileDir,
          plugin: {
            ...plugin,
            version: nextVersion,
            enabled: localEnabled,
          },
          configText: configTextToWrite,
          patchId,
          syncedFrom: hostname(),
        });
        if (path.resolve(repoRoot) === path.resolve(getRepoRoot())) {
          try {
            upsertCloudPlugin({ ...plugin, version: written.manifest?.version || nextVersion, snapshotDir: written.dir }, plugin.id);
          } catch {}
        }
        updatedPlugins.push(plugin.id);
      } catch (err) {
        if (err?.message?.includes('明文凭据')) {
          skippedCredentialPlugins.push({ id: plugin.id, reason: err.message });
        }
      }
    }
  }

  // 本机设置项：未勾选时仅保留单机备份，勾选后同步写入云端共享文件并顺手刷新单机备份。
  const preferenceSet = new Set(Array.isArray(selectedPreferences) ? selectedPreferences : []);
  const auCfgPath = process.env.DSH_AU_CONFIG_PATH || path.join(dshHome, 'dsh-au.config.json');
  let localAuCfg = {};
  const hasLocalAuCfg = fs.existsSync(auCfgPath);
  try {
    localAuCfg = hasLocalAuCfg ? JSON.parse(fs.readFileSync(auCfgPath, 'utf8')) : {};
  } catch {}
  const mergedClientPrefs = {
    ...(localAuCfg?.clientPreferences && typeof localAuCfg.clientPreferences === 'object' ? localAuCfg.clientPreferences : {}),
    ...(clientPreferences && typeof clientPreferences === 'object' ? clientPreferences : {}),
  };
  const localShortcutOverrides = mergedClientPrefs.shortcutOverrides
    && typeof mergedClientPrefs.shortcutOverrides === 'object'
    && !Array.isArray(mergedClientPrefs.shortcutOverrides)
    ? mergedClientPrefs.shortcutOverrides
    : {};
  const shortcutsFilePath = process.env.DSH_AU_MODEL_SHORTCUTS_PATH || path.join(dshHome, 'model-shortcuts.json');

  let machinePreferencesUpdated = false;
  let machinePreferencesError = '';
  if (preferenceSet.size > 0) {
    try {
      const patch = {};
      if (preferenceSet.has('shortcuts')) {
        patch.shortcutOverrides = localShortcutOverrides;
      }
      if (preferenceSet.has('modelShortcuts')) {
        const localModelShortcuts = readModelShortcuts({ filePath: shortcutsFilePath }).modelShortcuts;
        patch.modelShortcuts = localModelShortcuts;
        const cloudModelShortcutsPath = path.join(resolveSyncDir({ repoRoot }), 'cloud', 'model-shortcuts.json');
        fs.mkdirSync(path.dirname(cloudModelShortcutsPath), { recursive: true });
        fs.writeFileSync(
          cloudModelShortcutsPath,
          `${JSON.stringify({ schemaVersion: MODEL_SHORTCUTS_SCHEMA_VERSION, ...localModelShortcuts }, null, 2)}\n`,
          'utf8',
        );
      }
      const saved = saveMachinePreferences(patch);
      if (saved.ok) {
        machinePreferencesUpdated = true;
        // 推送时顺手把客户端偏好落回本机配置，避免本机与云端来源不一致。
        if (clientPreferences && typeof clientPreferences === 'object' && hasLocalAuCfg) {
          localAuCfg.clientPreferences = mergedClientPrefs;
          fs.writeFileSync(auCfgPath, JSON.stringify(localAuCfg, null, 2), 'utf8');
        }
      } else {
        machinePreferencesError = saved.reason || '写入本机云备份失败';
      }
    } catch (err) {
      machinePreferencesError = err.message;
    }
  }

  // 只要 syncDshAuPreferences !== false 且 dsh-au.config.json 存在（或勾选了 shortcuts），就将 8 项固定共享开关写入 cloud/dsh-au-preferences.json。
  let dshAuPrefsUpdated = false;
  if (syncDshAuPreferences !== false && (hasLocalAuCfg || preferenceSet.has('shortcuts'))) {
    try {
      // 跟随私人仓库当前 sync 布局（dsh-sync 或旧的 dsh-au/sync），不要写死旧路径。
      const dshAuPrefPath = path.join(resolveSyncDir({ repoRoot }), 'cloud', 'dsh-au-preferences.json');
      const existingCloudPrefs = fs.existsSync(dshAuPrefPath) ? JSON.parse(fs.readFileSync(dshAuPrefPath, 'utf8')) : {};
      const payload = {
        schemaVersion: 1,
        todo: localAuCfg?.features?.todo !== undefined ? Boolean(localAuCfg.features.todo) : (existingCloudPrefs.todo ?? true),
        remoteManagement: localAuCfg?.features?.remoteManagement !== undefined
          ? Boolean(localAuCfg.features.remoteManagement)
          : (existingCloudPrefs.remoteManagement ?? true),
        fullAccessByDefault: localAuCfg?.features?.fullAccessByDefault !== undefined
          ? Boolean(localAuCfg.features.fullAccessByDefault)
          : (existingCloudPrefs.fullAccessByDefault ?? false),
        // 新开关只认显式布尔值，旧快照缺字段不改变默认行为。
        // 锁屏断开远程只属于这台电脑，故意不写入云偏好。
        blockGoalCreation: typeof localAuCfg?.features?.blockGoalCreation === 'boolean'
          ? localAuCfg.features.blockGoalCreation
          : existingCloudPrefs.blockGoalCreation === true,
        sidebarWorkbench: localAuCfg?.features?.sidebarWorkbench === true,
        windowRestoreEnabled: localAuCfg?.windowState?.enabled !== undefined
          ? Boolean(localAuCfg.windowState.enabled)
          // 窗口还原与移动端优化默认关闭，缺字段时不替用户打开。
          : (existingCloudPrefs.windowRestoreEnabled ?? false),
        mobileEnabled: typeof mergedClientPrefs.mobileEnabled === 'boolean'
          ? mergedClientPrefs.mobileEnabled
          : (existingCloudPrefs.mobileEnabled ?? false),
        autoContinue: normalizeAutoContinue(localAuCfg?.autoContinue || existingCloudPrefs.autoContinue),
        // 勾选 shortcuts 时写入本机 shortcutOverrides；未勾选时保留云端原有 shortcutOverrides 不覆盖。
        shortcutOverrides: preferenceSet.has('shortcuts')
          ? localShortcutOverrides
          : (existingCloudPrefs.shortcutOverrides && typeof existingCloudPrefs.shortcutOverrides === 'object' && !Array.isArray(existingCloudPrefs.shortcutOverrides)
              ? existingCloudPrefs.shortcutOverrides
              : {}),
      };
      fs.mkdirSync(path.dirname(dshAuPrefPath), { recursive: true });
      fs.writeFileSync(dshAuPrefPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      dshAuPrefsUpdated = true;
    } catch {}
  }

  return {
    ok: true,
    profile: safeProfile,
    updatedPatchIds,
    skippedCredentialPatchIds,
    updatedPlugins,
    removedPlugins,
    skippedCredentialPlugins,
    desktopUpdated,
    dshAuPrefsUpdated,
    machinePreferencesUpdated,
    machinePreferencesError,
    hash: computeOfficialSettingsHash(repoRoot, safeProfile, { selectedPreferences }),
  };
}

export function runRestoreScriptForCloudSync({
  repoRoot = getRepoRoot(),
  dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh'),
  profile = '',
  selectedItems = ALL_OFFICIAL_SYNC_ITEM_IDS,
  selectedPlugins = null,
  syncPluginConfigs = null,
  preferences = ALL_PREFERENCE_SYNC_ITEM_IDS,
  autoSync = false,
  installPlugin = !autoSync,
  spawnSyncImpl = spawnSync,
} = {}) {
  // 未配置私人同步仓库且无清单环境变量覆盖时，先安全跳过，避免触发清单缺失异常。
  const envManifestPath = String(process.env.DSH_AU_PROFILES_MANIFEST_PATH || '').trim();
  if (!envManifestPath && !hasSyncRepo({ repoRoot })) {
    return {
      ok: true,
      skipped: true,
      reason: syncRepoUnavailableMessage(),
      hash: '',
      restartRequired: false,
    };
  }

  // 通过声明式清单解析合法方案 ID 与还原脚本路径。
  const manifest = loadDshProfilesManifest(repoRoot);
  const safeProfile = resolveDshProfileId(profile, { repoRoot, allowNonSelectable: true });
  const validSet = new Set(ALL_OFFICIAL_SYNC_ITEM_IDS);
  const items = Array.isArray(selectedItems)
    ? mapLegacyItemIds(selectedItems).filter((id) => validSet.has(id))
    : [...ALL_OFFICIAL_SYNC_ITEM_IDS];
  const allPluginIds = getAllCloudPluginIds();
  const pluginIds = Array.isArray(selectedPlugins) ? selectedPlugins : allPluginIds;
  const pluginConfigIds = Array.isArray(syncPluginConfigs) ? syncPluginConfigs : allPluginIds;
  const preferenceIds = Array.isArray(preferences)
    ? Array.from(new Set(preferences.filter((id) => ALL_PREFERENCE_SYNC_ITEM_IDS.includes(id))))
    : [...ALL_PREFERENCE_SYNC_ITEM_IDS];

  if (items.length === 0 && pluginIds.length === 0 && preferenceIds.length === 0 && readRemovedCloudPlugins().length === 0) {
    return {
      ok: true,
      skipped: true,
      reason: '未勾选任何同步项或云插件',
      hash: computeOfficialSettingsHash(repoRoot, safeProfile, { selectedPreferences: preferenceIds }),
      restartRequired: false,
    };
  }

  // 从清单 restoreScript 读取还原脚本路径，不再写死 scripts/dsh-restore.mjs。
  const restoreScript = manifest.restoreScript
    ? path.join(repoRoot, ...manifest.restoreScript.split('/').filter(Boolean))
    : '';
  if (!restoreScript || !fs.existsSync(restoreScript)) {
    return {
      ok: true,
      skipped: true,
      reason: syncRepoUnavailableMessage(),
      hash: computeOfficialSettingsHash(repoRoot, safeProfile, { selectedPreferences: preferenceIds }),
      restartRequired: false,
    };
  }
  const cliArgs = [
    restoreScript,
    '--profile', safeProfile,
    '--only-items', items.join(','),
    '--only-plugins', pluginIds.join(','),
    '--sync-plugin-configs', pluginConfigIds.join(','),
    '--preferences', preferenceIds.join(','),
  ];
  if (autoSync) cliArgs.push('--auto-sync');
  if (installPlugin) cliArgs.push('--install-plugin');

  const result = spawnSyncImpl(process.execPath, cliArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_HOME: dshHome,
    },
    windowsHide: true,
  });

  const hash = computeOfficialSettingsHash(repoRoot, safeProfile, { selectedPreferences: preferenceIds });
  if (result.status !== 0) {
    return {
      ok: false,
      status: result.status,
      error: (result.stderr || result.stdout || '执行 #71 还原脚本失败').trim(),
      hash,
      restartRequired: false,
    };
  }
  return {
    ok: true,
    skipped: false,
    stdout: (result.stdout || '').trim(),
    hash,
    syncedAt: new Date().toISOString(),
    restartRequired: true,
  };
}

function resolveWatchedFileTarget(dshHome, relPath) {
  const cleanRel = String(relPath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleanRel) return null;
  const targetRel = cleanRel.replace(/^app-config\//, '');
  if (!targetRel) return null;
  const strippedPath = path.join(dshHome, ...targetRel.split('/').filter(Boolean));
  if (fs.existsSync(strippedPath) || targetRel === cleanRel) {
    return { relKey: targetRel, localPath: strippedPath };
  }
  const directPath = path.join(dshHome, ...cleanRel.split('/').filter(Boolean));
  if (fs.existsSync(directPath)) {
    return { relKey: targetRel, localPath: directPath };
  }
  return { relKey: targetRel, localPath: strippedPath };
}

/**
 * 将未勾选云端共享的 DSH 官方设置与其它云插件配置按单机粒度备份到 machines/<machineId>.json：
 * - 自动归一化本机路径；
 * - 命中明文凭据时拦截跳过并记录到 skippedCredentials；
 * - 在已有备份基础上合并更新，仅当序列化结果变化时才写盘。
 */
export function backupUncheckedSettingsToMachine({
  repoRoot = getRepoRoot(),
  dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh'),
  profile = '', // eslint-disable-line no-unused-vars
  selectedItems = [],
  selectedPlugins = [],
  syncPluginConfigs = [],
  cloudSyncEnabled = false,
  machineId = '',
} = {}) {
  let manifest = { pathNormalizations: [], watchedFiles: [] };
  try {
    manifest = loadDshProfilesManifest(repoRoot);
  } catch {
    manifest = { pathNormalizations: [], watchedFiles: [] };
  }

  const selectedItemSet = new Set(expandSyncItemIds(selectedItems));
  const selectedPluginSet = new Set(Array.isArray(selectedPlugins) ? selectedPlugins : []);
  const syncConfigSet = new Set(Array.isArray(syncPluginConfigs) ? syncPluginConfigs : []);

  const existing = loadMachineSettingsBackup(machineId) || {};
  const nextOfficialBackup = existing.officialSettingsBackup && typeof existing.officialSettingsBackup === 'object' && !Array.isArray(existing.officialSettingsBackup)
    ? { ...existing.officialSettingsBackup }
    : {};
  const nextPluginConfigs = existing.pluginConfigs && typeof existing.pluginConfigs === 'object' && !Array.isArray(existing.pluginConfigs)
    ? { ...existing.pluginConfigs }
    : {};

  const localPatchPath = path.join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml');
  const localPatchText = fs.existsSync(localPatchPath) ? fs.readFileSync(localPatchPath, 'utf8') : '';
  const localBlocks = extractTopLevelPatchBlocks(localPatchText);
  const localBlockMap = new Map(localBlocks.map((b) => [b.id, b.text]));

  const backedUpItems = [];
  const backedUpPlugins = [];
  const skippedCredentials = [];

  const candidateItems = cloudSyncEnabled
    ? OFFICIAL_SYNC_ITEMS.filter((item) => !selectedItemSet.has(item.id))
    : OFFICIAL_SYNC_ITEMS;

  for (const item of candidateItems) {
    if (item.isDesktopPreferences) {
      const localDesktopPath = path.join(dshHome, 'desktop-preferences.json');
      if (!fs.existsSync(localDesktopPath)) continue;
      const text = fs.readFileSync(localDesktopPath, 'utf8');
      const issue = findPlaintextCredentialIssue(text);
      if (issue) {
        skippedCredentials.push({ scope: 'official', id: item.id, reason: issue });
        continue;
      }
      nextOfficialBackup[item.id] = { desktopPreferences: text };
      backedUpItems.push(item.id);
      continue;
    }

    const entry = {};
    let blockedByCredential = false;

    if (Array.isArray(item.patchIds) && item.patchIds.length > 0) {
      const cordisBlocks = {};
      for (const patchId of item.patchIds) {
        const rawBlock = localBlockMap.get(patchId);
        if (!rawBlock) continue;
        const normalizedBlock = normalizePortableConfigPaths(normalizeLocalPatchPaths(rawBlock, manifest));
        const issue = findPlaintextCredentialIssue(normalizedBlock);
        if (issue) {
          skippedCredentials.push({ scope: 'official', id: item.id, patchId, reason: issue });
          blockedByCredential = true;
          break;
        }
        cordisBlocks[patchId] = normalizedBlock;
      }
      if (blockedByCredential) continue;
      if (Object.keys(cordisBlocks).length > 0) {
        entry.cordisBlocks = cordisBlocks;
      }
    }

    if (item.id === 'llm-providers' && Array.isArray(manifest.watchedFiles) && manifest.watchedFiles.length > 0) {
      const watchedFiles = {};
      for (const relPath of manifest.watchedFiles) {
        const resolved = resolveWatchedFileTarget(dshHome, relPath);
        if (!resolved || !fs.existsSync(resolved.localPath)) continue;
        const text = fs.readFileSync(resolved.localPath, 'utf8');
        const issue = findPlaintextCredentialIssue(text);
        if (issue) {
          skippedCredentials.push({ scope: 'official', id: item.id, file: resolved.relKey, reason: issue });
          continue;
        }
        watchedFiles[resolved.relKey] = text;
      }
      if (Object.keys(watchedFiles).length > 0) {
        entry.watchedFiles = watchedFiles;
      }
    }

    if (Object.keys(entry).length > 0) {
      nextOfficialBackup[item.id] = entry;
      backedUpItems.push(item.id);
    }
  }

  const packagePath = path.join(dshHome, 'profiles', 'desktop', 'package.json');
  if (fs.existsSync(packagePath)) {
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')); } catch {}
    const deps = pkg?.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
    const cloudPlugins = readCloudPlugins().filter((p) => p && typeof p.id === 'string' && typeof p.package === 'string');
    const localBlockIds = localBlocks.map((b) => b.id);

    for (const plugin of cloudPlugins) {
      if (!Object.hasOwn(deps, plugin.package)) continue;
      const shouldBackup = !cloudSyncEnabled || !selectedPluginSet.has(plugin.id) || !syncConfigSet.has(plugin.id);
      if (!shouldBackup) continue;
      const patchId = resolvePluginPatchId(plugin, localBlockIds);
      const rawBlock = localBlockMap.get(patchId);
      if (!rawBlock) continue;
      const normalizedBlock = normalizePortableConfigPaths(rawBlock);
      const issue = findPlaintextCredentialIssue(normalizedBlock);
      if (issue) {
        skippedCredentials.push({ scope: 'plugin', id: plugin.id, patchId, reason: issue });
        continue;
      }
      nextPluginConfigs[plugin.id] = normalizedBlock;
      backedUpPlugins.push(plugin.id);
    }
  }

  const changed = canonicalJson(existing.officialSettingsBackup || {}) !== canonicalJson(nextOfficialBackup)
    || canonicalJson(existing.pluginConfigs || {}) !== canonicalJson(nextPluginConfigs);

  if (changed) {
    const saveResult = saveMachineSettingsBackup(
      {
        officialSettingsBackup: nextOfficialBackup,
        pluginConfigs: nextPluginConfigs,
      },
      machineId,
    );
    if (saveResult && saveResult.ok === false) {
      return {
        ok: false,
        reason: saveResult.reason || 'save_failed',
        changed: false,
        backedUpItems,
        backedUpPlugins,
        skippedCredentials,
      };
    }
  }

  return {
    ok: true,
    changed,
    backedUpItems,
    backedUpPlugins,
    skippedCredentials,
  };
}

/**
 * 从 machines/<machineId>.json 缺省恢复未勾选云端共享的官方设置与云插件配置：
 * 仅在本机缺少对应配置块或文件时补回，绝不覆盖本机已有配置。
 */
export function restoreUncheckedSettingsFromMachine({
  repoRoot = getRepoRoot(), // eslint-disable-line no-unused-vars
  dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh'),
  profile = '', // eslint-disable-line no-unused-vars
  selectedItems = [],
  selectedPlugins = [],
  syncPluginConfigs = [],
  cloudSyncEnabled = false,
  machineId = '',
} = {}) {
  const backup = loadMachineSettingsBackup(machineId) || {};
  const officialBackup = backup.officialSettingsBackup && typeof backup.officialSettingsBackup === 'object' && !Array.isArray(backup.officialSettingsBackup)
    ? backup.officialSettingsBackup
    : null;
  const pluginConfigs = backup.pluginConfigs && typeof backup.pluginConfigs === 'object' && !Array.isArray(backup.pluginConfigs)
    ? backup.pluginConfigs
    : null;

  if (!officialBackup && !pluginConfigs) {
    return { ok: true, restoredItems: [], restoredPlugins: [] };
  }

  const selectedItemSet = new Set(expandSyncItemIds(selectedItems));
  const selectedPluginSet = new Set(Array.isArray(selectedPlugins) ? selectedPlugins : []);
  const syncConfigSet = new Set(Array.isArray(syncPluginConfigs) ? syncPluginConfigs : []);

  const localPatchPath = path.join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml');
  let patchText = fs.existsSync(localPatchPath) ? fs.readFileSync(localPatchPath, 'utf8') : '';
  const localBlocks = extractTopLevelPatchBlocks(patchText);
  const localBlockIds = new Set(localBlocks.map((b) => b.id));
  let patchChanged = false;

  const restoredItems = [];
  const restoredPlugins = [];

  if (officialBackup) {
    for (const [itemId, entry] of Object.entries(officialBackup)) {
      if (!entry || typeof entry !== 'object') continue;
      if (cloudSyncEnabled && selectedItemSet.has(itemId)) continue;

      let itemRestored = false;

      if (entry.cordisBlocks && typeof entry.cordisBlocks === 'object') {
        for (const [patchId, blockText] of Object.entries(entry.cordisBlocks)) {
          if (typeof blockText !== 'string' || !blockText.trim()) continue;
          if (localBlockIds.has(patchId)) continue;
          const expanded = expandPortableConfigPaths(blockText);
          patchText = upsertPatchBlock(patchText, expanded, patchId);
          localBlockIds.add(patchId);
          patchChanged = true;
          itemRestored = true;
        }
      }

      if (typeof entry.desktopPreferences === 'string') {
        const localDesktopPath = path.join(dshHome, 'desktop-preferences.json');
        if (!fs.existsSync(localDesktopPath)) {
          fs.mkdirSync(path.dirname(localDesktopPath), { recursive: true });
          fs.writeFileSync(localDesktopPath, entry.desktopPreferences, 'utf8');
          itemRestored = true;
        }
      }

      if (entry.watchedFiles && typeof entry.watchedFiles === 'object') {
        for (const [relPath, content] of Object.entries(entry.watchedFiles)) {
          if (typeof content !== 'string') continue;
          const resolved = resolveWatchedFileTarget(dshHome, relPath);
          if (!resolved || fs.existsSync(resolved.localPath)) continue;
          fs.mkdirSync(path.dirname(resolved.localPath), { recursive: true });
          fs.writeFileSync(resolved.localPath, content, 'utf8');
          itemRestored = true;
        }
      }

      if (itemRestored) {
        restoredItems.push(itemId);
      }
    }
  }

  if (pluginConfigs) {
    const packagePath = path.join(dshHome, 'profiles', 'desktop', 'package.json');
    if (fs.existsSync(packagePath)) {
      let pkg = {};
      try { pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')); } catch {}
      const deps = pkg?.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
      const cloudPlugins = readCloudPlugins().filter((p) => p && typeof p.id === 'string' && typeof p.package === 'string');
      const cloudPluginMap = new Map(cloudPlugins.map((p) => [p.id, p]));

      for (const [pluginId, blockText] of Object.entries(pluginConfigs)) {
        if (typeof blockText !== 'string' || !blockText.trim()) continue;
        if (cloudSyncEnabled && selectedPluginSet.has(pluginId) && syncConfigSet.has(pluginId)) continue;
        const plugin = cloudPluginMap.get(pluginId);
        if (!plugin || !Object.hasOwn(deps, plugin.package)) continue;

        const blockIds = [...localBlockIds];
        const resolvedId = resolvePluginPatchId(plugin, blockIds);
        const backupBlockId = extractTopLevelPatchBlocks(blockText)[0]?.id || '';
        const pkgShort = plugin.package.split('/').pop() || '';
        if (
          localBlockIds.has(resolvedId)
          || localBlockIds.has(plugin.id)
          || (pkgShort && localBlockIds.has(pkgShort))
          || (backupBlockId && localBlockIds.has(backupBlockId))
        ) {
          continue;
        }

        const targetPatchId = backupBlockId || resolvedId || plugin.id;
        const expanded = expandPortableConfigPaths(blockText);
        patchText = upsertPatchBlock(patchText, expanded, targetPatchId);
        localBlockIds.add(targetPatchId);
        patchChanged = true;
        restoredPlugins.push(pluginId);
      }
    }
  }

  if (patchChanged) {
    fs.mkdirSync(path.dirname(localPatchPath), { recursive: true });
    fs.writeFileSync(localPatchPath, patchText, 'utf8');
  }

  return { ok: true, restoredItems, restoredPlugins };
}
