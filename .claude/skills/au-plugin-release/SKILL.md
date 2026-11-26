---
name: au-plugin-release
description: DSH 插件版本对齐、Release 更新日志生成、预检打包与上架发布工具。当用户输入“Au插件发布”、“发版”、“发布插件”、“上架插件市场”或需要对齐当前 DSH 版本号发版时使用。
---

# Au插件发布

将本仓库 DSH 插件版本号对齐本机当前运行的 DSH 版本前缀（格式 `<dsh版本>-<递增序号>`，如 `0.2.2-rc.3-1`、`0.2.2-rc.3-2`），由脚本一站式完成版本计算、前端构建体检与提交记录采集，并在**用户确认 Release 更新日志后**同步推送到 GitHub 与创建 GitHub Release（供 DSH 插件市场「更新内容 ›」展示宽屏版本说明）。

## 工作流

### 1. 预检与版本对齐计算（只读或写入版本号）

调用捆绑脚本获取当前 DSH 版本、下一递增版本号（`versionPlan.nextVersion`）、上次 Release 以来的提交记录（`recentCommits`）以及构建校验结果：

- **预览下一版本号、近期提交与仓库状态（不改文件）**：
  - macOS / Linux / Git Bash:
    ```bash
    node .claude/skills/au-plugin-release/scripts/release-plugin.mjs --mode plan
    ```
  - Windows PowerShell:
    ```powershell
    node .claude/skills/au-plugin-release/scripts/release-plugin.mjs --mode plan
    ```

- **将新版本号写入 `package.json` 并执行构建与检查（已跑过测试可加 `--skip-tests`）**：
  - macOS / Linux / Git Bash:
    ```bash
    node .claude/skills/au-plugin-release/scripts/release-plugin.mjs --mode apply --skip-tests
    ```
  - Windows PowerShell:
    ```powershell
    node .claude/skills/au-plugin-release/scripts/release-plugin.mjs --mode apply --skip-tests
    ```

### 2. 生成中文 Release 日志草稿并交由用户确认（推送门禁）

**核心门禁：在执行 `git push` 和创建 GitHub Release 之前，必须先向用户展示拟发布的版本号与中文 Release 日志草稿，等待用户确认或修改。**

Release 日志草稿要求（适配 `dshmarket` 宽屏 Markdown 渲染器）：
- 仅使用三级标题 `###`、无序列表 `-`、加粗 `**` 与行内代码 `` ` ``（不写裸 HTML，方便插件市场直接渲染）。
- 用用户一眼能看懂的大白话总结本次「新增与优化」或「问题修复」，不堆砌内部函数名或文件路径。

展示模板：
```markdown
拟发布版本：`v<nextVersion>`

### 新增与优化
- **<功能点标题>**：<一句话人话说明>
```

### 3. 用户确认后：提交推送并发布 GitHub Release

用户确认 Release 日志后：
1. 若 `gitState.signatureConfigured` 为 `false`，先按 `AGENTS.md` 配置本地署名（`HFTXsws` / `358544300+HFTXsws@users.noreply.github.com`）。
2. 提交并推送代码到 `github`（使用 `gh auth git-credential` 确保走 `HFTXsws` 账号）与 `origin`：
   - macOS / Linux / Git Bash:
     ```bash
     git add -A && git commit -m "chore(release): bump version to <nextVersion>" && git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push github main && git push origin main
     ```
   - Windows PowerShell:
     ```powershell
     git add -A; git commit -m "chore(release): bump version to <nextVersion>"; git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push github main; git push origin main
     ```
3. 将用户确认的 Release 日志写入临时文件，调用脚本 `--mode publish-release` 创建（或更新）GitHub Release，随后删除临时文件：
   - macOS / Linux / Git Bash:
     ```bash
     node .claude/skills/au-plugin-release/scripts/release-plugin.mjs --mode publish-release --target-version <nextVersion> --notes-file <notesFilePath>
     ```
   - Windows PowerShell:
     ```powershell
     node .claude/skills/au-plugin-release/scripts/release-plugin.mjs --mode publish-release --target-version <nextVersion> --notes-file <notesFilePath>
     ```

### 4. 发版收尾：同步云端插件清单（防多机 `VERSION_MISMATCH`）

`dsh-au` 作为 `local` / `local-repo` 软链插件，官方配置同步在启动时会自动跳过版号上云（避免其他机器未 `git pull` 时产生假不一致）。因此 GitHub Release 发布完成后，必须提醒用户在当前已更新到新版的机器上完成一次手动云清单对齐：

1. 在 DSH 中打开「插件管理 → 同步到云」，将云清单中的 `dsh-au` 版本更新为 `<nextVersion>`。
2. 在对应的同步仓库中提交并推送该变更，避免其他机器执行 Doctor 时触发 `VERSION_MISMATCH`。

