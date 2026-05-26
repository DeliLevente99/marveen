// Discord channel-group bootstrap.
//
// When CHANNEL_PROVIDER=discord, the plugin's outbound `reply` tool gates
// server-channel sends on `access.groups[channelId]` (channel-scoped),
// while DMs gate on `access.allowFrom` (user-scoped). The `/discord:access
// pair <code>` skill only populates `allowFrom`, so a fresh install where
// the operator wants the bot to reply in a SERVER channel (not a DM) still
// gets "channel <id> is not allowlisted -- add via /discord:access" until
// the operator manually runs `/discord:access group add <channelId>`.
//
// When DISCORD_CHANNEL_ID is set in the project .env (the operator already
// picked the target channel) we can avoid that manual step by inserting
// the entry on dashboard boot. Boot is also the right point: the plugin
// re-reads access.json on every read, and we want the entry present before
// the first inbound message arrives.
//
// No-op when:
//  - CHANNEL_PROVIDER is not 'discord'
//  - DISCORD_CHANNEL_ID is unset/empty
//  - the group entry is already present (idempotent)
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CHANNEL_PROVIDER, CHANNEL_CHAT_ID } from '../config.js'
import { channelStateDir } from '../channel-provider.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { logger } from '../logger.js'

interface AccessFile {
  dmPolicy?: 'pairing' | 'allowlist' | 'disabled'
  allowFrom?: string[]
  groups?: Record<string, { requireMention?: boolean; allowFrom?: string[] }>
  pending?: Record<string, unknown>
  invites?: Record<string, unknown>
}

export function ensureDiscordChannelGroup(): void {
  if (CHANNEL_PROVIDER !== 'discord') return
  if (!CHANNEL_CHAT_ID) return
  const dir = channelStateDir('discord')
  const path = join(dir, 'access.json')

  let access: AccessFile
  if (existsSync(path)) {
    try {
      access = JSON.parse(readFileSync(path, 'utf-8'))
    } catch {
      // Corrupt file -- safer to leave alone than overwrite.
      logger.warn({ path }, 'discord-group-bootstrap: access.json unparseable, skipping')
      return
    }
  } else {
    access = { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
  }

  access.groups = access.groups ?? {}
  if (CHANNEL_CHAT_ID in access.groups) return

  access.groups[CHANNEL_CHAT_ID] = { requireMention: false, allowFrom: [] }
  mkdirSync(dir, { recursive: true })
  atomicWriteFileSync(path, JSON.stringify(access, null, 2))
  logger.info({ channelId: CHANNEL_CHAT_ID }, 'discord-group-bootstrap: added channel to access.groups')
}

// Ensure the plugin's .env carries DISCORD_SUPPRESS_PAIRING_REPLY=1 so
// the (MARVEEN-PATCH'd) plugin skips the "Pairing required -- run
// /discord:access pair XXXXXX" auto-reply to the unknown sender.
// Marveen's operator-notification path drives approval out-of-band;
// the sender-side hint is confusing and unnecessary. No-op when:
//  - CHANNEL_PROVIDER is not 'discord'
//  - the env line is already present (idempotent line-replace, no churn)
export function ensureDiscordSuppressPairingReply(): void {
  if (CHANNEL_PROVIDER !== 'discord') return
  const envPath = join(channelStateDir('discord'), '.env')
  let content = ''
  try { content = readFileSync(envPath, 'utf-8') } catch { /* missing -- write fresh below */ }
  const matchRe = /^DISCORD_SUPPRESS_PAIRING_REPLY=.*$/m
  if (matchRe.test(content)) {
    if (/^DISCORD_SUPPRESS_PAIRING_REPLY=1$/m.test(content)) return // already set
    content = content.replace(matchRe, 'DISCORD_SUPPRESS_PAIRING_REPLY=1')
  } else {
    // Append, preserving the trailing newline convention.
    if (content && !content.endsWith('\n')) content += '\n'
    content += 'DISCORD_SUPPRESS_PAIRING_REPLY=1\n'
  }
  mkdirSync(join(envPath, '..'), { recursive: true })
  atomicWriteFileSync(envPath, content, { mode: 0o600 })
  logger.info({ envPath }, 'discord-group-bootstrap: ensured DISCORD_SUPPRESS_PAIRING_REPLY=1 in plugin .env')
}
