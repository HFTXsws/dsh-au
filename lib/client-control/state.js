import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ClientControlError, assertControl } from './errors.js'

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const INVALID_LOCK_STALE_MS = 5 * 60 * 1000

function ensurePrivateDirectory(directory) {
  if (process.platform === 'win32') {
    mkdirSync(directory, { recursive: true })
    return
  }
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  chmodSync(directory, PRIVATE_DIRECTORY_MODE)
}

function openPrivateFile(filePath, flags) {
  return process.platform === 'win32'
    ? openSync(filePath, flags)
    : openSync(filePath, flags, PRIVATE_FILE_MODE)
}

function securePrivateFile(filePath) {
  if (process.platform !== 'win32') chmodSync(filePath, PRIVATE_FILE_MODE)
}

export function defaultClientControlStateDirectory(homeDir = homedir()) {
  return join(process.env.DSH_HOME || join(homeDir, '.dsh'), 'dsh-au', 'client-control')
}

export function assertRequestId(requestId) {
  assertControl(typeof requestId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(requestId),
    'Request ID must be 1-80 ASCII letters, digits, _ or -', 'INVALID_REQUEST_ID')
}

export function hashBytes(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function atomicWriteJson(filePath, value) {
  ensurePrivateDirectory(dirname(filePath))
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  let handle
  try {
    handle = openPrivateFile(temporary, 'wx')
    writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncSync(handle)
  } catch (error) {
    try { if (handle !== undefined) closeSync(handle) } catch {}
    try { unlinkSync(temporary) } catch {}
    throw error
  }
  closeSync(handle)
  try {
    renameSync(temporary, filePath)
    securePrivateFile(filePath)
  } catch (error) {
    try { unlinkSync(temporary) } catch {}
    throw error
  }
}

export function createRequestStateStore({
  stateDir = defaultClientControlStateDirectory()
} = {}) {
  const absoluteDirectory = resolve(stateDir)

  function pathFor(requestId) {
    assertRequestId(requestId)
    return join(absoluteDirectory, `${requestId}.json`)
  }

  function load(requestId) {
    const filePath = pathFor(requestId)
    if (!existsSync(filePath)) return null
    try {
      const state = JSON.parse(readFileSync(filePath, 'utf8'))
      assertControl(state && typeof state === 'object' && !Array.isArray(state),
        'Request state is not a JSON object', 'INVALID_STATE')
      return state
    } catch (cause) {
      if (cause instanceof ClientControlError) throw cause
      throw new ClientControlError(`Cannot read request state: ${filePath}`, {
        code: 'INVALID_STATE',
        cause
      })
    }
  }

  function save(requestId, state) {
    atomicWriteJson(pathFor(requestId), state)
  }

  return {
    directory: absoluteDirectory,
    pathFor,
    lockPathFor: (requestId) => `${pathFor(requestId)}.lock`,
    load,
    save
  }
}

export function identityLockPath(kind, identity) {
  const key = hashBytes(`${kind}:${process.platform === 'win32' ? identity.toLowerCase() : identity}`)
  return join(defaultClientControlStateDirectory(), 'locks', `${key}.lock`)
}

function processIsAlive(pid) {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but cannot be signalled; only ESRCH proves it is gone.
    return error?.code !== 'ESRCH'
  }
}

function recoverableLock(filePath, { now, staleMs }) {
  let raw
  let stats
  try {
    raw = readFileSync(filePath, 'utf8')
    stats = statSync(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    return false
  }

  try {
    const record = JSON.parse(raw)
    if (Number.isInteger(record?.pid) && record.pid > 0 && typeof record?.token === 'string') {
      return !processIsAlive(record.pid)
    }
  } catch {
    // A malformed lock is recoverable only after it has remained unchanged for a conservative period.
  }
  return now() - stats.mtimeMs >= staleMs
}

function quarantineStaleLock(filePath) {
  const quarantine = `${filePath}.${process.pid}.${randomUUID()}.stale`
  try {
    renameSync(filePath, quarantine)
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    return false
  }
  try { unlinkSync(quarantine) } catch {}
  return true
}

function releaseOwnedLock(filePath, token) {
  try {
    const record = JSON.parse(readFileSync(filePath, 'utf8'))
    if (record?.token === token) unlinkSync(filePath)
  } catch {
    // Never delete a missing, replaced, or unreadable lock because it may belong to another process.
  }
}

export async function withControlLock(filePath, run, {
  now = Date.now,
  staleMs = INVALID_LOCK_STALE_MS
} = {}) {
  ensurePrivateDirectory(dirname(filePath))
  const token = randomUUID()
  let handle

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      handle = openPrivateFile(filePath, 'wx')
    } catch (cause) {
      if (cause?.code === 'EEXIST'
        && recoverableLock(filePath, { now, staleMs })
        && quarantineStaleLock(filePath)) continue
      throw new ClientControlError(`Another client-control operation owns lock: ${filePath}`, {
        code: 'CONTROL_LOCKED',
        cause
      })
    }

    try {
      writeFileSync(handle, `${JSON.stringify({ pid: process.pid, token, createdAt: now() })}\n`, 'utf8')
      fsyncSync(handle)
      securePrivateFile(filePath)
      break
    } catch (cause) {
      try { closeSync(handle) } catch {}
      handle = undefined
      releaseOwnedLock(filePath, token)
      throw new ClientControlError(`Cannot initialize client-control lock: ${filePath}`, {
        code: 'LOCK_INITIALIZATION_FAILED',
        cause
      })
    }
  }

  if (handle === undefined) {
    throw new ClientControlError(`Another client-control operation owns lock: ${filePath}`, {
      code: 'CONTROL_LOCKED'
    })
  }

  try {
    return await run()
  } finally {
    closeSync(handle)
    releaseOwnedLock(filePath, token)
  }
}

export function assertLogPrefix(raw, state) {
  const baselineBytes = state.baselineBytes
  const samePrefix = Number.isInteger(baselineBytes)
    && raw.length >= baselineBytes
    && hashBytes(raw.subarray(0, baselineBytes)) === state.baselineSha256
  assertControl(samePrefix,
    'Original log was truncated, replaced, or rewritten; refusing to guess', 'LOG_REWRITTEN')
}
