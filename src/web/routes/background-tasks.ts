import { randomBytes } from 'node:crypto'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import {
  createBackgroundTaskAtomic, finishBackgroundTask, getBackgroundTasks,
  getBackgroundTask, getRunningBackgroundTasks, markOrphanedTasksFailed,
  type BackgroundTask,
} from '../../db.js'
import { resolveFromPath } from '../../platform.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// Resolution is lazy on POSIX so the dashboard module-loads even if
// tmux is missing in PATH (allowing partial usage on hosts without
// it). Windows takes a different code path entirely — see the win*
// helpers below — so the tmux resolver never fires there.
let _tmux: string | undefined
let _claude: string | undefined
const TMUX = () => (_tmux ??= resolveFromPath('tmux'))
const CLAUDE = () => (_claude ??= resolveFromPath('claude'))
const MAX_CONCURRENT = 3
const TIMEOUT_MS = 30 * 60 * 1000

const TZ = 'Europe/Budapest'

function bgSessionName(id: string): string {
  return `bg-${id}`
}

// --- Windows backend: in-process child_process map ---
//
// On POSIX the background-job pattern is "tmux new-session -d
// shellCmd" so the job survives a dashboard restart (tmux server is
// independent). On Windows there is no tmux, and pty-server is overkill
// for a non-interactive one-shot `claude -p` invocation. We just spawn
// the child directly, collect stdout/stderr into an in-memory buffer,
// and finalize on the child's exit event. Trade-off: a dashboard
// restart loses the in-memory map, so any "running" bg-task at
// restart time is swept to 'failed' by sweepOrphanedBackgroundTasks
// (winIsAlive returns false for anything not in the map). Matches
// the POSIX semantics for tmux-sessions that exited while the
// dashboard was down — both end up marked failed with whatever
// captured output was available.

interface WinJob {
  proc: ChildProcess
  output: string
  exited: boolean
}
const winJobs = new Map<string, WinJob>()

function winSpawnBg(id: string, session: string, prompt: string): boolean {
  const claudeBin = CLAUDE()
  let proc: ChildProcess
  try {
    proc = spawn(claudeBin, ['-p', prompt, '--output-format', 'text'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env },
    })
  } catch (err) {
    logger.error({ err, id }, 'winSpawnBg: spawn failed')
    return false
  }
  const job: WinJob = { proc, output: '', exited: false }
  winJobs.set(session, job)
  proc.stdout?.on('data', (d: Buffer) => { job.output += d.toString('utf-8') })
  proc.stderr?.on('data', (d: Buffer) => { job.output += d.toString('utf-8') })
  proc.on('exit', (code) => {
    job.exited = true
    const status = code === 0 ? 'done' : 'failed'
    finishBackgroundTask(id, status, job.output.trim() || '(no output)')
    winJobs.delete(session)
    logger.info({ id, code }, `Background task ${status}`)
  })
  proc.on('error', (err) => {
    job.exited = true
    finishBackgroundTask(id, 'failed', `(spawn error: ${err.message})`)
    winJobs.delete(session)
  })
  return true
}

function winIsAlive(session: string): boolean {
  const job = winJobs.get(session)
  return !!job && !job.exited
}

function winCapture(session: string): string | null {
  const job = winJobs.get(session)
  return job ? job.output : null
}

function winKill(session: string): void {
  const job = winJobs.get(session)
  if (!job) return
  try { job.proc.kill() } catch { /* already dead */ }
  winJobs.delete(session)
}

// --- Platform-dispatched primitives ---

function isBgSessionAlive(session: string): boolean {
  if (process.platform === 'win32') return winIsAlive(session)
  try {
    const out = execFileSync(TMUX(), ['list-sessions', '-F', '#{session_name}'], { timeout: 3000, encoding: 'utf-8' })
    return out.split('\n').some(l => l.trim() === session)
  } catch {
    return false
  }
}

function captureSession(session: string): string | null {
  if (process.platform === 'win32') return winCapture(session)
  try {
    return execFileSync(TMUX(), ['capture-pane', '-t', session, '-p', '-S', '-500'], { timeout: 5000, encoding: 'utf-8' })
  } catch {
    return null
  }
}

function killSession(session: string): void {
  if (process.platform === 'win32') return winKill(session)
  try {
    execFileSync(TMUX(), ['kill-session', '-t', session], { timeout: 3000 })
  } catch { /* already dead */ }
}

export function spawnBackgroundTask(agentId: string, prompt: string): BackgroundTask | { error: string } {
  const id = randomBytes(4).toString('hex').toUpperCase()
  const session = bgSessionName(id)

  const task = createBackgroundTaskAtomic(id, agentId, prompt, session, MAX_CONCURRENT)
  if (!task) {
    return { error: `Maximum ${MAX_CONCURRENT} egyidejű háttérfeladat ágensenként.` }
  }

  if (process.platform === 'win32') {
    if (!winSpawnBg(id, session, prompt)) {
      finishBackgroundTask(id, 'failed', '(spawn failed)')
      return { error: 'Nem sikerült elindítani a háttérfeladatot' }
    }
  } else {
    const shellCmd = [
      `export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"`,
      `${CLAUDE()} -p "$BG_PROMPT" --output-format text 2>&1`,
    ].join(' && ')

    try {
      execFileSync(TMUX(), [
        'new-session', '-d', '-s', session, '-x', '200', '-y', '50',
        `${shellCmd}; echo '___BG_DONE___'; sleep 5`,
      ], {
        timeout: 5000,
        env: { ...process.env, BG_PROMPT: prompt },
      })
    } catch (err) {
      logger.error({ err, id, session }, 'Failed to spawn background task tmux session')
      finishBackgroundTask(id, 'failed', '(spawn failed)')
      return { error: 'Nem sikerült elindítani a háttérfeladatot' }
    }
  }

  logger.info({ id, agentId, session, prompt: prompt.slice(0, 100) }, 'Background task started')

  setTimeout(() => checkAndFinalize(id), TIMEOUT_MS)
  pollUntilDone(id)

  return task
}

function pollUntilDone(id: string): void {
  const interval = setInterval(() => {
    const task = getBackgroundTask(id)
    if (!task || task.status !== 'running') {
      clearInterval(interval)
      return
    }

    const session = task.tmux_session
    if (!session) { clearInterval(interval); return }

    if (!isBgSessionAlive(session)) {
      const output = '(session ended)'
      finishBackgroundTask(id, 'done', output)
      logger.info({ id }, 'Background task session ended')
      clearInterval(interval)
      return
    }

    const pane = captureSession(session)
    if (pane && pane.includes('___BG_DONE___')) {
      const output = pane.replace(/___BG_DONE___[\s\S]*$/, '').trim()
      finishBackgroundTask(id, 'done', output)
      killSession(session)
      logger.info({ id }, 'Background task completed')
      clearInterval(interval)
    }
  }, 10_000)
}

function checkAndFinalize(id: string): void {
  const task = getBackgroundTask(id)
  if (!task || task.status !== 'running') return

  const session = task.tmux_session
  const output = session ? captureSession(session) : null
  finishBackgroundTask(id, 'timeout', output?.trim() || '(timeout)')
  if (session) killSession(session)
  logger.warn({ id }, 'Background task timed out after 30 minutes')
}

export function sweepOrphanedBackgroundTasks(): void {
  const running = getRunningBackgroundTasks()
  let orphaned = 0
  for (const task of running) {
    if (!task.tmux_session || !isBgSessionAlive(task.tmux_session)) {
      const output = task.tmux_session ? captureSession(task.tmux_session) : null
      finishBackgroundTask(task.id, 'failed', output?.trim() || '(orphaned on restart)')
      orphaned++
    } else {
      setTimeout(() => checkAndFinalize(task.id), TIMEOUT_MS)
      pollUntilDone(task.id)
    }
  }
  if (orphaned) logger.info({ orphaned }, 'Swept orphaned background tasks on startup')
}

const TASK_ID_RE = /^\/api\/background-tasks\/([A-F0-9]{8})$/

export async function tryHandleBackgroundTasks(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/background-tasks' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { agent_id: string; prompt: string }
    if (!data.prompt?.trim()) {
      json(res, { error: 'Prompt megadása kötelező' }, 400)
      return true
    }
    if (!data.agent_id?.trim()) {
      json(res, { error: 'Agent ID megadása kötelező' }, 400)
      return true
    }

    const result = spawnBackgroundTask(data.agent_id.trim(), data.prompt.trim())
    if ('error' in result) {
      json(res, { error: result.error }, 429)
      return true
    }
    json(res, result, 201)
    return true
  }

  if (path === '/api/background-tasks' && method === 'GET') {
    const agentId = url.searchParams.get('agent') || undefined
    const all = url.searchParams.get('all') === 'true'
    const tasks = getBackgroundTasks(agentId, all)
    const formatted = tasks.map(t => ({
      ...t,
      started_label: new Date(t.started_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }),
      finished_label: t.finished_at ? new Date(t.finished_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }) : null,
    }))
    json(res, formatted)
    return true
  }

  const taskMatch = path.match(TASK_ID_RE)
  if (taskMatch && method === 'GET') {
    const task = getBackgroundTask(taskMatch[1])
    if (!task) { json(res, { error: 'Háttérfeladat nem található' }, 404); return true }

    let liveOutput: string | null = null
    if (task.status === 'running' && task.tmux_session) {
      liveOutput = captureSession(task.tmux_session)
    }

    json(res, {
      ...task,
      liveOutput,
      started_label: new Date(task.started_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }),
      finished_label: task.finished_at ? new Date(task.finished_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }) : null,
    })
    return true
  }

  if (taskMatch && method === 'DELETE') {
    const task = getBackgroundTask(taskMatch[1])
    if (!task) { json(res, { error: 'Háttérfeladat nem található' }, 404); return true }
    const output = task.tmux_session ? captureSession(task.tmux_session) : null
    if (task.status === 'running' && task.tmux_session) {
      killSession(task.tmux_session)
    }
    finishBackgroundTask(task.id, 'failed', output?.trim() || '(cancelled)')
    json(res, { ok: true })
    return true
  }

  return false
}
