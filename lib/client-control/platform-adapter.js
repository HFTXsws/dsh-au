import { UnsupportedPlatformError } from './errors.js'
import { MacOSClientAdapter } from './macos-adapter.js'
import { WindowsClientAdapter } from './windows-adapter.js'

class UnsupportedClientAdapter {
  constructor(platform) {
    this.platform = platform
  }

  capabilities() {
    return {
      platform: this.platform,
      provider: 'claude',
      actions: ['read'],
      internalActions: [],
      uiAutomation: 'unsupported'
    }
  }

  call() {
    throw new UnsupportedPlatformError(this.platform)
  }
}

export function createPlatformAdapter({ platform = process.platform, ...options } = {}) {
  if (platform === 'win32') return new WindowsClientAdapter(options)
  if (platform === 'darwin') return new MacOSClientAdapter(options)
  return new UnsupportedClientAdapter(platform)
}
