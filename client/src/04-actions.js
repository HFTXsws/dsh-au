    const PLUGIN_NOTICE_KEY = 'dsh-au-plugin-notice';
    const PLUGIN_NOTICE_OWNER_KEY = 'dsh-au-plugin-notice-owner';
    const PLUGIN_SYNCING_KEY = 'dsh-au-plugin-syncing';

    /** 同步结果写到 sessionStorage，工作台被重载后仍能看见成功或失败。 */
    function readPluginNotice() {
      try { return sessionStorage.getItem(PLUGIN_NOTICE_KEY) || ''; } catch { return ''; }
    }

    function persistPluginNotice(text) {
      try {
        if (text) sessionStorage.setItem(PLUGIN_NOTICE_KEY, text);
        else sessionStorage.removeItem(PLUGIN_NOTICE_KEY);
      } catch {}
    }

    /** 提示必须绑定操作目标，切换到其它插件详情时不能复用旧结果。 */
    function readPluginNoticeOwner() {
      try { return sessionStorage.getItem(PLUGIN_NOTICE_OWNER_KEY) || ''; } catch { return ''; }
    }

    function persistPluginNoticeOwner(pluginId) {
      try {
        if (pluginId) sessionStorage.setItem(PLUGIN_NOTICE_OWNER_KEY, pluginId);
        else sessionStorage.removeItem(PLUGIN_NOTICE_OWNER_KEY);
      } catch {}
    }

    function persistPluginSyncing(active) {
      try {
        if (active) sessionStorage.setItem(PLUGIN_SYNCING_KEY, '1');
        else sessionStorage.removeItem(PLUGIN_SYNCING_KEY);
      } catch {}
    }

    function readPluginSyncing() {
      try { return sessionStorage.getItem(PLUGIN_SYNCING_KEY) === '1'; } catch { return false; }
    }

    function matchPluginHost(hostKey, target) {
      const left = String(hostKey || '').toLocaleLowerCase();
      const right = String(target || '').toLocaleLowerCase();
      return left === right || left === right.replace(/\.local$/, '') || right === left.replace(/\.local$/, '');
    }

    /**
     * 同步文本复制兜底逻辑：用于非安全上下文（远程 HTTP）、iframe 或原生 Clipboard API 受限环境。
     * 结合了 copy 事件拦截注入与隐藏输入域选区机制，并在完成后还原用户的选区与焦点。
     */
    function fallbackCopyText(text) {
      if (!text && text !== 0) return false;
      if (typeof document === 'undefined') return false;
      const textStr = String(text ?? '');
      let copied = false;

      // 1. 监听一次性捕获阶段的 copy 事件，通过 clipboardData 注入剪贴板数据
      const onCopyCapture = (event) => {
        try {
          if (event.clipboardData) {
            event.clipboardData.setData('text/plain', textStr);
            event.preventDefault();
            copied = true;
          }
        } catch {}
      };

      try {
        document.addEventListener('copy', onCopyCapture, { capture: true });
      } catch {}

      // 2. 创建不可见但处于视口内的输入域以确保激活浏览器选区
      const textarea = document.createElement('textarea');
      textarea.value = textStr;
      textarea.setAttribute('readonly', '');
      textarea.setAttribute('aria-hidden', 'true');
      textarea.setAttribute('tabindex', '-1');
      textarea.style.position = 'fixed';
      textarea.style.top = '0';
      textarea.style.left = '0';
      textarea.style.width = '1px';
      textarea.style.height = '1px';
      textarea.style.padding = '0';
      textarea.style.border = 'none';
      textarea.style.outline = 'none';
      textarea.style.boxShadow = 'none';
      textarea.style.background = 'transparent';
      textarea.style.opacity = '0';
      textarea.style.pointerEvents = 'none';
      textarea.style.zIndex = '-9999';

      const activeElement = document.activeElement;
      const selection = typeof document.getSelection === 'function' ? document.getSelection() : null;
      const originalRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

      try {
        document.body.appendChild(textarea);
        textarea.focus({ preventScroll: true });
        textarea.select();
        textarea.setSelectionRange(0, textStr.length);

        const execResult = document.execCommand('copy');
        if (execResult) copied = true;
      } catch {
        // 部分浏览器不支持 execCommand，依赖 onCopyCapture 兜底判定
      } finally {
        try {
          document.removeEventListener('copy', onCopyCapture, { capture: true });
        } catch {}
        textarea.remove();
        // 恢复用户原有选区和输入焦点
        if (originalRange && selection) {
          try {
            selection.removeAllRanges();
            selection.addRange(originalRange);
          } catch {}
        }
        if (activeElement && typeof activeElement.focus === 'function') {
          try { activeElement.focus({ preventScroll: true }); } catch {}
        }
      }

      return copied;
    }

    /**
     * 全局剪贴板兼容补丁：修补 DSH 原生代码块及操作栏在远程 HTTP（非安全上下文）下复制失效的问题。
     * 原生 DSH 代码块复制依赖 navigator.clipboard.writeText，在 HTTP 远程地址下会直接报错并截断。
     * 本补丁拦截 navigator.clipboard.writeText，若原生调用被浏览器拒绝，自动无缝执行同步复制兜底。
     */
    function installClipboardPolyfill() {
      const win = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null);
      if (!win) return;
      const nav = win.navigator || (typeof navigator !== 'undefined' ? navigator : null);
      if (!nav) return;
      if (win.__dshAuClipboardPolyfilled) return;
      win.__dshAuClipboardPolyfilled = true;

      const createPatchedWriteText = (originalWriteText, target) => {
        return async function writeText(text) {
          // 在安全上下文（HTTPS 或 localhost）下优先尝试原生接口
          if (typeof originalWriteText === 'function' && win.isSecureContext !== false) {
            try {
              await originalWriteText.call(target, text);
              return;
            } catch (err) {
              // 原生调用失败（如权限被拒或焦点丢失），向下进入降级逻辑
            }
          }
          // 在非安全上下文（远程 HTTP）或原生失败时，执行健壮的同步兜底
          const success = fallbackCopyText(text);
          if (!success) {
            const err = typeof DOMException === 'function'
              ? new DOMException('Clipboard write failed under current context', 'NotAllowedError')
              : new Error('NotAllowedError: Clipboard write failed under current context');
            throw err;
          }
        };
      };

      try {
        if (!nav.clipboard) {
          const clipboardShim = {
            writeText: createPatchedWriteText(null, null),
            readText: async () => '',
          };
          try {
            Object.defineProperty(nav, 'clipboard', {
              value: clipboardShim,
              configurable: true,
              writable: true,
              enumerable: true,
            });
          } catch {
            const proto = Object.getPrototypeOf(nav) || win.Navigator?.prototype;
            if (proto) {
              Object.defineProperty(proto, 'clipboard', {
                value: clipboardShim,
                configurable: true,
                writable: true,
                enumerable: true,
              });
            }
          }
        } else {
          const original = nav.clipboard.writeText?.bind(nav.clipboard);
          const patched = createPatchedWriteText(original, nav.clipboard);
          try {
            nav.clipboard.writeText = patched;
          } catch {
            Object.defineProperty(nav.clipboard, 'writeText', {
              value: patched,
              configurable: true,
              writable: true,
            });
          }
        }
      } catch {}
    }

    /** 在安全上下文优先使用 Clipboard API，并为 HTTP 局域网入口保留浏览器兼容回退。 */
    async function copyConnectionUrl(url) {
      if (!url || typeof document === 'undefined') return false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(url);
          return true;
        }
      } catch {}
      return fallbackCopyText(url);
    }

    /** 同源表单触发服务器 303 直达远端；指定 target 时只导航受控 iframe，不离开控制端页面。 */
    function navigateToAuthenticatedRemote(routeId, targetName = '') {
      if (!routeId || typeof document === 'undefined') return;
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = '/dsh-au/connect';
      form.target = targetName;
      form.style.display = 'none';
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'routeId';
      input.value = routeId;
      form.appendChild(input);
      document.body.appendChild(form);
      form.submit();
      // 提交已进入浏览器导航队列，下一帧移除临时表单避免污染控制端 DOM。
      const schedule = window.requestAnimationFrame || ((callback) => callback());
      schedule(() => form.remove());
    }

    function reportClientEvent(event, deviceId, details = {}) {
      // keepalive 让 pagehide / 插件销毁记录不随导航一起取消；不记录 URL、输入或正文。
      void fetch('/dsh-au/api', {
        method: 'POST', keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...details, documentId: DOCUMENT_INSTANCE_ID, clientId: CLIENT_INSTANCE_ID, event, deviceId, action: 'reportClientEvent' }),
      }).catch(() => {});
    }

    function installPageLifecycleTrace() {
      const metadata = () => ({
        navigationType: window.performance?.getEntriesByType?.('navigation')?.[0]?.type || 'unknown',
        pageAgeMs: Math.max(0, Math.round(window.performance?.now?.() || 0)),
      });
      reportClientEvent('shell-started', 'local', metadata());
      const onShow = (event) => reportClientEvent('page-shown', 'local', { ...metadata(), result: event.persisted ? 'bfcache' : 'normal' });
      const onHide = (event) => reportClientEvent('page-hidden', 'local', { ...metadata(), result: event.persisted ? 'bfcache' : 'normal' });
      window.addEventListener('pageshow', onShow);
      window.addEventListener('pagehide', onHide);
      return () => {
        reportClientEvent('shell-disposed', 'local', { ...metadata(), reason: 'plugin-dispose' });
        window.removeEventListener('pageshow', onShow);
        window.removeEventListener('pagehide', onHide);
      };
    }

    /** 优选通路切换写入服务端网络日志；只上报路由 ID 与状态，不含地址和凭据。 */
    function reportRouteChange(payload) {
      void callApi('reportRouteChange', { ...payload, documentId: DOCUMENT_INSTANCE_ID, clientId: CLIENT_INSTANCE_ID }).catch(() => {});
    }

    // 模块执行时立即尝试挂载剪贴板补丁，保证首屏交互前剪贴板可用
    installClipboardPolyfill();


