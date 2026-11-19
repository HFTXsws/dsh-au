import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { loadClaudeLog } from './claude-log.js'
import { ClientControlError, assertControl } from './errors.js'

export function claudeProjectsRoot(homeDir = homedir()) {
  return join(homeDir, '.claude', 'projects')
}

export function projectSlug(projectDir) {
  return resolve(projectDir).replace(/[^A-Za-z0-9_-]/g, '-')
}

export function listClaudeProjectDirectories(homeDir = homedir()) {
  const root = claudeProjectsRoot(homeDir)
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ slug: entry.name, path: join(root, entry.name) }))
}

function comparablePath(value) {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function projectDirectoryMatches(directory, projectDir) {
  const expected = comparablePath(projectDir)
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.jsonl')) continue
    try {
      const { records } = loadClaudeLog(join(directory, name))
      if (records.some((record) => typeof record.cwd === 'string'
        && comparablePath(record.cwd) === expected)) return true
    } catch {
      // A damaged unrelated session must not hide other valid project candidates.
    }
  }
  return false
}

export function resolveClaudeProjectDirectory(projectDir, {
  homeDir = homedir(),
  allowMissing = false
} = {}) {
  const absoluteProject = resolve(projectDir)
  const directories = listClaudeProjectDirectories(homeDir)
  const contentMatches = directories.filter((entry) => projectDirectoryMatches(entry.path, absoluteProject))
  if (contentMatches.length > 1) {
    throw new ClientControlError('Multiple Claude project directories match the requested cwd', {
      code: 'AMBIGUOUS_PROJECT'
    })
  }
  if (contentMatches.length === 1) return contentMatches[0].path

  const expectedSlug = projectSlug(absoluteProject)
  const slugMatches = directories.filter((entry) => entry.slug === expectedSlug)
  if (slugMatches.length === 1) return slugMatches[0].path
  if (allowMissing) return join(claudeProjectsRoot(homeDir), expectedSlug)
  throw new ClientControlError(`Claude project directory not found for: ${absoluteProject}`, {
    code: 'PROJECT_NOT_FOUND'
  })
}

export function resolveClaudeSessionLog({
  sessionLog,
  sessionId,
  projectDir,
  homeDir = homedir()
} = {}) {
  if (sessionLog) {
    const absolute = resolve(sessionLog)
    assertControl(existsSync(absolute) && statSync(absolute).isFile(),
      `Claude session log not found: ${absolute}`, 'SESSION_NOT_FOUND')
    return absolute
  }
  assertControl(typeof sessionId === 'string' && /^[0-9a-fA-F-]{36}$/.test(sessionId),
    'Provide --session-log or a UUID --session-id', 'INVALID_ARGUMENT')

  const directories = projectDir
    ? [{ path: resolveClaudeProjectDirectory(projectDir, { homeDir }) }]
    : listClaudeProjectDirectories(homeDir)
  const matches = directories
    .map((entry) => join(entry.path, `${sessionId}.jsonl`))
    .filter(existsSync)
  assertControl(matches.length > 0, `Claude session not found: ${sessionId}`, 'SESSION_NOT_FOUND')
  assertControl(matches.length === 1,
    `Claude session exists in multiple project directories: ${sessionId}`, 'AMBIGUOUS_SESSION')
  return matches[0]
}

export function listSessionLogs(projectDirectory) {
  if (!existsSync(projectDirectory)) return []
  return readdirSync(projectDirectory)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => join(projectDirectory, name))
}

export function sessionIdFromLog(filePath) {
  return basename(filePath, '.jsonl')
}
