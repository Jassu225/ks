'use client';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
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

// Bottom-right panel state. `running` while the command streams; resolves to
// `ok`/`err` on exit, `warn` for a pre-flight prompt (no command configured),
// or `confirm` when a live process still sits in the worktree and the user must
// approve killing it before the remove proceeds.
type Panel =
  | { kind: 'running' | 'ok' | 'err'; title: string; output: string }
  | { kind: 'warn'; title: string; msg: string; settingsLink: true }
  | { kind: 'confirm'; title: string; msg: string; unit: WorkUnitDoc; processes: BusyProc[] };

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
  const [running, setRunning] = useState<string | null>(null); // unitId in flight
  const [removed, setRemoved] = useState<Set<string>>(new Set()); // optimistic hide
  const [panel, setPanel] = useState<Panel | null>(null);
  const outputEnd = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((s: { removeCommand?: string }) => setRemoveCommand(s.removeCommand ?? ''))
      .catch(() => setRemoveCommand(''));
  }, []);

  // keep the streaming output scrolled to the latest line
  useEffect(() => {
    if (panel && 'output' in panel) outputEnd.current?.scrollIntoView({ block: 'end' });
  }, [panel]);

  const visible = useMemo(() => units.filter((u) => !removed.has(u.unitId)), [units, removed]);

  // Stream the remove command, optionally killing live sessions in the worktree
  // first (only after the user confirmed). Updates the panel live + on exit.
  const doRemove = async (u: WorkUnitDoc, kill: boolean): Promise<void> => {
    if (!u.worktreeDir) return;
    setRunning(u.unitId);
    try {
      if (kill) {
        setPanel({ kind: 'running', title: u.identifier, output: 'killing sessions in worktree…\n' });
        const kRes = await fetch('/api/worktree-kill', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: u.worktreeDir }),
        });
        const k = await kRes.json().catch(() => ({ stillAlive: [] }));
        if (Array.isArray(k.stillAlive) && k.stillAlive.length) {
          setPanel({
            kind: 'err',
            title: u.identifier,
            output: `could not kill pid(s) ${k.stillAlive.join(', ')} — remove aborted`,
          });
          return;
        }
      }

      setPanel({ kind: 'running', title: u.identifier, output: '' });
      const res = await fetch('/api/run-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: u.worktreeDir, identifier: u.identifier, title: u.title }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        if (data.needsConfig) {
          setPanel({ kind: 'warn', title: 'No remove command', msg: data.error, settingsLink: true });
        } else {
          setPanel({ kind: 'err', title: u.identifier, output: data.error ?? 'Command failed.' });
        }
        return;
      }

      // Stream NDJSON: {type:stdout|stderr|exit}. Append text live; capture exit.
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let output = '';
      let exitCode: number | null = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: { type?: string; data?: string; code?: number };
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.type === 'stdout' || ev.type === 'stderr') {
            output += ev.data ?? '';
            setPanel({ kind: 'running', title: u.identifier, output });
          } else if (ev.type === 'exit') {
            exitCode = ev.code ?? 0;
          }
        }
      }

      if (exitCode === 0) {
        setPanel({ kind: 'ok', title: u.identifier, output: output + '\n✓ removed' });
        setRemoved((prev) => new Set(prev).add(u.unitId)); // optimistic hide
        await onRefresh?.(); // re-pull the board + this section
      } else {
        setPanel({
          kind: 'err',
          title: u.identifier,
          output: output + `\n✗ exited with code ${exitCode ?? '?'}`,
        });
      }
    } catch {
      setPanel({
        kind: 'err',
        title: u.identifier,
        output: 'Request failed — is the board server still running?',
      });
    } finally {
      setRunning(null);
    }
  };

  const onRemove = async (u: WorkUnitDoc): Promise<void> => {
    if (!u.worktreeDir || running) return;
    if (removeCommand !== null && !removeCommand.trim()) {
      setPanel({
        kind: 'warn',
        title: 'No remove command',
        msg: 'Set a removal command in Settings before removing a worktree.',
        settingsLink: true,
      });
      return;
    }
    setRunning(u.unitId);
    setPanel({ kind: 'running', title: u.identifier, output: 'checking for live sessions…' });
    try {
      const busyRes = await fetch('/api/worktree-busy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: u.worktreeDir }),
      });
      const busy = await busyRes.json().catch(() => ({ busy: false, processes: [] }));
      if (busyRes.ok && busy.busy) {
        // Don't remove blindly — ask the user to approve killing the sessions.
        const claude = (busy.processes as BusyProc[]).some((p) => p.isClaude);
        setPanel({
          kind: 'confirm',
          title: u.identifier,
          unit: u,
          msg: claude
            ? 'A Claude Code session is still live in this worktree. Killing it will lose its current turn.'
            : 'A process is still using this worktree.',
          processes: busy.processes ?? [],
        });
        setRunning(null);
        return;
      }
    } catch {
      setPanel({
        kind: 'err',
        title: u.identifier,
        output: 'Could not check for live sessions — is the board server still running?',
      });
      setRunning(null);
      return;
    }
    // worktree is clear — remove without killing.
    await doRemove(u, false);
  };

  if (visible.length === 0 && !panel) return null;

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
                    <button
                      type="button"
                      onClick={() => onRemove(u)}
                      disabled={running !== null || panel?.kind === 'confirm'}
                      className="rounded bg-red-950/60 px-2 py-0.5 text-[11px] font-medium text-red-300 hover:bg-red-900/70 disabled:opacity-50"
                    >
                      {running === u.unitId ? 'removing…' : 'Remove'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {panel && (
        <div
          className={`fixed bottom-4 right-4 z-50 flex max-h-[60vh] w-[28rem] max-w-[calc(100vw-2rem)] flex-col rounded-lg border shadow-xl ${
            panel.kind === 'ok'
              ? 'border-emerald-800 bg-slate-950'
              : panel.kind === 'err'
                ? 'border-red-800 bg-slate-950'
                : panel.kind === 'warn' || panel.kind === 'confirm'
                  ? 'border-amber-800 bg-slate-950'
                  : 'border-slate-700 bg-slate-950'
          }`}
        >
          <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2 text-xs">
            <span className="flex items-center gap-2 font-medium text-slate-200">
              {panel.kind === 'running' && (
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-indigo-400" />
              )}
              {panel.kind === 'ok' && <span className="text-emerald-400">✓</span>}
              {panel.kind === 'err' && <span className="text-red-400">✗</span>}
              {panel.kind === 'warn' && <span className="text-amber-400">⚠</span>}
              {panel.kind === 'confirm' && <span className="text-amber-400">⚠</span>}
              {panel.title}
            </span>
            <button
              type="button"
              onClick={() => setPanel(null)}
              className="text-slate-500 hover:text-slate-300"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
          {panel.kind === 'warn' ? (
            <div className="px-3 py-3 text-xs text-amber-200">
              <p>{panel.msg}</p>
              <Link
                href="/settings"
                className="mt-2 inline-block font-medium text-indigo-400 hover:text-indigo-300"
              >
                Open Settings →
              </Link>
            </div>
          ) : panel.kind === 'confirm' ? (
            <div className="flex flex-col overflow-hidden">
              <div className="overflow-auto px-3 py-3 text-xs text-amber-200">
                <p className="mb-2">{panel.msg}</p>
                <ul className="space-y-1 font-mono text-[11px] text-slate-400">
                  {panel.processes.map((p) => (
                    <li key={p.pid} className="truncate" title={p.command}>
                      <span className={p.isClaude ? 'text-indigo-300' : 'text-slate-500'}>
                        {p.isClaude ? 'claude' : 'proc'}
                      </span>{' '}
                      <span className="text-slate-600">pid {p.pid}</span> · {p.command}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-800 px-3 py-2">
                <button
                  type="button"
                  onClick={() => setPanel(null)}
                  className="rounded bg-slate-800 px-3 py-1 text-[11px] font-medium text-slate-300 hover:bg-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => doRemove(panel.unit, true)}
                  className="rounded bg-red-700 px-3 py-1 text-[11px] font-medium text-white hover:bg-red-600"
                >
                  Kill sessions &amp; remove
                </button>
              </div>
            </div>
          ) : (
            <pre className="overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-300">
              {panel.output || '…'}
              <div ref={outputEnd} />
            </pre>
          )}
        </div>
      )}
    </section>
  );
}
