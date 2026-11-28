import { spawnSync } from 'node:child_process';
import process from 'node:process';

/**
 * DSH 桌面窗口几何状态的校验与还原目标计算。
 *
 * 渲染进程只能读写 `window.screenX/outerWidth` 这类 DIP 坐标，Electron 的窗口
 * 定位同样按 DIP 处理，所以这里统一使用整数 DIP，并假设原点在主显示器左上角。
 * 所有外部输入（手改配置、旧版本数据、异常上报）都必须经过归一化，避免把窗口
 * 还原到屏幕外或缩成看不见的尺寸。
 */

/** 无记录时的默认状态：默认关闭，未开启前不改变任何窗口行为。 */
export const DEFAULT_WINDOW_STATE = Object.freeze({ enabled: false, geometry: null });

/** 尺寸与坐标护栏；上限只防异常数据，不作为真实屏幕判断依据。 */
const MIN_WIDTH = 320;
const MIN_HEIGHT = 240;
const MAX_DIMENSION = 16384;
const MAX_COORDINATE = 100000;

/** 判定窗口落在显示器内的最小可见宽度/高度，保证标题栏始终可拖回。 */
const MIN_VISIBLE_WIDTH = 160;
const MIN_VISIBLE_HEIGHT = 120;

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/** 归一化窗口位置与大小；任一字段非法或尺寸非正即视为无效记录。 */
function normalizeBounds(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const values = [Number(raw.x), Number(raw.y), Number(raw.width), Number(raw.height)];
  if (!values.every(isFiniteNumber)) return null;
  const [x, y, width, height] = values;
  // 宽高为 0/负数只可能是脏数据，不能靠护栏"修好"，直接作废整条记录。
  if (width <= 0 || height <= 0) return null;
  return {
    x: clamp(Math.round(x), -MAX_COORDINATE, MAX_COORDINATE),
    y: clamp(Math.round(y), -MAX_COORDINATE, MAX_COORDINATE),
    width: clamp(Math.round(width), MIN_WIDTH, MAX_DIMENSION),
    height: clamp(Math.round(height), MIN_HEIGHT, MAX_DIMENSION),
  };
}

/** 归一化显示器可用区域（不含菜单栏/任务栏）。 */
function normalizeDisplay(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const values = [Number(raw.availLeft), Number(raw.availTop), Number(raw.availWidth), Number(raw.availHeight)];
  if (!values.every(isFiniteNumber)) return null;
  const [availLeft, availTop, availWidth, availHeight] = values;
  if (availWidth <= 0 || availHeight <= 0) return null;
  return {
    availLeft: clamp(Math.round(availLeft), -MAX_COORDINATE, MAX_COORDINATE),
    availTop: clamp(Math.round(availTop), -MAX_COORDINATE, MAX_COORDINATE),
    availWidth: clamp(Math.round(availWidth), MIN_WIDTH, MAX_DIMENSION),
    availHeight: clamp(Math.round(availHeight), MIN_HEIGHT, MAX_DIMENSION),
  };
}

/**
 * 归一化一条几何记录：窗口边界 + 所在显示器 + 是否全屏 + 记录时间。
 * 缺少合法的 bounds 时整条记录作废，避免用半个有效值去挪窗口。
 */
export function normalizeWindowGeometry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const bounds = normalizeBounds(raw.bounds);
  if (!bounds) return null;
  const display = normalizeDisplay(raw.display);
  const savedAt = typeof raw.savedAt === 'string' && !Number.isNaN(Date.parse(raw.savedAt))
    ? new Date(raw.savedAt).toISOString()
    : new Date().toISOString();
  const fullscreen = raw.fullscreen === true;
  // 最大化判断：
  // 1. 显式标记为 true 且不是全屏；
  // 2. 或未带标记时（向下兼容旧数据），满足 Windows 最大化边框微溢出特征
  const isWindowsMaximizedBounds = Boolean(
    display
      && bounds.x <= display.availLeft
      && bounds.y <= display.availTop
      && bounds.width >= display.availWidth - 4
      && bounds.width <= display.availWidth + 32
      && bounds.height >= display.availHeight - 4
      && bounds.height <= display.availHeight + 32
  );
  const maximized = !fullscreen && (raw.maximized === true || (raw.maximized === undefined && isWindowsMaximizedBounds));
  return {
    bounds,
    display,
    fullscreen,
    maximized,
    savedAt,
  };
}

/** 归一化持久化状态；只接受布尔开关，其余一律回落到关闭。 */
export function normalizeWindowState(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: source.enabled === true,
    geometry: normalizeWindowGeometry(source.geometry),
  };
}

/**
 * 比较两条窗口几何记录是否在忽略 savedAt 后实质一致：
 * 都为空返回 true，仅一方为空返回 false；均有效时比对归一化后的 bounds、display、fullscreen、maximized。
 */
export function isSameWindowGeometry(a, b) {
  const normA = normalizeWindowGeometry(a);
  const normB = normalizeWindowGeometry(b);
  if (!normA && !normB) return true;
  if (!normA || !normB) return false;
  if (normA.fullscreen !== normB.fullscreen || normA.maximized !== normB.maximized) return false;
  if (
    normA.bounds.x !== normB.bounds.x
    || normA.bounds.y !== normB.bounds.y
    || normA.bounds.width !== normB.bounds.width
    || normA.bounds.height !== normB.bounds.height
  ) {
    return false;
  }
  if (!normA.display && !normB.display) return true;
  if (!normA.display || !normB.display) return false;
  return (
    normA.display.availLeft === normB.display.availLeft
    && normA.display.availTop === normB.display.availTop
    && normA.display.availWidth === normB.display.availWidth
    && normA.display.availHeight === normB.display.availHeight
  );
}

/** 窗口与显示器是否有足够可见交集，避免还原到已拔掉的显示器上。 */
function hasVisibleOverlap(bounds, display) {
  const overlapWidth = Math.min(bounds.x + bounds.width, display.availLeft + display.availWidth)
    - Math.max(bounds.x, display.availLeft);
  const overlapHeight = Math.min(bounds.y + bounds.height, display.availTop + display.availHeight)
    - Math.max(bounds.y, display.availTop);
  return overlapWidth >= MIN_VISIBLE_WIDTH && overlapHeight >= MIN_VISIBLE_HEIGHT;
}

/** 在当前显示器居中，尺寸先收敛到该显示器可用区域。 */
function centerOn(display, width, height) {
  const fittedWidth = Math.min(width, display.availWidth);
  const fittedHeight = Math.min(height, display.availHeight);
  return {
    x: display.availLeft + Math.round((display.availWidth - fittedWidth) / 2),
    y: display.availTop + Math.round((display.availHeight - fittedHeight) / 2),
    width: fittedWidth,
    height: fittedHeight,
    fullscreen: false,
    maximized: false,
  };
}

/**
 * 计算启动时的还原目标。
 *
 * 规则：
 * 1. 记录为全屏 → 铺满记录时所在显示器（原生全屏无法从渲染进程触发，见 README/说明）。
 * 2. 记录为最大化 → 铺满该显示器工作区并标记 maximized，由宿主优先触发系统原生最大化。
 * 3. 记录为普通窗口 → 保留原位置，但把越界部分拉回显示器，尺寸不超出可用区域。
 * 4. 记录里的显示器已不存在 → 退化到当前显示器居中，尺寸按当前显示器收敛。
 *
 * @param {unknown} geometry 已持久化的几何记录。
 * @param {unknown} currentDisplay 渲染进程当前读到的显示器可用区域。
 * @returns {{x:number,y:number,width:number,height:number,fullscreen:boolean,maximized:boolean}|null}
 */
export function resolveRestoreTarget(geometry, currentDisplay) {
  const stored = normalizeWindowGeometry(geometry);
  if (!stored) return null;
  const current = normalizeDisplay(currentDisplay);
  const targetDisplay = stored.display || current;
  if (!targetDisplay) return null;

  if (stored.fullscreen) {
    return {
      x: targetDisplay.availLeft,
      y: targetDisplay.availTop,
      width: targetDisplay.availWidth,
      height: targetDisplay.availHeight,
      fullscreen: true,
      maximized: false,
    };
  }

  if (!hasVisibleOverlap(stored.bounds, targetDisplay)) {
    return centerOn(current || targetDisplay, stored.bounds.width, stored.bounds.height);
  }

  if (stored.maximized) {
    return {
      x: targetDisplay.availLeft,
      y: targetDisplay.availTop,
      width: targetDisplay.availWidth,
      height: targetDisplay.availHeight,
      fullscreen: false,
      maximized: true,
    };
  }

  return {
    // 位置直接沿用记录：能通过可见性判定就说明它与显示器有足够交集；
    // 只有纵向要压回可用区域顶部，避免标题栏被菜单栏/任务栏盖住。
    x: stored.bounds.x,
    y: Math.max(stored.bounds.y, targetDisplay.availTop),
    width: Math.min(stored.bounds.width, targetDisplay.availWidth),
    height: Math.min(stored.bounds.height, targetDisplay.availHeight),
    fullscreen: false,
    maximized: false,
  };
}

/**
 * 在 Windows 上优先调用系统原生 API 将 DSH 桌面窗口最大化。
 * 使用 ShowWindowAsync(SW_MAXIMIZE)，零阻塞、无窗口闪烁。
 */
export function maximizeWindowsAppWindow() {
  if (process.platform !== 'win32') return false;
  const psCmd = `
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class DshWinHelper { [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c); };' -ErrorAction SilentlyContinue;
$p = Get-Process | Where-Object { $_.ProcessName -like "*DSH*" -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1;
if ($p) { [DshWinHelper]::ShowWindowAsync($p.MainWindowHandle, 3) }
`.trim();
  try {
    const result = spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle', 'Hidden',
      '-Command', psCmd,
    ], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 3000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}
