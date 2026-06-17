'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useBoard } from '@/lib/useBoard';
import { useNow } from '@/lib/useNow';
import type { BoardConfig, SessionDoc, WorkUnitDoc } from '@/lib/types';
import { Column } from './Column';
import { CompletedWorktrees } from './CompletedWorktrees';

// Ticket workflow runs only a subset of phases (init + context/research +
// plan/implement), so the ticket lane shows just these columns. Mirrors
// TICKET_TEMPLATE in src/lib/phasemodel.ts.
const TICKET_PHASES = new Set([0, 1, 2, 9, 10]);

// Linear statuses treated as "done" → hidden from the board.
const DONE_STATUSES = new Set([
  'done',
  'completed',
  'complete',
  'canceled',
  'cancelled',
  'merged',
  'closed',
  'archived',
]);

export function Board({ config }: { config: BoardConfig }) {
  const { project, workUnits, sessions, reminders, connected, refresh } = useBoard(config);
  const [swimlanes, setSwimlanes] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const now = useNow(30_000); // one shared clock → recency-based glow self-expires

  const onRefresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  };

  // Kill switch: stops the daemon + PocketBase (POST /api/kill). Two-step so a
  // stray click can't take down the backend. It auto-restarts + re-backfills on
  // the next Claude session, so this is reversible.
  const [killState, setKillState] = useState<'idle' | 'armed' | 'killing' | 'killed'>('idle');
  const onKill = async (): Promise<void> => {
    if (killState === 'idle') {
      setKillState('armed');
      setTimeout(() => setKillState((s) => (s === 'armed' ? 'idle' : s)), 4000);
      return;
    }
    if (killState !== 'armed') return;
    setKillState('killing');
    try {
      await fetch('/api/kill', { method: 'POST' });
    } catch {
      // best-effort — the daemon/PB may already be gone
    }
    setKillState('killed');
  };

  // Columns come from the project's phaseModel (project-defined), never a
  // hard-coded enum. Each card sits in the column matching its currentPhase.
  const columns = project?.phaseModel ?? [];

  // Hide the stale backlog: a card shows only if its worktree is a CURRENT git
  // worktree (PocketBase keeps old records forever, so worktreeDir alone isn't
  // enough) and it isn't in a done state.
  const liveWorktrees = useMemo(() => new Set(project?.worktreePaths ?? []), [project]);
  const visibleUnits = useMemo(
    () =>
      workUnits.filter(
        (u) =>
          u.worktreeDir &&
          liveWorktrees.has(u.worktreeDir) &&
          !(u.linearStatus && DONE_STATUSES.has(u.linearStatus.trim().toLowerCase())),
      ),
    [workUnits, liveWorktrees],
  );

  // Finished work whose git worktree still exists — the inverse of the board's
  // done-exclusion, restricted to live worktrees. Cleanup candidates.
  const completedWorktrees = useMemo(
    () =>
      workUnits
        .filter(
          (u) =>
            u.worktreeDir &&
            liveWorktrees.has(u.worktreeDir) &&
            u.linearStatus &&
            DONE_STATUSES.has(u.linearStatus.trim().toLowerCase()),
        )
        .sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? '')),
    [workUnits, liveWorktrees],
  );

  const byPhase = useMemo(() => {
    const map = new Map<number, WorkUnitDoc[]>();
    for (const c of columns) map.set(c.number, []);
    for (const u of visibleUnits) {
      const n = u.currentPhase?.number;
      if (n == null) continue;
      if (!map.has(n)) map.set(n, []);
      map.get(n)!.push(u);
    }
    return map;
  }, [columns, visibleUnits]);

  // Collapse to the latest session per worktree path — a path accrues many
  // sessions over time, but only the most recent one is shown. Sessions with no
  // path are kept individually (keyed by id).
  const latestSessions = useMemo(() => {
    const byPath = new Map<string, SessionDoc>();
    for (const s of sessions) {
      const key = s.worktreePath ?? s.sessionId;
      const cur = byPath.get(key);
      if (!cur || (s.lastActivity ?? '') > (cur.lastActivity ?? '')) byPath.set(key, s);
    }
    return [...byPath.values()];
  }, [sessions]);

  const types = swimlanes ? (['ticket', 'project'] as const) : ([null] as const);

  return (
    <div className="flex h-screen flex-col bg-slate-950 text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-800 bg-slate-900 px-5 py-3">
        <div>
          <h1 className="text-lg font-bold text-slate-100">ks-flow</h1>
          <p className="text-xs text-slate-500">{project?.projectPath ?? config.projectPath}</p>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span
            className="rounded bg-slate-800 px-2 py-0.5 font-mono text-[11px] text-slate-400"
            title="Active backing store (set by the daemon's db_provider)"
          >
            {config.dbProvider === 'firestore'
              ? `firestore · ${config.firestoreMode}`
              : 'pocketbase'}
          </span>
          <label className="flex items-center gap-1.5 text-slate-400">
            <input
              type="checkbox"
              checked={swimlanes}
              onChange={(e) => setSwimlanes(e.target.checked)}
              className="accent-indigo-500"
            />
            swimlanes
          </label>
          <span
            className={`flex items-center gap-1 ${connected ? 'text-emerald-400' : 'text-slate-500'}`}
          >
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                connected ? 'bg-emerald-400' : 'bg-slate-600'
              }`}
            />
            {connected ? 'live' : 'connecting…'}
          </span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            title="Refresh the board + completed worktrees from the store"
            className="rounded px-2 py-0.5 text-slate-400 hover:text-slate-200 disabled:opacity-50"
          >
            <span className={`inline-block ${refreshing ? 'animate-spin' : ''}`}>↻</span>
          </button>
          <Link href="/settings" className="text-slate-400 hover:text-slate-200" title="Settings">
            ⚙
          </Link>
          <button
            type="button"
            onClick={onKill}
            disabled={killState === 'killing' || killState === 'killed'}
            title="Stop the daemon + PocketBase. They restart and re-backfill on the next Claude session."
            className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
              killState === 'armed'
                ? 'bg-red-600 text-white'
                : killState === 'killed'
                  ? 'bg-slate-800 text-slate-500'
                  : 'bg-red-950/50 text-red-400 hover:bg-red-900/60'
            }`}
          >
            {killState === 'idle' && 'kill'}
            {killState === 'armed' && 'confirm?'}
            {killState === 'killing' && 'killing…'}
            {killState === 'killed' && 'stopped'}
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto overflow-x-hidden p-4">
        {columns.length === 0 ? (
          <div className="grid h-full place-items-center text-sm text-slate-500">
            No phases yet — the daemon hasn’t ingested a state.yaml for this project.
          </div>
        ) : (
          types.map((t) => {
            const unitsForLane = t ? visibleUnits.filter((u) => u.type === t) : visibleUnits;
            // Hide an empty lane so a ticket-only (or project-only) repo doesn't
            // render a wide band of empty columns for the other type.
            if (t && unitsForLane.length === 0) return null;
            const laneSet = new Set(unitsForLane.map((u) => u.unitId));
            // Ticket lane shows only ticket phases; project lane (and the
            // combined view) shows the full phase model.
            const laneColumns =
              t === 'ticket' ? columns.filter((c) => TICKET_PHASES.has(c.number)) : columns;
            return (
              <section key={t ?? 'all'} className="mb-6">
                {t && (
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {t}s
                  </h3>
                )}
                <div className="flex gap-3 overflow-x-auto pb-2">
                  {laneColumns.map((c) => (
                    <Column
                      key={c.number}
                      phase={c}
                      units={(byPhase.get(c.number) ?? []).filter((u) => laneSet.has(u.unitId))}
                      sessions={latestSessions}
                      reminders={reminders}
                      now={now}
                    />
                  ))}
                </div>
              </section>
            );
          })
        )}
        <CompletedWorktrees units={completedWorktrees} onRefresh={onRefresh} />
      </main>
    </div>
  );
}
