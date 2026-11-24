    // ===== 模型快捷切换：项目配置、宿主目录与当前可见会话 =====
    const MODEL_SHORTCUT_REQUEST = 'model-shortcut-request';
    const MODEL_SHORTCUT_RESULT = 'model-shortcut-result';
    const MODEL_SHORTCUT_KEY = 'model-shortcut-key';
    const MODEL_SHORTCUT_CONFIG_REQUEST = 'model-shortcut-config-request';
    const MODEL_SHORTCUT_READY = 'model-shortcut-ready';
    const MODEL_SHORTCUT_NATIVE_ID = 'dsh-au.model-shortcut.shared';
    const modelShortcutFrameCapabilities = new WeakMap();
    const modelShortcutFrameTokens = new WeakMap();
    const modelShortcutFrameProbes = new Map();
    const DEFAULT_MODEL_SHORTCUT_BINDING = keyBinding('KeyM', { alt: true });
    const modelShortcutsStore = {
      snapshot: { enabled: false, binding: DEFAULT_MODEL_SHORTCUT_BINDING, slots: Array(9).fill(null), loaded: false, busy: false, error: '' },
      listeners: new Set(),
    };
    const modelShortcutPopup = {
      snapshot: { open: false, loading: false, selecting: false, error: '', catalog: null, target: null },
      listeners: new Set(),
    };
    let modelShortcutCtx = null;
    let modelShortcutTarget = { deviceId: 'local', frame: null, allowed: false };
    let modelShortcutGeneration = 0;
    const modelShortcutRequests = new Map();

    function publishModelShortcuts(patch) {
      modelShortcutsStore.snapshot = { ...modelShortcutsStore.snapshot, ...patch };
      for (const listener of [...modelShortcutsStore.listeners]) listener(modelShortcutsStore.snapshot);
    }

    function publishModelShortcutPopup(patch) {
      modelShortcutPopup.snapshot = { ...modelShortcutPopup.snapshot, ...patch };
      for (const listener of [...modelShortcutPopup.listeners]) listener(modelShortcutPopup.snapshot);
      // 这里只把当前页面的按键状态送进其 iframe，不广播到其它设备或浏览器。
      for (const listener of [...modelShortcutsStore.listeners]) listener(modelShortcutsStore.snapshot);
    }

    function useModelShortcuts() {
      const [snapshot, setSnapshot] = useState(modelShortcutsStore.snapshot);
      useEffect(() => {
        modelShortcutsStore.listeners.add(setSnapshot);
        setSnapshot(modelShortcutsStore.snapshot);
        return () => modelShortcutsStore.listeners.delete(setSnapshot);
      }, []);
      return snapshot;
    }

    async function loadModelShortcuts() {
      try {
        const res = await callApi('getModelShortcuts');
        if (!res?.ok || !res.modelShortcuts) throw new Error(res?.error || '读取模型快捷配置失败');
        publishModelShortcuts({ ...res.modelShortcuts, loaded: true, error: '' });
        return modelShortcutsStore.snapshot;
      } catch (error) {
        publishModelShortcuts({ enabled: false, loaded: false, error: error.message || '读取模型快捷配置失败' });
        throw error;
      }
    }

    async function saveModelShortcuts(patch) {
      if (modelShortcutsStore.snapshot.busy) throw new Error('模型快捷配置正在保存，请稍候');
      publishModelShortcuts({ busy: true, error: '' });
      try {
        const candidateBinding = Object.prototype.hasOwnProperty.call(patch, 'binding') ? patch.binding : modelShortcutsStore.snapshot.binding;
        if (candidateBinding && (patch.binding || patch.enabled === true)) {
          const checked = validateModelShortcutBinding(candidateBinding);
          if (!checked.ok) throw new Error(checked.reason);
        }
        const res = await callApi('saveModelShortcuts', patch);
        if (!res?.ok || !res.modelShortcuts) throw new Error(res?.error || '保存模型快捷配置失败');
        publishModelShortcuts({ ...res.modelShortcuts, loaded: true, busy: false, error: '' });
        closeModelShortcutPopup();
        return modelShortcutsStore.snapshot;
      } catch (error) {
        publishModelShortcuts({ busy: false, error: error.message || '保存模型快捷配置失败' });
        throw error;
      }
    }

    /** 与 AU 的其它动作双向检查冲突；模型绑定始终不进入旧 localStorage 覆盖表。 */
    function modelShortcutBindingClash(binding, actionId) {
      return actionId !== 'model.open' && modelShortcutsStore.snapshot.loaded
        && sameShortcutBinding(binding, modelShortcutsStore.snapshot.binding);
    }

    function validateModelShortcutBinding(binding) {
      const checked = validateShortcutBinding(binding, 'model.open');
      if (!checked.ok) return checked;
      if (!binding.ctrl && !binding.alt && !binding.meta && !/^F\d+$/.test(binding.code)) {
        return { ok: false, reason: '模型快捷键需要带 Ctrl、Alt 或 Cmd，或使用功能键，避免影响普通输入' };
      }
      const reserved = (binding.alt && !binding.ctrl && !binding.meta && ['F4', 'Tab'].includes(binding.code))
        || (binding.meta && ['KeyQ', 'KeyW', 'KeyM', 'Tab', 'Space'].includes(binding.code))
        || (binding.ctrl && !binding.alt && ['KeyW', 'KeyR', 'KeyL', 'KeyT', 'KeyN'].includes(binding.code));
      if (reserved) return { ok: false, reason: '与浏览器或操作系统常用快捷键冲突，请换一个组合键' };
      const shortcuts = modelShortcutService(modelShortcutCtx, 'shortcuts');
      if (typeof shortcuts?.describeBinding === 'function') {
        try {
          const modifiers = [];
          if (binding.ctrl) modifiers.push('control');
          if (binding.alt) modifiers.push('alt');
          if (binding.shift) modifiers.push('shift');
          if (binding.meta) modifiers.push('meta');
          const description = shortcuts.describeBinding({ code: binding.code, modifiers });
          if (description.issue) return { ok: false, reason: '这个组合键被宿主保留或在当前平台不受支持，请换一个' };
          const conflicts = (description.conflicts || []).filter((id) => id !== MODEL_SHORTCUT_NATIVE_ID);
          if (conflicts.length) {
            const catalog = [...(shortcuts.catalog?.getSnapshot?.() || []), ...(shortcuts.fixedCatalog?.getSnapshot?.() || [])];
            const conflict = catalog.find((item) => item.id === conflicts[0]);
            return { ok: false, reason: `与宿主快捷键「${typeof conflict?.label === 'string' ? conflict.label : conflicts[0]}」冲突` };
          }
        } catch {
          return { ok: false, reason: '暂时无法检查宿主快捷键冲突，请稍后重试' };
        }
      }
      return { ok: true, reason: '' };
    }

    function closeModelShortcutPopup() {
      ++modelShortcutGeneration;
      for (const [requestId, pending] of modelShortcutRequests) {
        window.clearTimeout(pending.timer);
        modelShortcutRequests.delete(requestId);
        pending.reject(new Error('当前模型列表或设备已改变，请重新打开列表'));
      }
      for (const [probeId, pending] of modelShortcutFrameProbes) {
        window.clearTimeout(pending.timer);
        modelShortcutFrameProbes.delete(probeId);
        pending.reject(new Error('当前设备或模型列表已改变，请重试'));
      }
      publishModelShortcutPopup({ open: false, loading: false, selecting: false, error: '', catalog: null, target: null });
    }

    /** 舞台只提供当前那一个 iframe；后台预加载设备不能成为选模目标。 */
    function updateModelShortcutTarget(next) {
      if (next.deviceId !== modelShortcutTarget.deviceId || next.frame !== modelShortcutTarget.frame
        || next.routeId !== modelShortcutTarget.routeId || next.allowed !== modelShortcutTarget.allowed) closeModelShortcutPopup();
      modelShortcutTarget = next;
    }

    function captureModelShortcutTarget(catalogOnly = false) {
      // 设置页可以只读目录；实际切换仍必须留在正在看的对话。
      if (!catalogOnly && !modelShortcutTarget.allowed) throw new Error('请先打开当前设备的对话，再切换模型');
      const target = { ...modelShortcutTarget, catalogOnly };
      if (target.deviceId !== 'local') {
        if (!target.frame?.contentWindow) throw new Error('当前设备页面尚未就绪，不能切换模型');
        target.frameWindow = target.frame.contentWindow;
        target.frameToken = modelShortcutFrameToken(target.frameWindow);
      } else {
        target.sessionId = readNativeSelectedSessionId(modelShortcutCtx);
        if (!target.sessionId && !catalogOnly) throw new Error('当前没有可切换模型的对话');
      }
      return target;
    }

    function assertModelShortcutTarget(target) {
      if ((!target.catalogOnly && !modelShortcutTarget.allowed) || target.deviceId !== modelShortcutTarget.deviceId
        || target.frame !== modelShortcutTarget.frame || target.routeId !== modelShortcutTarget.routeId) throw new Error('当前设备已改变，请重新打开模型列表');
      if (target.deviceId === 'local' && target.sessionId !== readNativeSelectedSessionId(modelShortcutCtx)) {
        throw new Error('当前对话已改变，请重新打开模型列表');
      }
      if (target.frame && (target.frameWindow !== target.frame.contentWindow
        || target.frameToken !== modelShortcutFrameToken(target.frameWindow))) throw new Error('当前设备页面已重新加载，请重试');
    }

    function modelShortcutService(ctx, name) {
      try { return ctx?.get?.(name) || ctx?.[name]; } catch { return null; }
    }

    /** 复用宿主目录；兼容未提供目录服务、但公开原生 session RPC 的宿主。 */
    function nativeModelShortcutDirectory(ctx, sessionId) {
      const directories = modelShortcutService(ctx, 'modelDirectories');
      if (!sessionId && typeof directories?.catalog?.load === 'function') return {
        load: async () => {
          const catalog = await directories.catalog.load();
          return { ...catalog, current: catalog.current ?? catalog.default };
        },
        select: () => { throw new Error('当前没有可切换模型的对话'); },
      };
      if (sessionId && typeof directories?.directoryFor === 'function') return directories.directoryFor(sessionId);
      const remote = modelShortcutService(ctx, 'remote')?.session || ctx?.remote?.session;
      if (typeof remote?.modelCatalog !== 'function' || typeof remote?.selectModel !== 'function') {
        throw new Error('当前设备不支持宿主模型选择接口，请更新该设备的 DSH');
      }
      return {
        load: async () => {
          const result = await remote.modelCatalog();
          if (!result?.ok) throw new Error(result?.error?.message || '读取宿主模型目录失败');
          return { ...result.value, current: result.value.default };
        },
        select: (selection) => remote.selectModel({ sessionId, ...selection }),
      };
    }

    function flattenModelShortcutCatalog(snapshot, sessionId) {
      if (!snapshot || snapshot.status === 'error') throw new Error(snapshot?.error || '读取宿主模型目录失败');
      const models = [];
      for (const group of snapshot.groups || []) {
        for (const model of group.models || []) {
          const reasoning = model.reasoning || {};
          const efforts = Array.isArray(reasoning.efforts) ? reasoning.efforts : [];
          // 仅用于安静展示目录元数据；真正 select 仍只转发用户已保存的 reasoningEffort。
          const defaultReasoning = typeof reasoning.default === 'string'
            ? reasoning.default
            : typeof reasoning.defaultEffort === 'string' ? reasoning.defaultEffort : '';
          const defaultReasoningMeta = efforts.find((effort) => effort.id === defaultReasoning);
          models.push({
            provider: group.id, model: model.id, label: model.name || model.id,
            providerLabel: group.name || group.id,
            reasoningEfforts: efforts.map((effort) => ({ id: effort.id, name: effort.name || effort.id })),
            reasoningDefault: defaultReasoning,
            reasoningDefaultLabel: defaultReasoningMeta?.name || defaultReasoning,
          });
        }
      }
      return { models, current: snapshot.current || null, sessionId };
    }

    function modelShortcutCurrentMatch(selection, current, available) {
      if (!selection || !current
        || selection.provider !== (current.provider || current.providerId)
        || selection.model !== (current.model || current.modelId)) return false;
      // 同模型不同推理档位不能同时宣称“当前”；未知档位时宁可不标记。
      const selectedEffort = selection.reasoningEffort || available?.reasoningDefault || '';
      const currentEffort = current.reasoningEffort || current.reasoning?.effort || current.reasoning?.default
        || available?.reasoningDefault || '';
      return Boolean(selectedEffort && currentEffort ? selectedEffort === currentEffort : !selectedEffort && !currentEffort);
    }

    function modelShortcutVendorTone(provider = '', model = '') {
      const p = String(provider || '').toLowerCase();
      const m = String(model || '').toLowerCase();
      if (p.includes('kiro') || p.includes('claude') || p.includes('anthropic')
        || m.includes('claude') || m.includes('opus') || m.includes('sonnet') || m.includes('haiku')) {
        return 'anthropic';
      }
      if (p.includes('antigravity') || p.includes('gemini') || p.includes('google')
        || m.includes('gemini') || m.includes('gemma')) {
        return 'google';
      }
      if (p.includes('azure') || p.includes('openai')
        || m.includes('gpt') || m.includes('o1') || m.includes('o3')) {
        return 'openai';
      }
      if (p.includes('deepseek') || m.includes('deepseek')) {
        return 'deepseek';
      }
      if (p.includes('qwen') || p.includes('alibaba') || m.includes('qwen')) {
        return 'qwen';
      }
      return 'custom';
    }

    function configuredModelShortcutRows(slots, catalog) {
      return slots.map((selection, index) => {
        if (!selection) return null;
        const available = catalog?.models?.find((model) => model.provider === selection.provider && model.model === selection.model);
        const reasoningEfforts = available?.reasoningEfforts || [];
        const savedEffort = selection.reasoningEffort || '';
        // 未显式保存推理强度时，默认选中 medium（若无 medium 则回退模型默认或首个档位），不再展示「默认」前缀
        const fallbackEffortMeta = !savedEffort && reasoningEfforts.length
          ? (reasoningEfforts.find((effort) => String(effort.id || '').toLowerCase() === 'medium')
            || reasoningEfforts.find((effort) => effort.id === available?.reasoningDefault)
            || reasoningEfforts[0]
            || null)
          : null;
        const savedEffortMeta = reasoningEfforts.find((effort) => effort.id === savedEffort);
        const effectiveEffort = savedEffort || fallbackEffortMeta?.id || '';
        const effortAvailable = !savedEffort || Boolean(savedEffortMeta);
        const reasoningLabel = savedEffort
          ? (savedEffortMeta?.name || savedEffort)
          : (fallbackEffortMeta?.name || fallbackEffortMeta?.id || available?.reasoningDefaultLabel || '');
        return {
          number: index + 1,
          selection,
          effectiveReasoningEffort: effectiveEffort,
          label: selection.label || available?.label || selection.model,
          providerLabel: available?.providerLabel || selection.provider,
          vendor: modelShortcutVendorTone(selection.provider, selection.model),
          reasoningEfforts,
          reasoningDefaultLabel: available?.reasoningDefaultLabel || '',
          reasoningLabel,
          reasoningUnavailable: Boolean(savedEffort && !savedEffortMeta),
          available: Boolean(available && effortAvailable),
          current: modelShortcutCurrentMatch(
            effectiveEffort && !selection.reasoningEffort ? { ...selection, reasoningEffort: effectiveEffort } : selection,
            catalog?.current,
            available
          ),
        };
      }).filter(Boolean);
    }

    function requestFrameModelShortcut(target, action, extra = {}) {
      assertModelShortcutTarget(target);
      const requestId = globalThis.crypto?.randomUUID?.() || `model-${Date.now()}-${Math.random()}`;
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          modelShortcutRequests.delete(requestId);
          reject(new Error('当前设备未响应模型请求，请确认该设备已安装新版 DSH AU'));
        }, 6000);
        modelShortcutRequests.set(requestId, { frameWindow: target.frameWindow, resolve, reject, timer });
        try {
          target.frameWindow.postMessage({ source: 'dsh-au', type: MODEL_SHORTCUT_REQUEST, requestId, action,
            generation: modelShortcutGeneration, frameToken: target.frameToken, ...extra }, '*');
        } catch (error) {
          window.clearTimeout(timer);
          modelShortcutRequests.delete(requestId);
          reject(error);
        }
      });
    }

    async function readTargetModelShortcutCatalog(target) {
      assertModelShortcutTarget(target);
      if (target.frameWindow) {
        const peer = await probeModelShortcutFrame(target);
        assertModelShortcutTarget(target);
        if (peer.bridge) {
          target.remoteProtocol = 'bridge';
          const catalog = await requestFrameModelShortcut(target, 'catalog');
          assertModelShortcutTarget(target);
          if (!catalog?.sessionId) throw new Error('当前设备没有可切换模型的对话');
          target.sessionId = catalog.sessionId;
          return catalog;
        }
        if (!peer.sessionId) throw new Error('旧远端未提供当前可见会话，请更新该设备的 DSH AU');
        if (!target.routeId) throw new Error('当前远端通路未就绪，请重新进入设备');
        target.remoteProtocol = 'native';
        target.sessionId = peer.sessionId;
        const result = await callApi('getRemoteModelCatalog', { deviceId: target.deviceId, routeId: target.routeId });
        assertModelShortcutTarget(target);
        if (!result?.ok) throw new Error(result?.error || '远端原生模型目录不可用');
        if (!result.catalog) throw new Error('本机 DSH AU 尚未载入远端选模接口，请重载插件或重启本机 DSH');
        // 全局 default 不是该会话的当前选择，旧桥未返回时不冒称当前模型。
        return flattenModelShortcutCatalog({ ...result.catalog, current: null }, target.sessionId);
      }
      const snapshot = await nativeModelShortcutDirectory(modelShortcutCtx, target.sessionId).load();
      assertModelShortcutTarget(target);
      return flattenModelShortcutCatalog(snapshot, target.sessionId);
    }

    async function loadModelShortcutCatalog() {
      return readTargetModelShortcutCatalog(captureModelShortcutTarget(true));
    }

    async function openModelShortcutPopup() {
      if (modelShortcutPopup.snapshot.open) { closeModelShortcutPopup(); return; }
      const generation = ++modelShortcutGeneration;
      publishModelShortcutPopup({ open: true, loading: true, error: '', catalog: null, target: null });
      try {
        const config = await loadModelShortcuts();
        if (generation !== modelShortcutGeneration) return;
        if (!config.enabled) { closeModelShortcutPopup(); return; }
        const target = captureModelShortcutTarget();
        const catalog = await readTargetModelShortcutCatalog(target);
        if (generation !== modelShortcutGeneration) return;
        publishModelShortcutPopup({ loading: false, catalog, target });
      } catch (error) {
        if (generation === modelShortcutGeneration) publishModelShortcutPopup({ loading: false, error: error.message || '模型列表打开失败' });
      }
    }

    /** 检查可用性之后才调用 select；失败、空槽或会话变化绝不自动改选其它模型。 */
    async function selectModelShortcutNumber(number) {
      const popup = modelShortcutPopup.snapshot;
      if (!popup.open || popup.loading || popup.selecting) return false;
      const selection = modelShortcutsStore.snapshot.slots[number - 1];
      if (!selection) { publishModelShortcutPopup({ error: `编号 ${number} 未配置模型` }); return false; }
      const row = configuredModelShortcutRows(modelShortcutsStore.snapshot.slots, popup.catalog).find((item) => item.number === number);
      if (!row?.available) { publishModelShortcutPopup({ error: `编号 ${number} 的模型在当前设备不可用，未进行替换` }); return false; }
      const generation = modelShortcutGeneration;
      publishModelShortcutPopup({ selecting: true, error: '' });
      try {
        const target = popup.target;
        if (!target) throw new Error('当前对话未就绪，请重新打开模型列表');
        assertModelShortcutTarget(target);
        const effectiveEffort = selection.reasoningEffort || row.effectiveReasoningEffort || '';
        const next = { provider: selection.provider, model: selection.model,
          ...(effectiveEffort ? { reasoningEffort: effectiveEffort } : {}) };
        let result;
        if (target.frameWindow && target.remoteProtocol === 'native') {
          const visible = await probeModelShortcutFrame(target);
          assertModelShortcutTarget(target);
          if (generation !== modelShortcutGeneration || visible.sessionId !== target.sessionId) {
            throw new Error('远端当前对话已改变，请重新打开模型列表');
          }
          result = await callApi('selectRemoteModel', { deviceId: target.deviceId, routeId: target.routeId,
            sessionId: target.sessionId, selection: next });
          if (result?.ok && (!result.selected || result.selected.provider !== next.provider || result.selected.model !== next.model
            || (next.reasoningEffort && result.selected.reasoningEffort !== next.reasoningEffort))) {
            throw new Error('本机远端选模接口未返回有效回执，请重载 DSH AU 后重试');
          }
        } else if (target.frameWindow) {
          result = await requestFrameModelShortcut(target, 'select', { sessionId: target.sessionId, selection: next });
        } else {
          const directory = nativeModelShortcutDirectory(modelShortcutCtx, target.sessionId);
          const fresh = flattenModelShortcutCatalog(await directory.load(), target.sessionId);
          assertModelShortcutTarget(target);
          if (!configuredModelShortcutRows([selection], fresh)[0]?.available) throw new Error('该模型在当前设备不可用，未进行替换');
          result = await directory.select(next);
        }
        if (!result?.ok) throw new Error(result?.error?.message || '宿主拒绝了模型切换');
        if (generation === modelShortcutGeneration) closeModelShortcutPopup();
        return true;
      } catch (error) {
        if (generation === modelShortcutGeneration) publishModelShortcutPopup({ selecting: false, error: error.message || '模型切换失败' });
        return false;
      }
    }

    function modelShortcutNumberFromEvent(event) {
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.isComposing) return null;
      const match = /^(?:Digit|Numpad)([1-9])$/.exec(event.code || '');
      return match ? Number(match[1]) : null;
    }

    function consumeModelShortcutKey(event) {
      if (shortcutStore.recording || event.isComposing || event.repeat) return false;
      if (modelShortcutPopup.snapshot.open) {
        if (event.code === 'Escape') {
          event.preventDefault(); event.stopImmediatePropagation?.(); closeModelShortcutPopup(); return true;
        }
        const number = modelShortcutNumberFromEvent(event);
        if (number !== null) {
          event.preventDefault(); event.stopImmediatePropagation?.(); void selectModelShortcutNumber(number); return true;
        }
      }
      const config = modelShortcutsStore.snapshot;
      if (config.loaded && config.enabled && matchesShortcutBinding(event, config.binding)
        && validateModelShortcutBinding(config.binding).ok) {
        event.preventDefault(); event.stopImmediatePropagation?.(); void openModelShortcutPopup(); return true;
      }
      return false;
    }

    async function handleControlledModelShortcutRequest(data, ctx, maySelect = () => true, isCurrent = () => true) {
      if (!isCurrent()) throw new Error('模型请求已过期，请重新打开列表');
      const sessionId = readNativeSelectedSessionId(ctx);
      if (!sessionId) throw new Error('当前设备没有可切换模型的对话');
      if (data.action === 'select' && data.sessionId !== sessionId) throw new Error('当前设备的对话已改变，请重新打开模型列表');
      const directory = nativeModelShortcutDirectory(ctx, sessionId);
      const catalog = flattenModelShortcutCatalog(await directory.load(), sessionId);
      if (sessionId !== readNativeSelectedSessionId(ctx)) throw new Error('当前设备的对话已改变，请重试');
      if (!isCurrent()) throw new Error('模型请求已过期，请重新打开列表');
      if (data.action === 'catalog') return catalog;
      if (!maySelect()) throw new Error('当前设备已不在查看中，模型未切换');
      if (data.action !== 'select' || !data.selection || typeof data.selection.provider !== 'string' || typeof data.selection.model !== 'string') {
        throw new Error('模型选择请求无效');
      }
      const selection = { provider: data.selection.provider, model: data.selection.model,
        ...(typeof data.selection.reasoningEffort === 'string' ? { reasoningEffort: data.selection.reasoningEffort } : {}) };
      if (!configuredModelShortcutRows([selection], catalog)[0]?.available) throw new Error('该模型在当前设备不可用，未进行替换');
      return directory.select(selection);
    }

    function modelShortcutFrameToken(frameWindow) {
      if (!frameWindow) return '';
      if (!modelShortcutFrameTokens.has(frameWindow)) modelShortcutFrameTokens.set(frameWindow,
        globalThis.crypto?.randomUUID?.() || `frame-${Date.now()}-${Math.random()}`);
      return modelShortcutFrameTokens.get(frameWindow);
    }

    function modelShortcutFrameLoaded(frame) {
      if (!frame?.contentWindow) return;
      modelShortcutFrameTokens.delete(frame.contentWindow);
      modelShortcutFrameCapabilities.delete(frame.contentWindow);
      if (frame === modelShortcutTarget.frame) closeModelShortcutPopup();
    }

    function isOwnedModelShortcutFrame(frameWindow) {
      if (!frameWindow) return false;
      if (frameWindow === modelShortcutTarget.frame?.contentWindow) return true;
      const stage = typeof document !== 'undefined' ? document.getElementById?.(STAGE_HOST_ID) : null;
      return [...(stage?.querySelectorAll?.('iframe') || [])].some((frame) => frame.contentWindow === frameWindow
        && frame.name?.startsWith(CONTROLLED_FRAME_NAME_PREFIX));
    }

    /** 新桥用能力确认，旧桥用“快照随后 nonce probe 回执”的有序消息确认真实可见会话。 */
    function probeModelShortcutFrame(target) {
      assertModelShortcutTarget(target);
      if (modelShortcutFrameCapabilities.get(target.frameWindow) === target.frameToken) {
        return Promise.resolve({ bridge: true });
      }
      const probeId = `model-probe-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`}`;
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          modelShortcutFrameProbes.delete(probeId);
          reject(new Error('当前远端未提供可见会话或模型快捷键桥，请更新该设备的 DSH AU'));
        }, 2500);
        modelShortcutFrameProbes.set(probeId, { target, frameWindow: target.frameWindow,
          generation: modelShortcutGeneration, sessionId: '', resolve, reject, timer });
        postShortcutConfig(target.frameWindow);
        target.frameWindow.postMessage({ source: 'dsh-au', type: 'dsh-au:request-workspaces-snapshot' }, '*');
        target.frameWindow.postMessage({ source: 'dsh-au', type: 'frame-probe', frameId: probeId }, '*');
      });
    }

    function finishModelShortcutProbe(probeId, pending, result) {
      window.clearTimeout(pending.timer);
      modelShortcutFrameProbes.delete(probeId);
      try {
        assertModelShortcutTarget(pending.target);
        if (pending.generation !== modelShortcutGeneration) throw new Error('模型列表已改变，请重试');
        pending.resolve(result);
      } catch (error) { pending.reject(error); }
    }

    /** 用标准宿主命令驱动 native iframe 分发；只声明项目默认键位，不写宿主偏好。 */
    function installNativeModelShortcutInput(ctx) {
      const shortcuts = modelShortcutService(ctx, 'shortcuts');
      if (shortcuts?.runtime !== 'desktop' || typeof shortcuts?.register !== 'function') {
        return { ownsDomTrigger: () => false, active: () => false, dispose: () => {} };
      }
      let disposeBinding = null;
      let signature = '';
      const overrideWarning = '宿主存在模型键的本地覆盖，请在宿主恢复该命令默认值以使用项目键位';
      const effectiveMatches = () => {
        const native = shortcuts.catalog?.getSnapshot?.()?.find((row) => row.id === MODEL_SHORTCUT_NATIVE_ID)?.binding;
        if (!native) return false;
        const modifiers = native.modifiers || [];
        return sameShortcutBinding(modelShortcutsStore.snapshot.binding, { code: native.code,
          ctrl: modifiers.includes('control'), alt: modifiers.includes('alt'), shift: modifiers.includes('shift'), meta: modifiers.includes('meta') });
      };
      const checkOverride = () => {
        if (!disposeBinding || shortcuts.config?.getSnapshot?.()?.status === 'loading') return;
        if (!effectiveMatches() && modelShortcutsStore.snapshot.error !== overrideWarning) publishModelShortcuts({ error: overrideWarning });
        else if (effectiveMatches() && modelShortcutsStore.snapshot.error === overrideWarning) publishModelShortcuts({ error: '' });
      };
      const sync = () => {
        const config = modelShortcutsStore.snapshot;
        const binding = config.loaded && config.enabled && config.binding && validateModelShortcutBinding(config.binding).ok
          ? config.binding : null;
        const next = JSON.stringify(binding);
        if (next === signature) return;
        signature = next;
        disposeBinding?.(); disposeBinding = null;
        if (!binding) return;
        const modifiers = ['ctrl', 'alt', 'shift', 'meta'].filter((key) => binding[key]).map((key) => key === 'ctrl' ? 'control' : key);
        try {
          disposeBinding = shortcuts.register({ id: MODEL_SHORTCUT_NATIVE_ID,
            label: () => '模型快捷切换（项目配置）', aliases: ['model shortcuts'],
            defaults: { [`desktop:${shortcuts.platform}`]: { code: binding.code, modifiers } },
            regions: ['page', 'editable'], modals: [],
            resolve: (context) => {
              if (shortcutStore.recording || !modelShortcutsStore.snapshot.enabled || !modelShortcutTarget.allowed) return { status: 'pass' };
              // 宿主已校验 iframe name/connected；这里只再锁住当前舞台，不处理后台设备。
              if (context.source === 'iframe' && modelShortcutTarget.frame && context.target !== modelShortcutTarget.frame) return { status: 'pass' };
              if (context.source !== 'menu' && !effectiveMatches()) {
                checkOverride(); return { status: 'blocked', reason: 'conflict' };
              }
              return { status: 'handled', run: () => { void openModelShortcutPopup(); } };
            },
          });
          checkOverride();
        } catch {
          publishModelShortcuts({ error: '宿主原生快捷键声明失败，远端可先更新 DSH AU 键盘桥' });
        }
      };
      const offCatalog = shortcuts.catalog?.subscribe?.(checkOverride);
      modelShortcutsStore.listeners.add(sync);
      sync();
      return {
        active: () => Boolean(disposeBinding) && effectiveMatches(),
        ownsDomTrigger: (event) => Boolean(disposeBinding) && effectiveMatches() && ['windows', 'macos'].includes(shortcuts.platform)
          && matchesShortcutBinding(event, modelShortcutsStore.snapshot.binding),
        dispose: () => { modelShortcutsStore.listeners.delete(sync); offCatalog?.(); disposeBinding?.(); },
      };
    }

    /** 新的桥独立于旧快捷键保存方式，只接受直接父窗口请求或当前舞台回复。 */
    function installModelShortcuts(ctx) {
      modelShortcutCtx = ctx;
      const nativeInput = !isControlledFrame() ? installNativeModelShortcutInput(ctx) : null;
      let controlledPopupOpen = false;
      let controlledGeneration = -1;
      let controlledFrameToken = '';
      const onKey = (event) => {
        if (!isControlledFrame()) {
          if (!nativeInput?.ownsDomTrigger(event)) consumeModelShortcutKey(event);
          return;
        }
        if (shortcutStore.recording || event.isComposing || event.repeat) return;
        const config = modelShortcutsStore.snapshot;
        const number = controlledPopupOpen ? modelShortcutNumberFromEvent(event) : null;
        const close = controlledPopupOpen && event.code === 'Escape';
        // 该键属于外层宿主；不能让远端 web 的保留键规则否决已在外层验证的绑定。
        const toggle = config.loaded && config.enabled && matchesShortcutBinding(event, config.binding);
        if (!close && number === null && !toggle) return;
        event.preventDefault(); event.stopImmediatePropagation?.();
        window.parent.postMessage({ source: 'dsh-au', type: MODEL_SHORTCUT_KEY,
          action: close ? 'close' : number !== null ? 'select' : 'toggle', number,
          generation: controlledGeneration, frameToken: controlledFrameToken }, '*');
      };
      const onMessage = (event) => {
        const data = event.data;
        if (data?.source !== 'dsh-au') return;
        if (isControlledFrame()) {
          if (event.source !== window.parent) return;
          if (data.type === SHORTCUT_CONFIG_MESSAGE && data.modelShortcuts) {
            const config = data.modelShortcuts;
            publishModelShortcuts({ enabled: config.enabled === true, binding: normalizeShortcutBinding(config.binding),
              slots: Array(9).fill(null), loaded: config.loaded === true });
            controlledPopupOpen = data.modelShortcutOpen === true;
            controlledGeneration = Number.isSafeInteger(data.modelShortcutGeneration) ? data.modelShortcutGeneration : -1;
            controlledFrameToken = typeof data.modelShortcutFrameToken === 'string' ? data.modelShortcutFrameToken : '';
            window.parent.postMessage({ source: 'dsh-au', type: MODEL_SHORTCUT_READY, protocol: 2,
              generation: controlledGeneration, frameToken: controlledFrameToken }, '*');
          }
          if (data.type === MODEL_SHORTCUT_REQUEST && typeof data.requestId === 'string' && data.requestId.length <= 128) {
            const reply = (extra) => window.parent.postMessage({ source: 'dsh-au', type: MODEL_SHORTCUT_RESULT, requestId: data.requestId, ...extra }, '*');
            void handleControlledModelShortcutRequest(data, ctx, () => controlledPopupOpen,
              () => Number.isSafeInteger(data.generation) && data.generation === controlledGeneration
                && data.frameToken === controlledFrameToken
            ).then((value) => reply({ ok: true, value }),
              (error) => reply({ ok: false, error: error.message || '当前设备模型请求失败' }));
          }
          return;
        }
        if (data.type === MODEL_SHORTCUT_CONFIG_REQUEST && isOwnedModelShortcutFrame(event.source)) {
          postShortcutConfig(event.source);
          return;
        }
        if (data.type === MODEL_SHORTCUT_READY && data.protocol === 2 && isOwnedModelShortcutFrame(event.source)
          && data.generation === modelShortcutGeneration && data.frameToken === modelShortcutFrameToken(event.source)) {
          modelShortcutFrameCapabilities.set(event.source, data.frameToken);
          for (const [probeId, pending] of modelShortcutFrameProbes) {
            if (pending.frameWindow === event.source) finishModelShortcutProbe(probeId, pending, { bridge: true });
          }
          return;
        }
        if (data.type === 'dsh-au:controlled-workspaces-snapshot') {
          for (const pending of modelShortcutFrameProbes.values()) {
            if (pending.frameWindow === event.source) pending.sessionId = typeof data.currentSessionId === 'string'
              && data.currentSessionId.length <= 128 ? data.currentSessionId : '';
          }
        }
        if (data.type === 'frame-ready') {
          const pending = modelShortcutFrameProbes.get(data.frameId);
          if (pending?.frameWindow === event.source) finishModelShortcutProbe(data.frameId, pending,
            { bridge: false, sessionId: pending.sessionId });
        }
        if (data.type === MODEL_SHORTCUT_RESULT) {
          const pending = modelShortcutRequests.get(data.requestId);
          if (!pending || pending.frameWindow !== event.source) return;
          window.clearTimeout(pending.timer); modelShortcutRequests.delete(data.requestId);
          if (data.ok) pending.resolve(data.value);
          else pending.reject(new Error(data.error || '当前设备模型请求失败'));
        }
        if (data.type === MODEL_SHORTCUT_KEY && modelShortcutTarget.allowed
          && event.source === modelShortcutTarget.frame?.contentWindow && !shortcutStore.recording) {
          const current = data.generation === modelShortcutGeneration && data.frameToken === modelShortcutFrameToken(event.source);
          const legacyToggle = data.action === 'toggle' && data.generation === undefined && data.frameToken === undefined
            && !nativeInput?.active();
          if (!current && !legacyToggle) return;
          if (current) modelShortcutFrameCapabilities.set(event.source, data.frameToken);
          if (data.action === 'close') closeModelShortcutPopup();
          else if (data.action === 'select' && Number.isInteger(data.number) && data.number >= 1 && data.number <= 9) void selectModelShortcutNumber(data.number);
          else if (data.action === 'toggle' && modelShortcutsStore.snapshot.enabled) void openModelShortcutPopup();
        }
      };
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('message', onMessage);
      if (!isControlledFrame()) void loadModelShortcuts().catch(() => {});
      else window.parent.postMessage({ source: 'dsh-au', type: MODEL_SHORTCUT_CONFIG_REQUEST }, '*');
      return () => {
        nativeInput?.dispose();
        window.removeEventListener('keydown', onKey, true); window.removeEventListener('message', onMessage);
        for (const pending of modelShortcutRequests.values()) {
          window.clearTimeout(pending.timer); pending.reject(new Error('模型快捷切换已卸载'));
        }
        modelShortcutRequests.clear(); closeModelShortcutPopup();
        if (modelShortcutCtx === ctx) modelShortcutCtx = null;
      };
    }

    function ModelShortcutOverlay() {
      const config = useModelShortcuts();
      const [popup, setPopup] = useState(modelShortcutPopup.snapshot);
      const dialog = useRef(null);
      useEffect(() => {
        modelShortcutPopup.listeners.add(setPopup);
        setPopup(modelShortcutPopup.snapshot);
        return () => modelShortcutPopup.listeners.delete(setPopup);
      }, []);
      useEffect(() => {
        if (!popup.open) return undefined;
        const previous = document.activeElement;
        dialog.current?.focus?.();
        return () => { if (previous?.isConnected) previous.focus?.(); };
      }, [popup.open]);
      if (!popup.open) return null;
      const rows = configuredModelShortcutRows(config.slots, popup.catalog);
      const onDialogKey = (event) => {
        if (event.code !== 'Tab') return;
        const buttons = [...(dialog.current?.querySelectorAll('button:not(:disabled)') || [])];
        if (!buttons.length) { event.preventDefault(); return; }
        const index = buttons.indexOf(document.activeElement);
        const next = event.shiftKey ? (index <= 0 ? buttons.length - 1 : index - 1) : (index + 1) % buttons.length;
        event.preventDefault(); buttons[next].focus();
      };
      return h('div', { className: 'dsh-au-model-shortcut-overlay', onClick: (event) => {
        if (event.target === event.currentTarget) closeModelShortcutPopup();
      } }, h('section', { className: 'dsh-au-model-shortcut-dialog', role: 'dialog', 'aria-modal': true,
        'aria-labelledby': 'dsh-au-model-shortcut-title', tabIndex: -1, ref: dialog, onKeyDown: onDialogKey },
        h('div', { className: 'dsh-au-model-shortcut-head' },
          h('div', { className: 'dsh-au-model-shortcut-head-info' },
            h('h3', { id: 'dsh-au-model-shortcut-title' }, '模型快捷切换'),
            h('p', { className: 'dsh-au-model-shortcut-desc' }, '只切换当前正在看的对话。')
          ),
          h('div', { className: 'dsh-au-model-shortcut-keyhints', 'aria-hidden': 'true' },
            h('span', { className: 'dsh-au-model-shortcut-keyhint' },
              h('kbd', null, '1–9'),
              ' 选择'
            ),
            h('span', { className: 'dsh-au-model-shortcut-keyhint-dot' }, '·'),
            h('span', { className: 'dsh-au-model-shortcut-keyhint' },
              h('kbd', null, 'Esc'),
              ' 关闭'
            )
          )
        ),
        popup.loading ? h('div', { className: 'dsh-au-model-shortcut-status is-loading', role: 'status' },
          h('span', { className: 'dsh-au-model-shortcut-pulse-dot', 'aria-hidden': 'true' }),
          '正在读取当前设备的模型…'
        ) : null,
        !popup.loading && !rows.length ? h('p', { className: 'dsh-au-model-shortcut-status is-empty' }, '尚未配置模型，请到 DSH AU 设置中配置编号 1–9。') : null,
        h('div', { className: 'dsh-au-model-shortcut-options', role: 'list' },
          ...rows.map((row) => h('button', { type: 'button', key: row.number, className: 'dsh-au-model-shortcut-option',
            disabled: popup.loading || popup.selecting, 'aria-disabled': !row.available || popup.loading || popup.selecting,
            'aria-current': row.current ? 'true' : undefined,
            'data-current': row.current ? 'true' : undefined,
            'data-unavailable': row.available ? undefined : 'true',
            'data-vendor': row.vendor,
            onClick: () => { void selectModelShortcutNumber(row.number); } },
            h('kbd', { className: 'dsh-au-model-shortcut-number' }, String(row.number)),
            h('span', { className: 'dsh-au-model-shortcut-option-main' },
              h('strong', null, row.label),
              h('span', { className: 'dsh-au-model-shortcut-option-meta', title: `${row.providerLabel} / ${row.selection.model}` },
                h('span', { className: 'dsh-au-model-shortcut-vendor-tag', 'data-vendor': row.vendor }, row.providerLabel),
                row.reasoningLabel ? ` · ${row.reasoningLabel}` : '')
            ),
            h('span', { className: row.current ? 'dsh-au-model-shortcut-option-current' : 'dsh-au-model-shortcut-option-state' },
              row.current
                ? [h('span', { key: 'dot', className: 'dsh-au-model-shortcut-current-dot', 'aria-hidden': 'true' }), '当前']
                : row.available ? '' : '不可用')))
        ),
        popup.selecting ? h('div', { className: 'dsh-au-model-shortcut-status is-loading', role: 'status' },
          h('span', { className: 'dsh-au-model-shortcut-pulse-dot', 'aria-hidden': 'true' }),
          '正在切换模型…'
        ) : null,
        popup.error ? h('p', { className: 'dsh-au-shortcut-error', role: 'alert' }, popup.error) : null,
        h('div', { className: 'dsh-au-model-shortcut-foot' },
          h('span', { className: 'dsh-au-model-shortcut-foot-tip' },
            popup.loading ? '正在同步模型清单…' : popup.selecting ? '正在切换会话模型…' : '按数字键直接切换'
          ),
          h('button', { type: 'button', className: 'dsh-au-btn dsh-au-model-shortcut-close-btn', onClick: closeModelShortcutPopup }, '关闭 (Esc)')
        )
      ));
    }

    const modelShortcutHelpers = {
      modelShortcutsStore, modelShortcutPopup, DEFAULT_MODEL_SHORTCUT_BINDING,
      configuredModelShortcutRows, flattenModelShortcutCatalog, modelShortcutNumberFromEvent,
      modelShortcutVendorTone,
      validateModelShortcutBinding, updateModelShortcutTarget, installModelShortcuts,
      openModelShortcutPopup, closeModelShortcutPopup, selectModelShortcutNumber,
      consumeModelShortcutKey, loadModelShortcutCatalog, loadModelShortcuts, saveModelShortcuts,
      handleControlledModelShortcutRequest, ModelShortcutOverlay,
      modelShortcutFrameLoaded, modelShortcutFrameToken,
    };
