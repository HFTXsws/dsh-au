import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAckStore } from '../lib/ack-store.js';

function withTempFile(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-au-acks-'));
  try {
    return run(join(dir, 'nested', 'dsh-au.acks.json'), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('missing or corrupted file loads as empty', () => {
  withTempFile((file, dir) => {
    assert.equal(createAckStore({ filePath: file }).get('s1'), -1);
    writeFileSync(join(dir, 'bad.json'), '{not json', 'utf8');
    assert.equal(createAckStore({ filePath: join(dir, 'bad.json') }).get('s1'), -1);
  });
});

test('acks survive a restart and only ever move forward', () => {
  withTempFile((file) => {
    const first = createAckStore({ filePath: file });
    first.set('s1', 7);
    first.set('s1', 3);
    first.set('s2', 12);
    first.flush();
    const second = createAckStore({ filePath: file });
    assert.equal(second.get('s1'), 7);
    assert.equal(second.get('s2'), 12);
    assert.equal(second.get('unknown'), -1);
  });
});

test('nothing is written until something is acknowledged, and invalid input is ignored', () => {
  withTempFile((file) => {
    const store = createAckStore({ filePath: file });
    store.set('', 1);
    store.set('s1', Number.NaN);
    store.flush();
    assert.equal(existsSync(file), false);
  });
});

test('the file keeps only the most recent entries and no session content', () => {
  withTempFile((file) => {
    const store = createAckStore({ filePath: file });
    for (let index = 0; index < 600; index += 1) store.set(`s${index}`, index);
    store.flush();
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.version, 1);
    assert.equal(Object.keys(saved.acks).length, 500);
    assert.equal(saved.acks.s599, 599);
    assert.equal(saved.acks.s0, undefined);
    assert.deepEqual(Object.keys(saved).sort(), ['acks', 'version']);
  });
});
