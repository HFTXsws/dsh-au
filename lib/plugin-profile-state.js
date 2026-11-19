import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const ownedLocks = new Map();
const FILES = ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml'];
const LOCK = '.dsh-plugin-sync.lock';
const RECOVERY = '.dsh-plugin-sync.recovery.json';

/** 所有入口按实际 Profile 串行变更；未知或遗留锁不擅自删除。 */
export function acquirePluginProfileLock(profileDir) {
  const root = path.resolve(profileDir);
  const existing = ownedLocks.get(root);
  if (existing) {
    existing.depth += 1;
    return () => release(root, existing);
  }
  const file = path.join(root, LOCK);
  const owner = { pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString(), depth: 1 };
  let fd;
  try {
    fd = openSync(file, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ pid: owner.pid, token: owner.token, startedAt: owner.startedAt }));
  } catch (error) {
    if (error.code === 'EEXIST') {
      const busy = new Error('该 DSH Profile 正在变更或存在中断遗留锁；请先运行插件 Doctor，不要重复安装');
      busy.code = 'PROFILE_BUSY';
      throw busy;
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  ownedLocks.set(root, owner);
  return () => release(root, owner);
}

function release(root, owner) {
  if (ownedLocks.get(root) !== owner) return;
  owner.depth -= 1;
  if (owner.depth > 0) return;
  const file = path.join(root, LOCK);
  try {
    const current = JSON.parse(readFileSync(file, 'utf8'));
    if (current.token === owner.token && current.pid === process.pid) unlinkSync(file);
  } finally {
    ownedLocks.delete(root);
  }
}

/** 同目录临时文件替换，避免半份 JSON/YAML；只允许明确的插件配置目标。 */
export function writePluginProfileText(profileDir, name, text) {
  if (![...FILES, RECOVERY].includes(name)) throw new Error('非法插件配置写入目标');
  const root = path.resolve(profileDir);
  const target = path.join(root, name);
  if (existsSync(target) && readFileSync(target, 'utf8') === text) return false;
  const temp = path.join(root, `.${name}.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  let created = false;
  try {
    fd = openSync(temp, 'wx', 0o600);
    created = true;
    writeFileSync(fd, text, 'utf8');
    closeSync(fd);
    fd = undefined;
    renameSync(temp, target);
  } finally {
    if (fd !== undefined) closeSync(fd);
    // 只有成功独占创建的临时文件才归本次调用所有，碰撞时不删除别人内容。
    if (created && existsSync(temp)) unlinkSync(temp);
  }
}

export function snapshotPluginProfile(profileDir) {
  return Object.fromEntries(FILES.map((name) => {
    const file = path.join(path.resolve(profileDir), name);
    return [name, existsSync(file) ? readFileSync(file, 'utf8') : null];
  }));
}

/** 仅恢复配置和锁文件；node_modules/store 的安装副作用必须单独报告。 */
export function restorePluginProfile(profileDir, snapshot) {
  for (const name of FILES) {
    const target = path.join(path.resolve(profileDir), name);
    if (snapshot[name] === null) {
      if (existsSync(target)) unlinkSync(target);
    } else if (!existsSync(target) || readFileSync(target, 'utf8') !== snapshot[name]) {
      writePluginProfileText(profileDir, name, snapshot[name]);
    }
  }
}

export function recordPluginRecovery(profileDir, state) {
  const target = path.join(path.resolve(profileDir), RECOVERY);
  if (!state) {
    if (existsSync(target)) unlinkSync(target);
    return;
  }
  writePluginProfileText(profileDir, RECOVERY, `${JSON.stringify({ schemaVersion: 1, pid: process.pid, at: new Date().toISOString(), ...state }, null, 2)}\n`);
}

/** Doctor 只读运行态，不删除锁、不修依赖、不加载含凭据的配置内容。 */
export function readPluginProfileState(profileDir) {
  const root = path.resolve(profileDir);
  const read = (name) => {
    try { return JSON.parse(readFileSync(path.join(root, name), 'utf8')); }
    catch (error) { return error.code === 'ENOENT' ? null : { invalid: true }; }
  };
  const lock = read(LOCK);
  let lockAlive = false;
  if (Number.isSafeInteger(lock?.pid) && lock.pid > 0) {
    try { process.kill(lock.pid, 0); lockAlive = true; }
    catch (error) { lockAlive = error.code === 'EPERM'; }
  }
  const recovery = read(RECOVERY);
  return { lock: lock ? { pid: lock.pid, startedAt: lock.startedAt, invalid: Boolean(lock.invalid), alive: lockAlive } : null,
    recovery: recovery ? { status: recovery.status, code: recovery.code, at: recovery.at, pid: recovery.pid,
      pluginId: typeof recovery.pluginId === 'string' ? recovery.pluginId : undefined,
      failedPluginIds: Array.isArray(recovery.failedPluginIds) ? recovery.failedPluginIds.filter((id) => typeof id === 'string') : undefined,
      configRestored: Boolean(recovery.configRestored), invalid: Boolean(recovery.invalid) } : null };
}
