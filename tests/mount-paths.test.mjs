import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyLocalBinding, toHomeRelative } from '../lib/local-bindings.js';
import { inspectLocalServiceManagement } from '../lib/service-doctor.js';

function pathFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-au-mount-paths-'));
  // 只清理本测试创建并持有的绝对临时目录，不接触真实挂载或配置。
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scriptPath = path.join(root, 'mount.mjs');
  const configPath = path.join(root, 'rclone.conf');
  const cacheDir = path.join(root, 'cache');
  writeFileSync(scriptPath, '// 静态路径 fixture，不启动服务。\n');
  writeFileSync(configPath, '配置内容不应被路径诊断读取。\n');
  mkdirSync(cacheDir);
  return { root, scriptPath, configPath, cacheDir };
}

test('网盘本机配置与缓存覆盖旧目录元数据，家目录缩写分别展开', (t) => {
  const { scriptPath, configPath, cacheDir } = pathFixture(t);
  const source = {
    scriptPath: toHomeRelative(scriptPath),
    configPath: toHomeRelative(configPath),
    cacheDir: toHomeRelative(cacheDir),
  };
  const result = applyLocalBinding(
    { id: 'svc_mount', configPath: 'obsolete-cache', cacheDir: 'obsolete-cache' },
    { svc_mount: source },
    {},
  );
  assert.equal(result.scriptPath, scriptPath);
  assert.equal(result.configPath, configPath);
  assert.equal(result.cacheDir, cacheDir);
  assert.notEqual(result.configPath, result.cacheDir);
});

test('Doctor 分别校验网盘配置文件和缓存目录，首次未建缓存不误报失败', async (t) => {
  const { root, scriptPath, configPath, cacheDir } = pathFixture(t);
  const cases = [
    { name: '现有缓存目录', cacheDir, status: 'managed', exists: true, isDirectory: true },
    { name: '缓存误填为普通文件', cacheDir: configPath, status: 'misconfigured', exists: true, isDirectory: false },
    { name: '首次尚未建立缓存', cacheDir: path.join(root, 'not-created'), status: 'managed', exists: false, isDirectory: false },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const report = await inspectLocalServiceManagement('svc_mount', {
        bindingsData: { machineId: 'mount-fixture', filePath: path.join(root, 'binding.json'), services: {
          svc_mount: { scriptPath, configPath, cacheDir: scenario.cacheDir },
        } },
        stateData: { services: {} },
        profile: { enabled: [], autoStartOnBoot: [], autoStartOnDsh: [] },
        skipNetworkProbe: true,
        preferScriptRunner: true,
        env: { PATH: '' },
      });
      assert.equal(report.status, scenario.status);
      assert.equal(report.configPaths[0].isFile, true);
      assert.equal(report.cachePaths[0].exists, scenario.exists);
      assert.equal(report.cachePaths[0].isDirectory, scenario.isDirectory);
      assert.equal(report.lifecycleProbe, null);
      if (scenario.status === 'misconfigured') assert.match(report.issues.join('\n'), /cacheDir/);
      else assert.deepEqual(report.issues, []);
    });
  }
});
