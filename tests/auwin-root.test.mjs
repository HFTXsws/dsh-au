import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildScriptLaunchSpec,
  listCursorWorkerInstances,
  resolveAuWinRoot,
} from '../lib/background-services.js';
import { machineFilePath, setLocalBindingService, writeActivePointer } from '../lib/local-bindings.js';

const ENV_KEYS = [
  'DSH_AU_AUWIN_ROOT', 'DSH_AU_CONFIG_PATH', 'DSH_AU_LOCAL_DIR', 'DSH_AU_MACHINES_DIR',
  'DSH_AU_LOCAL_POINTER_PATH', 'DSH_AU_LOCAL_STATE_PATH', 'DSH_AU_LOCAL_BINDINGS_PATH',
];

test('resolveAuWinRoot infers AuWin from cursor_workers scriptPath in machine bindings', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-au-auwin-root-'));
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const auwin = path.join(dir, 'AuWin');
  const script = path.join(auwin, 'backend', 'scripts', 'system', 'cursor_worker.py');
  const configPath = path.join(path.dirname(script), 'cursor_workers.json');
  mkdirSync(path.dirname(script), { recursive: true });
  mkdirSync(path.join(auwin, 'backend', 'lanmiao'), { recursive: true });
  writeFileSync(path.join(auwin, 'backend', 'lanmiao', 'background_services.py'), '# fixture\n');
  writeFileSync(script, '# fixture\n');
  writeFileSync(configPath, JSON.stringify({
    machines: { 'Test-Host': { prefix: 'x9' } },
    repos: ['Demo'],
  }));

  for (const key of ENV_KEYS) delete process.env[key];
  process.env.DSH_AU_LOCAL_DIR = path.join(dir, 'local');
  process.env.DSH_AU_CONFIG_PATH = path.join(dir, 'missing-config.json');

  const machineId = 'auwin-root-host';
  mkdirSync(path.dirname(machineFilePath(machineId)), { recursive: true });
  writeFileSync(machineFilePath(machineId), JSON.stringify({ schemaVersion: 2, machineId, services: {} }));
  writeActivePointer(machineId);
  assert.equal(setLocalBindingService('cursor_workers', {
    name: 'Cursor Workers',
    scriptPath: script,
    configPath,
  }).ok, true);

  assert.equal(resolveAuWinRoot(), auwin);
  const listed = await listCursorWorkerInstances({
    hostnames: ['Test-Host'],
    commands: ['node.exe index.js worker --name x9-Demo start'],
  });
  assert.deepEqual(listed.map((item) => item.name), ['x9-Demo']);
});

test('cursor_worker.py launch spec always adds --no-wait so the launcher cannot fake-alive', () => {
  const spec = buildScriptLaunchSpec('C:/AuWin/backend/scripts/system/cursor_worker.py', { windowless: true });
  assert.equal(spec.args.includes('--no-wait'), true);
});
