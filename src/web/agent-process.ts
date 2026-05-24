import { existsSync, readFileSync } from 'node:fs'
import { join, delimiter as PATH_DELIMITER } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { OLLAMA_URL } from '../config.js'
import { logger } from '../logger.js'
import {
  detectPaneState,
  decideSubmitFollowup,
  shouldClearTruncatedPreamble,
} from '../pane-state.js'
import { agentDir, readAgentModel, readAgentSecurityProfile, readAgentClaudeConfigDir, readAgentChannelProvider } from './agent-config.js'
import { parseTelegramToken } from './telegram.js'
import { getProvider, getProviderType, channelStateDir, readChannelToken, type ChannelProviderType } from '../channel-provider.js'
import { CHANNEL_PROVIDER } from '../config.js'
import { loadProfileTemplate } from './profiles.js'
import { writeAgentSettingsFromProfile } from './agent-scaffold.js'
import { getSecret } from './vault.js'
import { agentRuntime } from '../platform/agent-runtime.js'

function resolveAgentProvider(name: string): ChannelProviderType {
  const perAgent = readAgentChannelProvider(name)
  if (perAgent === 'slack' || perAgent === 'telegram') return perAgent
  return CHANNEL_PROVIDER
}

export function agentSessionName(name: string): string {
  return `agent-${name}`
}

export function isAgentRunning(name: string): boolean {
  return agentRuntime.hasSession(agentSessionName(name))
}

// Build the env block that the agent's claude process inherits. Mirrors
// the legacy `export X=... && export Y=...` chain that was baked into the
// tmux shell-command, just structured so the cross-platform runtime can
// pass it to spawn() directly (Windows ConPTY) or re-serialize into a
// shell `export` prefix (POSIX tmux).
function buildAgentEnv(opts: {
  dir: string
  agentChannelDir: string
  agentProvider: ChannelProviderType
  isOllama: boolean
  isDeepseek: boolean
  deepseekKey: string
  claudeConfigDir: string | null
}): Record<string, string> {
  const env: Record<string, string> = {}
  // Inherit the dashboard's env as the baseline, then layer agent-specific
  // overrides. We deliberately COPY rather than reference so deleting a
  // shadowed token below doesn't unset it in the dashboard process.
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v
  }
  // Prepend the same tool-search prefix the legacy shellCmd used so the
  // claude/bun discovery order is identical to the pre-refactor agent.
  // POSIX-only paths skip on Windows because:
  //  (a) `/opt/homebrew/bin:/usr/local/bin/...` joined with `;` (Windows
  //      PATH separator) creates a single invalid entry that breaks
  //      PATH lookup for non-prefix tools, and
  //  (b) Windows installs put claude.exe and bun.exe on PATH directly
  //      via the installer, so no prefix is needed.
  const home = process.env.HOME ?? homedir()
  const pathPrefix = process.platform === 'win32'
    ? []
    : ['/opt/homebrew/bin', `${home}/.bun/bin`, '/usr/local/bin', '/usr/bin', '/bin']
  if (pathPrefix.length > 0) {
    env.PATH = pathPrefix.join(PATH_DELIMITER) + (env.PATH ? PATH_DELIMITER + env.PATH : '')
  }
  // Strip channel tokens that would shadow per-agent state. The plugin
  // bootstraps its own token from ~/.claude/channels/<provider>/.env.
  delete env.TELEGRAM_BOT_TOKEN
  delete env.SLACK_BOT_TOKEN
  delete env.SLACK_APP_TOKEN
  const stateEnvVar = opts.agentProvider === 'slack' ? 'SLACK_STATE_DIR' : 'TELEGRAM_STATE_DIR'
  env[stateEnvVar] = opts.agentChannelDir
  if (opts.agentProvider === 'slack') {
    env.SLACK_AUDIT_LOG = join(opts.agentChannelDir, 'audit.jsonl')
  }
  if (opts.claudeConfigDir) env.CLAUDE_CONFIG_DIR = opts.claudeConfigDir
  if (opts.isOllama) {
    env.ANTHROPIC_AUTH_TOKEN = 'ollama'
    env.ANTHROPIC_BASE_URL = OLLAMA_URL
  }
  if (opts.isDeepseek) {
    env.ANTHROPIC_AUTH_TOKEN = opts.deepseekKey
    env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
  }
  return env
}

export function startAgentProcess(name: string): { ok: boolean; pid?: number; error?: string } {
  if (isAgentRunning(name)) return { ok: false, error: 'Agent is already running' }

  const dir = agentDir(name)
  if (!existsSync(dir)) return { ok: false, error: 'Agent not found' }

  const agentProvider = resolveAgentProvider(name)
  const provider = getProvider(agentProvider)
  const agentChannelDir = channelStateDir(agentProvider, dir)
  const token = readChannelToken(agentProvider, join(agentChannelDir, '.env'))
  // Backward compat: try legacy Telegram token if provider-aware lookup misses
  if (!token && agentProvider === 'telegram') {
    const legacyToken = parseTelegramToken(name)
    if (!legacyToken) return { ok: false, error: 'Channel not configured for this agent' }
  } else if (!token) {
    return { ok: false, error: `${provider.type} channel not configured for this agent` }
  }

  const session = agentSessionName(name)

  try {
    // Belt-and-braces session takedown: the isAgentRunning check above
    // would have returned early if the session was alive, but a stale
    // tmux session (process gone but tmux server still tracking) could
    // sit at the same name. killSession is a no-op when nothing's there.
    agentRuntime.killSession(session)
    agentRuntime.sleepSync(3000)

    const model = readAgentModel(name)
    const isClaude = model.startsWith('claude-')
    const isDeepseek = model.startsWith('deepseek-')
    const isOllama = !isClaude && !isDeepseek
    // DeepSeek's /anthropic base URL accepts the literal Anthropic SDK
    // request format, so Claude Code talks to it as if it were Anthropic.
    // We pull the API key from the encrypted vault (entry id: DEEPSEEK_API_KEY)
    // rather than process.env so operators can rotate it from the dashboard
    // without restarting. We do NOT fail-fast on missing key here -- a 401
    // from the upstream gives a clearer signal in the agent's pane than a
    // pre-flight error string the operator would have to dig out of logs.
    const deepseekKey = isDeepseek ? (getSecret('DEEPSEEK_API_KEY') ?? '') : ''
    // Apply security profile: write allow/deny list into settings.json, and
    // skip the dangerously-skip-permissions flag for strict profiles so
    // Claude Code enforces the list rather than bypassing it.
    const profile = loadProfileTemplate(readAgentSecurityProfile(name))
    writeAgentSettingsFromProfile(name, profile)
    // Optional per-agent CLAUDE_CONFIG_DIR (alternate Claude Code config dir,
    // e.g. for routing this agent to a separate Anthropic login). When the
    // agent-config field is missing or blank, claudeConfigDir is null and we
    // emit no export, preserving the default Claude Code behavior.
    const claudeConfigDir = readAgentClaudeConfigDir(name)
    // `--continue` requires an existing session; on a brand-new agent the
    // Claude Code projects directory does not yet exist and `claude` exits
    // immediately with an obscure "No deferred tool marker found" error
    // that is silent inside tmux. Detect first launch by probing for the
    // encoded project dir and skip `--continue` only then. The encoding
    // mirrors Claude Code's own scheme: replace every `/` with `-`.
    const projectsRoot = claudeConfigDir
      ? join(claudeConfigDir, 'projects')
      : join(homedir(), '.claude', 'projects')
    // Normalize separators before encoding so Windows paths (which contain
    // backslashes) match Claude Code's projects-dir key format. POSIX is
    // unaffected since paths only contain forward slashes.
    const encodedProject = dir.replace(/[\\/]/g, '-')
    const hasPriorSession = existsSync(join(projectsRoot, encodedProject))

    const env = buildAgentEnv({
      dir,
      agentChannelDir,
      agentProvider,
      isOllama,
      isDeepseek,
      deepseekKey,
      claudeConfigDir,
    })

    const claudeArgs: string[] = []
    if (hasPriorSession) claudeArgs.push('--continue')
    if (profile.permissionMode !== 'strict') claudeArgs.push('--dangerously-skip-permissions')
    claudeArgs.push('--model', model)
    claudeArgs.push('--channels', `plugin:${provider.pluginId}`)

    agentRuntime.startSession({
      name: session,
      cwd: dir,
      command: 'claude',
      args: claudeArgs,
      env,
      // Defense in depth on POSIX: even though buildAgentEnv already
      // `delete`-d these keys from `env`, a long-running tmux server may
      // hold them in its inherited globals. The shim emits `unset` for
      // these before our exports run, so a sub-agent never inherits the
      // main agent's channel token. See scripts/channels.sh:18-23 for
      // the leak path this defends against.
      unsetEnv: ['TELEGRAM_BOT_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
    })

    logger.info({ name, session, channelDir: agentChannelDir }, 'Agent session started')

    // After a restart with --continue, a session that's been idle for >24h
    // shows the "Resume from summary" modal before the prompt input is ready
    // (113.6k tokens at 2d age in observed cases). Until the operator either
    // sends a new prompt or dismisses the modal, every scheduled task and
    // every inter-agent message stalls because isSessionReadyForPrompt sees
    // a non-idle pane state. The pre-flight dismiss baked into
    // sendPromptToSession only fires on outgoing traffic -- so on a fresh
    // restart with no inbound, the modal can sit indefinitely.
    //
    // Fire a delayed dismiss after Claude Code has had time to render the
    // modal. 8 seconds is a comfortable margin in observed restarts (modal
    // typically appears within 4-6s). Survey-rating modals from prior
    // sessions can also be present, so dismiss both. Errors are swallowed
    // -- the outbound pre-flight remains the safety net if this misses.
    setTimeout(() => {
      try {
        dismissSurveyModalIfPresent(session)
        dismissResumeSummaryModalIfPresent(session)
      } catch (err) {
        logger.warn({ err, name, session }, 'Post-restart modal dismiss failed')
      }
    }, 8000)

    return { ok: true }
  } catch (err) {
    logger.error({ err, name }, 'Failed to start agent session')
    return { ok: false, error: 'Failed to start agent session' }
  }
}

export function stopAgentProcess(name: string): { ok: boolean; error?: string } {
  const session = agentSessionName(name)
  if (!isAgentRunning(name)) return { ok: false, error: 'Agent is not running' }

  try {
    agentRuntime.killSession(session)
    agentRuntime.sleepSync(2000)
    // Reap any orphaned plugin grandchildren the runtime didn't get.
    // The plugin writes its pid to the agent's channel state dir;
    // prefer that, fall back to an env-var-scoped pkill (POSIX only).
    try {
      const agentProvider = resolveAgentProvider(name)
      const dir = agentDir(name)
      const chanDir = channelStateDir(agentProvider, dir)
      const pidPath = join(chanDir, 'bot.pid')
      if (existsSync(pidPath)) {
        const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10)
        if (pid > 1) {
          try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
        }
      }
      if (process.platform !== 'win32') {
        const stateEnvVar = agentProvider === 'slack' ? 'SLACK_STATE_DIR' : 'TELEGRAM_STATE_DIR'
        execFileSync('/usr/bin/pkill', ['-f', `${stateEnvVar}=${chanDir}`], { timeout: 3000 })
      }
      // Windows orphan reap (Get-CimInstance Win32_Process + Stop-Process)
      // would go here. Deferred — the bot.pid path above is the primary
      // reaper and covers the common case.
    } catch { /* pkill returns non-zero if no match -- fine */ }
    logger.info({ name, session }, 'Agent session stopped')
    return { ok: true }
  } catch (err) {
    logger.error({ err, name, session }, 'Failed to stop agent session')
    return { ok: false, error: 'Failed to stop agent session' }
  }
}

export function getAgentProcessInfo(name: string): { running: boolean; session?: string } {
  const running = isAgentRunning(name)
  if (!running) return { running: false }
  return {
    running: true,
    session: agentSessionName(name),
  }
}

// Claude Code occasionally pops a "How is Claude doing this session? (optional)"
// rating modal above the prompt input. The footer line still reads
// "bypass permissions on (shift+tab to cycle)" so detectPaneState() classifies
// the pane as idle, but the modal swallows the next keystroke and pinches off
// every scheduled prompt + agent message until a human dismisses it. We strip
// it pre-flight by sending "0" (Dismiss) when the marker is visible, so any
// caller writing a prompt has a clear input field.
const SURVEY_MODAL_RX = /How is Claude doing this session/

function dismissSurveyModalIfPresent(session: string): void {
  try {
    const pane = agentRuntime.capture(session)
    if (pane == null || !SURVEY_MODAL_RX.test(pane)) return
    agentRuntime.sendKey(session, '0')
    // Modal close is one frame; settle window so the next keystroke lands
    // in the prompt input, not the now-stale modal handler.
    agentRuntime.sleepSync(300)
    logger.info({ session }, 'Dismissed Claude Code session-rating modal before sending prompt')
  } catch (err) {
    logger.warn({ err, session }, 'Failed to probe/dismiss session-rating modal')
  }
}

// When a session approaches its context limit Claude Code shows a "Resume from
// summary" modal with three numbered options and footer "Enter to confirm".
// detectPaneState() reads that footer as 'unknown' (not the usual "bypass
// permissions" string), so isSessionReadyForPrompt() refuses to deliver and
// every scheduled task / inter-agent message piles up behind it. Pre-flight
// pick option 1 (Resume from summary, recommended) and Enter to confirm.
const RESUME_SUMMARY_MODAL_RX = /Resume from summary/

function dismissResumeSummaryModalIfPresent(session: string): void {
  try {
    const pane = agentRuntime.capture(session)
    if (pane == null || !RESUME_SUMMARY_MODAL_RX.test(pane)) return
    agentRuntime.sendKey(session, '1')
    agentRuntime.sleepSync(100)
    agentRuntime.sendKey(session, 'Enter')
    // /compact starts immediately and can run for minutes; we only need to
    // unblock the modal so detectPaneState can transition off 'unknown'.
    agentRuntime.sleepSync(300)
    logger.info({ session }, 'Dismissed Claude Code resume-from-summary modal before sending prompt')
  } catch (err) {
    logger.warn({ err, session }, 'Failed to probe/dismiss resume-from-summary modal')
  }
}

// How many follow-up Enters sendPromptToSession() is willing to fire
// when the post-send capture says the prompt is still parked in the
// input box. Two retries cover the observed stuck-rate (single-pane
// recovery typically lands on the first or second extra Enter); a
// stuck-after-two-retries pane gets a logged give-up so the operator
// can intervene rather than the loop spinning indefinitely.
const SUBMIT_RETRY_MAX_ATTEMPTS = 2
// Wait between sending an Enter and re-capturing the pane. Long enough
// for the runtime to flush the keystroke into the Claude Code TUI and
// for the TUI to either transition to busy (turn started) or stay idle
// with the parked text (still stuck). Empirically 300ms is past the
// frame-render gap detectPaneState already guards against.
const SUBMIT_RETRY_POLL_MS = 300

// Buffer-clear (Ctrl-U) used pre-flight when shouldClearTruncatedPreamble
// flags a stale preamble in the live input box.
function clearInputBuffer(session: string): void {
  try {
    agentRuntime.sendKey(session, 'C-u')
    // Settle briefly so the next send-keys lands in the freshly cleared
    // buffer rather than racing the Ctrl-U.
    agentRuntime.sleepSync(100)
  } catch (err) {
    logger.warn({ err, session }, 'Failed to clear pane input buffer before send')
  }
}

// Send text to a session as if typed at the prompt.
//
// Pre-flight: if the live input box already shows a stale preamble from
// a previous wrapped message that never fully landed (shouldClearTrun-
// catedPreamble), Ctrl-U the buffer first so a fresh prompt is not
// concatenated onto the stale trust-marker. Skipping this guard would
// let an UNTRUSTED payload sit behind a stale TEAM MEMBER NOTICE
// preamble and read as if it came from a trusted peer.
//
// Post-flight: bracketed-paste detection and frame-level races in the
// Claude Code TUI occasionally swallow the trailing Enter, leaving the
// fully written prompt parked in the input box (either as a [Pasted
// text #N] placeholder or as verbatim text under an idle footer). We
// re-sample the pane after the initial Enter and, if shouldRetrySubmit
// still reports stuck, send up to SUBMIT_RETRY_MAX_ATTEMPTS extra
// Enters. The retry budget bounds the loop so a pathologically stuck
// pane gives up rather than spinning.
export function sendPromptToSession(session: string, text: string): void {
  dismissSurveyModalIfPresent(session)
  dismissResumeSummaryModalIfPresent(session)

  // Pre-flight buffer-clear when a stale preamble is detected. Reading
  // the pane is best-effort: a capture failure here means we cannot
  // prove the buffer is clean, but proceeding without the clear is no
  // worse than the pre-fix status quo.
  try {
    const preCapture = agentRuntime.capture(session)
    if (preCapture != null && shouldClearTruncatedPreamble(preCapture)) {
      logger.info({ session }, 'Cleared stale preamble from input buffer before sending prompt')
      clearInputBuffer(session)
    }
  } catch (err) {
    logger.warn({ err, session }, 'Pre-send capture failed; skipping truncated-preamble check')
  }

  const oneLine = text.replace(/\r?\n/g, ' ')
  agentRuntime.sendText(session, oneLine)
  agentRuntime.sendKey(session, 'Enter')

  // Post-send retry loop. The payload hint is the first chunk of oneLine
  // (truncated to a safe length) so the verbatim-stuck path has something
  // recognisable to substring-match against without leaking the whole
  // prompt body into log lines should the give-up branch fire.
  const payloadHint = oneLine.slice(0, Math.min(oneLine.length, 96))
  for (let attempt = 0; ; attempt++) {
    agentRuntime.sleepSync(SUBMIT_RETRY_POLL_MS)
    const pane = capturePane(session)
    const action = decideSubmitFollowup(pane, payloadHint, attempt, SUBMIT_RETRY_MAX_ATTEMPTS)
    if (action === 'done') break
    if (action === 'give-up') {
      logger.warn({ session, attempt }, 'sendPromptToSession: prompt still parked after retries')
      break
    }
    // action === 'retry-enter'
    try {
      agentRuntime.sendKey(session, 'Enter')
    } catch (err) {
      logger.warn({ err, session, attempt }, 'Retry-Enter send failed')
      break
    }
  }
}

// How long to wait between the two capture samples when the first one
// looks idle. The Claude Code UI renders the "idle footer without `esc
// to interrupt`" line for ~1 frame after a turn submits before the
// spinner lands; a quarter-second settle window is well past that.
const PANE_READY_CONFIRM_DELAY_MS = 250

// Capture a pane snapshot. Null on any error so the caller can treat
// "capture failed" as "not ready".
export function capturePane(session: string): string | null {
  return agentRuntime.capture(session)
}

// Check if a Claude Code session is ready to accept a new prompt.
//
// The detection has two layers, both needed to close the frame-level
// false-positive that let PR1+PR2's smoke test fire a prompt into a pane
// that was actually mid-thinking:
//
//   1. detectPaneState() looks for a set of turn-scoped busy signals
//      (spinner glyph labels paired with the runtime tail, token-count
//      pattern, and the footer's `esc to interrupt` marker) so even the
//      single frame where the footer lacks `· esc to interrupt` is
//      classified busy by the spinner that is already rendered above
//      the input box.
//
//   2. Double-sample confirmation: if the first capture looks idle, we
//      sleep 250ms and re-capture. Only agreement from both samples
//      returns true. Cost on the ready path: ~250ms sleep plus a second
//      capture round-trip (typically tens of ms). Busy pass through
//      layer 1 and return immediately without the delay.
export function isSessionReadyForPrompt(session: string): boolean {
  const first = capturePane(session)
  if (first == null) return false
  if (detectPaneState(first) !== 'idle') return false

  agentRuntime.sleepSync(PANE_READY_CONFIRM_DELAY_MS)

  const second = capturePane(session)
  if (second == null) return false
  return detectPaneState(second) === 'idle'
}
