import { describe, it, expect } from 'vitest'
import { deriveDiscordBotId, deriveTelegramBotId } from '../web/agent-registry.js'

// Reference values for a fictitious Discord bot user ID. We build a token
// the way Discord does (base64url of the snowflake) and verify decode
// recovers it. The other two segments are arbitrary noise; the function
// must ignore them.
function buildDiscordToken(userId: string, extraSegments: string[] = ['abc', 'xyz']): string {
  const head = Buffer.from(userId, 'utf-8').toString('base64url')
  return [head, ...extraSegments].join('.')
}

describe('deriveDiscordBotId', () => {
  it('decodes a standard 3-segment bot token', () => {
    const tok = buildDiscordToken('1234567890123456789')
    expect(deriveDiscordBotId(tok)).toBe('1234567890123456789')
  })

  it('decodes a 4-segment token (newer format with extra segment)', () => {
    const tok = buildDiscordToken('987654321098765432', ['MTA', 'abc', 'xyz'])
    expect(deriveDiscordBotId(tok)).toBe('987654321098765432')
  })

  it('returns null when first segment does not decode to a snowflake-shaped string', () => {
    // Decodes to "hello" — not a snowflake, must be rejected.
    const garbage = Buffer.from('hello', 'utf-8').toString('base64url') + '.x.y'
    expect(deriveDiscordBotId(garbage)).toBeNull()
  })

  it('returns null on empty / null / missing first segment', () => {
    expect(deriveDiscordBotId(null)).toBeNull()
    expect(deriveDiscordBotId(undefined)).toBeNull()
    expect(deriveDiscordBotId('')).toBeNull()
    expect(deriveDiscordBotId('.tail.only')).toBeNull()
  })

  it('returns null when decoded ID has the wrong length (too short or too long)', () => {
    const tooShort = buildDiscordToken('123') // 3 digits, below snowflake floor
    const tooLong = buildDiscordToken('123456789012345678901') // 21 digits, above ceiling
    expect(deriveDiscordBotId(tooShort)).toBeNull()
    expect(deriveDiscordBotId(tooLong)).toBeNull()
  })
})

describe('deriveTelegramBotId', () => {
  it('extracts the bot ID prefix before the colon', () => {
    expect(deriveTelegramBotId('8123456789:AAFakeHMACsegment')).toBe('8123456789')
  })

  it('returns null when there is no colon', () => {
    expect(deriveTelegramBotId('justtokenwithoutcolon')).toBeNull()
  })

  it('returns null when the prefix is not numeric', () => {
    expect(deriveTelegramBotId('abc123:tail')).toBeNull()
  })

  it('returns null when token is empty / null', () => {
    expect(deriveTelegramBotId(null)).toBeNull()
    expect(deriveTelegramBotId(undefined)).toBeNull()
    expect(deriveTelegramBotId('')).toBeNull()
    expect(deriveTelegramBotId(':onlyhmac')).toBeNull()
  })
})
