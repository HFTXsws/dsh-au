import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'dsh-au-lock-remote-'));
process.env.DSH_AU_NET_LOG = join(tempDir, 'net.jsonl');
test.after(() => rmSync(tempDir, { recursive: true, force: true }));

const { createRemoteProxyPool } = await import('../lib/remote-proxy-pool.js');
const { applyScreenLockRemoteConnections } = await import('../lib/screen-lock-remotes.js');
const { parseSessionLockLine, startWindowsSessionLockWatcher } = await import('../lib/windows-session-lock.js');

const remote = {
  id: 'r_lock',
  deviceId: 'example-mac',
  transport: 'tunnel',
  url: 'http://127.0.0.1:1/',
  username: '',
  password: '',
};

function loadFramePlanner() {
  const source = readFileSync(new URL('../client/src/11-shell.js', import.meta.url), 'utf8');
  const start = source.indexOf('function planScreenLockRemoteFrames');
  const end = source.indexOf('// END planScreenLockRemoteFrames');
  assert.ok(start >= 0 && end > start, '壳层应包含锁屏页面决策');
  return new Function(`${source.slice(start, end)}\nreturn planScreenLockRemoteFrames;`)();
}

function portOpen(url) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      resolve(open);
    };
    const req = http.get(url, { agent: false, timeout: 800 }, (res) => {
      res.resume();
      finish(true);
    });
    req.on('timeout', () => {
      req.destroy();
      finish(true);
    });
    req.on('error', () => finish(false));
  });
}

test('开关关闭时锁屏保留已经连上的远程代理', async () => {
  const pool = createRemoteProxyPool();
  try {
    await pool.probeAll([remote]);
    const before = (await pool.syncRemotes([remote]))[0];
    assert.match(before.proxyUrl, /^http:\/\/127\.0\.0\.1:\d+/);
    assert.equal(await portOpen(before.proxyUrl), true);
    assert.equal(applyScreenLockRemoteConnections({
      locked: true,
      enabled: false,
      pool,
      probe: () => { throw new Error('开关关闭不应重探'); },
    }), 'unchanged');
    const after = (await pool.syncRemotes([remote]))[0];
    assert.equal(after.proxyUrl, before.proxyUrl);
    assert.equal(await portOpen(after.proxyUrl), true);
  } finally {
    pool.stopAll();
  }
});

test('开关打开时锁屏关掉远程代理，锁屏期间不重连，解锁后重新连上', async () => {
  const pool = createRemoteProxyPool();
  try {
    await pool.probeAll([remote]);
    const before = (await pool.syncRemotes([remote]))[0].proxyUrl;
    assert.equal(applyScreenLockRemoteConnections({ locked: true, enabled: true, pool }), 'suspended');
    assert.equal(pool.isConnectionsSuspended(), true);
    assert.equal(await portOpen(before), false);
    await pool.probeAll([remote]);
    assert.equal((await pool.syncRemotes([remote]))[0].proxyUrl, '');
    let restore = null;
    assert.equal(applyScreenLockRemoteConnections({
      locked: false,
      enabled: true,
      pool,
      probe: () => { restore = pool.probeAll([remote]); },
    }), 'resumed');
    await restore;
    const after = (await pool.syncRemotes([remote]))[0].proxyUrl;
    assert.match(after, /^http:\/\/127\.0\.0\.1:\d+/);
    assert.notEqual(after, before);
    assert.equal(await portOpen(after), true);
    assert.equal(pool.isConnectionsSuspended(), false);
  } finally {
    pool.stopAll();
  }
});

test('锁屏先记住已打开页面，解锁后只恢复已经重新连上的页面', () => {
  const plan = loadFramePlanner();
  const base = {
    enabled: true,
    wasEnabled: true,
    openedIds: ['win', 'mac'],
    activeId: 'win',
    readyIds: [],
    liveIds: ['win', 'mac'],
    suspended: null,
  };
  assert.deepEqual(plan({ ...base, enabled: false, wasLocked: false, isLocked: true }).mode, 'keep');
  assert.equal(plan({ ...base, enabled: false, wasLocked: false, isLocked: true, suspended: { ids: ['win'], pending: true } }).suspended, null);

  const locked = plan({ ...base, wasLocked: false, isLocked: true });
  assert.equal(locked.mode, 'suspend');
  assert.deepEqual(locked.suspended.ids, ['win', 'mac']);
  assert.equal(locked.suspended.activeId, 'win');

  const waiting = plan({
    ...base,
    wasLocked: true,
    isLocked: false,
    openedIds: [],
    activeId: null,
    suspended: locked.suspended,
  });
  assert.equal(waiting.mode, 'wait');
  assert.deepEqual(waiting.suspended.ids, ['win', 'mac']);

  const partial = plan({
    ...base,
    wasLocked: true,
    isLocked: false,
    openedIds: [],
    readyIds: ['mac'],
    suspended: waiting.suspended,
  });
  assert.equal(partial.mode, 'restore');
  assert.deepEqual(partial.ids, ['mac']);
  assert.equal(partial.activeId, null);
  assert.deepEqual(partial.suspended.ids, ['win']);

  const gone = plan({
    ...base,
    wasLocked: true,
    isLocked: false,
    readyIds: [],
    liveIds: ['mac'],
    suspended: { ids: ['gone'], activeId: null, pending: true },
  });
  assert.equal(gone.mode, 'keep');
  assert.equal(gone.suspended, null);

  const restored = plan({
    ...base,
    wasLocked: false,
    isLocked: false,
    readyIds: ['win'],
    suspended: partial.suspended,
  });
  assert.deepEqual(restored.ids, ['win']);
  assert.equal(restored.activeId, 'win');
  assert.equal(restored.suspended, null);
});

test('会话监视器只把 locked / unlocked 当成锁屏变化', () => {
  const cases = [
    ['locked', true],
    ['unlocked', false],
    ['locked\r', true],
    ['\uFEFFunlocked', false],
    ['watcher-error boom', null],
    ['', null],
  ];
  for (const [line, expected] of cases) {
    assert.equal(parseSessionLockLine(line), expected, line);
  }
});

function processCpuSeconds(pid) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).CPU`,
    ], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(Number(String(stdout).trim()));
    });
  });
}

// 跑这条时如果这台电脑正锁着，失败是对的：监视器应如实报告锁屏。
test('没锁屏时报告未锁屏，之后停在锁屏通知上且几乎不占 CPU', async () => {
  if (process.platform !== 'win32') return;
  let watcher;
  let failed = null;
  try {
    const locked = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('10 秒内没有读到会话锁状态')), 10000);
      watcher = startWindowsSessionLockWatcher({
        keepAlive: true,
        onLockChange(value) {
          clearTimeout(timer);
          resolve(value);
        },
        onError(err) {
          clearTimeout(timer);
          failed = err;
          reject(err);
        },
      });
    });
    assert.equal(locked, false);
    const pid = watcher.pid;
    const before = await processCpuSeconds(pid);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    if (failed) throw failed;
    process.kill(pid, 0);
    const after = await processCpuSeconds(pid);
    assert.ok(after - before < 0.25, `等待锁屏通知时 CPU ${after - before} 秒`);
  } finally {
    watcher?.stop();
  }
});
