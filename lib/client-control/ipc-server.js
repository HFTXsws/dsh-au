import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { createCodexProvider } from './codex-provider.js';
import { detectDshProfile, resolveClientControlPaths } from './paths.js';

const MAX_REQUEST_BYTES = 64 * 1024;
const ALLOWED_FIELDS = new Set(['token', 'provider', 'action', 'text', 'requestId', 'sessionId', 'cwd', 'timeoutMs']);

function rotateToken(tokenPath) {
  mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  writeFileSync(tokenPath, token, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(tokenPath, 0o600); } catch {}
  return token;
}

function readEndpointMetadata(endpointPath) {
  try {
    const value = JSON.parse(readFileSync(endpointPath, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanupStaleEndpoint(paths, platform) {
  const metadata = readEndpointMetadata(paths.endpointPath);
  if (metadata?.endpoint === paths.endpoint && processIsAlive(Number(metadata.pid))) {
    throw new Error(`Client-control endpoint is already owned by process ${metadata.pid}`);
  }
  rmSync(paths.endpointPath, { force: true });
  // Only unlink a Unix socket when stale metadata proves it belonged to this endpoint.
  if (platform !== 'win32' && metadata?.endpoint === paths.endpoint) {
    rmSync(paths.endpoint, { force: true });
  }
}

function validateRequest(body, token) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid request');
  if (Object.keys(body).some((key) => !ALLOWED_FIELDS.has(key))) throw new Error('Unsupported request field');
  if (body.token !== token) throw new Error('Unauthorized');
  if (body.provider !== 'codex') throw new Error('IPC currently supports provider=codex only');
  if (!['capabilities', 'prompt'].includes(body.action)) throw new Error('Unsupported action');
}

export function createClientControlIpcServer({
  ctx,
  homeDir = homedir(),
  dshHome,
  profile = detectDshProfile(),
  platform = process.platform,
} = {}) {
  const paths = resolveClientControlPaths({ homeDir, dshHome, profile, platform });
  let token = '';
  const provider = createCodexProvider({ ctx, stateDir: paths.codexStateDir });
  let server = null;

  async function dispatch(body) {
    validateRequest(body, token);
    if (body.action === 'capabilities') {
      return { ok: true, provider: 'codex', actions: ['prompt'], transport: platform === 'win32' ? 'named-pipe' : 'unix-socket' };
    }
    if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(body.requestId)) {
      throw new Error('Invalid requestId');
    }
    if (typeof body.text !== 'string' || !body.text.trim()) throw new Error('Prompt must be nonempty');
    if (Buffer.byteLength(body.text, 'utf8') > 60 * 1024) throw new Error('Prompt exceeds 60 KiB');
    if (body.cwd !== undefined) {
      if (typeof body.cwd !== 'string' || !body.cwd || !existsSync(body.cwd) || !statSync(body.cwd).isDirectory()) throw new Error('cwd must be an existing directory');
    }
    return provider.prompt({
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
      cwd: typeof body.cwd === 'string' ? body.cwd : '',
      text: body.text,
      requestId: body.requestId,
      timeoutMs: Math.min(Number(body.timeoutMs) || 180_000, 600_000),
    });
  }

  function start() {
    if (server) return Promise.resolve(paths);
    mkdirSync(paths.baseDir, { recursive: true, mode: 0o700 });
    try { chmodSync(paths.baseDir, 0o700); } catch {}
    if (platform !== 'win32') {
      mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
      try { chmodSync(paths.runtimeDir, 0o700); } catch {}
    }
    cleanupStaleEndpoint(paths, platform);
    server = createServer((socket) => {
      let raw = '';
      let handled = false;
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        if (handled) return;
        raw += chunk;
        if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
          handled = true;
          socket.end(`${JSON.stringify({ ok: false, error: 'Request too large' })}\n`);
          return;
        }
        const newline = raw.indexOf('\n');
        if (newline < 0) return;
        handled = true;
        const frame = raw.slice(0, newline);
        if (raw.slice(newline + 1).trim()) {
          socket.end(`${JSON.stringify({ ok: false, error: 'Only one request frame is allowed' })}\n`);
          return;
        }
        let request;
        try {
          request = JSON.parse(frame);
        } catch {
          socket.end(`${JSON.stringify({ ok: false, error: 'Invalid JSON request' })}\n`);
          return;
        }
        void dispatch(request).then(
          (result) => socket.end(`${JSON.stringify(result)}\n`),
          (error) => socket.end(`${JSON.stringify({ ok: false, error: error?.message || 'Client control failed' })}\n`),
        );
      });
      socket.on('end', () => {
        if (!handled) socket.end(`${JSON.stringify({ ok: false, error: 'Incomplete request frame' })}\n`);
      });
      socket.on('error', () => {});
    });
    return new Promise((resolve, reject) => {
      const active = server;
      const fail = (error) => {
        if (server === active) server = null;
        reject(error);
      };
      active.once('error', fail);
      active.listen(paths.endpoint, () => {
        active.off('error', fail);
        try {
          if (platform !== 'win32') chmodSync(paths.endpoint, 0o600);
          // Rotate only after the endpoint is owned, so a failed second instance cannot invalidate the live token.
          token = rotateToken(paths.tokenPath);
          writeFileSync(paths.endpointPath, `${JSON.stringify({
            schemaVersion: 1,
            endpoint: paths.endpoint,
            tokenPath: paths.tokenPath,
            profile,
            platform,
            pid: process.pid,
          }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
          try { chmodSync(paths.endpointPath, 0o600); } catch {}
          resolve(paths);
        } catch (error) {
          token = '';
          rmSync(paths.tokenPath, { force: true });
          if (platform !== 'win32') rmSync(paths.endpoint, { force: true });
          active.close(() => {});
          fail(error);
        }
      });
    });
  }

  function close() {
    const active = server;
    server = null;
    return new Promise((resolve) => {
      if (!active) return resolve();
      active.close(() => {
        const metadata = readEndpointMetadata(paths.endpointPath);
        if (metadata?.pid === process.pid && metadata?.endpoint === paths.endpoint) {
          if (platform !== 'win32') rmSync(paths.endpoint, { force: true });
          rmSync(paths.endpointPath, { force: true });
          rmSync(paths.tokenPath, { force: true });
        }
        token = '';
        resolve();
      });
    });
  }

  return { start, close, paths, dispatch };
}
