import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { outFile } from '../scripts/build-client.js';

function loadClientModule(win = {}) {
  const code = readFileSync(outFile, 'utf8');
  let definition = null;
  win.__ModuleLoader__ = { load: (def) => { definition = def; } };
  new Function('window', code)(win);
  const fakeReact = {
    createElement: () => ({}),
    Fragment: Symbol('Fragment'),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
  };
  return definition.factory((id) => {
    if (id === 'react') return fakeReact;
    if (id === 'react-dom') return { createPortal: () => ({}) };
    throw new Error(`未预期的 require：${id}`);
  });
}

function createMockBrowserEnvironment({ isSecureContext = false, hasNativeClipboard = false, nativeFail = false } = {}) {
  let clipboardDataText = '';
  let execCommandCalled = false;
  const elements = [];
  const listeners = new Map();

  const doc = {
    body: {
      appendChild(node) {
        elements.push(node);
        return node;
      },
    },
    createElement(tag) {
      const attrs = new Map();
      return {
        tagName: tag.toUpperCase(),
        value: '',
        style: {},
        setAttribute(k, v) { attrs.set(k, v); },
        getAttribute(k) { return attrs.get(k); },
        focus() {},
        select() {},
        setSelectionRange() {},
        remove() {
          const idx = elements.indexOf(this);
          if (idx !== -1) elements.splice(idx, 1);
        },
      };
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    execCommand(command) {
      if (command === 'copy') {
        execCommandCalled = true;
        // 模拟浏览器在 execCommand('copy') 时派发 copy 事件
        const copyFns = listeners.get('copy') || [];
        for (const fn of copyFns) {
          const evt = {
            clipboardData: {
              setData(mime, data) {
                if (mime === 'text/plain') clipboardDataText = data;
              },
            },
            preventDefault() {},
          };
          fn(evt);
        }
        return true;
      }
      return false;
    },
    activeElement: null,
    getSelection() {
      return {
        rangeCount: 0,
        getRangeAt() { return null; },
        removeAllRanges() {},
        addRange() {},
      };
    },
  };

  const nav = {};
  if (hasNativeClipboard) {
    nav.clipboard = {
      async writeText(text) {
        if (nativeFail) {
          throw new Error('NotAllowedError: writeText denied');
        }
        clipboardDataText = text;
      },
      async readText() {
        return clipboardDataText;
      },
    };
  }

  const win = {
    name: '',
    isSecureContext,
    navigator: nav,
    document: doc,
  };

  return {
    win,
    doc,
    nav,
    elements,
    getClipboardText: () => clipboardDataText,
    wasExecCommandCalled: () => execCommandCalled,
  };
}

async function withBrowserGlobals(env, fn) {
  const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const origWin = globalThis.window;
  const origDoc = globalThis.document;

  globalThis.window = env.win;
  globalThis.document = env.doc;
  Object.defineProperty(globalThis, 'navigator', {
    value: env.nav,
    configurable: true,
    writable: true,
    enumerable: true,
  });

  try {
    return await fn();
  } finally {
    if (origNavDesc) {
      Object.defineProperty(globalThis, 'navigator', origNavDesc);
    } else {
      delete globalThis.navigator;
    }
    if (origWin !== undefined) globalThis.window = origWin;
    else delete globalThis.window;
    if (origDoc !== undefined) globalThis.document = origDoc;
    else delete globalThis.document;
  }
}

test('fallbackCopyText 能够正常处理文本并在模拟 DOM 中完成复制', async () => {
  const env = createMockBrowserEnvironment();
  await withBrowserGlobals(env, () => {
    const mod = loadClientModule(env.win);
    const { fallbackCopyText } = mod.apply.clipboard;
    assert.equal(typeof fallbackCopyText, 'function');

    // 空值安全校验
    assert.equal(fallbackCopyText(''), false);
    assert.equal(fallbackCopyText(null), false);

    // 正常文本复制
    const ok = fallbackCopyText('DSH-AU 远程复制代码块测试');
    assert.equal(ok, true);
    assert.equal(env.wasExecCommandCalled(), true);
    assert.equal(env.getClipboardText(), 'DSH-AU 远程复制代码块测试');
    // 临时 textarea 必须在执行完毕后被彻底移除
    assert.equal(env.elements.length, 0);
  });
});

test('installClipboardPolyfill 在缺少原生 clipboard 时（如 HTTP 远程地址）提供 writeText shim', async () => {
  const env = createMockBrowserEnvironment({ isSecureContext: false, hasNativeClipboard: false });
  await withBrowserGlobals(env, async () => {
    assert.equal(env.nav.clipboard, undefined);
    const mod = loadClientModule(env.win);
    const { installClipboardPolyfill } = mod.apply.clipboard;

    // 模块加载即时安装，或显式调用 installClipboardPolyfill 均可确保 clipboard 就绪
    installClipboardPolyfill();
    assert.ok(env.nav.clipboard, '应该成功在 navigator 上注入 clipboard');
    assert.equal(typeof env.nav.clipboard.writeText, 'function');

    // 模拟 DSH 远程界面中点击复制代码块：await navigator.clipboard.writeText(...)
    await env.nav.clipboard.writeText('目标：先为现有 Cursor 和 Gemini 的 ACP 接入补充耗时日志');
    assert.equal(env.getClipboardText(), '目标：先为现有 Cursor 和 Gemini 的 ACP 接入补充耗时日志');
    assert.equal(env.wasExecCommandCalled(), true);
  });
});

test('installClipboardPolyfill 在原生 writeText 报错时无缝降级兜底', async () => {
  const env = createMockBrowserEnvironment({ isSecureContext: true, hasNativeClipboard: true, nativeFail: true });
  await withBrowserGlobals(env, async () => {
    const mod = loadClientModule(env.win);
    const { installClipboardPolyfill } = mod.apply.clipboard;

    installClipboardPolyfill();
    // 原生会抛错，但经过 Polyfill 拦截后，应该捕获并自动降级为 fallback，且 Promise 正确 resolve
    await env.nav.clipboard.writeText('自动降级成功文本');
    assert.equal(env.getClipboardText(), '自动降级成功文本');
    assert.equal(env.wasExecCommandCalled(), true);
  });
});

test('apply(ctx) 挂载 clipboard polyfill effect', async () => {
  const env = createMockBrowserEnvironment();
  await withBrowserGlobals(env, () => {
    const mod = loadClientModule(env.win);
    const effects = [];
    const fakeCtx = {
      effect: (fn, label) => { effects.push({ fn, label }); },
      slots: { inject: () => {}, register: () => {} },
      shortcuts: { register: () => {} },
      layout: {},
    };

    mod.apply(fakeCtx);
    const clipboardEffect = effects.find((e) => e.label === 'dsh-au: clipboard polyfill');
    assert.ok(clipboardEffect, '必须注册 dsh-au: clipboard polyfill effect');
    clipboardEffect.fn();
    assert.ok(env.nav.clipboard, '执行 effect 后 clipboard 必须就绪');
  });
});
