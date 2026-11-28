import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const VALID_EXT_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const VALID_SECRET_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const STORE_VERSION = 1;

function assertValidExtId(extId) {
  const id = typeof extId === 'string' ? extId.trim() : '';
  if (!VALID_EXT_ID_RE.test(id) || FORBIDDEN_KEYS.has(id)) {
    throw new Error(`非法扩展 ID: ${String(extId)}`);
  }
  return id;
}

function assertValidKey(key) {
  const clean = typeof key === 'string' ? key.trim() : '';
  if (!VALID_SECRET_KEY_RE.test(clean) || FORBIDDEN_KEYS.has(clean)) {
    throw new Error(`非法私密存储键名: ${String(key)}`);
  }
  return clean;
}

/**
 * 解析扩展私密存储文件路径：
 * 优先 opts.secretsPath，其次 DSH_AU_EXT_SECRETS_PATH，默认 <DSH_HOME|~/.dsh>/dsh-au/ext-secrets.json。
 */
export function resolveExtSecretsPath(opts = {}) {
  const explicit = typeof opts?.secretsPath === 'string' ? opts.secretsPath.trim() : '';
  if (explicit) return path.resolve(explicit);

  const envPath = typeof process.env.DSH_AU_EXT_SECRETS_PATH === 'string'
    ? process.env.DSH_AU_EXT_SECRETS_PATH.trim()
    : '';
  if (envPath) return path.resolve(envPath);

  const dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME.trim()
    : path.join(homedir(), '.dsh');
  return path.join(dshHome, 'dsh-au', 'ext-secrets.json');
}

function readSecretsDoc(filePath) {
  if (!existsSync(filePath)) {
    return { version: STORE_VERSION, extensions: {} };
  }
  const rawText = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').trim();
  if (!rawText) {
    return { version: STORE_VERSION, extensions: {} };
  }
  const parsed = JSON.parse(rawText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('扩展私密存储文件格式损坏');
  }
  const rawExts = parsed.extensions && typeof parsed.extensions === 'object' && !Array.isArray(parsed.extensions)
    ? parsed.extensions
    : {};
  return {
    version: STORE_VERSION,
    extensions: rawExts,
  };
}

function writeSecretsDoc(filePath, doc) {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch {}

  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  const payload = `${JSON.stringify({ version: STORE_VERSION, extensions: doc.extensions }, null, 2)}\n`;
  try {
    writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
    try { chmodSync(tmpPath, 0o600); } catch {}
    renameSync(tmpPath, filePath);
    try { chmodSync(filePath, 0o600); } catch {}
  } catch (err) {
    try { rmSync(tmpPath, { force: true }); } catch {}
    throw err;
  }
}

export function getExtSecret(extId, key, opts = {}) {
  const validExtId = assertValidExtId(extId);
  const validKey = assertValidKey(key);
  const filePath = resolveExtSecretsPath(opts);
  const doc = readSecretsDoc(filePath);
  const ns = Object.hasOwn(doc.extensions, validExtId) ? doc.extensions[validExtId] : null;
  if (!ns || typeof ns !== 'object' || !Object.hasOwn(ns, validKey)) return '';
  return typeof ns[validKey] === 'string' ? ns[validKey] : '';
}

export function setExtSecret(extId, key, value, opts = {}) {
  const validExtId = assertValidExtId(extId);
  const validKey = assertValidKey(key);
  const strValue = value == null ? '' : String(value);
  const filePath = resolveExtSecretsPath(opts);
  const doc = readSecretsDoc(filePath);
  const currentNs = Object.hasOwn(doc.extensions, validExtId) && doc.extensions[validExtId] && typeof doc.extensions[validExtId] === 'object'
    ? { ...doc.extensions[validExtId] }
    : {};

  if (strValue === '') {
    delete currentNs[validKey];
  } else {
    currentNs[validKey] = strValue;
  }

  if (Object.keys(currentNs).length === 0) {
    delete doc.extensions[validExtId];
  } else {
    doc.extensions[validExtId] = currentNs;
  }

  writeSecretsDoc(filePath, doc);
  return { ok: true };
}

export function deleteExtSecret(extId, key, opts = {}) {
  return setExtSecret(extId, key, '', opts);
}

export function clearExtSecrets(extId, opts = {}) {
  const validExtId = assertValidExtId(extId);
  const filePath = resolveExtSecretsPath(opts);
  const doc = readSecretsDoc(filePath);
  if (Object.hasOwn(doc.extensions, validExtId)) {
    delete doc.extensions[validExtId];
    writeSecretsDoc(filePath, doc);
  }
  return { ok: true };
}

export function listExtSecretKeys(extId, opts = {}) {
  const validExtId = assertValidExtId(extId);
  const filePath = resolveExtSecretsPath(opts);
  const doc = readSecretsDoc(filePath);
  const ns = Object.hasOwn(doc.extensions, validExtId) ? doc.extensions[validExtId] : null;
  if (!ns || typeof ns !== 'object') return [];
  return Object.keys(ns)
    .filter((k) => VALID_SECRET_KEY_RE.test(k) && !FORBIDDEN_KEYS.has(k) && typeof ns[k] === 'string')
    .sort();
}

/**
 * 创建绑定到指定扩展命名空间的只隔离密钥存储视图，
 * 防止扩展读写其他扩展的私密数据。
 */
export function createExtSecretStore(extId, opts = {}) {
  const validExtId = assertValidExtId(extId);
  const boundOpts = opts?.secretsPath ? { secretsPath: opts.secretsPath } : {};
  return {
    get: (key) => getExtSecret(validExtId, key, boundOpts),
    set: (key, value) => setExtSecret(validExtId, key, value, boundOpts),
    delete: (key) => deleteExtSecret(validExtId, key, boundOpts),
    clear: () => clearExtSecrets(validExtId, boundOpts),
    listKeys: () => listExtSecretKeys(validExtId, boundOpts),
    has: (key) => getExtSecret(validExtId, key, boundOpts).length > 0,
  };
}
