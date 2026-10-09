'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { SeeLogs, useStreams } from '@/components/StreamPanel';
import type { WorkUnitDoc } from '@/lib/types';

function relTime(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

interface BusyProc {
  pid: number;
  command: string;
  isClaude: boolean;
}

// Each Remove is a stream (components/StreamPanel.tsx) under `remove:<unitId>`,
// with its own bottom-right panel. Remove's two special cases are states of that
// stream: `warn` for "no command configured", and `custom` for the "a live
// process is still in this worktree" confirm prompt. Hidden, it comes back
// through See logs beside the button.

/**
 * Worktrees whose work is finished (Linear status done/merged/closed) but whose
 * git worktree still exists — cleanup candidates. The daemon nulls worktreeDir
 * for dead worktrees, so a non-null worktreeDir here means the dir is live.
 *
 * Each row's Remove button runs the user's configured removal command (set in
 * Settings) via /api/run-command, streaming its output into the bottom-right
 * panel. On success it optimistically hides the row and asks the board to
 * refresh; on failure the error stays in the panel.
 */
export function CompletedWorktrees({
  units,
  onRefresh,
}: {
  units: WorkUnitDoc[];
  onRefresh?: () => void | Promise<void>;
}) {
  const [removeCommand, setRemoveCommand] = useState<string | null>(null);
  const [removed, setRemoved] = useState<Set<string>>(new Set()); // optimistic hide
  // Each worktree's removal is its own stream: its checks, confirmation and
  // output stay in its own panel, and survive a trip to another page.
  const { get, show, run, dismiss } = useStreams();
  const keyOf = (u: WorkUnitDoc): string => `remove:${u.unitId}`;
  /** Running, or waiting on the kill-sessions confirmation. */
  const isBusy = (u: WorkUnitDoc): boolean => {
    const s = get(keyOf(u));
    return Boolean(s && (s.isRunning || s.view.kind === 'custom'));
  };

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((s: { removeCommand?: string }) => setRemoveCommand(s.removeCommand ?? ''))
      .catch(() => setRemoveCommand(''));
  }, []);

  const visible = useMemo(() => units.filter((u) => !removed.has(u.unitId)), [units, removed]);

  // Stream the remove command, optionally killing live sessions in the worktree
  // first (only after the user confirmed). Updates the panel live + on exit.
  const doRemove = async (u: WorkUnitDoc, kill: boolean): Promise<void> => {
    if (!u.worktreeDir) return;
    const key = keyOf(u);
    if (kill) {
      show(key, { kind: 'running', title: u.identifier, output: 'killing sessions in worktree…\n' }, { isRunning: true });
      const kRes = await fetch('/api/worktree-kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: u.worktreeDir }),
      });
      const k = await kRes.json().catch(() => ({ stillAlive: [] }));
      if (Array.isArray(k.stillAlive) && k.stillAlive.length) {
        show(key, {
          kind: 'err',
          title: u.identifier,
          output: `could not kill pid(s) ${k.stillAlive.join(', ')} — remove aborted`,
        });
        return;
      }
    }

    await run(key, {
      title: u.identifier,
      url: '/api/run-command',
      body: { path: u.worktreeDir, identifier: u.identifier, title: u.title },
      successNote: '✓ removed',
      onSuccess: async () => {
        setRemoved((prev) => new Set(prev).add(u.unitId)); // optimistic hide
        await onRefresh?.(); // re-pull the board + this section
      },
      // The route answers with JSON (not NDJSON) when no removal command is
      // configured; that deserves a link to Settings, not a raw error line.
      mapEarlyError: (payload: unknown) =>
        (payload as { needsConfig?: boolean; error?: string })?.needsConfig
          ? {
              kind: 'warn',
              title: 'No remove command',
              msg: (payload as { error?: string }).error ?? 'Set a removal command in Settings.',
              settingsLink: true,
            }
          : undefined,
    });
  };

  const onRemove = async (u: WorkUnitDoc): Promise<void> => {
    if (!u.worktreeDir || isBusy(u)) return;
    const key = keyOf(u);
    if (removeCommand !== null && !removeCommand.trim()) {
      show(key, {
        kind: 'warn',
        title: 'No remove command',
        msg: 'Set a removal command in Settings before removing a worktree.',
        settingsLink: true,
      });
      return;
    }
    show(key, { kind: 'running', title: u.identifier, output: 'checking for live sessions…' }, { isRunning: true });
    try {
      const busyRes = await fetch('/api/worktree-busy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: u.worktreeDir }),
      });
      const busy = await busyRes.json().catch(() => ({ busy: false, processes: [] }));
      if (busyRes.ok && busy.busy) {
        // Don't remove blindly — ask the user to approve killing the sessions.
        const procs: BusyProc[] = busy.processes ?? [];
        const claude = procs.some((p) => p.isClaude);
        show(key, {
          kind: 'custom',
          title: u.identifier,
          body: (
            <>
              <p className="mb-2">
                {claude
                  ? 'A Claude Code session is still live in this worktree. Killing it will lose its current turn.'
                  : 'A process is still using this worktree.'}
              </p>
              <ul className="space-y-1 font-mono text-[11px] text-slate-400">
                {procs.map((p) => (
                  <li key={p.pid} className="truncate" title={p.command}>
                    <span className={p.isClaude ? 'text-indigo-300' : 'text-slate-500'}>
                      {p.isClaude ? 'claude' : 'proc'}
                    </span>{' '}
                    <span className="text-slate-600">pid {p.pid}</span> · {p.command}
                  </li>
                ))}
              </ul>
            </>
          ),
          actions: (
            <>
              <button
                type="button"
                onClick={() => dismiss(key)}
                className="rounded bg-slate-800 px-3 py-1 text-[11px] font-medium text-slate-300 hover:bg-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void doRemove(u, true)}
                className="rounded bg-red-700 px-3 py-1 text-[11px] font-medium text-white hover:bg-red-600"
              >
                Kill sessions &amp; remove
              </button>
            </>
          ),
        });
        return;
      }
    } catch {
      show(key, {
        kind: 'err',
        title: u.identifier,
        output: 'Could not check for live sessions — is the board server still running?',
      });
      return;
    }
    // worktree is clear — remove without killing.
    await doRemove(u, false);
  };

  if (visible.length === 0) return null;

  return (
    <section className="mt-8 border-t border-slate-800 pt-5">
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
        Completed worktrees · not removed
        <span className="ml-2 rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
          {visible.length}
        </span>
      </h2>
      <p className="mb-3 text-[11px] text-slate-600">
        Finished work whose git worktree still exists. Remove runs your configured command (
        <Link href="/settings" className="text-indigo-400 hover:text-indigo-300">
          Settings
        </Link>
        ).
      </p>

      {visible.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate-800">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-900 text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">Ticket</th>
                <th className="px-3 py-2 font-medium">Title</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">PR</th>
                <th className="px-3 py-2 font-medium">Worktree</th>
                <th className="px-3 py-2 font-medium">Last activity</th>
                <th className="px-3 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {visible.map((u) => (
                <tr key={u.unitId} className="bg-slate-950 hover:bg-slate-900/60">
                  <td className="px-3 py-2 font-mono text-slate-400">
                  {u.linearUrl ? (
                    <a
                      href={u.linearUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-indigo-400 hover:text-indigo-300"
                      title="Open in Linear"
                    >
                      {u.identifier} ↗
                    </a>
                  ) : (
                    u.identifier
                  )}
                </td>
                  <td className="max-w-md truncate px-3 py-2 text-slate-200" title={u.title}>
                    {u.title}
                  </td>
                  <td className="px-3 py-2">
                    {u.linearStatus && (
                      <span className="rounded bg-emerald-950 px-1.5 py-0.5 text-emerald-300">
                        {u.linearStatus}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {u.pr ? (
                      <a
                        href={u.pr.url}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded bg-violet-950 px-1.5 py-0.5 font-medium text-violet-300 hover:bg-violet-900"
                      >
                        PR{u.pr.number ? ` #${u.pr.number}` : ''}
                      </a>
                    ) : (
                      <span className="text-slate-600">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2" title={u.worktreeDir ?? ''}>
                    <span className="block max-w-[16rem] break-all font-mono text-[10px] text-slate-500">
                      {u.worktreeDir}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-500">{relTime(u.lastActivity)}</td>
                  <td className="px-3 py-2 text-right">
                    <span className="inline-flex items-center gap-1">
                      <SeeLogs streamKey={keyOf(u)} />
                      <button
                        type="button"
                        onClick={() => onRemove(u)}
                        disabled={isBusy(u)}
                        className="rounded bg-red-950/60 px-2 py-0.5 text-[11px] font-medium text-red-300 hover:bg-red-900/70 disabled:opacity-50"
                      >
                        {get(keyOf(u))?.isRunning ? 'removing…' : 'Remove'}
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

    </section>
  );
}
