// lib/archive-index.ts — what the transcript backup has uploaded, per unit.
//
// Which session file was last uploaded, at what size/mtime, and under which
// object name. Lives in the store (PocketBase `backup_units`, or Firestore
// projects/{id}/backupUnits), one doc per unit, keyed by its object-name-safe
// identifier. The backup CLI is its only reader and writer; the board sees it
// through `transcript-backup --status`.
//
// The index is a CACHE, never the source of truth: a missing or stale entry
// only costs a redundant upload, each sweep reconciles it against a bucket
// listing, `--reindex` rebuilds it from the bucket, and `--force` ignores it.
//
// It used to be a file, $KS_FLOW_DATA/archive-index.json. The first load
// imports that file into the store and renames it `.imported`, so nothing is
// lost and nothing is imported twice.
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config.js';
import type { ArchivedSession, BackupStore, BackupUnitDoc } from './db/types.js';

export type { ArchivedSession } from './db/types.js';

/** A unit's entry: its store doc without the doc id (that is derived from the identifier). */
export type UnitArchive = Omit<BackupUnitDoc, 'uid'>;

/** Every unit's entry, keyed by identifier: what one sweep reads and updates. */
export interface ArchiveIndex {
  units: Record<string, UnitArchive>;
}

/** The pre-store index file, imported once. */
export const LEGACY_INDEX_PATH = join(dataDir(), 'archive-index.json');

/** Object-name-safe identifier: the unit's bucket prefix and its doc id. */
export function safeId(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Every unit's entry for `projectId`. Throws when the store cannot be reached:
 * an empty index would make the next sweep re-upload every unit, so callers
 * decide what an unreachable store means for them.
 */
export async function loadArchiveIndex(store: BackupStore, projectId: string): Promise<ArchiveIndex> {
  const units: Record<string, UnitArchive> = {};
  for (const { uid: _uid, ...unit } of await store.getBackupUnits(projectId)) units[unit.identifier] = unit;
  await importLegacyIndex(store, projectId, units);
  return { units };
}

/** Writes one unit's entry. */
export async function saveUnit(store: BackupStore, projectId: string, unit: UnitArchive): Promise<void> {
  await store.upsertBackupUnit(projectId, { uid: safeId(unit.identifier), ...unit });
}

/** One-time move of archive-index.json into the store: units the store lacks are added, then the file is set aside. */
async function importLegacyIndex(store: BackupStore, projectId: string, units: Record<string, UnitArchive>): Promise<void> {
  if (!existsSync(LEGACY_INDEX_PATH)) return;
  let legacy: { units?: Record<string, UnitArchive> } | null = null;
  try {
    legacy = JSON.parse(readFileSync(LEGACY_INDEX_PATH, 'utf8')) as { units?: Record<string, UnitArchive> };
  } catch {
    legacy = null; // unreadable: nothing to import, and nothing worth keeping either
  }
  for (const [identifier, unit] of Object.entries(legacy?.units ?? {})) {
    if (units[identifier] || !unit?.sessions) continue;
    await saveUnit(store, projectId, unit);
    units[identifier] = unit;
  }
  try {
    renameSync(LEGACY_INDEX_PATH, `${LEGACY_INDEX_PATH}.imported`);
  } catch {
    // another sweep imported it at the same moment
  }
}

/** True when the local file differs from what the index says was uploaded.
 * Size OR mtime is enough: an append changes both, and a rewrite that somehow
 * preserved size would still move mtime. */
export function needsUpload(prev: ArchivedSession | undefined, size: number, mtimeMs: number): boolean {
  if (!prev) return true;
  return prev.size !== size || Math.floor(prev.mtimeMs) !== Math.floor(mtimeMs);
}
