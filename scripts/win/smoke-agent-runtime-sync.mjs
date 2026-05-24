// Isolated smoke-test for the Windows agent-runtime shim (pty-server
// backend). Spawns cmd.exe via the shim, blocks the main thread with
// sleepSync between send and capture, asserts that the command output
// is visible in the buffer. Proves the pty-server child process keeps
// libuv pumping while the main thread sleeps — the architectural fix
// that makes the in-process pty viable on Windows.
//
// Run from project root after `npm run build`:
//   node scripts/win/smoke-agent-runtime-sync.mjs

import { agentRuntime } from '../../dist/platform/agent-runtime.js'

function log(...args) { console.log('[smoke]', ...args) }
function fail(msg) { console.error('[smoke] FAIL:', msg); process.exit(1) }

const NAME = 'smoke-conpty-test'
let failures = 0

try {
  log('hasSession before start:', agentRuntime.hasSession(NAME))
  if (agentRuntime.hasSession(NAME)) { failures++; log('expected no session before start') }

  log('startSession (pwsh)')
  agentRuntime.startSession({
    name: NAME,
    cwd: process.cwd(),
    command: 'cmd.exe',
    args: ['/Q', '/K'],   // /Q quiet (no banner), /K keeps shell after command
    env: process.env,
    cols: 200,
    rows: 50,
  })

  log('hasSession after start:', agentRuntime.hasSession(NAME))
  if (!agentRuntime.hasSession(NAME)) failures++

  log('listSessions:', agentRuntime.listSessions())

  // Let powershell render its prompt
  agentRuntime.sleepSync(1500)

  log('sendText + Enter (echo SENTINEL_OK_42)')
  agentRuntime.sendText(NAME, 'echo SENTINEL_OK_42')
  agentRuntime.sendKey(NAME, 'Enter')

  // Let it execute and render
  agentRuntime.sleepSync(1500)

  const capture = agentRuntime.capture(NAME)
  log('capture length:', capture?.length ?? 'null')
  log('capture last 400 chars:')
  console.log('---')
  console.log((capture ?? '').slice(-400))
  console.log('---')

  if (!capture || !capture.includes('SENTINEL_OK_42')) {
    failures++
    log('SENTINEL not found in capture — fail')
  } else {
    log('SENTINEL found ✓')
  }

  log('killSession')
  agentRuntime.killSession(NAME)
  agentRuntime.sleepSync(300)

  log('hasSession after kill:', agentRuntime.hasSession(NAME))
  if (agentRuntime.hasSession(NAME)) failures++

  if (failures === 0) {
    log('ALL OK')
    process.exit(0)
  } else {
    fail(`${failures} assertion(s) failed`)
  }
} catch (err) {
  fail('exception: ' + (err instanceof Error ? err.stack : String(err)))
}
