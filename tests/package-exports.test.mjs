import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('package.json 保持 dsh-au 包名并暴露公共子路径导出', () => {
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'dsh-au');
  const expected = {
    './sync-repo': './lib/sync-repo.js',
    './config-store': './lib/config-store.js',
    './cloud-manifest': './lib/cloud-manifest.js',
    './local-bindings': './lib/local-bindings.js',
    './plugin-bundles': './lib/plugin-bundles.js',
    './plugin-profile-state': './lib/plugin-profile-state.js',
    './plugin-runtime': './lib/plugin-runtime.js',
    './plugin-links': './lib/plugin-links.js',
    './legacy-cleanup': './lib/legacy-cleanup.js',
    './official-settings-sync': './lib/official-settings-sync.js',
    './plugin-doctor': './lib/plugin-doctor.js',
    './service-doctor': './lib/service-doctor.js',
  };
  for (const [subpath, file] of Object.entries(expected)) {
    assert.equal(pkg.exports[subpath], file, `缺少导出 ${subpath}`);
  }
});
