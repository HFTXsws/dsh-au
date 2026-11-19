import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

function cmdQuote(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Local junction installs bypass npm, so create the same callable shims explicitly. */
export function installClientControlShims({
  binDir,
  packageDir,
  nodePath = process.execPath,
  platform = process.platform,
  profile = 'desktop',
} = {}) {
  if (typeof profile !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(profile) || /^\.+$/.test(profile)) {
    throw new TypeError('DSH profile must use 1-80 letters, digits, dot, underscore, or hyphen');
  }
  const target = resolve(packageDir, 'lib', 'client-control', 'cli.js');
  mkdirSync(binDir, { recursive: true });
  const files = [];
  if (platform === 'win32') {
    const cmdPath = join(binDir, 'dsh-au-client-control.cmd');
    const ps1Path = join(binDir, 'dsh-au-client-control.ps1');
    writeFileSync(cmdPath, `@ECHO OFF\r\n${cmdQuote(nodePath)} ${cmdQuote(target)} --profile ${cmdQuote(profile)} %*\r\nEXIT /B %ERRORLEVEL%\r\n`, 'utf8');
    const psText = `$ErrorActionPreference = 'Stop'\r\n& ${psQuote(nodePath)} ${psQuote(target)} --profile ${psQuote(profile)} @args\r\nexit $LASTEXITCODE\r\n`;
    writeFileSync(ps1Path, `\uFEFF${psText}`, 'utf8');
    files.push(cmdPath, ps1Path);
  } else {
    const shimPath = join(binDir, 'dsh-au-client-control');
    const relativeTarget = relative(binDir, target).split(sep).join('/');
    const script = `#!/bin/sh\nexec ${JSON.stringify(nodePath)} "$(dirname "$0")/${relativeTarget}" --profile ${JSON.stringify(profile)} "$@"\n`;
    writeFileSync(shimPath, script, { encoding: 'utf8', mode: 0o755 });
    chmodSync(shimPath, 0o755);
    files.push(shimPath);
  }
  return files;
}
