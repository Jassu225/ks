// lib/claude-sessions.ts — the Claude Code processes running right now.
//
// Claude Code keeps one ~/.claude/sessions/<pid>.json per running session
// (pid, sessionId, cwd, procStart, tmux pane, …) and deletes it on a clean
// exit. A crash leaves the file behind, and macOS reuses pids, so a file only
// counts while its pid is alive AND that process started at the recorded
// procStart (`ps lstart` format, in UTC).
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LiveSession } from './db/types.js';

export const CLAUDE_SESSIONS_DIR = join(homedir(), '.claude', 'sessions');

const squash = (s: string): string => s.trim().replace(/\s+/g, ' ');

/** pid → `ps lstart` for the given pids, or null if `ps` couldn't run. */
function startTimes(pids: number[]): Map<number, string> | null {
  try {
    // Claude writes procStart in UTC; ps prints lstart in the local zone.
    const out = execFileSync('/bin/ps', ['-p', pids.join(','), '-o', 'pid=,lstart='], {
      encoding: 'utf8',
      timeout: 4000,
      env: { ...process.env, TZ: 'UTC' },
    });
    const map = new Map<number, string>();
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.+)$/);
      if (m) map.set(Number(m[1]), squash(m[2]));
    }
    return map;
  } catch (e) {
    // ps exits 1 when none of the pids exist — that's an empty answer, not a failure.
    if ((e as { status?: number }).status === 1) return new Map();
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Live interactive Claude Code sessions, newest first. */
export function readLiveSessions(): LiveSession[] {
  let files: string[];
  try {
    files = readdirSync(CLAUDE_SESSIONS_DIR).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return [];
  }
  const found: LiveSession[] = [];
  for (const f of files) {
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(readFileSync(join(CLAUDE_SESSIONS_DIR, f), 'utf8'));
    } catch {
      continue; // mid-write or unreadable — the next scan picks it up
    }
    const pid = Number(r.pid);
    if (!pid || r.kind !== 'interactive' || typeof r.cwd !== 'string') continue;
    if (typeof r.sessionId !== 'string' || typeof r.procStart !== 'string') continue;
    if (!alive(pid)) continue;
    const tmux = typeof r.tmux === 'string' ? r.tmux.match(/%\d+$/) : null;
    found.push({
      pid,
      sessionId: r.sessionId,
      cwd: r.cwd,
      procStart: squash(r.procStart),
      startedAt: new Date(Number(r.startedAt) || 0).toISOString(),
      tmuxPane: tmux ? tmux[0] : null,
      name: typeof r.name === 'string' ? r.name : null,
    });
  }
  const starts = found.length ? startTimes(found.map((s) => s.pid)) : null;
  return found
    .filter((s) => !starts || starts.get(s.pid) === s.procStart)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
