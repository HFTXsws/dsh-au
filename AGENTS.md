## 知识库（Wiki）— 仅存私人同步仓库，禁止落盘本开源仓

本仓库为**开源项目**。为防止真实域名、设备名、绝对路径、内网 IP、私人仓库名或凭据意外混入开源提交，**本仓库不维护 `docs/wiki/`，严禁在本仓库新建或写入任何 Wiki 页面**。

- **唯一 Wiki 位置**：维护者的私人同步仓库 `<syncRepoRoot>/docs/wiki/`（包含 `SCHEMA.md`、`index.md`、`log.md` 与具体页）。
- **如何定位 `<syncRepoRoot>`**：依次读取 `~/.dsh/dsh-au.config.json` 中的 `syncRepoRoot` 字段，或环境变量 `DSH_AU_SYNC_REPO`；若本机未配置私人同步仓库（例如外部协作者环境），则跳过 Wiki，直接以本仓库 `README.md`、`sync/README.md` 与源码为准。
- **读写规范**：需要项目历史背景、架构取舍或踩坑记录时，先读 `<syncRepoRoot>/docs/wiki/index.md` 再读具体页；对话里出现「下次还会踩」的结论，列出候选页，经用户确认后写回 `<syncRepoRoot>/docs/wiki/`（绝不写入本开源仓库）。

## Git 提交署名自检

- 在本仓库执行 `git commit` 前，先检查当前仓库本地是否已单独配置 `user.name` 与 `user.email`（`git config --local user.name` / `git config --local user.email`）。
- 若未单独配置（或当前生效邮箱仍为全局其他邮箱），在提交前先向维护者确认，必要时写入本地署名：
  - `git config --local user.name "HFTXsws"`
  - `git config --local user.email "358544300+HFTXsws@users.noreply.github.com"`
- 该规则仅作为换机防遗忘与防误用其他全局邮箱的提醒；若协作者明确使用自己的署名，不强制覆盖。

## 前端构建校验（Windows CRLF）

- 若 `npm test` / `npm run check:client` 报错 `client/client.js 与 client/src 不一致`，先执行 `npm run build:client` 再重跑 `npm test`（详情见 `<syncRepoRoot>/docs/wiki/gotchas/windows-client-bundle-crlf-check.md`）。
- 构建后若仅因 CRLF/LF 差异导致 `git add client/client.js` 无实质变更，无需额外提交。

