import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAuWinPythonLaunch } from '../lib/background-services.js';

function pythonFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-au-python-launch-'));
  // Only remove the temporary directory created by this fixture.
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const venv = join(root, 'project with spaces', 'venv');
  const home = join(root, 'base Python');
  mkdirSync(join(venv, 'Scripts'), { recursive: true });
  mkdirSync(home, { recursive: true });
  return { venv, home };
}

test('Windows controller bypasses the Low Integrity venv image without losing its environment', async (t) => {
  // 2026-10-28: inherited Low Integrity on venv/python.exe prevented Worker log/data writes.
  const { venv, home } = pythonFixture(t);
  writeFileSync(join(venv, 'pyvenv.cfg'), `home = ${home}\r\ninclude-system-site-packages = false\r\n`);
  for (const executable of ['python.exe', 'pythonw.exe']) {
    await t.test(executable, () => {
      const launcher = join(venv, 'Scripts', executable);
      const base = join(home, executable);
      writeFileSync(launcher, 'venv redirector');
      writeFileSync(base, 'base interpreter');
      const inputEnv = { PATH: 'unchanged', __PYVENV_LAUNCHER__: 'foreign-venv', PYTHONUTF8: '0' };
      const result = resolveAuWinPythonLaunch({ pythonPath: launcher, platformOs: 'win32', env: inputEnv });
      assert.equal(result.command, base);
      assert.equal(result.env.__PYVENV_LAUNCHER__, launcher);
      assert.equal(result.env.PATH, 'unchanged');
      assert.equal(result.env.PYTHONUTF8, '1');
      assert.equal(result.env.PYTHONIOENCODING, 'utf-8');
      assert.equal(inputEnv.__PYVENV_LAUNCHER__, 'foreign-venv');
      assert.equal(inputEnv.PYTHONUTF8, '0');
    });
  }
});

test('incomplete Windows virtual environments retain the original executable', async (t) => {
  for (const scenario of ['missing config', 'missing home', 'missing base']) {
    await t.test(scenario, (child) => {
      const { venv, home } = pythonFixture(child);
      const launcher = join(venv, 'Scripts', 'python.exe');
      writeFileSync(launcher, 'venv redirector');
      if (scenario !== 'missing config') {
        writeFileSync(join(venv, 'pyvenv.cfg'), scenario === 'missing home' ? 'version = 3.10.10\n' : `home = ${home}\n`);
      }
      const result = resolveAuWinPythonLaunch({ pythonPath: launcher, platformOs: 'win32', env: { __PYVENV_LAUNCHER__: 'foreign-venv' } });
      assert.equal(result.command, launcher);
      assert.equal(result.env.__PYVENV_LAUNCHER__, undefined);
    });
  }
});

test('macOS, Linux and system Python keep their executable and do not inherit a foreign venv', async (t) => {
  for (const [platformOs, pythonPath] of [['darwin', '/project/venv/bin/python3'], ['linux', '/project/venv/bin/python'], ['win32', 'python']]) {
    await t.test(platformOs, () => {
      const result = resolveAuWinPythonLaunch({ pythonPath, platformOs, env: { __PYVENV_LAUNCHER__: 'foreign-venv' } });
      assert.equal(result.command, pythonPath);
      assert.equal(result.env.__PYVENV_LAUNCHER__, undefined);
    });
  }
});
