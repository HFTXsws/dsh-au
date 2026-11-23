#!/usr/bin/env node
/**
 * 测试夹具：模拟私人仓库 scripts/dsh-restore.mjs 的 --auto-sync 最小行为。
 * 真正实现来自 dsh-au/lib/official-settings-sync.js，不依赖外部私人仓库。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = process.env.DSH_AU_PLUGIN_ROOT;
if (!pluginRoot) {
  console.error('DSH_AU_PLUGIN_ROOT is required');
  process.exit(1);
}

const {
  applySelectedOfficialPatchBlocks,
  computeOfficialSettingsHash,
  normalizeCloudSyncConfig,
  resolveRepoProfilePatchPath,
  syncOfficialDesktopPreferences,
} = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'official-settings-sync.js')).href);

const args = process.argv.slice(2);
const autoSync = args.includes('--auto-sync');
const dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh');
const auConfigPath = process.env.DSH_AU_CONFIG_PATH || path.join(dshHome, 'dsh-au.config.json');
let localAuConfigRaw = null;
try {
  if (existsSync(auConfigPath)) localAuConfigRaw = JSON.parse(readFileSync(auConfigPath, 'utf8'));
} catch {}
const localCloudSync = normalizeCloudSyncConfig(localAuConfigRaw?.cloudSync, { repoRoot });
if (autoSync && !localCloudSync.enabled) {
  console.log('[dsh-restore] 本机未开启云端配置自动同步，跳过。');
  process.exit(0);
}

const profile = localCloudSync.profile || 'general';
const source = resolveRepoProfilePatchPath(repoRoot, profile);
const targetDir = path.join(dshHome, 'profiles', 'desktop');
const target = path.join(targetDir, 'cordis.patch.yml');
if (!existsSync(source) || !existsSync(targetDir)) {
  console.error('missing source or target profile');
  process.exit(1);
}

const merged = applySelectedOfficialPatchBlocks({
  currentPatchText: readFileSync(target, 'utf8'),
  renderedProfilePatch: readFileSync(source, 'utf8'),
  selectedItems: localCloudSync.selectedItems,
});
mkdirSync(targetDir, { recursive: true });
writeFileSync(target, merged.endsWith('\n') ? merged : `${merged}\n`);

if (localCloudSync.selectedItems.includes('desktop-preferences')) {
  syncOfficialDesktopPreferences({ repoRoot, dshHome, enabled: true });
}

const nextConfig = {
  ...(localAuConfigRaw && typeof localAuConfigRaw === 'object' ? localAuConfigRaw : {}),
  cloudSync: {
    ...localCloudSync,
    lastSyncedHash: computeOfficialSettingsHash(repoRoot, profile),
    lastSyncedAt: new Date().toISOString(),
  },
};
writeFileSync(auConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
process.exit(0);
