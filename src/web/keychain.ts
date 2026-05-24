import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { platform } from 'node:os'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'

// Secure OS-level key store for the vault master key.
//   macOS: /usr/bin/security against the user Keychain.
//   Windows: DPAPI-encrypted blob stored alongside the project
//     (store/.vault-dpapi.bin). DPAPI encrypts with a key derived from
//     the current user's logon credentials, so an attacker with file
//     access still can't decrypt without being logged in as that user.
//   Linux: not implemented here — vault.ts falls back to a plaintext
//     .vault-key file (file-acl tightens its mode to 0o600).
//
// The exported surface (isKeychainAvailable / keychainStore / Retrieve /
// Delete) is what vault.ts consumes; the name predates the Windows
// addition and is kept for callsite stability.

const SECURITY = '/usr/bin/security'
const SERVICE = 'com.marveen.vault'
const ACCOUNT = 'master-key'

const DPAPI_FILE = join(PROJECT_ROOT, 'store', '.vault-dpapi.bin')

export function isKeychainAvailable(): boolean {
  return platform() === 'darwin' || platform() === 'win32'
}

// --- macOS Keychain via /usr/bin/security ---

function macStore(value: string): void {
  execFileSync(SECURITY, [
    'add-generic-password',
    '-U',
    '-s', SERVICE,
    '-a', ACCOUNT,
    '-w', value,
    '-A',
  ], { stdio: ['ignore', 'ignore', 'ignore'] })
}

function macRetrieve(): string | null {
  try {
    const out = execFileSync(SECURITY, [
      'find-generic-password',
      '-s', SERVICE,
      '-a', ACCOUNT,
      '-w',
    ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    return out.trim() || null
  } catch {
    return null
  }
}

function macDelete(): boolean {
  try {
    execFileSync(SECURITY, [
      'delete-generic-password',
      '-s', SERVICE,
      '-a', ACCOUNT,
    ], { stdio: ['ignore', 'ignore', 'ignore'] })
    return true
  } catch {
    return false
  }
}

// --- Windows DPAPI via PowerShell ---
//
// PowerShell exposes the .NET ProtectedData class without any extra
// install. Per-call cost is ~100-300 ms (PS spawn), acceptable for a
// startup-time master-key load. We feed the plaintext/ciphertext via
// stdin (-Command reads it with [Console]::In.ReadToEnd()) so no
// argument-escaping rules apply and no high-entropy secret ever
// appears in process-listing argv.

// Windows PowerShell 5.1 does not auto-load System.Security; without
// the explicit Add-Type the script fails with "Unable to find type
// [System.Security.Cryptography.ProtectedData]". PowerShell 7+
// auto-loads it but the Add-Type is a no-op there, so always include it.
//
// Stdin must be read via OpenStandardInput() + StreamReader rather than
// [Console]::In.ReadToEnd(). The latter returns empty when PowerShell
// thinks it has no console (which is the case when -Command spawns a
// non-interactive session and Node pipes stdin in); OpenStandardInput
// gets the raw stream regardless.
const PS_PROTECT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$reader = New-Object System.IO.StreamReader([System.Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
$text = $reader.ReadToEnd()
$bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
$prot = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
[Console]::Out.Write([Convert]::ToBase64String($prot))
`

const PS_UNPROTECT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$reader = New-Object System.IO.StreamReader([System.Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
$text = $reader.ReadToEnd().Trim()
$prot = [Convert]::FromBase64String($text)
$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($prot, $null, 'CurrentUser')
[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($bytes))
`

function dpapiProtect(plaintext: string): string {
  return execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', PS_PROTECT_SCRIPT,
  ], { encoding: 'utf-8', input: plaintext, timeout: 10000 })
}

function dpapiUnprotect(ciphertextBase64: string): string {
  return execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', PS_UNPROTECT_SCRIPT,
  ], { encoding: 'utf-8', input: ciphertextBase64, timeout: 10000 })
}

function winStore(value: string): void {
  const protectedB64 = dpapiProtect(value)
  // atomicWriteFileSync + 0o600 routes through file-acl's icacls on
  // Windows, so the .vault-dpapi.bin file gets owner-only ACL too.
  // Belt-and-braces: even if the DPAPI envelope were somehow
  // decrypted (e.g. malware running as the same user), the file is
  // also OS-protected.
  atomicWriteFileSync(DPAPI_FILE, protectedB64, { mode: 0o600 })
}

function winRetrieve(): string | null {
  if (!existsSync(DPAPI_FILE)) return null
  try {
    const ciphertext = readFileSync(DPAPI_FILE, 'utf-8').trim()
    if (!ciphertext) return null
    return dpapiUnprotect(ciphertext).trim() || null
  } catch {
    return null
  }
}

function winDelete(): boolean {
  try {
    if (!existsSync(DPAPI_FILE)) return false
    unlinkSync(DPAPI_FILE)
    return true
  } catch {
    return false
  }
}

// --- Dispatch ---

export function keychainStore(value: string): void {
  if (platform() === 'win32') return winStore(value)
  return macStore(value)
}

export function keychainRetrieve(): string | null {
  if (platform() === 'win32') return winRetrieve()
  return macRetrieve()
}

export function keychainDelete(): boolean {
  if (platform() === 'win32') return winDelete()
  return macDelete()
}
