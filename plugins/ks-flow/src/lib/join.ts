// lib/join.ts — join sessions to work-units by worktree, aggregate the waiting
// badge + activity recency onto the card.
//
// The card's COLUMN comes from the phase layer (currentPhase); this layer only
// decorates the card with "waiting on you" and lastActivity from its sessions.
import type { SessionDoc, WaitingState, WorkUnitDoc } from './db/types.js';

function sameOrUnder(child: string | null, parent: string | null): boolean {
  if (!child || !parent) return false;
  return child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/');
}

/** Does this session work this unit's worktree? */
export function sessionMatchesUnit(s: SessionDoc, u: WorkUnitDoc): boolean {
  if (!u.worktreeDir) return false;
  return (
    s.worktreePath === u.worktreeDir ||
    sameOrUnder(s.cwd, u.worktreeDir) ||
    sameOrUnder(s.worktreePath, u.worktreeDir)
  );
}

function maxIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

/**
 * Recompute a unit's joined session ids, aggregated waiting state, and
 * lastActivity from the given sessions. Returns a new WorkUnitDoc (pure).
 */
export function joinUnit(unit: WorkUnitDoc, sessions: SessionDoc[]): WorkUnitDoc {
  const matched = sessions.filter((s) => s.inProject && sessionMatchesUnit(s, unit));

  let waiting: WaitingState | null = null;
  let lastActivity = unit.lastActivity;
  for (const s of matched) {
    lastActivity = maxIso(lastActivity, s.lastActivity);
    if (s.waitingTool && s.waitingSince) {
      // carry the oldest blocking wait across the unit's sessions
      if (!waiting || s.waitingSince < waiting.since) {
        waiting = {
          active: true,
          tool: s.waitingTool,
          since: s.waitingSince,
          sessionId: s.sessionId,
        };
      }
    }
  }

  return {
    ...unit,
    sessionIds: matched.map((s) => s.sessionId),
    waiting,
    lastActivity,
  };
}
