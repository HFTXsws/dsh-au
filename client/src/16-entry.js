    function apply(ctx) {
      // 无论作为主控制端还是受控端 iframe，均安装剪贴板兼容补丁以修补远程 HTTP 下复制代码块失效的问题。
      ctx.effect(() => {
        installClipboardPolyfill();
        return () => {};
      }, 'dsh-au: clipboard polyfill');

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
            // 因此若自定义键位为 Backslash 或 Tab 则 defaults 传空对象由 keydown 兜底；其余键位（如默认 Alt+9/Alt+0）正常向宿主注册 defaults，使桌面端在远端未升级插件时也能直接拦截 iframe 按键。
            const actionId = tab === 'fav' ? 'menu.open' : 'services.open';
            const binding = effectiveShortcutBinding(actionId);
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
              aliases: [id, tab === 'fav' ? 'open command menu' : 'open background services'],
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
      // 仍注册 main key 以兼容既有侧栏入口；Shell 会立即将其导航回本机对话。
      ctx.slots.inject('main', () =>
        ctx.slots.register(
          { name: 'main', key: PANEL_ID },
          () => h('div', { className: 'dsh-au-placeholder' })
        )
      );
      // 设备切换由顶部常驻栏承载，避免在侧边栏重复暴露“Au 多机”入口。
    }
    apply.remoteWorkspaces = remoteWorkspacesClient.helpers;
    apply.todo = todoClient.helpers;
    // 新功能沿用现有 apply.helpers 风格，保持插件顶层导出契约不变。
    apply.modelShortcuts = modelShortcutHelpers;
    apply.modelShortcutSettings = modelShortcutSettingsHelpers;
    apply.clipboard = { fallbackCopyText, installClipboardPolyfill };


