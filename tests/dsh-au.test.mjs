import './isolate-net-log.mjs';
import './isolate-sync.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getLocalDshPluginInventory,
  getMachineDshPluginIds,
  getMachineServiceProfile,
  getMachineServiceProfiles,
  getSharedCloudServiceIds,
  getSharedDshPlugins,
  canonicalMachineHost,
  isServiceListedForMachine,
  getSharedDevices,
  loadConfig,
  mergeSharedRemotes,
  promoteLocalDshPluginToCloud,
  promoteLocalServiceToCloud,
  saveConfig,
  updateMachineServiceProfile,
  normalizeMachineServiceProfile,
  applyDiscoveredLanPeer,
  publishLocalLanShare,
  updateSharedDeviceRoute,
  updateSharedRemote,
} from '../lib/config-store.js';
import { removeCloudService } from '../lib/cloud-manifest.js';
import { applyLocalBinding } from '../lib/local-bindings.js';
import { createStatusTracker } from '../lib/status-tracker.js';
import { listConversationSummaries } from '../lib/session-reader.js';
import { classifyRemoteTransport, createRemoteProxyPool } from '../lib/remote-proxy-pool.js';
import { applyPluginPatchConfig, buildNpmInstallArgs, buildPnpmInvocation, DEFAULT_NPM_REGISTRY, findLocalLinkedDependencies, getNpmPackageScope, isLocalPluginAlreadyMounted, isNpmPluginAlreadyInstalled, resolveNpmRegistry, resolvePluginPatchId, summarizePnpmFailure, syncDshPlugins, withLocalLinkSpecs } from '../lib/plugin-sync-core.js';
import { createLanBridge } from '../lib/lan-bridge.js';
import {
  SERVICES_CATALOG,
  healthProbeCandidates,
  isManagedCursorWorkerCommand,
  cursorWorkerInstancesFromNodeProcesses,
  listCursorWorkerInstances,
  isManagedRemoteDesktopCommand,
  remoteDesktopInstancesFromNodeProcesses,
  probeCursorWorkersAlive,
  listCloudflaredInstances,
  probeCloudflaredAlive,
  isManagedCloudflaredCommand,
  controlCloudflaredService,
  syncCloudflaredBootDaemon,
  resolveMacUserLaunchdTarget,
  controlMacUserLaunchdService,
  MACOS_USER_LAUNCHD_CONTROLS,
  matchesProcessPattern,
  CLOUDFLARED_ADMIN_REQUIRED,
  CLOUDFLARED_BOOT_ADMIN_REQUIRED,
  probeHealthEndpoint,
  probeServiceEndpointAlive,
  resolveCursorWorkerPrefix,
  resolveServiceConfigPath,
  syncBootStartupEntry,
  serviceControlCapability,
  validateServiceControlRequest,
} from '../lib/background-services.js';

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

/** 云清单夹具：插件与设备定义只有这一份，测试各写各的临时文件，互不干扰。 */
function cloudManifestFixture(overrides = {}) {
  return {
    schemaVersion: 1,
    updatedAt: '',
    services: {},
    devices: [{
      id: 'example-mac',
      name: 'mac',
      routes: [{ id: 'example-mac-tunnel', type: 'tunnel', url: 'https://dsh-mac.example/', username: 'shared-user' }],
    }],
    plugins: {
      'dsh-au': { name: 'DSH-au', package: 'dsh-au', source: 'local' },
      'dsh-acp-adapter': {
        name: 'ACP', package: '@example/dsh-acp-adapter', source: 'npm', version: '1.0.0',
        activation: 'profile-managed', requiresDshProfile: 'kiro',
      },
    },
    ...overrides,
  };
}

test('client mounts a root-resident top bar and preserves remote iframe instances', () => {
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');

  // 顶部栏必须在中心列 main slot 外；否则切换主面板会将它一起卸载。
  assert.match(client, /centerColumn\.insertBefore\(topHost, mainSlot\)/);
  // 舞台必须在 shell.overlay 内，以保证切回本机对话时 iframe 不卸载。
  assert.match(client, /ctx\.slots\.inject\('shell\.overlay'/);
  assert.match(client, /ReactDOM\.createPortal\(stage, hosts\.stageHost\)/);
  // 标签点击展开设备栏；键盘切换可显式保留当前折叠态。
  // selectLocal 额外带来源诊断参数；这里只锁定 preserveTopbar 默认值仍为 false。
  assert.match(client, /const selectLocal = useCallback\(\(\{ preserveTopbar = false[,}][^)]*\} = \{\}\) => \{/);
  assert.match(client, /const selectDevice = useCallback\(\(id, \{ preserveTopbar = false, targetUrl = '', navigateTopLevel = false \} = \{\}\) => \{/);
  assert.match(client, /if \(!preserveTopbar\) setTopbarCollapsed\(false\)/);
  assert.match(client, /function dispatchDeviceSwitch\(direction, preserveTopbar = true\)/);
  // 由 DSH 快捷键服务处理浏览器事件，并通过内部事件统一本地与 iframe 内的切换。
  assert.match(client, /const inject = \['slots', 'layout', 'shortcuts', 'uiWorkspace', 'sessions'\]/);
  assert.match(client, /ctx\.shortcuts\.register\(\{/);
  assert.match(client, /'dsh-au\.device\.previous'/);
  assert.match(client, /'dsh-au\.device\.next'/);
  assert.match(client, /'BracketLeft', -1/);
  assert.match(client, /'BracketRight', 1/);
  // Ctrl+Tab 向右，Ctrl+Shift+Tab 向左，均保留折叠态。
  assert.match(client, /'dsh-au\.device\.next\.ctrl-tab'/);
  assert.match(client, /'dsh-au\.device\.previous\.ctrl-shift-tab'/);
  assert.match(client, /'dsh-au\.device\.next\.ctrl-tab', '切换到右侧设备（备用）', 'Tab', 1\)/);
  assert.match(client, /'dsh-au\.device\.previous\.ctrl-shift-tab', '切换到左侧设备（备用）', 'Tab', -1\)/);
  assert.match(client, /function getDeviceSwitchShortcutDirection\(event\)/);
  assert.match(client, /return shortcutDeviceDirection\(findShortcutAction\(event\)\)/);
  assert.match(client, /const direction = getDeviceSwitchShortcutDirection\(event\)/);
  assert.match(client, /selectRelativeDevice\(direction, \{ preserveTopbar: event\.detail\?\.preserveTopbar === true \}\)/);
  // 注册表登记随快捷键覆盖重新注册：改过键位的动作不再交出默认键位。
  assert.match(client, /shortcutStore\.listeners\.add\(sync\)/);
  assert.match(client, /const defaults = code === 'Tab' \|\| customized\(actionId\)/);
  // Ctrl+Delete 打开菜单，Shift+\\ 直达服务：均由捕获阶段监听转为同一事件。
  assert.match(client, /WORKBENCH_SHORTCUT_EVENT = 'dsh-au:open-workbench'/);
  assert.match(client, /function dispatchWorkbenchShortcut\(tab\)/);
  assert.match(client, /actionId === 'menu\.open'/);
  assert.match(client, /keyBinding\('Delete', \{ ctrl: true \}\)/);
  assert.doesNotMatch(client, /const isCtrlBackslash/);
  assert.match(client, /actionId === 'services\.open'/);
  assert.match(client, /keyBinding\('Backslash', \{ shift: true \}\)/);
  assert.match(client, /window\.addEventListener\(WORKBENCH_SHORTCUT_EVENT, onWorkbenchShortcut\)/);
  assert.match(client, /window\.addEventListener\('keydown', onKey, true\)/);
  assert.match(client, /const registerWorkbenchShortcut = \(id, label, tab\) => \{/);
  assert.match(client, /'dsh-au\.workbench\.menu'/);
  assert.match(client, /'dsh-au\.workbench\.services'/);
  assert.match(client, /dispatchWorkbenchShortcut\('fav'\)/);
  assert.match(client, /dispatchWorkbenchShortcut\('services'\)/);
  // 严禁在 ShortcutRegistry defaults 中抢注 Backslash，否则会令后加载的 @deepseek-ai/dsh-client-ui-sidebar-right (pane.split) 抛冲突崩溃
  assert.doesNotMatch(client, /'desktop:windows':\s*\{\s*code:\s*'Backslash'/);
  assert.doesNotMatch(client, /'desktop:windows':\s*\{\s*code:\s*'Tab'/);
  assert.doesNotMatch(client, /event\.key\.toLocaleLowerCase\(\) === 'k'/);
  assert.match(client, /window\.addEventListener\(DEVICE_SWITCH_EVENT, onDeviceSwitch\)/);
  assert.match(client, /window\.top\.postMessage\(\{ source: 'dsh-au', type: 'switch-device', direction \}, '\*'\)/);
  // macOS 仅在 DSH 侧栏折叠时给顶部栏让出固定间距，dsh-au 胶囊状态不参与判断。
  assert.match(client, /MACOS_SIDEBAR_COLLAPSED_LEADING_INSET = 180/);
  assert.match(client, /data-sidebar-collapsed/);
  assert.match(client, /sidebarLeadingInset = IS_MACOS && dshSidebarCollapsed/);
  assert.match(client, /ensureStyles\(sidebarLeadingInset\)/);
  // 折叠态只保留状态点：胶囊本体直接拖动、单击展开，位置与选择均可持久化。
  assert.match(client, /TOPBAR_COLLAPSED_STORAGE_KEY = 'dsh-au\.topbar-collapsed'/);
  assert.match(client, /localStorage\.setItem\(TOPBAR_COLLAPSED_STORAGE_KEY, String\(topbarCollapsed\)\)/);
  assert.match(client, /className: 'dsh-au-floating-capsule dsh-au-status-capsule'/);
  assert.match(client, /FLOATING_CAPSULE_STORAGE_KEY = 'dsh-au\.status-capsule-position'/);
  assert.match(client, /onPointerDown: startCapsuleDrag/);
  assert.match(client, /suppressCapsuleClickRef\.current = drag\.moved/);
  assert.doesNotMatch(client, /dsh-au-capsule-grip|DragGripIcon/);
  assert.match(client, /ReactDOM\.createPortal\(floatingCapsule, hosts\?\.stageHost \|\| document\.body\)/);
  assert.match(client, /hosts && !topbarCollapsed \? ReactDOM\.createPortal\(topbar, hosts\.topHost\)/);
  assert.match(client, /setHostMountAttempt\(\(attempt\) => attempt \+ 1\)/);
  assert.match(client, /statusItems\.map\(\(item\)/);
  // 设备归属只取手动账本；运行时身份与扫描结果不得参与自动归并。
  assert.match(client, /function buildManualDeviceViews\(self, definitions, remotes, accessTransport = 'local'\)/);
  assert.match(client, /function isSelfDevice\(device, self\)/);
  assert.match(client, /const devices = allDevices.filter\(\(device\) => !isSelfDevice\(device, state\.self\)\)/);
  assert.match(client, /const allDevices = buildManualDeviceViews\(state\.self, state\.devices, state\.remotes, accessRoute\.transport\)/);
  assert.doesNotMatch(client, /function isCurrentHostRemote|function isSamePhysicalMachine|function mergeSameHostDevices/);
  // 当前入口仍决定在已登记路径中选择 LAN、IPv6 或 tunnel，不改变设备归属。
  assert.match(client, /function resolveCurrentAccessRoute\(remotes, href\)/);
  assert.match(client, /function selectRouteForCurrentAccess\(routes, accessTransport = 'local'\)/);
  assert.match(client, /accessRoute = resolveCurrentAccessRoute\(state\.remotes, window\.location\.href\)/);
   assert.match(client, /function formatRouteTransportLabel\(route\)/);
   assert.match(client, /const transport = \['lan', 'ipv6', 'tunnel'\]\.includes\(remote\.transport\)/);
   assert.doesNotMatch(client, /remote\.transport === 'ipv6' \? 'ipv6' : 'tunnel'/);
   assert.match(client, /正在加载远程 DSH 界面：\$\{activeDev\.name\}（\$\{formatRouteTransportLabel\(activeDev\.selectedRoute\)\}）/);
  // 2026-10-28：保活、超时与回退改由 remote-frames.test.mjs 驱动真实组件行为，
  // 不再把旧回调签名或标签计时器当成行为保障。
  // 手机上同源 POST 认证接力必须提交到受控 iframe，不能导航走控制端页面。
  assert.match(client, /function navigateToAuthenticatedRemote\(routeId, targetName = ''\)/);
  assert.match(client, /form\.action = '\/dsh-au\/connect'/);
  assert.match(client, /form\.target = targetName/);
  assert.match(client, /if \(selectedDevice\?\.useDirectNavigation && compactMobile\)/);
  assert.match(client, /navigateToAuthenticatedRemote\(routeId, frameName\)/);
  // 浏览器顶栏整页跳到远程 DSH；桌面壳和侧栏远程对话走嵌页。
  assert.match(client, /onClick: \(\) => selectDevice\(device\.id, \{ targetUrl: device\.targetUrl, navigateTopLevel: true \}\)/);
  assert.match(client, /if \(!compactMobile && !isElectronShell\(\) && \(navigateTopLevel \|\| selectedDevice\.useDirectNavigation\)\)/);
  assert.match(client, /selectDevice\(target\.id, \{ preserveTopbar: true, targetUrl: target\.targetUrl \|\| '' \}\)/);
  assert.doesNotMatch(client, /selectDevice\(target\.id, \{[^}]*navigateTopLevel/);
  // 手机端从展开设备栏切换远端时不能自动收起，否则无法连续切换或返回控制端。
  assert.match(client, /用户从已展开的手机设备栏点选远端时，保留设备标签以便继续切换或返回。/);
  assert.match(client, /if \(!preserveTopbar\) setTopbarCollapsed\(false\);[\s\S]*?reportClientEvent\('select-device', id\);/);
  assert.match(client, /document\.documentElement\.setAttribute\('data-dsh-au-remote-active', 'true'\)/);
  // 仅由 DSH-AU 创建的远端 iframe 进入被控态；只转发设备切换按键，不挂载第二套界面。
  assert.match(client, /CONTROLLED_FRAME_NAME_PREFIX = 'dsh-au-controlled:'/);
  assert.match(client, /function isControlledFrame\(\)/);
  assert.match(client, /'data-html-preview': ''/);
  assert.match(client, /function installControlledFrameShortcutBridge\(\)/);
  assert.match(client, /window\.top\.postMessage\(\{ source: 'dsh-au', type: 'switch-device', direction, preserveTopbar: true \}, '\*'\)/);
  assert.match(client, /function isDeviceSwitchMessageFromStage\(/);
  assert.match(client, /isDeviceSwitchMessageFromStage\(event\.source, frames\)/);
  assert.doesNotMatch(client, /frame\.contentWindow === event\.source/);
  const bridge = client.slice(client.indexOf('function installControlledFrameShortcutBridge('), client.indexOf('function dispatchWorkbenchShortcut'));
  assert.match(bridge, /if \(!action\?\.forward\) return;/);
  assert.doesNotMatch(bridge, /defaultPrevented/);
  assert.match(client, /if \(isControlledFrame\(\)\) \{/);
  assert.match(client, /ctx\.effect\(\(\) => installControlledFrameShortcutBridge\(\), 'dsh-au: controlled frame shortcut bridge'\)/);
  assert.match(client, /if \(window\[CLIENT_APPLY_LOCK\]\) return;/);

  // 顶栏只保留高频全局入口、插件入口和设备操作；局域网开关与扫描收纳进远程弹窗。
  const toolbarStart = client.indexOf("className: 'dsh-au-actions'");
  const toolbar = client.slice(toolbarStart, client.indexOf('const floatingCapsule = h(', toolbarStart));
  assert.match(toolbar, /className: 'dsh-au-action-group'/);
  assert.match(toolbar, /className: 'dsh-au-action-divider'/);
  assert.match(toolbar, /h\(CommandMenuIcon\)/);
  assert.match(toolbar, /h\(ServicesIcon\)/);
  assert.match(toolbar, /h\(PluginIcon\)/);
  assert.match(toolbar, /setWorkbenchTab\('plugins'\)/);
  assert.match(toolbar, /h\(AddRemoteIcon\)/);
  assert.match(toolbar, /h\(RefreshIcon\)/);
  assert.doesNotMatch(toolbar, /h\(LanIcon\)|ScanIcon|dsh-au-action-status/);
  assert.match(toolbar, /className: 'dsh-au-icon-btn primary'/);
  assert.doesNotMatch(toolbar, /dsh-au-btn on|\+ 添加远程域名|⚡ 统一菜单|⚙ 后台服务|🔍 扫描局域网/);
  // 顶栏可见标签保持短文案；脚本菜单用四字以区分命令入口。
  for (const label of ['插件', '服务', '脚本菜单', '远程', '新增']) {
    assert.match(toolbar, new RegExp(`dsh-au-tool-label' }, '${label}'`));
  }
  // 网络诊断日志留给 Agent 读文件；顶栏不再放下载按钮。
  assert.doesNotMatch(toolbar, /dsh-au-tool-label' }, '日志'|h\(NetLogIcon\)|downloadNetLog/);
  assert.match(client, /dsh-au-mobile-collapse/);
  assert.match(client, /'aria-label': '收起设备栏'/);
  assert.match(toolbar, /h\(RemoteListIcon\)/);
  // 左侧设备标签只承担切换，配置编辑集中到远程管理面板。
  assert.match(client, /dsh-au-tab-name/);
  assert.match(client, /dsh-au-tab\.active \.dsh-au-badge/);
  assert.doesNotMatch(client, /编辑远程配置.*✎/);
  // 管理页直接渲染手动设备及其完整路径，并收纳本机局域网接入、扫描、新增设备和本机归属。
  assert.match(client, /function RemoteManagerModal\(\{ devices, self, lanOn, scanning, onToggleLan, onDiscover,/);
  assert.match(client, /function DeviceModal\(/);
  assert.match(client, /function RouteModal\(/);
  assert.match(client, /devices: allDevices/);
  assert.match(client, /onToggleLan: toggleLanShare/);
  assert.match(client, /onDiscover: handleDiscover/);
  assert.match(client, /本机局域网接入/);
  assert.match(client, /扫描中\.\.\./);
  assert.match(client, /onAddDevice:/);
  assert.match(client, /onAddRoute:/);
  assert.match(client, /onSetLocal: handleSetLocalDevice/);
  assert.match(client, /dsh-au-remote-device-routes/);
  // 每条地址可单独复制，且复制按钮不会占用点击路径编辑的动作。
  assert.match(client, /async function copyConnectionUrl\(url\)/);
  assert.match(client, /className: 'dsh-au-btn dsh-au-copy-link'/);
  assert.match(client, /copiedRouteId === route\.id \? '已复制' : '复制'/);
  assert.match(client, /\.dsh-au-copy-link \{ min-width:58px; padding:6px 12px; \}/);
  // 本机地址与 LAN 地址的展示行为由 local-routes.test.mjs 的回归用例覆盖。
  for (const type of ['local', 'lan', 'ipv6', 'tunnel']) {
    assert.match(client, new RegExp(`value: '${type}'`));
  }
  // 路径状态与设备总状态相同时仅保留状态灯，差异状态才显示文字。
  assert.match(client, /const renderRoute = \(route, deviceStatus\) => \{/);
  assert.match(client, /const statusDiff = \(route\.status \|\| 'unknown'\) !== deviceStatus/);
  assert.match(client, /visibleRoutes\(device\)\.map\(\(route\) => renderRoute\(route, device\.status\)\)/);
  // 标题不随长列表滚动，路径列表独占剩余高度滚动。
  assert.match(client, /\.dsh-au-remote-manager \{ width:min\(930px,96vw\); height:min\(840px,calc\(92dvh - 24px\)\);/);
  assert.match(client, /\.dsh-au-remote-manager-head .*flex:0 0 auto/);
  assert.match(client, /\.dsh-au-remote-list \{ display:flex; flex:1 1 auto; flex-direction:column; min-height:0;.*overflow-y:auto/);
  // 滚动容器内的卡片禁止 shrink；局域网控制卡与路径行必须锁定盒模型、图标宽高与不换行标题。
  assert.match(client, /\.dsh-au-remote-device \{ flex:0 0 auto;/);
  assert.match(client, /\.dsh-au-lan-control \{ display:flex; align-items:center; justify-content:space-between; gap:12px; padding:11px 14px;/);
  assert.match(client, /\.dsh-au-remote-row \{ box-sizing:border-box; width:100%;/);
  assert.match(client, /\.dsh-au-remote-row-name \{ display:inline-flex; align-items:center; gap:7px; font-size:13px; line-height:18px; font-weight:600; color:#f1f5f9; white-space:nowrap; \}/);
  assert.match(client, /\.dsh-au-remote-row-name svg \{ width:15px; height:15px; flex:0 0 15px;/);
  // 顶栏是唯一入口，侧边面板列表不再注册。
  assert.doesNotMatch(client, /ctx\.slots\.inject\('sidebar\.panellist'/);
  // 保留全部状态样式；实际主题色与对比度由浏览器回归验证，不再锁住单个深色十六进制值。
  for (const status of ['idle', 'busy', 'done', 'waiting', 'error']) {
    assert.match(client, new RegExp(`\\.dsh-au-dot\\.${status} \\{`));
  }
  assert.match(client, /waiting: '等待你操作'/);
  assert.match(client, /runtime\?\.statusV2 \|\| runtime\?\.status/);
  assert.match(client, /dsh-au-dot\.needs_auth, \.dsh-au-dot\.unknown, \.dsh-au-dot\.offline \{/);
  // 服务控制响应优先于轮询，并在服务端日志不可用时留下可见的本地诊断。
  assert.match(client, /refreshRevisionRef/);
  assert.match(client, /serviceControlEpochRef/);
  assert.match(client, /appendServiceUiLog/);
  assert.match(client, /控制响应不完整：未返回服务状态/);
  assert.match(client, /接口返回了非 JSON 内容/);
  // 插件管理使用一个侧边栏入口，页面内切换本机/云插件；ACP 不再和 Kiro 作任何关联。
  assert.match(client, /activeTab === 'plugins'/);
  assert.match(client, /pluginView === 'cloud'/);
  assert.match(client, /插件管理/);
  assert.match(client, /本机插件/);
  assert.match(client, /云插件/);
  assert.match(client, /localDshPlugins/);
  assert.match(client, /'unlinkCloudPluginFromCurrentMachine'/);
  assert.match(client, /machineDshPluginProfiles: res\.machineDshPluginProfiles/);
  assert.match(client, /currentMachineDshPluginIds: Array\.isArray\(res\.currentMachineDshPluginIds\)/);
  // 徽标文案精简，避免在窄卡片里换行
  assert.match(client, /'仅本机'/);
  assert.match(client, /同步到云/);
  assert.match(client, /取消接入此电脑/);
  assert.match(client, /promoteLocalDshPluginToCloud/);
  assert.doesNotMatch(client, /removeSharedDshPluginFromCloud/);
  assert.doesNotMatch(client, /backupAllLocalPluginsToCloud/);
  assert.doesNotMatch(client, /一键备份本机全部插件/);
  assert.match(client, /一键还原到本地/);
  assert.match(client, /确认从云端还原到本地/);
  assert.match(client, /syncCloudPluginToCurrentMachine/);
  assert.match(client, /同步到当前电脑/);
  assert.match(client, /currentMachineDshPluginIds/);
  // 排序口径与自研标签必须同源：排序用 resolvePluginCardState 的状态，卡片/详情复用同一份。
  assert.match(client, /const resolvePluginCardState = \(plugin, ctx = \{\}\) => \{/);
  assert.match(client, /const pluginSortRank = \(state\) => \{/);
  assert.match(client, /sortPluginsByState\(isCloudPluginTab \? dshPlugins : localDshPlugins/);
  assert.match(client, /const isOwnDshPlugin = \(plugin\) =>/);
  assert.match(client, /dsh-au-chip-own/);
  // 状态只由 pluginStateView 出一份 chips，动作只留一个按钮：卡片不再放按钮，避免同一件事说三遍。
  assert.match(client, /const pluginStateView = \(state\) => \{/);
  assert.match(client, /'取消接入本机'/);
  assert.match(client, /'从云清单移除'/);
  assert.match(client, /推送到云端配置/);
  assert.match(client, /从云覆盖本地/);
  // 两个移除动作的影响范围不同，必须各自带一行说明，否则会被当成同一件事。
  assert.match(client, /unlink: '仅这台电脑 · 停用不卸载 · 配置不跟随云'/);
  assert.match(client, /'所有电脑都看不到 · 不影响本机'/);
  assert.doesNotMatch(client, /pluginEnabledState/);
  assert.doesNotMatch(client, /className: 'dsh-au-card-foot', 'data-align': 'split'/);
  // 左栏四个页签与顶栏共用同一套 16px 线性图标：插件管理不再缺图标，也不再混用 ★/⚙ 字符。
  assert.match(client, /navItem\('plugins', 'nav-plugins', h\(PluginIcon\), '插件管理'/);
  assert.match(client, /function StarIcon\(\)/);
  assert.doesNotMatch(client, /'★ 常用收藏'/);
  assert.doesNotMatch(client, /'⚙ 后台服务管理'/);
  assert.match(client, /'自研'/);
  assert.match(client, /serviceView === 'cloud'/);
  assert.match(client, /本机服务 · 运行中 \$\{runningCount\}\/\$\{localServices\.length\} 项/);
  assert.match(client, /云服务/);
  assert.match(client, /visibleServices/);
  assert.doesNotMatch(client, /listedForMachine/);
  assert.match(client, /localBindingServiceIds/);
  assert.match(client, /cloudServiceIds/);
  assert.match(client, /promoteLocalServiceToCloud/);
  assert.match(client, /toggleCloudServiceOnCurrentMachine/);
  assert.match(client, /dsh-au-plugin-notice/);
  assert.match(client, /pluginNoticeOwner === cloudPluginId \? pluginNotice : ''/);
  assert.match(client, /pluginSaving \? '正在处理…' : view\.actionLabel/);
  assert.match(client, /正在启动，等待进程探测…/);
  assert.doesNotMatch(client, /启动命令已执行/);
  assert.match(client, /启动后仍未运行/);
  assert.match(client, /dsh-au-svc-spinner/);
  // 服务详情改为克制结构：单层标题 + 状态 chips + 三行开关，不再堆叠编号框
  assert.match(client, /className: 'dsh-au-insp-name'/);
  assert.match(client, /flagRow\('开机自启动'/);
  assert.doesNotMatch(client, /1\. 纳入电脑/);
  assert.match(client, /workerNames\.join\(' · '\)/);
  assert.match(client, /function matchPluginHost\(hostKey, target\)/);
  assert.doesNotMatch(client, /Example-Yoga.*将同步/);
  assert.doesNotMatch(client, /可为其它电脑预先选择/);
  // 手机端保留悬浮折叠与独立收起入口，工具由右侧菜单纵向展开。
  assert.match(client, /function isMobileTopbarViewport/);
  assert.match(client, /移动 UA 或触摸输入进入手机模式/);
  assert.match(client, /compact-mobile \.dsh-au-actions \{ display:none/);
  assert.match(client, /compact-mobile\.mobile-tools-open \.dsh-au-actions \{ display:flex/);
  assert.match(client, /compact-mobile \.dsh-au-mobile-controls \{ display:flex/);
  // 汉堡菜单只给手机端；选择器必须压过通用 icon-btn 的 display:inline-flex。
  assert.match(client, /\.dsh-au-icon-btn\.dsh-au-mobile-menu \{ display:none/);
  assert.match(client, /compact-mobile \.dsh-au-icon-btn\.dsh-au-mobile-menu \{ display:inline-flex/);
  assert.match(client, /className: 'dsh-au-icon-btn dsh-au-mobile-collapse'/);
  assert.match(client, /'aria-controls': 'dsh-au-topbar-tools'/);
  assert.match(client, /Cursor ACP 接入插件：用于把 Cursor Agent 接入 DSH/);
  assert.doesNotMatch(client, /Cursor ACP 接入与 Kiro 网关独立/);
  // 开源仓客户端仅保留通用占位文案，不硬编码特定机器名。
  assert.match(client, /设备名称，如 example-mac/);
  // 四类卡片共用同一套结构，插件卡片不再单独用修饰 class
  assert.match(client, /className: 'dsh-au-card-head'/);
  assert.match(client, /dsh-au-card-title/);
});

test('nested preview switch-device source still matches the stage iframe', () => {
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  const start = client.indexOf('function isDeviceSwitchMessageFromStage(');
  assert.ok(start >= 0, 'isDeviceSwitchMessageFromStage missing');
  let depth = 0;
  let end = client.indexOf('{', start);
  for (; end < client.length; end += 1) {
    if (client[end] === '{') depth += 1;
    else if (client[end] === '}') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }
  const isDeviceSwitchMessageFromStage = new Function(`${client.slice(start, end)}; return isDeviceSwitchMessageFromStage;`)();
  const stageWindow = {};
  stageWindow.parent = stageWindow;
  const nested = { parent: stageWindow };
  const outsider = {};
  outsider.parent = outsider;
  const frames = [{ contentWindow: stageWindow }];
  assert.equal(isDeviceSwitchMessageFromStage(stageWindow, frames), true);
  assert.equal(isDeviceSwitchMessageFromStage(nested, frames), true);
  assert.equal(isDeviceSwitchMessageFromStage(outsider, frames), false);
});

test('config-store round-trips syncRepoRoot and auwinRoot without dropping them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-cfg-root-'));
  process.env.DSH_AU_CONFIG_PATH = join(dir, 'dsh-au.config.json');
  try {
    writeFileSync(join(dir, 'dsh-au.config.json'), JSON.stringify({
      syncRepoRoot: 'D:/private-sync-repo',
      auwinRoot: 'D:/PlatformRoot',
    }), 'utf8');
    const cfg = loadConfig();
    assert.equal(cfg.syncRepoRoot, 'D:/private-sync-repo');
    assert.equal(cfg.auwinRoot, 'D:/PlatformRoot');
    saveConfig(cfg);
    const reloaded = JSON.parse(readFileSync(join(dir, 'dsh-au.config.json'), 'utf8'));
    assert.equal(reloaded.syncRepoRoot, 'D:/private-sync-repo');
    assert.equal(reloaded.auwinRoot, 'D:/PlatformRoot');
  } finally {
    delete process.env.DSH_AU_CONFIG_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config-store initializes default remote and persists updates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-cfg-'));
  process.env.DSH_AU_CONFIG_PATH = join(dir, 'dsh-au.config.json');
  try {
    const cfg = loadConfig();
    // 局域网免密接入默认关闭，必须由用户明确开启。
    assert.equal(cfg.lanShareEnabled, false);
    // 开源默认云清单没有内置设备；远程路线只来自私人仓库云清单。
    assert.deepEqual(cfg.remotes, []);

    cfg.lanShareEnabled = true;
    saveConfig(cfg);
    assert.equal(loadConfig().lanShareEnabled, true);
    cfg.lanShareEnabled = false;
    saveConfig(cfg);
    const reloaded = loadConfig();
    assert.equal(reloaded.lanShareEnabled, false);
  } finally {
    delete process.env.DSH_AU_CONFIG_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config-store synchronizes shared metadata without replacing target-machine identity or passwords', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-cfg-'));
  const configPath = join(dir, 'dsh-au.config.json');
  const cloudPath = join(dir, 'manifest.cloud.json');
  process.env.DSH_AU_CONFIG_PATH = configPath;
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = cloudPath;
  try {
    writeFileSync(cloudPath, `${JSON.stringify(cloudManifestFixture({
      devices: [
        {
          id: 'example-mac', name: 'mac',
          routes: [
            { id: 'r_example_mac_tunnel', type: 'tunnel', url: 'https://dsh.example.com/', username: 'shared-user' },
            { id: 'r_example_mac_ipv6', type: 'ipv6', url: 'https://example-mac.example:8443/dsh/' },
            { id: 'lan_example_mac', type: 'lan', url: 'http://192.0.2.38:31990/' },
          ],
        },
        {
          id: 'win', name: 'win',
          routes: [
            { id: 'r_example_win_tunnel', type: 'tunnel', url: 'https://dsh-win.example.com/', username: 'shared-user' },
            { id: 'r_example_win_ipv6', type: 'ipv6', url: 'https://win.example:8443/dsh/' },
          ],
        },
      ],
    }), null, 2)}\n`);
    writeFileSync(configPath, JSON.stringify({
      instanceId: 'target_machine_only',
      remotes: [{
        id: 'r_example_mac_tunnel',
        name: 'locally renamed Mac6',
        url: 'https://dsh.example.com/',
        username: 'shared-user',
        password: 'target-machine-password',
        knownIdentity: { instanceId: 'same-mac', hostname: 'Mac.local', ips: ['192.0.2.38'] },
      }, {
        id: 'r_example_win_tunnel',
        name: 'locally renamed Win',
        url: 'https://dsh-win.example.com/',
        username: 'shared-user',
        password: 'target-machine-win-password',
      }],
    }), 'utf8');

    const cfg = loadConfig();
    assert.equal(cfg.instanceId, 'target_machine_only');
    assert.equal(cfg.remotes.find((remote) => remote.id === 'r_example_mac_tunnel')?.password, 'target-machine-password');
    assert.deepEqual(cfg.remotes.find((remote) => remote.id === 'r_example_mac_tunnel')?.knownIdentity, { instanceId: 'same-mac', hostname: 'Mac.local', ips: ['192.0.2.38'] });
    assert.equal(cfg.remotes.find((remote) => remote.id === 'r_example_mac_tunnel')?.deviceId, 'example-mac');
    assert.equal(cfg.remotes.find((remote) => remote.id === 'r_example_mac_tunnel')?.transport, 'tunnel');
    // 显示名跟公共账本走；本机改过的 locally renamed Mac6 不能压过远程 name。
    assert.equal(cfg.remotes.find((remote) => remote.id === 'r_example_mac_tunnel')?.name, 'mac');
    // 新增路径不从同设备复制密码，避免将凭据发到尚未确认的新地址。
    assert.equal(cfg.remotes.find((remote) => remote.id === 'r_example_mac_ipv6')?.password, '');
    assert.equal(cfg.remotes.find((remote) => remote.id === 'r_example_mac_ipv6')?.transport, 'ipv6');
    // 局域网路径以远程账本为准，本机未确认前密码必须为空。
    const lanRemote = cfg.remotes.find((remote) => remote.id === 'lan_example_mac');
    assert.equal(lanRemote?.deviceId, 'example-mac');
    assert.equal(lanRemote?.transport, 'lan');
    assert.equal(lanRemote?.url, 'http://192.0.2.38:31990/');
    assert.equal(lanRemote?.password, '');
    assert.equal(cfg.remotes.find((remote) => remote.id === 'r_example_win_tunnel')?.deviceId, 'win');
    assert.equal(cfg.remotes.find((remote) => remote.id === 'r_example_win_ipv6')?.password, '');
    assert.equal(cfg.remotes.find((remote) => remote.id === 'r_example_win_ipv6')?.transport, 'ipv6');
  } finally {
    delete process.env.DSH_AU_CONFIG_PATH;
    delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shared metadata update renames Mac6 to Mac7 while retaining password when URL and username match', () => {
  const remotes = mergeSharedRemotes([
    {
      id: 'example-mac',
      name: 'Mac6',
      url: 'https://same-mac.example/dsh/',
      username: 'shared-user',
      password: 'target-only-secret',
      knownIdentity: { instanceId: 'id-1', hostname: 'Mac6.local', ips: ['192.0.2.10'] },
      proxyUrl: 'http://127.0.0.1:7890/',
      transport: 'tunnel',
    },
  ], [
    {
      id: 'example-mac',
      name: 'Mac7',
      url: 'https://same-mac.example/dsh/',
      username: 'shared-user',
      password: '',
      transport: 'tunnel',
    },
  ]);

  assert.deepEqual(remotes, [{
    id: 'example-mac',
    name: 'Mac7',
    url: 'https://same-mac.example/dsh/',
    username: 'shared-user',
    password: 'target-only-secret',
    knownIdentity: { instanceId: 'id-1', hostname: 'Mac6.local', ips: ['192.0.2.10'] },
    proxyUrl: 'http://127.0.0.1:7890/',
    transport: 'tunnel',
  }]);
});

test('shared metadata update clears password, knownIdentity, and proxyUrl when URL or username changes', () => {
  const urlChanged = mergeSharedRemotes([
    {
      id: 'example-mac',
      name: 'Mac6',
      url: 'https://old-mac.example/dsh/',
      username: 'shared-user',
      password: 'target-only-secret',
      knownIdentity: { instanceId: 'id-1', hostname: 'Mac6.local', ips: ['192.0.2.10'] },
      proxyUrl: 'http://127.0.0.1:7890/',
      transport: 'tunnel',
    },
  ], [
    {
      id: 'example-mac',
      name: 'Mac7',
      url: 'https://new-mac.example/dsh/',
      username: 'shared-user',
      password: '',
      transport: 'tunnel',
    },
  ]);

  assert.deepEqual(urlChanged, [{
    id: 'example-mac',
    name: 'Mac7',
    url: 'https://new-mac.example/dsh/',
    username: 'shared-user',
    password: '',
    transport: 'tunnel',
  }]);

  const usernameChanged = mergeSharedRemotes([
    {
      id: 'example-mac',
      name: 'Mac6',
      url: 'https://same-mac.example/dsh/',
      username: 'old-user',
      password: 'target-only-secret',
      knownIdentity: { instanceId: 'id-1', hostname: 'Mac6.local', ips: ['192.0.2.10'] },
      proxyUrl: 'http://127.0.0.1:7890/',
      transport: 'tunnel',
    },
  ], [
    {
      id: 'example-mac',
      name: 'Mac6',
      url: 'https://same-mac.example/dsh/',
      username: 'new-user',
      password: '',
      transport: 'tunnel',
    },
  ]);

  assert.deepEqual(usernameChanged, [{
    id: 'example-mac',
    name: 'Mac6',
    url: 'https://same-mac.example/dsh/',
    username: 'new-user',
    password: '',
    transport: 'tunnel',
  }]);
});

test('manual device routes keep LAN endpoints public but runtime identity and credentials local', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-device-route-'));
  const cloudPath = join(dir, 'manifest.cloud.json');
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = cloudPath;
  try {
    writeFileSync(cloudPath, `${JSON.stringify(cloudManifestFixture(), null, 2)}\n`, 'utf8');
    const saved = updateSharedDeviceRoute('example-mac', {
      id: 'example-mac-lan', type: 'lan', url: 'http://example-mac.local:31990/', username: 'shared-user',
    });
    assert.equal(saved.device.id, 'example-mac');
    assert.equal(saved.route.type, 'lan');
    assert.equal(getSharedDevices()[0].routes.some((route) => route.id === 'example-mac-lan' && route.url === 'http://example-mac.local:31990/'), true);
    const written = readFileSync(cloudPath, 'utf8');
    assert.doesNotMatch(written, /password|knownIdentity|instanceId|ips|lanShareEnabled/);
    assert.throws(() => updateSharedDeviceRoute('example-mac', {
      id: 'unsafe', type: 'tunnel', url: 'https://user:secret@example.test/?token=leak',
    }), /路径类型或地址无效/);
  } finally {
    delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discovered LAN peers write public lan routes for bound devices without copying identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-lan-peer-'));
  const cloudPath = join(dir, 'manifest.cloud.json');
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = cloudPath;
  try {
    writeFileSync(cloudPath, `${JSON.stringify(cloudManifestFixture({
      devices: [{ id: 'win', name: 'win', routes: [{ id: 'local_win', type: 'local' }] }],
    }), null, 2)}\n`, 'utf8');

    assert.equal(applyDiscoveredLanPeer({
      deviceId: 'win',
      url: 'http://192.0.2.19:31990/',
      instanceId: 'must-not-persist',
    })?.unchanged, false);
    const first = getSharedDevices()[0].routes.find((route) => route.type === 'lan');
    assert.equal(first?.id, 'lan_win');
    assert.equal(first?.url, 'http://192.0.2.19:31990/');

    assert.equal(applyDiscoveredLanPeer({
      deviceId: 'win',
      url: 'http://192.0.2.19:31990/',
    })?.unchanged, true);
    assert.equal(applyDiscoveredLanPeer({ deviceId: 'unknown', url: 'http://192.0.2.8:31990/' }), null);
    assert.doesNotMatch(readFileSync(cloudPath, 'utf8'), /must-not-persist|instanceId/);

    const published = publishLocalLanShare('win', ['192.0.2.88', '10.0.0.2'], 31990);
    assert.equal(published?.unchanged, false);
    assert.equal(getSharedDevices()[0].routes.find((route) => route.type === 'lan')?.url, 'http://10.0.0.2:31990/');
  } finally {
    delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local DSH inventory separates Profile plugins that join cloud sync from local-only plugins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-plugin-inventory-'));
  const profileDir = join(dir, 'profiles', 'desktop');
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = join(dir, 'manifest.cloud.json');
  process.env.DSH_HOME = dir;
  try {
    // 云清单带插件定义；这台电脑接入了哪些只看本机 Profile。
    writeFileSync(process.env.DSH_AU_CLOUD_MANIFEST_PATH, `${JSON.stringify(cloudManifestFixture(), null, 2)}\n`, 'utf8');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dependencies: {
        'dsh-au': '0.1.0',
        '@example/dsh-acp-adapter': '1.0.0',
        'local-only-plugin': '2.0.0',
      },
      // bundles 决定插件是否真的加载：装了但不在 bundles 里就算未启用。
      dsh: { profile: { bundles: ['dsh-au'] } },
    }), 'utf8');
    mkdirSync(join(profileDir, 'node_modules', 'dsh-au'), { recursive: true });
    writeFileSync(join(profileDir, 'node_modules', 'dsh-au', 'package.json'), JSON.stringify({
      name: 'dsh-au', version: '0.1.0', description: 'DSH 多机远程与局域网自发现工作区插件',
    }), 'utf8');

    const inventory = getLocalDshPluginInventory();
    assert.equal(inventory.length, 3);
    assert.deepEqual(inventory.find((plugin) => plugin.package === 'dsh-au'), {
      id: 'dsh-au', name: 'DSH-au', package: 'dsh-au', version: '0.1.0',
      description: 'DSH 多机远程与局域网自发现工作区插件', enabled: true,
      source: 'local', cloudManaged: true, selectedForCurrentMachine: true,
    });
    assert.equal(inventory.find((plugin) => plugin.package === '@example/dsh-acp-adapter')?.cloudManaged, true);
    assert.deepEqual(inventory.find((plugin) => plugin.package === 'local-only-plugin'), {
      id: 'local-only-plugin', name: 'local-only-plugin', package: 'local-only-plugin', version: '2.0.0',
      description: '', enabled: false,
      source: 'local-profile', cloudManaged: false, selectedForCurrentMachine: false,
    });
  } finally {
    delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    delete process.env.DSH_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('profile patch disabled overrides a plugin listed in bundles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-plugin-disabled-'));
  const profileDir = join(dir, 'profiles', 'desktop');
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = join(dir, 'manifest.cloud.json');
  process.env.DSH_HOME = dir;
  try {
    writeFileSync(process.env.DSH_AU_CLOUD_MANIFEST_PATH, `${JSON.stringify(cloudManifestFixture({
      plugins: { 'example-plugin': { name: 'Example', package: 'example-plugin', source: 'npm' } },
    }), null, 2)}\n`, 'utf8');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dependencies: { 'example-plugin': '1.0.0' },
      dsh: { profile: { bundles: ['example-plugin'] } },
    }), 'utf8');
    writeFileSync(join(profileDir, 'cordis.patch.yml'), [
      '- id: example-plugin',
      '  name: "example-plugin"',
      '  disabled: true',
      '',
    ].join('\n'), 'utf8');

    const inventory = getLocalDshPluginInventory('desktop', dir);
    assert.equal(inventory[0].enabled, false);
    assert.deepEqual(getMachineDshPluginIds(), []);
  } finally {
    delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    delete process.env.DSH_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plugin description prefers the local Chinese override over the package.json text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-plugin-desc-'));
  const profileDir = join(dir, 'profiles', 'desktop');
  process.env.DSH_HOME = dir;
  try {
    mkdirSync(join(profileDir, 'node_modules', '@ash-qw', 'dsh-theme-prts'), { recursive: true });
    mkdirSync(join(profileDir, 'node_modules', 'acme-en-only'), { recursive: true });
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dependencies: { '@ash-qw/dsh-theme-prts': '2.4.0', 'acme-en-only': '1.0.0' },
      dsh: { profile: { bundles: ['@ash-qw/dsh-theme-prts'] } },
    }), 'utf8');
    writeFileSync(join(profileDir, 'node_modules', '@ash-qw', 'dsh-theme-prts', 'package.json'), JSON.stringify({
      name: '@ash-qw/dsh-theme-prts', version: '2.4.0', description: 'Unofficial Arknights theme',
    }), 'utf8');
    writeFileSync(join(profileDir, 'node_modules', 'acme-en-only', 'package.json'), JSON.stringify({
      name: 'acme-en-only', version: '1.0.0', description: 'Only an English description',
    }), 'utf8');

    const inventory = getLocalDshPluginInventory();
    // 命中中文覆盖表：展示中文，英文原文不出现。
    const theme = inventory.find((plugin) => plugin.package === '@ash-qw/dsh-theme-prts');
    assert.match(theme.description, /明日方舟/);
    assert.equal(theme.enabled, true);
    // 没有覆盖条目的插件仍回退到 package.json 原文，不留空。
    const enOnly = inventory.find((plugin) => plugin.package === 'acme-en-only');
    assert.equal(enOnly.description, 'Only an English description');
    assert.equal(enOnly.enabled, false);
  } finally {
    delete process.env.DSH_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local plugin promote writes the cloud manifest while this machine keeps its own selection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-cloud-plugin-'));
  const profileDir = join(dir, 'profiles', 'desktop');
  const localHost = hostname();
  // 云清单必须隔离：否则 promote 会写进仓库里的真实 manifest.cloud.json。
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = join(dir, 'manifest.cloud.json');
  process.env.DSH_HOME = dir;
  try {
    writeFileSync(process.env.DSH_AU_CLOUD_MANIFEST_PATH, `${JSON.stringify(cloudManifestFixture({ plugins: {} }), null, 2)}\n`, 'utf8');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dependencies: { 'local-only-plugin': '2.0.0' },
      dsh: { profile: { bundles: [] } },
    }), 'utf8');

    const promoted = promoteLocalDshPluginToCloud('local-only-plugin', localHost);
    assert.deepEqual(promoted, {
      id: 'local-only-plugin', name: 'local-only-plugin', package: 'local-only-plugin', source: 'npm', version: '2.0.0', restartRequired: true,
    });
    // 定义落进云清单；这台电脑是否启用由 profile 的 bundles 决定。
    const cloudManifest = JSON.parse(readFileSync(process.env.DSH_AU_CLOUD_MANIFEST_PATH, 'utf8'));
    assert.equal(cloudManifest.plugins['local-only-plugin'].package, 'local-only-plugin');
    assert.equal(getLocalDshPluginInventory()[0].cloudManaged, true);
    assert.equal(getLocalDshPluginInventory()[0].selectedForCurrentMachine, false);
    assert.deepEqual(getMachineDshPluginIds(localHost), []);

    // 本机启用后即视为「已接入」；取消启用只影响本机，云清单定义仍然在。
    const packageJson = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
    packageJson.dsh.profile.bundles = ['local-only-plugin'];
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify(packageJson), 'utf8');
    assert.deepEqual(getMachineDshPluginIds(localHost), ['local-only-plugin']);
    assert.equal(getLocalDshPluginInventory()[0].selectedForCurrentMachine, true);

    packageJson.dsh.profile.bundles = [];
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify(packageJson), 'utf8');
    assert.deepEqual(getMachineDshPluginIds(localHost), []);
    assert.equal(getSharedDshPlugins().some((plugin) => plugin.id === 'local-only-plugin'), true);
  } finally {
    delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    delete process.env.DSH_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('completed session keeps blue confirmation state until shared tracker confirms it', () => {
  let agents = [];
  const tracker = createStatusTracker(() => ({ list: () => agents }));
  assert.deepEqual(tracker.getSnapshot(), {
    status: 'idle', statusV2: 'idle', runningCount: 0, waitingCount: 0, sessions: {}, sessionsV2: {}, stateVersion: 2,
    sessionsDetails: {}, sessionStateVersion: 1,
  });

  agents = [{ id: 'a1', status: 'running' }];
  assert.equal(tracker.getSnapshot().status, 'busy');
  assert.equal(tracker.getSessionStatus('a1'), 'busy');

  // 官方 AgentStatus 只有 idle | running；没有事件可用时，由 running → idle 推断一次完成。
  agents = [{ id: 'a1', status: 'idle' }];
  assert.equal(tracker.getSnapshot().status, 'done');
  assert.equal(tracker.getSessionStatus('a1'), 'done');

  assert.equal(tracker.confirm('a1'), true);
  assert.equal(tracker.getSessionStatus('a1'), 'idle');
});

test('conversation summaries use session title events and latest activity instead of creation time', async () => {
  const createdAt = 1_000;
  const latestAt = 9_000;
  const ctx = {
    get: (key) => ({
      sessionQuery: {
        listSessions: async () => [{ header: { id: 's1', createdAt, cwd: 'F:/project' } }],
        readTitleSnapshots: async () => [],
        observeSession: async () => ({ events: [
          { type: 'session/title', time: 2_000, data: { title: '实现跨设备 Todo' } },
          { type: 'assistant/message', time: latestAt, data: { message: { content: [{ type: 'text', text: '已完成 UI 修复' }] } } },
        ] }),
      },
      workspaceRegistry: { archivedSessionIds: [], list: () => [{ title: 'DemoApp', sessionIds: ['s1'] }] },
    })[key],
  };
  const cards = await listConversationSummaries(ctx, { getSessionStatus: () => 'done' });
  assert.deepEqual(cards, [{
    sessionId: 's1', title: '实现跨设备 Todo', summary: '已完成 UI 修复', workspace: 'DemoApp',
    updatedAt: latestAt, cwd: 'F:/project', status: 'done',
  }]);
});

test('remote-proxy-pool injects Basic Auth, strips iframe blockers, replays cookies, and upgrades WS', async () => {
  const expectedAuth = `Basic ${Buffer.from('admin:pass123').toString('base64')}`;
  let remoteStatus = 'busy';
  const upstream = http.createServer((req, res) => {
    if (req.headers.authorization !== expectedAuth) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="DSH"', 'x-frame-options': 'DENY' });
      res.end('unauthorized');
      return;
    }
    if (req.url === '/dsh-au/api') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, self: { status: remoteStatus, runningCount: remoteStatus === 'busy' ? 2 : 0 } }));
      return;
    }
    if (req.url === '/login') {
      res.writeHead(200, { 'set-cookie': 'dsh_token=abc999; Path=/; HttpOnly; SameSite=Strict; Secure' });
      res.end('logged_in');
      return;
    }
    res.writeHead(200, { 'x-frame-options': 'SAMEORIGIN' });
    res.end(`cookie:${req.headers.cookie || ''}|sec:${req.headers['sec-fetch-site']}`);
  });
  upstream.on('upgrade', (req, socket) => {
    if (req.headers.authorization !== expectedAuth) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(`echo:${d.toString()}`));
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;

  const pool = createRemoteProxyPool();
  try {
    const noAuth = { id: 'r1', name: 'Mac', url: `http://127.0.0.1:${upPort}/`, username: '', password: '' };
    await pool.probeAll([noAuth]);
    let view = (await pool.syncRemotes([noAuth]))[0];
    assert.equal(view.status, 'needs_auth');

    const unauthRes = await httpGet(view.proxyUrl);
    assert.equal(unauthRes.status, 401);
    assert.equal(unauthRes.headers['www-authenticate'], undefined);
    assert.equal(unauthRes.headers['x-frame-options'], undefined);

    const missingPassword = { ...noAuth, username: 'admin', password: '' };
     await pool.probeAll([missingPassword]);
     view = (await pool.syncRemotes([missingPassword]))[0];
     assert.equal(view.status, 'needs_auth');

     const withAuth = { ...noAuth, username: 'admin', password: 'pass123' };
    await pool.probeAll([withAuth]);
    view = (await pool.syncRemotes([withAuth]))[0];
    assert.equal(view.status, 'busy');
    assert.equal(view.runningCount, 2);

    remoteStatus = 'error';
    await pool.probeAll([withAuth]);
    view = (await pool.syncRemotes([withAuth]))[0];
    assert.equal(view.status, 'error');

    await httpGet(`${view.proxyUrl}login`);
    const apiRes = await httpGet(`${view.proxyUrl}api/test`);
    assert.equal(apiRes.status, 200);
    assert.match(apiRes.body, /cookie:dsh_token=abc999\|sec:same-origin/);

    const wsEcho = await new Promise((resolve, reject) => {
      const req = http.request(`${view.proxyUrl}ws`, { headers: { Connection: 'Upgrade', Upgrade: 'websocket' } });
      req.on('upgrade', (_res, sock) => {
        sock.once('data', (chunk) => { sock.destroy(); resolve(chunk.toString()); });
        sock.write('hello_dsh');
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(wsEcho, 'echo:hello_dsh');
  } finally {
    pool.stopAll();
    upstream.closeAllConnections?.();
    upstream.close();
  }
});

test('remote-proxy-pool reads remote identity and ignores status-path auth failures when homepage auth succeeds', async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === '/dsh/dsh-au/api') {
      // 子路径状态接口受反向代理规则限制，不应覆盖首页已验证的登录状态。
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.url === '/dsh-au/api') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, self: { instanceId: 'host_remote', hostname: 'Remote Host', ips: ['192.0.2.8'], status: 'done', runningCount: 0 } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('dsh homepage');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const port = upstream.address().port;
  const pool = createRemoteProxyPool();
  try {
    const remote = { id: 'nested', name: 'Nested', url: `http://127.0.0.1:${port}/dsh/`, username: '', password: '' };
    await pool.probeAll([remote]);
    let view = (await pool.syncRemotes([remote]))[0];
    assert.equal(view.status, 'done');
    assert.equal(view.runningCount, 0);
    assert.equal(view.instanceId, 'host_remote');
    assert.equal(view.hostname, 'Remote Host');
    assert.deepEqual(view.ips, ['192.0.2.8']);

    // 状态 API 移除后，首页仍可用但不能把“未知”伪装成“空闲”。
    upstream.removeAllListeners('request');
    upstream.on('request', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('dsh homepage');
    });
    await pool.probeAll([remote]);
    view = (await pool.syncRemotes([remote]))[0];
    assert.equal(view.status, 'unknown');
  } finally {
    pool.stopAll();
    upstream.closeAllConnections?.();
    upstream.close();
  }
});

test('incident: verified identity survives a later VPN-gated unavailable response', async () => {
  let allowCredentials = true;
  const upstream = http.createServer((_req, res) => {
    if (!allowCredentials) {
      res.writeHead(401);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, self: { instanceId: 'same-mac', hostname: 'Mac.local', ips: ['192.0.2.38'], status: 'idle' } }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const remote = { id: 'mac', name: 'example-mac', url: `http://127.0.0.1:${upstream.address().port}/`, username: 'user', password: 'old-password' };
  let persistedIdentity = null;
  const pool = createRemoteProxyPool({ onRemoteIdentity: (_id, identity) => { persistedIdentity = identity; } });
  try {
    await pool.probeAll([remote]);
    assert.deepEqual(remote.knownIdentity, { instanceId: 'same-mac', hostname: 'Mac.local', ips: ['192.0.2.38'] });
    assert.deepEqual(persistedIdentity, remote.knownIdentity);

    allowCredentials = false;
    await pool.probeAll([remote]);
    const view = (await pool.syncRemotes([remote]))[0];
    assert.equal(view.status, 'offline');
    assert.equal(view.accessReason, 'upstream_denied');
    assert.equal(view.instanceId, 'same-mac');
    assert.deepEqual(view.ips, ['192.0.2.38']);
  } finally {
    pool.stopAll();
    upstream.closeAllConnections?.();
    upstream.close();
  }
});

test('remote-proxy-pool preserves subpath prefix (/dsh/), caches static bundles, and blocks // open-proxy', async () => {
  let assetHits = 0;
  const upstream = http.createServer((req, res) => {
    if (!req.url?.startsWith('/dsh/')) {
      res.writeHead(401, { 'content-length': '0' });
      res.end();
      return;
    }
    if (req.url === '/dsh/assets/index.js') {
      assetHits += 1;
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(`bundle_v${assetHits}`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`subpath_ok:${req.url}`);
  });
  upstream.on('upgrade', (req, socket) => {
    if (req.url !== '/dsh/api/remote.mux') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(`mux:${d.toString()}`));
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;

  const pool = createRemoteProxyPool();
  try {
    const remote = { id: 'example-mac', name: 'example-mac', url: `http://127.0.0.1:${upPort}/dsh/`, username: '', password: '' };
    const view = (await pool.syncRemotes([remote]))[0];
    assert.match(view.proxyUrl, /\/dsh\/$/);

    const originRoot = new URL('/', view.proxyUrl).href;
    const rootRes = await httpGet(originRoot);
    assert.equal(rootRes.status, 200);
    assert.equal(rootRes.body, 'subpath_ok:/dsh/');

    const subRes = await httpGet(view.proxyUrl);
    assert.equal(subRes.status, 200);
    assert.equal(subRes.body, 'subpath_ok:/dsh/');

    // 验证静态资源自动补齐 /dsh/ 且第二次请求命中本机内存缓存
    const js1 = await httpGet(`${originRoot}assets/index.js`);
    const js2 = await httpGet(`${originRoot}assets/index.js`);
    assert.equal(js1.body, 'bundle_v1');
    assert.equal(js2.body, 'bundle_v1');
    assert.equal(assetHits, 1);

    // 验证 //evil.com 开头路径被 400 拒绝，不触发外部开放代理
    const ssrfGuard = await httpGet(`${originRoot}//evil.example.com/pwn`);
    assert.equal(ssrfGuard.status, 400);

    // 验证子路径下 WebSocket Upgrade 正确落到 /dsh/api/remote.mux
    const wsMux = await new Promise((resolve, reject) => {
      const req = http.request(`${originRoot}api/remote.mux`, { headers: { Connection: 'Upgrade', Upgrade: 'websocket' } });
      req.on('upgrade', (_res, sock) => {
        sock.once('data', (chunk) => { sock.destroy(); resolve(chunk.toString()); });
        sock.write('ping');
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(wsMux, 'mux:ping');
  } finally {
    pool.stopAll();
    upstream.closeAllConnections?.();
    upstream.close();
  }
});

test('lan-bridge exchanges local launch token cookie and respects lanShareEnabled switch', async () => {
  const mockLocalDsh = http.createServer((req, res) => {
    if (req.url === '/?token=launch_xyz') {
      res.writeHead(302, { 'set-cookie': 'browser_session=valid_1; SameSite=Strict' });
      res.end();
      return;
    }
    res.writeHead(200);
    res.end(`local_dsh:${req.headers.cookie || 'none'}`);
  });
  await new Promise((r) => mockLocalDsh.listen(0, '127.0.0.1', r));
  const dshPort = mockLocalDsh.address().port;

  let shareEnabled = true;
  const bridge = createLanBridge({
    instanceId: 'au_test1',
    preferredPort: 32990,
    getLanShareEnabled: () => shareEnabled,
    getLocalDshTarget: () => ({
      origin: `http://127.0.0.1:${dshPort}`,
      authUrl: `http://127.0.0.1:${dshPort}/?token=launch_xyz`,
    }),
    getStatus: () => ({ status: 'busy', runningCount: 2 }),
    getDeviceId: () => 'win',
  });

  const bridgePort = await bridge.start();
  try {
    const ping = await httpGet(`http://127.0.0.1:${bridgePort}/__dsh_au_ping`);
    assert.equal(ping.status, 200);
    const pingBody = JSON.parse(ping.body);
    assert.equal(pingBody.status, 'busy');
    assert.equal(pingBody.deviceId, 'win');
    assert.equal(pingBody.bridgePort, bridgePort);

    const page = await httpGet(`http://127.0.0.1:${bridgePort}/chat`);
    assert.equal(page.status, 200);
    assert.equal(page.body, 'local_dsh:browser_session=valid_1');

    // 跳转接口会带出已保存的远端凭据，任何写法都不能经桥接访问。
    for (const blockedPath of ['/dsh-au/connect', '//dsh-au//connect/', '/dsh/DSH-AU/Connect', '/dsh-au/%63onnect', '/dsh-au/connect?x=1', '/dsh-au/%E0%A4%A']) {
      const denied = await httpGet(`http://127.0.0.1:${bridgePort}${blockedPath}`);
      assert.equal(denied.status, 403, blockedPath);
      assert.doesNotMatch(denied.body, /local_dsh/, blockedPath);
    }

    shareEnabled = false;
    const blocked = await httpGet(`http://127.0.0.1:${bridgePort}/chat`);
    assert.equal(blocked.status, 403);
  } finally {
    bridge.stop();
    mockLocalDsh.closeAllConnections?.();
    mockLocalDsh.close();
  }
});

test('旧本机服务档不再接入服务，后台服务退出保护仍生效', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-svc-'));
  process.env.DSH_AU_CONFIG_PATH = join(dir, 'dsh-au.config.json');
  process.env.DSH_AU_STARTUP_DIR = join(dir, 'startup');
  try {
    const cfg = loadConfig();
    // 没有本机绑定 JSON 就没有可写开关的地方：直接报错，不再回落写旧配置名单。
    assert.throws(() => updateMachineServiceProfile(cfg, 'Machine-A', {
      enabled: ['dsh_bridge', 'antigravity', 'proxy', 'svc_files', 'svc_mount'],
      autoStartOnBoot: ['dsh_bridge', 'antigravity'],
      autoStartOnDsh: ['dsh_bridge', 'proxy'],
    }), /本机绑定文件不存在/);
    assert.throws(() => updateMachineServiceProfile(cfg, 'Machine-B', {
      enabled: ['antigravity', 'proxy'],
      autoStartOnBoot: [],
      autoStartOnDsh: ['antigravity'],
    }), /本机绑定文件不存在/);

    const reloaded = loadConfig();
    assert.deepEqual(getMachineServiceProfile(reloaded, 'Machine-A').enabled, []);
    assert.deepEqual(getMachineServiceProfile(reloaded, 'Machine-B').enabled, []);

    // 验证开机自启动脚本按当前电脑启用项同步写入与清理
     const macSync = await syncBootStartupEntry('Example-Mac.local', {
       enabled: ['cursor_workers', 'proxy', 'svc_ipv6_entry'],
       autoStartOnBoot: ['cursor_workers', 'proxy', 'svc_ipv6_entry'],
     }, 'darwin');
     assert.equal(macSync.synced, true);
     assert.deepEqual(macSync.activeServices, []);
     assert.deepEqual(macSync.skippedServices, ['cursor_workers', 'proxy', 'svc_ipv6_entry']);
     assert.equal(existsSync(macSync.filePath), false);
     assert.equal(macSync.launchdSync, null);
    const syncA = await syncBootStartupEntry('Machine-A', getMachineServiceProfile(reloaded, 'Machine-A'), 'win32');
    assert.equal(syncA.synced, true);
    assert.deepEqual(syncA.activeServices, []);

    const syncB = await syncBootStartupEntry('Machine-B', getMachineServiceProfile(reloaded, 'Machine-B'), 'win32');
    assert.equal(syncB.synced, true);
    assert.deepEqual(syncB.activeServices, []);

    // 内建目录已清空：服务由 machines JSON 驱动。通用控制策略用临时夹具覆盖。
    assert.equal(SERVICES_CATALOG.length, 0);
    const startOnly = { id: 'shared_dep', name: 'Shared', control: 'start-only' };
    const fullControl = { id: 'script_svc', name: 'Script', control: 'full' };
    const needsDevice = { id: 'cast_svc', name: 'Cast', control: 'full', needsDevice: true };
    assert.equal(validateServiceControlRequest('shared_dep', 'stop', { entry: startOnly }).ok, false);
    assert.equal(validateServiceControlRequest('script_svc', 'restart', { entry: fullControl }).ok, true);
    assert.equal(validateServiceControlRequest('cast_svc', 'start', { entry: needsDevice }).ok, false);
    assert.equal(validateServiceControlRequest('cast_svc', 'start', { entry: needsDevice, device: 'DEV001' }).ok, true);

    // 验证插件卸载钩子 (dispose) 绝不停止任何后台服务，且前端已接入统一菜单与后台服务入口
    const serverSrc = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
    // Multiple independent effects now exist; inspect the service lifecycle cleanup, not every later route.
    const disposeStart = serverSrc.lastIndexOf('hostCtx.effect(() => () => {');
    assert.ok(disposeStart >= 0, 'service lifecycle cleanup must exist');
    const disposeBlock = serverSrc.slice(disposeStart);
    assert.doesNotMatch(disposeBlock, /bgServices\.(controlService|stop)/);
    const clientSrc = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
    assert.match(clientSrc, /function UnifiedWorkbenchModal/);
    assert.match(clientSrc, /function CommandMenuIcon\(\)/);
    assert.match(clientSrc, /function ServicesIcon\(\)/);
    assert.match(clientSrc, /function buildManualDeviceViews\(self, definitions, remotes, accessTransport = 'local'\)/);
    assert.doesNotMatch(clientSrc, /function mergeSameHostDevices|function isSamePhysicalMachine/);
    assert.match(clientSrc, /getRouteTransportRank/);
    // 弹窗按整页比例收一半；手机端整屏，两个断点都必须存在，避免改小后挤压三栏。
    assert.match(clientSrc, /width:min\(1056px,78vw\); height:min\(684px,88dvh\).*font-size:13.3px/);
    assert.match(clientSrc, /@media \(max-width:1024px\)/);
    assert.match(clientSrc, /@media \(max-width:720px\)/);
    assert.match(clientSrc, /grid-template-columns:190px 1fr 330px/);
    // 本机服务只认当前机器绑定 JSON：已接入但已停止仍展示，运行中但未登记的不展示。
    assert.match(clientSrc, /const localServices = services\.filter\(\(svc\) => localBindingServiceIds\.includes\(svc\.id\)\);/);
    assert.doesNotMatch(clientSrc, /Boolean\(svc\.running\) \|\| \(currentEnabled/);
    // 标题里的「运行中」单独计数，不能拿列表长度冒充运行数量。
    assert.match(clientSrc, /本机服务 · 运行中 \$\{runningCount\}\/\$\{localServices\.length\} 项/);
    assert.match(clientSrc, /\.dsh-au-wb-card\.selected \{ border-color:#3b82f6; background:rgba\(59,130,246,\.16\)/);
    assert.match(clientSrc, /\.dsh-au-wb-navbtn\.active \{ background:rgba\(59,130,246,\.18\); border-color:#3b82f6/);
    assert.match(clientSrc, /const compactArtifactText =/);
    assert.match(clientSrc, /className: 'dsh-au-result-grid'/);
    assert.match(clientSrc, /📋 复制日志/);
    assert.match(clientSrc, /const sliceLatestRunLogs =/);
    assert.match(clientSrc, /const parseQuotaSections =/);
    const bgSrc = readFileSync(new URL('../lib/background-services.js', import.meta.url), 'utf8');
    assert.match(bgSrc, /export async function probeServiceEndpointAlive/);
    assert.match(bgSrc, /function canControlService\(serviceId\)/);
    assert.doesNotMatch(bgSrc, /WINDOWS_AUWIN_CONTROL_IDS/);
    assert.doesNotMatch(bgSrc, /MACOS_BOOT_CONTROL_IDS/);
    assert.match(bgSrc, /MACOS_LAUNCHD_BOOT_IDS = new Set\(\['cloudflared'\]\)/);
    assert.match(bgSrc, /MACOS_USER_LAUNCHD_CONTROLS = \{/);
    assert.match(bgSrc, /function bindingPrefersAuWin/);
    assert.match(bgSrc, /async function settleControlResult/);
    assert.match(bgSrc, /启动后仍未运行/);
    assert.match(clientSrc, /开机自启未写入系统 LaunchDaemon/);
    assert.match(serverSrc, /await syncBootStartupEntry/);
    assert.match(bgSrc, /list_managed_worker_pids/);
    assert.match(bgSrc, /venv', 'bin', 'python3/);
    assert.match(bgSrc, /WIN_HEADLESS_POPEN_PATCH/);
    assert.doesNotMatch(bgSrc, /detached:\s*true/);
    const runnerSrc = readFileSync(new URL('../lib/menu-runner.js', import.meta.url), 'utf8');
    assert.match(runnerSrc, /\/\/ 每次执行命令前先清空上一轮日志\s*logs = \[\];/);
    // 回归：Windows 图形宿主必须经 cmd start 新建可见系统终端，不能直接脱离启动 powershell.exe。
    assert.match(runnerSrc, /spawn\('cmd\.exe', \[\s*'\/d',\s*'\/c',\s*'start'/);
    assert.match(runnerSrc, /buildWindowsTerminalCountdownScript\(built, item\.readonly === true\)/);
  } finally {
    delete process.env.DSH_AU_CONFIG_PATH;
    delete process.env.DSH_AU_STARTUP_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('动态端口服务按宿主真实端口探活，清除后回落 JSON 登记值', async () => {
  const { applyRuntimeServicePort, setRuntimeServicePort } = await import('../lib/background-services.js');
  const registered = { id: 'dsh_next', port: 9353, health: 'http://127.0.0.1:9353/' };
  setRuntimeServicePort('dsh_next', 9491);
  try {
    const live = applyRuntimeServicePort(registered);
    assert.equal(live.port, 9491);
    assert.equal(live.health, 'http://127.0.0.1:9491/');
    // 只覆盖登记过运行期端口的服务，其他服务不受影响。
    assert.equal(applyRuntimeServicePort({ id: 'dsh_bridge', port: 3080 }).port, 3080);
  } finally {
    setRuntimeServicePort('dsh_next', null);
  }
  assert.equal(applyRuntimeServicePort(registered).port, 9353);
});

test('Windows never exposes an unregistered AuWin service as controllable', { skip: process.platform !== 'win32' }, () => {
  const capability = serviceControlCapability('svc_header_proxy');
  assert.equal(capability.canControl, false);
  assert.match(capability.controlReason, /未记录可执行 scriptPath/);
});

test('cursor_workers match agent process and host prefix', async () => {
  const cfg = {
    machines: {
      'Example-Mac': { prefix: 'x3' },
      MyHost: { prefix: 'x1' },
    },
  };
  assert.equal(resolveCursorWorkerPrefix(cfg, ['Example-Mac.local']), 'x3');
  assert.equal(isManagedCursorWorkerCommand(
    '/Users/me/.local/bin/agent --use-system-ca index.js worker --name x3-WorkerApp --worker-dir /tmp/WorkerApp start',
    'x3',
  ), true);
  assert.equal(isManagedCursorWorkerCommand(
    '/Users/me/.local/bin/agent worker --name x3-WorkerApp debug start',
    'x3',
  ), false);
  assert.equal(isManagedCursorWorkerCommand(
    '/Users/me/.local/bin/agent worker --name x1-SampleHost start',
    'x3',
  ), false);
  assert.equal(await probeCursorWorkersAlive({
    prefix: 'x3',
    commands: [
      '/Users/me/.local/bin/agent worker --name x3-DemoApp start',
      '/usr/bin/node some-other-job',
    ],
  }), true);
  assert.equal(await probeCursorWorkersAlive({
    prefix: 'x3',
    commands: ['/Users/me/.local/bin/agent worker --name x1-SampleHost start'],
  }), false);
  const listed = await listCursorWorkerInstances({
    prefix: 'x3',
    commands: ['/Users/me/.local/bin/agent worker --name x3-WorkerApp start'],
  });
  assert.deepEqual(listed.map((item) => item.name), ['x3-WorkerApp']);

  // Windows 上受限 Python 看不到 node.exe 时，CIM 快照仍必须正确识别本机 Worker。
  assert.deepEqual(cursorWorkerInstancesFromNodeProcesses([
    { pid: 41, commandLine: 'C:\\Cursor\\node.exe C:\\Cursor\\index.js worker --name x3-WorkerApp start' },
    { pid: 42, commandLine: 'C:\\Cursor\\node.exe C:\\Cursor\\index.js worker --name x1-SampleHost start' },
  ], 'x3'), [{ pid: 41, name: 'x3-WorkerApp' }]);
  const remoteCommand = 'C:\\node.exe C:\\Users\\me\\node_modules\\@wonderwhy-er\\desktop-commander\\dist\\index.js remote';
  assert.equal(isManagedRemoteDesktopCommand(remoteCommand), true);
  assert.deepEqual(remoteDesktopInstancesFromNodeProcesses([{ pid: 51, commandLine: remoteCommand }]), [{ pid: 51 }]);
});

test('cloudflared matches tunnel run and stops for admin', async () => {
  assert.equal(isManagedCloudflaredCommand('/opt/homebrew/bin/cloudflared tunnel run --protocol http2 --token-file /tmp/token'), true);
  assert.equal(isManagedCloudflaredCommand('/opt/homebrew/bin/cloudflared tunnel list'), false);
  assert.equal(isManagedCloudflaredCommand('brew services start cloudflared'), false);
  assert.equal(await probeCloudflaredAlive({
    commands: ['/opt/homebrew/bin/cloudflared tunnel run --token-file /tmp/token'],
  }), true);
  assert.equal(await probeCloudflaredAlive({
    commands: ['/opt/homebrew/bin/cloudflared tunnel list'],
  }), false);
  const listed = await listCloudflaredInstances({
    commands: ['/opt/homebrew/bin/cloudflared tunnel run --protocol http2'],
  });
  assert.equal(listed.length, 1);
  const skipped = await controlCloudflaredService('start', {
    listInstances: async () => [{ pid: 25645, command: 'cloudflared tunnel run' }],
    runLaunchctl: async () => ({ ok: true }),
  });
  assert.equal(skipped.skipped, true);
  let listCalls = 0;
  const started = await controlCloudflaredService('start', {
    listInstances: async () => {
      listCalls += 1;
      return listCalls === 1 ? [] : [{ pid: 9, command: 'cloudflared tunnel run' }];
    },
    runLaunchctl: async () => ({ ok: true }),
  });
  assert.equal(started.ok, true);
  assert.equal(started.skipped, undefined);
  const needsAdmin = await controlCloudflaredService('start', {
    listInstances: async () => [],
    runLaunchctl: async () => ({ ok: false, needsAdmin: true, error: 'not privileged' }),
  });
  assert.equal(needsAdmin.ok, false);
  assert.equal(needsAdmin.needsAdmin, true);
  assert.equal(needsAdmin.error, CLOUDFLARED_ADMIN_REQUIRED);
  assert.equal(validateServiceControlRequest('cloudflared', 'start', { entry: { id: 'cloudflared', name: 'cloudflared', control: 'full' } }).ok, true);
});

test('cloudflared boot flag syncs official LaunchDaemon not user plist', async () => {
  const loaded = await syncCloudflaredBootDaemon(true, {
    runLaunchctl: async (action) => (action === 'print' ? { ok: true } : { ok: false, error: 'should not bootstrap' }),
  });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.loaded, true);

  const bootstrapped = await syncCloudflaredBootDaemon(true, {
    runLaunchctl: async (action) => (action === 'print'
      ? { ok: false, missing: true, error: 'Could not find service' }
      : { ok: true }),
  });
  assert.equal(bootstrapped.ok, true);
  assert.equal(bootstrapped.loaded, true);

  const needsAdmin = await syncCloudflaredBootDaemon(true, {
    runLaunchctl: async (action) => (action === 'print'
      ? { ok: false, missing: true, error: 'Could not find service' }
      : { ok: false, needsAdmin: true, error: 'not privileged' }),
  });
  assert.equal(needsAdmin.ok, false);
  assert.equal(needsAdmin.needsAdmin, true);
  assert.equal(needsAdmin.error, CLOUDFLARED_BOOT_ADMIN_REQUIRED);

  const alreadyOff = await syncCloudflaredBootDaemon(false, {
    runLaunchctl: async () => ({ ok: false, missing: true, error: 'Could not find service "com.cloudflare.cloudflared" in domain for system' }),
  });
  assert.equal(alreadyOff.ok, true);
  assert.equal(alreadyOff.loaded, false);

  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-cf-boot-'));
  process.env.DSH_AU_STARTUP_DIR = join(dir, 'startup');
  try {
    const synced = await syncBootStartupEntry('Example-Mac.local', {
      enabled: ['cloudflared', 'cursor_workers'],
      autoStartOnBoot: ['cloudflared', 'cursor_workers'],
    }, 'darwin', {
      runLaunchctl: async (action) => (action === 'print'
        ? { ok: false, missing: true, error: 'Could not find service' }
        : { ok: true }),
    });
    assert.equal(synced.synced, true);
    assert.deepEqual(synced.activeServices, []);
    assert.deepEqual(synced.skippedServices, ['cursor_workers']);
    assert.equal(synced.launchdSync.cloudflared.ok, true);
    assert.equal(synced.launchdSync.cloudflared.wanted, true);
    assert.equal(existsSync(synced.filePath), false);
  } finally {
    delete process.env.DSH_AU_STARTUP_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Mac user LaunchAgents control running local services', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-mac-agents-'));
  const bindings = {
    dsh_bridge: { scriptPath: 'desktop_web_bridge.mjs', launcher: { label: 'com.example.web-bridge' } },
    antigravity: { scriptPath: 'antigravity-gateway/server.py', launcher: { label: 'com.example.antigravity-gateway' } },
    proxy: { launcher: { label: 'com.example.dsh-au.proxy' } },
    svc_ipv6_entry: { scriptPath: 'TCP6-LISTEN:8443', launcher: { label: 'com.example.socat-ipv6' } },
    shared_dep: { control: 'start-only', name: 'Shared' },
  };
  writeFileSync(join(dir, 'com.example.web-bridge.plist'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist><dict>',
    '<key>Label</key><string>com.example.web-bridge</string>',
    '<string>desktop_web_bridge.mjs</string>',
    '</dict></plist>',
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'com.example.antigravity-gateway.plist'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist><dict>',
    '<key>Label</key><string>com.example.antigravity-gateway</string>',
    '<string>antigravity-gateway/server.py</string>',
    '</dict></plist>',
    '',
  ].join('\n'));
  const bridge = resolveMacUserLaunchdTarget('dsh_bridge', { launchAgentsDir: dir, bindings });
  assert.equal(bridge.ok, true);
  assert.equal(bridge.label, 'com.example.web-bridge');
  assert.equal(bridge.discovered, true);
  const gravity = resolveMacUserLaunchdTarget('antigravity', { launchAgentsDir: dir, bindings });
  assert.equal(gravity.label, 'com.example.antigravity-gateway');
  const proxy = resolveMacUserLaunchdTarget('proxy', { launchAgentsDir: dir, bindings });
  assert.equal(proxy.discovered, false);
  assert.equal(proxy.label, 'com.example.dsh-au.proxy');
  assert.equal(MACOS_USER_LAUNCHD_CONTROLS.svc_files, undefined);
  // 进程特征来自本机绑定，开源代码不再内置任何具体端口。
  assert.equal(matchesProcessPattern('/opt/homebrew/bin/socat -d -d TCP6-LISTEN:8443,bind=[::],ipv6only=1,fork,reuseaddr TCP4:127.0.0.1:8443', 'TCP6-LISTEN:8443'), true);
  assert.equal(matchesProcessPattern('/opt/homebrew/bin/socat TCP6-LISTEN:9119,bind=[::],ipv6only=1,fork,reuseaddr TCP4:127.0.0.1:9119', 'TCP6-LISTEN:8443'), false);
  assert.equal(matchesProcessPattern('/opt/homebrew/bin/socat TCP6-LISTEN:8443', '  '), false);
  assert.equal(applyLocalBinding({ id: 'svc_ipv6_entry' }, { svc_ipv6_entry: { processPattern: ' TCP6-LISTEN:8443 ' } }, {}).processPattern, 'TCP6-LISTEN:8443');
  assert.equal(applyLocalBinding({ id: 'svc_ipv6_entry' }, { svc_ipv6_entry: { processPattern: 42 } }, {}).processPattern, undefined);
  writeFileSync(join(dir, 'com.example.socat-ipv6.plist'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist><dict>',
    '<key>Label</key><string>com.example.socat-ipv6</string>',
    '<string>TCP6-LISTEN:8443,bind=[::],ipv6only=1,fork,reuseaddr</string>',
    '</dict></plist>',
    '',
  ].join('\n'));
  const caddy = resolveMacUserLaunchdTarget('svc_ipv6_entry', { launchAgentsDir: dir, bindings });
  assert.equal(caddy.ok, true);
  assert.equal(caddy.discovered, true);
  assert.equal(caddy.label, 'com.example.socat-ipv6');

  const started = await controlMacUserLaunchdService('dsh_bridge', 'start', {
    launchAgentsDir: dir,
    bindings,
    runLaunchctl: async (action) => (action === 'print' ? { ok: true } : { ok: false, error: 'should not kickstart' }),
  });
  assert.equal(started.ok, true);
  assert.equal(started.skipped, true);

  const actions = [];
  const restarted = await controlMacUserLaunchdService('antigravity', 'restart', {
    launchAgentsDir: dir,
    bindings,
    runLaunchctl: async (action) => {
      actions.push(action);
      return { ok: true };
    },
  });
  assert.equal(restarted.ok, true);
  assert.deepEqual(actions, ['print', 'kickstart']);

  const stopped = await controlMacUserLaunchdService('dsh_bridge', 'stop', {
    launchAgentsDir: dir,
    bindings,
    runLaunchctl: async () => ({ ok: true }),
  });
  assert.equal(stopped.ok, true);
  assert.equal(validateServiceControlRequest('shared_dep', 'stop', {
    entry: { id: 'shared_dep', name: 'Shared', control: 'start-only' },
  }).ok, false);
  rmSync(dir, { recursive: true, force: true });
});

test('machine host aliases resolve case-insensitively and Mac only lists enabled services', () => {
  assert.equal(canonicalMachineHost('Example-Mac.local'), 'Example-Mac');
  // 本机服务档里 .local 与大小写都只是别名，必须命中同一条记录。
  const cfg = {
    machineServiceProfiles: {
      'Example-Mac': { enabled: ['dsh_bridge', 'svc_files', 'svc_ipv6_entry'], autoStartOnBoot: [], autoStartOnDsh: [] },
      MyHost: { enabled: ['dsh_bridge', 'svc_ddns', 'svc_mount'], autoStartOnBoot: [], autoStartOnDsh: [] },
    },
  };
  assert.deepEqual(getMachineServiceProfile(cfg, 'example-mac.local').enabled, []);
  assert.deepEqual(getMachineServiceProfile(cfg, 'MyHost').enabled, []);
  assert.ok(Object.values(getMachineServiceProfiles(cfg)).every((profile) => profile.enabled.length === 0));

  const macEnabled = ['dsh_bridge', 'antigravity', 'proxy', 'cursor_workers', 'svc_files', 'svc_ipv6_entry'];
  const macCloudflaredEnabled = ['dsh_bridge', 'cloudflared', 'antigravity', 'proxy', 'cursor_workers', 'svc_files', 'svc_ipv6_entry'];
  assert.equal(isServiceListedForMachine({ id: 'cloudflared', platform: 'darwin' }, 'darwin', macCloudflaredEnabled), true);
  assert.equal(isServiceListedForMachine({ id: 'cloudflared', platform: 'darwin' }, 'win32', []), false);
  assert.equal(isServiceListedForMachine({ id: 'dsh_bridge' }, 'darwin', macEnabled), true);
  assert.equal(isServiceListedForMachine({ id: 'svc_ipv6_entry' }, 'darwin', macEnabled), true);
  assert.equal(isServiceListedForMachine({ id: 'svc_ddns', platform: 'win32', kind: 'windows-service' }, 'darwin', macEnabled), false);
  assert.equal(isServiceListedForMachine({ id: 'svc_mount', drive: 'Q:' }, 'darwin', macEnabled), false);
  assert.equal(isServiceListedForMachine({ id: 'svc_mount', drive: 'Q:' }, 'win32', ['svc_mount']), true);
  assert.equal(isServiceListedForMachine({ id: 'svc_mount', drive: 'Q:' }, 'win32', []), true);
  const resolved = resolveServiceConfigPath('<AuOS>/AuWin/backend/app.py');
  assert.match(resolved.replaceAll('\\', '/'), /AuWin\/backend\/app\.py$/);
  assert.doesNotMatch(resolved, /<AuOS>/);
});

test('旧本机服务档不能接入服务，云服务仍只来自云清单', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-cloud-service-'));
  const localHost = hostname();
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = join(dir, 'manifest.cloud.json');
  process.env.DSH_AU_CONFIG_PATH = join(dir, 'dsh-au.config.json');
  try {
    // 「已上云」以云清单里的服务定义为准，不再单独维护登记表。
    writeFileSync(process.env.DSH_AU_CLOUD_MANIFEST_PATH, `${JSON.stringify(cloudManifestFixture({
      services: {
        dsh_bridge: { name: 'DSH 桥接' },
        proxy: { name: '代理' },
      },
    }), null, 2)}\n`, 'utf8');
    assert.deepEqual(getSharedCloudServiceIds().sort(), ['dsh_bridge', 'proxy']);

    // 本机没有绑定 JSON：启用失败，且不写旧配置、不往云清单里加东西。
    assert.throws(() => promoteLocalServiceToCloud('cc_connect', localHost), /未知后台服务|本机绑定文件不存在/);
    assert.equal(getMachineServiceProfile(loadConfig(), localHost).enabled.includes('cc_connect'), false);
    assert.deepEqual(getSharedCloudServiceIds().sort(), ['dsh_bridge', 'proxy']);

    // 取消接入同理：失败也不动云清单定义与「已上云」列表。
    assert.throws(() => updateMachineServiceProfile(loadConfig(), localHost, {
      enabled: [], autoStartOnBoot: [], autoStartOnDsh: [],
    }), /未知后台服务|本机绑定文件不存在/);
    assert.deepEqual(getMachineServiceProfile(loadConfig(), localHost).enabled, []);
    assert.deepEqual(getSharedCloudServiceIds().sort(), ['dsh_bridge', 'proxy']);
  } finally {
    delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    delete process.env.DSH_AU_CONFIG_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyRemoteTransport distinguishes IPv6 direct / DDNS ports from Cloudflare / FRP tunnels', () => {
  assert.equal(classifyRemoteTransport('https://example-mac.example.com:8443/dsh/'), 'ipv6');
  assert.equal(classifyRemoteTransport('http://192.0.2.19:31990/', {}, '', 'lan'), 'lan');
   assert.equal(classifyRemoteTransport('https://example-mac.example.com:8443/dsh/', {}, '', 'tunnel'), 'tunnel');
  assert.equal(classifyRemoteTransport('https://[2001:db8::1]:8443/dsh/'), 'ipv6');
  assert.equal(classifyRemoteTransport('https://dsh-win.example.com/', { 'cf-ray': '89abc-HKG' }), 'tunnel');
  assert.equal(classifyRemoteTransport('https://dsh.example.com/'), 'tunnel');
});

test('external device handoff keeps the route whitelist and Basic Auth password on the server', () => {
  const host = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.match(host, /path: '\/dsh-au\/connect'/);
  assert.match(host, /const remote = cfg\.remotes\.find\(\(item\) => item\.id === remoteId\)/);
  assert.match(host, /function buildAuthenticatedRemoteUrl\(remote\)/);
  assert.match(host, /target\.password = remote\.password \|\| ''/);
  assert.match(host, /res\.writeHead\(303, \{ location: buildAuthenticatedRemoteUrl\(remote\)/);
  assert.match(host, /currentMachineDshPluginIds: getMachineDshPluginIds\(hostname\)/);
  assert.match(host, /currentMachineDshPluginIds: selectedIds/);
  assert.match(host, /currentMachineProfile: getMachineServiceProfile\(cfg, hostname\)/);
  assert.match(host, /machineServiceProfiles: getMachineServiceProfiles\(cfg\)/);
});

test('already mounted local plugins skip relink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-mounted-'));
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
  try {
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    symlinkSync(join(repoRoot, 'dsh-au'), join(dir, 'node_modules', 'dsh-au'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(isLocalPluginAlreadyMounted(dir, { package: 'dsh-au' }), true);
    assert.equal(isLocalPluginAlreadyMounted(dir, { package: 'missing-plugin' }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing pnpm never bootstraps an unpinned npm exec version', () => {
  assert.equal(buildPnpmInvocation('', 'npm.cmd'), null);
  assert.equal(buildPnpmInvocation('', 'npm.cmd', 'https://packages.example.test/npm'), null);
  // 环境发现的真实运行时兼容与空格路径回归由 plugin-runtime.test.mjs 覆盖，不能依赖测试机已装 pnpm。
});

test('npm cloud plugins pin the public registry unless the manifest declares another registry', () => {
  const plugin = { package: '@weibaohui/dsh-continue', version: '0.3.11', source: 'npm' };
  assert.equal(resolveNpmRegistry(plugin), DEFAULT_NPM_REGISTRY);
  assert.equal(getNpmPackageScope(plugin.package), '@weibaohui');
  assert.equal(getNpmPackageScope('dsh-au'), '');
  assert.deepEqual(buildNpmInstallArgs(plugin), [
    'add', '--save-exact', '--registry', DEFAULT_NPM_REGISTRY,
    '--@weibaohui:registry=https://registry.npmjs.org/', '@weibaohui/dsh-continue@0.3.11',
  ]);
  assert.equal(resolveNpmRegistry({ ...plugin, registry: 'https://packages.example.test/npm' }), 'https://packages.example.test/npm');
  assert.equal(resolveNpmRegistry({ ...plugin, registry: 'file:///not-a-registry' }), DEFAULT_NPM_REGISTRY);
});

test('regression 2026-10-27: pnpm add sees local junction plugins as link: specs, then restores them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-link-spec-'));
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
  try {
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    symlinkSync(join(repoRoot, 'dsh-au'), join(dir, 'node_modules', 'dsh-au'), process.platform === 'win32' ? 'junction' : 'dir');
    mkdirSync(join(dir, 'node_modules', 'dshmarket'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-au': '0.1.0', dshmarket: '1.70.2' },
    }), 'utf8');

    const linked = findLocalLinkedDependencies(dir);
    assert.deepEqual(Object.keys(linked), ['dsh-au'], '只有软链挂载的本地插件需要 link:，真实 npm 目录不动');
    assert.match(linked['dsh-au'], /^link:.*dsh-au$/);

    let seenDuringInstall = null;
    withLocalLinkSpecs(dir, () => {
      seenDuringInstall = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies;
      // 模拟 pnpm add 回写新增插件。
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      pkg.dependencies['@weibaohui/dsh-continue'] = '0.3.11';
      writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg), 'utf8');
      return { status: 0 };
    });
    assert.match(seenDuringInstall['dsh-au'], /^link:/, 'pnpm 运行期间必须看到 link: 规格，否则会去 npm 拉 dsh-au');
    assert.equal(seenDuringInstall.dshmarket, '1.70.2');
    const after = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies;
    assert.deepEqual(after, { 'dsh-au': '0.1.0', dshmarket: '1.70.2', '@weibaohui/dsh-continue': '0.3.11' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pnpm failure summary keeps the real cause instead of the generic auth hint', () => {
  const stderr = [
    'Error: ERR_PNPM_FETCH_404',
    '  × adding a new package',
    '  ├─▶ Failed to resolve dependency tree: GET https://registry.npmjs.org/dsh-',
    '  │   au: Not Found - 404',
    '  help: dsh-au is not in the npm registry, or you have no permission to fetch',
    '        No authorization header was set for the request.',
  ].join('\n');
  const summary = summarizePnpmFailure(stderr);
  assert.match(summary, /ERR_PNPM_FETCH_404/);
  assert.match(summary, /Failed to resolve dependency tree/);
  assert.equal(summarizePnpmFailure('line a\nline b\nline c'), 'line b line c');
});

test('already installed npm plugins skip pnpm add', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-npm-'));
  try {
    mkdirSync(join(dir, 'node_modules', '@weibaohui', 'dsh-continue'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { '@weibaohui/dsh-continue': '0.3.11' },
    }), 'utf8');
    writeFileSync(join(dir, 'node_modules', '@weibaohui', 'dsh-continue', 'package.json'), JSON.stringify({
      name: '@weibaohui/dsh-continue', version: '0.3.11',
    }), 'utf8');
    assert.equal(isNpmPluginAlreadyInstalled(dir, { package: '@weibaohui/dsh-continue', version: '0.3.11' }), true);
    assert.equal(isNpmPluginAlreadyInstalled(dir, { package: '@weibaohui/dsh-continue', version: '9.9.9' }), false);
    assert.equal(isNpmPluginAlreadyInstalled(dir, { package: '@example/sample-plugin', version: '0.3.3' }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sync dry-run skips cloud plugins this machine has not enabled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-sync-skip-'));
  process.env.DSH_HOME = dir;
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = join(dir, 'manifest.cloud.json');
  try {
    writeFileSync(process.env.DSH_AU_CLOUD_MANIFEST_PATH, `${JSON.stringify(cloudManifestFixture({
      plugins: {
        'dsh-au': { name: 'DSH-au', package: 'dsh-au', source: 'local' },
        'weibaohui-dsh-continue': {
          name: 'continue', package: '@weibaohui/dsh-continue', source: 'npm', version: '0.3.11',
        },
      },
    }), null, 2)}\n`, 'utf8');
    mkdirSync(join(dir, 'profiles', 'desktop'), { recursive: true });
    // 本机 Profile 什么都没启用：名单为空，云插件一律跳过。
    writeFileSync(join(dir, 'profiles', 'desktop', 'package.json'), '{}\n', 'utf8');
    writeFileSync(join(dir, 'profiles', 'desktop', 'cordis.patch.yml'), '', 'utf8');
    const output = syncDshPlugins({ dshHome: dir, machineName: hostname(), dryRun: true });
    assert.equal(output.ok, true);
    assert.deepEqual(output.results.find((item) => item.id === 'weibaohui-dsh-continue'), {
      id: 'weibaohui-dsh-continue',
      status: 'skipped',
      reason: '当前电脑未选择',
    });
  } finally {
    delete process.env.DSH_HOME;
    delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('enabled plugin sync overwrites host-plane config without renaming the patch id', () => {
  const overlay = [
    '- id: dsh-continue',
    '  config:',
    '    prompt: "继续"',
    '    maxAttempts: 50',
    '    rules:',
    '      - id: r-status-413-compact',
    '        action: compact',
    '',
  ].join('\n');
  const stale = [
    '- id: dsh-continue',
    '  config:',
    '    prompt: old',
    '    maxAttempts: 1',
    '- id: dsh-au',
    '  disabled: false',
    '',
  ].join('\n');
  const plugin = { id: 'weibaohui-dsh-continue', package: '@weibaohui/dsh-continue' };
  assert.equal(resolvePluginPatchId(plugin, ['dsh-continue']), 'dsh-continue');
  const enabled = applyPluginPatchConfig(stale, plugin, false, overlay);
  assert.match(enabled, /- id: dsh-continue\r?\n  disabled: false\r?\n  config:\r?\n    prompt: "继续"/);
  assert.match(enabled, /maxAttempts: 50/);
  assert.match(enabled, /r-status-413-compact/);
  assert.doesNotMatch(enabled, /prompt: old/);
  assert.doesNotMatch(enabled, /- id: weibaohui-dsh-continue/);
  const disabled = applyPluginPatchConfig(stale, plugin, true, overlay);
  assert.match(disabled, /- id: dsh-continue\r?\n  disabled: true\r?\n  config:\r?\n    prompt: old/);
  assert.doesNotMatch(disabled, /maxAttempts: 50/);
});



test('端口被别的进程占着但没有 HTTP 响应时，不算该服务在跑', async () => {
  // 只接受连接、永不回包：模拟 5001 被系统进程占用的情况
  const silent = net.createServer(() => {});
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  const silentPort = silent.address().port;
  try {
    assert.equal(await probeServiceEndpointAlive({
      id: 'auwin',
      port: silentPort,
      url: `http://127.0.0.1:${silentPort}/`,
      probe: 'http',
    }), false);
  } finally {
    silent.close();
  }

  // 真回 200 的服务才算在跑
  const real = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
  await new Promise((resolve) => real.listen(0, '127.0.0.1', resolve));
  const realPort = real.address().port;
  try {
    assert.equal(await probeServiceEndpointAlive({
      id: 'auwin',
      port: realPort,
      url: `http://127.0.0.1:${realPort}/`,
      probe: 'http',
    }), true);
  } finally {
    real.close();
  }
});

test('探活地址支持数组与常见路径兜底，路径写错不会直接判停止', async () => {
  // 只对 /__health 回 200、其他路径直接断开：模拟「JSON 里把探活路径写错了」
  const picky = http.createServer((req, res) => {
    if (req.url === '/__health') { res.writeHead(200); res.end('ok'); return; }
    req.socket.destroy();
  });
  await new Promise((resolve) => picky.listen(0, '127.0.0.1', resolve));
  const port = picky.address().port;
  try {
    assert.equal(await probeHealthEndpoint(`http://127.0.0.1:${port}/wrong-health`), true);
    // 数组按书写顺序试：第一个端口没人听，第二个有响应就算活
    assert.equal(await probeHealthEndpoint([`http://127.0.0.1:1/health`, `http://127.0.0.1:${port}/__health`]), true);
  } finally {
    picky.close();
  }
  // 所有候选都连不上才算停止
  assert.equal(await probeHealthEndpoint(['http://127.0.0.1:1/health', 'http://127.0.0.1:2/health']), false);
});

test('探活候选顺序：先自己声明的地址，再补同 origin 的常见路径', () => {
  assert.deepEqual(healthProbeCandidates(''), []);
  assert.deepEqual(healthProbeCandidates(null), []);
  const list = healthProbeCandidates(['http://127.0.0.1:9001/healthz', 'http://127.0.0.1:9001/health']);
  assert.equal(list[0], 'http://127.0.0.1:9001/healthz');
  assert.equal(list[1], 'http://127.0.0.1:9001/health');
  assert.ok(list.includes('http://127.0.0.1:9001/__health'));
  assert.equal(new Set(list).size, list.length);
  // 只补同 origin，不去猜别的端口或主机
  assert.ok(list.every((url) => url.startsWith('http://127.0.0.1:9001/')));
});

test('删除云服务只摘云清单定义，本机接入与运行状态不受影响', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-remove-cloud-'));
  const configPath = join(dir, 'dsh-au.config.json');
  process.env.DSH_AU_CONFIG_PATH = configPath;
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = join(dir, 'manifest.cloud.json');
  try {
    writeFileSync(process.env.DSH_AU_CLOUD_MANIFEST_PATH, `${JSON.stringify(cloudManifestFixture({
      services: { proxy: { name: '代理' }, antigravity: { name: 'Antigravity' } },
    }), null, 2)}\n`, 'utf8');
    writeFileSync(configPath, JSON.stringify({ instanceId: 'local-only', machineServiceProfiles: {
      MyHost: { enabled: ['proxy'], autoStartOnBoot: ['proxy'], autoStartOnDsh: [] },
    } }), 'utf8');

    assert.deepEqual(getSharedCloudServiceIds().sort(), ['antigravity', 'proxy']);
    const result = removeCloudService('proxy');
    assert.equal(result.removed, true);
    // 云清单定义被摘掉，「已上云」列表随之变化；本机接入与自启勾选原样保留。
    assert.deepEqual(getSharedCloudServiceIds(), ['antigravity']);
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).machineServiceProfiles.MyHost, {
      enabled: ['proxy'], autoStartOnBoot: ['proxy'], autoStartOnDsh: [],
    });
  } finally {
    delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    delete process.env.DSH_AU_CONFIG_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('未接入本机的服务不保留自启勾选（自启是启用项的子集）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-profile-subset-'));
  process.env.DSH_AU_CLOUD_MANIFEST_PATH = join(dir, 'manifest.cloud.json');
  try {
    writeFileSync(process.env.DSH_AU_CLOUD_MANIFEST_PATH, `${JSON.stringify(cloudManifestFixture({
      services: { proxy: { name: '代理' } },
    }), null, 2)}\n`);
    const profile = normalizeMachineServiceProfile({
      enabled: ['proxy'],
      autoStartOnBoot: ['proxy', 'antigravity', 'dsh_bridge'],
      autoStartOnDsh: ['antigravity'],
    }, 'TestHost');
    assert.deepEqual(profile.enabled, ['proxy']);
    assert.deepEqual(profile.autoStartOnBoot, ['proxy']);
    assert.deepEqual(profile.autoStartOnDsh, []);
  } finally {
    delete process.env.DSH_AU_CLOUD_MANIFEST_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('开机项使用本机绑定的 scriptPath 与 args，而不是服务 id 特例', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-script-boot-'));
  const bindingPath = join(dir, 'machine.json');
  const scriptPath = join(dir, 'map-drive.ps1');
  writeFileSync(scriptPath, '# fixture\n');
  process.env.DSH_AU_STARTUP_DIR = join(dir, 'startup');
  process.env.DSH_AU_LOCAL_BINDINGS_PATH = bindingPath;
  const profile = { enabled: ['drive_map'], autoStartOnBoot: ['drive_map'] };
  try {
    writeFileSync(bindingPath, JSON.stringify({
      schemaVersion: 2,
      machineId: 'script-host',
      services: {
        drive_map: {
          scriptPath,
          args: ['-Action', 'start', '-WaitSeconds', '120', '-Server', '192.0.2.36', '-Mapping', 'Z:=HDD;X:=SSD'],
        },
      },
    }));
    const synced = await syncBootStartupEntry('Script-Host', profile, 'win32');
    assert.equal(synced.synced, true);
    assert.deepEqual(synced.activeServices, ['drive_map']);
    const vbs = readFileSync(synced.filePath, 'utf8');
    assert.match(vbs, /map-drive\.ps1/);
    assert.match(vbs, /-Action start/);
    assert.doesNotMatch(vbs, /control_service/);

    // 没有 AuWin 控制器、也没有 scriptPath 时，不能写出假开机项。
    const auwinSync = await syncBootStartupEntry('Script-Host', {
      enabled: ['svc_files', 'svc_mount', 'cursor_workers', 'dsh_bridge'],
      autoStartOnBoot: ['svc_files', 'svc_mount', 'cursor_workers', 'dsh_bridge'],
    }, 'win32');
    assert.deepEqual(auwinSync.activeServices, []);
    assert.equal(existsSync(auwinSync.filePath), false);

    writeFileSync(bindingPath, JSON.stringify({ schemaVersion: 2, machineId: 'script-host', services: { drive_map: {} } }));
    const skipped = await syncBootStartupEntry('Script-Host', profile, 'win32');
    assert.deepEqual(skipped.activeServices, []);
    assert.deepEqual(skipped.skippedServices, ['drive_map']);
    assert.equal(existsSync(synced.filePath), false);
  } finally {
    delete process.env.DSH_AU_STARTUP_DIR;
    delete process.env.DSH_AU_LOCAL_BINDINGS_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});