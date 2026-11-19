# Windows 开机 `.vbs` 跨仓库入口契约断层与 `pythonw.exe` 静默吞错

> `dsh-au` 生成的 Windows 开机启动脚本（`.vbs`）通过 `pythonw.exe -c` 调用外部平台控制器；若跨仓库函数名未同步或未加兼容回退，`pythonw.exe` 会在 `ImportError` 时无弹窗、无日志静默退出。
> 来源: 原文核实于 2026-11-04 若干托管服务开机未启动实机排障与修复 · 更新: 2026-11-17

## 一句话结论

**跨仓库（`dsh-au` → 外部平台控制器）生成的无窗口开机命令必须使用 `getattr(..., fallback)` 兼容新旧入口，且修改生成器后必须重新执行 `syncBootStartupEntry` 刷新系统启动目录中的实体 `.vbs` 文件。**

## 故障表现

- 面板中若干由控制器托管的服务（如本地文件服务、某挂载服务、后台 Worker 服务）均已勾选 `✓ 开机自启`，但电脑重启后始终处于 `○ 已停止`。
- 同机其他勾选了开机自启的服务（独立脚本、Windows 系统服务等）却都在运行。
- 通用控制器目录的日志与 `dsh-au` 均无任何启动失败日志。

## 已核实原因

| 环节 | 事实 |
| --- | --- |
| 跨仓契约断层 | 另一台设备提交将 `lib/background-services.js` 生成的开机命令改为导入控制器模块的 `boot_startup`，但外部平台控制器仓库并未提交 `boot_startup` 函数 |
| 静默吞错机制 | `.vbs` 使用 `sh.Run "...pythonw.exe -X utf8 -c ...", 0, False` 无窗口启动；在进入控制器业务日志前即抛 `ImportError` 退出，标准错误被 `pythonw.exe` 直接丢弃 |
| 幸存者偏差 | 独立脚本服务在 `.vbs` 前一行单独用 PowerShell 启动；系统服务由 Windows SCM 管理；另一些服务勾了「随 DSH 自启」。唯独走控制器内联命令且未勾「随 DSH 自启」的服务全部停着 |

## 修复与防护规范

1. **生成端强制带回退（`lib/background-services.js`）**：
   生成的 Python 内联命令不硬编码裸 `from ... import boot_startup`，改为：
   ```python
   from <controller_pkg> import background_services as _bs
   boot_startup = getattr(_bs, 'boot_startup', lambda ids: [_bs.control_service(s, 'start', notify=False) for s in ids])
   boot_startup([...])
   ```
   即使某台电脑的外部平台控制器尚未更新，也能自动回退到逐项 `control_service(s, 'start', notify=False)`。
2. **被调端补齐依赖顺序（外部平台控制器模块）**：
   `boot_startup(service_ids)` 在同时包含有依赖关系的服务（如前置文件服务与挂载服务）时，自动确保前置服务排在依赖方之前启动。
3. **落盘刷新不可省**：
   修改 `background-services.js` 不会自动改写 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\dsh-au-boot-<Host>.vbs`，修复后需触发一次开机项同步，并用相同命令行在终端用 `python.exe`（非 `pythonw.exe`）实测无报错。

> - macOS / Linux / Windows (PowerShell)
> - 在本仓库根目录运行只读 Doctor，检查服务绑定路径与自启纳管状态

```bash
node "$(git rev-parse --show-toplevel)/scripts/doctor.mjs"
```

## 关联

**相关页面**：

- [DSH-AU 本地服务、云同步服务与插件注册规范](../domain/dsh-au-service-plugin-registration.md) — 开机自启与随 DSH 自启的职责边界及生成规则。
- [DSH 重启连带关闭 Windows 后台服务：Job Object 隔离、持久日志与受限自愈](windows-dsh-job-object-服务退出与自愈.md) — 同一 VBS 生成通路还必须包含 Job Object 脱离标志，并与运行时补丁保持一致。
- [Windows Python 低完整性导致服务日志写入失败](windows-python-low-integrity.md) — Windows 开机 `.vbs` 中 `__PYVENV_LAUNCHER__` 与基础解释器启动协议的来源。

**源码**：

- `lib/background-services.js`（`syncBootStartupEntry`）
- `tests/dsh-au.test.mjs`
- `scripts/doctor.mjs`
