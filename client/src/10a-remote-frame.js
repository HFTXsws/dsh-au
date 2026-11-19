    // 加载期限属于每个页面实例，而不是当前标签；切回本机不会重置后台加载计时。
    const REMOTE_FRAME_LOAD_TIMEOUT_MS = 30000;
    // DSH AppFrame 默认侧边栏宽度 280px，低于 1024px 自动折叠为 56px 窄轨；用于尚未升级受控端侧栏隐藏脚本的远端机器物理裁切兜底。
    const REMOTE_SIDEBAR_EXPANDED_WIDTH_PX = 280;
    const REMOTE_SIDEBAR_COLLAPSED_WIDTH_PX = 56;
    const REMOTE_SIDEBAR_AUTO_COLLAPSE_BREAKPOINT_PX = 1024;

    function RemoteDshFrame({ deviceId, frameKey, routeId, targetUrl, active, compactMobile = false, stageWidth = 0, mountReason, onLoaded, onFailure }) {
      const frameRef = useRef(null);
      const callbacksRef = useRef({ onLoaded, onFailure });
      callbacksRef.current = { onLoaded, onFailure };
      const lifecycleRef = useRef(null);
      const [sidebarHiddenInFrame, setSidebarHiddenInFrame] = useState(false);
      const frameId = `${CLIENT_INSTANCE_ID}:${frameKey}`;
      const trace = (event, details = {}) => reportClientEvent(event, deviceId, {
        frameId, routeId, elapsedMs: Date.now() - (lifecycleRef.current?.startedAt || Date.now()), ...details,
      });

      useEffect(() => {
        const lifecycle = { alive: true, documentLoaded: false, ready: false, startedAt: Date.now(), probeTimers: [] };
        lifecycleRef.current = lifecycle;
        setSidebarHiddenInFrame(false);
        callbacksRef.current.onLoaded(frameKey, false, deviceId);
        trace('iframe-mounted', { reason: mountReason || 'select-device' });
        const timer = window.setTimeout(() => {
          if (!lifecycle.alive || lifecycle.documentLoaded || lifecycle.ready) return;
          trace('iframe-timeout', { reason: 'load-timeout', result: 'no-document-load' });
          callbacksRef.current.onFailure(deviceId, routeId, 'load-timeout', frameKey);
        }, REMOTE_FRAME_LOAD_TIMEOUT_MS);
        lifecycle.timer = timer;
        const onMessage = (event) => {
          if (!lifecycle.alive || event.source !== frameRef.current?.contentWindow) return;
          if (event.data?.source === 'dsh-au' && (event.data?.controlledSidebarHidden === true || event.data?.type === 'dsh-au:controlled-sidebar-hidden')) {
            setSidebarHiddenInFrame(true);
          }
          if (event.data?.source !== 'dsh-au' || event.data?.type !== 'frame-ready' || event.data.frameId !== frameId) return;
          if (lifecycle.ready) return;
          lifecycle.ready = true;
          // 插件可能在文档 load 之后才安装监听；ready 后补发最新键位与模型配置。
          postShortcutConfig(frameRef.current?.contentWindow);
          window.clearTimeout(timer);
          trace('iframe-ready', { result: 'remote-plugin-ready' });
          callbacksRef.current.onLoaded(frameKey, true, deviceId);
        };
        window.addEventListener('message', onMessage);
        return () => {
          lifecycle.alive = false;
          window.clearTimeout(timer);
          for (const probeTimer of lifecycle.probeTimers) window.clearTimeout(probeTimer);
          window.removeEventListener('message', onMessage);
          trace('iframe-unmounted', { reason: 'frame-removed' });
          callbacksRef.current.onLoaded(frameKey, false, deviceId);
        };
        // 在线/离线及当前标签不属于生命周期依赖；只有显式新 frameKey 才重建。
      }, [frameKey, deviceId, routeId, targetUrl]);

      const handleLoad = (event) => {
        const lifecycle = lifecycleRef.current;
        if (!lifecycle?.alive) return;
        // 手机认证接力的初始空白页不能算远端加载成功；跨源后读取受限则继续处理。
        try { if (event.currentTarget.contentWindow.location.href === 'about:blank') return; } catch {}
        modelShortcutFrameLoaded(event.currentTarget);
        lifecycle.documentLoaded = true;
        // 每次文档导航重新验证 ready，且取消上一轮握手计时，不复用旧文档的确认。
        lifecycle.ready = false;
        setSidebarHiddenInFrame(false);
        for (const probeTimer of lifecycle.probeTimers) window.clearTimeout(probeTimer);
        lifecycle.probeTimers = [];
        window.clearTimeout(lifecycle.timer);
        postShortcutConfig(event.currentTarget?.contentWindow);
        trace('iframe-loaded', { result: 'document-loaded' });
        // 旧版远端没有 ready 握手，仍按文档加载撤下遮罩，但日志不冒称应用已就绪。
        callbacksRef.current.onLoaded(frameKey, true, deviceId);
        const probe = () => {
          if (!lifecycle.alive || lifecycle.ready) return;
          frameRef.current?.contentWindow?.postMessage({ source: 'dsh-au', type: 'frame-probe', frameId }, '*');
        };
        probe();
        for (const delay of [500, 2000, 5000]) lifecycle.probeTimers.push(window.setTimeout(probe, delay));
        lifecycle.probeTimers.push(window.setTimeout(() => {
          if (!lifecycle.alive || lifecycle.ready) return;
          // 未确认可能是旧版远端或插件尚未初始化；只记诊断，不触发失败或重载。
          trace('iframe-ready-unconfirmed', { result: 'no-ready-ack' });
        }, 6000));
      };
      // 当受控远端尚未回报已通过内部 CSS 隐藏侧边栏时（例如远端尚未热更新新版本插件），在桌面端通过舞台 overflow:hidden 物理裁切远端侧边栏
      const clipOffsetPx = (!compactMobile && !sidebarHiddenInFrame)
        ? ((stageWidth <= 0 || stageWidth + REMOTE_SIDEBAR_EXPANDED_WIDTH_PX >= REMOTE_SIDEBAR_AUTO_COLLAPSE_BREAKPOINT_PX)
            ? REMOTE_SIDEBAR_EXPANDED_WIDTH_PX
            : REMOTE_SIDEBAR_COLLAPSED_WIDTH_PX)
        : 0;
      const frameStyle = clipOffsetPx > 0
        ? {
            display: active ? 'block' : 'none',
            left: `-${clipOffsetPx}px`,
            width: `calc(100% + ${clipOffsetPx}px)`,
          }
        : { display: active ? 'block' : 'none' };
      return h('iframe', {
        ref: frameRef,
        name: `${CONTROLLED_FRAME_NAME_PREFIX}${deviceId}`,
        'data-html-preview': '',
        'data-dsh-au-frame-id': frameId,
        className: 'dsh-au-iframe',
        src: targetUrl,
        style: frameStyle,
        allow: 'clipboard-read; clipboard-write',
        onLoad: handleLoad,
        onError: () => {
          if (!lifecycleRef.current?.alive) return;
          window.clearTimeout(lifecycleRef.current.timer);
          lifecycleRef.current.documentLoaded = false;
          lifecycleRef.current.ready = false;
          callbacksRef.current.onLoaded(frameKey, false, deviceId);
          trace('iframe-error', { reason: 'load-error', result: 'iframe-error' });
          callbacksRef.current.onFailure(deviceId, routeId, 'load-error', frameKey);
        },
      });
    }
