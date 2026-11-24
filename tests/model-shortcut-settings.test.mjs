import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from '../scripts/build-client.js';

function makeWindow() {
  const values = new Map();
  return {
    name: '',
    localStorage: {
      getItem: (key) => values.get(key) || null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  };
}

function loadSettings(catalog, slots = Array(9).fill(null)) {
  const source = build();
  let definition = null;
  const window = makeWindow();
  window.__ModuleLoader__ = { load: (next) => { definition = next; } };
  new Function('window', source)(window);

  const reactState = [
    undefined,
    { models: catalog, current: null },
    false,
    '',
    false,
    false,
    '',
  ];
  let cursor = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
    Fragment: Symbol('Fragment'),
    useState: (initial) => {
      const value = reactState[cursor++];
      return [value === undefined ? initial : value, () => {}];
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
  };
  const mod = definition.factory((id) => {
    if (id === 'react') return React;
    if (id === 'react-dom') return { createPortal: (element) => element };
    throw new Error(`未预期的 require：${id}`);
  });
  mod.apply.modelShortcuts.modelShortcutsStore.snapshot = {
    enabled: false,
    binding: { code: 'KeyM', ctrl: false, alt: true, shift: false, meta: false },
    slots,
    loaded: true,
    busy: false,
    error: '',
  };
  return mod.apply.modelShortcutSettings.ModelShortcutSettingsGroup();
}

function walk(node, out = []) {
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, out));
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  walk(node.props?.children, out);
  return out;
}

function textContent(node) {
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (!node || typeof node !== 'object') return node == null ? '' : String(node);
  return textContent(node.props?.children);
}

test('设置页保留九个编号并显示完整模型目录与不可用配置', () => {
  const catalog = Array.from({ length: 12 }, (_, index) => ({
    provider: 'provider',
    model: `model-${index + 1}`,
    label: `模型 ${index + 1}`,
    reasoningEfforts: [],
  }));
  const slots = Array(9).fill(null);
  slots[4] = {
    provider: 'legacy-provider',
    model: 'legacy-model',
    label: '旧模型',
    reasoningEffort: 'legacy-effort',
  };
  const tree = loadSettings(catalog, slots);
  const nodes = walk(tree);
  const rows = nodes.filter((node) => node.props?.className === 'dsh-au-model-shortcut-row');
  const numbers = rows.map((row) => textContent(row.props.children[0]));
  const modelSelects = nodes.filter((node) => node.type === 'select' && node.props?.className === 'dsh-au-model-shortcut-select');
  const firstOptions = walk(modelSelects[0]).filter((node) => node.type === 'option');
  const firstOptgroups = walk(modelSelects[0]).filter((node) => node.type === 'optgroup');
  const unavailableOptions = walk(modelSelects[4]).filter((node) => node.type === 'option');
  const unavailableOptgroups = walk(modelSelects[4]).filter((node) => node.type === 'optgroup');
  const effortSelect = nodes.find((node) => node.type === 'select' && node.props?.value === 'legacy-effort');
  const effortOptions = effortSelect.props.children.flat();

  assert.equal(rows.length, 9, '固定保留 9 行，不因空槽压缩编号');
  assert.deepEqual(numbers, ['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  assert.equal(modelSelects.length, 9);
  assert.ok(firstOptgroups.length > 0, '模型下拉列表按供应商分组');
  assert.equal(firstOptgroups[0].props.label, 'provider', '展示正确的供应商名称');
  assert.ok(firstOptions.some((option) => option?.props?.value === 'provider\u0000model-12' && option.props.disabled !== true), '第 12 个目录模型仍可选');
  assert.equal(modelSelects[4].props.value, 'legacy-provider\u0000legacy-model');
  assert.ok(unavailableOptgroups.some((group) => group.props.label === 'legacy-provider'), '不可用模型也归入对应供应商组');
  // 保留禁用选项和原值，但不要把警告拼进原生单行下拉框。
  assert.ok(unavailableOptions.some((option) => option?.props?.disabled === true && textContent(option) === '旧模型'), '不可用模型只显示名称，警告另起一行');
  assert.ok(effortOptions.some((option) => option?.props?.value === 'legacy-effort' && option.props.disabled === true && textContent(option) === 'legacy-effort'), '不可用推理强度保留原值，不附加长说明');
  const effortNotice = nodes.find((node) => node.props?.id === effortSelect.props['aria-describedby']);
  assert.ok(effortNotice && textContent(effortNotice).includes('不可用'), '档位不可用说明与下拉框通过 aria-describedby 关联');
  assert.ok(walk(rows[4]).some((node) => node.props?.['data-tone'] === 'warn' && textContent(node).includes('保留已有配置')), '模型不可用警告独立保留');
  assert.equal(slots[4].reasoningEffort, 'legacy-effort', '展示布局不得修改已保存强度');
  assert.equal(nodes.some((node) => node.props?.className === 'dsh-au-model-shortcut-overlay'), false, '设置页不再创建第二套选模弹层');
});

// 布局回归：长不可用说明挤出强度框，覆盖相邻清除按钮。
// 沿用项目的 Chrome dump-dom + 独立 iframe 检查法，不安装浏览器。
test('不可用模型设置在窄屏和200%显示下分行，强度框不覆盖清除按钮', {
  skip: !process.env.DSH_AU_TEST_CHROME,
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-au-model-wrap-'));
  const slots = [
    { provider: 'azure-full', model: 'azure-gpt-generic', label: 'GPT example (Azure)', reasoningEffort: 'xhigh' },
    { provider: 'acp-antigravity', model: 'gemini-example', label: 'Gemini example', reasoningEffort: 'high' },
    { provider: 'kiro', model: 'claude-opus-5.5', label: 'Kiro Claude Opus 5.5' },
    { provider: 'azure-full', model: 'azure-gpt-generic', label: 'GPT example (Azure)', reasoningEffort: 'high' },
    { provider: 'acp-antigravity', model: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', reasoningEffort: 'high' },
    { provider: 'custom-provider-with-a-long-unbroken-identifier', model: 'long-model', label: '长名称模型 / Long model with additional context', reasoningEffort: 'extended-reasoning-effort-with-a-long-unbroken-identifier' },
    null, null, null,
  ];
  const styles = new Map();
  const doc = {
    getElementById: (id) => styles.get(id),
    createElement: () => ({ textContent: '' }),
    head: { appendChild: (node) => styles.set(node.id, node) },
  };
  const win = makeWindow();
  win.__ModuleLoader__ = { load: (definition) => { win.definition = definition; } };
  const source = build().replace('shortcuts: shortcutHelpers };', 'shortcuts: shortcutHelpers, ensureStyles };');
  new Function('window', 'document', source)(win, doc);
  const mod = win.definition.factory((id) => {
    if (id === 'react') return { createElement() {} };
    if (id === 'react-dom') return {};
    throw new Error(`未预期的依赖 ${id}`);
  });
  mod.ensureStyles();
  const css = [...styles.values()].map((style) => style.textContent).join('\n');
  const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  // 只序列化实际组件的输出，不另写一份容易漂移的模型列表 HTML。
  const serialize = (node, selectedValue) => {
    if (Array.isArray(node)) return node.map((child) => serialize(child, selectedValue)).join('');
    if (node == null || typeof node === 'boolean') return '';
    if (typeof node !== 'object') return escape(node);
    const { type, props } = node;
    const attrs = Object.entries(props).flatMap(([key, value]) => {
      if (['children', 'ref', 'key', 'value'].includes(key) || key.startsWith('on') || value == null) return [];
      if (key === 'disabled') return value ? ['disabled'] : [];
      return [`${key === 'className' ? 'class' : key}="${escape(value)}"`];
    });
    if (type === 'option' && props.value === selectedValue) attrs.push('selected');
    return `<${type} ${attrs.join(' ')}>${serialize(props.children, type === 'select' ? props.value : selectedValue)}</${type}>`;
  };
  // 同时覆盖正常双行、提供方默认和长不可用说明；不使用另一份展示模板。
  const catalog = [
    { ...slots[0], providerLabel: '示例供应商', reasoningEfforts: [{ id: 'xhigh', name: 'Xhigh' }] },
    { ...slots[2], providerLabel: 'Kiro', reasoningEfforts: [] },
  ];
  const markup = serialize(loadSettings(catalog, slots));
  for (const { width, zoom, panelWidth } of [
    { width: 320, zoom: 1 }, { width: 390, zoom: 1 }, { width: 640, zoom: 1 },
    { width: 1280, zoom: 1 }, { width: 1256, zoom: 2 }, { width: 1280, zoom: 1, panelWidth: 420 },
  ]) {
    const name = `${width}-${zoom}x${panelWidth ? `-panel${panelWidth}` : ''}`;
    const frame = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><style>${css}
      body { margin:0; padding:16px; font-family:system-ui,sans-serif; background:#2c2c2e; color:#f9fafb; zoom:${zoom}; --dsw-alias-bg-layer-1:#232324; --dsw-alias-label-primary:#f9fafb; --dsw-alias-label-secondary:#cfd3d6; }
      </style></head><body><main class="dsh-au-settings-page"${panelWidth ? ` style="max-width:${panelWidth}px"` : ''}>${markup}</main><pre id="result" hidden></pre><script>
      const rect = element => element?.getBoundingClientRect().toJSON();
      const measurements = [...document.querySelectorAll('.dsh-au-model-shortcut-row')].map(row => {
        const model = row.querySelector('select');
        const clear = row.querySelector('.dsh-au-model-shortcut-row-clear');
        const effort = row.querySelector('.dsh-au-model-shortcut-effort-select');
        const label = row.querySelector('.dsh-au-model-shortcut-effort-tag');
        const warning = row.querySelector('[data-tone="warn"]');
        const provider = row.querySelector('.dsh-au-model-shortcut-id');
        const controls = row.querySelector('.dsh-au-model-shortcut-controls');
        const value = effort || row.querySelector('.dsh-au-model-shortcut-effort-default');
        return { row:rect(row), model:rect(model), clear:rect(clear), effort:rect(effort), label:rect(label), warning:rect(warning), provider:rect(provider), controls:rect(controls), value:rect(value),
          controlsFit:[model, clear, value, warning, provider].filter(Boolean).every(element => element.scrollWidth <= element.clientWidth + 1) };
      });
      document.querySelector('#result').textContent = JSON.stringify({ viewport:innerWidth, panelWidth:document.querySelector('.dsh-au-model-shortcut-slots').clientWidth, overflow:document.documentElement.scrollWidth > innerWidth, rows:measurements });
      </script></body></html>`;
    writeFileSync(join(directory, `${name}-preview.html`), frame);
    const file = join(directory, `${name}.html`);
    writeFileSync(file, `<!doctype html><body style="margin:0"><pre id="result" hidden></pre><iframe style="border:0;width:${width}px;height:1200px" srcdoc="${escape(frame)}" onload="document.querySelector('#result').textContent=this.contentDocument.querySelector('#result').textContent"></iframe></body>`);
    const result = spawnSync(process.env.DSH_AU_TEST_CHROME, [
      '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--hide-scrollbars', `--user-data-dir=${join(directory, `profile-${name}`)}`,
      `--window-size=${Math.max(640, width)},1200`, '--dump-dom', pathToFileURL(file).href,
    ], { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.error, undefined, 'Chrome 必须正常启动');
    assert.equal(result.status, 0, result.stderr);
    const match = result.stdout.match(/<pre id="result"[^>]*>([^<]+)<\/pre>/);
    assert.ok(match, '浏览器必须真正执行布局测量');
    const layout = JSON.parse(match[1]);
    writeFileSync(join(directory, `${name}.json`), JSON.stringify(layout, null, 2));
    assert.equal(layout.viewport, width, '窄屏必须使用真实 iframe 视口');
    assert.equal(layout.overflow, false, `${name} 页面不应横向溢出`);
    assert.equal(layout.rows.length, 9, '保留全部九个位置');
    if (panelWidth) assert.ok(layout.panelWidth <= panelWidth, '确实在宽窗口内使用窄设置区');
    for (const row of layout.rows) {
      assert.equal(row.controlsFit, true, `${name} 控件内部不应横向溢出`);
      assert.ok(row.controls.top >= row.model.bottom, `${name} 操作栏必须位于模型框下方`);
      assert.ok(row.clear.right <= row.row.right + 1, `${name} 清除必须留在槽位内`);
      if (row.warning) assert.ok(row.warning.top >= row.controls.bottom - 1, `${name} 不可用说明不能挤进操作栏`);
      if (!row.value) continue;
      assert.ok(row.label.right <= row.value.left + 1 || row.label.bottom <= row.value.top + 1, `${name} 强度标签不能与值重叠`);
      assert.ok(row.value.top >= row.model.bottom, `${name} 强度必须在第二行或自动换行`);
      assert.ok(row.value.right <= row.row.right + 1, `${name} 强度框必须留在槽位内`);
      assert.ok(row.value.right <= row.clear.left + 1 || row.value.bottom <= row.clear.top + 1, `${name} 强度框与清除不能重叠`);
      assert.ok(row.provider.right <= row.value.left + 1 || row.provider.bottom <= row.value.top + 1, `${name} 厂商标签不能覆盖强度框`);
      if (layout.panelWidth > 520) {
        assert.ok(row.provider.top >= row.value.top - 1 && row.provider.top <= row.value.bottom, `${name} 宽设置区的厂商和强度应在同一行`);
        assert.ok(Math.abs(row.clear.top - row.value.top) < 1, `${name} 宽设置区的强度与清除应齐平`);
      }
    }
  }
  console.log(`Model layout fixtures: ${directory}`);
});

test('groupModelShortcutOptions 按供应商分组并正确回退供应商名称', () => {
  const source = build();
  let definition = null;
  const window = makeWindow();
  window.__ModuleLoader__ = { load: (next) => { definition = next; } };
  new Function('window', source)(window);
  const mod = definition.factory((id) => {
    if (id === 'react') return { createElement() {}, Fragment: Symbol('Fragment') };
    if (id === 'react-dom') return { createPortal: (element) => element };
    throw new Error(`未预期的 require：${id}`);
  });
  const { groupModelShortcutOptions } = mod.apply.modelShortcutSettings;
  const options = [
    { provider: 'azure', model: 'gpt-4', label: 'GPT-4', providerLabel: 'Azure' },
    { provider: 'azure', model: 'gpt-35', label: 'GPT-3.5', providerLabel: 'Azure' },
    { provider: 'anthropic', model: 'claude-3', label: 'Claude 3', providerLabel: 'Anthropic' },
    { provider: 'custom', model: 'custom-1', label: 'Custom' },
  ];
  const groups = groupModelShortcutOptions(options);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].label, 'Azure');
  assert.equal(groups[0].models.length, 2);
  assert.equal(groups[1].label, 'Anthropic');
  assert.equal(groups[1].models.length, 1);
  assert.equal(groups[2].label, 'custom', '没有 providerLabel 时回退到 provider id');
});

test('设置页提供一键清除按钮，推理强度默认选中 medium 且不显示「默认」选项', () => {
  const catalog = [
    {
      provider: 'antigravity',
      model: 'gemini-4-hydrogen',
      label: 'Gemini 4 Hydrogen',
      providerLabel: '反重力',
      reasoningDefault: 'high',
      reasoningEfforts: [
        { id: 'low', name: 'Low' },
        { id: 'medium', name: 'Medium' },
        { id: 'high', name: 'High' },
      ],
    },
  ];
  const slots = Array(9).fill(null);
  slots[0] = {
    provider: 'antigravity',
    model: 'gemini-4-hydrogen',
    label: 'Gemini 4 Hydrogen',
  };
  const tree = loadSettings(catalog, slots);
  const nodes = walk(tree);

  const clearAllBtn = nodes.find((node) => node.type === 'button' && node.props?.className?.includes('dsh-au-model-shortcut-clear-all'));
  assert.ok(clearAllBtn, '应在“可配置 9 个位置”右侧渲染一键清除按钮');
  assert.equal(textContent(clearAllBtn), '一键清除');
  assert.equal(clearAllBtn.props.disabled, false, '有已配置槽位时一键清除按钮可用');

  const effortSelect = nodes.find((node) => node.type === 'select' && node.props?.className === 'dsh-au-model-shortcut-effort-select');
  assert.ok(effortSelect, '应渲染推理强度下拉框');
  assert.equal(effortSelect.props.value, 'medium', '未显式保存推理强度时默认选中 medium');
  const effortOptions = walk(effortSelect).filter((node) => node.type === 'option');
  assert.equal(effortOptions.some((opt) => textContent(opt) === '默认' || opt.props?.value === ''), false, '下拉列表中不应再包含“默认”选项');
  assert.deepEqual(effortOptions.map((opt) => opt.props.value), ['low', 'medium', 'high']);
});

