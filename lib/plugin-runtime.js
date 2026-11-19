/** Read-only plugin runtime discovery and bounded, synchronous command execution. */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { TextDecoder } from 'node:util';

const PROBE_TIMEOUT = 5000;
const OUTPUT_LIMIT = 1024 * 1024;
const isScript = (value) => /\.(?:[cm]?js)$/i.test(value);
const isBatch = (value) => /\.(?:cmd|bat)$/i.test(value);
const isNode = (value) => /^node(?:\.exe)?$/i.test(path.basename(value));
const unique = (values) => [...new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
const envValue = (env, key) => Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] || '';
const bounded = (value, fallback, maximum) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;

/** Only return diagnostic text, never registry URL credentials or common query secrets. */
function redact(value) {
  return String(value || '')
    .replace(/(https?:\/\/)[^\s/]*@/gi, '$1[redacted]@')
    .replace(/([?&](?:access_token|token|api_key|password|secret)=)[^&\s]*/gi, '$1[redacted]');
}

function failure(code, message, extra = {}) {
  return { ok: false, code, error: redact(message), ...extra };
}

function fileExists(filename, executable = false, platform = process.platform) {
  try {
    if (!statSync(filename).isFile()) return false;
    accessSync(filename, executable && platform !== 'win32' ? constants.X_OK : constants.R_OK);
    return true;
  } catch { return false; }
}

/** Enumerate PATH ourselves: Windows must not accept an extensionless POSIX npm/pnpm shim. */
function pathCommands(name, env, platform) {
  const extensions = platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  return unique(envValue(env, 'PATH').split(platform === 'win32' ? ';' : ':').filter(Boolean).flatMap((directory) =>
    extensions.map((extension) => path.join(directory.replace(/^"|"$/g, ''), `${name}${extension}`)),
  )).filter((filename) => fileExists(filename, true, platform));
}

function nodeCommand(options) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  return unique([options.nodeCommand, env.DSH_NODE_BIN, options.execPath || process.execPath, ...pathCommands('node', env, platform)])
    .find((filename) => isNode(filename) && fileExists(filename, true, platform)) || '';
}

function systemEncoding(env, platform) {
  if (platform !== 'win32') return 'utf-8';
  // chcp is a read-only cmd builtin; it works without a complete desktop-host PATH.
  const cmd = envValue(env, 'ComSpec') || path.join(envValue(env, 'SystemRoot') || 'C:\\Windows', 'System32', 'cmd.exe');
  const probe = spawnSync(cmd, ['/d', '/s', '/c', 'chcp'], { env, encoding: null, timeout: 1000, windowsHide: true, maxBuffer: 4096 });
  const page = String(probe.stdout || '').match(/\b(\d{3,5})\b/)?.[1];
  return ({ 65001: 'utf-8', 936: 'gbk', 950: 'big5', 932: 'shift_jis', 949: 'euc-kr', 866: 'ibm866' })[page]
    || (/^125[0-8]$/.test(page || '') ? `windows-${page}` : 'utf-8');
}

function decode(bytes, encoding, fallback) {
  if (!bytes?.length) return '';
  if (encoding === 'auto') {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { encoding = fallback; }
  }
  try { return new TextDecoder(encoding).decode(bytes); } catch { return bytes.toString('utf8'); }
}

/** Standard npm/pnpm Windows shims are safer as Node CLI than through cmd parsing. */
function batchCli(command) {
  const name = path.basename(command, path.extname(command)).toLowerCase();
  if (!['pnpm', 'pnpx', 'npm', 'npx'].includes(name)) return '';
  const directory = path.dirname(command);
  const candidates = name.startsWith('pn')
    ? ['cjs', 'mjs'].flatMap((extension) => [path.join(directory, 'node_modules', 'pnpm', 'bin', `pnpm.${extension}`), path.join(directory, `pnpm.${extension}`)])
    : [path.join(directory, 'node_modules', 'npm', 'bin', `${name}-cli.js`)];
  return candidates.find((filename) => fileExists(filename)) || '';
}

/**
 * Execute with shell:false, capturing bytes before decoding. Arbitrary batch files use cmd
 * with outer /s quoting; expansion-sensitive quotes/percent/bang/newlines are rejected.
 * No file is created. A timed-out/failed command may already have changed its cwd.
 */
export function runPluginCommand(command, args = [], options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const base = { status: null, signal: null, stdout: '', stderr: '', timedOut: false, truncated: false, sideEffectsPossible: false };
  if (typeof command !== 'string' || !command || command.includes('\0') || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    return { ...base, ...failure('INVALID_COMMAND', '命令和参数必须是合法字符串') };
  }
  let executable = command;
  let commandArgs = [...args];
  let nativeNode = isNode(command);
  if (isScript(command) || (platform === 'win32' && isBatch(command) && batchCli(command))) {
    const cli = isScript(command) ? command : batchCli(command);
    executable = nodeCommand(options);
    if (!executable || !verifyNode(executable, env, platform, bounded(options.timeoutMs, PROBE_TIMEOUT, PROBE_TIMEOUT), process.arch)) {
      return { ...base, ...failure('NODE_NOT_FOUND', '脚本需要经验证的真实 Node.js，不能用 Electron 代替') };
    }
    commandArgs = [cli, ...args];
    nativeNode = true;
  }
  let windowsVerbatimArguments = false;
  if (platform === 'win32' && isBatch(executable)) {
    // cmd expands % even inside quotes, and embedded quotes re-open shell metacharacters.
    // Fail closed for those uncommon inputs instead of pretending generic shell escaping is safe.
    if ([executable, ...commandArgs].some((value) => /["%!\r\n\0]/.test(value)) || commandArgs.some((value) => value.endsWith('\\'))) {
      return { ...base, ...failure('UNSAFE_BATCH_ARGUMENT', '批处理参数含不能安全传递的引号、展开符、换行或尾反斜杠；请使用 Node CLI') };
    }
    const quoted = [executable, ...commandArgs].map((value) => `"${value}"`).join(' ');
    executable = envValue(env, 'ComSpec') || path.join(envValue(env, 'SystemRoot') || 'C:\\Windows', 'System32', 'cmd.exe');
    commandArgs = ['/d', '/v:off', '/s', '/c', `"${quoted}"`];
    windowsVerbatimArguments = true;
  }
  const maxOutputBytes = bounded(options.maxOutputBytes, OUTPUT_LIMIT, 16 * OUTPUT_LIMIT);
  let result;
  try {
    result = spawnSync(executable, commandArgs, {
      cwd: options.cwd, env, shell: false, windowsHide: true, windowsVerbatimArguments,
      encoding: null, timeout: bounded(options.timeoutMs, 120000, 2147483647), killSignal: 'SIGKILL', maxBuffer: maxOutputBytes,
    });
  } catch (error) {
    return { ...base, ...failure(error.code || 'COMMAND_FAILED', error.message) };
  }
  const truncated = result.error?.code === 'ENOBUFS' || (result.stdout?.length || 0) + (result.stderr?.length || 0) > maxOutputBytes;
  const stdoutBytes = result.stdout?.subarray(0, maxOutputBytes);
  const stderrBytes = result.stderr?.subarray(0, Math.max(0, maxOutputBytes - (stdoutBytes?.length || 0)));
  const encoding = options.outputEncoding === 'system' ? (options.systemEncoding || systemEncoding(env, platform))
    : options.outputEncoding || (nativeNode ? 'utf-8' : 'auto');
  const fallback = options.systemEncoding || (encoding === 'auto' && platform === 'win32' &&
    [stdoutBytes, stderrBytes].some((bytes) => { try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return false; } catch { return true; } })
    ? systemEncoding(env, platform) : 'utf-8');
  const stdout = redact(decode(stdoutBytes, encoding, fallback));
  const stderr = redact(decode(stderrBytes, encoding, fallback));
  const code = result.error?.code || (truncated ? 'OUTPUT_LIMIT' : result.status === 0 ? undefined : result.signal ? 'COMMAND_SIGNAL' : 'COMMAND_EXIT');
  return {
    ok: result.status === 0 && !result.error && !truncated, status: result.status, signal: result.signal, stdout, stderr,
    code, error: code ? redact(result.error?.message || stderr || `命令退出码 ${result.status ?? result.signal}`) : undefined,
    timedOut: code === 'ETIMEDOUT', truncated, sideEffectsPossible: Boolean(result.pid),
  };
}

/** Read executable paths only, never process command lines (which can contain secrets). */
function ancestorPaths(env, platform, timeoutMs) {
  if (platform === 'win32') {
    const powershell = unique([
      ...pathCommands('pwsh', env, platform),
      ...[envValue(env, 'ProgramW6432'), envValue(env, 'ProgramFiles')].filter(Boolean).map((root) => path.join(root, 'PowerShell', '7', 'pwsh.exe')),
    ]).find((filename) => fileExists(filename, true, platform))
      || path.join(envValue(env, 'SystemRoot') || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = `[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding; $id=${process.pid}; $paths=@(); for($i=0;$i -lt 8;$i++){ $p=Get-CimInstance Win32_Process -Filter "ProcessId=$id"; if(-not $p){break}; if($p.ExecutablePath){$paths+=$p.ExecutablePath}; $id=$p.ParentProcessId }; ConvertTo-Json -Compress -InputObject @($paths)`;
    const probeEnv = { ...env };
    if (/powershell\.exe$/i.test(powershell)) {
      // PS 7's inherited module path can break PS 5.1's built-in CIM import.
      for (const key of Object.keys(probeEnv)) if (key.toLowerCase() === 'psmodulepath') delete probeEnv[key];
    }
    const probe = runPluginCommand(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { env: probeEnv, platform, timeoutMs, maxOutputBytes: 16384, outputEncoding: 'utf-8' });
    try { const paths = JSON.parse(probe.stdout); return Array.isArray(paths) ? paths : []; } catch { return []; }
  }
  const paths = [];
  let pid = process.pid;
  for (let index = 0; index < 8 && pid > 1; index += 1) {
    if (platform === 'linux') {
      try { paths.push(realpathSync(`/proc/${pid}/exe`)); } catch { break; }
      try { pid = Number(readFileSync(`/proc/${pid}/status`, 'utf8').match(/^PPid:\s*(\d+)/m)?.[1]); } catch { break; }
    } else {
      const probe = runPluginCommand('/bin/ps', ['-p', String(pid), '-o', 'ppid=', '-o', 'comm='], { env, platform, timeoutMs, maxOutputBytes: 16384 });
      const match = probe.stdout.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) break;
      paths.push(match[2]); pid = Number(match[1]);
    }
  }
  return paths;
}

function resourceRoots(options, env, platform, timeoutMs) {
  const metadata = unique([
    ...(options.appRoots || []), env.DSH_APP_ROOT, env.DSH_RESOURCES_PATH, env.DSH_RUNTIME_ROOT,
    env.DSH_HOST_EXEC_PATH, env.DSH_EXEC_PATH, process.resourcesPath,
    options.execPath || process.execPath,
    ...(options.ancestorExecPaths === undefined ? ancestorPaths(env, platform, timeoutMs) : options.ancestorExecPaths),
  ]);
  const roots = [];
  for (const location of metadata) {
    let directory = fileExists(location) ? path.dirname(location) : location;
    // Installer location, resources location, app.asar and runtime node all lead to resources.
    for (let level = 0; level < 8; level += 1) {
      roots.push(directory, path.join(directory, 'resources'), path.join(directory, 'Contents', 'Resources'));
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return unique(roots).filter((root) => existsSync(root));
}

function readMetadata(filename) {
  if (!existsSync(filename)) return '';
  if (statSync(filename).size > OUTPUT_LIMIT) throw Object.assign(new Error(`兼容元数据过大: ${filename}`), { code: 'PROFILE_METADATA_INVALID' });
  return readFileSync(filename, 'utf8');
}

function scalar(text, key) {
  const value = text.match(new RegExp(`^${key}:[ \\t]*(.+)$`, 'm'))?.[1]?.trim() || '';
  // pnpm's top-level scalars are sufficient; do not implement a general YAML parser.
  if (value.startsWith('"')) { try { return JSON.parse(value); } catch { return ''; } }
  if (value.startsWith("'")) return value.endsWith("'") ? value.slice(1, -1).replace(/''/g, "'") : '';
  return value.replace(/[ \t]+#.*$/, '');
}

function profileRequirements(profileDir) {
  if (!profileDir) return {};
  const pkgText = readMetadata(path.join(profileDir, 'package.json'));
  const pkg = pkgText ? JSON.parse(pkgText) : {};
  const modulesText = readMetadata(path.join(profileDir, 'node_modules', '.modules.yaml'));
  const packageManager = typeof pkg.packageManager === 'string' ? pkg.packageManager : '';
  if (packageManager && !/^pnpm@\d+\.\d+\.\d+(?:[+-].*)?$/.test(packageManager)) {
    throw Object.assign(new Error('Profile packageManager 不是固定版本 pnpm，不能确认兼容性'), { code: 'PNPM_INCOMPATIBLE' });
  }
  // pnpm 11 writes JSON to .modules.yaml; older releases write ordinary YAML.
  const modules = modulesText.trimStart().startsWith('{') ? JSON.parse(modulesText) : null;
  const modulesManager = modules ? modules.packageManager : scalar(modulesText, 'packageManager');
  const storeDir = modules ? modules.storeDir : scalar(modulesText, 'storeDir');
  if (modulesText && (!/^pnpm@\d+\.\d+\.\d+(?:[+-].*)?$/.test(modulesManager) || !storeDir || !path.isAbsolute(storeDir))) {
    throw Object.assign(new Error('现有 .modules.yaml 缺少可靠 packageManager/storeDir；请先用宿主修复依赖'), { code: 'PNPM_INCOMPATIBLE' });
  }
  return { pinnedVersion: packageManager.slice(5).split('+')[0], modulesVersion: modulesManager.slice(5).split('+')[0], storeDir };
}

function verifyNode(command, env, platform, timeoutMs, arch) {
  if (!isNode(command) || !fileExists(command, true, platform)) return null;
  const probe = runPluginCommand(command, ['-p', 'JSON.stringify({node:process.versions.node,electron:process.versions.electron||"",arch:process.arch})'], {
    env, platform, timeoutMs, cwd: tmpdir(), outputEncoding: 'utf-8', maxOutputBytes: 16384,
  });
  try {
    const version = JSON.parse(probe.stdout);
    return probe.ok && !version.electron && /^\d+\.\d+\.\d+$/.test(version.node) && version.arch === arch ? version.node : null;
  } catch { return null; }
}

function samePath(left, right, platform) {
  const canonical = (value) => { try { return realpathSync(value); } catch { return path.resolve(value); } };
  return platform === 'win32' ? canonical(left).toLowerCase() === canonical(right).toLowerCase() : canonical(left) === canonical(right);
}

/** Resolve Node independently: local-plugin installers must not require pnpm. */
export function resolvePluginNode(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const timeoutMs = bounded(options.timeoutMs, PROBE_TIMEOUT, 30000);
  const nodeName = platform === 'win32' ? 'node.exe' : 'node';
  const roots = resourceRoots(options, env, platform, timeoutMs);
  const bundled = roots.flatMap((root) => [
    path.join(root, 'runtime', arch, 'primary-runtime', 'dependencies', 'node', 'bin', nodeName),
    path.join(root, 'dependencies', 'node', 'bin', nodeName),
    ...(path.basename(root) === 'dependencies' ? [path.join(root, 'node', 'bin', nodeName)] : []),
  ]);
  for (const command of unique([...bundled, env.DSH_NODE_BIN, ...(options.nodeCandidates || []), options.execPath || process.execPath, ...pathCommands('node', env, platform)])) {
    const nodeVersion = verifyNode(command, env, platform, timeoutMs, arch);
    if (nodeVersion) return { ok: true, command, nodeVersion };
  }
  return failure('NODE_NOT_FOUND', '找不到当前架构的真实 Node.js；Electron 不能作为插件安装 Node');
}

/**
 * Resolve a verified Node + pnpm pair, or an already installed external pnpm. Never
 * bootstrap npm/corepack, download, install, or write Profile/config during discovery.
 * appRoots accepts install/resource/runtime roots; ancestorExecPaths:[] disables OS probing.
 */
export function resolvePluginRuntime(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const timeoutMs = bounded(options.timeoutMs, PROBE_TIMEOUT, 30000);
  const home = options.homeDir || homedir();
  let requirements;
  try { requirements = profileRequirements(options.profileDir); } catch (error) { return failure(error.code || 'PROFILE_METADATA_INVALID', error.message); }
  const roots = resourceRoots(options, env, platform, timeoutMs);
  const nodeName = platform === 'win32' ? 'node.exe' : 'node';
  const bundled = [];
  const bundledNodes = [];
  for (const root of roots) {
    // DSH ships per-architecture primary runtimes on all supported desktop platforms.
    const runtime = path.join(root, 'runtime', arch, 'primary-runtime', 'dependencies');
    const directRuntime = path.basename(root) === 'dependencies' ? root : path.join(root, 'dependencies');
    for (const dependencies of [runtime, directRuntime]) {
      const node = path.join(dependencies, 'node', 'bin', nodeName);
      const pnpm = path.join(dependencies, 'pnpm', 'bin', 'pnpm.cjs');
      if (fileExists(node, true, platform)) bundledNodes.push(node);
      if (fileExists(pnpm)) bundled.push({ pnpm, node, source: 'bundled' });
    }
    const unpacked = path.join(root, 'app.asar.unpacked', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
    if (fileExists(unpacked)) bundled.push({ pnpm: unpacked, source: 'bundled' });
  }
  const nodes = unique([...bundledNodes, env.DSH_NODE_BIN, ...(options.nodeCandidates || []), options.execPath || process.execPath, ...pathCommands('node', env, platform)]);
  const nodeVersions = new Map();
  const selectNode = (preferred) => {
    for (const command of unique([preferred, ...nodes])) {
      if (!nodeVersions.has(command)) nodeVersions.set(command, verifyNode(command, env, platform, timeoutMs, arch));
      if (nodeVersions.get(command)) return { command, version: nodeVersions.get(command) };
    }
    return null;
  };
  const external = unique([
    ...(options.pnpmCandidates || []), ...pathCommands('pnpm', env, platform),
    ...(platform === 'win32'
      ? [path.join(home, 'AppData', 'Roaming', 'npm', 'pnpm.cmd'), path.join(home, 'AppData', 'Local', 'pnpm', 'pnpm.exe'), path.join(home, 'AppData', 'Local', 'pnpm', 'pnpm.cmd')]
      : [path.join(home, '.local', 'share', 'pnpm', 'pnpm'), path.join(home, 'Library', 'pnpm', 'pnpm'), '/opt/homebrew/bin/pnpm', '/usr/local/bin/pnpm']),
  ]);
  // An explicit override is a user choice, not a hint to silently ignore on failure.
  const candidates = env.DSH_PNPM_BIN
    ? [{ pnpm: env.DSH_PNPM_BIN.trim(), source: 'override' }]
    : [...bundled, ...external.map((pnpm) => ({ pnpm, source: 'external' }))];
  const seen = new Set();
  let lastFailure = failure('PNPM_NOT_FOUND', '找不到经验证的内置或外部 pnpm；不会自动运行 npm exec 下载最新版');
  // Prevent corepack/pnpm self-management from downloading a packageManager version during probes.
  const probeEnv = { ...env, COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_AUTO_PIN: '0', npm_config_manage_package_manager_versions: 'false' };
  for (const candidate of candidates) {
    if (seen.has(candidate.pnpm) || !fileExists(candidate.pnpm, !isScript(candidate.pnpm), platform)) continue;
    seen.add(candidate.pnpm);
    if (platform === 'win32' && !/\.(?:exe|cmd|bat|[cm]?js)$/i.test(candidate.pnpm)) continue;
    let resolved = candidate.pnpm;
    try { resolved = realpathSync(candidate.pnpm); } catch {}
    const cli = isScript(resolved) ? resolved : isBatch(candidate.pnpm) ? batchCli(candidate.pnpm) : '';
    if (/[\\/]corepack[\\/]/i.test(resolved)) {
      lastFailure = failure('PNPM_UNVERIFIED_SHIM', '拒绝 corepack pnpm 引导入口'); continue;
    }
    // A corepack wrapper is not an installed pnpm and could fetch a version. Do not run it.
    if (isBatch(candidate.pnpm) && !cli) {
      lastFailure = failure('PNPM_UNVERIFIED_SHIM', 'pnpm 批处理未找到已安装 Node CLI；拒绝潜在 corepack 下载入口'); continue;
    }
    if (!cli && !/\.exe$/i.test(candidate.pnpm)) {
      let wrapper = '';
      try { if (statSync(candidate.pnpm).size < 65536) wrapper = readFileSync(candidate.pnpm, 'utf8'); } catch {}
      if (/corepack/i.test(wrapper)) { lastFailure = failure('PNPM_UNVERIFIED_SHIM', '拒绝 corepack pnpm 引导入口'); continue; }
    }
    const node = selectNode(candidate.node);
    if (!node) { lastFailure = failure('NODE_NOT_FOUND', '找不到当前架构的真实 Node.js；Electron 不能作为插件安装 Node'); continue; }
    const invocation = { command: cli ? node.command : candidate.pnpm, args: cli ? [cli] : [], source: candidate.source, nodeVersion: node.version };
    const probe = runPluginCommand(invocation.command, [...invocation.args, '--version'], { env: probeEnv, platform, timeoutMs, cwd: tmpdir(), maxOutputBytes: 16384 });
    const version = probe.stdout.trim();
    if (!probe.ok || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
      lastFailure = failure(probe.code || 'PNPM_VERSION_INVALID', probe.error || '无法核验 pnpm 版本'); continue;
    }
    if ((requirements.pinnedVersion && requirements.pinnedVersion !== version) ||
      (requirements.modulesVersion && requirements.modulesVersion.split('.')[0] !== version.split('.')[0])) {
      lastFailure = failure('PNPM_INCOMPATIBLE', `pnpm ${version} 不兼容 Profile ${requirements.pinnedVersion || requirements.modulesVersion}`); continue;
    }
    if (requirements.storeDir) {
      const store = runPluginCommand(invocation.command, [...invocation.args, 'store', 'path', '--silent'], {
        env: probeEnv, platform, timeoutMs, cwd: options.profileDir, maxOutputBytes: 16384,
      });
      if (!store.ok || !path.isAbsolute(store.stdout.trim()) || !samePath(store.stdout.trim(), requirements.storeDir, platform)) {
        lastFailure = failure('PNPM_STORE_INCOMPATIBLE', `pnpm ${version} 的 store 与现有 .modules.yaml 不一致；不会修改现有依赖`); continue;
      }
    }
    return { ok: true, ...invocation, pnpmVersion: version };
  }
  return lastFailure;
}
