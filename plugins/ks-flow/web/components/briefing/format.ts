// Shared formatting and styling for the Briefing and Daily log pages.
import type { BoardSection } from '@/lib/briefing-escalation';
import type { BriefingItemDoc, BriefingStage, Resolution } from '@/lib/types';

const pad = (n: number): string => String(n).padStart(2, '0');

/** "14:02" */
export const hhmm = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "Monday 2 Nov" */
export const longDay = (d: Date): string =>
  `${d.toLocaleDateString('en-GB', { weekday: 'long' })} ${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'short' })}`;

/** "Mon 2 Nov" */
export const shortDay = (d: Date): string =>
  `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'short' })}`;

/** "14:02" today, "Fri 14:02" within the week, "Fri 30 Oct 14:02" further off. */
export function when(iso: string | null | undefined, now: number): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const n = new Date(now);
  if (sameDay(d, n)) return hhmm(d);
  const days = Math.abs(d.getTime() - now) / 86_400_000;
  const wd = d.toLocaleDateString('en-GB', { weekday: 'short' });
  return days < 6 ? `${wd} ${hhmm(d)}` : `${shortDay(d)} ${hhmm(d)}`;
}

/** A duration as "2d 15h" / "1h 15m" / "40m" / "<1m". */
export function span(ms: number): string {
  const m = Math.floor(Math.abs(ms) / 60_000);
  if (m < 1) return '<1m';
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return h ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return mm ? `${h}h ${mm}m` : `${h}h`;
  return `${mm}m`;
}

/** The chip text: "overdue 40m" / "1h 15m left". */
export function leftText(dueAt: string, now: number): string {
  const ms = Date.parse(dueAt) - now;
  return ms <= 0 ? `overdue ${span(ms)}` : `${span(ms)} left`;
}

/** "due Mon 11:55" / "was due Fri 19:00" (an fyi: "read by …"). */
export function dueText(item: Pick<BriefingItemDoc, 'dueAt' | 'kind'>, now: number): string {
  const past = Date.parse(item.dueAt) <= now;
  if (item.kind === 'fyi') return `read by ${when(item.dueAt, now)}`;
  return `${past ? 'was due' : 'due'} ${when(item.dueAt, now)}`;
}

/** Where it came from: "DM · Marcus", "#ai · Dana", "#ai thread" (your own promise). */
export function sourceLabel(item: BriefingItemDoc): string {
  const s = item.source;
  const where = s?.channelName || 'Slack';
  if (item.kind === 'promise') return `${where}${s?.threadTs ? ' thread' : ''}`;
  return s?.from?.name ? `${where} · ${s.from.name}` : where;
}

export const KIND_LABEL: Record<BriefingItemDoc['kind'], string> = {
  ask: 'ASK',
  promise: 'YOU PROMISED',
  fyi: 'FYI',
};

export const KIND_CLS: Record<BriefingItemDoc['kind'], string> = {
  ask: 'bg-slate-800 text-slate-200',
  promise: 'bg-rose-950 text-rose-300',
  fyi: 'bg-slate-800 text-slate-400',
};

const CHIP_BASE = 'whitespace-nowrap rounded-full px-2.5 py-0.5 font-mono text-[12.5px] font-semibold';
export const CHIP_CLS: Record<BriefingStage, string> = {
  overdue: `${CHIP_BASE} bg-red-600 text-white`,
  hot: `${CHIP_BASE} border border-orange-800 bg-orange-950 text-orange-300`,
  warm: `${CHIP_BASE} border border-yellow-800 bg-yellow-950 text-amber-300`,
  calm: `${CHIP_BASE} border border-blue-900 bg-blue-950 text-blue-300`,
};

/** A card's frame, by its (worst) stage. */
export const CARD_CLS: Record<BriefingStage, string> = {
  overdue: 'border border-red-900 bg-[#2a0d12]',
  hot: 'border border-orange-800 bg-[#1c1208]',
  warm: 'border border-slate-800 bg-slate-900',
  calm: 'border border-slate-800 bg-slate-900',
};

export const SECTION_META: Record<BoardSection, { title: string; hint: string; cls: string; pill: string }> = {
  overdue: {
    title: 'Overdue',
    hint: 'Past due. They stay red until you archive them.',
    cls: 'text-red-300',
    pill: 'bg-red-600 text-white font-semibold',
  },
  hot: {
    title: 'Hot',
    hint: 'More than 80% of the time is gone.',
    cls: 'text-orange-300',
    pill: 'border border-orange-800 bg-orange-950 text-orange-300',
  },
  quick: {
    title: 'Quick replies',
    hint: 'Small asks grouped to clear in one go. Hot and overdue items are never grouped.',
    cls: 'text-indigo-200',
    pill: 'border border-indigo-800 bg-indigo-950 text-indigo-200',
  },
  today: {
    title: 'Due today',
    hint: 'Due before midnight, nearest first.',
    cls: 'text-amber-300',
    pill: 'border border-yellow-800 bg-yellow-950 text-amber-300',
  },
  later: {
    title: 'Later',
    hint: 'Due tomorrow or after.',
    cls: 'text-blue-300',
    pill: 'border border-blue-900 bg-blue-950 text-blue-300',
  },
  fyi: {
    title: 'Worth knowing',
    hint: 'Mentions and DMs that ask nothing of you. Read once and archive. These never turn red.',
    cls: 'text-slate-300',
    pill: 'border border-slate-700 bg-slate-800 text-slate-300',
  },
};

/** The pill label in the page header: "2 overdue", "4 due today", "3 FYI". */
export const PILL_LABEL: Record<BoardSection, string> = {
  overdue: 'overdue',
  hot: 'hot',
  quick: 'quick',
  today: 'due today',
  later: 'later',
  fyi: 'FYI',
};

export const RESOLUTION_LABEL: Record<Resolution, string> = {
  done: 'Done',
  'not-mine': 'Not mine',
  'wont-do': "Won't do",
};

/** The local calendar date of an ISO time, 'YYYY-MM-DD' (daily_logs' uid). */
export function localDate(iso: string | number | Date): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 'YYYY-MM-DDTHH:MM' for <input type="datetime-local"> from an ISO time. */
export function toLocalInput(iso: string | number | Date): string {
  const d = new Date(iso);
  return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
