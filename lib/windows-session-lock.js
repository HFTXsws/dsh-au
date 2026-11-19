import { spawn } from 'node:child_process';

/**
 * 宿主进程是 Electron 以 Node 方式拉起的，拿不到 powerMonitor。
 * 启动时读一次会话标志，之后向 Windows 注册锁屏通知，用 GetMessage 堵住等。
 * 标志偏移按 64 位进程实测：Level 后有 4 字节对齐，标志在第 16 字节。0 锁屏，1 未锁屏。
 */
const SESSION_LOCK_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class DshAuSessionLock {
  const int WM_WTSSESSION_CHANGE = 0x02B1;
  const int WTS_SESSION_LOCK = 0x7;
  const int WTS_SESSION_UNLOCK = 0x8;

  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate IntPtr WndProcDelegate(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  static WndProcDelegate procKeepAlive;

  [StructLayout(LayoutKind.Sequential)]
  struct POINT { public int x; public int y; }

  [StructLayout(LayoutKind.Sequential)]
  struct MSG {
    public IntPtr hwnd;
    public uint message;
    public IntPtr wParam;
    public IntPtr lParam;
    public uint time;
    public POINT pt;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct WNDCLASS {
    public uint style;
    public WndProcDelegate lpfnWndProc;
    public int cbClsExtra;
    public int cbWndExtra;
    public IntPtr hInstance;
    public IntPtr hIcon;
    public IntPtr hCursor;
    public IntPtr hbrBackground;
    public string lpszMenuName;
    public string lpszClassName;
  }

  [DllImport("wtsapi32.dll", SetLastError = true)]
  static extern bool WTSQuerySessionInformation(IntPtr hServer, int sessionId, int wtsInfoClass, out IntPtr ppBuffer, out int pBytesReturned);
  [DllImport("wtsapi32.dll")]
  static extern void WTSFreeMemory(IntPtr pMemory);
  [DllImport("wtsapi32.dll", SetLastError = true)]
  static extern bool WTSRegisterSessionNotification(IntPtr hWnd, int dwFlags);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "RegisterClassW")]
  static extern ushort RegisterClass(ref WNDCLASS lpWndClass);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CreateWindowExW")]
  static extern IntPtr CreateWindowEx(int dwExStyle, string lpClassName, string lpWindowName, int dwStyle, int x, int y, int nWidth, int nHeight, IntPtr hWndParent, IntPtr hMenu, IntPtr hInstance, IntPtr lpParam);
  [DllImport("user32.dll")]
  static extern IntPtr DefWindowProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)]
  static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
  [DllImport("user32.dll")]
  static extern bool TranslateMessage(ref MSG lpMsg);
  [DllImport("user32.dll")]
  static extern IntPtr DispatchMessage(ref MSG lpMsg);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr GetModuleHandle(string lpModuleName);

  public static int ReadSessionFlags() {
    IntPtr buffer;
    int bytes;
    if (!WTSQuerySessionInformation(IntPtr.Zero, -1, 25, out buffer, out bytes) || buffer == IntPtr.Zero) return -1;
    try {
      int offset = IntPtr.Size == 8 ? 16 : 12;
      if (bytes < offset + 4) return -1;
      return Marshal.ReadInt32(buffer, offset);
    } finally {
      WTSFreeMemory(buffer);
    }
  }

  static IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam) {
    if (msg == WM_WTSSESSION_CHANGE) {
      int code = wParam.ToInt32();
      if (code == WTS_SESSION_LOCK || code == WTS_SESSION_UNLOCK) {
        Console.Out.WriteLine(code == WTS_SESSION_LOCK ? "locked" : "unlocked");
        Console.Out.Flush();
      }
      return IntPtr.Zero;
    }
    return DefWindowProc(hWnd, msg, wParam, lParam);
  }

  public static void Run() {
    procKeepAlive = WndProc;
    WNDCLASS wc = new WNDCLASS();
    wc.lpfnWndProc = procKeepAlive;
    wc.hInstance = GetModuleHandle(null);
    wc.lpszClassName = "DshAuSessionLockWnd";
    if (RegisterClass(ref wc) == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
    IntPtr hwnd = CreateWindowEx(0, wc.lpszClassName, "", 0, 0, 0, 0, 0, new IntPtr(-3), IntPtr.Zero, wc.hInstance, IntPtr.Zero);
    if (hwnd == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    if (!WTSRegisterSessionNotification(hwnd, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    MSG msg;
    int rc;
    while ((rc = GetMessage(out msg, hwnd, 0, 0)) > 0) {
      TranslateMessage(ref msg);
      DispatchMessage(ref msg);
    }
    if (rc < 0) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
}
"@
  $flag = [DshAuSessionLock]::ReadSessionFlags()
  if ($flag -eq 0) { [Console]::Out.WriteLine('locked') }
  elseif ($flag -eq 1) { [Console]::Out.WriteLine('unlocked') }
  else { [Console]::Out.WriteLine('watcher-error session-flag ' + $flag) }
  [Console]::Out.Flush()
  if ($flag -eq 0 -or $flag -eq 1) { [DshAuSessionLock]::Run() }
} catch {
  [Console]::Out.WriteLine('watcher-error ' + $_.Exception.Message)
  [Console]::Out.Flush()
  exit 1
}
`;

export function parseSessionLockLine(line) {
  const text = String(line || '').replace(/^\uFEFF/, '').trim();
  if (text === 'locked') return true;
  if (text === 'unlocked') return false;
  return null;
}

function encodePowerShellCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * 先报一次当前锁屏状态，之后只在 Windows 锁屏通知到来时再报。
 * keepAlive 只给测试用：生产环境放开句柄，避免挡住宿主退出。
 */
export function startWindowsSessionLockWatcher({ onLockChange, onError, keepAlive = false } = {}) {
  let stopped = false;
  let child = null;
  let lastPid = null;
  let restartTimer = null;
  let buffer = '';

  const scheduleRestart = () => {
    if (stopped || restartTimer) return;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      launch();
    }, 2000);
    if (!keepAlive) restartTimer.unref?.();
  };

  const consume = (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const locked = parseSessionLockLine(line);
      if (locked !== null) onLockChange?.(locked);
      else if (line.trim()) onError?.(new Error(line.trim()));
      newline = buffer.indexOf('\n');
    }
  };

  const launch = () => {
    if (stopped) return;
    child = spawn('powershell.exe', [
      '-STA',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encodePowerShellCommand(SESSION_LOCK_SCRIPT),
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    lastPid = child.pid;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', consume);
    child.on('error', (err) => {
      onError?.(err);
      scheduleRestart();
    });
    child.on('exit', () => {
      child = null;
      scheduleRestart();
    });
    if (!keepAlive) child.unref?.();
  };

  launch();
  return {
    get pid() { return child?.pid ?? lastPid; },
    stop() {
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      if (child) child.kill();
      child = null;
    },
  };
}
