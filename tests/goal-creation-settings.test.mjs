import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODULES, srcDir } from '../scripts/build-client.js';

// 复用源片段清单，不运行构建，也不读写实际用户配置或生成的 client.js。
const source = MODULES.map(([file]) => readFileSync(join(srcDir, file), 'utf8')).join('\n');
const flush = () => new Promise((resolve) => setImmediate(resolve));
const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

/** React 是外部宿主边界；保留每个组件的 hook 与订阅，让真实 handler 更新后重新渲染。 */
function makeReact() {
  const instances = new Map();
  let active;
  let cursor;
  let effects = [];
  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
    useState(initial) {
      const index = cursor++;
      const state = active;
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
      return [state[index], (update) => {
        state[index] = typeof update === 'function' ? update(state[index]) : update;
      }];
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = active[index];
      if (!previous || !dependencies || dependencies.some((value, i) => !Object.is(value, previous.dependencies?.[i]))) {
        const next = { dependencies };
        active[index] = next;
        effects.push(() => { previous?.cleanup?.(); next.cleanup = effect(); });
      }
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in active)) active[index] = { current: initial };
      return active[index];
    },
    useCallback: (callback) => callback,
    useMemo: (factory) => factory(),
  };
  function expand(node, path = 'root') {
    if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}/${index}`));
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      if (!instances.has(path)) instances.set(path, []);
      active = instances.get(path);
      cursor = 0;
      const result = node.type(node.props);
      return expand(result, `${path}/component`);
    }
    return { ...node, props: { ...node.props, children: expand(node.props.children, `${path}/children`) } };
  }
  return {
    React,
    render(component) {
      const tree = expand(React.createElement(component));
      const pending = effects;
      effects = [];
      pending.forEach((effect) => effect());
      return tree;
    },
  };
}

function makeHost(features = {}) {
  return {
    features: { todo: true, fullAccessByDefault: false, ...features },
    goalCreationError: '',
    requests: [],
    save: null,
    fetch(url, options) {
      const payload = JSON.parse(options?.body || '{}');
      const request = { url, method: options?.method, payload };
      this.requests.push(request);
      if (payload.action === 'getFeatures') return response({
        ok: true, features: { ...this.features }, goalCreationError: this.goalCreationError,
      });
      if (payload.action === 'saveFeatures') {
        if (this.save) return this.save(request);
        const { action, ...patch } = payload;
        Object.assign(this.features, patch);
        if (patch.blockGoalCreation === false) this.goalCreationError = '';
        return response({ ok: true, features: { ...this.features }, goalCreationError: this.goalCreationError });
      }
      // 其他设置区的初始化请求仍经过真实 callApi，但不访问外部宿主。
      return response({ ok: false });
    },
  };
}

function openSettings(host) {
  const storage = new Map();
  const window = {
    name: '',
    location: { href: 'http://localhost/' },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  };
  const runtime = makeReact();
  const require = (id) => {
    if (id === 'react') return runtime.React;
    if (id === 'react-dom') return { createPortal: (element) => element };
    throw new Error(`Unexpected host dependency: ${id}`);
  };
  const { apply } = new Function('require', 'window', 'fetch', `${source}\nreturn { apply };`)(
    require, window, host.fetch.bind(host)
  );
  let settings;
  const hostEffects = new Map();
  // 通过实际插件 settings.section 注册拿到页面，不导出或替换内部保存函数。
  apply({
    uiWorkspace: { openSession() {} },
    effect: (effect, label) => hostEffects.set(label, effect),
    slots: {
      inject: (name, register) => { if (name === 'settings.section') register(); },
      register: (_definition, component) => { settings = component; },
    },
  });
  hostEffects.get('dsh-au: features')();
  return { render: () => runtime.render(settings), storage };
}

function textOf(node) {
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node == null || typeof node === 'boolean') return '';
  return typeof node === 'object' ? textOf(node.props?.children) : String(node);
}

function findAll(node, predicate, found = []) {
  if (Array.isArray(node)) node.forEach((child) => findAll(child, predicate, found));
  else if (node && typeof node === 'object') {
    if (predicate(node)) found.push(node);
    findAll(node.props?.children, predicate, found);
  }
  return found;
}

function section(tree, heading) {
  const matches = findAll(tree, (node) => node.type === 'section'
    && findAll(node, (child) => child.type === 'h3' && textOf(child) === heading).length > 0);
  assert.equal(matches.length, 1, `Settings section must be visible: ${heading}`);
  return matches[0];
}

function switchOf(tree, heading = '目标创建限制') {
  const matches = findAll(section(tree, heading), (node) => node.props?.role === 'switch');
  assert.equal(matches.length, 1);
  return matches[0];
}

test('legacy host defaults off; clicking persists only on the host and a fresh page reloads both values', async () => {
  const host = makeHost();
  let page = openSettings(host);
  let tree = page.render();
  assert.equal(switchOf(tree).props['aria-checked'], false);
  assert.equal(switchOf(tree).props.disabled, true, 'Cannot save before host features load');
  await flush();
  tree = page.render();
  assert.equal(switchOf(tree).props.disabled, false);
  const headings = findAll(tree, (node) => node.type === 'h3').map(textOf);
  const fullAccessIndex = headings.indexOf('默认权限模式');
  assert.deepEqual(headings.slice(fullAccessIndex, fullAccessIndex + 3), ['默认权限模式', '目标创建限制', '自动续跑与智能恢复']);
  const toggles = findAll(tree, (node) => node.props?.className === 'dsh-au-settings-category-toggle');
  assert.deepEqual(
    toggles.map((node) => [
      textOf(findAll(node, (child) => child.props?.className === 'dsh-au-settings-category-title')[0]),
      node.props['aria-expanded'],
    ]),
    [
      ['工作台', true],
      ['对话与权限', true],
      ['快捷操作', false],
      ['同步', false],
    ]
  );
  assert.ok(textOf(section(tree, '目标创建限制')).includes('禁止 AI 新建目标'));
  assert.ok(textOf(section(tree, '目标创建限制')).includes('不影响已有目标及其恢复/续跑'));
  assert.ok(textOf(section(tree, '目标创建限制')).includes('普通任务照常执行'));

  for (const expected of [true, false]) {
    const storageBefore = [...page.storage];
    switchOf(tree).props.onClick();
    assert.equal(switchOf(page.render()).props.disabled, true, 'Saving disables the switch');
    await flush();
    tree = page.render();
    assert.equal(switchOf(tree).props['aria-checked'], expected);
    assert.equal(switchOf(tree).props.disabled, false);
    assert.equal(host.features.blockGoalCreation, expected);
    assert.deepEqual([...page.storage], storageBefore, 'Goal restriction never writes browser preferences');
    const saves = host.requests.filter((request) => request.payload.action === 'saveFeatures');
    assert.deepEqual(saves.at(-1), {
      url: '/dsh-au/api', method: 'POST', payload: { action: 'saveFeatures', blockGoalCreation: expected },
    });
    page = openSettings(host);
    page.render();
    await flush();
    tree = page.render();
    assert.equal(switchOf(tree).props['aria-checked'], expected, 'Reload reads host state, not stale browser state');
  }
});

test('the switch shows the server-confirmed value instead of the requested toggle', async () => {
  const host = makeHost({ blockGoalCreation: false });
  host.save = () => response({ ok: true, features: { blockGoalCreation: false } });
  const page = openSettings(host);
  page.render();
  await flush();
  switchOf(page.render()).props.onClick();
  await flush();
  const tree = page.render();
  assert.equal(switchOf(tree).props['aria-checked'], false);
  assert.equal(switchOf(tree).props.disabled, false);
  assert.equal(textOf(section(tree, '目标创建限制')).includes('保存失败'), false);
});

test('failed or unconfirmed saves preserve the previous value, show recovery guidance and allow retry', async (t) => {
  for (const failure of [
    { name: 'HTTP failure', save: () => response({ error: '当前宿主不支持 tools.guard' }, 503), expected: '当前宿主不支持 tools.guard' },
    { name: 'Application failure', save: () => response({ ok: false }) },
    { name: 'Missing feature receipt', save: () => response({ ok: true, features: {} }) },
  ]) {
    await t.test(failure.name, async () => {
      const host = makeHost({ blockGoalCreation: true });
      host.save = failure.save;
      const page = openSettings(host);
      page.render();
      await flush();
      switchOf(page.render()).props.onClick();
      await flush();
      let tree = page.render();
      assert.equal(switchOf(tree).props['aria-checked'], true);
      assert.equal(switchOf(tree).props.disabled, false);
      assert.ok(textOf(section(tree, '目标创建限制')).includes(failure.expected || '保存失败，请稍后重试'));
      host.save = null;
      switchOf(tree).props.onClick();
      await flush();
      tree = page.render();
      assert.equal(switchOf(tree).props['aria-checked'], false);
      assert.equal(textOf(section(tree, '目标创建限制')).includes('保存失败'), false);
    });
  }
});

test('an unavailable host explains its saved restriction on reload and still allows switching it off', async () => {
  const host = makeHost({ blockGoalCreation: true });
  host.goalCreationError = '当前宿主不支持 tools.guard，已保存的目标创建限制无法生效';
  let page = openSettings(host);
  page.render();
  await flush();
  let tree = page.render();
  assert.equal(switchOf(tree).props['aria-checked'], true, 'Display the saved host value without claiming it is enforced');
  assert.equal(switchOf(tree).props.disabled, false, 'Capability failure must not lock the user out of turning the policy off');
  assert.ok(textOf(section(tree, '目标创建限制')).includes(host.goalCreationError));
  assert.equal(textOf(section(tree, '目标创建限制')).includes('对后续工具执行立即生效'), false);
  for (const heading of ['待办面板', '默认权限模式']) {
    assert.equal(switchOf(tree, heading).props.disabled, false);
    assert.equal(textOf(section(tree, heading)).includes('tools.guard'), false);
  }
  switchOf(tree).props.onClick();
  await flush();
  tree = page.render();
  assert.equal(switchOf(tree).props['aria-checked'], false);
  assert.equal(textOf(section(tree, '目标创建限制')).includes('tools.guard'), false, 'Successful OFF clears the unsupported-host explanation');
  page = openSettings(host);
  page.render();
  await flush();
  tree = page.render();
  assert.equal(switchOf(tree).props['aria-checked'], false);
  assert.equal(switchOf(tree).props.disabled, false);
  assert.equal(textOf(section(tree, '目标创建限制')).includes('tools.guard'), false);
});

test('saving another host setting with a partial receipt does not drop the goal restriction', async (t) => {
  for (const heading of ['待办面板', '默认权限模式']) {
    await t.test(heading, async () => {
      const host = makeHost({ blockGoalCreation: true });
      host.save = () => response({ ok: true, features: { todo: false, fullAccessByDefault: true } });
      const page = openSettings(host);
      page.render();
      await flush();
      switchOf(page.render(), heading).props.onClick();
      await flush();
      assert.equal(switchOf(page.render()).props['aria-checked'], true);
      assert.equal(switchOf(page.render()).props.disabled, false);
    });
  }
});
