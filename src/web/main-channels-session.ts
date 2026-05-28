// Main-agent channels session lifecycle — Windows only.
//
// On POSIX the marveen-channels tmux session is owned by an external
// service (launchd plist on macOS, systemd --user unit on Linux),
// started by scripts/channels.sh. The dashboard never spawns it —
// channel-monitor.ts just supervises what the service has running.
//
// On Windows there is no equivalent service yet (an install-windows.ps1
// native rewrite would register a Task Scheduler task; tracked
// separately). To make the dashboard usable on Windows end-to-end, we
// spawn the channels session ourselves via agentRuntime — the same
// path sub-agents use, with `MAIN_CHANNELS_SESSION` as the name. The
// session is bound to the dashboard's lifetime: dashboard exit ->
// pty-server exit -> channels session exit. That is a trade-off vs
// POSIX (a dashboard restart also restarts channels and the Telegram
// getUpdates poller briefly drops), but it's the simplest model that
// works without a service supervisor.
//
// All functions in this module are no-ops on non-Windows platforms so
// the POSIX boot path is byte-identical to before this file existed.

import { existsSync } from 'node:fs'
import { join, delimiter as PATH_DELIMITER } from 'node:path'
import { homedir } from 'node:os'
import { PROJECT_ROOT, MAIN_AGENT_ID, CHANNEL_PROVIDER, OLLAMA_URL } from '../config.js'
import { logger } from '../logger.js'
import { resolveFromPath } from '../platform.js'
import { getProvider, channelStateDir } from '../channel-provider.js'
import { agentRuntime, type SessionName } from '../platform/agent-runtime.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'

function buildMainChannelsEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v
  }
  // Windows PATH already contains claude.exe via the installer, so we
  // don't prepend the POSIX tool dirs (see agent-process.ts for the
  // same reasoning). Just propagate the existing PATH.
  // Strip channel tokens — the plugin reads its own token from
  // ~/.claude/channels/<provider>/.env so we must NOT inherit one
  // from the dashboard's env (which would shadow per-channel state).
  delete env.TELEGRAM_BOT_TOKEN
  delete env.SLACK_BOT_TOKEN
  delete env.SLACK_APP_TOKEN
  // The main agent's channel state lives in the project-root .claude
  // dir (not under per-agent agents/<name>/.claude). channelStateDir()
  // without an agentDir argument returns the main-agent path.
  const stateEnvVar = CHANNEL_PROVIDER === 'slack'
    ? 'SLACK_STATE_DIR'
    : CHANNEL_PROVIDER === 'discord'
      ? 'DISCORD_STATE_DIR'
      : 'TELEGRAM_STATE_DIR'
  env[stateEnvVar] = channelStateDir(CHANNEL_PROVIDER)
  return env
}

function hasPriorClaudeSession(): boolean {
  // Mirror channels.sh's detection: --continue only if Claude Code has
  // a prior session log for this project, otherwise it errors out and
  // the channels session dies on first launch.
  const projectsRoot = join(homedir(), '.claude', 'projects')
  const encodedProject = PROJECT_ROOT.replace(/[\\/]/g, '-')
  return existsSync(join(projectsRoot, encodedProject))
}

// Collapse ANSI residue + all whitespace so dialog detection survives the
// cursor-positioning sequences ConPTY emits between every word. Without
// collapsing whitespace, "Yes, I trust" arrives as "Yes,[1C]I[1C]trust" and
// the literal-phrase patterns scripts/channels.sh uses on POSIX would never
// match.
function flattenPane(pane: string): string {
  return pane
    .replace(/\x1b\[[0-9;?<>]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*[\x07\x1b]/g, '')
    .replace(/\s+/g, '')
}

// Auto-accept the trust + bypass-permissions dialogs Claude Code's TUI shows
// on first launch in a folder. The POSIX equivalent is the 12-iteration loop
// at scripts/channels.sh:80-110 (`tmux capture-pane` + `send-keys`). Without
// this, the channels session sits at the trust prompt indefinitely and the
// plugin never loads, so every channel message silently no-ops -- which is
// exactly what the L2 smoke test surfaced.
//
// Async + fire-and-forget so dashboard boot is not blocked by the handshake
// window. Errors are logged but never thrown -- a failure to auto-accept
// degrades to "operator must dismiss manually", same as if this code did
// not exist.
function autoAcceptStartupDialogs(session: SessionName): void {
  const MAX_ATTEMPTS = 15 // ~15s wallclock; ConPTY-on-WSL paint can be slow
  let trustHandled = false
  let bypassHandled = false
  let attempt = 0
  const tick = (): void => {
    attempt++
    if (!agentRuntime.hasSession(session)) {
      logger.warn({ session, attempt }, 'Channels session died before startup dialogs were dismissed')
      return
    }
    if (attempt > MAX_ATTEMPTS) {
      logger.warn({ session, trustHandled, bypassHandled }, 'Channels session startup-dialog timeout (plugin may not have loaded)')
      return
    }
    const pane = agentRuntime.capture(session)
    const flat = pane != null ? flattenPane(pane) : ''
    if (/Listeningforchannel/i.test(flat)) {
      logger.info({ session, attempt }, 'Channels session plugin loaded')
      return
    }
    if (!trustHandled && /Doyoutrust|Isthisaproject|Itrust|trustthisfolder/i.test(flat)) {
      trustHandled = true
      logger.info({ session }, 'Channels session: trust dialog detected, auto-accepting (1+Enter)')
      try {
        agentRuntime.sendKey(session, '1')
        agentRuntime.sleepSync(100)
        agentRuntime.sendKey(session, 'Enter')
      } catch (err) {
        logger.warn({ err, session }, 'Failed to send keys for trust auto-accept')
      }
    } else if (!bypassHandled && /BypassPermissions|Iaccept/i.test(flat)) {
      bypassHandled = true
      logger.info({ session }, 'Channels session: bypass-permissions dialog detected, auto-accepting (2+Enter)')
      try {
        agentRuntime.sendKey(session, '2')
        agentRuntime.sleepSync(100)
        agentRuntime.sendKey(session, 'Enter')
      } catch (err) {
        logger.warn({ err, session }, 'Failed to send keys for bypass auto-accept')
      }
    }
    setTimeout(tick, 1000)
  }
  // First tick after a beat so ConPTY has painted the initial frame.
  setTimeout(tick, 1500)
}

/**
 * Spawn the main agent's channels session via agentRuntime. No-op on
 * non-Windows (the platform service already owns this session).
 */
export function startMainChannelsSession(): void {
  if (process.platform !== 'win32') return
  if (agentRuntime.hasSession(MAIN_CHANNELS_SESSION)) {
    logger.info({ session: MAIN_CHANNELS_SESSION }, 'Main channels session already running, skip spawn')
    return
  }

  const provider = getProvider(CHANNEL_PROVIDER)
  const env = buildMainChannelsEnv()
  const args = [
    '--dangerously-skip-permissions',
    '--model', 'claude-sonnet-4-6',
    '--channels', `plugin:${provider.pluginId}`,
  ]
  if (hasPriorClaudeSession()) args.unshift('--continue')

  // node-pty's spawn on Windows uses CreateProcessW, which does NOT
  // honor PATHEXT for bare names — `claude.exe` would CreateProcess-fail
  // because the actual on-disk shim is `claude.cmd` (npm-installed CLI
  // shim, no .exe sibling). Resolve to the full path via resolveFromPath
  // which (since the PATHEXT-aware fix in src/platform.ts) returns the
  // .cmd entry on Windows and the bare absolute path on POSIX. Both
  // work directly with pty.spawn.
  const claudeBin = resolveFromPath('claude')
  try {
    agentRuntime.startSession({
      name: MAIN_CHANNELS_SESSION,
      cwd: PROJECT_ROOT,
      command: claudeBin,
      args,
      env,
      unsetEnv: ['TELEGRAM_BOT_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
    })
    logger.info(
      { session: MAIN_CHANNELS_SESSION, plugin: provider.pluginId, agentId: MAIN_AGENT_ID },
      'Main channels session spawned (Windows)',
    )
    autoAcceptStartupDialogs(MAIN_CHANNELS_SESSION)
  } catch (err) {
    logger.error({ err }, 'Failed to spawn main channels session on Windows; channel plugin will not be available')
  }
}

/**
 * Terminate the main channels session. No-op on non-Windows.
 * Called from hardRestartMarveenChannels and on dashboard shutdown.
 */
export function stopMainChannelsSession(): void {
  if (process.platform !== 'win32') return
  try { agentRuntime.killSession(MAIN_CHANNELS_SESSION) } catch { /* already gone */ }
}
