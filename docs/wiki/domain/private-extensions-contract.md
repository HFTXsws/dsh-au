# DSH-AU 私人仓库工作台扩展契约与新页面指南

> 定义 `sync/extensions/<extId>/` 的目录规范、前后端接口、热挂载生命周期与 Doctor 自检，保证出厂 `dsh-au` 零私有逻辑且私人仓可独立新增工作台页面。
> 来源: 从私人同步仓扩展需求抽离的通用扩展机制；核实于 `lib/private-extensions.js`、`client/src/10-workbench.js`、`scripts/doctor.mjs` · 更新: 2026-11-18

## 设计原则与出厂边界

1. **出厂零污染**：未配置 `syncRepoRoot`（或环境变量 `DSH_AU_SYNC_REPO`）时，`resolveSyncDir()` 返回 `null`，`dsh-au` 不加载任何私人扩展，工作台不渲染扩展导航项。
2. **目录即挂载**：凡位于当前有效 `<syncDir>/extensions/<folder>/` 下且含合法 `extension.json` 的目录，工作台打开/刷新时自动注入样式、挂载左侧导航与右侧详情，无需修改 `dsh-au` 源码。
3. **同源通道复用**：所有扩展后端动作统一通过 `/dsh-au/api` 的 `action: 'extAction'` 转发，无需调整反向代理（如 Caddy `/dsh/` 子路径白名单）。
4. **路径安全隔离**：所有扩展资源（`clientFile`、`styleFile`、`serverFile`）均经 `path.relative` 校验，禁止 `../` 越界访问扩展目录之外的文件。

## 目录结构与 `extension.json` 规范

```text
<syncDir>/extensions/<folder>/
├── extension.json   # 必填：清单（id / title / order / iconSvg / 文件名）
├── client.js        # 必填：前端组件工厂脚本（返回 useExtension Hook）
├── styles.css       # 可选：私有样式（注入工作台 <style>）
└── server.js        # 可选：后端处理器（导出 async function handleAction）
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | `string` | 是 | 匹配 `^[a-z0-9][a-z0-9-]{0,47}$`，全局唯一；前端 Tab 标识为 `ext:<id>` |
| `title` | `string` | 是 | 左侧导航栏显示名称 |
| `order` | `number` | 否 | 排序权重（升序，默认 `100`；常用推荐 `20~50`） |
| `surfaces` | `string[]` | 否 | 挂载位置数组，可选 `'workbench'`（工作台弹窗页签，默认）与 `'sidebar'`（左侧边栏工作区树 + 右侧主舞台）；支持传 `sidebar: true` 简写 |
| `iconSvg` | `string` | 否 | 16×16 线性 SVG 字符串；缺省使用通用扩展图标 |
| `clientFile` | `string` | 否 | 默认 `client.js` |
| `styleFile` | `string` | 否 | 默认 `styles.css` |
| `serverFile` | `string` | 否 | 默认 `server.js` |

## 前端契约（`client.js`）

`client.js` 由工作台以 `new Function('React', 'h', scriptText)` 编译执行，必须返回一个遵循 React Hooks 规则的 `useExtension` 函数（每次渲染都会调用，禁止在条件分支内调用 Hook）：

```js
return function useExtension({ id, title, active, callExt }) {
  const { useState, useEffect, useCallback } = React;
  const [data, setData] = useState(null);

  useEffect(() => {
    if (active && !data) {
      callExt('getDashboard', {}).then(setData);
    }
  }, [active, data, callExt]);

  return {
    renderCenter: () => h('div', { className: 'my-ext-center' }, '中间主区'),
    renderInspector: () => h('div', { className: 'my-ext-insp' }, '右侧详情区'),
  };
};
```

- `active`：`boolean`，当前工作台是否停留在 `ext:<id>` 标签页（或侧边栏扩展的主舞台是否激活）；建议仅在需要时按需拉取远端数据。
- `callExt(subAction, payload)`：自动发送 `{ action: 'extAction', extId: id, subAction, payload }` 到 `/dsh-au/api` 并返回 JSON 结果。
- `selectStageItem(itemId)` / `clearStage()` / `activeStageItem`：当 `surfaces` 含 `'sidebar'` 时由宿主壳层注入，用于从左侧边栏树节点一键激活右侧主舞台（`.dsh-au-stage`）并传入选中项 ID，或切回本机默认会话。
- 导出形式兼容直接 `return function useExtension(...)` 与 `return { useExtension }` 两种写法：
  - 工作台扩展（`surfaces` 含 `'workbench'`）返回对象必须提供 `renderCenter()` 函数，可选 `renderInspector()`；
  - 侧边栏工作区扩展（`surfaces` 含 `'sidebar'`）返回对象必须提供 `renderSidebar()`（挂载到左侧栏工作区树底部，与「本机 / 远程设备」分组同级）与 `renderStage({ itemId, selectStageItem, clearStage })`（或复用 `renderCenter()`，挂载到右侧主舞台）。
- **宿主运行时 Hook 约束**：`client/src/*.js` 合并为单文件作用域后共用 [client/src/01-runtime.js](../../../client/src/01-runtime.js) 顶部的 `const { ... } = React;` 解构；在工作台扩展宿主或其它前端模块新引入 `useMemo` 等 Hook 时，必须同步补进 `01-runtime.js` 并重新生成 `client/client.js`，否则会触发 `ReferenceError` 导致 `shell.overlay` 崩溃与全局快捷键失效（已由 `tests/private-extensions.test.mjs` 自动拦截）。

## 后端契约（`server.js`）

`server.js` 为 ESM 模块，导出 `handleAction`，支持按 `mtimeMs` 变更自动热重载：

```js
export async function handleAction({ action, body, ctx }) {
  if (action === 'getDashboard') {
    return { ok: true, items: [] };
  }
  return { ok: false, error: `未知动作: ${action}` };
}
```

- `action`：前端 `callExt(subAction, payload)` 传入的 `subAction`。
- `body`：前端传入的 `payload` 对象。
- `ctx`：宿主注入上下文，包含 `{ cfg, platformOs, getLocalHostInfo }`。
- **注意**：私人扩展的 `server.js` 中不可把真实密钥写入仓库 JSON；需与 `dsh-au` 一样遵循凭据隔离原则。

## 新增一个工作台页面的 4 步

1. 在 `<syncDir>/extensions/<new-slug>/` 新建 `extension.json`（设定唯一 `id`、`title`、`order`）与 `client.js`（可选 `styles.css`、`server.js`）。
2. 参考模板目录 `<syncDir>/extensions/<example-ext>/` 实现 `useExtension` 与 `handleAction`。
3. 在 `dsh-au` 仓库运行只读体检，确认清单、路径、前后端导出全部就绪：

```bash
# macOS / Linux / Windows (PowerShell)
npm run doctor -- --extensions
node scripts/doctor.mjs --ext <id>
```

4. 刷新工作台弹窗即可在左侧导航看到新页面（无需重启或重新构建 `dsh-au` 前端）。

## 关联

**相关页面**：

- [DSH-AU 本地服务、云同步服务与插件注册规范](dsh-au-service-plugin-registration.md) — `syncRepoRoot` 路径解析、四层真相与本地服务 Doctor 入口。
- [子路径反代（Caddy）漏放行 `/dsh-au-todo/*` 导致移动端远端工作区空白](../gotchas/dsh-au-subpath-proxy-api-whitelist.md) — 解释为何扩展复用 `/dsh-au/api` 通道可免改反代白名单。

**源码**：

- `lib/private-extensions.js`
- `lib/sync-repo.js`
- `lib/index.js`
- `client/src/10-workbench.js`
- `client/src/09-workbench-views.js`
- `scripts/doctor.mjs`
