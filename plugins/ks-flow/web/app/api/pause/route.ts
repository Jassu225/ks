// /api/pause — pause / resume the stop-nudge for a session (server-side DB write).
//
// POST { sessionId, unitId?, paused: boolean }
//   paused=true  → write a `kind:'pause'` record (uid = `pause:<sessionId>`)
//   paused=false → delete it
// The daemon skips nudging paused sessions, and auto-deletes the pause record
// when the session resumes (so the badge returns to Active on its own).
import { NextResponse } from 'next/server';
import { deleteReminder, getProjectId, upsertReminder } from '@/lib/serverdb';
import type { ReminderDoc } from '@/lib/types';

export const dynamic = 'force-dynamic';

const pauseUid = (sessionId: string): string => `pause:${sessionId}`;

export async function POST(req: Request): Promise<NextResponse> {
  let body: { sessionId?: string; unitId?: string; paused?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
  const sessionId = (body.sessionId ?? '').trim();
  if (!sessionId) return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });

  try {
    if (body.paused) {
      const doc: ReminderDoc = {
        uid: pauseUid(sessionId),
        projectId: getProjectId(),
        kind: 'pause',
        sessionId,
        unitId: typeof body.unitId === 'string' ? body.unitId : undefined,
        pausedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      };
      await upsertReminder(doc);
    } else {
      await deleteReminder(pauseUid(sessionId));
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error)?.message ?? 'write failed' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, paused: !!body.paused });
}
