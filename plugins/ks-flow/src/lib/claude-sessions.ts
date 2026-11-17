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

/**
 * A live session with the fields that change while it runs, for the peers
 * list (lib/peers.ts): its Remote Control id and Claude's own busy/idle. Cards
 * keep only the LiveSession part (toLiveSession), so these flips never rewrite
 * a card.
 */
export interface LiveProcess extends LiveSession {
  /** Remote Control's session id (`session_…`), the address `bridge:<id>`; null without Remote Control. */
  bridgeSessionId: string | null;
  /** Claude's own status (busy, idle, …) and when it last changed (ISO). */
  status: string | null;
  statusAt: string | null;
}

/** The fields a card keeps. */
export function toLiveSession(p: LiveProcess): LiveSession {
  return { pid: p.pid, sessionId: p.sessionId, cwd: p.cwd, procStart: p.procStart, startedAt: p.startedAt, tmuxPane: p.tmuxPane, name: p.name };
}

const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const isoOrNull = (v: unknown): string | null => (typeof v === 'number' && v > 0 ? new Date(v).toISOString() : null);

/** Live interactive Claude Code sessions, newest first (cards' fields only). */
export function readLiveSessions(): LiveSession[] {
  return readLiveProcesses().map(toLiveSession);
}

/** Live interactive Claude Code sessions with their changing fields, newest first. */
export function readLiveProcesses(): LiveProcess[] {
  let files: string[];
  try {
    files = readdirSync(CLAUDE_SESSIONS_DIR).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return [];
  }
  const found: LiveProcess[] = [];
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
      bridgeSessionId: strOrNull(r.bridgeSessionId),
      status: strOrNull(r.status),
      statusAt: isoOrNull(r.statusUpdatedAt),
    });
  }
  const starts = found.length ? startTimes(found.map((s) => s.pid)) : null;
  return found
    .filter((s) => !starts || starts.get(s.pid) === s.procStart)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
