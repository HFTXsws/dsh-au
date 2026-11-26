import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { PLUGIN_ROOT, getRepoRoot, hasSyncRepo, resolveSyncDir, syncRepoUnavailableMessage } from './sync-repo.js';

export const REPO_ROOT = PLUGIN_ROOT;
const repoRoot = () => getRepoRoot();

/** 归一化系统平台标识：仅区分 Windows (win32) 与 macOS (darwin) */
export function normalizePlatformOs(rawPlatform = process.platform) {
  return rawPlatform === 'darwin' ? 'darwin' : 'win32';
}

function expandUserPath(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homedir(), value.slice(2));
  return value;
}

function normalizeScriptBaseDir(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!trimmed || /^[A-Za-z]:/.test(trimmed)) return '';
  const segments = trimmed.split('/').filter(Boolean);
  if (segments.length === 0 || segments.includes('..') || segments.includes('.')) return '';
  return segments.join('/');
}

/**
 * 解析菜单脚本：~/、绝对路径（含盘符）、相对私人仓库根；
 * 无斜杠且仓库根下不存在时，仅当声明了 scriptBaseDir 才拼到 <repoRoot>/<scriptBaseDir>/。
 */
export function resolveMenuScriptPath(item, platformOs = normalizePlatformOs(), options = {}) {
  const isWin = platformOs === 'win32';
  const ext = item?.runner === 'platform' ? (isWin ? '.ps1' : '.sh') : '';
  const rawScript = String(item?.script || '').trim();
  const raw = `${rawScript}${ext}`;
  const expanded = expandUserPath(raw);
  if (!expanded) return '';
  if (path.isAbsolute(expanded) || /^[A-Za-z]:[\\/]/.test(expanded)) return expanded;
  const root = getRepoRoot();
  const fromRoot = path.join(root, expanded);
  if (existsSync(fromRoot)) return fromRoot;
  const baseDir = normalizeScriptBaseDir(options?.scriptBaseDir ?? item?.scriptBaseDir);
  if (!/[\\/]/.test(rawScript) && baseDir) return path.join(root, baseDir, expanded);
  return fromRoot;
}

function displayMenuScriptRef(scriptPath) {
  const root = getRepoRoot();
  const rel = path.relative(root, scriptPath).replace(/\\/g, '/');
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  return scriptPath.replace(/\\/g, '/');
}

/** 把 Windows PowerShell 可执行路径收成预览/前端用的命令名。 */
function windowsPowerShellName(psCommand = '') {
  return /pwsh/i.test(path.basename(String(psCommand))) ? 'pwsh' : 'powershell';
}

/** Windows 上优先 pwsh（PATH 或常见安装目录），找不到再回退 powershell。 */
export function resolveWindowsPowerShellCommand(options = {}) {
  const env = options.env || process.env;
  const existsRaw = options.exists || existsSync;
  // WindowsApps AppExecutionAlias、不可读 PATH 目录会让 existsSync 抛错，当作不存在继续回退。
  const exists = (filePath) => {
    try {
      return Boolean(existsRaw(filePath));
    } catch {
      return false;
    }
  };
  const pathValue = String(env.PATH || env.Path || '');
  const dirs = pathValue.split(path.delimiter).filter(Boolean).map((dir) => dir.replace(/^"|"$/g, ''));
  for (const dir of dirs) {
    let pwshExe = '';
    let pwshBin = '';
    try {
      pwshExe = path.join(dir, 'pwsh.exe');
      pwshBin = path.join(dir, 'pwsh');
    } catch {
      continue;
    }
    if (exists(pwshExe) || exists(pwshBin)) return 'pwsh';
  }
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = env.LOCALAPPDATA || '';
  const candidates = [
    path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    path.join(programFiles, 'PowerShell', '7-preview', 'pwsh.exe'),
    path.join(programFilesX86, 'PowerShell', '7', 'pwsh.exe'),
    localAppData ? path.join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe') : '',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return 'powershell';
}

function visibleMenuParams(item, platformOs) {
  return (Array.isArray(item?.params) ? item.params : []).filter((param) => !param.platform || param.platform === platformOs);
}

function menuParamOptions(param, platformOs) {
  return (Array.isArray(param?.options) ? param.options : []).filter((opt) => !opt.platform || opt.platform === platformOs);
}

function menuParamFlag(param, isWin) {
  if (isWin) {
    if (Object.hasOwn(param, 'winFlag')) return param.winFlag;
    if (Object.hasOwn(param, 'posixFlag')) return param.posixFlag;
    return '';
  }
  if (Object.hasOwn(param, 'posixFlag')) return param.posixFlag;
  if (Object.hasOwn(param, 'winFlag')) return param.winFlag;
  return '';
}

function isMenuParamTrue(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function resolveMenuParamValue(param, params = {}, platformOs = normalizePlatformOs()) {
  const raw = params && Object.hasOwn(params, param.name) ? params[param.name] : param.defaultValue;
  if (param.type === 'select') {
    const values = menuParamOptions(param, platformOs).map((opt) => opt.value);
    if (values.includes(raw)) return raw;
    if (values.includes(param.defaultValue)) return param.defaultValue;
    return values[0];
  }
  if (param.type === 'multiselect') {
    const allowed = new Set(menuParamOptions(param, platformOs).map((opt) => opt.value));
    const list = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw ? raw.split(',') : []);
    return list.filter((value) => allowed.has(value));
  }
  if (param.type === 'boolean') return isMenuParamTrue(raw);
  return raw == null ? '' : raw;
}

function appendMenuParamArgs(extraArgs, param, value, isWin) {
  if (param.type === 'boolean') {
    if (!isMenuParamTrue(value)) return;
    const flag = menuParamFlag(param, isWin);
    if (flag) extraArgs.push(flag);
    else extraArgs.push('true');
    return;
  }
  if (param.type === 'multiselect') {
    const joined = Array.isArray(value) ? value.filter(Boolean).join(',') : String(value || '');
    if (!joined && !param.required) return;
    const flag = menuParamFlag(param, isWin);
    if (flag) extraArgs.push(flag, joined);
    else extraArgs.push(joined);
    return;
  }
  const text = value == null ? '' : String(value).trim();
  if (!text && !param.required) return;
  const flag = menuParamFlag(param, isWin);
  if (flag) extraArgs.push(flag, text);
  else extraArgs.push(text);
}

/** 按 item.params 声明把用户选择拼成命令行参数。 */
export function buildMenuParamArgList(item, params = {}, platformOs = normalizePlatformOs()) {
  const isWin = platformOs === 'win32';
  const extraArgs = [...(item?.args || [])];
  for (const param of visibleMenuParams(item, platformOs)) {
    appendMenuParamArgs(extraArgs, param, resolveMenuParamValue(param, params, platformOs), isWin);
  }
  return extraArgs;
}

function resolveProfilesManifestMenuFile() {
  const envPath = String(process.env.DSH_AU_PROFILES_MANIFEST_PATH || '').trim();
  const manifestPath = envPath || path.join(resolveSyncDir(), 'cloud', 'dsh-profiles.json');
  if (!existsSync(manifestPath)) return '';
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
    const raw = typeof parsed?.menuFile === 'string' ? parsed.menuFile.trim() : '';
    if (!raw) return '';
    const normalized = raw.replace(/\\/g, '/');
    if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) return '';
    const segments = normalized.split('/').filter(Boolean);
    if (segments.length === 0 || segments.includes('..')) return '';
    const root = getRepoRoot();
    const resolved = path.resolve(root, ...segments);
    const rel = path.relative(root, resolved);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
    return resolved;
  } catch {
    return '';
  }
}

function resolveMenuJsonPath() {
  const syncMenu = path.join(resolveSyncDir(), 'menu.json');
  if (existsSync(syncMenu)) return syncMenu;
  return resolveProfilesManifestMenuFile();
}

/** 读取私人仓库 menu.json；未配置时不静默读插件目录，也不回退旧目录约定。 */
export function loadMenuSpec(platformOs = normalizePlatformOs()) {
  // win32 下告诉前端实际用的是 pwsh 还是 powershell，避免预览严等对不上把结果清空。
  const psCommandName = platformOs === 'win32'
    ? windowsPowerShellName(resolveWindowsPowerShellCommand())
    : '';
  if (!hasSyncRepo()) {
    return {
      platformOs,
      configured: false,
      message: syncRepoUnavailableMessage(),
      groups: [],
      psCommandName,
      sourceLabel: '',
    };
  }
  const menuPath = resolveMenuJsonPath();
  let raw = { version: 1, groups: [] };
  let loaded = false;
  if (menuPath && existsSync(menuPath)) {
    try {
      raw = JSON.parse(readFileSync(menuPath, 'utf8').replace(/^\uFEFF/, ''));
      loaded = true;
    } catch { /* 坏文件当空菜单，面板仍能打开 */ }
  }
  const topScriptBaseDir = normalizeScriptBaseDir(raw?.scriptBaseDir);
  const groups = (raw.groups || []).map((group, idx) => ({
    id: `g_${idx + 1}`,
    title: group.title,
    items: (group.items || []).map((item) => {
      const itemBaseDir = normalizeScriptBaseDir(item?.scriptBaseDir) || topScriptBaseDir;
      const itemWithBaseDir = itemBaseDir ? { ...item, scriptBaseDir: itemBaseDir } : { ...item };
      const scriptPath = resolveMenuScriptPath(itemWithBaseDir, platformOs, { scriptBaseDir: itemBaseDir });
      return {
        ...itemWithBaseDir,
        resolvedScript: displayMenuScriptRef(scriptPath),
      };
    }),
  }));
  return {
    platformOs,
    configured: true,
    message: '',
    groups,
    psCommandName,
    sourceLabel: loaded ? displayMenuScriptRef(menuPath) : '',
  };
}

/** 按系统与声明式 params 构造菜单命令参数与可读命令行 */
export function buildMenuCommandArgs(item, params = {}, platformOs = normalizePlatformOs(), options = {}) {
  const isWin = platformOs === 'win32';
  const extraArgs = buildMenuParamArgList(item, params, platformOs);
  const scriptBaseDir = normalizeScriptBaseDir(options?.scriptBaseDir ?? item?.scriptBaseDir);
  const scriptPath = resolveMenuScriptPath(item, platformOs, scriptBaseDir ? { scriptBaseDir } : {});
  const display = displayMenuScriptRef(scriptPath);

  if (item.runner === 'node') {
    return {
      command: process.execPath,
      args: [scriptPath, ...extraArgs],
      preview: `node ${display}${extraArgs.length ? ' ' + extraArgs.join(' ') : ''}`,
    };
  }
  if (item.runner === 'python') {
    const pyBin = isWin ? 'python' : 'python3';
    return {
      command: pyBin,
      args: [scriptPath, ...extraArgs],
      preview: `${pyBin} ${display}${extraArgs.length ? ' ' + extraArgs.join(' ') : ''}`,
    };
  }
  if (isWin) {
    const psCommand = resolveWindowsPowerShellCommand();
    const psName = windowsPowerShellName(psCommand);
    const psQuote = (arg) => (/[\s"']/u.test(String(arg)) ? `'${String(arg).replace(/'/g, "''")}'` : String(arg));
    const invokeExpr = `& ${psQuote(scriptPath)}${extraArgs.length ? ' ' + extraArgs.map(psQuote).join(' ') : ''}`;
    return {
      command: psCommand,
      args: [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; ${invokeExpr}`,
      ],
      preview: `${psName} -NoProfile -ExecutionPolicy Bypass -File ${display}${extraArgs.length ? ' ' + extraArgs.join(' ') : ''}`,
    };
  }
  return {
    command: 'bash',
    args: [scriptPath, ...extraArgs],
    preview: `bash ${display}${extraArgs.length ? ' ' + extraArgs.join(' ') : ''}`,
  };
}

/** 为可见 Windows 终端生成：只读查询保留结果，其它成功任务 5 秒后自动关闭。 */
function buildWindowsTerminalCountdownScript(built, keepOpenOnSuccess = false) {
  const quotePowerShellArg = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const invoke = `& ${[built.command, ...(built.args || [])].map(quotePowerShellArg).join(' ')}`;
  const successExit = keepOpenOnSuccess
    ? 'Write-Host "`n✓ 查询完成，终端将保留以便查看结果。" -ForegroundColor Cyan; Read-Host "按 Enter 关闭窗口"; exit 0'
    : [
        'for ($remaining = 5; $remaining -gt 0; $remaining -= 1) {',
        '  Write-Host "`r✓ 执行完成，终端将在 $remaining 秒后自动关闭；按 Enter 保留窗口。" -NoNewline -ForegroundColor Cyan',
        '  $deadline = [DateTime]::UtcNow.AddSeconds(1)',
        '  while ([DateTime]::UtcNow -lt $deadline) { if ([Console]::KeyAvailable -and [Console]::ReadKey($true).Key -eq [ConsoleKey]::Enter) { Write-Host "`n自动关闭已取消。按 Enter 关闭窗口。" -ForegroundColor Yellow; Read-Host "按 Enter 关闭窗口"; exit 0 }; Start-Sleep -Milliseconds 80 }',
        '}',
      ].join('; ');
  return [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    invoke,
    '$exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }',
    'if ($exitCode -ne 0) { Write-Host "`n✕ 执行失败（退出码 $exitCode）。终端将保留，按 Enter 关闭。" -ForegroundColor Red; Read-Host "按 Enter 关闭窗口"; exit $exitCode }',
    successExit,
  ].join('; ');
}

/** 为 macOS Terminal 生成与 Windows 一致的查询保留、倒计时关闭与错误保留脚本。 */
function buildMacTerminalCountdownCommand(preview, keepOpenOnSuccess = false) {
  const quoteBashArg = (value) => `'${String(value).replace(/'/g, "'\"'\"'")}'`;
  const successExit = keepOpenOnSuccess
    ? [
        "printf '\\n✓ 查询完成，终端将保留以便查看结果。\\n'",
        "read -r -p '按 Enter 关闭窗口' _",
        'exit 0',
      ].join('\n')
    : [
        'for remaining in 5 4 3 2 1; do',
        "  printf '\\r✓ 执行完成，终端将在 %s 秒后自动关闭；按 Enter 保留窗口。' \"$remaining\"",
        '  if IFS= read -r -t 1 _; then',
        "    printf '\\n自动关闭已取消。按 Enter 关闭窗口。\\n'",
        "    read -r -p '按 Enter 关闭窗口' _",
        '    exit 0',
        '  fi',
        'done',
      ].join('\n');
  const terminalScript = [
    `cd ${quoteBashArg(repoRoot())}`,
    preview,
    'exit_code=$?',
    'if [ "$exit_code" -ne 0 ]; then',
    "  printf '\\n✕ 执行失败（退出码 %s）。终端将保留，按 Enter 关闭。\\n' \"$exit_code\"",
    "  read -r -p '按 Enter 关闭窗口' _",
    '  exit "$exit_code"',
    'fi',
    successExit,
  ].join('\n');
  return `bash -lc ${quoteBashArg(terminalScript)}`;
}

/** 创建统一菜单运行器：支持插件内流式执行、交互式 stdin 输入与系统终端拉起 */
export function createMenuRunner(platformOs = normalizePlatformOs()) {
  let activeChild = null;
  let activeCode = '';
  let logs = [];
  const logsByCode = {};
  const previewByCode = {};

  function pushLog(type, text, targetCode = activeCode) {
    const codeKey = String(targetCode || activeCode || '');
    for (const rawLine of String(text || '').split(/\r?\n/)) {
      const line = rawLine.trimEnd();
      if (!line) continue;
      logs.push({ type, text: line });
      if (logs.length > 160) logs = logs.slice(-160);
      if (codeKey) {
        if (!Array.isArray(logsByCode[codeKey])) logsByCode[codeKey] = [];
        logsByCode[codeKey].push({ type, text: line });
        if (logsByCode[codeKey].length > 160) {
          logsByCode[codeKey] = logsByCode[codeKey].slice(-160);
        }
      }
    }
  }

  function findItem(code) {
    const spec = loadMenuSpec(platformOs);
    for (const g of spec.groups) {
      for (const it of g.items) {
        if (it.code === String(code)) return it;
      }
    }
    return null;
  }

  function executeCommand(code, params = {}) {
    if (!hasSyncRepo()) return { ok: false, error: syncRepoUnavailableMessage() };
    const item = findItem(code);
    if (!item) return { ok: false, error: `未知菜单序号: ${code}` };
    if (activeChild) {
      try { activeChild.kill(); } catch {}
      activeChild = null;
    }
    // 每次执行命令前先清空上一轮日志
    logs = [];
    logsByCode[item.code] = [];
    const built = buildMenuCommandArgs(item, params, platformOs, item?.scriptBaseDir ? { scriptBaseDir: item.scriptBaseDir } : {});
    const taskCode = item.code;
    activeCode = taskCode;
    previewByCode[taskCode] = built.preview;
    pushLog('cmd', `$ ${built.preview}`, taskCode);

    try {
      const child = spawn(built.command, built.args, {
        cwd: repoRoot(),
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      activeChild = child;
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => pushLog('ok', chunk, taskCode));
      child.stderr?.on('data', (chunk) => pushLog('prompt', chunk, taskCode));
      child.on('error', (err) => {
        pushLog('prompt', `[执行错误] ${err.message}`, taskCode);
        if (activeChild === child) activeChild = null;
      });
      child.on('close', (exitCode) => {
        pushLog(exitCode === 0 ? 'ok' : 'prompt', `[执行结束] #${item.code} ${item.label} 退出码: ${exitCode ?? 0}`, taskCode);
        if (activeChild === child) activeChild = null;
      });
      return { ok: true, preview: built.preview, running: true };
    } catch (err) {
      pushLog('prompt', `[启动失败] ${err.message}`, taskCode);
      return { ok: false, error: err.message };
    }
  }

  function sendStdin(input) {
    if (!activeChild || !activeChild.stdin || activeChild.stdin.destroyed) {
      pushLog('prompt', '[提示] 当前无等待输入的运行中子进程', activeCode);
      return { ok: false, error: '当前无运行中的交互子进程' };
    }
    const line = String(input ?? '');
    pushLog('cmd', `> ${line || '<Enter>'}`, activeCode);
    try {
      activeChild.stdin.write(`${line}\n`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  function openInTerminal(code, params = {}) {
    if (!hasSyncRepo()) return { ok: false, error: syncRepoUnavailableMessage() };
    const item = findItem(code);
    if (!item) return { ok: false, error: `未知菜单序号: ${code}` };
    logs = [];
    logsByCode[item.code] = [];
    const built = buildMenuCommandArgs(item, params, platformOs, item?.scriptBaseDir ? { scriptBaseDir: item.scriptBaseDir } : {});
    activeCode = item.code;
    previewByCode[item.code] = built.preview;
    pushLog('cmd', `[系统终端] ${built.preview}`, item.code);
    try {
      if (platformOs === 'win32') {
        // cmd start 显式创建可见窗口；直接脱离启动 powershell.exe 在 DSH 图形宿主中会静默结束。
        const child = spawn('cmd.exe', [
          '/d',
          '/c',
          'start',
          '""',
          'powershell.exe',
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          buildWindowsTerminalCountdownScript(built, item.readonly === true),
        ], {
          cwd: repoRoot(),
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
        child.unref();
      } else {
        const scriptCmd = buildMacTerminalCountdownCommand(built.preview, item.readonly === true);
        const child = spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(scriptCmd)}`], {
          cwd: repoRoot(),
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
      }
      return { ok: true, preview: built.preview };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  function clearLogs(code) {
    if (code) {
      const k = String(code);
      logsByCode[k] = [];
      delete previewByCode[k];
      if (activeCode === k) logs = [];
      return;
    }
    logs = [];
    for (const k of Object.keys(logsByCode)) {
      logsByCode[k] = [];
    }
  }

  function getSnapshot() {
    const copiedByCode = {};
    for (const [k, v] of Object.entries(logsByCode)) {
      copiedByCode[k] = Array.isArray(v) ? [...v] : [];
    }
    return {
      running: Boolean(activeChild),
      activeCode,
      logs: [...logs],
      logsByCode: copiedByCode,
      previewByCode: { ...previewByCode },
    };
  }

  return { executeCommand, sendStdin, openInTerminal, clearLogs, getSnapshot };
}


