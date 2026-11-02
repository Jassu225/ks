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
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { masterStatus, writeRequest, writeStartRequest, type BoardTrigger } from '@/lib/masterFiles';
import { addMasterEvent } from '@/lib/serverdb';
import type { MasterEventDoc } from '@/lib/types';

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
  let body: { trigger?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
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
