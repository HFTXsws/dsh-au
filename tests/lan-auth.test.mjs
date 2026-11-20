import test from 'node:test';
import assert from 'node:assert/strict';
import { createLanAuthLimiter, hashLanPassword, normalizeLanPasswordHash, readBasicAuthPassword, verifyLanPassword } from '../lib/lan-auth.js';

test('局域网密码只存哈希，校验正确与错误密码', () => {
  const stored = hashLanPassword('lan-secret');
  assert.doesNotMatch(stored, /lan-secret/);
  assert.equal(normalizeLanPasswordHash(stored), stored);
  assert.equal(verifyLanPassword('lan-secret', stored), true);
  assert.equal(verifyLanPassword('wrong', stored), false);
  assert.equal(verifyLanPassword('lan-secret', 'broken'), false);
  assert.equal(normalizeLanPasswordHash('plain-text'), '');
});

test('Basic Auth 头只取密码，账号任意', () => {
  const header = `Basic ${Buffer.from('anyone:p:w').toString('base64')}`;
  assert.equal(readBasicAuthPassword(header), 'p:w');
  assert.equal(readBasicAuthPassword(''), null);
  assert.equal(readBasicAuthPassword('Bearer x'), null);
});

test('连续输错后锁定，到期解锁', () => {
  let clock = 0;
  const limiter = createLanAuthLimiter({ maxFailures: 3, lockMs: 1000, now: () => clock });
  for (let i = 0; i < 3; i += 1) limiter.fail('10.0.0.2');
  assert.equal(limiter.isLocked('10.0.0.2'), true);
  assert.equal(limiter.isLocked('10.0.0.3'), false);
  clock = 1001;
  assert.equal(limiter.isLocked('10.0.0.2'), false);
});
