// Long-lived child process that owns all node-pty / ConPTY sessions on
// Windows. Spawned once by agent-runtime-win.ts on first use, talks back
// via a localhost HTTP endpoint.
//
// Why a separate process at all: when the parent dashboard blocks the main
// thread (sleepSync / execSync / Atomics.wait, any of which the legacy
// POSIX code paths rely on), libuv in that process does not pump. node-pty
// emits via libuv callbacks, so any pty held by the parent would stop
// receiving data the moment a sync sleep started. On POSIX this is moot
// because tmux is already in a separate process. On Windows we have to
// recreate that separation manually — that is this server.
//
// Protocol: POST /<method> with JSON body, JSON response. All errors are
// returned as { ok: false, error: string } with HTTP 200; HTTP non-200 is
// reserved for transport-level problems.
//
// Lifecycle: parent passes --port-file and --parent-pid args. On startup
// we write the chosen port to the port-file (atomically), then periodically
// check that parent-pid is still alive — if it dies, we exit so we don't
// leak across dashboard restarts.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { writeFileSync, renameSync, mkdirSync, openSync, closeSync } from 'node:fs'
import { dirname } from 'node:path'

// Match the inline IPty type used in agent-runtime-win.ts. Kept narrow to
// avoid pulling node-pty's full d.ts surface.
interface IPty {
  write(data: string): void
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void
  kill(signal?: string): void
  resize(cols: number, rows: number): void
  pid: number
}

interface PtyModule {
  spawn(file: string, args: string[], opts: {
    name?: string
    cols?: number
    rows?: number
    cwd?: string
    env?: Record<string, string>
    useConpty?: boolean
  }): IPty
}

// Loaded lazily so a missing node-pty crashes early with a clear message
// rather than at the first session start.
let ptyLib: PtyModule
try {
  ptyLib = (await import('node-pty')) as unknown as PtyModule
} catch (err) {
  process.stderr.write(`pty-server: failed to load node-pty: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(2)
}

interface Session {
  pty: IPty
  buf: string[]
  bufSize: number
  exited: boolean
}

const MAX_BUF_BYTES = 64 * 1024
const sessions = new Map<string, Session>()

const KEY_BYTES: Record<string, string> = {
  Enter: '\r',
  Escape: '\x1b',
  Up: '\x1b[A',
  Down: '\x1b[B',
  'C-u': '\x15',
}

// CSI / OSC / DCS / charset / misc 2-byte. Sufficient to strip Claude
// Code's TUI escapes for substring/regex matching against modal markers.
const ANSI_RX = new RegExp(
  '\x1b\\[[0-9;?]*[ -/]*[@-~]' +
  '|\x1b\\][^\x07]*(?:\x07|\x1b\\\\)' +
  '|\x1b[PX^_][^\x1b]*\x1b\\\\' +
  '|\x1b[=>]' +
  '|\x1b[()][0-9A-Za-z]' +
  '|\x1b[78MNDE]',
  'g',
)

function stripAnsi(s: string): string {
  return s
    .replace(ANSI_RX, '')
    .replace(/\r(?!\n)/g, '\n')
    .replace(/\x07/g, '')
    .replace(/[\x00-\x08\x0b-\x1f]/g, '')
}

// --- RPC handlers ---

interface RpcResult { ok: true; result?: unknown }
interface RpcError { ok: false; error: string }
type RpcResponse = RpcResult | RpcError

function handle(method: string, body: Record<string, unknown>): RpcResponse {
  try {
    switch (method) {
      case 'start': {
        const name = String(body.name ?? '')
        if (!name) return { ok: false, error: 'name required' }
        if (sessions.has(name)) return { ok: false, error: `session "${name}" already exists` }
        const command = String(body.command ?? '')
        const args = Array.isArray(body.args) ? (body.args as string[]) : []
        const cwd = String(body.cwd ?? process.cwd())
        const env = (body.env && typeof body.env === 'object')
          ? (body.env as Record<string, string>)
          : (process.env as Record<string, string>)
        const cols = Number(body.cols ?? 200)
        const rows = Number(body.rows ?? 50)
        const pty = ptyLib.spawn(command, args, {
          name: 'xterm-256color',
          cols,
          rows,
          cwd,
          env,
          useConpty: true,
        })
        const s: Session = { pty, buf: [], bufSize: 0, exited: false }
        pty.onData((data) => {
          s.buf.push(data)
          s.bufSize += data.length
          while (s.bufSize > MAX_BUF_BYTES && s.buf.length > 1) {
            const dropped = s.buf.shift()!
            s.bufSize -= dropped.length
          }
        })
        pty.onExit(() => { s.exited = true })
        sessions.set(name, s)
        return { ok: true, result: { pid: pty.pid } }
      }

      case 'kill': {
        const name = String(body.name ?? '')
        const s = sessions.get(name)
        if (!s) return { ok: true } // idempotent
        try { s.pty.kill() } catch { /* already dead */ }
        sessions.delete(name)
        return { ok: true }
      }

      case 'has': {
        const name = String(body.name ?? '')
        const s = sessions.get(name)
        if (!s) return { ok: true, result: false }
        if (s.exited) { sessions.delete(name); return { ok: true, result: false } }
        return { ok: true, result: true }
      }

      case 'list': {
        for (const [n, s] of sessions) if (s.exited) sessions.delete(n)
        return { ok: true, result: Array.from(sessions.keys()) }
      }

      case 'capture': {
        const name = String(body.name ?? '')
        const s = sessions.get(name)
        if (!s || s.exited) return { ok: true, result: null }
        return { ok: true, result: stripAnsi(s.buf.join('')) }
      }

      case 'sendText': {
        const name = String(body.name ?? '')
        const text = String(body.text ?? '')
        const s = sessions.get(name)
        if (!s || s.exited) return { ok: false, error: `sendText to dead/missing session "${name}"` }
        s.pty.write(text)
        return { ok: true }
      }

      case 'sendKey': {
        const name = String(body.name ?? '')
        const key = String(body.key ?? '')
        const s = sessions.get(name)
        if (!s || s.exited) return { ok: false, error: `sendKey to dead/missing session "${name}"` }
        let bytes = KEY_BYTES[key]
        if (bytes == null) {
          if (key.length !== 1) return { ok: false, error: `unsupported key name "${key}"` }
          bytes = key
        }
        s.pty.write(bytes)
        return { ok: true }
      }

      case 'ping':
        return { ok: true, result: { pid: process.pid, sessions: sessions.size } }

      default:
        return { ok: false, error: `unknown method: ${method}` }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// --- HTTP server ---

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method !== 'POST') {
    res.writeHead(405); res.end('POST only'); return
  }
  const method = (req.url ?? '/').replace(/^\//, '')
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    let parsed: Record<string, unknown>
    try {
      parsed = body ? JSON.parse(body) : {}
    } catch (err) {
      res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'bad json: ' + (err instanceof Error ? err.message : String(err)) })); return
    }
    const reply = handle(method, parsed)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(reply))
  })
})

// --- Lifecycle ---

const args = process.argv.slice(2)
const portFileArg = args.find(a => a.startsWith('--port-file='))?.slice('--port-file='.length)
const parentPidArg = args.find(a => a.startsWith('--parent-pid='))?.slice('--parent-pid='.length)

if (!portFileArg) {
  process.stderr.write('pty-server: --port-file=<path> required\n')
  process.exit(2)
}
const portFile = portFileArg
const parentPid = parentPidArg ? parseInt(parentPidArg, 10) : null

server.listen(0, '127.0.0.1', () => {
  const addr = server.address()
  if (!addr || typeof addr === 'string') {
    process.stderr.write('pty-server: failed to bind localhost\n')
    process.exit(2)
  }
  // Write port atomically: tmp file then rename, so the parent never reads
  // a half-written file via fast polling.
  mkdirSync(dirname(portFile), { recursive: true })
  const tmp = portFile + '.tmp'
  writeFileSync(tmp, String(addr.port), 'utf-8')
  renameSync(tmp, portFile)
  process.stderr.write(`pty-server: listening on 127.0.0.1:${addr.port}, port-file=${portFile}\n`)
})

// Parent-watch: if the dashboard process died (signal, crash, restart) we
// exit so we don't leak. Cheap polling — once per second is fine.
if (parentPid != null && Number.isFinite(parentPid)) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0)
    } catch {
      // ESRCH -> parent gone. Drop everything.
      for (const [name, s] of sessions) {
        try { s.pty.kill() } catch { /* ok */ }
        sessions.delete(name)
      }
      process.exit(0)
    }
  }, 1000).unref()
}

// Don't keep the process alive on SIGINT — parent will respawn if needed.
process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
