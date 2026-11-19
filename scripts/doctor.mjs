#!/usr/bin/env node
/**
 * DSH 本地服务管理 Doctor
 *
 * 检查本机绑定 JSON (sync/machines/<machineId>.json) 登记的本地服务是否成功支持 dsh-au 插件管理：
 * - 路径规范：私人同步仓库内的脚本是否直接写仓库相对路径，脚本文件是否存在；
 * - 四个开关与生命周期管理能力：本机启用 (enabled)、开机自启 (autoStartOnBoot)、随 DSH 自启 (autoStartOnDsh)、
 *   启动 (start)、重启 (restart)、停止 (stop) 是否就绪；
 * - 探活检查：当前 HTTP 健康地址或 TCP 端口是否可达；
 * - 可选闭环实测：传入 --service <id> --probe-lifecycle 对指定服务执行真实启停与自启同步闭环验证。
 *
 * 用法：
 *   node scripts/doctor.mjs
 *   node scripts/doctor.mjs --json
 *   node scripts/doctor.mjs --service <id> [--probe-lifecycle]
 *   node scripts/doctor.mjs --extensions
 *   node scripts/doctor.mjs --ext <id>
 */

import process from 'node:process';
import { runLocalServicesDoctor } from '../lib/service-doctor.js';
import { runPrivateExtensionsDoctor } from '../lib/private-extensions.js';

function parseArgs(argv) {
  const opts = { json: false, serviceId: '', probeLifecycle: false, hostname: '', extensionsOnly: false, extId: '' };
  const value = (flag, raw) => {
    if (!raw || !raw.trim() || raw.startsWith('--')) throw new Error(`${flag} 缺少有效参数`);
    return raw.trim();
  };
  const setService = (raw) => {
    if (opts.serviceId) throw new Error('--service 只能指定一次，禁止多个启停目标');
    opts.serviceId = value('--service', raw);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--probe-lifecycle') opts.probeLifecycle = true;
    else if (arg === '--service') setService(argv[++i]);
    else if (arg.startsWith('--service=')) setService(arg.slice('--service='.length));
    else if (arg === '--hostname') opts.hostname = value('--hostname', argv[++i]);
    else if (arg === '--extensions') opts.extensionsOnly = true;
    else if (arg === '--ext') opts.extId = value('--ext', argv[++i]);
    else if (arg.startsWith('--ext=')) opts.extId = value('--ext=', argv[i].slice('--ext='.length));
    else throw new Error(`未知参数：${arg}`);
  }
  // 必须在进入库函数、加载本机绑定前拒绝无目标的真实启停。
  if (opts.probeLifecycle && !opts.serviceId) throw new Error('--probe-lifecycle 必须指定唯一的 --service <id>');
  if (opts.extId) opts.extensionsOnly = true;
  return opts;
}

function badge(ok, warn = false) {
  if (ok) return '[PASS]';
  if (warn) return '[WARN]';
  return '[FAIL]';
}

function capTag(cap) {
  if (!cap) return '✗';
  if (cap.supported) return '✓';
  if (cap.byDesign) return '✓(受保护)';
  return '✗';
}

function printHumanReport(report) {
  console.log('=== DSH 本地服务管理 Doctor ===');
  console.log(`电脑主机 : ${report.machine.hostname} (machineId=${report.machine.machineId}, platform=${report.machine.platform})`);
  console.log(`本机绑定 : ${report.machine.bindingFile} (${report.machine.bindingExists ? '已存在' : '未创建'})`);
  console.log(`状态镜像 : ${report.machine.stateFile}`);
  console.log(`自启目录 : ${report.machine.startupDir}`);
  if (report.machine.bindingError) {
    console.log(`[FAIL] 绑定文件读取异常: ${report.machine.bindingError}`);
  }
  console.log('');

  if (report.services.length === 0) {
    console.log('[WARN] 当前绑定文件尚未登记任何本地服务。请先参考 dsh-au/sync/README.md 在 machines/<machineId>.json 中登记。');
    return;
  }

  for (const svc of report.services) {
    if (!svc.registered) {
      console.log(`${badge(false)} ${svc.id}: ${svc.issues.join('；')}`);
      continue;
    }
    const isPass = svc.status === 'managed';
    const isWarn = svc.status === 'monitor-only';
    const runLabel = svc.health.running === null ? '未探测' : svc.health.running ? '运行中' : '未运行';
    console.log(`${badge(isPass, isWarn)} ${svc.id} (${svc.name}) · 通道=${svc.controlChannel} · 当前=${runLabel}`);

    if (svc.scriptPath.raw) {
      const pathType = svc.scriptPath.isInRepo ? '仓库内相对路径' : '外部路径';
      const existsLabel = svc.scriptPath.isDirectory ? '错误：目录' : svc.scriptPath.isFile ? '文件存在' : '文件缺失或非普通文件';
      console.log(`       脚本路径 : ${svc.scriptPath.raw} (${pathType}, ${existsLabel})`);
    } else {
      console.log('       脚本路径 : (未在 JSON 记录 scriptPath，依赖平台控制器或仅作状态监控)');
    }

    for (const config of svc.configPaths || []) {
      const type = config.unverifiable ? '未解析' : config.isDirectory ? '错误：目录' : config.isFile ? '文件' : '缺失或不可访问';
      console.log(`       配置资源 : ${config.raw} (${type})`);
    }
    for (const cache of svc.cachePaths || []) {
      const type = cache.unverifiable ? '未解析' : cache.isDirectory ? '目录' : cache.exists ? '错误：非目录' : '尚未创建';
      console.log(`       缓存目录 : ${cache.raw} (${type})`);
    }
    if (svc.execution?.command) {
      console.log(`       运行入口 : ${svc.execution.command} (${svc.execution.exists ? `已找到：${svc.execution.resolved}` : '缺失或不可执行'})`);
    }
    if (!svc.lifecycleProbe) console.log('       生命周期 : 未实测（以下仅为静态管理条件，不证明自启或启停已生效）');
    const c = svc.capabilities;
    console.log(
      `       插件纳管 : 本机启用=${capTag(c.enabled)}(当前:${c.enabled.current ? '开' : '关'})`
      + ` | 开机自启=${capTag(c.autoStartOnBoot)}(当前:${c.autoStartOnBoot.current ? '开' : '关'})`
      + ` | 随DSH自启=${capTag(c.autoStartOnDsh)}(当前:${c.autoStartOnDsh.current ? '开' : '关'})`
      + ` | 启动=${capTag(c.start)}`
      + ` | 重启=${capTag(c.restart)}`
      + ` | 停止=${capTag(c.stop)}`,
    );

    if (svc.lifecycleProbe) {
      const entries = Object.entries(svc.lifecycleProbe.steps || {});
      const passedSteps = entries.filter(([, step]) => step.ok && !step.skipped).map(([name]) => name).join(', ');
      const skippedSteps = entries.filter(([, step]) => step.skipped).map(([name]) => name).join(', ');
      const label = svc.lifecycleProbe.complete === false ? '部分验证通过' : '通过';
      console.log(`       闭环实测 : ${svc.lifecycleProbe.ok ? `${label} (${passedSteps})` : `失败或未执行 (${svc.lifecycleProbe.error})`}`);
      console.log(`       自启检查 : 仅隔离生成与清理，未验证真实开机自启${skippedSteps ? `；未执行步骤：${skippedSteps}` : ''}`);
    }
    for (const issue of svc.issues) {
      console.log(`       [问题] ${issue}`);
    }
    for (const warn of svc.warnings) {
      console.log(`       [提示] ${warn}`);
    }
  }

  console.log('');
  console.log(
    `汇总 : 共 ${report.summary.total} 项服务 · 静态纳管检查通过 ${report.summary.managed} 项`
    + ` · 仅状态监控 ${report.summary.monitorOnly} 项`
    + ` · 配置异常 ${report.summary.misconfigured} 项`,
  );
}

function printExtensionsReport(extReport) {
  console.log('');
  console.log('=== 私人工作台扩展 Doctor ===');
  console.log(`私人仓库 : ${extReport.syncRepoRoot || '(未配置 syncRepoRoot)'}`);
  console.log(`扩展目录 : ${extReport.extensionsDir || '(无)'}`);
  if (extReport.status === 'unconfigured') {
    console.log('[PASS] 未配置私人仓库，出厂版本不加载任何私人扩展。');
    return;
  }
  if (extReport.issues?.length) {
    for (const issue of extReport.issues) {
      console.log(`[FAIL] ${issue}`);
    }
  }
  if (extReport.extensions.length === 0) {
    if (!extReport.issues?.length) {
      console.log('[PASS] 扩展目录暂无扩展，工作台将只显示内建标签页。');
    }
    return;
  }
  for (const ext of extReport.extensions) {
    const isPass = ext.status === 'ok';
    const isWarn = ext.status === 'warn';
    const fileFlags = [
      ext.files.manifest ? 'manifest' : '无manifest',
      ext.files.client ? 'client.js' : '无client.js',
      ext.files.style ? 'styles.css' : null,
      ext.files.server ? 'server.js' : null,
    ].filter(Boolean).join(', ');
    console.log(`${badge(isPass, isWarn)} ${ext.id || ext.folder} (${ext.title || '未命名'}) · order=${ext.order} · 文件=[${fileFlags}]`);
    for (const issue of ext.issues || []) {
      console.log(`       [问题] ${issue}`);
    }
    for (const warn of ext.warnings || []) {
      console.log(`       [提示] ${warn}`);
    }
  }
  console.log('');
  console.log(
    `扩展汇总 : 共 ${extReport.summary.total} 个扩展 · 通过 ${extReport.summary.okCount} 个`
    + ` · 提示 ${extReport.summary.warnCount} 个 · 异常 ${extReport.summary.failCount} 个`,
  );
}

try {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.extensionsOnly) {
    const extReport = await runPrivateExtensionsDoctor({ extId: opts.extId || undefined });
    if (opts.json) console.log(JSON.stringify(extReport, null, 2));
    else printExtensionsReport(extReport);
    process.exitCode = extReport.ok ? 0 : 1;
  } else {
    const report = await runLocalServicesDoctor({
      hostname: opts.hostname || undefined,
      serviceId: opts.serviceId || undefined,
      probeLifecycle: opts.probeLifecycle,
    });
    const extReport = opts.serviceId ? null : await runPrivateExtensionsDoctor({});
    const allOk = report.ok && (extReport ? extReport.ok : true);
    if (opts.json) {
      console.log(JSON.stringify(extReport ? { ...report, privateExtensions: extReport, ok: allOk } : report, null, 2));
    } else {
      printHumanReport(report);
      if (extReport) printExtensionsReport(extReport);
    }
    process.exitCode = allOk ? 0 : 1;
  }
} catch (error) {
  console.error(`[FAIL] ${error.message}`);
  process.exitCode = 2;
}
