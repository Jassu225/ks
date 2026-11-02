// lib/activity.ts — the Activity Log's rows: every background run ks-flow and
// the master session record, merged newest first, each with its type.
//
//   backup            backup_runs (GET /api/backup-runs: status checked server-side)
//   briefing          briefing_runs, trigger schedule / button / manual
//   log-in / log-off  briefing_runs with those triggers
//   master            master_events: the daemon starting / restarting the
//                     master, requests written or dropped for it
import type { BriefingRunDoc, MasterEventDoc } from './types';

export interface RunUpload {
  path: string;
  kind: 'session' | 'workflow' | 'time-log';
  /** Uncompressed bytes. */
  size: number;
  /** Bytes uploaded (zstd); absent on runs recorded before it was kept. */
  compressedSize?: number;
}

export interface RunUnit {
  identifier: string;
  uploads: RunUpload[];
  errors: string[];
}

/** A backup sweep as /api/backup-runs returns it (src/lib/backup-runs.ts BackupRun). */
export interface BackupRun {
  uid: string;
  startedAt: string;
  endedAt?: string;
  trigger: 'daily' | 'manual' | 'unit' | 'removal' | 'completed';
  scope: string;
  status: 'running' | 'interrupted' | 'ok' | 'partial' | 'failed';
  error?: string;
  unitsChecked?: number;
  unitsCurrent?: number;
  uploadedCount?: number;
  errorCount?: number;
  bytesSource?: number;
  bytesUploaded?: number;
  units?: RunUnit[];
}

export type ActivityType = 'backup' | 'briefing' | 'log-in' | 'log-off' | 'master';

export type ActivityRow =
  | { type: 'backup'; key: string; at: string; run: BackupRun }
  | { type: 'briefing' | 'log-in' | 'log-off'; key: string; at: string; run: BriefingRunDoc }
  | { type: 'master'; key: string; at: string; event: MasterEventDoc };

export type BriefingRow = Extract<ActivityRow, { type: 'briefing' | 'log-in' | 'log-off' }>;

export type ActivityFilter ='all' | 'backup' | 'briefing' | 'log' | 'master';

export const FILTERS: { id: ActivityFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'backup', label: 'Backup' },
  { id: 'briefing', label: 'Briefing' },
  { id: 'log', label: 'Log-in/off' },
  { id: 'master', label: 'Master' },
];

export function isFilter(v: string | null | undefined): v is ActivityFilter {
  return FILTERS.some((f) => f.id === v);
}

export function briefingType(run: Pick<BriefingRunDoc, 'trigger'>): 'briefing' | 'log-in' | 'log-off' {
  return run.trigger === 'log-in' ? 'log-in' : run.trigger === 'log-off' ? 'log-off' : 'briefing';
}

/** Every row, newest first (ties keep a stable order by key). */
export function activityRows(
  backups: BackupRun[],
  briefingRuns: BriefingRunDoc[],
  masterEvents: MasterEventDoc[],
): ActivityRow[] {
  const rows: ActivityRow[] = [
    ...backups.map((run): ActivityRow => ({ type: 'backup', key: `backup:${run.uid}`, at: run.startedAt, run })),
    ...briefingRuns.map((run): ActivityRow => ({ type: briefingType(run), key: `briefing:${run.uid}`, at: run.startedAt, run })),
    ...masterEvents.map((event): ActivityRow => ({ type: 'master', key: `master:${event.uid}`, at: event.at, event })),
  ];
  return rows.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '') || a.key.localeCompare(b.key));
}

export function matches(row: ActivityRow, f: ActivityFilter): boolean {
  switch (f) {
    case 'all':
      return true;
    case 'log':
      return row.type === 'log-in' || row.type === 'log-off';
    default:
      return row.type === f;
  }
}

/** What started a briefing run: "Scheduled 06:00", "Brief me", "Manual", "Log-in", "Log-off". */
export function briefingTriggerLabel(run: Pick<BriefingRunDoc, 'trigger' | 'slot'>): string {
  switch (run.trigger) {
    case 'schedule':
      return run.slot ? `Scheduled ${run.slot}` : 'Scheduled';
    case 'button':
      return 'Brief me';
    case 'log-in':
      return 'Log-in';
    case 'log-off':
      return 'Log-off';
    default:
      return 'Manual';
  }
}

/** What a master event was: "Start", "Hard restart", "Request · Scheduled 06:00", "Request · Brief me", "Request · Restart". */
export function masterEventLabel(e: Pick<MasterEventDoc, 'kind' | 'trigger' | 'slot'>): string {
  if (e.kind === 'start') return 'Start';
  if (e.kind === 'restart') return 'Hard restart';
  const what =
    e.trigger === 'schedule' ? (e.slot ? `Scheduled ${e.slot}` : 'Scheduled') : e.trigger === 'button' ? 'Brief me' : 'Restart';
  return `Request · ${what}`;
}

/** A briefing run with no end this long after it started is shown as unfinished, not running. */
export const BRIEFING_STALE_MS = 2 * 3_600_000;
/** A start/restart with no result this long after it ran: the daemon never saw it exit. */
export const LAUNCH_STALE_MS = 15 * 60_000;

export type RowStatus = 'ok' | 'partial' | 'failed' | 'running' | 'interrupted' | 'dropped' | 'unknown';

export function rowStatus(row: ActivityRow, now: number): RowStatus {
  if (row.type === 'backup') return row.run.status;
  if (row.type === 'master') {
    const e = row.event;
    if (e.result) return e.result;
    return now - Date.parse(e.at) < LAUNCH_STALE_MS ? 'running' : 'unknown';
  }
  const r = row.run;
  if (r.status !== 'running') return r.status;
  return now - Date.parse(r.startedAt) < BRIEFING_STALE_MS ? 'running' : 'interrupted';
}
