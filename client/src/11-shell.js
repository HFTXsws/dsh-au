    function resolveDevicePillStatus(device, { preloading = false } = {}) {
      const base = device?.status || 'unknown';
      if (preloading && (base === 'idle' || base === 'done')) return 'preloading';
      return base;
    }
    // END resolveDevicePillStatus

    function resolveDisconnectRemotesOnLock(snap) {
      return (snap?.self?.features?.disconnectRemotesOnLock ?? snap?.features?.disconnectRemotesOnLock) === true;
    }
    // END resolveDisconnectRemotesOnLock

    function planScreenLockRemoteFrames({
      enabled,
      wasEnabled,
      wasLocked,
      isLocked,
      openedIds,
      activeId,
      suspended,
      readyIds,
      liveIds,
    } = {}) {
      // 开关关闭时不记住、不恢复，页面保持调用方的原样。
      if (enabled !== true) return { mode: 'keep', suspended: null };

      const openIds = (Array.isArray(openedIds) ? openedIds : []).filter((id) => typeof id === 'string' && id);
      const saved = suspended?.pending === true ? suspended : null;
      const lockingNow = isLocked === true && wasLocked !== true;
      const enableWhileLocked = isLocked === true && wasEnabled !== true && saved === null;
      if ((lockingNow || enableWhileLocked) && saved === null) {
        return {
          mode: 'suspend',
          suspended: {
            ids: openIds,
            activeId: typeof activeId === 'string' && activeId ? activeId : null,
            pending: true,
          },
        };
      }
      if (isLocked === true || saved === null) return { mode: 'keep', suspended: saved };

      const ready = new Set(Array.isArray(readyIds) ? readyIds : []);
      const live = new Set(Array.isArray(liveIds) ? liveIds : []);
      const knowLive = live.size > 0;
      const restoreIds = [];
      const waitingIds = [];
      for (const id of saved.ids || []) {
        if (typeof id !== 'string' || !id) continue;
        // 设备已经从列表消失就不再等；还没重新连上的继续等。
        if (knowLive && !live.has(id)) continue;
        if (ready.has(id)) restoreIds.push(id);
        else waitingIds.push(id);
      }
      if (restoreIds.length === 0) {
        if (waitingIds.length === 0) return { mode: 'keep', suspended: null };
        return {
          mode: 'wait',
          suspended: { ids: waitingIds, activeId: saved.activeId || null, pending: true },
        };
      }
      return {
        mode: 'restore',
        ids: restoreIds,
        activeId: saved.activeId && restoreIds.includes(saved.activeId) ? saved.activeId : null,
        suspended: waitingIds.length
          ? { ids: waitingIds, activeId: saved.activeId || null, pending: true }
          : null,
      };
    }
    // END planScreenLockRemoteFrames

    /**
     * 常驻壳层：设备栏插入中心列顶部，远程 iframe 插入 shell.overlay。
     * 两处都是 root 作用域，因此切换本机对话与其它主面板时不会卸载 iframe。
     */
    function AuFleetShell({ selectPanel, collapseSidebar, expandSidebar, usePanelInfo, openLocalSession, readLocalSessionId }) {
      const [state, setState] = useState({ self: null, devices: [], lanPeers: [], remotes: [] });
      const [activeId, setActiveId] = useState(null);
      const [openedIds, setOpenedIds] = useState([]);
      // 首次选中时锁定已选通路；后续探测更新不能让正在保活的 iframe 自动跳转重载。
      const [openedRouteUrls, setOpenedRouteUrls] = useState({});
      // 手机外网切换将认证跳转定向到该 iframe，而非离开带有返回入口的控制端页面。
      const [directFrameRoutes, setDirectFrameRoutes] = useState({});
      const directFrameNavigationsRef = useRef(new Set());
      // 记录每台设备上一次“当前优选”通路，仅用于诊断日志判断是否发生切换。
      const lastSelectedRoutesRef = useRef(new Map());
      const lastOpenedProbeRef = useRef(new Map());
      const [reloadSeq, setReloadSeq] = useState({});
      const [loadedMap, setLoadedMap] = useState({});
      // 当前通路加载失败（iframe 报错或超时）时按优选顺序换下一条，全部试完才判定不可用。
      const [failedLoadDevices, setFailedLoadDevices] = useState({});
      const loadAttemptsRef = useRef(new Map());
      const openedRouteIdsRef = useRef(new Map());
      const openedReasonsRef = useRef(new Map());
      const advanceFailedRouteRef = useRef(null);
      const initialFocusControllerRef = useRef(null);
      const initialFocusCallbacksRef = useRef({ openLocalSession, readLocalSessionId });
      initialFocusCallbacksRef.current = { openLocalSession, readLocalSessionId };
      useEffect(() => {
        const controller = createInitialSessionFocusController({
          openLocalSession: (id) => {
            const open = initialFocusCallbacksRef.current.openLocalSession;
            return typeof open === 'function' ? open(id) : false;
          },
          readLocalSessionId: () => initialFocusCallbacksRef.current.readLocalSessionId?.() || '',
        });
        initialFocusControllerRef.current = controller;
        return () => {
          controller.dispose();
          if (initialFocusControllerRef.current === controller) initialFocusControllerRef.current = null;
        };
      }, []);
      const [editingRemote, setEditingRemote] = useState(null);
       const [editingDevice, setEditingDevice] = useState(null);
      const [remoteManager, setRemoteManager] = useState(false);
      const [workbenchTab, setWorkbenchTab] = useState(null);
      const [scanning, setScanning] = useState(false);
      const [topbarCollapsed, setTopbarCollapsed] = useState(readTopbarCollapsedPreference);
      const [compactMobile, setCompactMobile] = useState(() => (
        typeof window !== 'undefined' && isMobileTopbarViewport(window.innerWidth, window)
      ));
      const [dshSidebarCollapsed, setDshSidebarCollapsed] = useState(() => (
        typeof document !== 'undefined' && Boolean(document.querySelector('[data-sidebar-collapsed]'))
      ));
      const [floatingCapsulePosition, setFloatingCapsulePosition] = useState(readFloatingCapsulePosition);
      const dragRef = useRef(null);
      const suppressCapsuleClickRef = useRef(false);
      const [hosts, setHosts] = useState(null);
      const [hostMountAttempt, setHostMountAttempt] = useState(0);
      const [stageRect, setStageRect] = useState(null);
      const [stageTransition, setStageTransition] = useState(null);
      const stageTransitionTimerRef = useRef(null);
      const pendingPreloadIdsRef = useRef([]);
      const openedIdsRef = useRef([]);
      const activeIdRef = useRef(null);
      // 锁屏前打开的远程页面；解锁并重新连上后再放回来。
      const suspendedRemoteFramesRef = useRef(null);
      const wasLockedForRemotesRef = useRef(false);
      const wasDisconnectOnLockRef = useRef(false);
      const disconnectOnLockRef = useRef(false);
      // 远端工作区计划按最近活动顺序刷新；revision 只用于让事件驱动的队列重新评估。
      const [preloadPlanRevision, setPreloadPlanRevision] = useState(0);
      const [preloadingSessionsByDevice, setPreloadingSessionsByDevice] = useState({});
      useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
        const onMessage = (event) => {
          const data = event?.data;
          if (!data || data.source !== 'dsh-au' || typeof data.type !== 'string') return;
          if (!data.type.startsWith('dsh-au:session-preload-')) return;
          const deviceId = typeof data.deviceId === 'string' ? data.deviceId.trim() : '';
          if (!deviceId) return;
          const kind = data.type.slice('dsh-au:session-preload-'.length);
          const isRunning = kind === 'stage' && data.result === 'loading';
          const isDone = kind === 'ready' || kind === 'skipped' || kind === 'unsupported' || kind === 'error' || kind === 'cancelled'
            || (kind === 'stage' && data.result && data.result !== 'loading');
          if (!isRunning && !isDone) return;
          setPreloadingSessionsByDevice((prev) => {
            const current = Boolean(prev[deviceId]);
            if (isRunning && current) return prev;
            if (isDone && !current) return prev;
            if (isRunning) return { ...prev, [deviceId]: true };
            const next = { ...prev };
            delete next[deviceId];
            return next;
          });
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
      }, []);
      const clearStageTransition = useCallback(() => {
        if (stageTransitionTimerRef.current) {
          window.clearTimeout(stageTransitionTimerRef.current);
          stageTransitionTimerRef.current = null;
        }
        setStageTransition(null);
      }, []);
      useEffect(() => () => {
        if (stageTransitionTimerRef.current) {
          window.clearTimeout(stageTransitionTimerRef.current);
          stageTransitionTimerRef.current = null;
        }
      }, []);
      // 复用桌面工具栏作为手机端纵向展开区，不维护第二套操作入口。
      const [mobileToolsOpen, setMobileToolsOpen] = useState(false);
      const mobileToolsButtonRef = useRef(null);
      useEffect(() => {
        if (topbarCollapsed || !compactMobile) setMobileToolsOpen(false);
      }, [topbarCollapsed, compactMobile]);
      const activePanelId = usePanelInfo((info) => info.activePanelId);
      const sidebarLeadingInset = IS_MACOS && dshSidebarCollapsed
        ? MACOS_SIDEBAR_COLLAPSED_LEADING_INSET
        : 0;

      const applySnap = useCallback((snap) => {
        if (!snap || !snap.ok) return snap;
        // 顺手把顶栏轮询到的本机绑定、插件、收藏等同步进工作台缓存，避免首次开窗白屏。
        seedWorkbenchSnapshotFromState(snap);
        const nextDeviceIds = new Set((snap.devices || []).map((device) => device.id));
        setState({ self: snap.self, devices: snap.devices || [], lanPeers: snap.lanPeers || [], remotes: snap.remotes || [] });
        // 默认留在本机；若手动设备被删除才回到本机对话。
        setActiveId((current) => {
          if (!current || nextDeviceIds.has(current)) return current;
          // 这条路径不经过 selectLocal，单独留痕，否则“自动切回本机”在日志里无记录。
          reportClientEvent('select-local', 'local', { reason: 'device-removed', fromDeviceId: current, recordCount: nextDeviceIds.size });
          return null;
        });
        // 设备删除时释放页面与已锁定地址；短暂离线不会进入这条清理通路。
        setOpenedIds((old) => old.filter((id) => nextDeviceIds.has(id)));
        const retainDevices = (old) => Object.fromEntries(Object.entries(old).filter(([id]) => nextDeviceIds.has(id)));
        setOpenedRouteUrls(retainDevices);
        setDirectFrameRoutes(retainDevices);
        for (const id of openedRouteIdsRef.current.keys()) {
          if (nextDeviceIds.has(id)) continue;
          openedRouteIdsRef.current.delete(id);
          openedReasonsRef.current.delete(id);
          loadAttemptsRef.current.delete(id);
        }
        let stateChanged = true;
        let stateDigest = '';
        if (typeof window !== 'undefined') {
          window.__dshAuLastStateSnap = snap;
          disconnectOnLockRef.current = resolveDisconnectRemotesOnLock(snap);
          // 同步锁屏状态，供同步 poll 守卫使用。
          const wasLocked = window.__dshAuSystemLocked === true;
          const isLocked = snap.systemLocked === true;
          window.__dshAuSystemLocked = isLocked;
          if (!wasLocked && isLocked) {
            // eslint-disable-next-line no-console
            console.info('[dsh-au] client: systemLocked=true received from server');
          } else if (wasLocked && !isLocked) {
            // eslint-disable-next-line no-console
            console.info('[dsh-au] client: systemLocked=false received from server');
          }
          // 计算跨设备会话状态的轻量级指纹，让重型监听器能够依据状态变更选择性跳过
          const self = snap.self || {};
          const selfPart = `${self.deviceId || ''}:${self.statusV2 || self.status || ''}:${self.stateVersion || self.sessionStateVersion || ''}:${JSON.stringify(self.sessionStatesV2 || {})}`;
          const remotePart = Array.isArray(snap.remotes)
            ? snap.remotes.map((remote) => `${remote?.id || remote?.deviceId || ''}:${Boolean(remote?.online)}:${remote?.statusV2 || remote?.status || ''}:${JSON.stringify(remote?.sessionStatesV2 || {})}`).join('|')
            : '';
          stateDigest = `${selfPart}##${remotePart}`;
          const prevDigest = window.__dshAuLastSelfStateDigest;
          stateChanged = prevDigest === undefined || stateDigest !== prevDigest;
          window.__dshAuLastSelfStateDigest = stateDigest;
        }
        if (typeof window?.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
          window.dispatchEvent(new CustomEvent('dsh-au:self-state', {
            detail: {
              ...(snap.self || {}),
              _auSnap: snap,
              stateChanged,
              stateDigest,
            },
          }));
        }
        return snap;
      }, []);

      // 折叠偏好仅属于当前浏览器，不影响其它设备或 dsh-au 服务端配置。
      useEffect(() => {
        try { localStorage.setItem(TOPBAR_COLLAPSED_STORAGE_KEY, String(topbarCollapsed)); } catch {}
      }, [topbarCollapsed]);
      // DSH 侧栏由宿主 layout 控制；监听其稳定 data 属性，区分它与 dsh-au 自己的胶囊折叠。
      useEffect(() => {
        const root = document.documentElement;
        if (!root || typeof MutationObserver === 'undefined') return undefined;
        const syncSidebarState = () => setDshSidebarCollapsed(Boolean(document.querySelector('[data-sidebar-collapsed]')));
        syncSidebarState();
        const observer = new MutationObserver(syncSidebarState);
        observer.observe(root, { subtree: true, attributes: true, attributeFilter: ['data-sidebar-collapsed'] });
        return () => observer.disconnect();
      }, []);
      useEffect(() => {
        ensureStyles(sidebarLeadingInset);
      }, [sidebarLeadingInset]);
      useEffect(() => {
        try { localStorage.setItem(FLOATING_CAPSULE_STORAGE_KEY, JSON.stringify(floatingCapsulePosition)); } catch {}
      }, [floatingCapsulePosition]);

      // 手机端首次或窗口转为触摸窄屏时收起为悬浮胶囊；展开后可从菜单访问工具。
       useEffect(() => {
         const refreshMobileTopbar = () => {
           const mobile = isMobileTopbarViewport(window.innerWidth, window);
           setCompactMobile(mobile);
           if (mobile) setTopbarCollapsed(true);
         };
         refreshMobileTopbar();
         window.addEventListener('resize', refreshMobileTopbar);
         return () => window.removeEventListener('resize', refreshMobileTopbar);
       }, []);

       // 创建两个受插件管理的 Portal host：顶部栏进入中心列，舞台留在常驻 overlay。
      useEffect(() => {
        const mainSlot = document.querySelector('[data-slot="main"]');
        const centerColumn = mainSlot?.parentElement;
        const overlay = document.querySelector('[data-shell-overlay]');
        if (!mainSlot || !centerColumn || !overlay) {
          // 远端页面的 layout 可能在插件后提交；短暂重试而非永久放弃顶部栏/悬浮入口。
          const retry = window.setTimeout(() => setHostMountAttempt((attempt) => attempt + 1), 120);
          return () => window.clearTimeout(retry);
        }

        const topHost = document.createElement('div');
        topHost.id = TOP_HOST_ID;
        topHost.dataset.dshAuHost = 'top';
        centerColumn.insertBefore(topHost, mainSlot);

        const stageHost = document.createElement('div');
        stageHost.id = STAGE_HOST_ID;
        stageHost.dataset.dshAuHost = 'stage';
        overlay.appendChild(stageHost);

        setHosts({ topHost, stageHost, centerColumn });
        return () => {
          topHost.remove();
          stageHost.remove();
        };
      }, [hostMountAttempt]);

      // 以中心列及顶部栏的实际几何计算 overlay 舞台，窗口缩放时仍严丝合缝。
      useEffect(() => {
        if (!hosts) return undefined;
        let frame = 0;
        const updateRect = () => {
          frame = 0;
          const column = hosts.centerColumn.getBoundingClientRect();
          const bar = hosts.topHost.getBoundingClientRect();
          const top = Math.max(column.top, bar.bottom);
          const height = Math.max(0, column.bottom - top);
          setStageRect({ left: column.left, top, width: column.width, height });
        };
        const schedule = () => {
          if (!frame) frame = requestAnimationFrame(updateRect);
        };
        const observer = new ResizeObserver(schedule);
        observer.observe(hosts.centerColumn);
        observer.observe(hosts.topHost);
        window.addEventListener('resize', schedule);
        schedule();
        return () => {
          observer.disconnect();
          window.removeEventListener('resize', schedule);
          if (frame) cancelAnimationFrame(frame);
        };
      }, [hosts]);

      // 兼容侧栏既有「Au 多机」入口：点击后回到会话主面板，常驻栏不发生重建。
      useEffect(() => {
        if (activePanelId === PANEL_ID) selectPanel(null);
      }, [activePanelId, selectPanel]);

      // 确保当前选中的设备标签始终加入保活挂载集合，并在 html 根节点标记远端舞台激活态供本机移动端插件隐藏悬浮按钮。
      useEffect(() => {
        if (!activeId) {
          if (typeof document !== 'undefined' && document.documentElement) {
            document.documentElement.removeAttribute('data-dsh-au-remote-active');
          }
          return undefined;
        }
        setOpenedIds((old) => (old.includes(activeId) ? old : [...old, activeId]));
        if (typeof document !== 'undefined' && document.documentElement) {
          document.documentElement.setAttribute('data-dsh-au-remote-active', 'true');
        }
        return () => {
          if (typeof document !== 'undefined' && document.documentElement) {
            document.documentElement.removeAttribute('data-dsh-au-remote-active');
          }
        };
      }, [activeId]);

      useEffect(() => {
        // 首次挂载也带上当前 inset，避免后续轮询初始化把 macOS 避让宽度冲掉。
        ensureStyles(sidebarLeadingInset);
        let alive = true;
        const refreshNow = () => {
          callApi('getState').then((snap) => { if (alive) applySnap(snap); }).catch(() => {});
        };
        refreshNow();
        // 页面加载后静默预取一次工作台缓存（菜单与服务名单），后续首次点开弹窗直接秒开。
        callApi('getMenuWorkbench', { force: false }).then((wbSnap) => {
          if (alive && wbSnap?.ok) cachedWorkbenchSnapshot = wbSnap;
        }).catch(() => {});
        const timer = setInterval(refreshNow, 4000);
        window.addEventListener('dsh-au:refresh-state', refreshNow);
        return () => {
          alive = false;
          clearInterval(timer);
          window.removeEventListener('dsh-au:refresh-state', refreshNow);
        };
      }, [applySnap]);

      // 设备归属来自手动账本；远端身份与局域网扫描不参与设备创建或归并。
      const accessRoute = resolveCurrentAccessRoute(state.remotes, window.location.href);
      const allDevices = buildManualDeviceViews(state.self, state.devices, state.remotes, accessRoute.transport);
      const devices = allDevices.filter((device) => !isSelfDevice(device, state.self));
      if (typeof window !== 'undefined') {
        window.__dshAuAllDevices = allDevices;
        window.__dshAuDevices = devices;
      }
      useEffect(() => {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
          window.dispatchEvent(new CustomEvent('dsh-au:active-device-change', { detail: { activeId: activeId || null, devices } }));
        }
      }, [activeId, devices]);
      const accessAlias = resolveAccessLabel(state.remotes, window.location.href);
      const localLabel = accessRoute.name || accessAlias || '本机';
      const localBadge = accessRoute.badge || (accessAlias ? '内网穿透' : (state.self?.hostname || '本机直连'));
      const isDevicePreloading = (deviceId) => {
        if (!deviceId || deviceId === 'local') return false;
        const framePreloading = openedIds.includes(deviceId)
          && openedReasonsRef.current.get(deviceId) === 'preload'
          && !directFrameRoutes[deviceId]
          && !loadedMap[`${deviceId}_${reloadSeq[deviceId] || 0}`]
          && !failedLoadDevices[deviceId];
        return framePreloading || Boolean(preloadingSessionsByDevice[deviceId]);
      };
      const statusItems = [
        { id: 'local', name: localLabel, status: state.self?.statusV2 || state.self?.status || 'idle', runningCount: state.self?.runningCount || 0 },
        ...devices.map((device) => ({
          id: device.id,
          name: device.name,
          status: resolveDevicePillStatus(device, { preloading: isDevicePreloading(device.id) }),
          runningCount: device.runningCount || 0,
        })),
      ];
      // 选路诊断：每台设备的优选通路变化时上报一条，附带当时各路径状态，便于对照“为什么切过去”。
      const routeSignature = devices.map((device) => `${device.id}:${device.selectedRoute?.id || ''}`).join('|');
      useEffect(() => {
        const last = lastSelectedRoutesRef.current;
        for (const device of devices) {
          const nextRouteId = device.selectedRoute?.id || '';
          if (!last.has(device.id)) { last.set(device.id, nextRouteId); continue; }
          const prevRouteId = last.get(device.id);
          if (prevRouteId === nextRouteId) continue;
          last.set(device.id, nextRouteId);
          reportRouteChange({
            deviceId: device.id,
            fromRouteId: prevRouteId,
            toRouteId: nextRouteId,
            reason: 'preference-change',
            routeId: openedRouteIdsRef.current.get(device.id) || '',
            accessTransport: accessRoute.transport,
            routes: (device.routes || []).map((route) => ({ id: route.id, transport: route.transport || route.kind, status: route.status, online: route.online })),
          });
        }
        // 仅在优选结果签名变化时运行，常规 4 秒轮询不会重复上报。
      }, [routeSignature]);
      const openedProbeSignature = openedIds.map((id) => {
        const routeId = openedRouteIdsRef.current.get(id) || '';
        const route = devices.find((device) => device.id === id)?.routes.find((item) => item.id === routeId);
        return `${id}:${routeId}:${route?.online}:${route?.status}`;
      }).join('|');
      useEffect(() => {
        for (const id of openedIds) {
          const routeId = openedRouteIdsRef.current.get(id) || '';
          const route = devices.find((device) => device.id === id)?.routes.find((item) => item.id === routeId);
          if (!route) continue;
          const ready = isRouteReady(route);
          const key = `${id}:${routeId}`;
          const previous = lastOpenedProbeRef.current.get(key);
          lastOpenedProbeRef.current.set(key, ready);
          if (previous === undefined || previous === ready) continue;
          reportClientEvent(ready ? 'iframe-probe-recovered' : 'iframe-probe-offline', id, {
            routeId, frameId: `${CLIENT_INSTANCE_ID}:${id}_${reloadSeq[id] || 0}`,
            reason: ready ? 'probe-recovered' : 'probe-offline', result: 'frame-preserved',
          });
        }
      }, [openedProbeSignature]);
      const activeDev = devices.find((device) => device.id === activeId) || null;
      const activeFrameKey = activeDev ? `${activeDev.id}_${reloadSeq[activeDev.id] || 0}` : '';
      // 探活失败只改变状态灯，不遮掉已加载的会话，也不卸载其页面。
      const activeNeedsCredentials = Boolean(activeDev && !loadedMap[activeFrameKey] && activeDev.status === 'needs_auth');
      const activeUnavailable = Boolean(activeDev && !loadedMap[activeFrameKey] && (activeDev.status === 'offline' || failedLoadDevices[activeDev.id]));
      const activeLoading = Boolean(activeDev && !activeNeedsCredentials && !activeUnavailable && !loadedMap[activeFrameKey]);
      const lanOn = state.self?.lanShareEnabled !== false;
      const showStage = activeDev !== null && stageRect !== null;
      useEffect(() => {
        if (!hosts || !state.self || (activeId && !activeDev)) return;
        const frame = activeId
          ? [...hosts.stageHost.querySelectorAll('iframe')].find((item) => item.name === `${CONTROLLED_FRAME_NAME_PREFIX}${activeId}`) || null
          : null;
        // 首次进入只定位一次；预加载本身不选会话，后续设备切换和轮询只更新守卫。
        initialFocusControllerRef.current?.update({
          deviceId: activeId || 'local',
          routeId: activeId ? openedRouteIdsRef.current.get(activeId) || '' : '',
          frameKey: activeFrameKey, frame,
          loaded: activeId ? Boolean(loadedMap[activeFrameKey]) : true,
          allowed: !activePanelId && !remoteManager && !workbenchTab && !editingDevice && !editingRemote,
        });
      });

      // 选模目标来自当前可见舞台，不能拿后台 iframe 或本机保留会话代替远端。
      useEffect(() => {
        const frame = activeId && hosts?.stageHost
          ? [...hosts.stageHost.querySelectorAll('iframe')].find((item) => item.name === `${CONTROLLED_FRAME_NAME_PREFIX}${activeId}`) || null
          : null;
        updateModelShortcutTarget({ deviceId: activeId || 'local', frame,
          routeId: activeId ? openedRouteIdsRef.current.get(activeId) || '' : '',
          allowed: !activePanelId && !remoteManager && !workbenchTab && !editingDevice && !editingRemote
            && (!activeId || Boolean(loadedMap[activeFrameKey] && frame)),
        });
      });
      useEffect(() => () => updateModelShortcutTarget({ deviceId: 'local', frame: null, allowed: false }), []);

      openedIdsRef.current = openedIds;
      activeIdRef.current = activeId;

      const clearFailedLoad = useCallback((deviceId) => {
        setFailedLoadDevices((previous) => {
          if (!previous[deviceId]) return previous;
          const next = { ...previous };
          delete next[deviceId];
          return next;
        });
      }, []);

      const remoteReconnectSignature = [
        typeof window !== 'undefined' && window.__dshAuSystemLocked === true ? 'locked' : 'open',
        disconnectOnLockRef.current ? 'on' : 'off',
        devices.map((device) => `${device.id}:${device.targetUrl ? 'ready' : 'wait'}`).join('|'),
      ].join('::');
      useEffect(() => {
        const isLocked = typeof window !== 'undefined' && window.__dshAuSystemLocked === true;
        const readyIds = devices.filter((device) => device?.id && device.targetUrl).map((device) => device.id);
        const plan = planScreenLockRemoteFrames({
          enabled: disconnectOnLockRef.current === true,
          wasEnabled: wasDisconnectOnLockRef.current,
          wasLocked: wasLockedForRemotesRef.current,
          isLocked,
          openedIds: openedIdsRef.current,
          activeId: activeIdRef.current,
          suspended: suspendedRemoteFramesRef.current,
          readyIds,
          liveIds: devices.map((device) => device.id),
        });
        wasDisconnectOnLockRef.current = disconnectOnLockRef.current === true;
        wasLockedForRemotesRef.current = isLocked;
        suspendedRemoteFramesRef.current = plan.suspended;
        if (plan.mode === 'suspend') {
          // 先卸掉远程页面，等解锁后的新代理地址再挂回来，避免沿用已经关掉的旧端口。
          setOpenedIds((old) => (old.length === 0 ? old : []));
          setActiveId((current) => {
            if (!plan.suspended.ids.includes(current)) return current;
            // 锁屏断开远端同样绕过 selectLocal，补一条来源日志。
            reportClientEvent('select-local', 'local', { reason: 'screen-lock-suspend', fromDeviceId: current || '' });
            return null;
          });
          setOpenedRouteUrls((old) => {
            if (!plan.suspended.ids.some((id) => old[id])) return old;
            const next = { ...old };
            for (const id of plan.suspended.ids) delete next[id];
            return next;
          });
          return;
        }
        if (plan.mode !== 'restore') return;
        for (const id of plan.ids) {
          const device = devices.find((item) => item.id === id);
          const routeId = device?.selectedRoute?.id || '';
          if (routeId) openedRouteIdsRef.current.set(id, routeId);
          if (!openedReasonsRef.current.get(id)) openedReasonsRef.current.set(id, 'lock-restore');
          clearFailedLoad(id);
        }
        setOpenedIds((old) => {
          const missing = plan.ids.filter((id) => !old.includes(id));
          return missing.length === 0 ? old : [...old, ...missing];
        });
        setOpenedRouteUrls((old) => {
          const next = { ...old };
          let changed = false;
          for (const id of plan.ids) {
            const targetUrl = devices.find((item) => item.id === id)?.targetUrl;
            if (targetUrl && next[id] !== targetUrl) {
              next[id] = targetUrl;
              changed = true;
            }
          }
          return changed ? next : old;
        });
        // 用户解锁后已经点了别的设备时，不把画面抢回去。
        if (plan.activeId) setActiveId((current) => current || plan.activeId);
      }, [clearFailedLoad, remoteReconnectSignature]);

      const advanceFailedRoute = useCallback((deviceId, failedRouteId = '', reason = 'load-error', failedFrameKey = '') => {
        const device = devices.find((item) => item.id === deviceId);
        const currentFrameKey = `${deviceId}_${reloadSeq[deviceId] || 0}`;
        // 已销毁页面的迟到错误不得误切当前新页面的路线。
        if (!device || (failedFrameKey && failedFrameKey !== currentFrameKey)) return false;
        const attempts = new Set(loadAttemptsRef.current.get(deviceId) || []);
        const currentRouteId = failedRouteId || openedRouteIdsRef.current.get(deviceId) || '';
        if (currentRouteId) attempts.add(currentRouteId);
        const candidates = (device.routes || []).filter((route) =>
          route.type !== 'local' && isRouteReady(route) && !attempts.has(route.id)
          && getRouteTargetUrl(route, device.useDirectNavigation));
        const nextRoute = selectRouteForCurrentAccess(candidates, accessRoute.transport);
        if (!nextRoute) {
          loadAttemptsRef.current.set(deviceId, attempts);
          setFailedLoadDevices((previous) => ({ ...previous, [deviceId]: true }));
          reportClientEvent('iframe-unavailable', deviceId, { frameId: `${CLIENT_INSTANCE_ID}:${currentFrameKey}`, routeId: currentRouteId, reason, result: 'routes-exhausted' });
          return false;
        }
        attempts.add(nextRoute.id);
        loadAttemptsRef.current.set(deviceId, attempts);
        openedRouteIdsRef.current.set(deviceId, nextRoute.id);
        openedReasonsRef.current.set(deviceId, reason);
        clearFailedLoad(deviceId);
        setOpenedRouteUrls((previous) => ({ ...previous, [deviceId]: getRouteTargetUrl(nextRoute, device.useDirectNavigation) }));
        if (device.useDirectNavigation) setDirectFrameRoutes((previous) => ({ ...previous, [deviceId]: nextRoute.id }));
        setReloadSeq((previous) => ({ ...previous, [deviceId]: (previous[deviceId] || 0) + 1 }));
        reportClientEvent('iframe-reload', deviceId, { frameId: `${CLIENT_INSTANCE_ID}:${currentFrameKey}`, routeId: nextRoute.id, fromRouteId: currentRouteId, reason });
        reportRouteChange({
          deviceId, reason,
          frameId: `${CLIENT_INSTANCE_ID}:${currentFrameKey}`,
          fromRouteId: currentRouteId,
          toRouteId: nextRoute.id,
          accessTransport: accessRoute.transport,
          routes: (device.routes || []).map((route) => ({ id: route.id, transport: route.transport || route.kind, status: route.status, online: route.online })),
        });
        return true;
      }, [accessRoute.transport, clearFailedLoad, devices, reloadSeq]);
      advanceFailedRouteRef.current = advanceFailedRoute;
      const onFrameLoaded = useCallback((frameKey, loaded, deviceId) => {
        if (loaded && frameKey !== `${deviceId}_${reloadSeq[deviceId] || 0}`) return;
        setLoadedMap((previous) => {
          if (loaded) return previous[frameKey] ? previous : { ...previous, [frameKey]: true };
          if (!previous[frameKey]) return previous;
          const next = { ...previous };
          delete next[frameKey];
          return next;
        });
        if (loaded) {
           clearFailedLoad(deviceId);
           // 旧版远端可能在插件握手前已完成 document load，显式通知 14a coordinator。
           if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
             window.dispatchEvent(new CustomEvent('dsh-au:remote-frame-loaded', { detail: { deviceId, frameKey } }));
           }
         }
      }, [clearFailedLoad, reloadSeq]);
      const onFrameFailure = useCallback((deviceId, routeId, reason, frameKey) => {
        advanceFailedRouteRef.current?.(deviceId, routeId, reason, frameKey);
         // Failure/timeout releases the single hidden inflight slot for the next queued device.
         setPreloadPlanRevision((revision) => revision + 1);
      }, []);
      const refreshDeviceFrame = useCallback((device, reason = 'manual-refresh', route = device.selectedRoute) => {
        // 手机保留既有认证接力的刷新路线；桌面显式刷新才采用最新优选。
        if (reason === 'manual-refresh' && directFrameRoutes[device.id]) {
          route = device.routes.find((item) => item.id === directFrameRoutes[device.id]) || route;
        }
        if (!route?.id) return;
        const targetUrl = getRouteTargetUrl(route, device.useDirectNavigation);
        if (!targetUrl) return;
        const frameKey = `${device.id}_${reloadSeq[device.id] || 0}`;
        loadAttemptsRef.current.set(device.id, new Set([route.id]));
        const fromRouteId = openedRouteIdsRef.current.get(device.id) || '';
        openedRouteIdsRef.current.set(device.id, route.id);
        openedReasonsRef.current.set(device.id, reason);
        clearFailedLoad(device.id);
        onFrameLoaded(frameKey, false, device.id);
        setOpenedRouteUrls((old) => ({ ...old, [device.id]: targetUrl }));
        if (directFrameRoutes[device.id]) setDirectFrameRoutes((old) => ({ ...old, [device.id]: route.id }));
        setReloadSeq((old) => ({ ...old, [device.id]: (old[device.id] || 0) + 1 }));
        reportClientEvent('iframe-reload', device.id, { frameId: `${CLIENT_INSTANCE_ID}:${frameKey}`, routeId: route.id, fromRouteId, reason });
      }, [clearFailedLoad, directFrameRoutes, onFrameLoaded, reloadSeq]);

      const activeDevRef = useRef(activeDev);
      activeDevRef.current = activeDev;
      const refreshDeviceFrameRef = useRef(refreshDeviceFrame);
      refreshDeviceFrameRef.current = refreshDeviceFrame;

      const triggerDshReload = useCallback(() => {
        if (typeof window !== 'undefined') {
          if (window.desktopNext?.command) {
            window.desktopNext.command({ type: 'reload' }).catch(() => {
              window.location.reload();
            });
          } else {
            window.location.reload();
          }
        }
      }, []);

      const triggerDshRestart = useCallback(() => {
        if (typeof window !== 'undefined') {
          if (window.desktopNext?.command) {
            window.desktopNext.command({ type: 'restart-app' }).catch(() => {
              callApi('restartDsh').catch(() => {});
            });
          } else {
            callApi('restartDsh').catch(() => {});
          }
        }
      }, []);

      // reason 标明是谁让画面回到本机（顶栏点击、快捷键、设备移除、外部事件等），用于排查“自动切回本机”。
      const selectLocal = useCallback(({ preserveTopbar = false, reason = 'show-local', trigger = '', sessionId = '', knownRemote, recordCount } = {}) => {
        reportClientEvent('select-local', 'local', {
          fromRouteId: openedRouteIdsRef.current.get(activeId) || '',
          reason,
          trigger,
          sessionId,
          knownRemote,
          recordCount,
          fromDeviceId: activeId || '',
        });
        clearStageTransition();
        setActiveId(null);
        if (!preserveTopbar) setTopbarCollapsed(false);
        // 返回本机对话时恢复本机导航；仅在收起状态调用，避免误反向折叠。
        expandSidebar();
        selectPanel(null);
      }, [activeId, clearStageTransition, expandSidebar, selectPanel]);
      const selectDevice = useCallback((id, { preserveTopbar = false, targetUrl = '', navigateTopLevel = false } = {}) => {
        const selectedDevice = devices.find((device) => device.id === id);
        if (!selectedDevice?.selectedRoute) return;

        const selectedRoute = selectedDevice.selectedRoute;
        if (!selectedRoute.id) return;
        // 切换已打开页面只显示/隐藏，不用最新优选覆盖实际打开路线或失败尝试。
        // Manual selection wins over the age-based preload plan; keep the visited iframe alive.
         pendingPreloadIdsRef.current = pendingPreloadIdsRef.current.filter((deviceId) => deviceId !== id);
         setPreloadPlanRevision((revision) => revision + 1);
         if (!openedRouteIdsRef.current.has(id)) {
          loadAttemptsRef.current.set(id, new Set([selectedRoute.id]));
          openedRouteIdsRef.current.set(id, selectedRoute.id);
          openedReasonsRef.current.set(id, 'select-device');
          clearFailedLoad(id);
        }

        // 普通浏览器里，顶栏点选或已从远程入口打开时，整页去对方 DSH。
        // 桌面壳主窗口换成远程网址后会黑屏，顶栏改走和侧栏一样的嵌页。
        if (!compactMobile && !isElectronShell() && (navigateTopLevel || selectedDevice.useDirectNavigation)) {
          const route = selectedDevice.selectedRoute;
          reportClientEvent('select-device', id);
          if (route?.transport === 'lan' || route?.kind === 'lan') window.location.assign(selectedDevice.targetUrl);
          // 本机浏览器走本机代登录通道：凭据只在本机服务端注入，浏览器地址里没有密码。
          else if (!selectedDevice.useDirectNavigation && selectedDevice.targetUrl) window.location.assign(selectedDevice.targetUrl);
          else if (route?.id) navigateToAuthenticatedRemote(route.id);
          return;
        }
        if (selectedDevice?.useDirectNavigation && compactMobile) {
          const route = selectedDevice.selectedRoute;
          if (!route?.id) return;
          // 手机上将同源认证跳转装进 iframe；外层控制端及其悬浮返回入口始终留在当前页面。
          setDirectFrameRoutes((previous) => previous[id] ? previous : { ...previous, [id]: route.id });
          setActiveId(id);
          setOpenedIds((old) => (old.includes(id) ? old : [...old, id]));
          // 用户从已展开的手机设备栏点选远端时，保留设备标签以便继续切换或返回。
          if (!preserveTopbar) setTopbarCollapsed(false);
          reportClientEvent('select-device', id);
          collapseSidebar();
          selectPanel(null);
          return;
        }
        setActiveId(id);
        if (!preserveTopbar) setTopbarCollapsed(false);
        setOpenedIds((old) => (old.includes(id) ? old : [...old, id]));
        const firstTargetUrl = targetUrl || selectedDevice.targetUrl;
        if (firstTargetUrl) setOpenedRouteUrls((old) => (old[id] ? old : { ...old, [id]: firstTargetUrl }));
        // 点击时的加载状态与 mount/load 时间线一起判断“尚未预热”还是“重复加载”。
        reportClientEvent('select-device', id, {
          frameId: `${CLIENT_INSTANCE_ID}:${id}_${reloadSeq[id] || 0}`,
          routeId: openedRouteIdsRef.current.get(id) || '', reason: 'show-frame',
          result: loadedMap[`${id}_${reloadSeq[id] || 0}`] ? 'document-loaded' : 'still-loading',
        });
        // 桌面端保持左侧栏展开不变（受控远端 iframe 内部已隐藏侧栏），仅在移动端收起侧栏。
        if (compactMobile) collapseSidebar();
        selectPanel(null);
      }, [clearFailedLoad, collapseSidebar, compactMobile, devices, loadedMap, reloadSeq, selectPanel]);
      // 页面加载计时由 RemoteDshFrame 管理，切换标签不重置，也不以 8 秒误杀慢加载。

      // 预加载只消费 14a/coordinator 提供的有序最近活动计划；不再按设备列表自动打开全部远端页面。
      const pendingFrameLoad = openedIds.some((id) => !directFrameRoutes[id]
        && !loadedMap[`${id}_${reloadSeq[id] || 0}`] && !failedLoadDevices[id]);
      const isEligiblePreloadDevice = useCallback((device) => {
        const route = device?.selectedRoute;
        return accessRoute.transport === 'local'
          && !compactMobile
          && !device?.useDirectNavigation
          && device?.id
          && device.id !== 'local'
          && device.id !== state.self?.deviceId
          && device.status !== 'offline'
          && device.status !== 'needs_auth'
          && route?.id
          && route.probeCompleted === true
          && route.status !== 'unknown'
          && isRouteReady(route)
          && device.targetUrl;
      }, [accessRoute.transport, compactMobile, state.self?.deviceId]);
      const preloadQueueSignature = pendingPreloadIdsRef.current.join('|') + `::${preloadPlanRevision}`;
      const flushPendingPreloads = useCallback(() => {
        // 手动选择、当前页面加载或非桌面入口都不能被后台计划抢占。
        if (!hosts || pendingFrameLoad || accessRoute.transport !== 'local' || compactMobile) return;
        const queue = pendingPreloadIdsRef.current;
        let target = null;
        while (queue.length) {
          const candidateId = queue.shift();
          if (!candidateId || candidateId === 'local' || candidateId === state.self?.deviceId) continue;
          const candidate = devices.find((device) => device.id === candidateId);
          if (!candidate || openedIds.includes(candidate.id) || !isEligiblePreloadDevice(candidate)) continue;
          target = candidate;
          break;
        }
        if (!target) return;
        // 只启动队首一个隐藏 iframe；其余设备等 load/ready/error/timeout 释放 inflight。
        const routeId = target.selectedRoute.id;
        openedRouteIdsRef.current.set(target.id, routeId);
        openedReasonsRef.current.set(target.id, 'preload');
        loadAttemptsRef.current.set(target.id, new Set([routeId]));
        clearFailedLoad(target.id);
        setOpenedRouteUrls((old) => (old[target.id] ? old : { ...old, [target.id]: target.targetUrl }));
        setOpenedIds((old) => (old.includes(target.id) ? old : [...old, target.id]));
      }, [accessRoute.transport, clearFailedLoad, compactMobile, devices, hosts, isEligiblePreloadDevice, openedIds, pendingFrameLoad, state.self?.deviceId]);
      useEffect(() => {
        if (!hosts || pendingFrameLoad || accessRoute.transport !== 'local' || compactMobile) return undefined;
         const candidate = pendingPreloadIdsRef.current
           .map((deviceId) => devices.find((device) => device.id === deviceId))
           .find((device) => device && !openedIds.includes(device.id) && isEligiblePreloadDevice(device));
         if (!candidate) return undefined;
        const timer = window.setTimeout(() => {
          flushPendingPreloads();
        }, 750);
        return () => window.clearTimeout(timer);
      }, [accessRoute.transport, compactMobile, devices, flushPendingPreloads, hosts, isEligiblePreloadDevice, openedIds, pendingFrameLoad, preloadQueueSignature]);

      const selectRelativeDevice = useCallback((direction, options = {}) => {
        const ids = [null, ...devices.map((device) => device.id)];
        const currentIndex = Math.max(0, ids.indexOf(activeId));
        const nextId = ids[(currentIndex + direction + ids.length) % ids.length];
        if (nextId === null) selectLocal({ ...options, reason: 'shortcut-cycle' });
        else {
          const nextDevice = devices.find((device) => device.id === nextId);
          selectDevice(nextId, { ...options, targetUrl: nextDevice?.targetUrl || '' });
        }
      }, [activeId, devices, selectDevice, selectLocal]);

      // 手机跨外网设备时，先挂好受控 iframe，再把一次性认证 303 提交到该 frame，绝不导航顶层控制页。
      useEffect(() => {
        const routeId = activeId ? directFrameRoutes[activeId] : '';
        if (!routeId || !hosts?.stageHost) return;
        const reload = reloadSeq[activeId] || 0;
        const navigationKey = `${activeId}:${routeId}:${reload}`;
        if (directFrameNavigationsRef.current.has(navigationKey)) return;
        const frameName = `${CONTROLLED_FRAME_NAME_PREFIX}${activeId}`;
        const frame = [...hosts.stageHost.querySelectorAll('iframe')].find((item) => item.name === frameName);
        if (!frame) return;
        directFrameNavigationsRef.current.add(navigationKey);
        navigateToAuthenticatedRemote(routeId, frameName);
      }, [activeId, directFrameRoutes, hosts, reloadSeq]);

      // 远程 DSH 管理总开关：关闭时不渲染设备栏、远程舞台与悬浮胶囊（放在全部 state 之后，保持 hook 顺序稳定）。
      // featuresStore 定义在设置页片段；单独加载外壳时按默认开启处理。
      const remoteManagementEnabled = typeof useFeatures === 'function' ? useFeatures().remoteManagement !== false : true;

      // 设置页「管理远程设备」按钮请求打开远程设备管理弹窗。
      useEffect(() => {
        const onOpenRemoteManager = () => setRemoteManager(true);
        window.addEventListener(OPEN_REMOTE_MANAGER_EVENT, onOpenRemoteManager);
        return () => window.removeEventListener(OPEN_REMOTE_MANAGER_EVENT, onOpenRemoteManager);
      }, []);

      // 关闭远程 DSH 管理时，若正停留在远程设备上则先回到本机。
      useEffect(() => {
        if (!remoteManagementEnabled && activeId) selectLocal({ reason: 'remote-management-off' });
      }, [remoteManagementEnabled, activeId, selectLocal]);

      // 若已打开的远端后来确认是本机映射，立即回到本机而不是留下空白舞台。
      useEffect(() => {
        if (activeId && !devices.some((device) => device.id === activeId)) selectLocal({ reason: 'device-missing' });
      }, [activeId, devices, selectLocal]);

      // 外层的快捷键覆盖推送给每个受控 iframe（iframe 读不到外层的 localStorage）；iframe 加载完成时也会推一次。
      useEffect(() => {
        const push = () => {
          const frames = hosts ? hosts.stageHost.querySelectorAll('iframe') : [];
          for (const frame of frames) postShortcutConfig(frame.contentWindow);
        };
        push();
        shortcutStore.listeners.add(push);
        modelShortcutsStore.listeners.add(push);
        return () => { shortcutStore.listeners.delete(push); modelShortcutsStore.listeners.delete(push); };
      }, [hosts, devices]);

      // DSH 快捷键服务触发本窗口事件；Alt+[ / Alt+] 与 Ctrl+Tab 都有页面层兜底，iframe 内事件安全转发至顶层壳层。
      useEffect(() => {
        const onDeviceSwitch = (event) => {
          const direction = event.detail?.direction;
          if (direction !== -1 && direction !== 1) return;
          if (window.top !== window) {
            window.top.postMessage({ source: 'dsh-au', type: 'switch-device', direction }, '*');
          } else {
            selectRelativeDevice(direction, { preserveTopbar: event.detail?.preserveTopbar === true });
          }
        };
        const onDeviceSelect = (event) => {
          const requested = event.detail?.deviceId;
          if (typeof requested !== 'string' || !requested) return;
          if (requested === state.self?.deviceId || requested === 'local') {
            // 外部派发方（待办、侧栏拦截等）可在 detail.reason 等字段里说明来源，原样带进日志。
            selectLocal({
              preserveTopbar: true,
              reason: typeof event.detail?.reason === 'string' && event.detail.reason ? event.detail.reason : 'select-event',
              trigger: typeof event.detail?.trigger === 'string' ? event.detail.trigger : '',
              sessionId: typeof event.detail?.sessionId === 'string' ? event.detail.sessionId : '',
              knownRemote: typeof event.detail?.knownRemote === 'boolean' ? event.detail.knownRemote : undefined,
              recordCount: Number.isSafeInteger(event.detail?.recordCount) ? event.detail.recordCount : undefined,
            });
            return;
          }
          if (event.detail?.skipInitialFocus === true && typeof INITIAL_FOCUS_VISITS_KEY === 'string') {
            const visits = window[INITIAL_FOCUS_VISITS_KEY] instanceof Set
              ? window[INITIAL_FOCUS_VISITS_KEY]
              : (window[INITIAL_FOCUS_VISITS_KEY] = new Set());
            visits.add(requested);
          }
          const target = devices.find((device) => device.id === requested);
          if (target) selectDevice(target.id, { preserveTopbar: true, targetUrl: target.targetUrl || '' });
        };
        const onStageTransition = (event) => {
          const detail = event?.detail;
          if (!detail || detail.active === false) {
            clearStageTransition();
            return;
          }
          if (stageTransitionTimerRef.current) {
            window.clearTimeout(stageTransitionTimerRef.current);
          }
          const timeoutMs = Number(detail.timeoutMs) > 0 ? Number(detail.timeoutMs) : 3200;
          setStageTransition({
            deviceId: detail.deviceId || '',
            label: detail.label || '正在切换远程会话 ...',
            commandId: detail.commandId || '',
            forceMask: detail.forceMask === true,
          });
          stageTransitionTimerRef.current = window.setTimeout(() => {
            stageTransitionTimerRef.current = null;
            setStageTransition(null);
          }, timeoutMs);
        };
        const onPreloadDevice = (event) => {
          const requestedIds = Array.isArray(event?.detail?.deviceIds)
            ? event.detail.deviceIds
            : (event?.detail?.deviceId ? [event.detail.deviceId] : []);
          // A coordinator update is authoritative: replace and reorder the desired queue, never append all devices.
          pendingPreloadIdsRef.current = [...new Set(requestedIds.filter((id) => typeof id === 'string' && id && id !== 'local'))];
          setPreloadPlanRevision((revision) => revision + 1);
        };
        const onKeyDown = (event) => {
          const direction = getDeviceSwitchShortcutDirection(event);
          if (event.defaultPrevented || direction === null) return;
          if (event.target instanceof Element && event.target.closest('.dsh-au-mask')) return;
          event.preventDefault();
          dispatchDeviceSwitch(direction);
        };
        const onMessage = (event) => {
          if (event.data?.source !== 'dsh-au') return;
          const frames = hosts ? hosts.stageHost.querySelectorAll('iframe') : [];
          if (event.data.type === 'dsh-au:remote-command-ack') {
            if (!event.data.stage || event.data.stage === 'done') {
              clearStageTransition();
            }
            return;
          }
          if (event.data.type === 'dsh-au:controlled-workspaces-snapshot') {
            clearStageTransition();
            return;
          }
          if (event.data.type === 'switch-device') {
            if (event.data.direction !== -1 && event.data.direction !== 1) return;
            if (isDeviceSwitchMessageFromStage(event.source, frames)) {
              selectRelativeDevice(event.data.direction, { preserveTopbar: event.data.preserveTopbar === true });
            }
          } else if (event.data.type === SHORTCUT_ACTION_MESSAGE && event.data.action === 'todo.toggle') {
            // 焦点在远端 iframe 里时，待办面板仍属于外层页。
            if (isDeviceSwitchMessageFromStage(event.source, frames)) window.dispatchEvent(new CustomEvent(TODO_TOGGLE_EVENT));
          } else if (event.data.type === SHORTCUT_ACTION_MESSAGE && event.data.action === 'todo.cycle') {
            if (isDeviceSwitchMessageFromStage(event.source, frames)) window.dispatchEvent(new CustomEvent(TODO_CYCLE_EVENT));
          } else if (event.data.type === SHORTCUT_ACTION_MESSAGE && event.data.action === 'device.refresh') {
            if (isDeviceSwitchMessageFromStage(event.source, frames) && activeDevRef.current) {
              refreshDeviceFrameRef.current?.(activeDevRef.current, 'manual-refresh');
            }
          } else if (event.data.type === SHORTCUT_ACTION_MESSAGE && event.data.action === 'dsh.reload') {
            if (isDeviceSwitchMessageFromStage(event.source, frames)) triggerDshReload();
          } else if (event.data.type === SHORTCUT_ACTION_MESSAGE && event.data.action === 'dsh.restart') {
            if (isDeviceSwitchMessageFromStage(event.source, frames)) triggerDshRestart();
          } else if (event.data.type === 'remote-session-confirmed' || event.data.type === 'frame-ready') {
            clearStageTransition();
            if (event.data.type === 'remote-session-confirmed') {
              const matchedFrame = [...frames].find((frame) => frame?.contentWindow === event.source);
              const deviceId = matchedFrame?.dataset?.deviceId || activeId || '';
              callApi('probeRemote', deviceId ? { deviceId } : {}).then(applySnap).catch(() => {});
            }
          }
        };
        window.addEventListener(DEVICE_SWITCH_EVENT, onDeviceSwitch);
        window.addEventListener(DEVICE_SELECT_EVENT, onDeviceSelect);
        window.addEventListener('dsh-au:stage-transition', onStageTransition);
        window.addEventListener('dsh-au:preload-device', onPreloadDevice);
        window.addEventListener('keydown', onKeyDown, true);
        if (window.top === window) window.addEventListener('message', onMessage);
        return () => {
          window.removeEventListener(DEVICE_SWITCH_EVENT, onDeviceSwitch);
          window.removeEventListener(DEVICE_SELECT_EVENT, onDeviceSelect);
          window.removeEventListener('dsh-au:stage-transition', onStageTransition);
          window.removeEventListener('dsh-au:preload-device', onPreloadDevice);
          window.removeEventListener('keydown', onKeyDown, true);
          if (window.top === window) window.removeEventListener('message', onMessage);
        };
      }, [clearFailedLoad, clearStageTransition, compactMobile, devices, hosts, selectDevice, selectLocal, selectRelativeDevice, state.self?.deviceId, state.self?.instanceId]);

      // 统一菜单与后台服务的快捷键（默认 Ctrl+Delete、Shift+\\，可在设置页修改）由捕获阶段监听转为同一事件。
      useEffect(() => {
        const onWorkbenchShortcut = (event) => {
          const tab = event.detail?.tab;
          if (tab === 'fav') setWorkbenchTab((prev) => (prev ? null : 'fav'));
          else if (tab === 'services') setWorkbenchTab('services');
        };
        const onKey = (event) => {
          if (event.defaultPrevented) return;
          const actionId = findShortcutAction(event);
          if (actionId === 'menu.open') {
            event.preventDefault();
            dispatchWorkbenchShortcut('fav');
          } else if (actionId === 'services.open') {
            event.preventDefault();
            dispatchWorkbenchShortcut('services');
          } else if (actionId === 'device.refresh') {
            event.preventDefault();
            if (activeDevRef.current) {
              refreshDeviceFrameRef.current?.(activeDevRef.current, 'manual-refresh');
            }
          } else if (actionId === 'dsh.reload') {
            event.preventDefault();
            triggerDshReload();
          } else if (actionId === 'dsh.restart') {
            event.preventDefault();
            triggerDshRestart();
          } else if (event.key === 'Escape') {
            setWorkbenchTab(null);
          }
        };
        window.addEventListener(WORKBENCH_SHORTCUT_EVENT, onWorkbenchShortcut);
        window.addEventListener('keydown', onKey, true);
        return () => {
          window.removeEventListener(WORKBENCH_SHORTCUT_EVENT, onWorkbenchShortcut);
          window.removeEventListener('keydown', onKey, true);
        };
      }, []);

      const toggleLanShare = async () => {
        const next = !(state.self?.lanShareEnabled ?? true);
        applySnap(await callApi('setLanShare', { enabled: next }));
      };
      const handleSaveDevice = async (payload) => {
        const snap = await callApi('saveDevice', payload);
        applySnap(snap);
        return snap;
      };
      const handleSaveRoute = async (payload) => {
        const snap = await callApi('saveRoute', payload);
        applySnap(snap);
        if (snap?.ok && payload.id === openedRouteIdsRef.current.get(payload.deviceId)) {
          // 只编辑正在打开的路线才刷新；改备用路线不打断保活会话。
          const updated = buildManualDeviceViews(snap.self, snap.devices, snap.remotes, accessRoute.transport)
            .find((device) => device.id === payload.deviceId);
          const route = updated?.routes.find((item) => item.id === payload.id);
          if (updated && route) refreshDeviceFrame(updated, 'route-edited', route);
        }
        return snap;
      };
      const handleDeleteRoute = async (payload) => {
        const snap = await callApi('deleteRoute', payload);
        applySnap(snap);
        return snap;
      };
      const handleSetLocalDevice = async (deviceId) => {
        applySnap(await callApi('setLocalDevice', { deviceId }));
      };
      const handleDiscover = async () => {
        setScanning(true);
        try { applySnap(await callApi('discoverNow')); } finally { setScanning(false); }
      };
      const startCapsuleDrag = useCallback((event) => {
        if (event.button !== 0 || !stageRect) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.dataset.dragging = 'true';
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          position: clampFloatingCapsulePosition(floatingCapsulePosition, stageRect),
          moved: false,
        };
      }, [floatingCapsulePosition, stageRect]);
      const moveCapsuleDrag = useCallback((event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId || !stageRect) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
          drag.moved = true;
          event.preventDefault();
        }
        setFloatingCapsulePosition(clampFloatingCapsulePosition({ top: drag.position.top + dy, right: drag.position.right - dx }, stageRect));
      }, [stageRect]);
      const endCapsuleDrag = useCallback((event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        dragRef.current = null;
        suppressCapsuleClickRef.current = drag.moved;
        event.currentTarget.removeAttribute('data-dragging');
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }, []);
      const floatingCapsuleStyle = stageRect
        ? {
            top: stageRect.top + clampFloatingCapsulePosition(floatingCapsulePosition, stageRect).top,
            right: Math.max(8, window.innerWidth - (stageRect.left + stageRect.width) + clampFloatingCapsulePosition(floatingCapsulePosition, stageRect).right),
          }
        // host 尚未挂载时仍固定到 body 可视区，手机端至少保留可展开的返回入口。
        : { top: 16, right: 16, zIndex: 9999 };

      const topbar = h(
        'header',
        {
          className: `dsh-au-topbar${compactMobile ? ' compact-mobile' : ''}${compactMobile && mobileToolsOpen ? ' mobile-tools-open' : ''}`,
          'aria-label': 'Au 多机设备栏',
          onKeyDown: (event) => {
            if (event.key !== 'Escape' || !mobileToolsOpen) return;
            event.preventDefault();
            setMobileToolsOpen(false);
            mobileToolsButtonRef.current?.focus();
          },
        },
        [
              h(
                'div',
                { key: 'tabs', className: 'dsh-au-tabs' },
                h(
                  'button',
                  { type: 'button', className: `dsh-au-tab ${activeId === null ? 'active' : ''}`, onClick: () => selectLocal({ reason: 'topbar-click' }), title: accessAlias ? `当前通过远程域名访问：${accessAlias}` : '返回本机对话' },
                  h('span', { className: `dsh-au-dot ${state.self?.statusV2 || state.self?.status || 'idle'}` }),
                  h('span', { className: 'dsh-au-tab-name' }, localLabel),
                  h('span', { className: 'dsh-au-badge' }, localBadge)
                ),
                devices.map((device) => {
                  const dotStatus = resolveDevicePillStatus(device, { preloading: isDevicePreloading(device.id) });
                  const pillTitle = dotStatus === 'preloading'
                    ? `${device.routeSummary || device.name} · 预加载中`
                    : (device.routeSummary || device.name);
                  return h(
                    'button',
                    { type: 'button', key: device.id, className: `dsh-au-tab ${device.id === activeId ? 'active' : ''}`, title: pillTitle, onClick: () => selectDevice(device.id, { targetUrl: device.targetUrl, navigateTopLevel: true }) },
                    h('span', { className: `dsh-au-dot ${dotStatus}` }),
                    h('span', { className: 'dsh-au-tab-name' }, device.name),
                    h('span', { className: 'dsh-au-badge' }, device.badge)
                  );
                })
              ),
              // 控制按钮先于展开工具，键盘 Tab 顺序与视觉阅读顺序一致。
              h('div', { key: 'mobile-controls', className: 'dsh-au-mobile-controls' }, [
                h('button', {
                  key: 'mobile-menu', type: 'button', ref: mobileToolsButtonRef, className: 'dsh-au-icon-btn dsh-au-mobile-menu',
                  onClick: () => setMobileToolsOpen((open) => !open),
                  title: mobileToolsOpen ? '收起工具菜单' : '展开工具菜单', 'aria-label': '设备栏工具菜单',
                  'aria-expanded': compactMobile && mobileToolsOpen, 'aria-controls': 'dsh-au-topbar-tools',
                }, h(ToolbarMenuIcon)),
                h('button', { key: 'mobile-collapse', type: 'button', className: 'dsh-au-icon-btn dsh-au-mobile-collapse', onClick: () => {
                  setMobileToolsOpen(false);
                  setTopbarCollapsed(true);
                }, title: '收起设备栏', 'aria-label': '收起设备栏' }, h(DeviceBarChevron, { expanded: true })),
              ]),
              h(
                'div',
                {
                  key: 'actions', id: 'dsh-au-topbar-tools', className: 'dsh-au-actions', 'aria-label': '设备栏操作',
                  // 子按钮仍调用原来的处理器；执行操作后仅关闭手机菜单。
                  onClick: (event) => {
                    if (compactMobile && event.target.closest?.('button')) {
                      setMobileToolsOpen(false);
                      mobileToolsButtonRef.current?.focus();
                    }
                  },
                },
                h('div', { key: 'workspace', className: 'dsh-au-action-group', 'aria-label': '全局工具' }, [
                  // 插件管理是高频入口，放最左，直接打开工作台对应标签页。
                  h('button', { key: 'plugins', type: 'button', className: 'dsh-au-icon-btn', onClick: () => setWorkbenchTab('plugins'), title: '插件管理', 'aria-label': '打开插件管理' }, h(PluginIcon), h('span', { className: 'dsh-au-tool-label' }, '插件')),
                  h('button', { key: 'services', type: 'button', className: 'dsh-au-icon-btn', onClick: () => setWorkbenchTab('services'), title: '后台服务', 'aria-label': '管理后台服务' }, h(ServicesIcon), h('span', { className: 'dsh-au-tool-label' }, '服务')),
                  h('button', { key: 'menu', type: 'button', className: 'dsh-au-icon-btn', onClick: () => setWorkbenchTab('fav'), title: '脚本菜单 · Ctrl+Delete', 'aria-label': '打开统一菜单' }, h(CommandMenuIcon), h('span', { className: 'dsh-au-tool-label' }, '脚本菜单')),
                ]),
                h('span', { key: 'workspace-divider', className: 'dsh-au-action-divider', 'aria-hidden': true }),
                h('div', { key: 'device', className: 'dsh-au-action-group', 'aria-label': '设备管理' }, [
                  activeDev ? h('button', { key: 'refresh', type: 'button', className: 'dsh-au-icon-btn', onClick: () => {
                    // 手动刷新才切换到最新优选通路，后台探测不会打断当前 iframe 会话。
                    refreshDeviceFrame(activeDev, 'manual-refresh');
                  }, title: `刷新 ${activeDev.name} (F5)`, 'aria-label': `刷新当前远程设备 ${activeDev.name}` }, h(RefreshIcon), h('span', { className: 'dsh-au-tool-label' }, '刷新')) : null,
                  h('button', { key: 'remotes', type: 'button', className: 'dsh-au-icon-btn', onClick: () => setRemoteManager(true), title: '查看和编辑远程配置', 'aria-label': '查看和编辑远程配置' }, h(RemoteListIcon), h('span', { className: 'dsh-au-tool-label' }, '远程')),
                  h('button', { key: 'add', type: 'button', className: 'dsh-au-icon-btn primary', onClick: () => setEditingDevice({}), title: '添加手动设备', 'aria-label': '添加手动设备' }, h(AddRemoteIcon), h('span', { className: 'dsh-au-tool-label' }, '新增')),
                ])
              ),
            ]
      );

      const floatingCapsule = h(
        'button',
        {
          type: 'button',
          className: 'dsh-au-floating-capsule dsh-au-status-capsule',
          style: floatingCapsuleStyle,
          title: '拖动以移动；单击展开设备栏',
          'aria-label': `${statusItems.length} 台设备状态，拖动以移动，单击展开设备栏`,
          onPointerDown: startCapsuleDrag,
          onPointerMove: moveCapsuleDrag,
          onPointerUp: endCapsuleDrag,
          onPointerCancel: endCapsuleDrag,
          onLostPointerCapture: endCapsuleDrag,
          onClick: () => {
            if (suppressCapsuleClickRef.current) {
              suppressCapsuleClickRef.current = false;
              return;
            }
            setTopbarCollapsed(false);
          },
        },
        h(
          'span',
          { className: 'dsh-au-status-points', 'aria-label': `${statusItems.length} 台设备状态` },
          statusItems.map((item) => h(
            'span',
            { key: item.id, className: 'dsh-au-status-point', title: `${item.name}：${item.status === 'preloading' ? '预加载中' : item.status}${item.status === 'busy' || item.status === 'waiting' ? `（${item.runningCount} 个任务）` : ''}` },
            h('span', { className: `dsh-au-dot ${item.status}` })
          ))
        )
      );

      const stage = h(
        'div',
        {
          className: 'dsh-au-stage',
          style: stageRect ? { left: stageRect.left, top: stageRect.top, width: stageRect.width, height: stageRect.height, display: showStage ? 'block' : 'none' } : { display: 'none' },
        },
        activeNeedsCredentials
          ? h(AuthPromptCard, { key: activeDev.id, dev: activeDev, onSave: handleSaveRoute })
          : null,
        activeUnavailable
          ? h(UnavailableCard, { key: activeDev.id, dev: activeDev })
          : null,
        activeLoading
          ? h(
              'div',
              { className: 'dsh-au-loading' },
              h('div', { className: 'dsh-au-spinner' }),
              h(
                'span',
                null,
                stageTransition && (!stageTransition.deviceId || stageTransition.deviceId === activeDev.id) && stageTransition.label
                  ? stageTransition.label
                  : `正在加载远程 DSH 界面：${activeDev.name}（${formatRouteTransportLabel(activeDev.selectedRoute)}） ...`
              )
            )
          : null,
        !activeLoading && !activeNeedsCredentials && !activeUnavailable && stageTransition?.forceMask && (!stageTransition.deviceId || stageTransition.deviceId === activeDev?.id)
          ? h(
              'div',
              { className: 'dsh-au-stage-transition-mask', 'data-dsh-au-stage-transition': 'true' },
              h(
                'div',
                { className: 'dsh-au-stage-transition-pill' },
                h('div', { className: 'dsh-au-spinner' }),
                h('span', null, stageTransition.label || `正在切换至 ${activeDev?.name || '远程设备'} ...`)
              )
            )
          : null,
        devices
          // 已打开的页面只因设备删除或显式刷新移除，短暂 offline/needs_auth 不破坏保活。
          .filter((device) => openedIds.includes(device.id) && (openedRouteUrls[device.id] || directFrameRoutes[device.id]))
          .map((device) => {
            const frameKey = `${device.id}_${reloadSeq[device.id] || 0}`;
            const targetUrl = directFrameRoutes[device.id] ? 'about:blank' : openedRouteUrls[device.id];
            return h(RemoteDshFrame, {
              key: frameKey, frameKey,
              deviceId: device.id,
              routeId: openedRouteIdsRef.current.get(device.id) || '',
              targetUrl,
              active: device.id === activeId,
              compactMobile,
              stageWidth: stageRect?.width || 0,
              mountReason: openedReasonsRef.current.get(device.id) || 'select-device',
              onLoaded: onFrameLoaded,
              onFailure: onFrameFailure,
            });
          })
      );

      return h(
        React.Fragment,
        null,
        remoteManagementEnabled && hosts && !topbarCollapsed ? ReactDOM.createPortal(topbar, hosts.topHost) : null,
        remoteManagementEnabled && hosts ? ReactDOM.createPortal(stage, hosts.stageHost) : null,
        remoteManagementEnabled && topbarCollapsed ? ReactDOM.createPortal(floatingCapsule, hosts?.stageHost || document.body) : null,
        editingDevice ? ReactDOM.createPortal(h(DeviceModal, { initial: editingDevice, onClose: () => setEditingDevice(null), onSave: handleSaveDevice }), document.body) : null,
        editingRemote ? ReactDOM.createPortal(h(RouteModal, { initial: editingRemote, devices: allDevices, onClose: () => setEditingRemote(null), onSave: handleSaveRoute, onDelete: handleDeleteRoute }), document.body) : null,
        remoteManager ? ReactDOM.createPortal(h(RemoteManagerModal, {
          devices: allDevices,
          self: state.self,
          // 同时标记所有设备各自采用的通道，包括未选中的保活设备。
          currentConnections: resolveCurrentConnections(
            allDevices, state.self, window.location.href, openedRouteIdsRef.current, directFrameRoutes
          ),
          lanOn,
          scanning,
          onToggleLan: toggleLanShare,
          onDiscover: handleDiscover,
          onClose: () => setRemoteManager(false),
          onEdit: (route) => { setRemoteManager(false); setEditingRemote(route); },
          onEditDevice: (device) => { setRemoteManager(false); setEditingDevice(device); },
          onAddDevice: () => { setRemoteManager(false); setEditingDevice({}); },
          onAddRoute: (device) => { setRemoteManager(false); setEditingRemote({ deviceId: device.id }); },
          onSetLocal: handleSetLocalDevice,
        }), document.body) : null,        workbenchTab ? ReactDOM.createPortal(h(UnifiedWorkbenchModal, { initialTab: workbenchTab, onClose: () => setWorkbenchTab(null) }), document.body) : null
      );
    }

