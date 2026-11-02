// GET /api/briefing/master — is the master session up? From
// <dataDir>/master/session.json + heartbeat.json and a live check of its pid
// (lib/masterFiles.ts). Polled by the shared header every 15 s.
import { NextResponse } from 'next/server';
import { masterStatus } from '@/lib/masterFiles';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(masterStatus());
}
