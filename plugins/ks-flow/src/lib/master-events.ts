// lib/master-events.ts — the history of what the daemon does to the master
// (docs/briefing.md, "Activity Log"): each start / hard restart it runs and
// each schedule request it writes or drops is one MasterEventDoc in the store
// (`master_events`). The board's request route writes its own (button /
// restart) the same shape. The request files and daemon-state.json keep only
// what is pending and the last action; this is what the Activity Log lists.
//
// Recording is best-effort: a failed write is logged and never stops the
// action it describes.
import { randomUUID } from 'node:crypto';
import type { BriefingStore, MasterEventDoc } from './db/types.js';
import type { MasterRequest, SupervisorAction } from './master.js';

export type { MasterEventDoc } from './db/types.js';

/** What a finished start/restart command or a request write came to. */
export type EventOutcome = Pick<MasterEventDoc, 'result' | 'detail'>;

/** A new event: fresh uid, `at` = now, optional fields left out when unset. */
export function masterEvent(
  input: Omit<MasterEventDoc, 'uid' | 'at'>,
  now: Date = new Date(),
): MasterEventDoc {
  const doc: MasterEventDoc = { uid: randomUUID(), at: now.toISOString(), kind: input.kind, reason: input.reason, by: input.by };
  if (input.trigger !== undefined) doc.trigger = input.trigger;
  if (input.slot !== undefined) doc.slot = input.slot;
  if (input.result !== undefined) doc.result = input.result;
  if (input.detail !== undefined) doc.detail = input.detail;
  return doc;
}

/** The supervisor starting or hard-restarting the master. No result yet: the
 * command runs detached, and `launchOutcome` fills it in when it exits. */
export function supervisorEvent(action: SupervisorAction, why: string, now?: Date): MasterEventDoc {
  return masterEvent({ kind: action, reason: why, by: 'daemon' }, now);
}

/** The daemon's schedule request for a slot: written (`req`) or dropped
 * because one was already pending (`req` null). */
export function scheduleRequestEvent(slot: string, req: MasterRequest | null, now?: Date): MasterEventDoc {
  return masterEvent(
    {
      kind: 'request',
      trigger: 'schedule',
      slot,
      reason: `${slot} slot`,
      by: 'daemon',
      result: req ? 'ok' : 'dropped',
      detail: req ? `request ${req.id}` : 'a schedule request was already pending',
    },
    now,
  );
}

/** A start/restart command's end: exit 0 → ok; else failed, with how it ended. */
export function launchOutcome(code: number | null, signal: string | null): EventOutcome {
  if (code === 0) return { result: 'ok', detail: 'exited 0' };
  return { result: 'failed', detail: `${signal ? `killed by ${signal}` : `exited ${code ?? '?'}`} — see master/launch.log` };
}

/**
 * Write one event, never throwing: the action it records has happened (or is
 * happening) either way. Returns once the write settled, so a later update of
 * the same event can wait for it (two concurrent upserts of a new uid would
 * create two records).
 */
export async function recordMasterEvent(
  store: Pick<BriefingStore, 'upsertMasterEvent'>,
  projectId: string,
  doc: MasterEventDoc,
  log: (...a: unknown[]) => void,
): Promise<void> {
  try {
    await store.upsertMasterEvent(projectId, doc);
  } catch (e) {
    log(`master: could not record the ${doc.kind} event:`, (e as Error)?.message ?? e);
  }
}
