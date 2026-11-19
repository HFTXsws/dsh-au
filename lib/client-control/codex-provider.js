import { randomUUID } from 'node:crypto';
import { readSessionEventsAfter } from '../session-reader.js';
import { ClientControlError, assertControl } from './errors.js';
import {
  codexRequestFingerprint,
  createCodexRequestStateStore,
} from './codex-request-state.js';

const STATE_PHASES = new Set([
  'ready',
  'create_intent',
  'session_created',
  'send_intent',
  'accepted',
  'complete',
]);

function eventOf(item) {
  return item?.event || item;
}

function messageOf(event) {
  return event?.data?.message || event?.data || event?.payload?.message || event?.payload || null;
}

/** Preserve assistant text block order and contents; do not trim or add separators. */
export function rawMessageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function acceptedRequest(event, requestId) {
  if (event?.type !== 'user/message') return false;
  const message = messageOf(event);
  return message?.id === requestId
    || message?.source?.rpcId === requestId
    || message?.source?.requestId === requestId;
}

function hasAcceptedRequest(events, requestId) {
  return (events || []).some((item) => acceptedRequest(eventOf(item), requestId));
}

/**
 * Return one completed assistant turn following this request, or null while incomplete.
 * Tool/thinking payloads and later user turns are never returned.
 */
export function completedReplyAfter(events, requestId) {
  let accepted = false;
  let finished = false;
  const parts = [];
  for (const item of events || []) {
    const event = eventOf(item);
    if (!accepted) {
      accepted = acceptedRequest(event, requestId);
      continue;
    }
    if (event?.type === 'user/message') break;
    if (event?.type === 'assistant/message') parts.push(rawMessageText(messageOf(event)));
    if (event?.type === 'turn/end') {
      finished = true;
      break;
    }
  }
  return accepted && finished ? parts.join('') : null;
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function assertStoredRequest(state, requestId, parametersSha256) {
  const structurallyValid = state?.version === 1
    && state.provider === 'codex'
    && state.action === 'prompt'
    && state.requestId === requestId
    && typeof state.sessionId === 'string'
    && STATE_PHASES.has(state.phase);
  if (!structurallyValid) {
    throw new ClientControlError('Persisted Codex request state is invalid', {
      code: 'INVALID_STATE',
    });
  }
  if (state.parametersSha256 !== parametersSha256) {
    throw new ClientControlError('Request ID was already used with different parameters', {
      code: 'REQUEST_ID_REUSED',
    });
  }
  if (!state.sessionId && !['ready', 'create_intent'].includes(state.phase)) {
    throw new ClientControlError('Persisted Codex request state has no target session', {
      code: 'INVALID_STATE',
    });
  }
}

export function createCodexProvider({
  ctx,
  createSession,
  readEvents = readSessionEventsAfter,
  sleep = wait,
  now = Date.now,
  stateDir,
  lockTimeoutMs,
} = {}) {
  assertControl(ctx, 'Codex provider requires the DSH plugin context');
  const store = createCodexRequestStateStore({ stateDir, lockTimeoutMs });

  function sessionCreator() {
    const controller = ctx.get?.('sessionController') || ctx.sessionController;
    return typeof createSession === 'function'
      ? createSession
      : (typeof controller?.create === 'function' ? (request) => controller.create(request) : null);
  }

  async function createTargetSession(state, cwd, persist) {
    if (state.sessionId) return state.sessionId;
    if (state.phase === 'create_intent') {
      throw new ClientControlError(
        'Previous Codex session creation outcome is unknown; refusing to create a second session',
        { code: 'SESSION_CREATE_OUTCOME_UNKNOWN' },
      );
    }

    const create = sessionCreator();
    assertControl(create, 'Current DSH host cannot create a Codex session');
    persist('create_intent');
    const created = await create({ cwd });
    if (created?.ok === false) {
      // The host explicitly confirmed that no session was created, so a later retry remains safe.
      persist('ready');
      throw new ClientControlError(created?.error?.message || created?.error || 'Codex session creation failed');
    }
    const createdId = created?.sessionId || created?.value?.sessionId || created?.session?.id || '';
    if (!createdId) {
      throw new ClientControlError(
        'Codex session creation returned no session ID; refusing an unsafe retry',
        { code: 'SESSION_CREATE_OUTCOME_UNKNOWN' },
      );
    }
    state.sessionId = createdId;
    persist('session_created');
    return createdId;
  }

  async function prompt({ sessionId = '', cwd = '', text, requestId = randomUUID(), timeoutMs = 180_000 } = {}) {
    assertControl(typeof text === 'string' && text.trim(), 'Codex prompt must be nonempty');
    assertControl(typeof requestId === 'string' && requestId.trim(), 'Codex requestId is required');
    assertControl(Number.isFinite(timeoutMs) && timeoutMs > 0, 'Codex timeout must be positive');
    const parametersSha256 = codexRequestFingerprint({ sessionId, cwd, text });

    return store.withLock(requestId, async () => {
      let state = store.load(requestId);
      if (state) {
        assertStoredRequest(state, requestId, parametersSha256);
      } else {
        state = {
          version: 1,
          provider: 'codex',
          action: 'prompt',
          requestId,
          parametersSha256,
          sessionId,
          phase: sessionId ? 'session_created' : 'ready',
          createdAt: now(),
          updatedAt: now(),
        };
        store.save(requestId, state);
      }

      const persist = (phase) => {
        state.phase = phase;
        state.updatedAt = now();
        store.save(requestId, state);
      };
      const targetSessionId = await createTargetSession(state, cwd, persist);
      const controller = ctx.get?.('sessionController') || ctx.sessionController;
      assertControl(typeof controller?.prompt === 'function', 'Current DSH host has no sessionController.prompt');

      let events = await readEvents(ctx, targetSessionId, -1);
      let alreadyAccepted = hasAcceptedRequest(events, requestId);
      if (alreadyAccepted && !['accepted', 'complete'].includes(state.phase)) persist('accepted');

      let sentNow = false;
      if (!alreadyAccepted && state.phase === 'session_created') {
        // Persist intent before crossing the host boundary: an unknown outcome is read-only forever.
        persist('send_intent');
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(new ClientControlError('Codex prompt acceptance timed out')), timeoutMs);
        try {
          const accepted = await controller.prompt({
            sessionId: targetSessionId,
            requestId,
            mode: 'queue',
            content: [{ type: 'text', text }],
          }, abort.signal);
          assertControl(accepted?.accepted === true, accepted?.error?.message || 'Codex prompt was not accepted');
          sentNow = true;
          persist('accepted');
        } finally {
          clearTimeout(timer);
        }
        events = await readEvents(ctx, targetSessionId, -1);
      }

      const deadline = now() + timeoutMs;
      while (true) {
        const reply = completedReplyAfter(events, requestId);
        if (reply !== null) {
          persist('complete');
          return {
            ok: true,
            sessionId: targetSessionId,
            text: reply,
            deduplicated: !sentNow,
          };
        }
        if (now() >= deadline) {
          throw new ClientControlError('Codex reply timed out; retry with the same requestId to read without duplicate send');
        }
        await sleep(250);
        events = await readEvents(ctx, targetSessionId, -1);
      }
    });
  }

  return { prompt };
}
