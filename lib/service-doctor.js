import { accessSync, constants, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { hostname as osHostname, tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  buildScriptLaunchSpec,
  createBackgroundServiceManager,
  healthProbeCandidates,
  isRunnableScriptPath,
  isWindowsSystemBootService,
  probeServiceEndpointAlive,
  resolveServiceDefinition,
  resolveServiceConfigPath,
  resolveControllerPythonLaunch,
  resolveLaunchdPlistPath,
  resolveStartupDir,
  serviceControlCapability,
  syncBootStartupEntry,
  usesControllerService,
  validateServiceControlRequest,
} from './background-services.js';
import {
  applyLocalBinding,
  expandLocalPath,
  loadLocalBindings,
  loadLocalBindingState,
  toRepoRelativePath,
} from './local-bindings.js';

/** Doctor 只读取已有镜像，不触发配置或旧绑定迁移。 */
function profileFromState(bindingsData, stateData) {
  const state = stateData.services || {};
  const ids = Object.keys(bindingsData.services || {});
  const enabled = ids.filter((id) => state[id]?.enabled === true);
  return {
    enabled,
    autoStartOnBoot: enabled.filter((id) => state[id]?.autoStartOnBoot === true),
    autoStartOnDsh: enabled.filter((id) => state[id]?.autoStartOnDsh === true),
  };
}

/** 仅检查元数据与权限；配置文件可能含凭据，绝不读取其内容。 */
function inspectPath(filePath, platformOs) {
  const result = { exists: false, isFile: false, isDirectory: false, readable: false, executable: false, error: '' };
  if (!filePath) return result;
  try {
    const stat = statSync(filePath);
    result.exists = true;
    result.isFile = stat.isFile();
    result.isDirectory = stat.isDirectory();
    if (result.isFile) {
      try { accessSync(filePath, constants.R_OK); result.readable = true; } catch {}
      try {
        accessSync(filePath, platformOs === 'win32' ? constants.F_OK : constants.X_OK);
        result.executable = true;
      } catch {}
    }
  } catch (error) {
    result.error = String(error.code || 'UNKNOWN');
  }
  return result;
}

/** 按 PATH/PATHEXT 找实际解释器，不执行 --version，也不尝试启动服务。 */
function inspectCommand(command, platformOs, env) {
  const result = { command: command || '', resolved: '', exists: false };
  if (!command) return result;
  const candidates = [];
  if (path.isAbsolute(command) || /[\\/]/.test(command)) {
    candidates.push(path.resolve(command));
  } else {
    const searchPath = env.PATH || env.Path || env.path || '';
    const extensions = platformOs === 'win32' && !path.extname(command)
      ? ['', ...(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
      : [''];
    for (const dir of searchPath.split(platformOs === 'win32' ? ';' : ':').filter(Boolean)) {
      for (const ext of extensions) candidates.push(path.join(dir.replace(/^"|"$/g, ''), command + ext));
    }
  }
  for (const candidate of candidates) {
    const info = inspectPath(candidate, platformOs);
    if (info.isFile && info.executable) return { ...result, resolved: candidate, exists: true };
  }
  return result;
}

/** 旧目录的分号多路径逐项诊断，未展开模板单独标注，不能误称已检查。 */
function inspectConfigPaths(value, platformOs) {
  return String(value || '').split(/\s*;\s*/).filter(Boolean).map((raw) => {
    const expanded = resolveServiceConfigPath(raw);
    const unverifiable = /<[^>]+>|%[^%]+%/.test(expanded);
    const resolved = unverifiable ? expanded : expandLocalPath(expanded);
    return { raw, resolved, unverifiable, ...inspectPath(unverifiable ? '' : resolved, platformOs) };
  });
}

/**
 * 检查单个已登记本地服务是否支持插件完整管理：
 * 覆盖路径规范（仓库内相对路径 / 外部路径）、本机启用、开机自启、随 DSH 自启、启动 / 重启 / 停止及探活状态。
 */
export async function inspectLocalServiceManagement(serviceId, options = {}) {
  const targetHostname = options.hostname || osHostname();
  const platformOs = options.platform || process.platform;
  const bindingsData = options.bindingsData || loadLocalBindings(targetHostname, { migrate: false });
  const stateData = options.stateData || loadLocalBindingState(bindingsData.machineId);
  const profile = options.profile || profileFromState(bindingsData, stateData);
  const rawBound = bindingsData.services?.[serviceId];
  if (!rawBound || typeof rawBound !== 'object') {
    return {
      id: serviceId,
      registered: false,
      status: 'unregistered',
      issues: [`服务 ${serviceId} 未在 ${bindingsData.filePath} 的 services 段登记`],
    };
  }

  const baseEntry = resolveServiceDefinition(serviceId, { bindings: bindingsData.services }) || { id: serviceId, name: rawBound.name || serviceId };
  const entry = applyLocalBinding(baseEntry, bindingsData.services, stateData.services);
  const rawScriptPath = typeof rawBound.scriptPath === 'string' ? rawBound.scriptPath.trim() : '';
  const resolvedScriptPath = expandLocalPath(rawScriptPath);
  const repoRelative = toRepoRelativePath(rawScriptPath);
  const isInRepo = Boolean(repoRelative);
  // 若路径指向本仓库内且当前仓库内确实存在该文件，则要求 JSON 直接记录相对路径
  const inRepoExists = isInRepo && existsSync(path.resolve(resolvedScriptPath));
  const usesRepoRelative = !inRepoExists || rawScriptPath === repoRelative;
  const runnableScript = isRunnableScriptPath(rawScriptPath, platformOs);
  const scriptInfo = inspectPath(resolvedScriptPath, platformOs);
  const scriptExists = scriptInfo.exists;
  const configPaths = inspectConfigPaths(rawBound.configPath ?? entry.configPath, platformOs);
  const cachePaths = inspectConfigPaths(rawBound.cacheDir ?? entry.cacheDir, platformOs);
  const launchSpec = runnableScript
    ? buildScriptLaunchSpec(resolvedScriptPath, {
      platform: platformOs,
      windowless: true,
      cwd: entry.workdir,
      args: rawBound.args,
    })
    : null;

  const capability = (platformOs === 'darwin' && entry?.launchd)
    ? { canControl: true, controlReason: '' }
    : serviceControlCapability(serviceId, {
      hostname: targetHostname,
      bindings: bindingsData.services,
      entry,
      platform: platformOs,
    });

  const checkAction = (action) => {
    if (!capability.canControl) {
      return { supported: false, reason: capability.controlReason };
    }
    if (entry.control === 'view') {
      return { supported: false, reason: '未配置 scriptPath 或平台启动器' };
    }
    const check = validateServiceControlRequest(serviceId, action, { entry, device: options.device || 'DOCTOR_PROBE_DEVICE' });
    return {
      supported: check.ok,
      reason: check.ok ? '' : check.error,
    };
  };

  const startCap = checkAction('start');
  const restartCap = checkAction('restart');
  const stopCap = checkAction('stop');
  const isStartOnly = entry.control === 'start-only';
  const isWinScm = isWindowsSystemBootService(serviceId, platformOs);

  // 脚本后缀只是候选类型；平台原生通道的优先级要与实际管理器一致。
  const nativeCapability = serviceControlCapability(serviceId, {
    hostname: targetHostname, bindings: {}, entry: { ...entry, scriptPath: '' }, platform: platformOs,
  });
  const controlChannel = (platformOs === 'darwin' && entry.launchd && (existsSync(resolveLaunchdPlistPath(entry)) || !runnableScript))
    ? 'launchd'
    : ((platformOs === 'win32' && nativeCapability.canControl && !options.preferScriptRunner)
        || usesControllerService(serviceId, {
          platform: platformOs,
          preferScriptRunner: options.preferScriptRunner,
          bindings: bindingsData.services,
          entry,
        }))
      ? 'platform-controller'
      : runnableScript
        ? 'scriptPath'
        : capability.canControl
          ? 'platform-controller'
          : 'monitor-only';
  const command = controlChannel === 'scriptPath' ? launchSpec?.command
    : controlChannel === 'launchd' ? 'launchctl'
      : controlChannel === 'platform-controller' ? resolveControllerPythonLaunch().command : '';
  const execution = inspectCommand(command, platformOs, options.env || process.env);

  const enabledFlag = Boolean(profile.enabled?.includes(serviceId));
  const bootFlag = Boolean(profile.autoStartOnBoot?.includes(serviceId));
  const dshFlag = Boolean(profile.autoStartOnDsh?.includes(serviceId));

  const capabilities = {
    enabled: {
      supported: true,
      current: enabledFlag,
      detail: '已登记在本机绑定 JSON，可通过 state.json 切换本机启用',
    },
    autoStartOnBoot: {
      supported: isWinScm || capability.canControl,
      current: bootFlag,
      mode: isWinScm ? 'windows-scm' : controlChannel,
      requiresEnabled: !enabledFlag,
      detail: isWinScm
        ? '由 Windows 系统服务 (SCM) 管理开机自启'
        : capability.canControl
          ? (enabledFlag ? '支持同步到系统开机自启项' : '支持开机自启（需先开启本机启用）')
          : capability.controlReason,
    },
    autoStartOnDsh: {
      supported: capability.canControl,
      current: dshFlag,
      requiresEnabled: !enabledFlag,
      detail: capability.canControl
        ? (enabledFlag ? '支持随 DSH 启动无头拉起' : '支持随 DSH 自启（需先开启本机启用）')
        : capability.controlReason,
    },
    start: startCap,
    restart: isStartOnly
      ? { supported: false, byDesign: true, reason: '共享依赖 (start-only) 设计上禁止从面板重启' }
      : restartCap,
    stop: isStartOnly
      ? { supported: false, byDesign: true, reason: '共享依赖 (start-only) 设计上禁止从面板停止' }
      : stopCap,
  };

  const running = options.skipNetworkProbe ? null : await probeServiceEndpointAlive(entry);
  const issues = [];
  const warnings = [];

  if (rawScriptPath && !usesRepoRelative) {
    issues.push(`本项目内脚本路径应直接写仓库相对路径 "${repoRelative}"（当前为 "${rawScriptPath}"）`);
  }
  if (rawScriptPath && !scriptExists) {
    issues.push(`绑定的脚本文件不存在或无法访问：${resolvedScriptPath}`);
  } else if (rawScriptPath && !scriptInfo.isFile) {
    issues.push(`scriptPath 指向${scriptInfo.isDirectory ? '目录' : '非普通文件'}，不是可执行脚本文件：${resolvedScriptPath}`);
  } else if (rawScriptPath && !scriptInfo.readable) {
    issues.push(`scriptPath 文件不可读：${resolvedScriptPath}`);
  }
  if (rawScriptPath && !runnableScript) {
    issues.push(`scriptPath 格式在当前平台不可执行；配置文件不能充当启动脚本：${rawScriptPath}`);
  }
  if (execution.command && !execution.exists) {
    issues.push(`运行解释器或程序不可用（PATH 中缺失、不是普通文件或无执行权限）：${execution.command}`);
  }
  for (const config of configPaths) {
    if (config.unverifiable) {
      warnings.push(`configPath 含未解析占位符，未验证：${config.raw}`);
    } else if (config.isDirectory) {
      issues.push(`configPath 指向目录而不是配置文件；缓存目录应单独标注：${config.resolved}`);
    } else if (!config.exists) {
      warnings.push(`configPath 对应的配置资源不存在或无法访问，未验证其可用性：${config.resolved}`);
    }
  }
  for (const cache of cachePaths) {
    if (cache.unverifiable) warnings.push(`cacheDir 含未解析占位符，未验证：${cache.raw}`);
    else if (cache.exists && !cache.isDirectory) issues.push(`cacheDir 不是缓存目录：${cache.resolved}`);
    else if (!cache.exists) warnings.push(`cacheDir 尚不存在，可在挂载时创建：${cache.resolved}`);
  }
  if (controlChannel === 'scriptPath' && (!scriptInfo.isFile || !scriptInfo.readable || !execution.exists)) {
    for (const key of ['start', 'restart', 'stop', 'autoStartOnBoot', 'autoStartOnDsh']) {
      capabilities[key] = { ...capabilities[key], supported: false, reason: '脚本文件或运行解释器未就绪' };
    }
  }
  // 显式停止入口不能被当作普通 PID 停止：缺失或不兼容时报告配置异常。
  const rawStopPath = typeof rawBound.stopScriptPath === 'string' ? rawBound.stopScriptPath.trim() : '';
  if (Object.hasOwn(rawBound, 'stopScriptPath')) {
    const stopPath = expandLocalPath(rawStopPath);
    const stopRepoPath = toRepoRelativePath(rawStopPath);
    if (!isRunnableScriptPath(rawStopPath, platformOs) || !existsSync(stopPath)) {
      issues.push('stopScriptPath 不存在或不是当前平台可执行脚本');
    }
    if (stopRepoPath && existsSync(stopPath) && rawStopPath !== stopRepoPath) {
      issues.push(`本项目内停止脚本路径应直接写仓库相对路径 "${stopRepoPath}"`);
    }
  }
  if (!capability.canControl) {
    warnings.push(`当前仅支持状态监控，不支持启停与自启（在绑定 JSON 中补充 scriptPath 即可直接由插件管理）`);
  }

  const lifecycleFullyManaged = issues.length === 0 && capabilities.enabled.supported
    && capabilities.autoStartOnBoot.supported
    && capabilities.autoStartOnDsh.supported
    && capabilities.start.supported
    && (capabilities.restart.supported || capabilities.restart.byDesign)
    && (capabilities.stop.supported || capabilities.stop.byDesign);

  let lifecycleProbe = null;
  if (options.probeLifecycle && issues.length > 0) {
    lifecycleProbe = { ok: false, skipped: true, error: '静态配置检查未通过，未执行任何启停' };
  } else if (options.probeLifecycle) {
    lifecycleProbe = await runServiceLifecycleProbe(serviceId, entry, {
      hostname: targetHostname,
      platform: platformOs,
      initiallyRunning: Boolean(running),
      timeoutMs: options.timeoutMs,
      preferScriptRunner: options.preferScriptRunner,
    });
    if (!lifecycleProbe.ok) {
      issues.push(`生命周期实测未通过：${lifecycleProbe.error}`);
    }
  }

  const status = issues.length > 0
    ? 'misconfigured'
    : lifecycleFullyManaged
      ? 'managed'
      : 'monitor-only';

  return {
    id: serviceId,
    name: entry.name || serviceId,
    registered: true,
    status,
    controlChannel,
    controlMode: entry.control || 'view',
    scriptPath: {
      raw: rawScriptPath,
      resolved: resolvedScriptPath,
      isInRepo,
      expectedRepoRelative: repoRelative,
      usesRepoRelative,
      runnable: runnableScript,
      exists: scriptExists,
      isFile: scriptInfo.isFile,
      isDirectory: scriptInfo.isDirectory,
      readable: scriptInfo.readable,
      launchSpec,
    },
    execution,
    configPaths,
    cachePaths,
    evaluationMode: options.probeLifecycle ? 'lifecycle' : 'static',
    health: {
      declared: entry.health || '',
      candidates: healthProbeCandidates(entry.health),
      port: entry.port || null,
      running,
    },
    capabilities,
    lifecycleFullyManaged,
    lifecycleProbe,
    issues,
    warnings,
  };
}

/**
 * 对指定本地服务执行真实的管理闭环探针：
 * 1. 验证开机自启启动项生成与清理（在临时隔离目录内，不污染真实系统 Startup/LaunchAgents）；
 * 2. 验证 start -> restart -> stop 控制闭环（若服务原本在运行，测试结束后恢复运行状态）。
 */
export async function runServiceLifecycleProbe(serviceId, entry, options = {}) {
  const targetHostname = options.hostname || osHostname();
  const platformOs = options.platform || process.platform;
  const steps = {};
  const tempStartupDir = mkdtempSync(path.join(tmpdir(), 'dsh-au-doctor-startup-'));
  const prevStartupDir = process.env.DSH_AU_STARTUP_DIR;
  process.env.DSH_AU_STARTUP_DIR = tempStartupDir;
  try {
    const bootOn = await syncBootStartupEntry(targetHostname, {
      enabled: [serviceId],
      autoStartOnBoot: [serviceId],
      autoStartOnDsh: [serviceId],
    }, platformOs);
    const launchdSkipped = (bootOn.launchd || []).some((item) => item.id === serviceId && item.skipped);
    steps.bootSyncEnable = {
      ok: launchdSkipped || Boolean(bootOn.synced && bootOn.activeServices?.includes(serviceId)),
      skipped: launchdSkipped,
      mode: 'isolated-generation',
      activeServices: bootOn.activeServices,
      filePath: bootOn.filePath,
    };
    const bootOff = await syncBootStartupEntry(targetHostname, {
      enabled: [],
      autoStartOnBoot: [],
      autoStartOnDsh: [],
    }, platformOs);
    steps.bootSyncDisable = {
      ok: Boolean(bootOff.synced && bootOff.activeServices.length === 0),
      skipped: steps.bootSyncEnable.skipped,
      mode: 'isolated-generation',
    };
  } finally {
    if (prevStartupDir === undefined) delete process.env.DSH_AU_STARTUP_DIR;
    else process.env.DSH_AU_STARTUP_DIR = prevStartupDir;
    rmSync(tempStartupDir, { recursive: true, force: true });
  }

  const failedBoot = Object.entries(steps).find(([, step]) => !step.ok && !step.skipped);
  if (failedBoot) return { ok: false, complete: false, error: `${failedBoot[0]} 隔离启动项检查失败，未执行服务启停`, steps };
  const manager = createBackgroundServiceManager();
  const startRes = await manager.controlService(serviceId, 'start', { preferScriptRunner: options.preferScriptRunner });
  steps.start = { ok: Boolean(startRes.ok), skipped: Boolean(startRes.skipped), message: startRes.message || startRes.error || '' };
  if (!startRes.ok) {
    return { ok: false, error: `start 失败: ${steps.start.message}`, steps };
  }

  if (entry.control !== 'start-only') {
    const restartRes = await manager.controlService(serviceId, 'restart', { preferScriptRunner: options.preferScriptRunner });
    steps.restart = { ok: Boolean(restartRes.ok), message: restartRes.message || restartRes.error || '' };
    if (!restartRes.ok) {
      return { ok: false, error: `restart 失败: ${steps.restart.message}`, steps };
    }

    const stopRes = await manager.controlService(serviceId, 'stop', { preferScriptRunner: options.preferScriptRunner });
    steps.stop = { ok: Boolean(stopRes.ok), message: stopRes.message || stopRes.error || '' };
    if (!stopRes.ok) {
      return { ok: false, error: `stop 失败: ${steps.stop.message}`, steps };
    }

    if (options.initiallyRunning) {
      const restoreRes = await manager.controlService(serviceId, 'start', { preferScriptRunner: options.preferScriptRunner });
      steps.restore = { ok: Boolean(restoreRes.ok), message: restoreRes.message || restoreRes.error || '' };
    }
  }

  const failedStep = Object.entries(steps).find(([, step]) => !step.ok && !step.skipped);
  return {
    ok: !failedStep,
    complete: !failedStep && Object.values(steps).every((step) => !step.skipped),
    error: failedStep ? `${failedStep[0]} 检查失败` : '',
    steps,
  };
}

/**
 * 批量体检当前机器（或指定机器）的全部已登记本地服务。
 */
export async function runLocalServicesDoctor(options = {}) {
  // 在读取任何本机状态前阻止全机启停；库调用同样不能绕过 CLI 的单服务门禁。
  if (options.probeLifecycle && (typeof options.serviceId !== 'string' || !options.serviceId.trim())) {
    throw new Error('--probe-lifecycle 必须指定唯一的 --service <id>，禁止全机启停体检');
  }
  const targetHostname = options.hostname || osHostname();
  const platformOs = options.platform || process.platform;
  const bindingsData = loadLocalBindings(targetHostname, { migrate: false });
  const stateData = loadLocalBindingState(bindingsData.machineId);
  const profile = profileFromState(bindingsData, stateData);
  const startupDir = resolveStartupDir(platformOs);

  const allIds = Object.keys(bindingsData.services || {});
  const targetIds = options.serviceId ? [options.serviceId] : allIds;

  const services = [];
  for (const id of targetIds) {
    services.push(await inspectLocalServiceManagement(id, {
      ...options,
      hostname: targetHostname,
      platform: platformOs,
      bindingsData,
      stateData,
      profile,
    }));
  }

  const managedCount = services.filter((item) => item.status === 'managed').length;
  const monitorOnlyCount = services.filter((item) => item.status === 'monitor-only').length;
  const misconfiguredCount = services.filter((item) => item.status === 'misconfigured' || item.status === 'unregistered').length;

  return {
    ok: !bindingsData.error && misconfiguredCount === 0,
    checkedAt: new Date().toISOString(),
    machine: {
      hostname: targetHostname,
      machineId: bindingsData.machineId,
      platform: platformOs,
      bindingFile: bindingsData.filePath,
      bindingExists: Boolean(bindingsData.exists),
      bindingError: bindingsData.error || '',
      stateFile: stateData.filePath,
      startupDir,
    },
    summary: {
      total: services.length,
      managed: managedCount,
      monitorOnly: monitorOnlyCount,
      misconfigured: misconfiguredCount,
    },
    services,
  };
}
