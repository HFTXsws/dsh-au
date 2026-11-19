import './isolate-net-log.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNetLog, recordClientEvent, recordRouteChange } from '../lib/net-log.js';

// Always own a temporary log target, even if the caller supplied a production override.
const previousNetLogPath = process.env.DSH_AU_NET_LOG;
process.env.DSH_AU_NET_LOG = join(mkdtempSync(join(tmpdir(), 'dsh-au-page-lifecycle-')), 'net.jsonl');
test.after(() => {
  if (previousNetLogPath === undefined) delete process.env.DSH_AU_NET_LOG;
  else process.env.DSH_AU_NET_LOG = previousNetLogPath;
});

// Execute the real factory fragments. React/ReactDOM are external dependencies, but these
// lifecycle tests render no components: no fake hooks or product helpers are needed.
function initializeFactory(browser) {
  const source = ['01-runtime.js', '04-actions.js']
    .map((file) => readFileSync(new URL(`../client/src/${file}`, import.meta.url), 'utf8'))
    .join('\n');
  const requireBoundary = (name) => {
    if (name === 'react' || name === 'react-dom') return {};
    throw new Error(`Unexpected factory dependency: ${name}`);
  };
  return new Function('require', 'window', 'navigator', 'fetch', `${source}\nreturn { reportClientEvent, installPageLifecycleTrace };`)(
    requireBoundary, browser.window, { platform: 'test', userAgent: 'test' }, browser.fetch,
  );
}

// Browser EventTarget, navigation/performance and HTTP are system boundaries. The events
// themselves use Node's real EventTarget; only browser metadata and network delivery are supplied.
function createBrowser(navigationType = 'reload') {
  const operations = [];
  class BrowserWindow extends EventTarget {
    addEventListener(type, listener, options) {
      operations.push({ action: 'add', type });
      super.addEventListener(type, listener, options);
    }
    removeEventListener(type, listener, options) {
      operations.push({ action: 'remove', type });
      super.removeEventListener(type, listener, options);
    }
  }
  const window = new BrowserWindow();
  let pageAgeMs = 0;
  window.name = '';
  window.performance = {
    getEntriesByType: (type) => type === 'navigation' ? [{ type: navigationType }] : [],
    now: () => pageAgeMs,
  };
  const requests = [];
  return {
    window, operations, requests,
    fetch(url, options) {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return Promise.resolve({ ok: true });
    },
    age(value) { pageAgeMs = value; },
    emit(type, persisted = false) {
      const event = new Event(type);
      Object.defineProperty(event, 'persisted', { value: persisted });
      window.dispatchEvent(event);
    },
  };
}

// Incident 2026-10-28 16:02:12: plugin hot replacement disposed both retained iframes.
// A fresh client ID alone cannot distinguish that event from a real document navigation.
test('hot replacement retains document identity while a new browser document gets a new identity', (t) => {
  const browser = createBrowser();
  const first = initializeFactory(browser);
  const disposeFirst = first.installPageLifecycleTrace();
  browser.age(1200);
  disposeFirst();
  const second = initializeFactory(browser);
  t.after(second.installPageLifecycleTrace());
  const freshBrowser = createBrowser();
  const third = initializeFactory(freshBrowser);
  t.after(third.installPageLifecycleTrace());

  const [started, disposed, restarted] = browser.requests.map((request) => request.body);
  const navigated = freshBrowser.requests[0].body;
  assert.deepEqual(browser.requests.map((request) => request.body.event), ['shell-started', 'shell-disposed', 'shell-started']);
  assert.ok(started.documentId && started.clientId);
  assert.equal(disposed.documentId, started.documentId);
  assert.equal(disposed.clientId, started.clientId);
  assert.equal(restarted.documentId, started.documentId, 'factory replacement is not a new page');
  assert.notEqual(restarted.clientId, started.clientId);
  assert.notEqual(navigated.documentId, started.documentId, 'real navigation must change document identity');
  assert.notEqual(navigated.clientId, restarted.clientId);
  assert.equal(restarted.navigationType, 'reload', 'hot replacement keeps the original navigation metadata');
});

test('page transitions distinguish BFCache and cleanup stops delivery without installing beforeunload', () => {
  const browser = createBrowser('navigate');
  const client = initializeFactory(browser);
  const dispose = client.installPageLifecycleTrace();
  try {
    for (const [type, persisted, age] of [
      ['pageshow', false, 100], ['pagehide', true, 200],
      ['pageshow', true, 300], ['pagehide', false, 400],
    ]) {
      browser.age(age);
      browser.emit(type, persisted);
    }
  } finally {
    dispose();
  }
  const records = browser.requests.map((request) => request.body);
  assert.deepEqual(records.map((record) => record.event), ['shell-started', 'page-shown', 'page-hidden', 'page-shown', 'page-hidden', 'shell-disposed']);
  assert.deepEqual(records.slice(1, 5).map((record) => record.result), ['normal', 'bfcache', 'bfcache', 'normal']);
  assert.deepEqual(records.slice(1, 5).map((record) => record.pageAgeMs), [100, 200, 300, 400]);
  assert.ok(records.every((record) => record.documentId === records[0].documentId && record.clientId === records[0].clientId));
  assert.ok(records.every((record) => record.navigationType === 'navigate'));
  assert.deepEqual(browser.operations, [
    { action: 'add', type: 'pageshow' }, { action: 'add', type: 'pagehide' },
    { action: 'remove', type: 'pageshow' }, { action: 'remove', type: 'pagehide' },
  ]);
  for (const { url, options, body } of browser.requests) {
    assert.equal(url, '/dsh-au/api');
    assert.equal(options.method, 'POST');
    assert.equal(options.keepalive, true, 'navigation must not cancel the diagnostic request');
    assert.equal(options.headers['content-type'], 'application/json');
    assert.equal(body.action, 'reportClientEvent', 'the API otherwise dispatches this payload as getState');
  }
  const before = browser.requests.length;
  browser.emit('pageshow', true);
  browser.emit('pagehide', false);
  assert.equal(browser.requests.length, before, 'disposed plugin listeners must not duplicate later page records');
});

test('client delivery owns its document and client IDs and uses the diagnostic API action', () => {
  const browser = createBrowser();
  const client = initializeFactory(browser);
  client.reportClientEvent('initial-session-focus', 'win', {
    documentId: 'forged-page', clientId: 'forged-client', action: 'getState',
    event: 'forged-event', deviceId: 'forged-device', sessionId: 'session-1', reason: 'running',
  });
  const { body, options } = browser.requests[0];
  assert.equal(body.action, 'reportClientEvent');
  assert.equal(body.event, 'initial-session-focus');
  assert.equal(body.deviceId, 'win');
  assert.notEqual(body.documentId, 'forged-page');
  assert.notEqual(body.clientId, 'forged-client');
  assert.equal(body.sessionId, 'session-1');
  assert.equal(options.keepalive, true);
});

test('real JSONL accepts lifecycle metadata but drops URLs, query secrets and body content', () => {
  const before = readNetLog().length;
  const names = ['shell-started', 'shell-disposed', 'page-shown', 'page-hidden', 'initial-session-focus', 'session-preload'];
  for (const event of names) recordClientEvent({
    event, deviceId: 'win', documentId: 'document-1', clientId: 'client-1',
    sessionId: 'session-1', navigationType: 'reload', pageAgeMs: 123.4,
    url: 'https://private.example/?token=private-query-secret', query: 'private-query-secret',
    body: 'private-body-content', headers: { authorization: 'private-authorization-secret' },
    extra: { body: 'private-body-content' },
  });
  recordClientEvent({
    event: 'page-hidden', documentId: 'https://private.example/?token=private-query-secret',
    sessionId: 'session?token=private-query-secret', navigationType: 'reload?token=private-query-secret', pageAgeMs: Infinity,
  });
  recordRouteChange({
    deviceId: 'win', documentId: 'document-1', clientId: 'client-1', reason: 'preference-change',
    fromRouteId: 'route-1', toRouteId: 'route-2', body: 'private-body-content', query: 'private-query-secret',
  });
  const records = readNetLog().slice(before).map((line) => JSON.parse(line));
  assert.deepEqual(records.slice(0, names.length).map((record) => record.event), names.map((name) => `client.${name}`));
  for (const record of records.slice(0, names.length)) {
    assert.equal(record.documentId, 'document-1');
    assert.equal(record.clientId, 'client-1');
    assert.equal(record.sessionId, 'session-1');
    assert.equal(record.navigationType, 'reload');
    assert.equal(record.pageAgeMs, 123);
  }
  const invalid = records[names.length];
  assert.equal(invalid.documentId, '');
  assert.equal(invalid.sessionId, '');
  assert.equal(invalid.navigationType, '');
  assert.equal(Object.hasOwn(invalid, 'pageAgeMs'), false);
  assert.equal(records.at(-1).event, 'route.change');
  assert.equal(records.at(-1).documentId, 'document-1');
  for (const record of records) {
    for (const key of ['url', 'query', 'body', 'headers', 'extra']) assert.equal(Object.hasOwn(record, key), false);
  }
  const raw = JSON.stringify(records);
  for (const secret of ['private-query-secret', 'private-body-content', 'private-authorization-secret']) assert.equal(raw.includes(secret), false);
});

test('performance JSONL keeps bounded timings and counts but rejects payloads and forged fields', () => {
  const before = readNetLog().length;
  recordClientEvent({ event: 'session-preload-stage', deviceId: 'example-mac', sessionId: 'session-1', requestId: 'request-1',
    stage: 'window-installed', result: 'ready', elapsedMs: 123.4, backendMs: 20.6, pageMs: 100, installMs: 2.8,
    syncMs: 4.2, recordCount: 50, queueLength: 7, generation: 1, attempt: 2, cacheHit: false, clientReady: true,
    records: [{ text: 'private-chat-payload' }], error: 'private-error-secret', runId: 'forged-run' });
  recordClientEvent({ event: 'session-open', deviceId: 'example-mac', requestId: 'request?token=private-query-secret', stage: 'open?secret',
    elapsedMs: Infinity, pageMs: -1, installMs: 86400001, recordCount: 1.5, queueLength: -1, generation: 1000000001,
    cacheHit: 'true', clientReady: 1 });
  const [valid, invalid] = readNetLog().slice(before).map((line) => JSON.parse(line));
  assert.equal(valid.event, 'client.session-preload-stage');
  assert.equal(valid.requestId, 'request-1');
  assert.equal(valid.stage, 'window-installed');
  assert.equal(valid.elapsedMs, 123);
  assert.equal(valid.installMs, 3);
  assert.equal(valid.recordCount, 50);
  assert.equal(valid.cacheHit, false);
  assert.equal(valid.clientReady, true);
  assert.notEqual(valid.runId, 'forged-run');
  for (const key of ['elapsedMs', 'pageMs', 'installMs', 'recordCount', 'queueLength', 'generation', 'cacheHit', 'clientReady']) {
    assert.equal(Object.hasOwn(invalid, key), false);
  }
  assert.equal(invalid.requestId, '');
  assert.equal(invalid.stage, '');
  assert.doesNotMatch(JSON.stringify([valid, invalid]), /private-chat-payload|private-error-secret|private-query-secret/);
});
