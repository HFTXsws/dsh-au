import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  listMachineBindings,
  loadLocalBindings,
  loadMachinePreferences,
  loadMenuFavorites,
  saveMachinePreferences,
  saveMenuFavorites,
  setLocalBindingService,
  switchActiveBinding,
  updateMachinePlugins,
  writeActivePointer,
  writeLocalBindingState,
} from '../lib/local-bindings.js';
import { PLUGIN_ROOT, syncRepoUnavailableMessage } from '../lib/sync-repo.js';

const ENV_KEYS = [
  'DSH_AU_SYNC_REPO',
  'DSH_AU_CONFIG_PATH',
  'DSH_AU_LOCAL_DIR',
  'DSH_AU_LOCAL_BINDINGS_PATH',
  'DSH_AU_LOCAL_POINTER_PATH',
  'DSH_AU_LOCAL_STATE_PATH',
  'DSH_AU_MACHINES_DIR',
];

function isolateUnconfigured(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-au-unconfigured-'));
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.DSH_AU_CONFIG_PATH = path.join(dir, 'missing-dsh-au.config.json');
  t.after(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function pluginSyncPrivateDirs() {
  return [
    path.join(PLUGIN_ROOT, 'sync', 'local'),
    path.join(PLUGIN_ROOT, 'sync', 'machines'),
  ];
}

function snapshotPrivateDirs() {
  return pluginSyncPrivateDirs().map((dir) => ({
    dir,
    existed: existsSync(dir),
    names: existsSync(dir) ? readdirSync(dir).sort() : [],
  }));
}

test('未配置私人仓库且无 env 覆盖时，写本机绑定被拒绝，且不落盘到插件 sync/', (t) => {
  isolateUnconfigured(t);
  const before = snapshotPrivateDirs();
  const unavailable = syncRepoUnavailableMessage();

  assert.throws(() => writeActivePointer('test-host'), (err) => err.message === unavailable);
  assert.deepEqual(writeLocalBindingState('test-host', () => ({ enabled: true })), { ok: false, reason: unavailable });
  assert.equal(saveMenuFavorites(['11']).ok, false);
  assert.equal(saveMenuFavorites(['11']).reason, unavailable);
  assert.equal(updateMachinePlugins(['dsh-au']).ok, false);
  assert.equal(updateMachinePlugins(['dsh-au']).reason, unavailable);
  assert.equal(setLocalBindingService('demo', { scriptPath: 'scripts/demo.mjs' }).ok, false);
  assert.equal(setLocalBindingService('demo', { scriptPath: 'scripts/demo.mjs' }).reason, unavailable);
  assert.equal(switchActiveBinding('test-host').ok, false);
  assert.equal(switchActiveBinding('test-host').reason, unavailable);
  assert.equal(saveMachinePreferences({ shortcutOverrides: {} }).ok, false);
  assert.equal(saveMachinePreferences({ shortcutOverrides: {} }).reason, unavailable);

  assert.deepEqual(snapshotPrivateDirs(), before);
});

test('未配置时读操作优雅降级，不崩溃、不触发迁移写入', (t) => {
  isolateUnconfigured(t);
  const before = snapshotPrivateDirs();

  const bindings = loadLocalBindings();
  assert.equal(bindings.unconfigured, true);
  assert.equal(bindings.exists, false);
  assert.deepEqual(bindings.services, {});

  const favorites = loadMenuFavorites();
  assert.equal(favorites.unconfigured, true);
  assert.equal(favorites.favorites, null);

  const machines = listMachineBindings();
  assert.equal(machines.unconfigured, true);
  assert.deepEqual(machines.items, []);

  const prefs = loadMachinePreferences();
  assert.equal(prefs.unconfigured, true);
  assert.equal(prefs.shortcutOverrides, null);

  assert.deepEqual(snapshotPrivateDirs(), before);
});
