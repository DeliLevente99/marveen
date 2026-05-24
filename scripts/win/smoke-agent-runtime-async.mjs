// Async-pattern variant of smoke-agent-runtime-sync.mjs — uses real
// `await setTimeout(...)` so the libuv event loop runs between
// operations. Together with the sync variant, this isolates whether
// the shim's ConPTY usage is correct vs whether the architectural
// sleep-blocks-libuv issue is in play. Both should pass on a healthy
// build (the sync variant uses pty-server which sidesteps the block).
//
// Run from project root after `npm run build`:
//   node scripts/win/smoke-agent-runtime-async.mjs

import { agentRuntime } from '../../dist/platform/agent-runtime.js'

const NAME = 'smoke-async'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function log(...a) { console.log('[smoke]', ...a) }

let failures = 0

try {
  log('startSession (cmd.exe /Q /K)')
  agentRuntime.startSession({
    name: NAME,
    cwd: process.cwd(),
    command: 'cmd.exe',
    args: ['/Q', '/K'],
    env: process.env,
    cols: 200,
    rows: 50,
  })

  log('hasSession:', agentRuntime.hasSession(NAME))

  // Async sleep — yields to libuv so pty.onData fires
  await sleep(1500)

  let cap0 = agentRuntime.capture(NAME)
  log('capture after startup, length:', cap0?.length ?? 'null')
  log('first 200 chars:', JSON.stringify((cap0 ?? '').slice(0, 200)))

  log('sendText("echo SENTINEL_OK_42") + Enter')
  agentRuntime.sendText(NAME, 'echo SENTINEL_OK_42')
  agentRuntime.sendKey(NAME, 'Enter')

  await sleep(1500)

  const cap1 = agentRuntime.capture(NAME)
  log('capture after command, length:', cap1?.length ?? 'null')
  log('last 400 chars:')
  console.log('---')
  console.log((cap1 ?? '').slice(-400))
  console.log('---')

  if (!cap1 || !cap1.includes('SENTINEL_OK_42')) {
    failures++
    log('SENTINEL not found — FAIL')
  } else {
    log('SENTINEL found ✓')
  }

  log('killSession')
  agentRuntime.killSession(NAME)
  await sleep(300)

  log('hasSession after kill:', agentRuntime.hasSession(NAME))
  if (agentRuntime.hasSession(NAME)) { failures++; log('still alive after kill — FAIL') }

  if (failures === 0) { log('ALL OK'); process.exit(0) }
  log('FAILURES:', failures); process.exit(1)
} catch (err) {
  console.error('[smoke] exception:', err)
  process.exit(1)
}
