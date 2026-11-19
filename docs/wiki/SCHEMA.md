# dsh-au Wiki Schema

> 本文件定义 `docs/wiki/` 的组织约定。执行 Ingest、Query、Lint 时遵循本文件。

## 0. 铁律

1. 交叉引用是灵魂。新建或更新页面时，检查强相关兄弟页，并双向加链。
2. Lint 是必修。大约每 5 次写入做一轮健康检查，并在 `log.md` 追加 `lint`。
3. 好查询要存回。有复用价值的查询结论写成新页，操作记为 `query-filed`。

## 1. 目录

- `SCHEMA.md`：本约定
- `index.md`：目录，硬上限约 200 行
- `log.md`：时间线，只追加
- `architecture/`：架构取舍
- `gotchas/`：已核实的坑
- `domain/`：领域规则
- `processes/`：流程

没有页面时不要建分类目录。文件名用 kebab-case。

## 2. index.md

按分类写 `## {分类名}`。每个页面有且仅有一行：`- [path](path) — 一句话摘要`。超过约 200 行时拆成 `index-{category}.md` 子索引，主索引只留分类链接。

## 3. 页面

```markdown
# {标题}

> {一句话定位}
> 来源: {说明} · 更新: {YYYY-MM-DD}

## {正文小节}

{表格、列表、段落均可}

## 关联

**相关页面**：

- [标题](relative.md) — 为何相关

**源码**：

- `path/to/file`
```

- 标题用 `#`，正文从 `##` 开始
- 首段引用必须含一句话定位、来源、日期
- 关联分两栏：相关 Wiki 页、源码路径。两栏不要混写
- 相关页面原则上不得为空。确无兄弟页时写 `- 暂无（孤立知识点）`，供 Lint 复核
- A 链 B，B 必须链回 A

## 4. log.md

只在末尾追加。不改旧条目。

```markdown
## [{YYYY-MM-DD}] {operation} | {标题}

- 操作：{ingest | query-filed | lint | update}
- 来源：{触发来源}
- 变更：{改了哪一页}
```

`ingest`：新页或大幅更新。`update`：更新已有页。`query-filed`：查询结论存成页。`lint`：健康检查。

## 5. 操作

**Ingest**：已核实知识，新建或更新页面，更新 `index.md`，追加 `log.md`。不改本文件。

**Query**：先读 `index.md`，再读具体页。有复用价值的结论存回，操作记为 `query-filed`。

**Lint**：大约每 5 次 ingest 一轮。检查孤岛页、该互链未互链、单向链、过时内容、该建未建、index 是否接近 200 行。做完追加 `log.md`。

## 6. 四层

| 层 | 放哪 | 干什么 |
|---|---|---|
| Schema | `docs/wiki/SCHEMA.md` | 格式、操作、铁律 |
| Wiki | `index.md` + 各页 | 编译后的知识 |
| Rules | `.cursor/rules/` | MUST / NEVER；细节指向 Wiki 页 |
| Raw | 源码、过程稿、聊天 | 原材料。沉淀完可进 `_archive/` |
