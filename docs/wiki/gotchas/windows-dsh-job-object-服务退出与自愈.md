# DSH 重启连带关闭 Windows 后台服务：Job Object 隔离、持久日志与受限自愈

> Windows 上由 DSH-AU 拉起的常驻服务必须显式脱离 DSH Job Object；服务控制事件要持久化，自愈只接管本轮已确认运行后异常消失的服务。
> 来源: 原文核实于 2026-11-05 若干 Windows 常驻服务（端口服务、挂载盘服务、Worker 进程）实机停机诊断、修复、竞态审查与生命周期验收 · 更新: 2026-11-17

## 一句话结论

**`CREATE_NEW_PROCESS_GROUP` 只新建进程组，不会让进程脱离 Windows Job Object；DSH 启动常驻服务时必须同时使用 `CREATE_BREAKAWAY_FROM_JOB`，否则 DSH 宿主重启会回收这些后代进程。**

修复必须覆盖两条 Windows 启动通路：

1. DSH 运行期调用 AuWin 控制器时注入的 `WIN_HEADLESS_POPEN_PATCH`。
2. `syncBootStartupEntry` 生成到 Windows 启动目录的 `dsh-au-boot-<Host>.vbs` 内联 Python 补丁。

## 本次现象与时间线

| 时间（Asia/Shanghai） | 已核实事实 |
| --- | --- |
| 2026-11-05 22:09:35 | 后端文件服务仍正常响应挂载盘的 WebDAV `PROPFIND`。 |
| 2026-11-05 22:10:57 | DSH 旧宿主按正常关闭流程退出，退出码为 0；约 0.8 秒后新宿主启动。 |
| DSH 重启后 | 经 DSH 启动的四项服务（两个端口服务、一个挂载盘服务、一组 Worker 进程）均真实消失，并非面板误报；对应四项的 `enabled`、`autoStartOnBoot` 仍为 true。 |
| 同时 | 由独立启动器或系统服务托管的进程（如反向代理、DDNS）仍存活。 |

本机应用崩溃、资源耗尽与 Defender 拦截日志没有对应证据；Windows 进程终止审计未启用，因此不能从系统日志反推某个 `taskkill` 调用者。已核实的共同机制是：DSH 使用 Windows Job Object 管理宿主后代，而旧补丁只有 `CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP`，源码注释却误称已包含 `CREATE_BREAKAWAY_FROM_JOB`。

## 与旧故障的区分

| 故障 | 典型阶段 | 本次是否命中 |
| --- | --- | --- |
| Python Low Integrity | 服务启动时写日志、Temp 或缓存报 `Permission denied` | 否；服务已运行约一天，停机点与 DSH 重启对齐。 |
| `PYTHONUTF8=1` 解码 GBK | 挂载服务启动器退出码 1，日志停在第一行 | 否；挂载盘在停机前持续可访问。 |
| 开机 `.vbs` 跨仓函数缺失 | 重启电脑后服务从未启动 | 否；本轮服务先正常运行，随后在 DSH 宿主重启时消失。 |
| Job Object 未脱离 | 经 DSH 启动的常驻服务随宿主退出 | 是。 |

Worker 服务日志中确有 `PING timeout`、`ECONNRESET`、DNS 失败及重试累计；这是独立的网络稳定性风险，不能替代本次 DSH 重启时间线的根因证据。

## 修复契约

### Windows 启动隔离

常驻服务的最终 `creationflags` 必须同时包含：

- `CREATE_NO_WINDOW`（`0x08000000`）：无终端黑框。
- `CREATE_NEW_PROCESS_GROUP`（`0x00000200`）：独立进程组。
- `CREATE_BREAKAWAY_FROM_JOB`（`0x01000000`）：脱离 DSH Job Object。

运行时补丁和开机 VBS 必须使用同一组标志。修改生成器后还要重新同步实体 `.vbs`；只改仓库源码不会自动更新已经落盘的启动文件。

### 服务事件持久日志

服务控制请求、结果与自愈事件写入：

```text
~/.dsh/logs/dsh-au-services.jsonl
```

约束：

- 当前文件达到 2 MiB 前轮转为 `.1`，只保留一份备份。
- DSH 重启后读取末尾事件并恢复到对应服务日志面板。
- 写入函数失败时返回 `false`，调用方继续服务启停，不让日志故障反向中断控制。
- `password`、Token、API Key、AWS Key、Basic/Bearer、Cookie、URL userinfo，以及 `serviceId`、`action`、`source` 等结构字段统一脱敏。
- 业务服务自身的详细 stdout/stderr 仍以各服务原生日志为准；生命周期 JSONL 不代替业务日志。

### 受限自愈

自愈只处理 `enabled ∩ autoStartOnBoot`，并同时满足以下条件：

1. 当前 DSH 生命周期内已经明确观察到服务 `running=true`。
2. 随后连续两轮强制探测都明确为 `running=false`；`null/checking` 不计失败。
3. 用户未通过 DSH 主动停止，Doctor 未暂停该服务，插件未销毁。

恢复动作只允许 `start`，不调用 `restart` 或 `stop`：

- 退避：30 秒 → 2 分钟 → 5 分钟。
- 熔断：15 分钟滚动窗口内最多 3 次。
- 清零：恢复后连续健康 5 分钟才清除次数。
- 依赖：上层服务先确认其依赖服务已运行（如挂载服务先确认后端文件服务，WebUI 先确认代理）。依赖被用户停止时，上层服务不得绕过抑制把它拉起。
- 多机：恢复状态按当前 active binding 的 `machineId` 隔离；切换 binding 时旧 probe、旧抑制和旧退避全部失效。
- 串行：用户 stop、Doctor 生命周期探针会等待同服务的在途恢复结算，保证用户 stop 是最终动作。

冷启动时已经停止的服务保持 `UNSEEN`，不会仅因打开 DSH 被擅自启动；需要“随 DSH 打开即启动”时继续使用现有 `autoStartOnDsh` 开关。

## 排查与验收

> - macOS / Linux / Windows (PowerShell)
> - 在本仓库根目录只读检查绑定、控制通路与健康状态

```bash
node "$(git rev-parse --show-toplevel)/scripts/doctor.mjs" --json
```

> - Windows (PowerShell)
> - 检查登记服务的端口、挂载盘与 Worker 进程（端口、盘符、进程匹配规则换成你自己登记的值）

```bash
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object LocalPort -in 8080,8081
Get-PSDrive -Name X -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'worker' }
```

> - macOS / Linux / Windows (PowerShell)
> - 在本仓库根目录运行构建检查与测试

```bash
npm test
```

原文验收结果（2026-11-05，当时测试套件规模）：

- 完整测试 652 项：649 通过、3 跳过、0 失败。
- Doctor：12 项登记服务、10 项可管理、2 项纯监控、0 项配置错误。
- 使用修复后的控制器启动四项服务，启动命令所属父进程退出后，两个端口服务、挂载盘与 Worker 进程仍存活。
- 重新生成的 Windows 开机 VBS 已包含三项 creation flags。
- 最终只读代码审查无阻塞问题。

## 下次排查顺序

1. 对齐 DSH `shutdown.start/run.start` 与服务最后活动时间，先判断是否为宿主生命周期问题。
2. 同时核对真实端口、盘符和进程，排除仅面板探活误报。
3. 查看 `~/.dsh/logs/dsh-au-services.jsonl`，区分用户控制、随 DSH 自启、自愈与系统控制来源。
4. 若没有生命周期记录，再查服务原生日志、Windows 崩溃/资源/安全事件；未启用进程终止审计时明确写“无法反推调用者”。
5. 修复后分别验证父启动器退出、DSH 重启、开机 VBS、依赖顺序和用户 stop 抑制；只通过静态 Doctor 不算完成。

## 关联

**相关页面**：

- [DSH-AU 本地服务、云同步服务与插件注册规范](../domain/dsh-au-service-plugin-registration.md) — 服务开关、控制通路、Doctor 与运行生命周期的职责边界。
- [Windows 开机 `.vbs` 跨仓库入口契约断层与 `pythonw.exe` 静默吞错](windows-boot-vbs-cross-repo-contract.md) — 同一 VBS 生成通路的跨仓兼容与落盘刷新要求。

**源码**：

- `lib/background-services.js`
- `lib/index.js`
- `lib/service-event-log.js`
- `tests/background-service-recovery.test.mjs`
- `tests/service-event-log.test.mjs`
- `tests/windows-breakaway-job.test.mjs`
