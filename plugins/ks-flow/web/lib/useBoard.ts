'use client';
// useBoard — the board's store subscription (one instance, in
// lib/boardData.tsx's provider; pages read it with useBoardData()). It subscribes to the
// devices, the shared settings, work-units, and in-project sessions in real time and keeps the board
// components provider-agnostic: they never import a backend. Which backend it
// talks to is decided by cfg.dbProvider (resolved identically on the daemon):
//   - pocketbase (default): REST initial load + SSE realtime, local server.
//   - firestore: the board server's live stream (app/api/store/live, firebase-admin).
//
// One board for several devices: `devices` holds every device's record (its
// worktrees, Inbox, last Linear read), `settings` is meta/settings (null until
// the store is set up for devices: scripts/one-off/backfill-devices.ts), and
// `self` is this device's id. The retired meta/project is not read.
import { useEffect, useRef, useState } from 'react';
import { openLive, type LiveStatus } from './liveStore';
import { getPb } from './pocketbase';
import type { BoardConfig, DeviceDoc, ReminderDoc, SessionDoc, SettingsDoc, WorkUnitDoc } from './types';

export interface BoardData {
  /** Every known device (any number), forgotten ones included. */
  devices: DeviceDoc[];
  /** meta/settings: the shared settings and masterDeviceId; null before the device backfill. */
  settings: SettingsDoc | null;
  /** This device's id. */
  self: string;
  workUnits: WorkUnitDoc[];
  sessions: SessionDoc[];
  reminders: ReminderDoc[];
  connected: boolean;
  /** Firestore offline mode: are the live listeners up, and how many writes
   * wait in the outbox. null with PocketBase. */
  storeStatus: LiveStatus | null;
  /** Re-pull everything from the store. Reusable by any UI action (e.g. after
   * removing a worktree) and by the header's manual refresh button. The live
   * subscription still pushes on its own; this is an explicit on-demand pull. */
  refresh: () => Promise<void>;
}

export function useBoard(cfg: BoardConfig): BoardData {
  const [devices, setDevices] = useState<DeviceDoc[]>([]);
  const [settings, setSettings] = useState<SettingsDoc | null>(null);
  const [workUnits, setWorkUnits] = useState<WorkUnitDoc[]>([]);
  const [sessions, setSessions] = useState<SessionDoc[]>([]);
  const [reminders, setReminders] = useState<ReminderDoc[]>([]);
  const [connected, setConnected] = useState(false);
  const [storeStatus, setStoreStatus] = useState<LiveStatus | null>(null);
  // Populated by whichever backend subscribes; the returned refresh() proxies
  // to it so callers get a stable function identity.
  const reloadRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    // No project configured yet: nothing to subscribe to (the pages say so).
    if (!cfg.projectId) return;
    const setters = { setDevices, setSettings, setWorkUnits, setSessions, setReminders, setConnected, setStoreStatus };
    const register = (fn: () => Promise<void>): void => {
      reloadRef.current = fn;
    };
    if (cfg.dbProvider === 'pocketbase') {
      return subscribePocketbase(cfg, setters, register);
    }
    return subscribeFirestore(cfg, setters, register);
  }, [cfg]);

  return {
    devices,
    settings,
    self: cfg.deviceId,
    workUnits,
    sessions,
    reminders,
    connected,
    storeStatus,
    refresh: () => reloadRef.current(),
  };
}

interface Setters {
  setDevices: (d: DeviceDoc[]) => void;
  setSettings: (s: SettingsDoc | null) => void;
  setWorkUnits: (u: WorkUnitDoc[]) => void;
  setSessions: (s: SessionDoc[]) => void;
  setReminders: (r: ReminderDoc[]) => void;
  setConnected: (c: boolean) => void;
  setStoreStatus: (st: LiveStatus | null) => void;
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
      const [devs, meta, wus, sess, rems] = await Promise.all([
        pb
          .collection('devices')
          .getFullList()
          .then((rs) => rs.map((r) => ({ ...(r.data as DeviceDoc), deviceId: String(r.key) })))
          .catch(() => [] as DeviceDoc[]),
        pb
          .collection('meta')
          .getFirstListItem(pb.filter('key={:k}', { k: 'settings' }))
          .then((r) => r.data as SettingsDoc)
          .catch(() => null),
        pb
          .collection('work_units')
          .getFullList({ filter: pb.filter('projectKey={:k}', { k: pid }) })
          .then((rs) => rs.map((r) => r.data as WorkUnitDoc)),
        pb
          .collection('sessions')
          .getFullList({ filter: pb.filter('projectKey={:k} && inProject=true', { k: pid }) })
          .then((rs) => rs.map((r) => r.data as SessionDoc)),
        pb
          .collection('reminders')
          .getFullList({ filter: pb.filter('projectKey={:k}', { k: pid }) })
          .then((rs) => rs.map((r) => r.data as ReminderDoc))
          .catch(() => [] as ReminderDoc[]),
      ]);
      if (cancelled) return;
      s.setConnected(true);
      s.setDevices(devs);
      s.setSettings(meta);
      s.setWorkUnits(wus);
      s.setSessions(sess);
      s.setReminders(rems);
    } catch {
      if (!cancelled) s.setConnected(false);
    }
  };

  register(reload);
  void reload();

  // devices / meta are not per project (PocketBase holds this device alone).
  const cols: Array<[string, string | undefined]> = [
    ['devices', undefined],
    ['meta', undefined],
    ['work_units', pb.filter('projectKey={:k}', { k: pid })],
    ['sessions', pb.filter('projectKey={:k}', { k: pid })],
    ['reminders', pb.filter('projectKey={:k}', { k: pid })],
  ];
  for (const [col, filter] of cols) {
    pb.collection(col)
      .subscribe('*', () => void reload(), filter ? { filter } : {})
      .catch(() => {
        // realtime unavailable (or the collection predates the migration) — the initial load still rendered
      });
  }

  return () => {
    cancelled = true;
    for (const [col] of cols) pb.collection(col).unsubscribe().catch(() => {});
  };
}

/** Firestore: the board's server streams the store (app/api/store/live); the
 * browser never talks to Firestore itself. */
function subscribeFirestore(cfg: BoardConfig, s: Setters, register: RegisterReload): () => void {
  const live = openLive('board', {
    onSnap: (key, docs) => {
      if (key === 'devices') s.setDevices(docs as DeviceDoc[]);
      else if (key === 'settings') s.setSettings((docs[0] as SettingsDoc | undefined) ?? null);
      else if (key === 'workUnits') s.setWorkUnits(docs as WorkUnitDoc[]);
      else if (key === 'sessions') s.setSessions(docs as SessionDoc[]);
      else if (key === 'reminders') s.setReminders(docs as ReminderDoc[]);
    },
    onConnected: (ok) => s.setConnected(ok),
    onStatus: (st) => s.setStoreStatus(st),
  });
  register(live.reload);
  return live.close;
}
