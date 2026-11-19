# DSH 云插件跨机安装与快照契约

> 修改面板、菜单 71/72、插件快照或安装器时先读本页：安装机制共用，入口的选择与配置职责保持不同。
> 来源: 核实于同步核心、菜单 71/72 与插件库源码、隔离回归测试 · 更新: 2026-11-17

## 各入口共用什么、保留什么

| 入口 | 共用机制 | 保留的职责 |
| --- | --- | --- |
| DSH-au 面板 | HTTP 通过[工作线程桥](../../../lib/plugin-sync-jobs.js)调用同步核心；安装、快照验证与 Profile 锁共用 | 单插件接入/取消只处理目标插件；批量选择按提交的名单应用 |
| 菜单 71：还原 DSH 方案 | npm 插件走 `installNpmPlugin`；普通云插件走 `syncDshPlugins` | 仍专门配置工作1的 `profile-managed` ACP 与模型方案；不能当作“只导入插件”入口 |
| 菜单 72：导入云插件 | 只把选中项交给 `syncDshPlugins`，同样读取已保存的配置快照 | **只增不减**：未选项保持原状，不卸载、不禁用；不改模型供应商、凭据和后台服务 |
| 同步核心 CLI | 本仓库核心在 `lib/plugin-sync-core.js`；私人仓仍保留 `<syncRepoRoot>/scripts/dsh-plugin-sync.mjs` 入口 | 按传入的目标 DSH/Profile 操作，不悄悄改到另一份 Profile |

定义仍只在云清单，本机选择仍来自 Profile 的 bundles/patch；机器 JSON 是备份记录，不是另一台电脑的运行态。四层 SSOT 见[服务与插件注册规范](dsh-au-service-plugin-registration.md)。

## 安装运行时与成功条件

[运行时发现器](../../../lib/plugin-runtime.js)从宿主资源元数据、宿主祖先进程可执行路径、已存在的外部命令等来源发现工具，不依赖固定安装目录或 HTTP 进程的完整 PATH。

1. 核验当前架构的**真实 Node.js**，拒绝把 Electron 当 Node 运行包管理器。
2. 优先发现宿主已有 pnpm，再核验外部 pnpm；显式工具覆盖失败时不无声忽略。
3. 对照 Profile `packageManager`、现有 `.modules.yaml` 的 pnpm 主版本与 store；不兼容则返回明确错误。
4. 使用独立参数、`shell:false` 和有界命令执行；默认安装命令超时为 120 秒。Windows 优先运行已安装的 Node CLI，必要的批处理路径单独校验参数。
5. 包管理器退出成功之后，再核验目标 `node_modules` 中的包名与精确版本。**配置成功仍不等于重启后插件已加载。**

发现过程只做本地探测，不自动 `npm exec` 下载最新版 pnpm，不引导 corepack 下载别的版本。Windows stdout/stderr 按字节捕获，再区分 UTF-8 与系统码页解码；排障见[插件安装诊断](../gotchas/dsh-plugin-install-diagnostics.md)。

## 快照：配置状态与声明意图分开

每个插件只导出自己的 patch 块，保留 `patchId` 和便携 `~/...` 路径；源类型区分 npm 与仓库软链。模型供应商、其它插件块、日志与凭据不进入插件快照。**插件快照是唯一配置来源**：运行、预览、菜单与换机恢复都不再叠加或回退到 `app-config/dsh/cordis.patch.common.yml`。

**pnpm 包链接不等于本地仓库插件。** 普通 isolated 布局会把包链接到包管理目录，外置 virtual store 也可能让目标落在 Profile 外；仅看 `isSymbolicLink()` 会误标 `local-repo`。同步器与快照共用[链接分类器](../../../lib/plugin-links.js)，对照规范实际路径、`node_modules`、布局元信息中的 `virtualStoreDir` 与 `storeDir`，排除包管理器管理根内的链接；只有真正外部包目录链接才按本地来源处理。没有布局元信息时保留旧外链兼容；已有元信息损坏、不可读取或路径未解析时采用保守分类，不猜成本地仓库插件。

| 字段 | 含义 |
| --- | --- |
| `version` / `source.ref` | 优先取目标 Profile 已装包的元信息版本，不把 `^1.1.2` 当作实际安装版本 |
| `requestedSpec` | Profile dependencies 的原始声明，保留版本范围、link 等请求意图 |
| `versionVerified` | 是否取得已装包版本元信息；兼容回退的声明版本不能冒充已核验事实 |
| `hasConfig` | 明确是否有本插件的配置；false 时即使旧 `config.yml` 留着，也不读取或恢复 |
| `configHash` | 有配置时记录导出后字节的 SHA256；没有配置时不写此字段 |

文件使用同目录独占临时文件并 rename，**manifest 最后提交**。空配置导出仅删除已归属同包的生成配置，删除前验证规范绝对路径、仓库范围、目录/文件类型与已有摘要；独立文件及被额外修改的配置不无声删除。slug 相同但 manifest package 不同会拒绝覆盖。

读取保留 `byPackage` Map，只放完整有效快照；新增 `ok`、`warnings`、`errors`。诊断含 `code/package/dir/path/message`；坏 JSON 无法确定 package 时可按目录关联。缺配置、坏 JSON、摘要不符等不得退回公共默认块覆盖目标本机。旧快照无 hash 或无 hasConfig 可兼容读取，但必须给 warning。

### 从公共模板收敛到快照

插件配置统一收敛到快照目录 `sync/plugins/<slug>/config.yml`（以 `dsh-continue` 为例），同时记录精确版本、`patchId`、`hasConfig` 与 `configHash`，并删除旧 `app-config/dsh/cordis.patch.common.yml`。迁移顺序是“先生成并验证快照，再删除读路径和重复文件”。兼容边界是 **commit `287ff84`（首次支持 `savedConfig` 快照读取）及之后**：这些旧版会优先读取有效快照，common 缺失只是可选回落；更早版本只读 common，不在本次混合版本兼容范围内，必须先升级并重启后再执行插件同步。当前本仓库对应路径是正在使用的 `sync/plugins/<slug>/`。

**唯一来源不等于恢复插件默认规则。** 快照中保存的是用户实际配置，用户删掉的默认规则（如 `dsh-continue` 的 `r-rate-limit`、`r-any` 等）不得在迁移、同步或恢复时被带回，也不能用“默认规则齐全”的测试固定错误结果。以只保留一条 503 规则（按 `continue` 延迟 60000ms）的配置为例：`Responses request exceeds 32 MiB` 的 413 不再交给该宿主层插件，因为它无法直接读取 Agent preset 隔离域内的压缩服务；`dsh-au` 改在 `agent/request-error` 瀑布内通过 `agentPresets.serviceFor(agent, 'compaction')` 取得正确服务，压缩产生持久 surface 进展后原地 retry 一次。同步、导出、恢复必须原样保留用户的规则数组，不拼回默认规则或旧 413 规则；回归检查必须同时核对规则集合与本地/快照一致性，不能只检查“两边一样”。

回滚时必须成对恢复旧公共模板及旧读取逻辑，不能只恢复文件造成双重真理。当前正向路径不自动重建公共模板；声明快照缺失或损坏直接失败并由 Doctor 报告。

本机库存 `getLocalDshPluginInventory` 的 `version` 优先实际版本；缺包元信息时兼容声明版本，并提供 `requestedSpec/installedVersion/installed/installationVerified`。默认新增事实字段不可枚举以保持旧对象接口；JSON/API 需要显式传第三参数 `{ includeInstallFacts: true }`。声明依赖、bundles 资格、包实际存在、重启加载是不同事实。

## Profile 并发与恢复范围

[Profile 状态库](../../../lib/plugin-profile-state.js)用 Profile 目录下独占 `wx` 锁串行跨进程变更。正常结束只释放自己拥有的锁；遗留锁由 Doctor 报告，不能仅凭“锁看起来旧了”自动删除。

配置事务快照覆盖 `package.json`、`cordis.patch.yml`、`pnpm-lock.yaml` 的文本与原始缺失状态，并使用原子文件替换。失败或中断通过 recovery 元数据报告需要核验的阶段。

**恢复配置不是完整撤销安装。** `node_modules`、pnpm store、插件安装脚本的副作用不在文本恢复承诺内。菜单 71 还涉及供应商/模型方案与凭据补齐，插件事务也不承诺撤销该入口的所有方案操作。

结果区分 skipped、configured、partial、failed；只有需要时提示重启。遇到 recovery/partial failure，先运行 Doctor，确认实际依赖，再决定如何修复或重试。

## 跨系统能力与验收矩阵

| 范围 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| 宿主资源发现 | resources / 当前架构 runtime | Contents/Resources / 当前架构 runtime | resources / 当前架构 runtime |
| Node 与 pnpm 运行 | 核验真实 Node；优先 Node CLI，批处理独立处理 | 核验真实 Node；独立参数执行 | 核验真实 Node；独立参数执行 |
| 命令输出 | UTF-8 与系统码页按字节解码 | UTF-8 | UTF-8 |
| 仓库本地插件挂载 | junction，不要求管理员软链权限 | 目录符号链接 | 目录符号链接 |
| 配置便携路径 | 目标家目录与 YAML 反斜杠转义 | 目标家目录与 `/` | 目标家目录与 `/` |
| 原文记录的真实安装/重启加载 | 未执行 | 未执行 | 未执行 |

源码与隔离测试证明的是对应逻辑、临时文件和测试环境内行为。**Windows 一次安装成功只证明那台电脑当时的环境，不等于 macOS/Linux 实机验证，也不等于重启加载成功。** 完整集成门禁以当时测试报告为准，不能把模拟平台参数或 CLI 退出码当作真实跨机验收。

原文记录 GUI 浏览器连接不可用、没有完成在线面板验收，且未重启 DSH。后续须经用户授权重启 DSH 后单独验证实际面板/插件加载，不能把代码与测试通过报告成正在运行的新后端已生效。

## 关联

**相关页面**：

- [服务与插件注册规范](dsh-au-service-plugin-registration.md) — 四层 SSOT 与接入边界。
- [插件安装诊断](../gotchas/dsh-plugin-install-diagnostics.md) — 运行时、版本、快照与遗留锁错误的只读排查顺序。

**源码**：

- `lib/plugin-sync-core.js`、`lib/plugin-sync-jobs.js`
- 私人仓 CLI / 菜单：`<syncRepoRoot>/scripts/dsh-plugin-sync.mjs`、`<syncRepoRoot>/scripts/dsh-plugins.mjs`、`<syncRepoRoot>/scripts/dsh-restore.mjs`
- `lib/plugin-runtime.js`
- `lib/plugin-profile-state.js`
- `lib/plugin-bundles.js`、`lib/config-store.js`、`lib/plugin-links.js`
- `tests/plugin-snapshot-integrity.test.mjs`
