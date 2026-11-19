    // ===== 快捷键：动作表、绑定匹配、浏览器本地覆盖 =====
    // 覆盖项只存在当前浏览器（localStorage）；受控 iframe 读不到外层的存储，由外层经 postMessage 推送。
    const SHORTCUT_STORAGE_KEY = 'dsh-au.shortcuts';
    // 快捷键总开关：默认关闭，只存当前浏览器；关闭时所有 dsh-au 快捷键（含远程页面转发）都不响应。
    const SHORTCUTS_ENABLED_STORAGE_KEY = 'dsh-au.shortcuts-enabled';
    const SHORTCUT_CONFIG_MESSAGE = 'shortcut-config';
    const SHORTCUT_ACTION_MESSAGE = 'shortcut-action';
    const TODO_TOGGLE_EVENT = 'dsh-au:toggle-todo';
    const TODO_CYCLE_EVENT = 'dsh-au:cycle-todo';

    const keyBinding = (code, mods = {}) => ({
      code,
      ctrl: Boolean(mods.ctrl),
      alt: Boolean(mods.alt),
      shift: Boolean(mods.shift),
      meta: Boolean(mods.meta),
    });

    // Mac 默认键位沿用系统习惯；其他平台保留原有 Alt/Ctrl 组合。
    const platformShortcut = (mac, other) => IS_MACOS ? mac : other;

    /** 动作表是唯一来源：设置页、按键匹配、受控 iframe 转发都读它；forward 表示在受控 iframe 里也要转发到外层。 */
    const SHORTCUT_ACTIONS = [
      { id: 'device.previous', label: '切换到左侧设备', defaults: keyBinding('BracketLeft', { alt: true }), forward: true },
      { id: 'device.next', label: '切换到右侧设备', defaults: keyBinding('BracketRight', { alt: true }), forward: true },
      { id: 'device.previous.tab', label: '切换到左侧设备 (备用)', defaults: keyBinding('Tab', { ctrl: true, shift: true }), forward: true },
      { id: 'device.next.tab', label: '切换到右侧设备 (备用)', defaults: keyBinding('Tab', { ctrl: true }), forward: true },
      { id: 'menu.open', label: '打开统一菜单', defaults: platformShortcut(keyBinding('Digit9', { ctrl: true }), keyBinding('Digit9', { alt: true })) },
      { id: 'services.open', label: '打开后台服务', defaults: platformShortcut(keyBinding('Digit0', { ctrl: true }), keyBinding('Digit0', { alt: true })) },
      { id: 'todo.toggle', label: '展开 / 收起待办面板', defaults: keyBinding('Backslash', { shift: true }), forward: true },
      { id: 'todo.cycle', label: '轮流跳转待处理对话', defaults: platformShortcut(keyBinding('Delete', { meta: true }), keyBinding('Delete', { ctrl: true })), forward: true },
      { id: 'device.refresh', label: '刷新远程DSH', defaults: keyBinding('F5'), forward: true },
      { id: 'dsh.reload', label: '重新加载 DSH 页面', defaults: keyBinding('F5', { ctrl: true }), forward: true },
      { id: 'dsh.restart', label: '退出并重启 DSH', defaults: keyBinding('F4', { ctrl: true, alt: true }), forward: true },
    ];

    const MODIFIER_ONLY_CODES = new Set([
      'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
    ]);

    /** 设备切换动作对应的方向；其余动作返回 null。 */
    function shortcutDeviceDirection(actionId) {
      if (actionId === 'device.previous' || actionId === 'device.previous.tab') return -1;
      if (actionId === 'device.next' || actionId === 'device.next.tab') return 1;
      return null;
    }

    function normalizeShortcutBinding(raw) {
      if (!raw || typeof raw !== 'object' || typeof raw.code !== 'string' || !raw.code || raw.code.length > 32) return null;
      return keyBinding(raw.code, raw);
    }

    /** 读取到的覆盖表一律清洗：未知动作丢弃，null 表示用户明确清除，坏数据按未覆盖处理。 */
    function normalizeShortcutOverrides(raw) {
      const out = {};
      if (!raw || typeof raw !== 'object') return out;
      for (const action of SHORTCUT_ACTIONS) {
        if (!Object.prototype.hasOwnProperty.call(raw, action.id)) continue;
        if (raw[action.id] === null) {
          out[action.id] = null;
          continue;
        }
        const binding = normalizeShortcutBinding(raw[action.id]);
        if (binding) out[action.id] = binding;
      }
      return out;
    }

    function readShortcutOverrides() {
      try {
        return normalizeShortcutOverrides(JSON.parse(localStorage.getItem(SHORTCUT_STORAGE_KEY) || 'null'));
      } catch {
        return {};
      }
    }

    /** 只有明确记录为开启才启用快捷键；没有记录或读取失败都视为关闭。 */
    function readShortcutsEnabled() {
      try { return localStorage.getItem(SHORTCUTS_ENABLED_STORAGE_KEY) === 'true'; } catch { return false; }
    }

    function writeShortcutsEnabled(enabled) {
      try { localStorage.setItem(SHORTCUTS_ENABLED_STORAGE_KEY, enabled ? 'true' : 'false'); } catch {}
    }

    function writeShortcutOverrides(overrides) {
      try {
        if (Object.keys(overrides).length) localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(overrides));
        else localStorage.removeItem(SHORTCUT_STORAGE_KEY);
      } catch {}
    }

    function sameShortcutBinding(left, right) {
      return Boolean(left) && Boolean(right) && left.code === right.code
        && left.ctrl === right.ctrl && left.alt === right.alt && left.shift === right.shift && left.meta === right.meta;
    }

    /** 当前生效的绑定：覆盖优先（null 表示已清除），否则取默认。 */
    function effectiveShortcutBinding(actionId, overrides = shortcutStore.overrides) {
      if (Object.prototype.hasOwnProperty.call(overrides, actionId)) return overrides[actionId];
      return SHORTCUT_ACTIONS.find((item) => item.id === actionId)?.defaults ?? null;
    }

    /** 修饰键必须与绑定完全一致，Alt+[ 不会被 Alt+Shift+[ 误触发。 */
    function matchesShortcutBinding(event, binding) {
      return Boolean(binding) && event.code === binding.code
        && Boolean(event.ctrlKey) === binding.ctrl && Boolean(event.altKey) === binding.alt
        && Boolean(event.shiftKey) === binding.shift && Boolean(event.metaKey) === binding.meta;
    }

    /** 命中哪个动作；录入新快捷键期间一律不触发，避免边录边执行。 */
    function findShortcutAction(event, overrides = shortcutStore.overrides) {
      // 总开关关闭时一律不命中，本机与远程页面的快捷键都不生效。
      if (shortcutStore.recording || !shortcutStore.enabled) return null;
      for (const action of SHORTCUT_ACTIONS) {
        if (matchesShortcutBinding(event, effectiveShortcutBinding(action.id, overrides))) return action.id;
      }
      return null;
    }

    function shortcutBindingFromEvent(event) {
      if (!event || typeof event.code !== 'string' || !event.code || MODIFIER_ONLY_CODES.has(event.code)) return null;
      return keyBinding(event.code, { ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey });
    }

    /** 录入校验：不能吞掉普通打字，Esc 留给取消，且不能与其他动作的生效绑定冲突。 */
    function validateShortcutBinding(binding, actionId, overrides = shortcutStore.overrides) {
      if (!binding) return { ok: false, reason: '请按下一个组合键' };
      if (binding.code === 'Escape') return { ok: false, reason: 'Esc 用来取消录入，不能作为快捷键' };
      const isFunctionKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(binding.code);
      const hasCommandModifier = binding.ctrl || binding.alt || binding.meta;
      if (!hasCommandModifier && !isFunctionKey) {
        const shiftOnlyTyping = binding.shift && /^(Key[A-Z]|Digit\d|Space|Enter|Tab|Backspace)$/.test(binding.code);
        if (!binding.shift || shiftOnlyTyping) return { ok: false, reason: '需要带上 Ctrl、Alt 或 Cmd，或使用 F1 到 F24，否则会影响正常输入' };
      }
      const clash = SHORTCUT_ACTIONS.find((item) =>
        item.id !== actionId && sameShortcutBinding(effectiveShortcutBinding(item.id, overrides), binding));
      if (clash) return { ok: false, reason: `与「${clash.label}」冲突` };
      // 共享模型绑定只参与冲突检查，不改变其它动作的浏览器保存方式。
      if (modelShortcutBindingClash(binding, actionId)) return { ok: false, reason: '与「模型快捷切换」冲突' };
      return { ok: true, reason: '' };
    }

    function describeShortcutKeyCode(code) {
      const named = {
        BracketLeft: '[', BracketRight: ']', Backslash: '\\', Slash: '/', Comma: ',', Period: '.', Semicolon: ';',
        Quote: "'", Backquote: '`', Minus: '-', Equal: '=', Space: 'Space', ArrowUp: '↑', ArrowDown: '↓',
        ArrowLeft: '←', ArrowRight: '→',
      };
      if (named[code]) return named[code];
      const letter = /^Key([A-Z])$/.exec(code);
      if (letter) return letter[1];
      const digit = /^Digit(\d)$/.exec(code);
      if (digit) return digit[1];
      return code;
    }

    function describeShortcutBinding(binding, isMac = IS_MACOS) {
      if (!binding) return '未设置';
      const parts = [];
      if (binding.ctrl) parts.push(isMac ? '⌃' : 'Ctrl');
      if (binding.alt) parts.push(isMac ? '⌥' : 'Alt');
      if (binding.shift) parts.push(isMac ? '⇧' : 'Shift');
      if (binding.meta) parts.push(isMac ? '⌘' : 'Win');
      parts.push(describeShortcutKeyCode(binding.code));
      return parts.join(isMac ? '' : '+');
    }

    const shortcutStore = {
      overrides: {},
      enabled: false,
      listeners: new Set(),
      recording: false,
    };

    /** 切换总开关并通知订阅方（设置页、DSH 注册表同步、受控 iframe 推送）。 */
    function setShortcutsEnabled(next, { persist = true } = {}) {
      const enabled = next === true;
      if (persist) writeShortcutsEnabled(enabled);
      if (shortcutStore.enabled === enabled) return;
      shortcutStore.enabled = enabled;
      for (const listener of [...shortcutStore.listeners]) listener(shortcutStore.overrides);
    }

    function useShortcutsEnabled() {
      const [enabled, setEnabled] = useState(shortcutStore.enabled);
      useEffect(() => {
        const listener = () => setEnabled(shortcutStore.enabled);
        shortcutStore.listeners.add(listener);
        listener();
        return () => { shortcutStore.listeners.delete(listener); };
      }, []);
      return enabled;
    }

    function setShortcutOverrides(next, { persist = true } = {}) {
      shortcutStore.overrides = next;
      if (persist) writeShortcutOverrides(next);
      for (const listener of [...shortcutStore.listeners]) listener(next);
    }

    /** binding 为对象表示改键，null 表示清除，undefined 表示恢复默认。 */
    function setShortcutBinding(actionId, binding) {
      const next = { ...shortcutStore.overrides };
      if (binding === undefined) delete next[actionId];
      else next[actionId] = binding;
      setShortcutOverrides(next);
    }

    function resetAllShortcuts() {
      setShortcutOverrides({});
    }

    function useShortcutOverrides() {
      const [overrides, setOverrides] = useState(shortcutStore.overrides);
      useEffect(() => {
        shortcutStore.listeners.add(setOverrides);
        setOverrides(shortcutStore.overrides);
        return () => { shortcutStore.listeners.delete(setOverrides); };
      }, []);
      return overrides;
    }

    /** 外层页读本地存储并监听其他标签页的修改；受控 iframe 一律等外层推送，绝不读自己的存储。 */
    function initShortcutStore() {
      if (isControlledFrame()) {
        // 受控 iframe 先保持关闭，等外层推送总开关与覆盖表。
        setShortcutsEnabled(false, { persist: false });
        setShortcutOverrides({}, { persist: false });
        return () => {};
      }
      setShortcutsEnabled(readShortcutsEnabled(), { persist: false });
      setShortcutOverrides(readShortcutOverrides(), { persist: false });
      const onStorage = (event) => {
        if (event.key === SHORTCUT_STORAGE_KEY) setShortcutOverrides(readShortcutOverrides(), { persist: false });
        if (event.key === SHORTCUTS_ENABLED_STORAGE_KEY) setShortcutsEnabled(readShortcutsEnabled(), { persist: false });
      };
      window.addEventListener('storage', onStorage);
      return () => window.removeEventListener('storage', onStorage);
    }

    function postShortcutConfig(frameWindow) {
      try {
        const { enabled, binding, loaded } = modelShortcutsStore.snapshot;
        const fullAccessByDefault = typeof featuresStore !== 'undefined'
          ? Boolean(featuresStore?.snapshot?.fullAccessByDefault)
          : false;
        frameWindow?.postMessage({ source: 'dsh-au', type: SHORTCUT_CONFIG_MESSAGE, overrides: shortcutStore.overrides,
          shortcutsEnabled: shortcutStore.enabled,
          modelShortcuts: { enabled, binding, loaded },
          modelShortcutOpen: modelShortcutPopup.snapshot.open && modelShortcutTarget.frame?.contentWindow === frameWindow,
          modelShortcutGeneration,
          modelShortcutFrameToken: modelShortcutFrameToken(frameWindow),
          fullAccessByDefault,
        }, '*');
      } catch {}
    }

    const shortcutHelpers = {
      SHORTCUT_ACTIONS,
      shortcutStore,
      effectiveShortcutBinding,
      matchesShortcutBinding,
      findShortcutAction,
      shortcutBindingFromEvent,
      validateShortcutBinding,
      describeShortcutBinding,
      normalizeShortcutOverrides,
      setShortcutOverrides,
      setShortcutsEnabled,
      readShortcutsEnabled,
      shortcutDeviceDirection,
      installControlledFrameShortcutBridge,
      postShortcutConfig,
      ShortcutSettingsGroup,
    };
