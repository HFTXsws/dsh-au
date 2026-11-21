import { createRequire } from 'node:module';
import { homedir, hostname } from 'node:os';
import { join, relative, sep } from 'node:path';
import {
  deleteSharedDevice,
  deleteSharedDeviceRoute,
  getLocalDshPluginInventory,
  getLocalHostInfo,
  getMachineDshPluginIds,
  getMachineDshPluginProfiles,
  getMachineServiceProfile,
  getMachineServiceProfiles,
  getSharedCloudServiceIds,
  getSharedDevices,
  getSharedDshPlugins,
  applyDiscoveredLanPeer,
  publishLocalLanShare,
  loadConfig,
  normalizeRemote,
  promoteLocalDshPluginToCloud,
  promoteLocalServiceToCloud,
  readLocalDshBundleOrder,
  removeCloudDshPlugin,
  saveConfig,
  updateMachineServiceProfile,
  updateMachineServiceFlag,
  updateSharedDevice,
  updateSharedDeviceRoute,
} from './config-store.js';
import { createStatusTracker } from './status-tracker.js';
import { createAckStore } from './ack-store.js';
import { maximizeWindowsAppWindow, normalizeWindowGeometry, normalizeWindowState, resolveRestoreTarget } from './window-state.js';
import { normalizeAutoContinue, normalizeFeatures } from './features.js';
import { installAutoContinueRecovery } from './auto-continue-recovery.js';
import { installGoalCreationPolicy } from './goal-creation-policy.js';
import {
  buildCloudPluginSyncItems,
  buildOfficialSyncItems,
  buildOfficialSyncItemsByProfile,
  buildPreferenceSyncItems,
  computeOfficialSettingsHash,
  pushNewerInstalledPluginVersions,
  getAllCloudPluginIds,
  normalizeCloudSyncConfig,
  pushLocalOfficialSettingsToRepo,
  runRestoreScriptForCloudSync,
} from './official-settings-sync.js';
import { registerTodoRoutes } from './todo/index.js';
import { createLanBridge } from './lan-bridge.js';
import { LAN_PASSWORD_MIN_LENGTH, hashLanPassword, verifyLanPassword } from './lan-auth.js';
import { createLanDiscovery } from './lan-discovery.js';
import { createRemoteProxyPool } from './remote-proxy-pool.js';
import { applyScreenLockRemoteConnections } from './screen-lock-remotes.js';
import { startWindowsSessionLockWatcher } from './windows-session-lock.js';
import { createMenuRunner, loadMenuSpec, normalizePlatformOs } from './menu-runner.js';
import { createBackgroundServiceManager, detectLocalServicePathByPort, isWindowsSystemBootService, setRuntimeServicePort, syncBootStartupEntry } from './background-services.js';
import {
  listMachineBindings,
  loadLocalBindings,
  loadMenuFavorites,
  normalizeMenuFavorites,
  saveMenuFavorites,
  updateMachinePlugins,
  switchActiveBinding,
  cloudDefinitionToLocalBinding,
  setLocalBindingService,
  writeLocalBindingState,
} from './local-bindings.js';
import { readCloudManifest, removeCloudService, upsertCloudService } from './cloud-manifest.js';
import { readModelShortcuts, saveModelShortcuts } from './model-shortcuts.js';
import { createRemoteModelShortcuts } from './remote-model-shortcuts.js';
import { createRuntimeBridge } from './runtime-bridge.js';
import { createInitialSessionFocusResolver } from './initial-session-focus.js';
import { createSessionPreloadCache } from './session-preload.js';
import { listRootSessionIds, readSessionEventsAfter, subscribeSessionEvents } from './session-reader.js';
import { logNet, readNetLog, recordClientEvent, recordRouteChange, resolveNetLogPath } from './net-log.js';
import { runLocalServicesDoctor } from './service-doctor.js';
import { installOversizedRequestRecovery } from './oversized-request-recovery.js';
import { createClientControlIpcServer } from './client-control/ipc-server.js';
import { capturePluginBundle, previewPluginRestore } from './plugin-sync-core.js';
import { getRepoRoot, hasSyncRepo } from './sync-repo.js';
import { applySingleDshPluginState, runPluginsDoctor, syncDshPlugins } from './plugin-sync-jobs.js';
import {
  invokePrivateExtensionAction,
  listPrivateExtensionsForClient,
} from './private-extensions.js';
import { getConnectionRejection } from './http-auth.js';

export const name = 'dsh-au';
const HOST_APPLY_LOCK = '__dshAuHostApplyActive';

/**
 * 把这台机器上一个插件的 patch 配置块存进仓库（sync/plugins/<slug>/）。
 * 找不到配置块不算失败：没有 config 的插件照样只同步「安装 + 启用」。
 */
function writeLocalPluginBundle(packageName) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const captured = capturePluginBundle({
    packageName: typeof packageName === 'string' ? packageName : '',
    dshHome,
    syncedFrom: hostname(),
  });
  if (!captured.ok) throw new Error(captured.error);
  return {
    slug: captured.slug,
    dir: captured.dir,
    files: captured.files,
    hasConfig: captured.hasConfig,
    patchId: captured.patchId,
  };
}

/** 读取 JSON 请求体 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (raw.length < 256 * 1024) raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

/** 读取顶部设备栏提交的同源跳转表单；路线 ID 白名单始终在服务端验证。 */
function readFormBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { if (raw.length < 16 * 1024) raw += chunk; });
    req.on('end', () => {
      try { resolve(Object.fromEntries(new URLSearchParams(raw))); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

/** 服务端将本机保存的 Basic Auth 凭据只写进一次性导航响应，不让密码进入客户端 API 数据。 */
function buildAuthenticatedRemoteUrl(remote) {
  const target = new URL(remote.url);
  if (remote.username || remote.password) {
    target.username = remote.username || '';
    target.password = remote.password || '';
  }
  return target.href;
}

/** 把锁屏变化交给当前这份宿主。热重载后仍指向活着的连接池。 */
function publishScreenLock(locked) {
  const next = locked === true;
  if (globalThis.__dshAuScreenLockSeen === true && globalThis.__dshAuSystemLocked === next) return;
  globalThis.__dshAuScreenLockSeen = true;
  globalThis.__dshAuSystemLocked = next;
  console.info(next ? '[dsh-au] screen locked' : '[dsh-au] screen unlocked');
  try {
    globalThis.__dshAuNotifyScreenLock?.(next);
  } catch (err) {
    console.warn('[dsh-au] screen lock handler failed:', err?.message || err);
  }
}

/**
 * 插件是 ESM，直接 require 会抛错；宿主又是 Node 模式的 Electron，通常没有 powerMonitor。
 * 两种都失败时，改读 Windows 会话锁。测试进程不启动常驻监视器。
 */
function installScreenLockMonitor() {
  if (globalThis.__dshAuScreenLockWatcher) return;
  try {
    const { powerMonitor } = createRequire(import.meta.url)('electron');
    if (powerMonitor && typeof powerMonitor.on === 'function') {
      powerMonitor.on('lock-screen', () => publishScreenLock(true));
      powerMonitor.on('unlock-screen', () => publishScreenLock(false));
      globalThis.__dshAuScreenLockWatcher = { stop() {} };
      console.info('[dsh-au] powerMonitor screen-lock listener registered');
      return;
    }
  } catch (err) {
    if (process.env.DSH_AU_DEBUG) {
      console.debug('[dsh-au] powerMonitor unavailable:', err?.message || err);
    }
  }
  if (process.platform !== 'win32' || process.env.NODE_TEST_CONTEXT) return;
  console.info('[dsh-au] screen lock watcher started (windows session events)');
  globalThis.__dshAuScreenLockWatcher = startWindowsSessionLockWatcher({
    onLockChange: publishScreenLock,
    onError(err) {
      console.warn('[dsh-au] screen lock watcher failed:', err?.message || err);
    },
  });
}
installScreenLockMonitor();

export function apply(ctx) {
  // 市场热挂载与 profile bundle 同时存在时，只让第一个宿主实例注册路由和后台轮询。
  if (globalThis[HOST_APPLY_LOCK]) {
    console.warn('[dsh-au] skipped duplicate host loader');
    return;
  }
  globalThis[HOST_APPLY_LOCK] = true;
  let cfg = loadConfig();
  // 全局 guard 随 tools 注入生命周期注册一次，并始终读取同一个实时配置入口。
  const goalCreationPolicy = installGoalCreationPolicy(ctx, () => cfg);
  let observedLocalPort = 0;

  /**
   * 将宿主权限预设中的 defaultPreset 与 fullAccessByDefault 开关状态同步。
   * 开启时设为 danger-full-access，关闭时恢复为 workspace-write。
   */
  async function syncHostDefaultPreset(enabled) {
    const targetPreset = enabled ? 'danger-full-access' : 'workspace-write';
    try {
      const settings = ctx.get?.('settings') || ctx.settings;
      if (settings && typeof settings.mutate === 'function') {
        await settings.mutate('permission', [
          { op: 'set', path: ['defaultPreset'], value: targetPreset },
        ]);
        return;
      }
      if (settings && typeof settings.update === 'function') {
        await settings.update('permission', { defaultPreset: targetPreset });
      }
    } catch (err) {
      console.warn('[dsh-au] failed to sync host defaultPreset:', err?.message || err);
    }
  }

  // 监听宿主新会话创建事件：若开启 fullAccessByDefault，确保新会话应用 danger-full-access
  ctx.on?.('session/created', (session) => {
    if (!cfg.features?.fullAccessByDefault) return;
    try {
      const presets = ctx.get?.('permissionPresets') || ctx.permissionPresets;
      if (presets && typeof presets.apply === 'function') {
        presets.apply(session, 'danger-full-access');
      }
    } catch (err) {
      console.warn('[dsh-au] failed to apply danger-full-access on session/created:', err?.message || err);
    }
  });

  if (cfg.features?.fullAccessByDefault) {
    void syncHostDefaultPreset(true);
  }

  // 只接管 Responses 网关 32 MiB 的 413：从当前 Agent preset 取隔离压缩服务，成功替换历史后原地重试一次。
  ctx.effect(() => installOversizedRequestRecovery(ctx), 'dsh-au: oversized Responses request recovery');
  // 接管 503/断连原地等待与自动压缩重试，以及 max-tokens/interrupted 截断续写。
  ctx.effect(() => installAutoContinueRecovery(ctx, () => cfg), 'dsh-au: auto-continue recovery');

  // Agent 控制面只监听本机 named pipe / Unix socket；不注册 HTTP 路由，避免 LAN/远端页面代发消息。
  ctx.inject(['sessionController'], (hostCtx) => {
    const clientControl = createClientControlIpcServer({ ctx });
    void clientControl.start().then((paths) => {
      console.info(`[dsh-au] client-control IPC ready: ${paths.endpoint}`);
    }).catch((error) => {
      console.warn('[dsh-au] client-control IPC unavailable:', error?.message || error);
    });
    hostCtx.effect(() => () => { void clientControl.close(); }, 'dsh-au: client-control IPC');
  });

  // 启动时先把「仅版本更新」的勾选插件写上云，再按云端快照决定要不要拉回本机。
  if (cfg.cloudSync?.enabled && process.env.DSH_AU_DISABLE_AUTO_START !== '1') {
    try {
      const hashBefore = computeOfficialSettingsHash(getRepoRoot(), cfg.cloudSync.profile);
      let pushedVersions = { updated: [] };
      try {
        pushedVersions = pushNewerInstalledPluginVersions({
          repoRoot: getRepoRoot(),
          selectedPlugins: cfg.cloudSync.selectedPlugins,
        });
      } catch (err) {
        console.warn('[dsh-au] plugin version auto sync failed:', err?.message || err);
      }
      const currentHash = computeOfficialSettingsHash(getRepoRoot(), cfg.cloudSync.profile);
      // 这次哈希变化只来自刚推上去的版本号。本机已经装着这些版本，不能再按云端把它们装一遍。
      const onlyVersionPush = pushedVersions.updated?.length > 0
        && hashBefore
        && hashBefore === cfg.cloudSync.lastSyncedHash
        && currentHash
        && currentHash !== hashBefore;
      if (onlyVersionPush) {
        cfg.cloudSync = normalizeCloudSyncConfig({
          ...cfg.cloudSync,
          lastSyncedHash: currentHash,
          lastSyncedAt: new Date().toISOString(),
        });
        saveConfig(cfg);
      }
      if (currentHash && currentHash !== cfg.cloudSync.lastSyncedHash) {
        const synced = runRestoreScriptForCloudSync({
          repoRoot: getRepoRoot(),
          profile: cfg.cloudSync.profile,
          selectedItems: cfg.cloudSync.selectedItems,
          selectedPlugins: cfg.cloudSync.selectedPlugins,
          syncPluginConfigs: cfg.cloudSync.syncPluginConfigs,
          autoSync: true,
        });
        if (synced.ok && !synced.skipped) {
          cfg = loadConfig();
          cfg.cloudSync = normalizeCloudSyncConfig({
            ...cfg.cloudSync,
            lastSyncedHash: synced.hash,
            lastSyncedAt: synced.syncedAt || new Date().toISOString(),
          });
          saveConfig(cfg);
          globalThis.__dshAuCloudSyncRestartRequired = Boolean(synced.restartRequired);
        }
      }
    } catch (err) {
      console.warn('[dsh-au] startup cloud sync check failed:', err?.message || err);
    }
  }

  /**
   * 只按云清单与本机配置算出四张名单，不探测任何端口。
   * 开关保存后立刻回传这份数据，前端据此更新显示，不必等一轮健康检测。
   */
  function localStateLists(host) {
    const profile = getMachineServiceProfile(cfg, host);
    return {
      enabled: profile.enabled,
      autoStartOnBoot: profile.autoStartOnBoot,
      autoStartOnDsh: profile.autoStartOnDsh,
      cloud: getSharedCloudServiceIds(),
    };
  }

  /**
   * 常用收藏只认当前机器备份。没有私人仓库，或备份里没写收藏时，就是空的。
   * 不再回落到本机旧名单，避免清空私人路径后还看到以前的收藏。
   */
  function resolveMenuFavorites(host = hostname()) {
    const local = loadMenuFavorites(host);
    return Array.isArray(local.favorites) ? local.favorites : [];
  }

  /** 仓库内路径展示成相对路径，仓库外原样保留，避免把绝对路径回传给面板。 */
  function displayPath(filePath) {
    const rel = relative(getRepoRoot(), filePath);
    return rel && !rel.startsWith('..') ? rel.split(sep).join('/') : filePath;
  }

  /**
   * 本机绑定视图：当前用的是哪一份云备份、一共几份、每份属于哪台机器。
   * 只读目录，不探测端口，也不改任何文件。
   */
  function localBindingSnapshot(host = hostname()) {
    const bindings = loadLocalBindings(host);
    const listed = listMachineBindings(host);
    // 备份里存的是云清单的插件 id；面板给人看，转成包名更好认。
    const pluginLabels = new Map(getSharedDshPlugins().map((plugin) => [plugin.id, plugin.package || plugin.name || plugin.id]));
    const labelOf = (id) => pluginLabels.get(id) || id;
    return {
      machineId: listed.activeId || bindings.machineId,
      serviceIds: Object.keys(bindings.services || {}),
      displayName: bindings.displayName || '',
      file: displayPath(bindings.filePath),
      exists: Boolean(bindings.exists),
      plugins: bindings.plugins || [],
      pluginBundleOrder: bindings.pluginBundleOrder || [],
      currentHostId: listed.currentHostId,
      machinesDir: displayPath(listed.dir),
      machines: listed.items.map((item) => ({
        machineId: item.machineId,
        displayName: item.displayName,
        hostname: item.hostname,
        platform: item.platform,
        updatedAt: item.updatedAt,
        serviceCount: item.serviceCount,
        favoriteCount: item.favoriteCount,
        plugins: item.plugins.map(labelOf),
        pluginIds: item.plugins,
        pluginBundleOrder: item.pluginBundleOrder || [],
        pluginCount: item.pluginCount,
        broken: item.broken,
        active: item.active,
        currentHost: item.currentHost,
        file: displayPath(item.filePath),
      })),
    };
  }

  /** 刷新 state.json 里的 cloud 标记；其余开关本就读自 state.json（JSON 是唯一来源）。 */
  function mirrorLocalBindingState(targetHost) {
    try {
      const profile = getMachineServiceProfile(cfg, targetHost);
      const cloudIds = getSharedCloudServiceIds();
      writeLocalBindingState(targetHost, (serviceId) => ({
        enabled: profile.enabled.includes(serviceId),
        autoStartOnBoot: profile.autoStartOnBoot.includes(serviceId),
        autoStartOnDsh: profile.autoStartOnDsh.includes(serviceId),
        cloud: cloudIds.includes(serviceId),
      }));
    } catch {
      // 刷新失败不影响主流程。
    }
  }

  const statusTracker = createStatusTracker(() => ctx.get?.('agents'), {
    ackStore: createAckStore(),
    getArchivedSessionIds: () => ctx.get?.('workspaceRegistry')?.archivedSessionIds || [],
    listSessionIds: () => listRootSessionIds(ctx),
    readEventsAfter: (sessionId, afterSeq) => readSessionEventsAfter(ctx, sessionId, afterSeq),
    subscribe: (handler, hooks) => subscribeSessionEvents(ctx, handler, hooks),
  });
  const remotePool = createRemoteProxyPool({
    getAllowedOrigins: getLocalDshAllowedOrigins,
    onRemoteIdentity(remoteId, identity) {
      // 将已验证身份与本机远端配置一起保存，认证短暂失效时仍能识别同一物理设备。
      const remote = cfg.remotes.find((item) => item.id === remoteId);
      if (!remote) return;
      remote.knownIdentity = identity;
      saveConfig(cfg);
    },
  });
  const platformOs = normalizePlatformOs();
  const menuRunner = createMenuRunner(platformOs);
  const bgServices = createBackgroundServiceManager();
  // dsh-au-todo 等同进程插件只通过此桥访问会话、多机请求与蓝灯确认，禁止复制代理鉴权实现。
  const runtimeBridge = createRuntimeBridge({
    ctx,
    getConfig: () => cfg,
    remotePool,
    statusTracker,
    getLocalHostInfo,
  });
  // Host-owned native observations are shared across preload callers and disposed with this lifecycle.
  const sessionPreloadCache = createSessionPreloadCache({ ctx, onDiagnostic: (diag) => logNet('session.preload-stage', diag) });
  const remoteModelShortcuts = createRemoteModelShortcuts({ runtimeBridge });
  const sendRemoteModelResult = (res, result) => {
    const status = result?.ok ? 200 : (result?.status === 400 ? 400 : result?.status === 501 ? 501 : 502);
    sendJson(res, status, result?.ok ? result : { ok: false, error: result?.error || '远程模型请求失败' });
  };
  globalThis.__dshAuBridge = runtimeBridge;

  // 开关打开时，锁屏关掉到远程 DSH 的代理；解锁或关掉开关后再探活重连。
  function syncScreenLockConnections(locked) {
    const result = applyScreenLockRemoteConnections({
      locked: locked === true,
      enabled: cfg.features?.disconnectRemotesOnLock === true,
      pool: remotePool,
      probe: () => { void remotePool.probeAll(cfg.remotes); },
    });
    if (result === 'suspended') console.info('[dsh-au] screen lock closed remote DSH connections');
    else if (result === 'resumed') console.info('[dsh-au] screen unlock reopening remote DSH connections');
  }
  globalThis.__dshAuNotifyScreenLock = syncScreenLockConnections;

  function getLocalDshTarget() {
    const wsPort = Number(ctx.get?.('webServer')?.port) || observedLocalPort;
    if (!wsPort) return { origin: null, authUrl: null };
    const origin = `http://127.0.0.1:${wsPort}`;
    const conn = ctx.get?.('connection');
    let authUrl = origin;
    try {
      if (typeof conn?.authenticatedUrl === 'function') {
        authUrl = conn.authenticatedUrl(origin);
      }
    } catch {}
    return { origin, authUrl };
  }

  /** 当前真实端口和已登记本机入口是唯一跨源授权来源，不从请求头猜测可信设备。 */
  function getLocalDshAllowedOrigins() {
    const { origin } = getLocalDshTarget();
    const origins = origin ? [origin] : [];
    if (origin) {
      const port = new URL(origin).port;
      origins.push(`http://localhost:${port}`, `http://[::1]:${port}`);
    }
    const localDevice = getSharedDevices().find((device) => device.id === cfg.localDeviceId);
    for (const route of localDevice?.routes || []) {
      try { origins.push(new URL(route.url).origin); } catch {}
    }
    return [...new Set(origins)];
  }

  const lanBridge = createLanBridge({
    instanceId: cfg.instanceId,
    preferredPort: cfg.bridgePort,
    getLanShareEnabled: () => cfg.lanShareEnabled,
    getLanPasswordHash: () => cfg.lanPasswordHash,
    getLocalDshTarget,
    getAllowedOrigins: getLocalDshAllowedOrigins,
    getStatus: () => statusTracker.getSnapshot(),
    getDeviceId: () => cfg.localDeviceId,
  });

  const discovery = createLanDiscovery({
    instanceId: cfg.instanceId,
    udpPort: cfg.udpPort,
    getBridgeState: () => ({ enabled: cfg.lanShareEnabled, port: lanBridge.getPort() }),
    getStatus: () => statusTracker.getSnapshot(),
    getDeviceId: () => cfg.localDeviceId,
    onPeer: (peer) => {
      const applied = applyDiscoveredLanPeer(peer);
      if (applied && !applied.unchanged) cfg = loadConfig();
    },
  });

  async function buildStateSnapshot() {
    const remotesView = await remotePool.syncRemotes(cfg.remotes);
    const { origin: localUrl } = getLocalDshTarget();
    const { hostname, ips } = getLocalHostInfo();
    const statusSnapshot = statusTracker.getSnapshot();
    const { status, runningCount } = statusSnapshot;
    return {
      ok: true,
      self: {
        instanceId: cfg.instanceId,
        // 本机只认用户显式保存的设备归属，不用 hostname / IP 猜测。
        deviceId: cfg.localDeviceId,
        hostname,
        ips,
        localUrl,
        platformOs,
        lanShareEnabled: cfg.lanShareEnabled,
        // 只告诉前端是否已设置密码，哈希本身不出本机后端。
        lanPasswordSet: Boolean(cfg.lanPasswordHash),
        features: cfg.features,
        bridgePort: lanBridge.getPort(),
        status,
        runningCount,
        // status / runningCount / sessionStates 保持旧四值语义（waiting 折叠为 busy），旧版本设备只认这些；
        // 新版设备读取下面带 V2 的扩展字段，得到与本机一致的五值灯色。
        statusV2: statusSnapshot.statusV2,
        waitingCount: statusSnapshot.waitingCount,
        stateVersion: statusSnapshot.stateVersion,
        sessionStatesV2: statusSnapshot.sessionsV2,
        // 新字段只追加日志/已读水位；旧设备继续读取 V2 灯色字符串。
        sessionStateDetails: statusSnapshot.sessionsDetails,
        sessionStateVersion: 1,
        // 仅会话 ID 到状态映射；供受信任的同设备插件同步蓝灯，不含对话内容。
        sessionStates: statusSnapshot.sessions,
      },
      lanPeers: discovery.listPeers(),
      // 设备与路径均来自云清单 manifest.cloud.json；发现结果只作为本机运行态。
      devices: getSharedDevices(),
      remotes: remotesView,
      menuFavorites: resolveMenuFavorites(hostname),
      machineServiceProfiles: getMachineServiceProfiles(cfg),
      cloudServiceIds: getSharedCloudServiceIds(),
      dshPlugins: getSharedDshPlugins(),
       localDshPlugins: getLocalDshPluginInventory(),
      machineDshPluginProfiles: getMachineDshPluginProfiles(),
      currentMachineDshPluginIds: getMachineDshPluginIds(hostname),
      currentMachineProfile: getMachineServiceProfile(cfg, hostname),
      privateExtensions: listPrivateExtensionsForClient(),
      // 本机绑定：当前用哪一份云备份、一共几份，换机时靠它挑文件。
      localBinding: localBindingSnapshot(hostname),
      // 本机是否处于锁屏状态。Electron 主进程走 powerMonitor，当前宿主走 Windows 会话标志。
      systemLocked: globalThis.__dshAuSystemLocked === true,
    };
  }

  ctx.inject(['webServer'], (hostCtx) => {
    const server = hostCtx.webServer;
    if (Number.isInteger(server?.port) && server.port > 0) {
      observedLocalPort = server.port;
      // DSH NEXT 每次启动端口都会变：监控用宿主真实端口，不用 JSON 里登记的旧端口。
      setRuntimeServicePort('dsh_next', server.port);
    }

    void lanBridge.start().then((port) => {
      // 启动标记：把 DSH 重启与断线时间线对齐。
      logNet('bridge.start', { port, localDshPort: observedLocalPort, lanShareEnabled: cfg.lanShareEnabled, deviceId: cfg.localDeviceId || '' });
      discovery.start();
    });
    syncScreenLockConnections(globalThis.__dshAuSystemLocked === true);
    if (!remotePool.isConnectionsSuspended()) void remotePool.probeAll(cfg.remotes);
    // 状态追踪随宿主就绪启动：先回放日志恢复未确认状态，再订阅实时事件；重复触发时 start() 自身幂等。
    void statusTracker.start().catch(() => {});

    const localHost = getLocalHostInfo().hostname;
     const localProfile = getMachineServiceProfile(cfg, localHost);
     // 插件重载时也幂等补写开机启动项，修复旧版本留下的空 macOS plist。
     void syncBootStartupEntry(localHost, localProfile, platformOs);

    // 启动时后台静默预热一次服务状态缓存（1 小时有效），保证首次打开工作台弹窗也能秒出真实状态。
    void bgServices.listServices(false);

     // 随 DSH 启动自动拉起当前电脑配置的后台服务（异步非阻塞；关闭 DSH 时绝不关闭这些服务）
    if (process.env.DSH_AU_DISABLE_AUTO_START !== '1') {
      const localHost = getLocalHostInfo().hostname;
     const localProfile = getMachineServiceProfile(cfg, localHost);
      void bgServices.triggerDshAutoStart(localProfile, localHost);
    }

    let maintenanceTick = 0;
    const maintenanceTimer = setInterval(() => {
      void remotePool.probeAll(cfg.remotes);
      maintenanceTick += 1;
      // 每 30 秒强制核对一次曾经健康的开机自启服务；manager 内部负责防并发和退避。
      if (maintenanceTick % 2 === 0 && process.env.DSH_AU_DISABLE_AUTO_START !== '1') {
        const latestProfile = getMachineServiceProfile(cfg, localHost);
        void bgServices.reconcileBootRecovery(latestProfile);
      }
    }, 15_000);
    maintenanceTimer.unref?.();

    // 防止热重载或双源并发时重复注册路由导致整个 fiber 抛错崩溃。
    if (typeof globalThis.__dshAuDisposeRoute === 'function') {
      try { globalThis.__dshAuDisposeRoute(); } catch {}
      globalThis.__dshAuDisposeRoute = null;
    }
    if (typeof globalThis.__dshAuDisposeConnectRoute === 'function') {
      try { globalThis.__dshAuDisposeConnectRoute(); } catch {}
      globalThis.__dshAuDisposeConnectRoute = null;
    }

    let disposeRoute = null;
    let disposeConnectRoute = null;
    try {
      // 外网设备切换为一次同源 POST → 303 直达目标。密码只停留在服务端 Location 响应，永不下发给前端脚本。
      disposeConnectRoute = server.register({
        kind: 'exact',
        path: '/dsh-au/connect',
        handler: async (req, res) => {
          const rejection = getConnectionRejection(hostCtx, req) ?? getConnectionRejection(ctx, req);
          if (rejection !== undefined) {
            res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
            res.end(rejection === 401 ? 'Unauthorized' : 'Forbidden');
            return;
          }
          if (req.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
            res.end('Method Not Allowed');
            return;
          }
          const body = await readFormBody(req);
          const remoteId = typeof body.routeId === 'string' ? body.routeId : '';
          const remote = cfg.remotes.find((item) => item.id === remoteId);
          if (!remote) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
            res.end('Unknown DSH-AU remote route');
            return;
          }
          try {
            res.writeHead(303, { location: buildAuthenticatedRemoteUrl(remote), 'cache-control': 'no-store' });
            res.end();
          } catch {
            res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
            res.end('Invalid DSH-AU remote route');
          }
        },
      });
      globalThis.__dshAuDisposeConnectRoute = disposeConnectRoute;

      disposeRoute = server.register({
        kind: 'exact',
        path: '/dsh-au/api',
        handler: async (req, res) => {
        const rejection = getConnectionRejection(hostCtx, req) ?? getConnectionRejection(ctx, req);
        if (rejection !== undefined) {
          sendJson(res, rejection, { ok: false, error: rejection === 401 ? 'Unauthorized' : 'Forbidden' });
          return;
        }
        const sockPort = req.socket?.localPort;
        if (Number.isInteger(sockPort) && sockPort > 0) observedLocalPort = sockPort;

        if (req.method === 'GET') {
          sendJson(res, 200, await buildStateSnapshot());
          return;
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
          return;
        }
        const body = await readJsonBody(req);
        const action = body.action || 'getState';

        if (action === 'restartDsh') {
          // 客户端 callApi 走 POST；放在 action 声明之后，避免 GET 状态读取触发暂时性死区崩溃。
          if (typeof process.send === 'function') {
            try {
              process.send({ type: 'desktop-action', action: 'restart' });
              sendJson(res, 200, { ok: true, message: '已请求重启 DSH' });
            } catch (err) {
              sendJson(res, 500, { ok: false, error: '发送重启指令失败: ' + err.message });
            }
          } else {
            sendJson(res, 200, { ok: false, error: '当前环境不支持直接重启' });
          }
          return;
        }

        if (action === 'getInitialSessionFocus') {
          // 只返回首次进入的目标 ID；不导航、不确认，也不发送任何会话消息。
          const result = await createInitialSessionFocusResolver({ ctx, statusTracker, remotePool, getConfig: () => cfg })(body);
          sendJson(res, result.ok ? 200 : 502, result);
          return;
        }

        if (action === 'preloadSession') {
          // 只回传与记录脱敏标量状态；会话内容、请求体和原生错误永不进入响应或日志。
          const startedAt = Date.now();
          const result = await sessionPreloadCache.preload(body);
          logNet('session.preload', {
            sessionId: typeof result?.sessionId === 'string' ? result.sessionId.slice(0, 128) : '',
            clientId: typeof body?.clientId === 'string' ? body.clientId.slice(0, 128) : '',
            requestId: typeof body?.requestId === 'string' ? body.requestId.slice(0, 128) : '',
            result: typeof result?.result === 'string' ? result.result.slice(0, 64) : '',
            cursor: Number.isFinite(result?.cursor) ? result.cursor : null,
            elapsedMs: Math.max(0, Date.now() - startedAt),
          });
          sendJson(res, 200, { ok: true, ...result });
          return;
        }

        if (action === 'releaseSessionPreloads') {
          sessionPreloadCache.release(body);
          sendJson(res, 200, { ok: true });
          return;
        }

        if (action === 'cancelSessionPreload') {
          sessionPreloadCache.cancel(body);
          sendJson(res, 200, { ok: true });
          return;
        }

        if (action === 'reportClientEvent') {
          // 写入统一导出日志，同时保留桌面 stdout 兼容；输入字段由同一白名单收敛。
          const { event, data } = recordClientEvent(body);
          console.info(`[dsh-au] client.${event}`, JSON.stringify(data));
          sendJson(res, 200, { ok: true });
          return;
        }

        if (action === 'reportRouteChange') {
          // preference-change 与实际加载回退用 reason 区分；只收白名单 ID/状态。
          recordRouteChange(body);
          sendJson(res, 200, { ok: true });
          return;
        }

        if (action === 'getNetLog') {
          // 导出最近的网络诊断日志，供断线后直接下载分析。
          sendJson(res, 200, { ok: true, path: resolveNetLogPath(), lines: readNetLog(Number(body.limit) || 2000) });
          return;
        }

        if (action === 'getWindowState') {
          sendJson(res, 200, { ok: true, windowState: cfg.windowState });
          return;
        }

        if (action === 'saveWindowState') {
          // 开关与几何分开写入：采样只带 geometry，切换开关只带 enabled，互不覆盖。
          const next = { ...cfg.windowState };
          if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
          if ('geometry' in body) next.geometry = normalizeWindowGeometry(body.geometry);
          cfg.windowState = normalizeWindowState(next);
          saveConfig(cfg);
          sendJson(res, 200, { ok: true, windowState: cfg.windowState });
          return;
        }

        if (action === 'resolveWindowRestore') {
          // 还原决策留在 Host：显示器是否仍在、尺寸如何收敛都在服务端算，前端只负责应用。
          const target = resolveRestoreTarget(cfg.windowState.geometry, body.display);
          sendJson(res, 200, { ok: true, target });
          return;
        }

        if (action === 'maximizeWindow') {
          if (process.platform === 'win32') {
            try {
              const success = maximizeWindowsAppWindow();
              sendJson(res, 200, { ok: true, success });
            } catch (err) {
              sendJson(res, 500, { ok: false, error: err.message });
            }
          } else {
            sendJson(res, 200, { ok: true, skipped: true });
          }
          return;
        }

        if (action === 'getFeatures') {
          cfg = loadConfig();
          const policyError = cfg.features.blockGoalCreation ? goalCreationPolicy.getError() : null;
          sendJson(res, 200, {
            ok: true,
            goalCreationError: policyError || '',
            features: cfg.features,
            autoContinue: cfg.autoContinue,
            ...(cfg.clientPreferences ? { clientPreferences: cfg.clientPreferences } : {}),
          });
          return;
        }

        if (action === 'saveFeatures') {
          // 只接受布尔值，未带的字段保持原值；同时支持保存浏览器端的移动端抽屉与快捷键偏好供 dsh-au 跨机同步。
          const next = { ...cfg.features };
          if (typeof body.todo === 'boolean') next.todo = body.todo;
          if (typeof body.remoteManagement === 'boolean') next.remoteManagement = body.remoteManagement;
          if (typeof body.fullAccessByDefault === 'boolean') next.fullAccessByDefault = body.fullAccessByDefault;
          if (typeof body.blockGoalCreation === 'boolean') next.blockGoalCreation = body.blockGoalCreation;
          if (typeof body.disconnectRemotesOnLock === 'boolean') next.disconnectRemotesOnLock = body.disconnectRemotesOnLock;
          const features = normalizeFeatures(next);
          const policyError = features.blockGoalCreation ? goalCreationPolicy.getError() : null;
          if (body.blockGoalCreation === true && policyError) {
            sendJson(res, 501, { ok: false, error: policyError, features: cfg.features });
            return;
          }
          cfg.features = features;
          if (body.autoContinue && typeof body.autoContinue === 'object') {
            cfg.autoContinue = normalizeAutoContinue({ ...(cfg.autoContinue || {}), ...body.autoContinue });
          }
          if (body.clientPreferences && typeof body.clientPreferences === 'object') {
            cfg.clientPreferences = {
              ...(cfg.clientPreferences && typeof cfg.clientPreferences === 'object' ? cfg.clientPreferences : {}),
              ...(typeof body.clientPreferences.mobileEnabled === 'boolean'
                ? { mobileEnabled: body.clientPreferences.mobileEnabled }
                : {}),
              ...(body.clientPreferences.shortcutOverrides && typeof body.clientPreferences.shortcutOverrides === 'object'
                ? { shortcutOverrides: body.clientPreferences.shortcutOverrides }
                : {}),
            };
          }
          saveConfig(cfg);
          void syncHostDefaultPreset(cfg.features.fullAccessByDefault);
          // 正在锁屏时改开关要立刻断开或恢复，不用等下一次锁屏。
          syncScreenLockConnections(globalThis.__dshAuSystemLocked === true);
          sendJson(res, 200, {
            ok: true,
            goalCreationError: policyError || '',
            features: cfg.features,
            autoContinue: cfg.autoContinue,
            ...(cfg.clientPreferences ? { clientPreferences: cfg.clientPreferences } : {}),
          });
          return;
        }

        const buildCloudSyncViewPayload = (targetProfile) => {
          const repoRoot = getRepoRoot();
          return {
            items: buildOfficialSyncItems({ repoRoot, profile: targetProfile }),
            itemsByProfile: buildOfficialSyncItemsByProfile({ repoRoot }),
            pluginItems: buildCloudPluginSyncItems({ repoRoot }),
            preferenceItems: buildPreferenceSyncItems(),
          };
        };

        if (action === 'getCloudSyncSettings') {
          cfg = loadConfig();
          const cloudSync = normalizeCloudSyncConfig(cfg.cloudSync);
          const currentHash = computeOfficialSettingsHash(getRepoRoot(), cloudSync.profile);
          const bindings = loadLocalBindings();
          sendJson(res, 200, {
            ok: true,
            cloudSync: {
              ...cloudSync,
              currentHash,
              inSync: Boolean(cloudSync.lastSyncedHash && cloudSync.lastSyncedHash === currentHash),
              restartRequired: Boolean(globalThis.__dshAuCloudSyncRestartRequired),
              // 新电脑：已有私有仓库但从没同步过，前端据此弹「首次从云端拉取」确认。
              firstSyncPending: Boolean(hasSyncRepo() && !cloudSync.lastSyncedHash),
            },
            syncRepoRoot: typeof cfg.syncRepoRoot === 'string' ? cfg.syncRepoRoot : '',
            ...buildCloudSyncViewPayload(cloudSync.profile),
            machineId: bindings.machineId,
          });
          return;
        }

        if (action === 'saveCloudSyncSettings') {
          cfg = loadConfig();
          const prev = normalizeCloudSyncConfig(cfg.cloudSync);
          const hasItems = Array.isArray(body.selectedItems);
          const hasPlugins = Array.isArray(body.selectedPlugins);
          const hasPluginConfigs = Array.isArray(body.syncPluginConfigs);
          const hasPreferences = Array.isArray(body.selectedPreferences);
          const next = normalizeCloudSyncConfig({
            ...prev,
            ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
            ...(typeof body.profile === 'string' ? { profile: body.profile } : {}),
            ...(hasItems ? { selectedItems: body.selectedItems, customized: true } : {}),
            ...(hasPlugins ? { selectedPlugins: body.selectedPlugins, pluginsCustomized: true } : {}),
            ...(hasPluginConfigs ? { syncPluginConfigs: body.syncPluginConfigs, pluginsCustomized: true } : {}),
            ...(hasPreferences ? { selectedPreferences: body.selectedPreferences } : {}),
          });
          cfg.cloudSync = next;
          if (typeof body.syncRepoRoot === 'string') {
            const trimmed = body.syncRepoRoot.trim();
            if (trimmed) cfg.syncRepoRoot = trimmed;
            else delete cfg.syncRepoRoot;
          }
          saveConfig(cfg);
          const currentHash = computeOfficialSettingsHash(getRepoRoot(), next.profile);
          sendJson(res, 200, {
            ok: true,
            cloudSync: {
              ...next,
              currentHash,
              inSync: Boolean(next.lastSyncedHash && next.lastSyncedHash === currentHash),
              restartRequired: Boolean(globalThis.__dshAuCloudSyncRestartRequired),
              firstSyncPending: Boolean(hasSyncRepo() && !next.lastSyncedHash),
            },
            syncRepoRoot: typeof cfg.syncRepoRoot === 'string' ? cfg.syncRepoRoot : '',
            ...buildCloudSyncViewPayload(next.profile),
          });
          return;
        }

        if (action === 'runCloudSyncNow') {
          cfg = loadConfig();
          const prev = normalizeCloudSyncConfig(cfg.cloudSync);
          const singlePluginId = body.singlePluginOnly && typeof body.pluginId === 'string' ? body.pluginId.trim() : '';
          const next = singlePluginId
            ? prev
            : normalizeCloudSyncConfig({
                ...prev,
                ...(typeof body.profile === 'string' ? { profile: body.profile } : {}),
                ...(Array.isArray(body.selectedItems) ? { selectedItems: body.selectedItems, customized: true } : {}),
                ...(Array.isArray(body.selectedPlugins) ? { selectedPlugins: body.selectedPlugins, pluginsCustomized: true } : {}),
                ...(Array.isArray(body.syncPluginConfigs) ? { syncPluginConfigs: body.syncPluginConfigs, pluginsCustomized: true } : {}),
                ...(Array.isArray(body.selectedPreferences) ? { selectedPreferences: body.selectedPreferences } : {}),
              });
          const result = runRestoreScriptForCloudSync({
            repoRoot: getRepoRoot(),
            profile: typeof body.profile === 'string' ? body.profile : next.profile,
            selectedItems: singlePluginId ? [] : next.selectedItems,
            selectedPlugins: singlePluginId ? [singlePluginId] : next.selectedPlugins,
            syncPluginConfigs: singlePluginId ? [singlePluginId] : next.syncPluginConfigs,
            preferences: singlePluginId ? [] : next.selectedPreferences,
            autoSync: false,
          });
          if (!result.ok) {
            sendJson(res, 500, { ok: false, error: result.error || '执行 #71 同步失败' });
            return;
          }
          cfg = loadConfig();
          const validPluginIds = new Set(getAllCloudPluginIds());
          cfg.cloudSync = normalizeCloudSyncConfig({
            ...next,
            selectedPlugins: (next.selectedPlugins || []).filter((id) => validPluginIds.has(id)),
            syncPluginConfigs: (next.syncPluginConfigs || []).filter((id) => validPluginIds.has(id)),
            lastSyncedHash: result.hash,
            lastSyncedAt: result.syncedAt || new Date().toISOString(),
          });
          saveConfig(cfg);
          globalThis.__dshAuCloudSyncRestartRequired = Boolean(result.restartRequired);
          sendJson(res, 200, {
            ok: true,
            message: result.skipped ? result.reason : '已复用 #71 脚本同步所选官方设置与云插件，重启 DSH 后生效',
            restartRequired: Boolean(result.restartRequired),
            cloudSync: {
              ...cfg.cloudSync,
              currentHash: result.hash,
              inSync: true,
              restartRequired: Boolean(result.restartRequired),
            },
            ...buildCloudSyncViewPayload(cfg.cloudSync.profile),
          });
          return;
        }

        if (action === 'pushCloudSyncToRepo') {
          cfg = loadConfig();
          const prev = normalizeCloudSyncConfig(cfg.cloudSync);
          const singlePluginId = body.singlePluginOnly && typeof body.pluginId === 'string' ? body.pluginId.trim() : '';
          const next = singlePluginId
            ? prev
            : normalizeCloudSyncConfig({
                ...prev,
                ...(typeof body.profile === 'string' ? { profile: body.profile } : {}),
                ...(Array.isArray(body.selectedItems) ? { selectedItems: body.selectedItems, customized: true } : {}),
                ...(Array.isArray(body.selectedPlugins) ? { selectedPlugins: body.selectedPlugins, pluginsCustomized: true } : {}),
                ...(Array.isArray(body.syncPluginConfigs) ? { syncPluginConfigs: body.syncPluginConfigs, pluginsCustomized: true } : {}),
                ...(Array.isArray(body.selectedPreferences) ? { selectedPreferences: body.selectedPreferences } : {}),
              });
          try {
            const pushed = pushLocalOfficialSettingsToRepo({
              repoRoot: getRepoRoot(),
              profile: typeof body.profile === 'string' ? body.profile : next.profile,
              selectedItems: singlePluginId ? [] : next.selectedItems,
              selectedPlugins: singlePluginId ? [singlePluginId] : next.selectedPlugins,
              syncPluginConfigs: singlePluginId ? [singlePluginId] : next.syncPluginConfigs,
              clientPreferences: body.clientPreferences || null,
              selectedPreferences: singlePluginId ? [] : next.selectedPreferences,
            });
            const removedPlugins = Array.isArray(pushed.removedPlugins) ? pushed.removedPlugins : [];
            const removedIdSet = new Set(removedPlugins.map((item) => item.id));
            const cleanedNext = removedIdSet.size > 0
              ? {
                  ...next,
                  selectedPlugins: (next.selectedPlugins || []).filter((id) => !removedIdSet.has(id)),
                  syncPluginConfigs: (next.syncPluginConfigs || []).filter((id) => !removedIdSet.has(id)),
                }
              : next;
            cfg.cloudSync = normalizeCloudSyncConfig({
              ...cleanedNext,
              lastSyncedHash: pushed.hash,
              lastSyncedAt: new Date().toISOString(),
            });
            saveConfig(cfg);
            const removedNames = removedPlugins.map((item) => item.id || item.package).filter(Boolean);
            const message = removedNames.length > 0
              ? `已将本机设置推送到云；并从云清单移除已卸载插件: ${removedNames.join('、')}`
              : '已将本机勾选的官方设置与插件启用状态/配置回写到云端仓库快照';
            sendJson(res, 200, {
              ok: true,
              message,
              pushed,
              removedPlugins,
              cloudSync: {
                ...cfg.cloudSync,
                currentHash: pushed.hash,
                inSync: true,
                restartRequired: Boolean(globalThis.__dshAuCloudSyncRestartRequired),
              },
              ...buildCloudSyncViewPayload(cfg.cloudSync.profile),
            });
          } catch (err) {
            sendJson(res, 500, { ok: false, error: '回写仓库快照失败: ' + err.message });
          }
          return;
        }

        if (action === 'getModelShortcuts') {
          try {
            const result = readModelShortcuts();
            sendJson(res, 200, {
              ok: true,
              schemaVersion: 1,
              modelShortcuts: result.modelShortcuts,
            });
          } catch (err) {
            sendJson(res, 500, { ok: false, error: `读取模型快捷切换配置失败: ${err.message}` });
          }
          return;
        }

        if (action === 'saveModelShortcuts') {
          // 客户端直接提交 enabled/binding/slots；action 等其它请求字段不进入持久化层。
          const allowedRequestFields = new Set(['action', 'enabled', 'binding', 'slots']);
          if (Object.keys(body).some((key) => !allowedRequestFields.has(key))) {
            sendJson(res, 400, { ok: false, error: '保存模型快捷切换配置失败: 请求含有不支持的字段' });
            return;
          }
          const patch = {};
          for (const key of ['enabled', 'binding', 'slots']) {
            if (Object.hasOwn(body, key)) patch[key] = body[key];
          }
          try {
            const result = saveModelShortcuts(patch);
            sendJson(res, 200, {
              ok: true,
              schemaVersion: 1,
              modelShortcuts: result.modelShortcuts,
            });
          } catch (err) {
            const status = Number.isInteger(err?.status) ? err.status : 500;
            sendJson(res, status, { ok: false, error: `保存模型快捷切换配置失败: ${err.message}` });
          }
          return;
        }

        if (action === 'getRemoteModelCatalog') {
          const result = await remoteModelShortcuts.getRemoteModelCatalog({
            deviceId: body.deviceId,
            routeId: body.routeId,
          });
          sendRemoteModelResult(res, result);
          return;
        }

        if (action === 'selectRemoteModel') {
          const result = await remoteModelShortcuts.selectRemoteModel({
            deviceId: body.deviceId,
            routeId: body.routeId,
            sessionId: body.sessionId,
            selection: body.selection,
          });
          sendRemoteModelResult(res, result);
          return;
        }

        if (action === 'setLanPassword') {
          // 设置/修改局域网接入密码：已设置过时必须先验证旧密码。
          const next = typeof body.password === 'string' ? body.password : '';
          if (cfg.lanPasswordHash && !verifyLanPassword(String(body.currentPassword || ''), cfg.lanPasswordHash)) {
            sendJson(res, 400, { ok: false, error: '当前密码不正确' });
            return;
          }
          if (next.length < LAN_PASSWORD_MIN_LENGTH) {
            sendJson(res, 400, { ok: false, error: `新密码至少 ${LAN_PASSWORD_MIN_LENGTH} 位` });
            return;
          }
          cfg.lanPasswordHash = hashLanPassword(next);
          saveConfig(cfg);
          sendJson(res, 200, await buildStateSnapshot());
          return;
        }
        if (action === 'setLanShare') {
          // 没有密码不允许开启局域网接入，避免回到免密状态。
          if (body.enabled && !cfg.lanPasswordHash) {
            sendJson(res, 400, { ok: false, error: '请先设置局域网接入密码，再开启局域网接入' });
            return;
          }
          cfg.lanShareEnabled = Boolean(body.enabled);
          saveConfig(cfg);
          if (cfg.lanShareEnabled) discovery.broadcastNow();
          sendJson(res, 200, await buildStateSnapshot());
          return;
        }
        if (action === 'saveDevice') {
          try {
            updateSharedDevice({ id: body.id, name: body.name });
            cfg = loadConfig();
            sendJson(res, 200, await buildStateSnapshot());
          } catch (err) {
            sendJson(res, 400, { ok: false, error: `设备保存失败: ${err.message}` });
          }
          return;
        }
        if (action === 'deleteDevice') {
          try {
            const deleted = deleteSharedDevice(body.deviceId);
            if (cfg.localDeviceId === body.deviceId) {
              cfg.localDeviceId = '';
              saveConfig(cfg);
            }
            cfg = loadConfig();
            sendJson(res, deleted ? 200 : 404, deleted ? await buildStateSnapshot() : { ok: false, error: '设备不存在' });
          } catch (err) {
            sendJson(res, 500, { ok: false, error: `设备删除失败: ${err.message}` });
          }
          return;
        }
        if (action === 'setLocalDevice') {
          const deviceId = typeof body.deviceId === 'string' ? body.deviceId : '';
          if (!getSharedDevices().some((device) => device.id === deviceId)) {
            sendJson(res, 400, { ok: false, error: '本机归属设备不存在' });
            return;
          }
          // 本机归属只写本地配置；局域网地址是公共路径，绑定后立刻公布供对端探测。
          cfg.localDeviceId = deviceId;
          saveConfig(cfg);
          publishLocalLanShare(deviceId, getLocalHostInfo().ips, lanBridge.getPort());
          cfg = loadConfig();
          sendJson(res, 200, await buildStateSnapshot());
          return;
        }
        if (action === 'saveRoute' || action === 'saveRemote') {
          const existing = cfg.remotes.find((route) => route.id === body.id);
          const deviceId = typeof body.deviceId === 'string' && body.deviceId
            ? body.deviceId
            : existing?.deviceId;
          const type = body.type || body.transport || existing?.transport;
          if (!deviceId) {
            sendJson(res, 400, { ok: false, error: '请选择路径所属设备' });
            return;
          }
          let saved;
          try {
            saved = updateSharedDeviceRoute(deviceId, {
              id: body.id || existing?.id,
              type,
              url: body.url,
              username: body.username ?? existing?.username ?? '',
            });
          } catch (err) {
            sendJson(res, 400, { ok: false, error: `路径保存失败: ${err.message}` });
            return;
          }
          cfg = loadConfig();
          const merged = cfg.remotes.find((route) => route.id === saved.route.id);
          if (merged) {
            const password = body.password !== undefined && body.password !== ''
              ? body.password
              : (body.clearPassword ? '' : (existing?.password ?? merged.password));
            const requestedProxy = body.proxyUrl !== undefined
              ? (typeof body.proxyUrl === 'string' ? body.proxyUrl.trim() : '')
              : (existing?.proxyUrl || merged.proxyUrl || '');
            const normalizedLocal = normalizeRemote({ ...merged, proxyUrl: requestedProxy });
            if (requestedProxy && !normalizedLocal?.proxyUrl) {
              sendJson(res, 400, { ok: false, error: 'Clash 代理地址无效：请输入 http://host:port 的 HTTP/mixed-port 地址' });
              return;
            }
            const localIndex = cfg.remotes.findIndex((route) => route.id === merged.id);
            const localRoute = { ...merged, password };
            if (normalizedLocal?.proxyUrl) localRoute.proxyUrl = normalizedLocal.proxyUrl;
            else delete localRoute.proxyUrl;
            cfg.remotes[localIndex] = localRoute;
            saveConfig(cfg);
            cfg = loadConfig();
            await remotePool.probeAll([cfg.remotes.find((route) => route.id === merged.id)]);
          }
          sendJson(res, 200, await buildStateSnapshot());
          return;
        }
        if (action === 'deleteRoute' || action === 'deleteRemote') {
          const existing = cfg.remotes.find((route) => route.id === body.id);
          const deviceId = body.deviceId || existing?.deviceId;
          try {
            const deleted = deviceId && deleteSharedDeviceRoute(deviceId, body.id);
            if (!deleted) {
              sendJson(res, 404, { ok: false, error: '路径不存在' });
              return;
            }
          } catch (err) {
            sendJson(res, 500, { ok: false, error: `路径删除失败: ${err.message}` });
            return;
          }
          cfg.remotes = cfg.remotes.filter((route) => route.id !== body.id);
          saveConfig(cfg);
          cfg = loadConfig();
          sendJson(res, 200, await buildStateSnapshot());
          return;
        }
        if (action === 'confirmSession') {
          // 统一会话蓝/红灯确认入口：支持本机直接确认与远端设备确认，确认后立即刷新状态快照供顶栏消灯。
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
          const deviceId = typeof body.deviceId === 'string' ? body.deviceId : '';
          const localDeviceId = runtimeBridge.getLocalDevice().deviceId;
          if (!sessionId) {
            sendJson(res, 400, { ok: false, error: '缺少 sessionId' });
            return;
          }
          let confirmed = false;
          let confirmationState;
          if (!deviceId || deviceId === 'local' || deviceId === cfg.localDeviceId || deviceId === localDeviceId) {
            confirmed = statusTracker.confirm(sessionId, body.expectedEndSeq);
            confirmationState = statusTracker.getSessionState(sessionId);
          } else {
            const result = await runtimeBridge.requestDevice(deviceId, '/dsh-au-todo/api', {
              action: 'confirmSession',
              deviceId: 'local',
              sessionId,
              ...(body.expectedEndSeq !== undefined ? { expectedEndSeq: body.expectedEndSeq } : {}),
            });
            confirmed = result?.ok === true && result.confirmed !== false;
            confirmationState = result?.state;
            await runtimeBridge.refreshDevice(deviceId);
          }
          sendJson(res, 200, { ...await buildStateSnapshot(), ok: confirmed, confirmed,
            ...(confirmationState ? { state: confirmationState } : {}),
          });
          return;
        }
        if (action === 'probeRemote') {
          // 受控远端 iframe 内确认会话后通知宿主立即重探该设备，消除 15 秒轮询延迟。
          const deviceId = typeof body.deviceId === 'string' ? body.deviceId : '';
          if (deviceId) await runtimeBridge.refreshDevice(deviceId);
          sendJson(res, 200, await buildStateSnapshot());
          return;
        }
        if (action === 'discoverNow') {
          discovery.broadcastNow();
          await Promise.all([
            discovery.scanSubnet(lanBridge.getPort() || cfg.bridgePort),
            remotePool.probeAll(cfg.remotes),
          ]);
          for (const peer of discovery.listPeers()) applyDiscoveredLanPeer(peer);
          cfg = loadConfig();
          sendJson(res, 200, await buildStateSnapshot());
          return;
        }
        if (action === 'getMenuWorkbench') {
          const { hostname } = getLocalHostInfo();
          // 打开工作台属于纯只读操作：禁止自动将本机插件写入云端清单或改写仓库快照文件。
          const services = await bgServices.listServices(Boolean(body.force));
          sendJson(res, 200, {
            ok: true,
            selfHostname: hostname,
            platformOs,
            menuSpec: loadMenuSpec(platformOs),
            runner: menuRunner.getSnapshot(),
            services,
            serviceLogs: bgServices.getLogs(),
            serviceLogsById: bgServices.getLogsById(),
            menuFavorites: resolveMenuFavorites(hostname),
            machineServiceProfiles: getMachineServiceProfiles(cfg),
            privateExtensions: listPrivateExtensionsForClient(),
            currentMachineProfile: getMachineServiceProfile(cfg, hostname),
            cloudServiceIds: getSharedCloudServiceIds(),
            dshPlugins: getSharedDshPlugins(),
       localDshPlugins: getLocalDshPluginInventory(),
            machineDshPluginProfiles: getMachineDshPluginProfiles(),
            currentMachineDshPluginIds: getMachineDshPluginIds(hostname),
            localBinding: localBindingSnapshot(hostname),
            // 接入包：云包 + 本机包 + 内置项的同一份视图，前端只消费这一份。
          });
          return;
        }
        if (action === 'extAction') {
          const result = await invokePrivateExtensionAction(
            body.extId,
            body.subAction,
            body.payload && typeof body.payload === 'object' ? body.payload : {},
          );
          sendJson(res, result?.ok === false && result?.status ? result.status : 200, result);
          return;
        }
        /**
         * 切换当前使用的云备份：只改 local/active.json 指针，不动任何备份内容。
         * 切到别的电脑的备份只影响本机显示，不会去改那台电脑的任何开关。
         */
        if (action === 'switchLocalBinding') {
          const localHost = getLocalHostInfo().hostname;
          const switched = switchActiveBinding(body.machineId);
          if (!switched.ok) {
            sendJson(res, 400, { ok: false, error: `切换云备份失败: ${switched.reason}` });
            return;
          }
          bgServices.refreshRecoveryScope();
          await bgServices.waitForRecoveryMaintenanceIdle();
          const services = await bgServices.listServices(Boolean(body.force));
          sendJson(res, 200, {
            ok: true,
            machineId: switched.machineId,
            services,
            menuFavorites: resolveMenuFavorites(localHost),
            localBinding: localBindingSnapshot(localHost),
          });
          return;
        }
        if (action === 'saveMenuFavorites') {
          const localHost = getLocalHostInfo().hostname;
          if (Array.isArray(body.favorites)) {
            // 顺手刷新插件名单：收藏和插件同属「这台电脑的本机事实」，一次写盘完成。
            const saved = saveMenuFavorites(body.favorites, localHost, { plugins: getMachineDshPluginIds(localHost) });
            // 写本机绑定失败（例如目录只读）才回落到旧配置，保证这次点击不白点。
            if (!saved.ok) {
              cfg.menuFavorites = normalizeMenuFavorites(body.favorites);
              saveConfig(cfg);
            }
          }
          sendJson(res, 200, { ok: true, menuFavorites: resolveMenuFavorites(localHost) });
          return;
        }
        if (action === 'runMenuCommand') {
          const out = menuRunner.executeCommand(body.code, body.params || {});
          sendJson(res, 200, { ...out, runner: menuRunner.getSnapshot() });
          return;
        }
        if (action === 'sendMenuStdin') {
          const out = menuRunner.sendStdin(body.input);
          sendJson(res, 200, { ...out, runner: menuRunner.getSnapshot() });
          return;
        }
        if (action === 'openMenuInTerminal') {
          const out = menuRunner.openInTerminal(body.code, body.params || {});
          sendJson(res, 200, { ...out, runner: menuRunner.getSnapshot() });
          return;
        }
        if (action === 'clearMenuLogs') {
          menuRunner.clearLogs(body.code);
          sendJson(res, 200, { ok: true, runner: menuRunner.getSnapshot() });
          return;
        }
        if (action === 'controlBackgroundService' || (body.serviceId && ['start', 'stop', 'restart'].includes(action))) {
          const serviceAction = body.serviceAction || (['start', 'stop', 'restart'].includes(action) ? action : body.action);
          const out = await bgServices.controlService(body.serviceId, serviceAction, {
            pid: body.pid,
            device: body.device,
            // 只有真实 UI/API 操作才抑制看门狗；自启与恢复使用各自来源。
            source: 'user',
          });
          // 启动成功后把 state.json 的 enabled 置为 true；只对已登记在本机绑定 JSON 的服务生效，
          // 未登记的服务不会因为启动一次就被接入本机。
          if (out.ok && (serviceAction === 'start' || serviceAction === 'restart')) {
            const localHost = getLocalHostInfo().hostname;
            const current = getMachineServiceProfile(cfg, localHost);
            if (!current.enabled.includes(body.serviceId)) {
              const desired = { ...current, enabled: [...current.enabled, body.serviceId] };
              updateMachineServiceProfile(cfg, localHost, desired);
              cfg = loadConfig();
            }
          }
          mirrorLocalBindingState(getLocalHostInfo().hostname);
          const services = await bgServices.listServices(true);
          sendJson(res, 200, {
            ...out,
            services,
            currentMachineProfile: getMachineServiceProfile(cfg, getLocalHostInfo().hostname),
            serviceLogs: bgServices.getLogs(),
            serviceLogsById: bgServices.getLogsById(),
          });          return;
        }
        if (action === 'runServiceDoctor') {
          const serviceId = body.serviceId || '';
          // 生命周期探针会临时 stop；暂停该服务自愈，避免并发巡检把它抢先拉起。
          const releaseRecovery = serviceId ? bgServices.suspendRecovery(serviceId) : () => {};
          try {
            if (serviceId) await bgServices.waitForRecoveryIdle(serviceId);
            const report = await runLocalServicesDoctor({
              hostname: body.hostname || getLocalHostInfo().hostname,
              serviceId,
              probeLifecycle: Boolean(body.probeLifecycle),
            });
            sendJson(res, 200, report);
          } finally {
            releaseRecovery();
          }
          return;
        }
        if (action === 'toggleCloudServiceOnCurrentMachine') {
          const localHost = getLocalHostInfo().hostname;
          const serviceId = String(body.serviceId || '').trim();
          const cloudDefinition = readCloudManifest().manifest.services?.[serviceId];
          if (!cloudDefinition) {
            sendJson(res, 400, { ok: false, error: `云清单没有服务定义：${serviceId || '(未指定)'}` });
            return;
          }
          const currentBinding = loadLocalBindings(localHost);
          const currentProfile = getMachineServiceProfile(cfg, localHost);
          const connecting = !Object.hasOwn(currentBinding.services || {}, serviceId);
          // 接入时先按端口只读识别这台电脑实际运行的文件；失败就保留云定义，绝不猜路径。
          const detectedPath = connecting ? await detectLocalServicePathByPort(cloudDefinition.port) : '';
          const localDefinition = cloudDefinitionToLocalBinding({
            ...cloudDefinition,
            ...(detectedPath ? { scriptPath: detectedPath } : {}),
          });
          // 再换算成本机事实：路径展开到本机，macOS 专属的 launcher 只在 macOS 保留。
          const changed = setLocalBindingService(
            serviceId,
            connecting ? localDefinition : null,
            localHost,
          );
          if (!changed.ok) {
            sendJson(res, 400, { ok: false, error: `本机接入保存失败: ${changed.reason}` });
            return;
          }
          const profile = updateMachineServiceProfile(cfg, localHost, {
            ...currentProfile,
            enabled: connecting
              ? [...currentProfile.enabled, serviceId]
              : currentProfile.enabled.filter((id) => id !== serviceId),
          });
          // 补上 cloud 标记：这条服务来自云清单。
          mirrorLocalBindingState(localHost);
          const services = await bgServices.listServices(true);
          sendJson(res, 200, {
            ok: true,
            serviceId,
            connected: connecting,
            services,
            currentMachineProfile: profile,
            machineServiceProfiles: getMachineServiceProfiles(cfg),
            cloudServiceIds: getSharedCloudServiceIds(),
            localBinding: localBindingSnapshot(localHost),
          });
          return;
        }
        if (action === 'saveMachineServiceProfile') {
          const localHost = getLocalHostInfo().hostname;
          const targetHost = (body.hostname || localHost || 'default').trim();
          const current = getMachineServiceProfile(cfg, targetHost);
          const desired = {
            enabled: body.profile?.enabled !== undefined ? body.profile.enabled : current.enabled,
            autoStartOnBoot: body.profile?.autoStartOnBoot !== undefined ? body.profile.autoStartOnBoot : current.autoStartOnBoot,
            autoStartOnDsh: body.profile?.autoStartOnDsh !== undefined ? body.profile.autoStartOnDsh : current.autoStartOnDsh,
          };
          const singleFlag = Object.hasOwn(body, 'serviceId');
          const updated = singleFlag
            ? updateMachineServiceFlag(cfg, targetHost, body.serviceId, body.field, body.value)
            : updateMachineServiceProfile(cfg, targetHost, desired);
          cfg = loadConfig();
          // 单项开关等待启动项同步，并分别返回“已保存”和“已应用”；旧整表接口保留后台同步。
          // macOS cloudflared 同样等待结果，缺管理员权限必须当场提示。
          let bootSync = null;
          if (targetHost.toLocaleLowerCase() === localHost.toLocaleLowerCase()) {
            if (singleFlag || (platformOs === 'darwin' && updated.enabled.includes('cloudflared'))) {
              // 开关保存与启动项落地分开回报：不能把同步失败藏在后台，仍向用户宣称已生效。
              bootSync = await syncBootStartupEntry(targetHost, updated, platformOs);
            } else {
              setTimeout(() => {
                Promise.resolve(syncBootStartupEntry(targetHost, updated, platformOs)).catch(() => {});
              }, 0);
            }
          }
          mirrorLocalBindingState(targetHost);
          sendJson(res, 200, {
            ok: true,
            hostname: targetHost,
            profile: updated,
            bootSync,
            cloudServiceIds: getSharedCloudServiceIds(),
            localStateLists: localStateLists(targetHost),
            machineServiceProfiles: getMachineServiceProfiles(cfg),
            currentMachineProfile: getMachineServiceProfile(cfg, localHost),
          });
          return;
        }
        if (action === 'removeCloudService') {
          // 只删云清单登记：本机注册、服务目录和正在运行的进程都不动。
          const localHost = getLocalHostInfo().hostname || 'default';
          try {
            // 云清单里删掉服务定义即取消「已上云」，本机接入与进程不动。
            const removed = removeCloudService(body.serviceId);
            const updated = updateMachineServiceProfile(cfg, localHost, getMachineServiceProfile(cfg, localHost));
            cfg = loadConfig();
            // 删登记同样只改云清单：启动项同步放后台，别让按钮等它。
            setTimeout(() => {
              Promise.resolve(syncBootStartupEntry(localHost, updated, platformOs)).catch(() => {});
            }, 0);
            mirrorLocalBindingState(localHost);
            sendJson(res, 200, {
              ok: true,
              serviceId: removed.serviceId,
              hostname: localHost,
              profile: updated,
              cloudServiceIds: getSharedCloudServiceIds(),
              cloudManifestPath: removed.filePath,
              localStateLists: localStateLists(localHost),
              machineServiceProfiles: getMachineServiceProfiles(cfg),
              currentMachineProfile: getMachineServiceProfile(cfg, localHost),
            });
          } catch (err) {
            sendJson(res, 400, { ok: false, error: `删除云服务失败: ${err.message}` });
          }
          return;
        }
        if (action === 'promoteLocalServiceToCloud') {
          const localHost = getLocalHostInfo().hostname || 'default';
          try {
            const promoted = promoteLocalServiceToCloud(body.serviceId, localHost);
            const updated = updateMachineServiceProfile(cfg, localHost, promoted.profile);
            cfg = loadConfig();
            setTimeout(() => {
              Promise.resolve(syncBootStartupEntry(localHost, updated, platformOs)).catch(() => {});
            }, 0);
            mirrorLocalBindingState(localHost);
            // 同步到云 = 把这条服务的字段写进云清单。
            // 路径类字段只有落在本仓库内才填相对路径，其余留空，别的电脑才用得上。
            const catalogEntry = (await bgServices.listServices(false))
              .find((item) => item.id === promoted.serviceId);
            const cloudWritten = upsertCloudService(
              catalogEntry || { id: promoted.serviceId },
              promoted.serviceId,
            );
            sendJson(res, 200, {
              ok: true,
              serviceId: promoted.serviceId,
              hostname: localHost,
              profile: updated,
              cloudServiceIds: getSharedCloudServiceIds(),
              cloudManifestPath: cloudWritten.filePath,
              localStateLists: localStateLists(localHost),
              machineServiceProfiles: getMachineServiceProfiles(cfg),
              currentMachineProfile: getMachineServiceProfile(cfg, localHost),
            });
          } catch (err) {
            sendJson(res, 400, { ok: false, error: `服务同步到云失败: ${err.message}` });
          }
          return;
        }
        if (action === 'promoteLocalDshPluginToCloud') {
          try {
            const localHost = getLocalHostInfo().hostname;
            const packageName = typeof body.package === 'string' ? body.package : '';
            // 同步到云 = 先把「这个插件」的 patch 配置块存成仓库快照，再登记云清单；
            // 快照是唯一配置来源：必须先完整写入并校验，失败时绝不更新或清空云清单的 snapshot。
            const bundle = writeLocalPluginBundle(packageName);
            const plugin = promoteLocalDshPluginToCloud(packageName, localHost, { snapshotDir: bundle.dir });
            updateMachinePlugins(getMachineDshPluginIds(localHost), localHost, {
              bundleOrder: readLocalDshBundleOrder('desktop'),
            });
            sendJson(res, 200, {
              ok: true,
              plugin,
              bundle,
              dshPlugins: getSharedDshPlugins(),
              localDshPlugins: getLocalDshPluginInventory(),
              machineDshPluginProfiles: getMachineDshPluginProfiles(),
              currentMachineDshPluginIds: getMachineDshPluginIds(localHost),
              localBinding: localBindingSnapshot(localHost),
              restartRequired: true,
            });
          } catch (err) {
            sendJson(res, 400, { ok: false, error: `插件同步到云失败: ${err.message}` });
          }
          return;
        }
        if (action === 'previewRestoreMachinePlugins' || action === 'restoreMachinePlugins') {
          const localHost = getLocalHostInfo().hostname || 'default';
          const requestedMachineId = typeof body.machineId === 'string' ? body.machineId.trim() : '';
          const listed = listMachineBindings(localHost);
          const currentBindings = loadLocalBindings(localHost);
          const matchedMachine = requestedMachineId
            ? listed.items.find((item) => item.machineId === requestedMachineId)
            : listed.items.find((item) => item.active) || null;
          const targetMachineId = requestedMachineId
            ? (matchedMachine?.machineId || requestedMachineId)
            : '';
          const sharedPlugins = getSharedDshPlugins();
          // 一键还原到本地默认直接以云端公共清单（manifest.cloud.json）中的全部云插件为准；仅当显式传入 machineId 时才按机器名单过滤。
          const targetPluginIds = (requestedMachineId && matchedMachine?.plugins?.length)
            ? matchedMachine.plugins
            : sharedPlugins.map((item) => item.id);
          const targetBundleOrder = matchedMachine?.pluginBundleOrder?.length
            ? matchedMachine.pluginBundleOrder
            : (currentBindings.pluginBundleOrder || []);
          const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');

          if (action === 'previewRestoreMachinePlugins') {
            try {
              const preview = previewPluginRestore({
                dshHome,
                profile: 'desktop',
                dshProfile: typeof body.dshProfile === 'string' ? body.dshProfile : '',
                plugins: sharedPlugins,
                selectedIds: targetPluginIds,
                bundleOrder: targetBundleOrder,
                requireSnapshots: true,
              });
              if (!preview.ok) {
                sendJson(res, 500, { ...preview, ok: false, error: `生成恢复预览失败: ${preview.error}` });
                return;
              }
              sendJson(res, 200, {
                ok: true,
                machineId: targetMachineId,
                preview,
              });
            } catch (err) {
              sendJson(res, 500, { ok: false, error: `生成恢复预览失败: ${err.message}` });
            }
            return;
          }

          try {
            const sync = await syncDshPlugins({
              dshHome,
              profile: 'desktop',
              dshProfile: typeof body.dshProfile === 'string' ? body.dshProfile : '',
              machineName: localHost,
              plugins: sharedPlugins,
              selectedIds: targetPluginIds,
              bundleOrder: targetBundleOrder,
              requireSnapshots: true,
            });
            if (!sync.ok) {
              sendJson(res, 500, {
                ...sync,
                ok: false,
                error: `按备份恢复插件失败: ${sync.error}`,
                results: sync.results || [],
                errors: sync.errors || [],
              });
              return;
            }
            const currentIds = getMachineDshPluginIds(localHost);
            updateMachinePlugins(currentIds, localHost, { bundleOrder: targetBundleOrder });
            sendJson(res, 200, {
              ...sync,
              ok: true,
              machineId: targetMachineId,
              results: sync.results || [],
              errors: sync.errors || [],
              partialFailure: Boolean(sync.partialFailure),
              restartRequired: Boolean(sync.restartRequired),
              dshPlugins: getSharedDshPlugins(),
              localDshPlugins: getLocalDshPluginInventory(),
              machineDshPluginProfiles: getMachineDshPluginProfiles(),
              currentMachineDshPluginIds: currentIds,
              localBinding: localBindingSnapshot(localHost),
            });
          } catch (err) {
            sendJson(res, 500, { ok: false, error: `按备份恢复插件失败: ${err.message}` });
          }
          return;
        }
        if (action === 'removeCloudDshPlugin') {
          // 从云清单删除：摘定义、清各电脑名单引用、删仓库里的配置快照目录；不卸载本机插件。
          try {
            const removed = removeCloudDshPlugin(body.pluginId);
            sendJson(res, 200, {
              ok: true,
              plugin: removed.plugin,
              removedDefinition: removed.removedDefinition,
              removedBundle: removed.removedBundle,
              cloudManifestPath: removed.cloudManifestPath,
              dshPlugins: getSharedDshPlugins(),
              localDshPlugins: getLocalDshPluginInventory(),
              machineDshPluginProfiles: getMachineDshPluginProfiles(),
              restartRequired: false,
            });
          } catch (err) {
            sendJson(res, 400, { ok: false, error: `删除云插件失败: ${err.message}` });
          }
          return;
        }
        if (action === 'runPluginsDoctor') {
          const report = await runPluginsDoctor({ dshHome: process.env.DSH_HOME || join(homedir(), '.dsh') });
          // 体检失败也是有效诊断结果，不把完整报告丢成一个通用 HTTP 错误。
          sendJson(res, 200, { ok: true, report });
          return;
        }
        if (action === 'syncCloudPluginToCurrentMachine') {
          const localHost = getLocalHostInfo().hostname;
          const pluginId = typeof body.pluginId === 'string' ? body.pluginId : '';
          const plugin = getSharedDshPlugins().find((item) => item.id === pluginId);
          if (!plugin) {
            sendJson(res, 400, { ok: false, error: '该插件不在项目云清单中' });
            return;
          }
          try {
            // 接入只应用当前插件的云快照，不能让其它云插件的安装/版本问题阻断它。
            const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
            const sync = await applySingleDshPluginState({
              dshHome,
              profile: 'desktop',
              dshProfile: typeof body.dshProfile === 'string' ? body.dshProfile : '',
              machineName: localHost,
              plugins: getSharedDshPlugins(),
              pluginId,
              enabled: true,
              requireSnapshots: true,
            });
            if (!sync.ok) {
              sendJson(res, 500, { ...sync, ok: false, error: `插件接入失败: ${sync.error}`, results: sync.results || [] });
              return;
            }
            // 单插件应用后再读取最终启用名单，保留其它已接入插件。
            const selectedIds = getMachineDshPluginIds(localHost);
            updateMachinePlugins(selectedIds, localHost);
            sendJson(res, 200, {
              ...sync,
              ok: true,
              plugin,
              results: sync.results,
              dshPlugins: getSharedDshPlugins(),
              localDshPlugins: getLocalDshPluginInventory(),
              machineDshPluginProfiles: getMachineDshPluginProfiles(),
              currentMachineDshPluginIds: selectedIds,
              restartRequired: sync.restartRequired,
            });
          } catch (err) {
            sendJson(res, 500, { ok: false, error: `同步到当前电脑失败: ${err.message}` });
          }
          return;
        }
        if (action === 'unlinkCloudPluginFromCurrentMachine') {
          const localHost = getLocalHostInfo().hostname || 'default';
          const pluginId = typeof body.pluginId === 'string' ? body.pluginId : '';
          const plugin = getSharedDshPlugins().find((item) => item.id === pluginId);
          if (!plugin) {
            sendJson(res, 400, { ok: false, error: '该插件不在项目云清单中' });
            return;
          }
          try {
            // 取消接入只停用当前目标，不能借机安装或升级名单里的其它云插件。
            const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
            const sync = await applySingleDshPluginState({
              dshHome,
              profile: 'desktop',
              machineName: localHost,
              plugins: getSharedDshPlugins(),
              pluginId,
              enabled: false,
              requireSnapshots: true,
            });
            if (!sync.ok) {
              sendJson(res, 500, { ...sync, ok: false, error: `插件取消接入失败: ${sync.error}`, results: sync.results || [] });
              return;
            }
            // 跳过的取消操作没有改变 Profile，不能额外摘掉备份中的插件 ID。
            const selectedIds = getMachineDshPluginIds(localHost);
            updateMachinePlugins(selectedIds, localHost);
            sendJson(res, 200, {
              ...sync,
              ok: true,
              plugin,
              dshPlugins: getSharedDshPlugins(),
              localDshPlugins: getLocalDshPluginInventory(),
              machineDshPluginProfiles: getMachineDshPluginProfiles(),
              // 客户端立刻用最终名单重绘，不能等可能较慢的工作台刷新。
              currentMachineDshPluginIds: selectedIds,
              restartRequired: sync.restartRequired,
            });
          } catch (err) {
            sendJson(res, 500, { ok: false, error: `插件取消接入失败: ${err.message}` });
          }
          return;
        }
        if (action === 'saveMachineDshPluginProfile') {
          const localHost = getLocalHostInfo().hostname || 'default';
          const requestedHost = (body.hostname || localHost).trim();
          if (requestedHost.toLocaleLowerCase() !== localHost.toLocaleLowerCase()) {
            sendJson(res, 403, { ok: false, error: '云插件接入只能由目标电脑本机管理' });
            return;
          }
          try {
            // 本机自主管理：勾选结果直接应用到本机 DSH Profile，不再写跨机器名单。
            const selectedIds = (Array.isArray(body.pluginIds) ? body.pluginIds : [])
              .filter((id) => typeof id === 'string');
            const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
            const sync = await syncDshPlugins({
              dshHome,
              profile: 'desktop',
              dshProfile: typeof body.dshProfile === 'string' ? body.dshProfile : '',
              machineName: localHost,
              plugins: getSharedDshPlugins(),
              selectedIds,
              requireSnapshots: true,
            });
            if (!sync.ok) {
              sendJson(res, 500, { ...sync, ok: false, error: `插件应用失败: ${sync.error}`, results: sync.results || [] });
              return;
            }
            // 部分失败或跳过时，备份记录读最终事实，不能把未应用的勾选写成成功。
            const currentIds = getMachineDshPluginIds(localHost);
            updateMachinePlugins(currentIds, localHost);
            sendJson(res, 200, {
              ...sync,
              ok: true,
              hostname: localHost,
              dshPluginIds: currentIds,
              machineDshPluginProfiles: getMachineDshPluginProfiles(),
              currentMachineDshPluginIds: currentIds,
              restartRequired: sync.restartRequired,
            });
          } catch (err) {
            sendJson(res, 500, { ok: false, error: `插件配置应用失败: ${err.message}` });
          }
          return;
        }

        sendJson(res, 200, await buildStateSnapshot());
      },
    });
      globalThis.__dshAuDisposeRoute = disposeRoute;
    } catch {}

    // 待办面板的服务端路由随 dsh-au 一起注册；关闭开关时该路径回 404。
    const disposeTodoRoutes = registerTodoRoutes({
      server,
      bridge: runtimeBridge,
      isEnabled: () => cfg.features.todo,
      isFullAccessByDefault: () => Boolean(cfg.features?.fullAccessByDefault),
      checkRequest: (req) => getConnectionRejection(hostCtx, req) ?? getConnectionRejection(ctx, req),
    });

    hostCtx.effect(() => () => {
      clearInterval(maintenanceTimer);
      void bgServices.disposeRecovery();
      disposeTodoRoutes();
      if (typeof disposeRoute === 'function') {
        try { disposeRoute(); } catch {}
        if (globalThis.__dshAuDisposeRoute === disposeRoute) {
          globalThis.__dshAuDisposeRoute = null;
        }
      }
      if (typeof disposeConnectRoute === 'function') {
        try { disposeConnectRoute(); } catch {}
        if (globalThis.__dshAuDisposeConnectRoute === disposeConnectRoute) {
          globalThis.__dshAuDisposeConnectRoute = null;
        }
      }
      discovery.stop();
      lanBridge.stop();
      remotePool.stopAll();
      statusTracker.dispose();
      sessionPreloadCache.dispose();
      if (globalThis.__dshAuBridge === runtimeBridge) delete globalThis.__dshAuBridge;
      if (globalThis.__dshAuNotifyScreenLock === syncScreenLockConnections) delete globalThis.__dshAuNotifyScreenLock;
      if (globalThis[HOST_APPLY_LOCK]) delete globalThis[HOST_APPLY_LOCK];
    }, 'dsh-au: lifecycle');
  });
}
