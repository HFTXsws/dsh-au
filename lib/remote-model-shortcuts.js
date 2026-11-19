import { randomUUID } from 'node:crypto';

const MAX_ID_LENGTH = 128;
const MAX_PROVIDER_LENGTH = 128;
const MAX_MODEL_LENGTH = 256;
const MAX_EFFORT_LENGTH = 64;
const MAX_GROUPS = 128;
const MAX_MODELS_PER_GROUP = 512;
const MAX_EFFORTS_PER_MODEL = 64;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value, maxLength) {
  if (typeof value !== 'string') return '';
  const result = value.trim();
  return result && result.length <= maxLength ? result : '';
}

function failure(error, status = 400) {
  return { ok: false, error, status };
}

function validateKeys(value, allowed, label) {
  if (!isPlainObject(value)) return `${label}必须是对象`;
  if (Object.keys(value).some((key) => !allowed.has(key))) return `${label}含有不支持的字段`;
  return '';
}

function validateRouteAddress(body) {
  const keyError = validateKeys(body, new Set(['deviceId', 'routeId']), '请求');
  if (keyError) return keyError;
  if (!cleanString(body.deviceId, MAX_ID_LENGTH)) return '缺少有效 deviceId';
  if (!cleanString(body.routeId, MAX_ID_LENGTH)) return '缺少有效 routeId';
  return '';
}

function validateSelectionRequest(body) {
  const keyError = validateKeys(body, new Set(['deviceId', 'routeId', 'sessionId', 'selection']), '请求');
  if (keyError) return keyError;
  for (const field of ['deviceId', 'routeId', 'sessionId']) {
    if (!cleanString(body[field], field === 'sessionId' ? MAX_ID_LENGTH * 2 : MAX_ID_LENGTH)) {
      return `缺少有效 ${field}`;
    }
  }
  const selectionError = validateKeys(body.selection, new Set(['provider', 'model', 'reasoningEffort']), 'selection');
  if (selectionError) return selectionError;
  if (!cleanString(body.selection.provider, MAX_PROVIDER_LENGTH)) return '缺少有效 provider';
  if (!cleanString(body.selection.model, MAX_MODEL_LENGTH)) return '缺少有效 model';
  if (Object.hasOwn(body.selection, 'reasoningEffort')
    && !cleanString(body.selection.reasoningEffort, MAX_EFFORT_LENGTH)) {
    return 'reasoningEffort 无效';
  }
  return '';
}

function normalizeSelection(raw, limits = {}) {
  if (!isPlainObject(raw)) return null;
  const provider = cleanString(raw.provider, limits.provider || MAX_PROVIDER_LENGTH);
  const model = cleanString(raw.model, limits.model || MAX_MODEL_LENGTH);
  if (!provider || !model) return null;
  const result = { provider, model };
  if (Object.hasOwn(raw, 'reasoningEffort')) {
    const effort = cleanString(raw.reasoningEffort, limits.effort || MAX_EFFORT_LENGTH);
    if (!effort) return null;
    result.reasoningEffort = effort;
  }
  return result;
}

function sanitizeCatalog(raw) {
  if (!isPlainObject(raw) || !Array.isArray(raw.groups)) return null;
  const groups = [];
  for (const rawGroup of raw.groups.slice(0, MAX_GROUPS)) {
    if (!isPlainObject(rawGroup)) continue;
    const id = cleanString(rawGroup.id, MAX_PROVIDER_LENGTH);
    const name = cleanString(rawGroup.name, MAX_PROVIDER_LENGTH);
    if (!id || !name || !Array.isArray(rawGroup.models)) continue;
    const models = [];
    for (const rawModel of rawGroup.models.slice(0, MAX_MODELS_PER_GROUP)) {
      if (!isPlainObject(rawModel)) continue;
      const modelId = cleanString(rawModel.id, MAX_MODEL_LENGTH);
      const modelName = cleanString(rawModel.name, MAX_MODEL_LENGTH);
      if (!modelId || !modelName) continue;
      const model = { id: modelId, name: modelName };
      const rawReasoning = rawModel.reasoning;
      if (isPlainObject(rawReasoning) && Array.isArray(rawReasoning.efforts)) {
        const efforts = [];
        for (const rawEffort of rawReasoning.efforts.slice(0, MAX_EFFORTS_PER_MODEL)) {
          if (!isPlainObject(rawEffort)) continue;
          const effortId = cleanString(rawEffort.id, MAX_EFFORT_LENGTH);
          const effortName = cleanString(rawEffort.name, MAX_EFFORT_LENGTH);
          if (effortId && effortName) efforts.push({ id: effortId, name: effortName });
        }
        const reasoning = { efforts };
        const defaultEffort = cleanString(rawReasoning.defaultEffort, MAX_EFFORT_LENGTH);
        if (defaultEffort && efforts.some((effort) => effort.id === defaultEffort)) {
          reasoning.defaultEffort = defaultEffort;
        }
        model.reasoning = reasoning;
      }
      models.push(model);
    }
    groups.push({ id, name, models });
  }

  const defaultSelection = normalizeSelection(raw.default);
  let safeDefault = null;
  if (defaultSelection) {
    const group = groups.find((item) => item.id === defaultSelection.provider);
    const model = group?.models.find((item) => item.id === defaultSelection.model);
    const efforts = model?.reasoning?.efforts || [];
    if (group && model && (!defaultSelection.reasoningEffort
      || efforts.some((effort) => effort.id === defaultSelection.reasoningEffort))) {
      safeDefault = defaultSelection;
    }
  }

  // current deliberately stays null: the catalog endpoint has no session identity.
  return { groups, default: safeDefault, current: null };
}

function classifyBridgeFailure(response) {
  if (response?.status === 400) return failure(response.error, 400);
  if (response?.httpStatus === 404 || response?.httpStatus === 405) {
    return failure('远端 DSH 不支持模型快捷切换接口', 501);
  }
  return failure('远端模型请求失败', 502);
}

function unwrapNativeResponse(response, operation, expectedRpcId) {
  if (!response || typeof response !== 'object') return failure(`远端${operation}请求失败`, 502);
  if (response.ok === false && response.type !== 'server-response') return classifyBridgeFailure(response);
  if (response.httpStatus && (response.httpStatus < 200 || response.httpStatus >= 300)) {
    return classifyBridgeFailure(response);
  }
  if (response.type !== 'server-response') return failure(`远端${operation}响应无效`, 502);
  if (typeof response.rpcId !== 'string' || response.rpcId !== expectedRpcId) {
    return failure(`远端${operation}响应校验失败`, 502);
  }
  if (!isPlainObject(response.result) || response.result.ok !== true) {
    return failure(`远端${operation}被拒绝`, 502);
  }
  return { ok: true, value: response.result.value };
}

/** 后端专用远程模型接缝：只构造官方 client-request，不透传客户端附加字段。 */
export function createRemoteModelShortcuts({ runtimeBridge }) {
  async function requestNative(deviceId, routeId, method, args, operation) {
    const rpcId = randomUUID();
    const request = {
      type: 'client-request',
      rpcId,
      method,
      payload: { args },
    };
    const response = await runtimeBridge.requestDevice(deviceId, '/api', request, { routeId });
    return unwrapNativeResponse(response, operation, rpcId);
  }

  async function getRemoteModelCatalog(body) {
    const validation = validateRouteAddress(body);
    if (validation) return failure(validation, 400);
    const deviceId = body.deviceId.trim();
    const routeId = body.routeId.trim();
    const result = await requestNative(deviceId, routeId, 'session/modelCatalog', { }, '模型目录');
    if (!result.ok) return result;
    const catalog = sanitizeCatalog(result.value);
    return catalog ? { ok: true, catalog } : failure('远端模型目录格式无效', 502);
  }

  async function selectRemoteModel(body) {
    const validation = validateSelectionRequest(body);
    if (validation) return failure(validation, 400);
    const deviceId = body.deviceId.trim();
    const routeId = body.routeId.trim();
    const sessionId = body.sessionId.trim();
    const selection = normalizeSelection(body.selection);
    const request = { sessionId, provider: selection.provider, model: selection.model };
    if (selection.reasoningEffort) request.reasoningEffort = selection.reasoningEffort;
    const result = await requestNative(deviceId, routeId, 'session/selectModel', { request }, '模型选择');
    if (!result.ok) return result;
    const selected = normalizeSelection(result.value?.selected);
    if (!selected
      || selected.provider !== selection.provider
      || selected.model !== selection.model
      || (selection.reasoningEffort && selected.reasoningEffort !== selection.reasoningEffort)) {
      return failure('远端模型选择响应无效', 502);
    }
    return { ok: true, selected };
  }

  return { getRemoteModelCatalog, selectRemoteModel };
}
