import './isolate-sync.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveSyncRepoRoot } from '../lib/sync-repo.js';
import { loadLocalBindings } from '../lib/local-bindings.js';

test('配置文件带 UTF-8 BOM 时仍能读出 syncRepoRoot', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-au-sync-repo-bom-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfgPath = path.join(dir, 'dsh-au.config.json');
  const expected = path.resolve(dir, 'private-repo');
  writeFileSync(cfgPath, `\uFEFF${JSON.stringify({ syncRepoRoot: expected })}\n`, 'utf8');

  const previousConfig = process.env.DSH_AU_CONFIG_PATH;
  const previousSync = process.env.DSH_AU_SYNC_REPO;
  delete process.env.DSH_AU_SYNC_REPO;
  process.env.DSH_AU_CONFIG_PATH = cfgPath;
  t.after(() => {
    if (previousConfig === undefined) delete process.env.DSH_AU_CONFIG_PATH;
    else process.env.DSH_AU_CONFIG_PATH = previousConfig;
    if (previousSync === undefined) delete process.env.DSH_AU_SYNC_REPO;
    else process.env.DSH_AU_SYNC_REPO = previousSync;
  });

  assert.equal(resolveSyncRepoRoot(), expected);
});

test('配置 syncRepoRoot 且未覆盖 DSH_AU_LOCAL_DIR 时，local/state.json 跟随私人仓库 sync 目录', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-au-sync-local-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repoRoot = path.join(dir, 'private-repo');
  const syncLocal = path.join(repoRoot, 'dsh-sync', 'local');
  const syncMachines = path.join(repoRoot, 'dsh-sync', 'machines');
  mkdirSync(syncLocal, { recursive: true });
  mkdirSync(syncMachines, { recursive: true });
  writeFileSync(path.join(syncLocal, 'active.json'), JSON.stringify({ schemaVersion: 1, machineId: 'my-host' }));
  writeFileSync(path.join(syncMachines, 'my-host.json'), JSON.stringify({
    schemaVersion: 2,
    machineId: 'my-host',
    services: { demo: { name: 'Demo', scriptPath: '~/demo.py' } },
  }));
  writeFileSync(path.join(syncLocal, 'state.json'), JSON.stringify({
    schemaVersion: 1,
    machines: { 'my-host': { services: { demo: { enabled: true, autoStartOnBoot: true, autoStartOnDsh: false } } } },
  }));

  const keys = ['DSH_AU_SYNC_REPO', 'DSH_AU_LOCAL_DIR', 'DSH_AU_LOCAL_BINDINGS_PATH', 'DSH_AU_LOCAL_POINTER_PATH', 'DSH_AU_LOCAL_STATE_PATH', 'DSH_AU_MACHINES_DIR'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  process.env.DSH_AU_SYNC_REPO = repoRoot;
  t.after(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const loaded = loadLocalBindings();
  assert.equal(loaded.machineId, 'my-host');
  assert.equal(loaded.flags.demo.enabled, true);
  assert.equal(loaded.flags.demo.autoStartOnBoot, true);
});

