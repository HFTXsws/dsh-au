import { Worker } from 'node:worker_threads';

/** HTTP 入口只等待任务结果；运行中的安装不占宿主主线程。Profile 锁由共同核心处理。 */
function run(mode, options) {
  return new Promise((resolve) => {
    let received = false;
    let worker;
    const failed = (error) => ({ ok: false, outcome: 'failed', code: error?.code || 'SYNC_WORKER_FAILED',
      error: error?.message || '插件安装工作线程意外退出，请运行插件 Doctor', results: [], recoveryRequired: true, restartRequired: false });
    try {
      worker = new Worker(new URL('./plugin-sync-worker.js', import.meta.url), { workerData: { mode, options }, execArgv: [] });
    } catch (error) { resolve(failed(error)); return; }
    worker.once('message', (result) => { received = true; resolve(result); });
    worker.once('error', (error) => { received = true; resolve(failed(error)); });
    worker.once('exit', () => { if (!received) resolve(failed()); });
  });
}

export const syncDshPlugins = (options) => run('batch', options);
export const applySingleDshPluginState = (options) => run('single', options);
export const runPluginsDoctor = (options) => run('doctor', options);
