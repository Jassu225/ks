'use client';
// useBriefing — live subscription to the Briefing collections (docs/briefing.md,
// "Data"): briefing_items, briefing_runs, daily_logs. Same two backends as
// useBoard: PocketBase (REST load + SSE re-load) or Firestore (onSnapshot).
//
// What it loads: every OPEN item, plus items archived within the last
// WINDOW_DAYS (by `archivedAt`, so an item archived today that fell due long
// ago still shows; enough for "archived today" and the daily log's recent days
// without pulling the whole history on every change); the newest runs; the
// daily logs of the same window.
import {
  collection,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
} from 'firebase/firestore';
import { useEffect, useRef, useState } from 'react';
import { getDb } from './firebase';
import { getPb } from './pocketbase';
import type { BoardConfig, BriefingItemDoc, BriefingRunDoc, DailyLogDoc } from './types';

export const WINDOW_DAYS = 60;
/** Newest runs kept: the Briefing page shows the last one, the Activity Log lists them. */
const RUNS = 100;

export interface BriefingData {
  items: BriefingItemDoc[];
  runs: BriefingRunDoc[];
  dailyLogs: DailyLogDoc[];
  /** True once the first load came back (so pages can tell "empty" from "loading"). */
  loaded: boolean;
  refresh: () => Promise<void>;
}

const sinceIso = (): string => new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
const sinceDate = (): string => sinceIso().slice(0, 10);

export function useBriefing(cfg: BoardConfig): BriefingData {
  const [items, setItems] = useState<BriefingItemDoc[]>([]);
  const [runs, setRuns] = useState<BriefingRunDoc[]>([]);
  const [dailyLogs, setDailyLogs] = useState<DailyLogDoc[]>([]);
  const [loaded, setLoaded] = useState(false);
  const reloadRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    if (!cfg.projectId) return;
    const s: Setters = { setItems, setRuns, setDailyLogs, setLoaded };
    const register = (fn: () => Promise<void>): void => {
      reloadRef.current = fn;
    };
    return cfg.dbProvider === 'pocketbase'
      ? subscribePocketbase(cfg, s, register)
      : subscribeFirestore(cfg, s, register);
  }, [cfg]);

  return { items, runs, dailyLogs, loaded, refresh: () => reloadRef.current() };
}

interface Setters {
  setItems: (v: BriefingItemDoc[]) => void;
  setRuns: (v: BriefingRunDoc[]) => void;
  setDailyLogs: (v: DailyLogDoc[]) => void;
  setLoaded: (v: boolean) => void;
}

const byStartedDesc = (a: BriefingRunDoc, b: BriefingRunDoc): number =>
  (b.startedAt ?? '').localeCompare(a.startedAt ?? '');

function subscribePocketbase(
  cfg: BoardConfig,
  s: Setters,
  register: (fn: () => Promise<void>) => void,
): () => void {
  const pb = getPb(cfg);
  const k = cfg.projectId;
  let cancelled = false;
  // A master run writes many records in a burst; coalesce into one trailing re-load.
  let inFlight: Promise<void> | null = null;
  let again = false;

  const load = async (): Promise<void> => {
    const [items, runs, logs] = await Promise.all([
      pb
        .collection('briefing_items')
        .getFullList({
          filter: pb.filter("projectKey={:k} && (status='open' || archivedAt>={:since})", {
            k,
            since: sinceIso(),
          }),
        })
        .then((rs) => rs.map((r) => r.data as BriefingItemDoc).filter(Boolean))
        .catch(() => [] as BriefingItemDoc[]),
      pb
        .collection('briefing_runs')
        .getList(1, RUNS, { filter: pb.filter('projectKey={:k}', { k }), sort: '-startedAt' })
        .then((res) => res.items.map((r) => r.data as BriefingRunDoc).filter(Boolean))
        .catch(() => [] as BriefingRunDoc[]),
      pb
        .collection('daily_logs')
        .getFullList({ filter: pb.filter('projectKey={:k} && date>={:d}', { k, d: sinceDate() }) })
        .then((rs) => rs.map((r) => r.data as DailyLogDoc).filter(Boolean))
        .catch(() => [] as DailyLogDoc[]),
    ]);
    if (cancelled) return;
    s.setItems(items);
    s.setRuns(runs.sort(byStartedDesc));
    s.setDailyLogs(logs);
    s.setLoaded(true);
  };

  const reload = async (): Promise<void> => {
    if (inFlight) {
      again = true;
      return inFlight;
    }
    inFlight = (async () => {
      do {
        again = false;
        await load();
      } while (again && !cancelled);
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  register(reload);
  void reload();

  const cols = ['briefing_items', 'briefing_runs', 'daily_logs'];
  for (const col of cols) {
    pb.collection(col)
      .subscribe('*', () => void reload(), { filter: pb.filter('projectKey={:k}', { k }) })
      .catch(() => {
        // collection missing (migration not applied yet) or realtime down
      });
  }
  return () => {
    cancelled = true;
    for (const col of cols) pb.collection(col).unsubscribe().catch(() => {});
  };
}

function subscribeFirestore(
  cfg: BoardConfig,
  s: Setters,
  register: (fn: () => Promise<void>) => void,
): () => void {
  const db = getDb(cfg);
  const base = `projects/${cfg.projectId}`;
  const itemsCol = collection(db, `${base}/briefingItems`);
  const runsCol = collection(db, `${base}/briefingRuns`);
  const logsCol = collection(db, `${base}/dailyLogs`);
  // Two single-field queries (no composite index needed), merged by uid: the
  // open items, and those archived in the window (an open item's archivedAt is
  // null, which a '>=' on a string leaves out).
  const openQ = query(itemsCol, where('status', '==', 'open'));
  const recentQ = query(itemsCol, where('archivedAt', '>=', sinceIso()));
  const runsQ = query(runsCol, orderBy('startedAt', 'desc'), limit(RUNS));
  const logsQ = query(logsCol, where('date', '>=', sinceDate()));

  let open: BriefingItemDoc[] = [];
  let recent: BriefingItemDoc[] = [];
  const emitItems = (): void => {
    const m = new Map<string, BriefingItemDoc>();
    for (const d of [...recent, ...open]) m.set(d.uid, d);
    s.setItems([...m.values()]);
    s.setLoaded(true);
  };

  register(async () => {
    const [o, r, ru, l] = await Promise.all([getDocs(openQ), getDocs(recentQ), getDocs(runsQ), getDocs(logsQ)]);
    open = o.docs.map((d) => d.data() as BriefingItemDoc);
    recent = r.docs.map((d) => d.data() as BriefingItemDoc);
    emitItems();
    s.setRuns(ru.docs.map((d) => d.data() as BriefingRunDoc));
    s.setDailyLogs(l.docs.map((d) => d.data() as DailyLogDoc));
  });

  const unsubs = [
    onSnapshot(openQ, (snap) => {
      open = snap.docs.map((d) => d.data() as BriefingItemDoc);
      emitItems();
    }),
    onSnapshot(recentQ, (snap) => {
      recent = snap.docs.map((d) => d.data() as BriefingItemDoc);
      emitItems();
    }),
    onSnapshot(runsQ, (snap) => s.setRuns(snap.docs.map((d) => d.data() as BriefingRunDoc))),
    onSnapshot(logsQ, (snap) => s.setDailyLogs(snap.docs.map((d) => d.data() as DailyLogDoc))),
  ];
  return () => unsubs.forEach((u) => u());
}
