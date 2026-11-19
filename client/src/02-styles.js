    function ensureStyles(sidebarLeadingInset = 0) {
      if (typeof document === 'undefined') return;
      let style = document.getElementById(STYLE_ID);
      if (!style) {
        style = document.createElement('style');
        style.id = STYLE_ID;
        document.head.appendChild(style);
      }
      // 每次加载或 HMR 热更新时同步刷新样式：顶部常驻栏 + 舞台保活容器占满中心列剩余高度
      style.textContent = `
        #${TOP_HOST_ID} { flex-shrink:0; width:100%; padding-left:${sidebarLeadingInset}px; box-sizing:border-box; z-index:12; -webkit-app-region:no-drag; }
        /* 新版 DSH 原生抽屉模式下，为左上角悬浮的宿主侧栏开关留出安全间距，避免遮挡首颗设备标签 */
        [data-sidebar-drawer] #${TOP_HOST_ID} { padding-left:var(--dsh-frame-leading-clearance, 48px); }
        #${STAGE_HOST_ID} { display:contents; }
        .dsh-au-stage { position:fixed; z-index:1; background:#0f1117; overflow:hidden; pointer-events:auto; }
        #${TOP_HOST_ID} + [data-slot="main"] > * { flex:1 1 0% !important; min-height:0 !important; }
        .dsh-au-placeholder { display:none !important; }
        .dsh-au-topbar { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:6px 12px; min-height:42px; border-bottom:1px solid var(--dsw-alias-border-l2,#1f2430); background:var(--dsw-alias-bg-layer-2,#12151e); color:var(--dsw-alias-label-primary,#e5e7eb); font-size:13px; flex-shrink:0; -webkit-app-region:no-drag; }
        .dsh-au-tabs { display:flex; align-items:center; gap:8px; overflow-x:auto; flex:1; min-width:0; padding:2px 0; scrollbar-width:none; -webkit-app-region:no-drag; }
        .dsh-au-tabs::-webkit-scrollbar { display:none; }
        .dsh-au-status-capsule { display:inline-flex; align-items:center; gap:5px; max-width:calc(100vw - 16px); min-height:26px; padding:4px 8px; border:1px solid var(--dsw-alias-border-l2,#2e3646); border-radius:999px; background:var(--dsw-alias-bg-layer-1,#181c27); color:var(--dsw-alias-label-secondary,#9ca3af); cursor:pointer; font:inherit; line-height:18px; -webkit-app-region:no-drag; }
        .dsh-au-status-capsule:hover { border-color:#3b82f688; }
        .dsh-au-status-capsule:focus-visible, .dsh-au-icon-btn:focus-visible { outline:2px solid #3b82f6; outline-offset:2px; }
        .dsh-au-status-points { display:flex; align-items:center; gap:5px; max-width:calc(100vw - 40px); overflow:hidden; }
        .dsh-au-status-point { display:inline-flex; align-items:center; justify-content:center; width:12px; height:14px; flex:0 0 auto; }
        .dsh-au-status-point .dsh-au-dot { width:7px; height:7px; }
        .dsh-au-floating-capsule { position:fixed; z-index:4; box-shadow:0 5px 12px rgba(0,0,0,.28); cursor:grab; touch-action:none; user-select:none; }
        .dsh-au-floating-capsule[data-dragging] { cursor:grabbing; }
        .dsh-au-floating-capsule[data-dragging] .dsh-au-status-capsule { cursor:grabbing; }
        .dsh-au-floating-capsule .dsh-au-status-capsule { box-shadow:0 1px 0 rgba(255,255,255,.04) inset; }
        .dsh-au-tab { display:inline-flex; align-items:center; gap:7px; min-height:32px; padding:4px 12px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2,#252b3b); background:var(--dsw-alias-bg-layer-1,#181c27); color:var(--dsw-alias-label-secondary,#9ca3af); cursor:pointer; white-space:nowrap; user-select:none; transition:color .15s, border-color .15s, background .15s, box-shadow .15s; -webkit-app-region:no-drag; }
        /* 复用宿主主题：浅色用浅底深字，选中仍保留蓝色身份，不改变设备标签布局。 */
        .dsh-au-tab:hover { color:var(--dsw-alias-label-primary,#fff); border-color:var(--dsw-alias-state-business-primary,#3b82f6); background:var(--dsw-alias-interactive-bg-hover-solid,#1c2230); }
        .dsh-au-tab.active { background:var(--dsw-alias-state-business-tertiary,#172947); color:var(--dsw-alias-label-primary,#f8fafc); border-color:var(--dsw-alias-state-business-primary,#3b82f6); box-shadow:inset 0 1px 0 rgba(147,197,253,.22); }
        .dsh-au-tab-name { font-weight:600; letter-spacing:.01em; }
        .dsh-au-dot { width:8px; height:8px; border-radius:50%; display:inline-block; flex-shrink:0; }
        /* 状态色与主题前景混合：白底上的绿/黄小点仍清晰，深色保持原有状态语义。 */
        .dsh-au-dot.idle { background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#10b981) 70%,var(--dsw-alias-label-primary,#e5e7eb)); box-shadow:0 0 6px #10b98188; }
        .dsh-au-dot.busy { background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 70%,var(--dsw-alias-label-primary,#e5e7eb)); box-shadow:0 0 8px #f59e0baa; }
        .dsh-au-dot.done { background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 70%,var(--dsw-alias-label-primary,#e5e7eb)); box-shadow:0 0 8px #3b82f6aa; }
        .dsh-au-dot.waiting { background:color-mix(in srgb,#a855f7 70%,var(--dsw-alias-label-primary,#e5e7eb)); box-shadow:0 0 8px #a855f7aa; }
        .dsh-au-dot.error { background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 70%,var(--dsw-alias-label-primary,#e5e7eb)); box-shadow:0 0 8px #ef4444aa; }
        .dsh-au-dot.preloading { background:#06b6d4; box-shadow:0 0 8px #06b6d4cc; animation:dsh-au-dot-pulse 1.2s ease-in-out infinite; }
        .dsh-au-dot.needs_auth, .dsh-au-dot.unknown, .dsh-au-dot.offline { background:var(--dsw-alias-label-secondary,#6b7280); }
        .dsh-au-badge { font-size:10px; line-height:16px; padding:0 5px; border-radius:4px; background:var(--dsw-alias-interactive-bg-hover-solid,#262c3a); color:var(--dsw-alias-label-secondary,#94a3b8); }
        .dsh-au-tab.active .dsh-au-badge { background:var(--dsw-alias-state-business-tertiary,#243a5d); color:var(--dsw-alias-label-secondary,#bfd8ff); }
        .dsh-au-actions { display:flex; align-items:center; gap:8px; flex-shrink:0; -webkit-app-region:no-drag; }
        .dsh-au-action-group { display:flex; align-items:center; gap:4px; }
        .dsh-au-mobile-controls { display:flex; align-items:center; order:3; flex-shrink:0; -webkit-app-region:no-drag; }
        /* 双 class 才能压过后面的 .dsh-au-icon-btn { display:inline-flex }，否则桌面也会露出汉堡菜单。 */
        .dsh-au-icon-btn.dsh-au-mobile-menu { display:none; }
        .dsh-au-mobile-collapse { min-width:30px; width:30px; padding:0; }
        /* 以顶栏为悬浮菜单锚点；展开时不改变顶栏高度或远程舞台几何。 */
        .dsh-au-topbar.compact-mobile { position:relative; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:5px 8px; padding:5px 8px; min-height:38px; }
        .dsh-au-topbar.compact-mobile .dsh-au-mobile-controls { display:flex; order:0; gap:5px; }
        .dsh-au-topbar.compact-mobile .dsh-au-icon-btn.dsh-au-mobile-menu { display:inline-flex; }
        .dsh-au-topbar.compact-mobile .dsh-au-mobile-controls .dsh-au-icon-btn { min-width:44px; width:44px; height:44px; padding:0; }
        .dsh-au-topbar.compact-mobile .dsh-au-mobile-menu[aria-expanded="true"] { border-color:var(--dsw-alias-state-business-primary,#3b82f6); color:var(--dsw-alias-label-primary,#f8fafc); background:var(--dsw-alias-state-business-tertiary,#172947); }
        .dsh-au-topbar.compact-mobile .dsh-au-actions { display:none; }
        .dsh-au-topbar.compact-mobile.mobile-tools-open .dsh-au-actions { display:flex; position:absolute; top:calc(100% + 6px); right:8px; z-index:20; width:max-content; max-width:calc(100% - 16px); box-sizing:border-box; flex-direction:column; align-items:stretch; gap:8px; min-height:0; max-height:min(60dvh,420px); overflow-y:auto; overscroll-behavior:contain; padding:6px; border:1px solid var(--dsw-alias-border-l2,#2e3646); border-radius:8px; background:var(--dsw-alias-bg-layer-2,#12151e); box-shadow:0 8px 24px rgba(3,7,18,.35); scrollbar-width:thin; scrollbar-color:#4b5563 transparent; }
        .dsh-au-topbar.compact-mobile .dsh-au-action-group { flex-direction:column; align-items:stretch; gap:5px; }
        /* 每行填满内容宽度的菜单面板，保留完整标签及至少 44px 的触摸高度。 */
        .dsh-au-topbar.compact-mobile .dsh-au-actions .dsh-au-icon-btn { box-sizing:border-box; width:100%; min-width:0; flex-shrink:0; justify-content:flex-start; min-height:44px; height:auto; padding:12px; gap:10px; }
        .dsh-au-topbar.compact-mobile .dsh-au-tool-label { display:inline; font-size:14px; line-height:1.3; }
        .dsh-au-topbar.compact-mobile .dsh-au-action-divider { width:100%; height:1px; flex-shrink:0; }
        .dsh-au-topbar.compact-mobile .dsh-au-tabs { gap:5px; }
        .dsh-au-topbar.compact-mobile .dsh-au-tab { min-height:30px; padding:3px 8px; }
        .dsh-au-topbar.compact-mobile .dsh-au-badge { display:none; }
        .dsh-au-action-divider { width:1px; height:20px; background:var(--dsw-alias-border-l2,#2e3646); }
        /* 按钮使用宿主主题变量，避免浅色模式沿用深色底和浅色字。 */
        .dsh-au-btn { padding:4px 10px; border-radius:6px; border:1px solid var(--dsw-alias-border-l2,#d1d5db); background:var(--dsw-alias-bg-layer-1,#fff); color:var(--dsw-alias-label-primary,#1f2937); cursor:pointer; font-size:12px; white-space:nowrap; -webkit-app-region:no-drag; }
        .dsh-au-icon-btn { position:relative; display:inline-flex; align-items:center; justify-content:center; gap:5px; min-width:54px; height:30px; padding:0 8px; border:1px solid var(--dsw-alias-border-l2,#2e3646); border-radius:7px; background:var(--dsw-alias-bg-layer-1,#1a1f2c); color:var(--dsw-alias-label-secondary,#aeb9ca); cursor:pointer; white-space:nowrap; transition:color .15s, border-color .15s, background .15s, transform .15s; -webkit-app-region:no-drag; }
        .dsh-au-icon-btn:hover { border-color:var(--dsw-alias-state-business-primary,#4b5563); background:var(--dsw-alias-interactive-bg-hover-solid,#212838); color:var(--dsw-alias-label-primary,#f8fafc); }
        .dsh-au-icon-btn:active { transform:translateY(1px); }
        .dsh-au-icon-btn:disabled { cursor:wait; opacity:.62; }
        .dsh-au-icon-btn:focus-visible { outline:2px solid #3b82f6; outline-offset:2px; }
        .dsh-au-icon-btn svg { width:16px; height:16px; flex:0 0 auto; }
        .dsh-au-tool-label { font-size:11px; line-height:1; font-weight:600; letter-spacing:.02em; }
        .dsh-au-icon-btn.primary { background:#2563eb; border-color:#3b82f6; color:#fff; }
        .dsh-au-icon-btn.primary:hover { background:#1d4ed8; border-color:#3b82f6; }
        .dsh-au-action-status[data-lan-state="on"] { border-color:var(--dsw-alias-state-success-primary,#10b98166); color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#34d399) 50%,var(--dsw-alias-label-primary,#e5e7eb)); }
        .dsh-au-action-status[data-lan-state="off"] { border-color:var(--dsw-alias-border-l2,#64748b); color:var(--dsw-alias-label-secondary,#94a3b8); }
        .dsh-au-action-status::after { content:''; position:absolute; right:4px; bottom:4px; width:5px; height:5px; border:1.5px solid var(--dsw-alias-bg-layer-1,#1a1f2c); border-radius:50%; background:var(--dsw-alias-label-secondary,#64748b); }
        .dsh-au-action-status[data-lan-state="on"]::after { background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#10b981) 70%,var(--dsw-alias-label-primary,#e5e7eb)); }
        .dsh-au-toolbar-spin { animation:dsh-au-spin .8s linear infinite; }
        @media (prefers-reduced-motion: reduce) { .dsh-au-icon-btn { transition:none; } .dsh-au-toolbar-spin { animation:none; } }
        .dsh-au-btn:hover { border-color:var(--dsw-alias-state-business-primary,#2563eb); background:var(--dsw-alias-interactive-bg-hover-solid,#f3f4f6); }
        .dsh-au-btn:active { transform:scale(.98); }
        .dsh-au-btn:disabled { cursor:wait; opacity:.55; transform:none; }
        .dsh-au-btn.primary { background:#2563eb; border-color:#3b82f6; color:#fff; }
        .dsh-au-btn.on { border-color:#10b98188; color:#34d399; }
        .dsh-au-btn.off { border-color:#ef444488; color:#f87171; }
        .dsh-au-iframe { position:absolute; inset:0; width:100%; height:100%; border:none; background:#0f1117; color-scheme:dark; }
        .dsh-au-center { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; padding:24px; z-index:2; }
        .dsh-au-loading { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; background:rgba(15,17,23,0.78); color:#9ca3af; font-size:13px; pointer-events:none; z-index:1; }
        .dsh-au-stage-transition-mask { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; background:rgba(15,17,23,0.52); backdrop-filter:blur(4px); -webkit-backdrop-filter:blur(4px); color:#e2e8f0; font-size:13px; pointer-events:auto; z-index:5; transition:opacity .15s ease; }
        .dsh-au-stage-transition-pill { display:inline-flex; align-items:center; gap:10px; padding:10px 18px; border-radius:999px; background:rgba(22,25,34,0.92); border:1px solid rgba(59,130,246,0.32); box-shadow:0 10px 28px rgba(0,0,0,0.45); color:#f1f5f9; font-size:13px; font-weight:500; }
        .dsh-au-spinner { width:22px; height:22px; border:2px solid #334155; border-top-color:#3b82f6; border-radius:50%; animation:dsh-au-spin .8s linear infinite; }
        @keyframes dsh-au-spin { to { transform:rotate(360deg); } }
        .dsh-au-card { box-sizing:border-box; width:400px; max-width:100%; background:#161922; border:1px solid #2e3646; border-radius:10px; padding:20px; display:flex; flex-direction:column; gap:12px; color:#e5e7eb; font-size:13px; line-height:1.45; }
        .dsh-au-card *, .dsh-au-card *::before, .dsh-au-card *::after { box-sizing:border-box; }
        .dsh-au-input { width:100%; padding:8px 10px; border-radius:6px; border:1px solid #2e3646; background:#0f1117; color:#fff; font-size:13px; box-sizing:border-box; }
        .dsh-au-mask { position:fixed; inset:0; background:rgba(0,0,0,0.6); display:flex; align-items:center; justify-content:center; z-index:9999; }
        .dsh-au-remote-manager { width:min(930px,96vw); height:min(840px,calc(92dvh - 24px)); max-height:calc(92dvh - 24px); padding:0; gap:0; overflow:hidden; font-size:13px; line-height:1.45; border-radius:12px; box-shadow:0 20px 48px rgba(3,7,18,.68); }
        .dsh-au-remote-manager-head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:14px 16px; border-bottom:1px solid #262f40; background:#181d29; flex:0 0 auto; }
        .dsh-au-remote-manager-title { display:flex; flex-direction:column; gap:2px; min-width:0; }
        .dsh-au-remote-manager-title strong { font-size:14px; font-weight:600; color:#f8fafc; line-height:1.35; }
        .dsh-au-remote-manager-title span { color:#94a3b8; font-size:11.5px; line-height:1.35; }
        .dsh-au-remote-manager-actions { display:flex; align-items:center; gap:8px; flex-shrink:0; }
        .dsh-au-remote-list { display:flex; flex:1 1 auto; flex-direction:column; min-height:0; gap:12px; overflow-y:auto; overscroll-behavior:contain; padding:14px 16px; }
        .dsh-au-remote-device { flex:0 0 auto; border:1px solid #283142; border-radius:8px; background:#131722; overflow:hidden; }
        .dsh-au-lan-control { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:11px 14px; background:#161b27; }
        .dsh-au-lan-control-main { display:flex; flex-direction:column; gap:3px; min-width:0; }
        .dsh-au-lan-control-actions { display:inline-flex; align-items:center; gap:8px; flex-shrink:0; }
        .dsh-au-remote-device-head { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 14px; background:#181e2c; border-bottom:1px solid #222a3a; }
        .dsh-au-remote-device-routes { display:flex; flex-direction:column; gap:4px; padding:6px; }
        .dsh-au-remote-row { box-sizing:border-box; width:100%; display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:12px; padding:8px; border:1px solid transparent; border-radius:6px; background:transparent; color:#e5e7eb; text-align:left; transition:background .15s ease, border-color .15s ease; }
        .dsh-au-remote-row:hover { background:rgba(255,255,255,.025); border-color:#232b3b; }
        .dsh-au-remote-row[data-status-diff="false"] { grid-template-columns:minmax(0,1fr) auto; }
        .dsh-au-remote-row-main { min-width:0; display:flex; flex-direction:column; gap:3px; }
        button.dsh-au-remote-row-main { padding:0; border:0; background:transparent; color:inherit; font:inherit; text-align:left; cursor:pointer; }
        button.dsh-au-remote-row-edit:hover .dsh-au-remote-row-name { color:#f8fafc; }
        button.dsh-au-remote-row-edit:focus-visible { outline:2px solid #3b82f6; outline-offset:3px; border-radius:4px; }
        .dsh-au-remote-row-actions { display:inline-flex; align-items:center; justify-content:flex-end; gap:8px; flex-shrink:0; }
        .dsh-au-copy-link { min-width:58px; padding:6px 12px; }
        .dsh-au-remote-row-name { display:inline-flex; align-items:center; gap:7px; font-size:13px; line-height:18px; font-weight:600; color:#f1f5f9; white-space:nowrap; }
        .dsh-au-remote-row-name svg { width:15px; height:15px; flex:0 0 15px; color:#94a3b8; }
        .dsh-au-remote-row-url { overflow:hidden; color:#94a3b8; font-size:12px; line-height:16px; font-family:Consolas,ui-monospace,monospace; text-overflow:ellipsis; white-space:nowrap; }
        .dsh-au-remote-row-state { color:#94a3b8; font-size:11.5px; line-height:16px; white-space:nowrap; }
        .dsh-au-lan-control-main .dsh-au-remote-row-state { white-space:normal; }
        .dsh-au-remote-empty { padding:36px 16px; color:#94a3b8; text-align:center; font-size:12px; }
        .dsh-au-wb-modal { width:min(1056px,78vw); height:min(684px,88dvh); background:#11151e; border:1px solid #2c354d; border-radius:12px; box-shadow:0 20px 56px rgba(3,7,18,.75); display:flex; flex-direction:column; overflow:hidden; color:#f1f5f9; font-size:13.3px; }
        .dsh-au-wb-head { padding:10px 14px; border-bottom:1px solid #1f2637; background:#161b26; display:flex; align-items:center; justify-content:space-between; gap:10px; flex-shrink:0; }
        .dsh-au-wb-search { flex:1; min-width:0; max-width:420px; padding:7px 11px; border-radius:6px; border:1px solid #2c354d; background:#0b0d12; color:#f1f5f9; font-size:13px; outline:none; }
        .dsh-au-wb-search:focus { border-color:#3b82f6; box-shadow:0 0 0 2px rgba(59,130,246,.22); }
        .dsh-au-wb-body { flex:1; display:grid; grid-template-columns:190px 1fr 330px; min-height:0; }
        .dsh-au-wb-nav { border-right:1px solid #1f2637; background:#161b26; padding:9px; display:flex; flex-direction:column; gap:4px; overflow-y:auto; }
        .dsh-au-wb-navbtn { display:flex; align-items:center; justify-content:space-between; gap:6px; padding:7px 9px; border-radius:6px; border:1px solid transparent; background:transparent; color:#94a3b8; cursor:pointer; font-size:12.8px; text-align:left; }
        .dsh-au-wb-navbtn:hover { background:#1c2230; color:#f1f5f9; }
        .dsh-au-wb-navbtn.active { background:rgba(59,130,246,.18); border-color:#3b82f6; color:#f8fafc; font-weight:600; }
        /* 左栏图标与顶栏同一尺寸（16px 槽位），标题过长时只压缩文字，不挤掉图标或计数 */
        .dsh-au-nav-main { display:flex; align-items:center; gap:7px; min-width:0; flex:1 1 auto; }
        .dsh-au-nav-icon { display:inline-flex; align-items:center; justify-content:center; flex:0 0 16px; width:16px; height:16px; }
        .dsh-au-nav-label { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .dsh-au-nav-count { flex:0 0 auto; color:#7c8aa0; font-variant-numeric:tabular-nums; }
        .dsh-au-wb-navbtn:hover .dsh-au-nav-count { color:#cbd5e1; }
        .dsh-au-wb-navbtn.active .dsh-au-nav-count { color:#dbeafe; }
        .dsh-au-nav-dot { display:block; width:5px; height:5px; border-radius:50%; background:currentColor; opacity:.5; }
        .dsh-au-wb-center { padding:12px 14px; min-height:0; overflow-y:auto; display:flex; flex-direction:column; gap:10px; background:#11151e; }
        .dsh-au-wb-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:9px; }
        .dsh-au-wb-card { padding:10px 11px; border-radius:8px; border:1px solid #1f2637; background:#161b26; cursor:pointer; display:flex; flex-direction:column; justify-content:flex-start; gap:5px; text-align:left; transition:border-color .15s,background .15s,box-shadow .15s; }
        .dsh-au-card-head { display:flex; align-items:center; justify-content:space-between; gap:8px; min-width:0; }
        /* 标题行独占左侧：插件名超长时省略，自研标识不被挤掉 */
        .dsh-au-card-title-row { display:flex; align-items:center; gap:5px; flex:1 1 auto; min-width:0; }
        .dsh-au-card-title-row .dsh-au-card-title { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .dsh-au-chip-own { flex:0 0 auto; font-weight:700; letter-spacing:.2px; }
        .dsh-au-card-id { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:Consolas,monospace; font-size:10.8px; font-weight:600; color:#6f7f96; }
        .dsh-au-card-title { font-size:13.5px; font-weight:600; color:#f1f5f9; line-height:1.35; }
        .dsh-au-card-ver { font-family:Consolas,monospace; font-size:10.8px; color:#7c8aa0; }
        .dsh-au-card-desc { font-size:11.2px; color:#8b98ad; line-height:1.5; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
        .dsh-au-card-foot { display:flex; align-items:center; justify-content:flex-end; gap:6px; padding-top:6px; border-top:1px solid #1c2230; }
        .dsh-au-card-foot[data-align="split"] { justify-content:space-between; border-top:0; padding-top:2px; }
        .dsh-au-card-status { display:flex; align-items:center; gap:7px; min-width:0; }
        .dsh-au-card-btn { padding:4px 8px; border-radius:5px; border:1px solid #2c354d; background:#0b0d12; color:#94a3b8; font:inherit; font-size:10.8px; cursor:pointer; white-space:nowrap; }
        .dsh-au-card-btn:hover { color:#e2e8f0; border-color:#3b4a63; }
        .dsh-au-card-btn[data-tone="on"] { border-color:rgba(16,185,129,.45); color:#34d399; }
        .dsh-au-card-btn[data-tone="off"] { border-color:rgba(248,113,113,.4); color:#f87171; }
        .dsh-au-card-btn[data-tone="danger"] { border-color:rgba(248,113,113,.45); color:#f87171; }
        .dsh-au-card-btn:disabled { opacity:.38; cursor:not-allowed; }
        .dsh-au-link:disabled { opacity:.5; cursor:not-allowed; }
        .dsh-au-wb-card:hover { border-color:#334155; background:#1c2230; }
        .dsh-au-wb-card.selected { border-color:#3b82f6; background:rgba(59,130,246,.16); box-shadow:inset 0 1px 0 rgba(147,197,253,.22), 0 0 0 1px rgba(59,130,246,.32); }
        .dsh-au-wb-inspector { border-left:1px solid #1f2637; background:#161b26; padding:11px 13px; display:flex; flex-direction:column; gap:9px; min-height:0; overflow-y:auto; }
        .dsh-au-wb-term { flex:1; min-height:150px; border-radius:8px; border:1px solid #2c354d; background:#0b0d12; padding:9px 10px; font-family:Consolas,monospace; font-size:11.5px; line-height:1.65; color:#94a3b8; overflow-y:auto; display:flex; flex-direction:column; gap:6px; }
        .dsh-au-wb-pill { display:inline-flex; align-items:center; gap:5px; padding:4px 8px; border-radius:5px; border:1px solid #2c354d; background:#0b0d12; color:#94a3b8; font-size:11px; cursor:pointer; }
        .dsh-au-wb-pill:active { transform:scale(.98); }
        .dsh-au-wb-pill:disabled { cursor:not-allowed; opacity:.55; transform:none; }
        .dsh-au-wb-pill.on { border-color:#10b981; background:rgba(16,185,129,.14); color:#10b981; font-weight:600; }
        .dsh-au-wb-pill.sel { border-color:#3b82f6; background:rgba(59,130,246,.18); color:#93c5fd; font-weight:600; }

        .dsh-au-wb-foot { padding:8px 14px; border-top:1px solid #1f2637; background:#161b26; display:flex; align-items:center; justify-content:space-between; gap:10px; font-size:11px; color:#64748b; flex-shrink:0; }

        /* 右侧详情：克制样式，去掉多层框，用分隔线与 chips 承担层级 */
        .dsh-au-insp-head { display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
        .dsh-au-insp-name { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:15.5px; font-weight:650; color:#f1f5f9; }
        .dsh-au-insp-id { flex:0 1 auto; max-width:58%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:Consolas,monospace; font-size:11px; color:#7c8aa0; }
        .dsh-au-insp-desc { font-size:11.4px; line-height:1.55; color:#8b98ad; }
        /* 右栏窄，提示框跟着降一档字号，避免两三句话撑成四行抢走正文层级 */
        .dsh-au-wb-inspector .dsh-au-quota-shell { font-size:11.8px; line-height:1.6; color:#94a3b8; gap:5px; padding:9px 10px; }
        .dsh-au-insp-files { display:flex; flex-direction:column; gap:2px; padding:8px 0; border-bottom:1px solid #1c2230; }
        .dsh-au-insp-file-label { font-size:11px; color:#8b98ad; }
        .dsh-au-insp-file { font-family:Consolas,monospace; font-size:11px; line-height:1.5; color:#b0becf; word-break:normal; overflow-wrap:anywhere; }
        .dsh-au-chips { display:flex; flex-wrap:wrap; gap:5px; }
        /* 动作与其影响范围成组：说明比按钮低一档，不抢主操作 */
        .dsh-au-act-block { display:flex; flex-direction:column; gap:4px; }
        .dsh-au-act-hint { font-size:10.8px; line-height:1.45; color:#7c8aa0; }
        .dsh-au-chip { display:inline-flex; align-items:center; gap:5px; padding:3px 7px; border-radius:4px; background:rgba(148,163,184,.09); color:#94a3b8; font-size:10.6px; white-space:nowrap; }
        .dsh-au-chip[data-tone="emerald"] { background:rgba(16,185,129,.13); color:#34d399; }
        .dsh-au-chip[data-tone="amber"] { background:rgba(245,158,11,.13); color:#fbbf24; }
        .dsh-au-chip[data-tone="blue"] { background:rgba(59,130,246,.13); color:#93c5fd; }
        .dsh-au-chip[data-tone="violet"] { background:rgba(139,92,246,.18); color:#c4b5fd; }
        .dsh-au-chip[data-tone="muted"] { background:rgba(148,163,184,.09); color:#8b98ad; }
        .dsh-au-act { display:flex; gap:6px; }
        .dsh-au-act .dsh-au-btn { flex:1; font-size:12px; padding:7px 8px; }
        .dsh-au-kv { display:flex; align-items:center; justify-content:space-between; gap:10px; width:100%; padding:7px 0; border:0; border-bottom:1px solid #1c2230; background:transparent; color:#c7d2e0; font:inherit; font-size:11.8px; text-align:left; cursor:pointer; }
        .dsh-au-kv:hover { color:#f1f5f9; }
        .dsh-au-kv-val { display:inline-flex; align-items:center; gap:5px; font-size:11.3px; font-weight:600; }
        .dsh-au-dot { width:6px; height:6px; border-radius:50%; flex:0 0 6px; }
        .dsh-au-link { align-self:flex-start; padding:2px 0; border:0; background:transparent; color:#8b98ad; font:inherit; font-size:11.3px; cursor:pointer; text-decoration:underline; text-underline-offset:3px; }
        .dsh-au-link:hover { color:#e2e8f0; }
        .dsh-au-link[data-tone="danger"] { color:#f87171; }
        .dsh-au-note { font-size:11.2px; line-height:1.6; color:#8b98ad; white-space:pre-wrap; word-break:break-word; }
        .dsh-au-note[data-tone="busy"] { color:#93c5fd; display:flex; align-items:center; gap:6px; }
        .dsh-au-note[data-tone="ok"] { color:#34d399; }
        .dsh-au-note[data-tone="err"] { color:#fbbf24; }
        .dsh-au-svc-spinner { width:12px; height:12px; border:2px solid #60a5fa; border-top-color:transparent; border-radius:50%; animation:dsh-au-spin .7s linear infinite; flex:0 0 auto; }
        @media (prefers-reduced-motion: reduce) { .dsh-au-btn:active, .dsh-au-wb-pill:active { transform:none; } .dsh-au-svc-spinner { animation:none; border-top-color:#60a5fa; } }
        /* 平板：左侧导航保留，详情面板下沉到内容下方 */
        @media (max-width:1024px) {
          .dsh-au-wb-modal { width:min(94vw,760px); height:min(86dvh,720px); }
          .dsh-au-wb-body { grid-template-columns:150px minmax(0,1fr); grid-template-rows:minmax(0,1fr) auto; }
          .dsh-au-wb-nav { grid-row:1 / span 2; }
          .dsh-au-wb-inspector { grid-column:2; max-height:40dvh; border-left:0; border-top:1px solid #1f2637; }
          .dsh-au-wb-grid { grid-template-columns:1fr; }
        }
        /* 手机：整屏抽屉，导航改为横向滚动条，页面统一纵向滚动 */
        @media (max-width:720px) {
          .dsh-au-wb-modal { width:100vw; height:100dvh; max-height:none; border-radius:0; border:0; font-size:14.5px; padding-bottom:env(safe-area-inset-bottom); }
          .dsh-au-wb-head { flex-wrap:wrap; gap:8px; padding:8px 10px; }
          .dsh-au-wb-search { max-width:none; width:100%; flex:1 1 100%; }
          .dsh-au-wb-body { display:flex; flex-direction:column; overflow-y:auto; }
          /* 长列表不能压扁导航；横向滚动只发生在选项条内，正文继续纵向滚动。 */
          .dsh-au-wb-nav { flex:0 0 auto; min-height:59px; min-width:0; width:100%; box-sizing:border-box; flex-direction:row; gap:6px; padding:7px 8px; overflow-x:auto; overflow-y:hidden; border-right:0; border-bottom:1px solid #1f2637; }
          .dsh-au-wb-navbtn { flex:0 0 auto; min-height:44px; white-space:nowrap; font-size:13px; }
          .dsh-au-wb-center, .dsh-au-wb-inspector { overflow:visible; padding:10px 12px; }
          .dsh-au-wb-inspector { border-left:0; border-top:1px solid #1f2637; max-height:none; }
          .dsh-au-wb-term { min-height:120px; max-height:200px; }
          .dsh-au-wb-foot { display:none; }
          .dsh-au-wb-pill, .dsh-au-btn { min-height:34px; }
        }
        .dsh-au-quota-shell { display:flex; flex-direction:column; gap:8px; padding:10px 12px; border-radius:10px; border:1px solid #2c354d; background:#11151e; }
        .dsh-au-quota-card { padding:10px 12px; border-radius:8px; border:1px solid #1f2637; background:#161b26; display:flex; flex-direction:column; gap:8px; }
        .dsh-au-quota-head { display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:13px; font-weight:650; color:#f1f5f9; border-bottom:1px solid #1f2637; padding-bottom:6px; }
        .dsh-au-quota-head > span:first-child { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .dsh-au-quota-head > span:last-child { margin-left:auto; }
        .dsh-au-quota-row { display:flex; flex-direction:column; gap:3px; padding:5px 0; border-bottom:1px solid rgba(255,255,255,0.05); }
        .dsh-au-quota-row:first-child { padding-top:2px; }
        .dsh-au-quota-row:last-child { border-bottom:0; padding-bottom:1px; }
        .dsh-au-quota-row > span:first-child { font-size:11px; color:#8b98ad; font-weight:500; letter-spacing:0.2px; line-height:1.3; }
        .dsh-au-quota-row > span:last-child { font-size:12.6px; font-weight:600; line-height:1.45; text-align:left; overflow-wrap:break-word; word-break:break-word; }
        .dsh-au-result-grid { display:flex; flex-direction:column; }
        .dsh-au-result-tile { display:grid; grid-template-columns:88px minmax(0,1fr) minmax(0,auto); align-items:baseline; gap:4px 9px; min-width:0; padding:6px 0; border-bottom:1px solid #1c2230; }
        .dsh-au-result-tile:last-child { border-bottom:0; }
        .dsh-au-tile-label { font-size:10.8px; line-height:1.4; color:#8b98ad; }
        .dsh-au-tile-value { font-size:11.6px; font-weight:650; line-height:1.45; color:#f1f5f9; overflow-wrap:anywhere; text-wrap:balance; }
        .dsh-au-tile-value[data-tone="emerald"] { color:#34d399; }
        .dsh-au-tile-value[data-tone="blue"] { color:#93c5fd; }
        .dsh-au-tile-value[data-tone="amber"] { color:#fbbf24; }
        .dsh-au-tile-value[data-tone="rose"] { color:#f87171; }
        .dsh-au-tile-badge { min-width:0; justify-self:end; font-size:10px; font-weight:600; line-height:1.45; color:#8b98ad; text-align:right; overflow-wrap:anywhere; }
        .dsh-au-tone-badge { display:inline-flex; align-items:center; max-width:100%; padding:2px 7px; border-radius:999px; font-size:10.6px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .dsh-au-tone-badge[data-tone="emerald"] { background:rgba(16,185,129,.16); color:#34d399; border:1px solid rgba(16,185,129,.38); }
        .dsh-au-tone-badge[data-tone="blue"] { background:rgba(59,130,246,.18); color:#93c5fd; border:1px solid rgba(59,130,246,.42); }
        .dsh-au-tone-badge[data-tone="amber"] { background:rgba(245,158,11,.16); color:#fbbf24; border:1px solid rgba(245,158,11,.4); }
        .dsh-au-tone-badge[data-tone="rose"] { background:rgba(239,68,68,.16); color:#f87171; border:1px solid rgba(239,68,68,.4); }
        .dsh-au-log-sec { margin-top:4px; padding:4px 10px; border:1px solid rgba(16,185,129,.35); background:rgba(16,185,129,.10); color:#34d399; font-weight:700; border-radius:5px; }
        .dsh-au-log-done { margin-top:4px; padding:5px 10px; border-radius:6px; background:rgba(16,185,129,.14); border:1px solid rgba(16,185,129,.35); color:#34d399; font-weight:600; }
        .dsh-au-log-err { margin-top:4px; padding:5px 10px; border-radius:6px; background:rgba(245,158,11,.14); border:1px solid rgba(245,158,11,.4); color:#fbbf24; font-weight:600; }
        /* 设置分区沿用 DSH 设置页排版：大类可折叠，组内标题 + 说明 + 右侧开关，配色走 DSW 主题变量。 */
        .dsh-au-settings-page { display:flex; flex-direction:column; gap:2px; width:min(100%, 880px); padding:2px 0 28px; color:var(--dsw-alias-label-primary,#e5e7eb); }
        .dsh-au-settings-category + .dsh-au-settings-category { border-top:1px solid var(--dsw-alias-border-l1,#262f40); }
        .dsh-au-settings-category-toggle { display:grid; grid-template-columns:minmax(0,1fr) auto auto; align-items:center; gap:10px 12px; width:100%; margin:0; padding:13px 2px; border:0; background:transparent; color:inherit; font:inherit; text-align:left; cursor:pointer; -webkit-app-region:no-drag; }
        .dsh-au-settings-category-toggle:hover .dsh-au-settings-category-title { color:color-mix(in srgb, var(--dsw-alias-state-business-primary,#7aaaff) 82%, #fff); }
        .dsh-au-settings-category-toggle:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary,#7aaaff); outline-offset:2px; border-radius:6px; }
        /* 大类标题用宿主强调蓝，和正文白字、右侧灰摘要分开。 */
        .dsh-au-settings-category-title { font-size:16px; font-weight:600; line-height:1.3; color:var(--dsw-alias-state-business-primary,#7aaaff); }
        .dsh-au-settings-category-hint { color:var(--dsw-alias-label-tertiary,#8b98ad); font-size:12px; line-height:1.4; white-space:nowrap; }
        .dsh-au-settings-category-toggle svg { width:16px; height:16px; color:var(--dsw-alias-label-secondary,#9ca3af); }
        .dsh-au-settings-category-body { display:flex; flex-direction:column; gap:14px; padding:0 2px 16px; }
        .dsh-au-settings-category-body[hidden] { display:none; }
        /* 大类标题承担分组；组内 h3 只留给读屏，避免和开关标题叠两层。 */
        .dsh-au-settings-category .dsh-au-settings-group > h3 { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); border:0; }
        .dsh-au-settings-group { display:flex; flex-direction:column; gap:10px; }
        .dsh-au-settings-group + .dsh-au-settings-group { padding-top:14px; border-top:1px solid var(--dsw-alias-border-l1,#262f40); }
        .dsh-au-settings-group h3 { margin:0; font-size:14px; font-weight:600; line-height:1.4; }
        .dsh-au-settings-row { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
        .dsh-au-settings-desc { margin:0; min-width:0; color:var(--dsw-alias-label-secondary,#9ca3af); font-size:13px; line-height:1.7; }
        .dsh-au-settings-title { display:block; margin:0 0 3px; color:var(--dsw-alias-label-primary,#e5e7eb); font-weight:600; }
        .dsh-au-settings-row > .dsh-au-switch,
        .dsh-au-settings-row > .dsh-au-cloud-sync-controls { margin-top:1px; }
        .dsh-au-settings-hint { margin:0; color:var(--dsw-alias-label-tertiary,#8b98ad); font-size:12px; line-height:1.6; font-variant-numeric:tabular-nums; }
        /* 条目固定四层：标题与开关一行，说明、注释、按钮各下一行。长按钮不再挤标题。 */
        .dsh-au-settings-item { display:flex; flex-direction:column; gap:4px; min-width:0; }
        .dsh-au-settings-item-head { display:flex; align-items:center; justify-content:space-between; gap:16px; min-width:0; }
        .dsh-au-settings-item-head .dsh-au-settings-title { min-width:0; margin:0; line-height:22px; }
        .dsh-au-settings-item-head > .dsh-au-switch { flex:0 0 auto; }
        .dsh-au-settings-item .dsh-au-settings-desc { margin:0; line-height:1.6; }
        /* 状态行用浅底和说明正文分开，避免两段灰字连成一段。 */
        .dsh-au-settings-item .dsh-au-settings-hint { margin:6px 0 0; padding:6px 10px; border-radius:6px; background:color-mix(in srgb, var(--dsw-alias-label-primary,#f9fafb) 6%, transparent); }
        .dsh-au-settings-item-extra { min-width:0; }
        .dsh-au-settings-item-actions { display:flex; flex-wrap:wrap; align-items:center; justify-content:flex-end; gap:8px; margin-top:4px; }
        .dsh-au-settings-item-actions .dsh-au-btn { min-height:32px; padding:6px 12px; font-size:13px; font-weight:500; background:var(--dsw-alias-bg-layer-2,#2c2c2e); color:var(--dsw-alias-label-primary,#f9fafb); border-color:var(--dsw-alias-border-l2,#ffffff1f); }
        .dsh-au-settings-item-actions .dsh-au-btn:hover { border-color:var(--dsw-alias-state-business-primary,#7aaaff); background:var(--dsw-alias-interactive-bg-hover-solid,#353638); color:var(--dsw-alias-label-primary,#f9fafb); }
        .dsh-au-settings-item-actions .dsh-au-btn:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary,#7aaaff); outline-offset:2px; }
        .dsh-au-settings-group > .dsh-au-settings-item + .dsh-au-settings-item { margin-top:8px; }
        /* 同步区：标题/说明、操作、状态纵向排，避免长按钮把说明挤成细条。 */
        .dsh-au-settings-stack { display:flex; flex-direction:column; gap:8px; min-width:0; }
        .dsh-au-cloud-sync-action { display:flex; align-items:center; justify-content:space-between; gap:10px 16px; flex-wrap:wrap; }
        .dsh-au-cloud-sync-action .dsh-au-settings-hint { flex:1 1 220px; min-width:0; }
        .dsh-au-cloud-sync-status { display:flex; flex-direction:column; align-items:flex-start; gap:8px; }
        .dsh-au-switch { flex:0 0 auto; position:relative; width:40px; height:22px; padding:2px; border:none; border-radius:999px; background:var(--dsw-alias-border-l2,#39414f); cursor:pointer; transition:background-color .15s ease; -webkit-app-region:no-drag; }
        .dsh-au-switch[aria-checked="true"] { background:var(--dsw-alias-brand-primary,#3b82f6); }
        .dsh-au-switch:disabled { cursor:default; opacity:.5; }
        .dsh-au-switch:focus-visible { outline:2px solid var(--dsw-alias-brand-primary,#3b82f6); outline-offset:2px; }
        .dsh-au-switch-knob { display:block; width:18px; height:18px; border-radius:50%; background:var(--dsw-alias-label-primary-foreground,#fff); box-shadow:0 1px 2px rgba(0,0,0,.24); transform:translateX(0); transition:transform .15s ease; }
        .dsh-au-switch[aria-checked="true"] .dsh-au-switch-knob { transform:translateX(18px); }
        /* 自动续跑与智能恢复设置面板配套样式 */
        .dsh-au-auto-continue-config { display:flex; flex-direction:column; gap:12px; padding:14px; margin-top:4px; border:1px solid var(--dsw-alias-border-l2,#d1d5db); border-radius:10px; background:var(--dsw-alias-bg-layer-2,#f8fafc); }
        .dsh-au-auto-continue-row { display:flex; align-items:center; justify-content:space-between; gap:12px; font-size:13px; }
        .dsh-au-auto-continue-label { color:var(--dsw-alias-label-primary,#1f2937); font-weight:500; }
        .dsh-au-auto-continue-input-wrap { display:inline-flex; align-items:center; gap:6px; }
        .dsh-au-auto-continue-number-input { width:80px; height:28px; padding:2px 8px; border:1px solid var(--dsw-alias-border-l2,#d1d5db); border-radius:6px; background:var(--dsw-alias-bg-layer-1,#fff); color:var(--dsw-alias-label-primary,#1f2937); font:inherit; font-size:13px; text-align:right; }
        .dsh-au-auto-continue-text-input { flex:1; min-width:140px; height:28px; padding:2px 8px; border:1px solid var(--dsw-alias-border-l2,#d1d5db); border-radius:6px; background:var(--dsw-alias-bg-layer-1,#fff); color:var(--dsw-alias-label-primary,#1f2937); font:inherit; font-size:13px; }
        .dsh-au-auto-continue-text-input:disabled { opacity:.5; cursor:not-allowed; }
        .dsh-au-auto-continue-unit { color:var(--dsw-alias-label-tertiary,#6b7280); font-size:12px; }
        .dsh-au-auto-continue-checkbox-label { display:inline-flex; align-items:center; gap:8px; cursor:pointer; color:var(--dsw-alias-label-primary,#1f2937); font-size:13px; user-select:none; }
        .dsh-au-auto-continue-checkbox { width:16px; height:16px; accent-color:var(--dsw-alias-state-business-primary,#2563eb); cursor:pointer; }
        .dsh-au-auto-continue-btn { padding:4px 12px; border:1px solid var(--dsw-alias-state-business-primary,#2563eb); border-radius:6px; background:var(--dsw-alias-state-business-primary,#2563eb); color:#fff; font-size:12px; font-weight:500; cursor:pointer; transition:opacity .15s; }
        .dsh-au-auto-continue-btn:hover { opacity:.9; }
        .dsh-au-auto-continue-btn:disabled { opacity:.5; cursor:default; }
        .dsh-au-auto-continue-btn.secondary { background:var(--dsw-alias-bg-layer-1,#fff); color:var(--dsw-alias-label-primary,#1f2937); border:1px solid var(--dsw-alias-border-l2,#d1d5db); }
        .dsh-au-auto-continue-btn.secondary:hover { background:var(--dsw-alias-interactive-bg-hover-solid,#f3f4f6); }
        .dsh-au-auto-continue-btn.danger { background:transparent; color:#ef4444; border:1px solid rgba(239,68,68,0.35); }
        .dsh-au-auto-continue-btn.danger:hover:not(:disabled) { background:rgba(239,68,68,0.12); border-color:#ef4444; }
        .dsh-au-auto-continue-btn.danger:disabled { opacity:.4; cursor:not-allowed; }
        .dsh-au-auto-continue-trigger-btn { flex-shrink:0; display:inline-flex; align-items:center; gap:6px; padding:4px 12px; border:1px solid var(--dsw-alias-border-l2,#d1d5db); border-radius:6px; background:var(--dsw-alias-bg-layer-1,#fff); color:var(--dsw-alias-label-primary,#1f2937); font-size:12px; font-weight:500; cursor:pointer; transition:all .15s ease; user-select:none; }
        .dsh-au-auto-continue-trigger-btn:hover { background:var(--dsw-alias-interactive-bg-hover-solid,#f3f4f6); }
        .dsh-au-auto-continue-trigger-btn:disabled { opacity:.5; cursor:default; }
        .dsh-au-auto-continue-summary-bar { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 14px; margin-top:4px; border:1px solid var(--dsw-alias-border-l2,#d1d5db); border-radius:8px; background:var(--dsw-alias-bg-layer-2,#f8fafc); font-size:12.5px; }
        .dsh-au-auto-continue-summary-text { min-width:0; flex:1; color:var(--dsw-alias-label-secondary,#6b7280); line-height:1.5; }
        .dsh-au-auto-continue-modal { width:min(680px,95vw); max-height:min(820px,90dvh); }
        .dsh-au-auto-continue-modal-body { padding:16px 20px; display:flex; flex-direction:column; gap:14px; overflow-y:auto; overscroll-behavior:contain; max-height:calc(820px - 140px); }
        .dsh-au-auto-continue-saved-badge { display:inline-flex; align-items:center; gap:4px; font-size:12px; color:#34d399; }
        /* 结构化规则卡片列表与字段网格 */
        .dsh-au-ac-rules-container { display:flex; flex-direction:column; gap:12px; }
        .dsh-au-ac-rule-card { border:1px solid var(--dsw-alias-border-l2,#d1d5db); border-radius:10px; background:var(--dsw-alias-bg-layer-2,#f8fafc); padding:12px 14px; display:flex; flex-direction:column; gap:10px; transition:border-color .15s ease; }
        .dsh-au-ac-rule-card:hover { border-color:var(--dsw-alias-state-business-primary,#2563eb); }
        .dsh-au-ac-rule-header { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }
        .dsh-au-ac-rule-header-left { display:flex; align-items:center; gap:8px; flex:1; min-width:240px; }
        .dsh-au-ac-rule-name-input { flex:1; height:28px; padding:2px 8px; border:1px solid var(--dsw-alias-border-l2,#d1d5db); border-radius:6px; background:var(--dsw-alias-bg-layer-1,#fff); color:var(--dsw-alias-label-primary,#1f2937); font:inherit; font-size:13px; font-weight:600; }
        .dsh-au-ac-rule-name-input:focus { outline:none; border-color:var(--dsw-alias-state-business-primary,#2563eb); }
        .dsh-au-ac-rule-header-right { display:flex; align-items:center; gap:6px; flex-shrink:0; }
        .dsh-au-ac-rule-badge { display:inline-flex; align-items:center; padding:2px 8px; border-radius:999px; font-size:11.5px; font-weight:600; white-space:nowrap; }
        .dsh-au-ac-badge-code { background:rgba(239,68,68,0.12); color:#ef4444; border:1px solid rgba(239,68,68,0.28); }
        .dsh-au-ac-badge-code.code-4xx { background:rgba(245,158,11,0.12); color:#f59e0b; border:1px solid rgba(245,158,11,0.28); }
        .dsh-au-ac-badge-action { background:rgba(59,130,246,0.12); color:#2563eb; border:1px solid rgba(59,130,246,0.28); }
        .dsh-au-ac-rule-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
        .dsh-au-ac-rule-field { display:flex; flex-direction:column; gap:4px; font-size:12px; }
        .dsh-au-ac-rule-field.full-width { grid-column:span 2; }
        .dsh-au-ac-rule-field-label { color:var(--dsw-alias-label-secondary,#6b7280); font-weight:500; font-size:12px; }
        .dsh-au-ac-select { height:28px; padding:2px 8px; border:1px solid var(--dsw-alias-border-l2,#d1d5db); border-radius:6px; background:var(--dsw-alias-bg-layer-1,#fff); color:var(--dsw-alias-label-primary,#1f2937); font:inherit; font-size:12.5px; cursor:pointer; }
        .dsh-au-ac-select:focus { outline:none; border-color:var(--dsw-alias-state-business-primary,#2563eb); }
        .dsh-au-ac-rule-params-row { display:flex; align-items:center; gap:14px; flex-wrap:wrap; font-size:12px; color:var(--dsw-alias-label-primary,#1f2937); }
        .dsh-au-ac-rule-toolbar { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:2px; padding-top:4px; }
        .dsh-au-ac-truncate-card { border:1px dashed var(--dsw-alias-border-l2,#d1d5db); border-radius:10px; background:var(--dsw-alias-bg-layer-2,#f8fafc); padding:10px 14px; display:flex; align-items:center; justify-content:space-between; gap:12px; font-size:13px; }
        .dsh-au-shortcut-list { display:flex; flex-direction:column; border:1px solid var(--dsw-alias-border-l1,#262f40); border-radius:10px; overflow:hidden; }
        .dsh-au-shortcut-row { display:grid; grid-template-columns:minmax(0,1fr) auto auto; align-items:center; gap:12px; padding:9px 12px; font-size:13px; }
        .dsh-au-shortcut-row + .dsh-au-shortcut-row { border-top:1px solid var(--dsw-alias-border-l1,#262f40); }
        .dsh-au-shortcut-label { min-width:0; color:var(--dsw-alias-label-primary,#e5e7eb); }
        .dsh-au-kbd { min-width:96px; padding:3px 8px; border:1px solid var(--dsw-alias-border-l1,#2e3646); border-radius:6px; background:var(--dsw-alias-bg-layer-2,#1a1f2c); color:var(--dsw-alias-label-primary,#e5e7eb); font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; text-align:center; }
        .dsh-au-kbd.recording { border-color:var(--dsw-alias-brand-primary,#3b82f6); color:var(--dsw-alias-brand-primary,#3b82f6); }
        .dsh-au-kbd.empty { color:var(--dsw-alias-label-tertiary,#8b98ad); }
        .dsh-au-shortcut-actions { display:flex; gap:6px; }
        .dsh-au-shortcut-footer { display:flex; justify-content:flex-end; gap:6px; flex-wrap:wrap; }
        /* 云端配置自动同步控制区与独立弹窗 */
        .dsh-au-cloud-sync-controls { display:inline-flex; align-items:center; gap:8px; flex-shrink:0; }
        .dsh-au-cloud-sync-controls .dsh-au-btn { font-size:12px; padding:4px 10px; }
        .dsh-au-modal-mask { position:fixed; inset:0; z-index:10000; display:flex; align-items:center; justify-content:center; padding:20px; background:rgba(3,7,18,0.72); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px); animation:dsh-au-fade-in .15s ease-out both; }
        .dsh-au-modal-mask-above { z-index:10010; }
        .dsh-au-cloud-sync-modal { width:min(720px,96vw); max-height:min(780px,92dvh); display:flex; flex-direction:column; border:1px solid var(--dsw-alias-border-l1,#262f40); border-radius:14px; background:var(--dsw-alias-bg-layer-1,#151922); color:var(--dsw-alias-label-primary,#f1f5f9); box-shadow:0 24px 64px -12px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.08); overflow:hidden; }
        .dsh-au-cloud-sync-modal-header { flex-shrink:0; display:flex; align-items:flex-start; justify-content:space-between; gap:12px; padding:16px 20px 12px; border-bottom:1px solid var(--dsw-alias-border-l1,#262f40); }
        .dsh-au-cloud-sync-modal-header h3 { margin:0; font-size:16.5px; font-weight:600; line-height:1.4; color:var(--dsw-alias-label-primary,#f8fafc); }
        .dsh-au-cloud-sync-modal-header p { margin:4px 0 0; font-size:12.5px; line-height:1.5; color:var(--dsw-alias-label-secondary,#94a3b8); }
        .dsh-au-cloud-sync-modal-close { display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; padding:0; border:1px solid transparent; border-radius:6px; background:transparent; color:var(--dsw-alias-label-secondary,#94a3b8); cursor:pointer; font-size:18px; line-height:1; }
        .dsh-au-cloud-sync-modal-close:hover { background:var(--dsw-alias-interactive-bg-hover-solid,rgba(255,255,255,0.08)); color:var(--dsw-alias-label-primary,#1f2937); border-color:var(--dsw-alias-border-l2,rgba(255,255,255,0.12)); }
        .dsh-au-cloud-sync-toolbar { flex-shrink:0; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; padding:10px 20px; background:rgba(255,255,255,0.02); border-bottom:1px solid var(--dsw-alias-border-l1,#262f40); font-size:12.5px; }
        .dsh-au-cloud-sync-tabs { display:inline-flex; align-items:center; gap:4px; padding:3px; border-radius:8px; background:var(--dsw-alias-bg-layer-2,#1a1f2c); border:1px solid var(--dsw-alias-border-l1,#262f40); }
        .dsh-au-cloud-sync-tab { display:inline-flex; align-items:center; gap:6px; padding:4px 12px; border:none; border-radius:6px; background:transparent; color:var(--dsw-alias-label-secondary,#94a3b8); font-size:12px; font-weight:500; cursor:pointer; transition:background-color .15s, color .15s; }
        .dsh-au-cloud-sync-tab:hover { color:var(--dsw-alias-label-primary,#f1f5f9); }
        .dsh-au-cloud-sync-tab.is-active { background:#2563eb; color:#ffffff; font-weight:600; box-shadow:0 1px 3px rgba(0,0,0,0.25); }
        .dsh-au-cloud-sync-tab-badge { display:inline-flex; align-items:center; padding:0 6px; border-radius:999px; font-size:10.5px; font-weight:600; line-height:1.5; background:rgba(245,158,11,0.22); color:#fcd34d; border:1px solid rgba(245,158,11,0.4); }
        .dsh-au-cloud-sync-tab.is-active .dsh-au-cloud-sync-tab-badge { background:rgba(255,255,255,0.18); color:#fef3c7; border-color:rgba(255,255,255,0.28); }
        .dsh-au-cloud-sync-diff-banner { flex-shrink:0; display:flex; align-items:center; gap:8px; padding:8px 20px; font-size:12px; line-height:1.45; color:#fde68a; background:rgba(245,158,11,0.12); border-bottom:1px solid rgba(245,158,11,0.28); }
        .dsh-au-cloud-sync-outer-diff { display:inline-flex; align-items:center; padding:1px 7px; margin-left:6px; border-radius:999px; font-size:11px; font-weight:600; background:rgba(245,158,11,0.15); color:#fbbf24; border:1px solid rgba(245,158,11,0.35); vertical-align:middle; }
        .dsh-au-cloud-sync-compare-diff-note { padding:4px 8px; margin-bottom:4px; border-radius:6px; font-size:11.5px; line-height:1.45; color:#fde68a; background:rgba(245,158,11,0.12); border:1px solid rgba(245,158,11,0.28); }
        .dsh-au-cloud-sync-plugin-state { display:inline-flex; align-items:center; padding:1px 6px; border-radius:4px; font-size:11px; font-weight:600; }
        .dsh-au-cloud-sync-plugin-state.is-enabled { background:rgba(16,185,129,0.15); color:#34d399; border:1px solid rgba(16,185,129,0.3); }
        .dsh-au-cloud-sync-plugin-state.is-disabled { background:rgba(148,163,184,0.12); color:#94a3b8; border:1px solid rgba(148,163,184,0.25); }
        .dsh-au-cloud-sync-diff-badge { display:inline-flex; align-items:center; padding:1px 7px; border-radius:999px; font-size:11px; font-weight:600; }
        .dsh-au-cloud-sync-diff-badge.is-sync { background:rgba(16,185,129,0.12); color:#34d399; border:1px solid rgba(16,185,129,0.28); }
        .dsh-au-cloud-sync-diff-badge.is-diff { background:rgba(245,158,11,0.15); color:#fbbf24; border:1px solid rgba(245,158,11,0.35); }
        .dsh-au-cloud-sync-row-actions { display:inline-flex; align-items:center; gap:5px; margin-left:auto; }
        .dsh-au-cloud-sync-mini-btn { padding:2px 7px; border-radius:5px; border:1px solid rgba(59,130,246,0.35); background:rgba(59,130,246,0.12); color:#93c5fd; font-size:11px; font-weight:500; cursor:pointer; transition:all .15s; }
        .dsh-au-cloud-sync-mini-btn:hover { background:#2563eb; border-color:#3b82f6; color:#ffffff; }
        .dsh-au-cloud-sync-mini-btn:disabled { opacity:.5; cursor:wait; }
        .dsh-au-cloud-sync-config-toggle { display:inline-flex; align-items:center; gap:5px; margin-left:4px; padding:2px 8px; border-radius:999px; background:rgba(59,130,246,0.1); border:1px solid rgba(59,130,246,0.25); font-size:11.5px; color:#93c5fd; cursor:pointer; user-select:none; }
        .dsh-au-cloud-sync-config-toggle input[type="checkbox"] { margin:0; width:13px; height:13px; accent-color:#3b82f6; cursor:pointer; }
        .dsh-au-cloud-sync-toolbar-note { color:var(--dsw-alias-label-secondary,#94a3b8); font-size:12px; }
        .dsh-au-cloud-sync-profile-picker { display:inline-flex; align-items:center; gap:6px; }
        .dsh-au-cloud-sync-profile-label { color:var(--dsw-alias-label-secondary,#94a3b8); font-size:11.5px; font-weight:500; }
        .dsh-au-cloud-sync-profile-select { height:26px; padding:2px 8px; border-radius:6px; border:1px solid var(--dsw-alias-border-l1,#2e3646); background:var(--dsw-alias-bg-layer-2,#1a1f2c); color:var(--dsw-alias-label-primary,#f1f5f9); font:inherit; font-size:11.8px; cursor:pointer; }
        .dsh-au-cloud-sync-bulk-actions { display:inline-flex; align-items:center; gap:6px; }
        .dsh-au-cloud-sync-list { display:flex; flex-direction:column; gap:10px; padding:14px 20px 18px; overflow-y:auto; overscroll-behavior:contain; flex:1 1 auto; min-height:0; }
        .dsh-au-cloud-sync-pref-section { display:flex; flex-direction:column; gap:10px; }
        .dsh-au-cloud-sync-pref-title { margin:0; }
        .dsh-au-cloud-sync-pref-jump { flex:0 0 auto; margin-left:auto; }
        .dsh-au-cloud-sync-item { flex-shrink:0; display:flex; flex-direction:column; border:1px solid var(--dsw-alias-border-l1,#262f40); border-radius:10px; background:rgba(255,255,255,0.015); transition:border-color .15s, background .15s, box-shadow .15s; }
        .dsh-au-cloud-sync-item.is-checked { border-color:rgba(59,130,246,0.32); background:rgba(59,130,246,0.025); }
        .dsh-au-cloud-sync-item.is-diff { border-color:rgba(245,158,11,0.42); background:rgba(245,158,11,0.04); }
        .dsh-au-cloud-sync-item:hover { border-color:rgba(59,130,246,0.48); }
        .dsh-au-cloud-sync-item-main { display:flex; align-items:flex-start; gap:12px; padding:11px 14px; cursor:pointer; user-select:none; }
        .dsh-au-cloud-sync-item input[type="checkbox"] { margin-top:2px; width:16px; height:16px; accent-color:#3b82f6; cursor:pointer; flex-shrink:0; }
        .dsh-au-cloud-sync-item-body { display:flex; flex-direction:column; gap:5px; min-width:0; flex:1 1 auto; }
        .dsh-au-cloud-sync-item-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; width:100%; }
        .dsh-au-cloud-sync-item-cat { display:inline-flex; align-items:center; padding:1px 7px; border-radius:5px; font-size:11px; font-weight:600; background:rgba(59,130,246,0.15); color:#93c5fd; border:1px solid rgba(59,130,246,0.32); }
        .dsh-au-cloud-sync-item-title { font-size:13.2px; font-weight:600; color:var(--dsw-alias-label-primary,#f1f5f9); }
        .dsh-au-cloud-sync-item-count { display:inline-flex; align-items:center; padding:1px 6px; border-radius:999px; font-size:10.8px; color:var(--dsw-alias-label-secondary,#94a3b8); background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.08); }
        .dsh-au-cloud-sync-expand-btn { margin-left:auto; padding:2px 8px; border:1px solid rgba(255,255,255,0.08); border-radius:5px; background:rgba(255,255,255,0.03); color:var(--dsw-alias-label-secondary,#94a3b8); font-size:11.5px; cursor:pointer; transition:background .15s, color .15s; }
        .dsh-au-cloud-sync-expand-btn:hover { background:rgba(255,255,255,0.08); color:var(--dsw-alias-label-primary,#f8fafc); }
        .dsh-au-cloud-sync-item-diff { font-size:11.8px; line-height:1.5; color:var(--dsw-alias-label-secondary,#94a3b8); overflow-wrap:anywhere; }
        .dsh-au-cloud-sync-compare-box { display:flex; flex-direction:column; border-top:1px solid rgba(255,255,255,0.07); border-radius:0 0 10px 10px; background:rgba(9,13,22,0.55); padding:8px 14px 12px 42px; gap:4px; }
        .dsh-au-cloud-sync-compare-header { display:grid; grid-template-columns:minmax(130px,1.1fr) minmax(110px,0.9fr) minmax(150px,1.3fr); gap:10px; padding:2px 0 4px; font-size:11px; font-weight:600; color:var(--dsw-alias-label-tertiary,#64748b); border-bottom:1px solid rgba(255,255,255,0.05); }
        .dsh-au-cloud-sync-compare-row { display:grid; grid-template-columns:minmax(130px,1.1fr) minmax(110px,0.9fr) minmax(150px,1.3fr); gap:10px; align-items:baseline; padding:5px 0; font-size:12px; line-height:1.5; border-bottom:1px dashed rgba(255,255,255,0.04); }
        .dsh-au-cloud-sync-compare-row:last-child { border-bottom:0; padding-bottom:2px; }
        .dsh-au-cloud-sync-compare-label { color:var(--dsw-alias-label-secondary,#cbd5e1); font-weight:500; }
        .dsh-au-cloud-sync-compare-default { color:var(--dsw-alias-label-tertiary,#64748b); font-family:Consolas,ui-monospace,monospace; font-size:11.4px; text-decoration:line-through; text-decoration-color:rgba(148,163,184,0.4); }
        .dsh-au-cloud-sync-compare-current { color:#34d399; font-family:Consolas,ui-monospace,monospace; font-size:11.6px; font-weight:600; }
        .dsh-au-cloud-sync-compare-arrow { margin-right:5px; color:#60a5fa; font-weight:700; }
        .dsh-au-cloud-sync-modal-status { flex-shrink:0; margin:0; padding:8px 20px; font-size:12px; line-height:1.45; border-top:1px solid var(--dsw-alias-border-l1,#262f40); }
        .dsh-au-cloud-sync-modal-status.is-success { background:rgba(16,185,129,0.1); color:#6ee7b7; border-top-color:rgba(16,185,129,0.28); }
        .dsh-au-cloud-sync-modal-status.is-error { background:rgba(239,68,68,0.12); color:#fca5a5; border-top-color:rgba(239,68,68,0.3); }
        .dsh-au-cloud-sync-modal-footer { flex-shrink:0; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; padding:12px 20px; border-top:1px solid var(--dsw-alias-border-l2,#d1d5db); background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,0.02)); }
        .dsh-au-cloud-sync-modal-footer-left { display:inline-flex; align-items:center; gap:8px; }
        .dsh-au-cloud-sync-modal-footer-right { display:inline-flex; align-items:center; gap:8px; margin-left:auto; }
        .dsh-au-btn-primary { background:#2563eb !important; border-color:#3b82f6 !important; color:#ffffff !important; font-weight:500; }
        .dsh-au-btn-primary:hover { background:#1d4ed8 !important; border-color:#60a5fa !important; color:#ffffff !important; }
        .dsh-au-shortcut-modal-body > .dsh-au-settings-group > h3,
        .dsh-au-shortcut-modal-body > .dsh-au-settings-group > .dsh-au-settings-desc,
        .dsh-au-model-shortcut-modal-body > .dsh-au-settings-group > h3 { display:none; }
        .dsh-au-model-shortcut-modal { width:min(760px,96vw); max-height:min(820px,92dvh); }
         /* 模型快捷切换：高级现代暗黑质感与多厂商高光系统 */
         .dsh-au-model-shortcut-group { display:flex; flex-direction:column; gap:12px; }
         .dsh-au-model-shortcut-hero { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; padding:14px 16px; border:1px solid rgba(255,255,255,0.07); border-radius:12px; background:linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.01) 100%), var(--dsw-alias-bg-layer-1,#151922); box-shadow:0 1px 3px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.06); }
         .dsh-au-settings-subtitle { margin:3px 0 0; color:var(--dsw-alias-label-secondary,#94a3b8); font-size:12.5px; line-height:1.55; }
         .dsh-au-model-shortcut-trigger-card { display:flex; align-items:center; justify-content:space-between; gap:14px; flex-wrap:wrap; padding:12px 16px; border:1px solid rgba(255,255,255,0.07); border-radius:12px; background:rgba(255,255,255,0.015); }
         .dsh-au-model-shortcut-trigger-main { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
         .dsh-au-model-shortcut-trigger-label { font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary,#f1f5f9); }
         .dsh-au-model-shortcut-trigger-kbd { min-width:80px; padding:4px 10px; border-radius:7px; border:1px solid rgba(255,255,255,0.14); background:linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.02) 100%), #181d28; color:#f8fafc; font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; font-weight:600; text-align:center; box-shadow:0 2px 4px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.12); }
         .dsh-au-model-shortcut-trigger-kbd.recording { border-color:#3b82f6; color:#60a5fa; box-shadow:0 0 12px rgba(59,130,246,0.4); animation:dsh-au-pulse 1.2s ease-in-out infinite; }
         .dsh-au-model-shortcut-trigger-actions { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
         .dsh-au-model-shortcut-meta-header { display:flex; align-items:center; justify-content:space-between; padding:0 2px; }
         .dsh-au-model-shortcut-slots { display:flex; flex-direction:column; container:dsh-au-model-slots / inline-size; border:1px solid rgba(255,255,255,0.08); border-radius:14px; background:rgba(15,18,26,0.65); box-shadow:0 4px 20px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04); overflow:hidden; }
         /* B 紧凑双行：首行编号、模型、握柄；次行厂商、短强度框、清除。 */
         .dsh-au-model-shortcut-row { display:grid; grid-template-columns:28px minmax(0,1fr) 44px; align-items:start; gap:10px 12px; min-height:62px; padding:14px; font-size:13px; border-left:3px solid transparent; transition:transform .18s cubic-bezier(0.16,1,0.3,1), background-color .18s ease, border-color .18s ease, box-shadow .18s ease; position:relative; }
         .dsh-au-model-shortcut-row, .dsh-au-model-shortcut-row * { box-sizing:border-box; }
         .dsh-au-model-shortcut-row + .dsh-au-model-shortcut-row { border-top:1px solid rgba(255,255,255,0.05); }
         .dsh-au-model-shortcut-row:hover { background:rgba(255,255,255,0.025); }
         .dsh-au-model-shortcut-row[data-empty="true"] { opacity:0.65; background:rgba(0,0,0,0.12); }
         .dsh-au-model-shortcut-row[data-empty="true"]:hover { opacity:0.95; background:rgba(255,255,255,0.02); }
         .dsh-au-model-shortcut-row[data-drop-target="true"] { border-top-color:#3b82f6; box-shadow:inset 0 2px 0 #3b82f6, 0 0 16px rgba(59,130,246,0.25); background:rgba(59,130,246,0.08); }
         .dsh-au-model-shortcut-row.is-dragging { background:rgba(59,130,246,0.16); box-shadow:0 8px 24px rgba(0,0,0,0.4), inset 0 0 0 1px rgba(59,130,246,0.4); z-index:2; }
         .dsh-au-model-shortcut-number { display:inline-flex; align-items:center; justify-content:center; width:28px; height:36px; border:1px solid rgba(255,255,255,0.1); border-radius:8px; background:linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 100%), #161a24; color:var(--dsw-alias-label-secondary,#94a3b8); font:12px/1 ui-monospace,SFMono-Regular,Menlo,monospace; font-weight:600; font-variant-numeric:tabular-nums; box-shadow:0 1px 2px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.12); flex-shrink:0; box-sizing:border-box; }
         .dsh-au-model-shortcut-drag-handle { display:inline-flex; align-items:center; justify-content:center; width:44px; min-width:44px; height:44px; padding:0; border:1px solid transparent; border-radius:8px; background:transparent; color:var(--dsw-alias-label-tertiary,#64748b); cursor:grab; touch-action:none; user-select:none; transition:color .15s ease, background-color .15s ease, transform .15s ease; box-sizing:border-box; }
         .dsh-au-model-shortcut-drag-handle:hover { color:var(--dsw-alias-label-primary,#f1f5f9); background:rgba(255,255,255,0.08); border-color:rgba(255,255,255,0.1); }
         .dsh-au-model-shortcut-drag-handle:active { cursor:grabbing; transform:scale(.92); }
         .dsh-au-model-shortcut-drag-handle:disabled { cursor:wait; opacity:.45; }
         .dsh-au-model-shortcut-drag-handle:focus-visible { outline:2px solid #3b82f6; outline-offset:2px; }
         .dsh-au-model-shortcut-drag-handle svg { width:16px; height:16px; }
         .dsh-au-model-shortcut-row > .dsh-au-model-shortcut-number { grid-column:1; grid-row:1; align-self:center; }
         .dsh-au-model-shortcut-row > .dsh-au-model-shortcut-drag-handle { grid-column:3; grid-row:1; }
         .dsh-au-model-shortcut-main { grid-column:2; grid-row:1; align-self:center; display:flex; flex-direction:column; min-width:0; width:100%; }
         .dsh-au-model-shortcut-select-label { display:block; min-width:0; width:100%; }
         .dsh-au-model-shortcut-select { display:block; width:100%; min-width:0; height:36px; padding:6px 10px; border:1px solid rgba(255,255,255,0.09); border-radius:8px; background:rgba(255,255,255,0.035); color:var(--dsw-alias-label-primary,#f1f5f9); font:inherit; font-size:13px; font-weight:500; text-align:left; cursor:pointer; transition:border-color .15s ease, background-color .15s ease, box-shadow .15s ease; text-overflow:ellipsis; box-sizing:border-box; }
         .dsh-au-model-shortcut-select:hover { border-color:rgba(255,255,255,0.18); background:rgba(255,255,255,0.065); }
         .dsh-au-model-shortcut-select:disabled { cursor:wait; opacity:.6; }
         .dsh-au-model-shortcut-select:focus-visible, .dsh-au-model-shortcut-option:focus-visible { outline:2px solid #3b82f6; outline-offset:2px; }
         .dsh-au-model-shortcut-select option { background:#161a25; color:#f1f5f9; padding:6px 10px; }
         .dsh-au-model-shortcut-select optgroup { background:#161a25; color:#94a3b8; font-style:normal; font-weight:600; padding:6px 10px; }
         .dsh-au-model-shortcut-meta-line { grid-column:2 / -1; grid-row:3; display:flex; flex-direction:column; align-items:flex-start; gap:6px; margin:0; min-width:0; min-height:18px; }
         .dsh-au-model-shortcut-id { display:inline-flex; align-items:center; gap:5px; padding:2px 7px; border-radius:5px; font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; font-weight:500; border:1px solid transparent; width:fit-content; max-width:100%; min-width:0; white-space:normal; overflow-wrap:anywhere; transition:all .15s ease; }
         .dsh-au-vendor-dot { width:5px; height:5px; border-radius:50%; flex-shrink:0; }
         .dsh-au-model-shortcut-controls { grid-column:2 / -1; grid-row:2; display:grid; grid-template-columns:minmax(0,1fr) minmax(0,210px) auto; align-items:start; gap:12px; min-width:0; }
         .dsh-au-model-shortcut-controls > .dsh-au-model-shortcut-id { grid-column:1; margin-top:8px; }
         .dsh-au-model-shortcut-controls > .dsh-au-model-shortcut-effort { grid-column:2; }
         .dsh-au-model-shortcut-controls > .dsh-au-model-shortcut-row-clear { grid-column:3; }
         .dsh-au-model-shortcut-effort { display:grid; grid-template-columns:auto minmax(0,1fr); align-items:center; gap:6px 8px; min-width:0; width:100%; margin:0; padding:0; color:var(--dsw-alias-label-tertiary,#94a3b8); font-size:11.5px; white-space:normal; }
         .dsh-au-model-shortcut-effort-select:hover { border-color:rgba(255,255,255,0.18); background:rgba(255,255,255,0.065); }
         .dsh-au-model-shortcut-effort-select:focus-visible { outline:2px solid var(--dsw-alias-brand-primary,#3b82f6); outline-offset:2px; }
         .dsh-au-model-shortcut-effort-tag { font-size:11.5px; line-height:16px; color:var(--dsw-alias-label-secondary,#94a3b8); margin:0; user-select:none; }
         .dsh-au-model-shortcut-effort-hint { grid-column:1 / -1; font-size:11px; line-height:1.5; color:var(--dsw-alias-label-secondary,#94a3b8); white-space:normal; overflow-wrap:anywhere; }
         /* 显式清掉原生 select 的最小内容宽度，长档位值不能挤出操作栏。 */
         .dsh-au-model-shortcut-effort-select { display:block; width:100%; min-width:0; max-width:100%; height:40px; padding:6px 10px; border:1px solid rgba(255,255,255,0.09); border-radius:8px; background:rgba(255,255,255,0.035); color:var(--dsw-alias-label-primary,#f1f5f9); font:inherit; font-size:12px; cursor:pointer; text-overflow:ellipsis; transition:border-color .15s ease, background-color .15s ease; }
         .dsh-au-model-shortcut-effort-select option { background:#161a25; color:#f1f5f9; }
         .dsh-au-model-shortcut-effort-default { display:flex; align-items:center; min-height:40px; padding:6px 10px; border:1px dashed rgba(255,255,255,0.08); border-radius:8px; background:rgba(255,255,255,0.015); color:var(--dsw-alias-label-secondary,#94a3b8); font-size:11.5px; overflow-wrap:anywhere; }
         .dsh-au-model-shortcut-row-clear { margin:0; min-height:40px; padding:0 12px; border-radius:8px; font-size:11.5px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); color:var(--dsw-alias-label-tertiary,#94a3b8); transition:all .15s ease; box-sizing:border-box; display:inline-flex; align-items:center; justify-content:center; }
         .dsh-au-model-shortcut-row-clear:hover:not(:disabled) { border-color:rgba(244,63,94,0.4); background:rgba(244,63,94,0.12); color:#fda4af; }
         .dsh-au-model-shortcut-row-clear:disabled { opacity:0.35; cursor:not-allowed; }
         .dsh-au-model-shortcut-status { margin:0; color:var(--dsw-alias-label-secondary,#94a3b8); font-size:12px; line-height:1.5; }
         .dsh-au-model-shortcut-status[data-tone="warn"] { display:inline-flex; align-items:center; gap:5px; color:#fbbf24; background:rgba(245,158,11,0.1); border:1px solid rgba(245,158,11,0.22); padding:2px 7px; border-radius:6px; font-size:11px; width:fit-content; min-width:0; max-width:100%; white-space:normal; overflow-wrap:anywhere; }
         .dsh-au-model-shortcut-warn-dot { width:5px; height:5px; border-radius:50%; background:#f59e0b; flex-shrink:0; }
         .dsh-au-model-shortcut-status[data-tone="error"] { color:var(--dsw-alias-state-error-primary,#f87171); }
         .dsh-au-model-shortcut-status.is-loading { display:inline-flex; align-items:center; gap:7px; color:var(--dsw-alias-state-business-primary,#60a5fa); }
         .dsh-au-model-shortcut-pulse-dot { width:6px; height:6px; border-radius:50%; background:#3b82f6; box-shadow:0 0 8px #3b82f6; animation:dsh-au-dot-pulse 1.2s ease-in-out infinite; flex-shrink:0; }
         @keyframes dsh-au-dot-pulse { 0%, 100% { opacity:0.35; transform:scale(0.85); } 50% { opacity:1; transform:scale(1.15); } }
         @keyframes dsh-au-fade-in { from { opacity:0; } to { opacity:1; } }
         @keyframes dsh-au-pulse { 0%, 100% { opacity:0.8; } 50% { opacity:1; } }

         /* ===== 厂商专属品牌色彩高光体系 ===== */
         /* OpenAI / Azure (翡翠绿高光) */
         .dsh-au-model-shortcut-row[data-vendor="openai"] { border-left-color:rgba(16,185,129,0.55); }
         .dsh-au-model-shortcut-row[data-vendor="openai"]:hover { background:rgba(16,185,129,0.035); }
         .dsh-au-model-shortcut-row[data-vendor="openai"] .dsh-au-model-shortcut-number { border-color:rgba(16,185,129,0.35); color:#34d399; }
         .dsh-au-model-shortcut-row[data-vendor="openai"] .dsh-au-vendor-dot { background:#10b981; box-shadow:0 0 6px rgba(16,185,129,0.6); }
         .dsh-au-model-shortcut-row[data-vendor="openai"] .dsh-au-model-shortcut-id { background:rgba(16,185,129,0.1); color:#34d399; border-color:rgba(16,185,129,0.25); }

         /* Anthropic / Claude (暖赤陶/琥珀橙高光) */
         .dsh-au-model-shortcut-row[data-vendor="anthropic"] { border-left-color:rgba(249,115,22,0.55); }
         .dsh-au-model-shortcut-row[data-vendor="anthropic"]:hover { background:rgba(249,115,22,0.035); }
         .dsh-au-model-shortcut-row[data-vendor="anthropic"] .dsh-au-model-shortcut-number { border-color:rgba(249,115,22,0.35); color:#fb923c; }
         .dsh-au-model-shortcut-row[data-vendor="anthropic"] .dsh-au-vendor-dot { background:#f97316; box-shadow:0 0 6px rgba(249,115,22,0.6); }
         .dsh-au-model-shortcut-row[data-vendor="anthropic"] .dsh-au-model-shortcut-id { background:rgba(249,115,22,0.1); color:#fb923c; border-color:rgba(249,115,22,0.25); }

         /* Google / Gemini (晶莹靛蓝/紫罗兰高光) */
         .dsh-au-model-shortcut-row[data-vendor="google"] { border-left-color:rgba(99,102,241,0.55); }
         .dsh-au-model-shortcut-row[data-vendor="google"]:hover { background:rgba(99,102,241,0.035); }
         .dsh-au-model-shortcut-row[data-vendor="google"] .dsh-au-model-shortcut-number { border-color:rgba(99,102,241,0.35); color:#818cf8; }
         .dsh-au-model-shortcut-row[data-vendor="google"] .dsh-au-vendor-dot { background:#6366f1; box-shadow:0 0 6px rgba(99,102,241,0.6); }
         .dsh-au-model-shortcut-row[data-vendor="google"] .dsh-au-model-shortcut-id { background:rgba(99,102,241,0.1); color:#a5b4fc; border-color:rgba(99,102,241,0.25); }

         /* DeepSeek (极光青/科技蓝高光) */
         .dsh-au-model-shortcut-row[data-vendor="deepseek"] { border-left-color:rgba(6,182,212,0.55); }
         .dsh-au-model-shortcut-row[data-vendor="deepseek"]:hover { background:rgba(6,182,212,0.035); }
         .dsh-au-model-shortcut-row[data-vendor="deepseek"] .dsh-au-model-shortcut-number { border-color:rgba(6,182,212,0.35); color:#22d3ee; }
         .dsh-au-model-shortcut-row[data-vendor="deepseek"] .dsh-au-vendor-dot { background:#06b6d4; box-shadow:0 0 6px rgba(6,182,212,0.6); }
         .dsh-au-model-shortcut-row[data-vendor="deepseek"] .dsh-au-model-shortcut-id { background:rgba(6,182,212,0.1); color:#38bdf8; border-color:rgba(6,182,212,0.25); }

         /* Qwen (洋红/玫瑰粉高光) */
         .dsh-au-model-shortcut-row[data-vendor="qwen"] { border-left-color:rgba(236,72,153,0.55); }
         .dsh-au-model-shortcut-row[data-vendor="qwen"] .dsh-au-model-shortcut-number { border-color:rgba(236,72,153,0.35); color:#f472b6; }
         .dsh-au-model-shortcut-row[data-vendor="qwen"] .dsh-au-vendor-dot { background:#ec4899; box-shadow:0 0 6px rgba(236,72,153,0.6); }
         .dsh-au-model-shortcut-row[data-vendor="qwen"] .dsh-au-model-shortcut-id { background:rgba(236,72,153,0.1); color:#f472b6; border-color:rgba(236,72,153,0.25); }

         /* 自定义 / 默认 */
         .dsh-au-model-shortcut-row[data-vendor="custom"] .dsh-au-vendor-dot { background:#94a3b8; }
         .dsh-au-model-shortcut-row[data-vendor="custom"] .dsh-au-model-shortcut-id { background:rgba(148,163,184,0.08); color:#cbd5e1; border-color:rgba(148,163,184,0.18); }

         /* 浮层 HUD 厂商标签 */
         .dsh-au-model-shortcut-vendor-tag { display:inline-flex; align-items:center; padding:1px 5px; border-radius:4px; font-weight:500; font-size:10.5px; border:1px solid transparent; }
         .dsh-au-model-shortcut-vendor-tag[data-vendor="openai"] { background:rgba(16,185,129,0.12); color:#34d399; border-color:rgba(16,185,129,0.25); }
         .dsh-au-model-shortcut-vendor-tag[data-vendor="anthropic"] { background:rgba(249,115,22,0.12); color:#fb923c; border-color:rgba(249,115,22,0.25); }
         .dsh-au-model-shortcut-vendor-tag[data-vendor="google"] { background:rgba(99,102,241,0.12); color:#a5b4fc; border-color:rgba(99,102,241,0.25); }
         .dsh-au-model-shortcut-vendor-tag[data-vendor="deepseek"] { background:rgba(6,182,212,0.12); color:#38bdf8; border-color:rgba(6,182,212,0.25); }
         .dsh-au-model-shortcut-vendor-tag[data-vendor="qwen"] { background:rgba(236,72,153,0.12); color:#f472b6; border-color:rgba(236,72,153,0.25); }
         .dsh-au-model-shortcut-vendor-tag[data-vendor="custom"] { background:rgba(148,163,184,0.1); color:#cbd5e1; border-color:rgba(148,163,184,0.18); }

         .dsh-au-model-shortcut-option[data-vendor="openai"]:hover:not(:disabled) { border-color:rgba(16,185,129,0.35); background:rgba(16,185,129,0.06); }
         .dsh-au-model-shortcut-option[data-vendor="anthropic"]:hover:not(:disabled) { border-color:rgba(249,115,22,0.35); background:rgba(249,115,22,0.06); }
         .dsh-au-model-shortcut-option[data-vendor="google"]:hover:not(:disabled) { border-color:rgba(99,102,241,0.35); background:rgba(99,102,241,0.06); }
         .dsh-au-model-shortcut-option[data-vendor="deepseek"]:hover:not(:disabled) { border-color:rgba(6,182,212,0.35); background:rgba(6,182,212,0.06); }

         .dsh-au-model-shortcut-overlay { position:fixed; inset:0; pointer-events:auto; z-index:10000; display:flex; align-items:center; justify-content:center; padding:20px; background:rgba(3,7,18,0.65); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px); animation:dsh-au-fade-in .15s ease-out both; }
         .dsh-au-model-shortcut-dialog { width:min(540px,96vw); max-height:min(680px,90dvh); overflow-y:auto; padding:20px; border:1px solid rgba(255,255,255,0.1); border-radius:16px; background:linear-gradient(180deg, rgba(24,28,40,0.95) 0%, rgba(15,18,26,0.97) 100%); backdrop-filter:blur(28px) saturate(180%); -webkit-backdrop-filter:blur(28px) saturate(180%); color:var(--dsw-alias-label-primary,#f1f5f9); box-shadow:0 32px 72px -12px rgba(0,0,0,0.78), 0 0 0 1px rgba(255,255,255,0.08), inset 0 1px 0 rgba(255,255,255,0.15); animation:dsh-au-model-shortcut-in .2s cubic-bezier(0.16,1,0.3,1) both; }
         .dsh-au-model-shortcut-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; padding-bottom:14px; border-bottom:1px solid rgba(255,255,255,0.06); margin-bottom:12px; }
         .dsh-au-model-shortcut-head-info { display:flex; flex-direction:column; gap:3px; }
         .dsh-au-model-shortcut-dialog h3 { margin:0; font-size:17px; font-weight:600; letter-spacing:-0.01em; color:var(--dsw-alias-label-primary,#f8fafc); }
         .dsh-au-model-shortcut-keyhints { display:flex; align-items:center; gap:6px; padding:4px 9px; border-radius:8px; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.07); color:var(--dsw-alias-label-tertiary,#94a3b8); font-size:11px; white-space:nowrap; user-select:none; }
         .dsh-au-model-shortcut-keyhint { display:inline-flex; align-items:center; gap:4px; }
         .dsh-au-model-shortcut-keyhint kbd { display:inline-block; padding:1px 5px; min-width:16px; border:1px solid rgba(255,255,255,0.14); border-radius:4px; background:rgba(255,255,255,0.08); color:var(--dsw-alias-label-primary,#f1f5f9); font:11px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace; font-weight:600; text-align:center; box-shadow:0 1px 1px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.15); }
         .dsh-au-model-shortcut-keyhint-dot { opacity:0.35; }
         .dsh-au-model-shortcut-desc { margin:0; color:var(--dsw-alias-label-secondary,#94a3b8); font-size:12.5px; line-height:1.5; }
         .dsh-au-model-shortcut-options { display:flex; flex-direction:column; gap:4px; }
         .dsh-au-model-shortcut-option { display:grid; grid-template-columns:32px minmax(0,1fr) auto; align-items:center; gap:12px; width:100%; min-height:52px; padding:8px 12px; border:1px solid rgba(255,255,255,0.06); border-radius:10px; background:rgba(255,255,255,0.02); color:inherit; font:inherit; text-align:left; cursor:pointer; box-shadow:0 1px 2px rgba(0,0,0,0.15); transition:background-color .15s ease, border-color .15s ease, transform .12s cubic-bezier(0.16,1,0.3,1), box-shadow .15s ease; }
         .dsh-au-model-shortcut-option:hover:not(:disabled) { border-color:rgba(96,165,250,0.35); background:rgba(59,130,246,0.08); box-shadow:0 4px 12px -2px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.08); transform:translateY(-1px); }
         .dsh-au-model-shortcut-option:active:not(:disabled) { transform:translateY(0) scale(.995); }
         .dsh-au-model-shortcut-option[data-current="true"] { border-color:rgba(16,185,129,0.4); background:linear-gradient(90deg, rgba(16,185,129,0.12) 0%, rgba(16,185,129,0.03) 100%); box-shadow:inset 0 1px 0 rgba(16,185,129,0.2); }
         .dsh-au-model-shortcut-option[data-current="true"]:hover:not(:disabled) { border-color:rgba(16,185,129,0.55); background:linear-gradient(90deg, rgba(16,185,129,0.16) 0%, rgba(16,185,129,0.05) 100%); }
         .dsh-au-model-shortcut-option[data-unavailable="true"] { opacity:0.65; background:rgba(0,0,0,0.15); }
         .dsh-au-model-shortcut-option-main { display:flex; flex-direction:column; min-width:0; gap:3px; }
         .dsh-au-model-shortcut-option-main strong { overflow-wrap:anywhere; font-size:13.5px; font-weight:600; line-height:1.35; color:var(--dsw-alias-label-primary,#f8fafc); }
         .dsh-au-model-shortcut-option-meta { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--dsw-alias-label-tertiary,#94a3b8); font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; opacity:0.9; }
         .dsh-au-model-shortcut-option-current { display:inline-flex; align-items:center; gap:5px; padding:3px 8px; border-radius:999px; background:rgba(16,185,129,0.12); border:1px solid rgba(16,185,129,0.28); color:#34d399; font-size:11px; font-weight:600; white-space:nowrap; }
         .dsh-au-model-shortcut-current-dot { width:6px; height:6px; border-radius:50%; background:#10b981; box-shadow:0 0 6px rgba(16,185,129,0.6); flex-shrink:0; }
         .dsh-au-model-shortcut-option-state { display:inline-flex; align-items:center; padding:2px 7px; border-radius:999px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.08); color:var(--dsw-alias-label-tertiary,#94a3b8); font-size:11px; white-space:nowrap; }
         .dsh-au-model-shortcut-option[data-unavailable="true"] .dsh-au-model-shortcut-option-state { background:rgba(244,63,94,0.08); border-color:rgba(244,63,94,0.2); color:#fda4af; }
         .dsh-au-model-shortcut-foot { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:14px; padding-top:12px; border-top:1px solid rgba(255,255,255,0.06); }
         .dsh-au-model-shortcut-foot-tip { font-size:11.5px; color:var(--dsw-alias-label-tertiary,#94a3b8); }
         .dsh-au-model-shortcut-close-btn { padding:5px 12px; border-radius:8px; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1); color:var(--dsw-alias-label-secondary,#cbd5e1); font-size:12px; transition:all .15s ease; }
         .dsh-au-model-shortcut-close-btn:hover { background:rgba(255,255,255,0.08); border-color:rgba(255,255,255,0.2); color:#fff; }
         @keyframes dsh-au-model-shortcut-in { from { opacity:0; transform:translateY(6px) scale(.98); } to { opacity:1; transform:none; } }
         @media (prefers-reduced-motion: reduce) { .dsh-au-model-shortcut-dialog, .dsh-au-model-shortcut-row, .dsh-au-model-shortcut-option, .dsh-au-model-shortcut-drag-handle, .dsh-au-model-shortcut-trigger-kbd { animation:none; transition:none; } }
          @media (max-width: 640px) {
           .dsh-au-shortcut-row { grid-template-columns:minmax(0,1fr) auto; }
           .dsh-au-shortcut-actions { grid-column:1 / -1; flex-wrap:wrap; }
           .dsh-au-model-shortcut-dialog { max-height:calc(100dvh - 32px); padding:14px; }
           .dsh-au-model-shortcut-option { grid-template-columns:28px minmax(0,1fr) auto; }
           .dsh-au-model-shortcut-option-current { grid-column:3; grid-row:1 / span 2; }
           .dsh-au-model-shortcut-trigger-card { flex-direction:column; align-items:stretch; gap:10px; }
           .dsh-au-model-shortcut-trigger-actions { justify-content:flex-end; }
         }
        /* 根据设置区本身的宽度拆行：窄抽屉或放大显示也不能挤压控件。 */
         @container dsh-au-model-slots (max-width: 520px) {
           .dsh-au-model-shortcut-row { gap:8px; padding:10px; }
           .dsh-au-model-shortcut-controls { grid-template-columns:minmax(0,1fr) auto; gap:8px; }
           .dsh-au-model-shortcut-controls > .dsh-au-model-shortcut-id { grid-column:1 / -1; grid-row:1; margin-top:0; }
           .dsh-au-model-shortcut-controls > .dsh-au-model-shortcut-effort { grid-column:1; grid-row:2; }
           .dsh-au-model-shortcut-controls > .dsh-au-model-shortcut-row-clear { grid-column:2; grid-row:2; }
         }
         @container dsh-au-model-slots (max-width: 360px) {
           .dsh-au-model-shortcut-effort { display:flex; flex-direction:column; align-items:stretch; }
           .dsh-au-model-shortcut-controls > .dsh-au-model-shortcut-row-clear { align-self:start; margin-top:22px; }
         }
         .dsh-au-shortcut-error { color:#f87171; }

        /* 受控远端 iframe 隐藏内部侧栏与内部移动端悬浮抽屉按钮（桌面端与移动端统一复用主 DSH 单侧栏） */
        html[data-dsh-au-controlled-frame="true"] [class*="_sidebarCol"],
        html[data-dsh-au-controlled-frame="true"] [class*="sidebarCol"],
        html[data-dsh-au-controlled-frame="true"] aside[data-slot="sidebar"],
        html[data-dsh-au-controlled-frame="true"] [data-shell-leading],
        html[data-dsh-au-controlled-frame="true"] [data-slot="shell.leading"],
        html[data-dsh-au-controlled-frame="true"] [data-sidebar-header-controls],
        html[data-dsh-au-controlled-frame="true"] [class*="_handle"][data-side="sidebar"],
        html[data-dsh-au-controlled-frame="true"] .dsh-au-mobile-trigger,
        html[data-dsh-au-controlled-frame="true"] .dsh-au-mobile-backdrop,
        html[data-dsh-au-controlled-frame="true"] .dsh-au-mobile-edge-zone {
          display:none !important;
        }
        html[data-dsh-au-controlled-frame="true"] [class*="_frame"] {
          --dsh-frame-leading-clearance:0px !important;
          --dsh-windows-sidebar-width:0px !important;
        }
        html[data-dsh-au-controlled-frame="true"] [class*="_centerCol"] {
          grid-column:1 / 3 !important;
          border-left:none !important;
        }
        /* 远端舞台激活时压制本机侧栏非远端会话默认选中态背景，保留远端选中会话的原生高亮与悬停反馈 */
        html[data-dsh-au-remote-active="true"] [data-row-key^="session:"]:not([data-dsh-au-remote-session="1"]):not(:hover),
        html[data-dsh-au-remote-active="true"] [data-row-key^="session:"]:not([data-dsh-au-remote-session="1"]):not(:hover) > * {
          background:transparent !important;
          background-color:transparent !important;
        }
        /* 原生工作区树内的远端工作区行标题与机器胶囊排布：保持 _projectText 为 flex:1 以将右侧操作按钮推至最右端 */
        [data-row-key^="workspace:dsh-au-remote-ws:"] [class*="_projectText"] {
          display:flex !important;
          flex-direction:row !important;
          align-items:center !important;
          gap:6px !important;
          flex:1 1 0% !important;
          min-width:0 !important;
        }
        [data-row-key^="workspace:dsh-au-remote-ws:"] [class*="_projectText"] > [class*="_title"] {
          flex:0 1 auto !important;
          min-width:0 !important;
          overflow:hidden !important;
          text-overflow:ellipsis !important;
          white-space:nowrap !important;
        }
        [data-row-key^="session:"]:hover .dsh-au-remote-flat-badge {
          display:none !important;
        }
        .dsh-au-remote-flat-badge {
          height:16px !important;
          padding:0 5px !important;
          font-size:10px !important;
          margin-right:4px !important;
        }
        .dsh-au-state-dot-error {
          background:var(--dsw-alias-state-error-primary,#ef4444) !important;
          background-color:var(--dsw-alias-state-error-primary,#ef4444) !important;
          color:var(--dsw-alias-state-error-primary,#ef4444) !important;
          box-shadow:0 0 6px rgba(239,68,68,.75) !important;
        }
        /* 左侧栏远端工作区原生 1:1 融合样式：display:contents 使工作区项直接作为原生工作区树 flex 子项参与时间排序 */
        .dsh-au-remote-ws-root { display:contents; }
        .dsh-au-remote-ws-item { display:flex; flex-direction:column; gap:2px; }
        .dsh-au-remote-ws-row { display:flex; align-items:center; gap:6px; height:34px; padding:0 8px; border-radius:var(--dsw-radius-md,8px); color:var(--dsw-alias-label-primary,#111827); font-size:14px; line-height:20px; cursor:pointer; user-select:none; box-sizing:border-box; transition:background-color .12s ease; }
        body[data-ds-dark-theme] .dsh-au-remote-ws-row { color:var(--dsw-alias-label-primary,#e5e7eb); }
        .dsh-au-remote-ws-row:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(148,163,184,.1)); }
        .dsh-au-remote-ws-row.active { color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#2563eb)); }
        body[data-ds-dark-theme] .dsh-au-remote-ws-row.active { color:var(--dsw-alias-label-primary,#f8fafc); }
        .dsh-au-remote-ws-leading { width:16px; height:20px; flex:0 0 16px; display:inline-flex; align-items:center; justify-content:center; color:var(--dsw-alias-label-tertiary,#94a3b8); }
        .dsh-au-remote-ws-leading.highlight { color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#60a5fa)); }
        .dsh-au-remote-ws-folder-icon { display:inline-flex; align-items:center; justify-content:center; }
        .dsh-au-remote-ws-chevron-icon { display:none; align-items:center; justify-content:center; color:var(--dsw-alias-label-caption,#94a3b8); transition:transform .15s var(--ds-ease-in-out,ease); }
        .dsh-au-remote-ws-chevron-icon.expanded { transform:rotate(90deg); }
        .dsh-au-remote-ws-row:hover .dsh-au-remote-ws-folder-icon { display:none; }
        .dsh-au-remote-ws-row:hover .dsh-au-remote-ws-chevron-icon { display:inline-flex; }
        .dsh-au-remote-ws-main { flex:1 1 0%; min-width:0; display:flex; align-items:center; gap:6px; }
        .dsh-au-remote-ws-title { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:14px; font-weight:400; line-height:20px; color:inherit; }
        .dsh-au-remote-ws-badge { flex:0 0 auto; display:inline-flex; align-items:center; gap:4px; max-width:144px; height:18px; padding:0 6px; border-radius:999px; border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.08)); background:var(--dsw-alias-bg-module-platform,rgba(15,23,42,.06)); color:var(--dsw-alias-label-secondary,#475569); font-size:10.5px; font-weight:500; line-height:1; }
        body[data-ds-dark-theme] .dsh-au-remote-ws-badge { border-color:var(--dsw-alias-border-l1,rgba(148,163,184,.22)); background:var(--dsw-alias-bg-module-platform,rgba(30,41,59,.65)); color:var(--dsw-alias-label-secondary,#94a3b8); }
        .dsh-au-menu-ws-badge { flex:0 0 auto; margin-left:6px; }
        /* 电脑信息只在分组标题出现一次，给同名项目和长名称留出空间。 */
        [data-dsh-au-picker-groups] .dsh-au-menu-ws-badge { display:none; }
        .dsh-au-menu-ws-group-heading {
          padding:10px 8px 4px;
          color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#2563eb));
          font-size:13.5px;
          font-weight:600;
          line-height:20px;
          letter-spacing:0.01em;
          white-space:nowrap;
          overflow:hidden;
          text-overflow:ellipsis;
          user-select:none;
          -webkit-user-select:none;
          cursor:default;
        }
        body[data-ds-dark-theme] .dsh-au-menu-ws-group-heading {
          color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#60a5fa));
        }
        .dsh-au-menu-ws-group-heading:first-child,
        .dsh-au-menu-ws-group-heading[data-dsh-au-group-first="true"] {
          padding-top:4px;
        }
        /* 左侧栏工作区按设备（本机 / 各远端电脑）二级分组 */
        .dsh-au-ws-grouped-tree { display:flex; flex-direction:column; }
        button.dsh-au-ws-device-group {
          display:flex; align-items:center; gap:6px; width:100%; height:30px; margin:6px 0 2px; padding:0 8px;
          border:0; border-radius:var(--dsw-radius-md,8px); background:transparent;
          color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#2563eb)); font-size:13.5px; font-weight:600; line-height:20px;
          cursor:pointer; user-select:none; box-sizing:border-box; text-align:left;
          transition:background-color .12s ease, color .12s ease;
        }
        button.dsh-au-ws-device-group[data-first-group="1"] { margin-top:0; }
        button.dsh-au-ws-device-group:hover {
          background:var(--dsw-alias-interactive-bg-hover,rgba(148,163,184,.1));
          color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#2563eb) 85%,#0f172a);
        }
        body[data-ds-dark-theme] button.dsh-au-ws-device-group { color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#60a5fa)); }
        body[data-ds-dark-theme] button.dsh-au-ws-device-group:hover { color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#60a5fa) 82%,#ffffff); }
        .dsh-au-ws-device-group-chevron {
          width:12px; height:12px; flex:0 0 12px; display:inline-flex; align-items:center; justify-content:center;
          color:var(--dsw-alias-label-caption,#94a3b8); transition:transform .15s var(--ds-ease-in-out,ease);
        }
        button.dsh-au-ws-device-group[aria-expanded="true"] .dsh-au-ws-device-group-chevron { transform:rotate(90deg); }
        .dsh-au-ws-device-group-icon {
          width:15px; height:15px; flex:0 0 15px; display:inline-flex; align-items:center; justify-content:center;
          opacity:.95;
        }
        .dsh-au-ws-device-group-label {
          flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
        }
        .dsh-au-ws-device-group-transport {
          flex:0 0 auto; font-size:10.5px; font-weight:500; opacity:.78;
        }
        .dsh-au-ws-device-group-count {
          flex:0 0 auto; font-size:11px; font-weight:500; color:var(--dsw-alias-label-tertiary,#94a3b8);
        }
        .dsh-au-ws-grouped-item { padding-left:12px; box-sizing:border-box; }
        .dsh-au-ws-group-hidden { display:none !important; }
        .dsh-au-ws-grouped-tree .dsh-au-remote-ws-badge { display:none; }
        .dsh-au-remote-ws-row.active .dsh-au-remote-ws-badge,
        [data-row-key^="workspace:"][aria-selected="true"] .dsh-au-remote-ws-badge,
        [data-row-key^="workspace:"][class*="_selected"] .dsh-au-remote-ws-badge,
        [data-row-key^="workspace:"][class*="_active"] .dsh-au-remote-ws-badge {
          border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 35%,transparent);
          color:var(--dsw-alias-state-business-primary,#2563eb);
          background:var(--dsw-alias-state-business-tertiary,rgba(59,130,246,.12));
        }
        body[data-ds-dark-theme] .dsh-au-remote-ws-row.active .dsh-au-remote-ws-badge,
        body[data-ds-dark-theme] [data-row-key^="workspace:"][aria-selected="true"] .dsh-au-remote-ws-badge,
        body[data-ds-dark-theme] [data-row-key^="workspace:"][class*="_selected"] .dsh-au-remote-ws-badge,
        body[data-ds-dark-theme] [data-row-key^="workspace:"][class*="_active"] .dsh-au-remote-ws-badge {
          border-color:rgba(96,165,250,.45);
          color:#93c5fd;
          background:rgba(59,130,246,.18);
        }
        .dsh-au-remote-ws-badge-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .dsh-au-remote-ws-badge-sep { opacity:.42; font-size:9.5px; flex:0 0 auto; margin:0 -1px; }
        .dsh-au-remote-ws-badge-transport { flex:0 0 auto; font-size:10px; font-weight:600; opacity:.92; }
        .dsh-au-remote-ws-badge-dot { width:6px; height:6px; border-radius:50%; flex:0 0 6px; }
        .dsh-au-remote-ws-badge-dot.busy, .dsh-au-remote-ws-badge-dot.running, .dsh-au-remote-session-dot.busy, .dsh-au-remote-session-dot.running { background:#f59e0b; box-shadow:0 0 6px rgba(245,158,11,.7); animation:dsh-au-pulse 1.2s ease-in-out infinite; }
        .dsh-au-remote-ws-badge-dot.waiting, .dsh-au-remote-session-dot.waiting { background:#f97316; box-shadow:0 0 6px rgba(249,115,22,.85); animation:dsh-au-pulse 1s ease-in-out infinite; }
        /* 暂时隐藏自定义完成态蓝灯（done 状态点） */
        .dsh-au-remote-ws-badge-dot.done, .dsh-au-remote-session-dot.done { display:none !important; }
        .dsh-au-remote-ws-badge-dot.error, .dsh-au-remote-session-dot.error { background:#ef4444; box-shadow:0 0 6px rgba(239,68,68,.85); }
        .dsh-au-remote-ws-actions { display:none; align-items:center; gap:2px; flex:0 0 auto; margin-left:auto; }
        .dsh-au-remote-ws-row:hover .dsh-au-remote-ws-actions { display:inline-flex; }
        .dsh-au-remote-ws-action-btn { width:22px; height:22px; padding:0; border:0; border-radius:5px; background:transparent; color:var(--dsw-alias-label-secondary,#64748b); display:inline-flex; align-items:center; justify-content:center; cursor:pointer; }
        body[data-ds-dark-theme] .dsh-au-remote-ws-action-btn { color:var(--dsw-alias-label-secondary,#94a3b8); }
        .dsh-au-remote-ws-action-btn:hover { background:var(--dsw-alias-interactive-bg-active,rgba(148,163,184,.18)); color:var(--dsw-alias-label-primary,#111827); }
        body[data-ds-dark-theme] .dsh-au-remote-ws-action-btn:hover { color:var(--dsw-alias-label-primary,#f8fafc); }
        .dsh-au-remote-session-list { display:flex; flex-direction:column; gap:1px; }
        .dsh-au-remote-session-row { display:flex; align-items:center; gap:6px; height:32px; padding:0 8px 0 20px; border-radius:var(--dsw-radius-md,8px); color:var(--dsw-alias-label-secondary,#475569); font-size:14px; line-height:20px; cursor:pointer; user-select:none; box-sizing:border-box; transition:background-color .12s ease; }
        body[data-ds-dark-theme] .dsh-au-remote-session-row { color:var(--dsw-alias-label-secondary,#cbd5e1); }
        .dsh-au-remote-session-row:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(148,163,184,.1)); color:var(--dsw-alias-label-primary,#111827); }
        body[data-ds-dark-theme] .dsh-au-remote-session-row:hover { color:var(--dsw-alias-label-primary,#f8fafc); }
        .dsh-au-remote-session-row.selected { background:var(--dsw-alias-interactive-bg-selected,rgba(148,163,184,.16)); color:var(--dsw-alias-label-primary,#111827); font-weight:500; }
        body[data-ds-dark-theme] .dsh-au-remote-session-row.selected { color:var(--dsw-alias-label-primary,#f8fafc); }
        .dsh-au-remote-session-leading { width:16px; height:20px; flex:0 0 16px; display:inline-flex; align-items:center; justify-content:center; }
        .dsh-au-remote-session-dot { width:7px; height:7px; border-radius:50%; flex:0 0 7px; }
        .dsh-au-remote-session-title { flex:1 1 0%; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:14px; }
        .dsh-au-remote-session-time { flex:0 0 auto; font-size:10px; color:var(--dsw-alias-label-tertiary,#64748b); font-variant-numeric:tabular-nums; margin-left:4px; }
        .dsh-au-remote-ws-restore { display:flex; align-items:center; justify-content:flex-start; width:100%; height:26px; padding:0 8px 0 30px; border:0; border-radius:var(--dsw-radius-md,8px); background:transparent; color:var(--dsw-alias-label-tertiary,#64748b); font:inherit; font-size:11.5px; text-align:left; cursor:pointer; }
        .dsh-au-remote-ws-restore:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(148,163,184,.08)); color:var(--dsw-alias-label-secondary,#475569); }
        body[data-ds-dark-theme] .dsh-au-remote-ws-restore:hover { color:var(--dsw-alias-label-secondary,#94a3b8); }
      `;
    }

