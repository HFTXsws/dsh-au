import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ClientControlError } from './errors.js';

const DEFAULT_LOCK_TIMEOUT_MS = 600_000;
const LOCK_POLL_MS = 25;
const INVALID_LOCK_GRACE_MS = 30_000;

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function privateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { chmodSync(directory, 0o700); } catch {}
}

function privateAtomicWrite(filePath, value) {
  privateDirectory(dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = openSync(temporary, 'wx', 0o600);
    writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
    renameSync(temporary, filePath);
    try { chmodSync(filePath, 0o600); } catch {}
  } finally {
    if (handle !== undefined) closeSync(handle);
    rmSync(temporary, { force: true });
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function removeStaleLock(lockPath) {
  let raw = '';
  let ageMs = 0;
  try {
    raw = readFileSync(lockPath, 'utf8');
    ageMs = Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return !existsSync(lockPath);
  }

  let owner;
  try { owner = JSON.parse(raw); } catch {}
  if (processIsAlive(owner?.pid)) return false;
  if (!Number.isSafeInteger(owner?.pid) && ageMs < INVALID_LOCK_GRACE_MS) return false;

  // Compare the exact lock body before removal so a replaced owner is never deleted.
  try {
    if (readFileSync(lockPath, 'utf8') !== raw) return false;
    rmSync(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

function releaseOwnedLock(lockPath, token) {
  try {
    const owner = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (owner?.token === token) rmSync(lockPath, { force: true });
  } catch {}
}

async function acquireLock(lockPath, timeoutMs) {
  privateDirectory(dirname(lockPath));
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let handle;
    try {
      handle = openSync(lockPath, 'wx', 0o600);
      writeFileSync(handle, `${JSON.stringify({ pid: process.pid, token })}\n`, 'utf8');
      fsyncSync(handle);
      closeSync(handle);
      handle = undefined;
      try { chmodSync(lockPath, 0o600); } catch {}
      return () => releaseOwnedLock(lockPath, token);
    } catch (error) {
      if (handle !== undefined) closeSync(handle);
      if (error?.code !== 'EEXIST') throw error;
      if (removeStaleLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new ClientControlError('Codex request is already running', {
          code: 'CONTROL_LOCKED',
          cause: error,
        });
      }
      await new Promise((done) => setTimeout(done, LOCK_POLL_MS));
    }
  }
}

export function codexRequestFingerprint({ sessionId = '', cwd = '', text = '' } = {}) {
  const digest = createHash('sha256');
  for (const value of [sessionId, cwd, text]) {
    const bytes = Buffer.from(String(value), 'utf8');
    digest.update(String(bytes.length));
    digest.update(':');
    digest.update(bytes);
    digest.update(';');
  }
  return digest.digest('hex');
}

export function defaultCodexRequestStateDirectory({
  homeDir = homedir(),
  dshHome = process.env.DSH_HOME || join(homeDir, '.dsh'),
} = {}) {
  return join(dshHome, 'dsh-au', 'client-control', 'codex-requests');
}

export function createCodexRequestStateStore({
  stateDir = defaultCodexRequestStateDirectory(),
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
} = {}) {
  const directory = resolve(stateDir);

  function pathFor(requestId) {
    return join(directory, `${hash(String(requestId))}.json`);
  }

  function load(requestId) {
    const filePath = pathFor(requestId);
    if (!existsSync(filePath)) return null;
    try {
      const state = JSON.parse(readFileSync(filePath, 'utf8'));
      if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('not an object');
      return state;
    } catch (cause) {
      throw new ClientControlError(`Cannot read Codex request state: ${filePath}`, {
        code: 'INVALID_STATE',
        cause,
      });
    }
  }

  function save(requestId, state) {
    privateAtomicWrite(pathFor(requestId), state);
  }

  async function withLock(requestId, run) {
    const lockPath = `${pathFor(requestId)}.lock`;
    const release = await acquireLock(lockPath, lockTimeoutMs);
    try {
      return await run();
    } finally {
      release();
    }
  }

  return { directory, pathFor, load, save, withLock };
}
