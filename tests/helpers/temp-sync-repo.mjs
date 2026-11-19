import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/** 建一份可被 syncRepoRoot 识别的私人仓库夹具：dsh-au/sync + 可选 gateways。 */
export function makeTempSyncRepo(prefix = 'dsh-au-sync-repo-') {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const syncDir = path.join(root, 'dsh-au', 'sync');
  mkdirSync(path.join(syncDir, 'cloud'), { recursive: true });
  mkdirSync(path.join(syncDir, 'plugins'), { recursive: true });
  mkdirSync(path.join(syncDir, 'machines'), { recursive: true });
  mkdirSync(path.join(root, 'gateways', 'demo-gateway'), { recursive: true });
  mkdirSync(path.join(root, 'app-config', 'dsh'), { recursive: true });
  mkdirSync(path.join(root, 'app-config', 'codex'), { recursive: true });
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  writeFileSync(path.join(syncDir, 'cloud', 'manifest.cloud.json'), `${JSON.stringify({
    schemaVersion: 1, updatedAt: '', services: {}, devices: [], plugins: {},
  }, null, 2)}\n`);
  writeFileSync(path.join(root, 'gateways', 'demo-gateway', 'server.py'), 'print("ok")\n');
  return { root, syncDir };
}

/** 在用例期间把 DSH_AU_SYNC_REPO 指到临时仓库，结束后还原并删除目录。 */
export function useTempSyncRepo(t, prefix) {
  const repo = makeTempSyncRepo(prefix);
  const previous = process.env.DSH_AU_SYNC_REPO;
  process.env.DSH_AU_SYNC_REPO = repo.root;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_AU_SYNC_REPO;
    else process.env.DSH_AU_SYNC_REPO = previous;
    rmSync(repo.root, { recursive: true, force: true });
  });
  return repo;
}

export function copyMenuFixture(repoRoot) {
  copyFileSync(path.join(FIXTURES, 'menu.json'), path.join(repoRoot, 'scripts', 'menu.json'));
}

export function copyRestoreMock(repoRoot) {
  copyFileSync(path.join(FIXTURES, 'dsh-restore-mock.mjs'), path.join(repoRoot, 'scripts', 'dsh-restore.mjs'));
}
