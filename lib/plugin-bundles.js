/**
 * 插件配置快照：把「这台机器上某个插件的配置」落成仓库里可提交的一份文件。
 *
 * 目录：<repo>/dsh-au/sync/plugins/<slug>/
 *   plugin.json  机器读：包名、版本、启用态、下载来源、patchId
 *   config.yml   人读也可读：插件在 profile 的 cordis.patch.yml 里的那一个 `- id` 块
 *   README.md    人读：从哪下载、同步了什么、什么没同步
 *
 * 设计取舍：
 * - 只搬「这一个插件的 patch 块」，绝不整份 cordis.patch.yml——那份里还有模型 provider、
 *   主题、权限等本机基础设施配置，整份复制会把 A 机的供应商配置糊到 B 机。
 * - 不搬 activity/log 之类的运行日志，也不搬含凭据的字段。
 * - 仅复用只读链接分类，不 import 同步入口，避免和 dsh-plugin-sync 形成循环依赖。
 */
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolvePluginBundlesDir as resolveBundlesDir } from './sync-repo.js';
import { resolveExternalPluginLink } from './plugin-links.js';

const CREDENTIAL_KEY_RE = /^(?:.*[_-]?(?:password|passwd|secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|credential|cookie)s?|.*[_-]?authorization|(?:.*[_-])?token)$/i;
const URL_SENSITIVE_QUERY_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'#]*[?&](?:password|passwd|token|secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|credential|auth)=([^&\s"'#]+)/gi;

// 驼峰/下划线拆词后的末词命中这些即视为凭据字段（authToken、botToken、clientSecret 等）；maxTokens 这类复数计数不算。
const CREDENTIAL_LAST_WORDS = new Set(['password', 'passwd', 'secret', 'secrets', 'token', 'credential', 'credentials', 'cookie', 'cookies', 'authorization']);
// 整值占位引用：值必须完全由引用组成，“明文 + 引用”的混写不放行。
const FULL_PLACEHOLDER_RES = [
  /^!!js(?:\/|\b)/i,
  /^\$env:[A-Za-z_][A-Za-z0-9_]*$/i,
  /^process\.env(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\s*["'][^"']+["']\s*\])$/,
  /^getenv\s*\(\s*["'][^"']+["']\s*\)$/i,
  /^\$\.store(?:\.[A-Za-z0-9_]+)+$/,
  /^keychain:\S+$/i,
  /^credentialStore\.[A-Za-z]+\(\s*["'][^"']*["']\s*\)$/,
];
// 授权头允许 “Bearer ${TOKEN}” 这种认证方案前缀，其余位置只能是 ${...}。
const AUTH_SCHEME_PREFIX_RE = /^(?:bearer|basic|token)\s+/i;
const URL_USERINFO_PASSWORD_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/"'@#:]+:([^\s/"'@#]+)@[^\s/"']+/gi;

/** 字段名是否表示凭据：沿用原规则，再补驼峰末词判断。 */
function isCredentialKey(key) {
  if (CREDENTIAL_KEY_RE.test(key)) return true;
  const words = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_.-]+/).filter(Boolean);
  const last = (words[words.length - 1] || '').toLowerCase();
  if (CREDENTIAL_LAST_WORDS.has(last)) return true;
  // apiKey / accessKey / privateKey 拆成两词后由前一词判定。
  const prev = (words[words.length - 2] || '').toLowerCase();
  return last === 'key' && ['api', 'access', 'private', 'secret', 'auth'].includes(prev);
}

/** 值是否完全是占位引用；只有 ${...} 可与认证方案前缀并存。 */
function isFullPlaceholder(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return false;
  if (FULL_PLACEHOLDER_RES.some((re) => re.test(value))) return true;
  const withoutScheme = value.replace(AUTH_SCHEME_PREFIX_RE, '');
  if (!/\$\{[^}]+\}/.test(withoutScheme)) return false;
  return withoutScheme.replace(/\$\{[^}]+\}/g, '').trim() === '';
}

/** 去掉 URL 片段里的百分号编码再判断占位，避免 %24%7B 这类写法绕过。 */
function decodeUrlPart(part) {
  try { return decodeURIComponent(part); } catch { return part; }
}

/** 单个键值是否构成明文凭据。 */
function credentialValueIssue(key, value, quoted) {
  if (!isCredentialKey(key)) return '';
  const isEmptyOrNull = value === '' || (!quoted && /^(?:null|~)$/i.test(value));
  if (isEmptyOrNull || isFullPlaceholder(value)) return '';
  return `字段 ${key}`;
}

/** 检查一段花括号内联写法里的每个键值，如 `{ user: a, "password": "x" }`。 */
function findInlineMappingIssue(text) {
  const start = text.indexOf('{');
  if (start < 0) return '';
  const pairRe = /[{,]\s*(["']?)([A-Za-z0-9_.-]+)\1\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,}]*)/g;
  const body = text.slice(start);
  let match;
  while ((match = pairRe.exec(body)) !== null) {
    const { value, quoted } = parseYamlScalarValue(match[3]);
    const issue = credentialValueIssue(match[2], value, quoted);
    if (issue) return issue;
  }
  return '';
}

function parseYamlScalarValue(rawValue) {
  const trimmed = String(rawValue || '').trimStart();
  if (!trimmed || trimmed.startsWith('#')) return { value: '', quoted: false };
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    let inner = '';
    for (let i = 1; i < trimmed.length; i += 1) {
      const ch = trimmed[i];
      if (quote === '"' && ch === '\\' && i + 1 < trimmed.length) {
        inner += trimmed[i + 1];
        i += 1;
        continue;
      }
      if (quote === "'" && ch === "'" && trimmed[i + 1] === "'") {
        inner += "'";
        i += 1;
        continue;
      }
      if (ch === quote) {
        return { value: inner, quoted: true };
      }
      inner += ch;
    }
    return { value: trimmed.slice(1), quoted: true };
  }
  const withoutComment = trimmed.replace(/\s+#.*$/, '').trim();
  return { value: withoutComment, quoted: false };
}

/**
 * 检查 YAML 配置文本是否包含明文凭据（明文密钥字段、user:pass@ URL 或敏感 query 参数）。
 * 允许空值、null/~ 与整值占位引用（!!js/${...}/$.store/process.env/$env:/getenv(/keychain/credentialStore）；
 * 花括号内联写法逐项检查，驼峰字段名（authToken 等）同样识别，“明文 + 引用”的混写视为明文。
 * @returns {string} 命中时返回简短原因描述；安全时返回空串。
 */
export function findPlaintextCredentialIssue(text) {
  if (!text || typeof text !== 'string') return '';
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    if (/^\s*#/.test(line)) continue;
    const kvMatch = line.match(/^\s*(?:-\s+)?(["']?)([A-Za-z0-9_.-]+)\1\s*:\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[2];
      const rawValue = kvMatch[3];
      // 值是花括号内联写法时逐项检查，不把整段当成一个标量。
      if (/^\s*\{/.test(rawValue)) {
        const inlineIssue = findInlineMappingIssue(rawValue);
        if (inlineIssue) return inlineIssue;
      } else {
        const { value, quoted } = parseYamlScalarValue(rawValue);
        const issue = credentialValueIssue(key, value, quoted);
        if (issue) return issue;
      }
    } else {
      const inlineIssue = findInlineMappingIssue(line);
      if (inlineIssue) return inlineIssue;
    }
    URL_USERINFO_PASSWORD_RE.lastIndex = 0;
    let urlMatch;
    while ((urlMatch = URL_USERINFO_PASSWORD_RE.exec(line)) !== null) {
      // 只看密码段：必须整段是占位引用。
      if (!isFullPlaceholder(decodeUrlPart(urlMatch[1]))) {
        return 'URL 内嵌凭据 (user:pass@)';
      }
    }
    URL_SENSITIVE_QUERY_RE.lastIndex = 0;
    let queryMatch;
    while ((queryMatch = URL_SENSITIVE_QUERY_RE.exec(line)) !== null) {
      if (!isFullPlaceholder(decodeUrlPart(queryMatch[1]))) {
        return 'URL 敏感查询参数';
      }
    }
  }
  return '';
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 将插件 patch 配置块中的本机家目录绝对路径归一化为跨平台便携路径 `~/...`。
 * 兼容：
 * - YAML 双引号内因超长折行产生的 `\<newline><indent>\\` 续行；
 * - 当前机器 `homeDir` 的正斜杠、单反斜杠、YAML 双反斜杠形式；
 * - 任意 Windows/macOS/Linux 家目录下的 `.dsh` 路径（防止跨机二次导出时残留上台机器用户名）。
 */
export function normalizePortableConfigPaths(configText, homeDir = homedir()) {
  if (!configText || typeof configText !== 'string') return '';
  // 先拼接 YAML 双引号字符串里把反斜杠路径拆成两行的续行符
  let text = configText.replace(/\\\r?\n[ \t]*(?=\\\\)/g, '');
  const cleanHome = String(homeDir || '').replace(/[\\/]+$/, '');
  const patterns = [];
  if (cleanHome) {
    const forwardHome = cleanHome.replace(/\\/g, '/');
    const singleBackslashHome = cleanHome.replace(/\//g, '\\');
    const doubleBackslashHome = singleBackslashHome.replace(/\\/g, '\\\\');
    for (const variant of new Set([doubleBackslashHome, singleBackslashHome, forwardHome])) {
      if (variant) {
        patterns.push(new RegExp(`${escapeRegExp(variant)}(?:\\\\\\\\|\\\\|/)+([^\\s"']*)`, 'gi'));
      }
    }
  }
  // 兜底识别常见的 Windows / macOS / Linux 家目录路径（尤其是 .dsh 目录）
  patterns.push(
    /[A-Za-z]:\\\\Users\\\\[^\\/"'\s]+(?:\\\\)+(\.dsh(?:\\\\|\/)[^\s"']*)/g,
    /[A-Za-z]:\\Users\\[^\\/"'\s]+(?:\\)+(\.dsh(?:\\|\/)[^\s"']*)/g,
    /[A-Za-z]:\/Users\/[^\\/"'\s]+\/+(\.dsh\/[^\s"']*)/g,
    /\/Users\/[^\\/"'\s]+\/+(\.dsh\/[^\s"']*)/g,
    /\/home\/[^\\/"'\s]+\/+(\.dsh\/[^\s"']*)/g,
  );
  for (const regex of patterns) {
    text = text.replace(regex, (_match, subPath = '') => {
      const normalizedSub = String(subPath)
        .replace(/\\\\/g, '/')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '');
      return normalizedSub ? `~/${normalizedSub}` : '~';
    });
  }
  return text;
}

/**
 * 将插件配置快照中的 `~/...` 便携路径按目标机器系统还原为本机家目录绝对路径。
 * - Windows 双引号 YAML 字符串内使用双反斜杠 `\\` 转义；
 * - Windows 非双引号内使用单反斜杠 `\`；
 * - macOS / Linux 统一使用正斜杠 `/`。
 */
export function expandPortableConfigPaths(configText, homeDir = homedir(), platform = process.platform) {
  if (!configText || typeof configText !== 'string') return '';
  const cleanHome = String(homeDir || homedir()).replace(/[\\/]+$/, '');
  const isWin = platform === 'win32';
  const posixHome = cleanHome.replace(/\\/g, '/');
  const winSingleHome = cleanHome.replace(/\//g, '\\');
  const winDoubleHome = winSingleHome.replace(/\\/g, '\\\\');

  // 第一步：先展开双引号内部的 ~/ 路径（Windows 下必须转成 \\ 才符合 YAML 双引号转义）
  const afterDoubleQuoted = configText.replace(/"([^"\r\n]*)"/g, (_full, inner) => {
    const replaced = String(inner).replace(/(^|[\s=:])~\/([^\s"']+)/g, (_m, prefix, rest) => {
      const cleanRest = String(rest).replace(/\\\\/g, '/').replace(/\\/g, '/').replace(/^\/+/, '');
      return isWin
        ? `${prefix}${winDoubleHome}\\\\${cleanRest.replace(/\//g, '\\\\')}`
        : `${prefix}${posixHome}/${cleanRest}`;
    });
    return `"${replaced}"`;
  });

  // 第二步：展开双引号外部的 ~/ 路径
  return afterDoubleQuoted.replace(/(^|[\s'=:-\[])~\/([^\s"']+)/gm, (_m, prefix, rest) => {
    const cleanRest = String(rest).replace(/\\\\/g, '/').replace(/\\/g, '/').replace(/^\/+/, '');
    return isWin
      ? `${prefix}${winSingleHome}\\${cleanRest.replace(/\//g, '\\')}`
      : `${prefix}${posixHome}/${cleanRest}`;
  });
}

/** 包名 → 目录名：@weibaohui/dsh-continue → weibaohui-dsh-continue。 */
export function pluginBundleSlug(packageName) {
  return String(packageName || '')
    .trim()
    .replace(/^@/, '')
    .replace(/\//g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .toLowerCase() || 'unknown-plugin';
}

export function resolvePluginBundlesDir(repoRoot) {
  return resolveBundlesDir(repoRoot);
}

export function resolvePluginBundleDir(repoRoot, packageName) {
  return join(resolvePluginBundlesDir(repoRoot), pluginBundleSlug(packageName));
}

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function isPackageName(value) {
  return typeof value === 'string' && /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(value)
    && value.split('/').every((part) => part !== '.' && part !== '..');
}

function fileStat(filePath) {
  try { return lstatSync(filePath); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** 删除/替换前验证规范绝对路径、仓库内范围与每级目录，拒绝软链/junction 重定向。 */
function assertSnapshotPath(repoRoot, target) {
  const repo = resolve(repoRoot);
  const root = resolve(resolvePluginBundlesDir(repo));
  const absolute = resolve(target);
  const subPath = relative(root, absolute);
  if (!isAbsolute(target) || target !== absolute || subPath.startsWith(`..${sep}`) || subPath === '..' || isAbsolute(subPath)) {
    throw new Error(`插件快照路径越界: ${target}`);
  }
  const parent = dirname(absolute);
  let current = repo;
  for (const part of relative(repo, parent).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = fileStat(current);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new Error(`插件快照路径不能经过链接或非目录: ${current}`);
    }
  }
  return absolute;
}

/** 同目录独占临时文件 + rename：单个文件永远不暴露半写内容。 */
function writeSnapshotFile(repoRoot, filePath, content) {
  assertSnapshotPath(repoRoot, filePath);
  const stat = fileStat(filePath);
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
    throw new Error(`插件快照目标不是普通文件: ${filePath}`);
  }
  const temp = `${filePath}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const fd = openSync(temp, 'wx');
    created = true;
    try {
      writeFileSync(fd, content, 'utf8');
    } finally {
      closeSync(fd);
    }
    renameSync(temp, filePath);
    created = false;
  } finally {
    if (created) {
      assertSnapshotPath(repoRoot, temp);
      unlinkSync(temp);
    }
  }
}

function configDigest(content) {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * 判断插件是不是「仓库内软链」挂进来的（例如 dsh-au 自己）。
 * 只把包管理器管理根之外的外部链接标为 local-repo；pnpm 普通包链接仍属于 npm。
 */
export function isLinkedPackage(profileDir, packageName) {
  return Boolean(resolveExternalPluginLink(profileDir, packageName));
}

/** 从插件包自己的 package.json 取下载来源、许可证、版本；取不到就留空，不编造。 */
export function readPluginPackageMeta(profileDir, packageName) {
  // 只认目标 Profile 的包元信息；声明版本和其它包的元信息不能当安装事实。
  const raw = isPackageName(packageName)
    ? readJson(join(profileDir, 'node_modules', packageName, 'package.json'), {}) : {};
  const meta = raw && typeof raw === 'object' && !Array.isArray(raw)
    && (!raw.name || raw.name === packageName) ? raw : {};
  const installedVersion = typeof meta.version === 'string' ? meta.version.trim() : '';
  const repository = meta?.repository;
  const rawUrl = (typeof repository === 'string' ? repository : repository?.url) || meta?.homepage || '';
  const url = String(rawUrl).replace(/^git\+/, '').replace(/\.git$/, '');
  return {
    version: installedVersion,
    installed: Boolean(installedVersion),
    license: typeof meta?.license === 'string' ? meta.license : '',
    url,
    homepage: typeof meta?.homepage === 'string' ? meta.homepage : '',
  };
}

function buildReadme({ packageName, manifest, configText }) {
  const source = manifest.source || {};
  const lines = [
    `# ${packageName}`,
    '',
    '> 本目录由 dsh-au「同步到云」生成，用于换电脑时一键复刻这个插件。',
    '',
    '## 从哪下载',
    '',
    `- 包名：\`${packageName}\``,
    `- 版本：\`${manifest.version || source.ref || '未记录'}\``,
    `- 安装方式：${source.type === 'local-repo' ? '仓库内软链（随本仓库，无需下载）' : 'npm 包管理器安装'}`,
    `- 项目地址：${source.type === 'local-repo' ? '本仓库内目录（无需下载）' : (source.url || '未在插件 package.json 里声明')}`,
    `- 许可证：${source.license || '未在插件 package.json 里声明'}`,
    '',
    '## 同步了什么',
    '',
    configText
      ? `- 插件在 DSH profile \`cordis.patch.yml\` 里的 \`- id: ${manifest.patchId}\` 配置块（见本目录 \`config.yml\`）：开关、重试参数、规则表等`
      : '- 该插件在本机没有独立的 patch 配置块（config.yml 未生成），换机只需安装并启用',
    `- DSH profile 的 \`dependencies\` 与 \`dsh.profile.bundles\`（启用状态由 plugin.json 的 enabled 决定）`,
    '',
    '## 没有同步什么',
    '',
    '- 插件的运行日志 / 活动记录（例如 `~/.dsh/<插件名>/activity.jsonl`），属于本机产生的过程数据',
    '- 任何凭据、token、密码类字段',
    '- 其它插件的 patch 块：整份 `cordis.patch.yml` 里还有模型 provider、主题、权限等本机基础设施配置，不跨机复制',
    '',
    '## 换到另一台电脑',
    '',
    '1. 在 DSH 的「插件管理 → 云插件」里点该插件的「同步到当前电脑」',
    '2. dsh-au 会按上面的来源安装、写入启用状态，并把 `config.yml` 合并进本机 profile 的同 id 块（只覆盖这一个 id，其它条目原样保留）',
    '3. 完全重启 DSH 生效',
    '',
    `> 快照时间：${manifest.syncedAt || '未记录'}；来源机器：${manifest.syncedFrom || '未记录'}`,
    '',
  ];
  return lines.join('\n');
}

/**
 * 写一个插件的配置快照。
 * @param {object} options
 * @param {string} options.repoRoot 仓库根目录
 * @param {string} options.profileDir DSH profile 目录（读插件包的 package.json）
 * @param {object} options.plugin 云清单里的插件条目（package / version / source）
 * @param {string} [options.configText] 该插件在 profile patch 里的 `- id` 块原文；没有就传空串
 * @param {string} [options.patchId] 该块在 patch 里的 id
 * @param {string} [options.syncedFrom] 来源机器名，仅作记录
 */
export function writePluginBundle({ repoRoot, profileDir, plugin, configText = '', patchId = '', syncedFrom = '', homeDir = homedir() }) {
  const packageName = typeof plugin?.package === 'string' ? plugin.package : '';
  if (!isPackageName(packageName)) throw new Error('缺少或无效的插件包名，无法生成配置快照');
  const meta = readPluginPackageMeta(profileDir, packageName);
  const dir = resolve(resolvePluginBundleDir(repoRoot, packageName));
  const manifestPath = assertSnapshotPath(repoRoot, join(dir, 'plugin.json'));
  const configPath = assertSnapshotPath(repoRoot, join(dir, 'config.yml'));
  // 同一 slug 可能来自不同包。先验证已有清单归属，坏清单也不能无声覆盖。
  let previous = null;
  const manifestStat = fileStat(manifestPath);
  if (manifestStat) {
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error(`快照清单路径无效: ${manifestPath}`);
    previous = readJson(manifestPath, null);
    if (!previous || !isPackageName(previous.package)) throw new Error(`快照清单损坏，拒绝覆盖: ${manifestPath}`);
    if (previous.package !== packageName) throw new Error(`插件快照 slug 冲突: ${previous.package} 与 ${packageName}`);
  }
  const normalizedConfigText = configText ? normalizePortableConfigPaths(configText, homeDir) : '';
  if (normalizedConfigText) {
    const credentialIssue = findPlaintextCredentialIssue(normalizedConfigText);
    if (credentialIssue) {
      throw new Error(`插件配置快照包含明文凭据（${credentialIssue}），拒绝生成 config.yml`);
    }
  }
  mkdirSync(dir, { recursive: true });
  const declared = readJson(join(profileDir, 'package.json'), {})?.dependencies?.[packageName];
  const requestedSpec = typeof declared === 'string' ? declared
    : (typeof plugin?.requestedSpec === 'string' ? plugin.requestedSpec : plugin?.version || '');
  const version = meta.version || plugin?.version || '';

  const isLocalRepo = plugin?.source === 'local' || isLinkedPackage(profileDir, packageName);
  const manifest = {
    schemaVersion: 1,
    package: packageName,
    name: plugin?.name || packageName,
    version,
    requestedSpec,
    versionVerified: meta.installed,
    enabled: Boolean(plugin?.enabled),
    patchId: patchId || packageName,
    source: {
      type: isLocalRepo ? 'local-repo' : 'npm',
      ref: version,
      url: meta.url,
      license: meta.license,
    },
    hasConfig: Boolean(normalizedConfigText),
    ...(normalizedConfigText ? { configHash: configDigest(Buffer.from(normalizedConfigText, 'utf8')) } : {}),
    syncedAt: new Date().toISOString(),
    syncedFrom,
  };

  const files = ['plugin.json', 'README.md'];
  if (normalizedConfigText) {
    writeSnapshotFile(repoRoot, configPath, normalizedConfigText);
    files.push('config.yml');
  } else if (previous && previous.hasConfig !== false && fileStat(configPath)) {
    // 只删这份已归属同包的生成配置；首次导出旁边的独立文件不在删除范围。
    assertSnapshotPath(repoRoot, configPath);
    const stat = lstatSync(configPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`快照配置路径不是普通文件: ${configPath}`);
    if (previous.configHash && configDigest(readFileSync(configPath)) !== String(previous.configHash).toLowerCase()) {
      throw new Error(`快照配置已被修改，拒绝删除: ${configPath}`);
    }
    unlinkSync(configPath);
  }
  writeSnapshotFile(repoRoot, join(dir, 'README.md'), buildReadme({ packageName, manifest, configText: normalizedConfigText }));
  // 清单是最后的提交标志：中断/失败时旧 hash 会明确暴露不完整快照。
  writeSnapshotFile(repoRoot, manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, slug: pluginBundleSlug(packageName), files, hasConfig: Boolean(normalizedConfigText), manifest };
}

/**
 * 只把已有快照的版本号改成实际安装版本。
 * 不改 enabled、不改 config.yml，避免一次版本升级把插件设置也推上云。
 */
export function updatePluginBundleVersion({ repoRoot, packageName, version }) {
  if (!isPackageName(packageName)) throw new Error('缺少或无效的插件包名，无法更新快照版本');
  const exact = String(version || '').trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(exact)) throw new Error('插件版本不是可安装的精确版本');
  const manifestPath = assertSnapshotPath(repoRoot, resolve(resolvePluginBundleDir(repoRoot, packageName), 'plugin.json'));
  const manifestStat = fileStat(manifestPath);
  if (!manifestStat || !manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error('缺少可更新的插件快照');
  const previous = readJson(manifestPath, null);
  if (!previous || previous.package !== packageName) throw new Error('快照清单损坏，拒绝更新版本');
  const manifest = {
    ...previous,
    version: exact,
    requestedSpec: exact,
    versionVerified: true,
    source: { ...(previous.source && typeof previous.source === 'object' ? previous.source : {}), ref: exact },
  };
  if (previous.version === exact && previous.requestedSpec === exact && previous.source?.ref === exact && previous.versionVerified === true) {
    return { updated: false, manifest: previous };
  }
  writeSnapshotFile(repoRoot, manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const readmePath = resolve(resolvePluginBundleDir(repoRoot, packageName), 'README.md');
  const readmeStat = fileStat(readmePath);
  if (readmeStat?.isFile() && !readmeStat.isSymbolicLink()) {
    const readme = readFileSync(readmePath, 'utf8');
    const next = readme.replace(/^- 版本：`[^`]*`/m, `- 版本：\`${exact}\``);
    if (next !== readme) writeSnapshotFile(repoRoot, readmePath, next);
  }
  return { updated: true, manifest };
}

/**
 * 保持 byPackage Map 接口，仅放可用快照；调用方必须在本机写入前检查 errors。
 * 诊断含 package/dir/path，坏 JSON 无法识别包名时仍可按快照目录关联 preflight。
 */
export function readPluginBundles(repoRoot) {
  const root = resolve(resolvePluginBundlesDir(repoRoot));
  const byPackage = new Map();
  const warnings = [];
  const errors = [];
  const seenPackages = new Set();
  const invalidPackages = new Set();
  const report = (list, code, packageName, dir, filePath, message) => {
    list.push({ code, package: packageName, dir, path: filePath, message });
    if (list === errors && packageName) {
      invalidPackages.add(packageName);
      byPackage.delete(packageName);
    }
  };
  let entries;
  try {
    assertSnapshotPath(repoRoot, join(root, '__scope_check__'));
    if (!fileStat(root)) return { root, byPackage, ok: true, warnings, errors };
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    report(errors, 'SNAPSHOT_ROOT_UNREADABLE', '', root, root, `快照目录不可读取: ${error.code || error.message}`);
    return { root, byPackage, ok: false, warnings, errors };
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const dir = join(root, entry.name);
    const manifestPath = join(dir, 'plugin.json');
    const configPath = join(dir, 'config.yml');
    let packageName = '';
    try {
      assertSnapshotPath(repoRoot, manifestPath);
      const stat = fileStat(manifestPath);
      if (!stat) {
        report(errors, 'MANIFEST_MISSING', '', dir, manifestPath, '快照缺少 plugin.json');
        continue;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        report(errors, 'MANIFEST_NOT_FILE', '', dir, manifestPath, '快照清单不是普通文件');
        continue;
      }
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
      } catch (error) {
        report(errors, error instanceof SyntaxError ? 'MANIFEST_INVALID_JSON' : 'MANIFEST_UNREADABLE', '', dir, manifestPath, '快照清单无法读取或 JSON 损坏');
        continue;
      }
      if (!manifest || Array.isArray(manifest) || !isPackageName(manifest.package)) {
        report(errors, 'MANIFEST_INVALID', '', dir, manifestPath, '快照清单缺少合法 package');
        continue;
      }
      packageName = manifest.package;
      if (seenPackages.has(packageName)) {
        report(errors, 'DUPLICATE_PACKAGE', packageName, dir, manifestPath, '同一个包存在多份快照，拒绝任选一份');
        continue;
      }
      seenPackages.add(packageName);
      if (manifest.hasConfig !== undefined && typeof manifest.hasConfig !== 'boolean') {
        report(errors, 'HAS_CONFIG_INVALID', packageName, dir, manifestPath, 'hasConfig 必须为布尔值');
        continue;
      }
      if (manifest.configHash !== undefined && (typeof manifest.configHash !== 'string' || !/^[a-f0-9]{64}$/i.test(manifest.configHash))) {
        report(errors, 'CONFIG_HASH_INVALID', packageName, dir, manifestPath, 'configHash 必须为 SHA256 十六进制摘要');
        continue;
      }
      if (manifest.hasConfig === false && manifest.configHash !== undefined) {
        report(errors, 'CONFIG_MANIFEST_CONFLICT', packageName, dir, manifestPath, 'hasConfig:false 与 configHash 冲突');
        continue;
      }
      const configStat = fileStat(configPath);
      const hasConfig = manifest.hasConfig === undefined ? Boolean(configStat || manifest.configHash) : manifest.hasConfig;
      if (manifest.hasConfig === undefined) {
        report(warnings, 'LEGACY_HAS_CONFIG', packageName, dir, manifestPath, '旧快照没有 hasConfig，兼容按配置文件推断');
      }
      let configText = '';
      if (!hasConfig) {
        // 明确的无配置优先于旧文件；不读取它，更不会恢复到目标电脑。
        if (configStat) report(warnings, 'STALE_CONFIG_IGNORED', packageName, dir, configPath, 'hasConfig:false，已忽略残留 config.yml');
      } else {
        if (!configStat) {
          report(errors, 'CONFIG_MISSING', packageName, dir, configPath, '快照声明有配置，但缺少 config.yml');
          continue;
        }
        if (!configStat.isFile() || configStat.isSymbolicLink()) {
          report(errors, 'CONFIG_NOT_FILE', packageName, dir, configPath, '快照配置不是普通文件');
          continue;
        }
        const bytes = readFileSync(configPath);
        if (manifest.configHash !== undefined && configDigest(bytes) !== manifest.configHash.toLowerCase()) {
          report(errors, 'CONFIG_HASH_MISMATCH', packageName, dir, configPath, '快照配置 SHA256 不符，可能被篡改或尚未完整提交');
          continue;
        }
        if (manifest.configHash === undefined) {
          report(warnings, 'LEGACY_CONFIG_NO_HASH', packageName, dir, configPath, '旧快照没有配置摘要，兼容读取但完整性未验证');
        }
        configText = bytes.toString('utf8');
      }
      if (!invalidPackages.has(packageName)) byPackage.set(packageName, { dir, manifest, configText });
    } catch (error) {
      report(errors, 'SNAPSHOT_UNREADABLE', packageName, dir, manifestPath, `快照不可读取: ${error.code || error.message}`);
    }
  }
  return { root, byPackage, ok: errors.length === 0, warnings, errors };
}

/**
 * 删掉某个插件的配置快照目录（取消云同步 / 从云清单删除时用）。
 * 只动仓库里由「同步到云」生成的那份目录，不碰本机任何配置。
 */
export function removePluginBundle(repoRoot, packageName) {
  const dir = resolvePluginBundleDir(repoRoot, packageName);
  if (!existsSync(dir)) return { removed: false, dir };
  rmSync(dir, { recursive: true, force: true });
  return { removed: true, dir };
}
