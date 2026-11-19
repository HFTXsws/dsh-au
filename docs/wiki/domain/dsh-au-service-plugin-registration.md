# DSH-AU 本地服务、云同步服务与插件注册规范

> 注册本地服务、云同步服务与 DSH 插件前必读 `sync/README.md`，支持任意路径与任意系统脚本通过本地绑定 JSON 直接纳管。
> 来源: 核实于 `sync/README.md` 与 `lib/*` · 更新: 2026-11-17

## 必读入口与四层真相

在注册、修改或排查**本地服务、云同步服务、DSH 插件**时，必须先阅读 [`sync/README.md`](../../../sync/README.md)，严格遵守四层 JSON 单一事实来源（SSOT）。

当前正在使用的 `sync/` 由 `syncRepoRoot`（或环境变量 `DSH_AU_SYNC_REPO`）决定：优先 `<syncRepoRoot>/dsh-sync/`，否则旧布局 `<syncRepoRoot>/dsh-au/sync/`；未配置私人仓库时只用插件自带示例 `sync/`，**不把私人绑定写入开源仓**。下文路径都相对于「当前正在使用的那份 `sync/`」。

| 层级 | 路径 | 是否进 Git | 职责边界 |
| --- | --- | --- | --- |
| 云服务与云插件定义 | `sync/cloud/manifest.cloud.json` | 是（共享定义） | 跨电脑共享的服务定义、设备路由定义、云插件定义（不含本机绝对路径与运行开关） |
| 单机绑定云备份 | `sync/machines/<machineId>.json` | 私人仓：是；开源仓：否 | 每台电脑各自登记的本地服务（`services`）、常用菜单收藏（`menuFavorites`）、接过的云插件名单（`plugins`） |
| 本机活动指针 | `sync/local/active.json` | 否 | 当前电脑正在使用哪一份 `machines/<machineId>.json`（只记 `machineId`） |
| 本机开关镜像 | `sync/local/state.json` | 否 | 四个运行态开关（`enabled`、`autoStartOnBoot`、`autoStartOnDsh`、`cloud`）的唯一来源 |

## 本地服务脚本路径与跨平台纳管规则

`dsh-au` 插件对本地服务的管理遵循**不限制脚本路径、不限制操作系统**的原则：

1. **只记 `scriptPath` 即可完整纳管**：只要在 `sync/machines/<machineId>.json` 的 `services.<id>.scriptPath` 中记录了可执行脚本或二进制路径，无需修改插件代码白名单，插件即可自动管理该服务的：
   - **本机启用**（`enabled`）
   - **开机自启**（`autoStartOnBoot`：Windows 写入启动目录 `.vbs`，macOS 切换 `launchd` 或写入 `~/Library/LaunchAgents/*.plist`，Linux 写入 `~/.config/autostart/*.desktop`）
   - **随 DSH 自启**（`autoStartOnDsh`：DSH 启动时先探活防重，未运行时无头静默拉起，关闭 DSH 绝不杀服务）
   - **启动 / 重启 / 停止**（`start` / `restart` / `stop`）
2. **私人同步仓库内路径直接写相对路径**：
   - 若脚本位于私人同步仓库内，在 `machines/<machineId>.json` 中**直接记录仓库相对路径**（例如 `gateways/my-gateway/server.py`、`scripts/mount-share.ps1`），插件运行时按 `syncRepoRoot` 展开；
   - 若脚本位于仓库外：在家目录下写 `~/` 开头（如 `~/tools/my-daemon.py`），在其它任意磁盘或目录直接写绝对路径（统一使用 `/` 分隔符，如 `D:/Tools/my-service/my-service.exe` 或 `/opt/services/worker.sh`）。
3. **跨平台多语言解释器自适应**：
   - 自动识别 `.py` / `.pyw`、`.js` / `.mjs` / `.cjs`、`.ps1`、`.sh` / `.bash` / `.zsh` / `.command`、`.bat` / `.cmd` / `.vbs`、`.exe` 及无后缀可执行二进制文件。

## 云同步服务与插件注册边界

- **本地注册 ≠ 上云**：写入 `machines/<machineId>.json` 只让服务出现在当前电脑面板（默认未启用）；只有需要跨电脑共享时才同步到 `cloud/manifest.cloud.json`（仓库内路径自动转相对路径，仓库外路径留空）。
- **开启自启前必须先开启本机启用**：`autoStartOnBoot` 与 `autoStartOnDsh` 必须是 `enabled` 的子集，未启用时请求自启会显式报错拒绝。
- **插件同步规范**：通过工作台「插件管理 → 同步到云」生成 `sync/plugins/<slug>/`（含 `plugin.json`、可选 `config.yml`、`README.md`），并在 `machines/<machineId>.json` 的 `plugins` 数组记录插件 ID。
- **凭据红线**：严禁在任何绑定或云清单文件中写入 `password`、`passwd`、`token`、`secret`、`api_key`、`credential`、`cookie` 等字段。
- **统一安装与快照**：改面板、菜单 71/72 或同步器先读 [云插件契约](dsh-cloud-plugin-contract.md)。共用安装/快照核心不改变菜单 71 的方案托管 ACP 职责，也不改变菜单 72 的只增不减。
- **失败与中断**：先按 [插件安装诊断](../gotchas/dsh-plugin-install-diagnostics.md) 运行只读插件 Doctor。坏快照不能无声回落默认；Profile 配置恢复不代表依赖目录/store 完全回滚，遗留锁不自动清除。

## 本地服务管理 Doctor 自检

新增或修改本地服务绑定后，运行本地服务管理 Doctor 验证路径规范与插件管理能力是否全部就绪：

> - macOS / Linux / Windows (PowerShell)
> - 在本仓库根目录只读检查当前机器登记的本地服务

```bash
node "$(git rev-parse --show-toplevel)/scripts/doctor.mjs"
node "$(git rev-parse --show-toplevel)/scripts/doctor.mjs" --json
node "$(git rev-parse --show-toplevel)/scripts/doctor.mjs" --service <serviceId> --probe-lifecycle
```

## 路径字段与平台控制器

- `scriptPath`、`configPath`、`cacheDir` 各管一件事：启动入口、配置文件、缓存目录。缓存目录不能填到 `configPath`；Doctor 对目录型 `configPath` 报错，对 `cacheDir` 按目录检查，首次未建时只提示。
- Windows 上由平台控制器（AuWin）专管的服务走平台控制器（`background_services.py`），登记 `scriptPath` 只用于展示与体检，不改变实际控制通道。

## 关联

**相关页面**：

- [云插件跨机安装与快照契约](dsh-cloud-plugin-contract.md) — 共用安装核心、可靠快照、Profile 锁与跨系统验收矩阵。
- [DSH-AU 私人仓库工作台扩展契约与新页面指南](private-extensions-contract.md) — 同一 `sync/` 下的 `extensions/` 私人工作台页面契约与 Doctor 自检。
- [插件安装失败与只读诊断](../gotchas/dsh-plugin-install-diagnostics.md) — 版本/store、编码、快照和遗留锁问题的处理顺序。
- [Windows Python 低完整性导致服务日志写入失败](../gotchas/windows-python-low-integrity.md) — Python 服务有普通文件权限仍写入失败时，核实进程完整性；保留原虚拟环境并修复启动入口，另行验收服务生命周期。
- [Windows 下 PYTHONUTF8 让子进程输出解码静默崩溃](../gotchas/windows-pythonutf8-subprocess-decode.md) — 控制器的 UTF-8 环境会传给服务脚本，报 `启动器退出码 1` 且日志中断时先查这里。
- [Windows 开机 `.vbs` 跨仓库入口契约断层与 `pythonw.exe` 静默吞错](../gotchas/windows-boot-vbs-cross-repo-contract.md) — 开机自启 `.vbs` 跨仓库调用 `AuWin` 须保留兼容回退并重新同步落盘。
- [DSH 重启连带关闭 Windows 后台服务：Job Object 隔离、持久日志与受限自愈](../gotchas/windows-dsh-job-object-服务退出与自愈.md) — 服务先正常运行、随后随 DSH 宿主退出时，检查 Job 脱离、恢复状态机与生命周期日志。
- [子路径反代（Caddy）漏放行 `/dsh-au-todo/*` 导致移动端远端工作区空白](../gotchas/dsh-au-subpath-proxy-api-whitelist.md) — `dsh_caddy_ipv6` 子路径反代必须同时放行 `/dsh-au/*` 与 `/dsh-au-todo/*`。

**源码**：

- `sync/README.md`
- `lib/local-bindings.js`
- `lib/background-services.js`
- `lib/service-doctor.js`
- `lib/sync-repo.js`
- `scripts/doctor.mjs`
