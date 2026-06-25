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

export interface ProjectDoc {
  projectId: string;
  projectPath: string;
  commonDir: string;
  workflowType: 'ticket' | 'project' | 'mixed';
  phaseModel: PhaseRef[];
  worktreePaths: string[];
  updatedAt: string;
}

export interface WorkUnitDoc {
  unitId: string;
  type: 'ticket' | 'project';
  identifier: string;
  title: string;
  linearStatus: string | null;
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
  /** The entire parsed state.yaml, verbatim (for surfacing any field). */
  state: Record<string, unknown> | null;
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
