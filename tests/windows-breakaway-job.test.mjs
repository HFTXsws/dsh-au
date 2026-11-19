import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Regression: DSH's Windows Job Object reclaimed managed services after DSH restarted.
test('Windows runtime and boot launchers break managed services away from the DSH Job Object', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-au-breakaway-'));
  const auwinRoot = path.join(root, 'AuWin');
  const startupDir = path.join(root, 'startup');
  const bindingPath = path.join(root, 'machine.json');
  const envNames = ['DSH_AU_AUWIN_ROOT', 'DSH_AU_STARTUP_DIR', 'DSH_AU_LOCAL_BINDINGS_PATH'];
  const previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

  try {
    mkdirSync(path.join(auwinRoot, 'backend', 'lanmiao'), { recursive: true });
    writeFileSync(path.join(auwinRoot, 'backend', 'lanmiao', 'background_services.py'), '# test fixture\n', 'utf8');
    writeFileSync(bindingPath, JSON.stringify({
      schemaVersion: 2,
      machineId: 'breakaway-test',
      services: { dsh_bridge: { controller: 'auwin' } },
    }), 'utf8');
    process.env.DSH_AU_AUWIN_ROOT = auwinRoot;
    process.env.DSH_AU_STARTUP_DIR = startupDir;
    process.env.DSH_AU_LOCAL_BINDINGS_PATH = bindingPath;

    const {
      resolveAuWinPythonLaunch,
      syncBootStartupEntry,
      WIN_HEADLESS_POPEN_PATCH,
    } = await import('../lib/background-services.js?windows-breakaway-job');
    if (process.platform === 'win32') {
      const python = resolveAuWinPythonLaunch();
      const probe = [
        'import json, subprocess',
        'class _SI:',
        '    def __init__(self):',
        '        self.dwFlags = 0',
        '        self.wShowWindow = 1',
        'subprocess.STARTUPINFO = _SI',
        'subprocess.STARTF_USESHOWWINDOW = 1',
        'def _capture(*args, **kwargs):',
        "    print(json.dumps({'creationflags': kwargs.get('creationflags', 0), 'dwFlags': kwargs['startupinfo'].dwFlags, 'wShowWindow': kwargs['startupinfo'].wShowWindow}))",
        '    return object()',
        'subprocess.Popen = _capture',
        WIN_HEADLESS_POPEN_PATCH,
        "subprocess.Popen(['fixture'])",
      ].join('\n');
      const executed = spawnSync(python.command, ['-X', 'utf8', '-c', probe], {
        env: python.env,
        encoding: 'utf8',
        windowsHide: true,
      });
      assert.equal(executed.status, 0, executed.stderr);
      const captured = JSON.parse(executed.stdout.trim().split(/\r?\n/).at(-1));
      assert.equal(captured.creationflags & 0x08000000, 0x08000000);
      assert.equal(captured.creationflags & 0x00000200, 0x00000200);
      assert.equal(captured.creationflags & 0x01000000, 0x01000000);
      assert.equal(captured.dwFlags & 1, 1);
      assert.equal(captured.wShowWindow, 0);
    }
    const result = await syncBootStartupEntry('breakaway-test', {
      enabled: ['dsh_bridge'],
      autoStartOnBoot: ['dsh_bridge'],
    }, 'win32');

    assert.equal(result.synced, true);
    assert.deepEqual(result.activeServices, ['dsh_bridge']);
    const vbs = readFileSync(result.filePath, 'utf8');
    assert.match(
      vbs,
      /creationflags.+\| getattr\(subprocess, 'CREATE_BREAKAWAY_FROM_JOB', 0x01000000\)/,
    );
  } finally {
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
