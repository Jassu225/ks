// /api/processes — list the ks-flow-related processes currently running, so a
// stray/duplicate daemon (e.g. an old manual `node dist/daemon.js` left running
// alongside the launchd one) is visible at a glance.
//
// GET  → { processes: Array<{ name, pid, startedAt, startedAtRaw, port, command }> }
// POST → { pid } kills that process (SIGTERM). The pid is re-validated against a
//        fresh `ps` scan: ONLY a process that classifies as a ks-flow daemon may
//        be killed, so a crafted request can't terminate an arbitrary pid.
//
// Gathered from `ps` (pid + start time + command) joined to `lsof` (pid →
// listening TCP port). Classifies the daemon, PocketBase, and the board itself.
import { execFileSync } from 'node:child_process';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

interface ProcInfo {
  name: string;
  pid: number;
  startedAt: string | null; // ISO, if parseable
  startedAtRaw: string; // raw `ps lstart`
  port: number | null;
  command: string;
}

// pid → first listening TCP port.
function listeningPorts(): Map<number, number> {
  const map = new Map<number, number>();
  try {
    const out = execFileSync('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], {
      encoding: 'utf8',
      timeout: 4000,
    });
    for (const line of out.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 9) continue;
      const pid = Number(cols[1]);
      // The NAME column is e.g. "*:4317" or "127.0.0.1:8090", followed by a
      // state like "(LISTEN)" — so scan for the address token, not the last one.
      let port: number | null = null;
      for (const c of cols) {
        const m = c.match(/:(\d+)$/);
        if (m) port = Number(m[1]);
      }
      if (pid && port !== null && !map.has(pid)) map.set(pid, port);
    }
  } catch {
    /* lsof unavailable — ports just stay null */
  }
  return map;
}

function classify(command: string, port: number | null, boardPort: number): string | null {
  if (/dist\/daemon\.js\b/.test(command) || /\bdaemon\.(js|ts)\b/.test(command))
    return 'ks-flow daemon';
  if (/\bpocketbase\b/i.test(command)) return 'PocketBase';
  if (port === boardPort && /\b(next|node)\b/.test(command)) return 'board (web)';
  return null;
}

// Scan `ps`/`lsof` and return the classified ks-flow processes. Throws if `ps`
// itself fails so callers can distinguish "no matches" from "couldn't scan".
function collectProcesses(): ProcInfo[] {
  const boardPort = Number(process.env.PORT) || 4317;
  const ports = listeningPorts();

  const out = execFileSync('/bin/ps', ['-ax', '-o', 'pid=,lstart=,command='], {
    encoding: 'utf8',
    timeout: 4000,
    maxBuffer: 8 * 1024 * 1024,
  });

  const processes: ProcInfo[] = [];
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/\s+/);
    if (parts.length < 7) continue;
    const pid = Number(parts[0]);
    if (!pid) continue;
    const startedAtRaw = parts.slice(1, 6).join(' '); // DOW MON DD HH:MM:SS YYYY
    const command = parts.slice(6).join(' ');
    if (/[/ ]ps -ax|lsof -nP/.test(command)) continue; // skip our own probes
    const port = ports.get(pid) ?? null;
    const name = classify(command, port, boardPort);
    if (!name) continue;
    let startedAt: string | null = null;
    try {
      const d = new Date(startedAtRaw);
      if (!Number.isNaN(d.getTime())) startedAt = d.toISOString();
    } catch {
      /* leave null */
    }
    processes.push({ name, pid, startedAt, startedAtRaw, port, command });
  }

  // daemons first (so duplicates are obvious), then by name, then pid.
  processes.sort((a, b) => {
    const da = a.name === 'ks-flow daemon' ? 0 : 1;
    const db = b.name === 'ks-flow daemon' ? 0 : 1;
    return da - db || a.name.localeCompare(b.name) || a.pid - b.pid;
  });
  return processes;
}

export async function GET(): Promise<NextResponse> {
  let processes: ProcInfo[];
  try {
    processes = collectProcesses();
  } catch {
    return NextResponse.json({ processes: [], daemonCount: 0, error: 'ps failed' });
  }
  const daemonCount = processes.filter((p) => p.name === 'ks-flow daemon').length;
  return NextResponse.json({ processes, daemonCount });
}

export async function POST(req: Request): Promise<NextResponse> {
  let pid: number;
  try {
    const body = (await req.json()) as { pid?: unknown };
    pid = Number(body?.pid);
  } catch {
    return NextResponse.json({ ok: false, error: 'bad request' }, { status: 400 });
  }
  if (!Number.isInteger(pid) || pid <= 1) {
    return NextResponse.json({ ok: false, error: 'invalid pid' }, { status: 400 });
  }

  // Re-validate against a live scan: only a *currently-running ks-flow daemon*
  // may be killed. This is the security boundary — never trust the pid alone.
  let processes: ProcInfo[];
  try {
    processes = collectProcesses();
  } catch {
    return NextResponse.json({ ok: false, error: 'ps failed' }, { status: 500 });
  }
  const target = processes.find((p) => p.pid === pid);
  if (!target || target.name !== 'ks-flow daemon') {
    return NextResponse.json(
      { ok: false, error: 'pid is not a running ks-flow daemon' },
      { status: 409 },
    );
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as { message?: string })?.message ?? 'kill failed' },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, pid });
}
