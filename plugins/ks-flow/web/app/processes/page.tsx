'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

interface ProcInfo {
  name: string;
  pid: number;
  startedAt: string | null;
  startedAtRaw: string;
  port: number | null;
  command: string;
}

function fmtStarted(p: ProcInfo): string {
  if (!p.startedAt) return p.startedAtRaw;
  try {
    return new Date(p.startedAt).toLocaleString();
  } catch {
    return p.startedAtRaw;
  }
}

export default function ProcessesPage() {
  const [procs, setProcs] = useState<ProcInfo[]>([]);
  const [daemonCount, setDaemonCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [killing, setKilling] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const r = await fetch('/api/processes', { cache: 'no-store' });
      const d: { processes?: ProcInfo[]; daemonCount?: number; error?: string } = await r.json();
      setProcs(Array.isArray(d.processes) ? d.processes : []);
      setDaemonCount(d.daemonCount ?? 0);
      setErr(d.error ?? null);
    } catch {
      setErr('Could not read processes.');
    }
    setLoading(false);
  }, []);

  const kill = useCallback(
    async (pid: number): Promise<void> => {
      if (!window.confirm(`Kill ks-flow daemon (pid ${pid})?`)) return;
      setKilling(pid);
      setErr(null);
      try {
        const r = await fetch('/api/processes', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pid }),
        });
        const d: { ok?: boolean; error?: string } = await r.json();
        if (!d.ok) setErr(d.error ?? 'kill failed');
      } catch {
        setErr('kill failed');
      }
      setKilling(null);
      await load();
    },
    [load],
  );

  // With duplicates, keep the most-recently-started daemon and offer to kill the
  // older ones (a stray manual daemon is invariably the older PID).
  const daemons = procs.filter((p) => p.name === 'ks-flow daemon');
  const keeperPid =
    daemons.length > 1
      ? daemons.reduce((newest, p) => {
          const tp = p.startedAt ? Date.parse(p.startedAt) : -Infinity;
          const tn = newest.startedAt ? Date.parse(newest.startedAt) : -Infinity;
          return tp > tn ? p : newest;
        }).pid
      : null;

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000); // light auto-refresh
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
        <h1 className="text-lg font-bold">ks-flow · processes</h1>
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="text-xs text-slate-400 hover:text-slate-200 disabled:opacity-50"
          >
            {loading ? 'refreshing…' : '↻ refresh'}
          </button>
          <Link href="/" className="text-xs text-indigo-400 hover:text-indigo-300">
            ← back to board
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-5 py-8">
        <p className="text-xs text-slate-400">
          ks-flow-related processes running on this machine. If more than one{' '}
          <span className="text-slate-300">ks-flow daemon</span> appears, a stray instance is
          running (notifications fire twice) — use the <span className="text-slate-300">Kill</span>{' '}
          button on the older one.
        </p>

        {daemonCount > 1 && (
          <div className="mt-3 rounded border border-amber-900 bg-amber-950/50 px-3 py-2 text-sm text-amber-200">
            ⚠ {daemonCount} ks-flow daemons running — expected 1. Kill the older one(s); the
            newest (kept) is the live daemon.
          </div>
        )}

        {err && <p className="mt-3 text-sm text-rose-400">{err}</p>}

        <div className="mt-4 overflow-hidden rounded-lg border border-slate-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-900 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-2 font-medium">Process</th>
                <th className="px-4 py-2 font-medium">PID</th>
                <th className="px-4 py-2 font-medium">Started</th>
                <th className="px-4 py-2 font-medium">Port</th>
                <th className="px-4 py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {procs.length === 0 && !loading && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                    No ks-flow processes found.
                  </td>
                </tr>
              )}
              {procs.map((p) => {
                const dup = p.name === 'ks-flow daemon' && daemonCount > 1;
                const killable = dup && p.pid !== keeperPid;
                return (
                  <tr key={p.pid} className={killable ? 'bg-amber-950/30' : ''}>
                    <td className="px-4 py-2 text-slate-200" title={p.command}>
                      {p.name}
                      {dup && p.pid === keeperPid && (
                        <span className="ml-2 text-[10px] uppercase tracking-wide text-emerald-400">
                          kept
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 font-mono text-slate-300">{p.pid}</td>
                    <td className="px-4 py-2 text-slate-400">{fmtStarted(p)}</td>
                    <td className="px-4 py-2 font-mono text-slate-300">{p.port ?? '—'}</td>
                    <td className="px-4 py-2 text-right">
                      {killable && (
                        <button
                          type="button"
                          onClick={() => void kill(p.pid)}
                          disabled={killing === p.pid}
                          className="rounded border border-rose-800 bg-rose-950/50 px-2 py-1 text-xs text-rose-300 hover:bg-rose-900/60 disabled:opacity-50"
                        >
                          {killing === p.pid ? 'killing…' : 'Kill'}
                        </button>
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
