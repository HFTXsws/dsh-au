/** Distinguish genuine external local-package links from package-manager layout links. */
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

const METADATA_LIMIT = 1024 * 1024;
const PACKAGE_NAME = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;

function canonical(filename) {
  try { return realpathSync(filename); }
  catch (error) {
    // A not-yet-created store has a usable lexical boundary; unreadable roots do not.
    if (error.code === 'ENOENT') return path.resolve(filename);
    throw error;
  }
}

function contains(root, target) {
  const normalize = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  const relative = path.relative(normalize(root), normalize(target));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/** Read only layout scalars, not arbitrary npmrc/config or a general YAML object graph. */
function yamlScalar(raw) {
  const value = raw.trim();
  if (value.startsWith('"')) {
    const match = value.match(/^("(?:[^"\\]|\\.)*")(?:[ \t]+#.*)?$/);
    if (!match) throw new Error('Invalid quoted layout path');
    return JSON.parse(match[1]);
  }
  if (value.startsWith("'")) {
    const match = value.match(/^'((?:[^']|'')*)'(?:[ \t]+#.*)?$/);
    if (!match) throw new Error('Invalid quoted layout path');
    return match[1].replace(/''/g, "'");
  }
  if (!value || /^[\[{&*!|>]/.test(value) || /:\s/.test(value)) throw new Error('Invalid layout scalar');
  const plain = value.replace(/[ \t]+#.*$/, '').trim();
  if (/^(?:null|true|false|~|[-+]?\d+(?:\.\d+)?)$/i.test(plain)) throw new Error('Layout path must be a string');
  return plain;
}

function readLayout(modulesDir) {
  const filename = path.join(modulesDir, '.modules.yaml');
  let metadata;
  try { metadata = lstatSync(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  // A present but damaged/redirected metadata file must not certify an external link.
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > METADATA_LIMIT) throw new Error('Invalid layout metadata');
  const bytes = readFileSync(filename);
  if (bytes.length > METADATA_LIMIT) throw new Error('Layout metadata exceeds limit');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  let layout;
  if (text.trimStart().startsWith('{')) {
    layout = JSON.parse(text);
    if (!layout || Array.isArray(layout) || typeof layout !== 'object') throw new Error('Invalid layout metadata');
  } else {
    layout = {};
    const keys = new Set();
    let layoutScalar = false;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim() || /^\s*#/.test(line) || /^(?:---|\.\.\.)\s*$/.test(line)) continue;
      if (/^\t/.test(line)) throw new Error('Invalid YAML indentation');
      if (/^ /.test(line)) {
        if (layoutScalar) throw new Error('Layout scalar cannot have nested YAML values');
        continue;
      }
      const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]*(.*))?$/);
      if (!match || keys.has(match[1])) throw new Error('Invalid or duplicate YAML layout key');
      keys.add(match[1]);
      layoutScalar = ['virtualStoreDir', 'storeDir'].includes(match[1]);
      if (layoutScalar) layout[match[1]] = yamlScalar(match[2] || '');
    }
  }
  // storeDir is present in pnpm's modules manifest. Without it an external store cannot
  // be excluded safely. Older metadata may omit virtualStoreDir: use pnpm's default.
  if (typeof layout.storeDir !== 'string' || !layout.storeDir.trim() ||
    (layout.virtualStoreDir !== undefined && (typeof layout.virtualStoreDir !== 'string' || !layout.virtualStoreDir.trim()))) {
    throw new Error('Missing or invalid layout roots');
  }
  return layout;
}

function layoutRoot(base, value) {
  // Metadata paths are already expanded; do not guess environment/home placeholders or
  // Windows drive-relative paths, which could silently select a different working drive.
  if (/^(?:~(?:[\\/]|$)|[A-Za-z]:(?:$|[^\\/]))/.test(value) || /\$\{|%[^%]+%/.test(value)) throw new Error('Unresolved layout root');
  return canonical(path.resolve(base, value));
}

/**
 * Return the real absolute target of a genuine external package-directory link, or ''.
 * Missing metadata retains historical external-junction compatibility; unreadable or
 * malformed metadata fails closed. Never modifies Profile, links, store or config.
 */
export function resolveExternalPluginLink(profileDir, packageName) {
  if (typeof profileDir !== 'string' || !profileDir || typeof packageName !== 'string' ||
    !PACKAGE_NAME.test(packageName) || packageName.split('/').some((part) => part === '.' || part === '..')) return '';
  try {
    const profile = realpathSync(profileDir);
    const modules = canonical(path.join(profile, 'node_modules'));
    const packagePath = path.join(modules, ...packageName.split('/'));
    if (!lstatSync(packagePath).isSymbolicLink()) return '';
    const target = realpathSync(packagePath);
    if (!statSync(target).isDirectory() || contains(modules, target)) return '';
    const layout = readLayout(modules);
    if (layout) {
      // virtualStoreDir is relative to node_modules; storeDir follows the project root.
      const virtualStore = layoutRoot(modules, layout.virtualStoreDir || '.pnpm');
      const store = layoutRoot(profile, layout.storeDir);
      if (contains(virtualStore, target) || contains(store, target)) return '';
    }
    return target;
  } catch { return ''; }
}
