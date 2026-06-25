'use client';
// Notes — saved notes & reminders.
//   • Add from the header ("+ Add note" → Slack note / Any note) → a modal form.
//   • Board splits by work type: Professional (left) | Personal (right).
//   • Slack notes are added by pasting a message permalink (text + date fetched
//     server-side via SLACK_TOKEN — Slack can't list saved messages); they show a
//     Slack icon. "Any note" is free text.
//   • Any note can carry an optional reminder; once lapsed the daemon nudges once
//     a day until cleared, and the card glows red.
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNow } from '@/lib/useNow';
import type { ReminderDoc } from '@/lib/types';

type WorkType = 'personal' | 'professional';

const unescapeSlack = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// One token = a Slack mention/special/link in the message text.
const SLACK_TOKEN =
  /<@U[A-Z0-9]+(?:\|[^>]+)?>|<#C[A-Z0-9]+(?:\|[^>]+)?>|<!subteam\^[A-Z0-9]+(?:\|@?[^>]+)?>|<!(?:here|channel|everyone)(?:\|[^>]+)?>|<https?:[^>]+>/g;

// Render one token as a colored node. Users = indigo, channels = sky, broadcasts
// (@here/@channel) = amber, links = underlined indigo anchors.
function slackToken(tok: string, names: Record<string, string>, key: number): ReactNode {
  let m: RegExpExecArray | null;
  if ((m = /^<@(U[A-Z0-9]+)(?:\|([^>]+))?>$/.exec(tok))) {
    return (
      <span key={key} className="rounded bg-indigo-500/15 px-1 font-medium text-indigo-300">
        @{m[2] || names[m[1]] || m[1]}
      </span>
    );
  }
  if ((m = /^<#(C[A-Z0-9]+)(?:\|([^>]+))?>$/.exec(tok))) {
    return (
      <span key={key} className="rounded bg-sky-500/15 px-1 font-medium text-sky-300">
        #{m[2] || names[m[1]] || m[1]}
      </span>
    );
  }
  if ((m = /^<!subteam\^[A-Z0-9]+(?:\|@?([^>]+))?>$/.exec(tok))) {
    return (
      <span key={key} className="rounded bg-indigo-500/15 px-1 font-medium text-indigo-300">
        @{m[1] || 'group'}
      </span>
    );
  }
  if ((m = /^<!(here|channel|everyone)(?:\|[^>]+)?>$/.exec(tok))) {
    return (
      <span key={key} className="rounded bg-amber-500/15 px-1 font-medium text-amber-300">
        @{m[1]}
      </span>
    );
  }
  if ((m = /^<(https?:[^>|]+)(?:\|([^>]+))?>$/.exec(tok))) {
    return (
      <a
        key={key}
        href={m[1]}
        target="_blank"
        rel="noreferrer"
        className="text-indigo-400 underline hover:text-indigo-300"
      >
        {m[2] || m[1]}
      </a>
    );
  }
  return tok;
}

// Slack encodes mentions/links in message text (<@U123>, <#C1|general>, <url|label>).
// Render them inline for DISPLAY ONLY — the DB keeps the raw text. User/channel IDs
// without an inline name resolve from `names` (cache-first via /api/notes/slack/names).
function renderSlackParts(text: string, names: Record<string, string>): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  SLACK_TOKEN.lastIndex = 0;
  while ((m = SLACK_TOKEN.exec(text))) {
    if (m.index > last) out.push(unescapeSlack(text.slice(last, m.index)));
    out.push(slackToken(m[0], names, i++));
    last = SLACK_TOKEN.lastIndex;
  }
  if (last < text.length) out.push(unescapeSlack(text.slice(last)));
  return out;
}

// User/channel IDs without an inline name → need resolution from Slack.
function mentionIds(text: string): string[] {
  const ids = [...text.matchAll(/<@(U[A-Z0-9]+)>/g)].map((m) => m[1]);
  ids.push(...[...text.matchAll(/<#(C[A-Z0-9]+)>/g)].map((m) => m[1]));
  return ids;
}

interface NotesConfig {
  enabled: boolean;
  slack: { enabled: boolean; tokenPresent: boolean };
  linear: { enabled: boolean; keyPresent: boolean };
}

function fmt(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function toLocalInput(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Official Slack mark, inlined (CSP blocks external assets).
function SlackIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 122.8 122.8" width="14" height="14" aria-label="Slack" className="shrink-0">
      <path
        d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zM32.3 77.6c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z"
        fill="#E01E5A"
      />
      <path
        d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zM45.2 32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z"
        fill="#36C5F0"
      />
      <path
        d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zM90.5 45.2c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z"
        fill="#2EB67D"
      />
      <path
        d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zM77.6 90.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z"
        fill="#ECB22E"
      />
    </svg>
  );
}

function ReminderControl({
  note,
  onSet,
  onClear,
}: {
  note: ReminderDoc;
  onSet: (iso: string) => void;
  onClear: () => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(toLocalInput(note.dueAt));
  const lapsed = note.dueAt ? Date.parse(note.dueAt) <= Date.now() : false;

  if (!editing) {
    return (
      <div className="mt-2 flex items-center gap-2 text-[11px]">
        {note.dueAt ? (
          <>
            <span className={lapsed ? 'text-red-400' : 'text-slate-400'}>
              ⏰ {fmt(note.dueAt)}
              {lapsed ? ' · nagging daily' : ''}
            </span>
            <button
              type="button"
              onClick={() => {
                setVal(toLocalInput(note.dueAt));
                setEditing(true);
              }}
              className="text-indigo-400 hover:text-indigo-300"
            >
              edit
            </button>
            <button type="button" onClick={onClear} className="text-slate-500 hover:text-slate-300">
              clear
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-indigo-400 hover:text-indigo-300"
          >
            + set reminder
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="mt-2 flex items-center gap-2 text-[11px]">
      <input
        type="datetime-local"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] text-slate-100 focus:border-indigo-500 focus:outline-none"
      />
      <button
        type="button"
        disabled={!val}
        onClick={() => {
          onSet(new Date(val).toISOString());
          setEditing(false);
        }}
        className="rounded bg-indigo-600 px-2 py-1 font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
      >
        save
      </button>
      <button
        type="button"
        onClick={() => setEditing(false)}
        className="text-slate-500 hover:text-slate-300"
      >
        cancel
      </button>
    </div>
  );
}

function NoteCard({
  note,
  now,
  names,
  onSetReminder,
  onClearReminder,
  onEdit,
  onDone,
  onDelete,
}: {
  note: ReminderDoc;
  now: number;
  names: Record<string, string>;
  onSetReminder: (uid: string, iso: string) => void;
  onClearReminder: (uid: string) => void;
  onEdit: (uid: string, text: string) => void;
  onDone: (uid: string) => void;
  onDelete: (uid: string) => void;
}): JSX.Element {
  const overdue = note.dueAt != null && Date.parse(note.dueAt) <= now;
  const isSlack = note.section === 'slack';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.text ?? '');
  const body: ReactNode = isSlack ? renderSlackParts(note.text ?? '', names) : (note.text ?? '');
  return (
    <div
      className={`rounded-lg border border-slate-800 bg-slate-900 p-3 shadow-sm ${
        overdue ? 'overdue-glow' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 grow items-start gap-2">
          {isSlack && (
            <span className="mt-0.5">
              <SlackIcon />
            </span>
          )}
          {editing ? (
            <div className="grow">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={3}
                autoFocus
                className="w-full resize-y rounded border border-slate-700 bg-slate-800 px-2 py-1 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
              <div className="mt-1 flex gap-2 text-[11px]">
                <button
                  type="button"
                  disabled={!draft.trim()}
                  onClick={() => {
                    onEdit(note.uid, draft.trim());
                    setEditing(false);
                  }}
                  className="rounded bg-indigo-600 px-2 py-1 font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(note.text ?? '');
                    setEditing(false);
                  }}
                  className="text-slate-500 hover:text-slate-300"
                >
                  cancel
                </button>
              </div>
            </div>
          ) : (
            <p className="whitespace-pre-wrap text-sm text-slate-200">{body}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!isSlack && !editing && (
            <button
              type="button"
              onClick={() => {
                setDraft(note.text ?? '');
                setEditing(true);
              }}
              title="Edit note"
              className="text-slate-600 hover:text-indigo-400"
            >
              ✎
            </button>
          )}
          <button
            type="button"
            onClick={() => onDone(note.uid)}
            title="Mark done & archive"
            className="text-slate-600 hover:text-emerald-400"
          >
            ✓
          </button>
          <button
            type="button"
            onClick={() => onDelete(note.uid)}
            title="Delete note"
            className="text-slate-600 hover:text-red-400"
          >
            ✕
          </button>
        </div>
      </div>
      {(note.sourceDate || note.sourceUrl) && (
        <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
          {note.sourceDate && <span>{fmt(note.sourceDate)}</span>}
          {note.sourceUrl && (
            <a
              href={note.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="text-indigo-400 hover:text-indigo-300"
            >
              open in Slack ↗
            </a>
          )}
        </div>
      )}
      <ReminderControl
        note={note}
        onSet={(iso) => onSetReminder(note.uid, iso)}
        onClear={() => onClearReminder(note.uid)}
      />
    </div>
  );
}

// Work-type segmented toggle (Professional default).
function WorkTypeToggle({
  value,
  onChange,
}: {
  value: WorkType;
  onChange: (w: WorkType) => void;
}): JSX.Element {
  return (
    <div className="inline-flex overflow-hidden rounded border border-slate-700 text-[11px]">
      {(['professional', 'personal'] as WorkType[]).map((w) => (
        <button
          key={w}
          type="button"
          onClick={() => onChange(w)}
          className={`px-3 py-1 capitalize ${
            value === w ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
          }`}
        >
          {w}
        </button>
      ))}
    </div>
  );
}

// Add-note modal. mode 'slack' → paste a permalink; 'generic' → free text. Both
// take a work type (default professional) + an optional reminder.
function NoteModal({
  mode,
  saving,
  error,
  onSubmit,
  onClose,
}: {
  mode: 'slack' | 'generic';
  saving: boolean;
  error: string | null;
  onSubmit: (v: { text?: string; url?: string; workType: WorkType; dueAt?: string }) => void;
  onClose: () => void;
}): JSX.Element {
  const [workType, setWorkType] = useState<WorkType>('professional');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [due, setDue] = useState('');
  const ready = mode === 'slack' ? !!url.trim() : !!text.trim();

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-24"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg border border-slate-700 bg-slate-900 p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2">
          {mode === 'slack' && <SlackIcon />}
          <h2 className="text-sm font-semibold text-slate-100">
            {mode === 'slack' ? 'New Slack note' : 'New note'}
          </h2>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!ready) return;
            onSubmit({
              workType,
              dueAt: due ? new Date(due).toISOString() : undefined,
              ...(mode === 'slack' ? { url: url.trim() } : { text: text.trim() }),
            });
          }}
          className="space-y-3"
        >
          {mode === 'slack' ? (
            <>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="Paste a Slack message link (…/archives/<channel>/p…)"
                autoFocus
                className="w-full rounded border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
              />
              <p className="text-[11px] text-slate-500">
                The message text + date are fetched via your Slack token.
              </p>
            </>
          ) : (
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Write a note…"
              rows={4}
              autoFocus
              className="w-full resize-y rounded border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
          )}

          <div className="flex flex-wrap items-center gap-3 text-[11px]">
            <span className="text-slate-400">Work type</span>
            <WorkTypeToggle value={workType} onChange={setWorkType} />
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <label className="text-slate-400">Remind (optional)</label>
            <input
              type="datetime-local"
              value={due}
              onChange={(e) => setDue(e.target.value)}
              className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-slate-100 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          {error && <p className="text-[11px] text-red-400">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded px-3 py-1.5 text-sm text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !ready}
              className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {saving ? (mode === 'slack' ? 'Fetching…' : 'Saving…') : 'Add'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function Notes(): JSX.Element {
  const now = useNow(30_000);
  const [config, setConfig] = useState<NotesConfig | null>(null);
  const [notes, setNotes] = useState<ReminderDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [modal, setModal] = useState<'slack' | 'generic' | null>(null);
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ReminderDoc | null>(null);
  const [trashed, setTrashed] = useState<ReminderDoc[]>([]);
  const [showTrash, setShowTrash] = useState(false);
  const [archived, setArchived] = useState<ReminderDoc[]>([]);
  const [showArchive, setShowArchive] = useState(false);
  // Resolved mention names (users + channels), cache-first via /api/notes/slack/names.
  const [slackNames, setSlackNames] = useState<Record<string, string>>({});
  const triedIds = useRef<Set<string>>(new Set());

  const loadNotes = useCallback(async (): Promise<void> => {
    try {
      const r = await fetch('/api/notes', { cache: 'no-store' });
      const d: { notes?: ReminderDoc[] } = await r.json();
      setNotes(d.notes ?? []);
    } catch {
      /* leave as-is */
    }
  }, []);

  const loadTrash = useCallback(async (): Promise<void> => {
    try {
      const r = await fetch('/api/notes?trash=1', { cache: 'no-store' });
      const d: { notes?: ReminderDoc[] } = await r.json();
      setTrashed(d.notes ?? []);
    } catch {
      /* leave as-is */
    }
  }, []);

  const loadArchive = useCallback(async (): Promise<void> => {
    try {
      const r = await fetch('/api/notes?archive=1', { cache: 'no-store' });
      const d: { notes?: ReminderDoc[] } = await r.json();
      setArchived(d.notes ?? []);
    } catch {
      /* leave as-is */
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/notes/config', { cache: 'no-store' });
        setConfig(await r.json());
        await Promise.all([loadNotes(), loadTrash(), loadArchive()]);
      } finally {
        setLoading(false);
      }
    })();
  }, [loadNotes, loadTrash, loadArchive]);

  // Resolve any new <@U…> mentions across notes + trash. Marks ids tried so an
  // unresolvable one (left visitor / no users:read) isn't re-fetched in a loop.
  useEffect(() => {
    const need = new Set<string>();
    for (const n of [...notes, ...trashed, ...archived]) {
      if (n.section !== 'slack' || !n.text) continue;
      for (const id of mentionIds(n.text)) if (!triedIds.current.has(id)) need.add(id);
    }
    if (need.size === 0) return;
    need.forEach((id) => triedIds.current.add(id));
    fetch('/api/notes/slack/names', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [...need] }),
    })
      .then((r) => r.json())
      .then((d: { names?: Record<string, string> }) => {
        if (d.names && Object.keys(d.names).length) setSlackNames((p) => ({ ...p, ...d.names }));
      })
      .catch(() => {});
  }, [notes, trashed, archived]);

  const openModal = (mode: 'slack' | 'generic'): void => {
    setMenuOpen(false);
    setModalError(null);
    setModal(mode);
  };

  const submitModal = async (v: {
    text?: string;
    url?: string;
    workType: WorkType;
    dueAt?: string;
  }): Promise<void> => {
    setSaving(true);
    setModalError(null);
    try {
      if (modal === 'slack') {
        const r = await fetch('/api/notes/slack/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: v.url, workType: v.workType, dueAt: v.dueAt }),
        });
        const d: { error?: string } = await r.json();
        if (!r.ok) {
          setModalError(d.error ?? 'Could not fetch that message.');
          return;
        }
      } else {
        await fetch('/api/notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            section: 'generic',
            text: v.text,
            workType: v.workType,
            dueAt: v.dueAt,
          }),
        });
      }
      setModal(null);
      await loadNotes();
    } catch {
      setModalError('Request failed.');
    } finally {
      setSaving(false);
    }
  };

  const setReminder = async (uid: string, iso: string): Promise<void> => {
    await fetch('/api/notes', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, dueAt: iso }),
    });
    await loadNotes();
  };
  const editNote = async (uid: string, text: string): Promise<void> => {
    await fetch('/api/notes', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, text }),
    });
    await loadNotes();
  };
  const clearReminder = async (uid: string): Promise<void> => {
    await fetch('/api/notes', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, clearDue: true }),
    });
    await loadNotes();
  };
  // Soft delete: mark cleared (kept in DB, hidden from the board + skipped by the
  // daemon). Recoverable from Trash.
  const trashNote = async (uid: string): Promise<void> => {
    await fetch('/api/notes', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, cleared: true }),
    });
    await loadNotes();
  };
  const restoreNote = async (uid: string): Promise<void> => {
    await fetch('/api/notes', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, cleared: false }),
    });
    await Promise.all([loadNotes(), loadTrash()]);
  };
  // Mark completed → archived. Hidden from the board, daemon stops nagging.
  // Recoverable via Archive (Reopen).
  const doneNote = async (uid: string): Promise<void> => {
    await fetch('/api/notes', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, done: true }),
    });
    await Promise.all([loadNotes(), loadArchive()]);
  };
  const reopenNote = async (uid: string): Promise<void> => {
    await fetch('/api/notes', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, done: false }),
    });
    await Promise.all([loadNotes(), loadArchive()]);
  };
  // Permanent delete (only from Trash).
  const purgeNote = async (uid: string): Promise<void> => {
    await fetch('/api/notes', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid }),
    });
    await loadTrash();
  };

  const slackAvailable = !!(config?.slack.enabled && config.slack.tokenPresent);
  // Both columns: reverse chronological — newest added first.
  const sorted = [...notes].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  // Default work type is professional → legacy/undefined rows live on the left.
  const professional = sorted.filter((n) => n.workType !== 'personal');
  const personal = sorted.filter((n) => n.workType === 'personal');

  const cardProps = {
    now,
    names: slackNames,
    onSetReminder: (uid: string, iso: string) => void setReminder(uid, iso),
    onClearReminder: (uid: string) => void clearReminder(uid),
    // ✎ edits free-text (non-Slack) note bodies in place.
    onEdit: (uid: string, text: string) => void editNote(uid, text),
    // ✓ marks done & archives immediately (reversible via Archive → Reopen).
    onDone: (uid: string) => void doneNote(uid),
    // ✕ asks first → Trash (soft-delete, recoverable).
    onDelete: (uid: string) => setConfirmDelete(notes.find((n) => n.uid === uid) ?? null),
  };

  const column = (title: string, items: ReminderDoc[]): JSX.Element => (
    <section>
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
      {items.length === 0 ? (
        <p className="text-sm text-slate-600">Nothing here.</p>
      ) : (
        <div className="space-y-3">
          {items.map((n) => (
            <NoteCard key={n.uid} note={n} {...cardProps} />
          ))}
        </div>
      )}
    </section>
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-800 bg-slate-950 px-5 py-3">
        <h1 className="text-lg font-bold">ks-flow · notes</h1>
        <div className="flex items-center gap-3 text-xs">
          {config?.enabled && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setMenuOpen((o) => !o)}
                className="rounded bg-indigo-600 px-3 py-1 font-medium text-white hover:bg-indigo-500"
              >
                + Add note ▾
              </button>
              {menuOpen && (
                <>
                  <button
                    type="button"
                    aria-label="close menu"
                    className="fixed inset-0 z-10 cursor-default"
                    onClick={() => setMenuOpen(false)}
                  />
                  <div className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-md border border-slate-700 bg-slate-900 shadow-lg">
                    {slackAvailable && (
                      <button
                        type="button"
                        onClick={() => openModal('slack')}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-slate-200 hover:bg-slate-800"
                      >
                        <SlackIcon /> Slack note
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => openModal('generic')}
                      className="block w-full px-3 py-2 text-left text-slate-200 hover:bg-slate-800"
                    >
                      Any note
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          {config?.enabled && (
            <button
              type="button"
              onClick={() => {
                void loadArchive();
                setShowArchive(true);
              }}
              className="text-slate-400 hover:text-slate-200"
              title="Archive — completed notes (reopen)"
            >
              ✓{archived.length ? ` ${archived.length}` : ''}
            </button>
          )}
          {config?.enabled && (
            <button
              type="button"
              onClick={() => {
                void loadTrash();
                setShowTrash(true);
              }}
              className="text-slate-400 hover:text-slate-200"
              title="Trash — restore or permanently delete"
            >
              🗑{trashed.length ? ` ${trashed.length}` : ''}
            </button>
          )}
          <Link href="/" className="text-indigo-400 hover:text-indigo-300">
            ← back to board
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 py-8">
        {loading && <p className="text-sm text-slate-500">Loading…</p>}

        {!loading && !config?.enabled && (
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-5 text-sm text-slate-400">
            Notes are off. Enable them in{' '}
            <Link href="/settings" className="text-indigo-400 hover:text-indigo-300">
              Settings
            </Link>
            .
          </div>
        )}

        {!loading && config?.enabled && (
          <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
            {column('Professional', professional)}
            <div className="md:border-l md:border-slate-800 md:pl-8">{column('Personal', personal)}</div>
          </div>
        )}
      </main>

      {modal && (
        <NoteModal
          mode={modal}
          saving={saving}
          error={modalError}
          onSubmit={(v) => void submitModal(v)}
          onClose={() => {
            setModal(null);
            setModalError(null);
          }}
        />
      )}

      {showArchive && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-24"
          onClick={() => setShowArchive(false)}
        >
          <div
            className="w-full max-w-lg rounded-lg border border-slate-700 bg-slate-900 p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-100">Archive · completed</h2>
              <button
                type="button"
                onClick={() => setShowArchive(false)}
                className="text-slate-500 hover:text-slate-300"
              >
                ✕
              </button>
            </div>
            {archived.length === 0 ? (
              <p className="text-sm text-slate-500">No completed notes.</p>
            ) : (
              <div className="max-h-[60vh] space-y-2 overflow-y-auto">
                {archived.map((n) => (
                  <div
                    key={n.uid}
                    className="flex items-start justify-between gap-3 rounded border border-slate-800 bg-slate-950/50 p-2"
                  >
                    <div className="flex min-w-0 items-start gap-2">
                      {n.section === 'slack' && (
                        <span className="mt-0.5">
                          <SlackIcon />
                        </span>
                      )}
                      <p className="line-clamp-2 text-xs text-slate-300">
                        {n.section === 'slack' ? renderSlackParts(n.text ?? '', slackNames) : n.text}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void reopenNote(n.uid)}
                      className="shrink-0 rounded bg-slate-700 px-2 py-1 text-[11px] font-medium text-slate-100 hover:bg-slate-600"
                    >
                      Reopen
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {showTrash && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-24"
          onClick={() => setShowTrash(false)}
        >
          <div
            className="w-full max-w-lg rounded-lg border border-slate-700 bg-slate-900 p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-100">Trash</h2>
              <button
                type="button"
                onClick={() => setShowTrash(false)}
                className="text-slate-500 hover:text-slate-300"
              >
                ✕
              </button>
            </div>
            {trashed.length === 0 ? (
              <p className="text-sm text-slate-500">Trash is empty.</p>
            ) : (
              <div className="max-h-[60vh] space-y-2 overflow-y-auto">
                {trashed.map((n) => (
                  <div
                    key={n.uid}
                    className="flex items-start justify-between gap-3 rounded border border-slate-800 bg-slate-950/50 p-2"
                  >
                    <div className="flex min-w-0 items-start gap-2">
                      {n.section === 'slack' && (
                        <span className="mt-0.5">
                          <SlackIcon />
                        </span>
                      )}
                      <p className="line-clamp-2 text-xs text-slate-300">
                        {n.section === 'slack' ? renderSlackParts(n.text ?? '', slackNames) : n.text}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2 text-[11px]">
                      <button
                        type="button"
                        onClick={() => void restoreNote(n.uid)}
                        className="rounded bg-slate-700 px-2 py-1 font-medium text-slate-100 hover:bg-slate-600"
                      >
                        Restore
                      </button>
                      <button
                        type="button"
                        onClick={() => void purgeNote(n.uid)}
                        title="Delete permanently"
                        className="rounded px-2 py-1 text-slate-500 hover:text-red-400"
                      >
                        Delete forever
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-24"
          onClick={() => setConfirmDelete(null)}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-slate-700 bg-slate-900 p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-sm font-semibold text-slate-100">Move this note to Trash?</h2>
            <p className="mt-2 line-clamp-3 rounded border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs text-slate-400">
              {confirmDelete.section === 'slack'
                ? renderSlackParts(confirmDelete.text ?? '', slackNames)
                : confirmDelete.text}
            </p>
            <p className="mt-2 text-[11px] text-slate-500">
              You can restore it from <span className="text-slate-300">Trash</span> in the header.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDelete(null)}
                className="rounded px-3 py-1.5 text-sm text-slate-400 hover:text-slate-200"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const uid = confirmDelete.uid;
                  setConfirmDelete(null);
                  void trashNote(uid);
                }}
                className="rounded bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-500"
              >
                Move to Trash
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
