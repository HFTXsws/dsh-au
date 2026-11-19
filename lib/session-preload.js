/**
 * Host-owned, read-only preparation leases for the remote 48-hour session rail.
 *
 * The only history seam used here is sessionQuery.observeSession().  A prepared
 * observation is kept as a native [Symbol.dispose] lease; no session is retained,
 * followed, activated, or written by this cache.
 */

const MAX_ENTRIES = 24;
const FRESH_WINDOW_MS = 48 * 60 * 60 * 1000;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/u;
const CLIENT_ID_RE = /^[A-Za-z0-9._:@/-]{1,128}$/u;

function clockOf(now) {
  if (typeof now === 'function') return () => Number(now()) || 0;
  if (Number.isFinite(Number(now))) return () => Number(now);
  return () => Date.now();
}

function epochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string' || !value.trim()) return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function validId(value, pattern = CLIENT_ID_RE) {
  return typeof value === 'string' && pattern.test(value);
}

function validSessionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function freshActivity(value, at) {
  const activity = epochMs(value);
  return activity >= at - FRESH_WINDOW_MS && activity <= at;
}

function resultOf(result, sessionId, updatedAt = 0, cursor = null) {
  const normalizedCursor = cursor === null || cursor === undefined
    ? null
    : (Number.isFinite(Number(cursor)) ? Number(cursor) : null);
  return { result, sessionId, updatedAt: Number(updatedAt) || 0, cursor: normalizedCursor };
}

function getService(ctx, name) {
  try {
    return ctx?.get?.(name) || ctx?.[name];
  } catch {
    return ctx?.[name];
  }
}

function recordId(record) {
  return record?.header?.id || record?.sessionId || record?.id || '';
}

function promptTime(record) {
  return epochMs(
    record?.projections?.values?.sessionListMetadata?.lastPromptAt
      || record?.projectionValues?.sessionListMetadata?.lastPromptAt
      || record?.lastPromptAt,
  );
}

function workspaceContains(workspace, sessionId, record) {
  if (!workspace || workspace.archived === true || workspace.isArchived === true) return false;
  if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) return true;
  const workspaceId = record?.header?.workspaceId || record?.workspaceId;
  return Boolean(workspaceId && workspace.workspaceId === workspaceId);
}

function eventsOf(observation) {
  const events = observation?.events || observation?.records || observation?.snapshot?.events;
  return Array.isArray(events) ? events.map((item) => item?.event || item).filter(Boolean) : null;
}

function observedActivity(observation, record) {
  const events = eventsOf(observation);
  let latest = 0;
  if (events) {
    for (const event of events) {
      if (!['user/message', 'assistant/message'].includes(event?.type)) continue;
      latest = Math.max(latest, epochMs(event?.time));
    }
  }
  const projection = epochMs(
    observation?.projections?.values?.sessionListMetadata?.lastPromptAt
      || observation?.projectionValues?.sessionListMetadata?.lastPromptAt
      || record?.projections?.values?.sessionListMetadata?.lastPromptAt
      || record?.projectionValues?.sessionListMetadata?.lastPromptAt
      || record?.lastPromptAt,
  );
  return Math.max(latest, projection);
}

function observationRevision(observation) {
  return observation?.revision === undefined || observation?.revision === null
    ? ''
    : String(observation.revision);
}

function disposeObservation(observation) {
  if (!observation || typeof observation !== 'object') return;
  try {
    const dispose = typeof Symbol.dispose === 'symbol' ? observation[Symbol.dispose] : null;
    if (typeof dispose === 'function') {
      const pending = dispose.call(observation);
      pending?.catch?.(() => {});
      return;
    }
    const asyncDispose = typeof Symbol.asyncDispose === 'symbol' ? observation[Symbol.asyncDispose] : null;
    if (typeof asyncDispose === 'function') {
      const pending = asyncDispose.call(observation);
      pending?.catch?.(() => {});
    }
  } catch {
    // A late or already-disposed native lease must never escape the host route.
  }
}

/**
 * Create one host-lifetime cache of native prepared observations.
 * @param {{ctx: object, now?: Function|number, setTimer?: Function, clearTimer?: Function}} options
 */
export function createSessionPreloadCache({ ctx, now, setTimer = setTimeout, clearTimer = clearTimeout, onDiagnostic } = {}) {
  const clock = clockOf(now);
  const entries = new Map();
  const flights = new Map();
  const requestFlights = new Map();
  let disposed = false;
  // 仅在目录/正文观察等边界记录，不在每条历史事件上打点。
  function diagnose(input, stage, startedAt, result = 'pending', cacheHit = false) {
    try {
      onDiagnostic?.({ sessionId: input.sessionId, clientId: input.clientId, requestId: input.requestId,
        stage, result, cacheHit, elapsedMs: Math.max(0, clock() - startedAt), cacheEntries: entries.size });
    } catch {}
  }

  function clearEntryTimer(entry) {
    if (entry.timer !== null) {
      try { clearTimer(entry.timer); } catch {}
      entry.timer = null;
    }
  }

  function removeEntry(entry) {
    if (entries.get(entry.sessionId) !== entry) return;
    entries.delete(entry.sessionId);
    clearEntryTimer(entry);
    entry.disposed = true;
    disposeObservation(entry.observation);
  }

  function scheduleEntry(entry) {
    clearEntryTimer(entry);
    const at = clock();
    const deadline = entry.expiresAt;
    if (deadline <= at) {
      // Freshness is inclusive at exactly 48 hours; defer disposal by one tick.
      try {
        entry.timer = setTimer(() => {
          entry.timer = null;
          if (!disposed && !entry.disposed && clock() > entry.expiresAt) removeEntry(entry);
          else if (!disposed && !entry.disposed) scheduleEntry(entry);
        }, 1);
      } catch {
        entry.timer = null;
      }
      entry.timer?.unref?.();
      return;
    }
    try {
      entry.timer = setTimer(() => {
        entry.timer = null;
        if (disposed || entry.disposed) return;
        if (clock() > entry.expiresAt) removeEntry(entry);
        else scheduleEntry(entry);
      }, Math.max(1, deadline - at));
    } catch {
      entry.timer = null;
    }
    entry.timer?.unref?.();
  }

  function pruneExpired() {
    const at = clock();
    for (const entry of entries.values()) {
      if (entry.expiresAt < at) removeEntry(entry);
    }
  }

  function addOwner(entry, clientId, requestId) {
    if (!entry.owners.has(clientId)) entry.owners.set(clientId, new Set());
    entry.owners.get(clientId).add(requestId);
    scheduleEntry(entry);
  }

  function removeOwner(entry, clientId, requestId = null) {
    const requests = entry.owners.get(clientId);
    if (!requests) return;
    if (requestId) requests.delete(requestId);
    else requests.clear();
    if (requests.size === 0) entry.owners.delete(clientId);
    if (entry.owners.size === 0) removeEntry(entry);
  }

  function requestKey(clientId, requestId) {
    return `${clientId}\u0000${requestId}`;
  }

  function findOwned(clientId, requestId, sessionId) {
    for (const entry of entries.values()) {
      if (entry.sessionId !== sessionId) continue;
      if (entry.owners.get(clientId)?.has(requestId)) return entry;
    }
    return null;
  }

  function currentRevisionKey(record, stat) {
    const revision = stat?.revision ?? record?.revision ?? record?.header?.revision ?? '';
    const prompt = promptTime(record);
    return `${revision === '' ? '' : String(revision)}|${prompt || ''}`;
  }

  async function inspectCatalog(sessionId, signal) {
    const query = getService(ctx, 'sessionQuery');
    if (typeof query?.listSessions !== 'function' || typeof query?.observeSession !== 'function') return { result: 'unsupported' };
    let records;
    try {
      records = await query.listSessions(signal);
    } catch (error) {
      if (signal?.aborted) return { result: 'skipped' };
      return { result: 'failed' };
    }
    const record = Array.isArray(records) ? records.find((item) => recordId(item) === sessionId) : null;
    if (!record) return { result: 'skipped' };
    // Never warm delegated/subagent history: a remote preload must not become an Agent activation path.
    if (record.header?.origin === 'subagent' || Number(record.header?.delegationDepth) > 0) return { result: 'skipped' };
    if (record.formatStatus !== 'current' && record.live !== true) return { result: 'skipped' };

    const registry = getService(ctx, 'workspaceRegistry');
    let workspaces;
    try { workspaces = registry?.list?.(); } catch { workspaces = null; }
    const archived = new Set(Array.isArray(registry?.archivedSessionIds) ? registry.archivedSessionIds : []);
    if (!Array.isArray(workspaces) || archived.has(sessionId)
      || !workspaces.some((workspace) => !archived.has(sessionId) && workspaceContains(workspace, sessionId, record))) {
      return { result: 'skipped' };
    }

    const persistence = getService(ctx, 'sessionPersistence');
    let stat = null;
    if (typeof persistence?.stat === 'function') {
      try {
        stat = await persistence.stat(sessionId, signal ? { signal } : undefined);
      } catch {
        if (signal?.aborted) return { result: 'skipped' };
        return { result: 'failed' };
      }
      if (stat && stat.header?.id && stat.header.id !== sessionId) return { result: 'skipped' };
      if (!stat && record.live !== true && record.formatStatus !== 'current') return { result: 'skipped' };
      if (stat?.formatStatus !== undefined && stat.formatStatus !== 'current' && record.live !== true) return { result: 'skipped' };
    }
    return {
      result: 'ready',
      query,
      record,
      revisionKey: currentRevisionKey(record, stat),
    };
  }

  function budgetAllows(sessionId, activity) {
    const existing = entries.get(sessionId);
    if (existing) return true;
    if (entries.size < MAX_ENTRIES) return true;
    const oldest = [...entries.values()]
      .sort((left, right) => left.updatedAt - right.updatedAt)[0];
    // Do not let an older sidebar-first warm churn a cache containing the newest set.
    return Boolean(oldest && activity > oldest.updatedAt);
  }

  function evictFor(sessionId, activity) {
    // Same-session revision replacement is safe: the old internal lease is
    // transferred below after the new observation has passed validation.
    if (entries.has(sessionId)) return true;
    if (entries.size < MAX_ENTRIES) return true;
    const oldest = [...entries.values()]
      .sort((left, right) => left.updatedAt - right.updatedAt)[0];
    if (!oldest || activity <= oldest.updatedAt) return false;
    removeEntry(oldest);
    return true;
  }

  async function readFlight(flight, catalog) {
    let observation;
    try {
      observation = await catalog.query.observeSession(flight.sessionId, {
        projectionMode: 'none',
        signal: flight.controller.signal,
      });
      if (!observation || typeof Symbol.dispose !== 'symbol' || typeof observation[Symbol.dispose] !== 'function') {
        return resultOf('unsupported', flight.sessionId);
      }
      if (flight.controller.signal.aborted || disposed) return resultOf('skipped', flight.sessionId);
      const at = clock();
      const activity = observedActivity(observation, catalog.record);
      if (!freshActivity(activity, at)) return resultOf('skipped', flight.sessionId);
      if (flight.waiters.size === 0 || !evictFor(flight.sessionId, activity)) return resultOf('skipped', flight.sessionId);
      const previous = entries.get(flight.sessionId);
      const carriedOwners = previous
        ? new Map([...previous.owners].map(([clientId, requestIds]) => [clientId, new Set(requestIds)]))
        : new Map();
      if (previous) removeEntry(previous);
      const entry = {
        sessionId: flight.sessionId,
        observation,
        revisionKey: catalog.revisionKey || observationRevision(observation),
        updatedAt: activity,
        cursor: observation.cursor ?? eventsOf(observation)?.at(-1)?.seq ?? null,
        expiresAt: activity + FRESH_WINDOW_MS,
        owners: carriedOwners,
        timer: null,
        disposed: false,
      };
      entries.set(entry.sessionId, entry);
      observation = null;
      scheduleEntry(entry);
      return resultOf('ready', entry.sessionId, entry.updatedAt, entry.cursor);
    } catch (error) {
      if (flight.controller.signal.aborted || disposed) return resultOf('skipped', flight.sessionId);
      return resultOf('failed', flight.sessionId);
    } finally {
      disposeObservation(observation);
    }
  }

  function startFlight(sessionId, catalog) {
    const flight = {
      sessionId,
      controller: new AbortController(),
      waiters: new Map(),
      promise: null,
    };
    flight.promise = readFlight(flight, catalog).finally(() => {
      if (flights.get(sessionId) === flight) flights.delete(sessionId);
      for (const [requestId, request] of requestFlights) {
        if (request.flight === flight) requestFlights.delete(requestId);
      }
    });
    flights.set(sessionId, flight);
    return flight;
  }

  async function preload(input = {}) {
    const sessionId = input.sessionId;
    const clientId = input.clientId;
    const requestId = input.requestId;
    if (disposed || !validId(clientId) || !validId(requestId, REQUEST_ID_RE) || !validSessionId(sessionId)) {
      return resultOf('unsupported', validSessionId(sessionId) ? sessionId : '');
    }
    const at = clock();
    const hintedActivity = epochMs(input.updatedAt);
    if (!freshActivity(hintedActivity, at)) return resultOf('skipped', sessionId, hintedActivity);
    pruneExpired();

    const owned = findOwned(clientId, requestId, sessionId);
    if (owned) {
      scheduleEntry(owned);
      diagnose(input, 'cache-hit', at, 'ready', true);
      return resultOf('ready', sessionId, hintedActivity, owned.cursor);
    }

    const key = requestKey(clientId, requestId);
    const existingRequest = requestFlights.get(key);
    if (existingRequest) return existingRequest.promise;

    // Register before the first catalog await so cancelSessionPreload can abort a slow list/stat.
    const pending = {
      key,
      clientId,
      requestId,
      sessionId,
      controller: new AbortController(),
      cancelled: false,
      flight: null,
      promise: null,
    };
    requestFlights.set(key, pending);

    const run = (async () => {
      let existingFlight = flights.get(sessionId);
      let catalog;
      if (!existingFlight) {
        diagnose(input, 'catalog', at);
        catalog = await inspectCatalog(sessionId, pending.controller.signal);
        diagnose(input, 'catalog', at, catalog.result);
        if (pending.cancelled || disposed || pending.controller.signal.aborted) return resultOf('skipped', sessionId, hintedActivity);
        if (catalog.result !== 'ready') return resultOf(catalog.result, sessionId, hintedActivity);
        // A parallel caller may have completed the same catalog check while this one awaited stat().
        existingFlight = flights.get(sessionId);
        const existing = entries.get(sessionId);
        if (!existingFlight && existing && existing.revisionKey === catalog.revisionKey && freshActivity(existing.updatedAt, at)) {
          addOwner(existing, clientId, requestId);
          diagnose(input, 'cache-hit', at, 'ready', true);
          return resultOf('ready', sessionId, hintedActivity, existing.cursor);
        }
        if (!existingFlight && !budgetAllows(sessionId, hintedActivity)) return resultOf('skipped', sessionId, hintedActivity);
      }
      if (pending.cancelled || disposed) return resultOf('skipped', sessionId, hintedActivity);

      const observeStartedAt = clock();
      diagnose(input, existingFlight ? 'shared-observation' : 'observation', observeStartedAt);
      const flight = existingFlight || startFlight(sessionId, catalog);
      pending.flight = flight;
      flight.waiters.set(key, pending);
      const result = await flight.promise;
      diagnose(input, 'observation', observeStartedAt, pending.cancelled ? 'cancelled' : result.result);
      if (!pending.cancelled && result.result === 'ready') {
        const entry = entries.get(sessionId);
        if (entry && !entry.disposed) addOwner(entry, clientId, requestId);
        // updatedAt is the caller's qualified hint; actual event freshness stays host-only.
        return resultOf('ready', sessionId, hintedActivity, entry?.cursor ?? result.cursor);
      }
      return result.result === 'ready'
        ? result
        : resultOf(result.result, sessionId, hintedActivity, result.cursor);
    })();
    const wrapped = run.finally(() => {
      if (requestFlights.get(key) === pending) requestFlights.delete(key);
    });
    pending.promise = wrapped;
    return wrapped;
  }

  function release({ clientId, sessionIds } = {}) {
    if (!validId(clientId)) return;
    const ids = Array.isArray(sessionIds) ? sessionIds : (validSessionId(sessionIds) ? [sessionIds] : []);
    for (const entry of entries.values()) {
      if (ids.length && !ids.includes(entry.sessionId)) continue;
      removeOwner(entry, clientId);
    }
  }

  function cancel({ clientId, requestId } = {}) {
    if (!validId(clientId) || !validId(requestId, REQUEST_ID_RE)) return;
    const key = requestKey(clientId, requestId);
    const request = requestFlights.get(key);
    if (request) {
      request.cancelled = true;
      try { request.controller.abort('cancelled'); } catch {}
      if (request.flight) {
        request.flight.waiters.delete(key);
        if (request.flight.waiters.size === 0) request.flight.controller.abort('cancelled');
      }
      requestFlights.delete(key);
      return;
    }
    // A completed request can still be released by its exact client/session owner.
    for (const entry of entries.values()) {
      if (entry.owners.get(clientId)?.has(requestId)) {
        removeOwner(entry, clientId, requestId);
        return;
      }
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const request of requestFlights.values()) {
      request.cancelled = true;
      try { request.controller?.abort('disposed'); } catch {}
    }
    for (const flight of flights.values()) flight.controller.abort('disposed');
    flights.clear();
    requestFlights.clear();
    for (const entry of [...entries.values()]) removeEntry(entry);
    entries.clear();
  }

  return { preload, release, cancel, dispose };
}

export const SESSION_PRELOAD_LIMIT = MAX_ENTRIES;
export const SESSION_PRELOAD_FRESH_WINDOW_MS = FRESH_WINDOW_MS;
