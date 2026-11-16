// lib/reminders-fired.ts — which custom / note reminders THIS device already
// notified about, kept in <dataDir>/reminders-fired.json:
//   { "<uid>": { "firedAt": ISO, "dueAt": ISO } }
//
// Reminders notify on every device. The daemon used to write `lastFiredAt`
// into the shared reminder doc after each notice, only to remember "already
// notified today"; with several devices the first one to fire would silence
// all the others, and its whole-doc rewrite could undo an edit made at the
// same moment. So the memory is local, like Briefing's notices.json, and the
// daemon never writes reminder docs.
//
// Rules (unchanged from the doc-based ones):
//   - fire at due; then re-nag at most once per 24 h until cleared, and also on
//     a wake from sleep or a daemon start;
//   - a changed dueAt re-arms the reminder (fires again at the new due), as
//     the board's `lastFiredAt = null` on a due change did;
//   - a reminder with no entry yet starts from the doc's old `lastFiredAt`
//     (written by daemons before this file existed), so an upgrade does not
//     re-fire everything at once.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const REMINDERS_FIRED_FILE = 'reminders-fired.json';
export const DAY_MS = 86_400_000;

export interface FiredEntry {
  firedAt: string;
  dueAt: string;
}
export type FiredMap = Record<string, FiredEntry>;

/** The fields of a reminder doc this module reads. */
export interface FireableReminder {
  uid: string;
  dueAt?: string | null;
  lastFiredAt?: string | null;
}

export function readFired(dataDir: string): FiredMap {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dataDir, REMINDERS_FIRED_FILE), 'utf8'));
  } catch {
    return {};
  }
  const out: FiredMap = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [uid, e] of Object.entries(raw as Record<string, unknown>)) {
    if (!e || typeof e !== 'object') continue;
    const { firedAt, dueAt } = e as Record<string, unknown>;
    if (typeof firedAt === 'string' && typeof dueAt === 'string') out[uid] = { firedAt, dueAt };
  }
  return out;
}

/** Whole file, via a temp file + rename. */
export function writeFired(dataDir: string, map: FiredMap): void {
  mkdirSync(dataDir, { recursive: true });
  const tmp = join(dataDir, `.${REMINDERS_FIRED_FILE}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`);
  renameSync(tmp, join(dataDir, REMINDERS_FIRED_FILE));
}

/** When this device last notified about `r` for its current due time (ms), or null: not yet. */
export function lastFired(r: FireableReminder, map: FiredMap): number | null {
  const e = map[r.uid];
  if (e) {
    if (e.dueAt !== (r.dueAt ?? '')) return null; // due moved: re-armed
    const t = Date.parse(e.firedAt);
    return Number.isFinite(t) ? t : null;
  }
  // No local memory yet: start from what older daemons wrote into the doc.
  const t = r.lastFiredAt ? Date.parse(r.lastFiredAt) : NaN;
  return Number.isFinite(t) ? t : null;
}

/** Whether `r` (due, not cleared — the caller checks those) should notify now. */
export function shouldFire(
  r: FireableReminder,
  map: FiredMap,
  now: number,
  opts: { wake?: boolean; startup?: boolean } = {},
): boolean {
  if (!r.dueAt) return false;
  const due = Date.parse(r.dueAt);
  if (!Number.isFinite(due) || due > now) return false;
  const last = lastFired(r, map);
  return last == null || !!opts.wake || !!opts.startup || now - last >= DAY_MS;
}

/** The map with `r` recorded as fired at `now`. */
export function recordFired(map: FiredMap, r: FireableReminder, now: number): FiredMap {
  return { ...map, [r.uid]: { firedAt: new Date(now).toISOString(), dueAt: r.dueAt ?? '' } };
}

/** The map without reminders that are gone (deleted, cleared or done): `keep` holds the uids still armed. */
export function pruneFired(map: FiredMap, keep: Set<string>): { map: FiredMap; changed: boolean } {
  const out: FiredMap = {};
  let changed = false;
  for (const [uid, e] of Object.entries(map)) {
    if (keep.has(uid)) out[uid] = e;
    else changed = true;
  }
  return { map: out, changed };
}
