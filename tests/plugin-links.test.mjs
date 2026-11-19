import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveExternalPluginLink } from '../lib/plugin-links.js';

const PACKAGE = '@scope/demo';
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

/** All layout files and real package links are isolated from the user's Profile. */
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-plugin-links 空格中文-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('dsh-plugin-links 空格中文-'));
    rmSync(root, { recursive: true, force: true });
  });
  const create = (label, targetRelative, metadata) => {
    const profile = path.join(root, label, 'Profile');
    const modules = path.join(profile, 'node_modules');
    const target = path.join(root, label, targetRelative);
    mkdirSync(path.join(modules, '@scope'), { recursive: true });
    mkdirSync(target, { recursive: true });
    symlinkSync(target, path.join(modules, '@scope', 'demo'), LINK_TYPE);
    if (metadata !== undefined) {
      const text = typeof metadata === 'function' ? metadata({ profile, modules, target }) : metadata;
      writeFileSync(path.join(modules, '.modules.yaml'), text);
    }
    return { profile, modules, target };
  };
  return { root, create };
}

test('ordinary pnpm links inside the Profile, external virtual store or registered store are not local plugins', (t) => {
  const f = fixture(t);
  const scenarios = [
    { name: 'internal', target: 'Profile/node_modules/.pnpm/demo@1/node_modules/@scope/demo' },
    { name: 'external-virtual', target: 'virtual store/demo@1/node_modules/@scope/demo', metadata: ({ profile }) => JSON.stringify({
      virtualStoreDir: path.join(profile, '..', 'virtual store'), storeDir: path.join(profile, '..', 'store'),
    }) },
    { name: 'relative-virtual', target: 'virtual store/demo@1/node_modules/@scope/demo', metadata: () =>
      'virtualStoreDir: "../../virtual store"\nstoreDir: "../store"\n' },
    { name: 'relative-store', target: 'store/links/demo', metadata: () =>
      "virtualStoreDir: '.pnpm'\nstoreDir: '../store'\n" },
    { name: 'store-case', target: 'store/links/demo', metadata: ({ profile }) => JSON.stringify({
      virtualStoreDir: '.pnpm', storeDir: process.platform === 'win32' ? path.join(profile, '..', 'store').toUpperCase() : path.join(profile, '..', 'store'),
    }) },
  ];
  for (const scenario of scenarios) {
    const { profile } = f.create(scenario.name, scenario.target, scenario.metadata);
    assert.equal(resolveExternalPluginLink(profile, PACKAGE), '', scenario.name);
  }
});

test('genuine external repository junctions stay compatible with missing, JSON and YAML metadata without prefix-boundary mistakes', (t) => {
  const f = fixture(t);
  const scenarios = [
    { name: 'missing' },
    { name: 'json', metadata: ({ profile }) => JSON.stringify({ virtualStoreDir: '.pnpm', storeDir: path.join(profile, '..', 'store') }) },
    { name: 'yaml', metadata: () => 'packageManager: pnpm@9.15.0\nvirtualStoreDir: .pnpm\nstoreDir: ../store # managed store\n' },
  ];
  for (const scenario of scenarios) {
    // "store-repository" is a sibling of "store", not contained by that management root.
    const { profile, target } = f.create(scenario.name, 'store-repository/项目/demo', scenario.metadata);
    assert.equal(resolveExternalPluginLink(profile, PACKAGE), realpathSync(target), scenario.name);
  }
});

test('damaged layout metadata and non-package links fail closed rather than being certified as local', (t) => {
  const f = fixture(t);
  const scenarios = [
    ['json-truncated', '{"storeDir":'],
    ['yaml-broken-scalar', 'virtualStoreDir: .pnpm\nstoreDir: [unterminated\n'],
    ['yaml-duplicate', 'storeDir: ../first\nstoreDir: ../second\n'],
    ['yaml-invalid-root', 'storeDir: ../store\ninvalid YAML [\n'],
    ['yaml-nested-path', 'storeDir: ../store\n  nested: invalid\n'],
    ['invalid-utf8', Buffer.from([0xff, 0xfe])],
    ['missing-store', '{"virtualStoreDir":".pnpm"}'],
    ['wrong-type', '{"virtualStoreDir":42,"storeDir":"../store"}'],
    ['unresolved-root', '{"virtualStoreDir":".pnpm","storeDir":"%UNKNOWN%/store"}'],
  ];
  for (const [name, metadata] of scenarios) {
    const { profile } = f.create(name, 'external repo/demo', metadata);
    assert.equal(resolveExternalPluginLink(profile, PACKAGE), '', name);
  }
  const plainProfile = path.join(f.root, 'plain Profile');
  mkdirSync(path.join(plainProfile, 'node_modules', 'demo'), { recursive: true });
  assert.equal(resolveExternalPluginLink(plainProfile, 'demo'), '');
  assert.equal(resolveExternalPluginLink(plainProfile, '../outside'), '');
});
