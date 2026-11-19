/**
 * 工作台渲染函数：菜单卡、服务卡、插件卡、中心区、参数区与右侧检查器。
 * 每个函数从 scope 取自己需要的组件状态与处理函数，等价于原来闭包在 UnifiedWorkbenchModal 内部。
 */
    /**
     * 比较菜单预览时把开头的 pwsh / powershell 当成同一命令。
     * 后端找不到 pwsh 会回退 powershell，前端若写死 pwsh 会导致右侧结果被清空。
     */
    const isSameMenuPreview = (savedPreview, expectedPreview) => {
      const normalize = (text) => String(text || '').replace(/^(pwsh|powershell)\b/i, 'pwsh');
      return Boolean(savedPreview) && normalize(savedPreview) === normalize(expectedPreview);
    };

    const renderStyledLogLine = (scope, l, idx) => {

      const text = String(l?.text || '');
      const trimmed = text.trim();
      const secMatch = /^===\s*(.+?)\s*===$/.exec(trimmed) || /^\[(\d+)\]\s+(.+)$/.exec(trimmed);
      if (secMatch) {
        const title = secMatch[2] ? `[${secMatch[1]}] ${secMatch[2]}` : secMatch[1];
        return h('div', { key: idx, className: 'dsh-au-log-sec' }, `▸ ${title}`);
      }
      if (trimmed.startsWith('[完成]') || trimmed.startsWith('[OK]') || (trimmed.startsWith('[执行结束]') && trimmed.includes('退出码: 0'))) {
        return h('div', { key: idx, className: 'dsh-au-log-done' }, `✓ ${trimmed}`);
      }
      if (l?.type === 'prompt' || trimmed.startsWith('查询失败') || trimmed.startsWith('[!]') || (trimmed.startsWith('[执行结束]') && !trimmed.includes('退出码: 0'))) {
        return h('div', { key: idx, className: 'dsh-au-log-err' }, trimmed);
      }
      return h('div', { key: idx, style: { color: l.type === 'cmd' ? '#10b981' : '#e2e8f0', fontWeight: l.type === 'cmd' ? 700 : 400 } }, text);
    };

    const renderMenuCard = (scope, it, groupTitle) => {
      const { selectedCode, setSelectedCode, favorites, toggleFavorite, runMenu, isWin } = scope;

      const isFav = favorites.includes(it.code);
      const direct = canDirectRunMenu(it, isWin ? 'win32' : 'darwin');
      return h(
        'div',
        {
          key: it.code,
          className: `dsh-au-wb-card ${selectedCode === it.code ? 'selected' : ''}`,
          onClick: () => setSelectedCode(it.code),
          onDoubleClick: () => {
            setSelectedCode(it.code);
            if (direct) void runMenu(it.code);
          },
        },
        h('div', { className: 'dsh-au-card-head' }, [
          h('span', { key: 'id', className: 'dsh-au-card-id' }, groupTitle ? `#${it.code} · ${groupTitle}` : `#${it.code}`),
          h('button', {
            key: 'fav', type: 'button', className: 'dsh-au-card-btn',
            'data-tone': isFav ? 'on' : undefined,
            onClick: (e) => toggleFavorite(it.code, e),
          }, isFav ? '★ 已收藏' : '☆ 收藏'),
        ]),
        h('div', { className: 'dsh-au-card-title' }, it.label),
        h('div', { className: 'dsh-au-card-desc' }, it.description)
      );
    };

    /** 服务接入来自 machines 绑定；开关仅来自 local/state.json，不再回退旧本机配置。 */
    const resolveServiceState = (svc, localBindingServiceIds, cloudServiceIds, isCloudTab) => {
      const connected = localBindingServiceIds.includes(svc.id);
      const state = svc.localState || {};
      // 登记只决定列表归属；启用必须读取真实开关，不能把“已登记”伪装成“已启用”。
      const enabled = connected && state.enabled === true;
      return {
        cloudManaged: isCloudTab || cloudServiceIds.includes(svc.id),
        connectedOnHost: connected,
        enabledOnHost: enabled,
        bootOn: enabled && state.autoStartOnBoot === true,
        dshOn: enabled && state.autoStartOnDsh === true,
      };
    };

    /**
     * 运行状态标签。冷启动骨架里 running 是未知（null），
     * 这时要显示"检测中"而不是"已停止"，否则会被当成服务挂了。
     */
    const runningChip = (svc, suffix = '') => {
      if (svc.running === null || svc.running === undefined) {
        return { tone: 'blue', text: `◌ 检测中${suffix}` };
      }
      return {
        tone: svc.running ? 'emerald' : 'amber',
        text: `${svc.running ? '● 运行中' : '○ 已停止'}${suffix}`,
      };
    };

    const renderServiceCard = (scope, svc) => {
      const { selectedServiceId, setSelectedServiceId, busySvcId, savingServiceFlag, isCloudServiceTab, localBindingServiceIds, cloudServiceIds, selectedAiServiceIds, toggleAiServiceSelection, toggleServiceFlag, toggleCloudServiceOnCurrentMachine, promoteServiceToCloud } = scope;

      // AI 同步的选择只活在当前弹窗，绝不能复用会写入本机绑定的「接入」状态。
      const aiSelected = isCloudServiceTab && selectedAiServiceIds.includes(svc.id);
      // 没接入本机就不显示自启勾选，避免出现"没接入却显示随 DSH 自启"。
      const { cloudManaged, connectedOnHost, enabledOnHost, bootOn, dshOn } = resolveServiceState(svc, localBindingServiceIds, cloudServiceIds, isCloudServiceTab);
      const selected = cloudManaged && connectedOnHost;
      const systemBoot = svc.systemBoot?.managed ? svc.systemBoot : null;
      const bootActive = bootOn;
      const endpoint = svc.port ? `:${svc.port}` : (svc.drive || '');
      const syncSaving = busySvcId === svc.id || savingServiceFlag?.id === svc.id;
      const syncLabel = isCloudServiceTab
        ? (selected ? '取消接入' : '同步到本机')
        : (!cloudManaged ? '同步到云' : (selected ? '取消接入' : '接入云同步'));
      const onSyncClick = () => {
        if (isCloudServiceTab || cloudManaged) void toggleCloudServiceOnCurrentMachine(svc.id);
        else void promoteServiceToCloud(svc);
      };
      return h('div', {
        key: svc.id,
        className: `dsh-au-wb-card ${selectedServiceId === svc.id ? 'selected' : ''}`,
        style: { opacity: enabledOnHost || !isCloudServiceTab ? 1 : 0.76 },
        onClick: () => setSelectedServiceId(svc.id),
      }, [
        h('div', { key: 'head', className: 'dsh-au-card-head' }, [
          h('span', { key: 'id', className: 'dsh-au-card-id' }, `${svc.id}${endpoint ? ` ${endpoint}` : ''}`),
          h('span', { key: 'run', className: 'dsh-au-chip', 'data-tone': runningChip(svc).tone }, runningChip(svc).text),
        ]),
        h('div', { key: 'title', className: 'dsh-au-card-title' }, svc.name),
        // 卡片上直接说明为何不能启停，不必点进详情才发现按钮置灰。
        svc.canControl === false && svc.control !== 'view'
          ? h('div', { key: 'noctl', className: 'dsh-au-card-desc', 'data-tone': 'err', title: svc.controlReason || '' }, `仅可查看：${svc.controlReason || '当前平台不可控制'}`)
          : null,
        h('div', { key: 'desc', className: 'dsh-au-card-desc' }, svc.description || (svc.scriptPath ? `脚本 ${svc.scriptName || ''}` : svc.guard)),
        h('div', { key: 'foot', className: 'dsh-au-card-foot', onClick: (event) => event.stopPropagation() }, [
          h('button', {
            key: 'boot', type: 'button', className: 'dsh-au-card-btn', 'data-tone': bootActive ? 'on' : undefined,
            disabled: !connectedOnHost || syncSaving,
            title: systemBoot ? `${systemBoot.serviceName}（${systemBoot.mode}）：点击切换开机自启` : (connectedOnHost ? (enabledOnHost ? '' : '点击将自动开启本机启用并设置开机自启') : '请先将服务接入本机，再设置自启'),
            onClick: () => toggleServiceFlag(svc.id, 'autoStartOnBoot'),
          }, systemBoot
            ? (bootActive ? '✓ 系统自启' : '系统自启')
            : (bootOn ? '✓ 开机自启' : '开机自启')),
          h('button', {
            key: 'dsh', type: 'button', className: 'dsh-au-card-btn', 'data-tone': dshOn ? 'on' : undefined,
            disabled: !connectedOnHost || syncSaving,
            title: connectedOnHost ? (enabledOnHost ? '' : '点击将自动开启本机启用并设置随 DSH 自启') : '请先将服务接入本机，再设置自启',
            onClick: () => toggleServiceFlag(svc.id, 'autoStartOnDsh'),
          }, dshOn ? '✓ 随DSH' : '随DSH'),
          // 仅在云服务页提供临时选择；不触发「同步到当前电脑」的写入逻辑。
          isCloudServiceTab ? h('button', {
            key: 'ai-select', type: 'button', className: 'dsh-au-card-btn', 'data-tone': aiSelected ? 'on' : undefined,
            onClick: () => toggleAiServiceSelection(svc.id),
          }, aiSelected ? '✓ AI 已选' : '选择 AI同步') : null,
          h('button', {
            key: 'sync', type: 'button', className: 'dsh-au-card-btn',
            'data-tone': selected ? 'danger' : undefined,
            disabled: syncSaving,
            onClick: onSyncClick,
          }, syncSaving ? '处理中…' : syncLabel),
        ]),
      ]);
    };

    /**
     * 插件的展示口径：两枚状态 chip + 唯一动作。
     * 「启用」和「接入云同步」本来是一件事的两面——接入本机就包含启用，
     * 所以不再各写一行：状态归状态（chips），动作归动作（一个按钮）。
     * 启停改的是 profile，需要重启 DSH，这里只给文字，不给假开关。
     */
    const pluginStateView = (state) => {
      const enableChip = !state.installed
        ? { tone: 'muted', text: '未安装' }
        : (!state.enabledKnown
          ? null
          : (state.enabled ? { tone: 'emerald', text: '启用中' } : { tone: 'muted', text: '未启用' }));
      const cloudChip = state.selected
        ? { tone: 'blue', text: '已接入云同步' }
        : (state.cloudManaged ? { tone: 'blue', text: '云插件' } : { tone: 'amber', text: '仅本机' });
      const action = !state.cloudManaged
        ? 'promote'
        : (state.selected && state.installed ? 'unlink' : 'link');
      return {
        chips: [enableChip, cloudChip].filter(Boolean),
        action,
        actionLabel: { promote: '同步到云', link: '接入本机', unlink: '取消接入本机' }[action],
        removable: state.cloudManaged,
      };
    };

    /** 动作的影响范围：和按钮成对出现，避免两个「移除」被当成同一件事。 */
    const pluginActionHints = {
      promote: '其他电脑才可选到',
      link: '安装并启用 · 重启 DSH 后生效',
      unlink: '仅这台电脑 · 停用不卸载 · 配置不跟随云',
    };

    const pluginStateChips = (states, key, className = 'dsh-au-card-status') => h(
      'div',
      { key, className },
      states.map((state, index) => h('span', {
        key: `${state.text}-${index}`, className: 'dsh-au-chip', 'data-tone': state.tone,
      }, state.text))
    );

    /**
     * 自研标签：只标 DSH-Au 仓库自己的插件，社区插件保持原样。
     * 单独一枚紫色 chip，一眼能和「已接入云同步 / 仅本机」这类状态标签区分开。
     */
    const pluginOwnBadge = (plugin) => (isOwnDshPlugin(plugin) ? h('span', {
      key: 'own', className: 'dsh-au-chip dsh-au-chip-own', 'data-tone': 'violet',
      title: 'DSH-Au 团队自研插件，非社区插件',
    }, '自研') : null);

    const renderPluginCard = (scope, plugin) => {
      const { setSelectedPluginId, dshPlugins, localDshPlugins, isCloudPluginTab, currentMachinePluginIds, selectedPlugin } = scope;

      const state = resolvePluginCardState(plugin, {
        dshPlugins, localDshPlugins, currentMachinePluginIds, isCloudPluginTab,
      });
      const view = pluginStateView(state);
      const description = plugin.description || state.localEntry?.description || '';
      const meta = `v${plugin.version || '0.0.0'}${plugin.name && plugin.name !== plugin.package ? ` · ${plugin.package}` : ''}`;
      return h('div', {
        key: plugin.id,
        className: `dsh-au-wb-card ${selectedPlugin?.id === plugin.id ? 'selected' : ''}`,
        onClick: () => setSelectedPluginId(plugin.id),
      }, [
        h('div', { key: 'head', className: 'dsh-au-card-head' }, [
          h('div', { key: 'title-row', className: 'dsh-au-card-title-row' }, [
            h('span', { key: 'title', className: 'dsh-au-card-title' }, plugin.name),
            pluginOwnBadge(plugin),
          ]),
        ]),
        h('div', { key: 'meta', className: 'dsh-au-card-ver' }, meta),
        description ? h('div', { key: 'desc', className: 'dsh-au-card-desc' }, description) : null,
        pluginStateChips(view.chips, 'status'),
      ]);
    };

    /**
     * 云备份卡：一台电脑一份本机绑定，随仓库提交。
     * 这里只切换本机指针，不复制也不合并任何内容，两台电脑才不会互相覆盖。
     */
    const renderBackupCard = (scope, backup) => {
      const { busyMachineId, switchLocalBinding } = scope;
      const label = backup.displayName || backup.machineId;
      const meta = backup.updatedAt
        ? `更新于 ${backup.updatedAt.slice(0, 16).replace('T', ' ')}`
        : '未记录更新时间';
      const state = backup.broken
        ? { tone: 'amber', text: '文件损坏' }
        : backup.active
          ? { tone: 'emerald', text: '✓ 当前使用' }
          : backup.currentHost
            ? { tone: 'blue', text: '本机主机名匹配' }
            : { tone: 'muted', text: '其他电脑' };
      const busy = busyMachineId === backup.machineId;
      return h('div', {
        key: backup.machineId,
        className: `dsh-au-wb-card ${backup.active ? 'selected' : ''}`,
      }, [
        h('div', { key: 'head', className: 'dsh-au-card-head' }, [
          h('span', { key: 'id', className: 'dsh-au-card-id' }, backup.machineId),
          h('span', { key: 'state', className: 'dsh-au-chip', 'data-tone': state.tone }, state.text),
        ]),
        h('div', { key: 'title', className: 'dsh-au-card-title' }, label),
        h('div', { key: 'desc', className: 'dsh-au-card-desc' }, `${backup.serviceCount} 个服务 · 收藏 ${backup.favoriteCount} 项 · 插件 ${backup.pluginCount || 0} 个 · ${meta}`),
        // 正在使用的卡不再出按钮：状态已由右上角「✓ 当前使用」说清楚，按钮只留给可切换的备份。
        backup.active ? null : h('div', { key: 'foot', className: 'dsh-au-card-foot' }, [
          h('button', {
            key: 'switch', type: 'button', className: 'dsh-au-card-btn',
            disabled: busy || backup.broken,
            title: backup.broken ? '文件内容无法解析，先修好再切换' : '',
            onClick: () => void switchLocalBinding(backup.machineId),
          }, busy ? '切换中…' : '切换使用'),
        ]),
      ]);
    };

    const renderCenterContent = (scope) => {
      const { wb, activeTab, renderActiveExtensionCenter, setPluginView, setServiceView, serviceNotice, groups, services, favorites, dshPlugins, localDshPlugins, isCloudPluginTab, isCloudServiceTab, isBackupServiceTab, localBinding, machineBackups, localBindingServiceIds, serviceView, currentHostKey, currentMachinePluginIds, activePluginList, localServices, cloudServices, visibleServices, runningCount, selectedAiServiceIds, aiSyncPromptVisible, aiSyncPrompt, aiSyncPromptCopied, showAiSyncPrompt, copyAiSyncPrompt, setAiSyncPromptVisible, pluginSaving, pluginNotice, pluginNoticeOwner, selectedPlugin, pluginRestorePreview, setPluginRestorePreview, previewRestorePlugins, confirmRestorePlugins, runPluginDoctor, q, matchMenu, matchService } = scope;
      if (typeof activeTab === 'string' && activeTab.startsWith('ext:')) return renderActiveExtensionCenter();
      const menuUnconfigured = wb?.menuSpec?.configured === false;
      const isMenuTab = activeTab === 'fav' || activeTab === 'all' || groups.some((g) => g.id === activeTab);
      if (isMenuTab && menuUnconfigured) {
        return h('section', { className: 'dsh-au-quota-shell', role: 'status' }, [
          h('strong', { key: 'title' }, '未配置私人同步仓库'),
          h('span', { key: 'text', style: { color: '#fbbf24', fontSize: '15px' } }, wb?.menuSpec?.message || '未配置私人同步仓库 (syncRepoRoot)'),
        ]);
      }

      if (activeTab === 'plugins') {
        const visible = activePluginList.filter((plugin) => !q
          || plugin.id.toLocaleLowerCase().includes(q)
          || plugin.name.toLocaleLowerCase().includes(q)
          || plugin.package.toLocaleLowerCase().includes(q));
        const batchNotice = (pluginNoticeOwner === '__batch__' || !selectedPlugin) ? pluginNotice : '';
        const formatPreviewList = (items = []) => items.map((item) => item.name || item.package || item.id).join('、');
        return h(React.Fragment, null, [
          h('div', { key: 'tabs', style: { display: 'flex', gap: '7px', paddingBottom: '3px', borderBottom: '1px solid #1f2637', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' } }, [
            h('div', { key: 'view-pills', style: { display: 'flex', gap: '7px' } }, [
              h('button', { key: 'local', type: 'button', className: `dsh-au-wb-pill ${!isCloudPluginTab ? 'sel' : ''}`, onClick: () => setPluginView('local') }, `本机插件 ${localDshPlugins.length}`),
              h('button', { key: 'cloud', type: 'button', className: `dsh-au-wb-pill ${isCloudPluginTab ? 'sel' : ''}`, onClick: () => setPluginView('cloud') }, `云插件 ${dshPlugins.length}`),
            ]),
            // 仅保留从云端公共清单还原到本地的入口；插件上云统一在单个插件详情里手动执行，避免批量自动污染云清单。
            h('div', { key: 'batch-actions', style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, [
              h('button', { key: 'plugin-doctor', type: 'button', className: 'dsh-au-wb-pill', disabled: pluginSaving,
                title: '只检查运行时、实际版本与快照，不安装插件、不修改本机配置',
                onClick: () => void runPluginDoctor() }, '只读体检'),
              h('button', {
                key: 'restore-preview',
                type: 'button',
                className: 'dsh-au-wb-pill on',
                disabled: pluginSaving,
                title: '对比云端插件清单与本机 DSH Profile 的差异，确认后从云端一键还原到本地',
                onClick: () => void previewRestorePlugins(),
              }, pluginSaving ? '处理中…' : '一键还原到本地'),
            ]),
          ]),
          h('section', { key: 'notice', className: 'dsh-au-quota-shell' }, [
            h('strong', { key: 'title' }, isCloudPluginTab ? `云插件 · 当前电脑已接入 ${currentMachinePluginIds.length}/${dshPlugins.length} 项` : `本机插件 · 已识别 ${localDshPlugins.length} 项`),
            h('span', { key: 'text', style: { color: batchNotice ? '#34d399' : '#94a3b8', fontSize: '15px' } }, batchNotice || (isCloudPluginTab
              ? '选中插件后在详情面板操作；也可点击右上角「一键还原到本地」从云端一键恢复全部云插件与配置。'
              : '选中插件后在详情面板操作；同步到云后其他电脑才可选。')),
          ]),
          pluginRestorePreview ? h('section', { key: 'restore-preview-box', className: 'dsh-au-quota-shell', style: { borderColor: '#3b82f6' } }, [
            h('strong', { key: 'title' }, `还原前差异预览 · 来源：${pluginRestorePreview.machineId || '云端插件清单'}`),
            h('div', { key: 'summary', style: { color: '#cbd5e1', fontSize: '14px', lineHeight: 1.6 } }, [
              h('div', { key: 'install' }, `待安装 (${pluginRestorePreview.toInstall.length})：${formatPreviewList(pluginRestorePreview.toInstall) || '无'}`),
              h('div', { key: 'enable' }, `待启用 (${pluginRestorePreview.toEnable.length})：${formatPreviewList(pluginRestorePreview.toEnable) || '无'}`),
              h('div', { key: 'config' }, `配置更新 (${pluginRestorePreview.toUpdateConfig.length})：${formatPreviewList(pluginRestorePreview.toUpdateConfig) || '无'}`),
              h('div', { key: 'unchanged' }, `已就绪 (${pluginRestorePreview.unchanged.length})：${formatPreviewList(pluginRestorePreview.unchanged) || '无'}`),
              pluginRestorePreview.bundleOrderChanged ? h('div', { key: 'order', style: { color: '#38bdf8' } }, '加载顺序：将按备份记录的 bundles 顺序重新对齐') : null,
            ].filter(Boolean)),
            h('div', { key: 'actions', className: 'dsh-au-act' }, [
              h('button', {
                key: 'confirm',
                type: 'button',
                className: 'dsh-au-btn on',
                disabled: pluginSaving,
                onClick: () => void confirmRestorePlugins(pluginRestorePreview.machineId),
              }, pluginSaving ? '正在还原…' : '确认从云端还原到本地'),
              h('button', {
                key: 'cancel',
                type: 'button',
                className: 'dsh-au-btn',
                disabled: pluginSaving,
                onClick: () => setPluginRestorePreview(null),
              }, '收起预览'),
            ]),
          ]) : null,
          visible.length ? h('div', { key: 'grid', className: 'dsh-au-wb-grid' }, visible.map((plugin) => renderPluginCard(scope, plugin))) : h('div', { key: 'empty', className: 'dsh-au-remote-empty' }, '没有匹配的插件。'),
        ]);
      }
      if (activeTab === 'services') {
        const serviceSortRank = (service) => {
          if (service.running) return 0;
          return localBindingServiceIds.includes(service.id) ? 1 : 2;
        };
        const filtered = visibleServices
          .filter((s) => matchService(s))
          .sort((a, b) => serviceSortRank(a) - serviceSortRank(b));
        // 「已接入」只数当前机器绑定 JSON 里登记的云服务。
        const connectedCloudCount = cloudServices.filter((s) => localBindingServiceIds.includes(s.id)).length;
        // 绑定文件的短形式（machines/<id>.json）：整条相对路径会把标题一行撑爆。
        const bindingLabel = localBinding?.file ? localBinding.file.split('/').slice(-2).join('/') : '';
        // file 是按主机名推导的预期路径；只有 exists 才能称为“已绑定”。
        const hasLocalBinding = localBinding?.exists === true;
        return h(React.Fragment, null, [
          h('div', { key: 'tabs', style: { display: 'flex', gap: '7px', paddingBottom: '3px', borderBottom: '1px solid #1f2637' } }, [
            h('button', { key: 'local', type: 'button', className: `dsh-au-wb-pill ${serviceView === 'local' ? 'sel' : ''}`, onClick: () => setServiceView('local') }, `本机服务 ${localServices.length}`),
            // 第三层：云备份。定义在云服务，本机事实在云备份，当前用哪份由本机指针决定。
            h('button', { key: 'backup', type: 'button', className: `dsh-au-wb-pill ${isBackupServiceTab ? 'sel' : ''}`, onClick: () => setServiceView('backup') }, `云备份 ${machineBackups.length}`),
            h('button', { key: 'cloud', type: 'button', className: `dsh-au-wb-pill ${isCloudServiceTab ? 'sel' : ''}`, onClick: () => setServiceView('cloud') }, `云服务 ${cloudServices.length}`),
          ]),
          h('section', { key: 'notice', className: 'dsh-au-quota-shell' }, [
            h('strong', { key: 'title' }, isBackupServiceTab
              ? `云备份 · 共 ${machineBackups.length} 份`
              : (isCloudServiceTab ? `云服务 · 当前电脑已接入 ${connectedCloudCount}/${cloudServices.length} 项` : `本机服务 · 运行中 ${runningCount}/${localServices.length} 项`)),
            h('span', { key: 'text', style: { color: '#94a3b8', fontSize: '15px' } }, serviceNotice?.text || (isBackupServiceTab
              ? (hasLocalBinding
                ? `当前使用：${bindingLabel} · 备份随仓库提交；切换只改本机指针，不动任何一份备份内容。`
                : `当前电脑尚未生成本机绑定（预期文件：${bindingLabel || 'sync/machines/<machineId>.json'}）；保存本机绑定后会写入该文件。`)
              : isCloudServiceTab
                ? '“选择 AI同步”只在当前弹窗勾选服务；生成 Prompt 不会写入本机或云端配置。'
                : (hasLocalBinding
                  ? `当前电脑: ${currentHostKey} · 绑定 ${bindingLabel}；取消接入只影响当前电脑，关闭 DSH 绝不停止服务。`
                  : `当前电脑: ${currentHostKey} · 未生成本机绑定（预期文件：${bindingLabel || 'sync/machines/<machineId>.json'}）；服务仅在登记 JSON 中出现。`))),
          ]),
          // AI 同步只产出可复制的执行提示词；这里没有任何 API 写入或服务控制调用。
          isCloudServiceTab ? h('section', { key: 'ai-sync', className: 'dsh-au-quota-shell' }, [
            h('strong', { key: 'title' }, `AI同步 · 已勾选 ${selectedAiServiceIds.length} 项`),
            h('div', { key: 'actions', className: 'dsh-au-act' }, [
              h('button', {
                key: 'generate', type: 'button', className: 'dsh-au-btn on',
                disabled: selectedAiServiceIds.length === 0,
                onClick: showAiSyncPrompt,
              }, '生成 Prompt'),
              aiSyncPromptVisible ? h('button', {
                key: 'hide', type: 'button', className: 'dsh-au-btn',
                onClick: () => setAiSyncPromptVisible(false),
              }, '收起') : null,
            ].filter(Boolean)),
            aiSyncPromptVisible ? h('div', { key: 'prompt', className: 'dsh-au-act-block' }, [
              h('textarea', {
                key: 'text', className: 'dsh-au-input', readOnly: true, value: aiSyncPrompt,
                'aria-label': 'AI 同步 Prompt', style: { minHeight: '168px', resize: 'vertical', fontFamily: 'Consolas,monospace', fontSize: '11.5px', lineHeight: 1.55 },
              }),
              h('button', { key: 'copy', type: 'button', className: 'dsh-au-btn primary', onClick: () => void copyAiSyncPrompt() }, aiSyncPromptCopied ? '✓ 已复制' : '复制 Prompt'),
            ]) : null,
          ]) : null,
          isBackupServiceTab
            ? (machineBackups.length
              ? h('div', { key: 'grid', className: 'dsh-au-wb-grid' }, machineBackups.map((backup) => renderBackupCard(scope, backup)))
              : h('div', { key: 'empty', className: 'dsh-au-remote-empty' }, '还没有云备份：保存一次本机绑定就会生成 sync/machines/<machineId>.json。'))
            : (filtered.length ? h('div', { key: 'grid', className: 'dsh-au-wb-grid' }, filtered.map((svc) => renderServiceCard(scope, svc))) : h('div', { key: 'empty', className: 'dsh-au-remote-empty' },
              isCloudServiceTab ? '没有匹配的云服务。' : '本机当前没有可显示的服务（未接入本机的目录项不占位）。')),
        ]);
      }
      if (activeTab === 'fav') {
        const favCards = [];
        for (const g of groups) {
          for (const it of g.items || []) {
            if (favorites.includes(it.code) && matchMenu(it)) favCards.push(renderMenuCard(scope, it, g.title));
          }
        }
        return h('div', { className: 'dsh-au-wb-grid' }, favCards);
      }
      const visibleGroups = activeTab === 'all' ? groups : groups.filter((g) => g.id === activeTab);
      return visibleGroups.map((g) => {
        const items = (g.items || []).filter(matchMenu);
        if (items.length === 0) return null;
        return h(
          'div',
          { key: g.id, style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          h('div', { style: { fontWeight: 600, fontSize: '12.5px', color: '#94a3b8', borderBottom: '1px solid #1f2637', paddingBottom: '4px' } }, `${g.title} (${items.length})`),
          h('div', { className: 'dsh-au-wb-grid' }, items.map((it) => renderMenuCard(scope, it, '')))
        );
      });
    };

    const renderParamOptions = (scope) => {
      const { menuParamValues, setMenuParamValues, isWin, selectedMenu } = scope;
      if (!selectedMenu) return null;
      const platformOs = isWin ? 'win32' : 'darwin';
      const params = visibleMenuParams(selectedMenu, platformOs);
      if (!params.length) return null;
      const setParam = (name, value) => setMenuParamValues((prev) => ({ ...(prev || {}), [name]: value }));
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        params.map((param) => {
          const value = resolveMenuParamValue(param, menuParamValues || {}, platformOs);
          const options = menuParamOptions(param, platformOs);
          const label = h('div', { key: 'label', style: { fontSize: '12px', color: '#94a3b8', fontWeight: 600 } }, param.label || param.name);
          if (param.type === 'text') {
            return h('div', { key: param.name, style: { display: 'flex', flexDirection: 'column', gap: '5px' } }, [
              label,
              h('input', {
                key: 'input',
                className: 'dsh-au-input',
                placeholder: param.placeholder || '',
                value: value == null ? '' : String(value),
                onChange: (e) => setParam(param.name, e.target.value),
              }),
            ]);
          }
          if (param.type === 'boolean') {
            const on = isMenuParamTrue(value);
            return h('button', {
              key: param.name,
              type: 'button',
              className: `dsh-au-wb-pill ${on ? 'sel' : ''}`,
              style: { padding: '5px 8px' },
              onClick: () => setParam(param.name, !on),
            }, param.label || param.name);
          }
          if (param.type === 'multiselect') {
            const selected = Array.isArray(value) ? value : [];
            return h('div', { key: param.name, style: { display: 'flex', flexDirection: 'column', gap: '5px', maxHeight: '140px', overflowY: 'auto' } }, [
              label,
              ...options.map((opt) => {
                const checked = selected.includes(opt.value);
                return h('button', {
                  key: String(opt.value),
                  type: 'button',
                  className: `dsh-au-wb-pill ${checked ? 'sel' : ''}`,
                  style: { justifyContent: 'space-between', padding: '5px 8px' },
                  onClick: () => setParam(param.name, checked ? selected.filter((x) => x !== opt.value) : [...selected, opt.value]),
                }, opt.label || String(opt.value));
              }),
            ]);
          }
          return h('div', { key: param.name, style: { display: 'flex', flexDirection: 'column', gap: '5px' } }, [
            label,
            ...options.map((opt) => h('button', {
              key: String(opt.value),
              type: 'button',
              className: `dsh-au-wb-pill ${value === opt.value ? 'sel' : ''}`,
              style: { padding: '5px 8px' },
              onClick: () => setParam(param.name, opt.value),
            }, opt.label || String(opt.value))),
          ]);
        })
      );
    };

    const renderDebugDetails = (scope, { preview = '', scriptPath = '', configPath = '', cacheDir = '', logs = [], onClearLogs = null, emptyText = '当前没有可显示的原始日志。' }) => {
      const { copiedLog, debugExpanded, setDebugExpanded, copyLogs } = scope;

      return h(
        'section',
        { style: { marginTop: 'auto', borderTop: '1px solid #1f2637', paddingTop: '10px' } },
        h(
          'button',
          {
            type: 'button',
            className: `dsh-au-wb-pill ${debugExpanded ? 'sel' : ''}`,
            style: { width: '100%', justifyContent: 'space-between', padding: '8px 10px' },
            'aria-expanded': debugExpanded,
            onClick: () => setDebugExpanded((expanded) => !expanded),
          },
          h('span', null, '🔧 调试详情（执行命令与原始日志）'),
          h('span', null, debugExpanded ? '收起' : '展开')
        ),
        debugExpanded ? h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '10px' } },
          preview ? h('div', { style: { padding: '10px 12px', borderRadius: '6px', background: '#0b0d12', border: '1px solid #1f2637', fontFamily: 'Consolas,monospace', fontSize: '15.5px', color: '#10b981', wordBreak: 'break-all' } }, preview) : null,
          scriptPath ? h('div', { style: { fontSize: '14.5px', fontFamily: 'Consolas,monospace', color: '#94a3b8', wordBreak: 'break-all' } }, `脚本路径: ${scriptPath}`) : null,
          configPath ? h('div', { style: { fontSize: '14.5px', fontFamily: 'Consolas,monospace', color: '#64748b', wordBreak: 'break-all' } }, `配置路径: ${configPath}`) : null,
          cacheDir ? h('div', { style: { fontSize: '14.5px', fontFamily: 'Consolas,monospace', color: '#64748b', wordBreak: 'break-all' } }, `缓存目录: ${cacheDir}`) : null,
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            h('span', { style: { fontSize: '15.5px', color: '#94a3b8', fontWeight: 600 } }, '原始输出日志'),
            h(
              'div',
              { style: { display: 'flex', gap: '6px' } },
              h('button', { type: 'button', className: `dsh-au-wb-pill ${copiedLog ? 'on' : ''}`, disabled: logs.length === 0, onClick: () => copyLogs(logs) }, copiedLog ? '✓ 已复制' : '📋 复制日志'),
              onClearLogs ? h('button', { type: 'button', className: 'dsh-au-wb-pill', disabled: logs.length === 0, onClick: onClearLogs }, '清空日志') : null
            )
          ),
          h(
            'div',
            { className: 'dsh-au-wb-term' },
            logs.length > 0 ? logs.map((l, idx) => renderStyledLogLine(scope, l, idx)) : h('div', { style: { color: '#64748b' } }, emptyText)
          )
        ) : null
      );
    };

    const renderInspector = (scope) => {
      const { wb, activeTab, renderActiveExtensionInspector, pluginSaving, pluginNotice, pluginNoticeOwner, scrcpyDevice, setScrcpyDevice, stdinText, setStdinText, busySvcId, pendingDeleteSvc, pendingDeletePlugin, removePluginFromCloud, serviceNotice, services, dshPlugins, localDshPlugins, isCloudPluginTab, isCloudServiceTab, isBackupServiceTab, localBinding, machineBackups, localBindingServiceIds, currentHostKey, currentMachinePluginIds, selectedPlugin, cloudServiceIds, buildPreviewText, runMenu, openTerminal, clearLogs, sendStdin, toggleServiceFlag, toggleCloudServiceOnCurrentMachine, promoteServiceToCloud, removeServiceFromCloud, handleServiceControl, toggleCloudPluginOnCurrentMachine, promotePluginToCloud, syncCloudPluginToCurrentMachine, selectedMenu, selectedSvc } = scope;

      if (typeof activeTab === 'string' && activeTab.startsWith('ext:')) return renderActiveExtensionInspector();

      if (activeTab === 'plugins' && selectedPlugin) {
        const state = resolvePluginCardState(selectedPlugin, {
          dshPlugins, localDshPlugins, currentMachinePluginIds, isCloudPluginTab,
        });
        const { cloudPlugin, cloudManaged, cloudPluginId, installed, selected } = state;
        const view = pluginStateView(state);
        const description = selectedPlugin.description || state.localEntry?.description || '';
        const meta = `v${selectedPlugin.version || '0.0.0'}${selectedPlugin.name !== selectedPlugin.package ? ` · ${selectedPlugin.package}` : ''}`;
        // 这里只留「操作结果」和确实要解释的个例：状态已经由 chips 说完，不再用一段话复述。
        const notice = (pluginNoticeOwner === cloudPluginId ? pluginNotice : '') || (cloudPlugin?.id === 'dsh-acp-adapter'
          ? 'Cursor ACP 接入插件：用于把 Cursor Agent 接入 DSH。'
          : '');
        // 分支与改造前完全一致：本机未纳管=提升到云；云插件按「已接入这里/只读云清单」分流。
        const onAction = () => {
          if (!cloudManaged) void promotePluginToCloud(selectedPlugin);
          else if (selected && installed) void toggleCloudPluginOnCurrentMachine(cloudPluginId);
          else if (isCloudPluginTab) void syncCloudPluginToCurrentMachine(cloudPluginId);
          else void toggleCloudPluginOnCurrentMachine(cloudPluginId);
        };
        return h(React.Fragment, null, [
          h('div', { key: 'head', className: 'dsh-au-insp-head' }, [
            h('span', { key: 'name', className: 'dsh-au-insp-name', title: selectedPlugin.name }, selectedPlugin.name),
            pluginOwnBadge(selectedPlugin),
          ]),
          h('div', { key: 'meta', className: 'dsh-au-insp-id' }, meta),
          ...(description ? [h('div', { key: 'desc', className: 'dsh-au-insp-desc' }, description)] : []),
          pluginStateChips(view.chips, 'status', 'dsh-au-chips'),
          // 针对已接入云且本机已安装的插件：提供配置双向同步能力
          (state.cloudManaged && installed) ? h('div', { key: 'config-sync', className: 'dsh-au-act-block' }, [
            h('div', { className: 'dsh-au-act' }, [
              h('button', {
                type: 'button', className: 'dsh-au-btn on',
                disabled: pluginSaving,
                title: '将本机该插件的配置规则推送到仓库云端快照',
                onClick: () => void promotePluginToCloud(selectedPlugin),
              }, pluginSaving ? '正在处理…' : '推送到云端配置'),
              h('button', {
                type: 'button', className: 'dsh-au-btn',
                disabled: pluginSaving,
                title: '从仓库云端快照读取配置并覆盖本机，需重启 DSH 生效',
                onClick: () => void syncCloudPluginToCurrentMachine(cloudPluginId),
              }, pluginSaving ? '正在处理…' : '从云覆盖本地'),
            ]),
            h('div', { className: 'dsh-au-act-hint' }, '两端配置不一致时：可推送到云更新快照，或拉取云端覆盖本机'),
          ]) : null,
          // 按钮只说「做什么」，下面一行说「影响谁」：两个删除动作的范围不同，靠这行区分。
          h('div', { key: 'action', className: 'dsh-au-act-block' }, [
            h('button', {
              type: 'button', className: `dsh-au-btn ${view.action === 'unlink' ? 'off' : 'on'}`,
              disabled: pluginSaving,
              onClick: onAction,
            }, pluginSaving ? '正在处理…' : view.actionLabel),
            h('div', { className: 'dsh-au-act-hint' }, pluginActionHints[view.action] || ''),
          ]),
          // 从云清单删除：连同仓库里的配置快照目录一起清掉，本机安装与运行不受影响。
          view.removable ? h('div', { key: 'remove', className: 'dsh-au-act-block' }, [
            h('button', {
              type: 'button', className: 'dsh-au-link', 'data-tone': 'danger',
              disabled: pluginSaving,
              onClick: () => void removePluginFromCloud(cloudPluginId),
            }, pendingDeletePlugin === cloudPluginId ? '确认删除云清单与仓库快照？' : '从云清单移除'),
            h('div', { className: 'dsh-au-act-hint' }, pendingDeletePlugin === cloudPluginId
              ? '再点一次：会删掉云清单与仓库快照'
              : '所有电脑都看不到 · 不影响本机'),
          ]) : null,
          notice ? h('div', { key: 'note', className: 'dsh-au-note' }, notice) : null,
        ]);
      }
      // 云备份页不针对单个服务：右侧只交代「当前用的是哪一份、切换会改什么」。
      if (activeTab === 'services' && isBackupServiceTab) {
        const active = machineBackups.find((item) => item.active) || null;
        return h(React.Fragment, null, [
          h('div', { key: 'head', className: 'dsh-au-insp-head' }, [
            h('span', { key: 'name', className: 'dsh-au-insp-name', title: active?.displayName || '' }, active?.displayName || '云备份'),
          ]),
          h('div', { key: 'meta', className: 'dsh-au-insp-id' }, active?.machineId || '未生成'),
          h('div', { key: 'desc', className: 'dsh-au-insp-desc' }, active
            ? `${active.serviceCount} 个服务 · 收藏 ${active.favoriteCount} 项`
            : '还没有可用的云备份'),
          h('div', { key: 'plugins', className: 'dsh-au-insp-desc' }, active?.plugins?.length
            ? `插件：${active.plugins.join('、')}`
            : '插件：未记录'),
          h('div', { key: 'note', className: 'dsh-au-note' },
            `文件 ${localBinding?.file || '未生成'}，随仓库提交；切换只改本机 local/active.json 指针，不改任何备份内容。`),
        ]);
      }
      if (activeTab === 'services' && selectedSvc) {
        const startOnly = selectedSvc.control === 'start-only';
        // 只在 JSON 里定义、还没接入启停的服务：按钮置灰，别让人点了报错。
        const viewOnly = selectedSvc.control === 'view';
        // 与卡片同源：优先读本机绑定 JSON 里的状态。
        const { cloudManaged, connectedOnHost, enabledOnHost, bootOn, dshOn } = resolveServiceState(selectedSvc, localBindingServiceIds, cloudServiceIds, isCloudServiceTab);
        const busy = busySvcId === selectedSvc.id;
        const flagSaving = scope.savingServiceFlag?.id === selectedSvc.id;
        const systemBoot = selectedSvc.systemBoot?.managed ? selectedSvc.systemBoot : null;
        // 后端按平台真实能力给出 canControl；缺字段（旧后端）按可控处理。
        const cannotControl = selectedSvc.canControl === false;
        const controlReason = selectedSvc.controlReason || '当前服务仅支持查看状态';
        const noControl = viewOnly || cannotControl;
        // 服务日志按服务 ID 隔离，切换其它服务时绝不复用上一项输出。
        const logs = wb?.serviceLogsById?.[selectedSvc.id] || [];
        const workerNames = (selectedSvc.instances || []).map((item) => item.name).filter(Boolean);
        const portSuffix = selectedSvc.port ? ` · :${selectedSvc.port}` : '';
        // 启停进行中且看板还没起来时显示检测中，别让人误以为已停止。
        const runChip = busy && !selectedSvc.running
          ? { tone: 'blue', text: `◌ 检测中${portSuffix}` }
          : runningChip(selectedSvc, portSuffix);
        const activeNotice = serviceNotice?.id === selectedSvc.id ? serviceNotice : null;
        const syncLabel = isCloudServiceTab
          ? (enabledOnHost ? '取消接入此电脑' : '同步到当前电脑')
          : (!cloudManaged ? '同步到云' : (enabledOnHost ? '取消接入此电脑' : '接入云同步'));
        const onSyncClick = () => {
          if (isCloudServiceTab || cloudManaged) void toggleCloudServiceOnCurrentMachine(selectedSvc.id);
          else void promoteServiceToCloud(selectedSvc);
        };
        const flagRow = (label, on, onClick, disabled = false, title = '', valueText = null) => h(
          'button',
          {
            type: 'button', className: 'dsh-au-kv', onClick, disabled,
            title: title || (disabled ? '先在本机启用该服务，才能设置自启' : ''),
            style: disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined,
          },
          h('span', null, label),
          h('span', { className: 'dsh-au-kv-val' },
            h('span', { className: 'dsh-au-dot', style: { background: on ? '#34d399' : '#475569' } }),
            valueText ?? (on ? '开启' : '关闭'))
        );
        return h(
          React.Fragment,
          null,
          h('div', { className: 'dsh-au-insp-head' },
            h('span', { className: 'dsh-au-insp-name' }, selectedSvc.name)),
          // 中文描述优先；已绑定本机的服务不再回落到目录提示，未绑定的才显示。
          selectedSvc.description
            ? h('div', { className: 'dsh-au-insp-desc' }, selectedSvc.description)
            : (selectedSvc.scriptPath ? null : h('div', { className: 'dsh-au-insp-desc' }, selectedSvc.guard)),
          h('div', { className: 'dsh-au-chips' }, [
            h('span', { key: 'run', className: 'dsh-au-chip', 'data-tone': runChip.tone }, runChip.text),
            enabledOnHost ? h('span', { key: 'en', className: 'dsh-au-chip', 'data-tone': 'blue' }, '本机已启用')
              : (connectedOnHost ? h('span', { key: 'registered', className: 'dsh-au-chip' }, '已注册 · 未启用') : null),
            startOnly ? h('span', { key: 'so', className: 'dsh-au-chip' }, '仅可启动') : null,
            workerNames.length ? h('span', { key: 'wk', className: 'dsh-au-chip' }, workerNames.join(' · ')) : null,
          ].filter(Boolean)),
          cannotControl && !viewOnly ? h('div', { className: 'dsh-au-note', 'data-tone': 'err' }, `仅支持查看：${controlReason}`) : null,
          selectedSvc.needsDevice
            ? h('input', { className: 'dsh-au-input', placeholder: 'Android 设备序列号 (-s <device>)', value: scrcpyDevice, onChange: (e) => setScrcpyDevice(e.target.value) })
            : null,
          h('div', { className: 'dsh-au-act' }, [
            h('button', { key: 'start', type: 'button', className: 'dsh-au-btn on', disabled: busy || noControl, title: viewOnly ? '该服务只写在 JSON 里，尚未接入启停' : (cannotControl ? controlReason : undefined), onClick: () => handleServiceControl(selectedSvc.id, 'start') }, busy ? '处理中…' : '启动'),
            h('button', { key: 'restart', type: 'button', className: 'dsh-au-btn', disabled: startOnly || busy || noControl, title: viewOnly ? '该服务只写在 JSON 里，尚未接入启停' : (cannotControl ? controlReason : undefined), onClick: () => handleServiceControl(selectedSvc.id, 'restart') }, '重启'),
            h('button', { key: 'stop', type: 'button', className: 'dsh-au-btn off', disabled: startOnly || busy || noControl, title: viewOnly ? '该服务只写在 JSON 里，尚未接入启停' : (cannotControl ? controlReason : undefined), onClick: () => handleServiceControl(selectedSvc.id, 'stop') }, '停止'),
          ]),
          // 脚本路径单独成行，排法和下面的开关行一致：小标签在上，值在下。
          selectedSvc.scriptPath
            ? h('div', { className: 'dsh-au-insp-files' }, [
              h('div', { key: 'label', className: 'dsh-au-insp-file-label' }, '脚本路径'),
              h('div', { key: 'path', className: 'dsh-au-insp-file', title: selectedSvc.scriptPath }, selectedSvc.scriptPathShort || selectedSvc.scriptPath),
            ])
            : null,
          h('div', null, [
            flagRow(`本机启用（${currentHostKey}）`, enabledOnHost, () => toggleServiceFlag(selectedSvc.id, 'enabled'), !connectedOnHost || busy || flagSaving, busy || flagSaving ? '正在处理，请等待保存完成' : (!connectedOnHost ? '请先将服务接入本机' : '')),
            systemBoot
              ? flagRow('系统开机自启', bootOn, () => toggleServiceFlag(selectedSvc.id, 'autoStartOnBoot'), !connectedOnHost || busy || flagSaving, !connectedOnHost ? '请先将服务接入本机，才能设置自启' : `${systemBoot.serviceName}（${systemBoot.mode}）：点击切换开机自启`)
              : flagRow('开机自启动', bootOn, () => toggleServiceFlag(selectedSvc.id, 'autoStartOnBoot'), !connectedOnHost || busy || flagSaving, !connectedOnHost ? '请先将服务接入本机，才能设置自启' : (!enabledOnHost ? '开启时将自动联动开启本机启用' : '')),
            flagRow('随 DSH 自启动', dshOn, () => toggleServiceFlag(selectedSvc.id, 'autoStartOnDsh'), !connectedOnHost || busy || flagSaving, !connectedOnHost ? '请先将服务接入本机，才能设置自启' : (!enabledOnHost ? '开启时将自动联动开启本机启用' : '')),
          ]),
          systemBoot ? h('div', { className: 'dsh-au-note' }, `${systemBoot.serviceName} · Windows 服务当前启动模式：${systemBoot.mode}`) : null,
          // 云同步接入与本机启用分开：停用已登记的服务不删除绑定。
          cloudManaged && connectedOnHost ? null : h('button', {
            type: 'button',
            className: 'dsh-au-link',
            disabled: busy,
            onClick: onSyncClick,
          }, syncLabel),
          cloudManaged ? h('button', {
            type: 'button',
            className: 'dsh-au-link',
            'data-tone': 'danger',
            disabled: busy,
            onClick: () => void removeServiceFromCloud(selectedSvc.id),
          }, pendingDeleteSvc === selectedSvc.id ? '确认从云清单删除？（本机不受影响）' : '从云清单删除') : null,
          activeNotice
            ? h('div', { className: 'dsh-au-note', 'data-tone': activeNotice.tone || '', role: activeNotice.tone === 'err' ? 'alert' : 'status', 'aria-live': 'polite' }, [
              activeNotice.tone === 'busy' ? h('span', { key: 'spin', className: 'dsh-au-svc-spinner', 'aria-hidden': true }) : null,
              h('span', { key: 'text' }, activeNotice.text),
            ])
            : null,
          renderDebugDetails(scope, { scriptPath: selectedSvc.scriptPath, configPath: selectedSvc.configPath, cacheDir: selectedSvc.cacheDir, logs, emptyText: busy ? '正在等待启动输出…' : '当前没有可显示的原始日志。' })
        );
      }

      if (!selectedMenu) return null;
      const expectedPreview = buildPreviewText(selectedMenu);
      const savedPreview = wb?.runner?.previewByCode?.[selectedMenu.code] || '';
      // 归一化后再比：powershell 与 pwsh 只是本机回退差异，不能因此丢掉运行结果。
      const hasCurrentMenuRun = isSameMenuPreview(savedPreview, expectedPreview);
      // 同一菜单改参数后，旧运行记录与当前预览不一致，不能再显示为本次结果。
      const logs = hasCurrentMenuRun
        ? sliceLatestRunLogs(wb?.runner?.logsByCode?.[selectedMenu.code] || [])
        : [];
      const isSelectedMenuRunning = Boolean(wb?.runner?.running && wb?.runner?.activeCode === selectedMenu.code);
      const childInputGuide = isSelectedMenuRunning ? getChildInputGuide(selectedMenu, logs) : null;
      const quotaSections = parseQuotaSections(logs, selectedMenu);
      return h(
        React.Fragment,
        null,
        h('div', { className: 'dsh-au-insp-head' },
          h('span', { className: 'dsh-au-insp-name' }, selectedMenu.label),
          h('span', { className: 'dsh-au-insp-id' }, `#${selectedMenu.code}`)),
        h('div', { className: 'dsh-au-insp-desc' }, selectedMenu.description),
        renderParamOptions(scope),
        h('div', { className: 'dsh-au-act' },
          h('button', { type: 'button', className: 'dsh-au-btn on', onClick: () => runMenu(selectedMenu.code) }, selectedMenu.readonly ? '查询额度' : '在插件内执行'),
          h('button', { type: 'button', className: 'dsh-au-btn', onClick: () => openTerminal(selectedMenu.code) }, '系统终端')),
        quotaSections.length > 0
          ? h(
              'div',
              { className: 'dsh-au-quota-shell' },
              quotaSections.map((sec, sIdx) => h(
                'div',
                { key: sIdx, className: 'dsh-au-quota-card' },
                h(
                  'div',
                  { className: 'dsh-au-quota-head' },
                  h('span', null, sec.title),
                  h('span', { className: 'dsh-au-tone-badge', 'data-tone': sec.statusTone || 'emerald', style: { flex: '0 0 auto' } }, sec.status || '● 在线')
                ),
                sec.kind === 'summary'
                  ? h(
                      'div',
                      { className: 'dsh-au-result-grid' },
                      sec.rows.map((r, rIdx) => h(
                        'div',
                        { key: rIdx, className: 'dsh-au-result-tile' },
                        h('span', { className: 'dsh-au-tile-label' }, r.label),
                        h('span', { className: 'dsh-au-tile-value', 'data-tone': r.tone || 'emerald' }, r.value),
                        h('span', { className: 'dsh-au-tile-badge' }, r.badge || '')
                      ))
                    )
                  : sec.rows.map((r, rIdx) => h(
                      'div',
                      { key: rIdx, className: 'dsh-au-quota-row' },
                      h('span', null, r.label),
                      h('span', { style: { color: r.tone === 'rose' ? '#f87171' : r.tone === 'amber' ? '#fbbf24' : r.tone === 'blue' ? '#93c5fd' : '#34d399' } }, r.value)
                    ))
              ))
            )
          : isSelectedMenuRunning ? h(
              'div',
              { className: 'dsh-au-quota-shell' },
              h(
                'div',
                { className: 'dsh-au-quota-card' },
                h(
                  'div',
                  { className: 'dsh-au-quota-head' },
                  h('span', null, '执行状态'),
                  h('span', { className: 'dsh-au-tone-badge', 'data-tone': 'blue' }, '● 正在运行')
                ),
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: '9px', color: '#cbd5e1', fontSize: '13.5px', fontWeight: 500, lineHeight: 1.4 } },
                  h('div', { className: 'dsh-au-spinner', style: { width: '15px', height: '15px', flex: '0 0 auto' } }),
                  h('span', { style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, '正在执行，等待结果…')
                )
              )
            )
            : null,
        childInputGuide ? h(
          'section',
          { style: { display: 'flex', flexDirection: 'column', gap: '7px', padding: '10px', borderRadius: '8px', border: '1px solid rgba(59,130,246,.46)', background: 'rgba(59,130,246,.10)' } },
          h('div', { style: { fontSize: '15px', color: '#dbeafe', fontWeight: 600 } }, `⌨ ${childInputGuide.text}`),
          h(
            'div',
            { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
            childInputGuide.quick.map(([label, value]) => h('button', { key: `${label}:${value}`, type: 'button', className: 'dsh-au-wb-pill sel', onClick: () => void sendStdin(value) }, label))
          ),
          h(
            'div',
            { style: { display: 'flex', gap: '6px' } },
            h('input', { className: 'dsh-au-input', style: { fontSize: '16.5px', padding: '9px 12px' }, placeholder: '也可以输入其它确认内容或选项序号…', value: stdinText, onChange: (e) => setStdinText(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') void sendStdin(); } }),
            h('button', { type: 'button', className: 'dsh-au-btn primary', style: { fontSize: '16.5px', padding: '9px 14px' }, onClick: () => void sendStdin() }, '发送')
          )
        ) : null,
        renderDebugDetails(scope, { preview: expectedPreview, logs, onClearLogs: () => clearLogs(selectedMenu.code) })
      );
    };

