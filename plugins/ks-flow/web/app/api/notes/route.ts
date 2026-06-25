// /api/notes — standalone Notes-page entries (reminders collection, kind:'note').
//
// GET                                              → all note rows for the project
// POST   { section, text, dueAt?|relative? }       → create a note (+ optional reminder)
// PATCH  { uid, text?, dueAt?|relative?, clearDue?, cleared?, done? } → edit a note
// DELETE { uid }                                   → remove a note
//
// A note's reminder (dueAt) is fired by the daemon's reminder ticker — at due,
// then re-nagged once a day until `cleared` (same path as kind:'custom').
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { deleteReminder, getProjectId, listReminders, upsertReminder } from '@/lib/serverdb';
import type { ReminderDoc } from '@/lib/types';

export const dynamic = 'force-dynamic';

type Section = 'generic' | 'slack' | 'linear';

// dueAt from an absolute ISO string OR a relative "30m" / "2h" / "1d".
// Returns undefined when neither supplied, null when supplied-but-invalid.
function resolveDueAt(body: { dueAt?: string; relative?: string }): string | null | undefined {
  if (typeof body.dueAt === 'string' && body.dueAt) {
    const t = Date.parse(body.dueAt);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  if (typeof body.relative === 'string' && body.relative.trim()) {
    const m = body.relative.trim().match(/^(\d+)\s*([mhd])$/i);
    if (!m) return null;
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const ms = unit === 'm' ? n * 60_000 : unit === 'h' ? n * 3_600_000 : n * 86_400_000;
    return new Date(Date.now() + ms).toISOString();
  }
  return undefined;
}

// GET /api/notes          → active notes (not cleared, not done)
// GET /api/notes?trash=1   → soft-deleted notes (cleared === true), for the Trash view
// GET /api/notes?archive=1 → completed notes (done === true), for the Archive view
export async function GET(req: Request): Promise<NextResponse> {
  const params = new URL(req.url).searchParams;
  const trash = params.get('trash') === '1';
  const archive = params.get('archive') === '1';
  try {
    const all = await listReminders();
    const notes = all.filter((r) => {
      if (r.kind !== 'note') return false;
      if (trash) return r.cleared === true;
      if (archive) return r.done === true && !r.cleared;
      return !r.cleared && !r.done;
    });
    return NextResponse.json({ notes });
  } catch (e) {
    return NextResponse.json({ error: (e as Error)?.message ?? 'read failed' }, { status: 500 });
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: {
    section?: string;
    workType?: string;
    text?: string;
    dueAt?: string;
    relative?: string;
    sourceUrl?: string;
    sourceDate?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
  const section = (body.section ?? 'generic') as Section;
  if (!['generic', 'slack', 'linear'].includes(section)) {
    return NextResponse.json({ error: 'invalid section' }, { status: 400 });
  }
  // Default Professional; the board splits Professional (left) / Personal (right).
  const workType: 'personal' | 'professional' =
    body.workType === 'personal' ? 'personal' : 'professional';
  const text = (body.text ?? '').trim();
  if (!text) return NextResponse.json({ error: 'text is required' }, { status: 400 });
  const due = resolveDueAt(body);
  if (due === null) {
    return NextResponse.json(
      { error: 'a valid dueAt (ISO) or relative ("30m" / "2h" / "1d") is required' },
      { status: 400 },
    );
  }
  // Optional source metadata — used by manually-added Slack notes (permalink +
  // the original message date, shown on the card).
  const sourceUrl =
    typeof body.sourceUrl === 'string' && body.sourceUrl.trim() ? body.sourceUrl.trim() : undefined;
  let sourceDate: string | undefined;
  if (typeof body.sourceDate === 'string' && body.sourceDate.trim()) {
    const t = Date.parse(body.sourceDate);
    if (!Number.isFinite(t)) {
      return NextResponse.json({ error: 'invalid sourceDate' }, { status: 400 });
    }
    sourceDate = new Date(t).toISOString();
  }
  const doc: ReminderDoc = {
    uid: randomUUID(),
    projectId: getProjectId(),
    kind: 'note',
    section,
    workType,
    text,
    sourceUrl,
    sourceDate,
    dueAt: due ?? undefined,
    lastFiredAt: null,
    cleared: false,
    createdAt: new Date().toISOString(),
  };
  try {
    await upsertReminder(doc);
  } catch (e) {
    return NextResponse.json({ error: (e as Error)?.message ?? 'write failed' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, note: doc });
}

export async function PATCH(req: Request): Promise<NextResponse> {
  let body: {
    uid?: string;
    text?: string;
    dueAt?: string;
    relative?: string;
    clearDue?: boolean;
    cleared?: boolean;
    done?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
  const uid = (body.uid ?? '').trim();
  if (!uid) return NextResponse.json({ error: 'uid is required' }, { status: 400 });

  let existing: ReminderDoc | undefined;
  try {
    existing = (await listReminders()).find((r) => r.uid === uid && r.kind === 'note');
  } catch (e) {
    return NextResponse.json({ error: (e as Error)?.message ?? 'read failed' }, { status: 500 });
  }
  if (!existing) return NextResponse.json({ error: 'note not found' }, { status: 404 });

  const next: ReminderDoc = { ...existing };
  if (typeof body.text === 'string' && body.text.trim()) next.text = body.text.trim();
  if (typeof body.cleared === 'boolean') next.cleared = body.cleared;
  if (typeof body.done === 'boolean') next.done = body.done;
  if (body.clearDue) {
    next.dueAt = undefined;
    next.lastFiredAt = null;
  } else {
    const due = resolveDueAt(body);
    if (due === null) {
      return NextResponse.json({ error: 'invalid dueAt / relative' }, { status: 400 });
    }
    if (due !== undefined && due !== existing.dueAt) {
      next.dueAt = due;
      next.lastFiredAt = null; // re-arm: a changed due time should fire again
    }
  }
  try {
    await upsertReminder(next);
  } catch (e) {
    return NextResponse.json({ error: (e as Error)?.message ?? 'write failed' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, note: next });
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
