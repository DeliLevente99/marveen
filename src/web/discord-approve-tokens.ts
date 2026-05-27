// One-time, short-lived approval tokens for Discord pending pairings.
//
// The operator-notify path (channel-invites.ts) DMs the operator with a
// dashboard URL carrying an `?approve_token=...` query param. The token
// here lives 5 minutes and is consumed on first use. The dashboard
// frontend reads the token, fetches its details for a confirmation modal,
// and on confirm POSTs back to consume + approve.
//
// In-memory only -- a dashboard restart invalidates outstanding tokens
// (operator gets re-notified on the next invite-monitor tick since the
// pending entry is still in access.json). Acceptable: tokens are short-
// lived anyway, and persisting them adds attack surface for little gain.
import { randomBytes } from 'node:crypto'

export interface ApproveTokenEntry {
  code: string       // pending entry code in access.json
  senderId: string   // Discord user ID being approved
  expiresAt: number  // ms epoch
  agentName: string  // which agent's access.json this pending lives in
                     // (MAIN_AGENT_ID for the main agent, or sub-agent slug)
}

const TOKEN_TTL_MS = 5 * 60 * 1000
const store = new Map<string, ApproveTokenEntry>()

function pruneExpired(now = Date.now()): void {
  for (const [t, e] of store) {
    if (e.expiresAt < now) store.delete(t)
  }
}

export function mintApproveToken(code: string, senderId: string, agentName: string): string {
  pruneExpired()
  // 24 bytes base64url -> 32 chars -- unguessable. URL-safe.
  const token = randomBytes(24).toString('base64url')
  const expiresAt = Date.now() + TOKEN_TTL_MS
  store.set(token, { code, senderId, expiresAt, agentName })
  if (process.env.DISCORD_APPROVE_TOKEN_DEBUG === '1') {
    // eslint-disable-next-line no-console
    console.error(`[discord-approve-tokens] minted token=${token.slice(0, 8)}... code=${code} agent=${agentName} expiresAt=${new Date(expiresAt).toISOString()} storeSize=${store.size}`)
  }
  return token
}

// Non-destructive lookup. Used by the GET endpoint that drives the
// confirmation modal; does NOT delete the token (so the operator can
// see the modal, then click Approve, which calls consumeApproveToken).
export function peekApproveToken(token: string): ApproveTokenEntry | null {
  pruneExpired()
  const entry = store.get(token) ?? null
  if (process.env.DISCORD_APPROVE_TOKEN_DEBUG === '1') {
    // eslint-disable-next-line no-console
    console.error(`[discord-approve-tokens] peek token=${token.slice(0, 8)}... found=${entry ? 'yes' : 'NO'} storeSize=${store.size}`)
  }
  return entry
}

// Single-use: returns the entry and removes it. The caller is expected
// to perform the actual access.json mutation; we just guard the
// freshness/uniqueness window.
export function consumeApproveToken(token: string): ApproveTokenEntry | null {
  pruneExpired()
  const entry = store.get(token)
  if (!entry) return null
  store.delete(token)
  return entry
}
