import { normalizeAutoContinue } from './features.js';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import { REPO_ROOT, readCloudPlugins, readRemovedCloudPlugins, removeCloudPlugin, upsertCloudPlugin } from './cloud-manifest.js';
import { getRepoRoot, hasSyncRepo, resolveSyncDir, syncRepoUnavailableMessage } from './sync-repo.js';
import { findLatestMachinePreferences, loadMachinePreferences, saveMachinePreferences } from './local-bindings.js';
import { readModelShortcuts, saveModelShortcuts } from './model-shortcuts.js';
import { findPlaintextCredentialIssue, normalizePortableConfigPaths, readPluginBundles, readPluginPackageMeta, removePluginBundle, updatePluginBundleVersion, writePluginBundle } from './plugin-bundles.js';

export const OFFICIAL_SYNC_ITEMS = Object.freeze([
  {
    id: 'general-settings',
    category: '通用设置',
    title: '外观字号、对话界面与用量显示',
    patchIds: ['ui-theme', 'ui-chat', 'ui-settings-account', 'session-log-deepseek'],
    defaultDiff: '字号 18/15/17 · 标准视图 · 详细性能统计 · 链接新标签页打开 · 紧凑用量 · 关闭日志上报',
    comparisons: [
      { label: '正文 / 代码 / 终端字号', defaultValue: '14 / 13 / 14 px', currentValue: '18 / 15 / 17 px' },
      { label: '对话消息视图 (transcriptView)', defaultValue: '默认视图', currentValue: '标准视图 (standard)' },
      { label: '性能与耗时统计 (performanceUsage)', defaultValue: '简略', currentValue: '详细统计 (detailed)' },
      { label: '对话内链接打开方式 (linkOpening)', defaultValue: '当前窗口', currentValue: '新标签页打开 (new-tab)' },
      { label: '账户用量显示样式 (usage)', defaultValue: '标准卡片', currentValue: '紧凑模式 (compact)' },
      { label: '新手引导与官方会话日志上报', defaultValue: '开启引导 · 开启上报', currentValue: '跳过引导 · 关闭日志上报' },
    ],
  },
  {
    id: 'subagent-models',
    category: '内置插件',
    title: '子代理模型白名单',
    patchIds: ['subagent-model-selection-settings'],
    defaultDiff: '从私人仓库同步子代理可用模型白名单',
    comparisons: [
      { label: '允许子代理独立选择模型', defaultValue: '关闭 (false)', currentValue: '开启 (true)' },
      { label: '子代理可用模型白名单', defaultValue: '未限制（仅跟随主对话）', currentValue: '按私人仓库子代理白名单同步' },
    ],
  },
  {
    id: 'permission-preset',
    category: 'Agent 预设',
    title: '默认完全权限模式',
    patchIds: ['permission'],
    defaultDiff: '新开对话默认 danger-full-access（免除读写与命令二次确认）',
    comparisons: [
      { label: '新建对话默认权限预设 (defaultPreset)', defaultValue: '工作区内修改 (workspace-write，需审批)', currentValue: '完全权限 (danger-full-access，免确认)' },
    ],
  },
  {
    id: 'llm-providers',
    category: '模型',
    title: 'DSH 与 Codex 模型供应商、目录及默认模型',
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
    title: '桌面托盘、局域网与通知偏好',
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
 * 本机设置类同步项：按电脑各存一份，云端只认本机那份备份。
 * 新电脑第一次同步时才从最近更新的设备备份取初值，之后各设备独立演化。
 */
export const PREFERENCE_SYNC_ITEMS = Object.freeze([
  {
    id: 'shortcuts',
    category: '本机设置',
    title: '设备 / 页面切换快捷键',
    defaultDiff: '按电脑各存一份：推送写本机备份，拉取只读本机备份',
  },
  {
    id: 'modelShortcuts',
    category: '本机设置',
    title: '模型快捷槽位',
    defaultDiff: '按电脑各存一份：推送写本机备份，拉取只读本机备份',
  },
]);

export const ALL_PREFERENCE_SYNC_ITEM_IDS = PREFERENCE_SYNC_ITEMS.map((item) => item.id);

const LEGACY_ITEM_ID_MAP = Object.freeze({
  'ui-theme': 'general-settings',
  'ui-chat-account': 'general-settings',
});

export function getAllCloudPluginIds() {
  try {
    return readCloudPlugins()
      .filter((p) => typeof p?.id === 'string' && p.id)
      .map((p) => p.id);
  } catch {
    return [];
  }
}

export const DEFAULT_CLOUD_SYNC_CONFIG = Object.freeze({
  enabled: false,
  profile: 'generic',
  selectedItems: [...ALL_OFFICIAL_SYNC_ITEM_IDS],
  customized: false,
  selectedPlugins: [],
  syncPluginConfigs: [],
  pluginsCustomized: false,
  selectedPreferences: [...ALL_PREFERENCE_SYNC_ITEM_IDS],
  lastSyncedHash: '',
  lastSyncedAt: '',
});

export function normalizeCloudSyncConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const profile = ['kiro', 'generic', 'local'].includes(source.profile) ? source.profile : 'generic';
  const hasExplicitList = Array.isArray(source.selectedItems);
  let selectedItems;
  if (hasExplicitList) {
    const set = new Set(ALL_OFFICIAL_SYNC_ITEM_IDS);
    const mapped = source.selectedItems
      .map((id) => LEGACY_ITEM_ID_MAP[id] || id)
      .filter((id) => set.has(id));
    selectedItems = Array.from(new Set(mapped));
  } else {
    selectedItems = [...ALL_OFFICIAL_SYNC_ITEM_IDS];
  }
  const customized = typeof source.customized === 'boolean'
    ? source.customized
    : (hasExplicitList && selectedItems.length !== ALL_OFFICIAL_SYNC_ITEM_IDS.length);

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
  const pluginsCustomized = typeof source.pluginsCustomized === 'boolean'
    ? source.pluginsCustomized
    : (hasExplicitPlugins || hasExplicitPluginConfigs);

  // 本机设置默认全开，与旧版「随 dsh-au 插件整体同步」的行为保持一致；
  // 显式传入数组时只保留合法项，允许用户单独关掉某一项。
  const validPreferenceSet = new Set(ALL_PREFERENCE_SYNC_ITEM_IDS);
  const selectedPreferences = Array.isArray(source.selectedPreferences)
    ? Array.from(new Set(source.selectedPreferences.filter((id) => typeof id === 'string' && validPreferenceSet.has(id))))
    : [...ALL_PREFERENCE_SYNC_ITEM_IDS];

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
  };
}

export function computeOfficialSettingsHash(repoRoot = getRepoRoot(), profile = 'kiro') {
  const safeProfile = ['kiro', 'generic', 'local'].includes(profile) ? profile : 'generic';
  const patchPath = path.join(repoRoot, 'app-config', 'dsh', `cordis.patch.${safeProfile}.yml`);
  const prefPath = path.join(repoRoot, 'app-config', 'dsh', 'desktop-preferences.json');
  const dshAuPrefPath = path.join(resolveSyncDir({ repoRoot }), 'cloud', 'dsh-au-preferences.json');
  // 私人仓库路径仍是 gateway-*.json；变量名只用 gateway，避免内部产品代号。
  const gatewayModelsPath = path.join(repoRoot, 'app-config', 'codex', 'gateway-models.json');
  const gatewayPresetsPath = path.join(repoRoot, 'app-config', 'codex', 'gateway-presets.json');
  const readNormalized = (filePath) => fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n')
    : '';
  const patchContent = readNormalized(patchPath);
  const prefContent = readNormalized(prefPath);
  const dshAuPrefContent = readNormalized(dshAuPrefPath);
  // Codex 模型目录是 llm-providers 的同一份云端快照；只改目录时也要触发启动同步。
  const gatewayModelsContent = readNormalized(gatewayModelsPath);
  const gatewayPresetsContent = readNormalized(gatewayPresetsPath);
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
  const hash = crypto.createHash('sha256').update(
    `${safeProfile}\n${patchContent}\n---\n${prefContent}\n---\n${dshAuPrefContent}\n---\n${gatewayModelsContent}\n---\n${gatewayPresetsContent}\n---\n${pluginsDigest}`,
  ).digest('hex');
  return hash.slice(0, 16);
}

function mapLegacyItemIds(selectedItems) {
  if (!Array.isArray(selectedItems)) return [...ALL_OFFICIAL_SYNC_ITEM_IDS];
  return Array.from(new Set(selectedItems.map((id) => LEGACY_ITEM_ID_MAP[id] || id)));
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

export function applySelectedOfficialPatchBlocks({
  currentPatchText = '',
  renderedProfilePatch = '',
  sourcePatchText = '',
  selectedItems = ALL_OFFICIAL_SYNC_ITEM_IDS,
}) {
  const effectiveSource = renderedProfilePatch || sourcePatchText;
  const selectedSet = new Set(mapLegacyItemIds(selectedItems));
  const isAllOfficialSelected = isFullPatchSelection(selectedItems);
  const selectedPatchIds = new Set(
    OFFICIAL_SYNC_ITEMS.filter((item) => selectedSet.has(item.id)).flatMap((item) => item.patchIds)
  );
  const allOfficialPatchIds = new Set(
    OFFICIAL_SYNC_ITEMS.flatMap((item) => item.patchIds)
  );

  let resultText = '';
  const sourceBlocks = extractTopLevelPatchBlocks(effectiveSource);
  const currentBlocks = extractTopLevelPatchBlocks(currentPatchText);

  if (isAllOfficialSelected) {
    resultText = effectiveSource;
    for (const cur of currentBlocks) {
      if (!allOfficialPatchIds.has(cur.id) && cur.id !== 'dsh-au') {
        resultText = upsertPatchBlock(resultText, cur.text, cur.id);
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
  const sourcePath = path.join(repoRoot, 'app-config', 'dsh', 'desktop-preferences.json');
  if (!enabled || !fs.existsSync(sourcePath)) {
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
 * 当勾选了 dsh-au 插件或本机设置项时，把云端偏好同步到本机。
 * 官方开关来自 cloud/dsh-au-preferences.json；快捷键与模型槽位按电脑各存一份，
 * 只读本机机器备份，新电脑第一次同步才从最近一份设备备份取初值。
 */
export function syncOfficialDshAuPreferences({
  repoRoot = getRepoRoot(),
  dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh'),
  enabled = true,
  preferences = ALL_PREFERENCE_SYNC_ITEM_IDS,
} = {}) {
  const sourcePath = path.join(resolveSyncDir({ repoRoot }), 'cloud', 'dsh-au-preferences.json');
  const targetPath = process.env.DSH_AU_CONFIG_PATH || path.join(dshHome, 'dsh-au.config.json');
  if (!enabled) {
    return { updated: false, targetPath };
  }
  const preferenceSet = new Set(Array.isArray(preferences) ? preferences : ALL_PREFERENCE_SYNC_ITEM_IDS);
  const hasOfficialPrefs = fs.existsSync(sourcePath);
  if (!hasOfficialPrefs && preferenceSet.size === 0) {
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
        ...(typeof cloudPrefs.fullAccessByDefault === 'boolean' ? { fullAccessByDefault: cloudPrefs.fullAccessByDefault } : {}),
        // 只同步新建目标开关；不读取、迁移或改变任何旧目标。
        ...(typeof cloudPrefs.blockGoalCreation === 'boolean' ? { blockGoalCreation: cloudPrefs.blockGoalCreation } : {}),
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

    // 快捷键与模型槽位：本机备份没有时才向最近更新的设备备份借初值，并立即落回本机备份。
    let preferenceMigration = null;
    if (preferenceSet.has('shortcuts')) {
      const machinePrefs = loadMachinePreferences();
      let shortcutOverrides = machinePrefs.shortcutOverrides;
      if (!shortcutOverrides) {
        const latest = findLatestMachinePreferences();
        if (latest?.shortcutOverrides) {
          shortcutOverrides = latest.shortcutOverrides;
          preferenceMigration = { ...(preferenceMigration || {}), shortcutsFrom: latest.shortcutSource };
          saveMachinePreferences({ shortcutOverrides });
        }
      }
      if (shortcutOverrides) {
        nextCfg.clientPreferences = {
          ...(nextCfg.clientPreferences && typeof nextCfg.clientPreferences === 'object' ? nextCfg.clientPreferences : {}),
          shortcutOverrides,
        };
      }
    }
    if (preferenceSet.has('modelShortcuts')) {
      const machinePrefs = loadMachinePreferences();
      let modelShortcuts = machinePrefs.modelShortcuts;
      if (!modelShortcuts) {
        const latest = findLatestMachinePreferences();
        if (latest?.modelShortcuts) {
          modelShortcuts = latest.modelShortcuts;
          preferenceMigration = { ...(preferenceMigration || {}), modelShortcutsFrom: latest.modelSource };
          saveMachinePreferences({ modelShortcuts });
        }
      }
      if (modelShortcuts) {
        try {
          saveModelShortcuts(modelShortcuts);
        } catch { /* 本机写入失败时保留旧值，下次同步再试 */ }
      }
    }

    // 没有官方偏好、也没有任何本机设置可写时，不要凭空创建空的配置文件。
    if (!hasOfficialPrefs && !fs.existsSync(targetPath) && Object.keys(nextCfg).length === 0) {
      return { updated: false, targetPath };
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, `${JSON.stringify(nextCfg, null, 2)}\n`, 'utf8');
    return { updated: true, targetPath, preferences: cloudPrefs, preferenceMigration };
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
    .map((line) => line.replace(/[ \t]+$/g, ''));
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
  profile = 'kiro',
} = {}) {
  const safeProfile = ['kiro', 'generic', 'local'].includes(profile) ? profile : 'kiro';
  const localPatchPath = path.join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml');
  const repoPatchPath = path.join(repoRoot, 'app-config', 'dsh', `cordis.patch.${safeProfile}.yml`);

  const hasLocalPatch = fs.existsSync(localPatchPath);
  const localPatchText = hasLocalPatch ? fs.readFileSync(localPatchPath, 'utf8') : '';
  const localBlockMap = new Map(extractTopLevelPatchBlocks(localPatchText).map((b) => [b.id, b.text]));

  const hasRepoPatch = fs.existsSync(repoPatchPath);
  const repoPatchText = hasRepoPatch ? fs.readFileSync(repoPatchPath, 'utf8') : '';
  const repoBlockMap = new Map(extractTopLevelPatchBlocks(repoPatchText).map((b) => [b.id, b.text]));

  // Kiro 方案未启用 Cursor ACP 插件时，还原脚本会移除 dsh-acp-adapter 并把默认模型切回 kiro直连。
  const expectedBlockMap = new Map(repoBlockMap);
  if (safeProfile === 'kiro' && !hasLocalCursorAcpEnabled(dshHome)) {
    expectedBlockMap.delete('dsh-acp-adapter');
    expectedBlockMap.set(
      'agent-default-model',
      '- id: agent-default-model\n  config:\n    provider: kiro\n    model: kiro-claude-opus-5-5\n',
    );
  }

  const localDesktopPath = path.join(dshHome, 'desktop-preferences.json');
  const repoDesktopPath = path.join(repoRoot, 'app-config', 'dsh', 'desktop-preferences.json');

  return OFFICIAL_SYNC_ITEMS.map((item) => {
    if (item.isDesktopPreferences) {
      if (!fs.existsSync(repoDesktopPath)) {
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
}

/**
 * 一次生成三种还原方案的官方设置对比状态，供弹窗切换「模型方案」下拉框时即时更新徽章。
 */
export function buildOfficialSyncItemsByProfile({
  repoRoot = getRepoRoot(),
  dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh'),
} = {}) {
  return {
    kiro: buildOfficialSyncItems({ repoRoot, dshHome, profile: 'kiro' }),
    generic: buildOfficialSyncItems({ repoRoot, dshHome, profile: 'generic' }),
    local: buildOfficialSyncItems({ repoRoot, dshHome, profile: 'local' }),
  };
}

/**
 * 构建弹窗「本机设置」对比清单：
 * 对比当前电脑的实际快捷键/模型快捷槽位与该电脑在仓库 machines/<machineId>.json 中的云备份。
 */
export function buildPreferenceSyncItems({
  dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh'),
} = {}) {
  const machinePrefs = loadMachinePreferences();
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
  const cloudShortcuts = machinePrefs.shortcutOverrides
    && typeof machinePrefs.shortcutOverrides === 'object'
    && !Array.isArray(machinePrefs.shortcutOverrides)
    ? machinePrefs.shortcutOverrides
    : {};

  const shortcutsFilePath = process.env.DSH_AU_MODEL_SHORTCUTS_PATH || path.join(dshHome, 'model-shortcuts.json');
  const localModelShortcuts = readModelShortcuts({ filePath: shortcutsFilePath }).modelShortcuts;
  const cloudModelShortcuts = machinePrefs.modelShortcuts;

  return PREFERENCE_SYNC_ITEMS.map((item) => {
    if (item.id === 'shortcuts') {
      const hasBackup = machinePrefs.exists && machinePrefs.shortcutOverrides !== null;
      const inSync = hasBackup
        ? canonicalJson(localShortcuts) === canonicalJson(cloudShortcuts)
        : Object.keys(localShortcuts).length === 0;
      const diffLabel = inSync
        ? '✓ 与云一致'
        : (hasBackup ? '本地与云备份不一致' : '本机有修改 / 云端暂无备份');
      return {
        ...item,
        inSync,
        diffLabel,
        cloudValue: hasBackup ? cloudShortcuts : null,
        localValue: localShortcuts,
      };
    }

    if (item.id === 'modelShortcuts') {
      const hasBackup = machinePrefs.exists && cloudModelShortcuts !== null;
      const inSync = hasBackup
        ? canonicalJson(localModelShortcuts) === canonicalJson(cloudModelShortcuts)
        : false;
      const diffLabel = inSync
        ? '✓ 与云一致'
        : (hasBackup ? '本地与云备份不一致' : '云端暂无本机备份');
      return {
        ...item,
        inSync,
        diffLabel,
        cloudValue: hasBackup ? cloudModelShortcuts : null,
      };
    }

    return { ...item, inSync: true, diffLabel: '✓ 与云一致' };
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
  profile = 'kiro',
  selectedItems = ALL_OFFICIAL_SYNC_ITEM_IDS,
  selectedPlugins = null,
  syncPluginConfigs = null,
  clientPreferences = null,
  selectedPreferences = ALL_PREFERENCE_SYNC_ITEM_IDS,
} = {}) {
  const safeProfile = ['kiro', 'generic', 'local'].includes(profile) ? profile : 'generic';
  const selectedSet = new Set(mapLegacyItemIds(selectedItems));
  const localPatchPath = path.join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml');
  const updatedPatchIds = [];
  const skippedCredentialPatchIds = [];

  if (fs.existsSync(localPatchPath)) {
    const rawLocal = fs.readFileSync(localPatchPath, 'utf8')
      .replace(/[A-Za-z]:\\\\[^\n"]*?cursor-acp-wrapper\.mjs/g, '~/.dsh/cursor-acp-wrapper.mjs')
      .replace(/\/[^\n"]*?cursor-acp-wrapper\.mjs/g, '~/.dsh/cursor-acp-wrapper.mjs')
      .replace(/[A-Za-z]:\\\\[^\n"]*?antigravity-acp-wrapper\.mjs/g, '~/.dsh/antigravity-acp-wrapper.mjs')
      .replace(/\/[^\n"]*?antigravity-acp-wrapper\.mjs/g, '~/.dsh/antigravity-acp-wrapper.mjs');
    const localBlocks = extractTopLevelPatchBlocks(rawLocal);
    const localMap = new Map(localBlocks.map((b) => [b.id, b.text]));

    // 仅模型供应商/目录/默认模型项 (llm-providers) 区分方案；其余通用设置同步写入全部方案快照
    for (const targetProfile of ['kiro', 'generic', 'local']) {
      const repoPatchPath = path.join(repoRoot, 'app-config', 'dsh', `cordis.patch.${targetProfile}.yml`);
      if (!fs.existsSync(repoPatchPath)) continue;
      let repoText = fs.readFileSync(repoPatchPath, 'utf8');
      const eol = repoText.includes('\r\n') ? '\r\n' : '\n';
      repoText = repoText.replace(/\r\n/g, '\n');

      for (const item of OFFICIAL_SYNC_ITEMS) {
        if (!selectedSet.has(item.id)) continue;
        if (item.id === 'llm-providers' && targetProfile !== safeProfile) continue;
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
  if (selectedSet.has('desktop-preferences')) {
    const localDesktopPath = path.join(dshHome, 'desktop-preferences.json');
    const repoDesktopPath = path.join(repoRoot, 'app-config', 'dsh', 'desktop-preferences.json');
    if (fs.existsSync(localDesktopPath)) {
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

  // 本机设置项：快捷键与模型槽位按电脑各存一份，推送只写本机那份云备份。
  const preferenceSet = new Set(Array.isArray(selectedPreferences) ? selectedPreferences : ALL_PREFERENCE_SYNC_ITEM_IDS);
  const auCfgPath = process.env.DSH_AU_CONFIG_PATH || path.join(dshHome, 'dsh-au.config.json');
  let localAuCfg = {};
  try {
    localAuCfg = fs.existsSync(auCfgPath) ? JSON.parse(fs.readFileSync(auCfgPath, 'utf8')) : {};
  } catch {}
  const mergedClientPrefs = {
    ...(localAuCfg?.clientPreferences && typeof localAuCfg.clientPreferences === 'object' ? localAuCfg.clientPreferences : {}),
    ...(clientPreferences && typeof clientPreferences === 'object' ? clientPreferences : {}),
  };

  let machinePreferencesUpdated = false;
  let machinePreferencesError = '';
  if (preferenceSet.size > 0) {
    try {
      const patch = {};
      if (preferenceSet.has('shortcuts')) {
        // 客户端传来的覆盖优先，其次是本机配置里已有的值。
        patch.shortcutOverrides = mergedClientPrefs.shortcutOverrides && typeof mergedClientPrefs.shortcutOverrides === 'object'
          ? mergedClientPrefs.shortcutOverrides
          : {};
      }
      if (preferenceSet.has('modelShortcuts')) {
        patch.modelShortcuts = readModelShortcuts().modelShortcuts;
      }
      const saved = saveMachinePreferences(patch);
      if (saved.ok) {
        machinePreferencesUpdated = true;
        // 推送时顺手把客户端偏好落回本机配置，避免本机与云端来源不一致。
        if (clientPreferences && typeof clientPreferences === 'object' && fs.existsSync(auCfgPath)) {
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

  // 勾选 dsh-au 时，将自身开关（含新建目标限制）写入同一份云偏好，不同步目标记录。
  const effectivePluginSet = new Set(Array.isArray(selectedPlugins) ? selectedPlugins : getAllCloudPluginIds());
  let dshAuPrefsUpdated = false;
  if (effectivePluginSet.has('dsh-au')) {
    try {
      // 跟随私人仓库当前 sync 布局（dsh-sync 或旧的 dsh-au/sync），不要写死旧路径。
      const dshAuPrefPath = path.join(resolveSyncDir({ repoRoot }), 'cloud', 'dsh-au-preferences.json');
      const existingCloudPrefs = fs.existsSync(dshAuPrefPath) ? JSON.parse(fs.readFileSync(dshAuPrefPath, 'utf8')) : {};
      const payload = {
        schemaVersion: 1,
        todo: localAuCfg?.features?.todo !== undefined ? Boolean(localAuCfg.features.todo) : (existingCloudPrefs.todo ?? true),
        fullAccessByDefault: localAuCfg?.features?.fullAccessByDefault !== undefined
          ? Boolean(localAuCfg.features.fullAccessByDefault)
          : (existingCloudPrefs.fullAccessByDefault ?? false),
        // 新开关只认显式布尔值，旧快照缺字段不改变默认行为。
        // 锁屏断开远程只属于这台电脑，故意不写入云偏好。
        blockGoalCreation: typeof localAuCfg?.features?.blockGoalCreation === 'boolean'
          ? localAuCfg.features.blockGoalCreation
          : existingCloudPrefs.blockGoalCreation === true,
        windowRestoreEnabled: localAuCfg?.windowState?.enabled !== undefined
          ? Boolean(localAuCfg.windowState.enabled)
          : (existingCloudPrefs.windowRestoreEnabled ?? true),
        mobileEnabled: typeof mergedClientPrefs.mobileEnabled === 'boolean'
          ? mergedClientPrefs.mobileEnabled
          : (existingCloudPrefs.mobileEnabled ?? true),
        autoContinue: normalizeAutoContinue(localAuCfg?.autoContinue || existingCloudPrefs.autoContinue),
        // 快捷键已改存各电脑的机器备份；旧字段原样保留，仅作回滚依据。
        shortcutOverrides: existingCloudPrefs.shortcutOverrides && typeof existingCloudPrefs.shortcutOverrides === 'object'
          ? existingCloudPrefs.shortcutOverrides
          : {},
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
    hash: computeOfficialSettingsHash(repoRoot, safeProfile),
  };
}

export function runRestoreScriptForCloudSync({
  repoRoot = getRepoRoot(),
  dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh'),
  profile = 'kiro',
  selectedItems = ALL_OFFICIAL_SYNC_ITEM_IDS,
  selectedPlugins = null,
  syncPluginConfigs = null,
  preferences = ALL_PREFERENCE_SYNC_ITEM_IDS,
  autoSync = false,
  spawnSyncImpl = spawnSync,
} = {}) {
  const safeProfile = ['kiro', 'generic', 'local'].includes(profile) ? profile : 'generic';
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
      hash: computeOfficialSettingsHash(repoRoot, safeProfile),
      restartRequired: false,
    };
  }

  const restoreScript = path.join(repoRoot, 'scripts', 'dsh-restore.mjs');
  const appConfigDir = path.join(repoRoot, 'app-config');
  if (!hasSyncRepo({ repoRoot }) || !fs.existsSync(restoreScript) || !fs.existsSync(appConfigDir)) {
    return {
      ok: true,
      skipped: true,
      reason: syncRepoUnavailableMessage(),
      hash: computeOfficialSettingsHash(repoRoot, safeProfile),
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

  const result = spawnSyncImpl(process.execPath, cliArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_HOME: dshHome,
    },
    windowsHide: true,
  });

  const hash = computeOfficialSettingsHash(repoRoot, safeProfile);
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
