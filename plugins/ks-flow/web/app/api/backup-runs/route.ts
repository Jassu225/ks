// /api/backup-runs — the history of backup sweeps, for the Activity Log's Backup rows.
//
// GET → { ok, runs: BackupRun[], lastSweepAt } newest first (see src/lib/backup-runs.ts).
// Every device's runs, each with the `deviceId` it ran on, passed through as
// the CLI gives them (the Activity Log's Device column). The CLI judges an
// unfinished run of another device by that device's heartbeat, not by a pid;
// `lastSweepAt` is this device's last sweep.
//
// Produced by the CLI (`transcript-backup --runs`), like /api/transcript-backup's
// status: the history file's format and its merge rule (a start line plus an end
// line per run) live in one place, the daemon's code, not here as well.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

function dataDir(): string {
  return (
    process.env.KS_FLOW_DATA ||
    process.env.CLAUDE_PLUGIN_DATA ||
    join(homedir(), '.claude', 'plugins', 'data', 'ks-flow-karmasuite')
  );
}

export async function GET(): Promise<NextResponse> {
  const script = join(dataDir(), 'daemon', 'dist', 'transcript-backup.js');
  if (!existsSync(script)) {
    return NextResponse.json({ ok: false, runs: [], error: `backup script not found at ${script}` });
  }
  const payload = await new Promise<{ ok: boolean; runs: unknown[]; lastSweepAt?: string | null; error?: string }>((resolve) => {
    execFile(process.execPath, [script, '--runs'], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      try {
        const lines = stdout.trim().split('\n');
        const parsed = JSON.parse(lines[lines.length - 1]) as { runs?: unknown[]; lastSweepAt?: string | null };
        resolve({ ok: true, runs: parsed.runs ?? [], lastSweepAt: parsed.lastSweepAt ?? null });
      } catch {
        resolve({ ok: false, runs: [], error: stderr.trim() || err?.message || 'no output' });
      }
    });
  });
  return NextResponse.json(payload);
}
