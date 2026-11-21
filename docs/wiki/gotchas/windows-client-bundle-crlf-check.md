# Windows 下 client/client.js 换行符导致 check:client 报错

> 解释 Windows 环境下 `npm test` / `npm run check:client` 误报前端产物不一致的原因与标准处理方式。
> 来源: 多机协作排查 · 更新: 2026-11-21

## 现象

执行 `npm test` 或 `npm run check:client` 时报错：

```text
client/client.js 与 client/src 不一致，请运行：node scripts/build-client.js
```

同时 `tests/client-build.test.mjs` 中相关校验用例失败，但实际上 `client/src/` 并没有未构建的代码改动。

## 原因

1. `scripts/build-client.js` 按 LF（`\n`）拼接 `client/src/*.js` 并逐字节比对 `client/client.js`。
2. 在 Windows 上 Git 检出或保存文件时若启用了 `core.autocrlf`，工作区里的 `client/client.js` 会变成 CRLF（`\r\n`），导致字节比对失败。
3. 另一种可能是协作者在另一台机器修改了 `client/src/` 后未重新运行 `npm run build:client`。

## 处理规范

1. 遇到该报错时，**先运行 `npm run build:client`**，再执行 `npm test` 验证全量测试。
2. 构建完成后运行 `git status -sb` 确认是否存在真实内容变更：
   - 若 `git add client/client.js` 后工作区变干净（`nothing to commit`），说明仅是换行符差异，**不要**强行提交或制造无意义提交。
   - 若确实产生了实质 diff（说明此前 `client/src/` 有未构建改动），再正常提交 `client/client.js`。

## 关联

**相关页面**：

- 暂无（孤立知识点）

**源码**：

- `scripts/build-client.js`
- `tests/client-build.test.mjs`
- `client/client.js`
