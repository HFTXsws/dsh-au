    'use strict';
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef, useMemo } = React;

    // 在模块加载最早期清理因误触拖拽锁死的 manual 会话顺序（dsh.workspace.view.v5），确保宿主 createWorkspaceViewStore 初始化即采用 updated 按最新时间排序
    try {
      if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
        const rawView = localStorage.getItem('dsh.workspace.view.v5');
        if (rawView && rawView.includes('"manual"')) {
          const parsedView = JSON.parse(rawView);
          if (parsedView && typeof parsedView === 'object') {
            if (parsedView.orderBy === 'manual') {
              parsedView.orderBy = 'updated';
              parsedView.sessionOrderByAccount = {};
            }
            if (parsedView.state && typeof parsedView.state === 'object' && parsedView.state.orderBy === 'manual') {
              parsedView.state.orderBy = 'updated';
              parsedView.state.sessionOrderByAccount = {};
            }
            localStorage.setItem('dsh.workspace.view.v5', JSON.stringify(parsedView));
          }
        }
      }
    } catch {}

    const PANEL_ID = 'dsh-au';
    const STYLE_ID = 'dsh-au-style';
    const TOP_HOST_ID = 'dsh-au-top-host';
    const STAGE_HOST_ID = 'dsh-au-stage-host';
    const TOPBAR_COLLAPSED_STORAGE_KEY = 'dsh-au.topbar-collapsed';
    const FLOATING_CAPSULE_STORAGE_KEY = 'dsh-au.status-capsule-position';
    const DEFAULT_CAPSULE_POSITION = { top: 16, right: 16 };
    const DEVICE_SWITCH_EVENT = 'dsh-au:switch-device';
    // 对外提供受控设备选择事件；dsh-au-todo 仅传 deviceId，不接触远程 URL 或鉴权信息。
    const DEVICE_SELECT_EVENT = 'dsh-au:select-device';
    const WORKBENCH_SHORTCUT_EVENT = 'dsh-au:open-workbench';
    const CONTROLLED_FRAME_NAME_PREFIX = 'dsh-au-controlled:';
    const CLIENT_APPLY_LOCK = '__dshAuClientApplyActive';
    // 仅用于关联同一浏览器页面的诊断事件，不保存到配置或远端 URL。
    const CLIENT_INSTANCE_ID = globalThis.crypto?.randomUUID?.() || `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // 插件热替换会重建 CLIENT_INSTANCE_ID，但同一页面保留这个 ID；真正导航才换页 ID。
    const DOCUMENT_INSTANCE_ID = window.__dshAuDocumentInstanceId || (window.__dshAuDocumentInstanceId =
      globalThis.crypto?.randomUUID?.() || `page-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const IS_MACOS = typeof navigator !== 'undefined'
      && /Mac/i.test(`${navigator.platform || ''} ${navigator.userAgent || ''}`);
    // 仅 DSH 自身侧栏折叠时避开 macOS 左上角红绿灯，dsh-au 胶囊状态不参与判断。
    const MACOS_SIDEBAR_COLLAPSED_LEADING_INSET = 180;
    let controlledClientCtx = null;
    let controlledFullAccessByDefault = false;

    async function syncControlledHostDefaultPreset(enabled, ctx = controlledClientCtx) {
      const targetPreset = enabled ? 'danger-full-access' : 'workspace-write';
      let remoteSettings = null;
      try {
        remoteSettings = ctx?.get?.('remote')?.settings || ctx?.remote?.settings || null;
      } catch {
        remoteSettings = null;
      }
      if (remoteSettings && typeof remoteSettings.mutate === 'function') {
        try {
          await remoteSettings.mutate('permission', [
            { op: 'set', path: ['defaultPreset'], value: targetPreset },
          ]);
        } catch {}
      }
    }

    async function ensureControlledSessionFullAccess(sessionId, ctx = controlledClientCtx) {
      if (!controlledFullAccessByDefault || !sessionId) return;
      const sessionsSvc = ctx?.get?.('sessions') || ctx?.sessions;
      const tryApply = async () => {
        const live = sessionsSvc?.binding?.(sessionId)?.session;
        if (live && typeof live.command === 'function') {
          try {
            await live.command('/permission danger-full-access');
            return true;
          } catch {}
        }
        return false;
      };
      if (await tryApply()) return;
      for (const delay of [120, 350, 800]) {
        await new Promise((r) => setTimeout(r, delay));
        if (await tryApply()) return;
      }
    }

    /** 仅控制端创建的远程 iframe 带此前缀，避免普通嵌入页误隐藏本机插件。 */
    function isControlledFrame() {
      return typeof window !== 'undefined' && window.name.startsWith(CONTROLLED_FRAME_NAME_PREFIX);
    }

    /** 桌面壳是 Electron。它的主窗口不能整页换成远程网址，否则壳等不到自己的界面。 */
    function isElectronShell() {
      const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
      return /Electron/i.test(String(ua || ''));
    }

    /** 所有快捷键入口先汇入当前窗口事件；键盘切换不应改变设备栏的折叠偏好。 */
    function dispatchDeviceSwitch(direction, preserveTopbar = true) {
      window.dispatchEvent(new CustomEvent(DEVICE_SWITCH_EVENT, { detail: { direction, preserveTopbar } }));
    }

    /** 外层页与受控 iframe 采用同一识别规则；绑定来自动作表加浏览器本地覆盖，避免两处快捷键行为漂移。 */
    function getDeviceSwitchShortcutDirection(event) {
      return shortcutDeviceDirection(findShortcutAction(event));
    }

    /** 嵌套预览的 postMessage source 是子窗口，沿 parent 链认回舞台 iframe，不要只比 contentWindow。 */
    function isDeviceSwitchMessageFromStage(source, frames) {
      let win = source;
      const seen = new Set();
      while (win && !seen.has(win)) {
        seen.add(win);
        try {
          if ([...frames].some((frame) => frame.contentWindow === win)) return true;
        } catch {}
        let parent = null;
        try { parent = win.parent; } catch { break; }
        if (!parent || parent === win) break;
        win = parent;
      }
      return false;
    }

    const CONTROLLED_FRAME_STYLE_ID = 'dsh-au-controlled-frame-style';

    /** 读取原生 mainView 的会话 ID，不读 DOM 侧栏或会话内容。 */
    function readNativeSelectedSessionId(ctx) {
      try {
        const uiWorkspace = ctx?.get?.('uiWorkspace') || ctx?.uiWorkspace;
        const sessions = ctx?.get?.('sessions') || ctx?.sessions || uiWorkspace?.sessions;
        const rows = Object.values(sessions?.list?.getSnapshot?.()?.byId || {});
        const retained = rows.find((row) => (row?.retainedBy?.mainView || 0) > 0);
        if (retained?.id || retained?.sessionId) return retained.id || retained.sessionId;
        const mainViewSid = uiWorkspace?.mainView?.sessionId || ctx?.get?.('layout')?.mainView?.sessionId;
        if (typeof mainViewSid === 'string' && mainViewSid) return mainViewSid;
        return '';
      } catch { return ''; }
    }

    /** 从工作区路径提取末尾目录名作为默认展示标题。 */
    function extractWorkspaceLeafName(rawPath) {
      if (typeof rawPath !== 'string' || !rawPath.trim()) return '';
      const parts = rawPath.trim().replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
      return parts[parts.length - 1] || '';
    }

    /**
     * 受控远端 iframe 注入专属属性与样式：
     * 隐藏远端内部整个侧栏，仅保留外层单侧栏。
     */
    function ensureControlledFrameStyle(doc = typeof document !== 'undefined' ? document : null) {
      if (!doc?.documentElement) return;
      doc.documentElement.setAttribute?.('data-dsh-au-controlled-frame', 'true');
      let style = doc.getElementById?.(CONTROLLED_FRAME_STYLE_ID);
      if (!style && typeof doc.createElement === 'function') {
        style = doc.createElement('style');
        style.id = CONTROLLED_FRAME_STYLE_ID;
        (doc.head || doc.documentElement).appendChild?.(style);
      }
      if (style) {
        style.textContent = `
          html[data-dsh-au-controlled-frame="true"] [class*="_sidebarCol"],
          html[data-dsh-au-controlled-frame="true"] [class*="sidebarCol"],
          html[data-dsh-au-controlled-frame="true"] aside[data-slot="sidebar"],
          html[data-dsh-au-controlled-frame="true"] [data-shell-leading],
          html[data-dsh-au-controlled-frame="true"] [data-slot="shell.leading"],
          html[data-dsh-au-controlled-frame="true"] [data-sidebar-header-controls],
          html[data-dsh-au-controlled-frame="true"] [class*="_handle"][data-side="sidebar"],
          html[data-dsh-au-controlled-frame="true"] .dsh-au-mobile-trigger,
          html[data-dsh-au-controlled-frame="true"] .dsh-au-mobile-backdrop {
            display: none !important;
            width: 0 !important;
            min-width: 0 !important;
            max-width: 0 !important;
          }
          html[data-dsh-au-controlled-frame="true"] [class*="_frame"] {
            --dsh-frame-leading-clearance: 0px !important;
            --dsh-windows-sidebar-width: 0px !important;
          }
          html[data-dsh-au-controlled-frame="true"] [class*="_centerCol"],
          html[data-dsh-au-controlled-frame="true"] [class*="centerCol"] {
            grid-column: 1 / 3 !important;
            border-left: none !important;
            border-radius: 0 !important;
          }
        `;
      }
    }

    /** 规范化工作区路径用于跨分隔符/大小写去重。 */
    function normalizeWorkspacePathKey(rawPath) {
      if (typeof rawPath !== 'string') return '';
      return rawPath.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    }

    /** 清洗字符串中的孤立 UTF-16 代理项（被截断的 Emoji 或终端特殊控制输出），防止跨窗口/跨设备同步失败。 */
    function sanitizeTextForSync(raw) {
      if (typeof raw !== 'string' || !raw) return typeof raw === 'string' ? raw : '';
      let out = '';
      for (let i = 0; i < raw.length; i += 1) {
        const code = raw.charCodeAt(i);
        if (code >= 0xD800 && code <= 0xDBFF) {
          const next = i + 1 < raw.length ? raw.charCodeAt(i + 1) : 0;
          if (next >= 0xDC00 && next <= 0xDFFF) {
            out += raw[i] + raw[i + 1];
            i += 1;
          } else {
            out += '\uFFFD';
          }
        } else if (code >= 0xDC00 && code <= 0xDFFF) {
          out += '\uFFFD';
        } else {
          out += raw[i];
        }
      }
      return out;
    }

    const confirmedControlledSessions = new Map(); // sessionId -> confirmed completion version
    const controlledRecentBusyAt = new Map(); // sessionId -> lastBusyAtMs (legacy peers)
    const controlledSessionStateDetails = new Map(); // latest backend version, never regress on delayed polls
    let controlledBackendStateVersion = 0;
    const controlledNativeTurnFloor = new Map(); // a native busy turn must finish beyond this known version
    let controlledNavigationMetadata = {};

    function readControlledRawStatusMap(ctx) {
      const statusStore = (ctx?.get?.('uiSession') || ctx?.uiSession)?.sessionStatus;
      const getRawSnap = typeof statusStore?.__dshAuOrigGetSnapshot === 'function'
        ? statusStore.__dshAuOrigGetSnapshot
        : (typeof statusStore?.getSnapshot === 'function' ? statusStore.getSnapshot.bind(statusStore) : null);
      return getRawSnap ? getRawSnap() : null;
    }

    function hasControlledStateVersion(state) {
      // -1 is the old-peer sentinel, not a comparable event version.
      return Number.isSafeInteger(state?.stateSeq) && state.stateSeq >= 0
        && Number.isSafeInteger(state?.endSeq) && state.endSeq >= 0 && state.endSeq <= state.stateSeq;
    }

    function readControlledSessionVersion(sid, nativeSt, row = null) {
      let latest = null;
      for (const candidate of [row, nativeSt, controlledSessionStateDetails.get(sid)]) {
        if (!hasControlledStateVersion(candidate)) continue;
        if (!latest || candidate.stateSeq > latest.stateSeq
          || (candidate.stateSeq === latest.stateSeq && Number(candidate.ackedSeq ?? -1) >= Number(latest.ackedSeq ?? -1))) latest = candidate;
      }
      return latest;
    }

    /** Capture the completed turn before opening: a later SDK resolution cannot acknowledge a new turn. */
    function captureControlledSessionCompletion(sid, ctx, expected = {}) {
      const statusMap = readControlledRawStatusMap(ctx);
      const nativeSt = statusMap instanceof Map ? statusMap.get(sid) : statusMap?.[sid];
      const version = readControlledSessionVersion(sid, nativeSt);
      return {
        stateSeq: expected.stateSeq ?? version?.stateSeq,
        endSeq: expected.endSeq ?? version?.endSeq,
        nativeStatus: nativeSt,
        wasActive: nativeSt?.running === true || Boolean(nativeSt?.pendingInteraction),
      };
    }

    /** Confirm only a completed, unchanged turn; neither running nor a newer result may be cleared. */
    function markControlledSessionConfirmed(sessionId, ctx = controlledClientCtx, expected = {}) {
      const cleanSid = typeof sessionId === 'string' ? sessionId.trim() : '';
      if (!cleanSid || expected.wasActive) return false;
      try {
        const statusMap = readControlledRawStatusMap(ctx);
        const prev = statusMap instanceof Map ? statusMap.get(cleanSid) : statusMap?.[cleanSid];
        const version = readControlledSessionVersion(cleanSid, prev);
        if (prev?.running === true || prev?.pendingInteraction) return false;
        const sameNativeEnd = hasControlledStateVersion(prev) && prev.endSeq === expected.endSeq;
        if (Object.prototype.hasOwnProperty.call(expected, 'nativeStatus') && prev !== expected.nativeStatus
          && prev?.completionUnread === true && !sameNativeEnd) return false;
        // stateSeq also includes title/metadata events; only a different end or observed active turn invalidates confirmation.
        if (Number.isSafeInteger(expected.endSeq) && expected.endSeq >= 0
          && (!version || version.endSeq !== expected.endSeq
            || expected.endSeq <= (controlledNativeTurnFloor.get(cleanSid) ?? -1))) return false;
        if (version && /^(busy|running|waiting)$/.test(String(version.status || ''))) return false;
        const next = prev?.completionUnread === true ? { ...prev, completionUnread: false } : prev;
        if (next !== prev) {
          if (statusMap instanceof Map) statusMap.set(cleanSid, next);
          else if (statusMap && typeof statusMap === 'object') statusMap[cleanSid] = next;
        }
        confirmedControlledSessions.set(cleanSid, { stateSeq: version?.stateSeq, endSeq: version?.endSeq });
        if (confirmedControlledSessions.size > 200) confirmedControlledSessions.delete(confirmedControlledSessions.keys().next().value);
        return true;
      } catch { return false; }
    }

    /** New peers reconcile the exact acknowledged endSeq; old peers retain the recent-busy guard. */
    function syncControlledSessionsWithBackendState(sessionStatesV2, ctx = controlledClientCtx, now = Date.now(), sessionStateDetails = null) {
      if (!sessionStatesV2 || typeof sessionStatesV2 !== 'object') return false;
      if (sessionStateDetails && typeof sessionStateDetails === 'object') controlledBackendStateVersion = 1;
      let mutated = false;
      const statusMap = readControlledRawStatusMap(ctx);
      for (const [sid, rawLight] of Object.entries(sessionStatesV2)) {
        if (!sid) continue;
        const nativeSt = statusMap instanceof Map ? statusMap.get(sid) : statusMap?.[sid];
        const detail = sessionStateDetails?.[sid];
        const known = readControlledSessionVersion(sid, nativeSt);
        const versioned = hasControlledStateVersion(detail);
        // A delayed idle poll must not replace a newer running/end version or an ACK at the same version.
        if (versioned && known && (detail.stateSeq < known.stateSeq
          || (detail.stateSeq === known.stateSeq && Number(detail.ackedSeq ?? -1) < Number(known.ackedSeq ?? -1)))) continue;
        if (versioned) {
          const previous = controlledSessionStateDetails.get(sid);
          if (!previous || previous.stateSeq !== detail.stateSeq || previous.endSeq !== detail.endSeq
            || previous.ackedSeq !== detail.ackedSeq || previous.status !== detail.status) {
            controlledSessionStateDetails.set(sid, { ...detail });
            mutated = true;
          }
        }
        const norm = String((versioned ? detail.status : rawLight) || '').trim().toLowerCase();
        if (norm === 'busy' || norm === 'running' || norm === 'waiting' || nativeSt?.running === true || nativeSt?.pendingInteraction) {
          confirmedControlledSessions.delete(sid);
          controlledRecentBusyAt.set(sid, now);
          const floor = versioned ? detail.stateSeq : known?.stateSeq;
          if (Number.isSafeInteger(floor)) controlledNativeTurnFloor.set(sid, Math.max(controlledNativeTurnFloor.get(sid) ?? -1, floor));
          continue;
        }
        if (norm !== 'idle') continue;
        if (versioned) {
          if (!Number.isSafeInteger(detail.ackedSeq) || detail.ackedSeq < detail.endSeq
            || detail.endSeq <= (controlledNativeTurnFloor.get(sid) ?? -1)) continue;
        } else {
          const lastBusy = controlledRecentBusyAt.get(sid) || 0;
          if (lastBusy > 0 && now - lastBusy < 8000) continue;
        }
        if (!confirmedControlledSessions.has(sid) || nativeSt?.completionUnread === true) {
          if (markControlledSessionConfirmed(sid, ctx, versioned ? { endSeq: detail.endSeq, stateSeq: detail.stateSeq } : {})) {
            controlledNativeTurnFloor.delete(sid);
            if (nativeSt?.completionUnread === true) mutated = true;
          }
        }
      }
      return mutated;
    }

    /**
     * 采集受控端实时工作区与会话快照（含 0 会话空工作区与当前选中会话 ID）。
     */
    function extractControlledWorkspacesSnapshot(ctx = controlledClientCtx) {
      const uiWorkspace = ctx?.get?.('uiWorkspace') || ctx?.uiWorkspace;
      const workspacesSvc = ctx?.get?.('workspaces') || ctx?.workspaces || uiWorkspace?.workspaces;
      const sessionsSvc = ctx?.get?.('sessions') || ctx?.sessions || uiWorkspace?.sessions;
      const uiSessionSvc = ctx?.get?.('uiSession') || ctx?.uiSession;
      const statusMap = uiSessionSvc?.sessionStatus?.getSnapshot?.() || null;
      const currentSessionId = readNativeSelectedSessionId(ctx);
      const wsSnap = workspacesSvc?.list?.getSnapshot?.() || {};
      const pinnedSet = new Set(Array.isArray(wsSnap.pinnedSessionIds) ? wsSnap.pinnedSessionIds : []);
      const archivedSet = new Set(Array.isArray(wsSnap.archivedSessionIds) ? wsSnap.archivedSessionIds : []);
      const rawWorkspaces = Array.isArray(wsSnap.items)
        ? wsSnap.items
        : Object.values(wsSnap.byId || {});
      const sessSnap = sessionsSvc?.list?.getSnapshot?.() || {};
      const sessById = (sessSnap.byId && typeof sessSnap.byId === 'object') ? sessSnap.byId : {};
      const projectionsBySession = (sessSnap.projectionsBySession && typeof sessSnap.projectionsBySession === 'object')
        ? sessSnap.projectionsBySession
        : {};
      const rawSessions = Array.isArray(sessSnap.items)
        ? sessSnap.items
        : Object.values(sessById);

      const normalizeTitle = (rawTitle, path = '') => {
        const trimmed = typeof rawTitle === 'string' ? sanitizeTextForSync(rawTitle.trim()) : '';
        if (trimmed === 'default-workspace') return '默认工作区';
        if (trimmed) return trimmed;
        const leaf = sanitizeTextForSync(extractWorkspaceLeafName(path));
        return (!leaf || leaf === 'default-workspace') ? '默认工作区' : leaf;
      };

      const parseEpochMs = (val) => {
        if (typeof val === 'number' && Number.isFinite(val) && val > 0) return val;
        if (typeof val === 'string' && val.trim()) {
          const asNum = Number(val);
          if (Number.isFinite(asNum) && asNum > 0) return asNum;
          const parsed = Date.parse(val);
          if (Number.isFinite(parsed) && parsed > 0) return parsed;
        }
        return 0;
      };

      const readSessionRecord = (row, fallbackPath = '') => {
        if (!row || typeof row !== 'object') return null;
        const sid = row?.sessionId || row?.id;
        const isCurrentActiveBlank = Boolean(row?.blank && currentSessionId && sid === currentSessionId);
        if (typeof sid !== 'string' || !sid || row?.origin === 'subagent' || (row?.blank && !isCurrentActiveBlank) || archivedSet.has(sid)) return null;
        // 过滤外部扩展转接生成的 DSH 原生会话（0000e870- 前缀），除非它是当前正在主舞台打开的会话，
        // 防止其默认 cwd（~/.dsh/profiles/desktop）被提取目录名合成为「desktop」幽灵工作区。
        if (/^(?:0000e870-)/i.test(sid) && sid !== currentSessionId) return null;
        const values = row?.projections?.values || row?.projectionValues || projectionsBySession[sid]?.values || {};
        const pickRealTitle = (val) => {
          if (typeof val !== 'string') return '';
          const trimmed = val.trim();
          const lower = trimmed.toLowerCase();
          if (!trimmed || lower === 'default-workspace' || lower === 'default' || trimmed === '默认工作区') return '';
          return trimmed;
        };
        const rawTitle = pickRealTitle(values.title)
          || pickRealTitle(row?.displayTitle)
          || pickRealTitle(row?.title)
          || (isCurrentActiveBlank ? '新对话' : '未命名对话');
        const title = sanitizeTextForSync(rawTitle);
        const cwd = sanitizeTextForSync(String(row?.cwd || row?.path || values.workingDirectory || fallbackPath || '').trim());
        const nativeSt = statusMap instanceof Map ? statusMap.get(sid) : (statusMap && typeof statusMap === 'object' ? statusMap[sid] : null);
        const pendingKind = String(nativeSt?.pendingInteraction?.kind || row?.pendingInteraction?.kind || '').trim();
        const version = readControlledSessionVersion(sid, nativeSt, row);
        // Reading a retained mainView is not user intent: hidden/preheated frames keep unread completion.
        // A native boolean is authoritative over a stale session-list row from the previous turn.
        const rawCompletionUnread = typeof nativeSt?.completionUnread === 'boolean' ? nativeSt.completionUnread : row?.completionUnread === true;
        const isRunning = typeof nativeSt?.running === 'boolean' ? nativeSt.running : row?.running === true;
        const hasPending = Boolean(pendingKind === 'approval' || pendingKind === 'plan-review' || pendingKind === 'question');
        const promptTs = parseEpochMs(values.sessionListMetadata?.lastPromptAt) || parseEpochMs(row?.lastPromptAt);
        const rawUpdatedTs = parseEpochMs(row?.updatedAt);
        // 闲置历史会话被点击打开时，DSH 底层写入 session/end-seed 会将 row.updatedAt 刷成当前时间；
        // 因此仅在会话处于运行/等待态或缺少 promptTs 时才采纳 row.updatedAt，防止点开旧会话时间变成「刚刚」。
        const updatedAt = (isRunning || hasPending)
          ? Math.max(promptTs, rawUpdatedTs, parseEpochMs(row?.createdAt))
          : (promptTs || rawUpdatedTs || parseEpochMs(row?.createdAt) || (isCurrentActiveBlank ? Date.now() : 0));
        const confirmation = confirmedControlledSessions.get(sid);
        if (isRunning || hasPending || nativeSt?.completionUnread === true
          || (confirmation && version && version.endSeq > (confirmation.endSeq ?? -1))) {
          confirmedControlledSessions.delete(sid);
        }
        if (isRunning || hasPending) {
          controlledRecentBusyAt.set(sid, Date.now());
          if (version) controlledNativeTurnFloor.set(sid, Math.max(controlledNativeTurnFloor.get(sid) ?? -1, version.stateSeq));
        }
        const isConfirmedControlled = confirmedControlledSessions.has(sid);
        const completionUnread = (isConfirmedControlled || isRunning || hasPending) ? false : rawCompletionUnread;
        let status = String(row?.statusV2 || row?.status || values.status || 'idle');
        if (version?.status && (!hasControlledStateVersion(row) || version.stateSeq >= row.stateSeq)) status = String(version.status);
        // Native activity always wins over a stale row error, including mixed-version peers.
        if (hasPending) status = 'waiting';
        else if (isRunning) status = 'running';
        else if (completionUnread && status !== 'error') status = 'done';
        else if (isConfirmedControlled && (status === 'done' || status === 'error')) status = 'idle';
        return {
          sessionId: sid,
          title,
          status,
          updatedAt,
          cwd,
          pinned: pinnedSet.has(sid) || Boolean(row?.pinned),
          pendingInteractionKind: pendingKind || undefined,
          completionUnread: completionUnread || undefined,
          stateSeq: version?.stateSeq,
          endSeq: version?.endSeq,
          ackedSeq: version?.ackedSeq,
          blank: Boolean(row?.blank),
          workspaceId: String(row?.workspaceId || values.workspaceId || '').trim(),
          workspaceTitle: sanitizeTextForSync(String(row?.workspace || values.workspaceTitle || extractWorkspaceLeafName(cwd) || '').trim()),
        };
      };

      const workspaces = [];
      const byId = new Map();
      const byPath = new Map();
      const byTitle = new Map();
      const accountedSessionIds = new Set();

      for (const item of rawWorkspaces) {
        if (!item || typeof item !== 'object') continue;
        const path = typeof item.path === 'string'
          ? item.path.trim()
          : (typeof item.cwd === 'string' ? item.cwd.trim() : '');
        const normPath = normalizeWorkspacePathKey(path);
        const rawTitle = (typeof item.title === 'string' && item.title.trim())
          || (typeof item.name === 'string' && item.name.trim())
          || '';
        const title = normalizeTitle(rawTitle, path);
        const workspaceId = String(item.workspaceId || item.id || path || title || 'default');
        const createdTs = typeof item.createdAt === 'string' ? Date.parse(item.createdAt) : 0;
        let entry = byId.get(workspaceId)
          || (normPath && byPath.get(normPath))
          || (title && byTitle.get(title))
          || null;
        if (!entry) {
          entry = {
            workspaceId,
            title,
            path,
            createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
            updatedAt: Number(item.updatedAt || (Number.isFinite(createdTs) ? createdTs : 0) || 0),
            sessions: [],
          };
          workspaces.push(entry);
        } else {
          if (!entry.path && path) entry.path = path;
          if (!entry.createdAt && typeof item.createdAt === 'string') entry.createdAt = item.createdAt;
          const nextUpdated = Number(item.updatedAt || (Number.isFinite(createdTs) ? createdTs : 0) || 0);
          if (nextUpdated > entry.updatedAt) entry.updatedAt = nextUpdated;
        }
        byId.set(workspaceId, entry);
        if (normPath) byPath.set(normPath, entry);
        if (title) byTitle.set(title, entry);

        const appendSession = (parsed) => {
          if (!parsed) return;
          accountedSessionIds.add(parsed.sessionId);
          if (!entry.sessions.some((existing) => existing.sessionId === parsed.sessionId)) {
            entry.sessions.push({
              sessionId: parsed.sessionId,
              title: parsed.title,
              status: parsed.status,
              updatedAt: parsed.updatedAt,
              cwd: parsed.cwd || entry.path || path,
              pinned: Boolean(parsed.pinned),
              pendingInteractionKind: parsed.pendingInteractionKind,
              completionUnread: parsed.completionUnread,
              stateSeq: parsed.stateSeq,
              endSeq: parsed.endSeq,
              ackedSeq: parsed.ackedSeq,
              blank: Boolean(parsed.blank),
            });
          }
          if (parsed.updatedAt > entry.updatedAt) entry.updatedAt = parsed.updatedAt;
        };

        if (Array.isArray(item.sessions)) {
          for (const s of item.sessions) {
            appendSession(readSessionRecord(s, entry.path || path));
          }
        }
        if (Array.isArray(item.sessionIds)) {
          for (const sid of item.sessionIds) {
            if (typeof sid !== 'string' || !sid || accountedSessionIds.has(sid)) continue;
            appendSession(readSessionRecord(sessById[sid], entry.path || path));
          }
        }
      }

      for (const row of rawSessions) {
        const parsed = readSessionRecord(row, '');
        if (!parsed || accountedSessionIds.has(parsed.sessionId)) continue;
        const {
          sessionId, title, status, updatedAt, cwd,
          pinned, pendingInteractionKind, completionUnread, stateSeq, endSeq, ackedSeq, blank,
          workspaceId: wsId, workspaceTitle: wsTitle,
        } = parsed;
        const normCwd = normalizeWorkspacePathKey(cwd);
        const normWsTitle = normalizeTitle(wsTitle, cwd);

        let target = (wsId && byId.get(wsId))
          || (normCwd && byPath.get(normCwd))
          || (normWsTitle && byTitle.get(normWsTitle))
          || null;
        if (!target) {
          // 当受控端已存在真实注册的工作区（rawWorkspaces.length > 0）时，未匹配到任何已注册工作区的游离会话直接跳过，
          // 严禁按 cwd 兜底新建工作区；仅当 rawWorkspaces.length === 0 时才允许从 rawSessions 兜底创建工作区。
          if (rawWorkspaces.length > 0) continue;
          const fallbackId = wsId || cwd || normWsTitle || 'default';
          const fallbackTitle = normWsTitle;
          target = {
            workspaceId: fallbackId,
            title: fallbackTitle,
            path: cwd,
            createdAt: '',
            updatedAt,
            sessions: [],
          };
          workspaces.push(target);
          byId.set(fallbackId, target);
          if (normCwd) byPath.set(normCwd, target);
          if (fallbackTitle) byTitle.set(fallbackTitle, target);
        }
        if (!target.sessions.some((s) => s.sessionId === sessionId)) {
          target.sessions.push({
            sessionId,
            title,
            status,
            updatedAt,
            cwd: cwd || target.path || '',
            pinned: Boolean(pinned),
            pendingInteractionKind,
            completionUnread,
            stateSeq,
            endSeq,
            ackedSeq,
            blank: Boolean(blank),
          });
        }
        if (updatedAt > target.updatedAt) target.updatedAt = updatedAt;
      }

      for (const ws of workspaces) {
        ws.sessions.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
      }

      return {
        workspaces,
        currentSessionId,
        pinnedSessionIds: [...pinnedSet],
        archivedSessionIds: [...archivedSet],
      };
    }

    /** 向外层父窗口回传受控端工作区与当前会话快照。 */
    function postControlledWorkspacesSnapshot(ctx = controlledClientCtx) {
      try {
        const { workspaces, currentSessionId, pinnedSessionIds, archivedSessionIds } = extractControlledWorkspacesSnapshot(ctx);
        window.parent?.postMessage({
          source: 'dsh-au',
          type: 'dsh-au:controlled-workspaces-snapshot',
          navigationCommandId: controlledNavigationMetadata.commandId,
          selectionSeq: controlledNavigationMetadata.selectionSeq,
          workspaces,
          currentSessionId,
          pinnedSessionIds,
          archivedSessionIds,
          controlledSidebarHidden: true,
        }, '*');
      } catch {}
    }

    /** 受控 iframe 拿到焦点后，将设备切换按键安全转交给外层壳，并响应跨设备工作区与会话控制消息。 */
    function installControlledFrameShortcutBridge() {
      if (isControlledFrame()) {
        ensureControlledFrameStyle();
      }
      let interacted = false;
      const appliedFocusRequests = new Set();
      const appliedRemoteCommands = new Set(); // Non-navigation entity actions retain their own deduplication.
      const navigationCommands = new Map();
      const navigationTimers = new Set();
      let navigationGeneration = 0;
      let latestSelectionSeq = -1;
      let currentNavigation = null;
      let disposed = false;
      const ackRemoteCommand = (commandId, extra = {}) => {
        if (typeof commandId !== 'string' || !commandId) return;
        try {
          window.parent?.postMessage({
            source: 'dsh-au',
            type: 'dsh-au:remote-command-ack',
            commandId,
            ...extra,
          }, '*');
        } catch {}
      };
      const isCurrentNavigation = (navigation) => !disposed && navigation.generation === navigationGeneration && currentNavigation === navigation;
      const acknowledgeNavigation = (navigation) => {
        if (disposed) return;
        ackRemoteCommand(navigation.commandId, {
          navigationCommandId: navigation.commandId,
          selectionSeq: navigation.selectionSeq,
          stage: navigation.stage,
          result: navigation.result,
          ...(navigation.result === 'applied' ? { sessionId: navigation.sessionId } : {}),
        });
      };
      const finishNavigation = (navigation, result, sessionId) => {
        if (!navigation || navigation.stage === 'done') return;
        navigation.stage = 'done';
        navigation.result = result;
        if (result === 'applied') navigation.sessionId = sessionId;
        acknowledgeNavigation(navigation);
      };
      const assertCurrentNavigation = (navigation) => {
        if (!isCurrentNavigation(navigation)) throw new Error('superseded-navigation');
      };
      const awaitNavigation = async (navigation, action) => {
        assertCurrentNavigation(navigation);
        const value = await action();
        assertCurrentNavigation(navigation);
        return value;
      };
      const beginNavigation = (data) => {
        const commandId = typeof data.commandId === 'string' ? data.commandId : '';
        // Primary and Todo compatibility packets are one intent: a retry cannot invalidate itself.
        if (commandId && navigationCommands.has(commandId)) {
          const prevNav = navigationCommands.get(commandId);
          // 若此前因受控端冷启动未就绪返回 not-ready，允许后续重放重新尝试打开。
          if (prevNav?.result !== 'not-ready') {
            acknowledgeNavigation(prevNav);
            return null;
          }
        }
        const selectionSeq = Number.isSafeInteger(data.selectionSeq) && data.selectionSeq >= 0 ? data.selectionSeq : undefined;
        const navigation = { commandId, selectionSeq, stage: 'received' };
        if (commandId) navigationCommands.set(commandId, navigation);
        if (selectionSeq !== undefined && selectionSeq <= latestSelectionSeq) {
          finishNavigation(navigation, 'superseded');
          return null;
        }
        if (selectionSeq !== undefined) latestSelectionSeq = selectionSeq;
        navigationGeneration += 1;
        finishNavigation(currentNavigation, 'superseded');
        navigation.generation = navigationGeneration;
        currentNavigation = navigation;
        controlledNavigationMetadata = navigation;
        interacted = true; // A manual navigation also makes delayed first-entry focus ineligible.
        acknowledgeNavigation(navigation);
        return navigation;
      };
      const scheduleNavigationSnapshot = (navigation, delay) => {
        const id = window.setTimeout(() => {
          navigationTimers.delete(id);
          if (isCurrentNavigation(navigation)) postControlledWorkspacesSnapshot(controlledClientCtx);
        }, delay);
        navigationTimers.add(id);
      };
      const isRealControlledWorkspaceId = (wsId) => {
        if (typeof wsId !== 'string') return false;
        const trimmed = wsId.trim();
        if (!trimmed || trimmed === 'default' || trimmed === 'default-workspace') return false;
        if (trimmed.startsWith('ws:') || trimmed.startsWith('cwd:')) return false;
        return true;
      };
      const findControlledWorkspaceItem = (workspacesSvc, data = {}) => {
        const wsSnap = workspacesSvc?.list?.getSnapshot?.() || {};
        const items = Array.isArray(wsSnap.items) ? wsSnap.items : Object.values(wsSnap.byId || {});
        const normTargetPath = normalizeWorkspacePathKey(data.path || '');
        const normTargetTitle = (data.title === 'default-workspace' || data.title === '默认工作区')
          ? '默认工作区'
          : String(data.title || '').trim();
        return (Array.isArray(items) ? items : []).find((item) => {
          if (!item) return false;
          if (data.workspaceId && item.workspaceId === data.workspaceId) return true;
          const itemPathKey = normalizeWorkspacePathKey(item.path || item.cwd || '');
          if (normTargetPath && itemPathKey && itemPathKey === normTargetPath) return true;
          if (data.fallbackSessionId && Array.isArray(item.sessionIds) && item.sessionIds.includes(data.fallbackSessionId)) return true;
          const itemTitle = (item.title === 'default-workspace' || item.title === '默认工作区')
            ? '默认工作区'
            : String(item.title || item.name || '').trim();
          if (normTargetTitle && itemTitle === normTargetTitle) return true;
          return false;
        }) || null;
      };
      const resolveOrCreateControlledWorkspace = async (ctx, data = {}, isCurrent = () => true) => {
        const uiWorkspace = ctx?.get?.('uiWorkspace') || ctx?.uiWorkspace;
        const workspacesSvc = ctx?.get?.('workspaces') || ctx?.workspaces || uiWorkspace?.workspaces;
        let matched = findControlledWorkspaceItem(workspacesSvc, data);
        if (matched?.workspaceId) return matched;
        const cleanPath = typeof data.path === 'string' ? data.path.trim() : '';
        if (cleanPath && typeof workspacesSvc?.create === 'function') {
          try {
            const createRes = await workspacesSvc.create({ path: cleanPath });
            if (!isCurrent()) return null;
            const createdWs = createRes?.value?.workspace || createRes?.workspace || (createRes?.workspaceId ? createRes : null);
            if (createdWs?.workspaceId) return createdWs;
            matched = findControlledWorkspaceItem(workspacesSvc, data);
            if (matched?.workspaceId) return matched;
          } catch {}
        }
        return matched;
      };
      // 只保存“已交互”这个布尔值，不记录输入文本、按键或鼠标位置。
      const onInteraction = (event) => { if (event.isTrusted === true) interacted = true; };
      const onKeyDown = (event) => {
        const actionId = findShortcutAction(event);
        const action = SHORTCUT_ACTIONS.find((item) => item.id === actionId);
        // 编辑器或宿主可能先 preventDefault；需要转发的动作仍要穿出 iframe。
        if (!action?.forward) return;
        event.preventDefault();
        const direction = shortcutDeviceDirection(actionId);
        if (direction !== null) {
          window.top.postMessage({ source: 'dsh-au', type: 'switch-device', direction, preserveTopbar: true }, '*');
        } else {
          window.top.postMessage({ source: 'dsh-au', type: SHORTCUT_ACTION_MESSAGE, action: actionId }, '*');
        }
      };
      const onMessage = (event) => {
        const data = event.data;
        const initialFocus = data?.source === 'dsh-au' && data.type === 'initial-session-focus'
          || data?.source === 'dsh-au-todo' && data.type === 'dsh-au-todo:select-session' && data.initialFocus === true;
        if (initialFocus) {
          // 专用首次定位协议不走 Todo 的自动确认；兼容包也不能被第二个监听器重复处理。
          event.stopImmediatePropagation?.();
          if (event.source !== window.parent || typeof data.requestId !== 'string' || !data.requestId
            || data.requestId.length > 128 || typeof data.sessionId !== 'string' || !data.sessionId || data.sessionId.length > 128) return;
          const reply = (result) => window.parent.postMessage({
            source: 'dsh-au', type: 'initial-session-focus-result', requestId: data.requestId, sessionId: data.sessionId, result,
          }, '*');
          if (interacted) { reply('skipped-user-input'); return; }
          if (appliedFocusRequests.has(data.requestId) || readNativeSelectedSessionId(controlledClientCtx) === data.sessionId) {
            reply('already-selected'); return;
          }
          const uiWorkspace = controlledClientCtx?.get?.('uiWorkspace') || controlledClientCtx?.uiWorkspace;
          if (typeof uiWorkspace?.openSession !== 'function') { reply('not-ready'); return; }
          try {
            uiWorkspace.openSession(data.sessionId);
            appliedFocusRequests.add(data.requestId);
            reply('applied');
          } catch { reply('open-failed'); }
          return;
        }
        // 外层把自己的快捷键覆盖推送进来；只认来自直接父窗口的消息。
        if (event.source === window.parent && data?.source === 'dsh-au' && data?.type === 'frame-probe') {
          // 只有远端插件确实初始化后才确认 ready；旧版远端不支持时仍兼容 document load。
          window.parent.postMessage({ source: 'dsh-au', type: 'frame-ready', frameId: data.frameId }, '*');
          return;
        }
        if (event.source === window.parent && data?.source === 'dsh-au' && data?.type === SHORTCUT_CONFIG_MESSAGE) {
          setShortcutOverrides(normalizeShortcutOverrides(data.overrides), { persist: false });
          // 总开关跟随外层；旧版外层不带该字段时按关闭处理。
          setShortcutsEnabled(data.shortcutsEnabled === true, { persist: false });
          if (typeof data.fullAccessByDefault === 'boolean') {
            controlledFullAccessByDefault = data.fullAccessByDefault;
            void syncControlledHostDefaultPreset(controlledFullAccessByDefault);
          }
          return;
        }
        // 外层通知受控端同步确认并清除某条会话的未读完成标记。
        if (data?.source === 'dsh-au' && data?.type === 'dsh-au:confirm-remote-session') {
          if (event.source && event.source !== window.parent && event.source !== window.top) return;
          const sid = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
          if (sid) {
            markControlledSessionConfirmed(sid, controlledClientCtx, data);
            postControlledWorkspacesSnapshot(controlledClientCtx);
          }
          return;
        }
        if (data?.source === 'dsh-au' && data?.type === 'dsh-au:cancel-remote-navigation') {
          if (event.source && event.source !== window.parent && event.source !== window.top) return;
          const selectionSeq = Number.isSafeInteger(data.selectionSeq) && data.selectionSeq >= 0 ? data.selectionSeq : undefined;
          if (selectionSeq !== undefined && selectionSeq < latestSelectionSeq) return;
          if (selectionSeq !== undefined) latestSelectionSeq = selectionSeq;
          navigationGeneration += 1;
          finishNavigation(currentNavigation, 'cancelled');
          currentNavigation = null;
          controlledNavigationMetadata = { selectionSeq };
          return;
        }
        const todoNavigation = data?.source === 'dsh-au-todo' && data?.type === 'dsh-au-todo:select-session';
        const sessionNavigation = data?.source === 'dsh-au' && data?.type === 'dsh-au:open-remote-session' || todoNavigation;
        const workspaceNavigation = data?.source === 'dsh-au' && data?.type === 'dsh-au:open-remote-workspace';
        if (sessionNavigation || workspaceNavigation) {
          // The legacy Todo listener also opens/confirms; one controller must own the compatibility packet.
          if (todoNavigation) event.stopImmediatePropagation?.();
          if (event.source && event.source !== window.parent && event.source !== window.top) return;
          const navigation = beginNavigation(data);
          if (!navigation) return;
          const resolveNavigationServices = () => {
            const c = controlledClientCtx;
            const uw = c?.get?.('uiWorkspace') || c?.uiWorkspace;
            const ss = c?.get?.('sessions') || c?.sessions || uw?.sessions;
            return { ctx: c, uiWorkspace: uw, sessionsSvc: ss };
          };
          let { ctx, uiWorkspace, sessionsSvc } = resolveNavigationServices();
          const sid = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
          const completion = sid ? captureControlledSessionCompletion(sid, ctx, data) : null;
          let opened = false;
          let openedRequestedSession = false;
          const waitForOpenSessionReady = async (timeoutMs = 3000) => {
            const deadline = Date.now() + timeoutMs;
            while (isCurrentNavigation(navigation)) {
              const services = resolveNavigationServices();
              if (typeof services.uiWorkspace?.openSession === 'function') return services;
              if (Date.now() >= deadline) return services;
              await new Promise((resolve) => {
                const id = window.setTimeout(() => {
                  navigationTimers.delete(id);
                  resolve();
                }, 100);
                navigationTimers.add(id);
              });
            }
            return resolveNavigationServices();
          };
          const open = async (method, target) => {
            if (typeof uiWorkspace?.[method] !== 'function') return false;
            await awaitNavigation(navigation, () => uiWorkspace[method](target));
            if (method === 'openSession' && target === sid) {
              let resident = sessionsSvc?.manager?.sessions?.get?.(sid);
              const errMsg = String(resident?.openError?.message || resident?.openError || '');
              if (resident?.openState === 'error' && /is released/i.test(errMsg) && !resident.__dshAuOpenRecovered) {
                resident.__dshAuOpenRecovered = true;
                try { delete resident.__dshAuPreloaded; } catch { resident.__dshAuPreloaded = null; }
                try {
                  if (typeof sessionsSvc?.manager?.sessions?.delete === 'function') {
                    sessionsSvc.manager.sessions.delete(sid);
                  }
                } catch {}
                await awaitNavigation(navigation, () => uiWorkspace[method](target));
                resident = sessionsSvc?.manager?.sessions?.get?.(sid);
              }
              if (resident?.openState === 'error') {
                throw resident.openError instanceof Error ? resident.openError : new Error('session-open-error');
              }
              opened = true;
              openedRequestedSession = true;
              // 已打开会话的 open() 不会再进入 doOpen；补发状态，避免外层误等 30 秒。
              if (resident?.openState === 'open' && resident.openPromise == null && typeof postControlledSessionMetric === 'function') {
                postControlledSessionMetric('foreground-state', sid, { stage: 'already-open', result: 'open', generation: resident.openGeneration, elapsedMs: 0 });
              }
              return true;
            }
            opened = true;
            return true;
          };
          const runNavigation = async () => {
            try {
              if (sessionNavigation && !(data.createNew === true && (data.workspaceId || data.path || data.title))) {
                if (sid) {
                  // 受控 iframe 冷启动时 uiWorkspace 可能晚于脚本注入就绪，短时轮询等待后再打开目标会话。
                  if (typeof uiWorkspace?.openSession !== 'function') {
                    ({ ctx, uiWorkspace, sessionsSvc } = await waitForOpenSessionReady());
                    assertCurrentNavigation(navigation);
                  }
                  await open('openSession', sid);
                }
              } else {
                const matched = await awaitNavigation(navigation, () => resolveOrCreateControlledWorkspace(ctx, data, () => isCurrentNavigation(navigation)));
                const targetWorkspaceId = matched?.workspaceId || (isRealControlledWorkspaceId(data.workspaceId) ? data.workspaceId : '');
                const createAndOpenSessionFallback = async () => {
                  assertCurrentNavigation(navigation);
                  if (targetWorkspaceId && typeof uiWorkspace?.startSession === 'function') {
                    try { if (await open('startSession', targetWorkspaceId)) return; }
                    catch { assertCurrentNavigation(navigation); }
                  }
                  if (typeof sessionsSvc?.create === 'function') {
                    const created = await awaitNavigation(navigation, () => sessionsSvc.create(
                      targetWorkspaceId ? { workspaceId: targetWorkspaceId } : (data.path ? { cwd: data.path } : {})
                    ));
                    const newSid = created?.sessionId || created?.id || created?.value?.sessionId || '';
                    if (newSid && await open('openSession', newSid)) return;
                  }
                  await open('startSession', targetWorkspaceId || data.workspaceId);
                };
                if (sessionNavigation) {
                  const inWorkspace = sid && Array.isArray(matched?.sessionIds) && matched.sessionIds.includes(sid);
                  if (inWorkspace && typeof uiWorkspace?.openSession === 'function') await open('openSession', sid);
                  else if (targetWorkspaceId && typeof uiWorkspace?.openWorkspace === 'function') await open('openWorkspace', targetWorkspaceId);
                  else if (targetWorkspaceId && typeof uiWorkspace?.startSession === 'function') await open('startSession', targetWorkspaceId);
                  else if (sid) await open('openSession', sid);
                } else if (data.createNew === true) {
                  if (targetWorkspaceId && typeof uiWorkspace?.openWorkspace === 'function') {
                    try { await open('openWorkspace', targetWorkspaceId); }
                    catch { assertCurrentNavigation(navigation); await createAndOpenSessionFallback(); }
                  } else await createAndOpenSessionFallback();
                } else if (targetWorkspaceId && typeof uiWorkspace?.openWorkspace === 'function') {
                  try { await open('openWorkspace', targetWorkspaceId); }
                  catch {
                    assertCurrentNavigation(navigation);
                    if (data.fallbackSessionId && typeof uiWorkspace?.openSession === 'function') await open('openSession', data.fallbackSessionId);
                    else await createAndOpenSessionFallback();
                  }
                } else if (data.fallbackSessionId && typeof uiWorkspace?.openSession === 'function') {
                  await open('openSession', data.fallbackSessionId);
                } else if (data.workspaceId && typeof uiWorkspace?.openWorkspace === 'function') {
                  try { await open('openWorkspace', data.workspaceId); }
                  catch { assertCurrentNavigation(navigation); await createAndOpenSessionFallback(); }
                } else await createAndOpenSessionFallback();
              }
              assertCurrentNavigation(navigation);
              if (!opened) { finishNavigation(navigation, 'not-ready'); return; }
              if (openedRequestedSession) markControlledSessionConfirmed(sid, ctx, completion);
              postControlledWorkspacesSnapshot(ctx);
              const appliedSid = readNativeSelectedSessionId(ctx) || sid || '';
              if (data.createNew === true && appliedSid) {
                void ensureControlledSessionFullAccess(appliedSid, ctx);
              }
              finishNavigation(navigation, 'applied', appliedSid);
              scheduleNavigationSnapshot(navigation, workspaceNavigation ? 220 : 200);
              if (workspaceNavigation) scheduleNavigationSnapshot(navigation, 550);
            } catch {
              // Supersession/cancellation already has its own terminal ACK, never with a stale currentSid.
              if (isCurrentNavigation(navigation)) finishNavigation(navigation, 'open-failed');
            }
          };
          void runNavigation();
          return;
        }
        // 外层左侧栏发起远端会话或工作区实体操作（置顶、取消置顶、归档、取消归档、重命名会话、重命名工作区）。
        if (data?.source === 'dsh-au' && data?.type === 'dsh-au:remote-entity-action') {
          if (event.source && event.source !== window.parent && event.source !== window.top) return;
          if (data.commandId && appliedRemoteCommands.has(data.commandId)) {
            ackRemoteCommand(data.commandId);
            return;
          }
          if (data.commandId) {
            appliedRemoteCommands.add(data.commandId);
            ackRemoteCommand(data.commandId);
          }
          const uiWorkspace = controlledClientCtx?.get?.('uiWorkspace') || controlledClientCtx?.uiWorkspace;
          const workspacesSvc = controlledClientCtx?.get?.('workspaces') || controlledClientCtx?.workspaces || uiWorkspace?.workspaces;
          const sessionsSvc = controlledClientCtx?.get?.('sessions') || controlledClientCtx?.sessions || uiWorkspace?.sessions;
          const runEntityAction = async () => {
            try {
              const act = data.entityAction;
              const sid = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
              const title = typeof data.title === 'string' ? data.title.trim() : '';
              if (act === 'pinSession' && sid) {
                if (typeof uiWorkspace?.pinSession === 'function') await uiWorkspace.pinSession(sid);
                else await workspacesSvc?.pinSession?.(sid);
              } else if (act === 'unpinSession' && sid) {
                if (typeof uiWorkspace?.unpinSession === 'function') await uiWorkspace.unpinSession(sid);
                else await workspacesSvc?.unpinSession?.(sid);
              } else if (act === 'archiveSession' && sid) {
                if (typeof uiWorkspace?.archiveSession === 'function') await uiWorkspace.archiveSession(sid, { isCurrentSession: false });
                else await workspacesSvc?.archiveSession?.(sid, { isCurrentSession: false });
              } else if (act === 'unarchiveSession' && sid) {
                if (typeof uiWorkspace?.unarchiveSession === 'function') await uiWorkspace.unarchiveSession(sid);
                else await workspacesSvc?.unarchiveSession?.(sid);
              } else if (act === 'renameSession' && sid && title) {
                if (typeof sessionsSvc?.using === 'function') {
                  await sessionsSvc.using(sid, { source: 'workspaceOperation' }, (ref) => ref?.binding?.session?.rename?.(title));
                } else {
                  await sessionsSvc?.binding?.(sid)?.session?.rename?.(title);
                }
              } else if (act === 'renameWorkspace' && title) {
                const wsSnap = workspacesSvc?.list?.getSnapshot?.() || {};
                const items = Array.isArray(wsSnap.items) ? wsSnap.items : Object.values(wsSnap.byId || {});
                const normTargetPath = normalizeWorkspacePathKey(data.path || '');
                const matched = (Array.isArray(items) ? items : []).find((item) => {
                  if (!item) return false;
                  if (data.workspaceId && item.workspaceId === data.workspaceId) return true;
                  const itemPathKey = normalizeWorkspacePathKey(item.path || item.cwd || '');
                  if (normTargetPath && itemPathKey && itemPathKey === normTargetPath) return true;
                  if (data.oldTitle && item.title === data.oldTitle) return true;
                  return false;
                });
                const targetWsId = matched?.workspaceId || data.workspaceId;
                if (targetWsId && typeof workspacesSvc?.rename === 'function') {
                  await workspacesSvc.rename(targetWsId, title);
                }
              }
            } catch {}
            postControlledWorkspacesSnapshot(controlledClientCtx);
            if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
              window.setTimeout(() => postControlledWorkspacesSnapshot(controlledClientCtx), 200);
            }
          };
          void runEntityAction();
          return;
        }
        // 外层主动请求受控端工作区与会话快照。
        if (data?.source === 'dsh-au' && data?.type === 'dsh-au:request-workspaces-snapshot') {
          if (event.source && event.source !== window.parent && event.source !== window.top) return;
          postControlledWorkspacesSnapshot(controlledClientCtx);
          return;
        }
      };
      window.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('input', onInteraction, true);
      window.addEventListener('pointerdown', onInteraction, true);
      window.addEventListener('keydown', onInteraction, true);
      window.addEventListener('message', onMessage);
      return () => {
        disposed = true;
        navigationGeneration += 1;
        if (controlledNavigationMetadata === currentNavigation) controlledNavigationMetadata = {};
        for (const timer of navigationTimers) window.clearTimeout(timer);
        navigationTimers.clear();
        window.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('input', onInteraction, true);
        window.removeEventListener('pointerdown', onInteraction, true);
        window.removeEventListener('keydown', onInteraction, true);
        window.removeEventListener('message', onMessage);
      };
    }

    /** 快捷键服务与页面监听共用菜单与设置弹窗事件，避免宿主先消费键盘事件后失效。 */
    function dispatchWorkbenchShortcut(tab) {
      if (tab !== 'fav' && tab !== 'services' && tab !== 'settings' && tab !== 'cloudSync') return;
      window.dispatchEvent(new CustomEvent(WORKBENCH_SHORTCUT_EVENT, { detail: { tab } }));
    }

    /** 与 dsh-au-mobile 一致地识别手机/平板触摸环境，窄桌面窗口不会被误折叠。 */
    function isMobileTopbarViewport(width, env = typeof window !== 'undefined' ? window : null) {
      if (!Number.isFinite(width) || width <= 0 || width > 1440 || !env) return false;
      const ua = String(env.navigator?.userAgent || '');
      const touchPoints = Number(env.navigator?.maxTouchPoints || 0);
      const coarse = typeof env.matchMedia === 'function' && env.matchMedia('(pointer: coarse)').matches;
      const noHover = typeof env.matchMedia === 'function' && env.matchMedia('(hover: none)').matches;
      // 只按移动 UA 或触摸输入进入手机模式，窄桌面窗口维持完整工具栏。
      return /Android|iPhone|iPod|iPad|Tablet|PlayBook|Silk|Mobile|HarmonyOS|ArkWeb/i.test(ua)
        || (/Macintosh/i.test(ua) && touchPoints > 1)
        || (coarse && (noHover || touchPoints > 1));
    }

    /** 手机首次打开默认收起为悬浮胶囊；桌面继续遵从保存的选择。 */
    function readTopbarCollapsedPreference() {
      if (typeof window !== 'undefined' && isMobileTopbarViewport(window.innerWidth, window)) return true;
      try { return localStorage.getItem(TOPBAR_COLLAPSED_STORAGE_KEY) === 'true'; } catch { return false; }
    }

    const MOBILE_FEATURE_STORAGE_KEY = 'dsh-au.mobile-enabled';
    // 设置页「管理远程设备」按钮通过该事件请求外壳打开远程设备管理弹窗。
    const OPEN_REMOTE_MANAGER_EVENT = 'dsh-au:open-remote-manager';

    /** 移动端优化的开关只存在当前浏览器；默认关闭，只有明确记录为开启才生效。 */
    function readMobileFeatureEnabled() {
      try { return localStorage.getItem(MOBILE_FEATURE_STORAGE_KEY) === 'true'; } catch { return false; }
    }

    function writeMobileFeatureEnabled(enabled) {
      try { localStorage.setItem(MOBILE_FEATURE_STORAGE_KEY, enabled ? 'true' : 'false'); } catch {}
    }

    /** 读取相对主内容右上角的悬浮位置，损坏的本地值回落至默认位置。 */
    function readFloatingCapsulePosition() {
      try {
        const value = JSON.parse(localStorage.getItem(FLOATING_CAPSULE_STORAGE_KEY) || 'null');
        if (Number.isFinite(value?.top) && Number.isFinite(value?.right)) {
          return { top: Math.max(8, value.top), right: Math.max(8, value.right) };
        }
      } catch {}
      return DEFAULT_CAPSULE_POSITION;
    }

    /** 将悬浮胶囊限制在当前主内容区域，避免拖出屏幕后无法找回。 */
    function clampFloatingCapsulePosition(position, rect) {
      return {
        top: Math.min(Math.max(8, position.top), Math.max(8, rect.height - 36)),
        right: Math.min(Math.max(8, position.right), Math.max(8, rect.width - 140)),
      };
    }

