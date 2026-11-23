    // 侧边栏远端工作区原生融合模块：将远端电脑的工作区与会话 1:1 融进本机左侧栏，配合右侧远端舞台实现单侧栏无缝切换。
    const remoteWorkspacesClient = (() => {
      'use strict';
      const React = require('react');
      const ReactDOM = require('react-dom');
      let uiPrimitives = null;
      try { uiPrimitives = require('@deepseek-ai/dsh-client-ui-primitives'); } catch {}
      const h = React.createElement;
      const { useState, useEffect } = React;

      const HIDDEN_STORAGE_KEY = 'dsh-au.hidden-remote-workspaces-v1';
      const EXPANDED_STORAGE_KEY = 'dsh-au.expanded-remote-workspaces-v1';
      const COLLAPSED_DEVICE_GROUPS_STORAGE_KEY = 'dsh-au.collapsed-device-groups-v1';
      const RESOLVED_WS_STORAGE_KEY = 'dsh-au.remote-workspace-ids-v1';
      const MOUNT_CLASS = 'dsh-au-remote-ws-root';
      const MOUNT_ATTR = 'data-dsh-au-remote-workspaces';
      const POLL_INTERVAL_MS = 6000;
      const CLIENT_LOCK = '__dshAuRemoteWorkspacesApplyActive';
      const NATIVE_REMOTE_WS_PREFIX = 'dsh-au-remote-ws:';

      // 双通道缓存状态：通道 A（服务端聚合）+ 通道 B（受控 iframe 实时快照）
      const store = {
        serverWorkspaces: [],
        controlledSnapshots: new Map(), // deviceId -> { workspaces, currentSessionId, updatedAt }
        selectedSessionByDevice: new Map(), // deviceId -> sessionId
        selectedWorkspaceByDevice: new Map(), // deviceId -> workspaceKey
        activeDeviceId: null,
        activeExtStage: null, // { extId, itemId } | null
        devices: [],
         localDeviceId: '',
        hiddenKeys: new Set(),
        expandedKeys: new Set(),
        collapsedDeviceGroups: null,
        promptTrackerInitialized: false,
        lastMaxPromptTs: 0,
        initializedExpanded: new Set(),
        pinnedSessionOverrides: new Map(), // sessionId -> boolean
        archivedSessionIds: new Set(), // sessionId
        sessionTitleOverrides: new Map(), // sessionId -> title
        workspaceTitleOverrides: new Map(), // wsKey -> title
        resolvedWorkspaceIds: new Map(), // "deviceId::normPath" -> realWorkspaceId
        nativeWorkspaceById: new Map(), // nativeWsId -> mergedWs
        nativeSessionById: new Map(), // sessionId -> { ws, session, nativeWorkspaceId, indexInWorkspace }
        warmDevices: new Set(), // 已预热就绪的远端 deviceId 集合
        confirmedSessionUntil: new Map(), // 仅无版本旧设备保留短暂乐观保护
        confirmedEndSeqBySession: new Map(), // sessionId -> 实际已查看的结束序号，不遮蔽后续短回合
        latestNavigationByDevice: new Map(), // deviceId -> { commandId, selectionSeq, pending }
        recentBusyAtBySession: new Map(), // sessionId -> lastBusyAtMs（最近观测到处于运行/等待态的时间戳）
        activeInteractedSessions: new Set(), // 当前已由用户交互/打开查看过的远端 sessionId 集合
        busySortTsBySession: new Map(), // sessionId -> frozenSortTs（并行流式输出期间锁定排序基准，防止侧栏跳动）
        createSessionSeq: 0, // 递增的新建会话请求序号，防止跨工作区快速连点 + 时旧请求覆盖新焦点
        nativeBridgeInstalled: false,
        revision: 0,
        listeners: new Set(),
      };
      const pendingRemoteCommands = new Map(); // deviceId -> { messages: [], expiresAt: number }
      const pendingCreateFallbacks = new Map(); // commandId -> () => Promise<string|null>
      const lastRemoteConfirmRpcByKey = new Map(); // "deviceId:sessionId" -> timestampMs
      let overlaySlotMounted = false;
       // 主控制端唯一的最近会话预加载协调器；受控 iframe 分支不创建它。
       let remoteSessionPreloadCoordinator = null;

      /** 切换会话/工作区或切回本机时，仅保留当前正激活的会话在已交互集合中，避免历史会话无限累积。 */
      function pruneActiveInteractedSessions(keepSessionId = '') {
        const cleanKeep = typeof keepSessionId === 'string' ? keepSessionId.trim() : '';
        store.activeInteractedSessions.clear();
        if (cleanKeep) {
          store.activeInteractedSessions.add(cleanKeep);
        }
        const now = Date.now();
        for (const [sid, until] of store.confirmedSessionUntil.entries()) {
          if (!Number.isFinite(until) || now >= until) {
            store.confirmedSessionUntil.delete(sid);
          }
        }
      }

      /** 判断某个远端会话是否处于乐观已读确认保护窗口内（防止后台轮询旧快照在 ~1-2s 内把绿灯/蓝灯重新点亮）。 */
      function isSessionOptimisticallyConfirmed(sessionId, now = Date.now()) {
        if (typeof sessionId !== 'string' || !sessionId) return false;
        const until = store.confirmedSessionUntil.get(sessionId);
        if (!Number.isFinite(until)) return false;
        if (now >= until) {
          store.confirmedSessionUntil.delete(sessionId);
          return false;
        }
        return true;
      }

      /** 判断会话是否在最近窗口期内处于运行/等待态（防止刚在受控端完成的新回合在 1~2s 轮询差内被误当成已读旧回合）。 */
      function wasSessionRecentlyActive(sessionId, now = Date.now(), windowMs = 8000) {
        if (typeof sessionId !== 'string' || !sessionId) return false;
        const ts = store.recentBusyAtBySession.get(sessionId);
        if (!Number.isFinite(ts) || ts <= 0) return false;
        if (now - ts > windowMs) {
          store.recentBusyAtBySession.delete(sessionId);
          return false;
        }
        return true;
      }

      function notifyStoreListeners() {
        store.revision += 1;
        for (const listener of [...store.listeners]) {
          try { listener(); } catch {}
        }
      }

      /** 生成注入 DSH 原生 workspaces.list 的远端工作区 ID。 */
      function toNativeRemoteWorkspaceId(deviceId, workspaceId) {
        return `${NATIVE_REMOTE_WS_PREFIX}${String(deviceId || '').trim()}:${String(workspaceId || 'default').trim()}`;
      }

      /** 判断工作区 ID 是否为远端注入工作区。 */
      function isNativeRemoteWorkspaceId(workspaceId) {
        return typeof workspaceId === 'string' && workspaceId.startsWith(NATIVE_REMOTE_WS_PREFIX);
      }

      /** 解析远端原生工作区 ID。 */
      function parseNativeRemoteWorkspaceId(nativeWorkspaceId) {
        if (!isNativeRemoteWorkspaceId(nativeWorkspaceId)) return null;
        const rest = nativeWorkspaceId.slice(NATIVE_REMOTE_WS_PREFIX.length);
        const sepIdx = rest.indexOf(':');
        if (sepIdx <= 0) return null;
        const deviceId = rest.slice(0, sepIdx);
        const workspaceId = rest.slice(sepIdx + 1) || 'default';
        return {
          deviceId,
          workspaceId,
          key: makeWorkspaceKey(deviceId, workspaceId),
        };
      }

      /** 从路径提取工作区短名称。 */
      function workspaceLeafFromPath(rawPath) {
        if (typeof rawPath !== 'string' || !rawPath.trim()) return '';
        const parts = rawPath.trim().replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
        return parts[parts.length - 1] || '';
      }

      /** 归一化工作区路径比较键（统一斜杠、去尾斜杠、小写），消除同路径不同写法导致的重复工作区。 */
      function normalizeWorkspacePathKey(rawPath) {
        return String(rawPath || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      }

      /** 归一化工作区显示名称（将 default-workspace / default / 空名称统一映射为路径末段或「默认工作区」）。 */
      function normalizeWorkspaceTitle(rawTitle, rawPath = '') {
        const t = typeof rawTitle === 'string' ? rawTitle.trim() : '';
        if (!t || t === 'default-workspace' || t === 'default') {
          const leaf = workspaceLeafFromPath(rawPath);
          return (!leaf || leaf === 'default-workspace' || leaf === 'default') ? '默认工作区' : leaf;
        }
        return t;
      }

      /** 生成远端工作区唯一键（deviceId:workspaceId）。 */
      function makeWorkspaceKey(deviceId, workspaceId) {
        return `${String(deviceId || '').trim()}:${String(workspaceId || 'default').trim()}`;
      }

      /** 读取 localStorage 中已隐藏的远端工作区键集合。 */
      function readHiddenRemoteWorkspaces(storage = typeof localStorage !== 'undefined' ? localStorage : null) {
        try {
          const raw = storage?.getItem?.(HIDDEN_STORAGE_KEY);
          const parsed = JSON.parse(raw || '[]');
          if (!Array.isArray(parsed)) return [];
          return parsed.filter((item) => typeof item === 'string' && item.includes(':'));
        } catch {
          return [];
        }
      }

      /** 写入已隐藏的远端工作区键列表到 localStorage。 */
      function writeHiddenRemoteWorkspaces(keys, storage = typeof localStorage !== 'undefined' ? localStorage : null) {
        const normalized = [...new Set((Array.isArray(keys) ? keys : [...(keys || [])]).filter((k) => typeof k === 'string' && k.includes(':')))];
        try {
          storage?.setItem?.(HIDDEN_STORAGE_KEY, JSON.stringify(normalized));
        } catch {}
        store.hiddenKeys = new Set(normalized);
        notifyStoreListeners();
        return normalized;
      }

      /** 隐藏单个远端工作区。 */
      function hideRemoteWorkspace(deviceId, workspaceId, storage = typeof localStorage !== 'undefined' ? localStorage : null) {
        const key = makeWorkspaceKey(deviceId, workspaceId);
        const current = new Set(readHiddenRemoteWorkspaces(storage));
        current.add(key);
        return writeHiddenRemoteWorkspaces([...current], storage);
      }

      /** 恢复全部已隐藏的远端工作区。 */
      function restoreAllHiddenRemoteWorkspaces(storage = typeof localStorage !== 'undefined' ? localStorage : null) {
        try {
          storage?.removeItem?.(HIDDEN_STORAGE_KEY);
        } catch {}
        store.hiddenKeys = new Set();
        notifyStoreListeners();
        return [];
      }

      /** 读取已展开的远端工作区键集合。 */
      function readExpandedRemoteWorkspaces(storage = typeof localStorage !== 'undefined' ? localStorage : null) {
        try {
          const raw = storage?.getItem?.(EXPANDED_STORAGE_KEY);
          const parsed = JSON.parse(raw || '[]');
          return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
        } catch {
          return [];
        }
      }

      function persistExpandedRemoteWorkspaces(storage = typeof localStorage !== 'undefined' ? localStorage : null) {
        try {
          storage?.setItem?.(EXPANDED_STORAGE_KEY, JSON.stringify([...store.expandedKeys]));
        } catch {}
      }

      function readCollapsedDeviceGroups(storage = typeof localStorage !== 'undefined' ? localStorage : null) {
        if (store.collapsedDeviceGroups instanceof Set) return store.collapsedDeviceGroups;
        let list = [];
        try {
          const raw = storage?.getItem?.(COLLAPSED_DEVICE_GROUPS_STORAGE_KEY);
          const parsed = JSON.parse(raw || '[]');
          if (Array.isArray(parsed)) list = parsed.filter((item) => typeof item === 'string' && item);
        } catch {}
        store.collapsedDeviceGroups = new Set(list);
        return store.collapsedDeviceGroups;
      }

      function writeCollapsedDeviceGroups(keys, storage = typeof localStorage !== 'undefined' ? localStorage : null) {
        const normalized = [...new Set((Array.isArray(keys) ? keys : [...(keys || [])]).filter((k) => typeof k === 'string' && k))];
        store.collapsedDeviceGroups = new Set(normalized);
        try {
          storage?.setItem?.(COLLAPSED_DEVICE_GROUPS_STORAGE_KEY, JSON.stringify(normalized));
        } catch {}
        return store.collapsedDeviceGroups;
      }

      function isDeviceGroupCollapsed(groupKey, storage = typeof localStorage !== 'undefined' ? localStorage : null) {
        if (!groupKey) return false;
        return readCollapsedDeviceGroups(storage).has(groupKey);
      }

      function toggleDeviceGroupCollapsed(groupKey, storage = typeof localStorage !== 'undefined' ? localStorage : null) {
        if (!groupKey) return false;
        const current = new Set(readCollapsedDeviceGroups(storage));
        const nextCollapsed = !current.has(groupKey);
        if (nextCollapsed) current.add(groupKey);
        else current.delete(groupKey);
        writeCollapsedDeviceGroups([...current], storage);
        return nextCollapsed;
      }

      function expandDeviceGroup(groupKey, storage = typeof localStorage !== 'undefined' ? localStorage : null) {
        if (!groupKey) return false;
        const current = readCollapsedDeviceGroups(storage);
        if (!current.has(groupKey)) return false;
        const next = new Set(current);
        next.delete(groupKey);
        writeCollapsedDeviceGroups([...next], storage);
        return true;
      }

      /** 将左侧栏工作区树所在滚动容器滚动到最顶部。 */
      function scrollSidebarToTop(doc = typeof document !== 'undefined' ? document : null) {
        const treeContainer = findNativeWorkspaceTreeContainer(doc);
        if (!treeContainer) return false;
        const scroller = treeContainer.closest?.('[class*="_treeBody"]') || treeContainer.parentElement || treeContainer;
        if (!scroller) return false;
        try {
          if (typeof scroller.scrollTo === 'function') {
            scroller.scrollTo({ top: 0, behavior: 'smooth' });
            return true;
          }
        } catch {}
        if (typeof scroller.scrollTop === 'number') {
          scroller.scrollTop = 0;
          return true;
        }
        return false;
      }

      /** 格式化紧凑相对时间（刚刚、5分钟、2小时、3天）。 */
      function formatCompactRelativeTime(timestamp, now = Date.now()) {
        const ts = Number(timestamp || 0);
        if (!Number.isFinite(ts) || ts <= 0) return '';
        const seconds = Math.max(0, Math.floor((now - ts) / 1000));
        if (seconds < 60) return '刚刚';
        if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)}小时`;
        if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)}天`;
        return `${Math.floor(seconds / (86400 * 30))}个月`;
      }

      const STATUS_PRIORITY = { error: 5, waiting: 4, done: 3, busy: 2, running: 2, idle: 1 };

      function normalizeSessionStatus(status) {
        const s = String(status || 'idle').trim().toLowerCase();
        if (s === 'running') return 'busy';
        if (s === 'busy' || s === 'waiting' || s === 'done' || s === 'error') return s;
        return 'idle';
      }

      /** 计算工作区聚合状态（用于远端电脑胶囊呼吸灯与文件夹高亮）。 */
      function computeWorkspaceAggregateStatus(sessions, fallbackStatus = 'idle') {
        let best = normalizeSessionStatus(fallbackStatus);
        for (const session of Array.isArray(sessions) ? sessions : []) {
          const current = normalizeSessionStatus(session?.statusV2 || session?.status);
          if ((STATUS_PRIORITY[current] || 1) > (STATUS_PRIORITY[best] || 1)) {
            best = current;
          }
        }
        return best;
      }

      /**
       * 借鉴 Agents-Anywhere：多个远端任务并行流式输出（busy / waiting）时，
       * 锁定其进入运行态时的排序基准时间戳，防止每次流式 token 更新导致左侧栏会话与工作区上下反复跳动；
       * 当任务结束或状态切回非运行态时，立即释放锁定并按最新时间重排。
       */
      function resolveStabilizedSessionSortTs(session) {
        const sid = String(session?.sessionId || session?.id || '').trim();
        const rawTs = Number(session?.updatedAt || 0);
        const active = session?.status === 'busy' || session?.status === 'waiting';
        return active && store.busySortTsBySession.has(sid) ? store.busySortTsBySession.get(sid) : rawTs;
      }

      function compareRemoteSessionOrder(a, b) {
        const pinDiff = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
        if (pinDiff) return pinDiff;
        const activeA = a.status === 'busy' || a.status === 'waiting';
        const activeB = b.status === 'busy' || b.status === 'waiting';
        return Number(activeB) - Number(activeA)
          || resolveStabilizedSessionSortTs(b) - resolveStabilizedSessionSortTs(a)
          || String(a.sessionId || '').localeCompare(String(b.sessionId || ''));
      }

      /** 只有最终融合态拥有排序锁生命周期，单通道 idle 不得释放另一通道的 busy 锁。 */
      function prepareStabilizedSessionSortState(sessions) {
        for (const s of sessions) {
          if (s.status === 'busy' || s.status === 'waiting') {
            if (!store.busySortTsBySession.has(s.sessionId)) {
              store.busySortTsBySession.set(s.sessionId, Number(s.updatedAt) || Date.now());
            }
          } else {
            store.busySortTsBySession.delete(s.sessionId);
          }
        }
      }

      function readSessionStateMeta(session) {
        if (!Number.isSafeInteger(session?.stateSeq) || session.stateSeq < 0) return null;
        return {
          stateSeq: session.stateSeq,
          endSeq: Number.isSafeInteger(session.endSeq) ? session.endSeq : -1,
          ackedSeq: Number.isSafeInteger(session.ackedSeq) ? session.ackedSeq : -1,
        };
      }

      function isSessionStateConfirmed(session, now = Date.now()) {
        const meta = readSessionStateMeta(session);
        if (!meta) return isSessionOptimisticallyConfirmed(session?.sessionId, now);
        return meta.endSeq >= 0 && Math.max(meta.ackedSeq, store.confirmedEndSeqBySession.get(session.sessionId) ?? -1) >= meta.endSeq;
      }

      /** 状态是同一会话的时间线事实：先比事件/已读水位，不能用灯色优先级判断新旧。 */
      function selectNewerSessionState(previous, incoming) {
        const before = readSessionStateMeta(previous);
        const after = readSessionStateMeta(incoming);
        if (before && after) {
          if (before.stateSeq !== after.stateSeq) return before.stateSeq > after.stateSeq ? previous : incoming;
          if (before.ackedSeq !== after.ackedSeq) return before.ackedSeq > after.ackedSeq ? previous : incoming;
          return previous.fromServer && !incoming.fromServer ? previous : incoming;
        }
        // 旧端无日志水位时，实时运行信号不能被旧完成结果压住；已读仍走旧保护窗口。
        const active = (s) => s.status === 'busy' || s.status === 'waiting';
        if (active(previous) !== active(incoming)) return active(incoming) ? incoming : previous;
        return Number(incoming.updatedAt || 0) >= Number(previous.updatedAt || 0) ? incoming : previous;
      }

      function computeStabilizedWorkspaceSortTs(sessions, fallbackUpdatedAt = 0) {
        const list = Array.isArray(sessions) ? sessions : [];
        const hasActiveStreaming = list.some((s) => s?.status === 'busy' || s?.status === 'waiting');
        if (!hasActiveStreaming || list.length === 0) {
          return Number(fallbackUpdatedAt || 0);
        }
        return Math.max(
          ...list.map((s) => resolveStabilizedSessionSortTs(s)),
          0
        );
      }

      /**
       * 通道 A 标准化：从 `/dsh-au-todo/api` 的 `getState` 响应提取远端工作区列表。
       * 优先读取 `res.remoteWorkspaces`；若无则用 `res.cards` 中 `isLocal === false` 的卡片按 `deviceId + (cwd || workspace)` 聚合兜底。
       */
      function normalizeServerRemoteWorkspaces(res, devicesHint = []) {
        if (!res || typeof res !== 'object') return [];
        const localDeviceId = typeof res.localDeviceId === 'string' ? res.localDeviceId : '';
        const deviceNameMap = new Map();
        for (const dev of Array.isArray(devicesHint) ? devicesHint : []) {
          if (dev?.id && dev?.name) deviceNameMap.set(dev.id, dev.name);
        }

        const normalizeSessionItem = (s, defaultCwd = '') => {
          const sessionId = String(s?.sessionId || s?.id || '').trim();
          if (!sessionId || store.archivedSessionIds.has(sessionId)) return null;
          const pinnedOverride = store.pinnedSessionOverrides.has(sessionId)
            ? store.pinnedSessionOverrides.get(sessionId)
            : Boolean(s?.pinned);
          const titleOverride = store.sessionTitleOverrides.get(sessionId);
          const rawTitle = titleOverride || (typeof s?.title === 'string' && s.title.trim()) || '未命名对话';
          const title = typeof sanitizeTextForSync === 'function' ? sanitizeTextForSync(rawTitle) : rawTitle;
          const rawStatus = normalizeSessionStatus(s?.statusV2 || s?.status || 'idle');
          const isTurnActive = rawStatus === 'busy' || rawStatus === 'waiting';
          if (isTurnActive) {
            store.confirmedSessionUntil.delete(sessionId);
            store.recentBusyAtBySession.set(sessionId, Date.now());
          }
          const confirmedOptimistically = isSessionStateConfirmed({ ...s, sessionId });
          const status = confirmedOptimistically && (rawStatus === 'done' || rawStatus === 'error')
            ? 'idle'
            : rawStatus;
          // 过滤服务端返回的历史未发消息空白占位会话（带空 summary、未命名对话、未置顶且 idle）
          if (
            !s?.blank
            && Object.prototype.hasOwnProperty.call(s || {}, 'summary')
            && !String(s.summary || '').trim()
            && title === '未命名对话'
            && !pinnedOverride
            && status === 'idle'
          ) {
            return null;
          }
          const rawCwd = String(s?.cwd || s?.path || defaultCwd || '').trim();
          return {
            sessionId,
            title,
            status,
            updatedAt: Number(s?.updatedAt || 0),
            createdAt: s?.createdAt || null,
            cwd: typeof sanitizeTextForSync === 'function' ? sanitizeTextForSync(rawCwd) : rawCwd,
            pinned: Boolean(pinnedOverride),
            pendingInteractionKind: s?.pendingInteractionKind || null,
            // 新一轮对话开始运行（busy/waiting）或处于已读确认保护窗口时，立即清除上一轮遗留的未读标记
            completionUnread: (confirmedOptimistically || isTurnActive) ? false : Boolean(s?.completionUnread),
            ...readSessionStateMeta(s),
            blank: Boolean(s?.blank),
          };
        };

        const rawRemoteWorkspaces = Array.isArray(res.remoteWorkspaces) ? res.remoteWorkspaces : [];
        if (rawRemoteWorkspaces.length > 0) {
          const flatList = [];
          for (const entry of rawRemoteWorkspaces) {
            if (!entry || typeof entry !== 'object') continue;
            // 兼容按设备嵌套 { deviceId, deviceName, workspaces: [...] } 与扁平工作区项两种结构
            if (Array.isArray(entry.workspaces)) {
              const devId = String(entry.deviceId || entry.id || '').trim();
              if (!devId || devId === 'local' || (localDeviceId && devId === localDeviceId)) continue;
              const devName = entry.deviceName || entry.name || deviceNameMap.get(devId) || devId;
              for (const ws of entry.workspaces) {
                if (!ws || typeof ws !== 'object') continue;
                const path = String(ws.path || ws.cwd || '').trim();
                const title = (typeof ws.title === 'string' && ws.title.trim())
                  || (typeof ws.workspace === 'string' && ws.workspace.trim())
                  || (typeof ws.name === 'string' && ws.name.trim())
                  || workspaceLeafFromPath(path)
                  || '默认工作区';
                const workspaceId = String(ws.workspaceId || ws.id || path || title || 'default').trim();
                const sessions = (Array.isArray(ws.sessions) ? ws.sessions : [])
                  .map((s) => normalizeSessionItem(s, path))
                  .filter(Boolean)
                  .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
                const updatedAt = Math.max(
                  Number(ws.updatedAt || 0),
                  ...sessions.map((s) => Number(s.updatedAt || 0)),
                  0
                );
                flatList.push({
                  deviceId: devId,
                  deviceName: devName,
                  workspaceId,
                  title,
                  path,
                  updatedAt,
                  status: computeWorkspaceAggregateStatus(sessions, ws.status),
                  sessions,
                });
              }
              continue;
            }
            const devId = String(entry.deviceId || '').trim();
            if (!devId || devId === 'local' || (localDeviceId && devId === localDeviceId)) continue;
            const devName = entry.deviceName || deviceNameMap.get(devId) || devId;
            const path = String(entry.path || entry.cwd || '').trim();
            const title = (typeof entry.title === 'string' && entry.title.trim())
              || (typeof entry.workspace === 'string' && entry.workspace.trim())
              || (typeof entry.name === 'string' && entry.name.trim())
              || workspaceLeafFromPath(path)
              || '默认工作区';
            const workspaceId = String(entry.workspaceId || entry.id || path || title || 'default').trim();
            const sessions = (Array.isArray(entry.sessions) ? entry.sessions : [])
              .map((s) => normalizeSessionItem(s, path))
              .filter(Boolean)
              .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
            const updatedAt = Math.max(
              Number(entry.updatedAt || 0),
              ...sessions.map((s) => Number(s.updatedAt || 0)),
              0
            );
            flatList.push({
              deviceId: devId,
              deviceName: devName,
              workspaceId,
              title,
              path,
              updatedAt,
              status: computeWorkspaceAggregateStatus(sessions, entry.status),
              sessions,
            });
          }
          if (flatList.length > 0) return flatList;
        }

        // 兜底：从 res.cards 中筛选 isLocal === false 的卡片按 deviceId + (cwd || workspace) 聚合
        const grouped = new Map();
        for (const card of Array.isArray(res.cards) ? res.cards : []) {
          if (!card || card.isLocal !== false) continue;
          const devId = String(card.deviceId || '').trim();
          if (!devId || devId === 'local' || (localDeviceId && devId === localDeviceId)) continue;
          const cwd = String(card.cwd || card.path || '').trim();
          const wsTitle = (typeof card.workspace === 'string' && card.workspace.trim())
            || workspaceLeafFromPath(cwd)
            || '默认工作区';
          const wsKeyPart = cwd || wsTitle || 'default';
          const groupKey = `${devId}::${wsKeyPart}`;
          let group = grouped.get(groupKey);
          if (!group) {
            group = {
              deviceId: devId,
              deviceName: card.deviceName || deviceNameMap.get(devId) || devId,
              workspaceId: String(card.workspaceId || cwd || wsTitle || 'default').trim(),
              title: wsTitle,
              path: cwd,
              updatedAt: 0,
              status: 'idle',
              sessions: [],
            };
            grouped.set(groupKey, group);
          }
          const session = normalizeSessionItem(card, cwd);
          if (session && !group.sessions.some((s) => s.sessionId === session.sessionId)) {
            group.sessions.push(session);
            if (session.updatedAt > group.updatedAt) group.updatedAt = session.updatedAt;
          }
        }
        const fallbackList = [...grouped.values()];
        for (const ws of fallbackList) {
          ws.sessions.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
          ws.status = computeWorkspaceAggregateStatus(ws.sessions, ws.status);
        }
        return fallbackList;
      }

      /**
       * 双通道融合：将服务端聚合工作区（通道 A）与受控 iframe 实时快照（通道 B）合并。
       * 受控端实时快照可补充 0 会话空工作区、新建会话、真实 workspaceId 与当前选中会话。
       */
      function mergeRemoteWorkspaces(
        serverWorkspaces = [],
        controlledSnapshots = new Map(),
        devicesHint = [],
        hiddenSet = new Set()
      ) {
        const snapMap = controlledSnapshots instanceof Map
          ? controlledSnapshots
          : new Map(Object.entries(controlledSnapshots || {}));
        const hidden = hiddenSet instanceof Set ? hiddenSet : new Set(hiddenSet || []);
        const deviceNameMap = new Map();
        for (const dev of Array.isArray(devicesHint) ? devicesHint : []) {
          if (dev?.id && dev?.name) deviceNameMap.set(dev.id, dev.name);
        }
        for (const ws of Array.isArray(serverWorkspaces) ? serverWorkspaces : []) {
          if (ws?.deviceId && ws?.deviceName && !deviceNameMap.has(ws.deviceId)) {
            deviceNameMap.set(ws.deviceId, ws.deviceName);
          }
        }

        // 汇总服务端通道 A 与顶栏 remotes.sessionStatesV2 中已确认处于 idle 的权威会话集合：
        // 当某条会话已在另一台电脑上确认过（服务端状态为 idle 且无未读），本机受控 iframe 残留的浏览器本地 completionUnread/done 不得反超点亮绿灯。
        const authoritativeServerIdleSessions = new Set();
        const nowMs = Date.now();
        for (const ws of Array.isArray(serverWorkspaces) ? serverWorkspaces : []) {
          for (const s of Array.isArray(ws?.sessions) ? ws.sessions : []) {
            const sid = String(s?.sessionId || s?.id || '').trim();
            if (!sid) continue;
            const st = normalizeSessionStatus(s?.statusV2 || s?.status || 'idle');
            if (st === 'busy' || st === 'waiting') {
              store.recentBusyAtBySession.set(sid, nowMs);
              authoritativeServerIdleSessions.delete(sid);
            } else if (st === 'idle' && !s?.completionUnread) {
              authoritativeServerIdleSessions.add(sid);
            } else {
              authoritativeServerIdleSessions.delete(sid);
            }
          }
        }
        const auRemotes = (typeof window !== 'undefined' && Array.isArray(window.__dshAuLastStateSnap?.remotes))
          ? window.__dshAuLastStateSnap.remotes
          : [];
        for (const remote of auRemotes) {
          if (!remote || remote.online === false || !remote.sessionStatesV2 || typeof remote.sessionStatesV2 !== 'object') continue;
          for (const [sid, rawSt] of Object.entries(remote.sessionStatesV2)) {
            if (typeof sid !== 'string' || !sid) continue;
            const st = normalizeSessionStatus(rawSt);
            if (st === 'busy' || st === 'waiting') {
              store.recentBusyAtBySession.set(sid, nowMs);
              authoritativeServerIdleSessions.delete(sid);
            } else if (st === 'idle') {
              const serverHasNonIdle = (Array.isArray(serverWorkspaces) ? serverWorkspaces : []).some((w) =>
                (Array.isArray(w?.sessions) ? w.sessions : []).some((s) =>
                  (s?.sessionId || s?.id) === sid && (normalizeSessionStatus(s?.statusV2 || s?.status) !== 'idle' || s?.completionUnread)
                )
              );
              if (!serverHasNonIdle) {
                authoritativeServerIdleSessions.add(sid);
              }
            } else {
              authoritativeServerIdleSessions.delete(sid);
            }
          }
        }

        const byDevice = new Map();
        const ensureDeviceBucket = (deviceId) => {
          if (!byDevice.has(deviceId)) byDevice.set(deviceId, []);
          return byDevice.get(deviceId);
        };

        const upsertWorkspaceIntoBucket = (bucket, rawWs, deviceId, deviceName, { fromServer = false } = {}) => {
          if (!rawWs || typeof rawWs !== 'object') return;
          const wsPath = String(rawWs.path || rawWs.cwd || '').trim();
          const wsPathKey = normalizeWorkspacePathKey(wsPath);
          const wsTitle = normalizeWorkspaceTitle(
            rawWs.title || rawWs.workspace || rawWs.name,
            wsPath
          );
          const rawId = String(rawWs.workspaceId || rawWs.id || '').trim();
          const wsId = (!rawId || rawId === 'default-workspace' || rawId === 'default' || rawId.startsWith('cwd:')) && !wsPathKey && wsTitle === '默认工作区'
            ? 'default-workspace'
            : (rawId || wsPath || wsTitle || 'default');

          const incomingSessions = (Array.isArray(rawWs.sessions) ? rawWs.sessions : []).map((s) => {
            const sessionId = String(s?.sessionId || s?.id || '').trim();
            if (!sessionId || store.archivedSessionIds.has(sessionId)) return null;
            const pinnedOverride = store.pinnedSessionOverrides.has(sessionId)
              ? store.pinnedSessionOverrides.get(sessionId)
              : Boolean(s?.pinned);
            const titleOverride = store.sessionTitleOverrides.get(sessionId);
            const rawStatus = normalizeSessionStatus(s?.statusV2 || s?.status || 'idle');
            const isTurnActive = rawStatus === 'busy' || rawStatus === 'waiting';
            if (isTurnActive) {
              store.confirmedSessionUntil.delete(sessionId);
              store.recentBusyAtBySession.set(sessionId, nowMs);
            }
            const confirmedByServer = !readSessionStateMeta(s) && !fromServer
              && authoritativeServerIdleSessions.has(sessionId)
              && !wasSessionRecentlyActive(sessionId, nowMs);
            const confirmedOptimistically = isSessionStateConfirmed({ ...s, sessionId }, nowMs) || confirmedByServer;
            const status = confirmedOptimistically && (rawStatus === 'done' || rawStatus === 'error')
              ? 'idle'
              : rawStatus;
            const rawTitle = titleOverride || (typeof s?.title === 'string' && s.title.trim()) || '未命名对话';
            const rawCwd = String(s?.cwd || wsPath || '').trim();
            return {
              sessionId,
              title: typeof sanitizeTextForSync === 'function' ? sanitizeTextForSync(rawTitle) : rawTitle,
              status,
              updatedAt: Number(s?.updatedAt || 0),
              serverUpdatedAt: fromServer ? Number(s?.updatedAt || 0) : undefined,
              snapUpdatedAt: !fromServer ? Number(s?.updatedAt || 0) : undefined,
              createdAt: s?.createdAt || null,
              cwd: typeof sanitizeTextForSync === 'function' ? sanitizeTextForSync(rawCwd) : rawCwd,
              pinned: Boolean(pinnedOverride),
              pendingInteractionKind: s?.pendingInteractionKind || null,
              completionUnread: (confirmedOptimistically || isTurnActive) ? false : Boolean(s?.completionUnread),
              ...readSessionStateMeta(s),
              blank: Boolean(s?.blank),
              fromServer: Boolean(fromServer),
            };
          }).filter((s) => Boolean(s?.sessionId));

          const sortWsSessions = (list) => [...list].sort(compareRemoteSessionOrder);

          const existing = bucket.find((item) => {
            const itemPathKey = normalizeWorkspacePathKey(item.path || '');
            if (item.workspaceId === wsId) return true;
            if (wsPathKey && itemPathKey && wsPathKey === itemPathKey) return true;
            // 同设备下的「默认工作区」无论来自 default-workspace 目录、无 cwd 会话或空工作区，均合并为单一工作区
            if (wsTitle === '默认工作区' && item.title === '默认工作区') return true;
            if (wsTitle && item.title === wsTitle && (!wsPathKey || !itemPathKey || wsPathKey === itemPathKey)) return true;
            return false;
          });

          if (existing) {
            if (wsId && wsId !== 'default-workspace' && !wsId.startsWith('cwd:') && (existing.workspaceId === 'default-workspace' || existing.workspaceId.startsWith('cwd:'))) {
              existing.workspaceId = wsId;
            }
            existing.path = existing.path || wsPath;
            existing.title = normalizeWorkspaceTitle(existing.title || wsTitle, existing.path);
            existing.deviceName = deviceName || existing.deviceName;

            const sessionById = new Map();
            for (const s of existing.sessions) {
              sessionById.set(s.sessionId, { ...s });
            }
            for (const ls of incomingSessions) {
              const prev = sessionById.get(ls.sessionId);
              if (prev) {
                if (ls.status === 'busy' || ls.status === 'waiting') {
                  store.confirmedSessionUntil.delete(ls.sessionId);
                  store.recentBusyAtBySession.set(ls.sessionId, nowMs);
                }
                const confirmedByServer = (!fromServer && authoritativeServerIdleSessions.has(ls.sessionId) && !wasSessionRecentlyActive(ls.sessionId, nowMs))
                  || (prev.fromServer && prev.status === 'idle' && !prev.completionUnread && !fromServer && !wasSessionRecentlyActive(ls.sessionId, nowMs));
                const stateWinner = selectNewerSessionState(prev, ls);
                const confirmedOptimistically = isSessionStateConfirmed(stateWinner, nowMs)
                  || (!readSessionStateMeta(stateWinner) && confirmedByServer);
                const rawMergedStatus = stateWinner.status;
                const mergedStatus = confirmedOptimistically && (rawMergedStatus === 'done' || rawMergedStatus === 'error')
                  ? 'idle'
                  : rawMergedStatus;
                const isMergedActive = mergedStatus === 'busy' || mergedStatus === 'waiting';
                const pinnedVal = store.pinnedSessionOverrides.has(ls.sessionId)
                  ? store.pinnedSessionOverrides.get(ls.sessionId)
                  : Boolean(ls.pinned || prev.pinned);
                // 占位标题（未命名对话 / 空白会话的「新对话」/ 工作区兜底目录名）不得覆盖另一侧的真实标题
                const isPlaceholderTitle = (s) => {
                  const t = String(s?.title || '').trim();
                  const lower = t.toLowerCase();
                  return !t || t === '未命名对话' || lower === 'default-workspace' || lower === 'default' || t === '默认工作区' || (s?.blank && t === '新对话');
                };
                const isConfirmedNonBlank = (s) => !s?.blank && (
                  !isPlaceholderTitle(s)
                  || Boolean(s?.summary && String(s.summary).trim())
                  || (s?.status && s.status !== 'idle')
                  || Boolean(s?.completionUnread || s?.pendingInteractionKind)
                );
                sessionById.set(ls.sessionId, {
                  ...prev,
                  ...ls,
                  title: store.sessionTitleOverrides.get(ls.sessionId)
                    || (!isPlaceholderTitle(ls) || isPlaceholderTitle(prev) ? ls.title : prev.title),
                  status: mergedStatus,
                  ...readSessionStateMeta(stateWinner),
                  pinned: Boolean(pinnedVal),
                  pendingInteractionKind: mergedStatus === 'waiting' ? stateWinner.pendingInteractionKind : null,
                  completionUnread: (confirmedOptimistically || isMergedActive) ? false : Boolean(stateWinner.completionUnread || mergedStatus === 'done' || mergedStatus === 'error'),
                  // 仅当另一通道确认已产生非空白有效内容/状态时才解除 blank，防止旧版远端未携带 blank 字段的「未命名对话」把乐观「新对话」转成非空白残留
                  blank: Boolean((ls.blank || prev.blank) && !(isConfirmedNonBlank(ls) || isConfirmedNonBlank(prev))),
                  fromServer: Boolean(prev.fromServer || ls.fromServer),
                  serverUpdatedAt: fromServer ? Number(ls.updatedAt || 0) : prev.serverUpdatedAt,
                  snapUpdatedAt: !fromServer ? Number(ls.updatedAt || 0) : prev.snapUpdatedAt,
                  // prev.updatedAt 是服务端根据真实对话事件计算出的权威时间戳；
                  // 闲置会话被点击打开时受控 iframe 快照中的 ls.updatedAt 会因 session/end-seed 变成当前时间。
                  // 因此非活动状态下优先沿用服务端的真实时间戳，防止点开远端旧会话时间变成「刚刚」。
                  updatedAt: (prev.fromServer && Number(prev.updatedAt) > 0 && !isMergedActive && mergedStatus !== 'done' && !stateWinner.completionUnread)
                    ? Number(prev.updatedAt)
                    : Math.max(Number(prev.updatedAt || 0), Number(ls.updatedAt || 0)),
                });
              } else {
                sessionById.set(ls.sessionId, ls);
              }
            }
            existing.sessions = sortWsSessions(sessionById.values());
            existing.updatedAt = Math.max(
              Number(existing.updatedAt || 0),
              Number(rawWs.updatedAt || 0),
              ...existing.sessions.map((s) => Number(s.updatedAt || 0)),
              0
            );
            existing.sortUpdatedAt = computeStabilizedWorkspaceSortTs(existing.sessions, existing.updatedAt);
            existing.status = computeWorkspaceAggregateStatus(existing.sessions, rawWs.status || existing.status);
          } else {
            const sortedSessions = sortWsSessions(incomingSessions);
            const updatedAt = Math.max(
              Number(rawWs.updatedAt || 0),
              ...sortedSessions.map((s) => Number(s.updatedAt || 0)),
              0
            );
            bucket.push({
              deviceId,
              deviceName,
              workspaceId: wsId,
              title: wsTitle,
              path: wsPath,
              updatedAt,
              sortUpdatedAt: computeStabilizedWorkspaceSortTs(sortedSessions, updatedAt),
              status: computeWorkspaceAggregateStatus(sortedSessions, rawWs.status),
              sessions: sortedSessions,
            });
          }
        };

        for (const ws of Array.isArray(serverWorkspaces) ? serverWorkspaces : []) {
          if (!ws?.deviceId) continue;
          const deviceName = deviceNameMap.get(ws.deviceId) || ws.deviceName || ws.deviceId;
          upsertWorkspaceIntoBucket(ensureDeviceBucket(ws.deviceId), ws, ws.deviceId, deviceName, { fromServer: true });
        }

        for (const [deviceId, snap] of snapMap.entries()) {
          if (!deviceId || !snap || !Array.isArray(snap.workspaces)) continue;
          const bucket = ensureDeviceBucket(deviceId);
          const deviceName = deviceNameMap.get(deviceId) || snap.deviceName || deviceId;
          for (const liveWs of snap.workspaces) {
            upsertWorkspaceIntoBucket(bucket, liveWs, deviceId, deviceName, { fromServer: false });
          }
        }

        const allMerged = [];
        for (const [, list] of byDevice.entries()) {
          for (const item of list) {
            prepareStabilizedSessionSortState(item.sessions);
            item.sessions.sort(compareRemoteSessionOrder);
            item.sortUpdatedAt = computeStabilizedWorkspaceSortTs(item.sessions, item.updatedAt);
            item.status = computeWorkspaceAggregateStatus(item.sessions, item.sessions.length ? 'idle' : item.status);

            // 检查未置顶会话在 serverWorkspaces 与 controlledSnapshots 之间是否存在 > 60_000ms 的时间戳倒置并上报诊断
            const unpinned = (item.sessions || []).filter((s) => !s.pinned);
            let hasInversion = false;
            for (let i = 0; i < unpinned.length && !hasInversion; i++) {
              const s1 = unpinned[i];
              if (s1.serverUpdatedAt == null || s1.snapUpdatedAt == null) continue;
              for (let j = i + 1; j < unpinned.length; j++) {
                const s2 = unpinned[j];
                if (s2.serverUpdatedAt == null || s2.snapUpdatedAt == null) continue;
                const serverDiff = s1.serverUpdatedAt - s2.serverUpdatedAt;
                const snapDiff = s1.snapUpdatedAt - s2.snapUpdatedAt;
                if ((serverDiff > 0 && snapDiff < 0) || (serverDiff < 0 && snapDiff > 0)) {
                  if (Math.abs(serverDiff - snapDiff) > 60000 || Math.max(Math.abs(serverDiff), Math.abs(snapDiff)) > 60000) {
                    hasInversion = true;
                    break;
                  }
                }
              }
            }
            if (!hasInversion) {
              for (const s of unpinned) {
                if (s.serverUpdatedAt != null && s.snapUpdatedAt != null) {
                  if (Math.abs(s.serverUpdatedAt - s.snapUpdatedAt) > 60000) {
                    hasInversion = true;
                    break;
                  }
                }
              }
            }
            if (hasInversion) {
              emitRemoteWorkspaceDiag('session-sort-diag', item.deviceId, {
                workspaceId: item.workspaceId,
                topSessionId: item.sessions[0]?.sessionId,
                topUpdatedAt: item.sessions[0]?.updatedAt,
              });
            }
            const key = makeWorkspaceKey(item.deviceId, item.workspaceId);
            const titleOverride = store.workspaceTitleOverrides.get(key);
            const effectiveTitle = titleOverride || item.title;
            const altPathKey = item.path ? makeWorkspaceKey(item.deviceId, item.path) : '';
            const altTitleKey = effectiveTitle ? makeWorkspaceKey(item.deviceId, effectiveTitle) : '';
            const isHidden = hidden.has(key)
              || (altPathKey && hidden.has(altPathKey))
              || (altTitleKey && hidden.has(altTitleKey));
            allMerged.push({
              ...item,
              title: effectiveTitle,
              key,
              nativeWorkspaceId: toNativeRemoteWorkspaceId(item.deviceId, item.workspaceId),
              hidden: Boolean(isHidden),
            });
          }
        }

        // 跨设备全局按最近更新时间降序排列（并行流式输出期间使用稳定的 sortUpdatedAt 防止侧边栏工作区跳动）
        allMerged.sort((a, b) => {
          const tsB = Number(b.sortUpdatedAt ?? b.updatedAt ?? 0);
          const tsA = Number(a.sortUpdatedAt ?? a.updatedAt ?? 0);
          const diff = tsB - tsA;
          if (diff !== 0) return diff;
          return String(a.title || '').localeCompare(String(b.title || ''));
        });

        const visible = allMerged.filter((item) => !item.hidden);
        const hiddenCount = allMerged.length - visible.length;
        return { all: allMerged, visible, hiddenCount };
      }

      /** 根据 postMessage 的 event.source 认出对应的远端设备 ID。 */
      function resolveDeviceIdFromMessageSource(sourceWin, fallbackDeviceId = '', doc = typeof document !== 'undefined' ? document : null) {
        if (sourceWin && doc?.querySelectorAll) {
          const frames = doc.querySelectorAll('.dsh-au-stage iframe[name^="dsh-au-controlled:"], iframe[name^="dsh-au-controlled:"]');
          let win = sourceWin;
          const seen = new Set();
          while (win && !seen.has(win)) {
            seen.add(win);
            for (const frame of frames) {
              try {
                if (frame.contentWindow === win && typeof frame.name === 'string' && frame.name.startsWith(CONTROLLED_FRAME_NAME_PREFIX)) {
                  return frame.name.slice(CONTROLLED_FRAME_NAME_PREFIX.length);
                }
              } catch {}
            }
            let parent = null;
            try { parent = win.parent; } catch { break; }
            if (!parent || parent === win) break;
            win = parent;
          }
        }
        return typeof fallbackDeviceId === 'string' ? fallbackDeviceId.trim() : '';
      }

      /** 查找指定远端设备的受控 iframe 节点。 */
      function findControlledFrameByDeviceId(deviceId, doc = typeof document !== 'undefined' ? document : null) {
        if (!deviceId || !doc?.querySelectorAll) return null;
        const targetName = `${CONTROLLED_FRAME_NAME_PREFIX}${deviceId}`;
        const frames = doc.querySelectorAll('.dsh-au-stage iframe[name^="dsh-au-controlled:"], iframe[name^="dsh-au-controlled:"]');
        for (const frame of frames) {
          if (frame?.name === targetName) return frame;
        }
        return null;
      }

      function nextRemoteCommandId() {
        return `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      }

      /** 收到受控端 ack 后清理对应的待发指令，防止快照回传触发重复执行。 */
      /** 判断指定远端设备是否已回传过真实的受控端工作区快照（而非本地乐观注入的占位记录）。 */
      function hasLiveControlledSnapshot(deviceId) {
        if (!deviceId) return false;
        const snap = store.controlledSnapshots.get(deviceId);
        return Boolean(snap && snap.fromControlledFrame === true);
      }

      /** 清理指定远端设备快照中未发消息的乐观空白会话（「新对话」），切换工作区或会话时立即释放残留。 */
      function clearOptimisticBlankSessions(deviceId, keepSessionId = '') {
        if (!deviceId) return false;
        const snap = store.controlledSnapshots.get(deviceId);
        if (!snap || !Array.isArray(snap.workspaces)) return false;
        let changed = false;
        const nextWorkspaces = snap.workspaces.map((wsItem) => {
          if (!Array.isArray(wsItem?.sessions)) return wsItem;
          const filtered = wsItem.sessions.filter((s) => !s?.blank || (keepSessionId && s.sessionId === keepSessionId));
          if (filtered.length !== wsItem.sessions.length) {
            changed = true;
            return { ...wsItem, sessions: filtered };
          }
          return wsItem;
        });
        if (changed) {
          store.controlledSnapshots.set(deviceId, {
            ...snap,
            workspaces: nextWorkspaces,
          });
        }
        return changed;
      }

      /** 仅清理某次已被新操作取代的乐观占位会话（不误删更新的「新对话」）。 */
      function removeSpecificOptimisticSession(deviceId, targetSessionId) {
        if (!deviceId || !targetSessionId) return false;
        const snap = store.controlledSnapshots.get(deviceId);
        if (!snap || !Array.isArray(snap.workspaces)) return false;
        let changed = false;
        const nextWorkspaces = snap.workspaces.map((wsItem) => {
          if (!Array.isArray(wsItem?.sessions)) return wsItem;
          const filtered = wsItem.sessions.filter((s) => s?.sessionId !== targetSessionId);
          if (filtered.length !== wsItem.sessions.length) {
            changed = true;
            return { ...wsItem, sessions: filtered };
          }
          return wsItem;
        });
        if (changed) {
          store.controlledSnapshots.set(deviceId, {
            ...snap,
            workspaces: nextWorkspaces,
          });
        }
        return changed;
      }

      function acknowledgeRemoteCommand(deviceId, commandId, { stage = 'done' } = {}) {
        if (!commandId) return;
        const handleInEntry = (devId, entry) => {
          if (!entry || !Array.isArray(entry.messages)) return;
          if (stage === 'received') {
            if (entry.commandId === commandId || entry.messages.some((m) => m?.commandId === commandId)) {
              entry.receivedAck = true;
            }
            return;
          }
          entry.messages = entry.messages.filter((m) => m?.commandId !== commandId);
          if (!entry.messages.length) pendingRemoteCommands.delete(devId);
        };
        if (deviceId && pendingRemoteCommands.has(deviceId)) {
          handleInEntry(deviceId, pendingRemoteCommands.get(deviceId));
          return;
        }
        for (const [devId, entry] of pendingRemoteCommands.entries()) {
          handleInEntry(devId, entry);
        }
      }

      /** 冲刷指定远端设备的待发工作区/会话控制指令。 */
      function flushPendingRemoteCommands(deviceId, targetWindow = null, doc = typeof document !== 'undefined' ? document : null, { fromSnapshot = false } = {}) {
        if (!deviceId) return false;
        const pending = pendingRemoteCommands.get(deviceId);
        if (!pending) return false;
        if (Date.now() > pending.expiresAt) {
          pendingRemoteCommands.delete(deviceId);
          return false;
        }
        const win = targetWindow || findControlledFrameByDeviceId(deviceId, doc)?.contentWindow;
        if (!win || typeof win.postMessage !== 'function') return false;
        let sentAny = false;
        for (const msg of pending.messages) {
          // 一次性新建会话指令一旦已投递过，后续收到快照回传时严禁再次重放，防止循环触发 startSession
          if (fromSnapshot && msg?.createNew === true && (pending.deliveredCount || 0) >= 1) {
            continue;
          }
          try {
            win.postMessage(msg, '*');
            sentAny = true;
          } catch {}
        }
        if (sentAny) {
          pending.deliveredCount = (pending.deliveredCount || 0) + 1;
        }
        return sentAny;
      }

      /**
       * 向目标远端 iframe 发送指令；若 iframe 尚未加载就绪则缓存待发指令，
       * 在 load / frame-ready / dsh-au:controlled-workspaces-snapshot 时自动补发。
       */
      function sendOrQueueRemoteCommand(deviceId, messages, doc = typeof document !== 'undefined' ? document : null) {
        if (!deviceId) return;
        const rawList = (Array.isArray(messages) ? messages : [messages]).filter(Boolean);
        if (!rawList.length) return;
        const presetCid = rawList.find((m) => m && typeof m.commandId === 'string' && m.commandId)?.commandId;
        const cid = presetCid || nextRemoteCommandId();
        const isNavigation = rawList.some((m) => m?.type === 'dsh-au:open-remote-session' || m?.type === 'dsh-au:open-remote-workspace');
        const selectionSeq = store.createSessionSeq;
        const msgList = rawList.map((m) => (m && typeof m === 'object'
          ? { ...m, commandId: m.commandId || cid, ...(isNavigation ? { selectionSeq } : {}) }
          : m));
        if (isNavigation) store.latestNavigationByDevice.set(deviceId, { commandId: cid, selectionSeq, pending: true });
        const entry = {
          commandId: cid,
          messages: msgList,
          deliveredCount: 0,
          receivedAck: false,
          expiresAt: Date.now() + 15000,
        };
        pendingRemoteCommands.set(deviceId, entry);
        const deliver = () => {
          if (pendingRemoteCommands.get(deviceId) !== entry) return false;
          const frame = findControlledFrameByDeviceId(deviceId, doc);
          if (!frame?.contentWindow) return false;
          for (const msg of entry.messages) {
            try { frame.contentWindow.postMessage(msg, '*'); } catch {}
          }
          entry.deliveredCount += 1;
          return true;
        };
        const deliveredImmediately = deliver();
        const isWarmFrame = Boolean(
          deliveredImmediately && (hasLiveControlledSnapshot(deviceId) || store.warmDevices?.has?.(deviceId))
        );
        const hasOneShotCreate = msgList.some((m) => m?.createNew === true);
        if (!isWarmFrame && typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
          window.setTimeout(() => {
            if (!hasOneShotCreate || entry.deliveredCount === 0) {
              deliver();
            }
            const frame = findControlledFrameByDeviceId(deviceId, doc);
            if (frame && typeof frame.addEventListener === 'function') {
              frame.addEventListener('load', () => {
                store.warmDevices?.add?.(deviceId);
                flushPendingRemoteCommands(deviceId, frame.contentWindow, doc);
                window.setTimeout(() => flushPendingRemoteCommands(deviceId, frame.contentWindow, doc), 280);
              }, { once: true });
            }
          }, 60);
          if (!hasOneShotCreate || !deliveredImmediately) {
            for (const delay of [320, 950, 2100]) {
              window.setTimeout(() => {
                if (hasOneShotCreate && entry.deliveredCount >= 1) return;
                deliver();
              }, delay);
            }
          }
        }
      }

      function isCurrentRemoteNavigation(deviceId, data) {
        const latest = store.latestNavigationByDevice.get(deviceId);
        if (!latest) return true;
        if (Number.isSafeInteger(data?.selectionSeq) && data.selectionSeq !== latest.selectionSeq) return false;
        const commandId = data?.navigationCommandId || data?.commandId;
        if (commandId && commandId !== latest.commandId) return false;
        return !latest.cancelled;
      }

      /** 切走设备时让该 iframe 的旧异步导航失效，不关闭保活页面。 */
      function cancelRemoteNavigation(deviceId, doc = typeof document !== 'undefined' ? document : null) {
        if (!deviceId || deviceId === 'local') return;
        store.createSessionSeq += 1;
        const selectionSeq = store.createSessionSeq;
        store.latestNavigationByDevice.set(deviceId, { commandId: '', selectionSeq, pending: false, cancelled: true });
        pendingRemoteCommands.delete(deviceId);
        try {
          findControlledFrameByDeviceId(deviceId, doc)?.contentWindow?.postMessage({
            source: 'dsh-au', type: 'dsh-au:cancel-remote-navigation', selectionSeq,
          }, '*');
        } catch {}
      }

      /** 查找宿主左侧栏原生工作区树容器。 */
      function findNativeWorkspaceTreeContainer(doc = typeof document !== 'undefined' ? document : null) {
        if (!doc?.querySelector) return null;
        return (
          doc.querySelector('[class*="_sidebarCol"] [class*="_treeBody"] div[role="tree"][class*="_list"]:not([class*="_searchTree"])')
          || doc.querySelector('[class*="_regionArea"] [class*="_treeBody"] div[role="tree"][class*="_list"]:not([class*="_searchTree"])')
          || doc.querySelector('[class*="_treeBody"] div[role="tree"][class*="_list"]:not([class*="_searchTree"])')
          || doc.querySelector('aside[data-slot="sidebar"] [data-slot="sidebar.workspaces"] div[role="tree"][class*="_list"]:not([class*="_searchTree"])')
          || doc.querySelector('aside[data-slot="sidebar"] [data-slot="sidebar.workspaces"] div[role="tree"]:not([class*="_searchTree"])')
          || doc.querySelector('div[role="tree"][class*="_list"]:not([class*="_searchTree"])')
        );
      }

      /**
       * 在原生工作区树容器末尾维护专属挂载节点 `<div class="dsh-au-remote-ws-root" data-dsh-au-remote-workspaces="1"></div>`。
       * 严禁在内部任何元素上设置 `data-row-key` 属性，避免触发宿主 AnimatedRows.readPositions() 动画计算。
       */
      function ensureRemoteWorkspacesMountNode(doc = typeof document !== 'undefined' ? document : null) {
        const treeContainer = findNativeWorkspaceTreeContainer(doc);
        if (!treeContainer) return null;
        let mountNode = treeContainer.querySelector(`:scope > div.${MOUNT_CLASS}[${MOUNT_ATTR}="1"]`)
          || doc.querySelector(`div.${MOUNT_CLASS}[${MOUNT_ATTR}="1"]`);
        if (!mountNode) {
          mountNode = doc.createElement('div');
          mountNode.className = MOUNT_CLASS;
          mountNode.setAttribute(MOUNT_ATTR, '1');
        }
        if (mountNode.parentElement !== treeContainer || treeContainer.lastElementChild !== mountNode) {
          treeContainer.appendChild(mountNode);
        }
        return mountNode;
      }

      /**
       * 判断在远端舞台激活态下，点击侧边栏目标是否应自动将右侧舞台切回本机：
       * 命中原生本地工作区行、本地会话行、顶栏「新建对话」按钮或侧栏面板按钮（插件市场、设置等），且不在远端工作区挂载点或远端原生行内。
       */
      function shouldSwitchToLocalOnSidebarClick(target, doc = typeof document !== 'undefined' ? document : null) {
        if (!target || typeof target.closest !== 'function') return false;
        const activeAttr = doc?.documentElement?.getAttribute?.('data-dsh-au-remote-active');
        if (activeAttr !== 'true') return false;
        if (!target.closest('[class*="_sidebarCol"], [class*="_regionArea"], [class*="_settingsArea"], [data-sidebar-header-controls], aside[data-slot="sidebar"]')) return false;
        if (target.closest(`[${MOUNT_ATTR}="1"]`)) return false;
        if (target.closest('[data-dsh-au-ext-sidebar="1"]')) return false;
        if (target.closest(`[data-row-key^="workspace:${NATIVE_REMOTE_WS_PREFIX}"]`)) return false;
        const wsRow = target.closest('[data-row-key^="workspace:"]');
        if (wsRow && typeof wsRow.getAttribute === 'function') {
          const wsRowKey = wsRow.getAttribute('data-row-key') || '';
          if (wsRowKey.startsWith(`workspace:${NATIVE_REMOTE_WS_PREFIX}`)) return false;
        }
        const sessRow = target.closest('[data-row-key^="session:"]');
        if (sessRow && typeof sessRow.getAttribute === 'function') {
          const sessRowKey = sessRow.getAttribute('data-row-key') || '';
          const sid = sessRowKey.startsWith('session:') ? sessRowKey.slice('session:'.length) : '';
          if (sid && store.nativeSessionById.has(sid)) return false;
        }
        return Boolean(
          target.closest(
            '[data-row-key^="workspace:"], [data-row-key^="session:"], button[class*="_newSession"], button[class*="_brand"], [data-sidebar-header-controls] button:last-child, button[class*="_panelRow"], [class*="_panelRow"], [data-panel-id], [class*="_settingsArea"] button, button[class*="_settings"], a[href]'
          )
        );
      }

      // ===== SVG 图标组件（优先复用 DSH 原生图标原语，回退内联 SVG） =====
      function RemoteFolderClosedIcon() {
        if (typeof uiPrimitives?.IconFolderCloseRegular === 'function') {
          return h(uiPrimitives.IconFolderCloseRegular);
        }
        return h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, [
          h('path', { key: 'folder', d: 'M3 6.5A1.5 1.5 0 0 1 4.5 5h4.38a1.5 1.5 0 0 1 1.14.52L11.5 7.5H19.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-12Z' }),
        ]);
      }

      function RemoteFolderOpenIcon() {
        if (typeof uiPrimitives?.IconFolderOpenRegular === 'function') {
          return h(uiPrimitives.IconFolderOpenRegular);
        }
        return h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, [
          h('path', { key: 'base', d: 'M3 18.5V6.5A1.5 1.5 0 0 1 4.5 5h4.38a1.5 1.5 0 0 1 1.14.52L11.5 7.5H19.5A1.5 1.5 0 0 1 21 9v2' }),
          h('path', { key: 'flap', d: 'M3 18.5 5.2 11h16.3l-2.2 7.5a1.5 1.5 0 0 1-1.44 1H4.44A1.5 1.5 0 0 1 3 18.5Z' }),
        ]);
      }

      function RemoteChevronIcon() {
        if (typeof uiPrimitives?.IconTriangleRightFillRegular === 'function') {
          return h(uiPrimitives.IconTriangleRightFillRegular);
        }
        return h('svg', { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.1, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, [
          h('polyline', { key: 'p', points: '9 6 15 12 9 18' }),
        ]);
      }

      function RemoteMonitorIcon() {
        return h('svg', { width: 10, height: 10, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, [
          h('rect', { key: 'r', x: 3, y: 4, width: 18, height: 12, rx: 2 }),
          h('line', { key: 'l1', x1: 8, y1: 20, x2: 16, y2: 20 }),
          h('line', { key: 'l2', x1: 12, y1: 16, x2: 12, y2: 20 }),
        ]);
      }

      function RemoteEyeOffIcon() {
        return h('svg', { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, [
          h('path', { key: 'a', d: 'M17.94 17.94A10.07 10.07 0 0 1 12 19c-5 0-9.27-3.11-11-7 1.02-2.29 2.77-4.22 4.94-5.44' }),
          h('path', { key: 'b', d: 'M9.9 4.24A9.12 9.12 0 0 1 12 4c5 0 9.27 3.11 11 7a11.6 11.6 0 0 1-2.16 3.19' }),
          h('line', { key: 'c', x1: 2, y1: 2, x2: 22, y2: 22 }),
        ]);
      }

      function RemotePlusIcon() {
        if (typeof uiPrimitives?.IconAddOutlineRegular === 'function') {
          return h(uiPrimitives.IconAddOutlineRegular);
        }
        return h('svg', { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, [
          h('line', { key: 'v', x1: 12, y1: 5, x2: 12, y2: 19 }),
          h('line', { key: 'h', x1: 5, y1: 12, x2: 19, y2: 12 }),
        ]);
      }

      /** 将新建的远端空白会话乐观写入对应工作区快照并置为选中，使左侧栏立即反馈「新对话」。 */
      function injectOptimisticRemoteSession(ws, sessionId) {
        if (!ws?.deviceId || !sessionId) return;
        const now = Date.now();
        const newSession = {
          sessionId,
          title: '新对话',
          status: 'idle',
          updatedAt: now,
          cwd: ws.path || '',
          blank: true,
        };
        const existingSnap = store.controlledSnapshots.get(ws.deviceId);
        // 复制旧快照时丢弃此前残留的空白占位会话：它们已不是当前会话，继续携带只会把已发消息的会话误标为空白
        const snapWorkspaces = Array.isArray(existingSnap?.workspaces)
          ? existingSnap.workspaces.map((item) => ({
              ...item,
              sessions: Array.isArray(item.sessions) ? item.sessions.filter((s) => !s?.blank) : [],
            }))
          : [];
        const wsPathKey = normalizeWorkspacePathKey(ws.path || '');
        const wsTitle = normalizeWorkspaceTitle(ws.title || '', ws.path || '');
        let targetWs = snapWorkspaces.find((item) => {
          if (item.workspaceId && ws.workspaceId && item.workspaceId === ws.workspaceId) return true;
          const itemPathKey = normalizeWorkspacePathKey(item.path || '');
          if (wsPathKey && itemPathKey && wsPathKey === itemPathKey) return true;
          const itemTitle = normalizeWorkspaceTitle(item.title || '', item.path || '');
          if (wsTitle && itemTitle === wsTitle) return true;
          return false;
        });
        if (!targetWs) {
          targetWs = {
            workspaceId: ws.workspaceId || 'default-workspace',
            title: wsTitle,
            path: ws.path || '',
            updatedAt: now,
            sessions: [],
          };
          snapWorkspaces.unshift(targetWs);
        }
        targetWs.sessions = [
          newSession,
          ...targetWs.sessions.filter((s) => s?.sessionId !== sessionId),
        ];
        targetWs.updatedAt = now;
        store.controlledSnapshots.set(ws.deviceId, {
          workspaces: snapWorkspaces,
          currentSessionId: sessionId,
          updatedAt: now,
          fromControlledFrame: Boolean(existingSnap?.fromControlledFrame === true),
        });
        store.selectedSessionByDevice.set(ws.deviceId, sessionId);
        notifyStoreListeners();
      }

      const STAGE_TRANSITION_EVENT = 'dsh-au:stage-transition';
      const PRELOAD_DEVICE_EVENT = 'dsh-au:preload-device';

      function dispatchStageTransition(detail) {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
          window.dispatchEvent(new CustomEvent(STAGE_TRANSITION_EVENT, { detail }));
        }
      }

      function dispatchPreloadDevices(deviceIds) {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
          const list = [...new Set((Array.isArray(deviceIds) ? deviceIds : [deviceIds]).filter((id) => typeof id === 'string' && id && id !== 'local'))];
          // 空计划也要通知壳层清空待预热队列；已打开/访问过的 iframe 由壳层保留。
          window.dispatchEvent(new CustomEvent(PRELOAD_DEVICE_EVENT, { detail: { deviceId: list[0] || '', deviceIds: list } }));
        }
      }

      /** 读取 localStorage 中已解析的远端工作区真实 ID 映射表（deviceId::normPath -> realWorkspaceId）。 */
      function readCachedResolvedWorkspaceIds(storage = typeof localStorage !== 'undefined' ? localStorage : null) {
        try {
          const raw = storage?.getItem?.(RESOLVED_WS_STORAGE_KEY);
          const parsed = JSON.parse(raw || '{}');
          if (!parsed || typeof parsed !== 'object') return new Map();
          const map = new Map();
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof k === 'string' && typeof v === 'string' && k && v) map.set(k, v);
          }
          return map;
        } catch {
          return new Map();
        }
      }

      /** 缓存远端目录对应的真实原生 workspaceId，后续点击 + 新建对话直接跳过 workspace/create 往返。 */
      function rememberResolvedRemoteWorkspaceId(deviceId, rawPath, workspaceId, storage = typeof localStorage !== 'undefined' ? localStorage : null) {
        const cleanDev = String(deviceId || '').trim();
        const pathKey = normalizeWorkspacePathKey(rawPath);
        const cleanWsId = String(workspaceId || '').trim();
        if (
          !cleanDev
          || !pathKey
          || !cleanWsId
          || cleanWsId === 'default'
          || cleanWsId === 'default-workspace'
          || cleanWsId.startsWith('cwd:')
          || cleanWsId.startsWith('ws:')
        ) {
          return;
        }
        const cacheKey = `${cleanDev}::${pathKey}`;
        if (store.resolvedWorkspaceIds.get(cacheKey) === cleanWsId) return;
        store.resolvedWorkspaceIds.set(cacheKey, cleanWsId);
        try {
          const obj = {};
          for (const [k, v] of store.resolvedWorkspaceIds.entries()) obj[k] = v;
          storage?.setItem?.(RESOLVED_WS_STORAGE_KEY, JSON.stringify(obj));
        } catch {}
      }

      /** 获取远端工作区最有效的 workspaceId（若当前是合成 cwd:/ws: ID 且缓存中已有真实 ID，则直接返回真实 ID）。 */
      function resolveEffectiveRemoteWorkspaceId(ws) {
        const rawWsId = String(ws?.workspaceId || '').trim();
        if (rawWsId && rawWsId !== 'default' && rawWsId !== 'default-workspace' && !rawWsId.startsWith('cwd:') && !rawWsId.startsWith('ws:')) {
          if (ws?.deviceId && ws?.path) {
            rememberResolvedRemoteWorkspaceId(ws.deviceId, ws.path, rawWsId);
          }
          return rawWsId;
        }
        const cleanDev = String(ws?.deviceId || '').trim();
        const pathKey = normalizeWorkspacePathKey(ws?.path || '');
        if (cleanDev && pathKey) {
          if (store.resolvedWorkspaceIds.size === 0) {
            for (const [k, v] of readCachedResolvedWorkspaceIds().entries()) {
              store.resolvedWorkspaceIds.set(k, v);
            }
          }
          const cached = store.resolvedWorkspaceIds.get(`${cleanDev}::${pathKey}`);
          if (cached) return cached;
        }
        return rawWsId;
      }

      /**
       * 若当前设备在 store.devices 中存在已选中的在线路由（selectedRoute.id），
       * 将该 routeId 作为 `/dsh-au-todo/api` 的目标标识：
       * 服务端 `requestDevice` 通过 `aliases` 同样命中该设备，而 `refreshDevice` 仅匹配该在线路由，
       * 彻底跳过同一设备下离线的局域网路由（消除 4.5s 局域网探活超时阻塞）。
       */
      function resolvePreferredRemoteApiTargetId(deviceId) {
        const cleanId = String(deviceId || '').trim();
        if (!cleanId) return '';
        const dev = (Array.isArray(store.devices) ? store.devices : []).find((d) => d && d.id === cleanId);
        const route = dev?.selectedRoute;
        const routeId = (route && route.online !== false && typeof route.id === 'string') ? route.id.trim() : '';
        return routeId || cleanId;
      }

      /**
       * 将底层通信路径（lan / tunnel / ipv6）映射为工作区展示标签：
       * - lan -> 'Lan'
       * - tunnel / ipv4 -> 'ipv4'
       * - ipv6 -> 'ipv6'
       */
      function mapTransportToBadgeLabel(rawTransport, route = null) {
        const t = String(rawTransport || '').toLowerCase().trim();
        if (t === 'lan') return 'Lan';
        if (t === 'ipv6') return 'ipv6';
        if (t === 'tunnel' || t === 'ipv4') return 'ipv4';
        if (route) {
          const url = String(route.url || route.originUrl || '').toLowerCase();
          if (url.includes('ipv6') || url.includes('[') || route.remoteFamily === 'IPv6') return 'ipv6';
        }
        return '';
      }

      /** 根据远端 deviceId 解析出当前正在使用/就绪的通信路径标签（Lan、ipv4、ipv6）。 */
      function resolveDeviceConnectionTransport(deviceId) {
        const cleanId = String(deviceId || '').trim();
        if (!cleanId || cleanId === 'local') return '';

        const snap = typeof window !== 'undefined' ? window.__dshAuLastStateSnap : null;
        const selfDeviceId = String(store.localDeviceId || snap?.self?.deviceId || snap?.localDeviceId || '').trim();
        const selfInstanceId = String(snap?.self?.instanceId || '').trim();
        if ((selfDeviceId && cleanId === selfDeviceId) || (selfInstanceId && cleanId === selfInstanceId)) return '';

        const deviceList = Array.isArray(store.devices) && store.devices.length > 0
          ? store.devices
          : (typeof window !== 'undefined' && Array.isArray(window.__dshAuAllDevices) && window.__dshAuAllDevices.length > 0
              ? window.__dshAuAllDevices
              : (typeof window !== 'undefined' && Array.isArray(window.__dshAuLastStateSnap?.devices)
                  ? window.__dshAuLastStateSnap.devices
                  : []));

        const dev = deviceList.find((d) => d && (d.id === cleanId || d.deviceId === cleanId));
        if (dev?.isLocal === true || dev?.selectedRoute?.type === 'local' || dev?.selectedRoute?.kind === 'local') return '';
        const selected = dev?.selectedRoute;
        if (selected) {
          const label = mapTransportToBadgeLabel(selected.transport || selected.type || selected.kind, selected);
          if (label) return label;
        }

        if (dev && Array.isArray(dev.routes) && dev.routes.length > 0) {
          const onlineRoute = dev.routes.find((r) => r && r.online !== false && r.type !== 'local')
            || dev.routes.find((r) => r && r.type !== 'local');
          if (onlineRoute) {
            const label = mapTransportToBadgeLabel(onlineRoute.transport || onlineRoute.type || onlineRoute.kind, onlineRoute);
            if (label) return label;
          }
        }

        const remotes = (typeof window !== 'undefined' && Array.isArray(window.__dshAuLastStateSnap?.remotes))
          ? window.__dshAuLastStateSnap.remotes
          : [];
        const remote = remotes.find((r) => r && r.deviceId === cleanId && r.online !== false)
          || remotes.find((r) => r && r.deviceId === cleanId);
        if (remote) {
          const label = mapTransportToBadgeLabel(remote.transport || remote.type || remote.kind, remote);
          if (label) return label;
        }

        return '';
      }

      /** 记录远端工作区与会话操作的耗时及状态诊断日志（写入服务端 dsh-au-net.jsonl）。 */
      function emitRemoteWorkspaceDiag(event, deviceId, details = {}) {
        try {
          if (typeof reportClientEvent === 'function') {
            reportClientEvent(event, deviceId, {
              reason: event,
              ...details,
            });
          }
        } catch {}
      }

      /**
       * 调用服务端 `/dsh-au-todo/api` (`createRemoteSession`) 或受控代理 `/api/session/create`
       * 在远端工作区创建空白会话，兼容未更新 `dsh-au` 的旧版远端设备。
       */
      async function createRemoteBlankSession(ws, doc = typeof document !== 'undefined' ? document : null) {
        if (!ws?.deviceId || typeof fetch !== 'function') return null;
        const startedAt = Date.now();
        const targetApiDeviceId = resolvePreferredRemoteApiTargetId(ws.deviceId);
        const effectiveWsId = resolveEffectiveRemoteWorkspaceId(ws);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const res = await fetch('/dsh-au-todo/api', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                action: 'createRemoteSession',
                deviceId: targetApiDeviceId,
                workspaceId: effectiveWsId,
                cwd: ws.path || '',
                title: ws.title || '',
              }),
            });
            const data = await res?.json?.().catch?.(() => null);
            if (data?.ok && typeof data.sessionId === 'string' && data.sessionId) {
              if (typeof data.workspaceId === 'string' && data.workspaceId && ws.path) {
                rememberResolvedRemoteWorkspaceId(ws.deviceId, ws.path, data.workspaceId);
              }
              emitRemoteWorkspaceDiag('remote-session-create', ws.deviceId, {
                routeId: targetApiDeviceId,
                workspaceId: String(data.workspaceId || effectiveWsId || '').replace(/[\\/]+/g, '.'),
                sessionId: data.sessionId,
                result: attempt > 0 ? 'ok-retry' : 'ok',
                elapsedMs: Date.now() - startedAt,
              });
              return data.sessionId;
            }
          } catch {}
          if (attempt === 0) {
            await new Promise((r) => setTimeout(r, 300));
          }
        }

        // 若本地宿主尚未重载 createRemoteSession，尝试直调远端受控代理端口的 `/api/workspace/create` + `/api/session/create`
        try {
          const frame = findControlledFrameByDeviceId(ws.deviceId, doc);
          const rawSrc = frame?.src || (typeof frame?.getAttribute === 'function' ? frame.getAttribute('src') : '');
          if (rawSrc && /^https?:\/\//i.test(rawSrc)) {
            const proxyOrigin = new URL(rawSrc).origin;
            const cleanCwd = String(ws.path || '').trim();
            const rawWsId = String(effectiveWsId || ws.workspaceId || '').trim();
            let realWsId = (rawWsId && rawWsId !== 'default' && rawWsId !== 'default-workspace' && !rawWsId.startsWith('ws:') && !rawWsId.startsWith('cwd:'))
              ? rawWsId
              : '';
            if (!realWsId && cleanCwd) {
              try {
                const wsRes = await fetch(`${proxyOrigin}/api/workspace/create`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    type: 'client-request',
                    rpcId: nextRemoteCommandId(),
                    method: 'workspace/create',
                    payload: { args: { request: { path: cleanCwd } } },
                  }),
                });
                const wsData = await wsRes?.json?.().catch?.(() => null);
                const resolvedId = wsData?.result?.value?.workspace?.workspaceId || wsData?.value?.workspace?.workspaceId || '';
                if (typeof resolvedId === 'string' && resolvedId) {
                  realWsId = resolvedId;
                  rememberResolvedRemoteWorkspaceId(ws.deviceId, cleanCwd, resolvedId);
                }
              } catch {}
            }
            const res = await fetch(`${proxyOrigin}/api/session/create`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                type: 'client-request',
                rpcId: nextRemoteCommandId(),
                method: 'session/create',
                payload: {
                  args: {
                    request: realWsId ? { workspaceId: realWsId } : (cleanCwd ? { cwd: cleanCwd } : {}),
                  },
                },
              }),
            });
            const data = await res?.json?.().catch?.(() => null);
            const sid = data?.result?.value?.sessionId || data?.sessionId || '';
            if (typeof sid === 'string' && sid) {
              if (typeof featuresStore !== 'undefined' && featuresStore.snapshot.fullAccessByDefault) {
                void fetch(`${proxyOrigin}/api/settings/mutate`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    type: 'client-request',
                    rpcId: nextRemoteCommandId(),
                    method: 'settings/mutate',
                    payload: {
                      args: {
                        ns: 'permission',
                        ops: [{ op: 'set', path: ['defaultPreset'], value: 'danger-full-access' }],
                      },
                    },
                  }),
                }).catch(() => {});
              }
              emitRemoteWorkspaceDiag('remote-session-create', ws.deviceId, {
                routeId: targetApiDeviceId,
                workspaceId: String(realWsId || effectiveWsId || '').replace(/[\\/]+/g, '.'),
                sessionId: sid,
                result: 'ok-proxy-fallback',
                elapsedMs: Date.now() - startedAt,
              });
              return sid;
            }
          }
        } catch {}
        emitRemoteWorkspaceDiag('remote-session-create', ws.deviceId, {
          routeId: targetApiDeviceId,
          workspaceId: String(effectiveWsId || '').replace(/[\\/]+/g, '.'),
          result: 'failed',
          elapsedMs: Date.now() - startedAt,
        });
        return null;
      }

      /** 激活远端工作区（或在其下新建对话）。 */
      function activateRemoteWorkspace(ws, { createNew = false } = {}, doc = typeof document !== 'undefined' ? document : null) {
        if (!ws?.deviceId) return null;
        if (store.activeDeviceId && store.activeDeviceId !== ws.deviceId) cancelRemoteNavigation(store.activeDeviceId, doc);
        store.createSessionSeq = (Number(store.createSessionSeq) || 0) + 1;
        const myCreateSeq = store.createSessionSeq;
        const wsKey = ws.key || makeWorkspaceKey(ws.deviceId, ws.workspaceId);
        clearOptimisticBlankSessions(ws.deviceId);
        store.expandedKeys.add(wsKey);
        persistExpandedRemoteWorkspaces();
        store.selectedWorkspaceByDevice.set(ws.deviceId, wsKey);
        if (createNew) {
          store.selectedSessionByDevice.delete(ws.deviceId);
          pruneActiveInteractedSessions('');
        } else if (ws.sessions?.[0]?.sessionId) {
          store.selectedSessionByDevice.set(ws.deviceId, ws.sessions[0].sessionId);
          pruneActiveInteractedSessions(ws.sessions[0].sessionId);
        } else {
          pruneActiveInteractedSessions('');
        }
        store.activeDeviceId = ws.deviceId;
         remoteSessionPreloadCoordinator?.notifyForeground(ws.deviceId, store.selectedSessionByDevice.get(ws.deviceId) || '');
        notifyStoreListeners();
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
          window.dispatchEvent(new CustomEvent(DEVICE_SELECT_EVENT, { detail: { deviceId: ws.deviceId, skipInitialFocus: true } }));
        }
        const commandId = nextRemoteCommandId();
        const devLabel = ws.deviceName || ws.deviceId || '远程设备';
        const wsLabel = ws.title || '工作区';
        dispatchStageTransition({
          active: true,
          deviceId: ws.deviceId,
          commandId,
          timeoutMs: createNew ? 6500 : 2400,
          label: createNew
            ? `正在 ${devLabel} · ${wsLabel} 中新建对话 ...`
            : `正在切换至 ${devLabel} · ${wsLabel} ...`,
        });
        if (!createNew) {
          const fallbackSid = ws.sessions?.[0]?.sessionId || '';
          emitRemoteWorkspaceDiag('remote-workspace-open', ws.deviceId, {
            routeId: resolvePreferredRemoteApiTargetId(ws.deviceId),
            workspaceId: String(ws.workspaceId || '').replace(/[\\/]+/g, '.'),
            sessionId: fallbackSid,
            result: 'switch-workspace',
          });
          const messages = [{
            source: 'dsh-au',
            type: 'dsh-au:open-remote-workspace',
            commandId,
            deviceId: ws.deviceId,
            workspaceId: ws.workspaceId,
            path: ws.path || '',
            title: ws.title || '',
            createNew: false,
            fallbackSessionId: fallbackSid,
          }];
          if (fallbackSid) {
            messages.push({
              source: 'dsh-au-todo',
              type: 'dsh-au-todo:select-session',
              deviceId: ws.deviceId,
              sessionId: fallbackSid,
            });
          }
          sendOrQueueRemoteCommand(ws.deviceId, messages, doc);
          return null;
        }

        const openWsMessage = {
          source: 'dsh-au',
          type: 'dsh-au:open-remote-workspace',
          commandId,
          deviceId: ws.deviceId,
          workspaceId: ws.workspaceId,
          path: ws.path || '',
          title: ws.title || '',
          createNew: true,
          fallbackSessionId: ws.sessions?.[0]?.sessionId || '',
        };

        if (typeof fetch !== 'function') {
          sendOrQueueRemoteCommand(ws.deviceId, [openWsMessage], doc);
          return null;
        }

        let fallbackStarted = false;
        const fallbackToBackendCreate = async () => {
          pendingCreateFallbacks.delete(commandId);
          if (fallbackStarted) return null;
          fallbackStarted = true;
          if (store.createSessionSeq !== myCreateSeq) return null;
          // 0ms 乐观在左侧栏目标工作区下立即挂载「新对话」占位项，消除等待后端创建期间侧栏无响应的空窗期
          const tempSessionId = `dsh-au-creating:${commandId}`;
          injectOptimisticRemoteSession({ ...ws, key: wsKey }, tempSessionId);
          const createdSessionId = await createRemoteBlankSession(ws, doc);
          // 若等待后端创建期间用户已连点其他工作区「+」或切换到其他会话，仅回收本次的临时占位，绝不回抢焦点
          if (store.createSessionSeq !== myCreateSeq) {
            removeSpecificOptimisticSession(ws.deviceId, tempSessionId);
            notifyStoreListeners();
            return createdSessionId || null;
          }
          if (createdSessionId) {
            injectOptimisticRemoteSession({ ...ws, key: wsKey }, createdSessionId);
            pruneActiveInteractedSessions(createdSessionId);
            sendOrQueueRemoteCommand(ws.deviceId, [
              {
                source: 'dsh-au',
                type: 'dsh-au:open-remote-session',
                commandId: nextRemoteCommandId(),
                deviceId: ws.deviceId,
                sessionId: createdSessionId,
                workspaceId: ws.workspaceId || '',
                path: ws.path || '',
                title: ws.title || '',
                createNew: true,
              },
              {
                source: 'dsh-au-todo',
                type: 'dsh-au-todo:select-session',
                deviceId: ws.deviceId,
                sessionId: createdSessionId,
              },
            ], doc);
            if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
              window.setTimeout(() => {
                dispatchStageTransition({
                  active: false,
                  deviceId: ws.deviceId,
                  commandId,
                });
              }, 350);
            }
            return createdSessionId;
          }
          removeSpecificOptimisticSession(ws.deviceId, tempSessionId);
          sendOrQueueRemoteCommand(ws.deviceId, [openWsMessage], doc);
          return null;
        };

        // 若受控端已预热并回传过真实工作区快照（确认受控端支持 open-remote-workspace），立即向受控 iframe 下发原生指令；
        // 若超时未收到受控端 ack，自动降级走后端 createRemoteBlankSession + select-session 兜底。
        if (hasLiveControlledSnapshot(ws.deviceId) && findControlledFrameByDeviceId(ws.deviceId, doc)?.contentWindow) {
          pendingCreateFallbacks.set(commandId, fallbackToBackendCreate);
          sendOrQueueRemoteCommand(ws.deviceId, [openWsMessage], doc);
          if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
            window.setTimeout(() => {
              if (store.createSessionSeq !== myCreateSeq) {
                pendingCreateFallbacks.delete(commandId);
                return;
              }
              const pending = pendingRemoteCommands.get(ws.deviceId);
              if (pending && pending.commandId === commandId && !pending.receivedAck) {
                void fallbackToBackendCreate();
              }
            }, 900);
            window.setTimeout(() => {
              pendingCreateFallbacks.delete(commandId);
            }, 15000);
          }
          return null;
        }

        return fallbackToBackendCreate();
      }

      /**
       * 乐观确认远端会话已读/完成状态：
       * 立即清除本地缓存（serverWorkspaces + controlledSnapshots）中该会话的 completionUnread 与 done/error 状态，
       * 同步向受控端下发 dsh-au:confirm-remote-session 清理原生未读标记（杜绝 15 秒后绿点复燃），
       * 0ms 刷新左侧栏绿灯与工作区蓝灯，并异步向后端发送 confirmSession（使用解析后的最佳路由 ID）。
       */
      function confirmRemoteSessionOptimistically(deviceId, sessionId, { sendRpc = true, forceRpc = false, expectedEndSeq, doc = typeof document !== 'undefined' ? document : null } = {}) {
        const cleanDev = String(deviceId || '').trim();
        const cleanSid = String(sessionId || '').trim();
        if (!cleanSid) return false;
        const now = Date.now();
        let observed = null;
        const candidates = [
          ...store.serverWorkspaces.filter((ws) => !cleanDev || ws.deviceId === cleanDev),
          ...(store.controlledSnapshots.get(cleanDev)?.workspaces || []),
        ];
        for (const ws of candidates) {
          for (const s of Array.isArray(ws?.sessions) ? ws.sessions : []) {
            if (s.sessionId === cleanSid) observed = observed ? selectNewerSessionState(observed, s) : s;
          }
        }
        const observedMeta = readSessionStateMeta(observed);
        if (expectedEndSeq !== undefined && (!Number.isSafeInteger(expectedEndSeq) || expectedEndSeq < 0 || observedMeta?.endSeq !== expectedEndSeq)) return false;
        const observedActive = observed?.status === 'busy' || observed?.status === 'waiting';
        if (observedMeta) {
          store.confirmedSessionUntil.delete(cleanSid);
          if (!observedActive && observedMeta.endSeq >= 0) {
            store.confirmedEndSeqBySession.set(cleanSid, Math.max(store.confirmedEndSeqBySession.get(cleanSid) ?? -1, observedMeta.endSeq));
          }
        } else {
          store.confirmedSessionUntil.set(cleanSid, now + 15000);
        }
        store.activeInteractedSessions.add(cleanSid);
        if (!observedActive && typeof markControlledSessionConfirmed === 'function') {
          try { markControlledSessionConfirmed(cleanSid, undefined, observedMeta || undefined); } catch {}
        }
        // 同步通知受控 iframe 清理宿主原生 completionUnread，防止 15s 乐观期过后快照回传再次点亮绿点
        if (!observedActive && cleanDev && doc) {
          const targetRouteId = resolvePreferredRemoteApiTargetId(cleanDev) || cleanDev;
          const frame = findControlledFrameByDeviceId(cleanDev, doc)
            || (targetRouteId !== cleanDev ? findControlledFrameByDeviceId(targetRouteId, doc) : null);
          try {
            frame?.contentWindow?.postMessage({
              source: 'dsh-au',
              type: 'dsh-au:confirm-remote-session',
              deviceId: cleanDev,
              sessionId: cleanSid,
              ...observedMeta,
            }, '*');
          } catch {}
        }
        let mutated = false;
        const optimisticChanges = new Map();
        const rememberOriginal = (s) => {
          if (!optimisticChanges.has(s)) optimisticChanges.set(s, { status: s.status, completionUnread: s.completionUnread,
            stateSeq: s.stateSeq, endSeq: s.endSeq });
        };
        const revokeConfirmation = () => {
          if (!observedMeta || store.confirmedEndSeqBySession.get(cleanSid) === observedMeta.endSeq) {
            store.confirmedEndSeqBySession.delete(cleanSid);
            store.confirmedSessionUntil.delete(cleanSid);
            for (const [s, previous] of optimisticChanges) {
              if (s.status === 'idle' && s.stateSeq === previous.stateSeq && s.endSeq === previous.endSeq) {
                s.status = previous.status;
                s.completionUnread = previous.completionUnread;
              }
            }
            notifyStoreListeners();
          }
          if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
            window.dispatchEvent(new CustomEvent('dsh-au:refresh-state'));
          }
        };
        for (const ws of Array.isArray(store.serverWorkspaces) ? store.serverWorkspaces : []) {
          if (!ws || !Array.isArray(ws.sessions)) continue;
          let wsChanged = false;
          for (const s of ws.sessions) {
            if (s?.sessionId === cleanSid && isSessionStateConfirmed(s, now)) {
              rememberOriginal(s);
              if (s.completionUnread) { s.completionUnread = false; wsChanged = true; }
              if (s.status === 'done' || s.status === 'error') { s.status = 'idle'; wsChanged = true; }
            }
          }
          if (wsChanged) {
            ws.status = computeWorkspaceAggregateStatus(ws.sessions, 'idle');
            mutated = true;
          }
        }
        for (const [, snap] of store.controlledSnapshots.entries()) {
          if (!snap || !Array.isArray(snap.workspaces)) continue;
          for (const ws of snap.workspaces) {
            if (!ws || !Array.isArray(ws.sessions)) continue;
            let wsChanged = false;
            for (const s of ws.sessions) {
              if (s?.sessionId === cleanSid && isSessionStateConfirmed(s, now)) {
                rememberOriginal(s);
                if (s.completionUnread) { s.completionUnread = false; wsChanged = true; }
                if (s.status === 'done' || s.status === 'error') { s.status = 'idle'; wsChanged = true; }
              }
            }
            if (wsChanged) {
              ws.status = computeWorkspaceAggregateStatus(ws.sessions, 'idle');
              mutated = true;
            }
          }
        }
        notifyStoreListeners();
        if (sendRpc && !observedActive && cleanDev && typeof fetch === 'function' && (!observedMeta || observedMeta.endSeq >= 0)) {
          const targetDeviceId = resolvePreferredRemoteApiTargetId(cleanDev) || cleanDev;
          const rpcKey = `${targetDeviceId}:${cleanSid}${observedMeta ? `:${observedMeta.endSeq}` : ''}`;
          const lastRpcAt = lastRemoteConfirmRpcByKey.get(rpcKey) || 0;
          if (forceRpc || now - lastRpcAt >= 1200) {
            lastRemoteConfirmRpcByKey.set(rpcKey, now);
            fetch('/dsh-au-todo/api', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'confirmSession', deviceId: targetDeviceId, sessionId: cleanSid,
                ...(observedMeta ? { expectedEndSeq: observedMeta.endSeq } : {}),
              }),
            }).then(async (response) => {
              const result = await response?.json?.().catch?.(() => null);
              if (!result || result.ok === false || result.confirmed === false) {
                lastRemoteConfirmRpcByKey.delete(rpcKey);
                revokeConfirmation();
                return;
              }
              if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
                window.dispatchEvent(new CustomEvent('dsh-au:refresh-state'));
              }
            }).catch(() => {
              lastRemoteConfirmRpcByKey.delete(rpcKey);
              revokeConfirmation();
            });
          }
        }
        return mutated;
      }

      /**
       * 若用户当前正停留在远端设备的某个会话上（舞台可见、窗口拥有系统焦点且该会话处于选中/交互态），
       * 当该会话处于 busy/waiting 时自动标记为活跃交互会话；当其变为 done/error/completionUnread 时立即自动确认消除绿灯与蓝灯。
       * 若用户在双屏/分屏时切到其他软件（doc.hasFocus() === false），则暂不自动灭灯，等窗口重新聚焦后再确认。
       */
      function autoConfirmActiveRemoteSession(doc = typeof document !== 'undefined' ? document : null) {
        const activeDevId = store.activeDeviceId;
        if (!activeDevId || activeDevId === 'local') return;
        if (doc && doc.visibilityState === 'hidden') return;
        if (doc && typeof doc.hasFocus === 'function' && doc.hasFocus() === false) return;
        const activeRouteId = resolvePreferredRemoteApiTargetId(activeDevId) || activeDevId;
        const activeEl = doc?.activeElement;
        const isControlledIframeFocused = Boolean(
          activeEl
          && String(activeEl.tagName || '').toUpperCase() === 'IFRAME'
          && String(activeEl.getAttribute?.('name') || activeEl.name || '').startsWith('dsh-au-controlled:')
        );
        const allWorkspaces = [
          ...(Array.isArray(store.serverWorkspaces) ? store.serverWorkspaces : []),
          ...[...store.controlledSnapshots.entries()].flatMap(([devId, snap]) =>
            (Array.isArray(snap?.workspaces) ? snap.workspaces : []).map((ws) => ({ ...ws, deviceId: ws?.deviceId || devId }))
          ),
        ];
        for (const ws of allWorkspaces) {
          if (!ws?.deviceId || !Array.isArray(ws.sessions)) continue;
          const wsRouteId = resolvePreferredRemoteApiTargetId(ws.deviceId) || ws.deviceId;
          if (ws.deviceId !== activeDevId && wsRouteId !== activeRouteId) continue;
          const selectedSid = store.selectedSessionByDevice.get(ws.deviceId)
            || store.selectedSessionByDevice.get(activeDevId)
            || store.controlledSnapshots.get(ws.deviceId)?.currentSessionId
            || '';
          if (!selectedSid) continue;
          for (const s of ws.sessions) {
            if (!s || s.sessionId !== selectedSid) continue;
            if (s.status === 'busy' || s.status === 'waiting') {
              store.activeInteractedSessions.add(selectedSid);
            } else if (
              (s.status === 'done' || s.status === 'error' || s.completionUnread)
              && (store.activeInteractedSessions.has(selectedSid) || isControlledIframeFocused)
            ) {
              confirmRemoteSessionOptimistically(ws.deviceId, selectedSid, { sendRpc: true, doc });
            }
          }
        }
      }

      /**
       * 跨设备权威已读状态对账：
       * 1) 对远端会话：若服务端通道 A（`store.serverWorkspaces` 或 `window.__dshAuLastStateSnap.remotes`）
       *    已确认某条会话处于 `idle`（例如用户已在另一台电脑上点击确认过），且该会话并非 8 秒内刚在受控端结束运行，
       *    立即清除 `store.controlledSnapshots` 中残留的浏览器本地 `completionUnread` / `done` / `error`，
       *    并向受控 iframe 下发 `dsh-au:confirm-remote-session` 同步清理其原生 `uiSession.sessionStatus`；
       * 2) 对本机原生会话：若本机后端 `self.sessionStatesV2` 已将该会话标为 `idle`（例如从另一台电脑远程确认过），
       *    同步调用 `syncControlledSessionsWithBackendState` 清理本机浏览器的 `completionUnread` 绿点。
       */
      function reconcileConfirmedSessionsWithServer(doc = typeof document !== 'undefined' ? document : null) {
        const now = Date.now();
        const authoritativeSessionStates = new Map();
        for (const ws of store.serverWorkspaces) {
          for (const s of ws.sessions || []) {
            const previous = authoritativeSessionStates.get(s.sessionId);
            authoritativeSessionStates.set(s.sessionId, previous ? selectNewerSessionState(previous, s) : s);
          }
        }
        for (const remote of window.__dshAuLastStateSnap?.remotes || []) {
          if (remote.online === false) continue;
          for (const [sid, detail] of Object.entries(remote.sessionStateDetails || {})) {
            const previous = authoritativeSessionStates.get(sid);
            const incoming = { ...detail, sessionId: sid, fromServer: true };
            if (readSessionStateMeta(incoming)) authoritativeSessionStates.set(sid, previous ? selectNewerSessionState(previous, incoming) : incoming);
          }
        }
        const authoritativeIdleSessions = new Set();
        for (const ws of Array.isArray(store.serverWorkspaces) ? store.serverWorkspaces : []) {
          for (const s of Array.isArray(ws?.sessions) ? ws.sessions : []) {
            const sid = String(s?.sessionId || s?.id || '').trim();
            if (!sid) continue;
            const st = normalizeSessionStatus(s?.statusV2 || s?.status || 'idle');
            if (st === 'busy' || st === 'waiting') {
              store.recentBusyAtBySession.set(sid, now);
              authoritativeIdleSessions.delete(sid);
            } else if (st === 'idle' && !s?.completionUnread) {
              authoritativeIdleSessions.add(sid);
            } else {
              authoritativeIdleSessions.delete(sid);
            }
          }
        }
        const auSnap = typeof window !== 'undefined' ? window.__dshAuLastStateSnap : null;
        for (const remote of Array.isArray(auSnap?.remotes) ? auSnap.remotes : []) {
          if (!remote || remote.online === false || !remote.sessionStatesV2 || typeof remote.sessionStatesV2 !== 'object') continue;
          for (const [sid, rawSt] of Object.entries(remote.sessionStatesV2)) {
            if (typeof sid !== 'string' || !sid) continue;
            const st = normalizeSessionStatus(rawSt);
            if (st === 'busy' || st === 'waiting') {
              store.recentBusyAtBySession.set(sid, now);
              authoritativeIdleSessions.delete(sid);
            } else if (st === 'idle') {
              const serverHasNonIdle = (Array.isArray(store.serverWorkspaces) ? store.serverWorkspaces : []).some((w) =>
                (Array.isArray(w?.sessions) ? w.sessions : []).some((s) =>
                  (s?.sessionId || s?.id) === sid && (normalizeSessionStatus(s?.statusV2 || s?.status) !== 'idle' || s?.completionUnread)
                )
              );
              if (!serverHasNonIdle) {
                authoritativeIdleSessions.add(sid);
              }
            } else {
              authoritativeIdleSessions.delete(sid);
            }
          }
        }

        let mutated = false;
        for (const [devId, snap] of store.controlledSnapshots.entries()) {
          if (!snap || !Array.isArray(snap.workspaces)) continue;
          for (const ws of snap.workspaces) {
            if (!ws || !Array.isArray(ws.sessions)) continue;
            let wsChanged = false;
            for (const s of ws.sessions) {
              const sid = String(s?.sessionId || s?.id || '').trim();
              if (!sid) continue;
              const normSt = normalizeSessionStatus(s.statusV2 || s.status);
              if (normSt === 'busy' || normSt === 'waiting') {
                store.recentBusyAtBySession.set(sid, now);
                continue;
              }
              const meta = readSessionStateMeta(s);
              const authoritative = authoritativeSessionStates.get(sid);
              const authoritativeMeta = readSessionStateMeta(authoritative);
              const confirmedByVersion = meta && authoritativeMeta && authoritative.status === 'idle'
                && meta.endSeq >= 0 && authoritativeMeta.stateSeq >= meta.stateSeq && authoritativeMeta.ackedSeq >= meta.endSeq;
              if (
                (s.completionUnread || normSt === 'done' || normSt === 'error')
                && (confirmedByVersion || (!meta && authoritativeIdleSessions.has(sid) && !wasSessionRecentlyActive(sid, now)))
              ) {
                if (s.completionUnread) { s.completionUnread = false; wsChanged = true; }
                if (s.status === 'done' || s.status === 'error') { s.status = 'idle'; wsChanged = true; }
                if (confirmedByVersion) Object.assign(s, authoritativeMeta);
                if (doc) {
                  const targetRouteId = resolvePreferredRemoteApiTargetId(devId) || devId;
                  const frame = findControlledFrameByDeviceId(devId, doc)
                    || (targetRouteId !== devId ? findControlledFrameByDeviceId(targetRouteId, doc) : null);
                  try {
                    frame?.contentWindow?.postMessage({
                      source: 'dsh-au',
                      type: 'dsh-au:confirm-remote-session',
                      deviceId: devId,
                      sessionId: sid,
                      ...(confirmedByVersion ? authoritativeMeta : {}),
                    }, '*');
                  } catch {}
                }
              }
            }
            if (wsChanged) {
              ws.status = computeWorkspaceAggregateStatus(ws.sessions, 'idle');
              mutated = true;
            }
          }
        }

        const selfStates = auSnap?.self?.sessionStatesV2;
        if (selfStates && typeof selfStates === 'object' && typeof syncControlledSessionsWithBackendState === 'function') {
          if (syncControlledSessionsWithBackendState(selfStates, store.hostCtx, now, auSnap?.self?.sessionStateDetails)) {
            mutated = true;
          }
        }

        if (mutated) {
          notifyStoreListeners();
        }
        return mutated;
      }

      /** 激活远端工作区下的具体会话。 */
      function activateRemoteSession(ws, session) {
        if (!ws?.deviceId || !session?.sessionId) return;
        if (store.activeDeviceId && store.activeDeviceId !== ws.deviceId) cancelRemoteNavigation(store.activeDeviceId);
        store.createSessionSeq = (Number(store.createSessionSeq) || 0) + 1;
        const needsRpcConfirm = Boolean(
          session.completionUnread
          || session.status === 'done'
          || session.status === 'error'
        );
        clearOptimisticBlankSessions(ws.deviceId, session.sessionId);
        pruneActiveInteractedSessions(session.sessionId);
        store.selectedWorkspaceByDevice.set(ws.deviceId, ws.key);
        store.selectedSessionByDevice.set(ws.deviceId, session.sessionId);
        store.activeDeviceId = ws.deviceId;
         remoteSessionPreloadCoordinator?.notifyForeground(ws.deviceId, store.selectedSessionByDevice.get(ws.deviceId) || '');
        session.completionUnread = false;
        if (session.status === 'done' || session.status === 'error') {
          session.status = 'idle';
        }
        confirmRemoteSessionOptimistically(ws.deviceId, session.sessionId, {
          sendRpc: needsRpcConfirm,
          forceRpc: needsRpcConfirm,
        });
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
          window.dispatchEvent(new CustomEvent(DEVICE_SELECT_EVENT, { detail: { deviceId: ws.deviceId, skipInitialFocus: true } }));
        }
        const commandId = nextRemoteCommandId();
        const devLabel = ws.deviceName || ws.deviceId || '远程设备';
        dispatchStageTransition({
          active: true,
          deviceId: ws.deviceId,
          commandId,
          timeoutMs: 2200,
          label: `正在切换至 ${devLabel} · ${session.title || '远程对话'} ...`,
        });
        emitRemoteWorkspaceDiag('remote-session-open', ws.deviceId, {
          routeId: resolvePreferredRemoteApiTargetId(ws.deviceId),
          workspaceId: String(ws.workspaceId || '').replace(/[\\/]+/g, '.'),
          sessionId: session.sessionId,
          result: 'select-session',
        });
        sendOrQueueRemoteCommand(ws.deviceId, [
          {
            source: 'dsh-au',
            type: 'dsh-au:open-remote-session',
            commandId,
            deviceId: ws.deviceId,
            sessionId: session.sessionId,
          },
          {
            source: 'dsh-au-todo',
            type: 'dsh-au-todo:select-session',
            deviceId: ws.deviceId,
            sessionId: session.sessionId,
          },
        ]);
        // 自动展开左侧对应工作区并将该远端会话平滑滚动到可见区
        scrollSidebarToSession(session.sessionId);
      }

      /** 重建远端工作区与会话的原生映射表（不触发通知，供 getSnapshot 与控制器安全调用）。 */
      function rebuildNativeRemoteRegistry() {
        const merged = mergeRemoteWorkspaces(
          store.serverWorkspaces,
          store.controlledSnapshots,
          store.devices,
          store.hiddenKeys
        );
        const wsMap = new Map();
        const sessMap = new Map();
        for (const ws of merged.visible) {
          const nativeWsId = ws.nativeWorkspaceId || toNativeRemoteWorkspaceId(ws.deviceId, ws.workspaceId);
          wsMap.set(nativeWsId, ws);
          (ws.sessions || []).forEach((s, idx) => {
            if (s?.sessionId) {
              sessMap.set(s.sessionId, {
                ws,
                session: s,
                nativeWorkspaceId: nativeWsId,
                indexInWorkspace: idx,
              });
            }
          });
        }
        store.nativeWorkspaceById = wsMap;
        store.nativeSessionById = sessMap;
        return merged;
      }

      /**
       * 切换会话时自动展开左侧对应工作区文件夹并将该会话行平滑滚动到可见区。
       * 注意：严禁调用 setSessionListExpanded 或点击“展开其余 N 个会话”按钮；
       * 因为 DSH 原生 SessionTree 的 requiredWatermark(group.sessions, current, revealSessionId) 会自动将当前会话
       * (session.id === current) 算入可见水印范围并直接渲染进 DOM，无需手动展开其余会话（避免每次跳转导致 storedWatermarks +5 不断撑开其余隐藏会话）。
       */
      function scrollSidebarToSession(sessionId, options = {}, doc = typeof document !== 'undefined' ? document : null) {
        if (!sessionId) return;
        const ensureExpanded = () => {
          try {
            rebuildNativeRemoteRegistry();
            const remoteEntry = store.nativeSessionById?.get(sessionId);
            const uiWorkspace = store.hostCtx?.get?.('uiWorkspace') || store.hostCtx?.uiWorkspace;
            if (remoteEntry?.ws) {
              if (remoteEntry.ws.deviceId && expandDeviceGroup(`remote:${remoteEntry.ws.deviceId}`)) {
                decorateSidebarDeviceGroups(doc);
              }
              if (remoteEntry.ws.key) store.expandedKeys?.add?.(remoteEntry.ws.key);
              const targetWsId = remoteEntry.ws.nativeWorkspaceId || toNativeRemoteWorkspaceId(remoteEntry.ws.deviceId, remoteEntry.ws.workspaceId);
              uiWorkspace?.view?.setGroupExpanded?.(targetWsId, true);
            } else {
              if (expandDeviceGroup('local')) {
                decorateSidebarDeviceGroups(doc);
              }
              const workspacesSvc = store.hostCtx?.get?.('workspaces') || store.hostCtx?.workspaces || uiWorkspace?.workspaces;
              const wsItems = workspacesSvc?.list?.getSnapshot?.()?.items || [];
              const localWs = wsItems.find((w) => Array.isArray(w?.sessionIds) && w.sessionIds.includes(sessionId));
              if (localWs?.workspaceId) {
                uiWorkspace?.view?.setGroupExpanded?.(localWs.workspaceId, true);
              }
            }
          } catch {}
        };

        let scrolled = false;
        const scrollRow = () => {
          if (scrolled) return true;
          const effectiveDoc = doc || (typeof document !== 'undefined' ? document : null);
          ensureExpanded();
          if (!effectiveDoc?.querySelector) return false;
          const rowEl = effectiveDoc.querySelector(`[data-row-key="session:${sessionId}"]`) || effectiveDoc.querySelector(`[data-remote-session-id="${sessionId}"]`);
          if (rowEl && typeof rowEl.scrollIntoView === 'function') {
            try {
              rowEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            } catch {
              try { rowEl.scrollIntoView(); } catch {}
            }
            scrolled = true;
            return true;
          }
          return false;
        };

        scrollRow();
        if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
          for (const delay of [60, 180, 360, 650]) {
            window.setTimeout(scrollRow, delay);
          }
        }
      }

      /**
       * 从外部入口（如跨设备 Todo 面板点击或快捷键跳转）同步激活远端会话选中态：
       * 更新 store 选中映射、推进 latestNavigationByDevice 导航序号并下发 open-remote-session，
       * 同时不重复发送 HTTP confirmSession（由 Todo 自身负责），避免单测或实机产生双倍确认请求。
       */
      function syncExternalRemoteSelection(card, doc = typeof document !== 'undefined' ? document : null) {
        if (!card?.sessionId || !card?.deviceId) return;
        rebuildNativeRemoteRegistry();
        const entry = store.nativeSessionById?.get(card.sessionId);
        const devObj = (store.devices || []).find((d) =>
          d?.id === card.deviceId
          || d?.deviceId === card.deviceId
          || d?.selectedRoute?.id === card.deviceId
          || d?.routes?.some((r) => r?.id === card.deviceId)
        );
        const resolvedDevId = entry?.ws?.deviceId || devObj?.deviceId || devObj?.id || card.deviceId;
        if (store.activeDeviceId && store.activeDeviceId !== resolvedDevId) {
          cancelRemoteNavigation(store.activeDeviceId);
        }
        store.createSessionSeq = (Number(store.createSessionSeq) || 0) + 1;
        clearOptimisticBlankSessions(resolvedDevId, card.sessionId);
        pruneActiveInteractedSessions(card.sessionId);
        store.activeDeviceId = resolvedDevId;
        store.selectedSessionByDevice.set(resolvedDevId, card.sessionId);
        store.selectedSessionByDevice.set(card.deviceId, card.sessionId);
        if (entry?.ws?.key) {
          store.selectedWorkspaceByDevice.set(resolvedDevId, entry.ws.key);
          store.expandedKeys.add(entry.ws.key);
        }
        remoteSessionPreloadCoordinator?.notifyForeground(resolvedDevId, card.sessionId);
        confirmRemoteSessionOptimistically(resolvedDevId, card.sessionId, {
          sendRpc: false,
          forceRpc: false,
          doc,
        });
        const commandId = nextRemoteCommandId();
        sendOrQueueRemoteCommand(resolvedDevId, [
          {
            source: 'dsh-au',
            type: 'dsh-au:open-remote-session',
            commandId,
            deviceId: resolvedDevId,
            sessionId: card.sessionId,
          },
          {
            source: 'dsh-au-todo',
            type: 'dsh-au-todo:select-session',
            deviceId: resolvedDevId,
            sessionId: card.sessionId,
          },
        ], doc);
        notifyStoreListeners();
        scrollSidebarToSession(card.sessionId, { isLocal: false, deviceId: resolvedDevId }, doc);
      }

      /** 将远端会话/工作区操作（置顶、归档、重命名等）同步穿透到远端受控 iframe 与服务端 RPC。 */
      function executeRemoteEntityActionOnPeer(ws, { entityAction, sessionId = '', workspaceId = '', title = '' } = {}, doc = typeof document !== 'undefined' ? document : null) {
        if (!ws?.deviceId || !entityAction) return;
        const commandId = nextRemoteCommandId();
        sendOrQueueRemoteCommand(ws.deviceId, [{
          source: 'dsh-au',
          type: 'dsh-au:remote-entity-action',
          commandId,
          deviceId: ws.deviceId,
          entityAction,
          sessionId,
          workspaceId: workspaceId || ws.workspaceId || '',
          title,
        }], doc);
        if (typeof fetch === 'function') {
          fetch('/dsh-au-todo/api', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              action: 'remoteEntityAction',
              deviceId: resolvePreferredRemoteApiTargetId(ws.deviceId),
              entityAction,
              sessionId,
              workspaceId: workspaceId || resolveEffectiveRemoteWorkspaceId(ws) || '',
              title,
            }),
          }).catch(() => {});
        }
      }

      /**
       * 为 DSH 原生渲染出的远端工作区行与单列表会话行注入机器胶囊徽章 `[🖥 mac]` 及错误态红点。
       * 保持树视图内展开的子会话行清爽无冗余徽章，仅在工作区文件夹行与单列表（_flatList）会话行显示机器名。
       */
      function decorateNativeRemoteRows(doc = typeof document !== 'undefined' ? document : null) {
        if (!doc?.querySelectorAll) return;
        rebuildNativeRemoteRegistry();

        const monitorSvg = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"></rect><line x1="8" y1="20" x2="16" y2="20"></line><line x1="12" y1="16" x2="12" y2="20"></line></svg>';

        // 1. 装饰原生远端工作区行：[data-row-key^="workspace:dsh-au-remote-ws:"]
        const wsRows = doc.querySelectorAll(`[data-row-key^="workspace:${NATIVE_REMOTE_WS_PREFIX}"]`);
        for (const rowEl of wsRows) {
          const rowKey = rowEl?.getAttribute?.('data-row-key') || '';
          const nativeWsId = rowKey.startsWith('workspace:') ? rowKey.slice('workspace:'.length) : '';
          const ws = store.nativeWorkspaceById.get(nativeWsId);
          const parsed = ws || parseNativeRemoteWorkspaceId(nativeWsId);
          if (!parsed) continue;
          const deviceName = ws?.deviceName || parsed.deviceId || 'remote';
          const transportLabel = resolveDeviceConnectionTransport(parsed.deviceId);
          const aggStatus = ws ? computeWorkspaceAggregateStatus(ws.sessions, ws.status) : 'idle';
          rowEl.setAttribute?.('data-dsh-au-remote-device-id', parsed.deviceId);
          rowEl.setAttribute?.('data-dsh-au-remote-ws-id', parsed.workspaceId);

          const textContainer = rowEl.querySelector?.('[class*="_projectText"]')
            || rowEl.querySelector?.('[class*="_projectMainButton"]')
            || rowEl;
          if (!textContainer || typeof doc.createElement !== 'function') continue;
          let badge = rowEl.querySelector?.('.dsh-au-remote-ws-badge');
          if (!badge) {
            badge = doc.createElement('span');
            badge.className = 'dsh-au-remote-ws-badge';
          }
          if (badge.parentElement !== textContainer && typeof textContainer.appendChild === 'function') {
            const titleEl = textContainer.querySelector?.('[class*="_title"]');
            if (titleEl && titleEl.nextSibling && typeof textContainer.insertBefore === 'function') {
              textContainer.insertBefore(badge, titleEl.nextSibling);
            } else {
              textContainer.appendChild(badge);
            }
          }
          // 暂时隐藏自定义蓝灯：done 状态点不计入有效展示状态
          const effectiveAggStatus = aggStatus === 'done' ? 'idle' : aggStatus;
          const sig = `${deviceName}::${transportLabel}::${effectiveAggStatus}`;
          if (badge.getAttribute?.('data-badge-sig') !== sig) {
            badge.setAttribute?.('data-badge-sig', sig);
            const badgeTitle = transportLabel
              ? `远端设备：${deviceName}（连接方式：${transportLabel}）`
              : `远端设备：${deviceName}`;
            badge.setAttribute?.('title', badgeTitle);
            // SVG 是固定模板；设备名与通路标签来自配置/选路，只能作为文字插入，不能解析为 HTML。
            badge.innerHTML = monitorSvg;
            const nameEl = doc.createElement('span');
            nameEl.className = 'dsh-au-remote-ws-badge-name';
            nameEl.textContent = deviceName;
            badge.appendChild(nameEl);
            if (transportLabel) {
              const sepEl = doc.createElement('span');
              sepEl.className = 'dsh-au-remote-ws-badge-sep';
              sepEl.textContent = '·';
              badge.appendChild(sepEl);

              const transportEl = doc.createElement('span');
              transportEl.className = 'dsh-au-remote-ws-badge-transport';
              transportEl.textContent = transportLabel;
              badge.appendChild(transportEl);
            }
            if (effectiveAggStatus !== 'idle') {
              const dot = doc.createElement('span');
              dot.className = `dsh-au-remote-ws-badge-dot ${effectiveAggStatus}`;
              badge.appendChild(dot);
            }
          }
        }

        // 2. 装饰原生会话行：单列表模式（_flatList）注入紧凑机器徽章，错误状态会话将原生 StateDot 着色为红点
        const sessRows = doc.querySelectorAll('[data-row-key^="session:"]');
        for (const rowEl of sessRows) {
          const rowKey = rowEl?.getAttribute?.('data-row-key') || '';
          const sid = rowKey.startsWith('session:') ? rowKey.slice('session:'.length) : '';
          const entry = sid ? store.nativeSessionById.get(sid) : null;
          if (!entry) {
            const staleBadge = rowEl.querySelector?.('.dsh-au-remote-flat-badge');
            staleBadge?.remove?.();
            continue;
          }
          rowEl.setAttribute?.('data-dsh-au-remote-session', '1');
          rowEl.setAttribute?.('data-dsh-au-remote-device-id', entry.ws.deviceId);

          const dotEl = rowEl.querySelector?.('[class*="_stateDot"]');
          if (dotEl?.classList) {
            if (entry.session.status === 'error') {
              dotEl.classList.add('dsh-au-state-dot-error');
            } else {
              dotEl.classList.remove('dsh-au-state-dot-error');
            }
          }

          const inFlatList = Boolean(rowEl.closest?.('[class*="_flatList"]'));
          const existingFlatBadge = rowEl.querySelector?.('.dsh-au-remote-flat-badge');
          if (!inFlatList) {
            existingFlatBadge?.remove?.();
            continue;
          }
          const openBtn = rowEl.querySelector?.('[class*="_sessionOpen"]') || rowEl;
          if (!openBtn || typeof doc.createElement !== 'function') continue;
          let flatBadge = existingFlatBadge;
          if (!flatBadge) {
            flatBadge = doc.createElement('span');
            flatBadge.className = 'dsh-au-remote-ws-badge dsh-au-remote-flat-badge';
            const trailingEl = openBtn.querySelector?.('[class*="_time"]')
              || openBtn.querySelector?.('[class*="_trailingMeta"]')
              || openBtn.querySelector?.('[class*="_rowActions"]');
            if (trailingEl && typeof openBtn.insertBefore === 'function') {
              openBtn.insertBefore(flatBadge, trailingEl);
            } else if (typeof openBtn.appendChild === 'function') {
              openBtn.appendChild(flatBadge);
            }
          }
          const devName = entry.ws.deviceName || entry.ws.deviceId || 'remote';
          const transportLabel = resolveDeviceConnectionTransport(entry.ws.deviceId);
          const sig = `${devName}::${transportLabel}`;
          if (flatBadge.getAttribute?.('data-badge-sig') !== sig) {
            flatBadge.setAttribute?.('data-badge-sig', sig);
            flatBadge.setAttribute?.('title', transportLabel ? `远端设备：${devName}（连接方式：${transportLabel}）` : `远端设备：${devName}`);
            flatBadge.textContent = '';
            const nameEl = doc.createElement('span');
            nameEl.className = 'dsh-au-remote-ws-badge-name';
            nameEl.textContent = devName;
            flatBadge.appendChild(nameEl);
          }
        }

        // 3. 装饰弹出式工作区选择菜单（如添加新对话、Hero 区工作区切换下拉菜单）
        decorateWorkspacePickerMenu(doc);

        // 4. 在原生工作区树中按设备（本机 / 各远端电脑）渲染二级分组标题并缩进子工作区
        decorateSidebarDeviceGroups(doc);
      }

      /**
       * 在左侧栏原生工作区树（div[role="tree"]._list）中增加一层设备分组（本机 / mac / ...）：
       * - 仅当存在远端工作区时启用，纯本机时不额外占用行高；
       * - 通过 CSS order 排列分组标题与原生 _groupSection，不移动 React 管理的节点；
       * - 严禁给分组标题设置 data-row-key，避免干扰宿主 AnimatedRows 动画计算。
       */
      function decorateSidebarDeviceGroups(doc = typeof document !== 'undefined' ? document : null) {
        const treeContainer = findNativeWorkspaceTreeContainer(doc);
        if (!treeContainer || typeof treeContainer.querySelectorAll !== 'function') return;

        const clearDeviceGroups = () => {
          treeContainer.classList?.remove?.('dsh-au-ws-grouped-tree');
          const oldHeaders = Array.from(treeContainer.querySelectorAll(':scope > [data-dsh-au-device-group-header="1"]') || []);
          for (const hEl of oldHeaders) hEl.remove?.();
          const oldSections = Array.from(treeContainer.querySelectorAll(':scope > [class*="_groupSection"]') || []);
          for (const sec of oldSections) {
            sec.classList?.remove?.('dsh-au-ws-grouped-item', 'dsh-au-ws-group-hidden');
            if (sec.style) sec.style.order = '';
          }
        };

        const sections = Array.from(treeContainer.querySelectorAll(':scope > [class*="_groupSection"]') || []);
        if (sections.length === 0) {
          clearDeviceGroups();
          return;
        }

        const groupsById = new Map();
        let hasRemote = false;
        for (const sec of sections) {
          const rowEl = sec.querySelector?.('[data-row-key^="workspace:"]');
          const rowKey = rowEl?.getAttribute?.('data-row-key') || '';
          const nativeWsId = rowKey.startsWith('workspace:') ? rowKey.slice('workspace:'.length) : '';
          const parsed = parseNativeRemoteWorkspaceId(nativeWsId);
          if (parsed) {
            hasRemote = true;
            const ws = store.nativeWorkspaceById.get(nativeWsId);
            const deviceName = ws?.deviceName || parsed.deviceId || 'remote';
            const transportLabel = resolveDeviceConnectionTransport(parsed.deviceId);
            const groupKey = `remote:${parsed.deviceId}`;
            if (!groupsById.has(groupKey)) {
              groupsById.set(groupKey, {
                key: groupKey,
                isLocal: false,
                deviceId: parsed.deviceId,
                name: deviceName,
                transport: transportLabel,
                sections: [],
              });
            }
            groupsById.get(groupKey).sections.push(sec);
          } else {
            if (!groupsById.has('local')) {
              groupsById.set('local', {
                key: 'local',
                isLocal: true,
                deviceId: '',
                name: '本机',
                transport: '',
                sections: [],
              });
            }
            groupsById.get('local').sections.push(sec);
          }
        }

        const extMountNode = treeContainer.querySelector?.(':scope > [data-dsh-au-ext-sidebar="1"]');
        if (extMountNode?.style) extMountNode.style.order = '99998';

        if (!hasRemote && !extMountNode) {
          clearDeviceGroups();
          return;
        }

        const groups = [...groupsById.values()];

        treeContainer.classList?.add?.('dsh-au-ws-grouped-tree');
        const mountNode = treeContainer.querySelector?.(`:scope > div.${MOUNT_CLASS}[${MOUNT_ATTR}="1"]`);
        if (mountNode?.style) mountNode.style.order = '99999';

        const existingHeaders = new Map();
        for (const el of Array.from(treeContainer.querySelectorAll(':scope > [data-dsh-au-device-group-header="1"]') || [])) {
          const k = el.getAttribute?.('data-dsh-au-group-key');
          if (k && !existingHeaders.has(k)) existingHeaders.set(k, el);
          else el.remove?.();
        }

        const chevronSvg = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>';
        const localSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"></rect><line x1="2" y1="20" x2="22" y2="20"></line></svg>';
        const remoteSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"></rect><line x1="8" y1="20" x2="16" y2="20"></line><line x1="12" y1="16" x2="12" y2="20"></line></svg>';

        const activeKeys = new Set();
        groups.forEach((group, groupIdx) => {
          activeKeys.add(group.key);
          const collapsed = isDeviceGroupCollapsed(group.key);
          let header = existingHeaders.get(group.key);
          if (!header && typeof doc.createElement === 'function') {
            header = doc.createElement('button');
            header.type = 'button';
            header.className = 'dsh-au-ws-device-group';
            header.setAttribute('data-dsh-au-device-group-header', '1');
            header.setAttribute('data-dsh-au-group-key', group.key);
            header.addEventListener?.('click', (event) => {
              event?.stopPropagation?.();
              toggleDeviceGroupCollapsed(group.key);
              decorateSidebarDeviceGroups(doc);
            });
            treeContainer.appendChild?.(header);
          }
          if (header) {
            if (header.style) header.style.order = String(groupIdx * 1000);
            header.setAttribute?.('aria-expanded', collapsed ? 'false' : 'true');
            header.setAttribute?.('data-first-group', groupIdx === 0 ? '1' : '0');
            const titleText = group.transport ? `${group.name} · ${group.transport}` : group.name;
            header.setAttribute?.('title', titleText);
            const sig = `${group.isLocal ? 'local' : 'remote'}::${group.name}::${group.transport}::${group.sections.length}`;
            if (header.getAttribute?.('data-group-sig') !== sig) {
              header.setAttribute?.('data-group-sig', sig);
              header.textContent = '';

              const chevronSpan = doc.createElement('span');
              chevronSpan.className = 'dsh-au-ws-device-group-chevron';
              chevronSpan.innerHTML = chevronSvg;
              header.appendChild(chevronSpan);

              const iconSpan = doc.createElement('span');
              iconSpan.className = 'dsh-au-ws-device-group-icon';
              iconSpan.innerHTML = group.isLocal ? localSvg : remoteSvg;
              header.appendChild(iconSpan);

              const labelSpan = doc.createElement('span');
              labelSpan.className = 'dsh-au-ws-device-group-label';
              labelSpan.textContent = group.name;
              header.appendChild(labelSpan);

              if (group.transport) {
                const transportSpan = doc.createElement('span');
                transportSpan.className = 'dsh-au-ws-device-group-transport';
                transportSpan.textContent = group.transport;
                header.appendChild(transportSpan);
              }

              const countSpan = doc.createElement('span');
              countSpan.className = 'dsh-au-ws-device-group-count';
              countSpan.textContent = String(group.sections.length);
              header.appendChild(countSpan);
            }
          }

          group.sections.forEach((sec, itemIdx) => {
            if (sec.style) sec.style.order = String(groupIdx * 1000 + itemIdx + 1);
            sec.classList?.add?.('dsh-au-ws-grouped-item');
            if (collapsed) sec.classList?.add?.('dsh-au-ws-group-hidden');
            else sec.classList?.remove?.('dsh-au-ws-group-hidden');
          });
        });

        for (const [key, header] of existingHeaders.entries()) {
          if (!activeKeys.has(key)) header.remove?.();
        }
      }

      let workspacePickerGroupSeq = 0;

      /** 原生菜单按 DOM 顺序走键盘：在原父节点内重排整行，保留 React 的行身份、点击回调与选中勾。 */
      function groupWorkspacePickerRows(entries, doc) {
        const rows = entries.map(({ btn, ws }) => ({ btn, ws, row: btn.closest?.('[class*="_itemWrap"], [class*="itemWrap"]') || btn }));
        const container = rows[0]?.row?.parentElement;
        if (!container?.insertBefore || rows.some(({ row }) => row.parentElement !== container)) return;
        const groupsById = new Map();
        for (const entry of rows) {
          const deviceId = entry.ws.remoteDeviceId || entry.ws.deviceId || '';
          const key = deviceId ? `remote:${deviceId}` : 'local';
          if (!groupsById.has(key)) {
            const name = deviceId ? (entry.ws.remoteDeviceName || entry.ws.deviceName || deviceId) : '本机';
            const transport = deviceId ? resolveDeviceConnectionTransport(deviceId) : '';
            groupsById.set(key, { key, name, label: transport ? `${name} · ${transport}` : name, entries: [] });
          }
          groupsById.get(key).entries.push(entry);
        }
        // 本机固定在前；设备排序稳定，每台电脑内部保持原来的最近/手动顺序。
        const groups = [...groupsById.values()].sort((a, b) =>
          Number(b.key === 'local') - Number(a.key === 'local') || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
        const desiredRows = groups.flatMap((group) => group.entries.map(({ row }) => row));
        const desiredSet = new Set(desiredRows);
        const currentRows = Array.from(container.children || []).filter((node) => desiredSet.has(node));
        const signature = JSON.stringify(groups.map((group) => [group.key, group.label, group.entries.map(({ ws }) => ws.workspaceId)]));
        const oldHeadings = Array.from(container.querySelectorAll?.(':scope > .dsh-au-menu-ws-group-heading') || []);
        if (container.getAttribute?.('data-dsh-au-picker-groups') === signature
          && oldHeadings.length === groups.length && currentRows.every((row, index) => row === desiredRows[index])) return;
        for (const heading of oldHeadings) heading.remove?.();
        const firstRow = currentRows[0];
        if (!firstRow) return;
        // 先插入稳定锚点；所有行始终留在原 viewport 内，避免破坏原生 Portal 的卸载。
        const anchor = doc.createElement('span');
        container.insertBefore(anchor, firstRow);
        for (const group of groups) {
          const heading = doc.createElement('div');
          heading.className = 'dsh-au-menu-ws-group-heading';
          const headingId = `dsh-au-picker-group-${++workspacePickerGroupSeq}`;
          heading.setAttribute('id', headingId);
          heading.setAttribute('role', 'presentation');
          heading.setAttribute('data-dsh-au-group-device', group.key);
          if (group === groups[0]) {
            heading.setAttribute('data-dsh-au-group-first', 'true');
          }
          heading.textContent = group.label;
          heading.setAttribute('title', group.label);
          container.insertBefore(heading, anchor);
          for (const { btn, row } of group.entries) {
            const previousId = btn.getAttribute?.('data-dsh-au-group-heading');
            const descriptions = String(btn.getAttribute?.('aria-describedby') || '').split(/\s+/).filter((id) => id && id !== previousId);
            btn.setAttribute?.('aria-describedby', [...descriptions, headingId].join(' '));
            btn.setAttribute?.('data-dsh-au-group-heading', headingId);
            container.insertBefore(row, anchor);
          }
        }
        anchor.remove?.();
        container.setAttribute?.('data-dsh-au-picker-groups', signature);
      }

      /**
       * 装饰新建对话/切换项目时弹出的工作区选择菜单（WorkspacePickFlow Menu）：
       * 为远端工作区选项注入与侧边栏完全一致的机器与通信通路胶囊徽章 [🖥 win · Lan]。
       */
      function decorateWorkspacePickerMenu(doc = typeof document !== 'undefined' ? document : null) {
        if (!doc?.querySelectorAll) return;
        const combined = Array.isArray(store.combinedWorkspaces) && store.combinedWorkspaces.length > 0
          ? store.combinedWorkspaces
          : Array.from(store.nativeWorkspaceById.values());
        if (combined.length === 0) return;

        // 查找所有 Menu 菜单容器（通常由 Portal 挂载在 body 上或在 dialog 中）
        const menus = doc.querySelectorAll('[role="menu"]');
        for (const menu of menus) {
          const allButtons = Array.from(menu.querySelectorAll('button[role="menuitem"]'));
          if (allButtons.length === 0) continue;

          // 排除非工作区菜单（如工作区底部的“添加工作区”项）
          const workspaceButtons = allButtons.filter((btn) => {
            const text = btn.textContent || '';
            const isAdd = text.includes('添加工作区') || text.includes('Add workspace');
            return !isAdd;
          });
          if (workspaceButtons.length === 0) continue;

          // 首次按完整列表核对；分组后按保存的工作区 ID 匹配，不能再靠下标或同名标题认电脑。
          if (workspaceButtons.length !== combined.length) continue;
          const workspaceById = new Map(combined.map((ws) => [String(ws.workspaceId), ws]));
          const savedIds = new Set(workspaceButtons.map((btn) => btn.getAttribute?.('data-dsh-au-picker-workspace-id')).filter(Boolean));
          const matchesWorkspace = (btn, ws) => {
            if (!btn || !ws) return false;
            const disambiguatedEl = btn.querySelector?.('[class*="disambiguated"], [class*="Disambiguated"]');
            const titleEl = btn.querySelector?.('[class*="title"], [class*="Title"]');
            const suffixEl = btn.querySelector?.('[class*="pathSuffix"], [class*="PathSuffix"]');
            const labelEl = btn.querySelector?.('[class*="itemLabel"]');

            let label = '';
            if (titleEl) {
              label = titleEl.textContent?.trim() || '';
            } else if (labelEl) {
              label = labelEl.textContent?.trim() || '';
            } else {
              label = btn.textContent?.trim() || '';
            }

            const suffix = suffixEl?.textContent?.trim() || '';
            if (suffix && label.endsWith(suffix)) {
              label = label.slice(0, -suffix.length).trim();
            }

            const title = String(ws?.title || '').trim();
            const isDefaultA = !label || label === 'default-workspace' || label === 'default' || label === '默认工作区' || label === 'Default workspace';
            const isDefaultB = !title || title === 'default-workspace' || title === 'default' || title === '默认工作区' || title === 'Default workspace';

            const titleMatched = Boolean(title && ((isDefaultA && isDefaultB) || label === title));
            if (!titleMatched) return false;

            // 若按钮带有 disambiguated 路径信息，结合完整路径精确区分同名工作区
            const fullPath = disambiguatedEl?.getAttribute?.('title')?.trim() || '';
            if (fullPath) {
              const p1 = normalizeWorkspacePathKey(fullPath);
              const p2 = normalizeWorkspacePathKey(ws.path || ws.rawPath || '');
              if (p1 && p2 && p1 !== p2) return false;
            }

            return true;
          };

          const entries = workspaceButtons.map((btn, index) => {
            const savedId = btn.getAttribute?.('data-dsh-au-picker-workspace-id');
            let ws = savedId ? workspaceById.get(savedId) : combined[index];
            if (!savedId && savedIds.size > 0) {
              // React 增量插入的新行不在原列表下标位置；只从尚未绑定的工作区中认唯一标题。
              const candidates = combined.filter((item) => !savedIds.has(String(item.workspaceId)) && matchesWorkspace(btn, item));
              ws = candidates.length === 1 ? candidates[0] : null;
            }
            return matchesWorkspace(btn, ws) ? { btn, ws } : null;
          });
          if (entries.some((entry) => !entry) || new Set(entries.map(({ ws }) => ws.workspaceId)).size !== combined.length) continue;
          for (const { btn, ws } of entries) btn.setAttribute?.('data-dsh-au-picker-workspace-id', ws.workspaceId);

          const monitorSvg = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"></rect><line x1="8" y1="20" x2="16" y2="20"></line><line x1="12" y1="16" x2="12" y2="20"></line></svg>';

          entries.forEach(({ btn, ws }) => {

            // 本地工作区不注入远端胶囊
            const isRemote = Boolean(ws.__dshAuRemote || ws.deviceId || ws.remoteDeviceId);
            if (!isRemote) {
              const stale = btn.querySelector?.('.dsh-au-menu-ws-badge');
              stale?.remove?.();
              return;
            }

            const deviceId = ws.remoteDeviceId || ws.deviceId || '';
            const deviceName = ws.remoteDeviceName || ws.deviceName || deviceId || 'remote';
            const transportLabel = resolveDeviceConnectionTransport(deviceId);
            const sig = `${deviceName}::${transportLabel}`;

            let badge = btn.querySelector?.('.dsh-au-menu-ws-badge');
            if (!badge) {
              badge = doc.createElement('span');
              badge.className = 'dsh-au-remote-ws-badge dsh-au-menu-ws-badge';
              const checkIcon = btn.querySelector?.('[class*="_check"], [class*="check"]');
              if (checkIcon && checkIcon.parentElement === btn && typeof btn.insertBefore === 'function') {
                btn.insertBefore(badge, checkIcon);
              } else if (typeof btn.appendChild === 'function') {
                btn.appendChild(badge);
              }
            }

            if (badge.getAttribute?.('data-badge-sig') !== sig) {
              badge.setAttribute?.('data-badge-sig', sig);
              badge.setAttribute?.('title', transportLabel ? `远端设备：${deviceName}（连接方式：${transportLabel}）` : `远端设备：${deviceName}`);
              badge.innerHTML = monitorSvg;
              const nameEl = doc.createElement('span');
              nameEl.className = 'dsh-au-remote-ws-badge-name';
              nameEl.textContent = deviceName;
              badge.appendChild(nameEl);
              if (transportLabel) {
                const sepEl = doc.createElement('span');
                sepEl.className = 'dsh-au-remote-ws-badge-sep';
                sepEl.textContent = '·';
                badge.appendChild(sepEl);

                const transportEl = doc.createElement('span');
                transportEl.className = 'dsh-au-remote-ws-badge-transport';
                transportEl.textContent = transportLabel;
                badge.appendChild(transportEl);
              }
            }
          });
          groupWorkspacePickerRows(entries, doc);
        }
      }

      /**
       * 将本地工作区与远端工作区按「本机 / 各远端设备」分组排列：
       * - recent 模式下：按各设备组内最新活跃工作区时间降序排列（哪台电脑刚更新对话，该电脑分组与工作区一起置顶）；
       * - manual 模式下：本机固定在最前，远端设备按名称排序，组内保持原顺序。
       */
      function groupCombinedWorkspacesByDevice(localItems, remoteItems, { localUpdatedById = new Map(), orderBy = 'recent' } = {}) {
        const safeLocal = Array.isArray(localItems) ? localItems : [];
        const safeRemote = Array.isArray(remoteItems) ? remoteItems : [];
        const sortLocal = (items) => {
          if (orderBy === 'manual') return [...items];
          return items
            .map((item, idx) => ({ item, updatedAt: localUpdatedById.get(String(item.workspaceId)) ?? 0, idx }))
            .sort((a, b) => (b.updatedAt - a.updatedAt) || (a.idx - b.idx))
            .map((entry) => entry.item);
        };
        if (safeRemote.length === 0) return sortLocal(safeLocal);

        const remoteGroupsById = new Map();
        for (const item of safeRemote) {
          const deviceId = String(item?.remoteDeviceId || item?.deviceId || '').trim();
          if (!deviceId) continue;
          const deviceName = String(item?.remoteDeviceName || item?.deviceName || deviceId);
          if (!remoteGroupsById.has(deviceId)) {
            remoteGroupsById.set(deviceId, { deviceId, deviceName, items: [] });
          }
          remoteGroupsById.get(deviceId).items.push(item);
        }
        const sortRemote = (items) => {
          if (orderBy === 'manual') return [...items];
          return items
            .map((item, idx) => ({ item, updatedAt: Number(item?.sortUpdatedAt ?? item?.updatedAt ?? 0), idx }))
            .sort((a, b) => (b.updatedAt - a.updatedAt) || (a.idx - b.idx))
            .map((entry) => entry.item);
        };

        if (orderBy === 'manual') {
          const sortedRemoteGroups = [...remoteGroupsById.values()].sort((a, b) => (
            a.deviceName.localeCompare(b.deviceName) || a.deviceId.localeCompare(b.deviceId)
          ));
          return [
            ...sortLocal(safeLocal),
            ...sortedRemoteGroups.flatMap((group) => sortRemote(group.items)),
          ];
        }

        const sortedLocal = sortLocal(safeLocal);
        const localMaxTs = sortedLocal.reduce((max, item) => Math.max(max, localUpdatedById.get(String(item.workspaceId)) ?? 0), 0);
        const allGroups = [];
        if (sortedLocal.length > 0) {
          allGroups.push({ key: 'local', isLocal: true, name: '本机', updatedAt: localMaxTs, items: sortedLocal });
        }
        for (const group of remoteGroupsById.values()) {
          const items = sortRemote(group.items);
          const maxTs = items.reduce((max, item) => Math.max(max, Number(item?.sortUpdatedAt ?? item?.updatedAt ?? 0)), 0);
          allGroups.push({
            key: `remote:${group.deviceId}`,
            isLocal: false,
            name: group.deviceName,
            updatedAt: maxTs,
            items,
          });
        }
        allGroups.sort((a, b) => (
          (b.updatedAt - a.updatedAt)
          || (Number(b.isLocal) - Number(a.isLocal))
          || a.name.localeCompare(b.name)
          || a.key.localeCompare(b.key)
        ));
        return allGroups.flatMap((group) => group.items);
      }

      /**
       * 将远端工作区与会话无缝注入本机 DSH 原生数据流（workspaces.list / sessions.list / uiSession.sessionStatus），
       * 并拦截 uiWorkspace / workspaces / sessions / remoteAccess 上的动作穿透到远端设备。
       */
      function installNativeWorkspaceBridge(ctx) {
        const uiWorkspace = ctx?.get?.('uiWorkspace') || ctx?.uiWorkspace;
        const workspacesSvc = ctx?.get?.('workspaces') || ctx?.workspaces || uiWorkspace?.workspaces;
        const sessionsSvc = ctx?.get?.('sessions') || ctx?.sessions || uiWorkspace?.sessions;
        const uiSessionSvc = ctx?.get?.('uiSession') || ctx?.uiSession;
        const remoteAccessSvc = ctx?.get?.('remoteAccess') || ctx?.remoteAccess;

        const wsList = workspacesSvc?.list || (typeof uiWorkspace?.workspaces?.getSnapshot === 'function' ? uiWorkspace.workspaces : null);
        const sessList = sessionsSvc?.list || (typeof uiWorkspace?.sessions?.getSnapshot === 'function' ? uiWorkspace.sessions : null);
        const statusStore = uiSessionSvc?.sessionStatus || null;

        if (!wsList || typeof wsList.getSnapshot !== 'function' || !sessList || typeof sessList.getSnapshot !== 'function') {
          store.nativeBridgeInstalled = false;
          return () => {};
        }

        if (wsList.__dshAuNativeBridgeDisposer) {
          return wsList.__dshAuNativeBridgeDisposer;
        }

        const viewStore = uiWorkspace?.view;

        // DSH 原生 WorkspaceBrowser (createWorkspaceViewStore, 持久化于 localStorage 的 "dsh.workspace.view.v5")：
        // 若用户曾无意微拖动会话行，会触发 DSH 将 orderBy 永久置为 "manual" 并冻结 sessionOrderByAccount，
        // 进而使用 reconcileManualOrder 忽略更新时间与 ws.sessionIds 顺序，导致刚活跃的会话排在旧会话下方。
        // 此处在 bridge 初始化时检测并重置为 "updated" 排序模式，清空 manual 排序冻结表。
        try {
          if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
            const rawView = localStorage.getItem('dsh.workspace.view.v5');
            if (rawView) {
              const parsedView = JSON.parse(rawView);
              if (parsedView && typeof parsedView === 'object') {
                let mutatedView = false;
                if (parsedView.orderBy === 'manual') {
                  parsedView.orderBy = 'updated';
                  parsedView.sessionOrderByAccount = {};
                  mutatedView = true;
                }
                if (parsedView.state && typeof parsedView.state === 'object' && parsedView.state.orderBy === 'manual') {
                  parsedView.state.orderBy = 'updated';
                  parsedView.state.sessionOrderByAccount = {};
                  mutatedView = true;
                }
                if (mutatedView && typeof localStorage.setItem === 'function') {
                  localStorage.setItem('dsh.workspace.view.v5', JSON.stringify(parsedView));
                }
              }
            }
          }
        } catch {}

        // 注意：真实宿主中 uiWorkspace.view 即 viewInstance.actions（无 getSnapshot 方法），
        // 且宿主 setOrderBy 内部自带 if (mode === d.orderBy) return 幂等保护，因此必须直接调用 setOrderBy('updated', {}) 才能清空内存中的 manual 排序锁！
        if (typeof viewStore?.setOrderBy === 'function') {
          try { viewStore.setOrderBy('updated', {}); } catch {}
        }

        const origGetViewSnapshot = typeof viewStore?.getSnapshot === 'function' ? viewStore.getSnapshot.bind(viewStore) : null;
        if (viewStore && origGetViewSnapshot) {
          viewStore.getSnapshot = () => {
            const snap = origGetViewSnapshot();
            if (snap?.orderBy === 'manual') {
              return { ...snap, orderBy: 'updated', sessionOrderByAccount: {} };
            }
            return snap;
          };
        }

        const origGetWsSnapshot = wsList.getSnapshot.bind(wsList);
        const origSubWs = typeof wsList.subscribe === 'function' ? wsList.subscribe.bind(wsList) : null;
        const origGetSessSnapshot = sessList.getSnapshot.bind(sessList);
        const origSubSess = typeof sessList.subscribe === 'function' ? sessList.subscribe.bind(sessList) : null;
        const origGetStatusSnapshot = typeof statusStore?.getSnapshot === 'function' ? statusStore.getSnapshot.bind(statusStore) : null;
        const origSubStatus = typeof statusStore?.subscribe === 'function' ? statusStore.subscribe.bind(statusStore) : null;

        const wsExtraListeners = new Set();
        const sessExtraListeners = new Set();
        const statusExtraListeners = new Set();

        let cachedWsKey = null;
        let cachedWsSnap = null;
        wsList.getSnapshot = () => {
          const rawWs = origGetWsSnapshot() || { phase: 'ready', items: [], archivedSessionIds: [], pinnedSessionIds: [] };
          const rawSess = origGetSessSnapshot() || { byId: {} };
          const orderBy = uiWorkspace?.orderBy || rawWs.orderBy || 'recent';
          const cacheKey = `${store.revision}::${orderBy}`;
          if (cachedWsSnap && cachedWsKey === cacheKey && cachedWsSnap.__rawWs === rawWs && cachedWsSnap.__rawSess === rawSess) {
            return cachedWsSnap.value;
          }

          const { visible } = rebuildNativeRemoteRegistry();
          const rawSessionsById = (rawSess?.byId && typeof rawSess.byId === 'object') ? rawSess.byId : {};
          const localPinnedSet = new Set(Array.isArray(rawWs.pinnedSessionIds) ? rawWs.pinnedSessionIds : []);

          // 计算本地会话用于排序的最佳时间戳：闲置历史会话被点击打开时，DSH 底层写入 session/end-seed 会将 s.updatedAt 刷成当前时间；
          // 因此仅在会话正在运行时才 Math.max 取 updatedAt，闲置会话优先采纳真实的提问时间戳（lastPromptAt），防止打开旧会话后时间被刷成「刚刚」。
          const getLocalSessionSortTs = (sid) => {
            const s = rawSessionsById[sid];
            if (!s) return 0;
            const promptTs = Number(s?.projections?.values?.sessionListMetadata?.lastPromptAt) || Number(s.lastPromptAt) || 0;
            const rawUpd = Number(typeof s.updatedAt === 'string' ? Date.parse(s.updatedAt) : s.updatedAt) || 0;
            const rawCreated = Number(typeof s.createdAt === 'string' ? Date.parse(s.createdAt) : s.createdAt) || 0;
            return s.running === true
              ? Math.max(promptTs, rawUpd, rawCreated)
              : (promptTs || rawUpd || rawCreated);
          };

          const rawLocalItems = Array.isArray(rawWs.items)
            ? rawWs.items.filter((item) => !isNativeRemoteWorkspaceId(item?.workspaceId))
            : [];
          // 本地工作区会话排序：原始 workspace.json 中按创建顺序存储 sessionIds，
          // 这里按「置顶优先 -> 最新活跃时间倒序」重新排序，确保刚活跃的旧会话排在顶部
          const localItems = rawLocalItems.map((ws) => {
            if (!Array.isArray(ws?.sessionIds)) return ws;
            const filteredIds = ws.sessionIds.filter((sid) => !/^0000e870-/i.test(String(sid || '')));
            if (filteredIds.length <= 1) {
              return filteredIds.length === ws.sessionIds.length ? ws : { ...ws, sessionIds: filteredIds };
            }
            return {
              ...ws,
              sessionIds: [...filteredIds].sort((a, b) => (
                Number(localPinnedSet.has(b)) - Number(localPinnedSet.has(a))
                || getLocalSessionSortTs(b) - getLocalSessionSortTs(a)
              )),
            };
          });

          const localUpdatedById = new Map();
          for (const ws of localItems) {
            if (!ws?.workspaceId) continue;
            let maxTs = Number(typeof ws.createdAt === 'string' ? Date.parse(ws.createdAt) : ws.createdAt) || 0;
            for (const sid of Array.isArray(ws.sessionIds) ? ws.sessionIds : []) {
              const sTs = getLocalSessionSortTs(sid);
              if (sTs > maxTs) maxTs = sTs;
            }
            localUpdatedById.set(String(ws.workspaceId), maxTs);
          }

          const remotePinnedIds = [];
          const remoteItems = visible.map((ws) => {
            const nativeWsId = ws.nativeWorkspaceId || toNativeRemoteWorkspaceId(ws.deviceId, ws.workspaceId);
            const sessionIds = [];
            for (const s of Array.isArray(ws.sessions) ? ws.sessions : []) {
              if (!s?.sessionId) continue;
              sessionIds.push(s.sessionId);
              if (s.pinned) remotePinnedIds.push(s.sessionId);
            }
            const displayPath = ws.deviceName
              ? (ws.path ? `${ws.deviceName} · ${ws.path}` : ws.deviceName)
              : (ws.path || '');
            return {
              workspaceId: nativeWsId,
              title: ws.title,
              path: displayPath,
              createdAt: new Date(Number(ws.updatedAt || Date.now())).toISOString(),
              sessionIds,
              __dshAuRemote: true,
              remoteDeviceId: ws.deviceId,
              remoteDeviceName: ws.deviceName,
              remoteWorkspaceId: ws.workspaceId,
              rawPath: ws.path || '',
              updatedAt: Number(ws.updatedAt || 0),
              sortUpdatedAt: Number(ws.sortUpdatedAt ?? ws.updatedAt ?? 0),
              aggregateStatus: ws.status || 'idle',
            };
          });

          const combinedItems = groupCombinedWorkspacesByDevice(localItems, remoteItems, { localUpdatedById, orderBy });
          store.combinedWorkspaces = combinedItems;

          if (orderBy !== 'manual' && combinedItems.length > 0) {
            const topWs = combinedItems[0];
            const topDeviceKey = topWs.__dshAuRemote ? `remote:${topWs.remoteDeviceId}` : 'local';
            const topTs = topWs.__dshAuRemote
              ? Number(topWs.sortUpdatedAt ?? topWs.updatedAt ?? 0)
              : (localUpdatedById.get(String(topWs.workspaceId)) ?? 0);
            if (!store.promptTrackerInitialized) {
              store.promptTrackerInitialized = true;
              store.lastMaxPromptTs = topTs;
            } else if (topTs > (store.lastMaxPromptTs || 0)) {
              store.lastMaxPromptTs = topTs;
              const targetWorkspaceId = topWs.workspaceId;
              const scheduleReveal = typeof queueMicrotask === 'function' ? queueMicrotask : (fn) => setTimeout(fn, 0);
              scheduleReveal(() => {
                try {
                  expandDeviceGroup(topDeviceKey);
                  uiWorkspace?.view?.setGroupExpanded?.(targetWorkspaceId, true);
                  decorateSidebarDeviceGroups();
                  scrollSidebarToTop();
                } catch {}
              });
            }
          }

          const mergedPinned = [...new Set([
            ...(Array.isArray(rawWs.pinnedSessionIds) ? rawWs.pinnedSessionIds : []),
            ...remotePinnedIds,
          ])];
          const mergedArchived = [...new Set([
            ...(Array.isArray(rawWs.archivedSessionIds) ? rawWs.archivedSessionIds : []),
            ...store.archivedSessionIds,
          ])];

          const nextValue = {
            ...rawWs,
            phase: (rawWs.phase === 'loading' && remoteItems.length > 0) ? 'ready' : (rawWs.phase || 'ready'),
            items: combinedItems,
            pinnedSessionIds: mergedPinned,
            archivedSessionIds: mergedArchived,
          };
          cachedWsKey = cacheKey;
          cachedWsSnap = { __rawWs: rawWs, __rawSess: rawSess, value: nextValue };
          return nextValue;
        };

        if (origSubWs) {
          wsList.subscribe = (listener) => {
            wsExtraListeners.add(listener);
            const unsub = origSubWs(listener);
            return () => {
              wsExtraListeners.delete(listener);
              try { unsub?.(); } catch {}
            };
          };
        }

        let cachedSessKey = null;
        let cachedSessSnap = null;
        sessList.getSnapshot = () => {
          const rawSess = origGetSessSnapshot() || { byId: {} };
          const isRemoteActive = Boolean((store.activeDeviceId && store.activeDeviceId !== 'local') || store.activeExtStage);
          const selectedSig = [...store.selectedSessionByDevice.entries()].map(([k, v]) => `${k}:${v}`).join('|');
          const extStageSig = store.activeExtStage ? `${store.activeExtStage.extId}:${store.activeExtStage.itemId}` : '';
          const cacheKey = `${store.revision}::${store.activeDeviceId || 'local'}::${extStageSig}::${selectedSig}`;
          if (cachedSessSnap && cachedSessKey === cacheKey && cachedSessSnap.__rawSess === rawSess) {
            return cachedSessSnap.value;
          }

          rebuildNativeRemoteRegistry();
          const rawById = (rawSess?.byId && typeof rawSess.byId === 'object') ? rawSess.byId : {};
          const nextById = {};
          for (const [sid, s] of Object.entries(rawById)) {
            if (!s) continue;
            // 闲置历史会话被点击打开时，DSH 底层写入 session/end-seed 会将 s.updatedAt 刷成当前时间；
            // 因此仅在会话正在运行时才 Math.max 取 updatedAt，闲置会话优先采纳真实的提问时间戳，避免点开旧会话时间变成「刚刚」并跳到顶部。
            const promptTs = Number(s?.projections?.values?.sessionListMetadata?.lastPromptAt) || Number(s.lastPromptAt) || 0;
            const rawUpd = Number(typeof s.updatedAt === 'string' ? Date.parse(s.updatedAt) : s.updatedAt) || 0;
            const rawCreated = Number(typeof s.createdAt === 'string' ? Date.parse(s.createdAt) : s.createdAt) || 0;
            const bestLocalTs = s.running === true
              ? Math.max(promptTs, rawUpd, rawCreated)
              : (promptTs || rawUpd || rawCreated);
            // DSH 原生 WorkspaceBrowser 依赖 row.projections.values.sessionListMetadata.lastPromptAt 展示侧边栏相对时间与排序；
            // 若存在 bestLocalTs，除补全 s.lastPromptAt 外，同步更新 projections 内的 lastPromptAt。
            const patched = bestLocalTs > 0
              ? {
                  ...s,
                  updatedAt: bestLocalTs,
                  lastPromptAt: bestLocalTs,
                  ...(s.projections?.values
                    ? {
                        projections: {
                          ...s.projections,
                          values: {
                            ...s.projections.values,
                            sessionListMetadata: {
                              ...(s.projections.values.sessionListMetadata || {}),
                              lastPromptAt: bestLocalTs,
                            },
                          },
                        },
                      }
                    : {}),
                }
              : s;
            if (isRemoteActive && (s.retainedBy?.mainView ?? 0) > 0) {
              nextById[sid] = {
                ...patched,
                retainedBy: { ...(s.retainedBy || {}), mainView: 0 },
              };
            } else {
              nextById[sid] = patched;
            }
          }

          for (const [sid, entry] of store.nativeSessionById.entries()) {
            const { ws, session } = entry;
            const currentRemoteSid = store.selectedSessionByDevice.get(ws.deviceId)
              || (store.activeDeviceId ? store.selectedSessionByDevice.get(store.activeDeviceId) : '')
              || store.controlledSnapshots.get(ws.deviceId)?.currentSessionId
              || '';
            const activeMatchesWs = Boolean(
              store.activeDeviceId
              && (store.activeDeviceId === ws.deviceId
                || resolvePreferredRemoteApiTargetId(store.activeDeviceId) === resolvePreferredRemoteApiTargetId(ws.deviceId))
            );
            const isSelected = Boolean(activeMatchesWs && currentRemoteSid === sid);
            const displayCwd = ws.deviceName
              ? (session.cwd ? `${ws.deviceName} · ${session.cwd}` : ws.deviceName)
              : (session.cwd || ws.path || '');
            const rawTs = session.updatedAt;
            const parsedTs = typeof rawTs === 'number' && Number.isFinite(rawTs) && rawTs > 0
              ? rawTs
              : (typeof rawTs === 'string' && rawTs.trim() ? (Number(rawTs) || Date.parse(rawTs) || 0) : 0);
            const ts = parsedTs > 0 ? parsedTs : Date.now();
            const rawCreated = session.createdAt;
            const parsedCreated = typeof rawCreated === 'number' && Number.isFinite(rawCreated) && rawCreated > 0
              ? rawCreated
              : (typeof rawCreated === 'string' && rawCreated.trim() ? (Number(rawCreated) || Date.parse(rawCreated) || 0) : 0);
            const createdTs = parsedCreated > 0 ? parsedCreated : ts;
            // 使用 resolveStabilizedSessionSortTs 确保 DSH 原生列表与 compareRemoteSessionOrder 排序顺序完全一致
            const sortTs = resolveStabilizedSessionSortTs(session) || ts;
            nextById[sid] = {
              id: sid,
              title: session.title,
              displayTitle: session.title,
              cwd: displayCwd,
              createdAt: createdTs,
              updatedAt: ts,
              lastPromptAt: sortTs,
              projections: {
                values: {
                  title: session.title,
                  sessionListMetadata: {
                    blank: Boolean(session.blank && session.title === '新对话'),
                    lastPromptAt: sortTs,
                  },
                },
              },
              running: session.status === 'busy',
              blank: Boolean(session.blank && session.title === '新对话'),
              parentSessionId: null,
              agentPreset: 'standard',
              retainedBy: { mainView: isSelected ? 1 : 0 },
              __dshAuRemote: true,
              remoteDeviceId: ws.deviceId,
              remoteDeviceName: ws.deviceName,
              remoteWorkspaceId: ws.workspaceId,
              remoteStatus: session.status,
              ...readSessionStateMeta(session),
            };
          }

          const mergedIds = [...new Set([
            ...(Array.isArray(rawSess.ids) ? rawSess.ids : Object.keys(rawById)),
            ...store.nativeSessionById.keys(),
          ])];

          const nextValue = {
            ...rawSess,
            ids: mergedIds,
            byId: nextById,
          };
          cachedSessKey = cacheKey;
          cachedSessSnap = { __rawSess: rawSess, value: nextValue };
          return nextValue;
        };

        if (origSubSess) {
          sessList.subscribe = (listener) => {
            sessExtraListeners.add(listener);
            const unsub = origSubSess(listener);
            return () => {
              sessExtraListeners.delete(listener);
              try { unsub?.(); } catch {}
            };
          };
        }

        let cachedStatusKey = null;
        let cachedStatusSnap = null;
        if (statusStore && origGetStatusSnapshot) {
          statusStore.__dshAuOrigGetSnapshot = origGetStatusSnapshot;
          statusStore.getSnapshot = () => {
            const rawMap = origGetStatusSnapshot();
            const selfStates = (typeof window !== 'undefined' && window.__dshAuLastStateSnap?.self?.sessionStatesV2) || null;
            const selfDetails = window.__dshAuLastStateSnap?.self?.sessionStateDetails || null;
            const selfIdleDigest = selfStates && typeof selfStates === 'object'
              ? Object.entries(selfStates).filter(([, v]) => v === 'idle').map(([k]) => k).sort().join(',')
              : '';
            const cacheKey = `${store.revision}::${selfIdleDigest}::${JSON.stringify(selfDetails)}`;
            if (cachedStatusSnap && cachedStatusKey === cacheKey && cachedStatusSnap.__rawMap === rawMap) {
              return cachedStatusSnap.value;
            }
            rebuildNativeRemoteRegistry();
            if (selfDetails && typeof syncControlledSessionsWithBackendState === 'function') {
              syncControlledSessionsWithBackendState(selfStates, ctx, Date.now(), selfDetails);
            }
            const nextMap = new Map(rawMap instanceof Map ? rawMap : []);
            const nowMs = Date.now();
            if (selfStates && typeof selfStates === 'object') {
              for (const [sid, rawSt] of nextMap.entries()) {
                if (!rawSt || store.nativeSessionById.has(sid) || readSessionStateMeta(selfDetails?.[sid])) continue;
                const isLocalActive = Boolean(
                  rawSt.running === true
                  || rawSt.pendingInteraction
                  || rawSt.pendingInteractionKind
                );
                if (isLocalActive) {
                  store.recentBusyAtBySession.set(sid, nowMs);
                  continue;
                }
                if (rawSt.completionUnread === true && selfStates[sid] === 'idle' && !wasSessionRecentlyActive(sid, nowMs)) {
                  const clearedSt = { ...rawSt, completionUnread: false };
                  if (rawMap instanceof Map) {
                    rawMap.set(sid, clearedSt);
                  }
                  if (typeof markControlledSessionConfirmed === 'function') {
                    try { markControlledSessionConfirmed(sid, null); } catch {}
                  }
                  nextMap.set(sid, clearedSt);
                }
              }
            }
            for (const [sid, entry] of store.nativeSessionById.entries()) {
              // 仅对每个远端工作区前 5 条会话（indexInWorkspace < 5）注入未读/运行/审批状态，
              // 确保 DSH 原生 requiredWatermark 始终维持 5 条上限并稳定展示「展开其余 N 个会话」按钮。
              if (entry.indexInWorkspace >= 5) {
                nextMap.delete(sid);
                continue;
              }
              const s = entry.session;
              const running = s.status === 'busy';
              const pendingInteractionKind = s.pendingInteractionKind || (s.status === 'waiting' ? 'approval' : undefined);
              const completionUnread = Boolean(s.completionUnread || s.status === 'done' || s.status === 'error');
              if (running || pendingInteractionKind || completionUnread) {
                nextMap.set(sid, {
                  running,
                  pendingInteraction: pendingInteractionKind ? { kind: pendingInteractionKind } : undefined,
                  pendingInteractionKind,
                  completionUnread,
                  ...readSessionStateMeta(s),
                });
              } else {
                nextMap.delete(sid);
              }
            }
            cachedStatusKey = cacheKey;
            cachedStatusSnap = { __rawMap: rawMap, value: nextMap };
            return nextMap;
          };

          if (origSubStatus) {
            statusStore.subscribe = (listener) => {
              statusExtraListeners.add(listener);
              const unsub = origSubStatus(listener);
              return () => {
                statusExtraListeners.delete(listener);
                try { unsub?.(); } catch {}
              };
            };
          }
        }

        // trigger 记录被拦截的原生动作；sessionId/recordCount 用于判断是否因远端列表暂未识别该会话而误切回本机。
        const switchBackToLocalIfNeeded = (trigger = '', sessionId = '') => {
          if ((store.activeDeviceId && store.activeDeviceId !== 'local') || store.activeExtStage) {
            if (store.activeDeviceId && store.activeDeviceId !== 'local') {
              cancelRemoteNavigation(store.activeDeviceId);
            }
            store.createSessionSeq = (Number(store.createSessionSeq) || 0) + 1;
            store.activeDeviceId = null;
            store.activeExtStage = null;
            pruneActiveInteractedSessions('');
            notifyStoreListeners();
            if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
              window.dispatchEvent(new CustomEvent(DEVICE_SELECT_EVENT, { detail: {
                deviceId: 'local',
                reason: 'intercept',
                trigger,
                sessionId: typeof sessionId === 'string' ? sessionId : '',
                knownRemote: false,
                recordCount: store.nativeSessionById.size,
              } }));
            }
          }
        };

        // 拦截 uiWorkspace 动作
        const origOpenSession = typeof uiWorkspace?.openSession === 'function' ? uiWorkspace.openSession.bind(uiWorkspace) : null;
        if (uiWorkspace && origOpenSession) {
          uiWorkspace.openSession = (sessionId, ...rest) => {
            rebuildNativeRemoteRegistry();
            const remoteEntry = store.nativeSessionById.get(sessionId);
            if (remoteEntry) {
              activateRemoteSession(remoteEntry.ws, remoteEntry.session);
              return;
            }
            switchBackToLocalIfNeeded('openSession', sessionId);
            const res = origOpenSession(sessionId, ...rest);
            // 本地会话打开后自动滚动侧栏至该行并展开工作区
            scrollSidebarToSession(sessionId);
            return res;
          };
        }

        // Hero 下拉实际调用 openWorkspace；必须在原生创建和本机 retain/草稿迁移之前切到远端舞台。
        const origOpenWorkspace = typeof uiWorkspace?.openWorkspace === 'function' ? uiWorkspace.openWorkspace.bind(uiWorkspace) : null;
        if (uiWorkspace && origOpenWorkspace) {
          uiWorkspace.openWorkspace = async (workspaceId, ...rest) => {
            if (isNativeRemoteWorkspaceId(workspaceId)) {
              rebuildNativeRemoteRegistry();
              const ws = store.nativeWorkspaceById.get(workspaceId);
              if (!ws) throw new Error('远程工作区已不可用，请刷新后重新选择');
              // 本地草稿保留在原会话；不能把本机 binding 回调用于远端会话。
              uiWorkspace?.view?.setGroupExpanded?.(workspaceId, true);
              await activateRemoteWorkspace(ws, { createNew: true });
              return;
            }
            switchBackToLocalIfNeeded('openWorkspace');
            return origOpenWorkspace(workspaceId, ...rest);
          };
        }

        const origSelectWorkspace = typeof uiWorkspace?.selectWorkspace === 'function' ? uiWorkspace.selectWorkspace.bind(uiWorkspace) : null;
        if (uiWorkspace && origSelectWorkspace) {
          uiWorkspace.selectWorkspace = (workspaceId, ...rest) => {
            if (isNativeRemoteWorkspaceId(workspaceId)) {
              rebuildNativeRemoteRegistry();
              const ws = store.nativeWorkspaceById.get(workspaceId);
              if (ws) {
                uiWorkspace?.view?.setGroupExpanded?.(workspaceId, true);
                activateRemoteWorkspace(ws, { createNew: false });
              }
              return;
            }
            switchBackToLocalIfNeeded('selectWorkspace');
            return origSelectWorkspace(workspaceId, ...rest);
          };
        }

        const origStartSession = typeof uiWorkspace?.startSession === 'function' ? uiWorkspace.startSession.bind(uiWorkspace) : null;
        if (uiWorkspace && origStartSession) {
          uiWorkspace.startSession = (workspaceId, ...rest) => {
            if (isNativeRemoteWorkspaceId(workspaceId)) {
              rebuildNativeRemoteRegistry();
              const ws = store.nativeWorkspaceById.get(workspaceId);
              if (ws) {
                uiWorkspace?.view?.setGroupExpanded?.(workspaceId, true);
                return activateRemoteWorkspace(ws, { createNew: true });
              }
              return;
            }
            // 当处于远端 DSH 激活态且无参触发新建对话（如快捷键 Ctrl+N / Cmd+N）时，直接在当前激活的远端工作区新建对话
            if (!workspaceId && store.activeDeviceId && store.activeDeviceId !== 'local') {
              const merged = rebuildNativeRemoteRegistry();
              const selectedWsKey = store.selectedWorkspaceByDevice.get(store.activeDeviceId) || '';
              const targetWs = merged.visible.find((w) => w?.deviceId === store.activeDeviceId && (!selectedWsKey || w.key === selectedWsKey))
                || merged.visible.find((w) => w?.deviceId === store.activeDeviceId)
                || null;
              if (targetWs) {
                const nativeWsId = targetWs.nativeWorkspaceId || toNativeRemoteWorkspaceId(targetWs.deviceId, targetWs.workspaceId);
                uiWorkspace?.view?.setGroupExpanded?.(nativeWsId, true);
                return activateRemoteWorkspace(targetWs, { createNew: true });
              }
            }
            switchBackToLocalIfNeeded('startSession');
            const started = origStartSession(workspaceId, ...rest);
            if (typeof featuresStore !== 'undefined' && featuresStore.snapshot.fullAccessByDefault) {
              void (async () => {
                for (const delay of [60, 200, 500]) {
                  await new Promise((r) => setTimeout(r, delay));
                  const sid = readNativeSelectedSessionId(ctx);
                  if (sid) {
                    const sessionsSvc = ctx?.get?.('sessions') || ctx?.sessions;
                    const live = sessionsSvc?.binding?.(sid)?.session;
                    if (live && typeof live.command === 'function') {
                      try {
                        await live.command('/permission danger-full-access');
                        break;
                      } catch {}
                    }
                  }
                }
              })();
            }
            return started;
          };
        }

        const origSetSessionOrder = typeof viewStore?.setSessionOrder === 'function' ? viewStore.setSessionOrder.bind(viewStore) : null;
        if (viewStore && origSetSessionOrder) {
          // 屏蔽点击切换会话时的微拖拽写入 manual 排序锁，防止会话被插入到错误位置并锁死旧顺序
          viewStore.setSessionOrder = () => {};
        }
        const origSetGroupExpanded = typeof viewStore?.setGroupExpanded === 'function' ? viewStore.setGroupExpanded.bind(viewStore) : null;
        if (viewStore && origSetGroupExpanded) {
          viewStore.setGroupExpanded = (key, expanded) => {
            const res = origSetGroupExpanded(key, expanded);
            if (isNativeRemoteWorkspaceId(key)) {
              const parsed = parseNativeRemoteWorkspaceId(key);
              if (parsed) {
                if (expanded) {
                  store.expandedKeys.add(parsed.key);
                  // 展开工作区时先让后台会话正文预加载暂停让路，优先保障目录展开与本地缓存树同步，同时保留设备预热事件触发
                  remoteSessionPreloadCoordinator?.notifyForeground?.('', '');
                  if (store.nativeBridgeInstalled) decorateNativeRemoteRows();
                  else syncWorkspaceListFlexOrder(store.hostCtx);
                  dispatchPreloadDevices([parsed.deviceId]);
                } else {
                  store.expandedKeys.delete(parsed.key);
                }
                persistExpandedRemoteWorkspaces();
              }
            }
            return res;
          };
        }

        const origRetainAccountKeys = typeof viewStore?.retainAccountKeys === 'function' ? viewStore.retainAccountKeys.bind(viewStore) : null;
        if (viewStore && origRetainAccountKeys) {
          viewStore.retainAccountKeys = (keys) => {
            const baseKeys = Array.isArray(keys) ? keys : [...(keys || [])];
            const currentExpansion = viewStore.getSnapshot?.()?.groupExpansion || {};
            const extraRemoteKeys = Object.keys(currentExpansion).filter((k) => isNativeRemoteWorkspaceId(k));
            for (const nativeWsId of store.nativeWorkspaceById.keys()) {
              extraRemoteKeys.push(nativeWsId);
            }
            return origRetainAccountKeys([...new Set([...baseKeys, ...extraRemoteKeys])]);
          };
        }

        // 拦截 workspaces 动作（置顶、取消置顶、归档、取消归档、重命名、移除/隐藏）
        const origPinSession = typeof workspacesSvc?.pinSession === 'function' ? workspacesSvc.pinSession.bind(workspacesSvc) : null;
        if (workspacesSvc) {
          workspacesSvc.pinSession = async (sessionId, ...rest) => {
            rebuildNativeRemoteRegistry();
            const entry = store.nativeSessionById.get(sessionId);
            if (entry) {
              store.pinnedSessionOverrides.set(sessionId, true);
              notifyStoreListeners();
              executeRemoteEntityActionOnPeer(entry.ws, { entityAction: 'pinSession', sessionId });
              return { ok: true };
            }
            return origPinSession ? origPinSession(sessionId, ...rest) : undefined;
          };
        }

        const origUnpinSession = typeof workspacesSvc?.unpinSession === 'function' ? workspacesSvc.unpinSession.bind(workspacesSvc) : null;
        if (workspacesSvc) {
          workspacesSvc.unpinSession = async (sessionId, ...rest) => {
            rebuildNativeRemoteRegistry();
            const entry = store.nativeSessionById.get(sessionId);
            if (entry) {
              store.pinnedSessionOverrides.set(sessionId, false);
              notifyStoreListeners();
              executeRemoteEntityActionOnPeer(entry.ws, { entityAction: 'unpinSession', sessionId });
              return { ok: true };
            }
            return origUnpinSession ? origUnpinSession(sessionId, ...rest) : undefined;
          };
        }

        const origArchiveSession = typeof workspacesSvc?.archiveSession === 'function' ? workspacesSvc.archiveSession.bind(workspacesSvc) : null;
        if (workspacesSvc) {
          workspacesSvc.archiveSession = async (sessionId, ...rest) => {
            rebuildNativeRemoteRegistry();
            const entry = store.nativeSessionById.get(sessionId);
            if (entry) {
              store.archivedSessionIds.add(sessionId);
              notifyStoreListeners();
              executeRemoteEntityActionOnPeer(entry.ws, { entityAction: 'archiveSession', sessionId });
              return { ok: true };
            }
            return origArchiveSession ? origArchiveSession(sessionId, ...rest) : undefined;
          };
        }

        const origUnarchiveSession = typeof workspacesSvc?.unarchiveSession === 'function' ? workspacesSvc.unarchiveSession.bind(workspacesSvc) : null;
        if (workspacesSvc) {
          workspacesSvc.unarchiveSession = async (sessionId, ...rest) => {
            rebuildNativeRemoteRegistry();
            const entry = store.nativeSessionById.get(sessionId);
            if (entry) {
              store.archivedSessionIds.delete(sessionId);
              notifyStoreListeners();
              executeRemoteEntityActionOnPeer(entry.ws, { entityAction: 'unarchiveSession', sessionId });
              return { ok: true };
            }
            return origUnarchiveSession ? origUnarchiveSession(sessionId, ...rest) : undefined;
          };
        }

        const origRenameWorkspace = typeof workspacesSvc?.rename === 'function' ? workspacesSvc.rename.bind(workspacesSvc) : null;
        if (workspacesSvc) {
          workspacesSvc.rename = async (workspaceId, title, ...rest) => {
            if (isNativeRemoteWorkspaceId(workspaceId)) {
              rebuildNativeRemoteRegistry();
              const ws = store.nativeWorkspaceById.get(workspaceId) || parseNativeRemoteWorkspaceId(workspaceId);
              const cleanTitle = String(title || '').trim();
              if (ws && cleanTitle) {
                store.workspaceTitleOverrides.set(ws.key, cleanTitle);
                notifyStoreListeners();
                executeRemoteEntityActionOnPeer(ws, {
                  entityAction: 'renameWorkspace',
                  workspaceId: ws.workspaceId,
                  title: cleanTitle,
                });
              }
              return { ok: true };
            }
            return origRenameWorkspace ? origRenameWorkspace(workspaceId, title, ...rest) : undefined;
          };
        }

        const origRemoveWorkspace = typeof workspacesSvc?.remove === 'function' ? workspacesSvc.remove.bind(workspacesSvc) : null;
        if (workspacesSvc) {
          workspacesSvc.remove = async (workspaceId, ...rest) => {
            if (isNativeRemoteWorkspaceId(workspaceId)) {
              rebuildNativeRemoteRegistry();
              const ws = store.nativeWorkspaceById.get(workspaceId) || parseNativeRemoteWorkspaceId(workspaceId);
              if (ws) {
                hideRemoteWorkspace(ws.deviceId, ws.workspaceId);
              }
              return { ok: true };
            }
            return origRemoveWorkspace ? origRemoveWorkspace(workspaceId, ...rest) : undefined;
          };
        }

        // 拦截 sessions.rename
        const origRenameSession = typeof sessionsSvc?.rename === 'function' ? sessionsSvc.rename.bind(sessionsSvc) : null;
        if (sessionsSvc) {
          sessionsSvc.rename = async (sessionId, title, ...rest) => {
            rebuildNativeRemoteRegistry();
            const entry = store.nativeSessionById.get(sessionId);
            if (entry) {
              const cleanTitle = String(title || '').trim();
              if (cleanTitle) {
                store.sessionTitleOverrides.set(sessionId, cleanTitle);
                notifyStoreListeners();
                executeRemoteEntityActionOnPeer(entry.ws, {
                  entityAction: 'renameSession',
                  sessionId,
                  title: cleanTitle,
                });
              }
              return { ok: true };
            }
            return origRenameSession ? origRenameSession(sessionId, title, ...rest) : undefined;
          };
        }

        // 拦截 remoteAccess.source.deleteSession
        const remoteSource = remoteAccessSvc?.source;
        const origDeleteSession = typeof remoteSource?.deleteSession === 'function' ? remoteSource.deleteSession.bind(remoteSource) : null;
        if (remoteSource && origDeleteSession) {
          remoteSource.deleteSession = async (sessionId, ...rest) => {
            rebuildNativeRemoteRegistry();
            const entry = store.nativeSessionById.get(sessionId);
            if (entry) {
              store.archivedSessionIds.add(sessionId);
              notifyStoreListeners();
              executeRemoteEntityActionOnPeer(entry.ws, { entityAction: 'archiveSession', sessionId });
              return { ok: true };
            }
            return origDeleteSession(sessionId, ...rest);
          };
        }

        // 当远端工作区 store 更新时，主动唤醒所有原生订阅者（含在 dsh-au 加载前已注册的 WorkspaceBrowser / derive 订阅者）
        const propagateToNativeSubscribers = () => {
          rebuildNativeRemoteRegistry();
          if (wsList.listeners instanceof Set) {
            for (const fn of [...wsList.listeners]) {
              try { fn(); } catch {}
            }
          }
          for (const fn of [...wsExtraListeners]) {
            try { fn(); } catch {}
          }
          if (sessList.listeners instanceof Set) {
            for (const fn of [...sessList.listeners]) {
              try { fn(); } catch {}
            }
          }
          for (const fn of [...sessExtraListeners]) {
            try { fn(); } catch {}
          }
          if (typeof uiSessionSvc?.publishStatus === 'function') {
            try { uiSessionSvc.publishStatus(); } catch {}
          } else if (uiSessionSvc?.statusListeners instanceof Set) {
            for (const fn of [...uiSessionSvc.statusListeners]) {
              try { fn(); } catch {}
            }
          }
          for (const fn of [...statusExtraListeners]) {
            try { fn(); } catch {}
          }
          if (typeof document !== 'undefined') {
            decorateNativeRemoteRows(document);
          }
        };

        store.listeners.add(propagateToNativeSubscribers);
        store.nativeBridgeInstalled = true;
        propagateToNativeSubscribers();

        const disposer = () => {
          store.listeners.delete(propagateToNativeSubscribers);
          store.nativeBridgeInstalled = false;
          wsList.getSnapshot = origGetWsSnapshot;
          if (origSubWs) wsList.subscribe = origSubWs;
          sessList.getSnapshot = origGetSessSnapshot;
          if (origSubSess) sessList.subscribe = origSubSess;
          if (statusStore && origGetStatusSnapshot) {
            statusStore.getSnapshot = origGetStatusSnapshot;
            delete statusStore.__dshAuOrigGetSnapshot;
          }
          if (statusStore && origSubStatus) statusStore.subscribe = origSubStatus;
          if (uiWorkspace && origOpenSession) uiWorkspace.openSession = origOpenSession;
          if (uiWorkspace && origOpenWorkspace) uiWorkspace.openWorkspace = origOpenWorkspace;
          if (uiWorkspace && origSelectWorkspace) uiWorkspace.selectWorkspace = origSelectWorkspace;
          if (uiWorkspace && origStartSession) uiWorkspace.startSession = origStartSession;
          if (viewStore && origGetViewSnapshot) viewStore.getSnapshot = origGetViewSnapshot;
          if (viewStore && origSetSessionOrder) viewStore.setSessionOrder = origSetSessionOrder;
          if (viewStore && origSetGroupExpanded) viewStore.setGroupExpanded = origSetGroupExpanded;
          if (viewStore && origRetainAccountKeys) viewStore.retainAccountKeys = origRetainAccountKeys;
          if (workspacesSvc && origPinSession) workspacesSvc.pinSession = origPinSession;
          if (workspacesSvc && origUnpinSession) workspacesSvc.unpinSession = origUnpinSession;
          if (workspacesSvc && origArchiveSession) workspacesSvc.archiveSession = origArchiveSession;
          if (workspacesSvc && origUnarchiveSession) workspacesSvc.unarchiveSession = origUnarchiveSession;
          if (workspacesSvc && origRenameWorkspace) workspacesSvc.rename = origRenameWorkspace;
          if (workspacesSvc && origRemoveWorkspace) workspacesSvc.remove = origRemoveWorkspace;
          if (sessionsSvc && origRenameSession) sessionsSvc.rename = origRenameSession;
          if (remoteSource && origDeleteSession) remoteSource.deleteSession = origDeleteSession;
          delete wsList.__dshAuNativeBridgeDisposer;
        };
        wsList.__dshAuNativeBridgeDisposer = disposer;
        return disposer;
      }

      /** 侧边栏远端工作区树组件（严禁使用 data-row-key 属性）。 */
      function RemoteWorkspacesTree() {
        const [, setTick] = useState(0);
        useEffect(() => {
          const rerender = () => setTick((t) => t + 1);
          store.listeners.add(rerender);
          return () => store.listeners.delete(rerender);
        }, []);

        const { visible, hiddenCount } = mergeRemoteWorkspaces(
          store.serverWorkspaces,
          store.controlledSnapshots,
          store.devices,
          store.hiddenKeys
        );

        // 首次出现的工作区保持与原生工作区一致的默认折叠态；仅当内含待处理会话（waiting/error/done）时自动展开提醒
        for (const ws of visible) {
          if (!store.initializedExpanded.has(ws.key)) {
            store.initializedExpanded.add(ws.key);
            const agg = computeWorkspaceAggregateStatus(ws.sessions, ws.status);
            if (agg === 'waiting' || agg === 'error' || agg === 'done') {
              store.expandedKeys.add(ws.key);
            }
          }
        }

        useEffect(() => {
          if (store.nativeBridgeInstalled) {
            decorateNativeRemoteRows();
          } else {
            syncWorkspaceListFlexOrder(store.hostCtx);
          }
        });

        if (store.nativeBridgeInstalled) {
          if (hiddenCount <= 0) return null;
          return h('button', {
            key: 'restore',
            type: 'button',
            className: 'dsh-au-remote-ws-restore',
            onClick: (event) => {
              event.stopPropagation();
              restoreAllHiddenRemoteWorkspaces();
            },
          }, `已隐藏 ${hiddenCount} 个远端工作区 · 恢复全部`);
        }

        if (!visible.length && hiddenCount === 0) return null;

        return h(
          React.Fragment,
          null,
          visible.map((ws) => {
            const expanded = store.expandedKeys.has(ws.key);
            const isDeviceActive = store.activeDeviceId === ws.deviceId;
            const currentRemoteSessionId = store.selectedSessionByDevice.get(ws.deviceId)
              || store.controlledSnapshots.get(ws.deviceId)?.currentSessionId
              || '';
            const selectedWsKey = store.selectedWorkspaceByDevice.get(ws.deviceId) || '';
            const aggregateStatus = computeWorkspaceAggregateStatus(ws.sessions, ws.status);
            const hasRunning = aggregateStatus === 'busy' || aggregateStatus === 'waiting';
            const isWorkspaceActive = isDeviceActive && (
              (currentRemoteSessionId && ws.sessions.some((s) => s.sessionId === currentRemoteSessionId))
              || (!currentRemoteSessionId && selectedWsKey === ws.key)
            );

            const transportLabel = resolveDeviceConnectionTransport(ws.deviceId);

            return h('div', {
              key: ws.key,
              className: 'dsh-au-remote-ws-item',
              'data-remote-device-id': ws.deviceId,
              'data-remote-workspace-id': ws.workspaceId,
              'data-remote-ws-updated-at': String(ws.updatedAt || 0),
            }, [
              h('div', {
                key: 'row',
                role: 'treeitem',
                'aria-expanded': expanded,
                className: `dsh-au-remote-ws-row${expanded ? ' expanded' : ''}${isWorkspaceActive ? ' active' : ''}`,
                title: `${ws.title}${ws.path ? ` (${ws.path})` : ''} · ${ws.deviceName}`,
                onClick: (event) => {
                  const clickedLeading = Boolean(event.target?.closest?.('.dsh-au-remote-ws-leading'));
                  if (expanded && (clickedLeading || isWorkspaceActive)) {
                    store.expandedKeys.delete(ws.key);
                    persistExpandedRemoteWorkspaces();
                    notifyStoreListeners();
                    return;
                  }
                  activateRemoteWorkspace(ws, { createNew: false });
                },
              }, [
                h('span', {
                  key: 'leading',
                  className: `dsh-au-remote-ws-leading${isWorkspaceActive || hasRunning ? ' highlight' : ''}`,
                }, [
                  h('span', { key: 'folder', className: 'dsh-au-remote-ws-folder-icon' },
                    expanded ? h(RemoteFolderOpenIcon) : h(RemoteFolderClosedIcon)),
                  h('span', { key: 'chevron', className: `dsh-au-remote-ws-chevron-icon${expanded ? ' expanded' : ''}` },
                    h(RemoteChevronIcon)),
                ]),
                h('div', { key: 'main', className: 'dsh-au-remote-ws-main' }, [
                  h('span', { key: 'title', className: 'dsh-au-remote-ws-title' }, ws.title),
                  h('span', {
                    key: 'badge',
                    className: 'dsh-au-remote-ws-badge',
                    title: transportLabel ? `远端设备：${ws.deviceName}（连接方式：${transportLabel}）` : `远端设备：${ws.deviceName}`,
                  }, [
                    h(RemoteMonitorIcon, { key: 'icon' }),
                    h('span', { key: 'name', className: 'dsh-au-remote-ws-badge-name' }, ws.deviceName),
                    transportLabel ? h('span', { key: 'sep', className: 'dsh-au-remote-ws-badge-sep' }, '·') : null,
                    transportLabel ? h('span', { key: 'transport', className: 'dsh-au-remote-ws-badge-transport' }, transportLabel) : null,
                    (aggregateStatus !== 'idle' && aggregateStatus !== 'done')
                      ? h('span', { key: 'dot', className: `dsh-au-remote-ws-badge-dot ${aggregateStatus}` })
                      : null,
                  ]),
                ]),
                h('div', {
                  key: 'actions',
                  className: 'dsh-au-remote-ws-actions',
                  onClick: (event) => event.stopPropagation(),
                }, [
                  h('button', {
                    key: 'hide',
                    type: 'button',
                    className: 'dsh-au-remote-ws-action-btn hide',
                    title: '隐藏此远端工作区',
                    'aria-label': `隐藏远端工作区 ${ws.title}`,
                    onClick: (event) => {
                      event.stopPropagation();
                      hideRemoteWorkspace(ws.deviceId, ws.workspaceId);
                    },
                  }, h(RemoteEyeOffIcon)),
                  h('button', {
                    key: 'new',
                    type: 'button',
                    className: 'dsh-au-remote-ws-action-btn new-session',
                    title: '在此远端工作区新建对话',
                    'aria-label': `在远端工作区 ${ws.title} 新建对话`,
                    onClick: (event) => {
                      event.stopPropagation();
                      activateRemoteWorkspace(ws, { createNew: true });
                    },
                  }, h(RemotePlusIcon)),
                ]),
              ]),
              expanded && ws.sessions.length > 0
                ? h('div', { key: 'sessions', className: 'dsh-au-remote-session-list', role: 'group' },
                  ws.sessions.map((session) => {
                    const status = normalizeSessionStatus(session.status);
                    const selected = isDeviceActive && currentRemoteSessionId === session.sessionId;
                    return h('div', {
                      key: `${ws.key}:${session.sessionId}`,
                      role: 'treeitem',
                      'aria-selected': selected,
                      className: `dsh-au-remote-session-row${selected ? ' selected' : ''}`,
                      'data-remote-session-id': session.sessionId,
                      title: session.title,
                      onClick: (event) => {
                        event.stopPropagation();
                        activateRemoteSession(ws, session);
                      },
                    }, [
                      h('span', { key: 'leading', className: 'dsh-au-remote-session-leading' },
                        (status !== 'idle' && status !== 'done')
                          ? h('span', { className: `dsh-au-remote-session-dot ${status}`, title: status })
                          : null),
                      h('span', { key: 'title', className: 'dsh-au-remote-session-title' }, session.title),
                      h('span', { key: 'time', className: 'dsh-au-remote-session-time' }, formatCompactRelativeTime(session.updatedAt)),
                    ]);
                  }))
                : null,
            ]);
          }),
          hiddenCount > 0
            ? h('button', {
                key: 'restore',
                type: 'button',
                className: 'dsh-au-remote-ws-restore',
                onClick: (event) => {
                  event.stopPropagation();
                  restoreAllHiddenRemoteWorkspaces();
                },
              }, `已隐藏 ${hiddenCount} 个远端工作区 · 恢复全部`)
            : null
        );
      }

      /**
       * 将本机工作区（_groupSection）与远端工作区（.dsh-au-remote-ws-item）在同一 flex 容器内按「最近更新」时间交错排序。
       * 通过 CSS `order` 控制显示顺序，不移动 DSH 原生 React 管理的 DOM 节点。
       */
      function syncWorkspaceListFlexOrder(ctx = store.hostCtx, doc = typeof document !== 'undefined' ? document : null) {
        const treeContainer = findNativeWorkspaceTreeContainer(doc);
        if (!treeContainer || typeof treeContainer.querySelectorAll !== 'function') return;

        const uiWorkspace = ctx?.get?.('uiWorkspace') || ctx?.uiWorkspace;
        const workspacesSvc = ctx?.get?.('workspaces') || ctx?.workspaces || uiWorkspace?.workspaces;
        const sessionsSvc = ctx?.get?.('sessions') || ctx?.sessions || uiWorkspace?.sessions;
        const workspacesSnap = workspacesSvc?.list?.getSnapshot?.() || workspacesSvc?.getSnapshot?.() || null;
        const sessionsSnap = sessionsSvc?.list?.getSnapshot?.() || sessionsSvc?.getSnapshot?.() || null;

        const orderBy = uiWorkspace?.orderBy || workspacesSnap?.orderBy || 'recent';
        const localUpdatedById = new Map();
        const sessionsById = (sessionsSnap?.byId && typeof sessionsSnap.byId === 'object') ? sessionsSnap.byId : {};

        for (const ws of Array.isArray(workspacesSnap?.items) ? workspacesSnap.items : []) {
          if (!ws?.workspaceId) continue;
          let maxTs = Number(typeof ws.createdAt === 'string' ? Date.parse(ws.createdAt) : ws.createdAt) || 0;
          for (const sid of Array.isArray(ws.sessionIds) ? ws.sessionIds : []) {
            const s = sessionsById[sid];
            if (!s) continue;
            const promptTs = Number(s?.projections?.values?.sessionListMetadata?.lastPromptAt) || Number(s.lastPromptAt) || 0;
            const rawUpd = Number(typeof s.updatedAt === 'string' ? Date.parse(s.updatedAt) : s.updatedAt) || 0;
            const rawCreated = Number(typeof s.createdAt === 'string' ? Date.parse(s.createdAt) : s.createdAt) || 0;
            // 闲置历史会话被点击打开时，DSH 底层写入 session/end-seed 会将 s.updatedAt 刷成当前时间；
            // 因此仅在会话正在运行时才 Math.max 取 updatedAt，闲置会话优先采纳真实的提问时间戳。
            const sTs = s.running === true
              ? Math.max(promptTs, rawUpd, rawCreated)
              : (promptTs || rawUpd || rawCreated || 0);
            if (sTs > maxTs) maxTs = sTs;
          }
          localUpdatedById.set(String(ws.workspaceId), maxTs);
        }

        const nativeSections = Array.from(treeContainer.querySelectorAll(':scope > [class*="_groupSection"]'));
        const remoteItems = Array.from(treeContainer.querySelectorAll('.dsh-au-remote-ws-item'));
        const restoreBtn = treeContainer.querySelector('.dsh-au-remote-ws-restore');
        if (restoreBtn?.style) restoreBtn.style.order = '99999';

        if (orderBy === 'manual' || localUpdatedById.size === 0) {
          nativeSections.forEach((sec, idx) => {
            if (sec?.style) sec.style.order = String(idx + 1);
          });
          remoteItems.forEach((item, idx) => {
            if (item?.style) item.style.order = String(nativeSections.length + idx + 1);
          });
          return;
        }

        const combined = [];
        nativeSections.forEach((sec, idx) => {
          const rowEl = sec.querySelector?.('[data-row-key^="workspace:"]');
          const rowKey = rowEl?.getAttribute?.('data-row-key') || '';
          const wsId = rowKey.startsWith('workspace:') ? rowKey.slice('workspace:'.length) : '';
          const updatedAt = localUpdatedById.get(wsId) ?? 0;
          combined.push({ el: sec, updatedAt, domIndex: idx });
        });
        remoteItems.forEach((item, idx) => {
          const updatedAt = Number(item.getAttribute?.('data-remote-ws-updated-at') || 0) || 0;
          combined.push({ el: item, updatedAt, domIndex: nativeSections.length + idx });
        });

        combined.sort((a, b) => {
          const diff = b.updatedAt - a.updatedAt;
          if (diff !== 0) return diff;
          return a.domIndex - b.domIndex;
        });

        combined.forEach((entry, idx) => {
          if (entry.el?.style) {
            entry.el.style.order = String(idx + 1);
          }
        });
      }

      /** 通过 shell.overlay Portal 将远端工作区辅助节点（如恢复已隐藏按钮）渲染进左侧栏原生容器末尾。 */
      function RemoteWorkspacesOverlay() {
        const [mountNode, setMountNode] = useState(() => ensureRemoteWorkspacesMountNode());
        useEffect(() => {
          overlaySlotMounted = true;
          const syncMount = () => {
            const node = ensureRemoteWorkspacesMountNode();
            setMountNode((prev) => (prev === node ? prev : node));
            if (store.nativeBridgeInstalled) {
              decorateNativeRemoteRows();
            } else {
              syncWorkspaceListFlexOrder(store.hostCtx);
            }
          };
          syncMount();
          const observer = typeof MutationObserver !== 'undefined' && typeof document !== 'undefined' && document.body
            ? new MutationObserver(syncMount)
            : null;
          observer?.observe(document.body, { childList: true, subtree: true });
          const timer = window.setInterval(syncMount, 1500);
          return () => {
            overlaySlotMounted = false;
            observer?.disconnect();
            window.clearInterval(timer);
          };
        }, []);

        // 远程 DSH 管理关闭时，侧栏不再展示远程设备工作区。
        const remoteManagementEnabled = useFeatures().remoteManagement !== false;
        if (!remoteManagementEnabled || !mountNode || typeof ReactDOM.createPortal !== 'function') return null;
        return ReactDOM.createPortal(h(RemoteWorkspacesTree), mountNode);
      }

      function apply(ctx) {
        // 受控远端 iframe 分支：确保内部侧栏隐藏样式生效，并主动向父窗口同步工作区快照及后续变更
        if (isControlledFrame()) {
          ctx.effect(() => {
            ensureControlledFrameStyle();
            try {
              window.parent?.postMessage({
                source: 'dsh-au',
                type: 'dsh-au:controlled-sidebar-hidden',
                controlledSidebarHidden: true,
              }, '*');
            } catch {}
            const uiWorkspace = ctx?.get?.('uiWorkspace') || ctx?.uiWorkspace;
            const workspacesSvc = ctx?.get?.('workspaces') || ctx?.workspaces || uiWorkspace?.workspaces;
            const sessionsSvc = ctx?.get?.('sessions') || ctx?.sessions || uiWorkspace?.sessions;
            const uiSessionSvc = ctx?.get?.('uiSession') || ctx?.uiSession;
            let snapshotTimer = null;
            const scheduleSnapshotPush = () => {
              if (snapshotTimer) return;
              snapshotTimer = window.setTimeout(() => {
                snapshotTimer = null;
                postControlledWorkspacesSnapshot(ctx);
              }, 160);
            };
            const unsubWorkspaces = typeof workspacesSvc?.list?.subscribe === 'function'
              ? workspacesSvc.list.subscribe(scheduleSnapshotPush)
              : null;
            const unsubSessions = typeof sessionsSvc?.list?.subscribe === 'function'
              ? sessionsSvc.list.subscribe(scheduleSnapshotPush)
              : null;
            const unsubStatus = typeof uiSessionSvc?.sessionStatus?.subscribe === 'function'
              ? uiSessionSvc.sessionStatus.subscribe(scheduleSnapshotPush)
              : null;
            const syncControlledBackendConfirmations = async () => {
              if (typeof fetch !== 'function') return;
              try {
                const res = await fetch('/dsh-au/api', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ action: 'getState' }),
                });
                const data = await res?.json?.().catch?.(() => null);
                const selfStates = data?.self?.sessionStatesV2;
                if (selfStates && typeof syncControlledSessionsWithBackendState === 'function') {
                  if (syncControlledSessionsWithBackendState(selfStates, ctx, Date.now(), data?.self?.sessionStateDetails)) {
                    scheduleSnapshotPush();
                  }
                }
              } catch {}
            };
            postControlledWorkspacesSnapshot(ctx);
            void syncControlledBackendConfirmations();
            const controlledPollTimer = window.setInterval(syncControlledBackendConfirmations, POLL_INTERVAL_MS);
            return () => {
              if (snapshotTimer) window.clearTimeout(snapshotTimer);
              window.clearInterval(controlledPollTimer);
              try { unsubWorkspaces?.(); } catch {}
              try { unsubSessions?.(); } catch {}
              try { unsubStatus?.(); } catch {}
            };
          }, 'dsh-au: controlled remote workspaces bridge');
          return;
        }
        if (typeof window === 'undefined' || window[CLIENT_LOCK]) return;
        window[CLIENT_LOCK] = true;
        ctx.effect(() => () => {
          if (window[CLIENT_LOCK]) delete window[CLIENT_LOCK];
        }, 'dsh-au: remote workspaces singleton');

        const hasOverlaySlot = typeof ctx?.slots?.inject === 'function';
        store.hostCtx = ctx;

        ctx.effect(() => {
          store.hostCtx = ctx;
          store.hiddenKeys = new Set(readHiddenRemoteWorkspaces());
          for (const key of readExpandedRemoteWorkspaces()) {
            store.expandedKeys.add(key);
            store.initializedExpanded.add(key);
          }
          const disposeNativeBridge = installNativeWorkspaceBridge(ctx);

          let alive = true;
          let fetchInFlight = false;
          let lastScreenLockReported = false;

           // 只把最近 48 小时的远端活动交给 coordinator；设备/路线资格仍由 11-shell 最终门控。
           const preloadCoordinator = typeof createRemoteSessionPreloadCoordinator === 'function'
             && typeof collectRecentRemoteSessions === 'function'
             ? createRemoteSessionPreloadCoordinator({
               findFrame: (deviceId) => findControlledFrameByDeviceId(deviceId),
               requestDevicePreload: (orderedDeviceIds) => dispatchPreloadDevices(orderedDeviceIds),
                onPerformance: (diag) => {
                  if (!diag || typeof reportClientEvent !== 'function') return;
                  reportClientEvent(diag.event, diag.deviceId || '', {
                    sessionId: diag.sessionId || '', requestId: diag.requestId || '', foregroundId: diag.foregroundId || '', stage: diag.stage || '', result: diag.result || '',
                    elapsedMs: diag.elapsedMs, syncMs: diag.syncMs, backendMs: diag.backendMs, pageMs: diag.pageMs,
                    installMs: diag.installMs, recordCount: diag.recordCount, cacheHit: diag.cacheHit,
                    clientReady: diag.clientReady, generation: diag.generation, queueLength: diag.queueLength,
                  });
                },
               onDiagnostic: (diag) => {
                 if (!diag || typeof reportClientEvent !== 'function') return;
                 reportClientEvent('session-preload', diag.deviceId || '', {
                    requestId: diag.requestId || '', stage: diag.stage || '', attempt: diag.attempt,
                   sessionId: diag.sessionId || '',
                   result: diag.result || '',
                   reason: diag.reason || '',
                   elapsedMs: diag.elapsedMs,
                 });
               },
             })
             : null;
           if (preloadCoordinator) remoteSessionPreloadCoordinator = preloadCoordinator;
           const refreshRecentPreloadPlan = () => {
             if (!preloadCoordinator) return;
             // 锁屏时暂停预加载计划更新，避免后台继续触发远端同步。
             if (typeof window !== 'undefined' && window.__dshAuSystemLocked === true) return;
             const isDesktopLocal = resolveCurrentAccessRoute([], window.location.href).transport === 'local'
               && !isMobileTopbarViewport(window.innerWidth, window);
             if (!isDesktopLocal) {
               preloadCoordinator.updatePlan([]);
               return;
             }
             const deviceById = new Map(store.devices.map((device) => [device?.id, device]));
             const merged = mergeRemoteWorkspaces(
               store.serverWorkspaces,
               store.controlledSnapshots,
               store.devices,
               store.hiddenKeys,
             );
             const planInput = merged.visible.map((workspace) => {
               const device = deviceById.get(workspace.deviceId);
               const route = device?.selectedRoute;
               const hasPreservedFrame = Boolean(findControlledFrameByDeviceId(workspace.deviceId)?.contentWindow);
               const routeReady = Boolean(device
                 && device.online !== false
                 && device.status !== 'offline'
                 && device.status !== 'needs_auth'
                 && route?.probeCompleted === true
                 && route.status !== 'unknown'
                 && isRouteReady(route));
               // 已挂载保活的受控 iframe 在探测瞬时抖动（frame-preserved）期间不清空已预热会话计划，避免隧道偶发超时触发 prune 释放缓存。
               const online = routeReady || (hasPreservedFrame && device?.status !== 'needs_auth');
               return {
                 ...workspace,
                 online,
                 deviceStatus: online && (device?.status === 'offline' || device?.status === 'unknown') ? 'idle' : (device?.status || ''),
               };
             });
             const plan = collectRecentRemoteSessions(planInput, {
               localDeviceId: store.localDeviceId || window.__dshAuLastStateSnap?.self?.deviceId || '',
             });
             preloadCoordinator.updatePlan(Array.isArray(plan) ? plan : []);
           };
           store.listeners.add(refreshRecentPreloadPlan);
           refreshRecentPreloadPlan();

          // 应用服务端待办与工作区状态到 store.serverWorkspaces
          const applyServerTodoStateData = (data) => {
            if (!alive || !data || data.ok === false) return;
            store.localDeviceId = data.localDeviceId || data.self?.deviceId || store.localDeviceId || '';
            store.serverWorkspaces = normalizeServerRemoteWorkspaces(data, store.devices);
            reconcileConfirmedSessionsWithServer(typeof document !== 'undefined' ? document : null);
            autoConfirmActiveRemoteSession(typeof document !== 'undefined' ? document : null);
            notifyStoreListeners();
          };

          // 通道 A：拉取 `/dsh-au-todo/api` `{ action: 'getState' }`
          const fetchServerRemoteWorkspaces = async () => {
            if (!alive || fetchInFlight) return;
            fetchInFlight = true;
            try {
              let data = null;
              if (typeof window !== 'undefined' && window.__dshAuTodoGetStateInFlight) {
                // 复用并发中的 getState Promise，避免重复发起请求
                data = await window.__dshAuTodoGetStateInFlight.catch(() => null);
              } else {
                const response = await fetch('/dsh-au-todo/api', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ action: 'getState' }),
                });
                data = await response.json().catch(() => null);
                if (data && data.ok !== false && typeof window !== 'undefined') {
                  window.__dshAuLastTodoStateData = data;
                  if (typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
                    window.dispatchEvent(new CustomEvent('dsh-au:todo-state-data', { detail: data }));
                  }
                }
              }
              applyServerTodoStateData(data);
            } catch {} finally {
              fetchInFlight = false;
            }
          };

          // 向已挂载的受控远端 iframe 请求实时工作区快照
          const requestControlledSnapshots = () => {
            if (typeof document === 'undefined' || !document.querySelectorAll) return;
            const frames = document.querySelectorAll('.dsh-au-stage iframe[name^="dsh-au-controlled:"], iframe[name^="dsh-au-controlled:"]');
            for (const frame of frames) {
              try {
                frame.contentWindow?.postMessage({
                  source: 'dsh-au',
                  type: 'dsh-au:request-workspaces-snapshot',
                }, '*');
              } catch {}
            }
          };

          // 监听当前激活设备与在线设备列表变化
          let lastDevicesSig = '';
          const onActiveDeviceChange = (event) => {
            const nextActiveId = event?.detail?.activeId || null;
            const nextDevices = Array.isArray(event?.detail?.devices) ? event.detail.devices : store.devices;
            const prevActiveId = store.activeDeviceId;
            if (prevActiveId && prevActiveId !== nextActiveId) cancelRemoteNavigation(prevActiveId);
            store.activeDeviceId = nextActiveId;
             if (prevActiveId !== nextActiveId && (!nextActiveId || nextActiveId === 'local')) {
               remoteSessionPreloadCoordinator?.notifyForeground('', '');
               const localSid = readNativeSelectedSessionId(ctx);
               if (localSid) scrollSidebarToSession(localSid, { isLocal: true });
             } else if (prevActiveId !== nextActiveId) {
               const targetRemoteSid = store.selectedSessionByDevice.get(nextActiveId)
                 || store.controlledSnapshots.get(nextActiveId)?.currentSessionId
                 || '';
               remoteSessionPreloadCoordinator?.notifyForeground(
                 nextActiveId,
                 targetRemoteSid,
               );
               if (targetRemoteSid) scrollSidebarToSession(targetRemoteSid, { isLocal: false, deviceId: nextActiveId });
             }
            const resumedNavigation = store.latestNavigationByDevice.get(nextActiveId);
            if (resumedNavigation?.cancelled) resumedNavigation.cancelled = false;
            store.devices = nextDevices;
            notifyStoreListeners();
            const sig = `${nextActiveId || 'local'}::${nextDevices.map((d) => `${d?.id}:${d?.name}`).join('|')}`;
            if (sig !== lastDevicesSig || prevActiveId !== nextActiveId) {
              lastDevicesSig = sig;
              void fetchServerRemoteWorkspaces();
              requestControlledSnapshots();
            }
          };

          // 通道 B：监听受控远端 iframe 推送的实时工作区快照、frame-ready 与指令 ack
          const onMessage = (event) => {
            const data = event?.data;
             try { preloadCoordinator?.handleMessage(event); } catch {}
            if (!data || (data.source !== 'dsh-au' && data.source !== 'dsh-au-todo')) return;
            if (data.source === 'dsh-au-todo' && data.type === 'dsh-au-todo:remote-sessions-meta') {
              const devId = resolveDeviceIdFromMessageSource(event.source, data.deviceId || '');
              if (devId) store.warmDevices?.add?.(devId);
              return;
            }
            if (data.type === 'remote-session-confirmed') {
              const devId = resolveDeviceIdFromMessageSource(event.source, data.deviceId || '');
              if (devId) {
                store.warmDevices?.add?.(devId);
                if (store.latestNavigationByDevice.get(devId)?.pending) return;
                acknowledgeRemoteCommand(devId);
                dispatchStageTransition({ active: false, deviceId: devId });
                const confirmedSid = (typeof data.sessionId === 'string' && data.sessionId.trim())
                  || store.selectedSessionByDevice.get(devId)
                  || store.controlledSnapshots.get(devId)?.currentSessionId
                  || '';
                if (confirmedSid) {
                  confirmRemoteSessionOptimistically(devId, confirmedSid, {
                    sendRpc: data.endSeq === undefined,
                    ...(data.endSeq !== undefined ? { expectedEndSeq: data.endSeq } : {}),
                  });
                }
              }
              return;
            }
            if (data.type === 'dsh-au:remote-command-ack') {
              const devId = resolveDeviceIdFromMessageSource(event.source, data.deviceId || '');
              if (devId) store.warmDevices?.add?.(devId);
              if ((data.sessionId || data.navigationCommandId || Number.isSafeInteger(data.selectionSeq)) && !isCurrentRemoteNavigation(devId, data)) return;
              if (data.result === 'superseded' || data.result === 'cancelled') return;
              if (typeof data.sessionId === 'string' && data.sessionId && devId) {
                const prevSid = store.selectedSessionByDevice.get(devId);
                store.selectedSessionByDevice.set(devId, data.sessionId);
                store.activeInteractedSessions.add(data.sessionId);
                notifyStoreListeners();
                if (prevSid !== data.sessionId && store.activeDeviceId && (store.activeDeviceId === devId || resolvePreferredRemoteApiTargetId(store.activeDeviceId) === resolvePreferredRemoteApiTargetId(devId))) {
                  scrollSidebarToSession(data.sessionId, { isLocal: false, deviceId: devId });
                }
              }
              if (data.stage === 'received') {
                acknowledgeRemoteCommand(devId, data.commandId, { stage: 'received' });
              } else if (!data.stage || data.stage === 'done') {
                acknowledgeRemoteCommand(devId, data.commandId);
                const latest = store.latestNavigationByDevice.get(devId);
                if (latest?.commandId === data.commandId) latest.pending = false;
                dispatchStageTransition({ active: false, deviceId: devId, commandId: data.commandId });
                const createFallback = pendingCreateFallbacks.get(data.commandId);
                if (createFallback) {
                  pendingCreateFallbacks.delete(data.commandId);
                  if (data.result === 'open-failed' || data.result === 'not-ready') {
                    void createFallback();
                  }
                }
              }
              return;
            }
            if (data.type === 'frame-ready') {
              const devId = resolveDeviceIdFromMessageSource(event.source, data.deviceId || '');
              if (devId) {
                store.warmDevices?.add?.(devId);
                flushPendingRemoteCommands(devId, event.source);
                try {
                  event.source?.postMessage({ source: 'dsh-au', type: 'dsh-au:request-workspaces-snapshot' }, '*');
                } catch {}
              }
              return;
            }
            if (data.type === 'dsh-au:controlled-workspaces-snapshot') {
              const devId = resolveDeviceIdFromMessageSource(event.source, data.deviceId || '');
              if (!devId) return;
              const latest = store.latestNavigationByDevice.get(devId);
              const hasNavigationMetadata = Boolean(data.navigationCommandId || Number.isSafeInteger(data.selectionSeq));
              const cancelledLiveSnapshot = latest?.cancelled && data.selectionSeq === latest.selectionSeq && !data.navigationCommandId;
              if (hasNavigationMetadata && !isCurrentRemoteNavigation(devId, data) && !cancelledLiveSnapshot) return;
              // 已有明确用户意图后，无标签旧端快照只补内容，不能再次改变选中项。
              const maySelect = !latest?.cancelled && (!latest || hasNavigationMetadata);
              store.warmDevices?.add?.(devId);
              if (maySelect) dispatchStageTransition({ active: false, deviceId: devId, commandId: data.navigationCommandId });
              const incomingWorkspaces = Array.isArray(data.workspaces) ? data.workspaces : [];
              const prevSnap = store.controlledSnapshots.get(devId);
              const now = Date.now();
              // 若 15 秒内刚乐观插入了「新对话」空白会话而受控端快照尚未包含，保留该乐观空白会话防止闪烁
              if (prevSnap && Array.isArray(prevSnap.workspaces)) {
                for (const prevWs of prevSnap.workspaces) {
                  for (const prevSess of Array.isArray(prevWs?.sessions) ? prevWs.sessions : []) {
                    if (prevSess?.blank && now - Number(prevSess.updatedAt || 0) < 15000) {
                      const matchedIncoming = incomingWorkspaces.find((w) =>
                        (w.workspaceId && prevWs.workspaceId && w.workspaceId === prevWs.workspaceId)
                        || (w.path && prevWs.path && normalizeWorkspacePathKey(w.path) === normalizeWorkspacePathKey(prevWs.path))
                        || (w.title && prevWs.title && normalizeWorkspaceTitle(w.title, w.path) === normalizeWorkspaceTitle(prevWs.title, prevWs.path))
                      );
                      if (matchedIncoming) {
                        const list = Array.isArray(matchedIncoming.sessions) ? matchedIncoming.sessions : [];
                        if (!list.some((s) => s?.sessionId === prevSess.sessionId || s?.blank)) {
                          matchedIncoming.sessions = [prevSess, ...list];
                        }
                      } else {
                        incomingWorkspaces.unshift({ ...prevWs, sessions: [prevSess] });
                      }
                    }
                  }
                }
              }
              store.controlledSnapshots.set(devId, {
                workspaces: incomingWorkspaces,
                currentSessionId: maySelect && typeof data.currentSessionId === 'string' ? data.currentSessionId : (prevSnap?.currentSessionId || ''),
                updatedAt: now,
                fromControlledFrame: true,
              });
              if (maySelect && typeof data.currentSessionId === 'string' && data.currentSessionId) {
                const prevSid = store.selectedSessionByDevice.get(devId);
                store.selectedSessionByDevice.set(devId, data.currentSessionId);
                if (store.activeDeviceId && (store.activeDeviceId === devId || resolvePreferredRemoteApiTargetId(store.activeDeviceId) === resolvePreferredRemoteApiTargetId(devId))) {
                  store.activeInteractedSessions.add(data.currentSessionId);
                  if (prevSid !== data.currentSessionId) {
                    scrollSidebarToSession(data.currentSessionId, { isLocal: false, deviceId: devId });
                  }
                }
              }
              reconcileConfirmedSessionsWithServer(typeof document !== 'undefined' ? document : null);
              autoConfirmActiveRemoteSession(typeof document !== 'undefined' ? document : null);
              flushPendingRemoteCommands(devId, event.source, typeof document !== 'undefined' ? document : null, { fromSnapshot: true });
              notifyStoreListeners();
            }
          };

          // 当用户点击右侧受控远端 iframe（例如点击对话输入框）时，外层 window 触发 blur 且 document.activeElement 变为该受控 iframe（此时 document.hasFocus() 仍为 true）；
          // 若用户切到其他系统窗口（document.hasFocus() === false），则不在 blur 时误灭灯，等用户切回窗口触发 focus 时再自动确认。
          const onWindowBlurOrFocus = () => {
            if (typeof document === 'undefined') return;
            if (typeof document.hasFocus === 'function' && document.hasFocus() === false) return;
            const activeEl = document.activeElement;
            if (
              activeEl
              && String(activeEl.tagName || '').toUpperCase() === 'IFRAME'
              && String(activeEl.getAttribute?.('name') || activeEl.name || '').startsWith('dsh-au-controlled:')
            ) {
              const rawName = String(activeEl.getAttribute?.('name') || activeEl.name || '');
              const frameDevId = rawName.slice('dsh-au-controlled:'.length).trim();
              const devId = resolveDeviceIdFromMessageSource(activeEl.contentWindow, frameDevId) || frameDevId || store.activeDeviceId || '';
              const sid = store.selectedSessionByDevice.get(devId)
                || (frameDevId && store.selectedSessionByDevice.get(frameDevId))
                || store.controlledSnapshots.get(devId)?.currentSessionId
                || '';
              if (devId && sid) {
                confirmRemoteSessionOptimistically(devId, sid, { sendRpc: true, doc: document });
              }
            }
            autoConfirmActiveRemoteSession(document);
          };

          // 捕获阶段监听左侧栏点击与悬停：
          // 1) 鼠标悬停在远端工作区或远端会话行上时，立即触发目标设备受控 iframe 预热；
          // 2) 当处于远端舞台激活态时，点击原生本地工作区/会话/搜索结果/新建对话立即切回本机。
          const hoverPreloadedDevices = new Set();
          const onSidebarPointerOver = (event) => {
            const target = event?.target;
            if (!target || typeof target.closest !== 'function') return;
            const wsRow = target.closest('[data-row-key^="workspace:dsh-au-remote-ws:"]');
            if (wsRow && typeof wsRow.getAttribute === 'function') {
              const rawKey = wsRow.getAttribute('data-row-key') || '';
              const nativeWsId = rawKey.startsWith('workspace:') ? rawKey.slice('workspace:'.length) : '';
              const parsed = parseNativeRemoteWorkspaceId(nativeWsId);
              if (parsed?.deviceId && !hoverPreloadedDevices.has(parsed.deviceId)) {
                hoverPreloadedDevices.add(parsed.deviceId);
                dispatchPreloadDevices([parsed.deviceId]);
              }
              return;
            }
            const sessRow = target.closest('[data-row-key^="session:"]');
            if (sessRow && typeof sessRow.getAttribute === 'function') {
              const rawKey = sessRow.getAttribute('data-row-key') || '';
              const sid = rawKey.startsWith('session:') ? rawKey.slice('session:'.length) : '';
              const remoteEntry = sid ? store.nativeSessionById.get(sid) : null;
              const devId = remoteEntry?.ws?.deviceId || '';
              if (devId && !hoverPreloadedDevices.has(devId)) {
                hoverPreloadedDevices.add(devId);
                dispatchPreloadDevices([devId]);
              }
            }
          };

          const onSidebarCaptureClick = (event) => {
            const target = event?.target;
            if (!shouldSwitchToLocalOnSidebarClick(target, typeof document !== 'undefined' ? document : null)) return;
            const preservePanel = Boolean(target?.closest?.('button[class*="_panelRow"], [class*="_panelRow"], [data-panel-id], [class*="_settingsArea"] button, button[class*="_settings"], a[href]'));
            cancelRemoteNavigation(store.activeDeviceId);
            store.createSessionSeq = (Number(store.createSessionSeq) || 0) + 1;
            store.activeDeviceId = null;
            pruneActiveInteractedSessions('');
            notifyStoreListeners();
            if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
              // 侧栏捕获点击切回本机，标记来源便于和自动切回区分；点击面板项时保留宿主即将切换的面板。
              window.dispatchEvent(new CustomEvent(DEVICE_SELECT_EVENT, { detail: { deviceId: 'local', reason: 'sidebar-click', preservePanel } }));
            }
          };

          // 维护挂载点，仅在无 shell.overlay Portal 环境下才回退 ReactDOM.render，防止 Portal 与 legacy render 并发双渲染造成重复项
          let legacyMountedNode = null;
          const syncLegacyMount = () => {
            const node = ensureRemoteWorkspacesMountNode();
            if (node && !hasOverlaySlot && !overlaySlotMounted && typeof ReactDOM.render === 'function') {
              legacyMountedNode = node;
              try { ReactDOM.render(h(RemoteWorkspacesTree), node); } catch {}
            }
            if (store.nativeBridgeInstalled) {
              decorateNativeRemoteRows();
            } else {
              syncWorkspaceListFlexOrder(ctx);
            }
          };
          store.listeners.add(syncLegacyMount);
          syncLegacyMount();

          const uiWorkspace = ctx?.get?.('uiWorkspace') || ctx?.uiWorkspace;
          const workspacesSvc = ctx?.get?.('workspaces') || ctx?.workspaces || uiWorkspace?.workspaces;
          const sessionsSvc = ctx?.get?.('sessions') || ctx?.sessions || uiWorkspace?.sessions;
          const unsubLocalWs = typeof workspacesSvc?.list?.subscribe === 'function'
            ? workspacesSvc.list.subscribe(() => {
                if (store.nativeBridgeInstalled) decorateNativeRemoteRows();
                else syncWorkspaceListFlexOrder(ctx);
              })
            : null;
          const unsubLocalSessions = typeof sessionsSvc?.list?.subscribe === 'function'
            ? sessionsSvc.list.subscribe(() => {
                if (store.nativeBridgeInstalled) decorateNativeRemoteRows();
                else syncWorkspaceListFlexOrder(ctx);
              })
            : null;

          const observer = typeof MutationObserver !== 'undefined' && typeof document !== 'undefined' && document.body
            ? new MutationObserver(() => {
                ensureRemoteWorkspacesMountNode();
                syncLegacyMount();
                decorateWorkspacePickerMenu(document);
              })
            : null;
          observer?.observe(document.body, { childList: true, subtree: true });

          // 初始若已有 14-todo 抓取好的缓存，先行应用
          if (typeof window !== 'undefined' && window.__dshAuLastTodoStateData) {
            applyServerTodoStateData(window.__dshAuLastTodoStateData);
          }

          const computeRemoteDevicesDigest = () => {
            const remotes = typeof window !== 'undefined' ? window.__dshAuLastStateSnap?.remotes : null;
            if (!Array.isArray(remotes)) return '';
            return remotes.map((r) => `${r?.id || r?.deviceId || ''}:${Boolean(r?.online)}:${r?.statusV2 || r?.status || ''}:${JSON.stringify(r?.sessionStatesV2 || {})}`).join('|');
          };
          const checkHasOnlineRemotes = () => {
            const remotes = typeof window !== 'undefined' ? window.__dshAuLastStateSnap?.remotes : null;
            return Array.isArray(remotes) && remotes.some((r) => r && r.online !== false);
          };
          let lastRemoteWorkspacesDigest = computeRemoteDevicesDigest();

          void fetchServerRemoteWorkspaces();
          requestControlledSnapshots();
          const pollTimer = window.setInterval(() => {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            if (typeof window !== 'undefined' && window.__dshAuSystemLocked === true) {
              if (!lastScreenLockReported) {
                // eslint-disable-next-line no-console
                console.info('[dsh-au] remote sync skipped: screen is locked');
                lastScreenLockReported = true;
              }
              return;
            }
            if (lastScreenLockReported) {
              // eslint-disable-next-line no-console
              console.info('[dsh-au] remote sync resumed after screen unlock');
              lastScreenLockReported = false;
            }
            const currentDigest = computeRemoteDevicesDigest();
            const hasOnlineRemotes = checkHasOnlineRemotes();
            // 节流优化：若初始工作区已获取成功，且远端设备指纹未发生变化（或根本无在线远端设备），跳过重复的磁盘扫描
            const shouldSkipFetch = store.serverWorkspaces.length > 0
              && (!hasOnlineRemotes || (lastRemoteWorkspacesDigest && currentDigest === lastRemoteWorkspacesDigest));
            if (!shouldSkipFetch) {
              lastRemoteWorkspacesDigest = currentDigest;
              void fetchServerRemoteWorkspaces();
            }
            requestControlledSnapshots();
          }, POLL_INTERVAL_MS);

          const onSelfState = () => {
            if (typeof window !== 'undefined' && window.__dshAuSystemLocked === true) return;
            reconcileConfirmedSessionsWithServer(typeof document !== 'undefined' ? document : null);
            const currentDigest = computeRemoteDevicesDigest();
            const hasOnlineRemotes = checkHasOnlineRemotes();
            if (hasOnlineRemotes && currentDigest !== lastRemoteWorkspacesDigest) {
              lastRemoteWorkspacesDigest = currentDigest;
              void fetchServerRemoteWorkspaces();
            }
          };

          const onTodoStateData = (event) => {
            const data = event?.detail;
            if (data) {
              applyServerTodoStateData(data);
            }
          };
          const onActiveExtStageChange = (event) => {
            store.activeExtStage = event?.detail?.activeExtStage || null;
            notifyStoreListeners();
          };
          const onSidebarExtMounted = () => {
            if (typeof document !== 'undefined') {
              decorateSidebarDeviceGroups(document);
            }
          };
          window.addEventListener('dsh-au:active-device-change', onActiveDeviceChange);
          window.addEventListener('dsh-au:active-ext-stage-change', onActiveExtStageChange);
          window.addEventListener('dsh-au:sidebar-ext-mounted', onSidebarExtMounted);
          window.addEventListener('dsh-au:refresh-state', fetchServerRemoteWorkspaces);
          window.addEventListener('dsh-au:self-state', onSelfState);
          window.addEventListener('dsh-au:todo-state-data', onTodoStateData);
          const onMobileNewSession = (event) => {
            const activeDevId = store.activeDeviceId;
            if (!activeDevId || activeDevId === 'local') return;
            const merged = rebuildNativeRemoteRegistry();
            const selectedWsKey = store.selectedWorkspaceByDevice.get(activeDevId) || '';
            const targetWs = merged.visible.find((w) => w?.deviceId === activeDevId && (!selectedWsKey || w.key === selectedWsKey))
              || merged.visible.find((w) => w?.deviceId === activeDevId)
              || null;
            if (targetWs) {
              event?.preventDefault?.();
              activateRemoteWorkspace(targetWs, { createNew: true });
            }
          };
          window.addEventListener('dsh-au:mobile-new-session', onMobileNewSession);
          const onRemoteFrameLoaded = (event) => {
             const deviceId = String(event?.detail?.deviceId || '').trim();
             if (!deviceId || !preloadCoordinator) return;
             const frame = findControlledFrameByDeviceId(deviceId);
             if (!frame?.contentWindow) return;
             preloadCoordinator.handleMessage({
               source: frame.contentWindow,
               data: { source: 'dsh-au', type: 'frame-loaded', deviceId },
             });
           };
           window.addEventListener('dsh-au:remote-frame-loaded', onRemoteFrameLoaded);
           window.addEventListener('message', onMessage);
          window.addEventListener('blur', onWindowBlurOrFocus);
          window.addEventListener('focus', onWindowBlurOrFocus);
          if (typeof document !== 'undefined') {
            document.addEventListener('pointerover', onSidebarPointerOver, true);
            document.addEventListener('click', onSidebarCaptureClick, true);
          }

          return () => {
            alive = false;
            store.listeners.delete(syncLegacyMount);
             store.listeners.delete(refreshRecentPreloadPlan);
             if (remoteSessionPreloadCoordinator === preloadCoordinator) remoteSessionPreloadCoordinator = null;
             try { preloadCoordinator?.dispose(); } catch {}
            try { disposeNativeBridge?.(); } catch {}
            try { unsubLocalWs?.(); } catch {}
            try { unsubLocalSessions?.(); } catch {}
            observer?.disconnect();
            window.clearInterval(pollTimer);
            window.removeEventListener('dsh-au:active-device-change', onActiveDeviceChange);
            window.removeEventListener('dsh-au:active-ext-stage-change', onActiveExtStageChange);
            window.removeEventListener('dsh-au:sidebar-ext-mounted', onSidebarExtMounted);
            window.removeEventListener('dsh-au:refresh-state', fetchServerRemoteWorkspaces);
            window.removeEventListener('dsh-au:self-state', onSelfState);
            window.removeEventListener('dsh-au:todo-state-data', onTodoStateData);
            window.removeEventListener('dsh-au:mobile-new-session', onMobileNewSession);
            window.removeEventListener('dsh-au:remote-frame-loaded', onRemoteFrameLoaded);
             window.removeEventListener('message', onMessage);
            window.removeEventListener('blur', onWindowBlurOrFocus);
            window.removeEventListener('focus', onWindowBlurOrFocus);
            if (typeof document !== 'undefined') {
              document.removeEventListener('pointerover', onSidebarPointerOver, true);
              document.removeEventListener('click', onSidebarCaptureClick, true);
            }
            if (legacyMountedNode && typeof ReactDOM.unmountComponentAtNode === 'function') {
              try { ReactDOM.unmountComponentAtNode(legacyMountedNode); } catch {}
            }
          };
        }, 'dsh-au: remote workspaces controller');

        if (ctx?.slots?.inject) {
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register(
              {
                name: 'shell.overlay',
                id: 'dsh-au-remote-workspaces',
                order: 45,
              },
              RemoteWorkspacesOverlay
            )
          );
        }
      }

      return {
        apply,
        helpers: {
          HIDDEN_STORAGE_KEY,
          EXPANDED_STORAGE_KEY,
          MOUNT_CLASS,
          MOUNT_ATTR,
          NATIVE_REMOTE_WS_PREFIX,
          STAGE_TRANSITION_EVENT,
          PRELOAD_DEVICE_EVENT,
          dispatchStageTransition,
          dispatchPreloadDevices,
          toNativeRemoteWorkspaceId,
          isNativeRemoteWorkspaceId,
          parseNativeRemoteWorkspaceId,
          makeWorkspaceKey,
          readHiddenRemoteWorkspaces,
          writeHiddenRemoteWorkspaces,
          hideRemoteWorkspace,
          restoreAllHiddenRemoteWorkspaces,
          formatCompactRelativeTime,
          computeWorkspaceAggregateStatus,
          normalizeServerRemoteWorkspaces,
          mergeRemoteWorkspaces,
          resolveDeviceIdFromMessageSource,
          findControlledFrameByDeviceId,
          hasLiveControlledSnapshot,
          clearOptimisticBlankSessions,
          removeSpecificOptimisticSession,
          pruneActiveInteractedSessions,
          wasSessionRecentlyActive,
          resolveStabilizedSessionSortTs,
          computeStabilizedWorkspaceSortTs,
          markControlledSessionConfirmed,
          syncControlledSessionsWithBackendState,
          sanitizeTextForSync,
          sendOrQueueRemoteCommand,
          flushPendingRemoteCommands,
          acknowledgeRemoteCommand,
          findNativeWorkspaceTreeContainer,
          ensureRemoteWorkspacesMountNode,
          syncWorkspaceListFlexOrder,
          shouldSwitchToLocalOnSidebarClick,
          extractControlledWorkspacesSnapshot,
          postControlledWorkspacesSnapshot,
          ensureControlledFrameStyle,
          injectOptimisticRemoteSession,
          rememberResolvedRemoteWorkspaceId,
          resolveEffectiveRemoteWorkspaceId,
          resolvePreferredRemoteApiTargetId,
          mapTransportToBadgeLabel,
          resolveDeviceConnectionTransport,
          createRemoteBlankSession,
          activateRemoteWorkspace,
          confirmRemoteSessionOptimistically,
          autoConfirmActiveRemoteSession,
          reconcileConfirmedSessionsWithServer,
          activateRemoteSession,
          syncExternalRemoteSelection,
          scrollSidebarToSession,
          notifyStoreListeners,
          rebuildNativeRemoteRegistry,
          executeRemoteEntityActionOnPeer,
          decorateNativeRemoteRows,
          decorateSidebarDeviceGroups,
          decorateWorkspacePickerMenu,
          groupCombinedWorkspacesByDevice,
          readCollapsedDeviceGroups,
          writeCollapsedDeviceGroups,
          toggleDeviceGroupCollapsed,
          expandDeviceGroup,
          scrollSidebarToTop,
          installNativeWorkspaceBridge,
          RemoteWorkspacesTree,
          store,
        },
      };
    })();
