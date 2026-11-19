import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 每个测试文件在独立子进程运行；把诊断日志重定向到临时文件，避免污染真实 ~/.dsh/logs。
const tempDir = mkdtempSync(join(tmpdir(), 'dsh-au-netlog-'));
process.env.DSH_AU_NET_LOG = join(tempDir, 'net.jsonl');

const { logNet, readNetLog, sanitizePath, sanitizeUrl } = await import('../lib/net-log.js');
const { createLanBridge } = await import('../lib/lan-bridge.js');
const { createRemoteProxyPool } = await import('../lib/remote-proxy-pool.js');

const readEvents = () => readNetLog().map((line) => JSON.parse(line));
const clearLog = () => rmSync(process.env.DSH_AU_NET_LOG, { force: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test.after(() => rmSync(tempDir, { recursive: true, force: true }));

test('net-log strips credentials and query strings', () => {
  assert.equal(sanitizeUrl('https://user:secret@dsh-mac.example.com:8443/dsh/?token=abc'), 'https://dsh-mac.example.com:8443/dsh/');
  assert.equal(sanitizePath('/?token=launch_xyz'), '/');
  clearLog();
  logNet('unit', { a: 1 });
  const [event] = readEvents();
  assert.equal(event.event, 'unit');
  assert.equal(event.a, 1);
  assert.ok(event.ts);
});

test('lan-bridge logs aborted upstream requests but stays silent on fast ones', async () => {
  const mockLocalDsh = http.createServer((req, res) => {
    if (req.url.startsWith('/hang')) return; // 模拟本机 DSH 卡住：永不响应（带 query 也命中）
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise((resolve) => mockLocalDsh.listen(0, '127.0.0.1', resolve));
  const dshPort = mockLocalDsh.address().port;
  const bridge = createLanBridge({
    instanceId: 'au_netlog',
    preferredPort: 33990,
    getLanShareEnabled: () => true,
    getLocalDshTarget: () => ({ origin: `http://127.0.0.1:${dshPort}`, authUrl: `http://127.0.0.1:${dshPort}/?token=t` }),
    getStatus: () => ({ status: 'idle', runningCount: 0 }),
  });
  const bridgePort = await bridge.start();
  try {
    clearLog();
    await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${bridgePort}/fast`, { agent: false }, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject);
    });
    await sleep(50);
    assert.equal(readEvents().length, 0, '快速正常请求不应写日志');

    // 调用方 300ms 后放弃，等价于对端探测超时。
    // agent:false 避免复用上一条 keep-alive 连接导致请求排队、根本没到达桥接层。
    const req = http.get(`http://127.0.0.1:${bridgePort}/hang?token=secret`, { agent: false });
    req.on('error', () => {});
    await sleep(300);
    req.destroy();
    await sleep(100);
    const aborted = readEvents().find((event) => event.event === 'bridge.aborted');
    assert.ok(aborted, '卡住后被放弃的请求应记录 bridge.aborted');
    assert.equal(aborted.stage, 'upstream');
    assert.equal(aborted.path, '/hang');
    assert.ok(aborted.bootstrapMs >= 0);
  } finally {
    bridge.stop();
    mockLocalDsh.closeAllConnections?.();
    mockLocalDsh.close();
  }
});

test('probeAll logs state change once and throttles repeated failures', async () => {
  const pool = createRemoteProxyPool();
  const remote = { id: 'r_dead', deviceId: 'example-mac', transport: 'tunnel', url: 'http://user:pw@127.0.0.1:1/', username: 'user', password: 'pw' };
  try {
    clearLog();
    await pool.probeAll([remote]);
    await pool.probeAll([remote]);
    // 只统计探测事件，排除上一个用例遗留的桥接事件。
    const events = readEvents().filter((event) => event.event.startsWith('probe.'));
    assert.equal(events.length, 1, '同一失败状态在节流窗口内只记一次');
    const [event] = events;
    assert.equal(event.event, 'probe.change');
    assert.equal(event.to, 'offline');
    assert.equal(event.stage, 'home');
    assert.ok(event.errorCode, '应记录底层错误码');
    assert.equal(event.url, 'http://127.0.0.1:1/');
    assert.doesNotMatch(JSON.stringify(event), /pw|user:/);
  } finally {
    pool.stopAll();
  }
});
