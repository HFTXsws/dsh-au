# Windows Python 低完整性导致服务日志写入失败

> 遇到 DSH-au 启动 Python 服务报 `Permission denied`，先区分进程完整性与普通文件权限；复用现有虚拟环境，只调整经过验证的启动入口。
> 来源: 原文核实于 2026-10-28 后台 Worker / 某挂载服务实机诊断、Python 启动解析与启动器回归测试 · 更新: 2026-11-17

## 一句话结论

**换启动入口，不换原虚拟环境。** 使用该虚拟环境登记的基础 Python 执行脚本，同时保留原虚拟环境的路径和依赖；不需要重建环境或重装依赖。

这里的“基础 Python”不是随便从 PATH 选一个解释器，也不是因为 DSH 自带 Python 可写，就把服务改为使用 DSH 的依赖环境。本次服务使用的是 **通用控制器目录已有的虚拟环境**，不是给每个脚本重新建一个环境。

## 故障表现与已核实原因

本次六个后台 Worker 都在打开 `cursor-worker-<name>.log` 时失败，尚未进入 Worker 子进程启动阶段。换成追加模式或忽略旧日志删除错误后，仍然会写同一个受限目标，不能修复这个原因。

Windows 有两层不同的检查：用户的普通文件权限，以及进程与目标对象的完整性级别。**同一用户拥有目录完整权限，不等于 Low Integrity 进程可以写入普通完整性的目录。**

| 本次实机证据 | 观察结果 |
| --- | --- |
| 通用控制器目录的 `venv/Scripts/python.exe`、`pythonw.exe` | 继承了 `Low Mandatory Level (NW)` 标记 |
| 从普通完整性的终端启动控制器 venv Python | 子进程为 Low，完整性 RID 为 4096；在 Temp 和 Worker 数据目录新建独立文件均返回 Windows 错误码 5 |
| 同一终端启动 DSH 自带 Python，作为对照 | 子进程为 Medium，完整性 RID 为 8192；同目录写入成功 |
| 使用控制器 venv 对应的基础 Python，并传入原 venv 启动标识 | `sys.prefix` 保持控制器 venv，`psutil` 仍从该 venv 加载；Temp 和 Worker 数据目录读写成功 |

这些证据支持**本次进程低完整性导致写入被拒绝**，不能把所有 `Permission denied` 都归为同一原因。文件占用、只读属性、普通权限和安全软件仍需按各自证据排查。

## 修复方式与适用边界

当前 DSH-au 的 `resolveControllerPythonLaunch`（兼容别名 `resolveAuWinPythonLaunch`）使用以下启动协议：

1. 先解析原服务的虚拟环境启动器路径；Windows 下读取对应 `pyvenv.cfg` 的 `home`，选取同名基础解释器（`python.exe` 或 `pythonw.exe`）。
2. 启动基础解释器时，将 `__PYVENV_LAUNCHER__` 设为原虚拟环境启动器路径。原 venv 和依赖保持不变，同时保留原有 UTF-8 环境设置。
3. 配置不可读、缺少 `home` 或基础解释器不存在时，保留原启动路径，由原控制链路报告实际结果；不会偷偷改用另一个 Python 或新建环境。

本次协议在 Windows 的控制器 CPython 3.10 环境中已实测。macOS/Linux 保留原虚拟环境执行路径，不套用 Windows 的完整性处理；其他 Python 实现或新版本需另验。

这是**普通权限宿主的服务启动路径修复**，不是提权机制，也不修改 ACL、所有者或管理员权限。若宿主进程本身受限，换解释器不会自动解除父进程的限制。

修复范围以实际调用链为准：当前外部平台控制器的启停、状态扫描及 Windows 开机入口使用该解析器；任意 `scriptPath` 通用直控不能仅凭文件后缀认定已覆盖，需检查其实际解释器、工作目录与环境传递。

## 下次排查与验收顺序

1. **定位失败阶段**：记录完整目标路径、原生 Windows 错误码，确认是日志打开失败还是子进程已启动后退出。用独立新文件测试目标目录，不删除或覆盖已有日志。
2. **核实实际进程**：检查宿主、Python 子进程的完整性级别以及可执行文件继承的标记；不要只看诊断终端的用户身份或目录权限。
3. **核实环境未换**：检查 `sys.prefix`、`sys.base_prefix`、`sys._base_executable` 和关键依赖的加载位置。`sys.executable` 可能仍显示原 venv 启动器，因此不能单靠它判断真实入口或进程权限。
4. **验证实际写入**：从真实控制器上下文确认日志目录和 Worker 数据目录均可写；只换日志位置，可能把同样的错误推迟到数据写入阶段。
5. **分别验收生命周期**：验证 Worker 就绪、重复启动不新增实例，以及自启入口传递同一 venv 环境。静态 Doctor、单元测试和临时启动项生成都不等于真实服务或真实开机已验收。

优先保留现有环境并修复已证实的启动路径，不以重装依赖、扩大整个 Temp 权限或管理员运行作为本次问题的默认解决方案。

## 第二次案例：某挂载服务与根目录标签

2026-10-28 某挂载服务失败时查到 Low 标记的真实来源：**通用控制器根目录本身带显式标签** `Low Mandatory Level:(OI)(CI)(NW)`，`venv`、`logs` 及其中文件都继承它。上级工作目录没有标签，判断为某次沙箱写 ACL 时留下。

只改启动入口不够：控制器改用基础 Python 后，控制器脚本仍用 `venv/Scripts/python.exe` 拉起示例挂载脚本，脚本再拉起挂载子程序，整条链都是 Low，挂载子程序写不了 `%LOCALAPPDATA%/<app>/cache`。启动入口重定向只对 Python 有效，管不到它派生的原生程序。

经用户确认后，把根目录完整性恢复为默认的 Medium（可逆，不提权，不改普通权限）。venv Python 随即变为 Medium、缓存可写，实测挂载成功。

> - Windows (PowerShell)
> - 查看完整性标签；逐级检查，带 `(I)` 为继承，不带为本级显式设置

```bash
icacls "<ControllerRoot>" | Select-String "Mandatory Label"
```

> - Windows (PowerShell)
> - 恢复为 Medium 并让子项继承；修改安全标签前须用户确认

```bash
icacls "<ControllerRoot>" /setintegritylevel "(OI)(CI)M"
```

恢复后如果再次出现 Low，先查是谁又写了标签，不要反复手动改。

## 检查入口与本次验证边界

以下命令均从本仓库根目录运行，前提是已安装 Node.js；不会启动或停止 Worker。

> - macOS / Linux / Windows (PowerShell)
> - 检查启动器解析、环境保留及回退行为；不代表跨平台实机启动验收

```bash
node --test "$(git rev-parse --show-toplevel)/tests/python-launch.test.mjs"
```

> - macOS / Linux / Windows (PowerShell)
> - 只读检查当前机器登记的 Worker 类服务静态管理能力；未登记时按实际结果报告

```bash
node "$(git rev-parse --show-toplevel)/scripts/doctor.mjs" --service cursor_workers
```

2026-10-28 原始诊断已验证基础解释器保留 venv、关键依赖来源，以及 Temp/Worker 数据目录可写。原始六个 Worker 的实际启动验收被并行 Git 合并冲突中断；不能把上述环境验证记成六个 Worker 全部就绪。本页沉淀经验，不自动恢复服务启停任务。

## 关联

**相关页面**：

- [DSH-AU 服务与插件注册规范](../domain/dsh-au-service-plugin-registration.md) — 区分静态注册能力、运行环境与真实生命周期验收。
- [Windows 下 PYTHONUTF8 让子进程输出解码静默崩溃](windows-pythonutf8-subprocess-decode.md) — 该挂载故障的另一原因，两者需一起修。
- [Windows 开机 `.vbs` 跨仓库入口契约断层与 `pythonw.exe` 静默吞错](windows-boot-vbs-cross-repo-contract.md) — 同样运行于 Windows 开机 `.vbs` 的 `pythonw.exe` 无窗口链路，入口报错会被静默吞没。

**源码**：

- `lib/background-services.js`
- `tests/python-launch.test.mjs`
- `scripts/doctor.mjs`
- `sync/README.md`（Python 服务报 Permission denied 的简明排障入口）
