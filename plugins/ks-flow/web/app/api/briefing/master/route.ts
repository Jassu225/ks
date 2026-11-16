// GET /api/briefing/master — is the master session up? On the master device
// (and on PocketBase, or before the device backfill): from
// <dataDir>/master/session.json + heartbeat.json and a live check of its pid
// (lib/masterFiles.ts). On another device: from the status the master device's
// daemon publishes to devices/{master}.master, with `device` saying where the
// master runs and whether that device is offline (no heartbeat for 5 min).
// Polled by the shared header every 15 s.
import { NextResponse } from 'next/server';
import { masterStatus, masterStatusAnywhere } from '@/lib/masterFiles';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await masterStatusAnywhere());
  } catch (e) {
    // The store did not answer: this device's files are still the best answer.
    console.error('[ks-flow] master status: store read failed, using local files:', (e as Error)?.message ?? e);
    return NextResponse.json(masterStatus());
  }
}
