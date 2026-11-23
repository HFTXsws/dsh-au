import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveSyncDir, resolveSyncRepoRoot } from './sync-repo.js';

const VALID_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const VALID_SURFACES = new Set(['workbench', 'sidebar']);
const moduleCache = new Map();

/**
 * 归一化扩展挂载表面列表（默认仅挂载到工作台弹窗 ['workbench']，保持旧扩展零改动兼容；
 * 若声明 surfaces: ['sidebar'] 或 sidebar: true，则挂载到左侧栏工作区树与主舞台）。
 */
export function normalizeExtensionSurfaces(raw) {
  if (Array.isArray(raw?.surfaces)) {
    const clean = [...new Set(
      raw.surfaces
        .map((item) => String(item || '').trim().toLowerCase())
        .filter((item) => VALID_SURFACES.has(item)),
    )];
    if (clean.length > 0) return clean;
  }
  if (raw?.sidebar === true || (raw?.sidebar && typeof raw.sidebar === 'object')) {
    return raw?.workbench === true ? ['sidebar', 'workbench'] : ['sidebar'];
  }
  return ['workbench'];
}

function inspectExtFileRef(extDir, relPath, defaultName) {
  const raw = typeof relPath === 'string' && relPath.trim() ? relPath.trim() : defaultName;
  const full = path.resolve(extDir, raw);
  const rel = path.relative(extDir, full);
  const escaped = !rel || rel.startsWith('..') || path.isAbsolute(rel);
  return {
    raw,
    explicit: typeof relPath === 'string' && Boolean(relPath.trim()),
    escaped,
    full: escaped ? null : full,
    exists: !escaped && existsSync(full),
  };
}

function resolveSafeExtFile(extDir, relPath) {
  if (typeof relPath !== 'string' || !relPath.trim()) return null;
  const full = path.resolve(extDir, relPath.trim());
  const rel = path.relative(extDir, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return existsSync(full) ? full : null;
}

function readExtManifest(extDir) {
  const manifestPath = path.join(extDir, 'extension.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^﻿/, ''));
    const id = String(raw?.id || '').trim();
    const title = String(raw?.title || '').trim();
    if (!VALID_ID_RE.test(id) || !title) return null;
    const clientPath = resolveSafeExtFile(extDir, raw.clientFile || 'client.js');
    const stylePath = resolveSafeExtFile(extDir, raw.styleFile || 'styles.css');
    const serverPath = resolveSafeExtFile(extDir, raw.serverFile || 'server.js');
    return {
      id,
      title,
      order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : 100,
      iconSvg: typeof raw.iconSvg === 'string' ? raw.iconSvg : '',
      surfaces: normalizeExtensionSurfaces(raw),
      extDir,
      clientPath,
      stylePath,
      serverPath,
    };
  } catch {
    return null;
  }
}

export function loadPrivateExtensionDescriptors(pathOpts = {}) {
  const syncDir = resolveSyncDir(pathOpts);
  if (!syncDir) return [];
  const extRoot = path.join(syncDir, 'extensions');
  if (!existsSync(extRoot)) return [];

  const entries = [];
  for (const dirent of readdirSync(extRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue;
    const desc = readExtManifest(path.join(extRoot, dirent.name));
    if (desc) entries.push(desc);
  }
  entries.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return entries;
}

/**
 * 供前端工作台消费的扩展清单（含静态样式与客户端模块文本）。
 * 未配置 syncRepoRoot 时直接返回空数组，保证出厂版本零私人逻辑。
 */
export function listPrivateExtensionsForClient(pathOpts = {}) {
  return loadPrivateExtensionDescriptors(pathOpts).map((item) => ({
    id: item.id,
    title: item.title,
    order: item.order,
    iconSvg: item.iconSvg,
    surfaces: item.surfaces,
    styleText: item.stylePath ? readFileSync(item.stylePath, 'utf8') : '',
    clientScript: item.clientPath ? readFileSync(item.clientPath, 'utf8') : '',
  }));
}

export async function invokePrivateExtensionAction(extId, subAction, body = {}, ctx = {}, pathOpts = {}) {
  const id = String(extId || '').trim();
  const action = String(subAction || '').trim();
  if (!VALID_ID_RE.test(id) || !action) {
    return { ok: false, error: '无效的扩展调用参数' };
  }
  const desc = loadPrivateExtensionDescriptors(pathOpts).find((item) => item.id === id);
  if (!desc || !desc.serverPath) {
    return { ok: false, error: `扩展未就绪或未提供服务端处理器: ${id}` };
  }

  const mtimeMs = statSync(desc.serverPath).mtimeMs;
  const cached = moduleCache.get(desc.serverPath);
  let mod = cached && cached.mtimeMs === mtimeMs ? cached.mod : null;
  if (!mod) {
    const url = `${pathToFileURL(desc.serverPath).href}?v=${Math.floor(mtimeMs)}`;
    mod = await import(url);
    moduleCache.set(desc.serverPath, { mtimeMs, mod });
  }
  if (typeof mod?.handleAction !== 'function') {
    return { ok: false, error: `扩展 ${id} 未导出 handleAction` };
  }
  const syncRepoRoot = resolveSyncRepoRoot(pathOpts);
  return mod.handleAction({
    action,
    body,
    ctx: { ...ctx, syncRepoRoot, extDir: desc.extDir },
  });
}

const FAKE_REACT_SHIM = {
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
};

/**
 * 只读体检当前私人同步仓库中的工作台扩展（<syncDir>/extensions/*）。
 * 校验清单、路径穿越、client.js 语法与工厂返回值、server.js handleAction 导出及 ID 冲突。
 */
export async function runPrivateExtensionsDoctor(opts = {}) {
  const pathOpts = opts.syncRepoRoot ? { syncRepoRoot: opts.syncRepoRoot } : {};
  const syncRepoRoot = resolveSyncRepoRoot(pathOpts);
  const syncDir = resolveSyncDir(pathOpts);
  const filterId = String(opts.extId || '').trim();

  if (!syncDir) {
    return {
      ok: !filterId,
      status: 'unconfigured',
      syncRepoRoot: syncRepoRoot || null,
      extensionsDir: null,
      extensions: [],
      issues: filterId ? [`未配置私人同步仓库（syncRepoRoot），无法找到扩展: ${filterId}`] : [],
      summary: { total: 0, okCount: 0, warnCount: 0, failCount: filterId ? 1 : 0 },
    };
  }

  const extRoot = path.join(syncDir, 'extensions');
  if (!existsSync(extRoot)) {
    return {
      ok: !filterId,
      status: 'empty',
      syncRepoRoot,
      extensionsDir: extRoot,
      extensions: [],
      issues: filterId ? [`扩展目录尚未创建（${extRoot}），未找到扩展: ${filterId}`] : [],
      summary: { total: 0, okCount: 0, warnCount: 0, failCount: filterId ? 1 : 0 },
    };
  }

  const extensions = [];
  const seenIds = new Map();

  for (const dirent of readdirSync(extRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue;
    const extDir = path.join(extRoot, dirent.name);
    const manifestPath = path.join(extDir, 'extension.json');
    const issues = [];
    const warnings = [];

    if (!existsSync(manifestPath)) {
      extensions.push({
        folder: dirent.name,
        id: '',
        title: '',
        order: 100,
        status: 'fail',
        files: { manifest: false, client: false, style: false, server: false },
        issues: ['缺少 extension.json'],
        warnings: [],
      });
      continue;
    }

    let raw;
    try {
      raw = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^﻿/, ''));
    } catch (err) {
      extensions.push({
        folder: dirent.name,
        id: '',
        title: '',
        order: 100,
        status: 'fail',
        files: { manifest: false, client: false, style: false, server: false },
        issues: [`extension.json 解析失败: ${err.message}`],
        warnings: [],
      });
      continue;
    }

    const id = String(raw?.id || '').trim();
    const title = String(raw?.title || '').trim();
    const order = Number.isFinite(Number(raw?.order)) ? Number(raw.order) : 100;
    const surfaces = normalizeExtensionSurfaces(raw);

    if (!VALID_ID_RE.test(id)) {
      issues.push(`非法扩展 id "${id}"（需匹配 ^[a-z0-9][a-z0-9-]{0,47}$）`);
    } else if (seenIds.has(id)) {
      issues.push(`扩展 id "${id}" 与目录 ${seenIds.get(id)} 重复`);
    } else {
      seenIds.set(id, dirent.name);
    }
    if (!title) issues.push('缺少 title 显示名称');

    const clientRef = inspectExtFileRef(extDir, raw?.clientFile, 'client.js');
    const styleRef = inspectExtFileRef(extDir, raw?.styleFile, 'styles.css');
    const serverRef = inspectExtFileRef(extDir, raw?.serverFile, 'server.js');

    if (clientRef.escaped) {
      issues.push(`clientFile 越界访问被拒绝: ${clientRef.raw}`);
    } else if (!clientRef.exists) {
      issues.push(`缺少前端脚本: ${clientRef.raw}`);
    } else {
      try {
        const scriptText = readFileSync(clientRef.full, 'utf8');
        const factory = new Function('React', 'h', scriptText);
        const mod = factory(FAKE_REACT_SHIM, () => null);
        const hook = typeof mod === 'function' ? mod : (mod && typeof mod.useExtension === 'function' ? mod.useExtension : null);
        if (!hook) {
          issues.push(`${clientRef.raw} 未返回 useExtension 函数或 { useExtension } 对象`);
        } else {
          const rt = hook({
            id: id || 'doctor',
            title: title || 'Doctor',
            active: false,
            activeNativeSession: null,
            activeStageItem: '',
            selectStageItem: () => {},
            clearStage: () => {},
            openNativeSession: async () => ({}),
            callExt: async () => ({}),
          });
          const needsWorkbench = surfaces.includes('workbench');
          const needsSidebar = surfaces.includes('sidebar');
          if (!rt || typeof rt !== 'object') {
            issues.push(`${clientRef.raw} 的 useExtension 未返回有效对象`);
          } else {
            if (needsWorkbench && typeof rt.renderCenter !== 'function') {
              issues.push(`${clientRef.raw} 的 useExtension 返回值缺少 renderCenter 函数`);
            }
            if (needsSidebar && typeof rt.renderSidebar !== 'function') {
              issues.push(`${clientRef.raw} 声明了 sidebar 挂载但缺少 renderSidebar 函数`);
            }
            if (needsSidebar && typeof rt.renderStage !== 'function' && typeof rt.renderCenter !== 'function') {
              issues.push(`${clientRef.raw} 声明了 sidebar 挂载但缺少 renderStage（或 renderCenter）函数`);
            }
          }
        }
      } catch (err) {
        issues.push(`${clientRef.raw} 语法或工厂执行失败: ${err.message}`);
      }
    }

    if (styleRef.escaped) {
      issues.push(`styleFile 越界访问被拒绝: ${styleRef.raw}`);
    } else if (styleRef.explicit && !styleRef.exists) {
      warnings.push(`声明的样式文件不存在: ${styleRef.raw}`);
    }

    if (serverRef.escaped) {
      issues.push(`serverFile 越界访问被拒绝: ${serverRef.raw}`);
    } else if (serverRef.explicit && !serverRef.exists) {
      issues.push(`声明的服务端脚本不存在: ${serverRef.raw}`);
    } else if (serverRef.exists) {
      try {
        const mtimeMs = statSync(serverRef.full).mtimeMs;
        const mod = await import(`${pathToFileURL(serverRef.full).href}?doctor=${Math.floor(mtimeMs)}`);
        if (typeof mod?.handleAction !== 'function') {
          issues.push(`${serverRef.raw} 未导出 handleAction 函数`);
        }
      } catch (err) {
        issues.push(`${serverRef.raw} 加载失败: ${err.message}`);
      }
    }

    const status = issues.length ? 'fail' : (warnings.length ? 'warn' : 'ok');
    extensions.push({
      folder: dirent.name,
      id,
      title,
      order,
      surfaces,
      status,
      files: {
        manifest: true,
        client: clientRef.exists,
        style: styleRef.exists,
        server: serverRef.exists,
      },
      issues,
      warnings,
    });
  }

  extensions.sort((a, b) => a.order - b.order || a.folder.localeCompare(b.folder));
  const filtered = filterId ? extensions.filter((item) => item.id === filterId || item.folder === filterId) : extensions;
  const globalIssues = filterId && filtered.length === 0 ? [`未找到扩展: ${filterId}`] : [];
  const okCount = filtered.filter((x) => x.status === 'ok').length;
  const warnCount = filtered.filter((x) => x.status === 'warn').length;
  const failCount = filtered.filter((x) => x.status === 'fail').length + globalIssues.length;

  return {
    ok: failCount === 0,
    status: filtered.length === 0 ? 'empty' : (failCount === 0 ? 'ready' : 'error'),
    syncRepoRoot,
    extensionsDir: extRoot,
    extensions: filtered,
    issues: globalIssues,
    summary: {
      total: filtered.length,
      okCount,
      warnCount,
      failCount,
    },
  };
}

