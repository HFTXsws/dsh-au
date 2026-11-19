    // ===== 设置页：快捷键管理 =====
    function ShortcutSettingsGroup() {
      const overrides = useShortcutOverrides();
      const [recordingId, setRecordingId] = useState('');
      const [message, setMessage] = useState('');
      const titleId = 'dsh-au-shortcuts-title';

      useEffect(() => {
        if (!recordingId) return undefined;
        shortcutStore.recording = true;
        const onKeyDown = (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (event.code === 'Escape') {
            setRecordingId('');
            setMessage('');
            return;
          }
          const binding = shortcutBindingFromEvent(event);
          if (!binding) return;
          const result = validateShortcutBinding(binding, recordingId);
          if (!result.ok) {
            setMessage(result.reason);
            return;
          }
          setShortcutBinding(recordingId, binding);
          setRecordingId('');
          setMessage('');
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
          window.removeEventListener('keydown', onKeyDown, true);
          shortcutStore.recording = false;
        };
      }, [recordingId]);

      const rows = SHORTCUT_ACTIONS.map((action) => {
        const customized = Object.prototype.hasOwnProperty.call(overrides, action.id);
        const binding = effectiveShortcutBinding(action.id, overrides);
        const recording = recordingId === action.id;
        return h(
          'div',
          { key: action.id, className: 'dsh-au-shortcut-row' },
          h('span', { className: 'dsh-au-shortcut-label' }, action.label),
          h(
            'kbd',
            { className: `dsh-au-kbd${recording ? ' recording' : ''}${binding ? '' : ' empty'}` },
            recording ? '请按下新的组合键…' : describeShortcutBinding(binding)
          ),
          h(
            'span',
            { className: 'dsh-au-shortcut-actions' },
            h('button', {
              type: 'button',
              className: 'dsh-au-btn',
              onClick: () => {
                setMessage('');
                setRecordingId(recording ? '' : action.id);
              },
            }, recording ? '取消' : '修改'),
            h('button', {
              type: 'button',
              className: 'dsh-au-btn',
              disabled: !binding,
              onClick: () => setShortcutBinding(action.id, null),
            }, '清除'),
            h('button', {
              type: 'button',
              className: 'dsh-au-btn',
              disabled: !customized,
              onClick: () => setShortcutBinding(action.id, undefined),
            }, '恢复默认')
          )
        );
      });

      return h(
        'section',
        { className: 'dsh-au-settings-group', 'aria-labelledby': titleId },
        h('h3', { id: titleId }, '快捷键'),
        h(
          'p',
          { className: 'dsh-au-settings-desc' },
          '点「修改」后直接按下新的组合键，Esc 取消。需带 Ctrl、Alt 或 Cmd（F1 到 F24 除外），且不能与其他动作重复。设置只保存在当前浏览器，焦点在远端设备页面里时同样生效。'
        ),
        h('div', { className: 'dsh-au-shortcut-list' }, rows),
        message ? h('p', { className: 'dsh-au-settings-hint dsh-au-shortcut-error', role: 'alert' }, message) : null,
        h(
          'div',
          { className: 'dsh-au-shortcut-footer' },
          h('button', {
            type: 'button',
            className: 'dsh-au-btn',
            disabled: Object.keys(overrides).length === 0,
            onClick: () => {
              setMessage('');
              resetAllShortcuts();
            },
          }, '全部恢复默认')
        )
      );
    }

    /** 设置页外层清爽入口：单行展示 + 「配置快捷键」按钮打开独立弹窗（内部复用 ShortcutSettingsGroup）。 */
    function ShortcutSettingsSection() {
      const overrides = useShortcutOverrides();
      const [modalOpen, setModalOpen] = useState(false);
      const titleId = 'dsh-au-shortcuts-section-title';
      const customCount = Object.keys(overrides).length;
      const summaryItems = SHORTCUT_ACTIONS.slice(0, 3).map((action) => {
        const binding = effectiveShortcutBinding(action.id, overrides);
        return `${action.label}：${describeShortcutBinding(binding)}`;
      });
      const hintText = `共 ${SHORTCUT_ACTIONS.length} 项快捷键（已自定义 ${customCount} 项）· ${summaryItems.join(' · ')} · 设置保存在当前浏览器`;

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
          if (event.detail?.anchor !== 'shortcuts') return;
          setModalOpen(true);
        };
        window.addEventListener('dsh-au-open-settings-modal', onOpen);
        return () => window.removeEventListener('dsh-au-open-settings-modal', onOpen);
      }, []);

      return h(
        'section',
        { className: 'dsh-au-settings-group', 'aria-labelledby': titleId },
        h('h3', { id: titleId }, '快捷键'),
        h(SettingsItem, {
          title: '全局与远程页面快捷键',
          description: '自定义工作台、新建会话与设备切换等组合键；设置只保存在当前浏览器，焦点在远端设备页面里时同样生效。',
          hint: hintText,
          actions: h(
            'button',
            {
              type: 'button',
              className: 'dsh-au-btn',
              onClick: () => setModalOpen(true),
            },
            customCount > 0 ? `配置快捷键 (已改 ${customCount} 项)` : '配置快捷键'
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
                { className: 'dsh-au-cloud-sync-modal dsh-au-shortcut-modal', role: 'dialog', 'aria-modal': 'true' },
                h(
                  'div',
                  { className: 'dsh-au-cloud-sync-modal-header' },
                  h(
                    'div',
                    null,
                    h('h3', null, '配置快捷键'),
                    h('p', null, '点「修改」后直接按下新的组合键，Esc 取消。需带 Ctrl、Alt 或 Cmd（F1 到 F24 除外），且不能与其他动作重复。')
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
                  { className: 'dsh-au-cloud-sync-list dsh-au-shortcut-modal-body' },
                  h(ShortcutSettingsGroup)
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
