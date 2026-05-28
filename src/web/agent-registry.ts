// Agent registry: enumerate every agent (main + sub-agents) and read
// each one's per-provider .env to expose the public coordination
// fields — bot ID and channel ID per provider.
//
// Why this exists: inter-agent messaging on /api/messages routes
// through SQLite + the message-router (drops the prompt into the
// target's TUI). For an agent to ALSO reference another agent on
// Discord/Telegram (e.g. mention <@bot-id> in a user-visible reply),
// it needs to know the target's bot ID. The bot tokens themselves
// stay private (this module never returns them), but the bot ID is
// trivially derivable from the token's first segment and is already
// public information on the target's Discord profile, so exposing it
// via the dashboard API is safe.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { MAIN_AGENT_ID } from '../config.js'
import { agentDir, listAgentNames } from './agent-config.js'
import type { ChannelProviderType } from '../channel-provider.js'

export interface RegistryProviderInfo {
  /** Numeric bot user ID. Derived from the token, never the token itself. */
  botId: string | null
  /** The channel / chat / room the bot considers "home" for this operator. */
  channelId: string | null
}

export interface RegistryEntry {
  name: string
  isMain: boolean
  discord?: RegistryProviderInfo
  telegram?: RegistryProviderInfo
  slack?: RegistryProviderInfo
}

// Parse a .env file into a flat key → value map. Lines starting with `#`
// or blank are skipped. Surrounding quotes on values are stripped. Kept
// permissive (no schema enforcement) so a malformed line elsewhere in
// the file does not blow away the keys we actually care about.
function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  let raw: string
  try { raw = readFileSync(path, 'utf-8') } catch { return {} }
  const out: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const k = trimmed.slice(0, eq).trim()
    let v = trimmed.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    out[k] = v
  }
  return out
}

// Discord bot tokens are formatted `<base64url(userId)>.<base64url(ts)>.<hmac>`
// (sometimes with extra segments inserted between userId and ts on newer
// tokens). The first segment decodes to the numeric bot user ID. We do NOT
// validate the rest — we only need the ID, and Discord's user-ID format
// (snowflake: ASCII digits, up to 19 chars) gives us a cheap sanity check
// after decode.
export function deriveDiscordBotId(token: string | null | undefined): string | null {
  if (!token) return null
  const first = token.split('.')[0]
  if (!first) return null
  try {
    const decoded = Buffer.from(first, 'base64url').toString('utf-8')
    if (/^\d{17,20}$/.test(decoded)) return decoded
    return null
  } catch {
    return null
  }
}

// Telegram bot tokens are `<botUserId>:<hmac>` — bot ID is the part
// before the first colon. Snowflake range here is narrower (Telegram
// IDs are smaller) so we accept 5-20 digits.
export function deriveTelegramBotId(token: string | null | undefined): string | null {
  if (!token) return null
  const idx = token.indexOf(':')
  if (idx <= 0) return null
  const head = token.slice(0, idx)
  if (!/^\d{5,20}$/.test(head)) return null
  return head
}

// Slack tokens (`xoxb-…`) do NOT encode the bot ID; resolving requires
// an auth.test API call. We expose only what the .env exposes (the bot
// user ID under SLACK_BOT_USER_ID when an operator has filled it in).
function readSlackBotId(env: Record<string, string>): string | null {
  const id = env.SLACK_BOT_USER_ID
  if (id && /^[A-Z0-9]+$/.test(id)) return id
  return null
}

function buildProviderInfo(env: Record<string, string>, provider: ChannelProviderType): RegistryProviderInfo | undefined {
  if (provider === 'discord') {
    if (!env.DISCORD_BOT_TOKEN) return undefined
    return {
      botId: deriveDiscordBotId(env.DISCORD_BOT_TOKEN),
      channelId: env.DISCORD_CHANNEL_ID || null,
    }
  }
  if (provider === 'telegram') {
    if (!env.TELEGRAM_BOT_TOKEN) return undefined
    return {
      botId: deriveTelegramBotId(env.TELEGRAM_BOT_TOKEN),
      channelId: env.TELEGRAM_CHAT_ID || null,
    }
  }
  if (provider === 'slack') {
    if (!env.SLACK_BOT_TOKEN) return undefined
    return {
      botId: readSlackBotId(env),
      channelId: env.SLACK_CHANNEL_ID || null,
    }
  }
  return undefined
}

function channelEnvPath(provider: ChannelProviderType, baseDir: string | null): string {
  const base = baseDir ?? homedir()
  const subdir = provider === 'slack' ? 'slack' : provider === 'discord' ? 'discord' : 'telegram'
  return join(base, '.claude', 'channels', subdir, '.env')
}

function buildEntryFor(name: string, isMain: boolean): RegistryEntry {
  const base = isMain ? null : agentDir(name)
  const discordEnv = parseEnvFile(channelEnvPath('discord', base))
  const telegramEnv = parseEnvFile(channelEnvPath('telegram', base))
  const slackEnv = parseEnvFile(channelEnvPath('slack', base))

  const entry: RegistryEntry = { name, isMain }
  const d = buildProviderInfo(discordEnv, 'discord')
  if (d) entry.discord = d
  const t = buildProviderInfo(telegramEnv, 'telegram')
  if (t) entry.telegram = t
  const s = buildProviderInfo(slackEnv, 'slack')
  if (s) entry.slack = s
  return entry
}

/**
 * Snapshot every agent's per-provider bot ID + channel ID. Tokens are
 * never included. Used by GET /api/agents/registry; callers who need a
 * specific agent can filter by `name`.
 */
export function getAgentRegistry(): RegistryEntry[] {
  const entries: RegistryEntry[] = [buildEntryFor(MAIN_AGENT_ID, true)]
  for (const a of listAgentNames()) {
    if (a === MAIN_AGENT_ID) continue
    entries.push(buildEntryFor(a, false))
  }
  return entries
}
