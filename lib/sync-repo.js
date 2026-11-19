import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));

/** dsh-au 插件自身根目录。禁止再用 `../..` 去猜上层私人仓库。 */
export const PLUGIN_ROOT = path.resolve(LIB_DIR, '..');

const UNCONFIGURED_SYNC_REPO = '未配置私人同步仓库 (syncRepoRoot)';

function expandHome(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw === '~') return homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(homedir(), raw.slice(2));
  return raw;
}

function samePath(a, b) {
  if (!a || !b) return false;
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** 只读本机配置文件里的 syncRepoRoot，避免和 config-store 循环依赖。 */
function readUserSyncRepoRoot() {
  try {
    const dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh');
    const cfgPath = process.env.DSH_AU_CONFIG_PATH || path.join(dshHome, 'dsh-au.config.json');
    if (!existsSync(cfgPath)) return '';
    // 本机配置可能带 UTF-8 BOM（Windows 编辑器常见），先剥掉再解析。
    const raw = JSON.parse(readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
    return typeof raw?.syncRepoRoot === 'string' ? raw.syncRepoRoot.trim() : '';
  } catch {
    return '';
  }
}

/**
 * 私人同步仓库根。未配置时返回 null，调用方必须降级。
 * 顺序：options.repoRoot / options.syncRepoRoot → env DSH_AU_SYNC_REPO → ~/.dsh/dsh-au.config.json
 */
export function resolveSyncRepoRoot(options = {}) {
  const fromOptions = typeof options.repoRoot === 'string' && options.repoRoot.trim()
    ? options.repoRoot.trim()
    : (typeof options.syncRepoRoot === 'string' && options.syncRepoRoot.trim() ? options.syncRepoRoot.trim() : '');
  const raw = fromOptions || String(process.env.DSH_AU_SYNC_REPO || '').trim() || readUserSyncRepoRoot();
  if (!raw) return null;
  const resolved = path.resolve(expandHome(raw));
  // 插件根不是私人仓库；调用方把 PLUGIN_ROOT 当默认 repoRoot 时仍视为未配置。
  if (samePath(resolved, PLUGIN_ROOT)) return null;
  return resolved;
}

/**
 * 私人仓库内的 sync 目录：优先 `<root>/dsh-sync`，否则 `<root>/dsh-au/sync`。
 * 两者都不存在时，若已有 `dsh-au` 目录则回退旧布局，否则用未来的 `dsh-sync`。
 */
export function resolveSyncDirForRoot(syncRepoRoot) {
  if (!syncRepoRoot) return null;
  const root = path.resolve(syncRepoRoot);
  const preferred = path.join(root, 'dsh-sync');
  if (existsSync(preferred)) return preferred;
  const legacy = path.join(root, 'dsh-au', 'sync');
  if (existsSync(legacy)) return legacy;
  if (existsSync(path.join(root, 'dsh-au'))) return legacy;
  return preferred;
}

/** 开源默认：插件自带 sync/；私人仓库存在时改走仓库内 sync 目录。 */
export function resolveSyncDir(options = {}) {
  const root = resolveSyncRepoRoot(options);
  if (root) return resolveSyncDirForRoot(root);
  return path.join(PLUGIN_ROOT, 'sync');
}

/**
 * 路径换算用的“仓库根”：配置了私人仓库就用它，否则用插件根。
 * 不再猜测插件的上一级目录。
 */
export function getRepoRoot(options = {}) {
  return resolveSyncRepoRoot(options) || PLUGIN_ROOT;
}

/** 旧 import 名保留为插件根，避免再把上层目录当成仓库。 */
export const REPO_ROOT = PLUGIN_ROOT;

export function isPluginRoot(dir) {
  return samePath(dir, PLUGIN_ROOT);
}

/** 插件快照目录：私人仓库走 dsh-sync/plugins 或 dsh-au/sync/plugins，否则用插件自带 sync/plugins。 */
export function resolvePluginBundlesDir(repoRoot) {
  const explicit = typeof repoRoot === 'string' && repoRoot.trim() ? path.resolve(repoRoot) : resolveSyncRepoRoot();
  if (!explicit || isPluginRoot(explicit)) return path.join(PLUGIN_ROOT, 'sync', 'plugins');
  return path.join(resolveSyncDirForRoot(explicit), 'plugins');
}

export function syncRepoUnavailableMessage() {
  return UNCONFIGURED_SYNC_REPO;
}

export function hasSyncRepo(options = {}) {
  return Boolean(resolveSyncRepoRoot(options));
}
