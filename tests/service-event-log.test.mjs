import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendServiceEvent,
  readServiceEvents,
  SERVICE_EVENT_LOG_MAX_TAIL,
} from '../lib/service-event-log.js';

function createFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-au-service-events-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, filePath: join(directory, 'logs', 'services.jsonl') };
}

function parseLines(filePath) {
  return readFileSync(filePath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
}

test('append persists the required lifecycle fields and optional process details', (t) => {
  const { filePath } = createFixture(t);

  assert.equal(appendServiceEvent({
    event: 'service.control.completed',
    serviceId: 'worker',
    action: 'start',
    ok: true,
    message: 'started',
    pid: 321,
    exitCode: 0,
    source: 'manual',
  }, { filePath }), true);

  const [saved] = parseLines(filePath);
  assert.match(saved.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual({ ...saved, ts: undefined }, {
    ts: undefined,
    event: 'service.control.completed',
    serviceId: 'worker',
    action: 'start',
    ok: true,
    message: 'started',
    pid: 321,
    exitCode: 0,
    source: 'manual',
  });
});

test('append redacts credential assignments, auth headers, cookies, and URL userinfo', (t) => {
  const { filePath } = createFixture(t);
  const secrets = ['p1', 'p2', 't3', 's4', 'a5', 'c6', 'o7', 'x8', 'b9', 'u10', 'p11', 'c12', 'c13', 'aws14', 'aws15'];
  const message = [
    'password=p1 passwd:p2 token t3 secret=\'s4\' api_key="a5" credential=c6',
    'OPENAI_API_KEY=o7 x-api-key: x8 Authorization: Basic b9',
    'AWS_SECRET_ACCESS_KEY=aws14 AWS_ACCESS_KEY_ID=aws15',
    'endpoint=https://u10:p11@example.test/v1',
    'Cookie: session=c12; refresh=c13',
  ].join('\n');

  appendServiceEvent({ event: 'failed', serviceId: 'worker', action: 'start', ok: false, message }, { filePath });

  const [saved] = parseLines(filePath);
  for (const secret of secrets) assert.doesNotMatch(saved.message, new RegExp(secret));
  assert.match(saved.message, /OPENAI_API_KEY=\[REDACTED\]/);
  assert.match(saved.message, /x-api-key: \[REDACTED\]/);
  assert.match(saved.message, /AWS_SECRET_ACCESS_KEY=\[REDACTED\]/);
  assert.match(saved.message, /AWS_ACCESS_KEY_ID=\[REDACTED\]/);
  assert.match(saved.message, /Authorization: Basic \[REDACTED\]/);
  assert.match(saved.message, /https:\/\/\[REDACTED\]:\[REDACTED\]@example\.test/);
  assert.match(saved.message, /Cookie: \[REDACTED\]/);
});

test('append also redacts credential-like values from structured fields', (t) => {
  const { filePath } = createFixture(t);
  appendServiceEvent({
    event: 'service.control',
    serviceId: 'OPENAI_API_KEY=field-secret',
    action: 'token field-token',
    ok: false,
    message: 'failed',
    source: 'Authorization: Basic field-basic',
  }, { filePath });

  const [saved] = parseLines(filePath);
  for (const secret of ['field-secret', 'field-token', 'field-basic']) {
    assert.doesNotMatch(JSON.stringify(saved), new RegExp(secret));
  }
});

test('append rotates the current file to a single .1 backup before exceeding its limit', (t) => {
  const { filePath } = createFixture(t);
  appendServiceEvent({ event: 'first', serviceId: 'worker', action: 'start', ok: true, message: 'one' }, { filePath });
  const firstSize = statSync(filePath).size;

  appendServiceEvent(
    { event: 'second', serviceId: 'worker', action: 'stop', ok: true, message: 'two' },
    { filePath, maxBytes: firstSize + 1 },
  );

  assert.equal(parseLines(`${filePath}.1`)[0].event, 'first');
  assert.equal(parseLines(filePath)[0].event, 'second');
});

test('append reports an unwritable path without throwing into service control', (t) => {
  const { directory } = createFixture(t);
  const blockingFile = join(directory, 'not-a-directory');
  writeFileSync(blockingFile, 'block', 'utf8');
  const filePath = join(blockingFile, 'services.jsonl');

  let result;
  assert.doesNotThrow(() => {
    result = appendServiceEvent({ event: 'failed', serviceId: 'worker', action: 'start', ok: false, message: 'no disk' }, { filePath });
  });
  assert.equal(result, false);
});

test('tail returns the newest events in write order and enforces its upper bound', (t) => {
  const { filePath } = createFixture(t);
  const total = SERVICE_EVENT_LOG_MAX_TAIL + 3;
  for (let index = 0; index < total; index += 1) {
    appendServiceEvent({
      event: `event-${index}`,
      serviceId: 'worker',
      action: 'probe',
      ok: true,
      message: `message-${index}`,
    }, { filePath });
  }

  const events = readServiceEvents({ filePath, limit: SERVICE_EVENT_LOG_MAX_TAIL + 50 });
  assert.equal(events.length, SERVICE_EVENT_LOG_MAX_TAIL);
  assert.equal(events[0].event, 'event-3');
  assert.equal(events.at(-1).event, `event-${total - 1}`);
});

test('service manager persists control outcomes and restores them after a DSH restart', async (t) => {
  const { directory, filePath } = createFixture(t);
  const machineId = 'event-log-fixture';
  const env = {
    DSH_HOME: join(directory, 'dsh-home'),
    DSH_AU_LOCAL_DIR: join(directory, 'local'),
    DSH_AU_MACHINES_DIR: join(directory, 'machines'),
    DSH_AU_LOCAL_POINTER_PATH: join(directory, 'active.json'),
    DSH_AU_LOCAL_STATE_PATH: join(directory, 'state.json'),
    DSH_AU_CONFIG_PATH: join(directory, 'config.json'),
    DSH_AU_CLOUD_MANIFEST_PATH: join(directory, 'cloud.json'),
    DSH_AU_AUWIN_ROOT: join(directory, 'absent-auwin'),
    DSH_AU_STARTUP_DIR: join(directory, 'startup'),
    DSH_AU_PID_DIR: join(directory, 'pids'),
    DSH_AU_LOCAL_BINDINGS_PATH: undefined,
  };
  const previous = Object.keys(env).map((key) => [key, process.env[key]]);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  mkdirSync(env.DSH_AU_MACHINES_DIR, { recursive: true });
  writeFileSync(env.DSH_AU_LOCAL_POINTER_PATH, JSON.stringify({ schemaVersion: 1, machineId }));
  writeFileSync(join(env.DSH_AU_MACHINES_DIR, `${machineId}.json`), JSON.stringify({ schemaVersion: 2, machineId, services: {} }));
  writeFileSync(env.DSH_AU_CLOUD_MANIFEST_PATH, JSON.stringify({ schemaVersion: 1, services: {}, devices: [] }));

  try {
    const { createBackgroundServiceManager } = await import(`../lib/background-services.js?event-log-isolation=${Date.now()}`);
    const serviceEventLog = { filePath };
    const firstManager = createBackgroundServiceManager({ serviceEventLog });
    const result = await firstManager.controlService('missing-service', 'start', { source: 'user' });
    assert.equal(result.ok, false);
    const events = readServiceEvents({ filePath, limit: 10 });
    assert.deepEqual(events.map((event) => [event.event, event.action, event.ok, event.source]), [
      ['service.control.request', 'start', true, 'user'],
      ['service.control.result', 'start', false, 'user'],
    ]);

    const restored = createBackgroundServiceManager({ serviceEventLog }).getLogsById()['missing-service'];
    assert.equal(restored.length, 2);
    assert.match(restored[1].text, /持久日志 .* start: 未知后台服务/);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
