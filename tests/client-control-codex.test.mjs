import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { completedReplyAfter, createCodexProvider } from '../lib/client-control/codex-provider.js';
import { createCodexRequestStateStore } from '../lib/client-control/codex-request-state.js';
import { createClientControlIpcServer } from '../lib/client-control/ipc-server.js';

function userEvent(requestId) {
  return { seq: 1, type: 'user/message', data: { message: {
    id: requestId, role: 'user', content: [{ type: 'text', text: 'ask' }],
    source: { kind: 'cordis-host-runner', rpcId: requestId },
  } } };
}

function completedEvents(requestId, text = 'OK') {
  return [
    userEvent(requestId),
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } },
    { seq: 3, type: 'turn/end', data: {} },
  ];
}

function temporaryStateDirectory(t, prefix = 'dsh-au-codex-state-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'state');
}

test('completedReplyAfter preserves only ordered assistant text through turn/end', () => {
  const events = [
    { seq: 0, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'OLD' }] } } },
    userEvent('req-1'),
    { seq: 2, type: 'assistant/message', data: { message: { content: [
      { type: 'thinking', thinking: 'PRIVATE' },
      { type: 'text', text: '  原文\r\n' },
      { type: 'tool_use', input: { secret: 'NO' } },
    ] } } },
    { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '🙂  ' }] } } },
    { seq: 4, type: 'turn/end', data: {} },
  ];
  assert.equal(completedReplyAfter(events, 'req-1'), '  原文\r\n🙂  ');
  assert.equal(completedReplyAfter(events.slice(0, -1), 'req-1'), null);
});

test('Codex provider creates a session, sends once, then returns exact reply', async (t) => {
  const stateDir = temporaryStateDirectory(t);
  const prompts = [];
  let reads = 0;
  const ctx = {
    get(name) {
      if (name === 'sessionController') return {
        create: async (request) => {
          assert.deepEqual(request, { cwd: 'F:/Project' });
          return { sessionId: 'session:F:/Project' };
        },
        prompt: async (request, signal) => {
          assert.equal(signal instanceof AbortSignal, true);
          prompts.push(request);
          return { accepted: true };
        },
      };
      if (name === 'sessionQuery') return { observeSession: async () => ({ events: [], [Symbol.asyncDispose]: async () => {} }) };
      return null;
    },
    sessions: { get: () => null },
  };
  const provider = createCodexProvider({
    ctx,
    stateDir,
    readEvents: async () => {
      reads += 1;
      return reads === 1 ? [] : [
        userEvent('stable-request'),
        { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'OK' }] } } },
        { seq: 3, type: 'turn/end', data: {} },
      ];
    },
    sleep: async () => {},
  });
  const result = await provider.prompt({ cwd: 'F:/Project', text: 'reply OK', requestId: 'stable-request', timeoutMs: 1_000 });
  assert.deepEqual(result, { ok: true, sessionId: 'session:F:/Project', text: 'OK', deduplicated: false });
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].requestId, 'stable-request');
});

test('Codex provider fails before sending when session creation is unavailable', async (t) => {
  const stateDir = temporaryStateDirectory(t);
  let sent = false;
  const ctx = { get: () => ({ prompt: async () => { sent = true; } }) };
  const provider = createCodexProvider({
    ctx,
    stateDir,
    createSession: async () => ({ ok: false, error: 'no workspace' }),
  });
  await assert.rejects(
    provider.prompt({ cwd: '/missing', text: 'hello', requestId: 'r1' }),
    /no workspace/,
  );
  assert.equal(sent, false);
});

test('timeout retry without sessionId reuses the persisted session and never resends', async (t) => {
  const stateDir = temporaryStateDirectory(t);
  const requestId = 'timeout-retry';
  const rawReply = '  原文\r\n🙂  ';
  let clock = 0;
  let creates = 0;
  let sends = 0;
  let complete = false;
  const controller = {
    create: async () => {
      creates += 1;
      return { sessionId: 'created-session' };
    },
    prompt: async () => {
      sends += 1;
      return { accepted: true };
    },
  };
  const ctx = { get: (name) => (name === 'sessionController' ? controller : null) };
  const readEvents = async () => {
    if (!sends) return [];
    return complete ? completedEvents(requestId, rawReply) : [userEvent(requestId)];
  };
  const first = createCodexProvider({
    ctx,
    stateDir,
    readEvents,
    now: () => clock,
    sleep: async () => { clock += 5; },
  });

  await assert.rejects(
    first.prompt({ cwd: 'F:/Project', text: 'reply OK', requestId, timeoutMs: 10 }),
    /timed out/,
  );
  complete = true;

  // A fresh provider instance represents a process restart and must resume read-only.
  const restarted = createCodexProvider({ ctx, stateDir, readEvents });
  const result = await restarted.prompt({ cwd: 'F:/Project', text: 'reply OK', requestId, timeoutMs: 1_000 });
  assert.deepEqual(result, {
    ok: true,
    sessionId: 'created-session',
    text: rawReply,
    deduplicated: true,
  });
  assert.equal(creates, 1);
  assert.equal(sends, 1);

  const stateFiles = readdirSync(stateDir).filter((name) => name.endsWith('.json'));
  assert.equal(stateFiles.length, 1);
  const statePath = join(stateDir, stateFiles[0]);
  const stateText = readFileSync(statePath, 'utf8');
  assert.doesNotMatch(stateText, /reply OK|原文/);
  if (process.platform !== 'win32') {
    assert.equal(statSync(stateDir).mode & 0o777, 0o700);
    assert.equal(statSync(statePath).mode & 0o777, 0o600);
  }
});

test('concurrent calls with the same sessionId and requestId cross the send boundary once', async (t) => {
  const stateDir = temporaryStateDirectory(t);
  const requestId = 'parallel-request';
  const rawReply = '\nparallel raw\r\n';
  let sends = 0;
  let events = [];
  const controller = {
    prompt: async () => {
      sends += 1;
      await new Promise((done) => setTimeout(done, 20));
      events = completedEvents(requestId, rawReply);
      return { accepted: true };
    },
  };
  const ctx = { get: (name) => (name === 'sessionController' ? controller : null) };
  const providers = [
    createCodexProvider({ ctx, stateDir, readEvents: async () => events }),
    createCodexProvider({ ctx, stateDir, readEvents: async () => events }),
  ];
  const request = { sessionId: 'existing-session', text: 'hello', requestId, timeoutMs: 1_000 };

  const results = await Promise.all(providers.map((provider) => provider.prompt(request)));
  assert.equal(sends, 1);
  assert.deepEqual(results.map((result) => result.text), [rawReply, rawReply]);
  assert.deepEqual(results.map((result) => result.deduplicated).sort(), [false, true]);
});

test('a restarted provider recovers a lost send result from events without resending', async (t) => {
  const stateDir = temporaryStateDirectory(t);
  const requestId = 'lost-send-result';
  const rawReply = '  recovered\nverbatim  ';
  let sends = 0;
  let events = [];
  const controller = {
    prompt: async () => {
      sends += 1;
      events = completedEvents(requestId, rawReply);
      throw new Error('host response lost after acceptance');
    },
  };
  const ctx = { get: (name) => (name === 'sessionController' ? controller : null) };
  const first = createCodexProvider({ ctx, stateDir, readEvents: async () => events });
  const request = { sessionId: 'existing-session', text: 'hello', requestId, timeoutMs: 1_000 };

  await assert.rejects(first.prompt(request), /host response lost/);
  const store = createCodexRequestStateStore({ stateDir });
  const staleLock = `${store.pathFor(requestId)}.lock`;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(staleLock, `${JSON.stringify({ pid: 2_147_483_647, token: 'crashed-owner' })}\n`, 'utf8');

  const restarted = createCodexProvider({ ctx, stateDir, readEvents: async () => events });
  const result = await restarted.prompt(request);
  assert.equal(result.text, rawReply);
  assert.equal(result.deduplicated, true);
  assert.equal(sends, 1);
});

test('requestId reuse with different prompt parameters is rejected before another send', async (t) => {
  const stateDir = temporaryStateDirectory(t);
  const variants = [
    { sessionId: 'session-a', cwd: 'F:/Project', text: 'changed text' },
    { sessionId: 'session-a', cwd: 'F:/Other', text: 'original text' },
    { sessionId: 'session-b', cwd: 'F:/Project', text: 'original text' },
  ];

  for (const [index, changed] of variants.entries()) {
    const requestId = `bound-request-${index}`;
    let sends = 0;
    let events = [];
    const controller = {
      prompt: async () => {
        sends += 1;
        events = completedEvents(requestId);
        return { accepted: true };
      },
    };
    const ctx = { get: (name) => (name === 'sessionController' ? controller : null) };
    const provider = createCodexProvider({ ctx, stateDir, readEvents: async () => events });
    const original = {
      sessionId: 'session-a',
      cwd: 'F:/Project',
      text: 'original text',
      requestId,
      timeoutMs: 1_000,
    };
    await provider.prompt(original);
    await assert.rejects(provider.prompt({ ...changed, requestId, timeoutMs: 1_000 }), /different parameters/);
    assert.equal(sends, 1);
  }
});

test('client-control IPC rotates a private token after restart and rejects unauthorized requests', async (t) => {
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-au-ipc-test-'));
  t.after(() => rmSync(dshHome, { recursive: true, force: true }));
  const ctx = { get: () => null };
  const first = createClientControlIpcServer({ ctx, dshHome, profile: 'token-test' });
  let second;
  await first.start();
  try {
    const firstToken = readFileSync(first.paths.tokenPath, 'utf8').trim();
    await assert.rejects(first.dispatch({ token: 'wrong', provider: 'codex', action: 'capabilities' }), /Unauthorized/);
    const capabilities = await first.dispatch({ token: firstToken, provider: 'codex', action: 'capabilities' });
    assert.deepEqual(capabilities.actions, ['prompt']);

    await first.close();
    second = createClientControlIpcServer({ ctx, dshHome, profile: 'token-test' });
    await second.start();
    const secondToken = readFileSync(second.paths.tokenPath, 'utf8').trim();
    assert.notEqual(secondToken, firstToken);
    await assert.rejects(second.dispatch({ token: firstToken, provider: 'codex', action: 'capabilities' }), /Unauthorized/);
  } finally {
    await second?.close();
    await first.close();
  }
});
