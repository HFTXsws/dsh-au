import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyLocalBinding,
  ensureLocalBindingMigrated,
  listMachineBindings,
  loadLocalBindings,
  machineFilePath,
  saveMenuFavorites,
  resolveLocalBindingsPath,
  slugifyMachine,
  switchActiveBinding,
  updateMachinePlugins,
  writeActivePointer,
} from '../lib/local-bindings.js';

/** 每个用例独占一套 sync 目录：local/ 存指针与开关，machines/ 存可提交的备份。 */
function withSyncDir(run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-au-sync-'));
  const keys = [
    'DSH_AU_LOCAL_DIR',
    'DSH_AU_LOCAL_BINDINGS_PATH',
    'DSH_AU_MACHINES_DIR',
    'DSH_AU_LOCAL_POINTER_PATH',
    'DSH_AU_LOCAL_STATE_PATH',
  ];
  const previous = keys.map((key) => [key, process.env[key]]);
  for (const key of keys) delete process.env[key];
  process.env.DSH_AU_LOCAL_DIR = path.join(dir, 'local');
  try {
    return run(path.join(dir, 'local'));
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test('主机名归一成稳定的备份文件名', () => {
  assert.equal(slugifyMachine('example-MacBook-Pro.local'), 'example-macbook-pro');
  assert.equal(slugifyMachine('Win-Desktop.LAN'), 'win-desktop');
  assert.equal(slugifyMachine(''), 'machine');
});

test('旧文件迁移成云备份：路径 ~/ 化、开关进状态镜像、旧文件留 .bak', () => {
  withSyncDir((localDir) => {
    mkdirSync(localDir, { recursive: true });
    writeFileSync(path.join(localDir, 'manifest.local.json'), `${JSON.stringify({
      schemaVersion: 2,
      hostname: 'TestBook.local',
      menuFavorites: ['11', '33'],
      services: {
        svc: {
          name: 'S',
          scriptPath: path.join(homedir(), 'proj', 'svc.py'),
          log: path.join(homedir(), 'logs', 's.log'),
          health: 'http://127.0.0.1:8080/health',
          enabled: true,
          autoStartOnDsh: true,
          cloud: false,
        },
      },
    }, null, 2)}\n`, 'utf8');

    const out = ensureLocalBindingMigrated('TestBook.local');
    assert.equal(out.migrated, true);
    assert.equal(out.machineId, 'testbook');

    const machine = JSON.parse(readFileSync(machineFilePath('testbook'), 'utf8'));
    assert.equal(machine.services.svc.scriptPath, '~/proj/svc.py');
    assert.equal(machine.services.svc.log, '~/logs/s.log');
    // 备份是给仓库的：四个开关不该出现在里面。
    assert.equal(machine.services.svc.enabled, undefined);
    assert.equal(machine.services.svc.cloud, undefined);
    assert.deepEqual(machine.menuFavorites, ['11', '33']);

    const state = JSON.parse(readFileSync(path.join(localDir, 'state.json'), 'utf8'));
    assert.deepEqual(state.machines.testbook.services.svc, { enabled: true, autoStartOnDsh: true, cloud: false });

    assert.ok(existsSync(path.join(localDir, 'manifest.local.json.bak')), '旧文件要留一份 .bak');
    assert.equal(existsSync(path.join(localDir, 'manifest.local.json')), false);

    const pointer = JSON.parse(readFileSync(path.join(localDir, 'active.json'), 'utf8'));
    assert.equal(pointer.machineId, 'testbook');
  });
});

test('旧文件含凭据时拒绝迁移，原件不动', () => {
  withSyncDir((localDir) => {
    mkdirSync(localDir, { recursive: true });
    writeFileSync(path.join(localDir, 'manifest.local.json'), `${JSON.stringify({
      schemaVersion: 2,
      hostname: 'X.local',
      services: { svc: { token: 'plain-text' } },
    }, null, 2)}\n`, 'utf8');

    const out = ensureLocalBindingMigrated('X.local');
    assert.equal(out.migrated, false);
    assert.equal(out.reason, 'legacy-rejected');
    assert.ok(existsSync(path.join(localDir, 'manifest.local.json')));
    assert.equal(existsSync(machineFilePath('x')), false);
  });
});

test('切换只改指针，不动任何一份备份内容', () => {
  withSyncDir(() => {
    mkdirSync(path.dirname(machineFilePath('a')), { recursive: true });
    writeFileSync(machineFilePath('a'), `${JSON.stringify({
      schemaVersion: 2, machineId: 'a', displayName: 'A 机', services: { s1: { name: 'S1' } },
    }, null, 2)}\n`, 'utf8');
    writeFileSync(machineFilePath('b'), `${JSON.stringify({
      schemaVersion: 2, machineId: 'b', displayName: 'B 机', services: { s1: { name: 'S1' }, s2: { name: 'S2' } },
    }, null, 2)}\n`, 'utf8');
    writeActivePointer('a');

    const before = readFileSync(machineFilePath('a'), 'utf8');
    const listed = listMachineBindings('TestBook');
    assert.equal(listed.activeId, 'a');
    assert.equal(listed.items.find((item) => item.active).machineId, 'a');
    assert.equal(listed.items.find((item) => item.machineId === 'b').serviceCount, 2);
    // 列表按「当前使用 → 本机主机名 → 其余」排，第一张卡就是正在用的那份。
    assert.equal(listed.items[0].machineId, 'a');

    const switched = switchActiveBinding('b');
    assert.equal(switched.ok, true);
    assert.equal(listMachineBindings('TestBook').activeId, 'b');
    assert.equal(readFileSync(machineFilePath('a'), 'utf8'), before, '切换不该改写别人的备份');

    const missing = switchActiveBinding('missing');
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /云备份不存在/u);
  });
});

test('解析链：指针 > 旧文件 > 主机名备份', () => {
  withSyncDir((localDir) => {
    mkdirSync(localDir, { recursive: true });
    mkdirSync(path.dirname(machineFilePath('legacyhost')), { recursive: true });
    writeFileSync(machineFilePath('legacyhost'), '{}\n', 'utf8');
    writeFileSync(path.join(localDir, 'manifest.local.json'), '{}\n', 'utf8');

    // 迁移还没跑：旧文件是这台机器的事实来源。
    assert.match(resolveLocalBindingsPath('legacyhost'), /manifest\.local\.json$/u);
    // 指针一出现就按指针走。
    writeActivePointer('legacyhost');
    assert.match(resolveLocalBindingsPath('legacyhost'), /machines[\\/]legacyhost\.json$/u);
  });
});

test('绑定套用：~/ 展开成本机绝对路径，开关来自本地镜像', () => {
  withSyncDir((localDir) => {
    mkdirSync(path.dirname(machineFilePath('m1')), { recursive: true });
    writeFileSync(machineFilePath('m1'), `${JSON.stringify({
      schemaVersion: 2,
      machineId: 'm1',
      services: { svc: { scriptPath: '~/proj/svc.py', health: 'http://127.0.0.1:8080/api/health' } },
    }, null, 2)}\n`, 'utf8');
    writeActivePointer('m1');
    writeFileSync(path.join(localDir, 'state.json'), `${JSON.stringify({
      schemaVersion: 1,
      machines: { m1: { services: { svc: { enabled: true, cloud: true } } } },
    }, null, 2)}\n`, 'utf8');

    const loaded = loadLocalBindings('TestBook');
    const entry = applyLocalBinding({ id: 'svc', name: '目录名' }, loaded.services, loaded.flags);
    assert.equal(entry.scriptPath, path.join(homedir(), 'proj', 'svc.py'));
    assert.equal(entry.scriptName, 'svc.py');
    assert.equal(entry.scriptPathShort, '~/proj/svc.py');
    assert.equal(entry.port, 8080);
    assert.deepEqual(entry.localState, {
      enabled: true,
      autoStartOnBoot: false,
      autoStartOnDsh: false,
      cloud: true,
    });
  });
});

test('插件名单写进备份：只记接过哪些云插件，不记启用状态', () => {
  withSyncDir((localDir) => {
    mkdirSync(localDir, { recursive: true });
    writeFileSync(path.join(localDir, 'manifest.local.json'), `${JSON.stringify({
      schemaVersion: 2,
      hostname: 'Plug.local',
      services: { svc: { scriptPath: '~/proj/svc.py', enabled: true } },
    }, null, 2)}\n`, 'utf8');
    ensureLocalBindingMigrated('Plug.local');

    const saved = saveMenuFavorites(['11'], 'Plug.local', { plugins: ['@weibaohui/dsh-continue', 'dsh-market', 'dsh-market'] });
    assert.equal(saved.ok, true);
    assert.deepEqual(saved.plugins, ['@weibaohui/dsh-continue', 'dsh-market'], '重复项要去掉');

    const machine = JSON.parse(readFileSync(machineFilePath('plug'), 'utf8'));
    assert.deepEqual(machine.plugins, ['@weibaohui/dsh-continue', 'dsh-market']);
    assert.deepEqual(machine.menuFavorites, ['11']);
    // 服务绑定不能被一次收藏保存清掉。
    assert.ok(machine.services.svc);
    // 启用状态依旧不进备份。
    assert.equal(machine.services.svc.enabled, undefined);

    const listed = listMachineBindings('Plug.local');
    assert.equal(listed.items.find((item) => item.machineId === 'plug').pluginCount, 2);
  });
});

test('刷新插件名单：没有备份就不凭空创建，有备份只改这一行', () => {
  withSyncDir(() => {
    const skipped = updateMachinePlugins(['dsh-market'], 'NoBook');
    assert.equal(skipped.skipped, true);
    assert.equal(existsSync(machineFilePath('nobook')), false);

    mkdirSync(path.dirname(machineFilePath('b1')), { recursive: true });
    writeFileSync(machineFilePath('b1'), `${JSON.stringify({
      schemaVersion: 2, machineId: 'b1', menuFavorites: ['33'], services: { s1: { name: 'S1' } },
    }, null, 2)}\n`, 'utf8');
    writeActivePointer('b1');

    const out = updateMachinePlugins(['dsh-market'], 'B1');
    assert.equal(out.changed, true);
    const machine = JSON.parse(readFileSync(machineFilePath('b1'), 'utf8'));
    assert.deepEqual(machine.plugins, ['dsh-market']);
    assert.deepEqual(machine.menuFavorites, ['33'], '刷新插件不该动收藏');
    assert.ok(machine.services.s1, '刷新插件不该动服务');

    // 名单没变就不重写文件，避免每次启动都改 updatedAt。
    const again = updateMachinePlugins(['dsh-market'], 'B1');
    assert.equal(again.changed, false);
  });
});
