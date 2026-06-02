// Channel invite tokens for one-click pairing.
//
// Flow:
// 1. Operator generates an invite via POST /api/agents/:name/channels/:provider/invites.
//    The token + expiry is stored in invites.json (a sidecar next to access.json).
//    access.json's dmPolicy is flipped to 'pairing' so the channel plugin will
//    actually issue codes for unknown senders during the validity window.
// 2. The invitee opens the deep-link (Telegram: t.me/<bot>?start=invite-TOKEN, Slack: CLI pair),
//    the plugin creates a pending entry in access.json (standard pairing behaviour).
// 3. This monitor (started in src/index.ts) polls both files every few seconds.
//    When it sees a pending entry in access.json while at least one non-used,
//    non-expired invite token exists in invites.json, it auto-approves the entry:
//    marks the token used (in invites.json), moves the senderId into allowFrom
//    (in access.json), drops the pending row, restores allowlist policy if no
//    other invites are still active.
//
// Why a sidecar file: access.json is co-owned by the channel plugin (e.g.
// telegram@claude-plugins-official). That plugin rewrites access.json from its
// own schema on every pairing event and does NOT preserve unknown keys, so an
// `invites` map written into access.json gets silently wiped the moment an
// invitee triggers a pending entry. Storing tokens in invites.json — which the
// plugin never reads or writes — keeps them safe across plugin saves.
//
// The invite-token is a "shared secret" that grants exactly one auto-approve.
// Tokens are 16 random bytes (base64url, ~22 chars), unguessable in practice.
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { logger } from '../logger.js'
import { channelStateDir, readChannelToken, type ChannelProviderType } from '../channel-provider.js'
import { agentDir } from './agent-config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { WEB_PORT, WEB_HOST, PROJECT_ROOT } from '../config.js'
import { loadOrCreateDashboardToken } from './dashboard-auth.js'
import { mintApproveToken } from './discord-approve-tokens.js'

interface InviteEntry {
  createdAt: number
  expiresAt: number
  used: boolean
  usedBy?: string
  usedAt?: number
}

// access.json is co-owned by the channel plugin. We only ever touch the fields
// the plugin also understands (dmPolicy, allowFrom, pending); invite tokens live
// in the sidecar InvitesFile so the plugin can't clobber them.
interface AccessFile {
  dmPolicy?: 'pairing' | 'allowlist' | 'disabled'
  allowFrom?: string[]
  groups?: Record<string, unknown>
  pending?: Record<string, { senderId: string; chatId: string; createdAt: number; expiresAt: number; replies?: number }>
}

interface InvitesFile {
  invites?: Record<string, InviteEntry>
}

const INVITE_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

export function agentChannelDir(name: string, mainAgentId: string, provider: ChannelProviderType): string {
  return name === mainAgentId
    ? channelStateDir(provider)
    : channelStateDir(provider, agentDir(name))
}

// invites.json sits next to access.json in the same channel state dir.
function invitesPathFor(accessPath: string): string {
  return join(accessPath, '..', 'invites.json')
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

function readInvites(path: string): InvitesFile {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as InvitesFile
  } catch {
    return {}
  }
}

function writeInvites(path: string, data: InvitesFile): void {
  mkdirSync(join(path, '..'), { recursive: true })
  atomicWriteFileSync(path, JSON.stringify(data, null, 2))
}

function pruneInvites(store: InvitesFile, now: number): boolean {
  if (!store.invites) return false
  let mutated = false
  for (const [token, inv] of Object.entries(store.invites)) {
    if (inv.expiresAt < now && !inv.used) {
      delete store.invites[token]
      mutated = true
    }
  }
  return mutated
}

function activeInviteCount(store: InvitesFile, now: number): number {
  if (!store.invites) return 0
  let n = 0
  for (const inv of Object.values(store.invites)) {
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
  const invitesPath = invitesPathFor(accessPath)
  const store = readInvites(invitesPath)
  const now = Date.now()
  pruneInvites(store, now)

  const token = randomBytes(16).toString('base64url').slice(0, 22)
  const entry: InviteEntry = {
    createdAt: now,
    expiresAt: now + ttlMs,
    used: false,
  }
  store.invites = store.invites || {}
  store.invites[token] = entry
  writeInvites(invitesPath, store)

  // Flip dmPolicy to 'pairing' so the plugin issues codes for unknown senders
  // during the validity window. This is the one field we must set in access.json;
  // the plugin preserves it across its own writes.
  const access = readAccess(accessPath)
  if (access.dmPolicy !== 'disabled') {
    access.dmPolicy = 'pairing'
    writeAccess(accessPath, access)
  }

  let deepLink: string | undefined
  if (provider === 'telegram' && botUsername) {
    const cleanUsername = botUsername.replace(/^@/, '')
    deepLink = `https://t.me/${cleanUsername}?start=invite-${token}`
  }
  return { token, expiresAt: entry.expiresAt, deepLink }
}

export function listInvites(accessPath: string): Array<{ token: string; createdAt: number; expiresAt: number; used: boolean; usedBy?: string; deepLink?: string }> {
  const invitesPath = invitesPathFor(accessPath)
  const store = readInvites(invitesPath)
  const now = Date.now()
  if (pruneInvites(store, now)) writeInvites(invitesPath, store)
  if (!store.invites) return []
  return Object.entries(store.invites).map(([token, inv]) => ({
    token,
    createdAt: inv.createdAt,
    expiresAt: inv.expiresAt,
    used: inv.used,
    usedBy: inv.usedBy,
  }))
}

export function revokeInvite(accessPath: string, token: string): boolean {
  const invitesPath = invitesPathFor(accessPath)
  const store = readInvites(invitesPath)
  if (!store.invites?.[token]) return false
  delete store.invites[token]
  writeInvites(invitesPath, store)
  if (activeInviteCount(store, Date.now()) === 0) {
    const access = readAccess(accessPath)
    if (access.dmPolicy === 'pairing') {
      access.dmPolicy = 'allowlist'
      writeAccess(accessPath, access)
    }
  }
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
      const invitesPath = invitesPathFor(accessPath)
      const store = readInvites(invitesPath)
      // Discord has no invites.json (the install seeds invites only for
      // Telegram), but its pendings still need the operator-notify path.
      // So DON'T bail on a missing invites store -- treat it as empty and
      // fall through to the no-live-invites branch, which carries the
      // Discord notification logic. Telegram/Slack with a real store keep
      // their auto-approve behaviour below.
      if (!store.invites) store.invites = {}

      const access = readAccess(accessPath)
      const now = Date.now()
      if (pruneInvites(store, now)) writeInvites(invitesPath, store)

      const live = Object.entries(store.invites)
        .filter(([, inv]) => !inv.used && inv.expiresAt >= now)
        .sort((a, b) => a[1].createdAt - b[1].createdAt)
      if (live.length === 0) {
        if (activeInviteCount(store, now) === 0 && access.dmPolicy === 'pairing') {
          access.dmPolicy = 'allowlist'
          writeAccess(accessPath, access)
        }
        // No live invites but pendings may still exist -- operator needs
        // a DM to know they have to /discord:access approve manually.
        // Re-read the operator id from .env (see the call site below for
        // the boot-cached-constant rationale).
        if (provider === 'discord' && name === mainAgentId) {
          const operatorId = readOperatorDiscordUserId()
          if (operatorId) {
            const pendingEntries = Object.entries(access.pending || {})
              .sort((a, b) => a[1].createdAt - b[1].createdAt)
            if (pendingEntries.length > 0) notifyDiscordPendingsToOperator(accessPath, pendingEntries, operatorId)
          }
        }
        continue
      }

      const pendingEntries = Object.entries(access.pending || {})
        .sort((a, b) => a[1].createdAt - b[1].createdAt)
      if (pendingEntries.length === 0) continue

      const [pCode, pEntry] = pendingEntries[0]
      const [tToken, tEntry] = live[0]

      if (!access.allowFrom) access.allowFrom = []
      if (!access.allowFrom.includes(pEntry.senderId)) access.allowFrom.push(pEntry.senderId)
      if (access.pending) delete access.pending[pCode]

      tEntry.used = true
      tEntry.usedBy = pEntry.senderId
      tEntry.usedAt = now

      if (activeInviteCount(store, now) === 0) access.dmPolicy = 'allowlist'

      try {
        const approvedDir = join(accessPath, '..', 'approved')
        mkdirSync(approvedDir, { recursive: true })
        writeFileSync(join(approvedDir, pEntry.senderId), '')
      } catch (err) {
        logger.warn({ err, name, senderId: pEntry.senderId }, 'invite-monitor: failed to write approved marker')
      }

      writeAccess(accessPath, access)
      writeInvites(invitesPath, store)
      logger.info({ name, provider, senderId: pEntry.senderId, token: tToken }, 'Channel invite auto-approved')

      // Discord operator-DM notification: the bot DMs the operator with
      // a dashboard approve link for each new pending request. Only fires
      // for the main agent (Marveen) + Discord provider + when the
      // operator's user ID is configured. The notification goes through
      // the channels-session claude (sendPromptToSession), which then
      // invokes the discord plugin's reply tool to actually deliver the
      // DM. We track already-notified codes in-memory to avoid spamming
      // claude on every 3s tick.
      if (provider === 'discord' && name === mainAgentId) {
        // Re-read .env each tick instead of importing the boot-cached
        // constant: the operator typically saves OPERATOR_DISCORD_USER_ID
        // via the dashboard UI AFTER the dashboard has booted, so the
        // in-process config.ts value is stale at the first save -- the
        // /api/marveen/channels/discord/operator-id endpoint writes the
        // .env directly. (The cached const would force a dashboard
        // restart after every operator-id change.)
        const operatorId = readOperatorDiscordUserId()
        if (operatorId) notifyDiscordPendingsToOperator(accessPath, pendingEntries, operatorId)
      }
    }
  }
}

// Per-accessPath set of pending codes we have already DM-d the operator
// about. In-memory only -- a dashboard restart re-notifies for unresolved
// pendings (acceptable: better re-ping than miss).
const notifiedOperatorCodes = new Map<string, Set<string>>()

function notifyDiscordPendingsToOperator(
  accessPath: string,
  pendingEntries: Array<[string, { senderId: string; chatId: string; createdAt: number; expiresAt: number; groupChannelId?: string }]>,
  operatorId: string,
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
    const approveToken = mintApproveToken(code, entry.senderId)
    const url = `http://${WEB_HOST}:${WEB_PORT}/?token=${dashboardToken}&approve_token=${approveToken}`
    // Make the source unambiguous: a server-channel request reads very
    // differently from a private DM request. The old "Új <context> kéri
    // user@..." phrasing sounded like someone was DMing privately even
    // when the request came from a public channel.
    const where = entry.groupChannelId
      ? `a(z) <#${entry.groupChannelId}> csatornában`
      : 'privát üzenetben (DM)'
    const text =
      `<@${entry.senderId}> hozzáférést kér ${where}. ` +
      `Engedélyezed, hogy a bot válaszoljon neki? ` +
      `Jóváhagyás (5 percig él): ${url}`
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
