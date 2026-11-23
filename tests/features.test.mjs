import './isolate-sync.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig } from '../lib/config-store.js';
import {
  DEFAULT_AUTO_CONTINUE,
  DEFAULT_AUTO_CONTINUE_RULES,
  DEFAULT_FEATURES,
  normalizeAutoContinue,
  normalizeAutoContinueRule,
  normalizeFeatures,
} from '../lib/features.js';

// 旧配置和非布尔脏数据不能意外开启新的宿主级限制。
test('功能开关：todo 默认开启，权限与目标创建限制只有显式 true 才开启', () => {
  const cases = [
    [undefined, { todo: true, fullAccessByDefault: false, blockGoalCreation: false }],
    [{}, { todo: true, fullAccessByDefault: false, blockGoalCreation: false }],
    [{ todo: 'no' }, { todo: true, fullAccessByDefault: false, blockGoalCreation: false }],
    [{ todo: 0 }, { todo: true, fullAccessByDefault: false, blockGoalCreation: false }],
    [{ todo: false }, { todo: false, fullAccessByDefault: false, blockGoalCreation: false }],
    [{ fullAccessByDefault: true }, { todo: true, fullAccessByDefault: true, blockGoalCreation: false }],
    [{ fullAccessByDefault: 'yes' }, { todo: true, fullAccessByDefault: false, blockGoalCreation: false }],
    [{ todo: false, fullAccessByDefault: true, blockGoalCreation: true }, { todo: false, fullAccessByDefault: true, blockGoalCreation: true }],
    ...[null, false, 'true', 1, [], {}].map((blockGoalCreation) => [
      { blockGoalCreation }, { todo: true, fullAccessByDefault: false, blockGoalCreation: false },
    ]),
    [{ blockGoalCreation: true }, { todo: true, fullAccessByDefault: false, blockGoalCreation: true }],
    [{ disconnectRemotesOnLock: true }, { todo: true, fullAccessByDefault: false, blockGoalCreation: false, disconnectRemotesOnLock: true }],
    ...[null, false, 'true', 1, [], {}].map((disconnectRemotesOnLock) => [
      { disconnectRemotesOnLock },
      { todo: true, fullAccessByDefault: false, blockGoalCreation: false },
    ]),
    [{ sidebarWorkbench: true }, { todo: true, fullAccessByDefault: false, blockGoalCreation: false, sidebarWorkbench: true }],
    ...[null, false, 'true', 1, [], {}].map((sidebarWorkbench) => [
      { sidebarWorkbench },
      { todo: true, fullAccessByDefault: false, blockGoalCreation: false },
    ]),
  ];
  assert.deepEqual(normalizeFeatures(undefined), DEFAULT_FEATURES);
  for (const [raw, expected] of cases) {
    // 远程 DSH 管理缺字段时保持开启；侧边栏入口默认关闭；侧边栏扩展开关默认为空对象。
    assert.deepEqual(normalizeFeatures(raw), { remoteManagement: true, disconnectRemotesOnLock: false, sidebarWorkbench: false, sidebarExtensions: {}, ...expected });
  }
  // 侧边栏私人扩展开关仅保留显式布尔值，脏数据和非对象一律丢弃。
  assert.deepEqual(
    normalizeFeatures({ sidebarExtensions: { grokbot: false, 'claude-workspace': true, bad: 'false', empty: 0, '  ': false } }).sidebarExtensions,
    { grokbot: false, 'claude-workspace': true },
  );
  for (const bad of [null, undefined, [], 'grokbot', 123]) {
    assert.deepEqual(normalizeFeatures({ sidebarExtensions: bad }).sidebarExtensions, {});
  }
  for (const remoteManagement of [undefined, null, 'false', 0, true]) {
    assert.equal(normalizeFeatures({ remoteManagement }).remoteManagement, true);
  }
  assert.equal(normalizeFeatures({ remoteManagement: false }).remoteManagement, false);
});

test('配置读写往返保留全部宿主功能开关，旧配置缺目标限制字段时不改变原行为', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-features-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    assert.deepEqual(loadConfig().features, { todo: true, remoteManagement: true, fullAccessByDefault: false, blockGoalCreation: false, disconnectRemotesOnLock: false, sidebarWorkbench: false, sidebarExtensions: {} });
    const cfg = loadConfig();
    cfg.features = normalizeFeatures({ todo: false, remoteManagement: true, fullAccessByDefault: true, blockGoalCreation: true, disconnectRemotesOnLock: true, sidebarWorkbench: true, sidebarExtensions: { grokbot: false, 'claude-workspace': false } });
    saveConfig(cfg);
    assert.deepEqual(loadConfig().features, { todo: false, remoteManagement: true, fullAccessByDefault: true, blockGoalCreation: true, disconnectRemotesOnLock: true, sidebarWorkbench: true, sidebarExtensions: { grokbot: false, 'claude-workspace': false } });

    const filePath = join(dir, 'dsh-au.config.json');
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    delete raw.features.blockGoalCreation;
    writeFileSync(filePath, JSON.stringify(raw), 'utf8');
    assert.deepEqual(loadConfig().features, { todo: false, remoteManagement: true, fullAccessByDefault: true, blockGoalCreation: false, disconnectRemotesOnLock: true, sidebarWorkbench: true, sidebarExtensions: { grokbot: false, 'claude-workspace': false } });
    delete raw.features.disconnectRemotesOnLock;
    writeFileSync(filePath, JSON.stringify(raw), 'utf8');
    assert.deepEqual(loadConfig().features, { todo: false, remoteManagement: true, fullAccessByDefault: true, blockGoalCreation: false, disconnectRemotesOnLock: false, sidebarWorkbench: true, sidebarExtensions: { grokbot: false, 'claude-workspace': false } });
    delete raw.features.sidebarWorkbench;
    writeFileSync(filePath, JSON.stringify(raw), 'utf8');
    assert.deepEqual(loadConfig().features, { todo: false, remoteManagement: true, fullAccessByDefault: true, blockGoalCreation: false, disconnectRemotesOnLock: false, sidebarWorkbench: false, sidebarExtensions: { grokbot: false, 'claude-workspace': false } });
    delete raw.features.sidebarExtensions;
    writeFileSync(filePath, JSON.stringify(raw), 'utf8');
    assert.deepEqual(loadConfig().features, { todo: false, remoteManagement: true, fullAccessByDefault: true, blockGoalCreation: false, disconnectRemotesOnLock: false, sidebarWorkbench: false, sidebarExtensions: {} });
    delete raw.features;
    writeFileSync(filePath, JSON.stringify(raw), 'utf8');
    assert.deepEqual(loadConfig().features, { todo: true, remoteManagement: true, fullAccessByDefault: false, blockGoalCreation: false, disconnectRemotesOnLock: false, sidebarWorkbench: false, sidebarExtensions: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});

test('设置源码提供四个功能开关，目标创建限制与完全权限同组并仅保存当前宿主', () => {
  // 客户端由主任务统一构建；这里验证设置源码，不强迫子任务重建已有用户 bundle。
  const client = readFileSync(new URL('../client/src/13-settings.js', import.meta.url), 'utf8');
  assert.match(client, /callApi\('getFeatures'\)/);
  assert.match(client, /callApi\('saveFeatures', \{ todo: Boolean\(next\) \}\)/);
  assert.match(client, /callApi\('saveFeatures', \{ fullAccessByDefault: Boolean\(next\) \}\)/);
  assert.match(client, /callApi\('saveFeatures', \{ blockGoalCreation: Boolean\(next\) \}\)/);
  assert.match(client, /callApi\('saveFeatures', \{ sidebarWorkbench: Boolean\(next\) \}\)/);
  assert.match(client, /callApi\('saveFeatures', \{ sidebarExtensions: \{ \[extId\]: Boolean\(next\) \} \}\)/);
  assert.match(client, /h\(SidebarExtensionsFeatureGroup\)/);
  assert.match(client, /title: '启用待办面板'/);
  assert.match(client, /title: '在侧边栏显示 DSH AU'/);
  assert.match(client, /title: '新开对话默认完全权限'/);
  assert.match(client, /title: '启用移动端优化'/);
  assert.match(client, /writeMobileFeatureEnabled\(next\)/);
  assert.match(client, /callApi\('saveFeatures', \{ disconnectRemotesOnLock: Boolean\(next\) \}\)/);
  assert.match(client, /title: '锁屏时断开远程 DSH'/);
  assert.match(client, /h\(TodoFeatureGroup\),\s*h\(MobileFeatureGroup\),\s*h\(WindowMemoryFeatureGroup\),\s*h\(LockRemoteFeatureGroup\)/);
  assert.match(client, /h\(FullAccessFeatureGroup\),\s*h\(GoalCreationFeatureGroup\),\s*h\(AutoContinueFeatureGroup\)/);
  assert.deepEqual(normalizeAutoContinue(undefined), DEFAULT_AUTO_CONTINUE);
  assert.deepEqual(normalizeAutoContinue({ enabled: false, retryDelaySec: 1, maxRetries: 99, prompt: '  接着写  ' }), {
    enabled: false,
    retryDelaySec: 5,
    maxRetries: 30,
    compactOnDisconnect: true,
    continueOnTruncate: true,
    prompt: '接着写',
    rules: [],
  });
});

test('出厂不带续跑规则，总开关默认关闭', () => {
  assert.equal(DEFAULT_AUTO_CONTINUE.enabled, false);
  assert.equal(DEFAULT_AUTO_CONTINUE_RULES.length, 0);
  assert.deepEqual(normalizeAutoContinue(undefined).rules, []);
  assert.equal(normalizeAutoContinue(undefined).enabled, false);
});

test('normalizeAutoContinueRule 边界值校验与容错解析', () => {
  // 缺省值
  const def = normalizeAutoContinueRule(undefined, 2);
  assert.equal(def.id, 'rule-3');
  assert.equal(def.name, '自定义错误规则 3');
  assert.equal(def.enabled, true);
  assert.deepEqual(def.statusCodes, []);
  assert.deepEqual(def.keywords, []);
  assert.equal(def.action, 'wait_retry');
  assert.equal(def.delaySec, 60);
  assert.equal(def.maxRetries, 5);
  assert.equal(def.compactOnSecondAttempt, false);

  // compact_retry 默认延迟为 0
  const compactDef = normalizeAutoContinueRule({ action: 'compact_retry' });
  assert.equal(compactDef.delaySec, 0);

  // 允许 delaySec 为 0 秒
  const zeroDelay = normalizeAutoContinueRule({ action: 'wait_retry', delaySec: 0 });
  assert.equal(zeroDelay.delaySec, 0);

  // 非法 action 回退 wait_retry
  const invalidAction = normalizeAutoContinueRule({ action: 'unknown_action' });
  assert.equal(invalidAction.action, 'wait_retry');

  // statusCodes 支持字符串与数组，且过滤 100..599、去重与取整
  const codeParsed = normalizeAutoContinueRule({
    statusCodes: '503, 502 503 99 600 foo 429.2',
  });
  assert.deepEqual(codeParsed.statusCodes, [503, 502, 429]);

  // keywords 支持字符串与数组，去重且 trim 过滤空项
  const kwParsed = normalizeAutoContinueRule({
    keywords: ' auth_unavailable , no auth available, auth_unavailable,  , ',
  });
  assert.deepEqual(kwParsed.keywords, ['auth_unavailable', 'no auth available']);

  // maxRetries 裁剪到 1..30
  assert.equal(normalizeAutoContinueRule({ maxRetries: 0 }).maxRetries, 1);
  assert.equal(normalizeAutoContinueRule({ maxRetries: 50 }).maxRetries, 30);
});

test('normalizeAutoContinue 自定义 rules 同步回顶层兼容字段', () => {
  const norm = normalizeAutoContinue({
    rules: [
      {
        id: 'rule-503',
        action: 'wait_retry',
        delaySec: 45,
        maxRetries: 8,
      },
      {
        id: 'rule-413',
        action: 'compact_retry',
      },
    ],
  });
  assert.equal(norm.retryDelaySec, 45);
  assert.equal(norm.maxRetries, 8);
  assert.equal(norm.rules.length, 2);
  assert.equal(norm.rules[0].id, 'rule-503');
});
