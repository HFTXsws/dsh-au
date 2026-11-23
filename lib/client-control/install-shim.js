import { chmodSync, lstatSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

function cmdQuote(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Replace an existing shim instead of writing through it.
 * npm/pnpm may have left `.bin/<name>` as a symlink to `lib/client-control/cli.js`;
 * writeFileSync would follow that link and overwrite the CLI source with this shim.
 */
function writeShimFile(path, content, options) {
  try {
    // lstat does not follow links, so a symlink (even a dangling one) is removed, never its target.
    if (!lstatSync(path).isDirectory()) unlinkSync(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  writeFileSync(path, content, options);
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
    writeShimFile(cmdPath, `@ECHO OFF\r\n${cmdQuote(nodePath)} ${cmdQuote(target)} --profile ${cmdQuote(profile)} %*\r\nEXIT /B %ERRORLEVEL%\r\n`, 'utf8');
    const psText = `$ErrorActionPreference = 'Stop'\r\n& ${psQuote(nodePath)} ${psQuote(target)} --profile ${psQuote(profile)} @args\r\nexit $LASTEXITCODE\r\n`;
    writeShimFile(ps1Path, `\uFEFF${psText}`, 'utf8');
    files.push(cmdPath, ps1Path);
  } else {
    const shimPath = join(binDir, 'dsh-au-client-control');
    const relativeTarget = relative(binDir, target).split(sep).join('/');
    const script = `#!/bin/sh\nexec ${JSON.stringify(nodePath)} "$(dirname "$0")/${relativeTarget}" --profile ${JSON.stringify(profile)} "$@"\n`;
    writeShimFile(shimPath, script, { encoding: 'utf8', mode: 0o755 });
    chmodSync(shimPath, 0o755);
    files.push(shimPath);
  }
  return files;
}
