import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

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

// Heal a broken npm-installed Windows shim where the `.cmd` points at a
// missing `claude.exe` because npm renamed the running binary to
// `claude.exe.old.<unix_ms>` during an upgrade that did not finish. The
// symptom on marveen is silent: pty-server spawns the .cmd, .cmd prints
// "not recognized as an internal or external command" and exits in
// ~200ms, and the channel-monitor's stage 1-4 recovery loops fail
// because every respawn meets the same dead binary. Calling this before
// each marveen-channels spawn restores the highest-timestamp `.old.*`
// sibling so the next spawn succeeds without operator intervention.
//
// Idempotent: returns repaired=false when the .exe already exists or
// when there is no .old.<ts> sibling to restore. Pure on fs — no
// platform gate (callers are already Windows-only); the .cmd-suffix +
// %dp0%-pattern checks make this a safe no-op on unrelated inputs.
export function repairWindowsClaudeShim(cmdPath: string): { repaired: boolean; restoredFrom?: string; reason?: string } {
  if (!cmdPath.toLowerCase().endsWith('.cmd')) return { repaired: false, reason: 'not-cmd-shim' }
  let shim: string
  try {
    shim = readFileSync(cmdPath, 'utf-8')
  } catch {
    return { repaired: false, reason: 'shim-unreadable' }
  }
  // npm shim invokes the .exe via `"%dp0%\...claude.exe"` where %dp0% is the
  // .cmd's own directory. Match the first such reference rather than
  // hard-coding the @anthropic-ai path — keeps this resilient to npm shim
  // template changes.
  const m = shim.match(/"%dp0%\\?([^"\r\n]+\.exe)"/i)
  if (!m) return { repaired: false, reason: 'no-exe-ref-in-shim' }
  const exePath = resolve(dirname(cmdPath), m[1])
  if (existsSync(exePath)) return { repaired: false, reason: 'exe-already-present' }
  const exeDir = dirname(exePath)
  const exeName = exePath.slice(exeDir.length + 1) // e.g. "claude.exe"
  let entries: string[]
  try {
    entries = readdirSync(exeDir)
  } catch {
    return { repaired: false, reason: 'exe-dir-unreadable' }
  }
  // npm rename pattern: "<name>.old.<unix_ms>". Pick the newest by
  // timestamp so a sequence of interrupted upgrades restores the most
  // recent surviving copy.
  const oldRx = new RegExp('^' + exeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.old\\.(\\d+)$', 'i')
  let best: { path: string; ts: number } | null = null
  for (const e of entries) {
    const mm = e.match(oldRx)
    if (!mm) continue
    const ts = parseInt(mm[1], 10)
    if (!Number.isFinite(ts)) continue
    if (!best || ts > best.ts) best = { path: join(exeDir, e), ts }
  }
  if (!best) return { repaired: false, reason: 'no-old-sibling' }
  try {
    renameSync(best.path, exePath)
    return { repaired: true, restoredFrom: best.path }
  } catch (err) {
    return { repaired: false, reason: `rename-failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}
