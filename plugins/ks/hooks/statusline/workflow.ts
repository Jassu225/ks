import type { PhaseStatus, WorkflowPhase, WorkflowUnit } from '../../types'

export type ParsedState = WorkflowUnit

/** Phases each workflow type runs, in order (phase 0, initialization, left out). */
const SEQUENCE: Record<WorkflowUnit['kind'], number[]> = {
  ticket: [1, 2, 9, 10],
  project: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
}

/** Phases that start in a fresh `claude-ks` session (see /ks:project-manager). */
const FRESH_SESSION_PHASES: Record<number, true> = { 2: true, 9: true, 10: true }

/** Short labels, by the phase names state.yaml uses (both naming generations). */
const PHASE_LABELS: Record<string, string> = {
  'context-creation': 'Context',
  'codebase-research': 'Research',
  'initial-prd-draft': 'PRD draft',
  'prd-creation': 'PRD draft',
  'prd-user-stories': 'Stories',
  'user-stories': 'Stories',
  'prototype-creation': 'Prototype',
  'complete-prd': 'PRD',
  'product-requirements': 'PRD',
  'tad-creation': 'TAD',
  'linear-tickets-creation': 'Tickets',
  'implementation-plan-creation': 'Plan',
  'implementation': 'Implement',
}

/** Default names for phases not yet in state.yaml. */
const DEFAULT_PHASE_NAMES: Record<number, string> = {
  1: 'context-creation',
  2: 'codebase-research',
  3: 'initial-prd-draft',
  4: 'prd-user-stories',
  5: 'prototype-creation',
  6: 'complete-prd',
  7: 'tad-creation',
  8: 'linear-tickets-creation',
  9: 'implementation-plan-creation',
  10: 'implementation',
}

const STATUSES: Record<string, PhaseStatus> = {
  NOT_STARTED: 'NOT_STARTED',
  IN_PROGRESS: 'IN_PROGRESS',
  REVISITING: 'REVISITING',
  COMPLETED: 'COMPLETED',
  SKIPPED: 'SKIPPED',
  INVALIDATED: 'INVALIDATED',
}

function scalar(raw: string): string {
  const v = raw.trim()
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    return v.slice(1, -1)
  }
  return v === 'null' || v === '~' ? '' : v
}

/**
 * Reads the few fields the band needs from a ks state.yaml. The file is written
 * by ks-start-ticket/ks-start-project in a fixed layout (top-level keys at
 * column 0, entity fields at two spaces, list items at `  - `), so a line scan
 * is enough and no YAML library has to ship with the mod.
 */
export function parseState(text: string): ParsedState | null {
  let block = ''
  let kind: WorkflowUnit['kind'] | null = null
  let identifier = ''
  let name = ''
  let url = ''
  const phases: WorkflowPhase[] = []
  let phase: WorkflowPhase | null = null

  for (const line of text.split('\n')) {
    const top = /^([A-Za-z_]+):/.exec(line)
    if (top) {
      block = top[1] ?? ''
      if (block === 'ticket' || block === 'project') kind = block
      continue
    }
    if (kind && block === kind) {
      const m = /^ {2}(identifier|name|url):(.*)$/.exec(line)
      if (!m) continue
      const value = scalar(m[2] ?? '')
      if (m[1] === 'identifier') identifier = value
      else if (m[1] === 'name') name = value
      else url = value
    } else if (block === 'phases') {
      const m = /^ {2}(- | {2})(number|name|status):(.*)$/.exec(line)
      if (!m) continue
      if (m[1] === '- ') {
        phase = { number: -1, name: '', status: 'NOT_STARTED' }
        phases.push(phase)
      }
      if (!phase) continue
      const value = scalar(m[3] ?? '')
      if (m[2] === 'number') phase.number = Number(value)
      else if (m[2] === 'name') phase.name = value
      else phase.status = STATUSES[value] ?? 'NOT_STARTED'
    }
  }

  if (!kind) return null
  return { kind, identifier: identifier || null, name, url, phases }
}

export type PhaseCell = { number: number; label: string; status: PhaseStatus }

export type Progress = {
  cells: PhaseCell[]
  /** The phase being worked (IN_PROGRESS or REVISITING), if any. */
  active: PhaseCell | null
  /** The first phase not yet completed or skipped, when nothing is active. */
  next: PhaseCell | null
  /** True when `next` starts in a fresh session (claude-ks relaunch). */
  isSessionBoundary: boolean
}

export function phaseLabel(name: string, number: number): string {
  return PHASE_LABELS[name] ?? (name || `Phase ${number}`)
}

export function progress(unit: Pick<WorkflowUnit, 'kind' | 'phases'>): Progress {
  const byNumber: Record<number, WorkflowPhase> = {}
  for (const p of unit.phases) byNumber[p.number] = p

  const cells = SEQUENCE[unit.kind].map((number): PhaseCell => {
    const p = byNumber[number]
    const name = p?.name || DEFAULT_PHASE_NAMES[number] || ''
    return { number, label: phaseLabel(name, number), status: p?.status ?? 'NOT_STARTED' }
  })

  const active = cells.find(c => c.status === 'IN_PROGRESS' || c.status === 'REVISITING') ?? null
  const next = active
    ? null
    : (cells.find(c => c.status !== 'COMPLETED' && c.status !== 'SKIPPED') ?? null)
  const isSessionBoundary = next !== null && FRESH_SESSION_PHASES[next.number] === true

  return { cells, active, next, isSessionBoundary }
}

/** Phases that moved to COMPLETED between two reads of the same state.yaml. */
export function newlyCompleted(before: WorkflowPhase[], after: WorkflowPhase[]): WorkflowPhase[] {
  const was: Record<number, PhaseStatus> = {}
  for (const p of before) was[p.number] = p.status
  return after.filter(p => p.status === 'COMPLETED' && was[p.number] !== 'COMPLETED')
}
