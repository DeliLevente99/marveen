// POSIX implementation of AgentRuntime: tmux-backed.
//
// This is a direct lift of the tmux primitives that were previously inline
// in src/web/agent-process.ts (and a handful of other call sites). The
// semantics are intentionally byte-identical to the pre-refactor behavior
// — same flags, same timeouts, same chunking / dash-slide logic for
// `sendText`, same /bin/sleep timing helpers.
//
// If you change anything here, double-check that the POSIX behavior of
// Marveen has not drifted: the additive-only port principle says the
// non-Windows path stays exactly as it was.

import { execSync, execFileSync } from 'node:child_process'
import { resolveFromPath } from '../platform.js'
import type { AgentRuntime, StartSessionOpts, SessionName } from './agent-runtime.js'

const TMUX = resolveFromPath('tmux')

function quoteForShell(s: string): string {
  // Single-quote everything; close quote, embed escaped single-quote,
  // reopen. Standard sh idiom.
  return `'` + s.replace(/'/g, `'\\''`) + `'`
}

function envExportPrefix(env: Record<string, string>): string {
  // Translate the structured env into the same `export X=...` chain the
  // legacy shellCmd built inline. The shell that tmux spawns reads this
  // as if the operator had typed it: explicit, copy-pasteable in logs,
  // and inheritable by the claude grandchild.
  const parts: string[] = []
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(k)) continue
    parts.push(`export ${k}=${quoteForShell(v)}`)
  }
  return parts.join(' && ')
}

export function createPosixAgentRuntime(): AgentRuntime {
  function startSession(opts: StartSessionOpts): void {
    // unset MUST come first: the running tmux server's env (inherited from
    // whoever first started the server, typically the operator's login
    // shell with .env sourced) is the leak path. `unset X Y Z` strips
    // those names from the spawned shell BEFORE our explicit `export`s
    // re-establish only what the caller intended. Without this, a
    // TELEGRAM_BOT_TOKEN that leaked into the tmux server's globals
    // gets inherited by every sub-agent session, and they all fight over
    // the same getUpdates slot (409 Conflict in a loop).
    const validName = (s: string) => /^[A-Z_][A-Z0-9_]*$/i.test(s)
    const unsetNames = (opts.unsetEnv ?? []).filter(validName)
    const unsetCmd = unsetNames.length > 0 ? `unset ${unsetNames.join(' ')}` : ''
    const envPrefix = envExportPrefix(opts.env)
    const argv = [opts.command, ...opts.args].map(quoteForShell).join(' ')
    const cwdQuoted = quoteForShell(opts.cwd)
    const inner = [unsetCmd, envPrefix, `cd ${cwdQuoted}`, argv].filter(Boolean).join(' && ')
    execSync(
      `${TMUX} new-session -d -s ${opts.name} ${quoteForShell(inner)}`,
      { timeout: 10000 },
    )
  }

  function killSession(name: SessionName): void {
    try {
      execSync(`${TMUX} kill-session -t ${name} 2>/dev/null`, { timeout: 5000 })
    } catch { /* already gone is fine */ }
  }

  function hasSession(name: SessionName): boolean {
    try {
      const output = execSync(
        `${TMUX} list-sessions -F "#{session_name}"`,
        { timeout: 3000, encoding: 'utf-8' },
      )
      return output.split('\n').some((line) => line.trim() === name)
    } catch {
      return false
    }
  }

  function listSessions(): SessionName[] {
    try {
      const output = execSync(
        `${TMUX} list-sessions -F "#{session_name}"`,
        { timeout: 3000, encoding: 'utf-8' },
      )
      return output.split('\n').map((s) => s.trim()).filter(Boolean)
    } catch {
      return []
    }
  }

  function capture(name: SessionName): string | null {
    try {
      return execSync(
        `${TMUX} capture-pane -t ${name} -p`,
        { timeout: 3000, encoding: 'utf-8' },
      )
    } catch {
      return null
    }
  }

  // Lifted from the pre-refactor sendPromptToSession. tmux's `send-keys -l`
  // refuses chunks beginning with `-` (parses as a flag), so we slide the
  // boundary up to MAX_SLIDE chars past any trailing dash. A 30 ms sleep
  // between chunks keeps the bracketed-paste detector from concatenating
  // wrapped fragments into a single paste event.
  function sendText(name: SessionName, text: string): void {
    const CHUNK = 80
    const MAX_SLIDE = 8
    let i = 0
    while (i < text.length) {
      let end = Math.min(i + CHUNK, text.length)
      let slide = 0
      while (end < text.length && text[end] === '-' && slide < MAX_SLIDE) {
        end++; slide++
      }
      let chunk = text.slice(i, end)
      if (chunk.startsWith('-')) chunk = ' ' + chunk
      execFileSync(TMUX, ['send-keys', '-t', name, '-l', chunk], { timeout: 5000 })
      i = end
      if (i < text.length) {
        execFileSync('/bin/sleep', ['0.03'], { timeout: 1000 })
      }
    }
  }

  function sendKey(name: SessionName, key: string): void {
    // tmux's send-keys speaks key names natively. Whitelist the ones
    // Marveen actually uses so a typo'd 'Entr' doesn't get sent as
    // literal text.
    const allowed = new Set(['Enter', 'Escape', 'Up', 'Down', 'C-u'])
    const digit = /^[0-9]$/.test(key)
    if (!allowed.has(key) && !digit) {
      throw new Error(`agent-runtime: unsupported key name "${key}"`)
    }
    execFileSync(TMUX, ['send-keys', '-t', name, key], { timeout: 5000 })
  }

  function sleepSync(ms: number): void {
    // Preserve the legacy `/bin/sleep` invocation so POSIX behavior is
    // byte-identical. Atomics.wait would also work but would diverge
    // from the pre-refactor process tree (an operator inspecting
    // `ps -axf` while Marveen is mid-send would see different process
    // patterns).
    const seconds = (ms / 1000).toFixed(3)
    try {
      execFileSync('/bin/sleep', [seconds], { timeout: Math.max(2000, ms + 1000) })
    } catch { /* best effort */ }
  }

  return { startSession, killSession, hasSession, listSessions, capture, sendText, sendKey, sleepSync }
}
