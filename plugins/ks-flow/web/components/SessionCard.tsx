'use client';
import { useState } from 'react';
import type { SessionDoc, WorkUnitDoc } from '@/lib/types';

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

const PRIORITY_COLOR: Record<string, string> = {
  Urgent: 'bg-red-950 text-red-300',
  High: 'bg-orange-950 text-orange-300',
  Medium: 'bg-yellow-950 text-yellow-300',
  Low: 'bg-slate-800 text-slate-400',
};

export function WorkUnitCard({
  unit,
  sessions,
  now,
  dimmed = false,
}: {
  unit: WorkUnitDoc;
  sessions: SessionDoc[];
  now: number;
  dimmed?: boolean;
}) {
  const live = sessions.filter((s) => unit.sessionIds.includes(s.sessionId));
  // Recency-based, not the daemon's snapshot flag → glow self-expires.
  const active = live.filter(
    (s) => s.lastActivity && now - Date.parse(s.lastActivity) < ACTIVE_WINDOW_MS,
  ).length;
  const waiting = unit.waiting?.active;

  return (
    <div
      className={`rounded-lg border bg-slate-900 p-3 shadow-sm transition ${
        waiting ? 'border-amber-500 ring-2 ring-amber-500/30' : 'border-slate-800'
      } ${active > 0 ? 'session-glow' : ''} ${dimmed ? 'opacity-50' : ''}`}
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
