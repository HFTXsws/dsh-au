    /**
     * 通用预览沙盒中继桥：无论当前是主控制端还是受控端 iframe，都在页面加载首毫秒注册。
     * 接收侧边栏 sandbox="allow-scripts" 预览 iframe 的 postMessage，经同源 /dsh-au/api 转发，
     * 服务端严格校验目标私人扩展在 extension.json 中显式声明了 allowPreviewBridge: true。
     */
    function installPreviewExtBridge() {
      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {};
      const onMessage = (ev) => {
        const msg = ev && ev.data;
        if (!msg || msg.type !== 'dsh-au:preview-ext:req' || !msg.reqId || !msg.extId || !msg.subAction) return;
        const src = ev.source;
        if (!src || src === window || typeof src.postMessage !== 'function') return;
        Promise.resolve()
          .then(() => callApi('extAction', {
            extId: String(msg.extId),
            subAction: String(msg.subAction),
            payload: msg.payload && typeof msg.payload === 'object' ? msg.payload : {},
            fromPreviewBridge: true,
          }))
          .then((res) => {
            src.postMessage({
              type: 'dsh-au:preview-ext:res',
              reqId: msg.reqId,
              ok: Boolean(res && res.ok !== false),
              data: res,
              error: res && res.ok === false ? (res.error || 'ext-error') : '',
            }, '*');
          })
          .catch((err) => {
            src.postMessage({
              type: 'dsh-au:preview-ext:res',
              reqId: msg.reqId,
              ok: false,
              error: err?.message || String(err),
            }, '*');
          });
      };
      window.addEventListener('message', onMessage);
      return () => window.removeEventListener('message', onMessage);
    }

    /**
     * 移动端 HTML 预览白屏兼容补丁：
     * DSH 宿主以 <iframe src="blob:..." sandbox="allow-scripts"> 渲染交互式 HTML，
     * 部分 Android OEM / iOS 手机浏览器在无 allow-same-origin 的 sandbox iframe 中会静默阻止 blob: 导航导致白屏。
     * 在移动端由父页面毫秒级读取同源 blob 内容并转为 srcdoc（严格保留 sandbox="allow-scripts" 安全边界）。
     */
    function unpackDshHtmlBundle(blobText) {
      const m = typeof blobText === 'string' && blobText.match(/JSON\.parse\(text\("([A-Za-z0-9+/=]+)"\)\)/);
      if (!m) return blobText;
      try {
        const bin = atob(m[1]);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        const parsed = JSON.parse(new TextDecoder('utf-8').decode(bytes));
        if (parsed && typeof parsed.html === 'string' && (!Array.isArray(parsed.assets) || parsed.assets.length === 0)) {
          return parsed.html;
        }
      } catch {}
      return blobText;
    }

    function installMobileHtmlPreviewFix() {
      if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
      const ua = String(window.navigator?.userAgent || '');
      const isMobileUa = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS|ColorOS/i.test(ua);
      if (!isMobileUa) return () => {};
      const patchIframe = (iframe) => {
        if (!iframe || iframe.tagName !== 'IFRAME') return;
        if (!iframe.hasAttribute('data-html-preview')) return;
        const src = iframe.getAttribute('src') || '';
        if (!src.startsWith('blob:')) return;
        if (iframe.dataset.dshAuSrcdocFor === src) return;
        iframe.dataset.dshAuSrcdocFor = src;
        fetch(src)
          .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then((blobText) => {
            if (!iframe.isConnected || iframe.dataset.dshAuSrcdocFor !== src) return;
            const html = unpackDshHtmlBundle(blobText);
            iframe.removeAttribute('src');
            iframe.setAttribute('srcdoc', html);
          })
          .catch(() => {
            delete iframe.dataset.dshAuSrcdocFor;
          });
      };
      const scanAll = (root) => {
        if (!root || typeof root.querySelectorAll !== 'function') return;
        if (root.tagName === 'IFRAME') patchIframe(root);
        root.querySelectorAll('iframe[data-html-preview][src^="blob:"]').forEach(patchIframe);
      };
      scanAll(document);
      if (typeof MutationObserver !== 'function') return () => {};
      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === 'attributes' && m.target) {
            patchIframe(m.target);
          } else if (m.addedNodes && m.addedNodes.length) {
            for (const node of m.addedNodes) {
              if (node && node.nodeType === 1) scanAll(node);
            }
          }
        }
      });
      observer.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src'],
      });
      return () => observer.disconnect();
    }

    function apply(ctx) {
      // 无论作为主控制端还是受控端 iframe，均安装剪贴板兼容补丁以修补远程 HTTP 下复制代码块失效的问题。
      ctx.effect(() => {
        installClipboardPolyfill();
        return () => {};
      }, 'dsh-au: clipboard polyfill');

      // 无论作为主控制端还是受控端 iframe，首毫秒安装预览沙盒扩展中继桥。
      ctx.effect(() => installPreviewExtBridge(), 'dsh-au: preview ext bridge');

      // 移动端将 HTML 预览的 blob: iframe 转为 srcdoc，规避 Android/iOS 浏览器沙盒拦截 blob: 导致的白屏。
      ctx.effect(() => installMobileHtmlPreviewFix(), 'dsh-au: mobile html preview srcdoc fix');

      // 被控制端由外层 DSH-AU 统一提供设备栏；仅保留按键桥以穿透 iframe 的焦点边界。
      if (isControlledFrame()) {
        controlledClientCtx = ctx;
        if (ctx.layout && typeof ctx.layout.toggleSidebar === 'function') {
          const origToggleSidebar = ctx.layout.toggleSidebar.bind(ctx.layout);
          ctx.layout.toggleSidebar = () => {
            try {
              window.top?.postMessage({
                source: 'dsh-au',
                type: 'dsh-au:controlled-host-action',
                action: 'toggle-sidebar',
              }, '*');
            } catch {}
          };
        }
        if (ctx.layout && typeof ctx.layout.selectPanel === 'function') {
          const origSelectPanel = ctx.layout.selectPanel.bind(ctx.layout);
          ctx.layout.selectPanel = (panelId) => {
            if (panelId && panelId !== PANEL_ID) {
              try { origSelectPanel(null); } catch {}
              try {
                window.top?.postMessage({
                  source: 'dsh-au',
                  type: 'dsh-au:controlled-host-action',
                  action: 'select-panel',
                  panelId,
                }, '*');
              } catch {}
              return;
            }
            return origSelectPanel(panelId);
          };
        }
        ctx.effect(() => installModelShortcuts(ctx), 'dsh-au: controlled model shortcuts');
        ctx.effect(() => initShortcutStore(), 'dsh-au: shortcut store');
        ctx.effect(() => installControlledFrameShortcutBridge(), 'dsh-au: controlled frame shortcut bridge');
        // 只读预热远端宿主正文缓存，不切换 mainView，也不提前激活历史 Agent。
        ctx.effect(() => installControlledSessionPreload(ctx), 'dsh-au: controlled session preload');
        // 被控制的远端页面里，待办的会话桥与移动端样式同样要装；各自内部会按受控状态收敛。
        todoClient.apply(ctx);
        remoteWorkspacesClient.apply(ctx);
        mobileClient.apply(ctx);
        return;
      }
      // 同页双 Loader 只允许一个控制端实例注册插槽与快捷键。
      if (window[CLIENT_APPLY_LOCK]) return;
      window[CLIENT_APPLY_LOCK] = true;
      ctx.effect(() => () => {
        if (window[CLIENT_APPLY_LOCK]) delete window[CLIENT_APPLY_LOCK];
      }, 'dsh-au: client singleton');
      ctx.effect(() => installPageLifecycleTrace(), 'dsh-au: page lifecycle trace');
      ctx.effect(() => ensureStyles(), 'dsh-au: style');
      ctx.effect(() => installModelShortcuts(ctx), 'dsh-au: model shortcuts');
      ctx.effect(() => { void loadFeatures(); return () => {}; }, 'dsh-au: features');
      ctx.effect(() => initShortcutStore(), 'dsh-au: shortcut store');
      todoClient.apply(ctx);
      remoteWorkspacesClient.apply(ctx);
      mobileClient.apply(ctx);
      // 窗口位置记忆：启动时按记录还原，开启后轮询采样并写回 Host 配置。
      ctx.effect(() => {
        const controller = createWindowStateController();
        windowStateController = controller;
        void controller.start();
        return () => {
          controller.dispose();
          if (windowStateController === controller) windowStateController = null;
        };
      }, 'dsh-au: window state memory');
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-au',
            // 排在 DSH 内置「桌面设置」（order 100）之后，作为本机桌面增强的补充入口。
            order: 110,
            label: () => 'DSH AU',
          },
          AuSettingsSection
        )
      );
      ctx.effect(() => {
        let disposers = [];
        const clear = () => {
          for (const dispose of disposers) if (typeof dispose === 'function') dispose();
          disposers = [];
        };
        // 用户改过某个动作的键位后，不再向 DSH 注册表交出默认键位，避免旧键位继续生效。
        const customized = (actionId) => Object.prototype.hasOwnProperty.call(shortcutStore.overrides, actionId);
        const register = (actionId, id, label, code, direction) => {
          try {
            // Tab 键在 DSH ShortcutRegistry 中属于系统保留键（desktop:linux / web），仅注册无默认键位的命令项并由捕获监听处理
            const defaults = code === 'Tab' || customized(actionId)
              ? {}
              : {
                  'desktop:windows': { code, modifiers: ['alt'] },
                  'desktop:macos': { code, modifiers: ['alt'] },
                  'desktop:linux': { code, modifiers: ['alt'] },
                  'web:windows': { code, modifiers: ['primary', 'alt'] },
                  'web:macos': { code, modifiers: ['primary', 'alt'] },
                };
            return ctx.shortcuts.register({
              id,
              label: () => label,
              aliases: [id, direction < 0 ? 'previous device' : 'next device'],
              defaults,
              regions: ['page', 'editable'],
              modals: [],
              resolve: () => ({ status: 'handled', run: () => dispatchDeviceSwitch(direction) }),
            });
          } catch {
            return undefined;
          }
        };
        const registerWorkbenchShortcut = (id, label, tab) => {
          try {
            // 注意：DSH 内置插件 @deepseek-ai/dsh-client-ui-sidebar-right 的 pane.split 占用了 Primary+Backslash 默认键位且未加 try/catch；
            // 因此若自定义键位为 Backslash 或 Tab 则 defaults 传空对象由 keydown 兜底；其余键位（如默认 Alt+1/2/9/0）正常向宿主注册 defaults，使桌面端在远端未升级插件时也能直接拦截 iframe 按键。
            const actionMap = {
              settings: { actionId: 'settings.open', alias: 'open dsh-au settings' },
              cloudSync: { actionId: 'cloudSync.open', alias: 'open cloud sync settings' },
              fav: { actionId: 'menu.open', alias: 'open command menu' },
              services: { actionId: 'services.open', alias: 'open background services' },
            };
            const mapped = actionMap[tab] || actionMap.services;
            const binding = effectiveShortcutBinding(mapped.actionId);
            const platform = ctx.shortcuts?.platform;
            let defaults = {};
            if (binding && binding.code && binding.code !== 'Backslash' && binding.code !== 'Tab') {
              const modifiers = ['ctrl', 'alt', 'shift', 'meta'].filter((key) => binding[key]).map((key) => (key === 'ctrl' ? 'control' : key));
              if (platform) {
                defaults = { [`desktop:${platform}`]: { code: binding.code, modifiers } };
              } else {
                defaults = {
                  'desktop:windows': { code: binding.code, modifiers },
                  'desktop:macos': { code: binding.code, modifiers },
                  'desktop:linux': { code: binding.code, modifiers },
                };
              }
            }
            return ctx.shortcuts.register({
              id,
              label: () => label,
              aliases: [id, mapped.alias],
              defaults,
              regions: ['page', 'editable'],
              modals: [],
              resolve: () => ({ status: 'handled', run: () => dispatchWorkbenchShortcut(tab) }),
            });
          } catch {
            return undefined;
          }
        };
        const sync = () => {
          clear();
          // 快捷键总开关关闭时不向 DSH 注册表交出任何键位。
          if (!shortcutStore.enabled) return;
          disposers.push(
            register('device.previous', 'dsh-au.device.previous', '切换到左侧设备', 'BracketLeft', -1),
            register('device.next', 'dsh-au.device.next', '切换到右侧设备', 'BracketRight', 1),
            // Ctrl+Tab 向右，Ctrl+Shift+Tab 向左（默认键位，可在设置页修改）；均保留当前设备栏折叠态。
            register('device.next.tab', 'dsh-au.device.next.ctrl-tab', '切换到右侧设备（备用）', 'Tab', 1),
            register('device.previous.tab', 'dsh-au.device.previous.ctrl-shift-tab', '切换到左侧设备（备用）', 'Tab', -1),
            registerWorkbenchShortcut('dsh-au.settings.open', '打开 DSH AU 设置', 'settings'),
            registerWorkbenchShortcut('dsh-au.cloud-sync.open', '打开云端同步设置', 'cloudSync'),
            registerWorkbenchShortcut('dsh-au.workbench.menu', '打开统一菜单', 'fav'),
            registerWorkbenchShortcut('dsh-au.workbench.services', '打开后台服务', 'services'),
          );
        };
        sync();
        shortcutStore.listeners.add(sync);
        return () => {
          shortcutStore.listeners.delete(sync);
          clear();
        };
      }, 'dsh-au: device switch shortcuts');
      ctx.slots.inject('shell.overlay', () => ctx.slots.register(
        { name: 'shell.overlay', id: 'dsh-au-model-shortcuts' }, ModelShortcutOverlay
      ));
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'dsh-au-shell',
            inject: () => ({
              selectPanel: ctx.layout.selectPanel.bind(ctx.layout),
              toggleSidebar: () => ctx.layout.toggleSidebar(),
              openLocalSession: (sessionId) => {
                const workspace = ctx.get?.('uiWorkspace') || ctx.uiWorkspace;
                if (typeof workspace?.openSession !== 'function') return false;
                workspace.openSession(sessionId);
                return true;
              },
              openBridgedLocalSession: async (sessionId) => {
                const workspace = ctx.get?.('uiWorkspace') || ctx.uiWorkspace;
                if (typeof workspace?.openSession !== 'function') {
                  throw new Error('uiWorkspace.openSession 未就绪');
                }
                const sessions = ctx.get?.('sessions') || ctx.sessions;
                const known = Boolean(sessions?.list?.getSnapshot?.()?.byId?.[sessionId]);
                if (!known && typeof sessions?.refresh === 'function') {
                  await sessions.refresh();
                }
                workspace.openSession(sessionId);
                return true;
              },
              readLocalSessionId: () => readNativeSelectedSessionId(ctx),
              // layout 仅公开 toggle 动作；以宿主稳定 data 属性避免将已折叠的栏误打开。
              collapseSidebar: () => {
                if (!document.querySelector('[data-sidebar-collapsed]')) ctx.layout.toggleSidebar();
              },
              expandSidebar: () => {
                if (document.querySelector('[data-sidebar-collapsed]')) ctx.layout.toggleSidebar();
              },
            }),
          },
          AuFleetShell
        )
      );
      // 注册 main key 供侧边栏「DSH AU」入口触发；Shell 收到后会立即切回对话并打开设置弹窗定位到 DSH AU。
      ctx.slots.inject('main', () =>
        ctx.slots.register(
          { name: 'main', key: PANEL_ID },
          () => h('div', { className: 'dsh-au-placeholder' })
        )
      );
      ctx.effect(() => {
        let disposePanelEntry = null;
        const clearPanelEntry = () => {
          if (typeof disposePanelEntry === 'function') {
            disposePanelEntry();
            disposePanelEntry = null;
          }
        };
        const syncSidebarEntry = () => {
          const enabled = featuresStore.snapshot.sidebarWorkbench === true;
          if (enabled && !disposePanelEntry) {
            disposePanelEntry = ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.panellist',
                  id: PANEL_ID,
                  order: 20,
                  label: () => 'DSH AU',
                },
                SidebarWorkbenchIcon
              )
            );
          } else if (!enabled && disposePanelEntry) {
            clearPanelEntry();
            // 关闭开关时若当前停留在工作台主面板，切回本机对话。
            try { ctx.layout?.selectPanel?.(null); } catch {}
          }
        };
        syncSidebarEntry();
        featuresStore.listeners.add(syncSidebarEntry);
        return () => {
          featuresStore.listeners.delete(syncSidebarEntry);
          clearPanelEntry();
        };
      }, 'dsh-au: sidebar workbench entry');
    }
    apply.remoteWorkspaces = remoteWorkspacesClient.helpers;
    apply.todo = todoClient.helpers;
    // 新功能沿用现有 apply.helpers 风格，保持插件顶层导出契约不变。
    apply.modelShortcuts = modelShortcutHelpers;
    apply.modelShortcutSettings = modelShortcutSettingsHelpers;
    apply.clipboard = { fallbackCopyText, installClipboardPolyfill };


