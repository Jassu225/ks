// lib/briefingActions.ts — what the board's two writes do to an item
// (docs/briefing.md, "Board"). Pure: the API routes read the item, apply one
// of these, and write it back. Only the person reaches these — the master's
// CLI has no archive and never touches a due time the person set.
import type { BriefingItemDoc, Resolution } from './types';

export const RESOLUTIONS: Resolution[] = ['done', 'not-mine', 'wont-do'];

/** Set a new due time: dueSetByYou, a `by: 'you'` history entry, pushedCount +1
 * when later. The new history entry re-arms the daemon's notices: it counts a
 * notice only if sent after the latest due change (its own notices.json). */
export function applyDue(
  item: BriefingItemDoc,
  dueAt: string,
  reason: string | null,
  now: Date,
): BriefingItemDoc {
  const at = now.toISOString();
  const later = Date.parse(dueAt) > Date.parse(item.dueAt);
  return {
    ...item,
    dueAt,
    dueSetByYou: true,
    dueHistory: [
      ...(item.dueHistory ?? []),
      { at, from: item.dueAt ?? null, to: dueAt, by: 'you', ...(reason ? { reason } : {}) },
    ],
    pushedCount: (item.pushedCount ?? 0) + (later ? 1 : 0),
    updatedAt: at,
  };
}

/** Archive: the person's resolution and note; the clock stops here. */
export function applyArchive(
  item: BriefingItemDoc,
  resolution: Resolution,
  note: string | null,
  now: Date,
): BriefingItemDoc {
  const at = now.toISOString();
  return {
    ...item,
    status: 'archived',
    archivedAt: at,
    resolution,
    archiveNote: note,
    updatedAt: at,
  };
}
