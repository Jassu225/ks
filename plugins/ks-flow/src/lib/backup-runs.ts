// lib/backup-runs.ts — history of backup sweeps, for the board's Backups page.
//
// Every real sweep (daily, a board button, a removal, by hand) is one doc in the
// store (PocketBase `backup_runs`, or Firestore projects/{id}/backupRuns),
// written as it starts and rewritten whole as it ends. A run whose end never
// arrived shows up anyway — "running" while its process lives, "interrupted"
// after — instead of vanishing. Status, reindex and dry runs upload nothing and
// are not recorded.
import type { BackupRunDoc, BackupStore } from './db/types.js';

export type { BackupRunDoc, BackupTrigger, RunUnit, RunUpload } from './db/types.js';

/** A run as the board shows it. */
export interface BackupRun extends BackupRunDoc {
  status: 'running' | 'interrupted' | 'ok' | 'partial' | 'failed';
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists, it just isn't ours to signal.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A run's status: its outcome once it ended; before that, whether its process still lives. */
export function runStatus(doc: BackupRunDoc, alive: (pid: number) => boolean = isAlive): BackupRun['status'] {
  if (doc.outcome) return doc.outcome;
  return alive(doc.pid) ? 'running' : 'interrupted';
}

/** Every recorded run, newest first. */
export async function listRuns(
  store: BackupStore,
  projectId: string,
  alive: (pid: number) => boolean = isAlive,
): Promise<BackupRun[]> {
  const docs = await store.getBackupRuns(projectId);
  return docs
    .map((doc) => ({ ...doc, status: runStatus(doc, alive) }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** A sweep still going (its process alive, no end yet), if any: only one runs at a time. */
export function activeRun(runs: BackupRun[]): BackupRun | null {
  return runs.find((r) => r.status === 'running') ?? null;
}

/** A sweep of the whole project (not one card's, a removal or the completed units). */
export function isFullSweep(run: BackupRunDoc): boolean {
  return run.trigger === 'daily' || run.trigger === 'manual';
}

/**
 * When the last sweep finished, whatever started it: what `lastSweepAt` in the
 * old archive-index.json recorded. The board's "last sweep" reads it.
 */
export function lastSweepAt(runs: BackupRunDoc[]): string | null {
  let latest: string | null = null;
  for (const r of runs) if (r.endedAt && (!latest || r.endedAt > latest)) latest = r.endedAt;
  return latest;
}
