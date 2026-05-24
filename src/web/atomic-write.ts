import { writeFileSync, chmodSync, renameSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tightenToOwnerOnly } from '../platform/file-acl.js'

// Atomic write: write to a sibling tmp file and rename over the target, so a
// crash/kill mid-write can never leave a zero-byte or half-written state file.
// Use this for anything the dashboard depends on surviving a restart
// (dashboard-token, agent CLAUDE.md / SOUL.md, telegram env + access.json).
export function atomicWriteFileSync(
  path: string,
  data: string | Buffer,
  opts: { mode?: number } = {},
): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, data)
  if (opts.mode === 0o600) {
    // Owner-only is the "this is a secret" pattern (vault, .env,
    // dashboard-token). Route through the file-acl shim so Windows
    // gets real ACL enforcement (icacls) instead of a silent chmod
    // no-op. Applied to tmp BEFORE rename so the target appears
    // atomically with the tight ACL.
    try { tightenToOwnerOnly(tmp) } catch { /* best-effort */ }
  } else if (opts.mode !== undefined) {
    // Any other mode (rare): plain chmod. POSIX-only meaningful;
    // Windows ignores. The mode-bit semantic doesn't map cleanly to
    // NTFS ACLs in the general case, so this stays as the legacy no-op.
    try { chmodSync(tmp, opts.mode) } catch { /* best-effort */ }
  }
  renameSync(tmp, path)
}
