import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, hostname as osHostname } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { getRepoRoot, hasSyncRepo, resolveSyncDir, syncRepoUnavailableMessage } from './sync-repo.js';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const SYNC_DIR = path.resolve(LIB_DIR, '..', 'sync');

/** 本机目录：只放「当前用哪一份」和频繁变动的开关，整体被 .gitignore 忽略。 */
const LOCAL_DIR = path.join(SYNC_DIR, 'local');

/** 旧版固定文件名，仅用于一次性迁移。 */
const LEGACY_NAME = 'manifest.local.json';
/** 指针：只写 machineId，不写路径，目录搬家不用改。 */
const POINTER_NAME = 'active.json';
/** 开关镜像：勾选一次就变一次，必须留在本地，否则每点一下就脏一棵树。 */
const STATE_NAME = 'state.json';

/** 凭据类字段一律禁止出现在本机绑定里，和公共账本用同一套红线。 */
const FORBIDDEN_FIELD = /(?:password|passwd|token|secret|api[_-]?key|credential|cookie)/i;
/** 只属于运行态的四个开关：写进 state.json，不写进随仓库提交的备份。 */
const RUNTIME_FLAGS = ['enabled', 'autoStartOnBoot', 'autoStartOnDsh', 'cloud'];
/** 会被写成 ~/ 缩写的本机路径字段。 */
const HOME_PATH_FIELDS = ['scriptPath', 'stopScriptPath', 'workdir', 'log', 'configPath', 'cacheDir', 'plist'];

/** 允许把本机文件指到临时目录的 env；有任意一个就不走「未配置写保护」。 */
const LOCAL_PATH_ENV_KEYS = [
  'DSH_AU_LOCAL_DIR',
  'DSH_AU_LOCAL_BINDINGS_PATH',
  'DSH_AU_LOCAL_POINTER_PATH',
  'DSH_AU_LOCAL_STATE_PATH',
  'DSH_AU_MACHINES_DIR',
];

function hasLocalPathOverride() {
  return LOCAL_PATH_ENV_KEYS.some((key) => String(process.env[key] || '').trim());
}

/** 未配置私人仓库且无 env 覆盖时，禁止往插件自带 sync/ 写本机/私人文件。 */
function isPluginSyncWriteBlocked() {
  return !hasSyncRepo() && !hasLocalPathOverride();
}

function blockedWriteResult(extra = {}) {
  return { ok: false, reason: syncRepoUnavailableMessage(), ...extra };
}

function assertCanWriteLocalFiles() {
  if (isPluginSyncWriteBlocked()) throw new Error(syncRepoUnavailableMessage());
}

/** 环境变量可整体换掉本机目录（测试与多实例用），其余路径都由它推导。 */
function localDir() {
  if (process.env.DSH_AU_LOCAL_DIR) return path.resolve(process.env.DSH_AU_LOCAL_DIR);
  const override = process.env.DSH_AU_LOCAL_BINDINGS_PATH;
  if (override) return path.dirname(path.resolve(override));
  return path.join(resolveSyncDir(), 'local');
}

/** 云备份目录默认是 sync/machines（本机目录的同级），测试可用 env 单独指定。 */
function machinesDir() {
  if (process.env.DSH_AU_MACHINES_DIR) return path.resolve(process.env.DSH_AU_MACHINES_DIR);
  if (process.env.DSH_AU_LOCAL_DIR || process.env.DSH_AU_LOCAL_BINDINGS_PATH) {
    return path.join(localDir(), 'machines');
  }
  return path.join(resolveSyncDir(), 'machines');
}

const pointerPath = () => (process.env.DSH_AU_LOCAL_POINTER_PATH
  ? path.resolve(process.env.DSH_AU_LOCAL_POINTER_PATH)
  : path.join(localDir(), POINTER_NAME));
const statePath = () => (process.env.DSH_AU_LOCAL_STATE_PATH
  ? path.resolve(process.env.DSH_AU_LOCAL_STATE_PATH)
  : path.join(localDir(), STATE_NAME));
const legacyPath = () => (process.env.DSH_AU_LOCAL_BINDINGS_PATH
  || path.join(localDir(), LEGACY_NAME));

/**
 * 主机名 → 备份文件名。去掉 .local / .lan 这类后缀，
 * 避免同一台机器在不同网络下算出两个文件名。
 */
export function slugifyMachine(value = osHostname()) {
  const raw = String(value || '').trim().toLowerCase();
  const trimmed = raw.replace(/\.(local|lan|localdomain|home)$/u, '');
  const slug = trimmed.replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
  return slug || 'machine';
}

/** 一台电脑一份备份文件：machines/<machineId>.json。 */
export function machineFilePath(machineId) {
  return path.join(machinesDir(), `${machineId}.json`);
}

/** 读指针；损坏或缺失都当没有，交给后续回落逻辑。 */
export function readActivePointer() {
  const filePath = pointerPath();
  if (!existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    const machineId = typeof raw?.machineId === 'string' ? raw.machineId.trim() : '';
    return machineId ? { machineId, filePath, switchedAt: String(raw.switchedAt || '') } : null;
  } catch {
    return null;
  }
}

/** 写指针：只改这一个文件，不动任何备份内容。 */
export function writeActivePointer(machineId) {
  // 未配置私人仓库时绝不能在插件目录落下 active.json。
  assertCanWriteLocalFiles();
  const id = String(machineId || '').trim();
  if (!id) throw new Error('切换本机绑定缺少 machineId');
  const filePath = pointerPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = { schemaVersion: 1, machineId: id, switchedAt: new Date().toISOString() };
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { filePath, ...payload };
}

/** 递归拦截凭据字段，避免有人把令牌顺手写进本机绑定。 */
function assertNoSecrets(value, fieldPath = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${fieldPath}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_FIELD.test(key)) {
      throw new Error(`本机绑定不得包含凭据字段：${fieldPath}.${key}`);
    }
    assertNoSecrets(child, `${fieldPath}.${key}`);
  }
}

/**
 * 若路径位于私人仓库或插件目录内部，换算为仓库相对路径（统一使用 / 分隔符）；
 * 已经是仓库相对路径的直接归一分隔符；不在仓库内则返回空串。
 */
export function toRepoRelativePath(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  if (
    !raw.startsWith('/')
    && !raw.startsWith('\\')
    && !raw.startsWith('~')
    && !/^[A-Za-z]:[\\/]/.test(raw)
    && !raw.startsWith('%')
  ) {
    const normalized = raw.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
    if (normalized && !normalized.startsWith('..')) return normalized;
  }
  const slashNormalized = raw.replace(/\\/g, '/');
  const expanded = expandHome(raw);
  const resolved = path.resolve(expanded);
  const repoRoot = path.resolve(getRepoRoot());
  const isWin = process.platform === 'win32';
  const resolvedCmp = isWin ? resolved.toLowerCase() : resolved;
  const repoCmp = isWin ? repoRoot.toLowerCase() : repoRoot;
  if (resolvedCmp.startsWith(`${repoCmp}${path.sep}`)) {
    return resolved.slice(repoRoot.length + 1).replace(/\\/g, '/');
  }
  return '';
}

/**
 * 归一化本机绑定里的路径：
 * 1. 私人同步仓库或插件目录内的路径直接记录为仓库相对路径；
 * 2. 家目录下的仓库外路径写成 ~/，避免暴露用户名；
 * 3. 其它任意路径统一用 / 分隔符原样保留。
 */
export function toHomeRelative(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  const repoRelative = toRepoRelativePath(raw);
  if (repoRelative) return repoRelative;
  const home = homedir();
  if (home && (raw === home)) return '~';
  // 云备份统一用 /，避免 Windows 把可提交的 ~/ 路径写成平台专属的 ~\\。
  if (home && raw.startsWith(`${home}${path.sep}`)) return `~${raw.slice(home.length).replace(/\\/g, '/')}`;
  if (home) {
    const homeSlash = home.replace(/\\/g, '/');
    const rawSlash = raw.replace(/\\/g, '/');
    if (rawSlash.startsWith(`${homeSlash}/`)) return `~${rawSlash.slice(homeSlash.length)}`;
  }
  return raw;
}

/** ~/ 展开回绝对路径；其它写法原样返回，避免把仓库相对路径当成本机路径。 */
export function expandHome(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  if (raw === '~') return homedir();
  // 兼容旧版 Windows 已写入的 ~\\，新写入则始终使用跨平台的 ~/。
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(homedir(), raw.slice(2));
  return raw;
}

/**
 * 将本机绑定中的路径展开为当前机器可直接执行的绝对路径：
 * - 仓库内相对路径相对私人仓库根（或插件根）展开；
 * - ~/ 展开到当前用户家目录；
 * - 任意绝对路径（Windows 盘符路径或 POSIX / 路径）保持原样。
 */
export function expandLocalPath(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  const repoRoot = getRepoRoot();
  if (raw === '~') return homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    const repoRel = toRepoRelativePath(raw);
    if (repoRel && existsSync(path.join(repoRoot, repoRel))) {
      return path.join(repoRoot, repoRel);
    }
    return path.join(homedir(), raw.slice(2));
  }
  if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('/')) {
    return raw;
  }
  return path.resolve(repoRoot, raw);
}

/**
 * 把一条云服务定义换算成本机绑定条目（「接入本机」时用）。
 * 仓库内的路径直接保持仓库相对路径；
 * 仓库外路径在家目录下写成 ~/，其余保持绝对路径并统一使用 / 分隔符；
 * launcher.label 只在 macOS 上保留；分类不进绑定，控制策略保留为本机安全限制。
 */
export function cloudDefinitionToLocalBinding(definition, platform = process.platform) {
  const source = definition && typeof definition === 'object' ? definition : {};
  const toLocalPath = (value) => {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return '';
    const repoRelative = toRepoRelativePath(raw);
    if (repoRelative) return repoRelative;
    const absolute = path.isAbsolute(raw) || raw.startsWith('~') ? expandHome(raw) : path.resolve(getRepoRoot(), raw);
    // 统一用 /：绑定文件随仓库提交，不该带平台专属的反斜杠。
    return toHomeRelative(absolute).replace(/\\/g, '/');
  };
  const entry = {};
  if (Object.hasOwn(source, 'control')) entry.control = restrictServiceControl('full', source.control);
  if (typeof source.name === 'string' && source.name) entry.name = source.name;
  if (typeof source.description === 'string' && source.description) entry.description = source.description;
  const scriptPath = toLocalPath(source.scriptPath);
  if (scriptPath) entry.scriptPath = scriptPath;
  // 独立停止脚本与启动参数只传递声明过的类型，不把对象转成命令行文本。
  const stopScriptPath = toLocalPath(source.stopScriptPath);
  // 云端可能将外部停止路径留空；保留声明，避免接入后降级为杀端口进程。
  if (Object.hasOwn(source, 'stopScriptPath')) entry.stopScriptPath = stopScriptPath;
  for (const key of ['args', 'stopArgs']) {
    const args = normalizeControlArgs(source[key]);
    if (args) entry[key] = args;
  }
  if (Number.isSafeInteger(source.controlTimeoutMs) && source.controlTimeoutMs > 0) {
    entry.controlTimeoutMs = source.controlTimeoutMs;
  }
  const health = normalizeHealth(source.health);
  if (health) entry.health = health;
  if (Number.isInteger(source.port)) entry.port = source.port;
  const log = toLocalPath(source.log);
  if (log) entry.log = log;
  // doc 本来就是仓库相对路径，原样保留。
  if (typeof source.doc === 'string' && source.doc) entry.doc = source.doc;
  const label = typeof source.launcher?.label === 'string' ? source.launcher.label.trim() : '';
  if (label && platform === 'darwin') entry.launcher = { label };
  if (typeof source.controller === 'string' && source.controller.trim()) {
    entry.controller = source.controller.trim();
  }
  if (typeof source.platformController === 'string' && source.platformController.trim()) {
    entry.platformController = source.platformController.trim();
  }
  return entry;
}

/** 本机或云端控制策略只能收紧既有权限；未知策略默认只读，不能放宽共享依赖保护。 */
export function restrictServiceControl(current, requested) {
  const modes = ['view', 'start-only', 'full'];
  const currentLevel = modes.indexOf(current);
  const requestedLevel = modes.indexOf(requested);
  return currentLevel < 0 || requestedLevel < 0 ? 'view' : modes[Math.min(currentLevel, requestedLevel)];
}

/** 从一条服务里剥掉四个运行态开关，剩下的才是可提交的本机事实。 */
function stripRuntimeFlags(service) {
  if (!service || typeof service !== 'object') return {};
  const next = {};
  for (const [key, value] of Object.entries(service)) {
    if (RUNTIME_FLAGS.includes(key)) continue;
    if (HOME_PATH_FIELDS.includes(key) && typeof value === 'string') {
      next[key] = toHomeRelative(value);
      continue;
    }
    next[key] = value;
  }
  return next;
}

/**
 * 本机绑定文件解析顺序：
 * 1. 环境变量（测试与多实例隔离，最高优先级）
 * 2. 指针 active.json 指向的云备份
 * 3. 旧版 sync/local/manifest.local.json（迁移前）
 * 4. 本机主机名对应的云备份
 * 5. 该主机名将要写入的云备份路径（文件还没建）
 */
export function resolveLocalBindingsPath(targetHostname = osHostname()) {
  if (process.env.DSH_AU_LOCAL_BINDINGS_PATH) return process.env.DSH_AU_LOCAL_BINDINGS_PATH;

  const pointer = readActivePointer();
  if (pointer) {
    const filePath = machineFilePath(pointer.machineId);
    if (existsSync(filePath)) return filePath;
  }

  const legacy = legacyPath();
  if (existsSync(legacy)) return legacy;

  const hostFile = machineFilePath(slugifyMachine(targetHostname));
  if (existsSync(hostFile)) return hostFile;
  return hostFile;
}

/** 读一份云备份；不存在返回空表，不视为错误。 */
function readMachineFile(filePath) {
  if (!existsSync(filePath)) return { filePath, raw: null };
  try {
    return { filePath, raw: JSON.parse(readFileSync(filePath, 'utf8')) };
  } catch (err) {
    return { filePath, raw: null, error: err.message };
  }
}

/** 机器备份里的本机偏好字段：由 saveMachinePreferences 维护，其它写路径必须原样保留。 */
const PRESERVED_EXTRA_FIELDS = ['shortcutOverrides', 'modelShortcuts'];

/** 读已有备份里的偏好字段，避免保存收藏或插件名单时把它们抹掉。 */
function readPreservedFields(filePath) {
  const raw = readMachineFile(filePath).raw;
  if (!raw || typeof raw !== 'object') return {};
  const fields = {};
  for (const key of PRESERVED_EXTRA_FIELDS) {
    if (raw[key] && typeof raw[key] === 'object' && !Array.isArray(raw[key])) fields[key] = raw[key];
  }
  return fields;
}

/** 写一份云备份：剥掉运行态开关、路径缩成 ~/，再落盘。 */
function writeMachineFile(filePath, machine) {
  assertCanWriteLocalFiles();
  const services = {};
  for (const [id, service] of Object.entries(machine.services || {})) {
    services[id] = stripRuntimeFlags(service);
  }
  const pluginBundleOrder = normalizePlugins(machine.pluginBundleOrder);
  const payload = {
    ...readPreservedFields(filePath),
    schemaVersion: 2,
    machineId: machine.machineId,
    displayName: machine.displayName || machine.machineId,
    hostname: machine.hostname || '',
    platform: machine.platform || process.platform,
    updatedAt: new Date().toISOString(),
    menuFavorites: normalizeMenuFavorites(machine.menuFavorites),
    // 只记「这台电脑接过哪些云插件」，不记启用状态：插件是 npm 包，换机时照单重连而不是自动安装。
    plugins: normalizePlugins(machine.plugins),
    ...(pluginBundleOrder.length ? { pluginBundleOrder } : {}),
    // 本机偏好显式传入时覆盖旧值；没传就沿用 readPreservedFields 读到的内容。
    ...(machine.shortcutOverrides !== undefined ? { shortcutOverrides: machine.shortcutOverrides } : {}),
    ...(machine.modelShortcuts !== undefined ? { modelShortcuts: machine.modelShortcuts } : {}),
    services,
  };
  assertNoSecrets(payload);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { filePath, payload };
}

/** 读开关镜像；缺失返回空表，调用方自行回落到内联字段。 */
export function loadLocalBindingState(machineId = '') {
  const filePath = statePath();
  if (!existsSync(filePath)) return { filePath, services: {} };
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    const id = machineId || readActivePointer()?.machineId || '';
    const entry = raw?.machines?.[id];
    const services = entry?.services && typeof entry.services === 'object' ? entry.services : {};
    return { filePath, machineId: id, services };
  } catch (err) {
    return { filePath, services: {}, error: err.message };
  }
}

/** 把四个开关写进本地镜像：勾一次只改这个被忽略的文件，不脏 Git。 */
function writeLocalBindingStateFile(machineId, services) {
  assertCanWriteLocalFiles();
  const filePath = statePath();
  let raw = { schemaVersion: 1, machines: {} };
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object') raw = parsed;
    } catch { /* 坏文件直接重建，开关本就是可重建的镜像 */ }
  }
  raw.schemaVersion = 1;
  raw.machines = raw.machines && typeof raw.machines === 'object' ? raw.machines : {};
  raw.machines[machineId] = { updatedAt: new Date().toISOString(), services };
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  return { filePath, machineId, services };
}

let migrationChecked = false;

/**
 * 从服务表里挑出四个运行态开关。
 * 备份文件不带开关，迁移和保存时都得先把它们捞出来放进本地镜像。
 */
function extractRuntimeFlags(services) {
  const flags = {};
  for (const [id, service] of Object.entries(services || {})) {
    if (!service || typeof service !== 'object') continue;
    const entry = {};
    for (const key of RUNTIME_FLAGS) {
      if (typeof service[key] === 'boolean') entry[key] = service[key];
    }
    if (Object.keys(entry).length) flags[id] = entry;
  }
  return flags;
}

/**
 * 一次性迁移：把旧版固定文件名里的内容拆成「云备份 + 开关镜像 + 指针」。
 * 旧文件按约定保留为 manifest.local.json.bak，出问题能立刻对照。
 */
export function ensureLocalBindingMigrated(targetHostname = osHostname()) {
  // 未配置时连一次性迁移也不能写插件 sync/。
  if (isPluginSyncWriteBlocked()) return { migrated: false, reason: 'sync-repo-unavailable' };
  if (process.env.DSH_AU_LOCAL_BINDINGS_PATH) return { migrated: false, reason: 'env-override' };
  const pointer = readActivePointer();
  if (pointer && existsSync(machineFilePath(pointer.machineId))) {
    return { migrated: false, reason: 'pointer-ok', machineId: pointer.machineId };
  }
  const legacy = legacyPath();
  if (!existsSync(legacy)) return { migrated: false, reason: 'no-legacy' };

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(legacy, 'utf8'));
  } catch (err) {
    return { migrated: false, reason: 'legacy-broken', error: err.message };
  }

  const machineId = slugifyMachine(parsed?.hostname || targetHostname);
  const filePath = machineFilePath(machineId);
  const existing = readMachineFile(filePath).raw;
  const machine = {
    machineId,
    // 已有同名备份（从别的电脑拉下来）时不覆盖它，只把本机服务并进去。
    displayName: existing?.displayName || parsed?.displayName || String(parsed?.hostname || machineId),
    hostname: String(parsed?.hostname || targetHostname),
    platform: existing?.platform || String(parsed?.platform || process.platform),
    menuFavorites: Array.isArray(parsed?.menuFavorites) ? parsed.menuFavorites : existing?.menuFavorites,
    services: { ...(existing?.services || {}), ...(parsed?.services || {}) },
  };
  // 凭据红线同样管着迁移：旧文件里有 token 就整体不动，别把红线绕过去。
  try {
    writeMachineFile(filePath, machine);
  } catch (err) {
    return { migrated: false, reason: 'legacy-rejected', error: err.message };
  }

  // 四个开关从旧文件搬进本地镜像，备份保持干净。
  const flags = extractRuntimeFlags(parsed?.services);
  if (Object.keys(flags).length) writeLocalBindingStateFile(machineId, flags);

  writeActivePointer(machineId);
  try {
    renameSync(legacy, `${legacy}.bak`);
  } catch { /* 改名失败不影响新结构可用，旧文件留着也不碍事 */ }
  return { migrated: true, machineId, filePath };
}

/** 进程内只尝试一次迁移，读路径不该反复碰磁盘。 */
function migrateOnce(targetHostname) {
  if (migrationChecked) return null;
  migrationChecked = true;
  try {
    return ensureLocalBindingMigrated(targetHostname);
  } catch {
    return null;
  }
}

/**
 * 读取本机绑定。文件不存在时返回空表，不视为错误；
 * 解析失败或含凭据字段时返回 error，由调用方决定是降级还是提示。
 */
export function loadLocalBindings(targetHostname = osHostname(), options = {}) {
  // 未配置且无 env 覆盖：不迁移、不读插件 sync/，给调用方一个空表。
  if (isPluginSyncWriteBlocked()) {
    return {
      filePath: '',
      machineId: slugifyMachine(targetHostname),
      services: {},
      plugins: [],
      pluginBundleOrder: [],
      flags: {},
      exists: false,
      unconfigured: true,
    };
  }
  // 体检只读原始事实；正常插件加载仍保留原有一次性迁移行为。
  if (options.migrate !== false) migrateOnce(targetHostname);
  const filePath = resolveLocalBindingsPath(targetHostname);
  const machineId = readActivePointer()?.machineId || slugifyMachine(targetHostname);
  if (!existsSync(filePath)) return { filePath, machineId, services: {}, plugins: [], pluginBundleOrder: [], flags: {}, exists: false };
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    assertNoSecrets(raw);
    const services = raw?.services && typeof raw.services === 'object' ? raw.services : {};
    return {
      filePath,
      machineId,
      services,
      plugins: normalizePlugins(raw?.plugins),
      pluginBundleOrder: normalizePlugins(raw?.pluginBundleOrder),
      // 开关优先取本地镜像；旧文件里内联的开关作为回落，老数据不会突然丢状态。
      flags: loadLocalBindingState(machineId).services,
      displayName: String(raw?.displayName || ''),
      hostname: raw?.hostname || '',
      exists: true,
    };
  } catch (err) {
    return { filePath, machineId, services: {}, plugins: [], pluginBundleOrder: [], flags: {}, exists: true, error: err.message };
  }
}

/** 收藏项一律是两位菜单序号；归一化时顺手去重，脏数据直接丢弃。 */
export function normalizeMenuFavorites(favorites) {
  if (!Array.isArray(favorites)) return [];
  return [...new Set(favorites.filter((code) => typeof code === 'string' && /^\d{2}$/.test(code)))];
}

/** 插件名单只记包名/id 字符串：去空、去重，保持写入顺序。 */
export function normalizePlugins(plugins) {
  if (!Array.isArray(plugins)) return [];
  return [...new Set(plugins
    .filter((id) => typeof id === 'string')
    .map((id) => id.trim())
    .filter(Boolean))];
}

/**
 * 读取本机常用收藏。字段缺失时返回 favorites: null，由调用方回落到旧配置文件；
 * 文件不存在不算错误——换电脑后本来就没有绑定。
 */
export function loadMenuFavorites(targetHostname = osHostname()) {
  if (isPluginSyncWriteBlocked()) return { filePath: '', favorites: null, exists: false, unconfigured: true };
  migrateOnce(targetHostname);
  const filePath = resolveLocalBindingsPath(targetHostname);
  if (!existsSync(filePath)) return { filePath, favorites: null, exists: false };
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    assertNoSecrets(raw);
    if (!Array.isArray(raw?.menuFavorites)) return { filePath, favorites: null, exists: true };
    return { filePath, favorites: normalizeMenuFavorites(raw.menuFavorites), exists: true };
  } catch (err) {
    return { filePath, favorites: null, exists: true, error: err.message };
  }
}

/**
 * 把常用收藏写进当前云备份：一机一份，收藏不再跨电脑共享。
 * 文件不存在时按最小骨架新建，只写收藏，不伪造任何服务绑定。
 */
export function saveMenuFavorites(favorites, targetHostname = osHostname(), options = {}) {
  if (isPluginSyncWriteBlocked()) return blockedWriteResult();
  migrateOnce(targetHostname);
  const filePath = resolveLocalBindingsPath(targetHostname);
  const normalized = normalizeMenuFavorites(favorites);
  try {
    const existing = existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : null;
    const machineId = existing?.machineId || readActivePointer()?.machineId || slugifyMachine(targetHostname);
    // 旧文件里内联的开关先搬进本地镜像，再写不带开关的备份，避免这次保存把状态丢掉。
    const inlineFlags = extractRuntimeFlags(existing?.services);
    if (Object.keys(inlineFlags).length) {
      const previous = loadLocalBindingState(machineId).services;
      writeLocalBindingStateFile(machineId, { ...previous, ...inlineFlags });
    }
    const { payload } = writeMachineFile(filePath, {
      machineId,
      displayName: existing?.displayName,
      hostname: existing?.hostname || targetHostname,
      platform: existing?.platform,
      menuFavorites: normalized,
      // 调用方给了插件名单就用新的，没给就保留原样，别把已有记录抹掉。
      plugins: options.plugins === undefined ? existing?.plugins : options.plugins,
      pluginBundleOrder: options.pluginBundleOrder === undefined ? existing?.pluginBundleOrder : options.pluginBundleOrder,
      // 写备份时必须带上原有服务，否则一次收藏保存就把服务绑定清空。
      services: existing?.services || {},
    });
    assertNoSecrets(payload);
    return { ok: true, filePath, favorites: normalized, plugins: payload.plugins };
  } catch (err) {
    return { ok: false, filePath, reason: err.message };
  }
}

/**
 * 刷新当前云备份里的插件名单与加载顺序：默认备份不存在就什么都不做；
 * 若显式传入 createIfMissing: true（如用户点击「一键备份本机全部插件」），则按最小骨架新建本机备份。
 */
export function updateMachinePlugins(pluginIds, targetHostname = osHostname(), options = {}) {
  if (isPluginSyncWriteBlocked()) return blockedWriteResult();
  migrateOnce(targetHostname);
  const filePath = resolveLocalBindingsPath(targetHostname);
  const exists = existsSync(filePath);
  if (!exists && options.createIfMissing !== true) return { ok: true, skipped: true, filePath };
  try {
    const existing = exists ? JSON.parse(readFileSync(filePath, 'utf8')) : null;
    const machineId = existing?.machineId || readActivePointer()?.machineId || slugifyMachine(targetHostname);
    const plugins = normalizePlugins(pluginIds);
    const previous = normalizePlugins(existing?.plugins);
    const nextBundleOrder = options.bundleOrder === undefined
      ? normalizePlugins(existing?.pluginBundleOrder)
      : normalizePlugins(options.bundleOrder);
    const previousBundleOrder = normalizePlugins(existing?.pluginBundleOrder);
    const samePlugins = exists
      && previous.length === plugins.length
      && previous.every((id, i) => id === plugins[i]);
    const sameOrder = exists
      && previousBundleOrder.length === nextBundleOrder.length
      && previousBundleOrder.every((pkg, i) => pkg === nextBundleOrder[i]);
    if (samePlugins && sameOrder) {
      return { ok: true, changed: false, filePath, plugins, pluginBundleOrder: nextBundleOrder };
    }
    const { payload } = writeMachineFile(filePath, {
      ...(existing || {}),
      machineId,
      displayName: existing?.displayName || String(targetHostname || machineId),
      hostname: existing?.hostname || String(targetHostname || ''),
      platform: existing?.platform || process.platform,
      plugins,
      pluginBundleOrder: nextBundleOrder,
      services: existing?.services || {},
    });
    return {
      ok: true,
      changed: true,
      filePath,
      plugins: payload.plugins,
      pluginBundleOrder: payload.pluginBundleOrder || [],
    };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/** 参数只保留非空字符串，保留原始空格以免改变命令行语义。 */
function normalizeControlArgs(value) {
  if (!Array.isArray(value)) return null;
  return value.filter((arg) => typeof arg === 'string' && arg.trim());
}

/** 健康地址允许写字符串或数组：统一成「字符串」或「非空字符串数组」，空值一律返回空串。 */
function normalizeHealth(health) {
  if (Array.isArray(health)) {
    const list = health
      .filter((url) => typeof url === 'string' && url.trim())
      .map((url) => url.trim());
    return list.length ? list : '';
  }
  return typeof health === 'string' && health.trim() ? health.trim() : '';
}

/** 从健康地址里取端口，省得再单独维护一份 port 字段；数组取第一个能解析出端口的。 */
function portFromHealth(health) {
  const list = Array.isArray(health) ? health : [health];
  for (const url of list) {
    if (typeof url !== 'string' || !url) continue;
    try {
      const parsed = new URL(url);
      if (parsed.port) return Number(parsed.port);
      return parsed.protocol === 'https:' ? 443 : 80;
    } catch { /* 这条地址写坏了就继续看下一条 */ }
  }
  return null;
}

/** launchd 的 plist 位置由标签推导，标签以外的路径不单独存。 */
function plistFromLabel(label) {
  if (!label) return '';
  return path.join(process.env.HOME || '', 'Library', 'LaunchAgents', `${label}.plist`);
}

/** 仓库内路径缩成仓库相对路径，家目录下的路径缩成 ~/ 开头，面板显示更短且不暴露用户名。 */
function shortHomePath(targetPath) {
  const repoRelative = toRepoRelativePath(targetPath);
  if (repoRelative) return repoRelative;
  const home = homedir();
  if (home && targetPath.startsWith(`${home}${path.sep}`)) {
    // 面板与云备份都展示统一的 ~/ 形式，不能泄露 Windows 的路径分隔符。
    return `~${targetPath.slice(home.length).replace(/\\/g, '/')}`;
  }
  return targetPath;
}

/**
 * 把本机绑定合并到目录条目上。绑定只存「不能推导」的事实：
 * 脚本路径、健康地址、日志位置、launchd 标签、中文描述和四个状态位。
 * 脚本名、工作目录、端口、plist 路径都由这些字段推导，避免同一信息写两遍。
 * 备份里的路径支持仓库内相对路径、~/ 缩写或任意绝对路径，这里展开成绝对路径再交给执行层。
 */
export function applyLocalBinding(entry, services = loadLocalBindings().services, flags = loadLocalBindingState().services) {
  if (!entry) return entry;
  const bound = services?.[entry.id];
  if (!bound || typeof bound !== 'object') return entry;
  const rawScriptPath = typeof bound.scriptPath === 'string' ? bound.scriptPath.trim() : '';
  const scriptPath = expandLocalPath(rawScriptPath);
  const stopScriptPath = expandLocalPath(bound.stopScriptPath);
  const args = normalizeControlArgs(bound.args);
  const stopArgs = normalizeControlArgs(bound.stopArgs);
  const health = normalizeHealth(bound.health);
  const label = typeof bound.launcher?.label === 'string' ? bound.launcher.label : '';
  const log = expandLocalPath(typeof bound.log === 'string' ? bound.log : '');
  const configPath = expandLocalPath(typeof bound.configPath === 'string' ? bound.configPath : '');
  const cacheDir = expandLocalPath(typeof bound.cacheDir === 'string' ? bound.cacheDir : '');
  const derivedPort = portFromHealth(health);
  // 开关以本地镜像为准；镜像还没这一条时回落到旧文件里内联的字段。
  const state = flags?.[entry.id] || {};
  const flag = (key) => (typeof state[key] === 'boolean' ? state[key] : bound[key] === true);
  return {
    ...entry,
    ...(Object.hasOwn(bound, 'control') ? {
      control: restrictServiceControl(entry.control || (scriptPath || label ? 'full' : 'view'), bound.control),
    } : {}),
    ...(typeof bound.name === 'string' && bound.name ? { name: bound.name } : {}),
    ...(scriptPath ? {
      scriptPath,
      scriptName: path.basename(scriptPath),
      workdir: path.dirname(scriptPath),
      // 面板里显示 ~ 缩写版，路径短一截也不暴露用户名；实际执行仍用绝对路径。
      scriptPathShort: shortHomePath(scriptPath),
    } : {}),
    // 停止入口不参与 cwd 推导；仍以启动脚本所在目录为准。
    ...(Object.hasOwn(bound, 'stopScriptPath') ? { stopScriptPath } : {}),
    ...(args ? { args } : {}),
    ...(stopArgs ? { stopArgs } : {}),
    ...(Number.isSafeInteger(bound.controlTimeoutMs) && bound.controlTimeoutMs > 0
      ? { controlTimeoutMs: bound.controlTimeoutMs } : {}),
    ...(health ? { health } : {}),
    ...(derivedPort ? { port: derivedPort } : {}),
    ...(log ? { log } : {}),
    // 配置文件与缓存目录是不同用途的本机事实，不能互相替代。
    ...(configPath ? { configPath } : {}),
    ...(cacheDir ? { cacheDir } : {}),
    ...(typeof bound.description === 'string' && bound.description ? { description: bound.description } : {}),
    // 接入文档路径：非必填，换电脑时照着它做初始化。仓库相对路径，不展开。
    ...(typeof bound.doc === 'string' && bound.doc ? { doc: bound.doc } : {}),
    // 盘符探活只属于本机事实，例如 Q: / N:，不从开源内建目录猜。
    ...(typeof bound.drive === 'string' && bound.drive.trim() ? { drive: bound.drive.trim() } : {}),
    // 无端口常驻进程（如 socat 转发）按命令行特征探活；特征属于本机部署事实，只从绑定读取。
    ...(typeof bound.processPattern === 'string' && bound.processPattern.trim()
      ? { processPattern: bound.processPattern.trim() } : {}),
    ...(typeof bound.controller === 'string' && bound.controller.trim()
      ? { controller: bound.controller.trim() } : {}),
    ...(typeof bound.platformController === 'string' && bound.platformController.trim()
      ? { platformController: bound.platformController.trim() } : {}),
    ...(label ? { launchd: { label, plist: plistFromLabel(label) } } : {}),
    localState: {
      enabled: flag('enabled'),
      autoStartOnBoot: flag('autoStartOnBoot'),
      autoStartOnDsh: flag('autoStartOnDsh'),
      cloud: flag('cloud'),
    },
  };
}

/**
 * 写入当前电脑的服务开关：state.json 是本机开关的唯一来源。
 * 只写绑定 JSON 里登记的服务；回调返回 null 表示该服务保持原状态。
 * 写进 state.json 而不是备份文件：开关点一次变一次，绝不能弄脏随仓库提交的备份。
 */
export function writeLocalBindingState(targetHostname, stateForService) {
  if (isPluginSyncWriteBlocked()) return blockedWriteResult();
  const machineId = readActivePointer()?.machineId || slugifyMachine(targetHostname);
  const filePath = resolveLocalBindingsPath(targetHostname);
  if (!existsSync(filePath)) return { ok: false, reason: '本机绑定文件不存在' };
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    const services = raw?.services && typeof raw.services === 'object' ? raw.services : {};
    const previous = loadLocalBindingState(machineId).services;
    const next = { ...previous };
    let changed = false;
    for (const serviceId of Object.keys(services)) {
      const nextState = stateForService(serviceId);
      if (!nextState) continue;
      const entry = { ...(next[serviceId] || {}) };
      for (const key of RUNTIME_FLAGS) {
        if (typeof nextState[key] === 'boolean' && entry[key] !== nextState[key]) {
          entry[key] = nextState[key];
          changed = true;
        }
      }
      next[serviceId] = entry;
    }
    if (!changed) return { ok: true, changed: false, ...loadLocalBindingState(machineId) };
    const written = writeLocalBindingStateFile(machineId, next);
    return { ok: true, changed: true, ...written };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * 列出所有云备份：换机时看得到「这台电脑的绑定」，也看得到「别的电脑的备份」。
 * 只读目录，不改任何文件；当前使用中的那份单独标出来。
 */
export function listMachineBindings(targetHostname = osHostname()) {
  if (isPluginSyncWriteBlocked()) {
    return {
      dir: '',
      activeId: '',
      currentHostId: slugifyMachine(targetHostname),
      items: [],
      unconfigured: true,
    };
  }
  const dir = machinesDir();
  const activeId = readActivePointer()?.machineId || '';
  const currentHostId = slugifyMachine(targetHostname);
  const items = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      const filePath = path.join(dir, name);
      let raw = null;
      try {
        raw = JSON.parse(readFileSync(filePath, 'utf8'));
      } catch { /* 坏文件也列出来，让用户看得见问题 */ }
      items.push({
        machineId: id,
        filePath,
        displayName: String(raw?.displayName || ''),
        hostname: String(raw?.hostname || ''),
        platform: String(raw?.platform || ''),
        updatedAt: String(raw?.updatedAt || ''),
        serviceCount: raw?.services && typeof raw.services === 'object' ? Object.keys(raw.services).length : 0,
        favoriteCount: Array.isArray(raw?.menuFavorites) ? raw.menuFavorites.length : 0,
        plugins: normalizePlugins(raw?.plugins),
        pluginBundleOrder: normalizePlugins(raw?.pluginBundleOrder),
        pluginCount: normalizePlugins(raw?.plugins).length,
        broken: !raw,
        active: id === activeId,
        currentHost: id === currentHostId,
      });
    }
  }
  items.sort((a, b) => Number(b.active) - Number(a.active) || Number(b.currentHost) - Number(a.currentHost) || a.machineId.localeCompare(b.machineId));
  return { dir, activeId, currentHostId, items };
}

/**
 * 将一条云服务定义接入当前本机绑定，或移除已接入条目。
 * 服务“是否接入本机”只由 machines/<machineId>.json 的 services 键决定。
 */
export function setLocalBindingService(serviceId, definition = null, targetHostname = osHostname()) {
  if (isPluginSyncWriteBlocked()) return blockedWriteResult();
  migrateOnce(targetHostname);
  const id = String(serviceId || '').trim();
  const filePath = resolveLocalBindingsPath(targetHostname);
  if (!id) return { ok: false, reason: '本机服务缺少 id', filePath };
  if (!existsSync(filePath)) return { ok: false, reason: '本机绑定文件不存在，请先保存本机绑定', filePath };
  try {
    const existing = JSON.parse(readFileSync(filePath, 'utf8'));
    const services = { ...(existing?.services || {}) };
    if (definition && typeof definition === 'object') services[id] = { ...definition };
    else delete services[id];
    const { payload } = writeMachineFile(filePath, { ...existing, services });
    return { ok: true, filePath, connected: Boolean(payload.services[id]), services: payload.services };
  } catch (err) {
    return { ok: false, reason: err.message, filePath };
  }
}

/**
 * 切换当前使用的云备份：只改指针，不动任何备份内容。
 * 切到别的电脑的备份时，那些路径在本机大概率不存在，面板会显示「未安装」，属于预期。
 */
export function switchActiveBinding(machineId) {
  if (isPluginSyncWriteBlocked()) return blockedWriteResult();
  const id = String(machineId || '').trim();
  if (!id) return { ok: false, reason: '切换备份缺少 machineId' };
  const filePath = machineFilePath(id);
  if (!existsSync(filePath)) return { ok: false, reason: `云备份不存在：${path.basename(filePath)}` };
  try {
    const written = writeActivePointer(id);
    return { ok: true, machineId: id, filePath, switchedAt: written.switchedAt };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * 读取当前机器备份里的本机偏好：设备/页面切换快捷键与模型快捷槽位。
 * 字段缺失返回 null，由调用方决定回落还是保持本机现状。
 */
export function loadMachinePreferences(targetHostname = osHostname()) {
  if (isPluginSyncWriteBlocked()) {
    return {
      filePath: '',
      machineId: slugifyMachine(targetHostname),
      exists: false,
      shortcutOverrides: null,
      modelShortcuts: null,
      updatedAt: '',
      unconfigured: true,
    };
  }
  migrateOnce(targetHostname);
  const filePath = resolveLocalBindingsPath(targetHostname);
  const fallbackId = readActivePointer()?.machineId || slugifyMachine(targetHostname);
  if (!existsSync(filePath)) {
    return { filePath, machineId: fallbackId, exists: false, shortcutOverrides: null, modelShortcuts: null, updatedAt: '' };
  }
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    assertNoSecrets(raw);
    return {
      filePath,
      machineId: typeof raw?.machineId === 'string' && raw.machineId ? raw.machineId : fallbackId,
      exists: true,
      shortcutOverrides: raw?.shortcutOverrides && typeof raw.shortcutOverrides === 'object' && !Array.isArray(raw.shortcutOverrides)
        ? raw.shortcutOverrides : null,
      modelShortcuts: raw?.modelShortcuts && typeof raw.modelShortcuts === 'object' && !Array.isArray(raw.modelShortcuts)
        ? raw.modelShortcuts : null,
      updatedAt: String(raw?.updatedAt || ''),
    };
  } catch (err) {
    return { filePath, machineId: fallbackId, exists: true, shortcutOverrides: null, modelShortcuts: null, updatedAt: '', error: err.message };
  }
}

/**
 * 保存当前机器备份里的本机偏好。
 * 只更新显式传入的字段：传 null 表示清空该字段，未传则保持原值。
 */
export function saveMachinePreferences(patch = {}, targetHostname = osHostname()) {
  if (isPluginSyncWriteBlocked()) return blockedWriteResult();
  migrateOnce(targetHostname);
  const filePath = resolveLocalBindingsPath(targetHostname);
  let existing = null;
  try {
    existing = existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : null;
  } catch (err) {
    return { ok: false, filePath, reason: err.message };
  }
  const machineId = existing?.machineId || readActivePointer()?.machineId || slugifyMachine(targetHostname);
  const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const next = {
    ...(existing || {}),
    machineId,
    displayName: existing?.displayName || String(targetHostname || machineId),
    hostname: existing?.hostname || String(targetHostname || ''),
    platform: existing?.platform || process.platform,
    menuFavorites: existing?.menuFavorites,
    plugins: existing?.plugins,
    pluginBundleOrder: existing?.pluginBundleOrder,
    services: existing?.services || {},
  };
  if (Object.hasOwn(patch, 'shortcutOverrides')) {
    next.shortcutOverrides = isPlainObject(patch.shortcutOverrides) ? patch.shortcutOverrides : {};
  }
  if (Object.hasOwn(patch, 'modelShortcuts')) {
    // 槽位配置是完整对象；传 null 时显式留空，读取方会回落到默认值。
    next.modelShortcuts = isPlainObject(patch.modelShortcuts) ? patch.modelShortcuts : null;
  }
  try {
    const { payload } = writeMachineFile(filePath, next);
    return { ok: true, filePath, machineId, payload };
  } catch (err) {
    return { ok: false, filePath, reason: err.message };
  }
}

/**
 * 找云端最近更新、且含本机偏好的一份机器备份。
 * 新电脑第一次同步时用它作为初值；本机那份永远排除，避免自己抄自己。
 * 两个字段分别取各自最近的来源，互不牵连。
 */
export function findLatestMachinePreferences(targetHostname = osHostname(), options = {}) {
  const dir = machinesDir();
  const currentId = options.excludeMachineId
    || readActivePointer()?.machineId
    || slugifyMachine(targetHostname);
  if (!existsSync(dir)) return null;
  const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  let latestShortcuts = null;
  let latestModels = null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (!id || id === currentId) continue;
    let raw;
    try {
      raw = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
    } catch { /* 坏文件跳过，继续找下一份 */ continue; }
    const updatedAt = String(raw?.updatedAt || '');
    if (isPlainObject(raw?.shortcutOverrides) && (!latestShortcuts || updatedAt > latestShortcuts.updatedAt)) {
      latestShortcuts = { machineId: id, updatedAt, value: raw.shortcutOverrides };
    }
    if (isPlainObject(raw?.modelShortcuts) && (!latestModels || updatedAt > latestModels.updatedAt)) {
      latestModels = { machineId: id, updatedAt, value: raw.modelShortcuts };
    }
  }
  if (!latestShortcuts && !latestModels) return null;
  return {
    shortcutOverrides: latestShortcuts?.value || null,
    shortcutSource: latestShortcuts?.machineId || '',
    modelShortcuts: latestModels?.value || null,
    modelSource: latestModels?.machineId || '',
  };
}
