import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 测试副作用模块：必须最先 import。把本机指针、开关镜像与机器备份重定向到临时目录，
// 避免用例按真实主机名写进仓库里的 sync/local/state.json 与 sync/machines/*.json。
// 用例自己设置的 DSH_AU_LOCAL_DIR 优先；用例从不删除这个变量，所以整个文件都生效。
if (!process.env.DSH_AU_LOCAL_DIR && !process.env.DSH_AU_LOCAL_BINDINGS_PATH) {
  process.env.DSH_AU_LOCAL_DIR = join(mkdtempSync(join(tmpdir(), 'dsh-au-test-sync-')), 'local');
}
// 指向插件根会被 resolveSyncRepoRoot 视为未配置，挡住本机 dsh-au.config.json 的 syncRepoRoot。
// 不改 DSH_AU_CONFIG_PATH：config-store 可能在 import 时缓存路径，测试文件也会 delete 该变量。
if (!process.env.DSH_AU_SYNC_REPO) {
  process.env.DSH_AU_SYNC_REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
}
// 模型快捷槽位已改存本机文件，测试同样重定向，避免读写真实的 ~/.dsh/model-shortcuts.json。
const testBaseDir = process.env.DSH_AU_LOCAL_DIR || dirname(process.env.DSH_AU_LOCAL_BINDINGS_PATH);
if (!process.env.DSH_AU_MODEL_SHORTCUTS_PATH) {
  process.env.DSH_AU_MODEL_SHORTCUTS_PATH = join(testBaseDir, 'model-shortcuts.json');
}
if (!process.env.DSH_AU_SKIP_SCRIPT_PROCESS_SCAN) {
  process.env.DSH_AU_SKIP_SCRIPT_PROCESS_SCAN = '1';
}
