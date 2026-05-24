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
  let raw: string
  try {
    raw = execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    throw new Error(`Required binary not found on PATH: ${name}`)
  }
  const lines = raw.split('\n').map(s => s.trim()).filter(Boolean)
  if (lines.length === 0) {
    throw new Error(`Required binary not found on PATH: ${name}`)
  }
  if (process.platform !== 'win32') {
    // POSIX `which` returns one line; preserve historical behavior.
    return lines[0]
  }
  // Windows: `where` returns one path per PATH match in order. Common case
  // for npm-installed tools (claude, tsx, ...) is to ship BOTH a bare
  // POSIX-shell shim (no extension, for Git Bash) and a `.cmd` shim for
  // cmd.exe / Node child_process. The bare shim is listed first and is
  // what plain take-first-line would return, but it cannot be executed
  // via CreateProcess so `execFile`/`spawn` ENOENT on it. Prefer entries
  // whose extension is in PATHEXT (`.CMD` / `.EXE` / `.BAT` / `.COM` by
  // default) so Node can actually launch them. If none of the lines have
  // an executable extension, fall back to the first line — caller errors
  // are clearer than a silent extension change.
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').toUpperCase().split(';').filter(Boolean)
  const preferred = lines.find(p => {
    const dot = p.lastIndexOf('.')
    if (dot <= p.lastIndexOf('\\') && dot <= p.lastIndexOf('/')) return false
    return exts.includes(p.slice(dot).toUpperCase())
  })
  return preferred ?? lines[0]
}
