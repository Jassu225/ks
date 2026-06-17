// /api/reminders — set / clear a per-card custom reminder (server-side DB write).
//
// POST   { unitId, dueAt? (ISO) | relative? ("30m"|"2h"|"1d"), note? } → create
// DELETE { uid } → remove
// The daemon polls the `reminders` collection and fires the notification.
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { deleteReminder, getProjectId, upsertReminder } from '@/lib/serverdb';
import type { ReminderDoc } from '@/lib/types';

export const dynamic = 'force-dynamic';

function resolveDueAt(body: { dueAt?: string; relative?: string }): string | null {
  if (typeof body.dueAt === 'string' && body.dueAt) {
    const t = Date.parse(body.dueAt);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  if (typeof body.relative === 'string') {
    const m = body.relative.trim().match(/^(\d+)\s*([mhd])$/i);
    if (!m) return null;
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const ms = unit === 'm' ? n * 60_000 : unit === 'h' ? n * 3_600_000 : n * 86_400_000;
    return new Date(Date.now() + ms).toISOString();
  }
  return null;
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: { unitId?: string; dueAt?: string; relative?: string; note?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
  const unitId = (body.unitId ?? '').trim();
  if (!unitId) return NextResponse.json({ error: 'unitId is required' }, { status: 400 });
  const dueAt = resolveDueAt(body);
  if (!dueAt) {
    return NextResponse.json(
      { error: 'a valid dueAt (ISO) or relative ("30m" / "2h" / "1d") is required' },
      { status: 400 },
    );
  }
  const doc: ReminderDoc = {
    uid: randomUUID(),
    projectId: getProjectId(),
    kind: 'custom',
    unitId,
    dueAt,
    note: typeof body.note === 'string' && body.note.trim() ? body.note.trim() : undefined,
    lastFiredAt: null,
    cleared: false,
    createdAt: new Date().toISOString(),
  };
  try {
    await upsertReminder(doc);
  } catch (e) {
    return NextResponse.json({ error: (e as Error)?.message ?? 'write failed' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, reminder: doc });
}

export async function DELETE(req: Request): Promise<NextResponse> {
  let body: { uid?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
  const uid = (body.uid ?? '').trim();
  if (!uid) return NextResponse.json({ error: 'uid is required' }, { status: 400 });
  try {
    await deleteReminder(uid);
  } catch (e) {
    return NextResponse.json({ error: (e as Error)?.message ?? 'delete failed' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
