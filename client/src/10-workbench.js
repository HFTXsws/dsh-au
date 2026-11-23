    /**
     * 工作台弹窗记忆缓存：关闭弹窗后保留上次的菜单、插件、后台服务与本机绑定快照，
     * 并由顶栏状态轮询与启动预热提前填充，保证任何时候点开弹窗都 0 毫秒直出完整内容。
     */
    function compilePrivateExtension(clientScript) {
      if (typeof clientScript !== 'string' || !clientScript.trim()) return null;
      try {
        const factory = new Function('React', 'h', clientScript);
        const mod = factory(React, h);
        if (typeof mod === 'function') return { useExtension: mod };
        return mod && typeof mod.useExtension === 'function' ? mod : null;
      } catch (err) {
        return {
          useExtension: () => ({
            badge: '!',
            renderCenter: () => h('div', { className: 'dsh-au-wb-empty' }, `扩展加载失败: ${err?.message || err}`),
            renderInspector: () => null,
          }),
        };
      }
    }

    function PrivateExtensionRunner({ ext, active, parentSeq, runtimesRef, onExtUpdate }) {
      const compiled = useMemo(() => compilePrivateExtension(ext?.clientScript), [ext?.clientScript]);
      const callExt = useCallback(
        (subAction, payload = {}) => callApi('extAction', { extId: ext.id, subAction, payload }),
        [ext.id]
      );
      const runtime = compiled ? compiled.useExtension({ id: ext.id, title: ext.title, active, callExt }) : null;
      runtimesRef.current[ext.id] = runtime;
      const lastParentSeqRef = useRef(-1);
      useEffect(() => {
        if (lastParentSeqRef.current !== parentSeq) {
          lastParentSeqRef.current = parentSeq;
          return;
        }
        onExtUpdate();
      });
      useEffect(() => () => { delete runtimesRef.current[ext.id]; }, [ext.id, runtimesRef]);
      return null;
    }

    let cachedWorkbenchSnapshot = null;

    function seedWorkbenchSnapshotFromState(snap) {
      if (!snap || !snap.ok) return;
      cachedWorkbenchSnapshot = {
        ...(cachedWorkbenchSnapshot || {}),
        ok: true,
        selfHostname: snap.self?.hostname || cachedWorkbenchSnapshot?.selfHostname,
        platformOs: snap.self?.platformOs || cachedWorkbenchSnapshot?.platformOs,
        menuFavorites: snap.menuFavorites || cachedWorkbenchSnapshot?.menuFavorites,
        machineServiceProfiles: snap.machineServiceProfiles || cachedWorkbenchSnapshot?.machineServiceProfiles,
        currentMachineProfile: snap.currentMachineProfile || cachedWorkbenchSnapshot?.currentMachineProfile,
        cloudServiceIds: snap.cloudServiceIds || cachedWorkbenchSnapshot?.cloudServiceIds,
        dshPlugins: snap.dshPlugins || cachedWorkbenchSnapshot?.dshPlugins,
        localDshPlugins: snap.localDshPlugins || cachedWorkbenchSnapshot?.localDshPlugins,
        machineDshPluginProfiles: snap.machineDshPluginProfiles || cachedWorkbenchSnapshot?.machineDshPluginProfiles,
        currentMachineDshPluginIds: snap.currentMachineDshPluginIds || cachedWorkbenchSnapshot?.currentMachineDshPluginIds,
        localBinding: snap.localBinding || cachedWorkbenchSnapshot?.localBinding,
        privateExtensions: snap.privateExtensions || cachedWorkbenchSnapshot?.privateExtensions,
      };
    }

    /**
     * 统一菜单与独立后台服务管理工作台弹窗：
     * 1. 自动识别当前系统 (win32 / darwin)，联动菜单 71/21/62 与 .ps1/.sh 命令预览；
     * 2. 纳管 16 项独立后台服务（不随 DSH 关闭而退出），支持按电脑独立组合、开机自启与随 DSH 自启。
     */
    function UnifiedWorkbenchModal({ initialTab = 'fav', onClose, embedded = false }) {
      const [wb, setWbState] = useState(cachedWorkbenchSnapshot);
      const setWb = useCallback((updater) => {
        setWbState((prev) => {
          const next = typeof updater === 'function' ? updater(prev) : updater;
          if (next) cachedWorkbenchSnapshot = next;
          return next;
        });
      }, []);
      const [activeTab, setActiveTab] = useState(initialTab || 'fav');
      const [search, setSearch] = useState('');
      const [osOverride, setOsOverride] = useState('');
      const [selectedCode, setSelectedCode] = useState('11');
      const [selectedServiceId, setSelectedServiceId] = useState('dsh_bridge');
       const [selectedPluginId, setSelectedPluginId] = useState('');
       const [pluginView, setPluginView] = useState('local');
       const [serviceView, setServiceView] = useState('local');
       const [pluginSaving, setPluginSaving] = useState(false);
       const [pluginNotice, setPluginNotice] = useState(readPluginNotice);
        const [pluginNoticeOwner, setPluginNoticeOwner] = useState(readPluginNoticeOwner);
       const showPluginNotice = (text, pluginId) => {
          persistPluginNoticeOwner(pluginId || '');
          setPluginNoticeOwner(pluginId || '');
         persistPluginNotice(text);
         setPluginNotice(text);
       };
      const [menuParamValues, setMenuParamValues] = useState({});
      // 默认方案改为 general，加载后端动态方案后再自动对齐
      const [dshProfile, setDshProfile] = useState('general');
      const [scrcpyDevice, setScrcpyDevice] = useState('');
      const [stdinText, setStdinText] = useState('');
      const [busySvcId, setBusySvcId] = useState('');
      /** 正在切换的云备份 id：只用来禁用那一张卡的按钮，不锁整个面板。 */
      const [busyMachineId, setBusyMachineId] = useState('');
      const [pendingDeleteSvc, setPendingDeleteSvc] = useState('');
      const [pendingDeletePlugin, setPendingDeletePlugin] = useState('');
      const [serviceNotice, setServiceNotice] = useState(null);
      const [copiedLog, setCopiedLog] = useState(false);
      const [debugExpanded, setDebugExpanded] = useState(false);
      // Older polling responses must not overwrite a confirmed control response.
      const refreshRevisionRef = useRef(0);
      const serviceControlEpochRef = useRef(0);
       // 临时 AI 选择不写入任意同步 JSON；关闭工作台自然清空。
       const [selectedAiServiceIds, setSelectedAiServiceIds] = useState([]);
       const [aiSyncPromptVisible, setAiSyncPromptVisible] = useState(false);
       const [aiSyncPromptCopied, setAiSyncPromptCopied] = useState(false);
      const [savingServiceFlag, setSavingServiceFlag] = useState(null);
      const [pluginRestorePreview, setPluginRestorePreview] = useState(null);
      const serviceFlagPendingRef = useRef(false);
      const extRuntimesRef = useRef({});
      const parentExtSeqRef = useRef(0);
      parentExtSeqRef.current += 1;
      const [, setExtRenderTick] = useState(0);
      const triggerExtRender = useCallback(() => setExtRenderTick((n) => n + 1), []);
      const privateExtensions = (Array.isArray(wb?.privateExtensions) ? wb.privateExtensions : [])
        .filter((ext) => !Array.isArray(ext?.surfaces) || ext.surfaces.includes('workbench'));

      const refreshWorkbench = useCallback(async (force = false) => {
        const refreshRevision = ++refreshRevisionRef.current;
        const controlEpoch = serviceControlEpochRef.current;
        try {
          const data = await callApi('getMenuWorkbench', { force });
          if (data?.ok) {
            setWb((prev) => {
              // A stale poll cannot roll a service back after a newer control result.
              if (refreshRevision !== refreshRevisionRef.current || controlEpoch !== serviceControlEpochRef.current) return prev;
              const incomingById = data.serviceLogsById || {};
              const prevById = prev?.serviceLogsById || {};
              const mergedById = { ...prevById };
              for (const [id, logs] of Object.entries(incomingById)) {
                mergedById[id] = Array.isArray(logs) && logs.length > 0 ? logs : (prevById[id] || logs || []);
              }
              return { ...data, serviceLogsById: mergedById };
            });
            return data;
          }
        } catch {}
        return null;
      }, [setWb]);

      /** 手动点击弹窗顶部「刷新」按钮时，才强制重新检查所有后台服务运行状态。 */
      const handleManualRefresh = useCallback(async () => {
        if (busySvcId) return;
        setBusySvcId('__refresh__');
        try {
          await refreshWorkbench(true);
        } finally {
          setBusySvcId((curr) => (curr === '__refresh__' ? '' : curr));
        }
      }, [busySvcId, refreshWorkbench]);

      useEffect(() => {
        // 打开弹窗默认只读取 1 小时内的缓存快照，不再每次打开都发起 force=true 强制探测；
        // 仅当冷启动首屏服务仍处于待检测（running === null）时，才补一次后台探测。
        void (async () => {
          const snap = await refreshWorkbench(false);
          if (Array.isArray(snap?.services) && snap.services.some((svc) => svc?.running === null)) {
            void refreshWorkbench(true);
          }
        })();
        // 同步自己时页面可能被重载；清掉进行中标记并保留已写入的结果。
        if (readPluginSyncing()) {
          persistPluginSyncing(false);
          const text = readPluginNotice() || '同步已提交；已刷新当前电脑状态。';
          persistPluginNotice(text);
          setPluginNotice(text);
        }
      }, [refreshWorkbench]);

      useEffect(() => {
        if (activeTab === 'services') setDebugExpanded(true);
      }, [activeTab]);

      useEffect(() => {
        if (!wb?.runner?.running && (!busySvcId || busySvcId === '__refresh__')) return undefined;
        // 服务控制可能要等待进程探测；持续刷新让命令与失败原因即时进入检查器。
        const timer = setInterval(() => { void refreshWorkbench(false); }, busySvcId ? 800 : 1200);
        return () => clearInterval(timer);
      }, [wb?.runner?.running, busySvcId, refreshWorkbench]);

      const platformOs = osOverride || wb?.platformOs || 'win32';
      const isWin = platformOs === 'win32';
      const groups = wb?.menuSpec?.groups || [];
      const totalMenuItems = groups.reduce((sum, g) => sum + (g.items || []).length, 0);
      const services = wb?.services || [];
      const favorites = Array.isArray(wb?.menuFavorites) ? wb.menuFavorites : [];
      const machineProfiles = wb?.machineServiceProfiles || {};
       const dshPlugins = wb?.dshPlugins || [];
       const localDshPlugins = wb?.localDshPlugins || [];
       const machineDshPluginProfiles = wb?.machineDshPluginProfiles || {};
       const isCloudPluginTab = pluginView === 'cloud';
       const isCloudServiceTab = serviceView === 'cloud';
       // 第三层：云备份。只列 sync/machines/ 里已有的机器绑定，用来确认「我现在用的是哪一份」。
       const isBackupServiceTab = serviceView === 'backup';
       const localBinding = wb?.localBinding || null;
       const machineBackups = Array.isArray(localBinding?.machines) ? localBinding.machines : [];
        // 本机接入只认当前 machines/<machineId>.json 的 services 键，旧配置名单不参与。
        const localBindingServiceIds = Array.isArray(localBinding?.serviceIds) ? localBinding.serviceIds : [];
      const currentHostKey = wb?.selfHostname || 'this-machine';
       const pluginTargetHostKey = wb?.selfHostname || currentHostKey;
       const currentMachinePluginIds = Array.isArray(wb?.currentMachineDshPluginIds)
         ? wb.currentMachineDshPluginIds
         : (Object.entries(machineDshPluginProfiles)
           .find(([machine]) => matchPluginHost(machine, pluginTargetHostKey))?.[1] || []);
       // 排序先于选中：默认选中的插件就是列表第一张卡，避免出现「高亮卡在列表中间」。
       const activePluginList = sortPluginsByState(isCloudPluginTab ? dshPlugins : localDshPlugins, {
         dshPlugins, localDshPlugins, currentMachinePluginIds, isCloudPluginTab,
       });
       const selectedPlugin = activePluginList.find((plugin) => plugin.id === selectedPluginId) || activePluginList[0] || null;

      const currentProfile = wb?.currentMachineProfile || Object.entries(machineProfiles).find(([machine]) => matchPluginHost(machine, currentHostKey))?.[1] || {
        enabled: [],
        autoStartOnBoot: [],
        autoStartOnDsh: []
      };
      const currentEnabled = currentProfile.enabled || [];
      const cloudServiceIds = Array.isArray(wb?.cloudServiceIds) ? wb.cloudServiceIds : [];
      // 本机服务 = 当前 machines/<machineId>.json 登记的服务（已停止也保留，便于重新启动）；
      // 云服务 = 云清单定义。旧本机配置名单与运行中探测都不再决定本机列表。
      const localServices = services.filter((svc) => localBindingServiceIds.includes(svc.id));

      const cloudServices = services.filter((svc) => cloudServiceIds.includes(svc.id));
       // 只从云清单服务取已勾选项，杜绝把本机服务误带进 AI 同步任务。
       const selectedAiServices = cloudServices.filter((svc) => selectedAiServiceIds.includes(svc.id));
       const actualPlatform = wb?.platformOs || 'unknown';
       const platformLabel = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[actualPlatform] || actualPlatform;
       const bindingSummary = localBinding?.exists
         ? `${localBinding.file || 'sync/machines/<machineId>.json'}（已生成）`
         : '尚未生成本机绑定';
       // Prompt 只使用已展示的云服务定义和本机标识，不携带任何凭据或隐私配置值。
       const aiSyncPrompt = selectedAiServices.length ? [
         `任务：安全接入以下云服务到当前电脑（${platformLabel} / ${currentHostKey}）。`,
         `当前本机绑定：${bindingSummary}。`,
         '先阅读 dsh-au/sync/README.md，并严格遵守其四层真相和同步边界。',
         '服务：',
         ...selectedAiServices.map((svc) => `- ${svc.id}（${svc.name}）：doc=${svc.doc || '未提供'}；脚本=${svc.scriptPath || '未提供'}；健康检查=${svc.health || (svc.port ? `端口 ${svc.port}` : '未提供')}；当前${localBindingServiceIds.includes(svc.id) ? '已接入' : '未接入'}。`),
         '先核对本机路径、依赖、启动方式和健康地址；已接入项只验证，不重复写入。',
         '不得读取、输出或写入 password、token、secret、api_key、cookie 等凭据。',
         '遇到安装、覆盖现有配置、路径缺失、启动/停止服务或任何不确定项，先说明影响并向用户给出选项；确认后再继续。',
       ].join('\n') : '';
      const visibleServices = isCloudServiceTab ? cloudServices : localServices;

      const findMenuItem = (code) => {
        for (const g of groups) {
          for (const it of g.items || []) {
            if (it.code === code) return { item: it, groupTitle: g.title };
          }
        }
        return null;
      };

      const buildParamsFor = (item) => collectMenuParams(item, menuParamValues, platformOs);

      const buildPreviewText = (item) => {
        if (!item) return '';
        const scriptRef = item.resolvedScript || (item.runner === 'platform'
          ? `scripts/${item.script}${isWin ? '.ps1' : '.sh'}`
          : `scripts/${item.script}`);
        // 与后端 preview 对齐：本机没有 pwsh 时 menuSpec.psCommandName 为 powershell。
        const psName = wb?.menuSpec?.psCommandName || 'pwsh';
        const base = item.runner === 'node'
          ? `node ${scriptRef}`
          : item.runner === 'python'
            ? `${isWin ? 'python' : 'python3'} ${scriptRef}`
            : isWin
              ? `${psName} -NoProfile -ExecutionPolicy Bypass -File ${scriptRef}`
              : `bash ${scriptRef}`;
        const extra = buildMenuParamArgList(item, menuParamValues, platformOs);
        return `${base}${extra.length ? ' ' + extra.join(' ') : ''}`;
      };

      const toggleFavorite = async (code, event) => {
        if (event) event.stopPropagation();
        const next = favorites.includes(code)
          ? favorites.filter((c) => c !== code)
          : [...favorites, code];
        const res = await callApi('saveMenuFavorites', { favorites: next });
        if (res?.ok) setWb((prev) => (prev ? { ...prev, menuFavorites: res.menuFavorites } : prev));
      };

      const runMenu = async (code) => {
        // 每次仅清空当前任务；其它菜单的结果和日志仍可在切回时查看。
        try { await callApi('clearMenuLogs', { code }); } catch {}
        const res = await callApi('runMenuCommand', { code, params: buildParamsFor(findMenuItem(code)?.item) });
        if (res?.runner) setWb((prev) => (prev ? { ...prev, runner: res.runner } : prev));
      };

      const openTerminal = async (code) => {
        // 系统终端操作同样只重置当前菜单项的运行记录。
        try { await callApi('clearMenuLogs', { code }); } catch {}
        const res = await callApi('openMenuInTerminal', { code, params: buildParamsFor(findMenuItem(code)?.item) });
        if (res?.runner) setWb((prev) => (prev ? { ...prev, runner: res.runner } : prev));
      };

      const copyLogs = async (logs) => {
        const text = (logs || []).map((l) => l.text).join('\n');
        try {
          await navigator.clipboard.writeText(text);
          setCopiedLog(true);
          setTimeout(() => setCopiedLog(false), 1500);
        } catch {}
      };

      /** 临时勾选只改变当前 React 状态，不能调用任何同步／保存接口。 */
       const toggleAiServiceSelection = (svcId) => {
         if (!cloudServiceIds.includes(svcId)) return;
         setSelectedAiServiceIds((current) => (current.includes(svcId)
           ? current.filter((id) => id !== svcId)
           : [...current, svcId]));
         setAiSyncPromptVisible(false);
         setAiSyncPromptCopied(false);
       };

       const showAiSyncPrompt = () => {
         if (selectedAiServices.length) setAiSyncPromptVisible(true);
       };

       /** 复用兼容 HTTP 局域网入口的复制能力，复制失败时不伪报成功。 */
       const copyAiSyncPrompt = async () => {
         if (!aiSyncPrompt) return;
         const copied = await copyConnectionUrl(aiSyncPrompt);
         if (!copied) return;
         setAiSyncPromptCopied(true);
         setTimeout(() => setAiSyncPromptCopied(false), 1500);
       };

       const clearLogs = async (code) => {
        const res = await callApi('clearMenuLogs', { code });
        if (res?.runner) setWb((prev) => (prev ? { ...prev, runner: res.runner } : prev));
      };

      const sendStdin = async (input = stdinText) => {
        const val = String(input ?? '');
        setStdinText('');
        const res = await callApi('sendMenuStdin', { input: val });
        if (res?.runner) setWb((prev) => (prev ? { ...prev, runner: res.runner } : prev));
      };

      /** 云服务相关响应必须带回 cloudServiceIds；缺失说明后端未加载该接口（常见于未重启 DSH）。 */
      const requireCloudIds = (res, actionLabel) => {
        if (!res?.ok) throw new Error(res?.error || `${actionLabel}失败`);
        if (!Array.isArray(res.cloudServiceIds)) {
          throw new Error(`${actionLabel}未生效：后端未加载该接口，请重启 DSH 后再试`);
        }
        return res.cloudServiceIds;
      };

      const updateServiceState = (res) => setWb((prev) => {
        if (!prev) return prev;
        const lists = res.localStateLists || res.currentMachineProfile || res.profile;
        // 后端只回四张名单时，就地换算每个服务的状态；
        // 这样开关保存后不必再等一轮端口探测，点下去立刻有反馈。
        const services = lists && Array.isArray(prev.services)
          ? prev.services.map((svc) => ({
            ...svc,
            localState: {
              enabled: (lists.enabled || []).includes(svc.id),
              autoStartOnBoot: (lists.autoStartOnBoot || []).includes(svc.id),
              autoStartOnDsh: (lists.autoStartOnDsh || []).includes(svc.id),
              cloud: (lists.cloud || res.cloudServiceIds || prev.cloudServiceIds || []).includes(svc.id),
            },
          }))
          : (Array.isArray(res.services) ? res.services : prev.services);
        return {
          ...prev,
          services,
          cloudServiceIds: res.cloudServiceIds || prev.cloudServiceIds,
          machineServiceProfiles: res.machineServiceProfiles || prev.machineServiceProfiles,
          currentMachineProfile: res.currentMachineProfile || res.profile || prev.currentMachineProfile,
           localBinding: res.localBinding || prev.localBinding,
        };
      });

      // Keep the operator-visible request/error even if a plugin reload loses server-memory logs.
      const appendServiceUiLog = (svcId, type, text) => setWb((prev) => {
        if (!prev) return prev;
        const previous = prev.serviceLogsById?.[svcId] || [];
        const next = [...previous, { type, text }].slice(-80);
        return { ...prev, serviceLogsById: { ...(prev.serviceLogsById || {}), [svcId]: next } };
      });

      const toggleServiceFlag = async (svcId, field) => {
        if (serviceFlagPendingRef.current || busySvcId) return;
        if (!localBindingServiceIds.includes(svcId)) {
          const text = '该服务尚未登记到本机，请先接入本机';
          setServiceNotice({ id: svcId, text, tone: 'err' });
          appendServiceUiLog(svcId, 'prompt', text);
          return;
        }
        const wasEnabled = Boolean(currentProfile.enabled?.includes(svcId));
        const value = field === 'enabled'
          ? !wasEnabled
          : !(wasEnabled && (currentProfile[field] || []).includes(svcId));
        const autoEnabled = field !== 'enabled' && value && !wasEnabled;
        const label = { enabled: '本机启用', autoStartOnBoot: '开机自启动', autoStartOnDsh: '随 DSH 自启动' }[field];
        serviceFlagPendingRef.current = true;
        serviceControlEpochRef.current += 1;
        setSavingServiceFlag({ id: svcId, field });
        setDebugExpanded(true);
        setServiceNotice({ id: svcId, text: `正在保存${label}…`, tone: 'busy' });
        appendServiceUiLog(svcId, 'cmd', `[开关保存] ${label} -> ${value ? '开启' : '关闭'}`);
        try {
          // 只提交当前开关；服务端基于最新状态合并，不能让旧页面覆写其他服务的设置。
          const res = await callApi('saveMachineServiceProfile', { hostname: currentHostKey, serviceId: svcId, field, value });
          if (!res?.ok) throw new Error(res?.error || '服务开关保存失败');
          const saved = res.localStateLists?.[field] || res.currentMachineProfile?.[field];
          if (!Array.isArray(saved)) throw new Error('保存响应不完整：未返回开关状态，请重启 DSH 后重试');
          updateServiceState(res);
          if (saved.includes(svcId) !== value) throw new Error(`${label}未生效：服务端没有保存请求的状态`);
          const launchd = res.bootSync?.launchdSync?.cloudflared;
          let text = autoEnabled
            ? `已联动开启本机启用并开启${label}（不启停当前进程）`
            : `已${value ? '开启' : '关闭'}${label}（不启停当前进程）`;
          let tone = 'ok';
          if (res.bootSync?.synced === false || (field === 'autoStartOnBoot' && launchd?.ok === false)) {
            // macOS cloudflared 写系统 LaunchDaemon 失败时保留原有明确提示。
            text = `开关已保存，但启动项同步失败：${res.bootSync?.error || launchd?.error || '开机自启未写入系统 LaunchDaemon'}`;
            tone = 'err';
          } else if (field === 'autoStartOnBoot' && value && res.bootSync?.skippedServices?.includes(svcId)) {
            text = '开关已保存，但该服务没有可用的自启入口，启动项未生效';
            tone = 'err';
          }
          appendServiceUiLog(svcId, tone === 'err' ? 'prompt' : 'ok', text);
          setServiceNotice({ id: svcId, text, tone });
        } catch (err) {
          const text = `未保存或未生效：${err?.message || '服务开关保存失败'}`;
          appendServiceUiLog(svcId, 'prompt', text);
          setServiceNotice({ id: svcId, text, tone: 'err' });
        } finally {
          // 同时废弃保存期间的轮询，不能把刚保存的开关回滚成旧快照。
          serviceControlEpochRef.current += 1;
          serviceFlagPendingRef.current = false;
          setSavingServiceFlag(null);
        }
      };

      /** 当前电脑接入或取消已登记云服务；取消只改本机启用名单，不会停止正在运行的服务。 */
      const toggleCloudServiceOnCurrentMachine = async (svcId) => {
        const joining = !localBindingServiceIds.includes(svcId);
        setBusySvcId(svcId);
        try {
          const res = await callApi('toggleCloudServiceOnCurrentMachine', { serviceId: svcId });
          requireCloudIds(res, '云服务接入保存');
          updateServiceState(res);
          setServiceNotice({
            id: svcId,
            text: joining
              ? `已将服务 ${svcId} 同步接入电脑 ${currentHostKey}。`
              : `已取消服务 ${svcId} 在电脑 ${currentHostKey} 的云同步接入（不会停止服务）。`,
          });
        } catch (err) {
          setServiceNotice({ id: svcId, text: `未保存：${err?.message || '请检查本机配置'}` });
        } finally {
          setBusySvcId('');
        }
      };

      /**
       * 切换当前使用的云备份：只改本机指针，不动任何备份文件。
       * 切到别的电脑的备份时那些路径在本机大概率不存在，服务会显示未安装，属于预期。
       */
      const switchLocalBinding = async (machineId) => {
        if (!machineId || machineId === localBinding?.machineId) return;
        setBusyMachineId(machineId);
        try {
          const res = await callApi('switchLocalBinding', { machineId });
          if (!res?.ok) throw new Error(res?.error || '切换云备份失败');
          setWb((prev) => (prev ? {
            ...prev,
            services: Array.isArray(res.services) ? res.services : prev.services,
            menuFavorites: Array.isArray(res.menuFavorites) ? res.menuFavorites : prev.menuFavorites,
            localBinding: res.localBinding || prev.localBinding,
          } : prev));
          setServiceNotice({ id: machineId, text: `当前使用的云备份已切换为 ${machineId}。` });
        } catch (err) {
          setServiceNotice({ id: machineId, text: `未切换：${err?.message || '请检查 sync/machines 目录'}` });
        } finally {
          setBusyMachineId('');
        }
      };

      /** 本机服务首次上传至公共云清单，同时自动接入当前电脑。 */
      const promoteServiceToCloud = async (svc) => {        setBusySvcId(svc.id);
        try {
          const res = await callApi('promoteLocalServiceToCloud', { serviceId: svc.id });
          requireCloudIds(res, '同步到云');
          updateServiceState(res);
          setSelectedServiceId(svc.id);
          setServiceNotice({ id: svc.id, text: `已将 ${svc.name} 同步到云，并接入当前电脑。` });
        } catch (err) {
          setServiceNotice({ id: svc.id, text: `未保存：${err?.message || '请检查公共账本'}` });
        } finally {
          setBusySvcId('');
        }
      };

      /** 从云清单删除登记：只改云清单，不动本机注册与正在运行的服务。 */
      const removeServiceFromCloud = async (svcId) => {
        if (pendingDeleteSvc !== svcId) {
          setPendingDeleteSvc(svcId);
          setServiceNotice({ id: svcId, text: '再次点击确认：仅从云清单删除，本机注册与运行中的服务不受影响。' });
          return;
        }
        setPendingDeleteSvc('');
        setBusySvcId(svcId);
        try {
          const res = await callApi('removeCloudService', { serviceId: svcId });
          const nextIds = requireCloudIds(res, '删除云服务');
          if (nextIds.includes(svcId)) throw new Error('云清单仍包含该服务，请检查云清单文件是否只读');
          updateServiceState(res);
          setServiceNotice({ id: svcId, text: `已从云清单删除 ${svcId}：本机注册和正在运行的服务未受影响。` });
        } catch (err) {
          setServiceNotice({ id: svcId, text: `未删除：${err?.message || '请检查云清单'}` });
        } finally {
          setBusySvcId('');
        }
      };

      const handleServiceControl = async (svcId, action) => {
        const controlEpoch = ++serviceControlEpochRef.current;
        if (serviceFlagPendingRef.current) return;
        setSelectedServiceId(svcId);
        setBusySvcId(svcId);
        setDebugExpanded(true);
        appendServiceUiLog(svcId, 'cmd', `[UI request] ${svcId} -> ${action}`);
        setServiceNotice({ id: svcId, text: action === 'start' ? '正在启动，等待进程探测…' : action === 'stop' ? '正在停止…' : '正在重启…', tone: 'busy' });
        try {
          const res = await callApi('controlBackgroundService', {
            serviceId: svcId,
            serviceAction: action,
            device: svcId === 'scrcpy' ? scrcpyDevice.trim() : undefined,
          });
          if (controlEpoch !== serviceControlEpochRef.current) return;
          // Invalidate every pre-control poll; this response is the new service truth.
          serviceControlEpochRef.current += 1;
          const logs = res?.serviceLogsById?.[svcId] || [];
          if (Array.isArray(res?.services)) {
            setWb((prev) => (prev ? {
              ...prev,
              services: res.services,
              serviceLogs: res.serviceLogs || prev.serviceLogs,
              serviceLogsById: {
                ...(prev.serviceLogsById || {}),
                ...(res.serviceLogsById || {}),
                [svcId]: logs.length ? logs : (prev.serviceLogsById?.[svcId] || []),
              },
            } : prev));
          }
          const live = (res?.services || []).find((item) => item.id === svcId);
          const stillStopped = action === 'start' && live && !live.running && !res?.skipped;
          const stillRunning = action === 'stop' && live?.running;
          const incomplete = !Array.isArray(res?.services) && !res?.skipped;
          const unknownStart = action === 'start' && !live && !res?.skipped;
          const failed = res?.ok === false || stillStopped || stillRunning || unknownStart || incomplete;
          let text = res?.error || res?.message || '';
          if (incomplete && !text) text = '控制响应不完整：未返回服务状态，请重启 DSH 后重试';
          if (stillStopped) text = text || live.reason || '启动后仍未运行';
          if (stillRunning && !text) text = '停止后进程仍在运行';
          if (!text) {
            if (res?.skipped) text = '服务已在运行，未重复启动';
            else if (failed) text = '服务控制失败';
            else if (action === 'start') text = live?.running ? '已启动并确认在运行' : '启动结果未知';
            else if (action === 'stop') text = live && !live.running ? '已停止' : '停止结果未知';
            else text = '控制完成';
          }
          appendServiceUiLog(svcId, failed ? 'prompt' : 'ok', `[UI result] ${text}`);
          let noticeText = text;
          if (failed) {
            const raw = String(text || '').trim();
            const firstLine = raw.split(/\r?\n/)[0];
            if (raw.length > 50 || raw.includes('\n')) {
              noticeText = firstLine && firstLine.length <= 40
                ? (firstLine.startsWith('失败') ? firstLine : `失败：${firstLine}`)
                : `${action === 'start' ? '启动' : action === 'stop' ? '停止' : '控制'}失败（详细原因见下方原始日志）`;
            }
          }
          setServiceNotice({ id: svcId, text: noticeText, tone: failed ? 'err' : 'ok' });
        } catch (err) {
          if (controlEpoch !== serviceControlEpochRef.current) return;
          serviceControlEpochRef.current += 1;
          const text = err?.message || '服务控制请求失败';
          appendServiceUiLog(svcId, 'prompt', `[UI error] ${text}`);
          setServiceNotice({ id: svcId, text, tone: 'err' });
        } finally {
          setBusySvcId('');
        }
      };

      const updatePluginState = (res) => setWb((prev) => (prev ? {
        ...prev,
        dshPlugins: res.dshPlugins || prev.dshPlugins,
        localDshPlugins: res.localDshPlugins || prev.localDshPlugins,
        machineDshPluginProfiles: res.machineDshPluginProfiles || prev.machineDshPluginProfiles,
        // 接入/取消接口同步返回本机最终名单，立即更新避免按钮停在旧状态。
        currentMachineDshPluginIds: Array.isArray(res.currentMachineDshPluginIds)
          ? res.currentMachineDshPluginIds
          : prev.currentMachineDshPluginIds,
        localBinding: res.localBinding || prev.localBinding,
      } : prev));

      // 各安装入口共用风险后缀，避免 HTTP/业务失败或普通成功分支漏报未核实副作用。
      const pluginRecoveryHint = (result) => result?.recoveryRequired ? ' 依赖目录可能已变化或仍有未核实副作用，请先运行只读体检。' : '';
      const pluginResultError = (result, fallback) => Object.assign(new Error(result?.error || fallback), {
        code: result?.code, recoveryRequired: Boolean(result?.recoveryRequired),
      });

      /** 只读体检不安装、不修锁；后端未更新时明确提示，而不是显示空结果。 */
      const runPluginDoctor = async () => {
        setPluginSaving(true);
        try {
          const res = await callApi('runPluginsDoctor');
          if (!res?.report) throw new Error('服务端尚未载入插件体检接口，请重启 DSH 使后端新接口生效');
          const report = res.report;
          const runtime = report.runtime?.ok
            ? `Node ${report.runtime.nodeVersion} · pnpm ${report.runtime.pnpmVersion}（${report.runtime.source}）`
            : `运行时不可用：${report.runtime?.error || report.error || '请检查安装环境'}`;
          const issues = [...(report.errors || []), ...(report.warnings || [])];
          showPluginNotice(`只读体检：${runtime}。${issues.length ? issues.slice(0, 8).map((item) => `${item.package || item.code}：${item.message}`).join('；') : '未发现静态问题'}。未执行安装或验证重启加载。`, '__batch__');
        } catch (error) {
          showPluginNotice(`体检未完成：${error.message}`, '__batch__');
        } finally { setPluginSaving(false); }
      };

      // 优先消费后端返回的当前平台可用方案列表，缺失时从 #71 菜单参数或兜底项派生
      const dshProfileOptions = (() => {
        if (Array.isArray(wb?.dshProfiles) && wb.dshProfiles.length > 0) {
          return wb.dshProfiles.map((p) => ({ id: p.id, label: p.label || p.id }));
        }
        const menu71 = (wb?.menuSpec?.groups || [])
          .flatMap((g) => (Array.isArray(g?.items) ? g.items : []))
          .find((it) => it?.code === '71');
        const profileParam = (Array.isArray(menu71?.params) ? menu71.params : [])
          .find((p) => p?.name === 'dshProfile');
        const targetPlatform = isWin ? 'win32' : 'darwin';
        const specOptions = (Array.isArray(profileParam?.options) ? profileParam.options : [])
          .filter((opt) => !opt?.platform || opt.platform === targetPlatform)
          .map((opt) => ({
            id: opt.value || opt.id,
            label: opt.label || opt.value || opt.id,
          }))
          .filter((opt) => Boolean(opt.id));
        if (specOptions.length > 0) return specOptions;
        return [{ id: 'general', label: '通用' }];
      })();

      const activeDshProfile = dshProfileOptions.some((opt) => opt.id === dshProfile)
        ? dshProfile
        : (dshProfileOptions[0]?.id || 'general');

      // 后端动态方案加载后，若当前选中方案不在可用列表内则自动对齐到有效首项
      useEffect(() => {
        if (Array.isArray(wb?.dshProfiles) && wb.dshProfiles.length > 0 && activeDshProfile !== dshProfile) {
          setDshProfile(activeDshProfile);
        }
      }, [wb?.dshProfiles, activeDshProfile, dshProfile]);

      /** 从云端插件清单生成只读差异预览：对照安装、启用与配置明细后再由用户确认还原到本地。 */
      const previewRestorePlugins = async (machineId = '') => {
        setPluginSaving(true);
        try {
          const res = await callApi('previewRestoreMachinePlugins', {
            machineId,
            dshProfile: activeDshProfile,
          });
          if (!res?.ok) throw new Error(res?.error || '生成还原预览失败');
          if (!res?.preview) throw new Error('服务端尚未载入还原预览接口，请重启 DSH 使后端新接口生效');
          const preview = res.preview || {};
          setPluginRestorePreview({
            machineId: res.machineId || machineId,
            toInstall: preview.toInstall || [],
            toEnable: preview.toEnable || [],
            toUpdateConfig: preview.toUpdateConfig || [],
            unchanged: preview.unchanged || [],
            bundleOrderChanged: Boolean(preview.bundleOrderChanged),
            totalSelected: preview.totalSelected || 0,
          });
          showPluginNotice(
            `还原预览（${res.machineId || '云端插件清单'}）：待安装 ${(preview.toInstall || []).length} · 待启用 ${(preview.toEnable || []).length} · 配置更新 ${(preview.toUpdateConfig || []).length} · 已就绪 ${(preview.unchanged || []).length}`,
            '__batch__',
          );
        } catch (error) {
          showPluginNotice(`还原预览失败：${error.message || '请检查云清单'}`, '__batch__');
        } finally {
          setPluginSaving(false);
        }
      };

      /** 确认将云端插件清单及配置快照批量还原到本机（单插件失败隔离，保留成功项）。 */
      const confirmRestorePlugins = async (machineId = '') => {
        persistPluginSyncing(true);
        setPluginSaving(true);
        try {
          const res = await callApi('restoreMachinePlugins', {
            machineId,
            dshProfile: activeDshProfile,
          });
          if (!res?.ok) throw pluginResultError(res, '一键还原插件到本地失败');
          if (!res?.machineId && !Array.isArray(res?.results)) throw new Error('服务端尚未载入插件还原接口，请重启 DSH 使后端新接口生效');
          setPluginRestorePreview(null);
          updatePluginState(res);
          const failedList = (res.errors || []).map((item) => item.package || item.id).filter(Boolean);
          const skippedList = (res.results || []).filter((item) => ['skipped', 'profile-managed'].includes(item.status)).map((item) => item.id);
          if (res.outcome === 'skipped') {
            showPluginNotice(`未执行还原：所选插件均被跳过或由对应 DSH 方案管理。${pluginRecoveryHint(res)}`, '__batch__');
          } else if (res.partialFailure && failedList.length) {
            showPluginNotice(
              `部分还原完成：失败 ${failedList.length} 项（${failedList.join('、')}），成功项已配置；跳过 ${skippedList.length} 项。${pluginRecoveryHint(res)}`,
              '__batch__',
            );
          } else {
            showPluginNotice(
              `已从${res.machineId ? `备份 ${res.machineId}` : '云端插件清单'}应用配置；跳过 ${skippedList.length} 项。${res.restartRequired ? '请完全重启 DSH 后确认加载。' : '配置未变化，未验证运行中的加载。'}${pluginRecoveryHint(res)}`,
              '__batch__',
            );
          }
          void refreshWorkbench(false);
        } catch (error) {
          showPluginNotice(`还原未完成：${error.message || '请检查 DSH Profile 是否可写'}${pluginRecoveryHint(error)}`, '__batch__');
        } finally {
          persistPluginSyncing(false);
          setPluginSaving(false);
        }
      };

      /** 当前电脑接入或取消已登记云插件；取消不会卸载本机包。 */
      const toggleCloudPluginOnCurrentMachine = async (pluginId) => {
        setPluginSaving(true);
        try {
          const removing = currentMachinePluginIds.includes(pluginId);
          const res = await callApi(
            removing ? 'unlinkCloudPluginFromCurrentMachine' : 'syncCloudPluginToCurrentMachine',
            removing ? { pluginId } : { pluginId, dshProfile: activeDshProfile },
          );
          if (!res?.ok) throw pluginResultError(res, '云插件选择保存失败');
          updatePluginState(res);
          const skipped = res.outcome === 'skipped';
          showPluginNotice((skipped ? '未执行接入或取消：该插件不适用于当前方案或由方案专门管理。'
            : removing ? '已取消当前电脑接入；未卸载本机插件。' : '已配置当前插件；重启后的实际加载仍需确认。') + pluginRecoveryHint(res), pluginId);
          // 状态已由响应同步，慢速工作台刷新不能阻塞按钮反馈。
          void refreshWorkbench(false);
        } catch (error) {
          showPluginNotice(`未保存：${error.message || '请检查本机配置'}${pluginRecoveryHint(error)}`, pluginId);
        } finally {
          setPluginSaving(false);
        }
      };

      /** 本机已有插件首次上传至云清单，同时自动接入当前电脑。 */
      const promotePluginToCloud = async (plugin) => {
        setPluginSaving(true);
        try {
          const res = await callApi('promoteLocalDshPluginToCloud', { package: plugin.package });
          if (!res?.ok) throw new Error(res?.error || '同步到云失败');
          updatePluginState(res);
          setSelectedPluginId(res.plugin?.id || plugin.id);
          await refreshWorkbench(false);
          // 提示里带上仓库快照目录，换电脑前可以直接去看生成了什么。
          const bundleDir = res?.bundle?.dir ? `，配置快照已写入 ${res.bundle.slug}/` : '';
          showPluginNotice(`已将 ${plugin.name} 配置推送到唯一云端快照${bundleDir}。`, res.plugin?.id || plugin.id);
        } catch (error) {
          showPluginNotice(`未保存：${error.message || '请检查本机配置'}`, plugin.id);
        } finally {
          setPluginSaving(false);
        }
      };

      /**
       * 从云清单删除插件：删定义、摘掉各电脑名单里的引用，并删除仓库里的配置快照目录。
       * 本机已装插件不会因此被卸载。
       */
      const removePluginFromCloud = async (pluginId) => {
        if (pendingDeletePlugin !== pluginId) {
          setPendingDeletePlugin(pluginId);
          showPluginNotice('再次点击确认：会删除云清单条目与仓库里的配置快照，本机已装插件不受影响。', pluginId);
          return;
        }
        setPendingDeletePlugin('');
        setPluginSaving(true);
        try {
          const res = await callApi('removeCloudDshPlugin', { pluginId });
          if (!res?.ok) throw new Error(res?.error || '删除云插件失败');
          updatePluginState(res);
          await refreshWorkbench(false);
          const removedDir = res?.removedBundle?.removed ? '，并已删除仓库配置快照' : '';
          showPluginNotice(`已从云清单删除该插件${removedDir}；本机安装未受影响。`, pluginId);
        } catch (err) {
          showPluginNotice(`未删除：${err?.message || '请检查公共账本'}`, pluginId);
        } finally {
          setPluginSaving(false);
        }
      };

      /** 云插件同步到当前电脑：登记选择并执行安装、软链挂载及最终开关写入。 */
      const syncCloudPluginToCurrentMachine = async (pluginId) => {
        persistPluginSyncing(true);
        setPluginSaving(true);
        try {
          const res = await callApi('syncCloudPluginToCurrentMachine', { pluginId, dshProfile: activeDshProfile });
          if (!res?.ok) throw pluginResultError(res, '插件同步失败');
          updatePluginState(res);
          const skipped = res.outcome === 'skipped';
          const reasons = (res.results || []).filter((item) => ['skipped', 'profile-managed'].includes(item.status)).map((item) => item.reason || '由对应 DSH 方案管理').join('；');
          showPluginNotice(skipped ? `未执行接入：${reasons || '目标插件不适用于当前方案'}。`
            : `${res.plugin?.name || pluginId} 已配置到本机；${res.restartRequired ? '请完全重启 DSH 后确认加载。' : '配置未变化，未验证当前运行中的加载。'}${res.recoveryRequired ? '仍有未核实的安装副作用，请运行只读体检。' : ''}`, pluginId);
          // 状态已由响应同步，慢速工作台刷新不能阻塞按钮反馈。
          void refreshWorkbench(false);
        } catch (error) {
          showPluginNotice(`同步未完成：${error.message || '请检查 DSH Profile 是否可写'}${error.recoveryRequired ? '；依赖目录可能已变化，请运行只读体检。' : ''}`, pluginId);
        } finally {
          persistPluginSyncing(false);
          setPluginSaving(false);
        }
      };


      const q = search.trim().toLocaleLowerCase();
      const matchMenu = (it) => !q || it.code.includes(q) || it.label.toLocaleLowerCase().includes(q) || it.description.toLocaleLowerCase().includes(q);
      const matchService = (s) => !q || s.id.toLocaleLowerCase().includes(q) || s.name.toLocaleLowerCase().includes(q) || (s.guard || '').toLocaleLowerCase().includes(q);

      const selectedMenuFound = findMenuItem(selectedCode) || findMenuItem('11') || { item: null, groupTitle: '' };
      const selectedMenu = selectedMenuFound.item;
      const selectedSvc = visibleServices.find((s) => s.id === selectedServiceId) || visibleServices[0] || null;

      // 列表里已接入与运行中的都会出现，标题里的「运行中」只数真正在跑的，避免把已停止也算成在跑。
      const runningCount = localServices.filter((s) => s.running).length;

      // 渲染函数拆到 09-workbench-views.js，这里一次性把状态与处理函数交给它们。
      const scope = {
        wb, activeTab, selectedCode, setSelectedCode, selectedServiceId, setSelectedServiceId,
        setSelectedPluginId, setPluginView, setServiceView, serviceView, pluginSaving, pluginNotice, pluginNoticeOwner, menuParamValues,
        setMenuParamValues, dshProfile: activeDshProfile, setDshProfile, scrcpyDevice,
        setScrcpyDevice, stdinText, setStdinText, busySvcId, pendingDeleteSvc, serviceNotice,
        copiedLog, debugExpanded, setDebugExpanded, savingServiceFlag, selectedAiServiceIds, aiSyncPromptVisible, setAiSyncPromptVisible,
         aiSyncPrompt, aiSyncPromptCopied, showAiSyncPrompt, copyAiSyncPrompt, toggleAiServiceSelection, isWin, groups,
        services, favorites, dshPlugins, localDshPlugins, isCloudPluginTab,
        isCloudServiceTab, isBackupServiceTab, localBinding, machineBackups, busyMachineId, switchLocalBinding,
        currentHostKey, currentMachinePluginIds, activePluginList, selectedPlugin, currentProfile,
        currentEnabled, cloudServiceIds, localBindingServiceIds, localServices, cloudServices, visibleServices, runningCount, buildPreviewText,
        toggleFavorite, runMenu, openTerminal, copyLogs, clearLogs, sendStdin,
        toggleServiceFlag, toggleCloudServiceOnCurrentMachine, promoteServiceToCloud, removeServiceFromCloud, handleServiceControl, toggleCloudPluginOnCurrentMachine,
        promotePluginToCloud, syncCloudPluginToCurrentMachine, removePluginFromCloud, pendingDeletePlugin,
        pluginRestorePreview, setPluginRestorePreview, previewRestorePlugins, confirmRestorePlugins, runPluginDoctor,
        q, matchMenu, matchService, selectedMenu,
        selectedSvc, dshProfileOptions,
        renderActiveExtensionCenter: () => {
          const extId = typeof activeTab === 'string' && activeTab.startsWith('ext:') ? activeTab.slice(4) : '';
          const rt = extId ? extRuntimesRef.current[extId] : null;
          return rt?.renderCenter ? rt.renderCenter() : null;
        },
        renderActiveExtensionInspector: () => {
          const extId = typeof activeTab === 'string' && activeTab.startsWith('ext:') ? activeTab.slice(4) : '';
          const rt = extId ? extRuntimesRef.current[extId] : null;
          return rt?.renderInspector ? rt.renderInspector() : null;
        },
      };
      // 左栏页签与顶栏共用同一套 16px 线性图标：图标占固定槽位，标题过长也不推挤右侧计数。
      const navItem = (tab, key, icon, label, count) => h(
        'button',
        { key, type: 'button', className: `dsh-au-wb-navbtn ${activeTab === tab ? 'active' : ''}`, onClick: () => setActiveTab(tab) },
        h('span', { className: 'dsh-au-nav-main' }, [
          h('span', { key: 'icon', className: 'dsh-au-nav-icon' }, icon),
          h('span', { key: 'label', className: 'dsh-au-nav-label' }, label),
        ]),
        h('span', { className: 'dsh-au-nav-count' }, `${count}`)
      );

      const workbenchBox = h(
        'div',
        embedded
          ? { className: 'dsh-au-wb-modal dsh-au-wb-panel' }
          : { className: 'dsh-au-wb-modal', role: 'dialog', 'aria-modal': 'true' },
        privateExtensions.map((ext) => ext.styleText ? h('style', { key: `ext-style-${ext.id}` }, ext.styleText) : null),
        privateExtensions.map((ext) => h(PrivateExtensionRunner, {
          key: `ext-runner-${ext.id}`,
          ext,
          active: activeTab === `ext:${ext.id}`,
          parentSeq: parentExtSeqRef.current,
          runtimesRef: extRuntimesRef,
          onExtUpdate: triggerExtRender,
        })),
        h(
          'header',
          { className: 'dsh-au-wb-head' },
          h('input', {
            className: 'dsh-au-wb-search',
            placeholder: '输入菜单序号、服务名或关键字检索...',
            value: search,
            // 开窗不主动聚焦，避免移动端自动弹出键盘；用户仍可点击搜索。
            autoFocus: false,
            onChange: (e) => {
              const v = e.target.value;
              setSearch(v);
              const found = findMenuItem(v.trim());
              if (found) setSelectedCode(found.item.code);
            },
          }),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            h('button', {
              type: 'button',
              className: 'dsh-au-wb-pill on',
              onClick: () => setOsOverride(isWin ? 'darwin' : 'win32'),
              title: '自动识别当前系统；点击可切换预览 Windows / macOS 专属菜单项',
            }, isWin ? '系统识别: Windows (.ps1)' : '系统识别: macOS (.sh)'),
            h('button', {
              type: 'button',
              className: 'dsh-au-btn',
              disabled: busySvcId === '__refresh__',
              onClick: () => void handleManualRefresh(),
              title: '立即重新检查后台服务运行状态（默认 1 小时自动缓存）',
            }, busySvcId === '__refresh__' ? '刷新中…' : '刷新'),
            !embedded && typeof onClose === 'function'
              ? h('button', { type: 'button', className: 'dsh-au-btn', onClick: onClose }, '关闭 (Esc)')
              : null
          )
        ),
        h(
          'div',
          { className: 'dsh-au-wb-body' },
          h(
            'nav',
            { className: 'dsh-au-wb-nav' },
            navItem('fav', 'nav-fav', h(StarIcon), '常用收藏', favorites.length),
            navItem('services', 'nav-services', h(ServicesIcon), '后台服务管理', localServices.length),
            navItem('plugins', 'nav-plugins', h(PluginIcon), '插件管理', localDshPlugins.length),
            privateExtensions.map((ext) => {
              const tabKey = `ext:${ext.id}`;
              const iconNode = ext.iconSvg
                ? h('span', { style: { display: 'inline-flex', width: '16px', height: '16px' }, dangerouslySetInnerHTML: { __html: ext.iconSvg } })
                : h(ExtensionIcon);
              const badge = extRuntimesRef.current[ext.id]?.badge ?? '—';
              return navItem(tabKey, `nav-ext-${ext.id}`, iconNode, ext.title, badge);
            }),
            navItem('all', 'nav-all', h(CommandMenuIcon), '全部菜单指令', totalMenuItems),
            // 菜单分组是二级项：用同尺寸圆点占住图标槽位，标题仍与上面四个页签左对齐。
            groups.map((g) => h(
              'button',
              { key: g.id, type: 'button', className: `dsh-au-wb-navbtn ${activeTab === g.id ? 'active' : ''}`, onClick: () => setActiveTab(g.id) },
              h('span', { className: 'dsh-au-nav-main' }, [
                h('span', { key: 'icon', className: 'dsh-au-nav-icon' }, h('span', { className: 'dsh-au-nav-dot' })),
                h('span', { key: 'label', className: 'dsh-au-nav-label' }, g.title),
              ]),
              h('span', { className: 'dsh-au-nav-count' }, `${(g.items || []).length}`)
            ))
          ),
          h('section', { className: 'dsh-au-wb-center' }, renderCenterContent(scope)),
          h('aside', { className: 'dsh-au-wb-inspector' }, renderInspector(scope))
        ),
        h(
          'footer',
          { className: 'dsh-au-wb-foot' },
          h('span', null, '支持序号直达 (11-71) · 双击无参卡片直接执行 · 后台服务独立于 DSH 运行，支持按电脑保存自启组合'),
          h('span', null, `本机: ${wb?.selfHostname || 'DSH'} · SSOT: scripts/menu.json`)
        )
      );

      if (embedded) return workbenchBox;

      return h(
        'div',
        { className: 'dsh-au-mask', onClick: (e) => { if (e.target === e.currentTarget) onClose(); } },
        workbenchBox
      );
    }

    /** 侧边栏入口打开的嵌入式主面板：复用统一工作台全部内容并铺满主区域。 */
    function UnifiedWorkbenchPanel() {
      return h(UnifiedWorkbenchModal, { initialTab: 'fav', embedded: true });
    }

