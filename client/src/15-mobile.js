    // 移动端抽屉（原 dsh-au-mobile 客户端）。包进 IIFE 隔离同名标识；helpers 仅供测试读取。
    const mobileClient = (() => {
      'use strict';
      const React = require('react');
      const ReactDOM = require('react-dom');
      const h = React.createElement;
      const { useState, useEffect, useCallback, useRef } = React;

      const STYLE_ID = 'dsh-au-mobile-style';
      const MOBILE_ATTR = 'data-dsh-au-mobile';
      const DRAWER_ATTR = 'data-dsh-au-mobile-drawer';
      const HEADER_ATTR = 'data-dsh-au-mobile-header';
      const DRAGGING_ATTR = 'data-dsh-au-mobile-dragging';
      const DRAWER_OFFSET_VAR = '--dsh-au-mobile-drawer-tx';
      const MOBILE_MAX_WIDTH = 768;
      const DRAWER_MAX_WIDTH = 300;
      const DRAWER_VW_RATIO = 0.82;
      const EDGE_SWIPE_ZONE_PX = 44;
      const SWIPE_OPEN_THRESHOLD_PX = 56;
      const SWIPE_CLOSE_THRESHOLD_PX = 52;
      const HEADER_SWIPE_THRESHOLD_PX = 22;
      const HEADER_SCROLL_DELTA_PX = 10;
      const SWIPE_DIRECTION_RATIO = 1.35;
      const TABLET_MAX_WIDTH = 1440;
      const LONG_PRESS_DELAY_MS = 420;
      const COMPOSER_USER_TAP_WINDOW_MS = 1200;
      const TRIGGER_POSITION_STORAGE_KEY = 'dsh-au-mobile.trigger-pos-v2';
      const DEFAULT_TRIGGER_LEFT = 8;
      const DEFAULT_TRIGGER_BOTTOM_OFFSET = 184;
      const SOFT_KEYBOARD_HEIGHT_THRESHOLD_PX = 120;

      /**
       * 触发 DSH 原生「新建对话」动作：
       * 若当前处于远端 DSH 激活态，优先在当前选中的远端工作区新建对话；
       * 否则调用宿主 uiWorkspace 服务，不可用时回退点击侧边栏内的原生新建会话按钮。
       */
      function triggerNewSession(hostStartSession, doc = typeof document !== 'undefined' ? document : null) {
        if (
          doc?.documentElement?.getAttribute?.('data-dsh-au-remote-active') === 'true'
          && typeof window !== 'undefined'
          && typeof window.dispatchEvent === 'function'
          && typeof CustomEvent === 'function'
        ) {
          try {
            const ev = new CustomEvent('dsh-au:mobile-new-session', { cancelable: true });
            window.dispatchEvent(ev);
            if (ev.defaultPrevented) return true;
          } catch {}
        }
        if (typeof hostStartSession === 'function') {
          try {
            hostStartSession();
            return true;
          } catch {}
        }
        const btn = doc?.querySelector?.('button[class*="_newSession"], [data-sidebar-header-controls] button:last-child');
        if (btn && typeof btn.click === 'function') {
          btn.click();
          return true;
        }
        return false;
      }

      /** 计算悬浮按钮默认初始位置：对齐左侧边距（8px），位于底部输入框正上方一点。 */
      function getDefaultTriggerPosition(viewportWidth = 375, viewportHeight = 812, doc = typeof document !== 'undefined' ? document : null) {
        const vw = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 375;
        const vh = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 812;
        let top = Math.max(72, Math.round(vh - DEFAULT_TRIGGER_BOTTOM_OFFSET));
        try {
          const card = doc?.querySelector?.('[data-composer-seat] [class*="_card"]') || doc?.querySelector?.('[data-composer-seat]');
          const rect = card?.getBoundingClientRect?.();
          if (rect && Number.isFinite(rect.top) && rect.top > 64 && rect.top < vh) {
            top = Math.round(rect.top - 42);
          }
        } catch {}
        return clampTriggerPosition({ top, left: DEFAULT_TRIGGER_LEFT }, vw, vh);
      }

      /** 将悬浮按钮坐标限制在当前屏幕可视范围内，防止拖出屏幕后无法找回。 */
      function clampTriggerPosition(pos, viewportWidth = 375, viewportHeight = 812) {
        const vw = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 375;
        const vh = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 812;
        const fallbackTop = Math.max(72, Math.round(vh - DEFAULT_TRIGGER_BOTTOM_OFFSET));
        const rawTop = Number.isFinite(pos?.top) ? pos.top : fallbackTop;
        const rawLeft = Number.isFinite(pos?.left) ? pos.left : DEFAULT_TRIGGER_LEFT;
        return {
          top: Math.min(Math.max(8, Math.round(rawTop)), Math.max(8, vh - 44)),
          left: Math.min(Math.max(8, Math.round(rawLeft)), Math.max(8, vw - 44)),
        };
      }

      /**
       * 判断当前设备页面是否已通过顶部标签切换到另一台远程 DSH：
       * 切换后应隐藏当前设备自身的移动端悬浮抽屉按钮（避免压在远程 DSH 画面上方），
       * 而第二台 DSH（iframe 内）处于其本机标签态，正常保留其自身的悬浮按钮。
       */
      function isRemoteDshActive(doc = typeof document !== 'undefined' ? document : null) {
        if (!doc) return false;
        if (doc.documentElement?.getAttribute?.('data-dsh-au-remote-active') === 'true') return true;
        const stage = doc.querySelector?.('.dsh-au-stage');
        if (stage && stage.style?.display === 'block') return true;
        return Boolean(doc.querySelector?.('.dsh-au-tabs .dsh-au-tab:not(:first-child).active'));
      }

      /** 检测新版 DSH 宿主是否已启用官方原生移动端抽屉（存在原生抽屉或蒙层标记时由插件退让）。 */
      function hasNativeSidebarDrawer(doc = typeof document !== 'undefined' ? document : null) {
        return Boolean(doc?.querySelector?.('[data-sidebar-drawer], [data-sidebar-mask]'));
      }

      /**
       * 判断当前 resize 是否由软键盘引起：iOS 常仅缩小 visualViewport，Android 部分浏览器会同时缩小 layout viewport，
       * 因此同时比较可视视口差额和同宽情况下的上一次稳定高度。
       */
      function isSoftKeyboardViewport(win, stableViewport) {
        if (!win) return false;
        const width = Number(win.innerWidth || 0);
        const height = Number(win.innerHeight || 0);
        const visualViewport = win.visualViewport;
        const visualHeight = Number(visualViewport?.height || height);
        const visualOffsetTop = Number(visualViewport?.offsetTop || 0);
        const overlayHeight = height - visualHeight - visualOffsetTop;
        if (overlayHeight >= SOFT_KEYBOARD_HEIGHT_THRESHOLD_PX) return true;
        return Boolean(
          stableViewport
          && Math.abs(width - stableViewport.width) < SOFT_KEYBOARD_HEIGHT_THRESHOLD_PX
          && stableViewport.height - visualHeight >= SOFT_KEYBOARD_HEIGHT_THRESHOLD_PX
        );
      }

      /** 读取用户手动拖动保存的位置；未拖动过时返回 null 以自动吸附在输入框左上方。 */
      function readSavedTriggerPosition() {
        try {
          const saved = JSON.parse(localStorage.getItem(TRIGGER_POSITION_STORAGE_KEY) || 'null');
          if (Number.isFinite(saved?.top) && Number.isFinite(saved?.left)) {
            return clampTriggerPosition(saved, window.innerWidth, window.innerHeight);
          }
        } catch {}
        return null;
      }

      /**
       * 判定当前环境是否属于移动端或平板模式（含平板横屏）：
       * 1. 窄屏视口（宽度 <= 768px）：直接启用（覆盖手机竖屏与桌面窄窗口调试）；
       * 2. 平板与手机横屏（宽度 <= 1440px）：
       *    - UA 含移动/平板标识（Android / iPad / Tablet / HarmonyOS / Mobile 等）；
       *    - iPadOS 13+ 桌面模式伪装 UA（Macintosh 且 maxTouchPoints > 1）；
       *    - 粗粒度主指针且无悬停能力或多触点（pointer: coarse + hover: none / maxTouchPoints > 1）。
       */
      function isMobileViewport(width, env = typeof window !== 'undefined' ? window : null) {
        if (!Number.isFinite(width) || width <= 0) return false;
        if (width <= MOBILE_MAX_WIDTH) return true;
        if (width <= TABLET_MAX_WIDTH && env) {
          const ua = String(env.navigator?.userAgent || '');
          const touchPoints = Number(env.navigator?.maxTouchPoints || 0);
          const coarse = typeof env.matchMedia === 'function' && env.matchMedia('(pointer: coarse)').matches;
          const noHover = typeof env.matchMedia === 'function' && env.matchMedia('(hover: none)').matches;
          const isMobileOrTabletUa = /Android|iPhone|iPod|iPad|Tablet|PlayBook|Silk|Mobile|HarmonyOS|ArkWeb/i.test(ua);
          const isIpadDesktopMode = /Macintosh/i.test(ua) && touchPoints > 1;
          if (isMobileOrTabletUa || isIpadDesktopMode || (coarse && (noHover || touchPoints > 1))) {
            return true;
          }
        }
        return false;
      }

      /**
       * 判定侧边栏内的点击目标是否应自动收起抽屉：
       * - 点击会话行（[data-row-key^="session:"] / _sessionRow / _searchResultRow）、新建对话（_newSession）、全局面板项（_panelRow）时收起；
       * - 点击会话行右侧「...」操作区（_rowActions）、重命名输入框（_renameInput）或仅展开/折叠工作区文件夹（[data-row-key^="workspace:"] 本体）时不收起。
       */
      function shouldCloseDrawerOnSidebarClick(target) {
        if (!target || typeof target.closest !== 'function') return false;
        const sidebar = target.closest('[class*="sidebarCol"], aside[data-slot="sidebar"]');
        if (!sidebar) return false;

        // 重命名输入框或行内菜单弹出时不收起抽屉
        if (target.closest('input, textarea, [class*="_renameInput"], [role="menu"]')) return false;

        // 工作区文件夹行：仅点击右侧「新建对话」图标时收起，点击文件夹标题展开/折叠时不收起
        const workspaceRow = target.closest('[data-row-key^="workspace:"], [class*="_projectRow"], .dsh-au-remote-ws-row');
        if (workspaceRow) {
          const actionBtn = target.closest('[class*="_rowActions"] button, .dsh-au-remote-ws-action-btn');
          if (!actionBtn) return false;
          const aria = String(actionBtn.getAttribute('aria-label') || actionBtn.getAttribute('title') || '');
          const hasKeyShortcut = actionBtn.hasAttribute('aria-keyshortcuts');
          return hasKeyShortcut || /新建|new session|new chat/i.test(aria);
        }

        // 会话行：点击右侧「...」菜单按钮时不收起，点击会话主体时收起
        const sessionRow = target.closest('[data-row-key^="session:"], [class*="_sessionRow"], [class*="_searchResultRow"], .dsh-au-remote-session-row');
        if (sessionRow) {
          if (target.closest('[class*="_rowActions"]')) return false;
          return true;
        }

        // 侧边栏顶部「新建对话」、全局导航面板项、底部设置项
        if (target.closest('button[class*="_newSession"], button[class*="_panelRow"], [class*="_settingsArea"] button, a[href], [data-session-id]')) {
          return true;
        }
        return false;
      }

      /**
       * 判定是否启用「侧边栏抽屉 + 悬浮折叠按钮」模式：
       * 在移动/平板设备的竖屏状态（width <= height）或窄屏（width <= 768 且非横屏）下启用抽屉接管；
       * 横屏状态（width > height）下返回 false，保持 DSH 默认侧边栏逻辑并隐藏悬浮按钮。
       */
      function isPortraitDrawerMode(width, height, env = typeof window !== 'undefined' ? window : null) {
        if (!Number.isFinite(width) || width <= 0) return false;
        if (Number.isFinite(height) && height > 0 && width > height) return false;
        return isMobileViewport(width, env);
      }

      /** 计算移动端侧边栏抽屉像素宽度（82vw，限制在 240px~300px）。 */
      function getDrawerWidth(viewportWidth) {
        const vw = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 375;
        return Math.min(DRAWER_MAX_WIDTH, Math.round(Math.max(240, vw * DRAWER_VW_RATIO)));
      }

      /** 检测触摸起点是否位于横向滚动容器（代码块、表格、设备标签栏）内，防止右滑误拉开侧边栏。 */
      function isHorizontalScrollTarget(target) {
        let node = target instanceof Element ? target : null;
        while (node && node !== document.body && node !== document.documentElement) {
          const tag = (node.tagName || '').toLowerCase();
          if (tag === 'pre' || tag === 'code' || tag === 'table') return true;
          if (node.classList?.contains('dsh-au-tabs') || node.hasAttribute?.('data-horizontal-scroll')) return true;
          if (node.scrollWidth > node.clientWidth + 6 && typeof window.getComputedStyle === 'function') {
            const overflowX = window.getComputedStyle(node).overflowX;
            if (overflowX === 'auto' || overflowX === 'scroll') return true;
          }
          node = node.parentElement;
        }
        return false;
      }

      /**
       * 评估左右滑动手势：
       * - 收起态：支持左边缘（<=44px）右滑，或非横向滚动区右滑拉开抽屉；
       * - 展开态：支持任意位置左滑收起抽屉；
       * 返回实时跟手位移 translateXPx 与松手后的目标开关状态。
       */
      function evaluateSwipeGesture({ drawerOpen, startX, startY, currentX, currentY, drawerWidth, inScrollable }) {
        const dx = currentX - startX;
        const dy = currentY - startY;
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);
        const isHorizontal = absDx >= 10 && absDx > absDy * SWIPE_DIRECTION_RATIO;
        const width = Number.isFinite(drawerWidth) && drawerWidth > 0 ? drawerWidth : getDrawerWidth(375);

        if (!drawerOpen) {
          const canStartOpen = startX <= EDGE_SWIPE_ZONE_PX || !inScrollable;
          if (!canStartOpen || dx <= 0 || !isHorizontal) {
            return { active: false, translateXPx: -width, shouldOpen: false };
          }
          const translateXPx = Math.min(0, -width + dx);
          return { active: true, translateXPx, shouldOpen: dx >= SWIPE_OPEN_THRESHOLD_PX };
        }

        if (dx >= 0 || !isHorizontal) {
          return { active: false, translateXPx: 0, shouldOpen: true };
        }
        const translateXPx = Math.max(-width, dx);
        return { active: true, translateXPx, shouldOpen: Math.abs(dx) < SWIPE_CLOSE_THRESHOLD_PX };
      }

      /**
       * 评估垂直滑动手势以控制顶部会话栏（标题 + 对话/轨迹标签栏）收起与拉出：
       * - 手指从下往上滑（dy <= -28px 且垂直分量占优）：收起顶部区域（nextCollapsed: true）；
       * - 手指从上往下滑（dy >= 28px 且垂直分量占优）：拉出顶部区域（nextCollapsed: false）。
       */
      function evaluateVerticalHeaderSwipe({ headerCollapsed = false, startX, startY, currentX, currentY }) {
        const dx = currentX - startX;
        const dy = currentY - startY;
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);
        if (absDy < HEADER_SWIPE_THRESHOLD_PX || absDy <= absDx * SWIPE_DIRECTION_RATIO) {
          return { triggered: false, nextCollapsed: Boolean(headerCollapsed) };
        }
        if (dy < 0) {
          return { triggered: true, nextCollapsed: true };
        }
        return { triggered: true, nextCollapsed: false };
      }

      /**
       * 评估对话滚动容器（[data-conversation-scroll]）的 scrollTop 变化：
       * - 回到顶部（scrollTop <= 6）时始终展开顶部区域；
       * - 向下滚动浏览内容（手指从下往上滑，deltaY >= 10）时收起顶部区域；
       * - 向上回看历史内容（手指从上往下滑，deltaY <= -10）时拉出顶部区域。
       */
      function evaluateScrollHeaderState({ headerCollapsed = false, prevScrollTop = 0, nextScrollTop = 0 }) {
        if (!Number.isFinite(nextScrollTop)) {
          return { triggered: false, nextCollapsed: Boolean(headerCollapsed) };
        }
        if (nextScrollTop <= 6) {
          return { triggered: headerCollapsed !== false, nextCollapsed: false };
        }
        const deltaY = nextScrollTop - prevScrollTop;
        if (Math.abs(deltaY) < HEADER_SCROLL_DELTA_PX) {
          return { triggered: false, nextCollapsed: Boolean(headerCollapsed) };
        }
        const nextCollapsed = deltaY > 0;
        return { triggered: nextCollapsed !== Boolean(headerCollapsed), nextCollapsed };
      }

      /** 注入移动端专属抽屉侧栏、根网格单列轨道、对话宽度变量与 dsh-au 窄屏自适应样式。 */
      function ensureMobileStyles() {
        if (typeof document === 'undefined') return;
        if (typeof window !== 'undefined') {
          const root = document.documentElement;
          const drawerMode = isPortraitDrawerMode(window.innerWidth, window.innerHeight, window);
          const touchHeaderMode = isMobileViewport(window.innerWidth, window);
          const nativeDrawer = hasNativeSidebarDrawer(document);
          if (drawerMode) {
            root.setAttribute(MOBILE_ATTR, 'true');
            // 仅在宿主未启用新版原生抽屉时挂载自定义抽屉状态属性，避免接管原生侧栏轨道
            if (!nativeDrawer && !root.hasAttribute(DRAWER_ATTR)) {
              root.setAttribute(DRAWER_ATTR, 'closed');
            }
          }
          if (touchHeaderMode && !root.hasAttribute(HEADER_ATTR)) {
            root.setAttribute(HEADER_ATTR, 'expanded');
          }
        }
        let style = document.getElementById(STYLE_ID);
        if (!style) {
          style = document.createElement('style');
          style.id = STYLE_ID;
          document.head.appendChild(style);
        }
        style.textContent = `
          html[${HEADER_ATTR}] body {
            --dsh-content-font-size: 15px !important;
            --dsh-code-font-size: 12.5px !important;
            --dsh-terminal-font-size: 13px !important;
          }
          html[${MOBILE_ATTR}="true"][${DRAWER_ATTR}] [class*="_frame"] {
            grid-template-columns: minmax(0, 1fr) !important;
          }
          html[${MOBILE_ATTR}="true"][${DRAWER_ATTR}] [class*="_splitRow_"] > [class*="_divider_"],
          html[${MOBILE_ATTR}="true"][${DRAWER_ATTR}] [class*="_handle"],
          html[${HEADER_ATTR}] [data-width-handle] {
            display: none !important;
          }
          html[${MOBILE_ATTR}="true"][${DRAWER_ATTR}] [class*="centerCol"] {
            grid-column: 1 / -1 !important;
            grid-row: 1 / 2 !important;
            width: 100% !important;
            max-width: 100vw !important;
            flex: 1 1 100% !important;
            min-width: 0 !important;
          }
          html[${MOBILE_ATTR}="true"][${DRAWER_ATTR}] [data-rightbar-col] {
            position: fixed !important;
            top: 0 !important;
            right: 0 !important;
            bottom: 0 !important;
            width: 0 !important;
            z-index: 18 !important;
          }
          html[${MOBILE_ATTR}="true"][${DRAWER_ATTR}]:not([data-dsh-au-controlled-frame="true"]) [class*="sidebarCol"],
          html[${MOBILE_ATTR}="true"][${DRAWER_ATTR}]:not([data-dsh-au-controlled-frame="true"]) aside[data-slot="sidebar"] {
            position: fixed !important;
            top: 0 !important;
            bottom: 0 !important;
            left: 0 !important;
            width: min(82vw, 300px) !important;
            min-width: 240px !important;
            max-width: 300px !important;
            height: 100dvh !important;
            z-index: 9500 !important;
            background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-layer-2, #12151e)) !important;
            border-right: 1px solid var(--dsw-alias-border-l2, #262c3a) !important;
            transition: transform 240ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 240ms ease !important;
            will-change: transform;
          }
          html[${MOBILE_ATTR}="true"]:not([data-dsh-au-controlled-frame="true"]) [class*="sidebarCol"] > [class*="_root"] {
            width: 100% !important;
            max-width: 100% !important;
          }
          html[${MOBILE_ATTR}="true"][${DRAWER_ATTR}="closed"]:not([data-dsh-au-controlled-frame="true"]) [class*="sidebarCol"],
          html[${MOBILE_ATTR}="true"][${DRAWER_ATTR}="closed"]:not([data-dsh-au-controlled-frame="true"]) aside[data-slot="sidebar"] {
            transform: translate3d(-104%, 0, 0) !important;
            pointer-events: none !important;
            box-shadow: none !important;
          }
          html[${MOBILE_ATTR}="true"][${DRAWER_ATTR}="open"]:not([data-dsh-au-controlled-frame="true"]) [class*="sidebarCol"],
          html[${MOBILE_ATTR}="true"][${DRAWER_ATTR}="open"]:not([data-dsh-au-controlled-frame="true"]) aside[data-slot="sidebar"] {
            transform: translate3d(0, 0, 0) !important;
            pointer-events: auto !important;
            box-shadow: 18px 0 48px rgba(0, 0, 0, 0.62) !important;
          }
          html[${MOBILE_ATTR}="true"][${DRAGGING_ATTR}="true"]:not([data-dsh-au-controlled-frame="true"]) [class*="sidebarCol"],
          html[${MOBILE_ATTR}="true"][${DRAGGING_ATTR}="true"]:not([data-dsh-au-controlled-frame="true"]) aside[data-slot="sidebar"] {
            transition: none !important;
            transform: translate3d(var(${DRAWER_OFFSET_VAR}, -104%), 0, 0) !important;
            pointer-events: none !important;
          }
          html[data-dsh-au-controlled-frame="true"] [class*="_sidebarCol"],
          html[data-dsh-au-controlled-frame="true"] [class*="sidebarCol"],
          html[data-dsh-au-controlled-frame="true"] aside[data-slot="sidebar"],
          html[data-dsh-au-controlled-frame="true"] .dsh-au-mobile-trigger,
          html[data-dsh-au-controlled-frame="true"] .dsh-au-mobile-backdrop,
          html[data-dsh-au-controlled-frame="true"] .dsh-au-mobile-edge-zone {
            display: none !important;
            width: 0 !important;
            min-width: 0 !important;
            max-width: 0 !important;
            pointer-events: none !important;
          }
          .dsh-au-mobile-trigger {
            position: fixed;
            z-index: 9490;
            width: 34px;
            height: 34px;
            padding: 0;
            border-radius: 10px;
            /* 抽屉悬浮按钮沿用宿主浅/深表面与图标色，拖动和定位逻辑不变。 */
            border: 1px solid var(--dsw-alias-border-l2, rgba(148, 163, 184, 0.25));
            background: var(--dsw-alias-bg-layer-1, rgba(18, 21, 30, 0.88));
            color: var(--dsw-alias-label-secondary, #e5e7eb);
            display: inline-flex;
            align-items: center;
            justify-content: center;
            cursor: grab;
            touch-action: none;
            user-select: none;
            backdrop-filter: blur(10px);
            box-shadow: 0 5px 16px rgba(0, 0, 0, 0.36);
            transition: opacity 180ms ease, transform 180ms ease, border-color 150ms ease;
            -webkit-tap-highlight-color: transparent;
            -webkit-app-region: no-drag;
          }
          .dsh-au-mobile-trigger:hover {
            background: var(--dsw-alias-interactive-bg-hover-solid, #212838);
            color: var(--dsw-alias-label-primary, #f8fafc);
          }
          .dsh-au-mobile-trigger:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #3b82f6); outline-offset: 2px; }
          .dsh-au-mobile-trigger[data-dragging="true"] {
            cursor: grabbing;
            transition: none;
            transform: scale(1.06);
            border-color: var(--dsw-alias-state-business-primary, rgba(59, 130, 246, 0.65));
          }
          .dsh-au-mobile-trigger[data-long-pressed="true"] {
            transform: scale(0.9);
            border-color: var(--dsw-alias-state-success-primary, #10b981);
            background: var(--dsw-alias-state-success-tertiary, rgba(16, 185, 129, 0.25));
            color: var(--dsw-alias-label-primary, #34d399);
          }
          html[${MOBILE_ATTR}="true"][${DRAWER_ATTR}="open"] .dsh-au-mobile-trigger,
          html[data-dsh-au-controlled-frame="true"] .dsh-au-mobile-trigger {
            opacity: 0;
            pointer-events: none;
            transform: scale(0.88);
          }
          .dsh-au-mobile-edge-zone {
            position: fixed;
            left: 0;
            top: 44px;
            bottom: 64px;
            width: 16px;
            z-index: 9480;
            background: transparent;
            touch-action: pan-y;
            -webkit-tap-highlight-color: transparent;
          }
          .dsh-au-mobile-backdrop {
            position: fixed;
            inset: 0;
            z-index: 9485;
            background: rgba(4, 8, 16, 0.56);
            backdrop-filter: blur(2px);
            animation: dsh-au-mobile-fade 180ms ease;
          }
          @keyframes dsh-au-mobile-fade { from { opacity: 0; } to { opacity: 1; } }
          /* 新设备栏已自行适配菜单；旧的 28px 图标压缩样式仅用于非 compact 栏，避免 !important 覆盖文字与宽度。 */
          html[${MOBILE_ATTR}="true"] .dsh-au-topbar:not(.compact-mobile) {
            padding: 4px 8px !important;
            min-height: 40px !important;
            gap: 6px !important;
          }
          html[${MOBILE_ATTR}="true"] .dsh-au-topbar:not(.compact-mobile) .dsh-au-tabs {
            flex: 1 1 auto !important;
            min-width: 68px !important;
            gap: 5px !important;
          }
          html[${MOBILE_ATTR}="true"] .dsh-au-topbar:not(.compact-mobile) .dsh-au-tab {
            min-height: 28px !important;
            padding: 2px 8px !important;
            gap: 5px !important;
            font-size: 12px !important;
          }
          html[${MOBILE_ATTR}="true"] .dsh-au-topbar:not(.compact-mobile) .dsh-au-tab .dsh-au-badge,
          html[${MOBILE_ATTR}="true"] .dsh-au-topbar:not(.compact-mobile) .dsh-au-action-divider,
          html[${MOBILE_ATTR}="true"] .dsh-au-topbar:not(.compact-mobile) .dsh-au-tool-label {
            display: none !important;
          }
          html[${MOBILE_ATTR}="true"] .dsh-au-topbar:not(.compact-mobile) .dsh-au-actions {
            gap: 3px !important;
            flex: 0 1 auto !important;
            overflow-x: auto !important;
            scrollbar-width: none !important;
          }
          html[${MOBILE_ATTR}="true"] .dsh-au-topbar:not(.compact-mobile) .dsh-au-actions::-webkit-scrollbar {
            display: none !important;
          }
          html[${MOBILE_ATTR}="true"] .dsh-au-topbar:not(.compact-mobile) .dsh-au-action-group {
            gap: 3px !important;
          }
          html[${MOBILE_ATTR}="true"] .dsh-au-topbar:not(.compact-mobile) .dsh-au-icon-btn {
            min-width: 28px !important;
            width: 28px !important;
            height: 28px !important;
            padding: 0 !important;
          }
          html[${HEADER_ATTR}] [data-slot="conversation.header"] > header,
          html[${HEADER_ATTR}] [data-phase] header[class*="_header"],
          html[${HEADER_ATTR}] header:has(> [data-conversation-header-leading]) {
            max-height: 110px !important;
            opacity: 1 !important;
            transform: translateY(0) !important;
            overflow: hidden !important;
            transition: max-height 220ms cubic-bezier(0.22, 1, 0.36, 1), min-height 220ms cubic-bezier(0.22, 1, 0.36, 1), opacity 180ms ease, transform 220ms cubic-bezier(0.22, 1, 0.36, 1), padding 220ms ease, border-color 220ms ease !important;
          }
          html[${HEADER_ATTR}="collapsed"] [data-slot="conversation.header"] > header,
          html[${HEADER_ATTR}="collapsed"] [data-phase] header[class*="_header"],
          html[${HEADER_ATTR}="collapsed"] header:has(> [data-conversation-header-leading]) {
            max-height: 0px !important;
            min-height: 0px !important;
            height: 0px !important;
            padding-top: 0px !important;
            padding-bottom: 0px !important;
            margin: 0px !important;
            border-bottom-width: 0px !important;
            opacity: 0 !important;
            transform: translateY(-100%) !important;
            pointer-events: none !important;
          }
          html[${HEADER_ATTR}] [data-conversation-content],
          html[${HEADER_ATTR}] [data-slot="conversation.content"] {
            --dsh-chat-user-width: 100% !important;
            --dsh-chat-content-width: 100% !important;
            --dsh-composer-card-max-width: 100% !important;
            --dsh-composer-side-clearance: 6px !important;
            --dsh-composer-dock-inset: 2px !important;
          }
          html[${HEADER_ATTR}] [data-conversation-scroll] {
            scrollbar-gutter: auto !important;
            margin-right: 0 !important;
          }
          html[${HEADER_ATTR}] [data-conversation-scroll] [class*="_scroll"] {
            padding-left: 8px !important;
            padding-right: 8px !important;
          }
          html[${HEADER_ATTR}] [data-conversation-scroll] [class*="_column"] {
            max-width: 100% !important;
          }
          html[${HEADER_ATTR}] [class*="_composerHero"] {
            width: 100% !important;
            max-width: 100% !important;
            padding: 0 8px 20px !important;
            box-sizing: border-box !important;
          }
          html[${MOBILE_ATTR}="true"] [class*="_headline"] {
            font-size: 20px !important;
            line-height: 26px !important;
            gap: 8px !important;
          }
          html[${MOBILE_ATTR}="true"] [class*="_heroWorkspaceRow"] {
            padding: 0 4px !important;
            flex-wrap: wrap !important;
            gap: 4px !important;
          }
          html[${MOBILE_ATTR}="true"] .dsh-au-wb-body {
            grid-template-columns: 1fr !important;
            overflow-y: auto !important;
          }
          html[${MOBILE_ATTR}="true"] .dsh-au-wb-grid {
            grid-template-columns: 1fr !important;
          }
        `;
      }

      /** 仿 DeepSeek App 左上角双横线侧栏唤起图标。 */
      function DrawerTriggerIcon() {
        return h(
          'svg',
          { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
          h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 2.5 }),
          h('line', { x1: 9, y1: 4, x2: 9, y2: 20 }),
          h('line', { x1: 13, y1: 9, x2: 17, y2: 9 }),
          h('line', { x1: 13, y1: 13, x2: 16, y2: 13 })
        );
      }

      /** 主动失焦当前处于对话输入区内的焦点元素，收起移动端软键盘。 */
      function blurActiveComposer(doc = typeof document !== 'undefined' ? document : null) {
        const active = doc?.activeElement;
        if (active && typeof active.closest === 'function' && active.closest('[data-composer-seat]')) {
          try { active.blur?.(); } catch {}
        }
      }

      /**
       * 拦截移动端切换会话或首屏挂载时 Lexical 对 [data-composer-seat] 的自动 focus() 调用：
       * 仅当用户在 COMPOSER_USER_TAP_WINDOW_MS 窗口内主动点击了输入区时才放行聚焦并弹出软键盘。
       */
      function installComposerFocusGuard(win = typeof window !== 'undefined' ? window : null) {
        if (!win || !win.document || !win.HTMLElement?.prototype) return () => {};
        const doc = win.document;
        let lastComposerTapAt = 0;

        const isAllowed = () => (Date.now() - lastComposerTapAt) <= COMPOSER_USER_TAP_WINDOW_MS;
        const isMobileActive = () => (
          doc.documentElement?.getAttribute(MOBILE_ATTR) === 'true'
          || doc.documentElement?.hasAttribute(HEADER_ATTR)
        );
        const isComposerNode = (el) => Boolean(el && typeof el.closest === 'function' && el.closest('[data-composer-seat]'));

        const markUserTap = (event) => {
          const target = event?.target;
          if (isComposerNode(target)) {
            lastComposerTapAt = Date.now();
          } else {
            lastComposerTapAt = 0;
          }
        };

        const proto = win.HTMLElement.prototype;
        const origFocus = proto.focus;
        const patchedFocus = function patchedComposerFocus(...args) {
          if (isMobileActive() && isComposerNode(this) && !isAllowed()) {
            return;
          }
          return origFocus.apply(this, args);
        };
        proto.focus = patchedFocus;

        const onFocusIn = (event) => {
          if (!isMobileActive()) return;
          const target = event?.target;
          if (isComposerNode(target) && !isAllowed()) {
            try { target.blur?.(); } catch {}
          }
        };

        doc.addEventListener('pointerdown', markUserTap, true);
        doc.addEventListener('touchstart', markUserTap, { capture: true, passive: true });
        doc.addEventListener('focusin', onFocusIn, true);

        return () => {
          if (proto.focus === patchedFocus) {
            proto.focus = origFocus;
          }
          doc.removeEventListener('pointerdown', markUserTap, true);
          doc.removeEventListener('touchstart', markUserTap, true);
          doc.removeEventListener('focusin', onFocusIn, true);
        };
      }

      /**
       * 拦截移动端输入框的键盘换行键（Enter），防止误触发直接发送：
       * 在移动端软键盘中，换行键派发的是普通 Enter 键（shiftKey=false），
       * 默认会被 DSH 的 KEY_ENTER_COMMAND 捕获并调用 handlers.submit() 发送消息。
       * 在捕获阶段拦截输入区内的 Enter 键：
       * 1. 将 shiftKey 代理为 true，并清理 ctrlKey/metaKey；
       * 2. DSH 的命令处理器检测到 shiftKey=true 会主动放行（return false），不触发提交；
       * 3. 从而交由 Lexical 默认的换行逻辑（INSERT_LINE_BREAK_COMMAND）在光标处插入换行，
       *    实现「换行键只换行不发送，只能点击界面按钮发送」的移动端交互。
       */
      function installMobileComposerEnterKeyHandler(win = typeof window !== 'undefined' ? window : null) {
        if (!win || !win.document) return () => {};
        const doc = win.document;

        const isMobileActive = () => (
          doc.documentElement?.getAttribute(MOBILE_ATTR) === 'true'
          || doc.documentElement?.hasAttribute(HEADER_ATTR)
          || isMobileViewport(win.innerWidth, win)
        );

        const isComposerNode = (el) => Boolean(
          el && (
            (typeof el.closest === 'function' && el.closest('[data-composer-seat]'))
            || el.getAttribute?.('data-composer-seat')
          )
        );

        const onKeyDown = (event) => {
          if (!event) return;
          const key = event.key || event.code;
          const isEnter = key === 'Enter' || event.keyCode === 13 || event.which === 13;
          if (!isEnter) return;

          if (!isMobileActive()) return;

          const target = event.target || doc.activeElement;
          if (!isComposerNode(target)) return;

          // 移动端输入框内按 Enter：改写修饰键，使 DSH 判定为 Shift+Enter（换行）并拒绝提交
          try {
            Object.defineProperty(event, 'shiftKey', {
              get: () => true,
              configurable: true,
            });
          } catch {}

          try {
            Object.defineProperty(event, 'ctrlKey', {
              get: () => false,
              configurable: true,
            });
          } catch {}

          try {
            Object.defineProperty(event, 'metaKey', {
              get: () => false,
              configurable: true,
            });
          } catch {}

          if (typeof event.getModifierState === 'function') {
            const orig = event.getModifierState.bind(event);
            try {
              Object.defineProperty(event, 'getModifierState', {
                value: (mod) => {
                  if (mod === 'Shift') return true;
                  if (mod === 'Control' || mod === 'Meta') return false;
                  return orig(mod);
                },
                configurable: true,
              });
            } catch {}
          }
        };

        doc.addEventListener('keydown', onKeyDown, true);

        return () => {
          doc.removeEventListener('keydown', onKeyDown, true);
        };
      }

      /** 同步 html 根节点上的竖屏抽屉属性与全向触屏顶部栏折叠属性，卸载或切回桌面端时完整清理。 */
      function syncDocumentDrawerState(isDrawerMode, drawerOpen, isTouchHeaderMode = isDrawerMode, headerCollapsed = false, isNarrowMobile = isDrawerMode) {
        if (typeof document === 'undefined') return;
        const root = document.documentElement;
        if (!isDrawerMode) {
          // 若宿主使用新版原生抽屉，仍保留窄屏排版属性但彻底移除自定义抽屉控制属性，防止接管侧栏或触发遮罩错位
          if (isNarrowMobile) {
            root.setAttribute(MOBILE_ATTR, 'true');
          } else {
            root.removeAttribute(MOBILE_ATTR);
          }
          root.removeAttribute(DRAWER_ATTR);
          root.removeAttribute(DRAGGING_ATTR);
          root.style.removeProperty(DRAWER_OFFSET_VAR);
        } else {
          root.setAttribute(MOBILE_ATTR, 'true');
          root.setAttribute(DRAWER_ATTR, drawerOpen ? 'open' : 'closed');
        }
        if (!isTouchHeaderMode) {
          root.removeAttribute(HEADER_ATTR);
        } else {
          root.setAttribute(HEADER_ATTR, headerCollapsed ? 'collapsed' : 'expanded');
        }
      }

      /** 移动端抽屉与手势控制器：竖屏启用侧边栏抽屉与可拖动悬浮按钮，横屏保持原生侧边栏但保留上下滑隐藏顶部区域。 */
      function MobileDrawerShell({ ensureHostSidebarExpanded, hostStartSession }) {
        const [isMobile, setIsMobile] = useState(() => (typeof window !== 'undefined' ? isMobileViewport(window.innerWidth, window) : false));
        const [isDrawerMode, setIsDrawerMode] = useState(() => (typeof window !== 'undefined' ? isPortraitDrawerMode(window.innerWidth, window.innerHeight, window) : false));
        const [nativeDrawer, setNativeDrawer] = useState(() => (typeof document !== 'undefined' ? hasNativeSidebarDrawer(document) : false));
        const [remoteDshActive, setRemoteDshActive] = useState(() => (typeof document !== 'undefined' ? isRemoteDshActive(document) : false));
        const [drawerOpen, setDrawerOpen] = useState(false);
        const [headerCollapsed, setHeaderCollapsed] = useState(false);
        const [customTriggerPos, setCustomTriggerPos] = useState(readSavedTriggerPosition);
        const [defaultTriggerPos, setDefaultTriggerPos] = useState(() => (
          typeof window !== 'undefined'
            ? getDefaultTriggerPosition(window.innerWidth, window.innerHeight)
            : { top: 628, left: DEFAULT_TRIGGER_LEFT }
        ));
        const gestureRef = useRef(null);
        const triggerDragRef = useRef(null);
        const longPressTimerRef = useRef(null);
        const suppressTriggerClickRef = useRef(false);
        // 记录未被软键盘压缩的视口；键盘收起后据此恢复按钮原有坐标。
        const stableViewportRef = useRef({
          width: typeof window !== 'undefined' ? window.innerWidth : 375,
          height: typeof window !== 'undefined' ? window.innerHeight : 812,
        });

        const clearLongPressTimer = useCallback(() => {
          if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
          }
        }, []);

        useEffect(() => {
          if (!customTriggerPos) return;
          try { localStorage.setItem(TRIGGER_POSITION_STORAGE_KEY, JSON.stringify(customTriggerPos)); } catch {}
        }, [customTriggerPos]);

        useEffect(() => {
          ensureMobileStyles();
          blurActiveComposer();
          const refreshPositions = () => {
            // 软键盘打开期间 visual viewport 会变矮；不得把临时高度写回拖拽位置，
            // 否则键盘收起后按钮会永久停在被顶高的位置。
            if (isSoftKeyboardViewport(window, stableViewportRef.current)) return;
            stableViewportRef.current = { width: window.innerWidth, height: window.innerHeight };
            const nextMobile = isMobileViewport(window.innerWidth, window);
            const nextDrawer = isPortraitDrawerMode(window.innerWidth, window.innerHeight, window);
            const nextNativeDrawer = hasNativeSidebarDrawer(document);
            setNativeDrawer((prev) => {
              if (prev !== nextNativeDrawer && nextNativeDrawer) setDrawerOpen(false);
              return nextNativeDrawer;
            });
            setDefaultTriggerPos(getDefaultTriggerPosition(window.innerWidth, window.innerHeight));
            setCustomTriggerPos((prev) => (prev ? clampTriggerPosition(prev, window.innerWidth, window.innerHeight) : null));
            setIsDrawerMode((prev) => {
              if (prev !== nextDrawer && !nextDrawer) setDrawerOpen(false);
              return nextDrawer;
            });
            setIsMobile((prev) => {
              if (prev !== nextMobile && !nextMobile) {
                setDrawerOpen(false);
                setHeaderCollapsed(false);
              }
              return nextMobile;
            });
          };
          refreshPositions();
          const timer = setTimeout(refreshPositions, 180);
          const visualViewport = window.visualViewport;
          window.addEventListener('resize', refreshPositions);
          visualViewport?.addEventListener('resize', refreshPositions);
          return () => {
            clearTimeout(timer);
            window.removeEventListener('resize', refreshPositions);
            visualViewport?.removeEventListener('resize', refreshPositions);
            syncDocumentDrawerState(false, false, false, false, false);
          };
        }, []);

        const controlledFrame = typeof isControlledFrame === 'function' && isControlledFrame();
        const customDrawerActive = isDrawerMode && !nativeDrawer;
        const prevRemoteActiveRef = useRef(remoteDshActive);

        useEffect(() => {
          syncDocumentDrawerState(customDrawerActive, controlledFrame ? false : drawerOpen, isMobile, headerCollapsed, isDrawerMode);
          if (!isDrawerMode) return undefined;
          const syncRemoteAndSidebar = () => {
            const nextRemoteActive = isRemoteDshActive(document);
            const nextNativeDrawer = hasNativeSidebarDrawer(document);
            if (prevRemoteActiveRef.current !== nextRemoteActive) {
              prevRemoteActiveRef.current = nextRemoteActive;
              setDrawerOpen(false);
            }
            setRemoteDshActive((prev) => (prev === nextRemoteActive ? prev : nextRemoteActive));
            setNativeDrawer((prev) => {
              if (prev !== nextNativeDrawer && nextNativeDrawer) setDrawerOpen(false);
              return prev === nextNativeDrawer ? prev : nextNativeDrawer;
            });
            if (controlledFrame || nextNativeDrawer) return;
            // 仅在旧版宿主（无原生抽屉）的竖屏抽屉模式下保持 SidebarRoot 为 wide 渲染态；新版原生抽屉由宿主自行管理折叠状态
            if (document.querySelector('[data-sidebar-collapsed]')) {
              ensureHostSidebarExpanded();
            }
          };
          syncRemoteAndSidebar();
          if (typeof MutationObserver === 'undefined') return undefined;
          const observer = new MutationObserver(syncRemoteAndSidebar);
          observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-dsh-au-remote-active'],
          });
          observer.observe(document.body, {
            attributes: true,
            childList: true,
            subtree: true,
            attributeFilter: ['data-sidebar-drawer', 'data-sidebar-collapsed', 'style', 'class'],
          });
          return () => observer.disconnect();
        }, [isDrawerMode, customDrawerActive, controlledFrame, drawerOpen, isMobile, headerCollapsed, ensureHostSidebarExpanded]);

        const openDrawer = useCallback(() => {
          blurActiveComposer();
          ensureHostSidebarExpanded();
          setDrawerOpen(true);
        }, [ensureHostSidebarExpanded]);

        const closeDrawer = useCallback(() => {
          blurActiveComposer();
          setDrawerOpen(false);
        }, []);

        const activeTriggerPos = customTriggerPos || defaultTriggerPos;

        const startTriggerDrag = useCallback((event) => {
          if (event.button !== undefined && event.button !== 0) return;
          event.stopPropagation();
          const btnEl = event.currentTarget;
          btnEl.setPointerCapture?.(event.pointerId);
          btnEl.setAttribute('data-dragging', 'true');
          const clamped = clampTriggerPosition(activeTriggerPos, window.innerWidth, window.innerHeight);
          triggerDragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            origin: clamped,
            moved: false,
            longPressed: false,
          };
          clearLongPressTimer();
          longPressTimerRef.current = setTimeout(() => {
            longPressTimerRef.current = null;
            const currentDrag = triggerDragRef.current;
            if (!currentDrag || currentDrag.moved) return;
            currentDrag.longPressed = true;
            suppressTriggerClickRef.current = true;
            btnEl.removeAttribute('data-dragging');
            btnEl.setAttribute('data-long-pressed', 'true');
            setTimeout(() => btnEl.removeAttribute('data-long-pressed'), 280);
            try { navigator.vibrate?.(18); } catch {}
            blurActiveComposer();
            setHeaderCollapsed(false);
            setDrawerOpen(false);
            triggerNewSession(hostStartSession);
          }, LONG_PRESS_DELAY_MS);
        }, [activeTriggerPos, clearLongPressTimer, hostStartSession]);

        const moveTriggerDrag = useCallback((event) => {
          const drag = triggerDragRef.current;
          if (!drag || drag.pointerId !== event.pointerId || drag.longPressed) return;
          const dx = event.clientX - drag.startX;
          const dy = event.clientY - drag.startY;
          if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
            drag.moved = true;
            clearLongPressTimer();
            event.preventDefault();
          }
          setCustomTriggerPos(clampTriggerPosition({
            top: drag.origin.top + dy,
            left: drag.origin.left + dx,
          }, window.innerWidth, window.innerHeight));
        }, [clearLongPressTimer]);

        const endTriggerDrag = useCallback((event) => {
          clearLongPressTimer();
          const drag = triggerDragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          triggerDragRef.current = null;
          suppressTriggerClickRef.current = drag.moved || drag.longPressed;
          event.currentTarget.removeAttribute('data-dragging');
          if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }, [clearLongPressTimer]);

        // 绑定左右触摸滑动手势（右滑拉开、左滑收起）、上下滑/滚动折叠顶部栏及侧边栏会话点击自动收起
        useEffect(() => {
          if (!isMobile) return undefined;
          const root = document.documentElement;
          const scrollPositions = new WeakMap();

          const onScrollCapture = (event) => {
            if (drawerOpen) return;
            const scroller = event?.target;
            if (!(scroller instanceof Element)) return;
            if (scroller.closest('[class*="sidebarCol"], aside[data-slot="sidebar"], [role="dialog"], .dsh-au-mask, [data-composer-seat]')) {
              return;
            }
            if (!scroller.matches('[data-conversation-scroll], [class*="_scrollBody"], [class*="_scroll"]')) {
              return;
            }
            const nextTop = scroller.scrollTop;
            const prevTop = scrollPositions.has(scroller) ? scrollPositions.get(scroller) : nextTop;
            const res = evaluateScrollHeaderState({
              headerCollapsed,
              prevScrollTop: prevTop,
              nextScrollTop: nextTop,
            });
            if (res.triggered || Math.abs(nextTop - prevTop) >= HEADER_SCROLL_DELTA_PX || nextTop <= 6) {
              scrollPositions.set(scroller, nextTop);
            }
            if (res.triggered) {
              setHeaderCollapsed(res.nextCollapsed);
            }
          };

          const onTouchStart = (event) => {
            if (!event.touches || event.touches.length !== 1) return;
            const touch = event.touches[0];
            const target = event.target instanceof Element ? event.target : null;
            // Todo 面板自身需要接收 Pointer 拖拽和列表滚动；不让抽屉手势并发抢占该触摸序列。
            if (target?.closest('.dsh-au-mobile-trigger, .dsh-au-todo-dock, .dsh-au-todo-capsule')) return;
            const inSidebarOrModal = Boolean(target?.closest('[class*="sidebarCol"], aside[data-slot="sidebar"], [role="dialog"], .dsh-au-mask, [data-composer-seat]'));
            gestureRef.current = {
              startX: touch.clientX,
              startY: touch.clientY,
              anchorY: touch.clientY,
              drawerWidth: getDrawerWidth(window.innerWidth),
              inScrollable: isHorizontalScrollTarget(target),
              inSidebarOrModal,
              active: false,
              shouldOpen: drawerOpen,
            };
          };

          const onTouchMove = (event) => {
            const g = gestureRef.current;
            if (!g || !event.touches || event.touches.length !== 1) return;
            const touch = event.touches[0];
            const res = customDrawerActive
              ? evaluateSwipeGesture({
                  drawerOpen: controlledFrame ? false : drawerOpen,
                  startX: g.startX,
                  startY: g.startY,
                  currentX: touch.clientX,
                  currentY: touch.clientY,
                  drawerWidth: g.drawerWidth,
                  inScrollable: g.inScrollable,
                })
              : { active: false, translateXPx: 0, shouldOpen: false };
            if (!res.active && !g.active) {
              if (!drawerOpen && !g.inSidebarOrModal) {
                const vRes = evaluateVerticalHeaderSwipe({
                  headerCollapsed,
                  startX: g.startX,
                  startY: g.anchorY,
                  currentX: touch.clientX,
                  currentY: touch.clientY,
                });
                if (vRes.triggered) {
                  g.anchorY = touch.clientY;
                  setHeaderCollapsed(vRes.nextCollapsed);
                }
              }
              return;
            }
            g.active = true;
            g.shouldOpen = res.shouldOpen;
            if (controlledFrame) {
              try {
                window.parent?.postMessage({
                  source: 'dsh-au',
                  type: 'dsh-au:mobile-drawer-swipe',
                  phase: 'move',
                  translateXPx: res.translateXPx,
                  shouldOpen: res.shouldOpen,
                }, '*');
              } catch {}
              return;
            }
            if (!drawerOpen) ensureHostSidebarExpanded();
            root.setAttribute(DRAGGING_ATTR, 'true');
            root.style.setProperty(DRAWER_OFFSET_VAR, `${res.translateXPx}px`);
          };

          const finishGesture = () => {
            const g = gestureRef.current;
            gestureRef.current = null;
            if (controlledFrame) {
              if (g && g.active) {
                try {
                  window.parent?.postMessage({
                    source: 'dsh-au',
                    type: 'dsh-au:mobile-drawer-swipe',
                    phase: 'end',
                    shouldOpen: Boolean(g.shouldOpen),
                  }, '*');
                } catch {}
              }
              return;
            }
            root.removeAttribute(DRAGGING_ATTR);
            root.style.removeProperty(DRAWER_OFFSET_VAR);
            if (g && g.active) {
              setDrawerOpen(Boolean(g.shouldOpen));
            }
          };

          const onControlledSwipeMessage = (event) => {
            if (controlledFrame || !customDrawerActive) return;
            const data = event?.data;
            if (!data || data.source !== 'dsh-au' || data.type !== 'dsh-au:mobile-drawer-swipe') return;
            if (data.phase === 'move') {
              if (!drawerOpen) ensureHostSidebarExpanded();
              root.setAttribute(DRAGGING_ATTR, 'true');
              root.style.setProperty(DRAWER_OFFSET_VAR, `${Number(data.translateXPx) || 0}px`);
            } else if (data.phase === 'end') {
              root.removeAttribute(DRAGGING_ATTR);
              root.style.removeProperty(DRAWER_OFFSET_VAR);
              if (data.shouldOpen) {
                blurActiveComposer();
                ensureHostSidebarExpanded();
                setDrawerOpen(true);
              } else {
                setDrawerOpen(false);
              }
            }
          };

          const onKeyDown = (event) => {
            if (event.key === 'Escape' && drawerOpen) closeDrawer();
          };

          const onDocumentClick = (event) => {
            if (!drawerOpen || !(event.target instanceof Element)) return;
            const sidebar = event.target.closest('[class*="sidebarCol"], aside[data-slot="sidebar"]');
            if (!sidebar) return;
            const nativeToggle = event.target.closest('button[class*="_toggle"]');
            if (nativeToggle) {
              event.preventDefault();
              event.stopPropagation();
              closeDrawer();
              return;
            }
            if (shouldCloseDrawerOnSidebarClick(event.target)) {
              setHeaderCollapsed(false);
              closeDrawer();
            }
          };

          document.addEventListener('scroll', onScrollCapture, { capture: true, passive: true });
          window.addEventListener('touchstart', onTouchStart, { passive: true });
          window.addEventListener('touchmove', onTouchMove, { passive: true });
          window.addEventListener('touchend', finishGesture, { passive: true });
          window.addEventListener('touchcancel', finishGesture, { passive: true });
          window.addEventListener('message', onControlledSwipeMessage);
          window.addEventListener('keydown', onKeyDown);
          document.addEventListener('click', onDocumentClick, true);
          return () => {
            document.removeEventListener('scroll', onScrollCapture, true);
            window.removeEventListener('touchstart', onTouchStart);
            window.removeEventListener('touchmove', onTouchMove);
            window.removeEventListener('touchend', finishGesture);
            window.removeEventListener('touchcancel', finishGesture);
            window.removeEventListener('message', onControlledSwipeMessage);
            window.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('click', onDocumentClick, true);
            root.removeAttribute(DRAGGING_ATTR);
            root.style.removeProperty(DRAWER_OFFSET_VAR);
          };
        }, [isMobile, customDrawerActive, controlledFrame, remoteDshActive, drawerOpen, headerCollapsed, closeDrawer, ensureHostSidebarExpanded]);

        // 受控远端 iframe 内部不重复挂载悬浮折叠按钮；移动端始终由外层主 DSH 提供统一侧边栏抽屉与悬浮按钮。
        if (!isDrawerMode || controlledFrame || typeof document === 'undefined') return null;
        // 方案 B：新版 DSH 原生抽屉存在时直接退让，交由宿主原生侧栏开关与抽屉遮罩接管。
        if (nativeDrawer) return null;

        const resolvedTriggerPos = clampTriggerPosition(activeTriggerPos, window.innerWidth, window.innerHeight);

        return ReactDOM.createPortal(
          h(
            React.Fragment,
            null,
            remoteDshActive && !drawerOpen
              ? h('div', {
                  className: 'dsh-au-mobile-edge-zone',
                  'aria-hidden': true,
                })
              : null,
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-au-mobile-trigger',
                style: { top: `${resolvedTriggerPos.top}px`, left: `${resolvedTriggerPos.left}px` },
                onPointerDown: startTriggerDrag,
                onPointerMove: moveTriggerDrag,
                onPointerUp: endTriggerDrag,
                onPointerCancel: endTriggerDrag,
                onLostPointerCapture: endTriggerDrag,
                onContextMenu: (event) => event.preventDefault(),
                onClick: () => {
                  if (suppressTriggerClickRef.current) {
                    suppressTriggerClickRef.current = false;
                    return;
                  }
                  openDrawer();
                },
                title: '单击展开侧边栏；长按新建对话；拖动可移动位置',
                'aria-label': '展开侧边栏（长按新建对话）',
                'aria-expanded': drawerOpen,
              },
              h(DrawerTriggerIcon)
            ),
            drawerOpen
              ? h('div', {
                  className: 'dsh-au-mobile-backdrop',
                  onClick: closeDrawer,
                  'aria-label': '关闭侧边栏遮罩',
                })
              : null
          ),
          document.body
        );
      }

      const inject = ['slots', 'layout'];
      function apply(ctx) {
        // 开关只影响当前浏览器；关闭后刷新页面生效。
        if (!readMobileFeatureEnabled()) return;
        ctx.effect(() => ensureMobileStyles(), 'dsh-au-mobile: style');
        ctx.effect(() => installComposerFocusGuard(), 'dsh-au-mobile: focus-guard');
        ctx.effect(() => installMobileComposerEnterKeyHandler(), 'dsh-au-mobile: enter-guard');
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'dsh-au-mobile-shell',
              inject: () => ({
                // 抽屉拉开时确保宿主侧边栏处于完整内容态，而非桌面折叠窄图标态。
                ensureHostSidebarExpanded: () => {
                  try {
                    if (document.querySelector('[data-sidebar-collapsed]')) {
                      ctx.layout.toggleSidebar();
                    }
                  } catch {}
                },
                // 长按悬浮按钮时直接调用宿主工作区服务新建对话。
                hostStartSession: () => {
                  const ws = ctx.get?.('uiWorkspace');
                  if (ws && typeof ws.startSession === 'function') {
                    ws.startSession();
                    return;
                  }
                  throw new Error('uiWorkspace unavailable');
                },
              }),
            },
            MobileDrawerShell
          )
        );
      }

      return {
        inject,
        apply,
        helpers: {
          isMobileViewport,
          isPortraitDrawerMode,
          getDrawerWidth,
          getDefaultTriggerPosition,
          clampTriggerPosition,
          isRemoteDshActive,
          hasNativeSidebarDrawer,
          isSoftKeyboardViewport,
          triggerNewSession,
          isHorizontalScrollTarget,
          evaluateSwipeGesture,
          evaluateVerticalHeaderSwipe,
          evaluateScrollHeaderState,
          shouldCloseDrawerOnSidebarClick,
          installComposerFocusGuard,
          installMobileComposerEnterKeyHandler,
          readMobileFeatureEnabled,
          writeMobileFeatureEnabled,
        },
      };
    })();
