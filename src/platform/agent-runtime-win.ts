// Windows implementation of AgentRuntime.
//
// Architecture: this shim does NOT host node-pty directly. Instead it
// spawns a long-lived child process (pty-server.js) that owns all ptys
// and exposes them over a localhost HTTP endpoint. The shim talks to
// the server synchronously via execSync('curl ...'), so all of Marveen's
// existing sync timing patterns (sleepSync, Atomics.wait, execSync chains)
// continue to work without starving node-pty's libuv callbacks of the
// event loop. POSIX achieves the same separation via tmux; Windows
// achieves it via pty-server.js. The two backends present an identical
// AgentRuntime interface.
//
// Lifecycle:
//   - First method call lazily spawns the pty-server (detached, ignored
//     stdio). Subsequent calls reuse it.
//   - The server is parent-pid bound — when the dashboard dies the
//     server self-exits (one-second poll), so a dashboard restart
//     starts with a fresh server.

import { spawn, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { AgentRuntime, StartSessionOpts, SessionName } from './agent-runtime.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function pickStateDir(): string {
  // Mirror the digest-cwd fallback chain from src/memory.ts: try ~/.claude/tmp,
  // fall back to OS tmpdir if HOME is read-only.
  const candidates = [
    join(homedir(), '.claude', 'tmp', 'marveen-pty'),
    join(tmpdir(), 'marveen-pty'),
  ]
  for (const d of candidates) {
    try { mkdirSync(d, { recursive: true }); return d } catch { /* try next */ }
  }
  return tmpdir()
}

const STATE_DIR = pickStateDir()
const PORT_FILE = join(STATE_DIR, `pty-server-${process.pid}.port`)
const SERVER_SCRIPT = join(__dirname, 'pty-server.js')

let serverPort: number | null = null

function ensureServer(): number {
  if (serverPort != null) return serverPort

  if (!existsSync(SERVER_SCRIPT)) {
    throw new Error(
      `agent-runtime-win: pty-server.js not found at ${SERVER_SCRIPT}. ` +
      `Run \`npm run build\` to compile it.`,
    )
  }

  // Clean any stale port file from a previous run with the same PID
  // (PID recycling on long-lived systems is real even if rare).
  try { unlinkSync(PORT_FILE) } catch { /* fine */ }

  const child = spawn(
    process.execPath,
    [SERVER_SCRIPT, `--port-file=${PORT_FILE}`, `--parent-pid=${process.pid}`],
    {
      // Detached so it survives a parent-process SIGTERM; stdio:'ignore'
      // so the parent doesn't keep its pipes open and block exit. The
      // server itself does parent-pid polling and exits cleanly when
      // the dashboard goes away.
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  )
  child.unref()

  // Poll port file. 5s is plenty for a Node start + listen on a free port
  // (typical: 100-300ms). If we never see it, assume the spawn failed and
  // surface a clear error.
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (existsSync(PORT_FILE)) {
      const raw = readFileSync(PORT_FILE, 'utf-8').trim()
      const port = parseInt(raw, 10)
      if (Number.isFinite(port) && port > 0) {
        serverPort = port
        return port
      }
    }
    // Tiny busy-wait — pty-server boot is fast, no point spawning a real sleep.
    const buf = new SharedArrayBuffer(4)
    Atomics.wait(new Int32Array(buf), 0, 0, 50)
  }
  throw new Error(`agent-runtime-win: pty-server did not write ${PORT_FILE} within 5s`)
}

// Single-shot RPC via curl. curl.exe is shipped with Windows 10/11 in
// C:\Windows\System32\curl.exe so it's always on PATH. Using --max-time
// to bound any single call, and -sS to silence progress but keep errors.
function rpc<T = unknown>(method: string, body: Record<string, unknown> = {}): T {
  const port = ensureServer()
  const url = `http://127.0.0.1:${port}/${method}`
  const json = JSON.stringify(body)
  let stdout: string
  try {
    stdout = execFileSync('curl', [
      '-sS',
      '--max-time', '30',
      '-X', 'POST',
      '-H', 'Content-Type: application/json',
      '--data-binary', json,
      url,
    ], { encoding: 'utf-8', timeout: 35000 })
  } catch (err) {
    throw new Error(`agent-runtime-win: curl to pty-server failed for ${method}: ${err instanceof Error ? err.message : String(err)}`)
  }
  let parsed: { ok: boolean; result?: T; error?: string }
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error(`agent-runtime-win: pty-server returned non-JSON for ${method}: ${stdout.slice(0, 200)}`)
  }
  if (!parsed.ok) {
    throw new Error(`agent-runtime-win: pty-server ${method} returned error: ${parsed.error}`)
  }
  return parsed.result as T
}

export function createWinAgentRuntime(): AgentRuntime {
  return {
    startSession(opts: StartSessionOpts): void {
      rpc('start', {
        name: opts.name,
        cwd: opts.cwd,
        command: opts.command,
        args: opts.args,
        env: opts.env,
        cols: opts.cols,
        rows: opts.rows,
      })
    },

    killSession(name: SessionName): void {
      rpc('kill', { name })
    },

    hasSession(name: SessionName): boolean {
      return rpc<boolean>('has', { name })
    },

    listSessions(): SessionName[] {
      return rpc<string[]>('list', {})
    },

    capture(name: SessionName): string | null {
      return rpc<string | null>('capture', { name })
    },

    sendText(name: SessionName, text: string): void {
      rpc('sendText', { name, text })
    },

    sendKey(name: SessionName, key: string): void {
      rpc('sendKey', { name, key })
    },

    sleepSync(ms: number): void {
      // Safe to block the main thread here: all ptys live in the
      // pty-server child process, so its libuv keeps pumping while we
      // sleep.
      const buf = new SharedArrayBuffer(4)
      Atomics.wait(new Int32Array(buf), 0, 0, ms)
    },
  }
}
