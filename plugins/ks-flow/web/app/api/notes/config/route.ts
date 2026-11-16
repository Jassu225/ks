// /api/notes/config — what the Notes page may render.
//
// GET → {
//   enabled,                          // master toggle (generic section shows when on)
//   slack:  { enabled, tokenPresent },   // shows when enabled && SLACK_TOKEN present
//   linear: { enabled, keyPresent },     // shows when enabled && LINEAR_API_KEY present
// }
// Slack can't LIST saved messages (Slack retired that API in 2023), but a single
// message IS fetchable by its permalink via SLACK_TOKEN (conversations.history) —
// so the Slack section needs the token. Only booleans leave the server; the tokens
// themselves never do.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { loadDataEnv } from '@/lib/envfile';

export const dynamic = 'force-dynamic';

function dataDir(): string {
  return (
    process.env.KS_FLOW_DATA ||
    process.env.CLAUDE_PLUGIN_DATA ||
    join(homedir(), '.claude', 'plugins', 'data', 'ks-flow-karmasuite')
  );
}

export async function GET(): Promise<NextResponse> {
  loadDataEnv(join(dataDir(), '.env'));
  let notes = { enabled: false, slack: false, linear: false };
  try {
    const s = JSON.parse(readFileSync(join(dataDir(), 'board-settings.json'), 'utf8'));
    const n = s.notes ?? {};
    notes = { enabled: n.enabled === true, slack: n.slack === true, linear: n.linear === true };
  } catch {
    /* no settings file → defaults (feature off) */
  }
  return NextResponse.json({
    enabled: notes.enabled,
    slack: { enabled: notes.slack, tokenPresent: !!(process.env.SLACK_TOKEN ?? '').trim() },
    linear: { enabled: notes.linear, keyPresent: !!(process.env.LINEAR_API_KEY ?? '').trim() },
  });
}
