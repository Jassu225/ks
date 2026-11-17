'use client';
// /errors — this device's ks-flow problems (GET /api/errors; the daemon's
// errors.json): store listeners that stopped and jobs that keep failing. Open
// ones first, with when they started, how often they failed and when the daemon
// tries again; then the ones resolved in the last 7 days. The header's ⚠ links
// here and lights up while any is open.

import { useCallback, useEffect, useState } from 'react';
import { AppHeader } from '@/components/AppHeader';
import { RefreshIcon } from '@/components/icons';

interface ErrorEntry {
  key: string;
  title: string;
  message: string;
  firstAt: string;
  lastAt: string;
  count: number;
  resolvedAt: string | null;
  retryAt?: string | null;
}

function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function kindOf(key: string): string {
  if (key.startsWith('listener:')) return 'store listener';
  if (key.startsWith('job:')) return 'daemon job';
  return 'other';
}

export default function ErrorsPage() {
  const [entries, setEntries] = useState<ErrorEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const r = await fetch('/api/errors', { cache: 'no-store' });
      const d: { entries?: ErrorEntry[] } = await r.json();
      setEntries(Array.isArray(d.entries) ? d.entries : []);
      setErr(null);
    } catch {
      setErr('Could not read the errors.');
    }
    setLoading(false);
  }, []);

  // Read on open and on refresh: a local file, and the header's ⚠ already
  // follows the open count (every 30 s).
  useEffect(() => {
    void load();
  }, [load]);

  const open = entries.filter((e) => !e.resolvedAt);
  const resolved = entries.filter((e) => e.resolvedAt);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <AppHeader
        toolbar={
          <>
            <h1 className="text-sm font-semibold text-slate-200">Errors</h1>
            <div className="grow" />
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="inline-flex items-center gap-1 text-slate-400 hover:text-slate-200 disabled:opacity-50"
            >
              <RefreshIcon size={14} className={loading ? 'animate-spin' : ''} />
              {loading ? 'refreshing…' : 'refresh'}
            </button>
          </>
        }
      />

      <main className="mx-auto max-w-4xl px-5 py-8">
        <p className="text-xs text-slate-400">
          Problems ks-flow ran into on <span className="text-slate-300">this device</span>: a store listener that
          stopped (the daemon attaches it again on its own, waiting longer after each failure) or a job that keeps
          failing. Each one also sent a macOS notice when it started and when it worked again. Resolved ones stay
          here for 7 days.
        </p>

        {err && <p className="mt-3 text-sm text-rose-400">{err}</p>}

        <h2 className="mt-6 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Open {open.length > 0 && <span className="text-red-300">({open.length})</span>}
        </h2>
        {open.length === 0 && !loading && <p className="mt-2 text-sm text-emerald-300">Nothing is failing right now.</p>}
        <ul className="mt-2 space-y-2">
          {open.map((e) => (
            <li key={`${e.key}-${e.firstAt}`} className="rounded-lg border border-red-900/70 bg-[#1a0b10] px-4 py-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-semibold text-red-200">{e.title}</span>
                <span className="text-[11px] uppercase tracking-wide text-slate-500">{kindOf(e.key)}</span>
                <div className="grow" />
                <span className="text-xs text-slate-400">
                  {e.count} failure{e.count === 1 ? '' : 's'} since {when(e.firstAt)}
                </span>
              </div>
              <p className="mt-1.5 break-words font-mono text-xs text-slate-300">{e.message}</p>
              <p className="mt-1 text-xs text-slate-500">
                last {when(e.lastAt)}
                {e.retryAt ? ` · tried again at ${when(e.retryAt)}` : ''}
              </p>
            </li>
          ))}
        </ul>

        {resolved.length > 0 && (
          <>
            <h2 className="mt-8 text-xs font-semibold uppercase tracking-wide text-slate-400">Resolved (last 7 days)</h2>
            <ul className="mt-2 divide-y divide-slate-800 rounded-lg border border-slate-800">
              {resolved.map((e) => (
                <li key={`${e.key}-${e.firstAt}`} className="px-4 py-2.5 text-sm">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="text-slate-200">{e.title}</span>
                    <span className="text-[11px] uppercase tracking-wide text-slate-500">{kindOf(e.key)}</span>
                    <div className="grow" />
                    <span className="text-xs text-slate-500">
                      {e.count} failure{e.count === 1 ? '' : 's'} · {when(e.firstAt)} → fixed {when(e.resolvedAt)}
                    </span>
                  </div>
                  <p className="mt-1 break-words font-mono text-xs text-slate-500">{e.message}</p>
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
    </div>
  );
}
