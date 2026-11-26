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

    /** 服务端未返回前的兜底同步项（7 项非模型官方配置 + 4 项模型子项，共 11 项；对比细节以服务端为准）。 */
    const FALLBACK_CLOUD_SYNC_ITEMS = [
      { id: 'ui-theme', title: '外观：字号', patchIds: ['ui-theme'], comparisons: [] },
      { id: 'ui-chat', title: '聊天内容展示', patchIds: ['ui-chat'], comparisons: [] },
      { id: 'ui-settings-account', title: '账号设置界面', patchIds: ['ui-settings-account'], comparisons: [] },
      { id: 'session-log-deepseek', title: '会话日志上传设置', patchIds: ['session-log-deepseek'], comparisons: [] },
      { id: 'subagent-models', title: '子智能体：模型选择', patchIds: ['subagent-model-selection-settings'], comparisons: [] },
      { id: 'permission-preset', title: '权限：新会话的默认权限模式', patchIds: ['permission'], comparisons: [] },
      { id: 'desktop-preferences', title: '桌面设置：后台运行、浏览器与局域网、桌面通知', patchIds: [], isDesktopPreferences: true, comparisons: [] },
      { id: 'llm-pi-ai', title: '模型提供商', category: 'models', nonOfficial: true, patchIds: ['llm-pi-ai'], comparisons: [] },
      { id: 'claude-launcher', title: 'Claude 启动器与 4 档位映射', category: 'models', nonOfficial: true, patchIds: [], comparisons: [] },
      { id: 'codex-catalog', title: 'Codex 模型目录', category: 'models', nonOfficial: true, patchIds: [], comparisons: [] },
      { id: 'dsh-acp-adapter', title: 'Cursor ACP 适配器', category: 'models', nonOfficial: true, patchIds: ['dsh-acp-adapter'], comparisons: [] },
    ];

    /** 模型配置大类包含的子项 ID */
    const MODEL_CONFIG_ITEM_IDS = new Set([
      'llm-pi-ai',
      'claude-launcher',
      'codex-catalog',
      'dsh-acp-adapter',
      'llm-providers',
    ]);

    /** 云插件与配置兜底列表（与服务端 buildCloudPluginSyncItems 一致） */
    const FALLBACK_CLOUD_SYNC_PLUGINS = [];
    /** 与服务端 FIXED_SYNC_PLUGIN_ID 一致：dsh-au 固定参与云同步，不提供勾选 */
    const FIXED_SYNC_PLUGIN_ID = 'dsh-au';

    /** 本机设置兜底列表（与服务端 PREFERENCE_SYNC_ITEMS 一致） */
    const FALLBACK_PREFERENCE_ITEMS = [
      {
        id: 'shortcuts',
        category: '本机设置',
        title: '快捷键配置',
        defaultDiff: '默认单机备份，勾选后多台电脑云端共享自动同步',
      },
      {
        id: 'modelShortcuts',
        category: '本机设置',
        title: '快捷模型配置',
        defaultDiff: '默认单机备份，勾选后多台电脑云端共享自动同步',
      },
    ];

    // 后端未下发动态方案列表时的默认兜底常量；实际方案全部由后端返回。
    const DEFAULT_CLOUD_SYNC_PROFILE_OPTIONS = [
      { id: 'general', label: '通用' },
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

    function isModelSyncItem(item) {
      return Boolean(item && (item.category === 'models' || MODEL_CONFIG_ITEM_IDS.has(item.id)));
    }

    function prefDisplayTitle(item) {
      if (!item) return '';
      if (item.id === 'shortcuts') return '快捷键配置';
      if (item.id === 'modelShortcuts') return '快捷模型配置';
      return item.title || item.id;
    }

    function formatShortcutLabel(actionId, fallbackLabel) {
      const actions = (typeof shortcutHelpers !== 'undefined' && Array.isArray(shortcutHelpers?.SHORTCUT_ACTIONS))
        ? shortcutHelpers.SHORTCUT_ACTIONS
        : [];
      const found = actions.find(a => a.id === actionId);
      if (found) return `${found.label}（${actionId}）`;
      if (fallbackLabel && fallbackLabel !== actionId) return `${fallbackLabel}（${actionId}）`;
      return actionId || fallbackLabel || '快捷键';
    }

    function formatShortcutVal(val) {
      if (val === null) return '（已清除）';
      if (val === undefined) return '（默认）';
      if (typeof val === 'string') return val || '（未绑定）';
      if (typeof val === 'object' && typeof val.code === 'string') {
        if (typeof shortcutHelpers !== 'undefined' && typeof shortcutHelpers?.describeShortcutBinding === 'function') {
          return shortcutHelpers.describeShortcutBinding(val);
        }
        return val.code;
      }
      return JSON.stringify(val);
    }

    function formatCompareValue(val) {
      if (val === null || val === undefined || val === '') return '未设置';
      if (typeof val === 'boolean') return val ? '开启' : '关闭';
      if (typeof val === 'object') {
        if (typeof val.code === 'string') return formatShortcutVal(val);
        try { return JSON.stringify(val); } catch { return String(val); }
      }
      return String(val);
    }

    function makeCompareLine(label, value, tone, prefix = '') {
      return { text: `${prefix}${label}: ${value}`, tone };
    }

    /** 构造冲突行的双栏对比数据（本机 vs 云端）。 */
    function buildConflictCompareData(item, kind, shortcutOverrides, modelShortcutSnapshot) {
      const localLines = [];
      const cloudLines = [];
      let changedCount = 0;

      if (Array.isArray(item.diffLines) && item.diffLines.length > 0) {
        for (const line of item.diffLines) {
          const isShortcut = item.id === 'shortcuts';
          const label = isShortcut
            ? formatShortcutLabel(line.key || line.label, line.label)
            : (line.label && line.key && line.label !== line.key && !String(line.label).includes(line.key)
                ? `${line.label}（${line.key}）`
                : (line.label || line.key || '配置项'));
          const localText = isShortcut ? formatShortcutVal(line.local) : formatCompareValue(line.local);
          const cloudText = isShortcut ? formatShortcutVal(line.cloud) : formatCompareValue(line.cloud);
          const changed = line.changed !== undefined ? Boolean(line.changed) : (localText !== cloudText);
          if (changed) changedCount += 1;
          const localMissing = line.local === undefined || line.local === null;
          const cloudMissing = line.cloud === undefined || line.cloud === null;
          const localTone = !changed ? 'normal' : (localMissing ? 'removed' : (cloudMissing ? 'added' : 'changed'));
          const cloudTone = !changed ? 'normal' : (cloudMissing ? 'removed' : (localMissing ? 'added' : 'changed'));
          const lPrefix = localTone === 'added' ? '+ ' : (localTone === 'removed' ? '- ' : (localTone === 'changed' ? '~ ' : ''));
          const cPrefix = cloudTone === 'added' ? '+ ' : (cloudTone === 'removed' ? '- ' : (cloudTone === 'changed' ? '~ ' : ''));
          localLines.push(makeCompareLine(label, localText, localTone, lPrefix));
          cloudLines.push(makeCompareLine(label, cloudText, cloudTone, cPrefix));
        }
        return { localLines, cloudLines, diffCount: changedCount || item.diffLines.length };
      }

      if (item.id === 'shortcuts') {
        const localObj = (item.localValue && typeof item.localValue === 'object')
          ? item.localValue
          : (shortcutOverrides && typeof shortcutOverrides === 'object' ? shortcutOverrides : {});
        const cloudObj = (item.cloudValue && typeof item.cloudValue === 'object') ? item.cloudValue : {};
        const keys = Array.from(new Set([...Object.keys(localObj), ...Object.keys(cloudObj)]));
        for (const k of keys) {
          const label = formatShortcutLabel(k, k);
          const hasL = Object.prototype.hasOwnProperty.call(localObj, k);
          const hasC = Object.prototype.hasOwnProperty.call(cloudObj, k);
          const localText = hasL ? formatShortcutVal(localObj[k]) : '（默认）';
          const cloudText = hasC ? formatShortcutVal(cloudObj[k]) : '（默认）';
          const changed = canonicalCloudSyncJson(localObj[k]) !== canonicalCloudSyncJson(cloudObj[k]);
          if (changed) changedCount += 1;
          const tone = changed ? 'changed' : 'normal';
          const prefix = changed ? '~ ' : '';
          localLines.push(makeCompareLine(label, localText, tone, prefix));
          cloudLines.push(makeCompareLine(label, cloudText, tone, prefix));
        }
        if (localLines.length > 0) {
          return { localLines, cloudLines, diffCount: changedCount || localLines.length };
        }
      }

      if (item.id === 'modelShortcuts') {
        const localObj = (item.localValue && typeof item.localValue === 'object')
          ? item.localValue
          : (modelShortcutSnapshot?.loaded
              ? {
                  enabled: Boolean(modelShortcutSnapshot.enabled),
                  binding: modelShortcutSnapshot.binding ?? null,
                  slots: Array.isArray(modelShortcutSnapshot.slots) ? modelShortcutSnapshot.slots : [],
                }
              : null);
        const cloudObj = (item.cloudValue && typeof item.cloudValue === 'object') ? item.cloudValue : null;
        if (localObj || cloudObj) {
          const lEnabled = localObj ? Boolean(localObj.enabled) : false;
          const cEnabled = cloudObj ? Boolean(cloudObj.enabled) : false;
          const enabledChanged = lEnabled !== cEnabled;
          if (enabledChanged) changedCount += 1;
          localLines.push(makeCompareLine('启用状态（enabled）', lEnabled ? '开启' : '关闭', enabledChanged ? 'changed' : 'normal', enabledChanged ? '~ ' : ''));
          cloudLines.push(makeCompareLine('启用状态（enabled）', cEnabled ? '开启' : '关闭', enabledChanged ? 'changed' : 'normal', enabledChanged ? '~ ' : ''));

          const lSlots = Array.isArray(localObj?.slots) ? localObj.slots : [];
          const cSlots = Array.isArray(cloudObj?.slots) ? cloudObj.slots : [];
          const maxSlots = Math.max(lSlots.length, cSlots.length);
          for (let i = 0; i < maxSlots; i += 1) {
            const ls = lSlots[i];
            const cs = cSlots[i];
            const lText = ls ? (ls.modelId || ls.label || JSON.stringify(ls)) : '（未绑定）';
            const cText = cs ? (cs.modelId || cs.label || JSON.stringify(cs)) : '（未绑定）';
            const slotChanged = lText !== cText;
            if (slotChanged) changedCount += 1;
            const lTone = !slotChanged ? 'normal' : (!ls ? 'removed' : (!cs ? 'added' : 'changed'));
            const cTone = !slotChanged ? 'normal' : (!cs ? 'removed' : (!ls ? 'added' : 'changed'));
            localLines.push(makeCompareLine(`槽位 ${i + 1}（Slot ${i + 1}）`, lText, lTone, lTone === 'added' ? '+ ' : (lTone === 'removed' ? '- ' : (lTone === 'changed' ? '~ ' : ''))));
            cloudLines.push(makeCompareLine(`槽位 ${i + 1}（Slot ${i + 1}）`, cText, cTone, cTone === 'added' ? '+ ' : (cTone === 'removed' ? '- ' : (cTone === 'changed' ? '~ ' : ''))));
          }
          return { localLines, cloudLines, diffCount: changedCount || 1 };
        }
      }

      if (Array.isArray(item.fields) && item.fields.length > 0) {
        const diffFields = item.fields.filter(f => !f.localOnly && (f.local ?? null) !== (f.cloud ?? null));
        const targetFields = diffFields.length > 0 ? diffFields : item.fields.slice(0, 6);
        for (const f of targetFields) {
          const label = f.key && !String(f.label || '').includes(f.key)
            ? `${f.label || f.key}（${f.key}）`
            : (f.label || f.key || '配置项');
          const localText = formatCompareValue(f.local);
          const cloudText = f.localOnly ? '（本机独有）' : formatCompareValue(f.cloud);
          const changed = !f.localOnly && (f.local ?? null) !== (f.cloud ?? null);
          if (changed) changedCount += 1;
          const tone = changed ? 'changed' : 'normal';
          const prefix = changed ? '~ ' : '';
          localLines.push(makeCompareLine(label, localText, tone, prefix));
          cloudLines.push(makeCompareLine(label, cloudText, tone, prefix));
        }
        return { localLines, cloudLines, diffCount: changedCount || diffFields.length || 1 };
      }

      if (item.localValue !== undefined || item.cloudValue !== undefined) {
        const lText = formatCompareValue(item.localValue);
        const cText = formatCompareValue(item.cloudValue);
        const changed = lText !== cText;
        localLines.push(makeCompareLine(item.title || item.id, lText, changed ? 'changed' : 'normal', changed ? '~ ' : ''));
        cloudLines.push(makeCompareLine(item.title || item.id, cText, changed ? 'changed' : 'normal', changed ? '~ ' : ''));
        return { localLines, cloudLines, diffCount: 1 };
      }

      const fallbackText = (Array.isArray(item.diffDetails) && item.diffDetails.length > 0)
        ? item.diffDetails.join('、')
        : (item.diffLabel || '本地与云端存在差异');
      localLines.push({ text: `~ ${fallbackText}`, tone: 'changed' });
      cloudLines.push({ text: `~ 云端版本不同`, tone: 'changed' });
      return { localLines, cloudLines, diffCount: (Array.isArray(item.diffDetails) && item.diffDetails.length) || 1 };
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

    /** 云端同步独立弹窗：单页极简 4 卡片 + 顶部冲突对比区 + 即时生效 */
    function CloudSyncModal({
      isOpen,
      onClose,
      cloudSync,
      profileOptions,
      items,
      itemsByProfile,
      pluginItems,
      preferenceItems,
      shortcutOverrides,
      modelShortcutSnapshot,
      machineId,
      onQuickSave,
      onSave,
      onSaveAndSync,
      onPushToRepo,
      onResolveConflict,
      onSyncSinglePlugin,
      busy,
      message,
    }) {
      const availableProfileOptions = Array.isArray(profileOptions) && profileOptions.length > 0
        ? profileOptions
        : DEFAULT_CLOUD_SYNC_PROFILE_OPTIONS;
      const defaultProfileId = availableProfileOptions.some((o) => o.id === cloudSync.profile)
        ? cloudSync.profile
        : (availableProfileOptions[0]?.id || 'general');
      const [profile, setProfile] = useState(defaultProfileId);
      const [preferenceMap, setPreferenceMap] = useState(() => {
        const initial = {};
        for (const id of (cloudSync.selectedPreferences || [])) initial[id] = true;
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
      const [expandedGroups, setExpandedGroups] = useState({ models: false, plugins: false, shortcuts: false });
      const [expandedDiffs, setExpandedDiffs] = useState({});
      const [toast, setToast] = useState(null);
      const toastTimerRef = useRef(null);

      useEffect(() => {
        if (!isOpen) return;
        setProfile(defaultProfileId);
        const nextItems = {};
        for (const id of (cloudSync.selectedItems || [])) nextItems[id] = true;
        setSelectedMap(nextItems);
        const nextPlugins = {};
        for (const id of (cloudSync.selectedPlugins || FALLBACK_CLOUD_SYNC_PLUGINS.map(p => p.id))) nextPlugins[id] = true;
        setSelectedPluginsMap(nextPlugins);
        const nextPreferences = {};
        for (const id of (cloudSync.selectedPreferences || [])) nextPreferences[id] = true;
        setPreferenceMap(nextPreferences);
      }, [isOpen, defaultProfileId, cloudSync.selectedItems, cloudSync.selectedPlugins, cloudSync.selectedPreferences]);

      useEffect(() => {
        if (!isOpen) return;
        setExpandedGroups({ models: false, plugins: false, shortcuts: false });
        setExpandedDiffs({});
        setToast(null);
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

      const showToast = (text, isError = false) => {
        setToast({ text, isError });
        if (toastTimerRef.current && typeof clearTimeout === 'function') {
          clearTimeout(toastTimerRef.current);
        }
        if (typeof setTimeout === 'function') {
          toastTimerRef.current = setTimeout(() => { setToast(null); }, 2400);
        }
      };

      const profileItems = itemsByProfile && Array.isArray(itemsByProfile[profile]) && itemsByProfile[profile].length > 0
        ? itemsByProfile[profile]
        : null;
      const allList = profileItems || (items && items.length > 0 ? items : FALLBACK_CLOUD_SYNC_ITEMS);
      const modelGroupItems = allList.filter(isModelSyncItem);
      const officialGroupItems = allList.filter(item => !isModelSyncItem(item));

      const allPluginList = Array.isArray(pluginItems) ? pluginItems : FALLBACK_CLOUD_SYNC_PLUGINS;
      const dshAuPluginItem = allPluginList.find(item => item.id === FIXED_SYNC_PLUGIN_ID) || null;
      const otherPluginList = allPluginList.filter(item => item.id !== FIXED_SYNC_PLUGIN_ID);

      const preferenceList = preferenceItems && preferenceItems.length > 0 ? preferenceItems : FALLBACK_PREFERENCE_ITEMS;

      const buildPayloadWith = (nextSelectedMap, nextPluginsMap, nextPrefMap) => {
        const nextSelectedItems = allList.filter(i => nextSelectedMap[i.id]).map(i => i.id);
        const nextSelectedPlugins = allPluginList
          .filter(p => p.id === FIXED_SYNC_PLUGIN_ID || nextPluginsMap[p.id])
          .map(p => p.id);
        const nextSelectedPreferences = preferenceList.filter(p => nextPrefMap[p.id]).map(p => p.id);
        return {
          profile,
          selectedItems: nextSelectedItems,
          selectedPlugins: nextSelectedPlugins,
          syncPluginConfigs: nextSelectedPlugins,
          selectedPreferences: nextSelectedPreferences,
        };
      };

      const buildPayload = () => buildPayloadWith(selectedMap, selectedPluginsMap, preferenceMap);

      const commitQuickSave = (nextSelectedMap, nextPluginsMap, nextPrefMap, toastText) => {
        showToast(toastText);
        const payload = buildPayloadWith(nextSelectedMap, nextPluginsMap, nextPrefMap);
        const saver = typeof onQuickSave === 'function' ? onQuickSave : onSave;
        if (typeof saver === 'function') void saver(payload);
      };

      const toggleGroupOpen = (groupKey) => {
        setExpandedGroups(prev => ({ ...prev, [groupKey]: !prev[groupKey] }));
      };

      const toggleDiffOpen = (diffKey) => {
        setExpandedDiffs(prev => ({ ...prev, [diffKey]: !prev[diffKey] }));
      };

      // 1. DSH 官方配置（纯开关卡片，全开/全关 7 项非模型官方配置）
      const selectedOfficialCount = officialGroupItems.filter(i => selectedMap[i.id]).length;
      const allOfficialSelected = officialGroupItems.length > 0 && selectedOfficialCount === officialGroupItems.length;
      const partialOfficialSelected = selectedOfficialCount > 0 && !allOfficialSelected;
      const toggleOfficialGroup = () => {
        if (busy) return;
        const turnOn = !allOfficialSelected;
        const next = { ...selectedMap };
        for (const item of officialGroupItems) next[item.id] = turnOn;
        setSelectedMap(next);
        commitQuickSave(
          next,
          selectedPluginsMap,
          preferenceMap,
          turnOn ? '✓ 「DSH 官方配置」已开启云端共享，正在自动同步…' : '✓ 「DSH 官方配置」已切回仅单机备份'
        );
      };

      // 2. 模型配置（5 项精细行 + 右侧三态总开关）
      const selectedModelCount = modelGroupItems.filter(i => selectedMap[i.id]).length;
      const allModelSelected = modelGroupItems.length > 0 && selectedModelCount === modelGroupItems.length;
      const partialModelSelected = selectedModelCount > 0 && !allModelSelected;
      const toggleModelGroup = () => {
        if (busy) return;
        const turnOn = !allModelSelected;
        const next = { ...selectedMap };
        for (const item of modelGroupItems) next[item.id] = turnOn;
        setSelectedMap(next);
        commitQuickSave(
          next,
          selectedPluginsMap,
          preferenceMap,
          turnOn ? '✓ 「模型配置」已全部开启云端共享，正在自动同步…' : '✓ 「模型配置」已全部切回仅单机备份'
        );
      };
      const toggleModelChip = (item) => {
        if (busy) return;
        const nextOn = !selectedMap[item.id];
        const next = { ...selectedMap, [item.id]: nextOn };
        setSelectedMap(next);
        commitQuickSave(
          next,
          selectedPluginsMap,
          preferenceMap,
          nextOn ? `✓ 「${item.title || item.id}」已开启云端共享` : `✓ 「${item.title || item.id}」已切回单机备份`
        );
      };

      // 3. 其它云插件（chip 多选 + 右侧三态总开关）
      const selectedPluginCount = otherPluginList.filter(p => selectedPluginsMap[p.id]).length;
      const allPluginsSelected = otherPluginList.length > 0 && selectedPluginCount === otherPluginList.length;
      const partialPluginsSelected = selectedPluginCount > 0 && !allPluginsSelected;
      const togglePluginsGroup = () => {
        if (busy) return;
        const turnOn = !allPluginsSelected;
        const next = { ...selectedPluginsMap };
        for (const p of otherPluginList) next[p.id] = turnOn;
        setSelectedPluginsMap(next);
        commitQuickSave(
          selectedMap,
          next,
          preferenceMap,
          turnOn ? '✓ 「其它云插件」已全部开启云端共享，正在自动同步…' : '✓ 「其它云插件」已全部切回仅单机备份'
        );
      };
      const togglePluginChip = (p) => {
        if (busy) return;
        const nextOn = !selectedPluginsMap[p.id];
        const next = { ...selectedPluginsMap, [p.id]: nextOn };
        setSelectedPluginsMap(next);
        commitQuickSave(
          selectedMap,
          next,
          preferenceMap,
          nextOn ? `✓ 「${p.title || p.id}」已开启云端共享` : `✓ 「${p.title || p.id}」已切回单机备份`
        );
      };

      // 4. 快捷操作（快捷键配置 + 快捷模型配置 + 右侧三态总开关）
      const selectedPrefCount = preferenceList.filter(p => preferenceMap[p.id]).length;
      const allPrefsSelected = preferenceList.length > 0 && selectedPrefCount === preferenceList.length;
      const partialPrefsSelected = selectedPrefCount > 0 && !allPrefsSelected;
      const toggleShortcutsGroup = () => {
        if (busy) return;
        const turnOn = !allPrefsSelected;
        const next = {};
        for (const p of preferenceList) next[p.id] = turnOn;
        setPreferenceMap(next);
        commitQuickSave(
          selectedMap,
          selectedPluginsMap,
          next,
          turnOn ? '✓ 「快捷操作」已全部开启云端共享，正在自动同步…' : '✓ 「快捷操作」已全部切回仅单机备份'
        );
      };
      const togglePreferenceChip = (p) => {
        if (busy) return;
        const nextOn = !preferenceMap[p.id];
        const next = { ...preferenceMap, [p.id]: nextOn };
        setPreferenceMap(next);
        commitQuickSave(
          selectedMap,
          selectedPluginsMap,
          next,
          nextOn ? `✓ 「${prefDisplayTitle(p)}」已开启云端共享` : `✓ 「${prefDisplayTitle(p)}」已切回单机备份`
        );
      };

      // 顶部冲突 / 不一致列表（仅纳入当前参与同步的已勾选项 + 固定共享的 dsh-au）
      const conflictRows = [];
      for (const item of allList) {
        if (selectedMap[item.id] && item.inSync === false) {
          const cmp = buildConflictCompareData(item, 'official', shortcutOverrides, modelShortcutSnapshot);
          const prefix = (cloudSync.conflict || item.conflict) ? '双端冲突' : '不一致';
          conflictRows.push({
            key: `official:${item.id}`,
            kind: 'official',
            id: item.id,
            title: item.title || item.id,
            badge: `${prefix} · ${cmp.diffCount} 处差异`,
            localMeta: item.localMeta || '',
            cloudMeta: item.cloudMeta || '',
            localLines: cmp.localLines,
            cloudLines: cmp.cloudLines,
          });
        }
      }
      for (const p of otherPluginList) {
        if (selectedPluginsMap[p.id] && p.inSync === false) {
          const cmp = buildConflictCompareData(p, 'plugin', shortcutOverrides, modelShortcutSnapshot);
          const prefix = (cloudSync.conflict || p.conflict) ? '双端冲突' : '不一致';
          conflictRows.push({
            key: `plugin:${p.id}`,
            kind: 'plugin',
            id: p.id,
            title: `云插件 · ${p.title || p.id}`,
            badge: `${prefix} · ${cmp.diffCount} 处差异`,
            localMeta: p.localMeta || (p.localVersion ? `v${p.localVersion}` : ''),
            cloudMeta: p.cloudMeta || (p.cloudVersion ? `v${p.cloudVersion}` : ''),
            localLines: cmp.localLines,
            cloudLines: cmp.cloudLines,
          });
        }
      }
      for (const pref of preferenceList) {
        if (preferenceMap[pref.id] && pref.inSync === false) {
          const cmp = buildConflictCompareData(pref, 'preference', shortcutOverrides, modelShortcutSnapshot);
          const prefix = (cloudSync.conflict || pref.conflict) ? '双端冲突' : '不一致';
          conflictRows.push({
            key: `preference:${pref.id}`,
            kind: 'preference',
            id: pref.id,
            title: prefDisplayTitle(pref),
            badge: `${prefix} · ${cmp.diffCount} 处差异`,
            localMeta: pref.localMeta || '',
            cloudMeta: pref.cloudMeta || '',
            localLines: cmp.localLines,
            cloudLines: cmp.cloudLines,
          });
        }
      }
      if (dshAuPluginItem && dshAuPluginItem.inSync === false) {
        const cmp = buildConflictCompareData(dshAuPluginItem, 'dshau', shortcutOverrides, modelShortcutSnapshot);
        const prefix = (cloudSync.conflict || dshAuPluginItem.conflict) ? '双端冲突' : '不一致';
        conflictRows.push({
          key: 'dshau:dsh-au',
          kind: 'dshau',
          id: FIXED_SYNC_PLUGIN_ID,
          title: 'dsh-au 基础开关',
          badge: `${prefix} · ${cmp.diffCount} 处差异`,
          localMeta: dshAuPluginItem.localMeta || '',
          cloudMeta: dshAuPluginItem.cloudMeta || '',
          localLines: cmp.localLines,
          cloudLines: cmp.cloudLines,
        });
      }

      const hasConflictOrDiff = conflictRows.length > 0 || Boolean(cloudSync.conflict);

      const handleResolveRow = async (row, direction) => {
        if (busy) return;
        if (typeof onResolveConflict === 'function') {
          try {
            const res = await onResolveConflict({ kind: row.kind, id: row.id, direction, profile });
            if (res && res.ok === false) {
              showToast(res.error || '处理冲突失败', true);
              return;
            }
            if (res && res.skipped) {
              showToast(res.message || '未执行覆盖（已跳过）', true);
              return;
            }
            showToast(direction === 'push' ? `✓ 已将「${row.title}」用本机覆盖云端` : `✓ 已将「${row.title}」用云端覆盖本机`);
          } catch (err) {
            showToast(err?.message || '处理冲突异常', true);
          }
          return;
        }
        if (row.kind === 'plugin' && typeof onSyncSinglePlugin === 'function') {
          try {
            const res = await onSyncSinglePlugin({ profile, pluginId: row.id, direction });
            if (res && res.ok === false) {
              showToast(res.error || '单插件同步失败', true);
              return;
            }
            if (res && res.skipped) {
              showToast(res.message || '未执行同步（已跳过）', true);
              return;
            }
            showToast(direction === 'push' ? `✓ 已将「${row.title}」推送到云` : `✓ 已将「${row.title}」同步到本地`);
          } catch (err) {
            showToast(err?.message || '单插件同步异常', true);
          }
          return;
        }
        if (direction === 'push' && typeof onPushToRepo === 'function') {
          void onPushToRepo(buildPayload());
        } else if (direction === 'pull' && typeof onSaveAndSync === 'function') {
          void onSaveAndSync(buildPayload());
        }
      };

      const renderTriSwitch = (allOn, partialOn) => h(
        'div',
        {
          className: `dsh-au-cs-switch${allOn ? ' on' : (partialOn ? ' partial' : '')}`,
          'data-role': 'switch',
        }
      );

      const renderModePill = (selectedCount, totalCount, showRatioOnFull = true) => {
        if (selectedCount === 0) {
          return h('span', { className: 'dsh-au-cs-mode-pill machine', 'data-role': 'pill' }, '仅单机备份');
        }
        if (totalCount > 0 && selectedCount === totalCount) {
          return h(
            'span',
            { className: 'dsh-au-cs-mode-pill shared', 'data-role': 'pill' },
            showRatioOnFull && totalCount > 1 ? `云端共享 ${selectedCount}/${totalCount}` : '云端共享'
          );
        }
        return h(
          'span',
          { className: 'dsh-au-cs-mode-pill partial', 'data-role': 'pill' },
          `云端共享 ${selectedCount}/${totalCount}`
        );
      };

      const renderDetailTags = (tags) => {
        if (!Array.isArray(tags) || tags.length === 0) return null;
        return h(
          'div',
          { className: 'dsh-au-cs-provider-tags' },
          tags.map((tag, idx) => {
            if (typeof tag === 'string') {
              return h(
                'span',
                { key: idx, className: 'dsh-au-cs-provider-tag' },
                h('span', { className: 'dsh-au-cs-provider-dot' }),
                tag
              );
            }
            const label = tag.label || tag.name || tag.id || '';
            const detail = tag.value || tag.detail || '';
            const isWarn = Boolean(tag.warn || tag.status === 'warn');
            return h(
              'span',
              { key: tag.key || idx, className: 'dsh-au-cs-provider-tag' },
              h('span', { className: `dsh-au-cs-provider-dot${isWarn ? ' warn' : ''}` }),
              label ? h('strong', null, label) : null,
              detail ? (label ? `（${detail}）` : detail) : null
            );
          })
        );
      };

      const footerToastText = toast?.text || message || '';
      const footerToastError = Boolean(toast?.isError || (!toast && message && /失败|异常|错误|未声明|不存在|未配置|已跳过/.test(message)));

      return h(
        'div',
        {
          className: 'dsh-au-modal-mask',
          onClick: (e) => { if (e.target === e.currentTarget && !busy) onClose(); },
        },
        h(
          'div',
          { className: 'dsh-au-cloud-sync-modal dsh-au-cs-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '云端同步设置' },
          h(
            'div',
            { className: 'dsh-au-cs-header' },
            h(
              'div',
              null,
              h('h3', { className: 'dsh-au-cs-title' }, '云端同步设置'),
              h('p', { className: 'dsh-au-cs-sub' }, '开启的分类会在多台电脑间自动双向同步，未勾选的默认单机备份；点左侧展开明细，点右侧开关一键全选。')
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-au-cloud-sync-modal-close',
                onClick: onClose,
                disabled: busy,
                title: '关闭',
              },
              '×'
            )
          ),
          h(
            'div',
            { className: 'dsh-au-cs-body' },
            hasConflictOrDiff
              ? h(
                  'div',
                  { className: 'dsh-au-cs-diff-panel', role: 'status' },
                  h(
                    'div',
                    { className: 'dsh-au-cs-diff-panel-head' },
                    h(
                      'div',
                      { className: 'dsh-au-cs-diff-panel-title' },
                      h('span', null, '⚠'),
                      h(
                        'span',
                        null,
                        conflictRows.length > 0
                          ? `检测到 ${conflictRows.length} 项冲突 / 不一致（点任意行可展开对比）`
                          : (cloudSync.conflictReason || '检测到双端冲突，请选择覆盖方向')
                      )
                    ),
                    h(
                      'div',
                      { className: 'dsh-au-cs-diff-bulk-btns' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-au-cs-mini-btn',
                          disabled: busy,
                          onClick: () => { if (typeof onPushToRepo === 'function') void onPushToRepo(buildPayload()); },
                        },
                        '全部用本机'
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-au-cs-mini-btn primary',
                          disabled: busy,
                          onClick: () => { if (typeof onSaveAndSync === 'function') void onSaveAndSync(buildPayload()); },
                        },
                        '全部用云端'
                      )
                    )
                  ),
                  conflictRows.length > 0
                    ? h(
                        'div',
                        { className: 'dsh-au-cs-diff-list' },
                        conflictRows.map(row => {
                          const isOpen = Boolean(expandedDiffs[row.key]);
                          return h(
                            'div',
                            { key: row.key, className: `dsh-au-cs-diff-item${isOpen ? ' open' : ''}` },
                            h(
                              'div',
                              {
                                className: 'dsh-au-cs-diff-row-head',
                                role: 'button',
                                tabIndex: 0,
                                'aria-expanded': isOpen,
                                onClick: () => toggleDiffOpen(row.key),
                                onKeyDown: (e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    toggleDiffOpen(row.key);
                                  }
                                },
                              },
                              h(
                                'div',
                                { className: 'dsh-au-cs-diff-row-info' },
                                h(
                                  'div',
                                  { className: 'dsh-au-cs-diff-row-name' },
                                  h('span', { className: 'dsh-au-cs-caret', 'aria-hidden': 'true' }, '▸'),
                                  h('span', null, row.title),
                                  h('span', { className: 'dsh-au-cs-badge-conflict' }, row.badge)
                                )
                              ),
                              h(
                                'div',
                                {
                                  className: 'dsh-au-cs-diff-bulk-btns',
                                  onClick: (e) => e.stopPropagation(),
                                },
                                h(
                                  'button',
                                  {
                                    type: 'button',
                                    className: 'dsh-au-cs-mini-btn',
                                    disabled: busy,
                                    onClick: () => handleResolveRow(row, 'push'),
                                  },
                                  '用本机'
                                ),
                                h(
                                  'button',
                                  {
                                    type: 'button',
                                    className: 'dsh-au-cs-mini-btn primary',
                                    disabled: busy,
                                    onClick: () => handleResolveRow(row, 'pull'),
                                  },
                                  '用云端'
                                )
                              )
                            ),
                            isOpen
                              ? h(
                                  'div',
                                  { className: 'dsh-au-cs-diff-compare' },
                                  h(
                                    'div',
                                    { className: 'dsh-au-cs-compare-grid' },
                                    h(
                                      'div',
                                      { className: 'dsh-au-cs-compare-col' },
                                      h(
                                        'div',
                                        { className: 'dsh-au-cs-compare-col-title' },
                                        h('span', null, `本机（${machineId || '当前设备'}）`),
                                        row.localMeta ? h('span', null, row.localMeta) : null
                                      ),
                                      row.localLines.map((line, idx) => h(
                                        'div',
                                        { key: idx, className: `dsh-au-cs-compare-line${line.tone && line.tone !== 'normal' ? ` ${line.tone}` : ''}` },
                                        line.text
                                      ))
                                    ),
                                    h(
                                      'div',
                                      { className: 'dsh-au-cs-compare-col' },
                                      h(
                                        'div',
                                        { className: 'dsh-au-cs-compare-col-title' },
                                        h('span', null, '云端（私人仓库）'),
                                        row.cloudMeta ? h('span', null, row.cloudMeta) : null
                                      ),
                                      row.cloudLines.map((line, idx) => h(
                                        'div',
                                        { key: idx, className: `dsh-au-cs-compare-line${line.tone && line.tone !== 'normal' ? ` ${line.tone}` : ''}` },
                                        line.text
                                      ))
                                    )
                                  )
                                )
                              : null
                          );
                        })
                      )
                    : null
                )
              : h(
                  'div',
                  { className: 'dsh-au-cs-status-ok', role: 'status' },
                  h(
                    'div',
                    { className: 'dsh-au-cs-status-ok-left' },
                    h('span', null, '✓'),
                    h('span', null, '已与云端保持一致')
                  ),
                  h(
                    'span',
                    { className: 'dsh-au-cs-status-ok-meta' },
                    `本机：${machineId || '未识别'}${cloudSync.lastSyncedAt ? ` · ${cloudSync.lastSyncedAt}` : ''}`
                  )
                ),
            h(
              'div',
              { className: 'dsh-au-cs-group-list' },
              // 1. DSH 官方配置（纯开关卡片，无展开箭头与明细）
              h(
                'div',
                { id: 'groupOfficial', className: 'dsh-au-cs-group-card', 'data-group': 'official' },
                h(
                  'div',
                  {
                    className: 'dsh-au-cs-group-top',
                    role: 'button',
                    tabIndex: 0,
                    onClick: toggleOfficialGroup,
                    onKeyDown: (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleOfficialGroup();
                      }
                    },
                  },
                  h(
                    'div',
                    { className: 'dsh-au-cs-group-left' },
                    h(
                      'div',
                      { className: 'dsh-au-cs-group-title-row' },
                      h('span', { className: 'dsh-au-cs-group-title' }, 'DSH 官方配置'),
                      renderModePill(selectedOfficialCount, officialGroupItems.length, false)
                    ),
                    h('div', { className: 'dsh-au-cs-group-desc no-caret' }, '字号、聊天展示、账号界面、日志上传、默认权限、子智能体、托盘与通知')
                  ),
                  h(
                    'div',
                    { className: 'dsh-au-cs-switch-hit' },
                    renderTriSwitch(allOfficialSelected, partialOfficialSelected)
                  )
                )
              ),
              // 2. 模型配置（默认折叠，展开 5 项精细行）
              h(
                'div',
                { id: 'groupModels', className: `dsh-au-cs-group-card${expandedGroups.models ? ' open' : ''}`, 'data-group': 'models' },
                h(
                  'div',
                  {
                    className: 'dsh-au-cs-group-top',
                    role: 'button',
                    tabIndex: 0,
                    'aria-expanded': expandedGroups.models,
                    onClick: () => toggleGroupOpen('models'),
                    onKeyDown: (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleGroupOpen('models');
                      }
                    },
                  },
                  h(
                    'div',
                    { className: 'dsh-au-cs-group-left' },
                    h(
                      'div',
                      { className: 'dsh-au-cs-group-title-row' },
                      h('span', { className: 'dsh-au-cs-caret', 'aria-hidden': 'true' }, '▸'),
                      h('span', { className: 'dsh-au-cs-group-title' }, '模型配置'),
                      renderModePill(selectedModelCount, modelGroupItems.length, true)
                    ),
                    h('div', { className: 'dsh-au-cs-group-desc' }, '展开可查看供应商明细、默认模型、Claude 启动器与 4 档位映射（自动拦截明文 API Key）')
                  ),
                  h(
                    'div',
                    {
                      className: 'dsh-au-cs-switch-hit',
                      role: 'switch',
                      'aria-checked': allModelSelected ? 'true' : (partialModelSelected ? 'mixed' : 'false'),
                      onClick: (e) => {
                        e.stopPropagation();
                        toggleModelGroup();
                      },
                    },
                    renderTriSwitch(allModelSelected, partialModelSelected)
                  )
                ),
                expandedGroups.models
                  ? h(
                      'div',
                      { className: 'dsh-au-cs-group-detail' },
                      availableProfileOptions.length > 0
                        ? h(
                            'div',
                            { className: 'dsh-au-cloud-sync-profile-bar', style: { marginBottom: '8px' } },
                            h('label', { htmlFor: 'dsh-au-cloud-sync-profile-select' }, '模型方案：'),
                            h(
                              'select',
                              {
                                id: 'dsh-au-cloud-sync-profile-select',
                                className: 'dsh-au-cloud-sync-select',
                                value: profile,
                                disabled: busy,
                                onChange: (e) => {
                                  const nextProfile = e.target.value;
                                  setProfile(nextProfile);
                                  triggerQuickSave({ nextProfile }, '✓ 已切换模型方案并自动同步');
                                },
                              },
                              availableProfileOptions.map(opt => h('option', { key: opt.id, value: opt.id }, opt.label || opt.id))
                            )
                          )
                        : null,
                      h(
                        'div',
                        { className: 'dsh-au-cs-model-detail-list' },
                        modelGroupItems.map(item => {
                          const isSelected = Boolean(selectedMap[item.id]);
                          return h(
                            'div',
                            {
                              key: item.id,
                              className: `dsh-au-cs-model-row dsh-au-cs-chip${isSelected ? ' selected' : ''}`,
                              role: 'checkbox',
                              'aria-checked': isSelected,
                              onClick: () => toggleModelChip(item),
                            },
                            h(
                              'div',
                              { className: 'dsh-au-cs-model-row-head' },
                              h(
                                'div',
                                { className: 'dsh-au-cs-model-row-left' },
                                h('span', { className: 'dsh-au-cs-chip-check' }, '✓'),
                                h('span', null, item.title || item.id),
                                h('span', { className: 'dsh-au-cs-chip-key' }, item.id)
                              ),
                              item.summary ? h('span', { className: 'dsh-au-cs-model-row-val' }, item.summary) : null
                            ),
                            renderDetailTags(item.detailTags)
                          );
                        })
                      )
                    )
                  : null
              ),
              // 3. 其它云插件（默认折叠，chip 多选）
              h(
                'div',
                { id: 'groupPlugins', className: `dsh-au-cs-group-card${expandedGroups.plugins ? ' open' : ''}`, 'data-group': 'plugins' },
                h(
                  'div',
                  {
                    className: 'dsh-au-cs-group-top',
                    role: 'button',
                    tabIndex: 0,
                    'aria-expanded': expandedGroups.plugins,
                    onClick: () => toggleGroupOpen('plugins'),
                    onKeyDown: (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleGroupOpen('plugins');
                      }
                    },
                  },
                  h(
                    'div',
                    { className: 'dsh-au-cs-group-left' },
                    h(
                      'div',
                      { className: 'dsh-au-cs-group-title-row' },
                      h('span', { className: 'dsh-au-cs-caret', 'aria-hidden': 'true' }, '▸'),
                      h('span', { className: 'dsh-au-cs-group-title' }, '其它云插件'),
                      renderModePill(selectedPluginCount, otherPluginList.length, true)
                    ),
                    h('div', { className: 'dsh-au-cs-group-desc' }, '展开可自由单选 / 多选要同步的插件；未选插件保留单机备份')
                  ),
                  h(
                    'div',
                    {
                      className: 'dsh-au-cs-switch-hit',
                      role: 'switch',
                      'aria-checked': allPluginsSelected ? 'true' : (partialPluginsSelected ? 'mixed' : 'false'),
                      onClick: (e) => {
                        e.stopPropagation();
                        togglePluginsGroup();
                      },
                    },
                    renderTriSwitch(allPluginsSelected, partialPluginsSelected)
                  )
                ),
                expandedGroups.plugins
                  ? h(
                      'div',
                      { className: 'dsh-au-cs-group-detail' },
                      otherPluginList.length > 0
                        ? h(
                            'div',
                            { className: 'dsh-au-cs-sub-chips' },
                            otherPluginList.map(p => {
                              const isSelected = Boolean(selectedPluginsMap[p.id]);
                              return h(
                                'div',
                                {
                                  key: p.id,
                                  className: `dsh-au-cs-chip${isSelected ? ' selected' : ''}`,
                                  role: 'checkbox',
                                  'aria-checked': isSelected,
                                  onClick: () => togglePluginChip(p),
                                },
                                h('span', { className: 'dsh-au-cs-chip-check' }, '✓'),
                                h('span', null, p.title || p.id)
                              );
                            })
                          )
                        : h('div', { className: 'dsh-au-cs-group-desc no-caret' }, '暂无其它已安装的云插件')
                    )
                  : null
              ),
              // 4. 快捷操作（默认折叠，快捷键配置 + 快捷模型配置两个独立 chip）
              h(
                'div',
                { id: 'groupShortcuts', className: `dsh-au-cs-group-card${expandedGroups.shortcuts ? ' open' : ''}`, 'data-group': 'shortcuts' },
                h(
                  'div',
                  {
                    className: 'dsh-au-cs-group-top',
                    role: 'button',
                    tabIndex: 0,
                    'aria-expanded': expandedGroups.shortcuts,
                    onClick: () => toggleGroupOpen('shortcuts'),
                    onKeyDown: (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleGroupOpen('shortcuts');
                      }
                    },
                  },
                  h(
                    'div',
                    { className: 'dsh-au-cs-group-left' },
                    h(
                      'div',
                      { className: 'dsh-au-cs-group-title-row' },
                      h('span', { className: 'dsh-au-cs-caret', 'aria-hidden': 'true' }, '▸'),
                      h('span', { className: 'dsh-au-cs-group-title' }, '快捷操作'),
                      renderModePill(selectedPrefCount, preferenceList.length, true)
                    ),
                    h('div', { className: 'dsh-au-cs-group-desc' }, '展开可分别选择「快捷键」或「快捷模型」是否云端共享')
                  ),
                  h(
                    'div',
                    {
                      className: 'dsh-au-cs-switch-hit',
                      role: 'switch',
                      'aria-checked': allPrefsSelected ? 'true' : (partialPrefsSelected ? 'mixed' : 'false'),
                      onClick: (e) => {
                        e.stopPropagation();
                        toggleShortcutsGroup();
                      },
                    },
                    renderTriSwitch(allPrefsSelected, partialPrefsSelected)
                  )
                ),
                expandedGroups.shortcuts
                  ? h(
                      'div',
                      { className: 'dsh-au-cs-group-detail' },
                      h(
                        'div',
                        { className: 'dsh-au-cs-sub-chips' },
                        preferenceList.map(p => {
                          const isSelected = Boolean(preferenceMap[p.id]);
                          return h(
                            'div',
                            {
                              key: p.id,
                              className: `dsh-au-cs-chip${isSelected ? ' selected' : ''}`,
                              role: 'checkbox',
                              'aria-checked': isSelected,
                              onClick: () => togglePreferenceChip(p),
                            },
                            h('span', { className: 'dsh-au-cs-chip-check' }, '✓'),
                            h('span', null, prefDisplayTitle(p)),
                            h('span', { className: 'dsh-au-cs-chip-key' }, p.id)
                          );
                        })
                      )
                    )
                  : null
              )
            ),
            h(
              'div',
              { className: 'dsh-au-cs-always-shared-note' },
              h('strong', null, 'dsh-au 基础开关默认全机共享：'),
              '待办、远程管理、侧边栏入口、默认完全权限、窗口记忆开关、自动续跑等 8 项改完自动同步，无需手动勾选。'
            )
          ),
          h(
            'div',
            { className: 'dsh-au-cs-footer' },
            h(
              'span',
              { className: `dsh-au-cs-toast-hint${footerToastText ? ' show' : ''}${footerToastError ? ' is-error' : ''}` },
              footerToastText || ' '
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-au-cs-btn-close-footer',
                disabled: busy,
                onClick: onClose,
              },
              '完成'
            )
          )
        )
      );
    }

    /** 云端配置自动同步区块 */
    function CloudSyncFeatureGroup() {
      const [profileOptions, setProfileOptions] = useState(DEFAULT_CLOUD_SYNC_PROFILE_OPTIONS);
      const [cloudSync, setCloudSync] = useState({
        enabled: false,
        // 默认取动态方案列表首项或 general，避免写死旧方案名
        profile: DEFAULT_CLOUD_SYNC_PROFILE_OPTIONS[0]?.id || 'general',
        selectedItems: FALLBACK_CLOUD_SYNC_ITEMS.map(i => i.id),
        customized: false,
        selectedPlugins: FALLBACK_CLOUD_SYNC_PLUGINS.map(p => p.id),
        syncPluginConfigs: FALLBACK_CLOUD_SYNC_PLUGINS.map(p => p.id),
        pluginsCustomized: false,
        selectedPreferences: [],
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
        // 消费后端顶层返回的动态方案列表
        if (Array.isArray(res.profileOptions) && res.profileOptions.length > 0) {
          setProfileOptions(res.profileOptions);
        }
        if (res.cloudSync) {
          const fallbackProfile = (Array.isArray(res.profileOptions) && res.profileOptions[0]?.id) || 'general';
          setCloudSync(prev => ({
            ...prev,
            ...res.cloudSync,
            profile: res.cloudSync.profile || prev.profile || fallbackProfile,
            firstSyncPending: Boolean(res.cloudSync.firstSyncPending),
          }));
        }
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
        // 承接快捷键 Alt+2（cloudSync.open）的打开请求：既支持设置页已打开时即时弹出，也支持刚切换到 DSH AU 页签挂载后自动弹出。
        const openFromShortcut = () => {
          try { window.__dshAuPendingOpenCloudSyncModal = false; } catch {}
          setMessage('');
          setModalOpen(true);
          void refreshSettings();
        };
        if (typeof window !== 'undefined') {
          if (window.__dshAuPendingOpenCloudSyncModal) {
            openFromShortcut();
          }
          window.addEventListener('dsh-au-open-cloud-sync-modal', openFromShortcut);
          return () => window.removeEventListener('dsh-au-open-cloud-sync-modal', openFromShortcut);
        }
        return undefined;
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

      const handleQuickSave = async ({ profile, selectedItems, selectedPlugins, syncPluginConfigs, selectedPreferences }) => {
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
          } else {
            setCloudSync(prev => ({ ...prev, profile, selectedItems, selectedPlugins, syncPluginConfigs, selectedPreferences }));
          }
          if (cloudSync.enabled) {
            const syncRes = await callApi('runCloudSyncNow', {
              profile,
              selectedItems,
              selectedPlugins,
              syncPluginConfigs,
              selectedPreferences,
            });
            if (syncRes?.ok) {
              applyCloudSyncResponse(syncRes);
              if (syncRes.restartRequired !== undefined) {
                setCloudSync(prev => ({ ...prev, restartRequired: Boolean(syncRes.restartRequired) }));
              }
              void loadFeatures();
              if (typeof loadModelShortcuts === 'function') void loadModelShortcuts();
              setMessage(syncRes.message || '已保存并自动触发同步');
            } else {
              setMessage(syncRes?.error || '已保存设置，自动同步未完成');
            }
          } else {
            setMessage('已保存同步设置');
          }
        } catch {
          setMessage('保存失败');
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

      const handleResolveConflict = async ({ kind, id, direction, profile }) => {
        setBusy(true);
        setMessage('');
        try {
          const clientPreferences = {
            mobileEnabled: readMobileFeatureEnabled(),
            shortcutOverrides: readShortcutOverrides(),
          };
          const action = direction === 'push' ? 'pushCloudSyncToRepo' : 'runCloudSyncNow';
          const payload = { profile, clientPreferences };
          if (kind === 'official') {
            payload.singleItemOnly = true;
            payload.itemId = id;
          } else if (kind === 'plugin') {
            payload.singlePluginOnly = true;
            payload.pluginId = id;
          } else if (kind === 'preference') {
            payload.singlePreferenceOnly = true;
            payload.preferenceId = id;
          } else if (kind === 'dshau') {
            payload.dshAuPrefsOnly = true;
          }
          const res = await callApi(action, payload);
          if (res?.ok) {
            applyCloudSyncResponse(res);
            if (direction === 'pull') {
              void loadFeatures();
              if (typeof loadModelShortcuts === 'function') void loadModelShortcuts();
            }
            setMessage(res.message || (direction === 'push' ? '已用本机覆盖云端' : '已用云端覆盖本机'));
            return { ok: true, skipped: Boolean(res.skipped), message: res.message || '' };
          } else {
            const err = res?.error || '处理冲突失败';
            setMessage(err);
            return { ok: false, skipped: false, error: err };
          }
        } catch {
          setMessage('处理冲突异常');
          return { ok: false, skipped: false, error: '处理冲突异常' };
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
            setMessage(res.message || (direction === 'push' ? `已将 ${pluginId} 本地状态推送到云` : `已将 ${pluginId} 从云同步到本地`));
            return { ok: true, skipped: Boolean(res.skipped), message: res.message || '' };
          } else {
            const err = res?.error || '单插件同步失败';
            setMessage(err);
            return { ok: false, skipped: false, error: err };
          }
        } catch {
          setMessage('单插件同步异常');
          return { ok: false, skipped: false, error: '单插件同步异常' };
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
      const activeProfile = cloudSync.profile || (profileOptions[0]?.id || 'general');
      const allItems = (itemsByProfile && Array.isArray(itemsByProfile[activeProfile]) && itemsByProfile[activeProfile].length > 0)
        ? itemsByProfile[activeProfile]
        : (items && items.length > 0 ? items : FALLBACK_CLOUD_SYNC_ITEMS);
      const allPluginItems = Array.isArray(pluginItems) ? pluginItems : FALLBACK_CLOUD_SYNC_PLUGINS;
      const resolvedPreferenceItems = resolvePreferenceSyncItems(preferenceItems, shortcutOverrides, modelShortcutSnapshot);
      // 首次拉取确认框里展示的覆盖项数：只算会被本次拉取写入的不一致项。
      const firstSyncDiffCount = allItems.filter(item => item.inSync === false && (cloudSync.selectedItems || []).includes(item.id)).length
        + allPluginItems.filter(item => item.inSync === false && (cloudSync.selectedPlugins || []).includes(item.id)).length
        + resolvedPreferenceItems.filter(item => item.inSync === false && (cloudSync.selectedPreferences || []).includes(item.id)).length;
      const selectedItemSet = new Set(cloudSync.selectedItems || []);
      const selectedPluginSet = new Set(cloudSync.selectedPlugins || []);
      const selectedPreferenceSet = new Set(cloudSync.selectedPreferences || []);
      const selectedCount = selectedItemSet.size;
      const selectedPluginCount = selectedPluginSet.size;
      const selectedPreferenceCount = selectedPreferenceSet.size;
      // 外层「待同步」计数仅统计已勾选参与同步的项（含固定同步的 dsh-au），避免未勾选项干扰提示
      const totalDiffCount = loaded
        ? allItems.filter(i => selectedItemSet.has(i.id) && i.inSync === false).length
          + allPluginItems.filter(p => (p.id === FIXED_SYNC_PLUGIN_ID || selectedPluginSet.has(p.id)) && p.inSync === false).length
          + resolvedPreferenceItems.filter(p => selectedPreferenceSet.has(p.id) && p.inSync === false).length
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
          profileOptions,
          items: allItems,
          itemsByProfile,
          pluginItems: allPluginItems,
          preferenceItems: resolvedPreferenceItems,
          shortcutOverrides,
          modelShortcutSnapshot,
          machineId,
          onQuickSave: handleQuickSave,
          onSave: handleSaveModal,
          onSaveAndSync: handleSaveAndSyncModal,
          onPushToRepo: handlePushToRepo,
          onResolveConflict: handleResolveConflict,
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
            description: `控制本机是否在左侧边栏加载「${ext.title}」扩展（${ext.id}）。关闭后立即卸载且不再轮询，仅作单机备份保存，不会云端共享到其他电脑。`,
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

