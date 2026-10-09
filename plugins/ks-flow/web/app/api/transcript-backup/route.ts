// /api/transcript-backup — transcript backup status, and manual backup runs.
//
// GET  → { ok, lastSweepAt, units: [{ identifier, localSessions, cloudSessions,
//          missingLocally, lastArchivedAt, transcriptDir }] }
// POST { unit?: string } → run the sweep now (omit `unit` for the whole project),
//        streaming the CLI's output as NDJSON so the board's log panel can show
//        progress live. A backup can take minutes on a long transcript, and a
//        button that just sits there looks broken.
//
// Status comes from the CLI (`transcript-backup --status`, below), which lists
// the bucket once per call and reads the backup index and run history from the
// store; `lastSweepAt` is when the last sweep finished.
//
// The work itself is delegated to dist/transcript-backup.js (the same CLI the
// daemon's end-of-day sweep runs) so there is one implementation of the upload
// rules, not two.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { streamProcess } from '@/lib/streamproc';

export const dynamic = 'force-dynamic';

function dataDir(): string {
  return (
    process.env.KS_FLOW_DATA ||
    process.env.CLAUDE_PLUGIN_DATA ||
    join(homedir(), '.claude', 'plugins', 'data', 'ks-flow-karmasuite')
  );
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/**
 * Status is produced by the CLI (`transcript-backup --status`), not computed here.
 *
 * Two reasons. The board has no GCS client — it is a separate npm package — and
 * status must be derived from the BUCKET, because a unit archived before the
 * backup index existed (or on another machine, or after the store was cleared)
 * must still offer a Restore. Reading only the backup index meant the cards with
 * the most to recover showed nothing at all.
 *
 * Cached briefly so several open tabs and the 60s client poll share one listing.
 */
interface UnitStatus {
  identifier: string;
  transcriptDir: string;
  worktreePath: string;
  worktreeExists: boolean;
  localSessions: number;
  cloudSessions: number;
  missingCount: number;
  pendingCount: number;
  legacyOnly: boolean;
  lastArchivedAt: string | null;
}

interface StatusPayload {
  ok: boolean;
  units: UnitStatus[];
  lastSweepAt: string | null;
  error?: string;
}

const STATUS_TTL_MS = 30_000;
let cache: { at: number; payload: StatusPayload } | null = null;

async function readStatus(): Promise<StatusPayload> {
  if (cache && Date.now() - cache.at < STATUS_TTL_MS) return cache.payload;

  const script = join(dataDir(), 'daemon', 'dist', 'transcript-backup.js');
  if (!existsSync(script)) {
    return { ok: false, units: [], lastSweepAt: null, error: `backup script not found at ${script}` };
  }
  const payload = await new Promise<StatusPayload>((resolve) => {
    execFile(
      process.execPath,
      [script, '--status'],
      { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!stdout) {
          resolve({ ok: false, units: [], lastSweepAt: null, error: stderr.trim() || err?.message || 'no output' });
          return;
        }
        try {
          const lines = stdout.trim().split('\n');
          const parsed = JSON.parse(lines[lines.length - 1]) as { units?: UnitStatus[]; lastSweepAt?: string | null };
          resolve({ ok: true, units: parsed.units ?? [], lastSweepAt: parsed.lastSweepAt ?? null });
        } catch {
          resolve({ ok: false, units: [], lastSweepAt: null, error: stdout.slice(-500) });
        }
      },
    );
  });
  cache = { at: Date.now(), payload };
  return payload;
}

export async function GET(req: Request): Promise<NextResponse> {
  const wanted = new URL(req.url).searchParams.get('unit');
  const status = await readStatus();
  const units = wanted ? status.units.filter((u) => u.identifier === wanted) : status.units;
  return NextResponse.json({ ...status, units });
}

export async function POST(req: Request): Promise<NextResponse> {
  let unit: string | undefined;
  try {
    const body = (await req.json()) as { unit?: string };
    unit = typeof body?.unit === 'string' && body.unit ? body.unit : undefined;
  } catch {
    // no body → the whole project
  }

  const script = join(dataDir(), 'daemon', 'dist', 'transcript-backup.js');
  if (!existsSync(script)) {
    return NextResponse.json(
      { ok: false, error: `backup script not found at ${script} — run ks-flow bootstrap.` },
      { status: 500 },
    );
  }

  // No --since-hours: a manual backup should bring the target fully up to date,
  // not just whatever moved in the last day.
  const args = [script];
  if (unit) args.push('--unit', unit);

  cache = null; // a backup changes status; don't serve a stale card for 30s
  const { projectPath } = readJson(join(dataDir(), 'project.conf'), { projectPath: '' });
  return streamProcess({
    command: process.execPath,
    args,
    cwd: projectPath && existsSync(projectPath) ? projectPath : undefined,
    timeoutMs: 30 * 60_000,
    banner: unit
      ? `[ks-flow] backing up ${unit} — transcript + workflow…\n`
      : '[ks-flow] backing up every live worktree — transcript + workflow…\n',
  });
}
