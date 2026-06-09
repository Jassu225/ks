// /api/worktree-busy — is any live process using this worktree right now?
//
// POST { path } → { busy, processes: [{ pid, command, isClaude }] }
//   Ground truth via `lsof`: lists every process whose current working
//   directory is INSIDE the worktree (an open shell, an editor, or the Claude
//   Code CLI, which runs as `node`). lsof's command name is the executable, so
//   each pid is cross-checked with `ps` to read the full argv and flag the ones
//   that are a Claude Code session.
//
// Used as a hard gate before /api/run-command: the board refuses to remove a
// worktree while something live still sits in it.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NextResponse } from 'next/server';

const execFileP = promisify(execFile);
export const dynamic = 'force-dynamic';

interface Proc {
  pid: number;
  command: string;
  isClaude: boolean;
}

/** Parse `lsof -F pcn` records into {pid, lsofCommand, cwd}. */
function parseLsof(out: string): Array<{ pid: number; lsofCommand: string; cwd: string }> {
  const recs: Array<{ pid: number; lsofCommand: string; cwd: string }> = [];
  let pid = 0;
  let cmd = '';
  for (const line of out.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const val = line.slice(1);
    if (tag === 'p') pid = Number(val) || 0;
    else if (tag === 'c') cmd = val;
    else if (tag === 'n' && pid) recs.push({ pid, lsofCommand: cmd, cwd: val });
  }
  return recs;
}

/** pid → full argv, via one `ps` call. */
async function fullCommands(pids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (pids.length === 0) return map;
  try {
    const { stdout } = await execFileP('ps', ['-p', pids.join(','), '-o', 'pid=,command='], {
      timeout: 10_000,
    });
    for (const line of stdout.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (m) map.set(Number(m[1]), m[2].trim());
    }
  } catch {
    // ps unavailable / no matches — fall back to lsof command names
  }
  return map;
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

  // lsof exits non-zero when there are no matches — that just means "not busy".
  let out = '';
  try {
    const r = await execFileP('lsof', ['-nP', '-a', '-d', 'cwd', '+D', worktree, '-F', 'pcn'], {
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    out = r.stdout;
  } catch (e) {
    out = (e as { stdout?: string }).stdout ?? '';
  }

  const recs = parseLsof(out);
  const argv = await fullCommands(recs.map((r) => r.pid));
  const seen = new Set<number>();
  const processes: Proc[] = [];
  for (const r of recs) {
    if (seen.has(r.pid)) continue;
    seen.add(r.pid);
    const command = argv.get(r.pid) ?? r.lsofCommand;
    processes.push({ pid: r.pid, command, isClaude: /\bclaude\b/i.test(command) });
  }

  return NextResponse.json({ busy: processes.length > 0, processes });
}
