'use client';
// The Briefing item dialogs (screens: "Changing a due time and archiving"):
// Change due, and Archive (one item, or every open item of a card).
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { stageOf } from '@/lib/briefing-escalation';
import type { BriefingItemDoc, Resolution } from '@/lib/types';
import { CalendarIcon, ExternalIcon } from '../icons';
import {
  CHIP_CLS,
  KIND_CLS,
  KIND_LABEL,
  RESOLUTION_LABEL,
  hhmm,
  leftText,
  localDate,
  shortDay,
  sourceLabel,
  when,
} from './format';

// ── modal shell ───────────────────────────────────────────────────────────────
function Modal({
  label,
  onClose,
  children,
  wide = false,
}: {
  label: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The parent re-renders on every clock tick; keep focus where it is.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    // Focus the first control so the dialog is keyboard-ready.
    const first = ref.current?.querySelector<HTMLElement>(
      'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
    );
    first?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current();
      } else if (e.key === 'Tab' && ref.current) {
        // Keep Tab inside the dialog.
        const f = [
          ...ref.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])',
          ),
        ];
        if (f.length === 0) return;
        const i = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) {
          e.preventDefault();
          f[f.length - 1].focus();
        } else if (!e.shiftKey && i === f.length - 1) {
          e.preventDefault();
          f[0].focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, []);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-slate-950/70 p-4" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onMouseDown={(e) => e.stopPropagation()}
        className={`flex w-full ${wide ? 'max-w-xl' : 'max-w-lg'} flex-col gap-3.5 rounded-xl border border-slate-700 bg-slate-900 p-5 text-sm text-slate-200 shadow-[0_16px_40px_rgba(0,0,0,0.5)]`}
      >
        {children}
      </div>
    </div>
  );
}

const inputCls =
  'rounded-md border border-slate-700 bg-slate-950 px-2.5 py-2 text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400';
const btnGhost =
  'rounded-md border border-slate-700 px-3.5 py-1.5 text-slate-300 hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400';

async function post(url: string, body: unknown): Promise<string | null> {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    return r.ok ? null : j.error ?? `failed (${r.status})`;
  } catch {
    return 'Request failed — is the board server still running?';
  }
}

/** The item as the dialogs show it at the top. */
function ItemSummary({ item, now }: { item: BriefingItemDoc; now: number }) {
  const stage = stageOf(item, new Date(now));
  const frame =
    stage === 'overdue'
      ? 'border-red-900 bg-[#2a0d12]'
      : stage === 'hot'
        ? 'border-orange-800 bg-[#1c1208]'
        : 'border-slate-800 bg-slate-950';
  return (
    <div className={`flex flex-col gap-1.5 rounded-lg border px-3.5 py-3 ${frame}`}>
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-slate-400">
        <span className={`rounded px-2 py-0.5 text-[11px] font-bold tracking-wide ${KIND_CLS[item.kind]}`}>
          {KIND_LABEL[item.kind]}
        </span>
        <span>
          {sourceLabel(item)} · {when(item.source?.sentAt ?? item.receivedAt, now)}
        </span>
        <span className="grow" />
        <span className={CHIP_CLS[stage]}>{leftText(item.dueAt, now)}</span>
      </div>
      <p className="m-0 text-[15px] text-slate-100">{item.title}</p>
      {item.source?.text && item.source.text !== item.title && (
        <p className="m-0 line-clamp-3 text-[13px] text-slate-400">“{item.source.text}”</p>
      )}
    </div>
  );
}

// ── Change due ────────────────────────────────────────────────────────────────
const RULE_LABEL: Record<BriefingItemDoc['dueRule'], string> = {
  dm: 'DM rule, +4h',
  mention: 'mention rule, +24h',
  fyi: 'FYI, +24h',
  promise: 'your promise',
  message: 'deadline in the message',
  manual: 'set by hand',
};

/** The due date as day buttons: always today, tomorrow and the day after, plus
 * a calendar button for any other day. A day picked there that isn't one of
 * the three shows as a fourth, selected button, so the choice stays visible. */
function DayPicker({
  id,
  value,
  onChange,
  now,
}: {
  id: string;
  value: string; // YYYY-MM-DD, local
  onChange: (v: string) => void;
  now: number;
}) {
  const cal = useRef<HTMLInputElement>(null);
  const n = new Date(now);
  const days = [0, 1, 2].map((k) => {
    const d = at(n, k, 0);
    return { value: localDate(d), label: k === 0 ? 'Today' : k === 1 ? 'Tomorrow' : shortDay(d).split(' ')[0], sub: shortDay(d) };
  });
  const other = value && !days.some((d) => d.value === value) ? value : null;
  const otherDate = other ? new Date(`${other}T00:00`) : null;
  const btn = (selected: boolean): string =>
    `flex flex-col items-center rounded-lg border px-3 py-1.5 text-[13px] focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
      selected
        ? 'border-indigo-500 bg-indigo-950 text-indigo-100'
        : 'border-slate-700 bg-[#111a2e] text-slate-200 hover:border-indigo-500'
    }`;
  const openCalendar = (): void => {
    const el = cal.current;
    if (!el) return;
    try {
      el.showPicker();
    } catch {
      el.focus();
    }
  };
  return (
    <div className="flex flex-[2_1_320px] flex-col gap-1">
      <span id={`${id}-label`} className="text-[12.5px] text-slate-400">
        Date
      </span>
      <div role="group" aria-labelledby={`${id}-label`} className="flex flex-wrap items-stretch gap-2">
        {days.map((d) => (
          <button
            key={d.value}
            type="button"
            aria-pressed={value === d.value}
            onClick={() => onChange(d.value)}
            className={btn(value === d.value)}
          >
            <span className="font-semibold">{d.label}</span>
            <span className="text-[11.5px] text-slate-400">{d.sub}</span>
          </button>
        ))}
        {otherDate && (
          <button type="button" aria-pressed onClick={openCalendar} className={btn(true)}>
            <span className="font-semibold">{shortDay(otherDate).split(' ')[0]}</span>
            <span className="text-[11.5px] text-slate-400">{shortDay(otherDate)}</span>
          </button>
        )}
        <button
          type="button"
          onClick={openCalendar}
          aria-label="Pick another day"
          title="Pick another day"
          className="relative flex items-center rounded-lg border border-slate-700 bg-[#111a2e] px-3 text-slate-200 hover:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
        >
          <CalendarIcon size={18} />
          <input
            ref={cal}
            id={id}
            type="date"
            tabIndex={-1}
            aria-hidden="true"
            value={value}
            onChange={(e) => e.target.value && onChange(e.target.value)}
            className="pointer-events-none absolute inset-0 h-full w-full opacity-0"
          />
        </button>
      </div>
    </div>
  );
}

function at(d: Date, days: number, h: number, m = 0): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, h, m);
}

/** The due history, oldest first, with "Went overdue" when it did. */
export function DueHistory({ item, now }: { item: BriefingItemDoc; now: number }) {
  const rows = item.dueHistory ?? [];
  const overdue = Date.parse(item.dueAt) <= now;
  if (rows.length === 0 && !overdue) return null;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-slate-800 bg-[#0b1222] px-3.5 py-3">
      <h3 className="m-0 text-[13px] font-bold text-slate-300">Due history</h3>
      <div className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-1 text-[12.5px]">
        {rows.map((h, i) => (
          <HistoryRow key={i} h={h} now={now} />
        ))}
        {overdue && (
          <>
            <span className="font-mono text-red-300">{when(item.dueAt, now)}</span>
            <span className="text-red-300">Went overdue</span>
          </>
        )}
      </div>
    </div>
  );
}

function HistoryRow({ h, now }: { h: BriefingItemDoc['dueHistory'][number]; now: number }) {
  const to = when(h.to, now);
  const later = h.from != null && Date.parse(h.to) > Date.parse(h.from);
  const text =
    h.by === 'master'
      ? `${h.from ? 'Moved' : 'Set'} to ${to} by the master${h.reason ? ` (${h.reason})` : ''}`
      : `You ${later ? 'pushed it' : 'moved it'} to ${to}${h.reason ? `: “${h.reason}”` : ''}`;
  return (
    <>
      <span className="font-mono text-slate-400">{when(h.at, now)}</span>
      <span>{text}</span>
    </>
  );
}

export function DueDialog({
  item,
  now,
  onClose,
}: {
  item: BriefingItemDoc;
  now: number;
  onClose: () => void;
}) {
  const ids = useId();
  const initial = new Date(Math.max(Date.parse(item.dueAt), now + 3_600_000));
  const [date, setDate] = useState(localDate(initial));
  const [time, setTime] = useState(hhmm(initial));
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = useMemo(() => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    const t = /^(\d{1,2}):(\d{2})$/.exec(time);
    if (!m || !t) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3], +t[1], +t[2]);
    return Number.isNaN(d.getTime()) ? null : d;
  }, [date, time]);

  const pick = (d: Date): void => {
    setDate(localDate(d));
    setTime(hhmm(d));
  };
  const n = new Date(now);
  const daysToMonday = ((8 - n.getDay()) % 7) || 7;
  const presets: { label: string; at: Date }[] = [
    { label: '+1h', at: new Date(now + 3_600_000) },
    { label: '+4h', at: new Date(now + 4 * 3_600_000) },
    { label: 'Tomorrow 12:00', at: at(n, 1, 12) },
    { label: 'Next Mon 09:00', at: at(n, daysToMonday, 9) },
  ];

  const later = chosen ? chosen.getTime() > Date.parse(item.dueAt) : false;
  const past = chosen ? chosen.getTime() <= now : false;
  const same = chosen ? Math.abs(chosen.getTime() - Date.parse(item.dueAt)) < 60_000 : false;

  const save = async (): Promise<void> => {
    if (!chosen || same) return;
    setSaving(true);
    setError(null);
    const err = await post('/api/briefing/due', {
      uid: item.uid,
      dueAt: chosen.toISOString(),
      reason: reason.trim() || undefined,
    });
    setSaving(false);
    if (err) setError(err);
    else onClose();
  };

  return (
    <Modal label="Change due time" onClose={onClose}>
      <ItemSummary item={item} now={now} />
      <div className="flex flex-wrap items-baseline gap-2.5">
        <h2 className="m-0 text-[15px] font-bold">Change due</h2>
        <span className="text-[13px] text-slate-400">
          now: {when(item.dueAt, now)} ({item.dueSetByYou ? 'set by you' : RULE_LABEL[item.dueRule] ?? item.dueRule})
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {presets.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => pick(p.at)}
            title={`${shortDay(p.at)} ${hhmm(p.at)}`}
            className="rounded-lg border border-slate-700 bg-[#111a2e] py-2.5 text-slate-200 hover:border-indigo-500 hover:bg-indigo-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
          >
            {p.label}
          </button>
        ))}
      </div>
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="flex flex-wrap items-end gap-2.5">
          <DayPicker id={`${ids}-date`} value={date} onChange={setDate} now={now} />
          <div className="flex flex-[1_1_100px] flex-col gap-1">
            <label htmlFor={`${ids}-time`} className="text-[12.5px] text-slate-400">
              Time
            </label>
            <input
              id={`${ids}-time`}
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className={`${inputCls} font-mono`}
              required
            />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${ids}-why`} className="text-[12.5px] text-slate-400">
            Why (optional, kept in the history)
          </label>
          <input
            id={`${ids}-why`}
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className={inputCls}
          />
        </div>
        {later && (
          <p className="m-0 text-[12.5px] text-amber-300">
            This moves the due time later. It will show as pushed {(item.pushedCount ?? 0) + 1}× on the item.
          </p>
        )}
        {past && (
          <p className="m-0 text-[12.5px] text-red-300">That time has already passed: the item will be overdue.</p>
        )}
        {error && (
          <p role="alert" className="m-0 text-[12.5px] text-red-400">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={btnGhost}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={!chosen || same || saving}
            className="rounded-md border border-indigo-600 bg-indigo-600 px-3.5 py-1.5 font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
          >
            {saving ? 'Saving…' : chosen ? `Set due ${when(chosen.toISOString(), now)}` : 'Set due'}
          </button>
        </div>
      </form>
      <DueHistory item={item} now={now} />
    </Modal>
  );
}

// ── Archive ───────────────────────────────────────────────────────────────────
const RESOLUTIONS: Resolution[] = ['done', 'not-mine', 'wont-do'];

function itemLinks(items: BriefingItemDoc[]): { label: string; url: string }[] {
  const seen = new Set<string>();
  const out: { label: string; url: string }[] = [];
  const add = (label: string, url: string | null | undefined): void => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ label, url });
  };
  for (const it of items) {
    add('Open thread', it.source?.threadUrl);
    add(items.length > 1 ? `Message: ${it.title.slice(0, 32)}` : 'Open message', it.source?.messageUrl);
    for (const l of it.links ?? []) add(`Open ${l.label}`, l.url);
  }
  return out;
}

export function ArchiveDialog({
  items,
  now,
  onClose,
}: {
  items: BriefingItemDoc[];
  now: number;
  onClose: () => void;
}) {
  const ids = useId();
  const [note, setNote] = useState('');
  const [resolution, setResolution] = useState<Resolution>('done');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const many = items.length > 1;
  const evidence = items.flatMap((it) => it.evidence ?? []);
  const links = itemLinks(items);

  const archive = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    const err = await post('/api/briefing/archive', {
      uids: items.map((i) => i.uid),
      resolution,
      note: note.trim() || undefined,
    });
    setSaving(false);
    if (err) setError(err);
    else onClose();
  };

  return (
    <Modal label={many ? 'Archive items' : 'Archive item'} onClose={onClose} wide>
      <h2 className="m-0 text-base font-bold">
        {many ? `Archive all ${items.length} items in this thread?` : 'Archive this item?'}
      </h2>
      <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
        {items.map((it) => (
          <ItemSummary key={it.uid} item={it} now={now} />
        ))}
      </div>

      {evidence.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h3 className="m-0 text-[13px] font-bold text-slate-300">What the master found</h3>
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[13px] text-green-300">
            {evidence.map((e, i) => (
              <li key={i}>
                {e.url ? (
                  <a href={e.url} target="_blank" rel="noreferrer" className="text-green-300 underline-offset-2 hover:underline">
                    {e.text}
                  </a>
                ) : (
                  e.text
                )}
                <span className="text-slate-500"> · {when(e.at, now)}</span>
              </li>
            ))}
          </ul>
          <p className="m-0 text-[12.5px] text-slate-400">
            This is a hint only. Check it yourself: the clock stops only when you archive.
          </p>
        </div>
      )}

      {links.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {links.map((l) => (
            <a
              key={l.url}
              href={l.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 px-3 py-1.5 text-[13px] text-slate-300 no-underline hover:bg-slate-800"
            >
              {l.label}
              <ExternalIcon size={12} />
            </a>
          ))}
        </div>
      )}

      <form
        className="flex flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          void archive();
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={`${ids}-note`} className="text-[12.5px] text-slate-400">
            How it was resolved (optional)
          </label>
          <textarea
            id={`${ids}-note`}
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className={`${inputCls} resize-y`}
          />
        </div>
        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
          <legend className="mb-1 text-[12.5px] text-slate-400">Resolved as</legend>
          <div className="flex flex-wrap gap-2">
            {RESOLUTIONS.map((r) => (
              <label
                key={r}
                className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] focus-within:ring-2 focus-within:ring-indigo-400 ${
                  resolution === r ? 'border-indigo-600 bg-indigo-950 text-indigo-200' : 'border-slate-700 text-slate-300'
                }`}
              >
                <input
                  type="radio"
                  name={`${ids}-res`}
                  value={r}
                  checked={resolution === r}
                  onChange={() => setResolution(r)}
                  className="accent-indigo-400"
                />
                {RESOLUTION_LABEL[r]}
              </label>
            ))}
          </div>
        </fieldset>
        {error && (
          <p role="alert" className="m-0 text-[12.5px] text-red-400">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={btnGhost}>
            Keep open
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md border border-red-600 bg-red-600 px-4 py-2 font-semibold text-white hover:bg-red-500 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
          >
            {saving ? 'Archiving…' : many ? `Archive ${items.length}` : 'Archive'}
          </button>
        </div>
      </form>
      <p className="m-0 text-[12.5px] text-slate-500">
        Archiving happens only here: the master has no archive. “Won’t do” and “Not mine” are counted separately in the
        daily log.
      </p>
    </Modal>
  );
}

/** Archive straight away (an FYI's one-click "Archive": read, done). */
export async function archiveNow(uids: string[], resolution: Resolution = 'done'): Promise<string | null> {
  return post('/api/briefing/archive', { uids, resolution });
}
