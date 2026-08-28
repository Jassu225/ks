'use client';
// lib/backupStatus.tsx — transcript backup status, fetched once for the board.
//
// Every card wants to know two things: has this unit been backed up, and does
// the cloud hold sessions that local no longer does (i.e. is Restore worth
// offering). Both come from ONE GET /api/transcript-backup — a local JSON read
// on the server — so this is a single poll shared through context rather than a
// fetch per card, and rather than prop-drilling through Column.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export interface UnitBackupStatus {
  identifier: string;
  transcriptDir: string;
  worktreePath: string;
  worktreeExists: boolean;
  localSessions: number;
  cloudSessions: number;
  /** In the bucket, gone from disk — restorable. Set-based, not a count diff. */
  missingCount: number;
  missingLocally: boolean;
  /** On disk, not yet in the bucket (new, or grown since its last upload). */
  pendingCount: number;
  /** Only a pre-migration transcript.tar.zst exists — restore reads it, but the
   * unit has no per-file objects yet. */
  legacyOnly: boolean;
  lastArchivedAt: string | null;
  workflowObject: string | null;
}

interface BackupState {
  byUnit: Map<string, UnitBackupStatus>;
  lastSweepAt: string | null;
  refresh: () => Promise<void>;
}

const Ctx = createContext<BackupState>({
  byUnit: new Map(),
  lastSweepAt: null,
  refresh: async () => {},
});

const POLL_MS = 60_000;

export function BackupStatusProvider({ children }: { children: React.ReactNode }) {
  const [byUnit, setByUnit] = useState<Map<string, UnitBackupStatus>>(new Map());
  const [lastSweepAt, setLastSweepAt] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const r = await fetch('/api/transcript-backup');
      const j = (await r.json()) as { units?: UnitBackupStatus[]; lastSweepAt?: string | null };
      setByUnit(new Map((j.units ?? []).map((u) => [u.identifier, u])));
      setLastSweepAt(j.lastSweepAt ?? null);
    } catch {
      // board keeps working without backup status
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const value = useMemo(() => ({ byUnit, lastSweepAt, refresh }), [byUnit, lastSweepAt, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBackupStatus(unitId?: string): {
  status: UnitBackupStatus | undefined;
  lastSweepAt: string | null;
  refresh: () => Promise<void>;
} {
  const { byUnit, lastSweepAt, refresh } = useContext(Ctx);
  return { status: unitId ? byUnit.get(unitId) : undefined, lastSweepAt, refresh };
}
