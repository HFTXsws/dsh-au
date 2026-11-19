import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const stylesPath = join(root, 'client/src/02-styles.js');
const clientPath = join(root, 'client/client.js');

test('侧边栏工作区标签样式适配浅色与暗色模式主题变量', () => {
  const stylesSrc = readFileSync(stylesPath, 'utf8');
  const clientSrc = readFileSync(clientPath, 'utf8');

  for (const [label, code] of [['02-styles.js', stylesSrc], ['client.js', clientSrc]]) {
    // 1. 验证默认（浅色模式）不使用未注册的暗色写死背景 --dsw-alias-fill-l2 / rgba(30,41,59,.65)
    assert.doesNotMatch(
      code,
      /\.dsh-au-remote-ws-badge\s*\{[^}]*--dsw-alias-fill-l2/g,
      `${label}: 默认 badge 不应再引用不存在的 --dsw-alias-fill-l2`
    );

    // 2. 默认模式下应使用原生 Tag/Pill 规范的 --dsw-alias-bg-module-platform 平台背景
    assert.match(
      code,
      /\.dsh-au-remote-ws-badge\s*\{[^}]*--dsw-alias-bg-module-platform/g,
      `${label}: 默认 badge 必须使用 --dsw-alias-bg-module-platform 变量`
    );

    // 3. 浅色模式下 fallback 文字应为易于阅读的深色灰，且边框为轻浅微边框
    assert.match(
      code,
      /\.dsh-au-remote-ws-badge\s*\{[^}]*color:var\(--dsw-alias-label-secondary,#475569\)/,
      `${label}: 浅色 badge 文字颜色需提供深色回退`
    );

    // 4. 深色模式下（body[data-ds-dark-theme]）应覆盖为暗色背景与亮色字
    assert.match(
      code,
      /body\[data-ds-dark-theme\]\s+\.dsh-au-remote-ws-badge\s*\{[^}]*rgba\(30,41,59,\.65\)/,
      `${label}: 深色模式下 badge 保持舒适暗底`
    );

    // 5. 激活状态在浅色模式下使用品牌强调蓝与浅蓝衬底，而非夜间浅蓝 #93c5fd
    assert.match(
      code,
      /\.dsh-au-remote-ws-row\.active\s+\.dsh-au-remote-ws-badge[^}]*color:var\(--dsw-alias-state-business-primary,#2563eb\)/,
      `${label}: 浅色模式激活态 badge 应使用可读的高对比度商务蓝`
    );

    // 6. 深色模式激活状态保持高亮浅蓝
    assert.match(
      code,
      /body\[data-ds-dark-theme\]\s+[^{]*\.dsh-au-remote-ws-badge\s*\{[^}]*#93c5fd/,
      `${label}: 深色模式激活态保持夜间浅蓝`
    );
  }
});
