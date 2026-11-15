// lib/storeCache.ts — SERVER-only: the last Firestore snapshot per live scope,
// on disk at <dataDir>/cache/<scope>.json, so a board opened offline (and the
// serverdb reads that fall back while offline) still have the last known state.
// Written by app/api/store/live while a board is open: at most every 5 min while
// changes arrive, and once more when the board closes. Nothing updates it while
// no board is open.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ScopeCache {
  savedAt: string;
  snaps: Record<string, unknown[]>;
}

const cacheFile = (dataDir: string, scope: string): string => join(dataDir, 'cache', `${scope}.json`);

export function readScopeCache(dataDir: string, scope: string): ScopeCache | null {
  try {
    return JSON.parse(readFileSync(cacheFile(dataDir, scope), 'utf8')) as ScopeCache;
  } catch {
    return null;
  }
}

export function writeScopeCache(dataDir: string, scope: string, snaps: Record<string, unknown[]>): void {
  try {
    const file = cacheFile(dataDir, scope);
    mkdirSync(join(dataDir, 'cache'), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), snaps }));
    renameSync(tmp, file);
  } catch (e) {
    console.error(`[ks-flow] cache ${scope} not saved: ${(e as Error).message}`);
  }
}
