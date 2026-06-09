'use client';
// useBoard — the board's only data dependency. It subscribes to the project
// doc, work-units, and in-project sessions in real time and keeps the board
// components provider-agnostic: they never import a backend. Which backend it
// talks to is decided by cfg.dbProvider (resolved identically on the daemon):
//   - pocketbase (default): REST initial load + SSE realtime, local server.
//   - firestore: client-SDK onSnapshot (cloud or emulator).
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import { useEffect, useRef, useState } from 'react';
import { getDb } from './firebase';
import { getPb } from './pocketbase';
import type { BoardConfig, ProjectDoc, SessionDoc, WorkUnitDoc } from './types';

export interface BoardData {
  project: ProjectDoc | null;
  workUnits: WorkUnitDoc[];
  sessions: SessionDoc[];
  connected: boolean;
  /** Re-pull everything from the store. Reusable by any UI action (e.g. after
   * removing a worktree) and by the header's manual refresh button. The live
   * subscription still pushes on its own; this is an explicit on-demand pull. */
  refresh: () => Promise<void>;
}

export function useBoard(cfg: BoardConfig): BoardData {
  const [project, setProject] = useState<ProjectDoc | null>(null);
  const [workUnits, setWorkUnits] = useState<WorkUnitDoc[]>([]);
  const [sessions, setSessions] = useState<SessionDoc[]>([]);
  const [connected, setConnected] = useState(false);
  // Populated by whichever backend subscribes; the returned refresh() proxies
  // to it so callers get a stable function identity.
  const reloadRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    const setters = { setProject, setWorkUnits, setSessions, setConnected };
    const register = (fn: () => Promise<void>): void => {
      reloadRef.current = fn;
    };
    if (cfg.dbProvider === 'pocketbase') {
      return subscribePocketbase(cfg, setters, register);
    }
    return subscribeFirestore(cfg, setters, register);
  }, [cfg]);

  return {
    project,
    workUnits,
    sessions,
    connected,
    refresh: () => reloadRef.current(),
  };
}

interface Setters {
  setProject: (p: ProjectDoc | null) => void;
  setWorkUnits: (u: WorkUnitDoc[]) => void;
  setSessions: (s: SessionDoc[]) => void;
  setConnected: (c: boolean) => void;
}

type RegisterReload = (fn: () => Promise<void>) => void;

/** PocketBase: one REST load up front, then re-load on any matching SSE event.
 * The dataset is small, so re-fetching the full list on change is simpler and
 * flicker-free compared with merging per-record deltas. */
function subscribePocketbase(cfg: BoardConfig, s: Setters, register: RegisterReload): () => void {
  const pb = getPb(cfg);
  const pid = cfg.projectId;
  let cancelled = false;

  const reload = async (): Promise<void> => {
    try {
      const [proj, wus, sess] = await Promise.all([
        pb
          .collection('projects')
          .getFirstListItem(pb.filter('key={:k}', { k: pid }))
          .then((r) => r.data as ProjectDoc)
          .catch(() => null),
        pb
          .collection('work_units')
          .getFullList({ filter: pb.filter('projectKey={:k}', { k: pid }) })
          .then((rs) => rs.map((r) => r.data as WorkUnitDoc)),
        pb
          .collection('sessions')
          .getFullList({ filter: pb.filter('projectKey={:k} && inProject=true', { k: pid }) })
          .then((rs) => rs.map((r) => r.data as SessionDoc)),
      ]);
      if (cancelled) return;
      s.setConnected(true);
      s.setProject(proj);
      s.setWorkUnits(wus);
      s.setSessions(sess);
    } catch {
      if (!cancelled) s.setConnected(false);
    }
  };

  register(reload);
  void reload();

  const cols = ['projects', 'work_units', 'sessions'];
  for (const col of cols) {
    pb.collection(col)
      .subscribe('*', () => void reload(), {
        filter: pb.filter('projectKey={:k}', { k: pid }),
      })
      .catch(() => {
        // realtime unavailable — the initial load still rendered
      });
  }

  return () => {
    cancelled = true;
    for (const col of cols) pb.collection(col).unsubscribe();
  };
}

/** Firestore: live per-doc deltas via onSnapshot (no polling). */
function subscribeFirestore(cfg: BoardConfig, s: Setters, register: RegisterReload): () => void {
  const db = getDb(cfg);
  const base = `projects/${cfg.projectId}`;

  // Manual pull (onSnapshot is already live; this backs refresh()/actions).
  register(async () => {
    try {
      const [proj, units, sess] = await Promise.all([
        getDoc(doc(db, base)),
        getDocs(collection(db, `${base}/workUnits`)),
        getDocs(query(collection(db, `${base}/sessions`), where('inProject', '==', true))),
      ]);
      s.setConnected(true);
      s.setProject(proj.exists() ? (proj.data() as ProjectDoc) : null);
      s.setWorkUnits(units.docs.map((d) => d.data() as WorkUnitDoc));
      s.setSessions(sess.docs.map((d) => d.data() as SessionDoc));
    } catch {
      s.setConnected(false);
    }
  });

  const unsubProject = onSnapshot(doc(db, base), (snap) => {
    s.setConnected(true);
    s.setProject(snap.exists() ? (snap.data() as ProjectDoc) : null);
  });
  const unsubUnits = onSnapshot(collection(db, `${base}/workUnits`), (snap) => {
    s.setWorkUnits(snap.docs.map((d) => d.data() as WorkUnitDoc));
  });
  const unsubSessions = onSnapshot(
    query(collection(db, `${base}/sessions`), where('inProject', '==', true)),
    (snap) => s.setSessions(snap.docs.map((d) => d.data() as SessionDoc)),
  );

  return () => {
    unsubProject();
    unsubUnits();
    unsubSessions();
  };
}
