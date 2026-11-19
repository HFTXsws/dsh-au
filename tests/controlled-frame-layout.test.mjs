import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../scripts/build-client.js';

/** 执行真实样式安装器，仅替换宿主 DOM 边界以读取最终注入的 CSS。 */
function controlledFrameStyles() {
  const styles = new Map();
  const doc = {
    getElementById: (id) => styles.get(id),
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: (node) => styles.set(node.id, node) },
    documentElement: { setAttribute() {}, appendChild: (node) => styles.set(node.id, node) },
  };
  const win = { __ModuleLoader__: { load: (definition) => { win.definition = definition; } } };
  const code = build().replace('shortcuts: shortcutHelpers };', 'shortcuts: shortcutHelpers, ensureStyles };');
  new Function('window', 'document', code)(win, doc);
  const mod = win.definition.factory((id) => {
    if (id === 'react') return { createElement() {} };
    if (id === 'react-dom') return {};
    throw new Error(`Unexpected dependency ${id}`);
  });
  mod.ensureStyles();
  mod.apply.remoteWorkspaces.ensureControlledFrameStyle(doc);
  assert.equal(styles.size, 2);
  return {
    shared: styles.get('dsh-au-style').textContent,
    controlled: styles.get('dsh-au-controlled-frame-style').textContent,
  };
}

function assertControlledFrameKeepsNativeRightbar(css, source) {
  assert.match(css, /html\[data-dsh-au-controlled-frame="true"\][\s\S]*aside\[data-slot="sidebar"\][\s\S]*display:\s*none\s*!important/, `${source} 必须隐藏重复左栏`);
  const frameRule = css.match(/html\[data-dsh-au-controlled-frame="true"\] \[class\*="_frame"\]\s*\{([^}]*)\}/);
  assert.ok(frameRule, `${source} 必须保留受控 frame 规则`);
  assert.doesNotMatch(frameRule[1], /grid-template-columns/, `${source} 不得覆盖宿主动态维护的 sidebar|center|rightbar 三轨`);
  assert.match(css, /html\[data-dsh-au-controlled-frame="true"\] \[class\*="_centerCol"\][^{]*\{[^}]*grid-column:\s*1\s*\/\s*3\s*!important/, `${source} 的正文必须吸收已隐藏左栏所占轨道，但不能占用第三列 rightbar`);
}

// 2026-11-05 回归：两列覆盖让远端 DSH 的 rightbar 自动落入错误网格位置，文件预览无法显示。
test('controlled frame hides its duplicate left sidebar while preserving native center and rightbar columns', () => {
  const styles = controlledFrameStyles();
  for (const [source, css] of Object.entries(styles)) {
    assertControlledFrameKeepsNativeRightbar(css, source);
  }
});
