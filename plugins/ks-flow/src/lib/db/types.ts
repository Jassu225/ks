// lib/db/types.ts — the stable seam.
//
// No provider imports may appear in this file. It defines the
// provider-agnostic document shapes and the role-split contract
// (SessionWriter on the daemon side, SessionSource on the board side).
// The daemon imports only SessionWriter; the board imports only
// SessionSource; derive.ts / jsonl.ts / hooks import neither.

export type PhaseStatus =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'SKIPPED'
  | 'REVISITING'
  | 'INVALIDATED';

export interface PhaseRef {
  number: number;
  name: string;
}

export interface PhaseEntry extends PhaseRef {
  status: PhaseStatus;
  startedAt: string | null;
  endedAt: string | null;
  iterations?: Array<{ startedAt: string | null; endedAt: string | null }>;
}

export interface PrRef {
  number: number | null;
  url: string;
  repo: string | null;
}

export interface WaitingState {
  active: boolean;
  /** AskUserQuestion | ExitPlanMode | PermissionRequest | Elicitation */
  tool: string;
  since: string;
  sessionId: string;
}

/** Project-level document. phaseModel is the ORDERED COLUMN SET. */
export interface ProjectDoc {
  projectId: string; // stable hash of PROJECT_COMMON_DIR
  projectPath: string;
  commonDir: string;
  workflowType: 'ticket' | 'project' | 'mixed';
  phaseModel: PhaseRef[]; // ordered union of phases (the columns)
  worktreePaths: string[]; // CURRENT git worktrees — board hides cards not in this set
  updatedAt: string;
}

/** A work-unit = a card. Its column is currentPhase. */
export interface WorkUnitDoc {
  unitId: string; // ticket identifier (KAR-####) or project slug
  type: 'ticket' | 'project';
  identifier: string;
  title: string;
  linearStatus: string | null;
  linearUrl: string | null; // entity.url from state.yaml
  slackThreadUrl: string | null; // slack.project_thread permalink (source thread)
  priority: { value: number | null; name: string } | null;
  estimate: number | null;
  worktreeDir: string | null;
  stateYamlPath: string;
  phases: PhaseEntry[];
  currentPhase: PhaseRef | null; // derived → which column the card sits in
  pr: PrRef | null;
  slack: unknown | null;
  waiting: WaitingState | null; // aggregated from joined sessions
  sessionIds: string[];
  lastActivity: string | null;
  /** The entire parsed state.yaml, verbatim — so the board can surface any
   * field without new plumbing. The typed fields above are extracted from it
   * for convenient rendering. */
  state: Record<string, unknown> | null;
  updatedAt: string;
}

export interface OpenAsk {
  toolUseId: string;
  tool: string; // AskUserQuestion | ExitPlanMode
  since: string;
}

export interface OverlayWait {
  overlayId: string;
  kind: string; // PermissionRequest | Elicitation
  since: string;
  cleared: boolean;
}

/** JSONL-derived session activity, joined to a unit by worktree. */
export interface SessionDoc {
  sessionId: string;
  unitId: string | null;
  title: string | null;
  cwd: string | null;
  gitBranch: string | null;
  worktreePath: string | null;
  projectDir: string; // ~/.claude/projects/<encoded>
  filePath: string;
  firstActivity: string | null;
  lastActivity: string | null; // last line WITH a timestamp
  userMsgs: number;
  assistantMsgs: number;
  version: string | null;
  entrypoint: string | null;
  activity: 'active' | 'idle'; // recency only — NOT a column
  waitingSince: string | null;
  waitingTool: string | null;
  pr: PrRef | null;
  openAsks: OpenAsk[]; // JSONL-derived waits
  overlayWaits: OverlayWait[]; // permission/elicitation overlay
  inProject: boolean;
  archived: boolean;
  updatedAt: string;
}

export type Unsubscribe = () => void;

/**
 * A reminder record (stop-nudge pause flag OR a per-card custom reminder).
 * Lives in the `reminders` collection; the board's server writes it, the daemon
 * polls + writes back. The document id field is ALWAYS `uid` (PB + Firestore).
 */
export interface ReminderDoc {
  uid: string; // doc id — PB `uid` field / Firestore doc id
  projectId: string;
  kind: 'custom' | 'pause' | 'note';
  // kind: 'custom'
  unitId?: string; // the card
  dueAt?: string; // ISO — resolved from relative/absolute at set-time
  note?: string;
  lastFiredAt?: string | null;
  cleared?: boolean;
  // kind: 'pause'
  sessionId?: string; // paused session (its card shows the Paused badge)
  pausedAt?: string;
  // kind: 'note' — a standalone Notes-page entry (not tied to a card). May carry
  // an optional reminder (dueAt) that re-nags daily once lapsed, like 'custom'.
  section?: 'generic' | 'slack' | 'linear'; // which Notes section it belongs to
  workType?: 'personal' | 'professional'; // which Notes column (default professional)
  text?: string; // the note / saved-message body
  sourceDate?: string; // ISO — original date of the source (e.g. the Slack message)
  sourceUrl?: string; // permalink to the source (e.g. the Slack message)
  done?: boolean; // note marked completed → archived (hidden from board, daemon skips)
  createdAt: string;
}

/** Daemon (Node) side. */
export interface SessionWriter {
  upsertSession(projectId: string, doc: SessionDoc): Promise<void>;
  upsertMany(projectId: string, docs: SessionDoc[]): Promise<void>; // batched (backfill)
  upsertWorkUnit(projectId: string, doc: WorkUnitDoc): Promise<void>;
  upsertProject(doc: ProjectDoc): Promise<void>;
  markArchived(projectId: string, id: string): Promise<void>;
  // reminders: the daemon polls (getReminders) + writes back (upsert/delete).
  getReminders(projectId: string): Promise<ReminderDoc[]>;
  upsertReminder(projectId: string, doc: ReminderDoc): Promise<void>;
  deleteReminder(projectId: string, uid: string): Promise<void>;
  close?(): Promise<void>;
}

/** Board (UI) side. */
export interface SessionSource {
  getProject(projectId: string): Promise<ProjectDoc | null>;
  getWorkUnits(projectId: string): Promise<WorkUnitDoc[]>;
  getSessions(projectId: string): Promise<SessionDoc[]>;
  getReminders(projectId: string): Promise<ReminderDoc[]>;
  subscribeWorkUnits(
    projectId: string,
    onChange: (docs: WorkUnitDoc[]) => void,
  ): Unsubscribe;
  subscribeSessions(
    projectId: string,
    onChange: (docs: SessionDoc[]) => void,
  ): Unsubscribe;
  subscribeReminders(
    projectId: string,
    onChange: (docs: ReminderDoc[]) => void,
  ): Unsubscribe;
}

export interface DbProvider {
  name: string;
  writer(): SessionWriter;
  source(): SessionSource;
}
