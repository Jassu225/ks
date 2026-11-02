'use client';
// /briefing — everything the master found in Slack that needs the person, one
// card per Slack thread (groupKey), in SECTION_ORDER, escalating live
// (screens: "Briefing page"). Only the person archives; see Dialogs.tsx.
import { useMemo, useState } from 'react';
import {
  SECTION_ORDER,
  groupItems,
  groupStage,
  sectionOf,
  stageOf,
  type BoardSection,
} from '@/lib/briefing-escalation';
import { useShared } from '@/lib/boardData';
import { isDone } from '@/lib/units';
import type { BriefingItemDoc, BriefingRunDoc, BriefingStage, MasterStatus, SessionDoc, WorkUnitDoc } from '@/lib/types';
import { AppHeader, masterLabel } from '../AppHeader';
import { ChevronIcon, ExternalIcon } from '../icons';
import { ArchiveDialog, DueDialog, archiveNow } from './Dialogs';
import {
  CARD_CLS,
  CHIP_CLS,
  KIND_CLS,
  KIND_LABEL,
  PILL_LABEL,
  RESOLUTION_LABEL,
  SECTION_META,
  dueText,
  hhmm,
  leftText,
  localDate,
  longDay,
  sourceLabel,
  span,
  when,
} from './format';

interface Group {
  groupKey: string;
  items: BriefingItemDoc[];
  stage: BriefingStage;
  stages: BriefingStage[];
  section: BoardSection;
}

type DialogState = { kind: 'due'; uid: string } | { kind: 'archive'; uids: string[] } | null;

const btnSmall =
  'rounded-md border px-2.5 py-1 text-[12.5px] focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400';

// ── data shaping ──────────────────────────────────────────────────────────────
function buildGroups(items: BriefingItemDoc[], now: number): Group[] {
  const d = new Date(now);
  return groupItems(items).map((g) => {
    const stages = g.items.map((it) => stageOf(it, d));
    const stage = groupStage(stages);
    // A card is FYI only when every item in it is; quick only when every ask is.
    const asks = g.items.filter((it) => it.kind !== 'fyi');
    const rep = {
      kind: asks.length === 0 ? ('fyi' as const) : ('ask' as const),
      quick: asks.length > 0 && asks.every((it) => it.quick),
      dueAt: (asks[0] ?? g.items[0]).dueAt,
    };
    return { groupKey: g.groupKey, items: g.items, stage, stages, section: sectionOf(stage, rep, d) };
  });
}

function nextSlot(schedule: string[], now: number): string | null {
  if (schedule.length === 0) return null;
  const d = new Date(now);
  const cur = hhmm(d);
  return schedule.find((s) => s > cur) ?? `${schedule[0]} tomorrow`;
}

function runLine(run: BriefingRunDoc | undefined, now: number): string {
  if (!run) return 'no run yet';
  if (run.status === 'running') return `run in progress since ${when(run.startedAt, now)}`;
  if (run.status === 'failed') return `last run ${when(run.startedAt, now)} failed${run.error ? `: ${run.error}` : ''}`;
  return `last run ${when(run.startedAt, now)} added ${run.added}, updated ${run.updated}`;
}

const isToday = (iso: string | null | undefined, now: number): boolean => !!iso && localDate(iso) === localDate(now);

// ── item row ──────────────────────────────────────────────────────────────────
function tagsFor(it: BriefingItemDoc, nextUp: boolean): string[] {
  const t: string[] = [];
  if (nextUp) t.push('next up');
  if (it.pushedCount > 0) t.push(`pushed ${it.pushedCount}×`);
  else if (it.dueSetByYou) t.push('due set by you');
  if (it.dueRule === 'message') t.push('deadline in message');
  if (Date.parse(it.clockStart) > Date.parse(it.receivedAt) + 60_000) t.push('weekend: clock from Mon 09:00');
  if (it.unit) t.push(it.unit);
  if (it.linkedTo) t.push('follows up an archived item');
  return t;
}

function ItemRow({
  it,
  stage,
  now,
  nextUp,
  onDue,
  onArchive,
}: {
  it: BriefingItemDoc;
  stage: BriefingStage;
  now: number;
  nextUp: boolean;
  onDue: () => void;
  onArchive: () => void;
}) {
  const ev = it.evidence?.[it.evidence.length - 1];
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-3">
      <div className="flex min-w-0 flex-[999_1_420px] flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-slate-400">
          <span className={`rounded px-2 py-0.5 text-[11px] font-bold tracking-wide ${KIND_CLS[it.kind]}`}>
            {KIND_LABEL[it.kind]}
          </span>
          <span>{sourceLabel(it)}</span>
          <span className="text-slate-500">·</span>
          <span title={it.source?.sentAt ? new Date(it.source.sentAt).toLocaleString() : undefined}>
            {when(it.source?.sentAt ?? it.receivedAt, now)}
          </span>
          {tagsFor(it, nextUp).map((t) => (
            <span key={t} className="rounded bg-slate-800 px-1.5 py-px text-xs text-slate-300">
              {t}
            </span>
          ))}
          {(it.links ?? []).map((l) => (
            <a
              key={l.url}
              href={l.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded bg-slate-800 px-1.5 py-px text-xs text-indigo-300 hover:text-indigo-200"
            >
              {l.label}
              <ExternalIcon size={10} />
            </a>
          ))}
        </div>
        <p className="m-0 text-[15px] text-slate-100">{it.title}</p>
        {it.source?.text && it.source.text !== it.title && (
          <p className="m-0 line-clamp-2 text-[13px] text-slate-400" title={it.source.text}>
            “{it.source.text}”
          </p>
        )}
        {it.why && <p className="m-0 text-[12.5px] text-slate-500">{it.why}</p>}
        {ev && (
          <p className="m-0 font-mono text-[12.5px] text-green-300">
            looks done? {ev.text}. Check, then archive.
          </p>
        )}
      </div>
      <div className="flex flex-[1_0_220px] flex-col items-end gap-2">
        <span className={CHIP_CLS[stage]}>{leftText(it.dueAt, now)}</span>
        <span className="font-mono text-xs text-slate-400" title={new Date(it.dueAt).toLocaleString()}>
          {dueText(it, now)}
        </span>
        <div className="flex gap-1.5">
          {it.source?.messageUrl && (
            <a
              href={it.source.messageUrl}
              target="_blank"
              rel="noreferrer"
              className={`${btnSmall} inline-flex items-center gap-1 border-slate-700 text-slate-300 no-underline hover:bg-slate-800`}
            >
              Slack
              <ExternalIcon size={11} />
            </a>
          )}
          <button type="button" onClick={onDue} className={`${btnSmall} border-slate-700 text-slate-300 hover:bg-slate-800`}>
            Due…
          </button>
          <button type="button" onClick={onArchive} className={`${btnSmall} border-red-700 text-red-400 hover:bg-red-950`}>
            Archive…
          </button>
        </div>
      </div>
    </div>
  );
}

// ── a card: one Slack thread ──────────────────────────────────────────────────
function GroupCard({
  g,
  now,
  nextUp,
  batch,
  setDialog,
}: {
  g: Group;
  now: number;
  nextUp: boolean;
  batch: boolean;
  setDialog: (d: DialogState) => void;
}) {
  const many = g.items.length > 1;
  const frame = batch
    ? 'border-b border-indigo-900 last:border-b-0 px-4 py-3'
    : `${CARD_CLS[g.stage]} rounded-[10px] px-4 py-3.5`;
  const head = g.items[0];
  return (
    <article className={`flex flex-col gap-3 ${frame}`} aria-label={head.title}>
      {many && (
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-slate-400">
          <span className="font-mono text-[11px] uppercase tracking-widest text-slate-500">
            Thread · {g.items.length} items
          </span>
          <span>{head.source?.channelName ?? ''}</span>
          {head.source?.threadUrl && (
            <a
              href={head.source.threadUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-indigo-300 hover:text-indigo-200"
            >
              open thread <ExternalIcon size={11} />
            </a>
          )}
          <span className="grow" />
          <button
            type="button"
            onClick={() => setDialog({ kind: 'archive', uids: g.items.map((i) => i.uid) })}
            className={`${btnSmall} border-red-800 text-red-400 hover:bg-red-950`}
          >
            Archive all…
          </button>
        </div>
      )}
      {g.items.map((it, i) => (
        <div key={it.uid} className={i > 0 ? 'border-t border-slate-800/80 pt-3' : ''}>
          <ItemRow
            it={it}
            stage={g.stages[i]}
            now={now}
            nextUp={nextUp && i === 0}
            onDue={() => setDialog({ kind: 'due', uid: it.uid })}
            onArchive={() => setDialog({ kind: 'archive', uids: [it.uid] })}
          />
        </div>
      ))}
    </article>
  );
}

function NextUp({ g, now, setDialog }: { g: Group; now: number; setDialog: (d: DialogState) => void }) {
  const it = g.items[0];
  const stage = g.stages[0];
  const hotFrame =
    stage === 'overdue'
      ? 'border-red-700 bg-[#2a0d12] shadow-[0_0_0_4px_rgba(248,113,113,0.12)]'
      : stage === 'hot'
        ? 'border-orange-700 bg-[#1c1208] shadow-[0_0_0_4px_rgba(251,146,60,0.10)]'
        : 'border-indigo-800 bg-slate-900 shadow-[0_0_0_4px_rgba(129,140,248,0.10)]';
  const accent = stage === 'overdue' ? 'text-red-300' : stage === 'hot' ? 'text-orange-300' : 'text-indigo-300';
  return (
    <section aria-label="Next up" className={`flex flex-col gap-2.5 rounded-[10px] border px-5 py-[18px] ${hotFrame}`}>
      <div className="flex flex-wrap items-center gap-2.5">
        <span className={`font-mono text-[11px] uppercase tracking-[0.1em] ${accent}`}>Next up</span>
        <span className={`rounded px-2 py-0.5 text-[11px] font-bold tracking-wide ${KIND_CLS[it.kind]}`}>
          {KIND_LABEL[it.kind]}
        </span>
        <span className={`text-[13px] ${accent}`}>
          {sourceLabel(it)} · {when(it.source?.sentAt ?? it.receivedAt, now)}
        </span>
        <span className="grow" />
        <span className={`${CHIP_CLS[stage]} text-[13px]`}>{leftText(it.dueAt, now)}</span>
      </div>
      <p className="m-0 text-lg font-semibold text-rose-50">{it.title}</p>
      {it.source?.text && it.source.text !== it.title && (
        <p className="m-0 line-clamp-3 text-sm text-slate-300">“{it.source.text}”</p>
      )}
      {it.why && <p className="m-0 text-[13px] text-rose-200/80">{it.why}</p>}
      <div className="flex flex-wrap gap-2">
        {it.source?.messageUrl && (
          <a
            href={it.source.messageUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md bg-slate-200 px-3.5 py-1.5 font-semibold text-slate-900 no-underline hover:bg-white"
          >
            Open in Slack <ExternalIcon size={13} />
          </a>
        )}
        <button
          type="button"
          onClick={() => setDialog({ kind: 'due', uid: it.uid })}
          className="rounded-md border border-red-900 px-3.5 py-1.5 text-red-200 hover:bg-red-950"
        >
          Change due…
        </button>
        <button
          type="button"
          onClick={() => setDialog({ kind: 'archive', uids: [it.uid] })}
          className="rounded-md border border-red-500 px-3.5 py-1.5 font-semibold text-red-400 hover:bg-red-950"
        >
          Archive…
        </button>
      </div>
    </section>
  );
}

// ── FYI (folded) ──────────────────────────────────────────────────────────────
function FyiSection({ groups, now }: { groups: Group[]; now: number }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = groups.flatMap((g) => g.items.map((it, i) => ({ it, stage: g.stages[i] })));
  if (rows.length === 0) return null;
  const meta = SECTION_META.fyi;
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-2.5 pt-1.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="inline-flex items-center gap-1.5 rounded text-[15px] font-bold text-slate-300 hover:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
        >
          <ChevronIcon open={open} size={14} />
          {meta.title}
        </button>
        <span className="font-mono text-xs text-slate-400">{rows.length}</span>
        <span className="text-[13px] text-slate-400">{meta.hint}</span>
      </div>
      {error && (
        <p role="alert" className="m-0 text-[12.5px] text-red-400">
          {error}
        </p>
      )}
      {open && (
        <div className="rounded-[10px] border border-slate-800 bg-[#0b1222]">
          {rows.map(({ it, stage }) => (
            <div key={it.uid} className="flex flex-wrap items-center gap-3 border-b border-slate-800 px-4 py-2.5 last:border-b-0">
              <span className="w-32 truncate font-mono text-xs text-slate-400" title={sourceLabel(it)}>
                {sourceLabel(it)}
              </span>
              <span className="min-w-0 flex-[999_1_360px] text-slate-300">
                {it.source?.messageUrl ? (
                  <a href={it.source.messageUrl} target="_blank" rel="noreferrer" className="text-slate-300 hover:text-white">
                    {it.title}
                  </a>
                ) : (
                  it.title
                )}
              </span>
              <span className={`font-mono text-xs ${stage === 'warm' ? 'text-amber-300' : 'text-slate-400'}`}>
                {dueText(it, now)}
              </span>
              <button
                type="button"
                disabled={busy === it.uid}
                onClick={async () => {
                  setBusy(it.uid);
                  setError(await archiveNow([it.uid]));
                  setBusy(null);
                }}
                title="Archive as read (Done)"
                className="rounded-md border border-slate-700 px-2.5 py-0.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
              >
                {busy === it.uid ? 'Archiving…' : 'Archive'}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── archived today ────────────────────────────────────────────────────────────
function ArchivedToday({ items, now }: { items: BriefingItemDoc[]; now: number }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="self-start rounded-md border border-dashed border-slate-700 px-3 py-1.5 text-[13px] text-slate-400 hover:text-slate-200"
      >
        {open ? 'Hide' : 'Show'} {items.length} archived today
      </button>
      {open && (
        <ul className="m-0 flex list-none flex-col rounded-[10px] border border-slate-800 bg-[#0b1222] p-0">
          {items.map((it) => (
            <li key={it.uid} className="flex flex-wrap items-baseline gap-3 border-b border-slate-800 px-4 py-2.5 text-[13px] last:border-b-0">
              <span className="font-mono text-xs text-slate-500">{when(it.archivedAt, now)}</span>
              <span className="rounded bg-slate-800 px-1.5 text-xs text-slate-300">
                {it.resolution ? RESOLUTION_LABEL[it.resolution] : 'archived'}
              </span>
              <span className="min-w-0 flex-1 text-slate-300">{it.title}</span>
              {it.archiveNote && <span className="text-slate-500">“{it.archiveNote}”</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── sidebar ───────────────────────────────────────────────────────────────────
function MasterCard({ master, lastRun, now }: { master: MasterStatus | null; lastRun?: BriefingRunDoc; now: number }) {
  const { refreshMaster } = useShared();
  // A note describes the master as it was when its button was pressed, so it
  // shows only while the master's state is still that one: once "Starting…"
  // turns live (or a restart goes through), it disappears by itself.
  const [noteRaw, setNoteRaw] = useState<{ text: string; state: string | undefined } | null>(null);
  const setNote = (text: string | null): void => setNoteRaw(text ? { text, state: master?.state } : null);
  const note = noteRaw && noteRaw.state === master?.state ? noteRaw.text : null;
  const [armed, setArmed] = useState(false);
  const l = masterLabel(master);
  const sched = master?.briefing;
  const next = sched ? (sched.enabled ? nextSlot(sched.schedule, now) : 'scheduled runs off') : '…';

  // Restart needs a running master; with none (or a dead one) the button
  // starts one instead, through the daemon.
  const running = !!master?.alive;
  const starting = master?.state === 'starting';

  const request = async (trigger: 'button' | 'restart' | 'start'): Promise<void> => {
    setNote(null);
    try {
      const r = await fetch('/api/briefing/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ trigger }),
      });
      const j = (await r.json()) as { dropped?: boolean; error?: string; why?: string };
      if (!r.ok) setNote(j.error ?? 'request failed');
      else if (trigger === 'start') {
        setNote(j.dropped ? `Not started: ${j.why ?? 'a master is already up'}.` : 'Starting the master…');
      }
      else if (j.dropped) setNote(trigger === 'button' ? 'A run is already waiting.' : 'A restart is already waiting.');
      else
        setNote(
          trigger === 'button'
            ? 'Asked: the master runs it as soon as it is idle.'
            : 'Asked: the master writes a handoff and restarts.',
        );
      void refreshMaster();
    } catch {
      setNote('Request failed — is the board server still running?');
    }
  };

  const s = master?.session;
  const handoff = s?.handoff ? s.handoff.split('/').pop() : null;
  return (
    <section className="flex flex-col gap-2.5 rounded-[10px] border border-slate-800 bg-slate-900 p-4">
      <div className="flex items-center gap-2">
        <span className={`h-[9px] w-[9px] rounded-full ${l.dot}`} aria-hidden="true" />
        <h2 className="m-0 text-sm font-bold">Master</h2>
        <span className={`text-[13px] ${l.cls.split(' ').find((c) => c.startsWith('text-')) ?? ''}`}>
          {master?.state === 'live' || master?.state === 'busy' ? `live · ${l.text}` : l.text}
        </span>
      </div>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
        <dt className="text-slate-400">Session</dt>
        <dd className="m-0 truncate font-mono text-xs" title={s?.sessionId}>
          {s ? `ks-master${s.tmuxPane ? ` · tmux ${s.tmuxPane}` : ''}` : 'not started'}
        </dd>
        {s?.startedAt && (
          <>
            <dt className="text-slate-400">Started</dt>
            <dd className="m-0">
              {when(s.startedAt, now)}
              {handoff ? `, from ${handoff}` : ''}
            </dd>
          </>
        )}
        <dt className="text-slate-400">Last run</dt>
        <dd className="m-0">
          {lastRun
            ? `${when(lastRun.startedAt, now)} · ${lastRun.trigger}${lastRun.slot ? ` ${lastRun.slot}` : ''} · ${
                lastRun.status === 'ok'
                  ? `${lastRun.added} new, ${lastRun.updated} updated`
                  : lastRun.status === 'running'
                    ? 'running'
                    : 'failed'
              }`
            : 'none yet'}
        </dd>
        <dt className="text-slate-400">Next run</dt>
        <dd className="m-0">{next}</dd>
        {master && master.pending.length > 0 && (
          <>
            <dt className="text-slate-400">Waiting</dt>
            <dd className="m-0">
              {master.pending.length} request{master.pending.length === 1 ? '' : 's'}
            </dd>
          </>
        )}
        {master?.heartbeatAgeMs != null && (
          <>
            <dt className="text-slate-400">Heartbeat</dt>
            <dd className="m-0">{span(master.heartbeatAgeMs)} ago</dd>
          </>
        )}
      </dl>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!running}
          onClick={() => void request('button')}
          title={running ? 'Ask the master for a Slack pass now' : 'No master is running: start one first'}
          className="rounded-md border border-indigo-600 bg-indigo-600 px-3 py-1.5 font-semibold text-white hover:bg-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 disabled:cursor-not-allowed disabled:border-slate-700 disabled:bg-slate-800 disabled:text-slate-500"
        >
          Brief me now
        </button>
        {running ? (
          <button
            type="button"
            onClick={() => {
              if (!armed) {
                setArmed(true);
                setTimeout(() => setArmed(false), 4000);
                return;
              }
              setArmed(false);
              void request('restart');
            }}
            className={`rounded-md border px-3 py-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
              armed ? 'border-amber-600 bg-amber-950 text-amber-200' : 'border-slate-700 text-slate-300 hover:bg-slate-800'
            }`}
          >
            {armed ? 'Confirm restart?' : 'Restart master'}
          </button>
        ) : (
          <button
            type="button"
            disabled={starting}
            onClick={() => void request('start')}
            title={starting ? 'A master was just launched and is still loading' : 'Ask the daemon to launch claude-ks-master in tmux'}
            className="rounded-md border border-emerald-700 px-3 py-1.5 text-emerald-300 hover:bg-emerald-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:cursor-default disabled:opacity-60"
          >
            {starting ? 'Starting…' : 'Start master'}
          </button>
        )}
        {master?.bridgeSessionId && (
          <a
            href={`https://claude.ai/code/${master.bridgeSessionId}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 px-3 py-1.5 text-slate-300 no-underline hover:bg-slate-800"
          >
            Open in Claude <ExternalIcon size={12} />
          </a>
        )}
      </div>
      {note && (
        <p role="status" className="m-0 text-[12.5px] text-slate-400">
          {note}
        </p>
      )}
    </section>
  );
}

interface RollRow {
  id: string;
  phase: string;
  state: string;
  cls: string;
  note: string;
  rank: number;
}

function rollCall(units: WorkUnitDoc[], sessions: SessionDoc[], liveWorktrees: Set<string>, now: number): RollRow[] {
  const latest = new Map<string, SessionDoc>();
  for (const s of sessions) {
    if (!s.worktreePath) continue;
    const cur = latest.get(s.worktreePath);
    if (!cur || (s.lastActivity ?? '') > (cur.lastActivity ?? '')) latest.set(s.worktreePath, s);
  }
  const pill = 'rounded-full px-2 py-px text-xs';
  const rows: RollRow[] = [];
  for (const u of units) {
    const onDisk = !!u.worktreeDir && liveWorktrees.has(u.worktreeDir);
    if (!onDisk) continue;
    const phase = u.currentPhase ? `Phase ${u.currentPhase.number}` : '';
    if (isDone(u)) {
      // Done tickets whose worktree is still on disk: "Done" in the phase slot
      // says it's finished, so the pill shows idle time like any other row.
      const last = (u.worktreeDir ? latest.get(u.worktreeDir)?.lastActivity : null) ?? u.lastActivity;
      rows.push({
        id: u.identifier,
        phase: 'Done',
        state: last ? `idle ${span(now - Date.parse(last))}` : 'idle',
        cls: `${pill} bg-slate-800 text-slate-400`,
        note: u.title,
        rank: 4,
      });
      continue;
    }
    const live = (u.liveSessions?.length ?? 0) > 0;
    const inbox = u.inbox?.needsYou ? u.inbox : null;
    const waiting = u.waiting?.active ? u.waiting : null;
    if (!live && !inbox && !waiting) continue;
    const q = inbox?.threads.flatMap((t) => t.questions)[0];
    const s = u.worktreeDir ? latest.get(u.worktreeDir) : undefined;
    if (inbox) {
      rows.push({
        id: u.identifier,
        phase,
        state: 'Inbox question',
        cls: `${pill} bg-rose-950 text-rose-300`,
        note: `${inbox.stopped ? 'Stopped on you' : 'Waiting on you'}${q ? `: ${q.prompt}` : ''}`,
        rank: 0,
      });
    } else if (waiting) {
      rows.push({
        id: u.identifier,
        phase,
        state: 'waiting on you',
        cls: `${pill} bg-yellow-950 text-amber-300`,
        note: `${waiting.tool || 'Prompt'} for ${span(now - Date.parse(waiting.since))}`,
        rank: 1,
      });
    } else if (s?.activity === 'active') {
      rows.push({ id: u.identifier, phase, state: 'busy', cls: `${pill} bg-green-950 text-green-300`, note: u.title, rank: 2 });
    } else {
      const idle = s?.lastActivity ? ` ${span(now - Date.parse(s.lastActivity))}` : '';
      rows.push({ id: u.identifier, phase, state: `idle${idle}`, cls: `${pill} bg-slate-800 text-slate-300`, note: u.title, rank: 3 });
    }
  }
  return rows.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
}

function SessionsCard({ rows }: { rows: RollRow[] }) {
  return (
    <section className="flex flex-col gap-2.5 rounded-[10px] border border-slate-800 bg-slate-900 p-4">
      <div className="flex items-baseline gap-2">
        <h2 className="m-0 text-sm font-bold">Sessions</h2>
        <span className="text-[12.5px] text-slate-400">roll call, live from the board</span>
      </div>
      {rows.length === 0 && <p className="m-0 text-[12.5px] text-slate-500">No live sessions.</p>}
      {rows.map((r) => (
        <div key={r.id} className="flex flex-col gap-0.5 border-t border-slate-800 py-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[12.5px] font-semibold text-slate-200">{r.id}</span>
            <span className="text-[12.5px] text-slate-400">{r.phase}</span>
            <span className="grow" />
            <span className={r.cls}>{r.state}</span>
          </div>
          <span className="truncate text-[12.5px] text-slate-400" title={r.note}>
            {r.note}
          </span>
        </div>
      ))}
    </section>
  );
}

function TodayCard({ items, now }: { items: BriefingItemDoc[]; now: number }) {
  const { briefing } = useShared();
  const archived = items.filter((i) => i.status === 'archived' && isToday(i.archivedAt, now)).length;
  const created = items.filter((i) => isToday(i.createdAt, now)).length;
  const pushed = items.reduce(
    (n, i) =>
      n +
      (i.dueHistory ?? []).filter(
        (h) => h.by === 'you' && isToday(h.at, now) && h.from != null && Date.parse(h.to) > Date.parse(h.from),
      ).length,
    0,
  );
  const log = briefing.dailyLogs.find((d) => d.uid === localDate(now));
  return (
    <section className="flex flex-col gap-2 rounded-[10px] border border-slate-800 bg-slate-900 p-4">
      <h2 className="m-0 text-sm font-bold">Today so far</h2>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="flex flex-col">
          <span className="text-xl font-bold">{archived}</span>
          <span className="text-xs text-slate-400">archived</span>
        </div>
        <div className="flex flex-col">
          <span className="text-xl font-bold">{created}</span>
          <span className="text-xs text-slate-400">new</span>
        </div>
        <div className="flex flex-col">
          <span className={`text-xl font-bold ${pushed > 0 ? 'text-red-300' : ''}`}>{pushed}</span>
          <span className="text-xs text-slate-400">pushed</span>
        </div>
      </div>
      <span className="text-[12.5px] text-slate-400">
        {log?.logInAt ? `Logged in ${when(log.logInAt, now)}` : 'Not logged in yet (/ks-master:log-in)'}
        {log?.logOffAt ? ` · logged off ${when(log.logOffAt, now)}` : ''}
      </span>
    </section>
  );
}

// ── the page ──────────────────────────────────────────────────────────────────
export function BriefingPage() {
  const { config, board, briefing, master, now } = useShared();
  const [dialog, setDialog] = useState<DialogState>(null);

  const groups = useMemo(() => buildGroups(briefing.items, now), [briefing.items, now]);
  const bySection = useMemo(() => {
    const m = new Map<BoardSection, Group[]>();
    for (const s of SECTION_ORDER) m.set(s, []);
    for (const g of groups) m.get(g.section)!.push(g);
    return m;
  }, [groups]);
  const firstSection = SECTION_ORDER.find((s) => (bySection.get(s)?.length ?? 0) > 0);
  const nextUp = firstSection ? bySection.get(firstSection)![0] : null;

  const archivedToday = useMemo(
    () =>
      briefing.items
        .filter((i) => i.status === 'archived' && isToday(i.archivedAt, now))
        .sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? '')),
    [briefing.items, now],
  );

  const liveWorktrees = useMemo(() => new Set(board.project?.worktreePaths ?? []), [board.project]);
  const roll = useMemo(
    () => rollCall(board.workUnits, board.sessions, liveWorktrees, now),
    [board.workUnits, board.sessions, liveWorktrees, now],
  );

  const byUid = useMemo(() => new Map(briefing.items.map((i) => [i.uid, i])), [briefing.items]);
  const dueItem = dialog?.kind === 'due' ? byUid.get(dialog.uid) : undefined;
  const archiveItems =
    dialog?.kind === 'archive'
      ? dialog.uids.map((u) => byUid.get(u)).filter((i): i is BriefingItemDoc => !!i && i.status === 'open')
      : [];

  const pills = SECTION_ORDER.map((s) => ({
    s,
    n: (bySection.get(s) ?? []).reduce((n, g) => n + g.items.length, 0),
  })).filter((p) => p.n > 0);

  const sched = master?.briefing;
  const nextRun = sched?.enabled ? nextSlot(sched.schedule, now) : null;
  const subtitle = [
    `${longDay(new Date(now))} · ${hhmm(new Date(now))}`,
    runLine(briefing.runs[0], now),
    nextRun ? `next run ${nextRun}` : sched ? 'scheduled runs off' : null,
  ]
    .filter(Boolean)
    .join(' · ');

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
      <div className="mx-auto flex max-w-[1392px] flex-wrap items-start gap-6 p-6">
        <main className="flex min-w-0 flex-[999_1_720px] flex-col gap-5">
          <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
            <div className="flex flex-col gap-0.5">
              <h1 className="m-0 text-[22px] font-bold text-slate-50">Briefing</h1>
              <span className="text-[13px] text-slate-400">{subtitle}</span>
            </div>
            <div className="grow" />
            <div className="flex flex-wrap gap-2 text-[13px]">
              {pills.map((p) => (
                <span key={p.s} className={`rounded-full px-2.5 py-1 ${SECTION_META[p.s].pill}`}>
                  {p.n} {PILL_LABEL[p.s]}
                </span>
              ))}
            </div>
          </div>

          {!briefing.loaded ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : groups.length === 0 ? (
            <div className="rounded-[10px] border border-slate-800 bg-slate-900 p-5 text-sm text-slate-400">
              Nothing on your list. The master adds what Slack asks of you at each run; “Brief me now” runs one.
            </div>
          ) : null}

          {nextUp && <NextUp g={nextUp} now={now} setDialog={setDialog} />}

          {SECTION_ORDER.filter((s) => s !== 'fyi').map((s) => {
            const gs = bySection.get(s) ?? [];
            if (gs.length === 0) return null;
            const meta = SECTION_META[s];
            const batch = s === 'quick';
            const n = gs.reduce((k, g) => k + g.items.length, 0);
            return (
              <section key={s} className="flex flex-col gap-2" aria-labelledby={`sec-${s}`}>
                <div className="flex flex-wrap items-baseline gap-2.5 pt-1.5">
                  <h2 id={`sec-${s}`} className={`m-0 text-[15px] font-bold ${meta.cls}`}>
                    {meta.title}
                  </h2>
                  <span className="font-mono text-xs text-slate-400">{n}</span>
                  <span className="text-[13px] text-slate-400">{meta.hint}</span>
                </div>
                <div
                  className={
                    batch
                      ? 'flex flex-col rounded-[10px] border border-indigo-800 bg-[#0d1030]'
                      : 'flex flex-col gap-2'
                  }
                >
                  {gs.map((g) => (
                    <GroupCard
                      key={g.groupKey}
                      g={g}
                      now={now}
                      nextUp={g === nextUp}
                      batch={batch}
                      setDialog={setDialog}
                    />
                  ))}
                </div>
              </section>
            );
          })}

          <FyiSection groups={bySection.get('fyi') ?? []} now={now} />
          <ArchivedToday items={archivedToday} now={now} />
        </main>

        <aside className="flex min-w-0 flex-[1_1_320px] flex-col gap-4">
          <MasterCard master={master} lastRun={briefing.runs[0]} now={now} />
          <SessionsCard rows={roll} />
          <TodayCard items={briefing.items} now={now} />
        </aside>
      </div>

      {dueItem && dueItem.status === 'open' && (
        <DueDialog key={dueItem.uid} item={dueItem} now={now} onClose={() => setDialog(null)} />
      )}
      {archiveItems.length > 0 && <ArchiveDialog items={archiveItems} now={now} onClose={() => setDialog(null)} />}
    </div>
  );
}
