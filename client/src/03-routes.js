    function getRouteTransportRank(route) {
      if (route.kind === 'lan' || route.transport === 'lan') return 3;
      if (route.transport === 'ipv6') return 2;
      return 1;
    }

    function isRouteReady(route) {
      return route.online !== false && route.status !== 'offline' && route.status !== 'needs_auth';
    }

    /** 所有设备视图共用同一选路排序，避免“当前优选”与连接列表相互矛盾。 */
    function sortRoutesByPreference(routes) {
      return [...routes].sort((a, b) => {
        const readyDiff = Number(isRouteReady(b)) - Number(isRouteReady(a));
        if (readyDiff !== 0) return readyDiff;
        return getRouteTransportRank(b) - getRouteTransportRank(a);
      });
    }

    /** 当前页面入口决定可达路线，避免手机沿用控制端电脑的 LAN 优先级。 */
    function resolveCurrentAccessRoute(remotes, href) {
      try {
        const current = new URL(href);
        if (current.hostname === '127.0.0.1' || current.hostname === 'localhost' || current.hostname === '[::1]') {
          return { transport: 'local', badge: '直连' };
        }
        for (const remote of remotes || []) {
          const target = new URL(remote.originUrl || remote.url);
          if (target.origin === current.origin) {
            const transport = ['lan', 'ipv6', 'tunnel'].includes(remote.transport)
              ? remote.transport
              : (current.protocol === 'http:' ? 'lan' : 'tunnel');
            const matched = { ...remote, transport };
            return { ...matched, badge: formatRouteBadge(matched) };
          }
        }
        if (current.protocol === 'http:') return { transport: 'lan', badge: '局域网' };
        // 未登记的公网 HTTPS 入口也不是本机，不能向远端浏览器公布宿主回环地址。
        if (current.protocol === 'https:') return { transport: 'tunnel', badge: '内网穿透' };
      } catch {}
      return { transport: 'local', badge: '直连' };
    }

    function selectRouteForCurrentAccess(routes, accessTransport = 'local') {
      const ready = routes.filter(isRouteReady);
      // 只要已有明确探活成功的路由，就不允许尚未完成探活（status === 'unknown'）的路由抢占当前已连通通道，避免冷启动或重连时无谓抖动。
      const confirmedReady = ready.filter((item) => item.status && item.status !== 'unknown');
      const candidates = confirmedReady.length > 0 ? confirmedReady : ready;
      const preference = accessTransport === 'lan'
        ? ['lan', 'ipv6', 'tunnel']
        : accessTransport === 'ipv6' ? ['ipv6', 'tunnel'] : accessTransport === 'tunnel' ? ['tunnel'] : ['lan', 'ipv6', 'tunnel'];
      for (const transport of preference) {
        const route = candidates.find((item) => (item.transport || item.kind) === transport);
        if (route) return route;
      }
      return sortRoutesByPreference(routes)[0] || null;
    }

    function getRouteTargetUrl(route, useDirectNavigation) {
      if (!route) return '';
      if (route.kind === 'lan' || route.transport === 'lan') return route.url || route.originUrl || '';
      return useDirectNavigation ? (route.originUrl || route.url || '') : buildRemoteTargetUrl(route);
    }

    function formatRouteTransportLabel(route) {
      // 本机查看自己的 LAN 路径只改展示名称，不改变路径类型或地址。
      if (route?.isLocalView) return '本机';
      if (route?.kind === 'local' || route?.transport === 'local') return '本机';
      if (route?.kind === 'lan' || route?.transport === 'lan') return '局域网';
      if (route?.transport === 'ipv6') return 'IPv6 连接';
      if (route?.transport === 'tunnel') return '内网穿透';
      return '连接';
    }

    function formatRouteBadge(route) {
      if (route.isLocalView) return '本机';
      if (route.kind === 'local' || route.transport === 'local') return '本机';
      if (route.kind === 'lan' || route.transport === 'lan') return '局域网';
      if (route.status === 'needs_auth') return '待填账密';
      if (route.status === 'offline') return '无法访问';
      const prefix = formatRouteTransportLabel(route);
      if (route.status === 'unknown') return `${prefix} · 状态未知`;
      return prefix;
    }

    /** 将内部状态转为可扫视的文字，状态灯和文字始终使用同一语义。 */
    function formatStatusLabel(status) {
      return ({ idle: '空闲', busy: '执行中', waiting: '等待你操作', done: '待确认', error: '执行报错', offline: '无法访问', needs_auth: '待填账密', unknown: '状态未知' })[status] || '状态未知';
    }

    /** 已绑定本机，或公共 lan 地址就是本机网卡时，顶部标签不再重复画这台设备。 */
    function isSelfDevice(device, self) {
      if (self?.deviceId && device.id === self.deviceId) return true;
      const ips = new Set((self?.ips || []).filter((ip) => typeof ip === 'string'));
      if (!ips.size) return false;
      return (device.routes || []).some((route) => {
        if (route.kind !== 'lan' && route.transport !== 'lan' && route.type !== 'lan') return false;
        try { return ips.has(new URL(route.url || route.originUrl || '').hostname); } catch { return false; }
      });
    }

    /**
     * 设备归属完全由云清单 manifest.cloud.json 的 devices[].routes[] 决定。
     * 局域网发现与远端身份只补充单条已登记路径的运行状态，绝不创建或合并设备。
     */
    function buildManualDeviceViews(self, definitions, remotes, accessTransport = 'local') {
      const runtimeByRouteId = new Map((remotes || []).map((route) => [route.id, route]));
      const statusRank = { error: 6, waiting: 5, busy: 4, done: 3, idle: 2, unknown: 1, needs_auth: 1, offline: 0 };
      return (definitions || []).map((definition) => {
        const isLocalDevice = definition.id === self?.deviceId;
        // 只展示已登记的原路径，不为本机再合成一条回环地址。
        const routes = (definition.routes || []).map((route) => {
          if (route.type === 'local') {
            return {
              ...route,
              deviceId: definition.id,
              name: definition.name,
              kind: 'local',
              transport: 'local',
              // 旧 local 配置只保留归属与状态，不再把宿主回环地址放进连接列表。
              originUrl: '',
              url: '',
              // statusV2 含 waiting；旧版设备只有旧四值 status，缺字段时回落，行为不变。
              status: isLocalDevice ? self?.statusV2 || self?.status || 'idle' : 'offline',
              online: isLocalDevice,
              editable: route.editable !== false,
            };
          }
          const runtime = runtimeByRouteId.get(route.id);
          return {
            ...route,
            ...runtime,
            deviceId: definition.id,
            name: definition.name,
            kind: route.type === 'lan' ? 'lan' : 'remote',
            transport: route.type,
            // 仅本机浏览器查看本机时改名；LAN 地址、ID 和远程选路保持原样。
            isLocalView: isLocalDevice && accessTransport === 'local' && route.type === 'lan',
            originUrl: runtime?.originUrl || route.url,
            status: runtime?.statusV2 || runtime?.status || 'offline',
            online: runtime?.online !== false,
            editable: true,
          };
        });
        const routesByPreference = sortRoutesByPreference(routes);
        const connectable = routesByPreference.filter((route) => route.type !== 'local' && route.transport !== 'local');
        const selectedRoute = selectRouteForCurrentAccess(connectable, accessTransport);
        const status = [...routesByPreference].sort((left, right) => (statusRank[right.status] ?? 0) - (statusRank[left.status] ?? 0))[0]?.status || 'offline';
        const typeSummary = [...new Set(routes.map((route) => formatRouteBadge(route)))].join(' · ');
        const useDirectNavigation = accessTransport !== 'local';
        return {
          id: definition.id,
          deviceId: definition.id,
          name: definition.name || '未命名设备',
          status,
          runningCount: selectedRoute?.runningCount || 0,
          routes: routesByPreference,
          selectedRoute,
          // 顶部标签直接显示按当前访问环境选出的通路，不能只把摘要藏在 hover 中。
          badge: selectedRoute ? formatRouteBadge(selectedRoute) : '无法访问',
          targetUrl: getRouteTargetUrl(selectedRoute, useDirectNavigation),
          useDirectNavigation,
          routeSummary: typeSummary || '尚未配置连接路径',
        };
      }).sort((left, right) => left.name.localeCompare(right.name));
    }

    /** 当前标签只认实际打开的远端路径或浏览器入口，不跟随后台优选和保活页变化。 */
    function resolveCurrentConnection(devices, self, href, activeDeviceId = null, openedRouteId = '', openedRouteUrl = '') {
      const device = (devices || []).find((item) => item.id === (activeDeviceId || self?.deviceId));
      if (!device) return null;
      let currentRoute = null;
      if (activeDeviceId) {
        // 桌面保活地址比最近选中的 ID 更可靠；移动端则由实际认证导航的 ID 决定。
        currentRoute = (device.routes || []).find((route) => openedRouteUrl
          ? getRouteTargetUrl(route, false) === openedRouteUrl
          : route.id === openedRouteId);
      } else {
        try {
          const current = new URL(href);
          if (['127.0.0.1', 'localhost', '[::1]'].includes(current.hostname)) {
            // 本机入口的「当前」标在原 LAN 行，不再依赖一条额外 local 行。
            currentRoute = (device.routes || []).find((route) => route.kind === 'lan' || route.transport === 'lan');
          } else {
            // 同域名可有根路径和 /dsh/ 两种入口，优先匹配更具体的路径。
            let matchedPathLength = -1;
            for (const route of device.routes || []) {
              if (route.kind === 'local') continue;
              try {
                const target = new URL(route.originUrl || route.url);
                const path = target.pathname.replace(/\/+$/, '') || '/';
                const matchesPath = current.pathname === path || current.pathname.startsWith(path === '/' ? '/' : `${path}/`);
                if (target.origin === current.origin && matchesPath && path.length > matchedPathLength) {
                  currentRoute = route;
                  matchedPathLength = path.length;
                }
              } catch {}
            }
          }
        } catch {}
      }
      return currentRoute ? { deviceId: device.id, routeId: currentRoute.id } : null;
    }

    /** 每台设备各标一条当前通路，不能只标当前选中的全局设备标签。 */
    function resolveCurrentConnections(devices, self, href, openedRouteIds = new Map(), directFrameRoutes = {}) {
      const browserConnection = resolveCurrentConnection(devices, self, href);
      return Object.fromEntries((devices || []).map((device) => {
        const recordedId = directFrameRoutes[device.id] || openedRouteIds.get(device.id);
        let route;
        if (device.id === self?.deviceId) {
          route = (device.routes || []).find((item) => item.id === browserConnection?.routeId);
        } else if (recordedId) {
          // 已打开/保活的设备使用实际记录，后台优选改变不能挪走标签。
          route = (device.routes || []).find((item) => item.id === recordedId);
        } else {
          route = device.selectedRoute && isRouteReady(device.selectedRoute) ? device.selectedRoute : null;
        }
        return [device.id, route && route.kind !== 'local' ? route.id : ''];
      }));
    }

    /** 根据浏览器当前访问域名匹配配置别名；域名访问本机时不要把它误写成“本机”。 */
    function resolveAccessLabel(remotes, href) {
      let currentHost = '';
      try { currentHost = new URL(href).host.toLocaleLowerCase(); } catch { return null; }
      for (const remote of remotes || []) {
        try {
          if (new URL(remote.originUrl || remote.url).host.toLocaleLowerCase() === currentHost) return remote.name || null;
        } catch {}
      }
      return null;
    }

    /** 将远程 originUrl 的子路径（如 /dsh/）与 query 合并到本机 proxyUrl，兼容未重启的旧代理实例 */
    function buildRemoteTargetUrl(r) {
      if (!r || !r.proxyUrl) return '';
      try {
        const orig = new URL(r.originUrl);
        const proxy = new URL(r.proxyUrl);
        if (orig.pathname && orig.pathname !== '/' && (!proxy.pathname || proxy.pathname === '/')) {
          proxy.pathname = orig.pathname.endsWith('/') ? orig.pathname : `${orig.pathname}/`;
        }
        if (orig.search && !proxy.search) {
          proxy.search = orig.search;
        }
        return proxy.href;
      } catch {
        return r.proxyUrl;
      }
    }

    async function callApi(action, payload = {}) {
      const isGet = !action || action === 'getState';
      const res = await fetch('/dsh-au/api', isGet
        ? { method: 'GET', cache: 'no-store' }
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action, ...payload }),
          }
      );
      const raw = await res.text();
      let data;
      try { data = raw ? JSON.parse(raw) : {}; } catch {
        throw new Error(`接口返回了非 JSON 内容（HTTP ${res.status}）`);
      }
      if (!res.ok) {
        const error = new Error(data?.error || `接口请求失败（HTTP ${res.status}）`);
        error.code = data?.code;
        error.recoveryRequired = Boolean(data?.recoveryRequired);
        throw error;
      }
      return data;
    }

    /**
     * 将底层通信路径（lan / tunnel / ipv6）映射为展示标签：
     * - lan -> 'Lan'
     * - tunnel / ipv4 -> 'ipv4'
     * - ipv6 -> 'ipv6'
     */
    function mapTransportToBadgeLabel(rawTransport, route = null) {
      const t = String(rawTransport || '').toLowerCase().trim();
      if (t === 'lan') return 'Lan';
      if (t === 'ipv6') return 'ipv6';
      if (t === 'tunnel' || t === 'ipv4') return 'ipv4';
      if (route) {
        const url = String(route.url || route.originUrl || '').toLowerCase();
        if (url.includes('ipv6') || url.includes('[') || route.remoteFamily === 'IPv6') return 'ipv6';
      }
      return '';
    }

    /** 根据远端 deviceId 解析出当前正在使用/就绪的通信路径标签（Lan、ipv4、ipv6）。 */
    function resolveDeviceConnectionTransport(deviceId) {
      const cleanId = String(deviceId || '').trim();
      if (!cleanId || cleanId === 'local') return '';

      const snap = typeof window !== 'undefined' ? window.__dshAuLastStateSnap : null;
      const selfDeviceId = String(snap?.self?.deviceId || snap?.localDeviceId || '').trim();
      const selfInstanceId = String(snap?.self?.instanceId || '').trim();
      if ((selfDeviceId && cleanId === selfDeviceId) || (selfInstanceId && cleanId === selfInstanceId)) return '';

      const deviceList = typeof window !== 'undefined' && Array.isArray(window.__dshAuAllDevices) && window.__dshAuAllDevices.length > 0
        ? window.__dshAuAllDevices
        : (typeof window !== 'undefined' && Array.isArray(window.__dshAuDevices) && window.__dshAuDevices.length > 0
            ? window.__dshAuDevices
            : (typeof window !== 'undefined' && Array.isArray(window.__dshAuLastStateSnap?.devices)
                ? window.__dshAuLastStateSnap.devices
                : []));

      const dev = deviceList.find((d) => d && (d.id === cleanId || d.deviceId === cleanId));
      if (dev?.isLocal === true || dev?.selectedRoute?.type === 'local' || dev?.selectedRoute?.kind === 'local') return '';
      const selected = dev?.selectedRoute;
      if (selected) {
        const label = mapTransportToBadgeLabel(selected.transport || selected.type || selected.kind, selected);
        if (label) return label;
      }

      if (dev && Array.isArray(dev.routes) && dev.routes.length > 0) {
        const onlineRoute = dev.routes.find((r) => r && r.online !== false && r.type !== 'local')
          || dev.routes.find((r) => r && r.type !== 'local');
        if (onlineRoute) {
          const label = mapTransportToBadgeLabel(onlineRoute.transport || onlineRoute.type || onlineRoute.kind, onlineRoute);
          if (label) return label;
        }
      }

      const remotes = (typeof window !== 'undefined' && Array.isArray(window.__dshAuLastStateSnap?.remotes))
        ? window.__dshAuLastStateSnap.remotes
        : [];
      const remote = remotes.find((r) => r && r.deviceId === cleanId && r.online !== false)
        || remotes.find((r) => r && r.deviceId === cleanId);
      if (remote) {
        const label = mapTransportToBadgeLabel(remote.transport || remote.type || remote.kind, remote);
        if (label) return label;
      }

      return '';
    }

