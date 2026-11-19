# 子路径反代（Caddy）漏放行 `/dsh-au-todo/*` 导致移动端远端工作区空白

> 通过 `/dsh/` 子路径入口（如 IPv6 Caddy）访问 DSH 时，若反代白名单仅放行 `/dsh-au/*` 而漏掉 `/dsh-au-todo/*`，会导致顶栏设备正常在线、但侧边栏远端工作区与跨设备待办静默空白。
> 来源: 原文核实于 2026-11-04 移动端经子路径反代访问 Windows DSH 的实机排障与 Caddy 配置修复 · 更新: 2026-11-17

## 一句话结论

**所有挂载在 `/dsh/` 子路径下的反向代理（如 Caddy），只要采用显式路径白名单，必须同时将 `/dsh-au/*` 与 `/dsh-au-todo/*` 原样直通转发给本地 `3080` 桥接。**

## 故障表现

- **电脑直连或内网穿透根路径访问正常**：侧边栏能看到局域网 Mac 的全部远端工作区与会话。
- **手机访问 Mac 的 `/dsh/` 入口正常**：侧边栏能看到 Windows 的远端工作区。
- **唯独手机访问 Windows 的 `/dsh/` 入口异常**：顶部设备栏能看到局域网 Mac 在线，但左侧抽屉侧边栏完全没有远端工作区，且 `desktop-web-bridge.log` 中看不到任何 `/dsh-au-todo/api` 请求记录。

## 已核实原因

| 环节 | 事实 |
| --- | --- |
| 前端请求路径 | `dsh-au` 客户端以域名根路径请求两类后端接口：`fetch('/dsh-au/api')`（顶栏设备状态）与 `fetch('/dsh-au-todo/api')`（侧边栏远端工作区树 + 跨设备 Todo） |
| 桌面端与移动端差异 | 桌面端可借助后台保活受控 iframe（通道 B）补充工作区快照；移动端采用直接导航（`useDirectNavigation = true`），不挂载受控 iframe，100% 依赖通道 A（`/dsh-au-todo/api`） |
| Mac 与 Windows 反代差异 | Mac 的 Caddy 配置了同域名根路径兜底反代（`handle { reverse_proxy ... }`）；Windows 的 Caddy 采用显式白名单，仅写了 `handle /dsh-au/*` 与 `handle_path /dsh/*`，其余路径一律 `respond "Not Found" 404` |
| 拦截现场 | `/dsh-au-todo/api` 因前缀为 `/dsh-au-todo/`，无法命中 `/dsh-au/*`，在 Caddy 层直接返回 `404`，请求根本未到达 `127.0.0.1:3080` 桥接服务 |

## 修复方式与排查命令

在 Windows Caddy 配置（如 `<caddy-dir>/Caddyfile`）中，使用命名匹配器同时放行两个根路径接口前缀：

```caddyfile
@dsh_au_api path /dsh-au/* /dsh-au-todo/*
handle @dsh_au_api {
	reverse_proxy 127.0.0.1:3080 {
		header_up Host {host}
	}
}
```

排查子路径反代是否漏放行接口时，不要只看 `desktop-web-bridge.log`（被前置反代拦截的请求不会进桥接日志），应直接向反代端口探测两个接口的 HTTP 状态码（未带认证时到达桥接应返回 `401`，返回 `404` 说明被前置反代拦截）：

> - macOS / Linux (Bash)
> - 探测目标 IPv6 Caddy 入口是否已将两类接口全部转发到 3080 桥接（返回 401 为已转发，404 为被拦截）

```bash
curl -sk -o /dev/null -w "dsh-au/api: %{http_code}\n" "https://dsh.example.com:8443/dsh-au/api"
curl -sk -o /dev/null -w "dsh-au-todo/api: %{http_code}\n" -X POST "https://dsh.example.com:8443/dsh-au-todo/api"
```

> - Windows (PowerShell)
> - 在本机绕过公网 DNS 直接探测本地 8443 Caddy 路由（返回 401 为已转发，404 为被拦截）

```bash
curl.exe -sk --resolve "dsh.example.com:8443:[::1]" -o NUL -w "dsh-au/api: %{http_code}`n" "https://dsh.example.com:8443/dsh-au/api"
curl.exe -sk --resolve "dsh.example.com:8443:[::1]" -o NUL -w "dsh-au-todo/api: %{http_code}`n" -X POST "https://dsh.example.com:8443/dsh-au-todo/api"
```

## 关联

**相关页面**：

- [DSH-AU 本地服务、云同步服务与插件注册规范](../domain/dsh-au-service-plugin-registration.md) — `dsh_caddy_ipv6` 与 `dsh_bridge` 服务的注册与纳管边界。

**源码**：

- `client/src/03-routes.js`
- `client/src/14-todo.js`
- `client/src/14a-remote-workspaces.js`
- `lib/todo/index.js`
