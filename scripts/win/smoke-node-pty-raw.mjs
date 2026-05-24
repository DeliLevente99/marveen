// Bypass the agent-runtime shim — talk to node-pty / ConPTY directly to
// confirm the underlying primitive works (onData fires, exit semantics
// are sane). Useful when the shim itself misbehaves and you want to
// isolate "is it node-pty or my code". No pty-server involved.
//
// Run from project root (no build needed, imports node-pty directly):
//   node scripts/win/smoke-node-pty-raw.mjs
import * as pty from 'node-pty'

const proc = pty.spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-Command', '-'], {
  name: 'xterm-256color',
  cols: 200,
  rows: 50,
  cwd: process.cwd(),
  env: process.env,
})

console.log('[raw] spawned, pid =', proc.pid)

let total = 0
let chunks = 0
proc.onData((data) => {
  total += data.length
  chunks++
  process.stdout.write(`[raw chunk ${chunks} len=${data.length}] ${JSON.stringify(data.slice(0, 80))}...\n`)
})

proc.onExit((e) => {
  console.log('[raw] exit:', e)
})

setTimeout(() => {
  console.log('[raw] writing command')
  proc.write('Write-Output "SENTINEL_OK_42"\r')
}, 1500)

setTimeout(() => {
  console.log('[raw] total chunks =', chunks, 'total bytes =', total)
  proc.kill()
  process.exit(total > 0 ? 0 : 1)
}, 4000)
