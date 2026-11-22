import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  invokePrivateExtensionAction,
  listPrivateExtensionsForClient,
  loadPrivateExtensionDescriptors,
  normalizeExtensionSurfaces,
  runPrivateExtensionsDoctor,
} from '../lib/private-extensions.js';

test('未配置或不存在 syncRepoRoot 时返回空扩展列表（出厂隔离）', () => {
  const missingRoot = join(tmpdir(), `dsh-au-no-ext-${Date.now()}`);
  const list = loadPrivateExtensionDescriptors({ syncRepoRoot: missingRoot });
  assert.deepEqual(list, []);
  const clientList = listPrivateExtensionsForClient({ syncRepoRoot: missingRoot });
  assert.deepEqual(clientList, []);
});

test('从私人仓库加载扩展并拒绝路径穿越与未知扩展调用', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-au-ext-'));
  const extDir = join(root, 'dsh-sync', 'extensions', 'demo-ext');
  mkdirSync(extDir, { recursive: true });
  writeFileSync(join(extDir, 'extension.json'), JSON.stringify({
    id: 'demo',
    title: '演示扩展',
    order: 20,
    clientFile: 'client.js',
    styleFile: 'styles.css',
    serverFile: 'server.js',
  }), 'utf8');
  writeFileSync(join(extDir, 'client.js'), 'return () => ({ renderCenter: () => null, renderInspector: () => null });', 'utf8');
  writeFileSync(join(extDir, 'styles.css'), '.demo { color: red; }', 'utf8');
  writeFileSync(join(extDir, 'server.js'), 'export async function handleAction({ action, body }) { return { ok: true, echoed: action, val: body?.x || 0 }; }', 'utf8');

  // 非法路径穿越扩展会被拦截（无法读取越界文件）
  writeFileSync(join(root, 'secret.js'), 'SECRET_LEAK', 'utf8');
  const badDir = join(root, 'dsh-sync', 'extensions', 'bad-ext');
  mkdirSync(badDir, { recursive: true });
  writeFileSync(join(badDir, 'extension.json'), JSON.stringify({
    id: 'bad',
    title: 'Bad',
    clientFile: '../../secret.js',
  }), 'utf8');

  try {
    const clientList = listPrivateExtensionsForClient({ syncRepoRoot: root });
    const demoExt = clientList.find((x) => x.id === 'demo');
    const badExt = clientList.find((x) => x.id === 'bad');
    assert.ok(demoExt);
    assert.equal(demoExt.title, '演示扩展');
    assert.match(demoExt.styleText, /\.demo/);
    assert.equal(badExt?.scriptText || '', '');

    const okRes = await invokePrivateExtensionAction('demo', 'ping', { x: 42 }, {}, { syncRepoRoot: root });
    assert.deepEqual(okRes, { ok: true, echoed: 'ping', val: 42 });

    const errRes = await invokePrivateExtensionAction('not-exist', 'ping', {}, {}, { syncRepoRoot: root });
    assert.equal(errRes.ok, false);
    assert.match(errRes.error, /未就绪|未找到/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runPrivateExtensionsDoctor 校验正常扩展与各类异常（缺 handleAction/语法错误/重复 id）', async () => {
  const missingRoot = join(tmpdir(), `dsh-au-doc-miss-${Date.now()}`);
  const unconf = await runPrivateExtensionsDoctor({ syncRepoRoot: missingRoot });
  assert.equal(unconf.ok, true);
  assert.equal(unconf.status, 'empty');

  const root = mkdtempSync(join(tmpdir(), 'dsh-au-ext-doc-'));
  const okDir = join(root, 'dsh-sync', 'extensions', 'a-ok-ext');
  const dupDir = join(root, 'dsh-sync', 'extensions', 'dup-ext');
  const badSrvDir = join(root, 'dsh-sync', 'extensions', 'bad-srv');
  mkdirSync(okDir, { recursive: true });
  mkdirSync(dupDir, { recursive: true });
  mkdirSync(badSrvDir, { recursive: true });

  writeFileSync(join(okDir, 'extension.json'), JSON.stringify({ id: 'alpha', title: 'Alpha', order: 10 }), 'utf8');
  writeFileSync(join(okDir, 'client.js'), 'return () => ({ renderCenter: () => null });', 'utf8');
  writeFileSync(join(okDir, 'server.js'), 'export async function handleAction() { return { ok: true }; }', 'utf8');

  writeFileSync(join(dupDir, 'extension.json'), JSON.stringify({ id: 'alpha', title: 'Dup Alpha', order: 20 }), 'utf8');
  writeFileSync(join(dupDir, 'client.js'), 'return 123;', 'utf8');

  writeFileSync(join(badSrvDir, 'extension.json'), JSON.stringify({ id: 'beta', title: 'Beta', order: 30 }), 'utf8');
  writeFileSync(join(badSrvDir, 'client.js'), 'return { useExtension: () => ({}) };', 'utf8');
  writeFileSync(join(badSrvDir, 'server.js'), 'export const notHandle = 1;', 'utf8');

  try {
    const rep = await runPrivateExtensionsDoctor({ syncRepoRoot: root });
    assert.equal(rep.ok, false);
    assert.equal(rep.summary.total, 3);
    assert.equal(rep.summary.okCount, 1);
    assert.equal(rep.summary.failCount, 2);

    const dup = rep.extensions.find((e) => e.folder === 'dup-ext');
    assert.ok(dup.issues.some((m) => m.includes('重复')));
    assert.ok(dup.issues.some((m) => m.includes('未返回 useExtension 函数')));

    const badSrv = rep.extensions.find((e) => e.folder === 'bad-srv');
    assert.ok(badSrv.issues.some((m) => m.includes('缺少 renderCenter 函数')));
    assert.ok(badSrv.issues.some((m) => m.includes('未导出 handleAction')));

    const single = await runPrivateExtensionsDoctor({ syncRepoRoot: root, extId: 'alpha' });
    assert.equal(single.ok, false);
    assert.equal(single.extensions.length, 2);

    const notFound = await runPrivateExtensionsDoctor({ syncRepoRoot: root, extId: 'missing' });
    assert.equal(notFound.ok, false);
    assert.match(notFound.issues[0], /未找到扩展/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('支持声明 surfaces: ["sidebar"] 的侧边栏与主舞台扩展及 Doctor 校验', async () => {
  assert.deepEqual(normalizeExtensionSurfaces({}), ['workbench']);
  assert.deepEqual(normalizeExtensionSurfaces({ sidebar: true }), ['sidebar']);
  assert.deepEqual(normalizeExtensionSurfaces({ surfaces: ['sidebar', 'workbench'] }), ['sidebar', 'workbench']);

  const root = mkdtempSync(join(tmpdir(), 'dsh-au-sb-ext-'));
  const sbOkDir = join(root, 'dsh-sync', 'extensions', 'sb-ok');
  const sbBadDir = join(root, 'dsh-sync', 'extensions', 'sb-bad');
  mkdirSync(sbOkDir, { recursive: true });
  mkdirSync(sbBadDir, { recursive: true });

  writeFileSync(join(sbOkDir, 'extension.json'), JSON.stringify({
    id: 'sb-ok',
    title: '侧栏团队扩展',
    surfaces: ['sidebar'],
  }), 'utf8');
  writeFileSync(join(sbOkDir, 'client.js'), 'return () => ({ renderSidebar: () => null, renderStage: () => null });', 'utf8');
  writeFileSync(join(sbOkDir, 'server.js'), 'export async function handleAction() { return { ok: true }; }', 'utf8');

  writeFileSync(join(sbBadDir, 'extension.json'), JSON.stringify({
    id: 'sb-bad',
    title: '缺少侧栏函数扩展',
    surfaces: ['sidebar'],
  }), 'utf8');
  writeFileSync(join(sbBadDir, 'client.js'), 'return () => ({});', 'utf8');

  try {
    const clientList = listPrivateExtensionsForClient({ syncRepoRoot: root });
    const sbOk = clientList.find((x) => x.id === 'sb-ok');
    assert.ok(sbOk);
    assert.deepEqual(sbOk.surfaces, ['sidebar']);

    const rep = await runPrivateExtensionsDoctor({ syncRepoRoot: root });
    assert.equal(rep.ok, false);
    const okItem = rep.extensions.find((x) => x.id === 'sb-ok');
    const badItem = rep.extensions.find((x) => x.id === 'sb-bad');
    assert.equal(okItem.status, 'ok');
    assert.equal(badItem.status, 'fail');
    assert.ok(badItem.issues.some((m) => m.includes('renderSidebar')));
    assert.ok(badItem.issues.some((m) => m.includes('renderStage')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('client/src 使用的 React Hook 必须在 01-runtime.js 顶部统一解构', () => {
  const srcDir = join(process.cwd(), 'client', 'src');
  const runtimeText = readFileSync(join(srcDir, '01-runtime.js'), 'utf8');
  const destructMatch = runtimeText.match(/const\s*\{([^}]+)\}\s*=\s*React\s*;/);
  assert.ok(destructMatch, '01-runtime.js 缺少 const { ... } = React; 解构');
  const declared = new Set(destructMatch[1].split(',').map((s) => s.trim()).filter(Boolean));

  const hooks = ['useState', 'useEffect', 'useCallback', 'useRef', 'useMemo', 'useReducer', 'useLayoutEffect', 'useContext', 'useId', 'useImperativeHandle'];
  const files = readdirSync(srcDir).filter((f) => f.endsWith('.js')).sort();
  for (const file of files) {
    const text = readFileSync(join(srcDir, file), 'utf8');
    for (const hook of hooks) {
      const bareCallRe = new RegExp(`(?<![.\\w$])${hook}\\s*\\(`, 'g');
      if (bareCallRe.test(text)) {
        assert.ok(declared.has(hook), `${file} 调用了 ${hook}() 但未在 01-runtime.js 解构`);
      }
    }
  }
});

