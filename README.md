# dsh-au

`dsh-au` 是面向 DeepSeek Harness (DSH) 的多机工作台增强插件，集成本机/远程设备二级工作区、跨设备待办 (Todo)、模型快捷切换、移动端适配抽屉、本地服务/云插件管理，以及仅限本机调用的 Claude Desktop / Codex Agent 客户端控制入口。

## 核心功能

- **多机顶栏与二级工作区**：顶栏一键切换本机与局域网/隧道远程 DSH 设备（支持后台会话预加载与锁屏自动断连省电）；左侧栏按「本机 / 远程设备」二级分组展示各设备工作区与实时会话状态。
- **跨设备 Todo 待办**：在侧边栏直接管理跨设备同步的待办事项，支持绑定具体设备、工作区或对话并一键跳转执行。
- **模型快捷切换（1–9 槽位）**：通过快捷键（默认 `Alt+M`）呼出轻量模型面板，支持本机与受控远程 iframe 会话的 1–9 数字键秒切模型与思考强度。
- **多机工作台与云同步**：管理本机常驻服务（启停、开机自启、随 DSH 自启、异常自愈）、云插件快照跨机一键复刻，以及支持从私人同步仓库（`syncRepoRoot`）零侵入挂载自定义工作台扩展页面。
- **移动端抽屉适配**：针对手机浏览器触控视口自动折叠顶栏与侧边抽屉，优化窄屏操作体验。
- **本机 Agent 控制命令（`dsh-au-client-control`）**：允许本机 Agent 通过安全命名管道 / Unix Socket 向 Claude Desktop 或当前 DSH 的 Codex 会话发送任务并原样获取回复。

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
- 本机状态保存在 `~/.dsh/dsh-au/client-control/`，不进入 Git；不会把 Claude/Codex 回复正文写进请求账本。
- Claude 发送前会核对目标聊天、上一回合、空草稿和项目环境。无法唯一确认时停止，不猜测、不覆盖草稿。

## 禁止 AI 新建目标

在工作台设置中开启「禁止 AI 新建目标」，dsh-au 会在宿主工具执行层阻止 AI 调用 `create_goal`，包括子代理和嵌套工具调用；不依赖 AI 是否遵守提示。默认关闭，开启后对这台宿主的后续调用立即生效；可以随现有 dsh-au 配置同步流程跨电脑同步。

此开关只管新建：不会暂停、清除或修改旧目标，也不限制 `get_goal` 或 `update_goal`（包括恢复）。普通任务、待办和错误重试不受影响。它不拦截用户直接通过 DSH 原生界面或其他插件创建目标；远程宿主需要加载新版插件并开启自己的开关。

插件首次更新仍需由宿主重新加载服务端代码；只刷新页面不能替代服务端重载。宿主不支持工具执行拦截时，开启会明确报错，不会显示成已经成功拦截。

## Claude：新建会话并发送

前提：Claude Desktop 已打开，目标项目出现在侧边栏；macOS 必须让 Claude 保持前台，并在「系统设置 → 隐私与安全性 → 辅助功能」允许实际发起命令的终端或 DSH 控制 Claude。命令会唯一匹配并打开 `New session in <项目名>`；同名项目、不可见按钮、已有空白会话中的草稿或附件都会让操作停止，不会猜测或覆盖。

先把内容保存为 UTF-8 文本文件；`--request-id` 由调用方生成。中断或超时后必须使用完全相同的参数和请求编号重试。

> - Windows PowerShell
> - 自动打开当前项目的 Claude 新会话，发送并原样输出完整回复

```bash
& "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\.bin\dsh-au-client-control.ps1" --provider claude --action new --project-dir "F:\path\to\project" --prompt-file "F:\path\to\prompt.txt" --request-id "claude-new-001" --timeout 180
```

> - macOS
> - 自动打开当前项目的 Claude 新会话，发送并原样输出完整回复

```bash
"$HOME/.dsh/profiles/desktop/node_modules/.bin/dsh-au-client-control" --provider claude --action new --project-dir "/path/to/project" --prompt-file "/path/to/prompt.txt" --request-id "claude-new-001" --timeout 180
```

继续已有 Claude 对话时使用 `--action send`，并提供 `--session-log` 与 `--chat-title`；只读提取已完成回复使用 `--action read`。需要同时保存原文时追加 `--output-file <新文件>`，已有文件不会被覆盖。

## Claude：已有会话的只读验收

`inspect` 只检查当前打开的会话，不导航、不新建、不填写草稿、不发送，也不创建请求状态。续发前应先运行它；只有退出码为 0 且 stderr 提示 `target and empty draft verified; nothing sent.` 才算验收通过。

> - Windows PowerShell
> - 从任意目录核对当前已打开的原会话，不发送消息

```bash
& "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\.bin\dsh-au-client-control.cmd" --provider claude --action inspect --session-id "SESSION_UUID" --project-dir "F:\path\to\project" --chat-title "对话标题"
```

> - macOS（需要 Accessibility 授权；Linux 不支持 Claude 桌面 inspect）
> - 从任意目录核对当前已打开的原会话，不发送消息

```bash
"$HOME/.dsh/profiles/desktop/node_modules/.bin/dsh-au-client-control" --provider claude --action inspect --session-id "SESSION_UUID" --project-dir "/path/to/project" --chat-title "对话标题"
```

Windows 在 `RootWebArea` 的 `Session tools` 工具栏中核对唯一标题，限定主聊天区比对历史，并在会话环境中核对完整项目路径；侧栏同名按钮不是会话身份证明。输入区按 Raw UIA 父级隔离，Session details 的 Outputs/Changes 不当作待发附件；真正的输入区附件、未知操作和非空草稿仍会拒绝。

**空输入区没有 Send 的兼容边界（Windows，2026-11-08）**：保留原有 Prompt/Add/Send 三锚定位。仅对已严格确认空白的输入框，允许准确的 `rounded-composer` Group 直接位于 `group/approval-dock` Group 内，且 Raw 树唯一 Prompt/Add、Prompt 身份一致、dock 根及后代均无任何类型的准确名称 Send/Stop。还须在后续边界核对已验证的消息区与详情区身份；Raw 遍历限制为 64 层和 4096 节点，无法完整证明即停止。dock 内和三棵已验证子树之外的 Raw-only 图片、预览、列表附件及按钮都不会被漏过；历史/详情只按准确 runtime ID 根剪枝，不按同名标签忽略。此兼容不放宽发送：真实 Send 仍须唯一、可用、可见，窗口身份和已准备草稿仍须一致。

Windows 使用 Raw UIA 中的准确用户消息 UUID 定位完整正文，即使 `You said:` 只是截短摘要，也不点击 `Show more`；完整渲染正文必须与日志一致。兄弟会话若共用最新用户 UUID，即使文本签名不同也拒绝，原有同签名与同待处理消息保护仍保留。

回复读取按同一唯一完成主链的 assistant message ID 限定 Raw 正文行，再逐项比较文字、列表种类/层级/显示序号与分隔线；只排除有确切 renderer class token 的工具状态卡片，不删除任意尾部文字。文件链接只核对可见名称，不点击链接、不声明目的地已经核对；`read` 的原始 Markdown 与 URL 输出保持不变。无法无歧义投影的代码块、表格、HTML、复杂转义等继续拒绝，而不是丢掉内容。

**既有通知缺口**：此前真实目标 `inspect` 以退出码 1 拒绝，因为某个宿主插件把启动提示写进了聊天转录：宿主把它合并到 UUID 绑定的 assistant 正文行，但指定 JSONL 中没有该提示。只读定位确认日志投影全部匹配，UI 仅多出无法独立验证的插件提示；工具状态卡片并未混入。当前 Raw/native UIA 没有可验证的独立通知来源边界，因此核验规则继续拒绝未知内容，不按名称、角色、尾部位置或 token 数过滤。inspect 正确地拒绝了这类 UI-only 文本。

这类提示应走非转录通道（如 `$.ui.toast`），不要用写入聊天转录的 `$.ui.log`。只调整提示显示时，自动重试原文、60 秒等待、30 次上限与取消/去重逻辑应保持不变；提示 API 缺失或失败时略过显示，不回退转录、不阻断重试。

**其他电脑和旧会话仍需分别验收**：宿主插件不会热加载，也不会自动删除已显示的旧转录提示；需要时由用户自行完全退出 Claude Desktop，重开同一个原会话并保持草稿为空，再运行上述只读 `inspect`。必须同时得到退出码 0 和成功诊断，不能把某一台电脑通过、单元测试通过或 `read` 成功当作其他机器的 `inspect` / `send` 通过，更不能当作发送授权。其他宿主插件若仍注入无法独立验证的 UI-only 内容，依旧安全拒绝；不自动修改设置、安装资源或草稿。

新增的重试提示回归使用 Node 内置 `stripTypeScriptTypes` 加载 Hook 源码夹具，运行该测试需 Node 22.13 或以上；不能据此宣称较旧 Node 或其他电脑已经实机通过。

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

- Windows：Claude 使用 UI Automation；Codex 使用 DSH 原生会话接口。
- macOS：Claude 使用 System Events Accessibility；Codex 使用 DSH 原生会话接口。
- Linux：Claude 仅支持读取已有日志，不提供桌面发送；Codex 可在 DSH 支持的平台上使用。
- Claude 的 `new` 会点击侧边栏中唯一匹配的项目新会话按钮；它不创建项目环境，也不会在多个同名项目之间猜测。
