// /api/card-refresh — ask the daemon to bring one card up to date now.
//
// POST { unitId }
//   Appends a `RefreshCard` event to events.jsonl, the file the daemon already
//   tails (it is how the hooks reach it). The daemon runs the per-card form of
//   each clock job — the worktree list, the card's state.yaml, its Linear fields
//   — catches up its session transcripts, and rewrites the card with a new
//   `cardRefreshedAt` (plus `cardRefreshError` if a step failed).
import { appendFileSync } from 'node:fs';
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

export async function POST(req: Request): Promise<NextResponse> {
  let body: { unitId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
  const unitId = (body.unitId ?? '').trim();
  if (!unitId) return NextResponse.json({ error: 'unitId is required' }, { status: 400 });
  try {
    const event = { kind: 'RefreshCard', unitId, ts: new Date().toISOString() };
    appendFileSync(join(dataDir(), 'events.jsonl'), JSON.stringify(event) + '\n');
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
