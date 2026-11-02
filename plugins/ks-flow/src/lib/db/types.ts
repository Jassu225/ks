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
  /** AskUserQuestion | ExitPlanMode | PermissionRequest | Elicitation | Inbox */
  tool: string;
  since: string;
  sessionId: string;
}

/** One Inbox question or action item still waiting on the person. */
export interface InboxQuestionRef {
  id: string; // `<message id>/<key>`
  messageId: string;
  kind: string; // single | multi | text | action
  prompt: string; // clipped
  stopped: string | null; // the agent can't go on until it's answered: why
  holdsUp: string[];
  askedAt: string;
  /** The Claude session that asked it. */
  askedBy: string | null;
  /** open: unanswered; picked: answered in the Inbox but not sent yet. */
  state: 'open' | 'picked';
}

/** A Plannotator Inbox thread with something for the person (lib/inbox). */
export interface InboxThreadRef {
  threadId: string; // the root message id: the Inbox links it as #thread=<id>
  projectKey: string;
  subject: string | null;
  open: number;
  picked: number;
  actions: number; // of the open + picked, how many are action items
  stopped: string | null;
  holdsUp: string[];
  unseen: number; // agent messages the person hasn't looked at
  since: string | null; // when the oldest waiting question was asked
  lastAt: string;
  /** The message the link lands on (`&msg=`): the first one waiting, else the first unseen. */
  linkMessageId: string | null;
  questions: InboxQuestionRef[];
}

/** A card's Inbox threads. needsYou: a question, action item or unsent answer waits. */
export interface InboxCardState {
  needsYou: boolean;
  stopped: boolean;
  since: string | null;
  threads: InboxThreadRef[];
}

/** Project-level document. phaseModel is the ORDERED COLUMN SET. */
export interface ProjectDoc {
  projectId: string; // stable hash of PROJECT_COMMON_DIR
  projectPath: string;
  commonDir: string;
  workflowType: 'ticket' | 'project' | 'mixed';
  phaseModel: PhaseRef[]; // ordered union of phases (the columns)
  worktreePaths: string[]; // CURRENT git worktrees — board hides cards not in this set
  /** The Plannotator Inbox's address (its port changes on restart) and whether it answers. */
  inboxUrl?: string | null;
  inboxRunning?: boolean;
  updatedAt: string;
}

/** A work-unit = a card. Its column is currentPhase. */
export interface WorkUnitDoc {
  unitId: string; // ticket identifier (KAR-####) or project slug
  type: 'ticket' | 'project';
  identifier: string;
  title: string;
  linearStatus: string | null;
  /** Linear's colour for the status (hex) and its workflow type (backlog,
   * unstarted, started, completed, canceled, triage) — set once the daemon has
   * read the ticket live from Linear; absent before that. */
  linearStatusColor?: string | null;
  linearStatusType?: string | null;
  /** When the daemon last read this ticket from Linear (ISO); absent if never. */
  linearSyncedAt?: string | null;
  /** When the card's Refresh last finished (ISO), and what failed in it, if anything. */
  cardRefreshedAt?: string | null;
  cardRefreshError?: string | null;
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
  /** Claude Code processes running in this unit's worktree right now, newest
   * first — from Claude's own ~/.claude/sessions/<pid>.json, matched by cwd. */
  liveSessions?: LiveSession[];
  /** The newest of liveSessions: the one `ks-flow session` hands to scripts. */
  activeSession?: LiveSession | null;
  /** The card's Plannotator Inbox threads; null when none has anything for the person. */
  inbox?: InboxCardState | null;
  /** The entire parsed state.yaml, verbatim — so the board can surface any
   * field without new plumbing. The typed fields above are extracted from it
   * for convenient rendering. */
  state: Record<string, unknown> | null;
  updatedAt: string;
}

/** A live interactive Claude Code process. Only the fields that stay fixed for
 * the process's life are kept, so its busy/idle flips don't rewrite the card. */
export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
  /** Process start time (`ps lstart` format, UTC) — tells it apart from a later process reusing the pid. */
  procStart: string;
  startedAt: string; // ISO
  /** tmux pane id (`%42`) the session runs in, if it runs in tmux. */
  tmuxPane: string | null;
  name: string | null;
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

// ── transcript backups ──────────────────────────────────────────────────────
// What the GCS backup has uploaded (one doc per unit) and the history of its
// sweeps (one doc per run). Written and read by the backup CLI
// (transcript-backup.ts), which the daemon, the board and the removal hook all
// run. Ids are `uid`, like reminders.

/** One uploaded session JSONL (or the time log), keyed in `sessions` by its
 * path relative to the transcript dir. */
export interface ArchivedSession {
  size: number;
  mtimeMs: number;
  /** Bytes stored in the bucket (zstd); absent on records written before it was kept. */
  compressedSize?: number;
  object: string; // gs:// URI, for the UI and for restore
  uploadedAt: string;
}

/** Everything the bucket holds for one unit, as the sweep last left it. A
 * CACHE of the bucket: each sweep reconciles it against a listing, and
 * `--reindex` rebuilds it from one. */
export interface BackupUnitDoc {
  uid: string; // object-name-safe identifier (safeId) — doc id
  identifier: string;
  worktreePath: string;
  transcriptDir: string;
  sessions: Record<string, ArchivedSession>;
  /** Refreshed whenever this unit had a session upload — the two always travel
   * together, so a restore gets the workflow state that matches the transcript. */
  workflow: { object: string; size: number; uploadedAt: string } | null;
  /** The unit's time log (the ks plugin's ~/.claude/ks-time/<identifier>.jsonl). */
  timeLog?: ArchivedSession | null;
  lastArchivedAt: string;
}

/** What started a sweep. */
export type BackupTrigger = 'daily' | 'manual' | 'unit' | 'removal' | 'completed';

/** One object a run put in the bucket. */
export interface RunUpload {
  /** `transcript/<id>.jsonl`, `workflow.tar.zst` or `time-log.jsonl.zst`, under the unit. */
  path: string;
  kind: 'session' | 'workflow' | 'time-log';
  /** Uncompressed bytes: the source file, or a workflow folder's files together. */
  size: number;
  /** Bytes uploaded (zstd). Absent on runs recorded before it was kept. */
  compressedSize?: number;
}

/** A unit a run did something for: uploaded or failed. Units already current are only counted. */
export interface RunUnit {
  identifier: string;
  uploads: RunUpload[];
  errors: string[];
}

/** One sweep. Written as it starts; the end fields arrive when it finishes. */
export interface BackupRunDoc {
  uid: string; // run id — doc id
  startedAt: string;
  trigger: BackupTrigger;
  /** What the run was pointed at: `all live worktrees`, a unit id, a worktree path, `completed units`. */
  scope: string;
  /** The sweep's process, to tell a run still going from one that died. */
  pid: number;
  endedAt?: string;
  /** ok: nothing failed; partial: some uploads failed; failed: it could not do its job. */
  outcome?: 'ok' | 'partial' | 'failed';
  error?: string;
  /** Units the run looked at: one per target worktree. */
  unitsChecked?: number;
  /** Of those, units with nothing to upload (and no errors): already backed up. */
  unitsCurrent?: number;
  uploadedCount?: number;
  errorCount?: number;
  /** Uncompressed bytes of everything uploaded. */
  bytesSource?: number;
  /** Compressed bytes actually uploaded. */
  bytesUploaded?: number;
  units?: RunUnit[];
}

/** The backup CLI's side. */
export interface BackupStore {
  getBackupUnits(projectId: string): Promise<BackupUnitDoc[]>;
  upsertBackupUnit(projectId: string, doc: BackupUnitDoc): Promise<void>;
  /** Newest first. */
  getBackupRuns(projectId: string): Promise<BackupRunDoc[]>;
  upsertBackupRun(projectId: string, doc: BackupRunDoc): Promise<void>;
}

// ── briefing ────────────────────────────────────────────────────────────────
// What the master session found in Slack for the person (docs/briefing.md).
// The master writes items and runs only through `ks-flow briefing` (the CLI);
// the board archives and moves due times; the daemon records the notices it
// sent. Nothing archives an item but the person. Ids are `uid`, like reminders.
// master_events (MasterEventDoc) is the daemon's and the board's log of what
// they did to the master.
// The kind/stage/rule unions match lib/briefing/escalation.ts, which can't
// import them (the board keeps a verbatim copy of it).

export type BriefingKind = 'ask' | 'promise' | 'fyi';
export type BriefingStage = 'calm' | 'warm' | 'hot' | 'overdue';
export type DueRule = 'message' | 'promise' | 'dm' | 'mention' | 'fyi' | 'manual';
export type Resolution = 'done' | 'not-mine' | 'wont-do';

/** Where the item came from in Slack. Both links are always stored so items
 * can be grouped and found by either. */
export interface SlackRef {
  channel: string; // C…/D…/G… id
  channelName: string | null; // "#ai", "DM", "group DM"
  ts: string; // this message's ts
  threadTs: string | null; // the thread root's ts when this message is a reply; null for a root message
  messageUrl: string; // permalink to THIS exact message
  threadUrl: string | null; // permalink to the thread's ROOT message; null when this message is the root
  from: { id: string; name: string };
  text: string; // the exact message text
  sentAt: string; // ISO
}

export interface DueChange {
  at: string; // ISO, when the change was made
  from: string | null; // previous dueAt (null on first set)
  to: string;
  by: 'master' | 'you';
  reason?: string;
}

export interface BriefingItemDoc {
  uid: string; // itemUid(key) — doc id
  key: string; // `slack:<channel>:<ts>` — one item per Slack message
  groupKey: string; // `slack:<channel>:<threadTs ?? ts>` — one card per thread
  kind: BriefingKind;
  title: string; // one line, what is asked or promised
  why: string; // one line: why it is on the list / why this due time
  source: SlackRef;
  receivedAt: string; // ISO (= source.sentAt)
  clockStart: string; // ISO: receivedAt, or the next Monday 09:00 when received on a weekend
  dueAt: string; // ISO
  dueRule: DueRule;
  dueSetByYou: boolean; // true once the person sets a due time; the master never changes it after
  dueHistory: DueChange[];
  pushedCount: number; // times the person moved dueAt later
  fyiCap: boolean; // kind 'fyi': the stage never passes 'warm'
  quick: boolean; // a small ask (≈ under 5 min): eligible for the Quick replies batch
  unit: string | null; // KAR-… when linked to a ticket
  links: { label: string; url: string }[];
  evidence: { at: string; text: string; url?: string }[]; // "looks done" hints; never closes anything
  linkedTo: string | null; // uid of an archived item this one follows up
  status: 'open' | 'archived';
  archivedAt: string | null;
  resolution: Resolution | null;
  archiveNote: string | null;
  // No `notified`: the notices the daemon sent live in its own
  // <dataDir>/master/notices.json, so the daemon never writes an item.
  createdBy: 'master' | 'you';
  runId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One pass of the master over Slack. Written running; finished by `run finish`. */
export interface BriefingRunDoc {
  uid: string; // uuid — doc id
  trigger: 'schedule' | 'button' | 'log-in' | 'log-off' | 'manual';
  slot: string | null; // '06:00' for a scheduled run
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'ok' | 'failed';
  slackCursor: string | null; // ISO: Slack read up to here; the next run starts from the newest ok run's
  added: number;
  updated: number;
  summary: string | null;
  error: string | null;
}

/** One local day's log-in / log-off record. */
export interface DailyLogDoc {
  uid: string; // 'YYYY-MM-DD' (local) — doc id
  date: string;
  logInAt: string | null;
  logOffAt: string | null;
  logIn: Record<string, unknown> | null; // what /ks-master:log-in reported (plan, counts, sessions)
  logOff: Record<string, unknown> | null; // what /ks-master:log-off reported (archived, slipped, sessions, time)
  sessions: {
    unit: string;
    sessionId: string | null;
    phase: string | null;
    state: string;
    lastDid: string;
    suggestion?: string;
  }[];
  updatedAt: string;
}

/** Something done to or for the master session in the background: the daemon
 * starting or hard-restarting it, or a request file written for it (by the
 * daemon's schedule, or the board's Brief me now / Restart master). The
 * request files and daemon-state.json keep only what is pending and the last
 * action; this is the history the board's Activity Log lists. */
export interface MasterEventDoc {
  uid: string; // uuid — doc id
  at: string; // ISO
  kind: 'start' | 'restart' | 'request';
  /** A request's trigger. */
  trigger?: 'schedule' | 'button' | 'restart';
  /** A schedule request's slot ('06:00'). */
  slot?: string | null;
  /** Why: the supervisor's reason (`no live process for session.json`), or what asked. */
  reason: string;
  by: 'daemon' | 'board';
  /** ok: launched and exited 0 / request written · failed · dropped: one of that
   * trigger was already pending. Absent while a start/restart command still runs. */
  result?: 'ok' | 'failed' | 'dropped';
  /** The request id, the command's exit, an error. */
  detail?: string;
}

/** Read filter for briefing items; both fields optional (absent = all). */
export interface BriefingItemFilter {
  status?: 'open' | 'archived';
  groupKey?: string;
}

/** The briefing CLI's and the daemon's side. Writes replace the whole doc. */
export interface BriefingStore {
  getBriefingItems(projectId: string, filter?: BriefingItemFilter): Promise<BriefingItemDoc[]>;
  getBriefingItem(projectId: string, uid: string): Promise<BriefingItemDoc | null>;
  upsertBriefingItem(projectId: string, doc: BriefingItemDoc): Promise<void>;
  /** Newest first. */
  getBriefingRuns(projectId: string): Promise<BriefingRunDoc[]>;
  getBriefingRun(projectId: string, uid: string): Promise<BriefingRunDoc | null>;
  upsertBriefingRun(projectId: string, doc: BriefingRunDoc): Promise<void>;
  getDailyLog(projectId: string, date: string): Promise<DailyLogDoc | null>;
  /** Newest first. */
  getDailyLogs(projectId: string): Promise<DailyLogDoc[]>;
  upsertDailyLog(projectId: string, doc: DailyLogDoc): Promise<void>;
  /** Newest first, at most `limit` (default 200). */
  getMasterEvents(projectId: string, limit?: number): Promise<MasterEventDoc[]>;
  upsertMasterEvent(projectId: string, doc: MasterEventDoc): Promise<void>;
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
  backups(): BackupStore;
  briefing(): BriefingStore;
}
