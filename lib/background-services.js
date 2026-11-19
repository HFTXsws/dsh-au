import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { homedir, hostname, tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { PLUGIN_ROOT } from './sync-repo.js';
import { readCloudManifest } from './cloud-manifest.js';
import { applyLocalBinding, expandLocalPath, loadLocalBindings, restrictServiceControl } from './local-bindings.js';
import { appendServiceEvent, readServiceEvents } from './service-event-log.js';

function readUserControllerRoot() {
  try {
    const dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh');
    const cfgPath = process.env.DSH_AU_CONFIG_PATH || path.join(dshHome, 'dsh-au.config.json');
    if (!existsSync(cfgPath)) return '';
    const raw = JSON.parse(readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
    const preferred = typeof raw?.controllerRoot === 'string' ? raw.controllerRoot.trim() : '';
    if (preferred) return preferred;
    return typeof raw?.auwinRoot === 'string' ? raw.auwinRoot.trim() : '';
  } catch {
    return '';
  }
}

function controllerRootFromNearbyFile(filePath) {
  const resolved = expandLocalPath(filePath);
  if (!resolved) return '';
  let dir = path.dirname(resolved);
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(path.join(dir, 'backend', 'lanmiao', 'background_services.py'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '';
}

function inferControllerRootFromBindings() {
  try {
    const bound = loadLocalBindings().services || {};
    const files = [
      bound.cursor_workers?.configPath,
      bound.cursor_workers?.scriptPath,
      bound.auwin?.scriptPath,
    ];
    for (const filePath of files) {
      const root = controllerRootFromNearbyFile(filePath);
      if (root) return root;
    }
  } catch {
    return '';
  }
  return '';
}

/** 通用控制器目录：环境变量 DSH_AU_CONTROLLER_ROOT / 配置 controllerRoot 优先，兼容 DSH_AU_AUWIN_ROOT / auwinRoot 与脚本路径推断。 */
export function resolveControllerRoot() {
  const fromEnv = String(process.env.DSH_AU_CONTROLLER_ROOT || process.env.DSH_AU_AUWIN_ROOT || '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  const fromCfg = readUserControllerRoot();
  if (fromCfg) {
    const resolved = fromCfg === '~' ? homedir()
      : (fromCfg.startsWith('~/') || fromCfg.startsWith('~\\')) ? path.join(homedir(), fromCfg.slice(2))
        : fromCfg;
    return path.resolve(resolved);
  }
  return inferControllerRootFromBindings();
}

/** 兼容别名：保留给已有调用方。 */
export function resolveAuWinRoot() {
  return resolveControllerRoot();
}

function controllerRoot() {
  return resolveControllerRoot();
}

function hasControllerModuleAvailable() {
  const root = controllerRoot();
  if (!root) return false;
  return existsSync(path.join(root, 'backend', 'lanmiao', 'background_services.py'));
}

/** 内置目录为空：服务定义全部来自 machines/<machineId>.json 与云清单。 */
export const SERVICES_CATALOG = [];

/** 目录默认路径按 <ControllerParent>（兼容 <AuOS>）解析；本机覆盖优先，Windows 环境变量只在 win32 展开。 */
export function resolveServiceConfigPath(configPath, override = '') {
  if (override) return String(override);
  const root = controllerRoot();
  const parentDir = root ? path.dirname(root) : '';
  let resolved = String(configPath || '').replace(/<ControllerParent>|<AuOS>/g, parentDir);
  resolved = resolved.replace(/^~(?=\/|$)/, homedir());
  if (process.platform === 'win32') {
    resolved = resolved
      .replace(/%USERPROFILE%/gi, homedir())
      .replace(/%LOCALAPPDATA%/gi, process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'))
      .replace(/%APPDATA%/gi, process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'))
      .replace(/\//g, '\\');
  }
  return resolved;
}

/** 解析外部平台控制器虚拟环境 Python 路径（不存在时回退系统 python；windowless=true 时优先 pythonw.exe） */
export function resolveControllerPython({ windowless = false } = {}) {
  const root = controllerRoot();
  if (windowless && process.platform === 'win32') {
    const venvPyw = path.join(root, 'venv', 'Scripts', 'pythonw.exe');
    if (root && existsSync(venvPyw)) return venvPyw;
  }
  const venvPy = path.join(root, 'venv', 'Scripts', 'python.exe');
  if (root && existsSync(venvPy)) return venvPy;
  // macOS / Linux 用 venv/bin，避免落到没装 psutil 的系统 python3。
  const posixVenvPy = path.join(root, 'venv', 'bin', 'python3');
  if (root && existsSync(posixVenvPy)) return posixVenvPy;
  const posixVenvPy2 = path.join(root, 'venv', 'bin', 'python');
  if (root && existsSync(posixVenvPy2)) return posixVenvPy2;
  return process.platform === 'win32' ? 'python' : 'python3';
}

/** 兼容别名：保留给已有调用方。 */
export function resolveAuWinPython(options = {}) {
  return resolveControllerPython(options);
}

/**
 * Windows 工作区可能继承 Low Integrity：直接运行其中的 venv 启动器会使控制器降到 Low，
 * 即使用户有完整权限也写不了普通 Temp/Worker 数据目录。使用 venv 登记的基础解释器，
 * 并沿用 Python 自身的虚拟环境启动协议；不改 ACL、不提权，受限父进程仍保持受限。
 */
export function resolveControllerPythonLaunch({
  windowless = false,
  pythonPath = resolveControllerPython({ windowless }),
  platformOs = process.platform,
  env = process.env,
} = {}) {
  const childEnv = { ...env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  // 不让外层 Python 启动器的标识污染本次控制器的虚拟环境。
  delete childEnv.__PYVENV_LAUNCHER__;
  if (platformOs === 'win32' && /^pythonw?\.exe$/i.test(path.basename(pythonPath))) {
    const configPath = path.resolve(path.dirname(pythonPath), '..', 'pyvenv.cfg');
    try {
      const config = readFileSync(configPath, 'utf8');
      const home = config.match(/^\s*home\s*=\s*(.+?)\s*$/mi)?.[1];
      if (home) {
        const basePython = path.join(home, path.basename(pythonPath));
        if (existsSync(basePython)) {
          childEnv.__PYVENV_LAUNCHER__ = pythonPath;
          return { command: basePython, env: childEnv };
        }
      }
    } catch { /* 不完整的 venv 保留原有启动方式，交给控制器报告实际错误。 */ }
  }
  return { command: pythonPath, env: childEnv };
}

/** 兼容别名：保留给已有调用方。 */
export function resolveAuWinPythonLaunch(options = {}) {
  return resolveControllerPythonLaunch(options);
}

/** 轻量探测本机回环 TCP 端口是否处于监听状态 */
export function probeTcpPort(port, timeoutMs = 450) {
  if (!port) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** 只比 hostname 第一段，忽略大小写和 .local。 */
export function normalizeWorkerHost(name) {
  let host = String(name || '').trim().toLowerCase().replace(/\.+$/, '');
  if (host.endsWith('.local')) host = host.slice(0, -6);
  return host.split('.')[0] || '';
}

/** 按 machines[hostname].prefix 选本机 Worker 前缀；没有则退回顶层 prefix。 */
export function resolveCursorWorkerPrefix(raw, hostnames = []) {
  const machines = raw && typeof raw === 'object' ? raw.machines : null;
  if (machines && typeof machines === 'object') {
    const candidates = new Set((hostnames || []).map(normalizeWorkerHost).filter(Boolean));
    for (const [name, spec] of Object.entries(machines)) {
      if (!candidates.has(normalizeWorkerHost(name))) continue;
      const prefix = String(spec?.prefix || '').trim();
      if (prefix) return prefix;
    }
  }
  return String(raw?.prefix || '').trim();
}

/** 认 agent/node 拉起的 worker --name <prefix>[-repo]，不认 debug。 */
export function isManagedCursorWorkerCommand(command, prefix) {
  const args = String(command || '');
  const low = args.toLowerCase();
  if (!low.includes('worker') || low.includes('debug')) return false;
  if (!/(?:^|[\\/\s])(?:agent|node(?:\.exe)?)(?:\s|$)/i.test(args)) return false;
  const match = args.match(/--name(?:=|\s+)(\S+)/);
  if (!match || !prefix) return false;
  const name = match[1].replace(/^['"]|['"]$/g, '');
  return name === prefix || name.startsWith(`${prefix}-`);
}

function loadCursorWorkersConfig() {
  const bound = (() => {
    try { return loadLocalBindings().services?.cursor_workers || {}; }
    catch { return {}; }
  })();
  const candidates = [
    expandLocalPath(bound.configPath || ''),
    bound.scriptPath ? path.join(path.dirname(expandLocalPath(bound.scriptPath)), 'cursor_workers.json') : '',
    controllerRoot() ? path.join(controllerRoot(), 'backend', 'scripts', 'system', 'cursor_workers.json') : '',
  ];
  for (const filePath of candidates) {
    if (!filePath || !existsSync(filePath)) continue;
    try {
      return JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }
  }
  return {};
}

export function formatCursorWorkerNames(instances) {
  return (instances || []).map((item) => item?.name).filter(Boolean).join(', ');
}

/** 从 Windows CIM 结果中筛出受管 Cursor Worker；测试可直接注入 nodeProcesses。 */
export function cursorWorkerInstancesFromNodeProcesses(nodeProcesses, prefix) {
  if (!prefix || !Array.isArray(nodeProcesses)) return [];
  return nodeProcesses
    .filter((item) => isManagedCursorWorkerCommand(item?.commandLine, prefix))
    .map((item) => {
      const match = String(item?.commandLine || '').match(/--name(?:=|\s+)(\S+)/);
      return {
        pid: Number(item?.pid) || 0,
        name: match ? match[1].replace(/^['"]|['"]$/g, '') : '',
      };
    })
    .filter((item) => item.name);
}

/** Windows 的受限 Python 子进程可能看不到宿主的 node.exe；CIM 是该场景的进程事实来源。 */
function listWindowsNodeProcesses() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Select-Object @{n='pid';e={$_.ProcessId}}, @{n='commandLine';e={$_.CommandLine}} | ConvertTo-Json -Compress",
  ].join('; ');
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 8_000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { out += chunk; });
    const finish = (items) => {
      clearTimeout(timer);
      resolve(Array.isArray(items) ? items : null);
    };
    child.on('error', () => finish(null));
    child.on('close', () => {
      try {
        const parsed = JSON.parse(out.trim() || '[]');
        finish(Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []));
      } catch {
        finish(null);
      }
    });
  });
}

/** 用外部平台控制器的 list_managed_worker_pids 列本机 Worker；Windows 优先 CIM，避免 psutil 的假阴性。 */
export function listCursorWorkerInstances(options = {}) {
  if (Array.isArray(options.instances)) return Promise.resolve(options.instances);
  const prefix = options.prefix || resolveCursorWorkerPrefix(
    options.config || loadCursorWorkersConfig(),
    options.hostnames || [hostname(), process.env.COMPUTERNAME, process.env.HOSTNAME],
  );
  if (!prefix) return Promise.resolve([]);
  if (Array.isArray(options.commands)) {
    return Promise.resolve(cursorWorkerInstancesFromNodeProcesses(
      options.commands.map((command) => ({ commandLine: command })), prefix,
    ));
  }
  if (Array.isArray(options.nodeProcesses)) {
    return Promise.resolve(cursorWorkerInstancesFromNodeProcesses(options.nodeProcesses, prefix));
  }
  if (process.platform === 'win32') {
    return listWindowsNodeProcesses().then((items) => {
      if (items) return cursorWorkerInstancesFromNodeProcesses(items, prefix);
      return listCursorWorkerInstancesViaPython();
    });
  }
  return listCursorWorkerInstancesViaPython();
}

/** 非 Windows 或 CIM 不可用时，保留外部平台控制器 psutil 扫描作为兜底。 */
function listCursorWorkerInstancesViaPython() {
  return new Promise((resolve) => {
    const python = resolveControllerPythonLaunch();
    const code = 'import json; from backend.scripts.system.cursor_worker import list_managed_worker_pids; print(json.dumps([{"pid": pid, "name": name} for pid, name in list_managed_worker_pids()], ensure_ascii=True))';
    const child = spawn(python.command, ['-X', 'utf8', '-c', code], {
      cwd: controllerRoot() || undefined,
      env: python.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
    }, 8000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { out += chunk; });
    const finish = (items) => {
      clearTimeout(timer);
      resolve(Array.isArray(items) ? items : []);
    };
    child.on('error', () => finish([]));
    child.on('close', () => {
      try {
        const parsed = JSON.parse(out.trim().split(/\r?\n/).pop() || '[]');
        finish(parsed);
      } catch {
        finish([]);
      }
    });
  });
}

export async function probeCursorWorkersAlive(options = {}) {
  const instances = await listCursorWorkerInstances(options);
  return instances.length > 0;
}

export const CLOUDFLARED_LAUNCHD_LABEL = 'system/com.cloudflare.cloudflared';
export const CLOUDFLARED_PLIST = '/Library/LaunchDaemons/com.cloudflare.cloudflared.plist';
export const CLOUDFLARED_ADMIN_REQUIRED = 'Cloudflare 隧道启停需要管理员权限。先找我授权，不要静默弹密码框。';
export const CLOUDFLARED_BOOT_ADMIN_REQUIRED = 'Cloudflare 开机自启要加载系统 LaunchDaemon，需要管理员权限。先找我授权，不要静默弹密码框。';

/** 只认真正在跑隧道的进程，排除 brew/help/list。 */
export function isManagedCloudflaredCommand(command) {
  const low = String(command || '').toLowerCase();
  if (!low.includes('cloudflared')) return false;
  if (low.includes('brew services')) return false;
  return low.includes('tunnel') && /(?:^|[\s/])run(?:\s|$)/.test(low);
}

export function listCloudflaredInstances(options = {}) {
  if (Array.isArray(options.instances)) return Promise.resolve(options.instances);
  if (Array.isArray(options.commands)) {
    return Promise.resolve(options.commands
      .filter((command) => isManagedCloudflaredCommand(command))
      .map((command, index) => ({ pid: index + 1, command })));
  }
  return new Promise((resolve) => {
    const child = spawn('ps', ['-ax', '-o', 'pid=,command='], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
    }, 4000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { out += chunk; });
    const finish = (items) => {
      clearTimeout(timer);
      resolve(Array.isArray(items) ? items : []);
    };
    child.on('error', () => finish([]));
    child.on('close', () => {
      const items = String(out).split(/\r?\n/).map((line) => {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        if (!match || !isManagedCloudflaredCommand(match[2])) return null;
        return { pid: Number(match[1]), command: match[2] };
      }).filter(Boolean);
      finish(items);
    });
  });
}

export async function probeCloudflaredAlive(options = {}) {
  const instances = await listCloudflaredInstances(options);
  return instances.length > 0;
}

/** 命令行是否包含绑定登记的进程特征；特征按字面子串比较，空特征一律不匹配。 */
export function matchesProcessPattern(command, pattern) {
  const needle = typeof pattern === 'string' ? pattern.trim() : '';
  return Boolean(needle) && String(command || '').includes(needle);
}

/** macOS / Linux 用 pgrep -f 探测登记了 processPattern 的无端口进程；Windows 不走这条通路。 */
export async function probeProcessPatternAlive(pattern) {
  const needle = typeof pattern === 'string' ? pattern.trim() : '';
  if (!needle || process.platform === 'win32') return false;
  return new Promise((resolve) => {
    // `--` 防止以 - 开头的特征被 pgrep 当成选项。
    const child = spawn('pgrep', ['-f', '--', needle], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve(false);
    }, 3000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

function isLaunchctlPrivilegeError(text) {
  const low = String(text || '').toLowerCase();
  return /not privileged|permission denied|must be root|operation not permitted|input\/output error|could not find service/.test(low);
}

function isLaunchctlMissing(text) {
  return /could not find service/i.test(String(text || ''));
}

function isLaunchctlAlreadyLoaded(text) {
  return /already (?:loaded|bootstrapped|exists)/i.test(String(text || ''));
}

function defaultRunLaunchctl(action) {
  const args = action === 'bootout'
    ? ['bootout', CLOUDFLARED_LAUNCHD_LABEL]
    : action === 'bootstrap'
      ? ['bootstrap', 'system', CLOUDFLARED_PLIST]
      : action === 'print'
        ? ['print', CLOUDFLARED_LAUNCHD_LABEL]
        : ['kickstart', '-k', CLOUDFLARED_LAUNCHD_LABEL];
  return new Promise((resolve) => {
    const child = spawn('/bin/launchctl', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { out += chunk; });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => {
      resolve({ ok: false, needsAdmin: true, error: error.message });
    });
    child.on('close', (code) => {
      const detail = `${err}
${out}`.trim();
      if (code === 0 || isLaunchctlAlreadyLoaded(detail)) {
        resolve({ ok: true, error: '', stdout: out });
        return;
      }
      resolve({
        ok: false,
        missing: isLaunchctlMissing(detail),
        needsAdmin: isLaunchctlPrivilegeError(detail) || code === 1,
        error: detail || `launchctl ${args[0]} 退出码 ${code}`,
      });
    });
  });
}

/** 用户态先试 launchctl；没权限就停，绝不自己弹管理员密码。 */
export async function controlCloudflaredService(action, options = {}) {
  const list = options.listInstances || listCloudflaredInstances;
  const runLaunchctl = options.runLaunchctl || defaultRunLaunchctl;
  const instances = await list();
  if (action === 'start' && instances.length) {
    return {
      ok: true,
      skipped: true,
      message: `已在运行 ${instances.length} 个 cloudflared。未重复启动`,
      error: '',
      instances,
    };
  }
  if (action === 'stop' && !instances.length) {
    return { ok: true, skipped: true, message: '隧道未运行', error: '', instances: [] };
  }
  const launchAction = action === 'stop' ? 'bootout' : 'kickstart';
  let result = await runLaunchctl(launchAction);
  if (!result.ok && action !== 'stop') {
    result = await runLaunchctl('bootstrap');
  }
  if (!result.ok) {
    return {
      ok: false,
      needsAdmin: Boolean(result.needsAdmin),
      error: result.needsAdmin ? CLOUDFLARED_ADMIN_REQUIRED : (result.error || 'cloudflared 控制失败'),
      instances,
    };
  }
  const after = await list();
  if (action === 'stop') {
    return { ok: true, message: '已请求停止 Cloudflare 隧道', error: '', instances: after };
  }
  if (action !== 'stop' && !after.length && !options.allowEmptyAfterStart) {
    return { ok: false, needsAdmin: true, error: CLOUDFLARED_ADMIN_REQUIRED, instances: after };
  }
  return { ok: true, message: action === 'restart' ? '已请求重启 Cloudflare 隧道' : '已请求启动 Cloudflare 隧道', error: '', instances: after };
}

/** 把开机自启落到官方 system LaunchDaemon；没权限就停，不弹管理员密码。 */
export async function syncCloudflaredBootDaemon(wanted, options = {}) {
  const runLaunchctl = options.runLaunchctl || defaultRunLaunchctl;
  const wantBoot = Boolean(wanted);
  if (wantBoot) {
    const printed = await runLaunchctl('print');
    if (printed.ok) {
      return { ok: true, wanted: true, loaded: true, needsAdmin: false, error: '' };
    }
    const boot = await runLaunchctl('bootstrap');
    if (boot.ok) {
      return { ok: true, wanted: true, loaded: true, needsAdmin: false, error: '' };
    }
    return {
      ok: false,
      wanted: true,
      loaded: false,
      needsAdmin: Boolean(boot.needsAdmin),
      error: boot.needsAdmin ? CLOUDFLARED_BOOT_ADMIN_REQUIRED : (boot.error || 'cloudflared 开机项同步失败'),
    };
  }
  const printed = await runLaunchctl('print');
  if (!printed.ok && (printed.missing || isLaunchctlMissing(printed.error))) {
    return { ok: true, wanted: false, loaded: false, needsAdmin: false, error: '' };
  }
  const out = await runLaunchctl('bootout');
  if (out.ok || out.missing || isLaunchctlMissing(out.error)) {
    return { ok: true, wanted: false, loaded: false, needsAdmin: false, error: '' };
  }
  return {
    ok: false,
    wanted: false,
    loaded: Boolean(printed.ok),
    needsAdmin: Boolean(out.needsAdmin),
    error: out.needsAdmin ? CLOUDFLARED_BOOT_ADMIN_REQUIRED : (out.error || 'cloudflared 开机项关闭失败'),
  };
}

/** 开源仓不再内置个人 LaunchAgent 指纹；由本机绑定的 launcher.label / scriptPath 解析。 */
export const MACOS_USER_LAUNCHD_CONTROLS = {};

function launchAgentLabel(text) {
  const match = String(text || '').match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/);
  return match ? match[1].trim() : '';
}

function loadBindingsMap(hostname) {
  try {
    return loadLocalBindings(hostname).services || {};
  } catch {
    return {};
  }
}

export function resolveMacUserLaunchdTarget(serviceId, options = {}) {
  const spec = MACOS_USER_LAUNCHD_CONTROLS[serviceId] || {};
  const bindings = options.bindings || loadBindingsMap(options.hostname);
  const bound = bindings?.[serviceId] || {};
  const needle = spec.needle || String(bound.scriptPath || '').trim();
  const fallbackLabel = spec.fallbackLabel || String(bound.launcher?.label || '').trim();
  if (!needle && !fallbackLabel) {
    return { ok: false, error: `macOS 未登记用户 LaunchAgent: ${serviceId}` };
  }
  const dir = options.launchAgentsDir || path.join(homedir(), 'Library', 'LaunchAgents');
  if (needle && existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.plist')) continue;
      const filePath = path.join(dir, name);
      let text = '';
      try { text = readFileSync(filePath, 'utf8'); } catch { continue; }
      if (!text.includes(needle)) continue;
      const label = launchAgentLabel(text);
      if (!label) continue;
      return { ok: true, serviceId, label, plistPath: filePath, discovered: true };
    }
  }
  if (!fallbackLabel) {
    return { ok: false, error: `未找到 ${serviceId} 的用户 LaunchAgent` };
  }
  return {
    ok: true,
    serviceId,
    label: fallbackLabel,
    plistPath: path.join(dir, `${fallbackLabel}.plist`),
    discovered: false,
  };
}

function ensureMacUserLaunchdPlist(target) {
  if (existsSync(target.plistPath)) return { ok: true, created: false };
  return { ok: false, error: `缺少 ${target.serviceId} 的 LaunchAgent：${target.plistPath}` };
}

function defaultRunUserLaunchctl(action, target, options = {}) {
  const uid = options.uid || process.getuid?.();
  if (!uid) return Promise.resolve({ ok: false, error: '无法解析当前用户 UID' });
  const domainLabel = `gui/${uid}/${target.label}`;
  const args = action === 'bootout'
    ? ['bootout', domainLabel]
    : action === 'bootstrap'
      ? ['bootstrap', `gui/${uid}`, target.plistPath]
      : action === 'print'
        ? ['print', domainLabel]
        : ['kickstart', '-k', domainLabel];
  return new Promise((resolve) => {
    const child = spawn('/bin/launchctl', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { out += chunk; });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => resolve({ ok: false, error: error.message }));
    child.on('close', (code) => {
      const detail = `${err}\n${out}`.trim();
      if (code === 0 || isLaunchctlAlreadyLoaded(detail)) {
        resolve({ ok: true, error: '', stdout: out });
        return;
      }
      resolve({
        ok: false,
        missing: isLaunchctlMissing(detail),
        error: detail || `launchctl ${args[0]} 退出码 ${code}`,
      });
    });
  });
}

export async function controlMacUserLaunchdService(serviceId, action, options = {}) {
  const target = resolveMacUserLaunchdTarget(serviceId, options);
  if (!target.ok) return { ok: false, error: target.error };
  const ensured = ensureMacUserLaunchdPlist(target);
  if (!ensured.ok) return { ok: false, error: ensured.error };
  const runLaunchctl = options.runLaunchctl || ((nextAction) => defaultRunUserLaunchctl(nextAction, target, options));
  if (action === 'stop') {
    const out = await runLaunchctl('bootout');
    if (out.ok || out.missing || isLaunchctlMissing(out.error)) {
      return { ok: true, message: `已请求停止 ${serviceId}`, error: '' };
    }
    return { ok: false, error: out.error || `停止 ${serviceId} 失败` };
  }
  const printed = await runLaunchctl('print');
  if (!printed.ok) {
    const boot = await runLaunchctl('bootstrap');
    if (!boot.ok && !isLaunchctlAlreadyLoaded(boot.error)) {
      return { ok: false, error: boot.error || `加载 ${serviceId} LaunchAgent 失败` };
    }
  }
  if (action === 'start' && printed.ok) {
    return { ok: true, skipped: true, message: `${serviceId} 已由 LaunchAgent 托管`, error: '' };
  }
  const kicked = await runLaunchctl('kickstart');
  if (!kicked.ok) return { ok: false, error: kicked.error || `启动 ${serviceId} 失败` };
  return { ok: true, message: action === 'restart' ? `已请求重启 ${serviceId}` : `已请求启动 ${serviceId}`, error: '' };
}

async function decorateCursorWorkers(list, options = {}) {
  const instances = await listCursorWorkerInstances(options);
  const names = formatCursorWorkerNames(instances);
  return (list || []).map((svc) => {
    if (svc.id !== 'cursor_workers') return svc;
    const running = instances.length > 0;
    return {
      ...svc,
      running,
      status: running ? 'healthy' : 'stopped',
      reason: running ? `已发现 ${instances.length} 个 Worker: ${names}` : '未发现本机前缀 Worker 进程',
      instances,
    };
  });
}

/** Remote Desktop Commander 无监听端口；Windows 上也必须绕开受限 Python 的 node 进程枚举。 */
export function isManagedRemoteDesktopCommand(command) {
  const low = String(command || '').replaceAll('\\', '/').toLowerCase();
  return low.includes('/@wonderwhy-er/desktop-commander/dist/index.js')
    && /(?:^|\s)remote(?:\s|$)/.test(low);
}

export function remoteDesktopInstancesFromNodeProcesses(nodeProcesses) {
  if (!Array.isArray(nodeProcesses)) return [];
  return nodeProcesses
    .filter((item) => isManagedRemoteDesktopCommand(item?.commandLine))
    .map((item) => ({ pid: Number(item?.pid) || 0 }))
    .filter((item) => item.pid > 0);
}

function decorateWindowsRemoteDesktop(list, nodeProcesses) {
  if (!Array.isArray(nodeProcesses)) return list;
  const instances = remoteDesktopInstancesFromNodeProcesses(nodeProcesses);
  return (list || []).map((svc) => {
    if (svc.id !== 'remote') return svc;
    const running = instances.length > 0;
    return {
      ...svc,
      running,
      status: running ? 'healthy' : 'stopped',
      reason: running ? `已发现 ${instances.length} 个 Remote Desktop Commander 进程` : '未发现对应进程',
      instances,
    };
  });
}

async function decorateCloudflared(list) {
  // Windows 下 cloudflared 不走 ps 进程枚举，直接跳过避免无意义的子进程开销
  if (process.platform === 'win32') return list;
  const instances = await listCloudflaredInstances();
  const pids = instances.map((item) => item?.pid).filter(Boolean).join(', ');
  return (list || []).map((svc) => {
    if (svc.id !== 'cloudflared') return svc;
    const running = instances.length > 0;
    return {
      ...svc,
      running,
      status: running ? 'healthy' : 'stopped',
      reason: running ? `已发现 cloudflared tunnel run: pid ${pids}` : '未发现 cloudflared tunnel run 进程',
      instances,
    };
  });
}

/** 绑定里登记了 processPattern 的服务，在 macOS / Linux 上以进程特征决定运行状态。 */
async function decorateProcessPatternServices(list) {
  if (process.platform === 'win32') return list;
  return Promise.all((list || []).map(async (svc) => {
    if (!svc?.processPattern) return svc;
    const alive = await probeProcessPatternAlive(svc.processPattern);
    return {
      ...svc,
      url: svc.url || '',
      running: alive,
      status: alive ? 'healthy' : 'stopped',
      reason: alive ? `已发现进程特征 ${svc.processPattern}` : `未发现进程特征 ${svc.processPattern}`,
    };
  }));
}

/** Windows 系统服务的自启由 SCM 管理，不把 DSH 本地开关当成系统配置。 */
export function isWindowsSystemBootService(serviceId, platform = process.platform) {
  return platform === 'win32' && SERVICES_CATALOG.some((svc) => svc.id === serviceId && svc.kind === 'windows-service');
}

export function windowsServiceBootState(serviceName, row) {
  const mode = ['Auto', 'Manual', 'Disabled', 'Boot', 'System'].includes(row?.StartMode) ? row.StartMode : 'unknown';
  return {
    managed: true,
    serviceName,
    mode,
    enabled: mode === 'unknown' ? null : ['Auto', 'Boot', 'System'].includes(mode),
    reason: mode === 'unknown' ? '未能读取 Windows 服务自启模式' : '由插件联动 Windows 系统服务控制开机自启',
  };
}

export function syncWindowsServiceBootMode(serviceId, wantBoot) {
  const entry = SERVICES_CATALOG.find((svc) => svc.id === serviceId && svc.kind === 'windows-service');
  if (!entry?.serviceName || process.platform !== 'win32') return { ok: true, skipped: true };
  const mode = wantBoot ? 'auto' : 'demand';
  cachedWindowsBootRows = null;
  const direct = spawnSync('sc.exe', ['config', entry.serviceName, 'start=', mode], { windowsHide: true, encoding: 'utf8', timeout: 8000 });
  if (direct.status === 0) return { ok: true, serviceName: entry.serviceName, mode };
  const psCmd = `Start-Process sc.exe -ArgumentList 'config','${entry.serviceName}','start=','${mode}' -Verb RunAs -WindowStyle Hidden -Wait`;
  const elevated = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psCmd], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
  return { ok: elevated.status === 0, serviceName: entry.serviceName, mode };
}

// 后台服务状态与 Windows 系统服务自启模式默认缓存 1 小时，仅手动刷新或启停操作时强制重查
const SERVICE_STATUS_CACHE_TTL_MS = 60 * 60 * 1000;
let cachedWindowsBootRows = null;
let cachedWindowsBootAtMs = 0;

/** 仅查询服务名与 StartMode，绝不读取 PathName、凭据或修改 SCM；结果按 1 小时缓存避免频繁拉起 PowerShell。 */
async function decorateWindowsServiceBoot(list, { force = false } = {}) {
  const services = (list || []).filter((svc) => isWindowsSystemBootService(svc.id));
  if (!services.length) return list;
  const now = Date.now();
  let rows = !force && cachedWindowsBootRows && (now - cachedWindowsBootAtMs < SERVICE_STATUS_CACHE_TTL_MS)
    ? cachedWindowsBootRows
    : null;
  if (!rows) {
    const names = services.map((svc) => svc.serviceName);
    const filter = names.map((name) => `Name='${name}'`).join(' OR ');
    const script = `$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Service -Filter \"${filter}\" | Select-Object Name,StartMode | ConvertTo-Json -Compress`;
    rows = await new Promise((resolve) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
      let output = '';
      const timer = setTimeout(() => { try { child.kill(); } catch {} }, 5000);
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => { output += chunk; });
      child.on('error', () => { clearTimeout(timer); resolve([]); });
      child.on('close', (code) => {
        clearTimeout(timer);
        try {
          const parsed = code === 0 ? JSON.parse(output.trim() || '[]') : [];
          resolve(Array.isArray(parsed) ? parsed : [parsed]);
        } catch { resolve([]); }
      });
    });
    if (rows.length > 0) {
      cachedWindowsBootRows = rows;
      cachedWindowsBootAtMs = Date.now();
    }
  }
  return (list || []).map((svc) => isWindowsSystemBootService(svc.id)
    ? { ...svc, systemBoot: windowsServiceBootState(svc.serviceName, rows.find((row) => row?.Name === svc.serviceName)) }
    : svc);
}

async function decorateManagedProcessServices(list) {
  // 同一批 CIM 快照同时服务 Cursor Worker 和无端口的 Remote，并与系统服务自启查询并行执行，减少串行等待。
  const [nodeProcesses, bootDecoratedBase] = await Promise.all([
    process.platform === 'win32' ? listWindowsNodeProcesses() : Promise.resolve(null),
    decorateWindowsServiceBoot(list),
  ]);
  const withCursor = await decorateCursorWorkers(bootDecoratedBase, nodeProcesses ? { nodeProcesses } : {});
  const withRemote = decorateWindowsRemoteDesktop(withCursor, nodeProcesses);
  return decorateProcessPatternServices(await decorateCloudflared(withRemote));
}

/**
 * 探测单个服务的本地端口、挂载盘符或 Worker 进程是否已经就绪：
 * 用于启动前二次防重判断，避免外部已拉起同名实例时重复启动。
 */
/**
 * 探活兜底路径：JSON 里写错路径时，不该因此被判成服务停止。
 * 同一 origin 上换这些标准路径再问一遍，任一有响应就算在跑。
 */
const HEALTH_FALLBACK_PATHS = ['/__health', '/health', '/healthz', '/readyz', '/ping'];

/**
 * 把 health 归一成按优先级排列、去重的候选地址。
 * health 允许写字符串（最常见）或数组（多个端点按顺序试），数组先按书写顺序排前面。
 */
export function healthProbeCandidates(health) {
  const declared = (Array.isArray(health) ? health : [health])
    .filter((url) => typeof url === 'string' && url.trim())
    .map((url) => url.trim());
  const candidates = [...new Set(declared)];
  for (const url of declared) {
    let origin = null;
    try { origin = new URL(url).origin; } catch { continue; }
    // 兜底只加在同一 origin：跨端口、跨主机去猜没有依据，容易问到别的进程。
    for (const suffix of HEALTH_FALLBACK_PATHS) {
      const alt = `${origin}${suffix}`;
      if (!candidates.includes(alt)) candidates.push(alt);
    }
  }
  return candidates;
}

/** 只认真实 HTTP 响应；连接被接受但一直不回包（端口被别的进程占）判为不在跑。 */
function probeHttpDetail(url, timeoutMs = 600) {
  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { req?.destroy(); } catch {}
      resolve(result);
    };
    try {
      req = http.get(url, { timeout: timeoutMs }, (res) => {
        res.resume();
        finish({ alive: true, reason: 'response', code: '' });
      });
    } catch {
      finish({ alive: false, reason: 'error', code: 'ESYNTAX' });
      return;
    }
    req.on('timeout', () => finish({ alive: false, reason: 'timeout', code: 'ETIMEDOUT' }));
    req.on('error', (err) => finish({ alive: false, reason: 'error', code: err?.code || '' }));
  });
}

export function probeHttpAlive(url, timeoutMs = 600) {
  return probeHttpDetail(url, timeoutMs).then((result) => result.alive);
}

/** 主机根本不可达（拒绝连接、域名不存在）：换路径也不会有结果，同一 origin 后面的候选直接跳过。 */
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ESYNTAX']);

/** 取 origin（scheme + host + port）；写坏的地址返回空串。 */
function originOf(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

/**
 * 按候选顺序探活：先试 JSON 里写的地址，不通再试同 origin 的常见健康路径。
 * 判定口径是「HTTP 有响应」——2xx/3xx/4xx 都算活着，只有连不上或超时才算停止。
 * 某个 origin 明确不可达时只跳过它自己的候选，数组里其它地址仍会继续试。
 */
export async function probeHealthEndpoint(health) {
  const deadOrigins = new Set();
  for (const url of healthProbeCandidates(health)) {
    const origin = originOf(url);
    if (origin && deadOrigins.has(origin)) continue;
    const result = await probeHttpDetail(url);
    if (result.alive) return true;
    if (origin && UNREACHABLE_CODES.has(result.code)) deadOrigins.add(origin);
  }
  return false;
}

/** 解析服务在 macOS 上的 launchd 启动项路径（把 ~ 展开成家目录）。 */
export function resolveLaunchdPlistPath(entry) {
  const raw = entry?.launchd?.plist;
  if (!raw) return '';
  return String(raw).replace(/^~(?=\/|$)/, homedir());
}

/** launchctl 输出仅在内存中解析；调用方不得把其中的继承环境透传到日志或前端。 */
function runLaunchctl(args) {
  const res = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  const output = `${res.stdout || ''}${res.stderr || ''}`.trim();
  return { ok: res.status === 0, output, exitCode: res.status, missing: res.status !== 0 && isLaunchctlMissing(output) };
}

/** 原生启停保留现有 plist 参数；逐条核验命令，不用 load/unload -w 偷改自启开关。 */
export async function controlMacLaunchdService(entry, action, options = {}) {
  const label = entry?.launchd?.label;
  const plist = resolveLaunchdPlistPath(entry);
  if (!label) return { ok: false, message: '该服务未配置 macOS launchd 标签' };
  if (!['start', 'stop', 'restart'].includes(action)) return { ok: false, message: '不支持的控制动作' };
  const uid = options.uid ?? process.getuid?.();
  if (!Number.isInteger(uid) || uid < 0) return { ok: false, message: '无法解析当前用户 UID' };
  const domain = `gui/${uid}`;
  const target = `${domain}/${label}`;
  const run = options.runLaunchctl || runLaunchctl;
  const probeAlive = options.probeAlive || probeServiceEndpointAlive;
  const initiallyAlive = await probeAlive(entry);
  if (action === 'start' && initiallyAlive) {
    return { ok: true, skipped: true, message: `${entry.name} 已在运行，未重复启动` };
  }
  const printed = await run(['print', target]);
  const loaded = printed.ok;
  if (!loaded && printed.missing === false) return { ok: false, message: `launchctl print 失败：${target}` };
  // 原始 launchctl 输出可能含敏感环境；只报告操作名和目标，不把它透传到面板。
  const checkedRun = async (args) => {
    const result = await run(args);
    const code = Number.isInteger(result.exitCode) ? `（退出码 ${result.exitCode}）` : '';
    return result.ok ? null : { ok: false, message: `launchctl ${args[0]} 失败${code}：${target}` };
  };
  if (action === 'stop') {
    if (!loaded && initiallyAlive) return { ok: false, message: '服务仍在运行，但未找到所属 LaunchAgent；未结束未知进程' };
    if (loaded) {
      const failure = await checkedRun(['bootout', target]);
      if (failure) return failure;
    }
  } else {
    if (!loaded) {
      if (!existsSync(plist)) return { ok: false, message: `未找到启动项：${plist}` };
      const failure = await checkedRun(['bootstrap', domain, plist]);
      if (failure) return failure;
    }
    const args = action === 'restart' ? ['kickstart', '-k', target] : ['kickstart', target];
    const failure = await checkedRun(args);
    if (failure) return failure;
  }

  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 8000;
  const pollIntervalMs = options.pollIntervalMs ?? 400;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const alive = await probeAlive(entry);
    if (action === 'stop' ? !alive : alive) {
      return { ok: true, message: `${entry.name} ${action === 'stop' ? '已停止' : action === 'restart' ? '已重启' : '已启动'}` };
    }
    if (Date.now() >= deadline) {
      return { ok: false, message: action === 'stop' ? '停止超时：服务仍在运行' : '启动超时：服务探活未通过' };
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

/** 无端口 LaunchAgent 按 launchd 的运行状态与实际 PID 探活；仅加载 plist 不算运行。 */
export async function probeMacLaunchdAlive(entry, options = {}) {
  const label = entry?.launchd?.label;
  if (!label) return false;
  const uid = options.uid ?? process.getuid?.();
  if (!Number.isInteger(uid) || uid < 0) return false;
  const run = options.runLaunchctl || runLaunchctl;
  const result = await run(['print', `gui/${uid}/${label}`]);
  if (!result.ok) return false;
  // print 可能含继承的敏感环境变量：只提取顶层 state/pid，不回显或保存原始输出。
  const output = String(result.output || '');
  const state = output.match(/^\tstate = (.+)$/m)?.[1]?.trim();
  const pid = Number(output.match(/^\tpid = (\d+)$/m)?.[1]);
  return state === 'running' && Number.isSafeInteger(pid) && pid > 0
    && (options.isPidAlive || isProcessIdAlive)(pid);
}

export async function probeServiceEndpointAlive(entry, options = {}) {
  if (!entry) return false;
  // cursor_workers 没有监听端口，只能扫本机 Worker 进程。
  if (entry.id === 'cursor_workers') {
    return probeCursorWorkersAlive();
  }
  if (entry.id === 'cloudflared') {
    return probeCloudflaredAlive();
  }
  // 无端口进程按绑定登记的命令行特征探活，不再为某个服务 id 写死特征。
  if (entry.processPattern && process.platform !== 'win32') {
    return probeProcessPatternAlive(entry.processPattern);
  }
  // 声明了 health 端点的服务以真实 HTTP 响应为准，避免「端口有人监听」被误判成运行中。
  // health 可以是字符串或数组，路径写错会按同 origin 的常见健康路径兜底，不会直接判停止。
  if (entry.health) {
    return probeHealthEndpoint(entry.health);
  }
  // 端口通不代表是本服务：5001 这类端口常被系统进程占着，必须真拿到 HTTP 响应。
  if (entry.probe === 'http' && entry.url) {
    return probeHttpAlive(entry.url);
  }
  if (entry.port) {
    return probeTcpPort(entry.port);
  }
  if (entry.drive && process.platform === 'win32') {
    const drives = String(entry.drive)
      .split('/')
      .map((d) => d.trim())
      .filter(Boolean);
    return drives.length > 0 && drives.every((d) => existsSync(`${d}\\`));
  }
  if ((options.platform || process.platform) === 'darwin' && entry.launchd) {
    return probeMacLaunchdAlive(entry, options);
  }
  if (isRunnableScriptPath(entry.scriptPath)) {
    const trackedPid = readTrackedServicePid(entry.id);
    if (trackedPid && isProcessIdAlive(trackedPid)) return true;
    const scriptPids = await findPidsForScriptPath(entry.scriptPath, options);
    if (scriptPids.length > 0) return true;
  }
  return false;
}

/** 命令行是否在跑这份脚本：先比完整路径，再比「父目录/文件名」。 */
export function commandLineMentionsScript(commandLine, scriptPath) {
  const cmd = String(commandLine || '').replace(/\\/g, '/').toLowerCase();
  const resolved = expandLocalPath(scriptPath).replace(/\\/g, '/').toLowerCase();
  if (!cmd.trim() || !resolved) return false;
  if (cmd.includes(resolved)) return true;
  const parts = resolved.split('/').filter(Boolean);
  const base = parts[parts.length - 1] || '';
  const parent = parts[parts.length - 2] || '';
  return Boolean(base && parent && cmd.includes(`${parent}/${base}`));
}

function scriptInterpreterNames(scriptPath) {
  const ext = path.extname(String(scriptPath || '')).toLowerCase();
  if (ext === '.py' || ext === '.pyw') return ['python.exe', 'pythonw.exe'];
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return ['node.exe'];
  if (ext === '.exe') {
    const name = path.basename(scriptPath);
    return name ? [name] : [];
  }
  return [];
}

function listWindowsProcessesForScript(scriptPath) {
  const names = scriptInterpreterNames(scriptPath);
  if (process.platform !== 'win32' || names.length === 0) return Promise.resolve([]);
  const filter = names.map((name) => `Name = '${String(name).replace(/'/g, "''")}'`).join(' OR ');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object @{n='pid';e={$_.ProcessId}}, @{n='commandLine';e={$_.CommandLine}} | ConvertTo-Json -Compress`,
  ].join('; ');
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 8_000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { out += chunk; });
    const finish = (items) => {
      clearTimeout(timer);
      resolve(Array.isArray(items) ? items : []);
    };
    child.on('error', () => finish([]));
    child.on('close', () => {
      try {
        const parsed = JSON.parse(out.trim() || '[]');
        finish(Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []));
      } catch {
        finish([]);
      }
    });
  });
}

function listPosixProcessesForScript() {
  return new Promise((resolve) => {
    const child = spawn('ps', ['-ax', '-o', 'pid=,args='], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 8_000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { out += chunk; });
    const finish = (items) => {
      clearTimeout(timer);
      resolve(Array.isArray(items) ? items : []);
    };
    child.on('error', () => finish([]));
    child.on('close', () => {
      const items = String(out || '').split(/\r?\n/).flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+(.*)$/);
        return match ? [{ pid: Number(match[1]), commandLine: match[2] }] : [];
      });
      finish(items);
    });
  });
}

/** 找出命令行里带着这份脚本的进程。测试可注入 scriptProcesses / commands，避免扫本机。 */
export async function findPidsForScriptPath(scriptPath, options = {}) {
  const resolved = expandLocalPath(scriptPath);
  if (!resolved) return [];
  const injected = Array.isArray(options.scriptProcesses)
    ? options.scriptProcesses
    : (Array.isArray(options.commands)
      ? options.commands.map((commandLine, index) => ({
        pid: Array.isArray(options.pids) ? Number(options.pids[index]) : index + 1,
        commandLine,
      }))
      : null);
  if (injected) {
    return injected
      .filter((item) => commandLineMentionsScript(item?.commandLine, resolved))
      .map((item) => Number(item.pid))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  }
  // 测试隔离：避免每条用例都扫一遍本机 python/node 进程。
  if (process.env.DSH_AU_SKIP_SCRIPT_PROCESS_SCAN === '1') return [];
  const platformOs = options.platform || process.platform;
  const items = platformOs === 'win32'
    ? await listWindowsProcessesForScript(resolved)
    : await listPosixProcessesForScript();
  return (items || [])
    .filter((item) => commandLineMentionsScript(item.commandLine, resolved))
    .map((item) => Number(item.pid))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid && pid !== process.ppid);
}

const NON_RUNNABLE_EXTENSIONS = new Set([
  '.json', '.yaml', '.yml', '.toml', '.ini', '.conf', '.cfg',
  '.md', '.txt', '.log', '.plist', '.xml', '.csv',
]);

const RUNNABLE_EXTENSIONS = new Set([
  '.py', '.pyw', '.js', '.mjs', '.cjs', '.ps1',
  '.sh', '.bash', '.zsh', '.bat', '.cmd', '.vbs',
  '.exe', '.bin', '.command', '.ts',
]);

const WIN_ONLY_SCRIPT_EXTENSIONS = new Set(['.exe', '.bat', '.cmd', '.vbs']);

/**
 * 判断本机绑定里的 scriptPath 是否为可直接拉起的可执行脚本或程序。
 * 排除 .json/.yaml/.md 等纯数据文件；非 Windows 平台排除 Windows 盘符与专属后缀。
 */
export function isRunnableScriptPath(scriptPath, platformOs = process.platform) {
  const raw = typeof scriptPath === 'string' ? scriptPath.trim() : '';
  if (!raw) return false;
  const ext = path.extname(raw).toLowerCase();
  if (NON_RUNNABLE_EXTENSIONS.has(ext)) return false;
  if (platformOs !== 'win32' && WIN_ONLY_SCRIPT_EXTENSIONS.has(ext)) return false;
  return RUNNABLE_EXTENSIONS.has(ext) || ext === '';
}

/**
 * 按脚本后缀与目标系统拼出统一的跨平台启动命令：
 * 支持任意路径下的 Python (.py/.pyw)、Node (.js/.mjs/.cjs)、PowerShell (.ps1)、
 * Shell (.sh/.bash/.zsh/.command)、Windows 批处理/VBS (.bat/.cmd/.vbs) 与原生可执行文件。
 */
export function buildScriptLaunchSpec(scriptPath, options = {}) {
  const platformOs = options.platform || process.platform;
  const resolvedPath = expandLocalPath(scriptPath);
  const ext = path.extname(resolvedPath).toLowerCase();
  const extraArgs = Array.isArray(options.args)
    ? options.args.filter((item) => typeof item === 'string' && item.trim())
    : [];
  const cwd = options.cwd || (resolvedPath ? path.dirname(resolvedPath) : PLUGIN_ROOT);
  if (ext === '.py' || ext === '.pyw') {
    const pyBin = resolveControllerPython({ windowless: ext === '.pyw' || Boolean(options.windowless) });
    // cursor_worker.py 默认会倒计时或等回车，当服务拉起时必须立刻退出，避免把启动器 PID 误当成 Worker。
    const pyArgs = path.basename(resolvedPath).toLowerCase() === 'cursor_worker.py' && !extraArgs.includes('--no-wait')
      ? [...extraArgs, '--no-wait']
      : extraArgs;
    return { command: pyBin, args: ['-X', 'utf8', resolvedPath, ...pyArgs], cwd, scriptPath: resolvedPath, ext };
  }
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return { command: process.execPath || 'node', args: [resolvedPath, ...extraArgs], cwd, scriptPath: resolvedPath, ext };
  }
  if (ext === '.ps1') {
    if (platformOs === 'win32') {
      return {
        command: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolvedPath, ...extraArgs],
        cwd,
        scriptPath: resolvedPath,
        ext,
      };
    }
    return { command: 'pwsh', args: ['-NoProfile', '-NonInteractive', '-File', resolvedPath, ...extraArgs], cwd, scriptPath: resolvedPath, ext };
  }
  if (ext === '.sh' || ext === '.bash' || ext === '.command') {
    return { command: 'bash', args: [resolvedPath, ...extraArgs], cwd, scriptPath: resolvedPath, ext };
  }
  if (ext === '.zsh') {
    return { command: 'zsh', args: [resolvedPath, ...extraArgs], cwd, scriptPath: resolvedPath, ext };
  }
  if (ext === '.bat' || ext === '.cmd') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', resolvedPath, ...extraArgs], cwd, scriptPath: resolvedPath, ext };
  }
  if (ext === '.vbs') {
    return { command: 'wscript.exe', args: ['//B', '//Nologo', resolvedPath, ...extraArgs], cwd, scriptPath: resolvedPath, ext };
  }
  return { command: resolvedPath, args: [...extraArgs], cwd, scriptPath: resolvedPath, ext };
}

function resolveServicePidDir() {
  return process.env.DSH_AU_PID_DIR || path.join(tmpdir(), 'dsh-au-service-pids');
}

function resolveServicePidFile(serviceId) {
  const safeId = String(serviceId || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(resolveServicePidDir(), `${safeId}.json`);
}

function isProcessIdAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function readTrackedServicePid(serviceId) {
  const filePath = resolveServicePidFile(serviceId);
  if (!existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    const pid = Number(raw?.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function writeTrackedServicePid(serviceId, pid, scriptPath) {
  const filePath = resolveServicePidFile(serviceId);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify({
    serviceId,
    pid,
    scriptPath,
    startedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
}

function clearTrackedServicePid(serviceId) {
  const filePath = resolveServicePidFile(serviceId);
  if (existsSync(filePath)) {
    try { rmSync(filePath, { force: true }); } catch {}
  }
}

function findListeningPidsByPort(port) {
  if (!Number.isInteger(port) || port <= 0) return [];
  if (process.platform === 'win32') {
    const res = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
    const lines = String(res.stdout || '').split(/\r?\n/);
    const pids = new Set();
    const portSuffix = `:${port}`;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('TCP') || !trimmed.includes('LISTENING')) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 5) continue;
      const localAddr = parts[1] || '';
      if (!localAddr.endsWith(portSuffix)) continue;
      const pid = Number(parts[parts.length - 1]);
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && pid !== process.ppid) {
        pids.add(pid);
      }
    }
    return [...pids];
  }
  const res = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', windowsHide: true });
  return String(res.stdout || '')
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid && pid !== process.ppid);
}

function terminatePidCrossPlatform(pid) {
  if (!isProcessIdAlive(pid) || pid === process.pid || pid === process.ppid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
}

/** 显式停止脚本负责服务自身的停止；不读取输出，也不按探活端口杀进程。 */
function runExplicitStopScript(entry, timeoutMs) {
  const stopPath = expandLocalPath(entry.stopScriptPath);
  if (!isRunnableScriptPath(stopPath) || !existsSync(stopPath)) {
    return Promise.resolve({ ok: false, message: '停止脚本不存在或不可执行' });
  }
  const spec = buildScriptLaunchSpec(stopPath, { windowless: true, args: entry.stopArgs });
  return new Promise((resolve) => {
    let child;
    let timer;
    let finished = false;
    const finish = (ok, message) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ok, message });
    };
    try {
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
        windowsHide: true,
        stdio: 'ignore',
      });
      child.once('error', () => finish(false, '停止脚本无法启动'));
      child.once('close', (code) => finish(code === 0, code === 0 ? '停止脚本执行完成' : '停止脚本执行失败'));
      timer = setTimeout(() => {
        finish(false, '停止脚本执行超时');
        // 只结束本次控制脚本；绝不回退到杀健康端口的监听进程。
        try { child.kill(); } catch {}
      }, timeoutMs);
    } catch {
      finish(false, '停止脚本无法启动');
    }
  });
}

/**
 * 通用跨平台脚本控制器：
 * 显式 stopScriptPath 优先；仅未配置停止脚本时沿用原有进程控制。
 */
export async function controlScriptPathService(entry, action, options = {}) {
  const scriptPath = expandLocalPath(entry?.scriptPath || '');
  if (!isRunnableScriptPath(scriptPath)) {
    return { ok: false, message: `${entry?.name || entry?.id || '服务'} 未配置可执行 scriptPath` };
  }
  if (!['start', 'stop', 'restart'].includes(action)) {
    return { ok: false, message: '不支持的控制动作' };
  }
  const configuredTimeout = Number.isSafeInteger(entry.controlTimeoutMs) && entry.controlTimeoutMs > 0
    ? entry.controlTimeoutMs : 6000;
  // Node 定时器超过 2^31-1 会变成 1ms；截断上限而不是意外立即超时。
  const timeoutMs = Math.min(Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : configuredTimeout, 2147483647);
  const hasExplicitStop = Object.hasOwn(entry, 'stopScriptPath');
  const hasEndpointProbe = Boolean(entry.health || entry.port || entry.drive
    || (entry.processPattern && process.platform !== 'win32') || (entry.probe === 'http' && entry.url));
  const probeAlive = options.probeAlive || ((svc) => probeServiceEndpointAlive(svc, options));
  const alreadyRunningResult = () => ({
    ok: true,
    skipped: true,
    message: `${entry.name} 已在运行，未重复启动`,
    running: true,
  });

  if ((action === 'stop' || action === 'restart') && hasExplicitStop) {
    const stopped = await runExplicitStopScript(entry, timeoutMs);
    if (!stopped.ok) return { ...stopped, running: hasEndpointProbe ? await probeServiceEndpointAlive(entry) : null };
    clearTrackedServicePid(entry.id);
    // 停止脚本成功仍需验证服务已停止；失败不允许继续启动第二个实例。
    const deadline = Date.now() + timeoutMs;
    while (hasEndpointProbe && await probeServiceEndpointAlive(entry)) {
      if (Date.now() >= deadline) {
        return { ok: false, message: '停止脚本已执行，但服务仍可达；未继续重启', running: true };
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (action === 'stop') return { ok: true, message: `${entry.name} 已停止`, running: false };
  }

  if ((action === 'stop' || action === 'restart') && !hasExplicitStop) {
    const trackedPid = readTrackedServicePid(entry.id);
    const portPids = entry.port ? findListeningPidsByPort(entry.port) : [];
    const scriptPids = await findPidsForScriptPath(scriptPath, options);
    const targetPids = [...new Set([trackedPid, ...portPids, ...scriptPids].filter((pid) => Number.isInteger(pid) && pid > 0))];
    for (const pid of targetPids) {
      terminatePidCrossPlatform(pid);
    }
    clearTrackedServicePid(entry.id);
    const stopDeadline = Date.now() + timeoutMs;
    for (;;) {
      const endpointAlive = await probeServiceEndpointAlive(entry);
      const anyPidAlive = targetPids.some((pid) => isProcessIdAlive(pid));
      if (!endpointAlive && !anyPidAlive) break;
      if (Date.now() > stopDeadline) {
        if (process.platform !== 'win32') {
          for (const pid of targetPids) {
            try { process.kill(pid, 'SIGKILL'); } catch {}
          }
        }
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (action === 'stop') {
      const stillAlive = await probeServiceEndpointAlive(entry);
      return {
        ok: !stillAlive,
        message: !stillAlive ? `${entry.name} 已停止` : `停止超时：${entry.name} 仍在运行`,
        running: stillAlive,
      };
    }
  }

  if (action === 'start' && await probeAlive(entry)) {
    return alreadyRunningResult();
  }

  if (!existsSync(scriptPath)) {
    return { ok: false, message: `未找到服务脚本文件：${scriptPath}`, running: false };
  }

  const spec = buildScriptLaunchSpec(scriptPath, {
    windowless: true,
    cwd: entry.workdir || path.dirname(scriptPath),
    args: entry.args,
  });
  const cwd = existsSync(spec.cwd) ? spec.cwd : path.dirname(scriptPath);
  let child;
  try {
    child = spawn(spec.command, spec.args, {
      cwd,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (err) {
    return { ok: false, message: `启动脚本失败：${err.message}`, running: false };
  }

  if (child?.pid) {
    writeTrackedServicePid(entry.id, child.pid, scriptPath);
  }

  const startDeadline = Date.now() + timeoutMs;
  const startedResult = () => ({
    ok: true,
    pid: child?.pid || null,
    message: action === 'restart'
      ? `${entry.name} 已重启 (${path.basename(scriptPath)})`
      : `${entry.name} 已启动 (${path.basename(scriptPath)})`,
    running: true,
  });
  for (;;) {
    const childAlive = isProcessIdAlive(child?.pid);
    const probed = await probeAlive(entry);
    if (probed) {
      // 无探活地址时，新进程因互斥立刻退出但旧实例仍在 → 视为已运行，不报启动失败。
      if (!childAlive && !hasEndpointProbe) {
        clearTrackedServicePid(entry.id);
        return alreadyRunningResult();
      }
      return startedResult();
    }
    if (childAlive && !hasEndpointProbe) {
      // 无端口脚本多观察一小段时间，确认未立即崩溃退出
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (isProcessIdAlive(child?.pid)) return startedResult();
      clearTrackedServicePid(entry.id);
      if (await probeAlive(entry)) return alreadyRunningResult();
      return { ok: false, message: `启动失败：脚本进程 (${path.basename(scriptPath)}) 启动后立即退出`, running: false };
    }
    if (!childAlive && !hasEndpointProbe) {
      clearTrackedServicePid(entry.id);
      return { ok: false, message: `启动失败：脚本进程 (${path.basename(scriptPath)}) 启动后立即退出`, running: false };
    }
    if (Date.now() > startDeadline) {
      return { ok: false, message: `启动超时：${entry.name} 健康检查未通过`, running: false };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * 生成 Windows 无头子进程补丁代码：
 * 强制所有 Python 派生的子进程隐藏窗口、建立独立进程组并脱离 DSH Job Object。
 */
export const WIN_HEADLESS_POPEN_PATCH = [
  'import os, subprocess',
  'if os.name == "nt":',
  '    _orig_popen = subprocess.Popen',
  '    def _silent_popen(*a, **kw):',
  '        kw["creationflags"] = int(kw.get("creationflags", 0)) | getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200) | getattr(subprocess, "CREATE_BREAKAWAY_FROM_JOB", 0x01000000)',
  '        if kw.get("text") or kw.get("universal_newlines") or kw.get("encoding"):',
  '            kw.setdefault("errors", "replace")',
  '        si = kw.get("startupinfo") or subprocess.STARTUPINFO()',
  '        si.dwFlags |= getattr(subprocess, "STARTF_USESHOWWINDOW", 1)',
  '        si.wShowWindow = 0',
  '        kw["startupinfo"] = si',
  '        return _orig_popen(*a, **kw)',
  '    subprocess.Popen = _silent_popen',
].join('\n');

/** 解析系统开机自启动目录（支持测试通过 DSH_AU_STARTUP_DIR 覆盖，兼容 win32 / darwin / linux） */
export function resolveStartupDir(platformOs = process.platform) {
  if (process.env.DSH_AU_STARTUP_DIR) return process.env.DSH_AU_STARTUP_DIR;
  const home = homedir();
  if (platformOs === 'darwin') {
    return path.join(home, 'Library', 'LaunchAgents');
  }
  if (platformOs === 'linux') {
    return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'autostart');
  }
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

/** 官方系统 LaunchDaemon 管开机，不写用户 LaunchAgent。 */
const MACOS_LAUNCHD_BOOT_IDS = new Set(['cloudflared']);

function isPathInsideRoot(filePath, root) {
  if (!filePath || !root) return false;
  let resolvedFile = path.resolve(filePath);
  let resolvedRoot = path.resolve(root);
  if (process.platform === 'win32') {
    resolvedFile = resolvedFile.toLowerCase();
    resolvedRoot = resolvedRoot.toLowerCase();
  }
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  return resolvedFile === resolvedRoot || resolvedFile.startsWith(prefix);
}

/** 是否走外部平台控制器：看本机绑定的 controller/platformController，或脚本是否落在通用控制器目录下。 */
function bindingPrefersAuWin(bound) {
  if (!bound || typeof bound !== 'object') return false;
  const named = String(bound.controller || bound.platformController || '').trim().toLowerCase();
  if (named === 'auwin' || named === 'platform' || named === 'controller') return true;
  return isPathInsideRoot(expandLocalPath(bound.scriptPath || ''), controllerRoot());
}

/** 不再用开源仓服务 id 白名单；未声明 controller 且脚本不在通用控制器目录时走通用 scriptPath。 */
export function usesControllerService(serviceId, options = {}) {
  if (options.preferScriptRunner) return false;
  if (!hasControllerModuleAvailable()) return false;
  const bindings = options.bindings || loadBindingsMap(options.hostname);
  const bound = {
    ...(bindings?.[serviceId] || {}),
    ...(options.entry && typeof options.entry === 'object' ? options.entry : {}),
  };
  return bindingPrefersAuWin(bound);
}

/** 兼容别名：保留给已有调用方。 */
export function usesAuWinServiceController(serviceId, options = {}) {
  return usesControllerService(serviceId, options);
}

export function serviceControlCapability(serviceId, options = {}) {
  const platformOs = options.platform || process.platform;
  const catalogEntry = SERVICES_CATALOG.find((entry) => entry.id === serviceId);
  if (catalogEntry?.platform && catalogEntry.platform !== platformOs) {
    return { canControl: false, controlReason: `${catalogEntry.name} 仅支持 ${catalogEntry.platform}，当前平台不可控制` };
  }
  // 只要在本机绑定 JSON 记录了可执行 scriptPath，不限制脚本路径或操作系统，均由插件直接纳管。
  const bindings = options.bindings || loadLocalBindings(options.hostname).services || {};
  const boundScriptPath = options.entry?.scriptPath || bindings?.[serviceId]?.scriptPath || '';
  if (isRunnableScriptPath(boundScriptPath, platformOs)) {
    return { canControl: true, controlReason: '' };
  }
  if (usesControllerService(serviceId, { ...options, bindings, platform: platformOs })) {
    return { canControl: true, controlReason: '' };
  }
  if (platformOs === 'darwin') {
    if (serviceId === 'cloudflared' || MACOS_LAUNCHD_BOOT_IDS.has(serviceId)) {
      return { canControl: true, controlReason: '' };
    }
    if (bindings?.[serviceId]?.launcher?.label) {
      return { canControl: true, controlReason: '' };
    }
    return { canControl: false, controlReason: 'macOS 当前仅支持已登记 scriptPath、用户 LaunchAgent 或 Cloudflare 隧道的服务' };
  }
  return { canControl: false, controlReason: '本机绑定 JSON 未记录可执行 scriptPath 或外部平台控制器' };
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function plistString(value) {
  return `<string>${xmlEscape(value)}</string>`;
}

function buildMacBootPlist(label, bootIds, pythonPath, genericSpecs = []) {
  const ctrlDir = controllerRoot();
  const serviceJson = JSON.stringify(bootIds);
  const pythonRoot = JSON.stringify(ctrlDir);
  const genericJson = JSON.stringify(genericSpecs.map((spec) => ({
    cmd: [spec.command, ...spec.args],
    cwd: spec.cwd,
  })));
  const pyParts = ['import json, subprocess, sys'];
  if (bootIds.length) {
    pyParts.push(
      `sys.path.insert(0, ${pythonRoot})`,
      'from backend.lanmiao.background_services import control_service',
      `results = [control_service(service_id, 'start', notify=False) for service_id in ${serviceJson}]`,
    );
  } else {
    pyParts.push('results = []');
  }
  if (genericSpecs.length) {
    pyParts.push(
      `[subprocess.Popen(item['cmd'], cwd=item['cwd'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) for item in ${genericJson}]`,
    );
  }
  pyParts.push("print(json.dumps(results, ensure_ascii=True))");
  const pyInline = pyParts.join('; ');
  const logDir = path.join(homedir(), 'Library', 'Logs');
  const args = [pythonPath, '-X', 'utf8', '-c', pyInline];
  const argumentXml = args.map(plistString).join('\n        ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${plistString(label)}
  <key>ProgramArguments</key>
  <array>
        ${argumentXml}
  </array>
  <key>WorkingDirectory</key>
  ${plistString(ctrlDir)}
  <key>EnvironmentVariables</key>
  <dict>
    <key>PYTHONUTF8</key>
    <string>1</string>
    <key>PYTHONIOENCODING</key>
    <string>utf-8</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  ${plistString(path.join(logDir, `${label}.out.log`))}
  <key>StandardErrorPath</key>
  ${plistString(path.join(logDir, `${label}.err.log`))}
</dict>
</plist>
`;
}

/**
 * 同步当前电脑的「开机自启动」无窗口启动项：
 * 仅对同时处于 enabled 且开启 autoStartOnBoot 的服务生成独立自启脚本；为空时清理启动项。
 * 支持任意登记了 scriptPath 的本地服务在 win32 / darwin / linux 下同步开机自启。
 */
export async function syncBootStartupEntry(targetHostname, profile, platformOs = process.platform, options = {}) {
  const safeHost = String(targetHostname || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  const enabledSet = new Set(profile?.enabled || []);
  const requestedIds = (profile?.autoStartOnBoot || []).filter((id) => enabledSet.has(id));
  const bindings = loadLocalBindings(targetHostname).services || {};
  const hasRunnableBoundScript = (id) => isRunnableScriptPath(bindings?.[id]?.scriptPath || '', platformOs);
  // 原生 launcher.label 只同步原启动项，不能再生成无参数二进制通用启动项（如 Mac rclone）。
  // 不为错误平台、JSON-only 或未在外部平台控制器/scriptPath 注册的服务写出“看似已启用”的无效启动项。
  const usesCtrl = (id) => usesControllerService(id, { hostname: targetHostname, bindings, platform: platformOs });
  const bootIds = platformOs === 'darwin'
    ? requestedIds.filter((id) => (
      usesCtrl(id)
      || (!bindings?.[id]?.launcher?.label && !SERVICES_CATALOG.some((item) => item.id === id) && hasRunnableBoundScript(id))
    ))
    : requestedIds.filter((id) => serviceControlCapability(id, { hostname: targetHostname, bindings, platform: platformOs }).canControl);
  const launchdIds = platformOs === 'darwin'
    ? requestedIds.filter((id) => MACOS_LAUNCHD_BOOT_IDS.has(id) || Boolean(bindings?.[id]?.launcher?.label || SERVICES_CATALOG.find((item) => item.id === id)?.launchd?.label))
    : [];
  const skippedServices = requestedIds.filter((id) => !bootIds.includes(id) && !launchdIds.includes(id));
  const startupDir = resolveStartupDir(platformOs);
  const filePath = platformOs === 'darwin'
    ? path.join(startupDir, `com.dsh-au.boot.${safeHost}.plist`)
    : platformOs === 'linux'
      ? path.join(startupDir, `dsh-au-boot-${safeHost}.desktop`)
      : path.join(startupDir, `dsh-au-boot-${safeHost}.vbs`);

  let launchdSync = null;
  if (platformOs === 'darwin' && enabledSet.has('cloudflared')) {
    const skipRealLaunchd = Boolean(process.env.DSH_AU_STARTUP_DIR) && !options.runLaunchctl;
    launchdSync = {
      cloudflared: skipRealLaunchd
        ? { ok: true, skipped: true, wanted: launchdIds.includes('cloudflared'), loaded: false, needsAdmin: false, error: '' }
        : await syncCloudflaredBootDaemon(launchdIds.includes('cloudflared'), options),
    };
  }

  try {
    // macOS：对带 launchd 标签的服务直接做 enable/disable；对通用 scriptPath 或外部平台控制器托管服务写入用户 LaunchAgent。
    if (platformOs === 'darwin') {
      const domain = `gui/${typeof process.getuid === 'function' ? process.getuid() : 501}`;
      const applied = [];
      for (const id of enabledSet) {
        const catalogEntry = SERVICES_CATALOG.find((item) => item.id === id);
        const label = bindings?.[id]?.launcher?.label || catalogEntry?.launchd?.label || '';
        if (!label) continue;
        const wantBoot = requestedIds.includes(id);
        // Doctor 的临时 Startup 目录不应触及真实 launchd 开关；显式提供执行器时才做实测。
        const args = [wantBoot ? 'enable' : 'disable', `${domain}/${label}`];
        const run = process.env.DSH_AU_STARTUP_DIR && !options.runLaunchctl
          ? { ok: true, skipped: true }
          : options.runLaunchctl ? await options.runLaunchctl(args) : runLaunchctl(args);
        applied.push({ id, autoStartOnBoot: wantBoot, ok: run.ok, ...(run.skipped ? { skipped: true } : {}) });
      }
      // 原生开关写入失败必须反馈给面板，不能以 synced:true 掩盖；保留已有通用启动项。
      const failedLaunchd = applied.filter((item) => !item.ok);
      if (failedLaunchd.length) {
        return { synced: false, filePath, activeServices: [], skippedServices, launchdSync, launchd: applied,
          error: `macOS LaunchAgent 自启开关同步失败：${failedLaunchd.map((item) => item.id).join(', ')}` };
      }
      if (bootIds.length === 0) {
        if (existsSync(filePath)) rmSync(filePath, { force: true });
        return { synced: true, filePath, activeServices: [], skippedServices, launchdSync, launchd: applied };
      }
      mkdirSync(startupDir, { recursive: true });
      const label = `com.dsh-au.boot.${safeHost}`;
      const ctrlBootIds = bootIds.filter((id) => usesCtrl(id));
      const genericSpecs = bootIds
        .filter((id) => !usesCtrl(id) && hasRunnableBoundScript(id))
        .map((id) => buildScriptLaunchSpec(bindings[id].scriptPath, { windowless: true, platform: 'darwin', args: bindings[id].args }));
      writeFileSync(filePath, buildMacBootPlist(label, ctrlBootIds, resolveControllerPython({ windowless: true }), genericSpecs), 'utf8');
      return { synced: true, filePath, activeServices: bootIds, skippedServices, launchdSync, launchd: applied };
    }
    // Windows 系统服务仍由 SCM 管理，保留本机新增的启动模式同步；隔离体检不改真实系统服务。
    if (platformOs === 'win32' && !process.env.DSH_AU_STARTUP_DIR) {
      for (const id of Object.keys(bindings)) {
        if (isWindowsSystemBootService(id, platformOs)) {
          syncWindowsServiceBootMode(id, requestedIds.includes(id));
        }
      }
    }
    if (platformOs === 'linux') {
      const genericSpecs = bootIds
        .filter((id) => hasRunnableBoundScript(id))
        .map((id) => ({ id, spec: buildScriptLaunchSpec(bindings[id].scriptPath, { windowless: true, platform: 'linux', args: bindings[id].args }) }));
      const activeServices = genericSpecs.map((item) => item.id);
      if (activeServices.length === 0) {
        if (existsSync(filePath)) rmSync(filePath, { force: true });
        return { synced: true, filePath, activeServices: [], skippedServices, launchdSync };
      }
      mkdirSync(startupDir, { recursive: true });
      const shQuote = (val) => `'${String(val).replace(/'/g, "'\\''")}'`;
      const cmdJoined = genericSpecs
        .map(({ spec }) => `(cd ${shQuote(spec.cwd)} && nohup ${[spec.command, ...spec.args].map(shQuote).join(' ')} >/dev/null 2>&1 &)`)
        .join('; ');
      const desktopContent = [
        '[Desktop Entry]',
        'Type=Application',
        `Name=DSH-AU Boot Services (${safeHost})`,
        `Exec=/bin/sh -c "${cmdJoined.replace(/"/g, '\\"')}"`,
        'Terminal=false',
        'X-GNOME-Autostart-enabled=true',
        '',
      ].join('\n');
      writeFileSync(filePath, desktopContent, 'utf8');
      return { synced: true, filePath, activeServices, skippedServices, launchdSync };
    }
    // 通用 scriptPath + args：按后缀无窗口拉起，不再为某个服务 id 写死脚本。
    const genericScriptRuns = [];
    const ctrlIds = [];
    for (const id of bootIds) {
      if (usesCtrl(id)) {
        ctrlIds.push(id);
        continue;
      }
      if (hasRunnableBoundScript(id)) {
        genericScriptRuns.push({
          id,
          spec: buildScriptLaunchSpec(bindings[id].scriptPath, { windowless: true, platform: 'win32', args: bindings[id].args }),
        });
        continue;
      }
      skippedServices.push(id);
    }
    const activeServices = [
      ...genericScriptRuns.map((run) => run.id),
      ...ctrlIds,
    ];
    if (activeServices.length === 0) {
      if (existsSync(filePath)) rmSync(filePath, { force: true });
      return { synced: true, filePath, activeServices: [], skippedServices, launchdSync };
    }
    mkdirSync(startupDir, { recursive: true });
    // Windows 命令行参数：含空格或分号的加双引号；VBS 字符串里的双引号再写成两个。
    const winArg = (value) => (/[\s;"]/.test(value) ? `"${String(value).replace(/"/g, '\\"')}"` : String(value));
    const vbsRun = (commandLine) => `sh.Run "${commandLine.replace(/"/g, '""')}", 0, False`;
    const lines = [
      `' Auto-generated by dsh-au for machine: ${safeHost}`,
      `' Services: ${activeServices.join(', ')}`,
      'Set sh = CreateObject("WScript.Shell")',
    ];
    for (const run of genericScriptRuns) {
      const argv = [run.spec.command, ...run.spec.args];
      lines.push(`sh.CurrentDirectory = "${run.spec.cwd.replace(/"/g, '""')}"`);
      lines.push(vbsRun(argv.map(winArg).join(' ')));
    }
    if (ctrlIds.length) {
      const python = resolveControllerPythonLaunch({ windowless: true });
      const pyBin = python.command.replace(/\\/g, '\\\\');
      const launcher = python.env.__PYVENV_LAUNCHER__;
      if (launcher) {
        lines.push(`sh.Environment("PROCESS")("__PYVENV_LAUNCHER__") = "${launcher.replace(/"/g, '""')}"`);
      }
      const ctrlDir = controllerRoot().replace(/\\/g, '\\\\');
      // 列表与无窗口补丁全部使用 Python 单引号字面量，避免 -c "..." 内部出现双引号被 Windows 命令行解析器剥离导致 NameError；
      // 同时兼容外部平台控制器是否已定义 boot_startup，缺失时自动回退逐项调用 control_service 静默启动。
      const pySvcList = `[${ctrlIds.map((id) => `'${String(id).replace(/['\\]/g, '')}'`).join(', ')}]`;
      const pyHeadlessPatch = "import os, subprocess; _op = subprocess.Popen; subprocess.Popen = (lambda *a, **kw: (kw.update({'creationflags': int(kw.get('creationflags', 0)) | getattr(subprocess, 'CREATE_NO_WINDOW', 0x08000000) | getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0x00000200) | getattr(subprocess, 'CREATE_BREAKAWAY_FROM_JOB', 0x01000000)}), kw.setdefault('errors', 'replace') if (kw.get('text') or kw.get('universal_newlines') or kw.get('encoding')) else None, _op(*a, **kw))[-1]) if os.name == 'nt' else _op";
      const pyInline = `import sys; sys.path.insert(0, '${ctrlDir}'); ${pyHeadlessPatch}; from backend.lanmiao import background_services as _bs; boot_startup = getattr(_bs, 'boot_startup', lambda ids: [_bs.control_service(s, 'start', notify=False) for s in ids]); boot_startup(${pySvcList})`;
      lines.push(`sh.CurrentDirectory = "${controllerRoot().replace(/"/g, '""')}"`);
      lines.push(`sh.Run """${pyBin}"" -X utf8 -c ""${pyInline.replace(/"/g, '\\""')}""", 0, False`);
    }
    writeFileSync(filePath, lines.join('\r\n'), 'utf8');
    return { synced: true, filePath, activeServices, skippedServices, launchdSync };
  } catch (err) {
    return { synced: false, filePath, activeServices: bootIds, skippedServices, launchdSync, error: err.message };
  }
}

/** 校验后台服务启停请求是否满足平台控制器安全门禁 */
/** JSON 是服务定义的唯一来源：云清单 services 与本机绑定 services 的 id 并集。 */
export function jsonServiceIds() {
  const cloud = readCloudManifest().manifest.services || {};
  const bindings = loadLocalBindings().services || {};
  return [...new Set([...Object.keys(cloud), ...Object.keys(bindings)])];
}

// 宿主运行期才知道的端口（如 DSH NEXT 每次启动端口都会变）；优先于 JSON 里登记的固定端口。
const runtimeServicePorts = new Map();

/** 由宿主在端口就绪后登记；port 非法时清除，回落到 JSON 登记值。 */
export function setRuntimeServicePort(serviceId, port) {
  if (Number.isInteger(port) && port > 0 && port < 65536) runtimeServicePorts.set(serviceId, port);
  else runtimeServicePorts.delete(serviceId);
}

/** 用运行期端口覆盖登记端口与健康地址，避免动态端口服务被误判为已停止。 */
export function applyRuntimeServicePort(entry) {
  const port = entry && runtimeServicePorts.get(entry.id);
  if (!port) return entry;
  return { ...entry, port, health: `http://127.0.0.1:${port}/`, runtimePort: true };
}

/**
 * 按 id 解析出一条服务定义。JSON 里没有这个 id 就当它不存在。
 * 代码里的内建目录只用于补"怎么启停"这类运行元数据（kind / serviceName / launchd），
 * 不负责让服务出现在列表里。
 */
export function resolveServiceDefinition(serviceId, options = {}) {
  const id = String(serviceId || '').trim();
  if (!id) return null;
  const bindings = options.bindings || loadLocalBindings().services || {};
  const cloud = options.cloud || readCloudManifest().manifest.services || {};
  const bound = bindings[id] || {};
  const def = cloud[id] || {};
  const base = SERVICES_CATALOG.find((item) => item.id === id) || null;
  if (!base && !Object.keys(bound).length && !Object.keys(def).length) return null;
  const launchdLabel = def.launcher?.label || bound.launcher?.label || base?.launchd?.label || '';
  const hasRunnableScript = isRunnableScriptPath(bound.scriptPath || '');
  const inferredControl = base?.control || (launchdLabel || hasRunnableScript ? 'full' : 'view');
  const control = Object.hasOwn(def, 'control') ? restrictServiceControl(inferredControl, def.control) : inferredControl;
  const dependsOn = bound.dependsOn || def.dependsOn || base?.dependsOn;
  return applyRuntimeServicePort(applyLocalBinding({
    ...(base || {}),
    id,
    name: def.name || bound.name || base?.name || id,
    description: def.description || bound.description || base?.description || '',
    health: def.health || bound.health || base?.health || '',
    // 端口可以直接写 JSON；没写就从 health 推导（applyLocalBinding 里做）。
    port: Number.isInteger(def.port) ? def.port : (Number.isInteger(bound.port) ? bound.port : (base?.port ?? null)),
    doc: def.doc || bound.doc || '',
    category: def.category || base?.category || 'external',
    ...(dependsOn ? { dependsOn } : {}),
    ...(launchdLabel ? { launchd: { label: launchdLabel } } : {}),
    // 有启动器或本机绑定了可执行 scriptPath 就能启停；什么都没有就只能看
    control,
    guard: base?.guard || '',
    running: null,
    status: 'checking',
    instances: [],
  }, bindings));
}

export function validateServiceControlRequest(serviceId, action, options = {}) {
  const entry = options.entry || resolveServiceDefinition(serviceId);
  if (!entry) return { ok: false, error: `未知后台服务: ${serviceId}` };
  if (entry.control === 'view') {
    return { ok: false, error: `${entry.name} 只在 JSON 里定义，没有启动器信息，暂不支持启停` };
  }
  if (!['start', 'stop', 'restart'].includes(action)) {
    return { ok: false, error: `不支持的控制动作: ${action}` };
  }
  if (entry.control === 'start-only' && action !== 'start') {
    return {
      ok: false,
      error: `${entry.name} 当前仅允许启动，不支持从面板停止或重启`,
    };
  }
  if (entry.needsDevice && (action === 'start' || action === 'restart') && !options.device) {
    return { ok: false, error: '请先输入或选择投屏设备序列号' };
  }
  return { ok: true, entry };
}

/**
 * 创建独立后台服务管理器：
 * 核心原则：所有受管服务进程完全独立于 DSH 与本插件生命周期，关闭或重载 DSH 绝不关闭任何服务。
 */
/**
 * 只读地从 Windows 监听端口提取实际运行文件，供「同步到本机」预填路径。
 * 返回值绝不含命令行参数（参数可能带凭据），找不到或不确定时返回空串。
 */
export async function detectLocalServicePathByPort(port) {
  if (process.platform !== 'win32' || !Number.isInteger(port) || port < 1 || port > 65535) return '';
  const script = [
    `$port = ${port}`,
    "$line = netstat -ano -p tcp | Select-String ('^(\\s*TCP\\s+)(127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\]|\\[::\\]):' + $port + '\\s+.*LISTENING\\s+(\\d+)\\s*$') | Select-Object -First 1",
    "if (-not $line) { exit 0 }",
    "$ownerPid = [int](($line.Line.Trim() -split '\\s+')[-1])",
    "$p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $ownerPid)",
    "if (-not $p) { exit 0 }",
    "[pscustomobject]@{ executable = [string]$p.ExecutablePath; commandLine = [string]$p.CommandLine } | ConvertTo-Json -Compress",
  ].join('; ');
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 2_000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const info = JSON.parse(output.trim());
        const executable = String(info?.executable || '').trim();
        const commandLine = String(info?.commandLine || '');
        // python/node 自身不是服务脚本；只采集它紧随其后的明确脚本路径。
        const quoted = [...commandLine.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
        const scriptPath = quoted.slice(1).find((value) => /\.(?:pyw?|m?js|exe)$/i.test(value));
        const candidate = scriptPath || executable;
        return resolve(candidate && existsSync(candidate) ? candidate : '');
      } catch { return resolve(''); }
    });
  });
}

export function createBackgroundServiceManager(options = {}) {
  let cachedList = null;
  let lastFetchMs = 0;
  let inflightPromise = null;
  const serviceEventLogOptions = options.serviceEventLog || {};
  const persistedEvents = readServiceEvents({ ...serviceEventLogOptions, limit: 80 });
  const nowMs = typeof options.now === 'function' ? options.now : Date.now;
  if (!(globalThis.__dshAuServiceRecovery instanceof Map)) {
    globalThis.__dshAuServiceRecovery = new Map();
  }
  const usesGlobalRecoveryState = !(options.recoveryState instanceof Map);
  const recoveryState = usesGlobalRecoveryState
    ? globalThis.__dshAuServiceRecovery
    : options.recoveryState;
  const readRecoveryScope = typeof options.recoveryScope === 'function'
    ? options.recoveryScope
    : () => loadLocalBindings().machineId || hostname();
  let currentRecoveryScope = '';
  const recoveryProbe = typeof options.recoveryProbe === 'function'
    ? options.recoveryProbe
    : () => listServices(true);
  const recoveryStart = typeof options.recoveryStart === 'function'
    ? options.recoveryStart
    : (serviceId, action) => controlService(serviceId, action, { keepLogs: true, source: 'recovery' });
  const recoverySuspensions = new Map();
  const recoveryGenerations = new Map();
  const recoveryStartsInFlight = new Map();
  const recoveryChainsInFlight = new Map();
  let recoveryManagerGeneration = 0;
  const recoveryRetryDelaysMs = [30_000, 2 * 60_000, 5 * 60_000];
  const recoveryAttemptWindowMs = 15 * 60_000;
  const recoveryStableResetMs = 5 * 60_000;
  let recoveryTickPromise = null;
  let recoveryDisposed = false;
  const serviceLogs = [
    { type: 'ok', text: '[后台服务管理] 服务进程与 DSH 完全解耦：关闭 DSH 不会关闭任何后台服务。' },
  ];
  const serviceLogsById = {};

  function appendLog(type, text, svcId = '') {
    const entry = { type, text: String(text || '') };
    serviceLogs.push(entry);
    if (serviceLogs.length > 100) serviceLogs.splice(0, serviceLogs.length - 100);
    if (svcId) {
      if (!Array.isArray(serviceLogsById[svcId])) serviceLogsById[svcId] = [];
      serviceLogsById[svcId].push(entry);
      if (serviceLogsById[svcId].length > 80) serviceLogsById[svcId].splice(0, serviceLogsById[svcId].length - 80);
    }
  }

  /** active binding 切换后清空旧机状态；同名服务必须在新 binding 下重新观察后才可恢复。 */
  function syncRecoveryScope() {
    const nextScope = String(readRecoveryScope() || 'default');
    const globalScope = usesGlobalRecoveryState ? String(globalThis.__dshAuServiceRecoveryScope || '') : '';
    const previousScope = currentRecoveryScope || globalScope;
    if ((previousScope && previousScope !== nextScope)
      || (usesGlobalRecoveryState && !previousScope && recoveryState.size > 0)) {
      recoveryManagerGeneration += 1;
      recoveryState.clear();
      recoveryGenerations.clear();
      recoverySuspensions.clear();
    }
    currentRecoveryScope = nextScope;
    if (usesGlobalRecoveryState) globalThis.__dshAuServiceRecoveryScope = nextScope;
    return nextScope;
  }

  function newRecoveryEntry({ manualSuppressed = false } = {}) {
    return {
      everRunning: false,
      manualSuppressed,
      consecutiveStopped: 0,
      attempts: [],
      nextRetryAt: 0,
      healthySince: null,
      lastStatus: 'unknown',
      breakerLoggedUntil: 0,
    };
  }

  function getRecoveryEntry(serviceId) {
    syncRecoveryScope();
    let entry = recoveryState.get(serviceId);
    if (!entry || typeof entry !== 'object') {
      entry = newRecoveryEntry();
      recoveryState.set(serviceId, entry);
    }
    if (!Array.isArray(entry.attempts)) entry.attempts = [];
    return entry;
  }

  function appendRecoveryEvent(event, serviceId, action, ok, message, source = 'recovery') {
    appendServiceEvent({ event, serviceId, action, ok, message, source }, serviceEventLogOptions);
    appendLog(ok ? 'ok' : 'prompt', `[服务自愈] ${message}`, serviceId);
  }

  function applyUserRecoveryIntent(serviceId, action, controlOptions) {
    const gate = validateServiceControlRequest(serviceId, action, controlOptions);
    if (!gate.ok) return;
    syncRecoveryScope();
    bumpRecoveryGeneration(serviceId);
    if (action === 'stop') {
      const state = getRecoveryEntry(serviceId);
      state.manualSuppressed = true;
      state.consecutiveStopped = 0;
      state.healthySince = null;
      appendRecoveryEvent('service.recovery.suppressed', serviceId, action, true, '用户主动停止，已暂停自动恢复', 'user');
    } else if (action === 'start' || action === 'restart') {
      recoveryState.set(serviceId, newRecoveryEntry());
      appendRecoveryEvent('service.recovery.reset', serviceId, action, true, '用户主动启动，等待重新确认运行后再布防', 'user');
    }
  }

  function bumpRecoveryGeneration(serviceId) {
    const next = (recoveryGenerations.get(serviceId) || 0) + 1;
    recoveryGenerations.set(serviceId, next);
    return next;
  }

  function recoveryToken(serviceId) {
    return {
      manager: recoveryManagerGeneration,
      service: recoveryGenerations.get(serviceId) || 0,
    };
  }

  function recoveryTokenIsCurrent(serviceId, token) {
    const state = recoveryState.get(serviceId);
    return !recoveryDisposed
      && token.manager === recoveryManagerGeneration
      && token.service === (recoveryGenerations.get(serviceId) || 0)
      && !recoverySuspensions.has(serviceId)
      && !state?.manualSuppressed;
  }

  async function waitForRecoveryIdle(serviceId) {
    const id = String(serviceId || '').trim();
    if (!id) return;
    const pending = [recoveryChainsInFlight.get(id), recoveryStartsInFlight.get(id)].filter(Boolean);
    if (pending.length > 0) await Promise.allSettled(pending);
  }

  async function waitForRecoveryMaintenanceIdle() {
    const pending = recoveryTickPromise;
    if (pending) await Promise.allSettled([pending]);
  }

  function suspendRecovery(serviceId) {
    const id = String(serviceId || '').trim();
    if (!id) return () => {};
    bumpRecoveryGeneration(id);
    recoverySuspensions.set(id, (recoverySuspensions.get(id) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (recoverySuspensions.get(id) || 1) - 1;
      if (remaining > 0) recoverySuspensions.set(id, remaining);
      else recoverySuspensions.delete(id);
    };
  }

  function disposeRecovery() {
    recoveryDisposed = true;
    recoveryManagerGeneration += 1;
    const pending = [...new Set([...recoveryChainsInFlight.values(), ...recoveryStartsInFlight.values()])];
    return Promise.allSettled(pending);
  }

  // DSH 重启后把最近的控制结果恢复到面板；日志写盘时已统一脱敏。
  for (const event of persistedEvents) {
    const time = typeof event.ts === 'string' ? event.ts.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z') : '';
    const action = event.action || event.event || 'event';
    appendLog(event.ok ? 'ok' : 'prompt', `[持久日志 ${time}] ${action}: ${event.message || ''}`, event.serviceId || '');
  }

  /** 读取当前前缀的 Worker 日志尾部；文件名由配置前缀白名单生成，避免把任意路径暴露进面板。 */
  function appendCursorWorkerLogTails(serviceId, maxAgeMs = 120_000) {
    if (serviceId !== 'cursor_workers') return;
    const prefix = resolveCursorWorkerPrefix(loadCursorWorkersConfig(), [hostname(), process.env.COMPUTERNAME, process.env.HOSTNAME]);
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(prefix)) return;
    const logDir = process.env.TEMP || process.env.TMP || tmpdir();
    let names = [];
    try {
      names = readdirSync(logDir).filter((name) => name.startsWith(`cursor-worker-${prefix}-`) && name.endsWith('.log'));
    } catch { return; }
    for (const name of names.sort()) {
      const logPath = path.join(logDir, name);
      try {
        const stats = statSync(logPath);
        if (maxAgeMs > 0 && Date.now() - stats.mtimeMs > maxAgeMs) continue;
        const size = stats.size;
        const length = Math.min(Math.max(size, 0), 2_000);
        if (length === 0) continue;
        const handle = openSync(logPath, 'r');
        const buffer = Buffer.alloc(length);
        try { readSync(handle, buffer, 0, length, Math.max(0, size - length)); } finally { closeSync(handle); }
        const tail = buffer.toString('utf8').trim();
        if (tail) appendLog('out', `[${name}]\n${tail}`, serviceId);
      } catch { /* 单个 Worker 日志不可读不影响控制结果 */ }
    }
  }


  /** 清理当前前缀残留的 Worker 日志文件，防止文件占用/写权限冲突与陈旧日志混入 */
  function cleanCursorWorkerLogs(prefix) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(prefix)) return;
    const logDir = process.env.TEMP || process.env.TMP || tmpdir();
    let names = [];
    try {
      names = readdirSync(logDir).filter((name) => name.startsWith("cursor-worker-" + prefix + "-") && name.endsWith(".log"));
    } catch { return; }
    for (const name of names) {
      try {
        rmSync(path.join(logDir, name), { force: true });
      } catch { /* 忽略无法删除的文件 */ }
    }
  }

  function hasControllerModule() {
    return hasControllerModuleAvailable();
  }

  // Windows 仍用外部平台控制器扫描运行态；结果随后只合并已登记 JSON 的服务，避免目录项越过登记直接展示。
  function hasControllerBackend() {
    return process.platform === 'win32' && hasControllerModule();
  }

  // 控制能力必须和后端真实能力一致；Mac 不再把仅能查看的服务伪装成可启动。
  function canControlService(serviceId) {
    return controlCapabilityFor(resolveServiceDefinition(serviceId) || { id: serviceId }).canControl;
  }

  // macOS 上带 launchd 描述的服务由 launchctl 直接接管；本机绑定了可执行 scriptPath 的服务跨平台直接可控。
  function controlCapabilityFor(entry) {
    if (process.platform === 'darwin' && entry?.launchd) return { canControl: true, controlReason: '' };
    if (isRunnableScriptPath(entry?.scriptPath)) return { canControl: true, controlReason: '' };
    return serviceControlCapability(entry.id, { entry });
  }

  async function probeFallbackList() {
    // 列表只来自 JSON（云清单 + 本机绑定），内建目录不再硬塞服务进来。
    const boundCatalog = jsonServiceIds().map((id) => resolveServiceDefinition(id)).filter(Boolean);
    const results = await Promise.all(boundCatalog.map(async (cat) => {
      // 平台专用服务在别的系统上直接判为未运行：macOS 的 5001 常被别的程序占着，
      // 硬探 HTTP 会白等满超时（实测 604ms）。
      if (cat.windowsOnly && process.platform !== 'win32') {
        return {
          ...cat,
          running: false,
          status: 'stopped',
          reason: '仅 Windows 可用',
          ...controlCapabilityFor(cat),
          instances: [],
        };
      }
      if (cat.id === 'cursor_workers' || cat.id === 'cloudflared') {
        return {
          ...cat,
          running: false,
          status: 'stopped',
          reason: cat.id === 'cloudflared' ? '未发现 cloudflared tunnel run 进程' : '未发现本机前缀 Worker 进程',
          ...controlCapabilityFor(cat),
          instances: [],
        };
      }
      const running = await probeServiceEndpointAlive(cat);
      return {
        ...cat,
        running,
        status: running ? 'healthy' : 'stopped',
        reason: running ? '端口监听或盘符就绪' : '未检测到运行实例',
        ...controlCapabilityFor(cat),
        instances: [],
      };
    }));
    const decorated = await decorateManagedProcessServices(results);
    return decorated.map((svc) => ({ ...svc, configPath: resolveServiceConfigPath(svc.configPath) }));
  }

  function fetchControllerList() {
    return new Promise((resolve) => {
      if (!hasControllerBackend()) {
        probeFallbackList().then(resolve);
        return;
      }
      const python = resolveControllerPythonLaunch();
      // 使用 ensure_ascii=True 输出纯 ASCII \uXXXX 转义，配合 PYTHONUTF8=1 彻底消除 Windows GBK 乱码
      const code = 'import json; from backend.lanmiao.background_services import list_services; print(json.dumps(list_services(), ensure_ascii=True))';
      const child = spawn(python.command, ['-X', 'utf8', '-c', code], {
        cwd: controllerRoot() || undefined,
        env: python.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
      }, 12000);
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (c) => { out += c; });
      child.on('error', () => {
        clearTimeout(timer);
        probeFallbackList().then(resolve);
      });
      child.on('close', async () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(out.trim());
          if (parsed && Array.isArray(parsed.services)) {
            const byId = new Map(parsed.services.map((s) => [s.id, s]));
            // 扫描器可报告全部内置服务，但面板只接收云清单或本机绑定已登记的服务。
            const registeredServices = jsonServiceIds().map((id) => resolveServiceDefinition(id)).filter(Boolean);
            const merged = await Promise.all(registeredServices.map(async (cat) => {
              const live = byId.get(cat.id);
              const capability = controlCapabilityFor(cat);
               const endpointAlive = !live?.running ? await probeServiceEndpointAlive(cat) : false;
              const running = Boolean(live?.running || endpointAlive);
              if (live) {
                return {
                  ...cat,
                  ...live,
                  name: cat.name,
                  configPath: cat.configPath,
                  guard: cat.guard,
                  running,
                  status: running ? (live.status === 'stopped' ? 'healthy' : live.status) : live.status,
                  reason: endpointAlive && !live.running ? '本地端口已监听或盘符已就绪' : live.reason,
                   ...capability,
                };
              }
              return {
                ...cat,
                running,
                status: running ? 'healthy' : 'stopped',
                reason: running ? '本地端口已监听或盘符已就绪' : '未运行',
                 ...capability,
                instances: [],
              };
            }));
            resolve(await decorateManagedProcessServices(merged));
            return;
          }
        } catch {}
        probeFallbackList().then(resolve);
      });
    });
  }

  function withResolvedPaths(list) {
    // 本机绑定优先：路径、端口、健康地址以当前云备份 sync/machines/<machineId>.json 为准。
    const bindings = loadLocalBindings().services;
    return (list || []).map((svc) => {
      // 绑定会写回登记端口，运行期端口必须在其后再覆盖一次。
      const bound = applyRuntimeServicePort(applyLocalBinding(svc, bindings));
      return { ...bound, configPath: resolveServiceConfigPath(bound.configPath), cacheDir: resolveServiceConfigPath(bound.cacheDir), scriptPath: resolveServiceConfigPath(bound.scriptPath || bound.script || '') };
    });
  }

  /** 真正去探测一轮，同一时刻只允许一个探测在飞。 */
  function refreshServices() {
    if (!inflightPromise) {
      inflightPromise = fetchControllerList().then((list) => {
        cachedList = withResolvedPaths(list);
        lastFetchMs = Date.now();
        inflightPromise = null;
        return cachedList;
      });
    }
    return inflightPromise;
  }

  /**
   * 用最新绑定与 state.json 立即重建展示列表，不等端口探测。
   * 缓存只保留运行态；服务名单和开关是 JSON SSOT，不能因缓存而慢一拍。
   * 新登记、尚未扫描过的服务先标为 checking，后台刷新完成后再补 running。
   */
  async function reEnrichServices() {
    if (!cachedList) return refreshServices();
    const bindings = loadLocalBindings().services;
    const cachedById = new Map(cachedList.map((svc) => [svc.id, svc]));
    return catalogSkeleton().map((skeleton) => {
      const cached = cachedById.get(skeleton.id);
      return applyRuntimeServicePort(applyLocalBinding(cached ? { ...skeleton, ...cached } : skeleton, bindings));
    });
  }

  /**
   * 冷启动骨架：先把 JSON 服务目录吐出来，running 标成未知。
   * 面板因此可以立刻画出来，探测结果随后由强制刷新补上。
   */
  function catalogSkeleton() {
    const bindings = loadLocalBindings().services;
    return jsonServiceIds()
      .map((id) => resolveServiceDefinition(id))
      .filter(Boolean)
      .map((svc) => applyRuntimeServicePort(applyLocalBinding({
        ...svc,
        configPath: resolveServiceConfigPath(svc.configPath),
        cacheDir: resolveServiceConfigPath(svc.cacheDir),
        scriptPath: resolveServiceConfigPath(svc.scriptPath || svc.script || ''),
        ...(isWindowsSystemBootService(svc.id) ? { systemBoot: windowsServiceBootState(svc.serviceName) } : {}),
        running: null,
        status: 'checking',
      }, bindings)));
  }

  async function listServices(force = false) {
    // 后台服务常驻运行，默认 1 小时内直接复用上次探测结果；仅超过 1 小时或手动刷新/启停服务时重新探测。
    const stale = !cachedList || Date.now() - lastFetchMs >= SERVICE_STATUS_CACHE_TTL_MS;
    if (!force && cachedList) {
      if (stale) void refreshServices();
      // 不返回陈旧 state：开关、绑定服务名单先从 JSON 立即合并，运行态直接复用缓存。
      return reEnrichServices();
    }
    // 冷启动连缓存都没有：先给带本机开关的骨架让面板立刻出来，后台静默完成首次探测。
    if (!force) {
      void refreshServices();
      return catalogSkeleton();
    }
    // 强制刷新（手动点击刷新按钮或服务启停后）必须等新结果。
    return refreshServices();
  }

  // 启停命令执行完必须对上活进程；只回「已执行」但看板仍停止算失败。
  async function settleControlResult(action, serviceId, res) {
    cachedList = await listServices(true);
    lastFetchMs = Date.now();
    const live = (cachedList || []).find((item) => item.id === serviceId);
    if (action === 'start' && !res?.skipped && !live?.running) {
      const err = res?.error || res?.message || live?.reason || '启动后仍未运行';
      appendLog('prompt', `[未就绪] ${err}`, serviceId);
      return { ok: false, error: err, message: err, running: false, instances: live?.instances || [] };
    }
    if (action === 'stop' && live?.running) {
      const err = res?.error || res?.message || '停止后进程仍在运行';
      appendLog('prompt', `[仍在运行] ${err}`, serviceId);
      return { ok: false, error: err, message: err, running: true, instances: live?.instances || [] };
    }
    // start/stop 的最终事实以验活为准：控制器可能在进程已达到目标状态后才报超时或枚举失败。
    // restart 无法只靠“仍在运行”证明真的重启过，仍严格保留控制器失败。
    const reachedTarget = (action === 'start' && Boolean(live?.running))
      || (action === 'stop' && !live?.running);
    const recoveredByObservation = res?.ok === false && action !== 'restart' && reachedTarget;
    if (recoveredByObservation) {
      const controllerError = res?.error || res?.message || '控制器返回失败';
      appendLog('ok', `[状态已确认] ${controllerError}；但目标状态已实际生效`, serviceId);
    }
    const ok = res?.ok !== false || recoveredByObservation;
    const message = recoveredByObservation
      ? (action === 'start' ? '已启动并确认在运行（控制器诊断已记录）' : '已停止（控制器诊断已记录）')
      : (res?.message
        || (ok
          ? (action === 'start' ? '已启动并确认在运行' : action === 'stop' ? '已停止' : '控制完成')
          : (res?.error || '服务控制失败')));
    return {
      ok,
      skipped: Boolean(res?.skipped),
      message,
      error: ok ? '' : (res?.error || message),
      warning: recoveredByObservation ? (res?.error || res?.message || '控制器返回失败') : '',
      running: Boolean(live?.running),
      instances: live?.instances || [],
    };
  }

  async function controlServiceImpl(serviceId, action, options = {}) {
    if (!options.keepLogs) {
      serviceLogsById[serviceId] = [];
    }
    const check = validateServiceControlRequest(serviceId, action, options);
    if (!check.ok) {
      appendLog('prompt', `[安全门禁拦截] ${check.error}`, serviceId);
      return { ok: false, error: check.error };
    }
    const entry = applyLocalBinding(check.entry);
    const capability = controlCapabilityFor(entry);
    // 先写入命令日志；长时间的 Worker 检查期间，前端轮询可以立即显示反馈。
    appendLog('cmd', `[服务控制] ${entry.name} (${serviceId}) -> ${action}`, serviceId);

    if (!capability.canControl) {
      appendLog('prompt', `[提示] ${capability.controlReason}`, serviceId);
      return { ok: false, error: capability.controlReason };
    }

    if (serviceId === 'cloudflared') {
      const res = await controlCloudflaredService(action, options);
      appendLog(res.ok ? 'ok' : 'prompt', `[${entry.name}] ${res.message || res.error || ''}`, serviceId);
      lastFetchMs = Date.now();
      return settleControlResult(action, serviceId, res);
    }

    // 启动前先做存活判断：已有 Worker/端口时绝不重复拉起，并把实例写回列表。
    if (action === 'start') {
      if (serviceId === 'cursor_workers') {
        const instances = await listCursorWorkerInstances();
        if (instances.length) {
          const msg = `已在运行 ${instances.length} 个 Worker: ${formatCursorWorkerNames(instances)}。未重复启动`;
          appendLog('ok', `[跳过启动] ${msg}`, serviceId);
          appendCursorWorkerLogTails(serviceId);
          cachedList = await decorateManagedProcessServices(cachedList || SERVICES_CATALOG);
          lastFetchMs = Date.now();
          return { ok: true, skipped: true, message: msg, error: '', instances };
        }
        const prefix = resolveCursorWorkerPrefix(loadCursorWorkersConfig(), [hostname(), process.env.COMPUTERNAME, process.env.HOSTNAME]);
        cleanCursorWorkerLogs(prefix);
      } else {
        const endpointUp = await probeServiceEndpointAlive(entry);
        const snapshot = endpointUp ? null : await listServices(true);
        const alreadyRunning = endpointUp || Boolean(snapshot?.find((s) => s.id === serviceId)?.running);
        if (alreadyRunning) {
          const msg = '服务已在运行中，复用现有实例，未重复启动';
          appendLog('ok', `[跳过启动] ${entry.name} (${serviceId}): ${msg}`, serviceId);
          return { ok: true, skipped: true, message: msg, error: '' };
        }
      }
    }

    // macOS 原生通路：有 launchd 描述且 plist 存在（或未配可执行脚本）时用 launchctl；若无 plist 但绑定了 scriptPath 则直接跑脚本。
    if (process.platform === 'darwin' && entry.launchd) {
      const plist = resolveLaunchdPlistPath(entry);
      if (existsSync(plist) || !isRunnableScriptPath(entry.scriptPath)) {
        const macResult = await controlMacLaunchdService(entry, action);
        appendLog(macResult.ok ? 'ok' : 'prompt', `[${entry.name}] ${macResult.message}`, serviceId);
        return { ok: macResult.ok, message: macResult.message, error: macResult.ok ? '' : macResult.message };
      }
    }

    if (process.platform === 'darwin' && !entry.launchd) {
      const target = resolveMacUserLaunchdTarget(serviceId, { ...options, bindings: options.bindings });
      if (target.ok && (existsSync(target.plistPath) || !isRunnableScriptPath(entry.scriptPath))) {
        const res = await controlMacUserLaunchdService(serviceId, action, options);
        appendLog(res.ok ? 'ok' : 'prompt', `[${entry.name}] ${res.message || res.error || ''}`, serviceId);
        return settleControlResult(action, serviceId, res);
      }
    }

    // 通用脚本直控通路：非外部平台控制器专管服务，或当前环境无控制器模块时，只要登记了可执行 scriptPath 即可跨平台启停。
    const usePlatformController = usesControllerService(serviceId, options);
    if (!usePlatformController && isRunnableScriptPath(entry.scriptPath)) {
      const res = await controlScriptPathService(entry, action, options);
      appendLog(res.ok ? 'ok' : 'prompt', `[${entry.name}] ${res.message}`, serviceId);
      lastFetchMs = Date.now();
      return settleControlResult(action, serviceId, { ...res, error: res.ok ? '' : res.message });
    }

    return new Promise((resolve) => {
      const python = resolveControllerPythonLaunch();
      const pidArg = Number.isInteger(options.pid) && options.pid > 0 ? options.pid : 'None';
      const devArg = options.device ? JSON.stringify(String(options.device)) : 'None';
      const code = [
        WIN_HEADLESS_POPEN_PATCH,
        'import json',
        'from backend.lanmiao.background_services import control_service',
        `res = control_service(${JSON.stringify(serviceId)}, ${JSON.stringify(action)}, pid=${pidArg}, device=${devArg}, notify=False)`,
        "print(json.dumps({'ok': bool(res.get('success')), 'message': str(res.get('message', ''))}, ensure_ascii=True))",
      ].join('\n');
      // Windows 下短生命周期控制器仅启用 windowsHide: true（CREATE_NO_WINDOW），避免触发 DETACHED_PROCESS 导致 venv python.exe 弹出黑框
      // 实际常驻服务由 background_services.py 内部以 CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB 无头分离拉起
      const child = spawn(python.command, ['-X', 'utf8', '-c', code], {
        cwd: controllerRoot() || undefined,
        env: python.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let errOut = '';
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (c) => { out += c; });
      child.stderr?.on('data', (c) => { errOut += c; });
      child.on('error', (err) => {
        appendLog('prompt', `[控制异常] ${err.message}`, serviceId);
        resolve({ ok: false, error: err.message });
      });
      child.on('close', async () => {
        let parsed = { ok: false, message: '未返回控制结果' };
        try {
          const lines = out.trim().split(/\r?\n/);
          parsed = JSON.parse(lines[lines.length - 1]);
        } catch {
          if (out.trim()) appendLog('prompt', `[控制器输出] ${out.trim().slice(-2000)}`, serviceId);
        }
        const stderr = errOut.trim();
        if (stderr) appendLog('prompt', `[控制器错误] ${stderr.slice(-4000)}`, serviceId);
        appendLog(parsed.ok ? 'ok' : 'prompt', `[${entry.name}] ${parsed.message || parsed.error || '未返回控制结果'}`, serviceId);
        if (serviceId === 'cursor_workers' && action === 'start' && parsed.ok) {
          appendCursorWorkerLogTails(serviceId);
        }
        resolve(await settleControlResult(action, serviceId, parsed));
      });
    });
  }

  /** 统一记录所有控制入口与最终结果；写盘失败由日志模块内部吞掉，不影响控制语义。 */
  async function controlService(serviceId, action, options = {}) {
    const source = typeof options.source === 'string' && options.source ? options.source : 'system';
    appendServiceEvent({
      event: 'service.control.request',
      serviceId,
      action,
      ok: true,
      message: `请求执行 ${action}`,
      source,
    }, serviceEventLogOptions);
    if (source === 'user') {
      applyUserRecoveryIntent(serviceId, action, options);
      // 用户控制必须排在已发出的恢复启动之后，确保 stop 成为最终状态。
      await waitForRecoveryIdle(serviceId);
    }
    try {
      const result = await controlServiceImpl(serviceId, action, options);
      const firstPid = result?.instances?.find((item) => Number.isSafeInteger(item?.pid) && item.pid > 0)?.pid;
      appendServiceEvent({
        event: 'service.control.result',
        serviceId,
        action,
        ok: result?.ok === true,
        message: result?.message || result?.error || '未返回控制结果',
        pid: firstPid,
        source,
      }, serviceEventLogOptions);
      return result;
    } catch (error) {
      appendServiceEvent({
        event: 'service.control.result',
        serviceId,
        action,
        ok: false,
        message: error?.message || String(error),
        source,
      }, serviceEventLogOptions);
      throw error;
    }
  }

  function recoveryDependencies(serviceId) {
    const entry = resolveServiceDefinition(serviceId) || SERVICES_CATALOG.find((item) => item.id === serviceId);
    const raw = entry?.dependsOn;
    return (Array.isArray(raw) ? raw : [raw])
      .map((id) => String(id || '').trim())
      .filter(Boolean);
  }

  function orderRecoveryServices(serviceIds) {
    const eligible = new Set(serviceIds);
    const ordered = [];
    const visited = new Set();
    const visiting = new Set();
    const visit = (serviceId) => {
      if (visited.has(serviceId) || visiting.has(serviceId)) return;
      visiting.add(serviceId);
      for (const dependencyId of recoveryDependencies(serviceId)) {
        if (eligible.has(dependencyId)) visit(dependencyId);
      }
      visiting.delete(serviceId);
      visited.add(serviceId);
      ordered.push(serviceId);
    };
    for (const serviceId of serviceIds) visit(serviceId);
    return ordered;
  }

  function recoveryTrackedServices(serviceIds) {
    const tracked = new Set();
    const visit = (serviceId) => {
      if (tracked.has(serviceId)) return;
      tracked.add(serviceId);
      for (const dependencyId of recoveryDependencies(serviceId)) visit(dependencyId);
    };
    for (const serviceId of serviceIds) visit(serviceId);
    return tracked;
  }

  async function startRecoveryChain(serviceId, liveById, startedThisTick, visiting = new Set()) {
    if (startedThisTick.has(serviceId)) {
      const latestState = recoveryState.get(serviceId);
      if (latestState?.manualSuppressed || recoverySuspensions.has(serviceId)) {
        return { ok: false, cancelled: true, error: `${serviceId} 已被手动停止或暂时挂起` };
      }
      return startedThisTick.get(serviceId);
    }
    const token = recoveryToken(serviceId);
    if (!recoveryTokenIsCurrent(serviceId, token)) return { ok: false, cancelled: true, error: `${serviceId} 恢复已失效或暂停` };
    if (visiting.has(serviceId)) return { ok: false, error: `服务依赖存在循环: ${[...visiting, serviceId].join(' -> ')}` };
    visiting.add(serviceId);
    for (const dependencyId of recoveryDependencies(serviceId)) {
      const dependencyState = recoveryState.get(dependencyId);
      if (dependencyState?.manualSuppressed || recoverySuspensions.has(dependencyId)) {
        visiting.delete(serviceId);
        return { ok: false, error: `依赖 ${dependencyId} 已被手动停止或暂时挂起` };
      }
      if (liveById.get(dependencyId) !== true) {
        const dependencyResult = await startRecoveryChain(dependencyId, liveById, startedThisTick, visiting);
        if (!recoveryTokenIsCurrent(serviceId, token)) {
          visiting.delete(serviceId);
          return { ok: false, cancelled: true, error: `${serviceId} 恢复在依赖启动期间被取消` };
        }
        const latestDependencyState = recoveryState.get(dependencyId);
        if (latestDependencyState?.manualSuppressed || recoverySuspensions.has(dependencyId)) {
          visiting.delete(serviceId);
          return { ok: false, cancelled: true, error: `依赖 ${dependencyId} 已在启动期间被手动停止或暂时挂起` };
        }
        const dependencyReady = dependencyResult?.ok === true
          && (dependencyResult.running === true || dependencyResult.skipped === true);
        if (!dependencyReady) {
          visiting.delete(serviceId);
          return { ok: false, error: `依赖 ${dependencyId} 未确认运行: ${dependencyResult?.error || dependencyResult?.message || '启动失败'}` };
        }
        liveById.set(dependencyId, true);
      }
    }
    visiting.delete(serviceId);
    if (!recoveryTokenIsCurrent(serviceId, token)) return { ok: false, cancelled: true, error: `${serviceId} 恢复在启动前被取消` };

    const pendingStart = (async () => {
      try {
        return await recoveryStart(serviceId, 'start');
      } catch (error) {
        return { ok: false, error: error?.message || String(error) };
      }
    })();
    recoveryStartsInFlight.set(serviceId, pendingStart);
    let result;
    try {
      result = await pendingStart;
    } finally {
      if (recoveryStartsInFlight.get(serviceId) === pendingStart) recoveryStartsInFlight.delete(serviceId);
    }
    if (!recoveryTokenIsCurrent(serviceId, token)) {
      result = { ok: false, cancelled: true, error: `${serviceId} 恢复结果已因用户控制、Doctor 或插件销毁失效` };
    }
    startedThisTick.set(serviceId, result);
    return result;
  }

  /**
   * 仅恢复本次 DSH 生命周期内确认运行过、随后连续两轮明确停止的开机自启服务。
   * 冷启动即停止、探测未知、用户主动停止、Doctor 暂停与插件销毁都不会触发启动。
   */
  function reconcileBootRecovery(profile) {
    if (recoveryDisposed) return Promise.resolve({ ok: false, skipped: 'disposed', attempted: [], blocked: [] });
    if (recoveryTickPromise) return recoveryTickPromise;
    recoveryTickPromise = (async () => {
      const tickScope = syncRecoveryScope();
      const tickGeneration = recoveryManagerGeneration;
      const tickIsCurrent = () => !recoveryDisposed
        && tickScope === currentRecoveryScope
        && tickGeneration === recoveryManagerGeneration;
      const staleTick = () => ({ ok: false, skipped: 'scope-changed', attempted: [], blocked: [] });
      const enabled = new Set(profile?.enabled || []);
      const eligibleIds = [...new Set((profile?.autoStartOnBoot || []).filter((id) => enabled.has(id)))];
      const trackedServices = recoveryTrackedServices(eligibleIds);
      for (const serviceId of recoveryState.keys()) {
        if (!trackedServices.has(serviceId)) recoveryState.delete(serviceId);
      }

      let services;
      try {
        services = await recoveryProbe();
      } catch (error) {
        if (!tickIsCurrent()) return staleTick();
        const message = `状态探测失败，未执行恢复: ${error?.message || String(error)}`;
        appendRecoveryEvent('service.recovery.probe', '', 'probe', false, message);
        return { ok: false, error: message, attempted: [], blocked: [] };
      }
      if (!tickIsCurrent()) return staleTick();

      const liveById = new Map((Array.isArray(services) ? services : []).map((service) => [service.id, service.running]));
      const attempted = [];
      const blocked = [];
      const startedThisTick = new Map();

      for (const serviceId of orderRecoveryServices(eligibleIds)) {
        if (!tickIsCurrent()) return staleTick();
        const state = getRecoveryEntry(serviceId);
        const timestamp = Number(nowMs());
        const running = liveById.get(serviceId);
        state.attempts = state.attempts.filter((attemptAt) => Number.isFinite(attemptAt)
          && attemptAt <= timestamp && timestamp - attemptAt < recoveryAttemptWindowMs);

        if (running === true) {
          if (!state.everRunning) {
            appendRecoveryEvent('service.recovery.armed', serviceId, 'observe', true, '已确认服务运行，异常退出恢复已布防');
          }
          if (state.lastStatus !== 'running') state.healthySince = timestamp;
          state.everRunning = true;
          state.consecutiveStopped = 0;
          state.lastStatus = 'running';
          state.breakerLoggedUntil = 0;
          if (state.attempts.length > 0 && Number.isFinite(state.healthySince)
            && timestamp - state.healthySince >= recoveryStableResetMs) {
            state.attempts = [];
            state.nextRetryAt = 0;
            appendRecoveryEvent('service.recovery.stable', serviceId, 'observe', true, '连续健康 5 分钟，已清除恢复计数');
          }
          continue;
        }

        if (running !== false) {
          state.consecutiveStopped = 0;
          state.healthySince = null;
          state.lastStatus = 'unknown';
          continue;
        }
        state.healthySince = null;
        state.lastStatus = 'stopped';
        if (!state.everRunning || state.manualSuppressed || recoverySuspensions.has(serviceId)) {
          state.consecutiveStopped = 0;
          continue;
        }

        state.consecutiveStopped += 1;
        if (state.consecutiveStopped < 2 || timestamp < state.nextRetryAt) continue;
        if (state.attempts.length >= 3) {
          const blockedUntil = state.attempts[0] + recoveryAttemptWindowMs;
          blocked.push({ serviceId, reason: 'attempt-limit', until: blockedUntil });
          if (state.breakerLoggedUntil !== blockedUntil) {
            state.breakerLoggedUntil = blockedUntil;
            appendRecoveryEvent('service.recovery.blocked', serviceId, 'start', false, '15 分钟内已恢复 3 次，暂停自动启动');
          }
          continue;
        }

        state.attempts.push(timestamp);
        state.nextRetryAt = timestamp + recoveryRetryDelaysMs[Math.min(state.attempts.length - 1, recoveryRetryDelaysMs.length - 1)];
        state.consecutiveStopped = 0;
        appendRecoveryEvent('service.recovery.attempt', serviceId, 'start', true, `检测到异常退出，执行第 ${state.attempts.length} 次恢复`);
        const recoveryChain = startRecoveryChain(serviceId, liveById, startedThisTick);
        recoveryChainsInFlight.set(serviceId, recoveryChain);
        let result;
        try {
          result = await recoveryChain;
        } finally {
          if (recoveryChainsInFlight.get(serviceId) === recoveryChain) recoveryChainsInFlight.delete(serviceId);
        }
        const ok = result?.ok === true;
        const message = result?.message || result?.error || (ok ? '恢复启动已提交' : '恢复启动失败');
        attempted.push({ serviceId, ok, message });
        appendRecoveryEvent('service.recovery.result', serviceId, 'start', ok, message);
      }
      return { ok: attempted.every((item) => item.ok), attempted, blocked };
    })().finally(() => {
      recoveryTickPromise = null;
    });
    return recoveryTickPromise;
  }

  /**
   * DSH 启动时按当前电脑配置无头静默拉起勾选了「随 DSH 自启」的服务：
   * 1. 启动前严格判断进程、端口与盘符，已运行的服务绝不重复启动；
   * 2. 全程使用 CREATE_NO_WINDOW + SW_HIDE 无头静默执行，零终端弹窗；
   * 3. DSH 关闭或插件卸载时绝不调用 stop。
   */
  async function triggerDshAutoStart(profile, currentHost = '') {
    const hostKey = String(currentHost || 'default').toLowerCase();
    if (!globalThis.__dshAuAutoStartedHosts) {
      globalThis.__dshAuAutoStartedHosts = new Set();
    }
    if (globalThis.__dshAuAutoStartedHosts.has(hostKey)) {
      return [];
    }
    globalThis.__dshAuAutoStartedHosts.add(hostKey);

    const enabledSet = new Set(profile?.enabled || []);
    const toStart = (profile?.autoStartOnDsh || []).filter((id) => enabledSet.has(id));
    if (toStart.length === 0) return [];
    const currentList = await listServices(true);
    const pending = [];
    for (const svcId of toStart) {
      const live = currentList.find((s) => s.id === svcId);
      const entry = resolveServiceDefinition(svcId) || SERVICES_CATALOG.find((s) => s.id === svcId);
      if (live?.running || (await probeServiceEndpointAlive(live || entry))) {
        continue;
      }
      pending.push(svcId);
    }
    if (pending.length === 0) {
      appendLog('ok', `[随 DSH 自启] 电脑 ${currentHost || '本机'} 的 ${toStart.length} 项自启服务均已在运行中，无需重复启动。`);
      return [];
    }
    appendLog('ok', `[随 DSH 自启] 正在无头拉起 ${pending.length} 项未运行服务: ${pending.join(', ')}`);
    const started = [];
    for (const svcId of pending) {
      const res = await controlService(svcId, 'start', { keepLogs: true, source: 'dsh-autostart' });
      if (res?.ok && !res?.skipped) started.push(svcId);
    }
    return started;
  }

  function getLogs() {
    return [...serviceLogs];
  }

  function getLogsById() {
    const out = {};
    for (const [k, v] of Object.entries(serviceLogsById)) {
      out[k] = Array.isArray(v) ? [...v] : [];
    }
    return out;
  }

  return {
    listServices,
    reEnrichServices,
    controlService,
    triggerDshAutoStart,
    reconcileBootRecovery,
    suspendRecovery,
    waitForRecoveryIdle,
    waitForRecoveryMaintenanceIdle,
    refreshRecoveryScope: syncRecoveryScope,
    disposeRecovery,
    getLogs,
    getLogsById,
  };
}



