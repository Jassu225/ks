// The count behind the gate. Every open session holds a slot and so does every
// live agent. No session sees another's agents, so each ks-agent-limit session
// publishes its own count to a file of its own in a shared folder, and every
// session sums the fresh files.

/** What one session publishes: its live agents, as of `at`. */
export type SessionFile = {
  session: string
  agents: number
  /** Epoch ms of the last heartbeat: a file older than STALE_MS is a session that died. */
  at: number
  /** Set as the session ends: its slot and its agents are free at once. */
  hasEnded?: boolean
}

/** How often a session rewrites its file. */
export const HEARTBEAT_MS = 15_000
/** A file this old is a session that crashed or was killed: it holds nothing. */
export const STALE_MS = 60_000

export function parseSessionFile(text: string): SessionFile | null {
  try {
    const doc = JSON.parse(text) as Partial<SessionFile> | null
    if (typeof doc?.session !== 'string' || typeof doc.agents !== 'number' || typeof doc.at !== 'number') return null
    return { session: doc.session, agents: doc.agents, at: doc.at, hasEnded: doc.hasEnded === true }
  } catch {
    return null
  }
}

/** The files of other sessions that are still running. */
export function liveOthers(files: SessionFile[], self: string, now: number): SessionFile[] {
  return files.filter(f => f.session !== self && !f.hasEnded && now - f.at < STALE_MS)
}

/** Account sessions ListAgents also lists: they run elsewhere and hold no slot here. */
const REMOTE_TYPES = new Set(['cloud', 'remote_control'])

/**
 * The other Claude sessions on this machine, from ListAgents' result: the rows
 * of its `sessions` section that are not cloud or Remote Control sessions.
 * Null when the result has no such section to read.
 */
export function localPeerCount(result: unknown): number | null {
  const sections = (result as { sections?: unknown } | null)?.sections
  if (!Array.isArray(sections)) return null
  const peers = sections.find(s => (s as { kind?: unknown } | null)?.kind === 'sessions') as
    | { rows?: { type?: unknown }[] }
    | undefined
  // A listing with no peer section: no other session is running.
  if (!peers) return 0
  return (peers.rows ?? []).filter(r => !REMOTE_TYPES.has(String(r.type ?? ''))).length
}

export type Usage = {
  limit: number
  /** Open sessions, this one included. */
  sessions: number
  /** Live agents across those sessions (as far as they report them). */
  agents: number
  used: number
  free: number
}

export function usage(limit: number, sessions: number, agents: number): Usage {
  const used = sessions + agents
  return { limit, sessions, agents, used, free: Math.max(0, limit - used) }
}

/** What the model reads when its spawn is refused. */
export function denyText(u: Usage, retryMinutes: number): string {
  return [
    `No free agent slot: ${u.used}/${u.limit} in use on this machine (${u.sessions} sessions, ${u.agents} agents). Nothing was started.`,
    `Tell the user you are waiting for a slot. Then wait ${retryMinutes} minutes: run \`sleep ${retryMinutes * 60}\` with Bash and run_in_background: true, and carry on when it finishes.`,
    'Then call mcp__ks-agent-limit__capacity and start at most `free` agents; if none is free, wait again.',
  ].join('\n')
}

/** What the person sees when a spawn is refused. */
export function blockedText(u: Usage, retryMinutes: number): string {
  return `Agent blocked: ${u.used}/${u.limit} slots in use (${u.sessions} sessions, ${u.agents} agents). Claude will check again in ${retryMinutes} min.`
}
