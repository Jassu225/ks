'use client';
// /activity — the Activity Log: one history of everything ks-flow and the
// master session do in the background, newest first, each row with its type
// (lib/activity.ts):
//   Backup    transcript backup sweeps (the daemon's daily one, the board's
//             buttons, worktree removals) — a row opens what it uploaded
//   Briefing  the master's passes over Slack (scheduled, Brief me, by hand)
//   Log-in / Log-off  the master's /ks-master:log-in and log-off runs
//   Master    the daemon starting / hard-restarting the master, and requests
//             sent to it (schedule, Brief me now, Restart master)
// Filter chips narrow it by type (?type=backup|briefing|log|master). Briefing
// runs and master events are live through the shared provider; backup runs
// come from /api/backup-runs (their running/interrupted status is checked on
// the server), re-read whenever backup_runs changes.
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppHeader } from '@/components/AppHeader';
import { localDate } from '@/components/briefing/format';
import { RefreshIcon } from '@/components/icons';
import { SeeLogs, useStreams } from '@/components/StreamPanel';
import {
  activityRows,
  briefingTriggerLabel,
  FILTERS,
  isFilter,
  masterEventLabel,
  matches,
  rowStatus,
  type ActivityFilter,
  type ActivityRow,
  type ActivityType,
  type BackupRun,
  type BriefingRow,
  type RowStatus,
  type RunUpload,
} from '@/lib/activity';
import { backupRunKey } from '@/lib/backupStreams';
import { useShared } from '@/lib/boardData';
import type { BriefingRunDoc, MasterEventDoc } from '@/lib/types';

// ── formatting ──────────────────────────────────────────────────────────────

const BACKUP_TRIGGER: Record<BackupRun['trigger'], string> = {
  daily: 'Daily',
  manual: 'Back up now',
  unit: 'Card backup',
  removal: 'Worktree removal',
  completed: 'Completed units',
};

const STATUS: Record<RowStatus, { label: string; className: string }> = {
  ok: { label: 'OK', className: 'border-emerald-800 bg-emerald-950/50 text-emerald-300' },
  partial: { label: 'Partial', className: 'border-amber-800 bg-amber-950/50 text-amber-300' },
  failed: { label: 'Failed', className: 'border-rose-800 bg-rose-950/50 text-rose-300' },
  running: { label: 'Running', className: 'border-sky-800 bg-sky-950/50 text-sky-300' },
  interrupted: { label: 'Interrupted', className: 'border-slate-700 bg-slate-900 text-slate-400' },
  dropped: { label: 'Dropped', className: 'border-slate-700 bg-slate-900 text-slate-400' },
  unknown: { label: 'No result', className: 'border-slate-700 bg-slate-900 text-slate-400' },
};

const TYPE: Record<ActivityType, { label: string; className: string }> = {
  backup: { label: 'Backup', className: 'border-sky-900 bg-sky-950/60 text-sky-300' },
  briefing: { label: 'Briefing', className: 'border-indigo-800 bg-indigo-950/60 text-indigo-200' },
  'log-in': { label: 'Log-in', className: 'border-emerald-900 bg-emerald-950/50 text-emerald-300' },
  'log-off': { label: 'Log-off', className: 'border-teal-900 bg-teal-950/50 text-teal-300' },
  master: { label: 'Master', className: 'border-amber-900 bg-amber-950/40 text-amber-300' },
};

const KIND_LABELS: Record<RunUpload['kind'], string> = {
  session: 'session',
  workflow: 'workflow',
  'time-log': 'time log',
};

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function fmtSpan(start: string, end: string | null | undefined): string {
  if (!end) return '—';
  const s = Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000));
  if (!Number.isFinite(s)) return '—';
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

const fmtMaybe = (n: number | null): string => (n === null ? '—' : fmtBytes(n));
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

function StatusBadge({ status }: { status: RowStatus }) {
  const s = STATUS[status];
  return <span className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${s.className}`}>{s.label}</span>;
}

function TypeChip({ type }: { type: ActivityType }) {
  const t = TYPE[type];
  return <span className={`rounded-full border px-2 py-px text-[11px] font-medium ${t.className}`}>{t.label}</span>;
}

// ── row cells ───────────────────────────────────────────────────────────────

function whatOf(row: ActivityRow): string {
  if (row.type === 'backup') return BACKUP_TRIGGER[row.run.trigger] ?? row.run.trigger;
  if (row.type === 'master') return `${masterEventLabel(row.event)} · by ${row.event.by}`;
  return briefingTriggerLabel(row.run);
}

function durationOf(row: ActivityRow): string {
  if (row.type === 'backup') return fmtSpan(row.run.startedAt, row.run.endedAt);
  if (row.type === 'master') return '—';
  return fmtSpan(row.run.startedAt, row.run.endedAt);
}

function BackupDetails({ run }: { run: BackupRun }) {
  const units = (run.units ?? []).filter((u) => u.uploads.length > 0).length;
  return (
    <span className="text-slate-400">
      <span className="text-slate-300" title={run.scope}>
        {run.scope}
      </span>
      {run.endedAt && (
        <>
          {' · '}
          {plural(run.uploadedCount ?? 0, 'file')} · {plural(units, 'unit')}
          {' · '}
          <span title="uncompressed → uploaded (compressed)">
            {fmtBytes(sourceBytes(run))} → {fmtMaybe(uploadedBytes(run))}
          </span>
          {' · '}
          <span className={run.errorCount ? 'text-rose-300' : ''}>{plural(run.errorCount ?? 0, 'error')}</span>
        </>
      )}
    </span>
  );
}

function BriefingDetails({ run }: { run: BriefingRunDoc }) {
  return (
    <span className="text-slate-400">
      {run.status !== 'running' && (
        <>
          <span className="text-slate-300">+{run.added ?? 0} added</span> · {run.updated ?? 0} updated
        </>
      )}
      {run.slackCursor && <> · Slack read to {fmtWhen(run.slackCursor)}</>}
      {run.error ? (
        <span className="text-rose-300"> · {run.error}</span>
      ) : (
        run.summary && <span className="text-slate-500"> · {run.summary}</span>
      )}
    </span>
  );
}

function MasterDetails({ event }: { event: MasterEventDoc }) {
  return (
    <span className="text-slate-400">
      <span className="text-slate-300">{event.reason}</span>
      {event.detail && (
        <span className={event.result === 'failed' ? 'text-rose-300' : 'text-slate-500'}> · {event.detail}</span>
      )}
    </span>
  );
}

function Details({ row }: { row: ActivityRow }) {
  if (row.type === 'backup') return <BackupDetails run={row.run} />;
  if (row.type === 'master') return <MasterDetails event={row.event} />;
  return <BriefingDetails run={row.run} />;
}

// ── dialogs ─────────────────────────────────────────────────────────────────

function Dialog({
  label,
  title,
  sub,
  onClose,
  children,
}: {
  label: string;
  title: ReactNode;
  sub: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-12"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="w-full max-w-2xl rounded-lg border border-slate-800 bg-slate-950 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-slate-800 px-5 py-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">{title}</div>
            <p className="mt-1 text-xs text-slate-400">{sub}</p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-200" aria-label="Close">
            ✕
          </button>
        </div>
        <div className="space-y-4 px-5 py-4 text-sm">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, children, note }: { label: string; children: ReactNode; note?: string }) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-slate-200">{children}</dd>
      {note && <dd className="text-[11px] text-slate-500">{note}</dd>}
    </div>
  );
}

function ErrorBox({ text }: { text: string }) {
  return (
    <pre className="whitespace-pre-wrap rounded border border-rose-900 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
      {text}
    </pre>
  );
}

function BackupDialog({ run, onClose }: { run: BackupRun; onClose: () => void }) {
  const units = run.units ?? [];
  return (
    <Dialog
      label="Backup run details"
      onClose={onClose}
      title={
        <>
          <TypeChip type="backup" />
          <h2 className="text-base font-semibold">{fmtWhen(run.startedAt)}</h2>
          <StatusBadge status={run.status} />
          <SeeLogs streamKey={backupRunKey(run.uid)} />
        </>
      }
      sub={
        <>
          {BACKUP_TRIGGER[run.trigger] ?? run.trigger} · {run.scope}
          {run.endedAt && ` · took ${fmtSpan(run.startedAt, run.endedAt)}`}
        </>
      }
    >
      {run.error && <ErrorBox text={run.error} />}
      {run.status === 'running' && <p className="text-slate-400">Still running — reopen in a moment.</p>}
      {run.status === 'interrupted' && (
        <p className="text-slate-400">
          This run stopped before it finished (the process exited or the Mac slept), so what it uploaded was not recorded.
        </p>
      )}

      {run.endedAt && (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-xs sm:grid-cols-3">
          <Field label="Units checked" note="tickets the run looked at">
            {run.unitsChecked ?? 0}
          </Field>
          <Field label="Already current" note="nothing changed since their last backup">
            {run.unitsCurrent ?? 0}
          </Field>
          <Field label="Errors">
            <span className={run.errorCount ? 'text-rose-300' : ''}>{run.errorCount ?? 0}</span>
          </Field>
          <Field label="Files uploaded">{run.uploadedCount ?? 0}</Field>
          <Field label="Uncompressed">{fmtBytes(sourceBytes(run))}</Field>
          <Field label="Uploaded (compressed)">{fmtMaybe(uploadedBytes(run))}</Field>
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
    </Dialog>
  );
}

function BriefingDialog({ row, status, onClose }: { row: BriefingRow; status: RowStatus; onClose: () => void }) {
  const run = row.run;
  const day = localDate(run.startedAt);
  return (
    <Dialog
      label="Briefing run details"
      onClose={onClose}
      title={
        <>
          <TypeChip type={row.type} />
          <h2 className="text-base font-semibold">{fmtWhen(run.startedAt)}</h2>
          <StatusBadge status={status} />
        </>
      }
      sub={
        <>
          {briefingTriggerLabel(run)}
          {run.endedAt && ` · took ${fmtSpan(run.startedAt, run.endedAt)}`}
        </>
      }
    >
      {run.error && <ErrorBox text={run.error} />}
      {status === 'running' && <p className="text-slate-400">The master is still on this run.</p>}
      {status === 'interrupted' && (
        <p className="text-slate-400">This run never finished: the master stopped (or was restarted) before `run finish`.</p>
      )}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-xs sm:grid-cols-3">
        <Field label="Items added">{run.added ?? 0}</Field>
        <Field label="Items updated">{run.updated ?? 0}</Field>
        <Field label="Slack read up to" note="the next run starts here">
          {fmtWhen(run.slackCursor)}
        </Field>
        <Field label="Started">{fmtWhen(run.startedAt)}</Field>
        <Field label="Ended">{fmtWhen(run.endedAt)}</Field>
        <Field label="Run id">
          <span className="font-mono text-[11px] text-slate-400">{run.uid}</span>
        </Field>
      </dl>
      {run.summary && (
        <section>
          <h3 className="mb-1 text-xs text-slate-500">The master&apos;s summary</h3>
          <p className="whitespace-pre-wrap rounded border border-slate-800 bg-slate-900 px-3 py-2 text-[13px] text-slate-200">
            {run.summary}
          </p>
        </section>
      )}
      <p className="flex flex-wrap gap-4 text-xs">
        {row.type === 'briefing' ? (
          <Link href="/briefing" className="text-indigo-300 hover:text-indigo-200">
            Open the Briefing →
          </Link>
        ) : (
          <Link href={`/daily?date=${day}`} className="text-indigo-300 hover:text-indigo-200">
            Open the daily log for {day} →
          </Link>
        )}
      </p>
    </Dialog>
  );
}

function MasterDialog({ event, status, onClose }: { event: MasterEventDoc; status: RowStatus; onClose: () => void }) {
  return (
    <Dialog
      label="Master event details"
      onClose={onClose}
      title={
        <>
          <TypeChip type="master" />
          <h2 className="text-base font-semibold">{fmtWhen(event.at)}</h2>
          <StatusBadge status={status} />
        </>
      }
      sub={`${masterEventLabel(event)} · by the ${event.by}`}
    >
      {event.result === 'failed' && event.detail && <ErrorBox text={event.detail} />}
      {status === 'running' && <p className="text-slate-400">The command is still running; its result arrives when it exits.</p>}
      {status === 'unknown' && (
        <p className="text-slate-400">No result recorded: the daemon stopped before the command exited. See master/launch.log.</p>
      )}
      <dl className="grid grid-cols-1 gap-y-3 text-xs sm:grid-cols-2 sm:gap-x-6">
        <Field label="Why">{event.reason}</Field>
        {event.detail && event.result !== 'failed' && <Field label="Detail">{event.detail}</Field>}
        {event.trigger && <Field label="Request trigger">{event.trigger}</Field>}
        {event.slot && <Field label="Slot">{event.slot}</Field>}
      </dl>
      {event.result === 'dropped' && (
        <p className="text-xs text-slate-400">
          One request of this kind was already waiting for the master, so no second one was written.
        </p>
      )}
    </Dialog>
  );
}

// ── page ────────────────────────────────────────────────────────────────────

export function ActivityPage() {
  const { briefing, activity, now } = useShared();
  const router = useRouter();
  const pathname = usePathname() ?? '/activity';
  const params = useSearchParams();
  const typeParam = params?.get('type');
  const filter: ActivityFilter = isFilter(typeParam) ? typeParam : 'all';
  const setFilter = (f: ActivityFilter): void => {
    router.replace(f === 'all' ? pathname : `${pathname}?type=${f}`, { scroll: false });
  };

  const [backups, setBackups] = useState<BackupRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const loadBackups = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const r = await fetch('/api/backup-runs', { cache: 'no-store' });
      const d: { runs?: BackupRun[]; error?: string } = await r.json();
      setBackups(Array.isArray(d.runs) ? d.runs : []);
      setErr(d.error ?? null);
    } catch {
      setErr('Could not read the backup history.');
    }
    setLoading(false);
  }, []);

  // Poll too: a run whose process died turns from running to interrupted
  // without any write to backup_runs.
  useEffect(() => {
    void loadBackups();
    const t = setInterval(() => void loadBackups(), 30_000);
    return () => clearInterval(t);
  }, [loadBackups]);

  // backup_runs changed (a run started, or finished): re-read now. A sweep
  // writes its start and end only, so this stays a handful of reads per run.
  const { backupRunsVersion } = activity;
  useEffect(() => {
    if (backupRunsVersion === 0) return;
    const t = setTimeout(() => void loadBackups(), 400);
    return () => clearTimeout(t);
  }, [backupRunsVersion, loadBackups]);

  // A backup started from the board (still streaming here after a page change)
  // just finished: show its outcome now.
  const isBackingUp = useStreams().anyRunning('backup:');
  useEffect(() => {
    if (!isBackingUp) void loadBackups();
  }, [isBackingUp, loadBackups]);

  const refreshAll = (): void => {
    void loadBackups();
    void briefing.refresh();
    void activity.refresh();
  };

  const rows = useMemo(
    () => activityRows(backups, briefing.runs, activity.masterEvents),
    [backups, briefing.runs, activity.masterEvents],
  );
  const counts = useMemo(() => {
    const c = {} as Record<ActivityFilter, number>;
    for (const f of FILTERS) c[f.id] = rows.filter((r) => matches(r, f.id)).length;
    return c;
  }, [rows]);
  const shown = rows.filter((r) => matches(r, filter));
  const open = rows.find((r) => r.key === openKey) ?? null;
  const stillLoading = loading && rows.length === 0;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <AppHeader
        toolbar={
          <>
            <h1 className="text-sm font-semibold text-slate-200">Activity Log</h1>
            <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by type">
              {FILTERS.map((f) => {
                const on = f.id === filter;
                return (
                  <button
                    key={f.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setFilter(f.id)}
                    className={`rounded-full border px-2.5 py-0.5 ${
                      on
                        ? 'border-indigo-700 bg-indigo-950 text-indigo-200'
                        : 'border-slate-700 text-slate-400 hover:border-slate-600 hover:text-slate-200'
                    }`}
                  >
                    {f.label}
                    <span className={on ? 'ml-1 text-indigo-300/80' : 'ml-1 text-slate-500'}>{counts[f.id]}</span>
                  </button>
                );
              })}
            </div>
            <div className="grow" />
            <button
              type="button"
              onClick={refreshAll}
              disabled={loading}
              className="inline-flex items-center gap-1 text-slate-400 hover:text-slate-200 disabled:opacity-50"
            >
              <RefreshIcon size={14} className={loading ? 'animate-spin' : ''} />
              {loading ? 'refreshing…' : 'refresh'}
            </button>
          </>
        }
      />

      <main className="mx-auto max-w-screen-2xl px-5 py-8">
        <p className="text-xs text-slate-400">
          Everything ks-flow and the master session do in the background. <b className="text-slate-300">Backup</b>:
          transcript backups to GCS (the daemon&apos;s daily sweep, the board&apos;s backup buttons, worktree removals).{' '}
          <b className="text-slate-300">Briefing</b>: the master&apos;s passes over Slack.{' '}
          <b className="text-slate-300">Log-in / Log-off</b>: the master&apos;s start- and end-of-day runs.{' '}
          <b className="text-slate-300">Master</b>: the daemon starting or restarting the master, and requests sent to it.
          Click a row for its details.
        </p>

        {err && <p className="mt-3 text-sm text-rose-400">{err}</p>}

        {/* Cells never wrap (but Details); a window too narrow scrolls the table sideways. */}
        <div className="mt-4 overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-900 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="whitespace-nowrap px-4 py-2 font-medium">Started</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Trigger</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Duration</th>
                <th className="px-4 py-2 font-medium">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {shown.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                    {stillLoading
                      ? 'Loading…'
                      : filter === 'all'
                        ? 'Nothing recorded yet. The daemon’s next backup sweep or briefing slot will be the first.'
                        : 'Nothing of this type recorded yet.'}
                  </td>
                </tr>
              )}
              {shown.map((row) => {
                const status = rowStatus(row, now);
                return (
                  <tr
                    key={row.key}
                    onClick={() => setOpenKey(row.key)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') setOpenKey(row.key);
                    }}
                    tabIndex={0}
                    className="cursor-pointer align-top hover:bg-slate-900/60 focus:bg-slate-900/60 focus:outline-none"
                  >
                    <td className="whitespace-nowrap px-4 py-2 text-slate-200">{fmtWhen(row.at)}</td>
                    <td className="whitespace-nowrap px-4 py-2">
                      <TypeChip type={row.type} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-slate-400">{whatOf(row)}</td>
                    <td className="whitespace-nowrap px-4 py-2">
                      <span className="inline-flex items-center gap-1">
                        <StatusBadge status={status} />
                        {/* A backup this board started still has its live log. */}
                        {row.type === 'backup' && <SeeLogs streamKey={backupRunKey(row.run.uid)} />}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-slate-400">{durationOf(row)}</td>
                    <td className="min-w-[18rem] max-w-[48rem] px-4 py-2 text-xs">
                      <div className="line-clamp-2">
                        <Details row={row} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </main>

      {open?.type === 'backup' && <BackupDialog run={open.run} onClose={() => setOpenKey(null)} />}
      {open && (open.type === 'briefing' || open.type === 'log-in' || open.type === 'log-off') && (
        <BriefingDialog row={open} status={rowStatus(open, now)} onClose={() => setOpenKey(null)} />
      )}
      {open?.type === 'master' && (
        <MasterDialog event={open.event} status={rowStatus(open, now)} onClose={() => setOpenKey(null)} />
      )}
    </div>
  );
}
