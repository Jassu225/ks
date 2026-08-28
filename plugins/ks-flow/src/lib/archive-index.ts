// lib/archive-index.ts — local bookkeeping for the transcript backup sweep.
//
// Which session file was last uploaded, at what size/mtime, and under which
// object name. Lives in $KS_FLOW_DATA next to checkpoints.json for the same
// reason: it is per-file churn about LOCAL files, so it must not cost DB writes
// and does not belong in the cloud store. The board reads it through
// /api/archive-status rather than listing the bucket per card.
//
// The index is a CACHE, never the source of truth: a missing or stale entry
// only costs a redundant upload, and `--force` ignores it entirely.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from './config.js';

export const ARCHIVE_INDEX_PATH = join(dataDir(), 'archive-index.json');

/** One uploaded session JSONL. `rel` (the map key) is relative to the
 * transcript dir, so `subagents/<id>.jsonl` stays distinct from `<id>.jsonl`. */
export interface ArchivedSession {
  size: number;
  mtimeMs: number;
  object: string; // gs:// URI, for the UI and for restore
  uploadedAt: string;
}

export interface UnitArchive {
  identifier: string;
  worktreePath: string;
  transcriptDir: string;
  sessions: Record<string, ArchivedSession>;
  /** Refreshed whenever this unit had a session upload — the two always travel
   * together, so a restore gets the workflow state that matches the transcript. */
  workflow: { object: string; size: number; uploadedAt: string } | null;
  lastArchivedAt: string;
}

export interface ArchiveIndex {
  version: 1;
  lastSweepAt: string | null;
  units: Record<string, UnitArchive>; // keyed by identifier
}

const EMPTY: ArchiveIndex = { version: 1, lastSweepAt: null, units: {} };

export function readArchiveIndex(): ArchiveIndex {
  try {
    const parsed = JSON.parse(readFileSync(ARCHIVE_INDEX_PATH, 'utf8')) as ArchiveIndex;
    if (parsed?.version !== 1 || typeof parsed.units !== 'object' || parsed.units === null) {
      return { ...EMPTY };
    }
    return { version: 1, lastSweepAt: parsed.lastSweepAt ?? null, units: parsed.units };
  } catch {
    return { ...EMPTY };
  }
}

/** Atomic write (tmp + rename) — a crash mid-write can't corrupt the index. */
export function writeArchiveIndex(index: ArchiveIndex): void {
  mkdirSync(dirname(ARCHIVE_INDEX_PATH), { recursive: true });
  const tmp = `${ARCHIVE_INDEX_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf8');
  renameSync(tmp, ARCHIVE_INDEX_PATH);
}

/** True when the local file differs from what the index says was uploaded.
 * Size OR mtime is enough: an append changes both, and a rewrite that somehow
 * preserved size would still move mtime. */
export function needsUpload(prev: ArchivedSession | undefined, size: number, mtimeMs: number): boolean {
  if (!prev) return true;
  return prev.size !== size || Math.floor(prev.mtimeMs) !== Math.floor(mtimeMs);
}
