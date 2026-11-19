import dgram from 'node:dgram';
import http from 'node:http';
import { getLocalHostInfo } from './config-store.js';

export const BEACON_MAGIC = 'DSH_AU_V1';
const LIGHTS_V2 = ['idle', 'busy', 'waiting', 'done', 'error'];
const PEER_TTL_MS = 18_000;
const BEACON_INTERVAL_MS = 4_500;

/** 计算本机各局域网网卡对应的 /24 广播地址与网段前缀 */
export function getBroadcastTargets(ips) {
  const targets = new Set(['255.255.255.255']);
  for (const ip of ips) {
    const parts = ip.split('.');
    if (parts.length === 4) {
      targets.add(`${parts[0]}.${parts[1]}.${parts[2]}.255`);
    }
  }
  return [...targets];
}

/** 通过 HTTP 探测指定 IP:port 是否运行了开启局域网共享的 dsh-au 桥接服务 */
export function probeLanBridge(ip, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: ip, port, path: '/__dsh_au_ping', timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            resolve(data && data.dshAu === true ? { ...data, ip, bridgePort: port } : null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

/**
 * 创建局域网设备自发现管理器：
 * 1. 当本机开启局域网被控 (lanShareEnabled) 且桥接端口就绪时，定时广播本机 hostname + bridgePort + 忙闲状态
 * 2. 监听其他设备的 UDP 广播包（自动过滤本机 instanceId），维护在线局域网电脑列表
 * 3. 支持触发子网快速扫描兜底（应对部分路由器隔离 UDP 广播）
 */
export function createLanDiscovery({ instanceId, udpPort, getBridgeState, getStatus, getDeviceId, onPeer }) {
  const peers = new Map();
  let socket = null;
  let timer = null;
  let scanning = false;

  function upsertPeer(info, remoteIp) {
    if (!info || info.instanceId === instanceId) return;
    const ip = info.ip || remoteIp;
    const bridgePort = Number(info.bridgePort);
    if (!ip || !Number.isInteger(bridgePort) || bridgePort <= 0) return;
    const key = `${info.instanceId || ip}:${bridgePort}`;
    const deviceId = typeof info.deviceId === 'string' ? info.deviceId.trim() : '';
    const peer = {
      id: `lan_${info.instanceId || ip.replace(/\./g, '_')}`,
      instanceId: info.instanceId || key,
      deviceId,
      name: String(info.hostname || ip),
      hostname: String(info.hostname || ip),
      ip,
      bridgePort,
      url: `http://${ip}:${bridgePort}/`,
      status: ['busy', 'done', 'error'].includes(info.status) ? info.status : 'idle',
      statusV2: LIGHTS_V2.includes(info.statusV2) ? info.statusV2 : undefined,
      runningCount: Number(info.runningCount) || 0,
      waitingCount: Number(info.waitingCount) || 0,
      lastSeen: Date.now(),
      kind: 'lan',
    };
    peers.set(key, peer);
    // 对端已绑定公共设备时，把探测到的局域网地址写回云清单，Mac/Windows 才能互相直连。
    if (deviceId) onPeer?.(peer);
  }

  function broadcastNow() {
    if (!socket) return;
    const bridge = getBridgeState();
    if (!bridge.enabled || !bridge.port) return;
    const { hostname, ips } = getLocalHostInfo();
    const { status, statusV2, runningCount, waitingCount } = getStatus();
    const payload = Buffer.from(JSON.stringify({
      magic: BEACON_MAGIC,
      instanceId,
      deviceId: getDeviceId?.() || '',
      hostname,
      bridgePort: bridge.port,
      status,
      statusV2,
      runningCount,
      waitingCount,
    }));
    for (const target of getBroadcastTargets(ips)) {
      socket.send(payload, 0, payload.length, udpPort, target, () => {});
    }
  }

  async function scanSubnet(targetPort) {
    if (scanning || !targetPort) return;
    scanning = true;
    try {
      const { ips } = getLocalHostInfo();
      const prefixes = [...new Set(ips.map((ip) => ip.split('.').slice(0, 3).join('.')))];
      for (const prefix of prefixes) {
        const batch = [];
        for (let i = 1; i <= 254; i += 1) {
          const ip = `${prefix}.${i}`;
          if (ips.includes(ip)) continue;
          batch.push(probeLanBridge(ip, targetPort, 700).then((hit) => { if (hit) upsertPeer(hit, ip); }));
          if (batch.length >= 48) { await Promise.all(batch); batch.length = 0; }
        }
        if (batch.length) await Promise.all(batch);
      }
    } finally {
      scanning = false;
    }
  }

  return {
    start() {
      if (socket) return;
      try {
        socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        socket.on('error', () => {});
        socket.on('message', (msg, rinfo) => {
          try {
            const data = JSON.parse(msg.toString('utf8'));
            if (data && data.magic === BEACON_MAGIC) upsertPeer(data, rinfo.address);
          } catch {}
        });
        socket.bind(udpPort, () => {
          try { socket.setBroadcast(true); } catch {}
          broadcastNow();
        });
      } catch {}
      timer = setInterval(broadcastNow, BEACON_INTERVAL_MS);
      timer.unref?.();
    },
    broadcastNow,
    scanSubnet,
    upsertPeer,
    listPeers() {
      const now = Date.now();
      for (const [k, v] of peers.entries()) {
        if (now - v.lastSeen > PEER_TTL_MS) peers.delete(k);
      }
      return [...peers.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
      if (socket) { try { socket.close(); } catch {} socket = null; }
    },
  };
}
