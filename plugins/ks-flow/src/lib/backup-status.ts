// lib/backup-status.ts — <dataDir>/backup-status.json: the backup status the
// board shows (each card's backup chip and Restore, the toolbar's last sweep,
// the Activity Log's Backup rows), written by the daemon every minute from its
// listeners (backupRuns, backupUnits, devices) and its cached bucket listing.
//
// The board used to run `transcript-backup --status` on every poll (each tab,
// every minute): two whole reads of backupRuns, one of backupUnits and a full
// bucket listing each time. Now the board only reads this file; the bucket is
// listed again only when the index or a run changed (a backup on any device).
//
// The board reads the same file (web/lib/backupStatusFile.ts keeps the shape).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BackupRun } from './backup-runs.js';
import type { UnitStatus } from './transcript-archive.js';

export const BACKUP_STATUS_FILE = 'backup-status.json';

export interface BackupStatusFile {
  updatedAt: string;
  /** False when the units could not be computed (`error` says why); the runs are still there. */
  ok: boolean;
  error?: string | null;
  /** The GCS archive is off in Settings: no units. */
  disabled?: boolean;
  units: UnitStatus[];
  /** This device's last finished sweep. */
  lastSweepAt: string | null;
  /** The newest runs (every device's), newest first, each with its status. */
  runs: BackupRun[];
  /** When the bucket was last listed. */
  listedAt: string | null;
}

export function writeBackupStatus(dataDir: string, status: BackupStatusFile): void {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, BACKUP_STATUS_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(status) + '\n');
  renameSync(tmp, path);
}

export function readBackupStatus(dataDir: string): BackupStatusFile | null {
  try {
    const j = JSON.parse(readFileSync(join(dataDir, BACKUP_STATUS_FILE), 'utf8')) as BackupStatusFile;
    return typeof j.updatedAt === 'string' && Array.isArray(j.units) && Array.isArray(j.runs) ? j : null;
  } catch {
    return null;
  }
}
