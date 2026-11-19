# dsh-au

`dsh-au` 是面向 DeepSeek Harness (DSH) 的多机工作台增强插件，集成本机/远程设备二级工作区、跨设备待办 (Todo)、模型快捷切换、移动端适配抽屉、本地服务/云插件管理，以及仅限本机调用的 Codex Agent 客户端控制入口。

## 核心功能

- **多机顶栏与二级工作区**：顶栏一键切换本机与局域网/隧道远程 DSH 设备（支持后台会话预加载与锁屏自动断连省电）；左侧栏按「本机 / 远程设备」二级分组展示各设备工作区与实时会话状态。
- **跨设备 Todo 待办**：在侧边栏直接管理跨设备同步的待办事项，支持绑定具体设备、工作区或对话并一键跳转执行。
- **模型快捷切换（1–9 槽位）**：通过快捷键（默认 `Alt+M`）呼出轻量模型面板，支持本机与受控远程 iframe 会话的 1–9 数字键秒切模型与思考强度。
- **多机工作台与云同步**：管理本机常驻服务（启停、开机自启、随 DSH 自启、异常自愈）、云插件快照跨机一键复刻，以及支持从私人同步仓库（`syncRepoRoot`）零侵入挂载自定义工作台扩展页面。
- **移动端抽屉适配**：针对手机浏览器触控视口自动折叠顶栏与侧边抽屉，优化窄屏操作体验。
- **本机 Agent 控制命令（`dsh-au-client-control`）**：允许本机 Agent 通过安全命名管道 / Unix Socket 向当前 DSH 的 Codex 会话发送任务并原样获取回复。

## 安装方式

### 方式一：通过 DSH 插件市场或 CLI 安装

在 DSH 可视化插件市场（`dshmarket`）搜索 `dsh-au` 一键安装，或在终端执行：

> - macOS / Linux / Windows (PowerShell)
> - 通过 DSH CLI 安装插件

```bash
dsh plugin add dsh-au
```

### 方式二：从源码本地安装

在仓库根目录运行本地安装器（或通过已安装机器的「工作台 → 插件管理 → 云插件 → dsh-au → 同步到当前电脑」安装）。安装器会在目标 DSH profile 的 `node_modules/.bin` 下生成 `dsh-au-client-control` 命令，并自动绑定该 profile。

> - macOS / Linux / Windows (PowerShell)
> - 从本仓库任意目录安装到默认 `desktop` profile

```bash
node "$(git rev-parse --show-toplevel)/scripts/install-local.mjs" --profile desktop
```

安装或更新后完全重启 DSH，让服务端与 Codex 本机端点加载新版本。如需跨电脑同步个人服务、云插件快照或挂载私人扩展页，请参考 [sync/README.md](sync/README.md) 在工作台设置中配置 `syncRepoRoot`。

## 安全边界

- 控制入口只使用 Windows named pipe 或 Unix socket，不注册 HTTP 路由，不接受局域网和远端网页代发消息。
- 每个 DSH profile 使用独立端点和随机令牌；请求编号用于防止超时重试或并发调用重复发送。
- 本机状态保存在 `~/.dsh/dsh-au/client-control/`，不进入 Git；不会把 Codex 回复正文写进请求账本。

## 禁止 AI 新建目标

在工作台设置中开启「禁止 AI 新建目标」，dsh-au 会在宿主工具执行层阻止 AI 调用 `create_goal`，包括子代理和嵌套工具调用；不依赖 AI 是否遵守提示。默认关闭，开启后对这台宿主的后续调用立即生效；可以随现有 dsh-au 配置同步流程跨电脑同步。

此开关只管新建：不会暂停、清除或修改旧目标，也不限制 `get_goal` 或 `update_goal`（包括恢复）。普通任务、待办和错误重试不受影响。它不拦截用户直接通过 DSH 原生界面或其他插件创建目标；远程宿主需要加载新版插件并开启自己的开关。

插件首次更新仍需由宿主重新加载服务端代码；只刷新页面不能替代服务端重载。宿主不支持工具执行拦截时，开启会明确报错，不会显示成已经成功拦截。

## 工作台常用设置

- **错误自动续跑规则**：在工作台设置中可按 HTTP 状态码或错误关键词配置自动重试（支持延迟重试、压缩上下文后重试及追加提示词），出厂默认不预置规则，按需开启。
- **模型目录同步**：配置 `syncRepoRoot` 后，可在工作台「官方设置」中按私人同步仓库的清单刷新 DSH / Codex 模型目录；仅更新目录，不会覆盖当前选中模型、思考强度或 API Key。
- **锁屏自动断连**：可按本机需要开启锁屏时自动断开远端 DSH 连接，减少后台重连耗电（仅在本机生效，不同步到云端）。

## 自检与排障（Doctor）

插件内置只读诊断脚本 `scripts/doctor.mjs`，可用于检查本机已登记服务的路径、健康地址、自启入口以及私人扩展页契约（不会修改配置或启停服务）：

> - macOS / Linux / Windows (PowerShell)
> - 在插件根目录执行只读自检

```bash
node scripts/doctor.mjs
# 或
npm run doctor
```

排查私人工作台扩展页时，追加 `--extensions`：

```bash
npm run doctor -- --extensions
```

## 文档导航

- 多机同步、服务/远程设备/云插件注册：[sync/README.md](sync/README.md)
- 模型快捷切换与排序说明：[docs/模型快捷切换界面与排序说明.md](docs/模型快捷切换界面与排序说明.md)
- 远端模型快捷切换兼容说明：[docs/远端模型快捷切换兼容说明.md](docs/远端模型快捷切换兼容说明.md)
- 私人工作台扩展页契约：[docs/wiki/domain/private-extensions-contract.md](docs/wiki/domain/private-extensions-contract.md)

## Codex：新建或继续 DSH 会话

Codex 通过当前电脑正在运行的 DSH 原生会话接口工作，不点击桌面界面。省略 `--session-id` 时创建新会话；提供会话编号时继续原会话。

> - Windows PowerShell
> - 新建 Codex 会话，发送内容并输出完整回复

```bash
& "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\.bin\dsh-au-client-control.ps1" --provider codex --action prompt --text "回复我 OK" --cwd "F:\path\to\project" --request-id "codex-new-001" --timeout-ms 180000
```

> - macOS / Linux
> - 新建 Codex 会话，发送内容并输出完整回复

```bash
"$HOME/.dsh/profiles/desktop/node_modules/.bin/dsh-au-client-control" --provider codex --action prompt --text "回复我 OK" --cwd "/path/to/project" --request-id "codex-new-001" --timeout-ms 180000
```

Codex 超时后同样使用原请求编号重试；系统只读取原会话结果，不会再建一个会话或重复发送。`--action capabilities` 可检查当前 DSH 是否提供 Codex 控制能力。

## 平台边界

- Windows / macOS / Linux：Codex 均通过 DSH 原生会话接口在支持的平台上使用。
