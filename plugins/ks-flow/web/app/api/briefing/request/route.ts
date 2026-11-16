// POST /api/briefing/request — "Brief me now" / "Restart master" on the
// Briefing page. Writes <dataDir>/master/requests/<iso>-<trigger>.json; the
// master's mod submits it when the session is idle. Each press is also one
// master_events record (written, dropped or failed) for the Activity Log; a
// failed record is logged and never fails the request.
//
// Body: { trigger: 'button' | 'restart' | 'start' } → { ok, file, dropped }
// dropped: one of that trigger was already waiting, so nothing new was written.
// 'start' ("Start master", shown when no master runs) leaves start-request.json
// for the daemon instead of a request file; the daemon records that event.
// 'button' and 'restart' with no master running are refused (409): a request
// file would sit unread, and a master started later must not act on it.
//
// The master on another device (meta/settings.masterDeviceId): the same three
// buttons write a masterRequests doc instead ({trigger, from, createdAt});
// that device's daemon writes the file, records the master event, and drops a
// request older than 15 min. Refused (409) while the master device is offline
// (no heartbeat for 5 min) for 'button', and when its published status says no
// master runs (button, restart) or one already does (start).
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  masterStatus,
  masterTarget,
  remoteMasterStatus,
  writeRemoteRequest,
  writeRequest,
  writeStartRequest,
  type BoardTrigger,
  type MasterTarget,
} from '@/lib/masterFiles';
import { addMasterEvent } from '@/lib/serverdb';
import type { MasterEventDoc } from '@/lib/types';
import { readOnlyResponse } from '@/lib/readonly';

export const dynamic = 'force-dynamic';

const REASON: Record<BoardTrigger, string> = {
  button: 'Brief me now (board)',
  restart: 'Restart master (board)',
};

async function record(trigger: BoardTrigger, result: NonNullable<MasterEventDoc['result']>, detail: string): Promise<void> {
  try {
    // A store that doesn't answer must not hold up the button's reply.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('store did not answer in 5 s')), 5_000);
    });
    const write = addMasterEvent({
      uid: randomUUID(),
      at: new Date().toISOString(),
      kind: 'request',
      trigger,
      slot: null,
      reason: REASON[trigger],
      by: 'board',
      result,
      detail,
    });
    write.catch(() => {}); // a failure after the timeout: already logged as the timeout
    try {
      await Promise.race([write, timeout]);
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.error('[ks-flow] could not record the master event:', (e as Error)?.message ?? e);
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  // Read-only while this device is behind the store's data format (lib/readonly.ts).
  const readOnly = readOnlyResponse();
  if (readOnly) return readOnly;
  let body: { trigger?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
  if (body.trigger !== 'start' && body.trigger !== 'button' && body.trigger !== 'restart') {
    return NextResponse.json({ error: "trigger must be 'button', 'restart' or 'start'" }, { status: 400 });
  }
  let target: MasterTarget;
  try {
    target = await masterTarget();
  } catch {
    target = { local: true, masterDeviceId: null }; // store unreachable: this device's files
  }
  if (!target.local) return remote(target, body.trigger);
  if (body.trigger === 'start') {
    try {
      const s = writeStartRequest();
      return NextResponse.json({ ok: true, dropped: s.dropped, why: s.why });
    } catch (e) {
      return NextResponse.json({ error: (e as Error)?.message ?? 'write failed' }, { status: 500 });
    }
  }
  if (body.trigger !== 'button' && body.trigger !== 'restart') {
    return NextResponse.json({ error: "trigger must be 'button', 'restart' or 'start'" }, { status: 400 });
  }
  const trigger = body.trigger as BoardTrigger;
  // Both need a running master: a request file nobody reads would sit there,
  // and a later master would act on a click that is long stale.
  if (!masterStatus().alive) {
    return NextResponse.json(
      {
        error:
          trigger === 'restart'
            ? 'No master is running, so there is nothing to restart. Use Start master.'
            : 'No master is running. Start one first, then ask for a briefing.',
      },
      { status: 409 },
    );
  }
  let r: ReturnType<typeof writeRequest>;
  try {
    r = writeRequest(trigger);
  } catch (e) {
    const msg = (e as Error)?.message ?? 'write failed';
    await record(trigger, 'failed', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
  await record(
    trigger,
    r.dropped ? 'dropped' : 'ok',
    r.dropped ? `a ${trigger} request was already pending` : (r.file ?? 'request written'),
  );
  return NextResponse.json({ ok: true, ...r });
}

/** The master runs on another device: ask its daemon through a masterRequests doc. */
async function remote(
  target: Extract<MasterTarget, { local: false }>,
  trigger: 'start' | 'button' | 'restart',
): Promise<NextResponse> {
  const st = remoteMasterStatus(target);
  const name = st.device?.name ?? target.masterDeviceId;
  if (trigger === 'button' && st.device?.offline) {
    return NextResponse.json({ error: `master device ${name} is offline` }, { status: 409 });
  }
  if (trigger === 'start' && (st.alive || st.state === 'starting')) {
    return NextResponse.json({
      ok: true,
      dropped: true,
      why: st.alive ? `the master is already running on ${name}` : `the master is still starting on ${name}`,
    });
  }
  if (trigger !== 'start' && !st.alive) {
    return NextResponse.json(
      {
        error:
          trigger === 'restart'
            ? `No master is running on ${name}, so there is nothing to restart. Use Start master.`
            : `No master is running on ${name}. Start one first, then ask for a briefing.`,
      },
      { status: 409 },
    );
  }
  try {
    const doc = await writeRemoteRequest(target, trigger);
    return NextResponse.json({
      ok: true,
      dropped: false,
      remote: true,
      file: null,
      uid: doc.uid,
      why: `asked ${name}${st.device?.offline ? ' (offline now: the request is dropped unless it is back within 15 min)' : ''}`,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error)?.message ?? 'request failed' }, { status: 500 });
  }
}
