import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { PLUGIN_ROOT, getRepoRoot, resolveSyncDir } from './sync-repo.js';

export { PLUGIN_ROOT, REPO_ROOT, getRepoRoot, resolveSyncRepoRoot, resolveSyncDir } from './sync-repo.js';

/**
 * 云服务清单文件：全机器共用一份，随仓库提交。
 * 只放跨机器可复用的定义，绝不放绝对路径、运行状态或凭据。
 */
export function resolveCloudManifestPath() {
  if (process.env.DSH_AU_CLOUD_MANIFEST_PATH) return process.env.DSH_AU_CLOUD_MANIFEST_PATH;
  return path.join(resolveSyncDir(), 'cloud', 'manifest.cloud.json');
}

/** 路径字段：只有落在本仓库内才写相对路径，其余一律留空。 */
const PATH_FIELDS = new Set(['scriptPath', 'stopScriptPath', 'workdir', 'log', 'configPath', 'plist']);

/** 整组参数拒绝上云：敏感标志及本机路径不能靠删除单个参数来修补。 */
function safeCloudArgs(value) {
  if (!Array.isArray(value)) return null;
  const credentialFlag = /(?:password|passwd|token|secret|apikey|credential|cookie|authorization|auth)/i;
  const hostPath = /(?:^|[=\s,;"']|:(?!\/\/))(?:[\\/]|[A-Za-z]:[\\/]|~(?:[\\/]|$)|\$(?:HOME\b|USERPROFILE\b|\{(?:HOME|USERPROFILE)\}|env:(?:HOME|USERPROFILE)\b)|%(?:HOME|USERPROFILE|HOMEDRIVE|HOMEPATH)%)|\bfile:\/\//i;
  const credentialUrl = /:\/\/[^/?#\s]*@|[?&](?:password|passwd|token|secret|api[_-]?key|credential|cookie|authorization|auth)=/i;
  for (const arg of value) {
    if (typeof arg !== 'string' || !arg.trim()) return null;
    const flagName = arg.trim().split(/[=:\s]/, 1)[0].replace(/[-_]/g, '');
    if (credentialFlag.test(flagName) || hostPath.test(arg) || credentialUrl.test(arg)) return null;
  }
  return [...value];
}

/**
 * 把本机绝对路径转成仓库内相对路径。
 * 不在仓库内（例如 ~/Library/Logs、别的项目）就返回空串——别的机器无法复用。
 */
export function toRepoRelativePath(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  const expanded = raw === '~' ? homedir() : raw.startsWith('~/') ? path.join(homedir(), raw.slice(2)) : raw;
  const repoRoot = getRepoRoot();
  // 允许直接写仓库内相对路径（如 docs/example.md），存在就规范成 posix 相对路径。
  if (!path.isAbsolute(expanded)) {
    const candidate = path.resolve(repoRoot, expanded);
    const rel = path.relative(repoRoot, candidate);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
    return existsSync(candidate) ? rel.split(path.sep).join('/') : '';
  }
  const absolute = path.resolve(expanded);
  const relative = path.relative(repoRoot, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
  // 只登记真实存在的文件或目录，避免把写错的路径同步出去。
  if (!existsSync(absolute)) return '';
  return relative.split(path.sep).join('/');
}

const SENSITIVE_QUERY_KEY_RE = /^(?:password|passwd|token|secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|credential|authorization|auth)$/i;
const RAW_CREDENTIAL_URL_RE = /:\/\/[^/?#\s]*@|[?&](?:password|passwd|token|secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|credential|authorization|auth)=/i;

function hasSensitiveQueryParam(url) {
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_QUERY_KEY_RE.test(key)) return true;
  }
  return false;
}

function sanitizeCloudHealthUrl(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    if (url.username || url.password || hasSensitiveQueryParam(url)) return '';
    return trimmed;
  } catch {
    return RAW_CREDENTIAL_URL_RE.test(trimmed) ? '' : trimmed;
  }
}

/**
 * 把一条已解析的服务条目压成云端字段。
 * 路径类字段在本项目内就填相对路径，否则留空；其余字段照原样写。
 */
export function buildCloudServiceEntry(svc) {
  const source = svc && typeof svc === 'object' ? svc : {};
  const entry = {
    name: String(source.name || ''),
    description: String(source.description || ''),
    scriptPath: toRepoRelativePath(source.scriptPath),
    workdir: toRepoRelativePath(source.workdir),
    // health 允许字符串或数组：数组原样保留，别被 String() 拼成 "a,b" 这种废值；含凭据的 URL 过滤掉。
    health: Array.isArray(source.health)
      ? source.health.map((url) => sanitizeCloudHealthUrl(url)).filter(Boolean)
      : sanitizeCloudHealthUrl(source.health),
    port: Number.isInteger(source.port) ? source.port : null,
    log: toRepoRelativePath(source.log),
    // 接入文档：非必填，只在文档位于本仓库内时才写相对路径。
    doc: toRepoRelativePath(source.doc),
    launcher: {
      // 绑定层字段叫 launchd.label，目录层叫 launcher.label，两个都兼容。
      label: String(source.launcher?.label || source.launchd?.label || ''),
    },
  };
  // 可选停止脚本复用路径脱敏；未配置时不改变旧云条目形状。
  if (Object.hasOwn(source, 'stopScriptPath')) {
    entry.stopScriptPath = toRepoRelativePath(source.stopScriptPath);
  }
  for (const key of ['args', 'stopArgs']) {
    const args = safeCloudArgs(source[key]);
    if (args) entry[key] = args;
  }
  if (Number.isSafeInteger(source.controlTimeoutMs) && source.controlTimeoutMs > 0) {
    entry.controlTimeoutMs = source.controlTimeoutMs;
  }
  if (source.category) entry.category = String(source.category);
  if (source.control) entry.control = String(source.control);
  if (Array.isArray(source.platforms)) entry.platforms = source.platforms.map(String);
  return entry;
}

/** 规范化已下线插件 tombstone 记录：每条结构 { id, package, patchId, removedAt }。 */
function normalizeRemovedPlugins(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const result = {};
  for (const [key, entry] of Object.entries(source)) {
    const id = String(key || '').trim();
    if (!id || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const pkg = typeof entry.package === 'string' ? entry.package.trim() : '';
    if (!pkg) continue;
    result[id] = {
      id,
      package: pkg,
      patchId: typeof entry.patchId === 'string' ? entry.patchId.trim() : '',
      removedAt: typeof entry.removedAt === 'string' ? entry.removedAt : '',
    };
  }
  return result;
}

/** 规范化云清单结构，保留并校验 services、devices、plugins 与 removedPlugins。 */
export function normalizeCloudManifest(parsed) {
  const source = parsed && typeof parsed === 'object' ? parsed : {};
  const services = source.services && typeof source.services === 'object' && !Array.isArray(source.services) ? source.services : {};
  const devices = Array.isArray(source.devices) ? source.devices : [];
  const plugins = source.plugins && typeof source.plugins === 'object' && !Array.isArray(source.plugins) ? source.plugins : {};
  const removedPlugins = normalizeRemovedPlugins(source.removedPlugins);
  return {
    schemaVersion: 1,
    updatedAt: String(source.updatedAt || ''),
    services,
    devices,
    plugins,
    removedPlugins,
  };
}

/**
 * 读取云清单；文件缺失或内容损坏时返回空结构，不让调用方崩。
 * 云清单同时装两类定义：services（服务定义）与 devices（跨机器连接定义）。
 */
export function readCloudManifest() {
  const filePath = resolveCloudManifestPath();
  const empty = { schemaVersion: 1, updatedAt: '', services: {}, devices: [], plugins: {}, removedPlugins: {} };
  if (!existsSync(filePath)) return { filePath, manifest: empty, error: '' };
  try {
    const raw = readFileSync(filePath, 'utf8').trim();
    if (!raw) return { filePath, manifest: empty, error: '' };
    const parsed = JSON.parse(raw);
    return {
      filePath,
      manifest: normalizeCloudManifest(parsed),
      error: '',
    };
  } catch (err) {
    return { filePath, manifest: empty, error: err.message };
  }
}

function writeCloudManifest(manifest) {
  const filePath = resolveCloudManifestPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  const removedPlugins = normalizeRemovedPlugins(manifest.removedPlugins);
  const payload = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    services: manifest.services || {},
    devices: Array.isArray(manifest.devices) ? manifest.devices : [],
    plugins: manifest.plugins && typeof manifest.plugins === 'object' ? manifest.plugins : {},
    ...(Object.keys(removedPlugins).length > 0 ? { removedPlugins } : {}),
  };
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
  return { filePath, manifest: payload };
}

/** 云端设备定义：v3 账本的 devices 已迁到这里，只有“怎么连到那台机器”这类共享信息。 */
export function readCloudDevices() {
  return readCloudManifest().manifest.devices;
}

/** 覆盖写设备定义；services 原样保留，互不干扰。 */
export function writeCloudDevices(devices) {
  const { manifest } = readCloudManifest();
  const list = Array.isArray(devices) ? devices : [];
  return writeCloudManifest({ ...manifest, devices: list });
}

/** 「同步到云」：把一条服务写进云清单（同 id 覆盖）。 */
export function upsertCloudService(svc, serviceId) {
  const id = String(serviceId || svc?.id || '').trim();
  if (!id) throw new Error('同步到云缺少服务 id');
  const { manifest } = readCloudManifest();
  const services = { ...manifest.services, [id]: buildCloudServiceEntry(svc) };
  return writeCloudManifest({ ...manifest, services });
}

/** 从云清单移除一条服务：只动这份文件，不碰本机状态。 */
export function removeCloudService(serviceId) {
  const id = String(serviceId || '').trim();
  if (!id) throw new Error('删除云服务缺少服务 id');
  const { manifest } = readCloudManifest();
  if (!manifest.services[id]) return { removed: false, ...manifest };
  const services = { ...manifest.services };
  delete services[id];
  const result = writeCloudManifest({ ...manifest, services });
  return { removed: true, ...result };
}

/**
 * 云端插件定义：只放「这个插件是什么、从哪装、配置快照在哪」，
 * 不放槽位、绝对路径、凭据与运行状态。键是插件的公共 id。
 */
export function readCloudPlugins() {
  const plugins = readCloudManifest().manifest.plugins || {};
  return Object.entries(plugins)
    .filter(([id, plugin]) => id && plugin && typeof plugin === 'object')
    .map(([id, plugin]) => ({ id, ...plugin }));
}

/** 仅持久化可安全传给 pnpm 的 http(s) registry，拒绝路径、其它协议、userinfo 与敏感 query 参数。 */
export function normalizeNpmRegistry(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (url.username || url.password || hasSensitiveQueryParam(url)) return '';
    return url.href;
  } catch {
    return '';
  }
}

/** 把插件基本字段压成云端定义；snapshot 只在落在仓库内时才写相对路径。 */
function buildCloudPluginEntry(plugin) {
  const source = plugin && typeof plugin === 'object' ? plugin : {};
  const entry = {
    name: String(source.name || source.package || ''),
    package: String(source.package || ''),
    source: source.source === 'local' ? 'local' : 'npm',
    version: String(source.version || ''),
  };
  // 公共插件省略此字段时同步器固定官方 npm；私有源才按清单带上显式 registry。
  const registry = normalizeNpmRegistry(source.registry);
  if (entry.source === 'npm' && registry) entry.registry = registry;
  const snapshot = toRepoRelativePath(source.snapshotDir || '');
  if (snapshot) entry.snapshot = snapshot;
  return entry;
}

/** 读取云端已下线插件 tombstone 列表。 */
export function readRemovedCloudPlugins() {
  return Object.values(readCloudManifest().manifest.removedPlugins || {});
}

/** 「同步到云」：把一条插件定义写进云清单（同 id 覆盖），同时清理对应下线记录。 */
export function upsertCloudPlugin(plugin, pluginId) {
  const id = String(pluginId || plugin?.id || '').trim();
  if (!id) throw new Error('同步到云缺少插件 id');
  const { manifest } = readCloudManifest();
  const nextEntry = buildCloudPluginEntry(plugin);
  const plugins = { ...manifest.plugins, [id]: nextEntry };
  const removedPlugins = { ...(manifest.removedPlugins || {}) };
  delete removedPlugins[id];
  if (nextEntry.package) {
    for (const [remId, rem] of Object.entries(removedPlugins)) {
      if (rem?.package === nextEntry.package) delete removedPlugins[remId];
    }
  }
  return writeCloudManifest({ ...manifest, plugins, removedPlugins });
}

/** 从云清单移除一条插件定义并写入 tombstone 记录：只动这份文件，不碰本机安装。 */
export function removeCloudPlugin(pluginId) {
  const id = String(pluginId || '').trim();
  if (!id) throw new Error('删除云插件缺少插件 id');
  const { manifest } = readCloudManifest();
  if (!manifest.plugins?.[id]) return { removed: false, ...manifest };
  const existing = manifest.plugins[id];
  const plugins = { ...manifest.plugins };
  delete plugins[id];
  const removedPlugins = {
    ...(manifest.removedPlugins || {}),
    [id]: {
      id,
      package: String(existing.package || ''),
      patchId: String(existing.patchId || ''),
      removedAt: new Date().toISOString(),
    },
  };
  const result = writeCloudManifest({ ...manifest, plugins, removedPlugins });
  return { removed: true, ...result };
}
