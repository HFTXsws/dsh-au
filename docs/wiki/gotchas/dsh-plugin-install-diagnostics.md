# DSH 云插件安装失败与只读诊断

> 面板、菜单 71/72 出现安装失败、配置没有复刻、版本不符或 Profile 遗留锁时，先读 Doctor 的具体错误；不要用重复安装掩盖状态不明。
> 来源: 核实于 `lib/plugin-doctor.js`、运行时、Profile 状态、快照库与同步核心 · 更新: 2026-11-17

## 先做一个只读动作

本仓库没有独立插件 Doctor CLI。优先用工作台「插件管理 → 只读体检」（走 `lib/plugin-doctor.js`）。若仍从私人仓跑父仓脚本，前提是已安装真实 Node.js。

> - macOS / Linux / Windows (PowerShell)
> - 从本仓库根目录调用私人仓只读 Doctor（检查当前 Desktop Profile、运行时、实际包元信息与云快照）

```bash
node "<syncRepoRoot>/scripts/dsh-plugin-doctor.mjs"
```

需要机器可读结果时单独运行：

> - macOS / Linux / Windows (PowerShell)
> - 输出同一份只读诊断的 JSON

```bash
node "<syncRepoRoot>/scripts/dsh-plugin-doctor.mjs" --json
```

Doctor 可以探测已存在的 Node/pnpm 版本与 store，但**不安装、不清锁、不加载插件代码、不启动服务、不输出 patch 配置或凭据**。退出码 0 表示只读检查未发现错误，1 表示发现错误，2 表示参数无效；warning 或退出码 0 不证明重启后插件已加载。

本地服务绑定体检走另一条入口：`node scripts/doctor.mjs`。

## 按错误类别处理

| 诊断 | 原因与下一步 |
| --- | --- |
| `NODE_NOT_FOUND` | 未找到可核验的当前架构 Node，或拿 Electron 代替 Node；检查实际宿主资源入口/已安装 Node，不用另一个未知可执行文件试运气 |
| `PNPM_NOT_FOUND` / `PNPM_UNVERIFIED_SHIM` | 没有已安装可核验 pnpm，或只有可能下载版本的 corepack shim；核实宿主内置工具，安装器不会自动 `npm exec` 最新版 |
| `PNPM_INCOMPATIBLE` / `PNPM_STORE_INCOMPATIBLE` | 工具版本或 store 与 Profile 元信息不一致；先确认 Profile 原先使用的 pnpm/store，保留现有依赖，不直接换 store |
| `PROFILE_BUSY` / `RECOVERY_REQUIRED` | 同一 Profile 正在变更，或前次中断留下锁/recovery；确认原任务及进程状态，再制定恢复动作；Doctor 不自动删除遗留锁 |
| `CONFIG_HASH_MISMATCH` / `CONFIG_MISSING` / `MANIFEST_INVALID_JSON` / `SNAPSHOT_MISSING` | 云快照摘要不符、文件缺失或清单损坏；从可信来源电脑重新导出完整快照，再重试。坏快照不是“没配置”，不能用公共默认覆盖本机 |
| `INSTALLED_PACKAGE_INVALID` / `INSTALL_VERIFICATION_FAILED` / `VERSION_MISMATCH` | 依赖声明与实际包元信息不一致，或安装器退出后包名/版本核验失败；对照 declared/requested 与 actual，不把 dependencies 范围当已装事实 |
| `VERSION_NOT_PINNED` | 云版本仍是范围或未固定；从已装来源包导出真实版本。请求范围保存在 `requestedSpec`，恢复使用可核验的精确版本 |
| `ETIMEDOUT` / `ENOBUFS` / 命令非零退出 | 默认安装命令 120 秒超时或输出超限；输出超限保留 Node 返回的 `ENOBUFS` 错误码，优先读原始 pnpm 错误码、请求地址和解析错误，确认代理/registry/权限，不把通用认证提示当根因 |

快照无 hash 的旧版本会给 compatibility warning；`hasConfig:false` 残留配置只会给 `STALE_CONFIG_IGNORED` 并忽略该文件。这些 warning 不应被当成摘要校验已经通过。

## Windows 编码：字节、内容与退出状态分别看

Windows 原生命令可能输出 OEM/系统码页，Node CLI 通常输出 UTF-8。统一执行器先捕获字节，按命令类型和系统码页解码，保留 stdout/stderr、退出码、超时与截断状态，避免固定 UTF-8 把真实错误变成乱码或空结果。

乱码不代表安装失败原因就是网络，退出码非零也不必然表示编码错误。先分清：工具没启动、工具启动但失败、工具退出成功但实际包未核验、配置已写但宿主尚未重启加载。

同类父子进程编码问题见 [Windows PYTHONUTF8 解码排障](windows-pythonutf8-subprocess-decode.md)；Python 的 `text=True` 故障与 Node 执行器共用“按字节捕获、按来源解码”的原则，但修复位置和代码入口不同。

## pnpm 包误显示成本地插件

看到 npm 包在云快照中被标成 `local-repo` 时，先核对 pnpm 布局；普通 isolated 或外置 virtual store 的链接仍是包管理器布局，不是仓库插件。同步与快照已经共用分类器，不再仅凭“是链接”判断来源；具体管理根、旧布局兼容与损坏元信息边界见 [云插件契约](../domain/dsh-cloud-plugin-contract.md)。

## 中断后能恢复什么

Profile 文本事务覆盖依赖声明、插件 patch 与 pnpm 锁文件。`configRestored:true` 只表示这部分文本恢复；**不表示 node_modules、pnpm store 或安装脚本副作用被完全撤销**。recovery 标记与遗留锁保留给只读诊断，不用“删锁再装一次”代替恢复计划。

菜单 71 另有供应商/模型/ACP 方案职责，其整份配置恢复需按原备份流程处理；菜单 72 只增不减，未选插件不应因排障被禁用或卸载。面板 HTTP 安装已移到工作线程；仍需 Profile 锁保护跨进程一致性，不能因为页面还能响应就再提交同一 Profile 的第二个安装。

## 验证边界

只读 Doctor、隔离回归、真实插件安装、重启加载是四个不同门槛。当前文档记录源码契约与已有隔离证据；原文没有把真实安装、重启或 macOS/Linux 实机验证写成已完成。即使已有 Windows 成功案例，也只能证明对应机器当时的环境。

跨系统能力矩阵、快照字段与统一入口职责见 [云插件契约](../domain/dsh-cloud-plugin-contract.md)。完整测试门禁以当时报告为准；只读诊断不会替用户完成安装验收。

## 关联

**相关页面**：

- [云插件跨机安装与快照契约](../domain/dsh-cloud-plugin-contract.md) — 入口分工、真实版本、原子快照、Profile 锁与跨系统验收矩阵。
- [服务与插件注册规范](../domain/dsh-au-service-plugin-registration.md) — SSOT、凭据与本机接入边界。
- [Windows PYTHONUTF8 解码排障](windows-pythonutf8-subprocess-decode.md) — 原生命令码页与 UTF-8 父进程环境的区别。

**源码**：

- `lib/plugin-doctor.js`（工作台「只读体检」）
- 私人仓 CLI：`<syncRepoRoot>/scripts/dsh-plugin-doctor.mjs`
- `lib/plugin-runtime.js`
- `lib/plugin-profile-state.js`
- `lib/plugin-bundles.js`
- `lib/plugin-sync-jobs.js`、`lib/plugin-sync-core.js`
