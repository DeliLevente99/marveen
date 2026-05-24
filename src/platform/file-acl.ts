// Cross-platform "tighten this file to owner-only access" helper for
// the handful of paths Marveen treats as secrets: the SQLite DB
// (auth tokens, embedded vault refs), agent .env files (bot tokens),
// dashboard-token, vault.json.
//
// POSIX:  chmod 0o600 — standard owner-rw, group/other no access.
// Windows: icacls /inheritance:r /grant:r <user>:(F) — strip the
//   inheritance from the parent directory's DACL and grant Full control
//   to the current user only. NTFS does not honor POSIX mode bits, so
//   the legacy `chmodSync(path, 0o600)` calls were a silent no-op on
//   Windows; this restores real protection.
//
// Cost on Windows: ~50ms per call (icacls subprocess). Marveen calls
// this rarely (DB init + occasional atomic writes), so the overhead is
// inconsequential.

import { chmodSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { userInfo } from 'node:os'

let cachedAccount: string | null = null
function currentUserAccount(): string {
  if (cachedAccount != null) return cachedAccount
  // icacls is fussy about account resolution: a bare `<user>` argument
  // is ambiguous when the user account and the computer account share
  // a name (e.g. user "Levi" on machine "LEVI"). icacls then resolves
  // to the computer account, producing an empty-username DACL entry
  // (`LEVI\:(F)`) and effectively locking the file from Node's
  // syscalls. Always pass the fully-qualified `<domain>\<user>` form;
  // %USERDOMAIN% is the NetBIOS computer name on standalone machines
  // and the domain name on domain-joined ones. Fall back to bare
  // userInfo() if either env var is missing.
  const domain = process.env.USERDOMAIN
  const user = process.env.USERNAME ?? userInfo().username
  cachedAccount = domain ? `${domain}\\${user}` : user
  return cachedAccount
}

/**
 * Restrict `path` so only the current user can access it.
 * Throws on failure so the caller can decide whether to log + continue
 * (defense-in-depth) or fail the operation outright (hard requirement).
 */
export function tightenToOwnerOnly(path: string): void {
  if (process.platform === 'win32') {
    // /inheritance:r removes any inherited entries from the parent dir's
    // DACL. /grant:r replaces (not adds to) the user's existing grant
    // with Full control — without :r a second call could double-grant.
    // stdio: 'ignore' silences icacls's success chatter ("processed
    // 1 files" etc) which would otherwise spam the dashboard log if a
    // caller forwarded stdout.
    execFileSync('icacls', [
      path,
      '/inheritance:r',
      '/grant:r', `${currentUserAccount()}:(F)`,
    ], { timeout: 5000, stdio: 'ignore' })
  } else {
    chmodSync(path, 0o600)
  }
}
