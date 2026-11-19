import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installClientControlShims } from '../lib/client-control/install-shim.js';
import { createClientControlIpcServer } from '../lib/client-control/ipc-server.js';
import { detectDshProfile, resolveClientControlPaths } from '../lib/client-control/paths.js';

function temporaryDirectory(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('different DSH profiles receive separate private paths and profile-bound shims', (t) => {
  const root = temporaryDirectory(t, 'dsh-au-client-install-');
  const packageDir = join(import.meta.dirname, '..');
  assert.equal(detectDshProfile({ env: {}, argv: ['node', 'host.js', join(root, 'profiles', 'work')] }), 'work');
  const desktop = resolveClientControlPaths({ dshHome: root, profile: 'desktop', platform: 'win32' });
  const work = resolveClientControlPaths({ dshHome: root, profile: 'work', platform: 'win32' });
  assert.notEqual(desktop.baseDir, work.baseDir);
  assert.notEqual(desktop.endpoint, work.endpoint);
  assert.notEqual(desktop.tokenPath, work.tokenPath);

  const windowsBin = join(root, 'windows-bin');
  const windowsFiles = installClientControlShims({
    binDir: windowsBin,
    packageDir,
    nodePath: process.execPath,
    platform: 'win32',
    profile: 'work',
  });
  const cmd = readFileSync(windowsFiles.find((file) => file.endsWith('.cmd')), 'utf8');
  const ps1 = readFileSync(windowsFiles.find((file) => file.endsWith('.ps1')));
  assert.match(cmd, /--profile "work"/);
  assert.deepEqual([...ps1.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(ps1.toString('utf8'), /--profile 'work'/);

  const unixBin = join(root, 'unix-bin');
  const [unixShim] = installClientControlShims({
    binDir: unixBin,
    packageDir,
    nodePath: process.execPath,
    platform: 'darwin',
    profile: 'work',
  });
  assert.match(readFileSync(unixShim, 'utf8'), /^#!\/bin\/sh\n/);
  assert.match(readFileSync(unixShim, 'utf8'), /--profile "work"/);
  if (process.platform !== 'win32') assert.equal(statSync(unixShim).mode & 0o111, 0o111);
});

test('the installed command executes through the profile junction or symlink', (t) => {
  const root = temporaryDirectory(t, 'dsh-au-client-command-');
  const packageDir = join(import.meta.dirname, '..');
  const mountedPackage = join(root, 'node_modules', 'dsh-au');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(packageDir, mountedPackage, process.platform === 'win32' ? 'junction' : 'dir');
  const files = installClientControlShims({
    binDir: join(root, 'node_modules', '.bin'),
    packageDir: mountedPackage,
    nodePath: process.execPath,
    platform: process.platform,
    profile: 'desktop',
  });
  const command = process.platform === 'win32'
    ? files.find((file) => file.endsWith('.cmd'))
    : files[0];
  const result = spawnSync(command, ['--help'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /^Usage:/);
});

test('a live same-profile IPC server keeps its token while another profile starts independently', async (t) => {
  const dshHome = temporaryDirectory(t, 'dsh-au-client-ipc-');
  const ctx = { get: () => null };
  const first = createClientControlIpcServer({ ctx, dshHome, profile: 'desktop' });
  let other;
  await first.start();
  try {
    const firstToken = readFileSync(first.paths.tokenPath, 'utf8');

    const duplicate = createClientControlIpcServer({ ctx, dshHome, profile: 'desktop' });
    await assert.rejects(async () => duplicate.start(), /already owned/);
    assert.equal(readFileSync(first.paths.tokenPath, 'utf8'), firstToken);

    other = createClientControlIpcServer({ ctx, dshHome, profile: 'work' });
    await other.start();
    assert.notEqual(other.paths.endpoint, first.paths.endpoint);
    assert.notEqual(other.paths.tokenPath, first.paths.tokenPath);
  } finally {
    await other?.close();
    await first.close();
  }
});
