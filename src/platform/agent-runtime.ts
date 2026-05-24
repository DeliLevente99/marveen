// Cross-platform agent-runtime shim.
//
// Wraps the narrow subset of tmux primitives Marveen actually depends on
// (start a detached session running one process, send literal text or named
// keys to it, capture its visible buffer, kill it). The interface is
// intentionally minimal — anything tmux can do but Marveen does not use is
// out of scope.
//
// POSIX (Linux, macOS): backed by tmux. Behavior is byte-identical to the
//   pre-refactor agent-process.ts code; that code is lifted into
//   agent-runtime-posix.ts wholesale.
// Windows: backed by node-pty + ConPTY. Requires Visual Studio Build Tools
//   on the install host (node-pty has no prebuilt binaries on npm).
//
// Selection is at module load via top-level await — the unused module is
// not imported, so node-pty stays out of the dependency graph on POSIX.

export type SessionName = string

export interface StartSessionOpts {
  /** Logical session name. Becomes the tmux session name on POSIX. */
  name: SessionName
  /** Working directory the session's process is spawned in. */
  cwd: string
  /** Program to spawn. Resolved against PATH (Windows: PATHEXT too). */
  command: string
  /** Arguments for `command`. Each entry is one argv slot, no shell quoting. */
  args: string[]
  /** Full environment for the spawned process. Replaces the parent env. */
  env: Record<string, string>
  /**
   * Names of env vars to actively `unset` in the spawned shell BEFORE the
   * env exports + command run. Required on POSIX because tmux's running
   * server inherits the parent env; just omitting a key from `env` does
   * not strip it from a session the server spawns. Each named var is
   * `unset`-ed explicitly so the spawned process truly does not see it.
   * On Windows this is a no-op (every `pty.spawn` gets its own env block
   * — there is no shared server holding inherited vars).
   */
  unsetEnv?: string[]
  /** Pseudo-terminal width. Default 200 — matches tmux's effective pane. */
  cols?: number
  /** Pseudo-terminal height. Default 50. */
  rows?: number
}

export interface AgentRuntime {
  /**
   * Spawn a detached, long-running session. Caller MUST `killSession` first
   * if a session with this name already exists — startSession does not
   * auto-replace.
   */
  startSession(opts: StartSessionOpts): void

  /** Terminate the named session (best effort; no-op if absent). */
  killSession(name: SessionName): void

  /** True if a session with this name currently exists. */
  hasSession(name: SessionName): boolean

  /** Names of all sessions this runtime currently owns. */
  listSessions(): SessionName[]

  /**
   * Snapshot of the session's visible buffer. Returns null on capture
   * failure (timeout, dead session, etc).
   *
   * POSIX: `tmux capture-pane -p` output (ANSI already processed by tmux).
   * Windows: ANSI-stripped tail of accumulated pty stdout.
   */
  capture(name: SessionName): string | null

  /**
   * Write literal text to the session's input as if typed at the prompt.
   * Does NOT submit. Use `sendKey(name, 'Enter')` to submit.
   * The implementation may internally chunk long input.
   */
  sendText(name: SessionName, text: string): void

  /**
   * Send a named key. Supported names:
   *   'Enter' | 'Escape' | 'Up' | 'Down' | 'C-u' | '0' | '1' | ...
   * Digit/letter strings of length 1 are accepted as their literal character
   * (used for modal-option selection, e.g. send '0' to dismiss a numbered
   * dialog). Unknown key names throw.
   */
  sendKey(name: SessionName, key: string): void

  /**
   * Block the calling thread for ms milliseconds. The legacy agent-process
   * code relies on synchronous sleeps to order send-keys/capture-pane pairs
   * around tmux's render cycle. This preserves that timing on both
   * platforms.
   */
  sleepSync(ms: number): void
}

let runtime: AgentRuntime
if (process.platform === 'win32') {
  const mod = await import('./agent-runtime-win.js')
  runtime = mod.createWinAgentRuntime()
} else {
  const mod = await import('./agent-runtime-posix.js')
  runtime = mod.createPosixAgentRuntime()
}

export const agentRuntime: AgentRuntime = runtime
