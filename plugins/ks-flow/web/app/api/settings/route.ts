// /api/settings — read/write board-local settings (NOT project.conf, which the
// bootstrap rewrites). Currently holds the user's worktree-removal command.
//
// GET  → { removeCommand }
// POST { removeCommand } → persist it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

function dataDir(): string {
  return (
    process.env.CLAUDE_PLUGIN_DATA ||
    join(homedir(), '.claude', 'plugins', 'data', 'ks-flow-karmasuite')
  );
}
const settingsPath = (): string => join(dataDir(), 'board-settings.json');

function read(): { removeCommand: string } {
  try {
    const s = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    return { removeCommand: typeof s.removeCommand === 'string' ? s.removeCommand : '' };
  } catch {
    return { removeCommand: '' };
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(read());
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: { removeCommand?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
  const removeCommand = typeof body.removeCommand === 'string' ? body.removeCommand.trim() : '';
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const next = { ...read(), removeCommand };
  writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  return NextResponse.json({ ok: true, ...next });
}
