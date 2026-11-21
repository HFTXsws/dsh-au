/**
 * 调用宿主 `ctx.connection.requestRejection(req)` 做 Host/Origin 与浏览器会话校验。
 * - 当宿主挂载了 connection 服务时，返回 401 / 403 / undefined。
 * - 当测试等无 connection 服务的极简环境运行时，返回 undefined。
 */
export function getConnectionRejection(ctx, req) {
  const conn = (typeof ctx?.get === 'function' ? ctx.get('connection') : undefined) || ctx?.connection;
  if (typeof conn?.requestRejection !== 'function') return undefined;
  return conn.requestRejection(req);
}
