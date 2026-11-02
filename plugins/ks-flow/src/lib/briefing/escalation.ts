// lib/briefing/escalation.ts — when a briefing item is due and how hot it is now.
//
// Pure, no imports: the board keeps a verbatim copy at web/lib/briefing-
// escalation.ts (only the first line differs; escalation.test.ts checks it), so
// edit this file and copy it over. Local time is the machine's timezone, and
// every calendar step builds a new Date from local parts, so DST days stay right.
//
// An item's clock runs from clockStart (received, or Monday 09:00 when received
// on a weekend) to dueAt; the share of it used up sets the stage.

export type BriefingKind = 'ask' | 'promise' | 'fyi';
export type BriefingStage = 'calm' | 'warm' | 'hot' | 'overdue';
export type DueRule = 'message' | 'promise' | 'dm' | 'mention' | 'fyi' | 'manual';

/** Share of the window used up at which an item turns warm / hot. */
export const STAGE_AT = { warm: 0.5, hot: 0.8 } as const;

const HOUR = 3_600_000;

/** Hours from clockStart for the rules that are a plain window. */
const WINDOW_HOURS: Record<'dm' | 'mention' | 'fyi' | 'manual' | 'promise', number> = {
  dm: 4,
  mention: 24,
  fyi: 24,
  manual: 24, // a manual item normally comes with its own dueAt
  promise: 24, // a promise with no time said
};

const STAGE_RANK: Record<BriefingStage, number> = { calm: 0, warm: 1, hot: 2, overdue: 3 };

function isWeekend(d: Date): boolean {
  const day = d.getDay();
  return day === 0 || day === 6;
}

/** `d`'s local calendar day moved by `days`, at the given local time. */
function atLocal(d: Date, days: number, h: number, m = 0, s = 0, ms = 0): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, h, m, s, ms);
}

/** elapsed = (now - clockStart) / (dueAt - clockStart): ≥1 overdue, ≥0.8 hot,
 * ≥0.5 warm, else calm. An fyi never passes warm. A window that is empty or
 * negative (dueAt ≤ clockStart) is hot until dueAt, then overdue. */
export function stageOf(
  item: { clockStart: string; dueAt: string; fyiCap: boolean },
  now: Date,
): BriefingStage {
  const start = Date.parse(item.clockStart);
  const due = Date.parse(item.dueAt);
  const t = now.getTime();
  let stage: BriefingStage;
  if (due <= start) stage = t >= due ? 'overdue' : 'hot';
  else {
    const elapsed = (t - start) / (due - start);
    stage =
      elapsed >= 1 ? 'overdue' : elapsed >= STAGE_AT.hot ? 'hot' : elapsed >= STAGE_AT.warm ? 'warm' : 'calm';
  }
  return item.fyiCap && STAGE_RANK[stage] > STAGE_RANK.warm ? 'warm' : stage;
}

/** Received on a Saturday or Sunday (local): the clock starts Monday 09:00. */
export function clockStartFor(receivedAt: Date): Date {
  const day = receivedAt.getDay();
  if (day === 6) return atLocal(receivedAt, 2, 9);
  if (day === 0) return atLocal(receivedAt, 1, 9);
  return new Date(receivedAt.getTime());
}

/** A Saturday or Sunday moves to the Monday after, same local time. */
export function shiftOffWeekend(d: Date): Date {
  const day = d.getDay();
  const days = day === 6 ? 2 : day === 0 ? 1 : 0;
  if (!days) return new Date(d.getTime());
  return atLocal(d, days, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
}

/** The next weekday after `d`'s day, at `h`:00 local. */
function nextWorkingDay(d: Date, h: number): Date {
  let next = atLocal(d, 1, h);
  while (isWeekend(next)) next = atLocal(next, 1, h);
  return next;
}

/**
 * When an item is due. dm +4h, mention +24h, fyi +24h, manual +24h; promise:
 * eod = 19:00 on clockStart's day, tomorrow = next working day 12:00, none =
 * +24h, a Date as said. All from clockStart, then off the weekend — except a
 * message's own deadline and a promise's Date, which are kept as said.
 * halfTime (sender on the half-time list) halves the plain windows (dm,
 * mention, fyi, manual, promise none); fixed times (eod, tomorrow) stay.
 */
export function dueFor(input: {
  rule: DueRule;
  receivedAt: Date;
  messageDeadline?: Date;
  promise?: 'eod' | 'tomorrow' | 'none' | Date;
  halfTime?: boolean;
}): { clockStart: Date; dueAt: Date } {
  const clockStart = clockStartFor(input.receivedAt);
  if (input.rule === 'message') {
    if (!input.messageDeadline) throw new Error("dueFor: rule 'message' needs messageDeadline");
    return { clockStart, dueAt: new Date(input.messageDeadline.getTime()) };
  }
  if (input.rule === 'promise') {
    const p = input.promise ?? 'none';
    if (p instanceof Date) return { clockStart, dueAt: new Date(p.getTime()) };
    if (p === 'eod') return { clockStart, dueAt: shiftOffWeekend(atLocal(clockStart, 0, 19)) };
    if (p === 'tomorrow') return { clockStart, dueAt: nextWorkingDay(clockStart, 12) };
  }
  const hours = WINDOW_HOURS[input.rule] * (input.halfTime ? 0.5 : 1);
  return { clockStart, dueAt: shiftOffWeekend(new Date(clockStart.getTime() + hours * HOUR)) };
}

export type BoardSection = 'overdue' | 'hot' | 'quick' | 'today' | 'later' | 'fyi';

/** Board sections, top to bottom. */
export const SECTION_ORDER: BoardSection[] = ['overdue', 'hot', 'quick', 'today', 'later', 'fyi'];

/** fyi kind → fyi; overdue; hot; a quick ask → quick; due before the coming
 * local midnight → today; else later. */
export function sectionOf(
  stage: BriefingStage,
  item: { kind: BriefingKind; quick: boolean; dueAt: string },
  now: Date,
): BoardSection {
  if (item.kind === 'fyi') return 'fyi';
  if (stage === 'overdue') return 'overdue';
  if (stage === 'hot') return 'hot';
  if (item.quick) return 'quick';
  return Date.parse(item.dueAt) < atLocal(now, 1, 0).getTime() ? 'today' : 'later';
}

/** Open items, one group per groupKey (= one card per Slack thread): items by
 * dueAt, earliest first; groups by their earliest dueAt. */
export function groupItems<T extends { groupKey: string; dueAt: string; status: string }>(
  items: T[],
): { groupKey: string; items: T[] }[] {
  const byKey = new Map<string, T[]>();
  for (const it of items) {
    if (it.status !== 'open') continue;
    const list = byKey.get(it.groupKey);
    if (list) list.push(it);
    else byKey.set(it.groupKey, [it]);
  }
  const due = (it: T) => Date.parse(it.dueAt);
  const groups = [...byKey].map(([groupKey, list]) => ({
    groupKey,
    items: list.sort((a, b) => due(a) - due(b)),
  }));
  return groups.sort((a, b) => due(a.items[0]) - due(b.items[0]));
}

/** A card's stage: the worst of its open items' (calm when it has none). */
export function groupStage(stages: BriefingStage[]): BriefingStage {
  let worst: BriefingStage = 'calm';
  for (const s of stages) if (STAGE_RANK[s] > STAGE_RANK[worst]) worst = s;
  return worst;
}
