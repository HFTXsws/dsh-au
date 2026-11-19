/**
 * 插件中文描述覆盖表。
 *
 * 为什么需要：DSH 原生插件市场（dshmarket）卡片的描述来自联网目录，那里的
 * description 是 { zh, en } 多语言对象；插件自己的 package.json 只有一段原文
 * （多数是英文）。dsh-au 面板离线读本地包，所以默认只能拿到英文。
 *
 * 约定：键 = npm 包名，值 = 一行中文描述。没命中就回退 package.json 原文，
 * 不会因为缺条目而留空。新增插件补一行即可。
 */
export const PLUGIN_DESCRIPTIONS_ZH = {
  '@ash-qw/dsh-theme-prts': '面向 DSH Web 的非官方明日方舟 P.R.T.S. 风格界面主题，提供外观预设、辅助功能与会话导航。',
  'beauticode-dsh': '为 DSH Web 与官方桌面客户端提供图片 / 视频背景的 Cordis 插件。',
  // 原描述是中英双语拼在一行，中文面板里只留中文。
  'dshmarket': 'DSH 可视化插件市场：浏览、搜索并一键安装社区插件。',
  'dsh-find-plugins': '跨多个社区目录并叠加 GitHub 与 npm 实时搜索来找 DSH 插件，按相关度、可信度、新鲜度与有界热度排序，而不是只看 star。',
};

/**
 * 取插件描述的最终展示文案：中文覆盖优先，其次插件自带的 package.json 原文。
 * @param {string} packageName 插件包名
 * @param {string} fallback 插件 package.json 里的 description 原文
 */
export function resolvePluginDescription(packageName, fallback = '') {
  const zh = typeof PLUGIN_DESCRIPTIONS_ZH[packageName] === 'string'
    ? PLUGIN_DESCRIPTIONS_ZH[packageName].trim()
    : '';
  return zh || fallback;
}
