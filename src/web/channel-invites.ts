// Channel invite tokens for one-click pairing.
//
// Flow:
// 1. Operator generates an invite via POST /api/agents/:name/channels/:provider/invites.
//    The token + expiry is stored in access.json under `invites`.
//    If dmPolicy was 'allowlist', it is flipped to 'pairing' so the bot will
//    actually issue codes for unknown senders during the validity window.
// 2. The invitee opens the deep-link (Telegram: t.me/?start=TOKEN, Slack: CLI pair),
//    the plugin creates a pending entry in access.json (standard pairing behaviour).
// 3. This monitor (started in src/index.ts) polls access.json files every
//    few seconds. When it sees a pending entry land while at least one
//    non-used, non-expired invite token exists for that agent, it
//    auto-approves the entry: marks the token used, moves the senderId
//    into allowFrom, drops the pending row, restores allowlist policy if
//    no other invites are still active.
//
// The invite-token is a "shared secret" that grants exactly one auto-approve.
// Tokens are 16 random bytes (base64url, ~22 chars), unguessable in practice.
//
// First-pair TOFU (trust-on-first-use):
// As a fallback when no live invites exist and allowFrom is still empty
// (truly fresh install — operator never paired anyone), the monitor
// approves the first pending entry it sees, provided dmPolicy is
// 'pairing' and exactly one pending entry exists. This makes the
// Windows install usable without the install.sh-issued invite that the
// POSIX path relies on. Trust model: whoever DMs the freshly-installed
// bot first is the operator. The risk window is "between bot install
// and operator's first DM"; the bot token file is owner-only ACL'd at
// install time so an attacker cannot easily acquire it. Once allowFrom
// is populated the TOFU branch is dead permanently for that bot.
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { logger } from '../logger.js'
import { channelStateDir, readChannelToken, type ChannelProviderType } from '../channel-provider.js'
import { agentDir } from './agent-config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { WEB_PORT, WEB_HOST, PROJECT_ROOT, MAIN_AGENT_ID } from '../config.js'
import { loadOrCreateDashboardToken } from './dashboard-auth.js'
import { mintApproveToken } from './discord-approve-tokens.js'

interface InviteEntry {
  createdAt: number
  expiresAt: number
  used: boolean
  usedBy?: string
  usedAt?: number
}

interface AccessFile {
  dmPolicy?: 'pairing' | 'allowlist' | 'disabled'
  allowFrom?: string[]
  groups?: Record<string, unknown>
  pending?: Record<string, { senderId: string; chatId: string; createdAt: number; expiresAt: number; replies?: number }>
  invites?: Record<string, InviteEntry>
}

const INVITE_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

export function agentChannelDir(name: string, mainAgentId: string, provider: ChannelProviderType): string {
  return name === mainAgentId
    ? channelStateDir(provider)
    : channelStateDir(provider, agentDir(name))
}

function readAccess(path: string): AccessFile {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as AccessFile
  } catch {
    return {}
  }
}

function writeAccess(path: string, data: AccessFile): void {
  mkdirSync(join(path, '..'), { recursive: true })
  atomicWriteFileSync(path, JSON.stringify(data, null, 2))
}

function pruneInvites(access: AccessFile, now: number): boolean {
  if (!access.invites) return false
  let mutated = false
  for (const [token, inv] of Object.entries(access.invites)) {
    if (inv.expiresAt < now && !inv.used) {
      delete access.invites[token]
      mutated = true
    }
  }
  return mutated
}

function activeInviteCount(access: AccessFile, now: number): number {
  if (!access.invites) return 0
  let n = 0
  for (const inv of Object.values(access.invites)) {
    if (!inv.used && inv.expiresAt >= now) n++
  }
  return n
}

export interface CreateInviteResult {
  token: string
  expiresAt: number
  deepLink?: string
}

export function createInvite(
  accessPath: string,
  botUsername: string | undefined,
  provider: ChannelProviderType = 'telegram',
  ttlMs: number = INVITE_DEFAULT_TTL_MS,
): CreateInviteResult {
  const access = readAccess(accessPath)
  const now = Date.now()
  pruneInvites(access, now)

  const token = randomBytes(16).toString('base64url').slice(0, 22)
  const entry: InviteEntry = {
    createdAt: now,
    expiresAt: now + ttlMs,
    used: false,
  }
  access.invites = access.invites || {}
  access.invites[token] = entry

  if (access.dmPolicy !== 'disabled') access.dmPolicy = 'pairing'

  writeAccess(accessPath, access)

  let deepLink: string | undefined
  if (provider === 'telegram' && botUsername) {
    deepLink = `https://t.me/${botUsername}?start=invite-${token}`
  }
  return { token, expiresAt: entry.expiresAt, deepLink }
}

export function listInvites(accessPath: string): Array<{ token: string; createdAt: number; expiresAt: number; used: boolean; usedBy?: string; deepLink?: string }> {
  const access = readAccess(accessPath)
  const now = Date.now()
  if (pruneInvites(access, now)) writeAccess(accessPath, access)
  if (!access.invites) return []
  return Object.entries(access.invites).map(([token, inv]) => ({
    token,
    createdAt: inv.createdAt,
    expiresAt: inv.expiresAt,
    used: inv.used,
    usedBy: inv.usedBy,
  }))
}

export function revokeInvite(accessPath: string, token: string): boolean {
  const access = readAccess(accessPath)
  if (!access.invites?.[token]) return false
  delete access.invites[token]
  if (activeInviteCount(access, Date.now()) === 0) {
    access.dmPolicy = 'allowlist'
  }
  writeAccess(accessPath, access)
  return true
}

export function runInviteMonitorTick(mainAgentId: string, agentsRoot: string): void {
  const providerTypes: ChannelProviderType[] = ['telegram', 'slack', 'discord']

  for (const provider of providerTypes) {
    const targets: Array<{ name: string; accessPath: string }> = []
    const mainAccess = join(channelStateDir(provider), 'access.json')
    if (existsSync(mainAccess)) targets.push({ name: mainAgentId, accessPath: mainAccess })
    if (existsSync(agentsRoot)) {
      let entries: string[]
      try { entries = readdirSync(agentsRoot) } catch { entries = [] }
      for (const e of entries) {
        const p = join(channelStateDir(provider, join(agentsRoot, e)), 'access.json')
        if (existsSync(p)) targets.push({ name: e, accessPath: p })
      }
    }

    for (const { name, accessPath } of targets) {
      const access = readAccess(accessPath)
      if (!access.pending || Object.keys(access.pending).length === 0) continue

      const now = Date.now()
      const expiredOrUsed = pruneInvites(access, now)

      const live = access.invites
        ? Object.entries(access.invites)
            .filter(([, inv]) => !inv.used && inv.expiresAt >= now)
            .sort((a, b) => a[1].createdAt - b[1].createdAt)
        : []

      const pendingEntries = Object.entries(access.pending)
        .sort((a, b) => a[1].createdAt - b[1].createdAt)

      if (live.length > 0) {
        // Invite-based path: at least one live invite means the operator
        // is intentionally accepting a paired peer. Approve the oldest
        // pending entry against the oldest live invite.
        const [pCode, pEntry] = pendingEntries[0]
        const [tToken, tEntry] = live[0]

        if (!access.allowFrom) access.allowFrom = []
        if (!access.allowFrom.includes(pEntry.senderId)) access.allowFrom.push(pEntry.senderId)
        delete access.pending[pCode]

        tEntry.used = true
        tEntry.usedBy = pEntry.senderId
        tEntry.usedAt = now

        if (activeInviteCount(access, now) === 0) access.dmPolicy = 'allowlist'

        try {
          const approvedDir = join(accessPath, '..', 'approved')
          mkdirSync(approvedDir, { recursive: true })
          writeFileSync(join(approvedDir, pEntry.senderId), '')
        } catch (err) {
          logger.warn({ err, name, senderId: pEntry.senderId }, 'invite-monitor: failed to write approved marker')
        }

        writeAccess(accessPath, access)
        logger.info({ name, provider, senderId: pEntry.senderId, token: tToken }, 'Channel invite auto-approved')
        continue
      }

      // No live invites. Fall through to TOFU first-pair: allow only
      // when truly fresh (allowFrom empty, dmPolicy=pairing, exactly
      // one pending). Restoring allowlist policy as the very first step
      // would prematurely kill TOFU on a fresh install whose pruned
      // invites had expired -- defer until we've decided.
      const allowEmpty = (access.allowFrom?.length ?? 0) === 0
      const tofuEligible = allowEmpty && access.dmPolicy === 'pairing' && pendingEntries.length === 1
      if (tofuEligible) {
        const [pCode, pEntry] = pendingEntries[0]
        access.allowFrom = [pEntry.senderId]
        delete access.pending[pCode]
        try {
          const approvedDir = join(accessPath, '..', 'approved')
          mkdirSync(approvedDir, { recursive: true })
          writeFileSync(join(approvedDir, pEntry.senderId), '')
        } catch (err) {
          logger.warn({ err, name, senderId: pEntry.senderId }, 'invite-monitor: failed to write TOFU approved marker')
        }
        writeAccess(accessPath, access)
        logger.info({ name, provider, senderId: pEntry.senderId }, 'Channel first-pair auto-approved (TOFU): no live invites, allowlist was empty')
        continue
      }

      // Not TOFU-eligible (allowFrom already populated, or multiple
      // pending, or dmPolicy not "pairing") and no live invites.
      // Restore allowlist policy if we just pruned the last invite.
      if (expiredOrUsed && activeInviteCount(access, now) === 0 && access.dmPolicy === 'pairing') {
        access.dmPolicy = 'allowlist'
        writeAccess(accessPath, access)
      }

      // Discord operator-DM notification: the bot DMs the operator with
      // a dashboard approve link for each new pending request. Only fires
      // for the main agent (Marveen) + Discord provider + when the
      // operator's user ID is configured. The notification goes through
      // the channels-session claude (sendPromptToSession), which then
      // invokes the discord plugin's reply tool to actually deliver the
      // DM. We track already-notified codes in-memory to avoid spamming
      // claude on every 3s tick.
      if (provider === 'discord') {
        // Re-read .env each tick instead of importing the boot-cached
        // constant: the operator typically saves OPERATOR_DISCORD_USER_ID
        // via the dashboard UI AFTER the dashboard has booted, so the
        // in-process config.ts value is stale at the first save -- the
        // /api/marveen/channels/discord/operator-id endpoint writes the
        // .env directly. (The cached const would force a dashboard
        // restart after every operator-id change.)
        // Notify for every Discord-configured agent's pending entries
        // (main + sub-agents). The same operator owns all of them; the
        // approve token carries the agent name so the approve endpoint
        // mutates the correct per-agent access.json.
        const operatorId = readOperatorDiscordUserId()
        if (operatorId) notifyDiscordPendingsToOperator(accessPath, pendingEntries, operatorId, name)
      }
    }
  }
}

// Per-accessPath set of pending codes we've already DM'd the operator
// about. In-memory only -- a dashboard restart re-notifies the operator
// for unresolved pendings (acceptable: better re-ping than miss).
const notifiedOperatorCodes = new Map<string, Set<string>>()

function notifyDiscordPendingsToOperator(
  accessPath: string,
  pendingEntries: Array<[string, { senderId: string; chatId: string; createdAt: number; expiresAt: number; groupChannelId?: string }]>,
  operatorId: string,
  agentName: string,
): void {
  let notified = notifiedOperatorCodes.get(accessPath)
  if (!notified) {
    notified = new Set<string>()
    notifiedOperatorCodes.set(accessPath, notified)
  }
  for (const [code, entry] of pendingEntries) {
    if (notified.has(code)) continue
    // Skip if the sender IS the operator (don't DM yourself).
    if (entry.senderId === operatorId) continue
    const dashboardToken = (() => { try { return loadOrCreateDashboardToken() } catch { return '' } })()
    const approveToken = mintApproveToken(code, entry.senderId, agentName)
    const url = `http://${WEB_HOST}:${WEB_PORT}/?token=${dashboardToken}&approve_token=${approveToken}`
    const context = entry.groupChannelId
      ? `szerver csatorna <#${entry.groupChannelId}>`
      : 'DM'
    // For sub-agents the operator needs to know WHICH bot got the
    // request -- "Marveen-en" vs "discord-asszisztens-en". Main agent
    // notifications stay terse (we omit the redundant agent label).
    const target = agentName === MAIN_AGENT_ID ? '' : ` (${agentName})`
    const text = `Új ${context} kéri user@${entry.senderId}${target} (code: ${code}). Jóváhagyás (5 perc): ${url}`
    // Fire-and-forget so a Discord API stall doesn't block the tick.
    // notified.add stays in the promise chain so a failed call retries
    // on the next 3s tick.
    sendDiscordDM(operatorId, text).then(() => {
      notified!.add(code)
      logger.info({ code, senderId: entry.senderId, operator: operatorId }, 'discord: operator notification DM sent')
    }).catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err), code }, 'discord: failed to send operator notification DM')
    })
  }
}

// Direct Discord REST API DM. Bypasses the channels-session claude (which
// reads our notification prompt but can't be relied on to call the MCP
// tool deterministically -- observed: claude folds the notification into
// a scheduled-task response instead of invoking reply_to_user). Two
// hops: create-DM-channel + send-message.
async function sendDiscordDM(userId: string, content: string): Promise<void> {
  const envPath = join(channelStateDir('discord'), '.env')
  const token = readChannelToken('discord', envPath)
  if (!token) throw new Error('DISCORD_BOT_TOKEN missing at ' + envPath)

  const headers = {
    Authorization: `Bot ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'Marveen/0 (operator-notify; +https://github.com/Szotasz/marveen)',
  }
  // Step 1: open (or get existing) DM channel with the recipient.
  const openRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
    method: 'POST',
    headers,
    body: JSON.stringify({ recipient_id: userId }),
  })
  if (!openRes.ok) {
    const body = await openRes.text().catch(() => '')
    throw new Error(`open-DM HTTP ${openRes.status}: ${body.slice(0, 200)}`)
  }
  const channel = await openRes.json() as { id?: string }
  if (!channel.id) throw new Error('open-DM response missing channel id')

  // Step 2: send the message.
  const sendRes = await fetch(`https://discord.com/api/v10/channels/${channel.id}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content }),
  })
  if (!sendRes.ok) {
    const body = await sendRes.text().catch(() => '')
    throw new Error(`send-message HTTP ${sendRes.status}: ${body.slice(0, 200)}`)
  }
}

// Dynamic re-read of OPERATOR_DISCORD_USER_ID from project .env. See the
// comment in the call site for the boot-cached-constant rationale.
function readOperatorDiscordUserId(): string {
  try {
    const content = readFileSync(join(PROJECT_ROOT, '.env'), 'utf-8')
    const m = content.match(/^OPERATOR_DISCORD_USER_ID=(.+)$/m)
    return (m?.[1] ?? '').trim()
  } catch {
    return ''
  }
}

let inviteMonitorInterval: NodeJS.Timeout | null = null

export function startInviteMonitor(mainAgentId: string, agentsRoot: string, intervalMs = 3000): void {
  if (inviteMonitorInterval) return
  try { runInviteMonitorTick(mainAgentId, agentsRoot) } catch (err) {
    logger.error({ err }, 'invite-monitor first tick failed')
  }
  inviteMonitorInterval = setInterval(() => {
    try {
      runInviteMonitorTick(mainAgentId, agentsRoot)
    } catch (err) {
      logger.error({ err }, 'invite-monitor tick failed')
    }
  }, intervalMs)
  logger.info({ intervalMs }, 'Channel invite monitor started')
}

export function stopInviteMonitor(): void {
  if (inviteMonitorInterval) {
    clearInterval(inviteMonitorInterval)
    inviteMonitorInterval = null
  }
}
