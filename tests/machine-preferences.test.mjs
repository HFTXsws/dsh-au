import './isolate-sync.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  findLatestMachinePreferences,
  loadMachinePreferences,
  saveMachinePreferences,
  saveMenuFavorites,
} from '../lib/local-bindings.js';
import { readModelShortcuts, saveModelShortcuts } from '../lib/model-shortcuts.js';
import { syncOfficialDshAuPreferences } from '../lib/official-settings-sync.js';

function useTempSyncDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-au-machine-prefs-'));
  const previous = process.env.DSH_AU_LOCAL_DIR;
  process.env.DSH_AU_LOCAL_DIR = path.join(dir, 'local');
  mkdirSync(path.join(dir, 'local', 'machines'), { recursive: true });
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_AU_LOCAL_DIR;
    else process.env.DSH_AU_LOCAL_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    localDir: path.join(dir, 'local'),
    machineFile: (id) => path.join(dir, 'local', 'machines', `${id}.json`),
    pointTo: (id) => writeFileSync(
      path.join(dir, 'local', 'active.json'),
      JSON.stringify({ schemaVersion: 1, machineId: id, switchedAt: '' }),
    ),
    clearPointer: () => rmSync(path.join(dir, 'local', 'active.json'), { force: true }),
  };
}

test('机器偏好只写当前电脑那份，原有服务绑定不被抹掉', (t) => {
  const fixture = useTempSyncDir(t);
  fixture.pointTo('machine-a');
  writeFileSync(fixture.machineFile('machine-a'), JSON.stringify({
    schemaVersion: 2,
    machineId: 'machine-a',
    displayName: '电脑 A',
    services: { antigravity: { name: 'Antigravity Gateway', scriptPath: 'gateways/a.py' } },
    menuFavorites: ['11'],
  }));

  const saved = saveMachinePreferences({
    shortcutOverrides: { 'todo.toggle': { code: 'KeyT', ctrl: true, alt: true, shift: false, meta: false } },
    modelShortcuts: { enabled: true, binding: null, slots: [] },
  });
  assert.equal(saved.ok, true);

  const written = JSON.parse(readFileSync(fixture.machineFile('machine-a'), 'utf8'));
  assert.deepEqual(written.menuFavorites, ['11']);
  assert.equal(written.services.antigravity.scriptPath, 'gateways/a.py');
  assert.equal(written.shortcutOverrides['todo.toggle'].code, 'KeyT');
  assert.equal(written.modelShortcuts.enabled, true);
  assert.ok(written.updatedAt);

  const loaded = loadMachinePreferences();
  assert.equal(loaded.machineId, 'machine-a');
  assert.equal(loaded.shortcutOverrides['todo.toggle'].code, 'KeyT');
  assert.equal(loaded.modelShortcuts.enabled, true);

  // 保存常用收藏走另一条写路径，也不能把本机设置抹掉。
  const favorites = saveMenuFavorites(['11', '33']);
  assert.equal(favorites.ok, true);
  const afterFavorites = JSON.parse(readFileSync(fixture.machineFile('machine-a'), 'utf8'));
  assert.equal(afterFavorites.shortcutOverrides['todo.toggle'].code, 'KeyT');
  assert.equal(afterFavorites.modelShortcuts.enabled, true);
});

test('新电脑没有自己那份时，从最近更新的设备备份取初值作为来源', (t) => {
  const fixture = useTempSyncDir(t);
  fixture.pointTo('machine-a');
  // 先有设备 A 的机器备份，模拟另一台已经推送过配置的电脑。
  writeFileSync(fixture.machineFile('machine-a'), JSON.stringify({
    schemaVersion: 2,
    machineId: 'machine-a',
    services: {},
  }));
  saveMachinePreferences({
    shortcutOverrides: { 'device.next': { code: 'KeyN', ctrl: false, alt: true, shift: false, meta: false } },
    modelShortcuts: { enabled: false, binding: null, slots: [{ provider: 'azure-full', model: 'x' }] },
  });

  // 模拟另一台什么都没配过的电脑：没有指针，也没有自己的机器备份。
  fixture.clearPointer();
  const own = loadMachinePreferences();
  assert.equal(own.exists, false);
  assert.equal(own.shortcutOverrides, null);

  const latest = findLatestMachinePreferences();
  assert.equal(latest.shortcutSource, 'machine-a');
  assert.equal(latest.shortcutOverrides['device.next'].code, 'KeyN');
  assert.equal(latest.modelSource, 'machine-a');
  assert.equal(latest.modelShortcuts.slots[0].provider, 'azure-full');
  assert.equal(latest.modelShortcuts.slots[0].model, 'x');

  // 取初值后写回自己的那份，不能改到来源设备。
  saveMachinePreferences({ shortcutOverrides: latest.shortcutOverrides });
  const ownId = loadMachinePreferences().machineId;
  assert.notEqual(ownId, 'machine-a');
  const sourceAfter = JSON.parse(readFileSync(fixture.machineFile('machine-a'), 'utf8'));
  assert.equal(sourceAfter.modelShortcuts.enabled, false);
  assert.equal(sourceAfter.shortcutOverrides['device.next'].code, 'KeyN');
});

test('模型槽位首次读取时把旧的仓库共享配置迁到本机，之后只认本机', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-au-model-migrate-'));
  const previousHome = process.env.DSH_HOME;
  const previousPath = process.env.DSH_AU_MODEL_SHORTCUTS_PATH;
  const previousLocal = process.env.DSH_AU_LOCAL_DIR;
  delete process.env.DSH_AU_MODEL_SHORTCUTS_PATH;
  process.env.DSH_HOME = path.join(dir, 'home');
  process.env.DSH_AU_LOCAL_DIR = path.join(dir, 'local');
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    if (previousPath === undefined) delete process.env.DSH_AU_MODEL_SHORTCUTS_PATH;
    else process.env.DSH_AU_MODEL_SHORTCUTS_PATH = previousPath;
    if (previousLocal === undefined) delete process.env.DSH_AU_LOCAL_DIR;
    else process.env.DSH_AU_LOCAL_DIR = previousLocal;
    rmSync(dir, { recursive: true, force: true });
  });

  const repoRoot = path.join(dir, 'repo');
  const legacyPath = path.join(repoRoot, 'dsh-au', 'sync', 'cloud', 'model-shortcuts.json');
  mkdirSync(path.dirname(legacyPath), { recursive: true });
  writeFileSync(legacyPath, JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    binding: { code: 'KeyM', ctrl: false, alt: true, shift: false, meta: false },
    slots: [{ provider: 'azure-full', model: 'legacy-model' }],
  }));

  const first = readModelShortcuts({ repoRoot });
  assert.equal(first.exists, true);
  assert.equal(first.migratedFrom, legacyPath);
  assert.equal(first.modelShortcuts.enabled, true);
  assert.equal(first.modelShortcuts.slots[0].provider, 'azure-full');
  assert.equal(first.modelShortcuts.slots[0].model, 'legacy-model');
  const localPath = path.join(dir, 'home', 'model-shortcuts.json');
  assert.equal(existsSync(localPath), true);

  // 旧文件之后被改动也不会再影响本机，说明只读本机那份。
  writeFileSync(legacyPath, JSON.stringify({ schemaVersion: 1, enabled: false, binding: null, slots: [] }));
  const second = readModelShortcuts({ repoRoot });
  assert.equal(second.modelShortcuts.enabled, true);
  assert.equal(second.modelShortcuts.slots[0].provider, 'azure-full');
  assert.equal(second.modelShortcuts.slots[0].model, 'legacy-model');

  // 保存只写本机文件，不再写仓库旧文件。
  saveModelShortcuts({ enabled: false }, { repoRoot });
  const savedLocal = JSON.parse(readFileSync(localPath, 'utf8'));
  assert.equal(savedLocal.enabled, false);
  const legacyAfter = JSON.parse(readFileSync(legacyPath, 'utf8'));
  assert.equal(legacyAfter.enabled, false);
});

test('发布链路：快捷键只认本机机器备份，旧云偏好不再覆盖', (t) => {
  const fixture = useTempSyncDir(t);
  fixture.pointTo('machine-a');
  const binding = (code) => ({ code, ctrl: false, alt: true, shift: false, meta: false });
  writeFileSync(fixture.machineFile('machine-a'), JSON.stringify({
    schemaVersion: 2,
    machineId: 'machine-a',
    services: {},
    shortcutOverrides: { 'todo.toggle': binding('KeyN') },
  }));

  const repoRoot = path.join(fixture.dir, 'repo');
  const cloudDir = path.join(repoRoot, 'dsh-au', 'sync', 'cloud');
  mkdirSync(cloudDir, { recursive: true });
  writeFileSync(path.join(cloudDir, 'dsh-au-preferences.json'), JSON.stringify({
    schemaVersion: 1,
    todo: true,
    shortcutOverrides: { 'todo.toggle': binding('KeyC') },
  }));

  const dshHome = path.join(fixture.dir, 'home');
  mkdirSync(dshHome, { recursive: true });
  const configPath = path.join(dshHome, 'dsh-au.config.json');
  writeFileSync(configPath, JSON.stringify({
    clientPreferences: { shortcutOverrides: { 'todo.toggle': binding('KeyL') } },
  }));

  syncOfficialDshAuPreferences({ repoRoot, dshHome, preferences: ['shortcuts'] });
  const synced = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(synced.clientPreferences.shortcutOverrides['todo.toggle'].code, 'KeyN');

  // 未勾选时完全不动本机，证明独立开关生效。
  writeFileSync(configPath, JSON.stringify({
    clientPreferences: { shortcutOverrides: { 'todo.toggle': binding('KeyL') } },
  }));
  syncOfficialDshAuPreferences({ repoRoot, dshHome, preferences: [] });
  const kept = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(kept.clientPreferences.shortcutOverrides['todo.toggle'].code, 'KeyL');
});
