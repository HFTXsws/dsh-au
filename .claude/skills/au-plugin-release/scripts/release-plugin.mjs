#!/usr/bin/env node
/**
 * Au插件发布：DSH 版本自动探测、递增版本号计算、构建体检与 npm 发布预检脚本。
 * 遵循「优秀 Skill SSOT」第 5 节脚本四原则：
 * 1. 自愈性：捕获所有异常，始终以 exit 0 输出结构化 JSON（success + data + error + metadata）
 * 2. 结构化输出：统一 JSON，便于 Agent 确定性解析
 * 3. 幂等性：--mode plan 纯只读不改文件；--mode apply 仅在目标版本变化时原子写回 package.json
 * 4. 安全边界：只读 ~/.dsh 日志与当前仓库状态，不自动执行 git push 或 npm publish
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_NAME = 'release-plugin.mjs';
const startTime = Date.now();

function parseArgs(argv) {
  const out = {
    mode: 'plan',
    dshVersion: '',
    targetVersion: '',
    skipTests: false,
    repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--mode' && argv[i + 1]) {
      out.mode = String(argv[++i]).trim();
    } else if (arg === '--dsh-version' && argv[i + 1]) {
      out.dshVersion = String(argv[++i]).trim();
    } else if (arg === '--target-version' && argv[i + 1]) {
      out.targetVersion = String(argv[++i]).trim();
    } else if (arg === '--repo-root' && argv[i + 1]) {
      out.repoRoot = resolve(argv[++i]);
    } else if (arg === '--skip-tests') {
      out.skipTests = true;
    }
  }
  return out;
}

/**
 * 从本机 ~/.dsh/logs/ 最新日志或环境变量探测当前正在使用的 DSH 宿主版本（如 0.2.2-rc.3）。
 */
export function detectCurrentDshVersion({ dshHome = join(homedir(), '.dsh'), env = process.env } = {}) {
  if (env.DSH_VERSION && String(env.DSH_VERSION).trim()) {
    return { dshVersion: String(env.DSH_VERSION).trim(), source: 'env:DSH_VERSION' };
  }
  const logsDir = join(dshHome, 'logs');
  if (existsSync(logsDir)) {
    const files = readdirSync(logsDir)
      .filter((name) => /^desktop-next-\d{4}-\d{2}-\d{2}\.\d+\.jsonl$/.test(name))
      .map((name) => {
        const fullPath = join(logsDir, name);
        let mtimeMs = 0;
        try { mtimeMs = statSync(fullPath).mtimeMs; } catch {}
        return { name, fullPath, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));

    for (const file of files.slice(0, 5)) {
      try {
        const content = readFileSync(file.fullPath, 'utf8');
        const lines = content.split(/\r?\n/);
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const line = lines[i];
          if (!line || !line.includes('"dsh"')) continue;
          try {
            const parsed = JSON.parse(line);
            const ver = parsed?.fields?.dsh;
            if (typeof ver === 'string' && /^\d+\.\d+\.\d+/.test(ver.trim())) {
              return { dshVersion: ver.trim(), source: `logs:${file.name}` };
            }
          } catch {}
        }
      } catch {}
    }
  }
  return { dshVersion: '', source: 'not-found' };
}

/**
 * 根据当前 DSH 版本前缀与插件已有版本号，计算下一个 `<dshVersion>-<N>` 版本号（N 从 1 开始无限递增）。
 * 例如：
 * - dshVersion = "0.2.2-rc.3", current = "0.2.1" -> "0.2.2-rc.3-1"
 * - dshVersion = "0.2.2-rc.3", current = "0.2.2-rc.3-1" -> "0.2.2-rc.3-2"
 * - dshVersion = "0.2.2-rc.3", published = ["0.2.2-rc.3-2"] -> "0.2.2-rc.3-3"
 */
export function computeNextPluginVersion(dshVersion, currentVersion = '', publishedVersions = []) {
  const cleanDsh = String(dshVersion || '').trim();
  if (!cleanDsh) {
    throw new Error('未检测到当前 DSH 版本号，请通过 --dsh-version 显式指定');
  }
  const prefix = `${cleanDsh}-`;
  let maxSeq = 0;
  const candidates = [currentVersion, ...(Array.isArray(publishedVersions) ? publishedVersions : [])];
  for (const candidate of candidates) {
    const str = String(candidate || '').trim();
    if (!str.startsWith(prefix)) continue;
    const tail = str.slice(prefix.length);
    if (/^\d+$/.test(tail)) {
      const num = Number(tail);
      if (Number.isSafeInteger(num) && num > maxSeq) {
        maxSeq = num;
      }
    }
  }
  return {
    dshVersion: cleanDsh,
    currentVersion: String(currentVersion || '').trim(),
    nextSequence: maxSeq + 1,
    nextVersion: `${prefix}${maxSeq + 1}`,
  };
}

function runCmd(command, args, cwd, timeoutMs = 120000) {
  const isWin = process.platform === 'win32';
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: isWin && /\.(cmd|bat)$/i.test(command),
    windowsHide: true,
    timeout: timeoutMs,
  });
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
    error: result.error ? result.error.message : null,
  };
}

function queryPublishedVersions(pkgName, cwd) {
  if (!pkgName) return [];
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const res = runCmd(npmCmd, ['view', pkgName, 'versions', '--json'], cwd, 12000);
  if (!res.ok || !res.stdout) return [];
  try {
    const parsed = JSON.parse(res.stdout);
    if (Array.isArray(parsed)) return parsed.map(String);
    if (typeof parsed === 'string') return [parsed];
  } catch {}
  return [];
}

function inspectGitState(repoRoot) {
  const branch = runCmd('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot, 5000);
  const status = runCmd('git', ['status', '--porcelain'], repoRoot, 5000);
  const userName = runCmd('git', ['config', '--local', 'user.name'], repoRoot, 5000);
  const userEmail = runCmd('git', ['config', '--local', 'user.email'], repoRoot, 5000);
  const changedFiles = status.stdout
    ? status.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [];
  return {
    branch: branch.stdout || 'unknown',
    localUserName: userName.stdout || '',
    localUserEmail: userEmail.stdout || '',
    signatureConfigured: Boolean(userName.stdout && userEmail.stdout),
    changedFiles,
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pkgPath = join(opts.repoRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    throw new Error(`找不到 package.json: ${pkgPath}`);
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const currentVersion = String(pkg.version || '').trim();
  const detected = opts.dshVersion
    ? { dshVersion: opts.dshVersion, source: 'cli:--dsh-version' }
    : detectCurrentDshVersion();

  const publishedVersions = queryPublishedVersions(pkg.name, opts.repoRoot);
  const versionPlan = opts.targetVersion
    ? {
        dshVersion: detected.dshVersion,
        currentVersion,
        nextSequence: null,
        nextVersion: opts.targetVersion,
      }
    : computeNextPluginVersion(detected.dshVersion, currentVersion, publishedVersions);

  let versionUpdated = false;
  if (opts.mode === 'apply' && pkg.version !== versionPlan.nextVersion) {
    pkg.version = versionPlan.nextVersion;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    versionUpdated = true;
  }

  const buildRes = runCmd(process.execPath, ['scripts/build-client.js'], opts.repoRoot, 30000);
  if (!buildRes.ok) {
    throw new Error(`build:client 失败: ${buildRes.stderr || buildRes.stdout || buildRes.error}`);
  }
  const checkRes = runCmd(process.execPath, ['scripts/build-client.js', '--check'], opts.repoRoot, 30000);
  if (!checkRes.ok) {
    throw new Error(`check:client 失败: ${checkRes.stderr || checkRes.stdout || checkRes.error}`);
  }

  let testSummary = { skipped: opts.skipTests, ok: true, outputTail: '' };
  if (!opts.skipTests && opts.mode === 'apply') {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const testRes = runCmd(npmCmd, ['test'], opts.repoRoot, 180000);
    const tail = (testRes.stdout || testRes.stderr).split(/\r?\n/).slice(-12).join('\n');
    testSummary = { skipped: false, ok: testRes.ok, outputTail: tail };
    if (!testRes.ok) {
      throw new Error(`npm test 未通过:\n${tail}`);
    }
  }

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packPreview = runCmd(npmCmd, ['pack', '--dry-run', '--json'], opts.repoRoot, 30000);
  let packInfo = null;
  if (packPreview.ok && packPreview.stdout) {
    try {
      const parsed = JSON.parse(packPreview.stdout);
      const first = Array.isArray(parsed) ? parsed[0] : parsed;
      if (first) {
        packInfo = {
          id: first.id,
          name: first.name,
          version: first.version,
          size: first.size,
          unpackedSize: first.unpackedSize,
          entryCount: Array.isArray(first.files) ? first.files.length : 0,
        };
      }
    } catch {}
  }

  const gitState = inspectGitState(opts.repoRoot);
  return {
    mode: opts.mode,
    packageName: pkg.name,
    dshDetection: detected,
    versionPlan,
    versionUpdated,
    buildCheck: { ok: true, message: checkRes.stdout },
    testSummary,
    packInfo,
    gitState,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  let payload;
  try {
    const data = main();
    payload = {
      success: true,
      data,
      error: null,
      metadata: {
        script: SCRIPT_NAME,
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
      },
    };
  } catch (err) {
    payload = {
      success: false,
      data: null,
      error: err?.message || String(err),
      metadata: {
        script: SCRIPT_NAME,
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
      },
    };
  }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(0);
}
