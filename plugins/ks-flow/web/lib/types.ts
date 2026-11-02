// Board-side mirror of the provider-agnostic document shapes.
// Kept in sync with src/lib/db/types.ts (the daemon-side source of truth).
// Types are erased at compile time, so this duplication carries no runtime risk.

export interface PhaseRef {
  number: number;
  name: string;
}

export interface PrRef {
  number: number | null;
  url: string;
  repo: string | null;
}

export interface WaitingState {
  active: boolean;
  tool: string;
  since: string;
  sessionId: string;
}

/** One Inbox question or action item still waiting on the person. */
export interface InboxQuestionRef {
  id: string;
  messageId: string;
  kind: string; // single | multi | text | action
  prompt: string;
  stopped: string | null;
  holdsUp: string[];
  askedAt: string;
  /** The Claude session that asked it. */
  askedBy: string | null;
  /** open: unanswered; picked: answered in the Inbox but not sent yet. */
  state: 'open' | 'picked';
}

/** A Plannotator Inbox thread with something for the person. */
export interface InboxThreadRef {
  threadId: string;
  projectKey: string;
  subject: string | null;
  open: number;
  picked: number;
  actions: number;
  stopped: string | null;
  holdsUp: string[];
  unseen: number;
  since: string | null;
  lastAt: string;
  linkMessageId: string | null;
  questions: InboxQuestionRef[];
}

export interface InboxCardState {
  needsYou: boolean;
  stopped: boolean;
  since: string | null;
  threads: InboxThreadRef[];
}

/** Where the Inbox answers (its port changes on restart) and whether it does now. */
export interface InboxAddress {
  url: string | null;
  running: boolean;
}

export interface ProjectDoc {
  projectId: string;
  projectPath: string;
  commonDir: string;
  workflowType: 'ticket' | 'project' | 'mixed';
  phaseModel: PhaseRef[];
  worktreePaths: string[];
  inboxUrl?: string | null;
  inboxRunning?: boolean;
  updatedAt: string;
}

export interface WorkUnitDoc {
  unitId: string;
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
  linearUrl: string | null;
  slackThreadUrl: string | null;
  priority: { value: number | null; name: string } | null;
  estimate: number | null;
  worktreeDir: string | null;
  currentPhase: PhaseRef | null;
  pr: PrRef | null;
  waiting: WaitingState | null;
  sessionIds: string[];
  lastActivity: string | null;
  /** The card's Plannotator Inbox threads; null/absent when none has anything for the person. */
  inbox?: InboxCardState | null;
  /** Claude Code processes running in this unit's worktree right now, newest first. */
  liveSessions?: LiveSession[];
  /** The newest of liveSessions. */
  activeSession?: LiveSession | null;
  /** The entire parsed state.yaml, verbatim (for surfacing any field). */
  state: Record<string, unknown> | null;
}

/** A Claude Code process running in a unit's worktree (from ~/.claude/sessions/<pid>.json). */
export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
  procStart: string;
  startedAt: string;
  tmuxPane: string | null;
  name: string | null;
}

export interface SessionDoc {
  sessionId: string;
  unitId: string | null;
  title: string | null;
  cwd: string | null;
  gitBranch: string | null;
  worktreePath: string | null;
  lastActivity: string | null;
  activity: 'active' | 'idle';
  waitingSince: string | null;
  waitingTool: string | null;
  pr: PrRef | null;
  inProject: boolean;
  archived: boolean;
}

/** A reminder record — a per-card custom reminder OR a session pause flag.
 * Mirrors src/lib/db/types.ts; doc id field is always `uid`. */
export interface ReminderDoc {
  uid: string;
  projectId: string;
  kind: 'custom' | 'pause' | 'note';
  unitId?: string;
  dueAt?: string;
  note?: string;
  lastFiredAt?: string | null;
  cleared?: boolean;
  sessionId?: string;
  pausedAt?: string;
  // kind: 'note' — standalone Notes-page entry.
  section?: 'generic' | 'slack' | 'linear';
  workType?: 'personal' | 'professional';
  text?: string;
  sourceDate?: string;
  sourceUrl?: string;
  done?: boolean; // note marked completed → archived (hidden, daemon skips)
  createdAt: string;
}

/** Client-SDK config for the browser (cloud mode). projectId is shared with
 * the daemon; authDomain/storageBucket derive from it unless overridden. */
export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId?: string;
  storageBucket?: string;
  messagingSenderId?: string;
}

export interface BoardConfig {
  projectId: string;
  projectPath: string;
  /** The data dir this board is reading (for diagnostics when no project is found). */
  dataDir: string;
  /** Which backend the daemon is writing to — drives how useBoard reads.
   * Resolved identically on the daemon side (see src/lib/config.ts). */
  dbProvider: 'pocketbase' | 'firestore';
  firestoreMode: 'emulator' | 'cloud';
  gcpProjectId: string;
  firebase: FirebaseWebConfig | null;
  /** PocketBase REST/realtime base URL (pocketbase provider only). */
  pocketbaseUrl: string;
}

// ── Briefing (docs/briefing.md, "Data") ─────────────────────────────────────
// Mirrors src/lib/db/types.ts. The master writes these through `ks-flow
// briefing`; the board alone changes due times and archives.

export type BriefingKind = 'ask' | 'promise' | 'fyi';
export type BriefingStage = 'calm' | 'warm' | 'hot' | 'overdue';
export type DueRule = 'message' | 'promise' | 'dm' | 'mention' | 'fyi' | 'manual';
export type Resolution = 'done' | 'not-mine' | 'wont-do';

/** Where the item came from in Slack. */
export interface SlackRef {
  channel: string;
  channelName: string | null;
  ts: string;
  threadTs: string | null;
  messageUrl: string;
  threadUrl: string | null;
  from: { id: string; name: string };
  text: string;
  sentAt: string;
}

export interface DueChange {
  at: string;
  from: string | null;
  to: string;
  by: 'master' | 'you';
  reason?: string;
}

export interface BriefingItemDoc {
  uid: string;
  key: string;
  groupKey: string;
  kind: BriefingKind;
  title: string;
  why: string;
  source: SlackRef;
  receivedAt: string;
  clockStart: string;
  dueAt: string;
  dueRule: DueRule;
  dueSetByYou: boolean;
  dueHistory: DueChange[];
  pushedCount: number;
  fyiCap: boolean;
  quick: boolean;
  unit: string | null;
  links: { label: string; url: string }[];
  evidence: { at: string; text: string; url?: string }[];
  linkedTo: string | null;
  status: 'open' | 'archived';
  archivedAt: string | null;
  resolution: Resolution | null;
  archiveNote: string | null;
  // No `notified`: the daemon keeps the notices it sent in <dataDir>/master/notices.json.
  createdBy: 'master' | 'you';
  runId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BriefingRunDoc {
  uid: string;
  trigger: 'schedule' | 'button' | 'log-in' | 'log-off' | 'manual';
  slot: string | null;
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'ok' | 'failed';
  slackCursor: string | null;
  added: number;
  updated: number;
  summary: string | null;
  error: string | null;
}

export interface DailyLogDoc {
  uid: string;
  date: string;
  logInAt: string | null;
  logOffAt: string | null;
  logIn: Record<string, unknown> | null;
  logOff: Record<string, unknown> | null;
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

/** `master_events` (src/lib/db/types.ts MasterEventDoc): the daemon starting or
 * hard-restarting the master, or a request written / dropped for it. */
export interface MasterEventDoc {
  uid: string;
  at: string;
  kind: 'start' | 'restart' | 'request';
  trigger?: 'schedule' | 'button' | 'restart';
  slot?: string | null;
  reason: string;
  by: 'daemon' | 'board';
  /** Absent while a start/restart command still runs. */
  result?: 'ok' | 'failed' | 'dropped';
  detail?: string;
}

/** `<dataDir>/master/session.json` (written by claude-ks-master + its mod). */
export interface MasterSessionFile {
  v: 1;
  sessionId: string;
  pid: number | null;
  tmuxPane: string | null;
  cwd: string;
  startedAt: string;
  handoff: string | null;
}

/** `<dataDir>/master/heartbeat.json` (the master mod, every 30 s). */
export interface MasterHeartbeatFile {
  sessionId: string;
  at: string;
  busy: boolean;
}

/** GET /api/briefing/master. */
export interface MasterStatus {
  /** none: no session.json · starting: no pid and no process yet, session.json
   * under 3 min old · down: its process is gone · stale: alive but no heartbeat
   * (of this session) for 2 min · busy: a turn is running · live: idle and well.
   * Alive = the daemon's test: a `claude` process by pid, or by session id. */
  state: 'none' | 'starting' | 'down' | 'stale' | 'busy' | 'live';
  session: MasterSessionFile | null;
  heartbeat: MasterHeartbeatFile | null;
  alive: boolean;
  heartbeatAgeMs: number | null;
  /** Remote Control session id (from ~/.claude/sessions/<pid>.json) → claude.ai/code/<id>. */
  bridgeSessionId: string | null;
  /** Requests waiting in master/requests (file names). */
  pending: string[];
  /** board-settings.json `briefing`: whether scheduled passes run, and when. */
  briefing: { enabled: boolean; schedule: string[] };
}
