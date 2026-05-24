import { execSync } from 'node:child_process'

export type PlatformType = 'macos' | 'linux-server' | 'linux-gui'

function detect(): PlatformType {
  const override = process.env['MARVEEN_ENV']
  if (override === 'macos' || override === 'linux-server' || override === 'linux-gui') return override
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'linux') {
    const hasDisplay = !!(process.env['DISPLAY'] || process.env['WAYLAND_DISPLAY'] || process.env['XDG_SESSION_TYPE'])
    return hasDisplay ? 'linux-gui' : 'linux-server'
  }
  return 'linux-server'
}

export const PLATFORM: PlatformType = detect()

export function resolveFromPath(name: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error('Invalid binary name: ' + name)
  const cmd = process.platform === 'win32' ? `where ${name}` : `which ${name}`
  try {
    // `where` returns one path per line (one per PATH match); take the
    // first. `which` returns one line. trim() + split('\n')[0] handles
    // both uniformly.
    return execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0].trim()
  } catch {
    throw new Error(`Required binary not found on PATH: ${name}`)
  }
}
