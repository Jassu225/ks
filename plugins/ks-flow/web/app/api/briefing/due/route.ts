// POST /api/briefing/due — the person changes an item's due time.
//
// Body: { uid, dueAt (ISO), reason? } → { ok, item }
// Writes dueAt, dueSetByYou: true, a dueHistory entry by 'you', pushedCount + 1
// when later (lib/briefingActions.ts). Refuses an archived item.
import { NextResponse } from 'next/server';
import { applyDue } from '@/lib/briefingActions';
import { getBriefingItems, putBriefingItem } from '@/lib/serverdb';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<NextResponse> {
  let body: { uid?: string; dueAt?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
  const uid = (body.uid ?? '').trim();
  if (!uid) return NextResponse.json({ error: 'uid is required' }, { status: 400 });
  const t = typeof body.dueAt === 'string' ? Date.parse(body.dueAt) : NaN;
  if (!Number.isFinite(t)) return NextResponse.json({ error: 'a valid dueAt (ISO) is required' }, { status: 400 });
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;

  try {
    // Read right before the write (only the pure applyDue in between), so the
    // item written is the latest one. Residual race: PocketBase REST has no
    // transaction, so a CLI `add`/`evidence` landing between this read and the
    // put is overwritten (the master re-reads before its own writes too).
    const [item] = await getBriefingItems([uid]);
    if (!item) return NextResponse.json({ error: 'no such item' }, { status: 404 });
    if (item.status !== 'open') return NextResponse.json({ error: 'the item is archived' }, { status: 409 });
    const next = applyDue(item, new Date(t).toISOString(), reason, new Date());
    await putBriefingItem(next);
    return NextResponse.json({ ok: true, item: next });
  } catch (e) {
    return NextResponse.json({ error: (e as Error)?.message ?? 'write failed' }, { status: 500 });
  }
}
