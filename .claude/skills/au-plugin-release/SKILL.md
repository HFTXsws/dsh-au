---
name: au-plugin-release
description: DSH 插件版本对齐、预检打包与上架发布工具。当用户输入“Au插件发布”、“发版”、“发布插件”、“上架插件市场”或需要对齐当前 DSH 版本号发版时使用。
---

# Au插件发布

将本仓库 DSH 插件版本号对齐本机当前运行的 DSH 版本前缀（格式 `<dsh版本>-<递增序号>`，如 `0.2.2-rc.3-1`、`0.2.2-rc.3-2`），并由脚本一站式完成前端构建、一致性检查、测试与打包预览。

## 工作流

### 1. 预检与版本对齐计算（只读或写入版本号）

直接调用捆绑脚本，禁止手算版本号或手动拼接文件检查：

- **仅预览下一版本号与仓库状态（不改文件）**：
  - macOS / Linux / Git Bash:
    ```bash
    node .claude/skills/au-plugin-release/scripts/release-plugin.mjs --mode plan
    ```
  - Windows PowerShell:
    ```powershell
    node .claude/skills/au-plugin-release/scripts/release-plugin.mjs --mode plan
    ```

- **写入新版本号并执行构建与检查（跳过全量测试用 `--skip-tests`）**：
  - macOS / Linux / Git Bash:
    ```bash
    node .claude/skills/au-plugin-release/scripts/release-plugin.mjs --mode apply
    ```
  - Windows PowerShell:
    ```powershell
    node .claude/skills/au-plugin-release/scripts/release-plugin.mjs --mode apply
    ```

脚本读取 `~/.dsh/logs/desktop-next-*.jsonl` 中当前运行的 `fields.dsh` 版本作为前缀，结合 `package.json` 与 npm 已发布版本自动算出 `<dshVersion>-<N>`（从 `1` 起无限递增），并输出结构化 JSON（含 `versionPlan`、`buildCheck`、`packInfo`、`gitState`）。

### 2. Git 署名核对与提交推送确认

根据脚本返回的 `gitState` 与 `versionPlan`：
1. 若 `gitState.signatureConfigured` 为 `false`，按项目 `AGENTS.md` 提醒或设置本地 Git 署名（`HFTXsws` / `358544300+HFTXsws@users.noreply.github.com`）。
2. 向用户展示计算出的目标版本号（`versionPlan.nextVersion`）、变更文件与 `packInfo` 摘要，确认后执行提交、推送与 `npm publish`（属于对外发布操作，未经用户当轮明确授权不得自动执行 `git push` 或 `npm publish`）。

### 3. 提交并推送到 GitHub（插件市场自动抓取更新）

本插件在 `awesome-dsh-plugin` 插件市场以 GitHub 仓库方式上架（`https://github.com/HFTXsws/dsh-au`），市场爬虫会直接读取 GitHub 默认分支的 `package.json` 版本号与源码，**无需 `npm publish`**。

用户确认发布后，使用 `gh auth git-credential` 确保以 `HFTXsws` 账号推送至 `github`（并同步推送 `origin`）：
- macOS / Linux / Git Bash:
  ```bash
  git add -A && git commit -m "chore(release): bump version to <nextVersion>" && git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push github main && git push origin main
  ```
- Windows PowerShell:
  ```powershell
  git add -A; git commit -m "chore(release): bump version to <nextVersion>"; git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push github main; git push origin main
  ```
