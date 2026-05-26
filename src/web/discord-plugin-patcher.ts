// Discord plugin monkey-patcher.
//
// The Anthropic-curated `claude-plugins-official` marketplace doesn't accept
// external contributions (auto-rejected: see the PR review log), and the
// community-marketplace submission is multi-week review. We need `reply_to_
// user` (DM-by-user-id) for the operator-pairing-notification path TODAY,
// so we vendor a patched `server.ts` in vendor/discord-plugin/ and overwrite
// the installed plugin's file at dashboard boot.
//
// Safety:
//  - Operates on the user-scoped install path (~/.claude/plugins/cache/
//    claude-plugins-official/discord/<ver>/server.ts).
//  - Version-pinned: vendored file was forked from PATCHED_BASE_VERSION
//    (stored in vendor/discord-plugin/.patched-from-version). If the
//    installed plugin's package.json version differs, we LOG A WARNING
//    AND SKIP -- downgrading the operator's plugin silently is worse than
//    losing reply_to_user temporarily. Operator must re-vendor when
//    upstream bumps the version.
//  - Idempotent: looks for a marker string in the file (PATCH_MARKER) and
//    skips re-write when it's already there.
//  - Plugin updates re-overwrite our patched file; the next dashboard boot
//    re-applies if version still matches.
//
// POSIX vs Windows:
//  - Windows: dashboard spawns the channels session itself, so the patch
//    runs before `startMainChannelsSession` and the live session uses
//    the patched plugin on first start.
//  - POSIX: channels.sh runs under launchd/systemd independently of the
//    dashboard. The dashboard's patch still applies (next channels-
//    session respawn picks it up), but the currently-running claude is
//    not affected until restart. Operator may need a manual restart on
//    the very first boot after install; subsequent restarts are
//    transparent.
import { existsSync, readFileSync, readdirSync, copyFileSync, statSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { logger } from '../logger.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
// vendor/ lives at the repo root; from src/web/discord-plugin-patcher.ts
// that's three levels up.
const VENDOR_DIR = join(__dirname, '..', '..', 'vendor', 'discord-plugin')
const PLUGIN_BASE = join(homedir(), '.claude', 'plugins', 'cache', 'claude-plugins-official', 'discord')

// Unique string present only in the patched server.ts. Used as the
// "already patched" detection; if you change the patch contents, change
// this marker too. Bumping the marker forces re-apply of the vendored
// file -- needed when the patch grows (e.g., the pair-reply suppression
// added on top of reply_to_user).
const PATCH_MARKER = 'MARVEEN-PATCH: server-channel pending'

export function patchDiscordPluginIfNeeded(): void {
  if (!existsSync(PLUGIN_BASE)) return // plugin not installed; nothing to do
  const vendoredFile = join(VENDOR_DIR, 'server.ts')
  const versionPinFile = join(VENDOR_DIR, '.patched-from-version')
  if (!existsSync(vendoredFile) || !existsSync(versionPinFile)) {
    logger.warn({ vendoredFile, versionPinFile }, 'discord-plugin-patcher: vendor files missing, skipping')
    return
  }
  const patchedBaseVersion = readFileSync(versionPinFile, 'utf-8').trim()

  // Plugin install lays out one subdir per version (e.g., 0.0.4/). Pick
  // the highest-versioned one that exists.
  let versions: string[]
  try {
    versions = readdirSync(PLUGIN_BASE).filter((d) => /^\d+\.\d+\.\d+$/.test(d)).sort()
  } catch (err) {
    logger.warn({ err }, 'discord-plugin-patcher: cannot list plugin versions, skipping')
    return
  }
  if (versions.length === 0) return
  const installedVersion = versions[versions.length - 1]
  const installedServer = join(PLUGIN_BASE, installedVersion, 'server.ts')
  if (!existsSync(installedServer)) return

  if (installedVersion !== patchedBaseVersion) {
    logger.warn(
      { installedVersion, patchedBaseVersion },
      'discord-plugin-patcher: installed version differs from vendored patch base, skipping (reply_to_user tool will be unavailable; re-vendor after upstream bump)',
    )
    return
  }

  let installedContent: string
  try {
    installedContent = readFileSync(installedServer, 'utf-8')
  } catch (err) {
    logger.warn({ err, installedServer }, 'discord-plugin-patcher: cannot read installed server.ts, skipping')
    return
  }
  if (installedContent.includes(PATCH_MARKER)) return // already patched

  // Overwrite. Preserve the original file mode (vendored copy may have a
  // different mode bit set after the npm-shim chmod).
  try {
    const origStat = statSync(installedServer)
    copyFileSync(vendoredFile, installedServer)
    chmodSync(installedServer, origStat.mode)
    logger.info({ installedServer, installedVersion }, 'discord-plugin-patcher: applied vendored patch (reply_to_user tool)')
  } catch (err) {
    logger.error({ err, installedServer }, 'discord-plugin-patcher: failed to write patched server.ts')
  }
}
