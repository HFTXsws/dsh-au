# client/src —— 客户端 bundle 的源片段

这里每个 `.js` 都是**片段**，不是独立模块：它们会被 `scripts/build-client.js` 按 `MODULES` 顺序拼进同一个 `factory(require)` 作用域，等价于原来的单文件 `client/client.js`。

- 片段之间共享作用域，后面的片段可以直接引用前面声明的 `const` / `function`；`const` 不提升，调整顺序前先确认没有前置引用。
- 单独打开某个片段时，编辑器会提示未定义变量或 `return` 位置异常，这是预期现象。
- 改完源文件必须重新生成产物：`node scripts/build-client.js`；`npm test` 会先跑 `--check`，产物过期直接失败。
- `DSH` 只加载 `client/client.js`，不要手改产物。
