// Cross-platform "list processes with parent links and command lines"
// — the primitive channel-monitor.ts needs to verify a deeply-nested
// channel-plugin grandchild is alive under a given claude PID.
//
// POSIX: parses `/bin/ps -axo pid,ppid,command`. The legacy inline
//   implementation in channel-monitor.ts; lifted here unchanged.
// Windows: parses `Get-CimInstance Win32_Process` CSV with ProcessId,
//   ParentProcessId, CommandLine. WMI returns the full command line
//   (including all args), which is what the plugin-alive heuristic
//   relies on (e.g. matching `bun` + `server.ts` in argv).
//
// Returned shape mirrors what channel-monitor's old inline parser
// produced: a flat list of {pid, ppid, cmd} rows. Callers build
// child-of maps and walk from a root PID.

import { execFileSync } from 'node:child_process'

export interface ProcessRow {
  pid: number
  ppid: number
  cmd: string
}

function listPosix(): ProcessRow[] {
  try {
    const raw = execFileSync('/bin/ps', ['-axo', 'pid,ppid,command'], { timeout: 3000, encoding: 'utf-8' })
    const rows: ProcessRow[] = []
    for (const line of raw.split('\n').slice(1)) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
      if (!m) continue
      const pid = parseInt(m[1], 10)
      const ppid = parseInt(m[2], 10)
      if (!Number.isFinite(pid) || pid <= 0) continue
      rows.push({ pid, ppid, cmd: m[3] })
    }
    return rows
  } catch {
    return []
  }
}

function listWin(): ProcessRow[] {
  try {
    const raw = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation',
    ], { timeout: 5000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    const rows: ProcessRow[] = []
    const lines = raw.split(/\r?\n/)
    // Skip header. Columns: "ProcessId","ParentProcessId","CommandLine"
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue
      const m = line.match(/^"(\d+)","(\d+)","((?:[^"]|"")*)"$/)
      if (!m) continue
      const pid = parseInt(m[1], 10)
      const ppid = parseInt(m[2], 10)
      const cmd = m[3].replace(/""/g, '"')
      if (!Number.isFinite(pid) || pid <= 0) continue
      rows.push({ pid, ppid, cmd })
    }
    return rows
  } catch {
    return []
  }
}

/**
 * Snapshot the full process table on this host. Per-call cost: POSIX
 * a few ms; Windows ~200-400 ms (PowerShell + WMI). Callers should
 * cache the result for the duration of one analysis pass — there is
 * no point re-walking the tree multiple times in the same channel-
 * monitor tick.
 */
export function listProcessTree(): ProcessRow[] {
  return process.platform === 'win32' ? listWin() : listPosix()
}

/**
 * Convenience: build the parent-pid -> children-pids map from a list
 * of rows. Useful for depth-first walks anchored at a known PID.
 */
export function buildChildrenMap(rows: ProcessRow[]): Map<number, number[]> {
  const m = new Map<number, number[]>()
  for (const r of rows) {
    const arr = m.get(r.ppid) ?? []
    arr.push(r.pid)
    m.set(r.ppid, arr)
  }
  return m
}
