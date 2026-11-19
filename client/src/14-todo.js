    // 待办面板（原 dsh-au-todo 客户端）。包进 IIFE 隔离同名标识；协议名与存储键保持不变。
    const todoClient = (() => {
      'use strict';
      const React = require('react');
      const ReactDOM = require('react-dom');
      const h = React.createElement;
      const { useCallback, useEffect, useRef, useState } = React;
      let NativeToast = null;
      try { NativeToast = require('@deepseek-ai/dsh-client-ui-primitives').Toast; } catch {}

      const STYLE_ID = 'dsh-au-todo-style';
      const SELECT_SESSION_MESSAGE = 'dsh-au-todo:select-session';
      const REMOTE_SESSIONS_META_MESSAGE = 'dsh-au-todo:remote-sessions-meta';
      const DEVICE_SELECT_EVENT = 'dsh-au:select-device';
      const CONTROLLED_FRAME_PREFIX = 'dsh-au-controlled:';
      const CLIENT_LOCK = '__dshAuTodoClientApplyActive';
      const DOCK_POSITION_KEY = 'dsh-au-todo.dock-position';
      const DEFAULT_DOCK_POSITION = { top: 74, left: 0 };
      const remoteSessionMetaCache = new Map();
      const locallyConfirmedRemoteSessions = new Map();
      // 完成状态由面板和全局快捷键共享；旧列表与旧探针不能把刚完成的卡片补回来。
      const completedTodoSessions = new Map();
      let todoCompletionRevision = 0;
      let authoritativeTodoDeviceIds = new Set();
      const todoCompletionKey = (card) => `${card.deviceId}:${card.sessionId}`;
      const pendingRemoteSelections = new Map();
      let openWorkspaceSession = null;
      let todoPanelOpen = false;
      const todoPanelListeners = new Set();
      let todoPanelAnchor = { top: 64, right: 12 };
      const todoPanelAnchorListeners = new Set();
      let todoCycleNotice = null;
      let todoCycleNoticeSeq = 0;
      const todoCycleNoticeListeners = new Set();

      function setTodoCycleNotice(next) {
        todoCycleNotice = next;
        for (const listener of todoCycleNoticeListeners) listener(next);
      }

      /** 只有一个原生 Toast；重复触发重播同一位置的提示，不往页面堆叠通知。 */
      function showTodoCycleNotice(text) {
        todoCycleNoticeSeq += 1;
        setTodoCycleNotice({ seq: todoCycleNoticeSeq, text });
      }

      /** 常驻于 shell overlay，独立于 Todo 面板开关，沿用宿主的样式、淡出与无焦点交互。 */
      function TodoCycleNotice() {
        const [notice, setNotice] = useState(todoCycleNotice);
        useEffect(() => {
          todoCycleNoticeListeners.add(setNotice);
          setNotice(todoCycleNotice);
          return () => todoCycleNoticeListeners.delete(setNotice);
        }, []);
        if (!notice || !NativeToast) return null;
        return h(NativeToast, {
          key: notice.seq, text: notice.text,
          onDone: () => { if (todoCycleNotice?.seq === notice.seq) setTodoCycleNotice(null); },
        });
      }

      /** 顶部动作与浮动面板共享一个最小状态源，避免 DOM 模拟和跨组件状态漂移。 */
      function setTodoPanelOpen(next) {
        const open = Boolean(next);
        if (todoPanelOpen === open) return;
        todoPanelOpen = open;
        for (const listener of [...todoPanelListeners]) listener(open);
      }

      function useTodoPanelOpen() {
        const [open, setOpen] = useState(todoPanelOpen);
        useEffect(() => {
          todoPanelListeners.add(setOpen);
          return () => todoPanelListeners.delete(setOpen);
        }, []);
        return [open, setTodoPanelOpen];
      }

      /** 面板只跟随自己顶部图标与真实 header 的几何位置，并限制在视口内防止越界。 */
      function setTodoPanelAnchor(next) {
        const vw = typeof window !== 'undefined' ? Number(window.innerWidth) || 0 : 0;
        const maxRight = vw > 0 ? Math.max(8, vw - Math.min(400, Math.max(200, vw - 16))) : 12;
        const anchor = {
          top: Math.max(8, Math.round(Number(next?.top) || 64)),
          right: Math.min(maxRight, Math.max(8, Math.round(Number(next?.right) || 12))),
        };
        if (anchor.top === todoPanelAnchor.top && anchor.right === todoPanelAnchor.right) return;
        todoPanelAnchor = anchor;
        for (const listener of [...todoPanelAnchorListeners]) listener(anchor);
      }

      function useTodoPanelAnchor() {
        const [anchor, setAnchor] = useState(todoPanelAnchor);
        useEffect(() => {
          todoPanelAnchorListeners.add(setAnchor);
          return () => todoPanelAnchorListeners.delete(setAnchor);
        }, []);
        return anchor;
      }

      function TodoPanelIcon({ open = false }) {
        return h('svg', { width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, open
          ? [h('path', { key: 'a', d: 'M7 7l10 10M17 7L7 17' })]
          : [h('rect', { key: 'a', x: 4, y: 3, width: 16, height: 18, rx: 3 }), h('path', { key: 'b', d: 'M8 8h8M8 12h8M8 16h5' }), h('path', { key: 'c', d: 'M6.5 8.2l.8.8 1.5-1.8' })]);
      }

      // 几何居中的 24x24 刷新图标，圆心定位于 (12, 12)，半径 8，避免图标偏向按钮右下角
      function TodoRefreshIcon() {
        return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, [
          h('path', { key: 'arc', d: 'M20 12a8 8 0 1 1-2.34-5.66' }),
          h('path', { key: 'arrow', d: 'M20 4v4.5h-4.5' }),
        ]);
      }

      /** 从 DSH 官方 sessions.list 读取当前选中会话（优先 snap.current，回退唯一 mainView 引用），不依赖任何侧栏 DOM 属性。 */
      function selectedSessionSource(sessions) {
        const list = sessions?.list;
        const getSnapshot = () => {
          const snap = list?.getSnapshot?.() || {};
          if (typeof snap.current === 'string' && snap.current) return snap.current;
          const rows = Object.values(snap.byId || {});
          const matched = rows.find((row) => (row?.retainedBy?.mainView ?? 0) > 0);
          return matched?.id || matched?.sessionId || '';
        };
        return {
          getSnapshot,
          get: getSnapshot,
          subscribe(listener) {
            if (typeof list?.subscribe !== 'function') return () => {};
            return list.subscribe((arg) => {
              const next = typeof arg === 'string' && arg ? arg : getSnapshot();
              listener(next);
            });
          },
        };
      }

      function TodoHeaderActionInner() {
        const [open, setOpen] = useTodoPanelOpen();
        const buttonRef = useRef(null);
        const pointerToggled = useRef(false);
        const updateAnchor = useCallback(() => {
          const button = buttonRef.current;
          // DSH 的 [data-slot] 节点固定为 display:contents（宽高与坐标全为 0），必须测量真实 <header> 与按钮自身。
          const header = button?.closest?.('header');
          const headerRect = header?.getBoundingClientRect?.();
          const buttonRect = button?.getBoundingClientRect?.();
          const validHeaderRect = headerRect && headerRect.width > 0 && headerRect.height > 0 ? headerRect : null;
          const validButtonRect = buttonRect && buttonRect.width > 0 && buttonRect.height > 0 ? buttonRect : null;
          const rect = validHeaderRect || validButtonRect;
          if (!rect) return;
          const right = Math.max(8, window.innerWidth - rect.right + 12);
          const top = (validButtonRect ? validButtonRect.bottom : rect.bottom) + 8;
          setTodoPanelAnchor({ top, right });
        }, []);
        useEffect(() => {
          updateAnchor();
          const button = buttonRef.current;
          const header = button?.closest?.('header') || button;
          const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(updateAnchor) : null;
          if (header) observer?.observe(header);
          window.addEventListener('resize', updateAnchor);
          return () => {
            observer?.disconnect();
            window.removeEventListener('resize', updateAnchor);
          };
        }, [updateAnchor]);
        const toggle = () => {
          updateAnchor();
          setOpen(!open);
        };
        return h('button', {
          type: 'button',
          ref: buttonRef,
          className: 'dsh-au-todo-toggle',
          // 部分移动宿主会把 header 内的 click 交给手势层；优先在 PointerDown 切换，click 仅补键盘操作。
          onPointerDown: (event) => {
            if (event.button !== 0) return;
            pointerToggled.current = true;
            toggle();
          },
          // Pointer Events 不可用的旧移动 WebView 由 touchstart 覆盖；支持 Pointer 的浏览器不会重复切换。
          onTouchStart: () => {
            if (pointerToggled.current) return;
            pointerToggled.current = true;
            toggle();
          },
          onClick: () => {
            if (pointerToggled.current) {
              pointerToggled.current = false;
              return;
            }
            toggle();
          },
          title: open ? '收起跨设备 Todo' : '打开跨设备 Todo',
          'aria-label': open ? '收起跨设备 Todo' : '打开跨设备 Todo',
          'aria-expanded': open,
        }, h(TodoPanelIcon, { open }));
      }

      function isControlledFrame() {
        try {
          if (window.top && window.top !== window) return true;
        } catch {
          return true;
        }
        return typeof window.name === 'string' && window.name.startsWith(CONTROLLED_FRAME_PREFIX);
      }

      /** 识别移动端/触屏环境：禁用 HTML5 拖拽抢占触摸点击，并在跳转对话后自动收起全屏面板。 */
      function isMobileOrTouchViewport() {
        if (typeof window === 'undefined') return false;
        if (Number(window.innerWidth) > 0 && Number(window.innerWidth) <= 768) return true;
        const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
        return Boolean(coarse);
      }

      function ensureStyles() {
        let style = document.getElementById(STYLE_ID);
        if (!style) {
          style = document.createElement('style');
          style.id = STYLE_ID;
          document.head.appendChild(style);
        }
        style.textContent = `
          .dsh-au-todo-dock { position:fixed; z-index:40; top:64px; right:12px; width:min(400px,calc(100vw - 24px)); color:#e5e7eb; font:12px/1.4 ui-sans-serif,system-ui,sans-serif; -webkit-app-region:no-drag; }
          .dsh-au-todo-panel { overflow:hidden; border:1px solid #34415c; border-radius:10px; background:#121722f5; box-shadow:0 16px 46px #0009; }
          .dsh-au-todo-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:9px 10px; border-bottom:1px solid #2a3449; user-select:none; -webkit-user-select:none; }
          .dsh-au-todo-title { display:flex; align-items:center; gap:7px; font-weight:700; color:#f8fafc; }
          .dsh-au-todo-actions { display:flex; gap:5px; }
          /* 独立悬浮入口也复用宿主颜色，不能在浅色页面上留下深色按钮块。 */
          .dsh-au-todo-icon, .dsh-au-todo-toggle { display:inline-flex; align-items:center; justify-content:center; min-width:28px; height:28px; padding:0 6px; border:1px solid var(--dsw-alias-border-l2,#334155); border-radius:6px; background:var(--dsw-alias-bg-layer-1,#1a2130); color:var(--dsw-alias-label-secondary,#b8c5d8); cursor:pointer; -webkit-app-region:no-drag; }
          .dsh-au-todo-icon { width:28px; padding:0; line-height:0; }
          .dsh-au-todo-icon svg, .dsh-au-todo-toggle svg { display:block; margin:auto; flex:none; }
          .dsh-au-todo-toggle:hover, .dsh-au-todo-icon:hover { border-color:var(--dsw-alias-state-business-primary,#3b82f6); background:var(--dsw-alias-interactive-bg-hover-solid,#172947); color:var(--dsw-alias-label-primary,#dbeafe); }
          .dsh-au-todo-toggle[aria-expanded="true"] { border-color:var(--dsw-alias-state-business-primary,#3b82f6); background:var(--dsw-alias-state-business-tertiary,#172947); color:var(--dsw-alias-label-primary,#dbeafe); }
          .dsh-au-todo-toggle:focus-visible, .dsh-au-todo-icon:focus-visible, .dsh-au-todo-summary:focus-visible, .dsh-au-todo-jump:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary,#3b82f6); outline-offset:2px; }
          /* 单卡约 100px：列表最多露出 6 条，更多记录只在内部滚动。 */
          .dsh-au-todo-list { max-height:min(666px,calc(100dvh - 132px)); overflow-y:auto; padding:8px; display:flex; flex-direction:column; gap:8px; }
          .dsh-au-todo-card { border:1px solid rgba(255,255,255,0.08); border-radius:9px; background:#141923; padding:10px 12px; cursor:pointer; touch-action:manipulation; transition:border-color .15s ease, background-color .15s ease, box-shadow .15s ease; }
          .dsh-au-todo-card:hover, .dsh-au-todo-card[data-drop-target="true"] { border-color:rgba(96,165,250,0.4); background:#171e2c; }
          /* 当前选中的会话：清晰的高级蓝线边框 */
          .dsh-au-todo-card[data-selected="true"] { border-color:#3b82f6; background:#162032; box-shadow:0 0 0 1px #3b82f6, 0 4px 16px rgba(0,0,0,0.3); }
          .dsh-au-todo-card[data-selected="true"] .dsh-au-todo-name { color:#ffffff; }
          /* 置顶卡片：克制柔和的香槟金微描边，告别大面积土黄底 */
          .dsh-au-todo-card[data-pinned="true"] { border-color:rgba(245,158,11,0.35); background:#181c24; box-shadow:inset 0 1px 0 rgba(245,158,11,0.15); }
          .dsh-au-todo-card[data-pinned="true"]:hover { border-color:rgba(245,158,11,0.55); background:#1c202a; }
          .dsh-au-todo-card[data-pinned="true"][data-selected="true"] { border-color:#3b82f6; box-shadow:0 0 0 1px #3b82f6, inset 0 1px 0 rgba(245,158,11,0.2); }
          .dsh-au-todo-card-top { display:flex; align-items:center; gap:8px; min-width:0; }
          .dsh-au-todo-name { min-width:0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:14px; line-height:1.4; font-weight:600; color:#f1f5f9; letter-spacing:-0.01em; }
          .dsh-au-todo-jump { flex:none; display:inline-flex; align-items:center; justify-content:center; height:22px; padding:0 8px; border:1px solid rgba(59,130,246,0.4); border-radius:4px; background:#2563eb; color:#ffffff; font-size:11px; font-weight:600; line-height:1; cursor:pointer; white-space:nowrap; touch-action:manipulation; -webkit-tap-highlight-color:transparent; transition:background-color .15s ease; }
          .dsh-au-todo-jump:hover { background:#1d4ed8; border-color:#60a5fa; }
          /* 正文内容的显示先隐藏 */
          .dsh-au-todo-summary { display:none !important; width:100%; max-width:100%; overflow:hidden; margin:3px 0 0; padding:0; border:0; background:none; color:#98a7bc; font:inherit; line-height:1.45; text-align:left; text-overflow:ellipsis; white-space:nowrap; cursor:zoom-in; }
          .dsh-au-todo-card[data-expanded="true"] .dsh-au-todo-summary { max-height:14.5em; overflow-y:auto; white-space:pre-wrap; overflow-wrap:anywhere; cursor:zoom-out; scrollbar-color:#64748b transparent; }
          .dsh-au-todo-meta { display:flex; align-items:center; gap:6px; margin-top:8px; color:#8592a6; font-size:11px; overflow:hidden; flex-wrap:nowrap; }
          .dsh-au-todo-meta span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
          .dsh-au-todo-meta .dsh-au-todo-dot { width:6px; height:6px; margin-right:1px; flex:none; }
          .dsh-au-todo-workspace-tag { display:inline-flex; align-items:center; max-width:130px; height:18px; padding:0 6px; border-radius:4px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.08); color:#cbd5e1; font-size:10.5px; font-weight:500; flex:0 1 auto; }
          .dsh-au-todo-device-badge { flex:0 0 auto; max-width:130px; }
          .dsh-au-todo-time { margin-left:auto; flex:none; color:#64748b; font-size:11px; }
          .dsh-au-todo-priority-row { display:flex; align-items:center; gap:4px; margin-top:8px; width:100%; box-sizing:border-box; }
          .dsh-au-todo-priority-pill { flex:1 1 0; min-width:0; height:22px; padding:0; border:1px solid rgba(255,255,255,0.06); border-radius:4px; background:rgba(255,255,255,0.03); color:#64748b; font-size:11px; font-weight:500; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; transition:all .12s ease; user-select:none; }
          .dsh-au-todo-priority-pill:hover { border-color:rgba(255,255,255,0.15); background:rgba(255,255,255,0.06); color:#cbd5e1; }
          /* 选中态：极度清晰醒目的纯色高光药丸，一眼即知 */
          .dsh-au-todo-priority-pill.selected { border-color:#3b82f6 !important; background:#2563eb !important; color:#ffffff !important; font-weight:700 !important; box-shadow:0 1px 6px rgba(37,99,235,0.4); }
          .dsh-au-todo-priority-pill.selected[data-priority="P0"] { border-color:#ef4444 !important; background:#dc2626 !important; color:#ffffff !important; box-shadow:0 1px 6px rgba(220,38,38,0.45); }
          .dsh-au-todo-priority-pill.selected[data-priority="P1"] { border-color:#f97316 !important; background:#ea580c !important; color:#ffffff !important; box-shadow:0 1px 6px rgba(234,88,12,0.45); }
          .dsh-au-todo-priority-pill.selected[data-priority="P2"] { border-color:#3b82f6 !important; background:#2563eb !important; color:#ffffff !important; box-shadow:0 1px 6px rgba(37,99,235,0.4); }
          .dsh-au-todo-pinned-label { flex:none; padding:1px 6px; border:1px solid rgba(245,158,11,0.4); border-radius:999px; background:rgba(245,158,11,0.12); color:#fbbf24; font-size:10px; font-weight:600; line-height:1.3; }
          .dsh-au-todo-dot { width:6px; height:6px; border-radius:50%; background:#10b981; flex:none; }
          .dsh-au-todo-dot.done { background:#38bdf8; box-shadow:0 0 6px rgba(56,189,248,.6); } .dsh-au-todo-dot.busy { background:#f59e0b; box-shadow:0 0 6px rgba(245,158,11,.6); } .dsh-au-todo-dot.error { background:#ef4444; box-shadow:0 0 6px rgba(239,68,68,.6); } .dsh-au-todo-dot.waiting { background:#a855f7; box-shadow:0 0 6px rgba(168,85,247,.6); }
          .dsh-au-todo-queue { display:flex; flex-direction:column; gap:3px; margin-top:6px; padding:5px 7px; border-left:2px solid #3b82f6; border-radius:3px; background:rgba(0,0,0,0.25); color:#cbd5e1; }
          .dsh-au-todo-queue-label { color:#93c5fd; font-size:10px; font-weight:600; }
          .dsh-au-todo-queue-item { display:-webkit-box; overflow:hidden; white-space:pre-wrap; overflow-wrap:anywhere; -webkit-box-orient:vertical; -webkit-line-clamp:2; font-size:11.5px; }
          .dsh-au-todo-queue-more { color:#64748b; font-size:10px; }
          .dsh-au-todo-card-actions { display:flex; gap:6px; min-width:0; margin-top:8px; }
          .dsh-au-todo-btn { min-width:0; flex:1 1 0; height:26px; padding:0 8px; border:1px solid rgba(255,255,255,0.08); border-radius:5px; background:rgba(255,255,255,0.04); color:#cbd5e1; font:inherit; font-size:11.5px; font-weight:500; cursor:pointer; white-space:nowrap; touch-action:manipulation; display:inline-flex; align-items:center; justify-content:center; transition:all .15s ease; }
          .dsh-au-todo-btn:hover { background:rgba(255,255,255,0.08); border-color:rgba(255,255,255,0.16); color:#f8fafc; }
          .dsh-au-todo-btn.stash { border-color:rgba(245,158,11,0.25); background:rgba(245,158,11,0.08); color:#fde68a; }
          .dsh-au-todo-btn.stash:hover { border-color:rgba(245,158,11,0.45); background:rgba(245,158,11,0.16); color:#ffffff; }
          .dsh-au-todo-btn.complete { border-color:rgba(16,185,129,0.25); background:rgba(16,185,129,0.08); color:#6ee7b7; }
          .dsh-au-todo-btn.complete:hover { border-color:rgba(16,185,129,0.45); background:rgba(16,185,129,0.16); color:#ffffff; }
          .dsh-au-todo-btn.interrupt { border-color:rgba(239,68,68,0.3); background:rgba(239,68,68,0.1); color:#fca5a5; }
          .dsh-au-todo-btn.interrupt:hover { border-color:rgba(239,68,68,0.5); background:rgba(239,68,68,0.2); color:#ffffff; }
          .dsh-au-todo-notice { margin:6px 7px 0; padding:6px 8px; border:1px solid #f59e0b66; border-radius:6px; background:#451a03aa; color:#fde68a; font-size:11px; }
          .dsh-au-todo-empty { padding:22px 12px; color:#94a3b8; text-align:center; }
          /* 首次加载占位：转圈 + 文字，避免空列表被误认为“没有数据”。 */
          .dsh-au-todo-loading { display:flex; align-items:center; justify-content:center; gap:8px; padding:22px 12px; color:#94a3b8; }
          .dsh-au-todo-spinner { width:16px; height:16px; border:2px solid #334155; border-top-color:#60a5fa; border-radius:50%; animation:dsh-au-todo-spin 0.8s linear infinite; }
          @keyframes dsh-au-todo-spin { to { transform:rotate(360deg); } }
          /* 手机上仍由顶部图标打开同一浮动面板，而非切换到全屏或常驻遮挡。 */
          @media (max-width:768px) {
            .dsh-au-todo-dock { top:54px; right:8px; width:calc(100vw - 16px); max-width:400px; font-size:13px; }
            .dsh-au-todo-panel { max-height:calc(100dvh - 70px); }
            .dsh-au-todo-head { min-height:40px; box-sizing:border-box; padding:8px 10px; }
            .dsh-au-todo-list { max-height:calc(100dvh - 122px); padding:6px; gap:7px; }
            .dsh-au-todo-card { padding:9px; }
            .dsh-au-todo-name { font-size:15px; }
            .dsh-au-todo-jump { min-height:28px; padding:3px 10px; font-size:12px; }
            .dsh-au-todo-meta { gap:5px; }
            .dsh-au-todo-workspace { max-width:26%; }
            .dsh-au-todo-input, .dsh-au-todo-btn { min-height:36px; font-size:13px; }
            .dsh-au-todo-card-actions { gap:5px; }
          }
          @media (prefers-reduced-motion: reduce) { .dsh-au-todo-card { transition:none; } .dsh-au-todo-spinner { animation-duration:2.4s; } }
        `;
      }

      /** 同源 API 失败必须显式抛出，避免公网入口路由异常被误呈现为“空列表”。 */
      async function callApi(action, payload = {}) {
        // 复用并发中的 getState 请求，避免多模块重复发起网络与磁盘扫描
        if (action === 'getState' && typeof window !== 'undefined' && window.__dshAuTodoGetStateInFlight) {
          return window.__dshAuTodoGetStateInFlight;
        }

        const requestPromise = (async () => {
          const response = await fetch('/dsh-au-todo/api', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...payload }),
          });
          let data;
          try { data = await response.json(); } catch { throw new Error(`接口返回了非 JSON 内容（HTTP ${response.status}）`); }
          if (!response.ok || data?.ok === false) throw new Error(data?.error || `接口请求失败（HTTP ${response.status}）`);
          if (action === 'getState' && typeof window !== 'undefined') {
            // 缓存最新待办数据并广播事件，供 14-todo 与 14a-remote-workspaces 共享，无重复请求
            window.__dshAuLastTodoStateData = data;
            if (typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
              window.dispatchEvent(new CustomEvent('dsh-au:todo-state-data', { detail: data }));
            }
          }
          return data;
        })();

        if (action === 'getState' && typeof window !== 'undefined') {
          window.__dshAuTodoGetStateInFlight = requestPromise;
          try {
            return await requestPromise;
          } finally {
            if (window.__dshAuTodoGetStateInFlight === requestPromise) {
              window.__dshAuTodoGetStateInFlight = null;
            }
          }
        }

        return requestPromise;
      }

      function relativeTime(timestamp) {
        const seconds = Math.max(0, Math.floor((Date.now() - Number(timestamp || Date.now())) / 1000));
        if (seconds < 60) return '刚刚';
        if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
        return `${Math.floor(seconds / 86400)} 天前`;
      }

      const TODO_RECENT_WINDOW_MS = 48 * 60 * 60 * 1000;

      function todoTimestamp(value) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string' && value.trim()) {
          const numeric = Number(value);
          if (Number.isFinite(numeric)) return numeric;
          const parsed = Date.parse(value);
          if (Number.isFinite(parsed)) return parsed;
        }
        return NaN;
      }

      function isRecentTodoCard(card, now = Date.now()) {
        const updatedAt = todoTimestamp(card?.updatedAt);
        return Number.isFinite(updatedAt) && updatedAt >= now - TODO_RECENT_WINDOW_MS && updatedAt <= now;
      }

      function todoStatusRank(card) {
        const status = card?.status || 'idle';
        if (status === 'error') return 0;
        if (status === 'waiting') return 1;
        if (status === 'done') return 2;
        if (status === 'busy' || status === 'running') return 3;
        if (Array.isArray(card?.todos) && card.todos.some((todo) => typeof todo?.text === 'string' && todo.text.trim())) {
          return 4;
        }
        return 5;
      }

      /** 客户端对实时补齐的卡片再次限时，并立即剔除已隐藏空闲卡或已完成卡，防止变回绿灯后残留在面板上。 */
      function isHiddenIdleCard(card) {
        return card?.hidden === true && (!card.status || card.status === 'idle');
      }

      function sortCardsForDisplay(cards) {
        const rank = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4, P5: 5, P6: 6, P7: 7, P8: 8 };
        const now = Date.now();
        return [...cards]
          .filter((card) => card && !isHiddenIdleCard(card) && !completedTodoSessions.has(todoCompletionKey(card)) && isRecentTodoCard(card, now))
          .sort((left, right) =>
            (rank[left.priority] ?? 4) - (rank[right.priority] ?? 4)
            || Number(right.pinned === true) - Number(left.pinned === true)
            || todoStatusRank(left) - todoStatusRank(right)
            || Number(left.sortOrder) - Number(right.sortOrder)
            || Number(right.updatedAt) - Number(left.updatedAt));
      }

      /** 卡片正文只展示实际待发 Todo，不再只显示数量。 */
      function visibleTodos(todos) {
        return Array.isArray(todos) ? todos.filter((todo) => typeof todo?.text === 'string' && todo.text.trim()).slice(0, 2) : [];
      }

      /** 多行 Todo 输入随内容增长；清空后由调用方复位为单行。 */
      function resizeTodoInput(element) {
        if (!(element instanceof HTMLTextAreaElement)) return;
        element.style.height = 'auto';
        element.style.height = `${Math.min(element.scrollHeight, 128)}px`;
      }

      /** 以实际响应式面板宽度约束拖动坐标，移动端不会被拖到屏幕外。 */
      function clampDockPosition(position) {
        const width = Math.min(380, Math.max(180, window.innerWidth - 16));
        return {
          top: Math.min(Math.max(8, Number(position?.top) || DEFAULT_DOCK_POSITION.top), Math.max(8, window.innerHeight - 80)),
          left: Math.min(Math.max(8, Number(position?.left) || window.innerWidth - width - 8), Math.max(8, window.innerWidth - width - 8)),
        };
      }

      function readDockPosition() {
        try { return clampDockPosition(JSON.parse(localStorage.getItem(DOCK_POSITION_KEY) || 'null')); } catch { return clampDockPosition(null); }
      }

      /** 优先调用 DSH 官方 uiWorkspace.openSession；返回可观察结果以避免导航静默失败。 */
      function openNativeSession(sessionId, slotOpenSession = null) {
        if (typeof sessionId !== 'string' || !sessionId) {
          return { ok: false, error: '缺少目标会话 ID' };
        }
        const invokeOpen = typeof slotOpenSession === 'function' ? slotOpenSession : openWorkspaceSession;
        if (typeof invokeOpen === 'function') {
          try {
            invokeOpen(sessionId);
            return { ok: true };
          } catch (error) {
            console.warn('[dsh-au-todo] uiWorkspace.openSession threw:', error);
            return { ok: false, error: `打开会话失败：${error?.message || String(error)}` };
          }
        }
        console.warn('[dsh-au-todo] uiWorkspace.openSession is unavailable for session:', sessionId);
        return { ok: false, error: '当前页面未就绪 uiWorkspace.openSession 导航服务，请刷新或重启 DSH' };
      }

      /** 判断卡片是否属于当前宿主本机，防止本机 instanceId 被误走远程 iframe 分支。 */
      function isLocalCard(card, localDeviceId) {
        if (!card) return false;
        if (card.isLocal === true || card.deviceId === 'local' || !card.deviceId) return true;
        return Boolean(localDeviceId && card.deviceId === localDeviceId);
      }

      function workspaceNameFromCwd(cwd) {
        if (typeof cwd !== 'string' || !cwd.trim()) return '';
        const parts = cwd.trim().replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
        return parts[parts.length - 1] || '';
      }

      function summaryTextFromTurnOutline(turnOutline) {
        if (!Array.isArray(turnOutline) || !turnOutline.length) return '';
        for (let i = turnOutline.length - 1; i >= 0; i -= 1) {
          const turn = turnOutline[i];
          const text = String(turn?.response || turn?.prompt || '').replace(/\s+/g, ' ').trim();
          if (text) return text.slice(0, 220);
        }
        return '';
      }

      function extractControlledSessionsMeta(sessions) {
        try {
          const rows = Object.values(sessions?.list?.getSnapshot?.()?.byId || {});
          const result = [];
          for (const row of rows) {
            const sessionId = row?.id || row?.sessionId;
            if (typeof sessionId !== 'string' || !sessionId || row?.origin === 'subagent' || row?.blank) continue;
            const values = row?.projections?.values || {};
            const title = (typeof values.title === 'string' && values.title.trim())
              || (typeof row?.title === 'string' && row.title.trim())
              || '';
            const cwd = row?.cwd || values.workingDirectory || '';
            const workspace = workspaceNameFromCwd(cwd);
            const summary = summaryTextFromTurnOutline(values.turnOutline);
            const updatedAt = Number(values.sessionListMetadata?.lastPromptAt || row?.updatedAt || 0);
            if (title || summary || workspace) {
              result.push({ sessionId, title, summary, workspace, updatedAt });
            }
          }
          return result;
        } catch {
          return [];
        }
      }

      /** 仅当所属设备返回用户本人发新消息或手动追加待办解除 hidden 标记后，才恢复已完成卡片；后台插件续跑或灯色波动不恢复。 */
      function applyTodoCompletionState(data) {
        const explicitAuthority = Array.isArray(data.authoritativeDeviceIds);
        const ownerCards = new Map(data.cards.filter((card) => card.todoStateSource !== 'native')
          .map((card) => [todoCompletionKey(card), card]));
        // 兼容未发布来源列表的旧宿主：本机卡或仍带隐藏标记的卡可核实归属，不能信任兜底补出的时间。
        authoritativeTodoDeviceIds = new Set(explicitAuthority ? data.authoritativeDeviceIds
          : [...ownerCards.values()].filter((card) => card.hidden === true || isLocalCard(card, data.localDeviceId)).map((card) => card.deviceId));
        for (const [key, completed] of completedTodoSessions) {
          if (completed.pending) continue;
          const current = ownerCards.get(key);
          if (!current) continue;
          if (!authoritativeTodoDeviceIds.has(completed.deviceId) && explicitAuthority) continue;
          const baseline = Number(completed.hiddenAt || completed.lastUserMessageAt || completed.updatedAt || 0);
          const hasNewUserMessage = Number(current.lastUserMessageAt) > baseline;
          const hasNewTodo = Array.isArray(current.todos)
            && current.todos.some((todo) => Number(todo?.createdAt) > baseline);
          if (hasNewUserMessage || hasNewTodo) {
            completedTodoSessions.delete(key);
          }
        }
        return data.cards.filter((card) => !isHiddenIdleCard(card) && !completedTodoSessions.has(todoCompletionKey(card)));
      }

      /**
       * 用顶栏 `/dsh-au/api` 的实时 `sessionStatesV2` 对账并补齐跨设备卡片：
       * 即使宿主服务端尚未重启或远端活跃会话排在旧接口 50 条之外，也能立即亮灯并支持 F11 轮流跳转。
       */
      function reconcileCardsWithAuSnap(rawCards, snap, localDeviceId) {
        const list = (Array.isArray(rawCards) ? rawCards : [])
          .filter((card) => card && !isHiddenIdleCard(card) && !completedTodoSessions.has(todoCompletionKey(card)));
        for (const card of list) {
          if (card?.sessionId && card.title && !String(card.title).endsWith('待处理对话')) {
            remoteSessionMetaCache.set(card.sessionId, {
              sessionId: card.sessionId,
              title: card.title,
              summary: card.summary || '',
              workspace: card.workspace || '',
              updatedAt: Number(card.updatedAt) || Date.now(),
            });
          }
        }
        const auSnap = snap || (typeof window !== 'undefined' ? window.__dshAuLastStateSnap : null);
        if (!auSnap || typeof auSnap !== 'object') return list;

        const now = Date.now();
        for (const [k, ts] of locallyConfirmedRemoteSessions.entries()) {
          if (now - ts > 8000) locallyConfirmedRemoteSessions.delete(k);
        }

        const selfId = auSnap.self?.deviceId || localDeviceId || '';
        const localLights = new Map();
        if (auSnap.self?.sessionStatesV2 && typeof auSnap.self.sessionStatesV2 === 'object') {
          for (const [sid, light] of Object.entries(auSnap.self.sessionStatesV2)) {
            if (typeof light === 'string') localLights.set(sid, light);
          }
        }
        if (Array.isArray(auSnap.self?.sessions)) {
          for (const item of auSnap.self.sessions) {
            const sid = item?.id || item?.sessionId;
            const light = item?.statusV2 || item?.status;
            if (sid && typeof light === 'string') localLights.set(sid, light);
          }
        }

        const lightPriority = { error: 5, waiting: 4, done: 3, busy: 2, running: 2, idle: 1 };
        const remoteDevices = new Map();
        const deviceDefs = Array.isArray(auSnap.devices) ? auSnap.devices : [];
        for (const remote of Array.isArray(auSnap.remotes) ? auSnap.remotes : []) {
          if (!remote || remote.online === false) continue;
          const devId = remote.deviceId || remote.id;
          if (!devId || devId === 'local' || (selfId && devId === selfId) || (localDeviceId && devId === localDeviceId)) continue;
          const def = deviceDefs.find((d) => d.id === devId);
          const devName = def?.name || remote.name || devId;
          let entry = remoteDevices.get(devId);
          if (!entry) {
            entry = { deviceId: devId, deviceName: devName, lights: new Map(), fromSidebar: new Set() };
            remoteDevices.set(devId, entry);
          }
          if (remote.sessionStatesV2 && typeof remote.sessionStatesV2 === 'object') {
            for (const [sid, light] of Object.entries(remote.sessionStatesV2)) {
              if (typeof sid !== 'string' || typeof light !== 'string') continue;
              const prev = entry.lights.get(sid);
              if (!prev || (lightPriority[light] || 0) > (lightPriority[prev] || 0)) {
                entry.lights.set(sid, light);
              }
            }
          }
        }

        // 复用左侧边栏已融合的实时远端会话状态（含受控 iframe 实时推送的 completionUnread 绿点与 waiting/error/done 状态）
        try {
          remoteWorkspacesClient?.helpers?.rebuildNativeRemoteRegistry?.();
          const rwStore = remoteWorkspacesClient?.helpers?.store;
          if (rwStore?.nativeSessionById instanceof Map) {
            for (const [sid, entry] of rwStore.nativeSessionById.entries()) {
              const s = entry?.session;
              const ws = entry?.ws;
              const devId = ws?.deviceId;
              if (!sid || !devId || !s) continue;
              // 缓存远端会话元数据（标题、摘要、工作区等），以便合成卡片时显示真实标题
              if (s.title && !String(s.title).endsWith('待处理对话')) {
                remoteSessionMetaCache.set(sid, {
                  sessionId: sid,
                  title: s.title,
                  summary: s.summary || '',
                  workspace: s.workspace || ws.workspaceName || ws.title || '',
                  updatedAt: Number(s.updatedAt) || now,
                });
              }
              const liveLight = (s.status === 'error' || s.status === 'waiting' || s.status === 'done' || s.status === 'busy')
                ? s.status
                : (s.completionUnread ? 'done' : 'idle');
              // 仅当实时灯色有效，且（不是服务端过时列表 || 是已完成/等待/错误状态 || 明确标记未读）时采纳
              if (liveLight !== 'idle' && (!entry.session?.fromServer || liveLight === 'done' || liveLight === 'waiting' || liveLight === 'error' || s.completionUnread)) {
                let devEntry = remoteDevices.get(devId);
                if (!devEntry) {
                  devEntry = { deviceId: devId, deviceName: ws.deviceName || devId, lights: new Map(), fromSidebar: new Set() };
                  remoteDevices.set(devId, devEntry);
                }
                if ((lightPriority[liveLight] || 0) >= (lightPriority[devEntry.lights.get(sid)] || 0)) {
                  devEntry.lights.set(sid, liveLight);
                }
                // 来自受控 iframe 实时推送（非服务端旧列表）或有未读完成标记的会话，记录到 fromSidebar
                if (!s.fromServer || s.completionUnread) {
                  devEntry.fromSidebar?.add(sid);
                }
              }
            }
          }
        } catch {}

        const updated = list.map((card) => {
          if (!card?.sessionId) return card;
          if (isLocalCard(card, localDeviceId || selfId)) {
            const localLight = localLights.get(card.sessionId);
            if (localLight === 'idle' && (card.status === 'done' || card.status === 'error' || card.status === 'busy' || card.status === 'waiting')) {
              return { ...card, status: 'idle' };
            }
            // 允许从 idle 或 busy/running/waiting 正常流转到最新灯色（如 busy 跑完变成 done/waiting/error）
            if (localLight && localLight !== 'idle' && localLight !== card.status) {
              return { ...card, status: localLight };
            }
            return card;
          }
          const confirmKey = `${card.deviceId}:${card.sessionId}`;
          if (locallyConfirmedRemoteSessions.has(confirmKey) && (card.status === 'done' || card.status === 'error')) {
            return { ...card, status: 'idle' };
          }
          const remoteEntry = remoteDevices.get(card.deviceId);
          const remoteLight = remoteEntry?.lights.get(card.sessionId);
          if (locallyConfirmedRemoteSessions.has(confirmKey) && (remoteLight === 'done' || remoteLight === 'error')) {
            return { ...card, status: 'idle' };
          }
          if (remoteLight === 'idle' && (card.status === 'busy' || card.status === 'waiting')) {
            return { ...card, status: 'idle' };
          }
          // 允许从 idle 或 busy/running/waiting 正常流转到最新远端灯色（解决 busy 会话完成后卡在 busy 不被快捷键识别的问题）
          if (remoteLight && remoteLight !== 'idle' && remoteLight !== card.status) {
            return { ...card, status: remoteLight };
          }
          return card;
        }).filter((card) => !isHiddenIdleCard(card));

        const presentIds = new Set(updated.map((card) => card?.sessionId).filter(Boolean));
        // 本机会话补齐：当未拉取到本机权威待办列表时（例如面板未展开过仅靠快照对账），
        // 若快照检测到本机有待处理状态且未在列表中，合成并补齐本机待处理卡片
        for (const [sessionId, light] of localLights.entries()) {
          if (!light || light === 'idle' || presentIds.has(sessionId)) continue;
          const confirmKey = `${selfId || 'local'}:${sessionId}`;
          const localKey = `local:${sessionId}`;
          if (!authoritativeTodoDeviceIds.has(selfId) && !completedTodoSessions.has(confirmKey) && !completedTodoSessions.has(localKey)) {
            presentIds.add(sessionId);
            const meta = remoteSessionMetaCache.get(sessionId)
              || remoteWorkspacesClient?.helpers?.store?.nativeSessionById?.get?.(sessionId)?.session;
            const updatedAt = Number(meta?.updatedAt) || now;
            updated.push({
              deviceId: selfId || 'local',
              deviceName: auSnap.self?.hostname || '本机',
              sessionId,
              title: meta?.title || '本机待处理对话',
              summary: meta?.summary || '检测到待处理状态，点击或按快捷键直接跳转',
              workspace: meta?.workspace || '本机',
              updatedAt,
              priority: 'P4',
              sortOrder: -updatedAt,
              todos: [],
              pinned: false,
              hidden: false,
              status: light,
              isLocal: true,
            });
          }
        }

        for (const [devId, entry] of remoteDevices.entries()) {
          for (const [sessionId, light] of entry.lights.entries()) {
            if (!light || light === 'idle' || presentIds.has(sessionId)) continue;
            const confirmKey = `${devId}:${sessionId}`;
            // 所属设备已经返回完整待办列表时，缺席可能是完成隐藏，不能用旧探针灯色猜测补卡；
            // 但若侧边栏受控 iframe 实时明确报告了该会话（entry.fromSidebar）且未被本地完成隐藏，则允许合成补齐。
            if (completedTodoSessions.has(confirmKey)) continue;
            if (authoritativeTodoDeviceIds.has(devId) && !entry.fromSidebar?.has(sessionId)) continue;
            if (locallyConfirmedRemoteSessions.has(confirmKey) && (light === 'done' || light === 'error')) continue;
            presentIds.add(sessionId);
            const meta = remoteSessionMetaCache.get(sessionId)
              || remoteWorkspacesClient?.helpers?.store?.nativeSessionById?.get?.(sessionId)?.session;
            const updatedAt = Number(meta?.updatedAt) || now;
            updated.push({
              deviceId: devId,
              deviceName: entry.deviceName,
              sessionId,
              title: meta?.title || `${entry.deviceName} 待处理对话`,
              summary: meta?.summary || '远端设备检测到待处理状态，点击或按快捷键直接跳转',
              workspace: meta?.workspace || entry.deviceName,
              updatedAt,
              priority: 'P4',
              sortOrder: -updatedAt,
              todos: [],
              pinned: false,
              hidden: false,
              status: light,
              isLocal: false,
            });
          }
        }
        return updated;
      }

      let lastConfirmedSelectionKey = '';
      const lastConfirmedNativeEnds = new Map();
      const pendingNativeConfirmationEnds = new Map();

      /** Capture the event's completed end, never fill an old click's missing watermark from a later poll. */
      function observeNativeSessionCompletion(sessionId, self = window.__dshAuLastStateSnap?.self) {
        const row = Array.isArray(self?.sessions) ? self.sessions.find((item) => (item?.id || item?.sessionId) === sessionId) : null;
        // Controlled frames have no outer shell; their poll already owns the same backend details cache.
        const detail = self?.sessionStateDetails?.[sessionId] || (isControlledFrame() ? controlledSessionStateDetails.get(sessionId) : null) || row;
        const versioned = self?.sessionStateVersion >= 1 || Boolean(self?.sessionStateDetails)
          || (isControlledFrame() && controlledBackendStateVersion >= 1)
          || Number.isSafeInteger(detail?.stateSeq) || Number.isSafeInteger(detail?.endSeq);
        let status = String(detail?.statusV2 || detail?.status || self?.sessionStatesV2?.[sessionId] || '').toLowerCase();
        const nativeMap = readControlledRawStatusMap(controlledClientCtx);
        const nativeSt = nativeMap instanceof Map ? nativeMap.get(sessionId) : nativeMap?.[sessionId];
        if (nativeSt?.running === true) status = 'busy';
        else if (nativeSt?.pendingInteraction) status = 'waiting';
        const completed = status === 'done' || status === 'error';
        const endSeq = completed && Number.isSafeInteger(detail?.endSeq) && detail.endSeq >= 0
          && Number.isSafeInteger(detail?.stateSeq) && detail.endSeq <= detail.stateSeq
          && Number(detail?.ackedSeq ?? -1) < detail.endSeq
          && detail.endSeq > (controlledNativeTurnFloor.get(sessionId) ?? -1)
          && (!hasControlledStateVersion(nativeSt) || nativeSt.endSeq === detail.endSeq)
          ? detail.endSeq : undefined;
        return { versioned, status, endSeq };
      }

      function confirmLocalSessionNow(sessionId, { force = false, observed = observeNativeSessionCompletion(sessionId) } = {}) {
        if (typeof sessionId !== 'string' || !sessionId || /^(busy|running|waiting)$/.test(observed.status)) return;
        // New peers require the exact observed completed end; legacy peers keep their existing API shape.
        if (observed.versioned && !Number.isSafeInteger(observed.endSeq)) return;
        const now = Date.now();
        const key = `${sessionId}:${Math.floor(now / 1200)}`;
        if (observed.versioned) {
          if ((lastConfirmedNativeEnds.get(sessionId) ?? -1) >= observed.endSeq
            || pendingNativeConfirmationEnds.get(sessionId) === observed.endSeq) return;
          pendingNativeConfirmationEnds.set(sessionId, observed.endSeq);
        } else if (!force && lastConfirmedSelectionKey === key) return;
        lastConfirmedSelectionKey = key;
        const watermark = observed.versioned ? { expectedEndSeq: observed.endSeq } : {};
        let published = false;
        const publishConfirmed = (result) => {
          const accepted = observed.versioned ? result?.ok === true && result?.confirmed === true
            : result && result.ok !== false && result.confirmed !== false;
          if (!accepted || published) return;
          published = true;
          if (observed.versioned) {
            // An older response cannot overwrite or publish after a newer completed end was confirmed.
            if ((lastConfirmedNativeEnds.get(sessionId) ?? -1) >= observed.endSeq) return;
            lastConfirmedNativeEnds.set(sessionId, observed.endSeq);
            if (lastConfirmedNativeEnds.size > 200) lastConfirmedNativeEnds.delete(lastConfirmedNativeEnds.keys().next().value);
          }
          if (typeof window?.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
            window.dispatchEvent(new CustomEvent('dsh-au:refresh-state'));
          }
          if (isControlledFrame()) {
            try {
              window.top?.postMessage({ source: 'dsh-au', type: 'remote-session-confirmed', sessionId,
                ...(observed.versioned ? { endSeq: observed.endSeq } : {}),
              }, '*');
            } catch {}
          }
        };
        const primary = fetch('/dsh-au/api', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'confirmSession', sessionId, ...watermark }),
        }).then((response) => response.ok ? response.json() : null).catch(() => null);
        const todo = callApi('confirmSession', { deviceId: 'local', sessionId, ...watermark }).catch(() => null);
        // Either API's real confirmation is enough. If both fail, release only this attempt so a new click retries its captured end.
        void Promise.all([primary.then(publishConfirmed), todo.then(publishConfirmed)]).then(() => {
          if (observed.versioned && pendingNativeConfirmationEnds.get(sessionId) === observed.endSeq) pendingNativeConfirmationEnds.delete(sessionId);
        });
      }

      /** 被控远端 iframe 不渲染第二面板，只接收外层经过 dsh-au 的安全设备切换后发来的选会话消息，并向顶层同步会话摘要。 */
      function installControlledSessionBridge(sessions) {
        const publishMeta = () => {
          const items = extractControlledSessionsMeta(sessions);
          if (!items.length) return;
          try {
            window.top?.postMessage({ source: 'dsh-au-todo', type: REMOTE_SESSIONS_META_MESSAGE, sessions: items }, '*');
          } catch {}
        };
        publishMeta();
        let metaTimer = null;
        const unsubscribe = typeof sessions?.list?.subscribe === 'function'
          ? sessions.list.subscribe(() => {
              if (metaTimer) return;
              metaTimer = window.setTimeout(() => {
                metaTimer = null;
                publishMeta();
              }, 1200);
            })
          : null;
        const onMessage = (event) => {
          if (event.data?.source === 'dsh-au' && event.data?.type === 'frame-probe') {
            publishMeta();
            return;
          }
          if (event.data?.source !== 'dsh-au-todo' || event.data?.type !== SELECT_SESSION_MESSAGE) return;
          if (typeof event.data.sessionId !== 'string') return;
          if (typeof event.data.deviceId === 'string' && event.data.deviceId
            && typeof window.name === 'string' && window.name.startsWith(CONTROLLED_FRAME_PREFIX)
            && window.name !== `${CONTROLLED_FRAME_PREFIX}${event.data.deviceId}`) {
            return;
          }
          openNativeSession(event.data.sessionId);
          confirmLocalSessionNow(event.data.sessionId, { force: true });
        };
        window.addEventListener('message', onMessage);
        return () => {
          if (metaTimer) window.clearTimeout(metaTimer);
          try { unsubscribe?.(); } catch {}
          window.removeEventListener('message', onMessage);
        };
      }

      /**
       * 无论跨设备 Todo 面板是否展开、也无论当前窗口是外层页还是被控远端 iframe：
       * 1) 用户在左侧栏切换会话（selectedSession 变化）；
       * 2) 用户点击左侧栏中已处于选中态的当前会话，或在当前主对话区点击/按键交互；
       * 3) 用户正停留在某个活跃交互中的对话，该对话完成本轮输出变成 done/error；
       * 都立即触发本机 confirmSession，消除残留蓝灯。
       */
      function installNativeSessionConfirmBridge(sessions) {
        const currentSession = selectedSessionSource(sessions);
        if (!currentSession || typeof currentSession.subscribe !== 'function') return () => {};
        let prev = typeof currentSession.get === 'function' ? (currentSession.get() || '') : '';
        let interactedSessionId = '';
        let interactedCompletion = null;
        const isLocalViewVisible = () => (
          typeof document === 'undefined' || (document.visibilityState !== 'hidden'
            && (typeof document.hasFocus !== 'function' || document.hasFocus())
            && !document.documentElement?.hasAttribute('data-dsh-au-remote-active'))
        );
        const confirmInteraction = (sessionId, force = false) => {
          const observed = observeNativeSessionCompletion(sessionId);
          interactedSessionId = sessionId;
          interactedCompletion = observed.versioned && Number.isSafeInteger(observed.endSeq) ? observed : null;
          confirmLocalSessionNow(sessionId, { force, observed });
        };
        const unsubscribe = currentSession.subscribe((next) => {
          const nextSessionId = typeof next === 'string' ? next : '';
          if (prev !== nextSessionId) {
            interactedSessionId = '';
            interactedCompletion = null;
            // A background/preheated mainView retention is not a user opening the completed conversation.
            if (nextSessionId && isLocalViewVisible()) {
              confirmInteraction(nextSessionId, true);
              if (!isControlledFrame()) {
                remoteWorkspacesClient?.helpers?.scrollSidebarToSession?.(nextSessionId, { isLocal: true });
              }
            }
          }
          prev = nextSessionId;
        });
        const onPointerDown = (event) => {
          if (!isLocalViewVisible() || event?.isTrusted === false) return;
          const target = event?.target;
          if (!(target instanceof Element)) return;
          if (target.closest('.dsh-au-top-wrap, .dsh-au-floating-wrap, .dsh-au-todo-dock, .dsh-au-mask')) return;
          const currentId = typeof currentSession.get === 'function' ? (currentSession.get() || '') : prev;
          if (!currentId) return;
          const inSidebar = Boolean(target.closest('[data-slot="sidebar"], aside, nav, [role="navigation"]'));
          const inMain = Boolean(target.closest('[data-slot="main"], main, [data-composer-seat], [data-slot^="conversation"], textarea, [contenteditable="true"]'));
          if (inSidebar || inMain) {
            confirmInteraction(currentId);
          }
        };
        const onKeyDown = (event) => {
          if (!isLocalViewVisible() || event?.isTrusted === false) return;
          if (findShortcutAction(event)) return;
          const target = event?.target;
          if (target instanceof Element && target.closest('.dsh-au-todo-dock, .dsh-au-mask')) return;
          const currentId = typeof currentSession.get === 'function' ? (currentSession.get() || '') : prev;
          if (!currentId) return;
          confirmInteraction(currentId);
        };
        const onSelfState = (event) => {
          if (!isLocalViewVisible()) return;
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          const currentId = typeof currentSession.get === 'function' ? (currentSession.get() || '') : prev;
          if (!currentId) return;
          const sessionsList = event?.detail?.sessions;
          if (!Array.isArray(sessionsList)) return;
          const item = sessionsList.find((session) => session?.id === currentId);
          if (!item) return;
          const observed = observeNativeSessionCompletion(currentId, event.detail);
          if (observed.versioned) {
            // Never retroactively give a previous busy/hidden click the newly arrived completed end.
            if (Number.isSafeInteger(observed.endSeq) && interactedSessionId === currentId && interactedCompletion?.endSeq === observed.endSeq) {
              confirmLocalSessionNow(currentId, { force: true, observed: interactedCompletion });
            }
            return;
          }
          const status = item.statusV2 || item.status;
          if (status === 'busy' || status === 'running' || status === 'waiting') {
            interactedSessionId = currentId;
            return;
          }
          if ((status === 'done' || status === 'error') && interactedSessionId === currentId) {
            confirmLocalSessionNow(currentId, { force: true, observed });
          }
        };
        window.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('focusin', onPointerDown, true);
        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('input', onKeyDown, true);
        window.addEventListener('dsh-au:self-state', onSelfState);
        return () => {
          try { unsubscribe?.(); } catch {}
          window.removeEventListener('pointerdown', onPointerDown, true);
          window.removeEventListener('focusin', onPointerDown, true);
          window.removeEventListener('keydown', onKeyDown, true);
          window.removeEventListener('input', onKeyDown, true);
          window.removeEventListener('dsh-au:self-state', onSelfState);
        };
      }

      /** 全局跨设备会话缓存与待处理游标（供快捷键秒切最新未读/待处理对话，完全独立于 Todo 面板开闭）。 */
      let globalCachedCards = [];
      let globalLocalDeviceId = '';
      let globalCycleCursor = -1;
      let globalCardsFetchedOnce = false;

      /** 同步 Todo 面板卡片选中状态至远程工作区 store 与左侧原生侧边栏，打通双向高亮与会话导航。 */
      function syncSidebarSelectionFromTodo(card, isLocal) {
        if (!card?.sessionId) return;
        const rwHelpers = typeof remoteWorkspacesClient !== 'undefined' ? remoteWorkspacesClient.helpers : null;
        const store = rwHelpers?.store;
        if (isLocal) {
          if (store && store.activeDeviceId) {
            store.activeDeviceId = null;
            rwHelpers.notifyStoreListeners?.();
          }
          rwHelpers?.scrollSidebarToSession?.(card.sessionId, { isLocal: true, workspaceId: card.workspaceId || '' });
          return;
        }
        if (typeof rwHelpers?.syncExternalRemoteSelection === 'function') {
          rwHelpers.syncExternalRemoteSelection(card);
        }
      }

      function dispatchDeviceAndSessionGlobal(card, { localDeviceId = globalLocalDeviceId, openSession = openWorkspaceSession } = {}) {
        const markVisited = (devId) => {
          if (typeof window === 'undefined') return;
          const set = window[INITIAL_FOCUS_VISITS_KEY] instanceof Set
            ? window[INITIAL_FOCUS_VISITS_KEY]
            : (window[INITIAL_FOCUS_VISITS_KEY] = new Set());
          set.add(devId);
        };
        const effectiveLocalId = localDeviceId || globalLocalDeviceId;
        const isLocal = isLocalCard(card, effectiveLocalId);
        // 同步侧边栏与远端 store 状态
        syncSidebarSelectionFromTodo(card, isLocal);
        if (!isLocal) {
          markVisited(card.deviceId);
          window.dispatchEvent(new CustomEvent(DEVICE_SELECT_EVENT, { detail: { deviceId: card.deviceId } }));
          // syncSidebarSelectionFromTodo 已通过 sendOrQueueRemoteCommand 发送带 commandId/selectionSeq 的可靠指令；
          // 若此处再盲发无序号的 select-session 定时器，会反复把受控端正在异步打开的导航打断为 superseded。
          if (typeof remoteWorkspacesClient?.helpers?.syncExternalRemoteSelection === 'function') {
            return;
          }
          const message = { source: 'dsh-au-todo', type: SELECT_SESSION_MESSAGE, sessionId: card.sessionId, deviceId: card.deviceId };
          pendingRemoteSelections.set(card.deviceId, { message, expiresAt: Date.now() + 15000 });
          const getTargetFrames = () => {
            if (typeof document?.querySelectorAll !== 'function') return [];
            const exact = document.querySelectorAll(`iframe[name="${CONTROLLED_FRAME_PREFIX}${card.deviceId}"]`);
            if (exact.length) return exact;
            return document.querySelectorAll('iframe[name^="dsh-au-controlled:"], .dsh-au-stage iframe');
          };
          const notifyFrame = () => {
            for (const frame of getTargetFrames()) {
              frame.contentWindow?.postMessage(message, '*');
            }
          };
          notifyFrame();
          window.setTimeout?.(() => {
            notifyFrame();
            for (const frame of getTargetFrames()) {
              frame.addEventListener?.('load', () => {
                frame.contentWindow?.postMessage(message, '*');
                window.setTimeout?.(() => frame.contentWindow?.postMessage(message, '*'), 250);
                window.setTimeout?.(() => frame.contentWindow?.postMessage(message, '*'), 900);
                window.setTimeout?.(() => frame.contentWindow?.postMessage(message, '*'), 2200);
              }, { once: true });
            }
          }, 80);
          for (const delay of [350, 1100, 2200, 4000, 6500]) {
            window.setTimeout?.(notifyFrame, delay);
          }
          return;
        }
        markVisited('local');
        window.dispatchEvent(new CustomEvent(DEVICE_SELECT_EVENT, { detail: { deviceId: 'local', reason: 'todo-open-local' } }));
        openNativeSession(card.sessionId, openSession);
      }

      async function navigateToCardGlobal(card, { confirm = true, localDeviceId = globalLocalDeviceId, openSession = openWorkspaceSession } = {}) {
        if (!card?.sessionId) return;
        if (isMobileOrTouchViewport()) {
          setTodoPanelOpen(false);
        }
        if (typeof window?.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
          window.dispatchEvent(new CustomEvent('dsh-au:todo-card-navigated', { detail: { card } }));
        }
        dispatchDeviceAndSessionGlobal(card, { localDeviceId, openSession });
        if (confirm && (card.status === 'done' || card.status === 'error')) {
          const effectiveLocalId = localDeviceId || globalLocalDeviceId;
          if (!isLocalCard(card, effectiveLocalId)) {
            locallyConfirmedRemoteSessions.set(`${card.deviceId}:${card.sessionId}`, Date.now());
          }
          // 乐观将该会话在全局缓存中标为 idle，避免网络确认期间再次按键重复命中同一会话
          globalCachedCards = sortCardsForDisplay(globalCachedCards.map((item) =>
            item.deviceId === card.deviceId && item.sessionId === card.sessionId
              ? { ...item, status: 'idle' }
              : item));
          try {
            await callApi('confirmSession', { deviceId: card.deviceId, sessionId: card.sessionId });
            if (!isLocalCard(card, effectiveLocalId) && card.deviceId) {
              await fetch('/dsh-au/api', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'probeRemote', deviceId: card.deviceId }),
              }).catch(() => {});
            }
            if (typeof window?.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
              window.dispatchEvent(new CustomEvent('dsh-au:refresh-state'));
            }
          } catch {}
        }
      }

      /** 静默预热或拉取最新的全局会话列表（即使面板从未展开过）。 */
      async function syncGlobalCards() {
        const completionRevision = todoCompletionRevision;
        try {
          let auSnap = typeof window !== 'undefined' ? window.__dshAuLastStateSnap : null;
          const [data, fetchedSnap] = await Promise.all([
            callApi('getState'),
            !auSnap
              ? fetch('/dsh-au/api', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ action: 'getState' }),
                }).then((r) => r.json()).catch(() => null)
              : Promise.resolve(null),
          ]);
          if (completionRevision !== todoCompletionRevision) return globalCachedCards;
          if (fetchedSnap?.ok && typeof window !== 'undefined') {
            window.__dshAuLastStateSnap = fetchedSnap;
            auSnap = fetchedSnap;
          }
          if (Array.isArray(data.cards)) {
            if (typeof data.localDeviceId === 'string' && data.localDeviceId) {
              globalLocalDeviceId = data.localDeviceId;
            }
            globalCachedCards = sortCardsForDisplay(reconcileCardsWithAuSnap(applyTodoCompletionState(data), auSnap, globalLocalDeviceId));
            globalCardsFetchedOnce = true;
          }
        } catch {}
        return globalCachedCards;
      }

      /**
       * 轮流跳转待处理/未读会话（Ctrl+Delete 全局核心入口）：
       * 完全独立于 Todo 面板生命周期，面板未展开或功能未开启时同样秒级响应。
       */
      async function cycleWaitingSessionGlobal(openSession = openWorkspaceSession) {
        if (typeof window !== 'undefined' && window.__dshAuLastStateSnap) {
          const auSnap = window.__dshAuLastStateSnap;
          if (auSnap?.self?.deviceId && !globalLocalDeviceId) {
            globalLocalDeviceId = auSnap.self.deviceId;
          }
          globalCachedCards = sortCardsForDisplay(reconcileCardsWithAuSnap(globalCachedCards, auSnap, globalLocalDeviceId));
        }
        let pool = globalCachedCards.filter((card) => card.status === 'done' || card.status === 'error' || card.status === 'waiting');
        if (!pool.length && !globalCardsFetchedOnce) {
          // 按下瞬间 0ms 立即给出反馈，避免首次拉取期间用户感觉按键无响应
          showTodoCycleNotice('正在检查未读对话...');
          const fresh = await syncGlobalCards();
          pool = fresh.filter((card) => card.status === 'done' || card.status === 'error' || card.status === 'waiting');
        }
        if (!pool.length) {
          showTodoCycleNotice(globalCardsFetchedOnce ? '当前没有待确认的对话' : '暂时无法读取对话状态，请稍后重试');
          return false;
        }
        globalCycleCursor = (globalCycleCursor + 1) % pool.length;
        const target = pool[globalCycleCursor];
        const targetTitle = typeof target?.title === 'string' && target.title.trim() && !target.title.endsWith('待处理对话')
          ? `：${target.title.trim()}`
          : '';
        showTodoCycleNotice(`正在切换到下一个未读对话${targetTitle}...`);
        await navigateToCardGlobal(target, { confirm: true, openSession });
        return true;
      }

      /** 常驻安装全局待处理会话快捷键轮流跳转服务。 */
      function installGlobalWaitingSessionCycleService(ctx) {
        const onKeyDown = (event) => {
          if (event.defaultPrevented || findShortcutAction(event) !== 'todo.cycle') return;
          event.preventDefault();
          void cycleWaitingSessionGlobal();
        };

        const onCycleEvent = () => {
          void cycleWaitingSessionGlobal();
        };

        // 仅在面板已打开或此前已拉取过时才触发网络刷新，彻底解耦全局快捷键与后台静默扫盘
        const onRefreshState = () => {
          if (todoPanelOpen || globalCardsFetchedOnce) {
            void syncGlobalCards();
          }
        };

        // 收到设备状态快照时，仅纯内存对账更新卡片，零网络/磁盘 IO 开销
        const onSelfStateForGlobal = (event) => {
          const auSnap = event?.detail?._auSnap || (typeof window !== 'undefined' ? window.__dshAuLastStateSnap : null);
          if (auSnap?.self?.deviceId && !globalLocalDeviceId) globalLocalDeviceId = auSnap.self.deviceId;
          if (auSnap) {
            globalCachedCards = sortCardsForDisplay(reconcileCardsWithAuSnap(globalCachedCards, auSnap, globalLocalDeviceId));
          }
        };

        // 监听其他模块发起的 Todo 状态拉取结果，保持全局卡片缓存同步
        const onTodoStateData = (event) => {
          const data = event?.detail;
          if (data && Array.isArray(data.cards)) {
            if (typeof data.localDeviceId === 'string' && data.localDeviceId) {
              globalLocalDeviceId = data.localDeviceId;
            }
            const auSnap = typeof window !== 'undefined' ? window.__dshAuLastStateSnap : null;
            globalCachedCards = sortCardsForDisplay(reconcileCardsWithAuSnap(applyTodoCompletionState(data), auSnap, globalLocalDeviceId));
            globalCardsFetchedOnce = true;
          }
        };

        // 挂载时若已有其他模块拉取好的待办数据或顶栏状态快照，立即初始化进内存，确保首次按键也无需等待网络
        if (typeof window !== 'undefined' && window.__dshAuLastTodoStateData) {
          onTodoStateData({ detail: window.__dshAuLastTodoStateData });
        } else if (typeof window !== 'undefined' && window.__dshAuLastStateSnap) {
          onSelfStateForGlobal({ detail: { _auSnap: window.__dshAuLastStateSnap } });
        }

        // 订阅侧边栏 store 变更监听器：受控 iframe 收到完成快照并亮绿点时，毫秒级同步更新内存中的全局卡片缓存
        const onSidebarStoreChange = () => {
          const auSnap = typeof window !== 'undefined' ? window.__dshAuLastStateSnap : null;
          globalCachedCards = sortCardsForDisplay(reconcileCardsWithAuSnap(globalCachedCards, auSnap, globalLocalDeviceId));
        };
        remoteWorkspacesClient?.helpers?.store?.listeners?.add?.(onSidebarStoreChange);

        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener(TODO_CYCLE_EVENT, onCycleEvent);
        window.addEventListener('dsh-au:refresh-state', onRefreshState);
        window.addEventListener('dsh-au:self-state', onSelfStateForGlobal);
        window.addEventListener('dsh-au:todo-state-data', onTodoStateData);

        return () => {
          remoteWorkspacesClient?.helpers?.store?.listeners?.delete?.(onSidebarStoreChange);
          window.removeEventListener('keydown', onKeyDown, true);
          window.removeEventListener(TODO_CYCLE_EVENT, onCycleEvent);
          window.removeEventListener('dsh-au:refresh-state', onRefreshState);
          window.removeEventListener('dsh-au:self-state', onSelfStateForGlobal);
          window.removeEventListener('dsh-au:todo-state-data', onTodoStateData);
        };
      }

      /** 复用侧栏的真实远端选中状态，先将连接路由 ID 归到设备，避免仍高亮后台保留的本机会话。 */
      function readTodoRemoteSelection() {
        const store = typeof remoteWorkspacesClient !== 'undefined' ? remoteWorkspacesClient?.helpers?.store : null;
        if (!store) return { deviceId: '', sessionId: '' };
        const activeId = store.activeDeviceId;
        if (!activeId || activeId === 'local' || activeId === store.localDeviceId) return { deviceId: '', sessionId: '' };
        const device = (store.devices || []).find((item) => item.id === activeId || item.deviceId === activeId
          || item.selectedRoute?.id === activeId || item.routes?.some((route) => route.id === activeId));
        const deviceId = device?.deviceId || device?.id || activeId;
        const sessionId = store.selectedSessionByDevice?.get?.(deviceId) || store.selectedSessionByDevice?.get?.(activeId)
          || store.controlledSnapshots?.get?.(deviceId)?.currentSessionId || store.controlledSnapshots?.get?.(activeId)?.currentSessionId || '';
        return { deviceId, sessionId };
      }

      /** 只滚动 TODO 的内部列表，并仅移动让卡片进入可见区所需的距离，不改变页面或输入焦点。 */
      function revealTodoCard(list, card) {
        if (!list || !card || list.clientHeight <= 0) return false;
        const top = list.getBoundingClientRect().top + list.clientTop;
        const bottom = top + list.clientHeight;
        const bounds = card.getBoundingClientRect();
        if (bounds.top < top || bounds.height > list.clientHeight) list.scrollTop += bounds.top - top;
        else if (bounds.bottom > bottom) list.scrollTop += bounds.bottom - bottom;
        return true;
      }

      function TodoDockInner({ openSession, useSelectedSession = () => '' }) {
        const [panelOpen, setPanelOpen] = useTodoPanelOpen();
        const panelAnchor = useTodoPanelAnchor();
        const selectedSessionId = useSelectedSession((sessionId) => sessionId) || '';
        const [remoteSelection, setRemoteSelection] = useState(readTodoRemoteSelection);
        useEffect(() => {
          const store = remoteWorkspacesClient.helpers.store;
          const syncSelection = () => {
            const next = readTodoRemoteSelection();
            setRemoteSelection((current) => current.deviceId === next.deviceId && current.sessionId === next.sessionId ? current : next);
          };
          store.listeners.add(syncSelection);
          syncSelection();
          return () => store.listeners.delete(syncSelection);
        }, []);
        const [cards, setCards] = useState([]);
        const [localDeviceId, setLocalDeviceId] = useState('');
        const [notice, setNotice] = useState('');
        // 首次拉取完成前为 true；列表为空时据此显示 loading 而不是“没有数据”。
        const [loading, setLoading] = useState(true);
        const [drafts, setDrafts] = useState({});
        const [expandedCards, setExpandedCards] = useState(() => new Set());
        const [dragging, setDragging] = useState('');
        const [dropTarget, setDropTarget] = useState('');
        const f11Cursor = useRef(-1);
        // 首次挂载只记录宿主已有选中项；之后的原生切换才等同于用户已查看该会话。
        const previousNativeSelectionId = useRef(null);
        const pendingNativeSelectionId = useRef('');
        const refreshInFlightRef = useRef(false);
        const hasPreloadedRef = useRef(false);
        const lastSelfDigestRef = useRef('');
        const inputRefs = useRef(new Map());
        const listRef = useRef(null);
        const cardRefs = useRef(new Map());
        const lastRevealedCardKey = useRef('');
        const cardKey = (card) => `${card.deviceId}:${card.sessionId}`;
        // 兼容 card.deviceId 可能是设备 ID 或路由 ID 的差异：当 sessionId 匹配且属于当前活动远端设备（非本机）时判定为选中
        const rwStore = remoteWorkspacesClient.helpers.store;
        const selectedCard = cards.find((card) => remoteSelection.deviceId
          ? card.sessionId === remoteSelection.sessionId && (card.deviceId === remoteSelection.deviceId || card.deviceId === rwStore?.activeDeviceId || !isLocalCard(card, localDeviceId))
          : isLocalCard(card, localDeviceId) && card.sessionId === selectedSessionId);
        const selectedCardKey = selectedCard ? cardKey(selectedCard) : '';
        useEffect(() => {
          if (!panelOpen || !selectedCardKey) { lastRevealedCardKey.current = ''; return; }
          // 同一选中项的轮询重绘不反复拉回滚动位置；晚到的卡片和重新打开面板仍会定位。
          if (lastRevealedCardKey.current === selectedCardKey) return;
          if (revealTodoCard(listRef.current, cardRefs.current.get(selectedCardKey))) lastRevealedCardKey.current = selectedCardKey;
        }, [cards, panelOpen, selectedCardKey]);
        const collapseCard = (card) => setExpandedCards((current) => {
          const key = cardKey(card);
          if (!current.has(key)) return current;
          const next = new Set(current);
          next.delete(key);
          return next;
        });

        const refresh = useCallback(async () => {
          if (refreshInFlightRef.current) return;
          refreshInFlightRef.current = true;
          const completionRevision = todoCompletionRevision;
          try {
            let auSnap = typeof window !== 'undefined' ? window.__dshAuLastStateSnap : null;
            const [data, fetchedSnap] = await Promise.all([
              callApi('getState'),
              !auSnap
                ? fetch('/dsh-au/api', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ action: 'getState' }),
                  }).then((r) => r.json()).catch(() => null)
                : Promise.resolve(null),
            ]);
            // 请求发出后若有完成操作，整份旧响应作废，下一轮再取完成后的权威状态。
            if (completionRevision !== todoCompletionRevision) return;
            if (fetchedSnap?.ok && typeof window !== 'undefined') {
              window.__dshAuLastStateSnap = fetchedSnap;
              auSnap = fetchedSnap;
            }
            if (Array.isArray(data.cards)) {
              const effectiveLocalId = (typeof data.localDeviceId === 'string' && data.localDeviceId) || localDeviceId;
              if (typeof data.localDeviceId === 'string' && data.localDeviceId) {
                setLocalDeviceId(data.localDeviceId);
              }
              setCards(sortCardsForDisplay(reconcileCardsWithAuSnap(applyTodoCompletionState(data), auSnap, effectiveLocalId)));
              hasPreloadedRef.current = true;
              // 刷新成功只清除加载错误，不能把刚显示的操作失败原因立即擦掉。
              setNotice((current) => current.startsWith('Todo 列表加载失败：') ? '' : current);
            }
          } catch (error) {
            console.warn('[dsh-au-todo] getState failed:', error);
            setNotice(`Todo 列表加载失败：${error?.message || '未知错误'}`);
          } finally {
            setLoading(false);
            refreshInFlightRef.current = false;
          }
        }, [localDeviceId]);
        useEffect(() => {
          let timer = null;
          if (panelOpen) {
            // 面板展开时：首次展开且无预热缓存显示 Loading，立即拉取权威待办列表并启动 1 秒高频轮询
            if (!hasPreloadedRef.current && cards.length === 0) {
              setLoading(true);
            }
            void refresh();
            timer = setInterval(() => {
              void refresh();
            }, 1000);
          }
          const onSelfStateChange = (event) => {
            const detail = event?.detail || {};
            const auSnap = detail._auSnap || (typeof window !== 'undefined' ? window.__dshAuLastStateSnap : null);
            if (!panelOpen) {
              // 面板收起时：仅纯内存对账更新卡片灯色，不触发网络拉取或后台磁盘扫描
              if (auSnap) {
                setCards((current) => (current.length ? sortCardsForDisplay(reconcileCardsWithAuSnap(current, auSnap, localDeviceId)) : current));
              }
              return;
            }
            const sessionsList = detail.sessions;
            const selfPart = Array.isArray(sessionsList)
              ? sessionsList.map((s) => `${s?.id}:${s?.statusV2 || s?.status}`).join('|')
              : String(detail.statusV2 || '');
            const remotePart = Array.isArray(auSnap?.remotes)
              ? auSnap.remotes.map((r) => `${r?.id}:${r?.statusV2 || r?.status}:${JSON.stringify(r?.sessionStatesV2 || {})}`).join('|')
              : '';
            const digest = `${selfPart}##${remotePart}`;
            if (digest && digest !== lastSelfDigestRef.current) {
              lastSelfDigestRef.current = digest;
              if (auSnap) {
                setCards((current) => sortCardsForDisplay(reconcileCardsWithAuSnap(current, auSnap, localDeviceId)));
              }
              void refresh();
            }
          };
          const onRemoteMetaMessage = (event) => {
            if (event.data?.source === 'dsh-au' && event.data?.type === 'frame-ready') {
              const now = Date.now();
              for (const [devId, pending] of pendingRemoteSelections.entries()) {
                if (now > pending.expiresAt) {
                  pendingRemoteSelections.delete(devId);
                  continue;
                }
                const targetFrame = document.querySelector(`iframe[name="${CONTROLLED_FRAME_PREFIX}${devId}"]`);
                if (targetFrame?.contentWindow === event.source) {
                  try { event.source.postMessage(pending.message, '*'); } catch {}
                }
              }
              return;
            }
            if (event.data?.source !== 'dsh-au-todo' || event.data?.type !== REMOTE_SESSIONS_META_MESSAGE) return;
            if (!Array.isArray(event.data.sessions)) return;
            let updatedMeta = false;
            for (const item of event.data.sessions) {
              if (!item?.sessionId || !item.title) continue;
              const prev = remoteSessionMetaCache.get(item.sessionId);
              if (!prev || prev.title !== item.title || prev.summary !== item.summary) {
                remoteSessionMetaCache.set(item.sessionId, item);
                updatedMeta = true;
              }
            }
            if (updatedMeta) {
              const auSnap = typeof window !== 'undefined' ? window.__dshAuLastStateSnap : null;
              setCards((current) => sortCardsForDisplay(reconcileCardsWithAuSnap(current, auSnap, localDeviceId)));
            }
          };
          window.addEventListener('dsh-au:self-state', onSelfStateChange);
          window.addEventListener('message', onRemoteMetaMessage);
          return () => {
            if (timer) clearInterval(timer);
            window.removeEventListener('dsh-au:self-state', onSelfStateChange);
            window.removeEventListener('message', onRemoteMetaMessage);
          };
        }, [localDeviceId, panelOpen, refresh]);

        useEffect(() => {
          const previous = previousNativeSelectionId.current;
          previousNativeSelectionId.current = selectedSessionId;
          // 初始快照不是一次用户查看；数据稍后到达时保留本次切换，避免漏确认。
          if (previous === null) return;
          if (previous !== selectedSessionId) pendingNativeSelectionId.current = selectedSessionId;
          const sessionId = pendingNativeSelectionId.current;
          if (!sessionId) return;
          const card = cards.find((item) => isLocalCard(item, localDeviceId) && item.sessionId === sessionId);
          if (!card) return;
          pendingNativeSelectionId.current = '';
          if (card.hidden === true || completedTodoSessions.has(todoCompletionKey(card))) {
            setCards((current) => sortCardsForDisplay(current.filter((item) => item.sessionId !== sessionId)));
            if (card.status === 'done' || card.status === 'error') {
              void callApi('confirmSession', { deviceId: card.deviceId, sessionId }).catch(() => {});
            }
            return;
          }
          if (card.status !== 'done' && card.status !== 'error') return;
          setCards((current) => sortCardsForDisplay(current.map((item) =>
            isLocalCard(item, localDeviceId) && item.sessionId === sessionId
              ? { ...item, status: 'idle' }
              : item)));
          // 原生 DSH 侧栏切换同样视作已查看，复用 Todo 卡片跳转的确认协议。
          void callApi('confirmSession', { deviceId: card.deviceId, sessionId }).then(() => {
            void refresh();
          }).catch(() => {});
        }, [cards, localDeviceId, refresh, selectedSessionId]);

        const dispatchDeviceAndSession = useCallback((card) => {
          const markVisited = (devId) => {
            if (typeof window === 'undefined') return;
            const set = window[INITIAL_FOCUS_VISITS_KEY] instanceof Set
              ? window[INITIAL_FOCUS_VISITS_KEY]
              : (window[INITIAL_FOCUS_VISITS_KEY] = new Set());
            set.add(devId);
          };
          const isLocal = isLocalCard(card, localDeviceId);
          // 同步侧边栏与远端 store 状态
          syncSidebarSelectionFromTodo(card, isLocal);
          if (!isLocal) {
            markVisited(card.deviceId);
            window.dispatchEvent(new CustomEvent(DEVICE_SELECT_EVENT, { detail: { deviceId: card.deviceId } }));
            if (typeof remoteWorkspacesClient?.helpers?.syncExternalRemoteSelection === 'function') {
              setNotice('');
              return;
            }
            // 仅在侧边栏远端控制器不可用时降级使用局部 postMessage 重试。
            const message = { source: 'dsh-au-todo', type: SELECT_SESSION_MESSAGE, sessionId: card.sessionId, deviceId: card.deviceId };
            pendingRemoteSelections.set(card.deviceId, { message, expiresAt: Date.now() + 15000 });
            const getTargetFrames = () => {
              if (typeof document?.querySelectorAll !== 'function') return [];
              const exact = document.querySelectorAll(`iframe[name="${CONTROLLED_FRAME_PREFIX}${card.deviceId}"]`);
              if (exact.length) return exact;
              return document.querySelectorAll('iframe[name^="dsh-au-controlled:"], .dsh-au-stage iframe');
            };
            const notifyFrame = () => {
              for (const frame of getTargetFrames()) {
                frame.contentWindow?.postMessage(message, '*');
              }
            };
            notifyFrame();
            window.setTimeout?.(() => {
              notifyFrame();
              for (const frame of getTargetFrames()) {
                frame.addEventListener?.('load', () => {
                  frame.contentWindow?.postMessage(message, '*');
                  window.setTimeout?.(() => frame.contentWindow?.postMessage(message, '*'), 250);
                  window.setTimeout?.(() => frame.contentWindow?.postMessage(message, '*'), 900);
                  window.setTimeout?.(() => frame.contentWindow?.postMessage(message, '*'), 2200);
                }, { once: true });
              }
            }, 80);
            for (const delay of [350, 1100, 2200, 4000, 6500]) {
              window.setTimeout?.(notifyFrame, delay);
            }
            setNotice('');
            return;
          }
          markVisited('local');
          // 若用户当前停留在远程设备标签页，先切回本机再调用原生 uiWorkspace.openSession。
          window.dispatchEvent(new CustomEvent(DEVICE_SELECT_EVENT, { detail: { deviceId: 'local', reason: 'todo-open-local' } }));
          const result = openNativeSession(card.sessionId, openSession);
          setNotice(result.ok ? '' : (result.error || '切换会话失败'));
        }, [localDeviceId, openSession]);

        const openCard = useCallback(async (card, confirm = true) => {
          collapseCard(card);
          // 移动端面板近乎全屏，点击跳转时立即收起面板并同步发起导航，防止异步 confirm 阻塞手势或面板遮挡新会话。
          if (isMobileOrTouchViewport()) {
            setPanelOpen(false);
          }
          dispatchDeviceAndSession(card);
          if (confirm && (card.status === 'done' || card.status === 'error')) {
            if (!isLocalCard(card, localDeviceId)) {
              locallyConfirmedRemoteSessions.set(`${card.deviceId}:${card.sessionId}`, Date.now());
            }
            setCards((current) => sortCardsForDisplay(current.map((item) =>
              item.deviceId === card.deviceId && item.sessionId === card.sessionId
                ? { ...item, status: 'idle' }
                : item)));
            try {
              await callApi('confirmSession', { deviceId: card.deviceId, sessionId: card.sessionId });
              if (!isLocalCard(card, localDeviceId) && card.deviceId) {
                await fetch('/dsh-au/api', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ action: 'probeRemote', deviceId: card.deviceId }),
                }).catch(() => {});
              }
              if (typeof window?.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
                window.dispatchEvent(new CustomEvent('dsh-au:refresh-state'));
              }
            } catch {}
          }
          void refresh();
        }, [dispatchDeviceAndSession, localDeviceId, refresh, setPanelOpen]);

        useEffect(() => {
          // 统一交由 installGlobalWaitingSessionCycleService 处理快捷键与 TODO_CYCLE_EVENT，
          // 避免受控 iframe 转发 TODO_CYCLE_EVENT 时触发双监听器连跳两次。
          const onTodoCardNavigated = (event) => {
            const navCard = event?.detail?.card;
            if (!navCard?.sessionId) return;
            collapseCard(navCard);
            if (navCard.status === 'done' || navCard.status === 'error') {
              setCards((current) => sortCardsForDisplay(current.map((item) =>
                item.deviceId === navCard.deviceId && item.sessionId === navCard.sessionId
                  ? { ...item, status: 'idle' }
                  : item)));
            }
          };
          window.addEventListener('dsh-au:todo-card-navigated', onTodoCardNavigated);
          return () => {
            window.removeEventListener('dsh-au:todo-card-navigated', onTodoCardNavigated);
          };
        }, []);

        const updatePriority = async (card, priority) => {
          // 先本地重排，网络回写完成后再用权威状态对账，避免用户误以为优先级要等轮询才生效。
          setCards((current) => sortCardsForDisplay(current.map((item) => item.sessionId === card.sessionId ? { ...item, priority } : item)));
          const result = await callApi('setPriority', { deviceId: card.deviceId, sessionId: card.sessionId, priority });
          if (!result?.ok) await refresh();
        };
        const addTodo = async (card) => {
          const text = drafts[card.sessionId] || '';
          if (!text.trim()) return;
          const result = await callApi('appendTodo', { deviceId: card.deviceId, sessionId: card.sessionId, text });
          if (result?.ok) {
            completedTodoSessions.delete(todoCompletionKey(card));
            todoCompletionRevision += 1;
            setDrafts((old) => ({ ...old, [card.sessionId]: '' }));
            window.requestAnimationFrame(() => {
              const input = inputRefs.current.get(cardKey(card));
              if (input instanceof HTMLTextAreaElement) input.style.height = '';
            });
            collapseCard(card);
          }
          void refresh();
        };
        const togglePinned = async (card, event) => {
          event.stopPropagation();
          const pinned = card.pinned !== true;
          // 暂存必须即时上浮；失败时由服务端权威状态恢复。
          setCards((current) => sortCardsForDisplay(current.map((item) =>
            item.deviceId === card.deviceId && item.sessionId === card.sessionId ? { ...item, pinned } : item)));
          try {
            await callApi('setPinned', { deviceId: card.deviceId, sessionId: card.sessionId, pinned });
            setNotice('');
          } catch (error) {
            setNotice(error?.message || '暂存状态保存失败');
            await refresh();
          }
        };
        const continueTodo = async (card, event) => {
          event.stopPropagation();
          const result = await callApi('sendNextTodo', { deviceId: card.deviceId, sessionId: card.sessionId });
          if (result?.ok) {
            collapseCard(card);
            dispatchDeviceAndSession(card);
          }
          void refresh();
        };
        const interruptCard = async (card, event) => {
          event.stopPropagation();
          const result = await callApi('interruptSession', { deviceId: card.deviceId, sessionId: card.sessionId });
          if (result?.ok) {
            if (typeof window?.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
              window.dispatchEvent(new CustomEvent('dsh-au:refresh-state'));
            }
            setNotice('');
          } else {
            setNotice(result?.error || '停止会话失败');
          }
          await refresh();
        };
        const completeCard = async (card, event) => {
          event.stopPropagation();
          const key = todoCompletionKey(card);
          const baselineAt = Math.max(Number(card.lastUserMessageAt) || 0, Number(card.updatedAt) || 0);
          const completed = {
            deviceId: card.deviceId,
            stateSeq: card.stateSeq,
            updatedAt: card.updatedAt,
            lastUserMessageAt: Number(card.lastUserMessageAt) || 0,
            hiddenAt: baselineAt > 0 ? baselineAt : Date.now(),
            pending: true,
          };
          completedTodoSessions.set(key, completed);
          todoCompletionRevision += 1;
          // 乐观隐藏同步到全局快捷键；失败立即恢复，不依赖下一秒的轮询。
          setCards((current) => current.filter((item) => todoCompletionKey(item) !== key));
          globalCachedCards = globalCachedCards.filter((item) => todoCompletionKey(item) !== key);
          setNotice('');
          try {
            const result = await callApi('hideSession', {
              deviceId: card.deviceId, sessionId: card.sessionId,
              expectedEndSeq: Number.isSafeInteger(card.endSeq) && card.endSeq >= 0 ? card.endSeq : undefined,
              ...(Number.isFinite(card.lastUserMessageAt) ? { lastUserMessageAt: card.lastUserMessageAt } : {}),
              ...(Number.isFinite(card.updatedAt) ? { updatedAt: card.updatedAt } : {}),
            });
            if (!result?.ok) throw new Error(result?.error || '完成状态保存失败');
            completed.pending = false;
            // 迟到的完成可能遇到新一轮活动；不能把新 busy/waiting 的序号当作已经完成。
            if (result.confirmed === true && result.state?.status === 'idle'
              && Number.isSafeInteger(result.state.endSeq) && result.state.endSeq >= 0) {
              completed.stateSeq = Math.max(Number.isSafeInteger(completed.stateSeq) ? completed.stateSeq : -1, result.state.endSeq);
            }
            todoCompletionRevision += 1;
            if (typeof window?.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
              window.dispatchEvent(new CustomEvent('dsh-au:refresh-state'));
            }
          } catch (error) {
            if (completedTodoSessions.get(key) !== completed) return;
            completedTodoSessions.delete(key);
            todoCompletionRevision += 1;
            const restore = (current) => sortCardsForDisplay(current.some((item) => todoCompletionKey(item) === key) ? current : [...current, card]);
            setCards(restore);
            globalCachedCards = restore(globalCachedCards);
            setNotice(error?.message || '完成状态保存失败，卡片仍在列表中');
            await refresh();
          }
        };
        const dropCard = async (target, event) => {
          event.preventDefault();
          const moving = cards.find((card) => card.sessionId === dragging);
          if (!moving || moving.sessionId === target.sessionId) return;
          const samePriority = cards.filter((card) => card.sessionId !== moving.sessionId && card.priority === target.priority);
          const targetIndex = samePriority.findIndex((card) => card.sessionId === target.sessionId);
          const targetRect = event.currentTarget.getBoundingClientRect();
          const insertAfter = event.clientY > targetRect.top + targetRect.height / 2;
          const before = samePriority[insertAfter ? targetIndex : targetIndex - 1];
          const after = samePriority[insertAfter ? targetIndex + 1 : targetIndex];
          const sortOrder = before && after ? (Number(before.sortOrder) + Number(after.sortOrder)) / 2
            : before ? Number(before.sortOrder) + 1 : after ? Number(after.sortOrder) - 1 : -Date.now();
          await callApi('setSortOrder', { deviceId: moving.deviceId, sessionId: moving.sessionId, priority: target.priority, sortOrder });
          setDragging(''); setDropTarget(''); void refresh();
        };

        if (!panelOpen) return null;
        return h('aside', { className: 'dsh-au-todo-dock', style: panelAnchor, 'aria-label': '跨设备 Todo 列表' },
          h('section', { className: 'dsh-au-todo-panel' }, [
            h('header', { key: 'head', className: 'dsh-au-todo-head' }, [
              h('span', { key: 'title', className: 'dsh-au-todo-title' }, `跨设备 Todo · ${cards.length}`),
              h('span', { key: 'actions', className: 'dsh-au-todo-actions' }, [
                h('button', { key: 'refresh', type: 'button', className: 'dsh-au-todo-icon', onClick: () => void refresh(), title: '刷新列表', 'aria-label': '刷新 Todo 列表' }, h(TodoRefreshIcon)),
                h('button', { key: 'close', type: 'button', className: 'dsh-au-todo-icon', onClick: () => setPanelOpen(false), title: '收起跨设备 Todo', 'aria-label': '收起跨设备 Todo' }, h(TodoPanelIcon, { open: true })),
              ]),
            ]),
            notice ? h('div', { key: 'notice', className: 'dsh-au-todo-notice', role: 'status' }, notice) : null,
            h('div', { key: 'list', ref: listRef, className: 'dsh-au-todo-list' }, cards.length ? cards.map((card) => {
              const key = cardKey(card);
              const expanded = expandedCards.has(key);
              const selected = key === selectedCardKey;
              const touchMode = isMobileOrTouchViewport();
              const transport = isLocalCard(card, localDeviceId) ? '' : resolveDeviceConnectionTransport(card.deviceId);
              return h('article', {
                key, ref: (node) => { if (node) cardRefs.current.set(key, node); else cardRefs.current.delete(key); },
                className: 'dsh-au-todo-card', draggable: !touchMode, 'data-status': card.status,
                'data-pinned': String(card.pinned === true),
                'data-selected': String(selected),
                'aria-current': selected ? 'page' : undefined,
                'data-expanded': String(expanded),
                'data-drop-target': String(dropTarget === card.sessionId),
                onDragStart: () => { if (!touchMode) setDragging(card.sessionId); }, onDragEnd: () => { setDragging(''); setDropTarget(''); },
                onDragOver: (event) => { event.preventDefault(); setDropTarget(card.sessionId); }, onDrop: (event) => void dropCard(card, event),
                onClick: () => void openCard(card), title: '点击切换到此对话；蓝灯会确认消除',
              }, [
                h('div', { key: 'top', className: 'dsh-au-todo-card-top' }, [
                  h('div', { key: 'name', className: 'dsh-au-todo-name' }, card.title),
                  card.pinned === true ? h('span', { key: 'pinned', className: 'dsh-au-todo-pinned-label' }, '置顶') : null,
                  h('button', {
                    key: 'jump',
                    type: 'button',
                    className: 'dsh-au-todo-jump',
                    onClick: (event) => {
                      event.stopPropagation();
                      void openCard(card);
                    },
                    title: '跳转到此对话',
                    'aria-label': `跳转到对话 ${card.title || ''}`.trim(),
                  }, '跳转'),
                ]),
                h('button', {
                  key: 'summary', type: 'button', className: 'dsh-au-todo-summary', 'aria-expanded': expanded,
                  onClick: (event) => {
                    event.stopPropagation();
                    setExpandedCards((current) => {
                      const next = new Set(current);
                      if (next.has(key)) next.delete(key); else next.add(key);
                      return next;
                    });
                  },
                  title: expanded ? '收起对话内容' : '展开对话内容',
                }, card.summary || '暂无可用摘要'),
                h('div', { key: 'meta', className: 'dsh-au-todo-meta' }, [
                  h('span', { key: 'dot', className: `dsh-au-todo-dot ${card.status || 'idle'}`, title: card.status || 'idle' }),
                  card.workspace ? h('span', { key: 'workspace', className: 'dsh-au-todo-workspace-tag', title: card.workspace }, card.workspace) : null,
                  h('span', {
                    key: 'device-badge',
                    className: 'dsh-au-remote-ws-badge dsh-au-todo-device-badge',
                    title: transport ? `设备：${card.deviceName}（连接方式：${transport}）` : `设备：${card.deviceName}`,
                  }, [
                    h(RemoteMonitorIcon, { key: 'icon' }),
                    h('span', { key: 'name', className: 'dsh-au-remote-ws-badge-name' }, card.deviceName),
                    transport ? h('span', { key: 'sep', className: 'dsh-au-remote-ws-badge-sep' }, '·') : null,
                    transport ? h('span', { key: 'transport', className: 'dsh-au-remote-ws-badge-transport' }, transport) : null,
                  ]),
                  h('span', { key: 'time', className: 'dsh-au-todo-time' }, relativeTime(card.updatedAt)),
                ]),
                h('div', { key: 'priority-row', className: 'dsh-au-todo-priority-row', onClick: (event) => event.stopPropagation() },
                  ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'].map((p) => h('button', {
                    key: p,
                    type: 'button',
                    className: `dsh-au-todo-priority-pill${(card.priority || 'P4') === p ? ' selected' : ''}`,
                    'data-priority': p,
                    onClick: (event) => {
                      event.stopPropagation();
                      if (card.priority !== p) void updatePriority(card, p);
                    },
                    title: `切换为 ${p} 优先级`,
                    'aria-label': `${p} 优先级`,
                  }, p))
                ),
                visibleTodos(card.todos).length ? h('div', { key: 'queue', className: 'dsh-au-todo-queue', onClick: (event) => event.stopPropagation() }, [
                  h('span', { key: 'label', className: 'dsh-au-todo-queue-label' }, `待办内容${card.todos.length > 1 ? ` · ${card.todos.length} 项` : ''}`),
                  ...visibleTodos(card.todos).map((todo) => h('span', { key: todo.id, className: 'dsh-au-todo-queue-item', title: todo.text }, todo.text)),
                  card.todos.length > 2 ? h('span', { key: 'more', className: 'dsh-au-todo-queue-more' }, `另有 ${card.todos.length - 2} 项待办`) : null,
                ]) : null,
                h('div', { key: 'actions', className: 'dsh-au-todo-card-actions', onClick: (event) => event.stopPropagation() }, [
                  h('button', { key: 'stash', type: 'button', className: 'dsh-au-todo-btn stash', onClick: (event) => void togglePinned(card, event), title: card.pinned ? '取消置顶，回到常规排序' : '置顶到 Todo 列表最上方' }, card.pinned ? '取消置顶' : '置顶'),
                  (card.status === 'busy' || card.status === 'waiting') ? h('button', { key: 'interrupt', type: 'button', className: 'dsh-au-todo-btn interrupt', onClick: (event) => void interruptCard(card, event), title: '停止此对话当前正在执行的回合' }, '停止') : null,
                  card.status === 'done' && card.todos?.length ? h('button', { key: 'send', type: 'button', className: 'dsh-au-todo-btn', onClick: (event) => void continueTodo(card, event) }, '续跑') : null,
                  h('button', { key: 'complete', type: 'button', className: 'dsh-au-todo-btn complete', onClick: (event) => void completeCard(card, event), title: '仅从 Todo 列表隐藏，不删除对话或待办内容' }, '完成'),
                ]),
              ]);
            }) : loading
              ? h('div', { className: 'dsh-au-todo-loading', role: 'status', 'aria-live': 'polite' }, [
                h('span', { key: 'spinner', className: 'dsh-au-todo-spinner', 'aria-hidden': true }),
                h('span', { key: 'text' }, '正在加载 Todo…'),
              ])
              : h('div', { className: 'dsh-au-todo-empty' }, '没有可展示的顶层对话'))])
        );
      }

      function apply(ctx) {
        // 外部插件经 Context.get('uiWorkspace') 或直接属性读取宿主会话导航服务。
        const resolveOpenSession = () => {
          const uiWorkspace = ctx.get?.('uiWorkspace') || ctx.uiWorkspace;
          return typeof uiWorkspace?.openSession === 'function'
            ? uiWorkspace.openSession.bind(uiWorkspace)
            : null;
        };
        openWorkspaceSession = resolveOpenSession();
        if (!openWorkspaceSession) console.warn('[dsh-au-todo] uiWorkspace.openSession is unavailable at apply time');
        ctx.effect(() => () => { openWorkspaceSession = null; }, 'dsh-au-todo: ui workspace bridge');
        const sessions = ctx.get?.('sessions') || ctx.sessions;
        const currentSession = selectedSessionSource(sessions);
        ctx.effect(() => installNativeSessionConfirmBridge(sessions), 'dsh-au-todo: native session confirm bridge');
        if (isControlledFrame()) {
          ctx.effect(() => installControlledSessionBridge(sessions), 'dsh-au-todo: controlled session bridge');
          return;
        }
        if (window[CLIENT_LOCK]) return;
        window[CLIENT_LOCK] = true;
        ctx.effect(() => () => { if (window[CLIENT_LOCK]) delete window[CLIENT_LOCK]; }, 'dsh-au-todo: singleton');
        ctx.effect(() => ensureStyles(), 'dsh-au-todo: styles');
        // 展开 / 收起待办面板：键盘快捷键（默认 Alt+T，可在设置页修改）与受控 iframe 转发的事件共用同一入口。
        ctx.effect(() => {
          const toggleIfEnabled = () => {
            if (!(featuresStore.snapshot.loaded && featuresStore.snapshot.todo)) return false;
            setTodoPanelOpen(!todoPanelOpen);
            return true;
          };
          const onKeyDown = (event) => {
            if (event.defaultPrevented || findShortcutAction(event) !== 'todo.toggle') return;
            if (toggleIfEnabled()) event.preventDefault();
          };
          const onToggleEvent = () => { toggleIfEnabled(); };
          window.addEventListener('keydown', onKeyDown, true);
          window.addEventListener(TODO_TOGGLE_EVENT, onToggleEvent);
          return () => {
            window.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener(TODO_TOGGLE_EVENT, onToggleEvent);
          };
        }, 'dsh-au-todo: toggle shortcut');
        // 全局常驻快捷键监听：轮流跳转待处理/未读对话（默认 Ctrl+Delete），独立于待办面板开闭状态
        ctx.effect(() => installGlobalWaitingSessionCycleService(ctx), 'dsh-au-todo: global waiting session cycle');
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-au-todo-dock',
          order: 40,
          inject: () => ({
            hooks: { selectedSession: currentSession },
            openSession: (target) => {
              const fn = resolveOpenSession();
              if (!fn) throw new Error('uiWorkspace.openSession 未就绪');
              fn(target);
            },
          }),
        }, TodoDock));
        // 右侧工具组 conversation.session.header.utilities 中 open-in-app（文件夹）order 为 -10；设为 -20 使其紧贴文件夹按钮左侧。
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'dsh-au-todo-toggle',
          order: -20,
        }, TodoHeaderAction));
      }


      /** 功能开关关闭（或尚未读到开关）时不渲染任何待办界面；服务端路由由宿主按同一开关回 404。 */
      function TodoHeaderAction(props) {
        const features = useFeatures();
        return features.loaded && features.todo ? h(TodoHeaderActionInner, props) : null;
      }

      function TodoDock(props) {
        const features = useFeatures();
        return h(React.Fragment, null,
          h(TodoCycleNotice),
          features.loaded && features.todo ? h(TodoDockInner, props) : null,
        );
      }

      return {
        inject: ['slots', 'uiWorkspace', 'sessions'],
        apply,
        helpers: {
          cycleWaitingSessionGlobal,
          syncGlobalCards,
          getGlobalCachedCards: () => globalCachedCards,
        },
      };
    })();
