// lib/backup-runs.ts — history of backup sweeps, for the board's Activity Log (Backup rows).
//
// Every real sweep (daily, a board button, a removal, by hand) is one doc in the
// store (PocketBase `backup_runs`, or Firestore projects/{id}/backupRuns),
// written as it starts and rewritten whole as it ends. A run whose end never
// arrived shows up anyway — "running" while its process lives, "interrupted"
// after — instead of vanishing. Status, reindex and dry runs upload nothing and
// are not recorded.
//
// Several devices share the store, and each backs up only its own worktrees.
// A run carries the device it ran on (`deviceId`): its pid is checked only on
// that device; elsewhere it counts as running while its device's heartbeat
// (devices/{id}.lastSeenAt) is fresh, else "interrupted". "Already running" and
// "swept today" count only this device's runs. A run with no deviceId (before
// the device backfill) counts as this device's.
import type { BackupRunDoc, BackupStore } from './db/types.js';

export type { BackupRunDoc, BackupTrigger, RunUnit, RunUpload } from './db/types.js';

/** A run as the board shows it. */
export interface BackupRun extends BackupRunDoc {
  status: 'running' | 'interrupted' | 'ok' | 'partial' | 'failed';
}

/** A device whose heartbeat (every 60 s) is older than this is asleep or offline. */
export const DEVICE_FRESH_MS = 5 * 60_000;

/** Which device is asking, so runs can be told apart (several devices share the store). */
export interface RunContext {
  /** This device's id. Left out: every run counts as this device's (the one-device behaviour). */
  self?: string;
  /** Whether a pid is alive (this device's runs only). */
  alive?: (pid: number) => boolean;
  /** Other devices' last heartbeats: deviceId → lastSeenAt (ISO). */
  lastSeen?: Map<string, string> | Record<string, string>;
  now?: number;
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

/** Whether a run was made on this device (an untagged run counts as this device's). */
export function isMine(run: Pick<BackupRunDoc, 'deviceId'>, self: string | undefined): boolean {
  return !self || !run.deviceId || run.deviceId === self;
}

function seenAt(ctx: RunContext, deviceId: string): string | undefined {
  const m = ctx.lastSeen;
  if (!m) return undefined;
  return m instanceof Map ? m.get(deviceId) : m[deviceId];
}

/**
 * A run's status: its outcome once it ended. Before that, on this device,
 * whether its process still lives (a pid means nothing on another machine);
 * on another device, running only while that device's heartbeat is fresh.
 */
export function runStatus(doc: BackupRunDoc, ctx: RunContext | ((pid: number) => boolean) = {}): BackupRun['status'] {
  if (doc.outcome) return doc.outcome;
  const c: RunContext = typeof ctx === 'function' ? { alive: ctx } : ctx;
  if (isMine(doc, c.self)) return (c.alive ?? isAlive)(doc.pid) ? 'running' : 'interrupted';
  const seen = Date.parse(seenAt(c, doc.deviceId!) ?? '');
  const fresh = Number.isFinite(seen) && (c.now ?? Date.now()) - seen < DEVICE_FRESH_MS;
  return fresh ? 'running' : 'interrupted';
}

/** Every recorded run (every device's), newest first. */
export async function listRuns(
  store: BackupStore,
  projectId: string,
  ctx: RunContext | ((pid: number) => boolean) = {},
): Promise<BackupRun[]> {
  const docs = await store.getBackupRuns(projectId);
  return docs
    .map((doc) => ({ ...doc, status: runStatus(doc, ctx) }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** This device's sweep still going, if any: one runs at a time per device. */
export function activeRun(runs: BackupRun[], self?: string): BackupRun | null {
  return runs.find((r) => r.status === 'running' && isMine(r, self)) ?? null;
}

/** A sweep of the whole project (not one card's, a removal or the completed units). */
export function isFullSweep(run: BackupRunDoc): boolean {
  return run.trigger === 'daily' || run.trigger === 'manual';
}

/** This device's full sweeps that did their job (ok or partial). */
export function doneSweeps(runs: BackupRun[], self?: string): BackupRun[] {
  return runs.filter((r) => isMine(r, self) && isFullSweep(r) && (r.status === 'ok' || r.status === 'partial'));
}

/** Whether this device's sweep ran on `day` (`dayOf` maps a start to a day); another device's never counts. */
export function sweptOn(runs: BackupRun[], day: string, dayOf: (iso: string) => string, self?: string): boolean {
  return doneSweeps(runs, self).some((r) => dayOf(r.startedAt) === day);
}

/**
 * When the last sweep finished, whatever started it: what `lastSweepAt` in the
 * old archive-index.json recorded. The board's "last sweep" reads it. With
 * `self`, only this device's sweeps count.
 */
export function lastSweepAt(runs: BackupRunDoc[], self?: string): string | null {
  let latest: string | null = null;
  for (const r of runs) if (r.endedAt && isMine(r, self) && (!latest || r.endedAt > latest)) latest = r.endedAt;
  return latest;
}
