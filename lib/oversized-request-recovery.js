const OVERSIZED_RESPONSES_MESSAGE = 'Responses request exceeds 32 MiB';
const EXPLICIT_MESSAGE_413 = /\b(?:HTTP(?:\/API)?|API)\s*(?:status\s*)?413\b/i;

/** Only the known Responses 32 MiB rejection may enter this recovery path. */
function isOversizedResponsesFailure(failure) {
  const message = typeof failure?.message === 'string' ? failure.message : '';
  if (!message.includes(OVERSIZED_RESPONSES_MESSAGE)) return false;
  return failure.status === 413
    || failure.code === 'INVALID_REQUEST'
    || EXPLICIT_MESSAGE_413.test(message);
}

function compactionServiceFor(ctx, agent) {
  const presets = ctx.get?.('agentPresets');
  // A live preset registry owns service isolation; global fallback is only valid on older hosts without it.
  if (presets) return presets.serviceFor?.(agent, 'compaction');
  return ctx.get?.('compaction');
}

/**
 * Register the narrowly-scoped Responses 32 MiB recovery on a DSH host context.
 *
 * The per-agent attempt mark is the idempotency boundary for one live failure chain. It is
 * deliberately reset only when that agent becomes idle or its session commits a later
 * assistant/message, so a failed retry cannot loop while the active turn remains open.
 */
export function installOversizedRequestRecovery(ctx) {
  const attemptedAgents = new WeakSet();
  const agentsBySession = new WeakMap();
  const disposers = [];

  const remember = (agent) => {
    const session = agent?.session;
    if (!session || (typeof session !== 'object' && typeof session !== 'function')) return;
    let agents = agentsBySession.get(session);
    if (!agents) {
      agents = new Set();
      agentsBySession.set(session, agents);
    }
    agents.add(agent);
  };

  const clearAgent = (agent) => {
    if (!agent || (typeof agent !== 'object' && typeof agent !== 'function')) return;
    attemptedAgents.delete(agent);
    const session = agent.session;
    const agents = session && agentsBySession.get(session);
    if (!agents) return;
    agents.delete(agent);
    if (agents.size === 0) agentsBySession.delete(session);
  };

  disposers.push(ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
    if (!isOversizedResponsesFailure(failure) || signal?.aborted) return next();
    if (!agent || (typeof agent !== 'object' && typeof agent !== 'function')) return next();
    if (attemptedAgents.has(agent)) return next();

    let compaction;
    try {
      compaction = compactionServiceFor(ctx, agent);
    } catch {
      return next();
    }
    if (typeof compaction?.compactIfNeeded !== 'function') return next();

    const generation = agent.session?.surface?.replaceGeneration;
    attemptedAgents.add(agent);
    remember(agent);

    try {
      await compaction.compactIfNeeded(agent, 'context-overflow', signal);
    } catch {
      // The service may throw after committing its durable replacement; generation is authoritative below.
    }

    if (!signal?.aborted && agent.session?.surface?.replaceGeneration > generation) {
      return { kind: 'retry' };
    }
    return next();
  }));

  disposers.push(ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') clearAgent(agent);
  }));

  disposers.push(ctx.on('session/event', (session, event) => {
    if (event?.type !== 'assistant/message') return;
    const agents = agentsBySession.get(session);
    if (!agents) return;
    for (const agent of agents) attemptedAgents.delete(agent);
    agentsBySession.delete(session);
  }));

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const dispose of disposers.reverse()) {
      if (typeof dispose === 'function') dispose();
    }
  };
}

export const install = installOversizedRequestRecovery;
