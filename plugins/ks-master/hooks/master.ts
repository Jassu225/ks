// The wake-up mod's logic, free of `$`: what the files say and what to do
// about them. register.ts does the I/O. Tested in master.test.ts.
//
// Files (contract: plugins/ks-flow/docs/briefing.md, "The master"), all under
// <dataDir>/master/:
//   session.json      { v: 1, sessionId, pid, tmuxPane, cwd, startedAt, handoff }
//   heartbeat.json    { sessionId, at, busy }
//   requests/<iso>-<trigger>.json  { v: 1, id, trigger, slot, createdAt, prompt }
//   done/             requests the mod took (submitted, or dropped as a duplicate)

export const HEARTBEAT_MS = 30_000
export const POLL_MS = 15_000
/** Context fill (percent) past which the mod asks the master, once, to restart gracefully. */
export const CONTEXT_RESTART_PERCENT = 70

export type Trigger = 'schedule' | 'button' | 'restart'
const TRIGGERS: readonly string[] = ['schedule', 'button', 'restart']

export interface MasterSession {
  v: 1
  sessionId: string
  pid: number | null
  tmuxPane: string | null
  cwd: string
  startedAt: string
  handoff: string | null
}

export interface Heartbeat {
  sessionId: string
  at: string
  busy: boolean
}

export interface MasterRequest {
  v: 1
  id: string
  trigger: Trigger
  slot: string | null
  createdAt: string
  prompt: string
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseJson(text: string | null | undefined): unknown {
  if (typeof text !== 'string') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function parseSession(text: string | null | undefined): MasterSession | null {
  const raw = parseJson(text)
  if (!isObject(raw) || typeof raw.sessionId !== 'string') return null
  return {
    v: 1,
    sessionId: raw.sessionId,
    pid: typeof raw.pid === 'number' ? raw.pid : null,
    tmuxPane: typeof raw.tmuxPane === 'string' ? raw.tmuxPane : null,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
    handoff: typeof raw.handoff === 'string' ? raw.handoff : null,
  }
}

/**
 * Whether this process is the master session.json names: the same session id
 * (the launcher picked it), or the same pid (the session id moved on, as after
 * `/clear`). A process that is neither — an old master still shutting down
 * while a new one starts — must not take requests or touch the file.
 */
export function owns(session: MasterSession | null, me: { sessionId: string; pid: number | null }): boolean {
  if (!session) return false
  if (session.sessionId === me.sessionId) return true
  return me.pid !== null && session.pid === me.pid
}

/** session.json as this process should leave it: its pid in, its current session id. */
export function claimed(session: MasterSession, me: { sessionId: string; pid: number | null }): MasterSession {
  return { ...session, sessionId: me.sessionId, pid: me.pid ?? session.pid }
}

/** The first `<pid>.json` in ~/.claude/sessions whose sessionId is ours. */
export function pidFromSessionFile(text: string | null | undefined, sessionId: string): number | null {
  const raw = parseJson(text)
  if (!isObject(raw) || raw.sessionId !== sessionId || typeof raw.pid !== 'number') return null
  return raw.pid
}

/** The prompt a request carries; when it has none, the default for its trigger. */
export function defaultPrompt(trigger: Trigger, slot: string | null): string {
  switch (trigger) {
    case 'schedule':
      return `/ks-master:briefing schedule${slot ? ` ${slot}` : ''}`
    case 'button':
      return '/ks-master:briefing button'
    case 'restart':
      return '/ks-master:restart requested from the board'
  }
}

export function parseRequest(text: string | null | undefined): MasterRequest | null {
  const raw = parseJson(text)
  if (!isObject(raw) || typeof raw.trigger !== 'string' || !TRIGGERS.includes(raw.trigger)) return null
  const trigger = raw.trigger as Trigger
  const slot = typeof raw.slot === 'string' ? raw.slot : null
  const prompt = typeof raw.prompt === 'string' && raw.prompt.trim() ? raw.prompt : defaultPrompt(trigger, slot)
  return {
    v: 1,
    id: typeof raw.id === 'string' ? raw.id : '',
    trigger,
    slot,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    prompt,
  }
}

/** Request file names in the order they are taken: oldest first (`<iso>-<trigger>.json` sorts by time). */
export function requestOrder(names: readonly string[]): string[] {
  return names.filter(n => n.endsWith('.json') && !n.startsWith('.')).sort()
}

/**
 * What to do with the pending requests (already parsed, in `requestOrder`):
 * submit the first; drop every later one whose trigger it shares (one pending
 * request per trigger — the writers already keep to that; this catches a race).
 * Unreadable files are dropped too, so one bad file cannot block the queue.
 * A `restart` request made before this master started (`startedAt`, ms) is
 * dropped: it was meant for an earlier master (or none), and taking it would
 * make a fresh master restart itself straight away. Other triggers still run.
 */
export function plan(
  pending: readonly { name: string; request: MasterRequest | null }[],
  startedAt: number | null = null,
): { take: { name: string; request: MasterRequest } | null; drop: string[] } {
  const drop: string[] = []
  let take: { name: string; request: MasterRequest } | null = null
  for (const p of pending) {
    const made = p.request ? Date.parse(p.request.createdAt) : NaN
    const stale = p.request?.trigger === 'restart' && startedAt !== null && Number.isFinite(made) && made < startedAt
    if (!p.request || stale) drop.push(p.name)
    else if (!take) take = { name: p.name, request: p.request }
    else if (p.request.trigger === take.request.trigger) drop.push(p.name)
  }
  return { take, drop }
}

/** The system-prompt section: the instructions file with this launch's paths filled in. */
export function instructionsSection(template: string, vars: { masterDir: string; handoffsDir: string; cwd: string }): string {
  return template
    .replaceAll('{{MASTER_DIR}}', vars.masterDir)
    .replaceAll('{{HANDOFFS_DIR}}', vars.handoffsDir)
    .replaceAll('{{CWD}}', vars.cwd)
}
