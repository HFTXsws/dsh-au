import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  loadMenuFavorites,
  normalizeMenuFavorites,
  resolveLocalBindingsPath,
  saveMenuFavorites,
  writeActivePointer,
} from '../lib/local-bindings.js';

/** 每个用例独占一个临时绑定文件，避免碰到真实 sync/local 目录。 */
function withTempBindings(run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-au-favorites-'));
  const localPath = path.join(dir, 'manifest.local.json');
  const previous = process.env.DSH_AU_LOCAL_BINDINGS_PATH;
  process.env.DSH_AU_LOCAL_BINDINGS_PATH = localPath;
  try {
    return run(localPath);
  } finally {
    if (previous === undefined) delete process.env.DSH_AU_LOCAL_BINDINGS_PATH;
    else process.env.DSH_AU_LOCAL_BINDINGS_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('收藏归一化：只留两位序号、去掉重复与非字符串', () => {
  assert.deepEqual(normalizeMenuFavorites(['11', '11', '33', '1', 'ab', 45, null, '']), ['11', '33']);
  assert.deepEqual(normalizeMenuFavorites('11'), []);
  assert.deepEqual(normalizeMenuFavorites(undefined), []);
});

test('字段缺失时返回 null，调用方按空收藏处理', () => {
  withTempBindings((localPath) => {
    // 文件都不存在：不算错误
    const missing = loadMenuFavorites('test-host');
    assert.equal(missing.exists, false);
    assert.equal(missing.favorites, null);
    assert.equal(missing.filePath, localPath);

    // 文件存在但没有收藏字段：同样返回 null，别的字段不动
    writeFileSync(localPath, `${JSON.stringify({ schemaVersion: 2, hostname: 'test-host', services: {} }, null, 2)}\n`, 'utf8');
    const legacy = loadMenuFavorites('test-host');
    assert.equal(legacy.exists, true);
    assert.equal(legacy.favorites, null);
  });
});

test('保存收藏写入本机绑定，保留服务与主机名，脏数据被清理', () => {
  withTempBindings((localPath) => {
    writeFileSync(localPath, `${JSON.stringify({
      schemaVersion: 2,
      hostname: 'test-host',
      updatedAt: '2026-01-01T00:00:00.000Z',
      services: { antigravity: { enabled: true } },
    }, null, 2)}\n`, 'utf8');

    const saved = saveMenuFavorites(['33', '11', '33', 'x'], 'test-host');
    assert.equal(saved.ok, true);
    assert.deepEqual(saved.favorites, ['33', '11']);

    const raw = JSON.parse(readFileSync(localPath, 'utf8'));
    assert.deepEqual(raw.menuFavorites, ['33', '11']);
    // 四个开关直接保留在机器备份中，不再抽离到 state.json。
    assert.deepEqual(raw.services, { antigravity: { enabled: true } });
    assert.equal(raw.hostname, 'test-host');
    assert.notEqual(raw.updatedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(existsSync(path.join(path.dirname(localPath), 'state.json')), false);

    // 读回来是同一份，顺序保持不变
    assert.deepEqual(loadMenuFavorites('test-host').favorites, ['33', '11']);
  });
});

test('绑定文件不存在时只建骨架写收藏，不伪造任何服务', () => {
  withTempBindings((localPath) => {
    const saved = saveMenuFavorites(['71'], 'fresh-host');
    assert.equal(saved.ok, true);

    const raw = JSON.parse(readFileSync(localPath, 'utf8'));
    assert.deepEqual(raw.menuFavorites, ['71']);
    assert.deepEqual(raw.services, {});
    assert.equal(raw.hostname, 'fresh-host');
    assert.equal(raw.schemaVersion, 2);
  });
});

test('收藏字段同样受凭据红线约束，含敏感字段的文件拒绝写入', () => {
  withTempBindings((localPath) => {
    writeFileSync(localPath, `${JSON.stringify({
      schemaVersion: 2,
      hostname: 'test-host',
      services: { svc: { token: 'plain-text' } },
    }, null, 2)}\n`, 'utf8');

    const saved = saveMenuFavorites(['11'], 'test-host');
    assert.equal(saved.ok, false);
    assert.match(saved.reason, /凭据字段/);
    // 失败时不写坏原文件
    assert.match(readFileSync(localPath, 'utf8'), /plain-text/);
  });
});

test('绑定路径默认指向云备份，指针指向谁就解析谁', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-au-bind-path-'));
  const previousDir = process.env.DSH_AU_LOCAL_DIR;
  const previousPath = process.env.DSH_AU_LOCAL_BINDINGS_PATH;
  delete process.env.DSH_AU_LOCAL_BINDINGS_PATH;
  process.env.DSH_AU_LOCAL_DIR = path.join(dir, 'local');
  try {
    // 没指针、没旧文件：落在本机主机名对应的云备份上。
    assert.match(resolveLocalBindingsPath('TestBook'), /machines[\\/]testbook\.json$/u);
    // 指针优先：换机时只改这一行，路径不用跟着改。
    const machinesDir = path.dirname(resolveLocalBindingsPath('TestBook'));
    mkdirSync(machinesDir, { recursive: true });
    writeFileSync(path.join(machinesDir, 'other-machine.json'), '{}\n', 'utf8');
    writeActivePointer('other-machine');
    assert.match(resolveLocalBindingsPath('TestBook'), /machines[\\/]other-machine\.json$/u);
  } finally {
    if (previousDir === undefined) delete process.env.DSH_AU_LOCAL_DIR;
    else process.env.DSH_AU_LOCAL_DIR = previousDir;
    if (previousPath !== undefined) process.env.DSH_AU_LOCAL_BINDINGS_PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
