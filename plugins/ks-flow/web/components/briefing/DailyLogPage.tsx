'use client';
// /daily — one day's log (screens: "Log-off review"): the daily_logs doc that
// /ks-master:log-in and log-off write, plus what happened to the briefing
// items that day (archived, new, went overdue, pushed, still open).
import { useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { stageOf } from '@/lib/briefing-escalation';
import { useShared } from '@/lib/boardData';
import { WINDOW_DAYS } from '@/lib/useBriefing';
import type { BriefingItemDoc, DailyLogDoc, Resolution } from '@/lib/types';
import { AppHeader } from '../AppHeader';
import { ArchiveDialog } from './Dialogs';
import { CHIP_CLS, RESOLUTION_LABEL, hhmm, localDate, longDay, shortDay, span, when } from './format';

const pill = 'justify-self-start rounded-full px-2 py-px text-xs';

/** Local midnight of a 'YYYY-MM-DD' day, plus `days`. */
function dayStart(day: string, days = 0): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d + days);
}

const onDay = (iso: string | null | undefined, day: string): boolean => !!iso && localDate(iso) === day;

/** Minutes → "6h 40m". */
const mins = (m: number): string => span(m * 60_000);

// The log-off part is free-form (Record<string, unknown>); read what it holds
// when it has the shapes below, and skip it otherwise.
function engagedMinutes(log: DailyLogDoc | undefined): number | null {
  const v = log?.logOff?.engagedMinutes ?? log?.logIn?.engagedMinutes;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function timeRows(log: DailyLogDoc | undefined): { id: string; minutes: number }[] {
  const raw = log?.logOff?.time;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => {
      const o = (r ?? {}) as Record<string, unknown>;
      const id = typeof o.unit === 'string' ? o.unit : typeof o.id === 'string' ? o.id : null;
      const minutes = typeof o.minutes === 'number' ? o.minutes : null;
      return id && minutes != null ? { id, minutes } : null;
    })
    .filter((r): r is { id: string; minutes: number } => !!r)
    .sort((a, b) => b.minutes - a.minutes);
}

function textOf(v: unknown): string[] {
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  return [];
}

function Tile({ n, label, tone = 'plain' }: { n: number; label: string; tone?: 'plain' | 'red' | 'amber' }) {
  return (
    <div
      className={`flex flex-col gap-0.5 rounded-[10px] border px-4 py-3.5 ${
        tone === 'red' && n > 0 ? 'border-red-900 bg-[#2a0d12]' : 'border-slate-800 bg-slate-900'
      }`}
    >
      <span
        className={`text-2xl font-bold ${
          tone === 'red' && n > 0 ? 'text-red-300' : tone === 'amber' && n > 0 ? 'text-amber-300' : ''
        }`}
      >
        {n}
      </span>
      <span className={`text-[12.5px] ${tone === 'red' && n > 0 ? 'text-red-200' : 'text-slate-400'}`}>{label}</span>
    </div>
  );
}

function Card({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 rounded-[10px] border border-slate-800 bg-slate-900 p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="m-0 text-[15px] font-bold">{title}</h2>
        {sub && <span className="text-[12.5px] text-slate-400">{sub}</span>}
      </div>
      {children}
    </section>
  );
}

export function DailyLogPage() {
  const { config, briefing, now } = useShared();
  const today = localDate(now);
  // ?date=YYYY-MM-DD opens that day (the Activity Log's log-in / log-off rows link here).
  const asked = useSearchParams()?.get('date');
  const [day, setDay] = useState(() => (asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) && asked <= today ? asked : today));
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [archiveUid, setArchiveUid] = useState<string | null>(null);

  const isToday = day === today;
  const end = dayStart(day, 1).getTime();
  const oldest = localDate(now - (WINDOW_DAYS - 1) * 86_400_000);
  const log = briefing.dailyLogs.find((d) => d.uid === day || d.date === day);
  const items = briefing.items;

  const s = useMemo(() => {
    const archived = items.filter((i) => i.status === 'archived' && onDay(i.archivedAt, day));
    const byRes: Record<Resolution, number> = { done: 0, 'not-mine': 0, 'wont-do': 0 };
    for (const i of archived) if (i.resolution) byRes[i.resolution]++;
    const created = items.filter((i) => onDay(i.createdAt, day));
    // Went overdue that day: due that day, and not archived before its due time.
    const slipped = items
      .filter((i) => i.kind !== 'fyi' && onDay(i.dueAt, day) && Date.parse(i.dueAt) <= now)
      .filter((i) => i.status === 'open' || (i.archivedAt != null && Date.parse(i.archivedAt) > Date.parse(i.dueAt)))
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    const pushed = items.flatMap((i) =>
      (i.dueHistory ?? [])
        .filter((h) => h.by === 'you' && onDay(h.at, day) && h.from != null && Date.parse(h.to) > Date.parse(h.from))
        .map((h) => ({ item: i, h })),
    );
    // Open at the end of that day (now, for today).
    const cutoff = isToday ? now : end;
    const stillOpen = items
      .filter(
        (i) =>
          Date.parse(i.createdAt) < cutoff &&
          (i.status === 'open' || (i.archivedAt != null && Date.parse(i.archivedAt) >= cutoff)),
      )
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    const promises = items
      .filter((i) => i.status === 'open' && i.kind === 'promise' && onDay(i.dueAt, localDate(end)))
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    return { archived, byRes, created, slipped, pushed, stillOpen, promises };
  }, [items, day, isToday, end, now]);

  const engaged = engagedMinutes(log);
  const times = timeRows(log);
  const maxTime = times[0]?.minutes ?? 0;
  const plan = textOf(log?.logIn?.plan);
  const summary = textOf(log?.logOff?.summary);
  const archiveItem = archiveUid ? items.find((i) => i.uid === archiveUid && i.status === 'open') : undefined;

  const go = (delta: number): void => {
    setDay(localDate(dayStart(day, delta)));
    setHidden(new Set());
  };
  const resParts = (Object.keys(s.byRes) as Resolution[])
    .filter((r) => s.byRes[r] > 0)
    .map((r) => `${s.byRes[r]} ${RESOLUTION_LABEL[r].toLowerCase()}`);

  const open = s.stillOpen.filter((i) => !hidden.has(i.uid));
  const navBtn =
    'rounded-md border border-slate-700 px-3 py-1.5 text-slate-300 hover:bg-slate-800 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400';

  if (!config.projectId) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-200">
        <AppHeader />
        <p className="p-6 text-sm text-slate-400">No project configured — set one in Settings.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-[14px] leading-normal text-slate-200">
      <AppHeader />
      <div className="mx-auto flex max-w-[1280px] flex-col gap-[22px] px-6 py-8 sm:px-10">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-slate-400">
              Daily log{log?.logOffAt ? ' · written by /ks-master:log-off' : log?.logInAt ? ' · from /ks-master:log-in' : ''}
            </span>
            <h1 className="m-0 text-[22px] font-bold text-slate-50">{longDay(dayStart(day))}</h1>
            <span className="text-[13px] text-slate-400">
              {[
                log?.logInAt ? `Logged in ${hhmm(new Date(log.logInAt))}` : 'No log-in recorded',
                log?.logOffAt ? `logged off ${hhmm(new Date(log.logOffAt))}` : isToday ? 'not logged off yet' : null,
                engaged != null ? `engaged ${mins(engaged)}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>
          <div className="grow" />
          <nav aria-label="Days" className="flex gap-1.5">
            <button type="button" className={navBtn} disabled={day <= oldest} onClick={() => go(-1)}>
              ‹ {shortDay(dayStart(day, -1))}
            </button>
            {!isToday && (
              <button type="button" className={navBtn} onClick={() => go(1)}>
                {shortDay(dayStart(day, 1))} ›
              </button>
            )}
            {!isToday && (
              <button
                type="button"
                className={navBtn}
                onClick={() => {
                  setDay(today);
                  setHidden(new Set());
                }}
              >
                Today
              </button>
            )}
          </nav>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
          <Tile n={s.archived.length} label={`archived${resParts.length ? ` · ${resParts.join(', ')}` : ''}`} />
          <Tile n={s.created.length} label={isToday ? 'new today' : 'new that day'} />
          <Tile n={s.slipped.length} label={isToday ? 'went overdue today' : 'went overdue'} tone="red" />
          <Tile n={s.pushed.length} label="due times pushed" tone="amber" />
          <Tile n={s.stillOpen.length} label={isToday ? 'still open, carried to tomorrow' : 'open at end of day'} />
        </div>

        {(plan.length > 0 || summary.length > 0) && (
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            {plan.length > 0 && (
              <Card title="Plan at log-in">
                <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[13px] text-slate-300">
                  {plan.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </Card>
            )}
            {summary.length > 0 && (
              <Card title="At log-off">
                {summary.map((p, i) => (
                  <p key={i} className="m-0 text-[13px] text-slate-300">
                    {p}
                  </p>
                ))}
              </Card>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <Card title={isToday ? 'Still open: archive or keep?' : 'Open at end of day'} sub={isToday ? 'the master asks one by one' : undefined}>
            {open.length === 0 && <p className="m-0 text-[13px] text-slate-500">Nothing open.</p>}
            {open.map((i) => (
              <OpenRow
                key={i.uid}
                item={i}
                now={now}
                onKeep={() => setHidden((h) => new Set(h).add(i.uid))}
                onArchive={i.status === 'open' ? () => setArchiveUid(i.uid) : null}
              />
            ))}
          </Card>

          <Card title="Promises due tomorrow">
            {s.promises.length === 0 && <p className="m-0 text-[13px] text-slate-500">None.</p>}
            <div className="flex flex-col">
              {s.promises.map((i) => (
                <div key={i.uid} className="flex items-baseline gap-2.5 border-t border-slate-800 py-2">
                  <span className="w-[88px] shrink-0 font-mono text-[12.5px] text-blue-300">{when(i.dueAt, now)}</span>
                  <span className="text-[13px]">
                    {i.title}
                    <span className="text-slate-500"> ({i.source?.channelName ?? 'Slack'}, said {when(i.source?.sentAt, now)})</span>
                  </span>
                </div>
              ))}
            </div>
            <h2 className="m-0 mt-2 text-[15px] font-bold">{isToday ? 'Slipped today' : 'Slipped'}</h2>
            {s.slipped.length === 0 && <p className="m-0 text-[13px] text-slate-500">Nothing went overdue.</p>}
            <div className="flex flex-col gap-1.5 text-[13px]">
              {s.slipped.map((i) => (
                <span key={i.uid}>
                  <span className="text-red-300">Overdue {hhmm(new Date(i.dueAt))}</span> · {i.title}{' '}
                  <span className="text-slate-400">({slipNote(i, now)})</span>
                </span>
              ))}
            </div>
          </Card>
        </div>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <Card title="Sessions at log-off" sub="where each one stopped">
            {(log?.sessions ?? []).length === 0 && (
              <p className="m-0 text-[13px] text-slate-500">
                {log?.logOffAt ? 'No sessions recorded.' : 'Written by /ks-master:log-off.'}
              </p>
            )}
            {(log?.sessions ?? []).map((x, i) => (
              <div
                key={`${x.unit}-${i}`}
                className="grid grid-cols-[92px_minmax(0,1fr)_150px] items-baseline gap-2.5 border-t border-slate-800 py-2 text-[13px]"
              >
                <span className="font-mono font-semibold">{x.unit}</span>
                <span className="text-slate-300">
                  {x.lastDid}
                  {x.phase && <span className="text-slate-500"> · {x.phase}</span>}
                </span>
                <span className={`${pill} ${sessionTone(x.suggestion ?? x.state)}`}>{x.suggestion ?? x.state}</span>
              </div>
            ))}
          </Card>

          <Card title="Engaged time" sub={engaged != null ? `from ks-time · ${mins(engaged)}` : 'from ks-time'}>
            {times.length === 0 && (
              <p className="m-0 text-[13px] text-slate-500">Written by /ks-master:log-off (logOff.time).</p>
            )}
            {times.map((t) => (
              <div key={t.id} className="grid grid-cols-[92px_minmax(0,1fr)_64px] items-center gap-2.5 text-[13px]">
                <span className="truncate font-mono">{t.id}</span>
                <div className="h-2.5 rounded-[5px] bg-slate-800" role="presentation">
                  <div
                    className="h-2.5 rounded-[5px] bg-indigo-400"
                    style={{ width: `${maxTime ? Math.max(2, (t.minutes / maxTime) * 100) : 0}%` }}
                  />
                </div>
                <span className="text-right font-mono text-slate-400">{mins(t.minutes)}</span>
              </div>
            ))}
          </Card>
        </div>
      </div>

      {archiveItem && <ArchiveDialog items={[archiveItem]} now={now} onClose={() => setArchiveUid(null)} />}
    </div>
  );
}

function OpenRow({
  item,
  now,
  onKeep,
  onArchive,
}: {
  item: BriefingItemDoc;
  now: number;
  onKeep: () => void;
  onArchive: (() => void) | null;
}) {
  const stage = stageOf(item, new Date(now));
  const what = item.kind === 'promise' ? 'your promise' : item.kind === 'fyi' ? 'FYI' : item.source?.from?.name ?? 'ask';
  return (
    <div className="flex items-center gap-2.5 border-t border-slate-800 py-2">
      <span className={`${CHIP_CLS[stage]} !px-2 !text-[11.5px]`}>{stage}</span>
      <span className="min-w-0 flex-auto text-[13px]">
        {item.title} <span className="text-slate-500">({what}, since {when(item.receivedAt, now)})</span>
      </span>
      {item.status === 'archived' ? (
        <span className="text-xs text-slate-500">archived {when(item.archivedAt, now)}</span>
      ) : (
        <>
          <button
            type="button"
            onClick={onKeep}
            title="Keep it open (hides it from this list)"
            className="rounded-md border border-slate-700 px-2.5 py-0.5 text-[12.5px] text-slate-300 hover:bg-slate-800"
          >
            Keep
          </button>
          {onArchive && (
            <button
              type="button"
              onClick={onArchive}
              className="rounded-md border border-red-700 px-2.5 py-0.5 text-[12.5px] text-red-400 hover:bg-red-950"
            >
              Archive…
            </button>
          )}
        </>
      )}
    </div>
  );
}

function slipNote(i: BriefingItemDoc, now: number): string {
  const due = Date.parse(i.dueAt);
  const parts: string[] = [];
  const pushes = (i.dueHistory ?? []).filter((h) => h.by === 'you' && Date.parse(h.at) >= due);
  if (pushes.length) parts.push(`pushed to ${when(pushes[pushes.length - 1].to, now)}`);
  if (i.status === 'archived' && i.archivedAt) {
    parts.push(`archived ${hhmm(new Date(i.archivedAt))}, ${span(Date.parse(i.archivedAt) - due)} late`);
  } else parts.push('still open');
  return parts.join(', ');
}

function sessionTone(label: string): string {
  const l = label.toLowerCase();
  if (l.includes('answer') || l.includes('inbox') || l.includes('stopped')) return 'bg-rose-950 text-rose-300';
  if (l.includes('running') || l.includes('busy') || l.includes('leave')) return 'bg-green-950 text-green-300';
  if (l.includes('idle') || l.includes('close') || l.includes('plan') || l.includes('waiting')) return 'bg-yellow-950 text-amber-300';
  return 'bg-slate-800 text-slate-300';
}
