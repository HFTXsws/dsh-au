    // 仅记“本页面已首次进入哪些设备”，热替换不再定位，真正的新页面才重置。
    const INITIAL_FOCUS_VISITS_KEY = '__dshAuInitialFocusVisits';

    function isEditingSessionElement(element) {
      if (!element) return false;
      return element.isContentEditable === true || ['INPUT', 'TEXTAREA'].includes(element.tagName);
    }

    function createInitialSessionFocusController({ openLocalSession = () => false, readLocalSessionId = () => '' } = {}) {
      const visited = window[INITIAL_FOCUS_VISITS_KEY] instanceof Set
        ? window[INITIAL_FOCUS_VISITS_KEY]
        : (window[INITIAL_FOCUS_VISITS_KEY] = new Set());
      let current = null;
      let attempt = null;
      let disposed = false;
      const timers = new Set();
      const clearTimers = () => {
        for (const timer of timers) window.clearTimeout(timer);
        timers.clear();
      };
      const log = (visit, result, reason = '', sessionId = '') => reportClientEvent('initial-session-focus', visit.deviceId, {
        frameId: visit.frameKey ? `${CLIENT_INSTANCE_ID}:${visit.frameKey}` : '',
        routeId: visit.routeId || '', sessionId, result, reason,
        elapsedMs: Date.now() - visit.startedAt,
      });
      const finish = (visit, result, reason = '', sessionId = '') => {
        if (visit.finished) return;
        visit.finished = true;
        clearTimers();
        log(visit, result, reason, sessionId);
        visit.frame = null;
      };
      const stillCurrent = (visit) => !disposed && attempt === visit && !visit.finished
        && current?.deviceId === visit.deviceId
        && (visit.deviceId === 'local' || (current.frameKey === visit.frameKey && current.frame === visit.frame));
      const respectsInput = (visit) => {
        const element = document.activeElement;
        // 外层弹窗/待办输入也优先；后台旧本机输入框残留焦点不等于正在编辑远端。
        if (element?.closest?.('.dsh-au-mask, .dsh-au-todo-dock')) return false;
        if (visit.deviceId !== 'local') {
          if (isEditingSessionElement(element) && !element.closest?.('[data-slot="main"]')) return false;
          return element !== visit.frame;
        }
        return !isEditingSessionElement(element) && readLocalSessionId() === visit.selectedAtEntry;
      };
      const schedule = (callback, delay) => {
        const timer = window.setTimeout(() => { timers.delete(timer); callback(); }, delay);
        timers.add(timer);
      };
      const sendRemote = (visit, legacy = false) => {
        if (!stillCurrent(visit)) return;
        if (!respectsInput(visit)) { finish(visit, 'skipped-user-input'); return; }
        // 只通知当前目标 iframe；不能像跨设备列表一样广播给所有远端。
        visit.frame.contentWindow?.postMessage(legacy ? {
          source: 'dsh-au-todo', type: 'dsh-au-todo:select-session', initialFocus: true,
          requestId: visit.requestId, sessionId: visit.sessionId, deviceId: visit.deviceId,
        } : {
          source: 'dsh-au', type: 'initial-session-focus',
          requestId: visit.requestId, sessionId: visit.sessionId,
        }, '*');
      };
      const resolve = async (visit) => {
        visit.started = true;
        visit.frameKey = current.frameKey || '';
        visit.routeId = current.routeId || '';
        visit.frame = current.frame || null;
        try {
          const target = await callApi('getInitialSessionFocus', { deviceId: visit.deviceId, routeId: visit.routeId });
          if (!stillCurrent(visit)) return;
          if (!respectsInput(visit)) { finish(visit, 'skipped-user-input'); return; }
          if (!target?.ok || typeof target.sessionId !== 'string'
            || !['busy', 'waiting', 'done', 'error', 'keep-current'].includes(target.reason)) {
            // 旧宿主可能对未知动作返回普通 getState 快照；不能把 HTTP200 当定位已支持。
            finish(visit, 'query-failed', 'focus-api-unavailable'); return;
          }
          const sessionId = target.sessionId;
          if (!sessionId) { finish(visit, 'keep-current', 'last-view-preserved'); return; }
          if (sessionId.length > 128) { finish(visit, 'query-failed', 'invalid-session-id'); return; }
          visit.sessionId = sessionId;
          visit.reason = target.reason || '';
          if (visit.deviceId === 'local') {
            if (readLocalSessionId() === sessionId) { finish(visit, 'already-selected', visit.reason, sessionId); return; }
            try {
              const accepted = openLocalSession(sessionId);
              finish(visit, accepted === false ? 'ui-unavailable' : 'navigation-requested', visit.reason, sessionId);
            } catch {
              finish(visit, 'ui-unavailable', 'open-session-failed', sessionId);
            }
            return;
          }
          visit.requestId = globalThis.crypto?.randomUUID?.() || `${CLIENT_INSTANCE_ID}:${Date.now()}`;
          sendRemote(visit);
          if (visit.finished) return;
          // 新版远端可确认导航；旧版兼容现有 Todo 选会话协议，仅重试一次。
          schedule(() => sendRemote(visit, true), 800);
          schedule(() => {
            if (stillCurrent(visit)) finish(visit, 'sent-unconfirmed', visit.reason, sessionId);
          }, 3000);
        } catch {
          if (stillCurrent(visit)) finish(visit, 'query-failed');
        }
      };
      const onMessage = (event) => {
        const visit = attempt;
        if (!visit || !stillCurrent(visit) || event.source !== visit.frame?.contentWindow) return;
        const data = event.data;
        if (data?.source !== 'dsh-au' || data.type !== 'initial-session-focus-result'
          || data.requestId !== visit.requestId || data.sessionId !== visit.sessionId) return;
        if (data.result === 'not-ready') return;
        if (!['applied', 'already-selected', 'skipped-user-input', 'open-failed'].includes(data.result)) return;
        finish(visit, data.result, visit.reason, visit.sessionId);
      };
      window.addEventListener('message', onMessage);
      return {
        update(next) {
          if (disposed) return;
          const changed = current?.deviceId !== next.deviceId;
          if (attempt && !attempt.finished && (changed || next.allowed === false
            || (attempt.started && next.deviceId !== 'local' && (next.frameKey !== attempt.frameKey || next.frame !== attempt.frame)))) {
            finish(attempt, changed ? 'cancelled-switch' : 'cancelled-navigation');
          }
          current = next;
          if (next.allowed === false) return;
          if (changed || !attempt) {
            attempt = null;
            if (visited.has(next.deviceId)) return;
            visited.add(next.deviceId);
            attempt = { deviceId: next.deviceId, routeId: next.routeId || '', startedAt: Date.now(),
              selectedAtEntry: next.deviceId === 'local' ? readLocalSessionId() : '', started: false, finished: false };
          }
          if (!attempt || attempt.finished || attempt.started) return;
          if (next.deviceId !== 'local' && (!next.loaded || !next.frame)) return;
          if (!respectsInput({ ...attempt, frame: next.frame })) { finish(attempt, 'skipped-user-input'); return; }
          void resolve(attempt);
        },
        dispose() {
          if (disposed) return;
          if (attempt && !attempt.finished) finish(attempt, 'cancelled-dispose');
          disposed = true;
          clearTimers();
          window.removeEventListener('message', onMessage);
          attempt = null;
          current = null;
        },
      };
    }
