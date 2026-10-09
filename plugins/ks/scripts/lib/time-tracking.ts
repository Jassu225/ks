/**
 * Active time on a ks workflow unit, from the events time-log.sh records.
 *
 * Two figures, both unions of intervals so nothing counts twice (parallel
 * subagents, a background agent beside the main turn, two sessions on one
 * ticket):
 *
 *   agent   — Claude working: a turn from prompt to Stop, and each subagent
 *             from SubagentStart to SubagentStop.
 *   engaged — agent time plus your own between turns (reading, thinking,
 *             answering a permission prompt), as long as the gap is under the
 *             idle cut-off. A longer gap is time away and counts nothing.
 *
 * A turn that never reached Stop (Esc, a crash, a closed terminal) is open
 * until the next prompt; it counts only up to the idle cut-off, so a session
 * interrupted before lunch doesn't bill the lunch.
 */

export type TimeEvent = {
  /** Epoch ms. */
  ts: number
  event: string
  session: string
  /** Set on a subagent's own events. */
  agent?: string
  agentType?: string
  /** notification_type, SessionStart source or SessionEnd reason. */
  kind?: string
  /** The workflow phase in progress when the event fired. */
  phase?: string
}

export type Interval = { start: number; end: number; phase: string | null; isAgent: boolean }

export const DEFAULT_IDLE_MS = 10 * 60_000

/** Parses a time log (JSONL); malformed lines are skipped. */
export function parseLog(text: string): TimeEvent[] {
  const events: TimeEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as Partial<TimeEvent>
      if (typeof e.ts === 'number' && typeof e.event === 'string' && typeof e.session === 'string') {
        events.push(e as TimeEvent)
      }
    } catch {
      // a line cut short by a crash mid-append
    }
  }
  return events.sort((a, b) => a.ts - b.ts)
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = groups.get(k)
    if (list) list.push(item)
    else groups.set(k, [item])
  }
  return groups
}

/**
 * The main agent of one session, event by event, as a small state machine:
 *
 *   idle    — between turns: the gap is yours (counted while under the cut-off)
 *   busy    — a turn is running: the gap is Claude's
 *   waiting — a turn is blocked on you (a permission prompt): the gap is yours
 *
 * Only a prompt starts a turn. A tool event while idle is not Claude working:
 * plugins' own calls (a mod polling an MCP server every two minutes) raise
 * PostToolUse with no turn running, and counting those once billed hours of
 * "agent time" to a session sitting idle. `Now` is the stand-in summarize()
 * adds to count a live session up to the present.
 */
function mainIntervals(chain: TimeEvent[], idleMs: number, out: Interval[]): void {
  let state: 'idle' | 'busy' | 'waiting' = 'idle'
  /** Busy: the last moment Claude was seen working. Idle/waiting: when the wait began (null: nothing to count). */
  let since: number | null = null
  let phase: string | null = null

  const yours = (end: number): void => {
    if (since !== null && end > since && end - since <= idleMs) out.push({ start: since, end, phase, isAgent: false })
  }
  const claudes = (end: number, isCapped = false): void => {
    if (since === null || end <= since) return
    out.push({ start: since, end: isCapped ? since + Math.min(end - since, idleMs) : end, phase, isAgent: true })
  }

  for (const e of chain) {
    switch (e.event) {
      case 'UserPromptSubmit':
        // A prompt while busy: the last turn never reached Stop (Esc, a crash) — cap it.
        if (state === 'busy') claudes(e.ts, true)
        else yours(e.ts)
        state = 'busy'
        since = e.ts
        phase = e.phase ?? null
        break
      case 'Notification':
        if (state === 'busy') {
          claudes(e.ts)
          state = 'waiting'
          since = e.ts
        }
        break
      case 'Stop':
        if (state === 'busy') claudes(e.ts)
        else if (state === 'waiting') yours(e.ts)
        if (state !== 'idle' || since === null) since = e.ts
        state = 'idle'
        phase = e.phase ?? phase
        break
      case 'SessionStart':
        if (state === 'busy') claudes(e.ts, true)
        state = 'idle'
        since = e.ts
        phase = e.phase ?? phase
        break
      case 'SessionEnd':
        if (state === 'busy') claudes(e.ts, true)
        else yours(e.ts)
        state = 'idle'
        since = null; // nothing after an end is anyone's time
        break
      case 'Now':
        if (state === 'busy') claudes(e.ts)
        else yours(e.ts)
        break
      default:
        // PostToolUse and the like: progress inside a turn, an answered prompt
        // when waiting, noise when idle.
        if (state === 'busy') {
          claudes(e.ts)
          since = e.ts
        } else if (state === 'waiting') {
          yours(e.ts)
          state = 'busy'
          since = e.ts
        }
    }
  }
}

/** Every interval the events make: the main turns and gaps per session, and each subagent's run. */
export function intervals(events: TimeEvent[], idleMs = DEFAULT_IDLE_MS): Interval[] {
  const out: Interval[] = []
  const sorted = [...events].sort((a, b) => a.ts - b.ts)

  for (const chain of groupBy(sorted.filter(e => !e.agent), e => e.session).values()) {
    mainIntervals(chain, idleMs, out)
  }

  // Subagents: from their start to their stop, else to the last event they made.
  for (const run of groupBy(sorted.filter(e => e.agent), e => `${e.session}\u0000${e.agent}`).values()) {
    const start = run.find(e => e.event === 'SubagentStart') ?? run[0]
    const stop = run.find(e => e.event === 'SubagentStop') ?? run[run.length - 1]
    if (start && stop && stop.ts > start.ts) {
      out.push({ start: start.ts, end: stop.ts, phase: start.phase ?? null, isAgent: true })
    }
  }
  return out
}

/** Total ms covered by the intervals, overlaps counted once. */
export function unionMs(list: { start: number; end: number }[]): number {
  const sorted = [...list].sort((a, b) => a.start - b.start)
  let total = 0
  let start = -Infinity
  let end = -Infinity
  for (const i of sorted) {
    if (i.start > end) {
      if (end > start) total += end - start
      start = i.start
      end = i.end
    } else if (i.end > end) {
      end = i.end
    }
  }
  if (end > start) total += end - start
  return total
}

/** Splits intervals at local midnight, so a day's total is that day's. */
function byLocalDay(list: Interval[]): Map<string, Interval[]> {
  const days = new Map<string, Interval[]>()
  const key = (ms: number): string => {
    const d = new Date(ms)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  for (const i of list) {
    let start = i.start
    while (start < i.end) {
      const d = new Date(start)
      const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
      const end = Math.min(i.end, midnight)
      const k = key(start)
      const list = days.get(k) ?? []
      list.push({ ...i, start, end })
      days.set(k, list)
      start = end
    }
  }
  return days
}

export type Figures = { engagedMs: number; agentMs: number }

export type TimeSummary = Figures & {
  idleMs: number
  sessions: number
  firstAt: number | null
  lastAt: number | null
  /** By phase number (`-` when no phase was in progress), each a union of its own. */
  byPhase: Record<string, Figures>
  /** By local date (YYYY-MM-DD). */
  byDay: Record<string, Figures>
}

function figures(list: Interval[]): Figures {
  return { engagedMs: unionMs(list), agentMs: unionMs(list.filter(i => i.isAgent)) }
}

/**
 * With `now`, a session still going counts up to it: its last event is closed
 * off by a stand-in at `now`, so the turn running (or the gap you are in) shows
 * as it grows. Only for a session heard from within the idle cut-off: a session
 * that went quiet longer ago is away or gone, and adds nothing.
 */
export function summarize(events: TimeEvent[], idleMs = DEFAULT_IDLE_MS, now?: number): TimeSummary {
  const live: TimeEvent[] = []
  if (now !== undefined) {
    for (const chain of groupBy(events.filter(e => !e.agent), e => e.session).values()) {
      const last = chain.reduce((a, b) => (b.ts > a.ts ? b : a))
      if (last.event !== 'SessionEnd' && now > last.ts && now - last.ts <= idleMs) {
        live.push({ ts: now, event: 'Now', session: last.session, phase: last.phase })
      }
    }
  }
  const all = intervals([...events, ...live], idleMs)
  const byPhase: Record<string, Figures> = {}
  for (const [phase, list] of groupBy(all, i => i.phase ?? '-')) byPhase[phase] = figures(list)
  const byDay: Record<string, Figures> = {}
  for (const [day, list] of [...byLocalDay(all)].sort(([a], [b]) => a.localeCompare(b))) byDay[day] = figures(list)
  return {
    ...figures(all),
    idleMs,
    sessions: new Set(events.map(e => e.session)).size,
    firstAt: events.length ? Math.min(...events.map(e => e.ts)) : null,
    lastAt: events.length ? Math.max(...events.map(e => e.ts)) : null,
    byPhase,
    byDay,
  }
}

/** `3h 12m`, `47m`, `0m`. */
export function formatDuration(ms: number): string {
  const mins = Math.round(ms / 60_000)
  const hours = Math.floor(mins / 60)
  return hours > 0 ? `${hours}h ${String(mins % 60).padStart(2, '0')}m` : `${mins}m`
}
