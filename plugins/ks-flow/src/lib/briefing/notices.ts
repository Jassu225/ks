// lib/briefing/notices.ts — which macOS notices the daemon owes for briefing
// items (docs/briefing.md, "Daemon"). Pure: daemon.ts reads the open items and
// its own record of the notices sent (<dataDir>/master/notices.json, a
// NoticeMap), records the owed ones there, then sends what composeNotices
// returns. The daemon never writes briefing items: the board and the CLI are
// their only writers, so a notice can never race an archive or a due change.
//
// Per open item: one notice when it first turns hot, one when it turns overdue
// (an item that is already overdue when first seen gets only that one), and a
// re-nag at each schedule slot it is still overdue at. A notice counts only if
// sent after the item's last due change (dueHistory): moving the due time
// re-arms them. fyi items never pass warm, so they never notify.
//
// Several notices owed in one tick (the daemon starting after a while down, a
// briefing pass adding items that are already late, a slot re-nagging many)
// become ONE summary notice, never a burst.
import type { BriefingItemDoc } from '../db/types.js';
import { latestSlot } from '../master.js';
import { stageOf } from './escalation.js';

export type NoticeKind = 'hot' | 'overdue' | 'nag';
/** ISO of each notice sent for one item. */
export interface Notified {
  hot?: string;
  overdue?: string;
  lastNag?: string;
}
/** The daemon's record of notices sent, by item uid (notices.json `items`). */
export type NoticeMap = Readonly<Record<string, Notified>>;

/** One notice owed: the item, what kind, and the fields to merge into its NoticeMap entry. */
export interface Owed {
  uid: string;
  kind: NoticeKind;
  patch: Notified;
  item: BriefingItemDoc;
}

/** What lib/notify's notify() takes. */
export interface NoticeSpec {
  group: string;
  title: string;
  subtitle: string;
  message: string;
}

/** ms epoch of the item's last due change; notices sent before it are void. */
export function armedAt(item: Pick<BriefingItemDoc, 'dueHistory'>): number {
  let at = -Infinity;
  for (const h of item.dueHistory ?? []) {
    const t = Date.parse(h.at);
    if (Number.isFinite(t) && t > at) at = t;
  }
  return at;
}

function sentAfter(iso: string | undefined, armed: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= armed ? t : null;
}

/**
 * The notices owed at `now`, given those already sent (`sent`, by uid). `enabled` = the reminders switch (off: nothing,
 * and nothing recorded, so the first tick after it is turned back on owes them
 * all — as one summary). `pausedUnits` = cards paused on the board: an item
 * linked to one (`unit`) is silent, the same as the card's reminders.
 */
export function owedNotices(
  items: readonly BriefingItemDoc[],
  now: Date,
  sent: NoticeMap,
  opts: { schedule: readonly string[]; enabled: boolean; pausedUnits?: ReadonlySet<string> },
): Owed[] {
  if (!opts.enabled) return [];
  const nowIso = now.toISOString();
  const slot = latestSlot(now, opts.schedule);
  const out: Owed[] = [];
  for (const item of items) {
    if (item.status !== 'open') continue;
    if (item.unit && opts.pausedUnits?.has(item.unit)) continue;
    const stage = stageOf(item, now);
    if (stage !== 'hot' && stage !== 'overdue') continue;
    const n = sent[item.uid] ?? {};
    const armed = armedAt(item);
    const hotAt = sentAfter(n.hot, armed);
    if (stage === 'hot') {
      if (hotAt === null) out.push({ uid: item.uid, kind: 'hot', patch: { hot: nowIso }, item });
      continue;
    }
    const overdueAt = sentAfter(n.overdue, armed);
    if (overdueAt === null) {
      out.push({
        uid: item.uid,
        kind: 'overdue',
        patch: { overdue: nowIso, ...(hotAt === null ? { hot: nowIso } : {}) },
        item,
      });
      continue;
    }
    // Still overdue: re-nag once per slot passed since the last notice.
    const lastNag = sentAfter(n.lastNag, armed) ?? -Infinity;
    if (slot && slot.at.getTime() > Math.max(overdueAt, lastNag)) {
      out.push({ uid: item.uid, kind: 'nag', patch: { lastNag: nowIso }, item });
    }
  }
  return out;
}

/**
 * The NoticeMap to store once `owed` is recorded: each owed patch merged in,
 * and every uid not in `openUids` dropped (archived or gone — nothing more is
 * owed for it). `changed` = it differs from `sent`, so an idle tick writes
 * nothing.
 */
export function recordNotices(
  sent: NoticeMap,
  owed: readonly Owed[],
  openUids: ReadonlySet<string>,
): { map: Record<string, Notified>; changed: boolean } {
  const map: Record<string, Notified> = {};
  let changed = false;
  for (const [uid, n] of Object.entries(sent)) {
    if (openUids.has(uid)) map[uid] = { ...n };
    else changed = true;
  }
  for (const o of owed) {
    map[o.uid] = { ...map[o.uid], ...o.patch };
    changed = true;
  }
  return { map, changed };
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** 'HH:MM' local, with the weekday in front when not `now`'s day. */
export function dueLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '?';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? hm : `${DAYS[d.getDay()]} ${hm}`;
}

function who(item: BriefingItemDoc): string {
  const from = item.source?.from?.name;
  const where = item.source?.channelName;
  return [from, where].filter(Boolean).join(' · ');
}

const MAX_LISTED = 4;

/** The notices to send for what was recorded: one per item when only one is
 * owed, else a single summary (overdue first, then due soon). */
export function composeNotices(owed: readonly Owed[], now: Date): NoticeSpec[] {
  if (owed.length === 0) return [];
  if (owed.length === 1) {
    const { item, kind } = owed[0]!;
    const due = dueLabel(item.dueAt, now);
    const subtitle =
      kind === 'hot' ? `Due soon — ${due}` : kind === 'overdue' ? `Overdue — was due ${due}` : `Still overdue — was due ${due}`;
    const by = who(item);
    return [
      {
        group: `briefing-${item.uid}`,
        title: 'Briefing',
        subtitle,
        message: by ? `${item.title} (${by})` : item.title,
      },
    ];
  }
  const late = owed.filter((o) => o.kind !== 'hot');
  const soon = owed.filter((o) => o.kind === 'hot');
  const parts = [late.length ? `${late.length} overdue` : '', soon.length ? `${soon.length} due soon` : ''].filter(Boolean);
  const ordered = [...late, ...soon].sort((a, b) =>
    a.kind === 'hot' && b.kind !== 'hot' ? 1 : a.kind !== 'hot' && b.kind === 'hot' ? -1 : Date.parse(a.item.dueAt) - Date.parse(b.item.dueAt),
  );
  const listed = ordered.slice(0, MAX_LISTED).map((o) => o.item.title);
  const more = ordered.length > MAX_LISTED ? ` (+${ordered.length - MAX_LISTED} more)` : '';
  return [
    {
      group: 'briefing-summary',
      title: 'Briefing',
      subtitle: `${owed.length} items need you: ${parts.join(', ')}`,
      message: `${listed.join(' · ')}${more}`,
    },
  ];
}
