// lib/rotate.ts — daily rotation + N-file retention for the daemon's logs
// (events.jsonl, daemon.log). An active file `events.jsonl` rolls to
// `events.<YYYY-MM-DD>.jsonl`; only the newest N rolled files are kept.
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Local calendar day (YYYY-MM-DD) for a Date (default: now). */
export function dayStr(d: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The calendar day an existing file belongs to (by mtime), or null if absent. */
export function fileDay(path: string): string | null {
  try {
    return dayStr(statSync(path).mtime);
  } catch {
    return null;
  }
}

// Split `events.jsonl` → { stem: 'events', ext: '.jsonl' } on the FIRST dot, so
// the rolled name is `events.<day>.jsonl` (not `events.<day>jsonl`).
function split(activePath: string): { dir: string; stem: string; ext: string } {
  const dir = dirname(activePath);
  const b = basename(activePath);
  const dot = b.indexOf('.');
  return dot === -1
    ? { dir, stem: b, ext: '' }
    : { dir, stem: b.slice(0, dot), ext: b.slice(dot) };
}

/** Rolled-file path for an active file on a given day: events.jsonl → events.<day>.jsonl. */
export function rotatedName(activePath: string, day: string): string {
  const { dir, stem, ext } = split(activePath);
  return join(dir, `${stem}.${day}${ext}`);
}

/**
 * Roll the active file out to its dated name. If a file for that day already
 * exists (e.g. the daemon was down across several days, or a same-day re-roll),
 * append into it rather than clobber. Returns the rolled path, or null if the
 * active file was absent/empty (nothing to roll).
 */
export function rotateFile(activePath: string, day: string): string | null {
  if (!existsSync(activePath)) return null;
  try {
    if (statSync(activePath).size === 0) return null;
  } catch {
    return null;
  }
  const target = rotatedName(activePath, day);
  if (existsSync(target)) {
    appendFileSync(target, readFileSync(activePath));
    unlinkSync(activePath);
  } else {
    renameSync(activePath, target);
  }
  return target;
}

/** Keep only the newest `keep` dated rolls of an active file; delete the rest. */
export function pruneRotations(activePath: string, keep = 30): void {
  const { dir, stem, ext } = split(activePath);
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${esc(stem)}\\.(\\d{4}-\\d{2}-\\d{2})${esc(ext)}$`);
  const dated: { name: string; day: string }[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const m = re.exec(name);
    if (m) dated.push({ name, day: m[1] });
  }
  dated.sort((a, b) => b.day.localeCompare(a.day)); // newest first
  for (const f of dated.slice(keep)) {
    try {
      unlinkSync(join(dir, f.name));
    } catch {
      /* best-effort */
    }
  }
}
