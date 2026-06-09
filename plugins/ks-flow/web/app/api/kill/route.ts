// POST /api/kill — stop the always-on daemon and its PocketBase child from the
// board. The browser can't signal processes, so this runs server-side in the
// Next process (started by `ks-flow open`, runs as the user).
//
// The daemon is a launchd KeepAlive agent, so a plain kill would be respawned —
// the real stop is `launchctl bootout`, which sends SIGTERM and unloads it. The
// daemon's SIGTERM handler stops the PocketBase child; we also pkill any orphan
// as a belt-and-suspenders in case the daemon was SIGKILLed. Nothing is
// destroyed: pb_data + checkpoints.json persist, so the next daemon start (next
// Claude session, or `ks-flow install-daemon`) resumes and re-backfills.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NextResponse } from 'next/server';

const pexec = promisify(execFile);
const LABEL = 'com.ksflow.ingester';

export const dynamic = 'force-dynamic';

export async function POST(): Promise<NextResponse> {
  const uid = process.getuid?.() ?? 0;
  const result: Record<string, string> = {};

  // 1. Stop the launchd daemon (cascades a SIGTERM → PocketBase child stops).
  try {
    await pexec('launchctl', ['bootout', `gui/${uid}/${LABEL}`]);
    result.daemon = 'stopped';
  } catch (e) {
    const msg = String((e as { stderr?: string; message?: string })?.stderr ?? (e as Error)?.message ?? e);
    // bootout exits non-zero when the agent is already unloaded.
    result.daemon = /no such process|could not find|not find/i.test(msg)
      ? 'already stopped'
      : `error: ${msg.trim()}`;
  }

  // 2. Kill any orphaned PocketBase server (no-op if the daemon already did).
  try {
    await pexec('pkill', ['-f', 'pocketbase serve']);
    result.pocketbase = 'stopped';
  } catch {
    result.pocketbase = 'none running';
  }

  return NextResponse.json({ ok: true, ...result });
}
