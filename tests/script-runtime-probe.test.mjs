import './isolate-sync.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  commandLineMentionsScript,
  findPidsForScriptPath,
  probeServiceEndpointAlive,
} from '../lib/background-services.js';

test('command line matches script by full path or parent/name even when separators differ', () => {
  const script = 'D:\\repo\\services\\selection-guard\\windows-launcher.pyw';
  assert.equal(commandLineMentionsScript(
    'python -X utf8 d:/repo/services/selection-guard/windows-launcher.pyw',
    script,
  ), true);
  assert.equal(commandLineMentionsScript(
    'pythonw.exe selection-guard/windows-launcher.pyw',
    script,
  ), true);
  assert.equal(commandLineMentionsScript('python other-guard/windows-launcher.pyw', script), false);
});

test('injected command lines find the matching pid without scanning the host', async () => {
  const script = 'C:/repo/services/selection-guard/windows-launcher.pyw';
  const pids = await findPidsForScriptPath(script, {
    scriptProcesses: [
      { pid: 11, commandLine: 'python C:/other/app.py' },
      { pid: 22, commandLine: 'python -X utf8 C:/repo/services/selection-guard/windows-launcher.pyw' },
    ],
  });
  assert.deepEqual(pids, [22]);
});

test('script-path probe uses injected processes when no health or drive is declared', async () => {
  const entry = {
    id: 'selection_guard',
    scriptPath: 'D:/repo/services/selection-guard/windows-launcher.pyw',
  };
  assert.equal(await probeServiceEndpointAlive(entry, { commands: ['python C:/other.py'] }), false);
  assert.equal(await probeServiceEndpointAlive(entry, {
    commands: ['python -X utf8 D:/repo/services/selection-guard/windows-launcher.pyw'],
    pids: [25968],
  }), true);
});

test('drive letters still count as running on Windows without a tracked pid', async () => {
  if (process.platform !== 'win32') return;
  assert.equal(await probeServiceEndpointAlive({ id: 'missing-drive', drive: 'ZZ:' }), false);
  const systemDrive = `${(process.env.SystemDrive || 'C:').replace(/\\/g, '').slice(0, 2)}`;
  assert.equal(await probeServiceEndpointAlive({ id: 'system-drive', drive: systemDrive }), true);
});
