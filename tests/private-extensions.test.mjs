import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearExtSecrets,
  createExtSecretStore,
  deleteExtSecret,
  getExtSecret,
  listExtSecretKeys,
  resolveExtSecretsPath,
  setExtSecret,
} from '../lib/ext-secrets.js';
import {
  hasPrivateExtensionStream,
  invokePrivateExtensionAction,
  invokePrivateExtensionStream,
  listPrivateExtensionsForClient,
  loadPrivateExtensionDescriptors,
  normalizeExtensionSurfaces,
  runPrivateExtensionsDoctor,
} from '../lib/private-extensions.js';
import {
  BRIDGED_EXT_LLM_PROVIDER,
  isBridgedExtSessionId,
  toBridgedDshSessionId,
  groupEntriesIntoTurns,
  buildDshSeedEvents,
  syncExtSessionToNativeDsh,
  installExtNativeSessionBridge,
} from '../lib/ext-native-session-bridge.js';

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

test('sidebarTree 数据驱动侧边栏扩展可通过 Doctor，缺失时被明确拦截', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-au-sb-tree-'));
  const treeOkDir = join(root, 'dsh-sync', 'extensions', 'sb-tree-ok');
  const treeBadDir = join(root, 'dsh-sync', 'extensions', 'sb-tree-bad');
  mkdirSync(treeOkDir, { recursive: true });
  mkdirSync(treeBadDir, { recursive: true });

  writeFileSync(join(treeOkDir, 'extension.json'), JSON.stringify({
    id: 'sb-tree-ok',
    title: '原生侧栏树扩展',
    surfaces: ['sidebar'],
  }), 'utf8');
  writeFileSync(join(treeOkDir, 'client.js'), `return () => ({
    sidebarTree: {
      title: '原生分组',
      badge: 1,
      groups: [{ id: 'g1', title: '工作区', items: [{ id: 's1', title: '会话 1' }] }],
    },
  });`, 'utf8');
  writeFileSync(join(treeOkDir, 'server.js'), 'export async function handleAction() { return { ok: true }; }', 'utf8');

  writeFileSync(join(treeBadDir, 'extension.json'), JSON.stringify({
    id: 'sb-tree-bad',
    title: '缺失侧栏树与渲染器扩展',
    surfaces: ['sidebar'],
  }), 'utf8');
  writeFileSync(join(treeBadDir, 'client.js'), 'return () => ({ sidebarTree: null });', 'utf8');

  try {
    const rep = await runPrivateExtensionsDoctor({ syncRepoRoot: root });
    assert.equal(rep.ok, false);
    const okItem = rep.extensions.find((x) => x.id === 'sb-tree-ok');
    const badItem = rep.extensions.find((x) => x.id === 'sb-tree-bad');
    assert.equal(okItem.status, 'ok');
    assert.deepEqual(okItem.issues, []);
    assert.equal(badItem.status, 'fail');
    assert.ok(badItem.issues.some((m) => m.includes('缺少 sidebarTree 对象或 renderSidebar 函数')));
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


test('外部会话原生转接层将 Claude / GrokBot 历史投影为 DSH v4 事件流并拦截 LlmAdapter 续聊', async () => {
  assert.equal(typeof installExtNativeSessionBridge, 'function');

  const bridgedId = toBridgedDshSessionId('claude-workspace', 'sess-1');
  assert.ok(bridgedId.startsWith('0000e870-'));
  assert.equal(isBridgedExtSessionId(bridgedId), true);
  assert.equal(isBridgedExtSessionId('regular-session-id'), false);

  const entries = [
    { role: 'user', content: '用户提问内容', timestampMs: 1000 },
    { role: 'assistant', content: '助手回复内容', timestampMs: 2000 },
  ];
  const turns = groupEntriesIntoTurns(entries, 'claude-workspace');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].userText, '用户提问内容');
  assert.equal(turns[0].assistantText, '助手回复内容');

  const events = buildDshSeedEvents({
    dshSessionId: bridgedId,
    extId: 'claude-workspace',
    itemId: 'sess-1',
    title: 'Claude 工作区会话',
    turns,
    startSeq: 0,
    startTurn: 1,
  });

  assert.ok(events.length > 0);
  assert.equal(events[0].seq, 0);
  for (let i = 0; i < events.length; i += 1) {
    assert.equal(events[i].seq, i);
  }

  const eventTypes = events.map((e) => e.type);
  const requiredTypes = [
    'model/selection',
    'session/title',
    'turn/start',
    'step/start',
    'system/message',
    'user/message',
    'assistant/message',
    'step/end',
    'turn/end',
  ];
  for (const expectedType of requiredTypes) {
    assert.ok(eventTypes.includes(expectedType), '缺少预期事件类型: ' + expectedType);
  }

  const createdEvents = [];
  let createdHeader = null;
  const mockCtx = {
    sessionPersistence: {
      create: async (header) => {
        createdHeader = header;
        return {
          append: async (events) => {
            createdEvents.push(...events);
            return true;
          },
        };
      },
    },
  };

  const syncRes = await syncExtSessionToNativeDsh(mockCtx, {
    extId: 'claude-workspace',
    itemId: 'sess-1',
    title: 'Claude 工作区会话',
    entries,
  });

  assert.equal(syncRes.ok, true);
  assert.equal(syncRes.dshSessionId, bridgedId);
  assert.equal(syncRes.persisted, true);
  assert.equal(createdEvents.length, events.length);
  assert.equal(createdHeader?.id, bridgedId);
});

test('ext-secrets.js 命名空间隔离、读写删、listKeys 与非法参数校验', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-au-secrets-'));
  const secretsPath = join(root, 'nested', 'ext-secrets.json');
  const prevEnv = process.env.DSH_AU_EXT_SECRETS_PATH;

  try {
    process.env.DSH_AU_EXT_SECRETS_PATH = join(root, 'env-secrets.json');
    assert.equal(resolveExtSecretsPath(), join(root, 'env-secrets.json'));
    assert.equal(resolveExtSecretsPath({ secretsPath }), secretsPath);

    const storeA = createExtSecretStore('ext-alpha', { secretsPath });
    const storeB = createExtSecretStore('ext-beta', { secretsPath });

    assert.equal(storeA.has('api.token'), false);
    assert.equal(storeA.get('api.token'), '');

    assert.deepEqual(storeA.set('api.token', 'secret-a-123'), { ok: true });
    assert.deepEqual(storeA.set('endpoint_url', 'https://example.invalid'), { ok: true });
    assert.deepEqual(storeB.set('api.token', 'secret-b-999'), { ok: true });

    // 命名空间互不干扰，且 listKeys 仅返回键名
    assert.equal(storeA.get('api.token'), 'secret-a-123');
    assert.equal(storeB.get('api.token'), 'secret-b-999');
    assert.equal(storeA.has('api.token'), true);
    assert.deepEqual(storeA.listKeys(), ['api.token', 'endpoint_url']);
    assert.deepEqual(listExtSecretKeys('ext-beta', { secretsPath }), ['api.token']);

    // 空字符串视为删除
    storeA.set('endpoint_url', '');
    assert.equal(storeA.has('endpoint_url'), false);
    assert.deepEqual(storeA.listKeys(), ['api.token']);

    // 删除与清空
    deleteExtSecret('ext-alpha', 'api.token', { secretsPath });
    assert.equal(getExtSecret('ext-alpha', 'api.token', { secretsPath }), '');
    assert.equal(getExtSecret('ext-beta', 'api.token', { secretsPath }), 'secret-b-999');
    clearExtSecrets('ext-beta', { secretsPath });
    assert.deepEqual(storeB.listKeys(), []);

    if (process.platform !== 'win32') {
      assert.equal(statSync(secretsPath).mode & 0o777, 0o600);
    }

    // 非法 ID / Key 拒绝
    assert.throws(() => createExtSecretStore('../bad', { secretsPath }), /非法扩展 ID/);
    assert.throws(() => setExtSecret('BadUpper', 'token', '1', { secretsPath }), /非法扩展 ID/);
    assert.throws(() => storeA.set('__proto__', 'x'), /非法私密存储键名/);
    assert.throws(() => storeA.set('bad/key', 'x'), /非法私密存储键名/);
    assert.throws(() => storeA.get('constructor'), /非法私密存储键名/);
  } finally {
    if (prevEnv === undefined) delete process.env.DSH_AU_EXT_SECRETS_PATH;
    else process.env.DSH_AU_EXT_SECRETS_PATH = prevEnv;
    rmSync(root, { recursive: true, force: true });
  }
});

test('invokePrivateExtensionAction 注入 ctx.secrets 且 Doctor 兼容检查 streamAction', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-au-ext-sec-'));
  const secretsPath = join(root, 'secrets.json');
  const okDir = join(root, 'dsh-sync', 'extensions', 'sec-ext');
  const warnDir = join(root, 'dsh-sync', 'extensions', 'warn-stream-ext');
  mkdirSync(okDir, { recursive: true });
  mkdirSync(warnDir, { recursive: true });

  writeFileSync(join(okDir, 'extension.json'), JSON.stringify({
    id: 'sec-ext',
    title: '安全存储测试扩展',
  }), 'utf8');
  writeFileSync(join(okDir, 'client.js'), 'return () => ({ renderCenter: () => null });', 'utf8');
  writeFileSync(join(okDir, 'server.js'), `
    export async function handleAction({ action, body, ctx }) {
      if (action === 'save') {
        ctx.secrets.set(body.key, body.value);
        return { ok: true, keys: ctx.secrets.listKeys() };
      }
      if (action === 'read') {
        return { ok: true, val: ctx.secrets.get(body.key) };
      }
      return { ok: false, error: 'unknown' };
    }
  `, 'utf8');

  writeFileSync(join(warnDir, 'extension.json'), JSON.stringify({
    id: 'warn-stream',
    title: '非函数流扩展',
  }), 'utf8');
  writeFileSync(join(warnDir, 'client.js'), 'return () => ({ renderCenter: () => null });', 'utf8');
  writeFileSync(join(warnDir, 'server.js'), `
    export const streamAction = 'not-a-function';
    export async function handleAction() { return { ok: true }; }
  `, 'utf8');

  try {
    const saveRes = await invokePrivateExtensionAction('sec-ext', 'save', { key: 'apiKey', value: 'v-42' }, {}, { syncRepoRoot: root, secretsPath });
    assert.deepEqual(saveRes, { ok: true, keys: ['apiKey'] });
    const readRes = await invokePrivateExtensionAction('sec-ext', 'read', { key: 'apiKey' }, {}, { syncRepoRoot: root, secretsPath });
    assert.deepEqual(readRes, { ok: true, val: 'v-42' });

    // invokePrivateExtensionStream 对未导出 streamAction 的扩展自动回退 handleAction
    assert.equal(await hasPrivateExtensionStream('sec-ext', { syncRepoRoot: root }), false);
    const doc = await runPrivateExtensionsDoctor({ syncRepoRoot: root });
    assert.equal(doc.ok, true);
    const warnItem = doc.extensions.find((x) => x.id === 'warn-stream');
    assert.equal(warnItem.status, 'warn');
    assert.ok(warnItem.warnings.some((w) => w.includes('streamAction')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('installExtNativeSessionBridge 动态解析标题、拒绝无分隔符模型并支持 streamAction 流式对话与回退', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-au-bridge-stream-'));
  const streamDir = join(root, 'dsh-sync', 'extensions', 'stream-ext');
  const legacyDir = join(root, 'dsh-sync', 'extensions', 'legacy-ext');
  mkdirSync(streamDir, { recursive: true });
  mkdirSync(legacyDir, { recursive: true });

  writeFileSync(join(streamDir, 'extension.json'), JSON.stringify({
    id: 'stream-ext',
    title: '流式远程助手',
    surfaces: ['sidebar'],
  }), 'utf8');
  writeFileSync(join(streamDir, 'client.js'), 'return () => ({ renderSidebar: () => null, renderStage: () => null });', 'utf8');
  writeFileSync(join(streamDir, 'server.js'), `
    export const interrupted = [];
    export async function handleAction({ action, body }) {
      if (action === 'interruptRun') {
        interrupted.push(body?.sessionId || '');
        return { ok: true };
      }
      return { ok: true, reply: 'fallback-unused' };
    }
    export async function* streamAction({ action, body, signal }) {
      if (action !== 'sendMessage') return;
      yield { type: 'text-delta', text: '第一段:' + (body?.text || '') };
      yield '第二段';
      if (!signal?.aborted) {
        yield { type: 'text-delta', text: ':完成' };
      }
    }
  `, 'utf8');

  writeFileSync(join(legacyDir, 'extension.json'), JSON.stringify({
    id: 'legacy-ext',
    title: '传统同步助手',
    surfaces: ['sidebar'],
  }), 'utf8');
  writeFileSync(join(legacyDir, 'client.js'), 'return () => ({ renderSidebar: () => null, renderStage: () => null });', 'utf8');
  writeFileSync(join(legacyDir, 'server.js'), `
    export async function handleAction({ action, body }) {
      if (action === 'sendMessage') {
        return { ok: true, reply: '同步回复:' + (body?.text || '') };
      }
      return { ok: true };
    }
  `, 'utf8');

  let registeredAdapter = null;
  const mockCtx = {
    llm: {
      registerAdapter(providers, adapter) {
        assert.deepEqual(providers, [BRIDGED_EXT_LLM_PROVIDER]);
        registeredAdapter = adapter;
        return () => { registeredAdapter = null; };
      },
    },
  };

  const dispose = installExtNativeSessionBridge(mockCtx, { syncRepoRoot: root });
  try {
    assert.ok(registeredAdapter);

    // 1. resolveModel 动态返回扩展 title，不再硬编码 Claude
    const streamModel = await registeredAdapter.resolveModel(BRIDGED_EXT_LLM_PROVIDER, 'stream-ext::item-1');
    assert.equal(streamModel.name, '流式远程助手');
    const legacyModel = await registeredAdapter.resolveModel(BRIDGED_EXT_LLM_PROVIDER, 'legacy-ext::item-2');
    assert.equal(legacyModel.name, '传统同步助手');
    const unknownModel = await registeredAdapter.resolveModel(BRIDGED_EXT_LLM_PROVIDER, 'unknown-ext::item-3');
    assert.equal(unknownModel.name, 'unknown-ext');

    // 2. streamAction 逐块流式产出与汇总 block-end
    assert.equal(await hasPrivateExtensionStream('stream-ext', { syncRepoRoot: root }), true);
    const streamChunks = [];
    for await (const chunk of registeredAdapter.stream({
      model: 'stream-ext::item-1',
      messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
    })) {
      streamChunks.push(chunk);
    }
    const deltas = streamChunks.filter((c) => c.type === 'text-delta').map((c) => c.text);
    assert.deepEqual(deltas, ['第一段:你好', '第二段', ':完成']);
    const blockEnd = streamChunks.find((c) => c.type === 'block-end');
    assert.equal(blockEnd?.block?.text, '第一段:你好第二段:完成');
    assert.equal(streamChunks.at(-1)?.type, 'finish');

    // 3. 未导出 streamAction 时兼容回退 handleAction
    const legacyChunks = [];
    for await (const chunk of registeredAdapter.stream({
      model: 'legacy-ext::item-2',
      messages: [{ role: 'user', content: [{ type: 'text', text: '测试回退' }] }],
    })) {
      legacyChunks.push(chunk);
    }
    assert.deepEqual(
      legacyChunks.filter((c) => c.type === 'text-delta').map((c) => c.text),
      ['同步回复:测试回退'],
    );
    assert.equal(legacyChunks.find((c) => c.type === 'block-end')?.block?.text, '同步回复:测试回退');

    // 4. 无 :: 分隔符返回清晰错误，不硬编码回退
    const invalidChunks = [];
    for await (const chunk of registeredAdapter.stream({
      model: 'missing-separator',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {
      invalidChunks.push(chunk);
    }
    const invalidEnd = invalidChunks.find((c) => c.type === 'block-end');
    assert.match(invalidEnd?.block?.text || '', /无效的外部扩展会话模型标识/);

    // 5. 直接调用 invokePrivateExtensionStream 时未导出 streamAction 也会回退到 handleAction 单块输出
    const directFallback = [];
    for await (const chunk of invokePrivateExtensionStream(
      'legacy-ext',
      'sendMessage',
      { text: '直连' },
      {},
      { syncRepoRoot: root },
    )) {
      directFallback.push(chunk);
    }
    assert.deepEqual(directFallback, [{ type: 'text-delta', text: '同步回复:直连' }]);
  } finally {
    dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
