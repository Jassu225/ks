// lib/daemonFiles.ts — the files this device's daemon keeps current from its
// store listeners, read by the board's polled routes so no poll reads Firestore
// (src/lib/live-mirror.ts):
//   backup-status.json  each unit's backup status, the newest backup runs, the last sweep (src/lib/backup-status.ts)
//   errors.json         this device's ks-flow problems (src/lib/errors-log.ts)
//   devices.json        every device, with the master status it published (src/lib/device-list.ts)
// The shapes are the daemon's; only the fields the board reads are typed here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boardDataDir } from './boardConfig';

function readJson<T>(name: string): T | null {
  try {
    return JSON.parse(readFileSync(join(boardDataDir(), name), 'utf8')) as T;
  } catch {
    return null;
  }
}

/** The daemon rewrites backup-status.json every minute: older than this, it isn't running (or is on PocketBase). */
const BACKUP_STATUS_FRESH_MS = 5 * 60_000;

export interface BackupStatusFile {
  updatedAt: string;
  ok: boolean;
  error?: string | null;
  disabled?: boolean;
  units: unknown[];
  lastSweepAt: string | null;
  runs: unknown[];
  listedAt: string | null;
}

/** backup-status.json when the daemon keeps it (Firestore) and it is fresh; else null (use the CLI). */
export function readBackupStatusFile(now = Date.now()): BackupStatusFile | null {
  const j = readJson<BackupStatusFile>('backup-status.json');
  if (!j || typeof j.updatedAt !== 'string' || !Array.isArray(j.units) || !Array.isArray(j.runs)) return null;
  const at = Date.parse(j.updatedAt);
  return Number.isFinite(at) && now - at < BACKUP_STATUS_FRESH_MS ? j : null;
}

export interface ErrorEntry {
  key: string;
  title: string;
  message: string;
  firstAt: string;
  lastAt: string;
  count: number;
  resolvedAt: string | null;
  retryAt?: string | null;
}

/** errors.json's entries (open and recently resolved), newest first. */
export function readErrorsFile(): ErrorEntry[] {
  const j = readJson<{ entries?: unknown }>('errors.json');
  if (!j || !Array.isArray(j.entries)) return [];
  return (j.entries as ErrorEntry[])
    .filter((e) => !!e && typeof e.key === 'string' && typeof e.firstAt === 'string')
    .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
}

export interface CachedDevice {
  deviceId: string;
  name: string;
  lastSeenAt: string | null;
  masterStatus?: Record<string, unknown> | null;
}

/** One device from devices.json (written on every change of the devices listener), or null. */
export function cachedDevice(deviceId: string): CachedDevice | null {
  const j = readJson<{ devices?: CachedDevice[] }>('devices.json');
  return (Array.isArray(j?.devices) ? j!.devices : []).find((d) => d?.deviceId === deviceId) ?? null;
}
