import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { repairWindowsClaudeShim } from '../platform.js'

// The shim template npm emits for Windows: invokes the .exe via %dp0%
// (the directory of the .cmd itself). Tests reproduce this layout in a
// scratch dir and verify the repair function restores claude.exe from
// the highest-timestamp .old.<unix_ms> sibling.

const SHIM_BODY = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*
`

describe('repairWindowsClaudeShim', () => {
  let scratch: string
  let cmdPath: string
  let binDir: string
  let exePath: string

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'repair-shim-'))
    cmdPath = join(scratch, 'claude.cmd')
    binDir = join(scratch, 'node_modules', '@anthropic-ai', 'claude-code', 'bin')
    exePath = join(binDir, 'claude.exe')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(cmdPath, SHIM_BODY, 'utf-8')
  })

  afterEach(() => {
    try { rmSync(scratch, { recursive: true, force: true }) } catch { /* ok */ }
  })

  it('no-ops when claude.exe is healthy', () => {
    writeFileSync(exePath, 'fake-exe', 'utf-8')
    const r = repairWindowsClaudeShim(cmdPath)
    expect(r.repaired).toBe(false)
    expect(r.reason).toBe('exe-already-present')
    expect(existsSync(exePath)).toBe(true)
  })

  it('restores claude.exe from the only .old.<ts> sibling', () => {
    const oldPath = join(binDir, 'claude.exe.old.1779873885112')
    writeFileSync(oldPath, 'fake-exe-bytes', 'utf-8')
    const r = repairWindowsClaudeShim(cmdPath)
    expect(r.repaired).toBe(true)
    expect(r.restoredFrom).toBe(oldPath)
    expect(existsSync(exePath)).toBe(true)
    expect(existsSync(oldPath)).toBe(false)
  })

  it('picks the highest-timestamp .old sibling when multiple exist', () => {
    writeFileSync(join(binDir, 'claude.exe.old.1000'), 'oldest', 'utf-8')
    writeFileSync(join(binDir, 'claude.exe.old.5000'), 'newest', 'utf-8')
    writeFileSync(join(binDir, 'claude.exe.old.3000'), 'middle', 'utf-8')
    const r = repairWindowsClaudeShim(cmdPath)
    expect(r.repaired).toBe(true)
    expect(r.restoredFrom).toBe(join(binDir, 'claude.exe.old.5000'))
    // Older copies are left in place — we only restored the newest.
    const remaining = readdirSync(binDir).sort()
    expect(remaining).toEqual(['claude.exe', 'claude.exe.old.1000', 'claude.exe.old.3000'])
  })

  it('returns no-old-sibling when exe missing and no .old.<ts> present', () => {
    const r = repairWindowsClaudeShim(cmdPath)
    expect(r.repaired).toBe(false)
    expect(r.reason).toBe('no-old-sibling')
  })

  it('ignores non-cmd inputs', () => {
    const r = repairWindowsClaudeShim(join(scratch, 'claude.ps1'))
    expect(r.repaired).toBe(false)
    expect(r.reason).toBe('not-cmd-shim')
  })

  it('returns shim-unreadable when the .cmd file does not exist', () => {
    const r = repairWindowsClaudeShim(join(scratch, 'missing.cmd'))
    expect(r.repaired).toBe(false)
    expect(r.reason).toBe('shim-unreadable')
  })

  it('ignores shims that have no %dp0% exe reference', () => {
    writeFileSync(cmdPath, '@echo off\necho hello\n', 'utf-8')
    const r = repairWindowsClaudeShim(cmdPath)
    expect(r.repaired).toBe(false)
    expect(r.reason).toBe('no-exe-ref-in-shim')
  })

  it('skips files matching the .old prefix but not the .<ts> suffix', () => {
    // Defensive: a stray "claude.exe.old.txt" (no digits) must not be picked.
    writeFileSync(join(binDir, 'claude.exe.old.notes'), 'notes', 'utf-8')
    writeFileSync(join(binDir, 'claude.exe.old.'), 'partial', 'utf-8')
    const r = repairWindowsClaudeShim(cmdPath)
    expect(r.repaired).toBe(false)
    expect(r.reason).toBe('no-old-sibling')
  })
})
