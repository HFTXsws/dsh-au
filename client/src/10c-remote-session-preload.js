    // 远程会话预加载只准备受控端的后端会话缓存；它不打开会话、不改变 mainView，也不触发 Agent。
    const REMOTE_SESSION_PRELOAD_WINDOW_MS = 48 * 60 * 60 * 1000;
    const REMOTE_SESSION_PRELOAD_RETRY_MS = 6000;
    const REMOTE_SESSION_PRELOAD_PAUSE_MS = 1000;
    const REMOTE_SESSION_PRELOAD_TIMEOUT_MS = 12000;
    const REMOTE_SESSION_PRELOAD_MAX_ATTEMPTS = 3;
    const REMOTE_SESSION_PRELOAD_MAX_PER_DEVICE = 24;
    const REMOTE_SESSION_PRELOAD_NAMESPACE = 'dsh-au:session-preload-';
    const REMOTE_SESSION_OPEN_STALL_MS = 3500;
    // 老受控端没有加载状态协议时，最多让出 30 秒；不是把正常前台加载提前判成成功。
    const REMOTE_SESSION_FOREGROUND_WAIT_MS = 30000;
    const REMOTE_SESSION_PRELOAD_PAGE_OPTIONS = {
      maxMessages: 500,
      turnWindow: { minMessages: 50, minTurns: 2 },
    };

    function remoteSessionPreloadTimestamp(value) {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string' && value.trim()) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric;
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
      }
      return NaN;
    }

    function remoteSessionPreloadNow(value) {
      const numeric = remoteSessionPreloadTimestamp(value);
      return Number.isFinite(numeric) ? numeric : Date.now();
    }

    function remoteSessionPreloadIsOffline(item) {
      if (!item || typeof item !== 'object') return true;
      if (item.offline === true || item.online === false || item.connected === false) return true;
      const status = String(item.status || item.statusV2 || item.deviceStatus || '').trim().toLowerCase();
      return ['offline', 'disconnected', 'unreachable', 'unknown'].includes(status);
    }

    function remoteSessionPreloadIsBlankOrArchived(item) {
      if (!item || typeof item !== 'object') return true;
      return item.blank === true || item.archived === true || item.isArchived === true
        || item.archiveState === 'archived' || item.origin === 'subagent';
    }

    function remoteSessionPreloadSessionTimestamp(session) {
      // Only last-activity fields are accepted. In particular, createdAt is deliberately ignored.
      const projectionValues = session?.projections?.values || session?.projectionValues || {};
      const metadata = projectionValues?.sessionListMetadata || {};
      for (const candidate of [
        session?.updatedAt,
        session?.lastActivityAt,
        session?.lastPromptAt,
        metadata.lastPromptAt,
      ]) {
        const timestamp = remoteSessionPreloadTimestamp(candidate);
        if (Number.isFinite(timestamp)) return timestamp;
      }
      return NaN;
    }

    function remoteSessionPreloadSessionId(session) {
      const id = session?.sessionId || session?.id;
      return typeof id === 'string' ? id.trim() : '';
    }

    /** 以最新 last-activity 去重并排序；调用方应传 merged.visible，隐藏工作区不会进入计划。 */
    function collectRecentRemoteSessions(workspaces, { now, localDeviceId } = {}) {
      const current = remoteSessionPreloadNow(now);
      const local = typeof localDeviceId === 'string' ? localDeviceId.trim() : '';
      const cutoff = current - REMOTE_SESSION_PRELOAD_WINDOW_MS;
      const latestByKey = new Map();
      for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
        if (!workspace || typeof workspace !== 'object' || workspace.hidden === true) continue;
        const deviceId = String(workspace.deviceId || workspace.device?.id || '').trim();
        if (!deviceId || deviceId === 'local' || (local && deviceId === local)
          || remoteSessionPreloadIsOffline(workspace) || remoteSessionPreloadIsBlankOrArchived(workspace)) continue;
        for (const session of Array.isArray(workspace.sessions) ? workspace.sessions : []) {
          if (remoteSessionPreloadIsBlankOrArchived(session)
            || remoteSessionPreloadIsOffline(session)) continue;
          const sessionId = remoteSessionPreloadSessionId(session);
          const updatedAt = remoteSessionPreloadSessionTimestamp(session);
          if (!sessionId || !Number.isFinite(updatedAt) || updatedAt < cutoff || updatedAt > current) continue;
          const record = { deviceId, sessionId, updatedAt };
          const key = `${deviceId}\u0000${sessionId}`;
          const previous = latestByKey.get(key);
          if (!previous || updatedAt > previous.updatedAt) latestByKey.set(key, record);
        }
      }
      return [...latestByKey.values()].sort((a, b) => b.updatedAt - a.updatedAt
        || a.deviceId.localeCompare(b.deviceId) || a.sessionId.localeCompare(b.sessionId));
    }

    function remoteSessionPreloadPlanKey(record) {
      return `${record.deviceId}\u0000${record.sessionId}\u0000${record.updatedAt}`;
    }

    function remoteSessionPreloadRequestId(sequence, nonce = '') {
      return `dsh-au-preload-${nonce || 'client'}-${sequence}`.slice(0, 128);
    }

    /**
     * Parent-side scheduler. It never navigates a frame: integrators own hidden-frame creation,
     * while this controller only sends a scoped request after the exact frame reports ready/load.
     */
    function createRemoteSessionPreloadCoordinator({
      findFrame = () => null,
      requestDevicePreload = () => {},
      onDiagnostic = null,
      onPerformance = null,
      now,
      setTimer,
      clearTimer,
    } = {}) {
      const clock = () => remoteSessionPreloadNow(typeof now === 'function' ? now() : now);
      const schedule = typeof setTimer === 'function'
        ? setTimer
        : (typeof window !== 'undefined' && typeof window.setTimeout === 'function' ? window.setTimeout.bind(window) : null);
      const cancelTimer = typeof clearTimer === 'function'
        ? clearTimer
        : (typeof window !== 'undefined' && typeof window.clearTimeout === 'function' ? window.clearTimeout.bind(window) : null);
      let disposed = false;
      let sequence = 0;
      const coordinatorNonce = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
      let plan = [];
      let planByKey = new Map();
      let readyDevices = new Set();
      let completed = new Map();
      let attempts = new Map();
      let earlyReadySources = new Set();
      let readyFrameByDevice = new Map();
      let inflight = null;
      let retryTimer = null;
      let pauseUntil = 0;
      let foreground = null;
      let foregroundTimer = null;
      let lastRequestedDevices = '';
      const emitPerformance = (event, details) => {
        try { onPerformance?.({ ...details, event, queueLength: plan.length }); } catch {}
      };

      const emitDiagnostic = (current, result, reason = '') => {
        if (typeof onDiagnostic !== 'function' || !current) return;
        try {
          onDiagnostic({
            deviceId: current.deviceId,
            sessionId: current.sessionId,
            requestId: current.requestId,
            stage: current.stage || 'waiting-reply',
            attempt: (attempts.get(remoteSessionPreloadPlanKey(current.record)) || 0) + 1,
            result,
            reason: String(reason || result || '').slice(0, 64),
            elapsedMs: Math.max(0, clock() - (Number.isFinite(current.startedAt) ? current.startedAt : clock())),
          });
        } catch {}
      };

      const timerClear = (timer) => { if (timer !== null && timer !== undefined) cancelTimer?.(timer); };
      const findFrameFor = (deviceId) => {
        try { return findFrame(deviceId) || null; } catch { return null; }
      };
      const postToDevice = (deviceId, message) => {
        const frame = findFrameFor(deviceId);
        const target = frame?.contentWindow;
        if (!target || typeof target.postMessage !== 'function') return false;
        try { target.postMessage(message, '*'); return true; } catch { return false; }
      };
      const frameDeviceForSource = (source) => {
        if (!source) return '';
        for (const deviceId of [...new Set([...plan.map((item) => item.deviceId), ...(foreground ? [foreground.deviceId] : [])])]) {
          const frame = findFrameFor(deviceId);
          try {
            if (frame?.contentWindow && frame.contentWindow === source) {
              if (earlyReadySources.has(source)) {
                readyDevices.add(deviceId);
                readyFrameByDevice.set(deviceId, source);
              }
              return deviceId;
            }
          } catch {}
        }
        return '';
      };
      const clearRetry = () => {
        timerClear(retryTimer);
        retryTimer = null;
      };
      const hasRetryableWork = () => plan.some((record) => {
        const key = remoteSessionPreloadPlanKey(record);
        return !completed.has(key) && (attempts.get(key) || 0) < REMOTE_SESSION_PRELOAD_MAX_ATTEMPTS;
      });
      const scheduleRetry = (delay = REMOTE_SESSION_PRELOAD_RETRY_MS) => {
        if (!schedule || retryTimer !== null || disposed || !hasRetryableWork()) return;
        retryTimer = schedule(() => {
          retryTimer = null;
          pump();
        }, Math.max(0, delay));
      };
      const cancelInflight = (reason = 'cancelled', notify = true) => {
        const current = inflight;
        if (!current) return null;
        inflight = null;
        timerClear(current.timeout);
        current.timeout = null;
        if (notify) {
          postToDevice(current.deviceId, {
            source: 'dsh-au', type: `${REMOTE_SESSION_PRELOAD_NAMESPACE}cancel`,
            requestId: current.requestId, deviceId: current.deviceId, sessionId: current.sessionId, reason,
          });
        }
        return current;
      };
      const finishInflight = (result, reason = '') => {
        const current = inflight;
        if (!current) return;
        inflight = null;
        timerClear(current.timeout);
        current.timeout = null;
        emitDiagnostic(current, result, reason || result);
        const key = remoteSessionPreloadPlanKey(current.record);
        if (result === 'ready') {
          completed.set(key, 'ready');
          attempts.delete(key);
        } else if (result === 'unsupported' || result === 'skipped') {
          completed.set(key, result);
          attempts.delete(key);
        } else {
          attempts.set(key, (attempts.get(key) || 0) + 1);
        }
        if (!disposed) {
          if (result === 'ready' || result === 'unsupported' || result === 'skipped') pump();
          else scheduleRetry();
        }
      };
      function pump() {
        if (disposed || inflight || foreground || clock() < pauseUntil) {
          if (!disposed && !foreground && clock() < pauseUntil) scheduleRetry(Math.max(REMOTE_SESSION_PRELOAD_PAUSE_MS, pauseUntil - clock()));
          return;
        }
        for (const record of plan) {
          const key = remoteSessionPreloadPlanKey(record);
          if (completed.has(key) || (attempts.get(key) || 0) >= REMOTE_SESSION_PRELOAD_MAX_ATTEMPTS) continue;
          const frame = findFrameFor(record.deviceId);
          if (!frame?.contentWindow || !readyDevices.has(record.deviceId)
            || readyFrameByDevice.get(record.deviceId) !== frame.contentWindow) {
            readyDevices.delete(record.deviceId);
            readyFrameByDevice.delete(record.deviceId);
            continue;
          }
          const requestId = remoteSessionPreloadRequestId(++sequence, coordinatorNonce);
          const current = { ...record, requestId, timeout: null, record, startedAt: clock() };
          inflight = current;
          const sent = postToDevice(record.deviceId, {
            source: 'dsh-au', type: `${REMOTE_SESSION_PRELOAD_NAMESPACE}request`, requestId,
            deviceId: record.deviceId, sessionId: record.sessionId, updatedAt: record.updatedAt,
          });
          if (!sent) {
            inflight = null;
            attempts.set(key, (attempts.get(key) || 0) + 1);
            scheduleRetry();
            return;
          }
          if (schedule) {
            current.timeout = schedule(() => {
              if (inflight?.requestId !== requestId) return;
              const timedOut = cancelInflight('timeout');
              if (!timedOut) return;
              emitDiagnostic(timedOut, 'timeout', 'timeout');
              const timedOutKey = remoteSessionPreloadPlanKey(timedOut.record);
              attempts.set(timedOutKey, (attempts.get(timedOutKey) || 0) + 1);
              scheduleRetry();
            }, REMOTE_SESSION_PRELOAD_TIMEOUT_MS);
          }
          return;
        }
        if (hasRetryableWork()) scheduleRetry();
      }
      const updatePlan = (nextPlan) => {
        if (disposed) return;
        const normalized = [];
        const seen = new Set();
        const current = clock();
        const cutoff = current - REMOTE_SESSION_PRELOAD_WINDOW_MS;
        for (const raw of Array.isArray(nextPlan) ? nextPlan : []) {
          const deviceId = String(raw?.deviceId || '').trim();
          const sessionId = String(raw?.sessionId || '').trim();
          const updatedAt = remoteSessionPreloadTimestamp(raw?.updatedAt);
          if (!deviceId || !sessionId || !Number.isFinite(updatedAt) || updatedAt < cutoff || updatedAt > current) continue;
          const record = { deviceId, sessionId, updatedAt };
          const key = remoteSessionPreloadPlanKey(record);
          if (!seen.has(key)) { seen.add(key); normalized.push(record); }
        }
        normalized.sort((a, b) => b.updatedAt - a.updatedAt
          || a.deviceId.localeCompare(b.deviceId) || a.sessionId.localeCompare(b.sessionId));
        const nextByKey = new Map(normalized.map((record) => [remoteSessionPreloadPlanKey(record), record]));
        for (const [key, oldRecord] of planByKey) {
          if (nextByKey.has(key)) continue;
          completed.delete(key);
          attempts.delete(key);
          postToDevice(oldRecord.deviceId, {
            source: 'dsh-au', type: `${REMOTE_SESSION_PRELOAD_NAMESPACE}prune`,
            deviceId: oldRecord.deviceId, sessionId: oldRecord.sessionId, updatedAt: oldRecord.updatedAt,
          });
        }
        if (inflight && !nextByKey.has(remoteSessionPreloadPlanKey(inflight.record))) cancelInflight('plan-pruned');
        plan = normalized;
        planByKey = nextByKey;
        const devices = [...new Set(plan.map((record) => record.deviceId))];
        const signature = devices.join('\u0000');
        for (const deviceId of devices) {
          const contentWindow = findFrameFor(deviceId)?.contentWindow;
          if (contentWindow && earlyReadySources.has(contentWindow)) {
            readyDevices.add(deviceId);
            readyFrameByDevice.set(deviceId, contentWindow);
          }
        }
        const missingFrame = devices.some((deviceId) => !findFrameFor(deviceId)?.contentWindow);
        if (signature !== lastRequestedDevices || missingFrame) {
          try { requestDevicePreload(devices); } catch {}
        }
        lastRequestedDevices = devices.length ? signature : '';
        pump();
      };
      const handleMessage = (event) => {
        if (disposed || event?.data?.source !== 'dsh-au') return false;
        const data = event.data;
        const frameEvent = data.type === 'frame-ready' || data.type === 'frame-loaded'
          || data.type === 'dsh-au:frame-ready' || data.type === 'dsh-au:frame-loaded'
          || data.type === 'dsh-au:controlled-workspaces-snapshot';
        const deviceId = frameDeviceForSource(event.source);
        if (!deviceId) {
          // Before a plan exists, retain only a browsing-context-shaped source; later promotion
          // still requires exact identity against findFrame(deviceId).
          if (frameEvent && typeof event.source?.postMessage === 'function') earlyReadySources.add(event.source);
          return frameEvent && typeof event.source?.postMessage === 'function';
        }
        if (data.type === `${REMOTE_SESSION_PRELOAD_NAMESPACE}foreground-state`) {
          const stages = ['open-start', 'open-dispatched', 'window-ready', 'stall-resync', 'resync-failed', 'follow-settled', 'already-open'];
          if (data.deviceId !== deviceId || typeof data.sessionId !== 'string' || !stages.includes(data.stage)
            || !Number.isSafeInteger(data.generation) || data.generation < 0) return false;
          emitPerformance('session-open', data);
          if (foreground?.deviceId === deviceId && foreground.sessionId === data.sessionId && data.foregroundId === foreground.foregroundId) {
            if (foreground.generation !== undefined && data.generation < foreground.generation) return true;
            foreground.generation = data.generation;
            // 收到新版真实状态后不再按旧端超时放行，慢前台不会重新和后台抢资源。
            timerClear(foregroundTimer);
            foregroundTimer = null;
            if (data.stage === 'follow-settled' || data.stage === 'already-open') settleForeground(data.result || 'settled');
          }
          return true;
        }
        if (frameEvent) {
          readyDevices.add(deviceId);
          readyFrameByDevice.set(deviceId, event.source);
          if (foreground?.deviceId === deviceId) postToDevice(deviceId, {
            source: 'dsh-au', type: `${REMOTE_SESSION_PRELOAD_NAMESPACE}foreground-select`,
            deviceId, sessionId: foreground.sessionId, foregroundId: foreground.foregroundId,
          });
          pump();
          return true;
        }
        if (!String(data.type || '').startsWith(REMOTE_SESSION_PRELOAD_NAMESPACE)) return false;
        if (!inflight || deviceId !== inflight.deviceId || data.requestId !== inflight.requestId
          || data.deviceId !== inflight.deviceId || data.sessionId !== inflight.sessionId) return false;
        if (data.updatedAt !== undefined && remoteSessionPreloadTimestamp(data.updatedAt) !== inflight.updatedAt) return false;
        if (data.type === `${REMOTE_SESSION_PRELOAD_NAMESPACE}stage`) {
          inflight.stage = String(data.stage || '').slice(0, 64);
          emitPerformance('session-preload-stage', data);
          return true;
        }
        if (data.type === `${REMOTE_SESSION_PRELOAD_NAMESPACE}ready`) finishInflight('ready', data.reason);
        else if (data.type === `${REMOTE_SESSION_PRELOAD_NAMESPACE}unsupported`) finishInflight('unsupported', data.reason);
        else if (data.type === `${REMOTE_SESSION_PRELOAD_NAMESPACE}skipped`) finishInflight('skipped', data.reason);
        else if (data.type === `${REMOTE_SESSION_PRELOAD_NAMESPACE}error`) finishInflight('error', data.reason);
        else return false;
        return true;
      };
      const settleForeground = (result) => {
        if (!foreground) return;
        const current = foreground;
        foreground = null;
        timerClear(foregroundTimer);
        foregroundTimer = null;
        emitPerformance('session-open', { ...current, stage: 'foreground-settled', result, elapsedMs: Math.max(0, clock() - current.startedAt) });
        pauseUntil = clock() + REMOTE_SESSION_PRELOAD_PAUSE_MS;
        clearRetry();
        scheduleRetry(REMOTE_SESSION_PRELOAD_PAUSE_MS);
      };
      const notifyForeground = (deviceId, sessionId) => {
        if (disposed) return;
        const cleanDevice = String(deviceId || '').trim();
        const cleanSession = String(sessionId || '').trim();
        timerClear(foregroundTimer);
        foregroundTimer = null;
        foreground = null;
        pauseUntil = clock() + REMOTE_SESSION_PRELOAD_PAUSE_MS;
        // 同一个目标也要取消后台分页：点击后的实时流才是前台历史窗口的唯一写入者。
        cancelInflight('foreground');
        clearRetry();
        if (cleanDevice && cleanDevice !== 'local' && cleanSession) {
          const foregroundId = remoteSessionPreloadRequestId(++sequence, coordinatorNonce);
          foreground = { deviceId: cleanDevice, sessionId: cleanSession, foregroundId, startedAt: clock() };
          emitPerformance('session-open', { ...foreground, stage: 'foreground-wait', result: 'loading', elapsedMs: 0 });
          if (schedule) foregroundTimer = schedule(() => settleForeground('status-timeout'), REMOTE_SESSION_FOREGROUND_WAIT_MS);
          postToDevice(cleanDevice, { source: 'dsh-au', type: `${REMOTE_SESSION_PRELOAD_NAMESPACE}foreground-select`,
            deviceId: cleanDevice, sessionId: cleanSession, foregroundId });
        } else {
          scheduleRetry(REMOTE_SESSION_PRELOAD_PAUSE_MS);
        }
      };
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        clearRetry();
        timerClear(foregroundTimer);
        foregroundTimer = null;
        foreground = null;
        cancelInflight('dispose');
        for (const record of plan) {
          postToDevice(record.deviceId, {
            source: 'dsh-au', type: `${REMOTE_SESSION_PRELOAD_NAMESPACE}prune`,
            deviceId: record.deviceId, sessionId: record.sessionId, updatedAt: record.updatedAt,
          });
        }
        plan = [];
        planByKey.clear();
        readyDevices.clear();
        readyFrameByDevice.clear();
        earlyReadySources.clear();
        completed.clear();
        attempts.clear();
      };
      return { updatePlan, handleMessage, notifyForeground, dispose };
    }

    function remoteSessionPreloadCatalog(ctx) {
      const uiWorkspace = ctx?.get?.('uiWorkspace') || ctx?.uiWorkspace;
      return ctx?.get?.('sessions') || ctx?.sessions || uiWorkspace?.sessions || null;
    }

    function remoteSessionPreloadCatalogRows(ctx) {
      const snapshot = remoteSessionPreloadCatalog(ctx)?.list?.getSnapshot?.() || {};
      if (Array.isArray(snapshot.items)) return snapshot.items;
      if (snapshot.byId && typeof snapshot.byId === 'object') return Object.values(snapshot.byId);
      return [];
    }

    function remoteSessionPreloadClientId() {
      if (typeof window === 'undefined') return 'dsh-au-preload-client';
      if (!window.__dshAuSessionPreloadClientId) {
        const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        window.__dshAuSessionPreloadClientId = `dsh-au:${window.name || 'frame'}:${random}`;
      }
      return window.__dshAuSessionPreloadClientId;
    }

    /**
     * 为前端 Session 实例挂载秒开与假死自愈钩子：
     * 1. 若该会话已通过只读分页预热了消息窗口（__dshAuPreloaded），点击打开时在同一同步 tick 将 openState 置为 'open'，
     *    直接渲染已预热消息并初始化滚动，不闪“载入历史…”；后台仍继续建立 follow 实时流。
     * 2. 若实时流因公网隧道瞬断报错，保留已预热的窗口状态避免白屏报错。
     * 3. 若未预热会话在打开时因半死长连接卡在 'loading' 超过阈值，自动触发一次 resync() 重建流。
     */
    // 只给父窗口传时长/状态，不传事件正文；网络断开时仍能由本机统一落日志。
    function postControlledSessionMetric(type, sessionId, details = {}) {
      if (typeof window === 'undefined' || !window.name?.startsWith('dsh-au-controlled:')) return;
      try {
        const selection = window.__dshAuForegroundSelection;
        window.parent?.postMessage({ source: 'dsh-au', type: `${REMOTE_SESSION_PRELOAD_NAMESPACE}${type}`,
          deviceId: window.name.slice('dsh-au-controlled:'.length), sessionId, ...details,
          foregroundId: details.foregroundId ?? (selection?.sessionId === sessionId ? selection.foregroundId : '') }, '*');
      } catch {}
    }

    function sessionPerformanceNow() {
      return typeof window !== 'undefined' && typeof window.performance?.now === 'function' ? window.performance.now() : Date.now();
    }

    function installSessionInstantOpenHook(session, manager = null) {
      if (!session || typeof session !== 'object' || typeof session.doOpen !== 'function' || session.__dshAuInstantOpenHooked) {
        return session;
      }
      const origDoOpen = session.doOpen;
      Object.defineProperty(session, '__dshAuInstantOpenHooked', { value: true, configurable: true });
      session.doOpen = function patchedDoOpen(generation, ...rest) {
        const hadPreloaded = Boolean(this.__dshAuPreloaded);
        const startedAt = sessionPerformanceNow();
        const selection = typeof window !== 'undefined' ? window.__dshAuForegroundSelection : null;
        const foregroundId = selection?.sessionId === this.sessionId ? selection.foregroundId : '';
        const trace = (stage, result, extra = {}) => postControlledSessionMetric('foreground-state', this.sessionId, {
          stage, result, generation, foregroundId, cacheHit: hadPreloaded, elapsedMs: Math.max(0, sessionPerformanceNow() - startedAt), ...extra,
        });
        let stallTimer = null;
        trace('open-start', 'loading');
        const tryRecoverReleasedRef = (error) => {
          const msg = String(error?.message || error || this.openError?.message || this.openError || '');
          if (!/is released/i.test(msg)) return null;
          try { delete this.__dshAuPreloaded; } catch { this.__dshAuPreloaded = null; }
          if (this.__dshAuReleasedRetried) return null;
          this.__dshAuReleasedRetried = true;
          trace('released-retry', 'retrying');
          try {
            if (manager?.sessions?.get?.(this.sessionId) === this && typeof manager.sessions?.delete === 'function') {
              manager.sessions.delete(this.sessionId);
              const fresh = typeof manager.get === 'function' ? manager.get(this.sessionId) : null;
              if (fresh && fresh !== this) {
                if (typeof fresh.open === 'function') return Promise.resolve(fresh.open());
                if (typeof fresh.doOpen === 'function') return Promise.resolve(fresh.doOpen(fresh.openGeneration ?? generation, ...rest));
              }
            }
          } catch {}
          if (typeof this.resync === 'function') {
            return Promise.resolve(this.resync());
          }
          return null;
        };
        const finish = () => {
          if (stallTimer !== null && typeof clearTimeout === 'function') clearTimeout(stallTimer);
          if (generation !== this.openGeneration) return;
          const failed = this.openState === 'error';
          if (this.openState === 'open') {
            this.__dshAuStallRetried = false;
            this.__dshAuReleasedRetried = false;
          }
          if (failed && /is released/i.test(String(this.openError?.message || this.openError || ''))) {
            const recovery = tryRecoverReleasedRef(this.openError);
            if (recovery) {
              recovery.catch(() => trace('released-retry-failed', 'error'));
              return;
            }
          }
          if (hadPreloaded && failed) {
            this.openState = 'open';
            this.openError = null;
            try { this.notifier?.markDirty?.(); } catch {}
          }
          trace('follow-settled', failed ? (hadPreloaded ? 'cached-fallback' : 'error') : this.openState);
        };
        if (!hadPreloaded && typeof setTimeout === 'function') {
          stallTimer = setTimeout(() => {
            stallTimer = null;
            if (this.openState === 'loading' && this.openGeneration === generation && !this.__dshAuStallRetried) {
              this.__dshAuStallRetried = true;
              trace('stall-resync', 'retrying');
              try { Promise.resolve(this.resync?.()).catch(() => trace('resync-failed', 'error')); } catch { trace('resync-failed', 'error'); }
            }
          }, REMOTE_SESSION_OPEN_STALL_MS);
        }
        let promise;
        try { promise = origDoOpen.call(this, generation, ...rest); }
        catch (error) {
          const recovery = tryRecoverReleasedRef(error);
          if (recovery) {
            if (stallTimer !== null && typeof clearTimeout === 'function') clearTimeout(stallTimer);
            return recovery;
          }
          finish();
          throw error;
        }
        if (hadPreloaded && this.openState === 'loading') {
          this.openState = 'open';
          this.openError = null;
          try { this.notifier?.markDirty?.(); } catch {}
          trace('window-ready', 'cached', { recordCount: this.__dshAuPreloaded.count || 0 });
        }
        trace('open-dispatched', this.openState, { syncMs: Math.max(0, sessionPerformanceNow() - startedAt) });
        if (promise && typeof promise.then === 'function') {
          return promise.then(
            (val) => { finish(); return val; },
            (error) => {
              const recovery = tryRecoverReleasedRef(error);
              if (recovery) {
                if (stallTimer !== null && typeof clearTimeout === 'function') clearTimeout(stallTimer);
                return recovery;
              }
              finish();
              throw error;
            }
          );
        }
        finish();
        return promise;
      };
      return session;
    }

    /**
     * 使用宿主只读分页接口（remote.session.page，不唤醒休眠 Agent）将最近一屏聊天记录预热进浏览器 Session 实例。
     * 当缺少 manager.remote.session.page 或有效 cursor 时同步返回 null，确保不增加额外微任务。
     */
    function warmClientSessionWindow(ctx, entry, result, signal) {
      const catalog = remoteSessionPreloadCatalog(ctx);
      const manager = catalog?.manager;
      const cursor = Number.isSafeInteger(result?.cursor) ? result.cursor : null;
      if (cursor === null || cursor < -1 || typeof manager?.remote?.session?.page !== 'function' || typeof manager?.get !== 'function') {
        return null;
      }
      try { Promise.resolve(catalog.refreshProjections?.(entry.sessionId)).catch(() => {}); } catch {}
      const pageStartedAt = sessionPerformanceNow();
      entry.onStage?.('page', 'loading');
      return Promise.resolve(manager.remote.session.page({
        address: { kind: 'session', sessionId: entry.sessionId },
        throughSeq: cursor,
        ...REMOTE_SESSION_PRELOAD_PAGE_OPTIONS,
      }, signal)).then((pageRes) => {
        entry.pageMs = Math.max(0, sessionPerformanceNow() - pageStartedAt);
        if (signal?.aborted || !pageRes?.ok || !Array.isArray(pageRes.value?.records)) return false;
        const session = manager.get(entry.sessionId);
        if (!session || typeof session.installWindow !== 'function' || session.openState !== 'cold') return false;
        installSessionInstantOpenHook(session, manager);
        const installStartedAt = sessionPerformanceNow();
        session.installWindow(pageRes.value.records, Boolean(pageRes.value.hasMore));
        session.__dshAuPreloaded = {
          updatedAt: entry.updatedAt,
          cursor,
          count: pageRes.value.records.length,
        };
        entry.recordCount = pageRes.value.records.length;
        entry.installMs = Math.max(0, sessionPerformanceNow() - installStartedAt);
        entry.onStage?.('window-installed', 'ready');
        return true;
      }).catch(() => false);
    }

    function installControlledSessionPreload(ctx) {
      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {};
      const parentWindow = window.parent;
      const clientId = remoteSessionPreloadClientId();
      const inflight = new Map();
      const activeByKey = new Map();
      const cacheByDevice = new Map();
      let disposed = false;

      const catalog = remoteSessionPreloadCatalog(ctx);
      const manager = catalog?.manager;
      const origManagerGet = typeof manager?.get === 'function' ? manager.get : null;
      if (manager && origManagerGet) {
        manager.get = function patchedManagerGet(sessionId, ...rest) {
          const session = origManagerGet.call(this, sessionId, ...rest);
          return installSessionInstantOpenHook(session, manager);
        };
      }

      const postParent = (message) => {
        if (!parentWindow || typeof parentWindow.postMessage !== 'function') return;
        try { parentWindow.postMessage(message, '*'); } catch {}
      };
      const releaseRef = (entry, sessionId = '') => {
        if (!entry || entry.released) return;
        entry.released = true;
        try { entry.ref?.release?.(); } catch {}
        if (sessionId && entry.requestId) {
          // Per-request cancellation cannot accidentally release a newer lease for the same session.
          void api('cancelSessionPreload', { clientId, requestId: entry.requestId }, undefined).catch(() => {});
        }
      };
      const rowFor = (sessionId) => remoteSessionPreloadCatalogRows(ctx).find((row) => remoteSessionPreloadSessionId(row) === sessionId) || null;
      const rowTimestamp = (row) => remoteSessionPreloadSessionTimestamp(row);
      const expectedDeviceId = () => {
        const name = typeof window.name === 'string' ? window.name : '';
        return name.startsWith(typeof CONTROLLED_FRAME_NAME_PREFIX === 'string' ? CONTROLLED_FRAME_NAME_PREFIX : 'dsh-au-controlled:')
          ? name.slice((typeof CONTROLLED_FRAME_NAME_PREFIX === 'string' ? CONTROLLED_FRAME_NAME_PREFIX : 'dsh-au-controlled:').length)
          : '';
      };
      const validRequest = (data) => {
        const deviceId = typeof data?.deviceId === 'string' ? data.deviceId.trim() : '';
        const sessionId = typeof data?.sessionId === 'string' ? data.sessionId.trim() : '';
        const requestId = typeof data?.requestId === 'string' ? data.requestId.trim() : '';
        const updatedAt = remoteSessionPreloadTimestamp(data?.updatedAt);
        const current = Date.now();
        if (!deviceId || !sessionId || !requestId || deviceId.length > 128 || sessionId.length > 256 || requestId.length > 256) return null;
        const expected = expectedDeviceId();
        if (expected && expected !== deviceId) return null;
        if (!Number.isFinite(updatedAt) || updatedAt < current - REMOTE_SESSION_PRELOAD_WINDOW_MS || updatedAt > current) return null;
        const row = rowFor(sessionId);
        if (!row || remoteSessionPreloadIsBlankOrArchived(row) || remoteSessionPreloadIsOffline(row)) return null;
        const catalogUpdatedAt = rowTimestamp(row);
        if (!Number.isFinite(catalogUpdatedAt) || catalogUpdatedAt < current - REMOTE_SESSION_PRELOAD_WINDOW_MS
          || catalogUpdatedAt > current) return null;
        return { deviceId, sessionId, requestId, updatedAt, row };
      };
      const requestShape = (data) => {
        const deviceId = typeof data?.deviceId === 'string' ? data.deviceId.trim() : '';
        const sessionId = typeof data?.sessionId === 'string' ? data.sessionId.trim() : '';
        const requestId = typeof data?.requestId === 'string' ? data.requestId.trim() : '';
        const updatedAt = remoteSessionPreloadTimestamp(data?.updatedAt);
        const expected = expectedDeviceId();
        const current = Date.now();
        if (!deviceId || !sessionId || !requestId || deviceId.length > 128 || sessionId.length > 256
          || requestId.length > 256 || (expected && expected !== deviceId) || !Number.isFinite(updatedAt)
          || updatedAt < current - REMOTE_SESSION_PRELOAD_WINDOW_MS || updatedAt > current) return null;
        return { deviceId, sessionId, requestId, updatedAt };
      };
      const api = async (action, payload, signal) => {
        const response = await fetch('/dsh-au/api', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, ...payload }), signal,
        });
        const raw = await response.text();
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        return data;
      };
      const pruneCache = (now = Date.now()) => {
        for (const [deviceId, entries] of cacheByDevice) {
          for (const [sessionId, entry] of entries) {
            if (entry.expiresAt < now) {
              entries.delete(sessionId);
              releaseRef(entry, sessionId);
            }
          }
          const newest = [...entries.entries()].sort((a, b) => b[1].updatedAt - a[1].updatedAt);
          for (const [sessionId, entry] of newest.slice(REMOTE_SESSION_PRELOAD_MAX_PER_DEVICE)) {
            entries.delete(sessionId);
            releaseRef(entry, sessionId);
          }
          if (!entries.size) cacheByDevice.delete(deviceId);
        }
      };
      const cancel = (entry, reason = 'cancelled') => {
        if (!entry || entry.cancelled) return;
        entry.onStage?.(entry.stage || 'backend', 'cancelled');
        entry.cancelled = true;
        try { entry.controller.abort(); } catch {}
        void api('cancelSessionPreload', { clientId, requestId: entry.requestId }, undefined).catch(() => {});
        inflight.delete(entry.requestId);
        if (activeByKey.get(entry.key) === entry.requestId) activeByKey.delete(entry.key);
        postParent({ source: 'dsh-au', type: `${REMOTE_SESSION_PRELOAD_NAMESPACE}cancelled`,
          requestId: entry.requestId, deviceId: entry.deviceId, sessionId: entry.sessionId, reason });
      };
      const onRequest = (event, data) => {
        if (event.source !== parentWindow) return;
        const shape = requestShape(data);
        if (!shape) return;
        const request = validRequest(data);
        if (!request) {
          postParent({ source: 'dsh-au', type: `${REMOTE_SESSION_PRELOAD_NAMESPACE}skipped`,
            requestId: shape.requestId, deviceId: shape.deviceId, sessionId: shape.sessionId, updatedAt: shape.updatedAt,
            reason: 'catalog-ineligible' });
          return;
        }
        pruneCache();
        const key = `${request.deviceId}\u0000${request.sessionId}`;
        const cached = cacheByDevice.get(request.deviceId)?.get(request.sessionId);
        if (cached && cached.updatedAt >= request.updatedAt && cached.expiresAt >= Date.now()) {
          postParent({ source: 'dsh-au', type: `${REMOTE_SESSION_PRELOAD_NAMESPACE}stage`, requestId: request.requestId,
            deviceId: request.deviceId, sessionId: request.sessionId, updatedAt: request.updatedAt,
            stage: 'cache-hit', result: 'ready', cacheHit: true, clientReady: cached.clientReady === true, elapsedMs: 0 });
          postParent({ source: 'dsh-au', type: `${REMOTE_SESSION_PRELOAD_NAMESPACE}ready`, requestId: request.requestId,
            deviceId: request.deviceId, sessionId: request.sessionId, updatedAt: request.updatedAt });
          return;
        }
        const resident = manager?.sessions?.get?.(request.sessionId);
        if (resident && resident.openState !== 'cold') {
          postParent({ source: 'dsh-au', type: `${REMOTE_SESSION_PRELOAD_NAMESPACE}skipped`, requestId: request.requestId,
            deviceId: request.deviceId, sessionId: request.sessionId, updatedAt: request.updatedAt, reason: 'foreground-active' });
          return;
        }
        if (activeByKey.has(key)) return;
        const controller = typeof AbortController === 'function' ? new AbortController() : { signal: undefined, abort() {} };
        const entry = { ...request, key, controller, cancelled: false, released: false, startedAt: sessionPerformanceNow(), stage: 'backend' };
        entry.onStage = (stage, result) => {
          entry.stage = stage;
          if (entry.cancelled || disposed) return;
          postParent({ source: 'dsh-au', type: `${REMOTE_SESSION_PRELOAD_NAMESPACE}stage`, requestId: entry.requestId,
            deviceId: entry.deviceId, sessionId: entry.sessionId, updatedAt: entry.updatedAt, stage, result,
            elapsedMs: Math.max(0, sessionPerformanceNow() - entry.startedAt), backendMs: entry.backendMs,
            pageMs: entry.pageMs, installMs: entry.installMs, recordCount: entry.recordCount,
            clientReady: entry.clientReady === true, cacheHit: false });
        };
        entry.onStage('backend', 'loading');
        activeByKey.set(key, entry.requestId);
        inflight.set(entry.requestId, entry);
        // Backend preparation is intentionally explicit; generic sessions.retain is unsafe because it may promote a dormant Agent.
        void api('preloadSession', { clientId, requestId: entry.requestId, sessionId: entry.sessionId, updatedAt: entry.updatedAt }, controller.signal)
          .then(async (result) => {
            if (entry.cancelled || disposed) return;
            entry.backendMs = Math.max(0, sessionPerformanceNow() - entry.startedAt);
            entry.onStage('backend-prepared', result?.result || 'invalid-result');
            const responseIdentity = result?.sessionId === entry.sessionId
              && remoteSessionPreloadTimestamp(result?.updatedAt) === entry.updatedAt;
            const exact = responseIdentity && result?.ok === true && result?.result === 'ready';
            // 分页与安装都属于这个可取消请求；不能在仅后端就绪时撤掉索引。
            if (!exact) {
              void api('cancelSessionPreload', { clientId, requestId: entry.requestId }, undefined).catch(() => {});
              const terminal = !responseIdentity ? 'error'
                : result?.result === 'unsupported' ? 'unsupported' : result?.result === 'skipped' ? 'skipped' : 'error';
              postParent({ source: 'dsh-au', type: `${REMOTE_SESSION_PRELOAD_NAMESPACE}${terminal}`,
                requestId: entry.requestId, deviceId: entry.deviceId, sessionId: entry.sessionId, updatedAt: entry.updatedAt,
                reason: result?.result || 'invalid-result' });
              return;
            }
            const warmTask = warmClientSessionWindow(ctx, entry, result, controller.signal);
            const clientReady = warmTask === null ? null : await warmTask;
            if (entry.cancelled || disposed || controller.signal?.aborted) return;
            if (clientReady === false) {
              entry.onStage('window-failed', 'error');
              void api('cancelSessionPreload', { clientId, requestId: entry.requestId }, undefined).catch(() => {});
              postParent({ source: 'dsh-au', type: `${REMOTE_SESSION_PRELOAD_NAMESPACE}error`, requestId: entry.requestId,
                deviceId: entry.deviceId, sessionId: entry.sessionId, updatedAt: entry.updatedAt, reason: 'client-window-failed' });
              return;
            }
            // 旧宿主缺少分页接口时仍保留后端预热，但日志明确标为 backend-only，绝不冒称正文秒开。
            entry.clientReady = clientReady === true;
            const finalizeReady = () => {
              if (entry.cancelled || disposed) return;
              const deviceEntries = cacheByDevice.get(entry.deviceId) || new Map();
              const previous = deviceEntries.get(entry.sessionId);
              if (previous && previous.updatedAt >= entry.updatedAt) {
                // Backend already prepared this version; cancel the duplicate HOST lease only.
                void api('cancelSessionPreload', { clientId, requestId: entry.requestId }, undefined).catch(() => {});
                deviceEntries.set(entry.sessionId, previous);
              } else {
                if (previous) releaseRef(previous, entry.sessionId);
                const cacheEntry = { ref: null, requestId: entry.requestId, updatedAt: entry.updatedAt, expiresAt: entry.updatedAt + REMOTE_SESSION_PRELOAD_WINDOW_MS, released: false, clientReady: entry.clientReady };
                deviceEntries.set(entry.sessionId, cacheEntry);
                for (const [sid, old] of [...deviceEntries.entries()].sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(REMOTE_SESSION_PRELOAD_MAX_PER_DEVICE)) {
                  deviceEntries.delete(sid);
                  releaseRef(old, sid);
                }
              }
              cacheByDevice.set(entry.deviceId, deviceEntries);
              postParent({ source: 'dsh-au', type: `${REMOTE_SESSION_PRELOAD_NAMESPACE}ready`,
                requestId: entry.requestId, deviceId: entry.deviceId, sessionId: entry.sessionId, updatedAt: entry.updatedAt });
            };
            entry.onStage('complete', entry.clientReady ? 'window-ready' : 'backend-only');
            finalizeReady();
          })
          .catch((error) => {
            if (entry.cancelled || disposed) return;
            entry.onStage(entry.stage, 'error');
            void api('cancelSessionPreload', { clientId, requestId: entry.requestId }, undefined).catch(() => {});
            postParent({ source: 'dsh-au', type: `${REMOTE_SESSION_PRELOAD_NAMESPACE}error`, requestId: entry.requestId,
              deviceId: entry.deviceId, sessionId: entry.sessionId, updatedAt: entry.updatedAt, reason: 'request-failed' });
          }).finally(() => {
            if (inflight.get(entry.requestId) === entry) inflight.delete(entry.requestId);
            if (activeByKey.get(entry.key) === entry.requestId) activeByKey.delete(entry.key);
          });
      };
      const onCancelOrPrune = (event, data) => {
        if (event.source !== parentWindow || data?.source !== 'dsh-au') return;
        const deviceId = typeof data.deviceId === 'string' ? data.deviceId.trim() : '';
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
        if (!deviceId || !sessionId) return;
        if (data.type === `${REMOTE_SESSION_PRELOAD_NAMESPACE}cancel`) {
          const requestId = typeof data.requestId === 'string' ? data.requestId.trim() : '';
          const entry = requestId ? inflight.get(requestId) : [...inflight.values()].find((item) => item.deviceId === deviceId && item.sessionId === sessionId);
          cancel(entry, data.reason || 'cancelled');
        }
        if (data.type === `${REMOTE_SESSION_PRELOAD_NAMESPACE}prune`) {
          const entries = cacheByDevice.get(deviceId);
          const entry = entries?.get(sessionId);
          const pruneAt = remoteSessionPreloadTimestamp(data.updatedAt);
          if (entry && (!Number.isFinite(pruneAt) || pruneAt >= entry.updatedAt)) {
            entries.delete(sessionId);
            releaseRef(entry, sessionId);
            const preloadedSession = manager?.sessions?.get?.(sessionId) || (typeof manager?.get === 'function' ? manager.get(sessionId) : null);
            if (preloadedSession?.openState === 'cold' && preloadedSession.__dshAuPreloaded) {
              try { delete preloadedSession.__dshAuPreloaded; } catch { preloadedSession.__dshAuPreloaded = null; }
            }
          }
          if (!entries?.size) cacheByDevice.delete(deviceId);
          for (const entry of [...inflight.values()]) {
            if (entry.deviceId === deviceId && entry.sessionId === sessionId
              && (!Number.isFinite(pruneAt) || pruneAt >= entry.updatedAt)) cancel(entry, 'pruned');
          }
        }
      };
      const onMessage = (event) => {
        if (disposed || event.source !== parentWindow || event.data?.source !== 'dsh-au') return;
        if (event.data.type === `${REMOTE_SESSION_PRELOAD_NAMESPACE}foreground-select`) {
          const data = event.data;
          if (data.deviceId !== expectedDeviceId() || typeof data.sessionId !== 'string' || !data.sessionId || data.sessionId.length > 256
            || typeof data.foregroundId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.foregroundId)) return;
          if (window.__dshAuForegroundSelection?.foregroundId === data.foregroundId) return;
          const selection = { sessionId: data.sessionId, foregroundId: data.foregroundId };
          window.__dshAuForegroundSelection = selection;
          const resident = manager?.sessions?.get?.(data.sessionId);
          if (!resident || !Number.isSafeInteger(resident.openGeneration)) return;
          const generation = resident.openGeneration;
          const emit = (stage, result) => {
            if (disposed || window.__dshAuForegroundSelection !== selection || resident.openGeneration !== generation) return;
            postControlledSessionMetric('foreground-state', data.sessionId, { stage, result, generation, foregroundId: selection.foregroundId, elapsedMs: 0 });
          };
          if (resident.openPromise) {
            // 同会话正在打开时 open() 会复用旧 Promise，为新的选择单独绑定完成状态。
            emit('open-start', 'loading');
            Promise.resolve(resident.openPromise).then(() => emit('follow-settled', resident.openState), () => emit('follow-settled', 'error'));
          } else if (resident.openState === 'open') {
            emit('already-open', 'open');
          }
          return;
        }
        if (event.data.type === `${REMOTE_SESSION_PRELOAD_NAMESPACE}request`) onRequest(event, event.data);
        else if (event.data.type === `${REMOTE_SESSION_PRELOAD_NAMESPACE}cancel` || event.data.type === `${REMOTE_SESSION_PRELOAD_NAMESPACE}prune`) onCancelOrPrune(event, event.data);
      };
      window.addEventListener('message', onMessage);
      return () => {
        if (disposed) return;
        disposed = true;
        if (manager && origManagerGet && manager.get !== origManagerGet) {
          manager.get = origManagerGet;
        }
        window.removeEventListener('message', onMessage);
        for (const entry of [...inflight.values()]) cancel(entry, 'dispose');
        const sessionIds = [];
        for (const entries of cacheByDevice.values()) {
          for (const [sessionId, entry] of entries) {
            sessionIds.push(sessionId);
            releaseRef(entry);
          }
        }
        cacheByDevice.clear();
        if (sessionIds.length) void api('releaseSessionPreloads', { clientId, sessionIds: [...new Set(sessionIds)] }, undefined).catch(() => {});
      };
    }

    const remoteSessionPreloadHelpers = {
      REMOTE_SESSION_PRELOAD_WINDOW_MS,
      REMOTE_SESSION_OPEN_STALL_MS,
      REMOTE_SESSION_PRELOAD_PAGE_OPTIONS,
      collectRecentRemoteSessions,
      createRemoteSessionPreloadCoordinator,
      installControlledSessionPreload,
      installSessionInstantOpenHook,
      warmClientSessionWindow,
    };
    void remoteSessionPreloadHelpers;

    // This fragment is concatenated into the DSH factory; named declarations are the integration surface.
