import { json } from '../http-helpers.js'
import { MAIN_AGENT_ID } from '../../config.js'
import { agentRuntime } from '../../platform/agent-runtime.js'
import { agentSessionName } from '../agent-process.js'
import { MAIN_CHANNELS_SESSION } from '../main-agent.js'
import { isKnownAgent } from '../agent-config.js'
import type { RouteContext } from './types.js'

// GET /api/agents/<name>/console
// Returns the latest pane capture for the agent's tmux/pty session so the
// dashboard can render a live console view. ANSI escapes are stripped
// inside the pty-server's capture method already. `sessionExists` lets
// the frontend distinguish "agent stopped" from "agent idle".
export async function tryHandleAgentConsole(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx
  const m = path.match(/^\/api\/agents\/([^/]+)\/console$/)
  if (!m || method !== 'GET') return false

  const name = decodeURIComponent(m[1])
  if (!isKnownAgent(name)) {
    json(res, { error: 'Agent not found' }, 404)
    return true
  }

  const session = name === MAIN_AGENT_ID ? MAIN_CHANNELS_SESSION : agentSessionName(name)
  const sessionExists = agentRuntime.hasSession(session)
  if (!sessionExists) {
    json(res, { sessionExists: false, sessionName: session, pane: '' })
    return true
  }

  const pane = agentRuntime.capture(session) ?? ''
  json(res, { sessionExists: true, sessionName: session, pane })
  return true
}
