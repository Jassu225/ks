// lib/backupStreams.ts — stream keys for the backup actions, in one place so the
// button that starts a stream and every <SeeLogs> that reopens it agree.

/** The whole project's backup (the board's header button). */
export const BACKUP_ALL = 'backup:all';

/** One card's backup. */
export function backupKey(unitId: string): string {
  return `backup:${unitId}`;
}

/** One card's restore. */
export function restoreKey(unitId: string): string {
  return `restore:${unitId}`;
}

/** The key a backup stream also answers to once its run is recorded: a /backups row's. */
export function backupRunKey(runUid: string): string {
  return `backup-run:${runUid}`;
}

/** The run id the backup CLI prints as it starts (`[ks-flow backup] run <uid> started`), as stream aliases. */
export function backupRunAliases(output: string): string[] {
  return [...output.matchAll(/\[ks-flow backup\] run (\S+) started/g)].map((m) => backupRunKey(m[1] ?? ''));
}
