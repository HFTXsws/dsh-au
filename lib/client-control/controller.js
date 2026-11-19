import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import {
  isMainHuman,
  latestHuman,
  loadClaudeLog,
  renderedText,
  replyFor,
  textContent,
  verifyClaudeSource
} from './claude-log.js'
import {
  listSessionLogs,
  resolveClaudeProjectDirectory,
  resolveClaudeSessionLog,
  sessionIdFromLog
} from './discovery.js'
import { createPlatformAdapter } from './platform-adapter.js'
import { projectWindowsReplyView } from './windows-reply-view.js'
import { ClientControlError, assertControl } from './errors.js'
import {
  assertLogPrefix,
  assertRequestId,
  createRequestStateStore,
  hashBytes,
  identityLockPath,
  withControlLock
} from './state.js'

const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_POLL_MS = 500

function validatePrompt(prompt) {
  assertControl(typeof prompt === 'string' && prompt.trim() && !prompt.includes('\0'),
    'Prompt must be nonempty UTF-8 text without NUL', 'INVALID_PROMPT')
}

function validateTimeout(timeoutMs) {
  assertControl(Number.isFinite(timeoutMs) && timeoutMs > 0,
    'Timeout must be a positive number', 'INVALID_TIMEOUT')
}

function samePath(left, right) {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function assertSameRequest(state, expected) {
  for (const [key, value] of Object.entries(expected)) {
    const matches = key === 'prompt' && state.prompt === undefined
      ? state.promptSha256 === hashBytes(value)
      : state[key] === value
    assertControl(matches,
      `Request ID was already used with different ${key}`, 'REQUEST_ID_REUSED')
  }
}

function stripPersistedDisplayContext(state) {
  let changed = false
  if (typeof state.prompt === 'string') {
    state.promptSha256 = hashBytes(state.prompt)
    delete state.prompt
    changed = true
  }
  for (const key of ['lastUser', 'previousReply', 'sourceCwd']) {
    if (key in state) {
      delete state[key]
      changed = true
    }
  }
  return changed
}

function sanitizeCompletedState(state) {
  if (typeof state.prompt === 'string') {
    state.promptSha256 = hashBytes(state.prompt)
    delete state.prompt
  }
  for (const key of [
    'baselineFiles', 'baselineUuids', 'fingerprint', 'projectLogDir',
    'lastUser', 'previousReply', 'sessionId', 'sourceCwd'
  ]) delete state[key]
}

function readCompletedReply(state) {
  assertControl(typeof state.sessionLog === 'string' && typeof state.userUuid === 'string',
    'Completed request state is missing its reply identity', 'INVALID_STATE')
  const current = loadClaudeLog(state.sessionLog)
  if (Number.isInteger(state.baselineBytes) && typeof state.baselineSha256 === 'string') {
    assertLogPrefix(current.raw, state)
  }
  const response = replyFor(current.nodes, state.userUuid)
  assertControl(response !== null,
    'Completed reply is no longer available in its session log', 'INCOMPLETE_TURN')
  return response
}

async function waitForSessionReply({
  sessionLog,
  state,
  requestId,
  store,
  prompt,
  timeoutMs,
  pollMs,
  sleep,
  now
}) {
  const deadline = now() + timeoutMs
  while (true) {
    const current = loadClaudeLog(sessionLog)
    assertLogPrefix(current.raw, state)
    if (!state.userUuid) {
      const baseline = new Set(state.baselineUuids)
      const newUsers = current.records.filter((record) => record.uuid
        && !baseline.has(record.uuid) && isMainHuman(record))
      const matches = newUsers.filter((record) => textContent(record.message) === prompt
        && record.sessionId === state.sessionId
        && record.clientPlatform === 'desktop_app')
      if (newUsers.length && matches.length !== 1) {
        throw new ClientControlError('New user turns do not uniquely confirm this send', {
          code: 'SEND_NOT_CONFIRMED'
        })
      }
      if (matches.length > 1) {
        throw new ClientControlError('Multiple new user turns match this send', {
          code: 'SEND_NOT_CONFIRMED'
        })
      }
      if (matches.length === 1) {
        state.userUuid = matches[0].uuid
        state.phase = 'accepted'
        store.save(requestId, state)
      }
    }
    if (state.userUuid) {
      const response = replyFor(current.nodes, state.userUuid)
      if (response !== null) {
        state.phase = 'complete'
        sanitizeCompletedState(state)
        store.save(requestId, state)
        return response
      }
    }
    if (now() >= deadline) {
      throw new ClientControlError(
        'Timed out. Retry with the SAME request ID to read only; it will not resend',
        { code: 'TIMEOUT' }
      )
    }
    await sleep(pollMs)
  }
}

async function waitForNewReply({
  projectDir,
  projectLogDir,
  state,
  requestId,
  store,
  prompt,
  timeoutMs,
  pollMs,
  sleep,
  now
}) {
  const deadline = now() + timeoutMs
  while (true) {
    const matches = []
    for (const logPath of listSessionLogs(projectLogDir)) {
      if (state.baselineFiles.includes(sessionIdFromLog(logPath))) continue
      try {
        const current = loadClaudeLog(logPath)
        for (const record of current.records) {
          if (!isMainHuman(record)
            || textContent(record.message) !== prompt
            || typeof record.cwd !== 'string'
            || !samePath(record.cwd, projectDir)) continue
          const response = replyFor(current.nodes, record.uuid)
          if (response !== null) matches.push({ logPath, record, response })
        }
      } catch {
        // A writer may not have completed the new log yet; retry until timeout.
      }
    }
    if (matches.length > 1) {
      throw new ClientControlError('Multiple new session logs matched; refusing to guess', {
        code: 'AMBIGUOUS_SESSION'
      })
    }
    if (matches.length === 1) {
      const completed = loadClaudeLog(matches[0].logPath)
      state.phase = 'complete'
      state.sessionLog = matches[0].logPath
      state.userUuid = matches[0].record.uuid
      state.baselineBytes = completed.raw.length
      state.baselineSha256 = hashBytes(completed.raw)
      sanitizeCompletedState(state)
      store.save(requestId, state)
      return matches[0].response
    }
    if (now() >= deadline) {
      throw new ClientControlError(
        'Timed out. Retry with the SAME request ID to read only; it will not resend',
        { code: 'TIMEOUT' }
      )
    }
    await sleep(pollMs)
  }
}

export function createClaudeController({
  adapter = createPlatformAdapter(),
  stateDir,
  homeDir = homedir(),
  sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
  now = Date.now,
  pollMs = DEFAULT_POLL_MS
} = {}) {
  const store = createRequestStateStore({ stateDir })

  function resolveLog(options) {
    return resolveClaudeSessionLog({ ...options, homeDir })
  }

  function replyViewMetadata(source) {
    // Only the Windows UI boundary consumes this memory-only constrained projection.
    // Keep macOS behavior and raw reply output unchanged; never spread this into state.
    return adapter.capabilities?.().platform === 'win32' ? {
      SourceAssistantMessageIds: source.assistantMessageIds,
      // Match the existing visible-text contract, not link destinations; raw URLs stay in replyFor output.
      SourceReplyView: projectWindowsReplyView(source.replyViewSource, { linkLabels: true })
    } : {}
  }

  function read({ sessionLog, sessionId, projectDir, userUuid } = {}) {
    const logPath = resolveLog({ sessionLog, sessionId, projectDir })
    const current = loadClaudeLog(logPath)
    const target = userUuid || latestHuman(current.records).uuid
    const response = replyFor(current.nodes, target)
    assertControl(response !== null,
      'No completed reply for the selected turn; no partial text was emitted', 'INCOMPLETE_TURN')
    return response
  }

  async function inspect({ sessionLog, sessionId, projectDir, chatTitle } = {}) {
    assertControl(typeof chatTitle === 'string' && chatTitle,
      'Inspect requires --chat-title', 'INVALID_ARGUMENT')
    const source = verifyClaudeSource(resolveLog({ sessionLog, sessionId, projectDir }))
    return adapter.call('Inspect', {
      Title: chatTitle,
      Prompt: '',
      LastUser: textContent(source.user.message),
      // Raw UIA exposes the exact message UUID even when its accessible label is truncated.
      SourceUserUuid: source.user.uuid,
      LastUserRendered: renderedText(textContent(source.user.message)),
      PreviousReply: renderedText(source.reply),
      ...replyViewMetadata(source),
      SourceCwd: source.user.cwd || ''
    })
  }

  async function send({
    sessionLog,
    sessionId,
    projectDir,
    chatTitle,
    prompt,
    requestId,
    timeoutMs = DEFAULT_TIMEOUT_MS
  } = {}) {
    validatePrompt(prompt)
    validateTimeout(timeoutMs)
    assertRequestId(requestId)
    assertControl(typeof chatTitle === 'string' && chatTitle,
      'Send requires --chat-title', 'INVALID_ARGUMENT')
    const logPath = resolveLog({ sessionLog, sessionId, projectDir })
    const sessionLock = identityLockPath('session', resolve(logPath))

    return withControlLock(sessionLock, () => withControlLock(store.lockPathFor(requestId), async () => {
      let state = store.load(requestId)
      if (state) {
        assertSameRequest(state, {
          provider: 'claude', action: 'send', sessionLog: resolve(logPath),
          chatTitle, prompt
        })
        const strippedLegacyContext = stripPersistedDisplayContext(state)
        if (state.phase === 'complete') sanitizeCompletedState(state)
        if (strippedLegacyContext || state.phase === 'complete') store.save(requestId, state)
      } else {
        const source = verifyClaudeSource(logPath)
        state = {
          version: 2,
          provider: 'claude',
          action: 'send',
          phase: 'ready',
          sessionLog: resolve(logPath),
          chatTitle,
          sessionId: source.sessionId,
          promptSha256: hashBytes(prompt),
          baselineBytes: source.raw.length,
          baselineSha256: hashBytes(source.raw),
          baselineUuids: [...source.nodes.keys()]
        }
        store.save(requestId, state)
      }

      if (state.phase === 'complete') return readCompletedReply(state)

      if (['ready', 'prepare_intent', 'prepared'].includes(state.phase)) {
        const source = verifyClaudeSource(logPath)
        assertLogPrefix(source.raw, state)
        assertControl(source.raw.length === state.baselineBytes,
          'Session advanced before sending; inspect it before creating a new request',
          'SESSION_ADVANCED')
        // Rebuild visible context from the unchanged source log instead of persisting message bodies.
        const config = {
          Title: chatTitle,
          Prompt: prompt,
          LastUser: textContent(source.user.message),
          SourceUserUuid: source.user.uuid,
          LastUserRendered: renderedText(textContent(source.user.message)),
          PreviousReply: renderedText(source.reply),
          ...replyViewMetadata(source),
          SourceCwd: source.user.cwd || ''
        }
        if (state.phase === 'ready') {
          state.fingerprint = await adapter.call('Inspect', config)
          state.phase = 'prepare_intent'
          store.save(requestId, state)
        }
        config.Fingerprint = state.fingerprint
        if (state.phase === 'prepare_intent') {
          await adapter.call('Prepare', config)
          state.phase = 'prepared'
          store.save(requestId, state)
        }
        const ready = verifyClaudeSource(logPath)
        assertLogPrefix(ready.raw, state)
        assertControl(ready.raw.length === state.baselineBytes,
          'Session advanced during preparation; nothing was sent', 'SESSION_ADVANCED')
        state.phase = 'send_intent'
        store.save(requestId, state)
        await adapter.call('Send', config)
      }

      return waitForSessionReply({
        sessionLog: logPath,
        state,
        requestId,
        store,
        prompt,
        timeoutMs,
        pollMs,
        sleep,
        now
      })
    }))
  }

  async function newSession({
    projectDir,
    prompt,
    requestId,
    timeoutMs = DEFAULT_TIMEOUT_MS
  } = {}) {
    validatePrompt(prompt)
    validateTimeout(timeoutMs)
    assertRequestId(requestId)
    assertControl(typeof projectDir === 'string' && projectDir,
      'New requires --project-dir', 'INVALID_ARGUMENT')
    const absoluteProject = resolve(projectDir)
    assertControl(existsSync(absoluteProject),
      `Project directory not found: ${absoluteProject}`, 'PROJECT_NOT_FOUND')
    const projectLogDir = resolveClaudeProjectDirectory(absoluteProject, {
      homeDir,
      allowMissing: true
    })
    const projectLock = identityLockPath('new', absoluteProject)

    return withControlLock(projectLock, () => withControlLock(store.lockPathFor(requestId), async () => {
      let state = store.load(requestId)
      if (state) {
        assertSameRequest(state, {
          provider: 'claude', action: 'new', projectDir: absoluteProject, prompt
        })
        const strippedLegacyContext = stripPersistedDisplayContext(state)
        if (state.phase === 'complete') sanitizeCompletedState(state)
        if (strippedLegacyContext || state.phase === 'complete') store.save(requestId, state)
      } else {
        state = {
          version: 2,
          provider: 'claude',
          action: 'new',
          phase: 'ready',
          projectDir: absoluteProject,
          projectLogDir,
          promptSha256: hashBytes(prompt),
          baselineFiles: listSessionLogs(projectLogDir).map(sessionIdFromLog)
        }
        store.save(requestId, state)
      }

      if (state.phase === 'complete') return readCompletedReply(state)

      const config = { ProjectDir: absoluteProject, Prompt: prompt, AllowPrepared: false }
      if (state.phase === 'ready') {
        // Persist intent before the first UI side effect; a retry can then call idempotent NewOpen safely.
        state.phase = 'open_intent'
        store.save(requestId, state)
      }
      if (state.phase === 'open_intent') {
        state.fingerprint = await adapter.call('NewOpen', config)
        state.phase = 'opened'
        store.save(requestId, state)
      }
      config.Fingerprint = state.fingerprint || {}
      // prepare_intent is retained for request states created by the pre-NewOpen implementation.
      if (state.phase === 'opened' || state.phase === 'prepare_intent') {
        await adapter.call('NewPrepare', config)
        state.phase = 'prepared'
        store.save(requestId, state)
      }
      if (state.phase === 'prepared') {
        config.AllowPrepared = true
        state.phase = 'send_intent'
        store.save(requestId, state)
        await adapter.call('NewSend', config)
      }

      return waitForNewReply({
        projectDir: absoluteProject,
        projectLogDir: state.projectLogDir,
        state,
        requestId,
        store,
        prompt,
        timeoutMs,
        pollMs,
        sleep,
        now
      })
    }))
  }

  return { read, inspect, send, newSession, capabilities: () => adapter.capabilities() }
}
