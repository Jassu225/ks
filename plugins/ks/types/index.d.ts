export type PhaseStatus =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'REVISITING'
  | 'COMPLETED'
  | 'SKIPPED'
  | 'INVALIDATED'

export type WorkflowPhase = { number: number; name: string; status: PhaseStatus }

/** The ks workflow unit (ticket or project) that owns this checkout. */
export type WorkflowUnit = {
  kind: 'ticket' | 'project'
  /** `KAR-123` for a ticket; projects have none. */
  identifier: string | null
  name: string
  url: string
  phases: WorkflowPhase[]
}

/** The figures the statusline row shows besides the workflow, refreshed on a timer. */
export type StatusFacts = {
  limits: { kind: string; percentUsed: number; resetsAt?: string }[]
  /** The minute (epoch ms / 60000) the figures were read; reset countdowns count from it. */
  minute: number
}

/** A Slack thread recorded in state.yaml, by its label in the pane. */
export type ThreadLink = { label: string; channel: string | null; url: string | null }

/** Everything state.yaml records about the unit, for the project pane. */
export type ProjectInfo = {
  kind: 'ticket' | 'project'
  identifier: string | null
  name: string
  url: string
  status: string | null
  priority: string | null
  estimate: number | null
  /** Ticket assignee, or project lead. */
  owner: { role: 'Assignee' | 'Lead'; name: string } | null
  dueDate: string | null
  labels: string[]
  parentProject: { name: string; url: string | null } | null
  initiatives: string[]
  /** A project's phase tickets (PRD, prototype, TAD, plan) by label. */
  relatedTickets: { label: string; identifier: string; url: string }[]
  phases: {
    number: number
    label: string
    status: string
    startedAt: string | null
    endedAt: string | null
    iterations: number
  }[]
  threads: ThreadLink[]
  prs: { url: string; number: string; branch: string | null; createdAt: string | null; reviewThread: ThreadLink | null }[]
  worktree: string | null
  /** state.yaml's directory: the unit's workflow folder. */
  workflowDir: string
}

declare module 'claude-code' {
  interface PluginState {
    ks: { workflowUnit: WorkflowUnit | null; statusFacts: StatusFacts | null; projectInfo: ProjectInfo | null }
  }
}
