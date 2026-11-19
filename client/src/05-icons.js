    function SidebarIcon(props) {
      const size = props?.size ?? 16;
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('rect', { x: 2, y: 3, width: 20, height: 14, rx: 2 }),
        h('line', { x1: 8, y1: 21, x2: 16, y2: 21 }),
        h('line', { x1: 12, y1: 17, x2: 12, y2: 21 })
      );
    }

    /** 使用同一笔画图标提示设备栏展开与折叠，不依赖字体或 emoji。 */
    function DeviceBarChevron({ expanded = false }) {
      return h(
        'svg',
        { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('polyline', { points: expanded ? '6 15 12 9 18 15' : '6 9 12 15 18 9' })
      );
    }

    /** 顶栏与弹窗操作共用一套 16px 线性图标，显式锁定宽高以防在普通 flex 容器中被放大。 */
    function ToolbarIcon({ children, className = '' }) {
      return h('svg', { className, width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, children);
    }
    /** 三横线只表示工具展开入口，与工作台的统一菜单图标区分。 */
    function ToolbarMenuIcon() {
      return h(ToolbarIcon, null, [
        h('line', { key: 'top', x1: 4, y1: 6, x2: 20, y2: 6 }),
        h('line', { key: 'middle', x1: 4, y1: 12, x2: 20, y2: 12 }),
        h('line', { key: 'bottom', x1: 4, y1: 18, x2: 20, y2: 18 }),
      ]);
    }
    function CommandMenuIcon() {
      return h(ToolbarIcon, null, [
        h('rect', { key: 'a', x: 4, y: 4, width: 6, height: 6, rx: 1 }), h('rect', { key: 'b', x: 14, y: 4, width: 6, height: 6, rx: 1 }),
        h('rect', { key: 'c', x: 4, y: 14, width: 6, height: 6, rx: 1 }), h('rect', { key: 'd', x: 14, y: 14, width: 6, height: 6, rx: 1 }),
      ]);
    }
    /** 星标：左栏「常用收藏」用，与顶栏同一套 16px 线性图标语言。 */
    function StarIcon() {
      return h(ToolbarIcon, null, [h('path', { key: 'star', d: 'M12 4.2l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z' })]);
    }
    function ServicesIcon() {
      return h(ToolbarIcon, null, [h('rect', { key: 'top', x: 4, y: 4, width: 16, height: 6, rx: 1 }), h('rect', { key: 'bottom', x: 4, y: 14, width: 16, height: 6, rx: 1 }), h('line', { key: 'a', x1: 7, y1: 7, x2: 7.01, y2: 7 }), h('line', { key: 'b', x1: 7, y1: 17, x2: 7.01, y2: 17 })]);
    }
    /** 插件：插头轮廓。比拼图在 16px 下更容易辨认，顶栏与左栏共用同一枚。 */
    function PluginIcon() {
      return h(ToolbarIcon, null, [
        h('line', { key: 'pin-l', x1: 9, y1: 3, x2: 9, y2: 6.4 }),
        h('line', { key: 'pin-r', x1: 15, y1: 3, x2: 15, y2: 6.4 }),
        h('path', { key: 'body', d: 'M6.4 6.4h11.2v2.8a5.6 5.6 0 0 1-11.2 0V6.4z' }),
        h('line', { key: 'cord', x1: 12, y1: 14.8, x2: 12, y2: 21 }),
      ]);
    }
    function LanIcon() {
      return h(ToolbarIcon, null, [h('circle', { key: 'top', cx: 12, cy: 5, r: 2 }), h('circle', { key: 'left', cx: 5, cy: 18, r: 2 }), h('circle', { key: 'right', cx: 19, cy: 18, r: 2 }), h('line', { key: 'l', x1: 10.6, y1: 6.5, x2: 6.4, y2: 16.4 }), h('line', { key: 'r', x1: 13.4, y1: 6.5, x2: 17.6, y2: 16.4 })]);
    }
    function RemoteListIcon() {
      return h(ToolbarIcon, null, [h('rect', { key: 'frame', x: 3, y: 4, width: 18, height: 16, rx: 2 }), h('line', { key: 'one', x1: 8, y1: 9, x2: 17, y2: 9 }), h('line', { key: 'two', x1: 8, y1: 14, x2: 17, y2: 14 }), h('line', { key: 'dot-one', x1: 6, y1: 9, x2: 6.01, y2: 9 }), h('line', { key: 'dot-two', x1: 6, y1: 14, x2: 6.01, y2: 14 })]);
    }
    function RemoteMonitorIcon() {
      return h('svg', { width: 10, height: 10, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, [
        h('rect', { key: 'r', x: 3, y: 4, width: 18, height: 12, rx: 2 }),
        h('line', { key: 'l1', x1: 8, y1: 20, x2: 16, y2: 20 }),
        h('line', { key: 'l2', x1: 12, y1: 16, x2: 12, y2: 20 }),
      ]);
    }
    function AddRemoteIcon() {
      return h(ToolbarIcon, null, [h('rect', { key: 'screen', x: 3, y: 5, width: 12, height: 10, rx: 1.5 }), h('line', { key: 'stand', x1: 9, y1: 15, x2: 9, y2: 19 }), h('line', { key: 'base', x1: 6, y1: 19, x2: 12, y2: 19 }), h('line', { key: 'plus-v', x1: 19, y1: 7, x2: 19, y2: 15 }), h('line', { key: 'plus-h', x1: 16, y1: 11, x2: 22, y2: 11 })]);
    }
    function RefreshIcon() {
      return h(ToolbarIcon, null, [h('path', { key: 'arc', d: 'M19 8a7 7 0 1 0 1 5' }), h('polyline', { key: 'arrow', points: '19 4 19 8 15 8' })]);
    }
    function ExtensionIcon() {
      return h(ToolbarIcon, null, [
        h('rect', { key: 'a', x: 3, y: 3, width: 8, height: 8, rx: 1.5 }),
        h('rect', { key: 'b', x: 13, y: 3, width: 8, height: 8, rx: 1.5 }),
        h('rect', { key: 'c', x: 3, y: 13, width: 8, height: 8, rx: 1.5 }),
        h('path', { key: 'd', d: 'M17 13v8M13 17h8' }),
      ]);
    }

