import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { getRepoRoot, resolveSyncDir } from './sync-repo.js';

export const MODEL_SHORTCUTS_SCHEMA_VERSION = 1;
export const MODEL_SHORTCUT_SLOT_COUNT = 9;
export const DEFAULT_MODEL_SHORTCUT_BINDING = Object.freeze({
  code: 'KeyM',
  ctrl: false,
  alt: true,
  shift: false,
  meta: false,
});

const ROOT_FIELDS = new Set(['schemaVersion', 'enabled', 'binding', 'slots']);
const BINDING_FIELDS = new Set(['code', 'ctrl', 'alt', 'shift', 'meta']);
const MODEL_FIELDS = new Set(['provider', 'model', 'label', 'reasoningEffort']);
const SENSITIVE_FIELD = /(?:password|passwd|token|secret|api[_-]?key|apikey|credential|cookie|authorization|access[_-]?key|private[_-]?key|auth)/i;

/** 默认关闭；槽位始终保留 9 个固定位置，未配置项用 null 占位。 */
export function createDefaultModelShortcuts() {
  return {
    enabled: false,
    binding: { ...DEFAULT_MODEL_SHORTCUT_BINDING },
    slots: Array.from({ length: MODEL_SHORTCUT_SLOT_COUNT }, () => null),
  };
}

/** 本机配置目录：与 dsh-au.config.json 同目录，可用 DSH_HOME 覆盖。 */
function dshHome() {
  return process.env.DSH_HOME || path.join(homedir(), '.dsh');
}

/** 旧版共享配置文件：仅用于一次性迁移到本机，迁移后不再读取。 */
export function legacyModelShortcutsPath(repoRoot = getRepoRoot()) {
  return path.join(resolveSyncDir({ repoRoot }), 'cloud', 'model-shortcuts.json');
}

/** 模型快捷槽位现在按电脑独立保存，默认落在本机配置目录。 */
export function resolveModelShortcutsPath(filePath = '') {
  if (typeof filePath === 'string' && filePath) return filePath;
  if (process.env.DSH_AU_MODEL_SHORTCUTS_PATH) return process.env.DSH_AU_MODEL_SHORTCUTS_PATH;
  return path.join(dshHome(), 'model-shortcuts.json');
}

export class ModelShortcutsError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'ModelShortcutsError';
    this.code = code;
    this.status = status;
  }
}

function fail(message, code = 'INVALID', status = 400) {
  throw new ModelShortcutsError(message, code, status);
}

function assertPlainObject(value, message, code = 'INVALID', status = 400) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(message, code, status);
}

function assertKnownFields(value, fields, message) {
  for (const key of Object.keys(value)) {
    if (fields.has(key)) continue;
    if (SENSITIVE_FIELD.test(key)) fail(message, 'SENSITIVE_FIELD');
    fail(message, 'UNKNOWN_FIELD');
  }
}

function normalizeBinding(value) {
  if (value === null) return null;
  assertPlainObject(value, '模型快捷键 binding 必须是对象或 null');
  assertKnownFields(value, BINDING_FIELDS, '模型快捷键 binding 含有不允许的字段');
  if (typeof value.code !== 'string' || !value.code.trim() || value.code.length > 32) {
    fail('模型快捷键 binding.code 无效');
  }
  for (const key of ['ctrl', 'alt', 'shift', 'meta']) {
    if (typeof value[key] !== 'boolean') fail('模型快捷键 binding 修饰键必须是布尔值');
  }
  return {
    code: value.code.trim(),
    ctrl: value.ctrl,
    alt: value.alt,
    shift: value.shift,
    meta: value.meta,
  };
}

function normalizeSlot(value) {
  if (value === null) return null;
  assertPlainObject(value, '模型快捷键槽位必须是对象或 null');
  // 先拦截敏感字段，再统一使用不泄露字段名的错误，避免把凭据回显到 API。
  assertKnownFields(value, MODEL_FIELDS, '模型快捷键槽位含有不允许的字段');
  for (const key of ['provider', 'model']) {
    if (typeof value[key] !== 'string' || !value[key].trim()) fail('模型快捷键槽位缺少有效的 provider/model');
  }
  for (const key of ['label', 'reasoningEffort']) {
    if (Object.hasOwn(value, key) && typeof value[key] !== 'string') {
      fail('模型快捷键槽位的可选字段必须是字符串');
    }
  }
  const slot = {
    provider: value.provider.trim(),
    model: value.model.trim(),
  };
  if (Object.hasOwn(value, 'label')) slot.label = value.label;
  if (Object.hasOwn(value, 'reasoningEffort')) slot.reasoningEffort = value.reasoningEffort;
  return slot;
}

function normalizeSlots(value) {
  if (!Array.isArray(value)) fail('模型快捷键 slots 必须是数组');
  if (value.length > MODEL_SHORTCUT_SLOT_COUNT) fail('模型快捷键最多支持 9 个槽位');
  const slots = value.map(normalizeSlot);
  while (slots.length < MODEL_SHORTCUT_SLOT_COUNT) slots.push(null);
  return slots;
}

function normalizeModelShortcuts(value, { persisted = false } = {}) {
  assertPlainObject(value, '模型快捷键配置必须是 JSON 对象', persisted ? 'CORRUPT' : 'INVALID', persisted ? 500 : 400);
  assertKnownFields(value, ROOT_FIELDS, '模型快捷键配置含有不允许的字段');
  if (Object.hasOwn(value, 'schemaVersion') && value.schemaVersion !== MODEL_SHORTCUTS_SCHEMA_VERSION) {
    fail('模型快捷键配置 schemaVersion 不受支持', 'CORRUPT', persisted ? 500 : 400);
  }
  const defaults = createDefaultModelShortcuts();
  if (Object.hasOwn(value, 'enabled') && typeof value.enabled !== 'boolean') {
    fail('模型快捷键 enabled 必须是布尔值', persisted ? 'CORRUPT' : 'INVALID', persisted ? 500 : 400);
  }
  return {
    enabled: Object.hasOwn(value, 'enabled') ? value.enabled : defaults.enabled,
    binding: Object.hasOwn(value, 'binding') ? normalizeBinding(value.binding) : defaults.binding,
    slots: Object.hasOwn(value, 'slots') ? normalizeSlots(value.slots) : defaults.slots,
  };
}

function optionsFilePath(options) {
  if (typeof options === 'string') return resolveModelShortcutsPath(options);
  return resolveModelShortcutsPath(options?.filePath || '');
}

function corrupt(message = '模型快捷键配置文件损坏，未覆盖原配置') {
  return new ModelShortcutsError(message, 'CORRUPT', 500);
}

/** 读取本机配置；首次升级时把旧版仓库共享文件迁移到本机，之后只认本机。 */
export function readModelShortcuts(options = {}) {
  const filePath = optionsFilePath(options);
  if (!existsSync(filePath)) {
    const migrated = migrateLegacyModelShortcuts(filePath, options);
    if (migrated) return migrated;
    return { filePath, modelShortcuts: createDefaultModelShortcuts(), exists: false };
  }
  let parsed;
  try {
    const raw = readFileSync(filePath, 'utf8');
    parsed = raw.trim() ? JSON.parse(raw) : null;
  } catch {
    throw corrupt();
  }
  try {
    return {
      filePath,
      modelShortcuts: normalizeModelShortcuts(parsed, { persisted: true }),
      exists: true,
    };
  } catch (error) {
    if (error instanceof ModelShortcutsError && error.code === 'CORRUPT') throw error;
    throw corrupt('模型快捷键配置内容无效，未覆盖原配置');
  }
}

function atomicWrite(filePath, modelShortcuts) {
  const directory = path.dirname(filePath);
  const payload = `${JSON.stringify({ schemaVersion: MODEL_SHORTCUTS_SCHEMA_VERSION, ...modelShortcuts }, null, 2)}\n`;
  let tempPath = '';
  try {
    mkdirSync(directory, { recursive: true });
    tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
    writeFileSync(tempPath, payload, { encoding: 'utf8', mode: 0o644 });
    renameSync(tempPath, filePath);
  } catch {
    if (tempPath) {
      try { unlinkSync(tempPath); } catch {}
    }
    throw new ModelShortcutsError('模型快捷键配置写入失败，原配置未覆盖', 'WRITE_FAILED', 500);
  }
}

/**
 * 一次性迁移：把旧版仓库共享配置复制到本机。
 * 只在默认路径、且没有显式指定文件时执行；旧文件原样保留，作为回滚备份。
 */
function migrateLegacyModelShortcuts(filePath, options = {}) {
  if (options.filePath || typeof options === 'string') return null;
  if (process.env.DSH_AU_MODEL_SHORTCUTS_PATH) return null;
  const legacyPath = legacyModelShortcutsPath(options.repoRoot || getRepoRoot(options));
  if (!existsSync(legacyPath)) return null;
  try {
    const raw = readFileSync(legacyPath, 'utf8');
    const modelShortcuts = normalizeModelShortcuts(raw.trim() ? JSON.parse(raw) : null, { persisted: true });
    atomicWrite(filePath, modelShortcuts);
    return { filePath, modelShortcuts, exists: true, migratedFrom: legacyPath };
  } catch {
    // 旧文件损坏或本机目录不可写时保持默认值，不阻断插件启动。
    return null;
  }
}

/** 每次写入都重新读取磁盘，再只合并请求中出现的顶层字段。 */
export function saveModelShortcuts(patch, options = {}) {
  assertPlainObject(patch, '模型快捷键保存内容必须是 JSON 对象');
  assertKnownFields(patch, new Set(['enabled', 'binding', 'slots']), '模型快捷键保存内容含有不允许的字段');
  const current = readModelShortcuts(options);
  const next = normalizeModelShortcuts({
    ...current.modelShortcuts,
    ...patch,
  });
  atomicWrite(current.filePath, next);
  return { filePath: current.filePath, modelShortcuts: next, exists: true };
}

export { normalizeModelShortcuts };


