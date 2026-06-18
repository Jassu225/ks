#!/usr/bin/env node
// daemon.ts — the ks-flow ingester. Always-on (launchd), single project.
//
// Pipeline:
//   backfill (worktree-enumerated projects/ dirs) → chokidar tail of session
//   JSONL + events.jsonl + workflow/**/state.yaml → derive → join → store.
// Only the daemon writes to the DB. Ingestion bookkeeping stays local
// (checkpoints.json); only derived documents go to the store.
import chokidar from 'chokidar';
import {
  createWriteStream,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { loadConfig, readProjectConf } from './lib/config.js';
import { createProvider } from './lib/db/index.js';
import type { ReminderDoc, SessionDoc, SessionWriter, WorkUnitDoc } from './lib/db/types.js';
import { reminderSettings } from './lib/boardsettings.js';
import { notify, terminalNotifierAvailable } from './lib/notify.js';
import {
  addOverlay,
  applyLine,
  materialize,
  newAcc,
  type SessionAcc,
} from './lib/derive.js';
import { parseComplete, readRange } from './lib/jsonl.js';
import { Checkpoints } from './lib/checkpoints.js';
import { startPocketbase, type PbHandle } from './lib/pbserver.js';
import {
  currentPhase,
  derivePhaseModel,
  projectWorkflowType,
  unitCompleted,
} from './lib/phasemodel.js';
import { joinUnit, sessionMatchesUnit } from './lib/join.js';
import { parseStateYaml } from './lib/stateyaml.js';
import {
  CLAUDE_PROJECTS_DIR,
  DAEMON_LOG_PATH,
  encodeProjectDir,
  EVENTS_PATH,
  expandTilde,
  workflowDir,
} from './lib/paths.js';
import { isInProject, listWorktrees, toplevel } from './lib/worktree.js';

const cfg = loadConfig();
const conf = readProjectConf();
if (!conf) {
  console.error('[ks-flow] no project.conf — run bootstrap or `ks-flow set-project <path>`. Exiting.');
  process.exit(0);
}
const { projectId, commonDir: PROJECT_COMMON_DIR, projectPath } = conf;
const provider = createProvider(cfg);
const writer: SessionWriter = provider.writer();

const IDLE_MS = cfg.idleMinutes * 60_000;
const OVERLAY_TTL_MS = 10 * 60_000;

// Truncate-on-start log: open with 'w' so daemon.log holds only the current
// run. The daemon owns this file (launchd's StandardOutPath → /dev/null) to
// avoid two writers. Also mirror to stdout so `ks-flow daemon` (foreground)
// shows logs in the terminal.
const logStream = createWriteStream(DAEMON_LOG_PATH, { flags: 'w' });
function log(...a: unknown[]): void {
  const msg = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  const line = `[${new Date().toISOString()}] [ks-flow] ${msg}\n`;
  logStream.write(line);
  process.stdout.write(line);
}
function nowIso(): string {
  return new Date().toISOString();
}
function sessionIdFromPath(p: string): string {
  return p.replace(/\.jsonl$/, '').split('/').pop()!;
}
function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// ── in-memory state ─────────────────────────────────────────────────────────
const checkpoints = new Checkpoints();
const accs = new Map<string, SessionAcc>(); // sessionId → accumulator
const sessionDocs = new Map<string, SessionDoc>(); // last materialized doc
const units = new Map<string, WorkUnitDoc>(); // stateYamlPath → work-unit
const stateMtimes = new Map<string, number>(); // stateYamlPath → last-parsed mtimeMs (read-I/O gate)
const lastUnitSig = new Map<string, string>(); // unitId → last-written doc signature (write gate)
let lastProjectSig: string | null = null; // last-written project doc signature (write gate)
const worktreePathCache = new Map<string, string | null>(); // cwd → toplevel
const pendingOverlays = new Map<string, Array<{ id: string; kind: string; since: string }>>();
let knownWorktrees: string[] = conf.worktreePaths ?? [];
let eventsOffset = 0;
let pbHandle: PbHandle | null = null;

// ── reminders ─────────────────────────────────────────────────────────────
interface StopState {
  stoppedAt: string; // ISO of the Stop event
  lastRemind: number; // ms epoch of the last nudge fired
  count: number; // nudges fired (capped)
  fromRestart?: boolean; // armed at startup (cold replay / warm reconstruct) →
  // its first notice is batched into one grouped restart notice, not fired solo
}
const stopState = new Map<string, StopState>(); // sessionId → stop-nudge state
// True only during startup arming, so stop-nudges armed then (cold-start events
// replay or warm-restart reconstruction) are marked fromRestart and consolidated
// into a single grouped notice instead of an N-notice burst. Cleared after the
// first reminderTick.
let armingFromStartup = true;
const REMINDER_TICK_MS = 30_000;
// Activity newer than the stop by more than this = a genuine resume (not the
// turn-ending transcript line, which trails the Stop event by a few seconds).
const RESUME_MARGIN_MS = 30_000;
let reminderLastTickMs = 0; // for OS-wake (timer-gap) detection
let reminderStartup = true; // first tick re-fires lapsed custom reminders

function worktreePathFor(cwd: string | null): string | null {
  if (!cwd) return null;
  if (worktreePathCache.has(cwd)) return worktreePathCache.get(cwd)!;
  const top = toplevel(cwd);
  worktreePathCache.set(cwd, top);
  return top;
}

// ── session ingestion ───────────────────────────────────────────────────────
/** Read new bytes of a session file, fold into its accumulator. Returns the
 * inProject decision (undefined = not yet determinable). `rebuild` forces a full
 * re-read from offset 0 to reconstruct the in-memory doc — used by startup
 * backfill, because a session file sits at its persisted EOF across a restart,
 * so the normal "no new bytes" fast path would never build its acc/SessionDoc.
 * Without the doc, stop-nudges can't match the session to its work-unit and
 * fall silent. The watcher keeps the fast path (rebuild=false). */
function ingestSessionFile(path: string, rebuild = false): boolean | undefined {
  let st;
  try {
    st = statSync(path);
  } catch {
    const cp = checkpoints.get(path);
    if (cp) writer.markArchived(projectId, cp.sessionId).catch(() => {});
    return undefined;
  }
  const cp = checkpoints.get(path);
  const sessionId = cp?.sessionId ?? sessionIdFromPath(path);
  let start = cp?.byteOffset ?? 0;
  if (cp && (st.ino !== cp.inode || st.size < cp.byteOffset)) {
    start = 0; // truncate/replace → idempotent replay from 0
    accs.delete(sessionId);
  }
  if (rebuild && !accs.has(sessionId)) {
    start = 0; // rebuild the in-memory doc from scratch after a restart
  }
  if (st.size <= start && cp) return cp.inProject;

  let acc = accs.get(sessionId);
  if (!acc) {
    acc = newAcc(sessionId, path, path.split('/').slice(0, -1).join('/'));
    accs.set(sessionId, acc);
    drainPendingOverlays(acc);
  }

  const data = readRange(path, start, st.size);
  const { lines, consumedBytes } = parseComplete(data);
  for (const line of lines) applyLine(acc, line);

  // Membership is stable per file (cwd never changes). Cache once known.
  let inProject = cp?.inProject;
  if (inProject === undefined && acc.cwd) {
    inProject = isInProject(acc.cwd, PROJECT_COMMON_DIR, knownWorktrees);
  }

  const newOffset = consumedBytes > 0 ? start + consumedBytes : start;
  checkpoints.set(path, {
    byteOffset: newOffset,
    fileSize: st.size,
    inode: st.ino,
    sessionId,
    inProject,
  });
  return inProject;
}

function drainPendingOverlays(acc: SessionAcc): void {
  const pend = pendingOverlays.get(acc.sessionId);
  if (!pend) return;
  for (const o of pend) addOverlay(acc, o.id, o.kind, o.since);
  pendingOverlays.delete(acc.sessionId);
}

function snapshot(acc: SessionAcc, inProject: boolean): SessionDoc {
  const doc = materialize(acc, {
    nowMs: Date.now(),
    idleMs: IDLE_MS,
    overlayTtlMs: OVERLAY_TTL_MS,
    worktreePath: worktreePathFor(acc.cwd),
    inProject,
    nowIso: nowIso(),
  });
  sessionDocs.set(acc.sessionId, doc);
  return doc;
}

// ── debounced writes ────────────────────────────────────────────────────────
const sessionTimers = new Map<string, NodeJS.Timeout>();
function scheduleSessionUpsert(sessionId: string): void {
  const existing = sessionTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  sessionTimers.set(
    sessionId,
    setTimeout(() => {
      sessionTimers.delete(sessionId);
      const acc = accs.get(sessionId);
      if (!acc) return;
      const doc = snapshot(acc, true);
      writer.upsertSession(projectId, doc).catch((e) => log('upsertSession failed', e?.message));
      scheduleProjectRecompute();
    }, 1000),
  );
}

let projectTimer: NodeJS.Timeout | null = null;
function scheduleProjectRecompute(): void {
  if (projectTimer) return;
  projectTimer = setTimeout(() => {
    projectTimer = null;
    recomputeProject().catch((e) => log('recomputeProject failed', e?.message));
  }, 700);
}

async function recomputeProject(): Promise<void> {
  const unitList = [...units.values()];
  const sessions = [...sessionDocs.values()].filter((s) => s.inProject);
  // phase model + per-card column
  const withPhase = unitList.map((u) => ({ ...u, currentPhase: currentPhase(u) }));

  // Dedup per unitId by SOURCE precedence: the same unit can appear in the main
  // checkout AND in a worktree. The lifecycle is: a ticket's state.yaml lives in
  // its worktree while in progress (main has only a stale stub), then on
  // completion the workflow is copied back to main and the worktree is deleted.
  // So a worktree copy is authoritative and always overrides the main copy; the
  // main copy only wins once no worktree carries that unit (i.e. after cleanup).
  // Among multiple worktree copies (rare), prefer a live worktree then the
  // more-advanced one.
  const live = new Set(knownWorktrees);
  const isLive = (wt: string | null): boolean => !!(wt && live.has(realpathOr(wt)));
  const user = cfg.workflowUser ?? deriveWorkflowUser();
  const mainRoot = workflowDir(projectPath, user);
  const isMainCopy = (u: (typeof withPhase)[number]): boolean =>
    u.stateYamlPath.startsWith(mainRoot);
  // rank tuple (higher wins): [from-worktree, worktree-live, phase#, #phases]
  const rank = (u: (typeof withPhase)[number]): [number, number, number, number] => [
    isMainCopy(u) ? 0 : 1,
    isLive(u.worktreeDir) ? 1 : 0,
    u.currentPhase?.number ?? -1,
    u.phases.length,
  ];
  const gt = (a: number[], b: number[]): boolean => {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] > b[i];
    }
    return false;
  };
  const best = new Map<string, (typeof withPhase)[number]>();
  for (const u of withPhase) {
    const cur = best.get(u.unitId);
    if (!cur || gt(rank(u), rank(cur))) best.set(u.unitId, u);
  }
  const deduped = [...best.values()];
  const phaseModel = derivePhaseModel(deduped);
  // join sessions onto each card
  const joined = deduped.map((u) => joinUnit(u, sessions));

  // Write gate: only upsert docs that actually changed. recomputeProject runs on
  // every state.yaml/session change but touches every unit, so without this a
  // single edit re-writes the whole (ever-growing) set each time. The signature
  // excludes updatedAt so an unchanged doc isn't seen as "new" via its stamp.
  const projectDoc = {
    projectId,
    projectPath,
    commonDir: PROJECT_COMMON_DIR,
    workflowType: projectWorkflowType(joined),
    phaseModel,
    worktreePaths: knownWorktrees,
  };
  const projectSig = JSON.stringify(projectDoc);
  if (projectSig !== lastProjectSig) {
    lastProjectSig = projectSig;
    await writer.upsertProject({ ...projectDoc, updatedAt: nowIso() });
  }

  // A card is worktree-backed only if its worktreeDir is a CURRENT git worktree
  // (old state.yaml records removed worktrees; leftover dirs still exist, so
  // existsSync isn't enough). Null it otherwise so the board hides the backlog.
  for (const u of joined) {
    const worktreeDir = isLive(u.worktreeDir) ? u.worktreeDir : null;
    const doc = { ...u, worktreeDir };
    const sig = JSON.stringify(doc);
    if (lastUnitSig.get(u.unitId) === sig) continue; // unchanged → skip the DB write
    lastUnitSig.set(u.unitId, sig);
    await writer.upsertWorkUnit(projectId, { ...doc, updatedAt: nowIso() });
  }
}

// ── state.yaml ingestion ────────────────────────────────────────────────────
function ingestStateYaml(path: string, mtimeMs: number): void {
  const parsed = parseStateYaml(path);
  if (!parsed) return; // mid-write / malformed → keep last good, retry next tick (mtime NOT recorded)
  const u: WorkUnitDoc = {
    ...parsed.doc,
    currentPhase: null,
    waiting: null,
    sessionIds: [],
    lastActivity: null,
    updatedAt: nowIso(),
  };
  units.set(path, u);
  stateMtimes.set(path, mtimeMs);
  scheduleProjectRecompute();
}

// ── events.jsonl overlay ────────────────────────────────────────────────────
function ingestEvents(): void {
  if (!existsSync(EVENTS_PATH)) return;
  const st = statSync(EVENTS_PATH);
  if (st.size < eventsOffset) eventsOffset = 0;
  if (st.size <= eventsOffset) return;
  const data = readRange(EVENTS_PATH, eventsOffset, st.size);
  const { lines, consumedBytes } = parseComplete(data);
  if (consumedBytes > 0) {
    eventsOffset += consumedBytes;
    // Persist so a daemon RESTART resumes here instead of replaying the file
    // from 0 (which re-fired stop-nudges for the last `maxAge` of stops on every
    // restart). A cold start with no checkpoint still replays from 0, and a
    // daemon that was down still reads forward over events it missed — so the
    // intended "fire backlog stops on startup" behaviour is preserved.
    checkpoints.set(EVENTS_PATH, {
      byteOffset: eventsOffset,
      fileSize: st.size,
      inode: 0,
      sessionId: '__events__',
    });
  }
  for (const line of lines) {
    const ev = line as Record<string, unknown>;
    const sessionId = typeof ev.sessionId === 'string' ? ev.sessionId : null;
    const kind = typeof ev.kind === 'string' ? ev.kind : null;
    const id = typeof ev.id === 'string' ? ev.id : null;
    const since = typeof ev.ts === 'string' ? ev.ts : nowIso();
    if (!sessionId || !kind || !id) continue;
    // Reminder lifecycle events (drive the stop-nudge, not the waiting overlay).
    if (kind === 'Stop') {
      // (Re)arm the stop-nudge. The hook fires NO immediate notice — the daemon
      // owns the first notice too, gated by the debounce in reminderTick (count
      // 0 → fire after `debounceSec` of true quiet, incl. teammate activity).
      // Seed lastRemind at the stop time; the count===0 branch keys off the
      // debounce, later repeats off the interval.
      stopState.set(sessionId, {
        stoppedAt: since,
        lastRemind: Date.parse(since) || Date.now(),
        count: 0,
        fromRestart: armingFromStartup, // cold-start replay → batch into one notice
      });
      continue;
    }
    if (kind === 'SessionEnd') {
      stopState.delete(sessionId);
      continue;
    }
    // AskUserQuestion/ExitPlanMode are governed by the JSONL tool_use — ignore
    // them here to avoid double-counting (they carry no tool_use_id).
    if (kind !== 'PermissionRequest' && kind !== 'Elicitation') continue;
    const acc = accs.get(sessionId);
    if (acc) {
      addOverlay(acc, id, kind, since);
      scheduleSessionUpsert(sessionId);
    } else {
      const arr = pendingOverlays.get(sessionId) ?? [];
      arr.push({ id, kind, since });
      pendingOverlays.set(sessionId, arr);
    }
  }
}

// ── reminders ─────────────────────────────────────────────────────────────
function unitTitle(unitId: string | undefined): string | null {
  if (!unitId) return null;
  for (const u of units.values()) if (u.unitId === unitId) return u.title;
  return null;
}

/** The notification label + detail for a stopped session, enriched with its
 * work-unit. SessionDoc.unitId is never populated, so match by worktree the way
 * join does. `label` is the short identifier (the bold title line); `detail` is
 * the long descriptive text. macOS truncates the title/subtitle to one line but
 * WRAPS the message body, so callers put `detail` in the body. Ticket →
 * "KAR-1234" / its title; project → its slug / its title; no unit → brand /
 * session title or branch. */
function stopNotice(doc: SessionDoc | undefined): { label: string; detail: string } {
  const unit = doc ? [...units.values()].find((u) => sessionMatchesUnit(doc, u)) : undefined;
  if (unit?.type === 'ticket') return { label: unit.identifier, detail: unit.title };
  if (unit?.type === 'project')
    return { label: unit.identifier, detail: unit.title || doc?.gitBranch || 'project' };
  return { label: 'ks-flow', detail: doc?.title ?? doc?.gitBranch ?? 'idle' };
}

/** Latest activity (ms epoch) across the stopped session AND any sibling
 * session in the same worktree — covers "resumed" and "new session started". */
function latestActivity(doc: SessionDoc | undefined): number {
  let max = doc?.lastActivity ? Date.parse(doc.lastActivity) : -1;
  const wt = doc?.worktreePath ?? null;
  if (wt) {
    for (const s of sessionDocs.values()) {
      if (s.worktreePath === wt && s.lastActivity) {
        const t = Date.parse(s.lastActivity);
        if (t > max) max = t;
      }
    }
  }
  return max;
}

/** Latest teammate/subagent transcript activity (ms epoch) for a session, or -1.
 * Teammate turns are written to `<projectDir>/<sessionId>/subagents/agent-*.jsonl`
 * — a nested dir the watcher (depth:0) and backfill (top-level) never read, so
 * their timestamps never reach `lastActivity`. We stat those files directly:
 * while a teammate is mid-turn the session is ACTIVE even though the main agent
 * has Stopped, and we must not fire an idle notice. Only called for the (small)
 * set of stopped sessions, every REMINDER_TICK_MS — cheap. */
function subagentActivityMs(sid: string): number {
  const acc = accs.get(sid);
  if (!acc) return -1;
  const subDir = join(acc.projectDir, sid, 'subagents');
  let files: string[];
  try {
    files = readdirSync(subDir);
  } catch {
    return -1; // no subagents dir → no teammates
  }
  let max = -1;
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    try {
      const m = statSync(join(subDir, f)).mtimeMs;
      if (m > max) max = m;
    } catch {
      /* file vanished mid-stat — ignore */
    }
  }
  return max;
}

// Re-arm stop-nudges after a daemon restart. The events.jsonl read offset is
// persisted (so a restart doesn't replay/duplicate consumed Stops), which also
// means stopState — in-memory only — starts empty: a session that is STILL idle
// and waiting would silently lose its nudge across a restart. So we scan the
// events log for each session's LAST lifecycle event; if it's a `Stop` (not
// `SessionEnd`) and within maxAge, re-arm it as fromRestart. reminderTick then
// applies the usual gates (resume / completed / unmatched / paused) and the
// grouped-notice batching. Sessions that resumed or ended are NOT re-armed.
function reconstructStopState(): void {
  if (!existsSync(EVENTS_PATH)) return;
  let data: string;
  try {
    data = readFileSync(EVENTS_PATH, 'utf8');
  } catch {
    return;
  }
  const lastLifecycle = new Map<string, { kind: string; ts: string }>();
  for (const line of data.split('\n')) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const sid = typeof ev.sessionId === 'string' ? ev.sessionId : null;
    const kind = typeof ev.kind === 'string' ? ev.kind : null;
    if (!sid || (kind !== 'Stop' && kind !== 'SessionEnd')) continue;
    lastLifecycle.set(sid, { kind, ts: typeof ev.ts === 'string' ? ev.ts : nowIso() });
  }
  const settings = reminderSettings();
  const maxAgeMs = settings.capCount * settings.stopIntervalMin * 60_000;
  const now = Date.now();
  let armed = 0;
  for (const [sid, ev] of lastLifecycle) {
    if (ev.kind !== 'Stop') continue; // ended → not waiting
    if (stopState.has(sid)) continue; // already armed via cold-start replay
    const stoppedMs = Date.parse(ev.ts);
    if (!stoppedMs || now - stoppedMs > maxAgeMs) continue; // too old to nudge
    stopState.set(sid, { stoppedAt: ev.ts, lastRemind: stoppedMs, count: 0, fromRestart: true });
    armed++;
  }
  if (armed) log(`reconstructed ${armed} stop-nudge(s) still waiting after restart`);
}

async function reminderTick(): Promise<void> {
  const settings = reminderSettings();
  const now = Date.now();
  const wake =
    reminderLastTickMs !== 0 && now - reminderLastTickMs > Math.max(2 * REMINDER_TICK_MS, 120_000);
  const startup = reminderStartup;
  reminderLastTickMs = now;
  reminderStartup = false;

  let reminders: ReminderDoc[] = [];
  try {
    reminders = await writer.getReminders(projectId);
  } catch (e) {
    log('getReminders failed', (e as { message?: string })?.message);
    return; // transient — retry next tick
  }
  const paused = new Set(
    reminders.filter((r) => r.kind === 'pause' && r.sessionId).map((r) => r.sessionId!),
  );

  // Stop-nudges: a debounced first notice, then repeat every interval until
  // resume / cap / expiry. The gate is "time since last activity" (quiet
  // duration), NOT a `stoppedMs` vs activity comparison — the Stop event's ts is
  // whole-second (the hook truncates to .000) while transcript activity is
  // millisecond and the turn-ENDING line lands a beat AFTER the Stop event, so a
  // direct compare wrongly reads the session's own turn-end as a "resume" and
  // kills the nudge. Quiet-duration sidesteps that entirely. `lastAct` spans the
  // session transcript, its worktree siblings, AND its teammates' subagent
  // transcripts → active (incl. mid-multi-agent-turn) ⇒ no notice.
  if (settings.enabled) {
    const intervalMs = settings.stopIntervalMin * 60_000;
    const debounceMs = settings.debounceSec * 1000;
    const maxAgeMs = settings.capCount * intervalMs;
    // First notices of sessions armed at startup are collected here and fired as
    // ONE grouped notice (so a restart with N still-waiting sessions yields a
    // single "N sessions waiting" notice, not N separate ones). Later nudges go
    // back to individual per-session notices.
    const restartBatch: Array<{ sid: string; st: StopState; label: string; detail: string }> = [];
    for (const [sid, st] of [...stopState]) {
      const doc = sessionDocs.get(sid);
      const stoppedMs = Date.parse(st.stoppedAt);
      const lastAct = Math.max(latestActivity(doc), subagentActivityMs(sid), stoppedMs);
      // Genuine resume: activity well past the stop (margin clears the turn-end
      // line, which trails the Stop event by a few seconds) → drop + unpause.
      if (lastAct - stoppedMs > RESUME_MARGIN_MS) {
        stopState.delete(sid);
        const pauseRec = reminders.find((r) => r.kind === 'pause' && r.sessionId === sid);
        if (pauseRec) await writer.deleteReminder(projectId, pauseRec.uid).catch(() => {});
        continue;
      }
      if (now - stoppedMs > maxAgeMs || st.count >= settings.capCount) {
        stopState.delete(sid); // expired / hit the cap
        continue;
      }
      // Only nudge for a real tracked ticket/project. No matched unit (ad-hoc /
      // main-checkout session, or a Stop whose worktree is gone) → skip the
      // generic notice; it's not meaningful work to wait on. Left in stopState
      // so a late-parsing unit can still fire; maxAge cleans it otherwise.
      const unit = doc ? [...units.values()].find((u) => sessionMatchesUnit(doc, u)) : undefined;
      if (!unit) continue;
      // Ticket/project finished its workflow → an idle session here is done
      // work, not a session waiting on the user. Drop the nudge.
      if (unitCompleted(unit)) {
        stopState.delete(sid);
        continue;
      }
      if (paused.has(sid)) continue;
      // Not quiet long enough yet — still active, or teammates churning.
      if (now - lastAct < debounceMs) continue;
      if (st.count === 0) {
        const n = stopNotice(doc);
        if (st.fromRestart) {
          // Defer: batch into the one grouped restart notice fired after the loop.
          restartBatch.push({ sid, st, label: n.label, detail: n.detail });
          st.fromRestart = false;
          continue;
        }
        // subtitle = short status (one line), message body = full detail (wraps).
        notify(sid, 'Claude is waiting on you', n.detail, n.label);
        st.lastRemind = now;
        st.count += 1;
      } else if (now - st.lastRemind >= intervalMs) {
        const n = stopNotice(doc);
        notify(sid, 'Claude is still waiting on you', n.detail, n.label);
        st.lastRemind = now;
        st.count += 1;
      }
    }
    // Flush the restart batch as a single grouped notice (a lone session falls
    // back to its normal rich individual notice). Each batched session is marked
    // as having had its first notice (count=1) so it resumes individual repeats.
    if (restartBatch.length === 1) {
      const { sid, st, label, detail } = restartBatch[0];
      notify(sid, 'Claude is waiting on you', detail, label);
      st.lastRemind = now;
      st.count = 1;
    } else if (restartBatch.length > 1) {
      const labels = restartBatch.map((b) => b.label).join(', ');
      notify('ks-flow-restart', `${restartBatch.length} sessions waiting on you`, labels, 'ks-flow');
      for (const { st } of restartBatch) {
        st.lastRemind = now;
        st.count = 1;
      }
    }
  }

  // Custom per-card reminders: fire once at due, then re-nag on wake / startup
  // until cleared. Never on a plain tick.
  for (const r of reminders) {
    if (r.kind !== 'custom' || r.cleared || !r.dueAt) continue;
    if (Date.parse(r.dueAt) > now) continue;
    if (!(r.lastFiredAt == null || wake || startup)) continue;
    notify(r.unitId ?? r.uid, unitTitle(r.unitId) ?? r.unitId ?? 'reminder', r.note || 'Reminder due');
    await writer
      .upsertReminder(projectId, { ...r, lastFiredAt: nowIso() })
      .catch((e) => log('upsertReminder failed', e?.message));
  }
}

// ── backfill ────────────────────────────────────────────────────────────────
function enumerateProjectDirs(): string[] {
  const wts = listWorktrees(projectPath);
  knownWorktrees = wts.map((w) => w.path);
  const dirs = new Set<string>();
  for (const w of knownWorktrees) {
    const d = join(CLAUDE_PROJECTS_DIR, encodeProjectDir(w));
    if (existsSync(d)) dirs.add(d);
  }
  return [...dirs];
}

async function backfill(): Promise<void> {
  const dirs = enumerateProjectDirs();
  log(`backfill: ${dirs.length} in-project session dir(s)`);
  const batch: SessionDoc[] = [];
  for (const dir of dirs) {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const path = join(dir, f);
      const inProject = ingestSessionFile(path, true); // rebuild in-memory docs
      if (inProject === true) {
        const acc = accs.get(sessionIdFromPath(path));
        if (acc) batch.push(snapshot(acc, true));
      }
    }
  }
  checkpoints.flush();
  if (batch.length) await writer.upsertMany(projectId, batch);
  log(`backfill: ${batch.length} session(s) ingested`);

  // workflow state.yaml backfill — across the main repo AND every worktree
  scanAllStateYaml();
  await recomputeProject();
}

/** Workflow roots to scan: the main repo plus each worktree. Each worktree
 * carries its own committed copy of workflow/**, so a ticket's real progress
 * lives in ITS worktree, not the main checkout (which is often a stale stub). */
function workflowRoots(): string[] {
  const user = cfg.workflowUser ?? deriveWorkflowUser();
  const roots = new Set<string>([workflowDir(projectPath, user)]);
  for (const wt of knownWorktrees) roots.add(workflowDir(wt, user));
  return [...roots];
}

function scanAllStateYaml(): void {
  for (const root of workflowRoots()) scanStateYaml(root);
}

function deriveWorkflowUser(): string {
  // best-effort: first segment under workflow/ that exists
  const wfBase = join(projectPath, 'workflow');
  try {
    const subs = readdirSync(wfBase).filter((d) => {
      try {
        return statSync(join(wfBase, d)).isDirectory();
      } catch {
        return false;
      }
    });
    if (subs[0]) return subs[0];
  } catch {
    /* ignore */
  }
  return 'unknown';
}

function scanStateYaml(root: string): void {
  if (!existsSync(root)) return;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e);
      let s;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) stack.push(p);
      else if (e === 'state.yaml') {
        // Read-I/O gate: only readFileSync + YAML-parse when the file actually
        // changed since last parse. statSync above is cheap; the parse is not,
        // and completed tickets' state.yaml in the main checkout never change
        // yet accumulate forever. Unchanged + already-known → skip.
        if (stateMtimes.get(p) === s.mtimeMs && units.has(p)) continue;
        ingestStateYaml(p, s.mtimeMs);
      }
    }
  }
}

// ── watchers ────────────────────────────────────────────────────────────────
function startWatchers(): void {
  const usePoll = process.env.KS_FLOW_POLL === '1';
  const dirs = enumerateProjectDirs();

  // Watch the session DIRS (not a per-file glob) at depth 0 — one FSWatcher
  // per in-project dir. A watcher 'error' (e.g. EMFILE) is logged, never fatal.
  const sessionWatcher = chokidar.watch(dirs, {
    ignoreInitial: true,
    awaitWriteFinish: false,
    usePolling: usePoll,
    depth: 0,
  });
  const onSessionPath = (p: string) => {
    if (p.endsWith('.jsonl')) onSession(p);
  };
  sessionWatcher.on('add', onSessionPath);
  sessionWatcher.on('change', onSessionPath);
  sessionWatcher.on('unlink', (p) => {
    const cp = checkpoints.get(p);
    if (cp) writer.markArchived(projectId, cp.sessionId).catch(() => {});
  });
  sessionWatcher.on('error', (e) => log('session watcher error (continuing):', (e as Error)?.message));

  const eventsWatcher = chokidar.watch(EVENTS_PATH, {
    ignoreInitial: true,
    usePolling: usePoll,
  });
  eventsWatcher.on('add', ingestEvents);
  eventsWatcher.on('change', ingestEvents);
  eventsWatcher.on('error', (e) => log('events watcher error (continuing):', (e as Error)?.message));

  // state.yaml: a recursive chokidar `**` glob over the workflow tree opens an
  // FSWatcher per directory and blows the FD limit (EMFILE) on a big tree.
  // state.yaml changes are infrequent, so a periodic re-scan (idempotent) is
  // both cheaper and far more robust.
  setInterval(scanAllStateYaml, 15_000);

  // periodic worktree re-enumeration → add watches for new worktrees. When the
  // worktree set changes (e.g. a completed worktree was removed), recompute so
  // dead worktreeDirs get nulled — the state.yaml rescan no longer forces a
  // recompute every tick now that it's mtime-gated.
  setInterval(() => {
    const before = knownWorktrees.join('\n');
    const fresh = enumerateProjectDirs();
    sessionWatcher.add(fresh);
    if (knownWorktrees.join('\n') !== before) scheduleProjectRecompute();
  }, 60_000);

  // Reminder engine: one light poll — stop-nudges + due custom reminders.
  setInterval(() => {
    reminderTick().catch((e) => log('reminderTick failed', e?.message));
  }, REMINDER_TICK_MS);

  log('watching', dirs.length, 'session dir(s) + events; rescanning workflow state.yaml every 15s');
}

function onSession(path: string): void {
  const inProject = ingestSessionFile(path);
  checkpoints.flush();
  const sessionId = sessionIdFromPath(path);
  if (inProject === true) scheduleSessionUpsert(sessionId);
}

// ── lifecycle ───────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  checkpoints.load();
  log(`project ${projectId} (${projectPath}) common-dir ${PROJECT_COMMON_DIR}`);
  log(`db_provider=${cfg.dbProvider} firestore_mode=${cfg.firestoreMode}`);
  // PocketBase is a local server we own — start it (and its migrations) and
  // wait for health BEFORE any write. Dry-run uses the in-memory provider, so
  // skip it there.
  if (cfg.dbProvider === 'pocketbase' && process.env.KS_FLOW_DRYRUN !== '1') {
    pbHandle = await startPocketbase(cfg.pocketbasePort, log);
  }
  eventsOffset = checkpoints.get(EVENTS_PATH)?.byteOffset ?? 0; // resume, don't replay
  ingestEvents(); // catch up overlay offset
  await backfill();
  // Backfill-only mode: ingest once, flush, exit (deterministic verification /
  // one-shot debug). No watchers, no live tailing.
  if (process.env.KS_FLOW_BACKFILL_ONLY === '1') {
    log('backfill-only: done, flushing and exiting');
    checkpoints.flush();
    if (writer.close) await writer.close();
    process.exit(0);
  }
  startWatchers();
  if (!terminalNotifierAvailable()) {
    log('WARNING: terminal-notifier not found — notifications are disabled. Install: brew install terminal-notifier');
  }
  // Re-arm stop-nudges for sessions still waiting after a restart (needs units +
  // sessionDocs from backfill). Their first notice is grouped by reminderTick.
  reconstructStopState();
  // Startup catch-up: re-fire any lapsed (uncleared) custom reminders now, and
  // fire the single grouped restart notice for the re-armed stop-nudges.
  await reminderTick().catch((e) => log('reminderTick failed', e?.message));
  armingFromStartup = false; // live Stops from here on nudge individually
  log('ready');
}

function shutdown(): void {
  checkpoints.flush();
  pbHandle?.stop();
  if (writer.close) writer.close().finally(() => process.exit(0));
  else process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch((e) => {
  console.error('[ks-flow] fatal', e);
  process.exit(1);
});
