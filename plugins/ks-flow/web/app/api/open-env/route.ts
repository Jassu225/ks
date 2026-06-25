// /api/open-env — open $CLAUDE_PLUGIN_DATA/.env in the OS default TEXT editor.
//
// The .env holds secrets (SLACK_TOKEN, LINEAR_API_KEY, GCS/Firebase creds). It is
// deliberately NEVER read here and NEVER sent over HTTP — the server just hands
// the path to the editor (`open -t`). We only ensure the file exists first (with
// a comment header if brand-new) so the editor opens something.
//
// POST → { ok: boolean, path: string }
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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

const TEMPLATE = `# ks-flow secrets & config — read by the daemon and the board server.
# A value exported in your shell / launchd OVERRIDES the same key here.
# After editing, restart the daemon (board "kill" button → restarts next session)
# for daemon-side consumers to pick up changes.
#
# SLACK_TOKEN=xoxp-...        # user token (stars:read) for the Notes Slack section
# LINEAR_API_KEY=lin_api_...  # for the Notes Linear section
# GCS_BUCKET=my-ks-flow-archives
`;

export async function POST(): Promise<NextResponse> {
  const path = join(dataDir(), '.env');
  try {
    if (!existsSync(path)) {
      mkdirSync(dataDir(), { recursive: true });
      writeFileSync(path, TEMPLATE, { mode: 0o600 });
    }
    // `open -t` forces the default *text* editor (a bare .env has no default app).
    const child = spawn('open', ['-t', path], { stdio: 'ignore', detached: true });
    child.on('error', () => {
      /* not macOS / open missing — ignore */
    });
    child.unref();
    return NextResponse.json({ ok: true, path });
  } catch {
    return NextResponse.json({ ok: false, path }, { status: 500 });
  }
}
