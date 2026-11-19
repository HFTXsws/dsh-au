import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createPlatformAdapter } from '../lib/client-control/platform-adapter.js'
import { MacOSClientAdapter } from '../lib/client-control/macos-adapter.js'
import { WindowsClientAdapter } from '../lib/client-control/windows-adapter.js'
import { UnsupportedPlatformError } from '../lib/client-control/errors.js'

test('adapter capabilities expose supported actions and Linux fails explicitly', () => {
  const windows = createPlatformAdapter({ platform: 'win32', spawn: () => ({ status: 0, stdout: '{}' }) })
  const macos = createPlatformAdapter({ platform: 'darwin', spawn: () => ({ status: 0, stdout: '{}' }) })
  const linux = createPlatformAdapter({ platform: 'linux' })

  assert.deepEqual(windows.capabilities().actions, ['read', 'inspect', 'send', 'new'])
  assert.deepEqual(windows.capabilities().internalActions, ['NewOpen'])
  assert.equal(windows.capabilities().uiAutomation, 'UIAutomationClient')
  assert.deepEqual(macos.capabilities().actions, ['read', 'inspect', 'send', 'new'])
  assert.deepEqual(macos.capabilities().internalActions, ['NewOpen'])
  assert.equal(macos.capabilities().uiAutomation, 'System Events Accessibility')
  assert.deepEqual(linux.capabilities().actions, ['read'])
  assert.deepEqual(linux.capabilities().internalActions, [])
  assert.throws(() => linux.call('Inspect', {}), UnsupportedPlatformError)
})

test('Windows adapter prefers pwsh and falls back only when it is missing', () => {
  const commands = []
  const adapter = new WindowsClientAdapter({
    spawn(command, args) {
      commands.push({ command, args })
      if (command === 'pwsh') {
        return { status: null, error: Object.assign(new Error('missing'), { code: 'ENOENT' }) }
      }
      return { status: 0, stdout: '{"Pid":"123"}', stderr: '' }
    }
  })

  assert.deepEqual(adapter.call('Inspect', { Title: 'title' }), { Pid: '123' })
  assert.deepEqual(commands.map((entry) => entry.command), ['pwsh', 'powershell.exe'])
  assert.ok(commands[0].args.includes('-NoProfile'))
  assert.ok(commands[0].args.includes('-NonInteractive'))
  assert.ok(commands[0].args.includes('Inspect'))
})

test('macOS adapter invokes osascript JavaScript helper', () => {
  let invocation
  const adapter = new MacOSClientAdapter({
    spawn(command, args) {
      invocation = { command, args }
      return { status: 0, stdout: '{"Pid":"456"}', stderr: '' }
    }
  })

  assert.deepEqual(adapter.call('NewInspect', { ProjectDir: '/tmp/project' }), { Pid: '456' })
  assert.equal(invocation.command, 'osascript')
  assert.deepEqual(invocation.args.slice(0, 2), ['-l', 'JavaScript'])
  assert.ok(invocation.args.includes('NewInspect'))
})

test('adapters forward NewOpen through each native automation boundary', () => {
  const invocations = []
  const windows = new WindowsClientAdapter({
    spawn(command, args) {
      invocations.push({ platform: 'win32', command, args })
      return { status: 0, stdout: '{"Pid":"123"}', stderr: '' }
    }
  })
  const macos = new MacOSClientAdapter({
    spawn(command, args) {
      invocations.push({ platform: 'darwin', command, args })
      return { status: 0, stdout: '{"Pid":"456"}', stderr: '' }
    }
  })

  assert.deepEqual(windows.call('NewOpen', { ProjectDir: 'F:/Project A' }), { Pid: '123' })
  assert.deepEqual(macos.call('NewOpen', { ProjectDir: '/tmp/Project A' }), { Pid: '456' })
  assert.ok(invocations.find((item) => item.platform === 'win32').args.includes('NewOpen'))
  assert.ok(invocations.find((item) => item.platform === 'darwin').args.includes('NewOpen'))
})

const existingSessionConfig = {
  Title: '示例任务',
  Prompt: '',
  LastUser: 'shared synthetic summary prefix, followed by the full intended message body',
  LastUserRendered: 'shared synthetic summary prefix, followed by the full intended message body',
  SourceUserUuid: '11111111-1111-4111-8111-111111111111',
  PreviousReply: 'synthetic response',
  SourceAssistantMessageIds: ['chatcmpl-fixture'],
  SourceReplyView: [{ type: 'text', text: 'synthetic response' }],
  SourceCwd: 'F:\\Projects\\Game Build'
}

// 2026-11-08 incident: a verified empty renderer dock has no Send/Stop node at all.
// The single LF is the real ValuePattern value, not an empty-string normalization.
test('Windows 2026-11-08 empty renderer dock without Send inspects and preserves single LF', {
  skip: process.platform !== 'win32'
}, () => {
  const helperPath = fileURLToPath(new URL('./fixtures/windows-existing-context.ps1', import.meta.url))
  const adapter = new WindowsClientAdapter({ helperPath })
  const fingerprint = adapter.call('Inspect', {
    ...existingSessionConfig, Case: 'empty-dock-incident-2026-11-08'
  })
  assert.equal(fingerprint.Pid, '123')
  assert.equal(fingerprint.DraftBefore, '\n')
  assert.match(fingerprint.Document, /^42,/)
})

// 2026-11-08 regression: Claude exposes the title in Session tools, not Document.Name.
// Run the real PowerShell dispatch and validation against a fake OS/UIA boundary only.
test('Windows existing-session inspection follows current UI structure and stays fail-closed', {
  skip: process.platform !== 'win32'
}, async (t) => {
  const helperPath = fileURLToPath(new URL('./fixtures/windows-existing-context.ps1', import.meta.url))
  const adapter = new WindowsClientAdapter({ helperPath })
  const config = existingSessionConfig
  const listView = [
    { type: 'list_start', kind: 'ordered', depth: 0 },
    { type: 'item_start', depth: 0, ordinal: 1 }, { type: 'text', text: 'one' },
    { type: 'item_end', depth: 0 }, { type: 'list_end', depth: 0 },
    { type: 'list_start', kind: 'unordered', depth: 0 },
    { type: 'item_start', depth: 0, ordinal: null }, { type: 'text', text: 'outer' },
    { type: 'list_start', kind: 'unordered', depth: 1 },
    { type: 'item_start', depth: 1, ordinal: null }, { type: 'text', text: 'inner' },
    { type: 'item_end', depth: 1 }, { type: 'list_end', depth: 1 }, { type: 'text', text: 'tail' },
    { type: 'item_end', depth: 0 }, { type: 'list_end', depth: 0 },
    { type: 'rule' }, { type: 'text', text: 'done' }
  ]
  const cases = [
    ['current-tree', null],
    ['missing-title', /Missing or ambiguous.*title/],
    ['duplicate-title', /Missing or ambiguous.*title/],
    ['raw-duplicate-title', /Missing or ambiguous.*title/],
    ['hidden-title', /Missing or ambiguous.*title/],
    ['duplicate-document', /document.*missing or ambiguous/i],
    ['missing-document', /document.*missing or ambiguous/i],
    ['hidden-document', /document.*missing or ambiguous/i],
    ['truncated-human', /Latest human turn does not match/],
    ['truncated-complete-human', null],
    ['nested-human-text', null],
    ['missing-user-uuid', /Latest human message UUID is missing or ambiguous/],
    ['wrong-user-uuid', /Latest human message UUID is missing or ambiguous/],
    ['duplicate-user-uuid', /Latest human message UUID is missing or ambiguous/],
    ['wrong-human', /Latest human turn does not match/],
    ['wrong-reply', /Latest complete assistant body/],
    ['inline-reply', null, [{ type: 'text', text: 'file.cs(-1)' }]],
    ['changed-inline-reply', /Latest complete assistant body/, [{ type: 'text', text: 'file.cs(-1)' }]],
    ['missing-reply-id', /Assistant body row is missing or ambiguous/],
    ['wrong-reply-id', /Assistant body row is missing or ambiguous/],
    ['duplicate-reply-id', /Assistant body row is missing or ambiguous/],
    ['status-token-near-miss', /Unsupported assistant content|Latest complete assistant body/],
    ['unknown-reply-action', /Unsupported assistant content/],
    ['unlogged-reply-note', /Latest complete assistant body/],
    ['reply-list', null, listView],
    ['changed-list-depth', /Latest complete assistant body/, listView],
    ['wrong-project', /Full project path.*missing or ambiguous/],
    ['duplicate-project', /Full project path.*missing or ambiguous/],
    ['draft', /Existing draft preserved/],
    ['linebreak-draft', /Existing draft preserved/],
    ['attachment', /Composer contains attachment/],
    ['raw-attachment', /Composer contains attachment/],
    ['outer-attachment', /Composer contains attachment/],
    ['sibling-attachment', /Unscoped attachment, preview or action/],
    ['preview', /Composer contains attachment/],
    ['unknown-action', /Composer has an unrecognized action or attachment/],
    ['duplicate-prompt', /Missing or ambiguous control: Prompt/],
    ['raw-duplicate-prompt', /Missing or ambiguous control: Prompt/],
    ['hidden-prompt', /Prompt is unavailable/],
    ['readonly', /Prompt is read-only/],
    // No-Send eligibility is narrower than ordinary Send-based composer discovery.
    ['empty-dock-rounded-class-near-miss', /Cannot isolate the current composer safely/],
    ['empty-dock-missing-rounded-class', /Cannot isolate the current composer safely/],
    ['empty-dock-dock-class-near-miss', /Cannot isolate the current composer safely/],
    ['empty-dock-missing-dock-class', /Cannot isolate the current composer safely/],
    ['empty-dock-indirect-parent', /Cannot isolate the current composer safely/],
    ['empty-dock-wrong-parent-type', /Cannot isolate the current composer safely/],
    ['empty-dock-missing-add', /Cannot isolate the current composer safely/],
    ['empty-dock-duplicate-add', /Cannot isolate the current composer safely/],
    ['empty-dock-unqueryable-duplicate-add', /Cannot isolate the current composer safely/],
    ['empty-dock-unqueryable-attachment', /Cannot isolate the current composer safely/],
    ['empty-dock-stop-only', /Cannot isolate the current composer safely/],
    ['empty-dock-unqueryable-send', /Cannot isolate the current composer safely/],
    ['empty-dock-draft', /Cannot isolate the current composer safely/],
    ['empty-dock-linebreak-draft', /Cannot isolate the current composer safely/],
    ['empty-dock-attachment', /Composer contains attachment or preview content/],
    ['empty-dock-unknown-action', /Composer has an unrecognized action or attachment/],
    ['empty-dock-sibling-preview', /Unscoped attachment, preview or action/],
    ['empty-dock-sibling-attachment', /Unscoped attachment, preview or action/],
    ['empty-dock-unqueryable-sibling-preview', /Unscoped attachment, preview or action/],
    ['empty-dock-unqueryable-sibling-attachment', /Unscoped attachment, preview or action/],
    ['empty-dock-root-stop', /Cannot isolate the current composer safely/]
  ]
  for (const [scenario, expectedError, view = config.SourceReplyView] of cases) {
    await t.test(scenario, () => {
      const request = { ...config, Case: scenario, SourceReplyView: view }
      if (expectedError) {
        assert.throws(() => adapter.call('Inspect', request), expectedError)
      } else {
        const fingerprint = adapter.call('Inspect', request)
        assert.equal(fingerprint.Pid, '123')
        assert.equal(fingerprint.DraftBefore, '')
        assert.match(fingerprint.Document, /^42,/)
      }
    })
  }
})

test('Windows existing-session send requires unchanged identity and the exact owned draft', {
  skip: process.platform !== 'win32'
}, () => {
  const helperPath = fileURLToPath(new URL('./fixtures/windows-existing-context.ps1', import.meta.url))
  const adapter = new WindowsClientAdapter({ helperPath })
  const config = {
    Title: '示例任务', Prompt: 'synthetic next request',
    LastUser: 'synthetic question', PreviousReply: 'synthetic response',
    LastUserRendered: 'synthetic question', SourceUserUuid: '11111111-1111-4111-8111-111111111111',
    SourceAssistantMessageIds: ['chatcmpl-fixture'], SourceReplyView: [{ type: 'text', text: 'synthetic response' }],
    SourceCwd: 'F:\\Projects\\Game Build', Case: 'current-tree'
  }
  const fingerprint = adapter.call('Inspect', config)
  assert.throws(() => adapter.call('Send', {
    ...config, Case: 'prepared-send', Fingerprint: { ...fingerprint, Document: 'changed' }
  }), /Window or chat changed after preparation/)
  assert.throws(() => adapter.call('Send', {
    ...config, Fingerprint: fingerprint
  }), /Draft changed after preparation/)
  // A correct prepared request reaches the fake OS invocation boundary, never the real desktop.
  assert.throws(() => adapter.call('Send', {
    ...config, Case: 'prepared-send', Fingerprint: fingerprint
  }), /Fixture forbids invoking any UI action/)
})

test('Windows no-Send renderer dock rejects sends before any UI invocation', {
  skip: process.platform !== 'win32'
}, async (t) => {
  const helperPath = fileURLToPath(new URL('./fixtures/windows-existing-context.ps1', import.meta.url))
  const adapter = new WindowsClientAdapter({ helperPath })
  const config = {
    ...existingSessionConfig, Prompt: 'synthetic next request', Case: 'empty-dock-incident-2026-11-08'
  }
  const fingerprint = adapter.call('Inspect', config)
  for (const [scenario, expectedError] of [
    ['empty-dock-incident-2026-11-08', /Draft changed after preparation; nothing was sent/],
    ['empty-dock-prepared-send', /Cannot isolate the current composer safely/]
  ]) {
    await t.test(scenario, () => {
      assert.throws(() => adapter.call('Send', {
        ...config, Case: scenario, Fingerprint: fingerprint
      }), expectedError)
    })
  }
})

test('helpers contain real UI automation paths and Windows helper keeps UTF-8 BOM', () => {
  const windowsPath = createPlatformAdapter({ platform: 'win32' }).capabilities().helper
  const macosPath = createPlatformAdapter({ platform: 'darwin' }).capabilities().helper
  const windows = readFileSync(windowsPath)
  const macos = readFileSync(macosPath, 'utf8')

  assert.deepEqual([...windows.subarray(0, 3)], [0xef, 0xbb, 0xbf])
  assert.match(windows.toString('utf8'), /UIAutomationClient/)
  assert.match(windows.toString('utf8'), /InvokePattern/)
  assert.match(windows.toString('utf8'), /NewOpen/)
  assert.match(windows.toString('utf8'), /SamePath[\s\S]+Full project path is missing or ambiguous/)
  assert.match(macos, /Application\('System Events'\)/)
  assert.match(macos, /AXPress/)
  assert.match(macos, /NewOpen/)
  assert.match(macos, /full project path is missing or ambiguous/)
})
