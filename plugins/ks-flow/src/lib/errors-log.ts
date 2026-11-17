// lib/errors-log.ts — this device's ks-flow problems, for the board's Errors
// page (/errors), its toolbar icon and `ks-setup doctor`.
//
// <dataDir>/errors.json, written only by the daemon. One entry per problem key
// (`listener:reminders`, `job:linear`): opened on the first failure, counted on
// each one after it, resolved when the thing works again. Resolved entries are
// kept 7 days, then dropped. Local to this Mac on purpose: the store may be the
// very thing that is failing.
//
// The board reads the same file (web/lib/errorsFile.ts keeps the shape).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ERRORS_FILE = 'errors.json';
const KEEP_RESOLVED_MS = 7 * 86_400_000;

export interface ErrorEntry {
  /** `listener:<name>` or `job:<name>`. */
  key: string;
  /** What failed, for people ("Reminders listener", "Linear refresh"). */
  title: string;
  /** The last error message. */
  message: string;
  firstAt: string;
  lastAt: string;
  /** Failures since it opened. */
  count: number;
  /** When it worked again; null while open. */
  resolvedAt: string | null;
  /** While open: when the daemon tries again on its own (ISO), if it does. */
  retryAt?: string | null;
}

export interface ErrorsFile {
  updatedAt: string;
  entries: ErrorEntry[];
}

export function readErrors(dataDir: string): ErrorsFile {
  try {
    const j = JSON.parse(readFileSync(join(dataDir, ERRORS_FILE), 'utf8')) as Partial<ErrorsFile>;
    const entries = Array.isArray(j.entries)
      ? j.entries.filter((e): e is ErrorEntry => !!e && typeof e.key === 'string' && typeof e.firstAt === 'string')
      : [];
    return { updatedAt: typeof j.updatedAt === 'string' ? j.updatedAt : '', entries };
  } catch {
    return { updatedAt: '', entries: [] };
  }
}

function save(dataDir: string, file: ErrorsFile, now: Date): void {
  const cutoff = now.getTime() - KEEP_RESOLVED_MS;
  const entries = file.entries.filter((e) => !e.resolvedAt || Date.parse(e.resolvedAt) >= cutoff);
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, ERRORS_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ updatedAt: now.toISOString(), entries }, null, 2) + '\n');
  renameSync(tmp, path);
}

export interface Failure {
  key: string;
  title: string;
  message: string;
  retryAt?: string | null;
}

/** Record a failure. `opened`: no open entry had this key (a new problem: notify). */
export function recordError(dataDir: string, f: Failure, now = new Date()): { opened: boolean; entry: ErrorEntry } {
  const file = readErrors(dataDir);
  const at = now.toISOString();
  let entry = file.entries.find((e) => e.key === f.key && !e.resolvedAt);
  const opened = !entry;
  if (entry) {
    entry.title = f.title;
    entry.message = f.message;
    entry.lastAt = at;
    entry.count++;
    entry.retryAt = f.retryAt ?? null;
  } else {
    entry = { key: f.key, title: f.title, message: f.message, firstAt: at, lastAt: at, count: 1, resolvedAt: null, retryAt: f.retryAt ?? null };
    file.entries.unshift(entry);
  }
  save(dataDir, file, now);
  return { opened, entry };
}

/** Mark `key` resolved. Returns the entry that was open, or null (nothing to resolve). */
export function resolveError(dataDir: string, key: string, now = new Date()): ErrorEntry | null {
  const file = readErrors(dataDir);
  const entry = file.entries.find((e) => e.key === key && !e.resolvedAt);
  if (!entry) return null;
  entry.resolvedAt = now.toISOString();
  entry.retryAt = null;
  save(dataDir, file, now);
  return entry;
}

/** Keys still open (the daemon resolves its own leftovers on start once each works). */
export function openErrors(dataDir: string): ErrorEntry[] {
  return readErrors(dataDir).entries.filter((e) => !e.resolvedAt);
}
