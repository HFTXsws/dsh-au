import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { build } from '../scripts/build-client.js';

// 2026-10-28 浅色按钮回归：取自实际宿主默认 body / body[data-ds-dark-theme]，不是另造主题。
const HOST_TOKENS = {
  '--dsw-alias-bg-layer-1': ['#ffffff', '#232324'],
  '--dsw-alias-bg-layer-2': ['#ffffff', '#2c2c2e'],
  '--dsw-alias-label-primary': ['#0f1115', '#f9fafb'],
  '--dsw-alias-label-secondary': ['#61666b', '#cfd3d6'],
  '--dsw-alias-border-l2': ['#0000001a', '#ffffff1f'],
  '--dsw-alias-interactive-bg-hover': ['#2631480f', '#ffffff14'],
  '--dsw-alias-interactive-bg-active': ['#2631481a', '#ffffff24'],
  '--dsw-alias-interactive-bg-hover-solid': ['#f1f3f5', '#353638'],
  '--dsw-alias-state-business-primary': ['#4176e6', '#7aaaff'],
  '--dsw-alias-state-business-tertiary': ['#e4edfd', '#34415b'],
  '--dsw-alias-state-success-primary': ['#22c55e', '#22c55e'],
  '--dsw-alias-state-success-tertiary': ['#e6faed', '#233c2c'],
  '--dsw-alias-state-warn-primary': ['#f59e0b', '#f59e0b'],
  '--dsw-alias-state-error-primary': ['#ec1313', '#f25a5a'],
};

/** 只替换 DOM 宿主边界与测试出口；三套生产样式安装器原样执行。 */
function buttonStyles() {
  const styles = new Map();
  const attrs = new Map();
  const doc = {
    getElementById: id => styles.get(id), createElement: () => ({ textContent: '' }),
    head: { appendChild: node => styles.set(node.id, node) },
    documentElement: { setAttribute: (key, value) => attrs.set(key, value), hasAttribute: key => attrs.has(key) },
  };
  const win = { innerWidth: 390, innerHeight: 1000, __ModuleLoader__: { load: definition => { win.definition = definition; } } };
  const code = build()
    .replace('helpers: {\n', 'helpers: {\n          ensureMobileStyles,\n')
    .replace("return { inject: ['slots', 'uiWorkspace', 'sessions'], apply };", "return { inject: ['slots', 'uiWorkspace', 'sessions'], apply, ensureStyles };")
    .replace('shortcuts: shortcutHelpers };', 'shortcuts: shortcutHelpers, ensureStyles, todo: todoClient };');
  new Function('window', 'document', code)(win, doc);
  const mod = win.definition.factory(id => {
    if (id === 'react') return { createElement() {} };
    if (id === 'react-dom') return {};
    throw new Error(`Unexpected dependency ${id}`);
  });
  mod.ensureStyles();
  mod.todo.ensureStyles();
  mod.mobile.ensureMobileStyles();
  assert.equal(styles.size, 3, '必须安装 fleet、todo、mobile 三套真实 CSS');
  return [...styles.values()].map(node => node.textContent).join('\n');
}

/** CDP pipe 是浏览器系统边界；真实强制 hover/focus，不用派发不受信任事件伪造伪类。 */
function chromePipe(executable, profile) {
  const child = spawn(executable, [
    '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--hide-scrollbars', '--remote-debugging-pipe', `--user-data-dir=${profile}`,
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let nextId = 0;
  let buffer = '';
  let stderr = '';
  const requests = new Map();
  const events = new Map();
  const fail = error => {
    for (const pending of [...requests.values(), ...events.values()]) { clearTimeout(pending.timer); pending.reject(error); }
    requests.clear(); events.clear();
  };
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.on('error', fail);
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    fail(new Error(`Chrome exited ${code}/${signal}: ${stderr}`));
    resolve({ code, signal });
  }));
  child.stdio[4].setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const key = `${message.sessionId || ''}:${message.method}`;
      const pending = message.id ? requests.get(message.id) : events.get(key);
      if (!pending) continue;
      clearTimeout(pending.timer);
      if (message.id) requests.delete(message.id); else events.delete(key);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result || message.params);
    }
  });
  return {
    send(method, params = {}, sessionId) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { requests.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 10000);
        requests.set(id, { resolve, reject, timer });
        child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
      });
    },
    event(method, sessionId) {
      const key = `${sessionId}:${method}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { events.delete(key); reject(new Error(`CDP event timed out: ${method}`)); }, 10000);
        events.set(key, { resolve, reject, timer });
      });
    },
    async close() {
      const timer = setTimeout(() => child.kill('SIGTERM'), 5000);
      try { await this.send('Browser.close').catch(() => {}); return await exited; }
      finally { clearTimeout(timer); }
    },
  };
}

const ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';
function fixture(css, theme, width) {
  const tokens = Object.entries(HOST_TOKENS).map(([name, values]) => `${name}:${values[theme === 'dark' ? 1 : 0]}`).join(';');
  const button = (id, label, classes = '', attrs = '') => `<button data-check="${id}" data-kind="text" class="dsh-au-icon-btn ${classes}" ${attrs}>${ICON}<span data-label class="dsh-au-tool-label">${label}</span></button>`;
  const icon = (id, classes, attrs = '', position = '') => `<button data-check="${id}" data-kind="icon" class="${classes}" ${attrs} ${position ? `style="${position}"` : ''}>${ICON}</button>`;
  return `<!doctype html><html ${width === 390 ? 'data-dsh-au-mobile="true"' : ''}><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    ${css}
    /* 动画时钟是测试边界；只关闭过渡，颜色与伪类仍由原始 CSS 决定。 */
    * { transition:none !important; animation:none !important; }
    body { margin:0; ${tokens}; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font:14px system-ui; }
    .theme-details { margin:440px 24px 0; display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  </style></head><body ${theme === 'dark' ? 'data-ds-dark-theme' : ''}>
    <header class="dsh-au-topbar${width === 390 ? ' compact-mobile mobile-tools-open' : ''}">
      <div class="dsh-au-tabs">${[['tab-active', '本机', 'active', ''], ['tab-idle', '远程', '', ''], ['tab-hover', '备用', '', 'data-hover']].map(([id, label, cls, attrs]) => `<button class="dsh-au-tab ${cls}" data-check="${id}" data-kind="text" ${attrs}><span data-label class="dsh-au-tab-name">${label}</span></button>`).join('')}</div>
      ${width === 390 ? `<div class="dsh-au-mobile-controls">${icon('menu-trigger', 'dsh-au-icon-btn dsh-au-mobile-menu', 'aria-expanded="true"')}${icon('collapse', 'dsh-au-icon-btn dsh-au-mobile-collapse')}</div>` : ''}
      <div class="dsh-au-actions"><div class="dsh-au-action-group">
        ${button('ordinary', '菜单')}${button('ordinary-hover', '远程', '', 'data-hover')}
        ${button('primary', '新增', 'primary')}${button('primary-hover', '接入', 'primary', 'data-hover')}
        ${button('disabled', '加载', '', 'disabled')}
        ${button('lan-on', '服务', 'dsh-au-action-status', 'data-lan-state="on"')}${button('lan-off', '离线', 'dsh-au-action-status', 'data-lan-state="off"')}
      </div></div>
    </header>
    <section class="theme-details"><span>Todo 与抽屉入口</span>
      ${icon('todo', 'dsh-au-todo-toggle', 'aria-expanded="false"')}${icon('todo-expanded', 'dsh-au-todo-toggle', 'aria-expanded="true"')}${icon('todo-hover', 'dsh-au-todo-toggle', 'data-hover')}
      ${icon('focus', 'dsh-au-icon-btn', 'data-focus')}
      <span class="dsh-au-status-capsule">${['idle', 'busy', 'done', 'waiting', 'error', 'offline', 'unknown'].map(status => `<span class="dsh-au-status-point"><span class="dsh-au-dot ${status}" data-check="status-${status}" data-kind="status"></span></span>`).join('')}</span>
      <!-- 浅蓝选中底色是独立对比度边界：语义灯在白底合格不代表在选中标签上也合格。 -->
      ${['idle', 'busy', 'done', 'waiting', 'error', 'offline', 'unknown'].map(status => `<button class="dsh-au-tab active"><span class="dsh-au-dot ${status}" data-check="selected-status-${status}" data-kind="status"></span><span>选中</span></button>`).join('')}
    </section>
    ${icon('drawer', 'dsh-au-mobile-trigger', '', 'top:600px;left:24px')}${icon('drawer-pressed', 'dsh-au-mobile-trigger', 'data-long-pressed="true"', 'top:600px;left:80px')}
  </body></html>`;
}

// 防止把全部状态灯都改成同一灰色来「通过对比度」；只约束色相方向，不锁死主题色值。
export function statusHasMeaning(id, [r, g, b]) {
  const status = id.split('-').at(-1);
  if (status === 'idle') return g > r + .05 && g > b + .05;
  if (status === 'busy') return r > g + .05 && g > b + .05;
  if (status === 'done') return b > r + .05 && b > g + .05;
  if (status === 'error') return r > g + .05 && r > b + .05;
  if (status === 'unknown' || status === 'offline') return Math.max(r, g, b) - Math.min(r, g, b) < .12;
  return true;
}

// 由浏览器解析真实 computedColor（含 color-mix/alpha），叠加实际祖先背景后算 WCAG 对比度。
function measureColors() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const rgba = color => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data].map(value => value / 255); };
  const over = (front, back) => front.slice(0, 3).map((value, i) => value * front[3] + back[i] * (1 - front[3])).concat(1);
  const fade = (front, back, opacity) => over(front.slice(0, 3).concat(opacity), back);
  const background = element => {
    if (!element) return [1, 1, 1, 1];
    const style = getComputedStyle(element), parent = background(element.parentElement);
    return fade(over(rgba(style.backgroundColor), parent), parent, Number(style.opacity));
  };
  const luminance = color => color.slice(0, 3).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
  const contrast = (a, b) => { const aa = luminance(a), bb = luminance(b); return (Math.max(aa, bb) + .05) / (Math.min(aa, bb) + .05); };
  return [...document.querySelectorAll('[data-check]')].map(element => {
    const style = getComputedStyle(element), parent = background(element.parentElement);
    const fill = over(rgba(style.backgroundColor), parent), bg = background(element);
    const label = element.querySelector('[data-label]') || element.querySelector('svg') || element;
    const fg = fade(over(rgba(getComputedStyle(label).color), fill), parent, Number(style.opacity));
    const status = element.dataset.kind === 'status';
    return {
      id: element.dataset.check, kind: element.dataset.kind, color: style.color, background: style.backgroundColor,
      border: style.borderTopColor, contrast: status ? contrast(bg, parent) : contrast(fg, bg),
      luminance: luminance(bg), channels: bg.slice(0, 3), disabled: element.disabled === true,
      visible: style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && element.getBoundingClientRect().width > 0,
      outlineContrast: style.outlineStyle === 'none' ? null : contrast(over(rgba(style.outlineColor), parent), parent),
      indicatorContrast: element.matches('.dsh-au-action-status') ? contrast(over(rgba(getComputedStyle(element, '::after').backgroundColor), fill), fill) : null,
    };
  });
}

test('2026-10-28 light/dark buttons remain readable under real fleet, Todo and mobile styles', {
  skip: !process.env.DSH_AU_TEST_CHROME, timeout: 60000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-au-button-theme-'));
  console.log(`Theme fixtures: ${directory}`);
  const profile = join(realpathSync(directory), 'profile');
  const css = buttonStyles();
  const browser = chromePipe(process.env.DSH_AU_TEST_CHROME, profile);
  const layouts = new Map();
  const failures = [];
  try {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    for (const method of ['Page.enable', 'DOM.enable', 'CSS.enable']) await browser.send(method, {}, sessionId);
    for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
      const file = join(directory, `${theme}-${width}.html`);
      writeFileSync(file, fixture(css, theme, width));
      await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
      const loaded = browser.event('Page.loadEventFired', sessionId);
      await browser.send('Page.navigate', { url: pathToFileURL(file).href }, sessionId); await loaded;
      const { root } = await browser.send('DOM.getDocument', {}, sessionId);
      for (const [selector, pseudo] of [['[data-hover]', 'hover'], ['[data-focus]', 'focus-visible']]) {
        const { nodeIds } = await browser.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector }, sessionId);
        for (const nodeId of nodeIds) await browser.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [pseudo] }, sessionId);
      }
      const evaluated = await browser.send('Runtime.evaluate', { expression: `(${measureColors.toString()})()`, returnByValue: true }, sessionId);
      assert.equal(evaluated.exceptionDetails, undefined, '浏览器必须成功测量实际计算色');
      const measurements = evaluated.result.value;
      layouts.set(`${theme}-${width}`, measurements);
      writeFileSync(join(directory, `${theme}-${width}.json`), JSON.stringify(measurements, null, 2));
      const screenshot = await browser.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      writeFileSync(join(directory, `${theme}-${width}.png`), Buffer.from(screenshot.data, 'base64'));
      for (const row of measurements) {
        if (!row.visible) failures.push(`${theme}/${width}/${row.id}: invisible`);
        if (row.kind === 'status' && !statusHasMeaning(row.id, row.channels)) failures.push(`${theme}/${width}/${row.id}: lost status color meaning; channels=${row.channels}`);
        if (!row.disabled && row.contrast < (row.kind === 'text' ? 4.5 : 3)) failures.push(`${theme}/${width}/${row.id}: contrast ${row.contrast.toFixed(4)}; foreground=${row.color}; background=${row.background}`);
        if (row.indicatorContrast !== null && row.indicatorContrast < 3) failures.push(`${theme}/${width}/${row.id}::after: contrast ${row.indicatorContrast.toFixed(4)}`);
        if (row.id === 'focus' && (row.outlineContrast === null || row.outlineContrast < 3)) failures.push(`${theme}/${width}/focus: outline contrast ${row.outlineContrast}`);
        if (theme === 'dark' && row.kind !== 'status' && !row.id.startsWith('primary') && row.luminance >= .25) failures.push(`${theme}/${width}/${row.id}: dark theme became a light block`);
        if (theme === 'light' && ['tab-idle', 'ordinary', 'todo', 'drawer'].includes(row.id) && row.luminance <= .5) failures.push(`${theme}/${width}/${row.id}: light theme retained a dark block`);
      }
      const minimum = kind => Math.min(...measurements.filter(row => row.kind === kind && !row.disabled).map(row => row.contrast)).toFixed(4);
      console.log(`Theme colors measured: ${theme}/${width}; ${measurements.length} states; min text=${minimum('text')}; icon=${minimum('icon')}; status=${minimum('status')}`);
    }
    for (const width of [390, 1280]) for (const id of ['tab-idle', 'ordinary', 'todo', 'drawer']) {
      const light = layouts.get(`light-${width}`).find(row => row.id === id);
      const dark = layouts.get(`dark-${width}`).find(row => row.id === id);
      if (light.border === dark.border) failures.push(`${width}/${id}: border does not follow host theme`);
    }
    assert.deepEqual(failures, [], `按钮主题回归：\n${failures.join('\n')}`);
  } finally {
    const result = await browser.close();
    // 保留全部 HTML / JSON / PNG；只清除经 realpath 确认属于本批次的 Chrome profile。
    if (existsSync(profile)) {
      assert.equal(realpathSync(profile), join(realpathSync(directory), 'profile'));
      rmSync(profile, { recursive: true });
    }
    assert.equal(result.code, 0, 'Chrome 必须正常退出');
  }
});
