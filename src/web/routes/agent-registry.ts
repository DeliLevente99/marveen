import { json } from '../http-helpers.js'
import { getAgentRegistry } from '../agent-registry.js'
import type { RouteContext } from './types.js'

// GET /api/agents/registry
// Returns every agent (main + sub-agents) with the public per-provider
// coordination fields: bot ID and channel ID. Tokens are NOT included
// (those stay private to the agent's own .env file); callers needing a
// token use the per-agent endpoints under /api/agents/<name>.
//
// Use cases: an agent posting a Discord/Telegram reply that needs to
// mention another agent's bot, or the dashboard surfacing a coordination
// map. Filter to a single name with `?name=…`.
export async function tryHandleAgentRegistry(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx
  if (path !== '/api/agents/registry' || method !== 'GET') return false
  const filter = url.searchParams.get('name')
  const all = getAgentRegistry()
  const result = filter ? all.filter(e => e.name === filter) : all
  json(res, result)
  return true
}
