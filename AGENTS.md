## 知识库（Wiki）

项目知识在 `docs/wiki/`。

- 约定：`docs/wiki/SCHEMA.md`
- 入口：`docs/wiki/index.md`
- 时间线：`docs/wiki/log.md`

需要项目知识时，先读 `index.md`，再读具体页。不要每次从源码重新推。
对话里出现「下次还会踩」的结论，列出候选页，确认后再写回。
- **严禁写入隐私内容**：不得在 `docs/wiki/` 中记录真实域名、个人设备/主机名、本机绝对路径（含用户名或盘符项目目录）、私人仓库名或路径、内网 IP、Token/密钥或账号凭据；示例统一使用 `example.com`、`<device>`、`<syncRepoRoot>` 等占位符。

## Git 提交署名自检

- 在本仓库执行 `git commit` 前，先检查当前仓库本地是否已单独配置 `user.name` 与 `user.email`（`git config --local user.name` / `git config --local user.email`）。
- 若未单独配置（或当前生效邮箱仍为全局其他邮箱），在提交前先向维护者确认，必要时写入本地署名：
  - `git config --local user.name "HFTXsws"`
  - `git config --local user.email "358544300+HFTXsws@users.noreply.github.com"`
- 该规则仅作为换机防遗忘与防误用其他全局邮箱的提醒；若协作者明确使用自己的署名，不强制覆盖。

## 前端构建校验（Windows CRLF）

- 若 `npm test` / `npm run check:client` 报错 `client/client.js 与 client/src 不一致`，先执行 `npm run build:client` 再重跑 `npm test`（详情见 `docs/wiki/gotchas/windows-client-bundle-crlf-check.md`）。
- 构建后若仅因 CRLF/LF 差异导致 `git add client/client.js` 无实质变更，无需额外提交。

