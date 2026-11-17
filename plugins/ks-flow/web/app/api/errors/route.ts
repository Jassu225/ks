// GET /api/errors — this device's ks-flow problems, as its daemon records them
// in <dataDir>/errors.json (src/lib/errors-log.ts): a store listener that
// stopped (retried with a backoff), a job failing. Open ones first, then those
// resolved in the last 7 days. `open`: how many are open (the header's ⚠).
// A local file: polled with the version, it reads no store.
import { NextResponse } from 'next/server';
import { readErrorsFile } from '@/lib/daemonFiles';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const all = readErrorsFile();
  const open = all.filter((e) => !e.resolvedAt);
  const resolved = all.filter((e) => e.resolvedAt).sort((a, b) => String(b.resolvedAt).localeCompare(String(a.resolvedAt)));
  return NextResponse.json({ open: open.length, entries: [...open, ...resolved] });
}
