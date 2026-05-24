// Windows implementation of AgentRuntime: node-pty (ConPTY) backed.
//
// Requires `node-pty` to be installed. node-pty is a native module with no
// published prebuilds; on a fresh Windows install the operator must have
// Visual Studio Build Tools 2022 ("Desktop development with C++" workload)
// + Python 3 available when `npm install` runs, so node-gyp can compile it.
// This is documented in install-windows.ps1.
//
// Architecture per session:
//   - One IPty (ConPTY-backed pseudo-terminal) running the spawned process.
//   - One circular byte buffer accumulating the pty's stdout; on capture()
//     we ANSI-strip the tail and return it (mirrors `tmux capture-pane -p`).
//
// Differences from the POSIX (tmux) backend that callers should know about:
//   - There is no `tmux server` we attach to; sessions live inside this
//     Node process. A dashboard restart loses all session state. (POSIX
//     tmux survives dashboard restarts; on Windows, the channels session
//     is supervised by Task Scheduler and restarts with the dashboard.)
//   - `sendText` writes the whole string at once (no 80-char chunking).
//     ConPTY doesn't have tmux's bracketed-paste-detector quirks.
//   - ANSI stripping in `capture` is regex-based; complex cursor-positioning
//     escapes are dropped but not interpreted. Sufficient for the regex
//     modal-marker matches Marveen uses.

import type { AgentRuntime, StartSessionOpts, SessionName } from './agent-runtime.js'

// node-pty is loaded lazily so the import error surfaces with a useful
// message instead of an obscure MODULE_NOT_FOUND at server startup.
type IPty = {
  write(data: string): void
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void
  kill(signal?: string): void
  resize(cols: number, rows: number): void
  pid: number
}

type PtyModule = {
  spawn(file: string, args: string[], opts: {
    name?: string
    cols?: number
    rows?: number
    cwd?: string
    env?: Record<string, string>
    useConpty?: boolean
  }): IPty
}

let ptyMod: PtyModule | null = null
async function loadNodePty(): Promise<PtyModule> {
  if (ptyMod) return ptyMod
  try {
    const m = await import('node-pty')
    ptyMod = m as unknown as PtyModule
    return ptyMod
  } catch (err) {
    throw new Error(
      'agent-runtime-win: node-pty is required on Windows but failed to load. ' +
      'Install Visual Studio Build Tools 2022 (Desktop C++ workload), then ' +
      're-run `npm install`. Underlying error: ' + (err instanceof Error ? err.message : String(err)),
    )
  }
}

// Eagerly trigger the load so a missing node-pty fails at startup, not
// on the first session-start. The await is at module top level which
// matches the factory pattern in agent-runtime.ts.
const ptyLib: PtyModule = await loadNodePty()

// ANSI strip: covers CSI sequences (most common: cursor/color), OSC
// sequences (window title, hyperlinks), and bare ESC pairs. Good enough
// for substring/regex matching against modal markers.
const ANSI_RX = new RegExp(
  '\x1b\\[[0-9;?]*[ -/]*[@-~]' +     // CSI
  '|\x1b\\][^\x07]*(?:\x07|\x1b\\\\)' + // OSC
  '|\x1b[PX^_][^\x1b]*\x1b\\\\' +    // DCS / SOS / PM / APC
  '|\x1b[=>]' +                       // application keypad on/off
  '|\x1b[()][0-9A-Za-z]' +            // designate charset
  '|\x1b[78MNDE]',                    // misc 2-byte
  'g',
)

function stripAnsi(s: string): string {
  return s
    .replace(ANSI_RX, '')
    .replace(/\r(?!\n)/g, '\n')        // bare CR (cursor-home) -> newline
    .replace(/\x07/g, '')              // BEL
    .replace(/[\x00-\x08\x0b-\x1f]/g, '') // other control chars
}

interface Session {
  pty: IPty
  buf: string[]    // chunks; concatenated lazily in capture()
  bufSize: number  // total bytes accumulated across chunks
  exited: boolean
}

const MAX_BUF_BYTES = 64 * 1024  // ~3 screens of 200x50; matches tmux pane scale

export function createWinAgentRuntime(): AgentRuntime {
  const sessions = new Map<SessionName, Session>()

  function startSession(opts: StartSessionOpts): void {
    if (sessions.has(opts.name)) {
      throw new Error(`agent-runtime-win: session "${opts.name}" already exists; killSession first`)
    }
    // ConPTY needs a real Windows executable. node-pty resolves the
    // command against PATH itself when it has no path separator.
    const pty = ptyLib.spawn(opts.command, opts.args, {
      name: 'xterm-256color',
      cols: opts.cols ?? 200,
      rows: opts.rows ?? 50,
      cwd: opts.cwd,
      env: opts.env,
      useConpty: true,
    })
    const s: Session = { pty, buf: [], bufSize: 0, exited: false }
    pty.onData((data) => {
      s.buf.push(data)
      s.bufSize += data.length
      // Trim oldest chunks until we're back under the cap. We never
      // split a chunk — the oldest chunks tend to be small first
      // frames, so this is fine in practice.
      while (s.bufSize > MAX_BUF_BYTES && s.buf.length > 1) {
        const dropped = s.buf.shift()!
        s.bufSize -= dropped.length
      }
    })
    pty.onExit(() => { s.exited = true })
    sessions.set(opts.name, s)
  }

  function killSession(name: SessionName): void {
    const s = sessions.get(name)
    if (!s) return
    try { s.pty.kill() } catch { /* already dead */ }
    sessions.delete(name)
  }

  function hasSession(name: SessionName): boolean {
    const s = sessions.get(name)
    if (!s) return false
    if (s.exited) {
      // Reap exited sessions on probe so a restart starts clean.
      sessions.delete(name)
      return false
    }
    return true
  }

  function listSessions(): SessionName[] {
    // Side-effect: drop reaped exits so callers iterating + acting see
    // the same set hasSession would.
    for (const [name, s] of sessions) if (s.exited) sessions.delete(name)
    return Array.from(sessions.keys())
  }

  function capture(name: SessionName): string | null {
    const s = sessions.get(name)
    if (!s || s.exited) return null
    const raw = s.buf.join('')
    return stripAnsi(raw)
  }

  function sendText(name: SessionName, text: string): void {
    const s = sessions.get(name)
    if (!s || s.exited) {
      throw new Error(`agent-runtime-win: sendText to dead/missing session "${name}"`)
    }
    s.pty.write(text)
  }

  // Map the POSIX/tmux key names to the raw byte sequences ConPTY's child
  // expects on stdin. The Claude Code TUI reads these as if a real terminal
  // were typing them.
  const KEY_BYTES: Record<string, string> = {
    Enter: '\r',
    Escape: '\x1b',
    Up: '\x1b[A',
    Down: '\x1b[B',
    'C-u': '\x15',
  }

  function sendKey(name: SessionName, key: string): void {
    const s = sessions.get(name)
    if (!s || s.exited) {
      throw new Error(`agent-runtime-win: sendKey to dead/missing session "${name}"`)
    }
    let bytes = KEY_BYTES[key]
    if (bytes == null) {
      // Single-char digit/letter (modal option select). Anything longer
      // is a typo we want to surface, not pass through.
      if (key.length !== 1) {
        throw new Error(`agent-runtime-win: unsupported key name "${key}"`)
      }
      bytes = key
    }
    s.pty.write(bytes)
  }

  function sleepSync(ms: number): void {
    // Atomics.wait blocks the current thread without burning CPU and
    // without spawning a subprocess. Requires Node 16+ with the default
    // worker thread support.
    const buf = new SharedArrayBuffer(4)
    const arr = new Int32Array(buf)
    Atomics.wait(arr, 0, 0, ms)
  }

  return { startSession, killSession, hasSession, listSessions, capture, sendText, sendKey, sleepSync }
}
