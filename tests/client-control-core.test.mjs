import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadClaudeLog, replyFor } from '../lib/client-control/claude-log.js'
import {
  resolveClaudeProjectDirectory,
  resolveClaudeSessionLog
} from '../lib/client-control/discovery.js'
import { createClaudeController } from '../lib/client-control/controller.js'
import { runCli } from '../lib/client-control/cli.js'
import { resolveClientControlPaths } from '../lib/client-control/paths.js'
import {
  createRequestStateStore,
  hashBytes,
  withControlLock
} from '../lib/client-control/state.js'

const SESSION = '11111111-1111-4111-8111-111111111111'
const NEW_SESSION = '22222222-2222-4222-8222-222222222222'

function user(uuid, parentUuid = null, content = 'old prompt', extra = {}) {
  return {
    uuid,
    parentUuid,
    type: 'user',
    sessionId: SESSION,
    clientPlatform: 'desktop_app',
    message: { role: 'user', content },
    ...extra
  }
}

function assistant(uuid, parentUuid, content, stopReason = 'end_turn') {
  return {
    uuid,
    parentUuid,
    type: 'assistant',
    message: { role: 'assistant', content, stop_reason: stopReason }
  }
}

function complete(uuid, parentUuid) {
  return {
    uuid,
    parentUuid,
    type: 'system',
    subtype: 'stop_hook_summary',
    preventedContinuation: false
  }
}

function writeLog(filePath, records) {
  writeFileSync(filePath, records
    .map((record) => `${JSON.stringify(record)}\n`)
    .join(''), 'utf8')
}

function appendLog(filePath, records) {
  writeFileSync(filePath, records
    .map((record) => `${JSON.stringify(record)}\n`)
    .join(''), { encoding: 'utf8', flag: 'a' })
}

function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-au-client-control-'))
  const cleanup = () => rmSync(directory, { recursive: true, force: true })
  try {
    const result = run(directory)
    if (result && typeof result.then === 'function') return result.finally(cleanup)
    cleanup()
    return result
  } catch (error) {
    cleanup()
    throw error
  }
}

test('request state is private on Unix and stores only supplied JSON data', () => {
  fixture((directory) => {
    const stateDir = join(directory, 'state')
    const store = createRequestStateStore({ stateDir })
    store.save('private-state', { promptSha256: hashBytes('secret prompt') })

    const statePath = join(stateDir, 'private-state.json')
    assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), {
      promptSha256: hashBytes('secret prompt')
    })
    if (process.platform !== 'win32') {
      assert.equal(statSync(stateDir).mode & 0o777, 0o700)
      assert.equal(statSync(statePath).mode & 0o777, 0o600)
    }
  })
})

test('expired malformed lock is recovered and removed after use', async () => {
  await fixture(async (directory) => {
    const lockPath = join(directory, 'stale.lock')
    writeFileSync(lockPath, 'damaged lock', 'utf8')
    utimesSync(lockPath, new Date(0), new Date(0))

    assert.equal(await withControlLock(lockPath, async () => 'recovered', {
      now: () => 10_000,
      staleMs: 1
    }), 'recovered')
    assert.equal(existsSync(lockPath), false)
  })
})

test('live lock owner retains mutual exclusion regardless of stale threshold', async () => {
  await fixture(async (directory) => {
    const lockPath = join(directory, 'live.lock')
    let releaseOwner
    let ownerReady
    const ready = new Promise((resolveReady) => { ownerReady = resolveReady })
    const held = new Promise((resolveRelease) => { releaseOwner = resolveRelease })
    const owner = withControlLock(lockPath, async () => {
      ownerReady()
      await held
    })
    await ready

    await assert.rejects(
      withControlLock(lockPath, async () => {}, { staleMs: 0 }),
      (error) => error?.code === 'CONTROL_LOCKED'
    )
    releaseOwner()
    await owner
    assert.equal(existsSync(lockPath), false)
  })
})

test('main-chain extraction preserves raw text blocks and ignores tool-result bridges', () => {
  fixture((directory) => {
    const log = join(directory, `${SESSION}.jsonl`)
    const records = [
      user('human', null, 'question'),
      { uuid: 'attachment', parentUuid: 'human', type: 'attachment' },
      assistant('part-1', 'attachment', [
        { type: 'thinking', thinking: 'secret' },
        { type: 'text', text: '  中文\r\n' }
      ], 'tool_use'),
      {
        uuid: 'tool-result',
        parentUuid: 'part-1',
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'ignore' }] }
      },
      assistant('part-2', 'tool-result', [
        { type: 'text', text: '🙂same' },
        { type: 'text', text: 'same\n  ' }
      ]),
      complete('done', 'part-2')
    ]
    writeLog(log, records)
    writeFileSync(log, '{"partial":"🙂', { encoding: 'utf8', flag: 'a' })

    const parsed = loadClaudeLog(log)
    assert.equal(replyFor(parsed.nodes, 'human'), '  中文\r\n🙂samesame\n  ')
  })
})

test('Windows inspect projects only the selected completed reply chain into temporary UI config', async () => {
  await fixture(async (directory) => {
    const log = join(directory, `${SESSION}.jsonl`)
    const first = assistant('part-one', 'human', '[file**.**cs(-1)](file:///C:/project/file.cs)', 'tool_use')
    first.message.id = 'chatcmpl-first'
    const final = assistant('part-two', 'part-one', 'done.')
    final.message.id = 'chatcmpl-final'
    const dead = assistant('dead-branch', 'human', 'not the selected reply', 'tool_use')
    dead.message.id = 'chatcmpl-dead'
    writeLog(log, [user('human'), first, final, complete('done', 'part-two'), dead])
    const stateDir = join(directory, 'state')
    let uiConfig
    const controller = createClaudeController({
      stateDir,
      adapter: {
        capabilities: () => ({ platform: 'win32' }),
        call(action, config) { assert.equal(action, 'Inspect'); uiConfig = config; return { Pid: '123' } }
      }
    })
    assert.deepEqual(await controller.inspect({ sessionLog: log, chatTitle: 'title' }), { Pid: '123' })
    assert.deepEqual(uiConfig.SourceAssistantMessageIds, ['chatcmpl-first', 'chatcmpl-final'])
    assert.deepEqual(uiConfig.SourceReplyView, [{ type: 'text', text: 'file.cs(-1) done.' }])
    assert.equal(controller.read({ sessionLog: log }), '[file**.**cs(-1)](file:///C:/project/file.cs)done.')
    assert.equal(existsSync(stateDir), false)
  })
})

test('Windows display joins chunks of one assistant ID without manufacturing spaces', async () => {
  await fixture(async (directory) => {
    const log = join(directory, `${SESSION}.jsonl`)
    const first = assistant('chunk-one', 'human', 'file', 'tool_use')
    const final = assistant('chunk-two', 'chunk-one', '.cs(-1)')
    first.message.id = final.message.id = 'chatcmpl-shared-stream'
    writeLog(log, [user('human'), first, final, complete('done', 'chunk-two')])
    let view
    const controller = createClaudeController({
      stateDir: join(directory, 'state'),
      adapter: {
        capabilities: () => ({ platform: 'win32' }),
        call(action, config) { assert.equal(action, 'Inspect'); view = config.SourceReplyView; return {} }
      }
    })
    await controller.inspect({ sessionLog: log, chatTitle: 'title' })
    assert.deepEqual(view, [{ type: 'text', text: 'file.cs(-1)' }])
    assert.equal(controller.read({ sessionLog: log }), 'file.cs(-1)')
  })
})

test('dynamic discovery uses homedir Claude projects and log cwd instead of hardcoded slug', () => {
  fixture((homeDir) => {
    const projectDir = join(homeDir, 'work', '项目 A')
    const projectLogDir = join(homeDir, '.claude', 'projects', 'custom-provider-slug')
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(projectLogDir, { recursive: true })
    const log = join(projectLogDir, `${SESSION}.jsonl`)
    writeLog(log, [
      user('human', null, 'question', { cwd: projectDir }),
      assistant('answer', 'human', 'response'),
      complete('done', 'answer')
    ])

    assert.equal(resolveClaudeProjectDirectory(projectDir, { homeDir }), projectLogDir)
    assert.equal(resolveClaudeSessionLog({ sessionId: SESSION, projectDir, homeDir }), log)
    assert.equal(resolveClaudeSessionLog({ sessionId: SESSION, homeDir }), log)
  })
})

test('inspect rejects indistinguishable sibling logs before UI access and creates no request state', async (t) => {
  for (const [scenario, siblingReply, checkpoint, rejected] of [
    ['same rendered signature', '**old response**', true, true],
    ['same pending prompt', null, false, true],
    ['different completed reply', 'different response', true, false],
    ['shared latest user UUID with changed content', 'different response', true, true]
  ]) {
    await t.test(scenario, () => fixture(async (directory) => {
      const log = join(directory, `${SESSION}.jsonl`)
      const sibling = join(directory, `${NEW_SESSION}.jsonl`)
      const stateDir = join(directory, 'state')
      writeLog(log, [user('old-user'), assistant('answer', 'old-user', 'old response'), complete('done', 'answer')])
      const sharedAnchor = scenario === 'shared latest user UUID with changed content'
      const siblingUuid = sharedAnchor ? 'old-user' : 'sibling-user'
      const siblingRecords = [user(siblingUuid, null, sharedAnchor ? 'changed prompt' : 'old prompt', { sessionId: NEW_SESSION })]
      if (siblingReply !== null) siblingRecords.push(assistant('sibling-answer', siblingUuid, siblingReply))
      if (checkpoint) siblingRecords.push(complete('sibling-done', 'sibling-answer'))
      writeLog(sibling, siblingRecords)
      const original = readFileSync(log)
      let uiReads = 0
      const adapter = {
        call(action) {
          assert.equal(action, 'Inspect', 'read-only inspect must never reach a write/new action')
          uiReads += 1
          return { Pid: '123' }
        }
      }
      const controller = createClaudeController({ adapter, stateDir })
      const request = { sessionLog: log, chatTitle: 'same title' }
      if (rejected) {
        await assert.rejects(controller.inspect(request), (error) => error.code === 'AMBIGUOUS_SESSION')
        assert.equal(uiReads, 0)
      } else {
        assert.deepEqual(await controller.inspect(request), { Pid: '123' })
        assert.equal(uiReads, 1)
      }
      assert.equal(existsSync(stateDir), false)
      assert.deepEqual(readFileSync(log), original)
    }))
  }
})

test('persisted send intent makes a lost adapter result read-only on retry', async () => {
  await fixture(async (directory) => {
    const log = join(directory, `${SESSION}.jsonl`)
    const stateDir = join(directory, 'state')
    writeLog(log, [
      user('old-user'),
      assistant('old-answer', 'old-user', 'old response'),
      complete('old-done', 'old-answer')
    ])

    const calls = []
    const adapter = {
      capabilities: () => ({ platform: 'test', actions: ['read', 'inspect', 'send', 'new'] }),
      async call(action) {
        calls.push(action)
        if (action === 'Inspect') return { Pid: '1' }
        if (action === 'Send') {
          appendLog(log, [
            user('new-user', 'old-done', 'new request'),
            assistant('new-answer', 'new-user', [
              { type: 'text', text: '  raw\r\n' },
              { type: 'text', text: 'reply  ' }
            ]),
            complete('new-done', 'new-answer')
          ])
          throw new Error('adapter result lost after real click')
        }
        return { Pid: '1' }
      }
    }
    const controller = createClaudeController({ adapter, stateDir, pollMs: 1 })
    const request = {
      sessionLog: log,
      chatTitle: 'title',
      prompt: 'new request',
      requestId: 'stable-id',
      timeoutMs: 100
    }

    await assert.rejects(controller.send(request), /result lost/)
    const persisted = JSON.parse(readFileSync(join(stateDir, 'stable-id.json'), 'utf8'))
    assert.equal(persisted.phase, 'send_intent')
    assert.equal(persisted.promptSha256, hashBytes('new request'))
    assert.equal('prompt' in persisted, false)
    assert.equal('previousReply' in persisted, false)
    assert.equal(JSON.stringify(persisted).includes('old response'), false)
    assert.equal(await controller.send(request), '  raw\r\nreply  ')
    const completedState = JSON.parse(readFileSync(join(stateDir, 'stable-id.json'), 'utf8'))
    assert.equal(completedState.phase, 'complete')
    assert.equal('baselineUuids' in completedState, false)
    assert.deepEqual(calls, ['Inspect', 'Prepare', 'Send'])
  })
})

test('existing draft is preserved and the same request can retry from ready state', async () => {
  await fixture(async (directory) => {
    const log = join(directory, `${SESSION}.jsonl`)
    const stateDir = join(directory, 'state')
    writeLog(log, [
      user('old-user'),
      assistant('old-answer', 'old-user', 'old response'),
      complete('old-done', 'old-answer')
    ])

    let draft = 'my unsent draft'
    let sent = 0
    const adapter = {
      capabilities: () => ({ platform: 'test' }),
      async call(action, config) {
        if (action === 'Inspect') {
          if (draft) throw new Error('Existing draft preserved')
          return { Pid: '1' }
        }
        if (action === 'Prepare') {
          if (draft && draft !== config.Prompt) throw new Error('Existing draft preserved')
          draft = config.Prompt
          return { Pid: '1' }
        }
        sent += 1
        draft = ''
        appendLog(log, [
          user('new-user', 'old-done', config.Prompt),
          assistant('new-answer', 'new-user', 'OK'),
          complete('new-done', 'new-answer')
        ])
        return { Pid: '1' }
      }
    }
    const controller = createClaudeController({ adapter, stateDir, pollMs: 1 })
    const request = {
      sessionLog: log,
      chatTitle: 'title',
      prompt: 'new request',
      requestId: 'draft-retry',
      timeoutMs: 100
    }

    await assert.rejects(controller.send(request), /Existing draft preserved/)
    assert.equal(draft, 'my unsent draft')
    assert.equal(sent, 0)
    const readyState = JSON.parse(readFileSync(join(stateDir, 'draft-retry.json'), 'utf8'))
    assert.equal(readyState.phase, 'ready')
    assert.equal(readyState.promptSha256, hashBytes('new request'))
    assert.equal('prompt' in readyState, false)
    assert.equal('previousReply' in readyState, false)

    draft = ''
    assert.equal(await controller.send(request), 'OK')
    assert.equal(sent, 1)
  })
})

test('prepare result loss retries the owned draft and sends once', async () => {
  await fixture(async (directory) => {
    const log = join(directory, `${SESSION}.jsonl`)
    const stateDir = join(directory, 'state')
    writeLog(log, [
      user('old-user'),
      assistant('old-answer', 'old-user', 'old response'),
      complete('old-done', 'old-answer')
    ])

    let draft = ''
    let losePrepareResult = true
    let sent = 0
    const adapter = {
      capabilities: () => ({ platform: 'test' }),
      async call(action, config) {
        if (action === 'Inspect') return { Pid: '1' }
        if (action === 'Prepare') {
          if (draft && draft !== config.Prompt) throw new Error('Existing draft preserved')
          draft = config.Prompt
          if (losePrepareResult) {
            losePrepareResult = false
            throw new Error('prepare result lost')
          }
          return { Pid: '1' }
        }
        sent += 1
        draft = ''
        appendLog(log, [
          user('new-user', 'old-done', config.Prompt),
          assistant('new-answer', 'new-user', 'OK'),
          complete('new-done', 'new-answer')
        ])
        return { Pid: '1' }
      }
    }
    const controller = createClaudeController({ adapter, stateDir, pollMs: 1 })
    const request = {
      sessionLog: log,
      chatTitle: 'title',
      prompt: 'new request',
      requestId: 'prepare-retry',
      timeoutMs: 100
    }

    await assert.rejects(controller.send(request), /prepare result lost/)
    assert.equal(draft, 'new request')
    assert.equal(sent, 0)
    const preparedIntent = JSON.parse(readFileSync(join(stateDir, 'prepare-retry.json'), 'utf8'))
    assert.equal(preparedIntent.phase, 'prepare_intent')
    assert.equal('prompt' in preparedIntent, false)
    assert.equal(await controller.send(request), 'OK')
    assert.equal(sent, 1)
  })
})

test('session advance during preparation refuses to send', async () => {
  await fixture(async (directory) => {
    const log = join(directory, `${SESSION}.jsonl`)
    const stateDir = join(directory, 'state')
    writeLog(log, [
      user('old-user'),
      assistant('old-answer', 'old-user', 'old response'),
      complete('old-done', 'old-answer')
    ])

    let sent = 0
    const adapter = {
      capabilities: () => ({ platform: 'test' }),
      async call(action) {
        if (action === 'Inspect') return { Pid: '1' }
        if (action === 'Prepare') {
          appendLog(log, [
            user('manual-user', 'old-done', 'manual request'),
            assistant('manual-answer', 'manual-user', 'manual response'),
            complete('manual-done', 'manual-answer')
          ])
          return { Pid: '1' }
        }
        sent += 1
        return { Pid: '1' }
      }
    }
    const controller = createClaudeController({ adapter, stateDir, pollMs: 1 })

    await assert.rejects(controller.send({
      sessionLog: log,
      chatTitle: 'title',
      prompt: 'new request',
      requestId: 'advanced-session',
      timeoutMs: 100
    }), /Session advanced during preparation/)
    assert.equal(sent, 0)
  })
})

test('new session persists open intent and retries NewOpen without a second click', async () => {
  await fixture(async (homeDir) => {
    const projectDir = join(homeDir, 'work', 'Project A')
    const projectLogDir = join(homeDir, '.claude', 'projects', 'custom-project')
    const stateDir = join(homeDir, 'state')
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(projectLogDir, { recursive: true })
    writeLog(join(projectLogDir, `${SESSION}.jsonl`), [
      user('old-user', null, 'old prompt', { cwd: projectDir }),
      assistant('old-answer', 'old-user', 'old response'),
      complete('old-done', 'old-answer')
    ])

    let opened = false
    let loseOpenResult = true
    let openAttempts = 0
    let openClicks = 0
    let prepared = 0
    let sent = 0
    const statePath = join(stateDir, 'new-open-retry.json')
    const adapter = {
      capabilities: () => ({ platform: 'test', internalActions: ['NewOpen'] }),
      async call(action, config) {
        if (action === 'NewOpen') {
          openAttempts += 1
          assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).phase, 'open_intent')
          if (!opened) {
            opened = true
            openClicks += 1
          }
          if (loseOpenResult) {
            loseOpenResult = false
            throw new Error('open result lost')
          }
          return { Pid: '1', Document: 'blank-project-a' }
        }
        if (action === 'NewPrepare') {
          prepared += 1
          return { Pid: '1', Document: 'blank-project-a' }
        }
        if (action === 'NewSend') {
          sent += 1
          writeLog(join(projectLogDir, `${NEW_SESSION}.jsonl`), [
            user('new-user', null, config.Prompt, { cwd: projectDir, sessionId: NEW_SESSION }),
            assistant('new-answer', 'new-user', 'OK'),
            complete('new-done', 'new-answer')
          ])
          return { Pid: '1', Document: 'blank-project-a' }
        }
        throw new Error(`unexpected action: ${action}`)
      }
    }
    const controller = createClaudeController({ adapter, stateDir, homeDir, pollMs: 1 })
    const request = {
      projectDir,
      prompt: 'reply OK',
      requestId: 'new-open-retry',
      timeoutMs: 100
    }

    await assert.rejects(controller.newSession(request), /open result lost/)
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).phase, 'open_intent')
    assert.equal(await controller.newSession(request), 'OK')
    assert.equal(openAttempts, 2)
    assert.equal(openClicks, 1)
    assert.equal(prepared, 1)
    assert.equal(sent, 1)
  })
})

test('CLI writes replies unchanged to stdout and diagnostics only to stderr', () => {
  fixture((directory) => {
    const log = join(directory, `${SESSION}.jsonl`)
    writeLog(log, [
      user('human', null, 'question'),
      assistant('answer', 'human', '  原文\r\n🙂\n  '),
      complete('done', 'answer')
    ])
    const cli = fileURLToPath(new URL('../lib/client-control/cli.js', import.meta.url))
    const output = join(directory, 'reply.txt')
    const result = spawnSync(process.execPath, [
      cli,
      '--provider', 'claude',
      '--action', 'read',
      '--session-log', log,
      '--output-file', output
    ], { encoding: 'utf8' })
    assert.equal(result.status, 0)
    assert.equal(result.stdout, '  原文\r\n🙂\n  ')
    assert.equal(result.stderr, '')
    assert.equal(readFileSync(output, 'utf8'), result.stdout)
  })
})

test('CLI output-file refuses to overwrite an existing file', () => {
  fixture((directory) => {
    const log = join(directory, `${SESSION}.jsonl`)
    const output = join(directory, 'reply.txt')
    writeLog(log, [
      user('human', null, 'question'),
      assistant('answer', 'human', 'new reply'),
      complete('done', 'answer')
    ])
    writeFileSync(output, 'keep me', 'utf8')
    const cli = fileURLToPath(new URL('../lib/client-control/cli.js', import.meta.url))

    const result = spawnSync(process.execPath, [
      cli,
      '--provider', 'claude',
      '--action', 'read',
      '--session-log', log,
      '--output-file', output
    ], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /EEXIST|file already exists/i)
    assert.equal(readFileSync(output, 'utf8'), 'keep me')
  })
})

test('unified CLI sends Codex protocol fields through endpoint-v1 IPC', async () => {
  await fixture(async (directory) => {
    const dshHome = join(directory, 'dsh-home')
    const profile = 'integration-test'
    const paths = resolveClientControlPaths({ dshHome, profile })
    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\dsh-au-client-control-test-${process.pid}-${Date.now()}`
      : join(directory, 'client-control.sock')
    mkdirSync(paths.baseDir, { recursive: true })
    writeFileSync(paths.tokenPath, 'secret-token', 'utf8')
    writeFileSync(paths.endpointPath, JSON.stringify({
      schemaVersion: 1,
      endpoint,
      profile
    }), 'utf8')

    let received
    const server = createServer((socket) => {
      let raw = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk) => {
        raw += chunk
        if (!raw.includes('\n')) return
        received = JSON.parse(raw.slice(0, raw.indexOf('\n')))
        socket.end(`${JSON.stringify({
          ok: true,
          sessionId: 'session-1',
          text: '  codex raw\r\n🙂  '
        })}\n`)
      })
    })
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(endpoint, resolveListen)
    })
    try {
      let stdout = ''
      let stderr = ''
      const code = await runCli([
        '--provider', 'codex',
        '--action', 'prompt',
        '--text', 'hello',
        '--request-id', 'request-1',
        '--session-id', 'session-1',
        '--cwd', directory,
        '--timeout-ms', '1000',
        '--dsh-home', dshHome,
        '--profile', profile
      ], {
        stdout: { write: (value) => { stdout += value } },
        stderr: { write: (value) => { stderr += value } }
      })
      assert.equal(code, 0)
      assert.equal(stdout, '  codex raw\r\n🙂  ')
      assert.equal(stderr, '')
      assert.deepEqual(received, {
        token: 'secret-token',
        provider: 'codex',
        action: 'prompt',
        text: 'hello',
        requestId: 'request-1',
        sessionId: 'session-1',
        cwd: directory,
        timeoutMs: 1000
      })
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose))
    }
  })
})
