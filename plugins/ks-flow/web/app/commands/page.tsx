'use client';
// /commands — the message board (src/lib/device-commands.ts): every command
// posted for a device's daemon (by the master, an agent or `ks-flow
// device-run`), newest first: when, who asked from which device, which device
// runs it, the command and its argument, its status and outcome, and the end of
// its output. Live: the activity scope of the board's stream (deviceCommands,
// newest 200). Commands are kept 30 days.

import { useMemo, useState } from 'react';
import { AppHeader } from '@/components/AppHeader';
import { DeviceChip } from '@/components/DeviceChip';
import { useShared } from '@/lib/boardData';
import type { DeviceCommandDoc } from '@/lib/types';

const STATUS_STYLE: Record<DeviceCommandDoc['status'], string> = {
  queued: 'border-slate-600 text-slate-300',
  running: 'border-sky-700 bg-sky-950/60 text-sky-200',
  ok: 'border-emerald-800 bg-emerald-950/50 text-emerald-200',
  failed: 'border-red-900 bg-red-950/50 text-red-200',
  refused: 'border-amber-800 bg-amber-950/50 text-amber-200',
  expired: 'border-slate-700 text-slate-500',
};

function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function took(c: DeviceCommandDoc): string {
  const a = Date.parse(c.startedAt ?? '');
  const b = Date.parse(c.endedAt ?? '');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '';
  const s = Math.max(0, Math.round((b - a) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function argOf(c: DeviceCommandDoc): string {
  return c.args?.ticket ?? c.args?.dir ?? c.args?.unit ?? '';
}

export default function CommandsPage() {
  const { activity, config } = useShared();
  const [open, setOpen] = useState<string | null>(null);
  const [status, setStatus] = useState<'all' | 'problems'>('all');
  const rows = useMemo(
    () => activity.deviceCommands.filter((c) => status === 'all' || c.status === 'failed' || c.status === 'refused' || c.status === 'expired'),
    [activity.deviceCommands, status],
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <AppHeader
        toolbar={
          <>
            <h1 className="text-sm font-semibold text-slate-200">Commands</h1>
            <div className="grow" />
            <label className="flex items-center gap-1.5 text-slate-400">
              show
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as 'all' | 'problems')}
                className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-slate-200"
              >
                <option value="all">all</option>
                <option value="problems">failed, refused, expired</option>
              </select>
            </label>
          </>
        }
      />

      <main className="mx-auto max-w-6xl px-5 py-8">
        <p className="text-xs text-slate-400">
          The message board: commands one device asks another device&apos;s ks-flow daemon to run (
          <span className="font-mono text-slate-300">ks-flow device-run</span>; the master uses it to start tickets on
          another Mac). Only a fixed list runs (ping, start-ticket, new-session, restart-session, backup), with checked
          arguments and never a first message for Claude. Kept 30 days.
        </p>

        {config.dbProvider === 'pocketbase' && (
          <p className="mt-3 text-sm text-amber-300">The message board needs the Firestore store.</p>
        )}

        <div className="mt-4 overflow-hidden rounded-lg border border-slate-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-900 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">From</th>
                <th className="px-3 py-2 font-medium">To</th>
                <th className="px-3 py-2 font-medium">Command</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Outcome</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                    {activity.deviceCommands.length ? 'Nothing to show with this filter.' : 'No commands yet.'}
                  </td>
                </tr>
              )}
              {rows.map((c) => {
                const expanded = open === c.uid;
                const hasDetail = !!(c.output || c.note);
                return (
                  <tr
                    key={c.uid}
                    className={`align-top ${hasDetail ? 'cursor-pointer hover:bg-slate-900/60' : ''}`}
                    onClick={() => hasDetail && setOpen(expanded ? null : c.uid)}
                  >
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-400" title={c.createdAt}>
                      {when(c.createdAt)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-xs text-slate-200">{c.from?.by ?? '?'}</span>
                        <DeviceChip deviceId={c.from?.deviceId} shrink />
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <DeviceChip deviceId={c.to} always shrink />
                    </td>
                    <td className="px-3 py-2">
                      <span className="font-mono text-xs text-slate-100">{c.command}</span>
                      {argOf(c) && <span className="ml-1.5 break-all font-mono text-xs text-slate-400">{argOf(c)}</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span className={`rounded border px-1.5 py-0.5 text-[11px] ${STATUS_STYLE[c.status] ?? STATUS_STYLE.queued}`}>{c.status}</span>
                      {took(c) && <span className="ml-1.5 text-[11px] text-slate-500">{took(c)}</span>}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-300">
                      <div className="break-words">{c.message ?? (c.status === 'queued' ? 'waiting for that device' : '')}</div>
                      {hasDetail && !expanded && <div className="mt-0.5 text-[11px] text-slate-500">details ▸</div>}
                      {expanded && (
                        <div className="mt-2 space-y-2">
                          {c.note && <div className="text-slate-400">why: {c.note}</div>}
                          {c.output && (
                            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded border border-slate-800 bg-slate-950 p-2 font-mono text-[11px] text-slate-400">
                              {c.output}
                            </pre>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
