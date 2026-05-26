import { existsSync, unlinkSync, copyFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import { homedir } from 'node:os'
import { PROJECT_ROOT, OWNER_NAME, BOT_NAME, CHANNEL_PROVIDER } from '../../config.js'
import { readMarveenTelegramConfig, readMarveenDiscordConfig, readMarveenSlackConfig, sendMarveenAvatarChange } from '../telegram.js'
import { hardRestartMarveenChannels } from '../channel-monitor.js'
import { readFileOr } from '../agent-config.js'
import { parseMultipart } from '../multipart.js'
import { readBody, json, serveFile } from '../http-helpers.js'
import { MAIN_CHANNELS_SESSION } from '../main-agent.js'
import { readActiveModelFromProjectDir } from '../active-model.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { getProvider, channelStateDir, type ChannelProviderType } from '../../channel-provider.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'

function getActiveMarveenModel(): string {
  return readActiveModelFromProjectDir(PROJECT_ROOT) ?? 'unknown'
}

function readMainEnvVar(key: string): string {
  const envPath = join(PROJECT_ROOT, '.env')
  let content = ''
  try { content = readFileOr(envPath, '') } catch { /* missing is fine */ }
  const matchRe = new RegExp(`^${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}=(.+)$`, 'm')
  const m = content.match(matchRe)
  return (m?.[1] ?? '').trim()
}

function marveenChannelHasToken(provider: ChannelProviderType): boolean {
  const envPath = join(homedir(), '.claude', 'channels', provider, '.env')
  if (!existsSync(envPath)) return false
  const content = readFileOr(envPath, '')
  const key = getProvider(provider).envKeys[0]
  const m = content.match(new RegExp(`^${key}=(.+)$`, 'm'))
  return !!m && !!m[1].trim()
}

// channels.sh / main-channels-session.ts re-read .env at spawn, so writing
// here takes effect on the next channels-session restart without a dashboard
// reboot.
function setMainEnvVar(key: string, value: string): void {
  const envPath = join(PROJECT_ROOT, '.env')
  let content = ''
  try { content = readFileOr(envPath, '') } catch { /* missing is fine */ }
  const lines = content.split(/\r?\n/)
  const matchRe = new RegExp(`^${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}=`)
  let found = false
  const next: string[] = []
  for (const line of lines) {
    if (matchRe.test(line)) {
      next.push(`${key}=${value}`)
      found = true
    } else {
      next.push(line)
    }
  }
  if (!found) {
    if (next.length > 0 && next[next.length - 1] === '') next.pop()
    next.push(`${key}=${value}`)
    next.push('')
  }
  atomicWriteFileSync(envPath, next.join('\n'), { mode: 0o600 })
}

export async function tryHandleMarveen(ctx: RouteContext, webDir: string): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/marveen' && method === 'GET') {
    const claudeMd = readFileOr(join(PROJECT_ROOT, 'CLAUDE.md'), '')
    const soulMd = readFileOr(join(PROJECT_ROOT, 'SOUL.md'), '')
    const mcpJson = readFileOr(join(PROJECT_ROOT, '.mcp.json'), '')
    const soulSection = claudeMd.match(/## Személyiség\n\n([\s\S]*?)(?=\n## )/)?.[1]?.trim()
      || claudeMd.match(/## Szemelyiseg\n\n([\s\S]*?)(?=\n## )/)?.[1]?.trim()
      || ''
    const firstLine = claudeMd.match(/^Te .+$/m)?.[0]?.trim() || ''
    const descFromPersonality = soulSection.split('\n').filter(l => l.trim()).slice(0, 2).join(' ').slice(0, 200)
    const description = firstLine || descFromPersonality || `${OWNER_NAME} AI asszisztense`
    const tg = readMarveenTelegramConfig()
    const dc = readMarveenDiscordConfig()
    const sl = readMarveenSlackConfig()
    json(res, {
      name: BOT_NAME,
      description,
      model: getActiveMarveenModel(),
      tmuxSession: MAIN_CHANNELS_SESSION,
      running: true,
      hasTelegram: tg.hasTelegram,
      hasDiscord: dc.hasDiscord,
      hasSlack: sl.hasSlack,
      telegramBotUsername: tg.botUsername,
      discordChannelId: readMainEnvVar('DISCORD_CHANNEL_ID'),
      role: 'main',
      personality: soulSection,
      claudeMd,
      soulMd,
      mcpJson,
      readonly: true,
      // Dashboard kliens defaultja a provider-dropdown-hoz: a backend
      // CHANNEL_PROVIDER env-jébe pinneljük, hogy a UI ne hardcode-olt
      // 'telegram'-mal induljon.
      channelProvider: CHANNEL_PROVIDER,
    })
    return true
  }

  // POST /api/marveen/channels/:provider -- bind/replace the main agent's
  // channel provider via the dashboard. Writes the plugin token .env into
  // ~/.claude/channels/<provider>/, seeds an empty access.json (TOFU will
  // claim the first DM), flips project .env's CHANNEL_PROVIDER, and kicks
  // off a channels-session restart so the change takes effect immediately.
  const marveenChannelMatch = path.match(/^\/api\/marveen\/channels\/(telegram|slack|discord)$/)
  if (marveenChannelMatch && method === 'POST') {
    const provider = marveenChannelMatch[1] as ChannelProviderType
    const body = await readBody(req)
    const { botToken, appToken } = JSON.parse(body.toString()) as { botToken?: string; appToken?: string }
    if (!botToken?.trim()) { json(res, { error: 'botToken is required' }, 400); return true }

    const channelProvider = getProvider(provider)
    const validation = await channelProvider.validateToken(botToken.trim())
    if (!validation.ok) { json(res, { error: validation.error || 'Invalid token' }, 400); return true }

    const stateDir = channelStateDir(provider)
    mkdirSync(stateDir, { recursive: true })
    const tokenKey = channelProvider.envKeys[0]
    let envContent = `${tokenKey}=${botToken.trim()}\n`
    if (provider === 'slack' && appToken?.trim() && channelProvider.envKeys.includes('SLACK_APP_TOKEN')) {
      envContent += `SLACK_APP_TOKEN=${appToken.trim()}\n`
    }
    atomicWriteFileSync(join(stateDir, '.env'), envContent, { mode: 0o600 })
    if (!existsSync(join(stateDir, 'access.json'))) {
      atomicWriteFileSync(join(stateDir, 'access.json'), JSON.stringify({
        dmPolicy: 'pairing',
        allowFrom: [],
        groups: {},
        pending: {},
      }, null, 2))
    }

    setMainEnvVar('CHANNEL_PROVIDER', provider)

    try { hardRestartMarveenChannels() } catch (err) {
      logger.warn({ err }, 'hardRestartMarveenChannels failed after Marveen channel setup; manual restart required')
    }

    json(res, { ok: true, provider, botName: validation.botName, restartRequired: true })
    return true
  }

  // POST /api/marveen/channels/discord/channel-id -- write DISCORD_CHANNEL_ID
  // into the project .env AND add it to access.groups so the plugin's
  // outbound `reply` gate accepts the channel immediately, without a
  // dashboard restart. Boot-time bootstrap (ensureDiscordChannelGroup) still
  // handles the cold-start case.
  if (path === '/api/marveen/channels/discord/channel-id' && method === 'POST') {
    const body = await readBody(req)
    const { channelId } = JSON.parse(body.toString()) as { channelId?: string }
    const trimmed = channelId?.trim() ?? ''
    if (!trimmed) { json(res, { error: 'channelId is required' }, 400); return true }
    if (!/^\d{17,20}$/.test(trimmed)) { json(res, { error: 'Discord channel ID must be a 17-20 digit snowflake' }, 400); return true }

    setMainEnvVar('DISCORD_CHANNEL_ID', trimmed)

    const stateDir = channelStateDir('discord')
    mkdirSync(stateDir, { recursive: true })
    const accessPath = join(stateDir, 'access.json')
    let access: { dmPolicy?: string; allowFrom?: string[]; groups?: Record<string, unknown>; pending?: Record<string, unknown> } = {
      dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {},
    }
    if (existsSync(accessPath)) {
      try { access = JSON.parse(readFileOr(accessPath, '{}')) } catch { /* corrupt: start fresh */ }
    }
    access.groups = access.groups ?? {}
    if (!(trimmed in access.groups)) {
      access.groups[trimmed] = { requireMention: false, allowFrom: [] }
      atomicWriteFileSync(accessPath, JSON.stringify(access, null, 2))
    }

    json(res, { ok: true, channelId: trimmed })
    return true
  }

  // Intentionally read-only: Marveen's CLAUDE.md / SOUL.md / .mcp.json must be
  // edited from the filesystem or via a Telegram request to Marveen herself,
  // not through the dashboard. A leaked dashboard token would otherwise allow
  // remote identity rewrite of the live agent.
  if (path === '/api/marveen' && method === 'PUT') {
    json(res, { ok: true, readonly: true })
    return true
  }

  if (path === '/api/marveen/restart' && method === 'POST') {
    const result = hardRestartMarveenChannels()
    if (!result.ok) { json(res, { error: result.error || 'Restart failed' }, 500); return true }
    json(res, { ok: true })
    return true
  }

  if (path === '/api/marveen/avatar' && method === 'GET') {
    for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
      const p = join(PROJECT_ROOT, 'store', `marveen-avatar${ext}`)
      if (existsSync(p)) { serveFile(res, p); return true }
    }
    const fallback = join(webDir, 'avatars', '01_robot.png')
    if (existsSync(fallback)) { serveFile(res, fallback); return true }
    res.writeHead(404); res.end()
    return true
  }

  if (path === '/api/marveen/avatar' && method === 'POST') {
    const body = await readBody(req)
    const contentType = req.headers['content-type'] || ''

    for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
      const p = join(PROJECT_ROOT, 'store', `marveen-avatar${ext}`)
      if (existsSync(p)) unlinkSync(p)
    }

    if (contentType.includes('application/json')) {
      const { galleryAvatar } = JSON.parse(body.toString()) as { galleryAvatar: string }
      if (!galleryAvatar) { json(res, { error: 'No avatar specified' }, 400); return true }
      if (galleryAvatar.includes('..') || galleryAvatar.includes('/') || galleryAvatar.includes('\\')) {
        json(res, { error: 'Invalid avatar name' }, 400)
        return true
      }
      const srcPath = join(webDir, 'avatars', galleryAvatar)
      if (!existsSync(srcPath)) { json(res, { error: 'Avatar not found' }, 404); return true }
      const destPath = join(PROJECT_ROOT, 'store', `marveen-avatar${extname(galleryAvatar) || '.png'}`)
      copyFileSync(srcPath, destPath)
      sendMarveenAvatarChange(destPath).catch(() => {})
    } else {
      const { file } = parseMultipart(body, contentType)
      if (!file) { json(res, { error: 'No file uploaded' }, 400); return true }
      const destPath = join(PROJECT_ROOT, 'store', `marveen-avatar${extname(file.name) || '.png'}`)
      writeFileSync(destPath, file.data)
      sendMarveenAvatarChange(destPath).catch(() => {})
    }
    json(res, { ok: true })
    return true
  }

  return false
}
