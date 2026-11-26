    const sliceLatestRunLogs = (rawLogs) => {
      const arr = Array.isArray(rawLogs) ? rawLogs : [];
      for (let i = arr.length - 1; i >= 0; i -= 1) {
        const t = String(arr[i]?.text || '');
        if (arr[i]?.type === 'cmd' && (t.startsWith('$ ') || t.startsWith('[系统终端]'))) {
          return arr.slice(i);
        }
      }
      return arr;
    };

    /**
     * 判断一条日志对应哪个工具的规则产物。
     * 优先看目标路径（~/.claude、~/.codex、~/.comate、~/.dsh），再看工具名，
     * 避免 AGENTS.md 同时属于 Codex 与 DSH 时被记成一个。
     */
    const detectRuleTool = (line) => {
      const byPath = [
        [/\.claude[\\/]|CLAUDE\.md/i, 'Claude Code'],
        [/\.codex[\\/]/, 'Codex'],
        [/\.comate[\\/]|comate\.mdr/i, 'Comate'],
        [/\.dsh[\\/]/, 'DSH'],
        [/CURSOR\.md|\.cursor[\\/]/i, 'Cursor'],
      ].find(([pattern]) => pattern.test(line));
      if (byPath) return byPath[1];
      const byName = [
        [/Claude Code/i, 'Claude Code'],
        [/\bCodex\b/i, 'Codex'],
        [/\bComate\b/i, 'Comate'],
        [/\bCursor\b/i, 'Cursor'],
        [/\bDSH\b/, 'DSH'],
      ].find(([pattern]) => pattern.test(line));
      return byName ? byName[1] : '';
    };

    /**
     * 将长路径、箭头映射或冗长括号列表提炼为一眼可读的短产物名：
     * 彻底剔除 C:\Users\... / 长路径 ... 等长路径与技能枚举列表。
     */
    const compactArtifactText = (rawText) => {
      let s = String(rawText || '').trim();
      if (!s) return { tag: '', value: '' };

      // 常见配置文件以用户能理解的产物名呈现，不暴露冗长文件路径。
      const knownArtifact = [
        [/cordis\.patch\.ya?ml/i, 'DSH 桌面配置', '桌面配置补丁'],
        [/\.credentials\.ya?ml/i, 'DSH 本机凭据', '登录凭据文件'],
        [/AGENTS\.md\b/i, '全局规则', '规则配置文件'],
        [/CLAUDE\.md\b/i, 'Claude Code 规则', '规则配置文件'],
        [/CURSOR\.md\b/i, 'Cursor 规则', '规则配置文件'],
        [/comate\.mdr\b/i, 'Comate 规则', '规则配置文件'],
      ].find(([pattern]) => pattern.test(s));
      if (knownArtifact) return { tag: knownArtifact[1], value: knownArtifact[2] };

      // 若存在 "目标 -> 来源" 映射，仅保留左侧产物目标。
      if (s.includes(' -> ')) s = s.split(' -> ')[0].trim();
      // 剥离超过 18 字符的括号枚举（如 45 个 skill 名称列表）。
      s = s.replace(/\s*\([^)]{18,}\)/g, '').trim();
      s = s.replace(/^已注册快捷方式[:：]\s*/i, '').trim();

      let locationTag = '';
      if (/Start Menu|Programs/i.test(s)) locationTag = '开始菜单产物';
      else if (/Desktop|桌面/i.test(s)) locationTag = '桌面快捷方式';
      else if (/Applications/i.test(s)) locationTag = '应用目录产物';
      else if (/\.claude/i.test(s)) locationTag = 'Claude 配置';
      else if (/\.codex/i.test(s)) locationTag = 'Codex 配置';
      else if (/\.dsh/i.test(s)) locationTag = 'DSH 配置';
      else if (/JetBrains|Google|AndroidStudio|PyCharm|Idea/i.test(s)) locationTag = 'IDE 配置目录';

      // 将任意绝对路径收缩为末尾文件名或目录名。
      s = s.replace(/[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*([^\\/:*?"<>|\r\n]+)/g, '$1');
      s = s.replace(/\/(?:Users|home|Applications|opt|var)\/(?:[^/\s]+\/)*([^/\s]+)/g, '$1');
      if (s.length > 28) s = `${s.slice(0, 26)}...`;
      return { tag: locationTag, value: s };
    };

    const parseQuotaSections = (logs, menuItem = null) => {
      const isQuotaMenu = Boolean(menuItem?.readonly || ['31', '32', '33', '34'].includes(String(menuItem?.code || '')));
      if (isQuotaMenu) {
        const sections = [];
        let current = null;
        for (const entry of logs || []) {
          const line = String(entry?.text || '').trim();
          if (!line || line.startsWith('$') || line.startsWith('[系统终端]') || line.startsWith('[执行结束]')) continue;
          const secMatch = /^===\s*(.+?)\s*===$/.exec(line);
          if (secMatch) {
            current = { kind: 'quota', title: secMatch[1], status: '● 在线', statusTone: 'emerald', rows: [] };
            sections.push(current);
            continue;
          }
          if (current && !line.startsWith('[')) {
            const parts = line.split(/\s{2,}/);
            if (parts.length >= 2) {
              const label = parts[0].trim();
              let val = parts.slice(1).join(' ').replace(/\s+/g, ' ').trim();
              // 统一规整分隔符，两端补齐均匀间距，避免终端空格导致的怪异拼接
              val = val.replace(/\s*\|\s*/g, ' · ');
              const pctMatch = /(\d+(?:\.\d+)?)%/.exec(val);
              let tone = 'emerald';
              if (val.includes('失败') || val.includes('错误')) tone = 'rose';
              else if (pctMatch) {
                const pct = Number(pctMatch[1]);
                const isUsedPct = val.includes('已用');
                const remain = isUsedPct ? (100 - pct) : pct;
                tone = remain <= 15 ? 'rose' : remain <= 40 ? 'amber' : 'emerald';
              }
              current.rows.push({ label, value: val, tone });
            }
          }
        }
        return sections.filter((s) => s.rows.length > 0);
      }

      // 非额度指令：只生成 1 张高信噪比「结果与产物卡片」，绝不输出长路径、技能长列表与步骤明细
      const tiles = [];
      const addTile = (label, value, badge, tone = 'emerald') => {
        if (!value) return;
        const existing = tiles.find((t) => t.label === label && t.value === value);
        if (!existing) tiles.push({ label, value, badge, tone });
      };
      const addPriorityTile = (label, value, badge, tone = 'emerald') => {
        if (!value || tiles.some((t) => t.label === label && t.value === value)) return;
        tiles.unshift({ label, value, badge, tone });
      };

      let statusText = '● 正在执行';
      let statusTone = 'blue';
      let maxValidLinks = 0;
      let totalNewLinks = 0;
      let maxKeptLinks = 0;
      let hasRuleBuilt = false;
      // 规则同步目标按目的地判定：AGENTS.md 被 Codex 与 DSH 共用，只看文件名会串台。
      const ruleTools = new Set();

      for (const entry of logs || []) {
        const line = String(entry?.text || '').trim();
        if (!line || line.startsWith('$') || line.startsWith('[系统终端]')) continue;

        const exitMatch = /^\[执行结束\].*退出码:\s*(-?\d+)/.exec(line);
        if (exitMatch) {
          const codeNum = Number(exitMatch[1]);
          statusText = codeNum === 0 ? '✓ 执行成功' : `✕ 退出码 ${codeNum}`;
          statusTone = codeNum === 0 ? 'emerald' : 'rose';
          continue;
        }

        // 识别 Git 钩子目录设置；用功能语义替代原始 Git 配置键。
        const hooksMatch = /core\.hooksPath\s*(?:->|→)\s*(\S+)/i.exec(line);
        if (hooksMatch) {
          addTile('Git 自动钩子', `已绑定 ${hooksMatch[1]}`, '已启用', 'emerald');
          continue;
        }

        // Build-UserRules 的输出行带缩进，成功标记允许前导空白，否则整段都识别不到。
        const ruleOutput = /(?:CLAUDE\.md|AGENTS\.md|comate\.mdr|CURSOR\.md|global rules)/i.test(line);
        if (ruleOutput && /\[(?:OK|完成)\]|已(?:同步|构建|生成|写入)|verified/i.test(line)) {
          hasRuleBuilt = true;
          // 只有真正写入工具目录的行（"[OK] → 路径"）才算已同步；构建行和手抄提示不计。
          if (/\[(?:OK|完成)\]\s*(?:→|->)/.test(line)) {
            const ruleTool = detectRuleTool(line);
            if (ruleTool) {
              ruleTools.add(ruleTool);
              continue;
            }
          }
        }

        // 识别 #11 / #14 Skill 同步核心指标（剥离 45 个技能名的超长括号列表）。
        const skillCountMatch = /^Source skills:\s*(\d+)/i.exec(line);
        if (skillCountMatch) {
          addTile('仓库技能源', `${skillCountMatch[1]} 个 Skill`, '已扫描', 'blue');
          continue;
        }
        // 匹配任意 *-sync 引擎版本行，不写死私有项目名。
        const engineMatch = /^Found:\s*([A-Za-z0-9._-]+(?:-sync)?\s+[0-9.]+)/i.exec(line);
        if (engineMatch) {
          addTile('同步引擎', engineMatch[1], '环境就绪', 'blue');
          continue;
        }
        const linkStatsMatch = /New:\s*(\d+)\s*\|\s*Replaced:\s*(\d+)\s*\|\s*Valid:\s*(\d+)\s*\|\s*Unique kept:\s*(\d+)/i.exec(line);
        if (linkStatsMatch) {
          totalNewLinks += Number(linkStatsMatch[1]) + Number(linkStatsMatch[2]);
          maxValidLinks = Math.max(maxValidLinks, Number(linkStatsMatch[3]));
          maxKeptLinks = Math.max(maxKeptLinks, Number(linkStatsMatch[4]));
          continue;
        }
        if (/Configuring hooks|User Rules|CLAUDE\.md/i.test(line) && !hasRuleBuilt) {
          hasRuleBuilt = true;
          continue;
        }

        // 识别结构化标签产物（[OK] / [完成] / [备份] / [目标] / [--] / [!] / [错误]）
        const tagMatch = /^\[(OK|--|!|目标|备份|完成|预览|转交|取消|错误)\]\s*(.+)$/.exec(line);
        if (tagMatch) {
          const kind = tagMatch[1];
          const rawVal = tagMatch[2];
          const { tag, value } = compactArtifactText(rawVal);
          if (!value) continue;
          if (kind === 'OK' || kind === '完成') {
            if (kind === '完成') {
              statusText = '✓ 执行成功';
              statusTone = 'emerald';
            }
            addTile(tag || '产出结果', value, '✓ 已生效', 'emerald');
          } else if (kind === '备份') {
            addTile('安全备份', value, '可回滚', 'blue');
          } else if (kind === '目标') {
            addTile(tag || '目标环境', value, '已定位', 'blue');
          } else if (kind === '--') {
            addTile(tag || '保持现状', value, '已跳过', 'amber');
          } else if (kind === '!' || kind === '错误' || kind === '取消') {
            if (kind === '错误') {
              statusText = '✕ 执行异常';
              statusTone = 'rose';
            }
            addTile('异常 / 提示', value, '需关注', 'rose');
          } else if (kind === '预览' || kind === '转交') {
            addTile(kind === '预览' ? '变更预览' : '终端转交', value, kind, 'blue');
          }
        }
      }

      if (maxValidLinks > 0) {
        // 链接有效性是同步成败最直接的结果，固定放在卡片最前部。
        addPriorityTile('本机有效链接', `${maxValidLinks} 项有效`, `变更 ${totalNewLinks} · 独有 ${maxKeptLinks}`, 'emerald');
      }
      if (ruleTools.size > 0) {
        addTile('全局规则已同步', [...ruleTools].join('、'), '✓ 已生效', 'emerald');
      } else if (hasRuleBuilt) {
        addTile('全局规则已同步', '规则配置已构建', '✓ 已生效', 'emerald');
      }
      if (tiles.length === 0 && (logs || []).length > 1) {
        addTile(
          '执行状态',
          statusTone === 'emerald' ? `${menuItem?.label || '任务'}已完成` : (statusTone === 'rose' ? '执行出现异常，请看下方日志' : '正在运行子进程...'),
          statusText.replace(/^[✓✕●]\s*/, ''),
          statusTone
        );
      }

      if (tiles.length === 0) return [];
      return [{
        kind: 'summary',
        title: menuItem ? `#${menuItem.code} · ${menuItem.label}` : '执行结果总览',
        status: statusText,
        statusTone,
        rows: tiles,
      }];
    };

    /**
     * 插件卡的统一状态口径：卡片、排序、右侧详情都从这里取，
     * 避免三处各算一套导致「卡片说已接入、详情说仅本机」。
     */
    const resolvePluginCardState = (plugin, ctx = {}) => {
      const dshPlugins = Array.isArray(ctx.dshPlugins) ? ctx.dshPlugins : [];
      const localDshPlugins = Array.isArray(ctx.localDshPlugins) ? ctx.localDshPlugins : [];
      const currentMachinePluginIds = Array.isArray(ctx.currentMachinePluginIds) ? ctx.currentMachinePluginIds : [];
      const cloudPlugin = dshPlugins.find((item) => item.package === plugin.package);
      const cloudManaged = Boolean(ctx.isCloudPluginTab) || Boolean(cloudPlugin);
      const cloudPluginId = cloudPlugin?.id || plugin.id;
      const localEntry = localDshPlugins.find((item) => item.package === plugin.package);
      return {
        cloudPlugin,
        cloudManaged,
        cloudPluginId,
        localEntry,
        installed: Boolean(localEntry),
        // 老 host 不返回 enabled：宁可不显示启用状态，也不要把启用中的插件标成未启用。
        enabledKnown: Boolean(localEntry) && typeof localEntry.enabled === 'boolean',
        enabled: Boolean(localEntry?.enabled),
        selected: cloudManaged && currentMachinePluginIds.includes(cloudPluginId),
      };
    };

    /**
     * 排序档位：启用且已接入云同步 > 仅启用 > 仅接入云同步 > 已安装未启用 > 未安装。
     * 同档保持宿主返回顺序，刷新时卡片不会来回跳。
     */
    const pluginSortRank = (state) => {
      if (state.enabled && state.selected) return 0;
      if (state.enabled) return 1;
      if (state.selected) return 2;
      if (state.installed) return 3;
      return 4;
    };

    const sortPluginsByState = (plugins, ctx = {}) => (Array.isArray(plugins) ? plugins : [])
      .map((plugin, index) => ({ plugin, index, state: resolvePluginCardState(plugin, ctx) }))
      .sort((left, right) => (pluginSortRank(left.state) - pluginSortRank(right.state)) || (left.index - right.index))
      .map((entry) => entry.plugin);

    /** 自家插件（DSH-Au 仓库维护，含 dsh-au-* 系列）在列表里单独标识，不和社区插件混同。 */
    const isOwnDshPlugin = (plugin) => /^(@[^/]+\/)?dsh-au(-|$)/i.test(String(plugin?.package || ''));

    /**
     * 判断当前子进程输出是否在等待用户输入。
     * 1. 只读菜单（如额度查询）绝不等待输入，直接豁免，避免并发多任务时产生幽灵交互框。
     * 2. 选项匹配严格排除金额/百分比等浮点数（45.28、100.00%），仅识别真实序号格式。
     */
    const getChildInputGuide = (item, logs) => {
      if (item?.readonly) return null;
      const latestPrompt = [...(logs || [])].reverse().map((entry) => String(entry?.text || '')).find((line) => line.trim()) || '';
      const asksForChoice = /请选择|选项|序号|输入.*(?:编号|数字)|(?:^|\s)\[?\d+[)\]、]|(?:^|\s)\d+\.(?!\d)/i.test(latestPrompt);
      const asksForConfirmation = /\[\s*y\s*\/\s*n\s*\]|确认|是否继续|continue/i.test(latestPrompt);
      if (asksForChoice) return { text: '当前子进程正在等待选项序号；可直接选择 1 或 2，也可输入其它编号。', quick: [['选项 1', '1'], ['选项 2', '2'], ['回车默认', '']] };
      if (asksForConfirmation || item?.confirm) return { text: '当前子进程正在等待确认；发送 y 继续、n 取消，或按回车采用默认项。', quick: [['✓ 确认 (y)', 'y'], ['✕ 取消 (n)', 'n'], ['回车默认', '']] };
      if (item?.needsChildInput) return { text: '当前子进程正在等待输入；请按终端提示填写内容或选择序号。', quick: [['选项 1', '1'], ['选项 2', '2'], ['回车默认', '']] };
      return null;
    };
