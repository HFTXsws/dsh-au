import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ClientControlError } from './errors.js'

const HELPER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'windows-uia.ps1')

export class WindowsClientAdapter {
  constructor({ spawn = spawnSync, helperPath = HELPER_PATH, timeoutMs = 45_000 } = {}) {
    this.spawn = spawn
    this.helperPath = helperPath
    this.timeoutMs = timeoutMs
  }

  capabilities() {
    return {
      platform: 'win32',
      provider: 'claude',
      actions: ['read', 'inspect', 'send', 'new'],
      internalActions: ['NewOpen'],
      uiAutomation: 'UIAutomationClient',
      helper: this.helperPath
    }
  }

  call(action, config) {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-au-client-control-'))
    const configPath = join(directory, 'request.json')
    writeFileSync(configPath, JSON.stringify(config), 'utf8')
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', this.helperPath,
      '-Action', action,
      '-ConfigPath', configPath
    ]
    try {
      let result = this.spawn('pwsh', args, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: this.timeoutMs
      })
      if (result.error?.code === 'ENOENT') {
        result = this.spawn('powershell.exe', args, {
          encoding: 'utf8',
          windowsHide: true,
          timeout: this.timeoutMs
        })
      }
      if (result.error) {
        throw new ClientControlError(`Cannot start PowerShell UIA helper: ${result.error.message}`, {
          code: 'ADAPTER_START_FAILED',
          cause: result.error
        })
      }
      if (result.status !== 0) {
        throw new ClientControlError(String(result.stderr || '').trim()
          || 'Windows UIA helper failed', { code: 'ADAPTER_FAILED' })
      }
      try {
        return JSON.parse(String(result.stdout || '').replace(/^\uFEFF/, ''))
      } catch (cause) {
        throw new ClientControlError('Windows UIA helper did not return valid JSON', {
          code: 'ADAPTER_PROTOCOL_ERROR',
          cause
        })
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
}
