import { lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 已并入 dsh-au 的旧插件；它们在 profile 里的挂载痕迹必须清掉，否则会和内置功能重复加载。 */
export const LEGACY_PLUGINS = Object.freeze(['dsh-au-todo', 'dsh-au-mobile']);

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** 去掉 cordis.patch.yml 里 `- id: <旧插件>` 的整块：从该行起，到下一个顶格行之前。 */
export function stripPatchBlocks(text, ids = LEGACY_PLUGINS) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const idPattern = new RegExp(`^- id:\\s*['"]?(${ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})['"]?\\s*$`);
  const kept = [];
  let skipping = false;
  let removed = false;
  for (const line of text.split(/\r?\n/)) {
    if (idPattern.test(line)) {
      skipping = true;
      removed = true;
      continue;
    }
    if (skipping && (line === '' || /^\s/.test(line))) continue;
    skipping = false;
    kept.push(line);
  }
  // 没有旧插件块时原样返回：混合行尾（Windows autocrlf 快照 + LF 追加段）不能被顺手统一改写。
  return removed ? kept.join(eol) : text;
}

/**
 * 清理 profile 里旧 todo / mobile 插件的挂载：软链、依赖、bundles、包映射、patch 块。
 * 只动「仓库软链」和配置里的登记项；node_modules 下的真实目录不是本仓库挂的，一律不碰。
 */
export function cleanupLegacyPlugins({ profileDir, ids = LEGACY_PLUGINS }) {
  const summary = [];
  const warnings = [];
  const nodeModulesDir = join(profileDir, 'node_modules');

  for (const id of ids) {
    const linkPath = join(nodeModulesDir, id);
    let stat = null;
    try { stat = lstatSync(linkPath); } catch { stat = null; }
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      rmSync(linkPath, { recursive: true, force: true });
      summary.push(`软链 ${id}`);
    } else {
      warnings.push(`node_modules/${id} 是真实目录而不是仓库软链，已保留，请手动处理`);
    }
  }

  const pkgPath = join(profileDir, 'package.json');
  const pkg = readJson(pkgPath);
  if (pkg && typeof pkg === 'object') {
    let changed = false;
    for (const id of ids) {
      if (pkg.dependencies && id in pkg.dependencies) {
        delete pkg.dependencies[id];
        changed = true;
      }
    }
    const bundles = pkg?.dsh?.profile?.bundles;
    if (Array.isArray(bundles)) {
      const next = bundles.filter((item) => !ids.includes(item));
      if (next.length !== bundles.length) {
        pkg.dsh.profile.bundles = next;
        changed = true;
      }
    }
    if (changed) {
      writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
      summary.push('package.json 依赖与 bundles');
    }
  }

  const mapPath = join(nodeModulesDir, '.package-map.json');
  const map = readJson(mapPath);
  if (map?.packages && typeof map.packages === 'object') {
    let changed = false;
    for (const id of ids) {
      if (id in map.packages) {
        delete map.packages[id];
        changed = true;
      }
      const rootDeps = map.packages['.']?.dependencies;
      if (rootDeps && id in rootDeps) {
        delete rootDeps[id];
        changed = true;
      }
    }
    if (changed) {
      writeFileSync(mapPath, JSON.stringify(map), 'utf8');
      summary.push('.package-map.json');
    }
  }

  const patchPath = join(profileDir, 'cordis.patch.yml');
  let patchText = null;
  try { patchText = readFileSync(patchPath, 'utf8'); } catch { patchText = null; }
  if (patchText !== null) {
    const stripped = stripPatchBlocks(patchText, ids);
    if (stripped !== patchText) {
      writeFileSync(patchPath, stripped, 'utf8');
      summary.push('cordis.patch.yml 的旧插件块');
    }
  }

  return { changed: summary.length > 0, summary, warnings };
}
