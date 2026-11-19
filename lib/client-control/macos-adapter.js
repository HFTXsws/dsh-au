import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ClientControlError } from './errors.js'

const HELPER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'macos-accessibility.js')

export class MacOSClientAdapter {
  constructor({ spawn = spawnSync, helperPath = HELPER_PATH, timeoutMs = 45_000 } = {}) {
    this.spawn = spawn
    this.helperPath = helperPath
    this.timeoutMs = timeoutMs
  }

  capabilities() {
    return {
      platform: 'darwin',
      provider: 'claude',
      actions: ['read', 'inspect', 'send', 'new'],
      internalActions: ['NewOpen'],
      uiAutomation: 'System Events Accessibility',
      helper: this.helperPath
    }
  }

  call(action, config) {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-au-client-control-'))
    const configPath = join(directory, 'request.json')
    writeFileSync(configPath, JSON.stringify(config), 'utf8')
    try {
      const result = this.spawn('osascript', [
        '-l', 'JavaScript', this.helperPath, action, configPath
      ], {
        encoding: 'utf8',
        timeout: this.timeoutMs
      })
      if (result.error) {
        throw new ClientControlError(`Cannot start macOS Accessibility helper: ${result.error.message}`, {
          code: 'ADAPTER_START_FAILED',
          cause: result.error
        })
      }
      if (result.status !== 0) {
        throw new ClientControlError(String(result.stderr || '').trim()
          || 'macOS Accessibility helper failed', { code: 'ADAPTER_FAILED' })
      }
      try {
        return JSON.parse(String(result.stdout || ''))
      } catch (cause) {
        throw new ClientControlError('macOS Accessibility helper did not return valid JSON', {
          code: 'ADAPTER_PROTOCOL_ERROR',
          cause
        })
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
}
