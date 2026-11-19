    // layout 提供本机主面板切换；shortcuts 防止浏览器级监听被宿主提前消费。
    // layout 提供本机主面板切换；shortcuts 防止浏览器级监听被宿主提前消费；
    // uiWorkspace / sessions 供内置待办面板跳转和读取当前会话。
    const inject = ['slots', 'layout', 'shortcuts', 'uiWorkspace', 'sessions'];

    // ===== 窗口位置记忆 =====
    // DSH 桌面端的 Electron 窗口允许渲染进程用 moveTo/resizeTo 直接改位置与大小，
    // 所以位置、尺寸、所在显示器都能零权限还原；原生全屏无法从前端触发，
    // 全屏状态按"铺满记录时所在的显示器"还原。
    const WINDOW_STATE_POLL_MS = 1500;
    const WINDOW_STATE_SAVE_DEBOUNCE_MS = 600;
    let windowStateController = null;

    /** 只有桌面壳层的顶层窗口才有窗口坐标系；浏览器标签页、受控 iframe 一律不参与。 */
    function canRememberWindow() {
      return typeof window !== 'undefined'
        && window.top === window
        && !isControlledFrame()
        && isElectronShell()
        && window.outerWidth > 0;
    }

    /** 读取当前显示器可用区域（不含菜单栏/任务栏），坐标与 Electron 一致为 DIP。 */
    function readDisplayRect() {
      const screen = window.screen;
      return {
        availLeft: Math.round(screen.availLeft ?? 0),
        availTop: Math.round(screen.availTop ?? 0),
        availWidth: Math.round(screen.availWidth || screen.width),
        availHeight: Math.round(screen.availHeight || screen.height),
      };
    }

    /**
     * 读取当前窗口几何。原生全屏时渲染进程只能看到"铺满整块屏幕"，
     * 用整块屏幕尺寸判定（最大化只等于可用区域高度，因此不会被误判）。
     * 在 Windows 下，最大化窗口通过 bounds 覆盖或超出显示器可用工作区进行识别。
     */
    function readWindowGeometry() {
      const screen = window.screen;
      const bounds = {
        x: Math.round(window.screenX),
        y: Math.round(window.screenY),
        width: Math.round(window.outerWidth),
        height: Math.round(window.outerHeight),
      };
      const display = readDisplayRect();
      const fullscreen = Boolean(document.fullscreenElement)
        || (bounds.width >= screen.width - 2 && bounds.height >= screen.height - 2);
      // Windows 最大化特征：不是全屏，且 outer 尺寸覆盖了可用工作区（由于不可见边框，outerWidth/Height >= availWidth/Height）
      const maximized = !fullscreen && (
        bounds.width >= display.availWidth - 4 && bounds.height >= display.availHeight - 4
      );
      return { bounds, display, fullscreen, maximized, savedAt: new Date().toISOString() };
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /** 台前调度只在应用处于前台时把跨屏搬迁当正常摆放，否则会把窗口折进侧边条。 */
    async function waitForWindowFocus(timeout = 3000) {
      if (document.hasFocus()) return true;
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        await sleep(100);
        if (document.hasFocus()) return true;
      }
      return false;
    }

    const isSameBounds = (left, right) => Math.abs(left.x - right.x) <= 4
      && Math.abs(left.y - right.y) <= 4
      && Math.abs(left.width - right.width) <= 4
      && Math.abs(left.height - right.height) <= 4;

    function logWindowRestore(stage, target, landed) {
      try {
        console.info('[dsh-au] window restore', JSON.stringify({ stage, target, landed }));
      } catch {}
    }

    /**
     * 应用还原目标。顺序必须"先搬位置、再改大小"：
     * resizeTo 会被窗口当前所在屏幕夹住，先改大小再搬会得到错误尺寸（副屏上尤其明显）。
     * 若目标为最大化，先定位到目标显示器，再通过宿主原生 API 直接触发系统最大化。
     */
    async function applyRestoreTarget(target) {
      if (!target) return null;
      const isWindows = /Windows|Win32/i.test(navigator.userAgent || '');
      const place = async () => {
        window.moveTo(target.x, target.y);
        await sleep(260);
        window.resizeTo(target.width, target.height);
        await sleep(160);
        if (target.maximized && isWindows) {
          try {
            await callApi('maximizeWindow', {});
            await sleep(200);
          } catch {}
        }
      };
      try {
        await waitForWindowFocus();
        await place();
        window.focus();
        let landed = readWindowGeometry();
        const isMatched = (cand) => target.maximized
          ? cand.maximized
          : isSameBounds(cand.bounds, target);
        if (isMatched(landed)) {
          logWindowRestore('ok', target, landed.bounds);
          return target;
        }
        // 台前调度与显示器热插拔偶尔吞掉第一次，落地校验不过就再来一次。
        await sleep(320);
        await place();
        window.focus();
        landed = readWindowGeometry();
        if (isMatched(landed)) {
          logWindowRestore('retried', target, landed.bounds);
          return target;
        }
        logWindowRestore('missed', target, landed.bounds);
        // 目标显示器可能已被拔掉：按当前显示器重新居中并收敛尺寸。
        const display = readDisplayRect();
        const width = Math.min(target.width, display.availWidth);
        const height = Math.min(target.height, display.availHeight);
        window.moveTo(
          display.availLeft + Math.round((display.availWidth - width) / 2),
          display.availTop + Math.round((display.availHeight - height) / 2)
        );
        await sleep(260);
        window.resizeTo(width, height);
      } catch {
        return null;
      }
      return null;
    }

    const windowStateStore = {
      snapshot: { enabled: false, geometry: null, supported: canRememberWindow(), busy: false, error: '' },
      listeners: new Set(),
    };

    function publishWindowState(patch) {
      windowStateStore.snapshot = { ...windowStateStore.snapshot, ...patch };
      for (const listener of windowStateStore.listeners) listener(windowStateStore.snapshot);
    }

    function useWindowState() {
      const [snapshot, setSnapshot] = useState(windowStateStore.snapshot);
      useEffect(() => {
        windowStateStore.listeners.add(setSnapshot);
        setSnapshot(windowStateStore.snapshot);
        return () => { windowStateStore.listeners.delete(setSnapshot); };
      }, []);
      return snapshot;
    }

    /** 上次记录的可读摘要；没有记录时说明开启后的行为。 */
    function describeWindowGeometry(geometry) {
      if (!geometry) return '还没有记录：开启后会在关闭 DSH 前自动记下窗口位置。';
      const { bounds, display, fullscreen, maximized, savedAt } = geometry;
      const at = new Date(savedAt);
      const pad = (value) => String(value).padStart(2, '0');
      const mode = fullscreen ? '全屏' : (maximized ? '最大化' : '窗口模式');
      const parts = [
        `${bounds.width}×${bounds.height} @ (${bounds.x}, ${bounds.y})`,
        mode,
        display ? `显示器 ${display.availWidth}×${display.availHeight}` : '',
        `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`,
      ].filter(Boolean);
      return `上次记录：${parts.join(' · ')}`;
    }

    /**
     * 窗口记忆控制器：开启时采样并持久化几何，启动时按记录还原一次。
     * 采样用轮询而非 resize/move 事件——顶层窗口的位置变化不会派发 DOM 事件。
     */
    function createWindowStateController() {
      let pollTimer = null;
      let saveTimer = null;
      let lastSaved = '';
      let disposed = false;

      const saveGeometry = async () => {
        if (disposed || !windowStateStore.snapshot.enabled) return;
        const geometry = readWindowGeometry();
        const signature = JSON.stringify([geometry.bounds, geometry.display, geometry.fullscreen, geometry.maximized]);
        if (signature === lastSaved) return;
        lastSaved = signature;
        try {
          const res = await callApi('saveWindowState', { geometry });
          if (res?.windowState) publishWindowState({ geometry: res.windowState.geometry, error: '' });
        } catch {
          // 失败时清掉签名，让下一轮轮询重试同一次几何变化。
          lastSaved = '';
          publishWindowState({ error: '窗口位置保存失败，检查 DSH-AU 服务是否在线。' });
        }
      };

      const scheduleSave = () => {
        if (disposed || !windowStateStore.snapshot.enabled) return;
        if (saveTimer) window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => {
          saveTimer = null;
          void saveGeometry();
        }, WINDOW_STATE_SAVE_DEBOUNCE_MS);
      };

      /** 关闭页面前补一次同步上报，避免最后一次拖动没被轮询捕获。 */
      const flushOnHide = () => {
        if (!windowStateStore.snapshot.enabled) return;
        const geometry = readWindowGeometry();
        try {
          fetch('/dsh-au/api', {
            method: 'POST',
            keepalive: true,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'saveWindowState', geometry }),
          }).catch(() => {});
        } catch {}
      };

      const startPolling = () => {
        if (pollTimer || disposed) return;
        pollTimer = window.setInterval(() => {
          const geometry = readWindowGeometry();
          const signature = JSON.stringify([geometry.bounds, geometry.display, geometry.fullscreen, geometry.maximized]);
          if (signature !== lastSaved) scheduleSave();
        }, WINDOW_STATE_POLL_MS);
      };

      const stopPolling = () => {
        if (pollTimer) window.clearInterval(pollTimer);
        if (saveTimer) window.clearTimeout(saveTimer);
        pollTimer = null;
        saveTimer = null;
      };

      return {
        async start() {
          if (!windowStateStore.snapshot.supported) return;
          // 关闭前补报必须先挂上：启动时未开启也要在用户中途打开开关后立即生效。
          window.addEventListener('pagehide', flushOnHide);
          window.addEventListener('beforeunload', flushOnHide);
          try {
            const res = await callApi('getWindowState', {});
            const state = res?.windowState;
            if (!state) return;
            // 记录当前值，避免启动还原后立刻把旧几何又写回去。
            const current = readWindowGeometry();
            lastSaved = JSON.stringify([current.bounds, current.display, current.fullscreen, current.maximized]);
            publishWindowState({ enabled: state.enabled === true, geometry: state.geometry || null, error: '' });
            if (!state.enabled) return;
            // 等首屏布局稳定再挪窗口，避免和 DSH 自身的窗口初始化抢时序。
            await new Promise((resolve) => setTimeout(resolve, 400));
            const targetRes = await callApi('resolveWindowRestore', { display: readDisplayRect() });
            const applied = await applyRestoreTarget(targetRes?.target);
            if (applied) {
              const restored = readWindowGeometry();
              lastSaved = JSON.stringify([restored.bounds, restored.display, restored.fullscreen, restored.maximized]);
              publishWindowState({ geometry: restored });
            }
            startPolling();
          } catch {
            publishWindowState({ error: '窗口位置记录不可用：DSH-AU 服务未响应。' });
          }
        },
        async setEnabled(next) {
          publishWindowState({ busy: true, error: '' });
          try {
            const res = await callApi('saveWindowState', { enabled: Boolean(next) });
            publishWindowState({ enabled: Boolean(next), geometry: res?.windowState?.geometry || null });
            if (next) {
              lastSaved = '';
              await saveGeometry();
              startPolling();
            } else {
              stopPolling();
            }
          } catch {
            publishWindowState({ error: '开关保存失败，检查 DSH-AU 服务是否在线。' });
          } finally {
            publishWindowState({ busy: false });
          }
        },
        dispose() {
          disposed = true;
          stopPolling();
          window.removeEventListener('pagehide', flushOnHide);
          window.removeEventListener('beforeunload', flushOnHide);
        },
      };
    }

