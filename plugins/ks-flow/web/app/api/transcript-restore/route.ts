// /api/transcript-restore — pull a unit's backed-up transcripts back to disk.
//
// POST { unit: string, overwrite?: boolean, dryRun?: boolean }
//   → NDJSON stream ({ type: 'stdout'|'stderr'|'exit' }), same protocol as
//     /api/run-command and /api/transcript-backup, so the board's one log panel
//     renders a restore exactly like a remove or a backup.
//
// Delegates to dist/transcript-restore.js. Local files win unless `overwrite`
// is passed: a transcript on disk may be the live one Claude Code is appending
// to, so the default only fills in sessions that are MISSING locally — the
// pruned-after-30-days case this exists for.
import { existsSync } from 'node:fs';
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

export async function POST(req: Request): Promise<NextResponse> {
  let unit = '';
  let overwrite = false;
  let dryRun = false;
  try {
    const body = (await req.json()) as { unit?: string; overwrite?: boolean; dryRun?: boolean };
    unit = typeof body?.unit === 'string' ? body.unit.trim() : '';
    overwrite = body?.overwrite === true;
    dryRun = body?.dryRun === true;
  } catch {
    // fall through to the missing-unit error below
  }
  if (!unit) {
    return NextResponse.json({ ok: false, error: 'unit is required' }, { status: 400 });
  }

  const script = join(dataDir(), 'daemon', 'dist', 'transcript-restore.js');
  if (!existsSync(script)) {
    return NextResponse.json(
      { ok: false, error: `restore script not found at ${script} — run ks-flow bootstrap.` },
      { status: 500 },
    );
  }

  const args = [script, '--unit', unit];
  if (overwrite) args.push('--overwrite');
  if (dryRun) args.push('--dry-run');

  return streamProcess({
    command: process.execPath,
    args,
    timeoutMs: 30 * 60_000,
    banner: `[ks-flow] restoring ${unit} — existing local transcripts are kept${
      overwrite ? ' (OVERWRITE requested)' : ''
    }…\n`,
  });
}
