'use client';
import { useState } from 'react';
import type { ReminderDoc, SessionDoc, WorkUnitDoc } from '@/lib/types';
import { useBackupStatus } from '@/lib/backupStatus';
import { useStreamPanel } from '@/components/StreamPanel';

// A session counts as "active" (glowing border) if it wrote within this window.
// Derived client-side off a ticking clock (passed down from the board) so the
// glow self-expires, instead of trusting the daemon's snapshot 'activity' flag
// (which never re-evaluates on a timer and can stay stuck on).
const ACTIVE_WINDOW_MS = 5 * 60_000;

/** Copy a worktree path to the clipboard with brief feedback. */
function CopyPath({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked (no https / no permission) — path still shown on hover
    }
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      title={`Copy worktree path:\n${path}`}
      className="rounded bg-slate-800 px-1.5 py-0.5 font-medium text-slate-400 hover:bg-slate-700 hover:text-slate-200"
    >
      {copied ? 'copied' : '⧉ path'}
    </button>
  );
}

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

function absTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : 'no activity recorded';
}

/** ⏰ control: set / list / clear per-card custom reminders. Writes go to the
 * board server (/api/reminders); the live subscription re-renders. */
function ReminderControls({ unitId, reminders }: { unitId: string; reminders: ReminderDoc[] }) {
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const mine = reminders
    .filter((r) => r.kind === 'custom' && !r.cleared && r.unitId === unitId)
    .sort((a, b) => (a.dueAt ?? '').localeCompare(b.dueAt ?? ''));

  const add = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    e.stopPropagation();
    const v = val.trim();
    if (!v) return;
    setBusy(true);
    const isRel = /^\d+\s*[mhd]$/i.test(v);
    try {
      await fetch('/api/reminders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isRel ? { unitId, relative: v, note } : { unitId, dueAt: v, note }),
      });
      setVal('');
      setNote('');
      setOpen(false);
    } catch {
      // surfaced by the lack of a new chip
    }
    setBusy(false);
  };
  const clear = async (uid: string): Promise<void> => {
    await fetch('/api/reminders', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid }),
    }).catch(() => {});
  };

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        title="Set a reminder"
        className="rounded bg-slate-800 px-1.5 py-0.5 font-medium text-slate-400 hover:bg-slate-700 hover:text-slate-200"
      >
        ⏰{mine.length ? ` ${mine.length}` : ''}
      </button>
      {open && (
        <form
          onSubmit={add}
          onClick={(e) => e.stopPropagation()}
          className="mt-1 w-full space-y-1 rounded border border-slate-700 bg-slate-800 p-2"
        >
          <input
            value={val}
            onChange={(e) => setVal(e.target.value)}
            placeholder="30m · 2h · 1d · or 2026-06-20T15:00"
            spellCheck={false}
            className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-100 placeholder-slate-500"
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="note (optional)"
            className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-100 placeholder-slate-500"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-indigo-600 px-2 py-0.5 text-[11px] font-medium text-white disabled:opacity-50"
          >
            {busy ? 'setting…' : 'set reminder'}
          </button>
          {mine.map((r) => (
            <div key={r.uid} className="flex items-center justify-between gap-2 text-[10px] text-slate-400">
              <span className="truncate" title={r.note}>
                {r.dueAt ? new Date(r.dueAt).toLocaleString() : ''}
                {r.note ? ` · ${r.note}` : ''}
              </span>
              <button
                type="button"
                onClick={() => clear(r.uid)}
                className="shrink-0 text-slate-500 hover:text-red-400"
                title="Clear reminder"
              >
                ✕
              </button>
            </div>
          ))}
        </form>
      )}
    </>
  );
}


/**
 * Per-card backup + restore.
 *
 * Local transcripts are pruned at 30 days, so the interesting state is "the
 * bucket has sessions this machine no longer does" — that card gets an amber
 * Restore. Otherwise the control is a quiet cloud glyph that backs this one unit
 * up on demand, alongside the daemon's end-of-day sweep.
 *
 * "Back up" means transcript AND workflow: a session change uploads the changed
 * session files plus a refreshed workflow.tar.zst. Nothing changed in the window
 * means nothing to upload, so the tooltip says so rather than implying the click
 * always ships something.
 *
 * Restore never overwrites a local transcript (the CLI enforces that); it only
 * fills in what is missing, so clicking it while a session is live is safe.
 */
function TranscriptBackup({ unitId }: { unitId: string }) {
  const { status, refresh } = useBackupStatus(unitId);
  const { runStream, busy } = useStreamPanel();

  // Output goes to the shared bottom-right log panel — the same one Remove uses
  // — because a backup is not instant: a long transcript spends real time in
  // zstd and in the upload, and a button with no feedback reads as broken (it
  // did: a no-op click looked identical to a failure).
  const backup = (e: React.MouseEvent): void => {
    e.stopPropagation();
    void runStream({
      title: `Backing up ${unitId}`,
      url: '/api/transcript-backup',
      body: { unit: unitId },
      successNote: '✓ backup complete',
      onSuccess: refresh,
    });
  };

  const restore = (e: React.MouseEvent): void => {
    e.stopPropagation();
    void runStream({
      title: `Restoring ${unitId}`,
      url: '/api/transcript-restore',
      body: { unit: unitId },
      successNote: '✓ restore complete',
      onSuccess: refresh,
    });
  };

  const backedUpAt = status?.lastArchivedAt
    ? `Last backed up ${absTime(status.lastArchivedAt)}`
    : 'Never backed up';
  // Counts come from a per-file size+mtime comparison against the archive index
  // (see /api/transcript-backup GET), not from comparing how many files each
  // side has — equal counts can still be different files.
  const pending = status?.pendingCount ?? 0;

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={backup}
        disabled={busy}
        title={
          pending > 0
            ? `${pending} session file(s) on disk are new or have grown since their last ` +
              `upload — back up transcript + workflow now. ${backedUpAt}.`
            : `Everything on disk is already in the bucket (${status?.cloudSessions ?? 0} ` +
              `session file(s)). ${backedUpAt}.`
        }
        className={`rounded px-1.5 py-0.5 font-medium disabled:opacity-50 ${
          pending > 0
            ? 'bg-indigo-950 text-indigo-300 hover:bg-indigo-900'
            : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200'
        }`}
      >
        ☁ backup{pending > 0 ? ` ${pending}` : ''}
      </button>
      {/* Restore appears on its own the moment the bucket holds sessions this
          machine no longer has — that is the whole point of the backup, so it
          should never need hunting for. `legacyOnly` units have a pre-migration
          tarball and no per-file objects; restore can still read it, so offer it
          without a count. */}
      {status && (status.missingCount > 0 || (status.legacyOnly && status.localSessions === 0)) && (
        <button
          type="button"
          onClick={restore}
          disabled={busy}
          title={
            status.missingCount > 0
              ? `${status.missingCount} backed-up session file(s) are no longer on disk ` +
                `(pruned at 30 days, or the worktree was removed) — restore them. ` +
                `Existing local transcripts are never overwritten.`
              : 'A pre-migration archive exists for this unit and nothing is on disk — ' +
                'restore unpacks it. Existing local transcripts are never overwritten.'
          }
          className="rounded bg-amber-950 px-1.5 py-0.5 font-medium text-amber-300 hover:bg-amber-900 disabled:opacity-50"
        >
          ⤓ restore{status.missingCount > 0 ? ` ${status.missingCount}` : ''}
        </button>
      )}
    </span>
  );
}

const PRIORITY_COLOR: Record<string, string> = {
  Urgent: 'bg-red-950 text-red-300',
  High: 'bg-orange-950 text-orange-300',
  Medium: 'bg-yellow-950 text-yellow-300',
  Low: 'bg-slate-800 text-slate-400',
};

export function WorkUnitCard({
  unit,
  sessions,
  reminders,
  now,
  dimmed = false,
}: {
  unit: WorkUnitDoc;
  sessions: SessionDoc[];
  reminders: ReminderDoc[];
  now: number;
  dimmed?: boolean;
}) {
  const live = sessions.filter((s) => unit.sessionIds.includes(s.sessionId));
  // Recency-based, not the daemon's snapshot flag → glow self-expires.
  const active = live.filter(
    (s) => s.lastActivity && now - Date.parse(s.lastActivity) < ACTIVE_WINDOW_MS,
  ).length;
  const waiting = unit.waiting?.active;

  // Overdue: any uncleared custom reminder on this card whose due time has passed
  // → red travelling-border glow (takes precedence over the active-session glow).
  const overdue = reminders.some(
    (r) =>
      r.kind === 'custom' &&
      !r.cleared &&
      r.unitId === unit.unitId &&
      r.dueAt != null &&
      Date.parse(r.dueAt) <= now,
  );

  // Stop-nudge pause: paused if any of the unit's sessions has a pause record.
  const pauseRec = reminders.find(
    (r) => r.kind === 'pause' && r.sessionId && unit.sessionIds.includes(r.sessionId),
  );
  // Pause the most-recently-active live session (fallback: first session id).
  const pauseTarget =
    pauseRec?.sessionId ??
    [...live].sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''))[0]
      ?.sessionId ??
    unit.sessionIds[0];
  const togglePause = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation();
    if (!pauseTarget) return;
    await fetch('/api/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: pauseTarget, unitId: unit.unitId, paused: !pauseRec }),
    }).catch(() => {});
  };

  return (
    <div
      className={`rounded-lg border bg-slate-900 p-3 shadow-sm transition ${
        waiting ? 'border-amber-500 ring-2 ring-amber-500/30' : 'border-slate-800'
      } ${active > 0 ? 'session-glow' : overdue && !pauseRec ? 'overdue-glow' : ''} ${
        dimmed ? 'opacity-50' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-xs font-semibold text-slate-400">
          {unit.identifier}
        </span>
        <div className="flex flex-wrap items-center gap-1">
          {unit.priority?.name && (
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                PRIORITY_COLOR[unit.priority.name] ?? 'bg-slate-800 text-slate-400'
              }`}
            >
              {unit.priority.name}
            </span>
          )}
          {unit.estimate != null && (
            <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
              {unit.estimate} pt
            </span>
          )}
        </div>
      </div>

      <p className="mt-1 line-clamp-2 text-sm font-medium text-slate-100">
        {unit.title}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
        {unit.linearStatus && (
          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-400">
            {unit.linearStatus}
          </span>
        )}
        {unit.linearUrl && (
          <a
            href={unit.linearUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded bg-indigo-950 px-1.5 py-0.5 font-medium text-indigo-300 hover:bg-indigo-900"
            title="Open in Linear"
          >
            Linear ↗
          </a>
        )}
        {unit.slackThreadUrl && (
          <a
            href={unit.slackThreadUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded bg-fuchsia-950 px-1.5 py-0.5 font-medium text-fuchsia-300 hover:bg-fuchsia-900"
            title="Open the source Slack thread"
          >
            Slack ↗
          </a>
        )}
        {unit.pr && (
          <a
            href={unit.pr.url}
            target="_blank"
            rel="noreferrer"
            className="rounded bg-violet-950 px-1.5 py-0.5 font-medium text-violet-300 hover:bg-violet-900"
          >
            PR{unit.pr.number ? ` #${unit.pr.number}` : ''}
          </a>
        )}
        {waiting && (
          <span className="rounded bg-amber-400 px-1.5 py-0.5 font-semibold text-amber-950">
            ⏳ waiting: {unit.waiting?.tool}
          </span>
        )}
        {unit.worktreeDir && <CopyPath path={unit.worktreeDir} />}
        {live.length > 0 && (
          <button
            type="button"
            onClick={togglePause}
            title={pauseRec ? 'Reminders paused — click to resume' : 'Pause stop-reminders for this session'}
            className={`rounded px-1.5 py-0.5 font-medium ${
              pauseRec
                ? 'bg-amber-950 text-amber-300 hover:bg-amber-900'
                : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200'
            }`}
          >
            {pauseRec ? '⏸ paused' : '▶ active'}
          </button>
        )}
        <TranscriptBackup unitId={unit.unitId} />
        <ReminderControls unitId={unit.unitId} reminders={reminders} />
      </div>

      <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
        <span>
          {live.length > 0
            ? `${live.length} session${live.length > 1 ? 's' : ''}${
                active ? ` · ${active} active` : ''
              }`
            : 'no live session'}
        </span>
        <span title={`Session last active: ${absTime(unit.lastActivity)}`}>
          ⟳ active {relTime(unit.lastActivity)}
        </span>
      </div>
    </div>
  );
}
