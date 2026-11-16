'use client';
// useActivity — the live parts of the Activity Log that the Briefing hook does
// not already hold: `master_events` (newest EVENTS) and a change signal for
// `backup_runs`. Backup runs themselves still come from GET /api/backup-runs,
// since a run's running / interrupted status needs its process checked on the
// server (src/lib/backup-runs.ts); `backupRunsVersion` goes up on every change
// to the collection so the page re-fetches at once instead of waiting to poll.
// Same two backends as useBriefing: PocketBase (REST load + SSE) or Firestore
// (the board server's live stream, app/api/store/live). Mounted once, by BoardDataProvider: one subscription per
// collection (PocketBase's unsubscribe() drops every listener on it).
import { useCallback, useEffect, useRef, useState } from 'react';
import { openLive } from './liveStore';
import { getPb } from './pocketbase';
import type { BoardConfig, MasterEventDoc } from './types';

const EVENTS = 200;

export interface ActivityData {
  masterEvents: MasterEventDoc[];
  /** Bumped on each change to backup_runs. */
  backupRunsVersion: number;
  loaded: boolean;
  refresh: () => Promise<void>;
}

const byAtDesc = (a: MasterEventDoc, b: MasterEventDoc): number => (b.at ?? '').localeCompare(a.at ?? '');

export function useActivity(cfg: BoardConfig): ActivityData {
  const [masterEvents, setMasterEvents] = useState<MasterEventDoc[]>([]);
  const [backupRunsVersion, setVersion] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const reloadRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    if (!cfg.projectId) return;
    const bump = (): void => setVersion((v) => v + 1);
    const emit = (docs: MasterEventDoc[]): void => {
      setMasterEvents(docs.filter(Boolean).sort(byAtDesc));
      setLoaded(true);
    };
    return cfg.dbProvider === 'pocketbase'
      ? subscribePocketbase(cfg, emit, bump, (fn) => (reloadRef.current = fn))
      : subscribeFirestore(emit, bump, (fn) => (reloadRef.current = fn));
  }, [cfg]);

  const refresh = useCallback(() => reloadRef.current(), []);
  return { masterEvents, backupRunsVersion, loaded, refresh };
}

function subscribePocketbase(
  cfg: BoardConfig,
  emit: (docs: MasterEventDoc[]) => void,
  bump: () => void,
  register: (fn: () => Promise<void>) => void,
): () => void {
  const pb = getPb(cfg);
  const k = cfg.projectId;
  let cancelled = false;
  const load = async (): Promise<void> => {
    const docs = await pb
      .collection('master_events')
      .getList(1, EVENTS, { filter: pb.filter('projectKey={:k}', { k }), sort: '-at' })
      .then((res) => res.items.map((r) => r.data as MasterEventDoc))
      .catch(() => [] as MasterEventDoc[]); // collection missing until the migration runs
    if (!cancelled) emit(docs);
  };
  register(load);
  void load();
  const filter = pb.filter('projectKey={:k}', { k });
  pb.collection('master_events')
    .subscribe('*', () => void load(), { filter })
    .catch(() => {});
  pb.collection('backup_runs')
    .subscribe('*', () => bump(), { filter })
    .catch(() => {});
  return () => {
    cancelled = true;
    for (const col of ['master_events', 'backup_runs']) pb.collection(col).unsubscribe().catch(() => {});
  };
}

/** Firestore: the board server's live stream (app/api/store/live). */
function subscribeFirestore(
  emit: (docs: MasterEventDoc[]) => void,
  bump: () => void,
  register: (fn: () => Promise<void>) => void,
): () => void {
  const live = openLive('activity', {
    onSnap: (key, docs) => {
      if (key === 'masterEvents') emit(docs as MasterEventDoc[]);
      else if (key === 'backupRuns') bump();
    },
  });
  register(live.reload);
  return live.close;
}
