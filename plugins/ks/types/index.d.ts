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
    /** Each run (the phase itself, or each iteration): which phase the time log's events fell in. */
    runs: { startedAt: string; endedAt: string | null }[]
  }[]
  threads: ThreadLink[]
  prs: { url: string; number: string; branch: string | null; createdAt: string | null; reviewThread: ThreadLink | null }[]
  worktree: string | null
  /** state.yaml's directory: the unit's workflow folder. */
  workflowDir: string
}

/** The ticket's Linear state, fetched live while the project pane is open. */
export type LinearStatus = {
  name: string
  /** Linear's state type: triage, backlog, unstarted, started, completed, canceled. */
  type: string
  /** `#rrggbb`: the state's own color, else its type's default. */
  color: string
  /** The minute (epoch ms / 60000) it was fetched: a refetch in the same minute writes nothing. */
  checkedMinute: number
}

/** The newest Vercel preview deployment of the unit's branch. */
export type PreviewDeploy = {
  /** Vercel's deployment id (`dpl_…`). */
  id: string
  branch: string
  /** Vercel's state: QUEUED, INITIALIZING, BUILDING, READY, ERROR, CANCELED. */
  state: string
  /** This build's own https URL: a new one every push. */
  url: string | null
  /** The branch's https alias, the same for every build of the branch: what the preview links open. */
  branchUrl: string | null
  /** The deployment's page on vercel.com (build logs). */
  inspectorUrl: string | null
  sha: string | null
  /** Epoch ms the deployment was created. */
  createdAt: number
  checkedMinute: number
}

declare module 'claude-code' {
  interface PluginState {
    ks: {
      workflowUnit: WorkflowUnit | null
      statusFacts: StatusFacts | null
      projectInfo: ProjectInfo | null
      linearStatus: LinearStatus | null
      previewDeploy: PreviewDeploy | null
      /** Whether the project pane is open: the statusline's toggle reads `≡ less` then. */
      paneOpen: boolean
      /**
       * Minutes from the unit's time log: engaged per phase number (`-`: none in
       * progress — before the first phase, between phases), and engaged and agent
       * in all, overlaps counted once (so not the sum of the phases).
       */
      phaseTime: { byPhase: Record<string, number>; engaged: number; agent: number } | null
    }
  }
}
