    // 表单仅接受用户主动点击聚焦，打开时不自动呼出移动端键盘。
    function AuthPromptCard({ dev, onSave }) {
      const [username, setUsername] = useState(dev.username || '');
      const [password, setPassword] = useState('');
      const [saving, setSaving] = useState(false);

      const submit = async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
          await onSave({ id: dev.id, deviceId: dev.deviceId, type: dev.type || dev.transport, url: dev.originUrl, username, password });
        } finally {
          setSaving(false);
        }
      };

      return h(
        'div',
        { className: 'dsh-au-center' },
        h(
          'form',
          { className: 'dsh-au-card', onSubmit: submit },
          h('strong', { style: { fontSize: '15px' } }, `🔒 远程设备需要账号密码：${dev.name}`),
          h('div', { style: { fontSize: '12px', color: '#9ca3af' } }, `地址：${dev.originUrl}（保存后本机代理将自动携带 Basic Auth 请求头，无需重复输入）`),
          h('input', { className: 'dsh-au-input', placeholder: 'Basic Auth 账号', value: username, onChange: (e) => setUsername(e.target.value), autoFocus: false }),
          h('input', { className: 'dsh-au-input', type: 'password', placeholder: 'Basic Auth 密码', value: password, onChange: (e) => setPassword(e.target.value) }),
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } },
            h('button', { type: 'submit', className: 'dsh-au-btn primary', disabled: saving }, saving ? '连接中...' : '保存并接入')
          )
        )
      );
    }

    /** 已有凭据但当前路径不可用时只说明连通性，不再引导用户重复填写密码。 */
    function UnavailableCard({ dev }) {
      return h(
        'div',
        { className: 'dsh-au-center' },
        h('div', { className: 'dsh-au-card' }, [
          h('strong', { key: 'title', style: { fontSize: '15px' } }, `无法访问远程设备：${dev.name}`),
          h('div', { key: 'hint', style: { fontSize: '12px', color: '#9ca3af' } }, '已保留本机凭据。请检查 VPN、当前网络或远端服务状态后再刷新。'),
        ])
      );
    }

    /** 手动设备只保存名称；本机归属与密码分别由独立操作、本机配置处理。 */
    function DeviceModal({ initial, onClose, onSave }) {
      const [name, setName] = useState(initial?.name || '');
      const [err, setErr] = useState('');
      const submit = async (event) => {
        event.preventDefault();
        if (!name.trim()) { setErr('请输入设备名称'); return; }
        const result = await onSave({ id: initial?.id, name: name.trim() });
        if (result?.ok === false) { setErr(result.error || '保存失败'); return; }
        onClose();
      };
      return h('div', { className: 'dsh-au-mask', onClick: (event) => { if (event.target === event.currentTarget) onClose(); } },
        h('form', { className: 'dsh-au-card', onSubmit: submit }, [
          h('strong', { key: 'title', style: { fontSize: '15px' } }, initial?.id ? '编辑手动设备' : '新增手动设备'),
          err ? h('div', { key: 'error', style: { color: '#f87171', fontSize: '12px' } }, err) : null,
          h('input', { key: 'name', className: 'dsh-au-input', placeholder: '设备名称，如 example-mac', value: name, onChange: (event) => setName(event.target.value), autoFocus: false }),
          h('div', { key: 'actions', style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } }, [
            h('button', { key: 'cancel', type: 'button', className: 'dsh-au-btn', onClick: onClose }, '取消'),
            h('button', { key: 'save', type: 'submit', className: 'dsh-au-btn primary' }, '保存'),
          ]),
        ]));
    }

    /** 每条路径都显式选择所属设备与访问方式；不会从地址或名称推断归属。 */
    function RouteModal({ initial, devices, onClose, onSave, onDelete }) {
      const [deviceId, setDeviceId] = useState(initial?.deviceId || devices[0]?.id || '');
      const [type, setType] = useState(initial?.type || initial?.transport || 'tunnel');
      const [url, setUrl] = useState(initial?.originUrl || initial?.url || '');
      const [username, setUsername] = useState(initial?.username || '');
      const [password, setPassword] = useState('');
      const [proxyUrl, setProxyUrl] = useState(initial?.upstreamProxyUrl ?? initial?.proxyUrl ?? '');
      const [err, setErr] = useState('');
      const needsUrl = type !== 'local';
      const submit = async (event) => {
        event.preventDefault();
        if (!deviceId) { setErr('请选择所属设备'); return; }
        if (needsUrl && !url.trim()) { setErr('请输入路径地址'); return; }
        const result = await onSave({ id: initial?.id, deviceId, type, url: needsUrl ? url.trim() : undefined, username: username.trim(), password, proxyUrl: type === 'tunnel' ? proxyUrl.trim() : '' });
        if (result?.ok === false) { setErr(result.error || '保存失败'); return; }
        onClose();
      };
      const remove = async () => {
        const result = await onDelete({ id: initial.id, deviceId });
        if (result?.ok === false) { setErr(result.error || '删除失败'); return; }
        onClose();
      };
      return h('div', { className: 'dsh-au-mask', onClick: (event) => { if (event.target === event.currentTarget) onClose(); } },
        h('form', { className: 'dsh-au-card', onSubmit: submit }, [
          h('strong', { key: 'title', style: { fontSize: '15px' } }, initial?.id ? '编辑连接路径' : '新增连接路径'),
          err ? h('div', { key: 'error', style: { color: '#f87171', fontSize: '12px' } }, err) : null,
          h('select', { key: 'device', className: 'dsh-au-input', value: deviceId, onChange: (event) => setDeviceId(event.target.value) }, devices.map((device) => h('option', { key: device.id, value: device.id }, device.name))),
          h('select', { key: 'type', className: 'dsh-au-input', value: type, onChange: (event) => setType(event.target.value) }, [
            h('option', { key: 'local', value: 'local' }, '本机直连'),
            h('option', { key: 'lan', value: 'lan' }, '局域网'),
            h('option', { key: 'ipv6', value: 'ipv6' }, 'IPv6'),
            h('option', { key: 'tunnel', value: 'tunnel' }, '内网穿透'),
          ]),
          needsUrl ? h('input', { key: 'url', className: 'dsh-au-input', placeholder: type === 'lan' ? '局域网地址，如 http://my-mac.local:31990/' : '地址，如 https://dsh.example.com/', value: url, onChange: (event) => setUrl(event.target.value), autoFocus: false }) : h('div', { key: 'local-note', style: { color: '#94a3b8', fontSize: '12px' } }, '本机直连不保存地址；在该设备本机设为“本机设备”后自动可用。'),
          needsUrl ? h('input', { key: 'user', className: 'dsh-au-input', placeholder: 'Basic Auth 账号（免密留空）', value: username, onChange: (event) => setUsername(event.target.value) }) : null,
          needsUrl ? h('input', { key: 'password', className: 'dsh-au-input', type: 'password', placeholder: initial?.hasCredentials ? '密码（留空保持本机原密码）' : 'Basic Auth 密码（仅保存在本机）', value: password, onChange: (event) => setPassword(event.target.value) }) : null,
          type === 'tunnel' ? h('input', { key: 'proxy', className: 'dsh-au-input', placeholder: 'Clash HTTP/mixed-port（仅本机），如 http://127.0.0.1:7890', value: proxyUrl, onChange: (event) => setProxyUrl(event.target.value) }) : null,
          type === 'tunnel' ? h('div', { key: 'proxy-note', style: { color: '#94a3b8', fontSize: '12px' } }, '只代理这条内网穿透路径；局域网和 IPv6 路径仍直连。留空则直连。') : null,
          h('div', { key: 'actions', style: { display: 'flex', justifyContent: 'space-between', gap: '8px', marginTop: '4px' } }, [
            initial?.id ? h('button', { key: 'delete', type: 'button', className: 'dsh-au-btn off', onClick: remove }, '删除此路径') : h('span', { key: 'spacer' }),
            h('div', { key: 'confirm', style: { display: 'flex', gap: '8px' } }, [
              h('button', { key: 'cancel', type: 'button', className: 'dsh-au-btn', onClick: onClose }, '取消'),
              h('button', { key: 'save', type: 'submit', className: 'dsh-au-btn primary' }, '保存'),
            ]),
          ]),
        ]));
    }

    /** 设置/修改本机局域网接入密码；已设置时要求先输入当前密码。 */
    function LanPasswordForm({ passwordSet, onSave, onDone }) {
      const [current, setCurrent] = useState('');
      const [next, setNext] = useState('');
      const [confirm, setConfirm] = useState('');
      const [err, setErr] = useState('');
      const [saving, setSaving] = useState(false);
      const submit = async (event) => {
        event.preventDefault();
        if (next !== confirm) { setErr('两次输入的新密码不一致'); return; }
        setSaving(true);
        try {
          const result = await onSave({ currentPassword: current, password: next });
          if (result?.ok === false) { setErr(result.error || '保存失败'); return; }
          onDone();
        } finally {
          setSaving(false);
        }
      };
      return h('form', { className: 'dsh-au-lan-password-form', onSubmit: submit, style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' } }, [
        err ? h('div', { key: 'error', style: { color: '#f87171', fontSize: '12px' } }, err) : null,
        passwordSet ? h('input', { key: 'current', className: 'dsh-au-input', type: 'password', autoComplete: 'current-password', placeholder: '当前密码', value: current, onChange: (event) => setCurrent(event.target.value) }) : null,
        h('input', { key: 'next', className: 'dsh-au-input', type: 'password', autoComplete: 'new-password', placeholder: '新密码（至少 4 位）', value: next, onChange: (event) => setNext(event.target.value) }),
        h('input', { key: 'confirm', className: 'dsh-au-input', type: 'password', autoComplete: 'new-password', placeholder: '再输一次新密码', value: confirm, onChange: (event) => setConfirm(event.target.value) }),
        h('div', { key: 'actions', style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } }, [
          h('button', { key: 'cancel', type: 'button', className: 'dsh-au-btn', onClick: onDone }, '取消'),
          h('button', { key: 'save', type: 'submit', className: 'dsh-au-btn primary', disabled: saving }, saving ? '保存中...' : '保存密码'),
        ]),
      ]);
    }

    /** 集中查看手动设备及其全部路径，并收纳本机局域网共享与扫描操作；密码不会进入列表。 */
    function RemoteManagerModal({ devices, self, lanOn, scanning, onToggleLan, onSaveLanPassword, onDiscover, onClose, onEdit, onEditDevice, onAddDevice, onAddRoute, onSetLocal, currentConnections }) {
      // 每个设备都有独立的当前通道；直接打开弹窗时也能显示可用路径标签。
      const currentRouteIds = currentConnections || resolveCurrentConnections(devices, self, typeof window === 'undefined' ? '' : window.location.href);
      // 本机只把原 LAN 行显示为「本机」，所有设备都不再单列 local / 回环入口。
      const visibleRoutes = (device) => (device.routes || []).filter((route) => route.kind !== 'local');
      const routeCount = devices.reduce((count, device) => count + visibleRoutes(device).length, 0);
      const [copiedRouteId, setCopiedRouteId] = useState('');
      const [editingLanPassword, setEditingLanPassword] = useState(false);
      const lanPasswordSet = Boolean(self?.lanPasswordSet);
      const renderRoute = (route, deviceStatus) => {
        const statusDiff = (route.status || 'unknown') !== deviceStatus;
        const routeUrl = route.originUrl || route.url || '';
        const copy = async () => {
          if (await copyConnectionUrl(routeUrl)) {
            setCopiedRouteId(route.id);
            window.setTimeout(() => setCopiedRouteId((current) => current === route.id ? '' : current), 1200);
          }
        };
        const main = h(route.editable ? 'button' : 'div', {
          key: 'main',
          className: `dsh-au-remote-row-main${route.editable ? ' dsh-au-remote-row-edit' : ''}`,
          ...(route.editable ? { type: 'button', onClick: () => onEdit(route), title: `编辑连接路径：${route.name}` } : {}),
        }, [
          // 每台设备只在标题保留状态灯；实际使用的路径用文字标签区分。
          h('span', { key: 'name', className: 'dsh-au-remote-row-name' }, [
            h('span', { key: 'label' }, formatRouteBadge(route)),
            currentRouteIds[route.deviceId] === route.id
              ? h('span', { key: 'current', className: 'dsh-au-tone-badge', 'data-tone': 'blue', 'aria-label': '当前正在使用的连接路径' }, '当前')
              : null,
          ]),
          h('span', { key: 'url', className: 'dsh-au-remote-row-url' }, routeUrl),
        ]);
        const actions = [
          statusDiff ? h('span', { key: 'state', className: 'dsh-au-remote-row-state' }, formatStatusLabel(route.status)) : null,
          routeUrl ? h('button', { key: 'copy', type: 'button', className: 'dsh-au-btn dsh-au-copy-link', onClick: copy, title: '复制连接地址' }, copiedRouteId === route.id ? '已复制' : '复制') : null,
        ];
        return h('div', { key: route.id, className: 'dsh-au-remote-row dsh-au-remote-route', 'data-status-diff': String(statusDiff) }, [
          main,
          h('span', { key: 'actions', className: 'dsh-au-remote-row-actions' }, actions),
        ]);
      };
      return h(
        'div',
        { className: 'dsh-au-mask', onClick: (event) => { if (event.target === event.currentTarget) onClose(); } },
        h(
          'section',
          { className: 'dsh-au-card dsh-au-remote-manager', role: 'dialog', 'aria-modal': true, 'aria-label': '设备与连接路径管理' },
          [
            h('div', { key: 'head', className: 'dsh-au-remote-manager-head' }, [
              h('div', { key: 'title', className: 'dsh-au-remote-manager-title' }, [
                h('strong', { key: 'heading' }, '设备与连接路径'),
                h('span', { key: 'count' }, `已发现 ${devices.length} 台设备 · ${routeCount} 条连接路径`),
              ]),
              h('div', { key: 'actions', className: 'dsh-au-remote-manager-actions' }, [
                h('button', { key: 'add', type: 'button', className: 'dsh-au-btn primary', onClick: onAddDevice }, '新增设备'),
                h('button', { key: 'close', type: 'button', className: 'dsh-au-btn', onClick: onClose }, '关闭'),
              ]),
            ]),
            // 局域网控制卡与设备卡片统一置于同一滚动列表内，保证左右 16px 边距与内部 14px 基线完全对齐。
            h('div', { key: 'list', className: 'dsh-au-remote-list' }, [
              h('section', { key: 'lan-control', className: 'dsh-au-remote-device dsh-au-lan-control' }, [
                h('div', { key: 'main', className: 'dsh-au-lan-control-main' }, [
                  h('span', { key: 'label', className: 'dsh-au-remote-row-name' }, [
                    h(LanIcon, { key: 'icon' }),
                    h('span', { key: 'text' }, '本机局域网接入'),
                  ]),
                  h('span', { key: 'hint', className: 'dsh-au-remote-row-state' }, !lanPasswordSet
                    ? '尚未设置接入密码；先设置密码才能开启局域网接入。'
                    : (lanOn ? '已开启：局域网设备需在“局域网”路径里填写本机接入密码（账号随意）才能连接。' : '已关闭；开启后局域网设备凭接入密码连接本机。')),
                ]),
                h('span', { key: 'actions', className: 'dsh-au-lan-control-actions' }, [
                  h('button', { key: 'password', type: 'button', className: 'dsh-au-btn', onClick: () => setEditingLanPassword((value) => !value), title: '设置或修改局域网接入密码' }, lanPasswordSet ? '修改密码' : '设置密码'),
                  h('button', { key: 'toggle', disabled: !lanPasswordSet && !lanOn, type: 'button', className: `dsh-au-btn ${lanOn ? 'on' : 'off'}`, 'aria-pressed': lanOn, onClick: onToggleLan, title: `局域网接入：${lanOn ? '已开启' : '已关闭'}` }, lanOn ? '已开启' : '已关闭'),
                  h('button', { key: 'scan', type: 'button', className: 'dsh-au-btn', disabled: scanning, onClick: () => { void onDiscover(); }, title: scanning ? '正在扫描局域网' : '扫描局域网' }, scanning ? '扫描中...' : '扫描'),
                ]),
                editingLanPassword
                  ? h(LanPasswordForm, { key: 'password-form', passwordSet: lanPasswordSet, onSave: onSaveLanPassword, onDone: () => setEditingLanPassword(false) })
                  : null,
              ]),
              ...(devices.length
                ? devices.map((device) => h(
                  'section',
                  { key: device.id, className: 'dsh-au-remote-device' },
                  [
                    h('div', { key: 'device-head', className: 'dsh-au-remote-device-head' }, [
                      h('span', { key: 'name', className: 'dsh-au-remote-row-name' }, [
                        h('span', { key: 'dot', className: `dsh-au-dot ${device.status}` }),
                        h('span', { key: 'label' }, device.name),
                      ]),
                      h('span', { key: 'actions', style: { display: 'inline-flex', alignItems: 'center', gap: '8px' } }, [
                        h('button', { key: 'add', type: 'button', className: 'dsh-au-btn primary', onClick: () => onAddRoute(device), title: `为 ${device.name} 新增连接路径` }, '新增路径'),
                        h('button', { key: 'edit-device', type: 'button', className: 'dsh-au-btn', onClick: () => onEditDevice(device), title: `编辑 ${device.name}` }, '编辑设备'),
                        h('button', { key: 'local', type: 'button', className: `dsh-au-btn ${self?.deviceId === device.id ? 'on' : ''}`, onClick: () => onSetLocal(device.id), title: `将 ${device.name} 设为本机设备` }, self?.deviceId === device.id ? '本机设备' : '设为本机'),
                        h('span', { key: 'status', className: 'dsh-au-remote-row-state' }, formatStatusLabel(device.status)),
                      ]),
                    ]),
                    h('div', { key: 'routes', className: 'dsh-au-remote-device-routes' }, visibleRoutes(device).map((route) => renderRoute(route, device.status))),
                  ]
                ))
                : [h('div', { key: 'empty', className: 'dsh-au-remote-empty' }, '暂无远程配置，点击“新增”添加设备。')]),
            ]),
          ]
        )
      );
    }

