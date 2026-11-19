import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { syncBootStartupEntry } from '../lib/background-services.js';
import { inspectLocalServiceManagement, runLocalServicesDoctor } from '../lib/service-doctor.js';

const CLI_PATH = fileURLToPath(new URL('../scripts/doctor.mjs', import.meta.url));
const EMPTY_PATH_ENV = { PATH: '', PATHEXT: '.EXE' };

// 即使旧实现误读默认配置，也只能接触本测试的临时目录，不能遍历生产绑定。
async function withIsolatedEnv(run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-au-doctor-paths-'));
  const overrides = {
    DSH_AU_LOCAL_DIR: path.join(dir, 'local'),
    DSH_AU_LOCAL_BINDINGS_PATH: path.join(dir, 'bindings.json'),
    DSH_AU_MACHINES_DIR: path.join(dir, 'machines'),
    DSH_AU_LOCAL_POINTER_PATH: path.join(dir, 'local', 'active.json'),
    DSH_AU_LOCAL_STATE_PATH: path.join(dir, 'local', 'state.json'),
    DSH_AU_CONFIG_PATH: path.join(dir, 'dsh-au.config.json'),
    DSH_AU_CLOUD_MANIFEST_PATH: path.join(dir, 'manifest.cloud.json'),
    DSH_AU_STARTUP_DIR: path.join(dir, 'startup'),
    DSH_AU_PID_DIR: path.join(dir, 'pids'),
  };
  const previous = Object.keys(overrides).map((key) => [key, process.env[key]]);
  try {
    Object.assign(process.env, overrides);
    // 无服务绑定保证旧实现未加入口防护时，也不会启动任何生命周期探针。
    writeFileSync(overrides.DSH_AU_LOCAL_BINDINGS_PATH, JSON.stringify({ machineId: 'doctor-paths-test', services: {} }));
    writeFileSync(overrides.DSH_AU_CLOUD_MANIFEST_PATH, JSON.stringify({ schemaVersion: 1, services: {}, devices: [] }));
    return await run(dir);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // dir 始终是本函数刚创建的绝对临时目录，不清理任何宿主目录。
    rmSync(dir, { recursive: true, force: true });
  }
}

function inspectionOptions(dir, service, extra = {}) {
  return {
    bindingsData: {
      filePath: path.join(dir, 'bindings.json'),
      machineId: 'doctor-paths-test',
      services: { doctor_paths_fixture: { name: 'Doctor 路径测试', ...service } },
    },
    stateData: { services: {} },
    profile: { enabled: [], autoStartOnBoot: [], autoStartOnDsh: [] },
    skipNetworkProbe: true,
    env: EMPTY_PATH_ENV,
    ...extra,
  };
}

function writeNodeScript(dir) {
  const scriptPath = path.join(dir, 'worker.mjs');
  writeFileSync(scriptPath, '// 静态体检 fixture：不监听端口、不启动服务。\n', 'utf8');
  return scriptPath;
}

// 回归：存在且后缀合法的目录不能冒充可纳管脚本，无后缀目录也一样。
test('scriptPath 指向目录时按文件类型拒绝纳管，不因后缀获得 managed 状态', async (t) => {
  await withIsolatedEnv(async (dir) => {
    for (const suffix of ['.mjs', '.sh', '']) {
      await t.test(`目录后缀 ${suffix || '(无后缀)'}`, async () => {
        const scriptPath = path.join(dir, `script-directory${suffix}`);
        mkdirSync(scriptPath);
        const report = await inspectLocalServiceManagement('doctor_paths_fixture', inspectionOptions(dir, { scriptPath }));
        assert.equal(report.status, 'misconfigured');
        assert.equal(report.lifecycleFullyManaged, false);
        assert.equal(report.scriptPath.exists, true);
        assert.equal(report.scriptPath.isFile, false);
        assert.match(report.issues.join('\n'), /目录/);
      });
    }
  });
});

test('缺失脚本或不支持的 scriptPath 格式均报告配置错误，而不是静态纳管或纯监控', async (t) => {
  await withIsolatedEnv(async (dir) => {
    const cases = [
      { name: '缺失的 Node 脚本', fileName: 'missing.mjs', create: false, exists: false, isFile: false },
      { name: '现有 JSON 数据文件', fileName: 'settings.json', create: true, exists: true, isFile: true },
      { name: '现有未知格式文件', fileName: 'worker.unsupported', create: true, exists: true, isFile: true },
    ];
    for (const item of cases) {
      await t.test(item.name, async () => {
        const scriptPath = path.join(dir, item.fileName);
        if (item.create) writeFileSync(scriptPath, '{}\n', 'utf8');
        const report = await inspectLocalServiceManagement('doctor_paths_fixture', inspectionOptions(dir, { scriptPath }));
        assert.equal(report.status, 'misconfigured');
        assert.equal(report.lifecycleFullyManaged, false);
        assert.equal(report.scriptPath.exists, item.exists);
        assert.equal(report.scriptPath.isFile, item.isFile);
        assert.ok(report.issues.length > 0);
      });
    }
  });
});

test('现有普通 Node 脚本无探针仍为静态 managed，空 PATH 不影响宿主 Node 解释器', async () => {
  await withIsolatedEnv(async (dir) => {
    const scriptPath = writeNodeScript(dir);
    const report = await inspectLocalServiceManagement('doctor_paths_fixture', inspectionOptions(dir, { scriptPath }));
    assert.equal(report.status, 'managed');
    assert.equal(report.lifecycleFullyManaged, true);
    assert.equal(report.scriptPath.isFile, true);
    assert.equal(report.health.running, null);
    assert.equal(report.lifecycleProbe, null);
    assert.equal(report.execution.command, process.execPath);
    assert.equal(report.execution.resolved, process.execPath);
    assert.equal(report.execution.exists, true);
    assert.deepEqual(report.issues, []);
  });
});

test('configPath 指向目录时只报告路径类型错误，并阻止完整纳管', async (t) => {
  await withIsolatedEnv(async (dir) => {
    const scriptPath = writeNodeScript(dir);
    for (const suffix of ['.json', '.yaml', '']) {
      await t.test(`配置目录后缀 ${suffix || '(无后缀)'}`, async () => {
        const configPath = path.join(dir, `config-directory${suffix}`);
        mkdirSync(configPath);
        const report = await inspectLocalServiceManagement('doctor_paths_fixture', inspectionOptions(dir, { scriptPath, configPath }));
        assert.equal(report.status, 'misconfigured');
        assert.equal(report.lifecycleFullyManaged, false);
        assert.equal(report.configPaths.length, 1);
        assert.equal(report.configPaths[0].raw, configPath);
        assert.equal(report.configPaths[0].resolved, configPath);
        assert.equal(report.configPaths[0].exists, true);
        assert.equal(report.configPaths[0].isFile, false);
        assert.equal(report.configPaths[0].isDirectory, true);
        const issues = report.issues.join('\n');
        assert.match(issues, /configPath/);
        assert.match(issues, /目录/);
      });
    }
  });
});

test('configPath 是普通文件时只检查 stat，不因配置内容不是合法 JSON 阻止静态纳管', async () => {
  await withIsolatedEnv(async (dir) => {
    const scriptPath = writeNodeScript(dir);
    const configPath = path.join(dir, 'settings.json');
    // 故意不能 JSON.parse：Doctor 的路径检查不应读取或解析配置内容。
    writeFileSync(configPath, 'not-json: [\n', 'utf8');
    const report = await inspectLocalServiceManagement('doctor_paths_fixture', inspectionOptions(dir, { scriptPath, configPath }));
    assert.equal(report.status, 'managed');
    assert.equal(report.lifecycleFullyManaged, true);
    assert.equal(report.configPaths.length, 1);
    assert.equal(report.configPaths[0].raw, configPath);
    assert.equal(report.configPaths[0].resolved, configPath);
    assert.equal(report.configPaths[0].exists, true);
    assert.equal(report.configPaths[0].isFile, true);
    assert.equal(report.configPaths[0].isDirectory, false);
    assert.deepEqual(report.issues, []);
  });
});

test('Shell 脚本存在但隔离 PATH 内找不到解释器时为 misconfigured', async () => {
  await withIsolatedEnv(async (dir) => {
    const scriptPath = path.join(dir, 'worker.sh');
    writeFileSync(scriptPath, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
    const report = await inspectLocalServiceManagement('doctor_paths_fixture', inspectionOptions(
      dir,
      { scriptPath },
      { platform: 'linux', env: { PATH: '', PATHEXT: '.EXE' } },
    ));
    assert.equal(report.scriptPath.exists, true);
    assert.equal(report.scriptPath.isFile, true);
    assert.equal(report.execution.command, 'bash');
    assert.equal(report.execution.exists, false);
    assert.equal(report.status, 'misconfigured');
    assert.equal(report.lifecycleFullyManaged, false);
    assert.ok(report.issues.length > 0);
  });
});

test('仅填写合法 health 的监控条目仍为 monitor-only，不将空 scriptPath 误报为配置错误', async () => {
  await withIsolatedEnv(async (dir) => {
    const report = await inspectLocalServiceManagement('doctor_paths_fixture', inspectionOptions(dir, {
      health: 'http://127.0.0.1:1/health',
    }));
    assert.equal(report.status, 'monitor-only');
    assert.equal(report.lifecycleFullyManaged, false);
    assert.equal(report.scriptPath.raw, '');
    assert.equal(report.health.running, null);
    assert.equal(report.lifecycleProbe, null);
    assert.deepEqual(report.issues, []);
  });
});

test('缺少 --service 的 lifecycle API 请求在读取本机选项前拒绝，且不创建本机状态', async (t) => {
  await withIsolatedEnv(async (dir) => {
    const before = readdirSync(dir, { recursive: true }).sort();
    const cases = [
      { name: '裸 probeLifecycle 请求', options: { probeLifecycle: true } },
      {
        name: '本机选项不可读取的请求',
        options: {
          probeLifecycle: true,
          get hostname() {
            throw new Error('本机 hostname 在入口校验前被读取');
          },
        },
      },
    ];
    for (const item of cases) {
      await t.test(item.name, async () => {
        await assert.rejects(() => runLocalServicesDoctor(item.options), /--service/);
        assert.deepEqual(readdirSync(dir, { recursive: true }).sort(), before);
      });
    }
  });
});

test('CLI lifecycle 服务选择缺失、为空或重复时退出 2，不读取绑定或启停服务', async (t) => {
  await withIsolatedEnv(async (dir) => {
    const before = readdirSync(dir, { recursive: true }).sort();
    const cases = [
      { name: '裸 --probe-lifecycle', args: ['--probe-lifecycle'] },
      { name: '空 --service=', args: ['--probe-lifecycle', '--service='] },
      { name: '--service 后误接选项', args: ['--probe-lifecycle', '--service', '--json'] },
      { name: '重复 --service 指向不同 id', args: ['--service', 'a', '--service', 'b', '--probe-lifecycle'] },
    ];
    for (const item of cases) {
      await t.test(item.name, () => {
        const result = spawnSync(process.execPath, [CLI_PATH, ...item.args], {
          env: { ...process.env, ...EMPTY_PATH_ENV },
          encoding: 'utf8',
          windowsHide: true,
          timeout: 10_000,
        });
        assert.ifError(result.error);
        assert.equal(result.signal, null);
        assert.equal(result.status, 2);
        assert.match(result.stderr, /--service/);
        assert.deepEqual(readdirSync(dir, { recursive: true }).sort(), before);
      });
    }
  });
});

// 回归：目录自带的 ~/ launchd plist 存在时，实际原生通路不能被合法 scriptPath 抢走。
test('macOS 目录服务的家目录 plist 存在时优先报告 launchd 与 launchctl，不选择 Node 脚本通路', async () => {
  await withIsolatedEnv(async (dir) => {
    const home = path.join(dir, 'home');
    const launchAgents = path.join(home, 'Library', 'LaunchAgents');
    const binDir = path.join(dir, 'bin');
    mkdirSync(launchAgents, { recursive: true });
    mkdirSync(binDir);
    writeFileSync(path.join(launchAgents, 'com.example.antigravity-gateway.plist'), '<plist version="1.0"><dict/></plist>\n', 'utf8');
    const fakeLaunchctl = path.join(binDir, 'launchctl');
    writeFileSync(fakeLaunchctl, '#!/bin/sh\nexit 99\n', 'utf8');
    chmodSync(fakeLaunchctl, 0o755);
    const scriptPath = writeNodeScript(dir);
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousCwd = process.cwd();
    try {
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      assert.equal(homedir(), home, '家目录必须指向本测试的真实临时目录');
      // 相对 PATH 避免 Windows 盘符冒号被模拟 macOS 的 PATH 分隔规则拆开。
      process.chdir(dir);
      const report = await inspectLocalServiceManagement('antigravity', {
        bindingsData: {
          filePath: path.join(dir, 'bindings.json'),
          machineId: 'doctor-paths-test',
          services: { antigravity: { scriptPath, configPath: '', launcher: { label: 'com.example.antigravity-gateway' } } },
        },
        stateData: { services: {} },
        profile: { enabled: [], autoStartOnBoot: [], autoStartOnDsh: [] },
        platform: 'darwin',
        skipNetworkProbe: true,
        env: { PATH: 'bin', PATHEXT: '.EXE' },
      });
      assert.equal(report.controlChannel, 'launchd');
      assert.equal(report.execution.command, 'launchctl');
      assert.equal(report.execution.exists, true);
      assert.equal(path.resolve(report.execution.resolved), fakeLaunchctl);
      assert.equal(report.health.running, null);
      assert.equal(report.lifecycleProbe, null);
    } finally {
      process.chdir(previousCwd);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  });
});

test('macOS 临时 Startup 体检跳过目录服务的真实 launchctl，且不生成自启文件', async () => {
  await withIsolatedEnv(async (dir) => {
    const emptyBinDir = path.join(dir, 'empty-bin');
    mkdirSync(emptyBinDir);
    const previousPath = process.env.PATH;
    try {
      // 即使跳过门禁回归，也只能在空目录查找命令，绝不接触宿主 launchctl。
      process.env.PATH = emptyBinDir;
      writeFileSync(process.env.DSH_AU_LOCAL_BINDINGS_PATH, JSON.stringify({
        machineId: 'doctor-paths-test',
        services: { antigravity: { name: 'Antigravity', launcher: { label: 'com.example.antigravity-gateway' } } },
      }));
      const report = await syncBootStartupEntry('doctor-paths-test', {
        enabled: ['antigravity'],
        autoStartOnBoot: ['antigravity'],
      }, 'darwin');
      assert.equal(report.synced, true);
      assert.deepEqual(report.launchd, [{ id: 'antigravity', autoStartOnBoot: true, ok: true, skipped: true }]);
      assert.equal(path.dirname(report.filePath), process.env.DSH_AU_STARTUP_DIR);
      assert.equal(existsSync(report.filePath), false);
      assert.equal(existsSync(process.env.DSH_AU_STARTUP_DIR), false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});
