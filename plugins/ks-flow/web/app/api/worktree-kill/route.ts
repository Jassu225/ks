// /api/worktree-kill — kill every live process whose cwd is inside a worktree.
//
// POST { path } → { killed: number[], stillAlive: number[] }
//   Re-detects the live processes at kill time (never trusts client-supplied
//   pids), SIGTERMs them, waits, then SIGKILLs any survivor. Used after the user
//   explicitly confirms in the board — this closes the Claude Code session and
//   the terminal shell sitting in the worktree so the remove command can run.
//
// DESTRUCTIVE: terminates processes (a running Claude session loses its unsaved
// turn). Only reached behind an explicit confirmation in the UI. The board's own
// server pid is excluded defensively.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NextResponse } from 'next/server';

const execFileP = promisify(execFile);
export const dynamic = 'force-dynamic';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** PIDs with a cwd under `path` (excluding this server). lsof -t = terse pids. */
async function pidsUnder(path: string): Promise<number[]> {
  let out = '';
  try {
    const r = await execFileP('lsof', ['-nP', '-t', '-a', '-d', 'cwd', '+D', path], {
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    out = r.stdout;
  } catch (e) {
    out = (e as { stdout?: string }).stdout ?? '';
  }
  return [
    ...new Set(
      out
        .split('\n')
        .map((s) => Number(s.trim()))
        .filter((n) => n > 0 && n !== process.pid),
    ),
  ];
}

function signal(pids: number[], sig: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, sig);
    } catch {
      // already gone / not ours — ignore
    }
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: { path?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
  const worktree = (body.path ?? '').trim();
  if (!worktree) {
    return NextResponse.json({ error: 'A worktree path is required.' }, { status: 400 });
  }

  const initial = await pidsUnder(worktree);
  if (initial.length === 0) return NextResponse.json({ killed: [], stillAlive: [] });

  signal(initial, 'SIGTERM');
  await sleep(700);
  const survivors = await pidsUnder(worktree);
  if (survivors.length) {
    signal(survivors, 'SIGKILL');
    await sleep(300);
  }

  const stillAlive = await pidsUnder(worktree);
  return NextResponse.json({ killed: initial, stillAlive });
}
