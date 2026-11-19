import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname, networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { normalizeWindowState } from './window-state.js';
import { normalizeAutoContinue, normalizeFeatures } from './features.js';
import { normalizeCloudSyncConfig } from './official-settings-sync.js';
import { readCloudDevices, readCloudManifest, readCloudPlugins, removeCloudPlugin, upsertCloudPlugin, writeCloudDevices } from './cloud-manifest.js';
import { getRepoRoot } from './sync-repo.js';
import { loadLocalBindings, loadLocalBindingState, writeLocalBindingState } from './local-bindings.js';
import { isLinkedPackage, readPluginPackageMeta, removePluginBundle } from './plugin-bundles.js';
import { resolvePluginDescription } from './plugin-descriptions.js';
import { normalizeHttpProxy } from './upstream-proxy.js';

/** 判断服务是否属于当前电脑可识别的本机服务；未接入且仅 Windows 可用的项对 Mac 隐藏。 */
export function isServiceListedForMachine(entry, platformOs, enabledIds = []) {
  if (!entry) return false;
  if ((enabledIds || []).includes(entry.id)) return true;
  if (entry.platform && entry.platform !== platformOs) return false;
  if (platformOs !== 'win32' && (entry.kind === 'windows-service' || entry.kind === 'native-smb' || entry.drive)) {
    return false;
  }
  return true;
}

export const DEFAULT_BRIDGE_PORT = 31990;
export const DEFAULT_UDP_PORT = 41980;

export const KNOWN_SERVICE_IDS = [];


/** 设备路径类型；云清单里的 routes[].type 只允许这四种。 */
const SHARED_ROUTE_TYPES = new Set(['local', 'lan', 'ipv6', 'tunnel']);

/**
 * 合法服务 id = 内置清单 ∪ 云清单 services ∪ 本机绑定 services。
 * JSON 是服务定义的来源，所以只在 JSON 里出现的 id 同样合法。
 */
export function knownServiceIds() {
  const ids = new Set(KNOWN_SERVICE_IDS);
  try {
    for (const id of Object.keys(readCloudManifest().manifest.services || {})) ids.add(id);
  } catch { /* 云清单读不到就只认内置 */ }
  try {
    for (const id of Object.keys(loadLocalBindings().services || {})) ids.add(id);
  } catch { /* 本机绑定读不到就只认内置 */ }
  return ids;
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeHostKey(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : 'default';
}

/** 同一台电脑的 hostname 只留第一段，忽略 .local 和大小写。 */
export function canonicalMachineHost(value) {
  let host = normalizeHostKey(value);
  if (host === 'default') return host;
  host = host.replace(/\.+$/, '');
  if (host.toLocaleLowerCase().endsWith('.local')) host = host.slice(0, -6);
  return host.split('.')[0] || 'default';
}

function findCaseInsensitiveEntry(entries, targetHostname) {
  if (!isPlainObject(entries)) return null;
  const wanted = normalizeHostKey(targetHostname).toLocaleLowerCase();
  return Object.entries(entries).find(([key]) => key.toLocaleLowerCase() === wanted) || null;
}

function findMachineEntry(entries, targetHostname) {
  if (!isPlainObject(entries)) return null;
  const wanted = canonicalMachineHost(targetHostname).toLocaleLowerCase();
  const matches = Object.entries(entries).filter(([key]) => canonicalMachineHost(key).toLocaleLowerCase() === wanted);
  if (!matches.length) return null;
  return matches.find(([key]) => !/\.local$/i.test(key)) || matches[0];
}

function storeMachineHostKey(entries, targetHostname) {
  const found = findMachineEntry(entries, targetHostname);
  if (found && !/\.local$/i.test(found[0])) return found[0];
  return canonicalMachineHost(targetHostname);
}

function getMachinePreset() {
  // 不再内置任何机器的服务预设：接入名单只由本机操作写入，避免换机时凭空冒出一堆服务。
  return { enabled: [], autoStartOnBoot: [], autoStartOnDsh: [] };
}

function assertConfigValue(condition, message) {
  if (!condition) throw new Error(`au 配置无效：${message}`);
}

function normalizeSharedRoute(raw) {
  if (!isPlainObject(raw) || typeof raw.id !== 'string' || !raw.id.trim()) return null;
  const type = normalizeTransport(raw.type);
  if (!SHARED_ROUTE_TYPES.has(type)) return null;
  if (type === 'local') {
    return raw.url === undefined && raw.username === undefined ? { id: raw.id.trim(), type } : null;
  }
  if (typeof raw.url !== 'string' || !raw.url.trim()) return null;
  let parsed;
  try { parsed = new URL(raw.url); } catch { return null; }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  if (type !== 'lan' && parsed.protocol !== 'https:') return null;
  if (type === 'lan' && !['http:', 'https:'].includes(parsed.protocol)) return null;
  return {
    id: raw.id.trim(),
    type,
    url: parsed.href,
    ...(typeof raw.username === 'string' && raw.username ? { username: raw.username } : {}),
  };
}

function sanitizeServiceIdList(list, fallback = []) {
  const source = Array.isArray(list) ? list : fallback;
  const known = knownServiceIds();
  return [...new Set(source.filter((id) => typeof id === 'string' && known.has(id)))];
}

/** 规范化单台电脑的后台服务组合与自启动配置（按 hostname 隔离） */
export function normalizeMachineServiceProfile(raw, hostKey = '') {
  const preset = getMachinePreset(hostKey);
  if (!raw || typeof raw !== 'object') {
    return {
      enabled: [...preset.enabled],
      autoStartOnBoot: [...preset.autoStartOnBoot],
      autoStartOnDsh: [...preset.autoStartOnDsh],
    };
  }
  const enabled = sanitizeServiceIdList(raw.enabled, preset.enabled);
  // 没接入本机的服务不该留着自启勾选：自启必须是被启用项的子集。
  const restrictToEnabled = (list, fallback) => sanitizeServiceIdList(list, fallback)
    .filter((id) => enabled.includes(id));
  return {
    enabled,
    autoStartOnBoot: restrictToEnabled(raw.autoStartOnBoot, preset.autoStartOnBoot),
    autoStartOnDsh: restrictToEnabled(raw.autoStartOnDsh, preset.autoStartOnDsh),
  };
}

/** 只缓存已验证的远端身份；不接受密码或用户可编辑字段作为归并依据。 */
export function normalizeKnownIdentity(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const instanceId = typeof raw.instanceId === 'string' ? raw.instanceId.trim() : '';
  const host = typeof raw.hostname === 'string' ? raw.hostname.trim() : '';
  const ips = Array.isArray(raw.ips)
    ? [...new Set(raw.ips.filter((ip) => typeof ip === 'string' && ip.trim()).map((ip) => ip.trim()))]
    : [];
  return instanceId || host || ips.length ? { instanceId, hostname: host, ips } : null;
}

/** 规范化用户确认的物理设备绑定与通路类型；两者均不含凭据。 */
function normalizeDeviceId(raw) {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : '';
}

function normalizeTransport(raw) {
  return SHARED_ROUTE_TYPES.has(raw) ? raw : '';
}

/** 规范化单条远程设备配置。password 只允许留在本机配置。 */
export function normalizeRemote(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rawUrl = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!rawUrl) return null;
  let parsed;
  try {
    parsed = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
  } catch {
    return null;
  }
  const id = typeof raw.id === 'string' && raw.id.trim()
    ? raw.id.trim()
    : `r_${randomBytes(5).toString('hex')}`;
  const name = typeof raw.name === 'string' && raw.name.trim()
    ? raw.name.trim()
    : parsed.host;
  const knownIdentity = normalizeKnownIdentity(raw.knownIdentity);
  const deviceId = normalizeDeviceId(raw.deviceId);
  const transport = normalizeTransport(raw.transport);
  // Clash 代理是本机运行态：只允许 tunnel 路径带无凭据 HTTP/mixed-port 地址，绝不进入云清单。
  const proxyUrl = transport === 'tunnel' ? normalizeHttpProxy(raw.proxyUrl) : '';
  return {
    id,
    name,
    url: parsed.href,
    username: typeof raw.username === 'string' ? raw.username : '',
    password: typeof raw.password === 'string' ? raw.password : '',
    ...(knownIdentity ? { knownIdentity } : {}),
    ...(deviceId ? { deviceId } : {}),
    ...(transport ? { transport } : {}),
    ...(proxyUrl ? { proxyUrl } : {}),
  };
}

/** 读取当前 DSH Profile 直接安装的插件包名与启用状态，本机名单与清单共用一份读取。 */
function readLocalProfilePackages(profile = 'desktop') {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const profileDir = join(dshHome, 'profiles', profile);
  const packageJson = readJsonFile(join(profileDir, 'package.json'), {});
  const dependencies = isPlainObject(packageJson?.dependencies) ? packageJson.dependencies : {};
  // 启用状态以 profile 的 bundles 为准：装了但不在 bundles 里的插件不会被加载。
  const enabledPackages = new Set(
    (Array.isArray(packageJson?.dsh?.profile?.bundles) ? packageJson.dsh.profile.bundles : [])
      .filter((item) => typeof item === 'string')
  );
  return { profileDir, dependencies, enabledPackages };
}

/** 返回共享设备定义；定义只在云清单里，本机不再保留副本。 */
export function getSharedDevices() {
  return loadDeviceList();
}

/** 把云清单设备路径投影成 proxy 层使用的扁平远程路线，local 路径不进入远程池。 */
export function flattenSharedDeviceRoutes(devices = getSharedDevices()) {
  return devices.flatMap((device) => (device?.routes || [])
    .filter((route) => route?.type !== 'local')
    .map((route) => ({
      id: route.id,
      name: device.name,
      url: route.url,
      username: route.username || '',
      deviceId: device.id,
      transport: route.type,
    })));
}

/** 远程路线只来自云清单；没有设备时返回空表，不再内置任何假地址。 */
export function loadSharedRemotes() {
  return flattenSharedDeviceRoutes()
    .map((remote) => normalizeRemote({ ...remote, password: '' }))
    .filter(Boolean);
}

/** 云清单里定义的 DSH 插件；定义只有一份，不再读本地账本副本。 */
export function getSharedDshPlugins() {
  return readCloudPlugins().filter((plugin) => typeof plugin?.id === 'string' && typeof plugin.package === 'string');
}

/**
 * 当前电脑接入了哪些云插件：只看本机 DSH Profile。
 * 已安装且已启用的云插件即视为接入；每台电脑各管自己，不读跨机器名单。
 */
export function getMachineDshPluginIds(targetHostname = hostname()) {
  const { profileDir, enabledPackages } = readLocalProfilePackages();
  const disabledPluginKeys = readDisabledProfilePluginKeys(profileDir);
  return getSharedDshPlugins()
    // bundles 的装载资格还会被 patch 的 disabled: true 覆盖。
    .filter((plugin) => enabledPackages.has(plugin.package)
      && !disabledPluginKeys.has(plugin.package)
      && !disabledPluginKeys.has(plugin.package.split('/').pop()))
    .map((plugin) => plugin.id);
}

/** 面板只关心本机名单：跨机器名单已取消，其他电脑各读自己的 Profile。 */
export function getMachineDshPluginProfiles() {
  return { [canonicalMachineHost(hostname())]: getMachineDshPluginIds() };
}

/**
 * 读取当前机器服务开关：只认当前 machines 绑定与 local/state.json。
 * 旧 dsh-au.config.json 的 machineServiceProfiles 只在首次迁移时读取，之后不再参与运行态。
 */
export function getMachineServiceProfile(_cfg, targetHostname = hostname()) {
  const binding = loadLocalBindings(targetHostname);
  const state = loadLocalBindingState(binding.machineId).services;
  const registered = new Set(Object.keys(binding.services || {}));
  const enabled = [...registered].filter((id) => state?.[id]?.enabled === true);
  return {
    enabled,
    autoStartOnBoot: enabled.filter((id) => state?.[id]?.autoStartOnBoot === true),
    autoStartOnDsh: enabled.filter((id) => state?.[id]?.autoStartOnDsh === true),
  };
}

/**
 * 一次性迁移旧开关：只处理当前机器绑定 JSON 里登记、但 state.json 还没有记录的服务。
 * 旧名单里有、绑定 JSON 里没有的服务不会被接入；已有状态的服务不会被旧值覆盖。
 */
function migrateLegacyServiceFlags(rawProfiles, currentHost) {
  const legacy = findMachineEntry(rawProfiles, normalizeHostKey(currentHost))?.[1];
  if (!isPlainObject(legacy)) return;
  try {
    const binding = loadLocalBindings(currentHost);
    if (!binding.exists) return;
    const existing = loadLocalBindingState(binding.machineId).services || {};
    const has = (field, id) => Array.isArray(legacy[field]) && legacy[field].includes(id);
    writeLocalBindingState(currentHost, (serviceId) => (existing[serviceId] ? null : {
      enabled: has('enabled', serviceId),
      autoStartOnBoot: has('enabled', serviceId) && has('autoStartOnBoot', serviceId),
      autoStartOnDsh: has('enabled', serviceId) && has('autoStartOnDsh', serviceId),
    }));
  } catch {
    // 迁移失败不阻塞加载配置；对应服务按「全部关闭」展示，用户可在面板里重新打开。
  }
}

/** 云清单里出现即视为「已上云」：定义就是登记，不再单独维护服务 ID 名单。 */
export function getSharedCloudServiceIds() {
  return Object.keys(readCloudManifest().manifest.services || {});
}

/** 面板只展示当前机器绑定 JSON 派生的开关，不再回读旧本机配置名单。 */
export function getMachineServiceProfiles(cfg) {
  const currentHost = hostname();
  return { [canonicalMachineHost(currentHost)]: getMachineServiceProfile(cfg, currentHost) };
}

/** 更新当前本机绑定服务的开关，只落盘到被忽略的 local/state.json。 */
export function updateMachineServiceProfile(cfg, targetHostname, patch) {
  const hostKey = normalizeHostKey(targetHostname || hostname());
  const current = getMachineServiceProfile(cfg, hostKey);
  const registered = new Set(Object.keys(loadLocalBindings(hostKey).services || {}));
  const normalize = (ids) => [...new Set((Array.isArray(ids) ? ids : []).filter((id) => registered.has(id)))];
  const enabled = normalize(patch?.enabled !== undefined ? patch.enabled : current.enabled);
  const profile = {
    enabled,
    autoStartOnBoot: normalize(patch?.autoStartOnBoot !== undefined ? patch.autoStartOnBoot : current.autoStartOnBoot)
      .filter((id) => enabled.includes(id)),
    autoStartOnDsh: normalize(patch?.autoStartOnDsh !== undefined ? patch.autoStartOnDsh : current.autoStartOnDsh)
      .filter((id) => enabled.includes(id)),
  };
  const written = writeLocalBindingState(hostKey, (serviceId) => ({
    enabled: profile.enabled.includes(serviceId),
    autoStartOnBoot: profile.autoStartOnBoot.includes(serviceId),
    autoStartOnDsh: profile.autoStartOnDsh.includes(serviceId),
  }));
  if (!written.ok) throw new Error(written.reason || '本机服务状态保存失败');
  return profile;
}

/** 单个开关基于最新持久化状态更新，避免旧页面提交整份名单覆盖其他刚保存的开关。 */
export function updateMachineServiceFlag(cfg, targetHostname, serviceId, field, value) {
  if (!['enabled', 'autoStartOnBoot', 'autoStartOnDsh'].includes(field) || typeof value !== 'boolean') {
    throw new Error('服务开关参数无效');
  }
  const registered = loadLocalBindings(targetHostname).services || {};
  if (!Object.hasOwn(registered, serviceId)) throw new Error('该服务尚未登记到本机');
  const current = getMachineServiceProfile(cfg, targetHostname);
  const next = value
    ? [...new Set([...current[field], serviceId])]
    : current[field].filter((id) => id !== serviceId);
  // 已登记本机的服务开启「开机自启 / 随 DSH」时自动联动开启「本机启用」，避免必须先去详情栏点一次隐藏开关
  const nextEnabled = field === 'enabled'
    ? next
    : (value ? [...new Set([...current.enabled, serviceId])] : current.enabled);
  return updateMachineServiceProfile(cfg, targetHostname, { ...current, enabled: nextEnabled, [field]: next });
}

/**
 * 把本机启用的服务纳入「已上云」：启用状态写本机配置，
 * 云清单里的服务定义由调用方用 upsertCloudService 写入——定义即登记。
 */
export function promoteLocalServiceToCloud(serviceId, targetHostname = hostname()) {
  const id = typeof serviceId === 'string' ? serviceId.trim() : '';
  assertConfigValue(knownServiceIds().has(id), `未知后台服务: ${id}`);
  const cfg = loadConfig();
  const hostKey = normalizeHostKey(targetHostname || hostname());
  const current = getMachineServiceProfile(cfg, hostKey);
  const nextProfile = normalizeMachineServiceProfile({
    ...current,
    enabled: [...current.enabled, id],
  }, hostKey);
  updateMachineServiceProfile(cfg, hostKey, nextProfile);
  return { serviceId: id, cloudServiceIds: getSharedCloudServiceIds(), profile: nextProfile };
}

/** 从 npm 包名生成稳定、安全且可读的公共插件 ID；冲突时追加递增后缀。 */
function createCloudPluginId(packageName, existingIds) {  const base = packageName
    .replace(/^@/, '')
    .replace(/[\\/_]+/g, '-')
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'dsh-plugin';
  let id = base;
  let suffix = 2;
  while (existingIds.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  return id;
}

/**
 * 将当前 DSH Profile 已安装的单个插件纳入云清单，并选中当前电脑。
 * 定义写 cloud/manifest.cloud.json（含配置快照的相对路径）；本机接入情况由 DSH Profile 决定。
 * 绝不上传 node_modules 路径、凭据、运行状态或插件数据。
 * @param {string} packageName npm 包名
 * @param {string} targetHostname 目标电脑名
 * @param {{snapshotDir?: string}} [options] 配置快照目录（仓库内绝对路径）
 */
export function promoteLocalDshPluginToCloud(packageName, targetHostname = hostname(), options = {}) {
  const dshHome = options.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh');
  const localPlugin = getLocalDshPluginInventory('desktop', dshHome).find((plugin) => plugin.package === packageName);
  if (!localPlugin) throw new Error('该插件不在当前 DSH Profile 的直接安装清单中');

  const shared = getSharedDshPlugins();
  const existing = shared.find((plugin) => plugin.package === packageName);
  // 仓库内软链的插件（例如 dsh-au 自己）不是 npm 包，来源要如实标成 local。
  const linked = isLinkedPackage(join(dshHome, 'profiles', 'desktop'), packageName);
  const plugin = existing || {
    id: createCloudPluginId(packageName, new Set(shared.map((item) => item.id))),
    name: packageName,
    package: packageName,
    source: linked ? 'local' : 'npm',
    version: localPlugin.version,
    restartRequired: true,
  };
  upsertCloudPlugin({ ...plugin, version: localPlugin.version || plugin.version, snapshotDir: options.snapshotDir || '' }, plugin.id);

  // restartRequired 是界面提示用的语义字段，不写进云清单（那是定义）。
  return { ...plugin, version: localPlugin.version || plugin.version, restartRequired: true };
}

/** 读取当前 DSH Profile 的 bundles 加载顺序，供备份与跨机还原保持一致。 */
export function readLocalDshBundleOrder(profile = 'desktop', dshHomeOverride = '') {
  const dshHome = dshHomeOverride || process.env.DSH_HOME || join(homedir(), '.dsh');
  const packagePath = join(dshHome, 'profiles', profile, 'package.json');
  const packageJson = readJsonFile(packagePath, {});
  return (Array.isArray(packageJson?.dsh?.profile?.bundles) ? packageJson.dsh.profile.bundles : [])
    .filter((item) => typeof item === 'string' && item.trim());
}

/**
 * 将当前 DSH Profile 直接安装的所有第三方插件一次性纳入云清单，并返回其云插件 ID 列表与加载顺序。
 */
export function promoteAllLocalDshPluginsToCloud(targetHostname = hostname(), bundlesByPackage = new Map(), dshHomeOverride = '') {
  const dshHome = dshHomeOverride || process.env.DSH_HOME || join(homedir(), '.dsh');
  const inventory = getLocalDshPluginInventory('desktop', dshHome);
  const promoted = [];
  for (const item of inventory) {
    const snap = bundlesByPackage instanceof Map ? bundlesByPackage.get(item.package) : null;
    const cloudPlugin = promoteLocalDshPluginToCloud(item.package, targetHostname, {
      snapshotDir: snap?.dir || '',
      dshHome,
    });
    promoted.push(cloudPlugin);
  }
  const sharedByPkg = new Map(getSharedDshPlugins().map((plugin) => [plugin.package, plugin.id]));
  const pluginIds = inventory
    .map((item) => sharedByPkg.get(item.package))
    .filter(Boolean);
  return {
    promoted,
    pluginIds,
    bundleOrder: readLocalDshBundleOrder('desktop', dshHome),
  };
}

/**
 * 从云清单删除一个插件：摘定义、清掉各电脑名单里的引用、删掉仓库里的配置快照目录。
 * 不卸载本机已装插件，也不停任何进程——那属于本机操作。
 */
export function removeCloudDshPlugin(pluginId, options = {}) {
  const id = typeof pluginId === 'string' ? pluginId.trim() : '';
  if (!id) throw new Error('删除云插件缺少插件 id');
  const plugin = getSharedDshPlugins().find((item) => item.id === id);
  if (!plugin) throw new Error('云清单里没有这个插件');

  const removedDefinition = removeCloudPlugin(id);

  const removedBundle = removePluginBundle(options.repoRoot || getRepoRoot(), plugin.package);
  return {
    plugin,
    removedDefinition: removedDefinition.removed,
    removedBundle,
    cloudManifestPath: removedDefinition.filePath,
  };
}

/**
 * 设备定义统一读写云清单：它是“怎么连到那台机器”的共享定义，随仓库走。
 * 设备定义只有云清单一处，本机不再保留副本。
 */
function loadDeviceList() {
  const cloud = readCloudDevices();
  const source = cloud;
  return source.map((device) => ({ ...device, routes: [...(device.routes || [])] }));
}

function saveDeviceList(devices) {
  writeCloudDevices(devices);
}

/** 新建或重命名手动设备；路径只能由独立的 route 操作管理。 */
export function updateSharedDevice(device) {
  const devices = loadDeviceList();
  const id = normalizeDeviceId(device?.id) || `device_${randomBytes(5).toString('hex')}`;
  const name = typeof device?.name === 'string' ? device.name.trim() : '';
  assertConfigValue(name, '设备名称不能为空');
  const index = devices.findIndex((item) => item.id === id);
  const next = index >= 0
    ? { ...devices[index], name }
    : { id, name, routes: [] };
  if (index >= 0) devices[index] = next;
  else devices.push(next);
  saveDeviceList(devices);
  return next;
}

/** 删除一个手动设备及其公共路径；本机留存的密码不自动清理。 */
export function deleteSharedDevice(id) {
  const devices = loadDeviceList();
  const before = devices.length;
  const next = devices.filter((device) => device.id !== id);
  if (next.length === before) return false;
  saveDeviceList(next);
  return true;
}

/** 保存一条明确属于某设备的路径；不通过名称、主机名或 IP 猜测归属。 */
export function updateSharedDeviceRoute(deviceId, route) {
  const devices = loadDeviceList();
  const deviceIndex = devices.findIndex((device) => device.id === deviceId);
  assertConfigValue(deviceIndex >= 0, '所属设备不存在');
  const candidate = {
    id: typeof route?.id === 'string' && route.id.trim() ? route.id.trim() : `route_${randomBytes(5).toString('hex')}`,
    type: route?.type,
    ...(route?.url !== undefined ? { url: route.url } : {}),
    ...(route?.username ? { username: route.username } : {}),
  };
  const normalized = normalizeSharedRoute(candidate);
  assertConfigValue(normalized, '路径类型或地址无效');
  let previousDeviceIndex = -1;
  let previousRouteIndex = -1;
  devices.forEach((device, index) => {
    const routeIndex = device.routes.findIndex((item) => item.id === normalized.id);
    if (routeIndex >= 0) { previousDeviceIndex = index; previousRouteIndex = routeIndex; }
  });
  if (previousDeviceIndex >= 0 && previousDeviceIndex !== deviceIndex) {
    devices[previousDeviceIndex].routes.splice(previousRouteIndex, 1);
  }
  const currentDevice = devices[deviceIndex];
  const currentRouteIndex = currentDevice.routes.findIndex((item) => item.id === normalized.id);
  if (currentRouteIndex >= 0) currentDevice.routes[currentRouteIndex] = normalized;
  else currentDevice.routes.push(normalized);
  saveDeviceList(devices);
  return { device: currentDevice, route: normalized };
}

/** 只删除指定设备中的一条公共路径；本机密码和身份缓存不受影响。 */
export function deleteSharedDeviceRoute(deviceId, routeId) {
  const devices = loadDeviceList();
  const device = devices.find((item) => item.id === deviceId);
  if (!device) return false;
  const before = device.routes.length;
  device.routes = device.routes.filter((route) => route.id !== routeId);
  if (device.routes.length === before) return false;
  saveDeviceList(devices);
  return true;
}

/** 兼容旧调用方：将扁平 remote 写入显式设备中的 route。 */
export function updateSharedRemote(remote) {
  // 只同步公共字段，密码留给本机配置，绝不写进云清单。
  const normalized = normalizeRemote({ ...remote, password: '' });
  if (!normalized) return null;
  const { password, knownIdentity, proxyUrl: _localProxyUrl, ...shared } = normalized;
  const deviceId = normalizeDeviceId(shared.deviceId) || `legacy-${shared.id}`;
  const currentDevice = loadDeviceList().find((device) => device.id === deviceId);
  if (!currentDevice) updateSharedDevice({ id: deviceId, name: shared.name });
  const updated = updateSharedDeviceRoute(deviceId, {
    id: shared.id,
    type: shared.transport || 'tunnel',
    url: shared.url,
    username: shared.username,
  });
  return {
    id: updated.route.id,
    name: updated.device.name,
    url: updated.route.url,
    username: updated.route.username || '',
    deviceId: updated.device.id,
    transport: updated.route.type,
  };
}

/** 兼容旧调用方：按 route ID 删除，不会影响同设备的其它路径。 */
export function deleteSharedRemote(id) {
  const device = getSharedDevices().find((item) => item.routes.some((route) => route.id === id));
  return device ? deleteSharedDeviceRoute(device.id, id) : false;
}

/**
 * 仓库是远端元数据的 SSOT：同步名称、地址、用户名和稳定 ID；
 * 目标机仅保留各远端的密码，额外的本地远端也不删除。
 */
export function mergeSharedRemotes(localRemotes, sharedRemotes) {
  const merged = [...localRemotes];
  for (const shared of sharedRemotes) {
    const index = merged.findIndex((remote) => remote.id === shared.id || remote.url === shared.url);
    if (index < 0) {
      // 每条新路径的密码必须在当前电脑单独确认，绝不因同设备归属而复制到另一地址。
      merged.push({ ...shared, password: '' });
      continue;
    }
    const previous = merged[index];
    // 身份缓存、密码与本机 Clash 路径只能随未变的目标地址和用户名保留，避免换址或换账号后泄漏旧凭据。
    const sameTarget = previous.url === shared.url
      && (previous.username || '') === (shared.username || '');
    const password = sameTarget ? (previous.password || '') : '';
    const knownIdentity = sameTarget ? previous.knownIdentity : null;
    const proxyUrl = sameTarget && shared.transport === 'tunnel' ? previous.proxyUrl : '';
    merged[index] = {
      ...shared,
      password,
      ...(knownIdentity ? { knownIdentity } : {}),
      ...(proxyUrl ? { proxyUrl } : {}),
    };
  }
  return merged;
}

/** 解析本机 ~/.dsh/dsh-au.config.json 路径（允许测试通过环境变量覆盖） */
export function resolveConfigPath() {
  if (process.env.DSH_AU_CONFIG_PATH) return process.env.DSH_AU_CONFIG_PATH;
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(dshHome, 'dsh-au.config.json');
}

/** 读取本机持久化配置；远程路线来自云清单，服务开关只取本机。 */
export function loadConfig() {
  const filePath = resolveConfigPath();
  const raw = existsSync(filePath) ? readJsonFile(filePath, {}) : {};
  const instanceId = typeof raw.instanceId === 'string' && raw.instanceId
    ? raw.instanceId
    : `au_${randomBytes(6).toString('hex')}`;
  // 局域网免密接入会把本机 DSH 登录身份借给同网段连接者，必须由用户明确开启；已保存的选择保持不变。
  const lanShareEnabled = typeof raw.lanShareEnabled === 'boolean' ? raw.lanShareEnabled : false;
  const bridgePort = Number.isInteger(raw.bridgePort) && raw.bridgePort > 0 ? raw.bridgePort : DEFAULT_BRIDGE_PORT;
  const udpPort = Number.isInteger(raw.udpPort) && raw.udpPort > 0 ? raw.udpPort : DEFAULT_UDP_PORT;
  // 本机归属由用户明确选择；不从 hostname、IP 或 instanceId 推断公共设备。
  const localDeviceId = normalizeDeviceId(raw.localDeviceId);
  const localRemotes = Array.isArray(raw.remotes)
    ? raw.remotes.map(normalizeRemote).filter(Boolean)
    : [];
  const remotes = mergeSharedRemotes(localRemotes, loadSharedRemotes());

  const rawProfiles = raw.machineServiceProfiles && typeof raw.machineServiceProfiles === 'object'
    ? raw.machineServiceProfiles
    : {};
  migrateLegacyServiceFlags(rawProfiles, hostname());
  // 没有存过收藏就是空的，不再预置四个旧菜单。
  const menuFavorites = Array.isArray(raw.menuFavorites)
    ? [...new Set(raw.menuFavorites.filter((code) => typeof code === 'string' && /^\d{2}$/.test(code)))]
    : [];
  // 窗口位置记忆由桌面端插件写入；此处只做归一化，脏数据不参与还原。
  const windowState = normalizeWindowState(raw.windowState);
  const features = normalizeFeatures(raw.features);
  const autoContinue = normalizeAutoContinue(raw.autoContinue);

  const cloudSync = normalizeCloudSyncConfig(raw.cloudSync);
  // 保留本机私人路径字段，保存时不要丢
  const syncRepoRoot = typeof raw.syncRepoRoot === 'string' ? raw.syncRepoRoot.trim() : '';
  const auwinRoot = typeof raw.auwinRoot === 'string' ? raw.auwinRoot.trim() : '';
  const cfg = {
    instanceId, lanShareEnabled, bridgePort, udpPort, localDeviceId, remotes, menuFavorites, windowState, features, autoContinue, cloudSync,
    ...(syncRepoRoot ? { syncRepoRoot } : {}),
    ...(auwinRoot ? { auwinRoot } : {}),
  };
  if (raw.clientPreferences && typeof raw.clientPreferences === 'object') {
    cfg.clientPreferences = raw.clientPreferences;
  }
  // 旧服务名单原样透传：保存配置时不改写也不丢失，但运行态不再读取（回滚依据）。
  if (Object.keys(rawProfiles).length) {
    Object.defineProperty(cfg, 'machineServiceProfiles', { value: rawProfiles, enumerable: true, writable: false });
  }
  // 首次安装、新增共享设备或共享元数据更新时写回；不会清空目标机密码或 instanceId。
  if (!existsSync(filePath) || JSON.stringify(remotes) !== JSON.stringify(localRemotes)) saveConfig(cfg);
  return cfg;
}

/** 保存本机私密与运行时配置到 ~/.dsh/dsh-au.config.json */
export function saveConfig(cfg) {
  const filePath = resolveConfigPath();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(cfg, null, 2), 'utf8');
  return cfg;
}

/** 读取 profile patch 中被显式 disabled 的插件 id / 包名，补足 bundles 的加载状态。 */
function readDisabledProfilePluginKeys(profileDir) {
  const patchPath = join(profileDir, 'cordis.patch.yml');
  let text = '';
  try { text = readFileSync(patchPath, 'utf8'); } catch { return new Set(); }

  const disabled = new Set();
  let current = null;
  const flush = () => {
    if (current?.disabled) {
      if (current.id) disabled.add(current.id);
      if (current.name) disabled.add(current.name);
    }
  };
  for (const line of text.split(/\r?\n/)) {
    const entry = line.match(/^- id:\s*(.+?)\s*$/);
    if (entry) {
      flush();
      current = { id: entry[1].trim(), name: '', disabled: false };
      continue;
    }
    if (!current) continue;
    const name = line.match(/^\s+name:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))\s*$/);
    if (name) current.name = name[1] || name[2] || name[3] || '';
    if (/^\s+disabled:\s*true(?:\s+#.*)?\s*$/.test(line)) current.disabled = true;
  }
  flush();
  return disabled;
}

/**
 * 读取当前 DSH Profile 直接安装的插件，不扫描 node_modules 的传递依赖。
 * version 优先已装包版本；没有元信息时兼容声明版本，但安装事实标为未验证。
 * 默认保持旧的可枚举字段，新增事实可直接访问；includeInstallFacts:true 用于 JSON/API 输出。
 */
export function getLocalDshPluginInventory(profile = 'desktop', dshHomeOverride = '', { includeInstallFacts = false } = {}) {
  // 调用方传入目标 DSH 目录时必须读取那份 Profile，不能悄悄回落到当前机器。
  const dshHome = dshHomeOverride || process.env.DSH_HOME || join(homedir(), '.dsh');
  const profileDir = join(dshHome, 'profiles', profile);
  const packagePath = join(profileDir, 'package.json');
  const packageJson = readJsonFile(packagePath, {});
  const dependencies = isPlainObject(packageJson?.dependencies) ? packageJson.dependencies : {};
  // 启用状态以 profile 的 bundles 为准：装了但不在 bundles 里的插件不会被加载。
  const enabledPackages = new Set(
    (Array.isArray(packageJson?.dsh?.profile?.bundles) ? packageJson.dsh.profile.bundles : [])
      .filter((item) => typeof item === 'string')
  );
  const disabledPluginKeys = readDisabledProfilePluginKeys(profileDir);
  const cloudPlugins = getSharedDshPlugins();
  const cloudByPackage = new Map(cloudPlugins.map((plugin) => [plugin.package, plugin]));
  const selectedIds = new Set(getMachineDshPluginIds());

  /** 描述优先用中文覆盖表，其次插件自身 package.json；包名不合法时直接跳过，避免拼出越界路径。 */
  const readPluginDescription = (packageName) => {
    const fallback = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(packageName)
      ? readJsonFile(join(profileDir, 'node_modules', packageName, 'package.json'), {})
      : {};
    return resolvePluginDescription(packageName, typeof fallback?.description === 'string' ? fallback.description.trim() : '');
  };

  return Object.entries(dependencies)
    .filter(([packageName, version]) => typeof packageName === 'string' && typeof version === 'string')
    .map(([packageName, requestedSpec]) => {
      const cloudPlugin = cloudByPackage.get(packageName);
      const meta = readPluginPackageMeta(profileDir, packageName);
      const item = {
        id: cloudPlugin?.id || packageName,
        name: cloudPlugin?.name || packageName,
        package: packageName,
        version: meta.version || requestedSpec,
        description: readPluginDescription(packageName),
        // bundle 仅表示被装载；patch 的 disabled: true 才是最终运行态。
        enabled: enabledPackages.has(packageName)
          && !disabledPluginKeys.has(packageName)
          && !disabledPluginKeys.has(packageName.split('/').pop()),
        source: cloudPlugin?.source || 'local-profile',
        cloudManaged: Boolean(cloudPlugin),
        selectedForCurrentMachine: Boolean(cloudPlugin && selectedIds.has(cloudPlugin.id)),
      };
      // 旧面板/深比较默认不新增键；同步核心可直接取事实，API 输出时显式展开。
      for (const [key, value] of Object.entries({
        requestedSpec,
        installedVersion: meta.version,
        installed: meta.installed,
        installationVerified: meta.installed,
      })) {
        Object.defineProperty(item, key, { value, enumerable: includeInstallFacts });
      }
      return item;
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** 获取本机电脑名与局域网 IPv4 地址列表 */
export function getLocalHostInfo() {
  const nets = networkInterfaces();
  const ips = [];
  for (const list of Object.values(nets)) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.')) {
        ips.push(item.address);
      }
    }
  }
  return { hostname: hostname(), ips };
}

/** 优先家庭/办公网段，避免把 VPN 地址写成公共局域网路径。 */
export function buildLanShareUrl(ips, port) {
  const list = Array.isArray(ips) ? ips.filter((ip) => typeof ip === 'string') : [];
  const lanIp = list.find((ip) => /^192\.168\./.test(ip))
    || list.find((ip) => /^10\./.test(ip))
    || list.find((ip) => /^172\.(1[6-9]|2\d|3[01])\./.test(ip));
  const bridgePort = Number(port);
  return lanIp && Number.isInteger(bridgePort) && bridgePort > 0
    ? `http://${lanIp}:${bridgePort}/`
    : '';
}

/**
 * 把探测到的局域网地址写到已绑定设备的公共 lan 路径。
 * 只认云清单里已有的 deviceId；不写 instanceId、hostname 或密码。
 */
export function applyDiscoveredLanPeer(peer) {
  const deviceId = normalizeDeviceId(peer?.deviceId);
  if (!deviceId) return null;
  const device = getSharedDevices().find((item) => item.id === deviceId);
  if (!device) return null;
  if (typeof peer?.url !== 'string') return null;
  let parsed;
  try { parsed = new URL(peer.url); } catch { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  const existingLan = (device.routes || []).find((route) => route.type === 'lan');
  if (existingLan?.url === parsed.href) return { device, route: existingLan, unchanged: true };
  return {
    ...updateSharedDeviceRoute(deviceId, {
      id: existingLan?.id || `lan_${deviceId}`,
      type: 'lan',
      url: parsed.href,
    }),
    unchanged: false,
  };
}

/** 本机绑定后立刻公布当前桥接地址，供局域网其他电脑探测后写入同一条路径。 */
export function publishLocalLanShare(deviceId, ips, port) {
  const url = buildLanShareUrl(ips, port);
  return url ? applyDiscoveredLanPeer({ deviceId, url }) : null;
}
