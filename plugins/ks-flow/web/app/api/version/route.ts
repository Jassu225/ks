// GET /api/version — this device's version status, as its daemon published it
// (<dataDir>/version-status.json; src/lib/versioning.ts): its release and data
// format, the store's, whether it is behind, read-only, a dev build, and its
// last update. { status: null } before the daemon has written it.
// Polled by the shared header (lib/boardData.tsx) for the version banner.
import { NextResponse } from 'next/server';
import { readVersionStatus } from '@/lib/readonly';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ status: readVersionStatus() });
}
