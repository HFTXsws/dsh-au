/**
 * 锁屏期间要不要断开远程 DSH 连接。
 * 开关关闭，或当前没有因为锁屏而断开时，不碰连接池。
 */
export function applyScreenLockRemoteConnections({ locked, enabled, pool, probe } = {}) {
  const shouldDisconnect = locked === true && enabled === true;
  if (shouldDisconnect) {
    pool.suspendConnections();
    return 'suspended';
  }
  if (typeof pool.isConnectionsSuspended === 'function' && pool.isConnectionsSuspended()) {
    pool.resumeConnections();
    if (typeof probe === 'function') probe();
    return 'resumed';
  }
  return 'unchanged';
}
