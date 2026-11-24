    // ===== 设置页：模型快捷切换 =====
    const MODEL_SHORTCUT_SLOT_COUNT = 9;

    function modelShortcutSelectionKey(selection) {
      return selection && selection.provider && selection.model
        ? `${selection.provider}\u0000${selection.model}`
        : '';
    }

    function modelShortcutCatalogModel(catalog, slot) {
      if (!slot) return null;
      return (catalog.models || []).find((model) => model.provider === slot.provider && model.model === slot.model) || null;
    }

    function normalizeModelShortcutSlots(slots) {
      return Array.from({ length: MODEL_SHORTCUT_SLOT_COUNT }, (_, index) => slots?.[index] || null);
    }

    /** 只移动固定九槽数组，空槽也参与位置计算，绝不压缩或替换用户配置。 */
    function moveModelShortcutSlot(slots, from, to) {
      const next = normalizeModelShortcutSlots(slots);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next;
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    }

    function modelShortcutSlotsEqual(left, right) {
      return normalizeModelShortcutSlots(left).every((slot, index) => {
        const other = normalizeModelShortcutSlots(right)[index];
        return JSON.stringify(slot) === JSON.stringify(other);
      });
    }

    function groupModelShortcutOptions(options, catalogModels = []) {
      const groups = [];
      const groupMap = new Map();
      for (const model of options) {
        const providerId = model.provider || '';
        let group = groupMap.get(providerId);
        if (!group) {
          const providerLabel = model.providerLabel
            || catalogModels.find((item) => item.provider === providerId)?.providerLabel
            || model.provider
            || '其他';
          group = { id: providerId, label: providerLabel, models: [] };
          groupMap.set(providerId, group);
          groups.push(group);
        }
        group.models.push(model);
      }
      return groups;
    }

    function modelShortcutReasoningEffortId(effort) {
      return typeof effort === 'string' ? effort : effort?.id || '';
    }

    function modelShortcutReasoningEffortLabel(effort) {
      return typeof effort === 'string' ? effort : effort?.name || effort?.id || '';
    }

    /** 解析模型推理强度的默认档位：优先选择 medium，若无 medium 则回退模型默认或首个可用档位。 */
    function resolveDefaultModelShortcutEffort(efforts = [], fallbackDefault = '') {
      const list = Array.isArray(efforts) ? efforts : [];
      if (!list.length) return '';
      const medium = list.find((item) => modelShortcutReasoningEffortId(item).toLowerCase() === 'medium');
      if (medium) return modelShortcutReasoningEffortId(medium);
      if (fallbackDefault) {
        const matched = list.find((item) => modelShortcutReasoningEffortId(item) === fallbackDefault);
        if (matched) return modelShortcutReasoningEffortId(matched);
      }
      return modelShortcutReasoningEffortId(list[0]);
    }

    function isDefaultModelShortcutBinding(binding) {
      return Boolean(binding)
        && binding.code === DEFAULT_MODEL_SHORTCUT_BINDING.code
        && binding.ctrl === DEFAULT_MODEL_SHORTCUT_BINDING.ctrl
        && binding.alt === DEFAULT_MODEL_SHORTCUT_BINDING.alt
        && binding.shift === DEFAULT_MODEL_SHORTCUT_BINDING.shift
        && binding.meta === DEFAULT_MODEL_SHORTCUT_BINDING.meta;
    }

    function ModelShortcutSettingsGroup() {
      const shortcutState = useModelShortcuts();
      const [catalog, setCatalog] = useState({ models: [], current: null });
      const [catalogLoading, setCatalogLoading] = useState(true);
      const [catalogError, setCatalogError] = useState('');
      const [recording, setRecording] = useState(false);
      const [saving, setSaving] = useState(false);
      const [message, setMessage] = useState('');
      const [orderedSlots, setOrderedSlots] = useState(null);
      const [dragState, setDragState] = useState(null);
      const dragRef = useRef(null);
      const titleId = 'dsh-au-model-shortcuts-title';
      const binding = shortcutState.binding === undefined ? DEFAULT_MODEL_SHORTCUT_BINDING : shortcutState.binding;
      const savedSlots = normalizeModelShortcutSlots(shortcutState.slots);
      const slots = orderedSlots || savedSlots;

      // 配置与当前宿主目录分开加载：目录失败时仍保留已有配置，避免误清空不可用模型。
      useEffect(() => {
        let alive = true;
        void loadModelShortcuts().catch(() => {});
        setCatalogLoading(true);
        void loadModelShortcutCatalog()
          .then((nextCatalog) => {
            if (!alive) return;
            setCatalog({ models: Array.isArray(nextCatalog?.models) ? nextCatalog.models : [], current: nextCatalog?.current || null });
            setCatalogError('');
          })
          .catch(() => {
            if (alive) setCatalogError('读取当前模型目录失败，请稍后重试');
          })
          .finally(() => {
            if (alive) setCatalogLoading(false);
          });
        return () => { alive = false; };
      }, []);

      // 宿主保存成功后以返回的九槽数组为准；拖动预览只在一次保存完成前存在。
      useEffect(() => {
        setOrderedSlots(null);
        setDragState(null);
        dragRef.current = null;
      }, [shortcutState.slots]);

      // 录键时暂时屏蔽旧快捷键；Esc 只取消录入，不会写入配置。
      useEffect(() => {
        if (!recording) return undefined;
        shortcutStore.recording = true;
        const onKeyDown = (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (event.code === 'Escape') {
            setRecording(false);
            setMessage('');
            return;
          }
          const nextBinding = shortcutBindingFromEvent(event);
          if (!nextBinding) return;
          const result = validateModelShortcutBinding(nextBinding);
          if (!result.ok) {
            setMessage(result.reason || '这个组合键不能使用');
            return;
          }
          setRecording(false);
          void persistModelShortcutPatch({ binding: nextBinding }, setSaving, setMessage);
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
          window.removeEventListener('keydown', onKeyDown, true);
          shortcutStore.recording = false;
        };
      }, [recording]);

      const savePatch = (patch) => persistModelShortcutPatch(patch, setSaving, setMessage);
      const unavailableCount = slots.filter((slot) => slot && !modelShortcutCatalogModel(catalog, slot)).length;
      const hasConfiguredSlots = slots.some(Boolean);
      const bindingValidation = binding ? validateModelShortcutBinding(binding) : { ok: true, reason: '' };
      const controlsDisabled = !shortcutState.loaded || shortcutState.busy || saving;
      const statusMessage = message || shortcutState.error || catalogError
        || (!bindingValidation.ok ? `当前触发键不可用：${bindingValidation.reason}` : '');

      const focusModelShortcutHandle = (drag, index, fallback = drag?.focus) => {
        const rows = drag?.root ? [...drag.root.querySelectorAll('.dsh-au-model-shortcut-row')] : [];
        const handle = rows[index]?.querySelector?.('.dsh-au-model-shortcut-drag-handle');
        (handle || fallback)?.focus?.();
      };
      const releaseModelShortcutPointer = (drag) => {
        if (!drag?.captureTarget || !Number.isInteger(drag.pointerId)) return;
        drag.captureTarget.releasePointerCapture?.(drag.pointerId);
      };
      const cancelModelShortcutDrag = () => {
        const drag = dragRef.current;
        if (!drag) return;
        releaseModelShortcutPointer(drag);
        dragRef.current = null;
        setOrderedSlots(null);
        setDragState(null);
        focusModelShortcutHandle(drag, drag.from);
      };
      // Escape 可能来自 pointerdown 前的 input；窗口级监听保证拖动取消不依赖握柄焦点。
      useEffect(() => {
        const onWindowKeyDown = (event) => {
          if (event.key !== 'Escape' || !dragRef.current) return;
          event.preventDefault();
          event.stopPropagation();
          cancelModelShortcutDrag();
        };
        window.addEventListener('keydown', onWindowKeyDown, true);
        return () => {
          window.removeEventListener('keydown', onWindowKeyDown, true);
          releaseModelShortcutPointer(dragRef.current);
          dragRef.current = null;
        };
      }, []);
      const dropIndexFromPointer = (event, from) => {
        const container = event.currentTarget.closest?.('.dsh-au-model-shortcut-slots');
        const rowNodes = container ? [...container.querySelectorAll('.dsh-au-model-shortcut-row')] : [];
        if (!rowNodes.length) return from;
        const remaining = rowNodes.filter((_, index) => index !== from);
        const insertAt = remaining.findIndex((row) => event.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2);
        return insertAt < 0 ? MODEL_SHORTCUT_SLOT_COUNT - 1 : insertAt;
      };
      const beginModelShortcutDrag = (event, index) => {
        if (controlsDisabled || dragRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        const focusTarget = event.currentTarget;
        focusTarget.focus?.();
        focusTarget.setPointerCapture?.(event.pointerId);
        dragRef.current = {
          pointerId: event.pointerId,
          pointerType: event.pointerType || 'mouse',
          from: index,
          to: index,
          startX: event.clientX,
          startY: event.clientY,
          started: false,
          draft: slots,
          original: slots,
          focus: focusTarget,
          captureTarget: focusTarget,
          root: focusTarget.closest?.('.dsh-au-model-shortcut-slots'),
        };
        setDragState({ from: index, to: index, started: false });
      };
      const moveModelShortcutDrag = (event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
        if (!drag.started && distance < 6) return;
        drag.started = true;
        const to = dropIndexFromPointer(event, drag.from);
        if (to === drag.to) {
          setDragState({ from: drag.from, to, started: true });
          return;
        }
        drag.to = to;
        drag.draft = moveModelShortcutSlot(drag.original, drag.from, to);
        setOrderedSlots(drag.draft);
        setDragState({ from: drag.from, to, started: true });
      };
      const finishModelShortcutDrag = async (event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        releaseModelShortcutPointer(drag);
        dragRef.current = null;
        if (!drag.started || drag.to === drag.from) {
          setDragState(null);
          setOrderedSlots(null);
          focusModelShortcutHandle(drag, drag.from);
          return;
        }
        const next = drag.draft;
        setDragState({ from: drag.from, to: drag.to, started: true, saving: true });
        setOrderedSlots(next);
        const ok = await savePatch({ slots: next });
        if (!ok) setOrderedSlots(drag.original);
        setDragState(null);
        // 行号固定，成功后必须跟随同一个模型到目标槽；失败则回原槽。
        focusModelShortcutHandle(drag, ok ? drag.to : drag.from);
      };
      const reorderFromKeyboard = async (event, index) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          cancelModelShortcutDrag();
          return;
        }
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        event.stopPropagation();
        if (controlsDisabled || dragRef.current) return;
        const to = event.key === 'ArrowUp' ? index - 1 : index + 1;
        if (to < 0 || to >= MODEL_SHORTCUT_SLOT_COUNT) return;
        const original = slots;
        const next = moveModelShortcutSlot(original, index, to);
        const focusTarget = event.currentTarget;
        const focusDrag = {
          from: index,
          to,
          focus: focusTarget,
          root: focusTarget.closest?.('.dsh-au-model-shortcut-slots'),
        };
        setOrderedSlots(next);
        setDragState({ from: index, to, started: true, saving: true });
        const ok = await savePatch({ slots: next });
        if (!ok) setOrderedSlots(original);
        setDragState(null);
        focusModelShortcutHandle(focusDrag, ok ? to : index);
      };

      const rows = slots.map((slot, index) => {
        const availableModel = modelShortcutCatalogModel(catalog, slot);
        const models = catalog.models || [];
        const modelValue = modelShortcutSelectionKey(slot);
        const modelOptions = [
          ...(slot && !availableModel ? [{
            provider: slot.provider,
            model: slot.model,
            // 原生 select 不支持换行，状态说明放在字段下方而不是拼进名称。
            label: slot.label || slot.model,
            providerLabel: catalog.models?.find((m) => m.provider === slot.provider)?.providerLabel || slot.provider || '不可用模型',
            unavailable: true,
          }] : []),
          ...models,
        ];
        const groupedOptions = groupModelShortcutOptions(modelOptions, models);
        const efforts = Array.isArray(availableModel?.reasoningEfforts) ? availableModel.reasoningEfforts : [];
        const rawSavedEffort = slot?.reasoningEffort || '';
        const defaultEffort = resolveDefaultModelShortcutEffort(efforts, availableModel?.reasoningDefault);
        const savedEffort = rawSavedEffort || defaultEffort;
        const savedEffortAvailable = !rawSavedEffort || efforts.some((effort) => modelShortcutReasoningEffortId(effort) === rawSavedEffort);
        const rowBusy = Boolean(dragState?.saving);
        const vendor = slot ? modelShortcutVendorTone(slot.provider, slot.model) : undefined;
        // 预览数组已按目标位置重排，实际被拖动项现在位于 to 槽。
        const rowClass = `dsh-au-model-shortcut-row${dragState?.to === index && dragState.started ? ' is-dragging' : ''}`;
        const rowData = {
          key: index,
          className: rowClass,
          'data-slot-index': index,
          'data-has-model': slot ? 'true' : undefined,
          'data-empty': !slot ? 'true' : undefined,
          'data-vendor': vendor,
          'data-drop-target': dragState?.started && dragState.to === index ? 'true' : undefined,
        };
        return h(
          'div',
          rowData,
          h('span', { className: 'dsh-au-model-shortcut-number', 'aria-label': `第 ${index + 1} 行` }, `${index + 1}`),
          h('button', {
            type: 'button',
            className: 'dsh-au-model-shortcut-drag-handle',
            disabled: controlsDisabled || rowBusy,
            'aria-label': `调整第 ${index + 1} 项顺序`,
            title: '拖动排序；聚焦后可用 ↑ ↓ 调整',
            onPointerDown: (event) => beginModelShortcutDrag(event, index),
            onPointerMove: moveModelShortcutDrag,
            onPointerUp: finishModelShortcutDrag,
            onPointerCancel: cancelModelShortcutDrag,
            onKeyDown: (event) => { void reorderFromKeyboard(event, index); },
          },
            h('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
              h('path', { d: 'M5 3h1M10 3h1M5 8h1M10 8h1M5 13h1M10 13h1', fill: 'none', stroke: 'currentColor', 'stroke-linecap': 'round', 'stroke-width': '1.6' })
            )
          ),
          h(
            'div',
            { className: 'dsh-au-model-shortcut-main' },
            h(
              'label',
              { className: 'dsh-au-model-shortcut-select-label', title: slot ? `${slot.label || slot.model} · ${slot.provider} / ${slot.model}` : '选择模型' },
              h(
                'select',
                {
                  className: 'dsh-au-model-shortcut-select',
                  'aria-label': `第 ${index + 1} 个快捷模型`,
                  value: modelValue,
                  disabled: controlsDisabled || catalogLoading || rowBusy,
                  onChange: (event) => {
                    const selected = models.find((model) => modelShortcutSelectionKey(model) === event.target.value);
                    let nextSlot = null;
                    if (selected) {
                      const nextDefaultEffort = resolveDefaultModelShortcutEffort(selected.reasoningEfforts, selected.reasoningDefault);
                      nextSlot = {
                        provider: selected.provider,
                        model: selected.model,
                        label: selected.label,
                        ...(nextDefaultEffort ? { reasoningEffort: nextDefaultEffort } : {}),
                      };
                    }
                    if (!event.target.value || selected) {
                      void savePatch({ slots: slots.map((item, itemIndex) => itemIndex === index ? nextSlot : item) });
                    }
                  },
                },
                h('option', { value: '' }, '未选择模型'),
                groupedOptions.map((group) => h(
                  'optgroup',
                  {
                    key: group.id || group.label,
                    label: group.label,
                  },
                  group.models.map((model) => h(
                    'option',
                    {
                      key: modelShortcutSelectionKey(model),
                      value: modelShortcutSelectionKey(model),
                      disabled: model.unavailable,
                    },
                    model.label || model.model
                  ))
                ))
              )
            )
          ),
          // B 紧凑双行：厂商、强度和清除同行；异常说明仍在控件外换行。
          h('div', { className: 'dsh-au-model-shortcut-controls' },
            slot ? h('span', {
              className: 'dsh-au-model-shortcut-id',
              'data-vendor': vendor,
              title: `${availableModel?.providerLabel || slot.provider} / ${slot.model}`,
            },
              h('span', { className: 'dsh-au-vendor-dot', 'aria-hidden': 'true' }),
              `${availableModel?.providerLabel || slot.provider}`
            ) : null,
            slot
              ? efforts.length || savedEffort
                ? h(
                  'label',
                  { className: 'dsh-au-model-shortcut-effort', title: '推理强度设置' },
                  h('span', { className: 'dsh-au-model-shortcut-effort-tag' }, '推理强度'),
                  h(
                    'select',
                    {
                      className: 'dsh-au-model-shortcut-effort-select',
                      'aria-label': `第 ${index + 1} 个模型的推理强度`,
                      'aria-describedby': !savedEffortAvailable ? `${titleId}-effort-${index + 1}` : undefined,
                      value: savedEffort,
                      disabled: controlsDisabled || rowBusy,
                      onChange: (event) => {
                        const nextSlot = { ...slot };
                        if (event.target.value) nextSlot.reasoningEffort = event.target.value;
                        else delete nextSlot.reasoningEffort;
                        void savePatch({ slots: slots.map((item, itemIndex) => itemIndex === index ? nextSlot : item) });
                      },
                    },
                    !savedEffortAvailable
                      ? h('option', { value: rawSavedEffort, disabled: true }, rawSavedEffort)
                      : null,
                    efforts.map((effort) => {
                      const effortId = modelShortcutReasoningEffortId(effort);
                      return h('option', { key: effortId, value: effortId }, modelShortcutReasoningEffortLabel(effort));
                    })
                  ),
                  !savedEffortAvailable
                    ? h('span', { id: `${titleId}-effort-${index + 1}`, className: 'dsh-au-model-shortcut-effort-hint', role: 'status' }, '当前档位不可用，保留原值')
                    : null
                )
                : h('div', { className: 'dsh-au-model-shortcut-effort dsh-au-model-shortcut-effort-none' },
                    h('span', { className: 'dsh-au-model-shortcut-effort-tag' }, '推理强度'),
                    h('span', { className: 'dsh-au-model-shortcut-effort-default', title: '宿主未提供可调档位' }, '提供方默认')
                  )
              : null,
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-au-btn dsh-au-model-shortcut-row-clear',
                disabled: controlsDisabled || rowBusy || !slot,
                title: slot ? `清除第 ${index + 1} 个快捷模型` : '未配置模型',
                onClick: () => void savePatch({ slots: slots.map((item, itemIndex) => itemIndex === index ? null : item) }),
              },
              '清除'
            )
          ),
          slot && !availableModel
            ? h('div', { className: 'dsh-au-model-shortcut-meta-line' },
                h('span', { className: 'dsh-au-model-shortcut-status', 'data-tone': 'warn', role: 'status', title: '当前目录不可用，保留已有配置' },
                  h('span', { className: 'dsh-au-model-shortcut-warn-dot', 'aria-hidden': 'true' }),
                  '不可用 · 保留已有配置'
                )
              )
            : null
        );
      });

      return h(
        'section',
        { className: 'dsh-au-settings-group dsh-au-model-shortcut-group', 'aria-labelledby': titleId },
        h('h3', { id: titleId }, '模型快捷切换'),
        h(
          'div',
          { className: 'dsh-au-settings-row dsh-au-model-shortcut-hero' },
          h(
            'div',
            { className: 'dsh-au-settings-desc' },
            h('span', { className: 'dsh-au-settings-title' }, '启用模型快捷切换'),
            h('p', { className: 'dsh-au-settings-subtitle' }, '按绑定键打开列表，再用数字键选择；配置保存到项目，不实时广播、不自动提交。')
          ),
          h(
            'button',
            {
              type: 'button',
              role: 'switch',
              className: 'dsh-au-switch',
              'aria-checked': shortcutState.enabled,
              'aria-labelledby': titleId,
              disabled: controlsDisabled,
              onClick: () => void savePatch({ enabled: !shortcutState.enabled }),
            },
            h('span', { className: 'dsh-au-switch-knob', 'aria-hidden': 'true' })
          )
        ),
        h(
          'div',
          { className: 'dsh-au-model-shortcut-trigger-card' },
          h(
            'div',
            { className: 'dsh-au-model-shortcut-trigger-main' },
            h('span', { className: 'dsh-au-model-shortcut-trigger-label' }, '触发按键'),
            h(
              'kbd',
              { className: `dsh-au-kbd dsh-au-model-shortcut-trigger-kbd${recording ? ' recording' : ''}` },
              recording ? '请按下快捷键组合…' : describeShortcutBinding(binding)
            ),
            h('span', { className: 'dsh-au-settings-hint' }, '其他快捷键仍按原方式保存在当前浏览器。')
          ),
          h(
            'div',
            { className: 'dsh-au-shortcut-footer dsh-au-model-shortcut-trigger-actions' },
            h('button', {
              type: 'button',
              className: `dsh-au-btn${recording ? ' primary' : ''}`,
              disabled: controlsDisabled,
              onClick: () => {
                setMessage('');
                setRecording(!recording);
              },
            }, recording ? '取消录入' : '修改触发键'),
            h('button', {
              type: 'button',
              className: 'dsh-au-btn',
              disabled: controlsDisabled || !binding,
              onClick: () => void savePatch({ binding: null }),
            }, '清除'),
            h('button', {
              type: 'button',
              className: 'dsh-au-btn',
              disabled: controlsDisabled || isDefaultModelShortcutBinding(binding),
              onClick: () => void savePatch({ binding: DEFAULT_MODEL_SHORTCUT_BINDING }),
            }, '恢复默认')
          )
        ),
        h('div', { className: 'dsh-au-model-shortcut-meta-header' },
          h('p', { className: 'dsh-au-settings-hint' },
            catalogLoading
              ? [h('span', { key: 'dot', className: 'dsh-au-model-shortcut-pulse-dot', 'aria-hidden': 'true' }), ' 正在读取当前模型目录…']
              : `可配置 ${MODEL_SHORTCUT_SLOT_COUNT} 个位置${unavailableCount ? `；${unavailableCount} 个已有模型当前不可用` : ''}。`
          ),
          h('button', {
            type: 'button',
            className: 'dsh-au-btn dsh-au-model-shortcut-clear-all',
            disabled: controlsDisabled || Boolean(dragState?.saving) || !hasConfiguredSlots,
            title: hasConfiguredSlots ? '清除全部已配置的快捷模型' : '当前没有已配置的快捷模型',
            onClick: () => void savePatch({ slots: Array.from({ length: MODEL_SHORTCUT_SLOT_COUNT }, () => null) }),
          }, '一键清除')
        ),
        h('div', { className: 'dsh-au-model-shortcut-slots' }, rows),
        statusMessage ? h('p', { className: 'dsh-au-model-shortcut-status', 'data-tone': 'error', role: 'alert' }, statusMessage) : null,
      );
    }

    async function persistModelShortcutPatch(patch, setSaving, setMessage) {
      setSaving(true);
      setMessage('');
      try {
        await saveModelShortcuts(patch);
        setMessage('已保存到项目配置');
        return true;
      } catch (error) {
        setMessage(error?.message || '保存模型快捷切换配置失败，请稍后重试');
        return false;
      } finally {
        setSaving(false);
      }
    }

    /** 设置页外层清爽入口：单行开关 + 「配置快捷模型」按钮打开独立弹窗（内部复用 ModelShortcutSettingsGroup）。 */
    function ModelShortcutSettingsSection() {
      const shortcutState = useModelShortcuts();
      const [modalOpen, setModalOpen] = useState(false);
      const [saving, setSaving] = useState(false);
      const [message, setMessage] = useState('');
      const titleId = 'dsh-au-model-shortcuts-section-title';

      useEffect(() => {
        void loadModelShortcuts().catch(() => {});
      }, []);

      useEffect(() => {
        if (!modalOpen) return undefined;
        const onKeyDown = (event) => {
          if (event.key === 'Escape' && !shortcutStore.recording) {
            event.preventDefault();
            setModalOpen(false);
          }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, [modalOpen]);

      useEffect(() => {
        const onOpen = (event) => {
          if (event.detail?.anchor !== 'modelShortcuts') return;
          setModalOpen(true);
        };
        window.addEventListener('dsh-au-open-settings-modal', onOpen);
        return () => window.removeEventListener('dsh-au-open-settings-modal', onOpen);
      }, []);

      const binding = shortcutState.binding === undefined ? DEFAULT_MODEL_SHORTCUT_BINDING : shortcutState.binding;
      const savedSlots = normalizeModelShortcutSlots(shortcutState.slots);
      const configuredCount = savedSlots.filter(Boolean).length;
      const controlsDisabled = !shortcutState.loaded || shortcutState.busy || saving;
      const triggerText = describeShortcutBinding(binding);
      const hintText = `已配置 ${configuredCount}/${MODEL_SHORTCUT_SLOT_COUNT} 个槽位 · 触发键：${triggerText}${message ? ` · ${message}` : ''}`;

      return h(
        'section',
        { className: 'dsh-au-settings-group', 'aria-labelledby': titleId },
        h('h3', { id: titleId }, '模型快捷切换'),
        h(SettingsItem, {
          title: '启用模型快捷切换',
          description: '按触发键打开模型列表，再用数字键 1~9 快速切换当前对话模型与推理强度。',
          hint: hintText,
          control: h(
            'button',
            {
              type: 'button',
              role: 'switch',
              className: 'dsh-au-switch',
              'aria-checked': shortcutState.enabled,
              'aria-labelledby': titleId,
              disabled: controlsDisabled,
              onClick: () => { void persistModelShortcutPatch({ enabled: !shortcutState.enabled }, setSaving, setMessage); },
            },
            h('span', { className: 'dsh-au-switch-knob', 'aria-hidden': 'true' })
          ),
          actions: h(
            'button',
            {
              type: 'button',
              className: 'dsh-au-btn',
              onClick: () => setModalOpen(true),
            },
            `配置快捷模型 (${configuredCount}/${MODEL_SHORTCUT_SLOT_COUNT})`
          ),
        }),
        modalOpen
          ? portalSettingsModal(h(
              'div',
              {
                className: 'dsh-au-modal-mask dsh-au-modal-mask-above',
                onClick: (e) => { if (e.target === e.currentTarget && !shortcutStore.recording) setModalOpen(false); },
              },
              h(
                'div',
                { className: 'dsh-au-cloud-sync-modal dsh-au-model-shortcut-modal', role: 'dialog', 'aria-modal': 'true' },
                h(
                  'div',
                  { className: 'dsh-au-cloud-sync-modal-header' },
                  h(
                    'div',
                    null,
                    h('h3', null, '配置快捷模型与触发键'),
                    h('p', null, '支持修改触发组合键，并为 1~9 号数字槽位指定模型、推理强度及拖拽排序。')
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-au-cloud-sync-modal-close',
                      onClick: () => setModalOpen(false),
                      title: '关闭弹窗',
                    },
                    '×'
                  )
                ),
                h(
                  'div',
                  { className: 'dsh-au-cloud-sync-list dsh-au-model-shortcut-modal-body' },
                  h(ModelShortcutSettingsGroup)
                ),
                h(
                  'div',
                  { className: 'dsh-au-cloud-sync-modal-footer' },
                  h('div', { className: 'dsh-au-cloud-sync-modal-footer-left' }),
                  h(
                    'div',
                    { className: 'dsh-au-cloud-sync-modal-footer-right' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-au-btn dsh-au-btn-primary',
                        onClick: () => setModalOpen(false),
                      },
                      '完成'
                    )
                  )
                )
              )
            ))
          : null
      );
    }

    const modelShortcutSettingsHelpers = {
      ModelShortcutSettingsGroup,
      ModelShortcutSettingsSection,
      normalizeModelShortcutSlots,
      modelShortcutSelectionKey,
      moveModelShortcutSlot,
      modelShortcutSlotsEqual,
      groupModelShortcutOptions,
    };
