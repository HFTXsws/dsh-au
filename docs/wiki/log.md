# dsh-au 知识库变更时间线

> Append-only。记录每次知识库操作。

## [2026-11-17] ingest | 初始化 dsh-au 相关 Wiki

- 操作：ingest
- 来源：整理既有 dsh-au 排障与契约笔记，写入本仓库 `docs/wiki/`
- 变更：新增 `domain/dsh-au-service-plugin-registration.md`、`domain/dsh-cloud-plugin-contract.md`、`gotchas/dsh-plugin-install-diagnostics.md`、`gotchas/dsh-au-subpath-proxy-api-whitelist.md`、`gotchas/windows-python-low-integrity.md`、`gotchas/windows-pythonutf8-subprocess-decode.md`、`gotchas/windows-boot-vbs-cross-repo-contract.md`、`gotchas/windows-dsh-job-object-服务退出与自愈.md`；更新 `index.md`
- 适配：源码路径改为本仓库 `lib/`、`client/`、`scripts/doctor.mjs`、`sync/`；`syncRepoRoot` / `dsh-sync` 布局按 `sync/README.md` 改写；菜单 71/72 与插件 Doctor CLI 仍指向 `<syncRepoRoot>/scripts/`
- 未收录：与本插件无关的页面

## [2026-11-17] lint | 初始化后健康检查

- 操作：lint
- 来源：本轮新增 8 页后按 SCHEMA 做互链与路径核验
- 变更：修正 `domain/` 页指向 `sync/README.md` 与 `lib/*.js` 的相对路径（应为 `../../../`）；核验 8 页全部进入 `index.md`、Wiki 页互链双向、本仓库源码路径存在
- 验证：`index.md` 19 行；未执行代码测试

## [2026-11-18] ingest | 私人仓库工作台扩展契约与 Doctor 指南

- 操作：ingest
- 来源：将私人工作台扩展迁至 `<syncRepoRoot>` 后抽离通用私人扩展机制，补齐参考规范与自检说明
- 变更：新增 `domain/private-extensions-contract.md`；更新 `index.md`、`domain/dsh-au-service-plugin-registration.md` 双向关联与 `sync/README.md`

## [2026-11-18] update | 补充私人扩展渲染与 Hook 解构防呆校验

- 操作：update
- 来源：排查 `useMemo` 未解构拖垮 `shell.overlay`、以及 `compilePrivateExtension` 与 Doctor 导出校验不一致导致扩展面板空白
- 变更：在 `domain/private-extensions-contract.md` 补充 `useExtension` 兼容写法、`renderCenter` 约束与 `01-runtime.js` Hook 解构规则；同步增强 `lib/private-extensions.js` Doctor 试跑与 `tests/private-extensions.test.mjs` 回归检查

## [2026-11-21] ingest | Windows 下 client/client.js CRLF 换行符校验误报

- 操作：ingest
- 来源：多机切换后在 Windows 运行 `npm test` 频繁触发 `check:client` 报错
- 变更：新增 `gotchas/windows-client-bundle-crlf-check.md`，更新 `index.md` 与 `AGENTS.md`

