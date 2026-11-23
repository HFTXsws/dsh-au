import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invokePrivateExtensionAction } from './private-extensions.js';

export const BRIDGED_EXT_SESSION_PREFIX = '0000e870-';
export const BRIDGED_EXT_LLM_PROVIDER = 'dsh-au-ext-bridge';
const SESSION_FORMAT_VERSION = 4;

// dshSessionId -> { extId, itemId, title, cwd, modelSpec, turnCount, entryCount }
const bridgedSessionMap = new Map();
// `${extId}::${itemId}` -> { dshSessionId, generation, firstEntryId, entryCount, turnCount }
const bridgedItemState = new Map();

/** 判断会话 ID 是否为外部扩展转接生成的 DSH 原生会话（用于在本机默认工作区列表中隐藏）。 */
export function isBridgedExtSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId.toLowerCase().startsWith(BRIDGED_EXT_SESSION_PREFIX);
}

/** 根据扩展 ID、条目 ID 与代次生成确定性的合法 v4 UUID（固定以 0000e870- 开头）。 */
export function toBridgedDshSessionId(extId, itemId, generation = 0) {
  const hash = createHash('sha256')
    .update(`${extId}::${itemId}::${generation}`)
    .digest('hex');
  return `0000e870-${hash.slice(0, 4)}-4${hash.slice(4, 7)}-8${hash.slice(7, 10)}-${hash.slice(10, 22)}`;
}

/** 将扩展返回的混合历史条目归一为成对的 (user, assistant) 对话回合。 */
export function groupEntriesIntoTurns(entries = [], extId = '') {
  const turns = [];
  let pendingUser = null;

  const formatEntryMarkdown = (entry) => {
    if (!entry || typeof entry !== 'object') return '';
    if (entry.type === 'attachment') {
      const title = `### 📄 ${entry.fileName || '附件'}`;
      const src = entry.sourcePath || entry.url || '';
      const body = entry.previewContent ? `\n\n\`\`\`markdown\n${entry.previewContent}\n\`\`\`` : '';
      return `${title}${src ? `\n> 路径: \`${src}\`` : ''}${body}`;
    }
    const parts = [];
    if (entry.role === 'peer' && entry.fromAgentName) {
      parts.push(`**[来自 ${entry.fromAgentName}]**`);
    }
    if (typeof entry.content === 'string' && entry.content.trim()) {
      parts.push(entry.content.trim());
    }
    if (Array.isArray(entry.images) && entry.images.length > 0) {
      for (const img of entry.images) {
        const url = img?.resolvedUrl || (String(img?.url || '').startsWith('http') ? img.url : '');
        const alt = img?.alt || '图片';
        parts.push(url ? `![${alt}](${url})` : `*[图片: ${alt}]*`);
      }
    }
    return parts.join('\n\n').trim();
  };

  for (const raw of Array.isArray(entries) ? entries : []) {
    const text = formatEntryMarkdown(raw);
    if (!text) continue;
    const ts = Number(raw.timestampMs) > 0 ? Number(raw.timestampMs) : Date.now();
    const isUser = raw.role === 'user';

    if (isUser) {
      if (pendingUser) {
        turns.push({
          userText: pendingUser.text,
          userTime: pendingUser.ts,
          assistantText: pendingUser.assistantText || '（此提问无记录回复）',
          assistantTime: pendingUser.assistantTime || (pendingUser.ts + 1),
          model: pendingUser.model || extId,
        });
      }
      pendingUser = { text, ts, assistantText: '', assistantTime: ts, model: extId };
    } else {
      if (!pendingUser) {
        pendingUser = {
          text: '（历史记录上下文）',
          ts: Math.max(1, ts - 1),
          assistantText: '',
          assistantTime: ts,
          model: raw.model || extId,
        };
      }
      pendingUser.assistantText = pendingUser.assistantText
        ? `${pendingUser.assistantText}\n\n${text}`
        : text;
      pendingUser.assistantTime = Math.max(pendingUser.assistantTime || pendingUser.ts, ts);
      if (raw.model) pendingUser.model = raw.model;
    }
  }

  if (pendingUser) {
    turns.push({
      userText: pendingUser.text,
      userTime: pendingUser.ts,
      assistantText: pendingUser.assistantText || '（等待回复中…）',
      assistantTime: Math.max(pendingUser.ts + 1, pendingUser.assistantTime || 0),
      model: pendingUser.model || extId,
    });
  }
  return turns;
}

/** 将归一化后的对话回合列表构造为符合 DSH v4 规范的连续事件流。 */
export function buildDshSeedEvents({
  dshSessionId,
  extId,
  itemId,
  title = '',
  turns = [],
  startSeq = 0,
  startTurn = 1,
}) {
  const events = [];
  let seq = startSeq;
  let clock = turns[0]?.userTime || Date.now();
  const modelSpec = `${extId}::${itemId}`;

  const add = (type, data, extra = {}) => {
    const evt = {
      seq,
      time: clock,
      type,
      data,
      ...extra,
    };
    seq += 1;
    events.push(evt);
    return evt;
  };

  if (startSeq === 0) {
    add('model/selection', {
      provider: BRIDGED_EXT_LLM_PROVIDER,
      model: modelSpec,
    });
    const cleanTitle = String(title || itemId || extId).trim().slice(0, 60);
    if (cleanTitle) {
      add('session/title', {
        title: cleanTitle,
        messageSeqs: [],
        source: { kind: 'user' },
      });
    }
  }

  for (let i = 0; i < turns.length; i += 1) {
    const t = turns[i];
    const turnNum = startTurn + i;
    clock = Math.max(clock, Number(t.userTime) || Date.now());
    add('turn/start', { turn: turnNum });
    add('step/start', { turn: turnNum, step: 1 });

    if (turnNum === 1 && startSeq === 0) {
      add('system/message', {
        turn: 1,
        step: 1,
        message: {
          id: `${dshSessionId}:sys:1`,
          role: 'system',
          content: [],
          source: { kind: 'system-prompt' },
        },
      }, { surfaceOp: 'append' });
    }

    add('user/message', {
      id: `${dshSessionId}:u:${turnNum}`,
      role: 'user',
      content: [{ type: 'text', text: String(t.userText || '') }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' });

    clock = Math.max(clock, Number(t.assistantTime) || clock);
    const replyText = String(t.assistantText || '');
    add('assistant/message', {
      turn: turnNum,
      step: 1,
      message: {
        id: `${dshSessionId}:a:${turnNum}`,
        role: 'assistant',
        content: [{ type: 'text', text: replyText }],
        source: {
          kind: 'model',
          provider: BRIDGED_EXT_LLM_PROVIDER,
          model: modelSpec,
        },
      },
      stream: [
        { type: 'chunk', time: clock, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
        { type: 'chunk', time: clock, chunk: { type: 'text-delta', index: 0, text: replyText } },
        { type: 'chunk', time: clock, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: replyText } } },
        { type: 'chunk', time: clock, chunk: { type: 'finish', reason: { kind: 'stop' } } },
      ],
    }, { surfaceOp: 'append' });

    add('step/end', { turn: turnNum, step: 1 });
    add('turn/end', { turn: turnNum, reason: { kind: 'completed' } });
  }

  return events;
}

async function writeOrAppendPersistence(ctx, header, { extId, itemId, title, turns }, state) {
  const sessionsSvc = ctx?.get?.('sessions') || ctx?.sessions;
  const persistence = ctx?.get?.('sessionPersistence') || ctx?.sessionPersistence;
  const projectionCache = ctx?.get?.('sessionProjectionCache') || ctx?.sessionProjectionCache;

  const liveSession = typeof sessionsSvc?.get === 'function' ? sessionsSvc.get(header.id) : null;
  if (liveSession && typeof liveSession.append === 'function') {
    const deltaTurns = turns.slice(state.turnCount);
    if (deltaTurns.length > 0) {
      const newTurnEvents = buildDshSeedEvents({
        dshSessionId: header.id,
        extId,
        itemId,
        title,
        turns: deltaTurns,
        startSeq: state.seqCount,
        startTurn: state.turnCount + 1,
      });
      const batch = newTurnEvents.map((evt) => (
        evt.surfaceOp ? [evt.type, evt.data, { surfaceOp: evt.surfaceOp }] : [evt.type, evt.data]
      ));
      liveSession.append(batch);
      if (typeof sessionsSvc.flush === 'function') {
        await sessionsSvc.flush(liveSession);
      }
      state.seqCount += newTurnEvents.length;
      state.turnCount = turns.length;
    }
    return { persisted: true, mode: 'live', dshSessionId: header.id };
  }

  if (!persistence || typeof persistence.create !== 'function') {
    return { persisted: false, mode: 'memory-only', dshSessionId: header.id };
  }

  let handle = null;
  let created = false;
  let targetHeader = header;
  try {
    handle = await persistence.create(targetHeader);
    created = true;
  } catch {
    if (typeof persistence.open === 'function') {
      try {
        handle = await persistence.open(targetHeader.id, 'write');
      } catch {
        handle = null;
      }
    }
    // 已有磁盘文件损坏（如 stored log is corrupt）时，尝试删除或轮换到下一代 ID 重建
    if (!handle) {
      if (typeof persistence.delete === 'function') {
        try { await persistence.delete(targetHeader.id); } catch {}
      }
      try {
        handle = await persistence.create(targetHeader);
        created = true;
      } catch {
        state.generation += 1;
        targetHeader = {
          ...targetHeader,
          id: toBridgedDshSessionId(extId, itemId, state.generation),
        };
        state.dshSessionId = targetHeader.id;
        handle = await persistence.create(targetHeader);
        created = true;
      }
    }
  }
  if (!handle) return { persisted: false, mode: 'unavailable', dshSessionId: targetHeader.id };

  try {
    if (created) {
      const allEvents = buildDshSeedEvents({
        dshSessionId: targetHeader.id,
        extId,
        itemId,
        title,
        turns,
        startSeq: 0,
        startTurn: 1,
      });
      if (allEvents.length > 0) await handle.append(allEvents);
      await handle.flush?.();
      projectionCache?.coldSnapshot?.(targetHeader, 0, allEvents);
      state.turnCount = turns.length;
      state.seqCount = allEvents.length;
      return { persisted: true, mode: 'created', dshSessionId: targetHeader.id };
    }

    const existing = typeof handle.read === 'function' ? await handle.read() : { events: [] };
    const existingEvents = Array.isArray(existing?.events) ? existing.events : [];
    const existingTurnStarts = existingEvents.filter((e) => e?.type === 'turn/start').length;
    const existingTurnEnds = existingEvents.filter((e) => e?.type === 'turn/end').length;

    // 若磁盘上存在未闭合的 turn 或已有回合数多于外部当前回合数，轮换到下一代 ID 重建
    if (existingTurnStarts !== existingTurnEnds || existingTurnEnds > turns.length) {
      if (typeof handle.close === 'function') await handle.close();
      else if (typeof handle[Symbol.asyncDispose] === 'function') await handle[Symbol.asyncDispose]();
      handle = null;

      state.generation += 1;
      const freshHeader = {
        ...targetHeader,
        id: toBridgedDshSessionId(extId, itemId, state.generation),
      };
      state.dshSessionId = freshHeader.id;
      const freshHandle = await persistence.create(freshHeader);
      try {
        const allEvents = buildDshSeedEvents({
          dshSessionId: freshHeader.id,
          extId,
          itemId,
          title,
          turns,
          startSeq: 0,
          startTurn: 1,
        });
        if (allEvents.length > 0) await freshHandle.append(allEvents);
        await freshHandle.flush?.();
        projectionCache?.coldSnapshot?.(freshHeader, 0, allEvents);
        state.turnCount = turns.length;
        state.seqCount = allEvents.length;
      } finally {
        if (typeof freshHandle.close === 'function') await freshHandle.close();
        else if (typeof freshHandle[Symbol.asyncDispose] === 'function') await freshHandle[Symbol.asyncDispose]();
      }
      return { persisted: true, mode: 'rebuilt', dshSessionId: freshHeader.id };
    }

    if (existingTurnEnds === turns.length) {
      state.turnCount = turns.length;
      state.seqCount = existingEvents.length;
      return { persisted: true, mode: 'up-to-date', dshSessionId: targetHeader.id };
    }

    const deltaTurns = turns.slice(existingTurnEnds);
    const newTurnEvents = buildDshSeedEvents({
      dshSessionId: targetHeader.id,
      extId,
      itemId,
      title,
      turns: deltaTurns,
      startSeq: existingEvents.length,
      startTurn: existingTurnEnds + 1,
    });
    if (newTurnEvents.length > 0) {
      await handle.append(newTurnEvents);
      await handle.flush?.();
      projectionCache?.coldSnapshot?.(targetHeader, 0, [...existingEvents, ...newTurnEvents]);
    }
    state.turnCount = turns.length;
    state.seqCount = existingEvents.length + newTurnEvents.length;
    return { persisted: true, mode: 'appended', dshSessionId: targetHeader.id };
  } finally {
    if (handle) {
      if (typeof handle.close === 'function') await handle.close();
      else if (typeof handle[Symbol.asyncDispose] === 'function') await handle[Symbol.asyncDispose]();
    }
  }
}

/**
 * 将指定私人扩展会话（如 claude-workspace 或 grokbot）同步为 DSH 原生会话，
 * 返回可供前端 uiWorkspace.openSession(dshSessionId) 直接打开的会话 ID。
 */
export async function syncExtSessionToNativeDsh(ctx, {
  extId,
  itemId,
  title = '',
  cwd = '',
  entries: suppliedEntries = null,
  pathOpts = {},
} = {}) {
  const cleanExtId = String(extId || '').trim();
  const cleanItemId = String(itemId || '').trim();
  if (!cleanExtId || !cleanItemId) {
    return { ok: false, error: 'extId 与 itemId 不能为空' };
  }

  let entries = Array.isArray(suppliedEntries) ? suppliedEntries : null;
  let resolvedTitle = String(title || '').trim();
  let resolvedCwd = String(cwd || '').trim();

  if (!entries) {
    const trRes = await invokePrivateExtensionAction(
      cleanExtId,
      'getTranscript',
      { sessionId: cleanItemId, agentId: cleanItemId, limit: 160 },
      { ctx },
      pathOpts,
    );
    if (!trRes?.ok) {
      return { ok: false, error: trRes?.error || `读取扩展 ${cleanExtId} 历史记录失败` };
    }
    entries = Array.isArray(trRes.entries) ? trRes.entries : [];
    if (!resolvedTitle && trRes.title) resolvedTitle = String(trRes.title).trim();
    if (!resolvedCwd && trRes.cwd) resolvedCwd = String(trRes.cwd).trim();
  }

  const turns = groupEntriesIntoTurns(entries, cleanExtId);
  const itemKey = `${cleanExtId}::${cleanItemId}`;
  const firstTurnSig = turns[0] ? `${turns[0].userText.slice(0, 64)}` : 'empty';
  let state = bridgedItemState.get(itemKey);

  if (!state || state.firstTurnSig !== firstTurnSig || turns.length < state.turnCount) {
    const nextGen = state ? state.generation + 1 : 0;
    const dshSessionId = toBridgedDshSessionId(cleanExtId, cleanItemId, nextGen);
    state = {
      dshSessionId,
      generation: nextGen,
      firstTurnSig,
      turnCount: 0,
      seqCount: 0,
    };
    bridgedItemState.set(itemKey, state);
  }

  const dshSessionId = state.dshSessionId;
  const effectiveCwd = (resolvedCwd && existsSync(resolvedCwd)) ? resolvedCwd : process.cwd();
  const createdAt = turns[0]?.userTime || Date.now();
  const header = {
    version: SESSION_FORMAT_VERSION,
    id: dshSessionId,
    createdAt,
    cwd: effectiveCwd,
    isSeeded: false,
  };

  const writeRes = await writeOrAppendPersistence(
    ctx,
    header,
    { extId: cleanExtId, itemId: cleanItemId, title: resolvedTitle || cleanItemId, turns },
    state,
  );
  const finalSessionId = writeRes.dshSessionId || dshSessionId;

  bridgedSessionMap.set(finalSessionId, {
    dshSessionId: finalSessionId,
    extId: cleanExtId,
    itemId: cleanItemId,
    title: resolvedTitle || cleanItemId,
    cwd: effectiveCwd,
    modelSpec: itemKey,
  });

  return {
    ok: true,
    dshSessionId: finalSessionId,
    extId: cleanExtId,
    itemId: cleanItemId,
    title: resolvedTitle || cleanItemId,
    cwd: effectiveCwd,
    turnCount: turns.length,
    persisted: writeRes.persisted,
    mode: writeRes.mode,
  };
}

/** 从 DSH AgentLoop 传入的 messages 数组中提取最新一条人类消息的文本与图片/文件附件。 */
export async function extractLatestPromptPayload(messages = [], ctx = null) {
  const list = Array.isArray(messages) ? messages : [];
  let targetMsg = null;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const msg = list[i];
    if (msg?.role === 'user' && msg?.source?.kind !== 'runtime-context') {
      targetMsg = msg;
      break;
    }
  }
  if (!targetMsg) return { text: '', attachments: [] };

  const textParts = [];
  const attachments = [];
  const content = Array.isArray(targetMsg.content) ? targetMsg.content : [];
  const attService = ctx?.get?.('attachments') || ctx?.attachments;

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      textParts.push(block.text.trim());
    } else if (block.type === 'image') {
      const ref = block.attachment || block;
      const name = String(ref?.name || 'pasted-image.png');
      let filePath = String(ref?.path || '');
      let dataUrl = '';
      if (!filePath && attService && ref?.attachmentId) {
        try {
          const loaded = await (attService.readImage?.(ref.attachmentId) || attService.read?.(ref.attachmentId));
          const bytes = loaded?.data || loaded?.bytes || (Buffer.isBuffer(loaded) ? loaded : null);
          if (bytes) {
            const dir = join(tmpdir(), 'dsh-au-ext-attachments');
            mkdirSync(dir, { recursive: true });
            filePath = join(dir, `${Date.now()}-${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
            writeFileSync(filePath, bytes);
          }
        } catch {}
      }
      attachments.push({ type: 'image', name, path: filePath, dataUrl });
    } else if (block.type === 'file') {
      const ref = block.attachment || block;
      attachments.push({
        type: 'file',
        name: String(ref?.name || 'file'),
        path: String(ref?.path || ''),
      });
    }
  }

  return {
    text: textParts.join('\n\n').trim(),
    attachments,
  };
}

/**
 * 在 DSH 宿主注册外部扩展对话转接适配器（LlmAdapter）：
 * 使转接会话在 DSH 100% 原生对话界面中输入文字、粘贴图片、上传文件或点击停止时，
 * 自动转发给对应的私人仓扩展（claude-workspace / grokbot）并流式回传回复。
 */
export function installExtNativeSessionBridge(ctx, pathOpts = {}) {
  const disposers = [];

  const createBridgeLlmAdapter = () => ({
    providerInfo(provider) {
      return { id: provider, name: 'DSH-AU 外部会话转接' };
    },
    providerRetryPolicy() {
      return undefined;
    },
    imageRequestPricing() {
      return undefined;
    },
    imageRequestTarget(_provider, _model, image) {
      return { width: image.width, height: image.height, maxBytes: image.bytes };
    },
    async listModels(_provider) {
      // 仅用于侧边工作区内部转接，不在全局模型选择下拉菜单中暴露
      return [];
    },
    async resolveModel(provider, model) {
      const [extId] = String(model || '').split('::', 2);
      return {
        provider,
        id: model,
        name: extId === 'grokbot' ? 'GrokBot' : 'Claude',
        inputModalities: ['text', 'image'],
      };
    },
    async prepareCall(provider, model, signal) {
      const resolved = await this.resolveModel(provider, model, signal);
      return {
        model: resolved,
        stream: (options) => this.stream(options),
      };
    },
    async *stream(options) {
      const rawModel = String(options?.model || '');
      const [extId, itemId] = rawModel.includes('::')
        ? rawModel.split('::', 2)
        : ['claude-workspace', rawModel];
      const { text, attachments } = await extractLatestPromptPayload(options?.messages, ctx);
      const signal = options?.signal;

      const onAbort = () => {
        void invokePrivateExtensionAction(
          extId,
          'interruptRun',
          { sessionId: itemId, agentId: itemId },
          { ctx },
          pathOpts,
        ).catch(() => {});
      };
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        const sendRes = await invokePrivateExtensionAction(
          extId,
          'sendMessage',
          {
            sessionId: itemId,
            agentId: itemId,
            text: text || (attachments.length > 0 ? '请查看附带的文件' : ''),
            attachments,
            waitForReply: true,
          },
          { ctx },
          pathOpts,
        );
        const replyText = sendRes?.ok
          ? String(sendRes.reply || '（已发送，等待外部客户端处理）')
          : `发送失败: ${sendRes?.error || '未知错误'}`;

        yield { type: 'text-delta', index: 0, text: replyText };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: replyText } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } finally {
        if (signal && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort);
        }
      }
    },
  });

  const registerLlm = (llmSvc) => {
    if (!llmSvc || typeof llmSvc.registerAdapter !== 'function') return;
    try {
      const dispose = llmSvc.registerAdapter([BRIDGED_EXT_LLM_PROVIDER], createBridgeLlmAdapter());
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch {}
  };

  const immediateLlm = ctx?.get?.('llm') || ctx?.llm;
  if (immediateLlm) {
    registerLlm(immediateLlm);
  } else if (typeof ctx?.inject === 'function') {
    ctx.inject(['llm'], (childCtx) => {
      registerLlm(childCtx?.get?.('llm') || childCtx?.llm);
    });
  }

  return () => {
    while (disposers.length > 0) {
      const fn = disposers.pop();
      try { fn?.(); } catch {}
    }
  };
}



