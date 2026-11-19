export class ClientControlError extends Error {
  constructor(message, { code = 'CLIENT_CONTROL_ERROR', cause } = {}) {
    super(message, { cause })
    this.name = 'ClientControlError'
    this.code = code
  }
}

export class UnsupportedPlatformError extends ClientControlError {
  constructor(platform) {
    super(`Client UI control is unsupported on platform: ${platform}`, {
      code: 'UNSUPPORTED_PLATFORM'
    })
    this.name = 'UnsupportedPlatformError'
    this.platform = platform
  }
}

export function assertControl(condition, message, code) {
  if (!condition) throw new ClientControlError(message, { code })
}
