import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// 局域网接入密码：本机配置只保存 scrypt 加盐哈希，格式 `scrypt$<saltHex>$<hashHex>`。
const KEY_LEN = 32;
export const LAN_PASSWORD_MIN_LENGTH = 4;

/** 生成密码哈希；明文不落盘。 */
export function hashLanPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, KEY_LEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** 校验明文是否匹配已保存哈希；格式损坏一律视为不匹配。 */
export function verifyLanPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  try {
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
    return expected.length === KEY_LEN && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** 只认格式正确的哈希，脏数据按“未设置密码”处理。 */
export function normalizeLanPasswordHash(value) {
  return typeof value === 'string' && /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(value) ? value : '';
}

/** 从 Authorization: Basic 头取出密码；账号部分忽略，访问方可随意填写。 */
export function readBasicAuthPassword(header) {
  const match = /^Basic\s+(.+)$/i.exec(String(header || '').trim());
  if (!match) return null;
  let decoded = '';
  try { decoded = Buffer.from(match[1], 'base64').toString('utf8'); } catch { return null; }
  const sep = decoded.indexOf(':');
  return sep >= 0 ? decoded.slice(sep + 1) : null;
}

/**
 * 按来源 IP 计数的失败限速：连续失败 MAX_FAILURES 次后锁定 LOCK_MS，防止局域网内暴力猜密码。
 * 成功一次即清零。
 */
export function createLanAuthLimiter({ maxFailures = 5, lockMs = 60_000, now = () => Date.now() } = {}) {
  const records = new Map();
  return {
    isLocked(ip) {
      const rec = records.get(ip);
      if (!rec || !rec.lockedUntil) return false;
      if (rec.lockedUntil > now()) return true;
      records.delete(ip);
      return false;
    },
    fail(ip) {
      const rec = records.get(ip) || { count: 0, lockedUntil: 0 };
      rec.count += 1;
      if (rec.count >= maxFailures) { rec.lockedUntil = now() + lockMs; rec.count = 0; }
      records.set(ip, rec);
    },
    succeed(ip) { records.delete(ip); },
  };
}
