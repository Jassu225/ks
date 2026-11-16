// /api/devices — Settings → Devices (store-only; lib/devicesdb.ts).
//
// GET  → { devices, settings, self } (the board reads them live; this is for scripts and checks)
// POST { changes: [
//        { action: 'rename', deviceId, name: string | null },   // null/'' = back to its default name
//        { action: 'label', deviceId, label: string | null },   // 1–3 chars A–Z/0–9, a letter first (uppercased);
//                                                               // unique among non-forgotten devices (409);
//                                                               // null/'' = its daemon assigns one
//        { action: 'forget', deviceId, forgotten: boolean },    // only a stale, non-master device
//        { action: 'master', deviceId } ] }                     // meta/settings.masterDeviceId
//   Every change is checked first; then all are written (merges), or none. A
//   device taken back onto a label another device holds gives it up (null).
//   409 before the device backfill (no meta/settings).
import { NextResponse } from 'next/server';
import { applyDevicesChanges, DevicesError, parseChanges, readDevices } from '@/lib/devicesdb';
import { readOnlyResponse } from '@/lib/readonly';

export const dynamic = 'force-dynamic';

function fail(e: unknown): NextResponse {
  if (e instanceof DevicesError) return NextResponse.json({ error: e.message }, { status: e.status });
  return NextResponse.json({ error: (e as Error)?.message ?? 'store error' }, { status: 500 });
}

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await readDevices());
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  // Read-only while this device is behind the store's data format (lib/readonly.ts).
  const readOnly = readOnlyResponse();
  if (readOnly) return readOnly;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
  try {
    const state = await applyDevicesChanges(parseChanges(body));
    return NextResponse.json({ ok: true, ...state });
  } catch (e) {
    return fail(e);
  }
}
