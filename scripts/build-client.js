#!/usr/bin/env node
// 零依赖构建脚本：把 client/src/*.js 片段按固定顺序拼成 DSH 可加载的 client/client.js。
// 之所以不用打包器：这些片段共享同一个 factory 作用域（等价于原单文件），
// 只需按依赖顺序拼接，不需要模块解析。改完源文件跑一次本脚本即可。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const srcDir = join(root, 'client/src');
export const outFile = join(root, 'client/client.js');

// 拼接顺序 = 依赖顺序：后面的片段可以直接引用前面声明的 const/function。
// factory 作用域内 const 不提升，调整顺序前先确认没有前置引用。
export const MODULES = [
  ['01-runtime.js', '常量、事件桥、设备切换、视口与本地偏好'],
  ['01a-shortcuts.js', '快捷键动作表、绑定匹配、浏览器本地覆盖'],
  ['01b-model-shortcuts.js', '共享模型快捷配置、当前会话选模与受控 iframe 桥'],
  ['02-styles.js', '样式表与 ensureStyles'],
  ['03-routes.js', '路由选择、访问标签与 callApi'],
  ['04-actions.js', '插件通知、复制/跳转与上报'],
  ['05-icons.js', '图标原子组件'],
  ['06-cards.js', '登录卡片、设备/路由/远程管理弹窗'],
  ['07-menu-model.js', '菜单可直跑判定'],
  ['08-workbench-logic.js', '工作台纯函数：日志切片、规则识别、产物压缩、额度解析'],
  ['09-workbench-views.js', '工作台渲染：菜单卡、服务卡、插件卡、中心区与检查器'],
  ['10-workbench.js', '统一工作台弹窗状态与交互'],
  ['10a-remote-frame.js', '远程页面实例、加载期限与生命周期诊断'],
  ['10b-initial-session-focus.js', '首次进入对话定位与输入保护'],
  ['10c-remote-session-preload.js', '最近 48 小时远程会话预加载队列与只读缓存协议'],
  ['11-shell.js', '常驻壳层、设备栏与远程 iframe'],
  ['12-window-state.js', '注入声明与窗口位置记忆'],
  ['13-settings.js', '设置页分区'],
  ['13a-shortcut-settings.js', '设置页：快捷键管理'],
  ['13b-model-shortcut-settings.js', '设置页：共享模型快捷切换'],
  ['14-todo.js', '待办面板（原 dsh-au-todo 客户端）'],
  ['14a-remote-workspaces.js', '侧边栏远端工作区原生融合'],
  ['15-mobile.js', '移动端抽屉（原 dsh-au-mobile 客户端）'],
  ['16-entry.js', 'apply 与插槽注册'],
];

const HEADER = [
  '// 本文件由 scripts/build-client.js 从 client/src/*.js 生成，请勿直接编辑。',
  '// 修改源文件后运行：node scripts/build-client.js',
].join('\n') + '\n';

/** 拼出完整 bundle 文本；测试与 --check 共用同一实现，避免两份拼接逻辑漂移。 */
export function build() {
  const regions = MODULES.map(([file, purpose]) => {
    const code = readFileSync(join(srcDir, file), 'utf8');
    if (!code.endsWith('\n')) throw new Error(`${file} 必须以换行结尾`);
    return `//#region src/${file} — ${purpose}\n${code}//#endregion\n`;
  });
  return `${HEADER}window.__ModuleLoader__.load({\n`
    + `  id: 'dsh-au',\n`
    + `  factory: (require) => {\n`
    + regions.join('')
    + `\n    return { name: 'dsh-au', inject, apply, mobile: mobileClient.helpers, shortcuts: shortcutHelpers };\n`
    + `  },\n});\n`;
}

/** 源文件里存在但没进 manifest 的片段会被漏打包，这里显式列出来供测试断言。 */
export function orphanSources() {
  const listed = new Set(MODULES.map(([file]) => file));
  return readdirSync(srcDir).filter((file) => file.endsWith('.js') && !listed.has(file));
}

/** 2026-10-28：无变化也写文件会触发宿主 HMR，打断保活页面；只在内容变化时写入。 */
export function writeClientIfChanged(output, target = outFile) {
  try {
    if (readFileSync(target, 'utf8') === output) return false;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  writeFileSync(target, output, 'utf8');
  return true;
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const output = build();
  if (process.argv.includes('--check')) {
    const current = readFileSync(outFile, 'utf8');
    if (current !== output) {
      console.error('client/client.js 与 client/src 不一致，请运行：node scripts/build-client.js');
      process.exit(1);
    }
    console.log('client/client.js 与源文件一致');
  } else if (writeClientIfChanged(output)) {
    console.log(`已生成 ${outFile}（${output.split('\n').length - 1} 行）`);
  } else {
    console.log(`未变化 ${outFile}（跳过写入）`);
  }
}
