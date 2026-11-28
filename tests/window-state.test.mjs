import './isolate-sync.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig } from '../lib/config-store.js';
import { machineFilePath, saveMachineSettingsBackup, writeActivePointer } from '../lib/local-bindings.js';
import {
  DEFAULT_WINDOW_STATE,
  isSameWindowGeometry,
  normalizeWindowGeometry,
  normalizeWindowState,
  resolveRestoreTarget,
} from '../lib/window-state.js';

const DISPLAY = { availLeft: 0, availTop: 33, availWidth: 1512, availHeight: 949 };
const SECOND_DISPLAY = { availLeft: 1512, availTop: 0, availWidth: 1920, availHeight: 1055 };

test('默认状态关闭且没有几何记录', () => {
  assert.deepEqual(normalizeWindowState(undefined), DEFAULT_WINDOW_STATE);
  assert.deepEqual(normalizeWindowState({ enabled: 'yes', geometry: 'nope' }), { enabled: false, geometry: null });
});

test('几何记录缺少合法 bounds 时整条作废', () => {
  assert.equal(normalizeWindowGeometry(null), null);
  assert.equal(normalizeWindowGeometry({ display: DISPLAY }), null);
  assert.equal(normalizeWindowGeometry({ bounds: { x: 0, y: 0, width: 'wide', height: 600 } }), null);
});

test('几何记录收缩异常尺寸与坐标', () => {
  const geometry = normalizeWindowGeometry({
    bounds: { x: 12.6, y: -8.4, width: 10, height: 999999 },
    display: { availLeft: 0, availTop: 33, availWidth: 1512, availHeight: 949 },
    fullscreen: 1,
    savedAt: '2026-10-26T08:00:00.000Z',
  });
  assert.equal(geometry.bounds.width, 320, '宽度低于下限时抬到最小可交互尺寸');
  assert.equal(geometry.bounds.height, 16384, '高度高于上限时压回护栏');
  assert.equal(geometry.bounds.x, 13);
  assert.equal(geometry.bounds.y, -8);
  assert.equal(geometry.fullscreen, false, '只有严格 true 才算全屏');
  assert.equal(geometry.savedAt, '2026-10-26T08:00:00.000Z');
  assert.deepEqual(geometry.display, DISPLAY);
});

test('无几何记录时不产生还原目标', () => {
  assert.equal(resolveRestoreTarget(null, DISPLAY), null);
  assert.equal(resolveRestoreTarget({ bounds: { x: 0, y: 0, width: 0, height: 0 } }, DISPLAY), null);
});

test('普通窗口按记录还原位置与大小', () => {
  const target = resolveRestoreTarget({
    bounds: { x: 120, y: 80, width: 1280, height: 840 },
    display: DISPLAY,
  }, DISPLAY);
  assert.deepEqual(target, { x: 120, y: 80, width: 1280, height: 840, fullscreen: false, maximized: false });
});

test('全屏记录还原为铺满记录时所在的显示器', () => {
  const target = resolveRestoreTarget({
    bounds: { x: 1512, y: 0, width: 1920, height: 1055 },
    display: SECOND_DISPLAY,
    fullscreen: true,
  }, DISPLAY);
  assert.deepEqual(target, {
    x: 1512,
    y: 0,
    width: 1920,
    height: 1055,
    fullscreen: true,
    maximized: false,
  }, '应使用记录里的副屏，而不是当前所在的显示器');
});

test('Windows 最大化记录（负坐标与边框微溢出）正确识别并还原为最大化目标', () => {
  const winDisplay = { availLeft: 0, availTop: 0, availWidth: 1536, availHeight: 912 };
  const target = resolveRestoreTarget({
    // 典型 Windows 最大化窗口特征：x: -6, y: 0, width: 1548, height: 918
    bounds: { x: -6, y: 0, width: 1548, height: 918 },
    display: winDisplay,
    fullscreen: false,
  }, winDisplay);
  assert.deepEqual(target, {
    x: 0,
    y: 0,
    width: 1536,
    height: 912,
    fullscreen: false,
    maximized: true,
  });
});

test('显式最大化记录还原为最大化目标', () => {
  const target = resolveRestoreTarget({
    bounds: { x: 0, y: 33, width: 1512, height: 949 },
    display: DISPLAY,
    fullscreen: false,
    maximized: true,
  }, DISPLAY);
  assert.deepEqual(target, {
    x: 0,
    y: 33,
    width: 1512,
    height: 949,
    fullscreen: false,
    maximized: true,
  });
});

test('尺寸超出显示器可用区域时收缩', () => {
  const target = resolveRestoreTarget({
    bounds: { x: 40, y: 60, width: 3000, height: 2000 },
    display: DISPLAY,
  }, DISPLAY);
  assert.equal(target.width, DISPLAY.availWidth);
  assert.equal(target.height, DISPLAY.availHeight);
  assert.equal(target.x, 40);
  assert.equal(target.y, 60);
});

test('记录位置略出界时拉回，保留可拖动标题栏', () => {
  const target = resolveRestoreTarget({
    bounds: { x: -900, y: -300, width: 1280, height: 840 },
    display: DISPLAY,
  }, DISPLAY);
  assert.equal(target.y, DISPLAY.availTop, '纵向不能压到菜单栏上方');
  assert.ok(target.x > -1280, '横向仍保持部分可见');
  assert.equal(target.x, -900, '仍与显示器有足够交集时不挪横向位置');
});

test('横向整块越界时退化到居中而不是留一条边', () => {
  const target = resolveRestoreTarget({
    bounds: { x: -2000, y: 120, width: 1280, height: 840 },
    display: DISPLAY,
  }, DISPLAY);
  assert.deepEqual(target, {
    x: Math.round((DISPLAY.availWidth - 1280) / 2),
    y: DISPLAY.availTop + Math.round((DISPLAY.availHeight - 840) / 2),
    width: 1280,
    height: 840,
    fullscreen: false,
    maximized: false,
  });
});

test('记录里的显示器已不存在时退化到当前显示器居中', () => {
  const target = resolveRestoreTarget({
    bounds: { x: 5000, y: 200, width: 1600, height: 1000 },
    display: { availLeft: -3000, availTop: 0, availWidth: 1600, availHeight: 1000 },
  }, DISPLAY);
  assert.deepEqual(target, {
    x: Math.round((DISPLAY.availWidth - DISPLAY.availWidth) / 2),
    y: DISPLAY.availTop + Math.round((DISPLAY.availHeight - DISPLAY.availHeight) / 2),
    width: DISPLAY.availWidth,
    height: DISPLAY.availHeight,
    fullscreen: false,
    maximized: false,
  }, '尺寸先收敛到当前显示器，再居中');
});

test('缺少记录显示器时使用当前显示器判定', () => {
  const target = resolveRestoreTarget({
    bounds: { x: 200, y: 150, width: 900, height: 700 },
    display: null,
  }, DISPLAY);
  assert.deepEqual(target, { x: 200, y: 150, width: 900, height: 700, fullscreen: false, maximized: false });
});

test('配置读写往返保留窗口记忆，脏数据在读取时被清洗', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-window-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  process.env.DSH_AU_CONFIG_PATH = join(dir, 'dsh-au.config.json');
  try {
    // 首次读取没有记录，默认关闭。
    assert.deepEqual(loadConfig().windowState, DEFAULT_WINDOW_STATE);

    const cfg = loadConfig();
    cfg.windowState = normalizeWindowState({
      enabled: true,
      geometry: { bounds: { x: 40, y: 60, width: 1200, height: 800 }, display: DISPLAY, fullscreen: false },
    });
    saveConfig(cfg);
    const reloaded = loadConfig();
    assert.equal(reloaded.windowState.enabled, true);
    assert.deepEqual(reloaded.windowState.geometry.bounds, { x: 40, y: 60, width: 1200, height: 800 });
    assert.deepEqual(reloaded.windowState.geometry.display, DISPLAY);

    // 手改配置文件塞进坏数据时，读取后必须回到安全状态。
    const dirty = loadConfig();
    dirty.windowState = { enabled: 'true', geometry: { bounds: { width: 0 } } };
    saveConfig(dirty);
    assert.deepEqual(loadConfig().windowState, DEFAULT_WINDOW_STATE);
  } finally {
    delete process.env.DSH_AU_CONFIG_PATH;
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isSameWindowGeometry 忽略 savedAt 并准确识别空值与实质几何变化', () => {
  const base = {
    bounds: { x: 100, y: 80, width: 1200, height: 800 },
    display: DISPLAY,
    fullscreen: false,
    maximized: false,
    savedAt: '2026-01-01T00:00:00.000Z',
  };

  // 空值与脏数据归一后均为 null
  assert.equal(isSameWindowGeometry(null, undefined), true);
  assert.equal(isSameWindowGeometry(null, { bounds: { width: 0 } }), true);
  assert.equal(isSameWindowGeometry(null, base), false);
  assert.equal(isSameWindowGeometry(base, null), false);

  // 仅 savedAt 不同（含归一化后一致的浮点坐标）应视为相同
  assert.equal(
    isSameWindowGeometry(base, {
      ...base,
      bounds: { x: 100.2, y: 79.8, width: 1200, height: 800 },
      savedAt: '2026-11-28T08:00:00.000Z',
    }),
    true,
  );

  // 坐标、尺寸、显示器、全屏、最大化任意一项变更均应返回 false
  assert.equal(isSameWindowGeometry(base, { ...base, bounds: { ...base.bounds, x: 101 } }), false);
  assert.equal(isSameWindowGeometry(base, { ...base, bounds: { ...base.bounds, y: 81 } }), false);
  assert.equal(isSameWindowGeometry(base, { ...base, bounds: { ...base.bounds, width: 1201 } }), false);
  assert.equal(isSameWindowGeometry(base, { ...base, bounds: { ...base.bounds, height: 801 } }), false);
  assert.equal(isSameWindowGeometry(base, { ...base, display: SECOND_DISPLAY }), false);
  assert.equal(isSameWindowGeometry(base, { ...base, display: null }), false);
  assert.equal(isSameWindowGeometry(base, { ...base, fullscreen: true }), false);
  assert.equal(isSameWindowGeometry(base, { ...base, maximized: true }), false);
});

test('saveMachineSettingsBackup 重复写入仅 savedAt 不同或未变更内容时不刷写文件，真实变化时正常更新', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-machine-geom-'));
  const keys = [
    'DSH_AU_LOCAL_DIR',
    'DSH_AU_LOCAL_BINDINGS_PATH',
    'DSH_AU_MACHINES_DIR',
    'DSH_AU_LOCAL_POINTER_PATH',
    'DSH_AU_LOCAL_STATE_PATH',
  ];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  process.env.DSH_AU_LOCAL_DIR = join(dir, 'local');
  t.after(() => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const machineId = 'win-idempotent';
  writeActivePointer(machineId);

  const initialGeom = {
    bounds: { x: 120, y: 80, width: 1280, height: 840 },
    display: DISPLAY,
    fullscreen: false,
    maximized: false,
    savedAt: '2026-01-01T00:00:00.000Z',
  };
  const first = saveMachineSettingsBackup({
    windowGeometry: initialGeom,
    disconnectRemotesOnLock: false,
  }, machineId);
  assert.equal(first.ok, true);

  // 固定一个旧 updatedAt 在磁盘上，确保后续同毫秒执行也能明确验证未发生覆写
  const filePath = machineFilePath(machineId);
  const pinned = JSON.parse(readFileSync(filePath, 'utf8'));
  pinned.updatedAt = '2020-01-01T00:00:00.000Z';
  const pinnedRaw = `${JSON.stringify(pinned, null, 2)}\n`;
  writeFileSync(filePath, pinnedRaw, 'utf8');

  // 1. 仅 windowGeometry.savedAt 变化：不写盘，不刷新 updatedAt 与 savedAt
  const sameGeomNewTs = saveMachineSettingsBackup({
    windowGeometry: { ...initialGeom, savedAt: '2026-11-28T12:00:00.000Z' },
  }, machineId);
  assert.equal(sameGeomNewTs.ok, true);
  assert.equal(readFileSync(filePath, 'utf8'), pinnedRaw);
  assert.equal(sameGeomNewTs.payload.updatedAt, '2020-01-01T00:00:00.000Z');
  assert.equal(sameGeomNewTs.payload.windowGeometry.savedAt, '2026-01-01T00:00:00.000Z');

  // 2. 传入其他未变更字段：同样跳过写盘
  const sameFlag = saveMachineSettingsBackup({ disconnectRemotesOnLock: false }, machineId);
  assert.equal(sameFlag.ok, true);
  assert.equal(readFileSync(filePath, 'utf8'), pinnedRaw);

  // 3. 发生真实窗口尺寸变化：正常写盘并刷新 updatedAt 与 windowGeometry.savedAt
  const movedGeom = {
    ...initialGeom,
    bounds: { ...initialGeom.bounds, width: 1360 },
    savedAt: '2026-11-28T12:05:00.000Z',
  };
  const updated = saveMachineSettingsBackup({ windowGeometry: movedGeom }, machineId);
  assert.equal(updated.ok, true);
  const after = JSON.parse(readFileSync(filePath, 'utf8'));
  assert.equal(after.windowGeometry.bounds.width, 1360);
  assert.equal(after.windowGeometry.savedAt, '2026-11-28T12:05:00.000Z');
  assert.notEqual(after.updatedAt, '2020-01-01T00:00:00.000Z');
});
