'use client';
import { useEffect, useState } from 'react';
import type { InboxAddress, InboxThreadRef, ReminderDoc, SessionDoc, WorkUnitDoc } from '@/lib/types';
import { RemoveWorktree } from '@/components/RemoveWorktree';
import { TranscriptBackup } from '@/components/TranscriptBackup';
import { useBackupStatus } from '@/lib/backupStatus';

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

const PRIORITY_COLOR: Record<string, string> = {
  Urgent: 'bg-red-950 text-red-300',
  High: 'bg-orange-950 text-orange-300',
  Medium: 'bg-yellow-950 text-yellow-300',
  Low: 'bg-slate-800 text-slate-400',
};

/**
 * Linear's default colours by workflow state type, for a card the daemon has
 * not read live yet (its state.yaml has only the status name). Once synced the
 * card uses the exact colour Linear reports for that state.
 */
const STATUS_TYPE_COLOR: Record<string, string> = {
  triage: '#fc7840',
  backlog: '#bec2c8',
  unstarted: '#e2e2e2',
  started: '#f2c94c',
  completed: '#5e6ad2',
  canceled: '#95a2b3',
};
const STATUS_NAME_TYPE: Record<string, string> = {
  triage: 'triage',
  backlog: 'backlog',
  todo: 'unstarted',
  'in progress': 'started',
  'in review': 'started',
  done: 'completed',
  canceled: 'canceled',
  cancelled: 'canceled',
  duplicate: 'canceled',
};
function statusColor(unit: WorkUnitDoc): string {
  if (unit.linearStatusColor) return unit.linearStatusColor;
  const type = unit.linearStatusType ?? STATUS_NAME_TYPE[(unit.linearStatus ?? '').trim().toLowerCase()];
  return (type && STATUS_TYPE_COLOR[type]) || '#64748b';
}

/** How long a Refresh waits for the daemon's answer before giving up. */
const CARD_REFRESH_TIMEOUT_MS = 60_000;

/**
 * The card's header ribbon: the ticket's Linear status in Linear's own colour,
 * and a ↻ that refreshes the whole card now — the daemon re-checks the worktree
 * list, re-reads the card's state.yaml, its Linear fields and its session
 * transcripts (the per-card form of each clock job), and the board re-reads its
 * backup status. The spinner stops when the card's cardRefreshedAt moves.
 */
function StatusRibbon({ unit, ribbonSpace = false }: { unit: WorkUnitDoc; ribbonSpace?: boolean }) {
  const { refresh: refreshBackups } = useBackupStatus();
  const [askedAt, setAskedAt] = useState<string | null | undefined>(undefined); // cardRefreshedAt when clicked
  const [timedOut, setTimedOut] = useState(false);
  const refreshing = askedAt !== undefined;
  const refreshedAt = unit.cardRefreshedAt ?? null;
  const failed = timedOut || (!refreshing && !!unit.cardRefreshError);

  useEffect(() => {
    if (refreshing && refreshedAt !== askedAt) setAskedAt(undefined);
  }, [refreshing, refreshedAt, askedAt]);
  useEffect(() => {
    if (!refreshing) return;
    const t = setTimeout(() => {
      setAskedAt(undefined);
      setTimedOut(true);
    }, CARD_REFRESH_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [refreshing]);

  const refresh = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation();
    if (refreshing) return;
    setTimedOut(false);
    setAskedAt(refreshedAt);
    void refreshBackups();
    const res = await fetch('/api/card-refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unitId: unit.unitId }),
    }).catch(() => null);
    if (!res?.ok) {
      setAskedAt(undefined);
      setTimedOut(true);
    }
  };

  const color = statusColor(unit);
  const synced = unit.linearSyncedAt ?? null;
  const title = timedOut
    ? 'The daemon did not answer — see its log (ks-flow status). Click to retry.'
    : unit.cardRefreshError && !refreshing
      ? `Last refresh hit a problem: ${unit.cardRefreshError}. Click to retry.`
      : `Refresh this card: worktree, state.yaml, Linear, sessions, backup status` +
        (synced ? ` (Linear last read ${relTime(synced)})` : ' (Linear not read live yet)');

  return (
    <div
      className={`-mx-3 -mt-3 mb-2 flex items-center justify-between gap-2 rounded-t-lg border-b py-1 pl-3 ${
        ribbonSpace ? 'pr-14' : 'pr-3'
      }`}
      style={{ backgroundColor: `${color}26`, borderColor: `${color}55` }}
    >
      <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium" style={{ color }}>
        <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
        <span className="truncate">{unit.linearStatus ?? 'No status'}</span>
      </span>
      <button
        type="button"
        onClick={refresh}
        disabled={refreshing}
        title={title}
        aria-label="Refresh this card"
        className={`shrink-0 rounded px-1 text-[11px] leading-4 hover:bg-black/30 ${
          failed ? 'text-red-400' : 'text-slate-400 hover:text-slate-200'
        }`}
      >
        <span className={`inline-block ${refreshing ? 'animate-spin' : ''}`}>{failed ? '!' : '↻'}</span>
      </button>
    </div>
  );
}

/** A thread in the Inbox web app: `#thread=<root>&msg=<message>` (the url ends in "/"). */
function threadLink(inbox: InboxAddress | undefined, t: InboxThreadRef): string | null {
  if (!inbox?.url) return null;
  return `${inbox.url}#thread=${encodeURIComponent(t.threadId)}${
    t.linkMessageId ? `&msg=${encodeURIComponent(t.linkMessageId)}` : ''
  }`;
}

/**
 * The diagonal "Needs you" sash across the card's top-right corner: an Inbox
 * question, action item or unsent answer waits on you. Red when the agent has
 * stopped until you answer. Clicking it opens the first such thread.
 */
function NeedsYouRibbon({ unit, inbox }: { unit: WorkUnitDoc; inbox?: InboxAddress }) {
  const state = unit.inbox;
  if (!state?.needsYou) return null;
  const first = state.threads.find((t) => t.questions.length > 0) ?? state.threads[0];
  const href = first ? threadLink(inbox, first) : null;
  const waiting = state.threads.reduce((n, t) => n + t.open + t.picked, 0);
  const title =
    `${state.stopped ? 'Stopped on you: ' : ''}${waiting} Inbox item${waiting === 1 ? '' : 's'} waiting on you` +
    (state.since ? ` since ${relTime(state.since)}` : '') +
    (href ? (inbox?.running ? ' — open the thread' : ' — the Inbox is closed: run `plannotator inbox`') : '');
  const cls = `needs-you-ribbon pointer-events-auto ${state.stopped ? 'needs-you-stopped' : ''}`;
  return (
    // Its own clipping box, so the card itself keeps overflow visible for its menus.
    <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-lg">
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className={cls} title={title} onClick={(e) => e.stopPropagation()}>
          Needs you
        </a>
      ) : (
        <span className={cls} title={title}>
          Needs you
        </span>
      )}
    </div>
  );
}

/** The card's Inbox threads: what waits on you in each, linked to the thread. */
function InboxThreads({ unit, inbox }: { unit: WorkUnitDoc; inbox?: InboxAddress }) {
  const threads = unit.inbox?.threads ?? [];
  if (threads.length === 0) return null;
  const closed = !!inbox?.url && !inbox.running;
  return (
    <div className="mt-2 space-y-1 border-t border-slate-800 pt-2 text-[11px]">
      {threads.map((t) => {
        const href = threadLink(inbox, t);
        const questions = t.open - Math.min(t.actions, t.open);
        const parts = [
          questions > 0 && `${questions} open question${questions === 1 ? '' : 's'}`,
          t.actions > 0 && `${t.actions} action item${t.actions === 1 ? '' : 's'}`,
          t.picked > 0 && `${t.picked} answer${t.picked === 1 ? '' : 's'} to send`,
          t.questions.length === 0 && t.unseen > 0 && `${t.unseen} new message${t.unseen === 1 ? '' : 's'}`,
        ].filter(Boolean);
        const waits = t.questions.length > 0;
        const tip = [
          t.subject,
          ...t.questions.map((q) => `${q.kind === 'action' ? 'Action' : 'Q'}: ${q.prompt}`),
          closed ? 'The Inbox is closed: run `plannotator inbox`' : null,
        ]
          .filter(Boolean)
          .join('\n');
        const body = (
          <>
            <span className="shrink-0">{t.stopped ? '⛔' : waits ? '✋' : '✉'}</span>
            <span className="min-w-0">
              {t.stopped && <span className="font-semibold text-red-300">Stopped on you · </span>}
              <span className={waits ? 'text-slate-200' : 'text-slate-400'}>{parts.join(' · ')}</span>
              {t.holdsUp.length > 0 && (
                <span className="text-slate-500"> · holds up: {t.holdsUp.join('; ')}</span>
              )}
              {t.subject && <span className="block truncate text-slate-500">{t.subject}</span>}
            </span>
            {href && <span className="ml-auto shrink-0 text-slate-500">{closed ? 'Inbox (closed)' : 'Inbox ↗'}</span>}
          </>
        );
        const cls = `flex items-start gap-1.5 rounded px-1.5 py-1 ${
          t.stopped ? 'bg-red-950/60' : waits ? 'bg-orange-950/50' : 'bg-slate-800/60'
        }`;
        return href ? (
          <a
            key={t.threadId}
            href={href}
            target="_blank"
            rel="noreferrer"
            title={tip}
            onClick={(e) => e.stopPropagation()}
            className={`${cls} hover:brightness-125`}
          >
            {body}
          </a>
        ) : (
          <div key={t.threadId} title={tip} className={cls}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

export function WorkUnitCard({
  unit,
  sessions,
  reminders,
  now,
  inbox,
  done = false,
  dimmed = false,
  onRemoved,
}: {
  unit: WorkUnitDoc;
  sessions: SessionDoc[];
  reminders: ReminderDoc[];
  now: number;
  /** The Plannotator Inbox's address, for the thread links. */
  inbox?: InboxAddress;
  /** In the Done column: Linear says the work is finished. */
  done?: boolean;
  /** No live worktree (a Done unit already cleaned up). */
  dimmed?: boolean;
  /** After its worktree is removed: refresh the board so the card goes. */
  onRemoved?: () => void | Promise<void>;
}) {
  const live = sessions.filter((s) => unit.sessionIds.includes(s.sessionId));
  // Recency-based, not the daemon's snapshot flag → glow self-expires.
  const active = live.filter(
    (s) => s.lastActivity && now - Date.parse(s.lastActivity) < ACTIVE_WINDOW_MS,
  ).length;
  const waiting = unit.waiting?.active;
  const needsYou = !!unit.inbox?.needsYou;

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
      className={`relative rounded-lg border bg-slate-900 p-3 shadow-sm transition ${
        waiting ? 'border-amber-500 ring-2 ring-amber-500/30' : 'border-slate-800'
      } ${active > 0 ? 'session-glow' : overdue && !pauseRec ? 'overdue-glow' : ''} ${
        dimmed ? 'opacity-50' : ''
      }`}
    >
      <NeedsYouRibbon unit={unit} inbox={inbox} />
      <StatusRibbon unit={unit} ribbonSpace={needsYou} />
      <div className={`flex items-start justify-between gap-2 ${needsYou ? 'pr-8' : ''}`}>
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
        {/* No worktree left: the sweep has nothing to back up, only Restore applies. */}
        <TranscriptBackup unitId={unit.unitId} restoreOnly={!unit.worktreeDir} />
        <ReminderControls unitId={unit.unitId} reminders={reminders} />
        {/* An open ticket's dialog warns before removing. */}
        <RemoveWorktree unit={unit} completed={done} onRemoved={onRemoved} />
      </div>

      <InboxThreads unit={unit} inbox={inbox} />

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
