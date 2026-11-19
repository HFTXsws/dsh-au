import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MODEL_SHORTCUT_BINDING,
  MODEL_SHORTCUT_SLOT_COUNT,
  readModelShortcuts,
  saveModelShortcuts,
} from '../lib/model-shortcuts.js';

function tempFixture(prefix = 'dsh-au-model-shortcuts-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, filePath: join(dir, 'model-shortcuts.json') };
}

const configuredModel = { provider: 'openai', model: 'gpt-5.6', label: '主模型', reasoningEffort: 'high' };

test('缺少独立配置文件时返回默认关闭状态且不写盘', () => {
  const { dir, filePath } = tempFixture();
  try {
    const result = readModelShortcuts({ filePath });
    assert.equal(result.exists, false);
    assert.deepEqual(result.modelShortcuts, {
      enabled: false,
      binding: DEFAULT_MODEL_SHORTCUT_BINDING,
      slots: Array(9).fill(null),
    });
    assert.equal(existsSync(filePath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('部分更新保留未指定字段、固定九槽位置并允许清除 binding', () => {
  const { dir, filePath } = tempFixture();
  try {
    const first = saveModelShortcuts({ enabled: true }, { filePath });
    assert.equal(first.modelShortcuts.enabled, true);
    const slots = [null, configuredModel, null, null, { provider: 'anthropic', model: 'claude-sonnet' }];
    const second = saveModelShortcuts({ slots }, { filePath });
    assert.equal(second.modelShortcuts.enabled, true);
    assert.equal(second.modelShortcuts.binding.code, 'KeyM');
    assert.equal(second.modelShortcuts.slots.length, MODEL_SHORTCUT_SLOT_COUNT);
    assert.deepEqual(second.modelShortcuts.slots.slice(0, 5), slots);
    assert.equal(second.modelShortcuts.slots[1].model, 'gpt-5.6');
    assert.equal(second.modelShortcuts.slots[4].model, 'claude-sonnet');
    assert.deepEqual(second.modelShortcuts.slots.slice(5), Array(4).fill(null));

    const cleared = saveModelShortcuts({ binding: null }, { filePath });
    assert.equal(cleared.modelShortcuts.binding, null);
    assert.equal(readModelShortcuts({ filePath }).modelShortcuts.binding, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('模型快捷键拒绝超过九槽和非法槽位数据', () => {
  const { dir, filePath } = tempFixture();
  try {
    const cases = [
      { name: '超过九槽', patch: { slots: Array(10).fill(null) }, code: 'INVALID', text: /最多支持 9 个槽位/u },
      { name: '空模型 ID', patch: { slots: [{ provider: 'openai', model: ' ' }] }, code: 'INVALID', text: /有效的 provider\/model/u },
      { name: '敏感字段', patch: { slots: [{ provider: 'openai', model: 'x', apiKey: 'secret' }] }, code: 'SENSITIVE_FIELD', text: /敏感|不允许/u },
      { name: '未知字段', patch: { slots: [{ provider: 'openai', model: 'x', endpoint: 'https://example.test' }] }, code: 'UNKNOWN_FIELD', text: /槽位.*不允许/u },
      { name: '非法 binding', patch: { binding: { code: 'KeyM', ctrl: false, alt: 'yes', shift: false, meta: false } }, code: 'INVALID', text: /修饰键/u },
    ];
    for (const item of cases) {
      assert.throws(
        () => saveModelShortcuts(item.patch, { filePath }),
        (error) => error.code === item.code
          && item.text.test(error.message)
          && !/apiKey|endpoint/u.test(error.message),
        item.name,
      );
    }
    assert.equal(existsSync(filePath), false, '拒绝非法数据时不应创建配置文件');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('坏 JSON 显式报错且保存不会覆盖原内容', () => {
  const { dir, filePath } = tempFixture();
  try {
    const corrupt = '{ "enabled": true, 不是合法 JSON';
    writeFileSync(filePath, corrupt, 'utf8');
    assert.throws(() => readModelShortcuts({ filePath }), (error) => error.code === 'CORRUPT' && error.status === 500);
    assert.throws(() => saveModelShortcuts({ enabled: false }, { filePath }), (error) => error.code === 'CORRUPT');
    assert.equal(readFileSync(filePath, 'utf8'), corrupt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('独立模型快捷键文件不会改写旧 cloud manifest', () => {
  const { dir, filePath } = tempFixture();
  const manifestPath = join(dir, 'manifest.cloud.json');
  try {
    const oldManifest = JSON.stringify({ schemaVersion: 1, services: { keep: { name: '旧服务' } }, devices: [] }, null, 2);
    writeFileSync(manifestPath, oldManifest, 'utf8');
    saveModelShortcuts({ enabled: true, slots: [configuredModel] }, { filePath });
    assert.equal(readFileSync(manifestPath, 'utf8'), oldManifest);
    assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')).slots.slice(1), Array(8).fill(null));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
