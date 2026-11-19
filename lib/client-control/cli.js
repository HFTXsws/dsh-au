#!/usr/bin/env node
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { fileURLToPath } from 'node:url'
import { createClaudeController } from './controller.js'
import { ClientControlError } from './errors.js'
import { detectDshProfile, resolveClientControlPaths } from './paths.js'

const HELP = `Usage:
  node cli.js --provider claude --action read --session-log <path> [--user-uuid <uuid>] \\
    [--output-file <new-path>]
  node cli.js --provider claude --action inspect --session-log <path> --chat-title <title>
  node cli.js --provider claude --action send --session-log <path> --chat-title <title> \\
    --prompt-file <path> --request-id <id> [--timeout <seconds>] [--output-file <new-path>]
  node cli.js --provider claude --action new --project-dir <path> --prompt-file <path> \\
    --request-id <id> [--timeout <seconds>] [--output-file <new-path>]
  node cli.js --provider codex --action prompt --text <text> --request-id <id> \\
    [--session-id <id>] [--cwd <path>] [--timeout-ms <milliseconds>] [--profile <name>]
  node cli.js --provider codex --action capabilities [--profile <name>]

Session discovery may use --session-id with optional --project-dir instead of --session-log.
State defaults to DSH_HOME/dsh-au/client-control. Codex endpoint metadata is isolated by
DSH profile (desktop by default). Replies are emitted unchanged on stdout; diagnostics and
failures are emitted on stderr.`

export function parseCliArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--help' || token === '-h') {
      values.help = true
      continue
    }
    if (!token.startsWith('--')) throw new ClientControlError(`Unexpected argument: ${token}`)
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new ClientControlError(`Missing value for ${token}`, { code: 'INVALID_ARGUMENT' })
    }
    values[key] = value
    index += 1
  }
  return values
}

function readPrompt(filePath) {
  if (!filePath) throw new ClientControlError('--prompt-file is required', { code: 'INVALID_ARGUMENT' })
  const bytes = readFileSync(filePath)
  return bytes.toString('utf8').replace(/^\uFEFF/, '')
}

export function callCodexIpc(request, {
  dshHome,
  profile = detectDshProfile(),
  connect = createConnection,
  maxResponseBytes = 16 * 1024 * 1024
} = {}) {
  const paths = resolveClientControlPaths({ dshHome, profile })
  const metadata = JSON.parse(readFileSync(paths.endpointPath, 'utf8'))
  if (metadata?.schemaVersion !== 1 || metadata.profile !== profile
    || typeof metadata.endpoint !== 'string' || !metadata.endpoint) {
    throw new ClientControlError('Invalid Codex client-control endpoint metadata', {
      code: 'INVALID_ENDPOINT'
    })
  }
  const token = request.token || readFileSync(paths.tokenPath, 'utf8').trim()
  const body = { ...request, token }
  const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 180_000, 1), 600_000)

  return new Promise((resolve, reject) => {
    let raw = ''
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      callback(value)
    }
    const parseResponse = () => {
      const lineEnd = raw.indexOf('\n')
      const payload = lineEnd >= 0 ? raw.slice(0, lineEnd) : raw.trim()
      if (!payload) return false
      try {
        const response = JSON.parse(payload)
        if (!response?.ok) {
          finish(reject, new ClientControlError(response?.error || 'Codex IPC request failed', {
            code: 'ADAPTER_FAILED'
          }))
        } else {
          finish(resolve, response)
        }
      } catch (cause) {
        finish(reject, new ClientControlError('Codex IPC returned invalid JSON', {
          code: 'ADAPTER_PROTOCOL_ERROR',
          cause
        }))
      }
      return true
    }
    const socket = connect(metadata.endpoint, () => socket.write(`${JSON.stringify(body)}\n`))
    socket.setEncoding('utf8')
    socket.setTimeout(timeoutMs + 5_000, () => {
      socket.destroy()
      finish(reject, new ClientControlError('Codex IPC response timed out', { code: 'TIMEOUT' }))
    })
    socket.on('data', (chunk) => {
      raw += chunk
      if (Buffer.byteLength(raw, 'utf8') > maxResponseBytes) {
        socket.destroy()
        finish(reject, new ClientControlError('Codex IPC response is too large', {
          code: 'ADAPTER_PROTOCOL_ERROR'
        }))
        return
      }
      if (raw.includes('\n') && parseResponse()) socket.end()
    })
    socket.on('error', (cause) => finish(reject,
      new ClientControlError(`Codex IPC connection failed: ${cause.message}`, {
        code: 'ADAPTER_FAILED',
        cause
      })))
    socket.on('close', () => {
      if (!settled && !parseResponse()) {
        finish(reject, new ClientControlError('Codex IPC closed without a response', {
          code: 'ADAPTER_PROTOCOL_ERROR'
        }))
      }
    })
  })
}

export async function runCli(argv, {
  stdout = process.stdout,
  stderr = process.stderr,
  controllerFactory = createClaudeController
} = {}) {
  try {
    const options = parseCliArguments(argv)
    if (options.help) {
      stdout.write(`${HELP}\n`)
      return 0
    }
    const timeoutMs = options.timeoutMs !== undefined
      ? Number(options.timeoutMs)
      : (options.timeout === undefined ? undefined : Number(options.timeout) * 1000)
    if (options.provider === 'codex') {
      if (!['capabilities', 'prompt'].includes(options.action)) {
        throw new ClientControlError('Codex --action must be capabilities or prompt', {
          code: 'INVALID_ARGUMENT'
        })
      }
      const request = {
        provider: 'codex',
        action: options.action,
        text: options.action === 'prompt'
          ? (options.text === undefined ? readPrompt(options.promptFile) : options.text)
          : undefined,
        requestId: options.requestId,
        sessionId: options.sessionId,
        cwd: options.cwd,
        timeoutMs,
        token: options.token
      }
      const result = await callCodexIpc(request, {
        dshHome: options.dshHome,
        profile: options.profile || detectDshProfile()
      })
      stdout.write(options.action === 'prompt' ? result.text : JSON.stringify(result))
      return 0
    }
    if (options.provider !== 'claude') {
      throw new ClientControlError('--provider must be claude or codex', {
        code: 'UNSUPPORTED_PROVIDER'
      })
    }
    if (!['read', 'inspect', 'send', 'new'].includes(options.action)) {
      throw new ClientControlError('Claude --action must be read, inspect, send, or new', {
        code: 'INVALID_ARGUMENT'
      })
    }
    const controller = controllerFactory({
      stateDir: options.stateDir,
      homeDir: options.homeDir
    })
    const common = {
      sessionLog: options.sessionLog,
      sessionId: options.sessionId,
      projectDir: options.projectDir
    }

    let response
    if (options.action === 'read') {
      response = controller.read({ ...common, userUuid: options.userUuid })
    } else if (options.action === 'inspect') {
      await controller.inspect({ ...common, chatTitle: options.chatTitle })
      stderr.write('dsh-au client-control: target and empty draft verified; nothing sent.\n')
      return 0
    } else {
      const prompt = readPrompt(options.promptFile)
      const request = {
        ...common,
        prompt,
        requestId: options.requestId,
        timeoutMs
      }
      response = options.action === 'send'
        ? await controller.send({ ...request, chatTitle: options.chatTitle })
        : await controller.newSession(request)
    }
    // Match the old relay contract: create once, never overwrite, and emit identical UTF-8 text.
    if (options.outputFile) {
      writeFileSync(options.outputFile, response, { encoding: 'utf8', flag: 'wx' })
    }
    stdout.write(response)
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    stderr.write(`dsh-au client-control: ${message}\n`)
    return 1
  }
}

export function isCliEntrypoint(entryPath = process.argv[1]) {
  if (!entryPath) return false
  try {
    const invoked = realpathSync(entryPath)
    const current = realpathSync(fileURLToPath(import.meta.url))
    return process.platform === 'win32'
      ? invoked.toLowerCase() === current.toLowerCase()
      : invoked === current
  } catch {
    return false
  }
}

if (isCliEntrypoint()) {
  process.exitCode = await runCli(process.argv.slice(2))
}
