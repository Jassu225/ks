'use client';
// lib/boardData.tsx — the ONE live store subscription, shared by every page.
//
// The root layout mounts BoardDataProvider (app/providers.tsx), so the board,
// the Briefing, Daily log and Activity Log pages and the shared header all read the same
// data, and a move between pages keeps the subscription (and the shared
// clock) instead of re-loading. Two subscriptions to one PocketBase collection
// would also fight: unsubscribe() drops every listener on that collection.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { stageOf } from './briefing-escalation';
import { useActivity, type ActivityData } from './useActivity';
import { useBoard, type BoardData } from './useBoard';
import { useBriefing, type BriefingData } from './useBriefing';
import { useNow } from './useNow';
import type { BoardConfig, MasterStatus, VersionStatus, WorkUnitDoc } from './types';

export interface SharedData {
  config: BoardConfig;
  board: BoardData;
  briefing: BriefingData;
  /** The Activity Log's master events and the backup_runs change signal. */
  activity: ActivityData;
  master: MasterStatus | null;
  /** Re-read the master's status now (after a request, say). */
  refreshMaster: () => Promise<void>;
  /** One shared clock (30 s) for stages, glows and "left" chips. */
  now: number;
  notesEnabled: boolean;
  /** Open briefing items that are hot or overdue right now. */
  bellCount: number;
  /** Inbox questions waiting + unseen messages, across every card. */
  inboxCount: number;
  /** This device's version status (GET /api/version; null until its daemon wrote one). */
  version: VersionStatus | null;
  /** The ks-flow version this board was built from (GET /api/version `board`). */
  boardVersion: string | null;
  /** The ks plugin's version on this Mac (GET /api/version `ks`). */
  ksVersion: string | null;
  /** This device's open ks-flow problems (GET /api/errors `open`): the header's ⚠ lights up. */
  errorCount: number;
}

const Ctx = createContext<SharedData | null>(null);

/** Open questions plus unseen messages across the cards' Inbox threads. A
 * thread's unseen count is added only when it holds no question, as the card
 * does, so one unseen question is not counted twice. */
export function inboxWaiting(units: WorkUnitDoc[]): number {
  let n = 0;
  for (const u of units) {
    for (const t of u.inbox?.threads ?? []) {
      n += t.open + (t.questions.length === 0 ? t.unseen : 0);
    }
  }
  return n;
}

/** A text field has the focus: reloading now would lose what is being typed. */
function typing(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'submit'].includes((el as HTMLInputElement).type));
}

export function BoardDataProvider({ config, children }: { config: BoardConfig; children: React.ReactNode }) {
  const board = useBoard(config);
  const briefing = useBriefing(config);
  const activity = useActivity(config);
  const now = useNow(30_000);

  const [master, setMaster] = useState<MasterStatus | null>(null);
  const refreshMaster = useCallback(async (): Promise<void> => {
    try {
      const r = await fetch('/api/briefing/master', { cache: 'no-store' });
      if (r.ok) setMaster((await r.json()) as MasterStatus);
    } catch {
      // board server restarting — keep the last status
    }
  }, []);
  useEffect(() => {
    void refreshMaster();
    const id = setInterval(() => void refreshMaster(), 15_000);
    return () => clearInterval(id);
  }, [refreshMaster]);

  // This device's version status (the banner; read-only while behind on the
  // store's data format). Polled: the daemon rewrites it every minute.
  const [version, setVersion] = useState<VersionStatus | null>(null);
  const [boardVersion, setBoardVersion] = useState<string | null>(null);
  const [ksVersion, setKsVersion] = useState<string | null>(null);
  // This device's open problems (the daemon's errors.json: a local file, no store read).
  const [errorCount, setErrorCount] = useState(0);
  // The board's build id when this tab loaded: a new one (an update rebuilt and
  // restarted the board) reloads the tab, unless you are typing (then the next poll).
  const loadedBuild = useRef<string | null>(null);
  useEffect(() => {
    const read = (): void => {
      fetch('/api/errors', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { open?: number } | null) => d && setErrorCount(d.open ?? 0))
        .catch(() => {});
      fetch('/api/version', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { status?: VersionStatus | null; board?: string | null; ks?: string | null; build?: string | null } | null) => {
          if (d?.build) {
            if (!loadedBuild.current) loadedBuild.current = d.build;
            else if (d.build !== loadedBuild.current && !typing()) {
              window.location.reload();
              return;
            }
          }
          if (d) {
            setVersion(d.status ?? null);
            setBoardVersion(d.board ?? null);
            setKsVersion(d.ks ?? null);
          }
        })
        .catch(() => {});
    };
    read();
    const id = setInterval(read, 30_000);
    // Back to the tab (after an update, say): look at once, not at the next poll.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') read();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // The Notes tab is opt-in (Settings → Notes).
  const [notesEnabled, setNotesEnabled] = useState(false);
  useEffect(() => {
    fetch('/api/notes/config')
      .then((r) => r.json())
      .then((c: { enabled?: boolean }) => setNotesEnabled(!!c?.enabled))
      .catch(() => {});
  }, []);

  const bellCount = useMemo(() => {
    const d = new Date(now);
    let n = 0;
    for (const it of briefing.items) {
      if (it.status !== 'open') continue;
      const st = stageOf(it, d);
      if (st === 'hot' || st === 'overdue') n++;
    }
    return n;
  }, [briefing.items, now]);

  const inboxCount = useMemo(() => inboxWaiting(board.workUnits), [board.workUnits]);

  const value = useMemo<SharedData>(
    () => ({ config, board, briefing, activity, master, refreshMaster, now, notesEnabled, bellCount, inboxCount, version, boardVersion, ksVersion, errorCount }),
    [config, board, briefing, activity, master, refreshMaster, now, notesEnabled, bellCount, inboxCount, version, boardVersion, ksVersion, errorCount],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useShared(): SharedData {
  const v = useContext(Ctx);
  if (!v) throw new Error('useShared outside BoardDataProvider');
  return v;
}

/** The board's live data (what useBoard returned before it moved here). */
export function useBoardData(): BoardData {
  return useShared().board;
}
