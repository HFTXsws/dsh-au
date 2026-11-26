import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { copyMenuFixture, useTempSyncRepo } from './helpers/temp-sync-repo.mjs';
import {
  buildMenuCommandArgs,
  loadMenuSpec,
  resolveMenuScriptPath,
  resolveWindowsPowerShellCommand,
} from '../lib/menu-runner.js';
import { syncRepoUnavailableMessage } from '../lib/sync-repo.js';

const ENV_KEYS = ['DSH_AU_SYNC_REPO', 'DSH_AU_CONFIG_PATH', 'DSH_AU_PROFILES_MANIFEST_PATH'];

function isolateSyncEnv(t, extra = {}) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, extra);
  t.after(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

test('未配置私人同步仓库时菜单直接降级，不读插件目录', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-au-menu-unconfigured-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  isolateSyncEnv(t, { DSH_AU_CONFIG_PATH: path.join(dir, 'missing-dsh-au.config.json') });
  const spec = loadMenuSpec('win32');
  assert.equal(spec.configured, false);
  assert.equal(spec.message, syncRepoUnavailableMessage());
  assert.deepEqual(spec.groups, []);
  assert.equal(spec.sourceLabel, '');
  assert.equal(spec.psCommandName === 'pwsh' || spec.psCommandName === 'powershell', true);
});

test('只读 sync/menu.json 或清单 menuFile，绝不回退 scripts/menu.json', (t) => {
  const { root, syncDir } = useTempSyncRepo(t, 'dsh-au-menu-sync-json-');
  writeFileSync(path.join(root, 'scripts', 'menu.json'), JSON.stringify({
    version: 1,
    groups: [{ title: '旧脚本目录菜单', items: [{ code: '11', label: '旧项', script: 'init', runner: 'platform' }] }],
  }));

  const emptyWhenMissing = loadMenuSpec('win32');
  assert.equal(emptyWhenMissing.configured, true);
  assert.deepEqual(emptyWhenMissing.groups, []);
  assert.equal(emptyWhenMissing.sourceLabel, '');

  // 含 .. 的 menuFile 必须被安全拒绝。
  writeFileSync(path.join(syncDir, 'cloud', 'dsh-profiles.json'), JSON.stringify({
    menuFile: '../outside/menu.json',
    profiles: [{ id: 'default', file: 'p.json' }],
  }));
  const rejectedTraversal = loadMenuSpec('win32');
  assert.deepEqual(rejectedTraversal.groups, []);
  assert.equal(rejectedTraversal.sourceLabel, '');

  // 清单声明合法仓库相对 menuFile 时读取该文件。
  mkdirSync(path.join(root, 'custom'), { recursive: true });
  writeFileSync(path.join(root, 'custom', 'custom-menu.json'), JSON.stringify({
    version: 1,
    scriptBaseDir: ' /custom-scripts/ ',
    groups: [{ title: '清单声明菜单', items: [{ code: '55', label: '声明项', script: 'task.mjs', runner: 'node' }] }],
  }));
  writeFileSync(path.join(syncDir, 'cloud', 'dsh-profiles.json'), JSON.stringify({
    menuFile: 'custom/custom-menu.json',
    profiles: [{ id: 'default', file: 'p.json' }],
  }));
  const fromManifest = loadMenuSpec('win32');
  assert.equal(fromManifest.groups[0].title, '清单声明菜单');
  assert.equal(fromManifest.groups[0].items[0].code, '55');
  assert.equal(fromManifest.groups[0].items[0].scriptBaseDir, 'custom-scripts');
  assert.equal(fromManifest.groups[0].items[0].resolvedScript, 'custom-scripts/task.mjs');
  assert.equal(fromManifest.sourceLabel, 'custom/custom-menu.json');
  assert.equal(buildMenuCommandArgs(fromManifest.groups[0].items[0], {}, 'win32').preview, 'node custom-scripts/task.mjs');

  // sync/menu.json 存在时优先级高于 dsh-profiles.json 的 menuFile。
  writeFileSync(path.join(syncDir, 'menu.json'), JSON.stringify({
    version: 1,
    groups: [{ title: '同步目录菜单', items: [{ code: '99', label: '优先项', script: 'init', runner: 'platform' }] }],
  }));
  const fromSync = loadMenuSpec('win32');
  assert.equal(fromSync.groups[0].title, '同步目录菜单');
  assert.equal(fromSync.groups[0].items[0].code, '99');
  assert.equal(fromSync.sourceLabel, 'dsh-au/sync/menu.json');
});

test('声明式 params 按平台拼装命令行，并过滤 options.platform', (t) => {
  const { root } = useTempSyncRepo(t, 'dsh-au-menu-params-');
  copyMenuFixture(root);
  const spec = loadMenuSpec('win32');
  const item11 = spec.groups[0].items.find((item) => item.code === '11');
  const item21 = spec.groups.flatMap((g) => g.items).find((item) => item.code === '21');
  const item71 = spec.groups.flatMap((g) => g.items).find((item) => item.code === '71');

  assert.equal(spec.sourceLabel, 'dsh-au/sync/menu.json');
  assert.equal(item11.scriptBaseDir, 'scripts');
  assert.equal(item11.resolvedScript, 'scripts/init.ps1');
  assert.equal(loadMenuSpec('darwin').groups[0].items[0].resolvedScript, 'scripts/init.sh');

  const win21 = buildMenuCommandArgs(item21, { action: 'export' }, 'win32');
  assert.match(win21.preview, /-Action export -Yes$/);
  const mac21 = buildMenuCommandArgs(item21, { action: 'export' }, 'darwin');
  assert.match(mac21.preview, /export --yes$/);

  // Windows 上看不到 darwin 专属 local，回落到 defaultValue kiro，并带上 win32 布尔开关。
  const win71 = buildMenuCommandArgs(item71, { dshProfile: 'local' }, 'win32');
  assert.match(win71.preview, /--profile kiro --install-plugin/);
  const mac71 = buildMenuCommandArgs(item71, { dshProfile: 'local' }, 'darwin');
  assert.equal(mac71.preview, 'node scripts/dsh-restore.mjs --profile local');
});

test('脚本路径支持 ~/、绝对路径，以及 scriptBaseDir 声明式解析（未声明不猜 scripts/）', (t) => {
  const { root } = useTempSyncRepo(t, 'dsh-au-menu-script-path-');
  writeFileSync(path.join(root, 'root-tool.mjs'), '// fixture\n');
  writeFileSync(path.join(root, 'scripts', 'dsh-restore.mjs'), '// fixture\n');
  const homeFile = path.join(root, 'home-tool.py');
  writeFileSync(homeFile, '# fixture\n');

  const fromRoot = resolveMenuScriptPath({ runner: 'node', script: 'root-tool.mjs' });
  assert.equal(fromRoot, path.join(root, 'root-tool.mjs'));

  const withoutBaseDir = resolveMenuScriptPath({ runner: 'node', script: 'dsh-restore.mjs' });
  assert.equal(withoutBaseDir, path.join(root, 'dsh-restore.mjs'));

  const withOptionBaseDir = resolveMenuScriptPath(
    { runner: 'node', script: 'dsh-restore.mjs' },
    'win32',
    { scriptBaseDir: ' /scripts/ ' },
  );
  assert.equal(withOptionBaseDir, path.join(root, 'scripts', 'dsh-restore.mjs'));

  const withItemBaseDir = resolveMenuScriptPath({ runner: 'node', script: 'dsh-restore.mjs', scriptBaseDir: 'scripts' });
  assert.equal(withItemBaseDir, path.join(root, 'scripts', 'dsh-restore.mjs'));

  const absolute = resolveMenuScriptPath({ runner: 'python', script: homeFile });
  assert.equal(absolute, homeFile);

  const tildePath = resolveMenuScriptPath({ runner: 'python', script: '~/definitely-missing-dsh-au-menu-tool.py' });
  assert.match(tildePath, /definitely-missing-dsh-au-menu-tool\.py$/);
  assert.equal(path.isAbsolute(tildePath), true);
});

test('Windows 优先检测 pwsh，不存在时回退 powershell', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-au-pwsh-'));
  writeFileSync(path.join(dir, 'pwsh.exe'), '');
  assert.equal(resolveWindowsPowerShellCommand({ env: { PATH: dir }, exists: (file) => file.endsWith(`${path.sep}pwsh.exe`) && file.startsWith(dir) }), 'pwsh');
  assert.equal(resolveWindowsPowerShellCommand({ env: { PATH: '', ProgramFiles: 'C:\\Program Files' }, exists: () => false }), 'powershell');
  rmSync(dir, { recursive: true, force: true });
});

test('loadMenuSpec 在 win32 返回 psCommandName，其它平台为空', (t) => {
  const { root } = useTempSyncRepo(t, 'dsh-au-menu-ps-name-');
  copyMenuFixture(root);
  const win = loadMenuSpec('win32');
  assert.equal(win.psCommandName === 'pwsh' || win.psCommandName === 'powershell', true);
  assert.equal(loadMenuSpec('darwin').psCommandName, '');
});

test('WindowsApps AppExecutionAlias 或 PATH 探测抛错时回退 powershell', () => {
  const throwingExists = (file) => {
    const value = String(file);
    if (value.includes('WindowsApps') || /blocked/i.test(value)) {
      throw Object.assign(new Error('UNKNOWN: AppExecutionAlias reparse point'), { code: 'UNKNOWN' });
    }
    return false;
  };
  assert.equal(resolveWindowsPowerShellCommand({
    env: {
      PATH: 'C:\\blocked',
      ProgramFiles: 'C:\\Program Files',
      LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
    },
    exists: throwingExists,
  }), 'powershell');
});
