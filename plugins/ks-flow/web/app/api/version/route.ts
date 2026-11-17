// GET /api/version — this device's version status, as its daemon published it
// (<dataDir>/version-status.json; src/lib/versioning.ts): its release and data
// format, the store's, whether it is behind, read-only, a dev build, and its
// last update. { status: null } before the daemon has written it.
// `board`: the ks-flow version this board was built from, as `ks-flow open`
// recorded it (.ks-flow-version in the board's folder), else the plugin it was
// started from. `ks`: the ks plugin's version on this Mac (its live folder).
// Polled by the shared header (lib/boardData.tsx) for the version
// banner and the version next to the ks-flow name.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { readVersionStatus } from '@/lib/readonly';
import { liveRoot, rootContext } from '@/lib/ksroot';

export const dynamic = 'force-dynamic';

function boardVersion(): string | null {
  try {
    const v = readFileSync(join(process.cwd(), '.ks-flow-version'), 'utf8').trim();
    if (v) return v;
  } catch {
    /* a board built before the file existed */
  }
  const root = process.env.KS_FLOW_PLUGIN_ROOT;
  if (!root) return null;
  try {
    return (JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

/** The ks plugin's version on this Mac (its live folder: what the KS commands and new sessions run). */
function ksVersion(): string | null {
  const root = liveRoot('ks', rootContext());
  if (!root) return null;
  try {
    return (JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ status: readVersionStatus(), board: boardVersion(), ks: ksVersion() });
}
