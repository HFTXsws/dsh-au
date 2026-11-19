import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from '../scripts/build-client.js';

/** 只替换宿主 DOM 边界：实际执行两套样式安装器，捕获它们最终写入的 CSS。 */
function toolbarStyles() {
  const styles = new Map();
  const attrs = new Map();
  const doc = {
    getElementById: (id) => styles.get(id),
    createElement: () => ({ textContent: '' }),
    head: { appendChild: (node) => styles.set(node.id, node) },
    documentElement: { setAttribute: (key, value) => attrs.set(key, value), hasAttribute: (key) => attrs.has(key) },
  };
  const win = { innerWidth: 390, innerHeight: 844, __ModuleLoader__: { load: (definition) => { win.definition = definition; } } };
  // 仅测试出口，不更改生产接口或 CSS 安装逻辑。
  const code = build()
    .replace('helpers: {\n', 'helpers: {\n          ensureMobileStyles,\n')
    .replace('shortcuts: shortcutHelpers };', 'shortcuts: shortcutHelpers, ensureStyles };');
  new Function('window', 'document', code)(win, doc);
  const mod = win.definition.factory((id) => {
    if (id === 'react') return { createElement() {} };
    if (id === 'react-dom') return {};
    throw new Error(`Unexpected dependency ${id}`);
  });
  mod.ensureStyles();
  mod.mobile.ensureMobileStyles();
  assert.equal(styles.size, 2);
  return [...styles.values()].map((node) => node.textContent).join('\n');
}

/** 使用已安装的 Chrome，不下载浏览器；未指定时明确跳过，不将静态断言当作布局证明。 */
test('2026-10-28 mobile regressions: floating menu preserves page geometry and non-shrinking workbench navigation', {
  skip: !process.env.DSH_AU_TEST_CHROME,
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-au-toolbar-layout-'));
  const css = toolbarStyles();
  console.log(`Layout fixtures: ${directory}`);
  for (const width of [320, 390, 768, 1280]) {
    const mobile = width <= 768;
    const file = join(directory, `${width}.html`);
    const button = (label) => `<button class="dsh-au-icon-btn"><svg width="16" height="16"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor"/></svg><span class="dsh-au-tool-label">${label}</span></button>`;
    // 夹具保留真实设备栏的层级、类名和文字；浏览器验证 CSS，不重复实现 React 交互。
    const frameHtml = `<!doctype html><html ${mobile ? 'data-dsh-au-mobile="true"' : ''}><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0} ${css}</style></head><body>
      <!-- 宿主边界保留 top-host + 相邻 main + 独立 overlay stage，避免孤立 header 掩盖推挤正文的回归。 -->
      <section id="fixture-column" style="display:flex;flex-direction:column;height:100dvh">
      <div id="dsh-au-top-host"><header class="dsh-au-topbar${mobile ? ' compact-mobile mobile-tools-open' : ''}">
        <div class="dsh-au-tabs"><button class="dsh-au-tab active">mac</button><button class="dsh-au-tab">win</button><button class="dsh-au-tab">yoga</button></div>
        <div class="dsh-au-mobile-controls"><button class="dsh-au-icon-btn dsh-au-mobile-menu" aria-expanded="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button><button class="dsh-au-icon-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 15 6-6 6 6"/></svg></button></div>
        <div class="dsh-au-actions"><div class="dsh-au-action-group">${['插件', '服务', '脚本菜单'].map(button).join('')}</div><span class="dsh-au-action-divider"></span><div class="dsh-au-action-group">${['远程', '新增'].map(button).join('')}</div></div>
      </header></div>
      <main data-slot="main" style="flex:1;min-height:0"><div>本机正文</div></main>
      </section>
      <div id="dsh-au-stage-host"><div class="dsh-au-stage"><iframe class="dsh-au-iframe" title="保活远程页面" srcdoc="<body style='margin:0;padding:24px;background:#0f1117;color:#cbd5e1;font:14px sans-serif'><h2>远程工作区</h2><p>工具菜单悬浮在这里，正文与远程页面高度保持不变。</p></body>"></iframe></div></div>
      <!-- 长内容复现原 flex 收缩事故；导航与正文复用实际工作台层级，不覆盖被测 CSS。 -->
      <section class="dsh-au-wb-modal" role="dialog">
        <header class="dsh-au-wb-head"><input class="dsh-au-wb-search" placeholder="菜单和服务检索"><button class="dsh-au-btn">关闭</button></header>
        <div class="dsh-au-wb-body">
          <nav class="dsh-au-wb-nav">${['常用收藏', '后台服务管理', '插件管理', '全部菜单指令', '基础配置', 'IDE 管理', '远程接入', '网关服务', '开发工具', '同步管理'].map(label => `<button class="dsh-au-wb-navbtn"><span class="dsh-au-nav-main"><span class="dsh-au-nav-icon">●</span><span class="dsh-au-nav-label">${label}</span></span><span class="dsh-au-nav-count">12</span></button>`).join('')}</nav>
          <section class="dsh-au-wb-center">${Array.from({ length: 24 }, (_, index) => `<article class="dsh-au-wb-card"><strong class="dsh-au-card-title">后台服务 ${index + 1}</strong><span class="dsh-au-card-desc">包含状态、启用方式与本机配置的服务详情。</span><div class="dsh-au-card-foot"><button class="dsh-au-card-btn">启动</button></div></article>`).join('')}</section>
          <aside class="dsh-au-wb-inspector"><strong>后台服务详情</strong><p class="dsh-au-note">工作台有长正文时，顶部导航仍应保留完整触摸高度。</p></aside>
        </div><footer class="dsh-au-wb-foot">本机工作台</footer>
      </section><pre id="result" hidden></pre><script>
        const actions = document.querySelector('.dsh-au-actions');
        const rows = [...actions.querySelectorAll('button')];
        const header = document.querySelector('.dsh-au-topbar');
        const measurePage = () => {
          const column = document.querySelector('#fixture-column').getBoundingClientRect();
          const bar = document.querySelector('#dsh-au-top-host').getBoundingClientRect();
          const stage = document.querySelector('.dsh-au-stage');
          // 宿主提供 shell 中同一几何边界：舞台从 top-host 底部延伸到中心列底部。
          const top = Math.max(column.top, bar.bottom);
          Object.assign(stage.style, { left: column.left + 'px', top: top + 'px', width: column.width + 'px', height: Math.max(0, column.bottom - top) + 'px', display: 'block' });
          return {
            topbarHeight: header.getBoundingClientRect().height,
            hostHeight: bar.height,
            contentTop: document.querySelector('main[data-slot="main"]').getBoundingClientRect().top,
            stageTop: stage.getBoundingClientRect().top,
            stageHeight: stage.getBoundingClientRect().height
          };
        };
        header.classList.remove('mobile-tools-open');
        const closed = measurePage();
        if (${mobile}) header.classList.add('mobile-tools-open');
        const open = measurePage();
        const rect = actions.getBoundingClientRect();
        const panelStyle = getComputedStyle(actions);
        const panelInsets = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce((sum, key) => sum + parseFloat(panelStyle[key]), 0);
        const nav = document.querySelector('.dsh-au-wb-nav');
        const navRect = nav.getBoundingClientRect();
        const body = document.querySelector('.dsh-au-wb-body');
        nav.scrollLeft = nav.scrollWidth;
        const workbench = {
          navHeight: navRect.height, horizontalScroll: nav.scrollLeft > 0,
          rows: [...nav.querySelectorAll('button')].map(row => { const r = row.getBoundingClientRect(); return {
            height: r.height, top: r.top, bottom: r.bottom, inside: r.top >= navRect.top && r.bottom <= navRect.bottom
          }}),
          direction: getComputedStyle(nav).flexDirection,
          center: document.querySelector('.dsh-au-wb-center').getBoundingClientRect().toJSON(),
          inspector: document.querySelector('.dsh-au-wb-inspector').getBoundingClientRect().toJSON(),
          nav: navRect.toJSON()
        };
        body.scrollTop = body.scrollHeight;
        workbench.verticalScroll = body.scrollTop > 0;
        nav.scrollLeft = 0;
        body.scrollTop = 0;
        document.querySelector('#result').textContent = JSON.stringify({
          viewport: innerWidth, viewportHeight: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth,
          menu: { closed, open },
          panel: {
            width: rect.width, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
            position: panelStyle.position, headerBottom: header.getBoundingClientRect().bottom,
            headerRight: header.getBoundingClientRect().right - parseFloat(getComputedStyle(header).paddingRight),
            aboveStage: actions.contains(document.elementFromPoint(rect.left + 10, rect.top + 10))
          },
          rows: rows.map(row => {const r = row.getBoundingClientRect(); const label = row.querySelector('span'); const lr = label.getBoundingClientRect(); return {
            width: r.width, height: r.height, left: r.left, top: r.top, label: label.textContent,
            visible: getComputedStyle(label).display !== 'none' && lr.width > 0 && label.scrollWidth <= label.clientWidth && lr.left >= r.left && lr.right <= r.right,
            fullWidth: Math.abs(r.width - (rect.width - panelInsets)) < 2,
            contentWidth: ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth', 'gap'].reduce((sum, key) => sum + parseFloat(getComputedStyle(row)[key]), 0) + row.querySelector('svg').getBoundingClientRect().width + lr.width + panelInsets
          }}),
          controls: [...document.querySelectorAll('.dsh-au-mobile-controls button')].map(row => row.getBoundingClientRect().width),
          workbench
        });
      </script></body></html>`;
    // Chrome 顶层窗口最窄为 500px；真实 iframe 有独立视口，可准确验证 320/390px CSS。
    const srcdoc = frameHtml.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
    writeFileSync(file, `<!doctype html><body style="margin:0"><pre id="result" hidden></pre><iframe style="border:0;width:${width}px;height:1024px" srcdoc="${srcdoc}" onload="document.querySelector('#result').textContent=this.contentDocument.querySelector('#result').textContent"></iframe></body>`);
    const profile = join(realpathSync(directory), `profile-${width}`);
    const result = spawnSync(process.env.DSH_AU_TEST_CHROME, [
      '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--hide-scrollbars', `--user-data-dir=${profile}`,
      `--window-size=${width},1024`,
      ...(width === 390 ? [`--screenshot=${join(directory, 'portrait.png')}`] : []),
      '--dump-dom', pathToFileURL(file).href,
    ], { encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
    // 只删除已核实的本次 Chrome profile；HTML、测量和截图保留供人工复核。
    if (existsSync(profile)) {
      assert.equal(realpathSync(profile), join(realpathSync(directory), `profile-${width}`), 'cleanup 必须只针对本次真实 profile 绝对路径');
      rmSync(profile, { recursive: true });
    }
    assert.equal(result.error, undefined, 'Chrome 启动失败');
    assert.equal(result.status, 0, result.stderr);
    const match = result.stdout.match(/<pre id="result"[^>]*>([^<]+)<\/pre>/);
    assert.ok(match, '浏览器必须执行布局测量脚本');
    const layout = JSON.parse(match[1]);
    writeFileSync(join(directory, `${width}.json`), JSON.stringify(layout, null, 2));
    assert.equal(layout.viewport, width, '检查真实视口，不能将桌面误当窄屏');
    assert.equal(layout.overflow, false, `${width}px 不应横向溢出`);
    assert.equal(layout.rows.length, 5);
    assert.ok(layout.rows.every((row) => row.visible), `${width}px 菜单文字必须可见`);
    if (mobile) {
      assert.deepEqual(layout.menu.open, layout.menu.closed, `${width}px 展开菜单不能改变设备栏、正文或可用远程舞台的几何尺寸`);
      assert.ok(layout.menu.open.stageHeight > 0, '远程舞台必须确实存在，不能用空容器规避推挤回归');
      assert.equal(layout.panel.position, 'absolute', `${width}px 菜单必须脱离文档流`);
      assert.ok(layout.panel.top > layout.panel.headerBottom && layout.panel.top <= layout.panel.headerBottom + 10, `${width}px 菜单应悬浮在设备栏下方`);
      assert.ok(layout.panel.left >= 0 && layout.panel.right <= width && layout.panel.bottom <= layout.viewportHeight, `${width}px 悬浮面板不能越出视口`);
      assert.equal(layout.panel.aboveStage, true, `${width}px 菜单必须在远程 iframe 舞台上层且可点击`);
      assert.ok(Math.abs(layout.panel.right - layout.panel.headerRight) < 2, `${width}px 菜单应靠右对齐`);
      assert.ok(layout.panel.width < width / 2, `${width}px 菜单不应占满整行`);
      assert.ok(Math.abs(layout.panel.width - Math.max(...layout.rows.map(row => row.contentWidth))) < 4, `${width}px 菜单宽度应只容纳图标、文字与必要内边距`);
      assert.ok(layout.rows.every((row) => row.fullWidth && row.height >= 44 && row.height <= 48), `${width}px 菜单行相对于内容自适应面板保持同宽和正常触摸高度：${JSON.stringify(layout.rows)}`);
      assert.ok(layout.rows.every((row, index) => !index || row.top > layout.rows[index - 1].top), '菜单必须纵向排列');
      assert.ok(layout.controls.every((size) => size >= 44 && size <= 48), '菜单及收起入口保持正常触摸宽度');
    } else {
      assert.ok(layout.rows.every((row) => row.top === layout.rows[0].top), '桌面保持横向工具栏');
    }
    const wb = layout.workbench;
    assert.equal(wb.rows.length, 10);
    if (width <= 720) {
      assert.ok(wb.navHeight >= 58 && wb.navHeight <= 64, `${width}px 长正文不能压扁导航：${wb.navHeight}px`);
      assert.ok(wb.rows.every(row => row.height >= 44 && row.inside), `${width}px 导航按钮必须完整可见且可触摸：${JSON.stringify(wb.rows)}`);
      assert.equal(wb.horizontalScroll, true, `${width}px 导航应实际可横向滚动`);
      assert.equal(wb.verticalScroll, true, `${width}px 长正文应实际可纵向滚动`);
    } else if (width === 1280) {
      assert.equal(wb.direction, 'column', '桌面保留纵向侧栏');
      assert.ok(wb.center.left >= wb.nav.right - 1, '桌面正文仍位于侧栏右侧');
      assert.ok(wb.inspector.left >= wb.center.right - 1, '桌面保留右侧详情栏');
    }
    console.log(`Browser layout verified: ${width}px; panel=${layout.panel.width}px/${layout.panel.position}; topbar=${layout.menu.closed.topbarHeight}->${layout.menu.open.topbarHeight}px; contentTop=${layout.menu.closed.contentTop}->${layout.menu.open.contentTop}px; stageHeight=${layout.menu.closed.stageHeight}->${layout.menu.open.stageHeight}px; nav=${wb.navHeight}px; xScroll=${wb.horizontalScroll}; yScroll=${wb.verticalScroll}`);
  }
  console.log(`Layout fixtures: ${directory}`);
});
