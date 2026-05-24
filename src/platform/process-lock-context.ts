// Cross-platform builder for the ProcessLockContext interface that
// src/process-lock.ts consumes. The interface is intentionally narrow
// (list port holders, enumerate own processes matching a pattern, query
// command + owner of a single pid, signal a pid) and was designed
// from the start as a platform-shim seam: process-lock.ts is pure
// logic, this file holds the OS-specific I/O.
//
// POSIX (Linux, macOS): tools the dashboard expects in /bin and /usr/bin
//   (lsof, ps, kill). Behavior is byte-identical to the original
//   inline implementation that lived in src/index.ts; this is a 1:1
//   lift into a dedicated module.
//
// Windows: PowerShell-based equivalents:
//   - Get-NetTCPConnection           for port holders
//   - Get-CimInstance Win32_Process  for the process table + CommandLine
//   - Get-Process                    for the per-pid command name
//   - process.kill (Node, cross-platform) for signals + liveness probes
//
// Per-call cost on Windows is ~100-300 ms (PowerShell spawn). The
// dashboard's lock-acquire path runs at most ~7 PowerShell calls
// before declaring itself the owner, so total startup overhead is
// well under 2 s in the worst case.

import { execSync, execFileSync } from 'node:child_process'
import { logger } from '../logger.js'
import type { ProcessLockContext } from '../process-lock.js'

// --- POSIX (unchanged lift of the original src/index.ts impl) ---

function buildPosixProcessLockContext(): ProcessLockContext {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  return {
    currentPid: process.pid,
    uid,
    listPortHolders(port: number): number[] {
      try {
        const raw = execSync(`lsof -ti :${port} 2>/dev/null || true`, { timeout: 3000, encoding: 'utf-8' }).trim()
        if (!raw) return []
        return raw.split('\n').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0)
      } catch {
        return []
      }
    },
    listOwnProcessesMatching(pattern: RegExp): number[] {
      try {
        const raw = execFileSync('/bin/ps', ['-Ao', 'pid=,uid=,args='], { timeout: 3000, encoding: 'utf-8' })
        const out: number[] = []
        for (const line of raw.split('\n')) {
          const trimmed = line.trimStart()
          if (!trimmed) continue
          const m = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/)
          if (!m) continue
          const pid = parseInt(m[1], 10)
          const rowUid = parseInt(m[2], 10)
          const argv = m[3]
          if (!Number.isFinite(pid) || pid <= 0) continue
          if (pid === process.pid) continue
          if (uid != null && rowUid !== uid) continue
          if (!pattern.test(argv)) continue
          out.push(pid)
        }
        return out
      } catch {
        return []
      }
    },
    getProcessCommand(pid: number): string | null {
      try {
        return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], { timeout: 2000, encoding: 'utf-8' }).trim() || null
      } catch {
        return null
      }
    },
    getProcessUid(pid: number): number | null {
      try {
        const out = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'uid='], { timeout: 2000, encoding: 'utf-8' }).trim()
        const parsed = parseInt(out, 10)
        return Number.isFinite(parsed) ? parsed : null
      } catch {
        return null
      }
    },
    signal(pid: number, sig): 'sent' | 'gone' {
      try {
        process.kill(pid, sig as NodeJS.Signals | 0)
        return 'sent'
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code
        if (code === 'ESRCH') return 'gone'
        throw err
      }
    },
    sleep(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms))
    },
    log: {
      info: (obj, msg) => logger.info(obj, msg),
      warn: (obj, msg) => logger.warn(obj, msg),
      error: (obj, msg) => logger.error(obj, msg),
    },
  }
}

// --- Windows (PowerShell-backed) ---

function runPs(script: string, timeoutMs = 5000): string {
  return execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', script,
  ], { encoding: 'utf-8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] })
}

function buildWinProcessLockContext(): ProcessLockContext {
  // Windows has no UID. We use the Win32 SessionId instead — it
  // discriminates "this is my process vs another user's" the same way
  // POSIX UID does for the dashboard's purpose (legitimacy check on a
  // stale-pidfile candidate). Cache it once at construction so we
  // don't reshell PowerShell on every check.
  let ownSessionId: number | null = null
  try {
    const raw = runPs(`(Get-CimInstance Win32_Process -Filter "ProcessId=${process.pid}").SessionId`, 3000).trim()
    const parsed = parseInt(raw, 10)
    if (Number.isFinite(parsed)) ownSessionId = parsed
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Could not read own SessionId; legitimacy check on Windows will be more permissive')
  }

  // PowerShell spawns cost ~150-300 ms each. process-lock.ts's
  // filterOwnNodeCandidates calls getProcessCommand once per
  // enumerated PID, which on a Windows session with ~50 processes
  // multiplies into 10+ seconds of stalled startup. We populate this
  // cache as a side-effect of the bulk listOwnProcessesMatching query
  // (which already has the CommandLine in hand) so the per-pid
  // command lookups become O(1) Map reads. Misses (e.g. a port-holder
  // not in our session) still hit PowerShell, but the common case
  // doesn't.
  const cmdCache = new Map<number, string | null>()

  // Heuristic: extract the executable base name from a Win CommandLine
  // string. Returns 'node' for `"C:\Program Files\nodejs\node.exe" ...`,
  // 'tsx' for `node ...tsx/dist/cli.mjs ...`, etc. The
  // filterOwnNodeCandidates check only needs /node|tsx/i to match, so a
  // close-enough exe name is sufficient.
  function commandFromArgv(argv: string): string {
    // Quoted first arg: "...\name.exe" rest...
    const quoted = argv.match(/^"([^"]+)"/)
    const first = quoted ? quoted[1] : argv.split(/\s+/)[0] ?? ''
    const base = first.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|com)$/i, '')
    // tsx is invoked as `node ... tsx/dist/cli.mjs ...` — if base is
    // 'node' but argv references tsx, surface tsx so the /node|tsx/i
    // matcher still wins.
    if (base.toLowerCase() === 'node' && /\btsx[\\/]/i.test(argv)) return 'tsx'
    return base
  }

  return {
    currentPid: process.pid,
    uid: ownSessionId,
    listPortHolders(port: number): number[] {
      try {
        // -State Listen: only the LISTEN socket(s), not ESTABLISHED
        // outbound conns to the same port on another endpoint.
        // -Unique: dedup since a multi-IP bind shows up twice.
        const raw = runPs(
          `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`,
          3000,
        ).trim()
        if (!raw) return []
        return raw.split(/\r?\n/).map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0)
      } catch {
        return []
      }
    },
    listOwnProcessesMatching(pattern: RegExp): number[] {
      // One WMI query for own-session processes (server-side filter on
      // SessionId is faster than client-side), CSV-formatted so we can
      // robustly parse multi-line CommandLine values in Node. Side-effect:
      // every row populates cmdCache so subsequent getProcessCommand
      // calls don't reshell PowerShell once-per-pid.
      const sessionFilter = ownSessionId != null ? ` -Filter "SessionId=${ownSessionId}"` : ''
      try {
        const raw = runPs(
          `Get-CimInstance Win32_Process${sessionFilter} | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation`,
          5000,
        )
        const out: number[] = []
        const lines = raw.split(/\r?\n/)
        // CSV columns are "ProcessId","CommandLine"; skip header row.
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i]
          if (!line) continue
          const m = line.match(/^"(\d+)","((?:[^"]|"")*)"$/)
          if (!m) continue
          const pid = parseInt(m[1], 10)
          const cmdline = m[2].replace(/""/g, '"')
          if (!Number.isFinite(pid) || pid <= 0) continue
          // Seed the per-pid command cache even for the current PID and
          // non-matching rows: filterOwnNodeCandidates may probe any
          // own-session PID, and we'd rather hit the cache than reshell.
          const cmd = commandFromArgv(cmdline)
          if (cmd) cmdCache.set(pid, cmd)
          if (pid === process.pid) continue
          if (!pattern.test(cmdline)) continue
          out.push(pid)
        }
        return out
      } catch {
        return []
      }
    },
    getProcessCommand(pid: number): string | null {
      const cached = cmdCache.get(pid)
      if (cached !== undefined) return cached
      try {
        const out = runPs(
          `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).ProcessName`,
          2000,
        ).trim()
        const result = out || null
        cmdCache.set(pid, result)
        return result
      } catch {
        cmdCache.set(pid, null)
        return null
      }
    },
    getProcessUid(pid: number): number | null {
      // Return SessionId so the legitimacy check can compare against
      // ownSessionId via the existing uid === uid logic.
      try {
        const out = runPs(
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").SessionId`,
          2000,
        ).trim()
        const parsed = parseInt(out, 10)
        return Number.isFinite(parsed) ? parsed : null
      } catch {
        return null
      }
    },
    signal(pid: number, sig): 'sent' | 'gone' {
      // process.kill works on Windows too: SIGTERM/SIGKILL both map to
      // hard TerminateProcess (no graceful shutdown signal exists on
      // Windows), and (pid, 0) is the standard liveness probe.
      try {
        process.kill(pid, sig as NodeJS.Signals | 0)
        return 'sent'
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code
        if (code === 'ESRCH') return 'gone'
        throw err
      }
    },
    sleep(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms))
    },
    log: {
      info: (obj, msg) => logger.info(obj, msg),
      warn: (obj, msg) => logger.warn(obj, msg),
      error: (obj, msg) => logger.error(obj, msg),
    },
  }
}

export function buildProcessLockContext(): ProcessLockContext {
  return process.platform === 'win32'
    ? buildWinProcessLockContext()
    : buildPosixProcessLockContext()
}
