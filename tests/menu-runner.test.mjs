import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const ENV_KEYS = ['DSH_AU_SYNC_REPO', 'DSH_AU_CONFIG_PATH'];

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
  assert.equal(spec.psCommandName === 'pwsh' || spec.psCommandName === 'powershell', true);
});

test('配置了私人仓库时优先读 sync/menu.json，否则回退 scripts/menu.json', (t) => {
  const { root, syncDir } = useTempSyncRepo(t, 'dsh-au-menu-sync-json-');
  copyMenuFixture(root);
  const fromScripts = loadMenuSpec('win32');
  assert.equal(fromScripts.configured, true);
  assert.equal(fromScripts.groups[0].items[0].code, '11');

  writeFileSync(path.join(syncDir, 'menu.json'), JSON.stringify({
    version: 1,
    groups: [{ title: '同步目录菜单', items: [{ code: '99', label: '优先项', script: 'init', runner: 'platform' }] }],
  }));
  const fromSync = loadMenuSpec('win32');
  assert.equal(fromSync.groups[0].title, '同步目录菜单');
  assert.equal(fromSync.groups[0].items[0].code, '99');
});

test('声明式 params 按平台拼装命令行，并过滤 options.platform', (t) => {
  const { root } = useTempSyncRepo(t, 'dsh-au-menu-params-');
  copyMenuFixture(root);
  const spec = loadMenuSpec('win32');
  const item11 = spec.groups[0].items.find((item) => item.code === '11');
  const item21 = spec.groups.flatMap((g) => g.items).find((item) => item.code === '21');
  const item71 = spec.groups.flatMap((g) => g.items).find((item) => item.code === '71');

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

test('脚本路径支持 ~/、绝对路径，以及无斜杠时回退 scripts/', (t) => {
  const { root } = useTempSyncRepo(t, 'dsh-au-menu-script-path-');
  writeFileSync(path.join(root, 'root-tool.mjs'), '// fixture\n');
  const homeFile = path.join(root, 'home-tool.py');
  writeFileSync(homeFile, '# fixture\n');

  const fromRoot = resolveMenuScriptPath({ runner: 'node', script: 'root-tool.mjs' });
  assert.equal(fromRoot, path.join(root, 'root-tool.mjs'));

  const fromScripts = resolveMenuScriptPath({ runner: 'node', script: 'dsh-restore.mjs' });
  assert.equal(fromScripts, path.join(root, 'scripts', 'dsh-restore.mjs'));

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
