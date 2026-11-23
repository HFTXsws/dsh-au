    /** 内置功能开关存宿主机配置；新建目标限制默认关闭，不投射到其他主机。 */
    const featuresStore = {
      snapshot: {
        todo: false, remoteManagement: true, fullAccessByDefault: false, blockGoalCreation: false, disconnectRemotesOnLock: false, sidebarWorkbench: false, sidebarExtensions: {}, sidebarExtensionCatalog: [], goalCreationError: '',
        loaded: false, busy: false, error: '',
        /** 自动续跑默认关闭，且没有规则。 */
        autoContinue: { enabled: false, retryDelaySec: 60, maxRetries: 5, compactOnDisconnect: true, continueOnTruncate: true, prompt: '继续', rules: [] },
      },
      listeners: new Set(),
    };

    function publishFeatures(patch) {
      featuresStore.snapshot = { ...featuresStore.snapshot, ...patch };
      for (const listener of featuresStore.listeners) listener(featuresStore.snapshot);
    }

    function useFeatures() {
      const [snapshot, setSnapshot] = useState(featuresStore.snapshot);
      useEffect(() => {
        featuresStore.listeners.add(setSnapshot);
        setSnapshot(featuresStore.snapshot);
        return () => { featuresStore.listeners.delete(setSnapshot); };
      }, []);
      return snapshot;
    }

    function broadcastFeaturesToControlledFrames() {
      if (typeof document === 'undefined') return;
      try {
        const frames = document.querySelectorAll('iframe.dsh-au-iframe');
        for (const frame of frames) {
          if (frame?.contentWindow && typeof postShortcutConfig === 'function') {
            postShortcutConfig(frame.contentWindow);
          }
        }
      } catch {}
    }

    async function loadFeatures() {
      try {
        const res = await callApi('getFeatures');
        if (res?.ok && res.features) {
          if (res.clientPreferences && typeof res.clientPreferences === 'object') {
            if (typeof res.clientPreferences.mobileEnabled === 'boolean') {
              writeMobileFeatureEnabled(res.clientPreferences.mobileEnabled);
            }
            if (res.clientPreferences.shortcutOverrides && typeof res.clientPreferences.shortcutOverrides === 'object') {
              setShortcutOverrides(normalizeShortcutOverrides(res.clientPreferences.shortcutOverrides));
            }
          }
          /** 兜底归一化 autoContinue，确保每个字段都有合法默认值 */
          const ac = res.autoContinue && typeof res.autoContinue === 'object' ? res.autoContinue : {};
          const def = featuresStore.snapshot.autoContinue;
          const rules = Array.isArray(ac.rules) ? ac.rules : [];
          const autoContinue = {
            enabled:            typeof ac.enabled            === 'boolean' ? ac.enabled            : def.enabled,
            retryDelaySec:      typeof ac.retryDelaySec      === 'number'  ? ac.retryDelaySec      : def.retryDelaySec,
            maxRetries:         typeof ac.maxRetries         === 'number'  ? ac.maxRetries         : def.maxRetries,
            compactOnDisconnect:typeof ac.compactOnDisconnect=== 'boolean' ? ac.compactOnDisconnect: def.compactOnDisconnect,
            continueOnTruncate: typeof ac.continueOnTruncate === 'boolean' ? ac.continueOnTruncate : def.continueOnTruncate,
            prompt:             typeof ac.prompt             === 'string'  ? ac.prompt             : def.prompt,
            rules,
          };
          publishFeatures({
            todo: res.features.todo !== false,
            remoteManagement: res.features.remoteManagement !== false,
            fullAccessByDefault: res.features.fullAccessByDefault === true,
            blockGoalCreation: res.features.blockGoalCreation === true,
            disconnectRemotesOnLock: res.features.disconnectRemotesOnLock === true,
            sidebarWorkbench: res.features.sidebarWorkbench === true,
            sidebarExtensions: res.features.sidebarExtensions && typeof res.features.sidebarExtensions === 'object' && !Array.isArray(res.features.sidebarExtensions)
              ? res.features.sidebarExtensions
              : {},
            sidebarExtensionCatalog: Array.isArray(res.sidebarExtensionCatalog) ? res.sidebarExtensionCatalog : [],
            goalCreationError: typeof res.goalCreationError === 'string' ? res.goalCreationError : '',
            loaded: true,
            error: '',
            autoContinue,
          });
        }
      } catch {
        publishFeatures({ error: '读取功能开关失败' });
      }
    }

    async function saveTodoFeature(next) {
      publishFeatures({ busy: true, error: '' });
      try {
        const res = await callApi('saveFeatures', { todo: Boolean(next) });
        if (!res?.ok) throw new Error(res?.error || 'save failed');
        publishFeatures({ todo: res.features.todo !== false, busy: false });
        broadcastFeaturesToControlledFrames();
      } catch {
        publishFeatures({ busy: false, error: '保存失败，请稍后重试' });
      }
    }

    /** 远程 DSH 管理开关存宿主配置；关闭后外壳立即收起设备栏与远程页面。 */
    async function saveRemoteManagementFeature(next) {
      publishFeatures({ busy: true, error: '' });
      try {
        const res = await callApi('saveFeatures', { remoteManagement: Boolean(next) });
        if (!res?.ok || typeof res.features?.remoteManagement !== 'boolean') throw new Error(res?.error || 'save failed');
        publishFeatures({ remoteManagement: res.features.remoteManagement, busy: false });
      } catch {
        publishFeatures({ busy: false, error: '保存失败，请稍后重试' });
      }
    }

    async function saveFullAccessFeature(next) {
      publishFeatures({ busy: true, error: '' });
      try {
        const res = await callApi('saveFeatures', { fullAccessByDefault: Boolean(next) });
        if (!res?.ok) throw new Error(res?.error || 'save failed');
        publishFeatures({
          todo: res.features.todo !== false,
          fullAccessByDefault: res.features.fullAccessByDefault === true,
          busy: false,
        });
        broadcastFeaturesToControlledFrames();
      } catch {
        publishFeatures({ busy: false, error: '保存失败，请稍后重试' });
      }
    }

    /** 只保存这台电脑的锁屏断开开关，不写进会同步到其他电脑的偏好。 */
    async function saveLockRemoteFeature(next) {
      publishFeatures({ busy: true, error: '' });
      try {
        const res = await callApi('saveFeatures', { disconnectRemotesOnLock: Boolean(next) });
        if (!res?.ok || typeof res.features?.disconnectRemotesOnLock !== 'boolean') {
          throw new Error(res?.error || '保存失败，请稍后重试');
        }
        publishFeatures({
          disconnectRemotesOnLock: res.features.disconnectRemotesOnLock,
          busy: false,
        });
      } catch (error) {
        publishFeatures({ busy: false, error: error?.message || '保存失败，请稍后重试' });
      }
    }

    /** 保存侧边栏工作台入口开关；开启后在左侧边栏添加 DSH AU 入口。 */
    async function saveSidebarWorkbenchFeature(next) {
      publishFeatures({ busy: true, error: '' });
      try {
        const res = await callApi('saveFeatures', { sidebarWorkbench: Boolean(next) });
        if (!res?.ok || typeof res.features?.sidebarWorkbench !== 'boolean') {
          throw new Error(res?.error || '保存失败，请稍后重试');
        }
        publishFeatures({
          sidebarWorkbench: res.features.sidebarWorkbench,
          busy: false,
        });
      } catch (error) {
        publishFeatures({ busy: false, error: error?.message || '保存失败，请稍后重试' });
      }
    }

    /** 保存本机单个侧边栏私人扩展的挂载开关；仅落盘本机，不同步到其它设备。 */
    async function saveSidebarExtensionFeature(extId, next) {
      publishFeatures({ busy: true, error: '' });
      try {
        const res = await callApi('saveFeatures', { sidebarExtensions: { [extId]: Boolean(next) } });
        if (!res?.ok || !res.features?.sidebarExtensions || typeof res.features.sidebarExtensions !== 'object') {
          throw new Error(res?.error || '保存失败，请稍后重试');
        }
        publishFeatures({
          sidebarExtensions: res.features.sidebarExtensions,
          busy: false,
        });
      } catch (error) {
        publishFeatures({ busy: false, error: error?.message || '保存失败，请稍后重试' });
      }
    }

    /** 仅保存当前宿主的新建目标限制；未确认的回执不能冒充已保存。 */
    async function saveGoalCreationFeature(next) {
      publishFeatures({ busy: true, error: '' });
      try {
        const res = await callApi('saveFeatures', { blockGoalCreation: Boolean(next) });
        if (!res?.ok || typeof res.features?.blockGoalCreation !== 'boolean') {
          throw new Error(res?.error || '保存失败，请稍后重试');
        }
        publishFeatures({
          blockGoalCreation: res.features.blockGoalCreation,
          goalCreationError: typeof res.goalCreationError === 'string' ? res.goalCreationError : '',
          busy: false,
        });
      } catch (error) {
        publishFeatures({ busy: false, error: error?.message || '保存失败，请稍后重试' });
      }
    }

    /** 保存自动续跑配置；合并当前快照与 patch，成功后用服务端回执更新状态并短暂提示。 */
    async function saveAutoContinueFeature(patch) {
      publishFeatures({ busy: true, error: '', autoContinueSaved: false });
      try {
        const current = featuresStore.snapshot.autoContinue;
        const nextAutoContinue = { ...current, ...patch };
        const res = await callApi('saveFeatures', { autoContinue: nextAutoContinue });
        if (!res?.ok) throw new Error(res?.error || '保存失败，请稍后重试');
        // 用服务端回执中的 autoContinue 归一化更新（兜底沿用 nextAutoContinue）
        const ac = res.autoContinue && typeof res.autoContinue === 'object' ? res.autoContinue : nextAutoContinue;
        const def = featuresStore.snapshot.autoContinue;
        const rules = Array.isArray(ac.rules) ? ac.rules : (Array.isArray(nextAutoContinue.rules) ? nextAutoContinue.rules : []);
        publishFeatures({
          busy: false,
          autoContinueSaved: true,
          autoContinue: {
            enabled:            typeof ac.enabled            === 'boolean' ? ac.enabled            : def.enabled,
            retryDelaySec:      typeof ac.retryDelaySec      === 'number'  ? ac.retryDelaySec      : def.retryDelaySec,
            maxRetries:         typeof ac.maxRetries         === 'number'  ? ac.maxRetries         : def.maxRetries,
            compactOnDisconnect:typeof ac.compactOnDisconnect=== 'boolean' ? ac.compactOnDisconnect: def.compactOnDisconnect,
            continueOnTruncate: typeof ac.continueOnTruncate === 'boolean' ? ac.continueOnTruncate : def.continueOnTruncate,
            prompt:             typeof ac.prompt             === 'string'  ? ac.prompt             : def.prompt,
            rules,
          },
        });
        // 短暂清除「已保存」提示
        setTimeout(() => { publishFeatures({ autoContinueSaved: false }); }, 3000);
        return true;
      } catch (error) {
        publishFeatures({ busy: false, error: error?.message || '保存失败，请稍后重试' });
        return false;
      }
    }

    /** 设置条目：标题与开关一行，下面依次是说明、补充、注释和按钮。 */
    function SettingsItem({ title, description, extra, hint, control, actions }) {
      const hints = (Array.isArray(hint) ? hint : [hint]).filter((line) => line != null && line !== '');
      const desc = description == null || description === ''
        ? []
        : (Array.isArray(description) ? description : [description]);
      return h(
        'div',
        { className: 'dsh-au-settings-item' },
        h(
          'div',
          { className: 'dsh-au-settings-item-head' },
          h('span', { className: 'dsh-au-settings-title' }, title),
          control || null
        ),
        desc.length ? h('p', { className: 'dsh-au-settings-desc' }, ...desc) : null,
        extra ? h('div', { className: 'dsh-au-settings-item-extra' }, extra) : null,
        ...hints.map((line) => h('p', { className: 'dsh-au-settings-hint' }, line)),
        actions ? h('div', { className: 'dsh-au-settings-item-actions' }, actions) : null
      );
    }

    function FeatureSwitchGroup({ id, heading, title, description, checked, disabled, onToggle, hint }) {
      const titleId = `dsh-au-feature-${id}-title`;
      return h(
        'section',
        { className: 'dsh-au-settings-group', 'aria-labelledby': titleId },
        h('h3', { id: titleId }, heading),
        h(SettingsItem, {
          title,
          description,
          hint,
          control: h(
            'button',
            {
              type: 'button',
              role: 'switch',
              className: 'dsh-au-switch',
              'aria-checked': checked,
              'aria-labelledby': titleId,
              disabled,
              onClick: onToggle,
            },
            h('span', { className: 'dsh-au-switch-knob', 'aria-hidden': 'true' })
          ),
        })
      );
    }

    function TodoFeatureGroup() {
      const features = useFeatures();
      return h(FeatureSwitchGroup, {
        id: 'todo',
        heading: '待办面板',
        title: '启用待办面板',
        description: '在对话顶部显示跨设备的对话待办面板，可排序、暂存并续跑。关闭后这台电脑不再提供待办接口，其他设备会自动改用原生会话列表。',
        checked: features.todo,
        disabled: !features.loaded || features.busy,
        onToggle: () => { void saveTodoFeature(!features.todo); },
        hint: features.error || '',
      });
    }

    /** 远程 DSH 管理：开关控制设备栏是否出现；按钮直接打开远程设备管理弹窗。 */
    function RemoteManagementFeatureGroup() {
      const features = useFeatures();
      const titleId = 'dsh-au-feature-remote-management-title';
      const enabled = features.remoteManagement !== false;
      return h(
        'section',
        { className: 'dsh-au-settings-group', 'aria-labelledby': titleId },
        h('h3', { id: titleId }, '远程 DSH 管理'),
        h(SettingsItem, {
          title: '启用远程 DSH 管理',
          description: '在对话顶部显示设备栏，可切换和管理本机与远程 DSH 设备。关闭后设备栏与远程页面全部隐藏，打开后立即恢复。',
          hint: features.error || (enabled ? '已开启：顶部显示设备栏。' : '已关闭：设备栏与远程页面已隐藏。'),
          control: h(
            'button',
            {
              type: 'button',
              role: 'switch',
              className: 'dsh-au-switch',
              'aria-checked': enabled,
              'aria-labelledby': titleId,
              disabled: !features.loaded || features.busy,
              onClick: () => { void saveRemoteManagementFeature(!enabled); },
            },
            h('span', { className: 'dsh-au-switch-knob', 'aria-hidden': 'true' })
          ),
          actions: h(
            'button',
            {
              type: 'button',
              className: 'dsh-au-btn',
              disabled: !enabled,
              // 由外壳统一打开远程设备管理弹窗，避免在设置页重复一份设备状态。
              onClick: () => window.dispatchEvent(new CustomEvent(OPEN_REMOTE_MANAGER_EVENT)),
            },
            '管理远程设备'
          ),
        })
      );
    }

    function FullAccessFeatureGroup() {
      const features = useFeatures();
      return h(FeatureSwitchGroup, {
        id: 'full-access',
        heading: '默认权限模式',
        title: '新开对话默认完全权限',
        description: '开启后，本地和远程 DSH 新开对话时均默认使用「完全权限」模式（绕过命令执行与文件读写二次确认，免除手动切换与频繁审批）。关闭后恢复默认权限模式。',
        checked: features.fullAccessByDefault,
        disabled: !features.loaded || features.busy,
        onToggle: () => { void saveFullAccessFeature(!features.fullAccessByDefault); },
        hint: features.error || (features.fullAccessByDefault ? '已开启：本地与远程新建对话将默认采用完全权限模式。' : '已关闭：新建对话使用工作区内修改模式。'),
      });
    }

    function GoalCreationFeatureGroup() {
      const features = useFeatures();
      return h(FeatureSwitchGroup, {
        id: 'goal-creation',
        heading: '目标创建限制',
        title: '禁止 AI 新建目标',
        description: '开启后，禁止 AI 在这台电脑上新建 DSH 目标；不影响已有目标及其恢复/续跑，普通任务照常执行。',
        checked: features.blockGoalCreation,
        disabled: !features.loaded || features.busy,
        onToggle: () => { void saveGoalCreationFeature(!features.blockGoalCreation); },
        hint: features.error || features.goalCreationError || '对后续工具执行立即生效；随 dsh-au 设置跨电脑同步。',
      });
    }

    function LockRemoteFeatureGroup() {
      const features = useFeatures();
      return h(FeatureSwitchGroup, {
        id: 'lock-remotes',
        heading: '锁屏断开远程',
        title: '锁屏时断开远程 DSH',
        description: '开启后，这台电脑锁屏时断开已经打开的远程 DSH，锁屏期间不重连。解锁后自动重连，并恢复这些页面和预加载。',
        checked: features.disconnectRemotesOnLock === true,
        disabled: !features.loaded || features.busy,
        onToggle: () => { void saveLockRemoteFeature(!features.disconnectRemotesOnLock); },
        hint: features.error || '只保存在这台电脑，不会同步到其他电脑。关闭时仍只暂停远程同步。',
      });
    }

    function MobileFeatureGroup() {
      const [enabled, setEnabled] = useState(readMobileFeatureEnabled);
      const [changed, setChanged] = useState(false);
      return h(FeatureSwitchGroup, {
        id: 'mobile',
        heading: 'DSH 移动端优化',
        title: '启用移动端优化',
        description: '适配移动端 DSH，界面更简洁，内容展示更充分。',
        checked: enabled,
        disabled: false,
        onToggle: () => {
          const next = !enabled;
          writeMobileFeatureEnabled(next);
          setEnabled(next);
          setChanged(true);
          void callApi('saveFeatures', { clientPreferences: { mobileEnabled: Boolean(next) } }).catch(() => {});
        },
        hint: changed ? '已保存，刷新页面后生效。' : '设置保存在这台电脑（支持随 dsh-au 云插件跨电脑同步），刷新页面后生效。',
      });
    }

    function normalizeRuleForDraft(r) {
      const statusCodes = Array.isArray(r.statusCodes) ? r.statusCodes : [];
      const keywords = Array.isArray(r.keywords) ? r.keywords : [];
      return {
        id: r.id || `rule-${Math.random().toString(36).slice(2, 9)}`,
        name: typeof r.name === 'string' ? r.name : '未命名规则',
        enabled: r.enabled !== false,
        statusCodes,
        statusCodesStr: statusCodes.join(', '),
        keywords,
        keywordsStr: keywords.join(', '),
        action: r.action === 'compact_retry' || r.action === 'followup_prompt' ? r.action : 'wait_retry',
        delaySec: typeof r.delaySec === 'number' ? r.delaySec : (r.action === 'compact_retry' ? 0 : 60),
        maxRetries: typeof r.maxRetries === 'number' ? r.maxRetries : 5,
        compactOnSecondAttempt: Boolean(r.compactOnSecondAttempt),
      };
    }

    /** 自动续跑与智能恢复独立参数配置弹窗（结构化规则卡片编辑器） */
    function AutoContinueModal({ isOpen, onClose, autoContinue, busy, error, onSave }) {
      const [draftRules, setDraftRules] = useState(() => {
        const source = Array.isArray(autoContinue?.rules) ? autoContinue.rules : [];
        return source.map(normalizeRuleForDraft);
      });
      const [continueOnTruncate, setContinueOnTruncate] = useState(() => autoContinue?.continueOnTruncate ?? true);
      const [prompt, setPrompt] = useState(() => autoContinue?.prompt ?? '继续');
      const [localError, setLocalError] = useState('');

      useEffect(() => {
        if (!isOpen) return;
        const source = Array.isArray(autoContinue?.rules) ? autoContinue.rules : [];
        setDraftRules(source.map(normalizeRuleForDraft));
        setContinueOnTruncate(autoContinue?.continueOnTruncate ?? true);
        setPrompt(autoContinue?.prompt ?? '继续');
        setLocalError('');
      }, [isOpen, autoContinue]);

      useEffect(() => {
        if (!isOpen) return undefined;
        const onKeyDown = (e) => {
          if (e.key === 'Escape' && !busy) {
            e.preventDefault();
            onClose();
          }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, [isOpen, busy, onClose]);

      if (!isOpen) return null;

      const updateRule = (idx, patch) => {
        setDraftRules((prev) => {
          const next = [...prev];
          next[idx] = { ...next[idx], ...patch };
          return next;
        });
      };

      const deleteRule = (idx) => {
        if (draftRules.length <= 1) {
          setLocalError('至少保留一条恢复规则');
          return;
        }
        setLocalError('');
        setDraftRules((prev) => prev.filter((_, i) => i !== idx));
      };

      const addRule = () => {
        setLocalError('');
        const newRule = normalizeRuleForDraft({
          id: `rule-${Date.now()}`,
          name: '自定义错误规则',
          enabled: true,
          statusCodes: [],
          keywords: [],
          action: 'wait_retry',
          delaySec: 30,
          maxRetries: 3,
          compactOnSecondAttempt: true,
        });
        setDraftRules((prev) => [...prev, newRule]);
      };

      const resetRules = () => {
        setLocalError('');
        setDraftRules([]);
      };

      const handleSave = async () => {
        const cleanedRules = [];
        for (let i = 0; i < draftRules.length; i++) {
          const r = draftRules[i];
          const name = (r.name || '').trim();
          if (!name) {
            setLocalError(`第 ${i + 1} 条规则名称不能为空`);
            return;
          }

          const delay = Number(r.delaySec);
          if (isNaN(delay) || delay < 0 || delay > 600) {
            setLocalError(`规则「${name}」等待秒数须在 0 ~ 600 秒之间`);
            return;
          }

          const retries = Number(r.maxRetries);
          if (isNaN(retries) || retries < 1 || retries > 30) {
            setLocalError(`规则「${name}」最大重试次数须在 1 ~ 30 次之间`);
            return;
          }

          const statusCodes = (r.statusCodesStr || '')
            .split(',')
            .map((s) => parseInt(s.trim(), 10))
            .filter((n) => !isNaN(n));

          const keywords = (r.keywordsStr || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);

          cleanedRules.push({
            id: r.id,
            name,
            enabled: Boolean(r.enabled),
            statusCodes,
            keywords,
            action: r.action,
            delaySec: delay,
            maxRetries: retries,
            compactOnSecondAttempt: Boolean(r.compactOnSecondAttempt),
          });
        }

        setLocalError('');
        const firstWait = cleanedRules.find((r) => r.action === 'wait_retry') || cleanedRules[0] || {};
        const payload = {
          rules: cleanedRules,
          retryDelaySec: typeof firstWait.delaySec === 'number' ? firstWait.delaySec : 60,
          maxRetries: typeof firstWait.maxRetries === 'number' ? firstWait.maxRetries : 5,
          compactOnDisconnect: Boolean(firstWait.compactOnSecondAttempt),
          continueOnTruncate: Boolean(continueOnTruncate),
          prompt: typeof prompt === 'string' && prompt.trim() ? prompt.trim() : '继续',
        };

        const ok = await onSave(payload);
        if (ok) {
          onClose();
        }
      };

      return h(
        'div',
        {
          className: 'dsh-au-modal-mask',
          onClick: (e) => { if (e.target === e.currentTarget && !busy) onClose(); },
        },
        h(
          'div',
          { className: 'dsh-au-cloud-sync-modal dsh-au-auto-continue-modal', role: 'dialog', 'aria-modal': 'true' },
          h(
            'div',
            { className: 'dsh-au-cloud-sync-modal-header' },
            h(
              'div',
              null,
              h('h3', null, '自动续跑与智能恢复配置'),
              h('p', null, '明确配置每个错误码与关键错误信息对应的恢复动作，支持随时新增自定义错误类型')
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-au-cloud-sync-modal-close',
                onClick: onClose,
                disabled: busy,
                title: '关闭弹窗',
              },
              '×'
            )
          ),
          h(
            'div',
            { className: 'dsh-au-auto-continue-modal-body' },
            // 主体规则卡片列表
            h(
              'div',
              { className: 'dsh-au-ac-rules-container' },
              draftRules.map((rule, idx) => {
                const parsedCodes = (rule.statusCodesStr || '')
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean);
                const codeBadgeText = parsedCodes.length > 0 ? `HTTP ${parsedCodes.join(', ')}` : '通用错误';
                const is4xx = parsedCodes.some((c) => c.startsWith('4'));

                let actionBadgeText = `等待 ${rule.delaySec || 0}s 后原地重试`;
                if (rule.action === 'compact_retry') {
                  actionBadgeText = '先压缩上下文后继续';
                } else if (rule.action === 'followup_prompt') {
                  actionBadgeText = `等待 ${rule.delaySec || 0}s 后发送提示词`;
                }

                return h(
                  'div',
                  { key: rule.id || idx, className: 'dsh-au-ac-rule-card' },
                  // 卡片头部
                  h(
                    'div',
                    { className: 'dsh-au-ac-rule-header' },
                    h(
                      'div',
                      { className: 'dsh-au-ac-rule-header-left' },
                      h('input', {
                        type: 'checkbox',
                        className: 'dsh-au-auto-continue-checkbox',
                        checked: Boolean(rule.enabled),
                        disabled: busy,
                        title: '启用/停用此规则',
                        onChange: (e) => updateRule(idx, { enabled: e.target.checked }),
                      }),
                      h('input', {
                        type: 'text',
                        className: 'dsh-au-ac-rule-name-input',
                        value: rule.name,
                        disabled: busy,
                        placeholder: '规则名称',
                        onChange: (e) => updateRule(idx, { name: e.target.value }),
                      })
                    ),
                    h(
                      'div',
                      { className: 'dsh-au-ac-rule-header-right' },
                      h('span', { className: `dsh-au-ac-rule-badge dsh-au-ac-badge-code${is4xx ? ' code-4xx' : ''}` }, codeBadgeText),
                      h('span', { className: 'dsh-au-ac-rule-badge dsh-au-ac-badge-action' }, actionBadgeText),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-au-auto-continue-btn danger',
                          disabled: busy || draftRules.length <= 1,
                          title: draftRules.length <= 1 ? '至少保留一条规则' : '删除此规则',
                          onClick: () => deleteRule(idx),
                        },
                        '删除'
                      )
                    )
                  ),
                  // 卡片字段网格
                  h(
                    'div',
                    { className: 'dsh-au-ac-rule-grid' },
                    // 1. 错误码（HTTP Status）
                    h(
                      'div',
                      { className: 'dsh-au-ac-rule-field' },
                      h('label', { className: 'dsh-au-ac-rule-field-label' }, '错误码 (HTTP Status)'),
                      h('input', {
                        type: 'text',
                        className: 'dsh-au-auto-continue-text-input',
                        value: rule.statusCodesStr,
                        disabled: busy,
                        placeholder: '例如: 503 或 413 (逗号分隔)',
                        onChange: (e) => updateRule(idx, { statusCodesStr: e.target.value }),
                      })
                    ),
                    // 2. 关键错误信息（匹配子串，逗号分隔）
                    h(
                      'div',
                      { className: 'dsh-au-ac-rule-field' },
                      h('label', { className: 'dsh-au-ac-rule-field-label' }, '关键错误信息 (匹配子串，逗号分隔)'),
                      h('input', {
                        type: 'text',
                        className: 'dsh-au-auto-continue-text-input',
                        value: rule.keywordsStr,
                        disabled: busy,
                        placeholder: '例如: auth_unavailable, no auth available',
                        onChange: (e) => updateRule(idx, { keywordsStr: e.target.value }),
                      })
                    ),
                    // 3. 处理方式
                    h(
                      'div',
                      { className: 'dsh-au-ac-rule-field full-width' },
                      h('label', { className: 'dsh-au-ac-rule-field-label' }, '处理方式'),
                      h(
                        'select',
                        {
                          className: 'dsh-au-ac-select',
                          value: rule.action,
                          disabled: busy,
                          onChange: (e) => {
                            const newAction = e.target.value;
                            const patch = { action: newAction };
                            if (newAction === 'compact_retry' && rule.delaySec === 60) {
                              patch.delaySec = 0;
                            }
                            updateRule(idx, patch);
                          },
                        },
                        h('option', { value: 'wait_retry' }, '等待设定秒数后原地继续（不发消息）'),
                        h('option', { value: 'compact_retry' }, '先压缩上下文后立即原地继续'),
                        h('option', { value: 'followup_prompt' }, '等待后自动发送续写提示词')
                      )
                    ),
                    // 4. 参数行
                    h(
                      'div',
                      { className: 'dsh-au-ac-rule-field full-width' },
                      h(
                        'div',
                        { className: 'dsh-au-ac-rule-params-row' },
                        h(
                          'span',
                          { className: 'dsh-au-auto-continue-input-wrap' },
                          h('span', { className: 'dsh-au-ac-rule-field-label' }, '等待秒数:'),
                          h('input', {
                            type: 'number',
                            min: 0,
                            max: 600,
                            className: 'dsh-au-auto-continue-number-input',
                            value: rule.delaySec,
                            disabled: busy,
                            onChange: (e) => updateRule(idx, { delaySec: e.target.value }),
                          }),
                          h('span', { className: 'dsh-au-auto-continue-unit' }, '秒')
                        ),
                        h(
                          'span',
                          { className: 'dsh-au-auto-continue-input-wrap' },
                          h('span', { className: 'dsh-au-ac-rule-field-label' }, '最大重试:'),
                          h('input', {
                            type: 'number',
                            min: 1,
                            max: 30,
                            className: 'dsh-au-auto-continue-number-input',
                            value: rule.maxRetries,
                            disabled: busy,
                            onChange: (e) => updateRule(idx, { maxRetries: e.target.value }),
                          }),
                          h('span', { className: 'dsh-au-auto-continue-unit' }, '次')
                        ),
                        rule.action === 'wait_retry'
                          ? h(
                              'label',
                              { className: 'dsh-au-auto-continue-checkbox-label' },
                              h('input', {
                                type: 'checkbox',
                                className: 'dsh-au-auto-continue-checkbox',
                                checked: Boolean(rule.compactOnSecondAttempt),
                                disabled: busy,
                                onChange: (e) => updateRule(idx, { compactOnSecondAttempt: e.target.checked }),
                              }),
                              '连续第 2 次断连时先压缩上下文'
                            )
                          : null
                      )
                    )
                  )
                );
              })
            ),
            // 规则列表下方工具栏
            h(
              'div',
              { className: 'dsh-au-ac-rule-toolbar' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-au-auto-continue-btn secondary',
                  disabled: busy,
                  onClick: addRule,
                },
                '+ 新增错误规则'
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-au-auto-continue-btn secondary',
                  disabled: busy,
                  onClick: resetRules,
                },
                '清空规则'
              )
            ),
            // 弹窗底部补充区（非报错类的字数截断续写）
            h(
              'div',
              { className: 'dsh-au-ac-truncate-card' },
              h(
                'label',
                { className: 'dsh-au-auto-continue-checkbox-label' },
                h('input', {
                  type: 'checkbox',
                  className: 'dsh-au-auto-continue-checkbox',
                  checked: Boolean(continueOnTruncate),
                  disabled: busy,
                  onChange: (e) => setContinueOnTruncate(e.target.checked),
                }),
                '输出字数截断 (max-tokens) 自动发送提示词续写'
              ),
              h(
                'span',
                { className: 'dsh-au-auto-continue-input-wrap' },
                h('span', { className: 'dsh-au-ac-rule-field-label' }, '续写提示词:'),
                h('input', {
                  type: 'text',
                  style: { width: '120px' },
                  className: 'dsh-au-auto-continue-text-input',
                  value: prompt,
                  disabled: busy || !continueOnTruncate,
                  placeholder: '继续',
                  onChange: (e) => setPrompt(e.target.value),
                })
              )
            )
          ),
          h(
            'div',
            { className: 'dsh-au-cloud-sync-modal-footer' },
            h(
              'div',
              { className: 'dsh-au-cloud-sync-modal-footer-left' },
              (localError || error)
                ? h('span', { style: { color: '#ef4444', fontSize: '12px' } }, localError || error)
                : null
            ),
            h(
              'div',
              { className: 'dsh-au-cloud-sync-modal-footer-right' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-au-auto-continue-btn secondary',
                  disabled: busy,
                  onClick: onClose,
                },
                '取消'
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-au-auto-continue-btn',
                  disabled: busy,
                  onClick: handleSave,
                },
                busy ? '正在保存...' : '保存配置'
              )
            )
          )
        )
      );
    }

    /** 自动续跑与智能恢复功能设置面板（主开关 + 参数摘要条 + 独立配置弹窗） */
    function AutoContinueFeatureGroup() {
      const features = useFeatures();
      const ac = features.autoContinue || {};
      const disabled = !features.loaded || features.busy;
      const [isModalOpen, setIsModalOpen] = useState(false);

      const rules = Array.isArray(ac.rules) ? ac.rules : [];
      const enabledRules = rules.filter((r) => r.enabled !== false);
      const summaryText = enabledRules.length > 0
        ? `已启用 ${enabledRules.length} 条错误规则`
        : '未启用任何错误规则';

      const hintMsg = features.autoContinueSaved
        ? '已保存，立即生效。'
        : '';

      return h(
        'section',
        { className: 'dsh-au-settings-group', 'aria-labelledby': 'dsh-au-feature-auto-continue-title' },
        h('h3', { id: 'dsh-au-feature-auto-continue-title' }, '自动续跑与智能恢复'),
        h(SettingsItem, {
          title: '启用智能恢复与自动续跑',
          description: '遇到 503 服务繁忙或远端断连时在后台安静等待后原地重试（不刷屏发消息）；连续断连可自动压缩瘦身，字数截断时自动接力续写。',
          hint: [ac.enabled ? summaryText : '', features.error || hintMsg],
          control: h(
            'button',
            {
              type: 'button',
              role: 'switch',
              className: 'dsh-au-switch',
              'aria-checked': Boolean(ac.enabled),
              'aria-labelledby': 'dsh-au-feature-auto-continue-title',
              disabled,
              onClick: () => { void saveAutoContinueFeature({ enabled: !ac.enabled }); },
            },
            h('span', { className: 'dsh-au-switch-knob', 'aria-hidden': 'true' })
          ),
          actions: ac.enabled
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-au-btn',
                  disabled,
                  onClick: () => setIsModalOpen(true),
                },
                '配置规则'
              )
            : null,
        }),
        // 独立弹窗
        h(AutoContinueModal, {
          isOpen: isModalOpen,
          onClose: () => setIsModalOpen(false),
          autoContinue: ac,
          busy: features.busy,
          error: features.error,
          onSave: (draft) => saveAutoContinueFeature(draft),
        })
      );
    }

    /** 服务端未返回前的兜底同步项（与服务端 OFFICIAL_SYNC_ITEMS 的 8 个固定项一致；对比细节以服务端为准）。 */
    const FALLBACK_CLOUD_SYNC_ITEMS = [
      { id: 'ui-theme', title: '外观：字号', patchIds: ['ui-theme'], comparisons: [] },
      { id: 'ui-chat', title: '聊天内容展示', patchIds: ['ui-chat'], comparisons: [] },
      { id: 'ui-settings-account', title: '账号设置界面', patchIds: ['ui-settings-account'], comparisons: [] },
      { id: 'session-log-deepseek', title: '会话日志上传设置', patchIds: ['session-log-deepseek'], comparisons: [] },
      { id: 'subagent-models', title: '子智能体：模型选择', patchIds: ['subagent-model-selection-settings'], comparisons: [] },
      { id: 'permission-preset', title: '权限：新会话的默认权限模式', patchIds: ['permission'], comparisons: [] },
      { id: 'llm-providers', title: '模型提供商、目录与默认模型', nonOfficial: true, patchIds: ['llm-pi-ai', 'dsh-acp-adapter', 'agent-default-model'], comparisons: [] },
      { id: 'desktop-preferences', title: '桌面设置：后台运行、浏览器与局域网、桌面通知', patchIds: [], isDesktopPreferences: true, comparisons: [] },
    ];

    /** 云插件与配置兜底列表（与服务端 buildCloudPluginSyncItems 一致） */
    const FALLBACK_CLOUD_SYNC_PLUGINS = [];
    /** 与服务端 FIXED_SYNC_PLUGIN_ID 一致：dsh-au 固定参与云同步，不提供勾选 */
    const FIXED_SYNC_PLUGIN_ID = 'dsh-au';

    /** 本机设置兜底列表（与服务端 PREFERENCE_SYNC_ITEMS 一致） */
    const FALLBACK_PREFERENCE_ITEMS = [
      {
        id: 'shortcuts',
        category: '本机设置',
        title: '设备 / 页面切换快捷键',
        defaultDiff: '按电脑各存一份：推送写本机备份，拉取只读本机备份',
      },
      {
        id: 'modelShortcuts',
        category: '本机设置',
        title: '模型快捷槽位',
        defaultDiff: '按电脑各存一份：推送写本机备份，拉取只读本机备份',
      },
    ];

    // 内部 ID 与私有仓库的 cordis.patch.<id>.yml 文件名保持不变，只换显示名。
    // generic 已不再提供；「工作」含本机 OneAPI 链路，仅 macOS 可选。
    const CLOUD_SYNC_PROFILE_OPTIONS = [
      { id: 'kiro', label: '通用' },
      ...(typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '')
        ? [{ id: 'local', label: '工作' }]
        : []),
    ];

    const PREFERENCE_JUMPS = {
      shortcuts: { anchor: 'shortcuts', label: '前往设置', title: '打开快捷键设置' },
      modelShortcuts: { anchor: 'modelShortcuts', label: '前往设置', title: '打开模型快捷设置' },
    };

    /** 配置弹窗挂到设置页上，避免被折叠的大类挡住，也能盖住同步弹窗。 */
    function portalSettingsModal(node) {
      const target = typeof document !== 'undefined' ? document.querySelector('.dsh-au-settings-page') : null;
      if (target && typeof ReactDOM.createPortal === 'function') return ReactDOM.createPortal(node, target);
      return node;
    }

    function resolveItemComparisons(item, profile) {
      if (item.id === 'llm-providers') {
        if (profile === 'generic') {
          return [
            { label: 'DSH 模型供应商列表 (llm-pi-ai)', defaultValue: '无自定义供应商', currentValue: '按 generic 方案从私人仓库同步供应商列表' },
            { label: 'Codex 模型目录', defaultValue: '不自动刷新', currentValue: '同步完整与精简目录，不切换当前模型' },
            { label: '原生 ACP 代理适配器', defaultValue: '未配置', currentValue: '不启用（纯网关模式）' },
            { label: '新对话默认模型', defaultValue: '官方默认模型', currentValue: '保持通用网关默认模型' },
          ];
        }
        if (profile === 'local') {
          return [
            { label: 'DSH 模型供应商列表 (llm-pi-ai)', defaultValue: '无自定义供应商', currentValue: '按 local 方案从私人仓库同步供应商列表' },
            { label: 'Codex 模型目录', defaultValue: '不自动刷新', currentValue: '同步完整与精简目录，不切换当前模型' },
            { label: '新对话默认模型 (agent-default-model)', defaultValue: '官方默认模型', currentValue: '按 local 方案同步默认模型与思考强度' },
          ];
        }
        return [
          { label: 'DSH 模型供应商列表 (llm-pi-ai)', defaultValue: '无自定义供应商', currentValue: '按所选方案从私人仓库同步供应商列表' },
          { label: 'Codex 模型目录', defaultValue: '不自动刷新', currentValue: '同步完整与精简目录，不切换当前模型' },
          { label: '原生 ACP 代理适配器', defaultValue: '未配置', currentValue: '按所选方案同步 ACP 适配器' },
          { label: '新对话默认模型 (agent-default-model)', defaultValue: '官方默认模型', currentValue: '按所选方案同步默认模型与思考强度' },
        ];
      }
      if (Array.isArray(item.comparisons) && item.comparisons.length > 0) return item.comparisons;
      const fallback = FALLBACK_CLOUD_SYNC_ITEMS.find(f => f.id === item.id)
        || FALLBACK_CLOUD_SYNC_PLUGINS.find(f => f.id === item.id);
      return fallback?.comparisons || [];
    }

    /** 官方设置「方案 H」：统一取出细项，旧服务端无 fields 时回退到静态对比表（local 为 null）。 */
    function resolveOfficialFields(item, profile) {
      if (Array.isArray(item.fields) && item.fields.length > 0) return item.fields;
      return resolveItemComparisons(item, profile).map(c => ({
        label: c.label,
        officialDefault: c.defaultValue ?? null,
        local: null,
        cloud: c.currentValue ?? null,
      }));
    }

    function officialFieldsHaveLocal(fields) {
      return fields.some(f => f.local !== null && f.local !== undefined);
    }

    /** 行右侧「与云 N 处不同」的 N：优先按细项 local 与 cloud 计数，缺数据时退回区块差异数。 */
    function countOfficialCloudDiff(item, fields) {
      if (officialFieldsHaveLocal(fields)) {
        // 本机独有、云端没有的键（localOnly）与服务端 inSync 判定一致，不算差异。
        const n = fields.filter(f => !f.localOnly && (f.local ?? null) !== (f.cloud ?? null)).length;
        if (n > 0) return n;
      }
      return (Array.isArray(item.diffDetails) ? item.diffDetails.length : 0) || 1;
    }

    function officialFieldText(value, emptyText = '未设置') {
      return value === null || value === undefined || value === ''
        ? h('span', { className: 'dsh-au-cloud-sync-row-cell-null' }, emptyText)
        : String(value);
    }

    /** 官方设置单行：勾选框、名称与 ID、状态，点击行展开四列对照（官方默认 / 本机 / 云端）。 */
    function renderOfficialRow({ item, checked, busy, expanded, profile, onToggleCheck, onToggleExpand, onChangeProfile }) {
      const fields = resolveOfficialFields(item, profile);
      const hasLocal = officialFieldsHaveLocal(fields);
      const inSync = item.inSync !== false;
      const profileLabel = (CLOUD_SYNC_PROFILE_OPTIONS.find(o => o.id === profile) || {}).label || profile;
      const idText = item.id === 'desktop-preferences'
        ? 'desktop-preferences.json'
        : ((Array.isArray(item.patchIds) && item.patchIds.length > 0 ? item.patchIds : [item.id]).join(' · '));
      const diffN = countOfficialCloudDiff(item, fields);

      const onRowKey = (e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggleExpand(item.id); }
      };

      // 方案 G：展开后四列对照（细项 / 官方默认 / 本机 / 云端）。
      // 只列出有官方默认值的细项；没有记录官方默认的细项一律不显示（用户要求，避免满屏「未记录」）。
      // 被隐藏的细项若与云端不同，在表格下方用一行提示，避免行上显示「与云 N 处不同」却在展开后找不到。
      // 只有本机与云端不同的单元格标琥珀色，本机改了官方默认的细项用左侧细条提示。
      const cloudTitle = `云端「${profileLabel}」`;
      const hasOfficialDefault = (f) => f.officialDefault !== null && f.officialDefault !== undefined && f.officialDefault !== '';
      // 模型项例外：只列出模型提供商（每个提供商一行，对应 DSH「模型」设置页），默认模型与 ACP 细项不列出。
      const isProviderField = (f) => typeof f.key === 'string' && f.key.startsWith('llm-pi-ai.providers.');
      const visibleFields = item.id === 'llm-providers'
        ? fields.filter(isProviderField)
        : fields.filter(hasOfficialDefault);
      const hiddenCloudDiffs = fields.filter(f => !visibleFields.includes(f) && hasLocal && !f.localOnly && (f.local ?? null) !== (f.cloud ?? null));
      let panelBody;
      if (visibleFields.length === 0) {
        panelBody = h('div', { className: 'dsh-au-cloud-sync-row-empty' }, '这一项没有记录官方默认值的细项。');
      } else if (!hasLocal) {
        panelBody = [
          h('div', { key: 'note', className: 'dsh-au-cloud-sync-row-empty' }, '服务端版本较旧，暂时只能显示概要；重启 DSH 后可查看逐项对比。'),
          h('div', { key: 'th', className: 'dsh-au-cloud-sync-row-th is-g' },
            h('span', null, '细项'), h('span', null, '官方默认'), h('span', null, '本机'), h('span', null, cloudTitle)),
          ...visibleFields.map((f, idx) => h('div', { key: idx, className: 'dsh-au-cloud-sync-row-tr is-g' },
            h('span', { className: `dsh-au-cloud-sync-row-cell-label${f.nonOfficial ? ' is-unofficial' : ''}` }, f.label),
            h('span', { className: 'dsh-au-cloud-sync-row-cell-ref' }, officialFieldText(f.officialDefault, '未记录')),
            h('span', { className: 'dsh-au-cloud-sync-row-cell-ref' }, officialFieldText(null)),
            h('span', { className: 'dsh-au-cloud-sync-row-cell-ref' }, officialFieldText(f.cloud)))),
        ];
      } else {
        panelBody = [
          h('div', { key: 'th', className: 'dsh-au-cloud-sync-row-th is-g' },
            h('span', null, '细项'), h('span', null, '官方默认'), h('span', null, '本机'), h('span', null, cloudTitle)),
          ...visibleFields.map((f, idx) => {
            const cloudDiff = !f.localOnly && (f.local ?? null) !== (f.cloud ?? null);
            const changedOfficial = f.officialDefault !== null && f.officialDefault !== undefined && (f.local ?? null) !== f.officialDefault;
            return h('div', { key: f.key || idx, className: `dsh-au-cloud-sync-row-tr is-g${cloudDiff ? ' is-cloud-diff' : ''}${changedOfficial ? ' is-changed' : ''}` },
              // 绿色 = 非官方名称：DSH 界面里找不到对应叫法，由 dsh-au 自行起名，悬停可看原始键名。
              h('span', { className: `dsh-au-cloud-sync-row-cell-label${f.nonOfficial ? ' is-unofficial' : ''}`, title: f.nonOfficial ? `非官方名称（${f.key || ''}）` : (f.key || undefined) }, f.label),
              h('span', { className: 'dsh-au-cloud-sync-row-cell-ref' }, officialFieldText(f.officialDefault, '未记录')),
              h('span', { className: `dsh-au-cloud-sync-row-cell-val${cloudDiff ? ' is-diff' : ''}` }, officialFieldText(f.local)),
              h('span', { className: `dsh-au-cloud-sync-row-cell-val${cloudDiff ? ' is-diff' : ''}` }, f.localOnly ? '（本机独有，不参与同步对比）' : officialFieldText(f.cloud)));
          }),
        ];
      }
      // 表格放进横向滚动容器：列宽按内容撑开不换行，窄窗口时左右滚动而不是挤压成多行。
      panelBody = h('div', { key: 'scroll', className: 'dsh-au-cloud-sync-row-scroll' },
        h('div', { className: 'dsh-au-cloud-sync-row-table' }, panelBody));
      if (hiddenCloudDiffs.length > 0) {
        panelBody = [].concat(panelBody, h('div', {
          key: 'hidden-diff',
          className: 'dsh-au-cloud-sync-row-note is-diff',
          title: hiddenCloudDiffs.map(f => f.key || f.label).join('\n'),
        }, `另有 ${hiddenCloudDiffs.length} 处没有官方默认值的细项与云端不同（未列出）：${hiddenCloudDiffs.slice(0, 3).map(f => f.label).join('、')}${hiddenCloudDiffs.length > 3 ? ' 等' : ''}`));
      }
      if (item.id === 'llm-providers') {
        panelBody = [].concat(panelBody, h('div', { key: 'codex', className: 'dsh-au-cloud-sync-row-note' },
          '勾选后还会同步 Codex CLI 的模型目录（完整与精简两份）。dsh-acp-adapter 让 DSH 通过 ACP 使用 Cursor Agent 等外部模型，和默认模型互相引用，所以一起同步。'));
      }

      return h(
        'div',
        { key: item.id, className: `dsh-au-cloud-sync-row-item${expanded ? ' is-open' : ''}` },
        h(
          'div',
          {
            className: 'dsh-au-cloud-sync-row',
            role: 'button',
            tabIndex: 0,
            'aria-expanded': expanded,
            onClick: () => onToggleExpand(item.id),
            onKeyDown: onRowKey,
          },
          h('input', {
            type: 'checkbox',
            checked,
            disabled: busy,
            'aria-label': `同步 ${item.title}`,
            onClick: (e) => e.stopPropagation(),
            onChange: () => onToggleCheck(item.id),
          }),
          h(
            'div',
            { className: 'dsh-au-cloud-sync-row-name' },
            h(
              'span',
              // 同步项标题同样用绿色表示非官方名称，替代原来的「非官方名称」小标签。
              { className: `dsh-au-cloud-sync-row-title${item.nonOfficial ? ' is-unofficial' : ''}`, title: item.nonOfficial ? '非官方名称：DSH 界面里没有对应叫法' : undefined },
              item.title,
              null
            ),
            h('span', { className: 'dsh-au-cloud-sync-row-id' }, idText),
            item.id === 'llm-providers'
              ? h('span', { className: 'dsh-au-cloud-sync-row-hint' }, item.groupNote || '与 Cursor ACP 适配器、默认模型一起同步')
              : null
          ),
          inSync
            ? h('span', { className: 'dsh-au-cloud-sync-row-status' }, '与云一致')
            : h('span', {
                className: 'dsh-au-cloud-sync-row-status is-diff',
                title: Array.isArray(item.diffDetails) && item.diffDetails.length > 0 ? `差异区块：${item.diffDetails.join('、')}` : undefined,
              }, `与云 ${diffN} 处不同`),
          h('span', { className: 'dsh-au-cloud-sync-row-chevron', 'aria-hidden': 'true' }, '▾')
        ),
        expanded
          ? h(
              'div',
              { className: 'dsh-au-cloud-sync-row-panel' },
              item.id === 'llm-providers'
                ? h(
                    'div',
                    { className: 'dsh-au-cloud-sync-row-profile' },
                    h('span', { className: 'dsh-au-cloud-sync-profile-label' }, '模型方案：'),
                    h(
                      'select',
                      {
                        className: 'dsh-au-cloud-sync-profile-select',
                        value: profile,
                        disabled: busy,
                        onChange: (e) => onChangeProfile(e.target.value),
                      },
                      CLOUD_SYNC_PROFILE_OPTIONS.map(opt => h('option', { key: opt.id, value: opt.id }, opt.label))
                    )
                  )
                : null,
              panelBody
            )
          : null
      );
    }

    /** 按键排序序列化，用于前端即时对比本机与云端 JSON 配置是否一致。 */
    function canonicalCloudSyncJson(value) {
      if (Array.isArray(value)) return `[${value.map(item => canonicalCloudSyncJson(item)).join(',')}]`;
      if (value && typeof value === 'object') {
        const keys = Object.keys(value).sort();
        return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalCloudSyncJson(value[key])}`).join(',')}}`;
      }
      return JSON.stringify(value);
    }

    /** 结合当前浏览器实时快捷键与模型槽位状态，重算「本机设置」的本地/云端一致状态。 */
    function resolvePreferenceSyncItems(preferenceItems, shortcutOverrides, modelShortcutSnapshot) {
      const baseList = Array.isArray(preferenceItems) && preferenceItems.length > 0
        ? preferenceItems
        : FALLBACK_PREFERENCE_ITEMS;
      return baseList.map((item) => {
        if (item.id === 'shortcuts' && item.cloudValue !== undefined && shortcutOverrides && typeof shortcutOverrides === 'object') {
          const hasBackup = item.cloudValue !== null;
          const inSync = hasBackup
            ? canonicalCloudSyncJson(shortcutOverrides) === canonicalCloudSyncJson(item.cloudValue)
            : Object.keys(shortcutOverrides).length === 0;
          return {
            ...item,
            inSync,
            diffLabel: inSync ? '✓ 与云一致' : (hasBackup ? '本地与云备份不一致' : '本机有修改 / 云端暂无备份'),
          };
        }
        if (item.id === 'modelShortcuts' && item.cloudValue !== undefined && modelShortcutSnapshot?.loaded) {
          const liveModelShortcuts = {
            enabled: Boolean(modelShortcutSnapshot.enabled),
            binding: modelShortcutSnapshot.binding ?? null,
            slots: Array.isArray(modelShortcutSnapshot.slots) ? modelShortcutSnapshot.slots : [],
          };
          const hasBackup = item.cloudValue !== null;
          const inSync = hasBackup
            ? canonicalCloudSyncJson(liveModelShortcuts) === canonicalCloudSyncJson(item.cloudValue)
            : false;
          return {
            ...item,
            inSync,
            diffLabel: inSync ? '✓ 与云一致' : (hasBackup ? '本地与云备份不一致' : '云端暂无本机备份'),
          };
        }
        return item;
      });
    }

    /** 云端同步独立弹窗：双 Tab（DSH 官方设置 | 云插件与配置）、勾选启用状态与配置、展开对比 */
    function CloudSyncModal({ isOpen, onClose, cloudSync, items, itemsByProfile, pluginItems, preferenceItems, machineId, onSave, onSaveAndSync, onPushToRepo, onSyncSinglePlugin, busy, message }) {
      const [activeTab, setActiveTab] = useState('official');
      const [profile, setProfile] = useState(cloudSync.profile || 'kiro');
      const [preferenceMap, setPreferenceMap] = useState(() => {
        const initial = {};
        for (const id of (cloudSync.selectedPreferences || FALLBACK_PREFERENCE_ITEMS.map(i => i.id))) initial[id] = true;
        return initial;
      });
      const [selectedMap, setSelectedMap] = useState(() => {
        const initial = {};
        for (const id of (cloudSync.selectedItems || [])) initial[id] = true;
        return initial;
      });
      const [selectedPluginsMap, setSelectedPluginsMap] = useState(() => {
        const initial = {};
        for (const id of (cloudSync.selectedPlugins || FALLBACK_CLOUD_SYNC_PLUGINS.map(p => p.id))) initial[id] = true;
        return initial;
      });
      const [syncConfigMap, setSyncConfigMap] = useState(() => {
        const initial = {};
        for (const id of (cloudSync.syncPluginConfigs || FALLBACK_CLOUD_SYNC_PLUGINS.map(p => p.id))) initial[id] = true;
        return initial;
      });
      const [expandedMap, setExpandedMap] = useState({});

      useEffect(() => {
        if (!isOpen) return;
        setProfile(cloudSync.profile || 'kiro');
        const nextItems = {};
        for (const id of (cloudSync.selectedItems || [])) nextItems[id] = true;
        setSelectedMap(nextItems);
        const nextPlugins = {};
        for (const id of (cloudSync.selectedPlugins || FALLBACK_CLOUD_SYNC_PLUGINS.map(p => p.id))) nextPlugins[id] = true;
        setSelectedPluginsMap(nextPlugins);
        const nextConfigs = {};
        for (const id of (cloudSync.syncPluginConfigs || FALLBACK_CLOUD_SYNC_PLUGINS.map(p => p.id))) nextConfigs[id] = true;
        setSyncConfigMap(nextConfigs);
        const nextPreferences = {};
        for (const id of (cloudSync.selectedPreferences || FALLBACK_PREFERENCE_ITEMS.map(i => i.id))) nextPreferences[id] = true;
        setPreferenceMap(nextPreferences);
      }, [isOpen, cloudSync.profile, cloudSync.selectedItems, cloudSync.selectedPlugins, cloudSync.syncPluginConfigs, cloudSync.selectedPreferences]);

      useEffect(() => {
        if (!isOpen) return;
        setExpandedMap({});
      }, [isOpen]);

      useEffect(() => {
        if (!isOpen) return undefined;
        const onKeyDown = (e) => {
          if (e.key === 'Escape' && !busy) {
            if (typeof document !== 'undefined' && document.querySelector('.dsh-au-modal-mask-above')) return;
            e.preventDefault();
            onClose();
          }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, [isOpen, busy, onClose]);

      if (!isOpen) return null;

      const profileItems = itemsByProfile && Array.isArray(itemsByProfile[profile]) && itemsByProfile[profile].length > 0
        ? itemsByProfile[profile]
        : null;
      const allList = profileItems || (items && items.length > 0 ? items : FALLBACK_CLOUD_SYNC_ITEMS);
      const allPluginList = Array.isArray(pluginItems) ? pluginItems : FALLBACK_CLOUD_SYNC_PLUGINS;
      // dsh-au 固定参与同步，单独放在「dsh-au 设置」页签；「其它云插件」页签不再列出它。
      const dshAuPluginItem = allPluginList.find(item => item.id === FIXED_SYNC_PLUGIN_ID) || null;
      const otherPluginList = allPluginList.filter(item => item.id !== FIXED_SYNC_PLUGIN_ID);
      const isPluginTab = activeTab === 'plugins';
      const isDshAuTab = activeTab === 'dshau';
      const activeList = isPluginTab ? otherPluginList : [];
      const fixedOfficialList = allList.filter(item => !item.dynamic);
      const dynamicOfficialList = allList.filter(item => item.dynamic);

      const handleToggle = (id) => {
        if (isPluginTab) {
          setSelectedPluginsMap(prev => ({ ...prev, [id]: !prev[id] }));
        } else {
          setSelectedMap(prev => ({ ...prev, [id]: !prev[id] }));
        }
      };

      const handleTogglePluginConfig = (id) => {
        setSyncConfigMap(prev => ({ ...prev, [id]: !prev[id] }));
      };

      const handleToggleExpand = (id) => {
        setExpandedMap(prev => ({ ...prev, [id]: !prev[id] }));
      };


      const handleSelectAll = () => {
        if (isPluginTab) {
          const next = {};
          for (const item of otherPluginList) next[item.id] = true;
          setSelectedPluginsMap(next);
        } else {
          const next = {};
          for (const item of allList) next[item.id] = true;
          setSelectedMap(next);
        }
      };

      const handleDeselectAll = () => {
        if (isPluginTab) {
          setSelectedPluginsMap({});
        } else {
          setSelectedMap({});
        }
      };

      const currentSelectedItems = allList.filter(item => selectedMap[item.id]).map(item => item.id);
      const currentSelectedPlugins = allPluginList
        .filter(item => item.id === FIXED_SYNC_PLUGIN_ID || selectedPluginsMap[item.id])
        .map(item => item.id);
      const preferenceList = preferenceItems && preferenceItems.length > 0 ? preferenceItems : FALLBACK_PREFERENCE_ITEMS;
      const currentSelectedPreferences = preferenceList.filter(item => preferenceMap[item.id]).map(item => item.id);
      const prefDiffItems = preferenceList.filter(item => item.inSync === false);
      const officialDiffItems = allList.filter(item => item.inSync === false);
      const pluginDiffItems = allPluginList.filter(item => item.inSync === false);
      const officialTabDiffCount = officialDiffItems.length;
      const dshAuTabDiffCount = prefDiffItems.length + (dshAuPluginItem && dshAuPluginItem.inSync === false ? 1 : 0);
      const pluginTabDiffCount = otherPluginList.filter(item => item.inSync === false).length;
      const totalDiffItems = [...prefDiffItems, ...officialDiffItems, ...pluginDiffItems];
      const totalDiffCount = totalDiffItems.length;
      const diffTitleSummary = totalDiffItems.slice(0, 3).map(item => item.title).join('、')
        + (totalDiffCount > 3 ? ` 等 ${totalDiffCount} 项` : '');
      const togglePreference = (id) => setPreferenceMap(prev => ({ ...prev, [id]: !prev[id] }));
      const renderRowFor = (item) => renderOfficialRow({
        item,
        checked: Boolean(selectedMap[item.id]),
        busy,
        expanded: Boolean(expandedMap[item.id]),
        profile,
        onToggleCheck: handleToggle,
        onToggleExpand: handleToggleExpand,
        onChangeProfile: setProfile,
      });
      const buildPayload = () => ({
        profile,
        selectedItems: currentSelectedItems,
        selectedPlugins: currentSelectedPlugins,
        syncPluginConfigs: currentSelectedPlugins,
        selectedPreferences: currentSelectedPreferences,
      });

      return h(
        'div',
        {
          className: 'dsh-au-modal-mask',
          onClick: (e) => { if (e.target === e.currentTarget && !busy) onClose(); },
        },
        h(
          'div',
          { className: 'dsh-au-cloud-sync-modal', role: 'dialog', 'aria-modal': 'true' },
          h(
            'div',
            { className: 'dsh-au-cloud-sync-modal-header' },
            h(
              'div',
              null,
              h('h3', null, '自定义云端同步设置项'),
              h('p', null, isPluginTab
                ? '勾选需要实时同步的云插件（勾选后自动同步该插件的安装、启用状态与插件配置）。'
                : isDshAuTab
                  ? 'dsh-au 自身配置固定参与云同步，无需勾选：上半部分所有电脑共用一份，下半部分每台电脑各存一份。'
                  : `当前设备：${machineId || '未识别'} · 勾选需要同步的官方设置，点击任意一行可展开查看本机与云端、官方默认的差异。`)
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-au-cloud-sync-modal-close',
                onClick: onClose,
                disabled: busy,
                title: '关闭弹窗',
              },
              '×'
            )
          ),
          h(
            'div',
            { className: 'dsh-au-cloud-sync-toolbar' },
            h(
              'div',
              { className: 'dsh-au-cloud-sync-tabs', role: 'tablist' },
              h(
                'button',
                {
                  type: 'button',
                  role: 'tab',
                  'aria-selected': !isPluginTab,
                  className: `dsh-au-cloud-sync-tab${!isPluginTab ? ' is-active' : ''}`,
                  onClick: () => setActiveTab('official'),
                },
                `DSH 官方设置 (${currentSelectedItems.length}/${allList.length})`,
                officialTabDiffCount > 0
                  ? h('span', { className: 'dsh-au-cloud-sync-tab-badge' }, `${officialTabDiffCount} 项不一致`)
                  : null
              ),
              h(
                'button',
                {
                  type: 'button',
                  role: 'tab',
                  'aria-selected': isDshAuTab,
                  className: `dsh-au-cloud-sync-tab${isDshAuTab ? ' is-active' : ''}`,
                  onClick: () => setActiveTab('dshau'),
                },
                'dsh-au 设置',
                dshAuTabDiffCount > 0
                  ? h('span', { className: 'dsh-au-cloud-sync-tab-badge' }, `${dshAuTabDiffCount} 项不一致`)
                  : null
              ),
              h(
                'button',
                {
                  type: 'button',
                  role: 'tab',
                  'aria-selected': isPluginTab,
                  className: `dsh-au-cloud-sync-tab${isPluginTab ? ' is-active' : ''}`,
                  onClick: () => setActiveTab('plugins'),
                },
                `其它云插件 (${otherPluginList.filter(item => selectedPluginsMap[item.id]).length}/${otherPluginList.length})`,
                pluginTabDiffCount > 0
                  ? h('span', { className: 'dsh-au-cloud-sync-tab-badge' }, `${pluginTabDiffCount} 项不一致`)
                  : null
              )
            ),
            h(
              'div',
              { className: 'dsh-au-cloud-sync-bulk-actions' },
              isDshAuTab ? null : h('button', { type: 'button', className: 'dsh-au-btn', disabled: busy, onClick: handleSelectAll }, '全选'),
              isDshAuTab ? null : h('button', { type: 'button', className: 'dsh-au-btn', disabled: busy, onClick: handleDeselectAll }, '全不选')
            )
          ),
          totalDiffCount > 0
            ? h(
                'div',
                { className: 'dsh-au-cloud-sync-diff-banner', role: 'status' },
                `⚠ 检测到本地与云端有 ${totalDiffCount} 项不一致（${diffTitleSummary}）。若要上传当前修改，请点左下角「本地推送到云」；若要还原云端配置，请点「保存并云同步到本地」。`
              )
            : null,
          h(
            'div',
            { className: 'dsh-au-cloud-sync-list' },
            isDshAuTab
              ? h(
                  'div',
                  { className: 'dsh-au-cloud-sync-pref-section' },
                  h('p', { className: 'dsh-au-cloud-sync-pref-title' }, '所有电脑共用（固定同步）'),
                  h(
                    'div',
                    { className: `dsh-au-cloud-sync-item is-checked${dshAuPluginItem && dshAuPluginItem.inSync === false ? ' is-diff' : ''}` },
                    h(
                      'div',
                      { className: 'dsh-au-cloud-sync-item-main', style: { alignItems: 'center' } },
                      h(
                        'div',
                        { className: 'dsh-au-cloud-sync-item-body' },
                        h(
                          'div',
                          { className: 'dsh-au-cloud-sync-item-head' },
                          h('span', { className: 'dsh-au-cloud-sync-item-cat' }, '自研插件'),
                          h('span', { className: 'dsh-au-cloud-sync-item-title' }, 'dsh-au 版本与开关'),
                          dshAuPluginItem
                            ? h(
                                'span',
                                { className: `dsh-au-cloud-sync-diff-badge ${dshAuPluginItem.inSync === false ? 'is-diff' : 'is-sync'}` },
                                dshAuPluginItem.diffLabel || (dshAuPluginItem.inSync === false ? '有差异' : '✓ 与云一致')
                              )
                            : h('span', { className: 'dsh-au-cloud-sync-diff-badge is-diff' }, '云清单暂无 dsh-au')
                        ),
                        h(
                          'span',
                          { className: 'dsh-au-cloud-sync-item-diff' },
                          '版本 · 启用状态 · 启动时还原窗口 · 新开对话默认完全权限 · 禁止 AI 新建目标 · 智能恢复与自动续跑'
                        )
                      )
                    )
                  ),
                  h('p', { className: 'dsh-au-cloud-sync-pref-title' }, '每台电脑各存一份（互不覆盖）'),
                  preferenceList.map(item => {
                    const jump = PREFERENCE_JUMPS[item.id];
                    const prefInSync = item.inSync !== false;
                    const prefDiffLabel = item.diffLabel || (prefInSync ? '✓ 与云一致' : '本地与云不一致');
                    return h(
                    'div',
                    {
                      key: item.id,
                      className: `dsh-au-cloud-sync-item${preferenceMap[item.id] ? ' is-checked' : ''}${!prefInSync ? ' is-diff' : ''}`,
                    },
                    h(
                      'div',
                      {
                        className: 'dsh-au-cloud-sync-item-main',
                        style: { alignItems: 'center' },
                        onClick: () => { if (!busy) togglePreference(item.id); },
                      },
                      h('input', {
                        type: 'checkbox',
                        checked: Boolean(preferenceMap[item.id]),
                        disabled: busy,
                        style: { marginTop: 0 },
                        onClick: (e) => e.stopPropagation(),
                        onChange: () => togglePreference(item.id),
                      }),
                      h(
                        'div',
                        { className: 'dsh-au-cloud-sync-item-body' },
                        h(
                          'div',
                          { className: 'dsh-au-cloud-sync-item-head' },
                          h('span', { className: 'dsh-au-cloud-sync-item-cat' }, item.category || '本机设置'),
                          h('span', { className: 'dsh-au-cloud-sync-item-title' }, item.title),
                          item.inSync !== undefined
                            ? h(
                                'span',
                                {
                                  className: `dsh-au-cloud-sync-diff-badge ${prefInSync ? 'is-sync' : 'is-diff'}`,
                                },
                                prefDiffLabel
                              )
                            : null,
                          jump ? null : h('span', { className: 'dsh-au-cloud-sync-item-diff' }, item.defaultDiff)
                        )
                      ),
                      jump ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-au-btn dsh-au-cloud-sync-pref-jump',
                          title: jump.title,
                          'aria-label': jump.title,
                          onClick: (event) => {
                            event.stopPropagation();
                            event.preventDefault();
                            window.dispatchEvent(new CustomEvent('dsh-au-open-settings-modal', {
                              detail: { anchor: jump.anchor },
                            }));
                          },
                        },
                        jump.label
                      ) : null
                    )
                  );
                  })
                )
              : null,
            activeTab === 'official'
              ? h(
                  React.Fragment,
                  null,
                  // 图例：绿色名称不是 DSH 官方叫法，避免用户误以为能在 DSH 设置页搜到。
                  h('p', { className: 'dsh-au-cloud-sync-row-legend' },
                    h('span', { className: 'is-unofficial' }, '绿色名称'),
                    '为非官方名称：DSH 界面里没有对应叫法，悬停可查看原始配置键。'),
                  h(
                    'div',
                    { className: 'dsh-au-cloud-sync-rowlist' },
                    fixedOfficialList.map(renderRowFor)
                  ),
                  dynamicOfficialList.length > 0
                    ? [
                        h('div', { key: 'divider', className: 'dsh-au-cloud-sync-row-divider' }, '未分类的官方设置（新发现，默认不同步）'),
                        h('div', { key: 'dynamic', className: 'dsh-au-cloud-sync-rowlist' }, dynamicOfficialList.map(renderRowFor)),
                      ]
                    : null
                )
              : null,
            activeList.map(item => {
              const checked = isPluginTab ? Boolean(selectedPluginsMap[item.id]) : Boolean(selectedMap[item.id]);
              if (isPluginTab) {
                const inSync = item.inSync !== false;
                const diffLabel = item.diffLabel || (inSync ? '✓ 与云一致' : '有差异');
                return h(
                  'div',
                  {
                    key: item.id,
                    className: `dsh-au-cloud-sync-item${checked ? ' is-checked' : ''}`,
                  },
                  h(
                    'div',
                    {
                      className: 'dsh-au-cloud-sync-item-main',
                      style: { alignItems: 'center' },
                      onClick: () => { if (!busy) handleToggle(item.id); },
                    },
                    h('input', {
                      type: 'checkbox',
                      checked,
                      disabled: busy,
                      style: { marginTop: 0 },
                      onClick: (e) => e.stopPropagation(),
                      onChange: () => handleToggle(item.id),
                    }),
                    h(
                      'div',
                      { className: 'dsh-au-cloud-sync-item-body' },
                      h(
                        'div',
                        { className: 'dsh-au-cloud-sync-item-head' },
                        h('span', { className: 'dsh-au-cloud-sync-item-cat' }, item.category || '云插件'),
                        h('span', { className: 'dsh-au-cloud-sync-item-title' }, item.title),
                        h(
                          'span',
                          {
                            className: `dsh-au-cloud-sync-diff-badge ${inSync ? 'is-sync' : 'is-diff'}`,
                          },
                          diffLabel
                        ),
                        h(
                          'span',
                          { className: 'dsh-au-cloud-sync-row-actions', onClick: (e) => e.stopPropagation() },
                          !inSync && typeof onSyncSinglePlugin === 'function'
                            ? [
                                h(
                                  'button',
                                  {
                                    key: 'pull',
                                    type: 'button',
                                    className: 'dsh-au-cloud-sync-mini-btn',
                                    disabled: busy,
                                    title: '仅用云端快照覆盖该插件的本机配置与启用状态（云 → 本地）',
                                    onClick: () => onSyncSinglePlugin({ profile, pluginId: item.id, direction: 'pull' }),
                                  },
                                  '云→本地'
                                ),
                                h(
                                  'button',
                                  {
                                    key: 'push',
                                    type: 'button',
                                    className: 'dsh-au-cloud-sync-mini-btn',
                                    disabled: busy,
                                    title: '仅用本机该插件的版本、启用状态与配置覆盖云端快照（本地 → 云）',
                                    onClick: () => onSyncSinglePlugin({ profile, pluginId: item.id, direction: 'push' }),
                                  },
                                  '本地→云'
                                ),
                              ]
                            : null,
                          h(
                            'span',
                            {
                              className: `dsh-au-cloud-sync-plugin-state ${checked ? 'is-enabled' : 'is-disabled'}`,
                            },
                            checked ? '实时同步已开启' : '未开启同步'
                          )
                        )
                      )
                    )
                  )
                );
              }
              return null;
            })
          ),
          message
            ? h(
                'div',
                {
                  className: `dsh-au-cloud-sync-modal-status ${/失败|异常|错误/.test(message) ? 'is-error' : 'is-success'}`,
                  role: 'status',
                },
                message
              )
            : null,
          h(
            'div',
            { className: 'dsh-au-cloud-sync-modal-footer' },
            h(
              'div',
              { className: 'dsh-au-cloud-sync-modal-footer-left' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-au-btn',
                  disabled: busy,
                  title: '把本机当前已勾选的官方设置及插件启用状态/配置写回云端仓库快照（本机 → 云）',
                  onClick: () => onPushToRepo(buildPayload()),
                },
                busy ? '正在推送...' : '本地推送到云'
              )
            ),
            h(
              'div',
              { className: 'dsh-au-cloud-sync-modal-footer-right' },
              h('button', { type: 'button', className: 'dsh-au-btn', disabled: busy, onClick: onClose }, '取消'),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-au-btn',
                  disabled: busy,
                  onClick: () => onSave(buildPayload()),
                },
                '仅保存勾选'
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-au-btn dsh-au-btn-primary',
                  disabled: busy,
                  title: '保存当前勾选，并立即把云端仓库的设置与插件启用状态/配置同步到这台电脑（云 → 本机）',
                  onClick: () => onSaveAndSync(buildPayload()),
                },
                busy ? '正在同步...' : '保存并云同步到本地'
              )
            )
          )
        )
      );
    }

    /** 云端配置自动同步区块 */
    function CloudSyncFeatureGroup() {
      const [cloudSync, setCloudSync] = useState({
        enabled: false,
        profile: 'kiro',
        selectedItems: FALLBACK_CLOUD_SYNC_ITEMS.map(i => i.id),
        customized: false,
        selectedPlugins: FALLBACK_CLOUD_SYNC_PLUGINS.map(p => p.id),
        syncPluginConfigs: FALLBACK_CLOUD_SYNC_PLUGINS.map(p => p.id),
        pluginsCustomized: false,
        selectedPreferences: FALLBACK_PREFERENCE_ITEMS.map(i => i.id),
        lastSyncedHash: '',
        lastSyncedAt: '',
        inSync: true,
        restartRequired: false,
      });
      const [items, setItems] = useState(FALLBACK_CLOUD_SYNC_ITEMS);
      const [itemsByProfile, setItemsByProfile] = useState(null);
      const [pluginItems, setPluginItems] = useState(FALLBACK_CLOUD_SYNC_PLUGINS);
      const [preferenceItems, setPreferenceItems] = useState(FALLBACK_PREFERENCE_ITEMS);
      const [machineId, setMachineId] = useState('');
      const [syncRepoRoot, setSyncRepoRoot] = useState('');
      const savedSyncRepoRootRef = useRef('');
      const [repoPathRestart, setRepoPathRestart] = useState(false);
      const [loaded, setLoaded] = useState(false);
      const [busy, setBusy] = useState(false);
      const [message, setMessage] = useState('');
      const [modalOpen, setModalOpen] = useState(false);
      // 新电脑首次接入私有仓库时的确认框；本次会话里用户点了「暂不」就不再自动弹出。
      const [firstSyncConfirmOpen, setFirstSyncConfirmOpen] = useState(false);
      const firstSyncDismissedRef = useRef(false);
      const shortcutOverrides = useShortcutOverrides();
      const modelShortcutSnapshot = useModelShortcuts();

      const applyCloudSyncResponse = (res) => {
        if (!res?.ok) return;
        if (res.cloudSync) setCloudSync(prev => ({ ...prev, ...res.cloudSync, firstSyncPending: Boolean(res.cloudSync.firstSyncPending) }));
        // 首次接入：有私有仓库、从没同步过、总开关已开 → 先确认，再立即拉取，不用等重启。
        if (res.cloudSync?.firstSyncPending && res.cloudSync.enabled && !firstSyncDismissedRef.current) {
          setFirstSyncConfirmOpen(true);
        }
        if (Array.isArray(res.items) && res.items.length > 0) setItems(res.items);
        if (res.itemsByProfile && typeof res.itemsByProfile === 'object') setItemsByProfile(res.itemsByProfile);
        if (Array.isArray(res.pluginItems)) setPluginItems(res.pluginItems);
        if (Array.isArray(res.preferenceItems) && res.preferenceItems.length > 0) setPreferenceItems(res.preferenceItems);
        if (typeof res.machineId === 'string') setMachineId(res.machineId);
        if (typeof res.syncRepoRoot === 'string') {
          setSyncRepoRoot(res.syncRepoRoot);
          savedSyncRepoRootRef.current = res.syncRepoRoot.trim();
        }
      };

      const refreshSettings = async () => {
        try {
          const res = await callApi('getCloudSyncSettings');
          if (res?.ok) {
            applyCloudSyncResponse(res);
            setLoaded(true);
          }
        } catch {
          // 兜底保持默认
          setLoaded(true);
        }
      };

      useEffect(() => {
        void refreshSettings();
      }, []);

      const handleToggle = async () => {
        const nextEnabled = !cloudSync.enabled;
        setBusy(true);
        setMessage('');
        try {
          const res = await callApi('saveCloudSyncSettings', {
            enabled: nextEnabled,
            profile: cloudSync.profile,
            selectedItems: cloudSync.selectedItems,
            selectedPlugins: cloudSync.selectedPlugins,
            syncPluginConfigs: cloudSync.syncPluginConfigs,
            selectedPreferences: cloudSync.selectedPreferences,
          });
          if (res?.ok && res.cloudSync) {
            applyCloudSyncResponse(res);
            setMessage(nextEnabled ? '已开启云端配置自动同步' : '已关闭云端配置自动同步');
          } else {
            setCloudSync(prev => ({ ...prev, enabled: nextEnabled }));
          }
        } catch {
          setMessage('保存开关状态失败');
        } finally {
          setBusy(false);
        }
      };

      const handleRunSync = async (targetPayload) => {
        setBusy(true);
        setMessage('');
        try {
          const payload = targetPayload || {
            profile: cloudSync.profile,
            selectedItems: cloudSync.selectedItems,
            selectedPlugins: cloudSync.selectedPlugins,
            syncPluginConfigs: cloudSync.syncPluginConfigs,
            selectedPreferences: cloudSync.selectedPreferences,
          };
          const res = await callApi('runCloudSyncNow', payload);
          if (res?.ok) {
            applyCloudSyncResponse(res);
            if (res.restartRequired !== undefined) {
              setCloudSync(prev => ({ ...prev, restartRequired: Boolean(res.restartRequired) }));
            }
            void loadFeatures();
            if (typeof loadModelShortcuts === 'function') void loadModelShortcuts();
            setMessage(res.message || '立即同步成功');
          } else {
            setMessage(res?.error || '同步失败，请检查脚本输出');
          }
        } catch {
          setMessage('同步请求异常');
        } finally {
          setBusy(false);
        }
      };

      const handleSaveModal = async ({ profile, selectedItems, selectedPlugins, syncPluginConfigs, selectedPreferences }) => {
        setBusy(true);
        setMessage('');
        try {
          const res = await callApi('saveCloudSyncSettings', {
            enabled: cloudSync.enabled,
            profile,
            selectedItems,
            selectedPlugins,
            syncPluginConfigs,
            selectedPreferences,
          });
          if (res?.ok && res.cloudSync) {
            applyCloudSyncResponse(res);
            setMessage('同步配置已更新');
            setModalOpen(false);
          } else {
            setCloudSync(prev => ({ ...prev, profile, selectedItems, selectedPlugins, syncPluginConfigs, selectedPreferences }));
            setModalOpen(false);
          }
        } catch {
          setMessage('保存失败');
        } finally {
          setBusy(false);
        }
      };

      const handleSaveAndSyncModal = async ({ profile, selectedItems, selectedPlugins, syncPluginConfigs, selectedPreferences }) => {
        setBusy(true);
        setMessage('');
        try {
          const res = await callApi('saveCloudSyncSettings', {
            enabled: cloudSync.enabled,
            profile,
            selectedItems,
            selectedPlugins,
            syncPluginConfigs,
            selectedPreferences,
          });
          if (res?.ok && res.cloudSync) {
            applyCloudSyncResponse(res);
          }
          await handleRunSync({ profile, selectedItems, selectedPlugins, syncPluginConfigs, selectedPreferences });
          setModalOpen(false);
        } catch {
          setMessage('保存并同步异常');
        } finally {
          setBusy(false);
        }
      };

      const handlePushToRepo = async ({ profile, selectedItems, selectedPlugins, syncPluginConfigs, selectedPreferences }) => {
        setBusy(true);
        setMessage('');
        try {
          const clientPreferences = {
            mobileEnabled: readMobileFeatureEnabled(),
            shortcutOverrides: readShortcutOverrides(),
          };
          const res = await callApi('pushCloudSyncToRepo', {
            profile,
            selectedItems,
            selectedPlugins,
            syncPluginConfigs,
            selectedPreferences,
            clientPreferences,
          });
          if (res?.ok) {
            applyCloudSyncResponse(res);
            setMessage(res.message || '已成功将当前设置推送到仓库');
          } else {
            setMessage(res?.error || '推送到仓库失败');
          }
        } catch {
          setMessage('推送请求异常');
        } finally {
          setBusy(false);
        }
      };

      const handleSyncSinglePlugin = async ({ profile, pluginId, direction }) => {
        setBusy(true);
        setMessage('');
        try {
          const clientPreferences = {
            mobileEnabled: readMobileFeatureEnabled(),
            shortcutOverrides: readShortcutOverrides(),
          };
          const res = await callApi(direction === 'push' ? 'pushCloudSyncToRepo' : 'runCloudSyncNow', {
            profile,
            singlePluginOnly: true,
            pluginId,
            clientPreferences,
          });
          if (res?.ok) {
            applyCloudSyncResponse(res);
            if (direction === 'pull') void loadFeatures();
            setMessage(direction === 'push' ? `已将 ${pluginId} 本地状态推送到云` : `已将 ${pluginId} 从云同步到本地`);
          } else {
            setMessage(res?.error || '单插件同步失败');
          }
        } catch {
          setMessage('单插件同步异常');
        } finally {
          setBusy(false);
        }
      };

      const handleRestartDsh = async () => {
        try {
          await callApi('restartDsh');
        } catch {}
      };

      const titleId = 'dsh-au-feature-cloud-sync-title';
      const allItems = (itemsByProfile && Array.isArray(itemsByProfile[cloudSync.profile]) && itemsByProfile[cloudSync.profile].length > 0)
        ? itemsByProfile[cloudSync.profile]
        : (items && items.length > 0 ? items : FALLBACK_CLOUD_SYNC_ITEMS);
      const allPluginItems = Array.isArray(pluginItems) ? pluginItems : FALLBACK_CLOUD_SYNC_PLUGINS;
      const resolvedPreferenceItems = resolvePreferenceSyncItems(preferenceItems, shortcutOverrides, modelShortcutSnapshot);
      // 首次拉取确认框里展示的覆盖项数：只算会被本次拉取写入的不一致项。
      const firstSyncDiffCount = allItems.filter(item => item.inSync === false && (cloudSync.selectedItems || []).includes(item.id)).length
        + allPluginItems.filter(item => item.inSync === false && (cloudSync.selectedPlugins || []).includes(item.id)).length
        + resolvedPreferenceItems.filter(item => item.inSync === false && (cloudSync.selectedPreferences || []).includes(item.id)).length;
      const selectedCount = (cloudSync.selectedItems || []).length;
      const selectedPluginCount = (cloudSync.selectedPlugins || []).length;
      const selectedPreferenceCount = (cloudSync.selectedPreferences || []).length;
      const totalDiffCount = loaded
        ? allItems.filter(i => i.inSync === false).length
          + allPluginItems.filter(p => p.inSync === false).length
          + resolvedPreferenceItems.filter(p => p.inSync === false).length
        : 0;
      const selectionHint = `设置 ${selectedCount}/${allItems.length} · 插件 ${selectedPluginCount}/${allPluginItems.length} · 本机 ${selectedPreferenceCount}/${resolvedPreferenceItems.length}`;

      return h(
        'section',
        { className: 'dsh-au-settings-group', 'aria-labelledby': titleId },
        h('h3', { id: titleId }, '云端配置自动同步'),
        h(SettingsItem, {
          title: '开启云端配置自动同步',
          description: [
            '拉取配置仓库或启动 DSH 时，自动复用 #71 还原脚本。',
            h('br'),
            '将已勾选的官方设置、Codex 模型目录及云插件同步到本机。',
          ],
          hint: selectionHint,
          control: h(
            'button',
            {
              type: 'button',
              role: 'switch',
              className: 'dsh-au-switch',
              'aria-checked': cloudSync.enabled,
              'aria-labelledby': titleId,
              disabled: busy,
              onClick: () => void handleToggle(),
            },
            h('span', { className: 'dsh-au-switch-knob', 'aria-hidden': 'true' })
          ),
          actions: h(
            'button',
            {
              type: 'button',
              className: 'dsh-au-btn',
              onClick: () => {
                setMessage('');
                setModalOpen(true);
                void refreshSettings();
              },
            },
            '选择同步项',
            cloudSync.conflict
              ? h('span', { className: 'dsh-au-cloud-sync-outer-diff' }, '双端冲突')
              : totalDiffCount > 0
                ? h('span', { className: 'dsh-au-cloud-sync-outer-diff' }, `${totalDiffCount} 项待同步`)
                : null
          ),
        }),
        cloudSync.conflict
          ? h('div', { className: 'dsh-au-settings-note is-warn', role: 'alert' }, cloudSync.conflictReason || '检测到本机与云端均有未同步改动，已暂停自动覆盖，请点「选择同步项」手动推送或拉取。')
          : null,
        h(SettingsItem, {
          title: '私人同步仓库路径',
          description: '指向包含 dsh-sync 或 dsh-au/sync 的本地仓库；留空则只用插件自带的示例 sync/。',
          extra: h('input', {
            className: 'dsh-au-input',
            placeholder: '~/Projects/my-sync-config',
            value: syncRepoRoot,
            disabled: busy,
            onChange: (event) => setSyncRepoRoot(event.target.value),
            onBlur: async () => {
              const previous = savedSyncRepoRootRef.current;
              const nextPath = syncRepoRoot.trim();
              if (nextPath === previous) return;
              setBusy(true);
              try {
                const res = await callApi('saveCloudSyncSettings', { syncRepoRoot: nextPath });
                if (!res?.ok) {
                  setMessage('保存私人同步仓库路径失败');
                  return;
                }
                const saved = typeof res.syncRepoRoot === 'string' ? res.syncRepoRoot.trim() : nextPath;
                setSyncRepoRoot(saved);
                savedSyncRepoRootRef.current = saved;
                if (saved !== previous) {
                  setRepoPathRestart(true);
                  setMessage('路径已更改，请重启 DSH 后生效');
                }
              } catch {
                setMessage('保存私人同步仓库路径失败');
              } finally {
                setBusy(false);
              }
            },
          }),
          hint: [
            cloudSync.lastSyncedAt ? `上次同步：${cloudSync.lastSyncedAt}` : '',
            message,
          ],
          actions: (cloudSync.restartRequired || repoPathRestart)
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-au-btn',
                  onClick: handleRestartDsh,
                },
                '立即重启 DSH'
              )
            : null,
        }),
        h(CloudSyncModal, {
          isOpen: modalOpen,
          onClose: () => setModalOpen(false),
          cloudSync,
          items: allItems,
          itemsByProfile,
          pluginItems: allPluginItems,
          preferenceItems: resolvedPreferenceItems,
          machineId,
          onSave: handleSaveModal,
          onSaveAndSync: handleSaveAndSyncModal,
          onPushToRepo: handlePushToRepo,
          onSyncSinglePlugin: handleSyncSinglePlugin,
          busy,
          message,
        }),
        firstSyncConfirmOpen
          ? portalSettingsModal(h(
              'div',
              { className: 'dsh-au-modal-mask dsh-au-modal-mask-above' },
              h(
                'div',
                { className: 'dsh-au-cloud-sync-modal', role: 'alertdialog', 'aria-modal': 'true', style: { maxWidth: '520px' } },
                h(
                  'div',
                  { className: 'dsh-au-cloud-sync-modal-header' },
                  h(
                    'div',
                    null,
                    h('h3', null, '首次从云端拉取配置'),
                    h('p', null, `这台电脑还没从私有仓库同步过。将用云端配置覆盖本机 ${firstSyncDiffCount} 项不一致的设置（DSH 官方设置、dsh-au 设置与已勾选的云插件），部分设置需重启 DSH 后生效。`)
                  )
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
                        className: 'dsh-au-btn',
                        disabled: busy,
                        onClick: () => { firstSyncDismissedRef.current = true; setFirstSyncConfirmOpen(false); },
                      },
                      '暂不'
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-au-btn dsh-au-btn-primary',
                        disabled: busy,
                        onClick: async () => {
                          setFirstSyncConfirmOpen(false);
                          firstSyncDismissedRef.current = true;
                          await handleRunSync();
                        },
                      },
                      busy ? '正在同步...' : '立即拉取'
                    )
                  )
                )
              )
            ))
          : null
      );
    }

    const SETTINGS_CATEGORY_STORAGE_KEY = 'dsh-au.settings-categories.v1';

    /** 读取某个设置大类是否展开；没有记录时用页面默认值。 */
    function readSettingsCategoryOpen(id, defaultOpen) {
      try {
        const raw = localStorage.getItem(SETTINGS_CATEGORY_STORAGE_KEY);
        if (!raw) return defaultOpen;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && Object.prototype.hasOwnProperty.call(parsed, id)) {
          return parsed[id] === true;
        }
      } catch {}
      return defaultOpen;
    }

    function writeSettingsCategoryOpen(id, open) {
      try {
        const raw = localStorage.getItem(SETTINGS_CATEGORY_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        if (!parsed || typeof parsed !== 'object') return;
        parsed[id] = open;
        localStorage.setItem(SETTINGS_CATEGORY_STORAGE_KEY, JSON.stringify(parsed));
      } catch {}
    }

    /** 设置页大类：标题可折叠，记住展开状态，组内仍复用原有开关行。 */
    function SettingsCategory({ id, title, hint, defaultOpen = false, children }) {
      const [open, setOpen] = useState(() => readSettingsCategoryOpen(id, defaultOpen));
      const panelId = `dsh-au-settings-cat-${id}`;
      return h(
        'div',
        { className: `dsh-au-settings-category${open ? ' is-open' : ''}`, 'data-category': id },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-au-settings-category-toggle',
            'aria-expanded': open,
            'aria-controls': panelId,
            onClick: () => {
              const next = !open;
              setOpen(next);
              writeSettingsCategoryOpen(id, next);
            },
          },
          h('span', { className: 'dsh-au-settings-category-title' }, title),
          h('span', { className: 'dsh-au-settings-category-hint' }, open ? '' : hint),
          h(DeviceBarChevron, { expanded: open })
        ),
        h('div', { id: panelId, className: 'dsh-au-settings-category-body', hidden: !open }, children)
      );
    }

    function WindowMemoryFeatureGroup() {
      const snapshot = useWindowState();
      const titleId = 'dsh-au-window-memory-title';
      const supported = snapshot.supported;
      const hint = snapshot.error
        || (supported ? describeWindowGeometry(snapshot.geometry) : '仅在 DSH 桌面端生效；浏览器访问时无法还原窗口。');
      return h(
        'section',
        { className: 'dsh-au-settings-group', 'aria-labelledby': titleId },
        h('h3', { id: titleId }, '窗口位置与大小'),
        h(SettingsItem, {
          title: '启动时还原窗口',
          description: '记住关闭前的位置、大小和所在显示器，下次启动自动还原；最大化时直接还原为系统最大化。',
          hint,
          control: h(
            'button',
            {
              type: 'button',
              role: 'switch',
              className: 'dsh-au-switch',
              'aria-checked': snapshot.enabled,
              'aria-labelledby': titleId,
              disabled: !supported || snapshot.busy,
              onClick: () => { void windowStateController?.setEnabled(!snapshot.enabled); },
            },
            h('span', { className: 'dsh-au-switch-knob', 'aria-hidden': 'true' })
          ),
        })
      );
    }

    function SidebarWorkbenchFeatureGroup() {
      const features = useFeatures();
      const enabled = features.sidebarWorkbench === true;
      return h(FeatureSwitchGroup, {
        id: 'sidebar-workbench',
        heading: '侧边栏入口',
        title: '在侧边栏显示 DSH AU',
        description: '打开后在左侧边栏顶部导航区添加「DSH AU」入口，点击即可打开设置弹窗并切换到 DSH AU。',
        checked: enabled,
        disabled: !features.loaded || features.busy,
        onToggle: () => { void saveSidebarWorkbenchFeature(!enabled); },
        hint: features.error || (enabled ? '已开启：左侧边栏已显示「DSH AU」入口。' : '已关闭：侧边栏不显示「DSH AU」入口。'),
      });
    }

    /** 侧边栏私人扩展（如 GrokBot、Claude）本机独立开关组；无可用侧边栏扩展时隐藏。 */
    function SidebarExtensionsFeatureGroup() {
      const features = useFeatures();
      const catalog = Array.isArray(features.sidebarExtensionCatalog) ? features.sidebarExtensionCatalog : [];
      if (catalog.length === 0) return null;
      const flags = features.sidebarExtensions && typeof features.sidebarExtensions === 'object'
        ? features.sidebarExtensions
        : {};
      const headingId = 'dsh-au-feature-sidebar-extensions-title';
      return h(
        'section',
        { className: 'dsh-au-settings-group', 'aria-labelledby': headingId },
        h('h3', { id: headingId }, '侧边栏扩展'),
        catalog.map((ext) => {
          const enabled = flags[ext.id] !== false;
          const itemTitleId = `dsh-au-feature-sidebar-ext-${ext.id}`;
          return h(SettingsItem, {
            key: ext.id,
            title: `在侧边栏挂载 ${ext.title}`,
            description: `控制本机是否在左侧边栏加载「${ext.title}」扩展（${ext.id}）。关闭后立即卸载且不再轮询，只保存在这台电脑，不会同步到其他电脑。`,
            hint: features.error || (enabled ? '已开启：当前电脑侧边栏已挂载该扩展。' : '已关闭：当前电脑侧边栏不挂载该扩展。'),
            control: h(
              'button',
              {
                type: 'button',
                role: 'switch',
                className: 'dsh-au-switch',
                'aria-checked': enabled,
                'aria-label': `在侧边栏挂载 ${ext.title}`,
                id: itemTitleId,
                disabled: !features.loaded || features.busy,
                onClick: () => { void saveSidebarExtensionFeature(ext.id, !enabled); },
              },
              h('span', { className: 'dsh-au-switch-knob', 'aria-hidden': 'true' })
            ),
          });
        })
      );
    }

    /** 设置页按使用频率分组：日常工作台、对话权限默认展开，快捷键和同步默认收起。 */
    function AuSettingsSection() {
      return h(
        'div',
        { className: 'dsh-au-settings-page' },
        h(SettingsCategory, { id: 'workspace', title: '工作台', hint: '远程 · 侧边栏 · 待办 · 移动端 · 窗口', defaultOpen: true },
          h(RemoteManagementFeatureGroup),
          h(SidebarWorkbenchFeatureGroup),
          h(SidebarExtensionsFeatureGroup),
          h(TodoFeatureGroup),
          h(MobileFeatureGroup),
          h(WindowMemoryFeatureGroup),
          h(LockRemoteFeatureGroup)
        ),
        h(SettingsCategory, { id: 'conversation', title: '对话与权限', hint: '权限 · 目标 · 续跑', defaultOpen: true },
          h(FullAccessFeatureGroup),
          h(GoalCreationFeatureGroup),
          h(AutoContinueFeatureGroup)
        ),
        h(SettingsCategory, { id: 'shortcuts', title: '快捷操作', hint: '快捷键 · 模型', defaultOpen: false },
          h(ShortcutSettingsSection),
          h(ModelShortcutSettingsSection)
        ),
        h(SettingsCategory, { id: 'sync', title: '同步', hint: '官方设置与云插件', defaultOpen: false },
          h(CloudSyncFeatureGroup)
        )
      );
    }

