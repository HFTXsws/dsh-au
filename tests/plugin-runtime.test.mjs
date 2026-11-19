import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { resolvePluginNode, resolvePluginRuntime, runPluginCommand } from '../lib/plugin-runtime.js';

/** Real isolated processes: no inherited npmrc, user HOME, Profile, PATH or package manager. */
function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'dsh-plugin-runtime 空格中文-'));
  const env = {
    HOME: directory, USERPROFILE: directory, APPDATA: path.join(directory, 'appdata'), LOCALAPPDATA: path.join(directory, 'local'),
    TMPDIR: directory, TMP: directory, TEMP: directory, PATH: '',
    SystemRoot: process.env.SystemRoot || '', ComSpec: process.env.ComSpec || '',
    npm_config_userconfig: path.join(directory, 'empty.npmrc'), npm_config_globalconfig: path.join(directory, 'empty-global.npmrc'),
    COREPACK_ENABLE_NETWORK: '0',
  };
  writeFileSync(env.npm_config_userconfig, '');
  writeFileSync(env.npm_config_globalconfig, '');
  t.after(() => {
    // Destructive cleanup is confined to the exact temp root this test created.
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('dsh-plugin-runtime 空格中文-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const write = (relative, contents) => {
    const filename = path.join(directory, relative);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, contents);
    return filename;
  };
  const copyNode = (relative) => {
    const filename = write(relative, '');
    copyFileSync(process.execPath, filename);
    if (process.platform !== 'win32') chmodSync(filename, 0o755);
    return filename;
  };
  return { directory, env, write, copyNode, options: { env, homeDir: directory, ancestorExecPaths: [] } };
}

function bundledFixture(t, { version = '11.28.5', store, installRoot, resourcesName = 'resources' } = {}) {
  const f = fixture(t);
  const relativeRoot = installRoot || '应用 安装/DSH NEXT';
  const dependencies = `${relativeRoot}/${resourcesName}/runtime/${process.arch}/primary-runtime/dependencies`;
  const node = f.copyNode(`${dependencies}/node/bin/${process.platform === 'win32' ? 'node.exe' : 'node'}`);
  const storeDir = store || path.join(f.directory, 'store', 'v11');
  const pnpm = f.write(`${dependencies}/pnpm/bin/pnpm.cjs`, `
const args = process.argv.slice(2);
if (args.includes('--version')) process.stdout.write(${JSON.stringify(version)} + '\\n');
else if (args.includes('store') && args.includes('path')) process.stdout.write(${JSON.stringify(storeDir)} + '\\n');
else { process.stderr.write('installation must not run in discovery'); process.exitCode = 93; }
`);
  const root = path.join(f.directory, relativeRoot);
  return { ...f, node, pnpm, root, storeDir, options: { ...f.options, execPath: path.join(f.directory, 'unavailable.exe'), appRoots: [root] } };
}

test('Windows production regression: native Node path with spaces and Chinese preserves arguments without a shell', (t) => {
  const f = fixture(t);
  const node = f.copyNode(`Program Files 中文/${process.platform === 'win32' ? 'node.exe' : 'node'}`);
  const script = f.write('echo 参数.cjs', 'process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));');
  const args = ['two words', '中文', 'x & echo injected', '^|<>', '%PATH%', '!bang!', '"embedded quote"', 'trailing\\'];
  const result = runPluginCommand(node, [script, ...args], { cwd: f.directory, env: f.env });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(JSON.parse(result.stdout), { args, cwd: f.directory });
  assert.equal(result.sideEffectsPossible, true);
});

test('js, cjs and mjs scripts run with a verified Node even without PATH', (t) => {
  const f = fixture(t);
  const node = f.copyNode(`Node 配套/${process.platform === 'win32' ? 'node.exe' : 'node'}`);
  for (const extension of ['js', 'cjs', 'mjs']) {
    const script = f.write(`脚本 带空格.${extension}`, 'process.stdout.write(process.argv[2]);');
    const result = runPluginCommand(script, ['中文 & literal'], { env: f.env, cwd: f.directory, nodeCommand: node });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.stdout, '中文 & literal');
  }
});

test('batch files use safe outer quoting and reject expansion-sensitive arguments before spawning', { skip: process.platform !== 'win32' }, (t) => {
  const f = fixture(t);
  const script = f.write('print.cjs', 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  // Existing cmd files are commonly ACP-encoded; ASCII contents avoid conflating source
  // encoding with the Unicode command/argument transport this regression exercises.
  const batch = f.write('批处理 路径/run.cmd', `@"${process.execPath}" "%~dp0..\\print.cjs" %*\r\n`);
  const args = ['two words', '中文', 'x & echo injected', '^|<>'];
  const result = runPluginCommand(batch, args, { cwd: f.directory, env: f.env });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(JSON.parse(result.stdout), args);
  for (const input of ['%PATH%', '!expansion!', '" & echo bad', 'line\nbreak', 'trailing\\']) {
    const rejected = runPluginCommand(batch, [input], { cwd: f.directory, env: f.env });
    assert.equal(rejected.code, 'UNSAFE_BATCH_ARGUMENT');
    assert.equal(rejected.sideEffectsPossible, false);
  }
});

test('Chinese GBK errors decode as system bytes while known Node output stays UTF-8', (t) => {
  const f = fixture(t);
  const script = f.write('gbk.cjs', 'process.stderr.write(Buffer.from([0xd6,0xd0,0xce,0xc4])); process.exitCode=7;');
  const system = runPluginCommand(process.execPath, [script], { env: f.env, outputEncoding: 'system', systemEncoding: 'gbk' });
  assert.equal(system.stderr, '中文');
  assert.equal(system.status, 7);
  assert.equal(system.code, 'COMMAND_EXIT');
  const knownNode = runPluginCommand(process.execPath, [script], { env: f.env });
  assert.match(knownNode.stderr, /\uFFFD/);
  if (process.platform === 'win32') {
    const batch = f.write('gbk 错误.cmd', `@"${process.execPath}" "%~dp0gbk.cjs"\r\n`);
    const native = runPluginCommand(batch, [], { env: f.env, systemEncoding: 'gbk' });
    assert.equal(native.stderr, '中文');
    assert.equal(native.status, 7);
  }
});

test('a real hanging child times out with its error code and possible-side-effects marker', (t) => {
  const f = fixture(t);
  const started = Date.now();
  const result = runPluginCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: f.env, timeoutMs: 200 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ETIMEDOUT');
  assert.equal(result.timedOut, true);
  assert.equal(result.sideEffectsPossible, true);
  assert.ok(Date.now() - started < 5000, 'timeout must remain bounded');
});

test('output overflow remains bounded and is a failure rather than silent success', (t) => {
  const f = fixture(t);
  const result = runPluginCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(200000))'], { env: f.env, maxOutputBytes: 4096 });
  assert.equal(result.ok, false);
  assert.equal(result.truncated, true);
  assert.equal(result.code, 'ENOBUFS');
  assert.ok(Buffer.byteLength(result.stdout + result.stderr) <= 4096);
});

test('spawn errors keep ENOENT and diagnostics redact URL credentials and query tokens', (t) => {
  const f = fixture(t);
  const missing = runPluginCommand(path.join(f.directory, 'missing.exe'), [], { env: f.env });
  assert.equal(missing.code, 'ENOENT');
  assert.equal(missing.sideEffectsPossible, false);
  const result = runPluginCommand(process.execPath, ['-e', 'process.stderr.write("GET https://user:pass@example.test/x?token=secret&ok=1");process.exitCode=1'], { env: f.env });
  for (const output of [result.stderr, result.error]) {
    assert.ok(!output.includes('user:pass'));
    assert.ok(!output.includes('token=secret'));
    assert.ok(output.includes('example.test/x'));
  }
});

test('nondefault installation roots are derived from explicit resources, ancestor exe and host metadata without PATH', (t) => {
  const f = bundledFixture(t);
  const metadata = [
    { appRoots: [path.join(f.root, 'resources')] },
    { appRoots: [], ancestorExecPaths: [path.join(f.root, 'DSH NEXT.exe')] },
    { appRoots: [], env: { ...f.env, DSH_RESOURCES_PATH: path.join(f.root, 'resources') } },
  ];
  for (const source of metadata) {
    const result = resolvePluginRuntime({ ...f.options, ...source });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.command, f.node);
    assert.deepEqual(result.args, [f.pnpm]);
    assert.equal(result.source, 'bundled');
    assert.equal(result.nodeVersion, process.versions.node);
    assert.equal(result.pnpmVersion, '11.28.5');
  }
});

test('real executable ancestry discovers a Unicode portable runtime without supplied application roots', (t) => {
  const f = bundledFixture(t);
  const moduleUrl = new URL('../lib/plugin-runtime.js', import.meta.url).href;
  const script = f.write('ancestor probe.mjs', `
import { resolvePluginRuntime } from ${JSON.stringify(moduleUrl)};
process.stdout.write(JSON.stringify(resolvePluginRuntime({env:process.env,execPath:${JSON.stringify(f.node)},homeDir:${JSON.stringify(f.directory)},ancestorExecPaths:[]})));
`);
  const result = runPluginCommand(f.node, [script], { cwd: f.directory, env: f.env, timeoutMs: 15000 });
  assert.equal(result.ok, true, result.error);
  const runtime = JSON.parse(result.stdout);
  assert.equal(runtime.ok, true, runtime.error);
  assert.equal(runtime.command, f.node);
  assert.deepEqual(runtime.args, [f.pnpm]);
});

test('macOS application resource layout and current architecture work without hardcoded install directories', (t) => {
  const f = bundledFixture(t, { installRoot: 'Portable 中文/DSH NEXT.app/Contents', resourcesName: 'Resources' });
  // Exercise the .app -> Contents/Resources derivation with native test-host processes.
  const result = resolvePluginRuntime({ ...f.options, appRoots: [path.dirname(f.root)] });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.command, f.node);
  const wrongArch = resolvePluginNode({ ...f.options, appRoots: [], nodeCandidates: [f.node], arch: process.arch === 'x64' ? 'arm64' : 'x64' });
  assert.equal(wrongArch.code, 'NODE_NOT_FOUND');
});

test('local installer resolves Node without pnpm and never launches an Electron-named executable as Node', (t) => {
  const f = fixture(t);
  const node = f.copyNode(`runtime/node/bin/${process.platform === 'win32' ? 'node.exe' : 'node'}`);
  const result = resolvePluginNode({ ...f.options, execPath: node });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.command, node);
  const electron = f.write('DSH NEXT.exe', 'this executable must never run');
  const rejected = resolvePluginNode({ ...f.options, execPath: electron });
  assert.equal(rejected.code, 'NODE_NOT_FOUND');
  const script = f.write('untrusted.cjs', 'throw new Error("must not execute")');
  assert.equal(runPluginCommand(script, [], { env: f.env, execPath: electron }).code, 'NODE_NOT_FOUND');
});

test('YAML and pnpm11 JSON module metadata accept a matching store without modifying Profile', (t) => {
  const f = bundledFixture(t);
  const profileDir = path.join(f.directory, 'Profile 隔离');
  const pkgFile = f.write('Profile 隔离/package.json', JSON.stringify({ packageManager: 'pnpm@11.28.5' }));
  for (const format of ['yaml', 'json']) {
    const modules = { packageManager: 'pnpm@11.28.5', storeDir: f.storeDir };
    const text = format === 'json' ? JSON.stringify(modules) : `packageManager: pnpm@11.28.5\nstoreDir: ${JSON.stringify(f.storeDir)}\n`;
    const modulesFile = f.write('Profile 隔离/node_modules/.modules.yaml', text);
    const before = readFileSync(pkgFile, 'utf8');
    const result = resolvePluginRuntime({ ...f.options, profileDir });
    assert.equal(result.ok, true, result.error);
    assert.equal(readFileSync(pkgFile, 'utf8'), before);
    assert.equal(readFileSync(modulesFile, 'utf8'), text);
    assert.equal(existsSync(path.join(profileDir, 'pnpm-lock.yaml')), false);
  }
});

test('incompatible pinned version, modules major and store fail before installing or altering Profile', (t) => {
  const f = bundledFixture(t);
  const scenarios = [
    { pin: 'pnpm@10.0.0', manager: 'pnpm@11.28.5', store: f.storeDir, code: 'PNPM_INCOMPATIBLE' },
    { pin: '', manager: 'pnpm@9.15.0', store: f.storeDir, code: 'PNPM_INCOMPATIBLE' },
    { pin: 'pnpm@11.28.5', manager: 'pnpm@11.28.5', store: path.join(f.directory, 'other-store'), code: 'PNPM_STORE_INCOMPATIBLE' },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const profileDir = path.join(f.directory, `Profile-${index}`);
    const packageText = JSON.stringify({ packageManager: scenario.pin });
    const modulesText = JSON.stringify({ packageManager: scenario.manager, storeDir: scenario.store });
    const packageFile = f.write(`Profile-${index}/package.json`, packageText);
    const modulesFile = f.write(`Profile-${index}/node_modules/.modules.yaml`, modulesText);
    const result = resolvePluginRuntime({ ...f.options, profileDir });
    assert.equal(result.ok, false);
    assert.equal(result.code, scenario.code, result.error);
    assert.equal(readFileSync(packageFile, 'utf8'), packageText);
    assert.equal(readFileSync(modulesFile, 'utf8'), modulesText);
  }
});

test('explicit installed pnpm override wins but an incompatible override is not silently ignored', (t) => {
  const f = bundledFixture(t);
  const override = f.write('override pnpm/pnpm.cjs', 'process.stdout.write("10.7.0\\n");');
  const env = { ...f.env, DSH_PNPM_BIN: override };
  const compatible = resolvePluginRuntime({ ...f.options, env });
  assert.equal(compatible.ok, true, compatible.error);
  assert.equal(compatible.source, 'override');
  assert.deepEqual(compatible.args, [override]);
  const profileDir = path.join(f.directory, 'Pinned');
  f.write('Pinned/package.json', JSON.stringify({ packageManager: 'pnpm@11.28.5' }));
  const incompatible = resolvePluginRuntime({ ...f.options, env, profileDir });
  assert.equal(incompatible.code, 'PNPM_INCOMPATIBLE');
});

test('missing pnpm and corepack wrappers fail without bootstrapping npm or executing a downloader', (t) => {
  const f = fixture(t);
  const node = f.copyNode(`Node/${process.platform === 'win32' ? 'node.exe' : 'node'}`);
  const marker = path.join(f.directory, 'downloader-executed');
  f.write('npm/npm.cmd', `@echo ran > "${marker}"\r\n`);
  const options = { ...f.options, execPath: node, env: { ...f.env, PATH: path.join(f.directory, 'npm') } };
  assert.equal(resolvePluginRuntime(options).code, 'PNPM_NOT_FOUND');
  const corepack = f.write('corepack/dist/pnpm.cjs', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');`);
  assert.equal(resolvePluginRuntime({ ...options, pnpmCandidates: [corepack] }).code, 'PNPM_UNVERIFIED_SHIM');
  assert.equal(existsSync(marker), false);
});

test('Windows PATH ignores POSIX shim and runs installed pnpm CLI instead of its unsafe cmd wrapper', { skip: process.platform !== 'win32' }, (t) => {
  const f = fixture(t);
  const node = f.copyNode('standalone Node/node.exe');
  const marker = path.join(f.directory, 'wrapper-executed');
  const directory = path.join(f.directory, 'npm bin');
  f.write('npm bin/pnpm', '#!/bin/sh\nexit 99\n');
  f.write('npm bin/pnpm.cmd', `@echo unsafe > "${marker}"\r\n@exit /b 99\r\n`);
  const cli = f.write('npm bin/node_modules/pnpm/bin/pnpm.cjs', 'process.stdout.write("11.28.5\\n");');
  const result = resolvePluginRuntime({ ...f.options, env: { ...f.env, PATH: directory }, execPath: node });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.source, 'external');
  assert.equal(result.command, node);
  assert.deepEqual(result.args, [cli]);
  assert.equal(existsSync(marker), false);
});
