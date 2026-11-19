# Windows 下 PYTHONUTF8 让子进程输出解码静默崩溃

> DSH-au 以 `PYTHONUTF8=1` 拉起外部平台控制器，环境变量会传给服务脚本；脚本里 `text=True` 读取 `tasklist` / PowerShell 的本地码页输出时会崩溃或返回空结果。
> 来源: 原文核实于 2026-10-28 某挂载服务启动失败实机复现、示例挂载脚本修复与回归测试 · 更新: 2026-11-17

## 一句话结论

**系统命令输出按字节捕获，再按 OEM 码页容错解码。** 不要在服务脚本里依赖 `subprocess.run(..., text=True)` 的默认编码。

## 故障表现

- 面板报 `启动器退出码 1`，外部平台控制器日志只有一行服务启动标记（如 `[MountService] 某挂载服务`），之后没有任何错误。
- 原因是控制器调度脚本把子脚本的 stdout/stderr 定向到 `DEVNULL`，异常堆栈被丢弃，日志里看不到崩溃。

## 已核实原因

| 环节 | 事实 |
| --- | --- |
| 控制器环境 | `resolveControllerPythonLaunch`（兼容别名 `resolveAuWinPythonLaunch`）为控制器设置 `PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8`，子进程继承 |
| UTF-8 模式影响 | `text=True` 按 UTF-8 解码；中文 Windows 的 `tasklist` 管道输出是 GBK |
| 崩溃形式 | 读线程抛 `UnicodeDecodeError`，`result.stdout` 变为 `None`，随后字符串包含判断（如 `"target.exe" in None`）抛 `TypeError`，脚本退出码 1 |
| 静默隐患 | 进程枚举函数（如 `list_mount_pids()`）写成 `result.stdout or ""`，不会崩溃但返回空列表，停止挂载时会误报“没有匹配进程” |

控制器自身需要 UTF-8 输出 JSON，所以修复点放在服务脚本的命令读取处，而不是去掉控制器的 `PYTHONUTF8`。

## 修复方式

示例挂载脚本新增 `_run_text()`：按字节捕获输出，用 `oem` 编解码器加 `errors="replace"` 解码；没有 `oem` 的平台退回 UTF-8。进程存活判断与 PID 枚举函数都改用它。

回归测试在 `PYTHONUTF8=1` 的子进程中运行真实模块，只把系统命令替换成输出 GBK 字节的真实进程：修复前复现同一 `TypeError`，修复后通过。

## 下次排查顺序

1. `启动器退出码 N` 且日志中断时，先用控制器同款环境（`PYTHONUTF8=1`）直接运行脚本，拿到被 `DEVNULL` 吞掉的堆栈。
2. 搜索脚本里所有 `text=True` / `universal_newlines=True` 的系统命令调用，确认是否按固定编码解码。
3. 同类调用（其他读取 `tasklist`/`netstat`/PowerShell 的挂载或后台脚本）按需同样修复。

## 关联

**相关页面**：

- [Windows Python 低完整性导致服务写入失败](windows-python-low-integrity.md) — 同一次挂载故障的另一个原因：解码修好后，挂载子程序仍因 Low 完整性写不了缓存。
- [DSH-AU 服务与插件注册规范](../domain/dsh-au-service-plugin-registration.md) — 控制器启动环境与静态体检的边界。
- [DSH 云插件安装失败与只读诊断](dsh-plugin-install-diagnostics.md) — Node 插件命令同样按字节捕获并区分 UTF-8/系统码页；不要把乱码当作安装根因。

**源码**：

- `lib/background-services.js`（`resolveControllerPythonLaunch` / `resolveAuWinPythonLaunch`）
- 通用控制器目录中的示例挂载脚本及对应解码回归测试（不在本仓库）
- 通用控制器目录中的后台服务调度模块（丢弃子脚本输出；不在本仓库）
