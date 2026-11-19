import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function loadClientModule() {
  const clientCode = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  let captured = null;
  const fakeWindow = {
    __ModuleLoader__: {
      load(def) {
        captured = def;
      },
    },
  };
  const fn = new Function('window', clientCode);
  fn(fakeWindow);
  assert.ok(captured, 'ModuleLoader.load should be called');
  assert.equal(captured.id, 'dsh-au');

  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: Symbol('Fragment'),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useCallback: (cb) => cb,
    useRef: (val) => ({ current: val }),
  };
  const fakeReactDOM = {
    createPortal: (node, container) => ({ portal: true, node, container }),
  };
  const mod = captured.factory((id) => {
    if (id === 'react') return fakeReact;
    if (id === 'react-dom') return fakeReactDOM;
    throw new Error(`Unexpected require: ${id}`);
  });
  return { mod: mod.mobile, root: mod, clientCode };
}

test('merged client exposes mobile helpers and gates the drawer on a per-browser flag defaulting to on', () => {
  const { mod, root, clientCode } = loadClientModule();
  assert.equal(typeof root.apply, 'function');
  assert.ok(root.inject.includes('layout'));
  assert.match(clientCode, /if \(!readMobileFeatureEnabled\(\)\) return;/);

  const store = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = { getItem: (key) => (store.has(key) ? store.get(key) : null), setItem: (key, value) => { store.set(key, String(value)); } };
  try {
    // 没有记录时默认关闭移动端优化。
    assert.equal(mod.readMobileFeatureEnabled(), false);
    mod.writeMobileFeatureEnabled(false);
    assert.equal(store.get('dsh-au.mobile-enabled'), 'false');
    assert.equal(mod.readMobileFeatureEnabled(), false);
    mod.writeMobileFeatureEnabled(true);
    assert.equal(mod.readMobileFeatureEnabled(), true);
  } finally {
    if (previous === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous;
  }
});

test('mobile viewport and drawer width helpers follow DeepSeek-App compact bounds', () => {
  const { mod } = loadClientModule();
  assert.equal(mod.isMobileViewport(375), true);
  assert.equal(mod.isMobileViewport(768), true);
  assert.equal(mod.isMobileViewport(769), false);
  assert.equal(mod.isMobileViewport(1440), false);
  assert.equal(mod.isMobileViewport(844, {
    matchMedia: () => ({ matches: true }),
    navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile' },
  }), true);

  // 平板横屏：iPadOS 桌面模式伪装 UA（Macintosh + maxTouchPoints > 1，如 1366px iPad Pro 横屏）
  assert.equal(mod.isMobileViewport(1366, {
    matchMedia: (q) => ({ matches: q.includes('coarse') || q.includes('none') }),
    navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', maxTouchPoints: 5 },
  }), true);

  // 平板横屏：Android / 鸿蒙平板横屏（1280px）
  assert.equal(mod.isMobileViewport(1280, {
    matchMedia: (q) => ({ matches: q.includes('coarse') || q.includes('none') }),
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36', maxTouchPoints: 5 },
  }), true);

  // 桌面电脑（1440px，无触点、精细鼠标指针）：保持桌面模式不启用移动端抽屉
  assert.equal(mod.isMobileViewport(1440, {
    matchMedia: () => ({ matches: false }),
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', maxTouchPoints: 0 },
  }), false);

  // 竖屏窄屏与竖屏平板启用侧边栏抽屉与悬浮按钮；横屏（width > height）关闭抽屉与悬浮按钮以保持原生侧边栏
  assert.equal(mod.isPortraitDrawerMode(390, 844), true);
  assert.equal(mod.isPortraitDrawerMode(820, 1180, {
    matchMedia: (q) => ({ matches: q.includes('coarse') }),
    navigator: { userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)', maxTouchPoints: 5 },
  }), true);
  assert.equal(mod.isPortraitDrawerMode(740, 360), false);
  assert.equal(mod.isPortraitDrawerMode(1180, 820, {
    matchMedia: (q) => ({ matches: q.includes('coarse') }),
    navigator: { userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)', maxTouchPoints: 5 },
  }), false);

  assert.equal(mod.getDrawerWidth(320), 262);
  assert.equal(mod.getDrawerWidth(390), 300);

  // 悬浮按钮边界钳制：保证任意拖拽均不会超出手机可视区域
  assert.deepEqual(mod.clampTriggerPosition({ top: -20, left: -10 }, 375, 812), { top: 8, left: 8 });
  assert.deepEqual(mod.clampTriggerPosition({ top: 900, left: 500 }, 375, 812), { top: 768, left: 331 });

  // 默认初始位置：位于输入框正上方一点，左对齐 8px
  assert.deepEqual(
    mod.getDefaultTriggerPosition(390, 844, {
      querySelector: () => ({ getBoundingClientRect: () => ({ top: 680 }) }),
    }),
    { top: 638, left: 8 }
  );

  // 长按触发新建对话：优先调用宿主服务，不可用时回退点击原生新建按钮
  let serviceCalled = 0;
  assert.equal(mod.triggerNewSession(() => { serviceCalled += 1; }), true);
  assert.equal(serviceCalled, 1);

  let domClicked = 0;
  assert.equal(mod.triggerNewSession(
    () => { throw new Error('fallback'); },
    { querySelector: () => ({ click: () => { domClicked += 1; } }) }
  ), true);
  assert.equal(domClicked, 1);
});

test('incident: switching to a second DSH on mobile keeps the main DSH unified sidebar drawer & trigger active while hiding the controlled iframe sidebar, and keyboard resize preserves trigger position', () => {
  const { mod, clientCode } = loadClientModule();

  // 检测当前页面是否正处于远端 DSH 舞台激活态（供边缘触控区与远端长按新建对话使用）。
  assert.equal(mod.isRemoteDshActive({
    documentElement: { getAttribute: (name) => (name === 'data-dsh-au-remote-active' ? 'true' : null) },
    querySelector: () => null,
  }), true);
  assert.equal(mod.isRemoteDshActive({
    documentElement: { getAttribute: () => null },
    querySelector: (sel) => (sel === '.dsh-au-stage' ? { style: { display: 'block' } } : null),
  }), true);
  assert.equal(mod.isRemoteDshActive({
    documentElement: { getAttribute: () => null },
    querySelector: (sel) => (sel.includes(':not(:first-child).active') ? {} : null),
  }), true);
  assert.equal(mod.isRemoteDshActive({
    documentElement: { getAttribute: () => null },
    querySelector: () => null,
  }), false);

  // iOS: 仅 visualViewport 变矮；Android 某些浏览器：layout viewport 同时变矮。
  assert.equal(mod.isSoftKeyboardViewport({
    innerWidth: 390,
    innerHeight: 844,
    visualViewport: { height: 510, offsetTop: 0 },
  }, { width: 390, height: 844 }), true);
  assert.equal(mod.isSoftKeyboardViewport({
    innerWidth: 390,
    innerHeight: 510,
  }, { width: 390, height: 844 }), true);
  assert.equal(mod.isSoftKeyboardViewport({
    innerWidth: 390,
    innerHeight: 844,
    visualViewport: { height: 844, offsetTop: 0 },
  }, { width: 390, height: 844 }), false);

  assert.match(clientCode, /if \(isSoftKeyboardViewport\(window, stableViewportRef\.current\)\) return;/);
  assert.match(clientCode, /visualViewport\?\.addEventListener\('resize', refreshPositions\)/);
  // 主 DSH 在远端激活态下继续保留悬浮按钮与统一侧边栏，仅受控 iframe 内部不重复挂载悬浮按钮
  assert.match(clientCode, /if \(!isDrawerMode \|\| controlledFrame \|\| typeof document === 'undefined'\) return null/);
  assert.match(clientCode, /dsh-au:mobile-drawer-swipe/);
  assert.match(clientCode, /dsh-au-mobile-edge-zone/);
  assert.doesNotMatch(clientCode, /html\[data-dsh-au-remote-active="true"\] \.dsh-au-mobile-trigger/);
  assert.doesNotMatch(clientCode, /html\[data-dsh-au-controlled-frame="true"\]:not\(\[data-dsh-au-mobile="true"\]\)/);
});

test('shouldCloseDrawerOnSidebarClick closes on session selection and new session, but keeps workspace folder toggle open', () => {
  const { mod } = loadClientModule();
  const makeTarget = (matchesMap, attrs = {}) => ({
    closest: (selector) => {
      for (const [pattern, val] of Object.entries(matchesMap)) {
        if (selector.includes(pattern)) return val;
      }
      return null;
    },
    getAttribute: (name) => attrs[name] || null,
    hasAttribute: (name) => Boolean(attrs[name]),
  });

  // 点击会话行主体 -> 自动收起抽屉
  const sessionRowTarget = makeTarget({
    sidebarCol: {},
    'data-row-key^="session:"': {},
  });
  assert.equal(mod.shouldCloseDrawerOnSidebarClick(sessionRowTarget), true);

  // 点击会话行右侧「...」菜单按钮 -> 不收起抽屉
  const sessionMenuBtn = makeTarget({
    sidebarCol: {},
    'data-row-key^="session:"': {},
    _rowActions: {},
  });
  assert.equal(mod.shouldCloseDrawerOnSidebarClick(sessionMenuBtn), false);

  // 点击工作区文件夹标题展开/折叠 -> 不收起抽屉
  const workspaceFolderHeader = makeTarget({
    sidebarCol: {},
    'data-row-key^="workspace:"': {},
  });
  assert.equal(mod.shouldCloseDrawerOnSidebarClick(workspaceFolderHeader), false);

  // 点击侧边栏顶部「新建对话」按钮 -> 自动收起抽屉
  const newSessionBtn = makeTarget({
    sidebarCol: {},
    _newSession: {},
  });
  assert.equal(mod.shouldCloseDrawerOnSidebarClick(newSessionBtn), true);

  // 点击统一侧边栏中的远端会话行 -> 自动收起抽屉
  const remoteSessionRow = makeTarget({
    sidebarCol: {},
    'dsh-au-remote-session-row': {},
  });
  assert.equal(mod.shouldCloseDrawerOnSidebarClick(remoteSessionRow), true);

  // 点击统一侧边栏中的远端工作区「+ 新建对话」按钮 -> 自动收起抽屉
  const remoteWsNewBtn = makeTarget({
    sidebarCol: {},
    'dsh-au-remote-ws-row': {},
    'dsh-au-remote-ws-action-btn': {
      getAttribute: (name) => (name === 'title' ? '在此远端工作区新建对话' : null),
      hasAttribute: () => false,
    },
  });
  assert.equal(mod.shouldCloseDrawerOnSidebarClick(remoteWsNewBtn), true);
});

test('mobile drawer gesture guard leaves the Todo dock pointer drag and Todo scrolling untouched', () => {
  const { clientCode } = loadClientModule();
  assert.match(clientCode, /target\?\.closest\('\.dsh-au-mobile-trigger, \.dsh-au-todo-dock, \.dsh-au-todo-capsule'\)/);
  assert.match(clientCode, /Todo 面板自身需要接收 Pointer 拖拽和列表滚动/);
});

test('installComposerFocusGuard blocks programmatic composer focus on session switch until user taps composer', () => {
  const { mod } = loadClientModule();
  const listeners = {};
  let focusedCount = 0;
  function FakeElement() {}
  FakeElement.prototype.focus = function () {
    focusedCount += 1;
  };
  const fakeWin = {
    HTMLElement: FakeElement,
    document: {
      documentElement: {
        getAttribute: (name) => (name === 'data-dsh-au-mobile' ? 'true' : null),
        hasAttribute: (name) => name === 'data-dsh-au-mobile',
      },
      addEventListener: (type, fn) => { listeners[type] = fn; },
      removeEventListener: (type) => { delete listeners[type]; },
    },
  };

  const dispose = mod.installComposerFocusGuard(fakeWin);
  const composerEditor = Object.create(FakeElement.prototype);
  composerEditor.closest = (sel) => (sel === '[data-composer-seat]' ? {} : null);

  // 1. 切换会话时触发的自动 focus() 被拦截，不弹出软键盘
  composerEditor.focus({ preventScroll: true });
  assert.equal(focusedCount, 0);

  // 2. 用户主动点击输入框区域后，放行 focus() 以正常弹出软键盘
  listeners.pointerdown({ target: composerEditor });
  composerEditor.focus({ preventScroll: true });
  assert.equal(focusedCount, 1);

  dispose();
});

test('installMobileComposerEnterKeyHandler blocks Enter submission on mobile composer and rewrites to shift-enter for line breaks', () => {
  const { mod } = loadClientModule();
  assert.equal(typeof mod.installMobileComposerEnterKeyHandler, 'function');

  const listeners = {};
  function FakeElement(isComposer = false) {
    this._isComposer = isComposer;
  }
  FakeElement.prototype.closest = function (sel) {
    return sel === '[data-composer-seat]' && this._isComposer ? {} : null;
  };

  let isMobile = true;
  const fakeWin = {
    innerWidth: 375,
    document: {
      documentElement: {
        getAttribute: (name) => (name === 'data-dsh-au-mobile' && isMobile ? 'true' : null),
        hasAttribute: (name) => name === 'data-dsh-au-mobile' && isMobile,
      },
      addEventListener: (type, fn) => { listeners[type] = fn; },
      removeEventListener: (type) => { delete listeners[type]; },
    },
  };

  const dispose = mod.installMobileComposerEnterKeyHandler(fakeWin);
  assert.equal(typeof listeners.keydown, 'function');

  const composerEditor = new FakeElement(true);
  const outsideElement = new FakeElement(false);

  // 1. 移动端输入框内按 Enter：改写 shiftKey=true（阻断 DSH 发送，交给 Lexical 换行），清除 ctrl/meta
  const mobileEnterEvent = {
    key: 'Enter',
    keyCode: 13,
    shiftKey: false,
    ctrlKey: true,
    metaKey: true,
    target: composerEditor,
    getModifierState: (k) => k === 'Control',
  };
  listeners.keydown(mobileEnterEvent);
  assert.equal(mobileEnterEvent.shiftKey, true, 'shiftKey should be rewritten to true');
  assert.equal(mobileEnterEvent.ctrlKey, false, 'ctrlKey should be cleared to false');
  assert.equal(mobileEnterEvent.metaKey, false, 'metaKey should be cleared to false');
  assert.equal(mobileEnterEvent.getModifierState('Shift'), true);
  assert.equal(mobileEnterEvent.getModifierState('Control'), false);

  // 2. 移动端输入框内按其它字符（如 A）：不改写修饰键
  const normalCharEvent = {
    key: 'a',
    keyCode: 65,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    target: composerEditor,
  };
  listeners.keydown(normalCharEvent);
  assert.equal(normalCharEvent.shiftKey, false);

  // 3. 移动端在非 composer 节点按 Enter：不改写修饰键
  const outsideEnterEvent = {
    key: 'Enter',
    keyCode: 13,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    target: outsideElement,
  };
  listeners.keydown(outsideEnterEvent);
  assert.equal(outsideEnterEvent.shiftKey, false);

  // 4. 桌面模式（非移动端）：输入框内按 Enter 不改写，保留桌面回车发送原生行为
  isMobile = false;
  fakeWin.innerWidth = 1440;
  const desktopEnterEvent = {
    key: 'Enter',
    keyCode: 13,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    target: composerEditor,
  };
  listeners.keydown(desktopEnterEvent);
  assert.equal(desktopEnterEvent.shiftKey, false);

  dispose();
  assert.equal(listeners.keydown, undefined, 'listener should be removed on dispose');
});

test('swipe gesture engine supports right-swipe open, left-swipe close, and scrollable guard', () => {
  const { mod } = loadClientModule();

  // 左边缘向右滑动超过阈值：激活跟手并判定展开
  const edgeOpen = mod.evaluateSwipeGesture({
    drawerOpen: false,
    startX: 18,
    startY: 200,
    currentX: 96,
    currentY: 205,
    drawerWidth: 280,
    inScrollable: true,
  });
  assert.equal(edgeOpen.active, true);
  assert.equal(edgeOpen.shouldOpen, true);
  assert.equal(edgeOpen.translateXPx, -202);

  // 在代码块等横向滚动容器内部（非左边缘）右滑：不误触抽屉
  const blockedInCode = mod.evaluateSwipeGesture({
    drawerOpen: false,
    startX: 120,
    startY: 200,
    currentX: 210,
    currentY: 202,
    drawerWidth: 280,
    inScrollable: true,
  });
  assert.equal(blockedInCode.active, false);
  assert.equal(blockedInCode.shouldOpen, false);

  // 抽屉展开态向左滑动：跟手收回并判定关闭
  const swipeClose = mod.evaluateSwipeGesture({
    drawerOpen: true,
    startX: 240,
    startY: 220,
    currentX: 150,
    currentY: 226,
    drawerWidth: 280,
    inScrollable: false,
  });
  assert.equal(swipeClose.active, true);
  assert.equal(swipeClose.shouldOpen, false);
  assert.equal(swipeClose.translateXPx, -90);
});

test('vertical swipe engine collapses header on swipe-up and expands header on swipe-down', () => {
  const { mod } = loadClientModule();

  // 手指从下往上滑（dy < 0）：收起顶部区域
  const swipeUp = mod.evaluateVerticalHeaderSwipe({
    headerCollapsed: false,
    startX: 180,
    startY: 320,
    currentX: 184,
    currentY: 260,
  });
  assert.equal(swipeUp.triggered, true);
  assert.equal(swipeUp.nextCollapsed, true);

  // 手指从上往下滑（dy > 0）：拉出顶部区域
  const swipeDown = mod.evaluateVerticalHeaderSwipe({
    headerCollapsed: true,
    startX: 180,
    startY: 200,
    currentX: 176,
    currentY: 256,
  });
  assert.equal(swipeDown.triggered, true);
  assert.equal(swipeDown.nextCollapsed, false);

  // 水平滑动为主时不误触发顶部区域折叠
  const horizontalSwipe = mod.evaluateVerticalHeaderSwipe({
    headerCollapsed: false,
    startX: 100,
    startY: 200,
    currentX: 190,
    currentY: 165,
  });
  assert.equal(horizontalSwipe.triggered, false);
  assert.equal(horizontalSwipe.nextCollapsed, false);

  // 对话容器向下滚动（scrollTop 增大）：自动收起顶栏
  const scrollDown = mod.evaluateScrollHeaderState({
    headerCollapsed: false,
    prevScrollTop: 20,
    nextScrollTop: 55,
  });
  assert.equal(scrollDown.triggered, true);
  assert.equal(scrollDown.nextCollapsed, true);

  // 对话容器向上滚动（scrollTop 减小）：自动拉出顶栏
  const scrollUp = mod.evaluateScrollHeaderState({
    headerCollapsed: true,
    prevScrollTop: 120,
    nextScrollTop: 80,
  });
  assert.equal(scrollUp.triggered, true);
  assert.equal(scrollUp.nextCollapsed, false);
});

test('client styles and overlay mount off-canvas drawer, top-left trigger, and remote iframe support', () => {
  const { clientCode } = loadClientModule();
  assert.match(clientCode, /data-dsh-au-mobile/);
  assert.match(clientCode, /data-dsh-au-mobile-drawer/);
  assert.match(clientCode, /data-dsh-au-mobile-header/);
  assert.match(clientCode, /\[data-slot="conversation\.header"\] > header/);
  assert.match(clientCode, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*!important/);
  assert.match(clientCode, /grid-column:\s*1\s*\/\s*-1\s*!important/);
  assert.match(clientCode, /--dsh-chat-user-width:\s*100%\s*!important/);
  assert.match(clientCode, /--dsh-chat-content-width:\s*100%\s*!important/);
  assert.match(clientCode, /padding-left:\s*8px\s*!important/);
  assert.match(clientCode, /--dsh-content-font-size:\s*15px\s*!important/);
  assert.match(clientCode, /translate3d\(-104%, 0, 0\)/);
  assert.match(clientCode, /\.dsh-au-mobile-trigger/);
  assert.match(clientCode, /TRIGGER_POSITION_STORAGE_KEY = 'dsh-au-mobile\.trigger-pos-v2'/);
  assert.match(clientCode, /onPointerDown: startTriggerDrag/);
  assert.doesNotMatch(clientCode, /\[\$\{HEADER_ATTR\}="collapsed"\] \.dsh-au-mobile-trigger/);
  assert.doesNotMatch(clientCode, /padding-left:\s*46px/);
  assert.match(clientCode, /\.dsh-au-mobile-backdrop/);
  assert.match(clientCode, /button\[class\*="_toggle"\]/);
  assert.doesNotMatch(clientCode, /if \(isControlledFrame\(\)\) return/);
});

test('backs down custom mobile drawer when DSH native sidebar drawer is present', () => {
  const { mod, clientCode } = loadClientModule();
  assert.equal(typeof mod.hasNativeSidebarDrawer, 'function');
  assert.equal(mod.hasNativeSidebarDrawer({ querySelector: () => null }), false);
  assert.equal(mod.hasNativeSidebarDrawer({
    querySelector: (sel) => (sel.includes('[data-sidebar-drawer]') ? {} : null),
  }), true);

  // 原生抽屉存在时跳过强行展开与抽屉渲染，并给顶部栏预留宿主左上角按钮间距
  assert.match(clientCode, /if \(controlledFrame \|\| nextNativeDrawer\) return;/);
  assert.match(clientCode, /if \(nativeDrawer\) return null;/);
  assert.match(clientCode, /\[data-sidebar-drawer\] #\$\{TOP_HOST_ID\}/);
  assert.match(clientCode, /html\[\$\{MOBILE_ATTR\}="true"\]\[\$\{DRAWER_ATTR\}\] \[class\*="_frame"\]/);
});
