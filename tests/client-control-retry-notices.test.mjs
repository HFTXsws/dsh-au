import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

// Load the retry-notice fixture without its type-only host SDK import or generated files.
const source = readFileSync(new URL('./fixtures/claude-retry-host-register.ts', import.meta.url), 'utf8')
const { register } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`)
// The retry request must retain the fixture text, not a separately pinned sentence.
const retryLiteral = source.match(/^const RETRY_TEXT\s*=\s*(.+)$/m)?.[1]
assert.ok(retryLiteral, 'production retry text declaration must be available')
const retryText = runInNewContext(retryLiteral)
assert.equal(typeof retryText, 'string')

const transientFailure = { reason: 'error', answer: 'API Error: 503 synthetic service failure' }
const modelTurnFailure = { reason: 'completed', answer: 'API Error: 400 Requests ending with a model turn are not supported.' }

function createHarness(t, { toastMode = 'available', rejectSubmit = false } = {}) {
  let now = 1_000_000
  t.mock.method(Date, 'now', () => now)
  const handlers = new Map()
  const timers = []
  const submissions = []
  const notices = []
  const transcript = []
  const continued = Symbol('synthetic next result')
  const ui = {
    log(...args) { transcript.push(args) }
  }
  if (toastMode !== 'missing') {
    // Code 2.1.317 accepts toast(text, options?) and returns void; this patch
    // uses one nonempty string. Reject bad calls before capture so a production
    // catch cannot hide a malformed notification behind a passing notice count.
    ui.toast = function (...args) {
      assert.equal(this, ui, 'the SDK receiver must be preserved')
      assert.equal(args.length, 1, 'the supported default toast call takes one text argument')
      assert.equal(typeof args[0], 'string')
      assert.ok(args[0].trim().length > 0)
      notices.push(args)
      if (toastMode === 'throw') throw new Error('synthetic synchronous toast failure')
      if (toastMode === 'reject') return Promise.reject(new Error('synthetic asynchronous toast failure'))
    }
  }
  const sdk = {
    ui,
    clock: {
      after(delay, callback) {
        timers.push({ delay, due: now + delay, callback, fired: false })
      }
    },
    prompt: {
      async submit(request) {
        submissions.push(structuredClone(request))
        if (rejectSubmit) throw new Error('synthetic submission failure')
      }
    }
  }
  // All failure state and callbacks below belong to the fixture register.
  register((name, handler) => handlers.set(name, handler))
  return {
    timers, submissions, notices, transcript,
    async emit(name, event) {
      let nextCalls = 0
      const result = await handlers.get(name)(sdk, event, forwarded => {
        assert.equal(forwarded, event, 'the original event must reach next')
        nextCalls += 1
        return continued
      })
      assert.equal(nextCalls, 1)
      assert.equal(result, continued)
    },
    elapse(ms) { now += ms },
    async runDue() {
      for (const timer of timers.filter(timer => !timer.fired && timer.due <= now)) {
        timer.fired = true
        await timer.callback()
      }
    },
    async advance(ms) {
      this.elapse(ms)
      await this.runDue()
    }
  }
}

function assertRetryRequests(harness) {
  for (const request of harness.submissions) {
    assert.deepEqual(request, { text: retryText })
  }
}

async function exhaustRetries(harness) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await harness.emit('turn.complete', attempt === 1 ? modelTurnFailure : transientFailure)
    assert.equal(harness.timers.length, attempt + 1, 'each eligible failure schedules one retry')
    assert.equal(harness.timers.at(-1).delay, 60_000)
    await harness.advance(60_000)
    assert.equal(harness.submissions.length, attempt + 1)
  }
  await harness.emit('turn.complete', transientFailure)
  await harness.advance(60_000)
  assert.equal(harness.timers.length, 30, 'retry 31 must not be scheduled')
  assert.equal(harness.submissions.length, 30, 'retry 31 must not be submitted')
}

const noticeScenarios = [
  {
    name: 'session startup', notices: 1, timers: 0, submissions: 0,
    async exercise(harness) { await harness.emit('session.start', { sessionId: 'synthetic-session' }) }
  },
  {
    name: 'transient service failure', notices: 1, timers: 1, submissions: 1,
    async exercise(harness) {
      await harness.emit('turn.complete', transientFailure)
      await harness.advance(59_999)
      assert.equal(harness.submissions.length, 0, 'a retry must wait the full 60 seconds')
      await harness.advance(1)
    }
  },
  {
    name: 'recoverable model-turn 400', notices: 1, timers: 1, submissions: 1,
    async exercise(harness) {
      await harness.emit('turn.complete', modelTurnFailure)
      await harness.advance(60_000)
    }
  },
  {
    name: 'retry limit reached', notices: 31, timers: 30, submissions: 30,
    exercise: exhaustRetries
  },
  {
    name: 'retry submission rejected', rejectSubmit: true, notices: 2, timers: 1, submissions: 1,
    async exercise(harness) {
      await harness.emit('turn.complete', transientFailure)
      await harness.advance(60_000)
    }
  }
]

// ui.log would flatten startup/retry notices into the verified reply UIA row.
// Every notice branch must instead use the non-transcript SDK toast boundary.
test('retry notices use toast without adding transcript content', async t => {
  for (const scenario of noticeScenarios) {
    await t.test(scenario.name, async child => {
      const harness = createHarness(child, { rejectSubmit: scenario.rejectSubmit })
      await scenario.exercise(harness)
      assert.equal(harness.notices.length, scenario.notices)
      assert.equal(harness.transcript.length, 0)
      assert.equal(harness.timers.length, scenario.timers)
      assert.equal(harness.submissions.length, scenario.submissions)
      assertRetryRequests(harness)
    })
  }
})

test('unavailable or failing toast cannot interrupt next, retry scheduling, or submission', async t => {
  for (const toastMode of ['missing', 'throw', 'reject']) {
    await t.test(toastMode, async child => {
      // Rejected submissions exercise the catch notice as well as startup,
      // both scheduled-retry reasons, and the exhausted-retry notice.
      const harness = createHarness(child, { toastMode, rejectSubmit: true })
      await harness.emit('session.start', { sessionId: 'synthetic-session' })
      await exhaustRetries(harness)
      assert.equal(harness.transcript.length, 0, 'notification failure must not fall back to ui.log')
      assertRetryRequests(harness)
    })
  }
})

test('normal completion cancels the pending retry and allows a later independent failure', async t => {
  const harness = createHarness(t)
  await harness.emit('turn.complete', transientFailure)
  await harness.emit('turn.complete', { reason: 'completed', answer: 'synthetic successful completion' })
  await harness.advance(60_000)
  assert.equal(harness.submissions.length, 0, 'the cancelled callback must not submit')

  await harness.emit('turn.complete', transientFailure)
  assert.equal(harness.timers.length, 2)
  await harness.advance(60_000)
  assert.equal(harness.submissions.length, 1)
  assertRetryRequests(harness)
})

test('subagent failures do not schedule retries or cancel the main-agent retry', async t => {
  const harness = createHarness(t)
  const childFailure = { ...transientFailure, agentId: 'synthetic-child' }
  await harness.emit('turn.complete', childFailure)
  assert.equal(harness.timers.length, 0)
  assert.equal(harness.notices.length, 0)

  await harness.emit('turn.complete', transientFailure)
  await harness.emit('turn.complete', childFailure)
  assert.equal(harness.timers.length, 1)
  await harness.advance(60_000)
  assert.equal(harness.submissions.length, 1)
  assertRetryRequests(harness)
})

test('cooldown duplicates and superseded timers cannot submit duplicate retries', async t => {
  const harness = createHarness(t)
  await harness.emit('turn.complete', transientFailure)
  await harness.advance(59_999)
  await harness.emit('turn.complete', transientFailure)
  assert.equal(harness.timers.length, 1, 'cooldown duplicates must share the pending retry')
  assert.equal(harness.submissions.length, 0)

  // Model an overdue clock callback: a new eligible turn replaces it before delivery.
  harness.elapse(1)
  await harness.emit('turn.complete', transientFailure)
  assert.equal(harness.timers.length, 2)
  await harness.runDue()
  assert.equal(harness.submissions.length, 0, 'an older timer cannot submit after replacement')
  await harness.advance(60_000)
  assert.equal(harness.submissions.length, 1)
  assertRetryRequests(harness)
})
