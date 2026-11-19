import { createHash } from 'node:crypto';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';

function safeIdentity(value, fallback) {
  const normalized = String(value || '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+$/, '');
  return normalized || fallback;
}

export function detectDshProfile({ env = process.env, argv = process.argv } = {}) {
  const configured = safeIdentity(env.DSH_PROFILE, '');
  if (configured) return configured;
  for (const value of argv || []) {
    if (typeof value !== 'string' || !value) continue;
    if (basename(dirname(value)).toLowerCase() !== 'profiles') continue;
    const candidate = safeIdentity(basename(value), '');
    if (candidate) return candidate;
  }
  return 'desktop';
}

/** Keep each DSH profile's capability token and endpoint metadata isolated. */
export function clientControlProfileDirectory(profile = detectDshProfile()) {
  const raw = String(profile || 'desktop');
  const label = safeIdentity(raw, 'desktop').slice(0, 48);
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 10);
  return `${label}-${hash}`;
}

export function resolveClientControlPaths({
  homeDir = homedir(),
  dshHome = process.env.DSH_HOME || join(homeDir, '.dsh'),
  profile = detectDshProfile(),
  platform = process.platform,
  temporaryDirectory = tmpdir(),
} = {}) {
  const profileDir = clientControlProfileDirectory(profile);
  const rootDir = join(dshHome, 'dsh-au', 'client-control');
  const baseDir = join(rootDir, profileDir);
  const suffix = createHash('sha256').update(`${dshHome}\0${profile}`).digest('hex').slice(0, 16);
  let uid = 'user';
  try { uid = safeIdentity(userInfo().uid ?? userInfo().username, 'user'); } catch {}
  const runtimeDir = join(temporaryDirectory, `dsh-au-${uid}`);
  return {
    rootDir,
    baseDir,
    profileDir,
    runtimeDir,
    tokenPath: join(baseDir, 'capability.token'),
    endpointPath: join(baseDir, 'endpoint-v1.json'),
    codexStateDir: join(baseDir, 'codex-requests'),
    endpoint: platform === 'win32'
      ? `\\\\.\\pipe\\dsh-au-client-control-v1-${suffix}`
      : join(runtimeDir, `cc-${suffix}.sock`),
  };
}
