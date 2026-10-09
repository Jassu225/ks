import type { ProjectInfo, ThreadLink } from '../../types'
import { phaseLabel } from '../statusline/workflow'

type Doc = Record<string, unknown>

/** Where the unit's files are, read beside state.yaml. */
export type InfoContext = {
  /** state.yaml's directory. */
  workflowDir: string
}

const RELATED_TICKETS: Record<string, string> = {
  prd_ticket_id: 'PRD',
  prototype_ticket_id: 'Prototype',
  tad_ticket_id: 'TAD',
  implementation_plan_ticket_id: 'Plan',
}

/** slack.* keys the schema names, in the order the pane lists them. */
const THREAD_LABELS: Record<string, string> = {
  project_thread: 'Project thread',
  release_thread: 'Release thread',
  pr_review_threads: 'PR review',
}

function obj(value: unknown): Doc | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Doc) : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function named(value: unknown): string | null {
  return str(obj(value)?.name)
}

function thread(label: string, value: unknown): ThreadLink | null {
  const t = obj(value)
  if (!t) return null
  const channel = str(t.channel_name)
  const url = str(t.url)
  if (!channel && !url) return null
  return { label, channel: channel && !channel.startsWith('#') ? `#${channel}` : channel, url }
}

function humanize(key: string): string {
  const words = key.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Every Slack thread under `slack:`, known keys first, a list as one per entry. */
function threads(slack: Doc | null): ThreadLink[] {
  if (!slack) return []
  const keys = Object.keys(slack).sort((a, b) => {
    const rank = (k: string): number => (k in THREAD_LABELS ? Object.keys(THREAD_LABELS).indexOf(k) : 99)
    return rank(a) - rank(b)
  })
  return keys.flatMap(key => {
    const label = THREAD_LABELS[key] ?? humanize(key)
    const value = slack[key]
    if (Array.isArray(value)) {
      return value.flatMap((v, i) => thread(value.length > 1 ? `${label} ${i + 1}` : label, v) ?? [])
    }
    return thread(label, value) ?? []
  })
}

/** The unit's Linear workspace URL prefix, to link a bare ticket id. */
function issueUrl(unitUrl: string, identifier: string): string {
  const workspace = /linear\.app\/([^/]+)\//.exec(unitUrl)?.[1]
  return workspace ? `https://linear.app/${workspace}/issue/${identifier}` : unitUrl
}

/**
 * The pane's view of a parsed state.yaml (ticket or project). Reads leniently:
 * a field the file lacks, or holds in an older shape, is left out rather than
 * failing the whole pane.
 */
export function projectInfo(doc: unknown, ctx: InfoContext): ProjectInfo | null {
  const root = obj(doc)
  if (!root) return null
  const kind = obj(root.ticket) ? 'ticket' : obj(root.project) ? 'project' : null
  if (!kind) return null
  const unit = obj(root[kind]) ?? {}
  const url = str(unit.url) ?? ''
  const owner = kind === 'ticket' ? named(unit.assignee) : named(unit.lead)

  return {
    kind,
    identifier: str(unit.identifier),
    name: str(unit.name) ?? '',
    url,
    status: named(unit.status),
    priority: named(unit.priority),
    estimate: typeof unit.estimate === 'number' ? unit.estimate : null,
    owner: owner ? { role: kind === 'ticket' ? 'Assignee' : 'Lead', name: owner } : null,
    dueDate: str(obj(unit.dates)?.due_date),
    labels: list(unit.labels).flatMap(l => named(l) ?? []),
    parentProject: named(unit.parent_project)
      ? { name: named(unit.parent_project) ?? '', url: str(obj(unit.parent_project)?.url) }
      : null,
    initiatives: list(unit.initiatives).flatMap(i => named(i) ?? []),
    relatedTickets: Object.entries(RELATED_TICKETS).flatMap(([key, label]) => {
      const identifier = str(unit[key])
      return identifier ? [{ label, identifier, url: issueUrl(url, identifier) }] : []
    }),
    phases: list(root.phases).flatMap(p => {
      const phase = obj(p)
      if (!phase || typeof phase.number !== 'number' || phase.number === 0) return []
      const iterations = list(phase.iterations)
        .map(obj)
        .filter((i): i is Doc => i !== null)
      const first = iterations[0]
      const last = iterations[iterations.length - 1]
      const name = str(phase.name) ?? ''
      return [
        {
          number: phase.number,
          label: phaseLabel(name, phase.number),
          status: str(phase.status) ?? 'NOT_STARTED',
          startedAt: str(phase.started_at) ?? str(first?.started_at),
          endedAt: str(phase.ended_at) ?? str(last?.ended_at),
          iterations: iterations.length,
        },
      ]
    }),
    threads: threads(obj(root.slack)),
    prs: list(root.prs).flatMap(p => {
      const pr = obj(p)
      const prUrl = str(pr?.url)
      if (!pr || !prUrl) return []
      return [
        {
          url: prUrl,
          number: /\/pull\/(\d+)/.exec(prUrl)?.[1] ?? prUrl,
          branch: str(pr.branch),
          createdAt: str(pr.created_at),
          reviewThread: thread('Review', pr.review_thread),
        },
      ]
    }),
    worktree: str(root.worktree_dir),
    workflowDir: ctx.workflowDir,
  }
}

/** A workflow folder from `workflow/` on (`workflow/jaswanth/tickets/kar-123`), else as given. */
export function workflowLabel(dir: string): string {
  const at = dir.lastIndexOf('/workflow/')
  return at >= 0 ? dir.slice(at + 1) : dir
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `Oct 7 06:22` in UTC offset `offsetMinutes` (the host's, read once). */
export function formatWhen(iso: string, offsetMinutes: number): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return iso
  const d = new Date(ms + offsetMinutes * 60000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/** `11:31 AM`: the clock time of `ms` in UTC offset `offsetMinutes`, 12-hour with its meridian. */
export function formatClock(ms: number, offsetMinutes: number): string {
  const d = new Date(ms + offsetMinutes * 60000)
  const hours = d.getUTCHours()
  return `${hours % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`
}
