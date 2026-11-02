// lib/master.ts — the daemon's side of the Briefing master session
// (docs/briefing.md, "The master" and "Daemon"): the scheduled request files
// and the supervisor that starts or hard-restarts the master.
//
// Files, all under <dataDir>/master/ (the same dir claude-ks-master and the
// ks-master mod use):
//   session.json        { v: 1, sessionId, pid, tmuxPane, cwd, startedAt, handoff } — the launcher writes it, the mod fills pid
//   heartbeat.json      { sessionId, at, busy } — the mod, every 30 s
//   requests/<iso>-<trigger>.json  { v: 1, id, trigger, slot, createdAt, prompt } — the daemon writes `schedule` ones
//   daemon-state.json   { v: 1, slotAt, lastActionAt, lastAction } — the daemon's own memory across restarts
//   notices.json        { v: 1, items: { <uid>: { hot?, overdue?, lastNag? } } } — the briefing notices the daemon sent
//   launch.log          output of the start/restart commands the daemon runs (append)
//   start-request.json  { v: 1, at, by } — the board's "Start master"; the daemon takes it on its next tick
//
// The decisions (which slot to write, start or restart) are pure functions with
// tests (master.test.ts); the rest is file and process I/O for daemon.ts. What
// the daemon did (starts, restarts, schedule requests) is also kept as history
// in the store's master_events (lib/master-events.ts) for the Activity Log.
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchOutcome, type EventOutcome } from './master-events.js';

// ── the commands the daemon runs (plugins/ks/scripts) ──────────────────────
// Kept here, in one place: part D owns these scripts and their flags.
/** No live master: start one in a new tmux window (or a new tmux session). */
export const MASTER_START_CMD = ['claude-ks-master', '--detached'] as const;
/** A master that stopped taking requests: replace it, no handoff. */
export const MASTER_RESTART_CMD = ['claude-ks-rc-restart', '--master', '--force'] as const;

/** A request older than this, with a stale heartbeat, means the master is stuck. */
export const REQUEST_STUCK_MS = 15 * 60_000;
/** A heartbeat older than this is stale (the mod writes one every 30 s). */
export const HEARTBEAT_STALE_MS = 5 * 60_000;
/** At most one start or restart per this long. */
export const ACTION_GAP_MS = 10 * 60_000;
/** A session.json this young with no pid yet is a master still starting up. */
export const START_GRACE_MS = 3 * 60_000;
/** With no pid yet, a heartbeat of the same session this fresh also means
 * "starting", whatever startedAt says (the mod beats every 30 s). */
export const STARTING_BEAT_MS = 2 * 60_000;
/** A schedule slot missed (daemon down, Mac asleep) is still written within this long. */
export const MISSED_SLOT_MS = 6 * 3_600_000;

export type Trigger = 'schedule' | 'button' | 'restart';

export interface MasterSession {
  v: 1;
  sessionId: string;
  pid: number | null;
  tmuxPane: string | null;
  cwd: string;
  startedAt: string;
  handoff: string | null;
}

export interface Heartbeat {
  sessionId: string;
  at: string;
  busy: boolean;
}

export interface MasterRequest {
  v: 1;
  id: string;
  trigger: Trigger;
  slot: string | null;
  createdAt: string;
  prompt: string;
}

export interface DaemonState {
  v: 1;
  /** ISO of the newest schedule slot handled (written, or skipped while off). */
  slotAt: string | null;
  /** ISO of the last start/restart the daemon ran. */
  lastActionAt: string | null;
  lastAction: 'start' | 'restart' | null;
}

// ── schedule slots ─────────────────────────────────────────────────────────

/** The newest slot at or before `now` (local time), among today's and
 * yesterday's: `{ slot: '06:00', at }`. Null for an empty schedule. */
export function latestSlot(now: Date, schedule: readonly string[]): { slot: string; at: Date } | null {
  let best: { slot: string; at: Date } | null = null;
  for (const slot of schedule) {
    const m = /^(\d{2}):(\d{2})$/.exec(slot);
    if (!m) continue;
    const h = Number(m[1]);
    const min = Number(m[2]);
    let at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min);
    if (at.getTime() > now.getTime()) at = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, h, min);
    if (!best || at.getTime() > best.at.getTime()) best = { slot, at };
  }
  return best;
}

/**
 * What the schedule job does at `now`. Each slot is handled once: written as a
 * request when briefing is on and the slot is at most MISSED_SLOT_MS old, else
 * only marked handled (off, too old, or the very first run — which arms the
 * clock rather than firing a slot that passed before the feature existed).
 * `advanceTo` is the new `slotAt` to remember; null = nothing to do.
 */
export function decideSchedule(input: {
  now: Date;
  schedule: readonly string[];
  enabled: boolean;
  slotAt: string | null;
}): { write: { slot: string; at: Date } | null; advanceTo: Date | null; why: string } {
  const latest = latestSlot(input.now, input.schedule);
  if (!latest) return { write: null, advanceTo: null, why: 'no schedule' };
  const handled = input.slotAt ? Date.parse(input.slotAt) : NaN;
  if (Number.isFinite(handled) && handled >= latest.at.getTime()) {
    return { write: null, advanceTo: null, why: 'slot already handled' };
  }
  if (!Number.isFinite(handled)) return { write: null, advanceTo: latest.at, why: 'first run: armed' };
  if (!input.enabled) return { write: null, advanceTo: latest.at, why: 'briefing off' };
  if (input.now.getTime() - latest.at.getTime() > MISSED_SLOT_MS) {
    return { write: null, advanceTo: latest.at, why: 'missed by more than 6 h' };
  }
  return { write: latest, advanceTo: latest.at, why: 'due' };
}

/** The scheduled request's prompt (the ks-master briefing skill: `<trigger> [slot]`). */
export function schedulePrompt(slot: string): string {
  return `/ks-master:briefing schedule ${slot}`;
}

// ── supervision ────────────────────────────────────────────────────────────

export type SupervisorAction = 'start' | 'restart';

/**
 * Start, hard-restart or leave the master. `alive` = session.json names a
 * running Claude process (by pid, or by its session id among live sessions).
 * `oldestRequestAt` = ms epoch of the oldest file still in requests/.
 * Rules: no live master → start; a request pending > 15 min and a heartbeat
 * older than 5 min (or none) → restart; never two actions within 10 min.
 */
export function decideSupervision(input: {
  now: number;
  session: MasterSession | null;
  alive: boolean;
  heartbeat: Heartbeat | null;
  oldestRequestAt: number | null;
  lastActionAt: number | null;
}): { action: SupervisorAction | null; why: string } {
  const { now } = input;
  let want: { action: SupervisorAction; why: string } | null = null;
  const started = input.session ? Date.parse(input.session.startedAt) : NaN;
  // A heartbeat from THIS session (a previous master's last beat says nothing
  // about this one) under STARTING_BEAT_MS old: the mod is running.
  const beatAt = input.heartbeat && input.session && input.heartbeat.sessionId === input.session.sessionId
    ? Date.parse(input.heartbeat.at)
    : NaN;
  const ownBeatFresh = Number.isFinite(beatAt) && now - beatAt < STARTING_BEAT_MS;
  if (!input.session) want = { action: 'start', why: 'no session.json' };
  else if (
    !input.alive &&
    input.session.pid === null &&
    ((Number.isFinite(started) && now - started < START_GRACE_MS) || ownBeatFresh)
  ) {
    // Starting, not down: just launched (by anyone) and the mod has not filled
    // pid yet, or the mod is beating for this session but its pid is not
    // recorded (nor its process seen) yet. Starting another would run two masters.
    return { action: null, why: 'ok' };
  } else if (!input.alive) {
    want = {
      action: 'start',
      why: input.session.pid ? `pid ${input.session.pid} is not running` : 'no live process for session.json',
    };
  } else if (input.oldestRequestAt !== null && now - input.oldestRequestAt > REQUEST_STUCK_MS) {
    const beat = input.heartbeat ? Date.parse(input.heartbeat.at) : NaN;
    const beatAge = Number.isFinite(beat) ? now - beat : Infinity;
    if (beatAge > HEARTBEAT_STALE_MS) {
      const mins = Math.round((now - input.oldestRequestAt) / 60_000);
      want = {
        action: 'restart',
        why: `a request pending ${mins} min, heartbeat ${
          Number.isFinite(beatAge) ? `${Math.round(beatAge / 60_000)} min old` : 'missing'
        }`,
      };
    }
  }
  if (!want) return { action: null, why: 'ok' };
  if (input.lastActionAt !== null && now - input.lastActionAt < ACTION_GAP_MS) {
    return { action: null, why: `${want.action} wanted (${want.why}) but the last action was under 10 min ago` };
  }
  return want;
}

// ── file I/O ───────────────────────────────────────────────────────────────

export function masterDir(dataDir: string): string {
  return join(dataDir, 'master');
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Write via a dot-file + rename, so a reader (the mod polls every 15 s, and
 * skips dot-files) never sees half a file. */
function writeAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${path.split('/').pop()}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, path);
}

export function readSession(dir: string): MasterSession | null {
  const raw = readJson(join(dir, 'session.json'));
  if (!isObject(raw) || typeof raw.sessionId !== 'string') return null;
  return {
    v: 1,
    sessionId: raw.sessionId,
    pid: typeof raw.pid === 'number' ? raw.pid : null,
    tmuxPane: typeof raw.tmuxPane === 'string' ? raw.tmuxPane : null,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
    handoff: typeof raw.handoff === 'string' ? raw.handoff : null,
  };
}

/**
 * The board's "Start master" press, if one is waiting: read and removed in one
 * go (a second tick never sees it). Null when there is none. An unreadable file
 * still counts as a press.
 */
export function takeStartRequest(dir: string): { at: string | null; by: string } | null {
  const path = join(dir, 'start-request.json');
  if (!existsSync(path)) return null;
  const raw = readJson(path);
  try {
    unlinkSync(path);
  } catch {
    // already taken
  }
  return {
    at: isObject(raw) && typeof raw.at === 'string' ? raw.at : null,
    by: isObject(raw) && typeof raw.by === 'string' ? raw.by : 'board',
  };
}

/**
 * Whether a "Start master" press should launch one: yes unless a master is
 * running or still starting (the same test as decideSupervision, without its
 * 10-minute gap or stuck-request rule — a person asked for it).
 */
export function decideManualStart(input: {
  now: number;
  session: MasterSession | null;
  alive: boolean;
  heartbeat: Heartbeat | null;
}): { start: boolean; why: string } {
  const d = decideSupervision({ ...input, oldestRequestAt: null, lastActionAt: null });
  if (d.action === 'start') return { start: true, why: `requested from the board (${d.why})` };
  return { start: false, why: input.alive ? 'the master is already running' : 'the master is still starting' };
}

export function readHeartbeat(dir: string): Heartbeat | null {
  const raw = readJson(join(dir, 'heartbeat.json'));
  if (!isObject(raw) || typeof raw.at !== 'string') return null;
  return {
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
    at: raw.at,
    busy: raw.busy === true,
  };
}

export function readDaemonState(dir: string): DaemonState {
  const raw = readJson(join(dir, 'daemon-state.json'));
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  if (!isObject(raw)) return { v: 1, slotAt: null, lastActionAt: null, lastAction: null };
  return {
    v: 1,
    slotAt: str(raw.slotAt),
    lastActionAt: str(raw.lastActionAt),
    lastAction: raw.lastAction === 'start' || raw.lastAction === 'restart' ? raw.lastAction : null,
  };
}

export function writeDaemonState(dir: string, state: DaemonState): void {
  writeAtomic(join(dir, 'daemon-state.json'), state);
}

/** notices.json `{ v: 1, items: { <uid>: { hot?, overdue?, lastNag? } } }`:
 * the daemon's own record of the briefing notices it sent (lib/briefing/notices).
 * Kept out of the items so the daemon never writes one. Missing or unreadable
 * → empty (a notice may then be sent once more). */
export function readNotices(dir: string): Record<string, { hot?: string; overdue?: string; lastNag?: string }> {
  const raw = readJson(join(dir, 'notices.json'));
  const out: Record<string, { hot?: string; overdue?: string; lastNag?: string }> = {};
  if (!isObject(raw) || !isObject(raw.items)) return out;
  for (const [uid, n] of Object.entries(raw.items)) {
    if (!isObject(n)) continue;
    const e: { hot?: string; overdue?: string; lastNag?: string } = {};
    for (const k of ['hot', 'overdue', 'lastNag'] as const) if (typeof n[k] === 'string') e[k] = n[k] as string;
    out[uid] = e;
  }
  return out;
}

export function writeNotices(dir: string, items: Record<string, { hot?: string; overdue?: string; lastNag?: string }>): void {
  writeAtomic(join(dir, 'notices.json'), { v: 1, items });
}

/** The pending requests (requests/*.json, dot-files skipped): trigger and when
 * made (createdAt, else the file's mtime). An unreadable file counts with its
 * name's trigger, so it still blocks a duplicate and still ages. */
export function pendingRequests(dir: string): { name: string; trigger: string | null; createdAt: number }[] {
  const reqDir = join(dir, 'requests');
  let names: string[];
  try {
    names = readdirSync(reqDir);
  } catch {
    return [];
  }
  const out: { name: string; trigger: string | null; createdAt: number }[] = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    const path = join(reqDir, name);
    const raw = readJson(path);
    let created = isObject(raw) && typeof raw.createdAt === 'string' ? Date.parse(raw.createdAt) : NaN;
    if (!Number.isFinite(created)) {
      try {
        created = statSync(path).mtimeMs;
      } catch {
        continue; // taken by the mod between the list and the stat
      }
    }
    const trigger =
      isObject(raw) && typeof raw.trigger === 'string'
        ? raw.trigger
        : (/-([a-z-]+)\.json$/.exec(name)?.[1] ?? null);
    out.push({ name, trigger, createdAt: created });
  }
  return out;
}

/** Write a request file unless one with the same trigger is pending (one per
 * trigger). Returns the written request, or null when it was dropped. */
export function writeRequest(
  dir: string,
  input: { trigger: Trigger; slot: string | null; prompt: string; now?: Date },
): MasterRequest | null {
  if (pendingRequests(dir).some((r) => r.trigger === input.trigger)) return null;
  const createdAt = (input.now ?? new Date()).toISOString();
  const req: MasterRequest = {
    v: 1,
    id: randomUUID(),
    trigger: input.trigger,
    slot: input.slot,
    createdAt,
    prompt: input.prompt,
  };
  writeAtomic(join(dir, 'requests', `${createdAt}-${input.trigger}.json`), req);
  return req;
}

// ── processes ──────────────────────────────────────────────────────────────

/** Whether `pid` is a running Claude process (the same test claude-ks-master
 * uses: `ps` shows a command containing "claude"). */
export function pidIsClaude(pid: number): boolean {
  try {
    const cmd = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return cmd.includes('claude');
  } catch {
    return false; // ps exits 1 for no such process
  }
}

let scriptsDirCache: string | null = null;

/**
 * plugins/ks/scripts, where claude-ks-master and claude-ks-rc-restart live.
 * KS_SCRIPTS_DIR overrides; else walk up from this file (dist/lib/master.js or
 * lib/master.ts in plugins/ks-flow/src) to a dir holding ks/scripts; else ask
 * the login shell (ks init puts the scripts on PATH; launchd's PATH lacks it).
 * A miss is not cached: the next action looks again.
 */
export function ksScriptsDir(): string | null {
  if (scriptsDirCache) return scriptsDirCache;
  const has = (d: string) => existsSync(join(d, MASTER_START_CMD[0]));
  const env = process.env.KS_SCRIPTS_DIR;
  if (env && has(env)) return (scriptsDirCache = env);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const cand = join(dir, 'ks', 'scripts');
    if (has(cand)) return (scriptsDirCache = cand);
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  try {
    const found = execFileSync('/bin/zsh', ['-c', `${LOGIN_PRELUDE} command -v ${MASTER_START_CMD[0]}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (found) scriptsDirCache = dirname(found);
  } catch {
    // not on the login shell's PATH either
  }
  return scriptsDirCache;
}

// The user's shell setup, for PATH (tmux, jq, claude live in Homebrew and
// ~/.local, which launchd's PATH lacks) — the same prelude lib/notify uses.
const LOGIN_PRELUDE =
  '{ [ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile"; ' +
  '[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"; } 2>/dev/null;';

/**
 * Run a supervisor command (MASTER_START_CMD / MASTER_RESTART_CMD) from
 * plugins/ks/scripts through the login shell's PATH, detached so it outlives a
 * daemon restart. Its output goes to `<masterDir>/launch.log` (append), not to
 * pipes: a pipe to the daemon would SIGPIPE the command if the daemon exited
 * while it ran (the restart command can outlive a daemon restart). The exit
 * code is logged when the daemon is still around to see it.
 *
 * `onDone` (once): `{result: 'failed', detail}` when the command could not be
 * launched, else its exit through `launchOutcome` — what the Activity Log's
 * master event records. Never called when the daemon exits first.
 */
export function runMasterCommand(
  cmd: readonly string[],
  masterDirPath: string,
  log: (...a: unknown[]) => void,
  onDone?: (outcome: EventOutcome) => void,
): void {
  let reported = false;
  const done = (o: EventOutcome): void => {
    if (reported) return;
    reported = true;
    try {
      onDone?.(o);
    } catch (e) {
      log('master: onDone failed', (e as Error)?.message);
    }
  };
  const dir = ksScriptsDir();
  if (!dir) {
    log(`master: cannot run ${cmd.join(' ')} — plugins/ks/scripts not found (set KS_SCRIPTS_DIR)`);
    done({ result: 'failed', detail: 'plugins/ks/scripts not found (set KS_SCRIPTS_DIR)' });
    return;
  }
  const [name, ...args] = cmd;
  const script = join(dir, name!);
  const logPath = join(masterDirPath, 'launch.log');
  let out: number;
  try {
    mkdirSync(masterDirPath, { recursive: true });
    out = openSync(logPath, 'a');
    writeSync(out, `\n── ${new Date().toISOString()} ${cmd.join(' ')}\n`);
  } catch (e) {
    log(`master: cannot open ${logPath}:`, (e as Error).message);
    done({ result: 'failed', detail: `cannot open ${logPath}: ${(e as Error).message}` });
    return;
  }
  // The daemon's own node first: the scripts run `node …/datadir.mjs`.
  // The login shell (zsh -c sourcing the profile) is what puts tmux/claude on
  // PATH under launchd. The shell string is fixed: the script and its args go
  // in as argv ($0 "$@"), never interpolated into it.
  const prelude = `${LOGIN_PRELUDE} export PATH="$KS_FLOW_NODE_DIR:$PATH";`;
  try {
    const child = spawn('/bin/zsh', ['-c', `${prelude} exec "$0" "$@"`, script, ...args], {
      stdio: ['ignore', out, out],
      detached: true,
      // KS_MASTER_DIR: the scripts use the daemon's master dir instead of
      // resolving the data dir again under launchd's environment. Set only for
      // these two commands, not in the daemon's own env.
      env: { ...process.env, KS_FLOW_NODE_DIR: dirname(process.execPath), KS_MASTER_DIR: masterDirPath },
    });
    child.on('error', (e: Error) => {
      log(`master: ${cmd.join(' ')} failed to spawn:`, e.message);
      done({ result: 'failed', detail: `failed to spawn: ${e.message}` });
    });
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      log(`master: ${cmd.join(' ')} exited ${signal ?? code} (output in ${logPath})`);
      done(launchOutcome(code, signal));
    });
    child.unref();
    log(`master: launched ${cmd.join(' ')} (pid ${child.pid ?? '?'}, output in ${logPath})`);
  } catch (e) {
    log(`master: ${cmd.join(' ')} failed to spawn:`, (e as Error)?.message);
    done({ result: 'failed', detail: `failed to spawn: ${(e as Error)?.message}` });
  } finally {
    closeSync(out); // the child holds its own copy of the descriptor
  }
}
