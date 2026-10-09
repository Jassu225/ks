'use client';

// /backups — every transcript backup sweep this machine ran: the daemon's daily
// one, the board's buttons, a worktree removal. A table of runs; a run opens a
// dialog with everything it uploaded.

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { SeeLogs, useStreams } from '@/components/StreamPanel';
import { backupRunKey } from '@/lib/backupStreams';

interface RunUpload {
  path: string;
  kind: 'session' | 'workflow' | 'time-log';
  /** Uncompressed bytes. */
  size: number;
  /** Bytes uploaded (zstd); absent on runs recorded before it was kept. */
  compressedSize?: number;
}

interface RunUnit {
  identifier: string;
  uploads: RunUpload[];
  errors: string[];
}

interface BackupRun {
  uid: string;
  startedAt: string;
  endedAt?: string;
  trigger: 'daily' | 'manual' | 'unit' | 'removal' | 'completed';
  scope: string;
  status: 'running' | 'interrupted' | 'ok' | 'partial' | 'failed';
  error?: string;
  unitsChecked?: number;
  unitsCurrent?: number;
  uploadedCount?: number;
  errorCount?: number;
  bytesSource?: number;
  bytesUploaded?: number;
  units?: RunUnit[];
}

const TRIGGER_LABELS: Record<BackupRun['trigger'], string> = {
  daily: 'Daily',
  manual: 'Back up now',
  unit: 'Card backup',
  removal: 'Worktree removal',
  completed: 'Completed units',
};

const STATUS_STYLES: Record<BackupRun['status'], { label: string; className: string }> = {
  ok: { label: 'OK', className: 'border-emerald-800 bg-emerald-950/50 text-emerald-300' },
  partial: { label: 'Partial', className: 'border-amber-800 bg-amber-950/50 text-amber-300' },
  failed: { label: 'Failed', className: 'border-rose-800 bg-rose-950/50 text-rose-300' },
  running: { label: 'Running', className: 'border-sky-800 bg-sky-950/50 text-sky-300' },
  interrupted: { label: 'Interrupted', className: 'border-slate-700 bg-slate-900 text-slate-400' },
};

const KIND_LABELS: Record<RunUpload['kind'], string> = {
  session: 'session',
  workflow: 'workflow',
  'time-log': 'time log',
};

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function fmtDuration(run: BackupRun): string {
  if (!run.endedAt) return '—';
  const s = Math.max(0, Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function uploads(run: BackupRun): RunUpload[] {
  return (run.units ?? []).flatMap((u) => u.uploads);
}

/** Uncompressed bytes of what the run uploaded. */
function sourceBytes(run: BackupRun): number {
  return run.bytesSource ?? uploads(run).reduce((n, f) => n + f.size, 0);
}

/** Compressed bytes actually uploaded; null for a run recorded before that was kept. */
function uploadedBytes(run: BackupRun): number | null {
  if (run.bytesUploaded !== undefined) return run.bytesUploaded;
  const files = uploads(run);
  return files.length > 0 && files.every((f) => f.compressedSize !== undefined)
    ? files.reduce((n, f) => n + (f.compressedSize ?? 0), 0)
    : files.length === 0
      ? 0
      : null;
}

function fmtMaybe(n: number | null): string {
  return n === null ? '—' : fmtBytes(n);
}

function StatusBadge({ status }: { status: BackupRun['status'] }) {
  const s = STATUS_STYLES[status];
  return <span className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${s.className}`}>{s.label}</span>;
}

function RunDialog({ run, onClose }: { run: BackupRun; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const units = run.units ?? [];
  return (
    <div
      className="fixed inset-0 z-20 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-12"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Backup run details"
        className="w-full max-w-2xl rounded-lg border border-slate-800 bg-slate-950 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-slate-800 px-5 py-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold">{fmtWhen(run.startedAt)}</h2>
              <StatusBadge status={run.status} />
              <SeeLogs streamKey={backupRunKey(run.uid)} />
            </div>
            <p className="mt-1 text-xs text-slate-400">
              {TRIGGER_LABELS[run.trigger] ?? run.trigger} · {run.scope}
              {run.endedAt && ` · took ${fmtDuration(run)}`}
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-200" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="space-y-4 px-5 py-4 text-sm">
          {run.error && (
            <pre className="whitespace-pre-wrap rounded border border-rose-900 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
              {run.error}
            </pre>
          )}
          {run.status === 'running' && <p className="text-slate-400">Still running — reopen in a moment.</p>}
          {run.status === 'interrupted' && (
            <p className="text-slate-400">This run stopped before it finished (the process exited or the Mac slept), so what it uploaded was not recorded.</p>
          )}

          {run.endedAt && (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-xs sm:grid-cols-3">
              <div>
                <dt className="text-slate-500">Units checked</dt>
                <dd className="text-slate-200">{run.unitsChecked ?? 0}</dd>
                <dd className="text-[11px] text-slate-500">tickets the run looked at</dd>
              </div>
              <div>
                <dt className="text-slate-500">Already current</dt>
                <dd className="text-slate-200">{run.unitsCurrent ?? 0}</dd>
                <dd className="text-[11px] text-slate-500">nothing changed since their last backup</dd>
              </div>
              <div>
                <dt className="text-slate-500">Errors</dt>
                <dd className={run.errorCount ? 'text-rose-300' : 'text-slate-200'}>{run.errorCount ?? 0}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Files uploaded</dt>
                <dd className="text-slate-200">{run.uploadedCount ?? 0}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Uncompressed</dt>
                <dd className="text-slate-200">{fmtBytes(sourceBytes(run))}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Uploaded (compressed)</dt>
                <dd className="text-slate-200">{fmtMaybe(uploadedBytes(run))}</dd>
              </div>
            </dl>
          )}

          {run.endedAt && units.length === 0 && !run.error && (
            <p className="text-slate-400">Nothing to upload — every unit was already backed up.</p>
          )}

          {units.map((u) => (
            <section key={u.identifier} className="rounded border border-slate-800">
              <h3 className="border-b border-slate-800 bg-slate-900 px-3 py-1.5 font-mono text-xs text-slate-200">{u.identifier}</h3>
              <ul className="divide-y divide-slate-900">
                {u.uploads.map((f) => (
                  <li key={f.path} className="flex items-center gap-3 px-3 py-1.5 text-xs">
                    <span className="w-16 shrink-0 text-slate-500">{KIND_LABELS[f.kind] ?? f.kind}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-slate-300" title={f.path}>
                      {f.path}
                    </span>
                    <span className="shrink-0 text-slate-400" title="uncompressed → uploaded (compressed)">
                      {fmtBytes(f.size)}
                      {f.compressedSize !== undefined && <span className="text-slate-500"> → {fmtBytes(f.compressedSize)}</span>}
                    </span>
                  </li>
                ))}
                {u.errors.map((e) => (
                  <li key={e} className="px-3 py-1.5 text-xs text-rose-300">
                    ✕ {e}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function BackupsPage() {
  const [runs, setRuns] = useState<BackupRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const r = await fetch('/api/backup-runs', { cache: 'no-store' });
      const d: { runs?: BackupRun[]; error?: string } = await r.json();
      setRuns(Array.isArray(d.runs) ? d.runs : []);
      setErr(d.error ?? null);
    } catch {
      setErr('Could not read the backup history.');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  // A backup started from the board (still streaming here after a page change)
  // just finished: show its outcome now, not at the next poll.
  const isBackingUp = useStreams().anyRunning('backup:');
  useEffect(() => {
    if (!isBackingUp) void load();
  }, [isBackingUp, load]);

  const open = runs.find((r) => r.uid === openId) ?? null;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-800 bg-slate-950 px-5 py-3">
        <h1 className="text-lg font-bold">ks-flow · backups</h1>
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

      <main className="mx-auto max-w-screen-2xl px-5 py-8">
        <p className="text-xs text-slate-400">
          Transcript backups to GCS: the daemon&apos;s once-a-day sweep, the board&apos;s backup buttons and worktree removals.
          Each run uploads whatever changed since the last one — session files, the unit&apos;s workflow and its time log. Click a
          run for what it uploaded.
        </p>

        {err && <p className="mt-3 text-sm text-rose-400">{err}</p>}

        {/* Cells never wrap; a window too narrow for the table scrolls it sideways instead. */}
        <div className="mt-4 overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full whitespace-nowrap text-left text-sm">
            <thead className="bg-slate-900 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-2 font-medium">Started</th>
                <th className="px-4 py-2 font-medium">Trigger</th>
                <th className="px-4 py-2 font-medium">Scope</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Duration</th>
                <th className="px-4 py-2 text-right font-medium">Uploaded</th>
                <th className="px-4 py-2 text-right font-medium">Uncompressed</th>
                <th className="px-4 py-2 text-right font-medium">Compressed</th>
                <th className="px-4 py-2 text-right font-medium">Errors</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {runs.length === 0 && !loading && (
                <tr>
                  <td colSpan={9} className="px-4 py-6 text-center text-slate-500">
                    No backup runs recorded yet. The daemon&apos;s next daily sweep will be the first.
                  </td>
                </tr>
              )}
              {runs.map((run) => {
                const units = (run.units ?? []).filter((u) => u.uploads.length > 0).length;
                return (
                  <tr
                    key={run.uid}
                    onClick={() => setOpenId(run.uid)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') setOpenId(run.uid);
                    }}
                    tabIndex={0}
                    className="cursor-pointer hover:bg-slate-900/60 focus:bg-slate-900/60 focus:outline-none"
                  >
                    <td className="px-4 py-2 text-slate-200">{fmtWhen(run.startedAt)}</td>
                    <td className="px-4 py-2 text-slate-400">{TRIGGER_LABELS[run.trigger] ?? run.trigger}</td>
                    <td className="max-w-[20rem] truncate px-4 py-2 text-slate-400" title={run.scope}>
                      {run.scope}
                    </td>
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center gap-1">
                        <StatusBadge status={run.status} />
                        {/* A run this board started still has its live log. */}
                        <SeeLogs streamKey={backupRunKey(run.uid)} />
                      </span>
                    </td>
                    <td className="px-4 py-2 text-slate-400">{fmtDuration(run)}</td>
                    <td className="px-4 py-2 text-right text-slate-300">
                      {run.endedAt ? (
                        <>
                          {run.uploadedCount ?? 0} file{run.uploadedCount === 1 ? '' : 's'}
                          <span className="text-slate-500">
                            {' '}
                            · {units} unit{units === 1 ? '' : 's'}
                          </span>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-2 text-right text-slate-300">{run.endedAt ? fmtBytes(sourceBytes(run)) : '—'}</td>
                    <td className="px-4 py-2 text-right text-slate-300">{run.endedAt ? fmtMaybe(uploadedBytes(run)) : '—'}</td>
                    <td className={`px-4 py-2 text-right ${run.errorCount ? 'text-rose-300' : 'text-slate-500'}`}>
                      {run.endedAt ? (run.errorCount ?? 0) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </main>

      {open && <RunDialog run={open} onClose={() => setOpenId(null)} />}
    </div>
  );
}
