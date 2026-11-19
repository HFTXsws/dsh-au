import { parentPort, workerData } from 'node:worker_threads';
import { applySingleDshPluginState, syncDshPlugins } from './plugin-sync-core.js';
import { runPluginsDoctor } from './plugin-doctor.js';

// 安装仍使用同一同步核心，但放到工作线程，避免卡住宿主状态/HTTP 服务。
try {
  const result = workerData.mode === 'doctor' ? runPluginsDoctor(workerData.options)
    : workerData.mode === 'single' ? applySingleDshPluginState(workerData.options) : syncDshPlugins(workerData.options);
  parentPort.postMessage(result);
} catch (error) {
  parentPort.postMessage({ ok: false, outcome: 'failed', code: error.code || 'SYNC_WORKER_FAILED',
    error: error.message, results: [], recoveryRequired: true, restartRequired: false });
}
