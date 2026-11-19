# dsh-au 知识库索引

> 按需查阅，不重复推导。
> 硬上限约 200 行。超出时拆分为子索引。
> 约定见 [SCHEMA.md](SCHEMA.md)。

## 领域规则（domain）

- [domain/dsh-cloud-plugin-contract.md](domain/dsh-cloud-plugin-contract.md) — 面板与菜单 71/72 共用安装核心，保留入口职责；区分实际版本、声明意图、完整快照与 Profile 文本恢复。
- [domain/dsh-au-service-plugin-registration.md](domain/dsh-au-service-plugin-registration.md) — 注册本地服务、云同步服务与 DSH 插件必读 `sync/README.md`；`syncRepoRoot` 指向私人仓，任意路径脚本可由绑定 JSON 纳管，并由 `scripts/doctor.mjs` 体检。
- [domain/private-extensions-contract.md](domain/private-extensions-contract.md) — 私人仓工作台扩展契约（`sync/extensions/<extId>/`）：定义 `extension.json`、`useExtension`、`handleAction` 规范、新增页面流程与 `scripts/doctor.mjs --extensions` 校验。

## 踩坑记录（gotchas）

- [gotchas/dsh-plugin-install-diagnostics.md](gotchas/dsh-plugin-install-diagnostics.md) — 只读插件 Doctor 排查工具版本/store、Windows 编码、坏快照、实际包与遗留锁，不自动安装或清锁。
- [gotchas/dsh-au-subpath-proxy-api-whitelist.md](gotchas/dsh-au-subpath-proxy-api-whitelist.md) — `/dsh/` 子路径反代（如 Caddy）若白名单仅放行 `/dsh-au/*` 会将 `/dsh-au-todo/api` 拦截为 `404`，导致移动端侧边栏远端工作区与待办空白。
- [gotchas/windows-python-low-integrity.md](gotchas/windows-python-low-integrity.md) — Windows Python 服务日志权限失败：核实低完整性进程，使用原 venv 对应的基础解释器并保留依赖，不重建环境。
- [gotchas/windows-pythonutf8-subprocess-decode.md](gotchas/windows-pythonutf8-subprocess-decode.md) — 控制器的 `PYTHONUTF8=1` 传给服务脚本后，`text=True` 读取 GBK 命令输出会静默崩溃；改为按字节读取、按 OEM 码页解码。
- [gotchas/windows-boot-vbs-cross-repo-contract.md](gotchas/windows-boot-vbs-cross-repo-contract.md) — Windows 开机 `.vbs` 通过 `pythonw.exe` 跨仓库调用 `AuWin` 时，必须带 `getattr` 兼容回退并重新同步 `.vbs`，防止 `ImportError` 被静默吞没。
- [gotchas/windows-dsh-job-object-服务退出与自愈.md](gotchas/windows-dsh-job-object-服务退出与自愈.md) — DSH 重启连带关闭 Windows 后台服务时，检查 Job Object 脱离、持久生命周期日志、受限自愈与多机 binding 隔离。
