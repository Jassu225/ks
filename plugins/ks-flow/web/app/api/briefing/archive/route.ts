// POST /api/briefing/archive — the person archives one item or several (a
// card's "Archive all…"). The only archive path there is: the master's CLI
// has none, and nothing archives on its own.
//
// Body: { uids: string[] (or uid), resolution: 'done'|'not-mine'|'wont-do', note? }
// → { ok, archived: string[], skipped: string[] } (skipped: missing or already archived)
import { NextResponse } from 'next/server';
import { RESOLUTIONS, applyArchive } from '@/lib/briefingActions';
import { getBriefingItems, putBriefingItem } from '@/lib/serverdb';
import type { Resolution } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<NextResponse> {
  let body: { uid?: string; uids?: string[]; resolution?: string; note?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
  const uids = [...new Set([...(Array.isArray(body.uids) ? body.uids : []), ...(body.uid ? [body.uid] : [])])]
    .filter((u): u is string => typeof u === 'string' && u.trim() !== '')
    .map((u) => u.trim());
  if (uids.length === 0) return NextResponse.json({ error: 'uids is required' }, { status: 400 });
  const resolution = body.resolution as Resolution;
  if (!RESOLUTIONS.includes(resolution)) {
    return NextResponse.json({ error: `resolution must be one of ${RESOLUTIONS.join(', ')}` }, { status: 400 });
  }
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 2000) : null;

  try {
    const items = await getBriefingItems(uids);
    const now = new Date();
    const archived: string[] = [];
    for (const item of items) {
      if (item.status !== 'open') continue;
      // Re-read each item right before its write, so a master `add`/`evidence`
      // that landed since the read above (or during the earlier writes) is
      // kept. Residual race: PocketBase REST has no transaction, so a CLI write
      // in the gap between this read and the put is still overwritten.
      const [fresh] = await getBriefingItems([item.uid]);
      if (!fresh || fresh.status !== 'open') continue;
      await putBriefingItem(applyArchive(fresh, resolution, note, now));
      archived.push(item.uid);
    }
    return NextResponse.json({ ok: true, archived, skipped: uids.filter((u) => !archived.includes(u)) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error)?.message ?? 'write failed' }, { status: 500 });
  }
}
