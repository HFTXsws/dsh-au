import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MODULES, build, orphanSources, outFile, writeClientIfChanged } from '../scripts/build-client.js';

const buildScript = fileURLToPath(new URL('../scripts/build-client.js', import.meta.url));

test('client/client.js 与 client/src 源文件一致', () => {
  // 产物提交进 git，DSH 直接加载它；源文件改完忘记重建会在这里失败。
  assert.equal(readFileSync(outFile, 'utf8'), build());
});

test('client/src 下没有漏登记的片段', () => {
  assert.deepEqual(orphanSources(), []);
});

test('build-client.js --check 在产物最新时通过', () => {
  const stdout = execFileSync(process.execPath, [buildScript, '--check'], { encoding: 'utf8' });
  assert.match(stdout, /一致/);
});

test('bundle 保持 ModuleLoader 入口、dsh-au 标识与逐片段 region 标记', () => {
  const code = readFileSync(outFile, 'utf8');
  assert.match(code, /^\/\/ 本文件由 scripts\/build-client\.js/);
  assert.match(code, /window\.__ModuleLoader__\.load\(\{/);
  assert.match(code, /id: 'dsh-au'/);
  assert.match(code, /return \{ name: 'dsh-au', inject, apply, mobile: mobileClient\.helpers, shortcuts: shortcutHelpers \};/);
  // region 标记让 bundle 里每一段都能回溯到 client/src 下的来源文件。
  for (const [file] of MODULES) {
    assert.ok(code.includes(`//#region src/${file}`), `缺少 ${file} 的 region 标记`);
  }
});

test('拼接后的 bundle 能被 ModuleLoader 真实加载并导出 name/inject/apply', () => {
  const code = readFileSync(outFile, 'utf8');
  let definition = null;
  new Function('window', code)({ __ModuleLoader__: { load: (def) => { definition = def; } } });
  assert.equal(definition?.id, 'dsh-au');
  const fakeReact = {
    createElement: () => ({}),
    Fragment: Symbol('Fragment'),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
  };
  const mod = definition.factory((id) => {
    if (id === 'react') return fakeReact;
    if (id === 'react-dom') return { createPortal: () => ({}) };
    throw new Error(`未预期的 require：${id}`);
  });
  // 片段被拼接进同一个 factory 作用域，顶层缺引用会在这里直接抛错。
  assert.equal(mod.name, 'dsh-au');
  // remote / remote.settings 必须声明，否则受控页同步默认权限时宿主抛 “without inject”。
  assert.deepEqual(mod.inject, ['slots', 'layout', 'shortcuts', 'uiWorkspace', 'sessions', 'remote', 'remote.settings']);
  assert.equal(typeof mod.apply, 'function');
  assert.equal(typeof mod.mobile.isMobileViewport, 'function');
});

function temporaryBuildDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-au-client-build-'));
  t.after(() => {
    // 只清理本测试创建的临时目录，先核对解析后的目标，绝不清理实际插件目录。
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('dsh-au-client-build-'));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function fileMetadata(target) {
  const stats = statSync(target, { bigint: true });
  return { mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs, size: stats.size };
}

function markHistoricalModification(target) {
  // 固定历史 mtime 让误写必然可见，不依赖随机 sleep 或文件系统时钟精度。
  const historical = new Date('2000-01-01T00:00:00Z');
  utimesSync(target, historical, historical);
}

// 2026-10-28：相同 bundle 被重写后，宿主 stat-poll HMR 同时卸载 mac/win，打断输入。
test('incident 2026-10-28: unchanged client output preserves metadata while changed or missing output is written', (t) => {
  const directory = temporaryBuildDirectory(t);
  const target = join(directory, 'client.js');
  const original = 'const greeting = "你好";\n';
  assert.equal(writeClientIfChanged(original, target), true, '缺失的输出仍能创建');
  assert.equal(readFileSync(target, 'utf8'), original);
  markHistoricalModification(target);
  const before = fileMetadata(target);

  assert.equal(writeClientIfChanged(original, target), false);
  assert.deepEqual(fileMetadata(target), before, '无变化不得触碰 mtime/ctime/size');
  assert.equal(readFileSync(target, 'utf8'), original);

  const changed = 'const greeting = "你好，新的构建";\n';
  assert.equal(writeClientIfChanged(changed, target), true);
  assert.equal(readFileSync(target, 'utf8'), changed);
  assert.equal(fileMetadata(target).size, BigInt(Buffer.byteLength(changed, 'utf8')));
  assert.notEqual(fileMetadata(target).mtimeNs, before.mtimeNs);
});

test('isolated build CLI skips unchanged output and --check never writes current or stale output', async (t) => {
  const directory = temporaryBuildDirectory(t);
  const fixtureScript = join(directory, 'scripts', 'build-client.js');
  mkdirSync(dirname(fixtureScript), { recursive: true });
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}', 'utf8');
  writeFileSync(fixtureScript, readFileSync(buildScript, 'utf8'), 'utf8');
  const fixture = await import(pathToFileURL(fixtureScript).href);
  mkdirSync(fixture.srcDir, { recursive: true });
  // 以复制脚本的 MODULES 为准，避免主代理同时添加片段时与导入快照发生漂移。
  for (const [file] of fixture.MODULES) writeFileSync(join(fixture.srcDir, file), `// 临时片段 ${file}\n`, 'utf8');
  const expected = fixture.build();

  for (const [scenario, args, stale, status, shouldWrite] of [
    ['普通构建无变化', [], false, 0, false],
    ['--check 当前产物', ['--check'], false, 0, false],
    ['--check 过期产物', ['--check'], true, 1, false],
    ['普通构建真变化', [], true, 0, true],
  ]) {
    await t.test(scenario, () => {
      const initial = stale ? '// 旧的临时产物\n' : expected;
      writeFileSync(fixture.outFile, initial, 'utf8');
      markHistoricalModification(fixture.outFile);
      const before = fileMetadata(fixture.outFile);
      const result = spawnSync(process.execPath, [fixtureScript, ...args], { encoding: 'utf8' });
      assert.equal(result.error, undefined);
      assert.equal(result.status, status, result.stderr);
      assert.equal(readFileSync(fixture.outFile, 'utf8'), shouldWrite ? expected : initial);
      if (shouldWrite) assert.notEqual(fileMetadata(fixture.outFile).mtimeNs, before.mtimeNs);
      else assert.deepEqual(fileMetadata(fixture.outFile), before, 'CLI 不应触碰不需要更新的产物');
      if (!args.length) assert.match(result.stdout, shouldWrite ? /已生成/ : /未变化/);
    });
  }
});
